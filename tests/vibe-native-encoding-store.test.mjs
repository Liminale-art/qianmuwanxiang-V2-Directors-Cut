import test from 'node:test';
import assert from 'node:assert/strict';
import {createVibeEncodingStore,createLocalVibeEncodingStore} from '../qianmu-vibe-encoding-store.js';
import {createNativeVibeEncodingStore} from '../qianmu-vibe-native-encoding-store.js';
import {createVibeReceiptCatalogue} from '../qianmu-vibe-receipt-catalogue.js';
import {receiptInput} from './helpers/vibe-receipt-fixture.mjs';
import {receiptWritableFixture} from './helpers/vibe-receipt-writable-fixture.mjs';
import {characterNativeFixture,namespace} from './helpers/character-native-fixture.mjs';

const id=input=>input.receipt.cacheKey,ref={version:1,namespace,id:'c'.repeat(64)};
async function fixture(t,inputs=[]){const native=await characterNativeFixture(t),local=receiptWritableFixture(inputs);
  const open=(db=local,options={})=>{const store=createNativeVibeEncodingStore({legacy:db.open(),createStorage:native.createStorage,...options});t.after(()=>store.close());return store;};
  const raw=(db=local)=>{const store=db.open();t.after(()=>store.close());return store;};
  return Object.assign(native,{local,open,raw});
}
const reserve=(store,input,attemptId='new-encoding-attempt',options={})=>store.reserve(namespace,id(input),input.receipt.identity,attemptId,{sourceAssetRef:input.receipt.sourceAssetRef,delivery:input.receipt.delivery,...options});

