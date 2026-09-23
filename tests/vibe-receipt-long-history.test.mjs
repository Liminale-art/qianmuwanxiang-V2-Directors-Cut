import test from 'node:test';
import assert from 'node:assert/strict';
import {createVibeReceiptCatalogue,VIBE_RECEIPT_CATALOGUE_SLOT as slot} from '../qianmu-vibe-receipt-catalogue.js';
import {createVibeReceiptOriginals,captureVibeReceiptOriginal} from '../qianmu-vibe-receipt-original.js';
import {resolveVibeReceiptLineage} from '../qianmu-vibe-receipt-lineage.js';
import {characterNativeFixture,namespace} from './helpers/character-native-fixture.mjs';
import {receiptInput,receiptLegacyFixture} from './helpers/vibe-receipt-fixture.mjs';

async function chainFixture(t,{count=32,reviews=256,local=false}={}){
  const f=await characterNativeFixture(t),base=await receiptInput({status:'reserved',reviewCount:reviews}),originals=createVibeReceiptOriginals(f.storage),versions=[],snapshots=[];
  for(let i=0;i<count;i++){
    const snapshot=structuredClone(base);Object.assign(snapshot.receipt,{attemptId:`history-attempt-${Math.floor(i/3)}`,status:['reserved','submitting','rejected'][i%3],revision:Math.floor(i/3)+1,updatedAt:i+2});
    const {digest}=await captureVibeReceiptOriginal(snapshot,namespace),{reference}=await originals.preserve(snapshot);
    versions.push({digest,section:'current',reference,parents:i?[versions[i-1].digest]:[]});snapshots.push(snapshot);
  }
  const value={schema:'qianmu.vibe.receipt-catalogue.v1',namespace,revision:count,entries:[{cacheKey:base.receipt.cacheKey,section:'current',versions}]};
  const old=await f.storage.read(slot);await f.storage.write(slot,value,{expectedFingerprint:old.fingerprint});
  const legacy=receiptLegacyFixture(local?[snapshots.at(-1)]:[]),catalogue=createVibeReceiptCatalogue({legacy:legacy.open(),createStorage:f.createStorage});t.after(()=>catalogue.close());
  const fileGets=4+versions.reduce((n,{reference})=>n+1+JSON.parse(f.files.get(`qianmu-v2-${reference.scope}-${reference.slot}-${reference.fingerprint}.json`)).value.parts.length,0);
  return Object.assign(f,{catalogue,legacy,versions,snapshots,key:base.receipt.cacheKey,value,fileGets});
}
function countReviewDigests(t){
  const digest=crypto.subtle.digest.bind(crypto.subtle);let count=0;
  t.mock.method(crypto.subtle,'digest',function(algorithm,data){
    const text=Buffer.from(data.buffer||data,data.byteOffset||0,data.byteLength).toString();
    if(text.startsWith('{"cacheKey":')&&text.includes('"previous":')&&text.includes('"reviews":'))count++;
    return digest(algorithm,data);
  });return {count:()=>count,reset:()=>count=0};
}

test('long native history keeps every file check while measuring repeated review-segment validation',async t=>{
  const f=await chainFixture(t),counter=countReviewDigests(t);f.reset();const started=performance.now();
  assert.deepEqual(await f.catalogue.get(namespace,f.key),f.snapshots.at(-1));const elapsed=performance.now()-started;
  assert.equal(f.calls.length,f.fileGets);assert.equal(f.uploads,0);
  assert.equal(counter.count(),3*f.versions.length*8);
  t.diagnostic(JSON.stringify({versions:f.versions.length,reviewsPerVersion:256,reviewDigestChecks:counter.count(),fileGets:f.calls.length,elapsedMs:Math.round(elapsed),scope:'isolated HTTP/IDB, not VPS timing'}));
});

test('128-version history is checked afresh on each operation, including local five-table evidence and all original files',async t=>{
  const f=await chainFixture(t,{count:128,reviews:512,local:true}),counter=countReviewDigests(t);
  for(let pass=0;pass<2;pass++){
    counter.reset();f.reset();f.legacy.state.transactions.length=0;const start=performance.now();
    assert.deepEqual(await f.catalogue.get(namespace,f.key),f.snapshots.at(-1));
    assert.equal(counter.count(),(3*128+3)*16);assert.equal(f.calls.length,f.fileGets);assert.equal(f.uploads,0);
    assert.equal(f.legacy.state.transactions.length,2);assert.ok(f.legacy.state.transactions.every(tx=>tx.mode==='readonly'&&tx.names.length===5));
    t.diagnostic(JSON.stringify({pass,versions:128,reviewsPerVersion:512,reviewDigestChecks:counter.count(),fileGets:f.calls.length,elapsedMs:Math.round(performance.now()-start),scope:'synthetic only'}));
  }
});

test('prepared lineage is operation-local: changing an earlier complete history between calls is not concealed',async t=>{
  const a=await receiptInput({status:'reserved',reviewCount:32}),b=structuredClone(a);b.receipt.status='submitting';b.receipt.updatedAt=2;
  const versions=await Promise.all([a,b].map(async(snapshot,i)=>({snapshot,digest:(await captureVibeReceiptOriginal(snapshot,namespace)).digest,parents:[]})));versions[1].parents=[versions[0].digest];
  const counter=countReviewDigests(t);assert.equal((await resolveVibeReceiptLineage(versions)).selected.digest,versions[1].digest);assert.equal(counter.count(),2);
  a.segments[0].reviews[0].feeReview.at=99;await assert.rejects(resolveVibeReceiptLineage(versions),/摘要不符/);
});

