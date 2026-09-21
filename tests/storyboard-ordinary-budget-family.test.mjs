import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import * as core from '../qianmu-storyboard.js';
import {captureStoryboardContinuation,saveStoryboardContinuation} from '../qianmu-storyboard-continuation.js';
import {captureStoryboardStreamFrame,createStoryboardStreamMessageReference} from '../qianmu-storyboard-stream-source.js?v=1.59.256';
import {bindStoryboardStreamBudgetFamily as bind,storyboardStreamBudgetReference as budget,normalizeStoryboardStreamReference as normalize,
  verifyStoryboardStreamReference as verify,storyboardStreamDigest as digest,storyboardStreamFingerprint as fingerprint} from '../qianmu-storyboard-stream-reference.js?v=1.59.256';
import {storyboardContinuationIdentityInput} from '../qianmu-storyboard-continuation-proof.js?v=1.59.256';
import {createImageAdmission,createImageAdmissionIdentity,createImageHistorySeeds} from '../qianmu-image-admission.js';
import {imageAttemptScopeKey,claimImageAttempt,importImageAttempts,beginImageAttempt,settleImageAttempt} from '../qianmu-image-attempts.js';
const copy=value=>JSON.parse(JSON.stringify(value));
const namespace='st-user:test';
const job=(ref,id)=>({id,chatKey:ref.chatKey,messageRef:copy(ref),automatic:true,target:'floor',source:'novel',profile:{count:'1'},prompt:id});
function storage(){
  const rows=new Map(),now=1780000000000;
  const run=(scope,fn)=>{const key=imageAttemptScopeKey(scope),result=fn(rows.get(key));rows.set(key,copy(result.ledger));return result;};
  return {rows,close(){},claim:async(scope,input,seeds=[])=>run(scope,raw=>claimImageAttempt(importImageAttempts(raw,scope,seeds,now),scope,input,now)),
    begin:async(scope,input)=>run(scope,raw=>beginImageAttempt(raw,scope,input,now)),settle:async(scope,input)=>run(scope,raw=>settleImageAttempt(raw,scope,input,now))};
}
async function fixture(){
  const message={mes:'Alice cooks.\n\n',name:'Alice',send_date:'day-1',gen_started:'generation-1',swipe_id:0};
  const context={chatId:'chat',characterId:0,characters:[{chat:'chat',avatar:'Alice.png'}],chat:[message],chatMetadata:{story_director_liminale:{}},eventSource:new EventEmitter()};
  const metadata=context.chatMetadata.story_director_liminale,account=async()=>namespace;
  const options={getContext:()=>context,epoch:()=>0,resolveNamespace:account,isCurrent:()=>true,floor:0,createReference:core.createStoryboardMessageReference};
  const root=core.createStoryboardMessageReference({message,chatKey:'chat',floor:0,now:1});
  const source=async()=>{const frame=await captureStoryboardStreamFrame(options);try{return await createStoryboardStreamMessageReference(frame);}finally{frame.close();}};
  const resolve=ref=>core.resolveStoryboardMessageReference(ref,context.chat,{chatKey:'chat',metadata:context.chatMetadata,namespace});
  let generation=1;
  return {message,context,metadata,root,source,resolve,
    async advance(save=async()=>{}){
      const handle=captureStoryboardContinuation({...options,type:'continue'});
      generation++;message.mes+=`Scene ${generation}.\n\n`;message.send_date=`day-${generation}`;message.gen_started=`generation-${generation}`;
      message.swipe_info=[{send_date:message.send_date,gen_started:message.gen_started,extra:{}}];
      try{await saveStoryboardContinuation(handle,account,metadata,save);}finally{handle.close();}
      return source();
    },
    runtime(ledger=storage(),owner=namespace){return {ledger,runtime:createImageAdmission({store:ledger,ownerId:'page',account:async()=>owner,resolveSource:value=>resolve(value.messageRef)})};},
  };
}

