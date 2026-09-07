import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import * as core from '../qianmu-storyboard.js';
import { storyboardFunctionSource as section } from './helpers/storyboard-form-fixture.mjs';

const order = (shotIndex = 0, requestIndex = 1, batchId = 'batch-a', batchStartedAt = 100) => ({ version: 1, batchId, batchStartedAt, shotIndex, requestIndex });
const record = (id, shotIndex = 0, extra = {}) => ({ id, chatKey: 'chat-a', floor: 3, swipeId: 0, messageHash: 'body-a',
  inlineOrder: order(shotIndex), imageIndex: 0, createdAt: 1000, ...extra });
const ids = rows => rows.map(row => row.id);
const sort = core.sortStoryboardInlineRecords;
const plain = value => JSON.parse(JSON.stringify(value));

test('inline order is bounded, explicit, detached and does not coerce malformed metadata', () => {
  const input = { ...order(), workflow: { private: true } }, normalized = core.normalizeStoryboardInlineOrder(input);
  assert.deepEqual(normalized, order()); input.shotIndex = 4; assert.equal(normalized.shotIndex, 0);
  for (const change of [{ version: 2 }, { batchId: '' }, { batchId: 'x'.repeat(161) }, { batchId: 'a\nb' }, { batchStartedAt: 0 },
    { batchStartedAt: NaN }, { batchStartedAt: Infinity }, { shotIndex: '0' }, { shotIndex: 20 }, { shotIndex: -1 }, { shotIndex: 1.5 }, { requestIndex: 0 }, { requestIndex: 21 }]) {
    assert.equal(core.normalizeStoryboardInlineOrder({ ...order(), ...change }), null);
  }
  assert.equal(core.normalizeStoryboardInlineOrder(null), null);
});

test('3 → 1 → 2 completion keeps narrative order for mixed engines without mutating storage', () => {
  const third = record('3', 2, { source: 'comfy', createdAt: 1001 });
  const first = record('1', 0, { source: 'novel', createdAt: 1003 });
  const second = record('2', 1, { source: 'banana', createdAt: 1006 });
  const source = Object.freeze([Object.freeze(third), Object.freeze(first), Object.freeze(second)]);
  assert.deepEqual(ids(sort(source.slice(0, 1))), ['3']);
  assert.deepEqual(ids(sort(source.slice(0, 2))), ['1', '3']);
  assert.deepEqual(ids(sort(source)), ['1', '2', '3']);
  assert.deepEqual(ids(source), ['3', '1', '2']);
  assert.equal(sort(source)[0], first);
});

test('retry and redraw variants stay with their shot, before the next shot; request outputs keep their own order', () => {
  const rows = [record('next', 1), record('second-output', 0, { imageIndex: 1 }),
    record('request-2', 0, { inlineOrder: order(0, 2) }), record('first-output'),
    record('redraw', 0, { createdAt: 4000, taskId: 'new-task' }), record('retry-request-2', 0, { inlineOrder: order(0, 2), createdAt: 5000 })];
  assert.deepEqual(ids(sort(rows)), ['first-output', 'redraw', 'second-output', 'request-2', 'retry-request-2', 'next']);
});

test('distinct preparation batches are independent of completion time and deterministic on timestamp ties', () => {
  const rows = [record('b', 0, { inlineOrder: order(0, 1, 'batch-b') }), record('a2', 1), record('a1'),
    record('earlier', 0, { inlineOrder: order(0, 1, 'batch-z', 90), createdAt: 9000 })];
  assert.deepEqual(ids(sort(rows)), ['earlier', 'a1', 'a2', 'b']);
  assert.deepEqual(ids(sort([...rows].reverse())), ['earlier', 'a1', 'a2', 'b']);
});

test('legacy images do not invent narrative intent; their variants remain grouped ahead of new batches', () => {
  const old = (id, root) => record(id, 0, { inlineOrder: null, variantRootId: root });
  const rows = [old('old-a', 'a'), record('new'), old('old-b', 'b'), old('redraw-a', 'a'),
    old('b-other-chat', 'b'), old('b-other-swipe', 'b')];
  rows[4].chatKey = 'chat-b'; rows[5].swipeId = 1;
  assert.deepEqual(ids(sort(rows)), ['old-a', 'redraw-a', 'old-b', 'b-other-chat', 'b-other-swipe', 'new']);
  assert.deepEqual(sort(null), []);
});

test('sorting reads lightweight metadata only, including after heavy snapshot archival', () => {
  const rows = Array.from({ length: 400 }, (_, index) => record(String(index), index % 20, { inlineOrder: order(index % 20, 1, `batch-${Math.floor(index / 20)}`, 100 + Math.floor(index / 20)) }));
  rows.forEach(row => { for (const key of ['snapshot', 'url', 'shotSpec', 'compiledPrompt', 'profile']) Object.defineProperty(row, key, { get() { throw Error('heavy read'); } }); });
  assert.equal(sort([...rows].reverse()).length, 400);
  assert.equal(sort([...rows].reverse())[0].id, '0');
});

