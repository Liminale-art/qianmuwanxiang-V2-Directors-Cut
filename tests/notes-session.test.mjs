import test from 'node:test';
import assert from 'node:assert/strict';

async function fixture() {
  const api = await import(`../qianmu-notes.js?fixture=${crypto.randomUUID()}`), accounts = new Map(), notices = [];
  let account = 'st-user:alice', writes = 0, closes = 0, blocker = null;
  const createRuntime = ({ namespace, guard, onChange }) => {
    const notes = accounts.get(namespace) || new Map(); accounts.set(namespace, notes);
    return {
      status: { state: 'local-only', pending: notes.size, error: '', conflicts: 0 },
      async list() { await guard(); return [...notes.values()].map(value => ({ ...value })); },
      async save(note) { await guard(); if (blocker) await blocker; const saved = { ...note, localRevision: (notes.get(note.id)?.localRevision || 0) + 1, revision: 0 }; notes.set(note.id, saved); writes++; onChange({ reason: 'save' }); return saved; },
      async remove(id) { await guard(); notes.delete(id); },
      async sync() { await guard(); },
      close() { closes++; },
    };
  };
  api.configureQianmuNotes({ resolveNamespace: async () => account, createRuntime, onChange: event => notices.push(event) });
  return { api, accounts, notices, setAccount(value) { account = value; }, setBlock(value) { blocker = value; }, get writes() { return writes; }, get closes() { return closes; } };
}

test('facade preserves account, synchronization revisions, and all unpinned originals across reopen', async () => {
  const e = await fixture();
  try {
    const note = e.api.createQianmuNote({ body: 'unfixed original', pinned: false });
    const saved = await e.api.saveQianmuNote(note);
    assert.equal(saved._notesAccount, 'st-user:alice'); assert.equal(saved.localRevision, 1); assert.equal(saved.pinned, false);
    assert.equal((await e.api.listQianmuNotes())[0].body, 'unfixed original');
    await e.api.clearTemporaryQianmuNotes();
    assert.equal((await e.api.listQianmuNotes())[0].body, 'unfixed original'); assert.equal(e.closes, 1);
    await e.api.saveQianmuNote({ ...saved, pinned: true });
    const unpinned = await e.api.saveQianmuNote({ ...(await e.api.listQianmuNotes())[0], pinned: false });
    assert.equal(unpinned.localRevision, 3); assert.equal(unpinned.body, saved.body);
  } finally { await e.api.clearTemporaryQianmuNotes(); }
});

test('old-account editor cannot silently become a new-account note on save or deletion', async () => {
  const e = await fixture();
  try {
    const original = await e.api.saveQianmuNote(e.api.createQianmuNote({ body: 'Alice only' }));
    e.setAccount('st-user:bob');
    await assert.rejects(e.api.saveQianmuNote(original), /账户或会话已变化/);
    await assert.rejects(e.api.deleteQianmuNote(original.id, { namespace: original._notesAccount }), /账户或会话已变化/);
    assert.deepEqual(await e.api.listQianmuNotes(), []); assert.equal(e.accounts.get('st-user:alice').get(original.id).body, 'Alice only');
    assert.ok(e.notices.some(event => event.reason === 'account'));
  } finally { await e.api.clearTemporaryQianmuNotes(); }
});

test('late local acknowledgements are not published after the host account changes', async () => {
  const e = await fixture(); let release;
  try {
    await e.api.listQianmuNotes(); e.setBlock(new Promise(resolve => { release = resolve; }));
    const operation = e.api.saveQianmuNote(e.api.createQianmuNote({ body: 'original account draft' }));
    await new Promise(resolve => setImmediate(resolve)); e.setAccount('st-user:bob'); release();
    await assert.rejects(operation, /账户或会话已变化/);
    assert.equal(e.writes, 1); assert.equal(e.accounts.get('st-user:alice').size, 1); assert.equal(e.accounts.has('st-user:bob'), false);
  } finally { await e.api.clearTemporaryQianmuNotes(); }
});

test('disposal waits for already-started local persistence and new reads wait for disposal', async () => {
  const e = await fixture(); let release;
  try {
    await e.api.listQianmuNotes(); e.setBlock(new Promise(resolve => { release = resolve; }));
    const operation = e.api.saveQianmuNote(e.api.createQianmuNote({ body: 'last edit' }));
    await new Promise(resolve => setImmediate(resolve)); const closing = e.api.clearTemporaryQianmuNotes();
    assert.equal(e.closes, 0); const reading = e.api.listQianmuNotes(); release(); await operation; await closing;
    assert.equal((await reading)[0].body, 'last edit'); assert.equal(e.closes, 1);
  } finally { await e.api.clearTemporaryQianmuNotes(); }
});

test('immediate disposal also drains the last input still awaiting account resolution', async () => {
  const e = await fixture();
  try {
    const before = await e.api.saveQianmuNote(e.api.createQianmuNote({ body: 'before' }));
    const saving = e.api.saveQianmuNote({ ...before, body: 'last key' });
    const closing = e.api.clearTemporaryQianmuNotes();
    await saving; await closing;
    assert.equal((await e.api.listQianmuNotes())[0].body, 'last key');
  } finally { await e.api.clearTemporaryQianmuNotes(); }
});

test('cold concurrent saves drain through opening without deadlocking close or the next read', async () => {
  const e = await fixture();
  try {
    const first = e.api.saveQianmuNote(e.api.createQianmuNote({ body: 'first cold draft' }));
    const second = e.api.saveQianmuNote(e.api.createQianmuNote({ body: 'second cold draft' }));
    const closing = e.api.clearTemporaryQianmuNotes();
    const reading = e.api.listQianmuNotes();
    await assert.rejects(e.api.saveQianmuNote(e.api.createQianmuNote({ body: 'not admitted during close' })), /账户或会话已变化/);
    const [firstSaved, secondSaved, , notes] = await Promise.all([first, second, closing, reading]);
    assert.notEqual(firstSaved.id, secondSaved.id);
    assert.deepEqual(notes.map(note => note.body).sort(), ['first cold draft', 'second cold draft']);
    assert.equal(e.writes, 2); assert.equal(e.closes, 1);
  } finally { await e.api.clearTemporaryQianmuNotes(); }
});

test('close admission never authorizes an old-account save after the real account changes', async () => {
  const e = await fixture();
  try {
    const original = await e.api.saveQianmuNote(e.api.createQianmuNote({ body: 'Alice original' }));
    const saving = e.api.saveQianmuNote({ ...original, body: 'old-account edit' });
    const closing = e.api.clearTemporaryQianmuNotes();
    e.setAccount('st-user:bob');
    await assert.rejects(saving, /账户或会话已变化/); await closing;
    assert.deepEqual(await e.api.listQianmuNotes(), []);
    assert.equal(e.accounts.get('st-user:alice').get(original.id).body, 'Alice original');
    assert.equal(e.writes, 1);
  } finally { await e.api.clearTemporaryQianmuNotes(); }
});

test('migration needs an explicitly confirmed account and never opens the old store otherwise', async () => {
  const e = await fixture();
  try {
    await assert.rejects(e.api.adoptLegacyQianmuNotes(), /确认旧便笺所属/);
    await assert.rejects(e.api.adoptLegacyQianmuNotes({ confirmed: true, namespace: 'st-user:another' }), /账户或会话已变化/);
    assert.equal(e.writes, 0);
  } finally { await e.api.clearTemporaryQianmuNotes(); }
});
