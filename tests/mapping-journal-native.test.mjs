import test from 'node:test';
import assert from 'node:assert/strict';
import {characterNativeFixture,namespace} from './helpers/character-native-fixture.mjs';
import {mappingLegacyFixture} from './helpers/mapping-legacy-fixture.mjs';
import {mappingReceiptsFixture} from './fixtures/storyboard-mapping-receipts.mjs';
import {createNativeMappingJournal} from '../qianmu-mapping-journal-native.js';
import {createStoryboardPackageJournal} from '../qianmu-storyboard-package-journal.js';
import {MAPPING_NATIVE_SLOT,validateMappingNativeIndex} from '../qianmu-mapping-native-contract.js';
import {mappingHead} from '../qianmu-storyboard-mapping-contract.js';
import {captureBundleMappings} from '../qianmu-bundle-mappings.js';
import {runMappingRegistry} from '../qianmu-storyboard-mapping-registry.js';
import {aliasFixture} from './fixtures/storyboard-user-aliases.mjs';
import {createCharacterNativeStore} from '../qianmu-character-native-store.js';
import {characterLibraryBackupDigest} from '../qianmu-character-library-backup.js';
import {runUserAliasOperation} from '../qianmu-user-alias-runtime.js';

async function fixture(t){
  const f=await characterNativeFixture(t),rows=await mappingReceiptsFixture({namespace});
  const open=(local=mappingLegacyFixture(),options={})=>{const journal=createNativeMappingJournal({legacy:local.open(),createStorage:f.createStorage,now:()=>40,...options});t.after(()=>journal.close());return journal;};
  return Object.assign(f,{rows,open,read:()=>f.storage.read(MAPPING_NATIVE_SLOT)});
}
const key=row=>[namespace,row.kind,row.head.digest];
const store=(journal,row)=>journal.importMappingReceipt(row.receipt,{head:row.head,confirmed:true});

test('all four receipt types migrate through actual readonly legacy journal, preserving originals and first-save metadata',async t=>{
  const f=await fixture(t),local=mappingLegacyFixture(f.rows),before=structuredClone(local.state.rows),a=f.open(local);
  const heads=await a.listMappingHeads(namespace);assert.equal(heads.length,4);assert.deepEqual(local.state.rows,before);
  for(const row of f.rows)assert.deepEqual(await a.loadMappingReceipt(...key(row)),row.receipt);
  const b=f.open();for(const row of f.rows)assert.deepEqual(await b.loadMappingReceipt(...key(row)),row.receipt);
  assert.equal((await f.read()).value.retained.length,0);assert.ok(local.state.reads.length>0);
  assert.equal(f.calls.some(row=>/delete|plugins|generate/.test(row.path)),false);
});

test('old receipts with no metadata index are derived read-only; no old IDB writes or removals',async t=>{
  const f=await fixture(t),local=mappingLegacyFixture(f.rows,{indexed:false});
  assert.equal((await f.open(local).listMappingHeads(namespace)).length,4);assert.equal(local.state.indexed,false);assert.deepEqual(local.state.rows,f.rows);
});

test('empty journal reads do not create files; confirmed new mappings land in ST only and retain first timestamps',async t=>{
  const f=await fixture(t),local=mappingLegacyFixture(),a=f.open(local);
  assert.deepEqual(await a.listMappingHeads(namespace),[]);assert.equal(f.uploads,0);
  const [env,subject]=f.rows;
  await assert.rejects(a.prepareSubjectMap(subject.receipt.review));assert.equal(f.uploads,0);
  const x=await a.prepareSubjectMap(subject.receipt.review,{confirmed:true}),y=await a.prepareEnvironmentMap(env.receipt.review,{confirmed:true});
  assert.equal(x.createdAt,40);assert.equal(y.createdAt,40);assert.equal(local.state.rows.length,0);
  const b=f.open(undefined,{now:()=>99});assert.deepEqual(await b.prepareSubjectMap(subject.receipt.review,{confirmed:true}),x);
  assert.deepEqual(await b.inspectEnvironmentMap(env.receipt.review),{receipt:y,fits:true});assert.deepEqual(await b.loadSubjectMap(namespace,subject.head.digest),x);
});

test('exact explicit imports remain idempotent while differing first-save metadata is not overwritten',async t=>{
  const f=await fixture(t),a=f.open(),row=f.rows[1];await store(a,row);f.reset();assert.deepEqual(await store(a,row),row.receipt);assert.equal(f.uploads,0);
  const changed={...row.receipt,createdAt:999};await assert.rejects(a.importMappingReceipt(changed,{head:mappingHead(row.kind,changed),confirmed:true}),/首次/);
  assert.deepEqual(await a.loadMappingReceipt(...key(row)),row.receipt);assert.equal(f.uploads,0);
});

