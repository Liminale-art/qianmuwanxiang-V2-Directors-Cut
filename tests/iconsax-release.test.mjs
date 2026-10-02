import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {collectReleaseFiles} from '../scripts/build-release.mjs';
import {qianmuIconMarkup} from '../qianmu-icon-renderer.js';

const root = new URL('../', import.meta.url);
const ICONSAX_RELEASE = '1.59.417';
// Only the renderer's affected client import closure changes in this release.
// Unrelated backend, storage and provider modules retain their existing URLs.
const changedNodes = new Set([
  'index.js', 'qianmu-icon-renderer.js', 'qianmu-assistant-history-view.js',
  'qianmu-ensemble-ui.js', 'qianmu-ensemble-view.js', 'qianmu-idle-preload.js',
  'qianmu-prose-assistant-conversation-list.js', 'qianmu-prose-assistant-floor.js',
  'qianmu-prose-assistant-panel.js', 'qianmu-prose-floor-tools.js', 'qianmu-prose-hive.js',
  'qianmu-text-collection-capture.js', 'qianmu-text-collection-host.js',
  'qianmu-text-collection-image-dialog.js', 'qianmu-text-collection-organization-view.js',
  'qianmu-text-collection-owner.js', 'qianmu-text-collection-panel.js',
  'qianmu-text-collection-view.js', 'qianmu-hive-commands.js',
]);
const files = await collectReleaseFiles();
const sources = new Map(await Promise.all(files.filter(file => file.endsWith('.js'))
  .map(async file => [file, await readFile(new URL(file, root), 'utf8')])));

function localReferences(file, source) {
  // Includes static imports, dynamic imports, loadLocalChunk calls and preload
  // array entries. Merely changing a parent's URL cannot invalidate its child.
  return [...source.matchAll(/(['"])(\.\/[^'"\r\n]+\.js(?:\?[^'"\r\n]*)?)\1/g)]
    .map(match => {
      const url = new URL(match[2], new URL(file, root));
      return {target: decodeURIComponent(url.pathname.slice(root.pathname.length)), url};
    });
}

test('the complete affected icon import closure uses its own release URL, including idle preloads', () => {
  const inbound = new Set(), graph = new Map();
  for (const [file, source] of sources) {
    graph.set(file, localReferences(file, source));
    for (const {target, url} of graph.get(file)) {
      if (!changedNodes.has(target)) continue;
      assert.equal(url.search, `?v=${ICONSAX_RELEASE}`, `${file} -> ${target}: refresh the literal child URL, not only its parent`);
      assert.equal(url.hash, '', `${file} -> ${target}: no fragment-based cache aliases`);
      inbound.add(target);
    }
  }
  for (const file of changedNodes) {
    assert.ok(sources.has(file), `${file}: affected code must ship locally`);
    if (file !== 'index.js') assert.ok(inbound.has(file), `${file}: do not leave a detached or untested node in the closure`);
  }
  const visited = new Set();
  function visit(file) {
    if (visited.has(file)) return;
    visited.add(file);
    for (const {target} of graph.get(file) || []) visit(target);
  }
  visit('index.js');
  for (const file of changedNodes) assert.ok(visited.has(file), `${file}: reachable from the installed entry`);
  // This is deliberately not a whole-repository version bump.
  assert.ok([...graph.get('index.js')].some(({target, url}) => !changedNodes.has(target) && url.search === '?v=1.59.414'));
});

test('installed entry and both bundled styles use the icon release version', async () => {
  const manifest = JSON.parse(await readFile(new URL('manifest.json', root), 'utf8'));
  const packageJson = JSON.parse(await readFile(new URL('package.json', root), 'utf8'));
  assert.equal(manifest.version, ICONSAX_RELEASE);
  assert.equal(packageJson.version, manifest.version);
  assert.equal(manifest.js, `index.js?v=${ICONSAX_RELEASE}`);
  assert.equal(manifest.css, `style.css?v=${ICONSAX_RELEASE}`);
  assert.ok(sources.get('index.js').includes(`const VERSION = '${ICONSAX_RELEASE}';`));
  assert.ok(sources.get('index.js').includes('qianmu-theme-skins.css?v=${VERSION}'));
  for (const file of ['qianmu-theme-skins.css', 'qianmu-icon-renderer.js', 'THIRD_PARTY_NOTICES.md']) assert.ok(files.includes(file));
  assert.ok(!files.some(file => /^scripts\/(?:vendor|preview)-iconsax\.mjs$/.test(file)), 'development fetch/preview code is not a runtime dependency');
});

test('new filled geometry isolates paint while outer CSS keeps older cached line icons visible', async () => {
  const style = await readFile(new URL('style.css', root), 'utf8');
  const outer = style.match(/\.qm-glyph-icon > svg\.qm-glyph-svg\s*\{([^}]+)\}/)?.[1] || '';
  assert.match(outer, /\bstroke:\s*currentColor\s*;/, 'old direct paths still inherit their visible stroke');
  assert.match(style, /#story-director-modal \.sd-header-actions \.qm-glyph-svg\s*\{\s*stroke:\s*currentColor\s*!important;\s*\}/);
  const camera = qianmuIconMarkup('fa-camera');
  for (const variant of ['outline', 'bold', 'twotone']) {
    assert.ok(camera.includes(`<g data-qm-icon-variant="${variant}" fill="none" stroke="none">`), `${variant}: child paint must override inherited outer paint`);
  }
  assert.doesNotMatch(sources.get('qianmu-icon-renderer.js'), /<use\b|\bhref\s*=|fetch\(|XMLHttpRequest/);
});
