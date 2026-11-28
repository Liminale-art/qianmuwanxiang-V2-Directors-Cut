import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import * as reader from '../qianmu-reader.js';
import {storyboardFunctionSource as section} from './helpers/storyboard-form-fixture.mjs';

const {planCoreadBatches, planCoreadTextSpans, coreadUncoveredTextRanges, coreadSliceCreatedAt} = reader;

// 批次必须首尾相接、互不重叠、盖住全部条目；除「单条超限独占一批」外不得超过上限。
function assertTiles(lengths, cap, joinCost = 0) {
  const batches = planCoreadBatches(lengths, cap, joinCost);
  if (!lengths.length) { assert.deepEqual(batches, []); return batches; }
  assert.equal(batches[0].from, 0);
  assert.equal(batches.at(-1).to, lengths.length - 1);
  batches.forEach((batch, i) => {
    assert.ok(batch.from <= batch.to, 'no empty batch');
    if (i) assert.equal(batch.from, batches[i - 1].to + 1, 'contiguous, no gap, no overlap');
    const filled = lengths.slice(batch.from, batch.to + 1).filter((len) => len > 0);
    const size = filled.reduce((sum, len) => sum + len, 0) + Math.max(0, filled.length - 1) * joinCost;
    if (cap > 0 && filled.length > 1) assert.ok(size <= cap, `batch ${i} size ${size} exceeds cap ${cap}`);
    if (i) assert.ok(filled.length, 'only the first batch may consist of empty items alone');
  });
  return batches;
}

test('batch planner: empty input, no cap and exact fits', () => {
  assert.deepEqual(planCoreadBatches([], 100), []);
  assert.deepEqual(planCoreadBatches(null, 100), []);
  assert.deepEqual(planCoreadBatches([5, 5, 5], 0), [{from: 0, to: 2}]);
  assert.deepEqual(planCoreadBatches([5, 5, 5], -1), [{from: 0, to: 2}]);
  assert.deepEqual(planCoreadBatches([5, 5, 5], 15), [{from: 0, to: 2}]);
  assert.deepEqual(planCoreadBatches([5, 5, 5], 14), [{from: 0, to: 1}, {from: 2, to: 2}]);
  assert.deepEqual(planCoreadBatches([5, 5, 5], 15, 1), [{from: 0, to: 1}, {from: 2, to: 2}], 'separator counts toward the cap');
  assert.deepEqual(planCoreadBatches([5, 5, 5], 5), [{from: 0, to: 0}, {from: 1, to: 1}, {from: 2, to: 2}]);
});

test('batch planner: an oversized item goes alone and is never split or dropped', () => {
  assert.deepEqual(planCoreadBatches([3, 50, 3], 10), [{from: 0, to: 0}, {from: 1, to: 1}, {from: 2, to: 2}]);
  assert.deepEqual(planCoreadBatches([50], 10), [{from: 0, to: 0}]);
  assert.deepEqual(planCoreadBatches([50, 50], 10), [{from: 0, to: 0}, {from: 1, to: 1}]);
});

test('batch planner: empty items never form a batch of their own', () => {
  assert.deepEqual(planCoreadBatches([0, 0], 10), [{from: 0, to: 1}]);
  assert.deepEqual(planCoreadBatches([0, 6, 0, 6, 0], 10), [{from: 0, to: 2}, {from: 3, to: 4}]);
  assert.deepEqual(planCoreadBatches([50, 0, 0], 10), [{from: 0, to: 2}]);
});

test('batch planner: every input is tiled exactly under every cap', () => {
  let seed = 7;
  const next = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
  for (let round = 0; round < 300; round++) {
    const lengths = Array.from({length: next(30)}, () => (next(5) ? next(60) : 0));
    for (const cap of [0, 1, 7, 25, 60, 1000]) for (const join of [0, 1]) assertTiles(lengths, cap, join);
  }
});

test('text spans: contiguous character ranges that reproduce the text without loss', () => {
  const text = `${'甲'.repeat(30)}\n${'乙'.repeat(10)}\n\n${'丙'.repeat(95)}\n${'丁'.repeat(8)}`;
  for (const cap of [0, 1, 10, 25, 40, 1000]) {
    for (const [from, to] of [[0, text.length], [5, 120], [31, 31], [140, 9999]]) {
      const spans = planCoreadTextSpans(text, from, to, cap);
      const start = Math.min(from, text.length), end = Math.min(to, text.length);
      if (end <= start) { assert.deepEqual(spans, []); continue; }
      assert.equal(spans[0].from, start);assert.equal(spans.at(-1).to, end);
      spans.forEach((span, i) => {
        assert.ok(span.to > span.from);
        if (i) assert.equal(span.from, spans[i - 1].to);
        if (cap > 0) assert.ok(span.to - span.from <= cap, 'text is hard-split, so the cap always holds');
      });
      assert.equal(spans.map((span) => text.slice(span.from, span.to)).join(''), text.slice(start, end));
    }
  }
  assert.deepEqual(planCoreadTextSpans('ab\ncd\nef', 0, 8, 6), [{from: 0, to: 6}, {from: 6, to: 8}], 'prefers line breaks');
});