test('actual local store mirror installs complete native receipt and review segments atomically',async()=>{
  const input=await receiptInput({reviewCount:65}),local=receiptWritableFixture(),store=local.open();
  await store.materialize(namespace,input,null);assert.deepEqual(await store.get(namespace,id(input)),input.receipt);
  assert.equal((await store.census(namespace)).reviewSegments.length,3);assert.equal((await store.reviewHistory(namespace,id(input),input.receipt)).reviews.length,65);
  await assert.rejects(store.materialize(namespace,input,null),/已变化/);store.close();
});
test('local mirror rollback, stale snapshot, wrong account and wrong key leave the original untouched',async()=>{
  const input=await receiptInput(),local=receiptWritableFixture([input]),store=local.open(),next=structuredClone(input);next.receipt.status='submitting';
  local.state.failWrite=true;await assert.rejects(store.materialize(namespace,next,input));assert.deepEqual(await store.get(namespace,id(input)),input.receipt);local.state.failWrite=false;
  const stale=structuredClone(input);stale.receipt.updatedAt=2;await assert.rejects(store.materialize(namespace,next,stale),/已变化/);
  await assert.rejects(store.materialize('st-user:other',next,input));assert.deepEqual(await store.get(namespace,id(input)),input.receipt);store.close();
});
test('default factory selects ST when configured and explicit local factory remains local for late result retention',async t=>{
  const f=await fixture(t),input=await receiptInput();f.configure();t.mock.method(globalThis,'fetch',f.fetchImpl);
  for(const [name,value] of [['indexedDB',f.local.indexedDB],['IDBKeyRange',f.local.keyRange]]){const previous=Object.getOwnPropertyDescriptor(globalThis,name);Object.defineProperty(globalThis,name,{value,configurable:true});t.after(()=>previous?Object.defineProperty(globalThis,name,previous):delete globalThis[name]);}
  const store=createVibeEncodingStore({now:()=>10});t.after(()=>store.close());
  assert.equal((await reserve(store,input)).owned,true);assert.ok(f.uploads>0);const before=f.uploads;
  const local=createLocalVibeEncodingStore({indexedDB:f.local.indexedDB,keyRange:f.local.keyRange});t.after(()=>local.close());await local.get(namespace,id(input));assert.equal(f.uploads,before);
});
test('first reservation is locally atomic and remotely published with its explicit predecessor before authorizing',async t=>{
  const f=await fixture(t),input=await receiptInput(),store=f.open();const reserved=await reserve(store,input);assert.equal(reserved.owned,true);
  const another=f.open(receiptWritableFixture());assert.deepEqual(await another.get(namespace,id(input)),reserved.receipt);assert.equal((await reserve(another,input,'another-device-attempt')).owned,false);
  const submitting=await store.transition(namespace,id(input),reserved.receipt.attemptId,'submitting');assert.equal(submitting.status,'submitting');
  assert.deepEqual(await another.get(namespace,id(input)),submitting);assert.ok(f.local.state.transactions.some(row=>row.mode==='readwrite'));
});
test('reviewed retry publishes one linked successor, not an unrelated legacy candidate root',async t=>{
  const input=await receiptInput({status:'reviewed',reviewCount:33}),f=await fixture(t,[input]),store=f.open();
  const first=await store.get(namespace,id(input)),next=await reserve(store,input,'next-paid-attempt',{retryAttemptId:first.attemptId});assert.equal(next.owned,true);
  const other=f.open(receiptWritableFixture());assert.equal((await other.get(namespace,id(input))).attemptId,'next-paid-attempt');assert.equal((await other.reviewHistory(namespace,id(input),next.receipt)).reviews.length,33);
  assert.equal(next.receipt.pastReviews[0].attemptId,first.attemptId);assert.equal((await reserve(other,input,'third-paid-attempt')).owned,false);
});
test('native write failure or lost acknowledgement blocks owned return and preserves uncertain local reservation',async t=>{
  for(const lost of [false,true]){const f=await fixture(t),input=await receiptInput(),store=f.open();let writes=0;
    f.hook(call=>{if(call.path!=='/api/files/upload')return;const {name,data}=JSON.parse(call.request.body);if(!name.endsWith('-vibe-receipt-catalogue.json'))return;writes++;if(lost)f.files.set(name,Buffer.from(data,'base64').toString());throw Error('no acknowledgement');});
    await assert.rejects(reserve(store,input));assert.equal(writes,1);assert.equal((await f.raw().get(namespace,id(input))).status,'reserved');
    f.hook(null);assert.equal((await reserve(store,input,'retry-without-review')).owned,false);
  }
});
test('local reservation failure cannot publish a fresh request or fall back to a paid path',async t=>{
  const f=await fixture(t),input=await receiptInput(),store=f.open();f.local.state.failWrite=true;await assert.rejects(reserve(store,input));assert.equal(f.uploads,0);assert.equal(f.local.state.tables.receipts.length,0);
});
test('account switch after native reservation blocks return while retaining only the original namespace',async t=>{
  const f=await fixture(t),input=await receiptInput(),store=f.open();f.hook(call=>{if(call.path!=='/api/files/upload')return;const {name}=JSON.parse(call.request.body);if(name.endsWith('-vibe-receipt-catalogue.json'))f.account('st-user:other');});
  await assert.rejects(reserve(store,input));assert.equal((await f.raw().get(namespace,id(input))).namespace,namespace);assert.ok(!f.local.state.tables.receipts.some(row=>row.namespace==='st-user:other'));
});
test('late local ready result is adopted on the next guarded native read without another encoding request',async t=>{
  const f=await fixture(t),input=await receiptInput(),store=f.open(),reserved=await reserve(store,input);await store.transition(namespace,id(input),reserved.receipt.attemptId,'submitting');
  f.account('st-user:other');const ready=await f.raw().transition(namespace,id(input),reserved.receipt.attemptId,'ready',{assetRef:ref});const before=f.uploads;await assert.rejects(store.get(namespace,id(input)));assert.equal(f.uploads,before);
  f.account(namespace);assert.deepEqual(await store.get(namespace,id(input)),ready);assert.deepEqual(await f.open(receiptWritableFixture()).get(namespace,id(input)),ready);
});
test('fresh client can review a remote uncertain request then retry with all previous evidence intact',async t=>{
  const input=await receiptInput(),f=await fixture(t,[input]);await f.open().get(namespace,id(input));const local=receiptWritableFixture(),store=f.open(local),row=await store.get(namespace,id(input));
  const proof=await store.previewLocalReview(namespace,id(input),row);const reviewed=await store.reviewLocal(namespace,id(input),row,proof,true);assert.equal(reviewed.status,'reviewed');
  const next=await reserve(store,input,'after-user-review',{retryAttemptId:reviewed.attemptId});assert.equal(next.owned,true);assert.equal(next.receipt.pastReviews.length,1);
});
test('ready records and paged archive are native, explicit archiving does not resurrect from a stale device',async t=>{
  const input=await receiptInput({status:'ready',reviewCount:2}),f=await fixture(t,[input]),store=f.open();await store.get(namespace,id(input));
  const client=f.open(receiptWritableFixture());assert.deepEqual(await client.archiveCompleted(namespace,[input.receipt],true),{archived:1,bytes:Buffer.byteLength(JSON.stringify(input.receipt))});
  assert.deepEqual(await store.list(namespace),[]);const page=await store.archivePage(namespace);assert.deepEqual(page.rows,[input.receipt]);assert.equal(page.count,1);
  const info=await client.inventory(namespace);assert.equal(info.receipts.length,0);assert.equal(info.archived.count,1);assert.equal(info.reviewHistory.reviews,2);assert.equal(info.metadata.count,1);
});
test('archive and compact require confirmation and reject changed expected rows',async t=>{
  const input=await receiptInput({status:'ready'}),f=await fixture(t,[input]),store=f.open();
  await assert.rejects(store.archiveCompleted(namespace,[input.receipt],false));await assert.rejects(store.archiveCompleted(namespace,[{...input.receipt,updatedAt:2}],true));
  await assert.rejects(store.compactReviews(namespace,id(input),input.receipt,false));assert.equal((await store.get(namespace,id(input))).status,'ready');
});
test('multi-record archive publishes the whole local batch without stale-predecessor failure on later rows',async t=>{
  const inputs=await Promise.all([0,.5,1].map(information=>receiptInput({status:'ready',information}))),f=await fixture(t,inputs),store=f.open();
  const result=await store.archiveCompleted(namespace,inputs.map(row=>row.receipt),true);assert.equal(result.archived,3);
  assert.equal((await store.list(namespace)).length,0);const fresh=f.open(receiptWritableFixture());assert.equal((await fresh.archivePage(namespace)).rows.length,3);
  assert.equal(f.local.state.tables.archive.length,3);assert.equal(f.local.state.tables.receipts.length,0);
});
test('failed native archive publication keeps the complete atomic local batch and reconciles on next read',async t=>{
  const inputs=await Promise.all([0,1].map(information=>receiptInput({status:'ready',information}))),f=await fixture(t,inputs),store=f.open();
  f.hook(call=>{if(call.path==='/api/files/upload'&&JSON.parse(call.request.body).name.endsWith('-vibe-receipt-catalogue.json')&&f.local.state.tables.archive.length)throw Error('archive head unavailable');});
  await assert.rejects(store.archiveCompleted(namespace,inputs.map(row=>row.receipt),true));assert.equal(f.local.state.tables.archive.length,2);
  f.hook(null);assert.equal((await store.archivePage(namespace)).rows.length,2);assert.equal((await f.open(receiptWritableFixture()).archivePage(namespace)).rows.length,2);
});
test('same-account unrelated attempts stop reads and mutations instead of choosing the newer ready row',async t=>{
  const input=await receiptInput(),f=await fixture(t,[input]),store=f.open();await store.get(namespace,id(input));const alien=structuredClone(input);alien.receipt.attemptId='alien-new-attempt';alien.receipt.updatedAt=9999;
  const other=f.open(receiptWritableFixture([alien]));await assert.rejects(other.get(namespace,id(input)),/尚未核对/);await assert.rejects(reserve(other,input),/尚未核对/);await assert.rejects(other.inventory(namespace),/未核对分歧/);
});
test('native mirror compare-and-swap detects an old page editing local receipts during hydration',async t=>{
  const input=await receiptInput(),f=await fixture(t,[input]);await f.open().get(namespace,id(input));const local=receiptWritableFixture(),store=f.open(local);
  local.state.beforeTransaction=({mode})=>{if(mode==='readwrite'){local.state.beforeTransaction=null;local.state.tables.receipts=[{...input.receipt,attemptId:'concurrent-local-attempt'}];}};
  await assert.rejects(reserve(store,input),/已变化/);assert.equal(local.state.tables.receipts[0].attemptId,'concurrent-local-attempt');
});
test('closing native store or an expired guard prevents mutations and exposes no partial output',async t=>{
  const f=await fixture(t),input=await receiptInput();let live=true;const store=f.open(f.local,{guard:()=>live});live=false;await assert.rejects(reserve(store,input));assert.equal(f.uploads,0);store.close();await assert.rejects(store.get(namespace,id(input)));
});
test('publish candidate deferral still adopts every OTHER local receipt and checks candidate changes',async t=>{
  const a=await receiptInput({status:'rejected'}),b=await receiptInput({information:1}),f=await fixture(t,[a,b]),catalogue=createVibeReceiptCatalogue({legacy:f.local.open(),createStorage:f.createStorage});t.after(()=>catalogue.close());
  const state=await catalogue.checkout(namespace,id(a)),local=f.raw(),reserved=await reserve(local,a,'deferred-attempt',{retryAttemptId:a.receipt.attemptId}),data=await local.census(namespace),candidate={namespace,section:'current',receipt:reserved.receipt,segments:[]};
  await catalogue.publish(namespace,candidate,state.heads);assert.equal((await catalogue.get(namespace,id(a))).receipt.attemptId,'deferred-attempt');assert.equal((await catalogue.get(namespace,id(b))).receipt.status,'unknown');assert.equal(data.current.length,2);
});

