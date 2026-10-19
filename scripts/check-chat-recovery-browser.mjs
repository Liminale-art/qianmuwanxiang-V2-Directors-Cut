// Actual recovery view, synthetic controller only; no ST, account or file access.
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.QIANMU_PLAYWRIGHT_MODULE || 'playwright');
const browser = await chromium.launch({ channel: process.env.QIANMU_BROWSER_CHANNEL || undefined, headless: true });
const context = await browser.newContext(), page = await context.newPage();
const errors = [], external = [], checks = [];
const ok = (label, value) => { assert.ok(value, label); checks.push(label); };
page.on('pageerror', error => errors.push(error.message));
await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin === 'https://recovery-fixture.test' && url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><body></body>' });
    if (url.origin === 'https://recovery-fixture.test' && /^\/qianmu-[a-z0-9-]+\.(?:js|css)$/.test(url.pathname)) return route.fulfill({ contentType: url.pathname.endsWith('.css') ? 'text/css' : 'text/javascript', body: await readFile(new URL('..' + url.pathname, import.meta.url)) });
    external.push(url.href); return route.abort();
});
try {
    await page.goto('https://recovery-fixture.test/');
    for (const file of ['style.css', 'qianmu-theme-skins.css']) await page.addStyleTag({ content: await readFile(new URL('../' + file, import.meta.url), 'utf8') });
    await page.evaluate(async () => {
        const { mountChatRecoveryView } = await import('/qianmu-chat-recovery-view.js');
        const { buildNativeBackupCatalog } = await import('/qianmu-chat-backup-catalog.js');
        document.body.innerHTML = '<div id="story-director-floor-nav" style="inset:0"><div class="sd-floor-shell"><div class="sd-floor-panel"><section class="sd-floor-view" data-floor-view="recovery"></section></div></div></div>';
        const root = document.querySelector('[data-floor-view]');
        window.calls = { load: 0, preview: 0, recover: 0, verify: 0, inspect: 0, configure: 0 };
        window.state = { phase: 'idle', busy: false, error: '', backups: [], preview: null, result: null,
            automaticBackup: { availability: 'unknown', busy: false, error: '', status: null } };
        window.characters = [{ avatar: 'synthetic.png', name: '合成角色 <b>纯文字</b>' }, { avatar: 'duplicate.png', name: '合成角色 <b>纯文字</b>' }, { avatar: 'other.png', name: '另一角色' }];
        const backups = Array.from({ length: 12 }, (_, i) => ({ name: `backup-${i}.jsonl`, messageCount: i + 1, size: '12 KB', excerpt: '<img src=x onerror="window.injected=true">',
            match: 'candidate', candidateAvatars: ['synthetic.png'], backupDay: '2026-10-19', backupTimeLabel: `2026-10-19 ${String(i).padStart(2,'0')}:00:00`, backupSort: i, timeZoneLabel: '服务器时间', source: 'native', sourceLabel: 'ST备份' }));
        // Use production invalid-date output: its nonempty "未知日期" label must
        // not accidentally sort above valid calendar dates.
        backups.push(...await buildNativeBackupCatalog([{ name: 'chat_unknown_20260230-120000.jsonl', messageCount: 5 }], characters));
        backups.push({ name: 'ambiguous.jsonl', messageCount: 3, match: 'ambiguous', candidateAvatars: ['other.png', 'duplicate.png'], backupDay: '2026-10-18', backupTimeLabel: '2026-10-18 12:30:00', backupSort: 5, timeZoneLabel: '服务器时间' });
        backups.push({ name: 'qianmu:deleted-role', messageCount: 4, match: 'candidate', candidateAvatars: ['deleted.png'], backupDay: '2026-10-19', backupTimeLabel: '2026-10-19 10:00:00', backupSort: 10, timeZoneLabel: '本机时间', source: 'qianmu', sourceLabel: '千幕备份' });
        window.autoMode = 'available'; window.previewRevision = 0;
        window.controller = {
            snapshot: () => state,
            load: async () => { calls.load++; state.phase = 'ready'; state.backups = backups; view.render(); },
            preview: async name => { calls.preview++; state.preview = { name, revision: ++previewRevision, messageCount: 13, text: '<script>window.injected=true</script>\n正文预览\n'.repeat(40), canRecover: true }; state.result = null; view.render(); },
            recover: async avatar => { calls.recover++; state.result = { status: 'verified', target: { avatar, name: '合成角色' }, fileName: 'synthetic-recovered.jsonl', messageCount: 13 }; view.render(); },
            verify: async () => { calls.verify++; state.result.status = 'verified'; view.render(); },
            inspectAutomaticBackup: async () => {
                if (autoMode === 'lost') throw new Error('synthetic status temporarily unavailable');
                calls.inspect++; state.automaticBackup.availability = autoMode;
                state.automaticBackup.status ||= { enabled: false, intervalMinutes: 30, limitMiB: 1024, usedBytes: 1024, lastRunAt: null, lastSuccessAt: null, nextRunAt: null, lastResult: null };
                state.automaticBackup.error = ''; state.automaticBackup.configurationUnknown = false; view.render();
            },
            configureAutomaticBackup: async draft => {
                calls.configure++; window.lastConfig = draft; state.automaticBackup.configurationUnknown = true; Object.assign(state.automaticBackup.status, draft);
                if (autoMode === 'lost') { state.automaticBackup.error = 'response lost'; throw new Error('设置结果未确认'); }
                state.automaticBackup.configurationUnknown = false;
                view.render();
            },
        };
        window.confirmation = true;
        window.mount = () => { window.view = mountChatRecoveryView({ root, controller, getCharacters: () => characters,
            confirm: async message => { window.lastConfirmation = message; return typeof confirmation === 'boolean' ? confirmation : await confirmation; },
            notify: message => { window.notice = message; } }); };
        mount();
    });
    const role = page.getByRole('combobox', { name: '选择要找回的角色', exact: true });
    const search = page.getByRole('searchbox', { name: '搜索角色名', exact: true });
    const recover = page.getByRole('button', { name: '另建找回副本', exact: true });
    const chooseOther = () => role.selectOption('__qianmu_other_backups__');
    ok('Opening performs no reads, writes or automatic-service probing', await page.evaluate(() => Object.values(calls).every(value => value === 0)));
    ok('Load requires a role or unmatched selection; backups are not dumped initially', await page.getByRole('button', { name: '读取备份', exact: true }).isDisabled() && await page.locator('.qm-recovery-item').count() === 0);
    await search.fill('合成角色');
    await page.waitForFunction(() => ![...document.querySelector('.qm-recovery-character-select').options].some(option => option.textContent.includes('另一角色')));
    ok('Search uses role names and duplicate names include avatar identity', await role.locator('option').allTextContents().then(rows => rows.some(text => text.includes('synthetic.png')) && rows.some(text => text.includes('duplicate.png')) && rows.every(text => !text.includes('另一角色'))));
    await role.selectOption('synthetic.png'); await page.getByRole('button', { name: '读取备份', exact: true }).click();
    ok('Ten selected-role candidates per page', await page.locator('.qm-recovery-item').count() === 10);
    ok('Date groups and descending times are primary; filenames are secondary only', await page.locator('.qm-recovery-day').textContent() === '2026-10-19 · 服务器时间'
        && await page.locator('.qm-recovery-item').first().getAttribute('title') === 'backup-11.jsonl' && !(await page.locator('.qm-recovery-item').first().innerText()).includes('backup-11'));
    ok('Untrusted excerpts and role names remain plain text', await page.evaluate(() => !document.querySelector('.qm-recovery-list img,.qm-recovery-character-select b') && !window.injected));
    await page.getByRole('button', { name: '下一页', exact: true }).click();
    ok('Remaining page has two candidates', await page.locator('.qm-recovery-item').count() === 2);
    await page.locator('.qm-recovery-item').first().click();
    ok('Preview is literal text and explicitly chosen role is fixed as destination', await page.evaluate(() => !document.querySelector('.qm-recovery-preview script') && !window.injected)
        && await page.locator('.qm-recovery-target-fixed').isVisible() && !await recover.isDisabled()
        && !await page.getByRole('combobox', { name: '找回副本的目标角色', exact: true }).isVisible());
    await page.evaluate(() => { confirmation = new Promise(resolve => { window.resolveConfirmation = resolve; }); });
    await recover.click(); await role.selectOption('duplicate.png'); await role.selectOption('synthetic.png');
    await page.evaluate(() => resolveConfirmation(true));
    ok('Changing role away and back invalidates confirmation and hides stale preview', await page.evaluate(() => calls.recover === 0) && !await page.locator('.qm-recovery-preview').isVisible());
    await page.locator('.qm-recovery-item').first().click();
    await page.evaluate(() => { confirmation = new Promise(resolve => { window.resolveConfirmation = resolve; }); }); await recover.click();
    await page.locator('.qm-recovery-item').first().click(); await page.evaluate(() => resolveConfirmation(true));
    ok('Same-file preview revision invalidates old confirmation', await page.evaluate(() => calls.recover === 0));
    await search.fill('另一');
    ok('Changing role search clears stale preview without another read', !await page.locator('.qm-recovery-preview').isVisible() && await page.evaluate(() => calls.load === 1));
    await chooseOther();
    ok('Unmatched mode keeps ambiguous and unknown-time backups reachable, unknown time last', await page.locator('.qm-recovery-item').count() === 3
        && await page.locator('.qm-recovery-item').last().getAttribute('title') === 'chat_unknown_20260230-120000.jsonl'
        && await page.locator('.qm-recovery-day').last().textContent().then(text => text.includes('未知日期')));
    await page.locator('.qm-recovery-item[title="qianmu:deleted-role"]').click();
    ok('Automatic backup of a removed avatar remains reachable and requires a current target', await page.locator('.qm-recovery-preview').isVisible() && await recover.isDisabled());
    await page.locator('.qm-recovery-item').last().click();
    ok('Unmatched preview requires explicit destination', await recover.isDisabled() && await page.getByRole('combobox', { name: '找回副本的目标角色', exact: true }).isVisible());
    await page.getByRole('combobox', { name: '找回副本的目标角色', exact: true }).selectOption('synthetic.png');
    await page.evaluate(() => { confirmation = true; }); await recover.click();
    ok('Verified result identifies copy and stops accidental resubmission', await page.getByText(/synthetic-recovered.jsonl/).isVisible() && await recover.isDisabled());
    await page.evaluate(() => { state.result.status = 'unknown'; view.render(); });
    await search.fill(''); await role.selectOption('synthetic.png');
    ok('Role changes cannot hide pending receipt or bypass its write lock', await page.getByRole('button', { name: '核实上次结果', exact: true }).isVisible()
        && await page.locator('.qm-recovery-item').first().isDisabled() && await page.evaluate(() => calls.recover === 1));
    await page.getByRole('button', { name: '核实上次结果', exact: true }).click();
    ok('Verification stays read-only at the UI contract', await page.evaluate(() => calls.verify === 1 && calls.recover === 1));

    ok('Automatic backup is collapsed and not inspected on normal recovery reads', !await page.locator('.qm-recovery-auto').evaluate(node => node.open) && await page.evaluate(() => calls.inspect === 0));
    await page.locator('.qm-recovery-auto > summary').click();
    await page.waitForFunction(() => calls.inspect === 1);
    const automaticEnabled = page.getByRole('checkbox', { name: '启用自动备份', exact: true });
    const interval = page.getByRole('spinbutton', { name: '备份间隔（分钟）', exact: true });
    const capacity = page.getByRole('spinbutton', { name: '有效备份空间上限（MB）', exact: true });
    const versions = page.getByRole('spinbutton', { name: '每份聊天最多保留版本数', exact: true });
    const saveAuto = page.getByRole('button', { name: '保存设置', exact: true });
    ok('Automatic defaults and legacy status keep thirty minutes, 1024 MB and unlimited versions', !await automaticEnabled.isChecked() && await interval.inputValue() === '30' && await capacity.inputValue() === '1024' && await versions.inputValue() === '');
    await automaticEnabled.check(); await interval.fill('14'); await saveAuto.click();
    ok('Minimum fifteen minutes validates without a server write', await page.evaluate(() => calls.configure === 0 && notice.includes('15')));
    await interval.fill('15');
    for (const value of ['', '255', '10241', '512.5']) {
        await capacity.fill(value); await saveAuto.click();
        ok(`Invalid capacity ${JSON.stringify(value)} never becomes a configuration write`, await page.evaluate(() => calls.configure === 0 && notice.includes('256–10240')));
    }
    await capacity.fill('1536');
    for (const value of ['0', '-1', '1.5', '20001']) {
        await versions.fill(value); await saveAuto.click();
        ok(`Invalid version limit ${value} is not treated as unlimited`, await page.evaluate(() => calls.configure === 0 && notice.includes('1–20000')));
    }
    await versions.fill(''); await versions.pressSequentially('1e'); await saveAuto.click();
    ok('Incomplete numeric version input is rejected rather than converted from empty value to unlimited', await versions.evaluate(node => node.validity.badInput)
        && await page.evaluate(() => calls.configure === 0 && notice.includes('1–20000')));
    await versions.fill('8'); await page.getByRole('button', { name: '读取状态', exact: true }).click();
    ok('Ordinary status readback does not replace unsaved custom capacity or version drafts', await capacity.inputValue() === '1536' && await versions.inputValue() === '8');
    await versions.fill('');
    await page.evaluate(() => { confirmation = false; }); await saveAuto.click();
    ok('Cancelling automatic settings confirmation writes nothing', await page.evaluate(() => calls.configure === 0));
    await page.evaluate(() => { confirmation = new Promise(resolve => { window.resolveConfirmation = resolve; }); }); await saveAuto.click();
    await interval.fill('30'); await page.evaluate(() => resolveConfirmation(true));
    ok('Editing automatic draft while confirmation is open invalidates approval', await page.evaluate(() => calls.configure === 0));
    for (const [control, value] of [[capacity, '1792'], [versions, '5']]) {
        await page.evaluate(() => { confirmation = new Promise(resolve => { window.resolveConfirmation = resolve; }); }); await saveAuto.click();
        await control.fill(value); await page.evaluate(() => resolveConfirmation(true));
        ok(`Editing ${control === capacity ? 'capacity' : 'version limit'} invalidates its pending policy confirmation`, await page.evaluate(() => calls.configure === 0));
    }
    await capacity.fill('1536'); await versions.fill('');
    await page.evaluate(() => { confirmation = true; }); await saveAuto.click();
    ok('Settings accept a custom capacity and serialize blank versions as zero only', await page.evaluate(() => calls.configure === 1 && lastConfig.enabled && lastConfig.intervalMinutes === 30 && lastConfig.limitMiB === 1536 && lastConfig.maxVersionsPerChat === 0) && await saveAuto.isDisabled());
    ok('Enable confirmation explicitly includes custom MB and unlimited-version policy', await page.evaluate(() => lastConfirmation.includes('1536 MB') && lastConfirmation.includes('版本数不限') && lastConfirmation.includes('轮换')));
    await interval.fill('60'); await page.evaluate(() => { autoMode = 'lost'; }); await saveAuto.click();
    ok('Lost settings response locks resubmission and exposes readback action', await saveAuto.isDisabled() && await page.locator('.qm-recovery-auto-status').textContent().then(text => text.includes('尚未确认')));
    await page.evaluate(() => { view.dispose(); mount(); }); await page.locator('.qm-recovery-auto > summary').click();
    ok('Closing and reopening cannot clear unknown settings even if status readback fails', await saveAuto.isDisabled() && await interval.isDisabled()
        && await page.locator('.qm-recovery-auto-status').textContent().then(text => text.includes('尚未确认')) && await page.evaluate(() => calls.configure === 2));
    await page.evaluate(() => { autoMode = 'available'; }); await page.getByRole('button', { name: '读取状态', exact: true }).click();
    ok('Readback resolves settings without resending and uses authoritative values', await page.evaluate(() => calls.configure === 2) && await interval.inputValue() === '60' && !await interval.isDisabled());
    await capacity.fill('768'); await versions.fill('5'); await saveAuto.click();
    ok('A finite per-chat limit is submitted and lower-capacity confirmation explains rotation', await page.evaluate(() => calls.configure === 3 && lastConfig.limitMiB === 768 && lastConfig.maxVersionsPerChat === 5
        && lastConfirmation.includes('768 MB') && lastConfirmation.includes('5 个版本') && lastConfirmation.includes('下调上限')) && await versions.inputValue() === '5');
    await versions.fill('20000'); await capacity.fill('10240'); await page.evaluate(() => { confirmation = false; }); await saveAuto.click();
    ok('Upper bounds are valid drafts and cancellation does not apply them', await page.evaluate(() => calls.configure === 3 && lastConfirmation.includes('10240 MB') && lastConfirmation.includes('20000 个版本')));
    await automaticEnabled.uncheck(); await saveAuto.click();
    ok('Disable confirmation keeps existing copies and names the saved future policy', await page.evaluate(() => calls.configure === 3 && lastConfirmation.includes('已保存的备份仍保留') && lastConfirmation.includes('10240 MB') && lastConfirmation.includes('20000 个版本')));
    await page.evaluate(() => { autoMode = 'unavailable'; }); await page.getByRole('button', { name: '读取状态', exact: true }).click();
    await role.selectOption('synthetic.png');
    ok('Missing or old optional service disables settings but not native recovery', await interval.isDisabled() && await page.locator('.qm-recovery-auto-status').textContent().then(text => text.includes('增强服务')) && !await page.getByRole('button', { name: '刷新备份', exact: true }).isDisabled());
    for (const width of [320, 393, 1280]) for (const family of ['classic', 'editorial', 'glass']) {
        await page.setViewportSize({ width, height: 520 });
        await page.evaluate(family => { const root=document.getElementById('story-director-floor-nav'); if(family==='classic')root.removeAttribute('data-qm-theme'); else root.dataset.qmTheme=family; }, family);
        ok(`No horizontal overflow at ${width}px/${family}`, await page.evaluate(() => {
            const panel = document.querySelector('.sd-floor-panel'); return panel.scrollWidth <= panel.clientWidth + 1 && panel.getBoundingClientRect().right <= innerWidth;
        }));
        if (width === 393 && family === 'glass') {
            const qa = new URL('../dist/local-qa/chat-recovery-478/', import.meta.url); await mkdir(qa, { recursive: true });
            await page.locator('.qm-recovery-auto').scrollIntoViewIfNeeded();
            await page.screenshot({ path: fileURLToPath(new URL('automatic-mobile.png', qa)) });
            await page.locator('.qm-recovery-character-tools').scrollIntoViewIfNeeded();
            await page.screenshot({ path: fileURLToPath(new URL('candidates-mobile.png', qa)) });
        }
    }
    await page.evaluate(() => { state.result.status = 'unknown'; view.dispose(); delete controller.inspectAutomaticBackup; delete controller.configureAutomaticBackup; mount(); });
    ok('Closing and reopening keeps unresolved receipt without another restore', await page.evaluate(() => calls.recover === 1) && await page.getByRole('button', { name: '核实上次结果', exact: true }).isVisible());
    await page.locator('.qm-recovery-auto > summary').click();
    ok('Absent optional methods produce a clear unavailable state, not an exception', await page.locator('.qm-recovery-auto-status').textContent().then(text => text.includes('增强服务')));
    await page.evaluate(() => {
        view.dispose();
        characters = Array.from({ length: 10000 }, (_, index) => ({ avatar: `synthetic-${index}.png`, name: index < 2 ? '同名角色' : index === 9999 ? '末页秦铎' : `测试角色${index}` }));
        state.phase = 'ready'; state.error = ''; state.preview = null; state.result = null;
        state.backups = [
            { name: 'tail-role.jsonl', match: 'candidate', candidateAvatars: ['synthetic-9999.png'], backupDay: '2026-10-19', backupSort: 1, backupTimeLabel: '2026-10-19 12:00:00' },
            { name: 'unmatched-large-list.jsonl', match: 'unmatched', candidateAvatars: [], backupDay: '', backupSort: null },
        ];
        window.beforeLargeCalls = JSON.stringify(calls); mount();
    });
    ok('Ten thousand loaded roles render only fifty options plus controls, and hidden target stays unbuilt', await role.locator('option').count() === 52
        && await page.locator('select[aria-label="找回副本的目标角色"] option').count() === 1);
    await page.getByRole('button', { name: '加载更多角色', exact: true }).click();
    ok('Main role picker expands in bounded batches of fifty', await role.locator('option').count() === 102);
    await search.fill('末页秦铎'); await role.locator('option[value="synthetic-9999.png"]').waitFor({ state: 'attached' });
    await role.selectOption('synthetic-9999.png');
    ok('Global Chinese role search reaches the ten-thousandth role without backend reads', await role.inputValue() === 'synthetic-9999.png'
        && await page.evaluate(() => JSON.stringify(calls) === beforeLargeCalls) && await page.locator('.qm-recovery-item').count() === 1);
    await page.evaluate(() => {
        const select = document.querySelector('.qm-recovery-character-select'); window.selectedRoleOption = select.selectedOptions[0];
        window.optionCreations = 0; const original = document.createElement.bind(document);
        document.createElement = (...args) => { if (args[0] === 'option') optionCreations++; return original(...args); };
        for (let i = 0; i < 10; i++) view.render();
        document.createElement = original;
    });
    ok('Unrelated state renders neither rebuild options nor reset selected role and active query', await page.evaluate(() => optionCreations === 0
        && document.querySelector('.qm-recovery-character-select').selectedOptions[0] === selectedRoleOption)
        && await search.inputValue() === '末页秦铎' && await role.inputValue() === 'synthetic-9999.png');
    await search.fill(''); await page.waitForFunction(() => document.querySelector('.qm-recovery-character-select').options.length > 50);
    ok('Clearing search pins the selected far-tail role instead of losing it', await role.inputValue() === 'synthetic-9999.png' && await role.locator('option').count() === 53);
    ok('Duplicate names use avatar labels built from the full character index', await role.locator('option[value="synthetic-0.png"]').textContent().then(text => text.includes('同名角色') && text.includes('synthetic-0.png'))
        && await role.locator('option[value="synthetic-1.png"]').textContent().then(text => text.includes('同名角色') && text.includes('synthetic-1.png')));
    await page.getByRole('button', { name: '加载更多角色', exact: true }).click();
    ok('Loading another batch retains a selection outside the current batch', await role.inputValue() === 'synthetic-9999.png' && await role.locator('option').count() === 103);
    await chooseOther(); await page.locator('.qm-recovery-item').click();
    const destination = page.getByRole('combobox', { name: '找回副本的目标角色', exact: true });
    const destinationSearch = page.getByRole('searchbox', { name: '搜索目标角色名', exact: true });
    ok('Unmatched destination picker also starts with a fifty-role batch', await destination.locator('option').count() === 51 && await recover.isDisabled());
    await destinationSearch.fill('末页秦铎'); await destination.locator('option[value="synthetic-9999.png"]').waitFor({ state: 'attached' });
    await destination.selectOption('synthetic-9999.png');
    ok('Unmatched destination search reaches all loaded roles and preserves the preview', await destination.inputValue() === 'synthetic-9999.png' && await page.locator('.qm-recovery-preview').isVisible() && !await recover.isDisabled());
    await destinationSearch.fill(''); await page.waitForFunction(() => document.querySelector('select[aria-label="找回副本的目标角色"]').options.length > 50);
    await page.getByRole('button', { name: '加载更多目标角色', exact: true }).click();
    ok('Unmatched destination clear and next batch retain the explicitly selected tail role', await destination.inputValue() === 'synthetic-9999.png' && await destination.locator('option').count() === 102);
    await page.evaluate(() => { confirmation = new Promise(resolve => { window.resolveConfirmation = resolve; }); }); await recover.click();
    await destinationSearch.fill('同名角色'); await page.evaluate(() => resolveConfirmation(true));
    ok('Typing another target search invalidates an open recovery confirmation before debounce settles', await page.evaluate(() => calls.recover === 1));
    await page.setViewportSize({ width: 320, height: 520 });
    for (const family of ['classic', 'editorial', 'glass']) {
        await page.evaluate(family => { const root=document.getElementById('story-director-floor-nav'); if(family==='classic')root.removeAttribute('data-qm-theme');else root.dataset.qmTheme=family; }, family);
        ok(`Ten-thousand-role controls fit 320px/${family}`, await page.evaluate(() => { const panel=document.querySelector('.sd-floor-panel'); return panel.scrollWidth <= panel.clientWidth + 1; }));
    }
    await search.fill('未提交的旧搜索'); await page.evaluate(() => { view.dispose(); mount(); });
    await page.waitForTimeout(150);
    ok('Disposed search timer cannot overwrite a new view or selection', await search.inputValue() === '' && await role.inputValue() === '' && await role.locator('option').count() === 52);
    ok('No external network or page errors', external.length === 0 && errors.length === 0);
    console.log(JSON.stringify({ passed: checks.length, checks, realST: false, externalNetwork: false, errors }));
} finally { await browser.close(); }
