import test from 'node:test';
import assert from 'node:assert/strict';
import { createChatRecovery } from '../qianmu-chat-recovery.js';

// Contract model of ST-BaiBai-Tools@58eace59 src/chat/chatList.js:253–307.
// The public wrapper rewrites only the native POST list to its fast-list API
// and returns that Response unchanged. This is not evidence of installation
// in a particular user's browser. All requests and records here are synthetic.
const origin = 'https://source-fixture.invalid';
const nativeList = '/api/backups/chat/get';
const alias = '/api/plugins/baibaoku/v1/chat-backups/fast-list';
const backup = 'chat_role_20261019-110000.jsonl';
const raw = [{ chat_metadata: { integrity: 'original', unknown: { keep: true } } },
    { name: '合成角色', is_user: false, mes: '仅合成正文' }].map(JSON.stringify).join('\n');
const sourceError = error => error?.code === 'source';

function wrapFastList(fetchImpl, observe = () => {}) {
    return (input, init) => {
        observe(input, init);
        const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url, origin);
        const method = String(init?.method ?? input?.method ?? 'GET').toUpperCase();
        if (method === 'POST' && url.origin === origin && url.pathname === nativeList) {
            // The public fast-list helper constructs a new RequestInit. It does
            // not forward the caller's credentials/cache/redirect options.
            return fetchImpl(new URL(alias, origin).href, { method: 'POST',
                headers: { 'X-CSRF-Token': 'synthetic-host', 'Content-Type': 'application/json' },
                body: '{}', signal: init?.signal });
        }
        return fetchImpl(input, init);
    };
}

function fixture({ listAlias = true, responseUrl, responseType = 'basic', redirected = false,
    mime = 'application/json', afterResponse, aliasFor = '' } = {}) {
    let account = 'source-account', sequence = 0;
    const calls = [], callerRequests = [], bodyReads = [], files = new Map();
    const reply = (path, data, { status = 200, type = 'application/json' } = {}) => {
        const response = new Response(typeof data === 'string' ? data : JSON.stringify(data), { status, headers: { 'content-type': type } });
        const isList = path === alias || path === nativeList;
        Object.defineProperties(response, {
            url: { value: isList ? responseUrl ?? origin + path : origin + (path === aliasFor ? alias : path) },
            redirected: { value: isList && redirected },
            type: { value: isList ? responseType : 'basic' },
        });
        const read = response.body.getReader.bind(response.body);
        response.body.getReader = (...args) => { bodyReads.push(path); return read(...args); };
        afterResponse?.({ path, response, setAccount: value => { account = value; } });
        return response;
    };
    const transport = async (input, init) => {
        const path = new URL(typeof input === 'string' ? input : input.url, origin).pathname;
        calls.push({ path, init });
        if (path === nativeList || path === alias) return reply(path, [{ file_name: backup, chat_items: 1, last_mes: '2026-10-19T03:01:00Z' }], { type: mime });
        if (path === '/api/plugins/qianmu-tts/chat-backups/list') return reply(path, {}, { status: 404 });
        if (path === '/api/plugins/qianmu-tts/chat-backups/status') return reply(path, {});
        if (path === '/api/backups/chat/download') return reply(path, raw, { type: 'application/jsonl' });
        if (path === '/api/characters/chats') return reply(path, [...files.keys()].map(file_name => ({ file_name })));
        if (path === '/api/chats/import') {
            const name = `${init.body.get('character_name')} - synthetic imported.jsonl`;
            // An invalid import acknowledgement may have reached the server;
            // leave an unknown result rather than pretending it is safe to retry.
            if (aliasFor !== path) files.set(name, await init.body.get('file').text());
            return reply(path, { res: true, fileNames: [name] });
        }
        if (path === '/api/chats/export') return reply(path, { result: files.get(JSON.parse(init.body).file) });
        assert.fail('Unexpected synthetic route: ' + path);
    };
    const controller = createChatRecovery({ origin, fetch: listAlias ? wrapFastList(transport, (input, init) => callerRequests.push({ input, init })) : transport,
        getRequestHeaders: () => ({ 'X-CSRF-Token': 'synthetic-only' }), resolveAccount: async () => account,
        getCharacters: () => [{ name: '合成角色', avatar: 'role.png' }],
        crypto: { randomUUID: () => `00000000-0000-4000-8000-${String(++sequence).padStart(12, '0')}` } });
    return { controller, calls, callerRequests, bodyReads, files, async prepare() { await controller.load(); await controller.preview(backup); } };
}

