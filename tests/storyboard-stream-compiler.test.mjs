import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {EventEmitter} from 'node:events';
import {compilerEnvironment,casting,response} from './helpers/comfy-compiler-fixture.mjs';
import {storyboardFunctionSource as section} from './helpers/storyboard-form-fixture.mjs';
import {applyCharacterCasting} from '../qianmu-character-casting.js';

const copy=value=>JSON.parse(JSON.stringify(value));
function deferred(){let resolve;return {promise:new Promise(yes=>resolve=yes),resolve:()=>resolve()};}
const editable=state=>copy(Object.fromEntries(['prompt','negative','promptDraft','target','floor','paragraphMode','manualParagraphIndex','pendingParagraphSelection','pendingCompilerStages','contentRating','shotPlans'].map(key=>[key,state[key]])));
async function fixture({floor=0,text='Alice reads a letter in the kitchen.\n\nShe reaches',wait=false}={}){
  const e=await compilerEnvironment(),host=e.context.ctx(),events=new EventEmitter(),controller=new AbortController();events.setMaxListeners(100);
  host.eventSource=events;host.chat.splice(0,host.chat.length,...Array.from({length:floor},(_,index)=>({mes:`earlier ${index}`,send_date:String(index),is_user:index%2===0})),
    {mes:text,name:'Alice',is_user:false,send_date:'live-start',gen_started:'live-generation',swipe_id:0});
  e.state.routing.enabled=false;e.state.prompt='MANUAL WORKBENCH';e.state.negative='manual exclusions';e.state.floor='99';e.state.target='gallery';
  e.state.promptDraft.userEditedCompiled=true;e.state.pendingCompilerStages=[{type:'manual',input:{owned:'user'}}];
  const initial=editable(e.state),calls=[],domEvents=new Map();let prepared,modelHook=null,preparedHook=null,worldHook=null,requests=0,hostSaves=0,saves=0,renders=0,wakes=0;
  host.saveMetadata=async()=>hostSaves++;
  Object.assign(e.context,{
    storyboardCleanWithTagRules:value=>value.replace(/<think>[\s\S]*?<\/think>/g,''),storyboardCleanMessageText:value=>value.trim(),resolveMacro:async value=>value,
    storyboardMessageParagraphs:value=>value.split(/\n\s*\n/).map(row=>row.trim()).filter(Boolean),
    storyboardCompilerWorldText:async()=>{if(worldHook)await worldHook();return {text:'',rows:[]};},
    storyboardCompilerCharacterCasting:async()=>({prepared:casting,assertCurrent:async()=>{},apply:applyCharacterCasting}),
    renderModal:()=>renders++,saveSettings:()=>saves++,storyboardScheduleAutomaticCapture:()=>wakes++,
    document:{addEventListener:(type,handler)=>{if(!domEvents.has(type))domEvents.set(type,new Set());domEvents.get(type).add(handler);},removeEventListener:(type,handler)=>domEvents.get(type)?.delete(handler)},
    storyboardCallCompiler:async(messages,_id,options)=>{
      requests++;const payload=JSON.parse(messages[1].content);calls.push({payload,options:copy(options)});
      let reply;
      if(options.jsonSchemaName==='qianmu.storyboard.narrative.v1'){
        const first=payload.source_catalogue.find(row=>row.floor===floor).passages.find(row=>row.paragraph_id==='P1').text;
        const {prompt_atoms,prompt_renderings,...shot}=response().shots[0];
        const anchor={floor,branch_id:'present',paragraph_id:'P1',quote:first};
        reply={schema:options.jsonSchemaName,should_generate:!wait,skip_reason:wait?'等待人物在场明确':'',decisions:[],shots:wait?[]:[{...shot,
          state_point:{branchId:'present',paragraphId:'P1',evidence:first},stream_support:{scene:anchor,content:anchor,presence:[{character_id:'A',source:anchor}]}}],
          source_states:payload.required_state_floors.map(floor=>({floor,roster:{branches:[{id:'present',layer:'present'}],subjectIds:['A']},events:[]})),continuity_links:[]};
      }else reply={schema:options.jsonSchemaName,shots:[{shot_id:'S1',prompt_atoms:response().shots[0].prompt_atoms,
        prompt_renderings:Object.fromEntries(options.promptFormats.map(format=>[format,response().shots[0].prompt_renderings[format]]))}]};
      if(modelHook)await modelHook({requests,messages,options});return JSON.stringify(reply);
    },
  });
  vm.runInContext(section('storyboardCompilerContext'),e.context);
  const onPrepared=async value=>{prepared=value;value.inputGuard.assertCurrent();await value.context.compilerSources.guard();if(preparedHook)await preparedHook(value);};
  return {...e,host,events,controller,initial,calls,domEvents,run:options=>e.context.storyboardCompilePrompt(null,{quiet:true,stream:{floor,signal:controller.signal},onPrepared,...options}),
    get prepared(){return prepared;},get counts(){return {requests,hostSaves,saves,renders,wakes};},
    set modelHook(value){modelHook=value;},set preparedHook(value){preparedHook=value;},set worldHook(value){worldHook=value;},
    assertReleased(){assert.equal(events.eventNames().reduce((sum,key)=>sum+events.listenerCount(key),0),0);assert.equal([...domEvents.values()].reduce((sum,rows)=>sum+rows.size,0),0);assert.equal(e.context.storyboardCompilerBusy,false);},
  };
}

