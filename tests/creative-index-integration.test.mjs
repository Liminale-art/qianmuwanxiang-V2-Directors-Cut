import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { parseDirectorFinal, paintModelLog, renderDirectorLive, directorPreviewPlan, directorQualitySummary } from '../qianmu-director-live.js';
import { CREATIVE_SYSTEM_PROMPT, CREATIVE_BLUEPRINT, CREATIVE_GUIDES, creativeSectionGuidance } from '../qianmu-creative-prompts.js';
import { createCreativeSchema, normalizeCreativeSections, validateCreativePlan, pruneInvalidCreativeItems, projectCreativeContinuity } from '../qianmu-creative-contract.js';
import { selectCreativeOptions, upgradeCreativeDefaults, upgradeCreativeBlueprint, recentInterludeHint } from '../qianmu-creative-runtime.js';
import { hashText, isPlainObject, mergeDefaults, uniqueClean, sanitizeEventStage, advanceEventStage } from '../qianmu-storyboard-utils.js';

const entry = await fs.readFile(new URL('../index.js', import.meta.url), 'utf8');
function between(start, end) {
  const a = entry.indexOf(start), b = entry.indexOf(end, a + start.length);
  assert.ok(a >= 0 && b > a, `source extraction: ${start}`);
  return entry.slice(a, b);
}
const promptSource = between('function directorHistorySelection(', '\nfunction validateApiSettings(');
const normalizeSource = between('function normalizePlan(', '// directorItemText -');
const qualitySource = between('function directorDedupePlan(', 'function makeStreamLogUpdater(');
const generationSource = between('function makeStreamLogUpdater(', '// MIGRATED to qianmu-storyboard-utils.js (commit 19)');
const geoSource = between('const FACTION_TRENDS =', '\nfunction buildPlanDigest(');
const plain = value => JSON.parse(JSON.stringify(value));
const BASIC = Object.freeze({ parallelSceneEnabled: false, interludeEnabled: false });

test('actual director host route uses Qianmu limits and never falls back to ambient generateRaw hooks', async () => {
  const source = between('async function callSillyTavernModel(', '// 字符串感知')
    .replace(/await import\('\.\/qianmu-model-host\.js(?:\?[^']*)?'\)/, 'hostModule');
  let available = true, sent, rawCalls = 0;
  const c = { settings: { maxOutputTokens: 6200, temperature: 0.4 }, ctx: () => ({}),
    hostModule: { hostChatModelAvailable: () => available, callHostChatModel: async options => { sent = options; return { text: 'complete' }; } },
    getGenerateRaw: () => async () => { rawCalls++; return 'legacy'; } };
  vm.createContext(c); vm.runInContext(source, c);
  await c.callSillyTavernModel('selected', 'rules', null, { directorRequest: true });
  assert.equal(sent.maxTokens, 6200); assert.equal(sent.temperature, 0.4);
  assert.deepEqual(plain(sent.messages), [{ role: 'system', content: 'rules' }, { role: 'user', content: 'selected' }]);
  await c.callSillyTavernModel('selected', 'rules', null, { directorRequest: true, max_tokens: 1400, temperature: 0 });
  assert.equal(sent.maxTokens, 1400); assert.equal(sent.temperature, 0);
  available = false;
  for (const delta of [null, () => {}]) {
    await assert.rejects(c.callSillyTavernModel('selected', 'rules', delta, { directorRequest: true }), /不支持千幕独立取材请求/);
  }
  assert.equal(rawCalls, 0);
  assert.equal(await c.callSillyTavernModel('unrelated feature'), 'legacy');
  assert.equal(rawCalls, 1);
});

