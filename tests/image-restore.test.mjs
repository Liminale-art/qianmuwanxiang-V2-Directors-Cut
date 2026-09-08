import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { createImageRestoreService } from '../qianmu-image-restore-service.js';
import { imageRestoreReceipt, imageRestoreRequest, imageRestoreErrorPayload } from '../qianmu-image-restore-contract.js';
import { createImageRestoreClient } from '../qianmu-image-restore-client.js';
import { imageServiceAccount } from '../qianmu-image-service-access.js';
import { init, exit } from '../server-plugin.js';

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aKuoAAAAASUVORK5CYII=';
const bytes = Buffer.from(PNG, 'base64'), sha256 = createHash('sha256').update(bytes).digest('hex');
const receipt = { url: '/user/images/Qianmu-References/original.png', sha256, mime: 'image/png', bytes: bytes.length };
const account = handle => imageServiceAccount({ user: { profile: { handle, enabled: true } } }).namespace;
const input = (write = false, row = receipt) => ({ version: 1, expectedAccount: account('alice'), receipt: row, ...(write ? { confirmed: true, data: PNG } : {}) });
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
const result = (state, row = receipt) => ({ ok: true, version: 1, expectedAccount: account('alice'), receipt: row, state });
const capability = () => ({ ok: true, version: 1, expectedAccount: account('alice'), originalPaths: true, missingOnly: true, automaticReplay: false, maxImageBytes: 16 * 1024 * 1024 });
const gate = () => { let release; const promise = new Promise(resolve => { release = resolve; }); return { promise, release }; };
async function fixture(t, options = {}) {
  const parent = await fs.realpath(os.tmpdir()), root = await fs.mkdtemp(path.join(parent, 'qianmu-restore-test-'));
  const userRoot = path.join(root, 'alice'), images = path.join(userRoot, 'user', 'images');
  await fs.mkdir(images, { recursive: true });
  const request = { user: { profile: { handle: 'alice', enabled: true }, directories: { root: userRoot, userImages: images } } };
  const service = createImageRestoreService({ dataRoot: root, ...options });
  t.after(async () => {
    await service.close(); const real = await fs.realpath(root);
    assert.equal(path.dirname(real), parent); assert.match(path.basename(real), /^qianmu-restore-test-/); await fs.rm(real, { recursive: true });
  });
  return { root, images, request, service, target: path.join(images, 'Qianmu-References', 'original.png'), stage: path.join(images, '.qianmu-restore-v1') };
}
async function installed(f, value = bytes) { await fs.mkdir(path.dirname(f.target), { recursive: true }); await fs.writeFile(f.target, value, { flag: 'wx' }); }
const isMissing = async name => { await assert.rejects(fs.lstat(name), { code: 'ENOENT' }); };

test('image restore contract rejects paths, credentials, overflows and unconfirmed input without changing receipts', () => {
  assert.deepEqual(imageRestoreReceipt(receipt), receipt);
  for (const url of ['user/images/a.png', '/user/images/../a.png', '/user/images/%2e%2e/a.png', '/user/images/C%3A/a.png', '/user/images/.private/a.png',
    '/user/images/aux.png', '/user/images/name%20/a.png', '/user/images/a%2fb.png', '/user/images/a%252fb.png', '/user/images/a.png?q=1', 'https://other.example/a.png',
    '/user/images/name%5C/a.png', '/user/images/a.jpg', '/user/images/a%00.png', '/user/images/' + 'a/'.repeat(9) + 'x.png']) {
    assert.throws(() => imageRestoreReceipt({ ...receipt, url }), /原图|参考图/);
  }
  assert.equal(imageRestoreReceipt({ ...receipt, url: '/user/images/%E5%9B%BE%20%E7%89%87/a.png' }).bytes, bytes.length);
  for (const extra of [{ apiKey: 'no' }, { directory: 'C:/private' }, { namespace: 'alice' }]) assert.throws(() => imageRestoreRequest({ ...input(), ...extra }));
  assert.equal(imageRestoreReceipt({ ...receipt, bytes: 24 * 1024 * 1024 }).bytes, 24 * 1024 * 1024);
  assert.throws(() => imageRestoreReceipt({ ...receipt, bytes: 24 * 1024 * 1024 + 1 }));
  assert.throws(() => imageRestoreRequest({ ...input(true), confirmed: false }, { write: true }));
  assert.throws(() => imageRestoreRequest({ ...input(true), data: PNG + '==' }, { write: true }));
  assert.throws(() => imageRestoreReceipt({ ...receipt, name: 'not-a-disk-field' }));
  assert.throws(() => imageRestoreReceipt({ ...receipt, sha256: [sha256] }));
});

