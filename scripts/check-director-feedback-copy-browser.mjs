// Production history/API renderers and appearance session; isolated, read-only
// local fixtures. No ST session, user storage, model or external requests.
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { storyboardFunctionSource } from '../tests/helpers/storyboard-form-fixture.mjs';

const { chromium } = createRequire(import.meta.url)(process.env.QIANMU_PLAYWRIGHT_MODULE || 'playwright');
const css = (await Promise.all(['style.css', 'qianmu-theme-skins.css'].map(file => readFile(new URL('../' + file, import.meta.url), 'utf8')))).join('\n');
const qa = new URL('../dist/local-qa/director-feedback-copy/', import.meta.url);
await mkdir(qa, { recursive: true });
const browser = await chromium.launch({ channel: process.env.QIANMU_BROWSER_CHANNEL || 'msedge', headless: true });
const context = await browser.newContext({ serviceWorkers: 'block' }), page = await context.newPage();
const checks = [], errors = [], external = [], screenshots = [];
const timer = setTimeout(() => void browser.close(), 60000);
const ok = (condition, label) => { assert.ok(condition, label); checks.push(label); };
page.on('pageerror', error => errors.push(error.message));
await context.route('**/*', async route => {
  const url = new URL(route.request().url());
  if (url.href === 'https://fontsapi.zeoseven.com/161/main/result.css') return route.fulfill({ contentType: 'text/css', body: '/* local font only */' });
  if (url.origin === 'https://qianmu.test') {
    if (url.pathname === '/') return route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><style>body{margin:0}#story-director-modal{position:relative!important;display:block!important;inset:auto!important;transform:none!important;width:100%!important;height:100dvh!important;box-sizing:border-box}#story-director-modal .sd-window{width:100%!important;height:100%!important;max-height:none!important;margin:0!important}</style><div id="story-director-modal" class="open sd-theme-light"><section class="sd-window"><main class="sd-body"></main></section></div>` });
    if (/^\/qianmu-[a-z0-9-]+\.(js|css)$/.test(url.pathname)) return route.fulfill({ contentType: url.pathname.endsWith('.css') ? 'text/css' : 'application/javascript', body: await readFile(new URL('..' + url.pathname, import.meta.url), 'utf8') });
    if (url.pathname === '/favicon.ico') return route.fulfill({ status: 204 });
  }
  external.push(url.href); return route.abort();
});
try {
  await page.goto('https://qianmu.test/');
  await page.evaluate(async source => {
    const [utils, { createQianmuAppearanceSession }, { updateAppearancePreferences }] = await Promise.all([
      import('/qianmu-storyboard-utils.js'), import('/qianmu-appearance-session.js'), import('/qianmu-appearance-settings.js'),
    ]);
    Object.assign(window, utils, {
      settings: { theme: 'light', providerMode: 'sillytavern', streamEnabled: true, logHistory: [], apiProfiles: [], availableModels: [], maxOutputTokens: 32000, contextBudget: 1000000, temperature: .8 },
      historyStore: { history: [] }, getFloatSize: () => 40, LOG_LIMIT: 5, FLOAT_SIZE_MIN: 32, FLOAT_SIZE_MAX: 80, feedbackOpenScope: null,
      renderQuickWheelSettings: () => '', renderStorageManagementCard: () => '', notesFeatureEnabled: () => true,
    });
    window.getChatStore = () => historyStore;
    (0, eval)(source);
    window.appearance = createQianmuAppearanceSession({ readSettings: () => settings, loadStyles: () => ({ promise: Promise.resolve(true), cancel() {} }), loadFont: () => ({ promise: Promise.resolve(true), cancel() {} }) });
    appearance.mount(document.querySelector('#story-director-modal'));
    window.paint = async (family, mode, providerMode = 'sillytavern') => {
      const root = document.querySelector('#story-director-modal');
      settings.theme = mode; settings.providerMode = providerMode; root.className = 'open sd-theme-' + mode;
      settings.appearance = updateAppearancePreferences(settings, { family, mode }); await appearance.sync();
      document.body.style.background = mode === 'dark' ? '#17181b' : '#f7f3eb';
      const source = document.createElement('template'); source.innerHTML = renderPlugTab();
      root.querySelector('.sd-body').innerHTML = renderHistorySection();
      root.querySelector('.sd-body').append(source.content.querySelector('.sd-model-config'));
    };
  }, ['renderHistorySection', 'renderPlugTab'].map(storyboardFunctionSource).join('\n'));
  for (const family of ['classic', 'editorial', 'glass']) for (const mode of ['light', 'dark']) for (const width of [320, 393, 1100]) {
    const label = `${family}/${mode}/${width}`;
    await page.setViewportSize({ width, height: 760 });
    await page.evaluate(async ({ family, mode }) => paint(family, mode), { family, mode });
    ok(await page.locator('.sd-history-empty').textContent() === '暂无记录', label + ' exact short history empty state');
    ok(await page.locator('.sd-history-empty').evaluate(node => {
      const style = getComputedStyle(node), root = getComputedStyle(document.querySelector('#story-director-modal'));
      const rect = node.getBoundingClientRect(), card = node.closest('.sd-card').getBoundingClientRect();
      return style.fontSize === root.getPropertyValue('--qm-type-label').trim()
        && parseFloat(style.fontSize) < parseFloat(root.getPropertyValue('--qm-type-body'))
        && style.justifyContent === 'center' && style.alignItems === 'center' && style.textAlign === 'center'
        && Math.abs(rect.left + rect.width / 2 - (card.left + card.width / 2)) < 1;
    }), label + ' centered within the card at smaller label scale');
    ok(!/继承 ST 当前连接|聊天补全支持独立流式|不影响正文生成/.test(await page.locator('.sd-model-config').innerText()), label + ' redundant ST sentence removed');
    ok(await page.locator('.sd-provider-select').inputValue() === 'sillytavern'
      && await page.locator('.sd-test-api').isVisible() && await page.locator('.sd-stream-toggle').isVisible()
      && !await page.locator('.sd-api-external-fields').isVisible(), label + ' essential ST model controls remain');
    ok(await page.locator('.sd-card,.sd-field-head,.sd-api-action-row,.sd-provider-select').evaluateAll(nodes => nodes.every(node => node.scrollWidth <= node.clientWidth + 1)), label + ' cards and controls do not overflow');
    if (width === 393) {
      const path = fileURLToPath(new URL(`${family}_${mode}_history_api.png`, qa));
      await page.locator('.sd-body').screenshot({ path, animations: 'disabled' }); screenshots.push(path);
    }
    await page.evaluate(async ({ family, mode }) => paint(family, mode, 'external'), { family, mode });
    ok(await page.locator('.sd-api-external-fields').isVisible() && await page.locator('.sd-save-api').isVisible()
      && await page.locator('.sd-stream-toggle').isVisible(), label + ' external model controls unchanged');
  }
  assert.deepEqual(errors, []); assert.deepEqual(external, []);
  console.log(JSON.stringify({ passed: checks.length, errors, external, screenshots, scope: 'production history/API markup with real appearance session, three themes and day/night at 320/393/1100; no ST or model' }, null, 2));
} finally { clearTimeout(timer); await context.close(); await browser.close(); }
