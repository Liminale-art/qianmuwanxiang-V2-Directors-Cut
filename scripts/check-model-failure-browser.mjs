// Offline production log-renderer checks. All records and responses are synthetic.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

const index = await readFile(new URL('../index.js', import.meta.url), 'utf8');
const start = index.indexOf('const LOG_STATUS_LABELS ='), end = index.indexOf('\nfunction renderTtsVoiceMapRows', start);
assert.ok(start > 0 && end > start);
const css = await readFile(new URL('../style.css', import.meta.url), 'utf8') + '\n' + await readFile(new URL('../qianmu-theme-skins.css', import.meta.url), 'utf8');
const require = createRequire(import.meta.url), { chromium } = require(process.env.QIANMU_PLAYWRIGHT_MODULE || 'playwright');
const browser = await chromium.launch({ channel: process.env.QIANMU_BROWSER_CHANNEL || undefined, headless: true });
const context = await browser.newContext(), page = await context.newPage();
const errors = [], checks = [], blocked = []; let external = 0;
const deadline = setTimeout(() => { void browser.close(); }, 60000);
page.on('pageerror', error => errors.push(error.message));
await context.route('**/*', async route => {
  const url = new URL(route.request().url());
  if (url.origin === 'https://qianmu.test' && url.pathname === '/') return route.fulfill({ contentType: 'text/html; charset=utf-8', body:
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><style>body{margin:0}#story-director-modal{position:relative!important;display:block!important;inset:auto!important;transform:none!important;width:100%!important;height:100dvh!important}#story-director-modal .sd-window{width:100%!important;height:100%!important;max-height:none!important;margin:0!important}</style><div id="story-director-modal" class="open sd-theme-dark"><section class="sd-window"><main class="sd-body"><section class="sd-card"><h3>日志</h3><div class="sd-log-list"></div></section></main></section></div>` });
  if (url.origin === 'https://qianmu.test' && /^\/qianmu-[a-z0-9-]+\.js$/.test(url.pathname)) return route.fulfill({ contentType: 'application/javascript', body: await readFile(new URL('..' + url.pathname, import.meta.url)) });
  if (url.origin === 'https://qianmu.test' && /^\/qianmu-[a-z0-9-]+\.css$/.test(url.pathname)) return route.fulfill({ contentType: 'text/css', body: await readFile(new URL('..' + url.pathname, import.meta.url)) });
  if (url.origin === 'https://qianmu.test' && url.pathname === '/favicon.ico') return route.fulfill({ status: 204, body: '' });
  external++; blocked.push(url.href); return route.abort();
});
try {
  await page.goto('https://qianmu.test/');
  await page.evaluate(async source => {
    const [utils, live, { createQianmuAppearanceSession }, { updateAppearancePreferences }] = await Promise.all([
      import('/qianmu-storyboard-utils.js'), import('/qianmu-director-live.js'), import('/qianmu-appearance-session.js'), import('/qianmu-appearance-settings.js'),
    ]);
    for (const name of ['htmlEscape', 'infoTag', 'estimateTokens']) window[name] = utils[name];
    Object.assign(window, { settings: { theme: 'dark', logOpenState: {} }, ...live });
    (0, eval)(source);
    const offlineAsset = () => ({ promise: Promise.resolve(true), cancel() {} });
    const appearance = createQianmuAppearanceSession({ readSettings: () => settings, loadStyles: offlineAsset, loadFont: offlineAsset });
    appearance.mount(document.querySelector('#story-director-modal'));
    window.checkFixture = async ({ family, mode, outcome }) => {
      settings.theme = mode; settings.appearance = updateAppearancePreferences(settings, { family, mode });
      document.querySelector('#story-director-modal').className = `open sd-theme-${mode}`; await appearance.sync();
      const root = document.querySelector('.sd-log-list'), prefix = '{"quests":[{"title":"kept"}],', rawError = JSON.stringify({ error: { code: 'model_not_found', type: 'invalid_request_error', message: '<img src=x onerror="window.UNSAFE=true">', detail: 'full detail '.repeat(120) } });
      const log = { id: 'fixture', kind: 'director', status: 'loading', request: 'REQUEST_EXACT', response: prefix, reasoning: 'THOUGHT_EXACT' };
      settings.logOpenState.fixture = true;
      root.innerHTML = renderLogEntry(log, 0, true);
      const rawNode = root.querySelector('.sd-term-response');
      Object.assign(log, { status: outcome === 'success' ? 'success' : outcome === 'cancelled' ? 'cancelled' : 'error', duration: '1s',
        response: prefix + '"kept":true}',
        error: outcome === 'success' ? '' : outcome === 'cancelled' ? '已中断。' : '推演未完成。',
        errorCause: outcome === 'success' ? '' : outcome === 'shortfall' ? '本次内容未完整达到栏目要求；已收内容可只读查看，缺项已记入日志。' : 'ORIGINAL_CAUSE',
        errorCode: outcome === 'shortfall' ? 'MODEL_OUTPUT_INCOMPLETE' : undefined,
        hasValidContent: true,
        completion: ['success', 'shortfall'].includes(outcome) ? { complete: true, finishReason: 'stop' } : { interrupted: true, finishReason: outcome === 'truncated' ? 'length' : '', rawTransport: rawError },
        quality: outcome === 'success' ? {} : { issues: [{ field: 'quests', missing: 4 }] },
      });
      const before = JSON.stringify(log); paintModelLog(root, log, renderLogEntry);
      const failure = root.querySelector('.sd-log-failure'), bottom = root.querySelector('.sd-log-diagnostics');
      const results = {
        'stream finalization keeps the raw response node and exact text': root.querySelector('.sd-term-response') === rawNode && rawNode.textContent === log.response,
        'request and reasoning remain separate': root.querySelector('.sd-term-request').textContent === 'REQUEST_EXACT' && bottom.textContent.includes('THOUGHT_EXACT'),
        'rendering never mutates logs or executes returned markup': JSON.stringify(log) === before && !root.querySelector('img,script') && !window.UNSAFE,
        'bottom has no error payload or failure facts': !/model_not_found|ORIGINAL_CAUSE|缺失内容|结束原因/.test(bottom.textContent),
        'no horizontal page overflow': document.documentElement.scrollWidth <= innerWidth + 1,
      };
      if (outcome === 'success') results['successful output has no failure box content'] = failure.textContent === '';
      else {
        const diagnostic = failure.querySelector('.sd-log-raw-error');
        const panel = failure.querySelector('.sd-log-error-panel'), panelStyle = panel && getComputedStyle(panel);
        results['all error details share one visual panel with transparent borderless internal text'] = failure.querySelectorAll('.sd-log-error-panel').length === 1
          && panelStyle.backgroundColor === 'rgb(20, 22, 26)' && panelStyle.borderRadius === '10px'
          && (!diagnostic || panel.contains(diagnostic)) && [...panel.querySelectorAll('.sd-term')].every(node => {
            const style = getComputedStyle(node); return style.backgroundColor === 'rgba(0, 0, 0, 0)' && style.borderTopWidth === '0px' && style.borderRadius === '0px';
          });
        if (outcome === 'shortfall') results['shortfall appears once without repeating the generated summary or original-error text'] = panel.textContent.trim() === '缺失内容：预演缺 4 条' && !panel.querySelector('details');
        else {
          results['one expandable raw response exists inside the failure box only'] = root.querySelectorAll('.sd-log-raw-error').length === 1 && diagnostic.querySelector('pre').textContent === rawError && !diagnostic.open;
          results['shortfall remains visible without a duplicated raw-error summary'] = !panel.querySelector('.sd-log-error-detail') && !panel.textContent.includes('ORIGINAL_CAUSE') && panel.textContent.includes('预演缺 4 条');
          diagnostic.querySelector('summary').click(); paintModelLog(root, log, renderLogEntry);
          results['diagnostic expansion survives a duplicate final update'] = diagnostic.open;
        }
        if (outcome === 'truncated') results['length finish is retained'] = failure.textContent.includes('回复被截断（length）');
      }
      return results;
    };
    window.showFailureScreenshot = async () => {
      await checkFixture({ family: 'glass', mode: 'light', outcome: 'error' });
      const raw = JSON.stringify({ error: { message: 'The requested model is not available.', type: 'invalid_request_error', param: null, code: 'model_not_found' } }, null, 2);
      const log = { id: 'fixture', kind: 'director', status: 'error', time: '离线日志界面验证', duration: '1.0s',
        error: '模型请求失败：HTTP 404', errorCode: 'MODEL_HTTP_ERROR',
        request: '[离线模拟请求，未联系模型服务]', response: '', completion: { interrupted: true, rawTransport: raw } };
      document.querySelector('.sd-log-list').innerHTML = renderLogEntry(log, 0, true);
      document.querySelector('.sd-log-raw-error').open = true;
    };
    window.showShortfallScreenshot = async () => {
      await checkFixture({ family: 'glass', mode: 'light', outcome: 'shortfall' });
      const log = { id: 'fixture', kind: 'director', status: 'error', time: '离线日志界面验证', duration: '1.0s',
        error: '本次推演未完整完成；已收到的条目仍可查看。', errorCode: 'MODEL_OUTPUT_INCOMPLETE',
        errorCause: '本次内容未完整达到栏目要求；已收内容可只读查看，缺项已记入日志。', hasValidContent: true,
        request: '[离线模拟请求，未联系模型服务]', response: '{"quests":[{"subject":"值班员","description":"把新送来的记录本交给接班人。"}]}',
        completion: { complete: true, finishReason: 'stop' }, quality: { issues: [{ field: 'quests', missing: 1 }, { field: 'interlude', missing: 1 }] } };
      document.querySelector('.sd-log-list').innerHTML = renderLogEntry(log, 0, true);
    };
  }, index.slice(start, end));
  for (const family of ['classic', 'editorial', 'glass']) for (const mode of ['light', 'dark']) for (const width of [320, 393, 1100]) {
    await page.setViewportSize({ width, height: 760 });
    for (const outcome of ['error', 'cancelled', 'truncated', 'shortfall', 'success']) {
      const results = await page.evaluate(options => checkFixture(options), { family, mode, outcome });
      for (const [name, passed] of Object.entries(results)) { const label = `${family}/${mode}/${width}/${outcome}: ${name}`; assert.ok(passed, label); checks.push(label); }
    }
  }
  if (process.env.QIANMU_FAILURE_SCREENSHOT) {
    await page.setViewportSize({ width: 540, height: 1100 });
    await page.evaluate(() => showFailureScreenshot());
    await page.screenshot({ path: process.env.QIANMU_FAILURE_SCREENSHOT, fullPage: true });
  }
  if (process.env.QIANMU_SHORTFALL_SCREENSHOT) {
    await page.setViewportSize({ width: 540, height: 1100 });
    await page.evaluate(() => showShortfallScreenshot());
    await page.screenshot({ path: process.env.QIANMU_SHORTFALL_SCREENSHOT, fullPage: true });
  }
  assert.equal(external, 0, JSON.stringify(blocked)); assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: checks.length, external, errors }, null, 2));
} finally { clearTimeout(deadline); await browser.close(); }
