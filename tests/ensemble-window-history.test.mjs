import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import * as contract from '../qianmu-storyboard-contract.js';
import {readEnsembleWindowHistory} from '../qianmu-ensemble-history.js?v=1.59.356';
import {createEnsembleStyleSession} from '../qianmu-ensemble-selection.js';
import {ensembleStyleOrigins} from '../qianmu-ensemble-origin.js';
import {normalizeStoryboardShotSpec} from '../qianmu-storyboard.js';
import {createStoryboardStreamMoment} from '../qianmu-storyboard-stream-moment.js?v=1.59.224';
import {response as basePlan} from './helpers/comfy-compiler-fixture.mjs';
const copy=value=>JSON.parse(JSON.stringify(value));
async function fixture({floor=2,referenceFloors=2,duplicate=false}={}){
  let account='st-user:history',reads=0,saves=0;
  const host={chatId:'history',characterId:0,characters:[{avatar:'A.png',chat:'history'}],chatMetadata:{story_director_liminale:{}},eventSource:new EventEmitter(),
    chat:Array.from({length:floor+1},(_,i)=>({mes:(i===floor?'A continues chatting.':'Alice reads a letter in the kitchen.')+'\n\n',name:'A',is_user:i===floor-1,send_date:1000+i,gen_started:2000+i})),saveMetadata:async()=>saves++};
  if(duplicate)host.chat[1]=copy(host.chat[0]);
  for(let i=0;i<floor-referenceFloors;i++)Object.defineProperty(host.chat[i],'mes',{get(){assert.fail('unselected prose read');}});
  const options={floor,referenceFloors,getContext:()=>host,epoch:()=>0,isCurrent:()=>true,resolveNamespace:async()=>{reads++;return account;},
    readText:message=>message.mes,readParagraphs:message=>message.mes.split('\n\n').filter(Boolean).map((text,i)=>({id:`P${i+1}`,text}))};
  const window=await contract.captureStoryboardCompilerSources(options),store=contract.openStoryboardCompilerContinuity(window),chatKey=window.current.messageRef.chatKey;
  const library={schema:'qianmu.ensemble.library.v1',namespace:account,schemes:[{id:'ink',revision:'ink-v1',name:'Ink',description:'quiet',tags:[],binding:{routeId:'private-route'}}]};
  const selection={schema:'qianmu.ensemble.chat-selection.v1',namespace:account,chatKey,revision:'choice-v1',enabled:true,styleLock:true,schemeIds:['ink']};
  const proof=revision=>({namespace:account,chatKey,preparationId:'new-batch',revision,bindingKey:'a'.repeat(64),ready:true,promptFormats:['tags']});
  const session=createEnsembleStyleSession({library,selection,namespace:account,chatKey,preparationId:'new-batch',base:proof('base-v1'),eligibility:new Map([['ink',proof('ink-v1')]]),guard:()=>window.assertCurrent()});
  const origin=ensembleStyleOrigins(session.resolve([{shot_id:'S1',scheme_id:'ink',reason:'quiet'}],['S1']),['S1'])[0];
  const context={floor,messages:window.messages,paragraphs:window.paragraphs,compilerSources:window,continuity:await store.read()};
  const config={focused:true,providerId:'novel',maxShots:3,minShots:1,allowedRatioIds:['3:2'],styleSession:session};
  const source=window.sources[0],oldFloor=source.messageRef.lastKnownFloor,raw=basePlan().shots[0];
  const oldShot={...raw,state_point:{branchId:'old',paragraphId:'P1',evidence:source.paragraphs[0].text}};
  const moment=createStoryboardStreamMoment(oldShot,{current:source});
  const spec=normalizeStoryboardShotSpec({subject:raw.subject,narrativeLayer:raw.narrative_layer,sourceParagraphIds:['P1'],insertAfter:'P1',narrativeMoment:moment,
    location:'kitchen',continuityUpdates:{time:'day'}});
  const row={id:'old-log',status:'queued',snapshot:{source:'novel',chatKey,messageRef:copy(source.messageRef),shotSpec:spec,ensembleStyleOrigin:origin,
    imageAdmission:{version:1,namespace:account,chatKey,messageKey:source.messageRef.messageKey,revisionId:source.messageRef.revisionId,logicalShotId:'b'.repeat(64),attemptId:'old-job',automaticSlot:true}}};
  const {prompt_atoms,prompt_renderings,...shot}=raw;
  const narrative={schema:'qianmu.storyboard.narrative.v1',should_generate:true,skip_reason:'',decisions:[],shots:[{...shot,scene_predecessor:'E1',
    state_point:{branchId:'new',paragraphId:'P1',evidence:window.current.paragraphs[0].text}}],
    source_states:window.sources.map(source=>({floor:source.messageRef.lastKnownFloor,roster:{branches:[{id:source===window.current?'new':'old',layer:'present'}],subjectIds:['A']},events:[]})),
    continuity_links:[{from_floor:oldFloor,from_branch:'old',to_floor:floor,to_branch:'new',evidence:{paragraph_id:'P1',quote:window.current.paragraphs[0].text},facts:[]}]};
  const calls=[];
  return {host,options,window,context,config,row,narrative,session,selection,library,origin,oldFloor,calls,get reads(){return reads;},get saves(){return saves;},set account(value){account=value;},
    async prepare(rows=[row]){await contract.captureStoryboardEnsembleHistory(window,rows);return contract.buildStoryboardPlanContractRequest(context,config);},
    async run(request,call){return contract.completeStoryboardFocusedExtraction({raw:JSON.stringify(narrative),context,request,guard:window.guard,publish:records=>store.publish(records),
      call:async(messages,definition)=>{const payload=JSON.parse(messages[1].content);calls.push({payload,definition});if(call)return call(payload,definition);
        return JSON.stringify({schema:'qianmu.storyboard.expression.v1',shots:[{shot_id:'S1',prompt_atoms,prompt_renderings:{tags:prompt_renderings.tags}}],style_assignments:[{shot_id:'S1',scheme_id:'ink',reason:'same scene'}]});}});},
    close(){store.close();window.close();}};
}

