import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { createSourceIdentityService } from '../qianmu-source-identity-service.js';
import { createSourceIdentityClient } from '../qianmu-source-identity-client.js';
import { SOURCE_IDENTITY_SCHEMA, sourceIdentityRecord, sourceIdentityRequest, sourceIdentityResponse, sourceIdentityErrorPayload } from '../qianmu-source-identity-contract.js';
import { imageServiceAccount } from '../qianmu-image-service-access.js';
import { init, exit } from '../server-plugin.js';
import { prepareStoryboardBundleSource } from '../qianmu-storyboard-bundle-source.js';

const marker = '.qianmu-source-identity.json';
const account = handle => imageServiceAccount({ user: { profile: { handle, enabled: true } } }).namespace;
const input = (handle = 'alice') => ({ version: 1, expectedAccount: account(handle), confirmed: true });
const row = (kind = 'instance') => ({ schema: SOURCE_IDENTITY_SCHEMA, kind, id: randomUUID() });
const response = () => ({ ok: true, version: 1, expectedAccount: account('alice'), state: 'ready', instanceId: randomUUID(), accountId: randomUUID(), proof: 'installation-labels', automaticRebinding: false });
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
const gate = () => { let release; const promise = new Promise(resolve => { release = resolve; }); return { promise, release }; };
async function fixture(t, options = {}) {
  const parent = await fs.realpath(os.tmpdir()), root = await fs.mkdtemp(path.join(parent, 'qianmu-identity-test-'));
  const userRoot = path.join(root, 'alice'); await fs.mkdir(userRoot);
  const request = { user: { profile: { handle: 'alice', enabled: true }, directories: { root: userRoot } } };
  const service = createSourceIdentityService({ dataRoot: root, ...options });
  t.after(async () => { await service.close(); const real = await fs.realpath(root);
    assert.equal(path.dirname(real), parent); assert.match(path.basename(real), /^qianmu-identity-test-/); await fs.rm(real, { recursive: true }); });
  return { parent, root, userRoot, request, service, instanceFile: path.join(root, marker), accountFile: path.join(userRoot, marker) };
}
const missing = async filename => assert.rejects(fs.lstat(filename), { code: 'ENOENT' });

test('identity contract accepts only versioned opaque labels; never paths, credentials or automatic rebinding', () => {
  assert.deepEqual(sourceIdentityRequest(input()), input());
  for (const extra of [{ confirmed: false }, { version: 2 }, { expectedAccount: 'st-user:alice' }, { id: randomUUID() }, { root: '/arbitrary' }, { apiKey: 'secret' }]) assert.throws(() => sourceIdentityRequest({ ...input(), ...extra }));
  const original = row(); assert.deepEqual(sourceIdentityRecord(original, 'instance'), original);
  for (const extra of [{ kind: 'account' }, { schema: 'future' }, { id: '123' }, { id: original.id.toUpperCase() }, { namespace: 'alice' }]) assert.throws(() => sourceIdentityRecord({ ...original, ...extra }, 'instance'));
  const value = response(); assert.deepEqual(sourceIdentityResponse(value), value);
  for (const extra of [{ proof: 'verified' }, { automaticRebinding: true }, { state: 'uninitialized' }, { root: '/data' }, { version: 2 }]) assert.throws(() => sourceIdentityResponse({ ...value, ...extra }));
  assert.equal(sourceIdentityResponse({ ...value, state: 'uninitialized', accountId: null }).state, 'uninitialized');
  const error = sourceIdentityErrorPayload(Object.assign(new Error('C:/secret/private-key'), { identityWriteState: 'unconfirmed' }));
  assert.equal(error.body.identityWriteState, 'unconfirmed'); assert.doesNotMatch(JSON.stringify(error), /secret|private-key/);
});

test('inspection is read-only and host-authenticated; supplied body cannot choose the identity or root', async t => {
  const f = await fixture(t);
  await assert.rejects(f.service.inspect({}), { status: 401 });
  assert.deepEqual(await f.service.inspect(f.request), { ...response(), instanceId: null, accountId: null, state: 'uninitialized' });
  await missing(f.instanceFile); await missing(f.accountFile);
  await assert.rejects(f.service.initialize(f.request, { ...input(), expectedAccount: account('bob') }), { status: 401 });
  await assert.rejects(f.service.initialize(f.request, { ...input(), root: f.parent }), { status: 400 });
  await assert.rejects(f.service.initialize(f.request, { ...input(), confirmed: false }), { status: 400 });
  await missing(f.instanceFile); await missing(f.accountFile);
  f.request.user.profile.enabled = false; await assert.rejects(f.service.inspect(f.request), { status: 401 });
});