test('capabilities and missing-file inspection are authenticated and never create directories', async t => {
  const f = await fixture(t);
  await assert.rejects(f.service.capabilities({}), { status: 401 });
  assert.deepEqual(await f.service.capabilities(f.request), { ...capability(), maxGalleryImageBytes: 24 * 1024 * 1024 });
  assert.equal((await f.service.inspect(f.request, input())).state, 'missing');
  assert.deepEqual(await fs.readdir(f.images), []);
  await assert.rejects(f.service.inspect(f.request, { ...input(), expectedAccount: account('bob') }), { status: 401 });
  f.request.user.profile.enabled = false; await assert.rejects(f.service.capabilities(f.request), { status: 401 });
});

test('old 16 MiB services remain compatible for references but stop larger gallery receipts before inspection or upload', async () => {
  const calls = [], fetchImpl = async (url, options) => {
    calls.push(url); if (url.endsWith('/capabilities')) return json(capability());
    return json(result('missing', JSON.parse(options.body).receipt));
  };
  const client = createImageRestoreClient({ namespace: 'st-user:alice', fetchImpl });
  assert.equal((await client.inspect(receipt)).state, 'missing');
  const before = calls.length;
  await assert.rejects(client.inspect({ ...receipt, bytes: 16 * 1024 * 1024 + 1 }), /更新后端/);
  assert.equal(calls.length, before);
  const updated = createImageRestoreClient({ namespace: 'st-user:alice', fetchImpl: async (url, options) => url.endsWith('/capabilities')
    ? json({ ...capability(), maxGalleryImageBytes: 24 * 1024 * 1024 }) : json(result('missing', JSON.parse(options.body).receipt)) });
  assert.equal((await updated.inspect({ ...receipt, bytes: 24 * 1024 * 1024 })).state, 'missing');
});

test('add-only originals keep exact URL, bytes, inode and modification time on repeated restoration', async t => {
  const f = await fixture(t);
  assert.equal((await f.service.restore(f.request, input(true))).state, 'created');
  assert.deepEqual(await fs.readFile(f.target), bytes);
  const before = await fs.stat(f.target); assert.equal(before.nlink, 1);
  assert.equal((await f.service.inspect(f.request, input())).state, 'present');
  assert.equal((await f.service.restore(f.request, input(true))).state, 'reused');
  const after = await fs.stat(f.target); assert.equal(after.ino, before.ino); assert.equal(after.mtimeMs, before.mtimeMs);
  assert.deepEqual(await fs.readdir(f.stage), []);
});

test('existing different bytes or size never get overwritten', async t => {
  const f = await fixture(t); await installed(f, Buffer.alloc(bytes.length, 1));
  assert.equal((await f.service.inspect(f.request, input())).state, 'conflict');
  await assert.rejects(f.service.restore(f.request, input(true)), { code: 'image_restore_conflict' });
  assert.deepEqual(await fs.readFile(f.target), Buffer.alloc(bytes.length, 1)); await isMissing(f.stage);
  await fs.writeFile(f.target, 'test-owned shorter original');
  assert.equal((await f.service.inspect(f.request, input())).state, 'conflict');
  await assert.rejects(f.service.restore(f.request, input(true)), { code: 'image_restore_conflict' });
  assert.equal(await fs.readFile(f.target, 'utf8'), 'test-owned shorter original');
});

test('invalid bytes, MIME, digest and extra credentials cannot cause any filesystem writes', async t => {
  const f = await fixture(t);
  for (const value of [{ ...input(true), data: Buffer.alloc(bytes.length).toString('base64') },
    { ...input(true), receipt: { ...receipt, sha256: 'f'.repeat(64) } }, { ...input(true), apiKey: 'private' },
    { ...input(true), receipt: { ...receipt, url: '/user/images/a.jpg', mime: 'image/jpeg' } }]) await assert.rejects(f.service.restore(f.request, value));
  assert.deepEqual(await fs.readdir(f.images), []);
});

