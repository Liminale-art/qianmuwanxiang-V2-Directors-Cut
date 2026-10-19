// Isolated worldbook navigation and actual panel scroll checks; no running ST,
// user files, backend, settings persistence or model requests are accessed.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { storyboardFunctionSource } from '../tests/helpers/storyboard-form-fixture.mjs';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.QIANMU_PLAYWRIGHT_MODULE || 'playwright');
const index = await readFile(new URL('../index.js', import.meta.url), 'utf8');
const css = await readFile(new URL('../style.css', import.meta.url), 'utf8') + '\n' + await readFile(new URL('../qianmu-theme-skins.css', import.meta.url), 'utf8');
const functions = ['contextWorldReadCurrent', 'invalidateContextWorldCache', 'ensureContextWorldBook', 'previewContextWorldBook', 'refreshWorldBooks',
  'getWorldNameStore', 'getWorldSelectionStore', 'getGlobalWorldBookStore', 'isWorldBookGlobal', 'setWorldBookGlobal', 'getSelectedWorldBookNames',
  'setWorldBookNameSelected', 'isWorldItemSelected', 'setWorldItemSelected', 'renderWorldBookSourcePanel', 'renderSelectedWorldBookEntries', 'renderContextEntry', 'getContextItemId', 'badge',
  'renderContextTab', 'renderDirectorSettingsTab', 'nestedScrollAtBoundary', 'bindPanelScrollStability'];
