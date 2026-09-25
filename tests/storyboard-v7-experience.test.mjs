import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  STORYBOARD_SCHEMA_VERSION,
  aggregateStoryboardShotTasks,
  createStoryboardDefaults,
  getStoryboardCapabilities,
  normalizeStoryboardState,
  planStoryboardProviderRequests,
  storyboardPartialCompletion,
  storyboardPartialPlanMap,
  storyboardInlinePartialCompletion,
} from '../qianmu-storyboard.js';

const source = await readFile(new URL('../index.js', import.meta.url), 'utf8');
const routeSource = await readFile(new URL('../qianmu-ensemble-route-view.js', import.meta.url), 'utf8');
const css = await readFile(new URL('../style.css', import.meta.url), 'utf8');
const contractSource = await readFile(new URL('../qianmu-storyboard-contract.js', import.meta.url), 'utf8');

assert.equal(STORYBOARD_SCHEMA_VERSION, 24);
assert.doesNotMatch(source, /STORYBOARD_SHOT_GROUP_TEMPLATES/);

const defaults = createStoryboardDefaults();
assert.equal(defaults.enabled, false, 'the master switch remains off until the user enables storyboard generation');
assert.deepEqual(defaults.automation, { autoGenerate: true, streamEnabled: false }, 'once enabled, new installations use ordinary automatic flow, never streaming without opt-in');
assert.equal(defaults.promptCompiler.enabled, true);
assert.equal(defaults.routing.templateId, undefined);
assert.equal(defaults.routing.confirmMultipleRequests, undefined);
assert.equal(defaults.generationPolicy.maxImages, 3);
assert.equal(defaults.routing.maxShotsPerFloor, undefined, 'image budget is no longer owned by shot groups');
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
assert.deepEqual(preservedManualMode.automation, { autoGenerate: false, streamEnabled: false }, 'upgrades must not silently start paid requests for existing manual users');
assert.equal(preservedManualMode.routing.templateId, undefined);
assert.equal(Object.hasOwn(preservedManualMode.routing.rules[0], 'sensitive'), false);

assert.equal(getStoryboardCapabilities('novel', 'nai-diffusion-5-full').contentPolicy, 'full');
assert.equal(getStoryboardCapabilities('novel', 'nai-diffusion-5-curated').contentPolicy, 'filtered');
assert.equal(getStoryboardCapabilities('openai', 'gpt-image-2').contentPolicy, 'filtered');
assert.equal(getStoryboardCapabilities('comfy', 'comfy-workflow').contentPolicy, 'custom');

assert.deepEqual(planStoryboardProviderRequests('novel', 3), [
  { requestIndex: 1, requestTotal: 3, imageCount: 1 },
  { requestIndex: 2, requestTotal: 3, imageCount: 1 },
  { requestIndex: 3, requestTotal: 3, imageCount: 1 },
]);
assert.deepEqual(planStoryboardProviderRequests('openai', 3), [
  { requestIndex: 1, requestTotal: 1, imageCount: 3 },
]);
assert.deepEqual(aggregateStoryboardShotTasks([
  { id: 'a', status: 'completed', resultIds: ['image-a'] },
  { id: 'b', status: 'failed', error: 'rate limited' },
], 'failed'), {
  status: 'completed', resultIds: ['image-a'], error: 'rate limited', partialFailureCount: 1,
}, 'a later NAI failure must not hide an earlier independently persisted image');
assert.equal(aggregateStoryboardShotTasks([
  { id: 'a', status: 'completed', resultIds: ['image-a'] },
  { id: 'b', status: 'queued' },
], 'queued').status, 'queued', 'a shared shot remains active until every split request settles');
assert.equal(storyboardPartialCompletion({status:'completed',shots:[{status:'completed'},{status:'queued'}]}),null);
assert.equal(storyboardPartialCompletion({status:'compiling',shots:[{status:'completed'},{status:'failed'}]}),null,'re-extraction must not show an old terminal badge');
assert.equal(storyboardPartialCompletion({status:'failed',shots:[{status:'failed'},{status:'cancelled'}]}),null);
assert.deepEqual(storyboardPartialCompletion({status:'completed',shots:[{status:'completed'},{status:'failed'},{status:'cancelled'}]}),{
  completedCount:1,incompleteCount:2,failedRequestCount:0,totalCount:3,label:'部分完成 · 2 镜未完成',
});
assert.equal(storyboardPartialCompletion({status:'completed',shots:[{status:'completed',partialFailureCount:1}]}).label,'部分完成 · 1 次出图未完成');
assert.equal(storyboardPartialCompletion({status:'completed',shots:[{status:'completed'}]}),null);
assert.equal(storyboardInlinePartialCompletion([{planId:'old'},{planId:'old'},{planId:'new'}],[
  {id:'new',status:'completed',shots:[{status:'completed'},{status:'cancelled'}]},
  {id:'old',status:'completed',shots:[{status:'completed',partialFailureCount:1}]},
])?.label,'部分完成 · 1 镜未完成，1 次出图未完成','linked same-paragraph plans aggregate without duplicate labels');
const sameIdPlans = [
  {id:'shared',chatKey:'other-chat',status:'completed',shots:[{status:'completed'},{status:'failed'}]},
  {id:'shared',chatKey:'current-chat',status:'completed',shots:[{status:'completed'},{status:'cancelled'}]},
];
assert.equal(storyboardPartialPlanMap(sameIdPlans,'current-chat').get('shared'),sameIdPlans[1],
  'an inline partial badge cannot borrow a same-ID plan from another chat');
