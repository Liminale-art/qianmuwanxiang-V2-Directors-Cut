import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {createVibeAssetStore} from '../qianmu-vibe-asset-store.js';
import {createVibeEncodingStore} from '../qianmu-vibe-encoding-store.js';
import {receiptInput} from './helpers/vibe-receipt-fixture.mjs';
import {receiptWritableFixture} from './helpers/vibe-receipt-writable-fixture.mjs';
import {createVibeAssetOperations} from '../qianmu-vibe-assets-worker.js';
import {vibeFileError} from '../qianmu-vibe-file.js';
import {characterWorkerStorageOptions} from '../qianmu-character-worker-storage.js';
import {buildStoryboardVibePackage} from '../qianmu-storyboard-package-assets.js';
import {validateStoryboardPackageMedia} from '../qianmu-storyboard-package-input.js';
import {callVibeAsset,closeVibeAssetRuntime} from '../qianmu-vibe-assets.js';
import {exportStoryboardPackageAssets,closeStoryboardPackageRuntime} from '../qianmu-storyboard-package-runtime.js';
import {createVerifiedProgressWatch} from '../qianmu-verified-progress-watch.js';
import {characterNativeFixture,namespace} from './helpers/character-native-fixture.mjs';
import {vibeLegacyFixture,vibeInput} from './helpers/vibe-legacy-fixture.mjs';

const origin='https://st.fixture.invalid',settled=()=>new Promise(resolve=>setImmediate(resolve));
const sources=await Promise.all(['qianmu-vibe-assets-worker.js','qianmu-storyboard-package-worker.js','qianmu-storyboard-bundle-restore-worker.js','qianmu-vibe-assets.js'].map(file=>readFile(new URL('../'+file,import.meta.url),'utf8')));
const packet=input=>({type:'qianmu-storyboard',version:6,credentialsIncluded:false,settings:{vibeLibrary:[{id:'item',name:'item',strength:0,information:0,assetRef:{version:1,namespace,id:input.asset.assetId}}],logs:[],pipelineLogs:[],shotPlans:[],taskStates:[]},chat:{images:[],collections:[]},media:[]});
async function fixture(t,inputs=[]){
  closeVibeAssetRuntime();closeStoryboardPackageRuntime();const f=await characterNativeFixture(t),local=vibeLegacyFixture(t,inputs),ledger=receiptWritableFixture();f.configure();t.mock.method(globalThis,'fetch',f.fetchImpl);
  class Worker extends EventTarget{
    static instances=[];
    constructor(url){super();Worker.instances.push(this);this.sent=[];this.received=[];this.closed=false;this.url=url;
      const self={location:{origin},addEventListener:(_,handler)=>this.receive=handler,postMessage:value=>{this.received.push(structuredClone(value));queueMicrotask(()=>{if(!this.closed)this.dispatchEvent(new MessageEvent('message',{data:structuredClone(value)}));});},close:()=>{this.workerClosed=true;}};
      this.realm=vm.createContext({self,characterWorkerStorageOptions,vibeFileError,createVibeAssetOperations,buildStoryboardVibePackage,validateStoryboardPackageMedia,
        createVibeAssetStore:options=>createVibeAssetStore({...options,indexedDB:local.indexedDB,keyRange:local.keyRange}),createVibeEncodingStore:options=>createVibeEncodingStore({...options,indexedDB:ledger.indexedDB,keyRange:ledger.keyRange,now:()=>10})});
      const source=String(url).includes('qianmu-vibe-assets-worker.js')?sources[0].slice(sources[0].indexOf('let pending=Promise.resolve()')):sources[1].replace(/^import[^\n]*\n/gm,'');
      vm.runInContext(source,this.realm);
    }
    postMessage(message){this.sent.push(structuredClone(message));queueMicrotask(()=>{if(!this.closed)void Promise.resolve(this.receive({data:structuredClone(message)})).catch(()=>this.dispatchEvent(new Event('error')));});}
    terminate(){this.closed=true;if(String(this.url).includes('qianmu-vibe-assets-worker.js'))vm.runInContext('runtime?.store.close();runtime?.encodings.close();',this.realm);}
  }
  const prior=Object.getOwnPropertyDescriptor(globalThis,'Worker');Object.defineProperty(globalThis,'Worker',{value:Worker,configurable:true});
  t.after(()=>{closeVibeAssetRuntime();closeStoryboardPackageRuntime();if(prior)Object.defineProperty(globalThis,'Worker',prior);else delete globalThis.Worker;});
  return Object.assign(f,{local,ledger,Worker});
}

