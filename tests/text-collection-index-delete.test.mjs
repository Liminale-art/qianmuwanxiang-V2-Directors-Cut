import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {collectionIndexFixture,record,entry,account} from './helpers/collection-index-fixture.mjs';
import {writeIndexedCollection} from '../qianmu-text-collection-index-write.js';
import {validateNativeCollectionDocument} from '../qianmu-text-collection-document.js';
import {applyTextCollectionMutation,TEXT_COLLECTION_SYNC_LIMITS} from '../qianmu-text-collection-sync-contract.js';

const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const deletion=(row,index=0)=>({version:1,expectedAccount:account,mutationId:'delete-operation-'+index,operation:'delete',id:row.id,baseRevision:row.revision});
const counts=f=>({gets:f.calls.filter(call=>call.request.method==='GET').length,posts:f.uploads,originals:f.bodyReads});
const write=(f,inputs,time=()=>30)=>writeIndexedCollection({store:f.storage,expectedAccount:account,inputs,hashes:inputs.map(hash),
  validate:value=>validateNativeCollectionDocument(value,{expectedAccount:account,scope:f.storage.scope}),check:async()=>true,now:time});

for(const count of [1,3])test(`warm native ${count===1?'single':'batch'} deletion uses one compact update and never reads an original`,async t=>{
  const f=await collectionIndexFixture(t,Array.from({length:count},(_,i)=>record(i+1,'完整正文'.repeat(10000)))),s=await f.open();await s.list();f.reset();
  const handles=f.records.map(row=>s.prepareDelete(row.id,row.revision));
  const ack=await(count===1?handles[0].submit():s.prepareBatch(handles.map(handle=>handle.request)).submit());
  assert.deepEqual(counts(f),{gets:6,posts:2,originals:0},'one head/body read, pre-write/pre-commit heads, two uploads and complete read-back');
  const state=(await f.readIndex()).value;assert.equal(state.revision,count*2);assert.equal(state.receipts.length,count);
  assert.ok(state.entries.every(row=>row.deleted&&row.record===null));assert.equal(count===1?ack.revision:ack.results.length,count===1?2:count);
});

test('missing complete originals do not prevent deleting their validated directory entries',async t=>{
  const f=await collectionIndexFixture(t,[record(1),record(2)]),s=await f.open();await s.list();
  for(const row of f.descriptors){const ref=row.original;f.files.delete(`qianmu-v2-${ref.scope}-${ref.slot}-${ref.fingerprint}.json`);}f.reset();
  await s.prepareBatch(f.records.map(row=>s.prepareDelete(row.id,1).request)).submit();
  assert.deepEqual(counts(f),{gets:6,posts:2,originals:0});assert.equal((await s.list()).total,0);
});

test('a stale target rejects the entire deletion batch before any upload or partial tombstone',async t=>{
  const f=await collectionIndexFixture(t,[record(1),record(2)]),before=(await f.readIndex()).value,s=await f.open();await s.list();f.reset();
  const requests=f.records.map((row,i)=>s.prepareDelete(row.id,i===1?2:1).request);
  await assert.rejects(s.prepareBatch(requests).submit(),{code:'text_collection_sync_conflict'});
  assert.deepEqual(counts(f),{gets:2,posts:0,originals:0});assert.deepEqual((await f.readIndex()).value,before);
});

test('delete fast path refuses a changed legacy document without rewriting it',async t=>{
  const f=await collectionIndexFixture(t,[record(1)],{version:1}),before=(await f.readIndex()).value;f.reset();
  await assert.rejects(write(f,[deletion(f.records[0])]),{code:'text_collection_sync_changed'});
  assert.deepEqual(counts(f),{gets:2,posts:0,originals:0});assert.deepEqual((await f.readIndex()).value,before);
});

test('lost deletion head acknowledgement reconciles identical durable receipts without extra uploads or revisions',async t=>{
  const f=await collectionIndexFixture(t,[record(1),record(2)]),s=await f.open();await s.list();
  const batch=s.prepareBatch(f.records.map(row=>s.prepareDelete(row.id,1).request));f.reset();f.loseIndexAck();
  await assert.rejects(batch.submit(),cause=>cause.writeState==='unconfirmed');assert.equal(f.uploads,2);assert.equal(f.bodyReads,0);f.reset();
  const ack=await batch.submit();assert.deepEqual(counts(f),{gets:5,posts:0,originals:0});assert.equal(ack.libraryRevision,4);
  const state=(await f.readIndex()).value;assert.equal(state.revision,4);assert.equal(state.receipts.length,2);assert.ok(state.entries.every(row=>row.revision===2));
});