test('v3 keeps an ordinary original budget separate from the fresh stream source and survives actual archive normalizers',async()=>{
  const f=await fixture(),before=copy(f.root),fresh=await f.advance(),ref=await bind(fresh,f.root,namespace,f.resolve);
  assert.equal(ref.stream.version,3);assert.equal(ref.stream.family.version,2);assert.deepEqual(budget(ref),before);
  assert.equal(ref.messageKey,fresh.messageKey);assert.equal(ref.revisionId,fresh.revisionId);assert.notEqual(ref.messageKey,before.messageKey);
  assert.deepEqual(core.normalizeStoryboardMessageReference(copy(ref)),ref);assert.deepEqual(core.sanitizeStoryboardSnapshot(job(ref,'new')).messageRef,ref);
  assert.deepEqual(core.createStoryboardWorkflowTicket({messageRef:ref}).messageRef,ref);assert.deepEqual(f.root,before);
  assert.equal(await verify(ref,()=>f.resolve(ref)),true);assert.doesNotMatch(JSON.stringify(ref),/Alice cooks|Scene 2|apiKey/);
});

test('ordinary budget contracts reject missing, nested, downgraded, foreign and malformed roots',async()=>{
  const f=await fixture(),ref=await bind(await f.advance(),f.root,namespace,f.resolve);
  for(const mutate of [r=>delete r.stream.family,r=>r.stream.version=2,r=>r.stream.version=1,r=>r.stream.version=99,r=>r.stream.family.version=1,
    r=>r.stream.family.reference=copy(ref),r=>r.stream.family.reference.stream={},r=>r.stream.family.reference.revisionId='stream:fake',
    r=>r.stream.family.reference.revisionHash='invalid',r=>r.stream.family.reference.baseSendDate='',r=>r.stream.family.reference.role='user',
    r=>r.stream.family.reference.chatKey='other',r=>r.stream.family.reference.name='Bob',r=>r.stream.family.reference.swipeId=1,
    r=>r.stream.family.reference.lastKnownFloor=-1,r=>r.stream.family.reference.createdAt='bad',r=>r.stream.family.namespace='st-user: ']){
    const bad=copy(ref);mutate(bad);assert.equal(normalize(bad).invalid,true);await assert.rejects(verify(bad,()=>f.resolve(bad)));
  }
});

test('ordinary roots require a saved exact v2 source bridge; v1 bridges and same-floor guesses cannot bind',async()=>{
  const f=await fixture(),fresh=await f.advance(),links=copy(f.metadata.storyboardContinuations);
  delete f.metadata.storyboardContinuations;await assert.rejects(bind(fresh,f.root,namespace,f.resolve));
  f.metadata.storyboardContinuations=copy(links);f.metadata.storyboardContinuations[0].version=1;delete f.metadata.storyboardContinuations[0].source;
  f.metadata.storyboardContinuations[0].id=await digest(storyboardContinuationIdentityInput(f.metadata.storyboardContinuations[0]));
  await assert.rejects(bind(fresh,f.root,namespace,f.resolve));f.metadata.storyboardContinuations=links;
  const current=core.createStoryboardMessageReference({message:f.message,chatKey:'chat',floor:0});
  await assert.rejects(bind(fresh,current,namespace,f.resolve));await assert.rejects(bind(fresh,{...f.root,revisionId:'12345678'},namespace,f.resolve));
});

test('pending and failed continue saves do not expose a usable ordinary budget family',async()=>{
  const f=await fixture();await assert.rejects(f.advance(async()=>{
    await assert.rejects(bind(await f.source(),f.root,namespace,f.resolve));throw Error('save failed');
  }),/save failed/);assert.equal(f.metadata.storyboardContinuations,undefined);
  await assert.rejects(bind(await f.source(),f.root,namespace,f.resolve));
});

test('repeated continues flatten to the same ordinary root without changing previous requests',async()=>{
  const f=await fixture(),first=await bind(await f.advance(),f.root,namespace,f.resolve),before=copy(first);
  const next=await bind(await f.advance(),first,namespace,f.resolve);
  assert.deepEqual(budget(next),f.root);assert.equal(next.stream.family.reference.stream,undefined);assert.deepEqual(first,before);
  await verify(first,()=>f.resolve(first));await verify(next,()=>f.resolve(next));
  assert.deepEqual((await createImageAdmissionIdentity(job(next,'new'),namespace)).scope,(await createImageAdmissionIdentity(job(f.root,'old'),namespace)).scope);
});

