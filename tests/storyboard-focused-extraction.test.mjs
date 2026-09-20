import test from 'node:test';
import assert from 'node:assert/strict';
import * as contract from '../qianmu-storyboard-contract.js';
import {normalizeStoryboardShotSpec} from '../qianmu-storyboard.js';
import {storyboardFocusedCatalogue,storyboardFocusedRepairContext} from '../qianmu-storyboard-focused-input.js';
import {STORYBOARD_NARRATIVE_SCHEMA as NARRATIVE,STORYBOARD_EXPRESSION_SCHEMA as EXPRESSION} from '../qianmu-storyboard-focused-extraction.js';
import {response as basePlan,compilerEnvironment} from './helpers/comfy-compiler-fixture.mjs';

const roster=()=>({branches:[{id:'now',layer:'present'}],subjectIds:['A']});
const event=(overrides={})=>({id:'coat',branchId:'now',paragraphId:'P1',subjectId:'A',category:'outfit',key:'coat',value:'removed',persistence:'persistent',evidence:'A removes the coat.',...overrides});
const record=(floor,events=[])=>({floor,roster:roster(),events});
const link=(from,to,facts=[{source_floor:from,event_id:'coat',subject_id:'A'}])=>({from_floor:from,from_branch:'now',to_floor:to,to_branch:'now',evidence:{paragraph_id:'P1',quote:'A continues chatting.'},facts});
const plain=value=>JSON.parse(JSON.stringify(value));

async function fixture({texts=['A removes the coat.\n\nA continues chatting.'],providerId='novel',promptFormats,maxShots=3,metadata,stream=false}={}){
  let active=true,saves=0,account='st-user:synthetic',saveHook=null;
  const host={chatId:'synthetic',characterId:0,characters:[{avatar:'A.png',chat:'synthetic'}],chatMetadata:metadata||{story_director_liminale:{}},
    chat:texts.map((mes,index)=>({mes,name:'A',is_user:index%2===1,send_date:String(index)})),async saveMetadata(){saves++;if(saveHook)await saveHook();}};
  const floor=texts.length-1;
  const sourceOptions={floor,referenceFloors:floor,getContext:()=>host,epoch:()=>0,
    isCurrent:()=>active,resolveNamespace:async()=>account,readText:message=>message.mes,
    readParagraphs:message=>message.mes.split('\n\n').filter(text=>text.trim()).map((text,index)=>({id:`P${index+1}`,text}))};
  const streamFrame=stream?await contract.captureStoryboardStreamFrame(sourceOptions):null;
  const window=await contract.captureStoryboardCompilerSources({...sourceOptions,streamFrame});
  const store=contract.openStoryboardCompilerContinuity(window);
  const context={floor,messages:window.messages,paragraphs:window.paragraphs,currentCharacter:'Alice stable appearance',persona:'user description',world:'selected world',
    compilerSources:window,continuity:await store.read()};
  const config={focused:true,providerId,promptFormats,maxShots,minShots:1,allowedRatioIds:['3:2'],groupLabel:'obsolete three beats',groupInstruction:'MUST split the scene into three narrative acts'};
  let request;
  try{request=contract.buildStoryboardPlanContractRequest(context,config);}catch(error){store.close();window.close();throw error;}
  const first=basePlan().shots[0];delete first.prompt_atoms;delete first.prompt_renderings;
  first.state_point={branchId:'now',paragraphId:'P1',evidence:window.paragraphs[0]};
  const narrative={schema:NARRATIVE,should_generate:true,skip_reason:'',shots:[first],source_states:texts.map((_,index)=>record(index)),continuity_links:[],decisions:[]};
  const expression=()=>({schema:EXPRESSION,shots:narrative.shots.map((shot,index)=>({shot_id:`S${index+1}`,prompt_atoms:{global:['kitchen','warm light'],character_ids:shot.characters.map(c=>c.character_id),scene_negative:['extra people']},
    ...(request.promptFormats.length?{prompt_renderings:Object.fromEntries(request.promptFormats.map(format=>[format,{global:format==='tags'?'kitchen, warm light':'A warmly lit kitchen.',
      characters:shot.characters.map(c=>({character_id:c.character_id,positive:format==='tags'?'silver hair, no coat':'Alice has silver hair and is not wearing a coat.'})),negative:'extra people'}]))}:{})}))});
  const calls=[];
  const options={context,request,guard:window.guard,publish:records=>store.publish(records),call:async(messages,definition)=>{calls.push({messages:plain(messages),definition:plain(definition)});return JSON.stringify(expression());}};
  return {host,window,store,context,config,request,narrative,expression,calls,options,get saves(){return saves;},set active(value){active=value;},set account(value){account=value;},set saveHook(value){saveHook=value;},
    run:overrides=>contract.completeStoryboardFocusedExtraction({...options,raw:JSON.stringify(narrative),...overrides}),close(){store.close();window.close();}};
}

