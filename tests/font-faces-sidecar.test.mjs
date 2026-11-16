import test from 'node:test';
import assert from 'node:assert/strict';
import { createFontFacesSidecar, fontFacesRef, FONT_FACES_SLOT } from '../qianmu-font-faces-sidecar.js';
import { attachSettingsPersistence } from '../qianmu-settings-persistence.js';
import { normalizeFontLibrary } from '../qianmu-font-library-state.js';

// Minimal in-memory IndexedDB: one object store per database name, callbacks fired asynchronously.
function fakeIndexedDB() {
  const databases = new Map();
  return { databases, open(name) {
    const request = {};
    if (!databases.has(name)) databases.set(name, new Map());
    const rows = databases.get(name);
    const db = { objectStoreNames: { contains: () => true }, createObjectStore() {}, close() {},
      transaction() {
        const tx = {};
        queueMicrotask(() => queueMicrotask(() => tx.oncomplete?.()));
        tx.objectStore = () => ({
          get(key) { const r = {}; queueMicrotask(() => { r.result = rows.get(key); r.onsuccess?.(); }); return r; },
          put(value) { rows.set(value.ref, structuredClone(value)); return {}; },
        });
        return tx;
      } };
    queueMicrotask(() => { request.result = db; request.onsuccess?.(); });
    return request;
  } };
}
function fakeStorage({ failWrites = 0 } = {}) {
  const state = { doc: null, fingerprint: 0, writes: 0, reads: 0, failWrites };
  return { state,
    async read(slot) {
      assert.equal(slot, FONT_FACES_SLOT); state.reads++;
      return state.doc ? { exists: true, value: structuredClone(state.doc), fingerprint: 'f' + state.fingerprint } : { exists: false };
    },
    async write(slot, value, { expectedFingerprint } = {}) {
      assert.equal(slot, FONT_FACES_SLOT);
      if (state.failWrites > 0) { state.failWrites--; throw new Error('offline'); }
      assert.equal(expectedFingerprint, state.doc ? 'f' + state.fingerprint : null, 'writes are conditional on what was read');
      state.doc = structuredClone(value); state.fingerprint++; state.writes++;
      return { fingerprint: 'f' + state.fingerprint };
    } };
}
const range = seed => Array.from({ length: 60 }, (_, i) => `U+${(0x4e00 + seed * 100 + i).toString(16)}`).join(',');
const webFont = (id, seed) => ({ id, name: `网络字体${seed}`, source: { kind: 'web', input: `https://fonts.example/${seed}.css` }, folder: '', tags: [],
  faces: Array.from({ length: 12 }, (_, i) => ({ urls: [{ url: `https://fonts.example/${seed}/${i}.woff2`, format: 'woff2' }], weight: '400', style: 'normal', unicodeRange: range(seed * 20 + i) })) });
const localFont = { id: 'local1', name: '本地字体', source: { kind: 'local', fileName: 'a.ttf', format: 'truetype' }, folder: '', tags: [], faces: [{ urls: [], weight: '400', style: 'normal' }] };
const library = fonts => normalizeFontLibrary({ version: 1, fonts, body: { fontId: fonts[0].id, weight: '400', style: 'normal', enabled: true } });
function fixture(options = {}) {
  const idb = options.indexedDB || fakeIndexedDB(), storage = options.storage || fakeStorage(options), timers = [], notices = [];
  let saves = 0;
  const sidecar = createFontFacesSidecar({ resolveNamespace: async () => 'st-user:test', indexedDB: idb, storageFactory: async () => storage,
    isConfigured: () => options.configured !== false, requestSave: () => { saves++; }, notify: message => notices.push(message),
    schedule: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, cancel: () => {}, now: () => 1_000_000 });
  const settle = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); await new Promise(resolve => setImmediate(resolve)); };
  const runTimers = async () => { for (const timer of timers.splice(0)) timer.fn(); await settle(); await sidecar.flush(); await settle(); };
  return { sidecar, idb, storage, timers, notices, settle, runTimers, get saves() { return saves; } };
}
const save = settings => JSON.parse(JSON.stringify(settings));

