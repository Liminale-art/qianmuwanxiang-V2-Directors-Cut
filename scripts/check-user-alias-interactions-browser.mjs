// Real USER alias view/coordinator and browser locks; synthetic memory-only records.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { aliasFixture, namespace, chatHash, targetKey } from '../tests/fixtures/storyboard-user-aliases.mjs';
import { installUserAliasFixture } from '../tests/helpers/user-alias-browser.mjs';
const library = aliasFixture({ extra: 25 });
library.archives[1].head.name = 'bob <img src=x>';
library.bindings.push({ category: 'user', subjectKey: 'user:/User Avatars/Other.png', scope: 'default', chatKey: '', archiveId: 'alice', revision: 'other-persona', updatedAt: 1 },
    { category: 'char', subjectKey: 'char:Alice.png', scope: 'default', chatKey: '', archiveId: 'alice', revision: 'char-unchanged', updatedAt: 1 });
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
const action = key => page.locator(`[data-alias-action="${key}"]`);
const idle = () => page.waitForFunction(() => dialog.isConnected && !dialog.querySelector('[data-alias-action=refresh]').disabled);
const ready = async options => { await page.evaluate(options => setup(options), options); await idle(); };
const click = async key => { await action(key).click(); await idle(); };
const count = name => page.evaluate(name => fixture.calls.filter(row => row.action === name).length, name);
const choose = async () => {
    await click('next'); const input = page.locator('.sd-user-alias-item').filter({ hasText: 'bob' }).locator('input'); await input.check(); await idle(); return input;
};
const approve = async () => { await choose(); await page.locator('[data-alias-accepted]').check(); };
async function check(name, run) { try { await run(); checks.push(name); } catch (error) { failures.push({ name, error: error.message }); } }
try {
    await page.goto('https://qianmu.test/');
    await page.addStyleTag({ content: await readFile(new URL('../style.css', import.meta.url), 'utf8') });
    await page.addStyleTag({ content: await readFile(new URL('../qianmu-theme-skins.css', import.meta.url), 'utf8') });
    await page.evaluate(installUserAliasFixture, { library, namespace, chatHash });
    await check('28 original affected bindings paginate without writing, truncation or automatically resolving a conflict', async () => {
        await ready(); assert.equal(await page.locator('[data-alias-choice]').count(), 24); assert.match(await page.locator('dialog main').innerText(), /28 条原绑定/);
        await page.locator('[data-alias-accepted]').check(); assert.equal(await action('apply').isDisabled(), true);
        await click('next'); assert.equal(await page.locator('[data-alias-choice]').count(), 4); assert.equal(await action('next').isDisabled(), true);
        assert.equal(await page.locator('[data-alias-accepted]').isChecked(), false); assert.equal(await page.locator('dialog img').count(), 0);
        await click('previous'); assert.equal(await page.locator('[data-alias-choice]').count(), 24); assert.equal(await page.evaluate(() => fixture.writes), 0);
    });
    await check('choosing a conflicting archive preserves that radio focus and scroll after asynchronous preview', async () => {
        await ready(); await click('next'); const radio = page.locator('.sd-user-alias-item').filter({ hasText: 'bob' }).locator('input');
        await radio.scrollIntoViewIfNeeded(); const top = await page.locator('dialog main').evaluate(node => node.scrollTop); await radio.check(); await idle();
        assert.equal(await radio.isChecked(), true); assert.equal(await radio.evaluate(node => node === document.activeElement), true);
        assert.equal(await page.locator('dialog main').evaluate(node => node.scrollTop), top); assert.equal(await action('apply').isDisabled(), true);
    });
    await check('paging and refreshing revoke consent but preserve an explicit archive choice until it becomes stale', async () => {
        await ready(); await approve(); assert.equal(await action('apply').isDisabled(), false); await click('previous');
        assert.equal(await page.locator('[data-alias-accepted]').isChecked(), false); await click('next');
        assert.equal(await page.locator('.sd-user-alias-item').filter({ hasText: 'bob' }).locator('input').isChecked(), true);
        await page.locator('[data-alias-accepted]').check(); await click('refresh'); assert.equal(await page.locator('[data-alias-accepted]').isChecked(), false);
        assert.equal(await page.evaluate(() => fixture.writes), 0);
    });
    await check('confirmed operation saves every original relation before binding writes; null, unrelated personas and CHAR stay intact', async () => {
        await ready(); await approve(); await click('apply');
        assert.deepEqual(await page.evaluate(() => fixture.events), ['receipt', 'bindings']); assert.equal(await page.evaluate(() => fixture.writes), 1);
        const state = await page.evaluate(() => ({ rows: fixture.library.bindings, archives: fixture.library.archives, receipt: [...fixture.maps.values()][0], result: fixture.result }));
        assert.equal(state.result.before, 28); assert.equal(state.result.after, 27); assert.equal(state.receipt.review.lineage.length, 28);
        assert.equal(state.rows.find(row => row.subjectKey === targetKey && row.scope === 'default').archiveId, 'bob');
        assert.equal(state.rows.find(row => row.chatKey === 'chat-one').archiveId, '');
        for (const revision of ['unchanged', 'other-persona', 'char-unchanged']) assert.deepEqual(state.rows.find(row => row.revision === revision), library.bindings.find(row => row.revision === revision));
        assert.deepEqual(state.archives, library.archives); assert.match(await page.locator('[role=status]').innerText(), /已核对整理 28 条原绑定/);
        assert.match(await page.locator('dialog main').innerText(), /未发现需要整理/); assert.equal(await action('apply').isDisabled(), true);
        await click('refresh'); assert.equal(await page.evaluate(() => fixture.writes), 1);
    });
    await check('missing actual persona files block selection and application without treating same names as identity', async () => {
        await ready({ missing: true }); assert.match(await page.locator('dialog main').innerText(), /人设不在ST目录/);
        assert.equal(await page.locator('[data-alias-choice]:enabled').count(), 0); await page.locator('[data-alias-accepted]').check();
        assert.equal(await action('apply').isDisabled(), true); assert.equal(await page.evaluate(() => fixture.writes), 0);
    });
    await check('empty and unavailable inventories are distinct, and failure can be refreshed without writing', async () => {
        await ready({ empty: true }); assert.match(await page.locator('dialog main').innerText(), /未发现需要整理/); assert.equal(await action('apply').isDisabled(), true);
        await ready({ fail: 'user-alias-preview' }); assert.doesNotMatch(await page.locator('dialog main').innerText(), /正在核对本机绑定/);
        assert.match(await page.locator('dialog main').innerText(), /暂不可用|未完成/); assert.equal(await action('apply').isDisabled(), true);
        await page.evaluate(() => { fixture.fail = ''; }); await click('refresh'); assert.equal(await page.locator('[data-alias-choice]').count(), 24);
    });
    await check('successful binding result is retained when its follow-up preview fails, without claiming rollback or retrying', async () => {
        await ready(); await approve(); await page.evaluate(() => { fixture.failAfterApply = true; }); await click('apply');
        const notice = await page.locator('[role=status]').innerText(); assert.match(notice, /已核对整理 28 条原绑定/); assert.match(notice, /隔离复查失败/);
        assert.equal(await action('apply').isDisabled(), true); assert.equal(await page.locator('[data-alias-choice]').count(), 0);
        await page.evaluate(() => { fixture.failAfterApply = false; }); await click('refresh'); assert.equal(await page.evaluate(() => fixture.writes), 1);
        assert.equal(await page.evaluate(() => fixture.maps.size), 1); assert.equal(await count('user-alias-apply'), 1);
    });
    for (const reason of ['head', 'binding', 'missing', 'capacity', 'receipt']) await check(`changed ${reason} blocks application before any binding write`, async () => {
        await ready(); await approve(); await page.evaluate(reason => {
            if (reason === 'head') fixture.library.archives[0].head.revision = 'new-revision';
            if (reason === 'binding') fixture.library.bindings[0].revision = 'new-binding';
            if (reason === 'missing') fixture.missing = true;
            if (reason === 'capacity') fixture.fits = false;
            if (reason === 'receipt') fixture.receiptFail = true;
        }, reason); await click('apply');
        assert.equal(await page.evaluate(() => fixture.writes), 0); assert.equal(await page.evaluate(() => fixture.attempts), 0);
        assert.equal(await action('apply').isDisabled(), true); assert.equal(await count('user-alias-apply'), 1);
        assert.equal(await page.locator('[data-alias-choice]').count(), 0); assert.ok((await page.locator('[role=status]').innerText()).length);
    });
    for (const stage of ['before', 'after']) await check(`${stage} binding-write failure keeps original proof and requires reinspection without automatic replay`, async () => {
        await ready(); await approve(); await page.evaluate(stage => { fixture.writeFail = stage; }, stage); await click('apply');
        const notice = await page.locator('[role=status]').innerText(); assert.match(notice, /未全部确认/); assert.match(notice, /不会自动重试或回滚/);
        assert.equal(await page.evaluate(() => fixture.maps.size), 1); assert.equal(await page.evaluate(() => fixture.attempts), 1);
        assert.equal(await page.evaluate(() => fixture.writes), stage === 'after' ? 1 : 0); assert.equal(await action('apply').isDisabled(), true);
        await page.evaluate(() => { fixture.writeFail = ''; }); await click('refresh'); assert.equal(await page.evaluate(() => fixture.attempts), 1);
    });
    await check('a stale candidate is rejected and reset, rather than silently selecting a different archive', async () => {
        await ready(); await approve(); await page.evaluate(() => { fixture.library.bindings.find(row => row.revision === 'old').revision = 'changed-old'; });
        await click('refresh'); assert.match(await page.locator('[role=status]').innerText(), /选择已过期/); assert.equal(await action('apply').isDisabled(), true);
        await click('refresh'); assert.match(await page.locator('dialog main').innerText(), /待选择 1 组/); assert.equal(await page.evaluate(() => fixture.writes), 0);
    });
    await check('detached dialog refuses further preview and consent events, and aborts its owner', async () => {
        await ready(); await page.evaluate(async () => {
            dialog.remove(); dialog.querySelector('[data-alias-action=refresh]').click(); const consent = dialog.querySelector('[data-alias-accepted]'); consent.checked = true; consent.dispatchEvent(new Event('change', { bubbles: true })); await new Promise(resolve => setTimeout(resolve, 25));
        });
        assert.equal(await count('user-alias-preview'), 1); assert.equal(await page.evaluate(() => fixture.signals.every(signal => signal.aborted)), true);
    });
    for (const pending of ['initial', 'choice', 'apply', 'post-apply']) await check(`closing during ${pending} does not continue preview or affect a new window`, async () => {
        if (pending === 'initial') { await page.evaluate(() => setup({ hold: 'user-alias-preview' })); }
        else {
            await ready(); await approve(); await page.evaluate(pending => { fixture.hold = pending === 'apply' ? 'user-alias-apply' : 'user-alias-preview'; }, pending);
            if (pending === 'choice') await page.locator('.sd-user-alias-item').filter({ hasText: 'alice' }).last().locator('input').click(); else await action('apply').click();
        }
        await page.waitForFunction(() => !!fixture.release);
        const before = await count('user-alias-preview'); await page.evaluate(async () => { window.oldFixture = fixture; window.oldDialog = dialog; owner.close(); await owner.finished; });
        await ready(); const html = await page.locator('dialog').innerHTML(); await page.evaluate(async () => { oldFixture.release(); await new Promise(resolve => setTimeout(resolve, 30)); });
        assert.equal(await page.locator('dialog').innerHTML(), html); assert.equal(await page.evaluate(() => oldDialog.isConnected), false);
        assert.equal(await page.evaluate(() => oldFixture.calls.filter(row => row.action === 'user-alias-preview').length), before);
        assert.equal(await page.evaluate(() => oldFixture.signals.every(signal => signal.aborted)), true);
        if (pending === 'apply' || pending === 'post-apply') { assert.equal(await page.evaluate(() => oldFixture.writes), 1); assert.equal(await page.evaluate(() => oldFixture.maps.size), 1); }
    });
    await check('account changes while a confirmed apply waits prevent binding and receipt writes', async () => {
        await ready(); await approve(); await page.evaluate(() => { fixture.hold = 'user-alias-apply'; fixture.when = 'before'; }); await action('apply').click(); await page.waitForFunction(() => !!fixture.release);
        await page.evaluate(() => { fixture.live = false; fixture.release(); }); await idle();
        assert.match(await page.locator('[role=status]').innerText(), /账户已变化/); assert.equal(await page.evaluate(() => fixture.writes + fixture.maps.size), 0);
        assert.equal(await action('apply').isDisabled(), true);
    });
    await check('busy confirmation cannot apply twice and a live theme switch does not discard its valid result', async () => {
        await ready(); await approve(); await page.evaluate(() => { fixture.hold = 'user-alias-apply'; fixture.when = 'before'; }); await action('apply').click(); await page.waitForFunction(() => !!fixture.release);
        await page.evaluate(async () => {
            dialog.querySelector('[data-alias-action=apply]').dispatchEvent(new MouseEvent('click', { bubbles: true }));
            await fixture.setAppearance({ family: 'glass', mode: 'dark', accent: '#537a6b' });
            await fixture.setAppearance({ family: 'editorial', mode: 'light', accent: '#537a6b' });
        });
        assert.equal(await count('user-alias-apply'), 1); assert.equal(await page.evaluate(() => fixture.writes), 0);
        await page.evaluate(() => fixture.release()); await idle(); assert.equal(await page.evaluate(() => fixture.writes), 1);
        assert.match(await page.locator('[role=status]').innerText(), /已核对整理/); assert.equal(await count('user-alias-apply'), 1);
    });
    await check('an occupied native browser recovery lock blocks application without receipts or binding writes', async () => {
        await ready(); await approve();
        await page.evaluate(async namespace => {
            await new Promise(resolve => { void navigator.locks.request(`qianmu:package-import:${namespace}`, async () => { resolve(); await new Promise(done => { fixture.releaseLock = done; }); }); });
        }, namespace);
        try { await click('apply'); assert.match(await page.locator('[role=status]').innerText(), /另一页面正在恢复或整理/); assert.equal(await page.evaluate(() => fixture.writes + fixture.maps.size), 0); }
        finally { await page.evaluate(() => { fixture.releaseLock(); fixture.releaseLock = null; }); }
        await click('refresh'); assert.match(await page.locator('dialog main').innerText(), /待选择 1 组/); assert.equal(await page.evaluate(() => fixture.writes), 0);
    });
    await check('page disposal while an apply response waits stops follow-up reads without undoing a confirmed write', async () => {
        await ready(); await approve(); await page.evaluate(() => { fixture.hold = 'user-alias-apply'; }); await action('apply').click(); await page.waitForFunction(() => !!fixture.release);
        const before = await count('user-alias-preview');
        await page.evaluate(async () => { dialog.remove(); fixture.release(); await owner.finished; });
        assert.equal(await count('user-alias-preview'), before); assert.equal(await page.evaluate(() => fixture.writes), 1); assert.equal(await page.evaluate(() => fixture.maps.size), 1);
        assert.equal(await page.evaluate(() => fixture.signals.every(signal => signal.aborted)), true);
    });
    await check('Escape closes without applying and returns keyboard focus to its opener', async () => {
        await ready(); await approve(); await page.keyboard.press('Escape'); await page.evaluate(() => owner.finished);
        assert.equal(await page.locator('dialog').count(), 0); assert.equal(await page.evaluate(() => fixture.writes), 0);
        assert.equal(await page.locator('#opener').evaluate(node => node === document.activeElement), true);
    });
    for (const width of [320, 393, 1280]) for (const family of ['classic', 'editorial', 'glass']) for (const mode of family === 'classic' ? ['light'] : ['light', 'dark']) await check(`${width}/${family}/${mode}: paged USER choices and consent survive live theme changes`, async () => {
        await page.setViewportSize({ width, height: width === 320 ? 568 : 900 }); await ready({ family, mode }); await approve();
        const geometry = await page.evaluate(() => { const box = dialog.getBoundingClientRect(), main = dialog.querySelector('main'); return { left: box.left, right: box.right, bottom: box.bottom, overflow: main.scrollWidth - main.clientWidth, radius: getComputedStyle(dialog).borderRadius, footer: dialog.querySelector('footer').getBoundingClientRect().bottom }; });
        assert.ok(geometry.left >= 0 && geometry.right <= width + 1 && geometry.bottom <= page.viewportSize().height + 1 && geometry.footer <= geometry.bottom + 1, JSON.stringify(geometry));
        assert.ok(geometry.overflow <= 1); if (family === 'editorial') assert.equal(geometry.radius, '0px');
        const retained = await page.evaluate(async () => {
            const checkbox = dialog.querySelector('[data-alias-accepted]'), before = fixture.calls.length; checkbox.focus(); dialog.querySelector('main').scrollTop = 150; const top = dialog.querySelector('main').scrollTop;
            await fixture.setAppearance({ family: 'glass', mode: 'dark', accent: '#537a6b' }); await fixture.setAppearance({ family: 'editorial', mode: 'light', accent: '#537a6b' });
            return { same: checkbox === dialog.querySelector('[data-alias-accepted]'), focus: checkbox === document.activeElement, checked: checkbox.checked, top, afterTop: dialog.querySelector('main').scrollTop, before, after: fixture.calls.length };
        });
        assert.equal(retained.same && retained.focus && retained.checked, true); assert.equal(retained.top, retained.afterTop); assert.equal(retained.before, retained.after); assert.equal(await page.evaluate(() => fixture.writes), 0);
    });
    assert.deepEqual(errors, []); assert.equal(external, 0);
    console.log(JSON.stringify({ passed: checks.length, checks, failures, errors, external, productionDataRead: false, scope: 'actual view/coordinator/contracts and browser locks; synthetic in-memory bindings and receipts, no native persistent store or physical-device claim' }));
    if (failures.length) process.exitCode = 1;
} finally { clearTimeout(deadline); await context.close(); await browser.close(); }