test('both the original v2 bridge SHA and the fresh prefix SHA are mandatory before reservation',async()=>{
  for(const field of ['digest','id','source','prefix']){
    const f=await fixture(),ref=await bind(await f.advance(),f.root,namespace,f.resolve),{runtime,ledger}=f.runtime();
    const link=f.metadata.storyboardContinuations[0];
    if(field==='source'){link.source.revisionId='12345678';ref.stream.family.reference.revisionId='12345678';}
    else if(field==='prefix')ref.stream.prefixDigest='a'.repeat(64);else link[field]='a'.repeat(64);
    assert.equal(f.resolve(ref).state,'active');await assert.rejects(runtime.admit(job(ref,field),{maxAutomatic:2}));assert.equal(ledger.rows.size,0);await runtime.close();
  }
});

test('original ordinary successes and continued new shots spend one existing automatic budget',async()=>{
  const f=await fixture(),{runtime,ledger}=f.runtime(),old=job(f.root,'old');
  await runtime.admit(old,{maxAutomatic:2});await runtime.beforeSubmit(old);await runtime.settle(old,'succeeded');
  const ref=await bind(await f.advance(),f.root,namespace,f.resolve),next=job(ref,'next');
  await runtime.admit(next,{maxAutomatic:2});await runtime.beforeSubmit(next);await runtime.settle(next,'accepted');
  assert.equal(ledger.rows.size,1);assert.equal(next.imageAdmission.messageKey,old.imageAdmission.messageKey);assert.equal(next.messageRef.messageKey,ref.messageKey);
  await assert.rejects(runtime.admit(job(ref,'third'),{maxAutomatic:2}),{code:'image_attempt_budget_exhausted'});await runtime.close();
});

test('cross-device reconstruction counts ordinary successes plus continued unknown results in the original budget',async()=>{
  const f=await fixture(),a=f.runtime(),old=job(f.root,'old');await a.runtime.admit(old,{maxAutomatic:2});await a.runtime.beforeSubmit(old);await a.runtime.settle(old,'succeeded');
  const next=job(await bind(await f.advance(),f.root,namespace,f.resolve),'next');await a.runtime.admit(next,{maxAutomatic:2});await a.runtime.beforeSubmit(next);await a.runtime.settle(next,'unknown');
  const history=[{id:'old',status:'success',snapshot:copy(old)},{id:'next',status:'failed',submissionState:'unknown',snapshot:copy(next)}];
  const third=job(await bind(await f.advance(),next.messageRef,namespace,f.resolve),'third'),identity=await createImageAdmissionIdentity(third,namespace);
  assert.equal((await createImageHistorySeeds(history,identity)).length,2);const b=f.runtime();
  await assert.rejects(b.runtime.admit(third,{maxAutomatic:2,history}),{code:'image_attempt_budget_exhausted'});
  assert.equal(b.ledger.rows.size,1);await a.runtime.close();await b.runtime.close();
});

test('ordinary-root manual supplements stay outside automatic slots and redraws retain their old logical slot',async()=>{
  const f=await fixture(),ref=await bind(await f.advance(),f.root,namespace,f.resolve),{runtime}=f.runtime();
  const manual={...job(ref,'manual'),automatic:false,manualSupplement:true};await runtime.admit(manual,{maxAutomatic:1});await runtime.beforeSubmit(manual);await runtime.settle(manual,'succeeded');
  const auto=job(ref,'automatic');await runtime.admit(auto,{maxAutomatic:1});await runtime.beforeSubmit(auto);await runtime.settle(auto,'succeeded');
  const redraw={...copy(auto),id:'redraw',automatic:false,prompt:'new style',attempt:2};await runtime.admit(redraw,{maxAutomatic:1});
  assert.equal(redraw.imageAdmission.logicalShotId,auto.imageAdmission.logicalShotId);assert.equal(redraw.imageAdmission.automaticSlot,true);await runtime.close();
});

