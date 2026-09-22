import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import * as core from '../qianmu-storyboard.js';
import {captureStoryboardContinuation,saveStoryboardContinuation} from '../qianmu-storyboard-continuation.js';
import {normalizeStoryboardContinuationLinks,storyboardContinuationIdentityInput} from '../qianmu-storyboard-continuation-proof.js?v=1.59.310';
import {storyboardStreamDigest} from '../qianmu-storyboard-stream-reference.js?v=1.59.310';
import {verifyStoryboardOrdinaryContinuation as verify} from '../qianmu-storyboard-ordinary-continuation.js';
import {createImageAdmission,createImageAdmissionIdentity} from '../qianmu-image-admission.js';
import {beginImageAttempt,continueImageAttempt,claimImageAttempt,importImageAttempts,settleImageAttempt,imageAttemptScopeKey} from '../qianmu-image-attempts.js';
import {storyboardFunctionSource as section} from './helpers/storyboard-form-fixture.mjs';
import {finishStoryboardStreamCapture} from '../qianmu-storyboard-stream-final.js';
const copy=value=>JSON.parse(JSON.stringify(value));
const deferred=()=>{let resolve;return {promise:new Promise(yes=>{resolve=yes;}),resolve};};
async function fixture(count=1){
  const message={mes:'Alice cooks.\n\n',name:'Alice',send_date:'day-1',gen_started:'generation-1',swipe_id:0};
  const host={chatId:'chat',characterId:0,characters:[{chat:'chat',avatar:'Alice.png'}],chatMetadata:{story_director_liminale:{}},chat:[message]};
  const namespace='st-user:ordinary',ref=core.createStoryboardMessageReference({message,chatKey:'chat',floor:0}),original=copy(message);
  const capture=()=>captureStoryboardContinuation({type:'continue',getContext:()=>host,epoch:()=>0,createReference:core.createStoryboardMessageReference});
  const advance=n=>{message.mes+=`Bob brings bowl ${n}.\n\n`;message.send_date=`day-${n}`;message.gen_started=`generation-${n}`;
    message.swipe_info=[{send_date:message.send_date,gen_started:message.gen_started,extra:{}}];};
  const save=(handle,callback=async()=>{})=>saveStoryboardContinuation(handle,async()=>namespace,host.chatMetadata.story_director_liminale,callback);
  for(let n=2;n<count+2;n++){const handle=capture();advance(n);try{await save(handle);}finally{handle.close();}}
  const resolve=(value=ref,options={})=>core.resolveStoryboardMessageReference(value,host.chat,{chatKey:host.chatId,namespace,metadata:host.chatMetadata,...options});
  return {host,message,namespace,ref,original,capture,advance,save,resolve,verify:()=>verify(ref,resolve,{namespace})};
}
function storage(){
  const rows=new Map(),now=Date.now(),run=(scope,fn)=>{const key=imageAttemptScopeKey(scope),result=fn(rows.get(key));rows.set(key,copy(result.ledger));return result;};
  return {rows,close(){},claim:async(scope,input,seeds=[])=>run(scope,value=>claimImageAttempt(importImageAttempts(value,scope,seeds,now),scope,input,now)),
    begin:async(scope,input)=>run(scope,value=>beginImageAttempt(value,scope,input,now)),continue:async(scope,input)=>run(scope,value=>continueImageAttempt(value,scope,input,now)),
    settle:async(scope,input)=>run(scope,value=>settleImageAttempt(value,scope,input,now))};
}
function admission(f,options={}){
  const store=options.store||storage(),runtime=createImageAdmission({store,account:async()=>f.namespace,ownerId:'test-page',resolveSource:job=>f.resolve(job.messageRef),...options});
  const job={id:'old-pending',chatKey:'chat',messageRef:copy(f.ref),target:'floor',floor:0,automatic:true,profile:{count:'1'},prompt:'Alice cooks.',shotType:'portrait'};
  return {store,runtime,job};
}

