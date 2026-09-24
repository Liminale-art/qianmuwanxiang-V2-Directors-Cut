import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import vm from 'node:vm';
import {captureStoryboardStreamFrame,createStoryboardStreamMessageReference} from '../qianmu-storyboard-stream-source.js?v=1.59.362';
import {createStoryboardMessageReference,normalizeStoryboardMessageReference,resolveStoryboardMessageReference,sanitizeStoryboardSnapshot,createStoryboardWorkflowTicket} from '../qianmu-storyboard.js';
import {verifyStoryboardStreamReference,storyboardStreamFingerprint,storyboardStreamDigest} from '../qianmu-storyboard-stream-reference.js?v=1.59.362';
import {createImageAdmission,createImageAdmissionIdentity,createImageHistorySeeds} from '../qianmu-image-admission.js';
import {imageAttemptScopeKey,claimImageAttempt,importImageAttempts,beginImageAttempt,continueImageAttempt,settleImageAttempt,summarizeImageAttempts} from '../qianmu-image-attempts.js';
import {storyboardFunctionSource} from './helpers/storyboard-form-fixture.mjs';
const clone=value=>JSON.parse(JSON.stringify(value));
function fixture(){
  const context={chatId:'chat-a',characterId:0,characters:[{chat:'chat-a',avatar:'Alice.png'}],chatMetadata:{story_director_liminale:{}},eventSource:new EventEmitter(),
    chat:[{mes:'Alice cooks.\n\nShe reaches',name:'Alice',send_date:'date-1',gen_started:'generation-1',swipe_id:0}]};
  const options={getContext:()=>context,epoch:()=>0,resolveNamespace:async()=>'st-user:test',isCurrent:()=>true,floor:0};
  let ref;
  return {context,options,get ref(){return ref;},async capture(){const frame=await captureStoryboardStreamFrame(options);ref=await createStoryboardStreamMessageReference(frame);frame.close();return ref;},
    resolve(value=ref){return resolveStoryboardMessageReference(value,context.chat,{chatKey:value.chatKey});},
    verify(value=ref){return verifyStoryboardStreamReference(value,()=>this.resolve(value));}};
}
function store(){
  const rows=new Map(),now=1780000000000;
  const run=(scope,fn)=>{const key=imageAttemptScopeKey(scope),result=fn(rows.get(key));rows.set(key,clone(result.ledger));return result;};
  return {rows,close(){},claim:async(scope,input,seeds=[])=>run(scope,raw=>claimImageAttempt(importImageAttempts(raw,scope,seeds,now),scope,input,now)),
    begin:async(scope,input)=>run(scope,raw=>beginImageAttempt(raw,scope,input,now)),continue:async(scope,input)=>run(scope,raw=>continueImageAttempt(raw,scope,input,now)),
    settle:async(scope,input)=>run(scope,raw=>settleImageAttempt(raw,scope,input,now)),inspect:scope=>summarizeImageAttempts(rows.get(imageAttemptScopeKey(scope)),scope,now)};
}
const job=(ref,id='first',prompt='Alice cooks')=>({id,chatKey:ref.chatKey,messageRef:ref,automatic:true,target:'floor',source:'novel',profile:{count:'1'},prompt});

test('growing frames share one generation identity; archived proofs accept append after frame disposal and JSON round-trip',async()=>{
  const f=fixture(),first=await f.capture();f.context.chat[0].mes+=' for a cup.\n\nNext';const second=await f.capture();
  assert.equal(first.revisionId,second.revisionId);assert.notEqual(first.revisionHash,second.revisionHash);
  assert.ok(second.stream.prefixLength>first.stream.prefixLength);assert.equal(await f.verify(clone(first)),true);assert.equal(await f.verify(second),true);
  assert.equal(f.context.eventSource.eventNames().length,0);assert.doesNotMatch(JSON.stringify(first),/Alice cooks|She reaches/);
  assert.deepEqual(normalizeStoryboardMessageReference(clone(first)),first);
  assert.deepEqual(sanitizeStoryboardSnapshot(job(first)).messageRef,first);assert.deepEqual(createStoryboardWorkflowTicket({messageRef:first}).messageRef,first);
});

