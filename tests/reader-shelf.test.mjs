import test from 'node:test';
import assert from 'node:assert/strict';
import { parseShelfSort, shelfSortFor, flipShelfSort, sortShelfBooks, normalizeTags, shelfTags, tagColor, applyTagEdits, bookSearchFields, matchBook, searchCounts, TAG_PALETTE } from '../features/reader/qianmu-reader-shelf.js';

const books = () => [
  { id: 'a', title: '乙书', author: '王', progress: 10, lastReadAt: 3, addedAt: 1, charCount: 500, tags: ['悬疑', '长篇'] },
  { id: 'b', title: '甲书', author: '李', progress: 90, lastReadAt: 1, addedAt: 2, charCount: 100, tags: ['悬疑'] },
  { id: 'c', title: '丙书', author: '张', progress: 50, lastReadAt: 2, addedAt: 3, charCount: 300, tags: [] },
];

test('sort keys: field plus direction, switching field takes its natural direction, flipping keeps the field', () => {
  assert.deepEqual(parseShelfSort('title-asc'), { field: 'title', dir: 'asc', name: '书名' });
  assert.equal(parseShelfSort('nonsense').field, 'addedAt');
  assert.equal(parseShelfSort('progress').dir, 'desc');
  assert.equal(shelfSortFor('author'), 'author-asc');
  assert.equal(shelfSortFor('together'), 'together-desc');
  assert.equal(flipShelfSort('lastReadAt-desc'), 'lastReadAt-asc');
});

test('sorting by each field in both directions; together uses the reading log', () => {
  const ids = (key, opts) => sortShelfBooks(books(), key, opts).map(b => b.id).join('');
  assert.equal(ids('lastReadAt-desc'), 'acb');
  assert.equal(ids('lastReadAt-asc'), 'bca');
  assert.equal(ids('progress-desc'), 'bca');
  assert.equal(ids('length-asc'), 'bca');
  assert.equal(ids('addedAt-desc'), 'cba');
  assert.equal(ids('together-desc', { together: b => ({ a: 5, b: 9, c: 0 })[b.id] }), 'bac');
  const original = books(); sortShelfBooks(original, 'title-asc');
  assert.equal(original.map(b => b.id).join(''), 'abc');   // 不改原数组
});

test('tags: input is split, cleaned and capped; shelf tags are counted; colours are stable or picked', () => {
  assert.deepEqual(normalizeTags('悬疑，长篇、 悬疑;  ;短篇 校园'), ['悬疑', '长篇', '短篇', '校园']);
  assert.equal(normalizeTags(Array.from({ length: 20 }, (_, i) => `t${i}`)).length, 12);
  assert.equal(normalizeTags(['一二三四五六七八九十一二三四五六七八九十多'])[0].length, 20);
  assert.deepEqual(shelfTags(books()), [{ tag: '悬疑', count: 2 }, { tag: '长篇', count: 1 }]);
  assert.ok(TAG_PALETTE.includes(tagColor('悬疑')));
  assert.equal(tagColor('悬疑'), tagColor('悬疑'));
  assert.equal(tagColor('悬疑', { 悬疑: '#ABCDEF' }), '#abcdef');
  assert.ok(TAG_PALETTE.includes(tagColor('悬疑', { 悬疑: 'red' })));
});

test('tag edits rename (merging into an existing tag), delete and recolour in one go', () => {
  const list = books();
  let colors = applyTagEdits(list, { 长篇: '#111111', 旧: '#222222' }, [{ from: '长篇', to: '悬疑' }]);   // 并进已有的
  assert.deepEqual(list.map(b => b.tags), [['悬疑'], ['悬疑'], []]);
  assert.deepEqual(colors, {});                                          // 改走与没书的名字不再留颜色
  colors = applyTagEdits(list, colors, [{ from: '悬疑', to: '推理', color: '#333333' }]);
  assert.deepEqual(list.map(b => b.tags), [['推理'], ['推理'], []]);
  assert.deepEqual(colors, { 推理: '#333333' });
  // 同一次里的几处改名按改之前的名字算：甲改成乙、乙改成丙，两个都改
  const swap = [{ tags: ['甲', '乙'] }];
  applyTagEdits(swap, {}, [{ from: '甲', to: '乙' }, { from: '乙', to: '丙' }]);
  assert.deepEqual(swap[0].tags, ['乙', '丙']);
  const again = applyTagEdits(list, colors, [{ from: '推理', remove: true }]);
  assert.deepEqual(list.map(b => b.tags), [[], [], []]);
  assert.deepEqual(again, {});
});

test('search can look in one field or all of them and counts hits per field', () => {
  const index = books().map(b => bookSearchFields(b, { collection: b.id === 'c' ? '悬疑合集' : '', pals: b.id === 'a' ? ['书友甲'] : [] }));
  assert.equal(matchBook(index[0], '书友', 'pals'), true);
  assert.equal(matchBook(index[0], '书友', 'title'), false);
  assert.equal(matchBook(index[2], '悬疑', 'tags'), false);
  assert.equal(matchBook(index[2], '悬疑', 'collection'), true);
  assert.equal(matchBook(index[1], '', 'tags'), true);
  assert.deepEqual(searchCounts(index, '悬疑'), { all: 3, title: 0, author: 0, tags: 2, collection: 1, pals: 0 });
  assert.equal(matchBook(bookSearchFields({ title: 'ABC' }), 'abc'), true);   // 不分大小写
});