test('uncovered text ranges use the union of text slices, not the largest end', () => {
  const slices = [
    {src: 'text', coveredFrom: 0, coveredTo: 100},
    {src: 'text', coveredFrom: 300, coveredTo: 400},
    {src: 'dialog', coveredFrom: 0, coveredTo: 9999},
    {src: 'mainline', coveredFrom: 0, coveredTo: 9999},
    {src: 'mixed', coveredFrom: 0, coveredTo: 9999, provenance: {source: 'mixed', sources: ['dialog', 'book'], charFrom: 100, charTo: 150}},
  ];
  assert.deepEqual(coreadUncoveredTextRanges(slices, 500), [{from: 150, to: 300}, {from: 400, to: 500}]);
  assert.deepEqual(coreadUncoveredTextRanges(slices, 350), [{from: 150, to: 300}]);
  assert.deepEqual(coreadUncoveredTextRanges(slices, 120), []);
  assert.deepEqual(coreadUncoveredTextRanges([], 80), [{from: 0, to: 80}]);
  assert.deepEqual(coreadUncoveredTextRanges([], 0), []);
  assert.deepEqual(coreadUncoveredTextRanges([{src: 'text', coveredFrom: 0, coveredTo: 1000}], 600), [], 'a full-book pass leaves nothing to do');
});

test('slice creation time prefers provenance and falls back to ts', () => {
  assert.equal(coreadSliceCreatedAt({ts: 9, provenance: {createdAt: 5}}), 5);
  assert.equal(coreadSliceCreatedAt({ts: 9}), 9);
  assert.equal(coreadSliceCreatedAt({}), 0);
});

// ── 真实函数：伴读对话总结 ──
const DIALOG_FUNCTIONS = ['coreadExplainError', 'coreadTranscriptLine', 'coreadClampBatchChars', 'coreadBatchBudget', 'coreadDialogBatches', 'coreadTextSpanSize', 'coreadMemorySnapshot', 'coreadMemoryRestore',
  'coreadNextBatch', 'coreadRecalculateDialogCursor', 'coreadReplaceDialogRange', 'coreadCommitDialogSlices', 'coreadPersistSlice',
  'coreadDistill', 'coreadManualSummarize', 'coreadRenumberSlices', 'coreadRegenSlice', 'coreadSaveSliceEdit', 'coreadDeleteSlice',
  'coreadClearAllSlices', 'coreadMergeSynonyms', 'coreadSummarizeStage', 'coreadStageFromResult', 'coreadSaveStageEdit', 'coreadRegenStage', 'coreadDeleteStage', 'coreadMaybeStage', 'coreadSummarySystemPrompt', 'coreadDistillText', 'coreadTooLongReason',
  'coreadBuildSliceFromParsed', 'coreadNormalizeSynonyms', 'coreadIsTransientError'];

function dialogFixture({messages = 12, cap = 100, slices = []} = {}) {
  const sent = [], toasts = [], saves = [];
  let id = 0, clock = 1000;
  const state = {saveOk: true, failAt: -1, modelCalls: [], memory: {summaryContextChars: cap, distillEvery: 2, vectorEnabled: false, sliceChars: 400,
    stageAuto: true, stageTrigger: 3, stageKeep: 1, stageChars: 800, summaryPrompts: reader.defaultCoreadSummaryPrompts()}};
  state.model = async () => JSON.stringify({summary: '合并', keywords: ['k']});
  const c = vm.createContext({
    coreadScheduleStage: () => {},
    reader, console, MODULE_NAME: 'fixture', Date: {now: () => ++clock},
    readerDialog: {
      bookId: 'book', bucket: 'A::book', loaded: true, cursor: 0, summaryFloor: 0, slices, stages: [], stageFailure: null,
      messages: Array.from({length: messages}, (_, i) => ({id: `m${i}`, role: i % 2 ? 'friend' : 'user', text: `第${String(i).padStart(2, '0')}句`.padEnd(30, '话')})),
    },
    coreadDistilling: false, coreadMemoryWrites: 0, coreadVecCache: null,
    coreadVectorStates: new Map(), coreadPipelineCircuits: new Map(), coreadEchoTtl: new Map(),
    coreadMemory: () => state.memory, coreadBookMeta: () => ({title: '书'}), companionCharName: () => '友', coreadUserName: () => '我',
    coreadCurrentReadBoundarySync: () => ({bookId: 'book', readTo: 500, chapterIndex: 0, progress: 10}),
    coreadNormalizeSlices: (rows, bookId, bucket, boundary) => rows.map((slice) => reader.normalizeCoreadSlice(slice, {bookId, bucket, boundary})),
    coreadSliceFingerprint: () => 'fp', coreadSyncSliceVector: async () => ({ok: false, skipped: true}),
    coreadForgetSliceRuntime: async () => {}, coreadUpdateComicDescriptionForSlice: async () => {}, coreadComicRecord: () => null,
    blobStore: {deleteReaderVectors: async () => {}}, rerenderMoreIfOpen: () => {},
    uid: (prefix) => `${prefix}-${++id}`, uniqueClean: (list) => [...new Set(list)], isPlainObject: (value) => !!value && typeof value === 'object' && !Array.isArray(value),
    extractJson: JSON.parse, coreadSalvageSummary: () => '',
    callCoreadModel: async (system, user) => { state.modelCalls.push({system, user}); return state.model(system, user); },
    COREAD_MEMORY_ENABLED: true, COREAD_DISTILL_RETRY: 2, coreadDateHint: () => '', DOMException,
    toast: (message, level) => toasts.push({message, level}),
    coreadSaveDialog: async () => { saves.push(c.readerDialog.slices.length); return state.saveOk; },
    coreadDistillSegment: async (segMsgs, m, meta, names) => {
      if (sent.length === state.failAt) { sent.push(null); throw new Error('HTTP 400'); }
      const transcript = segMsgs.filter((msg) => String(msg.text || '').trim()).map((msg) => c.coreadTranscriptLine(msg, names)).join('\n');
      sent.push(transcript);
      return {summary: `总结${sent.length}`, keywords: ['k'], synonyms: {}};
    },
  });
  vm.runInContext(DIALOG_FUNCTIONS.map(section).join('\n'), c);
  return {c, sent, toasts, saves, state, dialog: () => c.readerDialog};
}
const ranges = (dialog) => dialog.slices.map((slice) => [slice.coveredFrom, slice.coveredTo]);
const successToasts = (toasts) => toasts.filter((item) => item.level === 'success');