test('actual selected-floor capture binds a compact old style anchor and an empty-facts continuity link can inherit it',async()=>{
  const f=await fixture();try{const request=await f.prepare(),payload=JSON.parse(request.messages[1].content);assert.equal(payload.prior_scene_anchors[0].floor,0);
    assert.doesNotMatch(JSON.stringify(payload.prior_scene_anchors),/st-user|private-route|schemeId|bindingKey|ink/);
    const result=await f.run(request);assert.equal(f.calls.length,1);assert.equal(f.calls[0].payload.style_scene_lock.groups[0].scheme_id,'ink');
    assert.equal(result.styleSelection.assignments[0].schemeId,'ink');assert.equal(f.saves,1);assert.equal(result.trace.states[0].carriedFacts.length,0);
  }finally{f.close();}
});

test('a declared predecessor without a verified cross-floor chain is repaired locally and never reaches expression',async()=>{
  const f=await fixture();try{const request=await f.prepare();f.narrative.continuity_links=[];
    await assert.rejects(f.run(request,async(payload)=>{assert.equal(payload.stage,'narrative');assert.deepEqual(payload.context.prior_scene_anchors.map(row=>row.floor),[0]);
      assert.deepEqual(payload.context.evidence_sources.map(row=>row.floor),[0,2]);return JSON.stringify(f.narrative);}),error=>error.repairCalls===3&&error.diagnostic.reasonCodes.includes('style_scene_continuation'));
    assert.equal(f.calls.length,3);assert.equal(f.saves,0);
  }finally{f.close();}
});

test('multi-hop cross-floor inheritance accepts only the source branch actually on the validated path',async()=>{
  const f=await fixture();try{const request=await f.prepare();f.narrative.continuity_links=[
    {from_floor:0,from_branch:'old',to_floor:1,to_branch:'old',evidence:{paragraph_id:'P1',quote:f.window.sources[1].paragraphs[0].text},facts:[]},
    {...f.narrative.continuity_links[0],from_floor:1,from_branch:'old'}];
    assert.equal((await f.run(request)).styleSelection.assignments[0].schemeId,'ink');
  }finally{f.close();}
});

