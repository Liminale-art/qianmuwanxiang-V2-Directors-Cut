import test from 'node:test';
import assert from 'node:assert/strict';
import {characterNativeFixture, namespace, document} from './helpers/character-native-fixture.mjs';
import {createCharacterArchiveStore} from '../qianmu-character-archive-store.js';
import {createCharacterArchiveSession} from '../qianmu-character-archive-session.js';
import {readCharacterCasting} from '../qianmu-character-casting.js';
import {readStoryboardBoundSubjects} from '../qianmu-storyboard-subject-evidence.js';
import {characterLibraryBackupDigest} from '../qianmu-character-library-backup.js';

const emptySummary = () => ({version: 1, status: 'ready', namespace, bytes: 0, filesIncluded: false,
  documents: {count: 0, bytes: 0}, bindings: {count: 0, bytes: 0}, indexes: {count: 0, bytes: 0}});
function localFixture({nonempty = false, failSummary = false} = {}) {
  const calls = [], summary = emptySummary();
  if (nonempty) { summary.documents = {count: 1, bytes: 10}; summary.bytes = 10; }
  const state = {closed: 0, opened: 0, calls, summary};
  const store = {async storageSummary(_namespace, options) { calls.push('storageSummary'); assert.equal(options.isCurrent(), true); if (failSummary) throw Error('orphan originals'); return structuredClone(summary); },
    async list() { calls.push('list'); return [{id: 'legacy', name: 'Legacy'}]; }, async bindings() { calls.push('bindings'); return []; },
    async load() { calls.push('load'); return {document: {name: 'Legacy optional fields stay unchanged'}}; },
    async save(_namespace, value) { calls.push('save'); return value; },
    async backup() { assert.fail('selection must not load/normalize the old library'); }, close() { state.closed++; }};
  return {...state, state, store, createLocal() { state.opened++; return store; }};
}
function session(t, f, legacy = localFixture()) {
  const store = createCharacterArchiveSession({createLocal: legacy.createLocal, createStorage: f.createStorage}); t.after(() => store.close()); return {store, legacy};
}
const seed = async f => f.open().save(namespace, {document: document()});

test('new empty library selects ST by validated local metadata audit, without eager body reads or an empty upload', async t => {
  const f = await characterNativeFixture(t), {store, legacy} = session(t, f);
  assert.equal(legacy.state.opened, 0); assert.deepEqual(await store.list(namespace), []);
  assert.deepEqual(legacy.calls, ['storageSummary']); assert.equal(legacy.state.closed, 1); assert.equal(f.uploads, 0);
  const head = await store.save(namespace, {document: document()}); assert.equal((await f.open().load(namespace, head.id)).document.name, 'Alice');
  assert.equal(legacy.calls.includes('save'), false);
});

test('existing native directory never opens IDB, even if that browser DB is inaccessible', async t => {
  const f = await characterNativeFixture(t), head = await seed(f);
  const store = createCharacterArchiveSession({createStorage: f.createStorage, createLocal: () => assert.fail('IDB must not open')}); t.after(() => store.close());
  assert.equal((await store.load(namespace, head.id)).document.name, 'Alice'); assert.equal((await store.usage(namespace)).count, 1);
});

test('nonempty legacy library stays on its unchanged path and is never copied into an empty remote head', async t => {
  const f = await characterNativeFixture(t), {store, legacy} = session(t, f, localFixture({nonempty: true}));
  assert.equal((await store.list(namespace))[0].id, 'legacy'); assert.equal((await store.load(namespace, 'legacy')).document.name, 'Legacy optional fields stay unchanged');
  await store.save(namespace, {document: document('legacy edit')});
  assert.equal(legacy.calls.filter(row => row === 'storageSummary').length, 1); assert.equal(legacy.calls.filter(row => row === 'save').length, 1); assert.equal(f.uploads, 0);
  assert.equal((await f.readIndex()).exists, false);
});

