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
    if (url.origin === 'https://fonts.test' && url.pathname.endsWith('.css')) return route.fulfill({ headers: cors, contentType: 'text/css', body: '@font-face{font-family:"Fixture Web";src:url("./fixture.ttf") format("truetype");font-weight:400;font-style:normal}body{color:rgb(255,0,255)!important}' });
    if (url.origin === 'https://fonts.test' && url.pathname.endsWith('.ttf')) return route.fulfill({ headers: cors, contentType: 'font/ttf', body: bytes });
    unexpected.push(route.request().url()); return route.abort();
});
const record = name => checks.push(name);
const settled = async () => { await page.waitForFunction(() => !document.querySelector('[aria-busy="true"]')); };
const apply = async (id, target) => { await page.locator(`[data-font-apply="${id}"]`).selectOption(target); await settled(); };
const setPreviewSize = async value => page.locator('[data-font-preview-size]').evaluate((node, next) => { node.value = String(next); node.dispatchEvent(new Event('input', { bubbles: true })); node.dispatchEvent(new Event('change', { bubbles: true })); }, value);
const startHeldWeb = async name => {
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
        const { createQianmuAppearanceSession } = await import('./qianmu-appearance-session.js');
        const { updateAppearancePreferences } = await import('./qianmu-appearance-settings.js');
        window.saved = 0; window.downloads = []; window.notifications = []; window.acceptDelete = true; window.prosePreviewSize = 19;
        window.owner = {};
        document.body.classList.add('sd-prose-layout');
        document.body.innerHTML = '<aside id="host"><button id="host-button">ST 界面</button><input id="host-input" value="ST 输入"><i id="host-icon" class="fa-solid">★</i><strong id="host-strong">标题</strong></aside><div id="chat"><div class="mes"><div class="mes_text"><p id="host-prose">正文 ABC <em id="host-em">斜体</em><strong id="host-bold">粗体</strong></p><code id="host-code">const x = 1;</code></div></div></div><div id="story-director-modal"><section class="sd-window"><header class="sd-header"><h2 id="main-title">千幕</h2></header></section></div><div id="story-director-floor-nav"><div class="sd-floor-shell"><section class="sd-floor-panel"><header><div><h3>楼层工具</h3><p>共 12 层</p></div><button type="button" class="sd-floor-close">×</button></header><nav class="sd-floor-tabs"><button>楼层跳转</button><button>正文排版</button></nav><section class="sd-floor-view"><div class="qm-font-entry"><small data-font-library-summary>当前：原生字体</small><button data-font-library>字体库</button></div><p>原排版控件</p></section></section></div></div>';
        window.theme = { theme: 'light', appearance: updateAppearancePreferences({}, { family: 'classic', mode: 'light' }) };
        for (const id of ['story-director-modal', 'story-director-floor-nav']) document.getElementById(id).classList.add('sd-theme-light');
        window.appearance = createQianmuAppearanceSession({ readSettings: () => theme, loadStyles: () => ({ promise: Promise.resolve(true), cancel() {} }), loadFont: () => ({ promise: Promise.resolve(false), cancel() {} }) });
        appearance.mount(document.getElementById('story-director-modal')); appearance.mountPortal(document.getElementById('story-director-floor-nav')); await appearance.sync();
        window.setTheme = async (family, mode) => { theme = { theme: mode, appearance: updateAppearancePreferences({}, { family, mode }) }; appearance.repaintClassic(); await appearance.sync(); };
        window.library = createFontLibrary({ getOwner: () => owner, resolveNamespace: async () => 'st-user:synthetic-font-browser', isCurrent: () => true,
            getPreviewFontSize: () => prosePreviewSize,
            save: () => { saved++; }, download: async (blob, name) => { downloads.push({ name, text: await blob.text() }); }, confirm: async () => acceptDelete,
            closePanel: () => { window.closedPanels = (window.closedPanels || 0) + 1; library.detach(); document.getElementById('story-director-floor-nav').remove(); },
            notify: message => notifications.push(message), document });
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
    assert.equal(await page.locator('.qm-font-library').evaluate(node => node.firstElementChild.matches('.qm-font-enable') && !!node.firstElementChild.querySelector('[data-font-enabled]')), true);
    assert.equal(await page.locator('[data-font-enabled]').isChecked(), true, 'Old active assignments remain enabled by default');
    assert.equal(await page.locator('details.qm-font-web,.qm-font-web summary,.qm-font-web h2,.qm-font-web h3').count(), 0);
    assert.equal(await page.locator('[data-font-web-name]').isVisible(), true);
    assert.equal(await page.locator('[data-font-web-source]').isVisible(), true);
    assert.equal(await page.locator('[data-font-preview]').inputValue(), '一蝶振翅，万象入幕。');
    record('Library reuses themed icon rendering and removes duplicate application panels and persistent explanatory notes');
    await page.locator('[data-font-web-source]').fill('@import url("https://fonts.test/library.css");');
    await page.locator('[data-font-web-name]').fill('Web 样本'); await page.locator('[data-font-action="add-web"]').click(); await settled();
    await page.waitForFunction(() => document.querySelectorAll('[data-font-sample]').length === 1 && ![...document.querySelectorAll('[data-font-load-state]')].some(node => node.textContent.includes('加载中')));
    const webId = await page.evaluate(() => owner.fontLibrary.fonts[0].id);
    assert.equal(await page.locator('[data-font-preview-size]').inputValue(), '19');
    assert.equal(await page.locator('[data-font-sample]').evaluate(node => getComputedStyle(node).fontSize), '19px');
    assert.equal(await page.locator(`[data-font-apply="${webId}"] option:checked`).textContent(), '应用');
    assert.deepEqual(await page.locator(`[data-font-apply="${webId}"] option:not([value=""])`).allTextContents(), ['正文', 'ST界面', '全部']);
    assert.equal(await page.locator('[data-font-action="weight"],[data-font-style]').count(), 0, 'Fixed-weight, single-style fonts have no unusable variant buttons');
    assert.deepEqual(await page.evaluate(() => hostFonts()), await page.evaluate(() => before));
    assert.equal(await page.evaluate(() => document.querySelectorAll('[data-qianmu-font-runtime]').length), 0);
    assert.equal(await page.evaluate(() => getComputedStyle(document.body).color), 'rgb(22, 33, 44)');
    record('Real Web CSS parsing and FontFace list preview leave all host fonts/sizes and external non-font CSS untouched');
    const beforePreviewSizeSave = await page.evaluate(() => saved);
    await setPreviewSize(27);
    assert.equal(await page.locator('[data-font-sample]').evaluate(node => getComputedStyle(node).fontSize), '27px');
    assert.deepEqual(await page.evaluate(() => hostFonts()), await page.evaluate(() => before));
    assert.equal(await page.evaluate(() => saved), beforePreviewSizeSave, 'Preview-only size is session state, not a host typography setting');
    await page.locator('[data-font-action="back"]').click(); await page.locator('[data-font-library]').click();
    await page.locator('[data-font-preview-size]').waitFor();
    assert.equal(await page.locator('[data-font-preview-size]').inputValue(), '27');
    assert.equal(await page.locator('[data-font-sample]').evaluate(node => getComputedStyle(node).fontSize), '27px');
    record('Sample size begins at the prose-setting default, changes only list samples and survives return/reopen within the same account');
    await page.locator('[data-font-preview]').fill('ABC Custom preview 123');
    await apply(webId, 'body');
    assert.equal(await page.locator(`[data-font-apply="${webId}"] option:checked`).textContent(), '正文');
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
    await page.locator('[data-font-file="local"]').setInputFiles({ name: 'Local Fixture.ttf', mimeType: 'font/ttf', buffer: bytes }); await settled();
    await page.waitForFunction(() => document.querySelectorAll('[data-font-sample]').length === 2);
    assert.equal(await page.evaluate(() => owner.fontLibrary.fonts.filter(font => font.source.kind === 'local').length), 1);
    assert.equal(await page.evaluate(() => JSON.stringify(owner).includes('base64')), false);
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
    await page.locator('[data-font-action="export-selected"]').click(); await settled(); await page.waitForFunction(() => downloads.length === 1);
    const pack = await page.evaluate(() => downloads[0].text);
    assert.ok(Object.values(JSON.parse(pack).localFiles || {}).some(value => typeof value === 'string' && value.length > 100), 'The retained local original is still exported after another font was removed');
    await page.evaluate(() => { acceptDelete = false; }); await page.locator('[data-font-action="delete"]').click(); await settled();
    assert.equal(await page.evaluate(() => owner.fontLibrary.fonts.length), 2);
    await page.evaluate(() => { acceptDelete = true; }); await page.locator('[data-font-action="delete"]').click(); await settled();
    assert.equal(await page.evaluate(() => owner.fontLibrary.fonts.length), 0);
    await page.locator('[data-font-file="import"]').setInputFiles({ name: 'roundtrip.json', mimeType: 'application/json', buffer: Buffer.from(pack) }); await settled();
    await page.waitForFunction(() => document.querySelectorAll('[data-font-sample]').length === 2);
    assert.deepEqual(await page.evaluate(() => owner.fontLibrary.fonts.map(font => [font.folder, font.tags])), [['阅读', ['中文', '喜爱']], ['阅读', ['中文', '喜爱']]]);
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
                footer: [...host.querySelectorAll('.qm-font-card-foot')].map(node => ({ width: node.getBoundingClientRect().width, meta: node.querySelector('.qm-font-meta').getBoundingClientRect().width, noApply: !node.querySelector('[data-font-apply]'), deleteRight: node.getBoundingClientRect().right - node.querySelector('[data-font-action="delete-one"]').getBoundingClientRect().right })),
                titleRows: [...host.querySelectorAll('.qm-font-card-head')].map(node => {
                    const tools = node.querySelector('.qm-font-card-tools'), name = node.querySelector('.qm-font-name'), select = tools?.querySelector('[data-font-apply]');
                    return { tail: tools?.lastElementChild === select, line: !!select && Math.abs(name.getBoundingClientRect().top + name.getBoundingClientRect().height / 2 - select.getBoundingClientRect().top - select.getBoundingClientRect().height / 2) <= 2 };
                }),
                toolbarOrder: [...host.querySelector('.qm-font-toolbar').children].map(node => node.matches('[data-font-search]') ? 'search' : node.querySelector('[data-font-action="filter"]') ? 'folder' : node.matches('[data-font-action="manage"]') ? 'manage' : '?'),
                imports: [...host.querySelector('.qm-font-imports').children].map(node => ({ top: node.getBoundingClientRect().top, height: node.getBoundingClientRect().height })),
                editor: (() => { const editor = host.querySelector('.qm-font-preview-editor').getBoundingClientRect(), card = host.querySelector('.qm-font-card').getBoundingClientRect(); return { left: editor.left - card.left, right: editor.right - card.right }; })(),
                iconShapes: [...panel.querySelectorAll('.qm-font-icon,.qm-font-file-pick')].filter(node => node.offsetParent).map(node => ({ header: !!node.closest('.qm-font-header'), radius: getComputedStyle(node).borderTopLeftRadius, width: node.getBoundingClientRect().width, height: node.getBoundingClientRect().height })),
                filePicks: [...host.querySelectorAll('.qm-font-file-pick')].map(node => ({ color: getComputedStyle(node).color, opacity: getComputedStyle(node).opacity, display: getComputedStyle(node).display, input: { color: getComputedStyle(node.querySelector('input')).color, opacity: getComputedStyle(node.querySelector('input')).opacity, display: getComputedStyle(node.querySelector('input')).display } })),
                exportButton: { color: getComputedStyle(host.querySelector('[data-font-action="export-all"]')).color, opacity: getComputedStyle(host.querySelector('[data-font-action="export-all"]')).opacity, background: getComputedStyle(host.querySelector('[data-font-action="export-all"]')).backgroundColor },
                previewFamilies: [...host.querySelectorAll('[data-font-sample]')].map(node => getComputedStyle(node).fontFamily),
                previewSizes: [...host.querySelectorAll('[data-font-sample]')].map(node => getComputedStyle(node).fontSize),
                iconVariants: [...panel.querySelectorAll('[data-font-action="back"] [data-qm-icon-variant]')].filter(node => getComputedStyle(node).display !== 'none').map(node => node.dataset.qmIconVariant) };
        });
        assert.equal(measured.panel, true, `${width}/${family}/${mode} panel fits`); assert.equal(measured.noOverflow, true, `${width}/${family}/${mode} content fits`); assert.equal(measured.controlsFit, true, `${width}/${family}/${mode} controls fit`);
        assert.notEqual(measured.color, measured.bg); assert.equal(measured.titleSize, '17px'); assert.equal(measured.titleFamily, measured.mainTitleFamily);
        assert.deepEqual(measured.material, measured.mainMaterial, `${family}/${mode}: same main-panel surface, corner and filter treatment`);
        assert.ok(measured.footer.every(footer => footer.meta >= 70 && footer.noApply), `${width}/${family}/${mode} classification remains readable; application belongs to the title row`);
        assert.ok(measured.footer.every(footer => Math.abs(footer.deleteRight) <= 1), 'Single-font remove stays at the trailing edge of each card');
        assert.ok(measured.titleRows.every(row => row.tail && row.line), `${width}/${family}/${mode} application is the title-tools tail on the same line`);
        assert.deepEqual(measured.toolbarOrder, ['search', 'folder', 'manage']);
        assert.ok(measured.imports.every(item => Math.abs(item.top - measured.imports[0].top) <= 1 && Math.abs(item.height - measured.imports[0].height) <= 1), `${width}/${family}/${mode} upload, import and export share one row and equal heights`);
        assert.ok(Math.abs(measured.editor.left) <= 1 && Math.abs(measured.editor.right) <= 1, `${width}/${family}/${mode} preview editor aligns with list-card edges`);
        for (const shape of measured.iconShapes) {
            const circular = shape.radius.includes('%') ? parseFloat(shape.radius) >= 50 : parseFloat(shape.radius) >= Math.min(shape.width, shape.height) / 2 - 1;
            assert.equal(circular, family === 'glass' && shape.header, `${width}/${family}/${mode} only glass header navigation remains circular`);
            if (family === 'editorial') assert.equal(parseFloat(shape.radius), 0, 'Paper action controls keep square corners');
        }
        assert.ok(measured.filePicks.every(pick => pick.opacity === '1' && pick.input.opacity === '0' && pick.color === measured.exportButton.color), 'Native file inputs stay transparent and their labels retain the same readable ink as adjacent actions');
        assert.ok(measured.previewFamilies.every(value => value.includes('QianmuFont_')), `${family} list previews retain selected font despite theme CSS`);
        assert.ok(measured.previewSizes.every(value => value === '27px'), `${family} preview size remains session-local through theme changes`);
        assert.deepEqual(measured.iconVariants, [family === 'editorial' ? 'bold' : family === 'glass' ? 'twotone' : 'outline']);
        record(`${width}/${family}/${mode}: 17px title, correct action corners, aligned editor and title actions, real preview families, no clipping`);
        if (width === 393 && mode === 'dark') {
            await page.evaluate(() => { document.querySelector('.qm-font-window>.sd-body').scrollTop = 0; });
            await page.screenshot({ path: fileURLToPath(new URL(`${family}-${mode}.png`, qa)) });
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
        for (let index = 1; index <= 5; index++) await library.action('add-web', { name: `分页 ${index}`, source: `https://fonts.test/page-${index}.ttf` });
    });
    assert.equal(await page.locator('[data-font-sample]').count(), 6);
    await page.locator('[data-font-action="next"]').click();
    assert.equal(await page.locator('[data-font-sample]').count(), 1);
    await page.locator('[data-font-action="previous"]').click();
    assert.equal(await page.locator('[data-font-sample]').count(), 6);
    assert.equal(await page.evaluate(() => owner.fontLibrary.fonts.length), 7);
    record('Catalogue renders six previews per page in the panel scroll container, with deterministic previous/next navigation');
    await page.locator('[data-font-search]').fill('分页');
    await page.evaluate(() => { document.querySelector('.qm-font-window>.sd-body').scrollTop = 170; });
    const savedScroll = await page.locator('.qm-font-window>.sd-body').evaluate(node => node.scrollTop);
    await page.locator('[data-font-action="back"]').click(); await page.locator('[data-font-library]').click();
    await page.locator('[data-font-search]').waitFor();
    assert.equal(await page.locator('[data-font-search]').inputValue(), '分页');
    assert.equal(await page.locator('[data-font-sample]').count(), 5);
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
    await page.locator(`[data-font-action="weight"][data-font-id="${variantId}"]`).click();
    await page.locator(`[data-font-weight="${variantId}"]`).evaluate(node => { node.value = '700'; node.dispatchEvent(new Event('input', { bubbles: true })); });
    assert.equal(await page.locator(`[data-font-sample="${variantId}"]`).evaluate(node => getComputedStyle(node).fontWeight), '700');
    assert.equal(await page.evaluate(() => owner.fontLibrary.body.enabled), false);
    await page.locator('[data-font-preview]').click();
    assert.equal(await page.locator(`[data-font-weight-pop="${variantId}"]`).isVisible(), false);
    await page.locator(`[data-font-style="${variantId}"]`).selectOption('italic');
    await apply(variantId, 'body');
    assert.deepEqual(await page.evaluate(() => [owner.fontLibrary.body.weight, owner.fontLibrary.body.style]), ['700', 'italic']);
    const variantRow = await page.locator('.qm-font-card-head').evaluate(node => {
        const name = node.querySelector('.qm-font-name').getBoundingClientRect(), tools = node.querySelector('.qm-font-card-tools'), controls = [...tools.children].map(child => child.getBoundingClientRect());
        const footer = node.parentElement.querySelector('.qm-font-card-foot'), style = node.querySelector('.qm-font-style-pick'), weight = node.querySelector('[data-font-action="weight"]');
        const styleMatches = ['borderTopStyle', 'borderTopWidth', 'borderRadius', 'width', 'height'].every(property => getComputedStyle(style)[property] === getComputedStyle(weight)[property]);
        return { tail: tools.lastElementChild.matches('[data-font-apply]'), controlsFit: controls.every(rect => rect.right <= node.getBoundingClientRect().right + 1), line: controls.every(rect => Math.abs(rect.top + rect.height / 2 - name.top - name.height / 2) <= 2), overflow: document.querySelector('.qm-font-window>.sd-body').scrollWidth > document.querySelector('.qm-font-window>.sd-body').clientWidth + 1, deleteRight: Math.abs(footer.getBoundingClientRect().right - footer.querySelector('[data-font-action="delete-one"]').getBoundingClientRect().right) <= 1, styleMatches };
    });
    assert.deepEqual(variantRow, { tail: true, controlsFit: true, line: true, overflow: false, deleteRight: true, styleMatches: true }, 'Narrow name/weight/style/apply row stays aligned; style button and metadata-free delete remain consistent');
    await page.locator(`.qm-font-card[data-font-id="${variantId}"]`).scrollIntoViewIfNeeded();
    await page.screenshot({ path: fileURLToPath(new URL('glass-variant-narrow.png', qa)) });
    record('Title-row weight popup and conditional style selector affect the list sample first, close on outside click, then apply the selected variant explicitly');
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
    await page.locator('[data-font-action="close"]').click();
    assert.equal(await page.evaluate(() => closedPanels), 1);
    assert.equal(await page.locator('.qm-font-window').count(), 0);
    assert.ok((await page.evaluate(() => hostFonts()['host-prose'].family)).includes('QianmuFont_'));
    releaseHeld(); releaseHeld = null;
    await page.waitForFunction(prior => saved > prior, beforeCloseRequest);
    record('Header close stays responsive during Web loading and delegates to the floor close path while explicitly applied fonts remain active');
    await page.evaluate(() => { library.dispose(); appearance.reset(); });
    assert.equal(await page.evaluate(() => document.querySelectorAll('[data-qianmu-font-runtime]').length), 0);
    assert.deepEqual(errors, []); assert.deepEqual(unexpected, []);
    console.log(JSON.stringify({ passed: checks.length, checks, errors, unexpected, actualFontFace: true, realST: false, productionDataRead: false, externalFontRequests: false }));
} catch (error) {
    await page.screenshot({ path: fileURLToPath(new URL('failure.png', qa)) }).catch(() => {});
    throw error;
} finally { releaseHeld?.(); clearTimeout(deadline); await context.close(); await browser.close(); }