test('explicit initialization is persistent and idempotent across service restarts without changing existing bytes or timestamps', async t => {
  const f = await fixture(t), first = await f.service.initialize(f.request, input());
  assert.equal(first.state, 'ready'); assert.notEqual(first.instanceId, first.accountId);
  const files = [f.instanceFile, f.accountFile], before = await Promise.all(files.map(async name => ({ data: await fs.readFile(name), stat: await fs.stat(name, { bigint: true }) })));
  await f.service.close(); const second = createSourceIdentityService({ dataRoot: f.root }); t.after(() => second.close());
  assert.deepEqual(await second.inspect(f.request), first); assert.deepEqual(await second.initialize(f.request, input()), first);
  for (const [index, name] of files.entries()) { assert.deepEqual(await fs.readFile(name), before[index].data); const stat = await fs.stat(name, { bigint: true });
    assert.equal(stat.ino, before[index].stat.ino); assert.equal(stat.mtimeNs, before[index].stat.mtimeNs); assert.equal(stat.nlink, 1n); }
  assert.doesNotMatch(JSON.stringify(first), /qianmu-identity-test|\/alice|\\alice|st-user:alice/);
});

test('accounts share the instance label but have different account labels; same handles on separate installations differ', async t => {
  const f = await fixture(t), g = await fixture(t), a = await f.service.initialize(f.request, input()), other = await g.service.initialize(g.request, input());
  assert.equal(a.expectedAccount, other.expectedAccount); assert.notEqual(a.instanceId, other.instanceId); assert.notEqual(a.accountId, other.accountId);
  const bob = structuredClone(f.request); bob.user.profile.handle = 'bob'; bob.user.directories.root = path.join(f.root, 'bob'); await fs.mkdir(bob.user.directories.root);
  const b = await f.service.initialize(bob, input('bob')); assert.equal(b.instanceId, a.instanceId); assert.notEqual(b.accountId, a.accountId);
  assert.deepEqual(await f.service.inspect(f.request), a);
});

test('a copied account retains its label without pretending to be the same installation; full clones are labels, not authenticity', async t => {
  const f = await fixture(t), g = await fixture(t), a = await f.service.initialize(f.request, input());
  await fs.copyFile(f.accountFile, g.accountFile); const pending = await g.service.inspect(g.request);
  assert.equal(pending.state, 'uninitialized'); assert.equal(pending.accountId, a.accountId); assert.equal(pending.instanceId, null);
  const b = await g.service.initialize(g.request, input()); assert.equal(b.accountId, a.accountId); assert.notEqual(b.instanceId, a.instanceId);
  assert.equal(b.proof, 'installation-labels'); assert.equal(b.automaticRebinding, false);
});

test('corrupt, oversize, future and wrong-kind existing markers are preserved; the other missing marker is not created', async t => {
  for (const value of ['', '{broken', 'x'.repeat(1025), JSON.stringify({ ...row('account'), schema: 'future' }), JSON.stringify(row('instance'))]) {
    const f = await fixture(t); await fs.writeFile(f.accountFile, value, { flag: 'wx' });
    await assert.rejects(f.service.inspect(f.request)); await assert.rejects(f.service.initialize(f.request, input()));
    assert.equal(await fs.readFile(f.accountFile, 'utf8'), value); await missing(f.instanceFile);
  }
});

test('outside/equal roots, junction ancestors and hard-linked marker files are refused without writes', async t => {
  const f = await fixture(t), request = structuredClone(f.request);
  for (const root of [f.root, f.parent, f.root + '-other']) { request.user.directories.root = root; await assert.rejects(f.service.initialize(request, input()), { code: 'source_identity_path' }); }
  const target = path.join(f.root, 'original-account'), alias = path.join(f.root, 'alias'); await fs.mkdir(target); await fs.symlink(target, alias, process.platform === 'win32' ? 'junction' : 'dir');
  request.user.directories.root = alias; await assert.rejects(f.service.initialize(request, input()), { code: 'source_identity_path' });
  const original = path.join(target, 'original.json'); await fs.writeFile(original, JSON.stringify(row('account'))); await fs.link(original, f.accountFile);
  await assert.rejects(f.service.initialize(f.request, input()), { code: 'source_identity_path' }); assert.equal((await fs.stat(original)).nlink, 2); await missing(f.instanceFile);
});

