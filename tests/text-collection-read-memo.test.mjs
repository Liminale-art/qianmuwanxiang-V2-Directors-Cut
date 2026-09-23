import test from 'node:test';
import assert from 'node:assert/strict';
import {createCollectionReadMemo,COLLECTION_READ_MEMO_LIMITS as limits} from '../qianmu-text-collection-read-memo.js';
import {collectionIndexFixture,record,entry} from './helpers/collection-index-fixture.mjs';

const search=(term,cursor=null,limit=5)=>({cursor,limit,search:term});
test('actual native detail repeat and panel reopen reuse one exact frozen original without a file request',async t=>{
  const f=await collectionIndexFixture(t),first=await f.open();await first.list();f.reset();
  const a=await first.get(record(1).id),b=await first.get(record(1).id);assert.deepEqual(a,b);assert.equal(f.bodyReads,1,'baseline was 2 original GETs');
  assert.throws(()=>{b.record.text='不可污染缓存';},TypeError);assert.throws(()=>{b.record.source.charName='错误姓名';},TypeError);
  first.close();const next=await f.open();f.reset();assert.deepEqual((await next.get(record(1).id,{preferCache:true})).record,record(1));assert.equal(f.calls.length,0);
});

test('complete search paginates and repeats from compact match positions rather than downloading every body again',async t=>{
  const records=Array.from({length:20},(_,i)=>record(i+1,'预览'.repeat(150)+'尾部Keyword')),f=await collectionIndexFixture(t,records),s=await f.open();
  const first=await s.list(search('尾部keyword'));assert.equal(first.total,20);assert.equal(f.bodyReads,20);f.reset();
  const second=await s.list(search('尾部keyword',first.nextCursor));assert.equal(second.items.length,5);assert.equal(f.calls.length,0,'baseline next page downloaded all 20 originals again');
  assert.equal((await s.list(search('尾部KEYWORD'))).total,20);assert.equal(f.calls.length,0);assert.equal(f.uploads,0);
});

test('narrower terms inspect only the complete shorter-term matches, including matches after the preview',async t=>{
  const records=Array.from({length:22},(_,i)=>record(i+1,'前'.repeat(180)+(i===0?'回忆冬日':i===1?'回忆夏日':'没有关键词'))),f=await collectionIndexFixture(t,records),s=await f.open();
  assert.equal((await s.list(search('回忆'))).total,2);assert.equal(f.bodyReads,22);f.reset();
  const narrowed=await s.list(search('回忆冬日'));assert.equal(narrowed.total,1);assert.equal(narrowed.items[0].id,record(1).id);assert.equal(f.bodyReads,2,'the two evicted matching originals, not the 20 proven negatives');
  f.reset();assert.equal((await s.list(search('回忆冬日不存在'))).total,0);assert.equal(f.bodyReads,0);assert.equal((await s.list(search('回忆冬日不存在更多'))).total,0);assert.equal(f.bodyReads,0);
});

test('a shorter or unrelated new term does not inherit earlier negative matches',async t=>{
  const f=await collectionIndexFixture(t,[record(1,'冬日完整片段'),record(2,'其他')]),s=await f.open();
  assert.equal((await s.list(search('冬日不存在'))).total,0);assert.equal((await s.list(search('冬日'))).total,1);
  assert.equal((await s.list(search('其他'))).items[0].id,record(2).id);assert.equal((await s.list(search('CHAR'))).total,2);
});

test('explicit refresh bypasses exact original and match memos; missing data is not concealed',async t=>{
  const f=await collectionIndexFixture(t),s=await f.open();await s.get(record(1).id);await s.list(search('原文'));
  const ref=f.descriptors[0].original;f.files.delete(`qianmu-v2-${ref.scope}-${ref.slot}-${ref.fingerprint}.json`);f.reset();
  await assert.rejects(s.get(record(1).id,{forceRefresh:true}),{code:'st_account_storage_missing'});assert.equal(f.bodyReads,1);
  await assert.rejects(s.list(search('原文')),{code:'st_account_storage_missing'});assert.equal(f.bodyReads,2);
});

test('backup always reads all originals afresh, even after their full text and search results were memoized',async t=>{
  const f=await collectionIndexFixture(t,[record(1),record(2)]),s=await f.open();await s.list(search('原文'));f.reset();
  assert.deepEqual((await s.snapshot()).backup.records,f.records);assert.equal(f.bodyReads,2);
});

test('server authentication rejection revokes other warm detail readers in the same account scope',async t=>{
  const f=await collectionIndexFixture(t,[record(1),record(2)]),a=await f.open(),b=await f.open();await a.get(record(1).id);await b.list();
  f.hook(({path})=>path.includes('-collection-record-')?new Response('{}',{status:401}):null);
  await assert.rejects(a.get(record(2).id),{code:'st_account_storage_account'});f.hook(null);f.reset();
  await assert.rejects(b.get(record(1).id,{preferCache:true}),{code:'text_collection_sync_account'});assert.equal(f.calls.length,0);
});