test('native list accepts only the exact fast-list response despite the wrapper dropping caller request policies', async t => {
    const f = fixture(); t.after(() => f.controller.dispose());
    const state = await f.controller.load();
    assert.equal(state.backups[0].name, backup);
    assert.equal(state.backups[0].lastMessageAt, '2026-10-19T03:01:00Z', 'native display time comes from ST last_mes, not the filename timestamp');
    assert.equal(f.calls[0].path, alias);
    assert.equal(f.calls[0].init.method, 'POST');
    assert.deepEqual(Object.keys(f.calls[0].init).sort(), ['body', 'headers', 'method', 'signal']);
    for (const name of ['credentials', 'redirect', 'cache']) assert.equal(Object.hasOwn(f.calls[0].init, name), false);
    assert.equal(new Headers(f.calls[0].init.headers).get('x-csrf-token'), 'synthetic-host');
    assert.equal(f.calls[0].init.body, '{}');
    assert.ok(f.calls[0].init.signal instanceof AbortSignal);
    const caller = f.callerRequests[0];
    assert.equal(caller.input, nativeList);
    assert.equal(caller.init.method, 'POST');
    assert.equal(caller.init.credentials, 'same-origin');
    assert.equal(caller.init.redirect, 'error');
    assert.equal(caller.init.cache, 'no-store');
    assert.equal(caller.init.headers.get('x-csrf-token'), 'synthetic-only');
    assert.equal(caller.init.signal, f.calls[0].init.signal);
    assert.equal(f.calls.some(call => call.path === '/api/chats/import'), false);
});

test('the modeled wrapper redirects relative, absolute and Request list inputs but no other route', async () => {
    const targets = [], wrapped = wrapFastList(async input => targets.push(typeof input === 'string' ? input : input.url));
    for (const input of [nativeList, origin + nativeList, new Request(origin + nativeList, { method: 'POST' })]) await wrapped(input, { method: 'POST' });
    assert.deepEqual(targets, [origin + alias, origin + alias, origin + alias]);
    await wrapped('/api/backups/chat/download', { method: 'POST' });
    await wrapped(nativeList, { method: 'GET' });
    assert.deepEqual(targets.slice(3), ['/api/backups/chat/download', nativeList]);
});

for (const [label, responseUrl, extra] of [
    ['redirected', origin + alias, { redirected: true }],
    ['opaque', origin + alias, { responseType: 'opaque' }],
    ['opaque redirect', origin + alias, { responseType: 'opaqueredirect' }],
    ['foreign origin', 'https://elsewhere.invalid' + alias],
    ['other same-origin API', origin + '/api/plugins/baibaoku/v1/other'],
    ['query', origin + alias + '?cache=1'],
    ['fragment', origin + alias + '#same-looking'],
    ['trailing slash', origin + alias + '/'],
    ['username', 'https://user@source-fixture.invalid' + alias],
]) {
    test(`fast-list compatibility rejects ${label} before reading the response`, async t => {
        const f = fixture({ responseUrl, ...extra }); t.after(() => f.controller.dispose());
        await assert.rejects(f.controller.load(), sourceError);
        assert.equal(f.callerRequests[0].init.redirect, 'error');
        assert.equal(Object.hasOwn(f.calls[0].init, 'redirect'), false, 'response source checks remain necessary when a host wrapper drops redirect:error');
        assert.equal(f.bodyReads.includes(alias), false);
        assert.deepEqual(f.controller.snapshot().backups, []);
        assert.equal(f.calls.some(call => call.path === '/api/chats/import'), false);
    });
}

