// 伴读笔记跟随 ST 账户：一本书一份账户文件，哪边改过听哪边，两边都改过较晚的一份生效、另一份留在本机冲突仓；
// confirm 只在账户里确实是本机这一份时为真（旧笔记换算后据此才记 notesAt）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createReaderNotesSync, readerNotesSlot, READER_NOTES_INDEX_SLOT } from '../qianmu-reader-notes-sync.js';
import { accountMirrorSlot } from '../qianmu-account-mirror.js';

function fakeIndexedDB() {
  const databases = new Map();
  return { databases, open(name) {
    const request = {};
    if (!databases.has(name)) databases.set(name, new Map());
    const stores = databases.get(name);
    const rowsOf = storeName => { if (!stores.has(storeName)) stores.set(storeName, new Map()); return stores.get(storeName); };
    const db = { objectStoreNames: { contains: () => true }, createObjectStore() {}, close() {},
      transaction() {
        const tx = {}, pending = [], later = fn => { const r = {}; pending.push(() => { r.result = fn(); r.onsuccess?.(); }); return r; };
        queueMicrotask(() => { while (pending.length) pending.shift()(); queueMicrotask(() => { while (pending.length) pending.shift()(); tx.oncomplete?.(); }); });
        tx.objectStore = storeName => { const rows = rowsOf(storeName); return {
          put(value) { rows.set(value.id, structuredClone(value)); return {}; },
          delete(id) { rows.delete(id); return {}; },
          getAll: () => later(() => [...rows.values()].map(row => structuredClone(row))),
          getAllKeys: () => later(() => [...rows.keys()]),
        }; };
        return tx;
      } };
    queueMicrotask(() => { request.result = db; request.onsuccess?.(); });
    return request;
  } };
}
function fakeAccount() {
  const slots = new Map(); let counter = 0;
  return { slots, writes: 0, offline: false,
    async read(slot) { if (this.offline) throw new Error('offline'); const entry = slots.get(slot); return entry ? { exists: true, value: structuredClone(entry.value), fingerprint: entry.fingerprint } : { exists: false }; },
    async write(slot, value, { expectedFingerprint } = {}) {
      if (this.offline) throw new Error('offline');
      const entry = slots.get(slot);
      assert.equal(expectedFingerprint ?? null, entry ? entry.fingerprint : null, `conditional write of ${slot}`);
      slots.set(slot, { value: structuredClone(value), fingerprint: 'f' + (++counter) }); this.writes++;
      return { fingerprint: 'f' + counter };
    } };
}
// 一台设备：自己的 reader_notes（原样存，不改 updatedAt，和真实仓一样）与自己的同步记录库。
function device(account, { configured = () => true } = {}) {
  const notes = new Map(), idb = fakeIndexedDB(), downloaded = [], removed = [];
  const store = { listKeys: async () => [...notes.keys()], get: async key => (notes.has(key) ? structuredClone(notes.get(key)) : undefined),
    put: async (key, record) => { notes.set(key, structuredClone(record)); return key; }, delete: async key => { notes.delete(key); } };
  const sync = createReaderNotesSync({ store, resolveNamespace: async () => 'st-user:test', indexedDB: idb, storageFactory: async () => account, isConfigured: configured,
    onDownloaded: ids => downloaded.push(...ids), onRemoved: ids => removed.push(...ids), schedule: (fn, ms) => { if (ms > 1000) return 0; return setTimeout(fn, ms); }, cancel: () => {} });
  const conflicts = () => [...(idb.databases.get('qianmu-reader-notes-sync::st-user:test')?.get('conflicts')?.values() || [])];
  return { notes, store, sync, downloaded, removed, conflicts };
}
const record = (updatedAt, ...texts) => ({ v: 1, updatedAt, notes: texts.map((text, i) => ({ id: `n${i}`, kind: 'highlight', from: i * 10, to: i * 10 + 4, ch: 0, text, at: updatedAt, updatedAt })) });
const quiet = async work => { const warn = console.warn; console.warn = () => {}; try { return await work(); } finally { console.warn = warn; } };

test('one account file per book under its own prefix, plus the reader-notes index', async () => {
  assert.equal(READER_NOTES_INDEX_SLOT, 'reader-notes');
  assert.equal(readerNotesSlot('book-1'), accountMirrorSlot('reader-notes-', 'book-1'));
  assert.match(readerNotesSlot('book-1'), /^reader-notes-[0-9a-f]{40}$/);
  const account = fakeAccount(), a = device(account);
  await a.sync.put('book-1', record(100, '第一条'));
  assert.equal((await a.sync.run()).uploaded, 1);
  assert.ok(account.slots.has(readerNotesSlot('book-1')));
  const index = account.slots.get(READER_NOTES_INDEX_SLOT).value;
  assert.deepEqual(Object.values(index.entries), [{ key: 'book-1', token: 100, bytes: index.entries[readerNotesSlot('book-1')].bytes }]);
});

test('notes written on one device appear on another, and later edits travel back', async () => {
  const account = fakeAccount(), a = device(account), b = device(account);
  await a.sync.put('book-1', record(100, '划线一'));
  await a.sync.run();
  assert.equal(await b.sync.refresh('book-1'), true);
  assert.deepEqual(await b.store.get('book-1'), record(100, '划线一'));assert.deepEqual(b.downloaded, ['book-1']);
  await b.sync.put('book-1', record(200, '划线一', '划线二'));
  await b.sync.run(); await a.sync.run();
  assert.deepEqual((await a.store.get('book-1')).notes.map(note => note.text), ['划线一', '划线二']);
  assert.equal(a.conflicts().length + b.conflicts().length, 0, 'one side changed at a time: no conflict');
});

