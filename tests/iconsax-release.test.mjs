import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {collectReleaseFiles} from '../scripts/build-release.mjs';
import {qianmuIconMarkup} from '../qianmu-icon-renderer.js';

const root = new URL('../', import.meta.url);
const ICONSAX_RELEASE = '1.59.419';
// The installed entry/style follow the current release.
const CURRENT_RELEASE = '1.59.496';
const localLoaderClosure = new Set(['index.js', 'qianmu-feature-runtime.js', 'qianmu-focus-library-runtime.js',
  'qianmu-idle-preload.js', 'qianmu-prose-assistant-floor.js', 'qianmu-prose-floor-tools.js',
  'qianmu-text-collection-owner.js', 'qianmu-text-collection-host.js']);
// 2026-11-08 stamp unification: every importer of a module now shares that module's newest
// address, so each changed node has exactly one expected stamp regardless of its parent.
const unifiedRelease = new Map([
  ['qianmu-icon-renderer.js', '1.59.478'], ['qianmu-creative-social.js', '1.59.460'],
  ['qianmu-storyboard-capture-view.js', '1.59.484'], ['qianmu-idle-preload.js', '1.59.484'],
  ['qianmu-prose-floor-tools.js', '1.59.484'], ['qianmu-text-collection-host.js', '1.59.484'],
  ['features/tts/qianmu-tts-floor-ui.js', '1.59.484'], ['qianmu-prose-assistant-floor.js', '1.59.452'],
  ['qianmu-prose-assistant-panel.js', '1.59.452'], ['qianmu-prose-hive.js', '1.59.494'],
  ['qianmu-prose-floor-entries.js', '1.59.440'], ['qianmu-main-tabs.js', '1.59.421'],
]);
const moduleRelease = file => unifiedRelease.get(file) || (localLoaderClosure.has(file) ? '1.59.425' : ICONSAX_RELEASE);
// Refresh the real reverse import closure of changed client modules, including
// both consumers of the shared notes facade. Comment-only store edits do not
// change its runtime identity; unrelated backend/provider URLs also stay put.
const functionalNodes = new Set([
  'index.js', 'qianmu-icon-renderer.js', 'qianmu-main-tabs.js',
  'qianmu-creative-social.js',
  'qianmu-feature-runtime.js',
  'qianmu-notes.js', 'qianmu-notes-panel-sync.js', 'qianmu-notes-sync-runtime.js',
  'qianmu-prose-floor-entries.js', 'qianmu-text-collection-floor.js', 'features/tts/qianmu-tts-floor-ui.js',
]);
const changedNodes = new Set([
  'index.js', 'qianmu-icon-renderer.js', 'qianmu-assistant-history-view.js',
  'qianmu-creative-social.js',
  'qianmu-feature-runtime.js', 'qianmu-focus-library-runtime.js',
  'qianmu-storyboard-capture-view.js',
  'qianmu-ensemble-ui.js', 'qianmu-ensemble-view.js', 'qianmu-idle-preload.js',
  'qianmu-main-tabs.js', 'qianmu-notes.js', 'qianmu-notes-panel-sync.js',
  'qianmu-notes-sync-runtime.js',
  'qianmu-prose-assistant-conversation-list.js', 'qianmu-prose-assistant-floor.js',
  'qianmu-prose-assistant-panel.js', 'qianmu-prose-floor-tools.js', 'qianmu-prose-hive.js',
  'qianmu-text-collection-capture.js', 'qianmu-text-collection-host.js',
  'qianmu-text-collection-image-dialog.js', 'qianmu-text-collection-organization-view.js',
  'qianmu-text-collection-owner.js', 'qianmu-text-collection-panel.js',
  'qianmu-text-collection-view.js', 'qianmu-prose-floor-entries.js',
  'qianmu-text-collection-floor.js', 'features/tts/qianmu-tts-floor-ui.js',
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

test('affected modules use their intended release URL without duplicating shared notes or refreshing unchanged icons', () => {
  const inbound = new Set(), graph = new Map();
  for (const [file, source] of sources) {
    graph.set(file, localReferences(file, source));
    for (const {target, url} of graph.get(file)) {
      if (!changedNodes.has(target)) continue;
      assert.equal(url.search, `?v=${moduleRelease(target)}`, `${file} -> ${target}: refresh the literal child URL, not only its parent`);
      assert.equal(url.hash, '', `${file} -> ${target}: no fragment-based cache aliases`);
      inbound.add(target);
    }
  }
  for (const file of changedNodes) {
    assert.ok(sources.has(file), `${file}: affected code must ship locally`);
    if (file !== 'index.js') assert.ok(inbound.has(file), `${file}: do not leave a detached or untested node in the closure`);
  }
  // The font library (added after this release) imports the icon renderer at its own v470 address.
  const laterConsumers = new Set(['qianmu-font-library-view.js', 'qianmu-font-library.js']);
  const expectedClosure = new Set(functionalNodes);
  let grew = true;
  while (grew) {
    grew = false;
    for (const [file, refs] of graph) {
      if (!expectedClosure.has(file) && !laterConsumers.has(file) && refs.some(({target}) => expectedClosure.has(target))) {
        expectedClosure.add(file);
        grew = true;
      }
    }
  }
  assert.deepEqual([...changedNodes].sort(), [...expectedClosure].sort(), 'only the actual changed client modules and their parent closure need new URLs');
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
  assert.ok([...graph.get('index.js')].some(({target, url}) => target === 'qianmu-hive-commands.js' && url.search === '?v=1.59.477'), 'creative commands keep their own address (refreshed in b9c4b65b, not by this release)');
  for (const file of ['index.js', 'qianmu-notes-panel-sync.js']) {
    const notes = graph.get(file).find(({target}) => target === 'qianmu-notes.js');
    assert.equal(notes?.url.search, `?v=${ICONSAX_RELEASE}`, `${file}: notes facade must not become a second singleton`);
  }
  assert.ok(!changedNodes.has('qianmu-notes-sync-store.js'));
  for (const refs of graph.values()) {
    for (const {target, url} of refs) {
      if (target === 'qianmu-notes-sync-store.js') assert.equal(url.search, '', 'comment-only notes store retains its existing shared module URL');
    }
  }
});

test('installed entry and styles use their actual release addresses while unchanged icon modules retain their URL', async () => {
  const manifest = JSON.parse(await readFile(new URL('manifest.json', root), 'utf8'));
  const packageJson = JSON.parse(await readFile(new URL('package.json', root), 'utf8'));
  assert.equal(manifest.version, CURRENT_RELEASE);
  assert.equal(packageJson.version, manifest.version);
  // Same-release hotfixes append a cache suffix (e.g. -tts-font-1) after the release stamp.
  assert.match(manifest.js, new RegExp(`^index\\.js\\?v=${CURRENT_RELEASE.replace(/\./g, '\\.')}(?:-[a-z0-9-]+)?$`));
  assert.match(manifest.css, new RegExp(`^style\\.css\\?v=${CURRENT_RELEASE.replace(/\./g, '\\.')}(?:-[a-z0-9-]+)?$`));
  assert.ok(sources.get('index.js').includes(`const VERSION = '${CURRENT_RELEASE}';`));
  assert.ok(sources.get('index.js').includes('qianmu-theme-skins.css?v=${VERSION}'));
  for (const file of ['qianmu-theme-skins.css', 'qianmu-icon-renderer.js', 'THIRD_PARTY_NOTICES.md']) assert.ok(files.includes(file));
  assert.ok(!files.some(file => /^scripts\/(?:(?:vendor|preview)-iconsax|iconsax-selected-sources)\.mjs$/.test(file)), 'development fetch/preview and attachment source code are not runtime dependencies');
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
