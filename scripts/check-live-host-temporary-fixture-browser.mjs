// Development-only live-page fixture probe.
// Connects only to an explicitly supplied CDP browser, opens a new page,
// replaces chat references in memory, verifies the loaded Qianmu entry, then
// restores the exact references and closes only that new page. No login,
// persistence, generation or provider request is allowed.
import { createRequire } from 'node:module';

const target = String(process.env.QIANMU_ST_URL || '').trim();
if (!target) throw new Error('QIANMU_ST_URL is required; refusing to guess a host');
if (process.env.QIANMU_TEMP_FIXTURE_CONFIRM !== '1') {
  throw new Error('Set QIANMU_TEMP_FIXTURE_CONFIRM=1 to acknowledge the in-memory fixture probe');
}
const connectUrl = String(process.env.QIANMU_ST_CDP_URL || '').trim();
if (!connectUrl) throw new Error('QIANMU_ST_CDP_URL is required; refusing to launch or log in');
const parsedTarget = new URL(target);
if (!['http:', 'https:'].includes(parsedTarget.protocol)) throw new Error('QIANMU_ST_URL must use http or https');

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.QIANMU_PLAYWRIGHT_MODULE || 'playwright');
const browser = await chromium.connectOverCDP(connectUrl);
const context = browser.contexts()[0];
if (!context) throw new Error('The connected browser has no usable context');

const blockedMethods = [], externalRequests = [], failedRequests = [], pageErrors = [];
const page = await context.newPage();
page.setDefaultTimeout(15000);
await page.route('**/*', async route => {
  const request = route.request();
  const method = request.method().toUpperCase();
  const url = new URL(request.url());
  if (url.origin !== parsedTarget.origin) externalRequests.push(url.origin);
  if (!['GET', 'HEAD'].includes(method)) {
    blockedMethods.push({ method, pathname: url.pathname });
    await route.abort();
    return;
  }
  await route.continue();
});
page.on('requestfailed', request => failedRequests.push({ method: request.method(), pathname: new URL(request.url()).pathname }));
page.on('pageerror', error => pageErrors.push(String(error?.message || error).slice(0, 300)));

