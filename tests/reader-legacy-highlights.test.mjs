// 旧划线（章号 + 文字，有的带逐段 segments）一次性换成全局位置：一处、多处、跨段、找不到。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createProjection } from '../features/reader/qianmu-reader-model.js';
import { convertLegacyNotes, locateLegacyText, normalizeNotesRecord, chapterMarks, keepCandidate, dropCandidate, notePlaced } from '../features/reader/qianmu-reader-notes.js';

// 中性占位文字。第二章有一句话出现三次、有空行、有缩进、有插图占位。
const chapters = [
  { title: '第一节', content: '开头一段。\n这一行只出现一次。\n结尾。' },
  { title: '第二节', content: '　　同一句话。\n中间隔开。\n\n　　同一句话。\n⟦img:1⟧\n后面又有：同一句话。\n跨段的前半\n　　跨段的后半。' },
  { title: '第三节', content: '' },
];
const projection = createProjection(chapters);
const start = projection.starts[1], body = chapters[1].content;
const text = (from, to) => projection.slice(from, to);

test('one match: the highlight is anchored where the words are, in global coordinates', () => {
  const record = convertLegacyNotes([{ id: 'n1', kind: 'highlight', chapterIndex: 0, text: '只出现一次', hlStyle: 'wavy', color: '#112233', annotation: '想法', tags: ['t'], favorite: true, at: 50 }], projection);
  const [note] = record.notes;
  assert.equal(text(note.from, note.to), '只出现一次');
  assert.equal(note.ch, 0);assert.equal(note.candidates, undefined);
  assert.deepEqual({ ...note, from: 0, to: 0 }, { id: 'n1', kind: 'highlight', text: '只出现一次', hlStyle: 'wavy', color: '#112233', annotation: '想法', tags: ['t'], favorite: true, at: 50, updatedAt: 50, ch: 0, from: 0, to: 0 },
    'everything the old note had is kept; chapterIndex and segments are replaced by positions');
  assert.equal(record.updatedAt, 50);
});

test('several matches: the first one wins, the others wait in the pick list', () => {
  const [note] = convertLegacyNotes([{ id: 'n2', kind: 'highlight', chapterIndex: 1, text: '同一句话', at: 7 }], projection).notes;
  const places = [...body.matchAll(/同一句话/g)].map(m => start + m.index);
  assert.equal(places.length, 3);
  assert.equal(note.from, places[0]);assert.equal(note.to, places[0] + 4);
  assert.deepEqual(note.candidates, places.slice(1).map(from => ({ from, to: from + 4 })));
  // 渲染：本章只画第一处，另外两处画成待挑的虚线
  const marks = chapterMarks([note], start, body.length);
  assert.deepEqual(marks.map(m => [m.pick ?? 'mark', body.slice(m.from, m.to)]), [['mark', '同一句话'], [0, '同一句话'], [1, '同一句话']]);
  assert.deepEqual(chapterMarks([note], 0, projection.lengthOf(0)), [], 'nothing leaks into another chapter');
});

test('across paragraphs: segments are found in order and joined into one range; whitespace and the image line in between do not matter', () => {
  const [note] = convertLegacyNotes([{ id: 'n3', kind: 'highlight', chapterIndex: 1, text: '跨段的前半\n\n跨段的后半', segments: ['跨段的前半', '跨段的后半。'] }], projection).notes;
  assert.equal(text(note.from, note.to), '跨段的前半\n　　跨段的后半。');
  // 没有 segments 的旧划线，选区文字里的换行与正文的换行、缩进不一样，也找得到
  const [old] = convertLegacyNotes([{ id: 'n4', kind: 'highlight', chapterIndex: 1, text: '中间隔开。 同一句话' }], projection).notes;
  assert.equal(text(old.from, old.to), '中间隔开。\n\n　　同一句话');
  assert.deepEqual(locateLegacyText(body, ['同一句话。', '后面又有']), [{ from: body.indexOf('同一句话。\n⟦img'), to: body.indexOf('后面又有') + 4 }], 'only an image placeholder sits between the two parts');
  assert.deepEqual(locateLegacyText(body, ['开头', '结尾']), [], 'parts that are not next to each other do not chain');
});

