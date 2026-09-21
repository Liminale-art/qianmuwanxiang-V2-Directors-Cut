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

test('retired H3 cards are absent while legacy non-sensitive regional data remains readable', () => {
  const defaults = section('const DEFAULT_SETTINGS', 'let settings = null');
  assert.match(defaults, /videoH3: \{[\s\S]*?region: 'global'/);
  assert.doesNotMatch(source, /renderStoryboardVideoConnectionCard|sd-video-h3-(region|secret|check|save|forget)|sd-video-channel-card/);
  assert.doesNotMatch(defaults, /videoH3[^\n]*(apiKey|secret|credential)/i);
});

test('legacy H3 credentials can still be read but card removal does not delete or overwrite them', () => {
  const credentials = section("const STORYBOARD_VIDEO_H3_CREDENTIAL_ID", 'async function storyboardResolveApiKey');
  assert.match(credentials, /qianmu_video_minimax_h3/);
  assert.match(credentials, /readStoredSecret\(STORYBOARD_VIDEO_H3_CREDENTIAL_ID/);
  assert.doesNotMatch(credentials, /writeSecret\(|deleteSecret\(|storyboardWriteBrowserCredential\(/);
  assert.doesNotMatch(credentials, /settings\.videoH3\.(apiKey|secret|credential)/i);
});

test('API page keeps storage and shared service refresh without probing a retired credential card', () => {
  const bindings = section("if (activeTab === 'plug')", "root.querySelector('.sd-edit-injection')");
  assert.match(bindings, /bindStorageManagementEvents\(root\)/);
  assert.match(bindings, /refreshOptionalServiceState\(false\)/);
  assert.doesNotMatch(bindings, /storyboardVideoCredential|storyboardPaintVideoConnectionState|video\/minimax\/create|videoCoordinator|createTask|submit\(/i);
});
