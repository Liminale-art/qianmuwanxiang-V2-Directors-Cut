import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import * as storyboard from '../qianmu-storyboard.js';
import * as comfyRoutes from '../qianmu-comfy-route.js';
import { normalizeOpenAIImageCompatibility } from '../qianmu-openai-image-compat.js';
import { recipesFixture, namespace } from './helpers/comfy-route-fixture.mjs';
import { storyboardFunctionSource as section } from './helpers/storyboard-form-fixture.mjs';

const plain = value => JSON.parse(JSON.stringify(value));
const V3 = 'nai-diffusion-3', V5 = 'nai-diffusion-5-full';
function environment() {
  const state = storyboard.createStoryboardDefaults();
  Object.assign(state, { source: 'novel', view: 'assets', assetView: 'routing' });
  let activeState = state, account = namespace, chat = 'chat-a', options, choose = async () => null;
  const loads = [], mounts = [], context = vm.createContext({
    ...storyboard, clone: structuredClone, activeTab: 'imagegen', storyboardAdmissionEpoch: 1,
    storyboardState: () => activeState, getChatKey: () => chat, ctx: () => ({ chat: [] }),
    appearanceSession: { mountPortal: (...args) => { mounts.push(args); return () => {}; } },
    featureRuntime: { load: async key => { loads.push(key); assert.equal(key, 'comfyRoutes'); return routes; } },
  });
  const routes = { ...comfyRoutes, openComfyRoutePicker: async () => null };
  const identity = { resolveImageAccountNamespace: async () => account };
  const runtime = { openEnsembleTargetPicker: async value => { options = value; return choose(value); } };
  vm.runInContext(['storyboardConnectionState', 'storyboardProviderProfile', 'storyboardProfileSnapshot',
    'storyboardParameterPresets', 'storyboardResolveRoutingProfile', 'storyboardConfigureEnsembleTarget'].map(section).join('\n'), context);
  return { state, context, identity, routes, loads, mounts, get options() { return options; },
    setAccount: value => account = value, setChat: value => chat = value, setState: value => activeState = value,
    open: (target, callback = async () => null) => { choose = callback; return context.storyboardConfigureEnsembleTarget(state, runtime, identity, namespace, target); } };
}
const target = (providerId = 'novel', modelId = V5, extra = {}) => ({ providerId, modelId, capabilityModelId: modelId, connectionPresetId: '', parameterPresetId: '', ...extra });

test('actual target host exposes family-specific options and cancelling never commits a private draft', async () => {
  const e = environment(), original = target(), before = structuredClone(e.state);
  const result = await e.open(original, async options => {
    await options.guard();
    const draft = structuredClone(options.target); draft.modelId = V3;
    const validated = await options.validateTarget(draft);
    assert.equal(validated.target.capabilityModelId, V3);
    assert.equal(options.providers, storyboard.STORYBOARD_PROVIDER_REGISTRY);
    assert.equal(options.models('novel'), storyboard.STORYBOARD_MODEL_REGISTRY.novel);
    assert.deepEqual(plain(options.models('unknown')), []);
    assert.equal(options.connections('novel'), e.state.connections.novel.presets);
    assert.equal(options.defaultTarget('banana').modelId, e.state.profiles.banana.model);
    assert.ok(Array.isArray(options.parameterPresets(validated.target)));
    return null;
  });
  assert.equal(result, null); assert.deepEqual(original, target()); assert.deepEqual(e.state, before);
  assert.deepEqual(e.loads, [], 'ordinary edits do not import workflow code or request external services');
});

test('known models restore their real capability while third-party aliases retain the explicitly selected family capability', async () => {
  const e = environment(), before = structuredClone(e.state);
  for (const input of [target('novel', V3, { capabilityModelId: V5 }), target('novel', 'vendor/model-alias', { capabilityModelId: V3 })]) {
    const selected = await e.open(input, options => options.validateTarget(structuredClone(options.target)));
    const final = e.context.storyboardResolveRoutingProfile(e.state, selected.target);
    assert.equal(selected.target.modelId, input.modelId); assert.equal(selected.target.capabilityModelId, V3);
    assert.equal(final.model, input.modelId); assert.equal(final.capabilityModelId, V3);
    assert.equal(selected.artistCapable, true);
    assert.equal(selected.artistCapable, storyboard.getStoryboardCapabilities('novel', final.capabilityModelId, undefined, e.state.connections.novel.draft).supportsArtistSyntax);
  }
  assert.deepEqual(e.state, before);
});