test('actual two steps retain full selected input once, lock all shot facts and use a small expression handoff',async()=>{
  const f=await fixture({texts:['A removes the coat.','A continues chatting.']});
  f.narrative.source_states[0].events=[event()];f.narrative.continuity_links=[link(0,1)];
  const before=plain(f.narrative),result=await f.run(),payload=JSON.parse(f.calls[0].messages[1].content),firstInput=JSON.parse(f.request.messages[1].content);
  assert.equal(result.meta.mode,'focused_two_stage');assert.equal(result.meta.repairCalls,0);assert.equal(f.calls.length,1);assert.equal(f.saves,1);
  assert.equal(result.meta.persistence.status,'host_returned');assert.deepEqual(result.trace.narrative,before);
  assert.equal(payload.shots[0].active_state[0].value,'removed');assert.equal(payload.shots[0].active_state[0].subject_id,'A');
  assert.doesNotMatch(JSON.stringify(payload),/selected world|user description|stable appearance|st-user:|paragraphDigest/);
  assert.match(f.request.messages[1].content,/A removes the coat\./);assert.match(f.request.messages[1].content,/A continues chatting\./);
  assert.equal(firstInput.constraints.shot_group,undefined);assert.equal(firstInput.constraints.shot_group_rule,undefined);
  assert.equal(f.request.schema.properties.shots.maxItems,3);assert.ok(Object.isFrozen(result.trace.narrative));
  const final=JSON.parse(result.raw);assert.equal(final.schema,contract.STORYBOARD_PLAN_RESPONSE_SCHEMA_ID);
  assert.deepEqual(final.shots[0].composition,before.shots[0].composition);assert.deepEqual(final.shots[0].characters,before.shots[0].characters);f.close();
});

const streamAnchor=(floor,quote,paragraph_id='P1',branch_id='now')=>({floor,branch_id,paragraph_id,quote});
function streamSupport(f,{scene,content,presence}={}){
  const quote=f.window.paragraphs[0],anchor=streamAnchor(f.context.floor,quote);
  f.narrative.shots[0].stream_support={scene:scene||anchor,content:content||anchor,presence:presence||[{character_id:'A',source:anchor}]};
}

test('streaming director keeps the complete input but only releases closed grounded moments to expression',async()=>{
  const f=await fixture({stream:true,texts:['A removes the coat in the kitchen.\n\nA reaches toward']});streamSupport(f);
  const payload=JSON.parse(f.request.messages[1].content);
  assert.match(f.request.messages[1].content,/A reaches toward/);assert.deepEqual(payload.constraints.streaming.closed_target_paragraph_ids,['P1']);
  assert.equal(payload.constraints.min_shots_target,0);assert.equal(payload.constraints.max_shots,3);
  assert.ok(f.request.schema.properties.shots.items.required.includes('stream_support'));
  f.host.chat[0].mes+=' the cup.';
  const result=await f.run();assert.equal(f.calls.length,1);assert.equal(f.saves,0);assert.equal(result.meta.persistence.status,'deferred');
  assert.equal(result.trace.narrative.shots[0].stream_support.content.quote,'A removes the coat in the kitchen.');
  assert.equal(JSON.parse(result.raw).shots[0].stream_support,undefined);assert.equal(JSON.parse(f.calls[0].messages[1].content).shots[0].plan.stream_support,undefined);
  assert.doesNotMatch(f.calls[0].messages[1].content,/A reaches toward/);f.close();
});