assert.equal(storyboardPartialPlanMap(sameIdPlans,'missing-chat').size,0);
assert.equal(storyboardInlinePartialCompletion([{planId:'old'},{planId:'new'},{planId:'new'}],new Map([
  ['old',{id:'old',status:'completed',shots:[{status:'completed',partialFailureCount:1}]}],
  ['new',{id:'new',status:'completed',shots:[{status:'completed'},{status:'failed'}]}],
]))?.label,'部分完成 · 1 镜未完成，1 次出图未完成','preindexed plans avoid scanning the full library per paragraph');
const shownPartialPlans=new Set(),splitParagraphPlans=new Map([
  ['split',{id:'split',status:'completed',shots:[{status:'completed'},{status:'failed'}]}],
  ['later',{id:'later',status:'completed',shots:[{status:'completed',partialFailureCount:1}]}],
]);
assert.equal(storyboardInlinePartialCompletion([{planId:'split'}],splitParagraphPlans,shownPartialPlans)?.label,'部分完成 · 1 镜未完成');
assert.equal(storyboardInlinePartialCompletion([{planId:'split'}],splitParagraphPlans,shownPartialPlans),null,
  'the same plan does not repeat its partial badge under a later paragraph');
assert.equal(storyboardInlinePartialCompletion([{planId:'split'},{planId:'later'}],splitParagraphPlans,shownPartialPlans)?.label,'部分完成 · 1 次出图未完成',
  'a new plan can still show its own outcome at a shared later anchor');

assert.equal(preservedManualMode.routing.rules[0].shotTypes,undefined,'shot-type assignments are not persisted');
assert.equal(preservedManualMode.routing.enabled,undefined,'per-chat style selection is the only mirror enable authority');

assert.match(contractSource, /新增视觉价值[\s\S]*状态复述、重复画面[\s\S]*避免打断正文/, 'the compiler must silently skip replies without new visual value');
assert.match(source, /function storyboardSafePromptFallback[\s\S]*非露骨构图[\s\S]*storyboardAdaptShotForModel/, 'filtered image models must retain a safe deterministic fallback');
assert.doesNotMatch(source, /groupTemplate\.instruction/, 'style selection does not change narrative planning');
assert.match(source, /function storyboardAdaptShotForModel[\s\S]*policy !== 'filtered'[\s\S]*shot\.safePrompt/, 'only known filtered models receive the safe equivalent');
assert.match(source, /const storyboardActiveJobs = new Map\(\)/);
assert.match(source, /storyboardActiveJobs\.size < concurrency[\s\S]*storyboardRunQueuedJob/, 'configured generation concurrency must control real workers');
assert.match(source, /novelBusy[\s\S]*item\.source !== 'novel' \|\| !novelBusy/, 'NovelAI jobs remain strictly serial even when other providers use concurrency');
assert.doesNotMatch(source, /const latestFloor = storyboardCurrentAssistantFloor\(\);[\s\S]*byFloor\.set\(latestFloor/, 'an empty storyboard strip must not appear under every reply');
const inlineRender = source.slice(source.indexOf('function storyboardRenderInlineImages'), source.indexOf('function storyboardScheduleInlineRender'));
assert.match(inlineRender, /plan\.origin !== 'manual_supplement'/, 'only an explicitly requested manual supplement may expose an intermediate placeholder');
assert.doesNotMatch(inlineRender, /plan\.origin === 'automatic'[\s\S]*is-pending/, 'automatic intermediate states stay out of the immersive chat surface');
assert.match(source, /data-storyboard-chat-action="edit"[\s\S]*data-storyboard-chat-action="redraw"/, 'completed images retain edit and redraw escape hatches');
assert.doesNotMatch(routeSource, /sd-storyboard-safety-notice|受限制模型/);
assert.doesNotMatch(css, /\.sd-storyboard-safety-notice|\.sd-storyboard-route-rule/, 'retired route UI styles are removed with their abandoned controls');

console.log('Storyboard v7 automatic experience contract OK');
