// Real theme sync and floating-entry drag handler, isolated DOM and text only.
// No user notes, persistence, ST navigation or production origin is accessed.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {QUICK_HIVE_THEME_PALETTES} from '../qianmu-classic-palettes.js';
import {storyboardFunctionSource as section} from '../tests/helpers/storyboard-form-fixture.mjs';
const require = createRequire(import.meta.url), {chromium} = require(process.env.QIANMU_PLAYWRIGHT_MODULE || 'playwright');
const source = await readFile(new URL('../index.js', import.meta.url), 'utf8');
const css = await readFile(new URL('../style.css', import.meta.url), 'utf8');
const paletteSource = `const QUICK_HIVE_THEME_PALETTES = ${JSON.stringify(QUICK_HIVE_THEME_PALETTES)};`;
const variablesSource = source.slice(source.indexOf('const NOTES_THEME_VARIABLES'), source.indexOf('function syncNotesTheme'));
const browser = await chromium.launch({channel: process.env.QIANMU_BROWSER_CHANNEL || undefined, headless: true});
const context = await browser.newContext(), errors = [], checks = [];
let external = 0;
await context.route('**/*', async route => {
  const url = route.request().url();
  if (url === 'https://qianmu.test/') return route.fulfill({contentType: 'text/html', body: '<!doctype html><html lang="zh-CN"><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body></body></html>'});
  if (url === 'https://qianmu.test/qianmu-notes-theme.js') return route.fulfill({contentType: 'text/javascript', body: await readFile(new URL('../qianmu-notes-theme.js', import.meta.url), 'utf8')});
  if (url.startsWith('https://qianmu.test/') && /\.(?:png|jpe?g|webp|woff2?)(?:\?|$)/.test(url)) return route.fulfill({status: 204, body: ''});
  external++; return route.abort();
});
try {
  const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
  await page.setViewportSize({width: 1280, height: 900}); await page.goto('https://qianmu.test/');
  await page.addStyleTag({content: css});
  await page.evaluate(async ({paletteSource, variablesSource, dragSource}) => {
    const {syncQianmuNotesTheme} = await import('/qianmu-notes-theme.js');
    const palettes = new Function(paletteSource + ';return QUICK_HIVE_THEME_PALETTES;')();
    const variables = new Function(variablesSource + ';return NOTES_THEME_VARIABLES;')();
    Object.assign(window, {syncQianmuNotesTheme, palettes, variables});
    document.body.innerHTML = '<main id="story-director-modal" class="sd-theme-light"></main><div id="qianmu-notes-panel-layer" class="sd-theme-light keep-editor"><section class="sd-notes-panel" style="width:580px;height:440px"><textarea class="sd-note-body">未保存的原始正文。继续输入。</textarea></section></div><div id="qianmu-notes-float-layer" class="sd-theme-light sd-hive-theme-light"><button class="sd-detached-notes-entry is-glass-dark" style="left:80px;top:90px;--sd-notes-entry-width:60px;--sd-notes-entry-height:68px">N</button></div>';
    // Real standalone note surfaces are reproduced; the source panel is hidden.
    const panel = document.querySelector('.sd-notes-panel'); panel.style.position = 'absolute'; panel.style.left = '300px'; panel.style.top = '150px';
    const textarea = panel.querySelector('textarea'); textarea.focus(); textarea.setSelectionRange(2, 7, 'backward');
    const entry = document.querySelector('.sd-detached-notes-entry');
    window.fixture = {panel, textarea, entry, noteSettings: {position: {x: 80, y: 90}, detached: true}, settingsSaves: 0, deviceSaves: 0, binds: 0};
    Object.assign(window, {clampDetachedNotesEntry: value => value, detachedNoteCanReturnHome: () => false,
      notesFeatureSettings: () => fixture.noteSettings, saveSettings: () => fixture.settingsSaves++, persistNotesDevice: () => fixture.deviceSaves++,
      renderFloatingNotes: () => {throw Error('theme switch recreated entry');}, toast(){}, openNotesPanel(){}});
    new Function(dragSource + ';window.bindFloating=bindFloatingNoteEvents;')();
    bindFloating(document.getElementById('qianmu-notes-float-layer'));
    window.recolor = (themeKey, tone = 'dark', edgeIndex = 2) => syncQianmuNotesTheme({themeKey, palette: palettes[themeKey], appearance: {tone, edgeIndex}, variables});
  }, {paletteSource, variablesSource, dragSource: section('bindFloatingNoteEvents')});
  for (const theme of ['light', 'dark', 'summer', 'candy', 'kraft', 'dream']) for (const tone of ['light', 'dark']) {
    const result = await page.evaluate(({theme, tone}) => {
      const {textarea, panel, entry} = fixture, before = {width: panel.style.width, height: panel.style.height, left: entry.style.left, top: entry.style.top};
      recolor(theme, tone);
      return {sameEditor: document.querySelector('.sd-note-body') === textarea, samePanel: document.querySelector('.sd-notes-panel') === panel,
        sameEntry: document.querySelector('.sd-detached-notes-entry') === entry, value: textarea.value, active: document.activeElement === textarea,
        selection: [textarea.selectionStart, textarea.selectionEnd, textarea.selectionDirection], geometry: before,
        after: {width: panel.style.width, height: panel.style.height, left: entry.style.left, top: entry.style.top},
        edge: entry.style.getPropertyValue('--sd-wheel-edge'), expected: palettes[theme].edges[2 % palettes[theme].edges.length],
        copiedInk: getComputedStyle(document.getElementById('qianmu-notes-panel-layer')).getPropertyValue('--sd-text').trim(),
        sourceInk: getComputedStyle(document.getElementById('story-director-modal')).getPropertyValue('--sd-text').trim(), settingsSaves: fixture.settingsSaves, deviceSaves: fixture.deviceSaves};
    }, {theme, tone});
    assert.equal(result.sameEditor && result.samePanel && result.sameEntry && result.active, true);
    assert.equal(result.value, '未保存的原始正文。继续输入。'); assert.deepEqual(result.selection, [2, 7, 'backward']);
    assert.deepEqual(result.after, result.geometry); assert.equal(result.edge, result.expected); assert.equal(result.copiedInk, result.sourceInk); assert.equal(result.settingsSaves, 0); assert.equal(result.deviceSaves, 0);
    checks.push(`${theme}/${tone}: in-place colour with text, backward selection and geometry retained`);
  }
  // Use native pointer capture; recolour in the middle of the actual drag handler.
  await page.mouse.move(110, 124); await page.mouse.down(); await page.mouse.move(160, 164);
  const before = await page.locator('.sd-detached-notes-entry').evaluate(entry => ({left: entry.style.left, top: entry.style.top, dragging: entry.classList.contains('is-dragging')}));
  assert.equal(before.dragging, true);
  await page.evaluate(() => recolor('summer'));
  await page.mouse.move(200, 194); await page.mouse.up();
  const after = await page.evaluate(() => ({same: fixture.entry === document.querySelector('.sd-detached-notes-entry'), position: fixture.noteSettings.position,
    left: fixture.entry.style.left, top: fixture.entry.style.top, dragging: fixture.entry.classList.contains('is-dragging'), settingsSaves: fixture.settingsSaves, deviceSaves: fixture.deviceSaves}));
  assert.equal(after.same, true); assert.equal(after.dragging, false); assert.equal(after.settingsSaves, 0); assert.equal(after.deviceSaves, 1);
  assert.notEqual(after.left, before.left); assert.notEqual(after.top, before.top);
  assert.equal(Number.parseFloat(after.left), after.position.x); assert.equal(Number.parseFloat(after.top), after.position.y);
  checks.push('native captured-pointer drag continues across theme change and writes device geometry once without saving account settings');
  await page.evaluate(() => {document.getElementById('story-director-modal').remove(); recolor('candy');});
  assert.equal(await page.locator('#story-director-modal').count(), 0);
  checks.push('open standalone editor resolves theme without leaving a main-panel placeholder');
  assert.equal(external, 0); assert.deepEqual(errors, []);
  console.log(JSON.stringify({passed:checks.length,checks, external, errors, productionDataRead: false,
    scope:'real theme sync and native drag handler; independent synthetic device/account save counters, not real localStorage'}));
} finally {await context.close(); await browser.close();}