test('local edit and deletion invalidate detail and complete-match reuse across panels',async t=>{
  const f=await collectionIndexFixture(t),a=await f.open(),b=await f.open();await a.get(record(1).id);assert.equal((await a.list(search('原文'))).total,1);
  await b.prepareEdit(record(1).id,1,'已经修改').submit();f.reset();assert.equal((await a.get(record(1).id)).record.text,'已经修改');assert.equal(f.bodyReads,1);
  assert.equal((await a.list(search('原文'))).total,0);await b.prepareDelete(record(1).id,2).submit();assert.equal((await a.get(record(1).id)).record,null);assert.equal((await a.list(search('已经修改'))).total,0);
});

test('same revision but changed exact index descriptor cannot reuse complete search or original',async t=>{
  const f=await collectionIndexFixture(t),s=await f.open();await s.list(search('原文'));const changed=record(1,'同版本的新内容'),descriptor=await f.originals.preserve(entry(changed));
  const index=await f.readIndex();index.value.entries[0]=descriptor;await f.writeIndex(index.value);
  await s.list(undefined,{revalidate:true});f.reset();assert.equal((await s.list(search('新内容'))).total,1);assert.equal(f.bodyReads,1);
  assert.equal((await s.get(record(1).id)).record.text,changed.text);assert.equal((await s.list(search('原文'))).total,0);
});

test('changing descriptor metadata without changing the body hash is rejected, not served from a previous cache',async t=>{
  const f=await collectionIndexFixture(t),s=await f.open();await s.get(record(1).id);const index=await f.readIndex();index.value.entries[0].summary.charName='伪造姓名';await f.writeIndex(index.value);
  await s.list(undefined,{revalidate:true});f.reset();await assert.rejects(s.get(record(1).id),{code:'text_collection_sync_original'});assert.equal(f.bodyReads,1);
});

test('body and search memo expiration cause exact re-reading, and backward clocks never extend lifetime',async t=>{
  let now=100000;t.mock.method(Date,'now',()=>now);const f=await collectionIndexFixture(t),s=await f.open();await s.get(record(1).id);await s.list(search('原文'));
  now+=limits.ttlMs;f.reset();await s.get(record(1).id,{preferCache:true});assert.equal(f.bodyReads,1);
  now-=10;f.reset();await s.get(record(1).id,{preferCache:true});assert.equal(f.bodyReads,1);
});

for(const mode of ['account','configuration','abort'])test(`a memo hit still rejects a changed ${mode} before exposing text`,async t=>{
  const f=await collectionIndexFixture(t),s=await f.open();await s.get(record(1).id);await s.list(search('原文'));f.reset();const controller=new AbortController();
  if(mode==='account')f.setAccount('st-user:another');else if(mode==='configuration')f.reconfigure();else controller.abort();
  await assert.rejects(s.get(record(1).id,{preferCache:true,signal:controller.signal}));await assert.rejects(s.list(search('原文'),{preferCache:true,signal:controller.signal}));assert.equal(f.calls.length,0);
});

test('partial failed or cancelled searches never create complete-match cache entries',async t=>{
  const f=await collectionIndexFixture(t,[record(1),record(2),record(3)]),s=await f.open(),controller=new AbortController();let calls=0;
  f.hook(({path})=>{if(path.includes('-collection-record-')&&++calls===2)controller.abort();});
  await assert.rejects(s.list(search('原文'),{signal:controller.signal}));f.hook(null);f.reset();
  assert.equal((await s.list(search('原文'))).total,3);assert.equal(f.bodyReads,2,'only the independently completed first original is reusable');
});

test('bounded original memo evicts least-recently-used entries and never truncates long text to fit',async t=>{
  const records=Array.from({length:17},(_,i)=>record(i+1)),f=await collectionIndexFixture(t,records),s=await f.open();
  for(const item of records)await s.get(item.id);f.reset();await s.get(records[16].id);assert.equal(f.bodyReads,0);await s.get(records[0].id);assert.equal(f.bodyReads,1);
  const memo=createCollectionReadMemo(),descriptor={id:'fixture'};memo.rememberOriginal(descriptor,{text:'长'.repeat(limits.bytes)});assert.equal(memo.getOriginal(descriptor),null);
});

test('serialized UTF-16 budget bounds retained long originals independently of the entry-count cap',async t=>{
  const records=Array.from({length:6},(_,i)=>record(i+1,'字'.repeat(190000))),f=await collectionIndexFixture(t,records),s=await f.open();
  for(const item of records)await s.get(item.id);f.reset();assert.equal((await s.get(records.at(-1).id)).record.text.length,190000);assert.equal(f.bodyReads,0);
  assert.equal((await s.get(records[0].id)).record.text.length,190000);assert.equal(f.bodyReads,1,'six originals exceed 2MiB accounting before reaching the 16-item limit');
});

test('search memo is limited to four complete terms for one exact index and does not expose mutable positions',()=>{
  const memo=createCollectionReadMemo(),state={entries:[]};for(let i=0;i<5;i++)memo.rememberSearch(state,'term'+i,[0,2,4]);
  assert.equal(memo.getSearch(state,'term0'),null);const got=memo.getSearch(state,'term4');got[0]=9;assert.deepEqual([...memo.getSearch(state,'term4')],[0,2,4]);
  assert.equal(memo.getSearch({...state},'term4'),null);const other={entries:[]};memo.rememberSearch(other,'new',[1]);assert.equal(memo.getSearch(state,'term4'),null);
  memo.clear();assert.equal(memo.getSearch(other,'new'),null);
});
