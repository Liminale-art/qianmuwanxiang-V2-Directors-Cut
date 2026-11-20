import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import * as reader from '../qianmu-reader.js';
import * as comic from '../qianmu-reader-comic.js';
import { READER_CHAT_INDEX_SLOT } from '../qianmu-reader-chat-sync.js';
import { applyCoreadPackageData, createCoreadImportProgress } from '../qianmu-reader-package.js';
import { storyboardFunctionSource as section } from './helpers/storyboard-form-fixture.mjs';
import { createCoreadRecordsFixture } from './helpers/coread-center-fixture.mjs';

const read = (name) => readFile(new URL(`../${name}`, import.meta.url), 'utf8');
const empty = () => comic.normalizeComicRecord(null, 'book');
const described = (...ranges) => {
  let record = empty();
  for (const [from, to] of ranges) record = comic.applyComicBatch(record, { from, to }, { pages: {}, summary: `第${from + 1}到${to + 1}页`, keywords: ['k'], cast: [] }, { now: from + 1 });
  return record;
};
const reply = (from, to, extra = {}) => ({
  pages: Array.from({ length: to - from + 1 }, (_, i) => ({ page: from + 1 + i, panels: `第${from + 1 + i}页画面`, dialogue: [{ speaker: '甲', text: `台词${from + 1 + i}` }] })),
  summary: `总结${from + 1}-${to + 1}`, keywords: ['甲', '学校', '转学'], cast: [{ name: '甲', look: '黑色短发' }], ...extra,
});

// ── 纯逻辑：记录形状 ──
test('the module is re-exported through the lazily loaded reader module and listed for release', async () => {
  for (const name of Object.keys(comic)) assert.equal(reader[name], comic[name], name);
  const release = JSON.parse(await read('release-files.json'));
  assert.ok(release.files.includes('qianmu-reader-comic.js'));
});

test('record validation: fixed shape, bad input dropped, never throws', () => {
  for (const raw of [null, undefined, 'x', 7, [], { pages: 'x', segments: 'x', cast: 'x', lastBatch: 'x' }]) {
    assert.deepEqual(comic.normalizeComicRecord(raw, 'book'), { kind: 'comic', version: 1, bookId: 'book', direction: 'rtl', cast: [], pages: {}, segments: [], lastBatch: null });
  }
  const record = comic.normalizeComicRecord({
    bookId: 'b', direction: 'ttb',
    cast: [{ name: ' 甲 ', look: '短发', edited: true }, { name: '甲', look: '重复' }, { look: '无名' }, 'x'],
    pages: { 2: { panels: ' 画面 ', dialogue: ['乙：你好', { speaker: '', text: '谁' }, { text: '' }] }, 0: { panels: 'x' }, x: { panels: 'x' }, 3: { panels: '', dialogue: [] }, 4: 'bad' },
    segments: [{ fromPage: 4, toPage: 6, summary: '后' }, { fromPage: 1, toPage: 3, summary: '前', keywords: ['a', 'a', ''] }, { fromPage: 3, toPage: 5, summary: '重叠' },
      { fromPage: 7, toPage: 6, summary: '反了' }, { fromPage: 8, toPage: 8, summary: '  ' }, null],
    lastBatch: { images: 3, at: 5, input: 100, output: 'x' },
  }, 'ignored');
  assert.equal(record.bookId, 'b'); assert.equal(record.direction, 'ttb');
  assert.deepEqual(record.cast, [{ name: '甲', look: '短发', edited: true }]);
  assert.deepEqual(record.pages, { 2: { panels: '画面', dialogue: [{ speaker: '乙', text: '你好' }, { speaker: '？', text: '谁' }], updatedAt: 0 } });
  assert.deepEqual(record.segments.map((item) => [item.fromPage, item.toPage, item.summary]), [[1, 3, '前'], [4, 6, '后']], 'sorted, overlapping and invalid segments dropped');
  assert.deepEqual(record.segments[0].keywords, ['a']);
  assert.deepEqual(record.lastBatch, { images: 3, at: 5, input: 100 });
  assert.deepEqual(comic.normalizeComicRecord(record, 'b'), record, 'normalising is idempotent');
  assert.equal(JSON.stringify(record).includes('undefined'), false);
});

test('old descriptions on the book record still show, and never override the new record', () => {
  const legacy = { '1-3': { fromPage: 1, toPage: 3, summary: '旧一', keywords: ['x'], sliceId: 's', updatedAt: 9 }, '4-5': { fromPage: 4, toPage: 5, summary: '旧二' }, bad: { summary: '' } };
  assert.deepEqual(comic.normalizeComicRecord(null, 'b', legacy).segments.map((item) => item.summary), ['旧一', '旧二']);
  const merged = comic.normalizeComicRecord({ segments: [{ fromPage: 2, toPage: 4, summary: '新' }] }, 'b', legacy);
  assert.deepEqual(merged.segments.map((item) => item.summary), ['新'], 'legacy entries overlapping a stored segment are ignored');
  assert.equal(comic.normalizeComicRecord(null, 'b', legacy).segments[0].sliceId, undefined, 'slice links are per bucket and not carried over');
});

test('record keys are reserved and agree with the storage and package modules', async () => {
  assert.equal(comic.comicRecordKey('book-1'), 'comic::book-1');
  assert.equal(comic.isComicRecordKey('comic::book-1'), true);
  assert.equal(comic.isComicRecordKey('scope::book-1'), false);
  assert.equal(comic.isComicRecordKey(null), false);
  const store = await read('qianmu-blobstore.js'), pack = await read('qianmu-reader-package.js');
  assert.match(store, new RegExp(`const READER_BOOK_RECORD_PREFIX = '${comic.COMIC_RECORD_PREFIX}';`));
  assert.match(pack, new RegExp(`startsWith\\('${comic.COMIC_RECORD_PREFIX}'\\)`));
});

// ── 纯逻辑：分批 ──
test('batch planning never passes the current page, never re-covers described pages, respects the batch size and handles gaps', () => {
  const plan = (record, current, pagesPerBatch = 3, hasImage) => comic.planComicBatches({ record, current, pagesPerBatch, hasImage }).map((batch) => [batch.from, batch.to, batch.closed]);
  assert.deepEqual(plan(empty(), 0), [[0, 0, false]]);
  assert.deepEqual(plan(empty(), 2), [[0, 2, true]]);
  assert.deepEqual(plan(empty(), 7), [[0, 2, true], [3, 5, true], [6, 7, false]]);
  assert.deepEqual(plan(empty(), 7, 8), [[0, 7, true]]);
  assert.deepEqual(plan(empty(), 3, 1), [[0, 0, true], [1, 1, true], [2, 2, true], [3, 3, true]]);
  assert.deepEqual(plan(empty(), 3, 99).length, 1, 'batch size is clamped to 8');
  assert.deepEqual(plan(described([0, 2]), 2), []);
  assert.deepEqual(plan(described([2, 3], [7, 8]), 9), [[0, 1, true], [4, 6, true], [9, 9, false]], 'gaps between described ranges are closed batches');
  assert.deepEqual(plan(described([2, 3]), 1), [[0, 1, false]]);
  assert.deepEqual(plan(empty(), 5, 3, (index) => index !== 2), [[0, 1, true], [3, 5, true]], 'pages without an image are skipped and close the run before them');
  assert.deepEqual(plan(empty(), -1), []);
  // 随机：任意已建稿布局下，批次不越界、不重叠、不含已建稿页，且铺满全部待识别页。
  let seed = 11;
  const next = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
  for (let round = 0; round < 300; round++) {
    const total = 1 + next(40), current = next(total), size = 1 + next(8);
    let record = empty();
    for (let from = 0; from < total; from += 1 + next(6)) if (next(3) === 0) record = comic.applyComicBatch(record, { from, to: from }, { pages: {}, summary: 's', keywords: [], cast: [] });
    const done = new Set(record.segments.flatMap((item) => [item.fromPage - 1]));
    const batches = comic.planComicBatches({ record, current, pagesPerBatch: size });
    const covered = [];
    batches.forEach((batch, i) => {
      assert.ok(batch.from <= batch.to && batch.to <= current && batch.to - batch.from + 1 <= size);
      if (i) assert.ok(batch.from > batches[i - 1].to);
      for (let page = batch.from; page <= batch.to; page++) { assert.ok(!done.has(page)); covered.push(page); }
    });
    const pending = Array.from({ length: current + 1 }, (_, i) => i).filter((page) => !done.has(page));
    assert.deepEqual(covered, pending);
  }
});