test('a competing file appearing at publication wins; exclusive linking never replaces it', async t => {
  let target;
  const f = await fixture(t, { io: { ...fs, async link(from, to) { target = to; await fs.writeFile(to, 'race winner', { flag: 'wx' }); return fs.link(from, to); } } });
  await assert.rejects(f.service.restore(f.request, input(true)), { code: 'image_restore_conflict' });
  assert.equal(target, f.target); assert.equal(await fs.readFile(target, 'utf8'), 'race winner'); assert.deepEqual(await fs.readdir(f.stage), []);
});

test('a competing identical original is reused without being renamed or written', async t => {
  const f = await fixture(t, { io: { ...fs, async link(from, to) { await fs.writeFile(to, bytes, { flag: 'wx' }); return fs.link(from, to); } } });
  assert.equal((await f.service.restore(f.request, input(true))).state, 'reused');
  assert.deepEqual(await fs.readFile(f.target), bytes); assert.equal((await fs.stat(f.target)).nlink, 1);
});

test('unsupported hard links or disk failure never fall back to overwrite-capable uploads/copies', async t => {
  const f = await fixture(t, { io: { ...fs, async link() { throw Object.assign(new Error('disk path /private must not escape'), { code: 'EPERM' }); } } });
  let caught; try { await f.service.restore(f.request, input(true)); } catch (error) { caught = error; }
  assert.equal(imageRestoreErrorPayload(caught).status, 503);
  assert.doesNotMatch(JSON.stringify(imageRestoreErrorPayload(caught)), /private/);
  await isMissing(f.target); assert.deepEqual(await fs.readdir(f.stage), []);
});

test('published bytes survive a lost staging cleanup; a new service can inspect and finish only its proven second link', async t => {
  let failures = 1;
  const f = await fixture(t, { io: { ...fs, async unlink(file) { if (file.endsWith('.ready') && failures-- > 0) throw Object.assign(new Error('disk failure'), { code: 'EIO' }); return fs.unlink(file); } } });
  await assert.rejects(f.service.restore(f.request, input(true)), { code: 'EIO' });
  assert.deepEqual(await fs.readFile(f.target), bytes); assert.equal((await fs.stat(f.target)).nlink, 2);
  await f.service.close(); const next = createImageRestoreService({ dataRoot: f.root }); t.after(() => next.close());
  assert.equal((await next.inspect(f.request, input())).state, 'present'); assert.equal((await fs.stat(f.target)).nlink, 2);
  assert.equal((await next.restore(f.request, input(true))).state, 'reused'); assert.equal((await fs.stat(f.target)).nlink, 1);
  assert.deepEqual(await fs.readdir(f.stage), []); assert.deepEqual(await fs.readFile(f.target), bytes);
});

