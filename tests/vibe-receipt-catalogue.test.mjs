import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createVibeReceiptCatalogue,VIBE_RECEIPT_CATALOGUE_SLOT as slot} from '../qianmu-vibe-receipt-catalogue.js';
import {captureVibeReceiptOriginal,createVibeReceiptOriginals} from '../qianmu-vibe-receipt-original.js';
import {vibeReceiptFollows,resolveVibeReceiptHeads} from '../qianmu-vibe-receipt-lineage.js';
import {createVibeReviewSegment} from '../qianmu-vibe-history.js';
import {characterNativeFixture,namespace} from './helpers/character-native-fixture.mjs';
import {receiptInput,receiptLegacyFixture} from './helpers/vibe-receipt-fixture.mjs';

async function fixture(t,inputs=[]){const f=await characterNativeFixture(t),local=receiptLegacyFixture(inputs),opened=[];
  const open=(source=local,options={})=>{const store=createVibeReceiptCatalogue({legacy:source.open(),createStorage:f.createStorage,...options});opened.push(store);return store;};
  t.after(()=>opened.forEach(c=>c.close()));
  const writeIndex=async value=>{const old=await f.storage.read(slot);return f.storage.write(slot,value,{expectedFingerprint:old.fingerprint});};
  return {...f,local,open,writeIndex,get uploads(){return f.uploads;},readIndex:async()=>(await f.storage.read(slot)).value};
}
const selected=input=>input.receipt.cacheKey;
const change=(input,status,extra={})=>{const next=structuredClone(input);next.receipt={...next.receipt,status,updatedAt:Math.max(2,input.receipt.updatedAt),...extra};return next;};
const ready=input=>change(input,'ready',{assetRef:{version:1,namespace,id:'e'.repeat(64)}});
async function publish(store,input){const state=await store.inspect(namespace,selected(input));return store.publish(namespace,input,state.heads);}

test('actual legacy census is adopted read-only and complete originals are readable on an empty-local client',async t=>{
  const a=await receiptInput({reviewCount:65,undefinedDelivery:true}),b=await receiptInput({section:'archived',status:'ready',information:.5}),f=await fixture(t,[a,b]),store=f.open();
  const before=structuredClone(f.local.state.tables),list=await store.list(namespace);assert.equal(list.length,2);
  const other=f.open(receiptLegacyFixture());assert.deepEqual(await other.get(namespace,selected(a)),a);assert.deepEqual(await other.get(namespace,selected(b)),b);
  assert.deepEqual(f.local.state.tables,before);assert.ok(f.local.state.transactions.every(tx=>tx.mode==='readonly'));
  const uploads=f.uploads;assert.deepEqual(await store.get(namespace,selected(a)),a);assert.equal(f.uploads,uploads);
  assert.ok(!f.calls.some(c=>/delete|plugins|encode-vibe|generate|completions/.test(c.path)));
});

test('empty native/local directories remain empty without fabricating receipts or publishing a new head',async t=>{
  const f=await fixture(t),store=f.open();assert.deepEqual(await store.list(namespace),[]);assert.equal(await store.get(namespace,'a'.repeat(64)),null);
  assert.equal(f.uploads,0);assert.equal((await store.inspect(namespace,'a'.repeat(64))).kind,'empty');
});

test('one exact attempt advances to late completion without erasing the earlier source and without local writes',async t=>{
  const input=await receiptInput({status:'submitting'}),f=await fixture(t,[input]),store=f.open();await store.list(namespace);
  const before=(await store.inspect(namespace,selected(input))).heads[0],next=ready(input);f.local.state.tables.receipts[0]=next.receipt;
  assert.deepEqual(await store.get(namespace,selected(input)),next);const inspected=await store.inspect(namespace,selected(input));assert.equal(inspected.versions.length,2);
  assert.deepEqual(await store.readVersion(namespace,selected(input),before),input);assert.equal(inspected.kind,'resolved');
  const stale=f.open(receiptLegacyFixture([input]));assert.deepEqual(await stale.get(namespace,selected(input)),next);
});