test('no match: from is null and the note goes to the unplaced group; odd old data never throws', () => {
  const record = convertLegacyNotes([
    { id: 'n5', kind: 'highlight', chapterIndex: 1, text: '书里没有这句', annotation: '留着' },
    { id: 'n6', kind: 'highlight', chapterIndex: 9, text: '同一句话' },
    { id: 'n7', kind: 'highlight', chapterIndex: 1, text: '   ' },
    { kind: 'highlight', chapterIndex: 'x', text: null },
    { id: 'n5', kind: 'bookmark', chapterIndex: 1, text: '第二节' },
    { id: 'n8', kind: 'bookmark', chapterIndex: 2 },
    null, 'text', { id: 'n9', kind: 'other' },
  ], projection);
  const byId = Object.fromEntries(record.notes.map(note => [note.id, note]));
  for (const id of ['n5', 'n6', 'n7', 'legacy-3']) { assert.equal(byId[id].from, null, id); assert.equal(byId[id].to, null, id); assert.equal(notePlaced(byId[id]), false); }
  assert.equal(byId.n5.annotation, '留着');assert.equal(byId.n6.ch, 9, 'the old chapter number is still shown');
  assert.equal(byId['n5-4'].kind, 'bookmark', 'a repeated id gets its own');assert.equal(byId['n5-4'].from, start);
  assert.equal(byId.n8.from, projection.starts[2]);
  assert.equal(record.notes.length, 6);
  assert.deepEqual(convertLegacyNotes(undefined, projection), { v: 1, notes: [], updatedAt: 1 });
  assert.deepEqual(convertLegacyNotes([{ id: 'a', kind: 'highlight', chapterIndex: 0, text: '开头' }], createProjection([])).notes[0].from, null);
});

test('two devices converting the same old notes get the same record', () => {
  const legacy = [{ id: 'a', kind: 'highlight', chapterIndex: 1, text: '同一句话', at: 30 }, { id: 'b', kind: 'bookmark', chapterIndex: 0, at: 40 }];
  assert.equal(JSON.stringify(convertLegacyNotes(legacy, createProjection(structuredClone(chapters)))), JSON.stringify(convertLegacyNotes(legacy, projection)));
  assert.equal(convertLegacyNotes(legacy, projection).updatedAt, 40);
});

test('picking from the list: keep makes its own highlight, drop forgets the place; the last pick clears the list', () => {
  let record = convertLegacyNotes([{ id: 'n2', kind: 'highlight', chapterIndex: 1, text: '同一句话', hlStyle: 'underline', annotation: '只属于第一处', at: 7 }], projection);
  const [second, third] = record.notes[0].candidates;
  record = keepCandidate(record, 'n2', 1, { id: 'kept', now: 99, chapterOf: pos => projection.unitAt(pos) });
  const kept = record.notes.find(note => note.id === 'kept');
  assert.deepEqual([kept.from, kept.to, kept.ch, kept.hlStyle, kept.annotation, kept.at], [third.from, third.to, 1, 'underline', '', 99]);
  assert.deepEqual(record.notes[0].candidates, [second]);
  record = dropCandidate(record, 'n2', 0, { now: 100 });
  assert.equal('candidates' in record.notes[0], false);assert.equal(record.updatedAt, 100);
  assert.equal(dropCandidate(record, 'n2', 0, { now: 101 }).notes.length, 2, 'nothing left to drop is a no-op');
});

test('records read back from storage, the account or a package are cleaned without throwing', () => {
  assert.equal(normalizeNotesRecord(null), null);assert.equal(normalizeNotesRecord({ notes: 'x' }), null);
  const record = normalizeNotesRecord({ v: 1, updatedAt: 'later', notes: [{ id: 'a', kind: 'highlight', from: '3', to: 9, candidates: [{ from: 1, to: 0 }, { from: 2, to: 4 }, 'x'] },
    { id: 'a', kind: 'highlight' }, { id: '', kind: 'bookmark' }, { id: 'b', kind: 'bookmark', from: 'nope', ch: '2' }, { kind: 'x' }] });
  assert.deepEqual(record, { v: 1, updatedAt: 0, notes: [{ id: 'a', kind: 'highlight', from: 3, to: 9, ch: 0, candidates: [{ from: 2, to: 4 }] }, { id: 'b', kind: 'bookmark', from: null, ch: 2 }] });
});
