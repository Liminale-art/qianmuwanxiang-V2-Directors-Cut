import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { CHAT_RECOVERY_LIMITS, createChatRecovery, inspectChatRecoveryJsonl } from '../qianmu-chat-recovery.js';

const backup = 'chat_role_20261019-110000.jsonl';
const originalRows = () => [
    { user_name: 'unused', character_name: 'unused', create_date: '2026-10-18', custom: { untouched: [false, null, 0] }, chat_metadata: { integrity: 'original-identity', qianmu: { history: [{ text: '已有推演' }] }, anotherPlugin: { key: '原资料' }, bookmarks: ['旧引用'] } },
    { name: '用户', is_user: true, send_date: 'date-a', mes: '<img src=x onerror=alert(1)>第一条', extra: { custom: { checked: true } } },
    { name: '角色', is_user: false, send_date: 'date-b', mes: '第二条正文', swipe_id: 1, swipes: ['候选一', '第二条正文'], swipe_info: [{ extra: { value: 1 } }, { extra: { value: 2 } }], extra: { isSmallSys: false } },
];
const jsonl = rows => rows.map(row => JSON.stringify(row)).join('\n');
const uuid = index => `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
const wait = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
function fixture(options = {}) {
    let account = 'account-a', current = true, sequence = 0;
    const characters = [{ avatar: 'role.png', name: '目标角色' }, { avatar: 'other.png', name: '另一角色' }];
    const sources = new Map([[backup, jsonl(originalRows())]]), files = new Map(), calls = [], changes = [];
    files.set('role.png', new Map([['原聊天.jsonl', jsonl(originalRows())]])); files.set('other.png', new Map());
    const respond = data => new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } });
    const fetch = async (path, config) => {
        const form = config.body instanceof FormData, body = form ? config.body : JSON.parse(config.body);
        const call = { path, body, config, account }; calls.push(call);
        const overridden = await options.before?.(call, { sources, files, characters }); if (overridden) return overridden;
        if (path === '/api/backups/chat/get') return respond([...sources].map(([name, raw]) => ({ file_name: name, file_size: String(raw.length) + ' B', chat_items: inspectChatRecoveryJsonl(raw).messageCount, last_mes: '2026-10-19T03:00:00Z', mes: '<script>must be text</script>', chat_metadata: { doNotExpose: true } })));
        if (path === '/api/backups/chat/download') return new Response(sources.get(body.name) || '', { status: sources.has(body.name) ? 200 : 404 });
        if (path === '/api/characters/chats') return respond([...files.get(body.avatar_url).keys()].map(file_name => ({ file_name })));
        if (path === '/api/chats/import') {
            const avatar = body.get('avatar_url'), prefix = body.get('character_name'), raw = await body.get('file').text();
            const name = `${prefix} - 2026-10-19@11h00m00s001ms imported.jsonl`;
            const context = { files, sources, avatar, prefix, raw, name, respond };
            if (options.importer) return options.importer(context);
            files.get(avatar).set(name, raw); return respond({ res: true, fileNames: [name] });
        }
        if (path === '/api/chats/export') return respond({ result: files.get(body.avatar_url).get(body.file) });
        throw Error('Unexpected network route: ' + path);
    };
    const controller = createChatRecovery({ fetch, origin: 'https://st.invalid', timeoutMs: options.timeoutMs || 15000, getRequestHeaders: () => ({ 'Content-Type': 'application/json', 'X-CSRF-Token': 'fixture-only' }), resolveAccount: async () => { if (options.accountFailure?.()) throw Error('network'); return account; }, getCharacters: () => characters, isCurrent: () => current, onChange: value => changes.push(value), crypto: { randomUUID: () => uuid(++sequence) } });
    return { controller, calls, sources, files, characters, changes, setAccount: value => { account = value; }, setCurrent: value => { current = value; }, imports: () => calls.filter(call => call.path === '/api/chats/import'), prepare: async () => { await controller.load(); return controller.preview(backup); } };
}

test('construction and snapshots never read backups or mutate chat state', () => {
    const f = fixture(); assert.equal(f.calls.length, 0); assert.equal(f.controller.snapshot().phase, 'idle');
    const copy = f.controller.snapshot(); copy.backups.push('alien'); assert.deepEqual(f.controller.snapshot().backups, []);
});

test('list and preview are account-scoped reads with safe text summaries, not raw metadata', async () => {
    const f = fixture(); const loaded = await f.controller.load();
    assert.equal(loaded.busy, false); assert.equal(loaded.backups[0].name, backup); assert.equal(loaded.backups[0].excerpt, '<script>must be text</script>');
    assert.equal('chat_metadata' in loaded.backups[0], false);
    const preview = await f.controller.preview(backup);
    assert.equal(preview.preview.messageCount, 2); assert.ok(preview.preview.text.includes('<img src=x onerror=alert(1)>'));
    assert.deepEqual(preview.preview.participants, ['用户', '角色']); assert.equal(f.imports().length, 0);
    assert.deepEqual(f.calls.map(call => call.path), ['/api/backups/chat/get', '/api/backups/chat/download']);
    await assert.rejects(f.controller.preview('chat_another.jsonl'), /当前账户/); assert.equal(f.calls.length, 2);
});

test('every successful same-name preview has a new revision and failed previews cannot advance it', async () => {
    const f = fixture(); const first = await f.prepare();
    const same = await f.controller.preview(backup);
    assert.equal(same.preview.name, first.preview.name); assert.equal(same.preview.revision, first.preview.revision + 1);
    const rows = originalRows(); rows[1].mes = '同名备份已变化'; f.sources.set(backup, jsonl(rows));
    const changed = await f.controller.preview(backup);
    assert.equal(changed.preview.name, first.preview.name); assert.equal(changed.preview.revision, same.preview.revision + 1); assert.match(changed.preview.text, /同名备份已变化/);
    f.sources.delete(backup); await assert.rejects(f.controller.preview(backup));
    assert.equal(f.controller.snapshot().preview.revision, changed.preview.revision);
});

test('recovery preserves every metadata/message/swipe field and original files, changing only integrity', async () => {
    const f = fixture(), beforeSource = f.sources.get(backup), old = f.files.get('role.png').get('原聊天.jsonl');
    await f.prepare(); const result = await f.controller.recover('role.png');
    assert.equal(result.phase, 'verified'); assert.equal(result.busy, false); assert.equal(result.result.status, 'verified');
    assert.equal(f.imports().length, 1); const imported = f.imports()[0];
    assert.equal(imported.body.get('file_type'), 'jsonl'); assert.equal(imported.body.get('avatar_url'), 'role.png');
    assert.equal(imported.config.headers.has('content-type'), false); assert.equal(imported.config.headers.get('x-csrf-token'), 'fixture-only');
    assert.equal(imported.config.credentials, 'same-origin');
    const restored = inspectChatRecoveryJsonl(f.files.get('role.png').get(result.result.fileName)).rows;
    assert.notEqual(restored[0].chat_metadata.integrity, originalRows()[0].chat_metadata.integrity);
    restored[0].chat_metadata.integrity = originalRows()[0].chat_metadata.integrity;
    assert.deepEqual(restored, originalRows()); assert.equal(f.sources.get(backup), beforeSource); assert.equal(f.files.get('role.png').get('原聊天.jsonl'), old);
    assert.equal(f.files.get('other.png').size, 0);
    await f.controller.recover('other.png'); assert.equal(f.imports().length, 1, 'repeat action only checks the original operation');
    assert.equal(f.controller.snapshot().result.target.avatar, 'role.png');
});

test('response loss after a successful write is resolved by readback, never reposted', async () => {
    const f = fixture({ importer: async ({ files, avatar, name, raw }) => { files.get(avatar).set(name, raw); throw Error('connection lost'); } });
    await f.prepare(); const result = await f.controller.recover('role.png');
    assert.equal(result.result.status, 'verified'); assert.equal(f.imports().length, 1);
    await f.controller.verify(); assert.equal(f.imports().length, 1);
});

test('unknown write stays unknown with zero blind retries, later verification uses the same frozen target', async () => {
    let deferred;
    const f = fixture({ importer: async value => { deferred = value; throw Error('still running remotely'); } });
    await f.prepare(); const first = await f.controller.recover('role.png');
    assert.equal(first.phase, 'unknown'); assert.equal(first.result.status, 'unknown');
    await f.controller.recover('other.png'); await f.controller.verify(); assert.equal(f.imports().length, 1);
    await assert.rejects(f.controller.preview(backup), /先核实/);
    deferred.files.get(deferred.avatar).set(deferred.name, deferred.raw);
    const done = await f.controller.verify(); assert.equal(done.result.status, 'verified'); assert.equal(done.result.target.avatar, 'role.png'); assert.equal(f.imports().length, 1);
});

test('mismatched metadata or messages fails complete readback even when counts and integrity match', async () => {
    for (const mutate of [rows => { rows[0].chat_metadata.anotherPlugin.key = 'lost'; }, rows => { rows[1].mes = 'changed'; }, rows => { delete rows[2].swipe_info; }]) {
        const f = fixture({ importer: async ({ files, avatar, name, raw, respond }) => { const rows = inspectChatRecoveryJsonl(raw).rows; mutate(rows); files.get(avatar).set(name, jsonl(rows)); return respond({ res: true, fileNames: [name] }); } });
        await f.prepare(); const result = await f.controller.recover('role.png');
        assert.equal(result.result.status, 'conflict'); assert.equal(result.phase, 'unknown'); assert.equal(f.files.get('role.png').size, 2);
        await f.controller.verify(); assert.equal(f.imports().length, 1);
    }
});

test('multiple operation-prefix matches are not guessed or deleted', async () => {
    const f = fixture({ importer: async ({ files, avatar, name, raw, prefix, respond }) => { files.get(avatar).set(name, raw); files.get(avatar).set(prefix + ' - another imported.jsonl', raw); return respond({ res: true, fileNames: [name] }); } });
    await f.prepare(); const result = await f.controller.recover('role.png');
    assert.equal(result.result.status, 'conflict'); assert.equal(f.calls.some(call => call.path === '/api/chats/export'), false); assert.equal(f.files.get('role.png').size, 3);
});

test('a collision detected before submission never imports', async () => {
    const f = fixture(); f.files.get('role.png').set(`千幕找回-${uuid(1)} - existing imported.jsonl`, jsonl(originalRows()));
    await f.prepare(); await assert.rejects(f.controller.recover('role.png'), /已存在/); assert.equal(f.imports().length, 0);
});

test('changed or removed source requires a new preview with no write', async () => {
    for (const remove of [false, true]) {
        const f = fixture(); await f.prepare();
        if (remove) f.sources.delete(backup); else f.sources.set(backup, f.sources.get(backup) + '\n');
        await assert.rejects(f.controller.recover('role.png')); assert.equal(f.imports().length, 0);
    }
});

test('target selection never comes from a backup filename or a current active chat', async () => {
    const f = fixture(); await f.prepare();
    for (const avatar of ['', '../role.png', 'missing.png']) await assert.rejects(f.controller.recover(avatar));
    assert.equal(f.imports().length, 0);
    const result = await f.controller.recover('other.png'); assert.equal(result.result.target.avatar, 'other.png'); assert.equal(f.files.get('role.png').size, 1);
});

test('target removal/rename while preflight is in flight prevents the import', async () => {
    for (const rename of [false, true]) {
        const f = fixture({ before: async call => { if (call.path === '/api/characters/chats') { if (rename) f.characters[0].name = '已改名'; else f.characters.shift(); } } });
        await f.prepare(); await assert.rejects(f.controller.recover('role.png'), /角色/); assert.equal(f.imports().length, 0);
    }
});

test('account changes clear visible private data and prevent cross-account writes', async () => {
    const f = fixture(); await f.prepare(); f.setAccount('account-b');
    await assert.rejects(f.controller.recover('role.png'), /账户/); assert.equal(f.imports().length, 0);
    assert.deepEqual(f.controller.snapshot().backups, []); assert.equal(f.controller.snapshot().preview, null); assert.equal(f.controller.snapshot().result, null);
    await f.controller.load(); await f.controller.preview(backup); const result = await f.controller.recover('role.png');
    assert.equal(result.result.status, 'verified'); assert.equal(f.imports()[0].account, 'account-b');
});

test('account switch during source fetch cannot publish the old preview', async () => {
    const f = fixture({ before: async call => { if (call.path === '/api/backups/chat/download') f.setAccount('account-b'); } });
    await f.controller.load(); await assert.rejects(f.controller.preview(backup), /账户/); assert.equal(f.controller.snapshot().preview, null);
});

test('leaving before write stops safely; closing after submission retains only an unverified operation for later checking', async () => {
    const pre = fixture({ before: async call => { if (call.path === '/api/characters/chats') pre.setCurrent(false); } });
    await pre.prepare(); await assert.rejects(pre.controller.recover('role.png'), /页面/); assert.equal(pre.imports().length, 0);
    const post = fixture({ importer: async ({ files, avatar, name, raw, respond }) => { files.get(avatar).set(name, raw); post.setCurrent(false); return respond({ res: true, fileNames: [name] }); } });
    await post.prepare(); await assert.rejects(post.controller.recover('role.png'), /页面/); assert.equal(post.controller.snapshot().phase, 'unknown');
    post.setCurrent(true); const result = await post.controller.verify(); assert.equal(result.result.status, 'verified'); assert.equal(post.imports().length, 1);
});

test('busy calls and disposal do not start a second import or publish a late result', async () => {
    const held = wait(); let started;
    const f = fixture({ importer: async value => { started = value; await held.promise; value.files.get(value.avatar).set(value.name, value.raw); return value.respond({ res: true, fileNames: [value.name] }); } });
    await f.prepare(); const running = f.controller.recover('role.png');
    while (!started) await new Promise(resolve => setTimeout(resolve, 0));
    await assert.rejects(f.controller.recover('role.png'), /上一项/); const oldChanges = f.changes.length;
    f.controller.dispose(); held.resolve(); await assert.rejects(running); assert.equal(f.changes.length, oldChanges); assert.equal(f.controller.snapshot().phase, 'idle'); assert.equal(f.imports().length, 1);
});

test('invalid native responses fail closed instead of treating them as an empty target directory', async () => {
    for (const reply of [{ error: true }, {}, [{ file_name: '../outside.jsonl' }]]) {
        const f = fixture({ before: async call => call.path === '/api/characters/chats' ? new Response(JSON.stringify(reply), { headers: { 'Content-Type': 'application/json' } }) : undefined });
        await f.prepare(); await assert.rejects(f.controller.recover('role.png'), /目录/); assert.equal(f.imports().length, 0);
    }
});

test('legacy native headers are preserved with an added integrity only', () => {
    const rows = originalRows(); delete rows[0].chat_metadata; assert.deepEqual(inspectChatRecoveryJsonl('\ufeff' + jsonl(rows) + '\n').rows, rows);
});

test('malformed, empty, transforming swipes, imprecise numbers and over-budget files are rejected', () => {
    for (const text of ['', '{}', '{}\nnot-json', '{"chat_metadata":[]}\n{"mes":"x"}', '{"chat_metadata":{}}\n{"mes":{"message":"x"}}', '{"chat_metadata":{}}\n{"mes":"x","swipes":[{"message":"x"}]}', '{"chat_metadata":{"n":9007199254740993}}\n{"mes":"x"}']) assert.throws(() => inspectChatRecoveryJsonl(text));
    const huge = 'x'.repeat(CHAT_RECOVERY_LIMITS.bytes + 1); assert.throws(() => inspectChatRecoveryJsonl(huge), /大小/);
});

test('strict JSONL rejects duplicates, unsafe fields and empty middle rows without dropping data', () => {
    const raw = jsonl(originalRows());
    for (const invalid of [raw.replace('"original-identity"', '"old","integrity":"original-identity"'), raw.replace('"custom":', '"__proto__":'), raw.replace('\n', '\n\n'), '\n' + raw, raw.replace('"value":1', '"value":0.10000000000000001')]) assert.throws(() => inspectChatRecoveryJsonl(invalid));
    assert.deepEqual(inspectChatRecoveryJsonl('\ufeff' + raw.replaceAll('\n', '\r\n') + '\r\n').rows, originalRows());
    const rows = originalRows(); rows[1].extra.gen_id = 9007199254740992; rows[1].mes = '9007199254740993 / 0.10000000000000001';
    assert.deepEqual(inspectChatRecoveryJsonl(jsonl(rows)).rows, rows, 'native serialized number tokens and numeric message text remain valid');
});

test('header swipe objects are also refused because native import would transform that unknown field', () => {
    const rows = originalRows(); rows[0].swipes = [{ message: '未知头字段不能被改写' }];
    assert.throws(() => inspectChatRecoveryJsonl(jsonl(rows)), /原样导入/);
});

test('identity lookup failure clears private visible state without creating a copy', async () => {
    let failed = false; const f = fixture({ accountFailure: () => failed }); await f.prepare(); failed = true;
    await assert.rejects(f.controller.recover('role.png'), /账户/);
    assert.deepEqual(f.controller.snapshot().backups, []); assert.equal(f.controller.snapshot().preview, null); assert.equal(f.controller.snapshot().result, null); assert.equal(f.imports().length, 0);
});

test('a hidden pending receipt returns only after the original account is confirmed again', async () => {
    let failed = false;
    const f = fixture({ accountFailure: () => failed, importer: async ({ files, avatar, name, raw, respond }) => { files.get(avatar).set(name, raw); failed = true; return respond({ res: true, fileNames: [name] }); } });
    await f.prepare(); await assert.rejects(f.controller.recover('role.png'), /账户/); assert.equal(f.controller.snapshot().result, null);
    failed = false; const reloaded = await f.controller.load(); assert.equal(reloaded.result.status, 'unknown'); assert.equal(reloaded.preview, null);
    const done = await f.controller.verify(); assert.equal(done.result.status, 'verified'); assert.equal(f.imports().length, 1);
    f.setAccount('account-b'); await f.controller.load(); assert.equal(f.controller.snapshot().result, null); assert.equal(f.controller.snapshot().preview, null);
});

test('duplicate avatars and native-sanitized target names are not guessed', async () => {
    const f = fixture(); await f.prepare(); f.characters.push({ ...f.characters[0] });
    await assert.rejects(f.controller.recover('role.png'), /不唯一/); assert.equal(f.imports().length, 0);
    for (const avatar of ['role?.png', 'con.png', 'role .png ', 'x'.repeat(256) + '.png', 'role\u0085.png']) {
        f.characters.push({ avatar, name: '存在但不安全' }); await assert.rejects(f.controller.recover(avatar));
    }
    assert.equal(f.imports().length, 0);
});

test('read transport refuses redirected or foreign sources, login HTML and oversized bodies', async () => {
    for (const modify of [r => Object.defineProperty(r, 'redirected', { value: true }), r => Object.defineProperty(r, 'url', { value: 'https://elsewhere.invalid/api/backups/chat/get' }), r => r.headers.set('content-type', 'text/html'), r => r.headers.set('content-length', String(CHAT_RECOVERY_LIMITS.bytes + 1)), r => r.headers.set('content-length', '-1')]) {
        const f = fixture({ before: async call => { if (call.path !== '/api/backups/chat/get') return; const response = new Response('[]', { headers: { 'content-type': 'application/json' } }); modify(response); return response; } });
        await assert.rejects(f.controller.load()); assert.deepEqual(f.controller.snapshot().backups, []); assert.equal(f.imports().length, 0);
        assert.equal(f.calls[0].config.redirect, 'error'); assert.ok(f.calls[0].config.signal instanceof AbortSignal);
    }
});

test('a stalled read times out, aborts its request and allows a later explicit read', async () => {
    let stall = true;
    const f = fixture({ timeoutMs: 15, before: call => call.path === '/api/backups/chat/get' && stall ? new Promise(() => {}) : undefined });
    await assert.rejects(f.controller.load(), /超时/); assert.equal(f.calls[0].config.signal.aborted, true); assert.equal(f.controller.snapshot().busy, false);
    stall = false; await f.controller.load(); assert.equal(f.controller.snapshot().phase, 'ready');
});

test('dispose releases a stalled request immediately without a late state publication', async () => {
    const start = wait(); const f = fixture({ before: call => { if (call.path === '/api/backups/chat/get') { start.resolve(); return new Promise(() => {}); } } });
    const loading = f.controller.load(); await start.promise; const count = f.changes.length; f.controller.dispose();
    await assert.rejects(loading, /页面/); assert.equal(f.changes.length, count); assert.equal(f.calls[0].config.signal.aborted, true);
});

test('a stalled response body is bounded by the same timeout and cancelled', async () => {
    let cancelled = false;
    const f = fixture({ timeoutMs: 15, before: call => call.path === '/api/backups/chat/get' ? new Response(new ReadableStream({ cancel() { cancelled = true; } }), { headers: { 'Content-Type': 'application/json' } }) : undefined });
    await assert.rejects(f.controller.load(), /超时/); assert.equal(cancelled, true); assert.equal(f.controller.snapshot().busy, false);
});

test('a timed-out submitted import remains unknown and verification never sends another import', async () => {
    const f = fixture({ timeoutMs: 15, importer: () => new Promise(() => {}) }); await f.prepare();
    const result = await f.controller.recover('role.png'); assert.equal(result.phase, 'unknown'); assert.equal(f.imports()[0].config.signal.aborted, true);
    await f.controller.verify(); await f.controller.recover('other.png'); assert.equal(f.imports().length, 1);
});

test('preview is bounded while the entire valid source remains restorable', async () => {
    const f = fixture(), rows = originalRows(); rows.push(...Array.from({ length: 20 }, (_, i) => ({ name: '角色' + i, mes: '长文'.repeat(1800), extra: { index: i } })));
    f.sources.set(backup, jsonl(rows)); const preview = await f.prepare();
    assert.ok(preview.preview.text.length <= CHAT_RECOVERY_LIMITS.previewChars); assert.match(preview.preview.text, /预览已节略|未在预览中展开/);
    const result = await f.controller.recover('role.png'); assert.equal(result.result.messageCount, rows.length - 1);
    assert.equal(inspectChatRecoveryJsonl(f.files.get('role.png').get(result.result.fileName)).rows.length, rows.length);
});

test('module uses only read routes plus import, with no delete/save/open/storage or raw HTML path', async () => {
    const source = await readFile(new URL('../qianmu-chat-recovery.js', import.meta.url), 'utf8');
    assert.doesNotMatch(source, /\/api\/chats\/(?:save|delete|rename)|\/api\/backups\/chat\/delete|innerHTML|localStorage|indexedDB|saveMetadata|openCharacterChat/);
    assert.match(source, /NOT exclusive-create/);
});
