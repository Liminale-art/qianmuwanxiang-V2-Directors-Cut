import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import * as storyboard from '../qianmu-storyboard.js';
import { parseOpenAICompatibleHeaders, normalizeOpenAIImageCompatibility, serializeOpenAICompatibleHeaders } from '../qianmu-openai-image-compat.js';
import {storyboardFunctionSource} from './helpers/storyboard-form-fixture.mjs';
import {renderEnsembleTargetPicker,openEnsembleTargetPicker} from '../qianmu-ensemble-target-picker.js';
import {prepareEnsembleStyleBindings} from '../qianmu-ensemble-bindings.js?v=1.59.376';
import {attachEnsembleCompilerResult,sealEnsembleCompilerResult,resolveEnsembleCompiledRoutes} from '../qianmu-ensemble-handoff.js?v=1.59.376';
import {createStoryboardQueueWindow} from '../qianmu-storyboard-queue-window.js';
import {startStoryboardQueueWindowBatch} from '../qianmu-storyboard-queue-batch.js';

const source = await readFile(new URL('../index.js', import.meta.url), 'utf8');
const V3 = 'nai-diffusion-3', V45 = 'nai-diffusion-4-5-full', V5 = 'nai-diffusion-5-full';
const alias = 'vendor/shared-NAI';
function section(name) {
  if(name==='storyboardCreatePreparationGuard')return storyboardFunctionSource(name);
  const match = new RegExp(`^(?:async )?function ${name}\\(`, 'm').exec(source);
  assert.ok(match, name);
  const tail = source.slice(match.index), next = tail.slice(1).search(/^(?:async )?function /m);
  return next < 0 ? tail : tail.slice(0, next + 1);
}
function environment(capability = V3, model = alias, extra = {}) {
  const state = storyboard.createStoryboardDefaults();
  Object.assign(state, { enabled: true, target: 'gallery', prompt: 'quiet garden' });
  state.profiles.novel = { ...state.profiles.novel, model, capabilityModelId: capability };
  state.connections.novel.draft = { id: 'draft-a', credentialId: 'key-ref', baseUrl: 'https://relay.example', model: V5 };
  const notices = [], saved = [];
  const context = vm.createContext({
    ...storyboard, storyboardCompilerBusy:false, clone: structuredClone, parseOpenAICompatibleHeaders, normalizeOpenAIImageCompatibility, serializeOpenAICompatibleHeaders,
    settings: { apiProfiles: [] }, storyboardState: () => state, getChatKey: () => 'chat-a', ctx: () => ({ chat: [] }),
    storyboardTargetFloor: () => -1, storyboardCredentialRevision: 0, storyboardAdmissionEpoch: 1,
    resolveImageAccountNamespace: async () => 'st-user:identity',
    getCharacterDescription: () => '', getPersonaDescription: () => '',
    storyboardSelectedArtistPreset: () => null, storyboardGalleryRecords: () => [],
    uniqueClean: (items) => [...new Set(items.filter(Boolean))],
    htmlEscape: (value) => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;'),
    storyboardSafeUrl: (url) => String(url || ''),
    STORYBOARD_NAI_QUALITY_DEFAULTS: { [V3]: 'quality v3', [V45]: 'quality v45', [V5]: 'quality v5' },
    STORYBOARD_NAI_NEGATIVE_DEFAULTS: { [V3]: 'negative v3', [V45]: 'negative v45', [V5]: 'negative v5' },
    STORYBOARD_GENERIC_PROMPT_DEFAULTS: { positive: 'quality', negative: 'exclusions' },
    storyboardConnectionStatus: new Map(), storyboardDraftApiKeys: new Map(),
    storyboardConnectionLoadRevision: 0,
    storyboardProductionDeliveryPolicy: (_shot, policy) => policy,
    storyboardAnchorForMessage: () => null, storyboardCredentialId: () => 'key-ref',
    sanitizeStoryboardDiagnosticData: (value) => value,
    uid: () => 'generated-id', saveSettings: () => saved.push(true), renderModal: () => {},
    toast: (message) => { notices.push(message); return false; },
    ...extra,
  });
  const names = ['storyboardConnectionState', 'storyboardProviderProfile', 'renderStoryboardModelPicker', 'storyboardApplyModelBinding',
    'storyboardCompilerProfileOptions', 'renderStoryboardModelCard', 'storyboardPromptDefaultsKey',
    'storyboardProviderPromptDefaults', 'storyboardPromptLayerForArtist', 'storyboardRememberPromptLayer',
    'storyboardPromptsForArtist', 'storyboardJoinPrompt', 'storyboardParameterPresets',
    'renderStoryboardParameterPresets', 'renderStoryboardParameterVibes', 'renderStoryboardModelCreate', 'renderStoryboardVariantControls', 'renderStoryboardCreate', 'renderStoryboardConnectionCompatibility', 'renderStoryboardOpenAICompatibility', 'renderStoryboardImageOutputFields', 'renderStoryboardGenerationCard',
    'storyboardProfileSnapshot', 'storyboardCaptureWorkbench', 'storyboardGenerationPayload', 'storyboardRestoreSnapshotConnection',
    'storyboardPrepareComfyRoutes', 'storyboardCreatePreparationGuard', 'storyboardResolveRoutingProfile', 'storyboardCreateJob', 'storyboardGatewayRequest', 'storyboardLoadLogToWorkbench', 'storyboardSafeShotSpecFromPrompt', 'storyboardShotSpecForSelection', 'storyboardAdaptShotForModel'];
  for (const call of section('renderStoryboardCreate').matchAll(/\b(renderStoryboard\w+)\(/g)) {
    if (!names.includes(call[1])) context[call[1]] = () => '';
  }
  vm.runInContext(names.map(section).join('\n'), context);
  return { state, context, notices, saved };
}

test('workbench profile binding is strict about aliases but accepts new-install empty selection', () => {
  assert.equal(storyboard.resolveStoryboardProfileBinding('novel', {}).remoteModelId, V5);
  assert.equal(storyboard.resolveStoryboardProfileBinding('novel', { model: alias, capabilityModelId: V3 }).remoteModelId, alias);
  assert.throws(() => storyboard.resolveStoryboardProfileBinding('novel', { model: alias }), { code: 'missing_capability_model' });
  assert.throws(() => storyboard.resolveStoryboardProfileBinding('novel', { model: V3, capabilityModelId: V45 }), { code: 'model_capability_conflict' });
  assert.equal(storyboard.resolveStoryboardProfileBinding('openai', { model: 'vendor/custom' }).remoteModelId, 'vendor/custom');
});

test('actual provider profile uses its passed state and capability defaults, not a connection model or another state', () => {
  const env = environment();
  const different = storyboard.createStoryboardDefaults();
  different.profiles.novel = { ...different.profiles.novel, model: 'other/alias', capabilityModelId: V45 };
  const before = structuredClone(different);
  const profile = env.context.storyboardProviderProfile(different);
  assert.equal(profile.model, 'other/alias');
  assert.equal(profile.capabilityModelId, V45);
  assert.equal(profile.sampler, storyboard.getStoryboardNovelParameterSpec(V45).defaults.sampler);
  assert.deepEqual(different, before, 'render reads do not migrate or mutate state');
  const current = env.context.storyboardProviderProfile(env.state);
  assert.equal(current.model, alias);
  assert.equal(current.capabilityModelId, V3);
  assert.equal(current.baseUrl, 'https://relay.example');
});

test('loaded parameters preserve legal zero/false while missing fields receive the correct defaults', () => {
  const { state, context } = environment();
  Object.assign(state.profiles.novel, { loaded: true, cfg: '0', seed: '0', novelSm: false, sampler: '' });
  const profile = context.storyboardProviderProfile(state);
  assert.equal(profile.cfg, '0');
  assert.equal(profile.seed, '0');
  assert.equal(profile.novelSm, false);
  assert.equal(profile.sampler, storyboard.getStoryboardNovelParameterSpec(V3).defaults.sampler);
});

test('a current bound alias remains selected and escaped in the actual model control', () => {
  const { state, context } = environment(V45, 'vendor/<alias>');
  const html = context.renderStoryboardModelCard(state);
  assert.match(html, /value="vendor\/&lt;alias&gt;"/);
  assert.doesNotMatch(html, /value="nai-diffusion-5-full" selected/);
  assert.doesNotMatch(html, /<alias>/);
});

test('invalid bindings show a repairable model card instead of crashing the entire workbench', () => {
  const { state, context } = environment('', 'unknown-alias');
  const before = structuredClone(state.profiles.novel);
  const html = context.renderStoryboardCreate(state);
  assert.match(html, /请检查模型或连接/);
  assert.match(html, /value="unknown-alias"/);
  assert.doesNotMatch(html, /sd-storyboard-params/);
  assert.deepEqual(state.profiles.novel, before);
});

test('actual workbench rendering chooses NAI sampler and Vibe controls from capability', () => {
  for (const capability of [V3, V45, V5]) {
    const { state, context } = environment(capability);
    state.vibeLibrary = [{ id: 'vibe-a', name: 'test vibe', modelIds: [V3] }];
    const html = context.renderStoryboardCreate(state);
    assert.ok(html.includes('sd-storyboard-params'));
    assert.equal(html.includes('data-storyboard-field="scheduler"'), capability !== V5);
    assert.equal(html.includes('sd-vibe-workbench-strip'),capability!==V5);
    assert.doesNotMatch(html,/data-storyboard-param-vibe=/,'compatibility and selection now belong to the confirmed library session');
    assert.ok(html.includes(capability === V3 ? 'quality v3' : capability === V45 ? 'quality v45' : 'quality v5'));
  }
});

for (const family of ['banana', 'openai', 'seedream']) {
  test(`${family} workbench displays description fields without applying or mutating a selected NAI artist`, () => {
    const { state, context } = environment(V3, alias, { renderStoryboardOpenAICompatibility: () => '' });
    const artist = { id: 'artist-a', name: 'Artist', value: 'artist: nai-only', positivePrompt: 'NAI-positive', negativePrompt: 'NAI-negative' };
    state.artistPresets = [artist]; state.selectedArtistPresetId = artist.id; state.selectedVibeIds = ['vibe-a'];
    context.storyboardSelectedArtistPreset = () => artist;
    state.source = family;
    const html = context.renderStoryboardCreate(state);
    assert.ok(html.includes('画面要求')); assert.ok(html.includes('排除描述'));
    assert.doesNotMatch(html, /sd-storyboard-artist-preset|sd-storyboard-param-vibes|NAI-positive|NAI-negative/);
    const before = structuredClone(artist);
    const fields = { '.sd-storyboard-prompt': {value:'custom description'}, '.sd-storyboard-negative': {value:'custom exclusion'} };
    context.storyboardCaptureWorkbench({querySelector:selector=>fields[selector] || null,querySelectorAll:()=>[]}, family);
    assert.deepEqual(artist,before);
    assert.equal(state.promptDefaults[`${family}:${state.profiles[family].model}`].negative,'custom exclusion');
    const payload = context.storyboardGenerationPayload(state,state.profiles[family],{prompt:'scene'});
    assert.match(payload.prompt,/custom description/); assert.match(payload.negative,/custom exclusion/);
    assert.equal(payload.artistString,''); assert.equal(payload.selectedVibeIds.length,0);
    assert.equal(state.selectedArtistPresetId,artist.id); assert.equal(state.selectedVibeIds[0],'vibe-a');
    state.source = 'novel';
    const restored = context.renderStoryboardCreate(state);
    assert.ok(restored.includes('NAI-positive')); assert.ok(restored.includes('NAI-negative'));
  });
}

test('natural-language job snapshots do not advertise an artist or pool that was not applied', () => {
  const { state, context } = environment();
  state.source = 'openai'; state.prompt = 'scene';
  state.artistPresets = [{id:'artist-a',name:'NAI artist',value:'artist: nai-only'}];
  state.selectedArtistPresetId = 'artist-a'; state.promptDraft.artistString = 'artist: legacy-naI';
  state.artistPools = [{id:'pool-a',enabled:true,members:[{artistId:'artist-a'}]}]; state.selectedArtistPoolId='pool-a';
  const job = context.storyboardCreateJob(state,state.profiles.openai);
  assert.equal(job.artistPresetId,''); assert.equal(job.artistPoolId,''); assert.equal(job.artistString,'');
  assert.doesNotMatch(job.payload.prompt,/nai-only|legacy-naI/);
});

test('inline artist button follows the image family rather than current workbench selection', () => {
  const { state, context } = environment();
  context.snip = text => text; context.storyboardInlineVideoForRecord = () => null;
  vm.runInContext(section('storyboardInlineRecordMarkup'),context);
  state.source = 'openai';
  assert.match(context.storyboardInlineRecordMarkup({id:'nai',source:'novel',url:'https://image.example/a.png'}),/data-storyboard-chat-action="artist"/);
  state.source = 'novel';
  assert.doesNotMatch(context.storyboardInlineRecordMarkup({id:'gpt',source:'openai',url:'https://image.example/b.png'}),/data-storyboard-chat-action="artist"/);
});

test('built-in parameter styles keep the real alias and user styles match both name and capability', () => {
  const { state, context } = environment(V5);
  state.parameterPresets = [
    { id: 'v5', source: 'novel', profile: { model: alias, capabilityModelId: V5, cfg: '0' } },
    { id: 'v45', source: 'novel', profile: { model: alias, capabilityModelId: V45, cfg: '7' } },
    { id: 'other', source: 'novel', profile: { model: 'other/alias', capabilityModelId: V3 } },
  ];
  const presets = context.storyboardParameterPresets('novel');
  assert.ok(presets.some((item) => item.builtin));
  for (const preset of presets.filter((item) => item.builtin)) {
    assert.equal(preset.profile.model, alias);
    assert.equal(preset.profile.capabilityModelId, V5);
  }
  assert.equal(presets.some((item) => item.id === 'v5'), true);
  assert.equal(presets.some((item) => item.id === 'v45' || item.id === 'other'), false);
  const routed = context.storyboardParameterPresets('novel', V5);
  assert.ok(routed.some((item) => item.builtin));
  assert.ok(routed.filter((item) => item.builtin).every((item) => item.profile.model === V5 && item.profile.capabilityModelId === V5));
  assert.equal(context.storyboardParameterPresets('novel', V3).some((item) => item.builtin), false);
});

function rootWith(fields = {}) {
  return { querySelector: (selector) => fields[selector] || null, querySelectorAll: () => [] };
}

test('routing restores different capabilities for the same actual model name without editing workbench state', () => {
  const { state, context } = environment(V3);
  Object.assign(state.profiles.novel, { loaded: true, cfg: '1' });
  storyboard.rememberStoryboardModelProfile(state.modelProfiles, 'novel', { model: alias, capabilityModelId: V45, loaded: true, cfg: '9', sampler: 'k_euler' });
  const before = structuredClone(state);
  const profile = context.storyboardResolveRoutingProfile(state, { providerId: 'novel', modelId: alias, capabilityModelId: V45 });
  assert.equal(profile.cfg, '9');
  assert.equal(profile.capabilityModelId, V45);
  const job = context.storyboardCreateJob(state, state.profiles.novel, { modelId: alias, capabilityModelId: V45 });
  assert.equal(job.profile.cfg, '9');
  assert.equal(job.modelIdentity.capabilityModelId, V45);
  assert.deepEqual(state, before);
});

test('routing validates connection references and exact model/capability parameter references', () => {
  const { state, context } = environment(V3);
  state.parameterPresets = [{ id: 'params', source: 'novel', profile: { model: alias, capabilityModelId: V45, cfg: '0', steps: '17' } }];
  state.connections.novel.presets = [{ id: 'api', model: V5, baseUrl: 'https://route.example', credentialId: 'route-key' }];
  const route = { providerId: 'novel', modelId: alias, capabilityModelId: V45, connectionPresetId: 'api', parameterPresetId: 'params' };
  const profile = context.storyboardResolveRoutingProfile(state, route);
  assert.equal(profile.cfg, '0');
  assert.equal(profile.steps, '17');
  assert.equal(profile.model, alias);
  assert.throws(() => context.storyboardResolveRoutingProfile(state, { ...route, capabilityModelId: V3 }), { code: 'invalid_route_parameters' });
  assert.throws(() => context.storyboardResolveRoutingProfile(state, { ...route, parameterPresetId: 'missing' }), { code: 'invalid_route_parameters' });
  assert.throws(() => context.storyboardResolveRoutingProfile(state, { ...route, connectionPresetId: 'missing' }), { code: 'missing_route_connection' });
  assert.throws(() => context.storyboardCreateJob(state, state.profiles.novel, { connectionPresetId: 'missing' }), { code: 'missing_route_connection' });
  const builtin = context.storyboardResolveRoutingProfile(state, { providerId: 'novel', modelId: alias, capabilityModelId: V5, parameterPresetId: 'builtin:nai-v5-official' });
  assert.equal(builtin.model, alias);
  assert.equal(builtin.capabilityModelId, V5);
});

test('style target rendering keeps bound aliases selected and exposes stale references without changing state', () => {
  const { state, context } = environment(V3);
  const route = { providerId: 'novel', modelId: 'vendor/<alias>', capabilityModelId: V45, connectionPresetId: 'missing-api', parameterPresetId: 'missing-style' };
  const before = structuredClone(state);
  const html = renderEnsembleTargetPicker({target:route,providers:storyboard.STORYBOARD_PROVIDER_REGISTRY,models:storyboard.STORYBOARD_MODEL_REGISTRY.novel,
    connections:state.connections.novel.presets,parameters:[{id:'available-style',name:'Available'}]});
  assert.match(html, /value="vendor\/&lt;alias&gt;"/);
  assert.match(html, /value="missing-api" selected/);
  assert.match(html, /value="missing-style" selected/);
  assert.match(html, /role="status"/);
  assert.doesNotMatch(html, /<alias>/);
  assert.deepEqual(state, before);
});

test('actual style model/provider handlers edit a private target and preserve channel connections on model changes', async () => {
  const { state } = environment(V3);
  const rule = { id: 'r', target: { providerId: 'novel', modelId: alias, capabilityModelId: V45, connectionPresetId: 'api', parameterPresetId: 'params' } };
  state.routing.rules = [rule];
  const before = structuredClone(rule.target);
  const events=new Map(),previous=globalThis.document;
  globalThis.document={createElement:()=>({innerHTML:'',addEventListener:(name,callback)=>events.set(name,callback),removeEventListener:name=>events.delete(name)})};
  try{
    const modelPicked=await openEnsembleTargetPicker({target:rule.target,providers:storyboard.STORYBOARD_PROVIDER_REGISTRY,
      models:id=>storyboard.STORYBOARD_MODEL_REGISTRY[id]||[],defaultTarget:()=>rule.target,
      validateTarget:target=>({target}),context:{POPUP_TYPE:{CONFIRM:1},Popup:class{async show(){events.get('change')({target:{dataset:{ensembleTarget:'modelId'},value:V3}});return true;}}}});
    assert.equal(modelPicked.target.modelId,V3);assert.equal(modelPicked.target.capabilityModelId,V3);
    assert.equal(modelPicked.target.connectionPresetId,'api');assert.equal(modelPicked.target.parameterPresetId,'');
    assert.deepEqual(rule.target,before,'model changes stay in the private draft');
    const picked=await openEnsembleTargetPicker({target:rule.target,providers:storyboard.STORYBOARD_PROVIDER_REGISTRY,
      models:id=>storyboard.STORYBOARD_MODEL_REGISTRY[id]||[],
      defaultTarget:providerId=>({providerId,modelId:'gpt-image-2',capabilityModelId:'gpt-image-2',connectionPresetId:'',parameterPresetId:''}),
      validateTarget:target=>({target}),context:{POPUP_TYPE:{CONFIRM:1},Popup:class{async show(){events.get('change')({target:{dataset:{ensembleTarget:'providerId'},value:'openai'}});return true;}}}});
    assert.equal(picked.target.capabilityModelId,'gpt-image-2');assert.equal(picked.target.connectionPresetId,'');
    assert.deepEqual(rule.target,before,'choosing a style target must not write the live route before saving the scheme');
  }finally{if(previous===undefined)delete globalThis.document;else globalThis.document=previous;}
});

function generationEnvironment() {
  const env = environment(V3);
  const { state, context } = env, queued = [];
  Object.assign(context, {
    storyboardGenerationPreparing: new Set(),
    storyboardProductionContext: () => ({}), storyboardQueue: [], storyboardActiveJobs: new Map(), STORYBOARD_QUEUE_LIMIT: 100,
    storyboardQueueSettling: 0, storyboardQueueWindow: {reservedCount:0,has:()=>false,notify:()=>{}},
    // Model-routing fixture stops at the queue seam; ledger preflight is covered
    // by the separate user-count-range and stream compiler integration suites.
    storyboardPreflightImageBatch: async (_jobs,valid) => { if(!valid())throw Error('preparation changed'); },
    storyboardQueueJob: (job) => { queued.push(job); return true; }, confirmDialog: async () => true,
    storyboardSetPlanStatus:(plan,status,extra={})=>{if(plan)Object.assign(plan,{status,...extra});},
  });
  vm.runInContext(section('storyboardPlanHasGeneration')+section('storyboardPrepareDraftGroup')+section('storyboardGenerate'), context);
  state.source = 'openai';
  state.profiles.openai = { ...state.profiles.openai, model: 'gpt-image-2' };
  state.promptDraft.shots = [{ id: 'garden', prompt: 'quiet garden', shotType: 'environment',
    shotSpec: { evidence: { quote: 'quiet garden' }, visualDuty: 'establish the quiet location', narrativePurpose: 'establish the scene' } }];
  const styleSelection = {enabled:true};
  state.connections.novel.presets = [{ id: 'api', baseUrl: 'https://route.example', credentialId: 'route-key', model: V5 }];
  state.parameterPresets = [{ id: 'style', source: 'novel', profile: { model: alias, capabilityModelId: V45, steps: '17', count: '2', cfg: '0' } }];
  state.routing.rules = [{ id: 'r', enabled: true, name: '人物分工', target: { providerId: 'novel', modelId: alias, capabilityModelId: V45, connectionPresetId: 'api', parameterPresetId: 'style' } }];
  // Already compiled style choices use the real binding and sealed handoff.
  // Only account-file persistence is isolated here; its full real-ST transport
  // and recovery checks live in storyboard-stream-compiler.test.mjs.
  const namespace='st-user:identity',library={schema:'qianmu.ensemble.library.v1',namespace,schemes:[{id:'style',revision:'one',name:'人物风格',description:'',tags:[],binding:{routeId:'r',artistPresetId:''}}]};
  context.storyboardEnsembleHost=()=>({});
  context.featureRuntime={load:async key=>{
    assert.equal(key,'storyboardContract');return {
      resolveStoryboardEnsembleDraftPlan:()=>{const plan={id:`identity-plan-${state.shotPlans.length}`,chatKey:'chat-a',status:'prompt_ready',shots:[],origin:'manual'};state.shotPlans.push(plan);return plan;},
      restoreStoryboardEnsemblePlan:async(_state,_plan,planned,guard)=>{
        const binding=await prepareEnsembleStyleBindings({library,selection:{schema:'qianmu.ensemble.chat-selection.v1',namespace,chatKey:'chat-a',revision:'one',enabled:true,schemeIds:['style']},
          namespace,chatKey:'chat-a',preparationId:'identity-style',readState:()=>state,assertCurrent:()=>{guard.assertCurrent();return true;},guard:async()=>{guard.assertCurrent();return true;},
          resolveProfile:({route})=>context.storyboardResolveRoutingProfile(state,route),verifyTarget:async()=>({ready:true,promptFormats:['tags']})});
        try{
          const ids=planned.map((_,index)=>`S${index+1}`),receipt=binding.session.resolve(ids.map(shot_id=>({shot_id,scheme_id:'style',reason:'selected style'})),ids);
          const result={shouldGenerate:true,shots:planned};attachEnsembleCompilerResult(result,{session:binding.session,receipt});
          await sealEnsembleCompilerResult(result,async()=>{guard.assertCurrent();return true;});
          const resolved=await resolveEnsembleCompiledRoutes(result,planned,{guard:async()=>{guard.assertCurrent();return true;}});return {...resolved,close:()=>binding.close()};
        }catch(error){binding.close();throw error;}
      },
    };
  }};
  const generate=context.storyboardGenerate;
  context.storyboardGenerate=(...args)=>{state.promptDraft.ensembleRequired=styleSelection.enabled;return generate(...args);};
  return { ...env, queued, styleSelection };
}

for (const grouped of [false, true]) {
  test(`actual ${grouped ? 'grouped' : 'independent'} automatic generation shares max budget and never multiplies saved Count`, async () => {
    const {state, context, queued, styleSelection} = generationEnvironment();
    styleSelection.enabled = grouped;
    state.generationPolicy = {version:1, minImages:1, maxImages:2, concurrency:2};
    state.profiles.openai.count = '4';
    state.promptDraft.shots = ['garden', 'river', 'city', 'forest'].map((scene, index) => ({
      id:scene, prompt:`quiet ${scene}`, shotType:'environment', shotSpec:{sourceParagraphIds:[`p${index}`], scene, location:scene, evidence:{quote:scene}, visualDuty:`establish ${scene}`, narrativePurpose:`establish ${scene}`},
    }));
    assert.equal(await context.storyboardGenerate(null, {automatic:true}),true);
    assert.equal(queued.length,2);
    for(const job of queued){assert.equal(job.payload.parameters.count,1);assert.equal(job.requestTotal,1);assert.equal(job.automatic,true);}
    assert.equal(state.profiles.openai.count,'4');
  });
}

test('automatic single shot also ignores saved variant count, but explicit manual single preserves variants', async () => {
  for(const automatic of [false,true]){
    const {context, queued}=generationEnvironment();
    assert.equal(await context.storyboardGenerate(null,{automatic}),true);
    assert.equal(queued.length,automatic?1:2);
  }
});

test('real generation freezes batch/shot/request order independently of mutable plan and engine state', async () => {
  const { state, context, queued, styleSelection } = generationEnvironment(); let sequence = 0;
  context.uid = () => `order-${++sequence}`;
  assert.equal(await context.storyboardGenerate(null), true);
  assert.deepEqual(queued.map(job => job.inlineOrder.requestIndex), [1, 2]);
  assert.equal(queued[0].inlineOrder.batchId, queued[1].inlineOrder.batchId);
  assert.equal(queued[0].inlineOrder.batchStartedAt, queued[1].inlineOrder.batchStartedAt);
  const first = structuredClone(queued[0].inlineOrder);
  queued.length = 0;
  styleSelection.enabled = false;
  state.promptDraft.shots = ['garden', 'river'].map(scene => ({ id: scene, prompt: scene, shotType: 'environment',
    shotSpec: { sourceParagraphIds: ['p1'], scene, location: scene, narrativePurpose: `show ${scene}` } }));
  assert.equal(await context.storyboardGenerate(null), true);
  assert.deepEqual(queued.map(job => job.inlineOrder.shotIndex), [0, 1]);
  assert.notEqual(queued[0].inlineOrder.batchId, first.batchId);
  assert.equal(queued[0].inlineOrder.batchId, queued[1].inlineOrder.batchId);
  const before = structuredClone(queued.map(job => job.inlineOrder));
  state.promptDraft.shots.reverse(); state.source = 'comfy';
  assert.deepEqual(queued.map(job => job.inlineOrder), before);
  assert.deepEqual(storyboard.sanitizeStoryboardSnapshot(queued[0]).inlineOrder, JSON.parse(JSON.stringify(queued[0].inlineOrder)));
});

test('real generation and asynchronous queue preserve the preparation guard across a manual NAI variant batch', async () => {
  const { state, context } = generationEnvironment(), queued = []; let admitted = 0, sequence = 0;
  Object.assign(context, {
    uid: () => `job-${++sequence}`, storyboardQueue: queued,
    storyboardImageAdmissionRuntime: async () => ({ admit: async (_job, options) => {
      await Promise.resolve(); assert.equal(options.valid(), true); admitted++;
    } }),
    storyboardStartLog: job => { const log = { id: `log-${sequence}`, snapshot: structuredClone(job) }; state.logs.push(log); return log; },
    storyboardPlanForJob: () => null, storyboardSetPlanStatus: () => {}, storyboardPumpQueue: () => {},
  });
  vm.runInContext(section('storyboardQueueJob'), context);
  assert.equal(await context.storyboardGenerate(null), true);
  assert.equal(admitted, 2); assert.equal(queued.length, 2); assert.equal(state.logs.length, 2);
  assert.equal(context.storyboardGenerationPreparing.size, 0);
});

function boundedGenerationEnvironment() {
  const env=generationEnvironment(),{state,context,styleSelection}=env;
  styleSelection.enabled=false;
  state.generationPolicy={version:3,minImages:1,maxImages:21,concurrency:2};
  state.promptDraft.shots=Array.from({length:21},(_,index)=>{
    const scene=`scene ${index+1} by the river`;
    return {id:`scene-${index+1}`,prompt:scene,shotType:'environment',shotSpec:{sourceParagraphIds:[`p${index+1}`],scene,sceneId:`scene-${index+1}`,location:scene,
      evidence:{quote:scene},visualDuty:`show ${scene}`,narrativePurpose:`establish ${scene}`}};
  });
  context.settings.enabled=true;
  context.STORYBOARD_QUEUE_LIMIT=8;
  context.storyboardQueueSettling=0;
  context.storyboardQueueBatches=new Set();
  let sequence=0;
  context.uid=prefix=>`${prefix||'job'}-${++sequence}`;
  context.storyboardScheduleInlineRender=()=>{};
  context.startStoryboardQueueWindowBatch=startStoryboardQueueWindowBatch;
  context.storyboardQueueWindow=createStoryboardQueueWindow({limit:8,pollMs:10,occupied:()=>
    context.storyboardQueue.length+context.storyboardActiveJobs.size+context.storyboardQueueSettling});
  const admissions=[],accepted=[],preflights=[];
  context.storyboardImageAdmissionRuntime=async()=>({admit:async(job,{valid})=>{
    assert.equal(valid(),true);
    admissions.push(job.inlineOrder.shotIndex);
  }});
  context.storyboardPreflightImageBatch=async(jobs,valid)=>{
    assert.equal(valid(),true);
    preflights.push(jobs.map(job=>job.inlineOrder.shotIndex));
  };
  context.storyboardStartLog=job=>{
    const log={id:`bounded-log-${accepted.length+1}`,snapshot:structuredClone(job)};
    state.logs.push(log);accepted.push(job.inlineOrder.shotIndex);return log;
  };
  context.storyboardPlanForJob=()=>null;
  context.storyboardPumpQueue=()=>{};
  context.storyboardSettleImageAdmission=async()=>{};
  context.storyboardCompilePrompt=()=>assert.fail('21 prepared shots must not re-extract or re-prompt');
  vm.runInContext(section('storyboardQueueJob')+section('storyboardEnqueuePreparedBatch'),context);
  return {...env,admissions,accepted,preflights};
}

async function waitUntil(predicate) {
  for(let attempt=0;attempt<200;attempt++){
    if(predicate())return;
    await new Promise(resolve=>setImmediate(resolve));
  }
  assert.fail('bounded queue did not reach the expected state');
}

test('21 selected shots register one bounded batch and enter eight queue slots in narrative order',async()=>{
  const {context,admissions,accepted,preflights}=boundedGenerationEnvironment();
  assert.equal(await context.storyboardGenerate(null),true);
  assert.equal(context.storyboardQueueBatches.size,1);
  const entry=[...context.storyboardQueueBatches][0];
  assert.equal(preflights.length,1);
  assert.equal(preflights[0].length,21);
  await waitUntil(()=>accepted.length===8);
  assert.deepEqual(accepted,[0,1,2,3,4,5,6,7]);
  assert.deepEqual(admissions,accepted);
  assert.equal(context.storyboardQueue.length,8);
  assert.equal(entry.handle.pendingCount,13);
  for(let index=8;index<21;index++){
    context.storyboardQueue.shift();
    context.storyboardQueueWindow.notify();
    await waitUntil(()=>accepted.length===index+1);
    assert.equal(accepted.at(-1),index);
    assert.equal(context.storyboardQueue.length,8);
  }
  await entry.handle.done;
  assert.deepEqual(admissions,Array.from({length:21},(_,index)=>index));
  assert.equal(new Set(context.storyboardQueue.map(job=>job.id)).size,8);
  assert.equal(context.storyboardQueueWindow.reservedCount,0);
  context.storyboardQueueWindow.close();
});

test('stopping an unsubmitted 21-shot remainder keeps exactly the already admitted eight shots',async()=>{
  const {context,admissions,accepted}=boundedGenerationEnvironment();
  assert.equal(await context.storyboardGenerate(null),true);
  await waitUntil(()=>accepted.length===8);
  const entry=[...context.storyboardQueueBatches][0];
  assert.equal(entry.handle.stop('用户取消本批未提交余项'),true);
  const outcome=await entry.handle.done;
  assert.equal(outcome.acceptedCount,8);
  assert.equal(outcome.pendingCount,13);
  assert.deepEqual(accepted,[0,1,2,3,4,5,6,7]);
  assert.deepEqual(admissions,accepted);
  assert.equal(context.storyboardQueue.length,8);
  context.storyboardQueue.shift();context.storyboardQueueWindow.notify();
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(admissions.length,8);
  assert.equal(context.storyboardQueueWindow.reservedCount,0);
  context.storyboardQueueWindow.close();
});

for(const scenario of ['replaced shots array','changed source evidence']){
  test(`a 21-shot plan stops unsubmitted remainder after ${scenario} without losing admitted work`,async()=>{
    const {state,context,admissions,accepted}=boundedGenerationEnvironment();
    const plan={id:`bounded-${scenario}`,chatKey:'chat-a',status:'prompt_ready',origin:'manual',shots:[]};
    state.shotPlans.push(plan);
    context.storyboardPlanForJob=job=>job.planId===plan.id?plan:null;
    let entry=null;
    try{
      assert.equal(await context.storyboardGenerate(null,{plan}),true);
      await waitUntil(()=>accepted.length===8);
      entry=[...context.storyboardQueueBatches][0];
      assert.equal(plan.shots.length,21);
      if(scenario==='replaced shots array')plan.shots=[...plan.shots];
      else plan.shots[12].shotSpec.evidence.quote='changed evidence after the first queue window';
      // A completed accepted job frees a slot; stale source data must not use it.
      context.storyboardQueue.shift();
      context.storyboardQueueWindow.notify();
      const outcome=await entry.handle.done;
      assert.equal(outcome.stopped,true);
      assert.equal(outcome.acceptedCount,8);
      assert.equal(outcome.pendingCount,13);
      assert.deepEqual(accepted,[0,1,2,3,4,5,6,7]);
      assert.deepEqual(admissions,accepted);
      assert.equal(state.logs.length,8);
      assert.equal(context.storyboardQueue.length,7);
      assert.match(plan.error,/已入队 8\/21；余镜未提交/,'partial completion remains recorded after accepted jobs finish');
      assert.equal(context.storyboardQueueWindow.reservedCount,0);
    }finally{
      entry?.handle.stop('测试结束');
      if(entry)await entry.handle.done;
      context.storyboardQueueWindow.close();
    }
  });
}

test('source mutation during an asynchronous ninth admission settles it and keeps the first eight accepted jobs',async()=>{
  const {state,context,admissions,accepted}=boundedGenerationEnvironment();
  const plan={id:'bounded-admission-race',chatKey:'chat-a',status:'prompt_ready',origin:'manual',shots:[]};
  state.shotPlans.push(plan);
  context.storyboardPlanForJob=job=>job.planId===plan.id?plan:null;
  const priorRuntime=context.storyboardImageAdmissionRuntime;
  const ninthEntered=new Promise(resolve=>{context.ninthEntered=resolve;});
  let resumeNinth;
  const ninthGate=new Promise(resolve=>{resumeNinth=resolve;});
  const settlements=[];
  context.storyboardImageAdmissionRuntime=async()=>({admit:async(job,options)=>{
    if(job.inlineOrder.shotIndex===8){
      assert.equal(options.valid(),true);
      context.ninthEntered();
      await ninthGate;
      return;
    }
    return (await priorRuntime()).admit(job,options);
  }});
  context.storyboardSettleImageAdmission=async(job,result)=>settlements.push([job.inlineOrder.shotIndex,result]);
  let entry=null;
  try{
    assert.equal(await context.storyboardGenerate(null,{plan}),true);
    await waitUntil(()=>accepted.length===8);
    entry=[...context.storyboardQueueBatches][0];
    context.storyboardQueue.shift();context.storyboardQueueWindow.notify();
    await ninthEntered;
    plan.shots[12].shotSpec.evidence.quote='changed while image admission awaited';
    resumeNinth();
    const outcome=await entry.handle.done;
    assert.equal(outcome.stopped,true);
    assert.equal(outcome.acceptedCount,8);
    assert.equal(outcome.pendingCount,13);
    assert.deepEqual(admissions,[0,1,2,3,4,5,6,7]);
    assert.deepEqual(accepted,admissions);
    assert.deepEqual(settlements,[[8,'not_submitted']]);
    assert.equal(state.logs.length,8);
    assert.equal(context.storyboardQueue.length,7);
  }finally{
    resumeNinth();
    entry?.handle.stop('测试结束');
    if(entry)await entry.handle.done;
    context.storyboardQueueWindow.close();
  }
});

test('explicit manual multi-shot selection still has one output per shot and confirms only that demand',async()=>{
  const {state,context,queued,styleSelection}=generationEnvironment();let confirmation='';
  context.confirmDialog=async(_title,text)=>{confirmation=text;return true;};
  styleSelection.enabled=false;state.profiles.openai.count='4';
  state.promptDraft.shots=['garden','river'].map(scene=>({id:scene,prompt:scene,shotType:'environment',shotSpec:{sourceParagraphIds:['p1'],scene,location:scene,narrativePurpose:`show ${scene}`}}));
  assert.equal(await context.storyboardGenerate(null),true);
  assert.equal(queued.length,2);assert.ok(queued.every(job=>job.payload.parameters.count===1));
  assert.match(confirmation,/预计生成 2 张图片/);
});

test('duplicate or ungrounded candidates never fill a minimum target with extra generation',async()=>{
  const {state,context,queued,notices,styleSelection}=generationEnvironment();
  styleSelection.enabled=false;state.generationPolicy={minImages:3,maxImages:3,concurrency:2};
  const original=structuredClone(state.promptDraft.shots[0]);state.promptDraft.shots=[original,{...original,id:'duplicate'}];
  assert.equal(await context.storyboardGenerate(null,{automatic:true}),true);
  assert.equal(queued.length,1);assert.ok(notices.some(message=>message.includes('可用画面 1/3')));
  state.promptDraft.shots=[{id:'invalid',prompt:'invention',shotSpec:{}}];
  queued.length=0;assert.equal(await context.storyboardGenerate(null,{automatic:true}),false);assert.equal(queued.length,0);
});

test('actual generation routes across families and preserves applied style and per-request NAI count', async () => {
  const { context, queued } = generationEnvironment();
  assert.equal(await context.storyboardGenerate(null), true);
  assert.equal(queued.length, 2);
  for (const job of queued) {
    assert.equal(job.source, 'novel');
    assert.equal(job.profile.model, alias);
    assert.equal(job.profile.capabilityModelId, V45);
    assert.equal(job.profile.steps, '17');
    assert.equal(job.profile.cfg, '0');
    assert.equal(job.profile.count, '1');
    assert.equal(job.connection.id, 'api');
    assert.equal(job.connection.baseUrl, 'https://route.example');
    assert.equal(job.modelIdentity.capabilityModelId, V45);
    assert.equal(context.storyboardGatewayRequest(job, 'mock-key', { references: [], vibes: [] }).model, alias);
  }
});

test('a missing connection in the selected style stops queues, but disabled styles cannot block ordinary generation', async () => {
  const { state, context, queued, notices, styleSelection } = generationEnvironment();
  state.routing.rules[0].target.connectionPresetId = 'missing';
  context.storyboardCompilePrompt = async () => { throw new Error('must not call extraction'); };
  assert.equal(await context.storyboardGenerate(null), false);
  assert.match(notices.at(-1), /风格选择.*未启用/);
  assert.equal(queued.length, 0);
  styleSelection.enabled = false;
  state.prompt = 'quiet garden';
  assert.equal(await context.storyboardGenerate(null), true);
  assert.equal(queued[0].source, 'openai');
});

test('deleting a routed connection during safety preparation cannot queue a fallback request', async () => {
  const { state, context, queued, notices } = generationEnvironment();
  context.storyboardAdaptShotForModel = async (shot) => { state.connections.novel.presets = []; return shot; };
  assert.equal(await context.storyboardGenerate(null), false);
  assert.equal(queued.length, 0);
  assert.match(notices.at(-1), /生图设置已变化/);
});

test('changing drawing settings in the count confirmation prevents all queued requests', async () => {
  const { state, context, queued, notices } = generationEnvironment();
  context.confirmDialog = async () => { Object.assign(state.profiles.novel, { loaded: true, cfg: '8' }); return true; };
  assert.equal(await context.storyboardGenerate(null), false);
  assert.equal(queued.length, 0);
  assert.match(notices.at(-1), /生图设置已变化/);
});

test('a rejected or stale extraction result cannot be followed by generation of an older or fallback draft', async () => {
  const { state, context, queued } = generationEnvironment();
  state.prompt = '';
  context.storyboardCompilePrompt = async () => { state.prompt = 'manual review fallback'; return false; };
  assert.equal(await context.storyboardGenerate(null), false);
  assert.equal(queued.length, 0);
});

test('an archive load cannot continue preparing jobs after a channel change', async () => {
  const { state, context, queued } = generationEnvironment();
  const plan = { archiveRef: 'archive-a', status: 'prompt_ready' };
  context.storyboardReleasePlanArchive = async () => { state.source = 'banana'; };
  assert.equal(await context.storyboardGenerate(null, { plan }), false);
  assert.equal(queued.length, 0);
});

test('materializing visible parameter defaults on page navigation does not invalidate an unchanged effective model', () => {
  const { state, context } = environment(V3);
  const guard = context.storyboardCreatePreparationGuard(state);
  state.profiles.novel = { ...context.storyboardProviderProfile(state), loaded: true };
  state.view = 'assets';
  assert.equal(guard.isCurrent(), true);
  guard.dispose();
});

test('capture keeps the old identity when the DOM already shows the next selection', () => {
  const { state, context } = environment();
  const root = rootWith({ '.sd-storyboard-model-select': { value: V45 } });
  context.storyboardCaptureWorkbench(root, 'novel', { rememberModel: false });
  assert.equal(state.profiles.novel.model, alias);
  assert.equal(state.profiles.novel.capabilityModelId, V3);
  assert.equal(state.modelProfiles.bindings, undefined);
});

test('first prompt edit is remembered under the visible default model, not an empty model key', () => {
  const { state, context } = environment();
  state.profiles.novel = { ...storyboard.createStoryboardDefaults().profiles.novel };
  context.storyboardCaptureWorkbench(rootWith({ '.sd-storyboard-prompt': { value: 'my quality layer' } }));
  assert.equal(state.promptDefaults[`novel:${V5}`].positive, 'my quality layer');
  assert.equal(Object.hasOwn(state.promptDefaults, 'novel:'), false);
  assert.equal(state.profiles.novel.model, V5);
  assert.equal(state.profiles.novel.capabilityModelId, V5);
});

test('real selection callback with real capture replaces identity atomically and preserves previous alias memory', () => {
  const { state, context } = environment();
  state.profiles.novel.cfg = '0';
  const root = { ...rootWith(), isConnected: true };
  context.storyboardApplyModelBinding(root, state, 'novel', { remoteModelId: V45 });
  assert.equal(state.profiles.novel.model, V45);
  assert.equal(state.profiles.novel.capabilityModelId, V45);
  assert.equal(storyboard.getStoryboardRememberedProfile(state.modelProfiles, 'novel', alias, V3).cfg, '0');
  const before = structuredClone(state.profiles.novel);
  assert.throws(() => context.storyboardApplyModelBinding(root, state, 'novel', { remoteModelId: 'new-unbound-alias' }), { code: 'missing_capability_model' });
  assert.deepEqual(structuredClone(state.profiles.novel), before);
});

test('actual task creation and request preserve alias/capability/defaults independently of the connection model', () => {
  const { state, context } = environment();
  const job = context.storyboardCreateJob(state, state.profiles.novel);
  assert.equal(job.profile.model, alias);
  assert.equal(job.profile.capabilityModelId, V3);
  assert.equal(job.profile.sampler, storyboard.getStoryboardNovelParameterSpec(V3).defaults.sampler);
  assert.equal(job.modelIdentity.remoteModelId, alias);
  assert.equal(job.modelIdentity.capabilityModelId, V3);
  const request = context.storyboardGatewayRequest(job, 'test-key', { references: [], vibes: [] });
  assert.equal(request.model, alias);
  assert.equal(request.capabilityModelId, V3);
  assert.equal(job.compiledPrompt.modelBinding.capabilityModelId, V3);
});

test('an explicit canonical task route replaces the prior alias capability, while unknown routes fail', () => {
  const { state, context } = environment();
  const job = context.storyboardCreateJob(state, state.profiles.novel, { modelId: V45 });
  assert.equal(job.modelIdentity.remoteModelId, V45);
  assert.equal(job.modelIdentity.capabilityModelId, V45);
  assert.throws(() => context.storyboardCreateJob(state, state.profiles.novel, { modelId: 'unbound-route' }), { code: 'missing_capability_model' });
});

test('routing to another known model cannot inherit the previous model sampler or parameter edits', () => {
  const { state, context } = environment();
  Object.assign(state.profiles.novel, { loaded: true, sampler: 'k_dpm_2', cfg: '1' });
  const defaults = context.storyboardCreateJob(state, state.profiles.novel, { modelId: V5 });
  assert.equal(defaults.profile.sampler, storyboard.getStoryboardNovelParameterSpec(V5).defaults.sampler);
  assert.notEqual(defaults.profile.cfg, '1');
  storyboard.rememberStoryboardModelProfile(state.modelProfiles, 'novel', { model: V5, loaded: true, cfg: '9', sampler: 'k_euler_a' });
  const remembered = context.storyboardCreateJob(state, state.profiles.novel, { modelId: V5 });
  assert.equal(remembered.profile.cfg, '9');
  assert.equal(remembered.profile.sampler, 'k_euler_a');
  assert.equal(state.profiles.novel.cfg, '1');
});

test('actual log loading clears previous capability and sampler fields rather than merging stale settings', () => {
  const { state, context } = environment();
  state.profiles.novel.sampler = 'old sampler';
  context.storyboardLoadLogToWorkbench({ source: 'novel', snapshot: { source: 'novel', profile: { model: V45, cfg: '0' }, target: 'gallery' } });
  assert.equal(state.profiles.novel.capabilityModelId, undefined);
  assert.equal(state.profiles.novel.sampler, '');
  assert.equal(context.storyboardProviderProfile(state).capabilityModelId, V45);
  const original = { source: 'novel', profile: { model: alias, capabilityModelId: V3 }, connection: { id: 'original' } };
  const identity = storyboard.resolveStoryboardJobModelIdentity(original);
  context.storyboardLoadLogToWorkbench({ source: 'novel', snapshot: { ...original, profile: { model: alias }, modelIdentity: identity } });
  assert.equal(state.profiles.novel.capabilityModelId, V3);
  assert.equal(state.profiles.novel.model, alias);
});

test('safety adaptation uses the capability content policy, not misleading remote naming', async () => {
  const { state, context } = environment();
  const shot = { prompt: 'original dramatic scene', sensitive: true, safePrompt: 'quiet aftermath' };
  const full = await context.storyboardAdaptShotForModel(shot, 'novel', 'vendor/curated-looking', state, { capabilityModelId: V3 });
  assert.equal(full.safetyAdapted, false);
  const filtered = await context.storyboardAdaptShotForModel(shot, 'novel', 'vendor/full-looking', state, { capabilityModelId: 'nai-diffusion-5-curated' });
  assert.equal(filtered.safetyAdapted, true);
  assert.equal(filtered.prompt, 'quiet aftermath');
});

test('loading a saved image edit into the workbench takes priority over its original generation log', async () => {
  const { state, context } = environment();
  state.logs = [{ recordId: 'image-a', source: 'novel', snapshot: { source: 'novel', profile: { model: V5 }, prompt: 'old scene' } }];
  context.storyboardReadSnapshotForRecord = async () => ({ source: 'novel', profile: { model: alias, capabilityModelId: V45 }, prompt: 'edited scene', target: 'gallery' });
  vm.runInContext(section('storyboardLoadRecordToWorkbench'), context);
  await context.storyboardLoadRecordToWorkbench({ id: 'image-a', source: 'novel' });
  assert.equal(state.prompt, 'edited scene');
  assert.equal(state.profiles.novel.model, alias);
  assert.equal(state.profiles.novel.capabilityModelId, V45);
  assert.equal(state.logs[0].snapshot.prompt, 'old scene');
});

test('a late image-setting load cannot overwrite the workbench after changing chats', async () => {
  const { state, context } = environment();
  const before = JSON.stringify(state);
  context.storyboardReadSnapshotForRecord = async () => {
    context.getChatKey = () => 'chat-b';
    return { source: 'novel', profile: { model: V5 }, prompt: 'old-chat scene' };
  };
  vm.runInContext(section('storyboardLoadRecordToWorkbench'), context);
  assert.equal(await context.storyboardLoadRecordToWorkbench({ id: 'image-a', source: 'novel' }), false);
  assert.equal(JSON.stringify(state), before);
});

test('invalid profiles stop both compiler and generation before any external work', async () => {
  const { state, context, notices } = environment('', 'invalid-unbound');
  context.storyboardCompilerBusy = false;
  context.storyboardGenerationPreparing = new Set();
  context.storyboardCaptureWorkbench = () => ({ state, profile: state.profiles.novel, workflowResult: { ok: true, removedFields: [] } });
  context.featureRuntime = { load: () => assert.fail('external work must not begin') };
  vm.runInContext(section('storyboardCompilePrompt') + section('storyboardPlanHasGeneration') + section('storyboardPrepareDraftGroup') + section('storyboardGenerate'), context);
  assert.equal(await context.storyboardCompilePrompt(null), false);
  assert.equal(await context.storyboardGenerate(null), false);
  assert.equal(notices.length, 2);
});