test('follow-reading only takes a batch that can no longer grow', () => {
  const auto = (record, current, total = 100, pagesPerBatch = 3) => { const batch = comic.nextComicAutoBatch({ record, current, total, pagesPerBatch }); return batch && [batch.from, batch.to]; };
  assert.equal(auto(empty(), 0), null);
  assert.equal(auto(empty(), 1), null, 'two read pages wait for the third');
  assert.deepEqual(auto(empty(), 2), [0, 2]);
  assert.deepEqual(auto(empty(), 50), [0, 2], 'one batch, the earliest');
  assert.deepEqual(auto(described([0, 2]), 4), null);
  assert.deepEqual(auto(described([0, 2]), 4, 5), [3, 4], 'the last pages of the book are flushed');
  assert.deepEqual(auto(described([2, 5]), 6), [0, 1], 'a gap before described pages is flushed');
  assert.deepEqual(auto(empty(), 0, 1), [0, 0]);
  assert.equal(auto(described([0, 9]), 9, 10), null);
});

test('status counts read, described and missing pages up to the current page only', () => {
  assert.deepEqual(comic.comicStatus(empty(), 4), { read: 5, described: 0, missing: 5, currentDescribed: false });
  assert.deepEqual(comic.comicStatus(described([0, 2], [6, 8]), 4), { read: 5, described: 3, missing: 2, currentDescribed: false });
  assert.deepEqual(comic.comicStatus(described([0, 2]), 2), { read: 3, described: 3, missing: 0, currentDescribed: true });
  assert.deepEqual(comic.comicStatus(empty(), 2, (index) => index === 1), { read: 3, described: 0, missing: 1, currentDescribed: false });
});

// ── 纯逻辑：人物表 ──
test('cast merge adds new names only, never overwrites or deletes an edited entry, and dedupes names', () => {
  const cast = [{ name: '甲', look: '用户写的', edited: true }, { name: '乙', look: '' }, { name: 'Ann', look: 'red hair', note: '主角' }];
  const merged = comic.mergeComicCast(cast, [{ name: '甲', look: '模型写的' }, { name: ' 乙', look: '长发' }, { name: 'ann', look: 'other' }, { name: '丙', look: '眼镜', edited: true },
    { name: '丙', look: '重复' }, { name: '', look: 'x' }, null]);
  assert.deepEqual(merged, [{ name: '甲', look: '用户写的', edited: true }, { name: '乙', look: '长发' }, { name: 'Ann', look: 'red hair', note: '主角' }, { name: '丙', look: '眼镜' }]);
  assert.deepEqual(cast[1], { name: '乙', look: '' }, 'input is not mutated');
  assert.deepEqual(comic.mergeComicCast([{ name: '乙', look: '', edited: true }], [{ name: '乙', look: '长发' }]), [{ name: '乙', look: '', edited: true }], 'an edited entry keeps even an empty look');
  assert.deepEqual(comic.mergeComicCast(cast, []), comic.normalizeComicCast(cast));
  assert.deepEqual(comic.mergeComicCast(null, 'x'), []);
  const many = Array.from({ length: 200 }, (_, i) => ({ name: `n${i}`, look: '' }));
  assert.equal(comic.mergeComicCast([], many).length, 80);
  // 用户的编辑整份写回：改名、改外貌、删除都以卡片现值为准。
  const edited = comic.comicRecordWithSheet({ ...empty(), cast }, { direction: 'ltr', cast: [{ name: '甲二', look: '新', edited: true }, { name: '', look: '空名丢弃' }] });
  assert.equal(edited.direction, 'ltr'); assert.deepEqual(edited.cast, [{ name: '甲二', look: '新', edited: true }]);
  assert.equal(comic.comicRecordWithSheet(edited, { direction: 'sideways' }).direction, 'ltr');
});

// ── 纯逻辑：提示词 ──
test('the vision prompt states the reading direction and carries the cast sheet and the previous summary tail', () => {
  const long = `${'旧'.repeat(600)}结尾`;
  let record = comic.applyComicBatch(empty(), { from: 0, to: 2 }, { pages: {}, summary: long, keywords: [], cast: [{ name: '甲', look: '黑色短发' }] });
  record = comic.comicRecordWithSheet(record, { cast: [...record.cast, { name: '乙', look: '', note: '甲的姐姐', edited: true }] });
  const prompt = comic.buildComicVisionPrompt({ title: '某漫画', record, from: 3, to: 5 });
  assert.match(prompt.system, /日漫，右到左/); assert.doesNotMatch(prompt.system, /\{\{direction\}\}/);
  assert.match(prompt.system, /"pages":\[\{"page":页码,"panels":"…","dialogue":\[\{"speaker":"…","text":"…"\}\]\}\],"summary":"…","keywords":\["…"\],"cast":\[\{"name":"…","look":"…"\}\]/);
  assert.match(prompt.user, /《某漫画》第 4–6 页。图片依次是第 4、5、6 页。/);
  assert.match(prompt.user, /- 甲：黑色短发\n- 乙：外貌未记（甲的姐姐）/);
  const tail = prompt.user.split('【上文】\n')[1];
  assert.equal(tail, `…${long.slice(-400)}`);
  assert.match(comic.buildComicVisionPrompt({ record: comic.comicRecordWithSheet(empty(), { direction: 'ttb' }), from: 0, to: 0 }).system, /条漫，上到下/);
  assert.match(comic.buildComicVisionPrompt({ record: comic.comicRecordWithSheet(empty(), { direction: 'ltr' }), from: 0, to: 0 }).system, /左到右。每页从左上角/);
  const first = comic.buildComicVisionPrompt({ title: '', record: empty(), from: 0, to: 0 });
  assert.match(first.user, /《未命名漫画》第 1 页。图片依次是第 1 页。\n\n【人物表】\n（暂无）$/);
  // 上文只取本批之前的分段，不取之后的（回头补识别时不泄露后文）。
  const back = comic.buildComicVisionPrompt({ record: described([3, 5]), from: 0, to: 2 });
  assert.doesNotMatch(back.user, /上文/);
});

