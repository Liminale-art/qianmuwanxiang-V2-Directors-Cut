import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import {EventEmitter} from 'node:events';
import * as storyboard from '../qianmu-storyboard.js';
import * as contractRuntime from '../qianmu-storyboard-contract.js';
import {installCompilerDiagnosticsFixture} from './helpers/compiler-diagnostics-fixture.mjs';
import {storyboardFunctionSource} from './helpers/storyboard-form-fixture.mjs';

const source = await readFile(new URL('../index.js', import.meta.url), 'utf8');
function section(name) {
  if(name==='storyboardCreatePreparationGuard')return storyboardFunctionSource(name);
  const match = new RegExp(`^(?:async )?function ${name}\\(`, 'm').exec(source);
  assert.ok(match, name);
  const tail = source.slice(match.index), next = tail.slice(1).search(/^(?:async )?function /m);
  return next < 0 ? tail : tail.slice(0, next + 1);
}
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
async function tick() { for (let n = 0; n < 10; n++) await Promise.resolve(); }
function environment() {
  const state = storyboard.createStoryboardDefaults();
  state.enabled = true;
  state.profiles.novel.model = 'nai-diffusion-5-full';
  state.prompt = 'original prompt'; state.negative = 'original negative';
  state.promptPresets = [{ id: 'preset-a', items: [{ name: 'one', instruction: 'original instruction' }] }];
  state.promptCompiler.instructionPresetId = 'preset-a';
  state.promptCompiler.apiProfileId = 'llm-a';
  const chat = [{ mes: 'original floor', swipe_id: 0 }], events = new Map(), calls = [], notices = [];
  const plan = { id: 'plan-a', chatKey: 'chat-a', floor: 0, status: 'screening', shots: [] };
  const context = vm.createContext({
    ...storyboard, clone: structuredClone, settings: { apiProfiles: [{ id: 'llm-a', model: 'fast', apiUrl: 'https://llm.example', apiKey: 'private-key' }] },
    storyboardState: () => state, getChatKey: () => 'chat-a', ctx: () => ({ chat, mainApi: 'openai' }),
    getCharacterDescription: () => 'character', getPersonaDescription: () => 'persona', storyboardCredentialRevision: 0,
    storyboardDraftApiKeys: new Map(), storyboardCompilerBusy: false, storyboardTargetFloor: () => 0,
    storyboardScheduleAutomaticCapture: () => {},
    storyboardCaptureWorkbench: () => ({ state, profile: state.profiles[state.source] }),
    storyboardSetPlanStatus: (target, status, info = {}) => { if (target) Object.assign(target, { status, ...info }); },
    renderModal: () => {}, saveSettings: () => calls.push('save'), storyboardSchedulePlanArchive: () => {}, storyboardScheduleInlineRender: () => {},
    storyboardAnchorForMessage: () => null, storyboardShotSpecForSelection: () => null,
    toast: (message) => notices.push(message), console: { error: () => {}, warn: () => {} }, MODULE_NAME: 'qianmu-test',
    sanitizeStoryboardDiagnosticData: (data) => data, uid: () => 'test-id',
    document: {
      addEventListener: (name, handler) => { const handlers = events.get(name) || new Set(); handlers.add(handler); events.set(name, handlers); },
      removeEventListener: (name, handler) => events.get(name)?.delete(handler),
    },
    storyboardCompilerContext: async () => ({ floor: 0, paragraphs: ['original floor'], messages: [], worldRows: [] }),
    featureRuntime: { load: async () => ({ ...contractRuntime,buildStoryboardPlanContractRequest: () => ({ messages: [{ content: 'test contract' }], schema: {}, schemaId: 'test' }) }) },
    storyboardCompilerRequestConfig: () => ({}),
    storyboardCallCompiler: async () => { calls.push('llm'); return 'old response'; },
    storyboardCompilerResult: async () => ({ shouldGenerate: true, prompt: 'extracted prompt', negative: '', shots: [{ prompt: 'extracted prompt', sensitive: false }] }),
    storyboardProviderProfile: (_state, id = state.source) => state.profiles[id],
  });
  vm.runInContext(['storyboardPrepareComfyRoutes','storyboardUsesComfyCharacters','storyboardCreatePreparationGuard', 'storyboardCompilePrompt', 'storyboardAdaptShotForModel'].map(section).join('\n'), context);
  installCompilerDiagnosticsFixture(context);
  const dispatchInput = (className = 'sd-storyboard-field') => {
    for (const handler of events.get('input') || []) handler({ target: { className, type: 'text', matches: () => true, closest: () => ({}) } });
  };
  return { state, context, calls, notices, plan, chat, events, dispatchInput };
}

