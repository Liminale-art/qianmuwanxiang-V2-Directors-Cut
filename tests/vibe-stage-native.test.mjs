import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {VIBE_STAGE_SLOT} from '../qianmu-vibe-stage-native.js';
import {prepareVibeStageCheckpoint} from '../qianmu-vibe-stage-contract.js';
import {createStoryboardPackageJournal} from '../qianmu-storyboard-package-journal.js';
import {createStoryboardPackageStage} from '../qianmu-storyboard-package-stage.js';
import {buildStoryboardVibePackage} from '../qianmu-storyboard-package-assets.js';
import {createVibeAssetStore} from '../qianmu-vibe-asset-store.js';
import {collectRestoreStorage,clearRestoreStorage} from '../qianmu-storyboard-restore-storage.js';
import {runRestoreStorage} from '../qianmu-storyboard-restore-storage-runtime.js';
import {characterWorkerStorageOptions} from '../qianmu-character-worker-storage.js';
import {characterNativeFixture,namespace} from './helpers/character-native-fixture.mjs';
import {mappingLegacyFixture} from './helpers/mapping-legacy-fixture.mjs';
import {vibeLegacyFixture,vibeInput} from './helpers/vibe-legacy-fixture.mjs';

const descriptor=(file='a')=>({namespace,sourceNamespace:'st-user:source',chatHash:'b'.repeat(64),fileHash:file.repeat(64),fileBytes:120,assetIds:['c'.repeat(64)]});
const locks={request:async(_,__,work)=>work({})};
async function fixture(t,rows=[]){const f=await characterNativeFixture(t),old=mappingLegacyFixture([],{checkpoints:rows}),opened=[];
  const open=(local=old,extra={})=>{const journal=createStoryboardPackageJournal({indexedDB:local.indexedDB,keyRange:local.keyRange,native:{createStorage:f.createStorage},now:()=>10,...extra});opened.push(journal);return journal;};
  t.after(()=>opened.forEach(j=>j.close()));return {...f,old,openStage:open,empty:()=>mappingLegacyFixture()};}
const headName=`-${VIBE_STAGE_SLOT}.json`;

test('ordinary factory shares exact stages across empty-IDB clients, without touching settings or charging',async t=>{
  const f=await fixture(t),a=f.openStage();let row=await a.prepare(descriptor());assert.equal(row.phase,'prepared');
  const b=f.openStage(f.empty());assert.deepEqual(await b.list(namespace),[row]);row=await b.checkpoint(row,'staging');row=await b.checkpoint(row,'assets_ready');
  assert.deepEqual(await f.openStage(f.empty()).list(namespace),[row]);assert.deepEqual(f.old.state.checkpoints,[]);
  assert.ok(!f.calls.some(call=>/delete|plugins|completions|generate/.test(call.path)));
});

test('configured default factory routes the existing public API to native while explicit legacy stays read-only',async t=>{
  const original=prepareVibeStageCheckpoint(descriptor(),4),f=await fixture(t,[original]);f.configure();
  const j=createStoryboardPackageJournal({indexedDB:f.old.indexedDB,keyRange:f.old.keyRange});t.after(()=>j.close());assert.deepEqual(await j.list(namespace),[original]);
  await j.dismissCheckpoint(original,{confirmed:true});const local=f.old.open();t.after(()=>local.close());assert.deepEqual(await local.list(namespace),[original]);
  assert.deepEqual(await f.openStage().list(namespace),[]);assert.ok(f.old.state.reads.includes('checkpoints'));
});

test('complete old rows are preserved unchanged, including 1024 ordered asset identities',async t=>{
  const input=descriptor();input.assetIds=Array.from({length:1024},(_,i)=>i.toString(16).padStart(64,'0'));
  const row=prepareVibeStageCheckpoint(input,0),f=await fixture(t,[row]),j=f.openStage();assert.deepEqual(await j.list(namespace),[row]);assert.deepEqual(f.old.state.checkpoints,[row]);
  const doc=[...f.files.entries()].find(([name])=>name.includes('-vibe-stage-legacy-'));assert.ok(doc);assert.deepEqual(JSON.parse(doc[1]).value,row);
  const uploads=f.uploads;assert.deepEqual(await j.list(namespace),[row]);assert.equal(f.uploads,uploads);
});