test('uncertain streaming scenes can wait with zero shots, no expression request, no repair and no provisional ST write',async()=>{
  const f=await fixture({stream:true,texts:['Someone pauses.\n\nThey might be']});
  Object.assign(f.narrative,{should_generate:false,skip_reason:'人物在场尚不明确，等待后续正文',shots:[]});
  const result=await f.run();assert.equal(result.meta.repairCalls,0);assert.equal(f.calls.length,0);assert.equal(f.saves,0);
  assert.equal(JSON.parse(result.raw).should_generate,false);assert.equal(result.meta.persistence.status,'deferred');f.close();
});

test('streaming still life is independent of a cast roster but still requires current content and scene evidence',async()=>{
  const f=await fixture({stream:true,texts:['A broken cup rests on the kitchen table.\n\nSomeone enters']});
  f.narrative.shots[0].characters=[];streamSupport(f,{presence:[]});
  const result=await f.run();assert.equal(JSON.parse(result.raw).shots[0].characters.length,0);assert.equal(f.calls.length,1);f.close();
});

for(const [name,change] of [
  ['unfinished source',f=>{f.narrative.shots[0].source_paragraph_ids.push('P2');}],
  ['unfinished insertion',f=>{f.narrative.shots[0].insert_after='P2';f.narrative.shots[0].source_paragraph_ids.push('P2');}],
  ['tail presence',f=>{f.narrative.shots[0].stream_support.presence[0].source=streamAnchor(0,'A reaches','P2');}],
  ['tail scene',f=>{f.narrative.shots[0].stream_support.scene=streamAnchor(0,'A reaches','P2');}],
  ['fabricated content',f=>{f.narrative.shots[0].stream_support.content.quote='not in captured source';}],
  ['missing person',f=>{f.narrative.shots[0].stream_support.presence=[];}],
  ['extra person',f=>{f.narrative.shots[0].stream_support.presence.push({character_id:'B',source:streamAnchor(0,'A cooks.')});}],
  ['foreign person',f=>{f.narrative.shots[0].stream_support.presence[0].character_id='B';}],
  ['foreign branch',f=>{f.narrative.shots[0].stream_support.scene.branch_id='past';}],
  ['foreign floor',f=>{f.narrative.shots[0].stream_support.content.floor=999;}],
  ['later in same paragraph',f=>{f.narrative.shots[0].state_point.evidence='A cooks.';}],
])test(`streaming ${name} never reaches expression or image planning`,async()=>{
  const f=await fixture({stream:true,texts:['A cooks. A stands in the kitchen.\n\nA reaches']});streamSupport(f);change(f);let calls=0;
  await assert.rejects(f.run({call:async(_messages,definition)=>{calls++;assert.equal(definition.schemaId,NARRATIVE);return JSON.stringify(f.narrative);}}),error=>{
    assert.equal(error.code,'storyboard_contract_failed');assert.equal(error.diagnostic.repairCalls,3);assert.equal(error.diagnostic.stage,'narrative');return true;
  });assert.equal(calls,3);assert.equal(f.saves,0);f.close();
});

test('streaming earlier scene and presence need an explicit same-branch continuity chain; matching names alone do not qualify',async()=>{
  for(const linked of [false,true]){
    const f=await fixture({stream:true,texts:['A is in the kitchen.','USER asks about dinner.','A continues chatting.\n\nA reaches']});
    streamSupport(f,{scene:streamAnchor(0,'A is in the kitchen.'),presence:[{character_id:'A',source:streamAnchor(0,'A is in the kitchen.')}]});
    if(linked)f.narrative.continuity_links=[link(0,2,[])];
    if(linked){assert.equal((await f.run()).meta.repairCalls,0);assert.equal(f.calls.length,1);}
    else await assert.rejects(f.run({call:async()=>JSON.stringify(f.narrative)}),{code:'storyboard_contract_failed'});
    assert.equal(f.saves,0);f.close();
  }
});

