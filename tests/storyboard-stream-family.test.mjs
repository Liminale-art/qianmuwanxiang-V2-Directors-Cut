import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import * as core from '../qianmu-storyboard.js';
import {captureStoryboardContinuation,saveStoryboardContinuation} from '../qianmu-storyboard-continuation.js';
import {captureStoryboardStreamFrame,createStoryboardStreamMessageReference} from '../qianmu-storyboard-stream-source.js?v=1.59.338';
import {bindStoryboardStreamBudgetFamily as bind,storyboardStreamBudgetReference as budget,normalizeStoryboardStreamReference as normalize,
  verifyStoryboardStreamReference as verify} from '../qianmu-storyboard-stream-reference.js?v=1.59.338';
import {createImageAdmission,createImageAdmissionIdentity,createImageHistorySeeds} from '../qianmu-image-admission.js';
import {imageAttemptScopeKey,claimImageAttempt,importImageAttempts,beginImageAttempt,settleImageAttempt,summarizeImageAttempts} from '../qianmu-image-attempts.js';
const copy=value=>JSON.parse(JSON.stringify(value));
function store(){
  const rows=new Map(),now=1780000000000;
  const run=(scope,fn)=>{const key=imageAttemptScopeKey(scope),result=fn(rows.get(key));rows.set(key,copy(result.ledger));return result;};
  return {rows,close(){},claim:async(scope,input,seeds=[])=>run(scope,raw=>claimImageAttempt(importImageAttempts(raw,scope,seeds,now),scope,input,now)),
    begin:async(scope,input)=>run(scope,raw=>beginImageAttempt(raw,scope,input,now)),settle:async(scope,input)=>run(scope,raw=>settleImageAttempt(raw,scope,input,now)),
    inspect:scope=>summarizeImageAttempts(rows.get(imageAttemptScopeKey(scope)),scope,now)};
}
const job=(ref,id,prompt=id)=>({id,chatKey:ref.chatKey,messageRef:copy(ref),automatic:true,target:'floor',source:'novel',profile:{count:'1'},prompt});
async function fixture(){
  const message={mes:'Alice cooks.\n\n',name:'Alice',send_date:'day-1',gen_started:'generation-1',swipe_id:0};
  const context={chatId:'chat',characterId:0,characters:[{chat:'chat',avatar:'Alice.png'}],chat:[message],chatMetadata:{story_director_liminale:{}},eventSource:new EventEmitter()};
  const metadata=context.chatMetadata.story_director_liminale,account=async()=>'st-user:test';
  const options={getContext:()=>context,epoch:()=>0,resolveNamespace:account,isCurrent:()=>true,floor:0,createReference:core.createStoryboardMessageReference};
  const source=async()=>{const frame=await captureStoryboardStreamFrame(options);try{return await createStoryboardStreamMessageReference(frame);}finally{frame.close();}};
  const root=await source(),resolve=ref=>core.resolveStoryboardMessageReference(ref,context.chat,{chatKey:'chat',metadata:context.chatMetadata,namespace:'st-user:test'});
  let generation=1;
  return {message,context,metadata,root,source,resolve,account,options,
    async advance(save=async()=>{}){
      const handle=captureStoryboardContinuation({...options,type:'continue'});
      generation++;message.mes+=`Scene ${generation}.\n\n`;message.send_date=`day-${generation}`;message.gen_started=`generation-${generation}`;
      message.swipe_info=[{send_date:message.send_date,gen_started:message.gen_started,extra:{}}];
      try{await saveStoryboardContinuation(handle,account,metadata,save);}finally{handle.close();}
      return source();
    },
    runtime(ledger=store(),namespace='st-user:test'){
      return {ledger,runtime:createImageAdmission({store:ledger,ownerId:'page',account:async()=>namespace,resolveSource:value=>resolve(value.messageRef)})};
    }};
}

