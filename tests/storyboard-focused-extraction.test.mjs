import test from 'node:test';
import assert from 'node:assert/strict';
import * as contract from '../qianmu-storyboard-contract.js';
import {normalizeStoryboardShotSpec} from '../qianmu-storyboard.js';
import {STORYBOARD_NARRATIVE_SCHEMA as NARRATIVE,STORYBOARD_EXPRESSION_SCHEMA as EXPRESSION} from '../qianmu-storyboard-focused-extraction.js';
import {response as basePlan,compilerEnvironment} from './helpers/comfy-compiler-fixture.mjs';

const roster=()=>({branches:[{id:'now',layer:'present'}],subjectIds:['A']});
const event=(overrides={})=>({id:'coat',branchId:'now',paragraphId:'P1',subjectId:'A',category:'outfit',key:'coat',value:'removed',persistence:'persistent',evidence:'A removes the coat.',...overrides});
const record=(floor,events=[])=>({floor,roster:roster(),events});
const link=(from,to,facts=[{source_floor:from,event_id:'coat',subject_id:'A'}])=>({from_floor:from,from_branch:'now',to_floor:to,to_branch:'now',evidence:{paragraph_id:'P1',quote:'A continues chatting.'},facts});
const plain=value=>JSON.parse(JSON.stringify(value));

async function fixture({texts=['A removes the coat.\n\nA continues chatting.'],providerId='novel',promptFormats,maxShots=3,metadata}={}){
  let active=true,saves=0,account='st-user:synthetic',saveHook=null;
  const host={chatId:'synthetic',characterId:0,characters:[{avatar:'A.png',chat:'synthetic'}],chatMetadata:metadata||{story_director_liminale:{}},
    chat:texts.map((mes,index)=>({mes,name:'A',is_user:index%2===1,send_date:String(index)})),async saveMetadata(){saves++;if(saveHook)await saveHook();}};
  const floor=texts.length-1;
  const window=await contract.captureStoryboardCompilerSources({floor,referenceFloors:floor,getContext:()=>host,epoch:()=>0,
    isCurrent:()=>active,resolveNamespace:async()=>account,readText:message=>message.mes,
    readParagraphs:message=>message.mes.split('\n\n').map((text,index)=>({id:`P${index+1}`,text}))});
  const store=contract.openStoryboardCompilerContinuity(window);
  const context={floor,messages:window.messages,paragraphs:window.paragraphs,currentCharacter:'Alice stable appearance',persona:'user description',world:'selected world',
    compilerSources:window,continuity:await store.read()};
  const config={focused:true,providerId,promptFormats,maxShots,minShots:1,allowedRatioIds:['3:2'],groupLabel:'obsolete three beats',groupInstruction:'MUST split the scene into three narrative acts'};
  const request=contract.buildStoryboardPlanContractRequest(context,config);
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
