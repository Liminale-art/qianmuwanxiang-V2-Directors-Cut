import test from 'node:test';
import assert from 'node:assert/strict';
import { notesSyncOperationId } from '../qianmu-notes-sync-contract.js';
import { createNotesSyncRuntime } from '../qianmu-notes-sync-runtime.js';
import { createNotesSyncClient } from '../qianmu-notes-sync-client.js';
import { emptyNotesLocalState, validateNotesLocalState } from '../qianmu-notes-sync-store.js';

test('secure random operation IDs remain available without randomUUID and never use weak randomness', () => {
  const values = new Set();
  const limited = { getRandomValues: bytes => crypto.getRandomValues(bytes) };
  for (let i = 0; i < 100; i++) { const value = notesSyncOperationId(limited); assert.match(value, /^[a-f0-9]{32}$/); values.add(value); }
  assert.equal(values.size, 100);
  assert.throws(() => notesSyncOperationId({}), /安全便笺编号/);
});

test('HTTP-like browser capabilities preserve local notes, imports and exports and never attempt unverified upload', async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'crypto'), native = globalThis.crypto;
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: { getRandomValues: bytes => native.getRandomValues(bytes) } });
  let api, requests = 0;
  try {
    const namespace = 'st-user:plain-http'; let state = emptyNotesLocalState(namespace);
    const store = {
      async read() { return structuredClone(state); },
      async update(owner, action) { const next = structuredClone(state); await action(next); validateNotesLocalState(next, owner); state = next; return structuredClone(next); },
    };
    const runtime = createNotesSyncRuntime({ namespace, store });
    const saved = await runtime.save({ id: 'local', title: '', body: 'unpinned HTTP original', pinned: false, createdAt: 1, updatedAt: 1 });
    assert.equal(saved.body, 'unpinned HTTP original'); assert.equal((await runtime.list()).length, 1);
    const client = createNotesSyncClient({ namespace, fetchImpl: async () => { requests++; throw new Error('must not upload'); } });
    await assert.rejects(client.list(), error => error.code === 'notes_sync_unavailable' && /HTTPS/.test(error.message));
    assert.equal(requests, 0); client.close();
    api = await import(`../qianmu-notes.js?http-compat=${Date.now()}`);
    api.configureQianmuNotes({ resolveNamespace: async () => namespace, createRuntime: () => runtime });
    await api.saveImportedQianmuNote({ id: 'local', body: 'independent imported original' }, { check() {} });
    assert.equal((await api.listQianmuNotes()).length, 2);
    assert.deepEqual((await api.listQianmuNotes()).map(note => note.body).sort(), ['independent imported original', 'unpinned HTTP original']);
    await assert.rejects(api.adoptLegacyQianmuNotes({ confirmed: true, namespace }), /HTTPS/);
    assert.equal((await api.getQianmuNotesStorage()).count, 2);
  } finally {
    await api?.clearTemporaryQianmuNotes(); Object.defineProperty(globalThis, 'crypto', original);
  }
});
