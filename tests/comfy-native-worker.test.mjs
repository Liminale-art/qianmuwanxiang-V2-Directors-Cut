import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {createComfyWorkflowStore} from '../qianmu-comfy-library.js';
import {createComfyPoolStore} from '../qianmu-comfy-pool-store.js';
import {createComfySceneLockStore} from '../qianmu-comfy-lock-store.js';
import {COMFY_SELECTION_SCHEMA} from '../qianmu-comfy-selection.js';
import {comfySceneIdbFixture,comfySceneJournalFixture} from './helpers/comfy-scene-idb-fixture.mjs';
import {runRestoreStorage} from '../qianmu-storyboard-restore-storage-runtime.js';
import {characterWorkerStorageOptions} from '../qianmu-character-worker-storage.js';
import {characterNativeFixture,namespace} from './helpers/character-native-fixture.mjs';
import {comfyLibraryIdbFixture} from './helpers/comfy-library-idb-fixture.mjs';
import {poolNativeFixture} from './helpers/comfy-pool-native-fixture.mjs';
const origin='https://st.fixture.invalid',context={namespace,origin,csrf:'synthetic'};

test('actual storage Worker uses the native scene catalogue with its live account guard and never writes during inventory',async t=>{
  const f=await characterNativeFixture(t),old=comfySceneIdbFixture(),journal=comfySceneJournalFixture();
  property(t,'indexedDB',{open:(name,...args)=>(name==='qianmu-comfy-scene-runtime'?journal:old).indexedDB.open(name,...args)});property(t,'IDBKeyRange',old.keyRange);f.configure();t.mock.method(globalThis,'fetch',f.fetchImpl);
  const store=createComfySceneLockStore();t.after(()=>store.close());const scope={namespace,chatKey:'chat',continuityId:'scene',narrativeLayer:'present'},lock={schema:COMFY_SELECTION_SCHEMA,scope,poolKey:'a'.repeat(64),candidateId:'candidate',executionKey:'b'.repeat(64)};
  const reserved=await store.reserve(scope,{lock,expectedRevision:0,expectedGeneration:0,attemptId:'shot',ownerId:'page',token:'ticket'});await store.begin(reserved.receipt);await store.settle(reserved.receipt,'succeeded');
  const Worker=installWorker(t);f.reset();const summary=await runRestoreStorage('comfy',{namespace,guard:async()=>{},WorkerClass:Worker});
  assert.deepEqual(Worker.last.sent[0].nativeComfy,context);assert.equal(summary.scenes.status,'ready');assert.equal(summary.scenes.count,1);assert.equal(summary.scenes.generation,0);assert.equal(f.uploads,0);assert.equal(old.state.writes.length,0);assert.equal(Worker.last.closed,true);
});
function property(t,key,value){const prior=Object.getOwnPropertyDescriptor(globalThis,key);Object.defineProperty(globalThis,key,{value,configurable:true,writable:true});t.after(()=>{if(prior)Object.defineProperty(globalThis,key,prior);else delete globalThis[key];});}
function installWorker(t){
  const prior=Object.getOwnPropertyDescriptor(globalThis,'self');
  class Worker{
    static last;
    constructor(url){Worker.last=this;this.events={};this.sent=[];this.closed=false;const self={location:{origin},addEventListener:(_,listener)=>this.receive=listener,postMessage:value=>{if(!this.closed)this.events.message?.({data:structuredClone(value)});},close:()=>this.workerClosed=true};Object.defineProperty(globalThis,'self',{value:self,configurable:true});this.ready=import(url.href+'?comfy-native='+crypto.randomUUID());}
    addEventListener(type,callback){this.events[type]=callback;}
    postMessage(value){this.sent.push(structuredClone(value));void this.ready.then(()=>{if(!this.closed)return this.receive({data:value});}).catch(error=>this.events.error?.(error));}
    terminate(){this.closed=true;}
  }
  t.after(()=>{if(prior)Object.defineProperty(globalThis,'self',prior);else delete globalThis.self;});return Worker;
}
async function fixture(t){
  const f=await characterNativeFixture(t),local=comfyLibraryIdbFixture();property(t,'indexedDB',local.indexedDB);property(t,'IDBKeyRange',local.keyRange);f.configure();t.mock.method(globalThis,'fetch',f.fetchImpl);
  const store=createComfyWorkflowStore();t.after(()=>store.close());await store.save(namespace,{name:'Workflow',document:{workflow:{a:{class_type:'CLIPTextEncode',inputs:{text:'%qianmu_prompt%'}},b:{class_type:'SaveImage',inputs:{images:['a',0]}}}}});return {...f,local,store};
}
test('real storage Worker handoff reads native workflow metadata, does not upload graphs, and reports remaining local pools separately',async t=>{
  const f=await fixture(t),Worker=installWorker(t);f.reset();let guards=0;
  const summary=await runRestoreStorage('comfy',{namespace,guard:async()=>{guards++;},WorkerClass:Worker});
  assert.deepEqual(Worker.last.sent[0].nativeComfy,context);assert.equal(Worker.last.sent[0].nativeCharacters,undefined);assert.equal(summary.workflows.count,1);assert.equal(summary.workflows.versions,1);assert.equal(summary.pools.status,'unavailable');
  assert.equal(Worker.last.closed,true);assert.ok(guards>5);assert.ok(!f.calls.some(call=>call.request.method==='POST'||call.path.includes('-comfy-workflow-version-')));
});
test('live account loss during Worker inventory rejects the result without empty-library fallback or uploads',async t=>{
  const f=await fixture(t),Worker=installWorker(t);f.reset();let active=true;f.hook(call=>{if(call.path.includes('-comfy-workflow-library-'))active=false;});
  await assert.rejects(runRestoreStorage('comfy',{namespace,guard:async()=>{if(!active)throw Error('account changed');},WorkerClass:Worker}),/account changed/);
  assert.equal(Worker.last.closed,true);assert.ok(!f.calls.some(call=>call.request.method==='POST'));
});

