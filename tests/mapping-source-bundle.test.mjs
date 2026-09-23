import test from 'node:test';
import assert from 'node:assert/strict';
import {characterNativeFixture} from './helpers/character-native-fixture.mjs';
import {mappingLegacyFixture} from './helpers/mapping-legacy-fixture.mjs';
import {mappingReceiptsFixture} from './fixtures/storyboard-mapping-receipts.mjs';
import {carrierPack,carrierFixture,memoryCarrierStore,namespace} from './fixtures/bundle-carriers.mjs';
import {mappingHead} from '../qianmu-storyboard-mapping-contract.js';
import {createNativeMappingJournal} from '../qianmu-mapping-journal-native.js';
import {MAPPING_NATIVE_SLOT,validateMappingNativeIndex,planMappingNativeSources} from '../qianmu-mapping-native-contract.js';
import {captureBundleMappings,inspectBundleMappings} from '../qianmu-bundle-mappings.js';
import {captureBundleCarriers,inspectBundleCarriers} from '../qianmu-bundle-carriers.js';
import {createBundleCarrierRestore} from '../qianmu-bundle-carrier-restore.js';
import {planBundleMappingRestore,restoreBundleMappings,verifyBundleMappingRestore} from '../qianmu-bundle-mapping-restore.js';
import {openStoryboardBundle} from '../qianmu-storyboard-bundle.js';
import {sameBundleMappingHead} from '../qianmu-bundle-mapping-contract.js';
import {vibeDigest} from '../qianmu-vibe-file.js';

async function fixture(t,{seed=true}={}){
  const f=await characterNativeFixture(t,{account:namespace}),rows=await mappingReceiptsFixture({namespace});
  const open=()=>{const journal=createNativeMappingJournal({legacy:mappingLegacyFixture().open(),createStorage:f.createStorage});t.after(()=>journal.close());return journal;};
  const journal=open(),variants=rows.slice(0,2).map(({kind,receipt})=>{const value={...receipt,createdAt:receipt.createdAt+100};return {kind,receipt:value,head:mappingHead(kind,value)};});
  if(seed){for(const row of rows)await journal.importMappingReceipt(row.receipt,{head:row.head,confirmed:true});for(const row of variants)await journal.importMappingSource(row.receipt,{head:row.head,confirmed:true});}
  const pack=async(store=memoryCarrierStore().store)=>{const mappings=await captureBundleMappings({namespace,journal}),carriers=await captureBundleCarriers({namespace,store,mappings}),built=await carrierPack([...mappings.entries,...carriers.entries],40),opened=await openStoryboardBundle(built.file);
    const checkedMappings=await inspectBundleMappings(opened),checkedCarriers=await inspectBundleCarriers(opened,{mappings:checkedMappings});return {mappings,carriers,built,opened,checkedMappings,checkedCarriers};};
  return Object.assign(f,{rows,variants,journal,open,pack});
}

test('native retained receipts travel as existing flat carrier-original sections with exact first-save bytes',async t=>{
  const f=await fixture(t),pack=await f.pack();assert.equal(pack.mappings.index.heads.length,4);assert.equal(pack.carriers.summary.count,0);assert.equal(pack.carriers.summary.extraOriginalCount,2);
  assert.equal(pack.built.manifest.entries.filter(row=>row.id.startsWith('carrier-original:')).length,2);
  for(const row of f.variants){const text=JSON.stringify(row.receipt),sha=await vibeDigest(text),part=await pack.opened.read('carrier-original:'+sha);assert.equal(await part.file.text(),text);}
  await pack.mappings.verify();await pack.carriers.verify();assert.equal((await f.journal.listMappingHeads(namespace)).length,4);
});

test('empty target restores canonical history then retained raw sources; a fresh native client reads all originals',async t=>{
  const source=await fixture(t),pack=await source.pack(),target=await fixture(t,{seed:false}),carriers=memoryCarrierStore();
  const options={index:pack.mappings.index,opened:pack.opened,journal:target.journal},session=await createBundleCarrierRestore({opened:pack.opened,store:carriers.store,journal:target.journal});
  const mappingPlan=await planBundleMappingRestore(options),plan=await session.preview();assert.equal(mappingPlan.added,4);assert.equal(plan.originalCount,6);
  await restoreBundleMappings({...options,confirmed:true});await session.restore(plan,{confirmed:true});await session.verify();await verifyBundleMappingRestore(options);
  for(const row of [...source.rows,...source.variants])assert.deepEqual(await target.open().loadMappingSource(namespace,row.head),row.receipt);
  assert.equal((await target.journal.mappingPreservedSources(namespace)).length,2);assert.equal(carriers.state.originals.length,6);
  const reexport=await target.pack(carriers.store);assert.equal(reexport.carriers.summary.originalCount,6);assert.equal(reexport.carriers.summary.count,1);
  for(const row of pack.carriers.index.originals){const part=await reexport.opened.read(row.entryId);assert.equal(await part.file.text(),await (await pack.opened.read(row.entryId)).file.text());}
});