test('old progress differences are retained without overriding native progress or reviving an ended row',async t=>{
  const row=prepareVibeStageCheckpoint(descriptor(),2),f=await fixture(t,[row]),j=f.openStage();await j.list(namespace);const staged=await j.checkpoint(row,'staging');
  const newer={...row,phase:'assets_ready',revision:5,updatedAt:8};f.old.state.checkpoints=[newer];assert.deepEqual(await j.list(namespace),[staged]);
  await j.dismissCheckpoint(staged,{confirmed:true});f.old.state.checkpoints=[{...newer,revision:6,updatedAt:9}];assert.deepEqual(await f.openStage().list(namespace),[]);
  assert.equal([...f.files.keys()].filter(name=>name.includes('-vibe-stage-legacy-')).length,3);assert.deepEqual(f.old.state.checkpoints[0].revision,6);
});

test('reopening the same ended package has a new revision and retains a readable chain of ended generations',async t=>{
  const f=await fixture(t),j=f.openStage(),input=descriptor();let row=await j.prepare(input);const first=structuredClone(row);
  await j.dismissCheckpoint(row,{confirmed:true});let generation=await j.prepare(input);assert.equal(generation.revision,2);assert.equal(generation.phase,'prepared');
  await assert.rejects(j.checkpoint(first,'staging'),/已变化/);await assert.rejects(j.dismissCheckpoint(first,{confirmed:true}),/已变化/);
  generation=await j.checkpoint(generation,'staging');await j.dismissCheckpoint(generation,{confirmed:true});row=await j.prepare(input);assert.equal(row.revision,4);
  const index=await f.storage.read(VIBE_STAGE_SLOT),saved=index.value.active[0];assert.ok(saved.prior);const previous=await f.storage.readImmutable(saved.prior);assert.equal(previous.value.row.revision,3);
  assert.equal((await f.storage.readImmutable(previous.value.prior)).value.row.revision,1);
});

test('stage count limits remain eight active records while ended rows no longer use an active slot',async t=>{
  const f=await fixture(t),j=f.openStage();for(const id of ['0','1','2','3','4','5','6','7'])await j.prepare(descriptor(id));const uploads=f.uploads;
  await assert.rejects(j.prepare(descriptor('8')),/8份/);assert.equal(f.uploads,uploads);const row=(await j.list(namespace))[0];await j.dismissCheckpoint(row,{confirmed:true});await j.prepare(descriptor('8'));assert.equal((await j.list(namespace)).length,8);
  const old=f.empty();old.state.checkpoints=[prepareVibeStageCheckpoint(descriptor('9'),1)];await assert.rejects(f.openStage(old).list(namespace),/超过8份/);assert.equal(old.state.checkpoints.length,1);
});

test('invalid phase, altered manifest and unconfirmed end cannot advance any current checkpoint',async t=>{
  const f=await fixture(t),j=f.openStage(),row=await j.prepare(descriptor()),uploads=f.uploads;
  await assert.rejects(j.checkpoint(row,'assets_ready'));await assert.rejects(j.checkpoint(row,'prepared'));await assert.rejects(j.dismissCheckpoint(row));
  for(const changed of [{...descriptor(),sourceNamespace:'st-user:other'},{...descriptor(),assetIds:['d'.repeat(64)]},{...descriptor(),fileBytes:121}])await assert.rejects(j.prepare(changed));
  assert.equal(f.uploads,uploads);assert.deepEqual(await j.list(namespace),[row]);
});

test('stale account, cancellation, closed sessions and guard denial never publish records',async t=>{
  const f=await fixture(t,[prepareVibeStageCheckpoint(descriptor(),1)]),j=f.openStage();f.account('st-user:other');await assert.rejects(j.list(namespace));assert.equal(f.uploads,0);
  f.account(namespace);for(const options of [{isCurrent:()=>false},{isCurrent:async()=>true},{guard:async()=>false},{signal:AbortSignal.abort()}])await assert.rejects(f.openStage().prepare(descriptor(),options));
  j.close();await assert.rejects(j.list(namespace));assert.equal(f.uploads,0);
});

test('old-page edits during immutable preservation prevent publishing stale progress',async t=>{
  const row=prepareVibeStageCheckpoint(descriptor(),1),f=await fixture(t,[row]);let changed=false;
  f.hook(call=>{if(call.request.method==='POST'&&!changed){changed=true;f.old.state.checkpoints=[{...row,phase:'staging',revision:2,updatedAt:2}];}});
  await assert.rejects(f.openStage().list(namespace),/旧页面/);assert.ok(![...f.files.keys()].some(name=>name.endsWith(headName)));assert.equal(f.old.state.checkpoints[0].phase,'staging');
});