test('a marker replaced between lstat and open is detected using full file identity', async t => {
  let replace = false;
  const f = await fixture(t, { io: { ...fs, async open(filename, flags, mode) {
    if (replace && filename.endsWith(marker) && typeof flags === 'number') { replace = false; await fs.rename(filename, filename + '.old'); await fs.writeFile(filename, JSON.stringify(row('instance')) + '\n'); }
    return fs.open(filename, flags, mode);
  } } });
  await f.service.initialize(f.request, input()); replace = true;
  await assert.rejects(f.service.inspect(f.request), { code: 'source_identity_changed' });
  assert.ok(await fs.readFile(f.instanceFile + '.old')); assert.ok(await fs.readFile(f.instanceFile));
});

test('concurrent initialize/inspect do not observe partial labels and service close prevents a late write', async t => {
  const began = gate(), finish = gate(); let blocked = true;
  const f = await fixture(t, { io: { ...fs, async realpath(filename) { if (blocked) { blocked = false; began.release(); await finish.promise; } return fs.realpath(filename); } } });
  const writing = f.service.initialize(f.request, input()); await began.promise;
  await assert.rejects(f.service.initialize(f.request, input()), { code: 'source_identity_busy' });
  await assert.rejects(f.service.inspect(f.request), { code: 'source_identity_busy' });
  const closing = f.service.close(); finish.release();
  await assert.rejects(writing, { code: 'source_identity_changed', identityWriteState: 'not_started' }); await closing;
  await missing(f.instanceFile); await missing(f.accountFile);
});

test('read-only requests have bounded concurrency and account changes are caught even while a missing file is being read', async t => {
  const began = gate(), finish = gate(); let calls = 0;
  const f = await fixture(t, { io: { ...fs, async realpath(filename) { if (++calls <= 8) { if (calls === 8) began.release(); await finish.promise; } return fs.realpath(filename); } } });
  const reads = Array.from({ length: 8 }, () => f.service.inspect(f.request)); await began.promise;
  await assert.rejects(f.service.inspect(f.request), { code: 'source_identity_busy', status: 429 });
  f.request.user.profile.handle = 'bob'; finish.release();
  assert.ok((await Promise.allSettled(reads)).every(result => result.status === 'rejected' && result.reason.code === 'source_identity_changed'));
  await missing(f.instanceFile); await missing(f.accountFile);
});

test('partial write failures retain the marker and report uncertainty instead of auto-rotating or erasing it', async t => {
  const f = await fixture(t, { io: { ...fs, async open(filename, flags, mode) {
    const handle = await fs.open(filename, flags, mode); if (flags === 'wx') handle.writeFile = async () => { await handle.write(Buffer.from('{')); throw new Error('synthetic write failure'); }; return handle;
  } } });
  const error = await f.service.initialize(f.request, input()).catch(error => error);
  assert.equal(error.identityWriteState, 'unconfirmed'); assert.equal(sourceIdentityErrorPayload(error).body.identityWriteState, 'unconfirmed');
  assert.equal(await fs.readFile(f.instanceFile, 'utf8'), '{'); await missing(f.accountFile);
  await assert.rejects(f.service.initialize(f.request, input()), /损坏/); assert.equal(await fs.readFile(f.instanceFile, 'utf8'), '{');
});

test('abort after a complete first marker leaves its identity intact; explicit retry creates only the missing account', async t => {
  const controller = new AbortController(); let once = true;
  const f = await fixture(t, { io: { ...fs, async open(filename, flags, mode) { const handle = await fs.open(filename, flags, mode);
    if (flags === 'wx' && once) { once = false; const sync = handle.sync.bind(handle); handle.sync = async () => { await sync(); controller.abort(); }; } return handle;
  } } });
  await assert.rejects(f.service.initialize(f.request, input(), { signal: controller.signal }), { identityWriteState: 'unconfirmed' });
  const raw = await fs.readFile(f.instanceFile, 'utf8'), instance = JSON.parse(raw); await missing(f.accountFile);
  const inspected = await f.service.inspect(f.request); assert.equal(inspected.instanceId, instance.id); assert.equal(inspected.state, 'uninitialized');
  const initialized = await f.service.initialize(f.request, input()); assert.equal(initialized.instanceId, instance.id); assert.equal(initialized.state, 'ready');
  assert.equal(await fs.readFile(f.instanceFile, 'utf8'), raw);
});