function fullPlan(options = {}) {
  const plan = {
    story_status: { title: '街角', cycle: '周三傍晚', directions: [{ horizon: 'near', title: '旧账回响', content: '账单核对逐渐改变街坊间的赊欠规则。' }, { horizon: 'far', title: '另一处收信人', content: '不同收信人的经历让跨城联络成为新的主线。' }] },
    quests: Array.from({ length: 5 }, (_, i) => ({ title: `来信${i}`, subject: '伙计', description: `第${i}份信送到了街口，伙计正在寻找收信者。` })),
    character_dynamics: Array.from({ length: 2 }, (_, i) => ({ title: `待办${i}`, content: `阿岚把第${i}份账单拿到灯下核对，尚未动笔。` })),
    npc_updates: Array.from({ length: 3 }, (_, i) => ({ name: `邻居${i}`, next_action: `邻居正在为第${i}家店铺检查送货的路。` })),
    chain_reactions: Array.from({ length: 3 }, (_, i) => ({ spark: `第${i}条路临时改道。`, chain: `伙计将第${i}车货改送后巷 → 掌柜通知收货人延迟 → 邻街工坊调整当日排班` })),
    relation_undercurrents: Array.from({ length: 3 }, (_, i) => ({ parties: i === 2 ? [`邻居${i}`, `铺主${i}`, `调度员${i}`] : [`邻居${i}`, `铺主${i}`], tension: `第${i}张欠条尚未提起，两人都先谈了眼前的天气。` })),
    limitations: [],
  };
  if (options.parallelSceneEnabled !== false) plan.parallel_scene = { title: '如果赶上早班车', content: 'PARALLEL_ONLY_CONTENT：车门没有在面前关上，旧友从空座旁抬起头。' };
  if (options.interludeEnabled !== false) plan.interlude = { type: 'phone', title: '早班群', owner: '阿岚', conversation_kind: 'group', messages: Array.from({ length: 6 }, (_, i) => ({ sender: i % 2 ? '阿岚' : '老周', content: `INTERLUDE_ONLY_CONTENT：第${i}条钥匙交接消息。`, time: `08:0${i}` })) };
  return plan;
}

function fixture({ settings: overrides = {}, responses = [], duringWorldRead, memoryResult = {}, worldText = 'WORLD_SOURCE：旧码头仍在维修，有手机。' } = {}) {
  let saveCount = 0, injectCount = 0, selectionCount = 0, id = 0;
  let memoryText = memoryResult.text ?? 'MEMORY_SOURCE：旧码头的欠款尚未结清。', memoryFingerprint = 'memory-v1';
  const requests = [], toasts = [];
  const store = { blueprint: 'CUSTOM_BLUEPRINT：保留缓慢的日常节奏。', plan: { original: true }, history: [] };
  const context = { name1: '访客', chatMetadata: {}, extensionSettings: { gagaDogSummary: {} }, chat: [
    { name: '阿岚', is_user: false, mes: 'HISTORY_SOURCE：阿岚拿起手机，读到了老周的短信。' },
    { name: '访客', is_user: true, mes: 'USER_SOURCE：我询问那份旧账。' },
  ] };
  const settings = { enabled: true, providerMode: 'external', streamEnabled: false, systemPrompt: CREATIVE_SYSTEM_PROMPT,
    outputSchemaText: createCreativeSchema(), contextBudget: 100000, maxOutputTokens: 6000,
    contextOptions: { contextDepth: 5, includeChatHistory: true }, logHistory: [], ...overrides };
  const c = {
    settings, DEFAULT_SYSTEM_PROMPT: CREATIVE_SYSTEM_PROMPT, DEFAULT_BLUEPRINT: CREATIVE_BLUEPRINT, JSON_SCHEMA_TEXT: createCreativeSchema(),
    contextScanCache: { presetScannedAt: 1, worldScannedAt: 1, worldBooks: {} },
    ctx: () => context, getChatStore: () => store, getChatKey: () => 'chat-one',
    getCharacterName: () => '阿岚', getPersonaName: () => '访客', getCharacterDescription: () => '人物资料', getPersonaDescription: () => '',
    getSelectedWorldBookNames: () => [], getSelectedPresetNames: () => [], cleanContextText: String, resolveMacro: async value => value,
    refreshPresets: async () => assert.fail('cached presets should not refresh'), refreshWorldBooks: async () => assert.fail('cached world books should not refresh'),
    buildWorldContextText: async () => { duringWorldRead?.({ changeMemory: () => { memoryFingerprint = 'memory-v2'; } }); return worldText; },
    buildPresetContextText: async () => 'PRESET_SOURCE：短句与含蓄对话。',
    memoryHostFixture: { findExtension: () => ({ enabled: true }) },
    readGagaMemoryContext: options => { assert.equal(options.pluginAvailable, true); return { text: memoryText, status: memoryResult.status || 'ready', diagnostics: [], snapshot: { production: 'layered', summaryMode: 'mixed', fingerprint: memoryFingerprint } }; },
    htmlEscape: value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]),
    estimateTokens: value => Math.ceil(String(value).length / 4), hashText, isPlainObject, mergeDefaults, uniqueClean,
    creativeSectionGuidance, createCreativeSchema, normalizeCreativeSections, validateCreativePlan, pruneInvalidCreativeItems, projectCreativeContinuity, recentInterludeHint,
    selectCreativeOptions: (value, options) => { selectionCount++; return selectCreativeOptions(value, { ...options, random: () => .9 }); },
    busy: false, cancelRequested: false, abortController: null, directorRun: null, directorLiveLog: null, activeTab: 'dashboard', MODAL_ID: 'panel',
    document: { getElementById: () => null }, AbortController, Date, console, clone: structuredClone,
    validateApiSettings: () => true, toast: (...args) => { toasts.push(args); }, apiToast: () => {}, uid: prefix => `${prefix}-${++id}`,
    featureRuntime: { load: async () => assert.fail('ordinary director requests must not load image admission') },
    resolveImageAccountNamespace: async () => 'st-user:one',
    storyboardState: () => ({ enabled: false, automation: { autoGenerate: true }, directorBridge: { worldSideShotsEnabled: true, worldAutoGenerate: true } }),
    renderBusyState: () => {}, renderModal: () => {}, renderFloatButton: () => {}, rerenderIfOpen: () => {},
    pushLog: log => { settings.logHistory.push(log); return log; }, saveSettings: () => {},
    saveMetadata: async () => { saveCount++; }, applyDirectorInjection: async () => { injectCount++; }, injectSelection: new Map(),
    resetCreativeSocialState: () => {},
    storyboardQueueNewWorldPlan: async () => assert.fail('disabled storyboard must not receive director work'), parseDirectorFinal, paintModelLog, renderDirectorLive, directorPreviewPlan, directorQualitySummary,
    FACTION_RELATION_KINDS: ['冲突', '同盟', '张力', '中立', '依附'], sanitizeEventStage, advanceEventStage,
    callExternalApi: async (messages, onDelta, config, controller) => {
      const request = { messages, onDelta, config, controller }; requests.push(request);
      const next = responses[requests.length - 1];
      if (next === undefined) throw new Error('unexpected offline model request');
      const raw = typeof next === 'function' ? await next({ request, context, store, settings }) : next;
      config?.onResponse?.({ text: raw, reasoning: '', finishReason: 'stop', complete: true });
      return raw;
    },
  };
  c.callSillyTavernModel = async (userPrompt, systemPrompt, onDelta, config) => c.callExternalApi(
    [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }], onDelta, config, config?.controller);
  vm.createContext(c);
  vm.runInContext([promptSource, normalizeSource, qualitySource, geoSource, generationSource].join('\n'), c);
  vm.runInContext('directorMemoryHostModule = memoryHostFixture;', c);
  return { c, store, context, settings, requests, toasts, get selectionCount() { return selectionCount; }, get saves() { return saveCount; }, get injects() { return injectCount; },
    changeMemory() { memoryText = 'CHANGED_MEMORY'; memoryFingerprint = 'memory-v2'; } };
}

