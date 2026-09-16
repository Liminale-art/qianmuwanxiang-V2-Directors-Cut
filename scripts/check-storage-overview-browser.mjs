// Real storage renderer and stylesheet, isolated accounting fixtures only.
// This never reads a user's database or executes a backup / cleanup operation.
import assert from 'node:assert/strict';
import {mkdir, readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {join} from 'node:path';
import vm from 'node:vm';
import {renderStorageBackupSection} from '../qianmu-storage-backup-view.js';
import {storyboardFunctionSource as section} from '../tests/helpers/storyboard-form-fixture.mjs';

const require = createRequire(import.meta.url);
const {chromium} = require(process.env.QIANMU_PLAYWRIGHT_MODULE || 'playwright');
const source = await readFile(new URL('../index.js', import.meta.url), 'utf8');
const css = await readFile(new URL('../style.css', import.meta.url), 'utf8');
const constants = source.slice(source.indexOf('const STORAGE_CATEGORY_LABELS'), source.indexOf('function renderStorageManagementCard'));
const MB = 1024 * 1024;
const snapshot = {sampledAt: 1, origin: {available: true, usage: 500 * MB, quota: 2000 * MB}, trackedBytes: 400 * MB, manageableBytes: 400 * MB,
  categories: [{category: 'images', bytes: 240 * MB}, {category: 'audio', bytes: 120 * MB}, {category: 'reader', bytes: 40 * MB}],
  idb: {chatScopes: ['fixture']}, vibeStorage: {status: 'ready', assets: {count: 0, bytes: 0}, previews: {bytes: 0}, records: {count: 0, bytes: 0}, metadata: {bytes: 0}},
  restoreStorage: {status: 'ready', count: 0, bytes: 0}, mappingStorage: {status: 'ready', count: 0, bytes: 0}, carrierStorage: {status: 'ready', count: 0, bytes: 0},
  characterStorage: {status: 'ready', documents: {count: 0, bytes: 0}, bindings: {count: 0, bytes: 0}, indexes: {bytes: 0}},
  comfyStorage: {status: 'ready'}, focusLibrary: {status: 'ready', bytes: 0, count: 0}};
function render(data = snapshot, status = 'ready') {
  const state = vm.createContext({renderStorageBackupSection, storageInventoryState: {data, status, error: 'fixture inventory unavailable'},
    htmlEscape: value => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;'),
    formatStorageBytes: bytes => `${((Number(bytes) || 0) / MB).toFixed(1)} MB`, blobStore: {classifyStoragePressure: () => ({level: 'normal'})}});
  vm.runInContext(constants + section('renderStorageManagementCard'), state);
  return state.renderStorageManagementCard();
}

const browser = await chromium.launch({channel: process.env.QIANMU_BROWSER_CHANNEL || undefined, headless: true});
const context = await browser.newContext(), errors = [], checks = [];
let external = 0;
await context.route('**/*', async route => {
  const url = route.request().url();
  if (url === 'https://qianmu.test/') return route.fulfill({contentType: 'text/html', body: '<!doctype html><html lang="zh-CN"><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body></body></html>'});
  if (url === 'https://qianmu.test/qianmu-icon-renderer.js') return route.fulfill({contentType: 'text/javascript', body: await readFile(new URL('../qianmu-icon-renderer.js', import.meta.url), 'utf8')});
  // Stylesheet background art does not belong to the storage renderer under test.
  if (url.startsWith('https://qianmu.test/') && /\.(?:png|jpe?g|webp|woff2?)(?:\?|$)/.test(url)) return route.fulfill({status: 204, body: ''});
  external++; return route.abort();
});
try {
  const page = await context.newPage();
  if (process.env.QIANMU_STORAGE_SCREENSHOT_DIR) await mkdir(process.env.QIANMU_STORAGE_SCREENSHOT_DIR, {recursive: true});
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('https://qianmu.test/');
  await page.addStyleTag({content: css});
  await page.addStyleTag({content: 'body{margin:0;background:#555}#story-director-modal{box-sizing:border-box}#story-director-modal .sd-storage-card{width:min(620px,100%);box-sizing:border-box;margin:0 auto}'});
  for (const width of [320, 393, 768, 1280]) for (const theme of ['light', 'dark', 'summer', 'candy', 'kraft', 'dream']) {
    await page.setViewportSize({width, height: 898});
    const metrics = await page.evaluate(async ({html, theme}) => {
      document.body.innerHTML = `<div id="story-director-modal" class="open sd-theme-${theme}"><div class="sd-backdrop"></div><section class="sd-window"><main class="sd-body">${html}</main></section></div>`;
      const root = document.getElementById('story-director-modal');
      (await import('/qianmu-icon-renderer.js')).applyQianmuIcons(root);
      const hero = root.querySelector('.sd-storage-hero b'), legend = root.querySelector('.sd-storage-legend');
      const rows = [...legend.children].map(row => row.getBoundingClientRect());
      const buttons = [...root.querySelectorAll('.sd-storage-manage-actions button')].map(button => button.getBoundingClientRect());
      return {overflow: root.scrollWidth > root.clientWidth || document.documentElement.scrollWidth > innerWidth,
        heroSize: parseFloat(getComputedStyle(hero).fontSize), heroText: hero.textContent,
        rowsAligned: rows.every(row => Math.abs(row.left - rows[0].left) < 1 && Math.abs(row.right - rows[0].right) < 1),
        minRowHeight: Math.min(...rows.map(row => row.height)), minButtonHeight: Math.min(...buttons.map(row => row.height)),
        icons: [...root.querySelectorAll('.fa-arrow-right svg')].map(svg => svg.getAttribute('data-qm-glyph')),
        backups: root.querySelectorAll('.sd-storage-backup-section').length, expanded: root.querySelectorAll('details[open]').length};
    }, {html: render(), theme});
    assert.equal(metrics.overflow, false, `${theme}/${width} overflows`);
    assert.ok(metrics.heroSize >= 30, `${theme}/${width}: hero ${metrics.heroSize}px`);
    assert.equal(metrics.heroText, '400.0 MB');
    assert.equal(metrics.rowsAligned, true); assert.ok(metrics.minRowHeight >= 41); assert.ok(metrics.minButtonHeight >= 44);
    assert.deepEqual(metrics.icons, Array(4).fill('qm-regular-arrow-right')); assert.equal(metrics.backups, 1); assert.equal(metrics.expanded, 0);
    if (process.env.QIANMU_STORAGE_SCREENSHOT_DIR && ((width === 393 && theme === 'dark') || (width === 1280 && theme === 'light'))) {
      await page.screenshot({path: join(process.env.QIANMU_STORAGE_SCREENSHOT_DIR, `storage-real-renderer-${theme}-${width}.png`), fullPage: true});
    }
    await page.locator('.sd-storage-backup-section summary').click();
    assert.equal(await page.locator('.sd-storage-backup-section').getAttribute('open'), '');
    await page.locator('.sd-storage-details summary').click();
    assert.equal(await page.locator('.sd-storage-details').getAttribute('open'), '');
    checks.push(`${theme}/${width}: real renderer layout, local arrows, disclosures`);
  }
  for (const status of ['loading', 'error']) {
    await page.evaluate(html => {document.querySelector('#story-director-modal .sd-body').innerHTML = html;}, render(null, status));
    assert.equal(await page.locator('.sd-storage-hero').count(), 0);
    assert.equal(await page.locator('.sd-storage-backup-section').count(), 1);
    assert.equal(await page.locator('.sd-storage-clean').count(), 0);
    checks.push(`${status}: no fake total or cleanup, backup remains available`);
  }
  assert.equal(external, 0); assert.deepEqual(errors, []);
  console.log(JSON.stringify({checks, external, errors, productionDataRead: false}));
} finally {await context.close(); await browser.close();}
