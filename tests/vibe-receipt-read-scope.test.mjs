import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createVibeReceiptCatalogue,VIBE_RECEIPT_CATALOGUE_SLOT as slot} from '../qianmu-vibe-receipt-catalogue.js';
import {createNativeVibeEncodingStore} from '../qianmu-vibe-native-encoding-store.js';
import {characterNativeFixture,namespace} from './helpers/character-native-fixture.mjs';
import {receiptInput,receiptLegacyFixture} from './helpers/vibe-receipt-fixture.mjs';
import {receiptWritableFixture} from './helpers/vibe-receipt-writable-fixture.mjs';

const key=row=>row.receipt.cacheKey;
async function fixture(t,rows=[]){
  const f=await characterNativeFixture(t),local=receiptLegacyFixture(rows),opened=[];
  const open=(source=local,options={})=>{const store=createVibeReceiptCatalogue({legacy:source.open(),createStorage:f.createStorage,...options});opened.push(store);return store;};
  t.after(()=>opened.forEach(store=>store.close()));
  return Object.assign(f,{local,open,readIndex:async()=>(await f.storage.read(slot)).value});
}
const originals=f=>f.calls.filter(call=>call.path.includes('-vibe-receipt-original-')||call.path.includes('-vibe-receipt-part-'));
async function storedVersion(f,id,index=-1){const entry=(await f.readIndex()).entries.find(row=>row.cacheKey===id),version=entry.versions.at(index),manifest=(await f.storage.readImmutable(version.reference)).value;return {version,manifest};}
function removePart(f,manifest){const ref=manifest.parts[0],name=`qianmu-v2-${ref.scope}-${ref.slot}-${ref.fingerprint}.json`;
  assert.ok(f.files.has(name),'selected part exists');f.files.delete(name);
}

