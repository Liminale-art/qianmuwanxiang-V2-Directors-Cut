import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import * as contract from '../qianmu-storyboard-contract.js';
import {normalizeStoryboardMessageReference,sanitizeStoryboardSnapshot} from '../qianmu-storyboard.js';
import {createStoryboardStreamMoment} from '../qianmu-storyboard-stream-moment.js?v=1.59.224';
import {verifyStoryboardStreamReference} from '../qianmu-storyboard-stream-reference.js?v=1.59.278';
import {resolveStoryboardMessageReference} from '../qianmu-storyboard.js';
import {response as sample} from './helpers/comfy-compiler-fixture.mjs';
import {storyboardStreamStyleHistory} from '../qianmu-storyboard-stream-coverage.js?v=1.59.278';
import {ENSEMBLE_STYLE_ORIGIN_SCHEMA} from '../qianmu-ensemble-origin.js';
const copy=value=>JSON.parse(JSON.stringify(value));
const defaultTexts=['Alice reads a letter.','A mountain valley.','A broken cup.'];
const withStyle=row=>{row.snapshot.ensembleStyleOrigin={schema:ENSEMBLE_STYLE_ORIGIN_SCHEMA,namespace:'st-user:test',chatKey:'char:Alice.png:chat-a',
  preparationId:'old',selectionRevision:'r1',shotId:'S1',schemeId:'ink',revision:'v1',bindingKey:'a'.repeat(64),executionAuthorized:false};
  row.snapshot.ensembleStyleOrigin.chatKey=row.snapshot.chatKey;row.snapshot.shotSpec={sceneFingerprint:{location:'kitchen'},continuityUpdates:{time:'day'}};return row;};
async function fixture({stream=false,max=3,texts=defaultTexts}={}){
  let saves=0,account='st-user:test',identityReads=0;
  const host={chatId:'chat-a',characterId:0,characters:[{chat:'chat-a',avatar:'Alice.png'}],chatMetadata:{story_director_liminale:{}},eventSource:new EventEmitter(),
    chat:[{mes:texts.join('\n\n')+'\n\n',name:'Alice',send_date:'start',gen_started:'generation',swipe_id:0}],saveMetadata:async()=>saves++};
  const options={getContext:()=>host,epoch:()=>0,resolveNamespace:async()=>{identityReads++;return account;},isCurrent:()=>true,floor:0,referenceFloors:0,
    readText:m=>m.mes,readParagraphs:m=>m.mes.split('\n\n').filter(Boolean).map((text,index)=>({id:`P${index+1}`,text}))};
  const initial=await contract.captureStoryboardStreamFrame(options),base=await contract.createStoryboardStreamMessageReference(initial);initial.close();
  const frame=stream?await contract.captureStoryboardStreamFrame(options):null;
  const window=await contract.captureStoryboardCompilerSources({...options,streamFrame:frame}),store=contract.openStoryboardCompilerContinuity(window);
  const context={floor:0,compilerSources:window,paragraphs:window.paragraphs,messages:window.messages,continuity:await store.read()};
  const config={focused:true,providerId:'novel',minShots:2,maxShots:max,allowedRatioIds:['3:2']};
  const shot=index=>{
    const {prompt_atoms,prompt_renderings,...row}=sample().shots[index];
    const anchor={floor:0,branch_id:'present',paragraph_id:`P${index+1}`,quote:texts[index]};
    return {...row,state_point:{branchId:'present',paragraphId:`P${index+1}`,evidence:texts[index]},
      ...(stream?{stream_support:{scene:anchor,content:anchor,presence:row.characters.map(c=>({character_id:c.character_id,source:anchor}))}}:{})};
  };
  const history=(index,{status='success',submissionState,automaticSlot=true,id=String(index+1).repeat(64)}={})=>{
    const messageRef={...copy(base),stream:{...copy(base.stream),moment:createStoryboardStreamMoment(shot(index),window)}};
    return {id:`log-${index}`,status,...(submissionState?{submissionState}:{}),snapshot:{messageRef,chatKey:base.chatKey,automatic:true,
      imageAdmission:{version:1,namespace:'st-user:test',chatKey:base.chatKey,messageKey:base.messageKey,revisionId:base.revisionId,logicalShotId:id,attemptId:`attempt-${index}`,automaticSlot}}};
  };
  const narrative=indices=>({schema:'qianmu.storyboard.narrative.v1',should_generate:indices.length>0,skip_reason:indices.length?'':'No new view',decisions:[],shots:indices.map(shot),
    source_states:[{floor:0,roster:{branches:[{id:'present',layer:'present'}],subjectIds:['A']},events:[]}],continuity_links:[]});
  const calls=[];
  return {host,window,context,config,options,shot,history,narrative,calls,base,get saves(){return saves;},get identityReads(){return identityReads;},set account(value){account=value;},
    async prepare(rows=[]){context.streamCoverage=await contract.captureStoryboardStreamCoverage(window,rows);return contract.buildStoryboardPlanContractRequest(context,config);},
    async run(request,data,override){return contract.completeStoryboardFocusedExtraction({raw:JSON.stringify(data),context,request,guard:window.guard,publish:rows=>store.publish(rows),
      call:async(messages,definition)=>{
        const payload=JSON.parse(messages[1].content);calls.push({payload,definition});if(override)return override(payload,definition);
        assert.equal(definition.schemaId,'qianmu.storyboard.expression.v1');
        return JSON.stringify({schema:definition.schemaId,shots:payload.shots.map(row=>({shot_id:row.shot_id,prompt_atoms:{global:[row.plan.subject],character_ids:row.plan.characters.map(c=>c.character_id),scene_negative:[]},
          prompt_renderings:{tags:{global:row.plan.subject,characters:row.plan.characters.map(c=>({character_id:c.character_id,positive:'silver hair'})),negative:''}}}))});
      }});},close(){store.close();window.close();}};
}

