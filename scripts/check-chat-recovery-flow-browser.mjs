// Actual controller + view + browser fetch, against an in-memory native-contract
// fixture only. All requests are intercepted; no ST, external origin, profile,
// real chat, backup directory, or filesystem write is used.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.QIANMU_PLAYWRIGHT_MODULE || 'playwright');
const browser = await chromium.launch({ channel: process.env.QIANMU_BROWSER_CHANNEL || undefined, headless: true });
const context = await browser.newContext(), page = await context.newPage();
const origin = 'https://recovery-flow-fixture.test';
const fastList = process.env.QIANMU_TEST_FAST_BACKUPS === '1';
const listPath = fastList ? '/api/plugins/baibaoku/v1/chat-backups/fast-list' : '/api/backups/chat/get';
const errors = [], external = [], checks = [], calls = [], imports = [];
const ok = (label, value) => { assert.ok(value, label); checks.push(label); };
const backupName = 'chat_role_20261019-110000.jsonl';
const originalRows = [
    { user_name: 'unused', character_name: 'unused', create_date: '2026-10-19', unknownHeader: { values: [0, false, null, '原资料'] }, chat_metadata: { integrity: 'fixture-original-integrity', qianmu: { history: [{ title: '已有推演', text: '完整保留' }] }, independentPlugin: { records: ['不能丢失'] } } },
    { name: '合成用户', is_user: true, mes: '<img src=x onerror="window.injected=true">这是纯文字', send_date: '2026-10-19T02:00:00Z', extra: { untouched: true } },
    { name: '合成角色', is_user: false, mes: '采用的回复', send_date: '2026-10-19T02:01:00Z', swipe_id: 1, swipes: ['候选回复', '采用的回复'], swipe_info: [{ extra: { note: '候选资料' } }, { extra: { note: '采用资料' } }], extra: { unknown: { values: [1, 2, 3] } } },
];
const jsonl = rows => rows.map(row => JSON.stringify(row)).join('\n');
const originalBackup = jsonl(originalRows), originalChat = originalBackup + '\n';
const backups = new Map([[backupName, originalBackup]]);
const chats = new Map([['role.png', new Map([['原聊天.jsonl', originalChat]])], ['other.png', new Map([['其他原聊天.jsonl', originalChat]])]]);
let importMode = 'normal', pendingImport;
const fulfillJson = (route, value) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(value) });
page.on('pageerror', error => errors.push(error.message));
await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== origin) { external.push(url.href); return route.abort(); }
    if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><meta charset="utf-8"><body><main id="recovery"></main></body>' });
    if (['/qianmu-chat-recovery.js', '/qianmu-chat-recovery-view.js', '/qianmu-chat-backup-catalog.js', '/qianmu-json-input.js'].includes(url.pathname)) return route.fulfill({ contentType: 'text/javascript', body: await readFile(new URL('..' + url.pathname, import.meta.url)) });
    if (!url.pathname.startsWith('/api/')) { external.push(url.href); return route.abort(); }
    const path = url.pathname;
    assert.equal(request.method(), 'POST');
    assert.equal(request.headers()['x-csrf-token'], 'synthetic-csrf');
    calls.push(path);
    if (path === '/api/chats/import') {
        const parsed = await new Request(url.href, { method: 'POST', headers: request.headers(), body: request.postDataBuffer() }).formData();
        assert.equal(parsed.get('file_type'), 'jsonl'); assert.equal(parsed.has('file_name'), false);
        const avatar = parsed.get('avatar_url'), prefix = parsed.get('character_name');
        assert.ok(chats.has(avatar)); assert.match(prefix, /^.+-QM\d+$/);
        const raw = await parsed.get('file').text();
        // Native import parses and serializes JSONL; it chooses the final name
        // from character_name + its own timestamp, not an input file_name.
        const stored = jsonl(raw.split('\n').map(line => JSON.parse(line)));
        const name = `${prefix} - 2026-10-19@11h00m00s${String(imports.length).padStart(3, '0')}ms imported.jsonl`;
        const entry = { avatar, name, raw: stored }; imports.push(entry);
        if (importMode === 'lost-deferred') { pendingImport = entry; return route.abort('failed'); }
        chats.get(avatar).set(name, stored);
        return fulfillJson(route, { res: true, fileNames: [name] });
    }
    const body = request.postDataJSON();
    if (path === listPath) return fulfillJson(route, [...backups].map(([file_name, raw]) => ({ file_name, file_size: `${Buffer.byteLength(raw)} B`, chat_items: raw.split('\n').length - 1, last_mes: '2026-10-19T02:01:00Z', mes: '<script>window.injected=true</script>' })));
    if (path === '/api/backups/chat/download') {
        assert.ok(backups.has(body.name)); return route.fulfill({ status: 200, contentType: 'application/jsonl', body: backups.get(body.name) });
    }
    if (path === '/api/characters/chats') {
        assert.equal(body.simple, true); assert.ok(chats.has(body.avatar_url));
        return fulfillJson(route, [...chats.get(body.avatar_url).keys()].map(file_name => ({ file_name, file_id: file_name.slice(0, -6) })));
    }
    if (path === '/api/chats/export') {
        assert.equal(body.format, 'jsonl'); assert.equal(body.is_group, false); assert.equal(body.exportfilename, body.file);
        assert.ok(chats.get(body.avatar_url)?.has(body.file));
        return fulfillJson(route, { result: chats.get(body.avatar_url).get(body.file), message: 'synthetic export' });
    }
    assert.fail('Unexpected native route: ' + path);
});
try {
    await page.goto(origin);
    await page.evaluate(async ({ fastList, listPath }) => {
        const { createChatRecovery } = await import('/qianmu-chat-recovery.js');
        const { mountChatRecoveryView } = await import('/qianmu-chat-recovery-view.js');
        if (fastList) {
            // Reproduce the public BaiBai Tools request contract with native browser
            // Responses, not a mocked url property. Only in-memory fixture traffic.
            const originalFetch = window.fetch;
            window.fetch = async (input, init) => {
                const url = new URL(input instanceof Request ? input.url : String(input), location.origin);
                const method = String(init?.method || (input instanceof Request ? input.method : 'GET')).toUpperCase();
                if (method === 'POST' && url.origin === location.origin && url.pathname === '/api/backups/chat/get') {
                    return originalFetch(listPath, { method: 'POST', headers: { 'X-CSRF-Token': 'synthetic-csrf', 'Content-Type': 'application/json' }, body: '{}', signal: init?.signal });
                }
                return originalFetch(input, init);
            };
        }
        window.characters = [{ avatar: 'role.png', name: '合成目标角色' }, { avatar: 'other.png', name: '另一合成角色' }];
        window.notices = []; window.confirmations = []; window.confirmation = true;
        window.controller = createChatRecovery({ getRequestHeaders: () => ({ 'X-CSRF-Token': 'synthetic-csrf' }), resolveAccount: async () => 'synthetic-account', getCharacters: () => characters, onChange: snapshot => window.view?.render(snapshot) });
        window.mount = () => { window.view = mountChatRecoveryView({ root: document.getElementById('recovery'), controller, getCharacters: () => characters,
            confirm: async message => { confirmations.push(message); return typeof confirmation === 'boolean' ? confirmation : await confirmation; }, notify: message => notices.push(message) }); };
        mount();
    }, { fastList, listPath });
    const idle = () => page.waitForFunction(() => !controller.snapshot().busy);
    const recover = () => page.getByRole('button', { name: '另建找回副本', exact: true, includeHidden: true });
    ok('Opening the real view/controller performs no backup or chat request', calls.length === 0);
    await page.getByRole('combobox', { name: '选择要找回的角色', exact: true }).selectOption('role.png');
    await page.getByRole('button', { name: '读取备份', exact: true }).click(); await idle();
    ok('Explicit load reaches the expected native list without a Qianmu backup service probe', calls.length === 1 && calls[0] === listPath);
    await page.locator('.qm-recovery-item').click(); await idle();
    ok('Real preview downloads the backup without writing and renders untrusted text literally', imports.length === 0
        && await page.evaluate(() => !window.injected && !document.querySelector('.qm-recovery-list script,.qm-recovery-preview img') && controller.snapshot().preview.messageCount === 2));
    ok('Explicitly chosen role stays fixed; filename matching is only a preview candidate', !await recover().isDisabled()
        && await page.locator('.qm-recovery-target-fixed').textContent().then(text=>text.includes('合成目标角色'))
        && !await page.getByRole('combobox', { name: '找回副本的目标角色', exact: true }).isVisible());

    await page.evaluate(() => { confirmation = false; }); await recover().click();
    ok('Cancelling confirmation never submits an import', imports.length === 0);
    await page.evaluate(() => { confirmation = new Promise(resolve => { window.resolveConfirmation = resolve; }); });
    await recover().click();
    await page.locator('.qm-recovery-item').click(); await idle();
    await page.evaluate(async () => { resolveConfirmation(true); await new Promise(resolve => setTimeout(resolve, 0)); });
    ok('Same-name preview reread invalidates the previous confirmation through its revision', imports.length === 0);

    await page.evaluate(() => { confirmation = new Promise(resolve => { window.resolveConfirmation = resolve; }); });
    await recover().click();
    await page.evaluate(async () => { characters[0].name = '合成目标改名'; resolveConfirmation(true); await new Promise(resolve => setTimeout(resolve, 0)); });
    ok('A target renamed during confirmation does not inherit that approval', imports.length === 0);
    await page.evaluate(() => { characters[0].name = '合成目标角色'; confirmation = true; view.render(); });
    await recover().click(); await page.waitForFunction(() => controller.snapshot().phase === 'verified');
    const first = await page.evaluate(() => controller.snapshot());
    ok('The full real flow creates exactly one selected-target copy and confirms its complete readback', imports.length === 1 && first.result.status === 'verified' && first.result.target.avatar === 'role.png' && first.result.messageCount === 2 && calls.at(-1) === '/api/chats/export');
    const firstRows = chats.get('role.png').get(first.result.fileName).split('\n').map(line => JSON.parse(line));
    assert.notEqual(firstRows[0].chat_metadata.integrity, originalRows[0].chat_metadata.integrity);
    firstRows[0].chat_metadata.integrity = originalRows[0].chat_metadata.integrity;
    assert.deepEqual(firstRows, originalRows);
    ok('Every unknown metadata/message/swipe field survives; only copy integrity changes', true);
    ok('The verified file is shown but not auto-opened, and resubmission is disabled', await page.getByText(first.result.fileName, { exact: false }).isVisible() && await recover().isDisabled());

    await page.locator('.qm-recovery-item').click(); await idle();
    importMode = 'lost-deferred'; await recover().click(); await page.waitForFunction(() => controller.snapshot().phase === 'unknown');
    ok('A lost import response yields an unknown receipt, not a second import', imports.length === 2 && pendingImport && await recover().isDisabled());
    const afterLoss = calls.length;
    await page.evaluate(async () => { try { await controller.preview('chat_role_20261019-110000.jsonl'); } catch {} }); await idle();
    ok('A new preview cannot bypass the unresolved write lock', imports.length === 2 && calls.length === afterLoss && await page.evaluate(() => controller.snapshot().result.status === 'unknown'));
    await page.evaluate(() => { view.dispose(); mount(); });
    ok('Reopening the real view preserves the pending receipt without submitting again', imports.length === 2 && await page.getByRole('button', { name: '核实上次结果', exact: true }).isVisible() && await recover().isDisabled());
    await page.getByRole('button', { name: '核实上次结果', exact: true }).click(); await idle();
    ok('A still-absent copy stays unknown; checking sends no write', imports.length === 2 && await page.evaluate(() => controller.snapshot().phase === 'unknown'));
    chats.get(pendingImport.avatar).set(pendingImport.name, pendingImport.raw);
    await page.getByRole('button', { name: '核实上次结果', exact: true }).click(); await page.waitForFunction(() => controller.snapshot().phase === 'verified');
    const second = await page.evaluate(() => controller.snapshot());
    ok('The late native write is resolved by listing and full export of the original operation', imports.length === 2 && second.result.fileName === pendingImport.name && calls.at(-1) === '/api/chats/export');
    const secondRows = chats.get('role.png').get(second.result.fileName).split('\n').map(line => JSON.parse(line));
    secondRows[0].chat_metadata.integrity = originalRows[0].chat_metadata.integrity; assert.deepEqual(secondRows, originalRows);
    ok('Original backup and both existing chats remain byte-identical, with no extra destination changes', backups.get(backupName) === originalBackup && chats.get('role.png').get('原聊天.jsonl') === originalChat && chats.get('other.png').get('其他原聊天.jsonl') === originalChat && chats.get('role.png').size === 3 && chats.get('other.png').size === 1);
    ok('Only the documented native read routes and explicit native import were used', calls.every(path => [listPath, '/api/backups/chat/download', '/api/characters/chats', '/api/chats/import', '/api/chats/export'].includes(path)));
    ok('No external requests or page errors occurred', external.length === 0 && errors.length === 0);
    console.log(JSON.stringify({ passed: checks.length, checks, imports: imports.length, nativeContract: 'ST 1.19 synthetic APIs', transport: fastList ? 'BaiBai fast-list wrapper contract' : 'native fetch', actualController: true, actualView: true, realST: false, externalNetwork: false, persistentProfile: false, errors }));
} finally { await browser.close(); }
