// Actual notes portal/binders + native IndexedDB, isolated account and no HTTP sync transport.
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
const names = ['notesFeatureSettings', 'persistNotesDevice', 'notesSyncControls', 'notesFeatureEnabled', 'notesSortRuntime', 'notesFind', 'notesReplaceLocal',
  'hydrateNotesRuntime', 'persistNoteRuntime', 'scheduleNoteSave', 'openNotesPanel', 'closeNotesPanel', 'noteExcerpt', 'noteUpdatedLabel', 'renderNotesPanel',
  'notesPanelUsesCompactLayout', 'clampNotesPanelSize', 'stopNotesPanelResizeTracking', 'syncNotesPanelSizeToViewport', 'bindNotesPanelResize', 'renderNotesPanelPortal', 'bindNotesPanelEvents'];
try {
  await page.goto('https://qianmu.test/');
  await page.addStyleTag({ content: await readFile(new URL('../style.css', import.meta.url), 'utf8') });
  await page.evaluate(async source => {
    for (const file of ['qianmu-notes', 'qianmu-notes-panel-sync', 'qianmu-notes-device', 'qianmu-input-boundary']) Object.assign(window, await import(`./${file}.js`));
    const configure = configureQianmuNotes, { createNotesSyncRuntime } = await import('./qianmu-notes-sync-runtime.js');
    window.configureQianmuNotes = options => configure({ ...options, createRuntime: input => createNotesSyncRuntime({ ...input, client: null }) });
    const notes = { enabled: true, detached: false, position: { x: 15, y: 40 }, panelSize: { width: 430, height: 420 }, editorFontSize: 13, appearance: { tone: 'dark', edgeIndex: 0 } };
    Object.assign(window, { notesSyncPanel: null, notesDevice: null, notesViewEpoch: 0, notesReadEpoch: 0, notesSaveTimers: new Map(), notesPanelOpen: false, notesLoaded: false,
      notesLoading: null, notesRuntime: [], notesActiveId: '', notesSearch: '', notesZCounter: 1, notesPanelResizeObserver: null,
      settings: { enabled: true, notes: structuredClone(notes) }, DEFAULT_SETTINGS: { notes }, NOTES_EDITOR_FONT_SIZES: [13, 14, 16, 18, 20, 24],
      MODULE_NAME: 'fixture', NOTES_PANEL_LAYER_ID: 'qianmu-notes-panel-layer', fixture: { notices: [], downloads: [], settingsSaves: 0, confirm: true },
      clone: structuredClone, isPlainObject: value => value && typeof value === 'object',
      mergeDefaults: (target, defaults) => { for (const [key, value] of Object.entries(defaults)) if (target[key] === undefined) target[key] = structuredClone(value); },
      featureRuntime: { load: async () => ({ resolveImageAccountNamespace: async () => 'st-user:fixture-ui' }) }, storyboardRequestHeaders: () => ({}),
      toast: (...args) => fixture.notices.push(args), confirmDialog: async () => fixture.confirm, ttsDownloadBlob: (blob, name) => fixture.downloads.push({ blob, name }),
      coreadCopyText: async () => {}, saveSettings: () => fixture.settingsSaves++, renderFloatingNotes() {}, closeQuickWheel() {}, applyQianmuIcons() {},
      syncNotesTheme() { mountQianmuInputBoundary(document.getElementById(NOTES_PANEL_LAYER_ID)); },
      htmlEscape: value => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;'),
    });
    new Function(source + ';Object.assign(window,{' + source.match(/(?:async )?function (\w+)\(/g).map(match => match.match(/function (\w+)/)[1]).join(',') + '});')();
    fixture.hostKeys = 0;
    document.addEventListener('keydown', () => fixture.hostKeys++);
    openNotesPanel();
  }, names.map(section).join('\n'));
  await page.waitForFunction(() => notesLoaded);
  await page.locator('.sd-note-new').click();
  await page.locator('.sd-note-body').fill('第一条未固定便笺');
  await page.waitForFunction(() => notesSaveTimers.size === 0);
  let result = await page.evaluate(async () => ({ notes: await listQianmuNotes(), editor: document.querySelector('.sd-note-body').value }));
  assert.equal(result.notes.length, 1); assert.equal(result.notes[0].pinned, false); assert.equal(result.notes[0].body, result.editor);
  checks.push('actual create/editor input persists an unpinned original to native IndexedDB');
  assert.equal(await page.locator('.sd-note-sync-retry,.sd-note-sync-now').count(), 0, 'routine persistence does not require manual sync controls');
  await page.locator('.sd-note-body').press('Control+Enter');
  assert.equal(await page.evaluate(() => fixture.hostKeys), 0);
  assert.equal(await page.evaluate(() => document.activeElement.classList.contains('sd-note-body')), true);
  checks.push('the shared input boundary retains the notes editor and keeps modifier hotkeys away from the host');
  await page.evaluate(async () => {
    const input = document.querySelector('.sd-note-body'); input.focus(); input.setSelectionRange(2, 5, 'backward'); fixture.input = input;
    await notesSyncControls().sync();
  });
  result = await page.evaluate(() => ({ same: fixture.input === document.querySelector('.sd-note-body'), focus: fixture.input === document.activeElement, selection: [fixture.input.selectionStart, fixture.input.selectionEnd, fixture.input.selectionDirection] }));
  assert.equal(result.same && result.focus, true); assert.deepEqual(result.selection, [2, 5, 'backward']);
  checks.push('background sync/read preserves the exact focused editor and backward selection');
  await page.evaluate(() => { const input = document.querySelector('.sd-note-body'); for (let i = 1; i <= 12; i++) { input.value = 'rapid-' + i; input.dispatchEvent(new Event('input', { bubbles: true })); } });
  await page.waitForFunction(() => notesSaveTimers.size === 0);
  assert.equal(await page.evaluate(async () => (await listQianmuNotes())[0].body), 'rapid-12');
  checks.push('twelve immediate queued inputs retain only the latest body without losing revision continuity');
  await page.evaluate(() => { fixture.put = IDBObjectStore.prototype.put; IDBObjectStore.prototype.put = function (...args) { if (this.name === 'accounts') throw new DOMException('synthetic full', 'QuotaExceededError'); return fixture.put.apply(this, args); }; });
  await page.locator('.sd-note-body').fill('保存失败也不能丢掉的最后正文');
  await page.waitForFunction(() => document.querySelector('.sd-notes-sync-status').textContent.includes('保存未完成'));
  assert.equal(await page.locator('.sd-note-body').inputValue(), '保存失败也不能丢掉的最后正文');
  assert.ok(await page.evaluate(() => notesSaveTimers.size > 0), 'a failed draft must remain pending, not be announced as saved');
  await page.evaluate(() => { IDBObjectStore.prototype.put = fixture.put; window.dispatchEvent(new Event('online')); });
  await page.waitForFunction(() => notesSaveTimers.size === 0);
  assert.equal(await page.evaluate(async () => (await listQianmuNotes())[0].body), '保存失败也不能丢掉的最后正文');
  checks.push('quota failure keeps the editor and pending draft, shows honest status, and the automatic online wake durably recovers without a sync button');
  await page.locator('.sd-notes-list').click();
  await page.locator('.sd-note-tools-toggle').click(); await page.locator('.sd-note-pin').click();
  await page.waitForFunction(async () => (await listQianmuNotes())[0].pinned);
  await page.locator('.sd-note-tools-toggle').click(); await page.locator('.sd-note-pin').click();
  await page.waitForFunction(async () => !(await listQianmuNotes())[0].pinned);
  assert.equal((await page.evaluate(() => listQianmuNotes())).length, 1);
  checks.push('pin/unpin controls prominence only and leaves the original durable');
  await page.locator('.sd-note-select').click();
  await page.evaluate(async () => {
    document.querySelector('.sd-note-body').blur();
    const { createNotesSyncRuntime } = await import('./qianmu-notes-sync-runtime.js');
    const other = createNotesSyncRuntime({ namespace: 'st-user:fixture-ui' });
    const note = (await other.list())[0]; await other.save({ ...note, body: '另一页面的新版本' }); other.close();
    await hydrateNotesRuntime(true);
  });
  await page.locator('.sd-note-body').fill('接着另一页面的新版本继续编辑');
  await page.waitForFunction(() => notesSaveTimers.size === 0);
  result = await page.evaluate(() => listQianmuNotes());
  assert.equal(result.length, 1); assert.equal(result[0].body, '接着另一页面的新版本继续编辑');
  checks.push('unfocused refresh keeps the input closure on the updated note object and baseline');
  await page.evaluate(async () => {
    document.querySelector('.sd-note-body').blur(); await notesSyncControls().sync();
    fixture.realList = window.listQianmuNotes;
    window.listQianmuNotes = async () => { const old = await fixture.realList(); await new Promise(resolve => { fixture.releaseRead = resolve; }); return old; };
    fixture.refresh = hydrateNotesRuntime(true);
  });
  await page.waitForFunction(() => typeof fixture.releaseRead === 'function');
  await page.locator('.sd-note-body').fill('旧读取晚到也不能回退已保存的正文');
  await page.waitForFunction(() => notesSaveTimers.size === 0);
  await page.evaluate(async () => { document.querySelector('.sd-note-body').blur(); window.listQianmuNotes = fixture.realList; fixture.releaseRead(); await fixture.refresh; });
  assert.equal(await page.locator('.sd-note-body').inputValue(), '旧读取晚到也不能回退已保存的正文');
  assert.equal(await page.evaluate(() => notesRuntime[0].body), '旧读取晚到也不能回退已保存的正文');
  checks.push('delayed old read cannot revert an already acknowledged edit after blur');
  for (const width of [320, 393, 1280]) {
    await page.setViewportSize({ width, height: 850 });
    const layout = await page.locator('.sd-notes-panel').evaluate(panel => ({ width: panel.getBoundingClientRect().width, scroll: panel.scrollWidth, client: panel.clientWidth }));
    assert.ok(layout.width <= width); assert.ok(layout.scroll <= layout.client + 1); checks.push(`${width}: actual notes panel and sync strip fit without horizontal overflow`);
  }
  result = await page.evaluate(() => { notesFeatureSettings(); return { serialized: JSON.stringify(settings.notes), device: readNotesDeviceState() }; });
  assert.doesNotMatch(result.serialized, /panelSize|position|detached/); assert.equal(result.device.position.x, 15);
  checks.push('device geometry is present locally and excluded from enumerable ST account settings');
  await page.locator('.sd-notes-list').click();
  await page.locator('.sd-note-tools-toggle').click(); await page.evaluate(() => { fixture.confirm = false; });
  await page.locator('.sd-note-delete').click(); assert.equal((await page.evaluate(() => listQianmuNotes())).length, 1);
  await page.evaluate(() => { fixture.confirm = true; }); await page.locator('.sd-note-tools-toggle').click(); await page.locator('.sd-note-delete').click();
  await page.waitForFunction(async () => (await listQianmuNotes()).length === 0);
  checks.push('deletion needs explicit confirmation and does not resurrect through old input timers');
  await page.waitForFunction(() => !notesLoading && !document.querySelector('.sd-note-list-item'));
  await page.evaluate(() => {
    fixture.realList = window.listQianmuNotes;
    window.listQianmuNotes = async () => {
      await new Promise(resolve => { fixture.startRead = resolve; });
      const snapshot = await fixture.realList();
      await new Promise(resolve => { fixture.finishRead = resolve; }); return snapshot;
    };
    fixture.refresh = hydrateNotesRuntime(true);
    fixture.afterOldRead = fixture.refresh.then(() => { fixture.oldReadIds = notesRuntime.map(note => note.id); });
  });
  await page.waitForFunction(() => typeof fixture.startRead === 'function');
  await page.locator('.sd-note-new').click();
  await page.evaluate(() => fixture.startRead());
  await page.waitForFunction(() => typeof fixture.finishRead === 'function');
  await page.locator('.sd-notes-list').click(); await page.locator('.sd-note-tools-toggle').click(); await page.locator('.sd-note-delete').click();
  await page.waitForFunction(async () => (await fixture.realList()).length === 0 && notesRuntime.length === 0);
  await page.evaluate(async () => { window.listQianmuNotes = fixture.realList; fixture.finishRead(); await fixture.afterOldRead; });
  assert.deepEqual(await page.evaluate(() => fixture.oldReadIds), []);
  await page.waitForFunction(() => !notesLoading && !document.querySelector('.sd-note-list-item'));
  checks.push('create then delete during an older read never briefly reintroduces the deleted note');
  await page.evaluate(async () => { closeNotesPanel(); notesSyncPanel?.dispose(); await clearTemporaryQianmuNotes(); });
  assert.deepEqual(errors, []); assert.equal(external, 0);
  console.log(JSON.stringify({ passed: checks.length, checks, errors, external, scope: 'real UI/local persistence only; no network transport, production data or deployed ST' }));
} finally { await context.close(); await browser.close(); }