test('complete-floor planning sees occupied stream pictures, sends the full source and expresses only uncovered scenes',async()=>{
  const f=await fixture(),record=f.history(0),request=await f.prepare([record]),payload=JSON.parse(request.messages[1].content);
  assert.equal(payload.constraints.max_shots,2);assert.equal(payload.constraints.min_shots_target,1);assert.equal(payload.committed_images[0].subject,'Alice reads a letter');
  for(const text of defaultTexts)assert.ok(request.messages[1].content.includes(text));
  const result=await f.run(request,f.narrative([0,1,2]));assert.equal(result.meta.repairCalls,0);assert.equal(result.meta.coveredStreamShots,1);
  assert.deepEqual(result.trace.narrative.shots.map(row=>row.insert_after),['P2','P3']);assert.equal(f.calls.length,1);
  assert.deepEqual(f.calls[0].payload.shots.map(row=>row.plan.insert_after),['P2','P3']);assert.equal(f.saves,1);
  assert.equal(JSON.parse(result.raw).shots.length,2);assert.equal(record.status,'success');f.close();
});

test('a final proof covers the entire current prose, keeps the old budget family and remains strict on later append',async()=>{
  const f=await fixture();await f.prepare([f.history(0)]);
  const ref=await contract.createStoryboardFinalStreamReference(f.window,f.context.streamCoverage);
  assert.equal(ref.revisionId,f.base.revisionId);assert.equal(ref.stream.complete,true);assert.equal(ref.stream.prefixLength,f.host.chat[0].mes.length);
  assert.ok(Object.isFrozen(ref.stream.generation));assert.deepEqual(normalizeStoryboardMessageReference(copy(ref)),ref);
  assert.deepEqual(sanitizeStoryboardSnapshot({source:'novel',messageRef:ref}).messageRef,ref);
  const resolve=value=>resolveStoryboardMessageReference(value,f.host.chat,{chatKey:ref.chatKey});
  f.close();await verifyStoryboardStreamReference(ref,()=>resolve(ref));f.host.chat[0].mes+='New ending';
  assert.equal(resolve(ref).state,'stale');await assert.rejects(verifyStoryboardStreamReference(ref,()=>resolve(ref)),{code:'storyboard_stream_source'});
  assert.equal(resolve(f.base).state,'active','earlier accepted prefixes retain their append-tolerant identity');
});

