import test from 'node:test';
import assert from 'node:assert/strict';
import { planComicSlices, comicSliceText, COMIC_SLICE_PAGES } from '../qianmu-reader-comic.js';

const seg = (from, to, extra = {}) => ({ fromPage: from, toPage: to, summary: `总结${from}-${to}`, keywords: [`k${from}`], updatedAt: from, ...extra });
const record = (...segments) => ({ segments });
const plan = (segments, opts) => planComicSlices(record(...segments), segments, opts).map((g) => [g.fromPage, g.toPage]);

test('one comic memory covers at most 10 pages (user 2026-11-26)', () => {
  assert.equal(COMIC_SLICE_PAGES, 10);
  const threes = [seg(1, 3), seg(4, 6), seg(7, 9), seg(10, 12)];
  assert.deepEqual(plan(threes, { final: true }), [[1, 9], [10, 12]]);
  assert.deepEqual(plan([seg(1, 5), seg(6, 10), seg(11, 15)], { final: true }), [[1, 10], [11, 15]]);
  assert.deepEqual(plan([seg(1, 12)], { final: true }), [[1, 12]], 'a single segment longer than 10 pages stays whole');
});

test('while following along the last group waits if the next segment could still fit; a closed group is written', () => {
  assert.deepEqual(plan([seg(1, 3)]), []);
  assert.deepEqual(plan([seg(1, 3), seg(4, 6)]), []);
  assert.deepEqual(plan([seg(1, 3), seg(4, 6), seg(7, 9)]), [[1, 9]], '9 + 3 would pass 10: done');
  assert.deepEqual(plan([seg(1, 3), seg(4, 6), seg(7, 9), seg(10, 12)]), [[1, 9]], 'the next group starts waiting');
  assert.deepEqual(plan([seg(1, 5), seg(6, 10)]), [[1, 10]]);
});

test('a gap in described pages ends a group; summaries join in page order', () => {
  assert.deepEqual(plan([seg(7, 9), seg(1, 3)], { final: true }), [[1, 3], [7, 9]]);
  const [group] = planComicSlices(record(seg(4, 6), seg(1, 3, { keywords: ['甲', 'k4'] })), [seg(1, 3, { keywords: ['甲', 'k4'] }), seg(4, 6)], { final: true });
  assert.equal(group.summary, '总结1-3\n总结4-6');
  assert.deepEqual(group.keywords, ['甲', 'k4']);
  assert.equal(group.updatedAt, 4);
  assert.deepEqual(comicSliceText(record(seg(1, 3), seg(4, 6), seg(7, 9)), 4, 9).summary, '总结4-6\n总结7-9');
});