test('exact retry snapshot preserves inline order across sanitization and never supplies new intent for legacy logs', () => {
  const context = vm.createContext({ ...core, clone: structuredClone, uid: () => 'retry-id' });
  vm.runInContext(section('storyboardJobFromLog'), context);
  const snapshot = core.sanitizeStoryboardSnapshot({ source: 'novel', profile: { model: 'nai-diffusion-5-full' },
    payload: { prompt: 'quiet garden' }, connection: { baseUrl: 'https://image.example', credentialId: 'reference-only' }, inlineOrder: order(2) });
  const retry = context.storyboardJobFromLog({ attempt: 1, snapshot });
  assert.equal(retry.id, 'retry-id'); assert.equal(retry.attempt, 2); assert.deepEqual(plain(retry.inlineOrder), order(2));
  delete snapshot.inlineOrder;
  const legacy = context.storyboardJobFromLog({ attempt: 1, snapshot });
  assert.equal(legacy.inlineOrder, undefined);
  assert.equal(core.sanitizeStoryboardSnapshot({ inlineOrder: { ...order(), shotIndex: '2' } }).inlineOrder, null);
});

test('record and log projections retain the order outside the removable heavy snapshot', () => {
  const state = core.createStoryboardDefaults(), context = vm.createContext({ ...core,
    clone: structuredClone, uid: () => 'generated', storyboardState: () => state,
    storyboardItemCollectionIds: () => [], uniqueClean: value => value, hashText: () => 'hash',
    storyboardPipelineArchiveCache: new Map(), saveSettings() {},
  });
  vm.runInContext([section('storyboardCreateRecord'), section('storyboardStartLog')].join('\n'), context);
  const job = { id: 'job', source: 'novel', profile: { model: 'nai-diffusion-5-full' }, payload: { prompt: 'quiet garden' },
    planId: 'plan', planShotId: 'shot', inlineOrder: order(2), floor: 3, chatKey: 'chat-a', inlineByDefault: true,
    target: 'floor', prompt: 'quiet garden', compilerStages: [], attempt: 1 };
  const log = context.storyboardStartLog(job);
  assert.deepEqual(plain(log.snapshot.inlineOrder), order(2));
  const image = context.storyboardCreateRecord(job, log, '/user/images/a.png', 0, { floor: 3, message: { mes: 'body', swipe_id: 0 }, valid: true }, {});
  assert.deepEqual(plain(image.inlineOrder), order(2));
  delete image.snapshot; job.inlineOrder.shotIndex = 7;
  assert.equal(image.inlineOrder.shotIndex, 2);
  assert.equal(log.snapshot.inlineOrder.shotIndex, 2);
});

test('multiple fallback or shared-paragraph placements append in order while distinct anchors remain independent', () => {
  const dom = [], node = id => ({ id, insertAdjacentElement(position, item) {
    assert.equal(position, 'afterend'); dom.splice(dom.indexOf(this) + 1, 0, item);
  } });
  const p = node('paragraph'), text = node('text'), footer = node('footer'); dom.push(p, text, footer);
  const context = vm.createContext({}); vm.runInContext(section('storyboardInsertInlineWrapper'), context);
  const tails = new Map();
  for (const id of ['p1', 'p2']) context.storyboardInsertInlineWrapper(text, { node: p, fallback: false }, node(id), tails);
  for (const id of ['end1', 'end2', 'end3']) context.storyboardInsertInlineWrapper(text, { node: p, fallback: true }, node(id), tails);
  assert.deepEqual(ids(dom), ['paragraph', 'p1', 'p2', 'text', 'end1', 'end2', 'end3', 'footer']);
});

test('inserted illustration markup never becomes a paragraph when scoring the next anchor', () => {
  const prose = { matches: () => true, closest: () => null, textContent: 'real paragraph' };
  const illustration = { matches: () => true, closest: () => ({}), textContent: 'picture and buttons' };
  const context = vm.createContext({ storyboardCleanMessageText: value => value });
  vm.runInContext(section('storyboardMessageParagraphNodes'), context);
  assert.deepEqual(Array.from(context.storyboardMessageParagraphNodes({ children: [prose, illustration] })), [prose]);
  assert.deepEqual(Array.from(context.storyboardMessageParagraphNodes({ children: [], querySelectorAll: () => [illustration, prose] })), [prose]);
});

test('generation freezes one batch before asynchronous adaptation and rendering still enforces original link guards', () => {
  const generate = section('storyboardGenerate'), render = section('storyboardRenderInlineImages');
  assert.ok(generate.indexOf('const inlineBatch =') < generate.indexOf('await storyboardAdaptShotForModel'));
  assert.match(generate, /inlineOrder: \{ \.\.\.inlineBatch, shotIndex: index, requestIndex: request.requestIndex \}/);
  assert.match(section('storyboardCreateJob'), /inlineOrder: normalizeStoryboardInlineOrder\(inlineOrder\)/);
  assert.ok(render.indexOf('storyboardInlineRecordValid(record)') < render.indexOf('sortStoryboardInlineRecords(items.records)'));
  assert.doesNotMatch(render, /storyboardHydrateGallerySnapshots|storyboardReadSnapshotForRecord/);
  assert.match(section('storyboardInlineRecordValid'), /inactive|\['active', 'stale'\]/);
});
