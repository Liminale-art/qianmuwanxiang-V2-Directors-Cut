import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { collectAssistantNativeStorage as collect } from '../qianmu-assistant-storage-client.js';
import { collectProseAssistantStorage } from '../qianmu-prose-assistant-storage.js';
import { renderStorageBackupSection, collectionCleanupOptions } from '../qianmu-storage-backup-view.js';
const namespace = 'st-user:alice', account = 'st-user:' + createHash('sha256').update('alice').digest('hex');
const value = () => ({ ok: true, version: 1, expectedAccount: account, scope: 'st-account-assistant-files', observation: 'file-sizes-not-disk-allocation', contentVerified: false,
    heads: { count: 2, bytes: 400 }, current: { count: 2, bytes: 1200 }, retained: { count: 3, bytes: 2000 }, total: { count: 7, bytes: 3600 } });
const local = () => ({ namespace: account, status: 'ready', scope: 'current-account-local', estimated: true, bytes: 100, count: 2, records: 2, chats: 1, markers: 1, complete: 1, failed: 0, cancelled: 1 });
const response = (data = value(), status = 200, headers = {}) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', ...headers } });
const options = (patch = {}) => ({ resolveNamespace: async () => namespace, isCurrent: () => true, headers: () => ({ 'X-CSRF-Token': 'fixture', Authorization: 'PRIVATE', 'X-API-Key': 'PRIVATE' }), fetchImpl: async () => response(), ...patch });

