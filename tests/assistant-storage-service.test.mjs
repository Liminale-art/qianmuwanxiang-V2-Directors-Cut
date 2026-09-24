import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { createAssistantStorageService, installAssistantStorageRoutes } from '../qianmu-assistant-storage-service.js';
import { assistantStorageRequest, assistantStorageResponse, assistantStorageErrorPayload } from '../qianmu-assistant-storage-contract.js';
import { createNativeProseAssistantHistoryStore } from '../qianmu-prose-assistant-native.js';
import { emptyProseAssistantHistory } from '../qianmu-prose-assistant-history-contract.js';
import { streamCheckpointTransport } from './helpers/stream-checkpoint-fixture.mjs';
const sha = value => createHash('sha256').update(value).digest('hex');
const namespace = 'st-user:alice', expectedAccount = 'st-user:' + sha('alice');
async function fixture(t, options = {}) {
    const parent = await fs.realpath(os.tmpdir()), root = await fs.mkdtemp(path.join(parent, 'qianmu-assistant-storage-'));
    assert.ok(root.startsWith(parent + path.sep + 'qianmu-assistant-storage-'));
    const user = path.join(root, 'alice'), folder = path.join(user, 'files'); await fs.mkdir(folder, { recursive: true });
    const req = { user: { profile: { handle: 'alice', enabled: true }, directories: { root: user, files: folder } } }, opened = [];
    const io = { ...fs, open: async (file, ...args) => { opened.push(path.basename(file)); return fs.open(file, ...args); }, ...options.io };
    const service = createAssistantStorageService({ dataRoot: root, ...options, io });
    t.after(async () => { await service.close(); const resolved = path.resolve(root); assert.ok(resolved.startsWith(parent + path.sep + 'qianmu-assistant-storage-')); await fs.rm(resolved, { recursive: true, force: true }); });
    const transport = streamCheckpointTransport(namespace), input = (patch = {}) => ({ version: 1, expectedAccount, ...patch });
    async function add(id = 'A', revisions = 2) {
        const key = JSON.stringify(['qianmu-prose-assistant-v2', expectedAccount, 'char:A.png', { kind: 'character', chatId: id, avatar: 'A.png' }, null]);
        const store = await createNativeProseAssistantHistoryStore({ source: { key, scope: { namespace: expectedAccount }, guard: async () => true, assertCurrent: () => true }, isCurrent: () => true,
            storageFactory: transport.createStorage, now: () => 100, legacyFactory: () => ({ read: async () => emptyProseAssistantHistory(key), close() {} }) });
        for (let i = 0; i < revisions; i++) await store.write(expectedAccount, key, i, [{ id: 1, user: 'PRIVATE_QUESTION', assistant: 'PRIVATE_REPLY_' + i, status: 'complete', reference: null }]);
        store.close();
        for (const [name, text] of transport.files) await fs.writeFile(path.join(folder, name), text);
        return { key, head: `qianmu-v2-${sha('qianmu.st-account-document.v1\0' + namespace)}-assistant-${sha(key)}.json` };
    }
    const snapshot = async () => Object.fromEntries(await Promise.all((await fs.readdir(folder)).sort().map(async name => [name, sha(await fs.readFile(path.join(folder, name)))])));
    return { root, user, folder, req, service, io, opened, input, transport, add, snapshot };
}