test('unrelated final hard links and directory junctions are rejected without reads or writes outside the account', async t => {
  const f = await fixture(t); await installed(f);
  const other = path.join(f.root, 'unrelated.png'); await fs.link(f.target, other);
  await assert.rejects(f.service.inspect(f.request, input()), { code: 'image_restore_path' });
  await assert.rejects(f.service.restore(f.request, input(true)), { code: 'image_restore_path' });
  await fs.unlink(other); assert.deepEqual(await fs.readFile(f.target), bytes);
  const outside = path.join(f.root, 'other-user'); await fs.mkdir(outside);
  const junction = path.join(f.images, 'redirect'); await fs.symlink(outside, junction, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(f.service.restore(f.request, input(true, { ...receipt, url: '/user/images/redirect/stolen.png' })), { code: 'image_restore_path' });
  assert.deepEqual(await fs.readdir(outside), []);
  await fs.unlink(junction); // Remove only the test-owned link, never recurse through a junction.
});

test('trusted ST root/images directory relationships are required, not request body paths', async t => {
  const f = await fixture(t), changed = structuredClone(f.request);
  changed.user.directories.root = f.root; await assert.rejects(f.service.capabilities(changed), { code: 'image_restore_path' });
  changed.user.directories.root = path.join(f.root, 'alice'); changed.user.directories.userImages = path.join(f.root, 'bob', 'images');
  await assert.rejects(f.service.capabilities(changed), { code: 'image_restore_path' });
  changed.user.directories = null; await assert.rejects(f.service.capabilities(changed), { code: 'image_restore_setup' });
  assert.throws(() => createImageRestoreService({ dataRoot: path.parse(f.root).root }));
});

test('a filesystem without reliable file identities is not treated as safe for original replacement or recovery cleanup', async t => {
  const f = await fixture(t, { io: { ...fs, async lstat(file, options) { const stat = await fs.lstat(file, options); if (stat.isFile()) stat.ino = 0n; return stat; } } });
  await installed(f); await assert.rejects(f.service.inspect(f.request, input()), { code: 'image_restore_changed' });
  await assert.rejects(f.service.restore(f.request, input(true)), { code: 'image_restore_changed' });
  assert.deepEqual(await fs.readFile(f.target), bytes); await isMissing(f.stage);
});

test('64-bit filesystem identities work without rounding, including staged publication and recovery', async t => {
  const widen = stat => { assert.equal(typeof stat.ino, 'bigint'); if (stat.isFile()) stat.ino += 2n ** 64n; return stat; };
  const f = await fixture(t, { io: { ...fs,
    async lstat(file, options) { assert.equal(options?.bigint, true); return widen(await fs.lstat(file, options)); },
    async open(...args) { const handle = await fs.open(...args); return new Proxy(handle, { get(target, prop) {
      if (prop === 'stat') return async options => { assert.equal(options?.bigint, true); return widen(await target.stat(options)); };
      const value = target[prop]; return typeof value === 'function' ? value.bind(target) : value;
    } }); },
  } });
  assert.equal((await f.service.restore(f.request, input(true))).state, 'created');
  assert.equal((await f.service.restore(f.request, input(true))).state, 'reused');
  assert.deepEqual(await fs.readFile(f.target), bytes); assert.deepEqual(await fs.readdir(f.stage), []);
});

test('two different 64-bit file IDs that round to the same Number are never treated as one original', async t => {
  const beforeId = 2n ** 60n + 1n, openedId = beforeId + 1n; assert.equal(Number(beforeId), Number(openedId));
  const f = await fixture(t, { io: { ...fs,
    async lstat(file, options) { const stat = await fs.lstat(file, options); if (stat.isFile()) stat.ino = beforeId; return stat; },
    async open(...args) { const handle = await fs.open(...args); return new Proxy(handle, { get(target, prop) {
      if (prop === 'stat') return async options => { const stat = await target.stat(options); stat.ino = openedId; return stat; };
      const value = target[prop]; return typeof value === 'function' ? value.bind(target) : value;
    } }); },
  } });
  await installed(f); await assert.rejects(f.service.restore(f.request, input(true)), { code: 'image_restore_changed' });
  assert.deepEqual(await fs.readFile(f.target), bytes); await isMissing(f.stage);
});

test('account changes before publication discard only own stage and do not publish for either user', async t => {
  let request;
  const f = await fixture(t, { io: { ...fs, async rename(from, to) { await fs.rename(from, to); request.user.directories = null; } } }); request = f.request;
  await assert.rejects(f.service.restore(f.request, input(true)), { code: 'image_restore_changed' });
  await isMissing(f.target); assert.deepEqual(await fs.readdir(f.stage), []);
});

test('damaged staged bytes are never published even if the filesystem reported successful writes', async t => {
  const f = await fixture(t, { io: { ...fs, async rename(from, to) { await fs.rename(from, to); await fs.writeFile(to, Buffer.alloc(bytes.length)); } } });
  await assert.rejects(f.service.restore(f.request, input(true)), { code: 'image_restore_content' });
  await isMissing(f.target); assert.deepEqual(await fs.readdir(f.stage), []);
});

test('late missing-directory inspection does not return success for a changed account', async t => {
  let request;
  const f = await fixture(t, { io: { ...fs, async lstat(file, options) {
    if (file.endsWith('Qianmu-References')) { request.user.profile.handle = 'bob'; throw Object.assign(new Error('missing'), { code: 'ENOENT' }); }
    return fs.lstat(file, options);
  } } }); request = f.request;
  await assert.rejects(f.service.inspect(f.request, input()), { code: 'image_restore_changed' });
  assert.deepEqual(await fs.readdir(f.images), []);
});

test('abort after publication leaves the complete original and read-only inspection can settle uncertainty', async t => {
  const abort = new AbortController();
  const f = await fixture(t, { io: { ...fs, async link(from, to) { await fs.link(from, to); abort.abort(); } } });
  await assert.rejects(f.service.restore(f.request, input(true), { signal: abort.signal }), { code: 'image_restore_changed' });
  assert.deepEqual(await fs.readFile(f.target), bytes); assert.equal((await fs.stat(f.target)).nlink, 1);
  assert.equal((await f.service.inspect(f.request, input())).state, 'present');
});

test('bounded concurrency rejects another operation for the same account and close does not replay it', async t => {
  const began = gate(), finish = gate(); let blocked = true;
  const f = await fixture(t, { io: { ...fs, async realpath(file) { if (blocked) { blocked = false; began.release(); await finish.promise; } return fs.realpath(file); } } });
  const pending = f.service.restore(f.request, input(true)); await began.promise;
  await assert.rejects(f.service.inspect(f.request, input()), { code: 'image_restore_busy', status: 429 });
  const closing = f.service.close(); finish.release();
  await assert.rejects(pending, { code: 'image_restore_changed' }); await closing; await isMissing(f.target);
});

test('orphan staging is bounded and never automatically erased to make room', async t => {
  const f = await fixture(t); await fs.mkdir(f.stage);
  for (let i = 0; i < 256; i++) await fs.writeFile(path.join(f.stage, `owned-by-other-attempt-${i}.part`), 'partial', { flag: 'wx' });
  await assert.rejects(f.service.restore(f.request, input(true)), { code: 'image_restore_staging' });
  assert.equal((await fs.readdir(f.stage)).length, 256); await isMissing(f.target);
});

test('real restore HTTP endpoints use host account/directories and no-store; no generation or generic upload', async t => {
  const f = await fixture(t), routes = new Map();
  await init({ get: (name, handler) => routes.set(`GET ${name}`, handler), post: (name, handler) => routes.set(`POST ${name}`, handler) }, { dataRoot: f.root });
  const server = http.createServer(async (req, res) => {
    // Test host middleware only; the production route has no header-to-account mapping.
    if (req.headers['x-test-login'] === 'alice') req.user = structuredClone(f.request.user);
    const chunks = []; for await (const chunk of req) chunks.push(chunk); req.body = chunks.length ? JSON.parse(Buffer.concat(chunks)) : {};
    res.set = (key, value) => { res.setHeader(key, value); return res; }; res.status = code => { res.statusCode = code; return res; };
    res.json = value => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(value)); return res; };
    const handler = routes.get(`${req.method} ${req.url}`); if (!handler) { res.statusCode = 404; return res.end(); } await handler(req, res);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await exit(); });
  const base = `http://127.0.0.1:${server.address().port}/image/restore`;
  assert.equal((await fetch(`${base}/capabilities`)).status, 401);
  let writes = 0;
  const client = createImageRestoreClient({ namespace: 'st-user:alice', fetchImpl: async (url, options) => {
    assert.match(url, /^\/api\/plugins\/qianmu-tts\/image\/restore\/(capabilities|inspect|restore)$/);
    if (url.endsWith('/restore')) writes++;
    const response = await fetch(`${base}/${url.split('/').at(-1)}`, { ...options, headers: { ...options.headers, 'x-test-login': 'alice' } });
    assert.equal(response.headers.get('cache-control'), 'no-store'); return response;
  } });
  assert.equal((await client.inspect(receipt)).state, 'missing'); assert.deepEqual(await fs.readdir(f.images), []);
  assert.equal((await client.restore(receipt, PNG, { confirmed: true })).state, 'created');
  assert.equal((await client.inspect(receipt)).state, 'present');
  assert.equal((await client.restore(receipt, PNG, { confirmed: true })).state, 'reused'); assert.equal(writes, 2);
  assert.deepEqual(await fs.readFile(f.target), bytes);
  const response = await fetch(`${base}/restore`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-test-login': 'alice' }, body: JSON.stringify({ ...input(true), user: { directories: f.request.user.directories } }) });
  assert.equal(response.status, 400); assert.doesNotMatch(await response.text(), /qianmu-restore-test-|\\Users|apiKey/);
});