test('destination with a different current first-save timestamp retains its choice and imports both incoming originals',async t=>{
  const source=await fixture(t),pack=await source.pack(),target=await fixture(t,{seed:false}),row=source.rows[0],current={...row.receipt,createdAt:7000};
  await target.journal.importMappingSource(current,{head:mappingHead(row.kind,current),confirmed:true});
  const options={index:pack.mappings.index,opened:pack.opened,journal:target.journal},plan=await planBundleMappingRestore(options);assert.equal(plan.added,4);
  const store=memoryCarrierStore().store,session=await createBundleCarrierRestore({opened:pack.opened,store,journal:target.journal}),approved=await session.preview();
  await restoreBundleMappings({...options,confirmed:true});await session.restore(approved,{confirmed:true});await session.verify();
  assert.deepEqual(await target.journal.loadMappingReceipt(namespace,row.kind,row.head.digest),current);
  assert.deepEqual(await target.journal.loadMappingSource(namespace,row.head),row.receipt);
  assert.equal((await target.journal.listMappingSourceHeads(namespace)).length,7);
  assert.equal((await planBundleMappingRestore(options)).added,0);
});

test('new native source import requires confirmation, preserves strict ordinary import behavior and is idempotent',async t=>{
  const f=await fixture(t),row=f.variants[0];f.reset();
  await assert.rejects(f.journal.importMappingSource(row.receipt,{head:row.head}),/确认/);
  await assert.rejects(f.journal.importMappingReceipt(row.receipt,{head:row.head,confirmed:true}),/首次/);
  await f.journal.importMappingSource(row.receipt,{head:row.head,confirmed:true});assert.equal(f.uploads,0);
  assert.equal((await f.journal.inspectMappingSources(namespace,[row.head])).added,0);
});

test('capture detects later preserved sources and never discards them behind a previously valid active index',async t=>{
  const f=await fixture(t),snapshot=await captureBundleMappings({namespace,journal:f.journal}),row=f.rows[2],receipt={...row.receipt,createdAt:800};
  await f.journal.importMappingSource(receipt,{head:mappingHead(row.kind,receipt),confirmed:true});await assert.rejects(snapshot.verify(),/保全来源已变化/);
});

test('missing retained source body stops capture; a current receipt is not a replacement for it',async t=>{
  const f=await fixture(t),[row]=await f.journal.mappingPreservedSources(namespace),ref=row.reference;f.files.delete(`qianmu-v2-${ref.scope}-${ref.slot}-${ref.fingerprint}.json`);f.reset();
  await assert.rejects(captureBundleMappings({namespace,journal:f.journal}));assert.equal(f.uploads,0);
});

test('raw formatting variants remain byte-exact and deduplicate only on full raw hash',async t=>{
  const f=await carrierFixture({variant:true}),old=await captureBundleCarriers({namespace,store:f.store,mappings:f.mappings});
  const metadataVariant={...f.records[0].receipt,createdAt:1010},head=mappingHead('environment',metadataVariant),file=new Blob([JSON.stringify(metadataVariant)],{type:'application/json'}),sha=await vibeDigest(new Uint8Array(await file.arrayBuffer()));
  const {bundleCarrierOriginalHead}=await import('../qianmu-bundle-carrier-storage-contract.js');
  const capture=await captureBundleCarriers({namespace,store:f.store,mappings:{...f.mappings,preserved:[{head:bundleCarrierOriginalHead(namespace,sha,file.size),file}]}});
  assert.equal(capture.summary.originalCount,old.summary.originalCount+1);
  const opened=await openStoryboardBundle((await carrierPack([...f.mappings.entries,...capture.entries],71)).file);
  await inspectBundleCarriers(opened,{mappings:await inspectBundleMappings(opened)});
  assert.equal(await (await opened.read('carrier-original:'+sha)).file.text(),JSON.stringify(metadataVariant));
  assert.equal(head.digest,f.records[0].head.digest);
});

