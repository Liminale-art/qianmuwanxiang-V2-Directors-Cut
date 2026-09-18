import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../scripts/check-historical-host-readonly-browser.mjs', import.meta.url), 'utf8');
const releaseConfig = JSON.parse(await readFile(new URL('../release-files.json', import.meta.url), 'utf8'));

test('real-host probe requires explicit URL and read-only acknowledgement', () => {
  assert.match(source, /QIANMU_ST_URL/);
  assert.match(source, /QIANMU_READONLY_CONFIRM/);
  assert.match(source, /QIANMU_BROWSER_EXECUTABLE/);
  assert.match(source, /refusing to guess a host/);
});

test('real-host probe accepts an explicit local browser executable without mixing launch modes', () => {
  assert.match(source, /QIANMU_BROWSER_CHANNEL/);
  assert.match(source, /browserChannel && browserExecutable/);
  assert.match(source, /Use only one of QIANMU_BROWSER_CHANNEL or QIANMU_BROWSER_EXECUTABLE/);
  assert.match(source, /executablePath: browserExecutable/);
});

test('real-host probe aborts every non-GET request before navigation can write', () => {
  assert.match(source, /\['GET', 'HEAD'\]\.includes\(method\)/);
  assert.match(source, /blockedMethods\.push/);
  assert.match(source, /route\.abort\(\)/);
  assert.doesNotMatch(source, /page\.click\(|\.fill\(|\.press\(|\.check\(/);
});

test('real-host probe only inspects save capability and never invokes it', () => {
  assert.match(source, /typeof context\?\.saveMetadata === 'function'/);
  assert.match(source, /saveMetadataInvoked: false/);
  assert.doesNotMatch(source, /saveMetadata\s*\(/);
});

test('real-host probe closes only its own page when attached to a browser', () => {
  assert.match(source, /attachedBrowser: attached/);
  assert.match(source, /if \(!attached\) await browser\.close/);
});

test('real-host probe stays development-only and cannot enter the release whitelist', () => {
  assert.ok(releaseConfig.forbiddenSegments.includes('scripts'));
  assert.ok(releaseConfig.forbiddenSegments.includes('tests'));
  assert.ok(!releaseConfig.files.includes('scripts/check-historical-host-readonly-browser.mjs'));
  assert.ok(!releaseConfig.files.includes('tests/historical-host-probe.test.mjs'));
  assert.ok(!releaseConfig.directories.some(directory => ['scripts', 'tests'].includes(directory)));
});
