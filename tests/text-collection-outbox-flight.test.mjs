import test from 'node:test';
import assert from 'node:assert/strict';
import {createTextCollectionOutboxRuntime} from '../qianmu-text-collection-outbox-runtime.js';
import {createCollectionAutosave} from '../qianmu-text-collection-autosave.js';
import {emptyTextCollectionOutbox,validateTextCollectionOutbox} from '../qianmu-text-collection-outbox-store.js';
import {createTextCollection} from '../qianmu-text-collection.js';
import {textCollectionSyncError as error} from '../qianmu-text-collection-sync-contract.js';

const account='st-user:'+'a'.repeat(64),other='st-user:'+'b'.repeat(64);
const gate=()=>{let resolve;return {promise:new Promise(done=>{resolve=done;}),resolve};};
const settle=()=>new Promise(resolve=>setImmediate(resolve));
function request(namespace=account,id='mutation-1'){
  const record=createTextCollection({id:'collection-'+id,createdAt:1,mode:'full',source:{account:namespace,chatId:'old-chat',messageId:0,replyId:'reply-1',charName:'CHAR',userName:'USER',text:'完整收藏正文😀'}});
  return {version:1,expectedAccount:namespace,mutationId:id,operation:'create',id:record.id,baseRevision:0,record};
}
const receipt=input=>({ok:true,version:1,expectedAccount:input.expectedAccount,libraryRevision:1,mutationId:input.mutationId,id:input.id,revision:1,updatedAt:input.record.updatedAt});
function fixture(){
  const states=new Map(),sent=[],entered=gate(),release=gate();let mode='ok',updates=0;
  const state=namespace=>states.get(namespace)||emptyTextCollectionOutbox(namespace);
  const store={read:async(namespace,{guard})=>{assert.equal(guard(),true);return structuredClone(state(namespace));},update:async(namespace,mutate,{guard})=>{
    assert.equal(guard(),true);const next=structuredClone(state(namespace));mutate(next);validateTextCollectionOutbox(next,namespace);assert.equal(guard(),true);updates++;states.set(namespace,next);return structuredClone(next);
  }};
  function participant(namespace=account){
    let live=true;
    const session={expectedAccount:namespace,guard:async()=>{if(!live)throw error('account','changed',401);},close(){live=false;},resumePending:input=>({submit:async({signal}={})=>{
      sent.push(structuredClone(input));entered.resolve();const stopped=gate(),abort=()=>stopped.resolve();signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
      try{await Promise.race([release.promise,stopped.promise]);if(signal?.aborted)throw error('cancelled','stopped');if(mode==='lost')throw error('connection','lost',503);return receipt(input);}
      finally{signal?.removeEventListener('abort',abort);}
    }})};
    const runtime=createTextCollectionOutboxRuntime({session,store,isCurrent:()=>live,now:()=>2});
    return {session,runtime,invalidate(){live=false;}};
  }
  return {store,sent,entered,release,participant,get updates(){return updates;},state:namespace=>structuredClone(state(namespace||account)),change:fn=>fn(states.get(account)),set mode(value){mode=value;}};
}

test('UI and recovery runtimes share one exact in-flight request and one durable retirement',async()=>{
  const f=fixture(),ui=f.participant(),recovery=f.participant(),input=request();await ui.runtime.enqueue(input);
  const first=ui.runtime.submit(input.mutationId);await f.entered.promise;const second=recovery.runtime.submit(input.mutationId);assert.equal(second,recovery.runtime.submit(input.mutationId));await settle();
  assert.equal(f.sent.length,1);assert.equal(f.state().entries[0].started,true);f.release.resolve();
  assert.deepEqual(await second,await first);assert.equal(f.sent.length,1);assert.equal(f.updates,3,'enqueue, one start and one retirement only');assert.deepEqual(f.state().entries,[]);
  ui.runtime.close();recovery.runtime.close();
});

