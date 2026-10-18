import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { collectReleaseFiles } from '../scripts/build-release.mjs';

const root = new URL('../', import.meta.url);
const version = '1.59.464';
const releaseVersion = '1.59.464';
const refreshed = new Set([
  'qianmu-creative-prompts.js', 'qianmu-creative-contract.js',
  'qianmu-creative-runtime.js',
]);
const retained = new Map([
  ['qianmu-creative-social.js', '1.59.460'],
  ['qianmu-director-leave-guard.js', '1.59.463'],
  ['qianmu-director-live.js', '1.59.458'],
  ['qianmu-theme-menu.js', '1.59.455'],
  ...['qianmu-model-response.js', 'qianmu-model-host.js', 'qianmu-model-external.js',
    'qianmu-prose-assistant-request.js', 'qianmu-prose-assistant-preferences.js', 'qianmu-prose-assistant-panel.js',
    'qianmu-prose-assistant-floor.js', 'qianmu-prose-floor-tools.js', 'qianmu-idle-preload.js'].map(file => [file, '1.59.452']),
  ['qianmu-hive-commands.js', '1.59.446'], ['qianmu-prose-hive.js', '1.59.446'],
  ['qianmu-appearance-session.js', '1.59.444'],
  ['qianmu-memory-context.js', '1.59.448'],
  ['qianmu-st-context-sources.js', '1.59.450'],
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
  assert.equal(pkg.version, releaseVersion);
  assert.equal(manifest.version, releaseVersion);
  assert.equal(manifest.js, `index.js?v=${releaseVersion}`);
  assert.equal(manifest.css, `style.css?v=${releaseVersion}`);
  assert.ok(files.includes('qianmu-creative-social.css'));
  for (const file of ['qianmu-director-leave-guard.js', 'qianmu-director-navigation.js', 'qianmu-director-save-confirmation.js', 'qianmu-director-host-state.js', 'qianmu-director-auto-refresh.js']) {
    assert.ok(files.includes(file), `${file} must ship with the frontend`);
    const query=file==='qianmu-director-leave-guard.js'?`?v=${retained.get(file)}`:'';
    assert.ok(sources.get('index.js').includes(`from './${file}${query}'`), `${file} is used by the real entry with a refreshed identity when updated`);
  }
  assert.match(await readFile(new URL('style.css', root), 'utf8'), /@import url\('\.\/qianmu-creative-social\.css\?v=1\.59\.458'\)/);
  assert.ok(sources.get('index.js').includes(`const VERSION = '${releaseVersion}';`));
});

test('world display refresh imports only pure helpers without splitting shared utility state', () => {
  const utility = 'qianmu-storyboard-utils.js';
  const versioned = [];
  for (const [file, source] of sources) {
    for (const match of source.matchAll(/import\s*\{([^}]+)\}\s*from\s*['"]\.\/qianmu-storyboard-utils\.js([^'"]*)['"]/g)) {
      const names = match[1].split(',').map(name => name.trim()).filter(Boolean);
      if (match[2]) versioned.push({ file, names, query: match[2] });
      else assert.ok(!names.includes('geoRelationLabel'), `${file} cannot expect new exports from an old cached utility`);
    }
  }
  assert.deepEqual(versioned, [{ file: 'index.js', names: ['heatTier', 'geoRelationLabel'], query: '?v=1.59.456' }]);
  assert.ok(files.includes(utility));
  assert.match(sources.get('index.js'), /import\s*\{[^}]*\buid\b[^}]*\}\s*from '\.\/qianmu-storyboard-utils\.js'/);
});
