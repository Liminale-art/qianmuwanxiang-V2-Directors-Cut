import test from 'node:test';import assert from 'node:assert/strict';
import {characterNativeFixture} from './helpers/character-native-fixture.mjs';
import {carrierLegacyFixture} from './helpers/carrier-legacy-fixture.mjs';
import {carrierFixture,namespace,carrierPack} from './fixtures/bundle-carriers.mjs';
import {createBundleCarrierStore} from '../qianmu-bundle-carrier-store.js';
import {createNativeBundleCarrierStore} from '../qianmu-bundle-carrier-native-store.js';
import {CARRIER_NATIVE_SLOT,CARRIER_PROOF_SLOT,CARRIER_PART_SLOT,CARRIER_ORIGINAL_SLOT,CARRIER_PART_BYTES,validateCarrierNativeIndex} from '../qianmu-bundle-carrier-native-contract.js';
import {bundleCarrierOriginalHead,bundleCarrierHead} from '../qianmu-bundle-carrier-storage-contract.js';
import {captureBundleCarriers,inspectBundleCarriers} from '../qianmu-bundle-carriers.js';
import {openStoryboardBundle} from '../qianmu-storyboard-bundle.js';
import {createBundleCarrierProof,inspectBundleCarrierProof} from '../qianmu-bundle-carrier.js';
import {vibeDigest} from '../qianmu-vibe-file.js';
import {mappingReceiptsFixture} from './fixtures/storyboard-mapping-receipts.mjs';

