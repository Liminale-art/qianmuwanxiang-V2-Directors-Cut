import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const entry = await readFile(new URL('../index.js', import.meta.url), 'utf8');
const css = await readFile(new URL('../style.css', import.meta.url), 'utf8');
const start = entry.indexOf('const LOG_STATUS_LABELS =');
const end = entry.indexOf('\nfunction renderTtsVoiceMapRows', start);
assert.ok(start > 0 && end > start, 'production log renderer is available');
const escape = value => String(value).replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const settings = { logOpenState: {} };
const render = vm.runInNewContext(`${entry.slice(start, end)}\nrenderLogEntry`, {
  settings, htmlEscape: escape, infoTag: value => `<small>${escape(value)}</small>`, estimateTokens: value => String(value).length,
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
  assert.equal((html.match(/<pre class="sd-term/g) || []).length, 3);
  delete settings.logOpenState.kept;
});

test('log signals are fixed-size circles with semantic green, red, yellow and neutral colors', () => {
  assert.match(css, /#story-director-modal \.sd-log-status \{[^}]*width: 8px;[^}]*height: 8px;[^}]*flex: 0 0 8px;[^}]*border-radius: 50%;[^}]*background: currentColor;[^}]*color: var\(--sd-muted\)/);
  assert.match(css, /\.sd-log-status\.success \{ color: #4f9e6b; \}/);
  assert.match(css, /\.sd-log-status\.error \{ color: #c95e5e; \}/);
  assert.match(css, /\.sd-log-status\.cancelled,\s*#story-director-modal \.sd-log-status\.loading \{ color: #a58035; \}/);
  assert.match(css, /\.sd-log-meta \{[^}]*font-size: \.85em;/);
});