test('orphan/unreadable legacy metadata cannot be interpreted as empty and suppress historical data', async t => {
  const f = await characterNativeFixture(t), {store, legacy} = session(t, f, localFixture({failSummary: true}));
  await assert.rejects(() => store.save(namespace, {document: document()}), /orphan originals/); assert.equal(f.uploads, 0); assert.equal(legacy.calls.includes('save'), false);
});

test('401 and 503 native directory failures do not open or fall back to IDB', async t => {
  const f = await characterNativeFixture(t), {store, legacy} = session(t, f, localFixture({nonempty: true}));
  for (const status of [401, 503]) {
    f.hook(() => new Response('{}', {status, headers: {'content-type': 'application/json'}})); await assert.rejects(() => store.list(namespace));
  }
  assert.equal(legacy.state.opened, 0); assert.equal(f.uploads, 0);
});

test('corrupt native directory is an error, not permission to return a competing local library', async t => {
  const f = await characterNativeFixture(t); await seed(f); const {value} = await f.readIndex(); value.unknown = true; await f.writeIndex(value);
  const {store, legacy} = session(t, f, localFixture({nonempty: true})); f.reset(); await assert.rejects(() => store.list(namespace), /目录/);
  assert.equal(legacy.state.opened, 0); assert.equal(f.uploads, 0);
});

test('native directory appearing during local emptiness audit takes priority before any legacy operation', async t => {
  const f = await characterNativeFixture(t), legacy = localFixture({nonempty: true});
  legacy.store.storageSummary = async () => { await seed(f); return legacy.summary; };
  const {store} = session(t, f, legacy); assert.equal((await store.list(namespace))[0].name, 'Alice'); assert.equal(legacy.calls.includes('list'), false);
});

test('a native head disappearing after selection is not reinitialized as empty or replaced with IDB', async t => {
  const f = await characterNativeFixture(t); await seed(f); const {store, legacy} = session(t, f, localFixture({nonempty: true})); await store.list(namespace);
  const key = [...f.files.keys()].find(name => name.endsWith('-character-library.json')); f.files.delete(key); f.reset();
  await assert.rejects(() => store.list(namespace), /空库/); await assert.rejects(() => store.save(namespace, {document: document()}), /空库/);
  assert.equal(f.uploads, 0); assert.equal(legacy.state.opened, 0);
});

test('a head lost between native selection and its first delegated read cannot masquerade as a fresh library', async t => {
  const f = await characterNativeFixture(t); await seed(f); let heads = 0;
  f.hook(call => { if (call.request.method === 'GET' && call.path.endsWith('-character-library.json') && ++heads === 2) f.files.delete(call.path.split('/').at(-1)); });
  const {store, legacy} = session(t, f, localFixture({nonempty: true})); f.reset();
  await assert.rejects(() => store.list(namespace), /空库/); assert.equal(legacy.state.opened, 0); assert.equal(f.uploads, 0);
});

test('a live legacy session detects native activation before its next operation', async t => {
  const f = await characterNativeFixture(t), {store, legacy} = session(t, f, localFixture({nonempty: true}));
  await store.list(namespace); const head = await seed(f);
  assert.equal((await store.load(namespace, head.id)).document.name, 'Alice'); assert.equal(legacy.calls.includes('load'), false); assert.equal(legacy.state.closed, 1);
});

test('a local write racing remote activation is retained but reported uncertain, never silently replayed remotely', async t => {
  const f = await characterNativeFixture(t), legacy = localFixture({nonempty: true}), {store} = session(t, f, legacy);
  legacy.store.save = async () => { legacy.calls.push('save'); await seed(f); return {saved: true}; };
  await assert.rejects(() => store.save(namespace, {document: document('old-device')}), error => error.writeState === 'unconfirmed' && /未并入/.test(error.message));
  assert.equal(legacy.calls.filter(row => row === 'save').length, 1); assert.deepEqual((await store.list(namespace)).map(row => row.name), ['Alice']);
});