test('client requires consent and sends only a hashed account echo plus CSRF over the fixed same-origin endpoint', async () => {
  const calls = [], value = response(), client = createSourceIdentityClient({ namespace: 'st-user:alice', headers: () => ({ 'x-csrf-token': 'csrf', Authorization: 'Bearer secret', 'x-api-key': 'private' }),
    fetchImpl: async (url, options) => { calls.push({ url, options }); return json(value); } });
  await assert.rejects(client.initialize(), { identityWriteState: 'not_started' }); assert.equal(calls.length, 0);
  assert.deepEqual(await client.inspect(), value); assert.deepEqual(await client.initialize({ confirmed: true }), value);
  const [read, write] = calls; assert.equal(read.url, '/api/plugins/qianmu-tts/source-identity'); assert.equal(read.options.method, 'GET'); assert.equal(read.options.body, undefined);
  assert.equal(write.url, '/api/plugins/qianmu-tts/source-identity/initialize'); assert.deepEqual(JSON.parse(write.options.body), input());
  assert.equal(write.options.redirect, 'error'); assert.equal(write.options.credentials, 'same-origin'); assert.equal(write.options.cache, 'no-store'); assert.equal(write.options.headers['X-CSRF-Token'], 'csrf');
  assert.doesNotMatch(JSON.stringify(calls), /Bearer|private|st-user:alice/);
});

test('client never acknowledges wrong-account, future, overclaimed or malformed identity responses', async () => {
  for (const extra of [{ expectedAccount: account('bob') }, { version: 2 }, { proof: 'verified' }, { automaticRebinding: true }, { accountId: 'bad' }, { root: '/private' }, { instanceId: null, state: 'uninitialized' }]) {
    let calls = 0; const client = createSourceIdentityClient({ namespace: 'st-user:alice', fetchImpl: async () => { calls++; return json({ ...response(), ...extra }); } });
    await assert.rejects(client.initialize({ confirmed: true }), { identityWriteState: 'unconfirmed' }); assert.equal(calls, 1);
  }
});

test('client rejects old backends and oversized streamed replies without fallback, credentials or automatic retry', async () => {
  for (const makeResponse of [() => new Response('not found', { status: 404 }), () => json({ ...response(), extra: 'x'.repeat(2048) }),
    () => new Response(new Uint8Array([0xff]), { headers: { 'content-type': 'application/json' } })]) {
    let calls = 0; const client = createSourceIdentityClient({ namespace: 'st-user:alice', fetchImpl: async () => { calls++; return makeResponse(); } });
    await assert.rejects(client.inspect(), { identityWriteState: 'not_started' }); assert.equal(calls, 1);
  }
});

test('client timeout, cancellation and late account changes cannot acknowledge initialization or send after a cancelled guard', async () => {
  const began = gate(); let calls = 0;
  const client = createSourceIdentityClient({ namespace: 'st-user:alice', timeoutMs: 100, fetchImpl: () => { calls++; began.release(); return new Promise(() => {}); } });
  const waiting = client.initialize({ confirmed: true }); await began.promise;
  await assert.rejects(waiting, { identityWriteState: 'unconfirmed' }); assert.equal(calls, 1);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(client.initialize({ confirmed: true, signal: controller.signal }), { identityWriteState: 'not_started' }); assert.equal(calls, 1);
  let guards = 0; const changed = createSourceIdentityClient({ namespace: 'st-user:alice', guard: async () => { if (++guards === 3) throw new Error('changed account'); }, fetchImpl: async () => json(response()) });
  await assert.rejects(changed.initialize({ confirmed: true }), { identityWriteState: 'unconfirmed' });
  const release = gate(), guarded = createSourceIdentityClient({ namespace: 'st-user:alice', timeoutMs: 100, guard: () => release.promise, fetchImpl: () => { calls++; return json(response()); } });
  await assert.rejects(guarded.initialize({ confirmed: true }), { identityWriteState: 'not_started' }); release.release();
  await new Promise(resolve => setImmediate(resolve)); assert.equal(calls, 1);
});

test('client timeout cancels a stalled response reader and does not leave its stream locked', async () => {
  let cancelled = 0; const stream = new ReadableStream({ pull() {}, cancel() { cancelled++; } });
  const client = createSourceIdentityClient({ namespace: 'st-user:alice', timeoutMs: 100, fetchImpl: async () => new Response(stream, { headers: { 'content-type': 'application/json' } }) });
  await assert.rejects(client.initialize({ confirmed: true }), { identityWriteState: 'unconfirmed' });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(cancelled, 1); assert.equal(stream.locked, false);
});

