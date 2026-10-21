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
        if (path.startsWith('/api/plugins/qianmu-tts/chat-backups/')) return new Response('', { status: 404 });
        if (path === '/api/backups/chat/get') return respond([...sources].map(([name, raw]) => ({ file_name: name, file_size: String(raw.length) + ' B', chat_items: inspectChatRecoveryJsonl(raw).messageCount, last_mes: '2026-10-19T03:00:00Z', mes: '<script>must be text</script>', chat_metadata: { doNotExpose: true } })));
        if (path === '/api/backups/chat/download') return new Response(sources.get(body.name) || '', { status: sources.has(body.name) ? 200 : 404 });
        if (path === '/api/characters/chats') return respond([...files.get(body.avatar_url).keys()].map(file_name => ({ file_name })));
        if (path === '/api/chats/import') {
            const avatar = body.get('avatar_url'), prefix = body.get('character_name'), raw = await body.get('avatar').text();
            const name = `${prefix} - 2026-10-19@11h00m00s001ms imported.jsonl`;
            const context = { files, sources, avatar, prefix, raw, name, respond };
            if (options.importer) return options.importer(context);
            files.get(avatar).set(name, raw); return respond({ res: true, fileNames: [name] });
        }
        if (path === '/api/chats/rename') {
            const chats = files.get(body.avatar_url);
            if (!chats?.has(body.original_file) || chats.has(body.renamed_file)) return new Response(JSON.stringify({ error: true }), { status: 400, headers: { 'content-type': 'application/json' } });
            const raw = chats.get(body.original_file); chats.delete(body.original_file); chats.set(body.renamed_file, raw);
            if (options.renameResponseLoss?.()) throw Error('rename response lost');
            return respond({ ok: true, sanitizedFileName: body.renamed_file.replace(/\.jsonl$/, '') });
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
    assert.deepEqual(f.calls.map(call => call.path), ['/api/backups/chat/get', '/api/plugins/qianmu-tts/chat-backups/list', '/api/backups/chat/download']);
    await assert.rejects(f.controller.preview('chat_another.jsonl'), /当前账户/); assert.equal(f.calls.length, 3);
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
    assert.doesNotMatch(result.result.fileName, / imported\.jsonl$/);
    assert.equal(f.imports().length, 1); const imported = f.imports()[0];
    assert.equal(imported.body.get('file_type'), 'jsonl'); assert.equal(imported.body.get('avatar_url'), 'role.png'); assert.ok(imported.body.get('avatar') instanceof Blob); assert.equal(imported.body.get('file'), null);
    assert.equal(imported.config.headers.has('content-type'), false); assert.equal(imported.config.headers.get('x-csrf-token'), 'fixture-only');
    assert.equal(imported.config.credentials, 'same-origin');
    const restored = inspectChatRecoveryJsonl(f.files.get('role.png').get(result.result.fileName)).rows;
    assert.notEqual(restored[0].chat_metadata.integrity, originalRows()[0].chat_metadata.integrity);
    restored[0].chat_metadata.integrity = originalRows()[0].chat_metadata.integrity;
    assert.deepEqual(restored, originalRows()); assert.equal(f.sources.get(backup), beforeSource); assert.equal(f.files.get('role.png').get('原聊天.jsonl'), old);
    assert.equal(f.files.get('other.png').size, 0);
    const other = await f.controller.recover('other.png'); assert.equal(other.result.target.avatar, 'other.png'); assert.equal(f.imports().length, 2, 'a different target is a new recovery operation');
});

test('response loss after a successful write is resolved by readback, never reposted', async () => {
    const f = fixture({ importer: async ({ files, avatar, name, raw }) => { files.get(avatar).set(name, raw); throw Error('connection lost'); } });
    await f.prepare(); const result = await f.controller.recover('role.png');
    assert.equal(result.result.status, 'verified'); assert.doesNotMatch(result.result.fileName, / imported\.jsonl$/); assert.equal(f.imports().length, 1);
    await f.controller.verify(); assert.equal(f.imports().length, 1);
});

test('rename response loss after a successful import is resolved without reposting', async () => {
    let lose = true;
    const f = fixture({ renameResponseLoss: () => { if (!lose) return false; lose = false; return true; } }); await f.prepare();
    const result = await f.controller.recover('role.png');
    assert.equal(result.result.status, 'verified'); assert.doesNotMatch(result.result.fileName, / imported\.jsonl$/); assert.equal(f.imports().length, 1);
});