test('final proof creation cannot borrow a partial source window or cloned coverage ownership',async()=>{
  const partial=await fixture({stream:true});await assert.rejects(contract.createStoryboardFinalStreamReference(partial.window),{code:'storyboard_input_changed'});partial.close();
  const f=await fixture();await f.prepare([f.history(0)]);
  await assert.rejects(contract.createStoryboardFinalStreamReference(f.window,copy(f.context.streamCoverage)),{code:'storyboard_stream_coverage'});f.close();
});

test('final proof rejects an unavailable identity, account change or edited source instead of recycling earlier prefix authority',async()=>{
  const first=await fixture();delete first.host.chat[0].gen_started;
  await assert.rejects(contract.createStoryboardFinalStreamReference(first.window));first.close();
  const second=await fixture();second.account='st-user:another';await assert.rejects(contract.createStoryboardFinalStreamReference(second.window));second.close();
  const third=await fixture();await third.prepare([third.history(0)]);third.host.chat[0].mes+='new text';
  await assert.rejects(contract.createStoryboardFinalStreamReference(third.window,third.context.streamCoverage));third.close();
});

test('an invalid explicit completion marker cannot normalize into a looser prefix reference',async()=>{
  const f=await fixture(),ref=await contract.createStoryboardFinalStreamReference(f.window);
  for(const complete of [false,'true',1,null])assert.equal(normalizeStoryboardMessageReference({...copy(ref),stream:{...copy(ref.stream),complete}}).stream.invalid,true);
  f.close();
});

test('later partial frames also avoid committed moments; zero new scenes means no expression call or provisional ST write',async()=>{
  const f=await fixture({stream:true}),request=await f.prepare([f.history(0)]),result=await f.run(request,f.narrative([0]));
  assert.equal(JSON.parse(result.raw).should_generate,false);assert.equal(result.meta.repairCalls,0);assert.equal(f.calls.length,0);assert.equal(f.saves,0);f.close();
});

test('a full budget still records final-floor changes but never needs a second expression request for duplicates',async()=>{
  const f=await fixture({max:1}),request=await f.prepare([f.history(0)]),payload=JSON.parse(request.messages[1].content);
  assert.equal(payload.constraints.max_shots,0);assert.equal(payload.constraints.min_shots_target,0);
  const result=await f.run(request,f.narrative([0]));assert.equal(JSON.parse(result.raw).shots.length,0);assert.equal(f.calls.length,0);assert.equal(f.saves,1);f.close();
});

for(const status of ['queued','generating','success','completed','unknown','accepted','legacy-interrupted'])test(`${status} occupies its slot before image delivery, including compact gallery indices and repeated log/result references`,async()=>{
  const f=await fixture(),row=f.history(0,{status:['unknown','accepted','legacy-interrupted'].includes(status)?'failed':status,
    submissionState:['unknown','accepted'].includes(status)?status:undefined});
  if(status==='legacy-interrupted')row.startedAt=1;
  const gallery={id:'image',url:'https://example.invalid/image.png',messageRef:copy(row.snapshot.messageRef),imageAdmission:copy(row.snapshot.imageAdmission)};
  const coverage=await contract.captureStoryboardStreamCoverage(f.window,[row,gallery]);assert.equal(coverage.pins.length,1);
  assert.ok(Object.isFrozen(coverage.pins[0].moment));assert.deepEqual(normalizeStoryboardMessageReference(gallery.messageRef).stream.moment,gallery.messageRef.stream.moment);
  assert.deepEqual(sanitizeStoryboardSnapshot({...row.snapshot,source:'novel'}).messageRef.stream.moment,gallery.messageRef.stream.moment);f.close();
});

test('manual work, rejected unsubmitted work and another chat or generation do not consume this automatic floor budget',async()=>{
  const f=await fixture(),manual=f.history(0,{automaticSlot:false}),rejected=f.history(1,{status:'failed',submissionState:'not_submitted'}),foreign=f.history(2);
  foreign.snapshot.messageRef.chatKey='elsewhere';const old=f.history(0);old.snapshot.messageRef.stream.generation.startedAt='older';
  assert.equal(await contract.captureStoryboardStreamCoverage(f.window,[manual,rejected,foreign,old]),null);f.close();
});

