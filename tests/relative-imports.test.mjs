import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
const trackedSet = new Set(tracked);

const resolve = (file, specifier) => path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier));
const insideRepo = target => !target.startsWith('../') && !target.startsWith('dist/') && !target.endsWith('/') && target !== '.';

// Folder moves (scripts/relayout.mjs) must never leave a reference pointing at a file that is not there.
// Shipped modules: every static/dynamic import specifier. Host imports that leave the repo (../../../script.js) are skipped.
test('every relative import in shipped JS resolves to a tracked file', async () => {
  const release = JSON.parse(await readFile(path.join(root, 'release-files.json'), 'utf8'));
  const broken = [];
  for (const file of release.files.filter(name => name.endsWith('.js') && !name.startsWith('vendor/'))) {
    const source = await readFile(path.join(root, file), 'utf8');
    for (const match of source.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*)(['"])(\.{1,2}\/[^'"?#]+)(?:\?[^'"]*)?\1/g)) {
      const target = resolve(file, match[2]);
      if (insideRepo(target) && !trackedSet.has(target)) broken.push(`${file} -> ${match[2]}`);
    }
  }
  assert.deepEqual(broken, []);
});

// Tests and scripts reach repo modules through `../` imports and new URL(<../ path>, import.meta.url).
// Fixture strings (path-traversal samples) and deliberate "must not exist" checks are not code references.
const ABSENT_BY_DESIGN = new Set(['tests/gallery-narrative.test.mjs -> ../qianmu-gallery-narrative-view.js']);
test('every ../ module reference in tests and scripts resolves to a tracked file', async () => {
  const broken = [];
  for (const file of tracked.filter(name => /^(?:tests|scripts)\/[^/]+\.m?js$/.test(name))) {
    const source = await readFile(path.join(root, file), 'utf8');
    const pattern = /(?:\bfrom\s*|\bimport\s*\(\s*|\bnew URL\(\s*)(['"`])(\.\.\/[^'"`?#${}\s]+)(?:\?[^'"`]*)?\1/g;
    for (const match of source.matchAll(pattern)) {
      const target = resolve(file, match[2]), key = `${file} -> ${match[2]}`;
      if (insideRepo(target) && !trackedSet.has(target) && !ABSENT_BY_DESIGN.has(key)) broken.push(key);
    }
  }
  assert.deepEqual(broken, []);
});

test('relayout dry run reports moved references and refuses renames', async () => {
  const { planRelayout } = await import('../scripts/relayout.mjs');
  const plugin = await readFile(path.join(root, 'server-plugin.js'), 'utf8');
  const name = [...plugin.matchAll(/from '\.\/(qianmu-[\w-]+\.js)/g)].map(match => match[1]).find(file => trackedSet.has(file));
  const plan = await planRelayout([{ from: name, to: `relayout-probe/${name}` }]);
  assert.ok(plan.edits.get('server-plugin.js').next.includes(`'./relayout-probe/${name}`));
  assert.ok(plan.edits.get('release-files.json').next.includes(`"relayout-probe/${name}"`));
  await assert.rejects(planRelayout([{ from: name, to: 'relayout-probe/other.js' }]), /renaming/);
});