test('verified recovery markers survive a fresh list read without keeping the old banner or re-importing', async () => {
    const f = fixture(); await f.prepare();
    const first = await f.controller.recover('role.png');
    assert.equal(first.result.status, 'verified');
    assert.equal(f.controller.snapshot().recovered.length, 1);
    await f.controller.load();
    assert.equal(f.controller.snapshot().result, null);
    assert.equal(f.controller.snapshot().recovered.length, 1);
    await f.controller.preview(backup);
    const again = await f.controller.recover('role.png');
    assert.equal(again.result, null);
    assert.equal(f.imports().length, 1);
});

test('definitive ST import rejection clears the receipt and allows a later recovery', async () => {
    let reject = true;
    const f = fixture({ importer: async ({ files, avatar, name, raw, respond }) => {
        if (reject) return new Response(JSON.stringify({ error: 'missing upload' }), { status: 400, headers: { 'content-type': 'application/json' } });
        files.get(avatar).set(name, raw); return respond({ res: true, fileNames: [name] });
    } });
    await f.prepare();
    await assert.rejects(f.controller.recover('role.png'), /未预期|400|找回失败/);
    assert.equal(f.controller.snapshot().phase, 'error'); assert.equal(f.controller.snapshot().result, null);
    reject = false;
    const recovered = await f.controller.recover('other.png');
    assert.equal(recovered.result.status, 'verified'); assert.equal(f.imports().length, 2);
});

test('unknown write stays unknown with zero blind retries, while other targets remain recoverable', async () => {
    let attempts = 0, deferred;
    const f = fixture({ importer: async value => {
        if (++attempts === 1) { deferred = value; throw Error('still running remotely'); }
        value.files.get(value.avatar).set(value.name, value.raw); return value.respond({ res: true, fileNames: [value.name] });
    } });
    await f.prepare(); const first = await f.controller.recover('role.png');
    assert.equal(first.phase, 'unknown'); assert.equal(first.result.status, 'unknown');
    const second = await f.controller.recover('other.png');
    assert.equal(second.result.status, 'verified'); assert.equal(second.result.target.avatar, 'other.png'); assert.equal(f.imports().length, 2);
    assert.ok(deferred, 'the first uncertain operation remains a no-retry receipt');
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

test('verified recovery cannot import the same source into the same target twice', async () => {
    let sequence = 0;
    const f = fixture({ importer: async ({ files, avatar, prefix, raw, respond }) => {
        const name = `${prefix} - 2026-10-19@11h00m00s00${++sequence}ms imported.jsonl`;
        files.get(avatar).set(name, raw);
        return respond({ res: true, fileNames: [name] });
    } });
    await f.prepare();
    const first = await f.controller.recover('role.png');
    assert.equal(first.result.status, 'verified');
    await f.controller.load();
    await f.controller.preview(backup);
    const second = await f.controller.recover('role.png');
    assert.equal(second.result, null);
    assert.equal(f.imports().length, 1);
    for (const call of f.imports()) {
        assert.equal(call.body.get('character_name'), '目标角色-QM1');
        assert.doesNotMatch(call.body.get('character_name'), /\d+条/);
    }
});

test('recovery prefixes continue the target role QM sequence', async () => {
    const f = fixture();
    f.files.get('role.png').set('目标角色-QM7 - 2026-10-18@10h00m00s000ms imported.jsonl', jsonl(originalRows()));
    await f.prepare();
    const result = await f.controller.recover('role.png');
    assert.equal(result.result.status, 'verified');
    assert.equal(f.imports()[0].body.get('character_name'), '目标角色-QM8');
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
    await f.controller.verify(); await f.controller.recover('other.png'); assert.equal(f.imports().length, 2, 'a different target can still be attempted without reposting the original');
});

test('preview shows the newest five complete floors while the entire source remains restorable', async () => {
    const f = fixture(), rows = originalRows(); rows.push(...Array.from({ length: 20 }, (_, i) => ({ name: '角色' + i, mes: '长文'.repeat(1800), extra: { index: i } })));
    f.sources.set(backup, jsonl(rows)); const preview = await f.prepare();
    assert.equal(preview.preview.previewMessages.length, 5);
    assert.equal(preview.preview.previewMessages[0].floor, rows.length - 1);
    assert.equal(preview.preview.previewMessages.at(-1).floor, rows.length - 5);
    assert.equal(preview.preview.previewMessages[0].text, rows.at(-1).mes);
    const result = await f.controller.recover('role.png'); assert.equal(result.result.messageCount, rows.length - 1);
    assert.equal(inspectChatRecoveryJsonl(f.files.get('role.png').get(result.result.fileName)).rows.length, rows.length);
});

test('module uses only read routes plus import/rename, with no delete/save/open/storage or raw HTML path', async () => {
    const source = await readFile(new URL('../qianmu-chat-recovery.js', import.meta.url), 'utf8');
    assert.doesNotMatch(source, /\/api\/chats\/(?:save|delete)|\/api\/backups\/chat\/delete|innerHTML|localStorage|indexedDB|saveMetadata|openCharacterChat/);
    assert.match(source, /NOT exclusive-create/);
});

const backupApi = '/api/plugins/qianmu-tts/chat-backups';
const autoStatus = patch => ({ ok: true, version: 1, enabled: false, intervalMinutes: 30, limitMiB: 1024, usedBytes: 0,
    lastRunAt: null, lastSuccessAt: null, nextRunAt: null, lastResult: { created: 0, unchanged: 0, skipped: 0 }, retention: 'rotate-oldest-keep-one', ...patch });
const jsonResponse = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });

test('HTTP failures describe actual status without treating server errors as login failures', async () => {
    for (const [status, pattern] of [[401, /登录.*401/], [403, /校验.*403/], [404, /接口.*404/], [500, /读取或处理.*500/], [502, /代理.*502/], [206, /未预期.*206/]]) {
        const f = fixture({ before: call => call.path === '/api/backups/chat/get' ? new Response('{}', { status, headers: { 'content-type': 'application/json' } }) : undefined });
        await assert.rejects(f.controller.load(), pattern);
        assert.equal(f.imports().length, 0);
        if (![401, 403].includes(status)) assert.doesNotMatch(f.controller.snapshot().error, /登录/);
        else assert.equal(f.calls.length, 1, 'auth rejection cannot continue into another catalog');
    }
});

test('native recovery remains available when the optional service is absent', async () => {
    const f = fixture(); await f.prepare(); assert.equal(f.controller.snapshot().automaticBackup.availability, 'unavailable');
    await assert.rejects(f.controller.inspectAutomaticBackup(), /v1.59.482/);
    const restored = await f.controller.recover('role.png'); assert.equal(restored.result.status, 'verified');
});

test('automatic settings require a read, validate bounds and preserve the confirmed owner', async () => {
    const f = fixture({ before: call => call.path === backupApi + '/status' ? jsonResponse(autoStatus()) : call.path === backupApi + '/configure' ? jsonResponse(autoStatus(call.body)) : undefined });
    await f.controller.inspectAutomaticBackup();
    for (const input of [{ enabled: true, intervalMinutes: 14, limitMiB: 1024 }, { enabled: true, intervalMinutes: 1441, limitMiB: 1024 }, { enabled: true, intervalMinutes: 30, limitMiB: 255 }]) await assert.rejects(f.controller.configureAutomaticBackup(input));
    assert.equal(f.calls.filter(call => call.path.endsWith('/configure')).length, 0);
    await f.controller.configureAutomaticBackup({ enabled: true, intervalMinutes: 15, limitMiB: 512 });
    assert.equal(f.controller.snapshot().automaticBackup.status.enabled, true);
    assert.equal(f.calls.find(call => call.path.endsWith('/configure')).body.expectedAccount, 'account-a');
    f.setAccount('account-b');
    await assert.rejects(f.controller.configureAutomaticBackup({ enabled: false, intervalMinutes: 30, limitMiB: 1024 }), /账户/);
    assert.equal(f.calls.filter(call => call.path.endsWith('/configure')).length, 1, 'old confirmation cannot bind a new owner');
});

