import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import {EventEmitter} from 'node:events';
import * as storyboard from '../qianmu-storyboard.js';
import * as contractRuntime from '../qianmu-storyboard-contract.js';
import {installCompilerDiagnosticsFixture} from './helpers/compiler-diagnostics-fixture.mjs';
import {storyboardFunctionSource} from './helpers/storyboard-form-fixture.mjs';
import {installWorldbookFixture} from './helpers/storyboard-worldbooks-fixture.mjs';

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

function installRealContextReaders(e, persona = '') {
  const host = {chat:e.chat, mainApi:'openai', characterId:0, characters:[{description:'character'}], powerUserSettings:{persona_description:persona}};
  // ST binds input on #persona_description. jQuery's enumerable event array has
  // delegateCount, which Array.map in the guard's plain-data copy does not copy.
  const handlers = [() => {}]; handlers.delegateCount = 0;
  e.context.persona_description = {nodeType:1, jQueryFixture:{events:{input:handlers}, handle:() => {}}};
  e.context.ctx = () => ({...host});
  vm.runInContext(['getCharacterDescription','getPersonaDescription'].map(section).join('\n'), e.context);
  return host;
}

test('real persona reader and guard remain current with an empty persona and a stable jQuery-backed named input', () => {
  for (const persona of ['', undefined, 'available persona']) {
    const e = environment(), host = installRealContextReaders(e, persona);
    if (persona === undefined) delete host.powerUserSettings.persona_description;
    const guard = e.context.storyboardCreatePreparationGuard(e.state);
    try {
      assert.equal(guard.isCurrent(), true);
      guard.assertCurrent();
      assert.equal(typeof e.context.getPersonaDescription(), 'string');
    } finally { guard.dispose(); }
  }
});

test('actual compiler preparation with real context readers reaches its mocked model once for an empty persona', async () => {
  const e = environment(); installRealContextReaders(e);
  assert.equal(await e.context.storyboardCompilePrompt(null, {plan:e.plan}), true);
  assert.equal(e.calls.filter(call => call === 'llm').length, 1);
  assert.equal(e.state.prompt, 'extracted prompt');
});

test('real context readers still reject persona, character and API changes without replacing the previous draft', {timeout:2000}, async () => {
  for (const [persona, change] of [['', host => {host.powerUserSettings.persona_description = 'changed persona';}],
    ['filled persona', host => {host.powerUserSettings.persona_description = '';}],
    ['', host => {host.characters[0].description = 'changed character';}], ['', host => {host.mainApi = 'novel';}]]) {
    const e = environment(), host = installRealContextReaders(e, persona), entered = deferred(), release = deferred();
    e.context.storyboardCompilerContext = async () => { entered.resolve(); await release.promise; return {floor:0, paragraphs:['original floor'], messages:[], worldRows:[]}; };
    const work = e.context.storyboardCompilePrompt(null, {plan:e.plan});
    await entered.promise; change(host); release.resolve();
    assert.equal(await work, false);
    assert.equal(e.calls.filter(call => call === 'llm').length, 0);
    assert.equal(e.state.prompt, 'original prompt');
    assert.equal(e.state.pipelineLogs[0].stages[0].output.reason, 'preparation_context_changed');
  }
});

test('extracted guard binds only its owned plan and notices subsequent cancellation without a document',()=>{
  const e=environment();delete e.context.document;const guard=e.context.storyboardCreatePreparationGuard(e.state);
  assert.throws(()=>guard.bindPlan(e.plan),{code:'storyboard_input_changed'});
  e.state.shotPlans.push(e.plan);guard.bindPlan(e.plan);guard.assertCurrent();
  const other={...e.plan,id:'other'};e.state.shotPlans.push(other);assert.throws(()=>guard.bindPlan(other),{code:'storyboard_input_changed'});
  e.plan.status='cancelled';assert.throws(()=>guard.assertCurrent(),{code:'storyboard_input_changed'});guard.dispose();assert.equal(guard.isCurrent(),false);
});

