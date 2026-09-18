// Development-only full entry smoke test.
// Loads the real index.js in an isolated ST-shaped host, injects a temporary
// in-memory chat fixture, opens the actual floating entry, then restores the
// original references. No real account, provider, storage or host writer is
// used. This file is intentionally outside the release whitelist.
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.QIANMU_PLAYWRIGHT_MODULE || 'playwright');
const errors = [], external = [], calls = [];
const mime = file => file.endsWith('.css') ? 'text/css' : file.endsWith('.json') ? 'application/json' : 'text/javascript';
const server = http.createServer(async (req, res) => {
  try {
    const request = new URL(req.url || '/', 'http://127.0.0.1');
    if (request.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><html lang="zh-CN"><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="chat"></div><textarea id="send_textarea"></textarea><button id="send_but"></button><div id="send_form"></div><div id="extensions_settings"></div><div id="extensions_settings2"></div></body></html>');
      return;
    }
    if (request.pathname.startsWith('/api/')) {
      calls.push({ method: req.method, path: request.pathname });
      res.writeHead(404, { 'content-type': 'application/json' }); res.end('{"ok":false}'); return;
    }
    const relative = decodeURIComponent(request.pathname).replace(/^\/+/, '');
    const file = path.resolve(root, relative);
    if (!file.startsWith(root + path.sep)) throw new Error('path traversal');
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': `${mime(file)}; charset=utf-8` }); res.end(body);
  } catch (error) {
    res.writeHead(error?.code === 'ENOENT' ? 404 : 500); res.end('');
  }
});

await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ channel: process.env.QIANMU_BROWSER_CHANNEL || undefined, headless: true });
const context = await browser.newContext();
const page = await context.newPage();
page.setDefaultTimeout(10000);
page.on('pageerror', error => errors.push(String(error?.message || error)));
await context.route('**/*', async route => {
  const url = new URL(route.request().url());
  if (url.origin !== origin) { external.push({ method: route.request().method(), origin: url.origin }); await route.abort(); return; }
  await route.continue();
});