test('changed review meaning cannot be smuggled in as a first-save metadata variant',async t=>{
  const f=await fixture(t),pack=await f.pack(),preserved=structuredClone(f.variants[0].head);preserved.sourceDigest='f'.repeat(64);
  const {value}=await f.storage.read(MAPPING_NATIVE_SLOT);assert.throws(()=>planMappingNativeSources(value,[preserved]));
  const rows=pack.mappings.index.heads.filter(row=>row.key!==f.variants[0].head.key);
  await assert.rejects(captureBundleCarriers({namespace,store:memoryCarrierStore().store,mappings:{...pack.mappings,index:{...pack.mappings.index,heads:rows}}}),/同一完整历史映射/);
});

test('duplicate source heads under different immutable references fail strict native validation',async t=>{
  const f=await fixture(t),{value}=await f.storage.read(MAPPING_NATIVE_SLOT),copy=structuredClone(value.retained[0]);copy.reference.fingerprint='f'.repeat(64);value.retained.push(copy);
  assert.throws(()=>validateMappingNativeIndex(value,{namespace,scope:f.storage.scope}),/重复/);
});

test('native preservation quota includes all retained first-save variants before any upload',async t=>{
  const f=await fixture(t),{value,fingerprint}=await f.storage.read(MAPPING_NATIVE_SLOT),base=value.retained[0];
  value.retained=Array.from({length:512},(_,i)=>{const row=structuredClone(base);row.head.createdAt=1000+i;row.reference.fingerprint=(i+1).toString(16).padStart(64,'0');return row;});
  await f.storage.write(MAPPING_NATIVE_SLOT,value,{expectedFingerprint:fingerprint});const receipt={...f.rows[0].receipt,createdAt:9000},head=mappingHead('environment',receipt);f.reset();
  await assert.rejects(f.journal.inspectMappingSources(namespace,[head]),/名额|空间/);
  await assert.rejects(f.journal.importMappingSource(receipt,{head,confirmed:true}),/名额|空间/);assert.equal(f.uploads,0);
});

test('partial native restore is inspectable and explicit reopen adds only missing variants',async t=>{
  const source=await fixture(t),pack=await source.pack(),target=await fixture(t,{seed:false}),carriers=memoryCarrierStore(),options={index:pack.mappings.index,opened:pack.opened,journal:target.journal};
  const open=()=>createBundleCarrierRestore({opened:pack.opened,store:carriers.store,journal:target.journal});
  const session=await open(),approved=await session.preview();await restoreBundleMappings({...options,confirmed:true});
  let writes=0;target.hook(call=>{if(call.request.method==='POST'&&JSON.parse(call.request.body).name.includes('-mapping-record-')&&++writes===2)return Response.json({}, {status:503});});
  await assert.rejects(session.restore(approved,{confirmed:true}));assert.equal(carriers.state.originals.length,6);assert.equal((await target.journal.mappingPreservedSources(namespace)).length,1);
  target.hook(null);const resumed=await open(),plan=await resumed.preview();assert.equal(plan.addedOriginals,0);await assert.rejects(resumed.restore(plan),/确认/);
  await resumed.restore(plan,{confirmed:true});await resumed.verify();assert.equal((await target.journal.mappingPreservedSources(namespace)).length,2);
});

test('stage verification requires native source heads as well as retained raw carrier members',async t=>{
  const source=await fixture(t),pack=await source.pack(),target=await fixture(t,{seed:false}),carriers=memoryCarrierStore(),options={index:pack.mappings.index,opened:pack.opened,journal:target.journal};
  const session=await createBundleCarrierRestore({opened:pack.opened,store:carriers.store,journal:target.journal}),approved=await session.preview();await restoreBundleMappings({...options,confirmed:true});await session.restore(approved,{confirmed:true});
  const {value,fingerprint}=await target.storage.read(MAPPING_NATIVE_SLOT),removed=value.retained.pop();await target.storage.write(MAPPING_NATIVE_SLOT,value,{expectedFingerprint:fingerprint});
  await assert.rejects(session.verify(),/ST保全凭据尚未完整/);assert.equal(carriers.state.originals.length,6);
  const original=source.variants.find(row=>sameBundleMappingHead(row.head,removed.head)),sha=await vibeDigest(JSON.stringify(original.receipt));
  carriers.state.originals=carriers.state.originals.filter(row=>row.sha256!==sha);carriers.state.files.delete(sha);
  await assert.rejects(target.pack(carriers.store),/原清单声明的额外原件缺失/);
});

