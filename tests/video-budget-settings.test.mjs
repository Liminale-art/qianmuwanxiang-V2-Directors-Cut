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

test('budget settings expose bounded user limits without an automation switch', () => {
  const card = section('function renderStoryboardVideoBudgetCard', 'function renderStoryboardVideoConnectionCard');
  assert.match(card, /每日总额提醒线/);
  assert.match(card, /单次上限/);
  assert.match(card, /自动每日上限/);
  assert.match(card, /单聊天每日上限/);
  assert.match(card, /尚未开放/);
  assert.doesNotMatch(card, /checkbox|data-video-automatic|aria-pressed/i);
});

test('saving a policy normalizes it lazily and cannot enable paid automation', () => {
  const bindings = section("if (activeTab === 'plug')", "root.querySelector('.sd-edit-injection')");
  assert.match(bindings, /featureRuntime\.load\('videoBudget'\)/);
  assert.match(bindings, /normalizeVideoBudgetPolicy/);
  assert.match(bindings, /automatic: \{\s*enabled: false/);
  assert.match(bindings, /requireCostConfirmation: true/);
  assert.match(bindings, /requireExplicitConfirmation: true/);
  assert.doesNotMatch(bindings, /videoCoordinator|createTask|submit\(/i);
});