test('different attempts never merge by time, revision or cache equality; each complete source remains accessible',async t=>{
  const input=await receiptInput(),f=await fixture(t,[input]),store=f.open();await store.list(namespace);
  const other=ready(input);other.receipt.attemptId='other-device-attempt';other.receipt.updatedAt=9999;other.receipt.revision=2;
  const remote=f.open(receiptLegacyFixture([other]));await remote.list(namespace);await assert.rejects(store.get(namespace,selected(input)),/尚未核对/);
  const inspected=await store.inspect(namespace,selected(input));assert.equal(inspected.kind,'conflict');assert.equal(inspected.conflicts.length,2);
  for(const version of inspected.versions)assert.ok([input.receipt.attemptId,other.receipt.attemptId].includes((await store.readVersion(namespace,selected(input),version.digest)).receipt.attemptId));
  const writes=f.uploads;await assert.rejects(store.publish(namespace,other,inspected.heads),/分歧/);assert.equal(f.uploads,writes);
});

test('same attempt with a different channel, source, result, revision or review history stays disputed',async t=>{
  const original=await receiptInput({status:'ready',reviewCount:16});
  for(const edit of [i=>i.receipt.delivery.channelKey='9'.repeat(64),i=>i.receipt.sourceAssetRef.id='9'.repeat(64),i=>i.receipt.assetRef.id='9'.repeat(64),
    i=>i.receipt.revision++,i=>{delete i.receipt.reviewArchive;i.segments=[];}]){
    const changed=structuredClone(original);edit(changed);const entries=await Promise.all([original,changed].map(v=>captureVibeReceiptOriginal(v,namespace)));
    assert.equal((await resolveVibeReceiptHeads(entries)).kind,'conflict');
  }
});

test('explicit predecessor publishing supports reserved/submitting/ready/archive and stale source does not unarchive it',async t=>{
  const f=await fixture(t),store=f.open(),original=await receiptInput({status:'reserved'});await publish(store,original);
  const submitting=change(original,'submitting');await publish(store,submitting);const completed=ready(submitting);await publish(store,completed);
  const archived={...structuredClone(completed),section:'archived'};await publish(store,archived);assert.deepEqual(await store.get(namespace,selected(original)),archived);
  assert.equal((await store.list(namespace))[0].section,'archived');
  const stale=f.open(receiptLegacyFixture([original]));assert.deepEqual(await stale.get(namespace,selected(original)),archived);
  const info=await store.inspect(namespace,selected(original));assert.equal(info.heads.length,1);assert.equal(info.versions.length,4);
  await assert.rejects(publish(store,completed),/不能沿此前序/);
});

test('new attempt requires explicit reviewed/rejected predecessor and preserves the original fee review',async t=>{
  const input=await receiptInput({status:'unknown'}),f=await fixture(t,[input]),store=f.open();await store.list(namespace);
  const reviewed=change(input,'reviewed',{feeReview:{version:1,method:'local-user',previousStatus:'unknown',confirmation:'a'.repeat(64),at:2}});await publish(store,reviewed);
  const next=change(reviewed,'reserved',{attemptId:'retry-attempt-two',revision:2,updatedAt:3,pastReviews:[{attemptId:reviewed.receipt.attemptId,delivery:reviewed.receipt.delivery,feeReview:reviewed.receipt.feeReview}]});delete next.receipt.feeReview;
  assert.equal(await vibeReceiptFollows(reviewed,next),false);await publish(store,next);assert.deepEqual(await store.get(namespace,selected(input)),next);
  const oldClient=f.open(receiptLegacyFixture([input]));assert.deepEqual(await oldClient.get(namespace,selected(input)),next);
  const bad=change(next,'reserved',{attemptId:'third-attempt',revision:3});await assert.rejects(publish(store,bad),/不能沿此前序/);
});