test('serialized closed-paragraph proof survives terminal whitespace cleanup but is still strict on its content',async()=>{
  const f=fixture();f.context.chat[0].mes='Alice cooks.\r\n \t\r\n\t';
  const ref=normalizeStoryboardMessageReference(clone(await f.capture()));
  assert.equal(ref.stream.closedParagraph,true);assert.equal(ref.stream.prefixLength,'Alice cooks.'.length);
  f.context.chat[0].mes=f.context.chat[0].mes.trimEnd();assert.equal(f.resolve(ref).state,'active');assert.equal(await f.verify(ref),true);
  f.context.chat[0].mes='Alice cooks!';assert.equal(f.resolve(ref).state,'stale');await assert.rejects(f.verify(ref));
});

test('archived closed paragraphs reject joined continuations but accept a new separate paragraph',async()=>{
  const f=fixture(),ref=await f.capture();
  for(const suffix of [' More words','\nMore words','\r\nMore words','More words']){
    f.context.chat[0].mes='Alice cooks.'+suffix;assert.equal(f.resolve(ref).state,'stale');await assert.rejects(f.verify(ref));
  }
  for(const suffix of ['', ' \t', '\n', '\n\nNext', ' \r\n \t\r\nNext']){
    f.context.chat[0].mes='Alice cooks.'+suffix;assert.equal(f.resolve(ref).state,'active');await f.verify(ref);
  }
});

test('invalid boundary markers and a mixed partial/complete proof cannot normalize into a looser reference',async()=>{
  const f=fixture(),ref=await f.capture();
  for(const marker of [false,1,'true',null]){
    const bad=clone(ref);bad.stream.closedParagraph=marker;
    assert.equal(normalizeStoryboardMessageReference(bad).stream.invalid,true);await assert.rejects(f.verify(bad));
  }
  const mixed=clone(ref);mixed.stream.complete=true;assert.equal(normalizeStoryboardMessageReference(mixed).stream.invalid,true);
});

test('older exact-prefix proofs remain strict; the new cleanup rule is not retroactively guessed for them',async()=>{
  const f=fixture();f.context.chat[0].mes='Alice cooks.\n\n';
  const old=clone(await f.capture()),prefix=f.context.chat[0].mes;delete old.stream.closedParagraph;
  old.revisionHash=storyboardStreamFingerprint(prefix);Object.assign(old.stream,{prefixLength:prefix.length,prefixHash:old.revisionHash,prefixDigest:await storyboardStreamDigest(prefix)});
  assert.equal(await f.verify(old),true);f.context.chat[0].mes=prefix.trimEnd();assert.equal(f.resolve(old).state,'stale');await assert.rejects(f.verify(old));
});

test('a reserved request cannot drop its closed-paragraph marker and then submit a joined continuation',async()=>{
  const f=fixture(),ref=clone(await f.capture()),runtime=createImageAdmission({store:store(),account:async()=>'st-user:test',ownerId:'page',resolveSource:j=>f.resolve(j.messageRef)});
  const a=job(ref);await runtime.admit(a,{maxAutomatic:3});
  f.context.chat[0].mes='Alice cooks.\n\n';f.context.chat[0].mes=f.context.chat[0].mes.trimEnd();await runtime.beforeSubmit(a);
  f.context.chat[0].mes+=' but this is a dream';delete a.messageRef.stream.closedParagraph;
  await assert.rejects(runtime.beforeSubmit(a),{code:'image_attempt_identity'});
});

test('a paragraph joined during asynchronous proof verification cannot pass its final source guard',async()=>{
  const f=fixture(),ref=await f.capture();let calls=0;
  await assert.rejects(verifyStoryboardStreamReference(ref,()=>{if(calls++)f.context.chat[0].mes='Alice cooks.\nShe reaches';return f.resolve(ref);}));
});

for(const [label,change,state] of [
  ['prefix edit',m=>m.mes='Bob cooks.\n\nShe reaches','stale'],['prefix shrink',m=>m.mes='Alice','stale'],
  ['new generation',m=>m.gen_started='generation-2','stale'],['role change',m=>m.is_user=true,'orphaned'],
  ['swipe change',m=>m.swipe_id=1,'inactive_swipe'],['active generation',m=>m.extra={gen_id:'new'},'orphaned'],
])test(`${label} cannot dispatch an archived stream reference`,async()=>{
  const f=fixture(),ref=await f.capture();change(f.context.chat[0]);assert.equal(f.resolve(ref).state,state);await assert.rejects(f.verify(ref),{code:'storyboard_stream_source'});
});

