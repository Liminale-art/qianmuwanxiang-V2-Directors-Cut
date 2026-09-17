// Real mapping view and contracts. Synthetic receipts, memory-only journal, no ST data.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { mappingReceiptsFixture, namespace } from '../tests/fixtures/storyboard-mapping-receipts.mjs';
import { createStoryboardEnvironmentReview } from '../qianmu-storyboard-environment-map.js';
import { mappingHead } from '../qianmu-storyboard-mapping-contract.js';
import { installMappingRegistryFixture } from '../tests/helpers/mapping-registry-browser.mjs';
const receipts = await mappingReceiptsFixture();
for (let i = 0; i < 24; i++) {
    const review = await createStoryboardEnvironmentReview({ ...receipts[0].receipt.review, chatHash: i.toString(16).padStart(64, '0') });
    const receipt = { key: review.digest, namespace, review, createdAt: i + 5 };
    receipts.push({ kind: 'environment', receipt, head: mappingHead('environment', receipt) });
}
const require = createRequire(import.meta.url), { chromium } = require(process.env.QIANMU_PLAYWRIGHT_MODULE || 'playwright');
const browser = await chromium.launch({ channel: process.env.QIANMU_BROWSER_CHANNEL || undefined, headless: true });
const context = await browser.newContext({ acceptDownloads: true }), page = await context.newPage(), checks = [], failures = [], errors = [];
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
const action = key => page.locator(`[data-mapping-action="${key}"]`);
const idle = () => page.waitForFunction(() => dialog.isConnected && [...dialog.querySelectorAll('button[data-mapping-action]')].some(node => ['refresh', 'back', 'import-preview'].includes(node.dataset.mappingAction) && !node.disabled));
const ready = async options => { await page.evaluate(options => setup(options), options); await idle(); };
const click = async key => { await action(key).click(); await idle(); };
const count = name => page.evaluate(name => fixture.calls.filter(row => row.action === name).length, name);
const file = (index = 1, payload) => ({ name: '<receipt>.mapping.json', mimeType: 'application/json', buffer: Buffer.from(payload ?? JSON.stringify({ schema: 'qianmu.storyboard.mapping-receipt.v1', kind: receipts[index].kind, receipt: receipts[index].receipt })) });
async function upload(index = 1, payload) {
    const chooser = page.waitForEvent('filechooser'); await action('import').click(); await (await chooser).setFiles(file(index, payload)); await idle();
}
async function openReceipt(index = 1) {
    await page.locator('[data-mapping-query]').fill(receipts[index].head.digest); await click('search');
    await page.locator('[data-mapping-open="0"]').click(); await idle();
}
async function check(name, run) { try { await run(); checks.push(name); } catch (error) { failures.push({ name, error: error.message }); } }
try {
    await page.goto('https://qianmu.test/');
    await page.addStyleTag({ content: await readFile(new URL('../style.css', import.meta.url), 'utf8') });
    await page.addStyleTag({ content: await readFile(new URL('../qianmu-theme-skins.css', import.meta.url), 'utf8') });
    await page.evaluate(installMappingRegistryFixture, { receipts, namespace });
    await check('directory paging and filtering use compact heads without opening receipt bodies', async () => {
        await ready(); assert.equal(await page.locator('[data-mapping-open]').count(), 24); await click('next');
        assert.equal(await page.locator('[data-mapping-open]').count(), 4); await click('previous');
        await page.locator('[data-mapping-kind]').selectOption('subjects'); await click('search');
        assert.equal(await page.locator('[data-mapping-open]').count(), 3); assert.equal(await page.evaluate(() => fixture.reads), 0);
        assert.equal(await page.evaluate(() => fixture.writes), 0);
    });
    await check('search Enter keeps focus and selection across its asynchronous redraw', async () => {
        await ready(); const query = page.locator('[data-mapping-query]'); await query.fill(receipts[1].head.digest.toUpperCase());
        await query.evaluate(node => node.setSelectionRange(2, 10, 'backward'));
        await query.press('Enter'); await idle(); assert.equal(await page.locator('[data-mapping-open]').count(), 1);
        assert.equal(await query.evaluate(node => node === document.activeElement), true); assert.equal(await query.inputValue(), receipts[1].head.digest.toUpperCase());
        assert.deepEqual(await query.evaluate(node => [node.selectionStart, node.selectionEnd, node.selectionDirection]), [2, 10, 'backward']);
    });
    await check('detail pagination retains full original bindings and returns to the original scrolled directory row', async () => {
        await ready(); await page.evaluate(() => { dialog.querySelector('main').scrollTop = 210; });
        const before = await page.locator('dialog main').evaluate(node => node.scrollTop);
        await page.locator('[data-mapping-open="3"]').click(); await idle(); await click('back');
        assert.equal(await page.locator('dialog main').evaluate(node => node.scrollTop), before);
        assert.equal(await page.locator('[data-mapping-open="3"]').evaluate(node => node === document.activeElement), true);
        await openReceipt(); assert.match(await page.locator('dialog main').innerText(), /不使用档案（显式解除）/);
        assert.equal(await page.locator('dialog chat').count(), 0); await click('next');
        assert.match(await page.locator('.sd-mapping-items').innerText(), /source-24/); assert.equal(await action('next').isDisabled(), true);
        await click('previous'); assert.match(await page.locator('.sd-mapping-items').innerText(), /source-0/);
    });
    for (const index of [0, 2, 3]) await check(`receipt variant ${index} displays verified environment/local/bundle alias semantics`, async () => {
        await ready(); await openReceipt(index); const text = await page.locator('dialog main').innerText();
        assert.match(text, index === 0 ? /来源安装/ : index === 2 ? /本机USER等价地址整理/ : /原包USER来源整理与目标映射/);
        assert.equal(await page.evaluate(() => fixture.writes), 0);
    });
    await check('unsubmitted search draft survives visiting and returning from a record', async () => {
        await ready(); await page.locator('[data-mapping-query]').fill('尚未提交 <draft>'); await page.locator('[data-mapping-open="0"]').click(); await idle(); await click('back');
        assert.equal(await page.locator('[data-mapping-query]').inputValue(), '尚未提交 <draft>'); assert.equal(await page.locator('dialog draft').count(), 0);
    });
    await check('real browser download includes all 25 original bindings and releases its Blob URL when closed', async () => {
        await ready(); await openReceipt(); const downloaded = page.waitForEvent('download'); await click('export'); const download = await downloaded;
        const stream = await download.createReadStream(), chunks = []; for await (const chunk of stream) chunks.push(chunk);
        const result = JSON.parse(Buffer.concat(chunks).toString('utf8')); assert.deepEqual(result.receipt, receipts[1].receipt);
        assert.equal(result.receipt.review.lineage.length, 25); assert.match(download.suggestedFilename(), /^qianmu-subjects-.*\.mapping\.json$/);
        assert.match(await page.locator('[role=status]').innerText(), /请确认文件已保存/); assert.equal(await page.evaluate(() => fixture.writes), 0);
        await page.evaluate(async () => { owner.close(); await owner.finished; });
        assert.deepEqual(await page.evaluate(() => fixture.revoked), await page.evaluate(() => fixture.urls));
    });
    await check('corrupted receipt cannot be exported and makes no browser download URL', async () => {
        await ready(); await openReceipt(); await page.evaluate(digest => { [...fixture.records.values()].find(row => row.head.digest === digest).receipt.review.lineage[0].target.archiveId = 'wrong'; }, receipts[1].head.digest);
        await click('export'); assert.match(await page.locator('[role=status]').innerText(), /谱系|凭据/); assert.equal(await page.evaluate(() => fixture.urls.length), 0);
    });
    await check('import confirmation preserves keyboard focus and rechecking revokes the old consent', async () => {
        await ready({ empty: true }); await upload(); const checkbox = page.locator('[data-mapping-import-confirm]'); await checkbox.check();
        assert.equal(await checkbox.evaluate(node => node === document.activeElement), true); assert.equal(await action('import-apply').isDisabled(), false);
        await click('import-preview'); assert.equal(await checkbox.isChecked(), false); assert.equal(await action('import-apply').isDisabled(), true);
        assert.equal(await page.evaluate(() => fixture.writes), 0); assert.equal(await page.locator('dialog receipt').count(), 0);
    });
    for (const index of [0, 1, 2, 3]) await check(`actual receipt ${index} imports unchanged once, repeated import does not replay or overwrite`, async () => {
        await ready({ empty: true }); await upload(index); await page.locator('[data-mapping-import-confirm]').check(); await click('import-apply');
        assert.equal(await page.evaluate(() => fixture.writes), 1); assert.match(await page.locator('[role=status]').innerText(), /已保全完整历史凭据/);
        assert.deepEqual(await page.evaluate(() => [...fixture.records.values()][0].receipt), receipts[index].receipt);
        await upload(index); assert.match(await page.locator('dialog main').innerText(), /原记录完全相同/);
        await page.locator('[data-mapping-import-confirm]').check(); await click('import-apply'); assert.equal(await page.evaluate(() => fixture.writes), 1);
        assert.match(await page.locator('[role=status]').innerText(), /未新增或覆盖/);
    });
    await check('saved import remains reported if its follow-up directory read fails; old rows are not relabelled', async () => {
        await ready({ exclude: [1] }); assert.equal(await page.locator('[data-mapping-open]').count(), 24);
        await upload(); await page.locator('[data-mapping-import-confirm]').check(); await page.evaluate(() => { fixture.failAfterImport = true; });
        await click('import-apply'); const notice = await page.locator('[role=status]').innerText();
        assert.match(notice, /已保全完整历史凭据/); assert.match(notice, /隔离读取失败/); assert.equal(await page.locator('[data-mapping-open]').count(), 0);
        assert.doesNotMatch(await page.locator('dialog main').innerText(), /正在读取目录/);
        await page.evaluate(() => { fixture.failAfterImport = false; }); await click('refresh'); assert.equal(await page.locator('[data-mapping-open]').count(), 1);
        assert.equal(await page.evaluate(() => fixture.writes), 1); assert.equal(await count('mapping-import-apply'), 1);
    });
    await check('changed directory invalidates approved import and requires a new preview without auto retry', async () => {
        await ready({ empty: true }); await upload(); await page.locator('[data-mapping-import-confirm]').check();
        await page.evaluate(row => fixture.records.set(row.head.key, structuredClone(row)), receipts[0]); await click('import-apply');
        assert.match(await page.locator('[role=status]').innerText(), /确认已过期/); assert.equal(await action('import-apply').isDisabled(), true); assert.equal(await page.evaluate(() => fixture.writes), 0);
        await click('import-preview'); assert.equal(await page.locator('[data-mapping-import-confirm]').isChecked(), false);
        await page.locator('[data-mapping-import-confirm]').check(); await click('import-apply'); assert.equal(await page.evaluate(() => fixture.writes), 1);
    });
    await check('invalid file is readable as an error and returning to directory releases import state', async () => {
        await ready(); await upload(1, '{not json'); assert.equal(await action('import-apply').isDisabled(), true);
        assert.ok((await page.locator('[role=status]').innerText()).length); await click('import-back');
        assert.equal(await page.locator('[data-mapping-open]').count(), 24); assert.equal(await page.evaluate(() => fixture.writes), 0);
    });
    await check('file-picker cancellation leaves the directory and its scroll intact', async () => {
        await ready(); await page.locator('dialog main').evaluate(node => { node.scrollTop = 145; });
        const before = await count('mapping-list'), chooser = page.waitForEvent('filechooser'); await action('import').click(); await chooser;
        await page.locator('input[type=file]').dispatchEvent('cancel');
        assert.equal(await page.locator('input[type=file]').count(), 0); assert.equal(await count('mapping-list'), before);
        assert.equal(await page.locator('dialog main').evaluate(node => node.scrollTop), 145);
    });
    await check('detached dialog cannot dispatch another query and aborts its existing owner', async () => {
        await ready(); await page.evaluate(async () => { dialog.remove(); dialog.querySelector('[data-mapping-action=refresh]').click(); await new Promise(resolve => setTimeout(resolve, 25)); });
        assert.equal(await count('mapping-list'), 1); assert.equal(await page.evaluate(() => fixture.signals.every(signal => signal.aborted)), true);
    });
    await check('failed initial inventory and failed new search are unavailable, not a permanent spinner or stale labelled results', async () => {
        await ready({ fail: 'mapping-list' }); assert.match(await page.locator('dialog main').innerText(), /目录暂不可用/);
        assert.doesNotMatch(await page.locator('dialog main').innerText(), /正在读取目录/);
        await page.evaluate(() => { fixture.fail = ''; }); await click('refresh'); assert.equal(await page.locator('[data-mapping-open]').count(), 24);
        await page.locator('[data-mapping-query]').fill('new search'); await page.evaluate(() => { fixture.fail = 'mapping-list'; }); await click('search');
        assert.equal(await page.locator('[data-mapping-open]').count(), 0); assert.equal(await page.locator('[data-mapping-query]').inputValue(), 'new search');
        assert.match(await page.locator('dialog main').innerText(), /目录暂不可用/); assert.equal(await page.evaluate(() => fixture.writes), 0);
    });
    await check('a superseded or closed file picker cannot start an import preview', async () => {
        await ready(); const first = page.waitForEvent('filechooser'); await action('import').click(); await first;
        await page.evaluate(() => { window.oldPicker = dialog.querySelector('input[type=file]'); });
        const second = page.waitForEvent('filechooser'); await action('import').click(); await second;
        await page.evaluate(() => { const data = new DataTransfer(); data.items.add(new File(['{}'], 'late.json', { type: 'application/json' })); oldPicker.files = data.files; oldPicker.dispatchEvent(new Event('change', { bubbles: true })); });
        assert.equal(await count('mapping-import-preview'), 0); assert.equal(await page.locator('[data-mapping-open]').count(), 24);
        await page.evaluate(async () => { const picker = dialog.querySelector('input[type=file]'); owner.close(); await owner.finished; const data = new DataTransfer(); data.items.add(new File(['{}'], 'late.json')); picker.files = data.files; picker.dispatchEvent(new Event('change', { bubbles: true })); });
        assert.equal(await count('mapping-import-preview'), 0); assert.equal(await page.locator('dialog').count(), 0); assert.equal(await page.locator('#opener').evaluate(node => node === document.activeElement), true);
    });
    await check('closing during post-import inventory leaves the confirmed record without reviving old results', async () => {
        await ready({ empty: true }); await upload(); await page.locator('[data-mapping-import-confirm]').check();
        await page.evaluate(() => { fixture.hold = 'mapping-list'; }); await action('import-apply').click(); await page.waitForFunction(() => !!fixture.release);
        await page.evaluate(async () => { window.oldFixture = fixture; owner.close(); await owner.finished; }); await ready();
        const before = await page.locator('dialog').innerHTML(); await page.evaluate(async () => { oldFixture.release(); await new Promise(resolve => setTimeout(resolve, 30)); });
        assert.equal(await page.locator('dialog').innerHTML(), before); assert.equal(await page.evaluate(() => oldFixture.writes), 1);
        assert.equal(await page.evaluate(() => oldFixture.records.size), 1); assert.equal(await page.evaluate(() => oldFixture.calls.filter(row => row.action === 'mapping-import-apply').length), 1);
    });
    for (const pending of ['mapping-list', 'mapping-detail', 'mapping-export', 'mapping-import-preview', 'mapping-import-apply']) await check(`closing pending ${pending} cannot revive it, download, follow up or alter a new dialog`, async () => {
        await ready({ empty: pending === 'mapping-import-apply' });
        if (pending === 'mapping-export') await openReceipt();
        if (pending === 'mapping-import-apply') { await upload(); await page.locator('[data-mapping-import-confirm]').check(); }
        await page.evaluate(pending => { fixture.hold = pending; }, pending);
        if (pending === 'mapping-list') await action('refresh').click();
        if (pending === 'mapping-detail') await page.locator('[data-mapping-open="0"]').click();
        if (pending === 'mapping-export') await action('export').click();
        if (pending === 'mapping-import-preview') { const chooser = page.waitForEvent('filechooser'); await action('import').click(); await (await chooser).setFiles(file()); }
        if (pending === 'mapping-import-apply') await action('import-apply').click();
        await page.waitForFunction(() => !!fixture.release);
        await page.evaluate(async () => { window.oldFixture = fixture; window.oldDialog = dialog; owner.close(); await owner.finished; });
        await ready(); const before = await page.locator('dialog').innerHTML();
        await page.evaluate(async () => { oldFixture.release(); await new Promise(resolve => setTimeout(resolve, 30)); });
        assert.equal(await page.locator('dialog').innerHTML(), before); assert.equal(await page.evaluate(() => oldDialog.isConnected), false);
        assert.equal(await page.evaluate(() => oldFixture.signals.every(signal => signal.aborted)), true);
        assert.equal(await page.evaluate(() => oldFixture.urls.length), 0);
        if (pending === 'mapping-import-apply') assert.equal(await page.evaluate(() => oldFixture.calls.filter(row => row.action === 'mapping-list').length), 1);
    });
    await check('account change while import is waiting prevents any in-memory write', async () => {
        await ready({ empty: true }); await upload(); await page.locator('[data-mapping-import-confirm]').check();
        await page.evaluate(() => { fixture.hold = 'mapping-import-apply'; fixture.when = 'before'; }); await action('import-apply').click(); await page.waitForFunction(() => !!fixture.release);
        await page.evaluate(() => { fixture.live = false; fixture.release(); }); await idle();
        assert.match(await page.locator('[role=status]').innerText(), /账户已变化/); assert.equal(await page.evaluate(() => fixture.writes), 0); assert.equal(await action('import-apply').isDisabled(), true);
    });
    await check('native Escape still closes the dialog, aborts its owner and returns focus without another request', async () => {
        await ready(); await page.keyboard.press('Escape'); await page.evaluate(() => owner.finished);
        assert.equal(await page.locator('dialog').count(), 0); assert.equal(await count('mapping-list'), 1);
        assert.equal(await page.evaluate(() => fixture.signals.every(signal => signal.aborted)), true);
        assert.equal(await page.locator('#opener').evaluate(node => node === document.activeElement), true);
    });
    await check('a second export releases the previous Blob and the expiry timer releases only the latest one', async () => {
        await ready(); await openReceipt(); await page.clock.install();
        for (let i = 0; i < 2; i++) { const download = page.waitForEvent('download'); await click('export'); await download; }
        assert.equal(await page.evaluate(() => fixture.urls.length), 2); assert.deepEqual(await page.evaluate(() => fixture.revoked), await page.evaluate(() => fixture.urls.slice(0, 1)));
        await page.clock.fastForward(10001);
        assert.deepEqual(await page.evaluate(() => fixture.revoked), await page.evaluate(() => fixture.urls));
        await page.evaluate(() => owner.close()); assert.equal(await page.evaluate(() => fixture.revoked.length), 2);
    });
    for (const width of [320, 393, 1280]) for (const family of ['classic', 'editorial', 'glass']) for (const mode of family === 'classic' ? ['light'] : ['light', 'dark']) await check(`${width}/${family}/${mode}: directory, long details, import and live theme remain usable`, async () => {
        await page.setViewportSize({ width, height: width === 320 ? 568 : 900 }); await ready({ family, mode });
        for (const screen of ['list', 'detail', 'import']) {
            if (screen === 'detail') await openReceipt();
            if (screen === 'import') { await click('back'); await upload(); }
            const geometry = await page.evaluate(() => { const box = dialog.getBoundingClientRect(), main = dialog.querySelector('main'); return { left: box.left, right: box.right, bottom: box.bottom, overflow: main.scrollWidth - main.clientWidth, radius: getComputedStyle(dialog).borderRadius, footer: dialog.querySelector('footer').getBoundingClientRect().bottom }; });
            assert.ok(geometry.left >= 0 && geometry.right <= width + 1 && geometry.bottom <= page.viewportSize().height + 1 && geometry.footer <= geometry.bottom + 1, JSON.stringify(geometry));
            assert.ok(geometry.overflow <= 1, `${screen}: ${JSON.stringify(geometry)}`); if (family === 'editorial') assert.equal(geometry.radius, '0px');
        }
        await page.locator('[data-mapping-import-confirm]').check();
        const retained = await page.evaluate(async () => {
            const checkbox = dialog.querySelector('[data-mapping-import-confirm]'), before = fixture.calls.length; checkbox.focus(); dialog.querySelector('main').scrollTop = 137; const top = dialog.querySelector('main').scrollTop;
            await fixture.setAppearance({ family: 'glass', mode: 'dark', accent: '#537a6b' }); await fixture.setAppearance({ family: 'editorial', mode: 'light', accent: '#537a6b' });
            return { same: checkbox === dialog.querySelector('[data-mapping-import-confirm]'), focus: checkbox === document.activeElement, checked: checkbox.checked, top, afterTop: dialog.querySelector('main').scrollTop, before, after: fixture.calls.length };
        });
        assert.equal(retained.same && retained.focus && retained.checked, true); assert.equal(retained.top, retained.afterTop); assert.equal(retained.before, retained.after); assert.equal(await page.evaluate(() => fixture.writes), 0);
    });
    assert.deepEqual(errors, []); assert.equal(external, 0);
    console.log(JSON.stringify({ passed: checks.length, checks, failures, errors, external, productionDataRead: false, scope: 'actual view, import/registry contracts, native Blob download; isolated Map journal, no real ST storage or physical device' }));
    if (failures.length) process.exitCode = 1;
} finally { clearTimeout(deadline); await context.close(); await browser.close(); }
