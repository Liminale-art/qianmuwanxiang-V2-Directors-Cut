import test from 'node:test';
import assert from 'node:assert/strict';
import {createVibeAssetStore} from '../qianmu-vibe-asset-store.js';
import {createNativeVibeAssetStore,VIBE_NATIVE_SLOT} from '../qianmu-vibe-native-store.js';
import {createVibeAssetOperations} from '../qianmu-vibe-assets-worker.js';
import {createVibeStorageOperations,createVibeStorageActions} from '../qianmu-vibe-storage.js';
import {validateVibeStorageSummary} from '../qianmu-vibe-storage-summary.js';
import {createVibeEncodingRetention} from '../qianmu-vibe-encoding-retention.js';
import {prepareNovelVibeEncoding} from '../qianmu-vibe-encoding.js';
import {parseNovelVibeFile,vibeFilePreview} from '../qianmu-vibe-file.js';
import {characterNativeFixture,namespace} from './helpers/character-native-fixture.mjs';
import {vibeLegacyFixture,vibeInput} from './helpers/vibe-legacy-fixture.mjs';

async function fixture(t,inputs=[]){const f=await characterNativeFixture(t),old=vibeLegacyFixture(t,inputs),stores=[];
  const open=(legacy=old.open(),options={})=>{const store=createNativeVibeAssetStore({legacy,createStorage:f.createStorage,now:()=>2,...options});stores.push(store);return store;};
  const empty=()=>vibeLegacyFixture(t).open();t.after(()=>stores.forEach(store=>store.close()));return Object.assign(f,{old,openVibes:open,empty});
}
const headSuffix='-vibe-assets.json';
const ledger={inventory:async()=>({receipts:[],archived:{count:0,bytes:0},reviewHistory:{reviews:0,bytes:0},metadata:{count:0,bytes:0}})};
const locks={request:async(_name,_options,fn)=>fn({})};

test('late retained encoding is adopted by the original native account on return and readable by an empty-IDB client',async t=>{
  const f=await fixture(t),input=await vibeInput(),store=f.openVibes(),run=createVibeAssetOperations(store);await store.putFile(namespace,input.asset.serialized);
  const prepared=await prepareNovelVibeEncoding({version:1,provider:'novel',baseUrl:'https://relay.example',model:'nai-diffusion-4-full',image:input.asset.document.image,information:.5});
  const row={identity:prepared.identity,status:'reserved',attemptId:'test-attempt-one',sourceAssetRef:{version:1,namespace,id:input.asset.assetId}},local=[];
  // A writable receipt-return double updates the independent readonly-IDB census;
  // all remote storage, native migration and ordinary asset consumers are real.
  const sink=await createVibeEncodingRetention({namespace,id:input.asset.assetId,...prepared,attemptId:row.attemptId,guard:async()=>{},readSource:args=>run({type:'encoding-original',...args}),
    createAssets:()=>({close(){},async putFile(ns,text){assert.equal(ns,namespace);const assets=await parseNovelVibeFile(text);for(const asset of assets){if(local.some(item=>item.asset.assetId===asset.assetId))continue;
      const blob=vibeFilePreview(asset.document);local.push({asset,blob,head:{key:JSON.stringify([namespace,asset.assetId]),namespace,assetId:asset.assetId,bytes:asset.bytes,previewBytes:blob?.size||0,summary:asset.summary,createdAt:1}});}f.old.replace(local);return assets;}}),
    createReceipts:()=>({close(){},get:async()=>structuredClone(row),async transition(ns,key,attempt,status,{assetRef}){assert.equal(ns,namespace);assert.equal(key,prepared.cacheKey);assert.equal(attempt,row.attemptId);Object.assign(row,{status,assetRef});}})});
  row.status='submitting';f.account('st-user:other');const before=f.calls.length,ref=await sink.retain(btoa('new paid encoding'));sink.close();assert.equal(f.calls.length,before);assert.equal(row.status,'ready');
  f.account(namespace);const result=await f.openVibes().load(namespace,ref.id);assert.equal(result.summary.variants.length,2);assert.equal(result.document.importInfo.strength,0);
  const remote=await f.openVibes(f.empty()).load(namespace,ref.id);assert.deepEqual(remote,result);assert.equal(f.old.state.heads.length,2);
});

