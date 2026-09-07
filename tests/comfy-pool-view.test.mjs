import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { createComfyPoolCandidate, verifyComfyPoolCandidate, renderComfyPools } from '../qianmu-comfy-pool-view.js';
import { normalizeComfyClassification, COMFY_SELECTION_SCHEMA } from '../qianmu-comfy-selection.js';
import { recipesFixture, namespace } from './helpers/comfy-route-fixture.mjs';
import { storyboardFunctionSource as section } from './helpers/storyboard-form-fixture.mjs';
import { createStoryboardDefaults, normalizeStoryboardState } from '../qianmu-storyboard.js';
async function fixture() {
  const f = await recipesFixture(), recipe = structuredClone(f.recipes[0]);
  recipe.document.classification = normalizeComfyClassification({ version: 1, visualKinds: ['character'], castSizes: ['one'], contentClasses: ['sfw'], promptFormat: 'natural_language' });
  const choice = { recipe, roles: false, useReferences: false }, candidate = createComfyPoolCandidate({ namespace, choice, id: 'candidate-a' });
  const pool = { schema: COMFY_SELECTION_SCHEMA, namespace, id: 'pool-a', revision: 'pool-r1', enabled: false, styleLock: true, candidates: [candidate] };
  return { ...f, recipe, choice, candidate, pool };
}
test('new members copy only the chosen fixed-version classification, never graphs, workbench roles or enabled state', async () => {
  const f = await fixture(); assert.equal(f.candidate.enabled, false); assert.equal(f.candidate.target.comfyCharacterEnabled, false);
  assert.deepEqual(f.candidate.classification, f.recipe.document.classification); assert.notEqual(f.candidate.classification, f.recipe.document.classification);
  assert.equal(f.candidate.target.comfyWorkflowBinding.revision, f.recipe.binding.revision);
  assert.doesNotMatch(JSON.stringify(f.candidate), /class_type|%qianmu_prompt%/);
  const previous = structuredClone(f.candidate); previous.enabled = true; previous.priority = 5; previous.target.connectionPresetId = 'custom';
  const next = createComfyPoolCandidate({ namespace, choice: f.choice, previous });
  assert.equal(next.id, previous.id); assert.equal(next.priority, 5); assert.equal(next.target.connectionPresetId, 'custom'); assert.equal(next.enabled, false);
  assert.equal(previous.enabled, true);
});
test('legacy unclassified workflow is visible as incomplete rather than automatically enrolled', async () => {
  const f = await fixture(); delete f.recipe.document.classification;
  const candidate = createComfyPoolCandidate({ namespace, choice: f.choice });
  assert.equal(candidate.enabled, false); assert.equal(candidate.classification.promptFormat, '');
  await assert.rejects(() => verifyComfyPoolCandidate({ candidate, namespace, connections: [], readRecipe: async () => f.recipe }), /声明内容范围/);
});
test('existing references survive reselection, incompatible replacements reject, and explicit removal permits replacement', async () => {
  const f = await fixture(), refs = { version: 1, enabled: true, namespace, workflowHash: f.recipe.binding.workflowHash,
    items: [{ url: '/user/images/reference.png', name: 'ref', mime: 'image/png', bytes: 12, sha256: 'a'.repeat(64) }] };
  const candidate = createComfyPoolCandidate({ namespace, choice: { ...f.choice, useReferences: true, references: refs } });
  const previous = structuredClone(candidate), kept = createComfyPoolCandidate({ namespace, choice: f.choice, previous });
  assert.deepEqual(kept.target.comfyReferences, refs); assert.notEqual(kept.target.comfyReferences, refs);
  assert.throws(() => createComfyPoolCandidate({ namespace, choice: { ...f.choice, recipe: f.recipes[1] }, previous }), /参考图/);
  previous.target.comfyReferences = null;
  assert.equal(createComfyPoolCandidate({ namespace, choice: { ...f.choice, recipe: f.recipes[1] }, previous }).target.comfyWorkflowBinding.id, f.recipes[1].binding.id);
  assert.throws(() => createComfyPoolCandidate({ namespace: 'st-user:foreign', choice: f.choice }), /账户/);
  assert.throws(() => createComfyPoolCandidate({ namespace, choice: { ...f.choice, useReferences: true, references: null }, previous }), /没有已启用参考图/);
});
test('member verification requires matching fixed classification and known connection, and never grants execution readiness', async () => {
  const f = await fixture(); let reads = 0, guards = 0;
  const options = { candidate: f.candidate, namespace, connections: [], guard: async () => { guards++; }, readRecipe: async () => { reads++; return f.recipe; } };
  assert.match(await verifyComfyPoolCandidate(options), /执行资格将在生成前检查/); assert.ok(guards >= 3); assert.equal(reads, 1);
  f.candidate.classification.contentClasses = ['adult']; await assert.rejects(() => verifyComfyPoolCandidate(options), /分类与固定版本不符/);
  f.candidate.target.connectionPresetId = 'missing'; await assert.rejects(() => verifyComfyPoolCandidate(options), /API 预设已失效/); assert.equal(reads, 2);
});
test('late cancellation stops verification before a candidate can be returned to the editor', async () => {
  const f = await fixture(); let live = true;
  await assert.rejects(() => verifyComfyPoolCandidate({ candidate: f.candidate, namespace, connections: [],
    guard: async () => { if (!live) throw Error('page changed'); }, readRecipe: async () => { live = false; return f.recipe; } }), /page changed/);
});
test('candidate maintenance has no generate/apply button, exposes fields with safe names and no blank placeholder cards', async () => {
  const empty = renderComfyPools({ rows: [] }); assert.doesNotMatch(empty, /data-pool-id=|暂无/);
  const f = await fixture(); f.candidate.target.comfyWorkflowBinding.name = '<script>image</script>';
  const html = renderComfyPools({ draft: { name: 'plan', pool: f.pool }, openMembers: new Set([f.candidate.id]) });
  assert.doesNotMatch(html, /<script>|data-pool-action="(?:generate|apply|enable-auto)"/); assert.match(html, /&lt;script&gt;/);
  for (const field of ['connectionPresetId', 'priority']) assert.match(html, new RegExp(`data-pool-member-field="${field}"`));
  assert.match(html, /data-pool-action="toggle-roles"/); assert.match(html, /data-pool-action="toggle-member" aria-pressed="false"/);
  assert.match(html, /分类随固定版本/); assert.match(html, /自动运行尚未开放/);
});
test('imported or missing connection names are escaped and retained for explicit correction', async () => {
  const f = await fixture(); f.candidate.target.connectionPresetId = 'missing';
  const html = renderComfyPools({ draft: { name: 'plan', pool: f.pool }, connections: [{ id: 'known', name: '<img onerror=bad>' }] });
  assert.match(html, /value="missing" selected/); assert.match(html, /API 预设已失效/); assert.doesNotMatch(html, /<img onerror/);
});
test('candidate page has independent title/navigation/scroll key and restores only in Comfy mode', () => {
  const state = createStoryboardDefaults(); state.source = 'comfy'; state.view = 'comfy-pools';
  assert.equal(normalizeStoryboardState(state).view, 'comfy-pools');
  const c = vm.createContext({ storyboardState: () => state });
  vm.runInContext(['storyboardPageTitle', 'storyboardPageKey', 'renderStoryboardNav'].map(section).join('\n'), c);
  assert.equal(c.storyboardPageTitle(state), 'WORKFLOW CANDIDATES'); assert.equal(c.storyboardPageKey(state), 'comfy-pools');
  assert.match(c.renderStoryboardNav(state), /aria-current="page"[^>]+data-storyboard-view="create"/);
  state.source = 'novel'; assert.equal(normalizeStoryboardState(state).view, 'create');
});
test('index route-picker bridge captures reference ownership and guards late changes without mutating the workbench', async () => {
  const f = await fixture(), state = createStoryboardDefaults(); state.source = 'comfy'; state.view = 'comfy-pools';
  const before = structuredClone(state), picked = [];
  const c = vm.createContext({ clone: structuredClone, storyboardState: () => state, ctx: () => ({ Popup: 'test' }),
    featureRuntime: { load: async () => ({ openComfyRoutePicker: async options => { picked.push(options); return f.choice; } }) } });
  vm.runInContext(section('storyboardPickComfyPoolWorkflow'), c);
  const result = await c.storyboardPickComfyPoolWorkflow(state, { namespace, previous: f.candidate, guard: async () => {} });
  assert.equal(result.recipe, f.recipe); assert.equal(picked[0].binding, f.candidate.target.comfyWorkflowBinding); assert.deepEqual(state, before);
  c.featureRuntime.load = async () => ({ openComfyRoutePicker: async () => { state.profiles.comfy.comfyReferences = { changed: true }; return f.choice; } });
  await assert.rejects(() => c.storyboardPickComfyPoolWorkflow(state, { namespace, previous: null, guard: async () => {} }), /参考图已变化/);
});
test('candidate UI is lazy and all host lifecycle routes are connected without loading credentials', async () => {
  const index = await readFile(new URL('../index.js', import.meta.url), 'utf8');
  assert.match(index, /comfyPools:\s*\{[\s\S]*?load: \(\) => import\('\.\/qianmu-comfy-pool-view.js\?v=/);
  assert.match(section('storyboardEndSession'), /storyboardComfyPoolController\?\.detach/);
  assert.match(section('bindStoryboardTabEvents'), /storyboardMountComfyPools/);
  assert.match(section('storyboardMountComfyLibrary'), /onCandidates:/); assert.match(section('storyboardMountComfyPools'), /getScopeKey:/);
  assert.match(index, /storyboardComfyPoolController\?\.dispose\(\);\s*storyboardComfyPoolController = null/);
  const release = JSON.parse(await readFile(new URL('../release-files.json', import.meta.url), 'utf8')); assert.ok(release.files.includes('qianmu-comfy-pool-view.js'));
});