test('actual bridge and Worker reserve and transition the ST fee catalogue before returning success',async t=>{
  const input=await receiptInput(),f=await fixture(t),cacheKey=input.receipt.cacheKey,attemptId='actual-worker-attempt';
  const saved=await callVibeAsset('encoding-reserve',{namespace,cacheKey,identity:input.receipt.identity,attemptId,sourceAssetRef:input.receipt.sourceAssetRef,delivery:input.receipt.delivery});assert.equal(saved.owned,true);
  assert.ok([...f.files.keys()].some(name=>name.endsWith('-vibe-receipt-catalogue.json')));assert.equal(f.ledger.state.tables.receipts[0].status,'reserved');
  assert.equal((await callVibeAsset('encoding-transition',{namespace,cacheKey,attemptId,status:'submitting'})).status,'submitting');
  assert.equal((await callVibeAsset('encoding-get',{namespace,cacheKey})).status,'submitting');assert.ok(f.Worker.instances[0].received.some(row=>row.progress));
});

test('actual Worker never returns owned after a failed fee catalogue publication',async t=>{
  const input=await receiptInput(),f=await fixture(t);f.hook(call=>{if(call.path==='/api/files/upload'&&JSON.parse(call.request.body).name.endsWith('-vibe-receipt-catalogue.json'))throw Error('fee write failed');});
  await assert.rejects(callVibeAsset('encoding-reserve',{namespace,cacheKey:input.receipt.cacheKey,identity:input.receipt.identity,attemptId:'worker-failed-attempt',sourceAssetRef:input.receipt.sourceAssetRef,delivery:input.receipt.delivery}));
  assert.equal(f.ledger.state.tables.receipts[0].status,'reserved');assert.ok(!f.calls.some(row=>/generate|encode-vibe/.test(row.path)));
});

test('actual client and serial worker import then resolve native assets and reset verified progress for every operation',async t=>{
  const f=await fixture(t),a=await vibeInput('A'),b=await vibeInput('B');
  for(const input of [a,b])await callVibeAsset('import',{namespace,file:new Blob([input.asset.serialized])});
  const resolved=await callVibeAsset('resolve',{namespace,id:a.asset.assetId,model:'nai-diffusion-4-full',information:0});assert.equal(resolved.data,btoa('encoded'));
  assert.equal(f.local.state.heads.length,0);assert.equal(f.Worker.instances.length,1);const worker=f.Worker.instances[0],commands=worker.sent.filter(row=>row.type);
  for(const command of commands){assert.deepEqual(command.nativeStorage,{namespace,origin,csrf:'synthetic'});assert.equal(Object.hasOwn(command.nativeStorage,'apiKey'),false);}
  for(const command of commands.slice(0,2)){const sequence=worker.received.filter(row=>row.ticket===command.ticket&&row.progress).map(row=>row.progress);assert.ok(sequence.length>1);assert.deepEqual(sequence,sequence.map((_,i)=>i+1));}
  assert.ok(worker.received.some(row=>row.guard));assert.ok(!f.calls.some(row=>/generate|encode-vibe|plugins/.test(row.path)));
});

test('actual worker first-read migration is readonly and metadata rereads do not replay preservation',async t=>{
  const input=await vibeInput(),f=await fixture(t,[input]);assert.equal((await callVibeAsset('list',{namespace})).length,1);const before=f.uploads;
  await callVibeAsset('head',{namespace,id:input.asset.assetId});assert.equal(f.uploads,before);assert.equal(f.local.state.heads.length,1);
});

test('actual native worker rejects a changed account before exposing the old result',async t=>{
  const input=await vibeInput(),f=await fixture(t);await callVibeAsset('import',{namespace,file:new Blob([input.asset.serialized])});
  f.hook(call=>{if(call.path.includes('-vibe-original-part-'))f.account('st-user:other');});
  await assert.rejects(callVibeAsset('resolve',{namespace,id:input.asset.assetId,model:'nai-diffusion-4-full',information:0}));assert.equal(f.Worker.instances[0].closed,true);
});

