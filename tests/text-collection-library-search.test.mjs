import test from 'node:test';
import assert from 'node:assert/strict';
import {collectionLibraryFixture} from './helpers/collection-library-fixture.mjs';

test('real panel cancels an old search immediately and waits for debounce before sending only the newest text',async t=>{
  const f=await collectionLibraryFixture(t);assert.equal(f.calls.length,1);await f.input('回');await f.tick();const old=f.calls.at(-1);assert.equal(old.input.search,'回');
  await f.input('回忆');assert.equal(old.options.signal.aborted,true);assert.equal(f.calls.length,2);await f.input('回忆冬日');assert.equal(f.timers.size,1);assert.equal(f.calls.length,2);
  await f.tick();const latest=f.calls.at(-1);assert.equal(latest.input.search,'回忆冬日');assert.equal(f.calls.length,3);latest.resolve(1);await f.settle();
  assert.match(f.status,/共 1 条/);assert.doesNotMatch(f.status,/取消|未完成|重试/);
});

test('late response from a source that ignores abort is not rendered before the replacement query',async t=>{
  const f=await collectionLibraryFixture(t,{ignoreAbort:true});await f.input('旧');await f.tick();const old=f.calls.at(-1);
  await f.input('新');await f.tick();assert.equal(f.calls.length,2,'a second query is not run in parallel with an uncooperative first source');
  old.resolve(7);await f.settle();assert.doesNotMatch(f.status,/共 7 条/);assert.equal(f.calls.at(-1).input.search,'新');
  f.calls.at(-1).resolve(2);await f.settle();assert.match(f.status,/共 2 条/);
});

test('closing the actual panel aborts its active search and does not start pending input work',async t=>{
  const f=await collectionLibraryFixture(t);await f.input('搜索');await f.tick();const old=f.calls.at(-1);await f.input('待发送');
  f.panel.stop();await f.settle();assert.equal(old.options.signal.aborted,true);assert.equal(f.closed,true);assert.equal(f.timers.size,0);assert.equal(f.calls.length,2);
});

test('stale cached browsing does not start a hidden background refresh on search',async t=>{
  const f=await collectionLibraryFixture(t,{background:true});
  assert.equal(f.calls.some(call=>call.options.revalidate),false);
  await f.input('新');await f.tick();
  const newest=f.calls.at(-1);assert.equal(newest.input.search,'新');assert.equal(newest.options.revalidate,undefined);
  newest.resolve(1);await f.settle();assert.match(f.status,/共 1 条/);
  assert.equal(f.calls.some(call=>call.options.revalidate),false);
});

test('explicit refresh remains a foreground read without hidden revalidation',async t=>{
  const f=await collectionLibraryFixture(t,{background:true,initialCount:1});
  assert.equal(f.calls.length,1);assert.equal(f.calls[0].options.revalidate,undefined);
  await f.click('refresh');
  assert.equal(f.calls.length,2);assert.equal(f.calls.at(-1).options.revalidate,undefined);
  assert.equal(f.calls.some(call=>call.options.revalidate),false);
});

test('a genuine active search error is still visible rather than hidden by cancellation handling',async t=>{
  const f=await collectionLibraryFixture(t);await f.input('关键词');await f.tick();f.calls.at(-1).reject(Object.assign(Error('原件缺失，请核对'),{code:'text_collection_sync_original'}));await f.settle();
  assert.match(f.status,/原件缺失/);
});