test('fonts are written in full until both copies are confirmed, then as references; memory never changes', async () => {
  const f = fixture(), settings = attachSettingsPersistence({ fontLibrary: library([webFont('w1', 1), webFont('w2', 2), localFont]) }, f.sidecar);
  const full = JSON.stringify(settings.fontLibrary);
  const first = save(settings);
  assert.deepEqual(first.fontLibrary, JSON.parse(full), 'first save is complete');
  assert.equal(f.storage.state.writes, 0, 'nothing is uploaded on the save path itself');
  await f.runTimers();
  assert.equal(f.storage.state.writes, 1, 'one account-file write for the batch');
  assert.equal(f.saves, 1, 'a follow-up save is requested once both copies exist');
  const second = save(settings);
  const slim = second.fontLibrary.fonts.filter(font => font.facesRef);
  assert.equal(slim.length, 2);
  assert.ok(slim.every(font => font.faces.length === 0 && /^[0-9a-f]{64}$/.test(font.facesRef)));
  assert.deepEqual(second.fontLibrary.fonts.find(font => font.id === 'local1'), JSON.parse(full).fonts.find(font => font.id === 'local1'), 'local fonts are untouched');
  assert.ok(JSON.stringify(second).length < full.length / 3, 'the settings file shrinks');
  assert.equal(JSON.stringify(settings.fontLibrary), full, 'the in-memory library is exactly as before');
  assert.deepEqual(normalizeFontLibrary(settings.fontLibrary), JSON.parse(full), 'and still validates');
  for (const font of slim) assert.equal(font.facesRef, fontFacesRef(JSON.stringify(JSON.parse(full).fonts.find(item => item.id === font.id).faces)));
});

test('a reload restores the fonts from the local cache without touching the network', async () => {
  const f = fixture(), original = library([webFont('w1', 1), webFont('w2', 2)]);
  const settings = attachSettingsPersistence({ fontLibrary: structuredClone(original) }, f.sidecar);
  save(settings); await f.runTimers();
  const reloaded = save(settings), readsBefore = f.storage.state.reads;
  const next = fixture({ indexedDB: f.idb, storage: f.storage });
  attachSettingsPersistence(reloaded, next.sidecar);
  assert.throws(() => normalizeFontLibrary(reloaded.fontLibrary), 'the slim form is not readable by the library before it is restored');
  assert.equal(await next.sidecar.ready(reloaded), true);
  assert.equal(next.storage.state.reads, readsBefore, 'served from this browser');
  assert.deepEqual(normalizeFontLibrary(reloaded.fontLibrary), original);
  assert.equal(reloaded.fontLibrary.fonts.some(font => 'facesRef' in font), false);
  assert.ok(save(reloaded).fontLibrary.fonts.every(font => font.facesRef), 'restored fonts are known as stored: the next save is slim again');
  assert.equal(next.storage.state.writes, f.storage.state.writes, 'no re-upload');
});

