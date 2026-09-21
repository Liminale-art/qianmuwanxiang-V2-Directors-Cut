import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {EventEmitter} from 'node:events';
import {compilerEnvironment,casting,response} from './helpers/comfy-compiler-fixture.mjs';
import {storyboardFunctionSource as section} from './helpers/storyboard-form-fixture.mjs';
import {applyCharacterCasting} from '../qianmu-character-casting.js';
import {resolveStoryboardMessageReference,createStoryboardMessageReference,normalizeStoryboardState,sortStoryboardInlineRecords,buildStoryboardInlineTasks,storyboardInlineDisplayIndexes,storyboardProductionDeliveryPolicy} from '../qianmu-storyboard.js';
import {createImageAdmission} from '../qianmu-image-admission.js';
import {imageAttemptScopeKey,claimImageAttempt,importImageAttempts,beginImageAttempt,continueImageAttempt,settleImageAttempt} from '../qianmu-image-attempts.js';
import {captureStoryboardContinuation,saveStoryboardContinuation} from '../qianmu-storyboard-continuation.js';
import {createStoryboardContinuationHost} from '../qianmu-storyboard-continuation-host.js';
import {createStoryboardStreamScheduler,runStoryboardStreamPass} from '../qianmu-storyboard-stream-scheduler.js';
import {streamCheckpointTransport} from './helpers/stream-checkpoint-fixture.mjs';
import {createStoryboardStreamHost} from '../qianmu-storyboard-stream-host.js';

const copy=value=>JSON.parse(JSON.stringify(value));
function deferred(){let resolve;return {promise:new Promise(yes=>resolve=yes),resolve:()=>resolve()};}
const editable=state=>copy(Object.fromEntries(['prompt','negative','promptDraft','target','floor','paragraphMode','manualParagraphIndex','pendingParagraphSelection','pendingCompilerStages','contentRating','shotPlans'].map(key=>[key,state[key]])));
async function fixture({floor=0,text='Alice reads a letter in the kitchen.\n\nShe reaches',wait=false}={}){
  const e=await compilerEnvironment(),host=e.context.ctx(),events=new EventEmitter(),controller=new AbortController();events.setMaxListeners(100);
  const storage=streamCheckpointTransport();storage.configure();
  host.eventSource=events;host.chat.splice(0,host.chat.length,...Array.from({length:floor},(_,index)=>({mes:`earlier ${index}`,send_date:String(index),is_user:index%2===0})),
    {mes:text,name:'Alice',is_user:false,send_date:'live-start',gen_started:'live-generation',swipe_id:0});
  e.state.routing.enabled=false;e.state.prompt='MANUAL WORKBENCH';e.state.negative='manual exclusions';e.state.floor='99';e.state.target='gallery';
  e.state.promptDraft.userEditedCompiled=true;e.state.pendingCompilerStages=[{type:'manual',input:{owned:'user'}}];
  const initial=editable(e.state),calls=[],domEvents=new Map();let prepared,modelHook=null,preparedHook=null,worldHook=null,requests=0,hostSaves=0,saves=0,renders=0,wakes=0;
  host.saveMetadata=async()=>hostSaves++;
  Object.assign(e.context,{
    storyboardStreamRuntime:null,
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
          state_point:{branchId:'present',paragraphId:'P1',evidence:first},...(payload.constraints.streaming?{stream_support:{scene:anchor,content:anchor,presence:[{character_id:'A',source:anchor}]}}:{})}],
          source_states:payload.required_state_floors.map(floor=>({floor,roster:{branches:[{id:'present',layer:'present'}],subjectIds:['A']},events:[]})),continuity_links:[]};
      }else reply={schema:options.jsonSchemaName,shots:[{shot_id:'S1',prompt_atoms:response().shots[0].prompt_atoms,
        prompt_renderings:Object.fromEntries(options.promptFormats.map(format=>[format,response().shots[0].prompt_renderings[format]]))}]};
      if(modelHook)await modelHook({requests,messages,options,reply,payload});return JSON.stringify(reply);
    },
  });
  vm.runInContext(section('storyboardCompilerContext'),e.context);
  const onPrepared=async value=>{prepared=value;value.inputGuard.assertCurrent();await value.context.compilerSources.guard();if(preparedHook)await preparedHook(value);};
  return {...e,host,events,controller,initial,calls,domEvents,storage,run:options=>e.context.storyboardCompilePrompt(null,{quiet:true,stream:{floor,signal:controller.signal},onPrepared,...options}),
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
  assert.equal(f.prepared.shotReferences.length,1);assert.equal(f.prepared.shotReferences[0].stream.moment.paragraphId,'P1');
});

test('actual streaming wait leaves existing manual prompts and compiler stages intact without persisting provisional events',async()=>{
  const f=await fixture({wait:true});assert.equal(await f.run(),false);assert.equal(f.prepared.result.shouldGenerate,false);
  assert.deepEqual(editable(f.state),f.initial);assert.deepEqual(f.counts,{requests:1,hostSaves:0,saves:0,renders:0,wakes:1});assert.deepEqual(f.state.logs,[]);f.assertReleased();
});

for(const mode of ['waiting','busy','failed','cancelled'])test(`actual compiler reports ${mode} distinctly without altering its existing boolean API`,async()=>{
  const f=await fixture(mode==='waiting'?{text:'<think>private reasoning</think>\n\nUnfinished'}:{}),outcomes=[];
  if(mode==='busy')f.context.storyboardCompilerBusy=true;
  if(mode==='failed')f.context.storyboardCallCompiler=async()=>{throw Error('simulated failure');};
  if(mode==='cancelled')f.modelHook=()=>{f.state.prompt='USER EDIT';};
  assert.equal(await f.run({onStreamOutcome:value=>outcomes.push(value.status)}),false);
  assert.deepEqual(outcomes,[mode]);assert.deepEqual(f.jobs,[]);if(mode==='busy')f.context.storyboardCompilerBusy=false;f.assertReleased();
});

test('a throwing optional stream outcome observer cannot turn a prepared success into a failure',async()=>{
  const f=await fixture();assert.equal(await f.run({onStreamOutcome:()=>{throw Error('observer only');}}),true);assert.ok(f.prepared);f.assertReleased();
});

test('ordinary extraction does not invoke the stream-only outcome observer',async()=>{
  const f=await fixture({text:'Alice reads a letter in the kitchen.'});f.state.target='floor';f.state.floor='0';
  assert.equal(await f.run({stream:null,onPrepared:null,automatic:true,onStreamOutcome:()=>assert.fail('ordinary observer')}),true);f.assertReleased();
});

test('actual ordinary focused extraction saves the same compact narrative moment in its draft and normalized shot metadata',async()=>{
  const f=await fixture({text:'Alice reads a letter in the kitchen.'});f.state.target='floor';f.state.floor='0';
  assert.equal(await f.run({stream:null,onPrepared:null,automatic:true}),true,JSON.stringify(f.errors));
  const moment=f.state.promptDraft.shots[0].shotSpec.narrativeMoment;
  assert.equal(moment.paragraphId,'P1');assert.equal(moment.quote,'Alice reads a letter in the kitchen.');
  assert.equal(moment.subject,'Alice reads a letter');assert.equal(moment.start,0);f.assertReleased();
});