test('extracted guard observes replaced settings and draft-key containers through the real host adapter',()=>{
  for(const change of [e=>{e.context.settings={...e.context.settings,apiProfiles:[{...e.context.settings.apiProfiles[0],model:'replaced'}]};},
    e=>{e.context.storyboardDraftApiKeys=new Map([['novel','replacement']]);}]){
    const e=environment(),guard=e.context.storyboardCreatePreparationGuard(e.state);change(e);
    assert.throws(()=>guard.assertCurrent(),{code:'storyboard_input_changed'});guard.dispose();
  }
});

test('extracted guard binds only its owned plan and notices subsequent cancellation without a document',()=>{
  const e=environment();delete e.context.document;const guard=e.context.storyboardCreatePreparationGuard(e.state);
  assert.throws(()=>guard.bindPlan(e.plan),{code:'storyboard_input_changed'});
  e.state.shotPlans.push(e.plan);guard.bindPlan(e.plan);guard.assertCurrent();
  const other={...e.plan,id:'other'};e.state.shotPlans.push(other);assert.throws(()=>guard.bindPlan(other),{code:'storyboard_input_changed'});
  e.plan.status='cancelled';assert.throws(()=>guard.assertCurrent(),{code:'storyboard_input_changed'});guard.dispose();assert.equal(guard.isCurrent(),false);
});

test('extracted guard releases all operation-owned resources and document listeners',()=>{
  const e=environment(),guard=e.context.storyboardCreatePreparationGuard(e.state),closed=[];
  for(const name of ['ensemble','continuityStore','compilerSources','streamFrame','comfyBatch','comfyAuto','comfyReadiness'])guard[name]={close:()=>closed.push(name)};
  guard.dispose();assert.equal(closed.length,7);assert.equal(guard.isCurrent(),false);
  assert.equal([...e.events.values()].reduce((n,set)=>n+set.size,0),0);
});

test('native library mutations invalidate a running preparation even without a form input event',()=>{
  const e=environment();e.context.storyboardEnsembleRevision=0;const guard=e.context.storyboardCreatePreparationGuard(e.state);
  e.context.storyboardEnsembleRevision++;assert.throws(()=>guard.assertCurrent(),{code:'storyboard_input_changed'});guard.dispose();
});

test('actual context and preparation lifecycle invalidate restored dependency edits before repair/save and release borrowed sources',async()=>{
  for(const invalidate of [false,true]){
    const e=environment(),emitter=new EventEmitter(),host={chat:e.chat,chatId:'chat-a',characterId:0,
      characters:[{avatar:'A.png',chat:'chat-a'}],chatMetadata:{story_director_liminale:{}},eventSource:emitter,mainApi:'openai'};
    e.chat.unshift({mes:'prior state',is_user:true,swipe_id:0});e.plan.floor=1;
    Object.assign(e.context,{ctx:()=>host,storyboardAdmissionEpoch:0,storyboardTargetFloor:()=>1,
      storyboardCleanWithTagRules:text=>text,storyboardCleanMessageText:text=>text,resolveMacro:async text=>text,
      storyboardMessageParagraphs:text=>[text],storyboardCompilerWorldText:async()=>({text:'',rows:[]}),
      storyboardCompilerCharacterCasting:async()=>({prepared:null,assertCurrent:async()=>{},apply:shot=>({shot,warnings:[]})}),
      featureRuntime:{load:async key=>key==='storyboardContract'?contractRuntime:{resolveImageAccountNamespace:async()=> 'st-user:test'}},
    });
    vm.runInContext(section('storyboardCompilerContext'),e.context);
    let captured;
    const create=e.context.storyboardCreatePreparationGuard;e.context.storyboardCreatePreparationGuard=(...args)=>captured=create(...args);
    e.context.storyboardCallCompiler=async()=>{
      e.calls.push('llm');assert.ok(captured.compilerSources);assert.equal(captured.compilerSources.sources.length,2);
      if(invalidate){const old=e.chat[0].mes;e.chat[0].mes='temporary';emitter.emit('message_edited',0);e.chat[0].mes=old;}
      return 'synthetic response';
    };
    assert.equal(await e.context.storyboardCompilePrompt(null,{plan:e.plan}),!invalidate,JSON.stringify(e.notices));
    assert.equal(e.calls.includes('save'),!invalidate);assert.equal(e.plan.status,invalidate?'stale':'prompt_ready');
    assert.equal(emitter.eventNames().reduce((sum,type)=>sum+emitter.listenerCount(type),0),0);
    assert.throws(captured.compilerSources.assertCurrent,{code:'storyboard_input_changed'});
  }
});