test('a continued source keeps its fresh identity and carries one compact original budget root through actual archive normalizers',async()=>{
  const f=await fixture(),old=copy(f.root),fresh=await f.advance(),ref=await bind(fresh,f.root,'st-user:test',f.resolve);
  assert.equal(ref.stream.version,2);assert.equal(ref.revisionId,fresh.revisionId);assert.equal(ref.messageKey,fresh.messageKey);
  assert.notEqual(ref.revisionId,f.root.revisionId);assert.notEqual(ref.messageKey,f.root.messageKey);
  assert.equal(budget(ref).revisionId,f.root.revisionId);assert.deepEqual(f.root,old);assert.equal(await verify(ref,()=>f.resolve(ref)),true);
  assert.deepEqual(core.normalizeStoryboardMessageReference(copy(ref)),ref);
  assert.deepEqual(core.sanitizeStoryboardSnapshot(job(ref,'new')).messageRef,ref);
  assert.deepEqual(core.createStoryboardWorkflowTicket({messageRef:ref}).messageRef,ref);
  assert.doesNotMatch(JSON.stringify(ref),/Alice cooks|Scene 2|prompt|apiKey/);
});

test('ordinary v1 roots remain compatible, while missing, downgraded, nested and future family contracts fail closed',async()=>{
  const f=await fixture(),fresh=await f.advance(),ref=await bind(fresh,f.root,'st-user:test',f.resolve);
  assert.equal(normalize(f.root).invalid,undefined);
  for(const mutate of [r=>delete r.stream.family,r=>r.stream.version=1,r=>r.stream.version=3,r=>r.stream.family.version=2,
    r=>r.stream.family.reference=copy(ref),r=>r.stream.family.reference.chatKey='other',r=>r.stream.family.reference.name='Bob',
    r=>r.stream.family.reference.swipeId=1,r=>r.stream.family.namespace='st-user: ',r=>r.stream.family.reference.baseSendDate={secret:'payload'},
    r=>r.stream.family.reference.updatedAt='tomorrow',r=>r.stream.family.reference.lastKnownFloor=-1]){
    const bad=copy(ref);mutate(bad);assert.equal(normalize(bad).invalid,true);await assert.rejects(verify(bad,()=>f.resolve(bad)));
  }
});

test('source/budget binding requires an actually saved append path, not a matching text, floor, name or callback',async()=>{
  const f=await fixture(),fresh=await f.advance(),links=f.metadata.storyboardContinuations;
  delete f.metadata.storyboardContinuations;
  await assert.rejects(bind(fresh,f.root,'st-user:test',f.resolve));
  f.metadata.storyboardContinuations=links;
  await assert.rejects(bind(fresh,f.root,'st-user:other',f.resolve));
  await assert.rejects(bind(fresh,f.root,'st-user:test'));
  const ordinary=core.createStoryboardMessageReference({message:f.message,chatKey:'chat',floor:0});
  await assert.rejects(bind(fresh,ordinary,'st-user:test',f.resolve));
});

test('pending unsaved append links cannot authorize a family and a failed save leaves no binding',async()=>{
  const f=await fixture();
  await assert.rejects(f.advance(async()=>{
    const fresh=await f.source();await assert.rejects(bind(fresh,f.root,'st-user:test',f.resolve));throw Error('save failed');
  }),/save failed/);
  assert.equal(f.metadata.storyboardContinuations,undefined);
  await assert.rejects(bind(await f.source(),f.root,'st-user:test',f.resolve));
});

test('multiple continuations flatten to the original root without mutating old source proofs or nesting payloads',async()=>{
  const f=await fixture(),first=await bind(await f.advance(),f.root,'st-user:test',f.resolve),before=copy(first);
  const second=await bind(await f.advance(),first,'st-user:test',f.resolve);
  assert.deepEqual(budget(second),f.root);assert.deepEqual(first,before);
  assert.equal(second.stream.family.reference.stream.version,1);assert.equal(second.stream.family.reference.stream.family,undefined);
  await verify(first,()=>f.resolve(first));await verify(second,()=>f.resolve(second));
  assert.deepEqual((await createImageAdmissionIdentity(job(first,'a'),'st-user:test')).scope,(await createImageAdmissionIdentity(job(second,'b'),'st-user:test')).scope);
});

test('the original append path must pass through the new source generation rather than merely end at the current message',async()=>{
  const f=await fixture(),first=await f.advance(),second=await f.advance(),valid=await bind(second,f.root,'st-user:test',f.resolve);
  const bad=copy(valid);bad.stream.generation=first.stream.generation;bad.stream.generationKey=first.stream.generationKey;
  bad.revisionId=first.revisionId; // Deliberately keep the second message key.
  assert.equal(f.resolve(bad).state,'stale');await assert.rejects(verify(bad,()=>f.resolve(bad)));
  const broken=copy(valid);broken.stream.family.reference.stream.generation.startedAt='unrelated';
  assert.equal(f.resolve(broken).state,'stale');
});

