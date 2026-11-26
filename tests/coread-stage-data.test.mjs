import test from 'node:test';
import assert from 'node:assert/strict';
import * as reader from '../qianmu-reader.js';
import { portableJson } from '../qianmu-account-mirror.js';

const {
  COREAD_STAGE_DEFAULTS, coreadSliceFingerprint, coreadStagePosition, planCoreadStages,
  buildCoreadStage, normalizeCoreadStages, coreadStageStatus, coreadRecallPool, normalizeCoreadSlice,
} = reader;

// 对话切片：每条覆盖 2 条消息，第 i 条覆盖 [2i, 2i+1]，知情水位都在 1000 以内。
const dialog = (i, extra = {}) => normalizeCoreadSlice({
  id: `d${i}`, src: 'dialog', summary: `对话${i}`, keywords: [`k${i}`], coveredFrom: i * 2, coveredTo: i * 2 + 1,
  ts: 1000 + i, provenance: { source: 'dialog', readTo: 500 + i, createdAt: 1000 + i }, ...extra,
});
// 正文切片：每条覆盖 100 字，[100i, 100i+100)。
const book = (i, extra = {}) => normalizeCoreadSlice({
  id: `b${i}`, src: 'text', summary: `正文${i}`, keywords: [`t${i}`], coveredFrom: i * 100, coveredTo: i * 100 + 100,
  chapterFrom: 0, chapterTo: 0, ts: 2000 + i, provenance: { source: 'book', createdAt: 2000 + i }, ...extra,
});
const range = (n, make) => Array.from({ length: n }, (_, i) => make(i));
const far = { readTo: 1e9 };

test('factory defaults are the values the user set: 100 per stage, latest 20 kept, 800 characters', () => {
  assert.deepEqual({ ...COREAD_STAGE_DEFAULTS }, { trigger: 100, keep: 20, chars: 800 });
});

test('the fingerprint keeps the exact format of the stored vector fingerprints', () => {
  // 与改动前 index.js 里的实现逐字一致（summary 与 keywords 之间是 \u0001），旧向量缓存不会被判成已变。
  const old = s => { const text = `${s.summary || ''}\u0001${(s.keywords || []).join(',')}`; let h = 5381;
    for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) >>> 0; return `${text.length}_${h.toString(36)}`; };
  for (const s of [{ summary: '甲', keywords: ['a', 'b'] }, { summary: '' }, { keywords: ['x'] }]) assert.equal(coreadSliceFingerprint(s), old(s));
  assert.notEqual(coreadSliceFingerprint({ summary: 'ab', keywords: [] }), coreadSliceFingerprint({ summary: 'a', keywords: ['b'] }));
});

test('only plain dialog and single-source book slices can join a stage', () => {
  assert.deepEqual(coreadStagePosition(dialog(3)), { source: 'dialog', from: 6, to: 7 });
  assert.equal(coreadStagePosition(book(2)).from, 200);
  assert.equal(coreadStagePosition({ ...dialog(1), compressed: true }), null, 'old merged slice');
  assert.equal(coreadStagePosition({ id: 'm', src: 'mixed', summary: 'x', provenance: { source: 'mixed', sources: ['dialog', 'book'] } }), null);
  assert.equal(coreadStagePosition({ id: 'l', src: 'mainline', summary: 'x', provenance: { source: 'mainline' } }), null);
  assert.equal(coreadStagePosition({ ...dialog(1), provenance: { ...dialog(1).provenance, dialogArchived: true } }), null, 'archived dialog');
  // 漫画：字符位为空时按页判连续。
  const comic = normalizeCoreadSlice({ id: 'c', src: 'text', summary: 'x', coveredFrom: 0, coveredTo: 0, provenance: { source: 'book', chapterFrom: 3, chapterTo: 5 } });
  assert.deepEqual(coreadStagePosition(comic), { source: 'book', pages: true, from: 3, to: 5, chapterFrom: 3, chapterTo: 5 });
});