test('independent old devices with same review retain both exact receipts without selecting the latest timestamp',async t=>{
  const f=await fixture(t),row=f.rows[1];await store(f.open(),row);
  const alternate={...row.receipt,createdAt:900},local=mappingLegacyFixture([{kind:row.kind,receipt:alternate}]),a=f.open(local);
  assert.deepEqual(await a.loadSubjectMap(namespace,row.head.digest),row.receipt);
  const variants=await a.mappingPreservedSources(namespace);assert.equal(variants.length,1);assert.equal(variants[0].head.createdAt,900);
  assert.deepEqual((await f.storage.readImmutable(variants[0].reference)).value,alternate);assert.deepEqual(local.state.rows[0].receipt,alternate);
  f.reset();await f.open(local).listMappingHeads(namespace);assert.equal(f.uploads,0);assert.equal((await f.read()).value.retained.length,1);
  await assert.rejects(captureBundleMappings({namespace,journal:a}),/遗漏来源/);
});

test('later local append is picked up even on the same handle; repeated listing does not reread native originals',async t=>{
  const f=await fixture(t),local=mappingLegacyFixture([f.rows[0]]),a=f.open(local);assert.equal((await a.listMappingHeads(namespace)).length,1);
  local.state.rows.push(f.rows[1]);assert.equal((await a.listMappingHeads(namespace)).length,2);
  f.reset();await a.listMappingHeads(namespace);assert.equal(f.uploads,0);assert.equal(f.calls.some(row=>row.path.includes('-mapping-record-')),false);
});

test('failed old source read is not accepted as an empty source or published as a successful migration',async t=>{
  const f=await fixture(t),local=mappingLegacyFixture(f.rows);local.state.error=true;
  await assert.rejects(f.open(local).listMappingHeads(namespace),/不可用/);assert.equal(f.uploads,0);
});

test('changed local metadata during preservation stops index publication and keeps source and staged originals',async t=>{
  const f=await fixture(t),local=mappingLegacyFixture([f.rows[0]]);let changed=false;
  f.hook(call=>{if(!changed&&call.request.method==='POST'){changed=true;local.state.rows.push(f.rows[1]);}});
  await assert.rejects(f.open(local).listMappingHeads(namespace),/变化/);assert.equal((await f.read()).exists,false);
  assert.equal(local.state.rows.length,2);assert.ok(f.files.size>0);
});

test('invalid original proof or digest aborts migration before publishing a directory',async t=>{
  const f=await fixture(t),local=mappingLegacyFixture([f.rows[1]]);local.state.rows[0].receipt.review.lineage[0].target.archiveId='forged';
  await assert.rejects(f.open(local).listMappingHeads(namespace));assert.equal((await f.read()).exists,false);
});

test('native missing original is an error, never a return to local data or null receipt',async t=>{
  const f=await fixture(t),row=f.rows[1],a=f.open(mappingLegacyFixture([row]));await a.listMappingHeads(namespace);
  const {value}=await f.read(),ref=value.records[0].reference;f.files.delete(`qianmu-v2-${ref.scope}-${ref.slot}-${ref.fingerprint}.json`);f.reset();
  await assert.rejects(a.loadMappingReceipt(...key(row)));assert.equal(f.uploads,0);
});

test('known native directory disappearance or unreadable transport never rebuilds an empty library',async t=>{
  const f=await fixture(t),a=f.open();await store(a,f.rows[0]);const file=[...f.files.keys()].find(name=>name.endsWith('-mapping-library.json'));f.files.delete(file);f.reset();
  await assert.rejects(a.listMappingHeads(namespace),/缺失/);assert.equal(f.uploads,0);
  f.hook(call=>call.request.method==='GET'?Response.json({}, {status:503}):undefined);await assert.rejects(f.open().listMappingHeads(namespace));assert.equal(f.uploads,0);
});

test('account changes, signal cancellation and closed handles fail before another account gets a write',async t=>{
  const f=await fixture(t),a=f.open();f.account('st-user:other');await assert.rejects(store(a,f.rows[0]));assert.equal(f.uploads,0);
  f.account(namespace);const b=f.open(),controller=new AbortController();controller.abort();await assert.rejects(b.listMappingHeads(namespace,{signal:controller.signal}));
  await assert.rejects(b.prepareEnvironmentMap(f.rows[0].receipt.review,{confirmed:true,isCurrent:()=>false}));b.close();await assert.rejects(store(b,f.rows[0]));assert.equal(f.uploads,0);
});

