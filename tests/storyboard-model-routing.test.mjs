import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  STORYBOARD_MODEL_REGISTRY,
  createStoryboardDefaults,
  normalizeStoryboardState,
} from '../qianmu-storyboard.js';

const browserSource = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8');
const routeSource = fs.readFileSync(new URL('../qianmu-ensemble-route-view.js', import.meta.url), 'utf8');
const ensembleSource = fs.readFileSync(new URL('../qianmu-ensemble-view.js', import.meta.url), 'utf8');

assert.deepEqual(
  STORYBOARD_MODEL_REGISTRY.novel.map((item) => item.id),
  [
    'nai-diffusion-3',
    'nai-diffusion-4-curated-preview',
    'nai-diffusion-4-full',
    'nai-diffusion-4-5-curated',
    'nai-diffusion-4-5-full',
    'nai-diffusion-5-curated',
    'nai-diffusion-5-full',
  ],
  'NovelAI must expose only Anime V3 and later families',
);
assert.ok(STORYBOARD_MODEL_REGISTRY.novel.find((item) => item.id === 'nai-diffusion-5-full').label.includes('💕'));
assert.ok(!STORYBOARD_MODEL_REGISTRY.novel.find((item) => item.id === 'nai-diffusion-5-curated').label.includes('💕'));

const defaults = createStoryboardDefaults();
assert.deepEqual(defaults.routing,{rules:[]},'only explicit style target bindings remain');
assert.equal(STORYBOARD_MODEL_REGISTRY.novel.find((item) => item.id === 'nai-diffusion-5-full').capabilities.contentPolicy, 'full');
assert.equal(STORYBOARD_MODEL_REGISTRY.novel.find((item) => item.id === 'nai-diffusion-5-curated').capabilities.contentPolicy, 'filtered');

assert.doesNotMatch(browserSource,/routeStoryboardShot|routing\.single/,'the obsolete shot-type engine is not injected into either generation path');

const normalized = normalizeStoryboardState({
  schemaVersion: 4,
  source: 'novel',
  connections: {
    novel: {
      presets: [
        { id: 'v45-api', model: 'nai-diffusion-4-5-full', name: 'V4.5' },
        { id: 'v5-api', model: 'nai-diffusion-5-full', name: 'V5' },
      ],
    },
  },
  parameterPresets: [
    { id: 'v45-style', source: 'novel', profile: { model: 'nai-diffusion-4-5-full' } },
    { id: 'v5-style', source: 'novel', profile: { model: 'nai-diffusion-5-full' } },
  ],
  routing: {
    enabled: true,
    rules: [{
      id: 'route',
      target: { providerId: 'novel', modelId: 'nai-diffusion-4-5-full', connectionPresetId: 'v5-api', parameterPresetId: 'v5-style' },
    }],
  },
});
assert.equal(normalized.routing.rules[0].target.connectionPresetId, 'v5-api', 'a channel preset must remain selectable across models in the same provider');
assert.equal(normalized.routing.rules[0].target.parameterPresetId, 'v5-style', 'an incompatible reference stays visible for repair and must be rejected at task preflight');
assert.equal(Object.hasOwn(normalized.routing.rules[0], 'sensitive'), false, 'content sensitivity is internal metadata, not a routing switch');

assert.doesNotMatch(browserSource, /modelPresets[\s\S]*item\.model === profile\.model/, 'API presets must not be filtered by concrete model');
assert.match(browserSource, /const channelPresets = connection\.group\?\.presets \|\| \[\]/, 'API presets must be listed by image channel');
assert.match(browserSource, /const legacy = profileOverride \|\| state\.profiles\[providerId\][\s\S]*resolveStoryboardProfileBinding\(providerId, legacy\)/, 'the selected image model must come from drawing settings, not the connection preset');
assert.doesNotMatch(browserSource, /data-storyboard-routing-mode=/, 'the old single-model versus ensemble selector must be removed');
assert.doesNotMatch(routeSource, /sd-storyboard-routing-enabled|添加绘制线路/, 'the unpublished routing editor is removed');
assert.match(ensembleSource, /data-ensemble-action="enabled"/, 'native styles use the per-chat enable control');
assert.match(browserSource, /renderEnsembleRoutePanel\(/, 'the production entry must mount the scheme library');
assert.match(browserSource, /configureTarget:[\s\S]*?storyboardConfigureEnsembleTarget/, 'each scheme directly configures its own model or workflow');
assert.doesNotMatch(browserSource, /sd-storyboard-route-rating|仅 SFW|仅 NSFW/, 'the configuration UI must not expose redundant SFW/NSFW routing states');
assert.doesNotMatch(routeSource, /受限制模型|安全但叙事一致/, 'implementation policy is not a permanent user instruction');
assert.match(browserSource, /function storyboardAdaptShotForModel[\s\S]*contentPolicy[\s\S]*safePrompt/, 'filtered models must receive the compiler-provided safe narrative equivalent');
assert.match(browserSource, /function renderStoryboardParameterVibes[\s\S]*!capabilities\.supportsVibe[\s\S]*sd-vibe-workbench-strip/, 'only capable workbenches show Vibe selection entries; unsupported families can still manage the independent library');
assert.match(browserSource, /modelId: route\.modelId[\s\S]*connectionPresetId: route\.connectionPresetId/, 'the routed concrete model must reach the generation job');

console.log('Storyboard model and routing contract OK');