test('v2 records an exact compact ordinary revision, binds it to SHA identity, and preserves old requests through JSON reload',async()=>{
  const f=await fixture(),row=f.host.chatMetadata.story_director_liminale.storyboardContinuations[0],before=copy(f.ref);
  assert.equal(row.version,2);assert.equal(row.source.revisionId,f.ref.revisionId);assert.equal(row.source.revisionHash,f.ref.revisionHash);
  assert.equal(row.id,await storyboardStreamDigest(storyboardContinuationIdentityInput(row)));
  assert.doesNotMatch(JSON.stringify(row),/Alice cooks|Bob brings|prompt|apiKey|mes"/);
  f.host.chatMetadata=copy(f.host.chatMetadata);assert.equal(f.resolve().state,'active');assert.equal(await f.verify(),true);assert.deepEqual(f.ref,before);
  assert.equal(f.resolve().current.revisionHash,core.createStoryboardMessageReference({message:f.message,chatKey:'chat',floor:0}).revisionHash);
});

test('legacy v1, absent history or a different original revision cannot grant ordinary continuation ownership',async()=>{
  const f=await fixture(),row=f.host.chatMetadata.story_director_liminale.storyboardContinuations[0];
  const legacy={...copy(row),version:1};delete legacy.source;legacy.id=await storyboardStreamDigest(storyboardContinuationIdentityInput(legacy));
  assert.notEqual(f.resolve(f.ref,{continuationLinks:[legacy]}).state,'active');assert.notEqual(f.resolve(f.ref,{continuationLinks:[]}).state,'active');
  assert.notEqual(f.resolve({...f.ref,revisionId:'12345678'}).state,'active');
  assert.notEqual(f.resolve({...f.ref,revisionHash:'12345678'}).state,'active');
  assert.notEqual(f.resolve({...f.ref,role:'user'}).state,'active');
});

test('ordinary multi-continue proof supports relocation using metadata only, never reading unrelated high-floor prose',async()=>{
  const f=await fixture(2),tail=f.message,before=copy(f.ref);
  const rows=Array.from({length:5000},(_,n)=>({name:'Other',send_date:`other-${n}`,gen_started:'other',get mes(){assert.fail('unrelated prose read');}}));rows.push(tail);f.host.chat=rows;
  for(const lastKnownFloor of [0,5000]){
    const reference={...f.ref,lastKnownFloor},resolve=()=>f.resolve(reference);assert.equal(resolve().floor,5000);assert.equal(resolve().continuations.length,2);
    assert.equal(await verify(reference,resolve,{namespace:f.namespace}),true);
  }
  assert.deepEqual(f.ref,before);
});

test('prefix rewrite, identity, swipe, missing floor, ambiguous relocation and account changes never inherit the old source',async()=>{
  for(const mode of ['text','generation','swipe','missing','ambiguous','account','role','name']){
    const f=await fixture();
    if(mode==='text')f.message.mes='Other prose.\n\n'+f.message.mes;
    if(mode==='generation')f.message.gen_started='regenerated';
    if(mode==='swipe')f.message.swipe_id=1;
    if(mode==='missing')f.host.chat=[];
    if(mode==='ambiguous'){f.host.chat=[{mes:'unrelated',name:'X'},copy(f.message),copy(f.message)];}
    if(mode==='role')f.message.is_user=true;
    if(mode==='name')f.message.name='Other';
    const options=mode==='account'?{namespace:'st-user:other'}:{};
    assert.notEqual(f.resolve(f.ref,options).state,'active');await assert.rejects(verify(f.ref,()=>f.resolve(f.ref,options),{namespace:f.namespace,required:true}));
  }
});

test('ordinary paid verification rejects forged digest, bridge id, source revision, and changes during its asynchronous checks',async()=>{
  for(const field of ['digest','id','source']){
    const f=await fixture(),link=f.host.chatMetadata.story_director_liminale.storyboardContinuations[0];
    if(field==='source'){link.source.revisionId='12345678';f.ref.revisionId='12345678';}else link[field]='a'.repeat(64);
    assert.equal(f.resolve().state,'active','cheap display linking does not claim to verify SHA');await assert.rejects(f.verify());
  }
  const f=await fixture();let calls=0;await assert.rejects(verify(f.ref,()=>{if(calls++)f.host.chatMetadata.story_director_liminale.storyboardContinuations[0].createdAt++;return f.resolve();},{namespace:f.namespace}));
});

test('v2 missing, extra, inconsistent, downgraded or future ordinary-source contracts are rejected without mutating history',async()=>{
  const f=await fixture(),original=f.host.chatMetadata.story_director_liminale.storyboardContinuations[0];
  for(const change of [r=>delete r.source,r=>r.version=1,r=>r.version=99,r=>r.source.prompt='private',r=>r.source.messageKey='other',r=>r.source.swipeId=2,
    r=>r.source.revisionHash='12345678',r=>r.source.revisionId='',r=>r.source.baseSendDate='',r=>r.source.baseGenerationId='bad\nkey']){
    const row=copy(original);change(row);const before=copy(row);assert.throws(()=>normalizeStoryboardContinuationLinks([row]));assert.deepEqual(row,before);
  }
});

test('a provisional ordinary bridge is unreadable until save succeeds; failure cannot revive the old source',async()=>{
  for(const failure of [false,true]){
    const f=await fixture(0),handle=f.capture();f.advance(2);const started=deferred(),gate=deferred();
    const pending=f.save(handle,async()=>{started.resolve();await gate.promise;if(failure)throw Error('save failed');}),result=pending.then(()=>true,()=>false);
    await started.promise;assert.notEqual(f.resolve().state,'active');gate.resolve();assert.equal(await result,!failure);
    assert.equal(f.resolve().state,failure?'orphaned':'active');handle.close();
  }
});

test('ordinary in-flight work retains its original admission scope and can dispatch after verified continuation without rewriting its recipe',async()=>{
  const f=await fixture(),a=admission(f),before=copy(a.job.messageRef),identity=await createImageAdmissionIdentity(a.job,f.namespace);
  await a.runtime.admit(a.job,{maxAutomatic:1});await a.runtime.beforeSubmit(a.job);
  assert.equal(a.job.imageAdmission.messageKey,f.ref.messageKey);assert.equal(a.job.imageAdmission.revisionId,f.ref.revisionId);
  assert.deepEqual(identity.scope,await createImageAdmissionIdentity(a.job,f.namespace).then(value=>value.scope));assert.deepEqual(a.job.messageRef,before);
  await a.runtime.settle(a.job,'accepted');const next={...copy(a.job),id:'duplicate',prompt:'another subject'};delete next.imageAdmission;
  await assert.rejects(a.runtime.admit(next,{maxAutomatic:1}),error=>['image_attempt_busy','image_attempt_budget_exhausted'].includes(error.code));await a.runtime.close();
});

test('ordinary admission stops before claiming on corrupt proof or a wrong account, even if the display resolver omitted account filtering',async()=>{
  for(const mode of ['digest','account']){
    const f=await fixture();let claims=0;
    if(mode==='digest')f.host.chatMetadata.story_director_liminale.storyboardContinuations[0].digest='a'.repeat(64);
    const a=admission(f,{account:async()=>mode==='account'?'st-user:other':f.namespace,store:{claim(){claims++;assert.fail('must not claim');},close(){}}});
    await assert.rejects(a.runtime.admit(a.job,{maxAutomatic:1}));assert.equal(claims,0);await a.runtime.close();
  }
});

test('reserved continued work cannot submit after proof removal, context switch or source mutation',async()=>{
  for(const mode of ['remove','foreign','reference','prefix']){
    const f=await fixture(),a=admission(f);await a.runtime.admit(a.job,{maxAutomatic:1});
    if(mode==='remove')f.host.chatMetadata.story_director_liminale.storyboardContinuations=[];
    if(mode==='foreign')f.host.chatId='other';
    if(mode==='reference')a.job.messageRef.revisionId='12345678';
    if(mode==='prefix')f.message.mes='rewritten';
    await assert.rejects(a.runtime.beforeSubmit(a.job));await a.runtime.close();
  }
});

test('continuation beginning after reservation is verified at dispatch and required again for provider retries',async()=>{
  const f=await fixture(0),a=admission(f);await a.runtime.admit(a.job,{maxAutomatic:1});
  const handle=f.capture();f.advance(2);await f.save(handle);handle.close();await a.runtime.beforeSubmit(a.job);
  f.host.chatMetadata.story_director_liminale.storyboardContinuations=[];await assert.rejects(a.runtime.beforeSubmit(a.job));await a.runtime.close();
});

test('ledger awaits cannot smuggle a changed ordinary reference or removed continuation into dispatch',async()=>{
  for(const mode of ['claim-proof','begin-proof','account-reference']){
    const f=await fixture(),store=storage(),a=admission(f,{store,account:async()=>{if(mode==='account-reference')a.job.messageRef.revisionId='12345678';return f.namespace;}});
    const method=mode==='claim-proof'?'claim':'begin',original=store[method];store[method]=async(...args)=>{const result=await original(...args);f.host.chatMetadata.story_director_liminale.storyboardContinuations=[];return result;};
    if(mode==='begin-proof'){await a.runtime.admit(a.job,{maxAutomatic:1});await assert.rejects(a.runtime.beforeSubmit(a.job));}
    else await assert.rejects(a.runtime.admit(a.job,{maxAutomatic:1}));
    await a.runtime.close();
  }
});

test('actual inline records, queued indicators and source resolver consume the saved ordinary bridge without replacing original refs',async()=>{
  const f=await fixture(),task=core.createStoryboardTaskState({id:'old-pending',chatKey:'chat',floor:0,messageRef:copy(f.ref),status:'queued',uiVisible:true,
    inlineOrder:{version:1,batchId:'old-plan',batchStartedAt:100,shotIndex:0,requestIndex:1}}),state={taskStates:[task],logs:[]};let setup;
  const c=vm.createContext({...core,storyboardAdmissionEpoch:1,storyboardAdmission:null,confirmDialog(){},ctx:()=>f.host,getChatKey:()=>f.host.chatId,
    storyboardState:()=>state,storyboardGalleryRecords:()=>[],storyboardActiveJobs:new Map(),storyboardQueue:[task],
    featureRuntime:{load:async()=>({createImageAdmission:options=>(setup=options,{})})}});
  vm.runInContext(['storyboardImageAdmissionRuntime','storyboardVerifyWorldAutomaticApproval','storyboardValidatedAnchor','storyboardCurrentInlineTasks'].map(section).join('\n'),c);
  await c.storyboardImageAdmissionRuntime();const job={target:'floor',floor:0,chatKey:'chat',messageRef:copy(f.ref)},before=copy(job);
  assert.equal(c.storyboardValidatedAnchor(job).valid,true);assert.equal(c.storyboardCurrentInlineTasks().length,1);await verify(job.messageRef,()=>setup.resolveSource(job),{namespace:f.namespace});
  assert.deepEqual(job,before);f.host.chatMetadata={story_director_liminale:{}};assert.equal(c.storyboardValidatedAnchor(job).valid,false);assert.equal(c.storyboardCurrentInlineTasks().length,0);
});

test('actual automatic entry never turns missing ordinary plan provenance into an unrelated fresh budget',async()=>{
  const f=await fixture(),state=core.createStoryboardDefaults(),notices=[];
  Object.assign(state,{enabled:true});Object.assign(state.automation,{autoCapture:true,autoGenerate:true});state.promptCompiler.enabled=true;
  state.logs=[{id:'old-ordinary-log',status:'success',snapshot:{messageRef:copy(f.ref)}}];
  const before=copy(state),context=vm.createContext({...core,storyboardAutomaticEpoch:0,ctx:()=>f.host,getChatKey:()=>f.host.chatId,storyboardState:()=>state,
    storyboardGalleryRecords:()=>[],storyboardCompilePrompt:()=>assert.fail('must not call the model'),storyboardSubmitStreamPrepared:()=>assert.fail('must not queue'),
    storyboardEnsurePlan:()=>assert.fail('must not create a second plan'),uid:()=> 'test',saveSettings:()=>assert.fail('must not change state'),
    toast:message=>notices.push(message),sanitizeStoryboardDiagnosticData:v=>v,
    featureRuntime:{load:async key=>key==='storyboardContract'?{finishStoryboardStreamCapture}:{resolveImageAccountNamespace:async()=>f.namespace}}});
  vm.runInContext(['storyboardAutomaticTicketFloor','storyboardFinishStreamCapture','storyboardPlanForMessage','storyboardPerformAutomaticCapture'].map(section).join('\n'),context);
  const ticket={state,epoch:0,chatKey:'chat',floor:0,message:f.message,messageRef:core.createStoryboardMessageReference({message:f.message,chatKey:'chat',floor:0}),createdAt:Date.now(),autoGenerate:true};
  assert.equal(await context.storyboardPerformAutomaticCapture(ticket),false);assert.match(notices.at(-1),/原流式计划缺失或重复/);assert.deepEqual(state,before);
});

test('ordinary admission without saved lineage uses the actual metadata-only fast path and never scans chat prose',async()=>{
  const f=await fixture(0);f.host.chat=Array.from({length:5000},()=>({get mes(){assert.fail('ordinary admission must not scan prose');}}));let setup;
  const c=vm.createContext({...core,storyboardAdmissionEpoch:0,storyboardAdmission:null,ctx:()=>f.host,getChatKey:()=>f.host.chatId,confirmDialog(){},
    featureRuntime:{load:async()=>({createImageAdmission:options=>(setup=options,{})})}});
  vm.runInContext(['storyboardImageAdmissionRuntime','storyboardVerifyWorldAutomaticApproval'].map(section).join('\n'),c);await c.storyboardImageAdmissionRuntime();
  const a=admission(f,{resolveSource:()=>assert.fail('must not call the full resolver'),resolveContinuation:setup.resolveContinuation});
  await a.runtime.admit(a.job,{maxAutomatic:1});await a.runtime.beforeSubmit(a.job);await a.runtime.settle(a.job,'succeeded');await a.runtime.close();
});