test('account loss during original upload leaves no active directory and preserves the local source',async t=>{
  const f=await fixture(t),local=mappingLegacyFixture([f.rows[0]]);f.hook(call=>{if(call.request.method==='POST')f.live(false);});
  await assert.rejects(f.open(local).listMappingHeads(namespace));assert.equal([...f.files.keys()].some(name=>name.endsWith('-mapping-library.json')),false);assert.equal(local.state.rows.length,1);
});

test('lost directory acknowledgement is unconfirmed, not automatically retried; fresh read can recover it',async t=>{
  const f=await fixture(t),row=f.rows[1];let lost=false;
  f.hook(call=>{if(call.request.method!=='POST')return;const {name,data}=JSON.parse(call.request.body);if(name.endsWith('-mapping-library.json')&&!lost){lost=true;f.files.set(name,Buffer.from(data,'base64').toString());throw Error('ack lost');}});
  await assert.rejects(store(f.open(),row),error=>error.writeState==='unconfirmed');
  assert.equal(f.calls.filter(call=>call.request.method==='POST'&&JSON.parse(call.request.body).name.endsWith('-mapping-library.json')).length,1);
  f.hook(null);assert.deepEqual(await f.open().loadMappingReceipt(...key(row)),row.receipt);
});

test('independent clients append different reviews without replacing each other in the same realm',async t=>{
  const f=await fixture(t);await Promise.all(f.rows.map(row=>store(f.open(),row)));
  const heads=await f.open().listMappingHeads(namespace);assert.equal(heads.length,4);
});

test('registry, exact export and bundle capture consume native records on a device with no local receipts',async t=>{
  const f=await fixture(t);await f.open(mappingLegacyFixture(f.rows)).listMappingHeads(namespace);const journal=f.open();
  const list=await runMappingRegistry('mapping-list',{journal,namespace,input:{kind:'all',query:'',offset:0}});assert.equal(list.total,4);
  const capture=await captureBundleMappings({namespace,journal});assert.equal(capture.summary.count,4);await capture.verify();
  const output=await runMappingRegistry('mapping-export',{journal,namespace,input:{kind:'subjects',digest:f.rows[1].head.digest}});
  assert.deepEqual(JSON.parse(await output.file.text()).receipt,f.rows[1].receipt);
});

test('strict native contract rejects foreign references, duplicated or missing active sources and unknown fields',async t=>{
  const f=await fixture(t);await store(f.open(),f.rows[0]);const {value}=await f.read(),context={namespace,scope:f.storage.scope};
  for(const change of [v=>v.extra=true,v=>v.namespace='st-user:other',v=>v.revision=-1,v=>v.records.push(v.records[0]),v=>v.records[0].reference.scope='0'.repeat(64),v=>v.records[0].reference.slot='character-record',v=>{v.retained=v.records;v.records=[];},v=>v.retained.push(v.records[0])]){
    const changed=structuredClone(value);change(changed);assert.throws(()=>validateMappingNativeIndex(changed,context));
  }
});

test('shared factory defaults to native mapping storage while explicit local factory remains read-only legacy',async t=>{
  const f=await fixture(t),local=mappingLegacyFixture(f.rows);f.configure();const a=createStoryboardPackageJournal({indexedDB:local.indexedDB,keyRange:local.keyRange});t.after(()=>a.close());
  assert.equal(a.mappingPersistence,'st-account-file');assert.equal(a.persistence,'st-account-file');assert.equal((await a.listMappingHeads(namespace)).length,4);
  const b=local.open();t.after(()=>b.close());assert.equal(b.mappingPersistence,undefined);assert.equal((await b.listMappingHeads(namespace,{readOnly:true})).length,4);
});

test('caller mutation while preparing cannot change the approved source or account',async t=>{
  const f=await fixture(t),a=f.open(),input=structuredClone(f.rows[1].receipt.review),work=a.prepareSubjectMap(input,{confirmed:true});
  input.namespace='st-user:other';input.lineage[0].target.archiveId='wrong';
  const saved=await work;assert.deepEqual(saved.review,f.rows[1].receipt.review);
});

