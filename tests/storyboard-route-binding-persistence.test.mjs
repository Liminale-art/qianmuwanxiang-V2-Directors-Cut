import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeStoryboardState, resolveStoryboardProfileBinding } from '../qianmu-storyboard.js';

const V3 = 'nai-diffusion-3', V45 = 'nai-diffusion-4-5-full';
const target = { providerId: 'novel', modelId: 'relay/shared', capabilityModelId: V45, connectionPresetId: 'connection-a', parameterPresetId: 'style-a' };
function stateFor(value = target) {
  return normalizeStoryboardState({ routing: { styleLibrary:true, rules: [{ id: 'portrait', enabled: true, target: { ...value } }] } });
}

test('route aliases and both explicit references survive repeated save/reload normalization', () => {
  const first = stateFor(), restored = normalizeStoryboardState(JSON.parse(JSON.stringify(first)));
  assert.deepEqual(restored.routing, first.routing);
  assert.deepEqual(restored.routing.rules[0].target, target);
  assert.deepEqual(Object.keys(restored.routing).sort(),['rules','styleLibrary']);
});

test('retired router fields are discarded rather than retained as another source of model authority', () => {
  const state=stateFor();Object.assign(state.routing,{enabled:true,mode:'ensemble',frameStrategy:'montage',single:target});
  Object.assign(state.routing.rules[0],{priority:99,shotTypes:['portrait']});const restored=normalizeStoryboardState(state);
  assert.deepEqual(Object.keys(restored.routing).sort(),['rules','styleLibrary']);
  assert.equal(restored.routing.rules[0].priority,undefined);assert.equal(restored.routing.rules[0].shotTypes,undefined);
});

test('legacy canonical routes infer capability, not the legacy connection model', () => {
  const state = stateFor({ providerId: 'novel', modelId: V3 });
  assert.equal(state.routing.rules[0].target.modelId, V3);
  assert.equal(state.routing.rules[0].target.capabilityModelId, V3);
  const empty = stateFor({ providerId: 'openai' });
  assert.equal(empty.routing.rules[0].target.modelId, 'gpt-image-2');
  assert.equal(empty.routing.rules[0].target.capabilityModelId, 'gpt-image-2');
});

test('legacy custom OpenAI aliases remain custom without requiring a migration', () => {
  const state = stateFor({ providerId: 'openai', modelId: 'provider/custom' });
  assert.equal(state.routing.rules[0].target.modelId, 'provider/custom');
  assert.equal(state.routing.rules[0].target.capabilityModelId, 'gpt-image-2');
});

for (const [label, input] of [
  ['unbound alias', { modelId: 'relay/unknown', capabilityModelId: '' }],
  ['known model conflict', { modelId: V3, capabilityModelId: V45 }],
  ['cross-family capability', { capabilityModelId: 'gpt-image-2' }],
  ['malformed capability', { capabilityModelId: {} }],
  ['whitespace capability', { capabilityModelId: ' ' }],
  ['malformed model', { modelId: {} }],
  ['control character', { modelId: 'relay/\nshared' }],
  ['overlong model', { modelId: 'x'.repeat(241) }],
  ['blank explicit model', { modelId: ' ' }],
]) {
  test(`route normalization remains fail-closed after two reloads: ${label}`, () => {
    let state = stateFor({ ...target, ...input });
    state = normalizeStoryboardState(JSON.parse(JSON.stringify(state)));
    const route = state.routing.rules[0].target;
    assert.throws(() => resolveStoryboardProfileBinding(route.providerId, { model: route.modelId, capabilityModelId: route.capabilityModelId }));
    assert.equal(route.connectionPresetId, 'connection-a');
    assert.equal(route.parameterPresetId, 'style-a');
  });
}