test('missing or duplicate compiler profiles stop extraction before preparation, with a clear notice and no busy latch',async()=>{
  for(const change of [e=>e.context.settings.apiProfiles=[],e=>e.context.settings.apiProfiles.push({...e.context.settings.apiProfiles[0],apiUrl:'https://other.example'})]){
    const e=environment();change(e);
    e.context.storyboardPrepareComfyRoutes=async()=>assert.fail('no paid preparation before a valid compiler choice');
    assert.equal(await e.context.storyboardCompilePrompt(null,{plan:e.plan}),false);assert.deepEqual(e.calls,[]);assert.equal(e.context.storyboardCompilerBusy,false);
    assert.match(e.notices.at(-1),/档案已失效或编号重复/);assert.equal(e.plan.status,'screening');
    const guard=e.context.storyboardCreatePreparationGuard(e.state);guard.assertCurrent();guard.dispose();
  }
});

test('actual compiler never falls back for missing or duplicate explicit IDs but still honors explicit main-API selection',async()=>{
  const e=environment(),calls=[];vm.runInContext(section('storyboardCallCompiler'),e.context);
  Object.assign(e.context,{AbortController,callExternalApi:async(_messages,_unused,cfg)=>{calls.push(['external',cfg]);return 'ok';},callSillyTavernModel:async()=>{calls.push(['st']);return 'ok';}});
  const messages=[{content:'test'}];
  for(const mode of ['st','external']){e.context.settings.providerMode=mode;await assert.rejects(()=>e.context.storyboardCallCompiler(messages,'missing'),/未改用其他连接/);}
  e.context.settings.apiProfiles.push({...e.context.settings.apiProfiles[0],apiKey:'other-private'});
  await assert.rejects(()=>e.context.storyboardCallCompiler(messages,'llm-a'),/编号重复/);assert.deepEqual(calls,[]);
  e.context.settings.apiProfiles.pop();await e.context.storyboardCallCompiler(messages,'llm-a');assert.equal(calls[0][1].apiKey,'private-key');assert.equal(calls[0][1].apiUrl,'https://llm.example');
  e.context.settings.providerMode='st';await e.context.storyboardCallCompiler(messages,'');assert.equal(calls.at(-1)[0],'st');
  e.context.settings.providerMode='external';await e.context.storyboardCallCompiler(messages,null);assert.equal(calls.at(-1)[0],'external');assert.equal(calls.at(-1)[1].apiKey,undefined,'global external path still resolves its own current configuration');
});

test('missing compiler choice stays visible instead of looking like an implicitly selected main API',()=>{
  const e=environment();e.state.promptCompiler.apiProfileId='missing<id>';e.context.htmlEscape=value=>String(value).replaceAll('<','&lt;').replaceAll('>','&gt;');
  vm.runInContext(section('storyboardCompilerProfileOptions'),e.context);
  const html=e.context.storyboardCompilerProfileOptions(e.state);assert.match(html,/value="missing&lt;id&gt;" selected>原档案已失效/);assert.doesNotMatch(html,/missing<id>/);
});

for (const [name, mutate] of [
  ['model', (e) => { e.state.profiles.novel.model = 'nai-diffusion-3'; }],
  ['capability', (e) => { e.state.profiles.novel.capabilityModelId = 'nai-diffusion-3'; }],
  ['character reference toggle', (e) => { e.state.profiles.novel.characterReferenceEnabled = true; }],
  ['series', (e) => { e.state.source = 'openai'; }],
  ['connection URL', (e) => { e.state.connections.novel.draft.baseUrl = 'https://different.example'; }],
  ['image key revision', (e) => { e.context.storyboardCredentialRevision++; }],
  ['LLM credential', (e) => { e.context.settings.apiProfiles[0].apiKey = 'replacement-key'; }],
  ['LLM preset model', (e) => { e.context.settings.apiProfiles[0].model = 'different'; }],
  ['preset item', (e) => { e.state.promptPresets[0].items[0].instruction = 'new instruction'; }],
  ['worldbook selection', (e) => { e.state.promptCompiler.worldBookNames = ['new worldbook']; }],
  ['composition', (e) => { e.state.compositionPolicy.fixedRatioId = '16:9'; }],
  ['generation budget', (e) => { e.state.generationPolicy.maxImages = 1; }],
  ['manual prompt', (e) => { e.state.prompt = 'hand edited'; e.state.promptDraft.userEditedCompiled = true; }],
  ['source floor text', (e) => { e.chat[0].mes = 'edited floor'; }],
  ['source floor replacement', (e) => { e.chat[0] = { ...e.chat[0] }; }],
  ['chat switch', (e) => { e.context.getChatKey = () => 'chat-b'; }],
  ['state replacement', (e) => { e.context.storyboardState = () => ({ ...e.state }); }],
  ['cancelled plan', (e) => { e.plan.status = 'cancelled'; }],
]) {
  test(`late extraction cannot write or start repair after changing ${name}`, async () => {
    const e = environment(), gate = deferred();
    e.context.storyboardCallCompiler = async () => { e.calls.push('llm'); return gate.promise; };
    e.context.storyboardCompilerResult = async () => assert.fail('must not parse or repair a stale result');
    const work = e.context.storyboardCompilePrompt(null, { plan: e.plan });
    await tick(); assert.equal(e.calls.includes('llm'), true);
    mutate(e);
    const prompt = e.state.prompt, negative = e.state.negative;
    gate.resolve('stale response');
    assert.equal(await work, false);
    assert.equal(e.state.prompt, prompt);
    assert.equal(e.state.negative, negative);
    assert.equal(e.context.storyboardCompilerBusy, false);
    assert.equal([...e.events.values()].reduce((sum, set) => sum + set.size, 0), 0, 'operation listeners must be released');
    if (name === 'cancelled plan') assert.equal(e.plan.status, 'cancelled');
    else assert.equal(e.plan.status, 'stale', 'the original plan must not remain compiling');
    if (name === 'chat switch' || name === 'state replacement') assert.equal(e.notices.length, 0, 'do not notify the new context about an old result');
  });
}