test('complete branch comparisons share preparation without hiding an unrelated newer ready attempt',async t=>{
  const base=await receiptInput({status:'reserved',reviewCount:32}),rows=[base,structuredClone(base),structuredClone(base)];
  rows[1].receipt.status='submitting';rows[1].receipt.updatedAt=2;
  rows[2].receipt.status='ready';rows[2].receipt.assetRef={version:1,namespace,id:'a'.repeat(64)};rows[2].receipt.updatedAt=3;
  const versions=await Promise.all(rows.map(async(snapshot)=>({snapshot,digest:(await captureVibeReceiptOriginal(snapshot,namespace)).digest,parents:[]})));versions[1].parents=[versions[0].digest];
  const counter=countReviewDigests(t);assert.equal((await resolveVibeReceiptLineage(versions)).selected.digest,versions[2].digest);assert.equal(counter.count(),3);
  const alien=structuredClone(rows[2]);alien.receipt.attemptId='unrelated-ready-attempt';alien.receipt.updatedAt=9999;
  const entry={snapshot:alien,digest:(await captureVibeReceiptOriginal(alien,namespace)).digest,parents:[]};counter.reset();
  const result=await resolveVibeReceiptLineage([...versions,entry]);assert.equal(result.kind,'conflict');assert.equal(result.conflicts.length,3);assert.equal(counter.count(),4);
});

test('a single head cannot bypass forged old edges or repeated historical attempt IDs',async t=>{
  for(const kind of ['edge','attempt']){
    const f=await chainFixture(t,{count:9,reviews:0}),bad=structuredClone(f.snapshots.at(-1));bad.receipt.updatedAt=20;
    if(kind==='edge'){bad.receipt.status='ready';bad.receipt.assetRef={version:1,namespace,id:'c'.repeat(64)};bad.receipt.attemptId='forged-ready-attempt';}
    else{bad.receipt.status='reserved';bad.receipt.attemptId=f.snapshots[0].receipt.attemptId;bad.receipt.revision++;}
    const captured=await captureVibeReceiptOriginal(bad,namespace),saved=await createVibeReceiptOriginals(f.storage).preserve(bad),index=structuredClone(f.value);
    index.entries[0].versions.push({digest:captured.digest,reference:saved.reference,section:'current',parents:[f.versions.at(-1).digest]});index.revision++;
    const old=await f.storage.read(slot);await f.storage.write(slot,index,{expectedFingerprint:old.fingerprint});f.reset();
    await assert.rejects(f.catalogue.get(namespace,f.key),kind==='edge'?/状态衔接不符/:/复用/);assert.equal(f.uploads,0);
  }
});

test('removing an old original after a successful long-chain read cannot be hidden by prepared comparisons',async t=>{
  const f=await chainFixture(t,{count:12,reviews:32});await f.catalogue.get(namespace,f.key);const reference=f.versions[2].reference;
  f.files.delete(`qianmu-v2-${reference.scope}-${reference.slot}-${reference.fingerprint}.json`);f.reset();await assert.rejects(f.catalogue.get(namespace,f.key));assert.equal(f.uploads,0);
});

test('missing, cyclic, repeated or forward predecessors never enter the branch fast path',async()=>{
  const input=await receiptInput(),a={snapshot:input,digest:'a'.repeat(64),parents:[]},b={snapshot:input,digest:'b'.repeat(64),parents:[a.digest]};
  for(const versions of [[a,a],[{...a,parents:[a.digest]}],[{...a,parents:[b.digest]},b],[a,{...b,parents:[a.digest,a.digest]}],[a,{...b,parents:['f'.repeat(64)]}]])await assert.rejects(resolveVibeReceiptLineage(versions),/前后依据不完整/);
});

test('guard revocation during comparison prevents output and does not populate a later call cache',async t=>{
  const input=await receiptInput({reviewCount:32}),row={snapshot:input,digest:(await captureVibeReceiptOriginal(input,namespace)).digest,parents:[]},counter=countReviewDigests(t);let calls=0;
  await assert.rejects(resolveVibeReceiptLineage([row],{guard:()=>++calls<2}),/核对已取消/);assert.equal(counter.count(),1);
  assert.equal((await resolveVibeReceiptLineage([row])).kind,'resolved');assert.equal(counter.count(),2);
});

test('local census remains linear and complete at 1, 32 and 128 rows; no persistent cache skips old-writer changes',async t=>{
  const counter=countReviewDigests(t);
  for(const count of [1,32,128]){
    const inputs=await Promise.all(Array.from({length:count},(_,i)=>receiptInput({information:i/count,reviewCount:32}))),local=receiptLegacyFixture(inputs),store=local.open();t.after(()=>store.close());counter.reset();
    const start=performance.now(),census=await store.census(namespace);assert.equal(census.current.length,count);assert.equal(counter.count(),count);assert.equal(local.state.transactions.length,1);
    t.diagnostic(JSON.stringify({localRows:count,reviewDigestChecks:counter.count(),elapsedMs:Math.round(performance.now()-start),scope:'readonly IDB protocol double, not browser timing'}));
    local.state.tables.reviewUsage[0].bytes++;await assert.rejects(store.census(namespace),/计值与完整记录不符/);
  }
});