test('a stage forms only when enough older slices are waiting; the latest ones are kept out', () => {
  const opts = { trigger: 10, keep: 4, boundary: far };
  assert.equal(planCoreadStages(range(13, dialog), [], opts).length, 0, '13 − 4 kept = 9 < 10');
  const [group, ...rest] = planCoreadStages(range(14, dialog), [], opts);
  assert.equal(rest.length, 0);
  assert.equal(group.source, 'dialog');
  assert.deepEqual(group.parents.map(s => s.id), range(10, i => `d${i}`));
  assert.deepEqual(group.replaces, []);
  // 默认值：120 条才出第一组（100 条合、最近 20 条不合）。
  assert.equal(planCoreadStages(range(119, dialog), [], { boundary: far }).length, 0);
  assert.equal(planCoreadStages(range(120, dialog), [], { boundary: far })[0].parents.length, 100);
});

test('dialog and book slices are grouped separately and never mixed', () => {
  const slices = [...range(12, dialog), ...range(12, book)];
  const groups = planCoreadStages(slices, [], { trigger: 10, keep: 2, boundary: far });
  assert.deepEqual(groups.map(g => g.source).sort(), ['book', 'dialog']);
  for (const g of groups) assert.ok(g.parents.every(s => coreadStagePosition(s).source === g.source));
});

test('a gap in coverage breaks the run; slices are ordered by position, not by storage order', () => {
  const withGap = range(12, dialog).filter(s => s.id !== 'd5');
  assert.equal(planCoreadStages(withGap, [], { trigger: 6, keep: 0, boundary: far }).length, 1, 'd6–d11 only');
  assert.deepEqual(planCoreadStages(withGap, [], { trigger: 6, keep: 0, boundary: far })[0].parents.map(s => s.id), ['d6', 'd7', 'd8', 'd9', 'd10', 'd11']);
  const shuffled = range(6, dialog).reverse();
  assert.deepEqual(planCoreadStages(shuffled, [], { trigger: 6, keep: 0, boundary: far })[0].parents.map(s => s.id), range(6, i => `d${i}`));
});

test('slices already in an active, user-deleted or user-edited stage stay out; an untouched invalid stage gives its slices back', () => {
  const slices = range(12, dialog);
  const stage = (status, edited = false) => buildCoreadStage(slices.slice(0, 6), { summary: 's' }, { id: `st-${status}`, now: 1 });
  const opts = { trigger: 6, keep: 0, boundary: far };
  const active = stage('active');
  assert.deepEqual(planCoreadStages(slices, [active], opts).map(g => g.parents[0].id), ['d6']);
  assert.deepEqual(planCoreadStages(slices, [{ ...active, status: 'deleted' }], opts).map(g => g.parents[0].id), ['d6']);
  // 父切片 d2 被改过 → 阶段失效。
  const changed = slices.map(s => s.id === 'd2' ? { ...s, summary: '改过' } : s);
  assert.equal(coreadStageStatus(active, changed), 'invalid');
  const rebuilt = planCoreadStages(changed, [active], opts);
  assert.deepEqual(rebuilt.map(g => [g.parents[0].id, g.replaces]), [['d0', [active.id]], ['d6', []]]);
  // 用户改过的失效阶段不自动重建，切片也不让出。
  assert.deepEqual(planCoreadStages(changed, [{ ...active, edited: true }], opts).map(g => g.parents[0].id), ['d6']);
});

test('only slices visible at the current reading position are merged', () => {
  const slices = range(12, dialog);   // readTo = 500 + i
  const groups = planCoreadStages(slices, [], { trigger: 6, keep: 0, boundary: { readTo: 506 } });
  assert.deepEqual(groups.map(g => g.parents.map(s => s.id)), [range(6, i => `d${i}`)], 'd7+ read further than now');
  assert.equal(planCoreadStages(slices, [], { trigger: 6, keep: 0, boundary: {} }).length, 0, 'no reading position: protect');
  assert.equal(planCoreadStages(slices, [], { trigger: 6, keep: 0, boundary: {}, protection: false }).length, 2);
});

