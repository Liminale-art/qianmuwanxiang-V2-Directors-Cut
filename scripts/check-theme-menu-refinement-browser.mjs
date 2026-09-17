// Actual appearance menu renderer/binder, actions, session and native controls.
// All state is synthetic in a fresh browser context. No ST account, persistence,
// provider, production origin or paid generation is accessed by this regression.
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import vm from 'node:vm';
import { storyboardFunctionSource } from '../tests/helpers/storyboard-form-fixture.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.QIANMU_PLAYWRIGHT_MODULE || 'playwright');
const browser = await chromium.launch({ channel: process.env.QIANMU_BROWSER_CHANNEL || undefined, headless: true });
const deadline = setTimeout(() => { console.error('Theme menu refinement checks exceeded 120 seconds'); void browser.close(); }, 120000);
const context = await browser.newContext(), page = await context.newPage(), checks = [], errors = [], screenshots = [];
const screenshotDir = process.env.QIANMU_THEME_MENU_SCREENSHOT_DIR;
let external = 0;
if (screenshotDir) await mkdir(screenshotDir, { recursive: true });
page.on('pageerror', error => errors.push(error.message));
await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin === 'https://qianmu.test') {
        if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><html lang="zh-CN"><meta name="viewport" content="width=device-width,initial-scale=1"><body></body></html>' });
        if (/^\/qianmu-[a-z0-9-]+\.js$/.test(url.pathname)) return route.fulfill({ contentType: 'text/javascript', body: await readFile(new URL('..' + url.pathname, import.meta.url), 'utf8') });
    }
    external++;
    return route.abort();
});

const notesContext = vm.createContext({ notesSearch: '', notesRuntime: [], notesActiveId: 'n',
    notesFind: () => ({ id: 'n', body: '独立便笺未保存的正文。' }), notesFeatureSettings: () => ({ editorFontSize: 13 }),
    NOTES_EDITOR_FONT_SIZES: [13, 15], htmlEscape: value => String(value) });
vm.runInContext(storyboardFunctionSource('renderNotesPanel'), notesContext);
const notesHtml = notesContext.renderNotesPanel();

