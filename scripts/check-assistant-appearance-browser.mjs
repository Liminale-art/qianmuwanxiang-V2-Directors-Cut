// Actual API card and assistant panel; isolated storage/transport, no live ST.
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { storyboardFunctionSource } from '../tests/helpers/storyboard-form-fixture.mjs';
const require = createRequire(import.meta.url), { chromium } = require(process.env.QIANMU_PLAYWRIGHT_MODULE || 'playwright');
const probeOnly = process.argv.includes('--probe');
const css = (await Promise.all(['style.css', 'qianmu-theme-skins.css', 'qianmu-prose-assistant.css'].map(file => readFile(new URL('../' + file, import.meta.url), 'utf8')))).join('\n');
const browser = await chromium.launch({ channel: process.env.QIANMU_BROWSER_CHANNEL || undefined, headless: true });
const context = await browser.newContext(), page = await context.newPage(), errors = [], checks = [];
const timer = setTimeout(() => void browser.close(), 120000);
const qa = new URL('../dist/local-qa/assistant-appearance/', import.meta.url); await mkdir(qa, { recursive: true });
let external = 0;
page.on('pageerror', error => errors.push(error.message));
await context.route('**/*', async route => {
  const url = new URL(route.request().url());
  if (url.origin === 'https://qianmu.test') {
    if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><style>body{margin:0;font-size:20px}#story-director-modal{position:absolute!important;display:block!important;left:-9999px!important;top:0!important;width:350px!important;height:800px!important}.sd-window{display:block!important}#host-control{font-size:20px;height:48px}</style><input id="host-control"><div id="story-director-modal" class="open sd-theme-light"><div class="sd-window"><main class="sd-body"></main></div></div><section data-qm-prose-assistant-portal></section>` });
    if (/^\/qianmu-[a-z0-9-]+\.(js|css)$/.test(url.pathname)) return route.fulfill({ contentType: url.pathname.endsWith('.css') ? 'text/css' : 'text/javascript', body: await readFile(new URL('..' + url.pathname, import.meta.url), 'utf8') });
    if (url.pathname === '/favicon.ico') return route.fulfill({ status: 204 });
  }
  external++; return route.abort();
});
const ok = (name, value) => { assert.ok(value, name); checks.push(name); };
try {
  await page.goto('https://qianmu.test/');
  await page.evaluate(async source => {
    const [{ openProseAssistantPanel }, { createQianmuAppearanceSession }, { updateAppearancePreferences }, utils, { applyQianmuIcons }, { createProseAssistantConversationList }] = await Promise.all([
      import('/qianmu-prose-assistant-panel.js'), import('/qianmu-appearance-session.js'), import('/qianmu-appearance-settings.js'), import('/qianmu-storyboard-utils.js'), import('/qianmu-icon-renderer.js'), import('/qianmu-prose-assistant-conversation-list.js')]);
    window.paintConversationList = () => {
      const dialog = document.querySelector('.qm-prose-assistant-dialog');
      const view = createProseAssistantConversationList({ document, onOpen: () => {}, onNew: () => {}, onDelete: () => {}, onRefresh: () => {}, onRename: async () => {} });
      dialog.querySelector('main').hidden = true; dialog.querySelector('footer').hidden = true; dialog.append(view.element);
      view.render({ entries: [{ key: 'one', title: '一段较长的对话标题用于核对字号与截断', updatedAt: 1 }, { key: 'two', title: '旧案讨论', updatedAt: 2 }], currentKey: 'one', busy: false });
      window.removeConversationList = () => { view.dispose(); view.element.remove(); dialog.querySelector('main').hidden = false; dialog.querySelector('footer').hidden = false; };
    };
    Object.assign(window, utils, { settings: { theme: 'light', providerMode: 'external', apiProfiles: [], availableModels: ['fixture-model'], model: 'fixture-model', apiUrl: '', apiKey: '', temperature: .8, maxOutputTokens: 1000, contextBudget: 3000, logHistory: [] }, LOG_LIMIT: 10, FLOAT_SIZE_MIN: 32, FLOAT_SIZE_MAX: 80, feedbackOpenScope: null, getFloatSize: () => 40, renderQuickWheelSettings: () => '', renderStorageManagementCard: () => '' });
    (0, eval)(source);
    const root = document.querySelector('#story-director-modal'), portal = document.querySelector('[data-qm-prose-assistant-portal]');
    portal.style.setProperty('--qm-pa-prose-size', '24px'); portal.style.setProperty('--sd-prose-font-size', '24px');
    window.appearance = createQianmuAppearanceSession({ readSettings: () => settings, loadStyles: () => ({ promise: Promise.resolve(true), cancel() {} }), loadFont: () => ({ promise: Promise.resolve(true), cancel() {} }) });
    appearance.mount(root); appearance.mountPortal(portal, { inheritTheme: true });
    window.sent = 0; window.saved = 0;
    const host = { chatId: 'fixture', characterId: 0, characters: [{ name: '角色', avatar: 'fixture.png', chat: 'fixture' }], chatMetadata: {}, chat: [{ mes: '隔离正文' }] };
    window.paint = async (family, mode) => {
      window.panel?.dispose(); settings.theme = mode; root.className = 'open sd-theme-' + mode;
      settings.appearance = updateAppearancePreferences(settings, { family, mode }); await appearance.sync();
      root.querySelector('.sd-body').innerHTML = renderPlugTab(); applyQianmuIcons(root);
      window.panel = await openProseAssistantPanel({ parent: portal, source: { getContext: () => host, epoch: () => 0, resolveNamespace: async () => 'st-user:appearance-fixture', isCurrent: () => true, readText: message => message.mes },
        isCurrent: () => true, profiles: [], referenceFloors: 3, selection: { mode: 'custom', connection: { apiUrl: 'https://fixture.invalid/v1', apiKey: '', model: 'fixture-model', stream: false } },
        preferences: { current: () => settings, persist: () => { saved++; } }, applyIcons: applyQianmuIcons, copy: async () => {}, confirm: async () => false, getRequestHeaders: () => ({}),
        fetchImpl: async () => { sent++; return new Response(JSON.stringify({ choices: [{ message: { content: '这是一段隔离回复，用于核对正文与操作栏。' }, finish_reason: 'stop' }] }), { headers: { 'content-type': 'application/json' } }); },
      }); await panel.ready;
    };
    window.measure = node => { const s = getComputedStyle(node); return Object.fromEntries(['fontSize','lineHeight','minHeight','height','width','paddingTop','paddingBottom','paddingLeft','paddingRight','borderTopWidth','borderRadius'].map(key => [key,s[key]])); };
  }, storyboardFunctionSource('renderPlugTab'));
  for (const family of ['classic', 'editorial', 'glass']) for (const mode of ['light', 'dark']) for (const width of [320, 393, 1100]) {
    const label = `${family}/${mode}/${width}`;
    await page.setViewportSize({ width, height: 900 }); await page.evaluate(async ({ family, mode }) => paint(family, mode), { family, mode });
    await page.locator('[data-pa-action="settings"]').click();
    const metrics = await page.evaluate(() => ({ ref: { title: measure(document.querySelector('.sd-model-config h3')), label: measure(document.querySelector('.sd-model-config > label')), field: measure(document.querySelector('.sd-api-url')), button: measure(document.querySelector('.sd-save-api')), icon: measure(document.querySelector('.sd-delete-api-profile')), glyph: measure(document.querySelector('.sd-delete-api-profile svg')) }, own: { title: measure(document.querySelector('.qm-prose-assistant-dialog > header strong')), label: measure(document.querySelector('.qm-pa-config label > span')), field: measure(document.querySelector('[aria-label="助手API地址"]')), icon: measure(document.querySelector('[data-pa-action="settings"]')), glyph: measure(document.querySelector('[data-pa-action="settings"] svg')) } }));
    if (probeOnly) { if (mode === 'light' && width !== 393) console.log(JSON.stringify({ label, metrics })); continue; }
    ok(label + ' title/labels/fields match API typography: ' + JSON.stringify(metrics), ['title','label','field'].every(key => metrics.own[key].fontSize === metrics.ref[key].fontSize));
    ok(label + ' field heights and padding match API inputs', ['height','paddingTop','paddingBottom','paddingLeft','paddingRight'].every(key => metrics.own.field[key] === metrics.ref.field[key]));
    ok(label + ' action icons share API control/glyph dimensions', ['height','width'].every(key => metrics.own.icon[key] === metrics.ref.icon[key] && metrics.own.glyph[key] === metrics.ref.glyph[key]));
    ok(label + ' settings fit window without clipped controls', await page.locator('.qm-prose-assistant-dialog,[data-pa-settings],.qm-pa-config,.qm-pa-key').evaluateAll(nodes => nodes.every(node => node.scrollWidth <= node.clientWidth + 1)));
    const key = page.getByLabel('助手API Key'); await key.fill('fixture-only'); await page.locator('[data-pa-action="eye"]').click(); ok(label + ' key visibility remains functional', await key.getAttribute('type') === 'text'); await page.locator('[data-pa-action="eye"]').click();
    await page.getByLabel('参考楼层数').fill('2'); await page.waitForFunction(() => settings.proseAssistant?.referenceFloors === 2);
    ok(label + ' no settings action sends model requests', await page.evaluate(() => sent === 0));
    if (family === 'glass' && width === 393) await page.locator('.qm-prose-assistant-dialog').screenshot({ path: fileURLToPath(new URL(`${family}-${mode}-settings.png`, qa)), animations: 'disabled' });
    await page.locator('[data-pa-action="back"]').click();
    ok(label + ' prose and composer use API body size despite host 24px override', await page.locator('.qm-pa-composer,[data-pa-question]').evaluateAll(nodes => nodes.every(node => getComputedStyle(node).fontSize === getComputedStyle(document.querySelector('.sd-api-url')).fontSize)));
    const composer = await page.locator('.qm-pa-composer').evaluate(node => { const input = node.querySelector('textarea').getBoundingClientRect(), send = node.querySelector('button').getBoundingClientRect(); return Math.abs(input.height-send.height)<1 && input.right<=send.left && node.scrollWidth<=node.clientWidth+1; }); ok(label + ' composer controls align without overflow', composer);
    ok(label + ' host control remains unmodified', await page.locator('#host-control').evaluate(node => getComputedStyle(node).fontSize === '20px' && getComputedStyle(node).height === '48px'));
    await page.evaluate(() => paintConversationList());
    ok(label + ' conversation list body, metadata and search follow API scale', await page.evaluate(() => {
      const input = getComputedStyle(document.querySelector('.qm-pa-conversation-toolbar input')), reference = getComputedStyle(document.querySelector('.sd-api-url'));
      return input.fontSize === reference.fontSize && input.height === reference.height && getComputedStyle(document.querySelector('.qm-pa-conversation-title')).fontSize === reference.fontSize && getComputedStyle(document.querySelector('.qm-pa-conversation-meta')).fontSize === getComputedStyle(document.querySelector('.sd-model-config > label')).fontSize;
    }));
    ok(label + ' list search/actions and rows stay within the narrow panel', await page.locator('.qm-pa-conversation-toolbar,.qm-pa-conversation-item').evaluateAll(nodes => nodes.every(node => node.scrollWidth <= node.clientWidth + 1)));
    await page.locator('[data-pa-list-action="rename"]').first().click();
    ok(label + ' inline rename keeps matched field height and icon size', await page.locator('.qm-pa-conversation-edit input').evaluate(node => getComputedStyle(node).height === getComputedStyle(document.querySelector('.sd-api-url')).height));
    if (family === 'glass' && width === 393) await page.locator('.qm-prose-assistant-dialog').screenshot({ path: fileURLToPath(new URL(`${family}-${mode}-conversation-list.png`, qa)), animations: 'disabled' });
    await page.evaluate(() => removeConversationList());
  }
  if (!probeOnly) {
    await page.locator('[data-pa-question]').fill('隔离字号检查'); await page.locator('[data-pa-action="send"]').click(); await page.waitForFunction(() => document.querySelector('.qm-prose-assistant-dialog')?.getAttribute('aria-busy') === 'false');
    ok('actual transcript and edit fields use API body typography', await page.locator('.qm-pa-user,.qm-pa-reply').evaluateAll(nodes => nodes.length >= 2 && nodes.every(node => getComputedStyle(node).fontSize === getComputedStyle(document.querySelector('.sd-api-url')).fontSize)));
    await page.locator('[data-pa-action="edit"]').first().click();
    ok('reply editing retains matched font size', await page.locator('.qm-pa-edit textarea').evaluate(node => getComputedStyle(node).fontSize === getComputedStyle(document.querySelector('.sd-api-url')).fontSize));
    await page.locator('[data-pa-action="cancel-reply"]').click();
    await page.locator('.qm-prose-assistant-dialog').screenshot({ path: fileURLToPath(new URL('glass-dark-chat.png', qa)), animations: 'disabled' });
  }
  await page.evaluate(() => { panel.dispose(); appearance.reset(); }); assert.deepEqual(errors, []); assert.equal(external, 0);
  console.log(JSON.stringify({ passed: checks.length, errors, external, scope: 'actual API/assistant renderers; only synthetic conversation and model response' }));
} finally { clearTimeout(timer); await context.close(); await browser.close(); }