test('native observation uses only the fixed same-origin route, hashed account and CSRF header', async () => {
    let request;
    const result = await collect(options({ fetchImpl: async (url, init) => { request = { url, init }; return response(); } }));
    assert.equal(request.url, '/api/plugins/qianmu-tts/assistant/storage'); assert.equal(request.init.credentials, 'same-origin'); assert.equal(request.init.redirect, 'error'); assert.equal(request.init.cache, 'no-store');
    assert.deepEqual(JSON.parse(request.init.body), { version: 1, expectedAccount: account }); assert.doesNotMatch(JSON.stringify(request.init), /PRIVATE|alice/);
    assert.deepEqual(Object.keys(request.init.headers).sort(), ['Accept', 'Content-Type', 'X-CSRF-Token']); assert.equal(result.status, 'ready'); assert.equal(result.namespace, namespace); assert.equal(result.total.bytes, 3600);
});
test('native server files stay separate from browser quota and legacy cleanup authorization', async () => {
    const result = await collectProseAssistantStorage(options({ store: { usage: async () => local() } }));
    assert.equal(result.bytes, 100); assert.equal(result.native.total.bytes, 3600); assert.equal(result.count, 2); assert.equal(result.native.heads.count, 2);
    const choices = collectionCleanupOptions({ assistantStorage: result }); assert.equal(choices.length, 1); assert.equal(choices[0].bytes, 100); assert.match(choices[0].label, /旧副本.*本机/); assert.match(choices[0].risk[0], /不删除ST记录/);
    const html = renderStorageBackupSection(null, number => number + ' B', { data: { assistantStorage: result } });
    assert.match(html, /场外特助 · 当前账户 ST 文件/); assert.match(html, /1600 B/); assert.match(html, /3 份 · 2000 B/); assert.match(html, /7 个文件 · 3600 B/); assert.match(html, /当前账户旧本机副本/); assert.match(html, /100 B 逻辑估算/);
    assert.match(html, /不读取问答或核验历史正文/); assert.match(html, /不是磁盘分配量/);
});
test('unavailable native service never hides a known legacy estimate or turns ST usage into zero', async () => {
    const result = await collectProseAssistantStorage(options({ store: { usage: async () => local() }, fetchImpl: async () => new Response('Not found', { status: 404 }) }));
    assert.equal(result.status, 'ready'); assert.equal(result.bytes, 100); assert.equal(result.native.status, 'unavailable'); assert.equal(result.native.bytes, null);
    const html = renderStorageBackupSection(null, String, { data: { assistantStorage: result } }); assert.match(html, /请更新后端/); assert.match(html, /不依赖这项盘点/);
});
test('unavailable local database does not hide known ST observations', async () => {
    const result = await collectProseAssistantStorage(options({ store: { usage: async () => { throw Error('PRIVATE'); } } }));
    assert.equal(result.status, 'unavailable'); assert.equal(result.bytes, null); assert.equal(result.native.total.bytes, 3600);
    assert.equal(collectionCleanupOptions({ assistantStorage: result }).length, 0);
});
test('account and page changes invalidate rather than attach totals to a new owner', async () => {
    for (const mode of ['account', 'page']) {
        let owner = namespace, live = true;
        await assert.rejects(collect(options({ resolveNamespace: async () => owner, isCurrent: () => live,
            fetchImpl: async () => { if (mode === 'account') owner = 'st-user:bob'; else live = false; return response(); } })), { code: 'prose_assistant_storage_stale' });
    }
});
test('expired login rejects even with JSON error details', async () => {
    for (const status of [401, 403]) await assert.rejects(collect(options({ fetchImpl: async () => response({ message: 'PRIVATE' }, status) })), { code: 'prose_assistant_storage_stale' });
});
test('malformed, extra-field, wrong-account and inconsistent responses are unavailable, never partial totals', async () => {
    for (const data of [{ ...value(), expectedAccount: 'st-user:' + 'f'.repeat(64) }, { ...value(), secret: 'PRIVATE' }, { ...value(), total: { count: 7, bytes: 1 } }, { ...value(), contentVerified: true }, []]) {
        const result = await collect(options({ fetchImpl: async () => response(data) })); assert.equal(result.status, 'unavailable'); assert.equal(result.bytes, null); assert.equal('total' in result, false); assert.doesNotMatch(result.error, /PRIVATE/);
    }
});
test('HTTP, content-type, oversized and redirect failures use safe messages', async () => {
    for (const make of [() => response({ message: 'PRIVATE' }, 503), () => response(value(), 200, { 'content-length': '5000' }), () => new Response('PRIVATE', { headers: { 'content-type': 'text/plain' } }),
        () => response({ ok: false, code: 'assistant_storage_PRIVATE' }, 400), () => { const r = response(); Object.defineProperty(r, 'redirected', { value: true }); return r; },
        () => { const r = response(); Object.defineProperty(r, 'url', { value: 'https://fixture.invalid/wrong-path' }); return r; }]) {
        const result = await collect(options({ fetchImpl: async () => make() })); assert.equal(result.status, 'unavailable'); assert.doesNotMatch(result.error, /PRIVATE/);
    }
});
test('a response from another origin cannot be adopted even when its path and payload match', async t => {
    const descriptor=Object.getOwnPropertyDescriptor(globalThis,'location');Object.defineProperty(globalThis,'location',{configurable:true,value:{origin:'https://local.fixture.invalid'}});
    t.after(()=>{if(descriptor)Object.defineProperty(globalThis,'location',descriptor);else delete globalThis.location;});
    const result=await collect(options({fetchImpl:async()=>{const r=response();Object.defineProperty(r,'url',{value:'https://foreign.fixture.invalid/api/plugins/qianmu-tts/assistant/storage'});return r;}}));
    assert.equal(result.status,'unavailable');assert.equal('total' in result,false);
});
test('known missing/corrupt file response differs from an uninstalled backend', async () => {
    const result = await collect(options({ fetchImpl: async () => response({ ok: false, code: 'assistant_storage_missing', message: 'PRIVATE' }, 404) }));
    assert.match(result.error, /文件缺失/); assert.doesNotMatch(result.error, /请更新后端|PRIVATE/);
});
test('arbitrary transport exception messages and pseudo public fields cannot escape', async () => {
    const result = await collect(options({ fetchImpl: async () => { throw Object.assign(Error('PRIVATE request body'), { publicMessage: 'PRIVATE URL' }); } })); assert.doesNotMatch(result.error, /PRIVATE/);
});
test('deadline includes identity resolution and never starts a late request after expiry', async () => {
    let resume, calls = 0;
    const pending = collect(options({ timeoutMs: 100, resolveNamespace: () => new Promise(resolve => { resume = resolve; }), fetchImpl: async () => { calls++; return response(); } }));
    const result = await pending; assert.equal(result.status, 'unavailable'); resume(namespace); await new Promise(resolve => setImmediate(resolve)); assert.equal(calls, 0);
});
test('cancellation closes a stalled response reader and returns no successful observation', async () => {
    let cancelled = false, began; const started = new Promise(resolve => { began = resolve; }), controller = new AbortController();
    const pending = collect(options({ signal: controller.signal, fetchImpl: async () => new Response(new ReadableStream({ start() { began(); }, cancel() { cancelled = true; } }), { headers: { 'content-type': 'application/json' } }) }));
    await started; controller.abort(); const result = await pending; await new Promise(resolve => setImmediate(resolve)); assert.equal(result.status, 'unavailable'); assert.equal(cancelled, true);
});
test('streamed oversize response is cancelled rather than parsed', async () => {
    let cancelled = false;
    const result = await collect(options({ fetchImpl: async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('x'.repeat(5000))); }, cancel() { cancelled = true; } }), { headers: { 'content-type': 'application/json' } }) }));
    assert.equal(result.status, 'unavailable'); assert.equal(cancelled, true);
});
test('actual server and floor wiring expose the read-only observation without mutating cleanup scope', async () => {
    const server = await readFile(new URL('../server-plugin.js', import.meta.url), 'utf8'), floor = await readFile(new URL('../qianmu-prose-assistant-floor.js', import.meta.url), 'utf8');
    assert.match(server, /installAssistantStorageRoutes\(router,\{dataRoot:hostDataRoot,register:service=>imageTaskServices.add\(service\)/);
    assert.match(floor, /collectProseAssistantStorage\(\{resolveNamespace,isCurrent:live,headers\}\)/);
    assert.match(floor, /cleanupProseAssistantStorage\(\{resolveNamespace,isCurrent:valid,expectedNamespace,check,confirm,otherModules\}\)/);
});