test('director remains independent of image admission when storyboard is off despite retained automatic preferences', async () => {
  const e = fixture({ settings: BASIC, responses: [JSON.stringify(fullPlan(BASIC))] });
  await e.c.generateDirectorPlan();
  assert.equal(e.requests.length, 1); assert.equal(e.saves, 1); assert.equal(e.injects, 1);
  assert.equal(e.settings.logHistory[0].kind, 'director'); assert.equal(e.settings.logHistory[0].status, 'success');
});

test('account verification failures belong to director diagnostics, never claim an image was submitted', async () => {
  for (const afterRequest of [false, true]) {
    const e = fixture({ settings: BASIC, responses: [JSON.stringify(fullPlan(BASIC))] });
    e.c.resolveImageAccountNamespace = async () => {
      if (!afterRequest || e.requests.length) throw new Error('暂未确认当前 ST 账户，未提交生图，请稍后重试');
      return 'st-user:one';
    };
    await e.c.generateDirectorPlan();
    assert.equal(e.requests.length, afterRequest ? 1 : 0);
    assert.equal(e.saves, 0); assert.equal(e.injects, 0); assert.equal(e.store.plan.original, true);
    const log = e.settings.logHistory[0];
    assert.equal(log.kind, 'director'); assert.equal(log.status, 'error');
    assert.match(log.error, /推演/); assert.doesNotMatch(log.error, /生图/);
    if (afterRequest) assert.equal(log.response, JSON.stringify(fullPlan(BASIC)));
  }
});

test('host prompt inventory does not affect the director source fingerprint, while connection parameters still do', () => {
  const e = fixture({ settings: { providerMode: 'sillytavern' } });
  e.context.mainApi = 'openai'; e.context.getChatCompletionModel = () => 'gemini-fixture';
  e.context.chatCompletionSettings = { temperature: 0.7, prompts: { toJSON() { assert.fail('unselected host inventory must not be serialized'); } }, prompt_order: [] };
  const first = e.c.directorSourceFingerprint();
  e.context.chatCompletionSettings.prompts = [{ content: 'unselected'.repeat(100000) }];
  e.context.chatCompletionSettings.prompt_order = [{ character_id: 100001, order: [] }];
  assert.equal(e.c.directorSourceFingerprint(), first);
  e.context.chatCompletionSettings.temperature = 0.8;
  assert.notEqual(e.c.directorSourceFingerprint(), first);
});

