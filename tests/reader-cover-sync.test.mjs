import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as realStore from '../qianmu-blobstore.js';
import { createReaderCoverSync, READER_COVER_INDEX_SLOT, READER_COVER_MAX_BYTES } from '../qianmu-reader-cover-sync.js';
import { accountMirrorSlot } from '../qianmu-account-mirror.js';
import { installMemoryIndexedDB } from './helpers/reader-idb-fixture.mjs';

// The mirror's own memory of what was synced (object stores with keyPath `id`).
function fakeSyncMemory() {
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
const image = (text, type = 'image/png') => new Blob([new TextEncoder().encode(text)], { type });
const bytes = async blob => new TextDecoder().decode(await blob.arrayBuffer());
// Stands in for the canvas: a "thumbnail" is a short JPEG that names what it was made from.
const thumbnail = async blob => image(`缩略:${(await bytes(blob)).slice(0, 12)}`, 'image/jpeg');

// One browser: the real store module on its own in-memory IndexedDB. The module keeps one open database, so each
// call first points it at this browser's; the tests run their devices one after another.
function device(account, { shrink = thumbnail } = {}) {
  const holder = {}, idb = installMemoryIndexedDB(holder), arrived = [], removed = [];
  const here = fn => async (...args) => { globalThis.indexedDB = holder.indexedDB; globalThis.IDBKeyRange = holder.IDBKeyRange; realStore.configureBlobStoreAccount(); return fn(...args); };
  const blobStore = Object.fromEntries(['listCoverKeys', 'getCover', 'putCover', 'deleteCover', 'putBook', 'putReaderChat', 'putReaderImage', 'listReaderChatKeys',
    'deleteReaderBookData', 'auditOrphanedReaderBlobs', 'clearOrphanedReaderBlobs'].map(name => [name, here(realStore[name])]));
  const sync = createReaderCoverSync({ blobStore, shrink, resolveNamespace: async () => 'st-user:test', indexedDB: fakeSyncMemory(), storageFactory: async () => account, isConfigured: () => true,
    onDownloaded: ids => arrived.push(...ids), onRemoved: ids => removed.push(...ids), schedule: () => 1, cancel: () => {} });
  return { blobStore, sync, arrived, removed, idb };
}
const quiet = async work => { const warn = console.warn; console.warn = () => {}; try { return await work(); } finally { console.warn = warn; } };
const slotOf = id => accountMirrorSlot('reader-cover-', id);
// Device A imported three books (two with covers large enough to be worth shrinking); device B has the same account and no books.
async function shelf() {
  const account = fakeAccount(), a = device(account), b = device(account);
  for (const id of ['book1', 'book2', 'book3']) {
    await a.blobStore.putBook(id, { meta: { title: id }, fullText: '正文', chapters: [{}] });
    await a.blobStore.putCover(id, image(`${id} 的原图 ${'#'.repeat(400)}`));
  }
  return { account, a, b };
}

test('covers reach another device as thumbnails; the originals stay where they were imported', async () => {
  const { account, a, b } = await shelf();
  assert.deepEqual(await a.sync.run(), { uploaded: 3, downloaded: 0, dismissed: 0, conflicts: 0, unchanged: 0, removed: 0, tombstoned: 0 });
  assert.ok(account.slots.has(READER_COVER_INDEX_SLOT));
  const sent = JSON.parse(account.slots.get(slotOf('book2')).value.body.json);
  assert.deepEqual(Object.keys(sent).sort(), ['data', 'type', 'version']); assert.equal(sent.type, 'image/jpeg');
  assert.equal(Buffer.from(sent.data, 'base64').toString('utf8'), '缩略:book2 的原图 ##', 'only the thumbnail travels');
  assert.match(await bytes(await a.blobStore.getCover('book2')), /^book2 的原图 #{400}$/, 'the original on this device is untouched');

  assert.deepEqual(await b.sync.run(), { uploaded: 0, downloaded: 3, dismissed: 0, conflicts: 0, unchanged: 0, removed: 0, tombstoned: 0 });
  assert.deepEqual(b.arrived.sort(), ['book1', 'book2', 'book3'], 'an open shelf is told which covers arrived');
  for (const id of ['book1', 'book2', 'book3']) {
    const cover = await b.blobStore.getCover(id);
    assert.equal(cover.type, 'image/jpeg'); assert.equal(await bytes(cover), `缩略:${id} 的原图 ##`);
  }
  const writes = account.writes;
  await a.sync.run(); await b.sync.run(); await a.sync.run();
  assert.equal(account.writes, writes, 'settled: a thumbnail is not sent back as a change');
  assert.match(await bytes(await a.blobStore.getCover('book1')), /原图 #{400}$/, 'and never replaces the original');

  // A cover replaced later (same book, new picture) travels again.
  await a.blobStore.putCover('book3', image(`book3 换了封面 ${'#'.repeat(90)}`, 'image/webp'));
  assert.equal((await a.sync.run()).uploaded, 1);
  assert.equal((await b.sync.run()).downloaded, 1);
  assert.equal(await bytes(await b.blobStore.getCover('book3')), '缩略:book3 换了封面 #');
});

test('a cover that cannot be shrunk travels as it is unless it is over the limit; then it stays on this device only', async () => {
  const account = fakeAccount();
  const a = device(account, { shrink: async blob => { if ((await bytes(blob)).startsWith('坏图')) throw new Error('decode failed'); return null; } });
  const b = device(account);
  await a.blobStore.putCover('small', image('小图'));
  await a.blobStore.putCover('broken', image('坏图但不大'));
  await a.blobStore.putCover('huge', new Blob([new Uint8Array(READER_COVER_MAX_BYTES + 1)], { type: 'image/png' }));
  await a.blobStore.putCover('empty', image(''));
  const round = await quiet(() => a.sync.run());
  assert.equal(round.uploaded, 2);
  assert.equal(account.slots.has(slotOf('huge')), false); assert.equal(account.slots.has(slotOf('empty')), false);
  assert.equal((await a.blobStore.getCover('huge')).size, READER_COVER_MAX_BYTES + 1, 'the oversized original is kept locally');
  assert.equal((await b.sync.run()).downloaded, 2);
  assert.equal(await bytes(await b.blobStore.getCover('small')), '小图'); assert.equal((await b.blobStore.getCover('small')).type, 'image/png');
  assert.equal(await bytes(await b.blobStore.getCover('broken')), '坏图但不大');
  assert.equal(await b.blobStore.getCover('huge'), undefined);
});

test('a damaged account copy is ignored, the good ones still arrive', async () => {
  const { account, a, b } = await shelf();
  await a.sync.run();
  account.slots.get(slotOf('book1')).value.body = { json: '{"version":1,"data":""}' };
  account.slots.get(slotOf('book2')).value.body = { json: 'not json' };
  assert.equal((await b.sync.run()).downloaded, 1);
  assert.deepEqual(await b.blobStore.listCoverKeys(), ['book3']);
});

test('deleting a book removes its cover on the other devices; the rest of the shelf keeps theirs', async () => {
  const { account, a, b } = await shelf();
  await a.sync.run(); await b.sync.run();
  // The reader's order: the local transaction first (it deletes the cover), then the account.
  const local = await a.blobStore.deleteReaderBookData('book1', { deleteMemory: true });
  assert.equal(local.status, 'committed'); assert.equal(local.counts.covers, 1);
  assert.deepEqual(await a.sync.remove(['book1']), { registered: true, synced: ['book1'], pending: [] });
  const entry = account.slots.get(READER_COVER_INDEX_SLOT).value.entries[slotOf('book1')];
  assert.equal(entry.deleted, true); assert.equal(account.slots.get(slotOf('book1')).value.body, undefined);

  const round = await b.sync.run();
  assert.equal(round.removed, 1); assert.equal(round.unchanged, 2);
  assert.deepEqual(b.removed, ['book1']);
  assert.deepEqual((await b.blobStore.listCoverKeys()).sort(), ['book2', 'book3']);
  const fresh = device(account);
  assert.equal((await fresh.sync.run()).downloaded, 2);
  assert.deepEqual((await fresh.blobStore.listCoverKeys()).sort(), ['book2', 'book3'], 'a new device does not get the deleted book\'s cover');
  const writes = account.writes;
  await a.sync.run(); await b.sync.run();
  assert.equal(account.writes, writes, 'settled');
});

test('a cover whose book is on the shelf is not an orphan even when this device has no book body', async () => {
  const { a, b } = await shelf();
  await a.sync.run(); await b.sync.run();                                    // B: three covers, no bodies
  await b.blobStore.putCover('gone', image('书架上已经没有的书'));
  await b.blobStore.putReaderImage('gone', 1, image('插图'));
  await b.blobStore.putReaderImage('book2', 1, image('没有正文的插图'));
  const shelfBookIds = ['book1', 'book2', 'book3'];

  const audit = await b.blobStore.auditOrphanedReaderBlobs({ shelfBookIds });
  assert.deepEqual(audit.records.map(item => `${item.kind}:${item.key}`).sort(), ['cover:gone', 'image:book2::1', 'image:gone::1'],
    'synced covers are kept; illustrations still need the book body on this device');
  assert.equal((await b.blobStore.auditOrphanedReaderBlobs()).count, 6, 'without the shelf every cover here would look orphaned');
  assert.equal((await a.blobStore.auditOrphanedReaderBlobs({ shelfBookIds })).count, 0, 'the device that has the bodies has no orphans');

  const result = await b.blobStore.clearOrphanedReaderBlobs({ shelfBookIds });
  assert.equal(result.failed.length, 0); assert.equal(result.remaining, 0);
  assert.deepEqual(result.cleared.map(item => `${item.kind}:${item.key}`).sort(), ['cover:gone', 'image:book2::1', 'image:gone::1']);
  assert.deepEqual((await b.blobStore.listCoverKeys()).sort(), ['book1', 'book2', 'book3'], 'the shelf keeps its covers');
  assert.equal((await b.sync.run()).dismissed, 0, 'and the mirror sees nothing missing');
});

test('the entry mirrors covers in the background, after a cover is saved, after a package import, and when a book is deleted', async () => {
  const entry = await readFile(new URL('../index.js', import.meta.url), 'utf8');
  assert.match(entry, /const readerCoverSync=createReaderCoverSync\(\{blobStore,onDownloaded:ids=>coreadAccountCovers\(ids,true\),onRemoved:ids=>coreadAccountCovers\(ids,false\),/);
  assert.match(entry, /quiet\(\(\) => COREAD_ENABLED \? readerCoverSync\.run\(\) : null\)/);
  assert.match(entry, /await blobStore\.putCover\(bookId, new Blob\(\[cover\.bytes\][^\n]*\n\s*hasCover = true;\n\s*readerCoverSync\.request\(bookId\);/);
  assert.match(entry, /await blobStore\.putCover\(refillBookId, [^\n]*readerCoverSync\.request\(refillBookId\);/);
  assert.match(entry, /await applyCoreadPackageData\([^\n]*\n\s*check\(\);\n\s*readerCoverSync\.request\(\);/);
  assert.match(entry, /localCommitted = true;[\s\S]{0,400}void readerCoverSync\.remove\(\[bookId\]\);/);
  assert.match(entry, /auditOrphanedReaderBlobs\(\{shelfBookIds:\(settings\?\.coread\?\.books\|\|\[\]\)\.map\(book=>book\?\.id\)\}\)/);
  assert.match(entry, /clearOrphanedReaderBlobs\(\{check:\(\)=>cleanup\.check\(\),shelfBookIds:coreadShelfBookIds\(\)\}\)/);
  const files = JSON.parse(await readFile(new URL('../release-files.json', import.meta.url), 'utf8'));
  assert.ok(JSON.stringify(files).includes('"qianmu-reader-cover-sync.js"'), 'the new module ships');
});