test('a fresh browser restores from the account file; an unreachable copy changes nothing and is retried', async () => {
  const f = fixture(), original = library([webFont('w1', 1)]);
  const settings = attachSettingsPersistence({ fontLibrary: structuredClone(original) }, f.sidecar);
  save(settings); await f.runTimers();
  const persisted = save(settings);

  const fresh = fixture({ storage: f.storage });   // empty IndexedDB
  const onFresh = structuredClone(persisted);
  attachSettingsPersistence(onFresh, fresh.sidecar);
  assert.equal(await fresh.sidecar.ready(onFresh), true);
  assert.deepEqual(normalizeFontLibrary(onFresh.fontLibrary), original);
  assert.equal(fresh.idb.databases.get('qianmu-font-faces::st-user:test').size, 1, 'and is cached locally for next time');

  const offline = fixture({ configured: false });   // empty IndexedDB, account files unavailable
  const waiting = structuredClone(persisted), before = JSON.stringify(waiting);
  attachSettingsPersistence(waiting, offline.sidecar);
  let done = null;
  const pending = offline.sidecar.ready(waiting).then(value => { done = value; });
  await offline.settle();
  assert.equal(done, null, 'not resolved while the faces are unreachable');
  assert.equal(JSON.stringify(waiting), before, 'nothing is dropped or rewritten while waiting');
  assert.equal(offline.notices.length, 1);
  assert.equal(offline.timers.length, 1, 'a retry is scheduled');
  assert.deepEqual(save(waiting).fontLibrary, persisted.fontLibrary, 'saving meanwhile keeps the references intact');
  offline.sidecar.dispose(); offline.timers[0].fn(); await pending;
  assert.equal(done, false);
});

test('a damaged copy is rejected, a failed upload keeps fonts in full, and the gate holds the library back', async () => {
  const f = fixture(), original = library([webFont('w1', 1)]);
  const settings = attachSettingsPersistence({ fontLibrary: structuredClone(original) }, f.sidecar);
  save(settings); await f.runTimers();
  const persisted = save(settings);
  // Corrupt the local cache: the account copy is used instead, verified by digest.
  const rows = f.idb.databases.get('qianmu-font-faces::st-user:test');
  for (const row of rows.values()) row.json = row.json.replace('woff2', 'woff3');
  const repaired = fixture({ indexedDB: f.idb, storage: f.storage }), target = structuredClone(persisted);
  assert.equal(await repaired.sidecar.hydrate(target), true);
  assert.deepEqual(normalizeFontLibrary(target.fontLibrary), original);
  // Corrupt both: nothing is filled in.
  for (const row of rows.values()) row.json = '[]';
  for (const entry of Object.values(f.storage.state.doc.faces)) entry.faces[0].weight = '900';
  const broken = fixture({ indexedDB: f.idb, storage: f.storage }), untouched = structuredClone(persisted);
  assert.equal(await broken.sidecar.hydrate(untouched), false);
  assert.deepEqual(untouched, persisted);
  for (const entry of Object.values(f.storage.state.doc.faces)) entry.faces[0].weight = '400';

  const flaky = fixture({ failWrites: 1 }), other = attachSettingsPersistence({ fontLibrary: library([webFont('w9', 9)]) }, flaky.sidecar);
  const warn = console.warn; console.warn = () => {};
  try { save(other); await flaky.runTimers(); } finally { console.warn = warn; }
  assert.equal(save(other).fontLibrary.fonts[0].faces.length, 12, 'still written in full after a failed upload');
  assert.equal(flaky.saves, 0);
  await flaky.runTimers();
  assert.ok(save(other).fontLibrary.fonts[0].facesRef, 'the next save retries and then slims');

  const calls = [];
  const inner = { activate: () => calls.push('activate'), sync: async () => { calls.push('sync'); return 'synced'; }, attach: root => calls.push('attach:' + root.id),
    detach: () => calls.push('detach'), dispose: () => calls.push('dispose'), get extra() { return 'kept'; } };
  const held = structuredClone(persisted), gateFixture = fixture({ indexedDB: fakeIndexedDB(), storage: f.storage });
  const gated = gateFixture.sidecar.gate(inner, () => held);
  gated.activate(); gated.attach({ id: 'a', isConnected: true }); gated.detach(); gated.attach({ id: 'b', isConnected: true });
  assert.deepEqual(calls, ['detach'], 'nothing reads the catalogue before its faces are back');
  assert.equal(await gated.sync(), 'synced');
  await gateFixture.settle();
  assert.deepEqual([...calls].sort(), ['activate', 'attach:b', 'detach', 'sync'].sort(), 'the cancelled attach never happens');
  assert.equal(gated.extra, 'kept');
  gated.dispose(); assert.ok(calls.includes('dispose'));
});