test('the fast-list alias does not bypass account revalidation or MIME validation', async t => {
    const account = fixture({ afterResponse: ({ path, setAccount }) => { if (path === alias) setAccount('other-account'); } });
    const html = fixture({ mime: 'text/html' });
    t.after(() => { account.controller.dispose(); html.controller.dispose(); });
    await assert.rejects(account.controller.load(), error => error.code === 'account');
    await assert.rejects(html.controller.load(), error => error.code === 'response');
    assert.equal(account.bodyReads.includes(alias), false);
    assert.equal(html.bodyReads.includes(alias), false);
    assert.deepEqual(account.controller.snapshot().backups, []);
    assert.deepEqual(html.controller.snapshot().backups, []);
});

test('automatic backup listing cannot borrow the native list alias, without hiding valid native results', async t => {
    const path = '/api/plugins/qianmu-tts/chat-backups/list';
    const f = fixture({ listAlias: false, aliasFor: path }); t.after(() => f.controller.dispose());
    const state = await f.controller.load();
    assert.equal(state.backups.length, 1);
    assert.equal(state.backups[0].name, backup);
    assert.equal(state.automaticBackup.availability, 'unknown');
    assert.match(state.automaticBackup.error, /来源|地址/);
    assert.equal(f.bodyReads.includes(path), false);
    assert.equal(f.calls.some(call => call.path === '/api/chats/import'), false);
});

test('automatic backup status cannot borrow the native list alias', async t => {
    const path = '/api/plugins/qianmu-tts/chat-backups/status';
    const f = fixture({ listAlias: false, aliasFor: path }); t.after(() => f.controller.dispose());
    await assert.rejects(f.controller.inspectAutomaticBackup(), sourceError);
    assert.equal(f.bodyReads.includes(path), false);
    assert.equal(f.controller.snapshot().automaticBackup.status, null);
    assert.equal(f.calls.some(call => call.path.endsWith('/configure')), false);
});

test('preview/download cannot borrow the native list response alias', async t => {
    const f = fixture({ listAlias: false, aliasFor: '/api/backups/chat/download' }); t.after(() => f.controller.dispose());
    await f.controller.load();
    await assert.rejects(f.controller.preview(backup), sourceError);
    assert.equal(f.bodyReads.includes('/api/backups/chat/download'), false);
    assert.equal(f.controller.snapshot().preview, null);
});

test('target-chat listing cannot borrow the native list response alias before an import', async t => {
    const f = fixture({ listAlias: false, aliasFor: '/api/characters/chats' }); t.after(() => f.controller.dispose());
    await f.prepare(); await assert.rejects(f.controller.recover('role.png'), sourceError);
    assert.equal(f.bodyReads.includes('/api/characters/chats'), false);
    assert.equal(f.calls.some(call => call.path === '/api/chats/import'), false);
});

for (const path of ['/api/chats/import', '/api/chats/export']) {
    test(`${path} cannot borrow the native list alias or trigger an automatic retry`, async t => {
        const f = fixture({ listAlias: false, aliasFor: path }); t.after(() => f.controller.dispose());
        await f.prepare();
        if (path === '/api/chats/export') await assert.rejects(f.controller.recover('role.png'), sourceError);
        else await f.controller.recover('role.png');
        assert.equal(f.bodyReads.includes(path), false);
        assert.equal(f.controller.snapshot().result.status, 'unknown');
        if (path === '/api/chats/export') await assert.rejects(f.controller.verify(), sourceError);
        else await f.controller.verify();
        assert.equal(f.calls.filter(call => call.path === '/api/chats/import').length, 1);
        assert.equal(f.controller.snapshot().result.status, 'unknown');
    });
}