test('client does not send anything before explicit restore confirmation and filters all upstream headers', async () => {
  const calls = [];
  const client = createImageRestoreClient({ namespace: 'st-user:alice', headers: () => ({ Authorization: 'Bearer secret', 'x-api-key': 'private', 'x-csrf-token': 'csrf' }), fetchImpl: async (url, options) => {
    calls.push({ url, options }); return json(url.endsWith('/capabilities') ? capability() : result('created'));
  } });
  await assert.rejects(client.restore(receipt, PNG), { imageWriteState: 'not_started' }); assert.equal(calls.length, 0);
  await client.restore(receipt, PNG, { confirmed: true }); assert.equal(calls.length, 2);
  const sent = calls.at(-1); assert.equal(sent.options.redirect, 'error'); assert.equal(sent.options.credentials, 'same-origin');
  assert.equal(sent.options.headers['X-CSRF-Token'], 'csrf'); assert.doesNotMatch(JSON.stringify(calls), /Bearer|private|st-user:alice/);
  assert.deepEqual(JSON.parse(sent.options.body), input(true));
});

test('client rejects old/wrong-account capability before any write and never falls back to native upload', async () => {
  for (const value of [{ ...capability(), missingOnly: false }, { ...capability(), expectedAccount: account('bob') }, { ...capability(), version: 2 }]) {
    let requests = 0;
    const client = createImageRestoreClient({ namespace: 'st-user:alice', fetchImpl: async () => { requests++; return json(value); } });
    await assert.rejects(client.restore(receipt, PNG, { confirmed: true })); assert.equal(requests, 1);
  }
});