test('missing old originals, ended bodies and a known missing directory fail closed',async t=>{
  const row=prepareVibeStageCheckpoint(descriptor(),1),f=await fixture(t,[row]),j=f.openStage();await j.list(namespace);
  const original=[...f.files.entries()].find(([name])=>name.includes('-vibe-stage-legacy-'));f.files.delete(original[0]);await assert.rejects(j.list(namespace));f.files.set(...original);
  await j.dismissCheckpoint(row,{confirmed:true});const ended=[...f.files.keys()].find(name=>name.includes('-vibe-stage-ended-'));f.files.delete(ended);await assert.rejects(f.openStage(f.empty()).prepare(descriptor()));
  f.files.delete([...f.files.keys()].find(name=>name.endsWith(headName)));await assert.rejects(j.list(namespace),/目录缺失/);
});

test('lost acknowledgements preserve readable progress or an ended marker without retrying',async t=>{
  const f=await fixture(t),j=f.openStage();let lose=false;
  f.hook(call=>{if(lose&&call.request.method==='POST'){const {name,data}=JSON.parse(call.request.body);if(name.endsWith(headName)){f.files.set(name,Buffer.from(data,'base64').toString());throw Error('lost response');}}});
  lose=true;await assert.rejects(j.prepare(descriptor()));lose=false;const before=f.uploads,row=(await f.openStage(f.empty()).list(namespace))[0];assert.equal(f.uploads,before);assert.equal(row.phase,'prepared');
  lose=true;await assert.rejects(j.dismissCheckpoint(row,{confirmed:true}));lose=false;assert.deepEqual(await f.openStage(f.empty()).list(namespace),[]);
});

test('captured input and guard options cannot be weakened while a write awaits',async t=>{
  const f=await fixture(t),j=f.openStage(),input=descriptor(),options={isCurrent:()=>true},promise=j.prepare(input,options);input.assetIds[0]='d'.repeat(64);options.isCurrent=()=>false;
  const row=await promise;assert.equal(row.assetIds[0],'c'.repeat(64));
  f.hook(call=>{if(call.request.method==='POST')j.close();});await assert.rejects(j.checkpoint(row,'staging'));f.hook(null);assert.equal((await f.openStage(f.empty()).list(namespace))[0].phase,'prepared');
});

test('a different remote head published before commit stops overwriting it and leaves the complete attempted body',async t=>{
  const f=await fixture(t),j=f.openStage();await j.prepare(descriptor());const name=[...f.files.keys()].find(name=>name.endsWith(headName)),first=f.files.get(name);
  await j.prepare(descriptor('d'));const newer=f.files.get(name);f.files.set(name,first);let raced=false;
  f.hook(call=>{if(call.request.method==='POST'&&!raced){raced=true;f.files.set(name,newer);}});
  await assert.rejects(f.openStage(f.empty()).prepare(descriptor('e')),/已有更新|已在其他页面/);f.hook(null);assert.equal(f.files.get(name),newer);
  assert.equal((await f.openStage(f.empty()).list(namespace)).length,2);assert.ok([...f.files.keys()].filter(name=>name.includes('-vibe-stage-journal-')).length>=3);
});

test('malformed native directories and foreign ended references cannot masquerade as empty progress',async t=>{
  const f=await fixture(t),j=f.openStage(),row=await j.prepare(descriptor());await j.dismissCheckpoint(row,{confirmed:true});const baseline=await f.storage.read(VIBE_STAGE_SLOT);
  for(const change of [v=>v.namespace='st-user:other',v=>v.ended[0].reference.scope='f'.repeat(64),v=>v.ended[0].reference.bytes=1024*1024,v=>v.ended.push(v.ended[0]),v=>v.revision=-1]){
    const value=structuredClone(baseline.value);change(value);const current=await f.storage.read(VIBE_STAGE_SLOT);await f.storage.write(VIBE_STAGE_SLOT,value,{expectedFingerprint:current.fingerprint});await assert.rejects(f.openStage(f.empty()).list(namespace));
  }
});

test('non-lossless old timestamps and sparse manifests are not normalized into native progress',async t=>{
  for(const mode of ['negative-zero','sparse']){const row=prepareVibeStageCheckpoint(descriptor(),1);if(mode==='negative-zero')row.createdAt=-0;else row.assetIds=new Array(1);
    const f=await fixture(t,[row]);await assert.rejects(f.openStage().list(namespace));assert.equal(f.uploads,0);assert.ok(mode==='sparse'?!Object.hasOwn(f.old.state.checkpoints[0].assetIds,0):Object.is(f.old.state.checkpoints[0].createdAt,-0));}
});

