// Actual recovery view, synthetic controller only; no ST, account or file access.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
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
        document.body.innerHTML = '<div id="story-director-floor-nav" style="inset:0"><div class="sd-floor-shell"><div class="sd-floor-panel"><section class="sd-floor-view" data-floor-view="recovery"></section></div></div></div>';
        const root = document.querySelector('[data-floor-view]');
        window.calls = { load: 0, preview: 0, recover: 0, verify: 0 };
        window.state = { phase: 'idle', busy: false, error: '', backups: [], preview: null, result: null };
        const backups = Array.from({ length: 12 }, (_, i) => ({ name: `backup-${i}.jsonl`, messageCount: i + 1, size: '12 KB', excerpt: '<img src=x onerror="window.injected=true">' }));
        window.controller = {
            snapshot: () => state,
            load: async () => { calls.load++; state.phase = 'ready'; state.backups = backups; view.render(); },
            preview: async name => { calls.preview++; state.preview = { name, messageCount: 13, text: '<script>window.injected=true</script>\n正文预览\n'.repeat(40), canRecover: true }; state.result = null; view.render(); },
            recover: async avatar => { calls.recover++; state.result = { status: 'verified', target: { avatar, name: '合成角色' }, fileName: 'synthetic-recovered.jsonl', messageCount: 13 }; view.render(); },
            verify: async () => { calls.verify++; state.result.status = 'verified'; view.render(); },
        };
        window.confirmation = true;
        window.mount = () => {
            window.view = mountChatRecoveryView({ root, controller, getCharacters: () => [{ avatar: 'synthetic.png', name: '合成角色 <b>纯文字</b>' }],
                confirm: async () => typeof confirmation === 'boolean' ? confirmation : await confirmation,
                notify: message => { window.notice = message; } });
        };
        mount();
    });
    ok('Opening recovery does not load backups or start a write', await page.evaluate(() => Object.values(calls).every(value => value === 0)));
    await page.getByRole('button', { name: '加载备份', exact: true }).click();
    ok('Ten candidates per page', await page.locator('.qm-recovery-item').count() === 10);
    ok('Untrusted excerpts are text, not markup', await page.evaluate(() => !document.querySelector('.qm-recovery-list img') && !window.injected));
    await page.getByRole('button', { name: '下一页', exact: true }).click();
    ok('Remaining page has two candidates', await page.locator('.qm-recovery-item').count() === 2);
    await page.getByRole('searchbox').fill('backup-11');
    ok('Search resets pagination and filters without reads', await page.locator('.qm-recovery-item').count() === 1 && await page.evaluate(() => calls.load === 1));
    await page.locator('.qm-recovery-item').click();
    ok('Preview is literal text and target is explicitly required', await page.evaluate(() => !document.querySelector('.qm-recovery-preview script') && !window.injected)
        && await page.getByRole('button', { name: '另建找回副本', exact: true }).isDisabled());
    await page.getByRole('combobox').selectOption('synthetic.png');
    await page.evaluate(() => { confirmation = new Promise(resolve => { window.resolveConfirmation = resolve; }); });
    await page.getByRole('button', { name: '另建找回副本', exact: true }).click();
    await page.evaluate(async () => { await controller.preview('different.jsonl'); resolveConfirmation(true); });
    await page.waitForTimeout(20);
    ok('Changing preview during confirmation cannot save the replacement', await page.evaluate(() => calls.recover === 0));
    await page.evaluate(() => { confirmation = true; });
    await page.getByRole('button', { name: '另建找回副本', exact: true }).click();
    ok('Verified result names the new file and prevents duplicate submission', await page.getByText(/synthetic-recovered.jsonl/).isVisible()
        && await page.getByRole('button', { name: '另建找回副本', exact: true }).isDisabled());
    await page.evaluate(() => { state.result.status = 'unknown'; view.render(); });
    ok('Unknown write offers verification instead of another import', await page.getByRole('button', { name: '核实上次结果', exact: true }).isVisible()
        && await page.getByRole('button', { name: '另建找回副本', exact: true }).isDisabled());
    await page.getByRole('button', { name: '核实上次结果', exact: true }).click();
    ok('Verification is read-only at the UI contract', await page.evaluate(() => calls.verify === 1 && calls.recover === 1));
    for (const width of [320, 393, 1280]) {
        await page.setViewportSize({ width, height: 520 });
        ok(`No horizontal overflow at ${width}px`, await page.evaluate(() => {
            const panel = document.querySelector('.sd-floor-panel'); return panel.scrollWidth <= panel.clientWidth + 1 && panel.getBoundingClientRect().right <= innerWidth;
        }));
    }
    await page.evaluate(() => { view.dispose(); controller.load(); mount(); });
    ok('Closing/reopening keeps the receipt without repeating a restore', await page.evaluate(() => calls.recover === 1)
        && await page.getByText(/synthetic-recovered.jsonl/).isVisible());
    ok('No external network or page errors', external.length === 0 && errors.length === 0);
    console.log(JSON.stringify({ passed: checks.length, checks, realST: false, externalNetwork: false, errors }));
} finally { await browser.close(); }
