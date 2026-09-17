import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { historicalOriginalRestoreFixture as fixture, png } from './helpers/historical-original-restore-fixture.mjs';
import { captureStoryboardChatEvidence } from '../qianmu-storyboard-chat-evidence.js';

const consent = view => ({ confirmed: true, scope: view.scope, expectedDigest: view.digest });
const writes = f => f.imageCalls.filter(row => row.action === 'restore');
const gate = () => { let release; const promise = new Promise(resolve => release = resolve); return { promise, release }; };
function annotatedPng() {
  // A valid extra PNG text chunk gives different bytes without trailing garbage.
  const data = Buffer.from('tEXtComment\0alternate'), size = Buffer.alloc(4), crc = Buffer.alloc(4);
  size.writeUInt32BE(data.length - 4); let value = 0xffffffff;
  for (const byte of data) { value ^= byte; for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0); }
  crc.writeUInt32BE((value ^ 0xffffffff) >>> 0);
  return Buffer.concat([png.subarray(0, -12), size, data, crc, png.subarray(-12)]);
}

test('actual missing-only image stage restores exact originals and readbacks without changing chat metadata or recipes', async t => {
  const f = await fixture(t), before = await fs.readFile(f.file), current = structuredClone(f.current), session = f.open();
  assert.equal(f.imageCalls.length, 0);
  const view = await session.preview(); assert.equal(view.ready, true); assert.equal(writes(f).length, 0);
  assert.deepEqual(view.originals.map(row => row.state), ['missing', 'missing']); assert.deepEqual(await fs.readdir(f.images), []);
  const result = await session.restore(consent(view));
  assert.equal(result.originalsVerified, 2); assert.equal(result.completed.length, 2);
  for (const key of ['metadataRestored', 'recipesRestored', 'dependenciesRestored', 'restoreSupported']) assert.equal(result[key], false);
  assert.deepEqual(await fs.readFile(path.join(f.images, 'inline.png')), png); assert.deepEqual(await fs.readFile(path.join(f.images, 'server.png')), png);
  assert.deepEqual(await fs.readFile(f.file), before); assert.deepEqual(f.current, current);
  for (const call of f.imageCalls) { assert.equal(call.headers.Authorization, undefined); assert.equal(call.headers['X-CSRF-Token'], 'fixture'); assert.equal(call.signal.aborted, true); }
  const posts = writes(f); assert.equal(posts.length, 2); assert.ok(posts.every(row => row.body.confirmed === true && row.body.data === png.toString('base64')));
  await assert.rejects(session.restore(consent(view)), /确认/);
});

test('existing identical files are reused without upload, inode replacement or metadata changes', async t => {
  const f = await fixture(t); for (const name of ['inline.png', 'server.png']) await fs.writeFile(path.join(f.images, name), png);
  const target = path.join(f.images, 'inline.png'), before = await fs.stat(target), session = f.open(), view = await session.preview();
  assert.ok(view.originals.every(row => row.state === 'present'));
  const result = await session.restore(consent(view)); assert.equal(writes(f).length, 0); assert.deepEqual(result.completed, []);
  const after = await fs.stat(target); assert.equal(after.ino, before.ino); assert.equal(after.mtimeMs, before.mtimeMs);
});

test('all paths preflight before first write; later conflict prevents even earlier missing originals being uploaded', async t => {
  const f = await fixture(t); await fs.writeFile(path.join(f.images, 'server.png'), 'different content');
  const session = f.open(), view = await session.preview(); assert.equal(view.ready, false);
  assert.deepEqual(view.originals.map(row => row.state), ['missing', 'conflict']);
  await assert.rejects(session.restore(consent(view)), /确认/); assert.equal(writes(f).length, 0);
  await assert.rejects(fs.stat(path.join(f.images, 'inline.png')), { code: 'ENOENT' });
  assert.equal(await fs.readFile(path.join(f.images, 'server.png'), 'utf8'), 'different content');
});

test('confirmation needs a fresh exact digest and explicit originals-only scope', async t => {
  const f = await fixture(t), session = f.open(); await assert.rejects(session.restore({ confirmed: true }));
  const view = await session.preview();
  for (const changed of [{ confirmed: false }, { scope: 'full-restore' }, { expectedDigest: '0'.repeat(64) }]) await assert.rejects(session.restore({ ...consent(view), ...changed }));
  assert.equal(writes(f).length, 0);
});

