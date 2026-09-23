import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {characterNativeFixture, namespace, document} from './helpers/character-native-fixture.mjs';
import {captureCharacterWorkerStorage, characterWorkerStorageOptions} from '../qianmu-character-worker-storage.js';
import {createCharacterArchiveStore} from '../qianmu-character-archive-store.js';
import {runRestoreStorage} from '../qianmu-storyboard-restore-storage-runtime.js';
import {runStoryboardBundle} from '../qianmu-storyboard-bundle-runtime.js';
import {openStoryboardBundleRestoreRuntime} from '../qianmu-storyboard-bundle-restore-runtime.js';
const origin = 'https://st.fixture.invalid';
const turn = () => new Promise(resolve => setImmediate(resolve));
const context = () => ({namespace, origin, csrf: 'synthetic'});
const seed = f => f.open().save(namespace, {document: document()});

test('configured main-thread handoff contains only the live ST account, same origin and CSRF', async t => {
  const f = await characterNativeFixture(t); f.configure(); let guards = 0;
  assert.deepEqual(await captureCharacterWorkerStorage(namespace, async () => { guards++; }), context()); assert.equal(guards, 2);
  assert.equal(f.calls.length, 0); await assert.rejects(() => captureCharacterWorkerStorage('st-user:other', async () => {}), /账户/);
});

test('handoff rejects scope loss during capture instead of launching a worker with stale authority', async t => {
  const f = await characterNativeFixture(t); f.configure(); let calls = 0;
  await assert.rejects(() => captureCharacterWorkerStorage(namespace, async () => { if (++calls === 2) throw Error('scope lost'); }), /scope lost/); assert.equal(f.uploads, 0);
});

test('worker options reject different origin/account, extra credentials, malformed CSRF and absent guards before any fetch', async t => {
  const f = await characterNativeFixture(t);
  const base = {namespace, origin, guard: async () => {}};
  for (const change of [v => v.origin = 'https://other.invalid', v => v.namespace = 'st-user:other', v => v.apiKey = 'do-not-send', v => v.csrf = '\r\nforged', v => delete v.csrf]) {
    const value = context(); change(value); assert.throws(() => characterWorkerStorageOptions(value, base));
  }
  assert.throws(() => characterWorkerStorageOptions(context(), {...base, guard: undefined})); assert.equal(f.calls.length, 0);
  assert.equal(characterWorkerStorageOptions(undefined, base), false);
});

test('actual worker storage adapter uses native factory for list/detail/backup and asks live guards throughout', async t => {
  const f = await characterNativeFixture(t), head = await seed(f); t.mock.method(globalThis, 'fetch', f.fetchImpl); let checks = 0;
  const native = characterWorkerStorageOptions(context(), {namespace, origin, guard: async () => { checks++; }}), store = createCharacterArchiveStore({native}); t.after(() => store.close());
  assert.equal((await store.list(namespace))[0].id, head.id); assert.deepEqual((await store.load(namespace, head.id)).document, document());
  assert.equal((await store.backup(namespace)).archives.length, 1); assert.ok(checks > 10);
});

test('worker live guard loss mid-read stops the result and never writes a replacement empty library', async t => {
  const f = await characterNativeFixture(t), head = await seed(f); t.mock.method(globalThis, 'fetch', f.fetchImpl); let alive = true;
  const store = createCharacterArchiveStore({native: characterWorkerStorageOptions(context(), {namespace, origin, guard: async () => { if (!alive) throw Error('changed'); }})}); t.after(() => store.close());
  f.reset(); f.hook(call => { if (call.path.includes('-character-record-')) alive = false; });
  await assert.rejects(() => store.load(namespace, head.id)); assert.equal(f.uploads, 0);
});

// Execute the real browser worker module and its message handler in the Node
// fixture realm. This is synthetic message transport, not a browser/bridge test.
function installStorageWorker(t) {
  const prior = Object.getOwnPropertyDescriptor(globalThis, 'self');
  class Worker {
    static last;
    constructor(url) {
      Worker.last = this; this.events = {}; this.sent = []; this.closed = false;
      const scope = {location: {origin}, addEventListener: (_type, listener) => { this.receive = listener; },
        postMessage: value => { if (!this.closed) this.events.message?.({data: structuredClone(value)}); }, close: () => { this.workerClosed = true; }};
      Object.defineProperty(globalThis, 'self', {configurable: true, value: scope});
      this.ready = import(url.href + '?fixture=' + crypto.randomUUID());
    }
    addEventListener(type, callback) { this.events[type] = callback; }
    postMessage(value) { this.sent.push(structuredClone(value)); void this.ready.then(() => { if (!this.closed) return this.receive({data: value}); }).catch(error => this.events.error?.(error)); }
    terminate() { this.closed = true; }
  }
  t.after(() => { if (prior) Object.defineProperty(globalThis, 'self', prior); else delete globalThis.self; }); return Worker;
}

