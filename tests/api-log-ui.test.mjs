import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { renderModelDiagnostics, modelFailureText } from '../qianmu-director-live.js';

const entry = await readFile(new URL('../index.js', import.meta.url), 'utf8');
const css = await readFile(new URL('../style.css', import.meta.url), 'utf8');
const skinCss = await readFile(new URL('../qianmu-theme-skins.css', import.meta.url), 'utf8');
const start = entry.indexOf('const LOG_STATUS_LABELS =');
const end = entry.indexOf('\nfunction renderTtsVoiceMapRows', start);
assert.ok(start > 0 && end > start, 'production log renderer is available');
const escape = value => String(value).replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const settings = { logOpenState: {} };
const render = vm.runInNewContext(`${entry.slice(start, end)}\nrenderLogEntry`, {
  settings, renderModelDiagnostics, modelFailureText, htmlEscape: escape, infoTag: value => `<small>${escape(value)}</small>`, estimateTokens: value => String(value).length,
});

test('collapsed logs never read, tokenize or escape heavyweight request and response bodies', () => {
  const log = { id: 'heavy', status: 'error', time: 'today', kind: 'director' };
  for (const key of ['request', 'response', 'reasoning', 'completion']) Object.defineProperty(log, key, { get() { assert.fail(`Collapsed row read ${key}`); } });
  const html = render(log, 0);
  assert.match(html, /data-loaded="false"/); assert.doesNotMatch(html, /<pre|token|失败提示/);
});

test('stopped and truncated logs put all failure reasons before request/response, not under the output', () => {
  const html = render({ id: 'stopped', status: 'cancelled', completion: { interrupted: true, finishReason: 'length' }, response: 'partial' }, 0, true);
  assert.match(html, /sd-log-failure[\s\S]*已中断。[\s\S]*sd-term-request/);
  assert.match(html.slice(0, html.indexOf('sd-term-request')), /结束原因：length/);
  assert.doesNotMatch(html.slice(html.indexOf('sd-log-diagnostics')), /结束原因|未完整完成/);
});

test('director and other failed logs keep raw API errors in one escaped expandable failure box', () => {
  const raw = JSON.stringify({ error: { message: '<script>bad()</script>', type: 'invalid_request_error', code: 'model_not_found', detail: 'x'.repeat(700) } });
  for (const kind of ['director', 'theater', 'tts']) for (const status of ['error', 'cancelled']) {
    const log = { id: `${kind}-${status}`, kind, status, error: '失败原文', errorCause: '具体错误', errorCode: 'MODEL_REMOTE_ERROR',
      request: 'REQUEST_UNCHANGED', response: 'KEPT_PARTIAL', reasoning: 'REASONING_UNCHANGED',
      completion: { interrupted: true, rawTransport: raw, compatibility: '渠道兼容说明' } };
    const before = JSON.stringify(log), html = render(log, 0, true);
    const top = html.slice(html.indexOf('sd-log-failure'), html.indexOf('sd-term-request'));
    const bottom = html.slice(html.indexOf('sd-log-diagnostics'));
    assert.equal((html.match(/class="sd-log-error-panel"/g) || []).length, 1);
    assert.match(top, /sd-log-error-panel[\s\S]*sd-term-error[\s\S]*sd-log-raw-error/);
    assert.match(top, /原始错误：具体错误/); assert.match(top, /MODEL_REMOTE_ERROR/);
    assert.match(top, /<details class="sd-log-raw-error"><summary>原始服务响应/);
    assert.ok(top.includes(escape(raw))); assert.match(top, /渠道兼容说明/);
    assert.doesNotMatch(bottom, /model_not_found|渠道兼容说明|具体错误|MODEL_REMOTE_ERROR/);
    assert.equal(html.split('model_not_found').length - 1, 1);
    assert.match(bottom, /REASONING_UNCHANGED/);
    assert.match(html, /sd-term-response">KEPT_PARTIAL/);
    assert.doesNotMatch(html, /<script>/);
    assert.equal(JSON.stringify(log), before);
  }
});

test('failure details share one visual surface while internal raw text has no second background or border', () => {
  assert.match(css, /\.sd-log-error-panel \{[^}]*background: #14161a;[^}]*border: 1px[^}]*border-radius: 10px;/);
  assert.match(css, /\.sd-log-error-panel \.sd-term \{[^}]*background: transparent !important;[^}]*border: 0 !important;[^}]*border-radius: 0 !important;[^}]*padding: 0;/);
  assert.doesNotMatch(render({ id: 'ok', status: 'success' }, 0, true), /sd-log-error-panel/);
});
const labels = {success:'成功', error:'失败', cancelled:'已取消', loading:'生成中', none:'状态未知'};