test('only an existing explicit manual floor plan receives a frozen prompt-excluded target scope',()=>{
  for(const origin of ['manual','manual_supplement']){
    const e=environment();e.state.target='floor';e.plan.origin=origin;e.state.shotPlans.push(e.plan);e.chat[0].is_system=true;
    const guard=e.context.storyboardCreatePreparationGuard(e.state,{plan:e.plan});
    assert.equal(guard.allowHiddenTarget,true);guard.assertCurrent();guard.dispose();
  }
  for(const [setup,stream] of [[()=>{},{floor:0}],[e=>{e.plan.origin='automatic';},null],[e=>{e.state.target='latest';},null],
    [e=>{e.plan.floor=1;},null],[e=>{e.plan.chatKey='other';},null],[e=>{e.state.shotPlans=[];},null]]){
    const e=environment();e.state.target='floor';e.plan.origin='manual';e.state.shotPlans.push(e.plan);setup(e);
    const guard=e.context.storyboardCreatePreparationGuard(e.state,{plan:e.plan,stream});
    assert.equal(guard.allowHiddenTarget,false);guard.dispose();
  }
  const e=environment();e.state.target='floor';e.plan.origin='automatic';e.state.shotPlans.push(e.plan);
  const guard=e.context.storyboardCreatePreparationGuard(e.state,{plan:e.plan});e.plan.origin='manual';
  assert.equal(guard.allowHiddenTarget,false);guard.dispose();
});

test('explicit hidden-floor scope invalidates when its plan origin, identity or target is changed',()=>{
  for(const mutate of [e=>{e.plan.origin='automatic';},e=>{e.plan.id='other';},e=>{e.plan.floor=1;},e=>{e.plan.chatKey='other';},e=>{e.state.shotPlans=[];}]){
    const e=environment();e.state.target='floor';e.plan.origin='manual';e.state.shotPlans.push(e.plan);
    const guard=e.context.storyboardCreatePreparationGuard(e.state,{plan:e.plan});assert.equal(guard.allowHiddenTarget,true);
    mutate(e);assert.throws(()=>guard.assertCurrent(),{code:'storyboard_input_changed'});guard.dispose();
  }
});

test('actual index compiler-context wiring admits only its explicit hidden target and excludes hidden history',async()=>{
  for(const origin of ['manual','manual_supplement','automatic']){
    const e=environment(),emitter=new EventEmitter(),host={chat:e.chat,chatId:'chat-a',characterId:0,
      characters:[{avatar:'A.png',chat:'chat-a'}],chatMetadata:{story_director_liminale:{}},eventSource:emitter,mainApi:'openai'};
    e.chat.unshift({mes:'excluded earlier floor',is_system:true,swipe_id:0});e.chat[1].is_system=true;
    Object.assign(e.plan,{floor:1,origin});e.state.target='floor';e.state.shotPlans.push(e.plan);
    Object.assign(e.context,{ctx:()=>host,storyboardAdmissionEpoch:0,storyboardTargetFloor:()=>1,
      storyboardCleanWithTagRules:text=>text,storyboardCleanMessageText:text=>text,resolveMacro:async text=>text,
      storyboardMessageParagraphs:text=>[text],storyboardCompilerWorldText:async()=>({text:'',rows:[]}),
      storyboardCompilerCharacterCasting:async()=>({prepared:null,assertCurrent:async()=>{},apply:shot=>({shot,warnings:[]})}),
      featureRuntime:{load:async key=>key==='storyboardContract'?contractRuntime:{resolveImageAccountNamespace:async()=> 'st-user:test'}},
    });
    vm.runInContext(section('storyboardCompilerContext'),e.context);
    const guard=e.context.storyboardCreatePreparationGuard(e.state,{plan:e.plan});
    try{
      if(origin==='automatic')await assert.rejects(e.context.storyboardCompilerContext(e.state,guard),{code:'storyboard_context_unavailable'});
      else {
        const result=await e.context.storyboardCompilerContext(e.state,guard);
        assert.deepEqual([...result.compilerSources.messages].map(row=>row.floor),[1]);
        assert.equal(result.compilerSources.current.messageRef.role,'system');assert.equal(result.paragraphs[0],'original floor');
      }
    }finally{guard.dispose();}
    assert.equal(emitter.eventNames().reduce((sum,type)=>sum+emitter.listenerCount(type),0),0);
    assert.ok(e.chat.every(message=>message.is_system));
  }
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
    assert.equal(e.plan.status,invalidate?'stale':'prompt_ready');
    if(invalidate){
      assert.equal(e.state.prompt,'original prompt');
      assert.equal(e.state.promptDraft.compiled,'');
      assert.equal(e.state.logs.length,1,'only the metadata interruption is saved');
      assert.equal(e.state.logs[0].snapshot,null);
      assert.doesNotMatch(JSON.stringify(e.state.pipelineLogs),/original floor|original prompt|private-key/);
    }else assert.equal(e.calls.includes('save'),true);
    assert.equal(emitter.eventNames().reduce((sum,type)=>sum+emitter.listenerCount(type),0),0);
    assert.throws(captured.compilerSources.assertCurrent,{code:'storyboard_input_changed'});
  }
});