test('actual stage coordinator on independent clients checks native originals and resumes only after fresh inspection',async t=>{
  const f=await fixture(t),inputs=await Promise.all([vibeInput('one'),vibeInput('two')]),empty=vibeLegacyFixture(t),stores=[];
  const openAssets=()=>{const store=createVibeAssetStore({indexedDB:empty.indexedDB,keyRange:empty.keyRange,native:{createStorage:f.createStorage}});stores.push(store);return store;};t.after(()=>stores.forEach(s=>s.close()));
  const payload={type:'qianmu-storyboard',version:6,credentialsIncluded:false,settings:{vibeLibrary:inputs.map((item,i)=>({id:'v'+i,name:'v',assetRef:{version:1,namespace,id:item.asset.assetId},strength:0,informationExtracted:0}))},chat:{images:[],collections:[]},media:[]};
  const {file}=await buildStoryboardVibePackage(payload,{namespace,load:async(ns,id)=>inputs.find(item=>item.asset.assetId===id).asset});
  const store=openAssets(),j=f.openStage(),options={namespace,chatKey:'test-chat',guard:async()=>{},isCurrent:()=>true};let n=0;
  const stage=createStoryboardPackageStage({store:{...store,async putFile(...args){const value=await store.putFile(...args);if(++n===1)throw Error('interrupted');return value;}},journal:j,locks});
  const proof=await stage.inspect(file,options);await assert.rejects(stage.stage(file,proof,true,options));assert.equal((await f.openStage(f.empty()).list(namespace))[0].phase,'staging');
  const other=createStoryboardPackageStage({store:openAssets(),journal:f.openStage(f.empty()),locks});await assert.rejects(other.stage(file,proof,true,options),/重新核对/);
  const fresh=await other.inspect(file,options);assert.equal(fresh.missing,1);await assert.rejects(other.stage(file,fresh,false,options));const done=await other.stage(file,fresh,true,options);assert.equal(done.settingsApplied,false);assert.equal(done.verified,2);
  // Remove the exact remote source while leaving assets_ready. A fresh inspection
  // must fail, never trust the checkpoint or implicitly overwrite a corrupt file.
  f.files.delete([...f.files.keys()].find(name=>name.includes('-vibe-original-part-')));await assert.rejects(other.inspect(file,options));assert.equal((await j.list(namespace))[0].phase,'assets_ready');
});

test('actual management Worker lists and ends only native stage summaries, retaining all originals',async t=>{
  const f=await fixture(t);f.configure();await f.openStage().prepare(descriptor());t.mock.method(globalThis,'fetch',f.fetchImpl);
  const source=(await readFile(new URL('../qianmu-storyboard-restore-storage-worker.js',import.meta.url),'utf8')).replace(/^import[^\n]*\n/gm,''),posts=[];
  class Worker{listeners={};closed=false;constructor(){const old=f.empty(),self={location:{origin:'https://st.fixture.invalid'},addEventListener:(_,fn)=>this.handler=fn,close(){},postMessage:data=>{posts.push(data);queueMicrotask(()=>{if(!this.closed)this.listeners.message({data});});}};
    vm.runInNewContext(source,{self,characterWorkerStorageOptions,createStoryboardPackageJournal:options=>createStoryboardPackageJournal({...options,indexedDB:old.indexedDB,keyRange:old.keyRange}),collectRestoreStorage,clearRestoreStorage:options=>clearRestoreStorage({...options,locks})});}
    addEventListener(name,fn){this.listeners[name]=fn;}postMessage(data){queueMicrotask(()=>{if(!this.closed)void this.handler({data});});}terminate(){this.closed=true;}}
  const options={namespace,guard:async()=>{},WorkerClass:Worker},summary=await runRestoreStorage('inspect',options);assert.equal(summary.count,1);assert.equal(summary.items[0].kind,'vibes');const files=new Set(f.files.keys());
  const selected=summary.items.map(({kind,key,fingerprint})=>({kind,key,fingerprint}));assert.equal((await runRestoreStorage('clear',{...options,selected,confirmed:true,recoveryLossAccepted:true})).complete,true);
  assert.equal((await runRestoreStorage('inspect',options)).count,0);for(const file of files)assert.ok(f.files.has(file));assert.doesNotMatch(JSON.stringify(posts),/"assetIds"|"legacy"|"reference"|synthetic|Authorization/);
});
