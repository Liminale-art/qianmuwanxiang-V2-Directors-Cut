import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createTtsFavoritesSync, TTS_FAVORITES_INDEX_SLOT } from '../qianmu-tts-favorites-sync.js';
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
        const tx = {}, pending = [];
        const later = fn => { const r = {}; pending.push(() => { r.result = fn(); r.onsuccess?.(); }); return r; };
        queueMicrotask(() => { while (pending.length) pending.shift()(); queueMicrotask(() => { while (pending.length) pending.shift()(); tx.oncomplete?.(); }); });
        tx.objectStore = storeName => { const rows = rowsOf(storeName); return {
          put(value) { rows.set(value.id, structuredClone(value)); return {}; }, delete(id) { rows.delete(id); return {}; },
          getAll: () => later(() => [...rows.values()].map(row => structuredClone(row))), getAllKeys: () => later(() => [...rows.keys()]),
        }; };
        return tx;
      } };
    queueMicrotask(() => { request.result = db; request.onsuccess?.(); });
    return request;
  } };
}
function fakeAccount() {
  const slots = new Map(); let counter = 0;
  return { slots, writes: 0,
    async read(slot) { const entry = slots.get(slot); return entry ? { exists: true, value: structuredClone(entry.value), fingerprint: entry.fingerprint } : { exists: false }; },
    async write(slot, value, { expectedFingerprint } = {}) {
      const entry = slots.get(slot);
      assert.equal(expectedFingerprint ?? null, entry ? entry.fingerprint : null, `conditional write of ${slot}`);
      slots.set(slot, { value: structuredClone(value), fingerprint: 'f' + (++counter) }); this.writes++;
      return { fingerprint: 'f' + counter };
    } };
}
// A browser with its own favourites store, shaped like the blob store module.
function device(account) {
  const rows = new Map(); let refreshed = 0;
  const blobStore = {
    listFavorites: async () => [...rows].map(([id, value]) => ({ id, ...value })),
    getFavorite: async id => rows.get(id),
    restoreFavorite: async (id, record) => { rows.set(id, { blob: record.blob, meta: record.meta || {}, label: record.label || '', createdAt: Number(record.createdAt) || 1 }); return id; },
  };
  const sync = createTtsFavoritesSync({ blobStore, resolveNamespace: async () => 'st-user:test', indexedDB: fakeIndexedDB(), storageFactory: async () => account, isConfigured: () => true,
    onDownloaded: () => { refreshed++; }, schedule: () => 1, cancel: () => {} });
  return { rows, sync, get refreshed() { return refreshed; } };
}
const clip = (text, type = 'audio/mpeg') => new Blob([new TextEncoder().encode(text)], { type });
const bytes = async blob => new TextDecoder().decode(await blob.arrayBuffer());

test('a favourite kept on one device arrives on another with its audio, label, metadata and original time', async () => {
  const account = fakeAccount(), a = device(account), b = device(account);
  a.rows.set('fav:one', { blob: clip('音频内容一'), meta: { speaker: '旁白', text: '第一句', folder: '常用' }, label: '开场', createdAt: 111 });
  assert.equal((await a.sync.run()).uploaded, 1);
  assert.ok(account.slots.has(accountMirrorSlot('tts-favorite-', 'fav:one')) && account.slots.has(TTS_FAVORITES_INDEX_SLOT));
  assert.equal((await b.sync.run()).downloaded, 1);
  const copy = b.rows.get('fav:one');
  assert.equal(await bytes(copy.blob), '音频内容一'); assert.equal(copy.blob.type, 'audio/mpeg');
  assert.deepEqual({ meta: copy.meta, label: copy.label, createdAt: copy.createdAt }, { meta: { speaker: '旁白', text: '第一句', folder: '常用' }, label: '开场', createdAt: 111 });
  assert.equal(b.refreshed, 1, 'an open favourites list is told that something arrived');
  const writes = account.writes;
  await a.sync.run(); await b.sync.run(); await a.sync.run();
  assert.equal(account.writes, writes, 'settled');
});

