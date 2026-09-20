import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {captureStoryboardCompilerSources,openStoryboardCompilerContinuity} from '../qianmu-storyboard-compiler-sources.js';
import {STORYBOARD_CONTINUITY_STORE_SCHEMA} from '../qianmu-storyboard-continuity-store.js';
import {acquireChatSaveLock,releaseChatSaveLock} from '../qianmu-chat-save-lock.js';

const roster={branches:[{id:'now',layer:'present'}],subjectIds:['A']};
const proposal=(floor=0)=>({floor,roster:structuredClone(roster),events:[{id:'coat',branchId:'now',paragraphId:'P1',subjectId:'A',category:'outfit',key:'coat',value:'off',persistence:'persistent',evidence:'A脱下外套。'}]});
function deferred(){let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}
async function fixture({metadata,paragraphs,account='st-user:alice',floor=1,texts=['A脱下外套。','A继续聊天。']}={}){
  const emitter=new EventEmitter();emitter.setMaxListeners(300);let active=true,namespace=account,lookup=null,saveHook=null,saved='',saves=0;
  const context={chatId:'chat',characterId:0,characters:[{avatar:'A.png',chat:'chat'}],chatMetadata:metadata||{story_director_liminale:{keep:'untouched',storyboardImages:[{id:'original-image'}]}},
    eventSource:emitter,chat:texts.map((mes,index)=>({mes,name:'A',swipe_id:0,send_date:String(index)})),
    async saveMetadata(){saves++;if(saveHook)return saveHook();saved=JSON.stringify(context.chatMetadata);}};
  const options={floor,referenceFloors:Math.min(20,floor),getContext:()=>context,epoch:()=>0,isCurrent:()=>active,
    resolveNamespace:async()=>lookup?lookup():namespace,readText:message=>message.mes,
    readParagraphs:paragraphs||((message)=>[{id:'P1',text:message.mes}])};
  const window=await captureStoryboardCompilerSources(options),session=openStoryboardCompilerContinuity(window,{timeoutMs:100});
  return {context,window,session,options,get metadata(){return context.chatMetadata;},get store(){return context.chatMetadata.story_director_liminale;},get saved(){return saved;},get saves(){return saves;},
    set account(value){namespace=value;},set active(value){active=value;},set lookup(value){lookup=value;},set saveHook(value){saveHook=value;},
    listeners:()=>emitter.eventNames().reduce((sum,key)=>sum+emitter.listenerCount(key),0),close(){session.close();window.close();}};
}

test('empty cache reads without metadata mutation; forged or closed compiler windows cannot open persistence',async()=>{
  const f=await fixture(),before=JSON.stringify(f.metadata);assert.deepEqual(await f.session.read(),{status:'ready',revision:0,records:[],invalidFloors:[]});
  assert.equal(JSON.stringify(f.metadata),before);assert.equal(f.saves,0);
  f.lookup=()=>assert.fail('an empty cache needs no extra authenticated request');await f.session.read();
  assert.throws(()=>openStoryboardCompilerContinuity({...f.window}),{code:'storyboard_input_changed'});f.close();assert.throws(()=>openStoryboardCompilerContinuity(f.window));assert.equal(f.listeners(),0);
});

test('validated all-prose event records survive serialized ST save and reopen without full text or changes to images',async()=>{
  const f=await fixture(),original=f.store.storyboardImages,result=await f.session.publish([proposal()]);
  assert.equal(result.status,'host_returned');assert.equal(f.saves,1);assert.equal(f.store.storyboardImages,original);assert.equal(f.store.keep,'untouched');
  const saved=JSON.parse(f.saved);assert.equal(saved.story_director_liminale.storyboardContinuity.schema,STORYBOARD_CONTINUITY_STORE_SCHEMA);
  const record=saved.story_director_liminale.storyboardContinuity.records[0];assert.deepEqual(Object.keys(record),['messageRef','paragraphDigest','roster','events']);
  assert.doesNotMatch(JSON.stringify(record),/A继续聊天|apiKey|paragraphs/);f.close();
  const reopened=await fixture({metadata:saved}),read=await reopened.session.read();assert.equal(read.records.length,1);assert.equal(read.records[0].events[0].value,'off');
  assert.ok(Object.isFrozen(read.records[0].events[0]));assert.equal(reopened.saves,0);
  assert.equal((await reopened.session.publish([proposal()])).status,'unchanged');assert.equal(reopened.saves,0);reopened.close();
});

test('raw event order/identity remains source-bound and caller mutation during asynchronous saving cannot change it',async()=>{
  const f=await fixture(),draft=proposal(),wait=deferred();f.lookup=()=>wait.promise;
  const pending=f.session.publish([draft]);draft.events[0].value='injected after call';draft.roster.subjectIds.push('foreign');wait.resolve('st-user:alice');
  assert.equal((await pending).status,'host_returned');assert.equal(f.store.storyboardContinuity.records[0].events[0].value,'off');assert.deepEqual(f.store.storyboardContinuity.records[0].roster.subjectIds,['A']);f.close();
});

