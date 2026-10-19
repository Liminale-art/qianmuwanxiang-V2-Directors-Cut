// Real renderers, bindings, icons and themes with synthetic selections only.
// No ST globals, user settings, original documents, generation or live requests.
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { storyboardFunctionSource } from '../tests/helpers/storyboard-form-fixture.mjs';
import { QIANMU_HIVE_COMMANDS } from '../qianmu-hive-commands.js';

const names = ['renderQuickWheelSettings', 'bindWidgetSettings', 'renderLibrarySection', 'renderLibraryListBody', 'renderLibraryRow', 'theaterScriptLibraryCfg', 'bindLibraryEvents', 'bindTheaterTabEvents'];
const source = names.map(storyboardFunctionSource).join('\n');
const css = await readFile(new URL('../style.css', import.meta.url), 'utf8') + '\n' + await readFile(new URL('../qianmu-theme-skins.css', import.meta.url), 'utf8');
const require = createRequire(import.meta.url), { chromium } = require(process.env.QIANMU_PLAYWRIGHT_MODULE || 'playwright');
const browser = await chromium.launch({ channel: process.env.QIANMU_BROWSER_CHANNEL || undefined, headless: true });
const context = await browser.newContext(), page = await context.newPage(), checks = [], errors = [], requests = [];
const deadline = setTimeout(() => { void browser.close(); }, 60000);
const qa = new URL('../dist/local-qa/hive-theater-controls/', import.meta.url); await mkdir(qa, { recursive: true });
page.on('pageerror', error => errors.push(error.message));
await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin === 'https://qianmu.test' && url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><style>body{margin:0}#story-director-modal{position:relative!important;display:block!important;inset:auto!important;transform:none!important;width:100%!important;height:100dvh!important}#story-director-modal .sd-window{width:100%!important;height:100%!important;max-height:none!important;margin:0!important}</style><div id="story-director-modal" class="open sd-theme-light"><section class="sd-window"><main class="sd-body"></main></section></div>` });
    if (url.origin === 'https://qianmu.test' && /^\/qianmu-[a-z0-9-]+\.js$/.test(url.pathname)) return route.fulfill({ contentType: 'text/javascript', body: await readFile(new URL('..' + url.pathname, import.meta.url)) });
    if (url.origin === 'https://qianmu.test' && /^\/qianmu-[a-z0-9-]+\.css$/.test(url.pathname)) return route.fulfill({ contentType: 'text/css', body: await readFile(new URL('..' + url.pathname, import.meta.url)) });
    requests.push(route.request().url()); return route.abort();
});
const record = name => checks.push(name);
try {
    await page.goto('https://qianmu.test/');
    await page.evaluate(async ({ source, commands }) => {
        const [utils, { applyQianmuIcons }, { createQianmuAppearanceSession }, { updateAppearancePreferences }] = await Promise.all([
            import('/qianmu-storyboard-utils.js'), import('/qianmu-icon-renderer.js'), import('/qianmu-appearance-session.js'), import('/qianmu-appearance-settings.js'),
        ]);
        Object.assign(window, {
            htmlEscape: utils.htmlEscape, groupByFolder: utils.groupByFolder, applyQianmuIcons,
            QUICK_COMMANDS: commands, QUICK_COMMAND_IDS: commands.map(item => item.id), normalizeQuickWheelSettings() {},
            settings: { theme: 'light', quickWheelEnabled: true, quickWheelCustomExpanded: true, quickWheelCustomOrder: commands.map(item => item.id), quickWheelCustomEnabled: commands.map(item => item.id) },
            theater: { scripts: [{ id: 'one', title: '旅途之一', folder: '' }, { id: 'two', title: '旅途之二', folder: '' }, { id: 'three', title: '家中片刻', folder: '' }], scriptSearch: '' },
            getTheater: () => theater, theaterCatalogReady: true, theaterView: null, theaterExportMode: true, theaterExportSelection: new Set(),
            calls: { saves: 0, exports: [], confirms: [], notices: [] }, saveSettings: () => calls.saves++,
            bindTheaterPresetPicker() {}, importTheaterScripts() {}, applyAccState() {}, closeQuickWheel() {},
            exportTheaterScripts: ids => calls.exports.push(ids), confirmDialog: async (...args) => { calls.confirms.push(args); return false; },
            toast: (...args) => calls.notices.push(args), closeNotesPanel() {}, renderFloatingNotes() {},
        });
        (0, eval)(source);
        window.renderModal = () => {
            const body = document.querySelector('.sd-body');
            body.innerHTML = `<section class="sd-card sd-widget-card">${renderQuickWheelSettings()}</section><section class="sd-card sd-theater-card">${renderLibrarySection(theaterScriptLibraryCfg())}</section>`;
            applyQianmuIcons(body); bindWidgetSettings(body); bindTheaterTabEvents(body);
        };
        window.appearance = createQianmuAppearanceSession({ readSettings: () => settings, loadStyles: () => ({ promise: Promise.resolve(true), cancel() {} }), loadFont: () => ({ promise: Promise.resolve(false), cancel() {} }) });
        appearance.mount(document.getElementById('story-director-modal'));
        window.setTheme = async (family, mode) => {
            settings.theme = mode; settings.appearance = updateAppearancePreferences(settings, { family, mode });
            const root = document.getElementById('story-director-modal'); root.classList.remove('sd-theme-light', 'sd-theme-dark'); root.classList.add(`sd-theme-${mode}`);
            appearance.repaintClassic(); await appearance.sync();
        };
        renderModal();
    }, { source, commands: QIANMU_HIVE_COMMANDS });
    for (const family of ['classic', 'editorial', 'glass']) for (const mode of ['light', 'dark']) for (const width of [320, 393, 1100]) {
        const label = `${family}/${mode}/${width}`;
        await page.setViewportSize({ width, height: 850 });
        await page.evaluate(async ({ family, mode }) => { await setTheme(family, mode); theaterExportMode = true; theaterExportSelection.clear(); theater.scriptSearch = ''; renderModal(); }, { family, mode });
        const grid = await page.locator('.sd-wheel-custom-list').evaluate(node => {
            const frame = node.getBoundingClientRect(), buttons = [...node.children], rows = new Map();
            for (const button of buttons) { const y = Math.round(button.getBoundingClientRect().top); rows.set(y, (rows.get(y) || 0) + 1); }
            return { columns: getComputedStyle(node).gridTemplateColumns.split(' ').length, rows: [...rows.values()],
                cells: buttons.map(button => { const rect = button.getBoundingClientRect(), icon = button.querySelector('.qm-glyph-icon').getBoundingClientRect(), text = button.querySelector('span').getBoundingClientRect(); return { label: button.querySelector('span').textContent, ratio: rect.width / rect.height, above: icon.bottom <= text.top + 1, centered: Math.abs(icon.left + icon.width / 2 - text.left - text.width / 2) < 1, fits: rect.left >= frame.left && rect.right <= frame.right + 1 && button.scrollWidth <= button.clientWidth + 1 && button.scrollHeight <= button.clientHeight + 1 }; }) };
        });
        assert.equal(grid.columns, 4, label); assert.deepEqual(grid.rows, [4, 4, 4, 4], label);
        assert.deepEqual(grid.cells.map(cell => cell.label), QIANMU_HIVE_COMMANDS.map(item => item.label));
        assert.ok(grid.cells.every(cell => cell.above && cell.centered && cell.fits && cell.ratio >= 0.7 && cell.ratio <= 1.2), `${label}: ${JSON.stringify(grid.cells)}`);
        record(`${label}: four near-square columns keep all sixteen icons above complete centered labels`);
        const bar = page.locator('.sd-lib-icon-selection');
        assert.equal(await page.locator('.sd-lib-cancel-export').count(), 0);
        const actions = await bar.locator('button').evaluateAll(nodes => nodes.map(node => {
            const rect = node.getBoundingClientRect(), icon = node.querySelector('.qm-glyph-icon');
            return { label: node.getAttribute('aria-label'), title: node.title, width: rect.width, height: rect.height, center: rect.top + rect.height / 2, icon: icon?.dataset.qmGlyph, text: node.textContent.trim() };
        }));
        assert.deepEqual(actions.map(action => action.label), ['全选/取消全选', '删除选中', '导出选中']);
        assert.deepEqual(actions.map(action => action.icon), ['qm-regular-checks', 'qm-regular-trash', 'qm-regular-file-arrow-up']);
        assert.ok(actions.every(action => action.text === '' && action.label === action.title && action.width === 28 && action.height === 28 && Math.abs(action.center - actions[0].center) <= 1));
        assert.equal(await bar.evaluate(node => node.scrollWidth <= node.clientWidth + 1), true);
        record(`${label}: theater selection keeps count and three shared compact icons on one line without duplicate cancel`);
        if (width === 320) {
            await page.locator('.sd-widget-card').screenshot({ path: fileURLToPath(new URL(`hive-${family}-${mode}-320.png`, qa)), animations: 'disabled' });
            await page.locator('.sd-theater-card').screenshot({ path: fileURLToPath(new URL(`theater-${family}-${mode}-320.png`, qa)), animations: 'disabled' });
            const before = await page.evaluate(() => JSON.stringify(theater.scripts));
            await page.locator('.sd-lib-select-all').click();
            assert.equal(await page.locator('.sd-lib-sel-count').textContent(), '3');
            await page.locator('.sd-lib-batch-delete').click();
            await page.waitForFunction(() => calls.confirms.length > 0);
            assert.equal(await page.evaluate(() => JSON.stringify(theater.scripts)), before, 'Cancelling deletion retains every synthetic document');
            await page.locator('.sd-lib-select-all').click(); assert.equal(await page.locator('.sd-lib-sel-count').textContent(), '0');
            await page.locator('.sd-lib-search').fill('旅途'); await page.locator('.sd-lib-select-all').click();
            await page.locator('.sd-lib-confirm-export').click();
            assert.deepEqual(await page.evaluate(() => calls.exports.at(-1)), ['one', 'two']);
            assert.equal(await page.locator('.sd-lib-icon-selection').count(), 0);
            await page.locator('.sd-lib-export-toggle').click();
            await page.locator('.sd-lib-select-all').click();
            await page.locator('.sd-lib-export-toggle').click();
            assert.equal(await page.locator('.sd-lib-icon-selection').count(), 0);
            assert.equal(await page.evaluate(() => theaterExportSelection.size), 0);
            assert.equal(await page.evaluate(() => JSON.stringify(theater.scripts)), before);
            record(`${label}: original select-all, filtered export and multiselect exit work; cancelled deletion preserves records`);
        }
    }
    assert.deepEqual(errors, []); assert.deepEqual(requests, []);
    console.log(JSON.stringify({ passed: checks.length, checks, errors, unexpectedRequests: requests, realST: false, productionDataRead: false }));
} catch (error) {
    await page.screenshot({ path: fileURLToPath(new URL('failure.png', qa)) }).catch(() => {}); throw error;
} finally { clearTimeout(deadline); await context.close(); await browser.close(); }