test('streaming duplicate quotes cannot prove a unique moment, and manual supplement cannot borrow partial-floor authority',async()=>{
  const f=await fixture({stream:true,texts:['A cooks. A cooks.\n\nA reaches']});streamSupport(f);
  f.narrative.shots[0].stream_support.presence[0].source=streamAnchor(0,'A cooks.');
  await assert.rejects(f.run({call:async()=>JSON.stringify(f.narrative)}),{code:'storyboard_contract_failed'});
  assert.throws(()=>contract.buildStoryboardPlanContractRequest(f.context,{...f.config,manualSupplement:true}),{code:'storyboard_stream_readiness'});f.close();
});

test('streaming evidence repair receives the allowed stable IDs and original selected prose, without a second whole-context call',async()=>{
  const f=await fixture({stream:true});streamSupport(f);f.narrative.shots[0].stream_support.content.quote='invented';let repairs=0;
  const result=await f.run({call:async(messages,definition)=>{
    if(definition.schemaId===EXPRESSION)return JSON.stringify(f.expression());
    repairs++;const input=JSON.parse(messages[1].content);
    assert.equal(input.errors[0].code,'stream_readiness');assert.deepEqual(input.context.constraints.streaming.closed_target_paragraph_ids,['P1']);
    assert.equal(input.context.evidence_sources[0].floor,0);assert.doesNotMatch(JSON.stringify(input.context),/selected world|user description/);
    streamSupport(f);return JSON.stringify(f.narrative);
  }});assert.equal(repairs,1);assert.equal(result.meta.repairCalls,1);assert.equal(f.saves,0);f.close();
});

test('ordinary completed-floor extraction retains its original schema and does not acquire streaming fields or zero-minimum rules',async()=>{
  const f=await fixture(),payload=JSON.parse(f.request.messages[1].content);
  assert.equal(f.request.schema.properties.shots.items.properties.stream_support,undefined);assert.equal(payload.constraints.streaming,undefined);
  assert.equal(payload.constraints.min_shots_target,1);assert.doesNotMatch(f.request.messages[0].content,/流式提前取景/);f.close();
});

test('streaming cancellation or prefix rewrite during expression cannot return a late usable plan',async()=>{
  for(const mode of ['cancel','rewrite','account']){
    const f=await fixture({stream:true});streamSupport(f);let calls=0;
    await assert.rejects(f.run({call:async()=>{calls++;if(mode==='cancel')f.active=false;else if(mode==='account')f.account='st-user:other';else f.host.chat[0].mes='changed prefix\n\nnew tail';return JSON.stringify(f.expression());}}),{code:'storyboard_input_changed'});
    assert.equal(calls,1);assert.equal(f.saves,0);f.close();
  }
});

test('streaming readiness diagnostic names the missing proof, without quoting private prose',()=>{
  const error=contract.storyboardContractFailure({errors:[{code:'stream_readiness',path:'$.shots[0].stream_support',message:'SECRET prose'}]});
  assert.match(error.message,/提前画面/);assert.doesNotMatch(error.message,/SECRET/);
});

test('all-prose changes publish even without a picture, and are reused after serialized host metadata reopen',async()=>{
  const f=await fixture();Object.assign(f.narrative,{should_generate:false,skip_reason:'No new visual moment',shots:[]});f.narrative.source_states[0].events=[event()];
  const result=await f.run();assert.equal(f.calls.length,0);assert.equal(result.meta.stages.length,1);assert.equal(f.saves,1);
  const metadata=plain(f.host.chatMetadata);f.close();
  const next=await fixture({texts:['A removes the coat.\n\nA continues chatting.','A continues chatting.'],metadata});
  assert.deepEqual(next.request.requiredFloors,[1]);assert.equal(next.context.continuity.records[0].events[0].value,'removed');
  next.narrative.source_states=[record(1)];next.narrative.continuity_links=[link(0,1)];
  const resumed=await next.run();assert.equal(resumed.trace.states[0].carriedFacts[0].fact.value,'removed');next.close();
});