test('stale predecessor lists, repeated attempt ids and dropped old reviews cannot advance the catalogue',async t=>{
  const input=await receiptInput({status:'rejected'}),f=await fixture(t,[input]),store=f.open(),state=await store.inspect(namespace,selected(input));
  const retry=change(input,'reserved',{attemptId:'fresh-attempt',revision:2});await store.publish(namespace,retry,state.heads);
  await assert.rejects(store.publish(namespace,change(retry,'submitting'),state.heads),/前序记录已变化/);
  const reviewed=await receiptInput({status:'reviewed'}),bad=change(reviewed,'reserved',{attemptId:'other-attempt',revision:2});delete bad.receipt.feeReview;
  assert.equal(await vibeReceiptFollows(reviewed,bad,{explicit:true}),false);
  assert.equal(await vibeReceiptFollows(input,change(input,'reserved'),{explicit:true}),false);
});

test('a stale variant of an explicitly reviewed ancestor does not resurrect or block the verified newer attempt',async t=>{
  const input=await receiptInput({status:'submitting'}),f=await fixture(t,[input]),store=f.open();await store.list(namespace);
  const reviewed=change(input,'reviewed',{updatedAt:5,feeReview:{version:1,method:'local-user',previousStatus:'unknown',confirmation:'a'.repeat(64),at:5}});await publish(store,reviewed);
  const next=change(reviewed,'reserved',{attemptId:'verified-retry',revision:2,updatedAt:6,pastReviews:[{attemptId:input.receipt.attemptId,delivery:input.receipt.delivery,feeReview:reviewed.receipt.feeReview}]});delete next.receipt.feeReview;
  await publish(store,next);
  const stale=change(input,'unknown',{updatedAt:3}),oldClient=f.open(receiptLegacyFixture([stale]));assert.deepEqual(await oldClient.get(namespace,selected(input)),next);
  const sending=change(next,'submitting',{updatedAt:7});await publish(store,sending);assert.deepEqual(await oldClient.get(namespace,selected(input)),sending);
  // A status written after the supposed review is not retroactively covered.
  const ambiguous=change(input,'unknown',{updatedAt:8}),ambiguousClient=f.open(receiptLegacyFixture([ambiguous]));await assert.rejects(ambiguousClient.get(namespace,selected(input)),/尚未核对/);
});

test('complete review-chain compaction preserves semantics and explicit chosen representation',async t=>{
  const input=await receiptInput({status:'unknown',reviewCount:16}),f=await fixture(t),store=f.open();
  input.receipt.pastReviews=structuredClone(input.segments[0].reviews);input.segments=[];delete input.receipt.reviewArchive;
  const local=f.open(receiptLegacyFixture([input]));await local.list(namespace);
  const compacted=structuredClone(input),segment=await createVibeReviewSegment(namespace,selected(input),null,input.receipt.pastReviews);
  compacted.segments=[segment];compacted.receipt.reviewArchive={version:1,id:segment.id,count:segment.count};delete compacted.receipt.pastReviews;
  await publish(store,compacted);assert.deepEqual(await local.get(namespace,selected(input)),compacted);
});

test('new attempts cannot reuse an older rejected attempt absent from inline fee-review history',async t=>{
  const input=await receiptInput({status:'rejected'}),f=await fixture(t,[input]),store=f.open();await store.list(namespace);
  const retry=change(input,'reserved',{attemptId:'second-retry',revision:2});await publish(store,retry);const rejected=change(retry,'rejected');await publish(store,rejected);
  const reused=change(rejected,'reserved',{attemptId:input.receipt.attemptId,revision:3});await assert.rejects(publish(store,reused),/复用/);
  const index=await f.readIndex(),entry=index.entries[0],originals=createVibeReceiptOriginals(f.storage),saved=await originals.preserve(reused),captured=await captureVibeReceiptOriginal(reused,namespace);
  entry.versions.push({digest:captured.digest,section:'current',reference:saved.reference,parents:[entry.versions.at(-1).digest]});index.revision++;await f.writeIndex(index);
  await assert.rejects(store.get(namespace,selected(input)),/复用/);
});

test('union overflow is rejected before uploading any new original and never trims either account source',async t=>{
  const input=await receiptInput(),f=await fixture(t,[input]),store=f.open();await store.list(namespace);const index=await f.readIndex(),entry=index.entries[0];
  index.entries=Array.from({length:2048},(_,i)=>({...structuredClone(entry),cacheKey:i.toString(16).padStart(64,'0')}));await f.writeIndex(index);
  const uploads=f.uploads;await assert.rejects(store.list(namespace),/合并费用目录超过原有上限/);assert.equal(f.uploads,uploads);assert.equal(f.local.state.tables.receipts.length,1);assert.equal((await f.readIndex()).entries.length,2048);
});