test('ordinary default factory and second client with empty IDB share new complete assets and zero defaults',async t=>{
  const f=await fixture(t),input=await vibeInput(),store=createVibeAssetStore({indexedDB:f.old.indexedDB,keyRange:f.old.keyRange,native:{createStorage:f.createStorage},now:()=>2});t.after(()=>store.close());
  const heads=await store.putFile(namespace,input.asset.serialized);assert.deepEqual(heads[0].defaults,{strength:0,information:0});assert.equal(f.old.state.documents.length,0);
  const other=f.openVibes(f.empty());assert.deepEqual(await other.load(namespace,input.asset.assetId),input.asset);assert.equal((await other.list(namespace)).length,1);
  assert.deepEqual(await (await other.preview(namespace,input.asset.assetId)).arrayBuffer(),await input.blob.arrayBuffer());
});

test('configured ordinary factory chooses native without an extra user flag and never falls back after failure',async t=>{
  const f=await fixture(t),input=await vibeInput();f.configure();
  for(const [key,value] of [['indexedDB',f.old.indexedDB],['IDBKeyRange',f.old.keyRange]]){const prior=Object.getOwnPropertyDescriptor(globalThis,key);Object.defineProperty(globalThis,key,{configurable:true,value});t.after(()=>{if(prior)Object.defineProperty(globalThis,key,prior);else delete globalThis[key];});}
  const store=createVibeAssetStore();t.after(()=>store.close());await store.putFile(namespace,input.asset.serialized);assert.equal(f.old.state.heads.length,0);assert.ok(f.uploads>0);
  f.hook(()=>{throw Error('offline');});await assert.rejects(store.list(namespace));assert.equal(f.old.state.heads.length,0);
});

test('legacy migration preserves complete originals with readonly IDB, publishes first then bounded batches',async t=>{
  const inputs=await Promise.all(Array.from({length:10},(_,i)=>vibeInput('Old '+i,{preview:i!==0}))),f=await fixture(t,inputs),before=structuredClone(f.old.state),events=[];
  const store=f.openVibes(undefined,{onProgress:event=>events.push(event)});assert.equal((await store.list(namespace)).length,10);assert.deepEqual(f.old.state,before);
  const headWrites=f.calls.filter(call=>call.request.method==='POST'&&JSON.parse(call.request.body).name.endsWith(headSuffix));assert.equal(headWrites.length,3);
  assert.equal(events.filter(e=>e.kind==='vibe-catalogue').length,3);const other=f.openVibes(f.empty());
  for(const input of inputs)assert.deepEqual(await other.load(namespace,input.asset.assetId),input.asset);
  const first=await other.head(namespace,inputs[0].asset.assetId);assert.equal(Object.hasOwn(first,'previewBytes'),false);assert.equal(await other.preview(namespace,first.assetId),null);
});

test('warm lists and space inventory read metadata only and never redownload original blocks',async t=>{
  const input=await vibeInput(),f=await fixture(t,[input]),store=f.openVibes();await store.list(namespace);f.reset();f.old.reads.length=0;
  await store.list(namespace);await store.inventory(namespace);await store.head(namespace,input.asset.assetId);assert.equal(f.uploads,0);
  assert.ok(!f.calls.some(call=>/vibe-original-part|vibe-preview-part|vibe-original-[a-f0-9]/.test(call.path)));
  assert.ok(!f.old.reads.some(row=>row.name==='documents'&&row.kind==='get'));
});

test('a different old head is preserved as a separate source without replacing the native head',async t=>{
  const input=await vibeInput(),f=await fixture(t,[input]),a=f.openVibes();await a.list(namespace);const bInput={...input,head:{...input.head,createdAt:7,future:{keep:'yes'}}};
  const b=f.openVibes(vibeLegacyFixture(t,[bInput]).open());const listed=await b.list(namespace);assert.equal(listed[0].createdAt,1.25);
  const index=(await f.storage.read(VIBE_NATIVE_SLOT)).value;assert.equal(index.assets[0].legacy.length,1);assert.deepEqual(JSON.parse(index.assets[0].legacy[0].headText),bInput.head);
  assert.deepEqual(await b.load(namespace,input.asset.assetId),input.asset);
});

