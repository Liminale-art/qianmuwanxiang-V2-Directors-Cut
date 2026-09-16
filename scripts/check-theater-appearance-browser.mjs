// Actual theater renderers and isolated catalog/story fixtures, never generation.
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { storyboardFunctionSource } from '../tests/helpers/storyboard-form-fixture.mjs';

const names = ['renderActiveTab', 'renderTheaterTab', 'theaterOpening', 'renderTheaterMarkdown',
    'withHiddenScrollbar', 'renderTheaterReadView', 'renderTheaterFavoritesView', 'renderTheaterPresetEntries',
    'theaterScriptLibraryCfg', 'initTheaterPresetSelection', 'isTheaterPresetItemSelected', 'isTheaterFavorited',
    'getContextItemId', 'renderLibrarySection', 'renderLibraryListBody', 'renderLibraryRow'];
const source = names.map(storyboardFunctionSource).join('\n');
const css = await readFile(new URL('../style.css', import.meta.url), 'utf8') + '\n'
    + await readFile(new URL('../qianmu-theme-skins.css', import.meta.url), 'utf8');
const require = createRequire(import.meta.url), { chromium } = require(process.env.QIANMU_PLAYWRIGHT_MODULE || 'playwright');
const browser = await chromium.launch({ channel: process.env.QIANMU_BROWSER_CHANNEL || undefined, headless: true });
const context = await browser.newContext(), page = await context.newPage();
const deadline = setTimeout(() => { void browser.close(); }, 120000), checks = [], errors = [];
let external = 0;
const ok = (name, value) => { assert.ok(value, name); checks.push(name); };
const qa = new URL('../dist/local-qa/theater-appearance/', import.meta.url); await mkdir(qa, { recursive: true });
page.on('pageerror', error => errors.push(error.message));
await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin === 'https://qianmu.test' && url.pathname === '/') return route.fulfill({
        contentType: 'text/html; charset=utf-8', body: `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><style>body{margin:0}#story-director-modal{position:relative!important;display:block!important;inset:auto!important;transform:none!important;width:100%!important;height:100dvh!important;box-sizing:border-box}#story-director-modal .sd-window{width:100%!important;height:100%!important;max-height:none!important;margin:0!important}</style><div id="story-director-modal" class="open sd-theme-dark"><section class="sd-window"><main class="sd-body"></main></section></div>`,
    });
    if (url.origin === 'https://qianmu.test' && /^\/qianmu-[a-z0-9-]+\.js$/.test(url.pathname)) return route.fulfill({
        contentType: 'application/javascript', body: await readFile(new URL('..' + url.pathname, import.meta.url)),
    });
    external++; return route.abort();
});
try {
    await page.goto('https://qianmu.test/');
    await page.evaluate(async source => {
        const [utils, { createQianmuAppearanceSession }, { updateAppearancePreferences }, { applyQianmuIcons }] = await Promise.all([
            import('/qianmu-storyboard-utils.js'), import('/qianmu-appearance-session.js'), import('/qianmu-appearance-settings.js'), import('/qianmu-icon-renderer.js'),
        ]);
        for (const name of ['htmlEscape', 'uniqueClean', 'isNoisePresetName', 'groupByFolder', 'extractTheaterBody', 'snip', 'theaterSubtitle', 'formatDateTime']) window[name] = utils[name];
        Object.assign(window, {
            settings: { theme: 'dark', apiProfiles: [{ id: 'fixture', name: '隔离 API' }] }, activeTab: 'theater', editorView: null,
            MODAL_ID: 'story-director-modal', THEATER_INSTRUCTION_PLACEHOLDER: '隔离此幕指令', calls: { catalog: 0, render: 0, forbidden: 0 },
            getTheater: () => theaterFixture, getCurrentPresetName: () => '原预设', listPresetNames: () => ['原预设'],
            getPresetEntries: () => contextScanCache.presets['原预设'],
            ensureTheaterCatalog: () => { calls.catalog++; return new Promise(resolve => { window.resolveCatalog = resolve; }); },
            renderModal: () => { calls.render++; }, applyQianmuIcons,
        });
        const forbidden = () => { calls.forbidden++; throw Error('Generation and production writes are forbidden'); };
        window.saveSettings = window.stageTheaterScene = window.saveMetadata = forbidden;
        (0, eval)(source);
        window.appearance = createQianmuAppearanceSession({ readSettings: () => settings, loadStyles: () => ({ promise: Promise.resolve(true), cancel() {} }) });
        appearance.mount(document.querySelector('#story-director-modal'));
        window.setAppearance = async (family, mode) => { settings.appearance = updateAppearancePreferences(settings, { family, mode }); await appearance.sync(); };
        window.renderTheaterFixture = (state = 'home') => {
            window.theaterCatalogReady = !['loading', 'error', 'idle'].includes(state);
            window.theaterCatalogLoading = state === 'loading'; window.theaterCatalogError = state === 'error' ? '<img src=x> Failed-to-load-' + 'a'.repeat(110) : '';
            window.theaterBusy = state === 'busy'; window.theaterExportMode = state === 'export'; window.theaterExportSelection = new Set(['script0']);
            const scene = { id: 'scene0', createdAt: '2026-09-17T00:00:00Z', source: '风之剧札', content: '<幕外正文>原故事中的片刻。\n' + '风掠过海面，远处的灯光依然温柔。\n'.repeat(150) + '&lt;未解码标记&gt; <img src=x>\n</幕外正文>' };
            window.theaterFixture = { apiProfileId: 'fixture', presetName: '原预设', presetItems: {}, useChatHistory: true, historyDepth: 8,
                instruction: '沿用当前故事，不改变既有事实。', lastOutput: scene, readerFontScale: 'medium', scriptSearch: '',
                scripts: Array.from({ length: 30 }, (_, i) => ({ id: 'script' + i, title: '旅途剧札 ' + i, folder: i < 4 ? '沿海' : '' })),
                favorites: Array.from({ length: 28 }, (_, i) => ({ ...scene, id: 'fav' + i, source: i === 0 ? 's'.repeat(130) : '原剧札' })) };
            window.contextScanCache = { presetNames: ['原预设'], presets: { '原预设': Array.from({ length: 26 }, (_, i) => ({ uid: i, name: '预设条目' + i + '-' + 'x'.repeat(85), content: '保留原条目内容', enabled: i !== 1 })) } };
            window.theaterView = ['read', 'edit', 'html'].includes(state) ? { mode: 'read', scene, editing: state === 'edit' } : state.startsWith('favorites') ? { mode: 'favorites' } : null;
            if (state === 'html') { scene.isHtml = true; scene.content = '<!doctype html><meta charset="utf-8"><body style="background:#f0e8d8;color:#241e18"><p>隔离 HTML 内容，主题不重绘此文档。</p>' + '<p>保留原设计</p>'.repeat(80) + '</body>'; }
            if (state === 'empty') { theaterFixture.scripts = []; theaterFixture.favorites = []; theaterFixture.lastOutput = null; theaterFixture.presetName = ''; }
            if (state === 'favorites-empty') theaterFixture.favorites = [];
            calls.catalog = calls.render = calls.forbidden = 0;
            const body = document.querySelector('.sd-body'); body.classList.toggle('sd-editor-body', !!theaterView);
            body.innerHTML = renderActiveTab(); applyQianmuIcons(body); body.scrollTop = 0;
        };
    }, source);
    for (const [family, mode] of [['classic', 'dark'], ['editorial', 'light'], ['editorial', 'dark'], ['glass', 'light'], ['glass', 'dark']]) {
        for (const width of [320, 393, 1100]) for (const state of ['home', 'read', 'edit', 'favorites', 'error']) {
            const label = `${family}/${mode}/${width}/${state}`;
            await page.setViewportSize({ width, height: width === 320 ? 568 : 898 });
            await page.evaluate(async ({ family, mode, state }) => { await setAppearance(family, mode); renderTheaterFixture(state); }, { family, mode, state });
            await page.evaluate(() => { document.querySelectorAll('details').forEach(node => { node.open = true; }); });
            ok(label + ' actual view-specific controls remain', await page.evaluate(state => {
                if (state === 'home') return document.querySelectorAll('.sd-theater-stage,.sd-theater-open-latest,.sd-theater-open-favorites').length === 3 && document.querySelectorAll('.sd-lib-load').length === 30;
                if (state === 'read') return document.querySelectorAll('.sd-reader-font-opt').length === 5 && !!document.querySelector('.sd-reader-fullscreen');
                if (state === 'edit') return !!document.querySelector('.sd-reader-save') && !document.querySelector('.sd-reader-font-toggle');
                if (state === 'favorites') return document.querySelectorAll('.sd-fav-read,.sd-fav-remove').length === 56;
                return !!document.querySelector('.sd-theater-catalog-retry');
            }, state));
            ok(label + ' text rendering does not create untrusted images', await page.locator('.sd-body img').count() === 0);
            if (state === 'home' || state === 'edit') await page.locator('textarea').first().fill('尚未保存的幕外草稿\n'.repeat(80));
            const stable = await page.evaluate(async ({ family, mode, state }) => {
                const body = document.querySelector('.sd-body'), edit = body.querySelector('textarea'), target = edit || body.querySelector('button');
                target.focus(); if (edit) { edit.setSelectionRange(3, 10); edit.scrollTop = 70; }
                body.scrollTop = 40; body.querySelectorAll('.sd-scroll,.sd-theater-reader-scroll').forEach(node => { node.scrollTop = 85; });
                const checkbox = body.querySelector('input[type=checkbox]'); if (checkbox) checkbox.checked = !checkbox.checked;
                const all = [...body.querySelectorAll('*')], html = body.innerHTML, data = JSON.stringify([theaterFixture, theaterView, contextScanCache, calls]);
                const controls = [...body.querySelectorAll('input,textarea,select')].map(node => [node, node.value, node.checked]);
                const positions = [body, ...body.querySelectorAll('.sd-scroll,.sd-theater-reader-scroll,textarea')].map(node => [node, node.scrollTop]);
                await setAppearance(family === 'glass' ? 'editorial' : 'glass', mode === 'light' ? 'dark' : 'light'); await setAppearance(family, mode);
                return { dom: html === body.innerHTML && all.every(node => node.isConnected), focus: document.activeElement === target,
                    controls: controls.every(([node, value, checked]) => node.value === value && node.checked === checked), selection: !edit || (edit.selectionStart === 3 && edit.selectionEnd === 10),
                    scroll: positions.every(([node, top]) => Math.abs(top - node.scrollTop) < 1), exercisedScroll: state === 'error' || positions.some(([, top]) => top > 0),
                    state: data === JSON.stringify([theaterFixture, theaterView, contextScanCache, calls]) };
            }, { family, mode, state });
            ok(label + ' hot theme swap preserves reading/editing/list and catalog owner: ' + JSON.stringify(stable), Object.values(stable).every(Boolean));
            if (family !== 'classic') {
                const overflow = await page.locator('.sd-theater-settings-body .sd-source-row > span,.sd-theater-catalog-state p,.sd-fav-time,.sd-reader-prose').evaluateAll(nodes => nodes.filter(node => node.getClientRects().length).map(node => ({ className: node.className, width: node.clientWidth, scroll: node.scrollWidth })).filter(node => node.width + 1 < node.scroll));
                ok(label + ' long source titles and read failures fit the panel: ' + JSON.stringify(overflow.slice(0, 2)), overflow.length === 0);
                ok(label + ' preset labels stay within their selection rows', await page.locator('.sd-theater-settings-body .sd-source-row > span').evaluateAll(nodes => nodes.every(node => node.getBoundingClientRect().right <= node.parentElement.getBoundingClientRect().right + 1)));
                if (state === 'home') ok(label + ' original script library follows the family', await page.locator('[data-lib=script] .sd-lib-folder').first().evaluate((node, family) => getComputedStyle(node).borderRadius === (family === 'glass' ? '22px' : '5px'), family));
                if (['read', 'edit', 'favorites'].includes(state)) {
                    ok(label + ' reading uses an opaque unblurred surface', await page.locator('.sd-theater-view-card').evaluate(node => {
                        const style = getComputedStyle(node), cv = document.createElement('canvas'); cv.width = cv.height = 1; const ctx = cv.getContext('2d'); ctx.fillStyle = style.backgroundColor; ctx.fillRect(0, 0, 1, 1);
                        return ctx.getImageData(0, 0, 1, 1).data[3] === 255 && style.backdropFilter === 'none';
                    }));
                    ok(label + ' toolbar stays outside the scrolling prose', await page.evaluate(() => {
                        const bar = document.querySelector('.sd-reader-bar').getBoundingClientRect(), scroll = document.querySelector('.sd-theater-reader-scroll');
                        const before = bar.top; scroll.scrollTop += 140; const after = document.querySelector('.sd-reader-bar').getBoundingClientRect();
                        return Math.abs(before - after.top) < 1 && scroll.getBoundingClientRect().top >= after.bottom;
                    }));
                }
            }
            if (width === 393 && ((family === 'glass' && mode === 'light' && ['home', 'read'].includes(state)) || (family === 'editorial' && mode === 'dark' && ['edit', 'error'].includes(state)))) {
                await page.locator('.sd-body').evaluate(node => { node.scrollTop = 0; });
                await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
                await page.screenshot({ caret: 'initial', animations: 'disabled', path: fileURLToPath(new URL(`${family}-${mode}-${state}-393.png`, qa)) });
            }
        }
        await page.evaluate(() => renderTheaterFixture('html'));
        await page.frameLocator('.sd-reader-frame').locator('p').first().waitFor();
        const frame = page.frames().find(frame => frame !== page.mainFrame());
        await frame.evaluate(() => { window.scrollTo(0, 110); });
        await page.evaluate(() => { const frame = document.querySelector('.sd-reader-frame'); window.frameOwner = frame.contentWindow; window.frameLoads = 0; frame.addEventListener('load', () => { frameLoads++; }); });
        await page.evaluate(async ({ family, mode }) => { await setAppearance(family === 'glass' ? 'editorial' : 'glass', mode === 'light' ? 'dark' : 'light'); await setAppearance(family, mode); }, { family, mode });
        ok(`${family}/${mode} HTML frame keeps its sandbox, document, own palette and scroll`, await page.evaluate(() => {
            const frame = document.querySelector('.sd-reader-frame'); return frame.contentWindow === frameOwner && frameLoads === 0 && frame.getAttribute('sandbox') === 'allow-scripts allow-popups allow-forms';
        }) && await frame.evaluate(() => scrollY === 110 && getComputedStyle(document.body).backgroundColor === 'rgb(240, 232, 216)'));
        for (const state of ['empty', 'favorites-empty', 'loading', 'busy', 'export']) {
            await page.evaluate(state => renderTheaterFixture(state), state);
            ok(`${family}/${mode} original ${state} branch remains`, await page.evaluate(state => {
                const body = document.querySelector('.sd-body');
                if (state === 'empty') return body.textContent.includes('剧札空空') && !body.querySelector('.sd-theater-latest');
                if (state === 'favorites-empty') return body.textContent.includes('收藏夹还空着');
                if (state === 'loading') return body.textContent.includes('正在载入内置剧札') && calls.catalog === 0;
                if (state === 'busy') return body.querySelector('.sd-theater-stage').textContent.includes('停止上演');
                return body.querySelectorAll('.sd-lib-select:checked').length === 1 && !!body.querySelector('.sd-lib-confirm-export');
            }, state));
        }
    }
    await page.evaluate(() => renderTheaterFixture('idle'));
    await page.evaluate(async () => { await setAppearance('glass', 'light'); await setAppearance('editorial', 'dark'); });
    ok('a theme swap does not restart an initial catalog request', await page.evaluate(() => calls.catalog === 1 && calls.render === 0));
    await page.evaluate(async () => { document.getElementById(MODAL_ID).classList.remove('open'); resolveCatalog(); await Promise.resolve(); });
    ok('late catalog completion does not reopen a closed panel', await page.evaluate(() => calls.render === 0 && calls.forbidden === 0));
    await page.evaluate(() => appearance.reset()); assert.deepEqual(errors, []); assert.equal(external, 0);
    console.log(JSON.stringify({ passed: checks.length, checks, errors, external, scope: 'actual theater renderers; markdown fallback, synthetic HTML and catalog; no ST generation/save handlers or real catalog import' }));
} finally { clearTimeout(deadline); await context.close(); await browser.close(); }
