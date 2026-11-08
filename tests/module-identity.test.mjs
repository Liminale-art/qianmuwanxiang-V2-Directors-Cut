import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { collectReleaseFiles } from '../scripts/build-release.mjs';

const root = new URL('../', import.meta.url);

// A browser keeps one module instance per full URL, so `./x.js` and `./x.js?v=N`
// load two copies with separate state. Every shipped importer of a module must
// therefore use the same literal address; refreshing a module means moving all
// of its importers to the new stamp together.
test('each shipped local module is imported under exactly one address', async () => {
  const files = (await collectReleaseFiles()).filter(file => file.endsWith('.js'));
  const shipped = new Set(files);
  const addresses = new Map();
  for (const file of files) {
    const source = await readFile(new URL(file, root), 'utf8');
    for (const match of source.matchAll(/(['"`])\.\/([A-Za-z0-9_-]+\.js)(\?v=[0-9A-Za-z.-]+)?\1/g)) {
      if (!shipped.has(match[2])) continue;
      const seen = addresses.get(match[2]) || new Map();
      seen.set(match[3] || '(bare)', file);
      addresses.set(match[2], seen);
    }
  }
  const split = [...addresses].filter(([, seen]) => seen.size > 1)
    .map(([target, seen]) => `${target}: ${[...seen].map(([query, file]) => `${query} in ${file}`).join(', ')}`);
  assert.deepEqual(split, []);
});