test('group role boundaries use actual character members, never the group display name', async () => {
  const e = fixture({ settings: BASIC });
  Object.assign(e.context, { groupId: 'g', groups: [{ id: 'g', name: '街坊', members: ['a.png', 'b.png'] }],
    characters: [{ avatar: 'a.png', name: '阿岚' }, { avatar: 'b.png', name: '老周' }] });
  let run = {}; await e.c.buildPrompt(run);
  assert.deepEqual([...run.creativeOptions.characterNames], ['阿岚', '老周']);
  e.context.groups = []; run = {}; await e.c.buildPrompt(run);
  assert.deepEqual([...run.creativeOptions.characterNames], []);
});

test('source guards serialize selected entries only, while selected content and toggles remain guarded', () => {
  const e = fixture(), c = e.c;
  c.getContextItemId = item => item.id;
  c.getSelectedPresetNames = () => ['P']; c.getSelectedWorldBookNames = () => ['W'];
  e.settings.selectedPresetItems = { P: { on: true, off: false } };
  e.settings.selectedWorldBookItemsByChat = { 'chat-one': { W: { on: true, off: false } } };
  const forbidden = { id: 'off', toJSON() { assert.fail('unselected source content must not be serialized'); } };
  c.contextScanCache.presets = { P: [{ id: 'on', content: 'selected preset' }, forbidden] };
  c.contextScanCache.worldBooks = { W: [{ id: 'on', content: 'selected world' }, forbidden] };
  const first = c.directorSourceFingerprint();
  c.contextScanCache.presets.P[1] = { id: 'off', content: 'unselected'.repeat(100000) };
  c.contextScanCache.worldBooks.W[1] = { id: 'off', content: 'unselected'.repeat(100000) };
  assert.equal(c.directorSourceFingerprint(), first);
  c.contextScanCache.presets.P[0].content += ' changed';
  assert.notEqual(c.directorSourceFingerprint(), first);
  c.contextScanCache.presets.P[0].content = 'selected preset';
  c.contextScanCache.worldBooks.W[0].content += ' changed';
  assert.notEqual(c.directorSourceFingerprint(), first);
  c.contextScanCache.worldBooks.W[0].content = 'selected world';
  e.settings.selectedPresetItems.P.off = true;
  assert.notEqual(c.directorSourceFingerprint(), first);
});

test('actual buildPrompt binds sources, custom blueprint and one fixed interlude choice per run', async () => {
  const e = fixture({ settings: { outputSchemaText: 'CUSTOM_SCHEMA：字段附带私人阅读偏好。' } });
  e.store.plan = fullPlan(); e.store.plan.world_chatter = [{ text: 'CHATTER_ONLY_CONTENT' }]; e.store.plan.director_comment = ['COMMENT_ONLY_CONTENT'];
  const run = {}, prompt = await e.c.buildPrompt(run);
  for (const marker of ['WORLD_SOURCE', 'PRESET_SOURCE', 'MEMORY_SOURCE', 'HISTORY_SOURCE', 'USER_SOURCE', 'CUSTOM_BLUEPRINT', 'CUSTOM_SCHEMA']) assert.ok(prompt.includes(marker), marker);
  for (const marker of ['PARALLEL_ONLY_CONTENT', 'CHATTER_ONLY_CONTENT', 'COMMENT_ONLY_CONTENT']) assert.ok(!prompt.includes(marker), marker);
  assert.ok(!JSON.stringify(projectCreativeContinuity(e.store.plan)).includes('INTERLUDE_ONLY_CONTENT'));
  assert.match(prompt, /上轮趣味防重复参照[\s\S]*不是事实来源[\s\S]*INTERLUDE_ONLY_CONTENT/);
  assert.doesNotMatch(prompt, /第1条钥匙交接消息/, 'only the bounded first excerpt is sent, never the full old chat');
  assert.equal(e.selectionCount, 1);
  assert.equal(run.creativeOptions.interludeType, 'phone');
  assert.equal(run.creativeOptions.parallelSceneEnabled, true);
  assert.equal(run.sourceFingerprint, e.c.directorSourceFingerprint());
  assert.equal(run.memoryStatus.status, 'ready');
  assert.match(prompt, /candidate_reference/);
  assert.match(prompt, /仍为候选参考/);
  assert.ok(prompt.includes('"type": "phone"'));
  assert.ok(prompt.includes(CREATIVE_GUIDES.phone), 'the complete current phone viewpoint and naming guidance reaches the actual request');
});

