import test from 'node:test';
import assert from 'node:assert/strict';
import {collectionIndexFixture,record,entry} from './helpers/collection-index-fixture.mjs';
import {COLLECTION_READ_MEMO_LIMITS as limits,createCollectionReadMemo} from '../qianmu-text-collection-read-memo.js';

test('confirmed edits retain untouched original/source caches across panels, but changed descriptors must be read',async t=>{
  const f=await collectionIndexFixture(t,[record(1),record(2),record(3)]),a=await f.open(),b=await f.open();
  await a.sources();await a.list({cursor:null,limit:50,search:'原文'});
  await b.prepareEdit(record(1).id,1,'新的内容').submit();f.reset();
  assert.equal((await a.get(record(2).id)).record.text,record(2).text);
  assert.equal((await a.get(record(3).id)).record.text,record(3).text);assert.equal(f.calls.length,0);
  const sources=await a.sources({revalidate:true});
  assert.equal(sources.items.find(row=>row.id===record(1).id).revision,2);
  assert.equal(f.bodyReads,1,'only the changed original is reloaded, not all floor sources');
  f.reset();assert.equal((await a.list({cursor:null,limit:50,search:'原文'})).total,2);
  assert.equal((await a.list({cursor:null,limit:50,search:'新的内容'})).total,1);assert.equal(f.calls.length,0,'old match positions were not reused after the edit');
});

test('confirmed deletion keeps surviving details and floor stars warm, without fetching every surviving original',async t=>{
  const f=await collectionIndexFixture(t,[record(1),record(2),record(3)]),a=await f.open(),b=await f.open();await a.sources();
  await b.prepareDelete(record(1).id,1).submit();f.reset();
  assert.equal((await a.get(record(1).id)).record,null);
  assert.equal((await a.get(record(2).id)).record.text,record(2).text);
  assert.deepEqual((await a.sources()).items.map(row=>row.id),[record(2).id,record(3).id]);
  assert.equal(f.calls.length,0);assert.equal(f.uploads,0);
  a.close();b.close();const reopened=await f.open();
  assert.equal((await reopened.get(record(3).id,{preferCache:true})).record.text,record(3).text);assert.equal(f.calls.length,0);
});

test('independent queued deletions keep the final shared directory and untouched original warm',async t=>{
  const f=await collectionIndexFixture(t,[record(1),record(2),record(3)]),a=await f.open(),b=await f.open();await a.sources();
  await Promise.all([a.prepareDelete(record(1).id,1).submit(),b.prepareDelete(record(2).id,1).submit()]);f.reset();
  assert.equal((await a.get(record(1).id)).record,null);assert.equal((await b.get(record(2).id)).record,null);
  assert.equal((await a.get(record(3).id)).record.text,record(3).text);
  assert.deepEqual((await b.sources()).items.map(row=>row.id),[record(3).id]);assert.equal(f.calls.length,0);
});

test('an original response arriving after its deletion cannot refill the shared memo with the old entry',async t=>{
  const f=await collectionIndexFixture(t,[record(1),record(2),record(3)]),a=await f.open(),b=await f.open();
  await a.list();await a.get(record(2).id);await a.get(record(3).id);
  let release,entered;const gate=new Promise(resolve=>{release=resolve;}),started=new Promise(resolve=>{entered=resolve;});let held=false;
  f.hook(async({path})=>{if(!held&&path.includes(f.descriptors[0].original.fingerprint)){held=true;entered();await gate;}});
  const pending=assert.rejects(a.get(record(1).id),{code:'text_collection_sync_changed'});await started;
  await b.prepareDelete(record(1).id,1).submit();release();await pending;f.hook(null);f.reset();
  assert.equal((await a.get(record(1).id)).record,null);assert.equal((await a.get(record(2).id)).record.text,record(2).text);
  assert.deepEqual((await a.sources()).items.map(row=>row.id),[record(2).id,record(3).id]);assert.equal(f.calls.length,0);
});