test('a long pending dialogue becomes several slices whose ranges tile the pending messages', async () => {
  const e = dialogFixture({messages: 12, cap: 100});
  const result = await e.c.coreadDistill(true);
  assert.equal(result.ok, true);
  const covered = ranges(e.dialog());
  assert.ok(covered.length > 1, 'the cap must produce more batches, not a shorter transcript');
  assert.equal(result.made, covered.length);
  assert.equal(covered[0][0], 0);assert.equal(covered.at(-1)[1], 11);
  covered.forEach(([from], i) => { if (i) assert.equal(from, covered[i - 1][1] + 1); });
  assert.equal(e.dialog().cursor, 12);
  // 每条切片登记的范围，正是那一批真正送给模型的消息；送出的内容合起来一句不少。
  e.dialog().slices.forEach((slice, i) => {
    assert.ok(e.sent[i].length <= 100);
    const expected = e.dialog().messages.slice(slice.coveredFrom, slice.coveredTo + 1).map((msg) => `${msg.role === 'user' ? '我' : '友'}：${msg.text}`).join('\n');
    assert.equal(e.sent[i], expected);
    assert.equal(slice.provenance.dialogFrom, slice.coveredFrom);assert.equal(slice.provenance.dialogTo, slice.coveredTo);
    assert.deepEqual([...slice.provenance.dialogMessageIds], e.dialog().messages.slice(slice.coveredFrom, slice.coveredTo + 1).map((msg) => msg.id));
  });
  assert.equal(e.saves.length, covered.length, 'each batch is saved before the next one starts');
  assert.equal(successToasts(e.toasts).length, 1);
  assert.equal(e.c.coreadDistilling, false);
});

test('a single message longer than the cap is sent whole in its own slice', async () => {
  const e = dialogFixture({messages: 3, cap: 1300});
  e.state.memory.distillEvery = 3;   // 按条数是一批；按字数额度（至少 1000）拆成三批
  e.dialog().messages[1].text = '长'.repeat(1200);
  assert.equal((await e.c.coreadDistill(true)).ok, true);
  assert.deepEqual(ranges(e.dialog()), [[0, 0], [1, 1], [2, 2]]);
  assert.equal(e.sent[1], `友：${'长'.repeat(1200)}`);
  assert.ok(!e.sent.some((text) => text.includes('较早内容略')));
});

test('dialogue batches follow 对话每多少条总结一次 for manual and automatic runs; automatic leaves a partial tail for later', async () => {
  const e = dialogFixture({messages: 7, cap: 0});
  e.state.memory.distillEvery = 3;
  assert.equal((await e.c.coreadDistill(false)).ok, true);
  assert.deepEqual(ranges(e.dialog()), [[0, 2], [3, 5]], 'the seventh message waits until a full batch of three');
  assert.equal(e.dialog().cursor, 6);
  const m = dialogFixture({messages: 7, cap: 0});
  m.state.memory.distillEvery = 3;
  assert.equal((await m.c.coreadManualSummarize(0, 6)).ok, true);
  assert.deepEqual(ranges(m.dialog()), [[0, 2], [3, 5], [6, 6]], 'a manual run takes the partial tail too');
});

test('a non-zero batch limit never drops below 2000, and the prompt is counted inside it', () => {
  const e = dialogFixture({messages: 2});
  assert.deepEqual([0, -5, '', 1, 1999, 2000, 50000].map((v) => e.c.coreadClampBatchChars(v)), [0, 0, 0, 2000, 2000, 2000, 50000]);
  const memory = {...e.state.memory, summaryContextChars: 50000};
  const budget = e.c.coreadBatchBudget(memory, 'dialog', {title: '书'}, {user: '我', char: '友'});
  const prompt = e.c.coreadSummarySystemPrompt('dialog', memory, {title: '书'}, {user: '我', char: '友'}, {progress: '读至第 999 章 · 100%'}).length;
  assert.ok(budget < 50000 - prompt && budget >= 50000 - prompt - 400, String(budget));
  assert.equal(e.c.coreadBatchBudget({...memory, summaryContextChars: 0}, 'dialog', {}, {}), 0, '0 is unlimited');
});

test('a failed batch stops the run: earlier slices stay and the cursor stops before the failure', async () => {
  const e = dialogFixture({messages: 12, cap: 100});
  e.state.failAt = 1;
  const result = await e.c.coreadDistill(true);
  assert.equal(result.ok, false);assert.equal(result.made, 1);
  assert.equal(e.dialog().slices.length, 1);
  assert.equal(e.dialog().cursor, e.dialog().slices[0].coveredTo + 1);
  assert.ok(e.dialog().cursor < 12);
  assert.equal(e.sent.length, 2, 'no batch is attempted after the failed one');
  assert.equal(successToasts(e.toasts).length, 0);
  assert.equal(e.toasts.filter((item) => item.level === 'error' || item.level === 'warning').length, 1);
  // 再跑一次从失败处接着来，最终仍然铺满。
  e.state.failAt = -1;
  assert.equal((await e.c.coreadDistill(true)).ok, true);
  const covered = ranges(e.dialog());
  covered.forEach(([from], i) => { if (i) assert.equal(from, covered[i - 1][1] + 1); });
  assert.equal(covered.at(-1)[1], 11);assert.equal(e.dialog().cursor, 12);
});