test('same-floor rerolls discard the previous candidate branch and synthetic director injection', async () => {
  const e = fixture({ settings: BASIC });
  e.store.plan = fullPlan(); e.store.lastPlanIdx = e.context.chat.length - 1;
  e.context.chat.push({ name: 'System', is_system: true, mes: 'OLD_DIRECTOR_DIGEST', extra: { qianmu_injected: true } });
  // Keep the stored floor aligned with the expanded chat fixture.
  e.store.lastPlanIdx = e.context.chat.length - 1;
  const run = {}, prompt = await e.c.buildPrompt(run);
  assert.equal(run.sameFloorReroll, true);
  assert.match(prompt, /同楼层独立重推演/);
  assert.doesNotMatch(prompt, /上次推演参考/);
  assert.doesNotMatch(prompt, /OLD_DIRECTOR_DIGEST/);
});

test('new-floor prompts retain ordinary continuity for the prior candidate plan', async () => {
  const e = fixture({ settings: BASIC });
  e.store.plan = fullPlan(); e.store.lastPlanIdx = 0;
  const prompt = await e.c.buildPrompt({});
  assert.match(prompt, /上次推演参考/);
});

test('removing the temporary memory card preserves exact request memory and its diagnostics without a second archive', async () => {
  const memory = '【长期记忆】\n<script>not executable</script>\n【近期正文】\n' + '一段完整的旧经历'.repeat(1400);
  const e = fixture({ settings: BASIC, memoryResult: { text: memory },
    worldText: '【已保存的故事记忆】\nDECOY_NOT_MEMORY', responses: [JSON.stringify(fullPlan(BASIC))] });
  await e.c.generateDirectorPlan();
  const log = e.settings.logHistory[0], originalRequest = log.request;
  const request = JSON.parse(originalRequest)[1].content;
  assert.ok(request.includes('【已保存的故事记忆】\n' + memory));
  assert.equal(log.memory.status, 'ready');
  e.changeMemory();
  assert.equal(log.request, originalRequest, 'subsequent memory changes never rewrite a recorded request');
  assert.doesNotMatch(JSON.stringify(e.store), /not executable|memoryInspection|memory-v1/);
  assert.equal('memoryInspection' in log, false);
  assert.doesNotMatch(entry, /directorMemoryInspection|renderDirectorMemoryReview|bindDirectorMemoryReview|data-director-memory-review|run\.memoryInspection|memoryOffset/);
});

test('failed requests preserve the actual memory in logs without implying the saved plan used it', async () => {
  const e = fixture({ settings: BASIC, responses: [() => { throw new Error('fixture transport rejected'); }] });
  await e.c.generateDirectorPlan();
  const log = e.settings.logHistory[0];
  assert.equal(log.status, 'error'); assert.match(log.request, /MEMORY_SOURCE/);
  assert.equal(log.memory.status, 'ready');
  assert.equal(e.store.plan.original, true); assert.equal(e.saves, 0);
});

test('empty and partial memory retain actual request-time diagnostics after inspection UI removal', async () => {
  for (const [status, text] of [['disabled', ''], ['empty', ''], ['partial', 'ONLY_VALID_PART']]) {
    const e = fixture({ settings: BASIC, memoryResult: { status, text }, responses: [JSON.stringify(fullPlan(BASIC))] });
    await e.c.generateDirectorPlan();
    const log = e.settings.logHistory[0];
    assert.equal(log.memory.status, status);
    if (text) assert.ok(log.request.includes(text)); else assert.doesNotMatch(log.request, /MEMORY_SOURCE|ONLY_VALID_PART/);
  }
});

test('preflight failures do not fabricate a submitted memory request', async () => {
  const failed = fixture({ settings: { ...BASIC, contextBudget: 1 } });
  await failed.c.generateDirectorPlan();
  assert.equal(failed.requests.length, 0);
  assert.equal(failed.settings.logHistory[0].request, '');
  assert.equal(failed.settings.logHistory[0].memory, undefined);
});

test('a later API preflight failure preserves the original request log without carrying its memory to the failure', async () => {
  const e = fixture({ settings: BASIC, responses: [JSON.stringify(fullPlan(BASIC))] });
  await e.c.generateDirectorPlan();
  const original = e.settings.logHistory[0], request = original.request;
  e.c.validateApiSettings = () => false;
  await e.c.generateDirectorPlan();
  assert.equal(original.request, request); assert.equal(original.status, 'success');
  assert.equal(e.settings.logHistory[1].request, '');
  assert.equal(e.settings.logHistory[1].memory, undefined);
  assert.equal(e.requests.length, 1);
});

