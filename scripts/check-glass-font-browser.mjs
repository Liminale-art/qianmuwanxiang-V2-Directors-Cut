// Real stylesheet + appearance session, synthetic DOM, isolated headless Chromium.
// No live ST, credentials, production data, or provider requests.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.QIANMU_PLAYWRIGHT_MODULE || 'playwright');
const browser = await chromium.launch({ channel: process.env.QIANMU_BROWSER_CHANNEL || undefined, headless: true });
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
const page = await context.newPage();
const checks = [], errors = [], unexpectedRequests = [], fixtureFontRequests = [], minimalFontRequests = [], typography = [];
const fontUrl = 'https://fontsapi.zeoseven.com/161/main/result.css';
const paperFontUrl = 'https://fontsapi.zeoseven.com/309/main/result.css';
let fontMode = 'font-error';
const check = (name, actual) => { assert.ok(actual, name); checks.push(name); };
const uiIds = ['heading', 'hero', 'navigation', 'label', 'input', 'textarea', 'select', 'button', 'prose', 'prose-child',
    'reader', 'notes', 'capture', 'capture-prose', 'dialog', 'dialog-title', 'dialog-input', 'dialog-button', 'art-preview', 'version'];
const preserveIds = ['code', 'code-child', 'term', 'fa', 'font-sample'];
const html = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  :root { --mainFontFamily: Georgia, serif; }
  body { margin: 0; font: 22px/1.4 var(--mainFontFamily); }
  button,input,textarea,select { font-family: var(--mainFontFamily); }
  .fa-solid { font-family: 'Fixture Font Awesome'; font-weight: 900; }
  .fa-solid::before { content: '\\2605'; }
  #story-director-modal { position: relative; display: block; width: 100%; }
  #story-director-modal .sd-window { position: relative; width: 100%; }
  #glass-dialog { position: relative; inset: auto; }
</style><link rel="stylesheet" href="/style.css"></head><body>
<aside id="host"><h2 id="host-heading">ST 宿主标题</h2><p id="host-prose">ST 正文保持原字体</p><input id="host-input" value="ST input"></aside>
<section id="story-director-modal" class="open sd-theme-light" style="--sd-font:Georgia,serif">
  <div class="sd-window">
    <header class="sd-header"><h2 id="heading">千幕 UI</h2></header><section class="sd-hero"><h3 id="hero">镜头台</h3></section>
    <nav class="sd-storyboard-titlebar"><span role="heading" id="navigation">SCREENING ROOM</span></nav>
    <label id="label">标签<input id="input" value="正文编辑"></label><textarea id="textarea">中文 Text</textarea>
    <select id="select"><option>本地字体</option></select><button id="button">保存</button>
    <div class="sd-reader-prose" id="prose" style="font-family:Georgia,serif"><p id="prose-child">阅读字体<span>与正文</span></p></div>
    <small class="sd-version-tag" id="version">v1.59.441</small><pre><code id="code">request <span id="code-child">json</span></code></pre>
    <span class="sd-term" id="term">local-token</span><i class="fa-solid" id="fa" aria-hidden="true"></i>
    <div class="sd-storyboard-artist-type-preview"><b id="art-preview">艺术字样例</b></div>
    <section class="sd-card"><div class="sd-card-title-row"><h3 id="card-title">相同标题字号</h3></div><p class="sd-help" id="caption">相同辅助字号</p></section>
    <p data-font-sample="fixture" id="font-sample" style="font-family:'Times New Roman',serif!important;font-weight:700!important;font-style:italic!important;font-size:19px!important">Aa 独立字体样张</p>
    <div id="svg-icons"><i class="fa-solid fa-film"></i></div>
    <canvas id="excerpt" width="120" height="50"></canvas>
  </div>