// ── 纯逻辑：回复解析 ──
test('response parsing accepts sloppy JSON shapes', () => {
  const parse = (value, extra = {}) => comic.parseComicVisionReply(value, { from: 3, to: 5, title: '书', ...extra });
  const clean = parse(reply(3, 5));
  assert.deepEqual(Object.keys(clean.pages), ['4', '5', '6']);
  assert.deepEqual(clean.pages[4], { panels: '第4页画面', dialogue: [{ speaker: '甲', text: '台词4' }] });
  assert.equal(clean.summary, '总结4-6'); assert.deepEqual(clean.keywords, ['甲', '学校', '转学']); assert.deepEqual(clean.cast, [{ name: '甲', look: '黑色短发' }]);
  // 页码缺失或对不上→按顺序对位；多出来的页丢弃；画面可为数组；对白可为字符串。
  const loose = parse({ pages: [{ panels: ['一格', { text: '二格' }], dialogue: '甲：你好\n（看不清）' }, { page: 99, description: '第二张', lines: ['乙: 嗯'] }, { page: '6', panels: '第三张' }, { page: 7, panels: '多余' }], summary: ' s ', keywords: '甲、乙，丙' });
  assert.deepEqual(loose.pages[4], { panels: '一格\n二格', dialogue: [{ speaker: '甲', text: '你好' }, { speaker: '？', text: '（看不清）' }] });
  assert.deepEqual(loose.pages[5], { panels: '第二张', dialogue: [{ speaker: '乙', text: '嗯' }] });
  assert.equal(loose.pages[6].panels, '第三张'); assert.equal(loose.pages[7], undefined);
  assert.deepEqual(loose.keywords, ['甲', '乙', '丙']); assert.deepEqual(loose.cast, []);
  // pages 写成对象、缺数组、cast 带 edited 都不出错。
  const keyed = parse({ pages: { 4: { panels: 'a' }, 5: 'b' }, description: '总', cast: [{ name: '丙', look: 'x', edited: true }, 'bad'] });
  assert.deepEqual(keyed.pages, { 4: { panels: 'a', dialogue: [] }, 5: { panels: 'b', dialogue: [] } });
  assert.equal(keyed.summary, '总'); assert.deepEqual(keyed.keywords, ['书', '漫画']); assert.deepEqual(keyed.cast, [{ name: '丙', look: 'x' }]);
  // 只有总结（旧式回复）也算成功；没有总结但有逐页内容→用画面稿拼一段。
  assert.deepEqual(parse({ summary: '只有总结' }).pages, {});
  assert.equal(parse({ pages: [{ panels: '甲进门' }, { panels: '乙抬头' }] }).summary, '甲进门 乙抬头');
  // 解析失败时用抢救出的散文。
  assert.equal(parse(null, { salvaged: '模型直接写了一段话' }).summary, '模型直接写了一段话');
});

test('response parsing never accepts an empty description', () => {
  const parse = (value, extra = {}) => comic.parseComicVisionReply(value, { from: 0, to: 1, title: '书', ...extra });
  for (const value of [null, undefined, '', 'text', [], {}, { pages: [] }, { summary: '   ' }, { pages: [{ page: 1, panels: '', dialogue: [] }], summary: '' }, { keywords: ['a'], cast: [{ name: '甲' }] },
    { pages: [{ dialogue: [{ speaker: '甲', text: ' ' }] }] }]) {
    assert.equal(parse(value), null, JSON.stringify(value));
  }
  assert.equal(parse(null, { salvaged: '  ' }), null);
});

test('usage figures are read only when really reported', () => {
  assert.equal(comic.comicUsageFigures(null), null); assert.equal(comic.comicUsageFigures({}), null); assert.equal(comic.comicUsageFigures({ prompt_tokens: 'x' }), null);
  assert.deepEqual(comic.comicUsageFigures({ prompt_tokens: 1200, completion_tokens: 300 }), { input: 1200, output: 300 });
  assert.deepEqual(comic.comicUsageFigures({ input_tokens: 5 }), { input: 5, output: null });
  assert.deepEqual(comic.comicUsageFigures({ promptTokenCount: 7, candidatesTokenCount: 0 }), { input: 7, output: 0 });
  const status = { read: 9, described: 6, missing: 3 };
  assert.equal(comic.renderComicStat(status), '已建稿 <b>6</b> / 已读 9 页');
  assert.equal(comic.renderComicStat(status, { lastBatch: { images: 3, at: 1 }, withUsage: true }), '已建稿 <b>6</b> / 已读 9 页<br>上一批 3 张图');
  assert.equal(comic.renderComicStat(status, { lastBatch: { images: 3, at: 1, input: 1200, output: 300 }, withUsage: true }), '已建稿 <b>6</b> / 已读 9 页<br>上一批 3 张图 · 输入 1200 · 输出 300 token');
  assert.equal(comic.renderComicStat(status, { lastBatch: { images: 3, input: 1 }, busy: { from: 6, to: 8 } }), '已建稿 <b>6</b> / 已读 9 页 · 正在识别第 7–9 页');
});

test('a batch result replaces its range, merges cast and records the batch figures', () => {
  let record = comic.applyComicBatch(empty(), { from: 0, to: 2 }, comic.parseComicVisionReply(reply(0, 2), { from: 0, to: 2 }), { now: 10, images: 3, usage: { prompt_tokens: 900, completion_tokens: 200 } });
  assert.deepEqual(Object.keys(record.pages), ['1', '2', '3']); assert.equal(record.pages[1].updatedAt, 10);
  assert.deepEqual(record.segments, [{ fromPage: 1, toPage: 3, summary: '总结1-3', keywords: ['甲', '学校', '转学'], updatedAt: 10 }]);
  assert.deepEqual(record.cast, [{ name: '甲', look: '黑色短发' }]);
  assert.deepEqual(record.lastBatch, { images: 3, at: 10, input: 900, output: 200 });
  // 重新识别同一段：旧页稿与旧分段被整段替换，不残留。
  const redo = comic.applyComicBatch(record, { from: 0, to: 2 }, { pages: { 2: { panels: '新' }, 9: { panels: '越界' } }, summary: '新总结', keywords: [], cast: [{ name: '甲', look: '别的' }] }, { now: 20 });
  assert.deepEqual(Object.keys(redo.pages), ['2']); assert.equal(redo.segments.length, 1); assert.equal(redo.segments[0].summary, '新总结');
  assert.deepEqual(redo.cast, [{ name: '甲', look: '黑色短发' }]); assert.deepEqual(redo.lastBatch, { images: 3, at: 20 });
  assert.equal(record.segments[0].summary, '总结1-3', 'the previous record object is untouched');
  // 改切片文字只在页范围完全对上时同步分段总结。
  const same = comic.comicRecordWithSummary(record, 1, 3, { summary: '总结1-3', keywords: ['甲', '学校', '转学'] });
  assert.equal(same, record);
  assert.equal(comic.comicRecordWithSummary(record, 1, 2, { summary: '改' }), record);
  assert.equal(comic.comicRecordWithSummary(record, 1, 3, { summary: '  ' }), record);
  const changed = comic.comicRecordWithSummary(record, 1, 3, { summary: '改过', keywords: ['x'] }, 30);
  assert.deepEqual(changed.segments[0], { fromPage: 1, toPage: 3, summary: '改过', keywords: ['x'], updatedAt: 30 });
});