test('production HTTP routes and browser client distinguish installations without using generation, native upload or request-selected roots', async t => {
  const f = await fixture(t), routes = new Map(), seen = [];
  await init({ get: (name, handler) => routes.set(`GET ${name}`, handler), post: (name, handler) => routes.set(`POST ${name}`, handler) }, { dataRoot: f.root });
  const server = http.createServer(async (req, res) => {
    // Test-only host authentication; real routes only use ST's authenticated req.user.
    if (req.headers['x-test-login'] === 'alice') req.user = structuredClone(f.request.user);
    const chunks = []; for await (const chunk of req) chunks.push(chunk); req.body = chunks.length ? JSON.parse(Buffer.concat(chunks)) : {};
    res.set = (key, value) => { res.setHeader(key, value); return res; }; res.status = code => { res.statusCode = code; return res; };
    res.json = value => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(value)); return res; };
    seen.push(`${req.method} ${req.url}`); const handler = routes.get(`${req.method} ${req.url}`);
    if (!handler) { res.statusCode = 404; res.end(); return; } await handler(req, res);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await exit(); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(`${origin}/source-identity`)).status, 401);
  const client = createSourceIdentityClient({ namespace: 'st-user:alice', fetchImpl: async (url, options) => {
    const reply = await fetch(origin + url.replace('/api/plugins/qianmu-tts', ''), { ...options, headers: { ...options.headers, 'x-test-login': 'alice' } });
    assert.equal(reply.headers.get('cache-control'), 'no-store'); assert.equal(reply.headers.get('x-content-type-options'), 'nosniff'); return reply;
  } });
  assert.equal((await client.inspect()).state, 'uninitialized'); await missing(f.instanceFile); await missing(f.accountFile);
  const initialized = await client.initialize({ confirmed: true }); assert.equal(initialized.state, 'ready'); assert.deepEqual(await client.inspect(), initialized);
  const forged = await fetch(`${origin}/source-identity/initialize`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-test-login': 'alice' }, body: JSON.stringify({ ...input(), id: randomUUID(), user: { directories: { root: f.parent } } }) });
  assert.equal(forged.status, 400); assert.doesNotMatch(await forged.text(), /qianmu-identity-test|private|\\Users/);
  assert.ok(seen.every(route => /^(?:GET \/source-identity|POST \/source-identity\/initialize)$/.test(route)));
  assert.deepEqual(await fs.readdir(f.root), [marker, 'alice']); assert.deepEqual(await fs.readdir(f.userRoot), [marker]);
});

test('bundle export asks before initialization, verifies after capture, and never auto-initializes at read time', async () => {
  const value = response(), calls = [], confirmations = [];
  const prepared = await prepareStoryboardBundleSource({ namespace: 'st-user:alice', guard: async () => {}, confirm: async title => { confirmations.push(title); return true; },
    fetchImpl: async (url, options) => { calls.push(options.method); return json(calls.length === 1 ? { ...value, state: 'uninitialized', instanceId: null, accountId: null } : value); } });
  assert.deepEqual(calls, ['GET', 'POST']); assert.deepEqual(confirmations, ['初始化备份来源标识']); assert.deepEqual(prepared.source, value);
  await prepared.verify(); assert.deepEqual(calls, ['GET', 'POST', 'GET']); assert.equal(Object.isFrozen(prepared.source), true);
  let changed = false; const ready = await prepareStoryboardBundleSource({ namespace: 'st-user:alice', guard: async () => {}, confirm: async () => assert.fail('ready sources need no initialization prompt'),
    fetchImpl: async () => json(changed ? { ...value, instanceId: randomUUID() } : value) });
  changed = true; await assert.rejects(ready.verify(), /已变化/);
});

test('bundle export legacy fallback requires an explicit warning confirmation; failed initialization cannot silently downgrade', async () => {
  let calls = 0, prompts = 0;
  const options = { namespace: 'st-user:alice', guard: async () => {}, fetchImpl: async () => { calls++; return new Response('old backend', { status: 404 }); }, confirm: async (_title, text) => { prompts++; assert.match(text, /旧格式/); return true; } };
  const old = await prepareStoryboardBundleSource(options); assert.equal(old.source, null); await old.verify(); assert.equal(calls, 1); assert.equal(prompts, 1);
  await assert.rejects(prepareStoryboardBundleSource({ ...options, confirm: async () => false }), /取消/);
  let writes = 0; const value = response();
  await assert.rejects(prepareStoryboardBundleSource({ ...options, confirm: async () => true, fetchImpl: async (_url, options) => {
    if (options.method === 'POST') { writes++; throw Error('disconnected'); } return json({ ...value, instanceId: null, accountId: null, state: 'uninitialized' });
  } }), { identityWriteState: 'unconfirmed' }); assert.equal(writes, 1);
  await assert.rejects(prepareStoryboardBundleSource({ ...options, guard: async () => { throw Error('changed account'); }, confirm: async () => assert.fail('changed accounts must not offer fallback') }), /changed account/);
});