</section>
<section class="sd-reader-portal" id="reader" style="font-family:Georgia,serif;--sd-font:Georgia,serif"><p>阅读浮层</p></section>
<section id="qianmu-notes-panel-layer" style="--sd-font:Georgia,serif"><textarea class="sd-note-body" id="notes">便笺</textarea></section>
<section class="qm-storyboard-capture" id="capture" style="--qm-prose-font:Georgia,serif"><p class="qm-storyboard-capture-paragraph" id="capture-prose">提取段落</p></section>
<dialog id="glass-dialog" class="sd-image-info-dialog" open><header><h2 id="dialog-title">画面详情</h2></header>
  <main><p id="dialog">只读画面</p><input id="dialog-input" value="标签"></main><footer><button id="dialog-button">关闭</button></footer>
</dialog></body></html>`;

page.on('pageerror', error => errors.push(error.message));
await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin === 'https://fontsapi.zeoseven.com') {
        minimalFontRequests.push({ path: url.pathname, mode: fontMode });
        const headers = { 'access-control-allow-origin': '*', 'cache-control': 'no-store' };
        if (![fontUrl, paperFontUrl].includes(url.href) || fontMode === 'css-error') return route.fulfill({ status: 404, headers, body: '' });
        // Entirely synthetic network results: real provider assets are not downloaded.
        const paper = url.href === paperFontUrl;
        const src = fontMode === 'success' ? (paper ? 'local("SimSun"),local("Songti SC"),local("Noto Serif CJK SC")' : 'local("Microsoft YaHei"),local("PingFang SC"),local("Noto Sans CJK SC")') : 'url("./fixture.woff2")';
        return route.fulfill({ headers, contentType: 'text/css', body: `@font-face{font-family:"${paper ? 'KingHwaOldSong' : 'Sarasa Gothic SC'}";src:${src};font-style:normal;font-weight:400;font-display:swap}` });
    }
    if (url.origin === 'https://host-font.invalid') {
        fixtureFontRequests.push(url.pathname);
        return route.fulfill({ status: 404, body: '' }); // Simulated ST web-font failure, never sent externally.
    }
    if (url.origin === 'https://qianmu.test' && url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: html });
    if (url.origin === 'https://qianmu.test' && url.pathname === '/interface.ttf') return route.fulfill({ contentType: 'font/ttf', body: await readFile('C:/Windows/Fonts/arial.ttf') });
    if (url.origin === 'https://qianmu.test' && /^(?:\/style\.css|\/qianmu-[a-z0-9-]+\.(?:js|css))$/.test(url.pathname)) {
        return route.fulfill({ contentType: url.pathname.endsWith('.css') ? 'text/css' : 'text/javascript', body: await readFile(new URL('..' + url.pathname, import.meta.url)) });
    }
    unexpectedRequests.push(url.href); return route.abort();
});

async function snapshot() {
    return page.evaluate(({ uiIds, preserveIds }) => {
        const fonts = ids => Object.fromEntries(ids.map(id => [id, getComputedStyle(document.getElementById(id)).fontFamily]));
        const weights = ids => Object.fromEntries(ids.map(id => [id, getComputedStyle(document.getElementById(id)).fontWeight]));
        const sample = document.getElementById('prose-child');
        const range = document.createRange(); range.selectNodeContents(sample);
        return {
            ui: fonts(uiIds), preserve: fonts(preserveIds),
            weights: weights(['heading', 'hero', 'art-preview', ...preserveIds]),
            sizes: Object.fromEntries(['heading', 'hero', 'card-title', 'label', 'caption', 'font-sample'].map(id => [id, getComputedStyle(document.getElementById(id)).fontSize])),
            headings: Object.fromEntries(['heading', 'hero', 'card-title'].map(id => { const style = getComputedStyle(document.getElementById(id)); return [id, { background: style.backgroundImage, clip: style.backgroundClip, fill: style.webkitTextFillColor }]; })),
            sampleStyle: getComputedStyle(document.getElementById('font-sample')).fontStyle,
            baselineWeight: getComputedStyle(document.getElementById('story-director-modal')).fontWeight,
            host: fonts(['host-heading', 'host-prose', 'host-input']),
            pseudo: getComputedStyle(document.getElementById('fa'), '::before').fontFamily,
            svg: document.querySelector('#svg-icons svg')?.outerHTML,
            canvas: document.getElementById('excerpt').toDataURL(),
            width: range.getBoundingClientRect().width,
            theme: document.getElementById('story-director-modal').dataset.qmTheme || 'classic',
        };
    }, { uiIds, preserveIds });
}
async function theme(family, mode = 'light') {
    await page.evaluate(async ({ family, mode }) => {
        settings.appearance = updateAppearancePreferences(settings, { family, mode });
        await session.sync();
        await new Promise(resolve => requestAnimationFrame(resolve));
    }, { family, mode });
    // The optional font must not block session.sync; wait only in this test.
    await page.waitForFunction(url => {
        const link = [...document.querySelectorAll('link[rel="stylesheet"]')].find(node => node.href === url);
        return !link || Boolean(link.sheet);
    }, family === 'editorial' ? paperFontUrl : fontUrl);
    await page.evaluate(() => document.fonts.ready);
}

try {
    await page.goto('https://qianmu.test/');
    await page.evaluate(async () => {
        const { createQianmuAppearanceSession } = await import('/qianmu-appearance-session.js');
        const appearance = await import('/qianmu-appearance-settings.js');
        const { applyQianmuIcons } = await import('/qianmu-icon-renderer.js');
        window.settings = { theme: 'light' }; window.updateAppearancePreferences = appearance.updateAppearancePreferences;
        window.session = createQianmuAppearanceSession({ readSettings: () => settings, document, styleUrl: '/qianmu-theme-skins.css' });
        session.mount(document.getElementById('story-director-modal'));
        session.mount(document.getElementById('reader'), { role: 'reader' });
        session.mountNotes(document);
        session.mountPortal(document.getElementById('capture'), { inheritTheme: true });
        session.mountPortal(document.getElementById('glass-dialog'), { inheritTheme: true });
        applyQianmuIcons(document.getElementById('svg-icons'));
        const canvas = document.getElementById('excerpt'), pen = canvas.getContext('2d');
        pen.font = '18px Georgia'; pen.fillText('自定义海报', 0, 24);
        await session.sync();
    });
    const classic = await snapshot();
    await theme('editorial'); const editorial = await snapshot();
    check('classic follows the native host while paper prefers its dedicated KingHwaOldSong', classic.ui.heading.includes('Georgia') && editorial.ui.navigation.startsWith('KingHwaOldSong'));
    check('paper requests only its dedicated font, not the minimal-theme font', minimalFontRequests.some(row => row.path === '/309/main/result.css') && minimalFontRequests.every(row => !row.path.startsWith('/161/')));
    for (const [id, font] of Object.entries(editorial.ui).filter(([id]) => id !== 'version')) check(`paper ${id} prefers the dedicated Song family`, font.startsWith('KingHwaOldSong'));
    assert.deepEqual(editorial.preserve, classic.preserve); checks.push('paper preserves font samples, technical text and icons');
    await theme('glass'); const glass = await snapshot();
    for (const [id, font] of Object.entries(glass.ui)) check(`minimal ${id} prefers Sarasa with private local Heiti fallback`, font.startsWith('"Sarasa Gothic SC"') && font.includes('Qianmu Glass Local Heiti'));
    check('font asset failure is simulated without any external network', minimalFontRequests.some(row => row.path.endsWith('fixture.woff2')));
    check('minimal uses normal body weight and preserves heading/emphasis/code/icon hierarchy', glass.baselineWeight === '400' && JSON.stringify(glass.weights) === JSON.stringify(classic.weights));
    check('glass does not alter host heading/body/input', JSON.stringify(glass.host) === JSON.stringify(classic.host));
    assert.deepEqual(glass.preserve, classic.preserve, 'code/term/legacy icon fonts remain unchanged');
    checks.push('code/term/legacy icon fonts remain unchanged');
    check('legacy icon pseudo font and actual SVG artwork remain intact', glass.pseudo === classic.pseudo && Boolean(glass.svg) && glass.svg === classic.svg);
    check('custom excerpt canvas content remains byte-identical', glass.canvas === classic.canvas);
    for (const width of [393, 1280]) {
        await page.setViewportSize({ width, height: 900 });
        let baseline;
        for (const family of ['classic', 'editorial', 'glass']) {
            await theme(family); const result = await snapshot();
            baseline ??= result.sizes; assert.deepEqual(result.sizes, baseline, `${width}px ${family} retains the same shared type scale`);
            check(`${width}px ${family} keeps list sample family, weight and style independent`, result.preserve['font-sample'] === classic.preserve['font-sample'] && result.weights['font-sample'] === '700' && result.sampleStyle === 'italic');
            // This fixture's bare .sd-hero h3 is not the renderer's
            // .sd-hero-top > h3, so it has never been a gradient consumer.
            check(`${width}px ${family} headings use the selected plain/gradient treatment: ${JSON.stringify(result.headings)}`, Object.entries(result.headings).every(([id, value]) => family === 'glass' && id !== 'hero' ? value.background.includes('gradient') && value.fill === 'rgba(0, 0, 0, 0)' : value.background === 'none' && value.fill !== 'rgba(0, 0, 0, 0)'));
            typography.push({ width, family, sizes: result.sizes, font: result.ui.label, textWidth: result.width });
        }
        checks.push(`${width}px three themes retain the same computed heading/body/caption sizes`);
    }
    await page.setViewportSize({ width: 390, height: 844 }); await theme('glass');
    const face = await page.evaluate(() => [...document.styleSheets].filter(sheet => !sheet.href || new URL(sheet.href).origin === location.origin).flatMap(sheet => [...sheet.cssRules]).filter(rule => rule.type === CSSRule.FONT_FACE_RULE && rule.style.fontFamily.includes('Qianmu Glass Local Heiti')).map(rule => ({ src: rule.style.getPropertyValue('src'), display: rule.style.getPropertyValue('font-display') })));
    check('private Heiti face resolves installed fonts only, with no URL/import', face.length > 0 && face.every(row => row.src.includes('local(') && !/url\(/i.test(row.src)));
    const cdp = await context.newCDPSession(page);
    await cdp.send('DOM.enable'); await cdp.send('CSS.enable');
    async function platformFonts() {
        const { root } = await cdp.send('DOM.getDocument');
        const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: '#prose-child' });
        return (await cdp.send('CSS.getPlatformFontsForNode', { nodeId })).fonts;
    }
    const onlineFonts = await platformFonts();
    // Chromium may use the system sans face for an injected whitespace glyph.
    assert.ok(onlineFonts.some(font => /Sarasa|YaHei|PingFang|Noto Sans|Source Han Sans|WenQuanYi|Heiti/i.test(font.familyName))
        && onlineFonts.every(font => font.glyphCount > 0 && /Sarasa|YaHei|PingFang|Noto Sans|Source Han Sans|WenQuanYi|Heiti|Tahoma|Segoe|Arial/i.test(font.familyName)), `Chinese glyphs remain readable with the remote font blocked: ${JSON.stringify(onlineFonts)}`);
    checks.push('font-download failure leaves readable installed Sarasa or local Heiti glyphs');
    // Sarasa may already be installed on the QA machine. Model its absence by
    // changing only this fixture's first-choice family; never touch system fonts.
    await page.evaluate(() => document.querySelectorAll('[data-qm-theme="glass"]').forEach(root => root.style.setProperty('--qm-glass-font', '"Fixture Missing Face", "Qianmu Glass Local Heiti", sans-serif')));
    await page.evaluate(() => document.fonts.ready);
    const forcedFallbackFonts = await platformFonts();
    check('private installed Heiti really renders when Sarasa is unavailable', forcedFallbackFonts.some(font => /YaHei|PingFang|Noto Sans|Source Han Sans|WenQuanYi|Heiti/i.test(font.familyName)) && forcedFallbackFonts.every(font => !/Sarasa/.test(font.familyName)));
    await page.evaluate(() => document.querySelectorAll('[data-qm-theme="glass"]').forEach(root => root.style.removeProperty('--qm-glass-font')));
    await page.evaluate(() => document.fonts.ready);

    // This simulates the ST network font changing while Qianmu stays mounted.
    await page.evaluate(() => {
        const remote = document.createElement('style'); remote.id = 'host-remote-font';
        remote.textContent = '@font-face{font-family:"Host Network Font";src:url("https://host-font.invalid/remote.woff2")}';
        document.head.append(remote);
        document.documentElement.style.setProperty('--mainFontFamily', '"Host Network Font", cursive');
        for (const id of ['story-director-modal', 'reader', 'qianmu-notes-panel-layer']) document.getElementById(id).style.setProperty('--sd-font', '"Host Network Font", cursive');
        document.getElementById('capture').style.setProperty('--qm-prose-font', '"Host Network Font", cursive');
    });
    await page.evaluate(() => document.fonts.ready); const disrupted = await snapshot();
    check('host network-font change is real in the control group', disrupted.host['host-prose'].includes('Host Network Font') && fixtureFontRequests.length > 0);
    check('host font changes and failed downloads leave all glass UI fonts unchanged', JSON.stringify(disrupted.ui) === JSON.stringify(glass.ui));
    check('glass text layout does not shift when host network font fails', Math.abs(disrupted.width - glass.width) < 0.01);
    await context.setOffline(true); await theme('glass', 'dark'); const offline = await snapshot();
    check('offline dark-mode rendering retains the exact local font stack', JSON.stringify(offline.ui) === JSON.stringify(glass.ui));
    const offlineFonts = await platformFonts();
    check('actual platform glyph fonts remain identical while offline', JSON.stringify(offlineFonts) === JSON.stringify(onlineFonts));

    await page.evaluate(async () => {
        const dialog = document.createElement('dialog'); dialog.id = 'late-portal'; dialog.className = 'sd-image-info-dialog';
        dialog.innerHTML = '<h2>稍后打开</h2><input value="offline"><button>确定</button>';
        document.body.append(dialog); window.releaseLate = session.mountPortal(dialog, { inheritTheme: true });
        dialog.showModal(); await session.sync();
    });
    const late = await page.locator('#late-portal').evaluate(node => [node, ...node.querySelectorAll('h2,input,button')].map(el => getComputedStyle(el).fontFamily));
    check('a newly mounted native portal uses local Heiti while offline', late.every(font => font.includes('Qianmu Glass Local Heiti')));
    await page.evaluate(() => { document.getElementById('late-portal').close(); releaseLate(); document.getElementById('late-portal').remove(); });
    await context.setOffline(false);
    await page.evaluate(() => {
        document.getElementById('host-remote-font').remove(); document.documentElement.style.removeProperty('--mainFontFamily');
        for (const id of ['story-director-modal', 'reader', 'qianmu-notes-panel-layer']) document.getElementById(id).style.setProperty('--sd-font', 'Georgia,serif');
        document.getElementById('capture').style.setProperty('--qm-prose-font', 'Georgia,serif');
    });
    await page.evaluate(async () => {
        const { selectQianmuClassicTheme } = await import('/qianmu-appearance-actions.js');
        selectQianmuClassicTheme({ settings, themeKey: 'light', session, save() {}, resolveLogo: () => null });
        await document.fonts.ready;
    });
    const backClassic = await snapshot();
    check('switching glass to classic restores every original UI font', JSON.stringify(backClassic.ui) === JSON.stringify(classic.ui));
    check('leaving minimal releases its external font stylesheet', await page.locator(`link[href="${fontUrl}"]`).count() === 0);
    await theme('editorial'); const backEditorial = await snapshot();
    check('switching glass to editorial restores its dedicated font stack', JSON.stringify(backEditorial.ui) === JSON.stringify(editorial.ui));

    fontMode = 'css-error'; await theme('glass');
    check('failed font stylesheet leaves minimal ready and legible', await page.evaluate(() => session.status === 'ready') && JSON.stringify((await snapshot()).ui) === JSON.stringify(glass.ui));
    check('failed font stylesheet is released rather than leaving a blocking link', await page.locator(`link[href="${fontUrl}"]`).count() === 0);
    await theme('editorial');
    check('failed paper stylesheet leaves paper ready with its local Song fallback', await page.evaluate(() => session.status === 'ready') && JSON.stringify((await snapshot()).ui) === JSON.stringify(editorial.ui));
    check('failed paper stylesheet releases its link', await page.locator(`link[href="${paperFontUrl}"]`).count() === 0);
    await theme('classic'); fontMode = 'success'; await theme('editorial');
    check('mocked successful paper font loads the requested family', await page.evaluate(async () => { await document.fonts.load('16px "KingHwaOldSong"', '中文 Text'); return [...document.fonts].some(face => face.family.includes('KingHwaOldSong') && face.status === 'loaded'); }));
    await page.evaluate(async () => {
        const { createFontRuntime } = await import('/qianmu-font-runtime.js');
        window.fontRuntime = createFontRuntime({ document });
        window.libraryFont = { id: 'interface', source: { kind: 'web' }, faces: [{ urls: [{ url: 'https://qianmu.test/interface.ttf', format: 'truetype' }], weight: '400', style: 'normal' }] };
        window.libraryState = { fonts: [libraryFont], mode: 'separate', st: { fontId: 'interface', enabled: true, weight: 400, style: 'normal' }, previewText: 'ABC' };
        await fontRuntime.sync(libraryState);
    });
    check('font-library interface assignment does not replace the dedicated paper font', JSON.stringify((await snapshot()).ui) === JSON.stringify(editorial.ui));
    await theme('classic'); const interfaceFamily = await page.evaluate(() => fontRuntime.family('interface'));
    check('classic follows the actual verified interface font despite an older host snapshot', (await snapshot()).ui.heading.includes(interfaceFamily));
    await theme('glass'); check('interface assignment does not alter minimal typography', JSON.stringify((await snapshot()).ui) === JSON.stringify(glass.ui));
    await theme('editorial'); await page.evaluate(() => fontRuntime.sync({ ...libraryState, enabled: false }));
    check('turning off the font library does not remove paper typography or its stylesheet', JSON.stringify((await snapshot()).ui) === JSON.stringify(editorial.ui) && await page.locator(`link[href="${paperFontUrl}"]`).count() === 1);
    await theme('classic');
    check('classic returns to native host font after interface assignment is disabled', JSON.stringify((await snapshot()).ui) === JSON.stringify(classic.ui));
    check('leaving paper removes its dedicated stylesheet', await page.locator(`link[href="${paperFontUrl}"]`).count() === 0);
    await page.evaluate(() => fontRuntime.dispose());
    await theme('classic'); fontMode = 'success'; await theme('glass');
    const loadedSarasa = await page.evaluate(async () => {
        await document.fonts.load('16px "Sarasa Gothic SC"', '中文 Text');
        return [...document.fonts].some(face => face.family.includes('Sarasa Gothic SC') && face.status === 'loaded');
    });
    check('mocked successful Sarasa stylesheet activates the requested family', loadedSarasa);
    const loaded = await snapshot(), requestsBeforeMode = minimalFontRequests.length;
    check('successful font loading leaves host and protected technical/icon fonts untouched', JSON.stringify(loaded.host) === JSON.stringify(classic.host) && JSON.stringify(loaded.preserve) === JSON.stringify(classic.preserve));
    await theme('glass', 'dark');
    check('dark mode keeps Sarasa without a duplicate stylesheet request', minimalFontRequests.length === requestsBeforeMode && JSON.stringify((await snapshot()).ui) === JSON.stringify(glass.ui));
    await theme('glass');
    await page.evaluate(() => session.reset()); const reset = await snapshot();
    check('session disposal removes glass typography and restores classic', reset.theme === 'classic' && JSON.stringify(reset.ui) === JSON.stringify(classic.ui));
    check('session disposal removes its optional font stylesheet', await page.locator(`link[href="${fontUrl}"]`).count() === 0);
    check('no unrelated network requests or page errors', unexpectedRequests.length === 0 && errors.length === 0);
    await cdp.detach();
    console.log(JSON.stringify({ passed: checks.length, checks, typography, blockedRemotePlatformFonts: onlineFonts, forcedFallbackFonts, errors, unexpectedRequests, simulatedThemeFontRequests: minimalFontRequests, simulatedHostFontRequests: fixtureFontRequests.length, externalNetwork: 0, productionWrites: 0, providerRequests: 0 }, null, 2));
} finally { await context.close(); await browser.close(); }