test('a failed save reports no success, keeps no slice and does not advance the cursor', async () => {
  const e = dialogFixture({messages: 12, cap: 100});
  e.state.saveOk = false;
  const result = await e.c.coreadDistill(true);
  assert.equal(result.ok, false);
  assert.equal(e.dialog().slices.length, 0);assert.equal(e.dialog().cursor, 0);
  assert.equal(e.sent.length, 1, 'stops at the first batch that could not be saved');
  assert.equal(successToasts(e.toasts).length, 0);
  assert.equal(e.toasts.filter((item) => /记忆未能保存，请重试/.test(item.message)).length, 1);
  assert.equal(e.c.coreadVectorStates.size, 0);
  const manual = await e.c.coreadManualSummarize(0, 3);
  assert.equal(manual.ok, false);assert.match(manual.reason, /记忆未能保存/);assert.equal(e.dialog().slices.length, 0);
});

test('re-summarising over old slices replaces them only after every batch succeeded', async () => {
  const old = reader.normalizeCoreadSlice({id: 'old', batch: 1, src: 'dialog', summary: '旧', keywords: [], coveredFrom: 0, coveredTo: 7, ts: 1});
  const e = dialogFixture({messages: 12, cap: 100, slices: [old]});
  e.state.failAt = 1;
  const failed = await e.c.coreadManualSummarize(2, 3);
  assert.equal(failed.ok, false);
  assert.deepEqual(e.dialog().slices.map((slice) => slice.id), ['old'], 'a half-finished re-summary must not drop or duplicate the old memory');
  e.state.failAt = -1;
  const done = await e.c.coreadManualSummarize(2, 3);
  assert.equal(done.ok, true);assert.ok(done.made > 1);
  assert.ok(!e.dialog().slices.some((slice) => slice.id === 'old'));
  const covered = ranges(e.dialog());
  assert.equal(covered[0][0], 0);assert.equal(covered.at(-1)[1], 7);
  covered.forEach(([from], i) => { if (i) assert.equal(from, covered[i - 1][1] + 1); });
});

test('slice mutations are refused while a distill runs, and distills wait for a mutation in progress', async () => {
  const slice = () => reader.normalizeCoreadSlice({id: 's1', batch: 1, src: 'dialog', summary: '原', keywords: ['a'], coveredFrom: 0, coveredTo: 1, ts: 1});
  const e = dialogFixture({messages: 4, slices: [slice(), {...slice(), id: 's2', batch: 2, coveredFrom: 2, coveredTo: 3}]});
  e.c.coreadDistilling = true;
  for (const run of [() => e.c.coreadRegenSlice('s1'), () => e.c.coreadSaveSliceEdit('s1', '改', 'x'), () => e.c.coreadDeleteSlice('s1'),
    () => e.c.coreadClearAllSlices(), () => e.c.coreadMaybeStage({retry: true})]) {
    const result = await run();
    assert.equal(result.ok, false);assert.ok(result.reason);
  }
  assert.deepEqual(e.dialog().slices.map((item) => [item.id, item.summary]), [['s1', '原'], ['s2', '原']]);
  assert.equal(e.c.coreadMemoryWrites, 0);assert.equal(e.saves.length, 0);assert.equal(e.sent.length, 0);
  e.c.coreadDistilling = false;e.c.coreadMemoryWrites = 1;
  for (const run of [() => e.c.coreadDistill(true), () => e.c.coreadManualSummarize(0, 1), () => e.c.coreadMaybeStage({retry: true}), () => e.c.coreadDeleteSlice('s1')]) {
    assert.equal((await run()).ok, false);
  }
  assert.equal(e.sent.length, 0);assert.equal(e.state.modelCalls.length, 0);assert.equal(e.c.coreadDistilling, false);assert.equal(e.dialog().slices.length, 2);
});

test('edit, regenerate, delete and clear roll back when the archive cannot be saved', async () => {
  const make = () => [1, 2].map((n) => reader.normalizeCoreadSlice({id: `s${n}`, batch: n, src: 'dialog', summary: `原${n}`, keywords: ['a'], coveredFrom: (n - 1) * 2, coveredTo: n * 2 - 1, ts: n}));
  const e = dialogFixture({messages: 4, slices: make()});
  e.dialog().cursor = 4;
  e.state.saveOk = false;
  const before = JSON.stringify(e.dialog().slices);
  for (const run of [() => e.c.coreadSaveSliceEdit('s1', '改', 'x'), () => e.c.coreadRegenSlice('s1'), () => e.c.coreadDeleteSlice('s1'),
    () => e.c.coreadClearAllSlices()]) {
    const result = await run();
    assert.equal(result.ok, false);assert.match(result.reason, /记忆未能保存，请重试/);
    assert.equal(JSON.stringify(e.dialog().slices), before);
    assert.equal(e.dialog().cursor, 4);assert.equal(e.dialog().summaryFloor, 0);assert.equal(e.c.coreadMemoryWrites, 0);assert.equal(e.c.coreadDistilling, false);
  }
  e.state.saveOk = true;
  assert.equal((await e.c.coreadDeleteSlice('s2')).ok, true);
  assert.deepEqual(e.dialog().slices.map((item) => item.id), ['s1']);assert.equal(e.dialog().cursor, 2);
  assert.equal((await e.c.coreadClearAllSlices()).ok, true);
  assert.equal(e.dialog().slices.length, 0);assert.equal(e.dialog().summaryFloor, 4);
});