test('missing or duplicate compiler profiles stop extraction before preparation, with a clear notice and no busy latch',async()=>{
  for(const change of [e=>e.context.settings.apiProfiles=[],e=>e.context.settings.apiProfiles.push({...e.context.settings.apiProfiles[0],apiUrl:'https://other.example'})]){
    const e=environment();change(e);
    e.context.storyboardPrepareComfyRoutes=async()=>assert.fail('no paid preparation before a valid compiler choice');
    assert.equal(await e.context.storyboardCompilePrompt(null,{plan:e.plan}),false);assert.deepEqual(e.calls,['save']);assert.equal(e.context.storyboardCompilerBusy,false);
    assert.equal(e.state.logs.length,1);assert.equal(e.state.logs[0].snapshot,null);
    assert.equal(e.state.prompt,'original prompt');assert.equal(e.state.promptDraft.compiled,'');
    assert.doesNotMatch(JSON.stringify(e.state.pipelineLogs),/private-key|original floor|original prompt/);
    assert.match(e.notices.at(-1),/档案已失效或编号重复/);assert.equal(e.plan.status,'screening');
    const guard=e.context.storyboardCreatePreparationGuard(e.state);guard.assertCurrent();guard.dispose();
  }
});

test('runtime compiler selection loss stays boolean and records one metadata interruption without accepting the response', {timeout:2000}, async () => {
  for (const change of [
    e => { e.state.promptCompiler.apiProfileId = 'missing'; },
    e => { e.context.settings.apiProfiles = []; },
    e => { e.context.settings.apiProfiles.push({...e.context.settings.apiProfiles[0],apiKey:'other-private-key'}); },
  ]) {
    const e = environment(), reached = deferred(), response = deferred();
    let captured;
    const create = e.context.storyboardCreatePreparationGuard;
    e.context.storyboardCreatePreparationGuard = (...args) => captured = create(...args);
    e.context.storyboardCallCompiler = async () => { e.calls.push('llm'); reached.resolve(); return response.promise; };
    e.context.storyboardCompilerResult = () => assert.fail('an invalid compiler selection must not parse, repair or accept a late response');
    const before = JSON.stringify([e.state.prompt,e.state.negative,e.state.promptDraft]);
    const work = e.context.storyboardCompilePrompt(null,{plan:e.plan});
    await reached.promise;
    change(e);
    assert.equal(captured.isCurrent(),false,'runtime validity checks must not throw for this known selection change');
    assert.equal(captured.inputChangeReason,'preparation_compiler_changed');
    assert.throws(() => captured.assertCurrent(),{code:'storyboard_input_changed',inputChangeReason:'preparation_compiler_changed'});
    response.resolve('sensitive stale response');
    assert.equal(await work,false,'compile resolves cancelled rather than rejecting past its diagnostic handler');
    assert.equal(e.calls.filter(value => value === 'llm').length,1);
    assert.equal(JSON.stringify([e.state.prompt,e.state.negative,e.state.promptDraft]),before);
    assert.equal(e.plan.status,'stale');
    assert.equal(e.state.logs.length,1);
    assert.equal(e.state.logs[0].status,'cancelled');
    assert.equal(e.state.logs[0].snapshot,null);
    assert.equal(e.state.pipelineLogs[0].stages[0].output.reason,'preparation_compiler_changed');
    assert.doesNotMatch(JSON.stringify([e.state.logs,e.state.pipelineLogs]),/private-key|original floor|original prompt|sensitive stale/);
    assert.equal(e.context.storyboardCompilerBusy,false);
    assert.equal([...e.events.values()].reduce((sum,set) => sum + set.size,0),0);
  }
});