test('creating a new collection does not re-download existing complete originals to rebuild floor stars',async t=>{
  const f=await collectionIndexFixture(t,[record(1),record(2)]),s=await f.open();await s.sources();
  await s.prepareCreate(record(3)).submit();f.reset();
  assert.equal((await s.sources()).items.length,3);assert.equal(f.bodyReads,1);
  f.reset();assert.equal((await s.get(record(1).id)).record.text,record(1).text);assert.equal(f.calls.length,0);
});

test('a changed remote descriptor evicts only that exact original, including same-revision metadata changes',async t=>{
  const f=await collectionIndexFixture(t,[record(1),record(2)]),s=await f.open();await s.sources();
  const descriptor=await f.originals.preserve(entry(record(1,'同版本的新内容'))),index=await f.readIndex();index.value.entries[0]=descriptor;await f.writeIndex(index.value);
  await s.list(undefined,{revalidate:true});f.reset();
  assert.equal((await s.get(record(2).id)).record.text,record(2).text);assert.equal(f.calls.length,0);
  assert.equal((await s.get(record(1).id)).record.text,'同版本的新内容');assert.equal(f.bodyReads,1);
  const corrupted=await f.readIndex();corrupted.value.entries[0].summary.charName='伪造';await f.writeIndex(corrupted.value);
  await s.list(undefined,{revalidate:true});f.reset();await assert.rejects(s.get(record(1).id),{code:'text_collection_sync_original'});
  assert.equal(f.bodyReads,1,'body hash alone cannot authorize a different descriptor');
});

test('failed or unknown writes still invalidate browsing originals rather than treating the intended mutation as confirmed',async t=>{
  for(const failure of ['stale','lost-receipt']){
    const f=await collectionIndexFixture(t,[record(1),record(2)]),s=await f.open();await s.sources();
    if(failure==='lost-receipt')f.loseIndexAck();
    const op=s.prepareEdit(record(1).id,failure==='stale'?2:1,'只有确认后才采用');
    await assert.rejects(op.submit());f.reset();
    assert.equal((await s.get(record(2).id)).record.text,record(2).text);assert.equal(f.bodyReads,1,'failure clears every old original memo');
    assert.equal((await s.get(record(1).id)).record.text,failure==='stale'?record(1).text:'只有确认后才采用');
  }
});

test('minute-later reopening reuses bounded immutable text; explicit refresh and lifetime expiry still read it anew',async t=>{
  let clock=100000;t.mock.method(Date,'now',()=>clock);
  const f=await collectionIndexFixture(t),s=await f.open();await s.get(record(1).id);s.close();clock+=60000;
  const reopened=await f.open();f.reset();assert.equal((await reopened.get(record(1).id,{preferCache:true})).record.text,record(1).text);assert.equal(f.calls.length,0);
  await reopened.get(record(1).id,{forceRefresh:true});assert.equal(f.bodyReads,1);f.reset();clock+=limits.ttlMs;
  await reopened.get(record(1).id,{preferCache:true});assert.equal(f.bodyReads,1);assert.equal(limits.originals,16);assert.equal(limits.bytes,2*1024*1024);
});

test('retention prunes deleted/changed exact descriptors and byte accounting, and drops old search positions',()=>{
  const memo=createCollectionReadMemo(),a={id:'one',revision:1},b={id:'two',revision:1};
  memo.rememberOriginal(a,{id:'one',text:'first'});memo.rememberOriginal(b,{id:'two',text:'second'});
  const state={entries:[a,b]};memo.rememberSearch(state,'term',[0,1]);memo.clearSearch();assert.equal(memo.getSearch(state,'term'),null);
  memo.retainOriginals([a,{...b,revision:2}]);assert.equal(memo.getOriginal(b),null);assert.equal(memo.getOriginal(a).text,'first');
  memo.retainOriginals([{...a,deleted:true}]);assert.equal(memo.getOriginal(a),null);
});
