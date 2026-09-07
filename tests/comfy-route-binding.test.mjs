import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { normalizeComfyRouteBinding, retainComfyRouteBinding } from '../qianmu-comfy-route-contract.js';
import { pinComfyRouteWorkflow, readPinnedComfyRouteWorkflow } from '../qianmu-comfy-route.js';
import { normalizeStoryboardState, routeStoryboardShot } from '../qianmu-storyboard.js';
import { storyboardFunctionSource as section } from './helpers/storyboard-form-fixture.mjs';

const namespace = 'st-user:tester';
const selection = { id: 'workflow-a', revision: 'revision-one', version: 1 };
const graph = { text: { class_type: 'CLIPTextEncode', inputs: { text: '%qianmu_prompt%' } }, out: { class_type: 'SaveImage', inputs: { images: ['text', 0] } } };
const baseDocument = () => ({ workflow: JSON.stringify(graph), outputNodeId: 'out', parameters: { width: 832, count: 1 }, positivePrompt: 'quality', negativePrompt: 'blur' });
const copy = value => JSON.parse(JSON.stringify(value));
function fixture() {
  const f = { reads: [], opens: 0, closes: 0, guards: 0, document: baseDocument(),
    heads: [{ namespace, ...selection, name: '人物', archived: false }], versions: [{ namespace, ...selection, name: '人物' }] };
  f.options = { namespace, selection,
    guard: async () => { f.guards++; },
    createStore: () => { f.opens++; return {
      list: async ns => { f.reads.push(['list', ns]); return copy(f.heads); },
      versions: async (ns, id) => { f.reads.push(['versions', ns, id]); return copy(f.versions); },
      load: async (ns, id, revision) => { f.reads.push(['load', ns, id, revision]); return copy(f.document); },
      close: () => f.closes++,
      save: () => assert.fail('routing cannot write workflows'), archive: () => assert.fail('routing cannot archive'),
    }; },
  };
  return f;
}
async function binding() { return (await pinComfyRouteWorkflow(fixture().options)).binding; }

test('pinning captures a bounded lightweight identity and an immutable exact recipe without writes', async () => {
  const f = fixture(), before = copy(f.document), recipe = await pinComfyRouteWorkflow(f.options);
  assert.equal(recipe.binding.namespace, namespace); assert.deepEqual(recipe.binding.id, selection.id);
  assert.match(recipe.binding.workflowHash, /^[a-f0-9]{64}$/); assert.match(recipe.binding.recipeHash, /^[a-f0-9]{64}$/);
  assert.equal(recipe.document.parameters.width, '832'); assert.deepEqual(f.document, before);
  assert.ok(Object.isFrozen(recipe) && Object.isFrozen(recipe.binding) && Object.isFrozen(recipe.document.parameters));
  assert.deepEqual(f.reads.filter(row => row[0] === 'load'), [['load', namespace, selection.id, selection.revision]]);
  assert.equal(f.opens, 1); assert.equal(f.closes, 1); assert.equal(f.guards, 4);
  assert.ok(JSON.stringify(recipe.binding).length < 512); assert.doesNotMatch(JSON.stringify(recipe.binding), /class_type|quality|blur/);
});

test('pinned selection stays on its historical version after the library head advances', async () => {
  const f = fixture(), pin = await pinComfyRouteWorkflow(f.options);
  f.heads[0] = { ...f.heads[0], revision: 'revision-two', version: 2 };
  f.versions.push({ ...f.heads[0], name: 'new' });
  const restored = await readPinnedComfyRouteWorkflow({ ...f.options, binding: pin.binding });
  assert.equal(restored.binding.version, 1); assert.equal(restored.binding.revision, 'revision-one');
  assert.deepEqual(restored.document, pin.document); assert.ok(f.reads.filter(row => row[0] === 'load').every(row => row[3] === 'revision-one'));
});

for (const [field, change] of [
  ['graph', f => { const changed = copy(graph); changed.text.inputs.text += ' other'; f.document.workflow = JSON.stringify(changed); }],
  ['parameters', f => f.document.parameters.width = 1024], ['positive addition', f => f.document.positivePrompt = 'different'],
  ['negative addition', f => f.document.negativePrompt = 'other'], ['output', f => f.document.outputNodeId = 'text'],
]) test(`pinned ${field} change is rejected, never repaired or replaced with the current workbench`, async () => {
  const f = fixture(), pin = await pinComfyRouteWorkflow(f.options); change(f);
  await assert.rejects(readPinnedComfyRouteWorkflow({ ...f.options, binding: pin.binding }), { code: 'comfy_route_binding', submissionState: 'not_submitted' });
  assert.equal(f.opens, f.closes);
});

for (const [name, change] of [
  ['archived', f => f.heads[0].archived = true], ['missing head', f => f.heads = []],
  ['missing version', f => f.versions = []], ['missing graph', f => f.document = null],
  ['foreign index', f => f.heads[0].namespace = 'st-user:other'], ['foreign version', f => f.versions[0].namespace = 'st-user:other'],
  ['wrong version number', f => f.versions[0].version = 2],
]) test(`${name} prevents fixed-workflow preparation`, async () => {
  const f = fixture(); change(f);
  await assert.rejects(pinComfyRouteWorkflow(f.options), { code: 'comfy_route_binding' }); assert.equal(f.opens, f.closes);
});

