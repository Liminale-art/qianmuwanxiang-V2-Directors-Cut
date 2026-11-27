import test from 'node:test';
import assert from 'node:assert/strict';
import { READER_PAPERS, readerPaperOf, readerPaperVars, readerThemeSnapshot, normalizeReaderThemes, applyReaderTheme, sameReaderTheme, saveReaderTheme } from '../features/reader/qianmu-reader-theme.js';

const base = () => ({ fontSizePx: 19, lineHeight: 1.9, paraSpacing: 1, contentWidthRem: 42, justify: false, spacingPreset: 'normal' });

test('paper: follow adds nothing, built-ins and custom give paper and ink, bad values fall back', () => {
  assert.equal(readerPaperOf({}), null);
  assert.equal(readerPaperVars({ readerPaper: 'follow' }), '');
  assert.deepEqual(readerPaperOf({ readerPaper: 'night' }), { id: 'night', paper: READER_PAPERS.find(p => p.id === 'night').paper, ink: READER_PAPERS.find(p => p.id === 'night').ink });
  assert.deepEqual(readerPaperOf({ readerPaper: 'custom', readerPaperCustom: { paper: '#ABCDEF', ink: 'red' } }), { id: 'custom', paper: '#abcdef', ink: '#2e2a24' });
  assert.equal(readerPaperOf({ readerPaper: 'nope' }), null);
  assert.match(readerPaperVars({ readerPaper: 'cream' }), /^--rd-paper:#[0-9a-f]{6};--rd-ink:#[0-9a-f]{6};$/);
});

test('a scheme carries paper and typography; applying it sets everything, sameness is exact', () => {
  const c = { ...base(), readerPaper: 'custom', readerPaperCustom: { paper: '#eeeeee', ink: '#111111' }, fontSizePx: 22, spacingPreset: 'custom', lineHeight: 2.2 };
  const list = saveReaderTheme([], c, ' 夜里读 ', 't1');
  assert.equal(list.length, 1); assert.equal(list[0].name, '夜里读');
  const other = { ...base(), readerPaper: 'white' };
  assert.equal(sameReaderTheme(other, list[0]), false);
  applyReaderTheme(other, list[0]);
  assert.equal(other.readerPaper, 'custom'); assert.deepEqual(other.readerPaperCustom, { paper: '#eeeeee', ink: '#111111' });
  assert.equal(other.fontSizePx, 22); assert.equal(other.lineHeight, 2.2); assert.equal(other.spacingPreset, 'custom');
  assert.equal(sameReaderTheme(other, list[0]), true);
  other.fontSizePx = 23;
  assert.equal(sameReaderTheme(other, list[0]), false);
});

test('saving replaces a scheme with the same name, keeps at most twelve, values are clamped', () => {
  let list = [];
  for (let i = 0; i < 14; i++) list = saveReaderTheme(list, base(), `方案${i}`, `id${i}`);
  assert.equal(list.length, 12); assert.equal(list[0].name, '方案2');
  list = saveReaderTheme(list, { ...base(), fontSizePx: 99 }, '方案5', 'new');
  assert.equal(list.length, 12); assert.equal(list.at(-1).id, 'new'); assert.equal(list.at(-1).fontSizePx, 30);
  assert.deepEqual(saveReaderTheme(list, base(), '   ', 'x'), list);
  assert.deepEqual(normalizeReaderThemes([{ id: 'a' }, null, { id: 'a', name: 'x' }, { id: 'a', name: 'y' }]).map(t => t.name), ['x']);
  assert.equal(readerThemeSnapshot({}).spacingPreset, 'normal');
});
