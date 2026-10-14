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
        if (/^\/qianmu-[a-z0-9-]+\.css$/.test(url.pathname)) return route.fulfill({ contentType: 'text/css', body: await readFile(new URL('..' + url.pathname, import.meta.url), 'utf8') });
        if (url.pathname === '/favicon.ico') return route.fulfill({ status: 204 });
    }
    externalRequests++; return route.abort();
});
try {
    await page.goto('https://qianmu.test/');
    await page.addStyleTag({content:await readFile(new URL('../style.css',import.meta.url),'utf8')+'\n'+await readFile(new URL('../qianmu-theme-skins.css',import.meta.url),'utf8')+'\ntextarea:focus{outline:4px solid red!important;box-shadow:0 0 3px red!important}'});
    await page.evaluate(async () => {
        const { mountQianmuInputBoundary } = await import('/qianmu-input-boundary.js');
        const root = document.querySelector('#root'), editor = document.querySelector('#editor'), host = document.querySelector('#host');
        root.dataset.qmTheme='editorial';root.style.setProperty('--qm-ink','#333');
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
    assert.deepEqual(await page.locator('#editor').evaluate(node=>({outline:getComputedStyle(node).outlineStyle,shadow:getComputedStyle(node).boxShadow})),{outline:'none',shadow:'none'});
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
    assert.equal(await page.locator('#own-button').evaluate(node=>getComputedStyle(node).outlineWidth),'2px','buttons retain keyboard focus, unlike text editors');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'own-button');
    const isolated = await page.evaluate(() => ({ ...window.result, sameOff: window.sameOff }));
    assert.equal(isolated.hostKeys, 0); assert.equal(isolated.hostInputs, 0); assert.equal(isolated.hostClipboard, 0);
    assert.ok(isolated.ownKeys > 0 && isolated.ownInputs > 0 && isolated.rootKeys > isolated.ownKeys);
    assert.equal(isolated.sameOff, true);
    await page.locator('#host').fill('宿主仍正常');
    assert.equal(await page.locator('#host').evaluate(node=>getComputedStyle(node).outlineWidth),'4px','host ST editor focus remains untouched');
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
    // Exercise actual theme surfaces and the shared CSS in all owned control
    // containers. No host configuration, real popup, or provider is used.
    await page.addStyleTag({ content: ':is(button,input,select,textarea,summary,a):focus{outline:4px solid black!important} :is(input,select,textarea):focus{box-shadow:0 0 3px black!important} [data-focus-fixture]{position:relative!important;display:block!important;inset:auto!important;transform:none!important;width:100%!important;height:auto!important}' });
    await page.keyboard.press('Tab');
    const focusChecks = await page.evaluate(async () => {
        const { createQianmuAppearanceSession } = await import('/qianmu-appearance-session.js');
        const { updateAppearancePreferences } = await import('/qianmu-appearance-settings.js');
        let settings = { theme: 'light' }, checks = 0;
        const session = createQianmuAppearanceSession({ readSettings: () => settings, loadStyles: () => ({ promise: Promise.resolve(true), cancel() {} }), loadFont: () => ({ promise: Promise.resolve(true), cancel() {} }) });
        const roots = ['story-director-modal', 'sd-reader-portal', 'qianmu-notes-panel-layer', 'boundary', 'theme-portal', 'lightbox', 'assistant'].map(kind => {
            const root = document.createElement('section'); root.dataset.focusFixture = kind;
            if (kind.includes('portal') || kind.startsWith('story-') || kind.startsWith('qianmu-')) root.id = kind;
            if (kind === 'boundary') root.dataset.qmInputBoundary = '';
            if (kind === 'lightbox') root.className = 'sd-storyboard-lightbox';
            if (kind === 'assistant') root.className = 'qm-prose-assistant-dialog';
            root.style.setProperty('--sd-accent', '#7187a8');
            root.innerHTML = '<div class="sd-storyboard-root"><input class="sd-input" value="API"><input type="number" value="3"><select class="sd-select"><option>预设 / 模型</option></select><textarea class="sd-textarea">编辑内容</textarea><div contenteditable="true" tabindex="0">富文本</div><button class="sd-btn">保存</button><input type="checkbox"><input type="radio"><input type="range"><details><summary>折叠</summary></details><a href="#">查看</a></div><div class="sd-geo-stage"><button>世界</button></div><button class="sd-theme-swatch active"><span>主题</span></button>';
            document.body.append(root); session.mountPortal(root); return root;
        });
        function check(condition, message) { if (!condition) throw Error(message); checks++; }
        function accentOf(node) {
            const probe = document.createElement('i'); probe.style.color = 'var(--sd-accent, var(--qm-accent, #7187a8))'; node.append(probe);
            const color = getComputedStyle(probe).color; probe.remove(); return color;
        }
        for (const family of ['classic', 'editorial', 'glass']) for (const mode of ['light', 'dark']) {
            settings = { ...settings, theme: mode, appearance: updateAppearancePreferences(settings, { family, mode }) }; await session.sync();
            for (const root of roots) {
                root.classList.toggle('sd-theme-light', mode === 'light'); root.classList.toggle('sd-theme-dark', mode === 'dark');
                const label = `${family}/${mode}/${root.dataset.focusFixture}`;
                for (const field of root.querySelectorAll('input:not([type="checkbox"]):not([type="radio"]):not([type="range"]),select,textarea,[contenteditable]')) {
                    field.focus(); const style = getComputedStyle(field);
                    check(document.activeElement === field && style.outlineStyle === 'none' && style.boxShadow === 'none', `${label}: ${field.tagName} editing frame is neutral`);
                }
                for (const control of root.querySelectorAll('button,input[type="checkbox"],input[type="radio"],input[type="range"],summary,a')) {
                    control.focus(); const style = getComputedStyle(control);
                    const accent = accentOf(control.parentElement);
                    check(control.matches(':focus-visible') && style.outlineStyle === 'solid' && style.outlineColor === accent, `${label}: ${control.tagName} retains accent keyboard cue (${style.outlineColor} vs ${accent})`);
                }
                if (root.id === 'story-director-modal') check(getComputedStyle(root.querySelector('.sd-theme-swatch > span')).outlineColor === accentOf(root), `${label}: selected swatch uses accent`);
            }
        }
        document.querySelector('#host').focus();
        check(getComputedStyle(document.querySelector('#host')).outlineColor === 'rgb(0, 0, 0)', 'host black focus remains outside Qianmu ownership');
        session.reset(); roots.forEach(root => root.remove()); return checks;
    });
    assert.equal(externalRequests, 0); assert.deepEqual(errors, []);
    console.log(`PASS: owned bubbling hotkeys, Chinese text, composition events, real clipboard copy/paste, native host input, idempotency, appearance reset and ${focusChecks} theme/control focus checks (offline fixture only).`);
} finally { await context.close(); await browser.close(); }
