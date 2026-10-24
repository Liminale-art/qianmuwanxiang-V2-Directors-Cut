// Production controller/view/source parser/FontFace runtime, synthetic ST only.
// Font bytes come from a local system font; all network routes are intercepted.
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.QIANMU_PLAYWRIGHT_MODULE || 'playwright');
const bytes = await readFile(process.env.QIANMU_FONT_FIXTURE || 'C:/Windows/Fonts/arial.ttf');
const secondBytes = await readFile(process.env.QIANMU_SECOND_FONT_FIXTURE || 'C:/Windows/Fonts/times.ttf');
assert.ok(!bytes.equals(secondBytes), 'The multi-font package fixture must contain two genuinely different local originals');
const hostStyles = await readFile(`${process.env.QIANMU_ST_FIXTURE_ROOT || 'D:/ST/tools/SillyTavern-upstream'}/public/style.css`, 'utf8');
const hostCheckboxStyles = hostStyles.match(/input\[type='checkbox'\] \{[\s\S]+?(?=input\[type='checkbox'\]\.del_checkbox)/)?.[0];
assert.ok(hostCheckboxStyles?.includes('clip-path: polygon'), 'The host fixture must include real ST checkbox pseudo-element rules');
const shortWebSource = '@import url("https://fonts.test/library.css"); body { font-family: "Fixture Web"; }';
const segmentedCss = Array.from({ length: 64 }, (_, index) => `@font-face{font-family:"Fixture Web";src:url("./fixture.ttf") format("truetype");font-weight:400;font-style:normal;unicode-range:${index ? `U+${(0x4e00 + index - 1).toString(16)}` : 'U+0000-00FF'}}`).join('\n');
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
    if (url.origin === 'https://fonts.test' && url.pathname === '/library.css') return route.fulfill({ headers: cors, contentType: 'text/css', body: `${segmentedCss}\nbody{color:rgb(255,0,255)!important}` });
    if (url.origin === 'https://fonts.test' && url.pathname === '/missing.woff2') return route.fulfill({ status: 404, headers: cors, contentType: 'font/woff2', body: '' });
    if (url.origin === 'https://fonts.test' && url.pathname === '/corrupt.woff2') return route.fulfill({ headers: cors, contentType: 'font/woff2', body: Buffer.from('not-a-font-file') });
    if (url.origin === 'https://fonts.test' && url.pathname.endsWith('.css')) return route.fulfill({ headers: cors, contentType: 'text/css', body: '@font-face{font-family:"Fixture Web";src:url("./fixture.ttf") format("truetype");font-weight:400;font-style:normal}body{color:rgb(255,0,255)!important}' });
    if (url.origin === 'https://fonts.test' && url.pathname.endsWith('.ttf')) return route.fulfill({ headers: cors, contentType: 'font/ttf', body: bytes });
    unexpected.push(route.request().url()); return route.abort();
});
const record = name => checks.push(name);
const settled = async () => { await page.waitForFunction(() => !document.querySelector('[aria-busy="true"]')); };
const apply = async (id, target) => {
    const prior = await page.evaluate(() => notifications.length), enabled = await page.evaluate(() => owner.fontLibrary.enabled);
    await page.locator(`[data-font-apply="${id}"]`).selectOption(target); await settled();
    await page.waitForFunction(prior => notifications.length > prior, prior);
    const notices = await page.evaluate(prior => notifications.slice(prior), prior), label = { body: '正文', st: '界面', shared: '全部' }[target];
    assert.equal(notices.length, 1, 'One explicit application produces exactly one result notice');
    assert.equal(notices[0].level, enabled ? 'success' : 'info');
    assert.equal(notices[0].message, enabled ? `字体已应用于${label}` : `已保存${label}字体选择，字体库尚未启用`);
    if (enabled) {
        const expected = (await page.locator(`[data-font-sample="${id}"]`).evaluate(node => getComputedStyle(node).fontFamily)).split(',')[0].replaceAll('"', '');
        for (const key of target === 'shared' ? ['host-prose', 'host-button'] : [target === 'body' ? 'host-prose' : 'host-button']) assert.ok(notices[0].fonts[key].family.includes(expected), 'Success is emitted only after the requested host scope is actually painted');
    }
    assert.equal(await page.locator(`[data-font-apply="${id}"]`).evaluate(node => node.selectedIndex), -1, 'Application menu remains action-only, so the same target can be applied again');
};
const appliedLabel = id => page.locator(`[data-font-apply="${id}"]`).evaluate(node => node.parentElement.title);
const visibleIconVariants = locator => locator.evaluate(node => [...node.querySelectorAll('[data-qm-icon-variant]')].filter(icon => getComputedStyle(icon).display !== 'none').map(icon => icon.dataset.qmIconVariant));
const setPreviewSize = async value => page.locator('[data-font-preview-size]').selectOption(String(value));
const setAddOpen = async open => { const card = page.locator('details.qm-font-add'); if (await card.evaluate(node => node.open) !== open) await card.locator('summary').click(); };
const tagPanel = key => page.locator(`[data-font-tag-options="${key}"]`);
const tagToggle = key => page.locator(`[data-font-action="tags"][data-font-tag-target="${key}"]`);
const tagChip = (key, tag) => tagPanel(key).locator('[data-font-action="tag-toggle"]').filter({ hasText: new RegExp(`^${tag}$`) });
const parsedTags = async locator => (await locator.inputValue()).split(/[,，]/).map(value => value.trim()).filter(Boolean);
const tagPanelFits = async key => tagPanel(key).evaluate(node => {
    const rect = node.getBoundingClientRect(), host = node.closest('[data-font-local-dialog]') || node.closest('.sd-body'), bounds = host.getBoundingClientRect(), style = getComputedStyle(node);
    return { fits: rect.left >= bounds.left && rect.right <= bounds.right && node.scrollWidth <= node.clientWidth + 1,
        limited: Number.isFinite(parseFloat(style.maxHeight)) && parseFloat(style.maxHeight) > 0 && parseFloat(style.maxHeight) <= bounds.height,
        chipsFit: [...node.querySelectorAll('button')].every(chip => chip.getBoundingClientRect().right <= rect.right + 1 && chip.scrollWidth <= chip.clientWidth + 1) };
});
const cardFor = id => page.locator(`.qm-font-card[data-font-id="${id}"]`);
const renameGeometry = id => page.locator(`[data-font-rename-pop="${id}"]`).evaluate(node => {
    const cardNode = node.closest('.qm-font-card'), rect = node.getBoundingClientRect(), host = node.closest('.sd-body').getBoundingClientRect(), card = cardNode.getBoundingClientRect(), next = cardNode.nextElementSibling?.getBoundingClientRect();
    const point = (x, y) => ({ x, y, hit: node.contains(document.elementFromPoint(x, y)) });
    return { visible: rect.left >= host.left && rect.right <= host.right && rect.top >= host.top && rect.bottom <= host.bottom,
        bounds: { popup: rect.toJSON(), viewport: host.toJSON() },
        contained: rect.left >= card.left && rect.right <= card.right && rect.top >= card.top && rect.bottom <= card.bottom,
        nextCardClear: !next || next.top >= card.bottom, bottom: point(rect.left + rect.width / 2, rect.bottom - 2),
        actions: [...node.querySelectorAll('[data-font-action="rename-save"],[data-font-action="rename-cancel"]')].map(button => { const bounds = button.getBoundingClientRect(), x = bounds.left + bounds.width / 2, y = bounds.top + bounds.height / 2; return { action: button.dataset.fontAction, x, y, hit: button.contains(document.elementFromPoint(x, y)) }; }) };
});
const setSelected = async (id, selected) => { if ((await cardFor(id).getAttribute('aria-pressed') === 'true') !== selected) await cardFor(id).locator('.qm-font-name strong').click(); assert.equal(await cardFor(id).getAttribute('aria-pressed'), String(selected)); };
const orderedFonts = state => {
    const pinned = new Map((state.pinnedIds || []).map((id, index) => [id, index])), compare = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' }).compare;
    return state.fonts.map((font, index) => ({ ...font, insertion: index })).sort((a, b) => {
        if (pinned.has(a.id) || pinned.has(b.id)) return (pinned.get(a.id) ?? Infinity) - (pinned.get(b.id) ?? Infinity);
        if (state.sortBy === 'added') return (state.sortOrder === 'desc' ? -1 : 1) * (a.insertion - b.insertion);
        return (state.sortOrder === 'desc' ? -1 : 1) * compare(a.name, b.name) || a.insertion - b.insertion;
    });
};
const cataloguePage = async desired => {
    const currentPage = async () => Number((await page.locator('.qm-font-pagination>span').textContent()).match(/^\s*(\d+)/)[1]) - 1;
    while (await currentPage() < desired) await page.locator('[data-font-action="next"]').click();
    while (await currentPage() > desired) await page.locator('[data-font-action="previous"]').click();
};
const showFont = async id => { const sorted = orderedFonts(await page.evaluate(() => owner.fontLibrary)); const index = sorted.findIndex(font => font.id === id); assert.ok(index >= 0); await cataloguePage(Math.floor(index / 10)); };
const switchGeometry = async () => page.locator('[data-font-enabled]').evaluate(async node => {
    void getComputedStyle(node, '::after').transform;
    await Promise.all(node.getAnimations({ subtree: true }).map(animation => animation.finished.catch(() => {})));
    const track = getComputedStyle(node), thumb = getComputedStyle(node, '::after'), oldTick = getComputedStyle(node, '::before');
    const matrix = new DOMMatrix(thumb.transform === 'none' ? undefined : thumb.transform);
    return { checked: node.checked, width: parseFloat(track.width), height: parseFloat(track.height), thumbWidth: parseFloat(thumb.width), thumbHeight: parseFloat(thumb.height), radius: thumb.borderRadius,
        scaleX: matrix.a, scaleY: matrix.d, shift: matrix.e, clip: thumb.clipPath, shadow: thumb.boxShadow,
        visible: !['none', 'normal'].includes(thumb.content) && thumb.display !== 'none' && thumb.opacity === '1' && !['transparent', 'rgba(0, 0, 0, 0)'].includes(thumb.backgroundColor),
        oldTickHidden: oldTick.content === 'none' || oldTick.display === 'none' };
});
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
    await page.addStyleTag({ content: hostCheckboxStyles });
    await page.addStyleTag({ content: ':root{--mainFontFamily:Georgia,serif}body{margin:0;color:rgb(22,33,44);font:24px/1.6 Georgia,serif}button,input,textarea,select{font-family:Georgia,serif}#host #host-button,#host #host-input,#chat .mes .mes_text,#chat .mes_text p,#chat .mes_text span,#chat .mes_text q,#chat .mes_text em{font-family:Georgia,serif!important}#host-code{font-family:monospace}#host-icon{font-family:FixtureIcon!important}#story-director-floor-nav{inset:0;width:100vw;height:100dvh}#story-director-modal{display:none!important}' });
    await page.evaluate(async () => {
        const { createFontLibrary } = await import('./qianmu-font-library.js');
        const { createFontLocalStore } = await import('./qianmu-font-local-store.js');
        const { createFontLibraryView } = await import('./qianmu-font-library-view.js');
        const { createQianmuAppearanceSession } = await import('./qianmu-appearance-session.js');
        const { updateAppearancePreferences } = await import('./qianmu-appearance-settings.js');
        window.saved = 0; window.downloads = []; window.notifications = []; window.localWrites = []; window.confirmCalls = []; window.acceptDelete = true; window.prosePreviewSize = 19; window.rejectNextFontSave = false;
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
            viewFactory: options => createFontLibraryView({ ...options, initialSession: { folder: '旧会话隐藏分类', tags: ['失效标签筛选'], ...options.initialSession } }),
            localStoreFactory: options => { const store = createFontLocalStore(options); window.localStore = store; return { ...store, put: async (...args) => { localWrites.push(args[0]); return store.put(...args); } }; },
            save: () => { if (rejectNextFontSave) { rejectNextFontSave = false; throw new Error('Synthetic font settings save rejected'); } saved++; }, download: async (blob, name) => { downloads.push({ name, text: await blob.text() }); }, confirm: async (...args) => { confirmCalls.push(args); return acceptDelete; },
            closePanel: () => closeSyntheticFloor(),
            notify: (message, level) => notifications.push({ message, level, fonts: hostFonts() }), document });
        window.library = createSyntheticLibrary();
        library.attach(document.getElementById('story-director-floor-nav'));
        window.hostFonts = () => Object.fromEntries(['host-button', 'host-input', 'host-prose', 'host-code', 'host-icon'].map(id => [id, { family: getComputedStyle(document.getElementById(id)).fontFamily, size: getComputedStyle(document.getElementById(id)).fontSize }]));
        window.before = hostFonts();
        document.getElementById('host').insertAdjacentHTML('beforeend', '<input id="host-native-checkbox" type="checkbox" aria-label="synthetic host checkbox">');
        const mixed = document.createElement('div'); mixed.className = 'mes';
        mixed.innerHTML = '<div class="mes_text"><p id="mixed-prose">普通正文 ABC</p><div class="np-min-card" style="font-family:Georgia,serif"><p id="mixed-card">富卡保持原样</p></div><p id="mixed-tail">普通收尾 ABC</p></div>';
        document.getElementById('chat').appendChild(mixed);
    });
    assert.match(await page.locator('[data-font-library-summary]').textContent(), /^当前：/);
    assert.equal(await page.locator('#host-native-checkbox').evaluate(node => getComputedStyle(node, '::before').clipPath.startsWith('polygon(') && getComputedStyle(node, '::before').transform === 'matrix(0, 0, 0, 0, 0, 0)'), true, 'The fixture actually reproduces the host checkbox tick clipping and off-state scale');
    assert.equal(await page.locator('.qm-font-entry>span').count(), 0);
    await page.locator('[data-font-library]').click(); await page.locator('[data-font-web-source]').waitFor();
    assert.equal(await page.locator('.sd-floor-panel').isVisible(), false); assert.equal(await page.locator('.qm-font-window>.sd-header h2').textContent(), '字体库管理');
    assert.equal(await page.locator('.qm-font-mode,.qm-font-application,.qm-font-storage-note,.qm-font-note').count(), 0);
    assert.equal(await page.locator('[data-font-action="back"] .qm-glyph-svg').count(), 1);
    assert.equal(await page.locator('[data-font-action="close"]').count(), 0);
    assert.equal(await page.locator('.qm-font-header').evaluate(node => node.lastElementChild.matches('[data-font-action="back"]')), true, 'Only the trailing return action remains in the header');
    assert.equal(await page.locator('[data-font-enabled]').isChecked(), true, 'Old active assignments remain enabled by default');
    assert.deepEqual(await page.locator('[data-font-sort-order] option').evaluateAll(nodes => nodes.map(node => [node.value, node.textContent])), [['asc', '名称正序'], ['desc', '名称倒序'], ['added-asc', '添加时间正序'], ['added-desc', '添加时间倒序']]);
    assert.equal(await page.locator('details.qm-font-add').evaluate(node => node.open), true, 'An empty catalogue initially expands its combined add-font card');
    assert.equal(await page.locator('details.qm-font-add summary').textContent(), '添加字体');
    assert.equal(await page.locator('details.qm-font-add .qm-font-imports').count(), 1, 'Web and file actions share one collapsible add card');
    assert.deepEqual(await page.locator('.qm-font-imports>label').allTextContents(), ['上传本地字体', '导入字体包']);
    assert.equal(await page.locator('[data-font-action="export-all"],[data-font-action="filter"],[data-font-action="bulk-folder"],[data-font-folder-choice],[data-font-tag],.sd-reader-tags').count(), 0, 'Folder controls, filter tags and top-level export are absent');
    assert.equal(await page.locator('[data-font-web-name]').isVisible(), true);
    assert.equal(await page.locator('[data-font-web-source]').isVisible(), true);
    assert.equal(await page.locator('[data-font-web-tags]').getAttribute('placeholder'), '如：宋体,黑体，多个标签用逗号分隔');
    assert.equal(await page.locator('[data-font-action="add-web"] .qm-glyph-icon').getAttribute('data-qm-icon'), 'qm-regular-check', 'Adding Web fonts uses the same affirmative check as saving edits');
    assert.equal(await page.locator('details.qm-font-add>summary [data-font-action="add-web"]').count(), 1);
    const beforeEmpty = await page.evaluate(() => ({ saved, count: notifications.length }));
    await page.locator('[data-font-action="add-web"]').click(); await settled();
    assert.deepEqual(await page.evaluate(start => notifications.slice(start).map(({ message, level }) => ({ message, level })), beforeEmpty.count), [{ message: '链接不可为空', level: 'warning' }]);
    assert.equal(await page.evaluate(() => saved), beforeEmpty.saved);
    assert.equal(await page.locator('details.qm-font-add').evaluate(node => node.open), true, 'Submitting an empty link never folds the card');
    assert.equal(await page.locator('.qm-font-status,[data-font-local-status]').count(), 0);
    await page.locator('details.qm-font-add>summary>b').click();
    assert.equal(await page.locator('details.qm-font-add').evaluate(node => node.open), false);
    await page.locator('[data-font-action="add-web"]').click(); await settled();
    assert.equal(await page.locator('details.qm-font-add').evaluate(node => node.open), false, 'The header check does not unfold a collapsed card either');
    await page.locator('details.qm-font-add>summary>b').click();
    record('Add-card check is top-right and never toggles the disclosure; empty links show one ST warning without a footer or save');
    await tagToggle('web').click();
    assert.match(await tagPanel('web').textContent(), /暂无已有标签/);
    await page.locator('[data-font-web-name]').click();
    assert.equal(await tagPanel('web').isVisible(), false);
    assert.equal(await page.locator('[data-font-preview]').inputValue(), '一念起幕，万象成诗。 AaBbCc123456');
    record('Library reuses themed icon rendering and removes duplicate application panels and persistent explanatory notes');
    await page.locator('[data-font-web-source]').fill(shortWebSource);
    await page.locator('[data-font-web-tags]').fill('初始, 中文,初始');
    await page.locator('[data-font-web-name]').fill('Web 样本'); await page.locator('[data-font-action="add-web"]').click(); await settled();
    await page.waitForFunction(() => document.querySelectorAll('[data-font-sample]').length === 1 && ![...document.querySelectorAll('[data-font-load-state]')].some(node => node.textContent.includes('加载中')));
    const webId = await page.evaluate(() => owner.fontLibrary.fonts[0].id);
    assert.equal(await page.evaluate(() => owner.fontLibrary.fonts[0].faces.length), 64);
    assert.deepEqual(await page.evaluate(() => owner.fontLibrary.fonts[0].tags), ['初始', '中文']);
    await page.evaluate(() => { library.dispose(); library = createSyntheticLibrary(); library.attach(document.getElementById('story-director-floor-nav')); });
    await page.locator('[data-font-library]').click(); await page.locator('[data-font-preview-size]').waitFor();
    assert.equal(await page.locator('details.qm-font-add').evaluate(node => node.open), false, 'A fresh session with existing fonts defaults to a collapsed add card');
    await setAddOpen(true); assert.equal(await page.locator('[data-font-web-tags]').isVisible(), true);
    const beforeTagDraft = await page.evaluate(() => ({ state: owner.fontLibrary, saved }));
    await tagToggle('web').click();
    assert.deepEqual((await tagPanel('web').locator('[data-font-action="tag-toggle"]').allTextContents()).sort(), ['中文', '初始'].sort(), 'Existing tag choices are deduplicated from saved font entries');
    await page.locator('[data-font-web-tags]').fill('初始，,中文,,手输新标签');
    assert.equal(await tagChip('web', '初始').getAttribute('aria-pressed'), 'true');
    assert.equal(await tagChip('web', '中文').getAttribute('aria-pressed'), 'true');
    assert.equal(await tagChip('web', '手输新标签').count(), 0, 'Unsaved free-text tags do not enter the shared saved-tag pool');
    await tagChip('web', '中文').click();
    assert.deepEqual(await parsedTags(page.locator('[data-font-web-tags]')), ['初始', '手输新标签']);
    await tagChip('web', '中文').click();
    assert.deepEqual(await parsedTags(page.locator('[data-font-web-tags]')), ['初始', '手输新标签', '中文']);
    await page.locator('[data-font-web-name]').click();
    assert.equal(await tagPanel('web').isVisible(), false);
    assert.equal(await page.locator('[data-font-web-name]').evaluate(node => node === document.activeElement), true, 'Outside dismissal never consumes the next field focus');
    await page.locator('[data-font-web-name]').fill('首击可编辑');
    assert.deepEqual(await page.evaluate(() => ({ state: owner.fontLibrary, saved })), beforeTagDraft, 'Picking reusable tags only changes the active form draft');
    await tagToggle('web').click(); await page.keyboard.press('Escape');
    assert.equal(await tagPanel('web').isVisible(), false);
    assert.deepEqual(await parsedTags(page.locator('[data-font-web-tags]')), ['初始', '手输新标签', '中文']);
    await page.locator('[data-font-web-name]').fill(''); await page.locator('[data-font-web-tags]').fill('');
    record('Web tag reuse deduplicates saved choices, synchronizes mixed-comma text and multi-toggle highlights, and dismisses without swallowing focus or saving drafts');
    await setAddOpen(false); assert.equal(await page.locator('[data-font-web-tags]').isVisible(), false);
    assert.equal(await page.evaluate(() => window.closedPanels || 0), 0);
    record('The add card starts expanded only for an empty library, folds existing-library controls together and never mistakes internal toggles for an outside close');
    assert.equal(await page.locator('[data-font-preview-size]').inputValue(), '19');
    assert.deepEqual(await page.locator('[data-font-preview-size] option:not(:disabled)').evaluateAll(nodes => nodes.map(node => Number(node.value))), [12, 14, 16, 18, 20]);
    assert.equal(await page.locator('[data-font-preview-size] option:checked').evaluate(node => node.disabled), true, 'The prose-derived 19px initial value is preserved as a non-selectable current value');
    assert.equal(await page.locator('[data-font-sample]').evaluate(node => getComputedStyle(node).fontSize), '19px');
    assert.equal(await page.locator(`[data-font-apply="${webId}"]`).evaluate(node => node.selectedIndex), -1);
    assert.deepEqual(await page.locator(`[data-font-apply="${webId}"] option`).allTextContents(), ['正文', '界面', '全部']);
    assert.equal(await page.locator('option[value="restore-shared"],.qm-font-apply option[value=""]').count(), 0, 'Application menus have no redundant placeholder or cancel-all item');
    assert.equal(await page.locator('[data-font-action="weight"],[data-font-style]').count(), 0, 'Fixed-weight, single-style fonts have no unusable variant buttons');
    assert.equal(await page.locator('[data-font-action="more"]').count(), 0, 'Fixed-variant fonts expose edit/remove/apply without a redundant more step');
    assert.equal(await page.locator(`[data-font-action="edit"][data-font-id="${webId}"]`).isVisible(), true);
    assert.equal(await page.locator(`[data-font-action="delete-one"][data-font-id="${webId}"]`).isVisible(), true);
    assert.deepEqual(await visibleIconVariants(page.locator('.qm-font-apply-pick')), ['outline']);
    assert.equal(await page.locator('.qm-font-apply-pick').getAttribute('data-applied'), 'false');
    assert.deepEqual(await page.evaluate(() => hostFonts()), await page.evaluate(() => before));
    assert.equal(await page.evaluate(() => document.querySelectorAll('[data-qianmu-font-runtime]').length), 0);
    assert.equal(await page.evaluate(() => getComputedStyle(document.body).color), 'rgb(22, 33, 44)');
    assert.equal(await page.evaluate(() => notifications.filter(item => item.level === 'success').length), 0, 'Adding and previewing fonts cannot imply a successful host application');
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
    assert.equal(await appliedLabel(webId), '正文');
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
    assert.equal(await appliedLabel(webId), '全部');
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
    assert.equal(await appliedLabel(webId), '全部');
    await page.locator('[data-font-enabled]').check(); await settled();
    assert.equal(await page.evaluate(() => owner.fontLibrary.enabled), true);
    assert.ok((await page.evaluate(() => hostFonts()['host-prose'].family)).includes('QianmuFont_'));
    assert.ok((await page.evaluate(() => hostFonts()['host-button'].family)).includes('QianmuFont_'));
    assert.deepEqual(await page.evaluate(() => ({ fonts: owner.fontLibrary.fonts, body: owner.fontLibrary.body, st: owner.fontLibrary.st, shared: owner.fontLibrary.shared })), selectedBeforeDisable);
    assert.equal(await page.locator('[data-font-apply] option[value="restore-body"]').count(), 0, 'Body restore is replaced by the global enable control');
    record('Master off immediately removes host CSS while keeping all records and scope choices; preview and selection stay usable, and enabling restores the chosen scopes');
    record('Explicit applications notify success once only after actual scope painting; disabled-library selections notify info and list preview never reports application success');
    await setAddOpen(true);
    const beforeLocalSelection = await page.evaluate(() => ({ state: owner.fontLibrary, writes: localWrites.length, saved }));
    await page.locator('[data-font-file="local"]').setInputFiles({ name: 'Local Fixture.ttf', mimeType: 'font/ttf', buffer: bytes }); await settled();
    await page.locator('[data-font-local-dialog]').waitFor();
    assert.equal(await page.locator('[data-font-local-tags="0"]').getAttribute('placeholder'), '如：宋体,黑体，多个标签用逗号分隔');
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
        await tagToggle('local-0').click(); await tagChip('local-0', '中文').click();
        assert.deepEqual(await parsedTags(page.locator('[data-font-local-tags="0"]')), ['中文']);
        assert.equal(await page.locator('[data-font-local-tags="1"]').inputValue(), '第二款标签', 'Tag reuse in the first pending file never overwrites the second file draft');
        await tagToggle('local-1').click();
        assert.equal(await tagPanel('local-0').isVisible(), false);
        await tagChip('local-1', '初始').click();
        assert.deepEqual(await parsedTags(page.locator('[data-font-local-tags="1"]')), ['第二款标签', '初始']);
        await page.locator('[data-font-local-name="1"]').click();
        assert.equal(await tagPanel('local-1').isVisible(), false);
        assert.equal(await page.locator('[data-font-local-name="1"]').evaluate(node => node === document.activeElement), true);
        await tagToggle('local-0').click();
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
                assert.deepEqual(await tagPanelFits('local-0'), { fits: true, limited: true, chipsFit: true }, `${family}/${mode}: pending-local tag choices fit the 320px dialog`);
                await page.screenshot({ path: fileURLToPath(new URL(`local-upload-${family}-${mode}.png`, qa)) });
            }
            assert.ok(modalMaterials.every(material => material.alpha === 255 && material.opacity === '1'), `Local upload dialogs must be opaque in every theme: ${JSON.stringify(modalMaterials)}`);
            await page.evaluate(async () => {
                await setTheme('classic', 'light');
                void getComputedStyle(document.querySelector('[data-font-local-dialog]')).backgroundColor;
                await Promise.all(document.getAnimations().filter(animation => animation.effect?.getComputedTiming().iterations !== Infinity).map(animation => animation.finished.catch(() => {})));
            });
            await page.screenshot({ path: fileURLToPath(new URL('local-upload-metadata.png', qa)) });
            await page.keyboard.press('Escape');
            assert.equal(await tagPanel('local-0').isVisible(), false, 'The first Escape only retracts the tag choices');
            assert.equal(await page.locator('[data-font-local-dialog]').isVisible(), true, 'A tag-panel Escape does not discard pending uploads');
            assert.deepEqual(await parsedTags(page.locator('[data-font-local-tags="0"]')), ['中文']);
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
    record('Local tag reuse isolates each pending file, preserves first-click input focus, and handles Escape before cancelling the uncommitted upload');
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
    assert.equal(await appliedLabel(webId), '正文');
    assert.equal(await appliedLabel(localId), '界面');
    const independentFonts = await page.evaluate(() => hostFonts());
    assert.ok(independentFonts['host-prose'].family.includes('QianmuFont_') && independentFonts['host-button'].family.includes('QianmuFont_'));
    assert.notEqual(independentFonts['host-prose'].family, independentFonts['host-button'].family);
    record('Independent local and Web choices show concise body/ST labels while applying genuinely different host font families');
    const removalId = await page.evaluate(async () => {
        await library.action('add-web', { name: '单条移除样本', source: 'https://fonts.test/single-remove.ttf' });
        return owner.fontLibrary.fonts.find(font => font.name === '单条移除样本').id;
    });
    const beforeSingleRemoval = await page.evaluate(() => ({ body: owner.fontLibrary.body, st: owner.fontLibrary.st, shared: owner.fontLibrary.shared, fonts: owner.fontLibrary.fonts.filter(font => font.name !== '单条移除样本') }));
    const beforeSingleConfirmCount = await page.evaluate(() => confirmCalls.length);
    await page.evaluate(() => { acceptDelete = false; });
    await page.locator(`[data-font-action="delete-one"][data-font-id="${removalId}"]`).click(); await settled();
    assert.equal(await page.evaluate(() => owner.fontLibrary.fonts.length), 2, 'Single-font removal takes effect directly');
    assert.equal(await page.evaluate(() => confirmCalls.length), beforeSingleConfirmCount, 'Single-font removal does not open a second confirmation');
    await page.evaluate(() => { acceptDelete = true; });
    assert.deepEqual(await page.evaluate(() => ({ body: owner.fontLibrary.body, st: owner.fontLibrary.st, shared: owner.fontLibrary.shared, fonts: owner.fontLibrary.fonts })), beforeSingleRemoval);
    assert.deepEqual(await page.evaluate(() => hostFonts()), independentFonts);
    record('Single-font removal needs no extra confirmation and deletes only its target while retaining other records and active scope choices');
    assert.equal(await page.locator('[data-font-select]').count(), 0, 'Card selection no longer renders separate checkboxes');
    await page.locator('[data-font-action="manage"]').click();
    await page.locator('[data-font-action="select-page"]').click();
    assert.equal(await page.locator('.qm-font-card[aria-pressed="true"]').count(), 2);
    await page.locator('[data-font-action="manage"]').click();
    assert.equal(await page.locator('.qm-font-card[aria-pressed="true"]').count(), 0);
    assert.equal(await page.locator('[data-font-select]').count(), 0);
    await page.locator('[data-font-action="manage"]').click();
    await page.locator('.qm-font-card').first().locator('[data-font-sample]').click();
    assert.equal(await page.locator('.qm-font-card[aria-pressed="true"]').count(), 1);
    const selectedCard = page.locator('.qm-font-card').first();
    await selectedCard.focus(); await page.keyboard.press('Space');
    assert.equal(await selectedCard.getAttribute('aria-pressed'), 'false', 'Space toggles a managed card once');
    await page.keyboard.press('Enter');
    assert.equal(await selectedCard.getAttribute('aria-pressed'), 'true', 'Enter toggles a managed card once');
    assert.equal(await selectedCard.locator('.qm-font-card-tools').isVisible(), false, 'Management avoids accidental individual actions while selecting a card');
    await page.locator('[data-font-action="select-page"]').click();
    record('Management selects whole cards without checkboxes, supports click/Space/Enter exactly once, hides individual tools and clears picks on exit');
    await setSelected(webId, false);
    const beforeBulkDraft = await page.evaluate(() => owner.fontLibrary);
    await page.locator('[data-font-action="bulk-tags"]').click(); await tagToggle('bulk').click();
    assert.equal(await tagPanel('bulk').locator('[data-font-action="tag-toggle"]').count(), 4);
    await tagChip('bulk', '中文').click(); await tagChip('bulk', '手写').click();
    assert.deepEqual(await parsedTags(page.locator('[data-font-bulk-value]')), ['中文', '手写']);
    assert.deepEqual(await page.evaluate(() => owner.fontLibrary), beforeBulkDraft);
    await page.locator('[data-font-action="manage"]').click();
    assert.deepEqual(await page.evaluate(() => owner.fontLibrary), beforeBulkDraft, 'Leaving management without saving discards only the bulk draft');
    await page.locator('[data-font-action="manage"]').click(); await setSelected(localId, true);
    await page.locator('[data-font-action="bulk-tags"]').click(); await tagToggle('bulk').click();
    await page.locator('[data-font-bulk-value]').fill('中文，喜爱,,');
    assert.equal(await tagChip('bulk', '中文').getAttribute('aria-pressed'), 'true');
    assert.equal(await tagChip('bulk', '手写').getAttribute('aria-pressed'), 'false');
    await page.locator('[data-font-action="bulk-save"]').click(); await settled();
    assert.deepEqual(await page.evaluate(id => owner.fontLibrary.fonts.find(font => font.id === id), webId), beforeBulkDraft.fonts.find(font => font.id === webId), 'Bulk tag confirmation affects only explicitly selected entries');
    assert.deepEqual(await page.evaluate(id => owner.fontLibrary.fonts.find(font => font.id === id).tags, localId), ['中文', '喜爱']);
    await page.locator('[data-font-action="select-page"]').click();
    record('Bulk tag reuse deduplicates across entries, leaves cancelled drafts unsaved and updates only the explicitly selected fonts');
    await page.locator('[data-font-action="bulk-tags"]').click(); await page.locator('[data-font-bulk-value]').fill('中文,喜爱'); await page.locator('[data-font-action="bulk-save"]').click(); await settled();
    assert.deepEqual(await page.evaluate(() => owner.fontLibrary.fonts.map(font => font.tags)), [['中文', '喜爱'], ['中文', '喜爱']]);
    await page.locator('[data-font-action="manage"]').click();
    await page.evaluate(() => { owner.fontLibrary.fonts[0].folder = '保全旧分类'; owner.fontLibrary.folders = ['保全旧分类']; });
    const beforeWebEdit = await page.evaluate(() => owner.fontLibrary);
    const beforeEditedFamily = await page.evaluate(() => hostFonts()['host-prose'].family);
    await setAddOpen(false);
    await page.locator(`[data-font-action="edit"][data-font-id="${webId}"]`).click();
    assert.equal(await page.locator('details.qm-font-add').evaluate(node => node.open), true, 'Editing a Web entry opens the add card without a second click');
    assert.equal(await page.locator('[data-font-web-name]').inputValue(), 'Web 样本');
    assert.equal(await page.locator('[data-font-web-source]').inputValue(), shortWebSource, 'Editing a 64-face imported stylesheet restores the concise original input rather than expanding every face');
    assert.deepEqual((await page.locator('[data-font-web-tags]').inputValue()).split(/[,，]/).map(value => value.trim()).filter(Boolean), ['中文', '喜爱']);
    assert.equal(await page.locator('[data-font-action="add-web"] .qm-glyph-icon').getAttribute('data-qm-icon'), 'qm-regular-check');
    await page.locator('[data-font-web-name]').fill('取消的改名');
    await page.locator('[data-font-web-tags]').fill('取消的标签');
    await tagToggle('web').click(); await tagChip('web', '中文').click();
    await page.locator('[data-font-action="cancel-web"]').click();
    assert.deepEqual(await page.evaluate(() => owner.fontLibrary), beforeWebEdit);
    await page.locator(`[data-font-action="edit"][data-font-id="${webId}"]`).click();
    await page.locator('[data-font-web-tags]').fill('中文,新增,新增');
    await tagToggle('web').click();
    assert.equal(await tagChip('web', '中文').getAttribute('aria-pressed'), 'true');
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
    assert.equal(await page.locator('[data-font-web-source]').inputValue(), 'https://fonts.test/edited.css', 'A subsequent source edit remains the new concise URL');
    await page.locator('[data-font-web-tags]').fill('中文，新增,标签续改');
    await page.locator('[data-font-action="add-web"]').click(); await settled();
    const afterTagOnly = await page.evaluate(() => ({ state: owner.fontLibrary, fonts: hostFonts() }));
    assert.deepEqual(afterTagOnly.fonts, beforeTagOnly.fonts, 'Changing only tags does not reload or replace the active font');
    assert.deepEqual(afterTagOnly.state.fonts.find(font => font.id === webId).tags, ['中文', '新增', '标签续改']);
    afterTagOnly.state.fonts.find(font => font.id === webId).tags = beforeTagOnly.state.fonts.find(font => font.id === webId).tags;
    assert.deepEqual(afterTagOnly.state, beforeTagOnly.state);
    record('Editing only Web tags changes just the requested classifications while leaving source, binary face and all other settings intact');
    await tagToggle('web').click();
    assert.equal(await tagChip('web', '标签续改').count(), 1, 'A newly saved tag immediately becomes reusable without reopening the library');
    await tagChip('web', '标签续改').click();
    assert.deepEqual(await parsedTags(page.locator('[data-font-web-tags]')), ['标签续改']);
    await page.locator('[data-font-web-tags]').fill(''); await page.keyboard.press('Escape');
    assert.equal(await tagPanel('web').isVisible(), false);
    record('Web editing shares reusable tags and check-mark submission; newly saved tags appear immediately while failed or cancelled edits keep original records');
    const legacyId = await page.evaluate(async source => {
        await library.action('add-web', { name: '旧档分片字体', source });
        const entry = owner.fontLibrary.fonts.find(font => font.name === '旧档分片字体');
        entry.source.input = '内嵌字体样式'; delete entry.source.url;
        return entry.id;
    }, segmentedCss.replaceAll('./fixture.ttf', 'https://fonts.test/fixture.ttf'));
    const beforeLegacyEdit = await page.evaluate(id => owner.fontLibrary.fonts.find(font => font.id === id), legacyId);
    await page.locator(`[data-font-action="edit"][data-font-id="${legacyId}"]`).click();
    assert.equal(await page.locator('[data-font-web-source]').inputValue(), '', 'Legacy segmented records without a retained source are not expanded or guessed');
    assert.match(await page.locator('[data-font-web-source]').getAttribute('placeholder'), /留空.*保留/);
    await page.locator('[data-font-web-name]').fill('旧档只改名称');
    await page.locator('[data-font-web-tags]').fill('旧档,全角，半角');
    await page.locator('[data-font-action="add-web"]').click(); await settled();
    const afterLegacyEdit = await page.evaluate(id => owner.fontLibrary.fonts.find(font => font.id === id), legacyId);
    assert.deepEqual(afterLegacyEdit, { ...beforeLegacyEdit, name: '旧档只改名称', tags: ['旧档', '全角', '半角'] }, 'A blank legacy source edit preserves all original faces while changing only requested metadata');
    await page.locator(`[data-font-action="delete-one"][data-font-id="${legacyId}"]`).click(); await settled();
    record('Web editing retains concise original references across updates; old segmented records without references allow blank-source metadata edits without losing faces');
    const beforeCompactRename = await page.evaluate(() => owner.fontLibrary), previousPreviewSize = await page.locator('[data-font-preview-size]').inputValue();
    await page.evaluate(async id => library.action('update-fonts', { ids: [id], tags: [] }), localId);
    await page.locator('[data-font-preview]').fill('Aa'); await page.locator('[data-font-preview]').dispatchEvent('change'); await settled(); await setPreviewSize(12);
    await setAddOpen(false); await page.setViewportSize({ width: 320, height: 650 });
    for (const family of ['classic', 'editorial', 'glass']) for (const mode of ['light', 'dark']) {
        await page.evaluate(async ({ family, mode }) => setTheme(family, mode), { family, mode });
        for (const order of ['asc', 'desc']) {
            await page.locator('[data-font-sort-order]').selectOption(order); await settled();
            assert.equal(await page.locator('.qm-font-card').nth(order === 'asc' ? 0 : 1).getAttribute('data-font-id'), localId, 'Compact local fixture covers both a following-card neighbor and the final list position');
            const beforeDraft = await page.evaluate(() => owner.fontLibrary);
            await cardFor(localId).locator('[data-font-action="edit"]').click();
            let geometry = await renameGeometry(localId);
            assert.equal(geometry.visible, true, `${family}/${mode}/${order}: the entire rename panel is visible inside the scroll viewport: ${JSON.stringify(geometry.bounds)}`);
            assert.equal(geometry.contained, true, 'The expanded name/tag editor is contained in its own card rather than overlapping a neighboring card');
            assert.equal(geometry.nextCardClear, true, 'A following card remains below the expanded editor card');
            assert.equal(geometry.bottom.hit, true, `${family}/${mode}/${order}: the popup bottom is not clipped or covered by the next card`);
            assert.ok(geometry.actions.length === 2 && geometry.actions.every(action => action.hit), `${family}/${mode}/${order}: save and cancel receive actual pointer hits`);
            await tagToggle(`rename-${localId}`).click();
            geometry = await renameGeometry(localId);
            assert.equal(geometry.visible, true, `${family}/${mode}/${order}: opening reusable tags keeps the whole editor visible without test scrolling`);
            assert.equal(geometry.contained && geometry.nextCardClear && geometry.actions.every(action => action.hit), true);
            assert.equal((await tagPanelFits(`rename-${localId}`)).fits, true);
            if (order === 'asc') await page.screenshot({ path: fileURLToPath(new URL(`local-rename-${family}-${mode}.png`, qa)) });
            await page.keyboard.press('Escape');
            assert.equal(await tagPanel(`rename-${localId}`).isVisible(), false, 'Escape dismisses reusable tags before closing the local editor');
            assert.equal(await page.locator(`[data-font-rename-pop="${localId}"]`).isVisible(), true);
            const saving = family === 'glass' && mode === 'dark' && order === 'desc';
            await page.locator(`[data-font-rename="${localId}"]`).fill(saving ? beforeDraft.fonts.find(font => font.id === localId).name : '取消草稿不写入');
            geometry = await renameGeometry(localId);
            const action = geometry.actions.find(action => action.action === (saving ? 'rename-save' : 'rename-cancel'));
            await page.mouse.click(action.x, action.y); await settled();
            assert.equal(await page.locator(`[data-font-rename-pop="${localId}"]`).isVisible(), false);
            assert.deepEqual(await page.evaluate(() => owner.fontLibrary), beforeDraft, 'Cancelling or saving the unchanged name never alters original font metadata or assignments');
        }
    }
    await page.evaluate(async ({ id, tags }) => library.action('update-fonts', { ids: [id], tags }), { id: localId, tags: beforeCompactRename.fonts.find(font => font.id === localId).tags });
    await page.locator('[data-font-preview]').fill(beforeCompactRename.previewText); await page.locator('[data-font-preview]').dispatchEvent('change'); await settled();
    await setPreviewSize(previousPreviewSize); await page.locator('[data-font-sort-order]').selectOption('asc'); await settled();
    await page.setViewportSize({ width: 393, height: 850 }); await page.evaluate(async () => setTheme('classic', 'light'));
    assert.deepEqual(await page.evaluate(() => owner.fontLibrary), beforeCompactRename);
    assert.deepEqual(Buffer.from(await page.evaluate(async id => [...new Uint8Array(await (await localStore.get(id)).arrayBuffer())], localId)), bytes);
    record('At 320px all themes expand local name/tag editors inside their own card; first and last items and reusable tags remain fully visible without test scrolling, and real save/cancel hits preserve originals');
    const beforeRename = await page.evaluate(() => owner.fontLibrary), beforeRenameWrites = await page.evaluate(() => ({ saved, localWrites: [...localWrites] }));
    await page.locator(`[data-font-action="edit"][data-font-id="${localId}"]`).click();
    assert.equal(await page.locator(`[data-font-rename-pop="${localId}"]`).isVisible(), true);
    await page.locator(`[data-font-rename="${localId}"]`).fill('未保存的本地改名');
    await page.locator(`[data-font-rename-tags="${localId}"]`).fill('手输,全角，半角');
    await tagToggle(`rename-${localId}`).click(); await tagChip(`rename-${localId}`, '中文').click();
    assert.deepEqual(await parsedTags(page.locator(`[data-font-rename-tags="${localId}"]`)), ['手输', '全角', '半角', '中文']);
    assert.equal(await tagChip(`rename-${localId}`, '中文').getAttribute('aria-pressed'), 'true');
    await page.locator(`[data-font-action="rename-cancel"][data-font-id="${localId}"]`).click();
    assert.deepEqual(await page.evaluate(() => owner.fontLibrary), beforeRename);
    assert.deepEqual(await page.evaluate(() => ({ saved, localWrites: [...localWrites] })), beforeRenameWrites);
    await page.locator(`[data-font-action="edit"][data-font-id="${localId}"]`).click();
    await page.locator(`[data-font-rename="${localId}"]`).fill('Local 已改名');
    await page.locator(`[data-font-rename-tags="${localId}"]`).fill('本地,续改，中文,续改');
    await page.evaluate(() => { rejectNextFontSave = true; });
    await page.locator(`[data-font-action="rename-save"][data-font-id="${localId}"]`).click(); await settled();
    assert.deepEqual(await page.evaluate(() => owner.fontLibrary), beforeRename, 'A failed local metadata save preserves original records and assignments');
    assert.equal(await page.locator(`[data-font-rename="${localId}"]`).inputValue(), 'Local 已改名');
    assert.equal(await page.locator(`[data-font-rename-tags="${localId}"]`).inputValue(), '本地,续改，中文,续改');
    await page.locator(`[data-font-action="rename-save"][data-font-id="${localId}"]`).click(); await settled();
    const afterRename = await page.evaluate(() => owner.fontLibrary), renamed = afterRename.fonts.find(font => font.id === localId), originalLocal = beforeRename.fonts.find(font => font.id === localId);
    assert.deepEqual({ ...renamed, name: originalLocal.name, tags: originalLocal.tags }, originalLocal);
    assert.equal(renamed.name, 'Local 已改名');
    assert.deepEqual(renamed.tags, ['本地', '续改', '中文']);
    assert.deepEqual([afterRename.body, afterRename.st, afterRename.shared], [beforeRename.body, beforeRename.st, beforeRename.shared]);
    assert.deepEqual(await page.evaluate(() => localWrites), beforeRenameWrites.localWrites, 'Editing local metadata never rewrites the stored original binary');
    assert.deepEqual(Buffer.from(await page.evaluate(async id => [...new Uint8Array(await (await localStore.get(id)).arrayBuffer())], localId)), bytes);
    record('Local editing supports reusable/mixed-comma tags, cancels without writes, retains drafts on failure, and saves only name/tags while preserving identity, applied choices and original bytes');
    await page.evaluate(async ({ webId, localId }) => {
        await library.action('update-fonts', { ids: [webId], name: 'A Web 包内记录' });
        await library.action('update-fonts', { ids: [localId], name: 'B Local 包内记录' });
        for (let index = 1; index <= 8; index++) await library.action('add-web', { name: `M 不选入包 ${index}`, source: `https://fonts.test/unselected-${index}.ttf` });
    }, { webId, localId });
    await setAddOpen(true);
    await page.locator('[data-font-file="local"]').setInputFiles({ name: 'Second Original.ttf', mimeType: 'font/ttf', buffer: secondBytes });
    await page.locator('[data-font-local-dialog]').waitFor();
    await page.locator('[data-font-local-name="0"]').fill('Z 第二种本地原件');
    await page.locator('[data-font-local-tags="0"]').fill('衬线,第二原件');
    await page.locator('[data-font-action="local-confirm"]').click(); await settled();
    const secondLocalId = await page.evaluate(() => owner.fontLibrary.fonts.find(font => font.name === 'Z 第二种本地原件').id);
    assert.notEqual(secondLocalId, localId);
    assert.equal(await page.evaluate(() => owner.fontLibrary.fonts.length), 11);
    await page.locator('[data-font-action="previous"]').click();
    await page.locator('[data-font-action="manage"]').click();
    await setSelected(webId, true);
    await setSelected(localId, true);
    await page.locator('[data-font-action="next"]').click();
    await setSelected(secondLocalId, true);
    assert.match(await page.locator('[data-font-selection-count]').textContent(), /3/);
    assert.equal(await page.locator('[data-font-action="top"]').evaluate(node => node.nextElementSibling?.matches('[data-font-action="next"]')), true, 'Return-to-top is immediately before the next-page control');
    await page.locator('[data-font-action="top"]').scrollIntoViewIfNeeded();
    const beforeTop = await page.evaluate(() => ({ page: document.querySelector('.qm-font-pagination>span').textContent, query: document.querySelector('[data-font-search]').value, selected: document.querySelector('[data-font-selection-count]').textContent, ids: [...document.querySelectorAll('.qm-font-card')].map(node => [node.dataset.fontId, node.getAttribute('aria-pressed')]), globalScroll: window.scrollY, saved }));
    assert.ok(await page.locator('.qm-font-window>.sd-body').evaluate(node => node.scrollTop > 0), 'Page-two return-to-top starts from a genuinely scrolled panel');
    await page.locator('[data-font-action="top"]').click();
    await page.waitForFunction(() => document.querySelector('.qm-font-window>.sd-body').scrollTop < 1);
    assert.deepEqual(await page.evaluate(() => ({ page: document.querySelector('.qm-font-pagination>span').textContent, query: document.querySelector('[data-font-search]').value, selected: document.querySelector('[data-font-selection-count]').textContent, ids: [...document.querySelectorAll('.qm-font-card')].map(node => [node.dataset.fontId, node.getAttribute('aria-pressed')]), globalScroll: window.scrollY, saved })), beforeTop, 'Returning to the top changes only the font-panel scroll position');
    record('Quick return-to-top sits beside next-page and scrolls only the font panel without changing page, query, cross-page picks or persistent settings');
    await page.locator('[data-font-action="select-page"]').click();
    assert.match(await page.locator('[data-font-selection-count]').textContent(), /2/, 'Deselect page only changes the current page');
    await page.locator('[data-font-action="select-page"]').click();
    await page.locator('[data-font-action="previous"]').click();
    assert.equal(await page.locator('.qm-font-card[aria-pressed="true"]').count(), 2, 'Selections on page one survive visiting page two');
    assert.match(await page.locator('[data-font-selection-count]').textContent(), /3/);
    const selectedRecords = await page.evaluate(ids => owner.fontLibrary.fonts.filter(font => ids.includes(font.id)), [webId, localId, secondLocalId]);
    const beforeMissingOriginal = await page.evaluate(() => ({ state: owner.fontLibrary, saved }));
    await page.evaluate(async id => { window.missingOriginal = await localStore.get(id); await localStore.delete([id]); }, secondLocalId);
    await page.locator('[data-font-action="export-selected"]').click(); await settled();
    assert.equal(await page.evaluate(() => downloads.length), 0, 'A missing selected local original refuses the whole export instead of downloading an incomplete package');
    assert.match(await page.evaluate(() => notifications.at(-1).message), /缺少.*原件|不完整/);
    assert.equal(await page.evaluate(() => notifications.at(-1).level), 'warning');
    assert.equal(await page.locator('.qm-font-status').count(), 0, 'Operation feedback no longer accumulates below the library');
    assert.deepEqual(await page.evaluate(() => ({ state: owner.fontLibrary, saved })), beforeMissingOriginal);
    await page.evaluate(async id => { await localStore.put(id, missingOriginal); delete window.missingOriginal; }, secondLocalId);
    await page.locator('[data-font-action="export-selected"]').click(); await settled(); await page.waitForFunction(() => downloads.length === 1);
    const pack = await page.evaluate(() => downloads[0].text), packed = JSON.parse(pack);
    assert.equal(packed.fonts.length, 3, 'Cross-page selected fonts produce one package, not separate downloads');
    assert.deepEqual(packed.fonts, selectedRecords, 'Only selected metadata and original source declarations enter the package');
    assert.equal(packed.fonts.some(font => font.name.startsWith('M 不选入包')), false);
    assert.deepEqual(Object.keys(packed.localFiles).sort(), [localId, secondLocalId].sort());
    assert.ok(Buffer.from(packed.localFiles[localId], 'base64').equals(bytes));
    assert.ok(Buffer.from(packed.localFiles[secondLocalId], 'base64').equals(secondBytes));
    record('Cross-page multi-selection exports one exact Web-plus-two-local package, excludes every unselected entry and refuses export when any selected original is missing');
    await page.locator('[data-font-action="select-page"]').click();
    assert.match(await page.locator('[data-font-selection-count]').textContent(), /11/);
    await page.evaluate(() => { acceptDelete = false; }); await page.locator('[data-font-action="delete"]').click(); await settled();
    assert.equal(await page.evaluate(() => owner.fontLibrary.fonts.length), 11);
    await page.evaluate(() => { acceptDelete = true; }); await page.locator('[data-font-action="delete"]').click(); await settled();
    assert.equal(await page.evaluate(() => owner.fontLibrary.fonts.length), 0);
    assert.equal(await page.evaluate(async ids => (await Promise.all(ids.map(id => localStore.get(id)))).every(blob => blob === null), [localId, secondLocalId]), true);
    await page.evaluate(() => { library.dispose(); owner = {}; library = createSyntheticLibrary(); library.attach(document.getElementById('story-director-floor-nav')); });
    await page.locator('[data-font-library]').click(); await page.locator('[data-font-web-source]').waitFor();
    const invalidPack = structuredClone(packed); delete invalidPack.localFiles[secondLocalId];
    const beforeIncompleteImport = await page.evaluate(() => ({ owner, writes: localWrites.length, saved }));
    const successBeforeImport = await page.evaluate(() => notifications.filter(item => item.level === 'success').length);
    await page.locator('[data-font-file="import"]').setInputFiles({ name: 'incomplete.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(invalidPack)) }); await settled();
    assert.deepEqual(await page.evaluate(() => ({ owner, writes: localWrites.length, saved })), beforeIncompleteImport, 'Incomplete import is rejected before any metadata or binary write');
    await page.locator('[data-font-file="import"]').setInputFiles({ name: 'roundtrip.json', mimeType: 'application/json', buffer: Buffer.from(pack) }); await settled();
    await page.waitForFunction(() => document.querySelectorAll('[data-font-sample]').length === 3);
    const importedRecords = await page.evaluate(() => owner.fontLibrary.fonts);
    const metadataByName = values => values.map(({ id, ...font }) => font).sort((a, b) => a.name.localeCompare(b.name));
    assert.deepEqual(metadataByName(importedRecords), metadataByName(selectedRecords), 'Fresh-account import restores all names, tags, legacy fields, variants and Web references');
    assert.equal(await page.evaluate(() => owner.fontLibrary.previewText), packed.previewText, 'Import into an empty collection retains the packaged common preview text');
    const importedBinaries = await page.evaluate(async () => {
        const result = {};
        for (const font of owner.fontLibrary.fonts.filter(item => item.source.kind === 'local')) {
            const blob = await localStore.get(font.id); result[font.name] = await new Promise(resolve => { const reader = new FileReader(); reader.onload = () => resolve(reader.result.split(',')[1]); reader.readAsDataURL(blob); });
        }
        return result;
    });
    assert.ok(Buffer.from(importedBinaries['B Local 包内记录'], 'base64').equals(bytes));
    assert.ok(Buffer.from(importedBinaries['Z 第二种本地原件'], 'base64').equals(secondBytes));
    assert.equal(await page.evaluate(() => owner.fontLibrary.body.enabled || owner.fontLibrary.st.enabled || owner.fontLibrary.shared.enabled), false);
    assert.equal(await page.evaluate(() => notifications.filter(item => item.level === 'success').length), successBeforeImport, 'Package import previews records but must not emit host-application success');
    await page.locator(`[data-font-action="delete-one"][data-font-id="${secondLocalId}"]`).click(); await settled();
    await page.evaluate(async () => { for (const [oldName, name] of [['A Web 包内记录', 'Web 样本·已编辑'], ['B Local 包内记录', 'Local 已改名']]) { const font = owner.fontLibrary.fonts.find(item => item.name === oldName); await library.action('update-fonts', { ids: [font.id], name }); } });
    assert.equal(await page.locator('[data-font-sample]').count(), 2);
    await setPreviewSize(20);
    record('A fresh synthetic account imports the mixed package with exact original bytes and metadata; incomplete packages save nothing and imports never auto-apply fonts');
    if (await page.locator('[data-font-action="manage"]').getAttribute('aria-expanded') === 'true') await page.locator('[data-font-action="manage"]').click();
    await page.locator('[data-font-search]').fill('Web 样本');
    assert.equal(await page.locator('[data-font-sample]').count(), 1);
    await page.locator('[data-font-search]').fill('中文');
    assert.equal(await page.locator('[data-font-sample]').count(), 2);
    await page.locator('[data-font-search]').fill('保全旧分类');
    assert.equal(await page.locator('[data-font-sample]').count(), 0, 'Archived folder metadata is no longer a search dimension');
    await page.locator('[data-font-search]').fill('');
    assert.equal(await page.locator('[data-font-sample]').count(), 2);
    assert.equal(await page.locator('[data-font-action="filter"],[data-font-action="bulk-folder"],[data-font-folder-choice],[data-font-tag],.sd-reader-tags,[data-font-action="export-all"]').count(), 0);
    record('Search matches names and tags only; removed folders and tag-filter bars cannot leave invisible legacy-session filtering');
    await page.evaluate(async () => { const font = owner.fontLibrary.fonts[0]; await library.action('update-fonts', { ids: [font.id], tags: [...font.tags, '连续长标签'.repeat(12)] }); });
    for (const width of [320, 393, 1280]) for (const family of ['classic', 'editorial', 'glass']) for (const mode of ['light', 'dark']) {
        await setAddOpen(true);
        await page.setViewportSize({ width, height: 850 }); await page.evaluate(async ({ family, mode }) => setTheme(family, mode), { family, mode });
        if (width === 320) {
            const settingsBeforeToggle = await page.evaluate(() => ({ fonts: owner.fontLibrary.fonts, body: owner.fontLibrary.body, st: owner.fontLibrary.st, shared: owner.fontLibrary.shared }));
            for (const checked of [false, true]) {
                await page.locator('[data-font-enabled]').setChecked(checked); await settled();
                const toggle = await switchGeometry();
                assert.deepEqual({ ...toggle, radius: undefined }, { checked, width: 38, height: 22, thumbWidth: 16, thumbHeight: 16, radius: undefined, scaleX: 1, scaleY: 1, shift: checked ? 16 : 0, clip: 'none', shadow: 'none', visible: true, oldTickHidden: true }, `${family}/${mode}: the real ST checkbox cascade cannot hide or clip the switch thumb`);
                assert.ok(toggle.radius.includes('50%') || parseFloat(toggle.radius) >= 8, 'The switch thumb remains a circle in every theme');
                if (!checked) {
                    await setAddOpen(false); await page.evaluate(() => { document.querySelector('.qm-font-window>.sd-body').scrollTop = 0; });
                    await page.screenshot({ path: fileURLToPath(new URL(`${family}-${mode}-switch-off.png`, qa)) }); await setAddOpen(true);
                }
            }
            assert.deepEqual(await page.evaluate(() => ({ fonts: owner.fontLibrary.fonts, body: owner.fontLibrary.body, st: owner.fontLibrary.st, shared: owner.fontLibrary.shared })), settingsBeforeToggle);
        }
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
                    return { tail: !!tools?.lastElementChild?.contains(select), line: !!select && Math.abs(name.getBoundingClientRect().top + name.getBoundingClientRect().height / 2 - select.getBoundingClientRect().top - select.getBoundingClientRect().height / 2) <= 2, weight: getComputedStyle(name.querySelector('strong')).fontWeight };
                }),
                toolbarOrder: [...host.querySelector('.qm-font-toolbar').children].map(node => node.matches('[data-font-search]') ? 'search' : node.matches('[data-font-action="manage"]') ? 'manage' : node.querySelector('[data-font-sort-order]') ? 'sort' : '?'),
                imports: [...host.querySelector('.qm-font-imports').children].map(node => ({ top: node.getBoundingClientRect().top, height: node.getBoundingClientRect().height, width: node.getBoundingClientRect().width, text: node.textContent.trim(), icons: node.querySelectorAll('.qm-glyph-icon').length })),
                enable: (() => { const node = host.querySelector('.qm-font-enable'), label = node.querySelector('strong,span') || node, style = getComputedStyle(label); return { fontSize: style.fontSize, fontWeight: style.fontWeight }; })(),
                bodyControls: [...host.querySelectorAll('[data-font-web-name],[data-font-web-source],[data-font-web-tags],[data-font-preview],[data-font-search],[data-font-apply],[data-font-preview-size]')].map(node => getComputedStyle(node).fontSize),
                editor: (() => { const editor = host.querySelector('.qm-font-preview-editor').getBoundingClientRect(), card = host.querySelector('.qm-font-card').getBoundingClientRect(); return { left: editor.left - card.left, right: editor.right - card.right }; })(),
                previewTool: (() => { const head = host.querySelector('.qm-font-preview-editor .qm-font-field-head').getBoundingClientRect(), tool = host.querySelector('.qm-font-size-pick').getBoundingClientRect(); return { width: tool.width, height: tool.height, right: head.right - tool.right, top: tool.top - head.top, semantic: host.querySelector('.qm-font-size-pick .qm-glyph-icon')?.dataset.qmIcon }; })(),
                summaryMarker: (() => { const node = host.querySelector('.qm-font-add>summary'), style = getComputedStyle(node); return { display: style.display, listStyle: style.listStyleType, content: getComputedStyle(node, '::marker').content }; })(),
                listGap: getComputedStyle(host.querySelector('.qm-font-list')).rowGap,
                listHitAreas: [...host.querySelectorAll('.qm-font-card-tools .qm-font-icon')].map(node => ({ width: node.getBoundingClientRect().width, height: node.getBoundingClientRect().height })),
                bareTools: [...host.querySelectorAll('.qm-font-card-tools .qm-font-icon')].map(node => { const style = getComputedStyle(node); return { background: style.backgroundColor, border: style.borderTopWidth, shadow: style.boxShadow, weight: style.fontWeight }; }),
                iconShapes: [...panel.querySelectorAll('.qm-font-icon,.qm-font-file-pick')].filter(node => node.offsetParent).map(node => ({ header: !!node.closest('.qm-font-header'), radius: getComputedStyle(node).borderTopLeftRadius, width: node.getBoundingClientRect().width, height: node.getBoundingClientRect().height })),
                filePicks: [...host.querySelectorAll('.qm-font-file-pick')].map(node => ({ color: getComputedStyle(node).color, opacity: getComputedStyle(node).opacity, display: getComputedStyle(node).display, input: { color: getComputedStyle(node.querySelector('input')).color, opacity: getComputedStyle(node.querySelector('input')).opacity, display: getComputedStyle(node.querySelector('input')).display } })),
                tagPills: [...host.querySelectorAll('.qm-font-tag')].map(node => { const style = getComputedStyle(node), rect = node.getBoundingClientRect(), card = node.closest('.qm-font-card').getBoundingClientRect(); return { text: node.textContent, color: style.color, background: style.backgroundColor, border: parseFloat(style.borderTopWidth), fits: rect.left >= card.left && rect.right <= card.right && node.scrollWidth <= node.clientWidth + 1, wrap: style.overflowWrap }; }),
                previewFamilies: [...host.querySelectorAll('[data-font-sample]')].map(node => getComputedStyle(node).fontFamily),
                previewSizes: [...host.querySelectorAll('[data-font-sample]')].map(node => getComputedStyle(node).fontSize),
                manageVariants: [...host.querySelectorAll('[data-font-action="manage"] [data-qm-icon-variant]')].filter(node => getComputedStyle(node).display !== 'none').map(node => node.dataset.qmIconVariant),
                applyVariants: [...host.querySelectorAll('.qm-font-apply-pick [data-qm-icon-variant]')].filter(node => getComputedStyle(node).display !== 'none').map(node => node.dataset.qmIconVariant),
                iconVariants: [...panel.querySelectorAll('[data-font-action="back"] [data-qm-icon-variant]')].filter(node => getComputedStyle(node).display !== 'none').map(node => node.dataset.qmIconVariant) };
        });
        assert.equal(measured.panel, true, `${width}/${family}/${mode} panel fits`); assert.equal(measured.noOverflow, true, `${width}/${family}/${mode} content fits`); assert.equal(measured.controlsFit, true, `${width}/${family}/${mode} controls fit`);
        assert.notEqual(measured.color, measured.bg); assert.equal(measured.titleSize, '16px'); assert.equal(measured.titleFamily, measured.mainTitleFamily);
        assert.deepEqual(measured.material, measured.mainMaterial, `${family}/${mode}: same main-panel surface, corner and filter treatment`);
        assert.ok(measured.titleRows.every(row => row.tail && row.line), `${width}/${family}/${mode} application is the title-tools tail on the same line`);
        assert.ok(measured.titleRows.every(row => row.weight === '400'), 'Font entry names use regular weight');
        assert.ok(measured.toolbarOrder[0] === 'search' && measured.toolbarOrder.length === 3 && measured.toolbarOrder.includes('sort') && measured.toolbarOrder.includes('manage'), 'Name sorting sits beside management, after search');
        assert.deepEqual(measured.imports.map(item => item.text), ['上传本地字体', '导入字体包']);
        assert.ok(measured.imports.every(item => Math.abs(item.top - measured.imports[0].top) <= 1 && Math.abs(item.height - measured.imports[0].height) <= 1 && Math.abs(item.width - measured.imports[0].width) <= 1 && item.text && !item.icons), `${width}/${family}/${mode} local upload and package import are text-only, equal-width and equal-height`);
        assert.equal(measured.enable.fontSize, '14px'); assert.ok(Number(measured.enable.fontWeight) >= 600);
        assert.ok(measured.bodyControls.every(value => value === '12px'), 'Body controls share the main-panel 12px body tier');
        assert.ok(Math.abs(measured.editor.left) <= 1 && Math.abs(measured.editor.right) <= 1, `${width}/${family}/${mode} preview editor aligns with list-card edges`);
        assert.deepEqual({ ...measured.previewTool, semantic: undefined }, { width: 28, height: 28, right: 0, top: 0, semantic: undefined }, 'The 28px sample-size control aligns to the upper-right of its card header');
        assert.equal(measured.previewTool.semantic, 'qm-signature-font-preview-size', 'Sample size uses its dedicated smallcaps semantic icon');
        assert.equal(measured.summaryMarker.listStyle, 'none', 'The add-card summary has no native disclosure arrow');
        assert.equal(measured.listGap, '6px', 'Only inter-card spacing is tightened to 6px');
        assert.ok(measured.listHitAreas.every(area => area.width === 28 && area.height === 28), 'Tighter card spacing preserves every 28px list action hit area');
        assert.ok(measured.bareTools.every(tool => tool.background === 'rgba(0, 0, 0, 0)' && tool.border === '0px' && tool.shadow === 'none'), `${family}/${mode}: list actions have no individual background shell, border or shadow`);
        for (const shape of measured.iconShapes) {
            const circular = shape.radius.includes('%') ? parseFloat(shape.radius) >= 50 : parseFloat(shape.radius) >= Math.min(shape.width, shape.height) / 2 - 1;
            assert.equal(circular, family === 'glass' && shape.header, `${width}/${family}/${mode} only glass header navigation remains circular`);
            if (family === 'editorial') assert.equal(parseFloat(shape.radius), 0, 'Paper action controls keep square corners');
        }
        assert.ok(measured.filePicks.every(pick => pick.opacity === '1' && pick.input.opacity === '0' && pick.color === measured.filePicks[0].color), 'Native file inputs stay transparent and both labels retain matching readable ink');
        assert.ok(measured.tagPills.length >= 6 && measured.tagPills.every(pill => !pill.text.startsWith('#') && pill.fits && pill.color !== pill.background && (pill.border > 0 || !['transparent', 'rgba(0, 0, 0, 0)'].includes(pill.background))), `${width}/${family}/${mode} card tags have visible pill treatment without hash prefixes or clipping`);
        assert.ok(measured.tagPills.some(pill => pill.text.length === 60 && pill.wrap === 'anywhere'), 'Long tag text can wrap inside its own card');
        assert.ok(measured.previewFamilies.every(value => value.includes('QianmuFont_')), `${family} list previews retain selected font despite theme CSS`);
        assert.ok(measured.previewSizes.every(value => value === '20px'), `${family} preview size remains session-local through theme changes`);
        assert.deepEqual(measured.iconVariants, [family === 'editorial' ? 'bold' : family === 'glass' ? 'twotone' : 'outline']);
        assert.deepEqual(measured.manageVariants, ['outline'], 'Management uses the requested fixed document-filter outline icon');
        assert.ok(measured.applyVariants.length === 2 && measured.applyVariants.every(value => value === 'outline'), 'Unapplied state uses tick-square outline regardless of theme');
        record(`${width}/${family}/${mode}: 16px title, visible host-resistant switch, upper-right sample size, bare list actions and compact tags without clipping`);
        if (width === 320) {
            await tagToggle('web').click();
            assert.deepEqual(await tagPanelFits('web'), { fits: true, limited: true, chipsFit: true }, `${family}/${mode}: reusable tags and long labels remain bounded at 320px`);
            const tagTexts = await tagPanel('web').locator('[data-font-action="tag-toggle"]').allTextContents();
            assert.equal(new Set(tagTexts).size, tagTexts.length, 'Saved tags are never duplicated between fonts in the reuse panel');
            await page.locator('[data-font-web-tags]').fill('中文，标签续改,,');
            assert.equal(await tagChip('web', '中文').getAttribute('aria-pressed'), 'true');
            assert.equal(await tagChip('web', '标签续改').getAttribute('aria-pressed'), 'true');
            await tagPanel('web').scrollIntoViewIfNeeded();
            await page.screenshot({ path: fileURLToPath(new URL(`${family}-${mode}-tag-picker-narrow.png`, qa)) });
            await page.keyboard.press('Escape');
            assert.equal(await tagPanel('web').isVisible(), false);
            await page.locator('[data-font-web-tags]').fill('');
        }
        if (width === 393 && mode === 'dark') {
            await page.evaluate(() => { document.querySelector('.qm-font-window>.sd-body').scrollTop = 0; });
            await page.screenshot({ path: fileURLToPath(new URL(`${family}-add-open.png`, qa)) });
            await setAddOpen(false);
            await page.evaluate(() => { document.querySelector('.qm-font-window>.sd-body').scrollTop = 0; });
            await page.screenshot({ path: fileURLToPath(new URL(`${family}-${mode}.png`, qa)) });
            await setAddOpen(true);
        }
        if (width === 320) {
            await setAddOpen(false);
            await page.evaluate(() => { document.querySelector('.qm-font-window>.sd-body').scrollTop = 0; });
            await page.screenshot({ path: fileURLToPath(new URL(`${family}-${mode}-tags-narrow.png`, qa)) });
            await page.locator('[data-font-action="manage"]').click();
            const card = page.locator('.qm-font-card').first(), appearance = node => { const style = getComputedStyle(node); return [style.backgroundColor, style.borderColor, style.outlineColor, style.outlineStyle, style.boxShadow]; };
            const unselectedAppearance = await card.evaluate(appearance);
            await card.locator('[data-font-sample]').click();
            await card.evaluate(async node => { void getComputedStyle(node).backgroundColor; await Promise.all(node.getAnimations().map(animation => animation.finished.catch(() => {}))); });
            assert.equal(await card.getAttribute('aria-pressed'), 'true');
            assert.notDeepEqual(await card.evaluate(appearance), unselectedAppearance, `${family}/${mode}: selected cards have a visible background or border state`);
            assert.equal(await page.locator('[data-font-select]').count(), 0);
            assert.equal(await card.locator('.qm-font-card-tools').isVisible(), false);
            await page.screenshot({ path: fileURLToPath(new URL(`${family}-${mode}-selection.png`, qa)) });
            await page.locator('[data-font-action="manage"]').click();
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
    await page.locator('[data-font-web-name]').fill('AAA 分页 9');
    await page.locator('[data-font-web-source]').fill('https://fonts.test/page-9.ttf');
    await page.locator('[data-font-action="add-web"]').click(); await settled();
    assert.equal(await page.locator('[data-font-search]').inputValue(), '', 'A new addition clears stale filters so the user can see the new font');
    const sortedAfterAddition = orderedFonts(await page.evaluate(() => owner.fontLibrary)), addedIndex = sortedAfterAddition.findIndex(font => font.name === 'AAA 分页 9'), addedFontId = sortedAfterAddition[addedIndex].id;
    assert.ok(addedIndex < 10 && addedIndex !== sortedAfterAddition.length - 1, 'The chosen name sorts onto page one rather than its last insertion position');
    assert.equal(await page.locator('[data-font-sample]').count(), 10, 'New-font reveal uses the sorted page, not the original array position');
    assert.deepEqual(await page.locator('.qm-font-name strong').allTextContents(), sortedAfterAddition.slice(0, 10).map(font => font.name));
    assert.equal(await cardFor(addedFontId).getAttribute('data-font-revealed'), 'true');
    const revealed = await cardFor(addedFontId).evaluate(async node => {
        const body = node.closest('.sd-body'), cardRect = node.getBoundingClientRect(), bodyRect = body.getBoundingClientRect(), animation = getComputedStyle(node).animationName;
        await Promise.all(node.getAnimations().map(item => item.finished.catch(() => {})));
        return { visible: cardRect.top >= bodyRect.top - 1 && cardRect.bottom <= bodyRect.bottom + 1, animation, finalOpacity: getComputedStyle(node).opacity, pageScroll: window.scrollY };
    });
    assert.deepEqual(revealed, { visible: true, animation: 'qm-font-reveal', finalOpacity: '1', pageScroll: 0 }, 'The newly added card is in view, fades in once, and scrolls only the font-library body');
    assert.equal(await page.locator('[data-font-sample]').count(), 10);
    await page.locator('[data-font-action="next"]').click();
    assert.equal(await page.locator('[data-font-sample]').count(), 1);
    assert.deepEqual(await page.locator('.qm-font-name strong').allTextContents(), sortedAfterAddition.slice(10).map(font => font.name), 'Names are sorted before the ten-card pagination split');
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
    const beforeOrdering = await page.evaluate(() => ({ fonts: owner.fontLibrary.fonts, enabled: owner.fontLibrary.enabled, body: owner.fontLibrary.body, st: owner.fontLibrary.st, shared: owner.fontLibrary.shared }));
    const pinIds = await page.evaluate(() => ['分页 3', 'Local 已改名'].map(name => owner.fontLibrary.fonts.find(font => font.name === name).id));
    for (const id of pinIds) { await showFont(id); await cardFor(id).locator('[data-font-action="pin"]').click(); await settled(); }
    assert.deepEqual(await page.evaluate(() => owner.fontLibrary.pinnedIds), pinIds);
    assert.deepEqual(await page.locator('.qm-font-card').evaluateAll(nodes => nodes.slice(0, 2).map(node => node.dataset.fontId)), pinIds, 'Pins appear in the order they were pinned');
    await page.locator('[data-font-sort-order]').selectOption('desc'); await settled();
    assert.equal(await page.evaluate(() => owner.fontLibrary.sortOrder), 'desc');
    assert.deepEqual(await page.locator('.qm-font-name strong').allTextContents(), orderedFonts(await page.evaluate(() => owner.fontLibrary)).slice(0, 10).map(font => font.name));
    assert.deepEqual(await page.locator('.qm-font-card').evaluateAll(nodes => nodes.slice(0, 2).map(node => node.dataset.fontId)), pinIds, 'Descending name order never reverses pins');
    await cardFor(pinIds[0]).locator('[data-font-action="pin"]').click(); await settled();
    assert.deepEqual(await page.evaluate(() => owner.fontLibrary.pinnedIds), [pinIds[1]]);
    await showFont(pinIds[0]); await cardFor(pinIds[0]).locator('[data-font-action="pin"]').click(); await settled();
    assert.deepEqual(await page.evaluate(() => owner.fontLibrary.pinnedIds), [pinIds[1], pinIds[0]], 'Re-pinning appends after the pins that remained');
    await page.locator('[data-font-search]').fill('分页');
    assert.equal(await page.locator('.qm-font-card').first().getAttribute('data-font-id'), pinIds[0]);
    assert.deepEqual(await page.evaluate(() => owner.fontLibrary.pinnedIds), [pinIds[1], pinIds[0]], 'Searching hides non-matches without deleting their pins');
    await page.locator('[data-font-search]').fill('');
    await page.locator('[data-font-action="manage"]').click();
    await setSelected(pinIds[0], true); await setSelected(pinIds[1], true);
    const crossPageId = orderedFonts(await page.evaluate(() => owner.fontLibrary)).at(-1).id;
    await showFont(crossPageId); await setSelected(crossPageId, true);
    assert.match(await page.locator('[data-font-selection-count]').textContent(), /3/);
    for (const mode of ['asc', 'desc', 'added-asc', 'added-desc']) {
        await page.locator('[data-font-sort-order]').selectOption(mode); await settled();
        const state = await page.evaluate(() => owner.fontLibrary), sorted = orderedFonts(state);
        assert.equal(state.sortBy, mode.startsWith('added-') ? 'added' : 'name');
        assert.equal(state.sortOrder, mode.endsWith('desc') ? 'desc' : 'asc');
        assert.deepEqual(await page.locator('.qm-font-card').evaluateAll(nodes => nodes.map(node => node.dataset.fontId)), sorted.slice(0, 10).map(font => font.id), `${mode}: ordering is applied before ten-card pagination`);
        assert.deepEqual(sorted.slice(0, 2).map(font => font.id), [pinIds[1], pinIds[0]], `${mode}: pinned entries retain pin-time order`);
        await cataloguePage(1);
        assert.deepEqual(await page.locator('.qm-font-card').evaluateAll(nodes => nodes.map(node => node.dataset.fontId)), sorted.slice(10).map(font => font.id));
        for (const id of [...pinIds, crossPageId]) { await showFont(id); assert.equal(await cardFor(id).getAttribute('aria-pressed'), 'true', `${mode}: sorting does not lose managed selections across pages`); }
    }
    await page.locator('[data-font-sort-order]').selectOption('desc'); await settled();
    assert.match(await page.locator('[data-font-selection-count]').textContent(), /3/);
    await page.locator('[data-font-action="manage"]').click();
    await page.locator('[data-font-action="back"]').click(); await page.locator('[data-font-library]').click(); await page.locator('[data-font-sort-order]').waitFor();
    assert.equal(await page.locator('[data-font-sort-order]').inputValue(), 'desc');
    assert.deepEqual(await page.locator('.qm-font-card').evaluateAll(nodes => nodes.slice(0, 2).map(node => node.dataset.fontId)), [pinIds[1], pinIds[0]]);
    await page.evaluate(() => { library.dispose(); library = createSyntheticLibrary(); library.attach(document.getElementById('story-director-floor-nav')); });
    await page.locator('[data-font-library]').click(); await page.locator('[data-font-sort-order]').waitFor();
    assert.equal(await page.locator('[data-font-sort-order]').inputValue(), 'desc', 'Sorting restores from persisted settings in a fresh view instance');
    assert.deepEqual(await page.evaluate(() => owner.fontLibrary.pinnedIds), [pinIds[1], pinIds[0]]);
    assert.deepEqual(await page.evaluate(() => ({ fonts: owner.fontLibrary.fonts, enabled: owner.fontLibrary.enabled, body: owner.fontLibrary.body, st: owner.fontLibrary.st, shared: owner.fontLibrary.shared })), beforeOrdering, 'Pins and sorting never rewrite font records, original sources or application choices');
    for (const mode of ['added-asc', 'added-desc']) {
        await page.locator('[data-font-sort-order]').selectOption(mode); await settled();
        const name = mode === 'added-asc' ? 'AAA 最新添加' : 'ZZZ 最新添加';
        await setAddOpen(true); await page.locator('[data-font-web-name]').fill(name); await page.locator('[data-font-web-source]').fill(`https://fonts.test/${mode}.ttf`);
        await page.locator('[data-font-action="add-web"]').click(); await settled();
        const state = await page.evaluate(() => owner.fontLibrary), added = state.fonts.at(-1), sorted = orderedFonts(state);
        assert.equal(added.name, name, 'New records append to the persistent array independently of display order');
        const index = sorted.findIndex(font => font.id === added.id);
        assert.equal(index, mode === 'added-asc' ? state.fonts.length - 1 : state.pinnedIds.length);
        assert.equal(await cardFor(added.id).getAttribute('data-font-revealed'), 'true');
        assert.deepEqual(await page.locator('.qm-font-card').evaluateAll(nodes => nodes.map(node => node.dataset.fontId)), sorted.slice(Math.floor(index / 10) * 10, Math.floor(index / 10) * 10 + 10).map(font => font.id), `${mode}: new-font reveal locates the added-order page`);
    }
    const beforeAddedRename = await page.evaluate(() => owner.fontLibrary), latestAdded = beforeAddedRename.fonts.at(-1);
    await cardFor(latestAdded.id).locator('[data-font-action="edit"]').click();
    await page.locator('[data-font-web-name]').fill('A 改名但不改变添加顺序');
    await page.locator('[data-font-action="add-web"]').click(); await settled();
    const afterAddedRename = await page.evaluate(() => owner.fontLibrary);
    assert.deepEqual(afterAddedRename.fonts.map(font => font.id), beforeAddedRename.fonts.map(font => font.id));
    assert.deepEqual({ ...afterAddedRename.fonts.at(-1), name: latestAdded.name }, latestAdded);
    assert.equal(await page.locator('.qm-font-card').nth(afterAddedRename.pinnedIds.length).getAttribute('data-font-id'), latestAdded.id, 'Editing a name does not move an entry in added-desc ordering');
    const beforeFailedSort = await page.evaluate(() => ({ state: owner.fontLibrary, saved, page: document.querySelector('.qm-font-pagination>span').textContent }));
    const beforeFailedSortIds = await page.locator('.qm-font-card').evaluateAll(nodes => nodes.map(node => node.dataset.fontId));
    await page.evaluate(() => { rejectNextFontSave = true; });
    await page.locator('[data-font-sort-order]').selectOption('asc'); await settled();
    assert.equal(await page.locator('[data-font-sort-order]').inputValue(), 'added-desc', 'A rejected preference save restores both the prior criterion and direction');
    assert.deepEqual(await page.evaluate(() => ({ state: owner.fontLibrary, saved, page: document.querySelector('.qm-font-pagination>span').textContent })), beforeFailedSort);
    assert.deepEqual(await page.locator('.qm-font-card').evaluateAll(nodes => nodes.map(node => node.dataset.fontId)), beforeFailedSortIds);
    await page.locator('[data-font-sort-order]').selectOption('added-asc'); await settled();
    assert.equal(await page.evaluate(() => owner.fontLibrary.sortBy), 'added');
    assert.equal(await page.evaluate(() => owner.fontLibrary.sortOrder), 'asc');
    record('A failed sort-preference save restores the previous combined option, records and page; retry changes the intended criterion/direction only');
    await page.locator('[data-font-sort-order]').selectOption('added-desc'); await settled();
    await page.locator('[data-font-action="back"]').click(); await page.locator('[data-font-library]').click(); await page.locator('[data-font-sort-order]').waitFor();
    assert.equal(await page.locator('[data-font-sort-order]').inputValue(), 'added-desc');
    await page.evaluate(() => { library.dispose(); library = createSyntheticLibrary(); library.attach(document.getElementById('story-director-floor-nav')); });
    await page.locator('[data-font-library]').click(); await page.locator('[data-font-sort-order]').waitFor();
    assert.equal(await page.locator('[data-font-sort-order]').inputValue(), 'added-desc');
    assert.deepEqual(await page.locator('.qm-font-card').evaluateAll(nodes => nodes.map(node => node.dataset.fontId)), orderedFonts(await page.evaluate(() => owner.fontLibrary)).slice(0, 10).map(font => font.id));
    assert.deepEqual(await page.evaluate(() => owner.fontLibrary.fonts), afterAddedRename.fonts, 'Reopening preserves append order without fabricating timestamps or rewriting existing metadata');
    record('Name/added-order each support ascending and descending, preserve pins and cross-page selection, restore on reopen, and reveal new entries in the correct page without moving edited entries');
    for (const id of [...pinIds].reverse()) { await showFont(id); await cardFor(id).locator('[data-font-action="pin"]').click(); await settled(); }
    await page.locator('[data-font-sort-order]').selectOption('asc'); await settled(); await setPreviewSize(20);
    record('Multiple pins retain pin-time order across name sorting, filtering and reopen; unpin/re-pin is stable and sorting preserves managed selections without rewriting font data');
    const variantId = await page.evaluate(async () => {
        await library.action('add-web', { name: 'Variant 样本', source: '@font-face{font-family:"Variant";src:url("https://fonts.test/variant.ttf");font-weight:100 900;font-style:normal}@font-face{font-family:"Variant";src:url("https://fonts.test/variant-italic.ttf");font-weight:100 900;font-style:italic}' });
        return owner.fontLibrary.fonts.find(font => font.name === 'Variant 样本').id;
    });
    const otherCardId = await page.evaluate(async () => { await library.action('add-web', { name: 'Variant 同页固定款', source: 'https://fonts.test/variant-neighbor.ttf' }); return owner.fontLibrary.fonts.find(font => font.name === 'Variant 同页固定款').id; });
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
    await page.locator(`[data-font-action="weight"][data-font-id="${variantId}"]`).click();
    await page.locator(`[data-font-weight="${variantId}"]`).evaluate(node => { node.value = '600'; node.dispatchEvent(new Event('input', { bubbles: true })); });
    assert.equal(await page.evaluate(() => owner.fontLibrary.body.weight), '700', 'Changing preview weight does not silently alter the active prose assignment');
    await page.locator('[data-font-preview]').click();
    if (await more.getAttribute('aria-expanded') === 'true') await more.click();
    await apply(variantId, 'body');
    assert.deepEqual(await page.evaluate(() => [owner.fontLibrary.body.weight, owner.fontLibrary.body.style]), ['600', 'italic'], 'Re-selecting the already active target applies the newly chosen variant');
    assert.equal(await page.locator('#host-prose').evaluate(node => getComputedStyle(node).fontWeight), '600');
    await more.click();
    const variantRow = await cardFor(variantId).locator('.qm-font-card-head').evaluate(node => {
        const tools = node.querySelector('.qm-font-card-tools'), controls = [...tools.querySelectorAll('button,.qm-font-style-pick')].filter(child => child.offsetParent).map(child => child.getBoundingClientRect());
        const style = node.querySelector('.qm-font-style-pick'), weight = node.querySelector('[data-font-action="weight"]');
        const styleMatches = ['borderTopStyle', 'borderTopWidth', 'borderRadius', 'width', 'height'].every(property => getComputedStyle(style)[property] === getComputedStyle(weight)[property]);
        return { controlsFit: controls.every(rect => rect.right <= node.getBoundingClientRect().right + 1), line: controls.every(rect => Math.abs(rect.top + rect.height / 2 - controls[0].top - controls[0].height / 2) <= 2), overflow: document.querySelector('.qm-font-window>.sd-body').scrollWidth > document.querySelector('.qm-font-window>.sd-body').clientWidth + 1, styleMatches };
    });
    assert.deepEqual(variantRow, { controlsFit: true, line: true, overflow: false, styleMatches: true }, 'Expanded variant tools stay in a horizontal row without overflow or mismatched controls');
    await page.locator(`.qm-font-card[data-font-id="${variantId}"]`).scrollIntoViewIfNeeded();
    await page.screenshot({ path: fileURLToPath(new URL('glass-variant-narrow.png', qa)) });
    record('More expands edit/remove/variant controls horizontally while hiding apply; preview variants stay local until explicit application');
    await cardFor(variantId).locator('[data-font-sample]').click();
    assert.equal(await more.getAttribute('aria-expanded'), 'false', 'Clicking the same card sample retracts its more tools');
    await more.click(); await cardFor(otherCardId).locator('.qm-font-name strong').click();
    assert.equal(await more.getAttribute('aria-expanded'), 'false', 'Clicking another card retracts the previous tools');
    await more.click(); await page.locator('[data-font-search]').click();
    assert.equal(await more.getAttribute('aria-expanded'), 'false', 'Search focus retracts the previous tools on the first click');
    assert.equal(await page.locator('[data-font-search]').evaluate(node => node === document.activeElement), true);
    await page.locator('[data-font-search]').fill('Variant 样本');
    assert.equal(await page.locator('[data-font-search]').evaluate(node => node === document.activeElement), true, 'Retraction never replaces the typing target or steals focus');
    assert.equal(await page.locator('[data-font-sample]').count(), 1);
    await page.locator('[data-font-search]').fill('Variant');
    await more.click(); await cardFor(otherCardId).locator('[data-font-action="edit"]').click();
    assert.equal(await page.locator('[data-font-web-name]').inputValue(), 'Variant 同页固定款', 'The first click both closes old tools and opens the requested edit action');
    assert.equal(await more.getAttribute('aria-expanded'), 'false');
    await page.locator('[data-font-action="cancel-web"]').click();
    await more.click(); await page.locator(`[data-font-action="weight"][data-font-id="${variantId}"]`).click();
    await page.locator(`[data-font-weight="${variantId}"]`).click();
    assert.equal(await more.getAttribute('aria-expanded'), 'true', 'Clicks inside the weight popup do not retract its parent tools');
    await page.locator(`[data-font-style="${variantId}"]`).selectOption('normal');
    assert.equal(await more.getAttribute('aria-expanded'), 'true', 'Using the style picker does not retract its parent tools');
    await page.locator(`[data-font-action="weight"][data-font-id="${variantId}"]`).click();
    await page.locator(`[data-font-weight="${variantId}"]`).focus(); await page.keyboard.press('Escape');
    assert.equal(await more.getAttribute('aria-expanded'), 'false', 'Escape retracts expanded tools');
    assert.equal(await page.locator(`[data-font-weight-pop="${variantId}"]`).isVisible(), false);
    record('Expanded tools retract on sample, other card, search and Escape without swallowing the next edit click or typing focus; variant popups stay usable');
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