test('bad non-JSON old metadata cannot masquerade as an already preserved null field',async t=>{
  const input=await vibeInput();input.head.future=null;const f=await fixture(t,[input]),a=f.openVibes();await a.list(namespace);const before=f.uploads;
  f.old.state.heads[0].future=NaN;await assert.rejects(a.list(namespace));assert.equal(f.uploads,before);assert.ok(Number.isNaN(f.old.state.heads[0].future));
});

test('missing native head or original body fails closed and duplicate import cannot silently repair corruption',async t=>{
  const input=await vibeInput(),f=await fixture(t),a=f.openVibes();await a.putFile(namespace,input.asset.serialized);
  const part=[...f.files.keys()].find(name=>name.includes('-vibe-original-part-'));f.files.delete(part);const before=f.uploads;
  await assert.rejects(a.load(namespace,input.asset.assetId));await assert.rejects(a.putFile(namespace,input.asset.serialized));assert.equal(f.uploads,before);
  f.files.delete([...f.files.keys()].find(name=>name.endsWith(headSuffix)));await assert.rejects(a.list(namespace),/目录缺失/);
});

test('lost catalogue acknowledgement preserves complete originals; explicit reopen reuses them without duplicate uploads',async t=>{
  const input=await vibeInput(),f=await fixture(t,[input]);f.hook(call=>{if(call.request.method==='POST'){const {name,data}=JSON.parse(call.request.body);if(name.endsWith(headSuffix)){f.files.set(name,Buffer.from(data,'base64').toString());throw Error('lost ack');}}});
  await assert.rejects(f.openVibes().list(namespace));f.hook(null);f.reset();assert.equal((await f.openVibes().list(namespace)).length,1);assert.equal(f.uploads,0);
});

test('old-page change after original preservation stops directory publication, keeping both originals',async t=>{
  const input=await vibeInput(),f=await fixture(t,[input]);let edited=false;f.hook(call=>{if(call.request.method==='POST'&&!edited){edited=true;f.old.state.heads[0].future='late';}});
  await assert.rejects(f.openVibes().list(namespace),/旧页面/);assert.ok(![...f.files.keys()].some(name=>name.endsWith(headSuffix)));assert.ok(f.files.size>0);
});

test('later migration failure leaves the first verified catalogue intact and explicit reopening only fills missing originals',async t=>{
  const inputs=await Promise.all(Array.from({length:4},(_,i)=>vibeInput('partial '+i))),f=await fixture(t,inputs);let manifests=0;
  f.hook(call=>{if(call.request.method==='POST'){const {name}=JSON.parse(call.request.body);if(/-vibe-original-[a-f0-9]{64}\.json$/.test(name)&&++manifests===3)throw Error('connection lost');}});
  await assert.rejects(f.openVibes().list(namespace));f.hook(null);assert.equal((await f.openVibes(f.empty()).list(namespace)).length,1);
  const originals=new Set([...f.files.keys()].filter(name=>/-vibe-original-[a-f0-9]{64}\.json$/.test(name)));f.reset();
  assert.equal((await f.openVibes().list(namespace)).length,4);
  assert.ok(!f.calls.some(call=>call.request.method==='POST'&&originals.has(JSON.parse(call.request.body).name)));assert.equal(f.old.state.heads.length,4);
});

test('remote directory changes before publication stop an unrelated import rather than overwrite',async t=>{
  const input=await vibeInput(),other=await vibeInput('other'),f=await fixture(t),a=f.openVibes();await a.putFile(namespace,input.asset.serialized);
  const known=(await f.storage.read(VIBE_NATIVE_SLOT)).value;let edited=false;f.hook(async call=>{if(call.request.method==='POST'&&!edited){edited=true;f.hook(null);
    const prior=await f.storage.read(VIBE_NATIVE_SLOT);await f.storage.write(VIBE_NATIVE_SLOT,{...known,revision:known.revision+1},{expectedFingerprint:prior.fingerprint});}});
  await assert.rejects(a.putFile(namespace,other.asset.serialized));assert.equal((await f.openVibes(f.empty()).list(namespace)).length,1);
});