test('per-shot replay excludes future changes, expires momentary actions, and current state replaces inherited state',async()=>{
  const f=await fixture({texts:['A removes the coat.','A continues chatting.\n\nA puts the coat on.\n\nA looks outside.']});
  f.narrative.source_states[0].events=[event()];f.narrative.source_states[1].events=[event({id:'wear',paragraphId:'P2',evidence:'A puts the coat on.',value:'worn'}),
    event({id:'look',paragraphId:'P3',category:'action',key:'gaze',persistence:'momentary',value:'outside',evidence:'A looks outside.'})];
  f.narrative.continuity_links=[link(0,1)];
  const shot=plain(f.narrative.shots[0]);f.narrative.shots=[1,2,3].map((number)=>({...plain(shot),source_paragraph_ids:[`P${number}`],insert_after:`P${number}`,
    state_point:{branchId:'now',paragraphId:`P${number}`,evidence:f.window.paragraphs[number-1]}}));
  const result=await f.run(),states=result.trace.states.map(row=>row.effectiveFacts.map(item=>item.fact));
  assert.equal(states[0].find(row=>row.key==='coat').value,'removed');assert.equal(states[1].find(row=>row.key==='coat').value,'worn');
  assert.equal(states[1].some(row=>row.key==='gaze'),false);assert.equal(states[2].find(row=>row.key==='gaze').value,'outside');f.close();
  const g=await fixture({texts:['A removes the coat.\n\nA looks outside.','A continues chatting.']});
  g.narrative.source_states[0].events=[event(),event({id:'look',paragraphId:'P2',category:'action',key:'gaze',persistence:'momentary',value:'outside',evidence:'A looks outside.'})];
  g.narrative.continuity_links=[link(0,1)];assert.equal((await g.run()).trace.states[0].effectiveFacts.length,1);g.close();
});

test('flashback state stays in its own branch and expression results are restored to director order',async()=>{
  const f=await fixture({texts:['A removes the coat.\n\nA remembers wearing the coat.']});
  f.narrative.source_states[0].roster.branches.push({id:'past',layer:'memory'});
  f.narrative.source_states[0].events=[event(),event({id:'old',branchId:'past',paragraphId:'P2',evidence:'A remembers wearing the coat.',value:'worn'})];
  const shot=plain(f.narrative.shots[0]);f.narrative.shots.push({...shot,narrative_layer:'memory',source_paragraph_ids:['P2'],insert_after:'P2',state_point:{branchId:'past',paragraphId:'P2',evidence:f.window.paragraphs[1]}});
  const result=await f.run({call:async()=>{const value=f.expression();value.shots.reverse();return JSON.stringify(value);}});
  assert.equal(result.trace.states[0].effectiveFacts[0].fact.value,'removed');assert.equal(result.trace.states[1].effectiveFacts[0].fact.value,'worn');
  assert.deepEqual(JSON.parse(result.raw).shots.map(row=>row.insert_after),['P1','P2']);f.close();
});

test('stages share exactly three repair calls, local JSON cleanup is free, and second-stage repair never repeats full context',async()=>{
  const f=await fixture();let narrativeCalls=0,expressionCalls=0;
  const result=await f.run({raw:'not json',call:async(messages,definition)=>{
    if(definition.schemaId===NARRATIVE){narrativeCalls++;return narrativeCalls===1?'still invalid':JSON.stringify(f.narrative);}
    expressionCalls++;if(expressionCalls===1)return '{}';assert.doesNotMatch(JSON.stringify(messages),/user description|selected world|stable appearance/);return JSON.stringify(f.expression());
  }});
  assert.equal(narrativeCalls,2);assert.equal(expressionCalls,2);assert.equal(result.meta.repairCalls,3);assert.deepEqual(result.meta.stages.map(row=>row.repairCalls),[2,1]);f.close();
  const g=await fixture();let calls=0;
  await assert.rejects(g.run({raw:'bad',call:async(_messages,definition)=>{calls++;return definition.schemaId===NARRATIVE&&calls===3?JSON.stringify(g.narrative):'bad';}}),error=>{
    assert.equal(error.code,'storyboard_contract_failed');assert.equal(error.diagnostic.repairCalls,3);assert.equal(error.diagnostic.stage,'expression');return true;
  });assert.equal(calls,4);assert.equal(g.saves,1);g.close();
  const h=await fixture();assert.equal((await h.run({raw:'```json\n'+JSON.stringify(h.narrative)+'\n```'})).meta.repairCalls,0);h.close();
});