test('actual preparation stops on changed memory before request and does not discard old results', async () => {
  const e = fixture({ duringWorldRead: ({ changeMemory }) => changeMemory() });
  await e.c.generateDirectorPlan();
  assert.equal(e.requests.length, 0);
  assert.equal(e.store.plan.original, true);
  assert.equal(e.saves, 0); assert.equal(e.injects, 0);
  assert.match(e.settings.logHistory[0].error, /准备期间已变化/);
});

test('actual source budget failure is preflight only and never silently truncates inputs', async () => {
  const e = fixture({ settings: { contextBudget: 1 } });
  await e.c.generateDirectorPlan();
  assert.equal(e.requests.length, 0); assert.equal(e.selectionCount, 0);
  assert.equal(e.store.plan.original, true); assert.equal(e.saves, 0);
  assert.match(e.settings.logHistory[0].error, /超过当前上下文预算.*未裁切、未提交/);
});

test('full prompt budget includes creative system and output contract, not just selected sources', async () => {
  const e = fixture({ settings: { contextBudget: 500 } });
  await e.c.generateDirectorPlan();
  assert.equal(e.selectionCount, 1, 'source-only budget passed before full contract assembly');
  assert.equal(e.requests.length, 0); assert.equal(e.saves, 0);
  assert.match(e.settings.logHistory[0].error, /完整创作资料超过当前上下文预算/);
});

test('actual phone admission includes a narrative supporting character who is not a chat speaker', async () => {
  const plan = fullPlan(); plan.interlude.owner = '老周';
  const e = fixture({ responses: [JSON.stringify(plan)] });
  assert.ok(!e.context.chat.some(message => message.name === '老周'));
  await e.c.generateDirectorPlan();
  assert.equal(e.requests.length, 1); assert.equal(e.saves, 1);
  assert.equal(e.store.plan.interlude.owner, '老周');
});

test('worldbook-only names do not become phone owners without appearing in narrative or effective memory', async () => {
  const plan = fullPlan(); plan.interlude.owner = '方先生';
  const e = fixture({ worldText: 'WORLD_SOURCE：方先生拥有手机，只在设定中出现。', responses: [JSON.stringify(plan)] });
  await e.c.generateDirectorPlan();
  assert.equal(e.requests.length, 1);
  assert.equal(e.saves, 0); assert.equal(e.store.plan.original, true);
  assert.ok(e.settings.logHistory[0].quality.issues.some(issue => issue.field === 'interlude'));
});

test('each provider makes one request only; incomplete output keeps original responses and per-run switches without repair', async () => {
  for (const providerMode of ['external', 'sillytavern']) {
    const first = fullPlan(); first.quests.pop();
    const e = fixture({ settings: { providerMode }, responses: [JSON.stringify(first), () => assert.fail('no automatic supplemental model call')] });
    await e.c.generateDirectorPlan();
    assert.equal(e.requests.length, 1); assert.equal(e.selectionCount, 1);
    assert.equal(e.store.plan.original, true); assert.equal(e.saves, 0); assert.equal(e.injects, 0);
    const log = e.settings.logHistory[0];
    assert.equal(log.response, JSON.stringify(first));
    assert.equal(log.repairResponse, undefined); assert.equal(log.repairError, undefined);
    assert.doesNotMatch(log.error, /未自动补写/);
    assert.deepEqual(plain(log.creativeOptions), { parallelSceneEnabled: true, interludeEnabled: true, interludeType: 'phone', worldChatterEnabled: false, geopoliticsEnabled: false });
    assert.doesNotMatch(JSON.stringify(log.creativeOptions), /SOURCE|personaNames|phoneSourceText|characterNames/);
    assert.ok(log.quality.issues.some(issue => issue.field === 'quests' && issue.missing === 1));
    assert.equal(directorPreviewPlan(log).quests.length, 4);
    assert.equal(e.toasts.length, 1); assert.match(e.toasts[0][0], /预演.*已收内容/);
  }
});

