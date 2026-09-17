// Production detached-note render/mount/theme/drag chain with synthetic settings.
// No user notes, production origin, account persistence or provider is accessed.
// Settings and device saves are separate counters, not durable-storage proof.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { storyboardFunctionSource as section } from '../tests/helpers/storyboard-form-fixture.mjs';
const require = createRequire(import.meta.url), { chromium } = require(process.env.QIANMU_PLAYWRIGHT_MODULE || 'playwright');
const browser = await chromium.launch({ channel: process.env.QIANMU_BROWSER_CHANNEL || undefined, headless: true });
const context = await browser.newContext(), page = await context.newPage(), checks = [], errors = [];
let external = 0;
page.on('pageerror', error => errors.push(error.message));
await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin === 'https://qianmu.test') {
        if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><meta name="viewport" content="width=device-width,initial-scale=1"><body></body></html>' });
        if (/^\/qianmu-[a-z0-9-]+\.js$/.test(url.pathname)) return route.fulfill({ contentType: 'text/javascript', body: await readFile(new URL('..' + url.pathname, import.meta.url), 'utf8') });
    }
    external++; return route.abort();
});
try {
    await page.goto('https://qianmu.test/');
    for (const file of ['style.css', 'qianmu-theme-skins.css']) await page.addStyleTag({ content: await readFile(new URL('../' + file, import.meta.url), 'utf8') });
    await page.evaluate(async functions => {
        for (const file of ['qianmu-appearance-session', 'qianmu-appearance-actions', 'qianmu-classic-palettes', 'qianmu-icon-renderer', 'qianmu-notes-theme']) Object.assign(window, await import(`./${file}.js`));
        window.settings = { theme: 'dream', notes: { enabled: true, detached: true, position: { x: 80, y: 180 }, appearance: { tone: 'dark', edgeIndex: 0 } } };
        window.fixture = { settingsSaves: 0, deviceSaves: 0, opens: 0, renders: 0 };
        Object.assign(window, { MODULE_NAME: 'isolated-qianmu', NOTES_FLOAT_LAYER_ID: 'qianmu-notes-float-layer', NOTES_PANEL_LAYER_ID: 'qianmu-notes-panel-layer', notesPanelOpen: false,
            QUICK_HEX_BORDER_SVG: '<svg class="sd-hive-hex-outline" viewBox="0 0 100 100" aria-hidden="true"><polygon points="50,1 99,25 99,75 50,99 1,75 1,25"/></svg>',
            notesFeatureSettings: () => settings.notes, clampDetachedNotesEntry: position => ({ ...position }), detachedNotesGeometry: () => ({ width: 52, height: 60 }),
            htmlEscape: value => String(value).replaceAll('"', '&quot;'), detachedNoteCanReturnHome: () => false,
            saveSettings: () => fixture.settingsSaves++, persistNotesDevice: () => fixture.deviceSaves++, openNotesPanel: () => fixture.opens++, toast() {}, NOTES_THEME_VARIABLES: ['--sd-text', '--sd-accent', '--sd-card'],
        });
        window.appearanceSession = createQianmuAppearanceSession({ readSettings: () => settings, document, loadStyles: () => ({ promise: Promise.resolve(true), cancel() {} }) });
        new Function(functions + ';Object.assign(window,{renderFloatingNotes,bindFloatingNoteEvents,syncNotesTheme});')();
        renderFloatingNotes(); fixture.renders++;
        fixture.entry = document.querySelector('.sd-detached-notes-entry'); fixture.layer = fixture.entry.parentElement;
        fixture.icon = fixture.entry.querySelector('.qm-glyph-icon'); fixture.border = fixture.entry.querySelector('polygon');
        if (!fixture.icon || !fixture.border) throw Error('Actual note renderer must produce its real local icon and border');
        fixture.change = patch => changeQianmuAppearance({ settings, patch, session: appearanceSession, save: saveSettings });
        fixture.classic = themeKey => selectQianmuClassicTheme({ settings, themeKey, session: appearanceSession, save: saveSettings, resolveLogo: () => null });
        window.inspect = () => {
            const { entry, icon, border } = fixture, style = getComputedStyle(entry), line = getComputedStyle(border);
            const resolve = color => { const node = document.createElement('i'); node.style.color = color; entry.append(node); const out = getComputedStyle(node).color; node.remove(); return out; };
            return { same: entry === document.querySelector('.sd-detached-notes-entry') && icon === entry.querySelector('.qm-glyph-icon'),
                family: entry.dataset.qmTheme || null, mode: entry.dataset.qmMode || null, icon: getComputedStyle(icon).color, color: style.color,
                background: style.backgroundColor, edge: line.stroke, animation: line.animationName,
                accent: resolve(style.getPropertyValue('--qm-accent') || '#000'),
                ink: resolve(`color-mix(in srgb, ${style.getPropertyValue('--qm-accent') || '#000'} 55%, ${style.getPropertyValue('--qm-ink') || '#000'})`),
                position: [entry.style.left, entry.style.top], preference: { ...settings.notes.appearance }, renders: fixture.renders, settingsSaves: fixture.settingsSaves, deviceSaves: fixture.deviceSaves };
        };
    }, ['currentHiveThemeKey', 'currentHivePalette', 'renderFloatingNotes', 'bindFloatingNoteEvents', 'syncNotesTheme'].map(section).join('\n'));
    const original = await page.evaluate(() => inspect());
    assert.equal(original.animation, 'sd-hive-dream-edge');
    checks.push('Real classic dream detached note starts with its saved dark tone / edge 0 and classic animation');
    if (process.env.QIANMU_NOTES_APPEARANCE_AUDIT === '1') {
        const states = [];
        for (const patch of [{ family: 'glass', mode: 'light', accent: '#d24962', source: 'manual' }, { mode: 'dark' }, { accent: '#3c78bb' }]) {
            await page.evaluate(patch => fixture.change(patch), patch); states.push(await page.evaluate(() => inspect()));
        }
        console.log(JSON.stringify({ audit: states, errors, external, productionDataRead: false }));
    } else {
        for (const width of [393, 1280]) {
            await page.setViewportSize({ width, height: 900 });
            for (const family of ['editorial', 'glass']) {
                let priorMode;
                for (const mode of ['light', 'dark']) {
                    let priorAccent;
                    for (const accent of ['#d24962', '#3c78bb']) {
                        await page.evaluate(patch => fixture.change(patch), { family, mode, accent, source: 'manual' });
                        const result = await page.evaluate(() => inspect());
                        assert.equal(result.same, true); assert.equal(result.family, family); assert.equal(result.mode, mode);
                        assert.equal(result.animation, 'none', 'classic dream animation must not mask current accent');
                        assert.equal(result.edge, result.accent, 'computed stroke must use the selected accent even for saved edge 0');
                        assert.equal(result.icon, result.ink); assert.equal(result.color, result.ink);
                        assert.deepEqual(result.preference, { tone: 'dark', edgeIndex: 0 }); assert.deepEqual(result.position, ['80px', '180px']); assert.equal(result.renders, 1);
                        assert.equal(result.deviceSaves, 0, 'appearance edits must not write device geometry');
                        if (priorAccent) { assert.notEqual(result.edge, priorAccent.edge); assert.notEqual(result.icon, priorAccent.icon); }
                        priorAccent = result;
                        if (accent === '#3c78bb' && priorMode) { assert.notEqual(result.background, priorMode.background, 'day/night must not stay on saved dark tone'); assert.notEqual(result.icon, priorMode.icon); }
                        if (accent === '#3c78bb') priorMode = result;
                        checks.push(`${width}/${family}/${mode}/${accent}: actual note mount changes computed stroke/icon/fill without rebuilding or changing classic preferences`);
                    }
                }
            }
        }
        // The real pointer-capture handler continues while the theme is changed.
        await page.mouse.move(106, 210); await page.mouse.down(); await page.mouse.move(151, 248);
        const before = await page.evaluate(() => ({ position: [fixture.entry.style.left, fixture.entry.style.top], settingsSaves: fixture.settingsSaves, deviceSaves: fixture.deviceSaves, dragging: fixture.entry.classList.contains('is-dragging') }));
        assert.equal(before.dragging, true);
        await page.evaluate(() => fixture.change({ mode: 'light', accent: '#527c69' }));
        await page.mouse.move(180, 278); await page.mouse.up();
        const after = await page.evaluate(() => ({ same: fixture.entry === document.querySelector('.sd-detached-notes-entry'), position: settings.notes.position, settingsSaves: fixture.settingsSaves, deviceSaves: fixture.deviceSaves, dragging: fixture.entry.classList.contains('is-dragging') }));
        assert.equal(after.same, true); assert.equal(after.dragging, false);
        assert.equal(after.settingsSaves, before.settingsSaves + 1, 'only the theme edit writes account preferences, not the drag');
        assert.equal(after.deviceSaves, before.deviceSaves + 1, 'completed drag writes device geometry once');
        assert.ok(after.position.x > Number.parseFloat(before.position[0]) && after.position.y > Number.parseFloat(before.position[1]));
        checks.push('Native captured-pointer drag continues across appearance change: one account theme save and one separate device geometry save');

        // All classic palettes must continue using the retained classic tone and edge.
        for (const key of ['light', 'dark', 'summer', 'candy', 'kraft', 'dream']) {
            await page.evaluate(key => fixture.classic(key), key);
            const result = await page.evaluate(() => {
                const state = inspect(), palette = QUICK_HIVE_THEME_PALETTES[settings.theme];
                return { ...state, fill: fixture.entry.style.getPropertyValue('--sd-wheel-glass-fill'), tokenIcon: fixture.entry.style.getPropertyValue('--sd-wheel-icon'),
                    tokenEdge: fixture.entry.style.getPropertyValue('--sd-wheel-edge'), expected: { fill: palette.darkFill, icon: palette.darkIcon, edge: palette.edges[0] } };
            });
            assert.equal(result.same, true); assert.equal(result.family, null); assert.equal(result.fill, result.expected.fill); assert.equal(result.tokenIcon, result.expected.icon); assert.equal(result.tokenEdge, result.expected.edge);
            assert.deepEqual(result.preference, { tone: 'dark', edgeIndex: 0 }); assert.equal(result.animation, key === 'dream' ? 'sd-hive-dream-edge' : 'none');
            checks.push(`Classic ${key}: original detached-note tone / edge / animation restored on same live entry`);
        }
        // Production resync can repaint classic tokens during other UI work. The final
        // mount must reapply current optional appearance immediately, never on reopen.
        await page.evaluate(() => fixture.change({ family: 'editorial', mode: 'light', accent: '#ad7950' }));
        const themed = await page.evaluate(() => inspect());
        await page.evaluate(() => syncNotesTheme());
        const resynced = await page.evaluate(() => inspect());
        for (const key of ['same', 'edge', 'icon', 'background', 'mode', 'animation']) assert.equal(resynced[key], themed[key]);
        checks.push('Real syncNotesTheme classic-token refresh cannot overwrite the current new-theme detached entry');

        // Late creation under an already-selected theme uses the same production mount.
        await page.evaluate(() => { renderFloatingNotes(); fixture.renders++; fixture.entry = document.querySelector('.sd-detached-notes-entry'); fixture.layer = fixture.entry.parentElement; fixture.icon = fixture.entry.querySelector('.qm-glyph-icon'); fixture.border = fixture.entry.querySelector('polygon'); });
        const late = await page.evaluate(() => inspect());
        assert.equal(late.family, 'editorial'); assert.equal(late.mode, 'light'); assert.equal(late.edge, late.accent); assert.equal(late.icon, late.ink); assert.equal(late.animation, 'none');
        checks.push('Newly detached note immediately inherits the current appearance without opening its panel');
        await page.locator('.sd-detached-notes-entry').click(); assert.equal(await page.evaluate(() => fixture.opens), 1);
        checks.push('Theme adaptation preserves the real detached-note click-to-open binding');
        assert.equal(external, 0); assert.deepEqual(errors, []);
        console.log(JSON.stringify({ passed: checks.length, checks, errors, external, productionDataRead: false,
            scope: 'real renderer, theme session and native drag handlers; account/device saves use separate synthetic counters, not real localStorage' }));
    }
} finally { await context.close(); await browser.close(); }
