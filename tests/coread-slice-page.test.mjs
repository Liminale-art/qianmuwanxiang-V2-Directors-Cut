import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import * as reader from '../qianmu-reader.js';
import { storyboardFunctionSource as section } from './helpers/storyboard-form-fixture.mjs';

// 记忆子页的真实模板：页签、阶段行里嵌着它合并的细切片、没进阶段的切片单列。
const dialog = (i) => reader.normalizeCoreadSlice({ id: `d${i}`, batch: i + 1, src: 'dialog', summary: `对话记忆${i}`, keywords: [`k${i}`],
  coveredFrom: i * 2, coveredTo: i * 2 + 1, ts: 100 + i, provenance: { source: 'dialog', readTo: 10 } });
const book = (i) => reader.normalizeCoreadSlice({ id: `b${i}`, batch: 20 + i, src: 'text', summary: `正文记忆${i}`, keywords: [],
  coveredFrom: i * 100, coveredTo: i * 100 + 100, ts: 200 + i, provenance: { source: 'book', chapterFrom: 0, chapterTo: 0 } });
function page({ slices, stages = [], filter = 'all' }) {
  const c = vm.createContext({
    reader, readerDialog: { bookId: 'book', bucket: 'A::book', slices, stages, readBoundary: { readTo: 1e9 } },
    coreadMemory: () => ({ vectorEnabled: false, spoilerProtection: true }), coreadBookMeta: () => ({ title: '某书' }),
    coreadCurrentReadBoundarySync: () => ({ readTo: 1e9 }), coreadVecCache: null, coreadVectorStates: new Map(),
    coreadSliceFingerprint: reader.coreadSliceFingerprint,
    htmlEscape: (value) => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;'),
  });
  vm.runInContext(['coreadNormalizeSlices', 'coreadSliceSourceLabel', 'coreadSliceSourceClass', 'coreadSliceCoverageText', 'renderCoreadSubpageHead',
    'coreadVectorState', 'renderCoreadSliceRow', 'renderCoreadStageRow', 'renderCoreadSlicePage'].map(section).join('\n'), c);
  vm.runInContext(`coreadSliceFilter = ${JSON.stringify(filter)};`, c);
  return c.renderCoreadSlicePage();
}
const ids = (html, attr) => [...html.matchAll(new RegExp(`${attr}="([^"]+)"`, 'g'))].map((m) => m[1]);

test('the memory page lists loose slices, then stages with the slices they merged nested inside', () => {
  const slices = [...[0, 1, 2, 3].map(dialog), book(0)];
  const stage = reader.buildCoreadStage(slices.slice(0, 3), { summary: '阶段<一>' }, { id: 'st1', now: 1 });
  const html = page({ slices, stages: [stage] });
  assert.match(html, /某书 · 5 条 · 1 条阶段/);
  const tabs = [...html.matchAll(/data-filter="(\w+)" aria-pressed="(\w+)">([^<]+)<\/button>/g)].map((m) => [m[1], m[2], m[3]]);
  assert.deepEqual(tabs, [['all', 'true', '全部 5'], ['dialog', 'false', '共读交流 4'], ['book', 'false', '书中内容 1'], ['stage', 'false', '阶段总结 1']]);
  const stageRow = html.slice(html.indexOf('data-stage-id="st1"'));
  assert.deepEqual(ids(stageRow, 'data-id'), ['d0', 'd1', 'd2'], 'merged slices sit inside the stage, oldest first');
  const loose = html.slice(0, html.indexOf('data-stage-id="st1"'));
  assert.deepEqual(ids(loose, 'data-id'), ['b0', 'd3'], 'slices not in any stage are listed on their own, newest first');
  assert.match(stageRow, /阶段&lt;一&gt;|阶段&lt;一>/);assert.match(stageRow, /合 3 条/);
  assert.match(stageRow, /sd-reader-st-save">保存<\/button><button type="button" class="sd-reader-textbtn sd-reader-st-regen">重新总结<\/button>/);
  assert.match(html, /sd-reader-sm-regen">重新总结<\/button>/);assert.doesNotMatch(html, /重构/);
});

test('filters show one kind; a changed slice marks its stage as stopped; deleted stages disappear and free their slices', () => {
  const slices = [0, 1, 2].map(dialog);
  const stage = reader.buildCoreadStage(slices, { summary: '阶段' }, { id: 'st1', now: 1 });
  assert.deepEqual(ids(page({ slices, stages: [stage], filter: 'dialog' }), 'data-id'), ['d2', 'd1', 'd0'], 'the kind filter lists every slice flat');
  assert.deepEqual(ids(page({ slices, stages: [stage], filter: 'stage' }), 'data-stage-id'), ['st1']);
  const changed = slices.map((s) => (s.id === 'd1' ? { ...s, summary: '改过' } : s));
  assert.match(page({ slices: changed, stages: [stage] }), /is-invalid[\s\S]*已停用/);
  const gone = page({ slices, stages: [{ ...stage, status: 'deleted' }] });
  assert.equal(ids(gone, 'data-stage-id').length, 0);
  assert.deepEqual(ids(gone, 'data-id'), ['d2', 'd1', 'd0']);
  assert.match(page({ slices, stages: [], filter: 'stage' }), /还没有阶段总结。/);
});