for(const restore of [false,true])test(`actual bundle ${restore?'restore':'capture'} worker workflow factory reads the complete native version with its captured live account`,async t=>{
  const f=await fixture(t),head=(await f.store.list(namespace))[0],file=restore?'qianmu-storyboard-bundle-restore-worker.js':'qianmu-storyboard-bundle-worker.js';
  const source=(await readFile(new URL('../'+file,import.meta.url),'utf8')).replace(/^import[^\n]*\n/gm,'');let handler,workflow;const posts=[];
  const self={location:{origin},addEventListener:(_,fn)=>handler=fn,postMessage:value=>{posts.push(value);if(value.guard)queueMicrotask(()=>handler({data:{guard:value.guard}}));if(value.kind==='guard')queueMicrotask(()=>handler({data:{type:'rpc',id:value.id,operation:value.operation,request:value.request,result:true}}));},close(){}};
  const stub=()=>({close(){}}),process=async options=>{workflow=options.workflowStore;assert.equal(workflow.persistence,'st-account-file');assert.equal((await workflow.list(namespace))[0].revision,head.revision);assert.equal((await workflow.load(namespace,head.id,head.revision)).workflow,(await f.store.load(namespace,head.id,head.revision)).workflow);return {sourceDigest:'a'.repeat(64),close(){}};};
  vm.runInNewContext(source,{self,characterWorkerStorageOptions,createComfyWorkflowStore:options=>createComfyWorkflowStore({...options,indexedDB:f.local.indexedDB,keyRange:f.local.keyRange}),
    createComfyPoolStore:stub,createCharacterArchiveStore:stub,createVibeAssetStore:stub,createStoryboardPackageJournal:stub,createBundleCarrierStore:stub,createStoryboardPackageStage:stub,createImageRestoreClient:stub,createSourceIdentityClient:stub,
    captureStoryboardResourceBundle:process,createStoryboardBundleRestoreSession:process});
  const payload={namespace,chatKey:'chat',file:new Blob(),csrf:'synthetic',nativeCharacters:context};f.reset();
  await handler({data:restore?{id:'test',operation:1,type:'command',action:'open',payload}:{action:'capture',...payload}});
  assert.ok(workflow);assert.ok(!posts.some(row=>row.error||row.type==='error'));assert.ok(!f.calls.some(row=>row.request.method==='POST'));workflow.close();
});

