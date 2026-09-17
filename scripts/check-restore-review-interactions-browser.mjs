// Real dialog owners/renderers with isolated in-memory services, never ST data.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { installRestoreReviewFixture } from '../tests/helpers/restore-review-browser.mjs';
const require = createRequire(import.meta.url), { chromium } = require(process.env.QIANMU_PLAYWRIGHT_MODULE || 'playwright');
const browser = await chromium.launch({ channel: process.env.QIANMU_BROWSER_CHANNEL || undefined, headless: true });
const context = await browser.newContext(), page = await context.newPage(), checks = [], failures = [], errors = [];
let external = 0;
page.setDefaultTimeout(5000);
page.on('pageerror', error => errors.push(error.message));
const deadline = setTimeout(() => { void browser.close(); }, 180000);
await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin === 'https://qianmu.test') {
        if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><html lang="zh-CN"><meta name="viewport" content="width=device-width,initial-scale=1"><body></body></html>' });
        if (/^\/qianmu-[a-z0-9-]+\.js$/.test(url.pathname)) return route.fulfill({ contentType: 'text/javascript', body: await readFile(new URL('..' + url.pathname, import.meta.url), 'utf8') });
    }
    external++; return route.abort();
});
const action = key => page.locator(`[data-bundle-action="${key}"]`);
const idle = () => page.waitForFunction(() => dialog.isConnected && !dialog.querySelector('fieldset').disabled);
const ready = async options => { await page.evaluate(options => setup(options), options); await idle(); };
const click = async key => { await action(key).click(); await idle(); };
const callCount = action => page.evaluate(action => fixture.calls.filter(call => call.action === action).length, action);
const agree = async () => { for (const input of await page.locator('dialog .sd-bundle-review input[type=checkbox]:not(:disabled)').all()) await input.check(); };
async function check(name, run) {
    try { await run(); checks.push(name); }
    catch (error) { failures.push({ name, error: error.message, stack: error.stack?.split('\n').slice(0, 3).join('\n') }); }
}
try {
    await page.goto('https://qianmu.test/');
    for (const file of ['style.css', 'qianmu-theme-skins.css']) await page.addStyleTag({ content: await readFile(new URL('../' + file, import.meta.url), 'utf8') });
    await page.addStyleTag({ content: 'body{margin:0}#story-director-modal{display:block!important;position:relative!important;inset:auto!important;transform:none!important;width:100%;height:100dvh}' });
    await page.evaluate(installRestoreReviewFixture);
    await check('conflict paging, choice, mandatory recheck and explicit approvals gate restoration', async () => {
        await ready({ rich: true }); assert.equal(await action('restore').isDisabled(), true);
        assert.equal(await page.locator('[data-bundle-choice]').count(), 24);
        await click('next'); assert.equal(await page.locator('[data-bundle-choice="24"]').count(), 1);
        await page.locator('[data-bundle-choice="25"]').selectOption('incoming'); await idle();
        await click('previous'); await page.locator('[data-bundle-choice="0"]').selectOption('local'); await idle();
        assert.deepEqual(await page.evaluate(() => fixture.choices), { 'archive-25': 'incoming', 'archive-0': 'local' });
        await agree(); assert.equal(await action('restore').isDisabled(), true, 'consent cannot replace recheck');
        await click('preview'); assert.equal(await page.locator('.sd-bundle-review input:checked').count(), 0);
        await agree(); assert.equal(await action('restore').isEnabled(), true); assert.equal(await callCount('restore'), 0);
        assert.equal(await page.locator('dialog img,dialog b:has-text("备份.qianmu")').count(), 0, 'file name and service labels are escaped');
    });
    await check('checkbox rerender retains keyboard focus and unsent target query', async () => {
        await ready({ rich: true }); await page.locator('[data-bundle-target-for="0"]').click(); await idle();
        await page.locator('[data-bundle-target-query]').fill('未提交的角色名称');
        await page.locator('[data-bundle-environment]').check();
        assert.equal(await page.locator('[data-bundle-environment]').evaluate(node => node === document.activeElement), true, 'focused checkbox must survive redraw');
        assert.equal(await page.locator('[data-bundle-target-query]').inputValue(), '未提交的角色名称');
    });
    await check('CHAR and USER search, paging and target selection retain source identity and reset approval', async () => {
        await ready({ rich: true });
        for (const [index, category] of [[0, 'char'], [1, 'user']]) {
            await page.locator('[data-bundle-environment]').check();
            await page.locator(`[data-bundle-target-for="${index}"]`).click(); await idle();
            await page.locator('[data-bundle-target-query]').fill('对象'); await page.locator('[data-bundle-target-query]').press('Enter'); await idle();
            await click('targets-next'); assert.equal(await page.locator('[data-bundle-target-select]').count(), 2);
            await page.locator('[data-bundle-target-select="1"]').click(); await idle();
            assert.equal(await page.locator('[data-bundle-environment]').isChecked(), false);
            const mapped = await page.evaluate(() => fixture.mappings);
            assert.ok(mapped.some(row => row.category === category && row.sourceKey === `source-${index}.png` && row.targetKey === `${category}:target-25.png`));
            assert.equal(await page.locator('[data-bundle-target-picker]').count(), 0);
        }
        await page.locator('[data-bundle-target-clear="1"]').click(); await idle();
        assert.deepEqual(await page.evaluate(() => fixture.mappings.map(row => row.category)), ['char']);
        assert.equal(await callCount('restore'), 0);
    });
    await check('USER source choices clear target/conflict drafts and require fresh review', async () => {
        await ready({ rich: true, aliases: true }); await click('aliases');
        await click('aliases-next'); assert.equal(await page.locator('[data-bundle-source-choice]').count(), 2); await click('aliases-previous');
        await page.locator('[data-bundle-source-choice="1"]').check(); await idle();
        assert.deepEqual(await page.evaluate(() => fixture.aliases), { g0: 'c1' });
        assert.equal(await page.locator('[data-bundle-source-reviewed]').isChecked(), false);
        assert.equal(await action('restore').isDisabled(), true);
        await page.locator('[data-bundle-target-for="1"]').click(); await idle(); await page.locator('[data-bundle-target-select="0"]').click(); await idle();
        await page.locator('[data-bundle-choice="0"]').selectOption('incoming'); await idle();
        await page.locator('[data-bundle-source-choice="0"]').check(); await idle();
        assert.deepEqual(await page.evaluate(() => fixture.mappings), []); assert.deepEqual(await page.evaluate(() => fixture.choices), {});
    });
    await check('resource filters, receipt and carrier paging stay scoped and clear old confirmations', async () => {
        await ready({ rich: true });
        for (const [key, section] of [['resources', 'data-bundle-resource-section'], ['receipts', 'data-bundle-history'], ['carriers', 'data-bundle-carriers']]) {
            await click(key); await click(`${key}-next`); assert.match(await page.locator(`[${section}] nav`).innerText(), key === 'resources' ? /2 \/ 2/ : /25–26 \/ 26/);
            await click(`${key}-previous`);
        }
        await page.locator('[data-bundle-resource-filter]').selectOption('external'); await idle();
        assert.equal(await action('resources-next').isDisabled(), true);
        await page.locator('[data-bundle-history-reviewed]').check(); await click('receipts-next');
        assert.equal(await page.locator('[data-bundle-history-reviewed]').isChecked(), false);
        assert.equal(await callCount('restore'), 0);
    });
    for (const key of ['resources', 'receipts', 'carriers', 'aliases']) await check(`${key}: mismatched detail page blocks restore and invalidates old page`, async () => {
        await ready({ rich: true, aliases: true }); await click(key); await agree();
        await page.evaluate(key => { fixture.stale = key; }, key); await click(`${key}-next`);
        assert.match(await page.locator('dialog [role=status]').innerText(), /不符|已变化/);
        assert.equal(await action('restore').isDisabled(), true); assert.equal(await page.locator('.sd-bundle-review input:checked').count(), 0);
        assert.equal(await action(`${key}-next`).count(), 0, 'invalidated page must not remain visible as current evidence');
        await page.evaluate(() => { fixture.stale = ''; }); await click('preview');
        assert.equal(await action(key).count(), 1, 'recheck offers a fresh detail read');
    });
    await check('recheck invalidates cached detail pages when preview changes', async () => {
        await ready({ rich: true }); for (const key of ['resources', 'receipts', 'carriers']) await click(key);
        await page.evaluate(() => fixture.revision++); await click('preview');
        for (const key of ['resources', 'receipts', 'carriers']) assert.equal(await action(key).count(), 1, key);
    });
    await check('successful restore leaves a read-only result until close and releases the session once', async () => {
        await ready({}); await agree(); await action('restore').click();
        await page.waitForFunction(() => dialog.textContent.includes('配置已应用'));
        assert.equal(await action('restore').count(), 0); assert.equal(await callCount('restore'), 1);
        assert.equal(await page.locator('dialog fieldset').evaluate(node => node.disabled), true);
        await page.evaluate(async () => { owner.close(); window.finishedResult = await owner.finished; });
        assert.deepEqual(await page.evaluate(() => finishedResult), { resourcesVerified: true, settingsVerified: false });
        assert.equal(await page.evaluate(() => fixture.closeCount), 1);
        assert.equal(await page.locator('#opener').evaluate(node => node === document.activeElement), true);
    });
    await check('failed restore clears consent, shows the error and never retries automatically', async () => {
        await ready({}); await agree(); await page.evaluate(() => { fixture.fail = 'restore'; }); await action('restore').click(); await idle();
        assert.match(await page.locator('dialog [role=status]').innerText(), /隔离失败 restore/);
        assert.equal(await page.locator('[data-bundle-environment]').isChecked(), false); assert.equal(await action('restore').isDisabled(), true);
        assert.equal(await callCount('restore'), 1);
    });
    await check('environment remapping requires separate consent that rechecking revokes', async () => {
        await ready({ environment: true }); await page.locator('[data-bundle-environment]').check();
        assert.equal(await action('restore').isDisabled(), true); await page.locator('[data-bundle-mapping]').check();
        assert.equal(await action('restore').isEnabled(), true); await click('preview');
        assert.equal(await page.locator('[data-bundle-mapping]').isChecked(), false); await agree();
        await action('restore').click(); await page.waitForFunction(() => !!fixture.consent);
        assert.equal(await page.evaluate(() => fixture.consent.environmentMapped && fixture.consent.environmentReviewed), true);
    });
    for (const stage of ['connect', 'preview']) await check(`${stage} failure stays readable and closes without a restore`, async () => {
        await ready({ fail: stage }); assert.match(await page.locator('dialog [role=status]').innerText(), new RegExp(`隔离失败 ${stage}`));
        assert.equal(await action('restore').isDisabled(), true); assert.equal(await callCount('restore'), 0);
        await page.keyboard.press('Escape'); assert.equal(await page.locator('dialog').count(), 0);
    });
    for (const stage of ['connect', 'preview']) await check(`closing during ${stage} releases late session without reviving dialog`, async () => {
        await page.evaluate(stage => setup({ hold: stage }), stage); await page.waitForFunction(() => !!fixture.release);
        await page.evaluate(async () => { owner.close(); await owner.finished; fixture.release(); });
        await page.waitForFunction(() => fixture.closeCount === 1); assert.equal(await page.locator('dialog').count(), 0);
        assert.equal(await callCount('preview'), stage === 'connect' ? 0 : 1);
    });
    await check('closing during recheck does not start a chained alias read', async () => {
        await ready({ rich: true, aliases: true }); await click('aliases'); const before = await callCount('aliases');
        await page.evaluate(() => { fixture.hold = 'preview'; }); await action('preview').click(); await page.waitForFunction(() => !!fixture.release);
        await page.evaluate(async () => { owner.close(); await owner.finished; fixture.release(); await new Promise(resolve => setTimeout(resolve, 30)); });
        assert.equal(await callCount('aliases'), before); assert.equal(await page.locator('dialog').count(), 0);
    });
    await check('detached restore view is closed before dispatching another operation', async () => {
        await ready({}); const before = await callCount('preview');
        await page.evaluate(async () => { dialog.remove(); dialog.querySelector('[data-bundle-action=preview]').click(); await new Promise(resolve => setTimeout(resolve, 30)); });
        assert.equal(await callCount('preview'), before); assert.equal(await page.evaluate(() => fixture.closeCount), 1);
    });
    for (const stage of ['targets', 'resources', 'receipts', 'carriers', 'aliases', 'restore']) await check(`${stage}: late response after Escape cannot touch a newly opened view`, async () => {
        await ready({ rich: stage !== 'restore', aliases: stage === 'aliases' });
        if (stage === 'restore') await agree();
        await page.evaluate(stage => { fixture.hold = stage; }, stage);
        if (stage === 'targets') await page.locator('[data-bundle-target-for="0"]').click(); else await action(stage).click();
        await page.waitForFunction(() => !!fixture.release);
        await page.evaluate(() => { window.previousFixture=fixture; window.previousOwner=owner; });
        await page.keyboard.press('Escape');
        await ready({}); const before = await page.locator('dialog').innerHTML();
        await page.evaluate(async () => { previousFixture.release(); await new Promise(resolve => setTimeout(resolve, 30)); });
        assert.equal(await page.locator('dialog').innerHTML(), before); assert.equal(await callCount('restore'), 0);
        assert.equal(await page.evaluate(() => previousFixture.closeCount), 1);
        assert.equal(await page.evaluate(async () => await previousOwner.finished), null);
    });
    await check('record ending requires selected fingerprints and renewed consent', async () => {
        await ready({ kind: 'storage' }); const clear = page.locator('[data-restore-storage=clear]'); assert.equal(await clear.isDisabled(), true);
        await page.locator('[data-restore-item="0"]').check(); await page.locator('[data-restore-loss]').check();
        await page.locator('[data-restore-item="1"]').check(); assert.equal(await clear.isDisabled(), true);
        await page.locator('[data-restore-loss]').check(); await clear.click(); await idle();
        const input = await page.evaluate(() => fixture.calls.find(call => call.action === 'clear').input);
        assert.deepEqual(input.selected.map(row => row.fingerprint), ['fingerprint-0', 'fingerprint-1']);
        assert.equal(input.confirmed && input.recoveryLossAccepted, true); assert.equal(await clear.isDisabled(), true);
    });
    await check('partial record ending remains reported even when follow-up inventory fails', async () => {
        await ready({ kind: 'storage' }); await page.locator('[data-restore-item="0"]').check(); await page.locator('[data-restore-loss]').check();
        await page.evaluate(() => { fixture.partial = true; fixture.failAfterClear = true; }); await page.locator('[data-restore-storage=clear]').click(); await idle();
        const notice = await page.locator('dialog [role=status]').innerText(); assert.match(notice, /已结束 1 条/); assert.match(notice, /另一记录已变化/); assert.match(notice, /盘点暂时失败/);
        assert.equal(await page.locator('[data-restore-storage=clear]').isDisabled(), true);
    });
    await check('closing a pending record operation aborts and does not launch follow-up inventory', async () => {
        await ready({ kind: 'storage' }); await page.locator('[data-restore-item="0"]').check(); await page.locator('[data-restore-loss]').check();
        await page.evaluate(() => { fixture.hold = 'clear'; }); await page.locator('[data-restore-storage=clear]').click();
        await page.waitForFunction(() => !!fixture.release); const before = await callCount('inspect');
        await page.evaluate(async () => { owner.close(); await owner.finished; fixture.release(); await new Promise(resolve => setTimeout(resolve, 30)); });
        assert.equal(await callCount('inspect'), before); assert.equal(await page.evaluate(() => fixture.signals.every(signal => signal.aborted)), true);
    });
    await check('failed record ending clears selections and cannot silently retry', async () => {
        await ready({ kind: 'storage' }); await page.locator('[data-restore-item="0"]').check(); await page.locator('[data-restore-loss]').check();
        await page.evaluate(() => { fixture.fail = 'clear'; }); await page.locator('[data-restore-storage=clear]').click(); await idle();
        assert.match(await page.locator('dialog [role=status]').innerText(), /隔离失败 clear/);
        assert.equal(await page.locator('[data-restore-storage=clear]').isDisabled(), true); assert.equal(await page.locator('[data-restore-loss]').isChecked(), false);
        assert.equal(await callCount('clear'), 1); assert.equal(await callCount('inspect'), 1);
        await page.evaluate(() => { fixture.fail = ''; }); await page.locator('[data-restore-storage=refresh]').click(); await idle();
        assert.equal(await page.locator('[data-restore-item]:checked').count(), 0); assert.equal(await callCount('clear'), 1);
    });
    await check('detached record manager rejects further work and aborts its signal', async () => {
        await ready({ kind: 'storage' });
        await page.evaluate(async () => { dialog.remove(); dialog.querySelector('[data-restore-storage=refresh]').click(); await new Promise(resolve => setTimeout(resolve, 30)); });
        assert.equal(await callCount('inspect'), 1); assert.equal(await page.evaluate(() => fixture.signals.every(signal => signal.aborted)), true);
    });
    for (const width of [320, 393, 1280]) for (const family of ['classic', 'editorial', 'glass']) for (const mode of family === 'classic' ? ['light'] : ['light', 'dark']) {
        await check(`${width}/${family}/${mode}: real rich dialog stays contained, scrollable and theme switching preserves choices`, async () => {
            await page.setViewportSize({ width, height: width === 320 ? 568 : 900 }); await ready({ rich: true, family, mode });
            await page.locator('[data-bundle-choice="0"]').selectOption('local'); await idle();
            const geometry = await page.evaluate(() => { const rect = dialog.getBoundingClientRect(), main = dialog.querySelector('main'); return { left: rect.left, right: rect.right, bottom: rect.bottom, overflow: main.scrollWidth - main.clientWidth, scrollable: main.scrollHeight > main.clientHeight, radius: getComputedStyle(dialog).borderRadius }; });
            assert.ok(geometry.left >= 0 && geometry.right <= width + 1 && geometry.bottom <= page.viewportSize().height + 1, JSON.stringify(geometry)); assert.ok(geometry.overflow <= 1); assert.equal(geometry.scrollable, true);
            if (family === 'editorial') assert.equal(geometry.radius, '0px');
            assert.equal(await page.locator('[data-bundle-choice="0"]').inputValue(), 'local'); assert.equal(await callCount('restore'), 0);
            const retained = await page.evaluate(async () => {
                const element = dialog.querySelector('[data-bundle-choice="0"]'), before = fixture.calls.length;
                element.focus(); dialog.querySelector('main').scrollTop=137;
                const scroll = dialog.querySelector('main').scrollTop;
                await fixture.setAppearance({family:'glass', mode:'dark', accent:'#537a6b'});
                await fixture.setAppearance({family:'editorial', mode:'light', accent:'#537a6b'});
                return { same: element === dialog.querySelector('[data-bundle-choice="0"]'), focused: element === document.activeElement, value: element.value, scroll: dialog.querySelector('main').scrollTop, previousScroll: scroll, calls: fixture.calls.length, previousCalls: before };
            });
            assert.equal(retained.same && retained.focused, true); assert.equal(retained.value, 'local'); assert.equal(retained.scroll, retained.previousScroll); assert.equal(retained.calls, retained.previousCalls);
        });
    }
    assert.deepEqual(errors, []); assert.equal(external, 0);
    console.log(JSON.stringify({ passed: checks.length, checks, failures, errors, external, productionDataRead: false, scope: 'actual dialog interactions, synthetic in-memory service responses; not production restoration or physical-device validation' }));
    if (failures.length) process.exitCode = 1;
} finally { clearTimeout(deadline); await context.close(); await browser.close(); }