test('a completed service recovery must retain a prior reviewed fee rather than discard it',async t=>{
  const input=await receiptInput({status:'reviewed'});input.receipt.delivery={version:1,transport:'service',channelKey:'a'.repeat(64),serviceAttemptId:'b'.repeat(64)};delete input.receipt.feeReview.method;
  const completed=ready(input);completed.receipt.pastReviews=[{attemptId:input.receipt.attemptId,delivery:input.receipt.delivery,feeReview:input.receipt.feeReview}];delete completed.receipt.feeReview;
  assert.equal(await vibeReceiptFollows(input,completed),true);delete completed.receipt.pastReviews;assert.equal(await vibeReceiptFollows(input,completed),false);
});

test('review time cannot precede the uncertain source or exceed the purported reviewed receipt',async()=>{
  const input=await receiptInput(),reviewed=change(input,'reviewed',{updatedAt:3,feeReview:{version:1,method:'local-user',previousStatus:'unknown',confirmation:'a'.repeat(64),at:2}});
  assert.equal(await vibeReceiptFollows(input,reviewed),true);
  for(const at of [1,4]){reviewed.receipt.feeReview.at=at;assert.equal(await vibeReceiptFollows(input,reviewed),false);}
});

test('forged predecessor links cannot hide an unrelated uncertain request',async t=>{
  const input=await receiptInput(),f=await fixture(t,[input]),store=f.open();await store.list(namespace);const index=await f.readIndex(),entry=index.entries[0],unrelated=ready(input);unrelated.receipt.attemptId='unrelated-ready';
  const originals=createVibeReceiptOriginals(f.storage),saved=await originals.preserve(unrelated),captured=await captureVibeReceiptOriginal(unrelated,namespace);
  entry.versions.push({digest:captured.digest,section:'current',reference:saved.reference,parents:[entry.versions[0].digest]});index.revision++;await f.writeIndex(index);
  await assert.rejects(store.get(namespace,selected(input)),/状态衔接不符/);
});

test('invalid metadata, cycles, foreign slots, duplicate versions and section lies are rejected',async t=>{
  const input=await receiptInput();
  for(const edit of [i=>i.namespace='st-user:other',i=>i.entries.push(i.entries[0]),i=>i.entries[0].versions.push(i.entries[0].versions[0]),
    i=>i.entries[0].versions[0].parents=[i.entries[0].versions[0].digest],i=>i.entries[0].versions[0].reference.scope='f'.repeat(64),
    i=>i.entries[0].versions[0].reference.slot='vibe-stage-ended',i=>i.entries[0].section='archived']){
    const f=await fixture(t,[input]),store=f.open();await store.list(namespace);const index=await f.readIndex();edit(index);await f.writeIndex(index);await assert.rejects(store.get(namespace,selected(input)));
  }
});

test('old source changing during preservation fails without rewriting its state or authorizing a request',async t=>{
  const input=await receiptInput(),f=await fixture(t,[input]);let touched=false;
  const store=f.open(f.local,{onProgress(){if(touched)return;touched=true;f.local.state.tables.receipts[0].updatedAt=2;}});
  await assert.rejects(store.list(namespace),/旧页面修改/);assert.equal(f.local.state.tables.receipts[0].status,'unknown');
  assert.ok(![...f.files.keys()].some(name=>name.endsWith('-'+slot+'.json')));
});

test('missing known head or an original is an error, never an empty ledger fallback',async t=>{
  for(const kind of ['head','original']){const input=await receiptInput(),f=await fixture(t,[input]),store=f.open();await store.list(namespace);
    const name=[...f.files.keys()].find(name=>kind==='head'?name.endsWith('-'+slot+'.json'):name.includes('-vibe-receipt-part-'));f.files.delete(name);
    const uploads=f.uploads;await assert.rejects(store.get(namespace,selected(input)));assert.equal(f.uploads,uploads);
  }
});

