import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import vm from 'node:vm';
import * as core from '../qianmu-storyboard.js';
import {storyboardFunctionSource as section} from './helpers/storyboard-form-fixture.mjs';
import {captureStoryboardContinuation as capture,prepareStoryboardContinuation as prepare,saveStoryboardContinuation as save,normalizeStoryboardContinuationLinks as normalize,storyboardContinuationPath as path} from '../qianmu-storyboard-continuation.js';
import {createStoryboardMessageReference as reference,resolveStoryboardMessageReference as resolve,normalizeStoryboardMessageReference as normalizeRef} from '../qianmu-storyboard.js';
import {captureStoryboardStreamFrame,createStoryboardStreamMessageReference} from '../qianmu-storyboard-stream-source.js?v=1.59.338';
import {storyboardStreamGeneration as generation,storyboardStreamDigest as digest,storyboardStreamFingerprint as fingerprint,storyboardStreamGenerationInput,verifyStoryboardStreamReference as verify} from '../qianmu-storyboard-stream-reference.js';
const copy=value=>JSON.parse(JSON.stringify(value));
const deferred=()=>{let resolve;return {promise:new Promise(yes=>{resolve=yes;}),resolve:value=>resolve(value)};};
function fixture(){
  const message={mes:'Alice cooks.\n\n',name:'Alice',send_date:'day-1',gen_started:'generation-1',swipe_id:0},emitter=new EventEmitter();
  const context={chatId:'chat',characterId:0,characters:[{chat:'chat',avatar:'Alice.png'}],chatMetadata:{story_director_liminale:{}},chat:[message],eventSource:emitter};
  let epoch=0,namespace='st-user:test',saves=0;
  const options={type:'continue',getContext:()=>context,epoch:()=>epoch,createReference:reference},account=async()=>namespace;
  const store=context.chatMetadata.story_director_liminale;
  return {message,context,emitter,options,store,account,bump:()=>epoch++,set namespace(value){namespace=value;},get saves(){return saves;},
    capture:extra=>capture({...options,...extra}),save:(handle,callback=async()=>{saves++;})=>save(handle,account,store,callback),
    advance(n=2,suffix='Bob brings a bowl.\n\n'){message.mes+=suffix;message.send_date=`day-${n}`;message.gen_started=`generation-${n}`;
      message.swipe_info=[{send_date:message.send_date,gen_started:message.gen_started,extra:{}}];},
    async stream(){const frame=await captureStoryboardStreamFrame({...options,floor:0,resolveNamespace:account,isCurrent:()=>true});
      const result=await createStoryboardStreamMessageReference(frame);frame.close();return result;},
    resolve(ref,links=store.storyboardContinuations){return resolve(ref,context.chat,{chatKey:'chat',continuationLinks:links,namespace});},
    listeners(){return emitter.eventNames().reduce((n,key)=>n+emitter.listenerCount(key),0);}};
}

test('only an explicit non-dry host continue snapshots a source; it does not call an API, save or change host data',()=>{
  const f=fixture(),before=copy(f.context.chat);
  for(const type of ['normal','regenerate','swipe','append','quiet','impersonate',undefined])assert.equal(f.capture({type}),null);
  assert.equal(f.capture({dryRun:true}),null);const signal=new AbortController();signal.abort();assert.equal(f.capture({signal:signal.signal}),null);
  const handle=f.capture();assert.equal(handle.floor,0);assert.deepEqual(f.context.chat,before);assert.equal(f.saves,0);assert.ok(f.listeners()>0);
  handle.close();assert.equal(f.listeners(),0);assert.throws(handle.assertCurrent);
});

test('missing or unidentified assistant source is not guessed and does not leave listeners behind',()=>{
  for(const mutate of [m=>m.is_user=true,m=>m.is_system=true,m=>m.mes='',m=>m.mes='x'.repeat(200001),m=>{delete m.send_date;delete m.gen_started;}]){
    const f=fixture();mutate(f.message);assert.equal(f.capture(),null);assert.equal(f.listeners(),0);
  }
});