test('real storage Worker returns both native workflow and candidate summaries without original reads or uploads',async t=>{
  const f=await poolNativeFixture(t),store=f.openPool();await store.save(namespace,{name:'Candidates',pool:f.pool});f.configureDefaults();t.mock.method(globalThis,'fetch',f.fetchImpl);const Worker=installWorker(t);f.reset();
  const summary=await runRestoreStorage('comfy',{namespace,guard:async()=>{},WorkerClass:Worker});assert.deepEqual(Worker.last.sent[0].nativeComfy,context);assert.equal(summary.workflows.count,1);assert.equal(summary.pools.count,1);assert.equal(summary.pools.versions,1);assert.equal(summary.scenes.status,'unavailable');assert.equal(Worker.last.closed,true);
  assert.equal(f.uploads,0);assert.ok(!f.calls.some(row=>/-comfy-(?:workflow|pool)-version-/.test(row.path)));
});

for(const restore of [false,true])test(`actual bundle ${restore?'restore':'capture'} worker candidate factory preserves exact pool references on ST`,async t=>{
  const f=await poolNativeFixture(t),store=f.openPool(),head=await store.save(namespace,{name:'Candidates',pool:f.pool}),expected=await store.load(namespace,head.id,head.revision);f.configureDefaults();t.mock.method(globalThis,'fetch',f.fetchImpl);
  const filename=restore?'qianmu-storyboard-bundle-restore-worker.js':'qianmu-storyboard-bundle-worker.js',source=(await readFile(new URL('../'+filename,import.meta.url),'utf8')).replace(/^import[^\n]*\n/gm,'');let handler,pools;const posts=[];
  const self={location:{origin},addEventListener:(_,fn)=>handler=fn,postMessage:value=>{posts.push(value);if(value.guard)queueMicrotask(()=>handler({data:{guard:value.guard}}));if(value.kind==='guard')queueMicrotask(()=>handler({data:{type:'rpc',id:value.id,operation:value.operation,request:value.request,result:true}}));},close(){}};
  const stub=()=>({close(){}}),process=async options=>{pools=options.poolStore;assert.equal(pools.persistence,'st-account-file');assert.equal((await pools.list(namespace))[0].revision,head.revision);assert.deepEqual(await pools.load(namespace,head.id,head.revision),expected);assert.equal((await pools.backup(namespace)).pools[0].versions.length,1);return {sourceDigest:'a'.repeat(64),close(){}};};
  vm.runInNewContext(source,{self,characterWorkerStorageOptions,createComfyPoolStore:options=>createComfyPoolStore({...options,indexedDB:f.poolLocal.indexedDB,keyRange:f.poolLocal.keyRange}),createComfyWorkflowStore:stub,createCharacterArchiveStore:stub,createVibeAssetStore:stub,createStoryboardPackageJournal:stub,createBundleCarrierStore:stub,createStoryboardPackageStage:stub,createImageRestoreClient:stub,createSourceIdentityClient:stub,captureStoryboardResourceBundle:process,createStoryboardBundleRestoreSession:process});
  const payload={namespace,chatKey:'chat',file:new Blob(),csrf:'synthetic',nativeCharacters:context};f.reset();await handler({data:restore?{id:'test',operation:1,type:'command',action:'open',payload}:{action:'capture',...payload}});
  assert.ok(pools);assert.ok(!posts.some(row=>row.error||row.type==='error'));assert.equal(f.uploads,0);pools.close();
});
