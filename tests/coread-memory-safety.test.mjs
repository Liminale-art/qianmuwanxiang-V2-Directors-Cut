import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  COREAD_SLICE_SCHEMA_VERSION,
  chapterIndexAtOffset,
  filterCoreadSlicesAtBoundary,
  isCoreadSliceVisibleAtBoundary,
  normalizeCoreadSlice,
  normalizeCoreadSource,
} from '../qianmu-reader.js';

assert.equal(COREAD_SLICE_SCHEMA_VERSION, 3);
assert.equal(normalizeCoreadSource('text'), 'book');
assert.equal(normalizeCoreadSource('mainline'), 'mainline');
assert.equal(normalizeCoreadSource('dialog'), 'dialog');

const legacyBook = normalizeCoreadSlice({
  id: 'book-future',
  src: 'text',
  coveredFrom: 500,
  coveredTo: 900,
  summary: '后文章节',
  provenance: { readTo: 100 },
}, { bookId: 'book-1', bucket: 'chat::book-1', boundary: { readTo: 600, chapterIndex: 1, progress: 30 } });

assert.equal(legacyBook.provenance.source, 'book');
assert.equal(legacyBook.provenance.readTo, 900, '正文切片必须以实际覆盖终点为知识水位，不能被当前进度降级');
assert.equal(isCoreadSliceVisibleAtBoundary(legacyBook, { readTo: 899 }, true), false);
assert.equal(isCoreadSliceVisibleAtBoundary(legacyBook, { readTo: 900 }, true), true);

const dialog = normalizeCoreadSlice({
  id: 'dialog-1',
  src: 'dialog',
  coveredFrom: 2,
  coveredTo: 5,
  provenance: { dialogMessageIds: ['m2', 'm5', 'm5'] },
}, { bookId: 'book-1', bucket: 'chat::book-1', boundary: { readTo: 420, chapterIndex: 1, progress: 21 } });

assert.equal(dialog.provenance.readTo, 420);
assert.deepEqual(dialog.provenance.dialogMessageIds, ['m2', 'm5']);
assert.equal(isCoreadSliceVisibleAtBoundary(dialog, { readTo: 400 }, true), false);
assert.equal(isCoreadSliceVisibleAtBoundary(dialog, { readTo: 400 }, false), true);

const mainline = normalizeCoreadSlice({
  id: 'mainline-1',
  src: 'mainline',
  mainlineFloors: [12, 3, 12, 0, '7'],
}, { boundary: { readTo: 420 } });
assert.deepEqual(mainline.provenance.mainlineFloors, [3, 7, 12]);

const safe = filterCoreadSlicesAtBoundary([legacyBook, dialog, mainline], { readTo: 500 }, true);
assert.deepEqual(safe.map((slice) => slice.id), ['dialog-1', 'mainline-1']);
assert.equal(filterCoreadSlicesAtBoundary([legacyBook], { readTo: 1 }, false).length, 1);
assert.equal(isCoreadSliceVisibleAtBoundary(dialog, { readTo: null }, true), false, '开启保护时未知阅读水位必须保守隔离');

const chapters = [{ content: '12345' }, { content: '678' }, { content: '90' }];
assert.equal(chapterIndexAtOffset(chapters, 0), 0);
assert.equal(chapterIndexAtOffset(chapters, 5), 1);
assert.equal(chapterIndexAtOffset(chapters, 99), 2);

const source = await readFile(new URL('../index.js', import.meta.url), 'utf8');
assert.ok(source.includes('spoilerProtection: true'), '防剧透记忆过滤必须默认开启');
assert.match(source, /buildCompanionContext[\s\S]*coreadSafeSlices\(readerDialog\.slices[\s\S]*coreadRetrieveHits\(recallQuery[\s\S]*recallPool/, '伴读召回入口必须使用已按阅读水位过滤的池');
assert.match(source, /async function coreadMainlinePool[\s\S]*coreadResolveReadBoundary\(bookId\)[\s\S]*coreadSafeSlices/, '正文反哺的每个档案必须按对应书籍水位过滤');
assert.ok(source.includes('sliceSchemaVersion: reader.COREAD_SLICE_SCHEMA_VERSION'), '持久化记录必须带切片模式版本');
assert.ok(source.includes('正文楼层 ${provenance.mainlineFloors.map'), '正文来源只显示保存的楼层号');

console.log('Coread memory safety contract OK');