test('cross-account binding and malformed selection are rejected before storage is opened', async () => {
  const f = fixture(), pin = await binding();
  await assert.rejects(readPinnedComfyRouteWorkflow({ ...f.options, namespace: 'st-user:other', binding: pin }), { code: 'comfy_route_binding' });
  for (const ns of ['', 'st-user:', 'st-user: name', 'st-user:a\n', 'st-user:' + 'a'.repeat(240), 'other']) {
    await assert.rejects(pinComfyRouteWorkflow({ ...f.options, namespace: ns }), { code: 'comfy_route_binding' });
  }
  for (const bad of [{ ...selection, id: '../x' }, { ...selection, revision: '' }, { ...selection, version: 1.5 }, { ...selection, version: 65 }]) {
    await assert.rejects(pinComfyRouteWorkflow({ ...f.options, selection: bad }), { code: 'comfy_route_binding' });
  }
  assert.equal(f.opens, 0);
});

test('bad metadata is not truncated or silently downgraded; extraneous secrets and workflows are stripped', async () => {
  const good = await binding();
  for (const change of [{ schemaVersion: 2 }, { recipeHash: 'x' }, { workflowHash: 'A'.repeat(64) }, { name: 'x'.repeat(81) }, { name: 'x\n' }, { version: '1' }]) {
    assert.throws(() => normalizeComfyRouteBinding({ ...good, ...change }), { code: 'comfy_route_binding' });
    assert.deepEqual(retainComfyRouteBinding({ ...good, ...change }), { invalid: true });
  }
  assert.deepEqual(normalizeComfyRouteBinding({ ...good, apiKey: 'secret', workflow: graph, url: 'private' }), good);
  assert.equal(retainComfyRouteBinding(null), null);
});

test('late account/page changes stop reads and always close the store', async () => {
  for (const stop of [1, 2, 3, 4]) {
    const f = fixture(); f.options.guard = async () => { if (++f.guards === stop) throw Error('changed'); };
    await assert.rejects(pinComfyRouteWorkflow(f.options), /changed/); assert.equal(f.opens, f.closes);
  }
});

test('caller selection changes during preparation cannot retarget the captured version', async () => {
  const f = fixture(); f.options.selection = { ...selection };
  f.options.guard = async () => { if (++f.guards === 1) f.options.selection.revision = 'other'; };
  const result = await pinComfyRouteWorkflow(f.options); assert.equal(result.binding.revision, selection.revision);
});

test('archiving during hashing is detected before a recipe is handed to the caller', async () => {
  const f = fixture(); f.options.guard = async () => { if (++f.guards === 3) f.heads = []; };
  await assert.rejects(pinComfyRouteWorkflow(f.options), { code: 'comfy_route_binding' }); assert.equal(f.opens, f.closes);
});

test('recipe errors and rejected storage reads do not leak a live database handle', async () => {
  const f = fixture(); f.document.workflow = JSON.stringify({ a: { class_type: 'X', inputs: { api_key: 'secret' } } });
  await assert.rejects(pinComfyRouteWorkflow(f.options), { code: 'comfy_library_sensitive_fields' }); assert.equal(f.opens, f.closes);
  let closed = 0;
  await assert.rejects(pinComfyRouteWorkflow({ namespace, selection, createStore: () => ({
    list: async () => { throw Error('storage unavailable'); }, versions: async () => [], load: async () => null, close: () => closed++,
  }) }), /storage unavailable/); assert.equal(closed, 1);
});

test('route normalization retains only explicit Comfy bindings and preserves old unbound routes', async () => {
  const good = await binding();
  const state = normalizeStoryboardState({ routing: { enabled: true, rules: [{ id: 'one', shotTypes: ['portrait'], target: {
    providerId: 'comfy', modelId: 'comfy-workflow', comfyWorkflowBinding: good,
  } }] } });
  assert.deepEqual(routeStoryboardShot({ shotType: 'portrait' }, state.routing).comfyWorkflowBinding, good);
  const original = normalizeStoryboardState({ routing: { enabled: true, rules: [{ id: 'one', target: { providerId: 'comfy', modelId: 'comfy-workflow' } }] } });
  assert.equal(Object.hasOwn(original.routing.rules[0].target, 'comfyWorkflowBinding'), false);
  state.routing.rules[0].target.comfyWorkflowBinding = { invalid: true };
  assert.deepEqual(normalizeStoryboardState(state).routing.rules[0].target.comfyWorkflowBinding, { invalid: true });
  state.routing.rules[0].target.providerId = 'novel'; state.routing.rules[0].target.modelId = 'nai-diffusion-5-full';
  assert.equal(Object.hasOwn(normalizeStoryboardState(state).routing.rules[0].target, 'comfyWorkflowBinding'), false);
});

test('actual synchronous resolver cannot silently execute a pinned route through today’s Comfy profile', async () => {
  const context = vm.createContext({}); vm.runInContext(section('storyboardResolveRoutingProfile'), context);
  for (const reference of [await binding(), { invalid: true }]) {
    assert.throws(() => context.storyboardResolveRoutingProfile({}, { providerId: 'comfy', comfyWorkflowBinding: reference }), { code: 'comfy_route_binding' });
  }
});