test('a different account cannot bind or restore the ordinary family even if its source callback reports active',async()=>{
  const f=await fixture(),fresh=await f.advance(),ref=await bind(fresh,f.root,namespace,f.resolve);
  await assert.rejects(bind(fresh,f.root,'st-user:other',f.resolve));assert.throws(()=>budget(ref,'st-user:other'));
  const {runtime,ledger}=f.runtime(storage(),'st-user:other');await assert.rejects(runtime.admit(job(ref,'wrong'),{maxAutomatic:2}));assert.equal(ledger.rows.size,0);await runtime.close();
});

test('removed links or changed source/root after admission cannot dispatch the reserved request',async()=>{
  for(const phase of ['link','source','root']){
    const f=await fixture(),ref=await bind(await f.advance(),f.root,namespace,f.resolve),{runtime}=f.runtime(),item=job(ref,phase);
    await runtime.admit(item,{maxAutomatic:2});
    if(phase==='link')delete f.metadata.storyboardContinuations;else if(phase==='source')f.message.mes='Changed\n\n';else item.messageRef.stream.family.reference.updatedAt++;
    await assert.rejects(runtime.beforeSubmit(item));await runtime.close();
  }
});

test('original path must pass through the exact new generation and cannot fund a shorter prefix',async()=>{
  const f=await fixture(),first=await f.advance(),second=await f.advance(),ref=await bind(second,f.root,namespace,f.resolve);
  const bad=copy(ref);bad.stream.generation=first.stream.generation;bad.stream.generationKey=first.stream.generationKey;bad.revisionId=first.revisionId;
  assert.equal(f.resolve(bad).state,'stale');await assert.rejects(verify(bad,()=>f.resolve(bad)));
  const short=copy(ref);short.stream.prefixLength=3;short.stream.prefixHash=fingerprint(f.message.mes.slice(0,3));short.revisionHash=short.stream.prefixHash;
  short.stream.prefixDigest=await digest(f.message.mes.slice(0,3));
  assert.notEqual(f.resolve(short).state,'active');
});

test('ordinary-root family resolution remains metadata-only for unrelated high-floor messages',async()=>{
  const f=await fixture(),ref=await bind(await f.advance(),f.root,namespace,f.resolve);
  for(let i=1;i<5000;i++)f.context.chat.push({name:'Other',send_date:`other-${i}`,gen_started:`other-${i}`,get mes(){assert.fail('unrelated body read');}});
  await verify(ref,()=>f.resolve(ref));f.context.chat.unshift({is_user:true,mes:'unrelated',send_date:'earlier'});
  assert.equal(f.resolve(ref).floor,1);await verify(ref,()=>f.resolve(ref));
});

test('budget serialization strips unrelated payload without mutating the original and verification detects async root changes',async()=>{
  const f=await fixture(),root={...f.root,secret:'do not save'},ref=await bind(await f.advance(),root,namespace,f.resolve);
  assert.equal(ref.stream.family.reference.secret,undefined);assert.equal(root.secret,'do not save');
  let calls=0;await assert.rejects(verify(ref,()=>{if(++calls===3)ref.stream.family.reference.updatedAt++;return f.resolve(ref);}));
});

test('gallery sorting can read a new ordinary-family record without assuming its root has a stream generation',async()=>{
  const f=await fixture(),ref=await bind(await f.advance(),f.root,namespace,f.resolve);
  ref.stream.moment={version:1,paragraphId:'P2',branchId:'present',layer:'present',quote:'Scene 2.',subject:'scene',start:0,end:8,insertAfter:'P2',sourceIds:['P2']};
  const record={id:'new',chatKey:'chat',swipeId:0,messageRef:ref,url:'/synthetic.png',createdAt:2,
    inlineOrder:{version:1,batchId:`story-${f.root.revisionId}`,batchStartedAt:1,shotIndex:1,requestIndex:1}};
  assert.deepEqual(core.sortStoryboardInlineRecords([record]),[record]);
});

test('a family bridge changed between nested and final source checks is not accepted by the outer verifier',async()=>{
  const f=await fixture(),ref=await bind(await f.advance(),f.root,namespace,f.resolve);let calls=0;
  await assert.rejects(verify(ref,()=>{
    if(++calls===4)f.metadata.storyboardContinuations[0].createdAt++;
    return f.resolve(ref);
  }));assert.equal(calls,4);
});