test('failed post-write account check reports uncertainty instead of pretending nothing was saved', async t => {
  const f = await characterNativeFixture(t), legacy = localFixture({nonempty: true}), {store} = session(t, f, legacy);
  legacy.store.save = async () => { legacy.calls.push('save'); f.account('st-user:changed'); return {saved: true}; };
  await assert.rejects(() => store.save(namespace, {document: document()}), error => error.writeState === 'unconfirmed'); assert.equal(legacy.calls.filter(row => row === 'save').length, 1);
});

test('shared first selection serializes emptiness audit and concurrent native saves preserve both archives', async t => {
  const f = await characterNativeFixture(t), {store, legacy} = session(t, f);
  await Promise.all([store.save(namespace, {document: document('one')}), store.save(namespace, {document: document('two')})]);
  assert.equal(legacy.calls.filter(row => row === 'storageSummary').length, 1); assert.deepEqual((await store.list(namespace)).map(row => row.name).sort(), ['one','two']);
});

test('session snapshots input before remote selection and captures restore choices before asynchronous work', async t => {
  const f = await characterNativeFixture(t), {store} = session(t, f), input = {document: document('captured')}, pending = store.save(namespace, input);
  input.document.name = 'late change'; const head = await pending; assert.equal((await store.load(namespace, head.id)).document.name, 'captured');
  const backup = await store.backup(namespace), expectedDigest = await characterLibraryBackupDigest(backup), options = {expectedDigest, confirmed: true, decisions: {}};
  const restoring = store.restoreBackup(namespace, backup, options); options.decisions.invalid = 'incoming'; await restoring;
});

test('caller cancellation and closed sessions stop before opening native or legacy storage', async t => {
  const f = await characterNativeFixture(t), {store, legacy} = session(t, f); f.reset();
  await assert.rejects(() => store.backup(namespace, {isCurrent: () => false}), /变化/); assert.equal(f.calls.length, 0); assert.equal(legacy.state.opened, 0);
  store.close(); await assert.rejects(() => store.list(namespace), /结束/);
});

test('one archive session cannot be reused with a different account even if the transport is still alive', async t => {
  const f = await characterNativeFixture(t), {store} = session(t, f); await store.list(namespace); f.reset();
  await assert.rejects(() => store.list('st-user:elsewhere'), /切换/); assert.equal(f.calls.length, 0);
});

test('ordinary configured factory, casting and bound-subject discovery all consume the same native library', async t => {
  const f = await characterNativeFixture(t), head = await seed(f); f.configure();
  const prior = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB');
  Object.defineProperty(globalThis, 'indexedDB', {configurable: true, value: {open() { assert.fail('unexpected local DB'); }}});
  t.after(() => { if (prior) Object.defineProperty(globalThis, 'indexedDB', prior); else delete globalThis.indexedDB; });
  const factory = createCharacterArchiveStore(); t.after(() => factory.close());
  const subject = {category: 'char', subjectKey: 'char:alice.png', name: 'Alice'};
  await factory.bind(namespace, {target: {...subject, scope: 'default', chatKey: ''}, archiveId: head.id});
  const prepared = await readCharacterCasting({namespace, subjects: [subject], chatKey: 'chat-one', text: 'Alice', guard: async () => {}});
  assert.equal(prepared.entries.length, 1); assert.equal(prepared.entries[0].identity.archiveId, head.id);
  assert.deepEqual(await readStoryboardBoundSubjects(namespace), [{category: 'char', subjectKey: 'char:alice.png'}]);
});

test('explicit local fixtures remain available without probing an unrelated configured server', async t => {
  const f = await characterNativeFixture(t); f.configure(); let opened = 0;
  const store = createCharacterArchiveStore({indexedDB: {open() { opened++; throw Error('local intentionally unavailable'); }}}); t.after(() => store.close()); f.reset();
  await assert.rejects(() => store.list(namespace)); assert.equal(opened, 1); assert.equal(f.calls.length, 0);
});