test('actual native assistant writer files are observed without reading conversation bodies or changing any file', async t => {
    const f = await fixture(t); await f.add('A', 3); await f.add('B', 1);
    const before = await f.snapshot(), result = await f.service.inspect(f.req, f.input());
    assert.equal(result.heads.count, 2); assert.equal(result.current.count, 2); assert.equal(result.retained.count, 2); assert.equal(result.total.count, 6);
    assert.equal(result.total.bytes, [...f.transport.files.values()].reduce((sum, text) => sum + Buffer.byteLength(text), 0));
    assert.equal(result.contentVerified, false); assert.equal(result.observation, 'file-sizes-not-disk-allocation');
    assert.equal(f.opened.length, 2); assert.ok(f.opened.every(name => /-assistant-[a-f0-9]{64}\.json$/.test(name)));
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE|A\.png|chatId|alice|qianmu-v2/); assert.deepEqual(await f.snapshot(), before);
});
test('empty existing directory is zero; missing directory is unknown and is never created', async t => {
    const f = await fixture(t); assert.equal((await f.service.inspect(f.req, f.input())).total.count, 0);
    await fs.rmdir(f.folder); await assert.rejects(f.service.inspect(f.req, f.input()), { code: 'assistant_storage_missing' });
    await assert.rejects(fs.stat(f.folder), { code: 'ENOENT' });
});
test('orphan bodies are retained bytes, not invented conversations or a cleanup recommendation', async t => {
    const f = await fixture(t), { head } = await f.add('A', 1); await fs.unlink(path.join(f.folder, head));
    const result = await f.service.inspect(f.req, f.input()); assert.equal(result.heads.count, 0); assert.equal(result.current.count, 0); assert.equal(result.retained.count, 1);
    assert.equal('canDelete' in result, false); assert.equal(f.opened.length, 0);
});
test('unrelated modules and other-account prefixes are not opened or counted', async t => {
    const f = await fixture(t); await f.add('A', 1);
    for (const name of ['notes.json', `qianmu-v2-${'a'.repeat(64)}-assistant-${'b'.repeat(64)}.json`, 'private-key.txt']) await fs.writeFile(path.join(f.folder, name), 'PRIVATE');
    const result = await f.service.inspect(f.req, f.input()); assert.equal(result.total.count, 2); assert.equal(f.opened.length, 1);
});
test('body metadata observation does not read or claim validation of retained or current content', async t => {
    const f = await fixture(t); await f.add('A', 1);
    const body = [...f.transport.files.keys()].find(name => /-assistant-[a-f0-9]{64}-/.test(name)); await fs.writeFile(path.join(f.folder, body), 'not JSON PRIVATE');
    const result = await f.service.inspect(f.req, f.input()); assert.equal(result.current.bytes, 16); assert.equal(result.contentVerified, false); assert.equal(f.opened.length, 1);
});
test('forged account, namespace, filename and root are rejected even for an admin', async t => {
    const f = await fixture(t); f.req.user.profile.admin = true;
    for (const patch of [{ expectedAccount: 'st-user:' + 'b'.repeat(64) }, { path: f.folder }, { namespace }, { filename: 'private-key.txt' }, { root: '/' }]) await assert.rejects(f.service.inspect(f.req, f.input(patch)));
    f.req.user.profile.enabled = false; await assert.rejects(f.service.inspect(f.req, f.input()), { code: 'assistant_storage_account' }); assert.equal(f.opened.length, 0);
});
test('malformed head and missing current body fail closed, never reporting an empty or partial library', async t => {
    const f = await fixture(t), { head } = await f.add('A', 1), original = await fs.readFile(path.join(f.folder, head));
    await fs.writeFile(path.join(f.folder, head), '{}'); await assert.rejects(f.service.inspect(f.req, f.input()), { code: 'assistant_storage_content' });
    await fs.writeFile(path.join(f.folder, head), original); const pointer = JSON.parse(original); await fs.unlink(path.join(f.folder, head.slice(0, -5) + '-' + pointer.fingerprint + '.json'));
    await assert.rejects(f.service.inspect(f.req, f.input()), { code: 'assistant_storage_missing' });
});
test('hard-linked matching bodies are rejected before content is opened', async t => {
    const f = await fixture(t); await f.add('A', 1); const body = [...f.transport.files.keys()].find(name => /-assistant-[a-f0-9]{64}-/.test(name));
    await fs.link(path.join(f.folder, body), path.join(f.folder, 'unrelated-link')); await assert.rejects(f.service.inspect(f.req, f.input()), { code: 'assistant_storage_path' }); assert.equal(f.opened.length, 0);
});
test('linked account directories cannot redirect observation outside the authenticated path', async t => {
    const f = await fixture(t), target = path.join(f.root, 'elsewhere'), link = path.join(f.user, 'linked-files'); await fs.mkdir(target); await fs.symlink(target, link, 'junction');
    f.req.user.directories.files = link; await assert.rejects(f.service.inspect(f.req, f.input()), { code: 'assistant_storage_path' });
});
test('account changes during IO abort without disclosing statistics', async t => {
    let f; f = await fixture(t, { io: { open: async (...args) => { f.req.user.profile.handle = 'bob'; return fs.open(...args); } } }); await f.add();
    await assert.rejects(f.service.inspect(f.req, f.input()), { code: 'assistant_storage_changed' });
});
test('in-place body change during head inspection invalidates the entire observation', async t => {
    let f, changed = false; f = await fixture(t, { io: { open: async (...args) => {
        if (!changed) { changed = true; const body = [...f.transport.files.keys()].find(name => /-assistant-[a-f0-9]{64}-/.test(name)); await fs.appendFile(path.join(f.folder, body), 'changed'); }
        return fs.open(...args);
    } } }); await f.add(); await assert.rejects(f.service.inspect(f.req, f.input()), { code: 'assistant_storage_changed' });
});
test('new files during observation cause invalidation rather than an incomplete total', async t => {
    let f, changed = false; f = await fixture(t, { io: { open: async (...args) => {
        if (!changed) { changed = true; const body = [...f.transport.files.keys()].find(name => /-assistant-[a-f0-9]{64}-/.test(name)); await fs.writeFile(path.join(f.folder, body.replace(/-[a-f0-9]{64}\.json$/, '-' + 'f'.repeat(64) + '.json')), 'retained'); }
        return fs.open(...args);
    } } }); await f.add(); await assert.rejects(f.service.inspect(f.req, f.input()), { code: 'assistant_storage_changed' });
});
test('pre-cancelled and closed service observations cannot read or modify files', async t => {
    const f = await fixture(t), controller = new AbortController(); controller.abort();
    await assert.rejects(f.service.inspect(f.req, f.input(), { signal: controller.signal }), { code: 'assistant_storage_changed' });
    await f.service.close(); await assert.rejects(f.service.inspect(f.req, f.input()), { code: 'assistant_storage_busy' }); assert.equal(f.opened.length, 0);
});
test('request/response whitelist validates arithmetic and strips no failures into zero', () => {
    const empty = { ok: true, version: 1, expectedAccount, scope: 'st-account-assistant-files', observation: 'file-sizes-not-disk-allocation', contentVerified: false,
        heads: { count: 0, bytes: 0 }, current: { count: 0, bytes: 0 }, retained: { count: 0, bytes: 0 }, total: { count: 0, bytes: 0 } };
    assert.equal(assistantStorageResponse(empty, expectedAccount).total.bytes, 0);
    for (const patch of [{ path: '/private' }, { contentVerified: true }, { total: { count: 1, bytes: 20 } }, { heads: { count: -1, bytes: 0 } }]) assert.throws(() => assistantStorageResponse({ ...empty, ...patch }, expectedAccount));
    const getter = {}; Object.defineProperty(getter, 'expectedAccount', { enumerable: true, get() { throw Error('PRIVATE'); } });
    assert.throws(() => assistantStorageRequest({ ...empty, expectedAccount: '' })); assert.throws(() => assistantStorageRequest(getter), { code: 'assistant_storage_contract' });
    assert.doesNotMatch(JSON.stringify(assistantStorageErrorPayload(Error('PRIVATE path'))), /PRIVATE/);
});
test('actual installed route uses host root, no-store and authenticated identity and has no mutation route', async t => {
    const f = await fixture(t); await f.add('A', 1); const routes = new Map(), services = [];
    installAssistantStorageRoutes({ post: (route, fn) => routes.set(route, fn) }, { dataRoot: () => f.root, register: service => services.push(service) });
    t.after(async () => { for (const service of services) await service.close(); }); assert.deepEqual([...routes.keys()], ['/assistant/storage']);
    const response = () => Object.assign(new EventEmitter(), { headers: {}, code: 200, writableEnded: false, set(k, v) { this.headers[k] = v; }, status(code) { this.code = code; return this; }, json(body) { this.body = body; this.writableEnded = true; return this; } });
    const req = Object.assign(new EventEmitter(), f.req, { body: f.input() }), res = response(); await routes.get('/assistant/storage')(req, res);
    assert.equal(res.body.total.count, 2); assert.equal(res.headers['Cache-Control'], 'no-store'); assert.equal(res.headers['X-Content-Type-Options'], 'nosniff'); assert.equal(req.listenerCount('aborted'), 0); assert.equal(res.listenerCount('close'), 0);
    const denied = response(); await routes.get('/assistant/storage')(Object.assign(new EventEmitter(), { body: f.input({ path: f.root }) }), denied); assert.equal(denied.code, 401);
});