test('a captured continuation survives host timestamp replacement and stores only a detached compact proof',async()=>{
  const f=fixture(),before=f.message.mes,handle=f.capture();assert.equal(await prepare(handle,f.account),null);
  f.advance();const host=copy(f.context.chat),proposal=await prepare(handle,f.account);assert.equal(f.saves,0);
  assert.notEqual(proposal.from.messageKey,proposal.to.messageKey);assert.equal(proposal.length,before.length);assert.equal(proposal.digest,await digest(before));
  const result=await f.save(handle);assert.equal(f.saves,1);assert.deepEqual(result,f.store.storyboardContinuations[0]);assert.deepEqual(f.context.chat,host);
  assert.doesNotMatch(JSON.stringify(result),/Alice cooks|Bob brings|prompt|apiKey/);result.from.messageKey='mutated';assert.notEqual(f.store.storyboardContinuations[0].from.messageKey,'mutated');
  await f.save(handle);assert.equal(f.saves,1,'same append bridge is idempotent');handle.close();assert.equal(f.listeners(),0);
});

for(const [name,change] of [['prefix rewrite',f=>f.message.mes='Different body'],['replacement object',f=>f.context.chat[0]=copy(f.message)],
  ['name change',f=>f.message.name='Other'],['swipe change',f=>f.message.swipe_id=1],['new floor',f=>f.context.chat.push({mes:'new',is_user:true})],
  ['chat switch',f=>f.context.chatId='other'],['epoch switch',f=>f.bump()],['edit-and-restore',f=>f.emitter.emit('message_edited',0)],
  ['regenerate event',f=>f.emitter.emit('generation_after_commands','regenerate')]])test(`${name} cancels continuation proof without saving`,async()=>{
    const f=fixture(),handle=f.capture();f.advance();change(f);await assert.rejects(f.save(handle));assert.equal(f.saves,0);assert.equal(f.store.storyboardContinuations,undefined);handle.close();assert.equal(f.listeners(),0);
  });

test('abort, account switch or generation change during asynchronous preparation cannot publish a bridge',async()=>{
  for(const change of ['abort','account','generation']){
    const f=fixture(),signal=new AbortController(),handle=f.capture({signal:signal.signal});f.advance();let reads=0;
    const account=async()=>{if(++reads===2){if(change==='abort')signal.abort();if(change==='account')return 'st-user:other';if(change==='generation')f.message.gen_started='another-run';}return 'st-user:test';};
    await assert.rejects(save(handle,account,f.store,async()=>assert.fail('must not save')));assert.equal(f.store.storyboardContinuations,undefined);handle.close();
  }
});

test('a caller cannot save into a different chat store or mint a continuation from a forged/disposed handle',async()=>{
  const f=fixture(),handle=f.capture();f.advance();await assert.rejects(save(handle,f.account,{},async()=>assert.fail('foreign store')));
  await assert.rejects(prepare({...handle},f.account));handle.close();await assert.rejects(prepare(handle,f.account));
});

test('failed storage rolls back its own proposal; another change is not overwritten and success followed by chat switch is retained',async()=>{
  const f=fixture(),handle=f.capture();f.advance();
  await assert.rejects(f.save(handle,async()=>{throw Error('write failed');}),/write failed/);assert.equal(Object.hasOwn(f.store,'storyboardContinuations'),false);
  await assert.rejects(f.save(handle,async()=>{f.store.storyboardContinuations=['concurrent'];throw Error('failed');}));assert.deepEqual(f.store.storyboardContinuations,['concurrent']);
  delete f.store.storyboardContinuations;
  await assert.rejects(f.save(handle,async()=>{f.context.chatId='other';}));assert.equal(f.store.storyboardContinuations.length,1,'a returned save is not undone merely because the reader switched chat');handle.close();
});

test('same-chat writes serialize and a duplicate request cannot save twice',async()=>{
  const f=fixture(),handle=f.capture(),gate=deferred(),started=deferred();f.advance();let saves=0;
  const write=async()=>{saves++;started.resolve();await gate.promise;};const first=f.save(handle,write);await started.promise;
  const second=f.save(handle,write);gate.resolve();await first;await second;assert.equal(saves,1);handle.close();
});