test('automatic retention accepts only 3, 7, 15 or 30 days and sends the selected period', async () => {
    const f = fixture({ before: call => call.path === backupApi + '/status' ? jsonResponse(autoStatus()) : call.path === backupApi + '/configure' ? jsonResponse(autoStatus(call.body)) : undefined });
    await f.controller.inspectAutomaticBackup();
    for (const retentionDays of [2, 0, 31, 14, '7', null]) {
        await assert.rejects(f.controller.configureAutomaticBackup({ enabled: true, intervalMinutes: 30, limitMiB: 1024, retentionDays }));
    }
    assert.equal(f.calls.filter(call => call.path.endsWith('/configure')).length, 0);
    for (const retentionDays of [3, 7, 15, 30]) {
        await f.controller.configureAutomaticBackup({ enabled: true, intervalMinutes: 30, limitMiB: 1024, retentionDays });
        assert.equal(f.calls.filter(call => call.path.endsWith('/configure')).at(-1).body.retentionDays, retentionDays);
    }
});

test('legacy automatic status defaults to a bounded period and omitted count updates preserve the read limit', async () => {
    let stored = autoStatus();
    const f = fixture({ before: call => {
        if (call.path === backupApi + '/status') return jsonResponse(stored);
        if (call.path === backupApi + '/configure') { stored = autoStatus(call.body); return jsonResponse(stored); }
    } });
    await f.controller.inspectAutomaticBackup();
    assert.equal(f.controller.snapshot().automaticBackup.status.maxVersionsPerChat, 0);
    assert.equal(f.controller.snapshot().automaticBackup.status.retentionDays, 30);
    await f.controller.configureAutomaticBackup({ enabled: true, intervalMinutes: 30, limitMiB: 1536, maxVersionsPerChat: 7 });
    assert.equal(f.controller.snapshot().automaticBackup.status.maxVersionsPerChat, 7);
    await f.controller.configureAutomaticBackup({ enabled: true, intervalMinutes: 45, limitMiB: 3000 });
    assert.equal(f.calls.filter(call => call.path.endsWith('/configure')).at(-1).body.maxVersionsPerChat, 7);
    assert.equal(f.controller.snapshot().automaticBackup.status.limitMiB, 3000);
    await f.controller.configureAutomaticBackup({ enabled: true, intervalMinutes: 45, limitMiB: 3000, maxVersionsPerChat: 0 });
    assert.equal(f.controller.snapshot().automaticBackup.status.maxVersionsPerChat, 0);
});

test('invalid automatic version limits are rejected before writes and invalid receipts remain unknown', async () => {
    const bad = [-1, 0.5, 20001, '3', null, false, {}, Number.MAX_SAFE_INTEGER];
    const f = fixture({ before: call => call.path === backupApi + '/status' ? jsonResponse(autoStatus()) : undefined });
    await f.controller.inspectAutomaticBackup();
    for (const maxVersionsPerChat of bad) await assert.rejects(f.controller.configureAutomaticBackup({ enabled: true, intervalMinutes: 30, limitMiB: 1024, maxVersionsPerChat }));
    assert.equal(f.calls.filter(call => call.path.endsWith('/configure')).length, 0);
    for (const maxVersionsPerChat of bad) {
        const other = fixture({ before: call => call.path === backupApi + '/status' ? jsonResponse(autoStatus({ maxVersionsPerChat })) : undefined });
        await assert.rejects(other.controller.inspectAutomaticBackup(), /不完整/);
    }
    for (const response of [autoStatus({ enabled: true }), autoStatus({ enabled: true, maxVersionsPerChat: 3 }), autoStatus({ enabled: true, maxVersionsPerChat: '5' })]) {
        const other = fixture({ before: call => call.path === backupApi + '/status' ? jsonResponse(autoStatus()) : call.path === backupApi + '/configure' ? jsonResponse(response) : undefined });
        await other.controller.inspectAutomaticBackup();
        await assert.rejects(other.controller.configureAutomaticBackup({ enabled: true, intervalMinutes: 30, limitMiB: 1024, maxVersionsPerChat: 5 }));
        assert.equal(other.controller.snapshot().automaticBackup.configurationUnknown, true);
        await assert.rejects(other.controller.configureAutomaticBackup({ enabled: true, intervalMinutes: 30, limitMiB: 1024, maxVersionsPerChat: 5 }), /未确认/);
        assert.equal(other.calls.filter(call => call.path.endsWith('/configure')).length, 1);
    }
});