test('invalid event evidence, unknown floors, future links, swapped moments and wrong expression IDs never become a usable plan',async()=>{
  const changes=[f=>f.narrative.source_states[0].events=[event({evidence:'not in source'})],f=>f.narrative.source_states[0].floor=99,
    f=>f.narrative.continuity_links=[link(0,0)],f=>f.narrative.source_states=[],f=>f.narrative.shots[0].state_point.paragraphId='P2',
    f=>f.narrative.shots[0].characters[0].character_id='unknown'];
  for(const change of changes){const f=await fixture();change(f);let calls=0;
    await assert.rejects(f.run({call:async()=>{calls++;return JSON.stringify(f.narrative);}}),{code:'storyboard_contract_failed'});
    assert.equal(calls,3);assert.equal(f.saves,0);f.close();}
  const f=await fixture();let calls=0;await assert.rejects(f.run({call:async()=>{calls++;const value=f.expression();value.shots[0].shot_id='S4';return JSON.stringify(value);}}),{code:'storyboard_contract_failed'});
  assert.equal(calls,4);assert.equal(f.saves,1);f.close();
});

test('cancellation, edits and account changes around persistence/second request stop late plans without a retry',async()=>{
  for(const phase of ['before','save','expression','repair','account']){
    const f=await fixture();let calls=0;
    if(phase==='before')f.active=false;
    if(phase==='save')f.saveHook=()=>{f.host.chat[0].mes='edited';};
    const options={call:async(_messages,definition)=>{calls++;if(phase==='account')f.account='st-user:other';else f.active=false;return definition.schemaId===NARRATIVE?JSON.stringify(f.narrative):JSON.stringify(f.expression());}};
    if(phase==='repair')options.raw='invalid';
    await assert.rejects(f.run(options),{code:'storyboard_input_changed'});
    assert.equal(calls,['before','save'].includes(phase)?0:1);assert.equal(f.saves,['before','repair'].includes(phase)?0:1);f.close();
  }
});

test('unconfirmed persistence is visible and never retried while verified fresh facts may still produce a plan',async()=>{
  const f=await fixture();f.narrative.source_states[0].events=[event()];f.saveHook=()=>{throw Error('synthetic save unavailable');};
  const result=await f.run();assert.equal(result.meta.persistence.status,'unconfirmed');assert.equal(f.saves,1);assert.equal(f.calls.length,1);
  assert.equal(result.trace.states[0].effectiveFacts[0].fact.value,'removed');f.close();
});

test('local event IDs reused on distinct floors cannot erase either fact when the actual shot is normalized',async()=>{
  const f=await fixture({texts:['A removes the coat.','A continues chatting. A has a cup.']});
  f.narrative.source_states[0].events=[event()];f.narrative.source_states[1].events=[event({category:'prop',key:'cup',value:'held',evidence:'A has a cup.'})];
  f.narrative.continuity_links=[link(0,1)];
  const result=await f.run(),facts=result.trace.shotFacts[0];assert.equal(facts.length,2);assert.notEqual(facts[0].id,facts[1].id);
  const normalized=normalizeStoryboardShotSpec({continuityUpdates:{facts}});assert.equal(normalized.continuityUpdates.facts.length,2);f.close();
});

test('expression transport errors stop once with a stage label and no source/key text in the diagnostic',async()=>{
  const f=await fixture();let calls=0;
  await assert.rejects(f.run({call:async()=>{calls++;throw Error('sensitive narrative and secret bearer token');}}),error=>{
    assert.equal(error.code,'storyboard_contract_failed');assert.equal(error.diagnostic.stopReason,'request_failed');assert.equal(error.diagnostic.stage,'expression');
    assert.match(error.message,/提示表达/);assert.doesNotMatch(error.message+JSON.stringify(error.diagnostic),/sensitive|secret|bearer/);return true;
  });assert.equal(calls,1);assert.equal(f.saves,1);f.close();
});

test('NAI, natural-language channels and explicitly classified Comfy stay separate; unknown Comfy never guesses a format',async()=>{
  for(const [providerId,promptFormats,expected] of [['novel',undefined,['tags']],['openai',undefined,['natural_language']],['comfy',['character_blocks'],['character_blocks']],['comfy',undefined,[]]]){
    const f=await fixture({providerId,promptFormats});assert.deepEqual(f.request.promptFormats,expected);const result=await f.run();
    assert.deepEqual(Object.keys(JSON.parse(result.raw).shots[0].prompt_renderings||{}),expected);f.close();
  }
});

