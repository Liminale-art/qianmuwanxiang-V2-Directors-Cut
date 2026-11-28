// 坐标底座：投影、前缀和、按区间切片，以及 visibleWindowAt 与旧 computeVisibleWindow 逐字段相同。
import test from 'node:test';
import assert from 'node:assert/strict';
import { computeVisibleWindow } from '../qianmu-storyboard-utils.js';
import { chapterIndexAtOffset, planCoreadTextSpans } from '../qianmu-reader.js';
import { legacyUnits, createProjection, offsetFromRatio, positionAt, visibleWindowAt } from '../features/reader/qianmu-reader-model.js';

// 中性占位文字的旧书：章长不一，有空章、有句界字符、有插图占位与双空格（旧书投影原样保留它们）。
function seeded(seed) { let s = seed >>> 0; return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296); }
function oldBook(seed, chapters = 9) {
  const rand = seeded(seed), pieces = ['甲乙丙丁', '戊己庚辛。', '壬癸子丑！', '寅卯辰巳？', '午未…', '申酉」', '戌亥】', '天地）', 'abc)', '\n', '⟦img:2⟧', '  '];
  return Array.from({ length: chapters }, (_, i) => {
    const size = rand() < 0.15 ? 0 : Math.floor(rand() * 900);
    let content = '';
    while (content.length < size) content += pieces[Math.floor(rand() * pieces.length)];
    return { title: `第${i + 1}节`, content: content.slice(0, size) };
  });
}

test('legacy units are the prefix sums of the chapter lengths, the same ruler as before', () => {
  const chapters = [{ title: 'a', content: '12345' }, { title: 'b', content: '' }, { title: 'c', content: '1234567890' }, { title: 'd', content: 0 }];
  assert.deepEqual(legacyUnits(chapters), [
    { title: 'a', kind: 'toc', start: 0, length: 5 }, { title: 'b', kind: 'toc', start: 5, length: 0 },
    { title: 'c', kind: 'toc', start: 5, length: 10 }, { title: 'd', kind: 'toc', start: 15, length: 0 }]);
  const projection = createProjection(chapters);
  assert.deepEqual([...projection.starts], [0, 5, 5, 15]);
  assert.equal(projection.total, 15);
  assert.deepEqual(legacyUnits(null), []);
  assert.equal(createProjection(undefined).total, 0);
  assert.equal(createProjection([]).unitAt(3), null);
});

test('slice equals slicing the whole book joined together, for any range', () => {
  for (let seed = 1; seed <= 20; seed++) {
    const chapters = oldBook(seed), full = chapters.map(ch => String(ch.content || '')).join(''), projection = createProjection(chapters), rand = seeded(seed * 7);
    assert.equal(projection.total, full.length);
    for (let i = 0; i < 60; i++) {
      const a = Math.floor(rand() * (full.length + 20)) - 10, b = Math.floor(rand() * (full.length + 20)) - 10;
      assert.equal(projection.slice(a, b), full.slice(Math.max(0, a), Math.max(0, b)), `seed ${seed}: ${a}..${b}`);
    }
    assert.equal(projection.slice(0, full.length), full);
  }
});

test('unitAt follows chapterIndexAtOffset, empty chapters included', () => {
  for (let seed = 1; seed <= 12; seed++) {
    const chapters = oldBook(seed), projection = createProjection(chapters);
    for (let pos = -2; pos <= projection.total + 2; pos += 7) assert.equal(projection.unitAt(pos), chapterIndexAtOffset(chapters, pos), `seed ${seed} at ${pos}`);
    assert.equal(projection.unitAt(projection.total), chapterIndexAtOffset(chapters, projection.total));
  }
});

test('visibleWindowAt gives exactly what computeVisibleWindow gave on old books, sentence boundaries included', () => {
  const ratios = [0, 0.001, 0.13, 0.5, 0.731, 0.999, 1, -1, 2, NaN];
  const settings = [[15, 6000], [100, 1e9], [1, 200], [0, 0], [50, 800], [100, 250]];
  let compared = 0;
  for (let seed = 1; seed <= 25; seed++) {
    const chapters = oldBook(seed, 3 + (seed % 8)), projection = createProjection(chapters);
    for (let ci = -1; ci <= chapters.length; ci++) {
      for (const ratio of ratios) {
        const clamped = Math.max(0, Math.min(ci, chapters.length - 1));
        const readTo = positionAt(projection, ci, offsetFromRatio(projection.lengthOf(clamped), ratio));
        for (const [percent, cap] of settings) {
          assert.deepEqual(visibleWindowAt(projection, readTo, percent, cap), computeVisibleWindow(chapters, ci, ratio, percent, cap), `seed ${seed} ch ${ci} ratio ${ratio} ${percent}%/${cap}`);
          compared++;
        }
      }
    }
  }
  assert.ok(compared > 5000);
  // 没有章、只有空章
  for (const chapters of [[], [{ content: '' }, { content: '' }]]) {
    const projection = createProjection(chapters);
    assert.deepEqual(visibleWindowAt(projection, positionAt(projection, 0, 0), 15, 6000), computeVisibleWindow(chapters, 0, 0, 15, 6000));
  }
});

test('the read position is the old one: chapter start plus round(chapter length × ratio)', () => {
  const chapters = [{ content: '12345' }, { content: '1234567890' }], projection = createProjection(chapters);
  assert.equal(positionAt(projection, 1, offsetFromRatio(10, 0.5)), 10);
  assert.equal(positionAt(projection, 1, offsetFromRatio(10, 0.65)), computeVisibleWindow(chapters, 1, 0.65, 100, 1e9).readPos);
  assert.equal(positionAt(projection, 5, 99), 15, 'chapter and offset are clamped');
  assert.equal(positionAt(projection, 0, -3), 0);
  assert.equal(positionAt(createProjection([]), 2, 4), 0);
  // 偏移存下来再折回比例，读位不变
  for (let len = 1; len < 400; len += 13) for (const ratio of [0.1, 0.333, 0.5, 0.777, 0.95]) {
    const off = offsetFromRatio(len, ratio);
    assert.equal(offsetFromRatio(len, off / len), off);
  }
});

test('distill batches cut from a slice are the batches cut from the whole text', () => {
  const chapters = oldBook(3, 12), full = chapters.map(ch => String(ch.content || '')).join(''), projection = createProjection(chapters);
  for (const [from, to, cap] of [[0, full.length, 300], [17, 2400, 500], [100, 101, 50], [0, full.length, 0], [40, 40, 100]]) {
    const text = projection.slice(from, to);
    const viaSlice = planCoreadTextSpans(text, 0, text.length, cap).map(span => ({ from: from + span.from, to: from + span.to }));
    assert.deepEqual(viaSlice, planCoreadTextSpans(full, from, to, cap), `${from}..${to} cap ${cap}`);
  }
});