test('write errors and receipt mismatch remain unconfirmed even when response says generation was not submitted', async () => {
  for (const response of [() => json({ ok: false, version: 1, code: 'image_restore_storage', message: '请核对原文件', submissionState: 'not_submitted' }, 503),
    () => json(result('created', { ...receipt, sha256: 'a'.repeat(64) })), () => json({ ...result('created'), expectedAccount: account('bob') }),
    () => new Response('<html>login</html>'), () => { throw new Error('network error secret'); }]) {
    let requests = 0;
    const client = createImageRestoreClient({ namespace: 'st-user:alice', fetchImpl: async url => { requests++; return url.endsWith('/capabilities') ? json(capability()) : response(); } });
    await assert.rejects(client.restore(receipt, PNG, { confirmed: true }), { imageWriteState: 'unconfirmed', retryable: false }); assert.equal(requests, 2);
  }
});

test('client input is frozen before async guard; return after account/page change cannot be accepted', async () => {
  let active = true; const original = { ...receipt }, captured = [];
  const client = createImageRestoreClient({ namespace: 'st-user:alice', guard: async () => { if (!active) throw new Error('changed'); original.url = '/user/images/changed.png'; }, fetchImpl: async (url, options) => {
    if (url.endsWith('/capabilities')) return json(capability()); captured.push(JSON.parse(options.body)); active = false; return json(result('created'));
  } });
  await assert.rejects(client.restore(original, PNG, { confirmed: true }), { imageWriteState: 'unconfirmed' });
  assert.equal(captured.length, 1); assert.deepEqual(captured[0].receipt, receipt);
});

test('bounded malformed or stalled restore responses abort without an automatic retry', async () => {
  for (const mode of ['size', 'stream', 'timeout']) {
    let requests = 0, signal;
    const client = createImageRestoreClient({ namespace: 'st-user:alice', timeoutMs: 100, fetchImpl: async (url, options) => {
      requests++; if (url.endsWith('/capabilities')) return json(capability()); signal = options.signal;
      if (mode === 'timeout') return new Promise(() => {});
      return new Response(' '.repeat(mode === 'stream' ? 17000 : 2), { headers: { 'content-type': 'application/json', ...(mode === 'size' ? { 'content-length': '17000' } : {}) } });
    } });
    await assert.rejects(client.restore(receipt, PNG, { confirmed: true }), { imageWriteState: 'unconfirmed' });
    assert.equal(requests, 2); assert.equal(signal.aborted, true);
  }
});