test('first-response gaps retain prior plan, history and injection selection without requesting completion', async () => {
  const incomplete = fullPlan(BASIC); incomplete.quests.pop();
  incomplete.limitations = [{ field: 'quests', missing: 1, reason: '明确的封闭设定不允许补充可接近的场景。' }];
  const e = fixture({ settings: BASIC, responses: [JSON.stringify(incomplete)] });
  e.store.history = [{ id: 'old-history', plan: { old: true } }];
  e.c.injectSelection.set('old-selection', 'keep');
  const old = e.store.plan;
  await e.c.generateDirectorPlan();
  assert.equal(e.requests.length, 1);
  assert.equal(e.store.plan, old);
  assert.equal(e.store.history[0].id, 'old-history');
  assert.equal(e.c.injectSelection.get('old-selection'), 'keep');
  assert.equal(e.saves, 0); assert.equal(e.injects, 0);
  const log = e.settings.logHistory[0];
  assert.equal(log.status, 'error');
  assert.doesNotMatch(log.error, /旧结果保留/);
  assert.ok(log.quality.issues.some(issue => issue.field === 'quests' && issue.missing === 1));
  assert.equal(log.limitations[0].missing, 1);
  assert.equal(log.response, JSON.stringify(incomplete));
});

test('source changes during first request prevent adoption and do not launch another request', async () => {
  const incomplete = fullPlan(BASIC); incomplete.quests.pop();
  const e = fixture({ settings: BASIC, responses: [({ context }) => { context.chat[0].mes += ' NEW_SOURCE'; return JSON.stringify(incomplete); }] });
  await e.c.generateDirectorPlan();
  assert.equal(e.requests.length, 1);
  assert.equal(e.store.plan.original, true); assert.equal(e.saves, 0); assert.equal(e.injects, 0);
  assert.match(e.settings.logHistory[0].error, /正文、记忆或创作设置已变化/);
});

test('cancelled, interrupted and malformed responses preserve received cards without supplementation, saving or injection', async () => {
  const first = fullPlan(BASIC);
  const partial = '{"story_status":' + JSON.stringify(first.story_status) + ',"quests":[' + JSON.stringify(first.quests[0]) + ',{"title":"unfinished';
  for (const providerMode of ['external', 'sillytavern']) for (const failure of ['cancelled', 'interrupted', 'invalid-json']) {
    const e = fixture({ settings: { ...BASIC, providerMode, streamEnabled: true }, responses: [({ request }) => {
      request.onDelta(partial);
      if (failure === 'invalid-json') return partial;
      const error = new Error(failure === 'cancelled' ? 'USER_CANCELLED' : 'MODEL_STREAM_INTERRUPTED: transport fixture');
      if (failure === 'cancelled') error.name = 'AbortError';
      else error.modelResponse = { text: partial, reasoning: '', finishReason: 'length', complete: false, interrupted: true };
      throw error;
    }] });
    await e.c.generateDirectorPlan();
    assert.equal(e.requests.length, 1, `${providerMode}:${failure}`);
    assert.equal(e.saves, 0); assert.equal(e.injects, 0); assert.equal(e.store.plan.original, true);
    const log = e.settings.logHistory[0];
    assert.equal(log.response, partial);
    assert.equal(log.status, failure === 'cancelled' ? 'cancelled' : 'error');
    assert.ok(log.quality.issues.some(issue => issue.field === 'quests' && issue.missing === 4));
    assert.equal(directorPreviewPlan(log).quests.length, 1);
    assert.equal(e.toasts.length, 1); assert.doesNotMatch(e.toasts[0][0], /未自动补写/);
    if (failure === 'interrupted') { assert.match(log.error, /transport fixture/); assert.equal(log.completion.finishReason, 'length'); }
    if (failure === 'invalid-json') { assert.match(log.error, /模型输出格式有误|未完整完成/); assert.equal(log.completion.interrupted, undefined, 'format error is not fabricated truncation'); }
  }
});

test('complete outputs save and inject once per provider, while background gaps still produce one summary', async () => {
  for (const providerMode of ['external', 'sillytavern']) {
    const complete = fixture({ settings: { ...BASIC, providerMode }, responses: [JSON.stringify(fullPlan(BASIC))] });
    await complete.c.generateDirectorPlan();
    assert.equal(complete.requests.length, 1); assert.equal(complete.saves, 1); assert.equal(complete.injects, 1);
    assert.equal(complete.settings.logHistory[0].status, 'success');
    assert.equal(complete.store.directorQuality.repaired, undefined);
    const partial = fullPlan(BASIC); partial.quests.pop();
    const background = fixture({ settings: { ...BASIC, providerMode }, responses: [JSON.stringify(partial)] });
    await background.c.generateDirectorPlan(false, true, { background: true });
    assert.equal(background.requests.length, 1); assert.equal(background.saves, 0); assert.equal(background.injects, 0);
    assert.equal(background.toasts.length, 1); assert.match(background.toasts[0][0], /预演.*已收内容/);
  }
  assert.doesNotMatch(qualitySource, /repairDirectorPlanQuality|callExternalApi|callSillyTavernModel|mergeCreativeRepair/);
  assert.doesNotMatch(generationSource, /repairDirectorPlanQuality|repairResponse\s*=|repairError\s*=/);
});

