// Real library markup and theme styles; synthetic local entries, no ST access.
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { storyboardFunctionSource } from '../tests/helpers/storyboard-form-fixture.mjs';

const source = ['renderLibrarySection', 'renderLibraryListBody', 'renderLibraryRow'].map(storyboardFunctionSource).join('\n');
const baseline = process.argv.includes('--baseline');
const css = (baseline ? execFileSync('git', ['show', 'HEAD:style.css'], { cwd: fileURLToPath(new URL('..', import.meta.url)), encoding: 'utf8' }) : await readFile(new URL('../style.css', import.meta.url), 'utf8')) + '\n'
    + await readFile(new URL('../qianmu-theme-skins.css', import.meta.url), 'utf8');
const { chromium } = createRequire(import.meta.url)(process.env.QIANMU_PLAYWRIGHT_MODULE || 'playwright');
const browser = await chromium.launch({ channel: process.env.QIANMU_BROWSER_CHANNEL || undefined, headless: true });
const context = await browser.newContext(), page = await context.newPage();
const checks = [], errors = [], metrics = [];
const output = new URL('../dist/local-qa/theater-folder-borders/', import.meta.url);
await mkdir(output, { recursive: true });
let external = 0;
const blocked = [];
const ok = (name, value) => { checks.push({ name, passed: value }); if (!baseline) assert.ok(value, name); };
page.on('pageerror', error => errors.push(error.message));
await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin === 'https://qianmu.test' && url.pathname === '/') return route.fulfill({
        contentType: 'text/html; charset=utf-8', body: `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><style>body{margin:0}#story-director-modal{position:relative!important;display:block!important;inset:auto!important;transform:none!important;width:100%!important;height:100dvh!important;box-sizing:border-box}#story-director-modal .sd-window{width:100%!important;height:100%!important;max-height:none!important;margin:0!important}</style><div id="story-director-modal" class="open sd-theme-dark"><section class="sd-window"><main class="sd-body"><section class="sd-card"></section></main></section></div>`,
    });
    if (url.origin === 'https://qianmu.test' && /^\/qianmu-[a-z0-9-]+\.js$/.test(url.pathname)) return route.fulfill({
        contentType: 'application/javascript', body: await readFile(new URL('..' + url.pathname, import.meta.url)),
    });
    if (url.origin === 'https://qianmu.test' && /^\/qianmu-[a-z0-9-]+\.css$/.test(url.pathname)) return route.fulfill({
        contentType: 'text/css', body: await readFile(new URL('..' + url.pathname, import.meta.url)),
    });
    if (url.origin === 'https://qianmu.test' && url.pathname === '/favicon.ico') return route.fulfill({ status: 204 });
    external++; blocked.push(url.href); return route.abort();
});
try {
    await page.goto('https://qianmu.test/');
    await page.evaluate(async source => {
        const [utils, { createQianmuAppearanceSession }, { updateAppearancePreferences }, { applyQianmuIcons }] = await Promise.all([
            import('/qianmu-storyboard-utils.js'), import('/qianmu-appearance-session.js'), import('/qianmu-appearance-settings.js'), import('/qianmu-icon-renderer.js'),
        ]);
        Object.assign(window, { htmlEscape: utils.htmlEscape, groupByFolder: utils.groupByFolder, settings: { theme: 'dark' } });
        (0, eval)(source);
        const localStyles = () => ({ promise: Promise.resolve(true), cancel() {} });
        window.appearance = createQianmuAppearanceSession({ readSettings: () => settings, loadStyles: localStyles, loadFont: localStyles });
        appearance.mount(document.querySelector('#story-director-modal'));
        window.renderFixture = async (family, mode, open) => {
            settings.appearance = updateAppearancePreferences(settings, { family, mode }); await appearance.sync();
            document.querySelector('.sd-card').innerHTML = renderLibrarySection({ ns: 'script', title: '剧札', inlineCount: true,
                items: Array.from({ length: 14 }, (_, i) => ({ id: String(i), title: ['差一点', '存档与分支', '错时的信', '倒着写的一生'][i % 4], folder: i < 10 ? '千幕小剧场' : '咚咚小剧场' })),
                getSearch: () => '', getName: item => item.title, getFolder: item => item.folder, searchPlaceholder: '搜索剧札标题…',
            });
            document.querySelectorAll('.sd-lib-folder').forEach(node => { node.open = open; });
            applyQianmuIcons(document.querySelector('.sd-card'));
        };
    }, source);
    for (const [family, mode] of [['classic', 'dark'], ['classic', 'light'], ['editorial', 'light'], ['editorial', 'dark'], ['glass', 'light'], ['glass', 'dark']]) {
        for (const width of [320, 393, 560, 1100]) for (const open of [false, true]) {
            const label = `${family}/${mode}/${width}/${open ? 'open' : 'closed'}`;
            await page.setViewportSize({ width, height: 800 });
            await page.evaluate(({ family, mode, open }) => renderFixture(family, mode, open), { family, mode, open });
            const measured = await page.evaluate(() => {
                const folder = document.querySelector('.sd-lib-folder'), summary = folder.querySelector('summary');
                const f = getComputedStyle(folder), s = getComputedStyle(summary), list = document.querySelector('.sd-lib-list');
                const rows = [...document.querySelectorAll('.sd-lib-folder, .sd-lib-row')].filter(node => node.getClientRects().length);
                const expected = Math.max(0, parseFloat(f.borderTopLeftRadius) - parseFloat(f.borderTopWidth));
                return { folderRadius: f.borderTopLeftRadius, summaryRadius: s.borderTopLeftRadius, shadow: f.boxShadow,
                    cornersMatch: Math.abs(parseFloat(s.borderTopLeftRadius) - expected) < .01 && Math.abs(parseFloat(s.borderBottomLeftRadius) - (folder.open ? 0 : expected)) < .01,
                    singleThinBorder: rows.every(node => { const style = getComputedStyle(node); return ['Top', 'Right', 'Bottom', 'Left'].every(side => style['border' + side + 'Width'] === '1px') && style.boxShadow === 'none'; }),
                    insideScrollPort: rows.every(node => { const rect = node.getBoundingClientRect(), parent = list.getBoundingClientRect(); return rect.left >= parent.left && rect.right <= parent.right + .1; }),
                    sticky: s.position === 'sticky', overflow: list.scrollWidth <= list.clientWidth,
                };
            });
            metrics.push({ label, ...measured });
            for (const key of ['cornersMatch', 'singleThinBorder', 'insideScrollPort', 'sticky', 'overflow']) ok(label + ' ' + key, measured[key]);
            if (width === 393 && mode === 'light') await page.screenshot({ path: fileURLToPath(new URL(`${baseline ? 'before' : 'after'}-${family}-${open ? 'open' : 'closed'}.png`, output)), animations: 'disabled' });
            if (open) {
                await page.locator('.sd-lib-list').evaluate(node => { node.scrollTop = 90; });
                ok(label + ' sticky header stays in scrollport', await page.locator('.sd-lib-folder > summary').first().evaluate(node => Math.abs(node.getBoundingClientRect().top - node.closest('.sd-lib-list').getBoundingClientRect().top) < 1));
            }
        }
    }
    assert.deepEqual(errors, []); assert.equal(external, 0, JSON.stringify(blocked));
    console.log(JSON.stringify({ baseline, passed: checks.filter(check => check.passed).length, failed: checks.filter(check => !check.passed), metrics: metrics.filter(item => item.label.includes('/393/')), errors, external }));
} finally { await context.close(); await browser.close(); }