test('regenerate only accepts dialogue slices, whose range is a message range', async () => {
  const text = reader.normalizeCoreadSlice({id: 't', batch: 1, src: 'text', summary: '正文', keywords: [], coveredFrom: 0, coveredTo: 3, ts: 1});
  const e = dialogFixture({messages: 4, slices: [text]});
  const result = await e.c.coreadRegenSlice('t');
  assert.equal(result.ok, false);assert.equal(e.sent.length, 0);assert.equal(e.dialog().slices[0].summary, '正文');
});

test('recent slices are ordered by creation time across kinds, array order breaking ties', () => {
  const c = vm.createContext({reader, readerDialog: {slices: []}});
  vm.runInContext(section('coreadRecentSlices'), c);
  const pool = [
    {id: 'text-old', src: 'text', coveredTo: 900000, ts: 999, provenance: {createdAt: 10}},
    {id: 'mainline', src: 'mainline', coveredTo: 4000, provenance: {createdAt: 20}},
    {id: 'dialog-new', src: 'dialog', coveredTo: 12, provenance: {createdAt: 30}},
    {id: 'legacy-ts', src: 'dialog', coveredTo: 3, ts: 25},
  ];
  assert.deepEqual(Array.from(c.coreadRecentSlices(3, pool), (hit) => hit.slice.id), ['dialog-new', 'legacy-ts', 'mainline']);
  assert.deepEqual(Array.from(c.coreadRecentSlices(9, [{id: 'a'}, {id: 'b'}, {id: 'c'}]), (hit) => hit.slice.id), ['c', 'b', 'a'], 'undated old slices fall back to array order');
  assert.equal(pool[0].id, 'text-old', 'the pool itself is not reordered');
  assert.equal(c.coreadRecentSlices(0, pool).length, 0);
});

// ── 真实函数：阶段总结 ──
const stageSlices = (n) => Array.from({length: n}, (_, i) => reader.normalizeCoreadSlice({id: `s${i + 1}`, batch: i + 1, src: 'dialog', summary: `原${i + 1}`,
  keywords: [`k${i + 1}`], synonyms: i === 0 ? {甲: ['阿甲']} : {}, coveredFrom: i * 2, coveredTo: i * 2 + 1, ts: i + 1}));

test('a stage is added on top of the oldest run of slices; the slices themselves stay untouched', async () => {
  const e = dialogFixture({messages: 10, slices: stageSlices(5)});
  const before = JSON.stringify(e.dialog().slices);
  e.state.model = async () => JSON.stringify({summary: '这一段', keywords: ['阶段词'], synonyms: {乙: ['阿乙']}});
  const result = await e.c.coreadMaybeStage();
  assert.equal(result.ok, true);
  assert.equal(JSON.stringify(e.dialog().slices), before, 'slices are never rewritten or removed');
  const [stage] = e.dialog().stages;
  assert.deepEqual(stage.parents.map((parent) => parent.id), ['s1', 's2', 's3'], 'trigger 3, the newest one kept out');
  assert.equal(stage.summary, '这一段');assert.deepEqual(stage.keywords, ['阶段词']);
  assert.deepEqual({...stage.synonyms}, {甲: ['阿甲'], 乙: ['阿乙']}, 'synonym tables are merged, not lost');
  assert.deepEqual([stage.provenance.dialogFrom, stage.provenance.dialogTo], [0, 5]);
  const [call] = e.state.modelCalls;
  assert.match(call.system, /按顺序排列的 3 条共读交流记忆/);assert.match(call.system, /不超过 800 字/);assert.match(call.system, /【阶段整理】\n把按顺序排列/);
  assert.equal(call.user, '【记忆】\n1. 原1\n2. 原2\n3. 原3');
  assert.equal(e.dialog().stageFailure, null);
  assert.ok(e.toasts.some((t) => /已把 3 条共读交流合成一条阶段总结/.test(t.message)));
  assert.equal((await e.c.coreadMaybeStage()).reason, 'nothing', 's4 alone is not enough; s5 is kept');
  assert.equal(e.state.modelCalls.length, 1);
});

test('a stage whose archive cannot be saved is rolled back and reported', async () => {
  const e = dialogFixture({messages: 10, slices: stageSlices(4)});
  e.state.saveOk = false;
  const result = await e.c.coreadMaybeStage();
  assert.equal(result.ok, false);assert.match(result.reason, /记忆未能保存，请重试/);
  assert.equal(e.dialog().stages.length, 0);assert.equal(e.dialog().slices.length, 4);
  assert.equal(e.c.coreadDistilling, false);
});