test('renaming travels; removing here is not undone and does not remove it elsewhere; a wiped browser gets all back', async () => {
  const account = fakeAccount(), a = device(account), b = device(account);
  a.rows.set('fav:one', { blob: clip('一'), meta: {}, label: '旧名', createdAt: 1 });
  a.rows.set('fav:two', { blob: clip('二'), meta: {}, label: '第二条', createdAt: 2 });
  await a.sync.run(); await b.sync.run();
  b.rows.set('fav:one', { ...b.rows.get('fav:one'), label: '新名' });
  assert.equal((await b.sync.run()).uploaded, 1);
  assert.equal((await a.sync.run()).downloaded, 1);
  assert.equal(a.rows.get('fav:one').label, '新名'); assert.equal(await bytes(a.rows.get('fav:one').blob), '一');

  a.rows.delete('fav:two');
  assert.equal((await a.sync.run()).dismissed, 1);
  assert.equal(a.rows.has('fav:two'), false);
  await b.sync.run(); assert.equal(b.rows.has('fav:two'), true);
  const wiped = device(account);
  assert.equal((await wiped.sync.run()).downloaded, 2);
});

test('favourites never delete across devices: the store has no delete, so remove() refuses and rounds count nothing removed', async () => {
  const account = fakeAccount(), a = device(account), b = device(account);
  for (const [id, text] of [['fav:one', '一'], ['fav:two', '二'], ['fav:three', '三']]) a.rows.set(id, { blob: clip(text), meta: {}, label: id, createdAt: 1 });
  assert.deepEqual(await a.sync.run(), { uploaded: 3, downloaded: 0, dismissed: 0, conflicts: 0, unchanged: 0, removed: 0, tombstoned: 0 });
  assert.deepEqual(await b.sync.run(), { uploaded: 0, downloaded: 3, dismissed: 0, conflicts: 0, unchanged: 0, removed: 0, tombstoned: 0 });
  a.rows.delete('fav:two');
  assert.deepEqual(await a.sync.remove(['fav:two']), { registered: false, synced: [], pending: ['fav:two'] });
  assert.deepEqual(await a.sync.run(), { uploaded: 0, downloaded: 0, dismissed: 1, conflicts: 0, unchanged: 2, removed: 0, tombstoned: 0 });
  const entry = account.slots.get(TTS_FAVORITES_INDEX_SLOT).value.entries[accountMirrorSlot('tts-favorite-', 'fav:two')];
  assert.equal(entry.deleted, undefined, 'the account copy is not turned into a tombstone');
  assert.ok(account.slots.get(accountMirrorSlot('tts-favorite-', 'fav:two')).value.body, 'and still carries the clip');
  assert.deepEqual(await b.sync.run(), { uploaded: 0, downloaded: 0, dismissed: 0, conflicts: 0, unchanged: 3, removed: 0, tombstoned: 0 });
  assert.equal(b.rows.size, 3);
});

test('clips that cannot be carried are left local, and a damaged account copy is ignored', async () => {
  const account = fakeAccount(), a = device(account), b = device(account);
  a.rows.set('fav:empty', { blob: clip(''), meta: {}, label: '', createdAt: 1 });
  a.rows.set('fav:odd-meta', { blob: clip('x'), meta: { when: new Date(0) }, label: '', createdAt: 2 });
  a.rows.set('fav:not-audio', { blob: 'not a blob', meta: {}, label: '', createdAt: 3 });
  a.rows.set('fav:good', { blob: clip('好'), meta: {}, label: '', createdAt: 4 });
  const round = await a.sync.run();
  assert.equal(round.uploaded, 1); assert.equal(account.slots.size, 2, 'only the good clip and the index');
  account.slots.get(accountMirrorSlot('tts-favorite-', 'fav:good')).value.body = { json: '{"version":1,"data":""}' };
  assert.equal((await b.sync.run()).downloaded, 0); assert.equal(b.rows.size, 0);
});

test('the entry mirrors favourites in the background and after a favourite is added or renamed', async () => {
  const entry = await readFile(new URL('../index.js', import.meta.url), 'utf8');
  assert.match(entry, /const ttsFavoritesSync=createTtsFavoritesSync\(\{blobStore,/);
  assert.match(entry, /quiet\(\(\) => ttsFavoritesSync\.run\(\)\)/);
  assert.match(entry, /ttsFavoritesSync\.request\(resolvedId\);[^\n]*\n\s*await blobStore\.addFavorite\(resolvedId, blob, \{/);
  assert.match(entry, /ttsFavoritesSync\.request\(id\);\n\s*await blobStore\.updateFavorite\(id, \{/);
  const store = await readFile(new URL('../qianmu-blobstore.js', import.meta.url), 'utf8');
  assert.match(store, /export async function restoreFavorite\(favId, record\)/);
});