async function fixture(t,{seed=false}={}){
  const f=await characterNativeFixture(t,{account:namespace}),source=await carrierFixture(),legacy=carrierLegacyFixture(seed?source:{});
  const open=(old=legacy)=>{const store=createNativeBundleCarrierStore({legacy:old.open(),createStorage:f.createStorage});t.after(()=>store.close());return store;};
  const store=open(),save=(target=store)=>target.saveBatch(namespace,{heads:source.heads,originals:source.originals},{confirmed:true,loadProof:head=>source.store.load(namespace,head.carrierDigest),loadOriginal:sha=>source.rawFiles.get(sha)});
  return Object.assign(f,{source,legacy,store,open,save});
}
test('native source factory is lazy and uses configured ST by default, explicit legacy remains available',async t=>{
  const f=await fixture(t);f.configure();const old=carrierLegacyFixture();
  const store=createBundleCarrierStore({indexedDB:old.indexedDB,keyRange:old.keyRange});t.after(()=>store.close());assert.equal(store.persistence,'st-account-file');
  const legacy=createBundleCarrierStore({native:false,indexedDB:old.indexedDB,keyRange:old.keyRange});t.after(()=>legacy.close());assert.equal(legacy.persistence,undefined);
  assert.equal(f.uploads,0);await store.list(namespace);assert.equal(f.uploads,0);
});
test('all exact proof texts and raw formatting survive default native storage and a second client with no local history',async t=>{
  const f=await fixture(t);await f.save();const next=f.open(carrierLegacyFixture()),value=await next.list(namespace);
  assert.equal(value.heads.length,2);assert.equal(value.originals.length,4);
  for(const proof of f.source.proofs)assert.deepEqual(await next.load(namespace,proof.carrierDigest),proof);
  for(const head of f.source.originals)assert.equal(await(await next.loadOriginal(namespace,head.sha256)).text(),await f.source.rawFiles.get(head.sha256).text());
  const captured=await captureBundleCarriers({namespace,store:next,mappings:f.source.mappings}),built=await carrierPack([...f.source.mappings.entries,...captured.entries]);
  assert.equal((await inspectBundleCarriers(await openStoryboardBundle(built.file),{mappings:f.source.mappings})).summary.count,2);
  assert.ok([...f.files.keys()].some(name=>name.includes('-carrier-original-part-')));
});
test('readonly legacy migration preserves all originals including those without a proof head and rereads only heads on later listings',async t=>{
  const f=await fixture(t,{seed:true});f.legacy.state.heads=[];f.legacy.state.proofs=[];
  const first=await f.store.list(namespace);assert.equal(first.heads.length,0);assert.equal(first.originals.length,4);
  f.legacy.state.reads=[];f.reset();await f.store.list(namespace);
  assert.equal(f.uploads,0);assert.equal(f.calls.filter(row=>row.request.method==='GET').length,2);
  assert.equal(f.legacy.state.reads.filter(row=>['proofs','originals'].includes(row.name)&&row.kind==='get').length,0);
});
test('old proof migration and late old-device additions are retained without modifying IDB',async t=>{
  const f=await fixture(t,{seed:true}),last=f.legacy.state.proofs.pop();f.legacy.state.heads.pop();
  assert.equal((await f.store.list(namespace)).heads.length,1);f.legacy.state.proofs.push(last);f.legacy.state.heads.push(f.source.heads[1]);
  assert.equal((await f.store.list(namespace)).heads.length,2);assert.deepEqual(f.legacy.state.originals,f.source.originals);
});
test('missing or unavailable legacy records are not replaced by an empty successful migration',async t=>{
  const f=await fixture(t,{seed:true});f.legacy.state.rawFiles.delete(f.source.originals[0].sha256);
  await assert.rejects(f.store.list(namespace),/缺件/);assert.equal(f.uploads,0);
  f.legacy.state.error=true;const fresh=f.open();await assert.rejects(fresh.list(namespace),/不可用/);assert.equal(f.uploads,0);
});
test('partial native saves keep confirmed originals and explicit retry only fills missing files',async t=>{
  const f=await fixture(t);let stopped=false;
  f.hook(call=>{if(call.request.method==='POST'){const body=JSON.parse(Buffer.from(JSON.parse(call.request.body).data,'base64').toString());if(body.slot===CARRIER_PART_SLOT&&!stopped&&f.files.size>=4){stopped=true;return new Response('{}',{status:503});}}});
  await assert.rejects(f.save(),/不可用/);f.hook(null);const partial=await f.store.list(namespace);assert.ok(partial.originals.length>0&&partial.originals.length<4);assert.equal(partial.heads.length,0);
  f.reset();await f.save();assert.equal((await f.store.list(namespace)).originals.length,4);
  f.reset();await f.save();assert.equal(f.uploads,0);
});
test('account switch, cancelled input and closed stores never continue publishing',async t=>{
  const f=await fixture(t);await assert.rejects(f.store.saveOriginal(namespace,f.source.rawFiles.values().next().value,{head:f.source.originals[0]}),/确认/);assert.equal(f.uploads,0);
  await assert.rejects(f.store.list(namespace,{isCurrent:()=>false}),/变化/);assert.equal(f.uploads,0);
  await f.store.list(namespace);f.account('st-user:other');await assert.rejects(f.store.list(namespace),/账户|会话|确认/);assert.equal(f.uploads,0);
  f.store.close();await assert.rejects(f.store.list(namespace),/变化/);
});
test('lost catalog acknowledgement does not auto-retry and a new client can read accepted bytes',async t=>{
  const f=await fixture(t);let lost=false;
  f.hook(call=>{if(call.request.method!=='POST')return;const payload=JSON.parse(call.request.body),body=Buffer.from(payload.data,'base64').toString(),value=JSON.parse(body);
    if(!lost&&value.schema==='qianmu.st-account-head.v1'&&value.slot===CARRIER_NATIVE_SLOT){lost=true;f.files.set(payload.name,body);throw Error('lost receipt');}});
  await assert.rejects(f.save(),error=>error.writeState==='unconfirmed');f.hook(null);assert.equal((await f.open(carrierLegacyFixture()).list(namespace)).originals.length,1);
});
test('missing established native catalog fails closed instead of falling back to local history',async t=>{
  const f=await fixture(t);await f.save();for(const name of f.files.keys())if(name.endsWith('-carrier-library.json'))f.files.delete(name);
  await assert.rejects(f.store.list(namespace),/目录缺失/);
});
test('native source catalog enforces account-bound references and unchanged logical budgets',async t=>{
  const f=await fixture(t);await f.save();const value=(await f.storage.read(CARRIER_NATIVE_SLOT)).value;
  validateCarrierNativeIndex(value,{namespace,scope:f.storage.scope});
  for(const change of [x=>x.originals[0].reference.scope='a'.repeat(64),x=>x.proofs[0].reference.slot=CARRIER_ORIGINAL_SLOT,x=>x.originals.push(x.originals[0]),x=>x.extra=true]){
    const copy=structuredClone(value);change(copy);assert.throws(()=>validateCarrierNativeIndex(copy,{namespace,scope:f.storage.scope}));
  }
});
test('oversized and semantically invalid originals are refused before immutable uploads',async t=>{
  const f=await fixture(t),head=f.source.originals[0];
  await assert.rejects(f.store.saveOriginal(namespace,new Blob(['{}']),{head,confirmed:true}),/大小/);assert.equal(f.uploads,0);
  const invalid=new Blob(['{}']),sha=await vibeDigest('{}');await assert.rejects(f.store.saveOriginal(namespace,invalid,{head:bundleCarrierOriginalHead(namespace,sha,2),confirmed:true}),/结构|不完整|无效/);assert.equal(f.uploads,0);
});
test('multi-part raw JSON retains whitespace and number spellings across chunk boundaries',async t=>{
  const f=await fixture(t),raw=await f.source.rawFiles.values().next().value.text(),text=' '.repeat(CARRIER_PART_BYTES)+raw,file=new Blob([text],{type:'application/json'}),head=bundleCarrierOriginalHead(namespace,await vibeDigest(text),file.size);
  await f.store.saveOriginal(namespace,file,{head,confirmed:true});const restored=await f.open(carrierLegacyFixture()).loadOriginal(namespace,head.sha256);assert.equal(await restored.text(),text);
  const value=(await f.storage.read(CARRIER_NATIVE_SLOT)).value,record=await f.storage.readImmutable(value.originals[0].reference);assert.equal(record.value.parts.length,2);
});