test('guard does not disguise an unrelated snapshot implementation error as a compiler selection change', () => {
  const e = environment(), guard = e.context.storyboardCreatePreparationGuard(e.state,{requireCompiler:true});
  const failure = new Error('synthetic unrelated implementation failure');
  e.context.storyboardProviderProfile = () => { throw failure; };
  assert.throws(() => guard.isCurrent(),error => error === failure);
  assert.equal(guard.inputChangeReason,'');
  guard.dispose();
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
  ['built-in art direction', (e) => { e.state.profiles.novel.artDirection = 'cg'; }],
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
  test(`late extraction cannot write or start repair after changing ${name}`, {timeout:2000}, async () => {
    const e = environment(), gate = deferred(), reached = deferred();
    e.context.storyboardCallCompiler = async () => { e.calls.push('llm'); reached.resolve(); return gate.promise; };
    e.context.storyboardCompilerResult = async () => assert.fail('must not parse or repair a stale result');
    const work = e.context.storyboardCompilePrompt(null, { plan: e.plan });
    await reached.promise; assert.equal(e.calls.includes('llm'), true);
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

test('real worldbook directory normalization is browsing-only and does not cancel extraction', async () => {
  const e = environment();
  e.state.promptCompiler.worldBookView = 'removed-directory';
  Object.assign(e.context, {
    storyboardWorldEntryCache: { key: '', loading: null }, contextScanCache: { boundWorldBookNames: [], worldBooks: {} },
    uniqueClean: values => [...new Set(values.filter(Boolean))], detectBoundWorldBookNames: () => [], listWorldBooks: async () => [],
  });
  installWorldbookFixture(e.context);
  vm.runInContext(section('storyboardWarmCompilerWorldEntries'), e.context);
  const context = e.context.storyboardCompilerContext;
  e.context.storyboardCompilerContext = async (...args) => {
    await e.context.storyboardWarmCompilerWorldEntries();
    return context(...args);
  };
  assert.equal(await e.context.storyboardCompilePrompt(null, { plan: e.plan }), true);
  assert.equal(e.state.promptCompiler.worldBookView, '');
  assert.equal(e.calls.filter(call => call === 'llm').length, 1);
});

test('browsing-only projection still guards selected books, entries and every other compiler setting', () => {
  for (const [change, reason] of [
    [e => { e.state.promptCompiler.worldBookNames = ['changed']; }, 'preparation_world_selection_changed'],
    [e => { e.state.promptCompiler.worldEntryIds = ['changed-entry']; }, 'preparation_world_selection_changed'],
    [e => { e.state.promptCompiler.includeRecentFloors++; }, 'preparation_compiler_changed'],
    [e => { e.state.promptCompiler.tagRules = []; }, 'preparation_compiler_changed'],
    [e => { e.state.promptCompiler.apiProfileId = 'changed'; }, 'preparation_compiler_changed'],
    [e => { e.state.promptCompiler.futureInput = 'sensitive-future-value'; }, 'preparation_compiler_changed'],
  ]) {
    const e = environment(), guard = e.context.storyboardCreatePreparationGuard(e.state);
    e.state.promptCompiler.worldBookView = 'browsing-only';
    guard.assertCurrent();
    change(e);
    assert.throws(() => guard.assertCurrent(), {code:'storyboard_input_changed', inputChangeReason:reason});
    assert.equal(guard.inputChangeReason, reason);
    guard.dispose();
  }
});

test('guard reason codes distinguish input ownership and nested sources without exposing values', () => {
  const cases = [
    [e => { e.state.profiles.comfy.comfyWorkflow = 'sensitive-workflow'; }, 'preparation_profile_changed'],
    [e => { e.state.connections.comfy.draft.baseUrl = 'https://sensitive.example'; }, 'preparation_connection_changed'],
    [e => { e.context.storyboardCredentialRevision++; }, 'preparation_credentials_changed'],
    [e => { e.chat[0].mes = 'sensitive-prose'; }, 'preparation_messages_changed'],
    [e => { e.chat[0] = {...e.chat[0]}; }, 'preparation_message_replaced'],
    [e => { e.context.getChatKey = () => 'sensitive-chat'; }, 'preparation_chat_changed'],
    [e => { e.context.storyboardState = () => ({...e.state}); }, 'preparation_state_changed'],
  ];
  for (const [change, reason] of cases) {
    const e = environment(), guard = e.context.storyboardCreatePreparationGuard(e.state);
    change(e);
    assert.throws(() => guard.assertCurrent(), {code:'storyboard_input_changed', inputChangeReason:reason});
    assert.equal(guard.inputChangeReason, reason);
    assert.doesNotMatch(JSON.stringify({reason:guard.inputChangeReason}), /sensitive|private-key|original floor/);
    guard.dispose();
  }
  for (const supplied of ['compiler_source_message_changed', 'private-key']) {
    const e = environment(), guard = e.context.storyboardCreatePreparationGuard(e.state);
    guard.compilerSources = {assertCurrent() { throw Object.assign(Error('source changed'), {inputChangeReason:supplied}); }, close() {}};
    const reason = supplied === 'private-key' ? 'compiler_sources_changed' : supplied;
    assert.throws(() => guard.assertCurrent(), {code:'storyboard_input_changed', inputChangeReason:reason});
    assert.equal(guard.inputChangeReason, reason);
    guard.dispose();
  }
});

test('a no-picture response cannot clear a manually edited draft while it was in flight', {timeout:2000}, async () => {
  const e = environment(), gate = deferred(), reached = deferred();
  e.context.storyboardCompilerResult = async () => { reached.resolve(); return gate.promise; };
  const work = e.context.storyboardCompilePrompt(null, { plan: e.plan });
  await reached.promise; e.state.prompt = 'manual new drawing';
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
