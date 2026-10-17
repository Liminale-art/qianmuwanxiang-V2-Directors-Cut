import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { storyboardFunctionSource } from './helpers/storyboard-form-fixture.mjs';
import { htmlEscape, uniqueClean } from '../qianmu-storyboard-utils.js';

const css = await readFile(new URL('../style.css', import.meta.url), 'utf8');
function fixture(history = [], providerMode = 'sillytavern') {
  const store = { history }, settings = { providerMode, logHistory: [], streamEnabled: true };
  const context = vm.createContext({
    settings, htmlEscape, uniqueClean, getChatStore: () => store, formatDateTime: date => String(date ?? ''),
    getFloatSize: () => 40, LOG_LIMIT: 5, FLOAT_SIZE_MIN: 32, FLOAT_SIZE_MAX: 80, feedbackOpenScope: null,
    renderQuickWheelSettings: () => '', renderStorageManagementCard: () => '', notesFeatureEnabled: () => true,
  });
  vm.runInContext(['renderHistorySection', 'renderPlugTab'].map(storyboardFunctionSource).join('\n'), context);
  return { context, store, settings };
}

test('history empty state is short, centered and one typography step below body', () => {
  const { context } = fixture();
  assert.match(context.renderHistorySection(), /<p class="sd-muted sd-history-empty">暂无记录<\/p>/);
  assert.doesNotMatch(context.renderHistorySection(), /暂无历史记录|暂无记录。/);
  assert.match(css, /\.sd-history-empty \{[^}]*align-items: center;[^}]*justify-content: center;[^}]*font-size: var\(--qm-type-label, 12px\);[^}]*text-align: center;/);
});

test('history changes neither populated rows nor retention, escaping or stored records', () => {
  const records = Array.from({ length: 6 }, (_, index) => ({ id: `record-${index}`, createdAt: index, plan: { story_status: { title: index ? `条目${index}` : '<script>用户标题</script>' } } }));
  const { context, store } = fixture(records), before = JSON.stringify(store), html = context.renderHistorySection();
  assert.equal((html.match(/class="sd-lib-row"/g) || []).length, 5);
  assert.equal((html.match(/sd-load-history/g) || []).length, 5);
  assert.equal((html.match(/sd-delete-history/g) || []).length, 5);
  assert.doesNotMatch(html, /sd-history-empty|record-5|<script>/);
  assert.match(html, /&lt;script&gt;用户标题&lt;\/script&gt;/);
  assert.equal(JSON.stringify(store), before);
});

test('both model sources omit only the redundant ST sentence and retain controls', () => {
  for (const mode of ['sillytavern', 'external']) {
    const { context, settings } = fixture([], mode), before = JSON.stringify(settings), html = context.renderPlugTab();
    assert.doesNotMatch(html, /继承 ST 当前连接|聊天补全支持独立流式|不影响正文生成/);
    assert.match(html, /sd-provider-select/);
    assert.match(html, /sd-test-api">测试连接/);
    assert.match(html, /sd-stream-toggle sd-primary" aria-pressed="true">流式传输/);
    assert.match(html, mode === 'external' ? /sd-api-external-fields" >/ : /sd-api-external-fields" hidden>/);
    assert.equal(JSON.stringify(settings), before);
  }
});