test('external publication racing a new receipt is kept and reported as a conflict, without blind retry',async t=>{
  const f=await fixture(t);await store(f.open(),f.rows[0]);const before=await f.read();
  await store(f.open(),f.rows[2]);const file=[...f.files.keys()].find(name=>name.endsWith('-mapping-library.json')),newHead=f.files.get(file);
  // Restore only the synthetic pointer, then simulate another realm publishing
  // its newer pointer between our immutable body and directory writes.
  const scope=f.storage.scope;f.files.set(file,JSON.stringify({schema:'qianmu.st-account-head.v1',scope,slot:MAPPING_NATIVE_SLOT,fingerprint:before.fingerprint}));
  let changed=false;f.hook(call=>{if(call.request.method==='POST'){const {name}=JSON.parse(call.request.body);if(name.includes('-mapping-library-')&&!changed){changed=true;f.files.set(file,newHead);}}});
  await assert.rejects(store(f.open(),f.rows[1]),/更新/);f.hook(null);
  const heads=await f.open().listMappingHeads(namespace);assert.equal(heads.length,2);assert.ok(heads.some(row=>row.digest===f.rows[2].head.digest));assert.ok(!heads.some(row=>row.digest===f.rows[1].head.digest));
});

test('quota failure occurs before uploading a new record and never prunes existing metadata',async t=>{
  const f=await fixture(t);await store(f.open(),f.rows[1]);const {value,fingerprint}=await f.read(),base=value.records[0];
  value.records=Array.from({length:256},(_,i)=>{const row=structuredClone(base),id=(i+1).toString(16).padStart(64,'0');row.head.digest=id;row.head.key=JSON.stringify([namespace,'subjects',id]);row.reference.fingerprint=id;return row;});
  await f.storage.write(MAPPING_NATIVE_SLOT,value,{expectedFingerprint:fingerprint});f.reset();
  assert.equal((await f.open().inspectSubjectMap(f.rows[1].receipt.review)).fits,false);
  await assert.rejects(f.open().prepareSubjectMap(f.rows[1].receipt.review,{confirmed:true}));assert.equal(f.uploads,0);assert.equal((await f.read()).value.records.length,256);
});

test('wrong type, digest, matched environment and invalid original timestamp do not write',async t=>{
  const f=await fixture(t),a=f.open();await assert.rejects(async()=>a.loadMappingReceipt(namespace,'other','a'.repeat(64)));
  await assert.rejects(async()=>a.loadSubjectMap(namespace,'bad'));await assert.rejects(store(a,{...f.rows[0],receipt:{...f.rows[0].receipt,createdAt:-1}}));
  const invalid=structuredClone(f.rows[0].receipt.review);invalid.target=invalid.source;await assert.rejects(a.prepareEnvironmentMap(invalid,{confirmed:true}));assert.equal(f.uploads,0);
});

for(const rejected of [false,true])test(`real USER reconciliation ${rejected?'stops on receipt failure':'saves receipt before bindings and both survive another client'}`,async t=>{
  const f=await fixture(t),roles=createCharacterNativeStore({createStorage:f.createStorage}),journal=f.open(),library={...aliasFixture(),namespace};t.after(()=>roles.close());
  await roles.restoreBackup(namespace,library,{expectedDigest:await characterLibraryBackupDigest(await roles.backup(namespace)),confirmed:true});
  const before=await roles.bindings(namespace),options={namespace,chatHash:'d'.repeat(64),journal,store:roles,guard:async()=>{},resolveTargets:async targets=>targets.map(subjectKey=>({subjectKey,present:true})),locks:{request:async(_name,_options,fn)=>fn({})}};
  const first=await runUserAliasOperation('user-alias-preview',{...options,input:{choices:{},offset:0}}),winner=first.rows.find(row=>row.conflict&&row.archiveId==='bob'),choices={[winner.groupId]:winner.candidateId};
  const preview=await runUserAliasOperation('user-alias-preview',{...options,input:{choices,offset:0}});
  f.hook(async call=>{
    if(call.request.method!=='POST')return;const {name}=JSON.parse(call.request.body);
    if(name.includes('-mapping-record-')&&rejected)return Response.json({}, {status:503});
    if(name.endsWith('-character-library.json'))assert.equal((await f.read()).value.records.length,1);
  });
  const apply=runUserAliasOperation('user-alias-apply',{...options,input:{choices,digest:preview.digest,confirmed:true}});
  if(rejected){await assert.rejects(apply);assert.deepEqual(await roles.bindings(namespace),before);assert.equal((await f.read()).exists,false);}
  else{const result=await apply,other=createCharacterNativeStore({createStorage:f.createStorage});t.after(()=>other.close());
    assert.equal(result.status,'verified');assert.notDeepEqual(await other.bindings(namespace),before);
    const receipt=await f.open().loadSubjectMap(namespace,result.receiptDigest);assert.equal(receipt.review.scope,'local-user-alias-resolution');assert.equal(receipt.review.lineage.length,3);
  }
});