const start = index.indexOf("  root.querySelectorAll('.sd-toggle-worldbook')");
const end = index.indexOf("  root.querySelector('.sd-inject-enabled')", start);
assert.ok(start > 0 && end > start);
const source = functions.map(storyboardFunctionSource).join('\n') + `\nfunction bindWorldFixtureEvents(root) {${index.slice(start, end)}}`;
const browser = await chromium.launch({ channel: process.env.QIANMU_BROWSER_CHANNEL || undefined, headless: true });
const context = await browser.newContext({ viewport: { width: 393, height: 720 }, hasTouch: true, isMobile: true });
const page = await context.newPage(), errors = [], unexpected = [], checks = [];
const ok = (name, value) => { assert.ok(value, name); checks.push(name); };
page.on('pageerror', error => errors.push(error.message));
await page.route('**/*', async route => {
  const url = new URL(route.request().url());
  if (url.origin === 'https://context-fixture.test' && url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><div id="story-director-modal" class="open sd-theme-light"><section class="sd-window"><header class="sd-header">取材 / 幕后</header><main class="sd-body"></main></section></div>' });
  if (url.origin === 'https://context-fixture.test' && /^\/qianmu-[a-z0-9-]+\.(?:js|css)$/.test(url.pathname)) return route.fulfill({ contentType: url.pathname.endsWith('.css') ? 'text/css' : 'text/javascript', body: await readFile(new URL('..' + url.pathname, import.meta.url)) });
  unexpected.push(url.href); return route.abort();
});
try {
  await page.goto('https://context-fixture.test/'); await page.addStyleTag({ content: css });
  await page.evaluate(async source => {
    Object.assign(window, await import('/qianmu-storyboard-utils.js'));
    Object.assign(window, { contextWorldEpoch: 0, contextWorldPreviewRevision: 0, contextRefreshPromise: null, contextAutoScanned: false,
      lastWorldView: '', activeTab: 'context', accState: {}, chatKey: 'A', calls: { save: 0, read: 0, toast: 0 },
      settings: { contextOptions: { tagRules: [] }, selectedWorldBookNamesByChat: { A: { BoundA: true }, B: { BoundB: true } }, selectedWorldBookItemsByChat: {},
        globalWorldBookNames: {}, systemPrompt: 'Synthetic writing rules\n'.repeat(100), outputSchemaText: '{"synthetic":true}\n'.repeat(100) },
      contextScanCache: { presets: {}, worldBooks: {}, worldBookNames: [], boundWorldBookNames: [], worldScannedAt: '' },
      getChatKey: () => chatKey, detectBoundWorldBookNames: () => [chatKey === 'A' ? 'BoundA' : 'BoundB'],
      listWorldBooks: async () => ['BoundA', 'BoundB', 'Preview'],
      getWorldBookEntries: async name => { calls.read++; return Array.from({ length: 30 }, (_, i) => ({ uid: i, name: name + ' entry ' + i, content: 'private content ' + i })); },
      initializeSelectedContextState() {}, saveSettings() { calls.save++; }, toast() { calls.toast++; },
      maybeAutoScanContext() {}, getCharacterName: () => 'Character ' + chatKey, getPersonaName: () => 'User',
      renderTagRules: () => '<div style="height:240px">标签规则</div>', renderPresetSourcePanel: () => '<div style="height:200px">预设选择</div>',
      renderContextSelectionReview: () => '', renderInjectSections: () => '<p>注入范围</p>', renderInjectPreview: () => '',
      renderBackstageBlueprintCard: () => '<section class="sd-card" style="height:480px">当前剧本</section>',
      DEFAULT_SYSTEM_PROMPT: '', JSON_SCHEMA_TEXT: '',
    });
    (0, eval)(source);
    window.renderModal = () => {
      const body = document.querySelector('.sd-body'), previous = body.scrollTop;
      body.innerHTML = activeTab === 'context' ? `<div class="sd-cols-inner">${renderContextTab()}</div>` : renderDirectorSettingsTab();
      bindWorldFixtureEvents(document.querySelector('#story-director-modal'));
      bindPanelScrollStability(document.querySelector('#story-director-modal'));
      for (const details of body.querySelectorAll('details[data-acc]')) if (Object.hasOwn(accState, details.dataset.acc)) details.open = accState[details.dataset.acc];
      body.scrollTop = previous;
    };
    window.rerenderIfOpen = renderModal;
    renderModal(); await refreshWorldBooks(false);
  }, source);
  await page.locator('[data-acc="dd-world"] > summary').click();
  const before = await page.evaluate(() => ({ save: calls.save, selected: JSON.stringify(settings.selectedWorldBookNamesByChat), items: JSON.stringify(settings.selectedWorldBookItemsByChat) }));
  await page.locator('.sd-world-name[data-name="Preview"]').click();
  await page.waitForFunction(() => document.querySelector('[data-acc="blk-world-entries"] > summary b')?.textContent === 'Preview');
  ok('Unselected name click displays all entry labels without selecting or saving', await page.evaluate(before => document.querySelectorAll('.sd-context-check').length === 30
    && !document.querySelector('.sd-toggle-worldbook[data-name="Preview"]').checked && calls.save === before.save
    && JSON.stringify(settings.selectedWorldBookNamesByChat) === before.selected && JSON.stringify(settings.selectedWorldBookItemsByChat) === before.items, before));
  await page.evaluate(() => refreshWorldBooks(false));
  ok('Refreshing the directory retains the unselected preview', await page.locator('[data-acc="blk-world-entries"] > summary b').textContent() === 'Preview' && await page.locator('.sd-context-check').count() === 30);
  await page.evaluate(async () => { chatKey = 'B'; invalidateContextWorldCache(); renderModal(); await refreshWorldBooks(false); });
  ok('Changing chat uses its own bound view while preserving both stored selections', await page.evaluate(() => lastWorldView === ''
    && document.querySelector('[data-acc="blk-world-entries"] > summary b').textContent === 'BoundB'
    && JSON.stringify(settings.selectedWorldBookNamesByChat) === '{"A":{"BoundA":true},"B":{"BoundB":true}}'));
  // Real wheel/touch gestures over the final fold, not scrollTop-only assertions.
  const cdp = await context.newCDPSession(page);
  for (const tab of ['context', 'settings']) {
    await page.evaluate(tab => { activeTab = tab; renderModal(); }, tab);
    const finalFold = tab === 'context' ? '[data-acc="acc-worlds"]' : '[data-acc="director-law"]';
    for (let pass = 0; pass < 3; pass++) {
      await page.locator(finalFold).evaluate(node => { node.open = false; });
      await page.evaluate(() => { const body = document.querySelector('.sd-body'); body.scrollTop = body.scrollHeight; });
      await page.locator(finalFold + ' > summary').click();
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const position = await page.locator(finalFold + ' > summary').boundingBox();
      await page.mouse.move(position.x + 20, position.y + Math.min(12, position.height / 2));
      const initial = await page.evaluate(() => document.querySelector('.sd-body').scrollTop);
      await page.mouse.wheel(0, 240); await page.waitForTimeout(120);
      const afterWheel = await page.evaluate(() => document.querySelector('.sd-body').scrollTop);
      ok(`${tab} final fold ${pass + 1} accepts downward wheel after opening`, afterWheel > initial);
      await page.evaluate(() => { const body = document.querySelector('.sd-body'); body.scrollTop = 120; });
      const box = await page.locator('.sd-body').boundingBox(), x = box.x + 7, y = box.y + box.height - 60;
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
      for (let step = 1; step <= 6; step++) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y - step * 24 }] });
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await page.waitForTimeout(80);
      ok(`${tab} final fold ${pass + 1} accepts downward touch after opening`, await page.evaluate(() => document.querySelector('.sd-body').scrollTop > 120));
    }
  }
  ok('No browser errors or external network', errors.length === 0 && unexpected.length === 0);
  console.log(JSON.stringify({ passed: checks.length, checks, realST: false, externalNetwork: false, errors, unexpected }));
} finally { await context.close(); await browser.close(); }
