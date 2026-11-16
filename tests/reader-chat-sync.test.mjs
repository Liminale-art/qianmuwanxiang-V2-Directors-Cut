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
// One ST account: slots with fingerprints; writes are conditional.
function fakeAccount() {
  const slots = new Map(); let counter = 0;
  return { slots, writes: 0, failNext: 0,
    async read(slot) { const entry = slots.get(slot); return entry ? { exists: true, value: structuredClone(entry.value), fingerprint: entry.fingerprint } : { exists: false }; },
    async write(slot, value, { expectedFingerprint } = {}) {
      if (this.failNext > 0) { this.failNext--; throw new Error('offline'); }
      const entry = slots.get(slot);
      assert.equal(expectedFingerprint ?? null, entry ? entry.fingerprint : null, `conditional write of ${slot}`);
      slots.set(slot, { value: structuredClone(value), fingerprint: 'f' + (++counter) }); this.writes++;
      return { fingerprint: 'f' + counter };
    } };
}
// One browser: its own conversations store (updatedAt stamped on put, like the real one) and its own IndexedDB.
function device(account, { clock }) {
  const chats = new Map(), idb = fakeIndexedDB(), timers = [];
  const store = { listKeys: async () => [...chats.keys()], get: async key => (chats.has(key) ? structuredClone(chats.get(key)) : undefined),
    put: async (key, record) => { chats.set(key, { ...structuredClone(record), updatedAt: clock.tick() }); return key; } };
  const sync = createReaderChatSync({ store, resolveNamespace: async () => 'st-user:test', indexedDB: idb, storageFactory: async () => account, isConfigured: () => true,
    schedule: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, cancel: () => {} });
  return { chats, store, sync, timers, idb };
}
const clockOf = () => { let now = 1000; return { tick: () => (now += 10) }; };
const talk = (...lines) => ({ bookId: 'book1', messages: lines.map((text, i) => ({ id: 'm' + i, role: i % 2 ? 'assistant' : 'user', text })), summaries: [], slices: [], cursor: lines.length });
const quiet = async work => { const warn = console.warn; console.warn = () => {}; try { return await work(); } finally { console.warn = warn; } };

test('a conversation written on one device appears on another, and later edits travel both ways', async () => {
  const account = fakeAccount(), clock = clockOf(), a = device(account, { clock }), b = device(account, { clock });
  await a.store.put('chat::book1', talk('你好', '在读第一章'));
  assert.deepEqual(await a.sync.run(), { uploaded: 1, downloaded: 0, dismissed: 0, conflicts: 0, unchanged: 0 });
  assert.ok(account.slots.has(readerChatSlot('chat::book1')) && account.slots.has(READER_CHAT_INDEX_SLOT));
  assert.equal(JSON.stringify(account.slots.get(readerChatSlot('chat::book1')).value).includes('在读第一章'), false, 'the account copy is compressed');

  assert.deepEqual(await b.sync.run(), { uploaded: 0, downloaded: 1, dismissed: 0, conflicts: 0, unchanged: 0 });
  assert.deepEqual((await b.store.get('chat::book1')).messages, talk('你好', '在读第一章').messages);
  assert.deepEqual(await b.sync.run(), { uploaded: 0, downloaded: 0, dismissed: 0, conflicts: 0, unchanged: 1 }, 'a download is not mistaken for a local edit');
  assert.deepEqual(await a.sync.run(), { uploaded: 0, downloaded: 0, dismissed: 0, conflicts: 0, unchanged: 1 });

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

test('a local deletion is not propagated and not undone; a wiped browser gets everything back', async () => {
  const account = fakeAccount(), clock = clockOf(), a = device(account, { clock }), b = device(account, { clock });
  await a.store.put('chat::book1', talk('一')); await a.store.put('chat::book2', talk('二')); await a.sync.run(); await b.sync.run();
  a.chats.delete('chat::book1');                                            // the book was removed on device A
  const round = await a.sync.run();
  assert.equal(round.dismissed, 1); assert.equal(round.downloaded, 0);
  assert.equal(a.chats.has('chat::book1'), false, 'it does not come back here');
  assert.ok(account.slots.has(readerChatSlot('chat::book1')), 'the account copy is untouched');
  await b.sync.run(); assert.equal(b.chats.has('chat::book1'), true, 'other devices keep it');
  assert.deepEqual(await a.sync.run(), { uploaded: 0, downloaded: 0, dismissed: 0, conflicts: 0, unchanged: 1 });

  const wiped = device(account, { clock });                                 // same account, empty profile
  assert.equal((await wiped.sync.run()).downloaded, 2);
  assert.deepEqual([...wiped.chats.keys()].sort(), ['chat::book1', 'chat::book2']);
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
});