test('manual redraw of an originally automatic shot still represents its existing slot, not a new manual slot or free capacity',async()=>{
  const f=await fixture(),original=f.history(0),redraw=copy(original);redraw.id='manual-redraw';redraw.snapshot.automatic=false;
  redraw.snapshot.imageAdmission.attemptId='manual-attempt';
  const coverage=await contract.captureStoryboardStreamCoverage(f.window,[original,redraw]);assert.equal(coverage.pins.length,1);
  const retained=await contract.captureStoryboardStreamCoverage(f.window,[redraw]);assert.equal(retained.pins.length,1);
  redraw.snapshot.imageAdmission.automaticSlot=false;assert.equal(await contract.captureStoryboardStreamCoverage(f.window,[redraw]),null);f.close();
});

test('source proof, moment, account and compact receipt mismatches fail before any compiler call, not a new free budget',async()=>{
  const f=await fixture();
  for(const mutate of [row=>delete row.snapshot.messageRef.stream.moment,row=>row.snapshot.messageRef.stream.moment.quote='invented',
    row=>row.snapshot.messageRef.stream.prefixDigest='a'.repeat(64),row=>delete row.snapshot.imageAdmission,
    row=>row.snapshot.imageAdmission.namespace='st-user:other',row=>row.snapshot.imageAdmission.logicalShotId='bad']){
    const row=f.history(0);mutate(row);await assert.rejects(contract.captureStoryboardStreamCoverage(f.window,[row]));
  }
  assert.equal(f.calls.length,0);f.close();
});

test('nested evidence of the same moment is deduplicated without another model repair',async()=>{
  const f=await fixture(),row=f.history(0);row.snapshot.messageRef.stream.moment.quote='reads a letter';row.snapshot.messageRef.stream.moment.start=6;row.snapshot.messageRef.stream.moment.end=20;
  const request=await f.prepare([row]),data=f.narrative([0,1]);const result=await f.run(request,data);
  assert.deepEqual(result.trace.narrative.shots.map(row=>row.insert_after),['P2']);assert.equal(result.meta.repairCalls,0);f.close();
});

test('different moments within one paragraph are not blocked just because the paragraph already has an illustration',async()=>{
  const first='Alice reads a letter.',next='A broken cup.',f=await fixture({texts:[first+' '+next]}),row=f.history(0);
  Object.assign(row.snapshot.messageRef.stream.moment,{quote:first,start:0,end:first.length});
  const request=await f.prepare([row]),data=f.narrative([0]);
  data.shots[0].state_point.evidence=next;data.shots[0].subject='a broken cup';data.shots[0].characters=[];
  const result=await f.run(request,data);assert.equal(result.trace.narrative.shots.length,1);assert.equal(result.meta.coveredStreamShots,0);assert.equal(f.calls.length,1);f.close();
});

test('a shared sentence can still provide a distinct important subject; coverage does not ban the whole quote',async()=>{
  const f=await fixture(),request=await f.prepare([f.history(0)]),data=f.narrative([0]);
  data.shots[0].subject='the letter in Alice’s hands';data.shots[0].shot_role='detail';data.shots[0].shot_scale='insert';
  const result=await f.run(request,data);assert.equal(result.trace.narrative.shots.length,1);assert.equal(result.meta.coveredStreamShots,0);f.close();
});

test('over-budget new shots get a local repair with committed anchors and the existing shared three-request ceiling',async()=>{
  const f=await fixture({max:2}),request=await f.prepare([f.history(0)]);
  await assert.rejects(f.run(request,f.narrative([1,2]),(payload,definition)=>{
    assert.equal(definition.repair,true);assert.equal(payload.context.committed_images.length,1);
    assert.equal(payload.context.constraints.max_shots,1);return JSON.stringify(f.narrative([1,2]));
  }),error=>error.repairCalls===3&&error.diagnostic.reasonCodes.includes('stream_budget'));
  assert.equal(f.calls.length,3);assert.equal(f.saves,0);f.close();
});