test('same mutation identity with changed deletion payload is rejected, never silently rebased',async t=>{
  const f=await collectionIndexFixture(t),input=deletion(f.records[0]);await write(f,[input]);const before=(await f.readIndex()).value;f.reset();
  await assert.rejects(write(f,[{...input,baseRevision:2}]),{code:'text_collection_sync_mutation_conflict'});
  assert.deepEqual(counts(f),{gets:2,posts:0,originals:0});assert.deepEqual((await f.readIndex()).value,before);
});

test('independent native deletions serialize through the existing directory queue and preserve both receipts',async t=>{
  const f=await collectionIndexFixture(t,[record(1),record(2)]),a=await f.open(),b=await f.open();await a.list();await b.list(undefined,{forceRefresh:true});f.reset();
  await Promise.all([a.prepareDelete(f.records[0].id,1).submit(),b.prepareDelete(f.records[1].id,1).submit()]);
  assert.deepEqual(counts(f),{gets:12,posts:4,originals:0});const state=(await f.readIndex()).value;
  assert.equal(state.revision,4);assert.equal(state.receipts.length,2);assert.ok(state.entries.every(row=>row.deleted));
});

test('a remote head change during deletion publication still blocks overwriting and preserves the remote directory',async t=>{
  const f=await collectionIndexFixture(t),s=await f.open();await s.list();const before=(await f.readIndex()).value;
  const remote={...before,migration:{remote:'preserved'}},scope=f.storage.scope,slot='collections';
  const body=JSON.stringify({schema:'qianmu.st-account-document.v1',scope,slot,value:remote}),fingerprint=createHash('sha256').update(body).digest('hex');
  let heads=0;f.reset();f.hook(({path,request})=>{
    if(request.method==='GET'&&path.endsWith('-collections.json')&&++heads===3){
      f.files.set(`qianmu-v2-${scope}-${slot}-${fingerprint}.json`,body);
      f.files.set(`qianmu-v2-${scope}-${slot}.json`,JSON.stringify({schema:'qianmu.st-account-head.v1',scope,slot,fingerprint}));
    }
  });
  await assert.rejects(s.prepareDelete(f.records[0].id,1).submit(),{code:'st_account_storage_conflict'});f.hook(null);
  assert.equal(f.uploads,1,'only an unpublished retained body may have uploaded');assert.equal(f.bodyReads,0);
  assert.deepEqual((await f.readIndex()).value,remote);
});

test('descriptor-only tombstone matches the complete-record transition, including a backward clock',async t=>{
  const f=await collectionIndexFixture(t),input=deletion(f.records[0]),expected=applyTextCollectionMutation(entry(f.records[0]),input,0);
  const result=await write(f,[input],()=>0);assert.deepEqual(result.verified.value.entries[0],expected);
});

for(const time of [NaN,-1,1.5,253402214400001])test(`invalid delete clock ${time} leaves the entire directory unchanged`,async t=>{
  const f=await collectionIndexFixture(t,[record(1),record(2)]),before=(await f.readIndex()).value;f.reset();let index=0;
  await assert.rejects(write(f,f.records.map(deletion),()=>index++===0?30:time),{code:'text_collection_sync_clock'});
  assert.deepEqual(counts(f),{gets:2,posts:0,originals:0});assert.deepEqual((await f.readIndex()).value,before);
});

test('delete refuses a timestamp increment past the contract ceiling before uploading',async t=>{
  const f=await collectionIndexFixture(t),before=(await f.readIndex()).value,last=structuredClone(before);
  last.entries[0].updatedAt=last.entries[0].summary.updatedAt=253402214400000;await f.writeIndex(last);f.reset();
  await assert.rejects(write(f,[deletion(f.records[0])]),{code:'text_collection_sync_clock'});
  assert.deepEqual(counts(f),{gets:2,posts:0,originals:0});assert.deepEqual((await f.readIndex()).value,last);
});

test('a mutation-capacity boundary rejects the complete batch rather than publishing its first deletion',async t=>{
  const f=await collectionIndexFixture(t,[record(1),record(2)]),before=(await f.readIndex()).value,full={...before,revision:TEXT_COLLECTION_SYNC_LIMITS.mutations-1};
  await f.writeIndex(full);f.reset();await assert.rejects(write(f,f.records.map(deletion)),{code:'text_collection_sync_capacity'});
  assert.deepEqual(counts(f),{gets:2,posts:0,originals:0});assert.deepEqual((await f.readIndex()).value,full);
});