test('edit-and-restore invalidates in-flight work; searches and view navigation do not', () => {
  const e = environment(), guard = e.context.storyboardCreatePreparationGuard(e.state);
  e.state.view = 'gallery'; e.dispatchInput('sd-storyboard-gallery-search');
  assert.equal(guard.isCurrent(), true);
  e.dispatchInput('sd-storyboard-model-select');
  assert.equal(guard.isCurrent(), false);
  assert.throws(() => guard.assertCurrent(), { code: 'storyboard_input_changed' });
  assert.doesNotMatch(JSON.stringify(guard), /private-key|original floor/);
  guard.dispose();
});

test('context or runtime loading cannot start an LLM request after the selection changed', async () => {
  for (const phase of ['context', 'runtime']) {
    const e = environment(), gate = deferred();
    if (phase === 'context') e.context.storyboardCompilerContext = () => gate.promise;
    else e.context.featureRuntime.load = () => gate.promise;
    const work = e.context.storyboardCompilePrompt(null, { plan: e.plan });
    await tick(); e.state.promptCompiler.instructionPresetId = 'different';
    gate.resolve({});
    assert.equal(await work, false);
    assert.equal(e.calls.includes('llm'), false);
  }
});

test('successful current extraction still writes its result and clears operation resources', async () => {
  const e = environment();
  assert.equal(await e.context.storyboardCompilePrompt(null, { plan: e.plan }), true);
  assert.equal(e.state.prompt, 'extracted prompt');
  assert.equal(e.plan.status, 'prompt_ready');
  assert.equal(e.context.storyboardCompilerBusy, false);
  assert.equal(e.events.get('input').size, 0);
});

test('a no-picture response cannot clear a manually edited draft while it was in flight', async () => {
  const e = environment(), gate = deferred();
  e.context.storyboardCompilerResult = async () => gate.promise;
  const work = e.context.storyboardCompilePrompt(null, { plan: e.plan });
  await tick(); e.state.prompt = 'manual new drawing';
  gate.resolve({ shouldGenerate: false, skipReason: 'old no picture' });
  assert.equal(await work, false);
  assert.equal(e.state.prompt, 'manual new drawing');
});

test('guard does not traverse media previews, gallery, logs or parameter memory', () => {
  const e = environment();
  for (const name of ['logs', 'pipelineLogs', 'modelProfiles']) Object.defineProperty(e.state, name, { get: () => assert.fail(`must not read ${name}`) });
  const artist = { id: 'a', value: 'style' };
  Object.defineProperty(artist, 'previewUrl', { get: () => assert.fail('must not read a preview') });
  e.state.artistPresets = [artist];
  const guard = e.context.storyboardCreatePreparationGuard(e.state);
  assert.equal(guard.isCurrent(), true); guard.dispose();
});