test('both sides changed: the later write wins and the other copy is kept locally', async () => {
  const account = fakeAccount(), a = device(account), b = device(account);
  await a.sync.put('book-1', record(100, '原样'));
  await a.sync.run(); await b.sync.run();
  await a.sync.put('book-1', record(300, '甲设备改的'));
  await b.sync.put('book-1', record(250, '乙设备改的'));
  await b.sync.run();   // 乙先传上去
  const result = await a.sync.run();   // 甲也改过：它的较晚，留甲的，乙那份进甲的冲突仓
  assert.equal(result.conflicts, 1);
  assert.equal((await a.store.get('book-1')).notes[0].text, '甲设备改的');
  assert.equal(a.conflicts().length, 1);assert.match(a.conflicts()[0].text, /乙设备改的/);assert.equal(a.conflicts()[0].side, 'account');
  await b.sync.run();
  assert.equal((await b.store.get('book-1')).notes[0].text, '甲设备改的', 'the later write reaches the other device');
});

test('confirm is true only once the account holds exactly this copy', async () => {
  const account = fakeAccount();
  let configured = false;
  const a = device(account, { configured: () => configured });
  await a.store.put('book-1', record(100, '换算出来的'));
  assert.equal(await a.sync.confirm('book-1'), false, 'no account storage: not confirmed');
  configured = true; account.offline = true;
  assert.equal(await quiet(() => a.sync.confirm('book-1')), false, 'the upload failed: not confirmed');
  account.offline = false;
  assert.equal(await a.sync.confirm('book-1'), true);
  assert.equal(await a.sync.synced('book-1'), true);
  await a.store.put('book-1', record(150, '换算出来的', '又划一条'));
  assert.equal(await a.sync.synced('book-1'), false, 'a local change since the last round is not on the account yet');
  assert.equal(await a.sync.confirm('book-1'), true);
  assert.equal(await a.sync.confirm(''), false);assert.equal(await a.sync.synced('missing'), false);
});

test('one-time conversion: a device that finds the book already converted on the account adopts that copy', async () => {
  const account = fakeAccount(), a = device(account), b = device(account);
  // 甲先开书：账户里没有，本机换算、写入、确认上传
  await a.sync.refresh('book-1');
  assert.equal(await a.store.get('book-1'), undefined);
  await a.store.put('book-1', record(40, '旧划线'));
  assert.equal(await a.sync.confirm('book-1'), true);
  // 乙后开书：先取一次，账户里已有，就用它，不再从旧笔记换算
  await b.sync.refresh('book-1');
  assert.deepEqual(await b.store.get('book-1'), record(40, '旧划线'));
  // 两台设备各自换算出同一份（换算只由旧笔记与正文决定）：初次见面也不算冲突
  const c = device(account);
  await c.store.put('book-1', record(40, '旧划线'));
  assert.equal((await c.sync.run()).conflicts, 0);assert.equal(c.conflicts().length, 0);
});

test('deleting a book removes its notes on the other devices too', async () => {
  const account = fakeAccount(), a = device(account), b = device(account);
  await a.sync.put('book-1', record(100, '要删'));
  await a.sync.put('book-2', record(100, '留着'));
  await a.sync.run(); await b.sync.run();
  a.notes.delete('book-1');
  const outcome = await a.sync.remove(['book-1']);
  assert.deepEqual(outcome.synced, ['book-1']);
  await b.sync.run();
  assert.equal(await b.store.get('book-1'), undefined);assert.deepEqual(b.removed, ['book-1']);
  assert.deepEqual((await b.store.get('book-2')).notes[0].text, '留着');
});

test('the reader wires the mirror: background round, request after a write, removal with the book, and the unit store', async () => {
  const source = await readFile(new URL('../index.js', import.meta.url), 'utf8');
  assert.match(source, /const readerNotesSync=createReaderNotesSync\(\{store:\{listKeys:\(\)=>blobStore\.listReaderNoteKeys\(\),get:key=>blobStore\.getReaderNotes\(key\),put:\(key,record\)=>blobStore\.putReaderNotes\(key,record\),delete:key=>blobStore\.deleteReaderNotes\(key\)\}/);
  assert.match(source, /quiet\(\(\) => COREAD_ENABLED \? readerNotesSync\.run\(\) : null\)/);
  assert.match(source, /void readerNotesSync\.remove\(\[bookId\]\);/);
  assert.match(source, /void readerNotesSync\.put\(bookId, record\)\.catch\(/);
  const load = source.slice(source.indexOf('async function coreadLoadReaderNotes'), source.indexOf('// 账户里确认已是本机这一份之后'));
  assert.match(load, /if \(!record && legacy\) \{\s*await readerNotesSync\.refresh\(bookId\);[\s\S]*reader\.convertLegacyNotes\(meta\.notes, readerContentCache\.projection\)/, 'refresh first, adopt, otherwise convert');
  assert.doesNotMatch(load, /meta\.notes\s*=/, 'the old notes stay frozen');
  const confirm = source.slice(source.indexOf('async function coreadConfirmNotes'), source.indexOf('function coreadSyncNoteCount'));
  assert.match(confirm, /if \(!await readerNotesSync\.confirm\(bookId\)\) return;[\s\S]*meta\.notesAt = Date\.now\(\);/, 'notesAt only after the upload is confirmed');
});
