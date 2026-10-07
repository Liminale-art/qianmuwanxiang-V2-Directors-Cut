import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { collectReleaseFiles } from '../scripts/build-release.mjs';

const root = new URL('../', import.meta.url);
const version = '1.59.445';
const refreshed = new Set([
  'qianmu-creative-prompts.js', 'qianmu-creative-contract.js',
  'qianmu-creative-runtime.js', 'qianmu-director-live.js', 'qianmu-st-context-sources.js', 'qianmu-model-host.js',
]);
const retained = new Map([
  ['qianmu-theme-menu.js', '1.59.444'], ['qianmu-appearance-session.js', '1.59.444'],
  ['qianmu-memory-context.js', '1.59.443'], ['qianmu-hive-commands.js', '1.59.443'],
  ['qianmu-prose-hive.js', '1.59.443'], ['qianmu-prose-floor-tools.js', '1.59.443'],
]);
const files = await collectReleaseFiles();
const sources = new Map(await Promise.all(files.filter(file => file.endsWith('.js'))
  .map(async file => [file, await readFile(new URL(file, root), 'utf8')])));

test('creative release refreshes every literal consumer and remains reachable from the entry', () => {
  const graph = new Map();
  for (const [file, source] of sources) {
    const references = [...source.matchAll(/(['"])(\.\/[^'"\r\n]+\.js(?:\?[^'"\r\n]*)?)\1/g)].map(match => {
      const url = new URL(match[2], new URL(file, root));
      const target = decodeURIComponent(url.pathname.slice(root.pathname.length));
      if (refreshed.has(target) || retained.has(target)) {
        assert.equal(url.search, `?v=${refreshed.has(target) ? version : retained.get(target)}`, `${file} -> ${target}`);
        assert.equal(url.hash, '');
      }
      return target;
    });
    graph.set(file, references);
  }
  const reached = new Set();
  function visit(file) {
    if (reached.has(file)) return;
    reached.add(file);
    for (const next of graph.get(file) || []) visit(next);
  }
  visit('index.js');
  for (const file of [...refreshed, ...retained.keys()]) {
    assert.ok(files.includes(file), `${file} is included in the release`);
    assert.ok(reached.has(file), `${file} is reachable from the installed entry`);
  }
});

test('creative publication ships runtime only and retains unrelated shared module identities', async () => {
  assert.ok(files.every(file => !/(?:^|\/)(?:tests|scripts|Omniscene)\//i.test(file)));
  assert.ok(!files.some(file => /(?:审稿|开发大纲|进度清单|实测流程)/.test(file)));
  assert.ok(sources.get('qianmu-creative-runtime.js').includes("from './qianmu-storyboard-utils.js'"));
  const manifest = JSON.parse(await readFile(new URL('manifest.json', root), 'utf8'));
  const pkg = JSON.parse(await readFile(new URL('package.json', root), 'utf8'));
  assert.equal(pkg.version, version);
  assert.equal(manifest.version, version);
  assert.equal(manifest.js, `index.js?v=${version}`);
  assert.equal(manifest.css, `style.css?v=${version}`);
  assert.ok(sources.get('index.js').includes(`const VERSION = '${version}';`));
});