test('actual streaming compiler prepares an alternate floor without touching workbench, draft, plans, storage, renderer or image queue',async()=>{
  const f=await fixture({floor:2});assert.equal(await f.run(),true,JSON.stringify(f.errors));
  assert.deepEqual(editable(f.state),f.initial);assert.deepEqual(f.counts,{requests:2,hostSaves:0,saves:0,renders:0,wakes:1});assert.deepEqual(f.jobs,[]);
  assert.equal(f.prepared.context.floor,2);assert.deepEqual(f.prepared.context.compilerSources.messages.map(row=>row.floor),[0,1,2]);
  assert.equal(f.prepared.result.shots[0].shotSpec.characters[0].id,'archive:alice');assert.equal(f.prepared.result.shots[0].shotSpec.promptRenderingPack.renderings.tags.characters[0].character_id,'archive:alice');
  assert.deepEqual(f.prepared.context.compilerSources.stream.stableParagraphIds,['P1']);assert.match(JSON.stringify(f.calls[0].payload),/She reaches/);
  assert.doesNotMatch(JSON.stringify(f.calls[1].payload),/She reaches/);assert.throws(()=>f.prepared.inputGuard.assertCurrent(),{code:'storyboard_input_changed'});f.assertReleased();
  assert.match(f.prepared.messageRef.revisionId,/^stream:[a-f0-9]{64}$/);assert.ok(f.prepared.messageRef.stream.prefixLength>0);
});

test('actual streaming wait leaves existing manual prompts and compiler stages intact without persisting provisional events',async()=>{
  const f=await fixture({wait:true});assert.equal(await f.run(),false);assert.equal(f.prepared.result.shouldGenerate,false);
  assert.deepEqual(editable(f.state),f.initial);assert.deepEqual(f.counts,{requests:1,hostSaves:0,saves:0,renders:0,wakes:1});assert.deepEqual(f.state.logs,[]);f.assertReleased();
});

test('no closed visible prose waits before any model request, including paragraphs removed by extraction rules',async()=>{
  for(const text of ['unfinished','<think>private reasoning</think>\n\nShe reaches']){
    const f=await fixture({text});assert.equal(await f.run(),false);assert.equal(f.prepared,undefined);assert.equal(f.counts.requests,0);
    assert.equal(f.counts.saves,0);assert.deepEqual(editable(f.state),f.initial);assert.deepEqual(f.notices,[]);f.assertReleased();
  }
});

test('appending while either model stage or the scoped handoff is pending does not invalidate the fixed earlier snapshot',async()=>{
  const f=await fixture();f.modelHook=()=>{f.host.chat[0].mes+=' more prose';};f.preparedHook=()=>{f.host.chat[0].mes+='\n\nLater scene.';};
  assert.equal(await f.run(),true,JSON.stringify(f.errors));assert.equal(f.prepared.context.compilerSources.messages[0].text,'Alice reads a letter in the kitchen.\n\nShe reaches');
  assert.deepEqual(editable(f.state),f.initial);f.assertReleased();
});