test('ordinary native single lookup remains six HTTP reads for 1, 32 and 128 unrelated receipts',async t=>{
  for(const count of [1,32,128]){const rows=await Promise.all(Array.from({length:count},(_,i)=>receiptInput({information:i/count}))),f=await fixture(t),local=receiptWritableFixture(rows),store=createNativeVibeEncodingStore({legacy:local.open(),createStorage:f.createStorage});t.after(()=>store.close());
    await store.get(namespace,key(rows[0]));f.reset();assert.deepEqual(await store.get(namespace,key(rows[0])),rows[0].receipt);
    assert.equal(f.calls.length,6);assert.equal(originals(f).length,2);assert.equal(f.uploads,0);assert.equal(local.state.writes.length,0);
  }
});
test('checkout, inspect and exact-version reads do not download unrelated existing originals',async t=>{
  const rows=await Promise.all([0,.5,1].map(information=>receiptInput({information}))),f=await fixture(t,rows),store=f.open();await store.readAll(namespace);
  const info=await storedVersion(f,key(rows[1]));
  for(const read of [()=>store.checkout(namespace,key(rows[1])),()=>store.inspect(namespace,key(rows[1])),()=>store.readVersion(namespace,key(rows[1]),info.version.digest)]){
    f.reset();await read();assert.equal(originals(f).length,2);assert.equal(f.uploads,0);
  }
});
test('full audit still reads every original exactly once and errors on missing unrelated evidence',async t=>{
  const rows=await Promise.all([0,.5,1].map(information=>receiptInput({information}))),f=await fixture(t,rows),store=f.open();await store.readAll(namespace);f.reset();
  assert.equal((await store.readAll(namespace)).rows.length,3);assert.equal(originals(f).length,6);
  const {manifest}=await storedVersion(f,key(rows[2]));removePart(f,manifest);f.reset();
  assert.deepEqual(await store.get(namespace,key(rows[0])),rows[0]);assert.equal(originals(f).length,2);
  await assert.rejects(store.readAll(namespace));await assert.rejects(store.list(namespace));await assert.rejects(store.get(namespace,key(rows[2])));
});
test('a selected receipt is reread on every operation: no persistent cache conceals deletion or corruption',async t=>{
  for(const kind of ['delete','corrupt']){const row=await receiptInput(),f=await fixture(t,[row]),store=f.open();await store.get(namespace,key(row));const {manifest}=await storedVersion(f,key(row));
    if(kind==='delete')removePart(f,manifest);else{const name=[...f.files.keys()].find(name=>name.includes('-vibe-receipt-part-'));f.files.set(name,'{}');}
    const uploads=f.uploads;await assert.rejects(store.get(namespace,key(row)));assert.equal(f.uploads,uploads);
  }
});
test('single lookup verifies every historical predecessor, not just the newest ready head',async t=>{
  const row=await receiptInput({status:'reserved'}),f=await fixture(t,[row]),store=f.open();await store.get(namespace,key(row));let current=structuredClone(row);
  for(const status of ['submitting','ready']){current={...current,receipt:{...current.receipt,status,updatedAt:2,...(status==='ready'?{assetRef:{version:1,namespace,id:'d'.repeat(64)}}:{})}};await store.publish(namespace,current,(await store.inspect(namespace,key(row))).heads);}
  f.reset();assert.equal((await store.get(namespace,key(row))).receipt.status,'ready');assert.equal(originals(f).length,6);
  const {manifest}=await storedVersion(f,key(row),0);removePart(f,manifest);await assert.rejects(store.get(namespace,key(row)));
});
test('first single lookup still preserves ALL newly discovered legacy rows and complete segmented history',async t=>{
  const rows=await Promise.all([0,.5,1].map(information=>receiptInput({information,reviewCount:40}))),f=await fixture(t,rows),store=f.open();await store.get(namespace,key(rows[0]));
  assert.equal((await f.readIndex()).entries.length,3);const fresh=f.open(receiptLegacyFixture());
  for(const row of rows)assert.deepEqual(await fresh.get(namespace,key(row)),row);
  assert.ok(f.local.state.transactions.every(tx=>tx.mode==='readonly'));
});
test('local ready change on an unrelated receipt is not skipped by the targeted lookup',async t=>{
  const a=await receiptInput(),b=await receiptInput({information:.5,status:'submitting'}),f=await fixture(t,[a,b]),store=f.open();await store.get(namespace,key(a));
  const ready={...b.receipt,status:'ready',updatedAt:3,assetRef:{version:1,namespace,id:'c'.repeat(64)}};f.local.state.tables.receipts[1]=ready;
  await store.get(namespace,key(a));assert.deepEqual((await f.open(receiptLegacyFixture()).get(namespace,key(b))).receipt,ready);
});
test('full local census remains live for unrelated edits while a selected original is being read',async t=>{
  const a=await receiptInput(),b=await receiptInput({information:.5}),f=await fixture(t,[a,b]),store=f.open();await store.get(namespace,key(a));let changed=false;
  f.hook(call=>{if(!changed&&call.path.includes('-vibe-receipt-part-')){changed=true;f.local.state.tables.receipts[1].updatedAt=3;}});
  await assert.rejects(store.get(namespace,key(a)),/旧页面修改/);
});
test('source reuse distinguishes negative zero and explicit undefined from omitted properties',async t=>{
  for(const edit of [row=>row.createdAt=-0,row=>row.pastReviews[0].delivery=undefined]){
    const row=await receiptInput({reviewCount:1});row.receipt.pastReviews=row.segments[0].reviews;delete row.receipt.reviewArchive;row.segments=[];
    const f=await fixture(t,[row]),store=f.open();await store.get(namespace,key(row));let changed=false;
    f.hook(call=>{if(!changed&&call.path.includes('-vibe-receipt-part-')){changed=true;edit(f.local.state.tables.receipts[0]);}});
    await assert.rejects(store.get(namespace,key(row)),/旧页面修改/);
  }
});
test('source reuse never bypasses fresh usage counter or review segment integrity checks',async t=>{
  for(const edit of [tables=>tables.reviewUsage[0].bytes++,tables=>tables.reviewSegments[0].reviews[0].attemptId='tampered-attempt']){
    const row=await receiptInput({reviewCount:2}),f=await fixture(t,[row]),store=f.open();await store.get(namespace,key(row));let changed=false;
    f.hook(call=>{if(!changed&&call.path.includes('-vibe-receipt-part-')){changed=true;edit(f.local.state.tables);}});await assert.rejects(store.get(namespace,key(row)));
  }
});
test('native head changes, lost head and account switches still stop targeted reads',async t=>{
  for(const mode of ['changed','missing','account']){const row=await receiptInput(),f=await fixture(t,[row]),store=f.open();await store.get(namespace,key(row));let changed=false;
    f.hook(async call=>{if(changed||!call.path.includes('-vibe-receipt-part-'))return;changed=true;
      if(mode==='account')f.account('st-user:other');else if(mode==='missing'){const name=[...f.files.keys()].find(name=>name.endsWith('-'+slot+'.json'));f.files.delete(name);}
      else{const old=await f.storage.read(slot),next=structuredClone(old.value);next.revision++;await f.storage.write(slot,next,{expectedFingerprint:old.fingerprint});}
    });await assert.rejects(store.get(namespace,key(row)));
  }
});
test('empty native inventory does not invent an on-disk metadata record or trigger a write',async t=>{
  const f=await fixture(t),store=f.open();assert.deepEqual(await store.readAll(namespace),{rows:[],metadata:{count:0,bytes:0}});assert.equal(f.uploads,0);assert.equal(f.files.size,0);
});
test('decoded historical working set is explicitly cleared between receipts and is operation-local',async()=>{
  const source=await readFile(new URL('../qianmu-vibe-receipt-catalogue.js',import.meta.url),'utf8');
  assert.match(source,/function cacheFor\(entry\)\{if\(loadedKey!==entry\.cacheKey\)\{snapshots\.clear\(\)/);
  assert.ok(source.indexOf('const snapshots=new Map()')>source.indexOf('const task=queue'));
  assert.ok(source.indexOf('const capturedSources=new Map()')>source.indexOf('const task=queue'));
  const resolver=source.slice(source.indexOf('async function resolve(entry)'),source.indexOf('const sectionOf='));
  assert.doesNotMatch(resolver,/entry\.versions\.find/);
  assert.match(source,/queue=task\.then\(\(\)=>\{\},\(\)=>\{\}\)/);
});