test('actual compiler uses one selected API for both stages, persists metadata and binds final expressions to archive IDs',async()=>{
  const e=await compilerEnvironment();e.state.promptCompiler.apiProfileId='selected-only';e.context.settings.apiProfiles=[{id:'selected-only',apiUrl:'https://synthetic.invalid',model:'synthetic'}];
  assert.equal(await e.context.storyboardCompilePrompt(null),true,JSON.stringify(e.errors));assert.equal(e.llmCalls.length,2);
  assert.deepEqual(e.llmCalls.map(row=>row.id),['selected-only','selected-only']);
  assert.deepEqual(e.llmCalls.map(row=>row.options.jsonSchemaName),[NARRATIVE,EXPRESSION]);
  assert.ok(e.context.ctx().chatMetadata.story_director_liminale.storyboardContinuity);
  const shot=e.state.promptDraft.shots[0];assert.equal(shot.shotSpec.promptRenderingPack.renderings.tags.characters[0].character_id,'archive:alice');
  assert.match(shot.prompt,/^tag-scene-0/);assert.equal(shot.shotSpec.continuityUpdates.facts.length,0);
});

test('compact source catalogue reconstructs every character, including gaps, repeated paragraphs and supplementary Unicode',()=>{
  const text='  first α😀\r\n\r\nrepeat\t repeat\n最后一句  ';
  const paragraphs=[{id:'P1',text:'first α😀'},{id:'P2',text:'repeat'},{id:'P3',text:'repeat'},{id:'P4',text:'最后一句'}];
  const window={messages:[{floor:3,role:'user',text}],sources:[{messageRef:{lastKnownFloor:3},paragraphs}]};
  const [row]=storyboardFocusedCatalogue(window);assert.equal(row.passages.map(item=>item.text).join(''),text);
  assert.deepEqual(row.passages.filter(item=>item.paragraph_id).map(item=>[item.paragraph_id,item.text]),paragraphs.map(item=>[item.id,item.text]));
  assert.equal(row.role,'user');assert.equal(row.full_text,undefined);assert.deepEqual(storyboardFocusedCatalogue(window,[99]),[]);
  window.messages[0].text='encoded &amp; content';window.sources[0].paragraphs=[{id:'P1',text:'encoded & content'}];
  const fallback=storyboardFocusedCatalogue(window)[0];assert.equal(fallback.full_text,window.messages[0].text);assert.equal(fallback.paragraphs[0].text,'encoded & content');
});

test('the actual first request contains each normal source once and retains all selected configuration/context fields',async()=>{
  const f=await fixture({texts:['unique earlier prose','unique current prose']});
  const payload=JSON.parse(f.request.messages[1].content);
  for(const text of ['unique earlier prose','unique current prose'])assert.equal(f.request.messages[1].content.split(text).length-1,1);
  assert.equal(payload.character_setting,'Alice stable appearance');assert.equal(payload.user_persona,'user description');assert.equal(payload.selected_worldbook,'selected world');
  assert.equal(payload.target_paragraphs,undefined);assert.deepEqual(payload.target_paragraph_ids,['P1']);
  assert.deepEqual(payload.recent_messages,[{floor:0,role:'character'},{floor:1,role:'user'}]);f.close();
});

test('input capacity applies to the compact final request, not an unused duplicated legacy intermediate',async()=>{
  const texts=Array.from({length:5},(_,index)=>`${index}-`+'x'.repeat(179998));
  const f=await fixture({texts});assert.ok(Buffer.byteLength(JSON.stringify(f.request.messages))<1024*1024);
  assert.throws(()=>contract.buildStoryboardPlanContractRequest(f.context,{...f.config,focused:false}),{code:'storyboard_input_capacity'});
  const payload=JSON.parse(f.request.messages[1].content);assert.deepEqual(payload.source_catalogue.map(row=>row.passages.map(item=>item.text).join('')),texts);f.close();
  await assert.rejects(fixture({texts:[...texts,'y'.repeat(180000)]}),{code:'storyboard_input_capacity'});
});