test('metadata conflict or changed body prevents even image service preflight', async t => {
  const f = await fixture(t); f.current.saved.characterDrafts.items[0].future.note = 'local';
  await assert.rejects(f.open().preview(), /冲突/); assert.equal(f.imageCalls.length, 0);
  f.current.saved = structuredClone(f.saved); f.current.evidence = await captureStoryboardChatEvidence([{ mes: 'different' }], f.target.chatId);
  await assert.rejects(f.open().preview(), /正文/); assert.equal(f.imageCalls.length, 0);
});

test('wrong account, exact character, captured target or current context cannot be borrowed', async t => {
  const f = await fixture(t);
  await assert.rejects(f.open({ namespace: 'st-user:bob' }).preview());
  await assert.rejects(f.open({ target: { ...f.target, avatar: 'Other.png' } }).preview());
  f.current = { ...f.current, target: { ...f.target, avatar: 'Other.png' } };
  await assert.rejects(f.open().preview()); assert.equal(f.imageCalls.length, 0);
});

test('changed destination after confirmation is detected before the first upload and requires a new preview', async t => {
  const f = await fixture(t), session = f.open(), view = await session.preview();
  await fs.writeFile(path.join(f.images, 'server.png'), png);
  await assert.rejects(session.restore(consent(view)), /变化/); assert.equal(writes(f).length, 0);
  await assert.rejects(session.restore(consent(view)), /确认/);
  const fresh = await session.preview(); await session.restore(consent(fresh)); assert.equal(writes(f).length, 1);
});

test('metadata changed while inspecting destinations blocks the preview', async t => {
  const f = await fixture(t); let count = 0;
  const session = f.open({ fetchImpl: async (...args) => { const result = await f.restoreFetch(...args); if (++count === 2) f.current.saved.storyboardImages[0].future = true; return result; } });
  await assert.rejects(session.preview(), /变化/); assert.equal(writes(f).length, 0);
});

test('failure on second upload keeps verified first original and makes no destructive rollback or automatic retry', async t => {
  const f = await fixture(t); let posts = 0;
  const session = f.open({ fetchImpl: async (url, options) => { if (url.endsWith('/restore') && ++posts === 2) throw Error('second failed'); return f.restoreFetch(url, options); } });
  const view = await session.preview();
  await assert.rejects(session.restore(consent(view)), error => error.originalsState === 'needs_review' && error.completed.length === 1 && !error.metadataRestored);
  assert.deepEqual(await fs.readFile(path.join(f.images, 'inline.png')), png); await assert.rejects(fs.stat(path.join(f.images, 'server.png')), { code: 'ENOENT' });
  await assert.rejects(session.preview()); assert.equal(posts, 2);
});

test('lost successful write reply is unconfirmed; explicit new session discovers the file and never reuploads it', async t => {
  const f = await fixture(t); let lost = false;
  const session = f.open({ fetchImpl: async (...args) => { const result = await f.restoreFetch(...args); if (!lost && args[0].endsWith('/restore')) { lost = true; throw Error('reply lost'); } return result; } });
  const view = await session.preview(); await assert.rejects(session.restore(consent(view)), error => error.originalsState === 'needs_review' && error.completed.length === 0);
  assert.deepEqual(await fs.readFile(path.join(f.images, 'inline.png')), png);
  const retry = f.open(), fresh = await retry.preview(); assert.equal(fresh.originals[0].state, 'present');
  await retry.restore(consent(fresh)); assert.equal(writes(f).length, 2);
});

test('account or metadata change after first write stops remaining files and retains existing evidence', async t => {
  const f = await fixture(t); let changed = false;
  const session = f.open({ fetchImpl: async (...args) => { const result = await f.restoreFetch(...args); if (!changed && args[0].endsWith('/restore')) { changed = true; f.current.saved.storyboardImages[0].future = 'changed'; } return result; } });
  const view = await session.preview(); await assert.rejects(session.restore(consent(view)), error => error.originalsState === 'needs_review');
  assert.equal(writes(f).length, 1); assert.deepEqual(await fs.readFile(path.join(f.images, 'inline.png')), png);
});

test('mismatched POST or final file readback never reports successful originals verification', async t => {
  const f = await fixture(t); let posted = false;
  const session = f.open({ fetchImpl: async (url, options) => {
    const response = await f.restoreFetch(url, options), value = await response.json();
    if (url.endsWith('/restore')) posted = true;
    else if (posted && url.endsWith('/inspect')) value.state = 'missing';
    return Response.json(value, { status: response.status });
  } });
  const view = await session.preview(); await assert.rejects(session.restore(consent(view)), error => error.originalsState === 'needs_review'); assert.equal(writes(f).length, 1);
});