test('unknown settings writes stay locked through failed verification and transient auth loss', async () => {
    let mode = 'ok', status = autoStatus();
    const f = fixture({ before: call => {
        if (call.path === backupApi + '/status') return mode === 'ok' ? jsonResponse(status) : new Response('{}', { status: mode === 'auth' ? 403 : 503, headers: { 'content-type': 'application/json' } });
        if (call.path === backupApi + '/configure') { status = autoStatus(call.body); throw Error('response lost'); }
    } });
    const input = { enabled: true, intervalMinutes: 30, limitMiB: 1024 };
    await f.controller.inspectAutomaticBackup(); await assert.rejects(f.controller.configureAutomaticBackup(input));
    assert.equal(f.controller.snapshot().automaticBackup.configurationUnknown, true);
    mode = 'fail'; await assert.rejects(f.controller.inspectAutomaticBackup());
    assert.equal(f.controller.snapshot().automaticBackup.configurationUnknown, true);
    await assert.rejects(f.controller.configureAutomaticBackup(input), /未确认/);
    mode = 'auth'; await assert.rejects(f.controller.inspectAutomaticBackup());
    await assert.rejects(f.controller.configureAutomaticBackup(input), /未确认/);
    assert.equal(f.calls.filter(call => call.path.endsWith('/configure')).length, 1);
    mode = 'ok'; await f.controller.inspectAutomaticBackup();
    assert.equal(f.controller.snapshot().automaticBackup.configurationUnknown, false);
    assert.equal(f.controller.snapshot().automaticBackup.status.enabled, true);
});

test('an incomplete or mismatched configure receipt is never treated as success', async () => {
    for (const response of [autoStatus(), { ok: true }, autoStatus({ usedBytes: 0.5 }), autoStatus({ retention: 'delete-all' })]) {
        const f = fixture({ before: call => call.path === backupApi + '/status' ? jsonResponse(autoStatus()) : call.path === backupApi + '/configure' ? jsonResponse(response) : undefined });
        await f.controller.inspectAutomaticBackup();
        await assert.rejects(f.controller.configureAutomaticBackup({ enabled: true, intervalMinutes: 15, limitMiB: 512 }));
        assert.equal(f.controller.snapshot().automaticBackup.configurationUnknown, true);
    }
});

test('optional-service failures use bounded known codes, never arbitrary returned message HTML', async () => {
    const f = fixture({ before: call => call.path === backupApi + '/status' ? new Response(JSON.stringify({ ok: false, version: 1, code: 'chat_backup_disk_full', message: '<script>secret</script>' }), { status: 507, headers: { 'content-type': 'application/json' } }) : undefined });
    await assert.rejects(f.controller.inspectAutomaticBackup(), /剩余空间不足/);
    assert.doesNotMatch(f.controller.snapshot().error, /script|secret/);
});

test('automatic snapshots can be previewed and restored unchanged through native import', async () => {
    const entry = { id: '10000000-0000-4000-8000-000000000001', avatar: 'role.png', chatFile: '原聊天.jsonl', createdAt: '2026-10-19T05:00:00.000Z', messageCount: 2, sizeBytes: new TextEncoder().encode(jsonl(originalRows())).length, sha256: 'a'.repeat(64) };
    for (const nativeFailed of [false, true]) {
        const f = fixture({ before: call => {
            if (nativeFailed && call.path === '/api/backups/chat/get') return new Response('', { status: 500 });
            if (call.path === backupApi + '/list') return jsonResponse({ ok: true, version: 1, entries: [entry] });
            if (call.path === backupApi + '/read') return new Response(jsonl(originalRows()), { headers: { 'content-type': 'text/plain' } });
        } });
        const listed = await f.controller.load();
        if (nativeFailed) assert.match(listed.error, /仅显示千幕/);
        await f.controller.preview('qianmu:' + entry.id);
        const done = await f.controller.recover('role.png'); assert.equal(done.result.status, 'verified');
        const reads = f.calls.filter(call => call.path === backupApi + '/read');
        assert.equal(reads.length, 2); assert.deepEqual(reads[0].body, { expectedAccount: 'account-a', id: entry.id });
        assert.equal(f.imports().length, 1);
    }
});