test('the capacity cap takes the prefix that fits and leaves the rest for later', () => {
  const slices = range(10, i => dialog(i, { summary: 'x'.repeat(10) }));
  const [group] = planCoreadStages(slices, [], { trigger: 10, keep: 0, boundary: far, cap: 45, joinCost: 1 });
  assert.equal(group.parents.length, 4, '10+1+10+1+10+1+10 = 43 ≤ 45, a fifth would be 54');
  assert.equal(planCoreadStages(slices, [], { trigger: 10, keep: 0, boundary: far, cap: 15 }).length, 0, 'a single slice is not a stage');
});

test('a built stage records its parents, positions and the latest knowledge point', () => {
  const parents = range(3, dialog);
  const stage = buildCoreadStage(parents, { summary: '阶段', keywords: ['甲'], synonyms: { 甲: ['乙'] } }, { id: 'stage1', now: 99 });
  assert.equal(stage.stage, true);
  assert.equal(stage.src, 'dialog');
  assert.deepEqual([stage.coveredFrom, stage.coveredTo], [0, 5]);
  assert.deepEqual([stage.provenance.dialogFrom, stage.provenance.dialogTo, stage.provenance.readTo], [0, 5, 502]);
  assert.deepEqual(stage.parents, parents.map(s => ({ id: s.id, fp: coreadSliceFingerprint(s) })));
  assert.equal(coreadStageStatus(stage, parents), 'active');
  assert.equal(coreadStagePosition(stage), null, 'a stage never joins another stage');
  const bookStage = buildCoreadStage(range(3, book), { summary: 'b' }, { id: 'stage2', now: 1 });
  assert.deepEqual([bookStage.coveredFrom, bookStage.coveredTo, bookStage.provenance.readTo], [0, 300, 300], 'book boundary is the last character');
  assert.throws(() => buildCoreadStage([dialog(0), book(0)].map(s => ({ ...s, compressed: true })), { summary: 'x' }, { id: 'x' }));
  assert.throws(() => buildCoreadStage(parents, { summary: 'x' }, {}), /编号/);
  // 账户镜像与整包都按纯 JSON 带走整份记录：阶段字段必须能原样过 portableJson。
  const record = { slices: parents, stages: [stage, bookStage] };
  assert.deepEqual(JSON.parse(portableJson(record)).stages, JSON.parse(JSON.stringify(record.stages)));
});

test('old records without stages read as empty, broken entries are dropped and unknown states become active', () => {
  assert.deepEqual(normalizeCoreadStages(undefined), []);
  const [kept] = normalizeCoreadStages([null, { summary: 'no id' }, { id: 's', summary: 'ok', status: 'weird', parents: [{ id: 'd0', fp: 'x' }, { fp: 'y' }] }]);
  assert.equal(kept.status, 'active');
  assert.deepEqual(kept.parents, [{ id: 'd0', fp: 'x' }]);
  assert.equal(coreadStageStatus({ ...kept, parents: [] }, []), 'invalid');
});

test('recall pool: an active visible stage stands in for its slices; hidden or invalid stages fall back to the slices', () => {
  const slices = range(8, dialog);
  const stage = buildCoreadStage(slices.slice(0, 4), { summary: '阶段' }, { id: 'st', now: 1 });   // readTo 503
  const ids = pool => pool.map(s => s.id);
  assert.deepEqual(ids(coreadRecallPool(slices, [stage], far)), ['st', 'd4', 'd5', 'd6', 'd7']);
  // 读位回退到 502：阶段（知道到 503）被隔离，仍可见的 d0–d2 回到池里。
  assert.deepEqual(ids(coreadRecallPool(slices, [stage], { readTo: 502 })), ['d0', 'd1', 'd2']);
  const edited = slices.map(s => s.id === 'd1' ? { ...s, summary: '改' } : s);
  assert.deepEqual(ids(coreadRecallPool(edited, [stage], far)), range(8, i => `d${i}`));
  assert.deepEqual(ids(coreadRecallPool(slices, [{ ...stage, status: 'deleted' }], far)), range(8, i => `d${i}`));
});