test('both old root and fresh body SHA proofs are required before any reservation',async()=>{
  const f=await fixture(),ref=await bind(await f.advance(),f.root,'st-user:test',f.resolve);
  for(const mutate of [r=>r.stream.family.reference.stream.prefixDigest='a'.repeat(64),r=>r.stream.prefixDigest='b'.repeat(64)]){
    const bad=copy(ref);mutate(bad);const {runtime,ledger}=f.runtime();
    await assert.rejects(runtime.admit(job(bad,'bad'),{maxAutomatic:2}));assert.equal(ledger.rows.size,0);await runtime.close();
  }
  const {runtime,ledger}=f.runtime();f.metadata.storyboardContinuations[0].digest='c'.repeat(64);
  await assert.rejects(runtime.admit(job(ref,'tampered-link'),{maxAutomatic:2}));assert.equal(ledger.rows.size,0);
});

test('a family cannot use another account budget even when source resolution itself has an active matching reference',async()=>{
  const f=await fixture(),ref=await bind(await f.advance(),f.root,'st-user:test',f.resolve);
  assert.throws(()=>budget(ref,'st-user:other'));
  await assert.rejects(createImageAdmissionIdentity(job(ref,'new'),'st-user:other'));
  const {runtime,ledger}=f.runtime(store(),'st-user:other');await assert.rejects(runtime.admit(job(ref,'other'),{maxAutomatic:2}));
  assert.equal(ledger.rows.size,0);await runtime.close();
});

test('accepted old work and a new continued shot share the original automatic limit in the actual admission runtime',async()=>{
  const f=await fixture(),{runtime,ledger}=f.runtime(),first=job(f.root,'first');
  await runtime.admit(first,{maxAutomatic:2});await runtime.beforeSubmit(first);await runtime.settle(first,'accepted');
  const ref=await bind(await f.advance(),f.root,'st-user:test',f.resolve),second=job(ref,'second');
  await runtime.admit(second,{maxAutomatic:2});await runtime.beforeSubmit(second);await runtime.settle(second,'succeeded');
  assert.equal(second.imageAdmission.messageKey,first.imageAdmission.messageKey);assert.equal(second.imageAdmission.revisionId,first.imageAdmission.revisionId);
  assert.equal(second.messageRef.messageKey,ref.messageKey);assert.equal(ledger.rows.size,1);
  await assert.rejects(runtime.admit(job(ref,'third'),{maxAutomatic:2}),{code:'image_attempt_budget_exhausted'});await runtime.close();
});

test('cross-device history restores mixed original and continued successful/unknown slots without a fresh budget',async()=>{
  const f=await fixture(),ref=await bind(await f.advance(),f.root,'st-user:test',f.resolve),first=job(f.root,'first'),second=job(ref,'second');
  const original=f.runtime();
  for(const [item,outcome] of [[first,'succeeded'],[second,'unknown']]){
    await original.runtime.admit(item,{maxAutomatic:2});await original.runtime.beforeSubmit(item);await original.runtime.settle(item,outcome);
  }
  const history=[{id:'log-first',status:'success',snapshot:copy(first)},{id:'log-second',status:'failed',submissionState:'unknown',snapshot:copy(second)}];
  const next=await bind(await f.advance(),second.messageRef,'st-user:test',f.resolve),identity=await createImageAdmissionIdentity(job(next,'third'),'st-user:test');
  const seeds=await createImageHistorySeeds(history,identity);assert.equal(seeds.length,2);assert.ok(seeds.every(row=>row.automaticSlot));
  const restored=f.runtime();await assert.rejects(restored.runtime.admit(job(next,'third'),{maxAutomatic:2,history}),{code:'image_attempt_budget_exhausted'});
  assert.equal(restored.ledger.rows.size,1);await original.runtime.close();await restored.runtime.close();
});

test('known manual supplements do not spend automatic continuation slots and old retry identities remain stable',async()=>{
  const f=await fixture(),ref=await bind(await f.advance(),f.root,'st-user:test',f.resolve),{runtime}=f.runtime();
  const manual={...job(ref,'manual'),automatic:false,manualSupplement:true};await runtime.admit(manual,{maxAutomatic:1});await runtime.beforeSubmit(manual);await runtime.settle(manual,'succeeded');
  const automatic=job(ref,'automatic');await runtime.admit(automatic,{maxAutomatic:1});await runtime.beforeSubmit(automatic);await runtime.settle(automatic,'succeeded');
  const redraw={...copy(automatic),id:'redraw',automatic:false,prompt:'changed artist',attempt:2};
  const id=await createImageAdmissionIdentity(redraw,'st-user:test');assert.equal(id.logicalShotId,automatic.imageAdmission.logicalShotId);
  await runtime.admit(redraw,{maxAutomatic:1});assert.equal(redraw.imageAdmission.automaticSlot,true);await runtime.close();
});