test('a late failed safety request aborts instead of turning into a local fallback picture', async () => {
  const e = environment(), gate = deferred();
  e.context.featureRuntime.load = async () => ({ buildStoryboardSafetyContractRequest: () => ({ messages: [], schema: {} }) });
  e.context.storyboardCallCompiler = () => gate.promise;
  const guard = e.context.storyboardCreatePreparationGuard(e.state);
  const work = e.context.storyboardAdaptShotForModel({ prompt: 'story', sensitive: true }, 'openai', 'gpt-image-2', e.state, { chatKey: 'chat-a', isCurrent: guard.isCurrent });
  await tick(); e.state.connections.novel.draft.baseUrl = 'https://new.example';
  gate.reject(new Error('late failure'));
  assert.equal((await work).safetyAborted, true);
  guard.dispose();
});

for (const phase of ['before repair request', 'during repair request']) {
  test(`actual compiler repair is isolated ${phase}`, {timeout:2000}, async () => {
    const e = environment(), gate = deferred(), reached = deferred();
    let llmCalls = 0;
    const contract = {
      buildStoryboardPlanContractRequest: () => ({ messages: [], schema: {}, schemaId: 'test' }),
      parseStoryboardContractResponse: () => ({ ok: false, errors: ['invalid'] }),
      repairStoryboardContract: async ({ request }) => {
        if (phase === 'before repair request') { reached.resolve(); await gate.promise; }
        await request([]);
        return { ok: false };
      },
      createStoryboardContractManualFallback: () => assert.fail('stale result must not produce a fallback'),
    };
    e.context.featureRuntime.load = async () => ({...contractRuntime,...contract});
    e.context.storyboardCallCompiler = async () => {
      llmCalls++;
      if (llmCalls === 2 && phase === 'during repair request') { reached.resolve(); await gate.promise; }
      return 'invalid output';
    };
    vm.runInContext(section('storyboardCompilerResult'), e.context);
    const work = e.context.storyboardCompilePrompt(null, { plan: e.plan });
    await reached.promise; e.state.prompt = 'new manual prompt'; gate.resolve();
    assert.equal(await work, false);
    assert.equal(llmCalls, phase === 'before repair request' ? 1 : 2);
    assert.equal(e.state.prompt, 'new manual prompt');
  });
}

test('safety repair cannot call a second LLM after a configuration change', async () => {
  const e = environment(), gate = deferred();
  let llmCalls = 0;
  e.context.featureRuntime.load = async () => ({
    buildStoryboardSafetyContractRequest: () => ({ messages: [], schema: {} }),
    parseStoryboardContractResponse: () => ({ ok: false }),
    repairStoryboardContractOnce: async ({ request }) => { await gate.promise; await request([]); return { ok: false }; },
  });
  e.context.storyboardCallCompiler = async () => { llmCalls++; return 'invalid'; };
  const guard = e.context.storyboardCreatePreparationGuard(e.state);
  const work = e.context.storyboardAdaptShotForModel({ prompt: 'story', sensitive: true }, 'openai', 'gpt-image-2', e.state, { isCurrent: guard.isCurrent });
  await tick(); e.state.promptCompiler.instructionPresetId = 'different'; gate.resolve();
  assert.equal((await work).safetyAborted, true);
  assert.equal(llmCalls, 1); guard.dispose();
});

test('actual extraction stops after three failed repairs with a concise notice, no candidate and unchanged previous draft',async()=>{
 const e=environment();let calls=0;e.context.featureRuntime.load=async()=>contractRuntime;e.context.storyboardCallCompiler=async()=>{calls++;return '{ invalid';};
 vm.runInContext(section('storyboardCompilerResult'),e.context);
 assert.equal(await e.context.storyboardCompilePrompt(null,{plan:e.plan,quiet:true}),false);
 assert.equal(calls,4,'one initial extraction plus at most three format repairs');assert.equal(e.plan.status,'failed');assert.equal(e.state.prompt,'original prompt');
 const output=e.state.pipelineLogs[0].stages.at(-1).output.diagnostic;
 assert.match(e.notices.at(-1),/已修复3次/);assert.equal(output.repairCalls,3);assert.equal(e.plan.shots.length,0);assert.equal(e.plan.manualReviewRequired,undefined);
 assert.match(e.notices.at(-1),/返回不是有效 JSON/);
 assert.equal(output.stopReason,'budget_exhausted');
 assert.deepEqual([...output.reasonCodes],['json_syntax']);
 assert.equal(e.state.pendingCompilerStages,undefined);assert.equal(e.state.logs[0].kind,'prompt_compiler');
});

test('an actual post-acceptance implementation failure is not disguised as stale input', async () => {
  const e = environment();
  e.context.storyboardAnchorForMessage = () => { throw new Error('implementation failure'); };
  assert.equal(await e.context.storyboardCompilePrompt(null, { plan: e.plan }), false);
  assert.equal(e.plan.status, 'failed');
  assert.match(e.notices.at(-1), /implementation failure/);
});