test('a failed stage is reported once and not retried until the slice count changes; the retry button forces it', async () => {
  const e = dialogFixture({messages: 10, slices: stageSlices(4)});
  e.state.model = async () => { throw new Error('HTTP 401'); };
  const first = await e.c.coreadMaybeStage();
  assert.equal(first.failed, true);assert.match(first.reason, /鉴权失败/);
  assert.equal(e.dialog().stageFailure.sliceCount, 4);
  assert.equal(e.toasts.filter((t) => /阶段总结没有完成/.test(t.message)).length, 1);
  const calls = e.state.modelCalls.length;
  assert.equal((await e.c.coreadMaybeStage()).reason, 'waiting');
  assert.equal(e.state.modelCalls.length, calls, 'no new request while nothing changed');
  e.state.model = async () => JSON.stringify({summary: '好了', keywords: ['k']});
  assert.equal((await e.c.coreadMaybeStage({retry: true})).ok, true);
  assert.equal(e.dialog().stageFailure, null);
  // 条数变了自动再看：这里没有新的一组，规划为空。
  e.dialog().slices.push(reader.normalizeCoreadSlice({id: 's5', src: 'dialog', summary: '原5', keywords: [], coveredFrom: 8, coveredTo: 9, ts: 9}));
  assert.equal((await e.c.coreadMaybeStage()).reason, 'nothing');
});

test('the automatic stage switch stops it, and a running summary makes it wait', async () => {
  const e = dialogFixture({messages: 10, slices: stageSlices(4)});
  e.state.memory.stageAuto = false;
  assert.equal((await e.c.coreadMaybeStage()).reason, 'off');
  e.state.memory.stageAuto = true;e.c.coreadDistilling = true;
  assert.equal((await e.c.coreadMaybeStage()).ok, false);
  assert.equal(e.state.modelCalls.length, 0);assert.equal(e.dialog().stages.length, 0);
});

test('a stage summary far over its limit is asked again and then refused, never cut', async () => {
  const e = dialogFixture({messages: 10, slices: stageSlices(4)});
  e.state.memory.stageChars = 100;
  e.state.model = async () => JSON.stringify({summary: '长'.repeat(151), keywords: ['k']});
  const result = await e.c.coreadMaybeStage();
  assert.equal(result.failed, true);assert.match(result.reason, /超出字数上限（151 字，上限 100 字）/);
  assert.equal(e.state.modelCalls.length, 3);assert.match(e.state.modelCalls[1].user, /请压到 100 字以内/);
  assert.equal(e.dialog().stages.length, 0);
});

test('editing a stage marks it edited; deleting it keeps its slices and stops that run from being merged again', async () => {
  const e = dialogFixture({messages: 10, slices: stageSlices(4)});
  assert.equal((await e.c.coreadMaybeStage()).ok, true);
  const id = e.dialog().stages[0].id;
  const edited = await e.c.coreadSaveStageEdit(id, '  我改的  ', '甲，乙');
  assert.equal(edited.ok, true);
  assert.deepEqual([e.dialog().stages[0].summary, e.dialog().stages[0].edited, [...e.dialog().stages[0].keywords]], ['我改的', true, ['甲', '乙']]);
  assert.equal((await e.c.coreadSaveStageEdit(id, '   ', '')).ok, false, 'empty text is refused');
  e.state.saveOk = false;
  assert.match((await e.c.coreadSaveStageEdit(id, '另一版', '')).reason, /记忆未能保存/);
  assert.equal(e.dialog().stages[0].summary, '我改的', 'a failed save rolls back');
  e.state.saveOk = true;
  assert.equal((await e.c.coreadDeleteStage(id)).ok, true);
  assert.equal(e.dialog().stages[0].status, 'deleted');assert.equal(e.dialog().slices.length, 4);
  const calls = e.state.modelCalls.length;
  assert.equal((await e.c.coreadMaybeStage()).reason, 'nothing', 'a deleted stage keeps its run from being merged again');
  assert.equal(e.state.modelCalls.length, calls);
  assert.equal((await e.c.coreadDeleteStage(id)).ok, false);
});

test('regenerating a stage rewrites it from its current slices under the same id and clears the edited mark', async () => {
  const e = dialogFixture({messages: 10, slices: stageSlices(4)});
  await e.c.coreadMaybeStage();
  const id = e.dialog().stages[0].id;
  await e.c.coreadSaveStageEdit(id, '我改的', '');
  e.dialog().slices[1].summary = '原2·改';   // 父切片改过 → 阶段停用；重新总结用改后的内容
  assert.equal(reader.coreadStageStatus(e.dialog().stages[0], e.dialog().slices), 'invalid');
  e.state.model = async () => JSON.stringify({summary: '重新合', keywords: ['新']});
  const result = await e.c.coreadRegenStage(id);
  assert.equal(result.ok, true);
  const [stage] = e.dialog().stages;
  assert.deepEqual([stage.id, stage.summary, stage.edited], [id, '重新合', false]);
  assert.equal(reader.coreadStageStatus(stage, e.dialog().slices), 'active');
  assert.match(e.state.modelCalls.at(-1).user, /2\. 原2·改/);
  e.dialog().slices = e.dialog().slices.filter((slice) => slice.id !== 's2' && slice.id !== 's3');
  assert.match((await e.c.coreadRegenStage(id)).reason, /不足两条/);
  e.c.coreadDistilling = true;
  assert.equal((await e.c.coreadRegenStage(id)).ok, false);
});