async function settled() {
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

async function continuity(label) {
    const result = await page.evaluate(() => ({
        draft: fixture.draft === document.getElementById('fixture-draft'),
        note: fixture.note === document.querySelector('.sd-note-body'),
        floating: fixture.floating === document.querySelector('.sd-detached-notes-entry'),
        values: [fixture.draft.value, fixture.note.value],
        selection: [fixture.draft.selectionStart, fixture.draft.selectionEnd, fixture.draft.selectionDirection],
        scroll: fixture.scroller.scrollTop,
        floatingPosition: [fixture.floating.style.left, fixture.floating.style.top],
        changes: fixture.contentChanges,
    }));
    assert.deepEqual(result, { draft: true, note: true, floating: true,
        values: ['面板中的未保存草稿。', '独立便笺未保存的正文。'], selection: [2, 7, 'backward'], scroll: 137,
        floatingPosition: ['20px', '600px'], changes: 0 }, label);
    checks.push(`${label}: draft, backward selection, notes, detached entry, scroll retained without content writes`);
}

try {
    await page.goto('https://qianmu.test/');
    for (const file of ['style.css', 'qianmu-theme-skins.css']) await page.addStyleTag({ content: await readFile(new URL('../' + file, import.meta.url), 'utf8') });
    // Only fixture bounds are supplied here; all menu/control/skin styling is production CSS.
    await page.addStyleTag({ content: 'body{margin:0}#story-director-modal{position:relative!important;display:block!important;inset:auto!important;transform:none!important;width:100%!important;height:100dvh!important}#story-director-modal>.sd-window{position:relative!important;inset:auto!important;transform:none!important;margin:0!important;width:100%!important;max-width:900px!important;height:100dvh!important;max-height:none!important}#story-director-modal .fixture-scroll{min-height:0;flex:1;overflow:auto}#story-director-modal .fixture-scroll-inner{min-height:1500px;padding:20px}#qianmu-notes-panel-layer{position:fixed;top:400px;left:12px;max-width:250px;width:250px;z-index:1}#qianmu-notes-panel-layer .sd-notes-panel{max-height:170px}#qianmu-notes-panel-layer .sd-note-body{min-height:90px!important;height:90px!important}.fixture-following{position:fixed;bottom:4px;right:4px;z-index:2147483647}' });
    await page.evaluate(async notesHtml => {
        for (const file of ['qianmu-theme-menu', 'qianmu-appearance-settings', 'qianmu-appearance-session', 'qianmu-appearance-actions', 'qianmu-classic-palettes', 'qianmu-icon-renderer']) Object.assign(window, await import(`./${file}.js`));
        window.setup = async ({ family = 'classic', mode = 'light', classic = 'dream', failStyles = false, supported = true } = {}) => {
            window.unbind?.(); window.session?.reset();
            window.settings = { theme: classic };
            if (family !== 'classic') settings.appearance = updateAppearancePreferences(settings, { family, mode });
            document.body.innerHTML = `<main id="story-director-modal" class="sd-theme-${classic} open"><section class="sd-window"><header class="sd-header"><div class="sd-titlebox"><h2>千幕</h2><span class="sd-version-tag">隔离测试</span></div><div class="sd-header-actions">${renderQianmuThemeMenu(THEMES, classic, { settings, supported })}</div></header><main class="sd-body fixture-scroll"><div class="fixture-scroll-inner"><textarea id="fixture-draft" class="text_pole">面板中的未保存草稿。</textarea></div></main></section></main><div id="qianmu-notes-panel-layer" class="sd-theme-${classic}">${notesHtml}</div><div id="qianmu-notes-float-layer" class="sd-theme-${classic} sd-hive-theme-${classic}"><button class="sd-detached-notes-entry is-glass-dark" style="left:20px;top:600px;--sd-notes-entry-width:46px;--sd-notes-entry-height:54px">N</button></div><button class="fixture-following">外部操作</button>`;
            const root = document.getElementById('story-director-modal');
            window.fixture = { root, note: document.querySelector('.sd-note-body'), draft: document.getElementById('fixture-draft'),
                floating: document.querySelector('.sd-detached-notes-entry'), scroller: root.querySelector('.fixture-scroll'),
                saveCalls: 0, saveAttempts: 0, failSave: false, styleLoads: 0, styleErrors: 0, contentChanges: 0, outsideClicks: 0 };
            const saveAppearance = () => { fixture.saveAttempts++; if (fixture.failSave) throw new Error('Isolated appearance save failure'); fixture.saveCalls++; };
            fixture.draft.setSelectionRange(2, 7, 'backward'); fixture.scroller.scrollTop = 137;
            for (const node of [fixture.draft, fixture.note]) for (const event of ['input', 'change']) node.addEventListener(event, () => fixture.contentChanges++);
            document.querySelector('.fixture-following').addEventListener('click', () => fixture.outsideClicks++);
            window.session = createQianmuAppearanceSession({ readSettings: () => settings,
                loadStyles: () => ({ promise: Promise.resolve(++fixture.styleLoads !== 1 || !failStyles), cancel() {} }),
                onError: () => fixture.styleErrors++ });
            session.mount(root); session.mountNotes(document);
            window.unbind = bindQianmuThemeMenu(root, key => { selectQianmuClassicTheme({ settings, themeKey: key, session, save: saveAppearance, resolveLogo: () => null }); },
                supported ? { read: () => ({ ...readAppearancePreferences(settings), classic: settings.theme }), status: () => session.status,
                    sync: () => session.sync(), retry: () => session.retry(), change: patch => changeQianmuAppearance({ settings, patch, session, save: saveAppearance }) } : null);
            applyQianmuIcons(root); await session.sync();
        };
        window.menuState = () => {
            const menu = fixture.root.querySelector('.sd-theme-menu');
            const visible = node => !!node.getClientRects().length && getComputedStyle(node).visibility !== 'hidden';
            const options = [...menu.querySelectorAll('button,input')].filter(visible);
            return { visible: !menu.hidden, options: options.map(node => ({ family: node.dataset.appearanceFamily || null,
                classic: node.dataset.theme || null, type: node.type, label: node.getAttribute('aria-label') || node.textContent.trim() })),
                activeFamily: document.activeElement?.dataset.appearanceFamily || null,
                preference: readAppearancePreferences(settings), classic: settings.theme, loads: fixture.styleLoads, saves: fixture.saveCalls,
                theme: fixture.root.dataset.qmTheme || null, mode: fixture.root.dataset.qmMode || null };
        };
    }, notesHtml);

    // The current selectors and interaction assertions below intentionally target
    // the production menu rather than a duplicate implementation in this fixture.
    const trigger = page.locator('.sd-theme-btn'), menu = page.locator('.sd-theme-menu');
    const familyButton = family => page.locator(`[data-appearance-family="${family}"]`);
    const details = page.locator('.sd-theme-details');
    async function compact(label) {
        const state = await page.evaluate(() => menuState());
        assert.equal(state.visible, true, label);
        assert.deepEqual(state.options.slice(0, 3).map(option => option.family), ['editorial', 'glass', 'classic'], `${label}: three family tiles first`);
        assert.equal(await details.isVisible(), true);
        assert.equal(state.options.length, state.preference.family === 'classic' ? 9 : 11);
        const tiles = await page.locator('[data-appearance-family]').evaluateAll(nodes => nodes.map(node => {
            const { x, y, width, height } = node.getBoundingClientRect(); return { x, y, width, height };
        }));
        assert.ok(tiles.every(tile => Math.abs(tile.y - tiles[0].y) < 1 && Math.abs(tile.width - tiles[0].width) < 1 && Math.abs(tile.height - tiles[0].height) < 1), `${label}: equal tiles on one row`);
        assert.ok(tiles[0].x < tiles[1].x && tiles[1].x < tiles[2].x);
        assert.equal(await page.locator('[data-appearance-family] .sd-theme-dot').count(), 0);
        assert.equal(await page.locator('.sd-theme-detail-head').count(), 0);
        checks.push(`${label}: text-only family tiles on one row with current colors immediately available`);
    }
    async function bounds(label) {
        const box = await menu.boundingBox();
        const viewport = page.viewportSize();
        assert.ok(box && box.x >= -1 && box.y >= -1 && box.x + box.width <= viewport.width + 1 && box.y + box.height <= viewport.height + 1, `${label}: menu fits viewport ${JSON.stringify(box)}`);
        assert.ok(await menu.evaluate(node => node.scrollWidth - node.clientWidth <= 1), `${label}: no horizontal overflow`);
        checks.push(`${label}: visible menu is bounded without horizontal clipping`);
    }
    for (const width of [320, 393, 1280]) {
        await page.setViewportSize({ width, height: 900 });
        await page.evaluate(() => setup());
        await trigger.click(); await compact(`${width}/initial`); await bounds(`${width}/initial`);
        assert.equal(await page.evaluate(() => fixture.styleLoads), 0, 'opening menu must not load new-theme CSS');
        for (const family of ['editorial', 'glass']) {
            await familyButton(family).click(); await settled();
            assert.equal(await details.isVisible(), true);
            assert.equal(await page.locator('.sd-theme-accent-options').isVisible(), true);
            assert.equal(await page.locator('.sd-theme-classic-options').isVisible(), false);
            const selected = await page.evaluate(() => menuState());
            assert.equal(selected.theme, family); assert.equal(selected.preference.family, family);
            assert.equal(await familyButton(family).getAttribute('aria-expanded'), null);
            assert.ok(await page.locator('[data-appearance-accent]:visible').count() >= 3, 'new themes need real selectable preset accents');
            assert.equal(await page.locator('input.sd-theme-color[type=color]:visible').count(), 1);
            assert.equal(await page.locator('.sd-theme-mode-toggle:visible').count(), 1);
            const row = await page.locator('.sd-theme-swatches').evaluate(node => [...node.children].map(item => {
                const box = item.getBoundingClientRect(); return { mode: item.hasAttribute('data-appearance-mode-toggle'), x: box.x, y: box.y, width: box.width, height: box.height };
            }));
            assert.equal(row.length, 8); assert.equal(row[0].mode, true);
            assert.ok(row.every((item,index) => Math.abs(item.y - row[0].y) < 1 && item.width >= 24 && item.height >= 36 && (!index || item.x > row[index - 1].x)));
            checks.push(`${width}/${family}: family applies immediately and reveals preset/manual accents and a single mode icon`);
            checks.push(`${width}/${family}: mode is first in the single color row, with distinct nonoverlapping hit targets`);
            await bounds(`${width}/${family}`); await continuity(`${width}/${family}/open`);

            const mode = page.locator('.sd-theme-mode-toggle');
            for (let index = 0; index < 2; index++) {
                const before = await page.evaluate(() => menuState());
                const next = before.preference.mode === 'light' ? 'dark' : 'light';
                assert.equal(await mode.getAttribute('aria-label'), next === 'dark' ? '切换至夜间' : '切换至日间');
                assert.equal((await mode.innerText()).trim(), '', 'mode remains an icon, not duplicate day/night text');
                await mode.click(); await settled();
                const after = await page.evaluate(() => menuState());
                assert.equal(after.mode, next); assert.equal(after.preference.mode, next); assert.equal(after.saves, before.saves + 1);
                assert.equal(after.visible, true); assert.equal(await details.isVisible(), true);
                checks.push(`${width}/${family}/${next}: accessible day/night icon switches in-place with exactly one save`);
            }

            const preset = page.locator('[data-appearance-accent]:visible').last();
            const accent = await preset.getAttribute('data-appearance-accent');
            await preset.click(); await settled();
            const afterPreset = await page.evaluate(() => menuState());
            assert.equal(afterPreset.preference.accent, accent.toLowerCase()); assert.equal(afterPreset.preference.source, 'manual');
            assert.equal(await preset.getAttribute('aria-checked'), 'true');
            assert.equal(await page.locator('.sd-theme-color').inputValue(), accent.toLowerCase());
            assert.equal(afterPreset.visible, true);
            checks.push(`${width}/${family}: preset accent and native color value stay synchronized; manual source avoids cover override`);

            const beforeColor = await page.evaluate(() => ({ saves: fixture.saveCalls, accent: fixture.root.style.getPropertyValue('--sd-accent'), notes: getComputedStyle(fixture.floating).color }));
            await page.locator('.sd-theme-color').evaluate(input => {
                input.focus(); input.value = '#c84e78';
                input.dispatchEvent(new Event('input', { bubbles: true }));
                input.dispatchEvent(new Event('change', { bubbles: true }));
            });
            await settled();
            const afterColor = await page.evaluate(() => ({ preference: readAppearancePreferences(settings), saves: fixture.saveCalls,
                focused: document.activeElement === document.querySelector('.sd-theme-color'), accent: fixture.root.style.getPropertyValue('--sd-accent'),
                notesAccent: document.getElementById('qianmu-notes-panel-layer').style.getPropertyValue('--sd-accent') }));
            assert.equal(afterColor.preference.accent, '#c84e78'); assert.equal(afterColor.preference.source, 'manual');
            assert.equal(afterColor.saves, beforeColor.saves + 1, 'native input + change commits same color once');
            assert.equal(afterColor.focused, true); assert.notEqual(afterColor.accent, beforeColor.accent); assert.equal(afterColor.notesAccent, afterColor.accent);
            assert.equal(await details.isVisible(), true);
            const swatches = await page.locator('.sd-theme-accent-options .sd-theme-swatch > span').evaluateAll(nodes => nodes.map(node => {
                const rect = node.getBoundingClientRect(), css = getComputedStyle(node);
                return { y: rect.y, width: rect.width, height: rect.height, radius: css.borderRadius, outline: css.outlineStyle, background: css.backgroundImage };
            }));
            assert.equal(swatches.length, 7);
            assert.ok(swatches.every(item => Math.abs(item.y - swatches[0].y) < 1 && item.width === swatches[0].width && item.height === swatches[0].height && item.radius === swatches[0].radius), `custom color matches preset geometry: ${JSON.stringify(swatches)}`);
            assert.match(swatches.at(-1).background, /^conic-gradient\(/);
            assert.equal(await page.locator('.sd-theme-custom-color > span').innerText(), '');
            assert.equal(await page.locator('.sd-theme-custom-color').evaluate(node => node.classList.contains('active')), true);
            assert.equal(await page.locator('[data-appearance-accent].active').count(), 0, 'custom accent does not leave a preset marked selected');
            checks.push(`${width}/${family}: plus-free rainbow picker matches circular preset geometry and retains selection feedback`);
            checks.push(`${width}/${family}: custom color updates main/notes without recreating input or double-saving input + change`);
            await continuity(`${width}/${family}/custom-color`);

            await familyButton(family).click();
            await compact(`${width}/${family}/same-family`);
            assert.equal(await page.evaluate(() => menuState().theme), family, 'same-family selection does not reset theme or hide colors');
            await familyButton(family).click(); assert.equal(await details.isVisible(), true);
            await page.keyboard.press('Escape'); assert.equal(await menu.isVisible(), false);
            assert.equal(await trigger.evaluate(node => node === document.activeElement), true);
            await trigger.click(); await compact(`${width}/${family}/reopen`);
            assert.equal(await familyButton(family).getAttribute('aria-checked'), 'true');
            checks.push(`${width}/${family}: Escape restores trigger focus and reopening keeps current colors available`);
        }

        await familyButton('classic').click(); await settled();
        assert.equal(await page.locator('.sd-theme-classic-options').isVisible(), true);
        assert.equal(await page.locator('.sd-theme-accent-options').isVisible(), false);
        assert.equal(await page.locator('.sd-theme-mode-toggle').isVisible(), false);
        assert.equal(await page.locator('[data-theme]:visible').count(), 6);
        assert.equal(await page.evaluate(() => menuState().theme), null);
        assert.equal(await page.evaluate(() => menuState().classic), 'dream');
        for (const theme of ['light', 'dark']) {
            const button = page.locator(`[data-theme="${theme}"]`);
            assert.equal((await button.innerText()).trim(), '', `${theme} classic control is dot-only`);
            assert.ok(await button.getAttribute('aria-label'), `${theme} dot has an accessible name`);
        }
        const classicDots = await page.locator('.sd-theme-classic-options .sd-theme-swatch').evaluateAll(nodes => nodes.map(node => {
            const box = node.getBoundingClientRect(), dot = node.querySelector('span');
            return { x: box.x, y: box.y, name: node.textContent.trim(), title: node.title, radius: getComputedStyle(dot).borderRadius };
        }));
        assert.equal(classicDots.length,6);
        assert.ok(classicDots.every((item,index) => Math.abs(item.y-classicDots[0].y)<1 && item.name==='' && item.title && item.radius==='50%' && (!index || item.x>classicDots[index-1].x)));
        await bounds(`${width}/classic`); await continuity(`${width}/classic-roundtrip`);
        await page.locator('[data-theme="summer"]').click(); await settled();
        assert.equal(await menu.isVisible(), true); assert.equal(await page.evaluate(() => settings.theme), 'summer');
        assert.equal(await page.locator('[data-theme="summer"]').evaluate(node => node === document.activeElement),true);
        assert.equal(await page.evaluate(() => [fixture.root, document.getElementById('qianmu-notes-panel-layer')].every(node => node.classList.contains('sd-theme-summer') && !node.hasAttribute('data-qm-theme'))), true);
        checks.push(`${width}/classic: six dot-only legacy palettes on one row with accessible names, in-place selection, stable focus and synchronized restoration`);
        await page.keyboard.press('Escape');
        await trigger.click(); await compact(`${width}/classic-reopen`);
        await familyButton('glass').click(); await settled();
        assert.equal(await page.locator('.sd-theme-color').inputValue(), '#c84e78');
        assert.equal(await page.evaluate(() => settings.theme), 'summer', 'new theme must not overwrite last classic palette');
        await continuity(`${width}/new-theme-return`);
        if (screenshotDir) {
            for (const family of ['editorial', 'glass', 'classic']) {
                if (await familyButton(family).getAttribute('aria-checked') !== 'true') await familyButton(family).click();
                await settled();
                const file = path.join(screenshotDir, `menu-${family}-${width}.png`);
                await page.screenshot({ path: file }); screenshots.push(file);
            }
        }
    }

    // Keyboard navigation stays in visible choices; native color controls remain
    // focusable and Escape/outside close do not change the chosen theme.
    await page.setViewportSize({ width: 393, height: 900 });
    await page.evaluate(() => setup({ family: 'glass', mode: 'dark' }));
    await trigger.focus(); await page.keyboard.press('ArrowDown');
    assert.equal(await familyButton('glass').evaluate(node => node === document.activeElement), true);
    await compact('keyboard/saved-theme');
    await page.keyboard.press('Home'); assert.equal(await familyButton('editorial').evaluate(node => node === document.activeElement), true);
    await page.keyboard.press('End'); assert.equal(await page.locator('.sd-theme-color').evaluate(node => node === document.activeElement), true);
    await page.keyboard.press('ArrowDown'); assert.equal(await page.locator('.sd-theme-color').evaluate(node => node === document.activeElement), true, 'native color retains arrow ownership');
    await familyButton('editorial').focus();
    await page.keyboard.press('ArrowUp'); assert.equal(await page.locator('.sd-theme-color').evaluate(node => node === document.activeElement), true, 'first item wraps to native color');
    await familyButton('editorial').focus();
    await page.keyboard.press('Enter'); await settled();
    assert.equal(await details.isVisible(), true);
    const visited = [];
    for (let index = 0; index < 16; index++) {
        visited.push(await page.evaluate(() => ({ type: document.activeElement.type, hidden: !document.activeElement.getClientRects().length,
            classic: document.activeElement.dataset.theme || null, label: document.activeElement.getAttribute('aria-label') })));
        await page.keyboard.press('ArrowDown');
    }
    assert.ok(visited.some(item => item.type === 'color'), 'keyboard can reach the color chooser');
    assert.ok(visited.some(item => /切换至/.test(item.label)), 'keyboard can reach mode icon');
    assert.ok(visited.every(item => !item.hidden && !item.classic), 'navigation skips collapsed classic controls');
    await page.keyboard.press('Escape'); assert.equal(await trigger.evaluate(node => node === document.activeElement), true);
    const selectedBeforeOutside = await page.evaluate(() => settings.appearance);
    await trigger.click(); await page.locator('.fixture-following').click();
    assert.equal(await menu.isVisible(), false); assert.equal(await page.evaluate(() => fixture.outsideClicks), 1);
    assert.equal(await page.locator('.fixture-following').evaluate(node => node === document.activeElement), true);
    assert.deepEqual(await page.evaluate(() => settings.appearance), selectedBeforeOutside);
    checks.push('keyboard: selected family, Home/End/wrap, native color reachability, hidden controls skipped, Escape and outside focus');

    // Resource failure keeps the classic pixels and a separate retry accessible
    // while the current colors remain visible; settings remain recoverable.
    await page.evaluate(() => setup({ failStyles: true }));
    await trigger.click(); await familyButton('glass').click(); await settled();
    await page.waitForFunction(() => session.status === 'error');
    assert.equal(await page.evaluate(() => menuState().theme), null);
    assert.equal(await page.evaluate(() => readAppearancePreferences(settings).family), 'glass');
    assert.equal(await page.locator('.sd-theme-retry').isVisible(), true);
    assert.match(await page.locator('.sd-theme-status').innerText(), /经典/);
    await familyButton('glass').click(); assert.equal(await details.isVisible(), true);
    assert.equal(await page.locator('.sd-theme-retry').isVisible(), true);
    await page.locator('.sd-theme-retry').click(); await settled();
    await page.waitForFunction(() => session.status === 'ready');
    assert.equal(await page.evaluate(() => fixture.styleLoads), 2); assert.equal(await page.evaluate(() => fixture.styleErrors), 1);
    assert.equal(await page.evaluate(() => menuState().theme), 'glass');
    assert.equal(await page.locator('.sd-theme-retry').isVisible(), false);
    assert.equal(await familyButton('glass').evaluate(node => node === document.activeElement), true, 'focus leaves disappearing retry for selected family');
    await continuity('resource-failure/retry');
    checks.push('resource failure: classic fallback, requested preference and visible colors retained; retry restores selected-family focus');

    // A native color interaction emits input followed by change. If input fails,
    // the action restores both preferences and pixels; the trailing old-color
    // change must not erase that failure or silently switch cover to manual.
    for (const family of ['editorial', 'glass']) for (const source of ['cover', 'manual']) {
        const label = `color-save-failure/${family}/${source}`;
        await page.evaluate(async ({ family, source }) => {
            await setup({ family, mode: 'dark' });
            settings.appearance = updateAppearancePreferences(settings, { source, accent: '#527c69' });
            await session.sync();
            window.appearancePixels = () => [fixture.root, document.getElementById('qianmu-notes-panel-layer'), fixture.floating].map(node => ({
                styles: node.getAttribute('style'), theme: node.dataset.qmTheme, mode: node.dataset.qmMode,
                background: getComputedStyle(node).backgroundImage,
            }));
        }, { family, source });
        await trigger.click(); await familyButton(family).click(); await settled();
        const before = await page.evaluate(() => ({ settings: JSON.stringify(settings), pixels: appearancePixels(), saves: fixture.saveCalls, attempts: fixture.saveAttempts }));
        await page.evaluate(() => { fixture.failSave = true; });
        await page.locator('.sd-theme-color').evaluate(input => {
            input.focus(); input.value = '#c84e78'; input.dispatchEvent(new Event('input', { bubbles: true }));
        });
        const inputError = await page.locator('.sd-theme-status').innerText();
        assert.match(inputError, /颜色切换未完成.*已保留原设置/);
        assert.equal(await page.locator('.sd-theme-color').inputValue(), '#527c69');
        await page.locator('.sd-theme-color').dispatchEvent('change'); await settled();
        const failed = await page.evaluate(() => ({ settings: JSON.stringify(settings), pixels: appearancePixels(), saves: fixture.saveCalls, attempts: fixture.saveAttempts,
            error: document.querySelector('.sd-theme-status').textContent, feedback: !document.querySelector('.sd-theme-feedback').hidden,
            focused: document.activeElement === document.querySelector('.sd-theme-color'), visible: !document.querySelector('.sd-theme-menu').hidden,
        }));
        assert.equal(failed.settings, before.settings); assert.deepEqual(failed.pixels, before.pixels);
        assert.equal(failed.saves, before.saves); assert.equal(failed.attempts, before.attempts + 1);
        assert.equal(failed.error, inputError); assert.equal(failed.feedback && failed.focused && failed.visible, true);
        assert.equal(await trigger.evaluate(node => node.classList.contains('has-appearance-error')), true);
        checks.push(`${label}: failed input plus trailing change keeps original preferences/pixels and visible error without another save attempt`);
        await continuity(`${label}/rollback`);

        await page.evaluate(() => { fixture.failSave = false; });
        await page.locator('.sd-theme-color').evaluate(input => {
            input.value = '#8b584a'; input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new Event('change', { bubbles: true }));
        });
        await settled();
        const recovered = await page.evaluate(() => ({ preference: readAppearancePreferences(settings), pixels: appearancePixels(), saves: fixture.saveCalls, attempts: fixture.saveAttempts,
            error: document.querySelector('.sd-theme-status').textContent, feedbackHidden: document.querySelector('.sd-theme-feedback').hidden,
        }));
        assert.equal(recovered.preference.accent, '#8b584a'); assert.equal(recovered.preference.source, 'manual');
        assert.equal(recovered.preference.family, family); assert.equal(recovered.preference.mode, 'dark');
        assert.notDeepEqual(recovered.pixels, before.pixels); assert.equal(recovered.saves, before.saves + 1); assert.equal(recovered.attempts, before.attempts + 2);
        assert.equal(recovered.error, ''); assert.equal(recovered.feedbackHidden, true);
        assert.equal(await trigger.evaluate(node => node.classList.contains('has-appearance-error')), false);
        checks.push(`${label}: next genuine color edit succeeds once, updates pixels and clears the prior failure`);
        await continuity(`${label}/recovery`);
    }

    // Classic palettes share in-place interaction, but keep their native save
    // owner and full-palette semantics (not invented independent day/night).
    for (const previousFamily of ['classic', 'glass']) {
        await page.evaluate(async family => {
            await setup({ family, mode: 'dark', classic: 'dream' });
        }, previousFamily);
        await trigger.click();
        if(previousFamily !== 'classic') await familyButton('classic').click();
        await settled();
        const before=await page.evaluate(()=>({ settings:JSON.stringify(settings), saves:fixture.saveCalls, attempts:fixture.saveAttempts,
            pixels:[fixture.root,document.getElementById('qianmu-notes-panel-layer')].map(node=>({classes:[...node.classList].sort(),style:node.getAttribute('style')})) }));
        await page.evaluate(()=>{fixture.failSave=true;});
        const selected=page.locator('[data-theme="summer"]');
        await selected.click(); await settled();
        const failed=await page.evaluate(()=>({ settings:JSON.stringify(settings), saves:fixture.saveCalls, attempts:fixture.saveAttempts,
            pixels:[fixture.root,document.getElementById('qianmu-notes-panel-layer')].map(node=>({classes:[...node.classList].sort(),style:node.getAttribute('style')})) }));
        assert.equal(failed.settings,before.settings); assert.deepEqual(failed.pixels,before.pixels);
        assert.equal(failed.saves,before.saves); assert.equal(failed.attempts,before.attempts+1);
        assert.equal(await menu.isVisible(),true);assert.equal(await selected.evaluate(node=>node===document.activeElement),true);
        assert.equal(await page.locator('[data-theme="dream"]').getAttribute('aria-checked'),'true');
        assert.equal(await selected.getAttribute('aria-checked'),'false');
        assert.match(await page.locator('.sd-theme-status').innerText(),/颜色切换未完成.*已保留原设置/);
        await continuity(`classic-save-failure/${previousFamily}`);
        await page.evaluate(()=>{fixture.failSave=false;});
        await selected.click(); await settled();
        assert.equal(await page.evaluate(()=>settings.theme),'summer');
        assert.equal(await page.evaluate(()=>fixture.saveCalls),before.saves+1);
        assert.equal(await menu.isVisible(),true); assert.equal(await selected.evaluate(node=>node===document.activeElement),true);
        assert.equal(await selected.getAttribute('aria-checked'),'true');
        assert.equal(await page.locator('.sd-theme-feedback').isVisible(),false);
        checks.push(`classic-save-failure/${previousFamily}: failed choice restores settings/pixels/radio while keeping focus and menu; retry succeeds once`);
        await selected.click(); await settled();
        assert.equal(await page.evaluate(()=>fixture.saveCalls),before.saves+1,'same classic palette does not save twice');
        checks.push(`classic-save-failure/${previousFamily}: repeating active palette leaves menu open without redundant saves`);
    }

    // Old engines retain the usable classic-only fallback, without advertising
    // unsupported new themes or introducing preferences during plain menu use.
    await page.evaluate(() => setup({ supported: false }));
    await trigger.click(); assert.equal(await page.locator('[data-appearance-family]').count(), 0);
    assert.equal(await page.locator('[data-theme]:visible').count(), 6);
    await page.locator('[data-theme="dark"]').click();
    assert.equal(await page.evaluate(() => settings.theme), 'dark');
    assert.equal(await page.evaluate(() => Object.hasOwn(settings, 'appearance')), false);
    checks.push('unsupported runtime: existing classic-only menu remains selectable and does not invent appearance settings');

    assert.deepEqual(errors, []); assert.equal(external, 0);
    console.log(JSON.stringify({ passed: checks.length, checks, errors, external, screenshots, productionDataRead: false,
        scope: 'actual menu/actions/session with synthetic state; native color input DOM events are not physical OS color-dialog validation' }));
} finally {
    clearTimeout(deadline); await context.close(); await browser.close();
}