// ── 纯逻辑：书友可见文字 ──
test('visible text prefers page detail near the current page, falls back to summaries, and never looks ahead', () => {
  let record = empty();
  for (const [from, to] of [[0, 2], [3, 5], [6, 8]]) record = comic.applyComicBatch(record, { from, to }, comic.parseComicVisionReply(reply(from, to), { from, to }), { now: 1 });
  const text = comic.comicVisibleText(record, 5, 6000);
  assert.match(text, /【漫画第 6 页】\n画面：第6页画面\n对白：\n甲：台词6$/);
  for (const page of [1, 2, 3, 4, 5, 6]) assert.ok(text.includes(`【漫画第 ${page} 页】`), `page ${page}`);
  assert.doesNotMatch(text, /概要/, 'segments fully covered by page detail are not repeated');
  assert.doesNotMatch(text, /第 7|第7页|总结7-9/, 'nothing beyond the current page');
  // 当前页在一段中间：只取到当前页的页稿，这一段的总结（含后两页）不取。
  const middle = comic.comicVisibleText(record, 6, 6000);
  assert.ok(middle.includes('【漫画第 7 页】')); assert.doesNotMatch(middle, /第8页|第9页|总结7-9/);
  assert.ok(middle.includes('【漫画第 1–3 页·概要】\n总结1-3'), 'older pages beyond the six detailed ones come as summaries');
  assert.ok(middle.indexOf('概要') < middle.indexOf('【漫画第 2 页】'), 'chronological order');
  // 只有分段总结（旧数据）时照旧给总结。
  assert.equal(comic.comicVisibleText(described([0, 2], [3, 5]), 5), '【漫画第 1–3 页·概要】\n第1到3页\n\n【漫画第 4–6 页·概要】\n第4到6页');
  assert.equal(comic.comicVisibleText(described([0, 2]), 1), '');
  assert.equal(comic.comicVisibleText(empty(), 9), '');
  assert.equal(comic.comicVisibleText(null, 0), '');
});

test('visible text stays within the budget and always keeps the current page', () => {
  let record = empty();
  for (let from = 0; from < 60; from += 3) {
    const result = { pages: {}, summary: `段${from}`.padEnd(300, '述'), keywords: [], cast: [] };
    for (let page = from + 1; page <= from + 3; page++) result.pages[page] = { panels: `页${page}`.padEnd(500, '画'), dialogue: [] };
    record = comic.applyComicBatch(record, { from, to: from + 2 }, result, { now: 1 });
  }
  for (const budget of [800, 2000, 6000]) {
    const text = comic.comicVisibleText(record, 59, budget);
    assert.ok(text.includes('【漫画第 60 页】'));
    assert.ok(text.length <= budget + 40, `${text.length} > ${budget}`);
    assert.ok((text.match(/【漫画第 \d+ 页】/g) || []).length <= 6);
  }
  const tiny = comic.comicVisibleText(record, 59, 1);
  assert.ok(tiny.includes('【漫画第 60 页】'), 'an oversized current page is still sent whole');
  assert.equal((tiny.match(/【漫画第/g) || []).length, 1);
  assert.ok(comic.comicVisibleText(record, 59, 6000).includes('·概要】'), 'room left over goes to older summaries, newest first');
});

// ── 纯逻辑：按书友补建切片 ──
test('segments needing a slice: described, read, not covered by a book slice and not dismissed in this bucket', () => {
  const record = described([0, 2], [3, 5], [6, 8]);
  const need = (slices, current, dismissed) => comic.comicSegmentsNeedingSlices(record, slices, current, dismissed).map((item) => [item.fromPage, item.toPage]);
  assert.deepEqual(need([], 8), [[1, 3], [4, 6], [7, 9]]);
  assert.deepEqual(need([], 6), [[1, 3], [4, 6]], 'a segment reaching past the current page waits');
  assert.deepEqual(need([], 1), []);
  const slice = (from, to, extra = {}) => ({ src: 'text', provenance: { source: 'book', sources: ['book'], chapterFrom: from, chapterTo: to }, ...extra });
  assert.deepEqual(need([slice(0, 2)], 8), [[4, 6], [7, 9]]);
  assert.deepEqual(need([slice(0, 5)], 8), [[7, 9]], 'a merged slice covering several segments counts');
  assert.deepEqual(need([{ src: 'mixed', provenance: { source: 'mixed', sources: ['dialog', 'book'], chapterFrom: 0, chapterTo: 8 } }], 8), []);
  assert.deepEqual(need([{ src: 'text', chapterFrom: 0, chapterTo: 2 }], 2), [], 'old slices without provenance are recognised');
  assert.deepEqual(need([{ src: 'dialog', provenance: { source: 'dialog', chapterFrom: 0, chapterTo: 8 } }, slice(1, 2), { src: 'text', provenance: { source: 'book' } }], 2), [[1, 3]]);
  assert.deepEqual(need([], 8, [[0, 2], [6, 8]]), [[4, 6]]);
  assert.deepEqual(need([], 8, 'garbage'), [[1, 3], [4, 6], [7, 9]]);
  // 删除→记下范围；清空→现有分段全部记下；重新识别→撤销相交的。
  assert.deepEqual(comic.comicDismissRange([], slice(3, 5)), [[3, 5]]);
  assert.deepEqual(comic.comicDismissRange([[0, 9]], slice(3, 5)), [[0, 9]]);
  assert.deepEqual(comic.comicDismissRange(undefined, { src: 'dialog', provenance: { source: 'dialog', dialogFrom: 0, dialogTo: 3 } }), []);
  assert.deepEqual(comic.comicDismissAll(record), [[0, 2], [3, 5], [6, 8]]);
  assert.deepEqual(comic.comicUndismiss([[0, 2], [3, 5], [6, 8]], 3, 5), [[0, 2], [6, 8]]);
  assert.deepEqual(comic.comicUndismiss([[0, 8]], 3, 5), []);
});

