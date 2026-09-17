// Real export chooser and skins, synthetic metadata only. No ST, images or credentials.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)(process.env.QIANMU_PLAYWRIGHT_MODULE || 'playwright');
const browser = await chromium.launch({ channel: process.env.QIANMU_BROWSER_CHANNEL || undefined, headless: true });
const context = await browser.newContext(), errors = [], checks = []; let external = 0;
const timer = setTimeout(() => void browser.close(), 90000);
await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin === 'https://qianmu.test') {
        if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"><link rel="stylesheet" href="/qianmu-theme-skins.css"><div id="story-director-modal" class="open"><button id="export">导出</button></div>' });
        if (/^\/(?:qianmu-[a-z0-9-]+\.js|style\.css|qianmu-theme-skins\.css)$/.test(url.pathname)) return route.fulfill({ contentType: url.pathname.endsWith('.css') ? 'text/css' : 'application/javascript', body: await readFile(new URL('..' + url.pathname, import.meta.url)) });
    }
    external++; return route.abort();
});
try {
    const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message)); await page.goto('https://qianmu.test/');
    await page.evaluate(async () => {
        const { chooseStoryboardExportImages } = await import('/qianmu-storyboard-export-scope-view.js');
        const { createQianmuThemeSurfaceController } = await import('/qianmu-theme-surfaces.js');
        const parent = document.getElementById('story-director-modal');
        window.themes = createQianmuThemeSurfaceController(); window.themes.register(parent);
        window.records = Array.from({ length: 53 }, (_, i) => ({ id: `image-${i}`, floor: i % 5, createdAt: i, tags: ['<script>fixture</script>', '风景'], prompt: 'not displayed', url: '/not-requested.png' }));
        window.openFixture = mode => {
            window.result = undefined; window.guardCalls = 0;
            document.getElementById('export').focus();
            const task = chooseStoryboardExportImages({ parent, chatKey: 'same-' + 'x'.repeat(600), readRecords: () => window.records,
                guard: async () => { window.guardCalls++; if (mode === 'reject') throw Error('账户或聊天已变化'); if (mode === 'slow') await new Promise(resolve => window.releaseGuard = resolve); }, timeoutMs: mode === 'timeout' ? 100 : 15000,
                ...(mode === 'timeout' ? { guard: () => new Promise(resolve => window.releaseGuard = resolve) } : {}) });
            window.finished = task.then(result => { window.result = result; });
        };
        window.openFixture();
    });
    let dialog = page.locator('dialog');
    const click = action => dialog.locator(`[data-export-action="${action}"]`).click();
    assert.equal(await dialog.locator('[data-export-image]').count(), 24); assert.match(await dialog.innerText(), /已选 53 \/ 53/);
    assert.equal(await dialog.locator('img,script').count(), 0); checks.push('chooser shows 24 metadata rows, defaults to all and never loads preview images or markup');
    assert.match(await dialog.innerText(), /不是全部聊天备份/); checks.push('scope explains shared libraries and that the file is not an all-chat backup');
    await click('none'); assert.equal(await dialog.locator('[data-export-action="continue"]').isDisabled(), true);
    checks.push('accidentally empty selection cannot proceed');
    await dialog.locator('[data-export-image="1"]').check(); await click('next');
    assert.equal(await page.evaluate(() => document.activeElement.dataset.exportAction), 'next');
    await dialog.locator('[data-export-image="25"]').check();
    await click('next'); assert.equal(await dialog.locator('[data-export-image]').count(), 5);
    assert.equal(await page.evaluate(() => document.activeElement.dataset.exportAction), 'previous');
    checks.push('pagination redraw retains keyboard focus and switches to the available direction at the last page');
    await dialog.locator('[data-export-image="52"]').check();
    await click('previous'); assert.equal(await dialog.locator('[data-export-image="25"]').isChecked(), true);
    checks.push('checkbox selection persists across all three pages without ID collisions');
    for (const theme of [null, { theme: 'editorial', mode: 'light' }, { theme: 'editorial', mode: 'dark' }, { theme: 'glass', mode: 'light' }, { theme: 'glass', mode: 'dark' }]) for (const width of [320,393,1280]) {
        await page.evaluate(value => window.themes.setTheme(value), theme); await page.setViewportSize({ width, height: 800 });
        const metrics = await dialog.evaluate(node => { const main = node.querySelector('main'), rect = node.getBoundingClientRect(); return { left: rect.left, right: rect.right, over: main.scrollWidth > main.clientWidth + 1, scrollbar: getComputedStyle(main).scrollbarWidth }; });
        assert.ok(metrics.left >= 0 && metrics.right <= width && !metrics.over); assert.equal(metrics.scrollbar, 'none');
        checks.push(`${theme?.theme || 'classic'}/${theme?.mode || 'default'}/${width} long chat label wraps with functional hidden-bar scrolling`);
    }
    await click('continue'); await page.evaluate(() => window.finished);
    assert.deepEqual(await page.evaluate(() => window.result.read(window.records).map(row => row.id)), ['image-1','image-25','image-52']);
    assert.equal(await page.evaluate(() => window.guardCalls), 1); assert.equal(await page.locator('dialog').count(), 0);
    assert.equal(await page.evaluate(() => document.activeElement.id), 'export'); checks.push('continue guards once, returns exact selection and releases the dialog with focus restored');

    await page.evaluate(() => window.openFixture()); await page.keyboard.press('Escape'); await page.evaluate(() => window.finished);
    assert.equal(await page.evaluate(() => window.result), null); checks.push('Escape cancels rather than confirming default all selection');
    await page.evaluate(() => { window.openFixture(); const parent = document.getElementById('story-director-modal'); parent.classList.remove('open'); parent.classList.add('open'); });
    await page.evaluate(() => window.finished); assert.equal(await page.evaluate(() => window.result), null); checks.push('brief parent close/reopen cancels captured export permission');

    await page.evaluate(() => window.openFixture('reject')); dialog = page.locator('dialog'); await click('continue');
    await page.waitForFunction(() => document.querySelector('dialog [role="status"]').textContent.includes('已变化'));
    assert.equal(await page.evaluate(() => window.result === undefined), true); await click('cancel'); checks.push('changed account/chat never yields an export selection');
    await page.evaluate(() => { window.openFixture(); window.records[0].prompt = 'changed while choosing'; }); await click('continue');
    await page.waitForFunction(() => document.querySelector('dialog [role="status"]').textContent.includes('已变化')); await click('cancel');
    checks.push('record edits while chooser is open invalidate the snapshot instead of mixing old and new');

    await page.evaluate(() => window.openFixture('slow')); await click('continue'); assert.equal(await dialog.locator('[data-export-action="continue"]').isDisabled(), true);
    await click('cancel'); await page.evaluate(async () => { window.releaseGuard(); await window.finished; });
    assert.equal(await page.evaluate(() => window.result), null); assert.equal(await page.locator('dialog').count(), 0); checks.push('cancel during async account guard cannot return a late successful selection');
    await page.evaluate(() => window.openFixture('timeout')); await click('continue');
    await page.waitForFunction(() => document.querySelector('dialog [role="status"]').textContent.includes('超时'));
    await page.evaluate(() => window.releaseGuard()); assert.equal(await page.evaluate(() => window.result === undefined), true); await click('cancel');
    checks.push('timed-out guard unlocks cancellation and ignores late resolution');

    await page.evaluate(() => { window.records = []; window.openFixture(); }); assert.match(await dialog.innerText(), /没有静帧/);
    assert.equal(await dialog.locator('[data-export-action="continue"]').isDisabled(), false); await click('continue'); await page.evaluate(() => window.finished);
    assert.equal(await page.evaluate(() => window.result.count), 0); checks.push('empty chat explicitly allows its existing configuration/library-only backup');
    assert.deepEqual(errors, []); assert.equal(external, 0); console.log(JSON.stringify({ checks, pageErrors: errors, externalRequests: external, productionWrites: false }));
} finally { clearTimeout(timer); await context.close(); await browser.close(); }