test('selected API preset, not the current draft, determines protocol capability and the eventual provider plan', async () => {
  const e = environment();
  // A broken current draft must not replace a valid explicitly selected preset.
  e.state.connections.novel.draft = { protocol: 'openai-images' };
  e.state.connections.novel.presets = [{ id: 'native-nai', name: 'NAI', protocol: 'novelai', baseUrl: 'https://nai.example' }];
  const nai = await e.open(target('novel', V3, { connectionPresetId: 'native-nai' }), options => options.validateTarget(options.target));
  assert.equal(nai.artistCapable, true);
  const profile = e.context.storyboardResolveRoutingProfile(e.state, nai.target), connection = e.state.connections.novel.presets[0];
  const plan = storyboard.buildStoryboardProviderPlan({ providerId: 'novel', modelId: profile.model, capabilityModelId: profile.capabilityModelId, connection, prompt: 'garden' });
  assert.equal(plan.gatewayRequest.protocol, 'novelai');
  assert.equal(storyboard.getStoryboardCapabilities('novel', profile.capabilityModelId, undefined, connection).supportsArtistSyntax, nai.artistCapable);

  const model = e.state.profiles.banana.model;
  e.state.connections.banana.presets = [{ id: 'relay', name: 'Relay', protocol: 'openai-images', imageProtocolVersion: 1,
    baseUrl: 'https://relay.example', compatibility: normalizeOpenAIImageCompatibility({}) }];
  const compatible = await e.open(target('banana', model, { connectionPresetId: 'relay' }), options => options.validateTarget(options.target));
  assert.equal(compatible.artistCapable, false);
  const relayPlan = storyboard.buildStoryboardProviderPlan({ providerId: 'banana', modelId: model, connection: e.state.connections.banana.presets[0], prompt: 'garden' });
  assert.equal(relayPlan.gatewayRequest.protocol, 'openai-images');
  assert.equal(storyboard.getStoryboardCapabilities('banana', model, undefined, e.state.connections.banana.presets[0]).supportsArtistSyntax, compatible.artistCapable);
});

test('missing, duplicate or unsupported API selections are rejected before a target can be committed', async () => {
  for (const scenario of ['missing', 'duplicate', 'unsupported']) {
    const e = environment();
    e.state.connections.novel.presets = scenario === 'missing' ? [] : scenario === 'duplicate'
      ? [{ id: 'selection' }, { id: 'selection' }] : [{ id: 'selection', protocol: 'openai-images', imageProtocolVersion: 1 }];
    const before = structuredClone(e.state);
    await assert.rejects(e.open(target('novel', V5, { connectionPresetId: 'selection' }), options => options.validateTarget(options.target)), /预设|协议/);
    assert.deepEqual(e.state, before);
  }
});

test('invalid parameter presets fail via the actual final profile resolver, without mutating the target or state', async () => {
  const e = environment(), input = target('novel', V3, { parameterPresetId: 'removed' }), before = structuredClone(e.state);
  await assert.rejects(e.open(input, options => options.validateTarget(options.target)), /参数方案已失效/);
  assert.deepEqual(input, target('novel', V3, { parameterPresetId: 'removed' })); assert.deepEqual(e.state, before);
});

test('target validation fails closed for account, chat, epoch, state, tab and inner-page changes', async () => {
  for (const change of [e => e.setAccount('st-user:other'), e => e.setChat('chat-b'), e => e.context.storyboardAdmissionEpoch++,
    e => e.setState(storyboard.createStoryboardDefaults()), e => e.context.activeTab = 'world', e => e.state.assetView = 'tags']) {
    const e = environment(), input = target(), routing = structuredClone(e.state.routing);
    await assert.rejects(e.open(input, async options => { change(e); return options.validateTarget(options.target); }), /页面或账户已变化/);
    assert.deepEqual(e.state.routing, routing); assert.deepEqual(input, target());
  }
});