test('explicit recorded lineage resolves old stream images after send-date and generation changes, including JSON reload',async()=>{
  const f=fixture(),ref=await f.stream(),handle=f.capture();f.advance();assert.notEqual(f.resolve(ref).state,'active');
  await f.save(handle);handle.close();const links=copy(f.store.storyboardContinuations),restored=normalizeRef(copy(ref));
  assert.equal(f.resolve(restored,links).state,'active');assert.equal(await verify(restored,()=>f.resolve(restored,links)),true);
  assert.equal(f.resolve(restored,[]).state,'orphaned');assert.equal(f.resolve(restored,[{version:99}]).state,'stale');
  assert.equal(f.resolve(restored,links).continuations.length,1);f.message.mes='X'+f.message.mes.slice(1);assert.equal(f.resolve(restored,links).state,'stale');
});

test('saved v2 bridges retain both exact ordinary revisions and complete stream proofs; v1 never invents ordinary ownership',async()=>{
  const f=fixture(),ordinary=reference({message:f.message,chatKey:'chat',floor:0}),full=copy(ordinary),raw=f.message.mes;
  const g=generation(f.message),key=await digest(storyboardStreamGenerationInput(full,g));full.revisionHash=fingerprint(raw);full.revisionId=`stream:${key}`;
  full.stream={version:1,generation:g,generationKey:key,prefixLength:raw.length,prefixHash:full.revisionHash,prefixDigest:await digest(raw),complete:true};
  const handle=f.capture();f.advance();await f.save(handle);handle.close();assert.equal(f.resolve(full).state,'active');await verify(full,()=>f.resolve(full));
  assert.equal(f.resolve(ordinary).state,'active');assert.notEqual(f.resolve(full,[]).state,'active');
  const legacy=copy(f.store.storyboardContinuations);for(const row of legacy){row.version=1;delete row.source;row.id=await digest(JSON.stringify([row.namespace,row.chatKey,row.from,row.to,row.digest]));}
  assert.notEqual(f.resolve(ordinary,legacy).state,'active');assert.equal(f.resolve(full,legacy).state,'active');await verify(full,()=>f.resolve(full,legacy));
});

test('multiple explicit continuations preserve one source lineage without relaxing edits, namespace or swipe boundaries',async()=>{
  const f=fixture(),ref=await f.stream();for(const n of [2,3]){const handle=f.capture();f.advance(n);await f.save(handle);handle.close();}
  assert.equal(f.resolve(ref).continuations.length,2);await verify(ref,()=>f.resolve(ref));
  f.namespace='st-user:other';assert.notEqual(f.resolve(ref).state,'active');f.namespace='st-user:test';
  f.message.swipe_id=1;assert.equal(f.resolve(ref).state,'inactive_swipe');
});

test('weak UI fingerprints never authorize a tampered digest, link id, or changing bridge at paid verification',async()=>{
  const f=fixture(),ref=await f.stream(),handle=f.capture();f.advance();await f.save(handle);handle.close();
  for(const key of ['digest','id']){const links=copy(f.store.storyboardContinuations);links[0][key]='a'.repeat(64);
    assert.equal(f.resolve(ref,links).state,'active');await assert.rejects(verify(ref,()=>f.resolve(ref,links)));}
  let calls=0;await assert.rejects(verify(ref,()=>{if(calls++)f.store.storyboardContinuations[0].createdAt++;return f.resolve(ref);}));
});

test('duplicate, shrinking, cyclic, future and excessive link histories stop instead of guessing or clearing',async()=>{
  const f=fixture(),ref=await f.stream(),handle=f.capture();f.advance();const link=await prepare(handle,f.account);handle.close();
  for(const links of [null,{},[link,link],[{...link,version:99}],[{...link,length:200001}],[{...link,to:{...link.to,swipeId:1}}],
    [{...link,to:link.from}],[{...link,namespace:''}],Array.from({length:401},()=>link)])assert.throws(()=>normalize(links));
  assert.throws(()=>path(ref,[{...link,length:1}]));
  assert.throws(()=>path(ref,[link,{...link,id:'a'.repeat(64),from:link.to,to:link.from}]));
});

