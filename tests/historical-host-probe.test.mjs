import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../scripts/check-historical-host-readonly-browser.mjs', import.meta.url), 'utf8');

test('real-host probe requires explicit URL and read-only acknowledgement', () => {
  assert.match(source, /QIANMU_ST_URL/);
  assert.match(source, /QIANMU_READONLY_CONFIRM/);
  assert.match(source, /refusing to guess a host/);
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
