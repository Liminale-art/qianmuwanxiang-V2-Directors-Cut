import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

test('focus boundaries use the real ESM parser/linker without executing application code', async () => {
  const {stdout} = await promisify(execFile)(process.execPath,['--experimental-vm-modules',fileURLToPath(new URL('../scripts/check-focus-boundaries.mjs',import.meta.url))],{timeout:15000});
  const report=JSON.parse(stdout);
  assert.equal(report.modules,4);
  assert.equal(report.linked,true);
  assert.equal(report.executed,false);
  assert.equal(report.negativeFixtures,5);
  assert.equal(report.nonExecutionFixture,true);
});