let result;
try {
  await page.goto(target, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => typeof globalThis.SillyTavern?.getContext === 'function');
  try {
    await page.waitForSelector('#story-director-float', { state: 'attached', timeout: 8000 });
  } catch (_) {
    result = await page.evaluate(() => ({ frontEndLoaded: false, reason: '千幕悬浮入口未在新页出现，未注入临时数据' }));
  }
  if (!result) {
    result = await page.evaluate(async () => {
      const context = globalThis.SillyTavern.getContext();
      if (!context || typeof context !== 'object' || !Array.isArray(context.chat)) {
        return { frontEndLoaded: false, reason: 'ST 上下文或聊天数组不可用，未注入临时数据' };
      }
      const own = (key) => Object.prototype.hasOwnProperty.call(context, key);
      const original = {
        hasChat: own('chat'), chat: context.chat,
        hasMetadata: own('chatMetadata'), chatMetadata: context.chatMetadata,
        hasSaveMetadata: own('saveMetadata'), saveMetadata: context.saveMetadata,
        hasSaveSettings: own('saveSettings'), saveSettings: context.saveSettings,
        hasSaveSettingsDebounced: own('saveSettingsDebounced'), saveSettingsDebounced: context.saveSettingsDebounced,
      };
      const writerCalls = [];
      const fixtureId = `live-phase1-${Date.now().toString(36)}`;
      const floors = [
        ['夜班厨房', '水汽沿着窗框上升，角色A把火调小。', 'cinematic kitchen, steam, medium shot'],
        ['餐桌边的停顿', '角色B没有回答，只把旧瓷杯推回两人之间。', 'two people at a table, held silence'],
        ['电车经过之前', '窗外的灯影切过桌面，镜头移向未说出口的手势。', 'tram light across a table, insert shot'],
      ];
      const temporaryChat = floors.map(([title, text], floor) => ({
        mes: text, name: floor % 2 ? '角色B' : '角色A', is_user: false,
        extra: { qianmuTemporaryFixture: true, fixtureId, floor, title },
      }));
      const images = floors.map(([title], floor) => ({
        id: `${fixtureId}-image-${floor + 1}`, kind: 'still', status: 'succeeded', temporary: true,
        fixtureId, floor, title, prompt: floors[floor][2], model: 'temporary-fixture',
      }));
      const metadata = { story_director_liminale: {
        schemaVersion: 8, temporary: true, fixtureId, storyboardImages: images,
        storyboardCollections: [{ id: `${fixtureId}-sequence`, name: '临时连续镜头', temporary: true, fixtureId, imageIds: images.map(row => row.id) }],
      } };
      const writer = label => () => { writerCalls.push(label); };
      const restoreProperty = (key, has, value) => {
        if (has) context[key] = value;
        else delete context[key];
      };
      context.saveMetadata = writer('metadata');
      context.saveSettings = writer('settings');
      context.saveSettingsDebounced = writer('settingsDebounced');
      context.chat = [...temporaryChat];
      context.chatMetadata = metadata;
      let observed;
      try {
        const button = document.getElementById('story-director-float');
        if (!button) return { frontEndLoaded: false, reason: '入口在注入前消失，未继续操作' };
        button.click();
        await new Promise(resolve => setTimeout(resolve, 250));
        const modal = document.getElementById('story-director-modal');
        modal?.querySelector('.sd-storyboard-shortcut')?.click();
        await new Promise(resolve => setTimeout(resolve, 250));
        const navViews = ['create', 'characters', 'assets', 'gallery', 'logs'];
        const storyboardNavViews = [];
        for (const view of navViews) {
          const currentModal = document.getElementById('story-director-modal');
          const currentButton = currentModal?.querySelector(`[data-storyboard-view="${view}"]`);
          if (!currentButton) throw new Error(`missing storyboard navigation view: ${view}`);
          currentButton.click();
          await new Promise(resolve => setTimeout(resolve, 140));
          const activeButton = currentModal?.querySelector('.sd-storyboard-nav button[aria-current="page"]');
          storyboardNavViews.push({
            view,
            active: activeButton?.dataset.storyboardView || '',
            label: activeButton?.querySelector('span')?.textContent || '',
            title: currentModal?.querySelector('.sd-storyboard-titlebar [role="heading"]')?.textContent || '',
          });
        }
        const expectedTitles = {
          create: 'STORYBOARD', characters: 'CHARACTERS', assets: 'TAG LIBRARY',
          gallery: 'SCREENING ROOM', logs: 'LOGS',
        };
        const storyboardNavValid = storyboardNavViews.length === navViews.length
          && storyboardNavViews.every(item => item.active === item.view && item.title === expectedTitles[item.view]);
        if (!storyboardNavValid) throw new Error('storyboard navigation matrix mismatch');
        observed = {
          frontEndLoaded: true,
          floatRendered: Boolean(button.isConnected),
          modalRendered: Boolean(modal),
          storyboardMode: Boolean(modal?.classList.contains('sd-storyboard-mode')),
          storyboardNavViews,
          storyboardNavValid,
          chatLength: context.chat.length,
          storyboardImageCount: context.chatMetadata?.story_director_liminale?.storyboardImages?.length || 0,
          storyboardCollectionCount: context.chatMetadata?.story_director_liminale?.storyboardCollections?.length || 0,
          writerCalls: [...writerCalls],
        };
      } finally {
        restoreProperty('chat', original.hasChat, original.chat);
        restoreProperty('chatMetadata', original.hasMetadata, original.chatMetadata);
        restoreProperty('saveMetadata', original.hasSaveMetadata, original.saveMetadata);
        restoreProperty('saveSettings', original.hasSaveSettings, original.saveSettings);
        restoreProperty('saveSettingsDebounced', original.hasSaveSettingsDebounced, original.saveSettingsDebounced);
      }
      return { ...observed, restored: context.chat === original.chat && context.chatMetadata === original.chatMetadata };
    });
  }
  console.log(JSON.stringify({
    ...result,
    blockedMethods,
    externalOrigins: [...new Set(externalRequests)],
    failedRequests,
    pageErrors,
    productionWrites: false,
    attachedBrowser: true,
    temporaryFixture: Boolean(result.frontEndLoaded),
  }));
} finally {
  await page.close().catch(() => {});
}