test('close cancels an in-flight HTTP request and a late ignored response cannot upload another file', async t => {
  const f = await fixture(t), started = gate(), hold = gate(); let pendingSignal, posts = 0;
  const session = f.open({ fetchImpl: async (url, options) => { if (url.endsWith('/restore')) { posts++; pendingSignal = options.signal; started.release(); await hold.promise; } return f.restoreFetch(url, options); } });
  const view = await session.preview(), rejected = assert.rejects(session.restore(consent(view)), error => error.originalsState === 'needs_review');
  await started.promise; session.close(); await rejected; assert.equal(pendingSignal.aborted, true);
  hold.release(); await new Promise(resolve => setTimeout(resolve, 20)); assert.equal(posts, 1); await assert.rejects(session.preview());
});

test('deadline and parent cancellation cover stalled guard and stalled current-context resolver', async t => {
  const f = await fixture(t);
  for (const field of ['guard', 'readCurrent']) {
    const hold = gate(), session = f.open({ timeoutMs: 40, [field]: () => hold.promise });
    await assert.rejects(session.preview(), error => error.originalsState === 'not_started'); hold.release(field === 'readCurrent' ? f.current : undefined);
  }
  const controller = new AbortController(), hold = gate(), session = f.open({ signal: controller.signal, readCurrent: () => hold.promise });
  const rejected = assert.rejects(session.preview(), /取消/); controller.abort(); await rejected; hold.release(f.current);
  await new Promise(resolve => setTimeout(resolve, 10)); assert.equal(writes(f).length, 0);
});

test('concurrent operations cannot reuse a pending preview and selected target is captured at construction', async t => {
  const f = await fixture(t), hold = gate(), target = { ...f.target }; let blocked = true;
  const session = f.open({ target, guard: async () => { if (blocked) await hold.promise; } });
  target.avatar = 'Other.png'; const first = session.preview(); await assert.rejects(session.preview(), /正在进行/);
  blocked = false; hold.release(); assert.equal((await first).ready, true); assert.equal(writes(f).length, 0);
});

test('external or malformed original paths stop before any image request', async t => {
  const f = await fixture(t, { prepare: f => f.rows[1].url = 'https://external.example/private.png' });
  await assert.rejects(f.open().preview()); assert.equal(f.imageCalls.length, 0);
});

test('shared identical original destinations are restored once while differing bytes at the same path are rejected', async t => {
  const f = await fixture(t, { prepare: f => f.rows[1].url = f.rows[0].url });
  const session = f.open(), view = await session.preview(); assert.equal(view.originals.length, 1); await session.restore(consent(view)); assert.equal(writes(f).length, 1);
  const other = await fixture(t, { prepare: f => f.rows[1].url = f.rows[0].url, readImage: async row => new Blob([row.recordId === 'server' ? annotatedPng() : png]) });
  await assert.rejects(other.open().preview(), /路径/); assert.equal(other.imageCalls.length, 0);
});

test('empty historical gallery performs no image-service calls and still does not claim metadata restoration', async t => {
  const f = await fixture(t, { prepare: f => f.rows.splice(0) }), session = f.open(), view = await session.preview();
  const result = await session.restore(consent(view)); assert.equal(result.originalsVerified, 0); assert.equal(result.metadataRestored, false); assert.equal(f.imageCalls.length, 0);
});

test('deadline during a started upload is unconfirmed and late resolution cannot upload the next image', async t => {
  const f = await fixture(t), hold = gate(); let posts = 0, pendingSignal;
  const session = f.open({ timeoutMs: 200, fetchImpl: async (url, options) => {
    if (url.endsWith('/restore')) { posts++; pendingSignal = options.signal; await hold.promise; }
    return f.restoreFetch(url, options);
  } });
  const view = await session.preview(); await assert.rejects(session.restore(consent(view)), error => error.originalsState === 'needs_review');
  assert.equal(pendingSignal.aborted, true); hold.release(); await new Promise(resolve => setTimeout(resolve, 20)); assert.equal(posts, 1);
});

test('false source guard and old backend stop before uploads without inventing successful verification', async t => {
  const f = await fixture(t); await assert.rejects(f.open({ guard: async () => false }).preview(), /保护/);
  await assert.rejects(f.open({ fetchImpl: async () => new Response('old backend', { status: 404 }) }).preview(), /不兼容/);
  assert.equal(writes(f).length, 0);
});
