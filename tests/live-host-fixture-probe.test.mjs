import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../scripts/check-live-host-temporary-fixture-browser.mjs', import.meta.url), 'utf8');
const releaseConfig = JSON.parse(await readFile(new URL('../release-files.json', import.meta.url), 'utf8'));

test('live fixture probe requires explicit target, CDP and in-memory confirmation', () => {
  assert.match(source, /QIANMU_ST_URL/);
  assert.match(source, /QIANMU_ST_CDP_URL/);
  assert.match(source, /QIANMU_TEMP_FIXTURE_CONFIRM/);
  assert.match(source, /refusing to launch or log in/);
});

test('live fixture probe scopes network blocking to its new page and aborts non-GET traffic', () => {
  assert.match(source, /page\.route\('\*\*\/\*'/);
  assert.match(source, /\['GET', 'HEAD'\]\.includes\(method\)/);
  assert.match(source, /blockedMethods\.push/);
  assert.match(source, /route\.abort\(\)/);
  assert.doesNotMatch(source, /context\.route\(/);
});

test('live fixture probe replaces and restores chat, metadata and writers without persistence', () => {
  assert.match(source, /temporaryChat/);
  assert.match(source, /storyboardImages/);
  assert.match(source, /storyboardNavViews/);
  assert.match(source, /missing storyboard navigation view/);
  assert.match(source, /restoreProperty\('chat'/);
  assert.match(source, /restoreProperty\('chatMetadata'/);
  assert.match(source, /restoreProperty\('saveMetadata'/);
  assert.match(source, /restored: context\.chat === original\.chat/);
  assert.match(source, /productionWrites: false/);
  assert.doesNotMatch(source, /context\.saveMetadata\s*\(/);
});

test('live fixture probe closes only its own page and stays out of releases', () => {
  assert.match(source, /await page\.close\(\)/);
  assert.doesNotMatch(source, /browser\.close\(/);
  assert.ok(releaseConfig.forbiddenSegments.includes('scripts'));
  assert.ok(releaseConfig.forbiddenSegments.includes('tests'));
  assert.ok(!releaseConfig.files.includes('scripts/check-live-host-temporary-fixture-browser.mjs'));
  assert.ok(!releaseConfig.files.includes('tests/live-host-fixture-probe.test.mjs'));
  assert.ok(!releaseConfig.directories.some(directory => ['scripts', 'tests'].includes(directory)));
});