test('dedicated package runtime and actual worker export a complete remote Vibe from an empty local DB',async t=>{
  const input=await vibeInput(),f=await fixture(t),store=createVibeAssetStore({native:{createStorage:f.createStorage},indexedDB:f.local.indexedDB,keyRange:f.local.keyRange});t.after(()=>store.close());
  await store.putFile(namespace,input.asset.serialized);f.reset();let guards=0;
  const result=await exportStoryboardPackageAssets(packet(input),{namespace,guard:async()=>{guards++;},WorkerClass:f.Worker});
  const data=JSON.parse(await result.file.text());assert.equal(data.vibeAssets.length,1);assert.equal(data.vibeAssets[0].id,input.asset.assetId);assert.ok(guards>5);assert.equal(f.uploads,0);
  assert.equal(f.Worker.instances.at(-1).closed,true);assert.deepEqual(f.Worker.instances.at(-1).sent[0].nativeStorage,{namespace,origin,csrf:'synthetic'});
});

test('actual bundle restore worker passes native storage and live guard into its Vibe stage',async t=>{
  const input=await vibeInput(),f=await fixture(t),source=createVibeAssetStore({native:{createStorage:f.createStorage},indexedDB:f.local.indexedDB,keyRange:f.local.keyRange});t.after(()=>source.close());await source.putFile(namespace,input.asset.serialized);
  let handler,seen=false;const posts=[],stub=()=>({close(){}}),self={location:{origin},addEventListener:(_,fn)=>handler=fn,close(){},postMessage:message=>{posts.push(message);
    if(message.kind==='guard')queueMicrotask(()=>handler({data:{type:'rpc',id:message.id,operation:message.operation,request:message.request,result:true}}));}};
  vm.runInNewContext(sources[2].replace(/^import[^\n]*\n/gm,''),{self,characterWorkerStorageOptions,createComfyWorkflowStore:stub,createComfyPoolStore:stub,createCharacterArchiveStore:stub,
    createStoryboardPackageJournal:stub,createBundleCarrierStore:stub,createImageRestoreClient:stub,createSourceIdentityClient:stub,
    createVibeAssetStore:options=>createVibeAssetStore({...options,indexedDB:f.local.indexedDB,keyRange:f.local.keyRange}),createStoryboardPackageStage:options=>options,
    createStoryboardBundleRestoreSession:async options=>{seen=true;assert.deepEqual(await options.vibeStage.store.load(namespace,input.asset.assetId),input.asset);return {sourceDigest:'a'.repeat(64),close(){}};}});
  await handler({data:{id:'test',operation:1,type:'command',action:'open',payload:{namespace,chatKey:'chat',nativeCharacters:{namespace,origin,csrf:'synthetic'}}}});
  assert.equal(seen,true);assert.ok(!posts.some(row=>row.type==='error'));assert.ok(posts.some(row=>row.progress));await handler({data:{id:'test',type:'close'}});
});

function clientClock(){let time=0,serial=0;const tasks=new Map();return {get time(){return time;},tasks,setTimer:(run,ms)=>{const id=++serial;tasks.set(id,{at:time+ms,run});return id;},clearTimer:id=>tasks.delete(id),
  tick(ms){const end=time+ms;while(true){const next=[...tasks].filter(([,row])=>row.at<=end).sort((a,b)=>a[1].at-b[1].at)[0];if(!next)break;time=next[1].at;tasks.delete(next[0]);next[1].run();}time=end;}};}