for(const final of [false,true])test(`actual ${final?'finished-floor':'later streaming'} compiler consumes existing submitted moments before expression`,async()=>{
  const f=await fixture();assert.equal(await f.run(),true);
  const ref=copy(f.prepared.shotReferences[0]);
  f.state.logs.push({id:'occupied',status:'queued',snapshot:{messageRef:ref,chatKey:ref.chatKey,automatic:true,
    imageAdmission:{version:1,namespace:'st-user:route-test',chatKey:ref.chatKey,messageKey:ref.messageKey,revisionId:ref.revisionId,logicalShotId:'a'.repeat(64),automaticSlot:true,attemptId:'occupied'}}});
  assert.equal(await f.run(final?{stream:null,onPrepared:null,automatic:true}:{}),false,JSON.stringify(f.errors));
  assert.equal(f.counts.requests,3);assert.equal(f.calls[2].payload.committed_images.length,1);
  assert.equal(f.calls[2].payload.constraints.committed_images.occupied,1);assert.deepEqual(f.jobs,[]);
  if(!final){assert.deepEqual(editable(f.state),f.initial);assert.equal(f.prepared.shotReferences.length,0);assert.equal(f.counts.hostSaves,0);}
  else assert.equal(f.counts.hostSaves,1);
  f.assertReleased();
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
  ['automation toggle',f=>{f.state.automation.autoGenerate=!f.state.automation.autoGenerate;}],
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

function installStreamQueue(f){
  const rows=new Map(),now=Date.now(),run=(scope,fn)=>{const key=imageAttemptScopeKey(scope),value=fn(rows.get(key));rows.set(key,copy(value.ledger));return value;};
  const store={close(){},claim:async(scope,input,seeds=[])=>run(scope,value=>claimImageAttempt(importImageAttempts(value,scope,seeds,now),scope,input,now)),
    begin:async(scope,input)=>run(scope,value=>beginImageAttempt(value,scope,input,now)),continue:async(scope,input)=>run(scope,value=>continueImageAttempt(value,scope,input,now)),
    settle:async(scope,input)=>run(scope,value=>settleImageAttempt(value,scope,input,now))};
  const resolve=job=>resolveStoryboardMessageReference(job.messageRef,f.host.chat,{chatKey:'chat-a',namespace:'st-user:route-test',metadata:f.host.chatMetadata});
  const admission=createImageAdmission({store,account:async()=> 'st-user:route-test',ownerId:'stream-page',resolveSource:resolve});
  f.state.automation.autoGenerate=true;f.state.connections.novel.draft.baseUrl='https://image.invalid';
  Object.assign(f.context,{STORYBOARD_PIPELINE_LOG_LIMIT:40,storyboardPlansForPortableExport:async plans=>copy(plans),storyboardDeletePlanArchives:async()=>{},
    storyboardValidatedAnchor:job=>({valid:resolve(job).state==='active'}),storyboardPumpQueue(){},
    storyboardImageAdmissionRuntime:async()=>admission,storyboardSettleImageAdmission:(job,status)=>admission.settle(job,status)});
  vm.runInContext(['storyboardSubmitStreamPrepared','storyboardChooseComfyGenerationRoutes','storyboardQueueJob','storyboardStartLog','storyboardFinishLog',
    'storyboardRecordPreparedJobFailure','storyboardPlanForJob','storyboardSyncTaskState','storyboardSetPlanStatus'].map(section).join('\n'),f.context);
  const outcomes=[],errors=[];
  f.preparedHook=async value=>{try{outcomes.push(await f.context.storyboardSubmitStreamPrepared(value));}catch(error){errors.push(error);throw error;}};
  return {rows,admission,outcomes,errors,queue:f.context.storyboardQueue};
}

test('real stream compiler constructs and admits NAI jobs into the existing queue without borrowing the workbench',async()=>{
  const f=await fixture(),q=installStreamQueue(f),before=editable(f.state);delete before.shotPlans;
  assert.equal(await f.run(),true,JSON.stringify({errors:f.errors,jobErrors:q.errors.map(e=>e.message),notices:f.notices}));
  assert.deepEqual(q.outcomes,[{queued:1,failed:0,prepared:1}]);assert.equal(q.queue.length,1);const job=q.queue[0];
  assert.equal(job.automatic,true);assert.equal(job.profile.count,'1');assert.equal(job.floor,0);assert.equal(job.target,'floor');
  assert.equal(job.messageRef.stream.moment.paragraphId,'P1');assert.equal(job.imageAdmission.revisionId,job.messageRef.revisionId);
  assert.equal(job.imageAdmission.automaticSlot,true);assert.equal(job.promptLocked,false);assert.equal(f.state.shotPlans[0].shots[0].status,'queued');
  assert.equal(f.state.logs[0].snapshot.messageRef.stream.prefixDigest,job.messageRef.stream.prefixDigest);
  assert.equal(f.state.logs[0].snapshot.compilerStages?.[0]?.input?.owned,undefined);
  const after=editable(f.state);delete after.shotPlans;assert.deepEqual(after,before);assert.equal(f.counts.renders,0);f.assertReleased();
  f.host.chat[0].mes+=' more prose after compiler disposal';await q.admission.beforeSubmit(job);
  assert.equal(q.rows.size,1);await q.admission.settle(job,'succeeded');
  assert.equal(await f.run(),false,JSON.stringify(f.errors));assert.equal(q.queue.length,1);assert.equal(f.counts.requests,3);
});

test('stream queue refuses source rewrites before any provider POST even after preparation lifetime ended',async()=>{
  const f=await fixture(),q=installStreamQueue(f);assert.equal(await f.run(),true,JSON.stringify(f.errors));
  f.host.chat[0].mes='Bob arrives.\n\nOther';await assert.rejects(q.admission.beforeSubmit(q.queue[0]),{code:'storyboard_stream_source'});f.assertReleased();
});

test('a single live handoff cannot be submitted twice, and a closed handoff cannot be replayed',async()=>{
  const f=await fixture(),q=installStreamQueue(f);let second;
  f.preparedHook=async value=>{await f.context.storyboardSubmitStreamPrepared(value);try{await f.context.storyboardSubmitStreamPrepared(value);}catch(error){second=error;}};
  assert.equal(await f.run(),true,JSON.stringify(f.errors));assert.equal(second.code,'storyboard_stream_jobs');assert.equal(q.queue.length,1);
  await assert.rejects(f.context.storyboardSubmitStreamPrepared(f.prepared),{code:'storyboard_input_changed'});f.assertReleased();
});

test('queue capacity is checked before publishing stream plans, logs or reservations',async()=>{
  const f=await fixture(),q=installStreamQueue(f);f.context.STORYBOARD_QUEUE_LIMIT=0;
  assert.equal(await f.run(),false);assert.equal(q.errors[0].code,'storyboard_stream_jobs');assert.equal(q.queue.length,0);
  assert.equal(f.state.shotPlans.length,0);assert.equal(f.state.logs.length,0);assert.equal(q.rows.size,0);f.assertReleased();
});

test('stream plan retention never drops a still active plan to submit another request',async()=>{
  const f=await fixture(),q=installStreamQueue(f);f.state.shotPlans=Array.from({length:300},(_,index)=>({id:`active-${index}`,status:'generating'}));
  assert.equal(await f.run(),false);assert.match(q.errors[0].message,/任务记录暂满/);assert.equal(q.queue.length,0);assert.equal(q.rows.size,0);
  assert.equal(f.state.shotPlans.length,300);assert.equal(f.state.shotPlans[0].id,'active-0');f.assertReleased();
});

test('deactivating automatic generation after extraction cannot dispatch a stream request',async()=>{
  const f=await fixture(),q=installStreamQueue(f);f.preparedHook=async value=>{f.state.automation.autoGenerate=false;await f.context.storyboardSubmitStreamPrepared(value);};
  assert.equal(await f.run(),false);assert.equal(q.queue.length,0);assert.equal(q.rows.size,0);assert.equal(f.state.shotPlans.length,0);f.assertReleased();
});

test('a queue hook exception after acceptance reports the already accepted image rather than safe-to-repeat zero',async()=>{
  const f=await fixture(),q=installStreamQueue(f),queue=f.context.storyboardQueueJob;
  f.context.storyboardQueueJob=async(...args)=>{const accepted=await queue(...args);if(accepted)throw Error('post-queue observer interrupted');return accepted;};
  assert.equal(await f.run(),false);assert.deepEqual(q.errors[0].streamOutcome,{queued:1,failed:0,prepared:1});
  assert.equal(q.queue.length,1);assert.equal(f.state.logs.length,1);assert.equal(f.state.logs[0].status,'queued');f.assertReleased();
});

test('stream job preparation waits without touching plans when narrative requests no image',async()=>{
  const f=await fixture({wait:true}),q=installStreamQueue(f);assert.equal(await f.run(),false);
  assert.deepEqual(q.outcomes,[{queued:0,failed:0,prepared:0}]);assert.equal(f.state.shotPlans.length,0);assert.equal(q.queue.length,0);assert.equal(q.rows.size,0);f.assertReleased();
});

function useShotSet(f,indexes,after){
  f.modelHook=({reply,payload,options})=>{
    if(options.jsonSchemaName==='qianmu.storyboard.narrative.v1'){
      reply.shots=indexes.map(index=>{
        const {prompt_atoms,prompt_renderings,...shot}=response().shots[index],id=`P${index+1}`;
        const quote=payload.source_catalogue.find(row=>row.floor===0).passages.find(row=>row.paragraph_id===id).text;
        const anchor={floor:0,branch_id:'present',paragraph_id:id,quote};
        return {...shot,state_point:{branchId:'present',paragraphId:id,evidence:quote},
          ...(payload.constraints.streaming?{stream_support:{scene:anchor,content:anchor,presence:shot.characters.map(character=>({character_id:character.character_id,source:anchor}))}}:{})};
      });
    }else reply.shots=payload.shots.map(item=>{
      const shot=response().shots.find(shot=>shot.subject===item.plan.subject);
      return {shot_id:item.shot_id,prompt_atoms:shot.prompt_atoms,prompt_renderings:Object.fromEntries(options.promptFormats.map(format=>[format,shot.prompt_renderings[format]]))};
    });
    after?.({reply,payload,options});
  };
}
const threeParagraphs='Alice reads a letter in the kitchen.\n\nA mountain valley stretches into the sunlight.\n\nA broken cup rests on the table.\n\nUnfinished';
async function continueHost(f,text,{floor=0}={}){
  const message=f.host.chat[floor],handle=captureStoryboardContinuation({type:'continue',getContext:()=>f.host,epoch:()=>0,createReference:createStoryboardMessageReference});
  assert.ok(handle);assert.ok(text.startsWith(message.mes));message.mes=text;
  message.gen_started+='-continue';message.send_date+='-continue';message.swipe_info=[{send_date:message.send_date,gen_started:message.gen_started,extra:{}}];
  try{await saveStoryboardContinuation(handle,async()=>'st-user:route-test',f.host.chatMetadata.story_director_liminale,f.host.saveMetadata);}finally{handle.close();}
}

test('explicit continue reuses actual plan, occupied moments and admission budget while queue jobs keep fresh source proofs',async()=>{
  const f=await fixture({text:threeParagraphs.split('\n\n')[0]+'\n\n'}),q=installStreamQueue(f);useShotSet(f,[0]);
  assert.equal(await f.run(),true,JSON.stringify(f.errors));const old=copy(q.queue[0]),plan=f.state.shotPlans[0],planId=plan.id;
  await continueHost(f,threeParagraphs.split('\n\n').slice(0,2).join('\n\n')+'\n\n');useShotSet(f,[0,1]);
  assert.equal(await f.run(),true,JSON.stringify(f.errors));assert.equal(q.queue.length,2);assert.equal(q.rows.size,1);assert.equal(f.state.shotPlans.length,1);
  const next=q.queue[1];assert.equal(plan.id,planId);assert.equal(plan.shots.length,2);assert.equal(new Set(plan.shots.map(row=>row.id)).size,2);assert.deepEqual(copy(q.queue[0]),old);
  assert.equal(next.messageRef.stream.version,2);assert.notEqual(next.messageRef.messageKey,old.messageRef.messageKey);
  assert.equal(next.messageRef.stream.family.reference.messageKey,old.messageRef.messageKey);assert.equal(next.imageAdmission.revisionId,old.imageAdmission.revisionId);
  assert.equal(f.calls[2].payload.committed_images.length,1);assert.equal(f.calls[2].payload.constraints.committed_images.remaining,2);
  await q.admission.beforeSubmit(next);await q.admission.beforeSubmit(q.queue[0]);f.assertReleased();
});

test('multiple explicit continues retain one original plan and sort actual normalized waiting entries by prose, not generation identity',async()=>{
  const f=await fixture({text:threeParagraphs.split('\n\n').slice(0,2).join('\n\n')+'\n\n'}),q=installStreamQueue(f);useShotSet(f,[1]);
  assert.equal(await f.run(),true);const original=copy(q.queue[0]);
  await continueHost(f,threeParagraphs.replace('Unfinished','An ending.'));useShotSet(f,[0,1]);
  assert.equal(await f.run({stream:{floor:0,complete:true}}),true,JSON.stringify(f.errors));
  await continueHost(f,f.host.chat[0].mes+'\n\nLater.');useShotSet(f,[0,1,2]);
  assert.equal(await f.run({stream:{floor:0,complete:true}}),true,JSON.stringify(f.errors));
  assert.equal(q.queue.length,3);assert.equal(q.rows.size,1);assert.equal(f.state.shotPlans.length,1);
  assert.deepEqual(q.queue.map(row=>row.messageRef.stream.moment.paragraphId),['P2','P1','P3']);
  const entries=buildStoryboardInlineTasks(normalizeStoryboardState(copy(f.state)).taskStates,{chatKey:'chat-a',chat:f.host.chat,metadata:f.host.chatMetadata,
    logs:f.state.logs,records:[],waitingIds:new Set(q.queue.map(row=>row.id))});
  assert.equal(entries.length,3);assert.deepEqual(sortStoryboardInlineRecords(entries).map(row=>row.messageRef.stream.moment.paragraphId),['P1','P2','P3']);
  assert.deepEqual(copy(q.queue[0]),original);assert.equal(q.queue[2].messageRef.stream.family.reference.stream.version,1);
  assert.equal(q.queue[2].messageRef.stream.family.reference.messageKey,original.messageRef.messageKey);f.assertReleased();
});

test('finished continuation discovers old-key stream history before the ordinary automatic path and remains notification-idempotent',async()=>{
  const f=await fixture({text:threeParagraphs.split('\n\n')[0]+'\n\n'}),q=installStreamQueue(f);useShotSet(f,[0]);assert.equal(await f.run(),true);
  const final=installFinalNotifications(f);assert.equal(await final.run(),false);const previous=copy(f.state.shotPlans[0].streamFinalCapture);
  await continueHost(f,threeParagraphs.replace('\n\nUnfinished',''));useShotSet(f,[0,1,2]);
  assert.equal(await final.run(),true,JSON.stringify(f.errors));assert.equal(q.queue.length,3);assert.equal(q.rows.size,1);assert.equal(f.state.shotPlans.length,1);
  assert.notEqual(f.state.shotPlans[0].streamFinalCapture.sourceRevisionId,previous.sourceRevisionId);assert.equal(f.state.shotPlans[0].streamFinalCapture.status,'complete');
  const count=f.counts.requests;assert.equal(await final.run(),false);assert.equal(f.counts.requests,count);f.assertReleased();
});

test('a fully occupied original budget still blocks continued shots before expression without creating another plan',async()=>{
  const f=await fixture({text:threeParagraphs.split('\n\n')[0]+'\n\n'}),q=installStreamQueue(f);f.state.generationPolicy.maxImages=1;useShotSet(f,[0]);assert.equal(await f.run(),true);
  await continueHost(f,threeParagraphs.replace('\n\nUnfinished',''));useShotSet(f,[0]);const final=installFinalNotifications(f);
  assert.equal(await final.run(),false,JSON.stringify(f.errors));assert.equal(f.counts.requests,3);assert.equal(q.queue.length,1);assert.equal(q.rows.size,1);
  assert.equal(f.calls[2].payload.constraints.max_shots,0);assert.equal(f.state.shotPlans[0].streamFinalCapture.status,'complete');
  assert.equal(await final.run(),false);assert.equal(f.counts.requests,3);f.assertReleased();
});

test('an original plan survives explicitly unsubmitted failure even with zero occupied slots, but missing delivery evidence is not free capacity',async()=>{
  for(const missing of [false,true]){
    const f=await fixture({text:threeParagraphs.split('\n\n')[0]+'\n\n'}),q=installStreamQueue(f);useShotSet(f,[0]);assert.equal(await f.run(),true);
    const plan=f.state.shotPlans[0],id=plan.id;
    if(missing)f.state.logs=[];
    else{const old=q.queue.shift();await q.admission.settle(old,'not_submitted');Object.assign(f.state.logs[0],{status:'failed',submissionState:'not_submitted'});plan.shots[0].status='failed';plan.status='failed';}
    await continueHost(f,threeParagraphs.split('\n\n').slice(0,2).join('\n\n')+'\n\n');useShotSet(f,[1]);
    assert.equal(await f.run(),!missing,JSON.stringify(f.errors));assert.equal(f.state.shotPlans.length,1);assert.equal(plan.id,id);assert.equal(q.rows.size,1);
    if(!missing){assert.equal(q.queue.at(-1).messageRef.stream.version,2);assert.equal(plan.shots.length,2);assert.equal(f.calls[2].payload.constraints.committed_images.occupied,0);}
    else{assert.equal(f.counts.requests,2);assert.equal(q.queue.length,1);}
    f.assertReleased();
  }
});

test('continuation with missing, duplicate, corrupt or manually cancelled original plan cannot fall back to a new automatic plan',async()=>{
  for(const mode of ['missing','duplicate','cancelled','bad-id','bad-digest']){
    const f=await fixture({text:threeParagraphs.split('\n\n')[0]+'\n\n'}),q=installStreamQueue(f);useShotSet(f,[0]);assert.equal(await f.run(),true);
    await continueHost(f,threeParagraphs.replace('\n\nUnfinished',''));useShotSet(f,[0,1]);const final=installFinalNotifications(f);
    if(mode==='missing')f.state.shotPlans=[];
    if(mode==='duplicate')f.state.shotPlans.push({...copy(f.state.shotPlans[0]),id:'duplicate'});
    if(mode==='cancelled')f.state.shotPlans[0].status='cancelled';
    if(mode==='bad-id')f.state.shotPlans[0].id='unrelated-plan';
    if(mode==='bad-digest')f.host.chatMetadata.story_director_liminale.storyboardContinuations[0].digest='a'.repeat(64);
    assert.equal(await final.run(),false,JSON.stringify(f.errors));assert.equal(f.counts.requests,2);assert.equal(q.queue.length,1);assert.equal(q.rows.size,1);f.assertReleased();
  }
});

test('changing the saved append relation during expression cannot submit a new continuation job or replace the old plan',async()=>{
  const f=await fixture({text:threeParagraphs.split('\n\n')[0]+'\n\n'}),q=installStreamQueue(f);useShotSet(f,[0]);assert.equal(await f.run(),true);
  const before=copy(f.state.shotPlans[0]);await continueHost(f,threeParagraphs.split('\n\n').slice(0,2).join('\n\n')+'\n\n');useShotSet(f,[1]);
  f.modelHook=({reply,payload,options})=>{
    if(options.jsonSchemaName==='qianmu.storyboard.narrative.v1'){
      const {prompt_atoms,prompt_renderings,...shot}=response().shots[1],quote=payload.source_catalogue[0].passages[1].text,anchor={floor:0,branch_id:'present',paragraph_id:'P2',quote};
      reply.shots=[{...shot,state_point:{branchId:'present',paragraphId:'P2',evidence:quote},stream_support:{scene:anchor,content:anchor,presence:[]}}];
    }else{reply.shots=payload.shots.map(row=>({shot_id:row.shot_id,prompt_atoms:response().shots[1].prompt_atoms,prompt_renderings:response().shots[1].prompt_renderings}));delete f.host.chatMetadata.story_director_liminale.storyboardContinuations;}
  };
  assert.equal(await f.run(),false);assert.equal(q.queue.length,1);assert.deepEqual(copy(f.state.shotPlans[0]),before);f.assertReleased();
});

test('continued planning respects a locked/manual-review original plan before making another model request',async()=>{
  for(const flag of ['promptLocked','manualReviewRequired']){
    const f=await fixture({text:threeParagraphs.split('\n\n')[0]+'\n\n'}),q=installStreamQueue(f);assert.equal(await f.run(),true);
    await continueHost(f,threeParagraphs.split('\n\n').slice(0,2).join('\n\n')+'\n\n');f.state.shotPlans[0][flag]=true;useShotSet(f,[1]);
    assert.equal(await f.run(),false);assert.equal(f.counts.requests,2);assert.equal(q.queue.length,1);assert.equal(q.rows.size,1);f.assertReleased();
  }
});

test('serialized and lightweight archived original plans keep their identity when continued jobs are prepared',async()=>{
  const f=await fixture({text:threeParagraphs.split('\n\n')[0]+'\n\n'}),q=installStreamQueue(f);useShotSet(f,[0]);assert.equal(await f.run(),true);
  const final=installFinalNotifications(f),original=copy(f.state.shotPlans[0]),archive='original-stream-archive';
  f.state.shotPlans=[f.context.storyboardPlanLightweightSummary(original,archive)];f.state.shotPlans=normalizeStoryboardState(copy(f.state)).shotPlans;
  f.context.storyboardPlansForPortableExport=async()=>[copy(original)];
  await continueHost(f,threeParagraphs.replace('\n\nUnfinished',''));useShotSet(f,[0,1,2]);
  assert.equal(await final.run(),true,JSON.stringify(f.errors));const plan=f.state.shotPlans[0];
  assert.equal(plan.id,original.id);assert.equal(plan.revisionId,original.revisionId);assert.equal(plan.shots.length,3);assert.equal(plan.shots[0].prompt,original.shots[0].prompt);
  assert.equal(q.rows.size,1);assert.equal(q.queue[1].messageRef.stream.version,2);f.assertReleased();
});

test('actual continuation coverage on a high-floor chat reads only the selected context and target source, not unrelated prose',async()=>{
  const f=await fixture({floor:3999,text:'Alice reads a letter in the kitchen.\n\n'}),q=installStreamQueue(f);
  for(let n=0;n<3997;n++)Object.defineProperty(f.host.chat[n],'mes',{get(){assert.fail('unselected earlier prose read');}});
  assert.equal(await f.run(),true,JSON.stringify(f.errors));
  await continueHost(f,f.host.chat[3999].mes+'A new scene.\n\n',{floor:3999});
  assert.equal(await f.run(),false,JSON.stringify(f.errors));assert.equal(f.counts.requests,3);assert.equal(q.queue.length,1);assert.equal(q.rows.size,1);
  assert.deepEqual(f.calls[2].payload.source_catalogue.map(row=>row.floor),[3997,3998,3999]);f.assertReleased();
});

test('later stream frames append one new shot to the same plan and ledger without replacing accepted shots',async()=>{
  const f=await fixture({text:threeParagraphs}),q=installStreamQueue(f);useShotSet(f,[0]);
  assert.equal(await f.run(),true,JSON.stringify(f.errors));const first=copy(q.queue[0]);
  useShotSet(f,[0,1]);assert.equal(await f.run(),true,JSON.stringify(f.errors));
  assert.equal(q.queue.length,2);assert.equal(q.rows.size,1);assert.equal(f.state.shotPlans.length,1);assert.equal(f.state.shotPlans[0].shots.length,2);
  assert.deepEqual(copy(q.queue[0]),first);assert.equal(q.queue[1].messageRef.stream.moment.paragraphId,'P2');
  assert.equal(q.queue[0].inlineOrder.batchId,q.queue[1].inlineOrder.batchId);assert.deepEqual(q.queue.map(job=>job.inlineOrder.shotIndex),[0,1]);
  assert.equal(q.queue[0].imageAdmission.revisionId,q.queue[1].imageAdmission.revisionId);assert.equal(f.counts.requests,4);f.assertReleased();
});

test('actual final handoff fills only new scenes, persists final state and queues whole-prose proofs in the original automatic budget',async()=>{
  const f=await fixture({text:'Alice reads a letter in the kitchen.\n\nA mountain'}),q=installStreamQueue(f);useShotSet(f,[0]);
  assert.equal(await f.run(),true,JSON.stringify(f.errors));const first=copy(q.queue[0]),manual=editable(f.state);delete manual.shotPlans;
  f.host.chat[0].mes=threeParagraphs.replace('\n\nUnfinished','');useShotSet(f,[0,1,2]);
  assert.equal(await f.run({stream:{floor:0,complete:true}}),true,JSON.stringify(f.errors));assert.equal(q.queue.length,3);assert.equal(q.rows.size,1);
  assert.deepEqual(copy(q.queue[0]),first);assert.equal(f.counts.hostSaves,1);assert.equal(f.counts.requests,4);
  for(const job of q.queue.slice(1)){
    assert.equal(job.messageRef.stream.complete,true);assert.equal(job.messageRef.stream.prefixLength,f.host.chat[0].mes.length);
    assert.equal(job.imageAdmission.revisionId,first.imageAdmission.revisionId);assert.equal(job.imageAdmission.automaticSlot,true);
    assert.notEqual(job.messageRef.stream.prefixDigest,first.messageRef.stream.prefixDigest);
  }
  assert.equal(f.calls[2].payload.constraints.streaming,undefined);assert.ok(f.calls[2].payload.source_catalogue[0].passages.some(p=>p.text==='A broken cup rests on the table.'));
  assert.deepEqual(q.queue.map(job=>job.messageRef.stream.moment.paragraphId),['P1','P2','P3']);
  const after=editable(f.state);delete after.shotPlans;assert.deepEqual(after,manual);f.assertReleased();
  f.host.chat[0].mes+=' Another sentence.';
  await assert.rejects(q.admission.beforeSubmit(q.queue[1]),{code:'storyboard_stream_source'});
  await q.admission.beforeSubmit(q.queue[0]);
});

test('real early and final jobs deliver in prose order with normalized task markers and stable original queue identities',async()=>{
  const f=await fixture({text:'Alice reads a letter in the kitchen.\n\nA mountain valley stretches into the sunlight.\n\nA broken'}),q=installStreamQueue(f);
  Object.assign(f.context,{storyboardProductionDeliveryPolicy,storyboardItemCollectionIds:()=>[],uniqueClean:value=>value});
  vm.runInContext(section('storyboardCreateRecord')+'\n'+section('storyboardInlineTaskMarkup'),f.context);
  useShotSet(f,[1]);assert.equal(await f.run(),true,JSON.stringify(f.errors));
  const initial=q.queue[0],image=f.context.storyboardCreateRecord(initial,f.state.logs[0],'/user/images/early.png',0,{floor:0,message:f.host.chat[0],valid:true},{});
  f.host.chat[0].mes=threeParagraphs.replace('\n\nUnfinished','');useShotSet(f,[0,1,2]);
  assert.equal(await f.run({stream:{floor:0,complete:true}}),true,JSON.stringify(f.errors));
  assert.deepEqual(q.queue.map(job=>job.messageRef.stream.moment.paragraphId),['P2','P1','P3']);
  assert.deepEqual(q.queue.map(job=>job.inlineOrder.shotIndex),[0,1,2]);
  const tasks=normalizeStoryboardState(copy(f.state)).taskStates;
  const entries=buildStoryboardInlineTasks(tasks,{chatKey:'chat-a',chat:f.host.chat,records:[image],logs:f.state.logs,waitingIds:new Set(q.queue.map(job=>job.id))});
  assert.equal(entries.length,2);
  const sorted=sortStoryboardInlineRecords([image,...entries]);
  assert.deepEqual(sorted.map(row=>row.messageRef.stream.moment.paragraphId),['P1','P2','P3']);
  const indexes=storyboardInlineDisplayIndexes([image,...entries]);
  assert.match(f.context.storyboardInlineTaskMarkup(sorted[0],indexes.get(sorted[0])),/第 1 镜/);
  assert.equal(sorted[0].inlineOrder.shotIndex,1);assert.equal(initial.inlineOrder.shotIndex,0);
  const last=q.queue[2],lastImage=f.context.storyboardCreateRecord(last,f.state.logs.find(log=>log.taskId===last.id),'/user/images/last.png',0,{floor:0,message:f.host.chat[0],valid:true},{});
  assert.notEqual(image.messageHash,lastImage.messageHash);
  delete image.snapshot;delete lastImage.snapshot;
  assert.deepEqual(sortStoryboardInlineRecords([lastImage,image,sorted[0]]).map(row=>row.messageRef.stream.moment.paragraphId),['P1','P2','P3']);
  assert.equal(q.rows.size,1);assert.equal(f.state.shotPlans.length,1);f.assertReleased();
});

test('final scoped preparation works when no partial image was ready and the last paragraph has no blank-line terminator',async()=>{
  const f=await fixture({text:'Alice reads a letter in the kitchen.'}),q=installStreamQueue(f);
  assert.equal(await f.run({stream:{floor:0,complete:true}}),true,JSON.stringify(f.errors));assert.equal(q.queue.length,1);assert.equal(f.counts.hostSaves,1);
  assert.equal(q.queue[0].messageRef.stream.complete,true);assert.equal(q.queue[0].messageRef.stream.prefixLength,f.host.chat[0].mes.length);f.assertReleased();
});

test('a fully occupied final pass still publishes continuity without expression or additional image requests',async()=>{
  const f=await fixture({text:threeParagraphs}),q=installStreamQueue(f);f.state.generationPolicy.maxImages=1;useShotSet(f,[0]);assert.equal(await f.run(),true);
  assert.equal(await f.run({stream:{floor:0,complete:true}}),false,JSON.stringify(f.errors));assert.equal(q.queue.length,1);assert.equal(f.counts.hostSaves,1);assert.equal(f.counts.requests,3);
  assert.deepEqual(q.outcomes.at(-1),{queued:0,failed:0,prepared:0});f.assertReleased();
});

for(const complete of [false,true])test(`${complete?'final':'partial'} isolated automatic preparation ignores, but preserves, the workbench's manual paragraph selection`,async()=>{
  const f=await fixture({text:threeParagraphs}),q=installStreamQueue(f);
  f.state.paragraphMode='manual';f.state.manualParagraphIndex=2;f.state.pendingParagraphSelection={mode:'manual_supplement',indexes:[2],paragraphIds:['P3'],insertAfterIndex:2};
  const before=editable(f.state);delete before.shotPlans;
  assert.equal(await f.run({stream:{floor:0,complete}}),true,JSON.stringify(f.errors));assert.equal(q.queue.length,1);
  assert.equal(q.queue[0].messageRef.stream.moment.paragraphId,'P1');assert.equal(q.queue[0].manualSupplement,false);
  const after=editable(f.state);delete after.shotPlans;assert.deepEqual(after,before);f.assertReleased();
});

test('any terminal text edit or append during the final model call cancels the isolated result before image submission',async()=>{
  for(const append of [true,false]){
    const f=await fixture({text:threeParagraphs}),q=installStreamQueue(f);f.modelHook=()=>{f.host.chat[0].mes=append?f.host.chat[0].mes+' later':'changed';};
    assert.equal(await f.run({stream:{floor:0,complete:true}}),false);assert.equal(q.queue.length,0);assert.equal(f.counts.requests,1);assert.equal(f.counts.hostSaves,0);f.assertReleased();
  }
});

test('streaming shot group preserves original proof association even when duplicate coverage removes an earlier draft',async()=>{
  const f=await fixture({text:threeParagraphs}),q=installStreamQueue(f);useShotSet(f,[0,1,2]);
  const prepare=f.context.storyboardPrepareDraftGroup;
  f.context.storyboardPrepareDraftGroup=(...args)=>{const group=prepare(...args);group.planned=group.planned.slice(1);return group;};
  assert.equal(await f.run(),true,JSON.stringify(f.errors));assert.equal(q.queue.length,2);
  assert.deepEqual(q.queue.map(job=>job.messageRef.stream.moment.paragraphId),['P2','P3']);f.assertReleased();
});

test('one later mirror configuration failure aborts all unsubmitted stream jobs before any fee reservation',async()=>{
  const f=await fixture({text:threeParagraphs}),q=installStreamQueue(f);useShotSet(f,[0,1]);let calls=0;
  const create=f.context.storyboardCreateJob;f.context.storyboardCreateJob=(...args)=>{if(++calls===2)throw Error('second mirror model is unavailable');return create(...args);};
  assert.equal(await f.run(),false);assert.equal(q.queue.length,0);assert.equal(q.rows.size,0);assert.equal(f.state.shotPlans.length,0);
  assert.deepEqual(q.errors[0].streamOutcome,{queued:0,failed:0,prepared:0});f.assertReleased();
});

test('a refused middle stream mirror records only that unsubmitted mirror while its neighbors enter the queue',async()=>{
  const f=await fixture({text:threeParagraphs}),q=installStreamQueue(f);useShotSet(f,[0,1,2]);
  const admit=q.admission.admit.bind(q.admission);q.admission.admit=async(job,...args)=>{if(job.inlineOrder.shotIndex===1)throw Error('isolated reservation failure');return admit(job,...args);};
  assert.equal(await f.run(),true,JSON.stringify(f.errors));assert.deepEqual(q.outcomes,[{queued:2,failed:1,prepared:3}]);
  assert.deepEqual(q.queue.map(job=>job.inlineOrder.shotIndex),[0,2]);assert.deepEqual(f.state.shotPlans[0].shots.map(shot=>shot.status),['queued','failed','queued']);
  const failed=f.state.logs.find(log=>log.status==='failed');assert.equal(failed.submissionState,'not_submitted');assert.equal(failed.snapshot.messageRef.stream.moment.paragraphId,'P2');f.assertReleased();
});

test('an account or source interruption after first acceptance cannot submit later mirrors or erase the accepted result',async()=>{
  const f=await fixture({text:threeParagraphs}),q=installStreamQueue(f);useShotSet(f,[0,1,2]);
  const queue=f.context.storyboardQueueJob;f.context.storyboardQueueJob=async(...args)=>{const ok=await queue(...args);if(ok)f.controller.abort();return ok;};
  assert.equal(await f.run(),false);assert.equal(q.queue.length,1);assert.deepEqual(q.errors[0].streamOutcome,{queued:1,failed:0,prepared:3});
  assert.equal(f.state.logs.length,1);assert.equal(f.state.logs[0].status,'queued');
  assert.deepEqual(f.state.shotPlans[0].shots.map(shot=>shot.status),['queued','cancelled','cancelled']);f.assertReleased();
});

test('pinned mixed Comfy/NAI stream jobs keep their own workflow, model prompt format and single-image count',async()=>{
  const f=await fixture({text:threeParagraphs}),q=installStreamQueue(f);useShotSet(f,[0,1,2]);f.state.routing.enabled=true;
  f.state.connections.comfy.draft.baseUrl='https://comfy.invalid';
  f.context.storyboardPreflightComfyForCompiler=async()=>[]; // No real Comfy endpoint: readiness is outside this isolated queue test.
  f.context.storyboardConfirmComfyExecution=async()=>true;
  f.context.storyboardParseWorkflow=value=>typeof value==='string'?JSON.parse(value):value;
  assert.equal(await f.run(),true,JSON.stringify({errors:f.errors,queue:q.errors.map(e=>e.message),notices:f.notices}));
  assert.deepEqual(q.queue.map(job=>job.source),['comfy','comfy','novel'],JSON.stringify(f.notices));assert.deepEqual(q.queue.map(job=>job.profile.count),['1','1','1']);
  assert.deepEqual(q.queue.map(job=>job.messageRef.stream.moment.paragraphId),['P1','P2','P3']);
  assert.equal(q.queue[0].profile.comfyRouteBinding.id,'portrait');assert.equal(q.queue[1].profile.comfyRouteBinding.id,'landscape');
  assert.equal(q.queue[0].profile.comfyRoutePromptFormat,'tags');assert.equal(q.queue[1].profile.comfyRoutePromptFormat,'natural_language');
  assert.equal(q.queue[2].payload.compiledPrompt.promptFormat,'tags');assert.equal(q.rows.size,1);f.assertReleased();
});

test('terminal retention removes only the oldest terminal plan after successful stream preparation',async()=>{
  const f=await fixture(),q=installStreamQueue(f),removed=[];
  f.state.shotPlans=Array.from({length:300},(_,index)=>({id:`old-${index}`,status:index===299?'completed':'generating'}));
  f.context.storyboardPlanIsTerminal=plan=>plan?.status==='completed';f.context.storyboardDeletePlanArchives=async plans=>removed.push(...plans.map(plan=>plan.id));
  assert.equal(await f.run(),true,JSON.stringify(f.errors));assert.equal(q.queue.length,1);assert.equal(f.state.shotPlans.length,300);
  assert.deepEqual(removed,['old-299']);assert.ok(f.state.shotPlans.some(plan=>plan.id==='old-298'));f.assertReleased();
});

test('reopening an archived generation restores its full earlier shots before appending and retains the archived recovery copy',async()=>{
  const f=await fixture({text:threeParagraphs}),q=installStreamQueue(f);useShotSet(f,[0]);
  assert.equal(await f.run(),true);const plan=f.state.shotPlans[0];plan.status='completed';plan.shots[0].status='completed';plan.shots[0].resultIds=['kept-image'];plan.archiveRef='old-archive';
  const archive=copy(plan);plan.shots[0].prompt='';plan.shots[0].shotSpec=null;let loaded=0;
  f.context.storyboardPlansForPortableExport=async(plans,options)=>{assert.equal(plans[0],plan);assert.equal(options.strict,true);loaded++;return [copy(archive)];};
  useShotSet(f,[1]);assert.equal(await f.run(),true,JSON.stringify(f.errors));assert.equal(loaded,1);assert.equal(f.state.shotPlans.length,1);
  assert.equal(plan.archiveRef,undefined);assert.equal(archive.archiveRef,'old-archive');assert.equal(plan.shots[0].prompt,archive.shots[0].prompt);
  assert.deepEqual(plan.shots[0].shotSpec,archive.shots[0].shotSpec);assert.equal(plan.shots[0].status,'completed');
  assert.deepEqual(plan.shots[0].resultIds,['kept-image']);assert.equal(plan.shots[1].status,'queued');assert.equal(q.queue.length,2);f.assertReleased();
});

test('auto-selected stream Comfy jobs attach the captured selection and close the batch with the compiler',async()=>{
  const f=await fixture(),q=installStreamQueue(f);f.state.routing.enabled=true;f.state.connections.comfy.draft.baseUrl='https://comfy.invalid';
  f.context.storyboardPreflightComfyForCompiler=async()=>[];f.context.storyboardConfirmComfyExecution=async()=>true;f.context.storyboardParseWorkflow=value=>value;
  let attached=0,closed=0;
  f.context.storyboardChooseComfyGenerationRoutes=async(_state,guard,planned,routes)=>{
    const batch={attach:async(job)=>{attached++;assert.ok(job.messageRef.stream.moment);},close:()=>closed++};guard.comfyBatch=batch;
    return {routes,choices:new Map([[0,{candidateId:'portrait',target:routes[0]}]]),failures:new Map(),batch};
  };
  f.preparedHook=async value=>{value.inputGuard.comfyAuto={close(){}};q.outcomes.push(await f.context.storyboardSubmitStreamPrepared(value));};
  assert.equal(await f.run(),true,JSON.stringify({errors:f.errors,notices:f.notices}));assert.equal(attached,1);assert.equal(closed,1);
  assert.equal(q.queue[0].comfyAutoSelected,true);assert.ok(q.queue[0].compilerStages.some(row=>row.type==='comfy_selection'));f.assertReleased();
});

test('a missing archived plan blocks only the new stream batch and preserves its original archive marker',async()=>{
  const f=await fixture({text:threeParagraphs}),q=installStreamQueue(f);useShotSet(f,[0]);assert.equal(await f.run(),true);
  const plan=f.state.shotPlans[0];plan.archiveRef='missing';const original=copy(plan);
  f.context.storyboardPlansForPortableExport=async()=>{throw Error('archive missing');};useShotSet(f,[1]);
  assert.equal(await f.run(),false);assert.equal(q.queue.length,1);assert.deepEqual(copy(plan),original);f.assertReleased();
});

test('a concurrent archive replacement during preparation cannot append jobs to a detached plan object',async()=>{
  const f=await fixture({text:threeParagraphs}),q=installStreamQueue(f);useShotSet(f,[0]);assert.equal(await f.run(),true);
  const old=f.state.shotPlans[0],replacement=copy(old),adapt=f.context.storyboardAdaptShotForModel;
  f.context.storyboardAdaptShotForModel=async(...args)=>{f.state.shotPlans[0]=replacement;return adapt(...args);};useShotSet(f,[1]);
  assert.equal(await f.run(),false);assert.equal(q.queue.length,1);assert.equal(replacement.shots.length,1);assert.equal(old.shots.length,1);
  assert.match(q.errors.at(-1).message,/归档或替换/);f.assertReleased();
});

function installFinalNotifications(f){
  f.state.promptCompiler.enabled=true;f.context.storyboardAutomaticEpoch=0;
  vm.runInContext(['storyboardAutomaticTicketFloor','storyboardFinishStreamCapture','storyboardPlanForMessage','storyboardPerformAutomaticCapture',
    'storyboardPlanLightweightSummary'].map(section).join('\n'),f.context);
  const ticket=()=>({state:f.state,epoch:0,chatKey:'chat-a',floor:0,message:f.host.chat[0],createdAt:Date.now(),autoGenerate:true,
    messageRef:createStoryboardMessageReference({message:f.host.chat[0],chatKey:'chat-a',floor:0})});
  return {run:()=>f.context.storyboardPerformAutomaticCapture(ticket()),finish:()=>f.context.storyboardFinishStreamCapture(ticket()),ticket};
}

function installPassScheduler(f){
  const final=installFinalNotifications(f),timers=new Map(),outcomes=[];let seq=0,completion=null,finishes=0;
  const scheduler=createStoryboardStreamScheduler({isCurrent:()=>f.host.chatId==='chat-a'&&!f.controller.signal.aborted,busy:()=>f.context.storyboardCompilerBusy,
    read:()=>f.host.chat[0].mes,setTimer:fn=>{const id=++seq;timers.set(id,fn);return id;},clearTimer:id=>timers.delete(id),
    run:async({signal})=>{try{const outcome=await runStoryboardStreamPass({compile:f.context.storyboardCompilePrompt,submit:f.context.storyboardSubmitStreamPrepared},{floor:0,signal});outcomes.push(outcome);return outcome;}finally{completion?.resolve();}},
    finish:async()=>{finishes++;return final.run();}});
  return{scheduler,outcomes,timers,get finishes(){return finishes;},async pass(){completion=deferred();const [id,fn]=timers.entries().next().value;timers.delete(id);fn();await completion.promise;for(let i=0;i<8;i++)await Promise.resolve();}};
}

const trackedPass=f=>runStoryboardStreamPass({compile:f.context.storyboardCompilePrompt,submit:f.context.storyboardSubmitStreamPrepared},{floor:0,signal:f.controller.signal});

test('actual first incremental request observes its checkpoint before calling either model stage',async()=>{
  const f=await fixture(),q=installStreamQueue(f);let observed=0;
  f.modelHook=()=>{observed++;assert.equal(f.state.shotPlans.length,1);assert.equal(f.state.shotPlans[0].streamAttempt.status,'preparing');assert.ok(f.counts.saves>0);};
  assert.equal((await trackedPass(f)).status,'advanced');assert.equal(observed,2);assert.equal(q.queue.length,1);
  assert.equal(f.state.shotPlans[0].streamAttempt.status,'ready');f.assertReleased();
});

test('actual first model request waits for ST readback, and records never contain model inputs',async()=>{
  const f=await fixture(),q=installStreamQueue(f),held=deferred(),entered=deferred();let head=false;
  f.storage.hook=async({path,options})=>{
    if(path==='/api/files/upload')head=JSON.parse(Buffer.from(JSON.parse(options.body).data,'base64').toString('utf8')).schema==='qianmu.st-account-head.v1';
    else if(head){entered.resolve();await held.promise;}
  };
  const pending=trackedPass(f);await entered.promise;assert.equal(f.counts.requests,0);assert.equal(q.queue.length,0);assert.equal(f.context.storyboardCompilerBusy,true);
  held.resolve();assert.equal((await pending).status,'advanced');assert.equal(f.counts.requests,2);
  const records=f.storage.checkpoints();assert.deepEqual(records.map(row=>row.attempt.status),['preparing','ready']);
  assert.deepEqual(records.at(-1).attempt,copy(f.state.shotPlans[0].streamAttempt));
  assert.doesNotMatch(JSON.stringify(records),/Alice reads|MANUAL WORKBENCH|prompt|apiKey/);f.assertReleased();
});

test('actual pass and busy ownership wait for settlement readback before reporting completion',async()=>{
  const f=await fixture(),q=installStreamQueue(f),held=deferred(),entered=deferred();let heads=0,completed=false;
  f.storage.hook=async({path,options})=>{
    if(path==='/api/files/upload'&&JSON.parse(Buffer.from(JSON.parse(options.body).data,'base64').toString('utf8')).schema==='qianmu.st-account-head.v1')heads++;
    else if(path.startsWith('/user/files/')&&heads===2){entered.resolve();await held.promise;}
  };
  const pending=trackedPass(f).then(result=>{completed=true;return result;});await entered.promise;
  assert.equal(q.queue.length,1);assert.equal(completed,false);assert.equal(f.context.storyboardCompilerBusy,true);assert.equal(f.state.shotPlans[0].streamAttempt.status,'preparing');
  held.resolve();assert.equal((await pending).status,'advanced');assert.equal(f.state.shotPlans[0].streamAttempt.status,'ready');f.assertReleased();
});

for(const phase of ['prepare','settle'])test(`actual lost ${phase} acknowledgement stops without replay and keeps accepted images`,async()=>{
  const f=await fixture(),q=installStreamQueue(f);let heads=0,failures=0;
  f.storage.hook=({path,options,files})=>{
    if(path!=='/api/files/upload')return;
    const {name,data}=JSON.parse(options.body),body=Buffer.from(data,'base64').toString('utf8');
    if(JSON.parse(body).schema==='qianmu.st-account-head.v1'&&++heads===(phase==='prepare'?1:2)){
      files.set(name,body);failures++;throw Error('simulated persisted head with lost acknowledgement');
    }
  };
  const result=await trackedPass(f);assert.equal(result.status,'failed');assert.equal(failures,1);
  assert.ok(f.notices.some(text=>phase==='settle'?/检查点保存未确认/.test(text):/画面整理失败/.test(text)));
  assert.equal(f.counts.requests,phase==='prepare'?0:2);assert.equal(q.queue.length,phase==='prepare'?0:1);
  assert.equal(f.state.shotPlans[0].streamAttempt.status,'failed');const calls=f.counts.requests;
  f.host.chat[0].mes+=' another paragraph.\n\n';assert.equal((await trackedPass(f)).status,'failed');assert.equal(f.counts.requests,calls);assert.equal(failures,1);f.assertReleased();
});

test('actual missing local plan cannot overwrite the remote checkpoint to start a fresh incremental request',async()=>{
  const f=await fixture({wait:true}),q=installStreamQueue(f);assert.equal((await trackedPass(f)).status,'waiting');
  const oldFiles=[...f.storage.files.entries()],requests=f.counts.requests;f.state.shotPlans=[];f.host.chat[0].mes+=' another paragraph.\n\n';
  assert.equal((await trackedPass(f)).status,'failed');assert.equal(f.counts.requests,requests);assert.deepEqual([...f.storage.files.entries()],oldFiles);
  assert.equal(q.queue.length,0);assert.equal(f.state.shotPlans[0].streamAttempt.status,'failed');f.assertReleased();
});

for(const kind of ['account','source'])test(`actual ${kind} change while saving prevents either model stage`,async()=>{
  const f=await fixture(),q=installStreamQueue(f);let heads=0;
  f.storage.hook=({path,options})=>{
    if(path==='/api/files/upload'&&JSON.parse(Buffer.from(JSON.parse(options.body).data,'base64').toString('utf8')).schema==='qianmu.st-account-head.v1'&&++heads===1){
      if(kind==='account')f.storage.namespace='st-user:other';else f.controller.abort();
    }
  };
  assert.ok(['failed','cancelled'].includes((await trackedPass(f)).status));assert.equal(f.counts.requests,0);assert.equal(q.queue.length,0);f.assertReleased();
});

test('ordinary and untracked preparation open no checkpoint storage, and rejecting observers are isolated',async()=>{
  const f=await fixture(),q=installStreamQueue(f);assert.equal(await f.run({onStreamOutcome:()=>Promise.reject(Error('optional observer'))}),true);
  assert.equal(f.storage.calls.length,0);assert.equal(q.queue.length,1);f.assertReleased();
});

for(const status of ['preparing','failed','cancelled'])test(`actual restored ${status} checkpoint blocks both partial and finished-floor replay before a model call`,async()=>{
  const f=await fixture(),q=installStreamQueue(f);f.modelHook=()=>{throw Error('synthetic interruption');};await trackedPass(f);
  const restored=normalizeStoryboardState(copy(f.state));restored.shotPlans[0].streamAttempt.status=status;f.state.shotPlans=restored.shotPlans;
  const before=copy(f.state.shotPlans),calls=f.counts.requests;f.modelHook=null;f.host.chat[0].mes+='\n\nA later complete paragraph.';
  assert.equal((await trackedPass(f)).status,'failed');assert.equal(await installFinalNotifications(f).run(),false);
  assert.equal(f.counts.requests,calls);assert.equal(q.queue.length,0);assert.deepEqual(copy(f.state.shotPlans),before);f.assertReleased();
});

test('actual waiting prefixes retain one checkpoint, survive lightweight summaries and stop at the durable round limit',async()=>{
  const f=await fixture({text:'Alice reads a letter in the kitchen.\n\n',wait:true}),q=installStreamQueue(f);
  for(let i=0;i<3;i++){
    if(i)f.host.chat[0].mes+=`Another complete paragraph ${i}.\n\n`;
    assert.equal((await trackedPass(f)).status,'waiting');assert.equal(f.state.shotPlans.length,1);assert.equal(f.state.shotPlans[0].streamAttempt.passes,i+1);
  }
  installFinalNotifications(f);const plan=f.state.shotPlans[0],summary=f.context.storyboardPlanLightweightSummary(plan);
  assert.deepEqual(copy(summary.streamAttempt),copy(plan.streamAttempt));assert.equal(normalizeStoryboardState(copy(f.state)).shotPlans[0].streamAttempt.passes,3);
  f.host.chat[0].mes+='A fourth complete paragraph.\n\n';assert.equal((await trackedPass(f)).status,'waiting');assert.equal(f.counts.requests,3);
  assert.equal(await installFinalNotifications(f).run(),false);assert.equal(f.counts.requests,4);assert.equal(plan.streamFinalCapture.status,'complete');assert.equal(q.queue.length,0);f.assertReleased();
});

test('actual final capture rejects an edited later waiting fragment even when the original first prefix still matches',async()=>{
  const f=await fixture({text:'Alice reads a letter in the kitchen.\n\n',wait:true}),q=installStreamQueue(f);await trackedPass(f);
  f.host.chat[0].mes+='The kitchen is quiet.\n\n';await trackedPass(f);assert.equal(f.counts.requests,2);
  f.host.chat[0].mes=f.host.chat[0].mes.replace('The kitchen is quiet.','The room has changed.')+'Another paragraph.';
  assert.equal(await installFinalNotifications(f).run(),false);assert.equal(f.counts.requests,2);assert.equal(q.queue.length,0);
  assert.match(f.notices.at(-1),/片段或原检查点改变/);assert.equal(f.state.shotPlans[0].streamFinalCapture,undefined);f.assertReleased();
});

test('actual checkpoint persistence failure prevents the first model request and preserves a failed no-replay marker',async()=>{
  const f=await fixture(),q=installStreamQueue(f);f.context.saveSettings=()=>{throw Error('synthetic settings failure');};
  assert.equal((await trackedPass(f)).status,'failed');assert.equal(f.counts.requests,0);assert.equal(q.queue.length,0);
  assert.equal(f.state.shotPlans[0].streamAttempt.status,'failed');f.assertReleased();
});

test('actual queued pictures survive a later failed partial request and are not regenerated at final capture',async()=>{
  const f=await fixture(),q=installStreamQueue(f);assert.equal((await trackedPass(f)).status,'advanced');const old=copy(q.queue[0]),plan=f.state.shotPlans[0];
  f.host.chat[0].mes+=' for another letter.\n\n';f.modelHook=()=>{throw Error('synthetic later failure');};assert.equal((await trackedPass(f)).status,'failed');
  assert.equal(plan.streamAttempt.status,'failed');assert.equal(plan.shots[0].status,'queued');const calls=f.counts.requests;
  assert.equal(await installFinalNotifications(f).run(),false);assert.equal(f.counts.requests,calls);assert.deepEqual(copy(q.queue[0]),old);assert.equal(q.queue.length,1);f.assertReleased();
});

test('actual scheduler serializes growing prefixes and final capture through one original plan and paid-admission ledger',async()=>{
  const f=await fixture({text:threeParagraphs.split('\n\n')[0]+'\n\n'}),q=installStreamQueue(f),loop=installPassScheduler(f);useShotSet(f,[0]);
  for(let i=0;i<1000;i++)loop.scheduler.pulse('unused raw token');assert.equal(loop.timers.size,1);await loop.pass();assert.equal(q.queue.length,1);
  const original=copy(q.queue[0]);f.host.chat[0].mes=threeParagraphs;useShotSet(f,[0,1,2]);loop.scheduler.pulse();await loop.pass();assert.equal(q.queue.length,3);
  f.host.chat[0].mes=threeParagraphs.replace('\n\nUnfinished','');assert.equal(await loop.scheduler.finalize(),false,'the final pass has no remaining pictures to queue');
  assert.equal(await loop.scheduler.finalize(),false);assert.equal(loop.finishes,1);assert.equal(q.rows.size,1);assert.equal(f.state.shotPlans.length,1);assert.equal(q.queue.length,3);
  assert.deepEqual(loop.outcomes.map(row=>row.status),['advanced','advanced']);assert.equal(loop.scheduler.status.queued,3);assert.deepEqual(copy(q.queue[0]),original);
  assert.equal(f.state.shotPlans[0].streamFinalCapture.status,'complete');loop.scheduler.close();f.assertReleased();
});

test('actual failed incremental extraction cannot launch a fresh final LLM pass or mutate the workbench',async()=>{
  const f=await fixture(),q=installStreamQueue(f),loop=installPassScheduler(f),before=editable(f.state);let attempts=0;
  f.context.storyboardCallCompiler=async()=>{attempts++;throw Error('simulated offline');};loop.scheduler.pulse();await loop.pass();
  assert.equal(loop.outcomes[0].status,'failed');f.host.chat[0].mes+='\n\nAnother paragraph.';loop.scheduler.pulse();assert.equal(loop.timers.size,0);
  assert.equal(await loop.scheduler.finalize(),false);assert.equal(loop.finishes,0);assert.equal(attempts,1);assert.equal(q.queue.length,0);
  const after=editable(f.state);delete before.shotPlans;delete after.shotPlans;assert.deepEqual(after,before);
  assert.equal(f.state.shotPlans.length,1);assert.equal(f.state.shotPlans[0].streamAttempt.status,'failed');assert.equal(f.state.shotPlans[0].shots.length,0);
  loop.scheduler.close();f.assertReleased();
});

async function ordinaryPlanFixture({indexes=[0],text=threeParagraphs.split('\n\n').slice(0,2).join('\n\n')}={}){
  const f=await fixture({text}),q=installStreamQueue(f);useShotSet(f,indexes);
  Object.assign(f.state,{target:'floor',floor:'0'});
  const ref=createStoryboardMessageReference({message:f.host.chat[0],chatKey:'chat-a',floor:0});
  const plan=f.context.createStoryboardWorkflowTicket({id:'ordinary-original',chatKey:'chat-a',floor:0,messageRef:ref,origin:'automatic',autoGenerate:true});
  f.state.shotPlans=[plan];
  assert.equal(await f.run({stream:null,onPrepared:null,plan,automatic:true}),true,JSON.stringify(f.errors));
  assert.equal(await f.context.storyboardGenerate(null,{plan,automatic:true}),true,JSON.stringify(f.notices));
  assert.equal(q.queue.length,indexes.length);assert.equal(q.queue[0].messageRef.stream,undefined);
  return {f,q,plan};
}

for(const mode of ['saved','failed save','hot reload'])test(`actual host ${mode} hands off to ordinary continuation only after its original source is saved`,async()=>{
  const {f,q,plan}=await ordinaryPlanFixture(),old=copy(q.queue[0]);installFinalNotifications(f);
  Object.assign(f.context,{storyboardAutomaticPending:new Map(),storyboardAutomaticCurrent:null});
  const runtime=createStoryboardContinuationHost({getContext:()=>f.host,epoch:()=>f.context.storyboardAutomaticEpoch,enabled:()=>f.state.enabled,
    createReference:createStoryboardMessageReference,resolveNamespace:async()=>'st-user:route-test',notify:message=>f.notices.push(message)});
  f.context.storyboardContinuationRuntime=runtime;vm.runInContext(section('storyboardHandleAutomaticCapture'),f.context);
  const gate=deferred(),started=deferred();let writes=0;f.host.saveMetadata=async()=>{writes++;started.resolve();await gate.promise;if(mode==='failed save')throw Error('simulated save failure');};
  try{
    if(mode!=='hot reload')f.events.emit('generation_after_commands','continue',{},false);
    const message=f.host.chat[0];message.mes+='\n\nA broken cup rests on the table.';message.gen_started+='-continue';message.send_date+='-continue';
    message.swipe_info=[{send_date:message.send_date,gen_started:message.gen_started,extra:{}}];useShotSet(f,[0,1,2]);
    f.events.emit('message_received',0,'continue');const pending=f.context.storyboardHandleAutomaticCapture(0,'continue');
    if(mode!=='hot reload')await started.promise;
    assert.equal(f.context.storyboardAutomaticPending.size,0);assert.equal(q.queue.length,1);assert.equal(f.counts.requests,2);
    gate.resolve();assert.equal(await pending,mode==='saved',JSON.stringify(f.notices));
    if(mode==='saved'){
      assert.equal(writes,1,'one continuation metadata save before automatic extraction is allowed');
      const ticket=[...f.context.storyboardAutomaticPending.values()][0];assert.ok(ticket);assert.equal(await f.context.storyboardPerformAutomaticCapture(ticket),true,JSON.stringify(f.errors));
      assert.equal(q.queue.length,3);assert.equal(q.rows.size,1);assert.equal(f.state.shotPlans[0],plan);assert.equal(f.state.shotPlans.length,1);
      assert.equal(q.queue[2].imageAdmission.revisionId,old.imageAdmission.revisionId);assert.equal(writes,2,'the later final extraction also saves its continuity-state result');
    }else{assert.equal(f.state.shotPlans.length,1);assert.equal(plan.shots.length,1);assert.equal(f.counts.requests,2);assert.equal(writes,mode==='failed save'?1:0);}
    assert.deepEqual(copy(q.queue[0]),old);
  }finally{runtime.close();f.assertReleased();}
});

test('a later valid continuation cannot hide a lost earlier link and mint an ordinary fresh allowance',async()=>{
  const {f,q,plan}=await ordinaryPlanFixture();
  // The previous continue was never observed/saved (for example after reload).
  const message=f.host.chat[0];message.mes+='\n\nA broken cup rests on the table.';message.gen_started+='-lost';message.send_date+='-lost';
  message.swipe_info=[{send_date:message.send_date,gen_started:message.gen_started,extra:{}}];
  await continueHost(f,message.mes+'\n\nLater light fills the kitchen.');useShotSet(f,[0,1,2]);
  assert.equal(await installFinalNotifications(f).run(),false);assert.equal(q.queue.length,1);assert.equal(q.rows.size,1);assert.equal(plan.shots.length,1);assert.equal(f.counts.requests,2);
  assert.match(f.notices.at(-1),/未找到可核对的原自动计划/);f.assertReleased();
});

test('a saved continue without any prior automatic plan requires explicit extraction rather than a new automatic allowance',async()=>{
  const f=await fixture({text:threeParagraphs.split('\n\n')[0]}),q=installStreamQueue(f);
  await continueHost(f,f.host.chat[0].mes+'\n\nA broken cup rests on the table.');
  assert.equal(await installFinalNotifications(f).run(),false);assert.equal(f.counts.requests,0);assert.equal(q.queue.length,0);assert.equal(f.state.shotPlans.length,0);f.assertReleased();
});

test('actual ordinary plan continues into fresh v3 jobs under the same original plan and automatic budget',async()=>{
  const {f,q,plan}=await ordinaryPlanFixture(),old=copy(q.queue[0]),id=plan.id;
  await continueHost(f,f.host.chat[0].mes+'\n\nA broken cup rests on the table.');useShotSet(f,[0,1,2]);
  const final=installFinalNotifications(f);assert.equal(await final.run(),true,JSON.stringify({errors:f.errors,notices:f.notices}));
  assert.equal(f.state.shotPlans.length,1);assert.equal(plan.id,id);assert.equal(q.queue.length,3);assert.equal(q.rows.size,1);
  assert.deepEqual(copy(q.queue[0]),old);assert.equal(plan.messageRef.stream,undefined);
  for(const job of q.queue.slice(1)){assert.equal(job.messageRef.stream.version,3);assert.equal(job.imageAdmission.revisionId,old.imageAdmission.revisionId);await q.admission.beforeSubmit(job);}
  assert.equal(f.calls[2].payload.constraints.committed_images.occupied,1);assert.equal(plan.streamFinalCapture.status,'complete');
  const requests=f.counts.requests;assert.equal(await final.run(),false);assert.equal(f.counts.requests,requests);f.assertReleased();
});

test('ordinary plan continuation with a full original quota records the final state without another expression or image task',async()=>{
  const {f,q,plan}=await ordinaryPlanFixture();f.state.generationPolicy.maxImages=1;
  await continueHost(f,f.host.chat[0].mes+'\n\nA broken cup rests on the table.');useShotSet(f,[0]);
  const final=installFinalNotifications(f);assert.equal(await final.run(),false,JSON.stringify(f.errors));
  assert.equal(q.queue.length,1);assert.equal(q.rows.size,1);assert.equal(f.counts.requests,3);assert.equal(plan.streamFinalCapture.status,'complete');
  assert.equal(f.calls[2].payload.constraints.max_shots,0);f.assertReleased();
});

test('ordinary continuation keeps the workbench untouched and refuses cancelled, locked or manually reviewed original plans',async()=>{
  for(const property of ['status','promptLocked','manualReviewRequired']){
    const {f,q,plan}=await ordinaryPlanFixture();await continueHost(f,f.host.chat[0].mes+'\n\nNew ending.');
    plan[property]=property==='status'?'cancelled':true;const before=editable(f.state),final=installFinalNotifications(f);
    assert.equal(await final.run(),false);assert.equal(q.queue.length,1);assert.equal(f.counts.requests,2);assert.deepEqual(editable(f.state),before);f.assertReleased();
  }
});

test('continued ordinary jobs and old waiting markers sort by prose using compact positions through normalization and archive summaries',async()=>{
  const {f,q,plan}=await ordinaryPlanFixture({indexes:[1]});const original=copy(q.queue[0]);
  await continueHost(f,f.host.chat[0].mes+'\n\nA broken cup rests on the table.');useShotSet(f,[0,1,2]);
  const final=installFinalNotifications(f);assert.equal(await final.run(),true,JSON.stringify(f.errors));
  const state=normalizeStoryboardState(copy(f.state)),entries=buildStoryboardInlineTasks(state.taskStates,{chatKey:'chat-a',chat:f.host.chat,metadata:f.host.chatMetadata,
    logs:state.logs,waitingIds:new Set(q.queue.map(job=>job.id))});
  const sorted=sortStoryboardInlineRecords(entries,{plans:state.shotPlans});
  assert.deepEqual(sorted.map(row=>row.inlineOrder.shotIndex),[1,0,2]);
  const numbers=storyboardInlineDisplayIndexes(entries,{plans:state.shotPlans});assert.deepEqual(sorted.map(row=>numbers.get(row)),[0,1,2]);
  const summary=f.context.storyboardPlanLightweightSummary(plan,'archive');
  assert.equal(summary.shots[0].narrativeMoment.paragraphId,'P2');assert.deepEqual(copy(q.queue[0]),original);
  delete entries.find(row=>row.inlineOrder.shotIndex===0).narrativeMoment; // Pre-field task marker: use verified plan metadata.
  assert.deepEqual(sortStoryboardInlineRecords(entries,{plans:[summary]}).map(row=>row.inlineOrder.shotIndex),[1,0,2]);f.assertReleased();
});

test('legacy ordinary pipeline evidence survives real log normalization and is retained as plan presentation metadata without changing old requests',async()=>{
  const {f,q,plan}=await ordinaryPlanFixture({indexes:[1]});
  delete q.queue[0].shotSpec.narrativeMoment;delete f.state.logs[0].snapshot.shotSpec.narrativeMoment;delete plan.shots[0].shotSpec.narrativeMoment;
  for(const task of f.state.taskStates)delete task.narrativeMoment;
  const old=copy(q.queue[0]);Object.assign(f.state,normalizeStoryboardState(copy(f.state)));const current=f.state.shotPlans[0];
  await continueHost(f,f.host.chat[0].mes+'\n\nA broken cup rests on the table.');useShotSet(f,[0,1,2]);
  const final=installFinalNotifications(f);assert.equal(await final.run(),true,JSON.stringify({errors:f.errors,notices:f.notices}));
  assert.equal(q.queue.length,3);assert.equal(current.shots[0].narrativeMoment.paragraphId,'P2');assert.deepEqual(copy(q.queue[0]),old);
  assert.equal(f.state.logs.find(log=>log.snapshot?.planShotId===old.planShotId).snapshot.shotSpec.narrativeMoment,undefined);
  const entries=buildStoryboardInlineTasks(f.state.taskStates,{chatKey:'chat-a',chat:f.host.chat,metadata:f.host.chatMetadata,logs:f.state.logs,waitingIds:new Set(q.queue.map(job=>job.id))});
  assert.deepEqual(sortStoryboardInlineRecords(entries,{plans:f.state.shotPlans}).map(row=>row.inlineOrder.shotIndex),[1,0,2]);f.assertReleased();
});

test('a continued ordinary archive is restored before adding new shots and keeps its original recovery copy',async()=>{
  const {f,q,plan}=await ordinaryPlanFixture(),final=installFinalNotifications(f);plan.archiveRef='ordinary-archive';plan.status='completed';
  const archive=copy(plan),summary=f.context.storyboardPlanLightweightSummary(plan,plan.archiveRef);f.state.shotPlans=[summary];let restored=0;
  f.context.storyboardPlansForPortableExport=async()=>{restored++;return [copy(archive)];};
  await continueHost(f,f.host.chat[0].mes+'\n\nA broken cup rests on the table.');useShotSet(f,[0,1,2]);
  assert.equal(await final.run(),true,JSON.stringify(f.errors));assert.equal(restored,1);assert.equal(summary.shots.length,3);assert.equal(summary.archiveRef,undefined);
  assert.equal(archive.archiveRef,'ordinary-archive');assert.equal(summary.shots[0].prompt,archive.shots[0].prompt);assert.equal(q.rows.size,1);f.assertReleased();
});

test('ordinary continuation with missing occupied evidence stops before another model call or automatic reservation',async()=>{
  const {f,q,plan}=await ordinaryPlanFixture();f.state.logs=[];f.state.pipelineLogs=[];
  await continueHost(f,f.host.chat[0].mes+'\n\nA broken cup rests on the table.');useShotSet(f,[0,1,2]);
  assert.equal(await installFinalNotifications(f).run(),false);assert.equal(f.counts.requests,2);assert.equal(q.queue.length,1);assert.equal(q.rows.size,1);
  assert.equal(plan.shots.length,1);assert.equal(plan.streamFinalCapture.status,'failed');f.assertReleased();
});

test('ordinary continued planning cannot overwrite a user edit arriving before queue handoff',async()=>{
  const {f,q,plan}=await ordinaryPlanFixture();await continueHost(f,f.host.chat[0].mes+'\n\nA broken cup rests on the table.');useShotSet(f,[0,1,2]);
  let edited=false;f.preparedHook=async value=>{f.state.prompt='USER EDIT';edited=true;await f.context.storyboardSubmitStreamPrepared(value);};
  // Direct scoped handoff exercises the same source/workbench guard before queue publication.
  assert.equal(await f.run({stream:{floor:0,complete:true}}),false);assert.equal(edited,true);assert.equal(f.state.prompt,'USER EDIT');assert.equal(q.queue.length,1);
  assert.equal(plan.shots.length,1);f.assertReleased();
});

test('multiple ordinary continuations retain one plan and quota after final markers and source keys change again',async()=>{
  const {f,q,plan}=await ordinaryPlanFixture({text:threeParagraphs.split('\n\n')[0]}),final=installFinalNotifications(f);
  await continueHost(f,f.host.chat[0].mes+'\n\nA mountain valley stretches into the sunlight.');useShotSet(f,[0,1]);
  assert.equal(await final.run(),true,JSON.stringify(f.errors));const firstMarker=copy(plan.streamFinalCapture),old=copy(q.queue[0]);
  await continueHost(f,f.host.chat[0].mes+'\n\nA broken cup rests on the table.');useShotSet(f,[0,1,2]);
  assert.equal(await final.run(),true,JSON.stringify(f.errors));assert.equal(plan.shots.length,3);assert.equal(q.rows.size,1);assert.equal(q.queue.length,3);
  assert.notEqual(plan.streamFinalCapture.sourceRevisionId,firstMarker.sourceRevisionId);assert.deepEqual(copy(q.queue[0]),old);
  assert.equal(q.queue[2].messageRef.stream.family.reference.stream,undefined);assert.equal(q.queue[2].imageAdmission.revisionId,old.imageAdmission.revisionId);f.assertReleased();
});

test('removing an ordinary continuation proof during expression leaves the original plan and requests intact',async()=>{
  const {f,q,plan}=await ordinaryPlanFixture(),before=copy(plan.shots),old=copy(q.queue[0]);
  await continueHost(f,f.host.chat[0].mes+'\n\nA broken cup rests on the table.');
  useShotSet(f,[0,1,2],({options})=>{if(options.jsonSchemaName==='qianmu.storyboard.expression.v1')delete f.host.chatMetadata.story_director_liminale.storyboardContinuations;});
  assert.equal(await installFinalNotifications(f).run(),false);assert.equal(q.queue.length,1);assert.deepEqual(copy(plan.shots),before);assert.deepEqual(copy(q.queue[0]),old);f.assertReleased();
});

test('actual finished-floor automatic entry supplements a stream plan once without creating an ordinary second budget or replacing the workbench',async()=>{
  const f=await fixture(),q=installStreamQueue(f);useShotSet(f,[0]);assert.equal(await f.run(),true);const final=installFinalNotifications(f);
  f.host.chat[0].mes=threeParagraphs.replace('\n\nUnfinished','');useShotSet(f,[0,1,2]);const initial=editable(f.state);delete initial.shotPlans;
  assert.equal(await final.run(),true,JSON.stringify(f.errors));assert.equal(q.queue.length,3);assert.equal(q.rows.size,1);assert.equal(f.state.shotPlans.length,1);
  const plan=f.state.shotPlans[0];assert.equal(plan.streamFinalCapture.status,'complete');assert.equal(plan.streamFinalCapture.sourceRevisionId,final.ticket().messageRef.revisionId);
  assert.equal(await final.run(),false);assert.equal(f.counts.requests,4);assert.equal(q.queue.length,3);
  const after=editable(f.state);delete after.shotPlans;assert.deepEqual(after,initial);assert.equal(f.counts.renders,0);f.assertReleased();
});

test('host terminal whitespace cleanup preserves the actual admitted picture and finishes coverage without duplicate expression or a second budget',async()=>{
  const raw='Alice reads a letter in the kitchen.\n\n',f=await fixture({text:raw}),q=installStreamQueue(f);
  assert.equal(await f.run(),true,JSON.stringify(f.errors));assert.equal(q.queue[0].messageRef.stream.closedParagraph,true);
  const sent=f.calls[0].payload.source_catalogue.find(row=>row.floor===0);assert.match(JSON.stringify(sent),/Alice reads a letter/);
  f.host.chat[0].mes=raw.trimEnd();await q.admission.beforeSubmit(q.queue[0]);
  const final=installFinalNotifications(f);assert.equal(await final.run(),false,JSON.stringify(f.errors));
  assert.equal(f.state.shotPlans[0].streamFinalCapture.status,'complete');assert.equal(f.counts.requests,3);assert.equal(f.counts.hostSaves,1);
  assert.equal(q.queue.length,1);assert.equal(q.rows.size,1);assert.equal(await final.run(),false);assert.equal(f.counts.requests,3);f.assertReleased();
});

test('a joined continuation after actual stream queue admission cannot be dispatched as the old completed paragraph',async()=>{
  const f=await fixture(),q=installStreamQueue(f);assert.equal(await f.run(),true);
  f.host.chat[0].mes='Alice reads a letter in the kitchen. She only imagined it.';
  await assert.rejects(q.admission.beforeSubmit(q.queue[0]),{code:'storyboard_stream_source'});assert.equal(q.queue.length,1);f.assertReleased();
});

test('normalization and lightweight plan archives preserve terminal-pass idempotency after restart',async()=>{
  const f=await fixture(),q=installStreamQueue(f);assert.equal(await f.run(),true);const final=installFinalNotifications(f);
  assert.equal(await final.run(),false);assert.equal(f.counts.requests,3);const marker=copy(f.state.shotPlans[0].streamFinalCapture);
  assert.equal(marker.status,'complete');
  f.state.shotPlans=normalizeStoryboardState(f.state).shotPlans;assert.deepEqual(f.state.shotPlans[0].streamFinalCapture,marker);
  f.state.shotPlans[0]=f.context.storyboardPlanLightweightSummary(f.state.shotPlans[0],'archive-only-test');
  assert.deepEqual(copy(f.state.shotPlans[0].streamFinalCapture),marker);assert.equal(await final.run(),false);
  assert.equal(f.counts.requests,3);assert.equal(q.queue.length,1);f.assertReleased();
});

test('a failed final LLM call does not replay on another host notification or erase already submitted stream jobs',async()=>{
  const f=await fixture(),q=installStreamQueue(f);assert.equal(await f.run(),true);const final=installFinalNotifications(f);
  f.modelHook=()=>{throw Error('synthetic model failure');};assert.equal(await final.run(),false);
  assert.equal(f.state.shotPlans[0].streamFinalCapture.status,'failed');const count=f.counts.requests;
  assert.equal(await final.run(),false);assert.equal(f.counts.requests,count);assert.equal(q.queue.length,1);assert.equal(f.state.shotPlans[0].shots[0].status,'queued');f.assertReleased();
});

test('terminal continuation with lost, duplicated or malformed plan provenance stops instead of minting an ordinary free budget',async()=>{
  for(const mode of ['missing','duplicate','invalid-marker']){
    const f=await fixture(),q=installStreamQueue(f);assert.equal(await f.run(),true);const final=installFinalNotifications(f);
    if(mode==='missing')f.state.shotPlans=[];
    if(mode==='duplicate')f.state.shotPlans.push({...copy(f.state.shotPlans[0]),id:'duplicate'});
    if(mode==='invalid-marker')f.state.shotPlans[0].streamFinalCapture={version:1,invalid:true};
    assert.equal(await final.run(),false);assert.equal(f.counts.requests,2);assert.equal(q.queue.length,1);assert.equal(q.rows.size,1);
    assert.ok(f.notices.some(text=>/未重复提交|未重新自动生成/.test(text)));f.assertReleased();
  }
});

test('turning off automatic generation prevents a final continuation and ordinary generations keep the legacy path',async()=>{
  const f=await fixture(),q=installStreamQueue(f);assert.equal(await f.run(),true);const final=installFinalNotifications(f);
  f.state.automation.autoGenerate=false;assert.equal(await final.run(),false);assert.equal(f.counts.requests,2);assert.equal(q.queue.length,1);
  f.state.automation.autoGenerate=true;f.host.chat[0].gen_started='different-generation';
  assert.equal(await final.finish(),null);assert.equal(f.counts.requests,2);f.assertReleased();
});

test('a generation or account switch during terminal preparation cannot finalize the old pass in a new context',async()=>{
  for(const change of [f=>{f.host.chat[0].gen_started='new-generation';},f=>f.setAccount('st-user:other')]){
    const f=await fixture(),q=installStreamQueue(f);assert.equal(await f.run(),true);const final=installFinalNotifications(f);
    f.modelHook=()=>change(f);assert.equal(await final.run(),false);
    assert.equal(q.queue.length,1);assert.equal(f.state.shotPlans[0].streamFinalCapture.status,'preparing');f.assertReleased();
  }
});

test('a changed namespace between final-pass reservation and compiler source capture stops before the first model call',async()=>{
  const f=await fixture(),q=installStreamQueue(f);assert.equal(await f.run(),true);const final=installFinalNotifications(f);
  const load=f.context.featureRuntime.load;let reads=0;
  f.context.featureRuntime.load=async key=>{
    const runtime=await load(key);return key==='imageAdmission'?{...runtime,resolveImageAccountNamespace:async()=>++reads===1?'st-user:route-test':'st-user:other'}:runtime;
  };
  assert.equal(await final.run(),false);assert.equal(f.counts.requests,2);assert.equal(q.queue.length,1);
  assert.equal(f.state.shotPlans[0].streamFinalCapture.status,'preparing');f.assertReleased();
});

test('a deferred Comfy stream mirror records its own frozen proof and global slot while eligible neighbors continue',async()=>{
  const f=await fixture({text:threeParagraphs}),q=installStreamQueue(f);useShotSet(f,[0]);assert.equal(await f.run(),true);
  const recorded=[];f.context.storyboardRecordComfyPreparationFailure=(preparation,message)=>recorded.push({preparation,message});
  f.context.storyboardChooseComfyGenerationRoutes=async(_state,_guard,planned,routes,_coverage,plan)=>({routes,choices:new Map(),
    failures:new Map([[0,{preparation:{planId:plan.id,planShotId:plan.shots[0].id,messageRef:{invalid:true}},message:'no eligible workflow',diagnostics:[]}]]),batch:{}});
  f.preparedHook=async value=>{value.inputGuard.comfyAuto={close(){}};q.outcomes.push(await f.context.storyboardSubmitStreamPrepared(value));};
  useShotSet(f,[1,2]);assert.equal(await f.run(),true,JSON.stringify(f.errors));assert.equal(q.queue.length,2);assert.equal(recorded.length,1);
  assert.equal(recorded[0].preparation.messageRef.stream.moment.paragraphId,'P2');assert.equal(recorded[0].preparation.inlineOrder.shotIndex,1);
  assert.equal(q.queue[1].inlineOrder.shotIndex,2);assert.equal(q.queue[1].messageRef.stream.moment.paragraphId,'P3');
  assert.deepEqual(q.outcomes.at(-1),{queued:1,failed:1,prepared:1});f.assertReleased();
});

const storedFinals=f=>[...f.storage.files.values()].map(text=>JSON.parse(text)).filter(row=>row.schema==='qianmu.st-account-document.v1')
  .map(row=>row.value).filter(value=>value?.schema==='qianmu.storyboard.stream-final.v1');

test('actual final model and return both wait for their ST prepare and settle readbacks',async()=>{
  const f=await fixture(),q=installStreamQueue(f);assert.equal(await f.run(),true);const final=installFinalNotifications(f);
  const entered=[deferred(),deferred()],held=[deferred(),deferred()];let posts=0,blocked=0,ended=false;
  f.storage.hook=async({path})=>{if(path==='/api/files/upload')posts++;
    else if(posts===2*(blocked+1)&&blocked<2){const n=blocked++;entered[n].resolve();await held[n].promise;}};
  const pending=final.run().then(value=>{ended=true;return value;});
  await entered[0].promise;assert.equal(f.counts.requests,2);assert.equal(ended,false);held[0].resolve();
  await entered[1].promise;assert.equal(f.counts.requests,3);assert.equal(ended,false);held[1].resolve();assert.equal(await pending,false);
  const records=storedFinals(f);assert.deepEqual(records.map(row=>row.record.status),['preparing','complete']);
  assert.deepEqual(copy(f.state.shotPlans[0].streamFinalCapture),records.at(-1).record);assert.equal(q.queue.length,1);f.assertReleased();
});

for(const phase of ['prepare','settle'])test(`actual lost final ${phase} acknowledgement retains accepted jobs and blocks replay even without the local marker`,async()=>{
  const f=await fixture({text:threeParagraphs}),q=installStreamQueue(f);useShotSet(f,[0]);assert.equal(await f.run(),true);
  useShotSet(f,[0,1,2]);f.host.chat[0].mes=threeParagraphs.replace('\n\nUnfinished','');const final=installFinalNotifications(f);let posts=0;
  f.storage.hook=({path,options,files})=>{
    if(path==='/api/files/upload'&&++posts===(phase==='prepare'?2:4)){
      const {name,data}=JSON.parse(options.body);files.set(name,Buffer.from(data,'base64').toString());throw Error('synthetic lost final acknowledgement');
    }
  };
  assert.equal(await final.run(),phase==='settle');assert.equal(f.counts.requests,phase==='prepare'?2:4);assert.equal(q.queue.length,phase==='prepare'?1:3);
  assert.equal(f.state.shotPlans[0].streamFinalCapture.status,'failed');const count=f.counts.requests,queued=copy(q.queue);
  f.storage.hook=null;delete f.state.shotPlans[0].streamFinalCapture;
  assert.equal(await final.run(),false);assert.equal(f.counts.requests,count);assert.deepEqual(copy(q.queue),queued);assert.match(f.notices.at(-1),/已有取景记录/);f.assertReleased();
});

test('actual final claim remains no-replay after settings save fails following confirmed ST completion',async()=>{
  const f=await fixture(),q=installStreamQueue(f);assert.equal(await f.run(),true);const final=installFinalNotifications(f);
  const save=f.context.saveSettings;f.context.saveSettings=()=>{if(f.state.shotPlans[0]?.streamFinalCapture?.status==='complete')throw Error('settings unavailable');return save();};
  assert.equal(await final.run(),false);assert.equal(storedFinals(f).at(-1).record.status,'complete');assert.equal(q.queue.length,1);
  const count=f.counts.requests;f.context.saveSettings=save;delete f.state.shotPlans[0].streamFinalCapture;
  assert.equal(await final.run(),false);assert.equal(f.counts.requests,count);f.assertReleased();
});

test('actual final capture verifies a tracked partial checkpoint against ST before opening a final claim',async()=>{
  for(const missing of [false,true]){
    const f=await fixture(),q=installStreamQueue(f);assert.equal((await trackedPass(f)).status,'advanced');const final=installFinalNotifications(f);
    if(missing)f.storage.files.clear();else f.state.shotPlans[0].streamAttempt.updatedAt++;
    const before=f.storage.calls.length;assert.equal(await final.run(),false);assert.equal(f.counts.requests,2);assert.equal(q.queue.length,1);
    assert.equal(storedFinals(f).length,0);assert.ok(f.storage.calls.slice(before).every(row=>row.options.method==='GET'));f.assertReleased();
  }
});

for(const change of ['source','account','plan-id','manual'])test(`actual ${change} change during final claim readback prevents the first model request`,async()=>{
  const f=await fixture(),q=installStreamQueue(f);assert.equal(await f.run(),true);const final=installFinalNotifications(f);let posts=0;
  f.storage.hook=({path})=>{if(path==='/api/files/upload'&&++posts===2){
    if(change==='source')f.host.chat[0].mes+='changed';if(change==='account'){f.setAccount('st-user:other');f.storage.namespace='st-user:other';}
    if(change==='plan-id')f.state.shotPlans[0].id='replaced';if(change==='manual')f.state.shotPlans[0].promptLocked=true;
  }};
  assert.equal(await final.run(),false);assert.equal(f.counts.requests,2);assert.equal(q.queue.length,1);assert.equal(posts,2);f.assertReleased();
});

test('ordinary new floors use two bounded recovery reads, no file writes or model requests before falling through',async()=>{
  const f=await fixture();installStreamQueue(f);const final=installFinalNotifications(f);assert.equal(await final.finish(),null);
  assert.equal(f.storage.calls.length,2);assert.ok(f.storage.calls.every(row=>row.options.method==='GET'));assert.equal(f.counts.requests,0);f.assertReleased();
});

test('actual partial checkpoint blocks ordinary fallback after all local plans and logs are lost',async()=>{
  const f=await fixture(),q=installStreamQueue(f);assert.equal((await trackedPass(f)).status,'advanced');
  const queued=copy(q.queue);f.state.shotPlans=[];f.state.logs=[];const final=installFinalNotifications(f),before=f.storage.calls.length;
  assert.equal(await final.run(),false);assert.equal(f.counts.requests,2);assert.deepEqual(copy(q.queue),queued);assert.equal(f.state.shotPlans.length,0);
  assert.match(f.notices.at(-1),/本地计划缺失/);assert.ok(f.storage.calls.slice(before).every(row=>row.options.method==='GET'));f.assertReleased();
});

test('actual final-only checkpoint blocks fallback after all local plans and logs are lost',async()=>{
  const f=await fixture(),q=installStreamQueue(f);assert.equal(await f.run(),true);const final=installFinalNotifications(f);assert.equal(await final.run(),false);
  const queued=copy(q.queue),count=f.counts.requests;f.state.shotPlans=[];f.state.logs=[];
  assert.equal(await final.run(),false);assert.equal(f.counts.requests,count);assert.equal(f.state.shotPlans.length,0);assert.deepEqual(copy(q.queue),queued);
  assert.match(f.notices.at(-1),/本地计划缺失/);f.assertReleased();
});

test('actual unknown recovery storage never falls through to an ordinary fresh plan or model call',async()=>{
  const f=await fixture();installStreamQueue(f);const final=installFinalNotifications(f);f.storage.hook=()=>{throw Error('synthetic unavailable ST read');};
  assert.equal(await final.run(),false);assert.equal(f.counts.requests,0);assert.equal(f.state.shotPlans.length,0);assert.ok(f.notices.length);f.assertReleased();
});

test('a stream plan arriving during recovery cannot become a second ordinary plan',async()=>{
  const f=await fixture(),q=installStreamQueue(f);assert.equal(await f.run(),true);const saved=f.state.shotPlans[0];f.state.shotPlans=[];f.state.logs=[];
  const final=installFinalNotifications(f);let restored=false;
  f.storage.hook=()=>{if(!restored){restored=true;f.state.shotPlans.push(saved);}};
  assert.equal(await final.run(),false);assert.equal(f.counts.requests,2);assert.equal(f.state.shotPlans.length,1);assert.equal(q.queue.length,1);f.assertReleased();
});

function installActualStreamHost(f){
  const timers=new Map(),outcomes=[];let sequence=0,completion=null;
  f.context.settings.enabled=true;f.state.automation.streamEnabled=true;f.state.promptCompiler.enabled=true;
  const compile=f.context.storyboardCompilePrompt;
  Object.assign(f.context,{createStoryboardStreamHost,storyboardAutomaticEpoch:0,storyboardAutomaticCurrent:null,
    setTimeout:fn=>{const id=++sequence;timers.set(id,fn);return id;},clearTimeout:id=>timers.delete(id),
    storyboardCompilePrompt:async(root,options)=>{try{return await compile(root,{...options,onStreamOutcome:value=>{outcomes.push(value);return options.onStreamOutcome?.(value);}});}finally{completion?.resolve();}}});
  vm.runInContext(section('storyboardCreateStreamHost'),f.context);
  const runtime=f.context.storyboardStreamRuntime=f.context.storyboardCreateStreamHost();
  const next=()=>{const [id,fn]=timers.entries().next().value||[];assert.ok(fn);timers.delete(id);fn();};
  f.events.emit('generation_after_commands',undefined,{},false);f.host.chat[0].gen_started='real-host-generation';
  f.host.streamingProcessor={type:undefined,messageId:0,abortController:new AbortController()};
  return {runtime,timers,outcomes,pulse:()=>f.events.emit('stream_token_received','raw ignored'),
    async bootstrap(){next();for(let n=0;n<20;n++)await Promise.resolve();},
    async pass(){completion=deferred();next();await completion.promise;for(let n=0;n<20;n++)await Promise.resolve();},
    gate:()=>runtime.beforeAutomatic(0,f.host.chat[0],undefined)};
}

test('actual ST token adapter prepares an early picture then releases one original-budget final capture',async()=>{
  const f=await fixture(),q=installStreamQueue(f);useShotSet(f,[0]);const host=installActualStreamHost(f);
  host.pulse();await host.bootstrap();await host.pass();assert.equal(host.outcomes[0].status,'ready');assert.equal(q.queue.length,1);
  f.host.chat[0].mes=threeParagraphs.replace('\n\nUnfinished','');useShotSet(f,[0,1,2]);f.events.emit('message_received',0,undefined);
  assert.equal(await host.gate(),true);assert.equal(await installFinalNotifications(f).run(),true,JSON.stringify(f.notices));
  assert.equal(q.queue.length,3);assert.equal(q.rows.size,1);assert.equal(f.state.shotPlans.length,1);assert.equal(f.state.shotPlans[0].streamFinalCapture.status,'complete');
  host.runtime.close();assert.equal(host.timers.size,0);f.assertReleased();
});

test('actual stopped host cancels its in-flight compiler and never releases final automatic capture',async()=>{
  const f=await fixture(),q=installStreamQueue(f),held=deferred(),entered=deferred();const host=installActualStreamHost(f);
  f.modelHook=async()=>{entered.resolve();await held.promise;};host.pulse();await host.bootstrap();const pending=host.pass();await entered.promise;
  f.events.emit('generation_stopped');assert.equal(host.gate(),false);held.resolve();await pending;
  assert.equal(q.queue.length,0);assert.equal(f.counts.requests,1);assert.equal(host.outcomes[0].status,'cancelled');host.runtime.close();f.assertReleased();
});

test('actual manual edit between token batches preserves admitted pictures and blocks further compilation',async()=>{
  const f=await fixture(),q=installStreamQueue(f);const host=installActualStreamHost(f);host.pulse();await host.bootstrap();await host.pass();
  for(const fn of f.domEvents.get('input')||[])fn({target:{type:'text',className:'sd-storyboard-prompt',closest:()=>({}),matches:()=>true}});
  f.state.prompt='USER WORKBENCH EDIT';f.host.chat[0].mes=threeParagraphs;host.pulse();assert.equal(host.timers.size,0);assert.equal(host.gate(),false);
  assert.equal(q.queue.length,1);assert.equal(f.counts.requests,2);assert.equal(f.state.prompt,'USER WORKBENCH EDIT');host.runtime.close();f.assertReleased();
});
