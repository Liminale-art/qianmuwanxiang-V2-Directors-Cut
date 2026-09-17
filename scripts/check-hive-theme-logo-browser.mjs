// Actual floating-button renderer, appearance session and native SVG rasterization.
// Synthetic origin/settings only: no production account, data or generation.
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { storyboardFunctionSource as section } from '../tests/helpers/storyboard-form-fixture.mjs';
const require = createRequire(import.meta.url), { chromium } = require(process.env.QIANMU_PLAYWRIGHT_MODULE || 'playwright');
const modules = ['qianmu-hive-theme-logo.js', 'qianmu-appearance-actions.js', 'qianmu-appearance-settings.js', 'qianmu-appearance-session.js', 'qianmu-appearance-runtime.js', 'qianmu-appearance-portals.js', 'qianmu-classic-palettes.js', 'qianmu-theme-surfaces.js', 'qianmu-theme-palette.js'];
const logos = ['qianmulogo.png', 'qianmulogo-dark.png', 'qianmulogo-summer.png', 'qianmulogo-candy.png', 'qianmulogo-dream.png'];
const css = await readFile(new URL('../style.css', import.meta.url), 'utf8');
const skin = await readFile(new URL('../qianmu-theme-skins.css', import.meta.url), 'utf8');
const browser = await chromium.launch({ channel: process.env.QIANMU_BROWSER_CHANNEL || undefined, headless: true });
const context = await browser.newContext(), page = await context.newPage(), errors = [], checks = [];
let external = 0;
page.on('pageerror', error => errors.push(error.message));
await context.route('**/*', async route => {
    const url = route.request().url();
    if (url === 'https://qianmu.test/') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body></body></html>' });
    const file = url.replace('https://qianmu.test/', '');
    if (modules.includes(file)) return route.fulfill({ contentType: 'text/javascript', body: await readFile(new URL('../' + file, import.meta.url), 'utf8') });
    if (logos.includes(file)) return route.fulfill({ contentType: 'image/png', body: await readFile(new URL('../' + file, import.meta.url)) });
    external++; return route.abort();
});
try {
    await page.goto('https://qianmu.test/'); await page.addStyleTag({ content: css }); await page.addStyleTag({ content: skin });
    await page.evaluate(async renderSource => {
        const { QIANMU_HIVE_THEME_LOGO } = await import('./qianmu-hive-theme-logo.js');
        const { createQianmuAppearanceSession } = await import('./qianmu-appearance-session.js');
        const { changeQianmuAppearance, selectQianmuClassicTheme } = await import('./qianmu-appearance-actions.js');
        const { THEME_KEYS, QUICK_HIVE_THEME_PALETTES } = await import('./qianmu-classic-palettes.js');
        const settings = { enabled: true, floatingButton: true, theme: 'dream' }, floatId = 'story-director-float';
        const logos = { light: 'qianmulogo.png', dark: 'qianmulogo-dark.png', summer: 'qianmulogo-summer.png', candy: 'qianmulogo-candy.png', kraft: 'qianmulogo.png', dream: 'qianmulogo-dream.png' };
        const session = createQianmuAppearanceSession({ readSettings: () => settings, document, loadStyles: () => ({ promise: Promise.resolve(true), cancel() {} }) });
        let saves = 0, clicks = 0;
        Object.assign(window, { settings, FLOAT_ID: floatId, EXTENSION_NAME: '千幕', THEME_KEYS, FLOAT_LOGO_URLS: logos,
            FLOAT_LOGO_URL: logos.light, QIANMU_HIVE_THEME_LOGO,
            QUICK_HEX_BORDER_SVG: '<svg class="sd-hive-hex-outline" viewBox="0 0 100 100" aria-hidden="true"><polygon points="50,1 99,25 99,75 50,99 1,75 1,25"/></svg>',
            syncNotesTheme() {}, closeQuickWheel() {}, closeFloorNavigator() {},
            currentHiveThemeKey: () => settings.theme, currentHivePalette: () => QUICK_HIVE_THEME_PALETTES[settings.theme],
            bindFloatDrag: button => { if (!button.dataset.testBound) { button.dataset.testBound = 'true'; button.addEventListener('click', () => clicks++); } },
            applyFloatPosition: button => { button.style.left = '32px'; button.style.top = '32px'; }, appearanceSession: session,
        });
        new Function(renderSource + ';window.renderFloatButton=renderFloatButton;')();
        renderFloatButton();
        const button = document.getElementById(floatId), image = button.querySelector('img'), svg = button.querySelector('.qm-hive-theme-logo');
        if (!svg) throw Error('The production renderer omitted the theme logo');
        window.fixture = { button, image, svg, session, settings, get saves() { return saves; }, get clicks() { return clicks; },
            change: patch => changeQianmuAppearance({ settings, patch, session, save() { saves++; } }),
            classic: themeKey => selectQianmuClassicTheme({ settings, themeKey, session, save() { saves++; }, resolveLogo: key => logos[key] }),
        };
        window.inspect = () => {
            const { button, image, svg } = fixture, style = getComputedStyle(button);
            const normalize = color => { const node = document.createElement('i'); node.style.color = color; button.append(node); const result = getComputedStyle(node).color; node.remove(); return result; };
            return { image: getComputedStyle(image).display, svg: getComputedStyle(svg).display,
                colors: [...svg.querySelectorAll('path')].map(path => getComputedStyle(path).fill),
                expected: ['--qm-ink', '--qm-accent'].map(key => normalize(style.getPropertyValue(key).trim() || '#000')),
                same: button === document.getElementById(floatId) && svg === button.querySelector('.qm-hive-theme-logo') && image === button.querySelector('img'),
                source: image.getAttribute('src'), left: button.style.left, top: button.style.top,
                size: [button.getBoundingClientRect().width, button.getBoundingClientRect().height],
                pointer: getComputedStyle(svg).pointerEvents, clicks: fixture.clicks };
        };
    }, section('renderFloatButton'));
    const initial = await page.evaluate(() => inspect());
    assert.equal(initial.svg, 'none'); assert.equal(initial.image, 'block'); assert.equal(initial.source, 'qianmulogo-dream.png');
    checks.push('Classic dream uses its existing PNG; the dormant vector adds no visible logo');
    for (const width of [393, 1280]) {
        await page.setViewportSize({ width, height: 900 });
        for (const family of ['editorial', 'glass']) for (const mode of ['light', 'dark']) {
            let previous;
            for (const accent of ['#8b584a', '#3c78bb', '#d24962']) {
                await page.evaluate(patch => fixture.change(patch), { family, mode, source: 'manual', accent });
                const state = await page.evaluate(() => inspect());
                assert.equal(state.image, 'none'); assert.equal(state.svg, 'block'); assert.equal(state.same, true);
                assert.deepEqual(state.colors, state.expected); assert.equal(state.pointer, 'none');
                assert.equal(state.left, '32px'); assert.equal(state.top, '32px'); assert.ok(state.size[0] > 30 && state.size[1] > 40);
                assert.equal(state.source, 'qianmulogo-dream.png', 'new themes must not overwrite the saved classic image');
                if (previous) assert.notEqual(state.colors[1], previous);
                previous = state.colors[1];
                checks.push(`${width}/${family}/${mode}/${accent}: both SVG regions follow current tokens on the same live node`);
                if (process.env.QIANMU_HIVE_QA_DIR && width === 393 && accent === '#d24962') {
                    await mkdir(process.env.QIANMU_HIVE_QA_DIR, { recursive: true });
                    await page.screenshot({ path: join(process.env.QIANMU_HIVE_QA_DIR, `${family}-${mode}.png`), clip: { x: 16, y: 16, width: 74, height: 80 } });
                }
            }
        }
    }
    await page.locator('#story-director-float').click();
    assert.equal((await page.evaluate(() => inspect())).clicks, 1);
    checks.push('Visible SVG does not intercept the original button click');
    for (const key of ['light', 'dark', 'summer', 'candy', 'kraft', 'dream']) {
        await page.evaluate(key => fixture.classic(key), key);
        const state = await page.evaluate(() => inspect());
        assert.equal(state.same, true); assert.equal(state.image, 'block'); assert.equal(state.svg, 'none');
        assert.equal(state.source, key === 'light' || key === 'kraft' ? 'qianmulogo.png' : `qianmulogo-${key}.png`);
        checks.push(`Classic ${key}: original PNG and node restored, no theme-vector bleed`);
    }
    // Quantify original silhouette preservation, including transparent film holes.
    const fidelity = await page.evaluate(async () => {
        const { QIANMU_HIVE_THEME_LOGO } = await import('./qianmu-hive-theme-logo.js');
        const load = src => new Promise((resolve, reject) => { const image = new Image(); image.onload = () => resolve(image); image.onerror = reject; image.src = src; });
        const svg = QIANMU_HIVE_THEME_LOGO.replace('display:none', 'display:block').replaceAll('var(--qm-ink)', '#000').replaceAll('var(--qm-accent)', '#000');
        const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
        try {
            const [source, traced] = await Promise.all([load('/qianmulogo.png'), load(url)]);
            const canvas = document.createElement('canvas'); canvas.width = canvas.height = 384;
            const ctx = canvas.getContext('2d');
            const read = image => { ctx.clearRect(0, 0, 384, 384); ctx.drawImage(image, 0, 0, 384, 384); return ctx.getImageData(0, 0, 384, 384).data; };
            const a = read(source), b = read(traced); let intersection = 0, union = 0;
            for (let i = 3; i < a.length; i += 4) { if (a[i] >= 96 || b[i] >= 96) union++; if (a[i] >= 96 && b[i] >= 96) intersection++; }
            return { intersection, union, overlap: intersection / union };
        } finally { URL.revokeObjectURL(url); }
    });
    assert.ok(fidelity.overlap > .98, `SVG trace diverged from bundled original: ${JSON.stringify(fidelity)}`);
    checks.push(`Native raster silhouette overlap ${fidelity.overlap.toFixed(4)} with original PNG; no logo redesign`);
    assert.equal(external, 0); assert.deepEqual(errors, []);
    console.log(JSON.stringify({ passed: checks.length, checks, fidelity, errors, external, productionDataRead: false }));
} finally { await context.close(); await browser.close(); }
