import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  calculateCoreadDialogCursor,
  expandCoreadDialogRange,
} from '../qianmu-reader.js';

const linkedSlices = [
  { id: 'a', src: 'dialog', coveredFrom: 4, coveredTo: 6 },
  { id: 'b', src: 'dialog', coveredFrom: 1, coveredTo: 4 },
  { id: 'c', src: 'dialog', coveredFrom: 6, coveredTo: 8 },
  { id: 'book', src: 'text', coveredFrom: 0, coveredTo: 999 },
  { id: 'mainline', src: 'mainline', coveredFrom: 0, coveredTo: 999 },
];

const expanded = expandCoreadDialogRange(linkedSlices, 5, 5);
assert.equal(expanded.from, 1, '重叠闭包应继续向左吸收二次命中的切片');
assert.equal(expanded.to, 8, '重叠闭包应继续向右吸收二次命中的切片');
assert.deepEqual(expanded.overlaps.map((slice) => slice.id), ['b', 'a', 'c']);
assert.ok(!expanded.overlaps.some((slice) => slice.id === 'book' || slice.id === 'mainline'), '对谈重整不得误删其它来源');

const disjoint = [
  { id: 'first', src: 'dialog', coveredFrom: 0, coveredTo: 3 },
  { id: 'later', src: 'dialog', coveredFrom: 6, coveredTo: 8 },
];
assert.equal(calculateCoreadDialogCursor(disjoint, 12, 0), 4, 'cursor 必须停在首个未覆盖空洞前');
assert.equal(calculateCoreadDialogCursor([...disjoint, { id: 'bridge', src: 'dialog', coveredFrom: 4, coveredTo: 5 }], 12, 0), 9, '补齐空洞后才可继续推进');
assert.equal(calculateCoreadDialogCursor([{ id: 'later', src: 'dialog', coveredFrom: 5, coveredTo: 7 }], 12, 5), 8, '清空历史后的 summaryFloor 应作为连续覆盖起点');
assert.equal(calculateCoreadDialogCursor([{
  id: 'mixed',
  src: 'mixed',
  coveredFrom: 0,
  coveredTo: 100,
  provenance: { source: 'mixed', sources: ['dialog', 'book'], dialogFrom: 0, dialogTo: 4 },
}], 12, 0), 5, '跨来源压缩后必须保留明确的对谈覆盖水位');
assert.equal(calculateCoreadDialogCursor([{
  id: 'archived',
  src: 'dialog',
  coveredFrom: 0,
  coveredTo: 20,
  provenance: { source: 'dialog', dialogFrom: 0, dialogTo: 20, dialogArchived: true },
}], 4, 0), 0, '保留的旧对谈记忆不得占用重新导入后的新对话进度');

const source = await readFile(new URL('../index.js', import.meta.url), 'utf8');
const manual = source.slice(source.indexOf('async function coreadManualSummarize'), source.indexOf('// 切片按 coveredFrom'));
assert.match(manual, /expandCoreadDialogRange/, '后端必须自行重算完整重叠闭包，不能只依赖前端确认值');
assert.doesNotMatch(manual, /Math\.max\(to \+ 1, Number\(readerDialog\.cursor\)/, '手动总结不得按最大下标跳过前方空洞');
assert.match(manual, /coreadReplaceDialogRange/, '手动总结必须使用统一的安全替换事务');
const replace = source.slice(source.indexOf('async function coreadReplaceDialogRange'), source.indexOf('// ── 切片来源'));
assert.ok(replace.indexOf('coreadDistillSegment') < replace.indexOf('coreadPersistSlice'), '应先取得有效模型结果再落地新切片');
assert.ok(replace.indexOf('coreadPersistSlice') < replace.indexOf('coreadRemoveSliceMirrors'), '新切片落地前不得删除旧镜像');
assert.match(replace, /coreadRecalculateDialogCursor/, '替换完成后必须按连续覆盖重新计算进度');
const auto = source.slice(source.indexOf('async function coreadDistill(manual'), source.indexOf('// 手动总结'));
assert.match(auto, /coreadReplaceDialogRange/, '自动总结也必须安全替换后段手动切片，不能生成重叠记忆');

const compress = source.slice(source.indexOf('async function coreadCompressSlices'), source.indexOf('// 重新生成某条已有切片'));
assert.ok(compress.indexOf('coreadPersistSlice') < compress.indexOf('coreadRemoveSliceMirrors'), '二次总结也必须先写新切片再清旧切片');
assert.match(compress, /dialogFrom:[\s\S]*dialogTo:/, '融合切片必须保存对谈来源的独立覆盖范围');

const vector = source.slice(source.indexOf('async function coreadEnsureVectors'), source.indexOf('// 向量召回'));
assert.match(vector, /coreadWithRetry\(`vector:\$\{item\.s\.id\}`/, '每条切片必须使用独立向量重试与熔断键');
const edit = source.slice(source.indexOf('async function coreadSaveSliceEdit'), source.indexOf('// 删除单条切片'));
assert.match(edit, /coreadSyncSliceVector\(sliceId/, '任意切片编辑入口都必须触发向量同步');

assert.match(source, /summaryFloor: readerDialog\.summaryFloor/, '对话总结基准必须随档案持久化');
assert.match(source, /summaryFloor = \(readerDialog\.messages \|\| \[\]\)\.length/, '清空记忆时必须显式记录不再重蒸旧对话的基准');
assert.match(source, /coreadClearBookDialogue[\s\S]*coreadArchiveDialogSlices/, '删书但保留记忆时必须把旧对谈切片归档而非复用消息下标');

console.log('Coread memory lifecycle contract OK');