test('independently created default outbox stores share the same in-flight durable account task',async t=>{
  const rows=new Map(),database={close(){},transaction(){let aborted=false;const tx={abort(){aborted=true;queueMicrotask(()=>tx.onabort?.());},objectStore(){return {
    get(namespace){const operation={};queueMicrotask(()=>{if(aborted)return;operation.result=structuredClone(rows.get(namespace));operation.onsuccess?.();queueMicrotask(()=>{if(!aborted)tx.oncomplete?.();});});return operation;},
    put(state){rows.set(state.namespace,structuredClone(state));}
  };}};return tx;}},indexedDB={open(name){assert.equal(name,'qianmu-text-collection-outbox');const operation={};queueMicrotask(()=>{operation.result=database;operation.onsuccess?.();});return operation;}};
  const prior=Object.getOwnPropertyDescriptor(globalThis,'indexedDB');Object.defineProperty(globalThis,'indexedDB',{configurable:true,value:indexedDB});
  t.after(()=>{if(prior)Object.defineProperty(globalThis,'indexedDB',prior);else delete globalThis.indexedDB;});
  const f=fixture(),a=f.participant(),b=f.participant(),ui=createTextCollectionOutboxRuntime({session:a.session,now:()=>2}),recovery=createTextCollectionOutboxRuntime({session:b.session,now:()=>2}),input=request();
  await ui.enqueue(input);const first=ui.submit(input.mutationId);await f.entered.promise;const second=recovery.submit(input.mutationId);await settle();assert.equal(f.sent.length,1);
  f.release.resolve();assert.deepEqual(await first,await second);assert.deepEqual((await recovery.list()),[]);ui.close();recovery.close();a.runtime.close();b.runtime.close();
});

test('actual autosave three-second wake joins a still-running explicit UI save instead of resubmitting',async()=>{
  const f=fixture(),ui=f.participant(),window=new EventTarget(),document=new EventTarget(),timers=new Map();let serial=0,changes=0;
  window.navigator={onLine:true};window.setTimeout=(fn,delay)=>{timers.set(++serial,{fn,delay});return serial;};window.clearTimeout=id=>timers.delete(id);document.hidden=false;
  document.addEventListener('qianmu-text-collections-changed',()=>changes++);
  const auto=createCollectionAutosave({window,document,isCurrent:()=>true,sessionFactory:async()=>f.participant().session,outboxFactory:({session,isCurrent})=>createTextCollectionOutboxRuntime({session,store:f.store,isCurrent,now:()=>2})});
  auto.start();await auto.wake();const saving=ui.runtime.save(request());await f.entered.promise;
  window.dispatchEvent(new Event('qianmu-collection-save-queued'));const [id,timer]=timers.entries().next().value;assert.equal(timer.delay,3000);timers.delete(id);timer.fn();const recovering=auto.wake();await settle();
  assert.equal(f.sent.length,1,'the delayed recovery must not add a second native submission');f.release.resolve();await saving;await recovering;
  assert.deepEqual(f.state().entries,[]);assert.equal(f.updates,3);assert.equal(changes,1);assert.equal(timers.size,0);auto.close();ui.runtime.close();
});

for(const action of ['close','abort','preabort','account'])test(`joining runtime ${action} cannot cancel or adopt the owner's operation`,async()=>{
  const f=fixture(),ui=f.participant(),recovery=f.participant(),input=request();await ui.runtime.enqueue(input);const first=ui.runtime.submit(input.mutationId);await f.entered.promise;
  const controller=new AbortController();if(action==='preabort')controller.abort();const joined=recovery.runtime.submit(input.mutationId,{signal:controller.signal}),rejected=assert.rejects(joined);
  if(action!=='preabort'){await settle();if(action==='close')recovery.runtime.close();if(action==='abort')controller.abort();if(action==='account')recovery.invalidate();}
  if(action==='account')f.release.resolve();await rejected;assert.equal(f.sent.length,1);if(action!=='account')assert.equal(f.state().entries.length,1);
  f.release.resolve();assert.equal((await first).status,'confirmed');assert.equal(f.state().entries.length,0);ui.runtime.close();recovery.runtime.close();
});

