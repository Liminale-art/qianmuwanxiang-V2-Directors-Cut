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
let releaseHeld = null, notifyHeld = null;
const qa = new URL('../dist/local-qa/font-library/', import.meta.url); await mkdir(qa, { recursive: true });
const deadline = setTimeout(() => { void browser.close(); }, 90000);
page.on('pageerror', error => errors.push(error.message));
await context.route('**/*', async route => {
    const url = new URL(route.request().url()), cors = { 'access-control-allow-origin': '*', 'cache-control': 'no-store' };
    if (url.origin === 'https://fonts.test' && url.pathname.startsWith('/held-')) await new Promise(resolve => { releaseHeld = resolve; notifyHeld?.(); });
    if (url.origin === 'https://qianmu.test' && url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><body></body>' });
    if (url.origin === 'https://qianmu.test' && /^(?:\/style\.css|\/qianmu-[a-z0-9-]+\.(?:js|css))$/.test(url.pathname)) return route.fulfill({ contentType: url.pathname.endsWith('.css') ? 'text/css' : 'text/javascript', body: await readFile(new URL('..' + url.pathname, import.meta.url)) });
    if (url.origin === 'https://fonts.test' && url.pathname === '/failed-edit.css') return route.fulfill({ status: 503, headers: cors, contentType: 'text/css', body: '' });
    if (url.origin === 'https://fonts.test' && url.pathname === '/ambiguous-edit.css') return route.fulfill({ headers: cors, contentType: 'text/css', body: '@font-face{font-family:"Ambiguous One";src:url("./first.ttf")}@font-face{font-family:"Ambiguous Two";src:url("./second.ttf")}' });
    if (url.origin === 'https://fonts.test' && url.pathname === '/edited.css') return route.fulfill({ headers: cors, contentType: 'text/css', body: '@font-face{font-family:"Fixture Web";src:url("./edited-font.ttf") format("truetype");font-weight:400;font-style:normal}' });
    if (url.origin === 'https://fonts.test' && url.pathname === '/missing.woff2') return route.fulfill({ status: 404, headers: cors, contentType: 'font/woff2', body: '' });
    if (url.origin === 'https://fonts.test' && url.pathname === '/corrupt.woff2') return route.fulfill({ headers: cors, contentType: 'font/woff2', body: Buffer.from('not-a-font-file') });
    if (url.origin === 'https://fonts.test' && url.pathname.endsWith('.css')) return route.fulfill({ headers: cors, contentType: 'text/css', body: '@font-face{font-family:"Fixture Web";src:url("./fixture.ttf") format("truetype");font-weight:400;font-style:normal}body{color:rgb(255,0,255)!important}' });
    if (url.origin === 'https://fonts.test' && url.pathname.endsWith('.ttf')) return route.fulfill({ headers: cors, contentType: 'font/ttf', body: bytes });
    unexpected.push(route.request().url()); return route.abort();
});
const record = name => checks.push(name);
const settled = async () => { await page.waitForFunction(() => !document.querySelector('[aria-busy="true"]')); };
const apply = async (id, target) => { await page.locator(`[data-font-apply="${id}"]`).selectOption(target); await settled(); };
const visibleIconVariants = locator => locator.evaluate(node => [...node.querySelectorAll('[data-qm-icon-variant]')].filter(icon => getComputedStyle(icon).display !== 'none').map(icon => icon.dataset.qmIconVariant));
const setPreviewSize = async value => page.locator('[data-font-preview-size]').selectOption(String(value));
const setAddOpen = async open => { const card = page.locator('details.qm-font-add'); if (await card.evaluate(node => node.open) !== open) await card.locator('summary').click(); };
const startHeldWeb = async name => {
    await setAddOpen(true);
    await page.locator('[data-font-web-name]').fill(name);
    await page.locator('[data-font-web-source]').fill(`https://fonts.test/held-${name}.css`);
    const reached = new Promise(resolve => { notifyHeld = resolve; });
    const priorSaveCount = await page.evaluate(() => saved);
    await page.locator('[data-font-action="add-web"]').click(); await reached;
    assert.equal(await page.locator('[data-font-enabled]').isDisabled(), true, 'Master switch cannot race an in-flight account/font record update');
    return priorSaveCount;
};
try {
    await page.goto('https://qianmu.test/');
    for (const file of ['style.css', 'qianmu-theme-skins.css', 'qianmu-font-library.css']) await page.addStyleTag({ content: await readFile(new URL('../' + file, import.meta.url), 'utf8') });
    await page.addStyleTag({ content: ':root{--mainFontFamily:Georgia,serif}body{margin:0;color:rgb(22,33,44);font:24px/1.6 Georgia,serif}button,input,textarea,select{font-family:Georgia,serif}#host #host-button,#host #host-input,#chat .mes .mes_text,#chat .mes_text p,#chat .mes_text span,#chat .mes_text q,#chat .mes_text em{font-family:Georgia,serif!important}#host-code{font-family:monospace}#host-icon{font-family:FixtureIcon!important}#story-director-floor-nav{inset:0;width:100vw;height:100dvh}#story-director-modal{display:none!important}' });
    await page.evaluate(async () => {
        const { createFontLibrary } = await import('./qianmu-font-library.js');
        const { createFontLocalStore } = await import('./qianmu-font-local-store.js');
        const { createQianmuAppearanceSession } = await import('./qianmu-appearance-session.js');
        const { updateAppearancePreferences } = await import('./qianmu-appearance-settings.js');
        window.saved = 0; window.downloads = []; window.notifications = []; window.localWrites = []; window.acceptDelete = true; window.prosePreviewSize = 19;
        window.owner = {};
        document.body.classList.add('sd-prose-layout');
        document.body.innerHTML = '<aside id="host"><button id="host-button">ST 界面</button><input id="host-input" value="ST 输入"><i id="host-icon" class="fa-solid">★</i><strong id="host-strong">标题</strong></aside><div id="chat"><div class="mes"><div class="mes_text"><p id="host-prose">正文 ABC <em id="host-em">斜体</em><strong id="host-bold">粗体</strong></p><code id="host-code">const x = 1;</code></div></div></div><div id="story-director-modal"><section class="sd-window"><header class="sd-header"><h2 id="main-title">千幕</h2></header></section></div><div id="story-director-floor-nav"><div class="sd-floor-shell"><section class="sd-floor-panel"><header><div><h3>楼层工具</h3><p>共 12 层</p></div><button type="button" class="sd-floor-close">×</button></header><nav class="sd-floor-tabs"><button>楼层跳转</button><button>正文排版</button></nav><section class="sd-floor-view"><div class="qm-font-entry"><small data-font-library-summary>当前：原生字体</small><button data-font-library>字体库</button></div><p>原排版控件</p></section></section></div></div>';
        window.theme = { theme: 'light', appearance: updateAppearancePreferences({}, { family: 'classic', mode: 'light' }) };
        for (const id of ['story-director-modal', 'story-director-floor-nav']) document.getElementById(id).classList.add('sd-theme-light');
        window.appearance = createQianmuAppearanceSession({ readSettings: () => theme, loadStyles: () => ({ promise: Promise.resolve(true), cancel() {} }), loadFont: () => ({ promise: Promise.resolve(false), cancel() {} }) });
        appearance.mount(document.getElementById('story-director-modal')); appearance.mountPortal(document.getElementById('story-director-floor-nav')); await appearance.sync();
        window.setTheme = async (family, mode) => { theme = { theme: mode, appearance: updateAppearancePreferences({}, { family, mode }) }; appearance.repaintClassic(); await appearance.sync(); };
        const floor = document.getElementById('story-director-floor-nav');
        floor.insertAdjacentHTML('afterbegin', '<div class="sd-floor-backdrop"></div>');
        window.closeSyntheticFloor = () => { window.closedPanels = (window.closedPanels || 0) + 1; library.detach(); floor.remove(); };
        // Mirror the existing floor navigator's scoped backdrop binding; the
        // font library must not add a global close listener or intercept input.
        floor.querySelector('.sd-floor-backdrop').addEventListener('click', closeSyntheticFloor);
        window.createSyntheticLibrary = () => createFontLibrary({ getOwner: () => owner, resolveNamespace: async () => 'st-user:synthetic-font-browser', isCurrent: () => true,
            getPreviewFontSize: () => prosePreviewSize,
            localStoreFactory: options => { const store = createFontLocalStore(options); return { ...store, put: async (...args) => { localWrites.push(args[0]); return store.put(...args); } }; },
            save: () => { saved++; }, download: async (blob, name) => { downloads.push({ name, text: await blob.text() }); }, confirm: async () => acceptDelete,
            closePanel: () => closeSyntheticFloor(),
            notify: message => notifications.push(message), document });
        window.library = createSyntheticLibrary();
        library.attach(document.getElementById('story-director-floor-nav'));
        window.hostFonts = () => Object.fromEntries(['host-button', 'host-input', 'host-prose', 'host-code', 'host-icon'].map(id => [id, { family: getComputedStyle(document.getElementById(id)).fontFamily, size: getComputedStyle(document.getElementById(id)).fontSize }]));
        window.before = hostFonts();
        const mixed = document.createElement('div'); mixed.className = 'mes';
        mixed.innerHTML = '<div class="mes_text"><p id="mixed-prose">普通正文 ABC</p><div class="np-min-card" style="font-family:Georgia,serif"><p id="mixed-card">富卡保持原样</p></div><p id="mixed-tail">普通收尾 ABC</p></div>';
        document.getElementById('chat').appendChild(mixed);
    });
    assert.match(await page.locator('[data-font-library-summary]').textContent(), /^当前：/);
    assert.equal(await page.locator('.qm-font-entry>span').count(), 0);
    await page.locator('[data-font-library]').click(); await page.locator('[data-font-web-source]').waitFor();
    assert.equal(await page.locator('.sd-floor-panel').isVisible(), false); assert.equal(await page.locator('.qm-font-window>.sd-header h2').textContent(), '字体库管理');
    assert.equal(await page.locator('.qm-font-mode,.qm-font-application,.qm-font-storage-note,.qm-font-note').count(), 0);
    assert.equal(await page.locator('[data-font-action="back"] .qm-glyph-svg').count(), 1);
    assert.equal(await page.locator('[data-font-action="close"]').count(), 0);
    assert.equal(await page.locator('.qm-font-header').evaluate(node => node.lastElementChild.matches('[data-font-action="back"]')), true, 'Only the trailing return action remains in the header');
    assert.equal(await page.locator('[data-font-enabled]').isChecked(), true, 'Old active assignments remain enabled by default');
    assert.equal(await page.locator('details.qm-font-add').evaluate(node => node.open), true, 'An empty catalogue initially expands its combined add-font card');
    assert.equal(await page.locator('details.qm-font-add summary').textContent(), '添加字体');
    assert.equal(await page.locator('details.qm-font-add .qm-font-imports').count(), 1, 'Web and all three file actions share one collapsible add card');
    assert.equal(await page.locator('[data-font-web-name]').isVisible(), true);
    assert.equal(await page.locator('[data-font-web-source]').isVisible(), true);
    assert.equal(await page.locator('[data-font-preview]').inputValue(), '一蝶振翅，万象入幕。');
    record('Library reuses themed icon rendering and removes duplicate application panels and persistent explanatory notes');
    await page.locator('[data-font-web-source]').fill('@import url("https://fonts.test/library.css");');
    await page.locator('[data-font-web-tags]').fill('初始, 中文,初始');
    await page.locator('[data-font-web-name]').fill('Web 样本'); await page.locator('[data-font-action="add-web"]').click(); await settled();
    await page.waitForFunction(() => document.querySelectorAll('[data-font-sample]').length === 1 && ![...document.querySelectorAll('[data-font-load-state]')].some(node => node.textContent.includes('加载中')));
    const webId = await page.evaluate(() => owner.fontLibrary.fonts[0].id);
    assert.deepEqual(await page.evaluate(() => owner.fontLibrary.fonts[0].tags), ['初始', '中文']);
    await page.evaluate(() => { library.dispose(); library = createSyntheticLibrary(); library.attach(document.getElementById('story-director-floor-nav')); });
    await page.locator('[data-font-library]').click(); await page.locator('[data-font-preview-size]').waitFor();
    assert.equal(await page.locator('details.qm-font-add').evaluate(node => node.open), false, 'A fresh session with existing fonts defaults to a collapsed add card');
    await setAddOpen(true); assert.equal(await page.locator('[data-font-web-tags]').isVisible(), true);
    await setAddOpen(false); assert.equal(await page.locator('[data-font-web-tags]').isVisible(), false);
    assert.equal(await page.evaluate(() => window.closedPanels || 0), 0);
    record('The add card starts expanded only for an empty library, folds existing-library controls together and never mistakes internal toggles for an outside close');
    assert.equal(await page.locator('[data-font-preview-size]').inputValue(), '19');
    assert.deepEqual(await page.locator('[data-font-preview-size] option:not(:disabled)').evaluateAll(nodes => nodes.map(node => Number(node.value))), [12, 14, 16, 18, 20]);
    assert.equal(await page.locator('[data-font-preview-size] option:checked').evaluate(node => node.disabled), true, 'The prose-derived 19px initial value is preserved as a non-selectable current value');
    assert.equal(await page.locator('[data-font-sample]').evaluate(node => getComputedStyle(node).fontSize), '19px');
    assert.equal(await page.locator(`[data-font-apply="${webId}"] option:checked`).textContent(), '应用');
    assert.deepEqual(await page.locator(`[data-font-apply="${webId}"] option:not([value=""])`).allTextContents(), ['正文', 'ST界面', '全部']);
    assert.equal(await page.locator('[data-font-action="weight"],[data-font-style]').count(), 0, 'Fixed-weight, single-style fonts have no unusable variant buttons');
    assert.equal(await page.locator('[data-font-action="more"]').count(), 0, 'Fixed-variant fonts expose edit/remove/apply without a redundant more step');
    assert.equal(await page.locator(`[data-font-action="edit"][data-font-id="${webId}"]`).isVisible(), true);
    assert.equal(await page.locator(`[data-font-action="delete-one"][data-font-id="${webId}"]`).isVisible(), true);
    assert.deepEqual(await visibleIconVariants(page.locator('.qm-font-apply-pick')), ['outline']);
    assert.equal(await page.locator('.qm-font-apply-pick').getAttribute('data-applied'), 'false');
    assert.deepEqual(await page.evaluate(() => hostFonts()), await page.evaluate(() => before));
    assert.equal(await page.evaluate(() => document.querySelectorAll('[data-qianmu-font-runtime]').length), 0);
    assert.equal(await page.evaluate(() => getComputedStyle(document.body).color), 'rgb(22, 33, 44)');
    record('Real Web CSS parsing and FontFace list preview leave all host fonts/sizes and external non-font CSS untouched');
    const beforePreviewSizeSave = await page.evaluate(() => saved);
    await setPreviewSize(20);
    assert.equal(await page.locator('[data-font-sample]').evaluate(node => getComputedStyle(node).fontSize), '20px');
    assert.deepEqual(await page.evaluate(() => hostFonts()), await page.evaluate(() => before));
    assert.equal(await page.evaluate(() => saved), beforePreviewSizeSave, 'Preview-only size is session state, not a host typography setting');
    await page.locator('[data-font-action="back"]').click(); await page.locator('[data-font-library]').click();
    await page.locator('[data-font-preview-size]').waitFor();
    assert.equal(await page.locator('[data-font-preview-size]').inputValue(), '20');
    assert.equal(await page.locator('[data-font-sample]').evaluate(node => getComputedStyle(node).fontSize), '20px');
    assert.equal(await page.locator('details.qm-font-add').evaluate(node => node.open), false, 'Returning keeps the explicitly collapsed add card collapsed');
    await setAddOpen(true);
    await page.locator('[data-font-action="back"]').click(); await page.locator('[data-font-library]').click();
    await page.locator('[data-font-preview-size]').waitFor();
    assert.equal(await page.locator('details.qm-font-add').evaluate(node => node.open), true, 'Returning also preserves an explicitly expanded add card');
    record('Sample size begins at the prose-setting default, changes only list samples and survives return/reopen within the same account');
    await page.locator('[data-font-preview]').fill('ABC Custom preview 123');
    await apply(webId, 'body');
    assert.equal(await page.locator(`[data-font-apply="${webId}"] option:checked`).textContent(), '正文');
    assert.deepEqual(await visibleIconVariants(page.locator('.qm-font-apply-pick')), ['bold']);
    assert.equal(await page.locator('.qm-font-apply-pick').getAttribute('data-applied'), 'true');
    await page.waitForFunction(() => getComputedStyle(document.getElementById('host-prose')).fontFamily.includes('QianmuFont_'));
    const bodyOnly = await page.evaluate(() => hostFonts());
    assert.ok(bodyOnly['host-prose'].family.includes('QianmuFont_')); assert.equal(bodyOnly['host-button'].family, 'Georgia, serif');
    assert.equal(bodyOnly['host-code'].family, 'monospace'); assert.equal(bodyOnly['host-icon'].family, 'FixtureIcon'); assert.equal(bodyOnly['host-prose'].size, '24px');
    assert.deepEqual(await page.evaluate(() => [getComputedStyle(document.getElementById('host-em')).fontStyle, getComputedStyle(document.getElementById('host-bold')).fontWeight]), ['italic', '700']);
    const metrics = await page.evaluate(() => {
        const family = getComputedStyle(document.getElementById('host-prose')).fontFamily, canvas = document.createElement('canvas'), ctx = canvas.getContext('2d');
        ctx.font = `24px ${family}`; const applied = ctx.measureText('WIDE fi AV 0123456789').width;
        ctx.font = '24px Georgia'; return { applied, native: ctx.measureText('WIDE fi AV 0123456789').width, loaded: document.fonts.check(`24px ${family.split(',')[0]}`, 'WIDE') };
    });
    assert.ok(metrics.loaded && Math.abs(metrics.applied - metrics.native) > 1, 'Actual font glyph metrics change, not just a synthetic family name');
    assert.equal(await page.locator('[data-font-style]').count(), 0, 'Single-style fonts do not show a redundant style chooser');
    assert.equal(await page.locator('.qm-font-source').count(), 0, 'Source labels no longer compete with entry titles');
    const mixed = await page.evaluate(() => Object.fromEntries(['mixed-prose', 'mixed-tail', 'mixed-card'].map(id => [id, getComputedStyle(document.getElementById(id)).fontFamily])));
    assert.ok(mixed['mixed-prose'].includes('QianmuFont_')); assert.ok(mixed['mixed-tail'].includes('QianmuFont_')); assert.equal(mixed['mixed-card'], 'Georgia, serif');
    record('Mixed message without prose wrappers changes ordinary direct paragraphs while authored rich card stays native');
    record('Typing common preview then one Apply action overrides prior high-priority prose fonts; code/icons/native sizes retained');
    await apply(webId, 'st');
    await page.waitForFunction(() => getComputedStyle(document.getElementById('host-button')).fontFamily.includes('QianmuFont_'));
    record('ST application reaches controls with prior high-priority font rules without changing their sizes');
    await apply(webId, 'shared');
    assert.equal(await page.locator(`[data-font-apply="${webId}"] option:checked`).textContent(), '全部');
    assert.ok(await page.evaluate(() => Object.values(hostFonts()).filter(value => value.family.includes('QianmuFont_')).length >= 3));
    await apply(webId, 'body');
    assert.deepEqual(await page.evaluate(() => [owner.fontLibrary.body.fontId, owner.fontLibrary.st.fontId]), [webId, webId]);
    record('Shared and independent modes apply explicitly and preserve both independent choices');
    const selectedBeforeDisable = await page.evaluate(() => ({ fonts: owner.fontLibrary.fonts, body: owner.fontLibrary.body, st: owner.fontLibrary.st, shared: owner.fontLibrary.shared }));
    await page.locator('[data-font-enabled]').uncheck(); await settled();
    assert.equal(await page.evaluate(() => document.querySelectorAll('[data-qianmu-font-runtime]').length), 0, 'Disabling the master switch removes active font CSS');
    assert.deepEqual(await page.evaluate(() => hostFonts()), await page.evaluate(() => before));
    assert.equal(await page.evaluate(() => owner.fontLibrary.enabled), false);
    assert.deepEqual(await page.evaluate(() => ({ fonts: owner.fontLibrary.fonts, body: owner.fontLibrary.body, st: owner.fontLibrary.st, shared: owner.fontLibrary.shared })), selectedBeforeDisable);
    assert.ok((await page.locator('[data-font-sample]').evaluate(node => getComputedStyle(node).fontFamily)).includes('QianmuFont_'));
    await apply(webId, 'shared');
    assert.equal(await page.evaluate(() => owner.fontLibrary.enabled), false, 'Changing an assignment while off never secretly enables the library');
    assert.equal(await page.evaluate(() => document.querySelectorAll('[data-qianmu-font-runtime]').length), 0);
    assert.equal(await page.locator(`[data-font-apply="${webId}"] option:checked`).textContent(), '全部');
    await page.locator('[data-font-enabled]').check(); await settled();
    assert.equal(await page.evaluate(() => owner.fontLibrary.enabled), true);
    assert.ok((await page.evaluate(() => hostFonts()['host-prose'].family)).includes('QianmuFont_'));
    assert.ok((await page.evaluate(() => hostFonts()['host-button'].family)).includes('QianmuFont_'));
    assert.deepEqual(await page.evaluate(() => ({ fonts: owner.fontLibrary.fonts, body: owner.fontLibrary.body, st: owner.fontLibrary.st, shared: owner.fontLibrary.shared })), selectedBeforeDisable);
    assert.equal(await page.locator('[data-font-apply] option[value="restore-body"]').count(), 0, 'Body restore is replaced by the global enable control');
    record('Master off immediately removes host CSS while keeping all records and scope choices; preview and selection stay usable, and enabling restores the chosen scopes');
    await setAddOpen(true);
    const beforeLocalSelection = await page.evaluate(() => ({ state: owner.fontLibrary, writes: localWrites.length, saved }));
    await page.locator('[data-font-file="local"]').setInputFiles({ name: 'Local Fixture.ttf', mimeType: 'font/ttf', buffer: bytes }); await settled();
    await page.locator('[data-font-local-dialog]').waitFor();
    assert.deepEqual(await page.evaluate(() => ({ state: owner.fontLibrary, writes: localWrites.length, saved })), beforeLocalSelection, 'Selecting a local file opens metadata editing before touching settings or original-byte storage');
    await page.locator('[data-font-local-name="0"]').fill('取消入库');
    await page.locator('[data-font-local-tags="0"]').fill('不要保存');
    await page.locator('[data-font-action="local-cancel"]').click();
    assert.equal(await page.locator('[data-font-local-dialog]').isVisible(), false);
    assert.deepEqual(await page.evaluate(() => ({ state: owner.fontLibrary, writes: localWrites.length, saved })), beforeLocalSelection);
    for (const dismissal of ['escape', 'overlay']) {
        await page.locator('[data-font-file="local"]').setInputFiles([{ name: 'First Fixture.ttf', mimeType: 'font/ttf', buffer: bytes }, { name: 'Second Fixture.ttf', mimeType: 'font/ttf', buffer: bytes }]);
        await page.locator('[data-font-local-dialog]').waitFor();
        assert.equal(await page.locator('[data-font-local-name]').count(), 2, 'Each pending local file has its own editable metadata');
        await page.locator('[data-font-local-name="0"]').fill('第一款待确认');
        await page.locator('[data-font-local-tags="1"]').fill('第二款标签');
        await page.setViewportSize({ width: 320, height: 650 });
        const modalFits = await page.locator('[data-font-local-dialog]').evaluate(node => {
            const rect = node.getBoundingClientRect();
            return rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0 && rect.bottom <= innerHeight && node.scrollWidth <= node.clientWidth + 1;
        });
        assert.equal(modalFits, true, 'The per-file metadata dialog stays inside a narrow mobile viewport');
        assert.equal(await page.locator('.qm-font-window>.sd-body').evaluate(node => node.inert), true, 'Underlying library controls are inert while local metadata awaits confirmation');
        if (dismissal === 'escape') {
            const modalMaterials = [];
            for (const family of ['classic', 'editorial', 'glass']) for (const mode of ['light', 'dark']) {
                await page.evaluate(async ({ family, mode }) => {
                    await setTheme(family, mode);
                    void getComputedStyle(document.querySelector('[data-font-local-dialog]')).backgroundColor;
                    await Promise.all(document.getAnimations().filter(animation => animation.effect?.getComputedTiming().iterations !== Infinity).map(animation => animation.finished.catch(() => {})));
                }, { family, mode });
                const material = await page.locator('[data-font-local-dialog]').evaluate(node => {
                    const style = getComputedStyle(node), canvas = document.createElement('canvas');
                    canvas.width = canvas.height = 1;
                    const context = canvas.getContext('2d'); context.fillStyle = style.backgroundColor; context.fillRect(0, 0, 1, 1);
                    return { background: style.backgroundColor, alpha: context.getImageData(0, 0, 1, 1).data[3], opacity: style.opacity };
                });
                modalMaterials.push({ family, mode, ...material });
                await page.screenshot({ path: fileURLToPath(new URL(`local-upload-${family}-${mode}.png`, qa)) });
            }
            assert.ok(modalMaterials.every(material => material.alpha === 255 && material.opacity === '1'), `Local upload dialogs must be opaque in every theme: ${JSON.stringify(modalMaterials)}`);
            await page.evaluate(async () => {
                await setTheme('classic', 'light');
                void getComputedStyle(document.querySelector('[data-font-local-dialog]')).backgroundColor;
                await Promise.all(document.getAnimations().filter(animation => animation.effect?.getComputedTiming().iterations !== Infinity).map(animation => animation.finished.catch(() => {})));
            });
            await page.screenshot({ path: fileURLToPath(new URL('local-upload-metadata.png', qa)) });
            await page.locator('[data-font-local-name="0"]').focus(); await page.keyboard.press('Shift+Tab');
            assert.equal(await page.locator('[data-font-action="local-confirm"]').evaluate(node => node === document.activeElement), true, 'Reverse Tab remains inside the local metadata dialog');
            await page.keyboard.press('Tab');
            assert.equal(await page.locator('[data-font-local-name="0"]').evaluate(node => node === document.activeElement), true);
            await page.keyboard.press('Escape');
        } else {
            const layer = await page.locator('[data-font-local-layer]').boundingBox();
            const point = { x: layer.x + layer.width / 2, y: layer.y + 6 };
            assert.equal(await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.matches('[data-font-local-layer]'), point), true, 'Overlay dismissal uses a genuine visible backdrop point, outside rounded corners and the dialog');
            await page.mouse.click(point.x, point.y);
        }
        assert.equal(await page.locator('[data-font-local-dialog]').isVisible(), false, `${dismissal}: unconfirmed metadata is dismissed`);
        assert.equal(await page.locator('.qm-font-window>.sd-body').evaluate(node => node.inert), false);
        assert.equal(await page.evaluate(() => window.closedPanels || 0), 0, 'Dismissing local metadata does not close the containing floor tool');
        assert.deepEqual(await page.evaluate(() => ({ state: owner.fontLibrary, writes: localWrites.length, saved })), beforeLocalSelection);
        await page.setViewportSize({ width: 393, height: 850 });
    }
    record('Pending multi-file metadata fits narrow screens, traps focus and cancels through Escape or its own overlay without storing bytes or closing the parent');
    await page.locator('[data-font-file="local"]').setInputFiles({ name: 'Local Fixture.ttf', mimeType: 'font/ttf', buffer: bytes });
    await page.locator('[data-font-local-dialog]').waitFor();
    await page.locator('[data-font-local-name="0"]').fill('Local 自定名称');
    await page.locator('[data-font-local-tags="0"]').fill('本地，手写,本地');
    await page.locator('[data-font-action="local-confirm"]').click(); await settled();
    await page.waitForFunction(() => document.querySelectorAll('[data-font-sample]').length === 2);
    assert.equal(await page.evaluate(() => owner.fontLibrary.fonts.filter(font => font.source.kind === 'local').length), 1);
    assert.deepEqual(await page.evaluate(() => { const font = owner.fontLibrary.fonts.find(item => item.source.kind === 'local'); return [font.name, font.tags, font.source.fileName]; }), ['Local 自定名称', ['本地', '手写'], 'Local Fixture.ttf']);
    assert.equal(await page.evaluate(() => localWrites.length), beforeLocalSelection.writes + 1);
    assert.equal(await page.evaluate(() => JSON.stringify(owner).includes('base64')), false);
    assert.equal(await page.evaluate(() => window.closedPanels || 0), 0, 'Editing or cancelling the local metadata dialog never closes the floor tool');
    record('Local upload defers all settings and byte writes until per-file name/tags are confirmed; cancellation saves nothing');
    record('Local font upload shares the catalogue while original binary remains out of ST extension settings');
    const localId = await page.evaluate(() => owner.fontLibrary.fonts.find(font => font.source.kind === 'local').id);
    await apply(webId, 'body'); await apply(localId, 'st');
    assert.equal(await page.locator(`[data-font-apply="${webId}"] option:checked`).textContent(), '正文');
    assert.equal(await page.locator(`[data-font-apply="${localId}"] option:checked`).textContent(), 'ST界面');
    const independentFonts = await page.evaluate(() => hostFonts());
    assert.ok(independentFonts['host-prose'].family.includes('QianmuFont_') && independentFonts['host-button'].family.includes('QianmuFont_'));
    assert.notEqual(independentFonts['host-prose'].family, independentFonts['host-button'].family);
    record('Independent local and Web choices show concise body/ST labels while applying genuinely different host font families');
    const removalId = await page.evaluate(async () => {
        await library.action('add-web', { name: '单条移除样本', source: 'https://fonts.test/single-remove.ttf' });
        return owner.fontLibrary.fonts.find(font => font.name === '单条移除样本').id;
    });
    const beforeSingleRemoval = await page.evaluate(() => ({ body: owner.fontLibrary.body, st: owner.fontLibrary.st, shared: owner.fontLibrary.shared, fonts: owner.fontLibrary.fonts.filter(font => font.name !== '单条移除样本') }));
    await page.evaluate(() => { acceptDelete = false; });
    await page.locator(`[data-font-action="delete-one"][data-font-id="${removalId}"]`).click(); await settled();
    assert.equal(await page.evaluate(() => owner.fontLibrary.fonts.length), 3, 'Cancelled single removal retains its font record');
    await page.evaluate(() => { acceptDelete = true; });
    await page.locator(`[data-font-action="delete-one"][data-font-id="${removalId}"]`).click(); await settled();
    assert.deepEqual(await page.evaluate(() => ({ body: owner.fontLibrary.body, st: owner.fontLibrary.st, shared: owner.fontLibrary.shared, fonts: owner.fontLibrary.fonts })), beforeSingleRemoval);
    assert.deepEqual(await page.evaluate(() => hostFonts()), independentFonts);
    record('Per-font remove honors cancellation and confirmation, deleting only its target while retaining other records and active scope choices');
    assert.equal(await page.locator('[data-font-select]').first().isVisible(), false);
    await page.locator('[data-font-action="manage"]').click();
    await page.locator('[data-font-action="select-page"]').click();
    assert.equal(await page.locator('[data-font-select]:checked').count(), 2);
    await page.locator('[data-font-action="manage"]').click();
    assert.equal(await page.locator('[data-font-select]:checked').count(), 0);
    assert.equal(await page.locator('[data-font-select]').first().isVisible(), false);
    await page.locator('[data-font-action="manage"]').click();
    await page.locator('.qm-font-card').first().locator('[data-font-sample]').click();
    assert.equal(await page.locator('[data-font-select]:checked').count(), 1);
    await page.locator('[data-font-action="select-page"]').click();
    record('Bookshelf-style management hides checkboxes until requested, supports row selection and clears picks on exit');
    await page.locator('[data-font-action="bulk-folder"]').click(); await page.locator('[data-font-bulk-value]').fill('阅读'); await page.locator('[data-font-action="bulk-save"]').click(); await settled();
    await page.locator('[data-font-action="bulk-tags"]').click(); await page.locator('[data-font-bulk-value]').fill('中文,喜爱'); await page.locator('[data-font-action="bulk-save"]').click(); await settled();
    assert.deepEqual(await page.evaluate(() => owner.fontLibrary.fonts.map(font => [font.folder, font.tags])), [['阅读', ['中文', '喜爱']], ['阅读', ['中文', '喜爱']]]);
    await page.locator('[data-font-action="manage"]').click();
    const beforeWebEdit = await page.evaluate(() => owner.fontLibrary);
    const beforeEditedFamily = await page.evaluate(() => hostFonts()['host-prose'].family);
    await setAddOpen(false);
    await page.locator(`[data-font-action="edit"][data-font-id="${webId}"]`).click();
    assert.equal(await page.locator('details.qm-font-add').evaluate(node => node.open), true, 'Editing a Web entry opens the add card without a second click');
    assert.equal(await page.locator('[data-font-web-name]').inputValue(), 'Web 样本');
    assert.match(await page.locator('[data-font-web-source]').inputValue(), /fonts\.test/);
    assert.deepEqual((await page.locator('[data-font-web-tags]').inputValue()).split(/[,，]/).map(value => value.trim()).filter(Boolean), ['中文', '喜爱']);
    await page.locator('[data-font-web-name]').fill('取消的改名');
    await page.locator('[data-font-web-tags]').fill('取消的标签');
    await page.locator('[data-font-action="cancel-web"]').click();
    assert.deepEqual(await page.evaluate(() => owner.fontLibrary), beforeWebEdit);
    await page.locator(`[data-font-action="edit"][data-font-id="${webId}"]`).click();
    await page.locator('[data-font-web-tags]').fill('中文,新增,新增');
    await page.locator('[data-font-web-source]').fill('https://fonts.test/failed-edit.css');
    await page.locator('[data-font-action="add-web"]').click(); await settled();
    assert.deepEqual(await page.evaluate(() => owner.fontLibrary), beforeWebEdit, 'A failed source fetch cannot damage the existing font');
    assert.equal(await page.locator('[data-font-web-source]').inputValue(), 'https://fonts.test/failed-edit.css');
    assert.equal(await page.locator('[data-font-web-tags]').inputValue(), '中文,新增,新增');
    assert.equal(await page.locator('[data-font-action="cancel-web"]').isVisible(), true);
    await page.locator('[data-font-web-source]').fill('https://fonts.test/ambiguous-edit.css');
    await page.locator('[data-font-action="add-web"]').click(); await settled();
    assert.deepEqual(await page.evaluate(() => owner.fontLibrary), beforeWebEdit, 'Multiple unrelated font families cannot overwrite one original by guesswork');
    for (const path of ['missing.woff2', 'corrupt.woff2']) {
        await page.locator('[data-font-web-source]').fill(`https://fonts.test/${path}`);
        await page.locator('[data-font-action="add-web"]').click(); await settled();
        assert.deepEqual(await page.evaluate(() => owner.fontLibrary), beforeWebEdit, `${path}: a missing or undecodable font binary cannot replace existing records`);
        assert.equal(await page.evaluate(() => hostFonts()['host-prose'].family), beforeEditedFamily, `${path}: the previously applied actual font remains active`);
        assert.equal(await page.locator('[data-font-web-source]').inputValue(), `https://fonts.test/${path}`);
        assert.equal(await page.locator('[data-font-web-tags]').inputValue(), '中文,新增,新增');
        assert.equal(await page.locator('[data-font-action="cancel-web"]').isVisible(), true);
    }
    await page.locator('[data-font-web-name]').fill('Web 样本·已编辑');
    await page.locator('[data-font-web-source]').fill('https://fonts.test/edited.css');
    await page.locator('[data-font-action="add-web"]').click(); await settled();
    const afterWebEdit = await page.evaluate(() => owner.fontLibrary), editedWeb = afterWebEdit.fonts.find(font => font.id === webId), originalWeb = beforeWebEdit.fonts.find(font => font.id === webId);
    assert.equal(editedWeb.name, 'Web 样本·已编辑'); assert.match(JSON.stringify(editedWeb.source), /edited\.css/);
    assert.deepEqual([editedWeb.id, editedWeb.folder], [originalWeb.id, originalWeb.folder]);
    assert.deepEqual(editedWeb.tags, ['中文', '新增']);
    assert.deepEqual([afterWebEdit.enabled, afterWebEdit.mode, afterWebEdit.body, afterWebEdit.st, afterWebEdit.shared], [beforeWebEdit.enabled, beforeWebEdit.mode, beforeWebEdit.body, beforeWebEdit.st, beforeWebEdit.shared]);
    assert.deepEqual(afterWebEdit.fonts.filter(font => font.id !== webId), beforeWebEdit.fonts.filter(font => font.id !== webId));
    assert.equal(await page.locator('[data-font-action="cancel-web"]').isVisible(), false);
    assert.equal(await page.locator('[data-font-web-source]').inputValue(), '');
    assert.equal(await page.locator('[data-font-web-tags]').inputValue(), '');
    await page.waitForFunction(previous => { const family = getComputedStyle(document.getElementById('host-prose')).fontFamily; return family.includes('QianmuFont_') && family !== previous && document.fonts.check(`24px ${family.split(',')[0]}`, 'WIDE'); }, beforeEditedFamily);
    assert.notEqual(await page.evaluate(() => hostFonts()['host-prose'].family), beforeEditedFamily, 'Editing the source of the same record ID activates a newly loaded FontFace, not a stale slot');
    record('Web editing supports populated fields, cancellation and retry; failed or ambiguous sources retain every original record, and successful replacement preserves identity, classifications and active scopes');
    const beforeTagOnly = await page.evaluate(() => ({ state: owner.fontLibrary, fonts: hostFonts() }));
    await page.locator(`[data-font-action="edit"][data-font-id="${webId}"]`).click();
    await page.locator('[data-font-web-tags]').fill('中文，新增,标签续改');
    await page.locator('[data-font-action="add-web"]').click(); await settled();
    const afterTagOnly = await page.evaluate(() => ({ state: owner.fontLibrary, fonts: hostFonts() }));
    assert.deepEqual(afterTagOnly.fonts, beforeTagOnly.fonts, 'Changing only tags does not reload or replace the active font');
    assert.deepEqual(afterTagOnly.state.fonts.find(font => font.id === webId).tags, ['中文', '新增', '标签续改']);
    afterTagOnly.state.fonts.find(font => font.id === webId).tags = beforeTagOnly.state.fonts.find(font => font.id === webId).tags;
    assert.deepEqual(afterTagOnly.state, beforeTagOnly.state);
    record('Editing only Web tags changes just the requested classifications while leaving source, binary face and all other settings intact');
    const beforeRename = await page.evaluate(() => owner.fontLibrary);
    await page.locator(`[data-font-action="edit"][data-font-id="${localId}"]`).click();
    assert.equal(await page.locator(`[data-font-rename-pop="${localId}"]`).isVisible(), true);
    await page.locator(`[data-font-rename="${localId}"]`).fill('未保存的本地改名');
    await page.locator(`[data-font-action="rename-cancel"][data-font-id="${localId}"]`).click();
    assert.deepEqual(await page.evaluate(() => owner.fontLibrary), beforeRename);
    await page.locator(`[data-font-action="edit"][data-font-id="${localId}"]`).click();
    await page.locator(`[data-font-rename="${localId}"]`).fill('Local 已改名');
    await page.locator(`[data-font-action="rename-save"][data-font-id="${localId}"]`).click(); await settled();
    const afterRename = await page.evaluate(() => owner.fontLibrary), renamed = afterRename.fonts.find(font => font.id === localId), originalLocal = beforeRename.fonts.find(font => font.id === localId);
    assert.deepEqual({ ...renamed, name: originalLocal.name }, originalLocal);
    assert.equal(renamed.name, 'Local 已改名');
    assert.deepEqual([afterRename.body, afterRename.st, afterRename.shared], [beforeRename.body, beforeRename.st, beforeRename.shared]);
    record('Local name editing uses a small cancellable panel and changes only the name, not identity, source metadata or applied choices');
    await page.locator('[data-font-action="manage"]').click(); await page.locator('[data-font-action="select-page"]').click();
    await page.locator('[data-font-action="export-selected"]').click(); await settled(); await page.waitForFunction(() => downloads.length === 1);
    const pack = await page.evaluate(() => downloads[0].text);
    assert.ok(Object.values(JSON.parse(pack).localFiles || {}).some(value => typeof value === 'string' && value.length > 100), 'The retained local original is still exported after another font was removed');
    assert.ok(Object.values(JSON.parse(pack).localFiles).some(value => Buffer.from(value, 'base64').equals(bytes)), 'Renaming a local font preserves its original binary byte for byte');
    await page.evaluate(() => { acceptDelete = false; }); await page.locator('[data-font-action="delete"]').click(); await settled();
    assert.equal(await page.evaluate(() => owner.fontLibrary.fonts.length), 2);
    await page.evaluate(() => { acceptDelete = true; }); await page.locator('[data-font-action="delete"]').click(); await settled();
    assert.equal(await page.evaluate(() => owner.fontLibrary.fonts.length), 0);
    await setAddOpen(true);
    await page.locator('[data-font-file="import"]').setInputFiles({ name: 'roundtrip.json', mimeType: 'application/json', buffer: Buffer.from(pack) }); await settled();
    await page.waitForFunction(() => document.querySelectorAll('[data-font-sample]').length === 2);
    assert.deepEqual(await page.evaluate(() => owner.fontLibrary.fonts.map(font => [font.folder, font.tags])), [['阅读', ['中文', '新增', '标签续改']], ['阅读', ['中文', '喜爱']]]);
    assert.equal(await page.evaluate(() => owner.fontLibrary.body.enabled), false);
    record('Multi-select folder/tags, complete Web+local export/import, cancellation and explicit remove round-trip without auto-applying imports');
    if (await page.locator('[data-font-action="manage"]').getAttribute('aria-expanded') === 'true') await page.locator('[data-font-action="manage"]').click();
    await page.locator('[data-font-search]').fill('Web 样本');
    assert.equal(await page.locator('[data-font-sample]').count(), 1);
    await page.locator('[data-font-search]').fill('');
    await page.locator('[data-font-action="filter"]').click();
    await page.locator('[data-font-folder-choice="阅读"]').click();
    assert.equal(await page.locator('[data-font-sample]').count(), 2);
    await page.locator('[data-font-tag="中文"]').click();
    assert.equal(await page.locator('[data-font-sample]').count(), 2);
    await page.locator('[data-font-tag="中文"]').click();
    await page.locator('[data-font-action="filter"]').click();
    await page.locator('[data-font-folder-choice=""]').click();
    record('Bookshelf-style search, folder popup and tag chips filter without applying fonts or changing stored records');
    for (const width of [320, 393, 1280]) for (const family of ['classic', 'editorial', 'glass']) for (const mode of ['light', 'dark']) {
        await setAddOpen(true);
        await page.setViewportSize({ width, height: 850 }); await page.evaluate(async ({ family, mode }) => setTheme(family, mode), { family, mode });
        await page.evaluate(async () => {
            // Theme buttons animate their ink. Inspect the final appearance,
            // not an intermediate light-to-dark color interpolation.
            void getComputedStyle(document.querySelector('.qm-font-file-pick')).color;
            await Promise.all(document.getAnimations().filter(animation => animation.effect?.getComputedTiming().iterations !== Infinity).map(animation => animation.finished.catch(() => {})));
        });
        const measured = await page.evaluate(() => {
            const panel = document.querySelector('.qm-font-window'), host = panel.querySelector('.sd-body');
            const controls = [...host.querySelectorAll('button,input:not([type=file]),select,textarea')].filter(node => node.offsetParent);
            return { panel: panel.getBoundingClientRect().right <= innerWidth + 1, noOverflow: host.scrollWidth <= host.clientWidth + 1,
                controlsFit: controls.every(node => node.getBoundingClientRect().right <= panel.getBoundingClientRect().right + 1),
                color: getComputedStyle(host.querySelector('[data-font-preview]')).color, bg: getComputedStyle(host.querySelector('[data-font-preview]')).backgroundColor,
                titleSize: getComputedStyle(panel.querySelector('.sd-header h2')).fontSize,
                titleFamily: getComputedStyle(panel.querySelector('.sd-header h2')).fontFamily,
                mainTitleFamily: getComputedStyle(document.getElementById('main-title')).fontFamily,
                material: Object.fromEntries(['backgroundImage', 'backgroundColor', 'borderRadius', 'backdropFilter'].map(property => [property, getComputedStyle(panel)[property]])),
                mainMaterial: Object.fromEntries(['backgroundImage', 'backgroundColor', 'borderRadius', 'backdropFilter'].map(property => [property, getComputedStyle(document.querySelector('#story-director-modal>.sd-window'))[property]])),
                titleRows: [...host.querySelectorAll('.qm-font-card-head')].map(node => {
                    const tools = node.querySelector('.qm-font-card-tools'), name = node.querySelector('.qm-font-name'), select = tools?.querySelector('[data-font-apply]');
                    return { tail: !!tools?.lastElementChild?.contains(select), line: !!select && Math.abs(name.getBoundingClientRect().top + name.getBoundingClientRect().height / 2 - select.getBoundingClientRect().top - select.getBoundingClientRect().height / 2) <= 2 };
                }),
                toolbarOrder: [...host.querySelector('.qm-font-toolbar').children].map(node => node.matches('[data-font-search]') ? 'search' : node.querySelector('[data-font-action="filter"]') ? 'folder' : node.matches('[data-font-action="manage"]') ? 'manage' : '?'),
                imports: [...host.querySelector('.qm-font-imports').children].map(node => ({ top: node.getBoundingClientRect().top, height: node.getBoundingClientRect().height, width: node.getBoundingClientRect().width, text: node.textContent.trim(), icons: node.querySelectorAll('.qm-glyph-icon').length })),
                enable: (() => { const node = host.querySelector('.qm-font-enable'), label = node.querySelector('strong,span') || node, style = getComputedStyle(label); return { fontSize: style.fontSize, fontWeight: style.fontWeight }; })(),
                bodyControls: [...host.querySelectorAll('[data-font-web-name],[data-font-web-source],[data-font-web-tags],[data-font-preview],[data-font-search],[data-font-apply],[data-font-preview-size]')].map(node => getComputedStyle(node).fontSize),
                editor: (() => { const editor = host.querySelector('.qm-font-preview-editor').getBoundingClientRect(), card = host.querySelector('.qm-font-card').getBoundingClientRect(); return { left: editor.left - card.left, right: editor.right - card.right }; })(),
                iconShapes: [...panel.querySelectorAll('.qm-font-icon,.qm-font-file-pick')].filter(node => node.offsetParent).map(node => ({ header: !!node.closest('.qm-font-header'), radius: getComputedStyle(node).borderTopLeftRadius, width: node.getBoundingClientRect().width, height: node.getBoundingClientRect().height })),
                filePicks: [...host.querySelectorAll('.qm-font-file-pick')].map(node => ({ color: getComputedStyle(node).color, opacity: getComputedStyle(node).opacity, display: getComputedStyle(node).display, input: { color: getComputedStyle(node.querySelector('input')).color, opacity: getComputedStyle(node.querySelector('input')).opacity, display: getComputedStyle(node.querySelector('input')).display } })),
                exportButton: { color: getComputedStyle(host.querySelector('[data-font-action="export-all"]')).color, opacity: getComputedStyle(host.querySelector('[data-font-action="export-all"]')).opacity, background: getComputedStyle(host.querySelector('[data-font-action="export-all"]')).backgroundColor },
                previewFamilies: [...host.querySelectorAll('[data-font-sample]')].map(node => getComputedStyle(node).fontFamily),
                previewSizes: [...host.querySelectorAll('[data-font-sample]')].map(node => getComputedStyle(node).fontSize),
                manageVariants: [...host.querySelectorAll('[data-font-action="manage"] [data-qm-icon-variant]')].filter(node => getComputedStyle(node).display !== 'none').map(node => node.dataset.qmIconVariant),
                applyVariants: [...host.querySelectorAll('.qm-font-apply-pick [data-qm-icon-variant]')].filter(node => getComputedStyle(node).display !== 'none').map(node => node.dataset.qmIconVariant),
                iconVariants: [...panel.querySelectorAll('[data-font-action="back"] [data-qm-icon-variant]')].filter(node => getComputedStyle(node).display !== 'none').map(node => node.dataset.qmIconVariant) };
        });
        assert.equal(measured.panel, true, `${width}/${family}/${mode} panel fits`); assert.equal(measured.noOverflow, true, `${width}/${family}/${mode} content fits`); assert.equal(measured.controlsFit, true, `${width}/${family}/${mode} controls fit`);
        assert.notEqual(measured.color, measured.bg); assert.equal(measured.titleSize, '14px'); assert.equal(measured.titleFamily, measured.mainTitleFamily);
        assert.deepEqual(measured.material, measured.mainMaterial, `${family}/${mode}: same main-panel surface, corner and filter treatment`);
        assert.ok(measured.titleRows.every(row => row.tail && row.line), `${width}/${family}/${mode} application is the title-tools tail on the same line`);
        assert.deepEqual(measured.toolbarOrder, ['search', 'folder', 'manage']);
        assert.ok(measured.imports.every(item => Math.abs(item.top - measured.imports[0].top) <= 1 && Math.abs(item.height - measured.imports[0].height) <= 1 && Math.abs(item.width - measured.imports[0].width) <= 1 && item.text && !item.icons), `${width}/${family}/${mode} upload, import and export are text-only, equal-width and equal-height`);
        assert.equal(measured.enable.fontSize, '14px'); assert.ok(Number(measured.enable.fontWeight) >= 600);
        assert.ok(measured.bodyControls.every(value => value === '12px'), 'Body controls share the main-panel 12px body tier');
        assert.ok(Math.abs(measured.editor.left) <= 1 && Math.abs(measured.editor.right) <= 1, `${width}/${family}/${mode} preview editor aligns with list-card edges`);
        for (const shape of measured.iconShapes) {
            const circular = shape.radius.includes('%') ? parseFloat(shape.radius) >= 50 : parseFloat(shape.radius) >= Math.min(shape.width, shape.height) / 2 - 1;
            assert.equal(circular, family === 'glass' && shape.header, `${width}/${family}/${mode} only glass header navigation remains circular`);
            if (family === 'editorial') assert.equal(parseFloat(shape.radius), 0, 'Paper action controls keep square corners');
        }
        assert.ok(measured.filePicks.every(pick => pick.opacity === '1' && pick.input.opacity === '0' && pick.color === measured.exportButton.color), 'Native file inputs stay transparent and their labels retain the same readable ink as adjacent actions');
        assert.ok(measured.previewFamilies.every(value => value.includes('QianmuFont_')), `${family} list previews retain selected font despite theme CSS`);
        assert.ok(measured.previewSizes.every(value => value === '20px'), `${family} preview size remains session-local through theme changes`);
        assert.deepEqual(measured.iconVariants, [family === 'editorial' ? 'bold' : family === 'glass' ? 'twotone' : 'outline']);
        assert.deepEqual(measured.manageVariants, ['outline'], 'Management uses the requested fixed document-filter outline icon');
        assert.ok(measured.applyVariants.length === 2 && measured.applyVariants.every(value => value === 'outline'), 'Unapplied state uses tick-square outline regardless of theme');
        record(`${width}/${family}/${mode}: 14px title and capsule, 12px controls, equal text actions, compact previews without clipping`);
        if (width === 393 && mode === 'dark') {
            await page.evaluate(() => { document.querySelector('.qm-font-window>.sd-body').scrollTop = 0; });
            await page.screenshot({ path: fileURLToPath(new URL(`${family}-add-open.png`, qa)) });
            await setAddOpen(false);
            await page.evaluate(() => { document.querySelector('.qm-font-window>.sd-body').scrollTop = 0; });
            await page.screenshot({ path: fileURLToPath(new URL(`${family}-${mode}.png`, qa)) });
            await setAddOpen(true);
        }
    }
    await page.locator('[data-font-action="back"]').click();
    assert.equal(await page.locator('.sd-floor-tabs').isVisible(), true); assert.equal(await page.locator('[data-font-library]').isVisible(), true);
    await page.setViewportSize({ width: 320, height: 850 });
    const entryOverflow = await page.locator('.qm-font-entry').evaluate(node => {
        const summary = node.querySelector('[data-font-library-summary]'), button = node.querySelector('[data-font-library]'), original = summary.textContent;
        summary.textContent = `当前：${'长字体名称用于确认只占一行并保留字库入口'.repeat(8)}`;
        const style = getComputedStyle(summary), value = { whiteSpace: style.whiteSpace, overflow: style.overflow, ellipsis: style.textOverflow, clipped: summary.scrollWidth > summary.clientWidth, buttonFits: button.getBoundingClientRect().right <= node.getBoundingClientRect().right + 1 };
        summary.textContent = original; return value;
    });
    assert.deepEqual(entryOverflow, { whiteSpace: 'nowrap', overflow: 'hidden', ellipsis: 'ellipsis', clipped: true, buttonFits: true });
    record('Long current-font summaries ellipsize on one line and do not push the font-library entry out of narrow floor tools');
    await page.locator('[data-font-library]').click(); await page.locator('[data-font-preview]').waitFor();
    assert.equal(await page.locator('[data-font-sample]').count(), 2);
    record('One-step return preserves the floor tools and reopening restores the same catalogue');
    await page.evaluate(async () => {
        for (let index = 1; index <= 8; index++) await library.action('add-web', { name: `分页 ${index}`, source: `https://fonts.test/page-${index}.ttf` });
    });
    await page.locator('[data-font-search]').fill('不存在的筛选');
    assert.equal(await page.locator('[data-font-sample]').count(), 0);
    await setAddOpen(true);
    await page.locator('[data-font-web-name]').fill('分页 9');
    await page.locator('[data-font-web-source]').fill('https://fonts.test/page-9.ttf');
    await page.locator('[data-font-action="add-web"]').click(); await settled();
    assert.equal(await page.locator('[data-font-search]').inputValue(), '', 'A new addition clears stale filters so the user can see the new font');
    assert.equal(await page.locator('[data-font-sample]').count(), 1, 'Adding on a later page reveals the new font automatically');
    assert.equal(await page.locator('.qm-font-name strong').textContent(), '分页 9');
    assert.equal(await page.locator('.qm-font-card').getAttribute('data-font-revealed'), 'true');
    const revealed = await page.locator('.qm-font-card').evaluate(async node => {
        const body = node.closest('.sd-body'), cardRect = node.getBoundingClientRect(), bodyRect = body.getBoundingClientRect(), animation = getComputedStyle(node).animationName;
        await Promise.all(node.getAnimations().map(item => item.finished.catch(() => {})));
        return { visible: cardRect.top >= bodyRect.top - 1 && cardRect.bottom <= bodyRect.bottom + 1, animation, finalOpacity: getComputedStyle(node).opacity, pageScroll: window.scrollY };
    });
    assert.deepEqual(revealed, { visible: true, animation: 'qm-font-reveal', finalOpacity: '1', pageScroll: 0 }, 'The newly added card is in view, fades in once, and scrolls only the font-library body');
    await page.locator('[data-font-action="previous"]').click();
    assert.equal(await page.locator('[data-font-sample]').count(), 10);
    await page.locator('[data-font-action="next"]').click();
    assert.equal(await page.locator('[data-font-sample]').count(), 1);
    await page.locator('[data-font-action="previous"]').click();
    assert.equal(await page.locator('[data-font-sample]').count(), 10);
    assert.equal(await page.evaluate(() => owner.fontLibrary.fonts.length), 11);
    record('Catalogue renders ten compact previews per page, automatically reveals additions and keeps deterministic page navigation');
    await page.locator('[data-font-search]').fill('分页');
    await page.evaluate(() => { document.querySelector('.qm-font-window>.sd-body').scrollTop = 170; });
    const savedScroll = await page.locator('.qm-font-window>.sd-body').evaluate(node => node.scrollTop);
    await page.locator('[data-font-action="back"]').click(); await page.locator('[data-font-library]').click();
    await page.locator('[data-font-search]').waitFor();
    assert.equal(await page.locator('[data-font-search]').inputValue(), '分页');
    assert.equal(await page.locator('[data-font-sample]').count(), 9);
    assert.ok(Math.abs(await page.locator('.qm-font-window>.sd-body').evaluate(node => node.scrollTop) - savedScroll) <= 1);
    await page.locator('[data-font-search]').fill(''); await page.locator('[data-font-action="next"]').click();
    const pageTwoId = await page.locator('[data-font-sample]').getAttribute('data-font-sample');
    await page.locator('[data-font-action="back"]').click(); await page.locator('[data-font-library]').click();
    await page.locator('[data-font-sample]').waitFor();
    assert.equal(await page.locator('[data-font-sample]').count(), 1);
    assert.equal(await page.locator('[data-font-sample]').getAttribute('data-font-sample'), pageTwoId);
    await page.locator('[data-font-search]').fill('');
    record('Same-account return and reopening preserve list search, pagination and reading position without saving transient controls');
    const variantId = await page.evaluate(async () => {
        await library.action('add-web', { name: 'Variant 样本', source: '@font-face{font-family:"Variant";src:url("https://fonts.test/variant.ttf");font-weight:100 900;font-style:normal}@font-face{font-family:"Variant";src:url("https://fonts.test/variant-italic.ttf");font-weight:100 900;font-style:italic}' });
        return owner.fontLibrary.fonts.find(font => font.name === 'Variant 样本').id;
    });
    await page.locator('[data-font-search]').fill('Variant');
    const more = page.locator(`[data-font-action="more"][data-font-id="${variantId}"]`);
    assert.equal(await more.isVisible(), true);
    assert.equal(await page.locator(`[data-font-apply="${variantId}"]`).isVisible(), true);
    assert.equal(await page.locator(`[data-font-action="weight"][data-font-id="${variantId}"]`).isVisible(), false);
    await more.click();
    assert.equal(await page.locator(`[data-font-apply="${variantId}"]`).isVisible(), false);
    assert.equal(await page.locator(`[data-font-action="edit"][data-font-id="${variantId}"]`).isVisible(), true);
    assert.equal(await page.locator(`[data-font-action="delete-one"][data-font-id="${variantId}"]`).isVisible(), true);
    await page.locator(`[data-font-action="weight"][data-font-id="${variantId}"]`).click();
    assert.equal(await page.locator(`[data-font-weight-pop="${variantId}"]`).evaluate(node => { const rect = node.getBoundingClientRect(), body = node.closest('.sd-body').getBoundingClientRect(); return rect.left >= body.left - 1 && rect.right <= body.right + 1; }), true, 'The expanded weight slider stays inside the narrow library body');
    await page.locator(`[data-font-weight="${variantId}"]`).evaluate(node => { node.value = '700'; node.dispatchEvent(new Event('input', { bubbles: true })); });
    assert.equal(await page.locator(`[data-font-sample="${variantId}"]`).evaluate(node => getComputedStyle(node).fontWeight), '700');
    assert.equal(await page.evaluate(() => owner.fontLibrary.body.enabled), false);
    await page.locator('[data-font-preview]').click();
    assert.equal(await page.locator(`[data-font-weight-pop="${variantId}"]`).isVisible(), false);
    if (await more.getAttribute('aria-expanded') !== 'true') await more.click();
    await page.locator(`[data-font-style="${variantId}"]`).selectOption('italic');
    if (await more.getAttribute('aria-expanded') === 'true') await more.click();
    await apply(variantId, 'body');
    assert.deepEqual(await page.evaluate(() => [owner.fontLibrary.body.weight, owner.fontLibrary.body.style]), ['700', 'italic']);
    await more.click();
    const variantRow = await page.locator('.qm-font-card-head').evaluate(node => {
        const tools = node.querySelector('.qm-font-card-tools'), controls = [...tools.querySelectorAll('button,.qm-font-style-pick')].filter(child => child.offsetParent).map(child => child.getBoundingClientRect());
        const style = node.querySelector('.qm-font-style-pick'), weight = node.querySelector('[data-font-action="weight"]');
        const styleMatches = ['borderTopStyle', 'borderTopWidth', 'borderRadius', 'width', 'height'].every(property => getComputedStyle(style)[property] === getComputedStyle(weight)[property]);
        return { controlsFit: controls.every(rect => rect.right <= node.getBoundingClientRect().right + 1), line: controls.every(rect => Math.abs(rect.top + rect.height / 2 - controls[0].top - controls[0].height / 2) <= 2), overflow: document.querySelector('.qm-font-window>.sd-body').scrollWidth > document.querySelector('.qm-font-window>.sd-body').clientWidth + 1, styleMatches };
    });
    assert.deepEqual(variantRow, { controlsFit: true, line: true, overflow: false, styleMatches: true }, 'Expanded variant tools stay in a horizontal row without overflow or mismatched controls');
    await page.locator(`.qm-font-card[data-font-id="${variantId}"]`).scrollIntoViewIfNeeded();
    await page.screenshot({ path: fileURLToPath(new URL('glass-variant-narrow.png', qa)) });
    record('More expands edit/remove/variant controls horizontally while hiding apply; preview variants stay local until explicit application');
    const beforeBackRequest = await startHeldWeb('back');
    await page.locator('[data-font-action="back"]').click();
    assert.equal(await page.locator('.qm-font-window').count(), 0);
    assert.equal(await page.locator('[data-font-library]').isVisible(), true);
    releaseHeld(); releaseHeld = null;
    await page.waitForFunction(prior => saved > prior, beforeBackRequest);
    await page.locator('[data-font-library]').click(); await page.locator('[data-font-preview]').waitFor();
    await page.evaluate(async () => { await library.sync(); });
    record('Back remains responsive during an in-flight Web request and retains the existing catalogue and active font');
    const beforeCloseRequest = await startHeldWeb('close');
    assert.equal(await page.evaluate(() => window.closedPanels || 0), 0, 'Using inputs, menus and internal controls never closes the floor navigator');
    assert.equal(await page.evaluate(() => !!document.elementFromPoint(2, 2)?.closest('.qm-font-window')), false);
    await page.mouse.click(2, 2);
    assert.equal(await page.evaluate(() => closedPanels), 1);
    assert.equal(await page.locator('.qm-font-window').count(), 0);
    assert.ok((await page.evaluate(() => hostFonts()['host-prose'].family)).includes('QianmuFont_'));
    releaseHeld(); releaseHeld = null;
    await page.waitForFunction(prior => saved > prior, beforeCloseRequest);
    record('A background click closes the whole floor tool during Web loading, while internal controls and active fonts remain intact');
    await page.evaluate(() => { library.dispose(); appearance.reset(); });
    assert.equal(await page.evaluate(() => document.querySelectorAll('[data-qianmu-font-runtime]').length), 0);
    assert.deepEqual(errors, []); assert.deepEqual(unexpected, []);
    console.log(JSON.stringify({ passed: checks.length, checks, errors, unexpected, actualFontFace: true, realST: false, productionDataRead: false, externalFontRequests: false }));
} catch (error) {
    await page.screenshot({ path: fileURLToPath(new URL('failure.png', qa)) }).catch(() => {});
    throw error;
} finally { releaseHeld?.(); clearTimeout(deadline); await context.close(); await browser.close(); }