test('cancellation during preserved-source capture aborts without creating an incomplete package',async t=>{
  const f=await fixture(t);let active=true,reads=0;
  const journal={...f.journal,loadMappingSource:async(...args)=>{const row=await f.journal.loadMappingSource(...args);if(++reads===1)active=false;return row;}};
  await assert.rejects(captureBundleMappings({namespace,journal,isCurrent:()=>active}),/已变化/);assert.equal(reads,1);
});

test('different-current native mapping restore keeps original legacy import semantics for journals without source support',async t=>{
  const f=await fixture(t),pack=await f.pack(),row=f.rows[0],receipt={...row.receipt,createdAt:900},head=mappingHead(row.kind,receipt);
  const journal={listMappingHeads:async()=>[head],loadMappingReceipt:async()=>receipt,importMappingReceipt:async()=>assert.fail('no write')};
  await assert.rejects(planBundleMappingRestore({index:pack.mappings.index,opened:pack.opened,journal}),/首次记录不同/);
  const partial={...journal,importMappingSource:()=>{}};await assert.rejects(planBundleMappingRestore({index:pack.mappings.index,opened:pack.opened,journal:partial}),/接口不完整/);
});

test('native preserved originals already present in carrier storage are included once by exact raw hash',async t=>{
  const f=await fixture(t),source=await f.pack(),store=memoryCarrierStore().store;
  for(const row of source.mappings.preserved)await store.saveOriginal(namespace,row.file,{head:row.head,confirmed:true});
  const packed=await f.pack(store);assert.equal(packed.carriers.summary.originalCount,2);assert.equal(packed.carriers.summary.extraOriginalCount,2);
});

test('source preview validates full originals once and repeated stage verification reads only immutable metadata',async t=>{
  const source=await fixture(t),pack=await source.pack(),target=await fixture(t,{seed:false}),store=memoryCarrierStore().store;let rawReads=0;
  const opened={...pack.opened,read:async(...args)=>{rawReads++;return pack.opened.read(...args);}},options={index:pack.mappings.index,opened,journal:target.journal};
  const session=await createBundleCarrierRestore({opened,store,journal:target.journal}),approved=await session.preview(),before=rawReads;
  await session.preview();assert.equal(rawReads,before);
  await restoreBundleMappings({...options,confirmed:true});await session.restore(approved,{confirmed:true});const completed=rawReads;
  await session.verify();await session.verify();assert.equal(rawReads,completed);
});

test('new source import keeps the approved input and rejects changed identity before publishing a variant',async t=>{
  const f=await fixture(t),base=f.rows[2],receipt={...base.receipt,createdAt:444},head=mappingHead(base.kind,receipt);
  const pending=f.journal.importMappingSource(receipt,{head,confirmed:true});receipt.createdAt=445;await pending;
  assert.equal((await f.journal.loadMappingSource(namespace,head)).createdAt,444);
  const another={...base.receipt,createdAt:446},otherHead=mappingHead(base.kind,another);let active=true;
  f.hook(call=>{if(call.request.method==='POST'&&JSON.parse(call.request.body).name.includes('-mapping-record-'))active=false;});
  await assert.rejects(f.journal.importMappingSource(another,{head:otherHead,confirmed:true,isCurrent:()=>active}));f.hook(null);
  assert.equal(await f.journal.loadMappingSource(namespace,otherHead),null);
});

test('guarded native source API is read-only during planning and cannot use another account header',async t=>{
  const f=await fixture(t),row=f.rows[0],forged={...row.head,namespace:'st-user:other',key:JSON.stringify(['st-user:other',row.kind,row.head.digest])};f.reset();
  const p=await f.journal.inspectMappingSources(namespace,[row.head]);assert.equal(p.added,0);assert.equal(f.uploads,0);
  await assert.rejects(f.journal.loadMappingSource(namespace,forged));await assert.rejects(f.journal.inspectMappingSources(namespace,[forged]));assert.equal(f.uploads,0);
});
