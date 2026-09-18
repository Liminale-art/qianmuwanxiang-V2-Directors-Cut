import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../scripts/check-index-isolated-browser.mjs', import.meta.url), 'utf8');
const releaseConfig = JSON.parse(await readFile(new URL('../release-files.json', import.meta.url), 'utf8'));

test('full-entry isolated browser harness uses a temporary fixture and restores the host', () => {
  assert.match(source, /full-entry-phase1/);
  assert.match(source, /storyboardImageCount/);
  assert.match(source, /storyboardCollectionCount/);
  assert.match(source, /const originalChat = context\.chat/);
  assert.match(source, /context\.chat = originalChat/);
  assert.match(source, /await module\.onActivate\(\)/);
  assert.match(source, /await module\.onDisable\(\)/);
  assert.match(source, /productionWrites: false/);
});

test('full-entry isolated browser harness blocks external traffic and stays development-only', () => {
  assert.match(source, /url\.origin !== origin/);
  assert.match(source, /route\.abort\(\)/);
  assert.ok(releaseConfig.forbiddenSegments.includes('scripts'));
  assert.ok(releaseConfig.forbiddenSegments.includes('tests'));
  assert.ok(!releaseConfig.files.includes('scripts/check-index-isolated-browser.mjs'));
  assert.ok(!releaseConfig.files.includes('tests/index-isolated-browser.test.mjs'));
});
