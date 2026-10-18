// Production controller/view/source parser/FontFace runtime, synthetic ST only.
// Font bytes come from a local system font; all network routes are intercepted.
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.QIANMU_PLAYWRIGHT_MODULE || 'playwright');
const bytes = await readFile(process.env.QIANMU_FONT_FIXTURE || 'C:/Windows/Fonts/arial.ttf');
const browser = await chromium.launch({ channel: process.env.QIANMU_BROWSER_CHANNEL || undefined, headless: true });
const context = await browser.newContext({ viewport: { width: 393, height: 850 }, serviceWorkers: 'block' });
const page = await context.newPage(), checks = [], errors = [], unexpected = [];
const qa = new URL('../dist/local-qa/font-library/', import.meta.url); await mkdir(qa, { recursive: true });
const deadline = setTimeout(() => { void browser.close(); }, 60000);
page.on('pageerror', error => errors.push(error.message));
await context.route('**/*', async route => {
    const url = new URL(route.request().url()), cors = { 'access-control-allow-origin': '*', 'cache-control': 'no-store' };
    if (url.origin === 'https://qianmu.test' && url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><body></body>' });
    if (url.origin === 'https://qianmu.test' && /^(?:\/style\.css|\/qianmu-[a-z0-9-]+\.(?:js|css))$/.test(url.pathname)) return route.fulfill({ contentType: url.pathname.endsWith('.css') ? 'text/css' : 'text/javascript', body: await readFile(new URL('..' + url.pathname, import.meta.url)) });
    if (url.origin === 'https://fonts.test' && url.pathname.endsWith('.css')) return route.fulfill({ headers: cors, contentType: 'text/css', body: '@font-face{font-family:"Fixture Web";src:url("./fixture.ttf") format("truetype");font-weight:400;font-style:normal}body{color:rgb(255,0,255)!important}' });
    if (url.origin === 'https://fonts.test' && url.pathname.endsWith('.ttf')) return route.fulfill({ headers: cors, contentType: 'font/ttf', body: bytes });
    unexpected.push(route.request().url()); return route.abort();
});
const record = name => checks.push(name);
const settled = async () => { await page.waitForFunction(() => !document.querySelector('[aria-busy="true"]')); };
try {
    await page.goto('https://qianmu.test/');
    for (const file of ['style.css', 'qianmu-theme-skins.css', 'qianmu-font-library.css']) await page.addStyleTag({ content: await readFile(new URL('../' + file, import.meta.url), 'utf8') });
    await page.addStyleTag({ content: ':root{--mainFontFamily:Georgia,serif}body{margin:0;color:rgb(22,33,44);font:24px/1.6 Georgia,serif}button,input,textarea,select{font-family:Georgia,serif}#host-code{font-family:monospace}#host-icon{font-family:FixtureIcon!important}#story-director-floor-nav{inset:0;width:100vw;height:100dvh}#story-director-modal{display:none!important}' });
    await page.evaluate(async () => {
        const { createFontLibrary } = await import('./qianmu-font-library.js');
        const { createQianmuAppearanceSession } = await import('./qianmu-appearance-session.js');
        const { updateAppearancePreferences } = await import('./qianmu-appearance-settings.js');
        window.saved = 0; window.downloads = []; window.notifications = []; window.acceptDelete = true;
        window.owner = {};
        document.body.classList.add('sd-prose-layout');
        document.body.innerHTML = '<aside id="host"><button id="host-button">ST 界面</button><input id="host-input" value="ST 输入"><i id="host-icon" class="fa-solid">★</i></aside><div id="chat"><div class="mes"><div class="mes_text"><p id="host-prose">正文 ABC</p><code id="host-code">const x = 1;</code></div></div></div><div id="story-director-modal"></div><div id="story-director-floor-nav"><div class="sd-floor-shell"><section class="sd-floor-panel"><header><div><h3>楼层工具</h3><p>共 12 层</p></div><button type="button" class="sd-floor-close">×</button></header><nav class="sd-floor-tabs"><button>楼层跳转</button><button>正文排版</button></nav><section class="sd-floor-view"><div class="qm-font-entry"><span>字体</span><small data-font-library-summary>沿用原生字体</small><button data-font-library>字体库</button></div><p>原排版控件</p></section></section></div></div>';
        window.theme = { theme: 'light', appearance: updateAppearancePreferences({}, { family: 'classic', mode: 'light' }) };
        window.appearance = createQianmuAppearanceSession({ readSettings: () => theme, loadStyles: () => ({ promise: Promise.resolve(true), cancel() {} }), loadFont: () => ({ promise: Promise.resolve(false), cancel() {} }) });
        appearance.mount(document.getElementById('story-director-modal')); appearance.mountPortal(document.getElementById('story-director-floor-nav')); await appearance.sync();
        window.setTheme = async (family, mode) => { theme = { theme: mode, appearance: updateAppearancePreferences({}, { family, mode }) }; await appearance.sync(); };
        window.library = createFontLibrary({ getOwner: () => owner, resolveNamespace: async () => 'st-user:synthetic-font-browser', isCurrent: () => true,
            save: () => { saved++; }, download: async (blob, name) => { downloads.push({ name, text: await blob.text() }); }, confirm: async () => acceptDelete,
            notify: message => notifications.push(message), document });
        library.attach(document.getElementById('story-director-floor-nav'));
        window.hostFonts = () => Object.fromEntries(['host-button', 'host-input', 'host-prose', 'host-code', 'host-icon'].map(id => [id, { family: getComputedStyle(document.getElementById(id)).fontFamily, size: getComputedStyle(document.getElementById(id)).fontSize }]));
        window.before = hostFonts();
        const mixed = document.createElement('div'); mixed.className = 'mes';
        mixed.innerHTML = '<div class="mes_text"><p id="mixed-prose">普通正文 ABC</p><div class="np-min-card" style="font-family:Georgia,serif"><p id="mixed-card">富卡保持原样</p></div><p id="mixed-tail">普通收尾 ABC</p></div>';
        document.getElementById('chat').appendChild(mixed);
    });
    await page.locator('[data-font-library]').click(); await page.locator('[data-font-web-source]').waitFor();
    assert.equal(await page.locator('.sd-floor-tabs').isVisible(), false); assert.equal(await page.locator('.sd-floor-panel>header h3').textContent(), '字体库');
    await page.locator('[data-font-web-source]').fill('@import url("https://fonts.test/library.css");');
    await page.locator('[data-font-web-name]').fill('Web 样本'); await page.locator('[data-font-action="add-web"]').click(); await settled();
    await page.waitForFunction(() => document.querySelectorAll('[data-font-sample]').length === 1 && ![...document.querySelectorAll('[data-font-load-state]')].some(node => node.textContent.includes('加载中')));
    const webId = await page.evaluate(() => owner.fontLibrary.fonts[0].id);
    assert.deepEqual(await page.evaluate(() => hostFonts()), await page.evaluate(() => before));
    assert.equal(await page.evaluate(() => document.querySelectorAll('[data-qianmu-font-runtime]').length), 0);
    assert.equal(await page.evaluate(() => getComputedStyle(document.body).color), 'rgb(22, 33, 44)');
    record('Real Web CSS parsing and FontFace list preview leave all host fonts/sizes and external non-font CSS untouched');
    await page.locator('[data-font-preview]').fill('ABC Custom preview 123');
    await page.locator(`[data-font-action="apply"][data-font-target="body"]`).click(); await settled();
    await page.waitForFunction(() => getComputedStyle(document.getElementById('host-prose')).fontFamily.includes('QianmuFont_'));
    const bodyOnly = await page.evaluate(() => hostFonts());
    assert.ok(bodyOnly['host-prose'].family.includes('QianmuFont_')); assert.equal(bodyOnly['host-button'].family, 'Georgia, serif');
    assert.equal(bodyOnly['host-code'].family, 'monospace'); assert.equal(bodyOnly['host-icon'].family, 'FixtureIcon'); assert.equal(bodyOnly['host-prose'].size, '24px');
    const mixed = await page.evaluate(() => Object.fromEntries(['mixed-prose', 'mixed-tail', 'mixed-card'].map(id => [id, getComputedStyle(document.getElementById(id)).fontFamily])));
    assert.ok(mixed['mixed-prose'].includes('QianmuFont_')); assert.ok(mixed['mixed-tail'].includes('QianmuFont_')); assert.equal(mixed['mixed-card'], 'Georgia, serif');
    record('Mixed message without prose wrappers changes ordinary direct paragraphs while authored rich card stays native');
    record('Typing common preview then one Apply click changes only prose family; code/icons/native sizes retained');
    await page.locator(`[data-font-action="apply"][data-font-target="st"]`).click(); await settled();
    await page.waitForFunction(() => getComputedStyle(document.getElementById('host-button')).fontFamily.includes('QianmuFont_'));
    await page.locator('[data-font-mode="shared"]').click(); await settled();
    await page.locator('[data-font-action="apply"][data-font-target="shared"]').click(); await settled();
    assert.ok(await page.evaluate(() => Object.values(hostFonts()).filter(value => value.family.includes('QianmuFont_')).length >= 3));
    await page.locator('[data-font-mode="separate"]').click(); await settled();
    assert.deepEqual(await page.evaluate(() => [owner.fontLibrary.body.fontId, owner.fontLibrary.st.fontId]), [webId, webId]);
    record('Shared and independent modes apply explicitly and preserve both independent choices');
    await page.locator('[data-font-file="local"]').setInputFiles({ name: 'Local Fixture.ttf', mimeType: 'font/ttf', buffer: bytes }); await settled();
    await page.waitForFunction(() => document.querySelectorAll('[data-font-sample]').length === 2);
    assert.equal(await page.evaluate(() => owner.fontLibrary.fonts.filter(font => font.source.kind === 'local').length), 1);
    assert.equal(await page.evaluate(() => JSON.stringify(owner).includes('base64')), false);
    record('Local font upload shares the catalogue while original binary remains out of ST extension settings');
    await page.locator('[data-font-select-page]').check();
    await page.locator('[data-font-bulk-folder]').fill('阅读'); await page.locator('[data-font-action="folder"]').click(); await settled();
    await page.locator('[data-font-bulk-tags]').fill('中文,喜爱'); await page.locator('[data-font-action="tags"]').click(); await settled();
    assert.deepEqual(await page.evaluate(() => owner.fontLibrary.fonts.map(font => [font.folder, font.tags])), [['阅读', ['中文', '喜爱']], ['阅读', ['中文', '喜爱']]]);
    await page.locator('[data-font-action="export-selected"]').click(); await settled(); await page.waitForFunction(() => downloads.length === 1);
    const pack = await page.evaluate(() => downloads[0].text);
    await page.evaluate(() => { acceptDelete = false; }); await page.locator('[data-font-action="delete"]').click(); await settled();
    assert.equal(await page.evaluate(() => owner.fontLibrary.fonts.length), 2);
    await page.evaluate(() => { acceptDelete = true; }); await page.locator('[data-font-action="delete"]').click(); await settled();
    assert.equal(await page.evaluate(() => owner.fontLibrary.fonts.length), 0);
    await page.locator('[data-font-file="import"]').setInputFiles({ name: 'roundtrip.json', mimeType: 'application/json', buffer: Buffer.from(pack) }); await settled();
    await page.waitForFunction(() => document.querySelectorAll('[data-font-sample]').length === 2);
    assert.deepEqual(await page.evaluate(() => owner.fontLibrary.fonts.map(font => [font.folder, font.tags])), [['阅读', ['中文', '喜爱']], ['阅读', ['中文', '喜爱']]]);
    assert.equal(await page.evaluate(() => owner.fontLibrary.body.enabled), false);
    record('Multi-select folder/tags, complete Web+local export/import, cancellation and explicit remove round-trip without auto-applying imports');
    for (const width of [320, 393, 1280]) for (const family of ['classic', 'editorial', 'glass']) for (const mode of ['light', 'dark']) {
        await page.setViewportSize({ width, height: 850 }); await page.evaluate(async ({ family, mode }) => setTheme(family, mode), { family, mode });
        const measured = await page.evaluate(() => {
            const host = document.querySelector('.sd-floor-panel>section.qm-font-library'), panel = host.closest('.sd-floor-panel');
            const controls = [...host.querySelectorAll('button,input:not([type=file]),select,textarea')].filter(node => node.offsetParent);
            return { panel: panel.getBoundingClientRect().right <= innerWidth + 1, noOverflow: host.scrollWidth <= host.clientWidth + 1,
                controlsFit: controls.every(node => node.getBoundingClientRect().right <= panel.getBoundingClientRect().right + 1),
                color: getComputedStyle(host.querySelector('[data-font-preview]')).color, bg: getComputedStyle(host.querySelector('[data-font-preview]')).backgroundColor,
                titleSize: getComputedStyle(document.querySelector('.sd-floor-panel>header h3')).fontSize };
        });
        assert.equal(measured.panel, true, `${width}/${family}/${mode} panel fits`); assert.equal(measured.noOverflow, true, `${width}/${family}/${mode} content fits`); assert.equal(measured.controlsFit, true, `${width}/${family}/${mode} controls fit`);
        assert.notEqual(measured.color, measured.bg); assert.equal(measured.titleSize, '17px');
        record(`${width}/${family}/${mode}: floor hierarchy, readable fields, no horizontal clipping`);
        if (width === 393 && mode === 'dark') {
            await page.evaluate(() => { document.querySelector('.sd-floor-panel>section.qm-font-library').scrollTop = 0; });
            await page.screenshot({ path: fileURLToPath(new URL(`${family}-${mode}.png`, qa)) });
        }
    }
    await page.locator('[data-font-action="back"]').click();
    assert.equal(await page.locator('.sd-floor-tabs').isVisible(), true); assert.equal(await page.locator('[data-font-library]').isVisible(), true);
    await page.locator('[data-font-library]').click(); await page.locator('[data-font-preview]').waitFor();
    assert.equal(await page.locator('[data-font-sample]').count(), 2);
    record('One-step return preserves the floor tools and reopening restores the same catalogue');
    await page.evaluate(() => { library.dispose(); appearance.reset(); });
    assert.equal(await page.evaluate(() => document.querySelectorAll('[data-qianmu-font-runtime]').length), 0);
    assert.deepEqual(errors, []); assert.deepEqual(unexpected, []);
    console.log(JSON.stringify({ passed: checks.length, checks, errors, unexpected, actualFontFace: true, realST: false, productionDataRead: false, externalFontRequests: false }));
} finally { clearTimeout(deadline); await context.close(); await browser.close(); }
