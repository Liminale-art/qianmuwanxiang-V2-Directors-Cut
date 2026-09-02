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

test('H3 settings persist only non-sensitive regional preferences', () => {
  const defaults = section('const DEFAULT_SETTINGS', 'let settings = null');
  const card = section('function renderStoryboardVideoConnectionCard', 'function renderPlugTab');
  assert.match(defaults, /videoH3: \{[\s\S]*?region: 'global'/);
  assert.match(card, /sd-video-h3-region/);
  assert.match(card, /sd-video-h3-secret/);
  assert.match(card, /value=""/);
  assert.doesNotMatch(defaults, /videoH3[^\n]*(apiKey|secret|credential)/i);
});

test('H3 credentials use a dedicated secret id and are never rendered back into the field', () => {
  const credentials = section("const STORYBOARD_VIDEO_H3_CREDENTIAL_ID", 'async function storyboardResolveApiKey');
  assert.match(credentials, /qianmu_video_minimax_h3/);
  assert.match(credentials, /writeSecret\(STORYBOARD_VIDEO_H3_CREDENTIAL_ID/);
  assert.match(credentials, /deleteSecret\(STORYBOARD_VIDEO_H3_CREDENTIAL_ID/);
  assert.doesNotMatch(credentials, /settings\.videoH3\.(apiKey|secret|credential)/i);
});

test('the visible H3 test checks same-origin capability without creating a paid task', () => {
  const bindings = section("if (activeTab === 'plug')", "root.querySelector('.sd-edit-injection')");
  assert.match(bindings, /sd-video-h3-check/);
  assert.match(bindings, /refreshOptionalServiceState\(true\)/);
  assert.match(bindings, /不能代替首次生成时的授权校验|同源网关/);
  assert.doesNotMatch(bindings, /video\/minimax\/create|videoCoordinator|createTask|submit\(/i);
});