// ── 真实函数：正文蒸馏 ──
function textFixture({cap = 100, readPos = 250, slices = [], length = 400} = {}) {
  const sent = [], toasts = [], saves = [];
  let id = 0;
  const line = (n) => `第${String(n).padStart(3, '0')}行正文内容。\n`;
  const full = Array.from({length: Math.ceil(length / line(0).length)}, (_, n) => line(n)).join('').slice(0, length);
  const chapters = [{content: full.slice(0, 150)}, {content: full.slice(150)}];
  const state = {saveOk: true, failAt: -1, readPos, memory: {summaryContextChars: cap, autoDistillText: true, distillTextEvery: 1000, vectorEnabled: false}};
  const c = vm.createContext({
    coreadScheduleStage: () => {},
    reader, console, MODULE_NAME: 'fixture', AbortController, DOMException,
    readerDialog: {bookId: 'book', bucket: 'A::book', loaded: true, cursor: 0, summaryFloor: 0, slices, messages: []},
    readerView: {bookId: 'book', chapterIndex: 0, scrollRatio: 0}, readerContentCache: {bookId: 'book', chapters},
    coreadDistilling: false, coreadDistillAbort: false, coreadDistillCtl: null, coreadMemoryWrites: 0, coreadAutoTextInFlight: false,
    coreadVectorStates: new Map(), companionCharName: () => '书友', coreadUserName: () => '我', coreadSummarySystemPrompt: () => '规则',
    coreadMemory: () => state.memory, coreadBookMeta: () => ({title: '书', mode: 'text'}), coreadDialogBucket: () => 'A::book',
    coreadReadAt: () => state.readPos,
    coreadCurrentReadBoundarySync: () => ({bookId: 'book', readTo: state.readPos, chapterIndex: 0, progress: 10}),
    coreadSliceFingerprint: () => 'fp', coreadSyncSliceVector: async () => ({}), rerenderMoreIfOpen: () => {},
    blobStore: {getBook: async () => null}, uid: (prefix) => `${prefix}-${++id}`,
    toast: (message, level) => toasts.push({message, level}),
    coreadSaveDialog: async () => { saves.push(c.readerDialog.slices.length); return state.saveOk; },
    coreadDistillText: async (body) => {
      if (sent.length === state.failAt) { sent.push(null); throw new Error('HTTP 400'); }
      sent.push(body);
      return {summary: `正文${sent.length}`, keywords: ['k'], synonyms: {}};
    },
  });
  vm.runInContext(['coreadExplainError', 'coreadClampBatchChars', 'coreadBatchBudget', 'coreadDialogBatches', 'coreadTextSpanSize', 'coreadMemorySnapshot', 'coreadMemoryRestore', 'coreadNextBatch', 'coreadTextRangeMeta',
    'coreadPersistSlice', 'coreadDistillReadText', 'coreadDistillFullBook', 'coreadMaybeAutoDistillText', 'coreadProjectionOf', 'coreadTextSpans'].map(section).join('\n'), c);
  return {c, sent, toasts, saves, state, full, dialog: () => c.readerDialog};
}
const textSlices = (dialog) => dialog.slices.filter((slice) => slice.src === 'text').map((slice) => [slice.coveredFrom, slice.coveredTo]).sort((a, b) => a[0] - b[0]);
function assertTextTiles(e, from, to) {
  const covered = textSlices(e.dialog());
  assert.equal(covered[0][0], from);assert.equal(covered.at(-1)[1], to);
  covered.forEach(([start], i) => { if (i) assert.equal(start, covered[i - 1][1]); });
  return covered;
}

test('read-text distill covers the whole unread span in batches that each record exactly what was sent', async () => {
  const e = textFixture({cap: 0, readPos: 2500, length: 4000});
  const result = await e.c.coreadDistillReadText(e.state.memory);
  assert.equal(result.ok, true);
  const covered = assertTextTiles(e, 0, 2500);
  assert.ok(covered.length > 1);assert.equal(result.made, covered.length);
  // 送出的各批（模型侧会去首尾空白）与登记范围一一对应，合起来就是 0–250 的全部正文。
  e.dialog().slices.forEach((slice, i) => {
    assert.equal(e.sent[i], e.full.slice(slice.coveredFrom, slice.coveredTo));
    assert.ok(e.sent[i].length <= 1000, 'one batch is at most 正文每多少字总结一次 characters');
    assert.equal(slice.provenance.charFrom, slice.coveredFrom);assert.equal(slice.provenance.charTo, slice.coveredTo);
    assert.equal(slice.provenance.readTo, slice.coveredTo);
  });
  assert.equal(e.sent.join(''), e.full.slice(0, 2500));
  assert.equal(e.saves.length, covered.length);
});

test('read-text distill stops at a failed batch or a failed save without claiming the rest', async () => {
  const e = textFixture({cap: 0, readPos: 2500, length: 4000});
  e.state.failAt = 1;
  const failed = await e.c.coreadDistillReadText(e.state.memory);
  assert.equal(failed.ok, false);assert.equal(failed.made, 1);
  assert.equal(e.dialog().slices.length, 1);
  const firstEnd = e.dialog().slices[0].coveredTo;
  e.state.failAt = -1;e.state.saveOk = false;
  const unsaved = await e.c.coreadDistillReadText(e.state.memory);
  assert.equal(unsaved.ok, false);assert.match(unsaved.reason, /记忆未能保存，请重试/);assert.equal(unsaved.made, 0);
  assert.equal(e.dialog().slices.length, 1);
  e.state.saveOk = true;
  assert.equal((await e.c.coreadDistillReadText(e.state.memory)).ok, true);
  assert.equal(assertTextTiles(e, 0, 2500)[1][0], firstEnd, 'the next run resumes exactly where the saved coverage ends');
});