test('maximum-length UTF-8 account labels fit part envelopes without weakening raw payload limits',async t=>{
  const account='st-user:'+'界'.repeat(504),f=await characterNativeFixture(t,{account}),rows=await mappingReceiptsFixture({namespace:account});
  const store=createNativeBundleCarrierStore({legacy:carrierLegacyFixture().open(),createStorage:f.createStorage});t.after(()=>store.close());
  const text=' '.repeat(CARRIER_PART_BYTES)+JSON.stringify(rows[0].receipt),file=new Blob([text],{type:'application/json'}),head=bundleCarrierOriginalHead(account,await vibeDigest(text),file.size);
  await store.saveOriginal(account,file,{head,confirmed:true});assert.equal(await(await store.loadOriginal(account,head.sha256)).text(),text);
});
test('member digest mismatch never publishes a proof even when other originals have been preserved',async t=>{
  const f=await fixture(t);await f.store.saveOriginal(namespace,f.source.rawFiles.values().next().value,{head:f.source.originals[0],confirmed:true});
  await assert.rejects(f.store.saveBatch(namespace,{heads:f.source.heads,originals:[]},{confirmed:true,loadProof:head=>f.source.store.load(namespace,head.carrierDigest),loadOriginal:()=>null}),/成员不完整/);
  const after=await f.store.list(namespace);assert.equal(after.heads.length,0);assert.equal(after.originals.length,1);
});

