import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {characterNativeFixture,namespace} from './helpers/character-native-fixture.mjs';
import {mappingLegacyFixture} from './helpers/mapping-legacy-fixture.mjs';
import {mappingReceiptsFixture} from './fixtures/storyboard-mapping-receipts.mjs';
import {createStoryboardPackageJournal} from '../qianmu-storyboard-package-journal.js';
import {createNativeMappingJournal} from '../qianmu-mapping-journal-native.js';
import {runRestoreStorage} from '../qianmu-storyboard-restore-storage-runtime.js';
import {characterWorkerStorageOptions} from '../qianmu-character-worker-storage.js';
const origin='https://st.fixture.invalid';
async function fixture(t){
  const f=await characterNativeFixture(t),rows=await mappingReceiptsFixture({namespace}),local=mappingLegacyFixture();
  const a=createNativeMappingJournal({legacy:local.open(),createStorage:f.createStorage});t.after(()=>a.close());
  for(const row of rows)await a.importMappingReceipt(row.receipt,{head:row.head,confirmed:true});
  f.configure();t.mock.method(globalThis,'fetch',f.fetchImpl);
  for(const [name,value] of [['indexedDB',local.indexedDB],['IDBKeyRange',local.keyRange]]){
    const old=Object.getOwnPropertyDescriptor(globalThis,name);Object.defineProperty(globalThis,name,{configurable:true,value});
    t.after(()=>{if(old)Object.defineProperty(globalThis,name,old);else delete globalThis[name];});
  }
  return Object.assign(f,{rows,local});
}
function installWorker(t){
  const prior=Object.getOwnPropertyDescriptor(globalThis,'self');
  class Worker{
    static last;
    constructor(url){Worker.last=this;this.events={};this.sent=[];const scope={location:{origin},addEventListener:(_,fn)=>this.receive=fn,
      postMessage:value=>{if(!this.closed)this.events.message?.({data:structuredClone(value)});},close:()=>this.workerClosed=true};
      Object.defineProperty(globalThis,'self',{configurable:true,value:scope});this.ready=import(url.href+'?mapping-test='+crypto.randomUUID());}
    addEventListener(name,fn){this.events[name]=fn;}
    postMessage(value){this.sent.push(structuredClone(value));void this.ready.then(()=>{if(!this.closed)return this.receive({data:value});}).catch(error=>this.events.error?.(error));}
    terminate(){this.closed=true;}
  }
  t.after(()=>{if(prior)Object.defineProperty(globalThis,'self',prior);else delete globalThis.self;});return Worker;
}

test('actual storage worker registry/export use native receipts with no local originals or model credentials',async t=>{
  const f=await fixture(t),Worker=installWorker(t);let checks=0;
  const options={namespace,guard:async()=>{checks++;},WorkerClass:Worker};f.reset();
  const page=await runRestoreStorage('mapping-list',{...options,input:{kind:'all',query:'',offset:0}});assert.equal(page.total,4);
  assert.deepEqual(Worker.last.sent[0].nativeHistory,{namespace,origin,csrf:'synthetic'});assert.equal(Worker.last.sent[0].nativeCharacters,undefined);
  const exported=await runRestoreStorage('mapping-export',{...options,input:{kind:'subjects',digest:f.rows[1].head.digest}});
  assert.deepEqual(JSON.parse(await exported.file.text()).receipt,f.rows[1].receipt);assert.ok(checks>10);assert.equal(Worker.last.closed,true);assert.equal(f.uploads,0);
});

test('actual registry worker fails on lost live identity instead of returning private records',async t=>{
  const f=await fixture(t),Worker=installWorker(t);let active=true;f.hook(call=>{if(call.path.includes('-mapping-library-'))active=false;});
  await assert.rejects(runRestoreStorage('mapping-list',{namespace,guard:async()=>{if(!active)throw Error('changed');},WorkerClass:Worker,input:{kind:'all',query:'',offset:0}}),/changed/);
  assert.equal(Worker.last.closed,true);
});

test('USER alias worker handoff includes both role and receipt storage on the same account',async t=>{
  const f=await fixture(t);let payload;
  class StopWorker{constructor(){this.events={};}addEventListener(name,fn){this.events[name]=fn;}postMessage(value){payload=value;queueMicrotask(()=>this.events.message({data:{id:value.id,error:{message:'stopped before changes'}}}));}terminate(){}}
  await assert.rejects(runRestoreStorage('user-alias-preview',{namespace,chatHash:'a'.repeat(64),input:{choices:{},offset:0},resolveAliasTargets:async()=>[],guard:async()=>{},WorkerClass:StopWorker}),/stopped/);
  assert.deepEqual(payload.nativeHistory,{namespace,origin,csrf:'synthetic'});assert.deepEqual(payload.nativeCharacters,payload.nativeHistory);
});

for(const restore of [false,true])test(`actual bundle ${restore?'restore':'capture'} worker factory uses ST mapping journal before resource processing`,async t=>{
  const f=await fixture(t),file=restore?'qianmu-storyboard-bundle-restore-worker.js':'qianmu-storyboard-bundle-worker.js';
  const source=(await readFile(new URL('../'+file,import.meta.url),'utf8')).replace(/^import[^\n]*\n/gm,'');let handler,journal;const posts=[];
  const self={location:{origin},addEventListener:(_,fn)=>handler=fn,postMessage:value=>{posts.push(value);
    if(value.guard)queueMicrotask(()=>handler({data:{guard:value.guard}}));
    if(value.kind==='guard')queueMicrotask(()=>handler({data:{type:'rpc',id:value.id,operation:value.operation,request:value.request,result:true}}));
  },close(){}};
  const createStub=()=>({close(){}}),process=async options=>{journal=options.journal;const heads=await journal.listMappingHeads(namespace);assert.equal(heads.length,4);return {sourceDigest:'a'.repeat(64),close(){}};};
  vm.runInNewContext(source,{self,characterWorkerStorageOptions,createStoryboardPackageJournal:options=>createStoryboardPackageJournal({...options,indexedDB:f.local.indexedDB,keyRange:f.local.keyRange}),
    createComfyWorkflowStore:createStub,createComfyPoolStore:createStub,createCharacterArchiveStore:createStub,createVibeAssetStore:createStub,createBundleCarrierStore:createStub,
    createStoryboardPackageStage:createStub,createImageRestoreClient:createStub,createSourceIdentityClient:createStub,
    captureStoryboardResourceBundle:process,createStoryboardBundleRestoreSession:process});
  const payload={namespace,chatKey:'chat',file:new Blob(),csrf:'synthetic',nativeCharacters:{namespace,origin,csrf:'synthetic'}};
  await handler({data:restore?{id:'test',operation:1,type:'command',action:'open',payload}:{action:'capture',...payload}});
  assert.ok(journal);assert.equal(journal.mappingPersistence,'st-account-file');assert.ok(!posts.some(value=>value.error));journal.close();
});