for(const [label,change] of [
  ['prefix rewrite',f=>{f.host.chat[0].mes='Other person cooks.\n\nnew tail';}],
  ['reply replacement',f=>{f.host.chat[0]={...f.host.chat[0]};}],['swipe',f=>{f.host.chat[0].swipe_id=1;}],
  ['edit and restore',f=>f.events.emit('message_edited',0)],['chat switch notification',f=>f.events.emit('chat_changed','other')],
  ['metadata replacement',f=>{f.host.chatMetadata={};}],['lifecycle epoch',f=>{f.context.storyboardAdmissionEpoch++;}],
  ['abort',f=>f.controller.abort()],['account change',f=>f.setAccount('st-user:other')],
  ['automation toggle',f=>{f.state.automation.autoCapture=!f.state.automation.autoCapture;}],
])test(`streaming ${label} during the first request cannot produce a handoff or replace an existing draft`,async()=>{
  const f=await fixture();f.modelHook=()=>change(f);
  assert.equal(await f.run(),false,JSON.stringify(f.errors));assert.equal(f.prepared,undefined);assert.equal(f.counts.requests,1);assert.equal(f.counts.hostSaves,0);
  assert.deepEqual(editable(f.state),f.initial);assert.deepEqual(f.state.logs,[]);assert.deepEqual(f.jobs,[]);f.assertReleased();
});

test('manual edit during expression wins; the late response neither overwrites it nor dispatches a new task',async()=>{
  const f=await fixture();f.modelHook=({requests})=>{if(requests===2)f.state.prompt='USER NEW DRAFT';};
  assert.equal(await f.run(),false);assert.equal(f.state.prompt,'USER NEW DRAFT');assert.equal(f.prepared,undefined);assert.equal(f.counts.saves,0);f.assertReleased();
});

test('edit-and-restore in a selected earlier floor is still strict despite append-tolerant target text',async()=>{
  const f=await fixture({floor:2});f.modelHook=()=>f.events.emit('message_edited',0);
  assert.equal(await f.run(),false);assert.equal(f.prepared,undefined);assert.equal(f.counts.requests,1);f.assertReleased();
});

test('busy ownership lasts through the awaited handoff, and cancellation there invalidates the returned result',async()=>{
  const f=await fixture(),started=deferred(),finish=deferred();f.preparedHook=async()=>{started.resolve();await finish.promise;};
  const pending=f.run();await started.promise;assert.equal(f.context.storyboardCompilerBusy,true);assert.equal(await f.run(),false);assert.equal(f.counts.requests,2);
  f.controller.abort();finish.resolve();assert.equal(await pending,false);assert.deepEqual(editable(f.state),f.initial);f.assertReleased();
});

test('streaming preparation cannot be mixed with a form-root/manual plan or called without a scoped consumer',async()=>{
  const f=await fixture();
  for(const options of [{plan:{id:'manual'}},{onPrepared:null},{stream:{floor:-1}},{stream:{floor:0.5}},{stream:null}])assert.equal(await f.run(options),false);
  assert.equal(await f.context.storyboardCompilePrompt({}, {stream:{floor:0},onPrepared:()=>{}}),false);
  assert.equal(f.counts.requests,0);assert.deepEqual(editable(f.state),f.initial);f.assertReleased();
});

test('a stream identity without a durable host timestamp waits, and abort before context sends nothing',async()=>{
  const f=await fixture();delete f.host.chat[0].send_date;delete f.host.chat[0].gen_started;
  assert.equal(await f.run(),false);assert.equal(f.counts.requests,0);f.assertReleased();
  const g=await fixture();g.controller.abort();assert.equal(await g.run(),false);assert.equal(g.counts.requests,0);g.assertReleased();
});

test('actual compiler on ten thousand floors cannot read prose outside the selected three-floor window',async()=>{
  const f=await fixture({floor:9999});
  for(let index=0;index<9997;index++)Object.defineProperty(f.host.chat[index],'mes',{get(){assert.fail('unselected history read');}});
  assert.equal(await f.run(),true,JSON.stringify(f.errors));assert.deepEqual(f.calls[0].payload.source_catalogue.map(row=>row.floor),[9997,9998,9999]);
  assert.deepEqual(editable(f.state),f.initial);f.assertReleased();
});

test('streaming Comfy preparation always uses automatic preflight even if a caller omits the automatic option',async()=>{
  const f=await fixture();f.state.source='comfy';let checked=0;
  f.context.storyboardPreflightComfyForCompiler=async(_state,_profile,_plan,_guard,automatic)=>{assert.equal(automatic,true);checked++;throw Object.assign(Error('unverified custom workflow'),{comfyPreflight:true});};
  assert.equal(await f.run({automatic:false}),false);assert.equal(checked,1);assert.equal(f.counts.requests,0);assert.equal(f.prepared,undefined);assert.deepEqual(f.jobs,[]);f.assertReleased();
});
