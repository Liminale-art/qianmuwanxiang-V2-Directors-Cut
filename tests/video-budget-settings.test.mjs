import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = await readFile(new URL('../index.js', import.meta.url), 'utf8');

function section(start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.ok(from >= 0, `missing section: ${start}`);
  assert.ok(to > from, `missing section end: ${end}`);
  return source.slice(from, to);
}

test('video budget defaults fail closed for automation and keep confirmations mandatory', () => {
  const defaults = section('const DEFAULT_SETTINGS', 'let settings = null');
  assert.match(defaults, /budgetPolicy:[\s\S]*automatic: \{ enabled: false/);
  assert.match(defaults, /manual: \{ requireCostConfirmation: true \}/);
  assert.match(defaults, /highResolution: \{ requireExplicitConfirmation: true \}/);
});

test('retired speculative dynamic-budget controls are removed rather than merely hidden', () => {
  assert.doesNotMatch(source, /renderStoryboardVideoBudgetCard|sd-video-budget-(save|total|per-task|daily|chat|duration)|动态费用保护/);
});

test('opening API settings cannot rewrite legacy budgets or enable video automation', () => {
  const bindings = section("if (activeTab === 'plug')", "root.querySelector('.sd-edit-injection')");
  assert.doesNotMatch(bindings, /videoBudget|budgetPolicy|settings\.videoH3/);
  const policy=section('function storyboardVideoBudgetPolicy()', 'function renderPlugTab()');
  assert.match(policy, /enabled: false/);
  assert.match(policy, /requireCostConfirmation: true/);
  assert.match(policy, /requireExplicitConfirmation: true/);
  assert.doesNotMatch(bindings, /videoCoordinator|createTask|submit\(/i);
});