function clientFixture(){
  const clock=clientClock(),workers=[],scope={};let account=namespace,captureHook=null;
  class Worker extends EventTarget{constructor(){super();this.sent=[];workers.push(this);}postMessage(value){this.sent.push(value);}terminate(){this.closed=true;}reply(value){this.dispatchEvent(new MessageEvent('message',{data:value}));}}
  const source=sources[3].replace(/^import[^\n]*\n/gm,'').replace(/^export \{[^\n]*\n/gm,'').replaceAll('export ','').replaceAll('import.meta.url',JSON.stringify(new URL('../qianmu-vibe-assets.js',import.meta.url).href));
  const context=vm.createContext({Worker,URL,structuredClone,Date:{now:()=>clock.time},vibeFileError,isStAccountStorageConfigured:()=>true,getStAccountStorageReadScope:()=>scope,
    captureStAccountStorageWorkerContext:async()=>{await captureHook?.();return {namespace:account,origin,csrf:'synthetic'};},
    verifyStAccountStorageWorkerContext:async expected=>{await captureHook?.();if(account!==expected.namespace||origin!==expected.origin)throw vibeFileError('account','Vibe账户已变化');return true;},
    setTimeout:clock.setTimer,clearTimeout:clock.clearTimer,createVerifiedProgressWatch:options=>createVerifiedProgressWatch({...options,setTimer:clock.setTimer,clearTimer:clock.clearTimer})});vm.runInContext(source,context);
  return {clock,workers,context,setAccount:value=>account=value,hook:value=>captureHook=value};
}

test('native queued requests have no 60-second idle timer; idle watch starts only on worker execution',async()=>{
  const f=clientFixture(),a=f.context.callVibeAsset('head',{namespace,id:'a'}),b=f.context.callVibeAsset('head',{namespace,id:'b'});await settled();const worker=f.workers[0],[one,two]=worker.sent;
  worker.reply({ticket:one.ticket,started:true});f.clock.tick(90000);worker.reply({ticket:one.ticket,progress:1});await settled();f.clock.tick(90000);assert.equal(worker.closed,undefined);
  worker.reply({ticket:one.ticket,value:'one'});assert.equal(await a,'one');worker.reply({ticket:two.ticket,started:true});worker.reply({ticket:two.ticket,value:'two'});assert.equal(await b,'two');f.context.closeVibeAssetRuntime();assert.equal(f.clock.tasks.size,0);
});

test('guard heartbeats cannot renew idle deadlines and queued calls retain an absolute half-hour bound',async()=>{
  const f=clientFixture(),pending=f.context.callVibeAsset('head',{namespace}).catch(error=>error.code);await settled();const worker=f.workers[0],ticket=worker.sent[0].ticket;worker.reply({ticket,started:true});
  f.clock.tick(110000);worker.reply({ticket,guard:1});await settled();assert.equal(worker.sent.at(-1).result,true);f.clock.tick(10001);assert.equal(await pending,'vibe_file_timeout');assert.equal(worker.closed,true);
  const g=clientFixture(),queued=g.context.callVibeAsset('head',{namespace}).catch(error=>error.code);await settled();g.clock.tick(1800000);assert.equal(await queued,'vibe_file_timeout');assert.equal(g.clock.tasks.size,0);
});

test('bad progress, late account results and capture-time edits cannot bypass the client boundary',async()=>{
  for(const mode of ['progress','account']){const f=clientFixture(),pending=f.context.callVibeAsset('head',{namespace}).catch(error=>error.code);await settled();const worker=f.workers[0],ticket=worker.sent[0].ticket;worker.reply({ticket,started:true});
    if(mode==='progress')worker.reply({ticket,progress:2});else{f.setAccount('st-user:other');worker.reply({ticket,value:'private'});}assert.match(await pending,/vibe_file_(worker|account)/);assert.equal(worker.closed,true);}
  const f=clientFixture();let release;const hold=new Promise(resolve=>release=resolve);f.hook(()=>hold);const options={namespace,id:'original'},a=f.context.callVibeAsset('head',options),b=f.context.callVibeAsset('head',{namespace,id:'second'});options.id='changed';
  release();await settled();const worker=f.workers[0];assert.deepEqual(Array.from(worker.sent,row=>row.id),['original','second']);f.context.closeVibeAssetRuntime();await assert.rejects(a);await assert.rejects(b);
});

test('late progress guard from a completed request cannot terminate a subsequent live request',async()=>{
  const f=clientFixture(),a=f.context.callVibeAsset('head',{namespace});await settled();const worker=f.workers[0],ticket=worker.sent[0].ticket;worker.reply({ticket,started:true});
  let release,calls=0;const hold=new Promise(resolve=>release=resolve);f.hook(()=>++calls===1?hold:undefined);
  worker.reply({ticket,progress:1});worker.reply({ticket,value:'first'});assert.equal(await a,'first');f.hook(null);
  const b=f.context.callVibeAsset('head',{namespace});await settled();release();await settled();assert.equal(worker.closed,undefined);
  const next=worker.sent.at(-1).ticket;worker.reply({ticket:next,started:true});worker.reply({ticket:next,value:'second'});assert.equal(await b,'second');f.context.closeVibeAssetRuntime();
});

test('native caller cannot inject protocol control fields into ordinary asset requests',async()=>{
  const f=clientFixture();for(const key of ['ticket','type','nativeStorage','guard','started','progress'])await assert.rejects(f.context.callVibeAsset('head',{namespace,[key]:1}),{code:'vibe_file_file'});
  assert.equal(f.workers.length,0);assert.equal(f.clock.tasks.size,0);
});