test('wrong account, cancelled operation, failed guard and closed catalogue do not publish',async t=>{
  for(const kind of ['account','cancel','guard','closed']){const input=await receiptInput(),f=await fixture(t,[input]),store=f.open(),abort=new AbortController();let valid=true;
    if(kind==='account')f.account('st-user:other');if(kind==='cancel')abort.abort();if(kind==='guard')valid=false;if(kind==='closed')store.close();
    await assert.rejects(store.list(namespace,{signal:abort.signal,guard:()=>valid}));assert.equal(f.uploads,0);
  }
});

test('publish captures input, predecessor selection and options before its asynchronous validation',async t=>{
  const input=await receiptInput({status:'reserved'}),f=await fixture(t),store=f.open(),heads=[],options={guard:()=>true},before=structuredClone(input);
  const writing=store.publish(namespace,input,heads,options);input.receipt.status='unknown';heads.push('f'.repeat(64));options.guard=()=>false;
  await writing;assert.deepEqual(await store.get(namespace,selected(before)),before);
});

test('a remote head change during preservation is not overwritten or automatically merged',async t=>{
  const input=await receiptInput({status:'reserved'}),f=await fixture(t),store=f.open();await publish(store,input);const next=change(input,'submitting');let changed=false;
  f.hook(async call=>{if(changed||call.path!=='/api/files/upload')return;const {name}=JSON.parse(call.request.body);if(!name.includes('-vibe-receipt-part-'))return;changed=true;
    const index=await f.readIndex();index.revision++;await f.writeIndex(index);
  });await assert.rejects(publish(store,next));assert.equal((await f.readIndex()).entries[0].versions.length,1);
});

test('accepted catalogue with lost acknowledgement is not retried and a fresh client can inspect the saved evidence',async t=>{
  const input=await receiptInput({status:'reserved'}),f=await fixture(t),store=f.open();let headWrites=0;
  f.hook(call=>{if(call.path!=='/api/files/upload')return;const {name,data}=JSON.parse(call.request.body);if(!name.endsWith('-'+slot+'.json'))return;
    headWrites++;f.files.set(name,Buffer.from(data,'base64').toString());throw Error('accepted head; lost acknowledgement');});
  await assert.rejects(publish(store,input));assert.equal(headWrites,1);f.hook(null);assert.deepEqual(await f.open(receiptLegacyFixture()).get(namespace,selected(input)),input);
});

test('conflict inspection is order-independent and no timestamp-only winner is invented',async()=>{
  const original=await receiptInput({status:'reserved'}),submitting=change(original,'submitting'),completed=ready(submitting);
  const variants=await Promise.all([original,submitting,completed].map(v=>captureVibeReceiptOriginal(v,namespace)));
  for(const permutation of [variants,[variants[2],variants[0],variants[1]],variants.toReversed()])assert.equal((await resolveVibeReceiptHeads(permutation)).selected.snapshot.receipt.status,'ready');
  const other=structuredClone(completed);other.receipt.attemptId='unrelated-newest';other.receipt.updatedAt=9999;
  assert.equal((await resolveVibeReceiptHeads([...variants,await captureVibeReceiptOriginal(other,namespace)])).kind,'conflict');
});

test('release includes the catalogue but existing paid reservation and original-account result sink are not silently replaced',async()=>{
  const release=JSON.parse(await readFile(new URL('../release-files.json',import.meta.url),'utf8'));
  for(const file of ['qianmu-vibe-receipt-catalogue.js','qianmu-vibe-receipt-lineage.js'])assert.ok(release.files.includes(file));
  const source=await readFile(new URL('../qianmu-vibe-receipt-catalogue.js',import.meta.url),'utf8');assert.doesNotMatch(source,/legacy\.(?:reserve|transition|review|recover)|fetch\(|encodeNovelVibe\(/);
  for(const file of ['qianmu-vibe-encoding-retention.js','qianmu-vibe-assets-worker.js'])assert.doesNotMatch(await readFile(new URL('../'+file,import.meta.url),'utf8'),/qianmu-vibe-receipt-catalogue/);
});
