// 伴读整包里的笔记：v6 每本书一份 annotations.json，恢复时写回 reader_notes；
// 旧包（v1–v5，以及笔记还没换算时导出的 v6）的笔记在书架条目里，恢复时走开书时同一个换算。
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCoreadPackage, readCoreadPackageFile, applyCoreadPackageData } from '../qianmu-reader-package.js';
import { createProjection } from '../features/reader/qianmu-reader-model.js';
import { convertLegacyNotes } from '../features/reader/qianmu-reader-notes.js';

const plain = value => !!value && typeof value === 'object' && !Array.isArray(value);
const chapters = [{ title: '一', content: '开头。\n要划的那句。\n结尾。' }];
const legacyNotes = [{ id: 'n1', kind: 'highlight', chapterIndex: 0, text: '要划的那句', at: 5 }, { id: 'b1', kind: 'bookmark', chapterIndex: 0, text: '一', at: 6 }];
const converted = convertLegacyNotes(legacyNotes, createProjection(chapters));
const notesFromLegacy = async (notes, list) => convertLegacyNotes(notes, createProjection(list));

function source({ withRecord }) {
  const books = [{ id: 'book', title: '占位书', notes: legacyNotes, ...(withRecord ? { notesAt: 9, noteCount: 2 } : {}) }];
  const reader = { getBook: async () => ({ fullText: '', chapters, sig: 's' }), getCover: async () => undefined,
    getReaderNotes: async id => (withRecord && id === 'book' ? converted : undefined),
    listReaderChatKeys: async () => [], listReaderImages: async () => [], listReaderVectorKeys: async () => [], listAudio: async () => [], listRetLog: async () => [] };
  return { books, reader };
}
function destination() {
  const notes = new Map(), books = new Map(), shelf = { books: [] }, restored = [];
  const writer = { putBookWithCover: async (id, record) => { books.set(id, record); }, putReaderNotes: async (id, record) => { notes.set(id, { ...structuredClone(record), updatedAt: 1000 }); },
    putReaderChat: async () => {}, putReaderImageByKey: async () => {}, putReaderVectors: async () => {}, bulkPutAudio: async () => ({ added: 0, skipped: 0, failed: 0 }), pushRetLog: async () => {} };
  return { notes, books, shelf, restored, writer };
}
const restore = async (target, data) => applyCoreadPackageData(data, { blobStore: target.writer, coread: () => target.shelf, isPlainObject: plain, base64ToBlob: () => null,
  warn: (message, error) => assert.fail(`${message}: ${error?.message}`), notesFromLegacy, onNotesRestored: id => target.restored.push(id) });

test('v6 carries each book’s notes record and restores it as this moment’s write', async () => {
  const from = source({ withRecord: true }), pack = await buildCoreadPackage({ bookMetas: from.books, prefs: {}, blobStore: from.reader });
  const data = await readCoreadPackageFile(new File([pack.blob], 'pack.zip'));
  assert.equal(data.books[0].annotations, 'books/1/annotations.json');
  const target = destination(), progress = await restore(target, data);
  assert.equal(progress.failed, 0);
  assert.deepEqual(target.notes.get('book').notes, converted.notes);assert.equal(target.notes.get('book').updatedAt, 1000, 'the writer stamps it now, so an older account copy cannot win');
  assert.deepEqual(target.restored, ['book']);
  assert.equal('notes' in target.shelf.books[0], false, 'the shelf entry no longer carries the frozen copy');assert.equal(target.shelf.books[0].notesAt, 9);
});

test('a v6 pack made before the conversion still restores the notes, converted the same way as at book opening', async () => {
  const from = source({ withRecord: false }), pack = await buildCoreadPackage({ bookMetas: from.books, prefs: {}, blobStore: from.reader });
  const data = await readCoreadPackageFile(new File([pack.blob], 'pack.zip'));
  assert.equal(data.books[0].annotations, null);
  const target = destination();
  await restore(target, data);
  assert.deepEqual(target.notes.get('book').notes, converted.notes);
  const note = target.notes.get('book').notes[0];
  assert.equal(chapters[0].content.slice(note.from, note.to), '要划的那句');
  assert.deepEqual(target.shelf.books[0].notes, legacyNotes, 'the old notes stay frozen in the shelf entry until S6');
});

test('v1–v5 JSON packs with notes inside the shelf entry are converted on restore; a book without text keeps them for later', async () => {
  const pack = { type: 'qianmu-coread', version: 5, books: [
    { meta: { id: 'book', title: '占位书', notes: legacyNotes }, fullText: chapters[0].content, chapters },
    { meta: { id: 'empty', title: '没有笔记' }, fullText: '', chapters: [] }] };
  const data = await readCoreadPackageFile(new File([JSON.stringify(pack)], 'pack.json', { type: 'application/json' }));
  const target = destination(), progress = await restore(target, data);
  assert.equal(progress.ok, 2);assert.equal(progress.failed, 0);
  assert.deepEqual([...target.notes.keys()], ['book']);assert.deepEqual(target.restored, ['book']);
  assert.deepEqual(target.notes.get('book').notes, converted.notes);
  // 换算失败只算这一项失败，书照常恢复
  const broken = destination(), warnings = [];
  await applyCoreadPackageData(data, { blobStore: broken.writer, coread: () => broken.shelf, isPlainObject: plain, base64ToBlob: () => null, warn: (...args) => warnings.push(args),
    notesFromLegacy: async () => { throw Error('conversion failed'); } });
  assert.equal(broken.books.size, 2);assert.equal(broken.notes.size, 0);assert.equal(warnings.length, 1);
});