test('native review compaction preserves inline history as complete segments on empty-local clients',async t=>{
  const input=await receiptInput({status:'ready',reviewCount:16});input.receipt.pastReviews=input.segments[0].reviews;delete input.receipt.reviewArchive;input.segments=[];
  const f=await fixture(t,[input]),store=f.open();const compacted=await store.compactReviews(namespace,id(input),input.receipt,true);assert.equal(compacted.moved,16);
  const fresh=f.open(receiptWritableFixture()),row=await fresh.get(namespace,id(input));assert.equal(row.pastReviews,undefined);assert.equal((await fresh.reviewHistory(namespace,id(input),row)).reviews.length,16);
});
test('service review and recovery require exact provenance, and keep the fee review when settling ready',async t=>{
  const input=await receiptInput();input.receipt.delivery={version:1,transport:'service',channelKey:'b'.repeat(64),serviceAttemptId:'e'.repeat(64)};
  const f=await fixture(t,[input]),store=f.open(),serviceDelivery={version:1,channelKey:'b'.repeat(64),clientAttemptId:input.receipt.attemptId};
  const reviewed=await store.review(namespace,id(input),input.receipt,{reviewed:true,confirmation:'d'.repeat(64),requestDigest:id(input),attemptId:'e'.repeat(64),serviceDelivery});
  assert.equal((await store.recover(namespace,id(input),reviewed,ref,'f'.repeat(64),serviceDelivery)).reconciled,false);
  const ready=await store.recover(namespace,id(input),reviewed,ref,'e'.repeat(64),serviceDelivery);assert.equal(ready.reconciled,true);assert.equal(ready.receipt.pastReviews.length,1);
  assert.deepEqual(await f.open(receiptWritableFixture()).get(namespace,id(input)),ready.receipt);
});
test('remembered service cache can replace a rejected attempt, but never settle an unrelated uncertain attempt',async t=>{
  for(const status of ['rejected','unknown']){const input=await receiptInput({status}),f=await fixture(t,[input]),store=f.open();const remembered=await store.remember(namespace,id(input),input.receipt.identity,ref);
    assert.equal(remembered.status,status==='rejected'?'ready':'unknown');assert.deepEqual(await f.open(receiptWritableFixture()).get(namespace,id(input)),remembered);
  }
});
test('first migration preserves a multi-record batch with one native head publication and constant full-census count',async t=>{
  const inputs=await Promise.all(Array.from({length:16},(_,i)=>receiptInput({information:i/16}))),f=await fixture(t,inputs),store=f.open();assert.equal((await store.list(namespace)).length,16);
  assert.equal(f.calls.filter(call=>call.path==='/api/files/upload'&&JSON.parse(call.request.body).name.endsWith('-vibe-receipt-catalogue.json')).length,1);
  assert.equal(f.local.state.transactions.length,4);assert.equal(f.local.state.writes.length,0);
});