try {
  await page.goto(origin + '/', { waitUntil: 'domcontentloaded' });
  const result = await page.evaluate(async () => {
    const listeners = new Map();
    const eventSource = {
      on(type, handler) { const list = listeners.get(type) || []; list.push(handler); listeners.set(type, list); },
      off(type, handler) { listeners.set(type, (listeners.get(type) || []).filter(item => item !== handler)); },
      emit(type, ...args) { for (const handler of listeners.get(type) || []) void handler(...args); },
    };
    const writes = [];
    const context = {
      extensionSettings: {}, chat: [], chatMetadata: {}, characters: [], groups: [],
      name1: '测试用户', characterId: 0, chatId: 'isolated-qianmu-chat',
      eventSource, event_types: { APP_READY: 'app_ready', MESSAGE_RECEIVED: 'message_received', MESSAGE_DELETED: 'message_deleted', MESSAGE_EDITED: 'message_edited', MESSAGE_SWIPED: 'message_swiped', MESSAGE_SWIPE_DELETED: 'message_swipe_deleted', MORE_MESSAGES_LOADED: 'more_messages_loaded', CHAT_CHANGED: 'chat_changed', GROUP_UPDATED: 'group_updated', CHARACTER_SELECTED: 'character_selected', PERSONA_CHANGED: 'persona_changed' },
      getRequestHeaders: () => ({ 'X-CSRF-Token': 'isolated' }),
      saveMetadata: () => { writes.push('metadata'); },
      saveSettingsDebounced: () => { writes.push('settings'); },
      saveSettings: () => { writes.push('settings'); },
      substituteParams: text => String(text),
    };
    globalThis.SillyTavern = { getContext: () => context, libs: {} };
    globalThis.extension_settings = context.extensionSettings;
    globalThis.token = 'isolated'; globalThis.name1 = '测试用户'; globalThis.power_user = {};
    globalThis.toastr = { success() {}, info() {}, warning() {}, error() {} };
    globalThis.getRequestHeaders = context.getRequestHeaders;
    globalThis.getCurrentChatId = () => context.chatId;
    const module = await import('/index.js?isolated=1');
    await module.onActivate();
    await new Promise(resolve => setTimeout(resolve, 100));
    const button = document.getElementById('story-director-float');
    if (!button) throw new Error('full index did not render the floating entry');
    const originalChat = context.chat;
    const originalMetadata = context.chatMetadata;
    const fixtureId = 'full-entry-phase1';
    context.chat = [
      { mes: '水汽沿着窗框上升，角色A把火调小。', name: '角色A', is_user: false, extra: { qianmuTemporaryFixture: true, fixtureId, floor: 0 } },
      { mes: '角色B没有回答，只把旧瓷杯推回两人之间。', name: '角色B', is_user: false, extra: { qianmuTemporaryFixture: true, fixtureId, floor: 1 } },
      { mes: '窗外的灯影切过桌面，镜头移向未说出口的手势。', name: '角色A', is_user: false, extra: { qianmuTemporaryFixture: true, fixtureId, floor: 2 } },
    ];
    context.chatMetadata = { story_director_liminale: {
      schemaVersion: 8,
      temporary: true,
      fixtureId,
      storyboardImages: [
        { id: `${fixtureId}-image-1`, kind: 'still', status: 'succeeded', temporary: true, fixtureId, floor: 0, title: '夜班厨房', prompt: 'cinematic kitchen, steam, medium shot' },
        { id: `${fixtureId}-image-2`, kind: 'still', status: 'succeeded', temporary: true, fixtureId, floor: 1, title: '餐桌边的停顿', prompt: 'two people at a table, held silence' },
        { id: `${fixtureId}-image-3`, kind: 'still', status: 'succeeded', temporary: true, fixtureId, floor: 2, title: '电车经过之前', prompt: 'tram light across a table, insert shot' },
      ],
      storyboardCollections: [{ id: `${fixtureId}-sequence`, name: '临时连续镜头', temporary: true, fixtureId, imageIds: [`${fixtureId}-image-1`, `${fixtureId}-image-2`, `${fixtureId}-image-3`] }],
    } };
    button.click();
    await new Promise(resolve => setTimeout(resolve, 40));
    if (!document.getElementById('story-director-modal')) button.click();
    await new Promise(resolve => setTimeout(resolve, 100));
    const modal = document.getElementById('story-director-modal');
    const observed = {
      floatRendered: Boolean(button.isConnected),
      modalRendered: Boolean(modal),
      modalOpen: Boolean(modal?.classList.contains('open')),
      chatLength: context.chat.length,
      qianmuMetadataPresent: Boolean(context.chatMetadata.story_director_liminale),
      storyboardImageCount: context.chatMetadata.story_director_liminale?.storyboardImages?.length || 0,
      storyboardCollectionCount: context.chatMetadata.story_director_liminale?.storyboardCollections?.length || 0,
      storyboardMode: Boolean(modal?.classList.contains('sd-storyboard-mode')),
      title: modal?.querySelector('.sd-header h2, .sd-storyboard-body')?.textContent?.slice(0, 80) || '',
      writesBeforeCleanup: [...writes],
    };
    const storyboardShortcut = modal?.querySelector('.sd-storyboard-shortcut');
    storyboardShortcut?.click();
    await new Promise(resolve => setTimeout(resolve, 100));
    observed.storyboardMode = Boolean(modal?.classList.contains('sd-storyboard-mode'));
    observed.storyboardBody = Boolean(modal?.querySelector('.sd-storyboard-body'));
    observed.storyboardNav = Boolean(modal?.querySelector('.sd-storyboard-nav'));
    observed.storyboardFixtureStillReadable = context.chat.length === 3
      && context.chatMetadata.story_director_liminale?.storyboardImages?.length === 3
      && context.chatMetadata.story_director_liminale?.storyboardCollections?.[0]?.imageIds?.length === 3;
    context.chat = originalChat;
    context.chatMetadata = originalMetadata;
    await module.onDisable();
    return { observed, restored: context.chat === originalChat && context.chatMetadata === originalMetadata, writesAfterCleanup: writes, floatAfterDisable: Boolean(document.getElementById('story-director-float')), modalAfterDisable: Boolean(document.getElementById('story-director-modal')) };
  });
  assert.equal(result.observed.floatRendered, true);
  assert.equal(result.observed.modalRendered, true);
  assert.equal(result.observed.modalOpen, true);
  assert.equal(result.observed.chatLength, 3);
  assert.equal(result.observed.qianmuMetadataPresent, true);
  assert.equal(result.observed.storyboardImageCount, 3);
  assert.equal(result.observed.storyboardCollectionCount, 1);
  assert.equal(result.observed.storyboardMode, true);
  assert.equal(result.observed.storyboardBody, true);
  assert.equal(result.observed.storyboardNav, true);
  assert.equal(result.observed.storyboardFixtureStillReadable, true);
  assert.equal(result.restored, true);
  assert.equal(result.floatAfterDisable, false);
  assert.equal(result.modalAfterDisable, false);
  assert.equal(external.length, 0);
  assert.equal(errors.length, 0, errors.join('; '));
  console.log(JSON.stringify({ ...result, external, errors, apiCalls: calls, productionWrites: false, realEntry: true, temporaryFixture: true }));
} finally {
  await page.close().catch(() => {});
  await context.close().catch(() => {});
  await browser.close().catch(() => {});
  await new Promise(resolve => server.close(resolve));
}