test('real storage worker body receives native handoff and returns native character accounting through guarded RPC', async t => {
  const f = await characterNativeFixture(t); await seed(f); f.configure(); t.mock.method(globalThis, 'fetch', f.fetchImpl);
  const Worker = installStorageWorker(t); let checks = 0; f.reset();
  const summary = await runRestoreStorage('characters', {namespace, guard: async () => { checks++; }, WorkerClass: Worker}); await turn();
  assert.equal(summary.documents.count, 1); assert.deepEqual(Worker.last.sent[0].nativeCharacters, context());
  assert.ok(checks > 10); assert.equal(f.originalReads, 0); assert.equal(f.uploads, 0); assert.equal(Worker.last.closed, true); assert.equal(Worker.last.workerClosed, true);
});

test('real storage worker rejects a damaged native index rather than falling through to its local database', async t => {
  const f = await characterNativeFixture(t); await seed(f); const {value} = await f.readIndex(); value.unknown = true; await f.writeIndex(value); f.configure();
  t.mock.method(globalThis, 'fetch', f.fetchImpl); const Worker = installStorageWorker(t); f.reset();
  await assert.rejects(() => runRestoreStorage('characters', {namespace, guard: async () => {}, WorkerClass: Worker}), /目录/); await turn(); assert.equal(f.uploads, 0);
});

class BundleWorker {
  static last;
  constructor() { BundleWorker.last = this; this.events = {}; this.sent = []; }
  addEventListener(type, callback) { this.events[type] = callback; }
  terminate() { this.closed = true; }
  postMessage(value) {
    this.sent.push(structuredClone(value));
    if (value.action === 'capture') queueMicrotask(() => this.events.message({data: {result: {file: value.file, summary: {}, manifest: {}, fingerprint: 'a'.repeat(64)}}}));
    if (value.action === 'open') queueMicrotask(() => this.events.message({data: {id: value.id, operation: value.operation, action: value.action, type: 'result', sourceDigest: 'a'.repeat(64), result: {sourceDigest: 'a'.repeat(64)}}}));
  }
}

test('bundle capture runtime forwards the native account context without model credentials or raw library bodies', async t => {
  const f = await characterNativeFixture(t); f.configure();
  await runStoryboardBundle('capture', new Blob(['fixture']), {namespace, chatKey: 'chat', guard: async () => {}, WorkerClass: BundleWorker});
  assert.deepEqual(BundleWorker.last.sent[0].nativeCharacters, context()); assert.equal('archives' in BundleWorker.last.sent[0], false); assert.equal(BundleWorker.last.closed, true);
});

test('bundle restore runtime carries native scope independently from image-client CSRF and closes normally', async t => {
  const f = await characterNativeFixture(t); f.configure();
  const client = await openStoryboardBundleRestoreRuntime(new Blob(['fixture']), {namespace, chatKey: 'chat', guard: async () => {}, headers: () => ({'X-CSRF-Token': 'image-fixture', Authorization: 'not-forwarded'}),
    configuration: {preview: async () => ({}), apply: async () => ({})}, WorkerClass: BundleWorker});
  const payload = BundleWorker.last.sent[0].payload; assert.deepEqual(payload.nativeCharacters, context()); assert.equal(payload.csrf, 'image-fixture'); assert.equal('Authorization' in payload, false);
  client.close(); assert.equal(BundleWorker.last.closed, true);
});

test('all bundle and storage worker archive factories explicitly consume the validated native context', async () => {
  for (const name of ['qianmu-storyboard-bundle-worker.js','qianmu-storyboard-bundle-restore-worker.js','qianmu-storyboard-restore-storage-worker.js']) {
    const source = await readFile(new URL('../' + name, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /createCharacterArchiveStore\(\)/); assert.match(source, /createCharacterArchiveStore\(\{native:\s*characterWorkerStorageOptions/);
    assert.match(source, /nativeCharacters/);
  }
});
