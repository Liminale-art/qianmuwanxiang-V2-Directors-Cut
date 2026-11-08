import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);

// MODULES.md is navigation only. Guard the file list, not the descriptions, so editing a
// leading comment never fails the suite; adding/removing/moving a root file does.
test('MODULES.md lists exactly the tracked root files', async () => {
  const tracked = execFileSync('git', ['ls-files'], { cwd: fileURLToPath(root), encoding: 'utf8' })
    .split(/\r?\n/).filter(name => name && !name.includes('/') && !name.startsWith('.') && name !== 'MODULES.md').sort();
  const map = await readFile(new URL('MODULES.md', root), 'utf8');
  const listed = [...map.matchAll(/^\| `([^`]+)` \|/gm)].map(match => match[1]).sort();
  assert.deepEqual(listed, tracked, 'run node scripts/generate-module-map.mjs');
});
