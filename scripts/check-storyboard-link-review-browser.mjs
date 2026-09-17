import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { storyboardFunctionSource } from '../tests/helpers/storyboard-form-fixture.mjs';
import { installStoryboardLinkReviewFixture } from '../tests/helpers/storyboard-link-review-browser.mjs';
const require = createRequire(import.meta.url), { chromium } = require(process.env.QIANMU_PLAYWRIGHT_MODULE || 'playwright');
const browser = await chromium.launch({ channel: process.env.QIANMU_BROWSER_CHANNEL || undefined, headless: true });
const context = await browser.newContext(), page = await context.newPage(), checks = [], failures = [], errors = [];
let external = 0;
page.setDefaultTimeout(5000); page.on('pageerror', error => errors.push(error.message));
const deadline = setTimeout(() => { void browser.close(); }, 180000);
await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin === 'https://qianmu.test') {
        if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><html lang="zh-CN"><meta name="viewport" content="width=device-width,initial-scale=1"><body></body></html>' });
        if (/^\/qianmu-[a-z0-9-]+\.js$/.test(url.pathname)) return route.fulfill({ contentType: 'text/javascript', body: await readFile(new URL('..' + url.pathname, import.meta.url), 'utf8') });
    }
    external++; return route.abort();
});
const action = name => page.locator(`[data-link-action="${name}"]`);
const ready = options => page.evaluate(options => setup(options), options);
const select = async (floor = 26) => { await action('next').click(); await page.locator(`[data-link-floor="${floor}"]`).click(); await page.locator('[data-link-paragraph="1"]').check(); };
const idle = () => page.waitForFunction(() => !dialog.querySelector('fieldset')?.disabled);
const apply = async () => { await action('confirm').click(); await idle(); };
async function check(name, run) { try { await run(); checks.push(name); } catch (error) { failures.push({ name, error: error.message }); } }
try {
    await page.goto('https://qianmu.test/');
    await page.addStyleTag({ content: await readFile(new URL('../style.css', import.meta.url), 'utf8') });
    await page.addStyleTag({ content: await readFile(new URL('../qianmu-theme-skins.css', import.meta.url), 'utf8') });
    await page.evaluate(installStoryboardLinkReviewFixture, { hostSource: storyboardFunctionSource('storyboardPackageContext') + '\n' + storyboardFunctionSource('storyboardReviewRecordLink') });
    await check('only assistant floors are offered, 28 rows paginate, HTML stays text and nothing is selected by default', async () => {
        await ready(); assert.equal(await page.locator('[data-link-floor]').count(), 24); assert.equal(await page.locator('[data-link-floor="0"], [data-link-floor="1"], dialog img').count(), 0);
        assert.equal(await action('confirm').isDisabled(), true); await action('next').click(); assert.equal(await page.locator('[data-link-floor]').count(), 4);
        await page.locator('[data-link-floor="29"]').click(); assert.equal(await page.locator('[data-link-paragraph]').count(), 24);
        assert.equal(await page.locator('input:checked').count(), 0); await action('next').click(); assert.equal(await page.locator('[data-link-paragraph]').count(), 4);
        assert.equal(await page.evaluate(() => fixture.applies + fixture.writes), 0);
    });
    await check('floor navigation restores its original page, row focus and scroll instead of returning to the start', async () => {
        await ready(); await action('next').click(); const row = page.locator('[data-link-floor="28"]'); await row.scrollIntoViewIfNeeded();
        const top = await page.locator('dialog main').evaluate(node => node.scrollTop); await row.click();
        assert.equal(await page.locator('[data-link-paragraph="0"]').evaluate(node => node === document.activeElement), true);
        await action('floors').click(); assert.equal(await page.locator('[data-link-floor="28"]').count(), 1);
        assert.equal(await page.locator('[data-link-floor="28"]').evaluate(node => node === document.activeElement), true);
        assert.equal(await page.locator('dialog main').evaluate(node => node.scrollTop), top);
    });
    await check('paragraph choice preserves radio focus and scroll; off-page choices remain explicit and a new floor resets them', async () => {
        await ready(); await select(); const radio = page.locator('[data-link-paragraph="2"]'); await radio.scrollIntoViewIfNeeded();
        const top = await page.locator('dialog main').evaluate(node => node.scrollTop); await radio.check();
        assert.equal(await radio.evaluate(node => node === document.activeElement), true); assert.equal(await page.locator('dialog main').evaluate(node => node.scrollTop), top);
        await action('next').click(); assert.equal(await action('confirm').isDisabled(), false); assert.match(await page.locator('[role=status]').innerText(), /第 27 层、第 3 段/);
        await action('previous').click(); assert.equal(await radio.isChecked(), true); await action('floors').click();
        await page.locator('[data-link-floor]').first().click(); assert.equal(await action('confirm').isDisabled(), true); assert.equal(await page.locator('input:checked').count(), 0);
    });
    for (const change of ['text', 'swipe']) await check(`changed ${change} recovers selectable floors and revokes confirmation before invoking apply`, async () => {
        await ready(); await select(); await page.evaluate(change => { if (change === 'text') fixture.messages[26].mes = '已修改正文\n重新选择'; else fixture.messages[26].swipe_id++; }, change);
        await action('confirm').click(); await idle(); assert.equal(await page.evaluate(() => fixture.applies), 0);
        assert.equal(await page.locator('[data-link-floor="26"]').count(), 1); assert.match(await page.locator('[role=status]').innerText(), /重新选层/);
        assert.equal(await action('confirm').isDisabled(), true); await page.locator('[data-link-floor="26"]').click();
        await page.locator('[data-link-paragraph="0"]').check(); await apply(); assert.equal(await page.evaluate(() => fixture.writes), 1);
    });
    await check('confirm writes once after a reversible receipt and changes only display links, not source recipes or other records', async () => {
        await ready(); await select(); await apply(); const f = await page.evaluate(() => ({ store: fixture.store, original: fixture.original, events: fixture.events, receipt: fixture.receipt, phase: fixture.phase }));
        assert.deepEqual(f.events, ['receipt', 'save-start', 'save', 'applied']); assert.equal(f.phase, 'applied'); assert.equal(f.receipt.patch.length, 1);
        assert.deepEqual(f.store.storyboardImages[1], f.original.storyboardImages[1]);
        for (const key of ['recipe', 'snapshot', 'url']) assert.deepEqual(f.store.storyboardImages[0][key], f.original.storyboardImages[0][key]);
        assert.equal(f.store.storyboardImages[0].floor, 26); assert.equal(f.store.storyboardImages[0].paragraphAnchor.paragraphIndex, 1);
        assert.deepEqual(f.store.storyboardImages[0].restoreLinkHistory[0].review, f.original.storyboardImages[0].restoreLinkReview);
        assert.equal(await action('confirm').count(), 0); assert.match(await page.locator('[role=status]').innerText(), /已应用/);
        await page.locator('footer [data-link-action="close"]').click(); await page.evaluate(() => fixture.run);
        assert.equal(await page.evaluate(() => fixture.rendered), 1); assert.equal(await page.evaluate(() => fixture.writes), 1);
    });
    await check('Escape cancels without writing or rebuilding the underlying page, returns focus and releases ownership', async () => {
        await ready(); await select(); await page.keyboard.press('Escape'); await page.evaluate(() => fixture.run);
        assert.equal(await page.evaluate(() => fixture.writes + fixture.applies + fixture.rendered), 0);
        assert.equal(await page.locator('#opener').evaluate(node => node === document.activeElement), true);
        assert.deepEqual(await page.evaluate(() => [fixture.closed, fixture.released, fixture.transfer.busy]), [1, 1, false]);
    });
    await check('detached dialog refuses queued confirmation instead of calling the host or keeping ownership open', async () => {
        await ready(); await select(); await page.evaluate(() => { dialog.remove(); dialog.querySelector('[data-link-action=confirm]').click(); });
        await page.waitForFunction(() => !fixture.transfer.busy); assert.equal(await page.evaluate(() => fixture.applies + fixture.writes), 0);
    });
    for (const stage of ['receipt', 'save', 'applied']) await check(`close during ${stage} retains the owner until pending work settles and never schedules into a closed view`, async () => {
        await ready(); await select(); await page.evaluate(stage => { fixture.hold = stage; }, stage); await action('confirm').click(); await page.waitForFunction(() => !!fixture.release);
        await action('close').click(); assert.deepEqual(await page.evaluate(() => [fixture.closed, fixture.released, fixture.transfer.busy, Boolean(fixture.finished)]), [0, 0, true, false]);
        await page.evaluate(async () => { fixture.release(); await fixture.run; });
        assert.equal(await page.evaluate(() => fixture.writes), stage === 'receipt' ? 0 : 1); assert.equal(await page.evaluate(() => fixture.scheduled + fixture.rendered), 0);
        assert.deepEqual(await page.evaluate(() => [fixture.closed, fixture.released, fixture.transfer.busy]), [1, 1, false]);
        assert.equal(await page.locator('dialog').count(), 0); assert.ok(await page.evaluate(() => !!fixture.receipt));
    });
    for (const change of ['text', 'chat', 'account', 'owner']) await check(`changed ${change} during final receipt does not claim insertion or refresh a different context`, async () => {
        await ready(); await select(); await page.evaluate(() => { fixture.hold = 'applied'; }); await action('confirm').click(); await page.waitForFunction(() => !!fixture.release);
        await page.evaluate(change => { if (change === 'text') fixture.messages[26].mes = '新正文'; if (change === 'chat') fixture.chatKey = 'other-chat'; if (change === 'account') fixture.namespace = 'st-user:other'; if (change === 'owner') fixture.live = false; fixture.release(); }, change);
        await idle(); assert.equal(await page.evaluate(() => fixture.scheduled), 0); assert.match(await page.locator('[role=status]').innerText(), /未确认/);
        assert.equal(await page.evaluate(() => fixture.writes), 1); assert.equal(await action('confirm').isDisabled(), true);
        await action('close').first().click(); await page.evaluate(() => fixture.run); assert.equal(await page.evaluate(() => fixture.rendered), 0);
    });
    for (const stage of ['before', 'after']) await check(`${stage} persistence failure retains the original receipt and never retries automatically`, async () => {
        await ready(); await select(); await page.evaluate(stage => { fixture.saveFail = stage; }, stage); await apply();
        assert.match(await page.locator('[role=status]').innerText(), /未确认/); assert.equal(await action('confirm').isDisabled(), true);
        assert.equal(await page.evaluate(() => fixture.phase), 'uncertain'); assert.equal(await page.evaluate(() => fixture.applies), 1);
        assert.equal(await page.evaluate(() => fixture.writes), stage === 'before' ? 0 : 1); assert.ok(await page.evaluate(() => fixture.receipt.patch[0].before.value[0].restoreLinkReview));
    });
    for (const reason of ['lock', 'pending', 'jobs', 'image']) await check(`${reason} prevents mutation without discarding the original image`, async () => {
        await ready(); await select(); await page.evaluate(async reason => {
            if (reason === 'lock') await new Promise(resolve => { void navigator.locks.request('qianmu:package-import:st-user:test', async () => { resolve(); await new Promise(done => { fixture.releaseLock = done; }); }); });
            if (reason === 'pending') fixture.pending = true; if (reason === 'jobs') fixture.jobs.add('active'); if (reason === 'image') fixture.store.storyboardImages[0].tags = ['changed'];
        }, reason);
        try { await apply(); assert.equal(await page.evaluate(() => fixture.writes), 0); assert.equal(await page.evaluate(() => fixture.store.storyboardImages[0].inline), false); assert.equal(await action('confirm').isDisabled(), true); }
        finally { await page.evaluate(() => fixture.releaseLock?.()); }
    });
    await check('pagehide while saving releases only after the pending save, with no new view or callback', async () => {
        await ready(); await select(); await page.evaluate(() => { fixture.hold = 'save'; }); await action('confirm').click(); await page.waitForFunction(() => !!fixture.release);
        await page.evaluate(() => window.dispatchEvent(new Event('pagehide'))); assert.equal(await page.locator('dialog').count(), 0);
        assert.equal(await page.evaluate(() => fixture.transfer.busy), true); await page.evaluate(async () => { fixture.release(); await fixture.run; });
        assert.equal(await page.evaluate(() => fixture.scheduled + fixture.rendered), 0); assert.equal(await page.evaluate(() => fixture.writes), 1);
    });
    await check('busy confirmation ignores duplicate events and preserves the pending operation through theme switching', async () => {
        await ready(); await select(); await page.evaluate(() => { fixture.hold = 'save'; }); await action('confirm').click(); await page.waitForFunction(() => !!fixture.release);
        await page.evaluate(async () => { dialog.querySelector('[data-link-action=confirm]').dispatchEvent(new MouseEvent('click', { bubbles: true })); await fixture.setAppearance({ family: 'editorial', mode: 'dark', accent: '#537a6b' }); });
        assert.equal(await page.evaluate(() => fixture.applies), 1); assert.equal(await action('confirm').isDisabled(), true);
        await page.evaluate(() => fixture.release()); await idle(); assert.equal(await page.evaluate(() => fixture.writes), 1); assert.match(await page.locator('[role=status]').innerText(), /已应用/);
    });
    await check('removal while saving settles the owner without requiring another DOM event or updating a new dialog', async () => {
        await ready(); await select(); await page.evaluate(() => { fixture.hold = 'save'; }); await action('confirm').click(); await page.waitForFunction(() => !!fixture.release);
        await page.evaluate(async () => { window.oldDialog = dialog; window.oldFixture = fixture; dialog.remove(); fixture.release(); await fixture.run; });
        assert.equal(await page.evaluate(() => fixture.scheduled + fixture.rendered), 0); assert.equal(await page.evaluate(() => fixture.transfer.busy), false);
        await ready(); const html = await page.locator('dialog').innerHTML(); await page.evaluate(() => oldDialog.querySelector('[data-link-action=confirm]').dispatchEvent(new MouseEvent('click', { bubbles: true })));
        assert.equal(await page.locator('dialog').innerHTML(), html); assert.equal(await page.evaluate(() => oldFixture.applies), 1);
    });
    await check('leaving after a confirmed save retains success but closing its result never redraws a different chat', async () => {
        await ready(); await select(); await apply(); await page.evaluate(() => { fixture.chatKey = 'other-chat'; });
        assert.match(await page.locator('[role=status]').innerText(), /已应用/); await action('close').first().click(); await page.evaluate(() => fixture.run);
        assert.equal(await page.evaluate(() => fixture.writes), 1); assert.equal(await page.evaluate(() => fixture.rendered), 0); assert.deepEqual(await page.evaluate(() => fixture.notices), []);
    });
    await check('empty assistant inventory remains a non-writing, closable state', async () => {
        await ready({ empty: true }); assert.match(await page.locator('dialog main').innerText(), /暂无可选择正文/); assert.equal(await action('confirm').isDisabled(), true);
        await action('close').first().click(); await page.evaluate(() => fixture.run); assert.equal(await page.evaluate(() => fixture.writes), 0);
    });
    for (const width of [320, 393, 1280]) for (const family of ['classic', 'editorial', 'glass']) for (const mode of family === 'classic' ? ['light'] : ['light', 'dark']) await check(`${width}/${family}/${mode}: real floor/paragraph flow fits and retains selection during live theme changes`, async () => {
        await page.setViewportSize({ width, height: width === 320 ? 568 : 900 }); await ready({ family, mode }); await select();
        const geometry = await page.evaluate(() => { const box = dialog.getBoundingClientRect(), main = dialog.querySelector('main'); return { left: box.left, right: box.right, bottom: box.bottom, overflow: main.scrollWidth - main.clientWidth, radius: getComputedStyle(dialog).borderRadius, footer: dialog.querySelector('footer').getBoundingClientRect().bottom }; });
        assert.ok(geometry.left >= 0 && geometry.right <= width + 1 && geometry.bottom <= page.viewportSize().height + 1 && geometry.footer <= geometry.bottom + 1, JSON.stringify(geometry));
        assert.ok(geometry.overflow <= 1); if (family === 'editorial') assert.equal(geometry.radius, '0px');
        const retained = await page.evaluate(async () => { const radio = dialog.querySelector('[data-link-paragraph="1"]'), scroll = dialog.querySelector('main').scrollTop; radio.focus({ preventScroll: true }); await fixture.setAppearance({ family: 'glass', mode: 'dark', accent: '#537a6b' }); return radio === document.activeElement && radio.checked && radio.isConnected && scroll === dialog.querySelector('main').scrollTop; });
        assert.equal(retained, true); assert.equal(await page.evaluate(() => fixture.applies + fixture.writes), 0);
    });
    await check('no browser exceptions or external data/media requests', async () => { assert.deepEqual(errors, []); assert.equal(external, 0); });
    console.log(JSON.stringify({ passed: checks.length, checks, failures, errors, external, productionDataRead: false, scope: 'actual host/view/model/account guard/mutation and native locks; memory-only ST persistence/journal, not physical-device acceptance' }));
    if (failures.length) process.exitCode = 1;
} finally { clearTimeout(deadline); await context.close(); await browser.close(); }