test('a changed family or removed append proof after admission cannot submit a reserved job',async()=>{
  const f=await fixture(),ref=await bind(await f.advance(),f.root,'st-user:test',f.resolve);
  for(const change of ['receipt','links','body']){
    const {runtime}=f.runtime(),value=job(ref,change);await runtime.admit(value,{maxAutomatic:2});
    const links=f.metadata.storyboardContinuations,text=f.message.mes;
    if(change==='receipt')value.messageRef.stream.family.reference.messageKey='another';
    if(change==='links')delete f.metadata.storyboardContinuations;
    if(change==='body')f.message.mes='Different\n\n';
    await assert.rejects(runtime.beforeSubmit(value));f.metadata.storyboardContinuations=links;f.message.mes=text;await runtime.close();
  }
});

test('invalid relevant restored contracts stop reconstruction rather than silently discount an old slot',async()=>{
  const f=await fixture(),ref=await bind(await f.advance(),f.root,'st-user:test',f.resolve),identity=await createImageAdmissionIdentity(job(ref,'new'),'st-user:test');
  for(const mutate of [r=>r.stream.version=99,r=>r.stream.family.namespace='st-user:other',r=>delete r.stream.family.reference.stream.prefixDigest]){
    const bad=copy(ref);mutate(bad);
    await assert.rejects(createImageHistorySeeds([{id:'old',status:'success',snapshot:job(bad,'old')}],identity));
  }
  const foreign=job(ref,'elsewhere');foreign.chatKey='another-chat';foreign.messageRef.stream.version=99;
  assert.deepEqual(await createImageHistorySeeds([{id:'unrelated',status:'success',snapshot:foreign}],identity),[]);
});

test('family normalization strips payload extras and old shot moments, preserving only the new shot moment',async()=>{
  const f=await fixture(),root=copy(f.root);root.secret='do not persist';root.stream.payload='large';
  root.stream.moment={version:1,paragraphId:'P1',branchId:'present',layer:'present',quote:'Alice',subject:'Alice',start:0,end:5,insertAfter:'P1',sourceIds:['P1']};
  const ref=await bind(await f.advance(),root,'st-user:test',f.resolve);
  assert.equal(ref.stream.family.reference.secret,undefined);assert.equal(ref.stream.family.reference.stream.payload,undefined);
  assert.equal(ref.stream.family.reference.stream.moment,undefined);
  assert.deepEqual(budget(ref),f.root);
});

test('the frozen source/family pair is checked again across account and ledger awaits before dispatch',async()=>{
  for(const phase of ['account','ledger']){
    const f=await fixture(),ref=await bind(await f.advance(),f.root,'st-user:test',f.resolve),value=job(ref,'original'),ledger=store();
    let reads=0,begins=0;const oldBegin=ledger.begin;
    const replace=()=>{value.messageRef.updatedAt++;}; // Still valid prose, but not the admitted immutable request.
    ledger.begin=async(...args)=>{begins++;const result=await oldBegin(...args);if(phase==='ledger')replace();return result;};
    const runtime=createImageAdmission({store:ledger,ownerId:'page',resolveSource:item=>f.resolve(item.messageRef),
      account:async()=>{if(++reads===2&&phase==='account')replace();return 'st-user:test';}});
    await runtime.admit(value,{maxAutomatic:2});await assert.rejects(runtime.beforeSubmit(value),{code:'image_attempt_identity'});
    assert.equal(begins,phase==='account'?0:1);await runtime.close();
  }
});

test('resolving a family in a high-floor chat never reads unrelated message prose',async()=>{
  const f=await fixture(),ref=await bind(await f.advance(),f.root,'st-user:test',f.resolve);
  for(let i=1;i<5000;i++)f.context.chat.push({name:'Other',send_date:`unrelated-${i}`,gen_started:`unrelated-${i}`,
    get mes(){assert.fail('unrelated text read');}});
  assert.equal(f.resolve(ref).state,'active');await verify(ref,()=>f.resolve(ref));
});