test('unknown fields, forged refs, out-of-range floors, duplicate proposals and ungrounded evidence never save',async()=>{
  for(const mutate of [p=>p.messageRef={},p=>p.floor=20,p=>p.roster.paragraphs=[{id:'P1',text:'forged'}],p=>p.events[0].evidence='A穿上外套。',p=>p.events[0].offset=0]){
    const f=await fixture(),draft=proposal();mutate(draft);await assert.rejects(f.session.publish([draft]));assert.equal(f.saves,0);assert.equal(Object.hasOwn(f.store,'storyboardContinuity'),false);f.close();
  }
  const f=await fixture();await assert.rejects(f.session.publish([proposal(),proposal()]));assert.equal(f.saves,0);f.close();
});

test('cached facts are not reused after text, swipe, selected preprocessing, or character owner changes',async()=>{
  const f=await fixture();await f.session.publish([proposal()]);const baseline=JSON.parse(f.saved);f.close();
  for(const variant of ['text','swipe','paragraphs','owner','account','chat']){
    const current=await fixture({metadata:structuredClone(baseline),...(variant==='paragraphs'?{paragraphs:message=>[{id:'P1',text:message.mes+' changed filtering'}]}:{}),...(variant==='account'?{account:'st-user:bob'}:{})});
    current.close();
    if(variant==='text')current.context.chat[0].mes='A重新穿上外套。';
    if(variant==='swipe')current.context.chat[0].swipe_id=1;
    if(variant==='owner')current.context.characters[0].avatar='B.png';
    if(variant==='chat'){current.context.chatId='renamed';current.context.characters[0].chat='renamed';}
    const window=await captureStoryboardCompilerSources(current.options),session=openStoryboardCompilerContinuity(window),before=JSON.stringify(current.metadata);
    const result=await session.read();assert.equal(result.records.length,0,variant);assert.equal(JSON.stringify(current.metadata),before,'reading stale cache never deletes it');assert.equal(current.saves,0);
    session.close();window.close();
  }
});

test('a cached floor outside the current reference selection is not read or sent to the compiler',async()=>{
  const f=await fixture();await f.session.publish([proposal()]);f.close();
  const window=await captureStoryboardCompilerSources({...f.options,referenceFloors:0}),session=openStoryboardCompilerContinuity(window);
  assert.equal((await session.read()).records.length,0);session.close();window.close();
});

test('corrupt, future, oversized and foreign-owner metadata remains untouched and does not authorize replacement',async()=>{
  const f=await fixture();await f.session.publish([proposal()]);const baseline=JSON.parse(f.saved);f.close();
  for(const mutate of [x=>x.schema='future',x=>x.owner.namespace='st-user:other',x=>x.records[0].extra='secret',x=>x.records[0].events[0].value='x'.repeat(1001),x=>x.records.push(x.records[0])]){
    const metadata=structuredClone(baseline);mutate(metadata.story_director_liminale.storyboardContinuity);
    const current=await fixture({metadata}),before=JSON.stringify(metadata),read=await current.session.read();
    assert.equal(read.status,'unavailable');assert.equal((await current.session.publish([proposal()])).status,'unavailable');assert.equal(JSON.stringify(metadata),before);assert.equal(current.saves,0);current.close();
  }
});

test('changing account, source or local cache during admission prevents any host write',async()=>{
  for(const kind of ['account','source','cache']){
    const f=await fixture(),wait=deferred();f.lookup=()=>wait.promise;const pending=f.session.publish([proposal()]);
    if(kind==='source')f.context.chat[0].mes='edited';
    if(kind==='cache')f.store.storyboardContinuity={schema:'future'};
    wait.resolve(kind==='account'?'st-user:bob':'st-user:alice');
    if(kind==='cache')assert.equal((await pending).status,'unavailable');else await assert.rejects(pending);
    assert.equal(f.saves,0);f.close();
  }
});

test('host save failures are unconfirmed, never silently retried or rolled back over a newer field',async()=>{
  for(const kind of ['throw','change']){
    const f=await fixture();f.saveHook=()=>{if(kind==='change')f.store.storyboardContinuity={schema:'newer-field'};throw Error('synthetic host failure');};
    const result=await f.session.publish([proposal()]);assert.equal(result.status,'unconfirmed');assert.equal(f.saves,1);
    assert.equal(f.store.storyboardContinuity.schema,kind==='change'?'newer-field':STORYBOARD_CONTINUITY_STORE_SCHEMA);f.close();
  }
});