test('after a full-book pass the incremental distill says there is nothing to do, and still fills uncovered ranges', async () => {
  const covered = (from, to) => reader.normalizeCoreadSlice({id: `t${from}`, batch: 1, src: 'text', summary: '全书', keywords: [], coveredFrom: from, coveredTo: to, ts: 1});
  const done = textFixture({readPos: 250, slices: [covered(0, 400)]});
  const idle = await done.c.coreadDistillReadText(done.state.memory);
  assert.equal(idle.ok, false);assert.equal(idle.reason, '已读内容都已总结过了');assert.equal(done.sent.length, 0);
  // 全书蒸馏里失败的一段（100–200）仍可由增量蒸馏补上，且不重蒸已覆盖部分。
  const holed = textFixture({cap: 1000, readPos: 250, slices: [covered(0, 100), covered(200, 400)]});
  const filled = await holed.c.coreadDistillReadText(holed.state.memory);
  assert.equal(filled.ok, true);assert.equal(filled.made, 1);
  assert.deepEqual(holed.sent, [holed.full.slice(100, 200)]);
  assert.deepEqual(textSlices(holed.dialog()), [[0, 100], [100, 200], [200, 400]]);
  // 自动蒸馏按「已读而未覆盖」的字数判断阈值。
  holed.state.memory.distillTextEvery = 1000;
  await holed.c.coreadMaybeAutoDistillText();
  assert.equal(holed.sent.length, 1, 'nothing uncovered: automatic distill stays idle');
  const auto = textFixture({cap: 0, readPos: 1500, length: 2000, slices: [covered(0, 400)]});
  await auto.c.coreadMaybeAutoDistillText();
  const autoTiles = textSlices(auto.dialog());
  assert.equal(autoTiles.length, 3, 'same ruler as manual: the 1100 new characters become two batches of at most 1000');
  assert.deepEqual([autoTiles[1][0], autoTiles.at(-1)[1]], [400, 1500]);assert.equal(autoTiles[2][0], autoTiles[1][1]);
  assert.equal(auto.c.coreadAutoTextInFlight, false);
});

test('full-book distill uses the same ruler as reading, never cuts a chunk after sizing it, even under a small cap', async () => {
  const e = textFixture({cap: 1200, length: 4000});
  const result = await e.c.coreadDistillFullBook(e.state.memory, false);
  assert.equal(result.ok, true);
  const covered = assertTextTiles(e, 0, 4000);
  assert.equal(result.made, covered.length);assert.ok(covered.length >= 4);
  e.dialog().slices.forEach((slice, i) => {
    assert.equal(e.sent[i], e.full.slice(slice.coveredFrom, slice.coveredTo));
    assert.ok(e.sent[i].length <= 1000);
  });
  assert.equal(e.sent.join(''), e.full);
  assert.equal(e.saves.length, covered.length, 'each chunk is saved as it is made');
});

test('full-book distill stops and reports when a chunk cannot be saved', async () => {
  const e = textFixture({cap: 1200, length: 4000});
  e.state.saveOk = false;
  const result = await e.c.coreadDistillFullBook(e.state.memory, false);
  assert.equal(result.ok, false);assert.match(result.reason, /记忆未能保存，请重试/);assert.equal(result.made, 0);
  assert.equal(e.dialog().slices.length, 0);assert.equal(e.sent.length, 1);assert.equal(e.c.coreadDistilling, false);
});

test('text distills refuse to start while a slice mutation is in progress', async () => {
  const e = textFixture();
  e.c.coreadMemoryWrites = 1;
  assert.equal((await e.c.coreadDistillReadText(e.state.memory)).ok, false);
  assert.equal((await e.c.coreadDistillFullBook(e.state.memory, false)).ok, false);
  assert.equal(e.sent.length, 0);assert.equal(e.c.coreadDistilling, false);
});

test('the model-facing builders no longer cut what a slice claims to cover', () => {
  for (const name of ['coreadDistillSegment', 'coreadDistillText', 'coreadDistillReadText', 'coreadDistillFullBook']) {
    assert.doesNotMatch(section(name), /较早内容略|\.slice\(-/, name);
  }
});

test('automatic text distill handles at most two batches per trigger; a manual run has no such limit', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(new URL('../index.js', import.meta.url), 'utf8');
  assert.match(source, /async function coreadDistillReadText\(m, \{ maxBatches = Infinity \} = \{\}\) \{/);
  assert.match(source, /gaps\.flatMap\(\(gap\) => coreadTextSpans\(projection, gap, cap\)\)\.slice\(0, maxBatches\);/);
  const auto = source.slice(source.indexOf('async function coreadMaybeAutoDistillText'));
  assert.match(auto.slice(0, 1500), /coreadDistillReadText\(m, \{ maxBatches: 2 \}\)/);
  assert.match(source, /coreadDistillReadText\(m\)\.then\(/, 'the manual button distills everything that is pending');
});

test('running full-book distill twice makes no duplicate slices, and a later run only fills what is missing', async () => {
  const e = textFixture({cap: 1200, length: 4000});
  assert.equal((await e.c.coreadDistillFullBook(e.state.memory)).ok, true);
  const first = e.dialog().slices.length, sentBefore = e.sent.length;
  const again = await e.c.coreadDistillFullBook(e.state.memory);
  assert.equal(again.ok, false); assert.equal(again.reason, '全书都已总结过了');
  assert.equal(e.dialog().slices.length, first); assert.equal(e.sent.length, sentBefore, 'no request is sent the second time');
  // 删掉中间一条后再点：只补这一段。
  const removed = e.dialog().slices.splice(1, 1)[0];
  const refill = await e.c.coreadDistillFullBook(e.state.memory);
  assert.equal(refill.ok, true); assert.equal(refill.made, 1);
  assert.equal(e.sent.at(-1), e.full.slice(removed.coveredFrom, removed.coveredTo));
  assertTextTiles(e, 0, 4000);
});