test('expired slow IO keeps its concurrency slot until work actually settles', async t => {
    const waiters = []; let blocked = true, closed = 0;
    const directory = () => ({ async *[Symbol.asyncIterator]() {}, async close() { closed++; } });
    const f = await fixture(t, { timeoutMs: 100, io: { opendir: async () => blocked ? new Promise(resolve => waiters.push(resolve)) : directory() } });
    const first = f.service.inspect(f.req, f.input()), second = f.service.inspect(f.req, f.input());
    const settled = await Promise.allSettled([first, second]); assert.equal(settled.every(row => row.status === 'rejected' && row.reason.code === 'assistant_storage_changed'), true);
    assert.equal(waiters.length, 2); await assert.rejects(f.service.inspect(f.req, f.input()), { code: 'assistant_storage_busy' });
    for (const resolve of waiters) resolve(directory());
    while (closed < 2) await new Promise(resolve => setImmediate(resolve)); await new Promise(resolve => setImmediate(resolve));
    blocked = false; assert.equal((await f.service.inspect(f.req, f.input())).total.bytes, 0);
});
test('matching-file capacity fails without returning the first subset as a complete total', async t => {
    let sample, folder;
    const f = await fixture(t, { io: {
        opendir: async () => ({ async *[Symbol.asyncIterator]() {
            for (let i = 0; i <= 20000; i++) yield { name: `qianmu-v2-${sha('qianmu.st-account-document.v1\0' + namespace)}-assistant-${String(i).padStart(64, '0')}-${'a'.repeat(64)}.json`, isFile: () => true, isSymbolicLink: () => false };
        }, async close() {} }),
        lstat: async (file, options) => folder && path.dirname(file) === folder ? sample : fs.lstat(file, options),
    } });
    const samplePath = path.join(f.root, 'sample'); await fs.writeFile(samplePath, 'fixture'); sample = await fs.lstat(samplePath, { bigint: true }); folder = f.folder;
    await assert.rejects(f.service.inspect(f.req, f.input()), { code: 'assistant_storage_capacity' }); assert.equal(f.opened.length, 0);
});
test('unknown exception codes cannot expose private data through error payloads', () => {
    const payload = assistantStorageErrorPayload({ code: 'assistant_storage_PRIVATE_FILE', status: 400, message: 'PRIVATE' });
    assert.equal(payload.body.code, 'assistant_storage_unavailable'); assert.doesNotMatch(JSON.stringify(payload), /PRIVATE/);
});