test('a new generation has another budget identity, while the ordinary completed-floor contract stays strict on any append',async()=>{
  const f=fixture(),first=await f.capture(),ordinary=createStoryboardMessageReference({message:f.context.chat[0],chatKey:first.chatKey,floor:0});
  f.context.chat[0].mes+='!';assert.equal(f.resolve(ordinary).state,'stale');assert.equal(await f.verify(first),true);
  f.context.chat[0].gen_started='next-generation';const second=await f.capture();assert.notEqual(first.revisionId,second.revisionId);
});

test('malformed or stripped stream metadata remains explicitly invalid through normalizers, never an ordinary permissive reference',async()=>{
  const f=fixture(),ref=await f.capture();
  for(const change of [r=>delete r.stream,r=>r.stream=null,r=>r.stream.version=2,r=>r.stream.prefixLength=0,r=>r.stream.prefixLength=200001,
    r=>r.stream.generation.unexpected=true,r=>r.stream.generation.startedAt='',r=>r.revisionHash='ffffffff',r=>r.swipeId=10001]){
    const broken=clone(ref);change(broken);const normalized=normalizeStoryboardMessageReference(broken);
    assert.equal(normalized.stream.invalid,true);assert.equal(f.resolve(normalized).state,'stale');await assert.rejects(f.verify(normalized));
    await assert.rejects(createImageAdmissionIdentity(job(normalized),'st-user:test'),{code:'image_attempt_identity'});
  }
});

test('both strong digests are checked, not just synchronous UI fingerprints or self-consistent generation labels',async()=>{
  const f=fixture(),ref=await f.capture();
  for(const field of ['prefixDigest','generationKey']){
    const forged=clone(ref);forged.stream[field]='a'.repeat(64);if(field==='generationKey')forged.revisionId=`stream:${forged.stream.generationKey}`;
    assert.equal(f.resolve(forged).state,'active');await assert.rejects(f.verify(forged),{code:'storyboard_stream_source'});
  }
  await assert.rejects(verifyStoryboardStreamReference(ref),{code:'storyboard_stream_source'});
  await assert.rejects(verifyStoryboardStreamReference(ref,()=>resolveStoryboardMessageReference(ref,f.context.chat,{chatKey:'another-chat'})));
  assert.equal(await verifyStoryboardStreamReference({messageKey:'ordinary',revisionId:'ordinary'}),true);
});

test('source changes during async digest verification or replacement by a lookalike cannot pass the final guard',async()=>{
  const f=fixture(),ref=await f.capture();let calls=0;
  await assert.rejects(verifyStoryboardStreamReference(ref,()=>{if(calls++)f.context.chat[0]={...f.context.chat[0]};return f.resolve(ref);}));
});

test('high-floor lookup and relocation read only candidate prose; ambiguous moved identities do not guess',async()=>{
  const f=fixture(),ref=await f.capture(),target=f.context.chat[0];
  f.context.chat=Array.from({length:10000},(_,i)=>({send_date:`old-${i}`,name:'old',get mes(){throw new Error('unselected prose read');}}));
  f.context.chat[9000]=target;const moved=clone(ref);moved.lastKnownFloor=9000;
  assert.equal(f.resolve(moved).floor,9000);assert.equal(await f.verify(moved),true);
  assert.equal(f.resolve(ref).relocated,true);assert.equal(f.resolve(ref).floor,9000);assert.equal(await f.verify(ref),true);
  f.context.chat[8000]=clone(target);assert.equal(f.resolve(ref).state,'stale');
});