test('memory-archive cards: cast rows are escaped and the fill button follows the state', () => {
  const esc = (value) => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');
  const record = comic.comicRecordWithSheet(described([0, 2]), { direction: 'ttb', cast: [{ name: '<甲>', look: '"长发"', note: 'n&', edited: true }] });
  const html = comic.renderComicMemoryCards({ record, status: comic.comicStatus(record, 5) }, esc);
  assert.match(html, /<option value="ttb" selected>上到下（条漫）<\/option>/); assert.match(html, /右到左（日漫）/); assert.match(html, /左到右/);
  assert.match(html, /已建稿 <b>3<\/b> \/ 已读 6 页/); assert.match(html, />补齐未识别的 3 页<\/button>/);
  assert.match(html, /data-note="n&amp;" data-edited="1"/); assert.match(html, /value="&lt;甲>"/); assert.match(html, /value="&quot;长发&quot;"/);
  assert.doesNotMatch(html, /<甲>/);
  const done = comic.renderComicMemoryCards({ record, status: comic.comicStatus(record, 2) }, esc);
  assert.match(done, /sd-reader-comic-fill" disabled>已读的页都识别过了/);
  const busy = comic.renderComicMemoryCards({ record, status: comic.comicStatus(record, 5), filling: { batch: { from: 3, to: 5 } } }, esc);
  assert.match(busy, /sd-reader-comic-fill sd-btn-danger">停止</); assert.match(busy, /正在识别第 4–6 页/);
});

// ── 存储：与伴读对话同仓，但不被当成聊天档案 ──
test('a per-book record is not listed under any chat, survives "keep memory" deletion and is not counted as a conversation', async () => {
  const store = await read('qianmu-blobstore.js');
  const pick = (name) => { const start = store.indexOf(`function ${name}(`), end = store.indexOf('\nfunction ', start + 1); return store.slice(start, end); };
  const c = vm.createContext({ READER_BOOK_RECORD_PREFIX: 'comic::' });
  vm.runInContext(`${pick('exactStorageChatKey')}\n${pick('readerBucketScope')}`, c);
  assert.equal(c.readerBucketScope('chat-a::book', { bookId: 'book' }), 'chat-a');
  assert.equal(c.readerBucketScope('comic::book', { bookId: 'book', kind: 'comic' }), '', 'never offered in clean-up by chat');
  assert.equal(c.readerBucketScope('comic::book', {}), '');
  assert.match(store, /if \(bookRecord\) \{ if \(deleteMemory\) \{ watch\(target\.delete\(cursor\.key\)\); chatKeys\.push\(cursor\.key\); \} \}\s*else if \(storeName === STORE_CHATS && !deleteMemory\)/,
    'deleting a book keeps the record with retained memory, removes it with deleted memory, and never archives it as a dialogue');
  // 整包导入：页稿照常写回，但不计作「对话」。
  const puts = [], progress = createCoreadImportProgress();
  await applyCoreadPackageData({ books: [], chats: [{ key: 'comic::book', rec: { kind: 'comic' } }, { key: 'chat::book', rec: { messages: [] } }] },
    { blobStore: { putReaderChat: async (key, rec) => puts.push(key) }, coread: () => ({ books: [] }), isPlainObject: (value) => !!value && typeof value === 'object' && !Array.isArray(value), base64ToBlob: () => null, warn: () => {}, progress });
  assert.deepEqual(puts, ['comic::book', 'chat::book']); assert.equal(progress.chatOk, 1);
  // 走的是伴读对话那一套账户镜像（一条记录一个账户文件）。
  const index = await read('index.js');
  assert.match(index, /readerChatSync\.get\(reader\.comicRecordKey\(bookId\)\)/); assert.match(index, /readerChatSync\.put\(reader\.comicRecordKey\(cache\.bookId\), next\)/);
  assert.equal(READER_CHAT_INDEX_SLOT, 'reader-chats');
  assert.doesNotMatch(index.slice(index.indexOf('// ── 漫画识图 ──'), index.indexOf('// 发送/生成分离')), /putBook|comicDescriptions\[/, 'descriptions are no longer written onto the book record');
});

// ── 真实函数：跟读、补齐、看一眼、回退、按书友补建 ──
const COMIC_FUNCTIONS = ['coreadExplainError', 'coreadMemorySnapshot', 'coreadMemoryRestore', 'coreadNextBatch', 'coreadRenumberSlices', 'coreadRecalculateDialogCursor', 'coreadPersistSlice',
  'coreadDeleteSlice', 'coreadClearAllSlices', 'coreadUpdateComicDescriptionForSlice', 'coreadSaveSliceEdit', 'coreadComicPageImageNumber', 'coreadComicRecord', 'coreadComicPlanInput', 'coreadComicLoad',
  'coreadComicCommit', 'coreadComicSyncStatus', 'coreadComicBackfill', 'coreadComicDescribe', 'coreadComicAuto', 'coreadComicFillMissing', 'coreadComicStop', 'coreadAnalyzeComicPages', 'coreadComicVisibleText'];

function comicFixture({ pages = 12, current = 0, pagesPerBatch = 3, stored = null, legacy = {} } = {}) {
  const calls = [], toasts = [], reviews = [], saves = [], puts = [];
  let id = 0, clock = 1000;
  const chapters = Array.from({ length: pages }, (_, i) => ({ content: `⟦img:${i + 1}⟧` }));
  const state = { saveOk: true, recordOk: true, failAt: -1, conn: { model: 'vision' }, review: undefined, confirm: true, reply: null, usage: { prompt_tokens: 900, completion_tokens: 120 },
    cfg: { pagesPerBatch, autoFollow: true, reviewEachBatch: false, sendCurrentPage: false }, stored };
  const c = vm.createContext({
    reader, console, MODULE_NAME: 'fixture', AbortController, Date: { now: () => ++clock }, Promise,
    COREAD_SAVE_FAILED: '记忆未能保存，请重试', COREAD_MEMORY_BUSY: '正在整理记忆，请稍候',
    readerView: { bookId: 'book', chapterIndex: current, scrollRatio: 0 },
    readerContentCache: { bookId: 'book', chapters, comicDescriptions: legacy },
    readerDialog: { bookId: 'book', bucket: 'A::book', loaded: true, cursor: 0, summaryFloor: 0, slices: [], messages: [] },
    coreadComicVisionBusy: false, coreadComicVisionAbort: null, coreadComicFill: null, coreadComicWrite: Promise.resolve(),
    coreadDistilling: false, coreadMemoryWrites: 0, coreadVectorStates: new Map(), coreadPipelineCircuits: new Map(), coreadVecCache: null, coreadEchoTtl: new Map(),
    coreadMemory: () => ({ vectorEnabled: false }), coreadBookMeta: () => ({ title: '某漫画', mode: 'comic' }), coreadDialogBucket: () => c.readerDialog.bucket,
    coreadCompanion: () => ({ visibleCharsBefore: 6000 }),
    coreadCurrentReadBoundarySync: () => ({ bookId: 'book', readTo: 9999, chapterIndex: c.readerView.chapterIndex, progress: 10 }),
    coreadSliceFingerprint: () => 'fp', coreadSyncSliceVector: async () => ({ ok: false, skipped: true }), coreadForgetSliceRuntime: async () => {},
    refreshMoreIfRecords: () => {}, rerenderMoreIfOpen: () => {}, applyQianmuIcons: () => {},
    document: { querySelector: () => null, querySelectorAll: () => [] },
    uid: (prefix) => `${prefix}-${++id}`, uniqueClean: (list) => [...new Set(list)], isPlainObject: (value) => !!value && typeof value === 'object' && !Array.isArray(value),
    extractJson: JSON.parse, coreadSalvageSummary: () => '', coreadComicConfig: () => state.cfg, coreadVisionApiConn: () => state.conn,
    toast: (message, level) => toasts.push({ message, level }), confirmDialog: async () => state.confirm,
    coreadSaveDialog: async () => { saves.push(c.readerDialog.slices.length); return state.saveOk; },
    coreadConfirmComicSummary: async (label, summary, keywords) => { reviews.push({ label, summary, keywords }); return state.review; },
    coreadVisionDataUrl: async (blob) => `data:${blob.page}`,
    blobStore: { getReaderImage: async (bookId, n) => ({ page: n }), getReaderChat: async () => state.stored },
    readerChatSync: {
      get: async (key) => { assert.equal(key, 'comic::book'); return state.stored; },
      put: async (key, record) => { puts.push(key); if (!state.recordOk) throw new Error('disk'); state.stored = JSON.parse(JSON.stringify(record)); },
    },
    callCoreadVisionModel: async (system, user, images, opts) => {
      const index = calls.length;
      calls.push({ system, user, images: [...images] });
      if (index === state.failAt) throw new Error('HTTP 400');
      const pagesSent = images.map((url) => Number(url.slice(5)));
      opts.onUsage?.(state.usage);
      return typeof state.reply === 'string' ? state.reply : JSON.stringify(state.reply || reply(pagesSent[0] - 1, pagesSent.at(-1) - 1));
    },
  });
  vm.runInContext(COMIC_FUNCTIONS.map(section).join('\n'), c);
  return { c, calls, toasts, reviews, saves, puts, state, record: () => c.readerContentCache.comic, dialog: () => c.readerDialog,
    go: (page) => { c.readerView.chapterIndex = page; },
    // 载入完成后真实代码会自己触发一次跟读；测试里先按住，由各用例在布置好条件后显式触发。
    open: async () => { const auto = c.coreadComicAuto; c.coreadComicAuto = async () => {}; try { await c.coreadComicLoad('book'); } finally { c.coreadComicAuto = auto; } } };
}
const sliceRanges = (dialog) => Array.from(dialog.slices, (slice) => [slice.provenance.chapterFrom, slice.provenance.chapterTo]);
const pagesSent = (calls) => calls.map((call) => call.images.map((url) => Number(url.slice(5))));

test('follow-reading describes only pages already read, one batch per trigger, and saves without a dialog', async () => {
  const e = comicFixture({ current: 1 });
  await e.open();
  await e.c.coreadComicAuto();
  assert.equal(e.calls.length, 0, 'two read pages do not make a batch of three yet');
  e.go(2);
  await e.c.coreadComicAuto();
  assert.deepEqual(pagesSent(e.calls), [[1, 2, 3]]);
  assert.equal(e.reviews.length, 0, 'no review dialog by default');
  assert.deepEqual(Object.keys(e.record().pages), ['1', '2', '3']);
  assert.deepEqual(e.record().segments.map((item) => [item.fromPage, item.toPage, item.summary]), [[1, 3, '总结1-3']]);
  assert.deepEqual(e.record().cast, [{ name: '甲', look: '黑色短发' }]);
  assert.deepEqual(e.state.stored.segments, JSON.parse(JSON.stringify(e.record().segments)), 'what is in memory is what was saved');
  assert.deepEqual(e.puts, ['comic::book']);
  assert.deepEqual(sliceRanges(e.dialog()), [[0, 2]]);
  const slice = e.dialog().slices[0];
  assert.equal(slice.summary, '总结1-3'); assert.equal(slice.src, 'text'); assert.equal(slice.provenance.source, 'book');
  assert.deepEqual([slice.coveredFrom, slice.coveredTo], [0, '⟦img:1⟧⟦img:2⟧⟦img:3⟧'.length]);
  assert.deepEqual(e.record().lastBatch.images, 3); assert.equal(e.record().lastBatch.input, 900); assert.equal(e.record().lastBatch.output, 120);
  assert.equal(e.toasts.length, 0, 'the background run is silent when it works');
  // 跳到很后面：每次触发仍只做一批，且从最早的缺口开始，永不越过当前页。
  e.go(10);
  await e.c.coreadComicAuto();
  assert.deepEqual(pagesSent(e.calls), [[1, 2, 3], [4, 5, 6]]);
  await e.c.coreadComicAuto(); await e.c.coreadComicAuto(); await e.c.coreadComicAuto();
  assert.deepEqual(pagesSent(e.calls), [[1, 2, 3], [4, 5, 6], [7, 8, 9]], 'pages 10–11 wait for page 12');
  for (const sent of pagesSent(e.calls)) for (const page of sent) assert.ok(page <= 11);
  // 每次请求都带人物表与上一段的结尾。
  assert.match(e.calls[1].user, /【人物表】\n- 甲：黑色短发/); assert.match(e.calls[1].user, /【上文】\n总结1-3/);
  assert.match(e.calls[0].system, /日漫，右到左/);
  e.go(11);
  await e.c.coreadComicAuto();
  assert.deepEqual(pagesSent(e.calls).at(-1), [10, 11, 12]);
  assert.equal(e.c.coreadComicVisionBusy, false); assert.equal(e.c.coreadMemoryWrites, 0);
});

test('follow-reading stays off when disabled, unconfigured, busy or not yet loaded', async () => {
  const off = comicFixture({ current: 5 });
  await off.open(); off.state.cfg.autoFollow = false;
  await off.c.coreadComicAuto();
  assert.equal(off.calls.length, 0);
  const none = comicFixture({ current: 5 });
  await none.open(); none.state.conn = null;
  await none.c.coreadComicAuto(); await none.c.coreadComicAuto(); await none.c.coreadComicAuto();
  assert.equal(none.calls.length, 0); assert.equal(none.toasts.length, 1, 'one hint per book open, not one per page');
  none.state.conn = { model: 'vision' };
  await none.c.coreadComicAuto();
  assert.equal(none.calls.length, 1, 'works as soon as a connection is chosen');
  for (const flag of ['coreadDistilling', 'coreadMemoryWrites', 'coreadComicVisionBusy']) {
    const busy = comicFixture({ current: 5 });
    await busy.open(); busy.c[flag] = flag === 'coreadMemoryWrites' ? 1 : true;
    await busy.c.coreadComicAuto();
    assert.equal(busy.calls.length, 0, flag);
  }
  const unloaded = comicFixture({ current: 5 });
  await unloaded.c.coreadComicAuto();
  assert.equal(unloaded.calls.length, 0, 'without the stored record nothing is described, so nothing can be overwritten');
  const text = comicFixture({ current: 5 });
  text.c.coreadBookMeta = () => ({ title: '小说', mode: 'text' });
  await text.open(); await text.c.coreadComicAuto();
  assert.equal(text.calls.length, 0); assert.equal(text.record(), undefined);
});

test('a failed automatic batch is reported once and not retried on every page turn', async () => {
  const e = comicFixture({ current: 8 });
  await e.open(); e.state.failAt = 0;
  await e.c.coreadComicAuto(); await e.c.coreadComicAuto(); await e.c.coreadComicAuto();
  assert.equal(e.calls.length, 1); assert.equal(e.toasts.length, 1); assert.match(e.toasts[0].message, /漫画识图失败/);
  assert.deepEqual(e.record().segments, []); assert.equal(e.dialog().slices.length, 0); assert.equal(e.puts.length, 0);
  // 手动按钮照常可用。
  await e.c.coreadAnalyzeComicPages();
  assert.equal(e.record().segments.length, 3);
});

test('with the review switch on, each batch goes through the dialog before anything is saved', async () => {
  const e = comicFixture({ current: 2 });
  await e.open(); e.state.cfg.reviewEachBatch = true; e.state.review = null;
  await e.c.coreadComicAuto();
  assert.equal(e.calls.length, 1); assert.equal(e.reviews.length, 1); assert.equal(e.reviews[0].label, '第 1–3 页'); assert.equal(e.reviews[0].summary, '总结1-3');
  assert.deepEqual(e.record().segments, [], 'cancelled: nothing saved'); assert.equal(e.dialog().slices.length, 0); assert.equal(e.puts.length, 0);
  assert.equal(e.toasts.length, 0, 'a cancelled review is not a failure');
  e.state.review = { summary: '我改过的', keywords: ['改'] };
  await e.c.coreadComicAuto();
  assert.equal(e.record().segments[0].summary, '我改过的'); assert.deepEqual(e.record().segments[0].keywords, ['改']);
  assert.equal(e.dialog().slices[0].summary, '我改过的'); assert.deepEqual(Object.keys(e.record().pages), ['1', '2', '3'], 'page detail is kept as transcribed');
});

test('an empty or unusable reply is never saved as a description', async () => {
  for (const bad of ['', '{}', '{"pages":[],"summary":""}', '{"keywords":["a"]}', 'not json at all']) {
    const e = comicFixture({ current: 2 });
    await e.open(); e.state.reply = bad;
    await e.c.coreadComicAuto();
    assert.deepEqual(e.record().segments, [], bad); assert.equal(e.dialog().slices.length, 0); assert.equal(e.puts.length, 0);
    assert.equal(e.toasts.length, 1); assert.match(e.toasts[0].message, /识图模型没有返回有效内容|漫画识图失败/);
  }
});

test('a failed save rolls back: no description without a stored record, no slice without a stored archive', async () => {
  const e = comicFixture({ current: 2 });
  await e.open(); e.state.recordOk = false;
  await e.c.coreadComicAuto();
  assert.deepEqual(e.record().segments, []); assert.deepEqual(e.record().pages, {}); assert.equal(e.dialog().slices.length, 0); assert.equal(e.state.stored, null);
  assert.equal(e.toasts.length, 1); assert.match(e.toasts[0].message, /记忆未能保存，请重试/);
  assert.equal(e.c.coreadVectorStates.size, 0);
  // 页稿存住了、伴读档案没存住：切片还原并如实报错；页稿保留，下次直接补切片，不再花钱识别。
  const f = comicFixture({ current: 2 });
  await f.open(); f.state.saveOk = false;
  const result = await f.c.coreadComicDescribe({ from: 0, to: 2 });
  assert.equal(result.ok, false); assert.match(result.reason, /记忆未能保存，请重试/);
  assert.equal(f.dialog().slices.length, 0); assert.equal(f.c.coreadVectorStates.size, 0); assert.equal(f.c.coreadMemoryWrites, 0);
  assert.equal(f.record().segments.length, 1); assert.equal(f.state.stored.segments.length, 1);
  f.state.saveOk = true;
  await f.c.coreadComicAuto();
  assert.equal(f.calls.length, 1, 'no second model call'); assert.deepEqual(sliceRanges(f.dialog()), [[0, 2]]);
});

test('fill-missing works batch by batch, stops at the first failure and keeps what succeeded', async () => {
  const e = comicFixture({ current: 7 });
  await e.open(); e.state.failAt = 1;
  await e.c.coreadComicFillMissing();
  assert.deepEqual(pagesSent(e.calls), [[1, 2, 3], [4, 5, 6]], 'no batch is attempted after the failed one');
  assert.deepEqual(e.record().segments.map((item) => [item.fromPage, item.toPage]), [[1, 3]]);
  assert.deepEqual(sliceRanges(e.dialog()), [[0, 2]]);
  assert.equal(e.toasts.length, 1); assert.equal(e.toasts[0].level, 'warning'); assert.match(e.toasts[0].message, /已识别 1 批，之后识图失败/);
  assert.equal(e.c.coreadComicFill, null); assert.equal(e.c.coreadComicVisionBusy, false);
  // 再点一次：从失败处接着补，最后不满一批的零头也补上（手动补齐不等凑满）。
  e.state.failAt = -1;
  await e.c.coreadComicFillMissing();
  assert.deepEqual(pagesSent(e.calls).slice(2), [[4, 5, 6], [7, 8]]);
  assert.deepEqual(e.record().segments.map((item) => [item.fromPage, item.toPage]), [[1, 3], [4, 6], [7, 8]]);
  assert.deepEqual(sliceRanges(e.dialog()), [[0, 2], [3, 5], [6, 7]]);
  assert.equal(e.toasts.at(-1).level, 'success');
  await e.c.coreadComicFillMissing();
  assert.equal(e.calls.length, 4, 'nothing left: no request'); assert.match(e.toasts.at(-1).message, /已读的页都识别过了/);
});

test('fill-missing can be stopped between batches and needs a vision connection', async () => {
  const e = comicFixture({ current: 8 });
  await e.open();
  const original = e.c.callCoreadVisionModel;
  e.c.callCoreadVisionModel = async (...args) => { const out = await original(...args); if (e.calls.length === 2) e.c.coreadComicStop(); return out; };
  await e.c.coreadComicFillMissing();
  assert.equal(e.calls.length, 2); assert.equal(e.record().segments.length, 1, 'the batch in flight when stopped is discarded, the earlier one stays');
  assert.match(e.toasts.at(-1).message, /已停止，已识别 1 批/);
  const none = comicFixture({ current: 8 });
  await none.open(); none.state.conn = null;
  await none.c.coreadComicFillMissing();
  assert.equal(none.calls.length, 0); assert.equal(none.toasts.length, 1);
});

test('a second bucket gets its slices from the stored summaries without a model call', async () => {
  const e = comicFixture({ current: 5 });
  await e.open();
  await e.c.coreadComicFillMissing();
  assert.equal(e.calls.length, 2); assert.equal(e.dialog().slices.length, 2);
  // 换一位书友（另一个记忆桶）：同一本书、同一份页稿。
  e.c.readerDialog = { bookId: 'book', bucket: 'B::book', loaded: true, cursor: 0, summaryFloor: 0, slices: [], messages: [] };
  e.go(3);
  await e.c.coreadComicAuto();
  assert.deepEqual(sliceRanges(e.dialog()), [[0, 2]], 'only segments inside this reader\'s read range');
  e.go(5);
  await e.c.coreadComicAuto();
  assert.deepEqual(sliceRanges(e.dialog()), [[0, 2], [3, 5]]);
  assert.equal(e.calls.length, 2, 'no model call for the second bucket');
  assert.deepEqual(e.dialog().slices.map((slice) => slice.summary), ['总结1-3', '总结4-6']);
  assert.deepEqual(e.dialog().slices.map((slice) => slice.provenance.bucket), ['B::book', 'B::book']);
  await e.c.coreadComicAuto();
  assert.equal(e.dialog().slices.length, 2, 'not created twice');
  // 另一台设备／重开：页稿从存储读回，旧版写在书籍记录上的文字稿也照常并入。
  const again = comicFixture({ current: 8, stored: e.state.stored, legacy: { '7-9': { fromPage: 7, toPage: 9, summary: '旧稿', keywords: [] } } });
  await again.c.coreadComicLoad('book');   // 不按住：载入后自动补建
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(again.calls.length, 0); assert.deepEqual(sliceRanges(again.dialog()), [[0, 2], [3, 5], [6, 8]]);
  assert.equal(await again.c.coreadComicVisibleText('book', 8, {}), reader.comicVisibleText(again.record(), 8, 6000));
  assert.match(await again.c.coreadComicVisibleText('book', 8, {}), /旧稿/);
});

test('a slice the user deleted, or cleared, is not brought back; re-describing on request brings it back', async () => {
  const e = comicFixture({ current: 5 });
  await e.open();
  await e.c.coreadComicFillMissing();
  const [first, second] = e.dialog().slices;
  assert.equal((await e.c.coreadDeleteSlice(first.id)).ok, true);
  await e.c.coreadComicAuto();
  assert.deepEqual(sliceRanges(e.dialog()), [[3, 5]]);
  assert.deepEqual(e.dialog().comicDismissed, [[0, 2]]);
  assert.equal(e.record().segments.length, 2, 'the paid description itself stays for the companion and for other buckets');
  // 删除没存住→连「不再补回」一起还原。
  e.state.saveOk = false;
  assert.equal((await e.c.coreadDeleteSlice(second.id)).ok, false);
  assert.deepEqual(e.dialog().comicDismissed, [[0, 2]]); assert.equal(e.dialog().slices.length, 1);
  e.state.saveOk = true;
  assert.equal((await e.c.coreadClearAllSlices()).ok, true);
  await e.c.coreadComicAuto();
  assert.equal(e.dialog().slices.length, 0); assert.equal(e.calls.length, 2);
  // 在已建稿的页上点识图钮：确认后重新识别那一段，并重新写入记忆。
  e.state.confirm = false;
  await e.c.coreadAnalyzeComicPages();
  assert.equal(e.calls.length, 2, 'declined: no request');
  e.state.confirm = true; e.state.reply = reply(3, 5, { summary: '重识别' });
  await e.c.coreadAnalyzeComicPages();
  assert.deepEqual(pagesSent(e.calls).at(-1), [4, 5, 6]);
  assert.equal(e.record().segments.find((item) => item.fromPage === 4).summary, '重识别'); assert.equal(e.record().segments.length, 2);
  assert.deepEqual(sliceRanges(e.dialog()), [[3, 5]]); assert.equal(e.dialog().slices[0].summary, '重识别');
});

test('the reader button describes up to the current page now, and re-describing rewrites the existing slice', async () => {
  const e = comicFixture({ current: 3 });
  await e.open();
  await e.c.coreadAnalyzeComicPages();
  assert.deepEqual(pagesSent(e.calls), [[1, 2, 3], [4]], 'the partial batch is not left waiting');
  assert.deepEqual(sliceRanges(e.dialog()), [[0, 2], [3, 3]]);
  // 当前页在一段中间：不重识别（否则要么越过当前页，要么拆段）。
  e.go(1);
  await e.c.coreadAnalyzeComicPages();
  assert.equal(e.calls.length, 2); assert.match(e.toasts.at(-1).message, /读到第 3 页再重新识别/);
  e.go(2); e.state.reply = reply(0, 2, { summary: '第二版' });
  const sliceId = e.dialog().slices[0].id;
  await e.c.coreadAnalyzeComicPages();
  assert.deepEqual(pagesSent(e.calls).at(-1), [1, 2, 3]);
  assert.equal(e.dialog().slices.length, 2, 'no duplicate slice');
  assert.equal(e.dialog().slices.find((slice) => slice.id === sliceId).summary, '第二版');
  assert.equal(e.record().segments[0].summary, '第二版');
  // 在切片管理里手改这条切片：同一段的分段总结跟着改。
  assert.equal((await e.c.coreadSaveSliceEdit(sliceId, '手改', '关键')).ok, true);
  assert.equal(e.record().segments[0].summary, '手改'); assert.deepEqual(e.record().segments[0].keywords, ['关键']); assert.equal(e.state.stored.segments[0].summary, '手改');
});

test('a batch in flight is discarded when the reader moves to another book', async () => {
  const e = comicFixture({ current: 2 });
  await e.open();
  const original = e.c.callCoreadVisionModel;
  e.c.callCoreadVisionModel = async (...args) => { const out = await original(...args); e.c.readerView = { bookId: 'other', chapterIndex: 0 }; e.c.readerContentCache = { bookId: 'other', chapters: [] }; return out; };
  const result = await e.c.coreadComicDescribe({ from: 0, to: 2 });
  assert.equal(result.ok, false); assert.equal(result.aborted, true);
  assert.equal(e.puts.length, 0); assert.equal(e.dialog().slices.length, 0); assert.equal(e.c.coreadComicVisionBusy, false);
});

// ── 接线 ──
test('wiring: progress saves trigger follow-reading, the reply can carry the current page, usage is passed through', async () => {
  const index = await read('index.js'), proxy = await read('qianmu-st-model-proxy.js'), css = await read('style.css');
  assert.match(section('coreadSaveProgress'), /if \(summarize\) \{ coreadMaybeAutoDistillText\(\); void coreadComicAuto\(\); \}/);
  assert.match(section('coreadOpenBook'), /coreadComicStop\(\);[\s\S]*void coreadComicLoad\(bookId\);/);
  assert.match(section('coreadCloseReader'), /coreadComicStop\(\);/);
  assert.match(section('coreadComicConfig'), /comic\.autoFollow = comic\.autoFollow !== false;/);
  assert.match(index, /autoFollow: true,[^\n]*\n\s*reviewEachBatch: false,[^\n]*\n\s*sendCurrentPage: false,/);
  const replyBlock = index.slice(index.indexOf('// 「带上当前页」'), index.indexOf('// 「带上当前页」') + 900);
  assert.match(replyBlock, /coreadComicConfig\(\)\.sendCurrentPage && imageUrls\.length < 8/);
  assert.match(replyBlock, /coreadVisionApiConn\(\)[\s\S]*preparingView\.chapterIndex[\s\S]*pageAttached = true[\s\S]*comicPageHinted[\s\S]*callCoreadVisionModel\(dialogSystemPrompt, pageAttached \? `\$\{userPrompt\}[\s\S]{0,40}最后一张图是你们正在看的这一页/);
  assert.match(index, /class="sd-reader-inbtn sd-reader-dialog-page\$\{coreadComicConfig\(\)\.sendCurrentPage \? ' active' : ''\}" title="带上当前页"/);
  assert.match(css, /\.sd-reader-dialog-input\.is-assistant \.sd-reader-dialog-page \{ display: none; \}/);
  assert.match(section('callCoreadVisionModel'), /onUsage: opts\.onUsage/); assert.match(section('callCoreadVisionModel'), /if \(state\?\.usage\) opts\.onUsage\?\.\(state\.usage\)/);
  assert.match(proxy, /if \(accumulator\.snapshot\(\)\.usage\) onUsage\?\.\(accumulator\.snapshot\(\)\.usage\)/); assert.match(proxy, /if \(result\.usage\) onUsage\?\.\(result\.usage\)/);
  assert.match(index, /跟读时自动识图<\/span>\$\{renderMemSwitch\('sd-reader-comic-auto', comicCfg\.autoFollow\)\}/);
  assert.match(index, /每批先让我看一眼<\/span>\$\{renderMemSwitch\('sd-reader-comic-review-en', comicCfg\.reviewEachBatch\)\}/);
  assert.match(index, /class="sd-reader-mstate sd-reader-comic-stat" data-usage="1"/);
  assert.match(section('renderMemRecordsTab'), /curBook\?\.mode === 'comic' \? \(comicRecord \? reader\.renderComicMemoryCards\(/);
});

test('the memory-archive tab shows the comic cards instead of text distill for a comic, and nothing extra for a text book', () => {
  const { c, m, inputs } = createCoreadRecordsFixture();
  const textHtml = c.renderMemRecordsTab(m);
  assert.match(textHtml, /书籍蒸馏/); assert.doesNotMatch(textHtml, /漫画识图|人物表/);
  inputs.meta.mode = 'comic';
  assert.doesNotMatch(c.renderMemRecordsTab(m), /书籍蒸馏|漫画识图/, 'a comic whose record is not loaded shows neither card');
  const record = comic.comicRecordWithSheet(described([0, 2]), { cast: [{ name: '甲', look: '黑色短发' }] });
  Object.assign(c, { reader, coreadComicRecord: () => record, readerView: { chapterIndex: 5 }, coreadComicFill: null, coreadComicPlanInput: () => ({ hasImage: () => true }) });
  const html = c.renderMemRecordsTab(m);
  assert.doesNotMatch(html, /书籍蒸馏|sd-reader-distill-text/);
  assert.match(html, /漫画识图/); assert.match(html, /阅读方向/); assert.match(html, /已建稿 <b>3<\/b> \/ 已读 6 页/); assert.match(html, /补齐未识别的 3 页/);
  assert.match(html, /人物表/); assert.match(html, /class="sd-reader-minput sd-reader-comic-cast-name" placeholder="称呼" maxlength="40" value="甲"/);
  assert.match(html, /对切片进行二次总结/, 'the cards after it are still rendered');
});
