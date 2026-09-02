import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  STORYBOARD_SCHEMA_VERSION,
  STORYBOARD_SHOT_GROUP_TEMPLATES,
  createStoryboardDefaults,
  getStoryboardCapabilities,
  normalizeStoryboardState,
  routeStoryboardShot,
} from '../qianmu-storyboard.js';

const source = await readFile(new URL('../index.js', import.meta.url), 'utf8');
const css = await readFile(new URL('../style.css', import.meta.url), 'utf8');

assert.equal(STORYBOARD_SCHEMA_VERSION, 22);
assert.deepEqual(Object.keys(STORYBOARD_SHOT_GROUP_TEMPLATES), ['smart', 'threeBeat', 'dialogue', 'action', 'atmosphere']);

const defaults = createStoryboardDefaults();
assert.equal(defaults.enabled, false, 'the master switch remains off until the user enables storyboard generation');
assert.deepEqual(defaults.automation, { autoCapture: true, autoGenerate: true }, 'once enabled, new installations use the unobtrusive automatic flow');
assert.equal(defaults.promptCompiler.enabled, true);
assert.equal(defaults.routing.templateId, 'smart');
assert.equal(defaults.routing.maxShotsPerFloor, 3);
assert.equal(defaults.collapsedCards.prompt, true, 'advanced controls start collapsed');

const preservedManualMode = normalizeStoryboardState({
  schemaVersion: 6,
  automation: { autoCapture: false, autoGenerate: false },
  routing: {
    enabled: true,
    templateId: 'dialogue',
    rules: [{ id: 'legacy', sensitive: true, shotTypes: ['portrait'], target: { providerId: 'openai', modelId: 'gpt-image-2' } }],
  },
});
assert.deepEqual(preservedManualMode.automation, { autoCapture: false, autoGenerate: false }, 'upgrades must not silently start paid requests for existing manual users');
assert.equal(preservedManualMode.routing.templateId, 'dialogue');
assert.equal(Object.hasOwn(preservedManualMode.routing.rules[0], 'sensitive'), false);

assert.equal(getStoryboardCapabilities('novel', 'nai-diffusion-5-full').contentPolicy, 'full');
assert.equal(getStoryboardCapabilities('novel', 'nai-diffusion-5-curated').contentPolicy, 'filtered');
assert.equal(getStoryboardCapabilities('openai', 'gpt-image-2').contentPolicy, 'filtered');
assert.equal(getStoryboardCapabilities('comfy', 'comfy-workflow').contentPolicy, 'custom');

const route = routeStoryboardShot({ shotType: 'closeup', sensitive: true }, {
  enabled: true,
  rules: [{ id: 'closeup', sensitive: false, shotTypes: ['closeup'], target: { providerId: 'openai', modelId: 'gpt-image-2' } }],
});
assert.equal(route.ruleId, 'closeup', 'model assignment depends on cinematic role, not a visible content-rating switch');

assert.match(source, /should_generate[\s\S]*纯状态说明[\s\S]*避免打断正文与刷屏/, 'the compiler must silently skip replies without new visual value');
assert.match(source, /safe_prompt[\s\S]*安全、非露骨但叙事等价/, 'the compiler must prepare a safe narrative equivalent in the same pass');
assert.match(source, /STORYBOARD_SHOT_GROUP_TEMPLATES[\s\S]*groupTemplate\.instruction/, 'the selected cinematic template must guide shot planning');
assert.match(source, /function storyboardAdaptShotForModel[\s\S]*policy !== 'filtered'[\s\S]*shot\.safePrompt/, 'only known filtered models receive the safe equivalent');
assert.match(source, /const storyboardActiveJobs = new Map\(\)/);
assert.match(source, /storyboardActiveJobs\.size < concurrency[\s\S]*storyboardRunQueuedJob/, 'configured generation concurrency must control real workers');
assert.doesNotMatch(source, /const latestFloor = storyboardCurrentAssistantFloor\(\);[\s\S]*byFloor\.set\(latestFloor/, 'an empty storyboard strip must not appear under every reply');
const inlineRender = source.slice(source.indexOf('function storyboardRenderInlineImages'), source.indexOf('function storyboardScheduleInlineRender'));
assert.match(inlineRender, /plan\.origin !== 'manual_supplement'/, 'only an explicitly requested manual supplement may expose an intermediate placeholder');
assert.doesNotMatch(inlineRender, /plan\.origin === 'automatic'[\s\S]*is-pending/, 'automatic intermediate states stay out of the immersive chat surface');
assert.match(source, /data-storyboard-chat-action="edit"[\s\S]*data-storyboard-chat-action="redraw"/, 'completed images retain edit and redraw escape hatches');
assert.match(source, /sd-storyboard-safety-notice[\s\S]*不在生成结果下重复提示/);
assert.match(css, /\.sd-storyboard-safety-notice/);

console.log('Storyboard v7 automatic experience contract OK');