test('actual normalization supports new readable cards and legacy fields without auto-validating bad interludes', () => {
  const e = fixture();
  const raw = { quests: [{ id: 'old', objective: '完整旧际遇情境', reward: '旧字段保留' }], character_dynamics: { name: '阿岚', next_action: '先核对旧信上的邮戳。' }, interlude: { type: 'wrong', title: '短卡', content: '台词仍在，不应被静默换型。' }, world_updates: [{ title: '旧回声', content: '旧资料不清除' }] };
  const result = e.c.normalizePlan(raw, { interludeType: 'phone' });
  assert.equal(result.quests[0].description, '完整旧际遇情境');
  assert.equal(result.quests[0].reward, '旧字段保留');
  assert.equal(result.character_dynamics[0].name, '阿岚');
  assert.equal(result.world_updates[0].content, '旧资料不清除');
  assert.equal(result.interlude.type, 'wrong');
  assert.ok(e.c.directorQualityNeeds(result, null, e.store, { interludeType: 'phone' }).issues.some(issue => issue.field === 'interlude'));
});

test('unmodified qualified entries and persistent states are not rejected for resembling previous plans', () => {
  const e = fixture({ settings: BASIC }), plan = fullPlan(BASIC);
  const needs = e.c.directorQualityNeeds(plan, structuredClone(plan), e.store, BASIC);
  assert.equal(needs.issues.length, 0);
  assert.equal(needs.stagnantFields.length, 0);
  assert.equal(e.c.directorHasQualityNeeds(needs), false);
});

test('custom system, schema, library template and chat blueprint survive upgrade and are actually sent', async () => {
  const e = fixture({ settings: { ...BASIC, systemPrompt: 'CUSTOM_SYSTEM 原文', outputSchemaText: 'CUSTOM_FORMAT 原文',
    templates: [{ id: 'default-free-blueprint', content: 'CUSTOM_LIBRARY 原文' }] }, responses: [JSON.stringify(fullPlan(BASIC))] });
  e.store.blueprint = 'CUSTOM_CHAT_BLUEPRINT 原文';
  upgradeCreativeDefaults(e.settings, { systemPrompt: CREATIVE_SYSTEM_PROMPT, outputSchemaText: createCreativeSchema(), blueprint: CREATIVE_BLUEPRINT });
  upgradeCreativeBlueprint(e.store, CREATIVE_BLUEPRINT, 100);
  assert.equal(e.settings.systemPrompt, 'CUSTOM_SYSTEM 原文');
  assert.equal(e.settings.outputSchemaText, 'CUSTOM_FORMAT 原文');
  assert.equal(e.settings.templates[0].content, 'CUSTOM_LIBRARY 原文');
  assert.equal(e.store.blueprint, 'CUSTOM_CHAT_BLUEPRINT 原文');
  await e.c.generateDirectorPlan();
  assert.equal(e.requests.length, 1); assert.equal(e.saves, 1);
  assert.equal(e.requests[0].messages[0].content, 'CUSTOM_SYSTEM 原文');
  assert.match(e.requests[0].messages[1].content, /CUSTOM_FORMAT 原文/);
  assert.match(e.requests[0].messages[1].content, /CUSTOM_CHAT_BLUEPRINT 原文/);
});

test('model schema uses the actual world merge enums and story time remains a display string', () => {
  const e = fixture();
  const schema = createCreativeSchema({ ...BASIC, geopoliticsEnabled: true });
  const start = schema.indexOf('{\n'), shape = JSON.parse(schema.slice(start, schema.indexOf('\n\n', start)));
  assert.equal(typeof shape.story_status.cycle, 'string');
  for (const value of vm.runInContext('FACTION_TRENDS', e.c)) assert.ok(shape.factions[0].trend.includes(value));
  for (const value of vm.runInContext('FACTION_SCALES', e.c)) assert.ok(shape.factions[0].scale.includes(value));
  e.c.mergeGeopolitics(e.store, { factions: [{ id: 'f', name: '码头工会', agenda: '核算运费', trend: 'declining', scale: '城邦内' }], faction_relations: [], world_events: [] });
  assert.equal(e.store.factions[0].trend, 'declining');
  assert.equal(e.store.factions[0].scale, '城邦内');
  const normalized = e.c.normalizePlan(fullPlan(BASIC), BASIC);
  assert.equal(normalized.story_status.cycle, '周三傍晚');
});