test('large chats are read only through the selected window, and outside-history entries never expand it',async()=>{
  const f=await fixture({floor:3999});try{
    const outside=copy(f.row);outside.snapshot.messageRef.messageKey='not-selected';outside.snapshot.messageRef.lastKnownFloor=0;
    const request=await f.prepare([outside,f.row]);assert.deepEqual(JSON.parse(request.messages[1].content).prior_scene_anchors.map(row=>row.floor),[3997]);
    assert.equal((await f.run(request)).styleSelection.assignments[0].schemeId,'ink');
  }finally{f.close();}
});

test('rejected, manual, foreign-account and out-of-window history never becomes a style anchor or extra account lookup',async()=>{
  const f=await fixture();try{const rejected=copy(f.row),manual=copy(f.row),foreign=copy(f.row),outside=copy(f.row);
    rejected.status='failed';rejected.submissionState='not_submitted';manual.snapshot.imageAdmission.automaticSlot=false;foreign.snapshot.imageAdmission.namespace='st-user:other';outside.snapshot.messageRef.chatKey='other';
    const before=f.reads,request=await f.prepare([rejected,manual,foreign,outside]);assert.equal(f.reads,before);assert.equal(request.sceneContinuation,null);
  }finally{f.close();}
});

test('source revision or swipe changes exclude stale images without reinterpreting them as the new scene',async()=>{
  for(const kind of ['revision','swipe']){const f=await fixture();try{if(kind==='revision')f.row.snapshot.messageRef.revisionHash='different';else f.row.snapshot.messageRef.swipeId=2;
    const request=await f.prepare();assert.equal(request.sceneContinuation,null);assert.equal(readEnsembleWindowHistory(f.window).rows.length,0);
  }finally{f.close();}}
});

test('missing or mismatched admission for an otherwise accepted selected source fails closed',async()=>{
  for(const field of ['revisionId','messageKey','logicalShotId','attemptId']){const f=await fixture();try{f.row.snapshot.imageAdmission[field]='';await assert.rejects(f.prepare(),{code:'ensemble_history_source'});assert.equal(f.calls.length,0);}finally{f.close();}}
});

test('source edits, account changes and copied windows cannot reuse a historical capture',async()=>{
  const f=await fixture();try{const request=await f.prepare();f.host.chat[0].mes='edited';await assert.rejects(f.run(request));assert.equal(f.calls.length,0);}finally{f.close();}
  const g=await fixture();try{g.account='st-user:other';await assert.rejects(g.prepare());assert.equal(g.calls.length,0);}finally{g.close();}
  const h=await fixture();try{await assert.rejects(contract.captureStoryboardEnsembleHistory({...h.window},[h.row]),{code:'storyboard_input_changed'});assert.equal(readEnsembleWindowHistory(h.window),null);}finally{h.close();}
});

test('duplicate log and gallery rows share one immutable scene anchor and cannot be captured again for the same window',async()=>{
  const f=await fixture();try{const request=await f.prepare([f.row,{...copy(f.row),id:'image',url:'/user/images/fixture.png'}]);
    assert.equal(JSON.parse(request.messages[1].content).prior_scene_anchors.length,1);assert.ok(Object.isFrozen(readEnsembleWindowHistory(f.window).rows[0]));
    await assert.rejects(contract.captureStoryboardEnsembleHistory(f.window,[f.row]),{code:'ensemble_history_source'});
  }finally{f.close();}
});

test('indistinguishable source identities within the selected window are not guessed by nearest floor',async()=>{
  const f=await fixture({duplicate:true});try{await assert.rejects(f.prepare(),{code:'ensemble_history_source'});assert.equal(f.calls.length,0);}finally{f.close();}
});

test('a previous streaming image needs its exact prefix digest and valid original source before cross-floor inheritance',async()=>{
  for(const bad of [false,true]){const f=await fixture();try{
    const frame=await contract.captureStoryboardStreamFrame({...f.options,floor:0,referenceFloors:0}),ref=copy(await contract.createStoryboardStreamMessageReference(frame));frame.close();
    ref.stream.moment=f.row.snapshot.shotSpec.narrativeMoment;if(bad)ref.stream.prefixDigest='f'.repeat(64);
    f.row.snapshot.messageRef=ref;f.row.snapshot.imageAdmission.revisionId=ref.revisionId;
    if(bad)await assert.rejects(f.prepare(),{code:'storyboard_stream_source'});
    else assert.equal((await f.run(await f.prepare())).styleSelection.assignments[0].schemeId,'ink');
  }finally{f.close();}}
});