test('grounding repair receives only the affected original floor, not unrelated history, persona or worldbook',async()=>{
  const f=await fixture({texts:['A removes the coat.','UNRELATED middle floor','A continues chatting.']});
  f.narrative.source_states[0].events=[event({evidence:'fabricated evidence'})];let repairCalls=0;
  const result=await f.run({call:async(messages,definition)=>{
    if(definition.schemaId===EXPRESSION)return JSON.stringify(f.expression());
    repairCalls++;const payload=JSON.parse(messages[1].content);
    assert.equal(payload.errors[0].code,'source_evidence');assert.equal(payload.errors[0].path,'$.source_states[0]');
    assert.deepEqual(payload.context.evidence_sources.map(row=>row.floor),[0]);
    assert.equal(payload.context.evidence_sources[0].passages[0].text,'A removes the coat.');
    assert.doesNotMatch(JSON.stringify(payload.context),/UNRELATED|user description|selected world|st-user:synthetic/);
    const corrected=plain(f.narrative);corrected.source_states[0].events=[event()];return JSON.stringify(corrected);
  }});
  assert.equal(repairCalls,1);assert.equal(result.meta.repairCalls,1);assert.equal(f.saves,1);f.close();
});

test('expression repair receives the verified plan/state and cannot choose a new shot, scene or character',async()=>{
  const f=await fixture();f.narrative.source_states[0].events=[event()];let calls=0;
  const result=await f.run({call:async(messages)=>{
    calls++;if(calls===1){const value=f.expression();value.shots[0].prompt_renderings.tags.characters=[];return JSON.stringify(value);}
    const payload=JSON.parse(messages[1].content),handoff=payload.context.verified_handoff;
    assert.deepEqual(handoff.shots[0].plan,f.narrative.shots[0]);assert.equal(handoff.shots[0].active_state[0].value,'removed');
    assert.equal(handoff.shots[0].shot_id,'S1');assert.doesNotMatch(JSON.stringify(handoff),/selected world|user description/);
    return JSON.stringify(f.expression());
  }});
  assert.equal(calls,2);assert.equal(result.meta.repairCalls,1);f.close();
});

test('forged repair floor references cannot expand the original source selection; syntax repair gets IDs without a full prose resend',async()=>{
  const f=await fixture({texts:['SECRET earlier','CURRENT text']});
  const result={errors:[{path:'$.continuity_links[0]'}],repairFloors:[-1,88]},data={continuity_links:[{from_floor:-1,to_floor:88,facts:[{source_floor:9000}]}]};
  const isolated=storyboardFocusedRepairContext({name:'narrative',result,data,context:f.context,request:f.request,definition:f.request});
  assert.deepEqual(isolated.evidence_sources,[]);
  const syntax=storyboardFocusedRepairContext({name:'narrative',result:{errors:[{path:'$',code:'json_syntax'}]},context:f.context,request:f.request,definition:f.request});
  assert.doesNotMatch(JSON.stringify(syntax),/SECRET|CURRENT|selected world/);assert.deepEqual(syntax.paragraph_catalogue.map(row=>row.floor),[0,1]);f.close();
});

test('oversized evidence repair and cancellation before dispatch do not consume a request',async()=>{
  const texts=Array.from({length:5},(_,index)=>`${index}-`+'z'.repeat(198998)),f=await fixture({texts});let calls=0;
  // The valid initial input fits; repairing this malformed response with every
  // missing state floor would exceed the final wire budget. Never clip evidence.
  await assert.rejects(f.run({raw:JSON.stringify({padding:'p'.repeat(60000)}),call:async()=>{calls++;return '{}';}}),{code:'storyboard_input_capacity'});
  assert.equal(calls,0);assert.equal(f.saves,0);f.close();
  const g=await fixture();let checks=0;
  await assert.rejects(g.run({raw:'invalid',guard:async()=>{if(++checks===3)g.active=false;await g.window.guard();},call:async()=>{calls++;return '{}';}}),{code:'storyboard_input_changed'});
  assert.equal(calls,0);assert.equal(g.saves,0);g.close();
});
