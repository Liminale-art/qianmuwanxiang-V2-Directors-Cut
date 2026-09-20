import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.QIANMU_PLAYWRIGHT_MODULE || 'playwright');
const browser = await chromium.launch({ channel: process.env.QIANMU_BROWSER_CHANNEL || undefined, headless: true });
const context = await browser.newContext(), page = await context.newPage();
let externalRequests = 0;
const errors = [];
page.on('pageerror', error => errors.push(error.message));
await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin === 'https://qianmu.test') {
        if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body><textarea id="host"></textarea><section id="root"><textarea id="editor"></textarea><button id="own-button">Own control</button><div contenteditable="true" id="rich"><span>editable</span></div></section></body></html>' });
        if (/^\/qianmu-[a-z0-9-]+\.js$/.test(url.pathname)) return route.fulfill({ contentType: 'text/javascript', body: await readFile(new URL('..' + url.pathname, import.meta.url), 'utf8') });
    }
    externalRequests++; return route.abort();
});
try {
    await page.goto('https://qianmu.test/');
    await page.evaluate(async () => {
        const { mountQianmuInputBoundary } = await import('/qianmu-input-boundary.js');
        const root = document.querySelector('#root'), editor = document.querySelector('#editor'), host = document.querySelector('#host');
        window.result = { hostKeys: 0, hostInputs: 0, ownKeys: 0, ownInputs: 0, rootKeys: 0, hostClipboard: 0 };
        document.addEventListener('keydown', event => { window.result.hostKeys++; if (event.ctrlKey && event.key === 'Enter') host.focus(); });
        for (const type of ['beforeinput', 'input', 'compositionstart', 'compositionupdate', 'compositionend']) document.addEventListener(type, () => window.result.hostInputs++);
        for (const type of ['copy', 'paste', 'cut']) document.addEventListener(type, () => window.result.hostClipboard++);
        editor.addEventListener('keydown', () => window.result.ownKeys++);
        editor.addEventListener('input', () => window.result.ownInputs++);
        window.offBoundary = mountQianmuInputBoundary(root);
        window.sameOff = window.offBoundary === mountQianmuInputBoundary(root);
        root.addEventListener('keydown', () => window.result.rootKeys++);
        editor.focus();
    });
    await page.locator('#editor').press('Control+Enter');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'editor');
    await page.keyboard.insertText('中文输入不串到正文');
    assert.equal(await page.locator('#editor').inputValue(), '中文输入不串到正文');
    await page.locator('#editor').press('Control+A');
    await page.locator('#editor').press('Control+C');
    await page.locator('#editor').press('End');
    await page.locator('#editor').press('Control+V');
    assert.equal(await page.locator('#editor').inputValue(), '中文输入不串到正文中文输入不串到正文');
    const events = await page.evaluate(() => {
        const editor = document.querySelector('#editor');
        return ['compositionstart', 'compositionupdate', 'compositionend'].map(type => {
            const event = new CompositionEvent(type, { bubbles: true, cancelable: true, data: '中文' });
            return { type, accepted: editor.dispatchEvent(event), defaultPrevented: event.defaultPrevented };
        });
    });
    assert.ok(events.every(event => event.accepted && !event.defaultPrevented));
    await page.locator('#own-button').press('Control+Enter');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'own-button');
    const isolated = await page.evaluate(() => ({ ...window.result, sameOff: window.sameOff }));
    assert.equal(isolated.hostKeys, 0); assert.equal(isolated.hostInputs, 0); assert.equal(isolated.hostClipboard, 0);
    assert.ok(isolated.ownKeys > 0 && isolated.ownInputs > 0 && isolated.rootKeys > isolated.ownKeys);
    assert.equal(isolated.sameOff, true);
    await page.locator('#host').fill('宿主仍正常');
    assert.ok(await page.evaluate(() => window.result.hostInputs > 0));
    await page.evaluate(() => { window.offBoundary(); window.offBoundary(); });
    await page.locator('#editor').press('Control+Enter');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'host');
    const reset = await page.evaluate(async () => {
        const { createQianmuAppearanceSession } = await import('/qianmu-appearance-session.js');
        const root = document.querySelector('#root');
        const session = createQianmuAppearanceSession({ readSettings: () => ({ theme: 'light' }) });
        session.mountPortal(root);
        const dispatch = () => { const before = window.result.hostKeys; root.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true })); return window.result.hostKeys - before; };
        const mounted = dispatch(); session.reset(); return { mounted, reset: dispatch() };
    });
    assert.deepEqual(reset, { mounted: 0, reset: 1 });
    assert.equal(externalRequests, 0); assert.deepEqual(errors, []);
    console.log('PASS: owned bubbling hotkeys, Chinese text, composition events, real clipboard copy/paste, native host input, idempotency and appearance reset (offline fixture only).');
} finally { await context.close(); await browser.close(); }
