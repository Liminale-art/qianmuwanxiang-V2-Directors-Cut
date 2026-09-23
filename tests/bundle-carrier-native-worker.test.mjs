import test from 'node:test';import assert from 'node:assert/strict';import vm from 'node:vm';import {readFile} from 'node:fs/promises';
import {characterNativeFixture} from './helpers/character-native-fixture.mjs';
import {carrierLegacyFixture} from './helpers/carrier-legacy-fixture.mjs';
import {carrierFixture,namespace} from './fixtures/bundle-carriers.mjs';
import {createBundleCarrierStore} from '../qianmu-bundle-carrier-store.js';
import {runRestoreStorage} from '../qianmu-storyboard-restore-storage-runtime.js';
import {characterWorkerStorageOptions} from '../qianmu-character-worker-storage.js';
const origin='https://st.fixture.invalid';
async function fixture(t){
  const f=await characterNativeFixture(t,{account:namespace}),source=await carrierFixture(),old=carrierLegacyFixture(source);
  const store=createBundleCarrierStore({native:{createStorage:f.createStorage},indexedDB:old.indexedDB,keyRange:old.keyRange});t.after(()=>store.close());await store.list(namespace);
  const empty=carrierLegacyFixture();f.configure();t.mock.method(globalThis,'fetch',f.fetchImpl);
  for(const [name,value] of [['indexedDB',empty.indexedDB],['IDBKeyRange',empty.keyRange]]){
    const prior=Object.getOwnPropertyDescriptor(globalThis,name);Object.defineProperty(globalThis,name,{configurable:true,value});
    t.after(()=>{if(prior)Object.defineProperty(globalThis,name,prior);else delete globalThis[name];});
  }return Object.assign(f,{source,empty});
}
function installWorker(t){
  const prior=Object.getOwnPropertyDescriptor(globalThis,'self');
  class Worker{
    static last;
    constructor(url){Worker.last=this;this.events={};this.sent=[];this.received=[];const scope={location:{origin},addEventListener:(_,fn)=>this.receive=fn,
      postMessage:value=>{this.received.push(structuredClone(value));if(!this.closed)this.events.message?.({data:structuredClone(value)});},close:()=>this.workerClosed=true};
      Object.defineProperty(globalThis,'self',{configurable:true,value:scope});this.ready=import(url.href+'?carrier-native='+crypto.randomUUID());}
    addEventListener(name,fn){this.events[name]=fn;}
    postMessage(value){this.sent.push(structuredClone(value));void this.ready.then(()=>{if(!this.closed)return this.receive({data:value});}).catch(error=>this.events.error?.(error));}
    terminate(){this.closed=true;}
  }
  t.after(()=>{if(prior)Object.defineProperty(globalThis,'self',prior);else delete globalThis.self;});return Worker;
}
test('real accounting worker lists remote carrier proofs and orphan originals on a client with empty IDB',async t=>{
  const f=await fixture(t),Worker=installWorker(t);f.reset();let guards=0;
  const summary=await runRestoreStorage('carriers',{namespace,guard:async()=>{guards++;},WorkerClass:Worker});
  assert.equal(summary.count,2);assert.equal(summary.originalCount,4);assert.ok(guards>10);assert.equal(f.uploads,0);
  assert.deepEqual(Worker.last.sent[0].nativeHistory,{namespace,origin,csrf:'synthetic'});assert.equal(Worker.last.closed,true);
  assert.deepEqual(Worker.last.received.filter(value=>value.progress).map(value=>value.progress),[1]);
  assert.equal(f.calls.filter(row=>row.request.method==='GET').length,2);
});
test('real accounting worker fails on live identity loss without leaking the stale inventory',async t=>{
  const f=await fixture(t),Worker=installWorker(t);let active=true;f.hook(call=>{if(call.path.includes('-carrier-library-'))active=false;});
  await assert.rejects(runRestoreStorage('carriers',{namespace,guard:async()=>{if(!active)throw Error('changed');},WorkerClass:Worker}),/changed/);assert.equal(Worker.last.closed,true);
});
for(const restore of [false,true])test(`real bundle ${restore?'restore':'capture'} worker factory hands validated native source store to the coordinator`,async t=>{
  const f=await fixture(t),file=restore?'qianmu-storyboard-bundle-restore-worker.js':'qianmu-storyboard-bundle-worker.js';
  const source=(await readFile(new URL('../'+file,import.meta.url),'utf8')).replace(/^import[^\n]*\n/gm,'');let handler,carriers;const posts=[];
  const self={location:{origin},addEventListener:(_,fn)=>handler=fn,postMessage:value=>{posts.push(value);
    if(value.guard)queueMicrotask(()=>handler({data:{guard:value.guard}}));
    if(value.kind==='guard')queueMicrotask(()=>handler({data:{type:'rpc',id:value.id,operation:value.operation,request:value.request,result:true}}));
  },close(){}};
  const stub=()=>({close(){}}),process=async options=>{carriers=options.carrierStore;assert.equal(carriers.persistence,'st-account-file');
    const value=await carriers.list(namespace);assert.equal(value.heads.length,2);assert.equal(value.originals.length,4);return {sourceDigest:'a'.repeat(64),close(){}};};
  vm.runInNewContext(source,{self,characterWorkerStorageOptions,createBundleCarrierStore:options=>createBundleCarrierStore({...options,indexedDB:f.empty.indexedDB,keyRange:f.empty.keyRange}),
    createStoryboardPackageJournal:stub,createComfyWorkflowStore:stub,createComfyPoolStore:stub,createCharacterArchiveStore:stub,createVibeAssetStore:stub,
    createStoryboardPackageStage:stub,createImageRestoreClient:stub,createSourceIdentityClient:stub,captureStoryboardResourceBundle:process,createStoryboardBundleRestoreSession:process});
  const payload={namespace,chatKey:'chat',file:new Blob(),csrf:'synthetic',nativeCharacters:{namespace,origin,csrf:'synthetic'}};
  await handler({data:restore?{id:'test',operation:1,type:'command',action:'open',payload}:{action:'capture',...payload}});
  assert.ok(carriers);assert.ok(!posts.some(value=>value.error));
  assert.deepEqual(posts.filter(value=>value.progress).map(value=>value.progress),[1]);carriers.close();
});