for (const [status, label] of Object.entries(labels)) {
  test(`API log ${status} uses a textless signal with an accessible label and hover explanation`, () => {
    const html = render({id:'one', status, kind:'director'}, 0);
    assert.match(html, new RegExp(`<span class="sd-log-status ${status}" role="img" aria-label="${label}" title="${label}"><\\/span>`));
    assert.doesNotMatch(html, new RegExp(`>${label}<`));
    assert.match(html, /<summary>[\s\S]*sd-log-kind[\s\S]*推演[\s\S]*<\/summary>/);
  });
}

test('unknown, missing and inherited status keys stay neutral without injecting CSS or markup', () => {
  for (const status of [undefined, null, '', 'future', 'success error', 'constructor', '__proto__', '<img onerror="x">', 5, {}]) {
    const html = render({id:'two', status}, 1);
    assert.match(html, /class="sd-log-status none" role="img" aria-label="状态未知" title="状态未知"><\/span>/);
    assert.doesNotMatch(html, /<img|sd-log-status success|sd-log-status constructor/);
  }
});

test('status presentation does not mutate log payload, persistent state or open details', () => {
  const log = Object.freeze({id:'kept', status:'error', time:'2026/9/17 19:00', duration:'3.2s', kind:'theater', request:'<request>', response:'<response>', error:'<failure>'});
  settings.logOpenState.kept = true;
  const before = JSON.stringify({log, settings});
  const html = render(log, 2);
  assert.equal(JSON.stringify({log, settings}), before);
  assert.match(html, /data-acc="log-kept" open/);
  for (const content of ['&lt;request&gt;', '&lt;response&gt;', '&lt;failure&gt;', '2026/9/17 19:00', '3.2s', '小剧场']) assert.ok(html.includes(content));
  assert.equal((html.match(/<pre class="sd-term/g) || []).length, 4);
  assert.match(html, /class="sd-log-reasoning" hidden/);
  delete settings.logOpenState.kept;
});

test('log signals are fixed-size circles with semantic green, red, yellow and neutral colors', () => {
  assert.match(css, /#story-director-modal \.sd-log-status \{[^}]*width: 8px;[^}]*height: 8px;[^}]*flex: 0 0 8px;[^}]*border-radius: 50%;[^}]*background: currentColor;[^}]*color: var\(--sd-muted\)/);
  assert.match(css, /\.sd-log-status\.success \{ color: #4f9e6b; \}/);
  assert.match(css, /\.sd-log-status\.error \{ color: #c95e5e; \}/);
  assert.match(css, /\.sd-log-status\.cancelled,\s*#story-director-modal \.sd-log-status\.loading \{ color: #a58035; \}/);
  assert.match(css, /\.sd-log-meta \{[^}]*font-size: \.85em;/);
});

test('daylight theme signals retain saturated semantic colors without dark-ink blending or night overrides', () => {
  for (const [selector, color] of [['success', '#159461'], ['error', '#df4c5e'], ['is(.cancelled,.loading)', '#b88008']]) {
    const suffix = selector.startsWith('is(') ? `:${selector}` : `.${selector}`;
    assert.ok(skinCss.includes(`#story-director-modal[data-qm-theme][data-qm-mode="light"] .sd-log-status${suffix} { color: ${color}; }`));
  }
  assert.match(skinCss, /\[data-qm-theme\] \.sd-log-status\.success \{ color: color-mix\(in srgb, #4f9e6b 50%, var\(--qm-ink\)\); \}/);
  assert.match(skinCss, /\[data-qm-theme\] \.sd-log-status\.error \{ color: color-mix\(in srgb, #c05050 50%, var\(--qm-ink\)\); \}/);
});
