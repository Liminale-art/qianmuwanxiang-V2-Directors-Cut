// Actual preset renderers/change handlers; isolated host inventory, no real ST or model access.
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { presetPickerSource, installPresetPickerFixture, companionPresetHandlers, theaterPresetEntryBindings } from '../tests/helpers/preset-picker-fixture.mjs';

function controlProbe(node) {
  const style = getComputedStyle(node);
  return Object.fromEntries(['fontSize', 'fontWeight', 'lineHeight', 'color', 'backgroundColor', 'borderRadius', 'borderTopWidth', 'borderTopStyle', 'borderTopColor', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'minHeight'].map(key => [key, style[key]]));
}

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
    contentType: 'text/html; charset=utf-8', body: `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><style>body{margin:0}#story-director-modal{position:relative!important;inset:auto!important;transform:none!important;width:100%!important;height:100dvh!important;box-sizing:border-box}#story-director-modal .sd-window{width:100%!important;height:100%!important;max-height:none!important;margin:0!important}</style><div id="story-director-modal" class="open sd-theme-dark"><section class="sd-window"><main class="sd-body"></main></section></div><div id="sd-reader-portal" class="sd-reader-portal"><div class="sd-reader-stage"><div class="sd-reader-morepage"><div class="sd-reader-morepage-body"></div></div></div></div>`,
  });
  if (url.origin === 'https://qianmu.test' && /^\/qianmu-[a-z0-9-]+\.(?:js|css)$/.test(url.pathname)) return route.fulfill({ contentType: url.pathname.endsWith('.css') ? 'text/css' : 'application/javascript', body: await readFile(new URL('..' + url.pathname, import.meta.url)) });
  external++; externalUrls.push(url.href); return route.abort();
});
try {
  await page.goto('https://qianmu.test/');
  await page.evaluate(async ({ source, install, handlers, entryBindings }) => {
    const [utils, { groupPresetNames }, { createQianmuAppearanceSession }, { updateAppearancePreferences }] = await Promise.all([
      import('/qianmu-storyboard-utils.js'), import('/qianmu-st-context-sources.js'), import('/qianmu-appearance-session.js'), import('/qianmu-appearance-settings.js'),
    ]);
    Object.assign(window, utils, { groupPresetNames });
    (0, eval)(`(${install})(window)`); (0, eval)(source);
    window.appearance = createQianmuAppearanceSession({ readSettings: () => settings, loadStyles: () => ({ promise: Promise.resolve(true), cancel() {} }), loadFont: () => ({ promise: Promise.resolve(true), cancel() {} }) });
    appearance.mount(document.querySelector('#story-director-modal'));
    appearance.mountPortal(document.querySelector('#sd-reader-portal'), { inheritTheme: true, role: 'reader' });
    window.setAppearance = async (family, mode) => {
      settings.theme = mode; settings.appearance = updateAppearancePreferences(settings, { family, mode });
      for (const id of ['story-director-modal', 'sd-reader-portal']) { const root = document.getElementById(id); root.classList.toggle('sd-theme-dark', mode === 'dark'); root.classList.toggle('sd-theme-light', mode === 'light'); }
      appearance.repaintClassic();
      await appearance.sync();
    };
    window.paint = tab => {
      window.fixtureTab = tab;
      const modal = document.getElementById('story-director-modal'), portal = document.getElementById('sd-reader-portal');
      modal.style.setProperty('display', tab === 'companion-portal' ? 'none' : 'block', 'important');
      portal.style.setProperty('display', tab === 'companion-portal' ? 'flex' : 'none', 'important');
      modal.querySelector('.sd-body').innerHTML = ''; portal.querySelector('.sd-reader-morepage-body').innerHTML = '';
      const body = tab === 'companion-portal' ? portal.querySelector('.sd-reader-morepage-body') : modal.querySelector('.sd-body');
      if (tab === 'theater') {
        body.innerHTML = renderTheaterTab();
        bindTheaterPresetPicker(body);
        const root = body; eval(entryBindings);
      } else if (tab === 'materials') {
        body.innerHTML = renderContextTab();
      } else {
        body.innerHTML = `<div class="sd-reader-center-setup"><div class="sd-reader-setup-body">${renderCompanionSetupBody()}</div></div>`;
        const setupOverlay = body.querySelector('.sd-reader-center-setup');
        const rerenderSetup = () => { setupOverlay.querySelector('.sd-reader-setup-body').innerHTML = renderCompanionSetupBody(); };
        eval(handlers);
      }
    };
    window.renderModal = () => { calls.renders++; paint(fixtureTab); };
  }, { source: presetPickerSource, install: installPresetPickerFixture.toString(), handlers: companionPresetHandlers, entryBindings: theaterPresetEntryBindings });
  for (const family of ['classic', 'editorial', 'glass']) for (const mode of ['light', 'dark']) for (const width of [320, 393, 1100]) {
    await page.setViewportSize({ width, height: 1100 });
    await page.evaluate(async ({ family, mode }) => { await setAppearance(family, mode); }, { family, mode });
    await page.evaluate(() => { paint('materials'); document.querySelector('[data-acc="dd-preset"]').open = true; });
    const materialLabel = `${family}/${mode}/${width}/materials`;
    ok(`${materialLabel}: one concise preset-use hint`, await page.locator('.sd-preset-guidance').count() === 1
      && await page.locator('[data-acc="acc-presets"] > summary > .sd-preset-guidance').textContent() === '按需勾选，乱选只会左右脑互搏哦(ˉ▽ˉ；)');
    ok(`${materialLabel}: hint uses caption scale without clipping`, await page.locator('.sd-preset-guidance').evaluate(node => {
      const style = getComputedStyle(node), root = getComputedStyle(document.querySelector('#story-director-modal'));
      const box = node.getBoundingClientRect(), heading = node.parentElement.getBoundingClientRect(), title = node.parentElement.querySelector('b').getBoundingClientRect();
      return style.fontSize === root.getPropertyValue('--qm-type-caption').trim() && node.scrollWidth <= node.clientWidth + 1
        && style.textAlign === 'right' && box.left >= title.right && box.right <= heading.right;
    }));
    ok(`${materialLabel}: hint does not add selection controls`, await page.evaluate(() =>
      !document.querySelector('.sd-preset-guidance input,.sd-preset-guidance button')
      && document.querySelectorAll('.sd-pick-preset:checked').length === 1
      && document.querySelector('.sd-pick-preset:checked').dataset.name === current));
    ok(`${materialLabel}: only preset read status is replaced`, await page.evaluate(() =>
      !/已读取|待读取/.test(document.querySelector('[data-acc="acc-presets"] > summary').textContent)
      && /已读取|待读取/.test(document.querySelector('[data-acc="acc-worlds"] > summary').textContent)
      && !document.querySelector('.sd-context-source-pick .sd-preset-guidance')));
    if (width === 393 && ((family === 'glass' && mode === 'light') || (family === 'editorial' && mode === 'dark'))) {
      await page.evaluate(() => { document.querySelector('[data-acc="dd-preset"]').open = false; });
      await page.locator('[data-acc="acc-presets"]').screenshot({ path: fileURLToPath(new URL(`${family}-${mode}-preset-guidance-heading-393.png`, qa)), animations: 'disabled' });
      await page.evaluate(() => { document.querySelector('[data-acc="dd-preset"]').open = true; });
    }
    const materialSelectors = ['[data-acc="dd-preset"]', '[data-acc="dd-preset"] > summary', '[data-acc="dd-preset"] .sd-preset-version-group > summary', '[data-acc="dd-preset"] label.sd-source-row', '[data-acc="blk-preset-entries"]', '[data-acc="blk-preset-entries"] > summary', '[data-acc="blk-preset-entries"] > .sd-dropdown-body', '[data-acc="blk-preset-entries"] .sd-unified-source-entry', '[data-acc="blk-preset-entries"] .sd-context-entry-label'];
    const expectedControls = [];
    for (const selector of materialSelectors) expectedControls.push(await page.locator(selector).first().evaluate(controlProbe));
    for (const tab of ['theater', 'companion', 'companion-portal']) {
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
      if (tab !== 'theater') {
        const groupStyle = await summary.evaluate(node => {
          const style = getComputedStyle(node), before = getComputedStyle(node, '::before'), after = getComputedStyle(node, '::after');
          const marker = getComputedStyle(node, '::marker'), group = node.closest('.sd-reader-preset-version-group');
          const title = getComputedStyle(node.querySelector('span')), item = getComputedStyle(group.querySelector('.sd-reader-cps-name > span'));
          return { arrowless: style.listStyleType === 'none' && marker.content === '\"\"' && [before, after].every(pseudo => pseudo.content === 'none' || pseudo.display === 'none'),
            titleFont: title.fontSize, itemFont: item.fontSize, background: getComputedStyle(group).backgroundColor, border: getComputedStyle(group).borderTopWidth };
        });
        ok(`${label}: no native or generated group arrows: ${JSON.stringify(groupStyle)}`, groupStyle.arrowless);
        ok(`${label}: group title matches list font: ${JSON.stringify(groupStyle)}`, groupStyle.titleFont === groupStyle.itemFont);
        ok(`${label}: tinted frame distinguishes grouping`, groupStyle.border === '1px' && !['rgba(0, 0, 0, 0)', 'transparent'].includes(groupStyle.background));
        const stable = await page.evaluate(async ({ family, mode }) => {
          const root = fixtureTab === 'companion-portal' ? document.getElementById('sd-reader-portal') : document.getElementById('story-director-modal');
          const summary = root.querySelector('.sd-reader-preset-version-group > summary'), before = JSON.stringify(cp);
          summary.focus(); await setAppearance(family === 'glass' ? 'editorial' : 'glass', mode === 'light' ? 'dark' : 'light'); await setAppearance(family, mode);
          return summary.isConnected && document.activeElement === summary && JSON.stringify(cp) === before;
        }, { family, mode });
        ok(`${label}: hot theme swap keeps group focus and companion selection`, stable);
      } else {
        for (let i = 0; i < materialSelectors.length; i++) {
          const selector = materialSelectors[i].replaceAll('dd-preset', 'theater-preset-picker').replaceAll('blk-preset-entries', 'theater-preset-entries');
          const actual = await page.locator(selector).first().evaluate(controlProbe);
          ok(`${label}: exact materials control style ${i}: ${JSON.stringify({ expected: expectedControls[i], actual })}`, JSON.stringify(actual) === JSON.stringify(expectedControls[i]));
        }
        ok(`${label}: directory and entries align to API field without extra label`, await page.evaluate(() => {
          const body = document.querySelector('.sd-theater-settings-body'), api = body.querySelector('.sd-theater-api-select').getBoundingClientRect();
          return ![...body.children].some(node => node.tagName === 'LABEL' && node.textContent === '预设') && ['.sd-theater-preset-picker', '[data-acc="theater-preset-entries"]'].every(selector => {
            const r = body.querySelector(selector).getBoundingClientRect(); return Math.abs(r.left - api.left) <= 1 && Math.abs(r.right - api.right) <= 1;
          });
        }));
        const entry = page.locator('.sd-theater-preset-item').first(); await entry.uncheck();
        ok(`${label}: unified entry keeps actual theater selection handler`, await page.evaluate(() => !isTheaterPresetItemSelected(theater.presetName, document.querySelector('.sd-theater-preset-item').dataset.id)));
        await entry.check();
      }
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
        await page.locator(tab === 'theater' ? '.sd-card' : '[data-fold="preset"]').first().screenshot({ path: fileURLToPath(new URL(`${tab}-matched-groups-393.png`, qa)) });
      }
    }
  }
  await page.evaluate(() => { fixtureNames.push('【照见】Claude-Versatile-5.2.0'); paint('companion'); });
  await page.locator('.sd-reader-cps-scan').click();
  ok('host-added version appears after real refresh action', await page.locator('.sd-reader-cps-toggle[data-name="【照见】Claude-Versatile-5.2.0"]').count() === 1);
  ok('no page errors', errors.length === 0); ok(`no external requests: ${externalUrls.join(', ')}`, external === 0);
  console.log(JSON.stringify({ passed: checks.length, errors, external, scope: 'Actual materials and theater cards compared; companion groups in modal and reader portal with production selection handlers; isolated settings/host reads', screenshots: ['glass-light-preset-guidance-heading-393.png', 'editorial-dark-preset-guidance-heading-393.png', 'theater-matched-groups-393.png', 'companion-matched-groups-393.png', 'companion-portal-matched-groups-393.png'] }));
} finally { clearTimeout(deadline); await browser.close(); }