test('manual supplement cannot inherit automatic occupied pictures and raw forged coverage cannot change a contract',async()=>{
  const f=await fixture();await f.prepare([f.history(0)]);
  assert.throws(()=>contract.buildStoryboardPlanContractRequest(f.context,{...f.config,manualSupplement:true}),{code:'storyboard_stream_coverage'});
  f.context.streamCoverage=copy(f.context.streamCoverage);assert.throws(()=>contract.buildStoryboardPlanContractRequest(f.context,f.config),{code:'storyboard_stream_coverage'});f.close();
});

test('closed source windows and account changes cannot return a late reusable coverage snapshot',async()=>{
  const f=await fixture(),row=f.history(0);f.account='st-user:other';await assert.rejects(contract.captureStoryboardStreamCoverage(f.window,[row]));f.close();
  await assert.rejects(contract.captureStoryboardStreamCoverage(f.window,[row]));
});

test('ordinary automatic extraction with no stream history adds no account lookup or storage round trip',async()=>{
  const f=await fixture(),before=f.identityReads;
  assert.equal(await contract.captureStoryboardStreamCoverage(f.window,[]),null);
  assert.equal(await contract.captureStoryboardStreamCoverage(f.window,[{status:'success',snapshot:{messageRef:{revisionId:'ordinary'}}}]),null);
  assert.equal(f.identityReads,before);assert.equal(f.saves,0);f.close();
});

test('coverage is bound to the exact borrowed window and exposes only a budget scope, not reusable source authority',async()=>{
  const a=await fixture(),b=await fixture();await a.prepare([a.history(0)]);
  assert.equal(a.context.streamCoverage.messageRef,undefined);assert.equal(a.context.streamCoverage.scope.revisionId,a.base.revisionId);
  b.context.streamCoverage=a.context.streamCoverage;
  assert.throws(()=>contract.buildStoryboardPlanContractRequest(b.context,b.config),{code:'storyboard_stream_coverage'});a.close();b.close();
});

test('only occupied verified source rows contribute private scene anchors, never rejected or manual attempts',async()=>{
  const f=await fixture(),accepted=withStyle(f.history(0)),rejected=withStyle(f.history(1,{status:'failed',submissionState:'not_submitted'})),manual=withStyle(f.history(2,{automaticSlot:false}));
  const coverage=await contract.captureStoryboardStreamCoverage(f.window,[accepted,rejected,manual]),history=storyboardStreamStyleHistory(coverage,f.window);
  assert.equal(history.namespace,'st-user:test');assert.equal(history.rows.length,1);assert.equal(history.rows[0].anchor.origin.schemeId,'ink');
  assert.equal(history.rows[0].anchor.moment.paragraphId,'P1');assert.ok(Object.isFrozen(history.rows[0]));assert.equal(coverage.styleHistory,undefined);f.close();
});

test('duplicated log/gallery provenance is deduplicated and copied or foreign coverage cannot expose it',async()=>{
  const f=await fixture(),other=await fixture(),row=withStyle(f.history(0));
  const coverage=await contract.captureStoryboardStreamCoverage(f.window,[row,{...copy(row),id:'gallery',url:'/user/images/test.png'}]);
  assert.equal(storyboardStreamStyleHistory(coverage,f.window).rows.length,1);
  assert.throws(()=>storyboardStreamStyleHistory(copy(coverage),f.window),{code:'storyboard_stream_coverage'});
  assert.throws(()=>storyboardStreamStyleHistory(coverage,other.window),{code:'storyboard_stream_coverage'});f.close();other.close();
});

test('invalid style metadata does not break ordinary budget accounting when the ensemble is not enabled',async()=>{
  const f=await fixture(),row=withStyle(f.history(0));row.snapshot.ensembleStyleOrigin={invalid:true};
  const request=await f.prepare([row]);assert.equal(request.sceneContinuation,null);assert.equal(f.context.streamCoverage.pins.length,1);f.close();
});