test('actual source resolver and inline task projection consume only current-chat saved lineage',async()=>{
  const f=fixture(),ref=await f.stream(),handle=f.capture();f.advance();await f.save(handle);handle.close();let setup;
  const task=core.createStoryboardTaskState({id:'original-task',chatKey:'chat',messageRef:ref,floor:0,uiVisible:true,status:'queued',
    inlineOrder:{version:1,batchId:`stream-${ref.stream.generationKey}`,batchStartedAt:100,shotIndex:0,requestIndex:1}});
  const state={taskStates:[task],logs:[]},c=vm.createContext({...core,storyboardAdmissionEpoch:1,storyboardAdmission:null,confirmDialog(){},
    ctx:()=>f.context,getChatKey:()=>f.context.chatId,storyboardState:()=>state,storyboardGalleryRecords:()=>[],storyboardActiveJobs:new Map(),storyboardQueue:[task],
    featureRuntime:{load:async()=>({createImageAdmission:options=>(setup=options,{})})}});
  vm.runInContext(['storyboardImageAdmissionRuntime','storyboardVerifyWorldAutomaticApproval','storyboardValidatedAnchor','storyboardCurrentInlineTasks'].map(section).join('\n'),c);
  await c.storyboardImageAdmissionRuntime();const job={messageRef:ref,chatKey:'chat',target:'floor',floor:0};
  assert.equal(setup.resolveSource(job).state,'active');await verify(ref,()=>setup.resolveSource(job));
  assert.equal(c.storyboardValidatedAnchor(job).valid,true);assert.equal(c.storyboardCurrentInlineTasks().length,1);
  f.context.chatMetadata={story_director_liminale:{}};assert.notEqual(setup.resolveSource(job).state,'active');assert.equal(c.storyboardValidatedAnchor(job).valid,false);
  assert.equal(c.storyboardCurrentInlineTasks().length,0);
});

test('lookup of a continued high floor reads only its candidate prose, not unrelated history',async()=>{
  const f=fixture(),ref=await f.stream(),handle=f.capture();f.advance();await f.save(handle);handle.close();
  const tail=f.message,rows=Array.from({length:5000},(_,index)=>({name:'Other',send_date:`date-${index}`,gen_started:'other',
    get mes(){assert.fail('unrelated prose read');}}));rows.push(tail);
  const moved={...ref,lastKnownFloor:5000},resolved=resolve(moved,rows,{chatKey:'chat',metadata:f.context.chatMetadata});
  assert.equal(resolved.state,'active');assert.equal(resolved.floor,5000);
});

test('empty account namespaces and unreadable saved histories cannot create or replace a continuation ledger',async()=>{
  const f=fixture(),handle=f.capture();f.advance();const link=await prepare(handle,f.account);
  for(const namespace of ['st-user:','st-user:  ','unknown'])await assert.rejects(prepare(handle,async()=>namespace));
  assert.throws(()=>normalize([{...link,namespace:'st-user:'}]));
  for(const prior of [null,{version:99},[{version:99}]]){
    f.store.storyboardContinuations=prior;await assert.rejects(f.save(handle));assert.equal(f.store.storyboardContinuations,prior);assert.equal(f.saves,0);
  }
  handle.close();
});

test('the bounded lineage permits exactly 32 links and refuses a longer chain without deleting stored evidence',async()=>{
  const f=fixture(),ref=await f.stream();
  for(let n=2;n<=33;n++){const handle=f.capture();f.advance(n);await f.save(handle);handle.close();}
  assert.equal(path(ref,f.store.storyboardContinuations).length,32);await verify(ref,()=>f.resolve(ref));
  const handle=f.capture();f.advance(34);await f.save(handle);handle.close();
  assert.throws(()=>path(ref,f.store.storyboardContinuations));assert.equal(f.store.storyboardContinuations.length,33);
  assert.equal(f.resolve(ref).state,'stale');
});

test('actual metadata readers cannot use an optimistic continuation before its save callback succeeds',async()=>{
  for(const fail of [false,true]){
    const f=fixture(),ref=await f.stream(),handle=f.capture(),started=deferred(),gate=deferred();f.advance();
    const current=()=>resolve(ref,f.context.chat,{chatKey:'chat',metadata:f.context.chatMetadata});
    const write=f.save(handle,async()=>{started.resolve();await gate.promise;if(fail)throw Error('failed');});
    const outcome=write.then(()=>true,()=>false);await started.promise;assert.notEqual(current().state,'active');
    gate.resolve();assert.equal(await outcome,!fail);assert.equal(current().state,fail?'orphaned':'active');handle.close();
  }
});