test('a timed-out host promise keeps the shared save lock until it settles, even after the compiler closes',async()=>{
  const f=await fixture(),wait=deferred();f.saveHook=()=>wait.promise;
  assert.equal((await f.session.publish([proposal()])).reason,'host_pending');assert.equal(f.session.pending,true);
  const token={};assert.equal(acquireChatSaveLock(f.store,token),false);await assert.rejects(f.session.publish([proposal()]));f.close();
  assert.equal(acquireChatSaveLock(f.store,token),false);wait.resolve();await new Promise(resolve=>setImmediate(resolve));
  assert.equal(acquireChatSaveLock(f.store,token),true);releaseChatSaveLock(f.store,token);assert.equal(f.saves,1);
});

test('another guarded ST metadata writer blocks cache publication without replacing its metadata',async()=>{
  const f=await fixture(),token={};assert.equal(acquireChatSaveLock(f.store,token),true);
  assert.equal((await f.session.publish([proposal()])).reason,'host_save_busy');assert.equal(f.saves,0);assert.equal(Object.hasOwn(f.store,'storyboardContinuity'),false);releaseChatSaveLock(f.store,token);f.close();
});

test('retention stays bounded to 21 recently published source records, including revisiting an old floor',async()=>{
  const texts=Array.from({length:30},()=> 'A脱下外套。'),f=await fixture({texts,floor:20});
  await f.session.publish(Array.from({length:21},(_,floor)=>proposal(floor)));f.close();
  for(const floor of [29,0]){
    const window=await captureStoryboardCompilerSources({...f.options,floor,referenceFloors:0}),session=openStoryboardCompilerContinuity(window);
    assert.equal((await session.publish([proposal(floor)])).status,'host_returned');assert.equal(f.store.storyboardContinuity.records.length,21);assert.equal(f.store.storyboardContinuity.records[0].messageRef.lastKnownFloor,floor);
    session.close();window.close();
  }
  assert.deepEqual(f.store.storyboardImages,[{id:'original-image'}]);
});

test('new accepted empty event records replace obsolete facts without relying on whether an image was generated',async()=>{
  const f=await fixture();await f.session.publish([proposal()]);const update={floor:0,roster:structuredClone(roster),events:[]};
  assert.equal((await f.session.publish([update])).status,'host_returned');assert.deepEqual((await f.session.read()).records[0].events,[]);assert.equal(f.store.storyboardContinuity.revision,2);f.close();
});

test('source changes while ST save settles do not write or retry into the new chat',async()=>{
  const f=await fixture(),wait=deferred(),called=deferred();f.saveHook=()=>{called.resolve();return wait.promise;};
  const pending=f.session.publish([proposal()]);await called.promise;const original=f.store;
  f.context.chatMetadata={story_director_liminale:{newChat:true}};wait.resolve();
  assert.equal((await pending).reason,'source_changed');assert.equal(f.saves,1);assert.deepEqual(f.store,{newChat:true});assert.ok(original.storyboardContinuity);f.close();
});

test('concurrent in-place changes during a read are not returned as a verified snapshot',async()=>{
  const f=await fixture();await f.session.publish([proposal()]);const wait=deferred();f.lookup=()=>wait.promise;
  const pending=f.session.read();f.store.storyboardContinuity.records[0].events[0].value='newer';wait.resolve('st-user:alice');
  await assert.rejects(pending,{code:'storyboard_continuity_storage'});assert.equal(f.saves,1);f.close();
});

test('a later local field superseding the pending save is reported without overwriting it',async()=>{
  const f=await fixture(),wait=deferred(),called=deferred();f.saveHook=()=>{called.resolve();return wait.promise;};
  const pending=f.session.publish([proposal()]);await called.promise;
  f.store.storyboardContinuity={schema:'newer-field'};wait.resolve();assert.equal((await pending).reason,'local_changed');assert.equal(f.store.storyboardContinuity.schema,'newer-field');assert.equal(f.saves,1);f.close();
});

test('repeated operations do not change unrelated chat metadata and missing host persistence is explicit',async()=>{
  const f=await fixture();f.close();delete f.context.saveMetadata;
  const window=await captureStoryboardCompilerSources(f.options),session=openStoryboardCompilerContinuity(window),before=JSON.stringify(f.metadata);
  assert.equal((await session.publish([proposal()])).reason,'host_save_unavailable');assert.equal(JSON.stringify(f.metadata),before);session.close();window.close();
});

test('closing while account admission waits releases the pre-save lock and late resolution cannot stage a record',async()=>{
  const f=await fixture(),wait=deferred();f.lookup=()=>wait.promise;const pending=f.session.publish([proposal()]);
  const token={};assert.equal(acquireChatSaveLock(f.store,token),false);f.session.close();assert.equal(acquireChatSaveLock(f.store,token),true);
  wait.resolve('st-user:alice');await assert.rejects(pending);assert.equal(f.saves,0);assert.equal(Object.hasOwn(f.store,'storyboardContinuity'),false);
  releaseChatSaveLock(f.store,token);f.close();
});