test('a page change during asynchronous account resolution is rechecked before returning the selected target', async () => {
  const e = environment(), before = structuredClone(e.state);
  e.identity.resolveImageAccountNamespace = async () => { e.context.storyboardAdmissionEpoch++; return namespace; };
  await assert.rejects(e.open(target(), options => options.validateTarget(options.target)), /页面或账户已变化/);
  assert.deepEqual(e.state, before);
});

const reference = recipe => ({ version: 1, enabled: true, namespace, workflowHash: recipe.binding.workflowHash,
  items: [{ url: '/user/images/test/reference.png', name: 'reference', mime: 'image/png', bytes: 8, sha256: 'a'.repeat(64) }] });

test('workflow editing keeps the bound reference ahead of workbench references and only returns a new draft', async () => {
  const f = await recipesFixture(), e = environment(), input = { ...f.routes[0], comfyReferences: reference(f.recipes[0]) };
  e.state.profiles.comfy.comfyReferences = { ...reference(f.recipes[1]), items: [] };
  const before = structuredClone(e.state), original = structuredClone(input);
  e.routes.openComfyRoutePicker = async options => {
    assert.equal(options.hasReferences, true); assert.equal(options.defaultUseReferences, true);
    assert.deepEqual(options.binding, input.comfyWorkflowBinding); await options.guard();
    return { recipe: f.recipes[0], useReferences: true };
  };
  const chosen = await e.open(input, async options => options.validateTarget(await options.pickWorkflow(structuredClone(options.target))));
  assert.deepEqual(plain(chosen.target.comfyReferences), original.comfyReferences);
  assert.notEqual(chosen.target.comfyReferences, input.comfyReferences);
  assert.equal(chosen.target.comfyCharacterEnabled, false); assert.equal(chosen.target.parameterPresetId, '');
  assert.deepEqual(e.state, before); assert.deepEqual(input, original);
});

test('workflow cancellation and a graph mismatch never discard the existing target or its reference', async () => {
  const f = await recipesFixture();
  for (const scenario of ['cancel', 'different-graph', 'account', 'page']) {
    const e = environment(), input = { ...f.routes[0], comfyReferences: reference(f.recipes[0]) }, original = structuredClone(input), routing = structuredClone(e.state.routing);
    e.routes.openComfyRoutePicker = async () => {
      if (scenario === 'cancel') return null;
      if (scenario === 'account') e.setAccount('st-user:other');
      if (scenario === 'page') e.context.activeTab = 'world';
      return { recipe: f.recipes[1], useReferences: true };
    };
    const operation = e.open(input, options => options.pickWorkflow(structuredClone(options.target)));
    if (scenario === 'cancel') assert.equal(await operation, null);
    else await assert.rejects(operation, /参考图.*不符|页面或账户已变化/);
    assert.deepEqual(input, original); assert.deepEqual(e.state.routing, routing);
  }
});

test('only explicit reference removal clears a bound reference; a missing optional field preserves it', async () => {
  const f = await recipesFixture();
  for (const useReferences of [false, undefined]) {
    const e = environment(), input = { ...f.routes[0], comfyReferences: reference(f.recipes[0]) }, original = structuredClone(input);
    e.routes.openComfyRoutePicker = async () => ({ recipe: f.recipes[0], ...(useReferences === undefined ? {} : { useReferences }) });
    const picked = await e.open(input, options => options.pickWorkflow(structuredClone(options.target)));
    assert.deepEqual(plain(picked.comfyReferences), useReferences === false ? null : input.comfyReferences);
    assert.deepEqual(input, original);
  }
});

test('workbench references are opt-in and a change during workflow selection is not silently accepted', async () => {
  const f = await recipesFixture(), e = environment(), input = f.routes[0];
  e.state.profiles.comfy.comfyReferences = reference(f.recipes[0]);
  e.routes.openComfyRoutePicker = async options => {
    assert.equal(options.hasReferences, true); assert.equal(options.defaultUseReferences, false);
    e.state.profiles.comfy.comfyReferences = reference(f.recipes[1]);
    return { recipe: f.recipes[0], useReferences: true };
  };
  const before = structuredClone(input);
  await assert.rejects(e.open(input, options => options.pickWorkflow(structuredClone(options.target))), /参考图已变化/);
  assert.deepEqual(input, before);
});
