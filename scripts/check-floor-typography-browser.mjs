// Production floor renderer, number bindings and theme session; synthetic host only.
// No real ST chat, persistence, browser session or external font download is used.
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { storyboardFunctionSource } from '../tests/helpers/storyboard-form-fixture.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.QIANMU_PLAYWRIGHT_MODULE || 'playwright');
const entry = await readFile(new URL('../index.js', import.meta.url), 'utf8');
const constants = vm.runInNewContext(entry.slice(entry.indexOf('const PROSE_LAYOUT_DEFAULTS ='), entry.indexOf('const PROSE_LAYOUT_STORAGE_KEY =')) + ';({PROSE_LAYOUT_DEFAULTS,PROSE_LAYOUT_CONTROLS})');
const code = ['proseLayoutFormatValue', 'floorProseLayoutMarkup', 'bindFloorProseNumberControls', 'openFloorNavigator'].map(storyboardFunctionSource).join('\n');
const browser = await chromium.launch({ channel: process.env.QIANMU_BROWSER_CHANNEL || undefined, headless: true });
const context = await browser.newContext(), page = await context.newPage(), checks = [], errors = [];
const qa = new URL('../dist/local-qa/floor-typography/', import.meta.url);
await mkdir(qa, { recursive: true });
let external = 0;
const deadline = setTimeout(() => { void browser.close(); }, 60000);
page.on('pageerror', error => errors.push(error.message));
await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin === 'https://qianmu.test' && url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><body></body>' });
    if (url.origin === 'https://qianmu.test' && /^\/qianmu-[a-z0-9-]+\.(?:js|css)$/.test(url.pathname)) return route.fulfill({ contentType: url.pathname.endsWith('.css') ? 'text/css' : 'text/javascript', body: await readFile(new URL('..' + url.pathname, import.meta.url), 'utf8') });
    external++; return route.abort();
});
try {
    await page.goto('https://qianmu.test/');
    // Deliberately large host text exposes controls that accidentally inherit ST sizes.
    await page.addStyleTag({ content: 'body{margin:0;font:24px/1.6 serif}button,input{font:24px/1.6 serif}#fixture-host{font-size:24px}#story-director-modal{display:block!important;position:absolute!important;left:-2000px!important;width:540px!important;visibility:hidden!important}' });
    for (const file of ['style.css', 'qianmu-theme-skins.css']) await page.addStyleTag({ content: await readFile(new URL('../' + file, import.meta.url), 'utf8') });
    await page.evaluate(async ({ code, constants }) => {
        for (const module of ['qianmu-appearance-session', 'qianmu-appearance-settings', 'qianmu-icon-renderer']) Object.assign(window, await import(`./${module}.js`));
        const noop = () => {};
        Object.assign(window, constants, {
            FLOOR_NAV_ID: 'story-director-floor-nav', THEME_KEYS: ['light', 'dark'], floorNavigatorView: 'jump',
            fontLibrary: { attach() {}, detach() {} },
            ctx: () => ({ chat: Array.from({ length: 12 }, () => ({ mes: 'synthetic' })) }),
            closeQuickWheel: noop, closeFloorNavigator: () => document.getElementById('story-director-floor-nav')?.remove(),
            bindFloorNavigatorViewport: root => Object.assign(root.style, { left: '0px', top: '0px', width: '100vw', height: '100dvh' }),
            proseLayoutSettings: () => settings.proseLayout, applyProseLayout: noop,
            persistProseLayout: () => { window.saves++; }, jumpToChatFloor: floor => { window.jumped = Number(floor); },
        });
        new Function(code + ';Object.assign(window,{openFloorNavigator});')();
        window.setup = async ({ family, mode }) => {
            window.appearanceSession?.reset(); window.saves = 0;
            window.settings = { theme: mode, proseLayout: structuredClone(PROSE_LAYOUT_DEFAULTS), appearance: updateAppearancePreferences({}, { family, mode }) };
            document.body.innerHTML = `<div id="fixture-host"><input value="原生字号不改"></div><div id="chat"><div class="mes"><div class="mes_text">原生正文未启用排版</div></div></div><div id="story-director-modal" class="sd-theme-${mode}"><h3 class="sd-page-title">主面板页标题</h3><nav class="sd-tabs"><button>主面板页签</button></nav><label>字段</label><button class="sd-btn">主面板操作</button><span class="sd-hint-sm">主面板说明</span><input class="text_pole"></div>`;
            window.appearanceSession = createQianmuAppearanceSession({ readSettings: () => settings, loadStyles: () => ({ promise: Promise.resolve(true), cancel() {} }), loadFont: () => ({ promise: Promise.resolve(false), cancel() {} }) });
            appearanceSession.mount(document.getElementById('story-director-modal')); await appearanceSession.sync();
            openFloorNavigator('layout'); await appearanceSession.sync();
        };
    }, { code, constants });
    for (const width of [320, 393, 1280]) for (const family of ['classic', 'editorial', 'glass']) for (const mode of ['light', 'dark']) {
        await page.setViewportSize({ width, height: 850 });
        await page.evaluate(options => setup(options), { family, mode });
        const result = await page.evaluate(() => {
            const floor = document.getElementById(FLOOR_NAV_ID), main = document.getElementById('story-director-modal');
            const size = (root, selector) => getComputedStyle(root.querySelector(selector)).fontSize;
            const fits = selector => [...floor.querySelectorAll(selector)].every(node => node.scrollWidth <= node.clientWidth + 1);
            return {
                pairs: [['h3', '.sd-page-title'], ['.sd-floor-tabs button', '.sd-tabs button'], ['.sd-floor-jump', '.sd-btn'], ['.sd-floor-input', '.text_pole'], ['.sd-prose-control input[type=number]', '.text_pole'], ['.sd-prose-control > span', 'label'], ['header p', '.sd-hint-sm'], ['.sd-prose-control small', '.sd-hint-sm']].map(([a, b]) => [size(floor, a), size(main, b)]),
                panelFits: floor.querySelector('.sd-floor-panel').getBoundingClientRect().right <= innerWidth,
                contentFits: fits('.sd-prose-control,.sd-prose-checks label'),
                host: getComputedStyle(document.querySelector('#fixture-host input')).fontSize,
                prose: getComputedStyle(document.querySelector('.mes_text')).fontSize,
                sizes: ['h3', '.sd-floor-tabs button', '.sd-prose-control input[type=number]', 'header p'].map(selector => size(floor, selector)),
            };
        });
        for (const [actual, expected] of result.pairs) assert.equal(actual, expected, `${width}/${family}/${mode}: main/floor hierarchy`);
        assert.equal(result.panelFits, true); assert.equal(result.contentFits, true);
        assert.equal(result.host, '24px'); assert.equal(result.prose, '24px');
        assert.deepEqual(result.sizes, ['17px', '13.5px', '12px', '11px']);
        checks.push(`${width}/${family}/${mode}: shared title/tab/control/caption scale; no narrow overflow or host/prose resize`);
        await page.locator('[data-prose-key="fontSize"][type="number"]').fill('20');
        await page.locator('[data-prose-key="fontSize"][type="number"]').press('Enter');
        const updated = await page.evaluate(() => ({ value: settings.proseLayout.fontSize, mirrored: document.querySelector('[data-prose-key="fontSize"][type="range"]').value, saves }));
        assert.deepEqual(updated, { value: 20, mirrored: '20', saves: 1 });
        await page.locator('[data-floor-tab="jump"]').click();
        await page.locator('.sd-floor-input').fill('7'); await page.locator('.sd-floor-jump').click();
        assert.equal(await page.evaluate(() => jumped), 7);
        checks.push(`${width}/${family}/${mode}: actual tab, numeric editing, range mirror and jump bindings remain intact`);
        if (width === 393 && mode === 'dark') {
            await page.locator('[data-floor-tab="layout"]').click();
            await page.screenshot({ path: fileURLToPath(new URL(`${family}-${mode}-${width}.png`, qa)) });
        }
    }
    assert.deepEqual(errors, []); assert.equal(external, 0);
    console.log(JSON.stringify({ passed: checks.length, checks, errors, external, productionDataRead: false }));
} finally { clearTimeout(deadline); await context.close(); await browser.close(); }