test('retirement preserves originals, reports no physical bytes freed and cannot be resurrected by old IDB',async t=>{
  const input=await vibeInput(),f=await fixture(t,[input]),a=f.openVibes(),heads=await a.list(namespace),before=f.files.size;
  const removed=await a.remove(namespace,[input.asset.assetId],{expectedHeads:heads});assert.deepEqual(removed,{removed:1,bytes:0,retained:true,retainedBytes:input.head.bytes+input.blob.size});
  assert.ok(f.files.size>before);assert.deepEqual(await f.openVibes().list(namespace),[]);assert.equal(await a.load(namespace,input.asset.assetId),null);assert.equal(f.old.state.documents.length,1);
  const view=await a.inventory(namespace);assert.equal(view.retained.count,1);assert.equal(view.retained.bytes,removed.retainedBytes);
  await a.putFile(namespace,input.asset.serialized);assert.deepEqual(await a.load(namespace,input.asset.assetId),input.asset);assert.equal((await a.inventory(namespace)).retained.count,0);
});

test('retirement requires exact selection snapshot and account/current guards before writes',async t=>{
  const input=await vibeInput(),f=await fixture(t,[input]),a=f.openVibes(),heads=await a.list(namespace),before=f.uploads;
  await assert.rejects(a.remove(namespace,[input.asset.assetId],{expectedHeads:[{...heads[0],createdAt:77}]}));
  await assert.rejects(a.remove(namespace,[input.asset.assetId],{isCurrent:()=>false}));assert.equal(f.uploads,before);
  f.account('st-user:changed');await assert.rejects(a.list(namespace));assert.equal(f.uploads,before);
});

test('actual NAI asset operations resolve an existing native encoding on an empty-IDB client without encoding service calls',async t=>{
  const input=await vibeInput(),f=await fixture(t,[input]);await f.openVibes().list(namespace);
  const run=createVibeAssetOperations(f.openVibes(f.empty()),{encodings:{remember:()=>assert.fail('no paid encoding')}});
  const value=await run({type:'resolve',namespace,id:input.asset.assetId,model:'nai-diffusion-4-full',information:0});assert.equal(value.data,btoa('encoded'));
  const file=await run({type:'export',namespace,ids:[input.asset.assetId],bundle:false});assert.equal(await file.text(),input.asset.serialized);
});

test('native space summary includes retained content once and UI explicitly distinguishes it from physical deletion',async t=>{
  const input=await vibeInput(),f=await fixture(t,[input]),a=f.openVibes(),ops=createVibeStorageOperations({store:a,encodings:ledger,locks});
  let view=await ops.inventory(namespace);const actions=createVibeStorageActions({namespace,guard:async()=>{},call:async type=>type==='storage-inventory'?view:{removed:1,bytes:0,retained:true},items:()=>[]});
  const snapshot=await actions.list();await actions.remove(snapshot,[input.asset.assetId],async(title,text)=>{assert.match(title,/移出/);assert.match(text,/不释放物理磁盘空间/);assert.match(text,/仅在本设备/);return true;});
  await ops.remove(namespace,[input.asset.assetId],view.fingerprint,true);view=await ops.inventory(namespace);const summary=await ops.summary(namespace);
  assert.equal(summary.version,3);assert.equal(summary.retained.count,1);assert.equal(summary.assets.count,0);assert.deepEqual(validateVibeStorageSummary(summary,namespace),summary);
  assert.equal(summary.bytes,summary.retained.bytes+summary.metadata.bytes);assert.throws(()=>validateVibeStorageSummary({...summary,bytes:summary.bytes-summary.retained.bytes},namespace));
});

test('close is permanent and concurrent queued calls cannot write after their caller becomes stale',async t=>{
  const f=await fixture(t),input=await vibeInput(),a=f.openVibes();let current=true;
  const one=a.list(namespace),two=a.putFile(namespace,input.asset.serialized,{isCurrent:()=>current});current=false;
  await one;await assert.rejects(two);assert.equal(f.uploads,0);a.close();await assert.rejects(a.list(namespace));
});
