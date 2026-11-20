import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createReaderChatSync, readerChatSlot, READER_CHAT_INDEX_SLOT } from '../qianmu-reader-chat-sync.js';

// In-memory IndexedDB with named object stores (keyPath `id`), enough for the sync memory.
function fakeIndexedDB() {
  const databases = new Map();
  return { databases, open(name) {
    const request = {};
    if (!databases.has(name)) databases.set(name, new Map());
    const stores = databases.get(name);
    const rowsOf = storeName => { if (!stores.has(storeName)) stores.set(storeName, new Map()); return stores.get(storeName); };
    const db = { objectStoreNames: { contains: () => true }, createObjectStore() {}, close() {},
      transaction() {
        const tx = {};
        const pending = []; const later = fn => { const r = {}; pending.push(() => { r.result = fn(); r.onsuccess?.(); }); return r; };
        queueMicrotask(() => { while (pending.length) pending.shift()(); queueMicrotask(() => { while (pending.length) pending.shift()(); tx.oncomplete?.(); }); });
        tx.objectStore = storeName => { const rows = rowsOf(storeName); return {
          put(value) { if (databases.failWrites) throw new Error('disk full'); rows.set(value.id, structuredClone(value)); return {}; },
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
// One ST account: slots with fingerprints; writes are conditional.
function fakeAccount() {
  const slots = new Map(); let counter = 0;
  return { slots, writes: 0, failNext: 0, failSlot: null,
    async read(slot) { const entry = slots.get(slot); return entry ? { exists: true, value: structuredClone(entry.value), fingerprint: entry.fingerprint } : { exists: false }; },
    async write(slot, value, { expectedFingerprint } = {}) {
      if (this.failNext > 0) { this.failNext--; throw new Error('offline'); }
      if (this.failSlot === slot) throw new Error('offline');
      const entry = slots.get(slot);
      assert.equal(expectedFingerprint ?? null, entry ? entry.fingerprint : null, `conditional write of ${slot}`);
      slots.set(slot, { value: structuredClone(value), fingerprint: 'f' + (++counter) }); this.writes++;
      return { fingerprint: 'f' + counter };
    } };
}
// One browser: its own conversations store (updatedAt stamped on put, like the real one) and its own IndexedDB.
// `canDelete: false` is a mirror of the older kind, whose store has no delete.
function device(account, { clock, canDelete = true }) {
  const chats = new Map(), idb = fakeIndexedDB(), timers = [], removed = [], hold = { listing: null };
  const store = { listKeys: async () => { if (hold.listing) await hold.listing; return [...chats.keys()]; }, get: async key => (chats.has(key) ? structuredClone(chats.get(key)) : undefined),
    put: async (key, record) => { chats.set(key, { ...structuredClone(record), updatedAt: clock.tick() }); return key; },
    ...(canDelete ? { delete: async key => { chats.delete(key); } } : {}) };
  const sync = createReaderChatSync({ store, resolveNamespace: async () => 'st-user:test', indexedDB: idb, storageFactory: async () => account, isConfigured: () => true,
    onRemoved: keys => removed.push(...keys),
    schedule: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, cancel: () => {} });
  const memory = name => [...(idb.databases.get('qianmu-reader-chat-sync::st-user:test')?.get(name)?.values() || [])];
  return { chats, store, sync, timers, idb, removed, memory, hold };
}
// Two devices on one account, each holding the same three synced records: two books' conversations and a comic script.
async function pair() {
  const account = fakeAccount(), clock = clockOf(), a = device(account, { clock }), b = device(account, { clock });
  await a.store.put('chat::book1', talk('一', '读到第三章'));
  await a.store.put('comic::book1', { bookId: 'book1', pages: { 1: '第一页的文字稿' } });
  await a.store.put('chat::book2', talk('二'));
  await a.sync.run(); await b.sync.run();
  assert.equal(b.chats.size, 3);
  return { account, clock, a, b };
}
// What the reader does when a book is deleted together with its memory: local first, then the account.
const deleteBook1 = device => { device.chats.delete('chat::book1'); device.chats.delete('comic::book1'); return device.sync.remove(['chat::book1', 'comic::book1']); };
const indexEntry = (account, key) => account.slots.get(READER_CHAT_INDEX_SLOT).value.entries[readerChatSlot(key)];
const clockOf = () => { let now = 1000; return { tick: () => (now += 10) }; };
const talk = (...lines) => ({ bookId: 'book1', messages: lines.map((text, i) => ({ id: 'm' + i, role: i % 2 ? 'assistant' : 'user', text })), summaries: [], slices: [], cursor: lines.length });
const quiet = async work => { const warn = console.warn; console.warn = () => {}; try { return await work(); } finally { console.warn = warn; } };

test('a conversation written on one device appears on another, and later edits travel both ways', async () => {
  const account = fakeAccount(), clock = clockOf(), a = device(account, { clock }), b = device(account, { clock });
  await a.store.put('chat::book1', talk('你好', '在读第一章'));
  assert.deepEqual(await a.sync.run(), { uploaded: 1, downloaded: 0, dismissed: 0, conflicts: 0, unchanged: 0, removed: 0, tombstoned: 0 });
  assert.ok(account.slots.has(readerChatSlot('chat::book1')) && account.slots.has(READER_CHAT_INDEX_SLOT));
  assert.equal(JSON.stringify(account.slots.get(readerChatSlot('chat::book1')).value).includes('在读第一章'), false, 'the account copy is compressed');

  assert.deepEqual(await b.sync.run(), { uploaded: 0, downloaded: 1, dismissed: 0, conflicts: 0, unchanged: 0, removed: 0, tombstoned: 0 });
  assert.deepEqual((await b.store.get('chat::book1')).messages, talk('你好', '在读第一章').messages);
  assert.deepEqual(await b.sync.run(), { uploaded: 0, downloaded: 0, dismissed: 0, conflicts: 0, unchanged: 1, removed: 0, tombstoned: 0 }, 'a download is not mistaken for a local edit');
  assert.deepEqual(await a.sync.run(), { uploaded: 0, downloaded: 0, dismissed: 0, conflicts: 0, unchanged: 1, removed: 0, tombstoned: 0 });

  await b.store.put('chat::book1', talk('你好', '在读第一章', '第二章开始了'));
  assert.equal((await b.sync.run()).uploaded, 1);
  assert.equal((await a.sync.run()).downloaded, 1);
  assert.equal((await a.store.get('chat::book1')).messages.length, 3);
  const writes = account.writes;
  await a.sync.run(); await b.sync.run(); await a.sync.run();
  assert.equal(account.writes, writes, 'settled: no ping-pong between devices');
});

test('opening a conversation first brings in the newer account copy; saving schedules only that conversation', async () => {
  const account = fakeAccount(), clock = clockOf(), a = device(account, { clock }), b = device(account, { clock });
  await a.sync.put('chat::book1', talk('一'));
  await a.sync.put('chat::book2', talk('甲'));
  assert.equal(a.timers.length, 1, 'several saves share one background round');
  a.timers.shift().fn(); await a.sync.run();
  assert.equal(account.slots.size, 3);
  assert.deepEqual((await b.sync.get('chat::book1')).messages, talk('一').messages, 'a fresh device gets the conversation on open');
  assert.equal(b.chats.has('chat::book2'), false, 'only the opened conversation was fetched');
  await a.sync.put('chat::book1', talk('一', '二')); a.timers.shift().fn(); await a.sync.run();
  assert.equal((await b.sync.get('chat::book1')).messages.length, 2, 'and the newer copy on the next open');
});

test('when both sides changed, the newer write wins and the other is kept on the device', async () => {
  const account = fakeAccount(), clock = clockOf(), a = device(account, { clock }), b = device(account, { clock });
  await a.store.put('chat::book1', talk('起点')); await a.sync.run(); await b.sync.run();
  await a.store.put('chat::book1', talk('起点', 'A 的续写')); await a.sync.run();
  await b.store.put('chat::book1', talk('起点', 'B 的续写'));           // written later than A's
  const round = await b.sync.run();
  assert.equal(round.conflicts, 1); assert.equal(round.uploaded, 1);
  const kept = [...b.idb.databases.get('qianmu-reader-chat-sync::st-user:test').get('conflicts').values()];
  assert.equal(kept.length, 1); assert.equal(kept[0].side, 'account'); assert.equal(JSON.parse(kept[0].text).messages[1].text, 'A 的续写');
  assert.equal((await a.sync.run()).downloaded, 1);
  assert.equal((await a.store.get('chat::book1')).messages[1].text, 'B 的续写');

  // The other direction: the local copy is older than the account's.
  await b.store.put('chat::book1', talk('起点', 'B 再写'));               // not synced yet
  await a.store.put('chat::book1', talk('起点', 'A 更晚')); await a.sync.run();
  const second = await b.sync.run();
  assert.equal(second.conflicts, 1); assert.equal(second.downloaded, 1);
  assert.equal((await b.store.get('chat::book1')).messages[1].text, 'A 更晚');
  const local = [...b.idb.databases.get('qianmu-reader-chat-sync::st-user:test').get('conflicts').values()].find(row => row.side === 'local');
  assert.equal(JSON.parse(local.text).messages[1].text, 'B 再写', 'the overwritten local version is recoverable');
});

test('a record that disappears without remove() is not propagated and not undone; a wiped browser gets everything back', async () => {
  const account = fakeAccount(), clock = clockOf(), a = device(account, { clock }), b = device(account, { clock });
  await a.store.put('chat::book1', talk('一')); await a.store.put('chat::book2', talk('二')); await a.sync.run(); await b.sync.run();
  a.chats.delete('chat::book1');                                            // the book was removed on device A
  const round = await a.sync.run();
  assert.equal(round.dismissed, 1); assert.equal(round.downloaded, 0);
  assert.equal(a.chats.has('chat::book1'), false, 'it does not come back here');
  assert.ok(account.slots.has(readerChatSlot('chat::book1')), 'the account copy is untouched');
  await b.sync.run(); assert.equal(b.chats.has('chat::book1'), true, 'other devices keep it');
  assert.deepEqual(await a.sync.run(), { uploaded: 0, downloaded: 0, dismissed: 0, conflicts: 0, unchanged: 1, removed: 0, tombstoned: 0 });

  const wiped = device(account, { clock });                                 // same account, empty profile
  assert.equal((await wiped.sync.run()).downloaded, 2);
  assert.deepEqual([...wiped.chats.keys()].sort(), ['chat::book1', 'chat::book2']);
});

test('a deletion asked for with remove() reaches the account, other devices drop their copy, and a new device never gets it', async () => {
  const { account, clock, a, b } = await pair();
  const outcome = await deleteBook1(a);
  assert.deepEqual(outcome, { registered: true, synced: ['chat::book1', 'comic::book1'], pending: [] });
  for (const key of ['chat::book1', 'comic::book1']) {
    const file = account.slots.get(readerChatSlot(key)).value, entry = indexEntry(account, key);
    assert.deepEqual(Object.keys(file).sort(), ['deleted', 'key', 'version'], 'the account file is a tombstone without a body');
    assert.equal(entry.deleted, true); assert.equal(entry.at, file.deleted); assert.equal(entry.key, key);
  }
  assert.equal(indexEntry(account, 'chat::book2').deleted, undefined, 'the other book is untouched');

  const round = await b.sync.run();
  assert.deepEqual(round, { uploaded: 0, downloaded: 0, dismissed: 0, conflicts: 0, unchanged: 1, removed: 2, tombstoned: 0 });
  assert.deepEqual([...b.chats.keys()], ['chat::book2']);
  assert.deepEqual(b.removed.sort(), ['chat::book1', 'comic::book1'], 'the reader is told which conversations went');
  assert.equal(b.memory('conflicts').length, 0, 'a copy with nothing unsynced needs no keepsake');

  const fresh = device(account, { clock });
  assert.equal((await fresh.sync.run()).downloaded, 1);
  assert.deepEqual([...fresh.chats.keys()], ['chat::book2'], 'a new device does not bring the deleted ones back');
  const writes = account.writes;
  await a.sync.run(); await b.sync.run(); await fresh.sync.run(); await a.sync.run();
  assert.equal(account.writes, writes, 'settled: tombstones cause no further traffic');
  assert.equal(a.chats.has('chat::book1'), false);
});

test('against a deletion, unsynced work is judged by time: later work survives and returns, earlier work goes but is kept', async () => {
  const { account, a, b } = await pair();
  // B wrote more, offline, and A deleted before B synced. One edit is older than the deletion, one is newer.
  b.chats.set('chat::book1', { ...talk('一', '读到第三章', 'B 在删除之前写的'), updatedAt: Date.now() - 60000 });
  b.chats.set('comic::book1', { bookId: 'book1', pages: { 1: '第一页的文字稿', 2: 'B 在删除之后识的图' }, updatedAt: Date.now() + 60000 });
  await deleteBook1(a);
  const round = await b.sync.run();
  assert.equal(round.removed, 1); assert.equal(round.uploaded, 1); assert.equal(round.conflicts, 1);
  assert.equal(b.chats.has('chat::book1'), false, 'the earlier edit loses to the deletion');
  const kept = b.memory('conflicts');
  assert.equal(kept.length, 1); assert.equal(kept[0].key, 'chat::book1'); assert.equal(kept[0].side, 'local');
  assert.equal(JSON.parse(kept[0].text).messages[2].text, 'B 在删除之前写的', 'but its full text stays on the device');
  assert.equal(b.chats.get('comic::book1').pages[2], 'B 在删除之后识的图', 'the later edit survives');
  assert.equal(indexEntry(account, 'comic::book1').deleted, undefined, 'and replaces the tombstone');
  assert.equal(indexEntry(account, 'chat::book1').deleted, true);

  assert.equal((await a.sync.run()).downloaded, 1, 'the device that deleted gets the later work back');
  assert.equal(a.chats.get('comic::book1').pages[2], 'B 在删除之后识的图');
  assert.equal(a.chats.has('chat::book1'), false);
  const writes = account.writes;
  await b.sync.run(); await a.sync.run();
  assert.equal(account.writes, writes, 'settled');
});

test('a deletion made offline is written later; a file written without its index entry is retried until both are there', async () => {
  const { account, a, b } = await pair();
  account.failNext = 99;
  const offline = await quiet(() => deleteBook1(a));
  assert.deepEqual(offline, { registered: true, synced: [], pending: ['chat::book1', 'comic::book1'] }, 'noted on the device, not yet in the account');
  assert.equal(indexEntry(account, 'chat::book1').deleted, undefined);
  assert.deepEqual((await b.sync.run()).removed, 0, 'other devices keep their copy until the account knows');

  // Back online, but the index write fails after the files were written.
  account.failNext = 0; account.failSlot = READER_CHAT_INDEX_SLOT;
  assert.deepEqual(await quiet(() => a.sync.run()), { failed: true });
  assert.equal(account.slots.get(readerChatSlot('chat::book1')).value.deleted > 0, true, 'the files are already tombstones');
  assert.equal(indexEntry(account, 'chat::book1').deleted, undefined, 'the index is not');
  assert.equal(a.memory('manifest').filter(row => row.pendingDelete).length, 2, 'so the request stays');

  account.failSlot = null;
  const round = await a.sync.run();
  assert.equal(round.tombstoned, 2);
  assert.equal(a.memory('manifest').filter(row => row.pendingDelete).length, 0);
  assert.equal(a.memory('manifest').filter(row => row.deleted).length, 2);
  assert.equal((await b.sync.run()).removed, 2);
  assert.deepEqual([...b.chats.keys()], ['chat::book2']);
  assert.equal((await a.sync.run()).tombstoned, 0, 'written once');
});

test('remove() during a round that is already running still handles its own keys', async () => {
  const { account, a, b } = await pair();
  // The round has read its memory of what was synced and is about to list the local records when the book is deleted:
  // it will find the two records gone without knowing a deletion was asked for.
  let open; a.hold.listing = new Promise(resolve => { open = resolve; });
  const background = a.sync.run();
  await new Promise(resolve => setTimeout(resolve, 5));
  const asked = deleteBook1(a);
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(a.memory('manifest').filter(row => row.pendingDelete).length, 2, 'the request is noted while the round is still running');
  a.hold.listing = null; open();
  assert.deepEqual(await asked, { registered: true, synced: ['chat::book1', 'comic::book1'], pending: [] });
  await background;
  assert.equal(indexEntry(account, 'chat::book1').deleted, true); assert.equal(indexEntry(account, 'comic::book1').deleted, true);
  assert.equal(a.memory('manifest').filter(row => row.deleted).length, 2, 'the running round did not overwrite the request');
  assert.equal(a.chats.has('chat::book1'), false, 'nor bring the record back');
  assert.equal((await b.sync.run()).removed, 2);
});

test('a record made again after its deletion is uploaded and returns everywhere', async () => {
  const { account, a, b } = await pair();
  await deleteBook1(a); await b.sync.run();
  await a.store.put('chat::book1', talk('重新开始读'));
  assert.equal((await a.sync.run()).uploaded, 1);
  assert.equal(indexEntry(account, 'chat::book1').deleted, undefined);
  assert.equal(indexEntry(account, 'comic::book1').deleted, true, 'the one not made again stays deleted');
  assert.equal((await b.sync.run()).downloaded, 1);
  assert.equal(b.chats.get('chat::book1').messages[0].text, '重新开始读');

  // Made again before the deletion ever reached the account: the request is dropped, nobody loses anything.
  const second = await pair();
  second.account.failNext = 99;
  await quiet(() => deleteBook1(second.a));
  second.account.failNext = 0;
  await second.a.store.put('chat::book1', talk('删了又建'));
  const round = await second.a.sync.run();
  assert.equal(round.uploaded, 1); assert.equal(round.tombstoned, 1, 'only the comic script is deleted');
  assert.equal(indexEntry(second.account, 'chat::book1').deleted, undefined);
  assert.equal((await second.b.sync.run()).removed, 1);
  assert.equal(second.b.chats.get('chat::book1').messages[0].text, '删了又建');
  assert.equal(second.a.memory('manifest').filter(row => row.pendingDelete).length, 0);
});

test('a mirror whose store cannot delete never removes anything, and a failed registration says so', async () => {
  const { account, clock, a } = await pair();
  const old = device(account, { clock, canDelete: false });
  await old.sync.run(); assert.equal(old.chats.size, 3);
  await deleteBook1(a);
  const round = await old.sync.run();
  assert.equal(round.removed, 0); assert.equal(old.chats.size, 3, 'a tombstone does not delete from a store without delete');
  assert.deepEqual(await old.sync.remove(['chat::book2']), { registered: false, synced: [], pending: ['chat::book2'] });
  assert.equal(indexEntry(account, 'chat::book2').deleted, undefined);
  const fresh = device(account, { clock, canDelete: false });
  await fresh.sync.run();
  assert.deepEqual([...fresh.chats.keys()], ['chat::book2'], 'and it does not download a tombstone as a record');

  a.chats.delete('chat::book2'); a.idb.databases.failWrites = true;
  assert.deepEqual(await quiet(() => a.sync.remove(['chat::book2'])), { registered: false, synced: [], pending: ['chat::book2'] }, 'the device could not even note the request');
  a.idb.databases.failWrites = false;
  assert.equal(indexEntry(account, 'chat::book2').deleted, undefined, 'the account copy stays');
  assert.deepEqual(await a.sync.remove([]), { registered: true, synced: [], pending: [] });
});

test('failures are retried, unportable records are skipped, and nothing runs without account storage', async () => {
  const account = fakeAccount(), clock = clockOf(), a = device(account, { clock });
  await a.store.put('chat::book1', talk('一'));
  account.failNext = 1;
  const failed = await quiet(() => a.sync.run());
  assert.equal(failed.uploaded, 0); assert.equal(account.slots.size, 0);
  assert.equal((await a.sync.run()).uploaded, 1, 'the next round uploads it');

  a.chats.set('chat::odd', { messages: [], blob: new Blob(['x']), updatedAt: clock.tick() });
  const round = await a.sync.run();
  assert.equal(round.uploaded, 0); assert.equal(account.slots.has(readerChatSlot('chat::odd')), false, 'a record JSON cannot carry is left local');

  const offline = createReaderChatSync({ store: a.store, resolveNamespace: async () => 'st-user:test', indexedDB: fakeIndexedDB(), storageFactory: async () => account, isConfigured: () => false });
  assert.deepEqual(await offline.run(), { skipped: true });
  assert.deepEqual((await offline.get('chat::book1')).messages, talk('一').messages, 'reading still works locally');
  assert.throws(() => createReaderChatSync({ store: {} }));
});

test('the reader reaches its conversations through the sync layer', async () => {
  const entry = await readFile(new URL('../index.js', import.meta.url), 'utf8');
  assert.match(entry, /const rec = await readerChatSync\.get\(bucket\);/);
  assert.match(entry, /await readerChatSync\.put\(readerDialog\.bucket, \{/);
  assert.match(entry, /quiet\(\(\) => COREAD_ENABLED \? readerChatSync\.run\(\) : null\)/);
  assert.match(entry, /delete:async key=>\{await blobStore\.deleteReaderChat\(key\);await blobStore\.deleteReaderVectors\(key\);\}/, 'a conversation deleted by the account takes its vectors along');
  assert.match(entry, /deleteMemory \? readerChatSync\.remove\(result\.chatKeys \|\| \[\]\) : \(readerChatSync\.request\(\), null\)/);
  assert.equal((entry.match(/readerChatSync\.remove\(/g) || []).length, 1, 'only deleting a book with its memory deletes from the account; storage cleanup does not');
});