test('stream admission reserves one floor budget across snapshots, history hydration and refreshed runtimes',async()=>{
  const f=fixture(),first=await f.capture(),ledger=store(),options={store:ledger,account:async()=>'st-user:test',ownerId:'page-a',resolveSource:j=>f.resolve(j.messageRef)};
  const runtime=createImageAdmission(options),a=job(first);await runtime.admit(a,{maxAutomatic:1});
  f.context.chat[0].mes+=' for a cup.\n\nNext';const second=await f.capture();await runtime.beforeSubmit(a);await runtime.settle(a,'succeeded');
  const b=job(second,'second','A cup'),next=createImageAdmission({...options,ownerId:'page-b'});
  assert.deepEqual((await createImageAdmissionIdentity(a,'st-user:test')).scope,(await createImageAdmissionIdentity(b,'st-user:test')).scope);
  await assert.rejects(next.admit(b,{maxAutomatic:1}),{code:'image_attempt_budget_exhausted'});assert.equal(ledger.rows.size,1);
  const identity=await createImageAdmissionIdentity(b,'st-user:test'),seeds=await createImageHistorySeeds([{id:'saved',status:'success',snapshot:clone(a)}],identity);
  assert.equal(seeds.length,1);assert.equal(seeds[0].automaticSlot,true);
  const cold=createImageAdmission({...options,store:store(),ownerId:'page-c'});
  await assert.rejects(cold.admit(b,{maxAutomatic:1,history:[{id:'saved',status:'success',snapshot:clone(a)}]}),{code:'image_attempt_budget_exhausted'});
});

test('admission requires an actual source resolver and verifies again before every provider POST or retry',async()=>{
  const f=fixture(),ref=await f.capture(),ledger=store(),options={store:ledger,account:async()=>'st-user:test',ownerId:'page'};
  await assert.rejects(createImageAdmission(options).admit(job(ref),{maxAutomatic:3}));assert.equal(ledger.rows.size,0);
  const runtime=createImageAdmission({...options,resolveSource:j=>f.resolve(j.messageRef)}),a=job(ref);
  await runtime.admit(a,{maxAutomatic:3});f.context.chat[0].mes='different';await assert.rejects(runtime.beforeSubmit(a));
  const scope=(await createImageAdmissionIdentity(a,'st-user:test')).scope;assert.equal(ledger.inspect(scope).ledger.entries[0].status,'reserved');
  f.context.chat[0].mes='Alice cooks.\n\nShe reaches';await runtime.beforeSubmit(a);f.context.chat[0].gen_started='changed';await assert.rejects(runtime.beforeSubmit(a));
});

test('a reserved streaming job cannot shed its proof or change its source to bypass the paid-dispatch guard',async()=>{
  const f=fixture(),ref=await f.capture(),ledger=store(),runtime=createImageAdmission({store:ledger,account:async()=>'st-user:test',ownerId:'page',resolveSource:j=>f.resolve(j.messageRef)});
  const a=job(clone(ref));await runtime.admit(a,{maxAutomatic:3});delete a.messageRef.stream;a.messageRef.revisionId='ordinary';
  await assert.rejects(runtime.beforeSubmit(a),{code:'image_attempt_identity'});
  assert.equal([...ledger.rows.values()][0].entries[0].status,'reserved');
});

test('a host lacking a generation discriminator waits before extraction instead of creating an append-ambiguous proof',async()=>{
  const f=fixture();delete f.context.chat[0].gen_started;
  assert.equal(await captureStoryboardStreamFrame(f.options),null);assert.equal(f.context.eventSource.eventNames().length,0);
});

test('actual admission runtime injects the live ST chat resolver rather than archived snapshots',async()=>{
  const f=fixture(),ref=await f.capture();let setup;
  const env=vm.createContext({storyboardAdmissionEpoch:1,storyboardAdmission:null,confirmDialog(){},ctx:()=>f.context,getChatKey:()=>ref.chatKey,
    resolveStoryboardMessageReference,featureRuntime:{load:async()=>({createImageAdmission:options=>(setup=options,{})})}});
  vm.runInContext(['storyboardImageAdmissionRuntime','storyboardVerifyWorldAutomaticApproval'].map(storyboardFunctionSource).join('\n'),env);await env.storyboardImageAdmissionRuntime();
  assert.equal(setup.resolveSource(job(ref)).state,'active');f.context.chat[0].mes='changed';assert.equal(setup.resolveSource(job(ref)).state,'stale');
});