test('late legacy additions invalidate the readonly adoption snapshot before catalog publication',async t=>{
  const f=await fixture(t,{seed:true});f.legacy.state.proofs.pop();f.legacy.state.heads.pop();let changed=false;
  f.hook(call=>{if(!changed&&call.request.method==='POST'){changed=true;f.legacy.state.proofs.push(f.source.proofs[1]);f.legacy.state.heads.push(f.source.heads[1]);}});
  // The shared ST transport intentionally sanitizes an external guard failure.
  await assert.rejects(f.store.list(namespace),error=>error.code==='st_account_storage_connection');assert.equal((await f.storage.read(CARRIER_NATIVE_SLOT)).exists,false);
  f.hook(null);assert.equal((await f.store.list(namespace)).heads.length,2);
});
test('missing raw parts and damaged proof bodies never fall back to local replacements',async t=>{
  const f=await fixture(t);await f.save();const index=(await f.storage.read(CARRIER_NATIVE_SLOT)).value;
  const raw=await f.storage.readImmutable(index.originals[0].reference),part=raw.value.parts[0].reference;
  for(const name of f.files.keys())if(name.endsWith('-'+part.fingerprint+'.json'))f.files.delete(name);
  await assert.rejects(f.store.loadOriginal(namespace,index.originals[0].head.sha256),/原件已不可读/);
  for(const [name,body] of f.files)if(name.includes('-carrier-proof-')){f.files.set(name,body.replace('manifestText','forgedField'));break;}
  await assert.rejects(f.store.load(namespace,index.proofs[0].head.carrierDigest),/校验失败/);
});
test('lost membership before proof publication is rejected inside the fresh index update',async t=>{
  const f=await fixture(t);let changed=false;
  f.hook(async call=>{if(call.request.method!=='POST')return;const envelope=JSON.parse(Buffer.from(JSON.parse(call.request.body).data,'base64').toString());
    if(!changed&&envelope.slot===CARRIER_PROOF_SLOT){changed=true;f.hook(null);const prior=await f.storage.read(CARRIER_NATIVE_SLOT);await f.storage.write(CARRIER_NATIVE_SLOT,{...prior.value,originals:[],revision:prior.value.revision+1},{expectedFingerprint:prior.fingerprint});}
  });await assert.rejects(f.save(),/发布证明前已变化/);assert.equal((await f.storage.read(CARRIER_NATIVE_SLOT)).value.proofs.length,0);
});
test('same-account concurrent saves merge distinct source entries and do not lose either original',async t=>{
  const f=await fixture(t),second=f.open(carrierLegacyFixture());
  await Promise.all(f.source.originals.slice(0,2).map((head,index)=>(index?second:f.store).saveOriginal(namespace,f.source.rawFiles.get(head.sha256),{head,confirmed:true})));
  assert.equal((await f.store.list(namespace)).originals.length,2);
});
test('batch captures caller metadata before asynchronous work and never publishes mutated references',async t=>{
  const f=await fixture(t),input={heads:structuredClone(f.source.heads),originals:structuredClone(f.source.originals)};
  const pending=f.store.saveBatch(namespace,input,{confirmed:true,loadProof:head=>f.source.store.load(namespace,head.carrierDigest),loadOriginal:sha=>f.source.rawFiles.get(sha)});
  input.heads.length=0;input.originals[0].sha256='0'.repeat(64);await pending;assert.equal((await f.store.list(namespace)).heads.length,2);
});

test('native batched writes are linear and later catalog reads fetch no raw file bodies under synthetic latency',async t=>{
  const f=await fixture(t),files=new Map(),heads=[];
  for(let at=0;at<12;at++){const text=JSON.stringify({...f.source.records[0].receipt,createdAt:2000+at}),sha=await vibeDigest(text),file=new Blob([text],{type:'application/json'});files.set(sha,file);heads.push(bundleCarrierOriginalHead(namespace,sha,file.size));}
  f.reset();f.hook(()=>new Promise(resolve=>setTimeout(resolve,3)));const start=performance.now();
  await f.store.saveBatch(namespace,{heads:[],originals:heads},{confirmed:true,loadProof:()=>null,loadOriginal:sha=>files.get(sha)});
  const calls=f.calls.length,ms=performance.now()-start;assert.ok(calls<=100,'v336 needed 170 requests for the same fixture');f.reset();const listed=await f.store.list(namespace);
  assert.equal(listed.originals.length,12);assert.equal(f.calls.length,2);assert.equal(f.uploads,0);
  t.diagnostic(JSON.stringify({rawCount:12,batchRequests:calls,batchMs:Math.round(ms),catalogRequests:f.calls.length,latency:'3ms per request; synthetic only, not VPS timing'}));
});