test('owner closure propagates unconfirmed failure without transferring or automatically retrying the request',async()=>{
  const f=fixture(),ui=f.participant(),recovery=f.participant(),input=request();await ui.runtime.enqueue(input);const first=ui.runtime.submit(input.mutationId),firstRejected=assert.rejects(first);await f.entered.promise;
  const second=recovery.runtime.submit(input.mutationId),secondRejected=assert.rejects(second);await settle();ui.runtime.close();await firstRejected;await secondRejected;
  assert.equal(f.sent.length,1);assert.equal(f.state().entries[0].started,true);assert.deepEqual(f.state().entries[0].request,input);
  f.release.resolve();assert.equal((await recovery.runtime.submit(input.mutationId)).status,'confirmed');assert.deepEqual(f.sent,[input,input]);assert.deepEqual(f.state().entries,[]);recovery.runtime.close();
});

test('one lost acknowledgement rejects all participants and a later retry keeps the exact durable identity',async()=>{
  const f=fixture(),ui=f.participant(),recovery=f.participant(),input=request();await ui.runtime.enqueue(input);f.mode='lost';
  const first=ui.runtime.submit(input.mutationId),firstRejected=assert.rejects(first);await f.entered.promise;const second=recovery.runtime.submit(input.mutationId),secondRejected=assert.rejects(second);await settle();f.release.resolve();
  await firstRejected;await secondRejected;assert.deepEqual(f.sent,[input]);assert.deepEqual(f.state().entries[0].request,input);
  f.mode='ok';assert.equal((await recovery.runtime.submit(input.mutationId)).status,'confirmed');assert.deepEqual(f.sent,[input,input]);ui.runtime.close();recovery.runtime.close();
});

test('same operation id with changed durable request cannot borrow another in-flight result',async()=>{
  const f=fixture(),ui=f.participant(),recovery=f.participant(),input=request();await ui.runtime.enqueue(input);const first=ui.runtime.submit(input.mutationId),firstRejected=assert.rejects(first);await f.entered.promise;
  f.change(state=>{state.entries[0].request.record.source.charName='OTHER';});await assert.rejects(recovery.runtime.submit(input.mutationId),{code:'text_collection_sync_local_conflict'});
  assert.equal(f.sent.length,1);f.release.resolve();await firstRejected;assert.equal(f.state().entries.length,1);ui.runtime.close();recovery.runtime.close();
});

test('another runtime cannot remove a durable row while its shared original submission is running',async()=>{
  const f=fixture(),ui=f.participant(),recovery=f.participant(),input=request();await ui.runtime.enqueue(input);const first=ui.runtime.submit(input.mutationId);await f.entered.promise;
  const row=(await recovery.runtime.list())[0];await assert.rejects(recovery.runtime.remove(row,{confirmed:true,acceptUnconfirmed:true}),{code:'text_collection_sync_busy'});
  assert.equal(f.state().entries.length,1);assert.equal(f.sent.length,1);f.release.resolve();await first;ui.runtime.close();recovery.runtime.close();
});

test('in-flight scheduling is isolated by account, operation identity and injected durable store',async()=>{
  for(const kind of ['account','operation','store']){
    const f=fixture(),g=kind==='store'?fixture():f,ui=f.participant(),recovery=g.participant(kind==='account'?other:account),one=request(),two=request(kind==='account'?other:account,kind==='operation'?'mutation-2':'mutation-1');
    await ui.runtime.enqueue(one);await recovery.runtime.enqueue(two);const first=ui.runtime.submit(one.mutationId),second=recovery.runtime.submit(two.mutationId);await settle();
    assert.equal(f.sent.length+(g===f?0:g.sent.length),2,kind+' is not the same durable task');f.release.resolve();g.release.resolve();await first;await second;ui.runtime.close();recovery.runtime.close();
  }
});
