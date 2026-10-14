// Actual preset renderers/change handlers; isolated host inventory, no real ST or model access.
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { presetPickerSource, installPresetPickerFixture, companionPresetHandlers } from '../tests/helpers/preset-picker-fixture.mjs';

const css = await readFile(new URL('../style.css', import.meta.url), 'utf8') + '\n' + await readFile(new URL('../qianmu-theme-skins.css', import.meta.url), 'utf8');
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.QIANMU_PLAYWRIGHT_MODULE || 'playwright');
const browser = await chromium.launch({ channel: process.env.QIANMU_BROWSER_CHANNEL || undefined, headless: true });
const context = await browser.newContext(), page = await context.newPage();
const errors = [], checks = [], externalUrls = []; let external = 0;
const ok = (name, value) => { assert.ok(value, name); checks.push(name); };
const qa = new URL('../dist/local-qa/shared-preset-pickers/', import.meta.url); await mkdir(qa, { recursive: true });
const deadline = setTimeout(() => { void browser.close(); }, 120000);
page.on('pageerror', error => errors.push(error.message));
await context.route('**/*', async route => {
  const url = new URL(route.request().url());
  if (url.origin === 'https://qianmu.test' && url.pathname === '/') return route.fulfill({
    contentType: 'text/html; charset=utf-8', body: `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><style>body{margin:0}#story-director-modal{position:relative!important;display:block!important;inset:auto!important;transform:none!important;width:100%!important;height:100dvh!important;box-sizing:border-box}#story-director-modal .sd-window{width:100%!important;height:100%!important;max-height:none!important;margin:0!important}</style><div id="story-director-modal" class="open sd-theme-dark"><section class="sd-window"><main class="sd-body"></main></section></div>`,
  });
  if (url.origin === 'https://qianmu.test' && /^\/qianmu-[a-z0-9-]+\.(?:js|css)$/.test(url.pathname)) return route.fulfill({ contentType: url.pathname.endsWith('.css') ? 'text/css' : 'application/javascript', body: await readFile(new URL('..' + url.pathname, import.meta.url)) });
  external++; externalUrls.push(url.href); return route.abort();
});
try {
  await page.goto('https://qianmu.test/');
  await page.evaluate(async ({ source, install, handlers }) => {
    const [utils, { groupPresetNames }, { createQianmuAppearanceSession }, { updateAppearancePreferences }] = await Promise.all([
      import('/qianmu-storyboard-utils.js'), import('/qianmu-st-context-sources.js'), import('/qianmu-appearance-session.js'), import('/qianmu-appearance-settings.js'),
    ]);
    Object.assign(window, utils, { groupPresetNames });
    (0, eval)(`(${install})(window)`); (0, eval)(source);
    window.appearance = createQianmuAppearanceSession({ readSettings: () => settings, loadStyles: () => ({ promise: Promise.resolve(true), cancel() {} }), loadFont: () => ({ promise: Promise.resolve(true), cancel() {} }) });
    appearance.mount(document.querySelector('#story-director-modal'));
    window.setAppearance = async (family, mode) => { settings.appearance = updateAppearancePreferences(settings, { family, mode }); await appearance.sync(); };
    window.paint = tab => {
      window.fixtureTab = tab;
      const body = document.querySelector('.sd-body');
      if (tab === 'theater') {
        body.innerHTML = `<section class="sd-card"><h3>幕外小剧场栏目组</h3>${renderTheaterPresetPicker(theater.presetName)}</section>`;
        bindTheaterPresetPicker(body);
      } else {
        body.innerHTML = `<div class="sd-reader-center-setup"><div class="sd-reader-setup-body">${renderCompanionSetupBody()}</div></div>`;
        const setupOverlay = body.querySelector('.sd-reader-center-setup');
        const rerenderSetup = () => { setupOverlay.querySelector('.sd-reader-setup-body').innerHTML = renderCompanionSetupBody(); };
        eval(handlers);
      }
    };
    window.renderModal = () => { calls.renders++; paint(fixtureTab); };
  }, { source: presetPickerSource, install: installPresetPickerFixture.toString(), handlers: companionPresetHandlers });
  for (const family of ['classic', 'editorial', 'glass']) for (const mode of ['light', 'dark']) for (const width of [320, 393, 1100]) {
    await page.setViewportSize({ width, height: 1100 });
    await page.evaluate(async ({ family, mode }) => { await setAppearance(family, mode); }, { family, mode });
    for (const tab of ['theater', 'companion']) {
      const label = `${family}/${mode}/${width}/${tab}`;
      await page.evaluate(tab => { theater.presetName = current; cp.presets = [current]; companionPresetView = ''; paint(tab); }, tab);
      if (tab === 'theater') await page.locator('.sd-theater-preset-picker > summary').click();
      const target = tab === 'theater' ? '.sd-theater-preset-picker' : '[data-fold="preset"]';
      ok(`${label}: same two series groups`, await page.locator(`${target} .sd-preset-version-group`).count() === 2);
      ok(`${label}: current occurs once inside its group`, await page.locator(`${target} .sd-preset-version-group[open] ${tab === 'theater' ? 'input[value="【照见】Claude-Versatile-5.1.3 5.5"]' : 'input[data-name="【照见】Claude-Versatile-5.1.3 5.5"]'}`).count() === 1);
      ok(`${label}: counts have no version suffix`, (await page.locator(`${target} .sd-preset-version-group > summary small`).allTextContents()).every(text => text === '2'));
      const geometry = await page.locator(target).evaluate(node => {
        const rect = node.getBoundingClientRect();
        const candidates = [...node.querySelectorAll('.sd-preset-version-group > summary, .sd-preset-version-group[open] input')];
        return { width: rect.width, within: candidates.every(row => { const r = row.getBoundingClientRect(); return r.left >= rect.left - 1 && r.right <= rect.right + 1; }), overflow: node.scrollWidth <= node.clientWidth + 1 };
      });
      ok(`${label}: no horizontal crop or overflow`, geometry.within && geometry.overflow);
      const summary = page.locator(`${target} .sd-preset-version-group`).first().locator('summary').first();
      await summary.focus(); await page.keyboard.press('Enter');
      ok(`${label}: keyboard folds group`, !(await summary.evaluate(node => node.parentElement.open)));
      await page.keyboard.press('Enter');
      if (tab === 'theater') {
        const older = page.locator('input.sd-theater-preset-select[value="【照见】Claude-Versatile-4.8（试吃1）"]');
        await older.focus(); await page.keyboard.press('Space');
        ok(`${label}: real radio handler persists selection`, await page.evaluate(() => theater.presetName === older && calls.saves > 0));
        await page.locator('.sd-theater-preset-picker > summary').click();
        ok(`${label}: only one checked radio after repaint`, await page.locator('input.sd-theater-preset-select:checked').count() === 1);
        await page.locator('input.sd-theater-preset-select[value=""]').check();
        ok(`${label}: no-preset selection persists`, await page.evaluate(() => theater.presetName === ''));
        await page.locator('.sd-theater-preset-picker > summary').click();
      } else {
        const older = page.locator('input.sd-reader-cps-toggle[data-name="【照见】Claude-Versatile-4.8（试吃1）"]');
        await older.focus(); await page.keyboard.press('Space');
        ok(`${label}: actual companion handler retains independent multiselect`, await page.evaluate(() => cp.presets.includes(current) && cp.presets.includes(older) && theater.presetName === current));
        await page.locator('.sd-reader-cps-name[data-name="【照见】Claude-Versatile-5.1.3 5.5"]').click();
        ok(`${label}: clicking name only changes viewed entries`, await page.evaluate(() => cp.presets.length === 2 && companionPresetView === current));
        await page.locator('.sd-reader-cps-scan').click();
        ok(`${label}: refresh retains current entry`, await page.locator('[data-fold="presetitems"]').innerText().then(text => text.includes('保留的条目')));
      }
      if (family === 'glass' && mode === 'light' && width === 393) {
        await page.evaluate(tab => { theater.presetName = current; cp.presets = [current]; paint(tab); if (tab === 'theater') document.querySelector('.sd-theater-preset-picker').open = true; }, tab);
        await page.locator(tab === 'theater' ? '.sd-card' : '[data-fold="preset"]').screenshot({ path: fileURLToPath(new URL(`${tab}-groups-393.png`, qa)) });
      }
    }
  }
  await page.evaluate(() => { fixtureNames.push('【照见】Claude-Versatile-5.2.0'); paint('companion'); });
  await page.locator('.sd-reader-cps-scan').click();
  ok('host-added version appears after real refresh action', await page.locator('.sd-reader-cps-toggle[data-name="【照见】Claude-Versatile-5.2.0"]').count() === 1);
  ok('no page errors', errors.length === 0); ok(`no external requests: ${externalUrls.join(', ')}`, external === 0);
  console.log(JSON.stringify({ passed: checks.length, errors, external, scope: 'Actual grouped renderers and production selection handlers with isolated settings/host reads', screenshots: ['theater-groups-393.png', 'companion-groups-393.png'] }));
} finally { clearTimeout(deadline); await browser.close(); }