async function rawBatch(f,count){
  const files=new Map(),originals=[];
  for(let at=0;at<count;at++){const text=JSON.stringify({...f.source.records[0].receipt,createdAt:5000+at}),file=new Blob([text],{type:'application/json'}),sha=await vibeDigest(text);files.set(sha,file);originals.push(bundleCarrierOriginalHead(namespace,sha,file.size));}
  return {input:{heads:[],originals},files,options:{confirmed:true,loadProof:()=>null,loadOriginal:sha=>files.get(sha)}};
}
test('128 exact originals publish bounded metadata batches rather than a full directory per file',async t=>{
  const f=await fixture(t),batch=await rawBatch(f,128);f.reset();await f.store.saveBatch(namespace,batch.input,batch.options);
  assert.ok(f.calls.length<=7*128+24);const published=f.calls.filter(call=>call.request.method==='POST'&&JSON.parse(call.request.body).name.endsWith('-carrier-library.json'));assert.equal(published.length,17);
  assert.equal((await f.store.list(namespace)).originals.length,128);const last=batch.input.originals.at(-1);assert.equal(await(await f.open(carrierLegacyFixture()).loadOriginal(namespace,last.sha256)).text(),await batch.files.get(last.sha256).text());
});
test('interrupted trailing original batch stays immutable, does not publish after error and is reused on explicit retry',async t=>{
  const f=await fixture(t),batch=await rawBatch(f,12);let reads=0;
  await assert.rejects(f.store.saveBatch(namespace,batch.input,{...batch.options,loadOriginal:sha=>{if(++reads===3)throw Error('interrupted source');return batch.files.get(sha);}}),/interrupted source/);
  assert.equal((await f.store.list(namespace)).originals.length,1);
  const retained=new Set(f.calls.filter(call=>call.request.method==='POST').map(call=>JSON.parse(call.request.body).name).filter(name=>name.includes('-carrier-original-')));assert.equal(retained.size,4);
  f.reset();await f.store.saveBatch(namespace,batch.input,batch.options);
  assert.ok(f.calls.filter(call=>call.request.method==='POST').every(call=>!retained.has(JSON.parse(call.request.body).name)));assert.equal((await f.store.list(namespace)).originals.length,12);
});
test('progress is emitted only after checked native work and scope loss prevents buffered directory publication',async t=>{
  const f=await fixture(t),batch=await rawBatch(f,12);let progress=0,live=true;
  const store=createNativeBundleCarrierStore({legacy:carrierLegacyFixture().open(),createStorage:f.createStorage,onProgress:()=>{if(++progress===7)live=false;}});t.after(()=>store.close());
  await assert.rejects(store.saveBatch(namespace,batch.input,{...batch.options,isCurrent:()=>live}),/变化/);
  assert.ok(progress>=2);const index=await f.storage.read(CARRIER_NATIVE_SLOT);assert.equal(index.value.originals.length,1);
  const before=f.uploads;await new Promise(resolve=>setTimeout(resolve,10));assert.equal(f.uploads,before);
});
test('proof batches retain checked immutable tails without publishing missing or failed members',async t=>{
  const f=await fixture(t),proofs=[];
  for(let at=0;at<10;at++){const packed=await carrierPack(f.source.rawEntries,100+at),proof=await createBundleCarrierProof(await openStoryboardBundle(packed.file));proofs.push({proof,head:bundleCarrierHead((await inspectBundleCarrierProof(proof)).summary)});}
  const input={heads:proofs.map(row=>row.head),originals:f.source.originals},options={confirmed:true,loadOriginal:sha=>f.source.rawFiles.get(sha),loadProof:head=>proofs.find(row=>row.head.key===head.key).proof};let reads=0;
  await assert.rejects(f.store.saveBatch(namespace,input,{...options,loadProof:head=>{if(++reads===3)throw Error('proof source changed');return options.loadProof(head);}}),/proof source changed/);
  const partial=await f.store.list(namespace);assert.equal(partial.originals.length,4);assert.equal(partial.heads.length,1);
  await f.store.saveBatch(namespace,input,options);assert.equal((await f.store.list(namespace)).heads.length,10);
});
