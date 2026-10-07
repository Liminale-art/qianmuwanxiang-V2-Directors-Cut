import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { parseDirectorFinal, paintModelLog, renderDirectorLive } from '../qianmu-director-live.js';
import { CREATIVE_SYSTEM_PROMPT, CREATIVE_BLUEPRINT, creativeSectionGuidance } from '../qianmu-creative-prompts.js';
import { createCreativeSchema, normalizeCreativeSections, validateCreativePlan, pruneInvalidCreativeItems, projectCreativeContinuity } from '../qianmu-creative-contract.js';
import { selectCreativeOptions, mergeCreativeRepair, upgradeCreativeDefaults, upgradeCreativeBlueprint } from '../qianmu-creative-runtime.js';
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
const memoryReviewSource = between('function renderDirectorMemoryReview(', '\nfunction renderDashboardTab(');
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
    story_status: { title: '街角', cycle: '周三傍晚', summary: '旧信仍未领走。' },
    quests: Array.from({ length: 5 }, (_, i) => ({ title: `来信${i}`, description: `第${i}份信送到了街口，伙计正在寻找收信者。` })),
    character_dynamics: Array.from({ length: 2 }, (_, i) => ({ title: `待办${i}`, content: `阿岚把第${i}份账单拿到灯下核对，尚未动笔。` })),
    npc_updates: Array.from({ length: 3 }, (_, i) => ({ name: `邻居${i}`, next_action: `邻居正在为第${i}家店铺检查送货的路。` })),
    chain_reactions: Array.from({ length: 3 }, (_, i) => ({ spark: `第${i}条路临时改道。`, chain: `伙计将第${i}车货改送后巷，掌柜先通知收货人。` })),
    relation_undercurrents: Array.from({ length: 3 }, (_, i) => ({ parties: `阿岚和邻居${i}`, tension: `第${i}张欠条尚未提起，两人都先谈了眼前的天气。` })),
    limitations: [],
  };
  if (options.parallelSceneEnabled !== false) plan.parallel_scene = { title: '如果赶上早班车', content: 'PARALLEL_ONLY_CONTENT：车门没有在面前关上，旧友从空座旁抬起头。' };
  if (options.interludeEnabled !== false) plan.interlude = { type: 'phone', title: '早班群', owner: '阿岚', content: 'INTERLUDE_ONLY_CONTENT：老周：钥匙带了吗？阿岚：今天不是换锁吗。' };
  return plan;
}

function fixture({ settings: overrides = {}, responses = [], duringWorldRead, memoryResult = {}, worldText = 'WORLD_SOURCE：旧码头仍在维修，有手机。' } = {}) {
  let saveCount = 0, injectCount = 0, selectionCount = 0, id = 0;
  let memoryText = memoryResult.text ?? 'MEMORY_SOURCE：旧码头的欠款尚未结清。', memoryFingerprint = 'memory-v1';
  const requests = [];
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
    creativeSectionGuidance, createCreativeSchema, normalizeCreativeSections, validateCreativePlan, pruneInvalidCreativeItems, projectCreativeContinuity, mergeCreativeRepair,
    selectCreativeOptions: (value, options) => { selectionCount++; return selectCreativeOptions(value, { ...options, random: () => .9 }); },
    busy: false, cancelRequested: false, abortController: null, directorRun: null, directorLiveLog: null, directorMemoryInspection: null, activeTab: 'dashboard', MODAL_ID: 'panel',
    document: { getElementById: () => null }, AbortController, Date, console, clone: structuredClone,
    validateApiSettings: () => true, toast: () => {}, apiToast: () => {}, uid: prefix => `${prefix}-${++id}`,
    featureRuntime: { load: async () => assert.fail('ordinary director requests must not load image admission') },
    resolveImageAccountNamespace: async () => 'st-user:one',
    storyboardState: () => ({ enabled: false, automation: { autoGenerate: true }, directorBridge: { worldSideShotsEnabled: true, worldAutoGenerate: true } }),
    renderBusyState: () => {}, renderModal: () => {}, renderFloatButton: () => {}, rerenderIfOpen: () => {},
    pushLog: log => { settings.logHistory.push(log); return log; }, saveSettings: () => {},
    saveMetadata: async () => { saveCount++; }, applyDirectorInjection: async () => { injectCount++; }, injectSelection: new Map(),
    storyboardQueueNewWorldPlan: async () => assert.fail('disabled storyboard must not receive director work'), parseDirectorFinal, paintModelLog, renderDirectorLive,
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
  vm.createContext(c);
  vm.runInContext([promptSource, normalizeSource, qualitySource, geoSource, generationSource, memoryReviewSource].join('\n'), c);
  vm.runInContext('directorMemoryHostModule = memoryHostFixture;', c);
  return { c, store, context, settings, requests, get selectionCount() { return selectionCount; }, get saves() { return saveCount; }, get injects() { return injectCount; },
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
  for (const marker of ['PARALLEL_ONLY_CONTENT', 'INTERLUDE_ONLY_CONTENT', 'CHATTER_ONLY_CONTENT', 'COMMENT_ONLY_CONTENT']) assert.ok(!prompt.includes(marker), marker);
  assert.equal(e.selectionCount, 1);
  assert.equal(run.creativeOptions.interludeType, 'phone');
  assert.equal(run.creativeOptions.parallelSceneEnabled, true);
  assert.equal(run.sourceFingerprint, e.c.directorSourceFingerprint());
  assert.equal(run.memoryStatus.status, 'ready');
  assert.match(prompt, /candidate_reference/);
  assert.match(prompt, /仍为候选参考/);
  assert.ok(prompt.includes('"type": "phone"'));
  assert.ok(prompt.includes('只从正文已经出现的 CHAR 或其他非 USER 人物中选取手机所属者'));
});

test('temporary memory review reads the exact request range, not duplicate headings or later memory', async () => {
  const memory = '【长期记忆】\n<script>not executable</script>\n【近期正文】\n' + '一段完整的旧经历'.repeat(1400);
  const e = fixture({ settings: BASIC, memoryResult: { text: memory },
    worldText: '【已保存的故事记忆】\nDECOY_NOT_MEMORY', responses: [JSON.stringify(fullPlan(BASIC))] });
  await e.c.generateDirectorPlan();
  const review = e.c.directorMemoryInspection, request = JSON.parse(review.log.request)[1].content;
  assert.equal(request.slice(review.snapshot.start, review.snapshot.start + review.snapshot.length), memory);
  assert.equal(review.snapshot.length, memory.length);
  const html = e.c.renderDirectorMemoryReview(true);
  assert.match(html, /分层滚动 · 混合/); assert.match(html, /推演成功/);
  assert.match(html, /&lt;script&gt;not executable&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script>|DECOY_NOT_MEMORY/);
  e.changeMemory();
  assert.equal(e.c.renderDirectorMemoryReview(true), html, 'opening does not reread or replace the request snapshot');
  assert.doesNotMatch(JSON.stringify(e.store), /not executable|memoryInspection|memory-v1/);
  assert.equal('memoryInspection' in review.log, false, 'the card adds no persistent memory copy to logs');
  assert.equal('text' in review.snapshot, false, 'only offsets and display metadata are retained');
});

test('temporary review is available for failed requests without implying the old plan used them', async () => {
  const e = fixture({ settings: BASIC, responses: [() => { throw new Error('fixture transport rejected'); }] });
  await e.c.generateDirectorPlan();
  const html = e.c.renderDirectorMemoryReview(true);
  assert.match(html, /推演失败/); assert.match(html, /MEMORY_SOURCE/);
  assert.match(html, /不是当前审片的剧情内容/); assert.match(html, /不代表模型已经收到或采用/);
  assert.equal(e.store.plan.original, true); assert.equal(e.saves, 0);
});

test('empty and partial memory keep their actual request-time status without a fabricated current snapshot', async () => {
  for (const [status, text, label] of [['disabled', '', '记忆联动未启用'], ['empty', '', '没有可用记忆'],
    ['partial', 'ONLY_VALID_PART', '部分纳入请求内容']]) {
    const e = fixture({ settings: BASIC, memoryResult: { status, text }, responses: [JSON.stringify(fullPlan(BASIC))] });
    await e.c.generateDirectorPlan();
    const html = e.c.renderDirectorMemoryReview(true);
    assert.ok(html.includes(label));
    if (text) assert.ok(html.includes(text)); else assert.doesNotMatch(html, /class="sd-memory-review-text"|已纳入请求内容/);
  }
});

test('preflight failures and session changes cannot expose another chat or fabricate submitted memory', async () => {
  const failed = fixture({ settings: { ...BASIC, contextBudget: 1 } });
  await failed.c.generateDirectorPlan();
  assert.equal(failed.requests.length, 0);
  assert.match(failed.c.renderDirectorMemoryReview(true), /未形成请求/);
  assert.doesNotMatch(failed.c.renderDirectorMemoryReview(true), /MEMORY_SOURCE|class="sd-memory-review-text"/);
  for (const change of [e => { e.context.chat = []; }, e => { e.c.settings = { ...e.settings }; },
    e => { e.c.getChatKey = () => 'another-chat'; }, e => { e.c.getChatStore = () => ({}); },
    e => { e.c.directorMemoryInspection = null; }]) {
    const e = fixture({ settings: BASIC, responses: [JSON.stringify(fullPlan(BASIC))] });
    await e.c.generateDirectorPlan(); change(e);
    const html = e.c.renderDirectorMemoryReview(true);
    assert.match(html, /本页尚无推演请求记录/); assert.doesNotMatch(html, /MEMORY_SOURCE|推演成功/);
  }
});

test('a later API preflight failure replaces the previous successful inspection', async () => {
  const e = fixture({ settings: BASIC, responses: [JSON.stringify(fullPlan(BASIC))] });
  await e.c.generateDirectorPlan();
  assert.match(e.c.renderDirectorMemoryReview(true), /推演成功/);
  e.c.validateApiSettings = () => false;
  await e.c.generateDirectorPlan();
  const html = e.c.renderDirectorMemoryReview(true);
  assert.match(html, /未形成请求/); assert.doesNotMatch(html, /推演成功|MEMORY_SOURCE/);
  assert.equal(e.requests.length, 1);
});

test('cleared or evicted logs cannot remain visible through the temporary inspection reference', async () => {
  const e = fixture({ settings: BASIC, responses: [JSON.stringify(fullPlan(BASIC))] });
  await e.c.generateDirectorPlan();
  e.settings.logHistory = [];
  assert.match(e.c.renderDirectorMemoryReview(true), /本页尚无推演请求记录/);
  assert.doesNotMatch(e.c.renderDirectorMemoryReview(true), /MEMORY_SOURCE|推演成功/);
  assert.match(entry, /if \(selected.includes\('__diagnostics__'\)\) \{\s*settings.logHistory = \[\];\s*directorMemoryInspection = null/);
});

test('stream deltas do not repeatedly parse or replace the unchanged memory review', async () => {
  const e = fixture({ settings: BASIC, responses: [JSON.stringify(fullPlan(BASIC))] });
  await e.c.generateDirectorPlan();
  let paints = 0, card;
  const makeCard = () => {
    const detail = { open: true };
    return { querySelector: () => detail, set outerHTML(value) { assert.match(value, /记忆联动/); paints++; card = makeCard(); } };
  };
  card = makeCard();
  e.c.renderLogEntry = () => '';
  e.c.paintModelLog = () => {};
  e.c.bindDirectorMemoryReview = () => {};
  e.c.document.getElementById = () => ({ querySelector: selector => selector === '[data-director-memory-review]' ? card : null });
  e.c.refreshDirectorLiveUI();
  for (let index = 0; index < 50; index++) { e.c.directorLiveLog.response += '字'; e.c.refreshDirectorLiveUI(); }
  assert.equal(paints, 1); assert.equal(card.querySelector().open, true);
  e.settings.logHistory = []; e.c.refreshDirectorLiveUI();
  assert.equal(paints, 2, 'log removal invalidates the display even without a new request');
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
  const e = fixture({ worldText: 'WORLD_SOURCE：方先生拥有手机，只在设定中出现。', responses: [JSON.stringify(plan), '{}'] });
  await e.c.generateDirectorPlan();
  assert.equal(e.requests.length, 2);
  assert.equal(e.saves, 0); assert.equal(e.store.plan.original, true);
  assert.ok(e.settings.logHistory[0].quality.issues.some(issue => issue.field === 'interlude'));
});

test('actual repair reuses the exact source prompt and fixed interlude, and appends only missing items', async () => {
  const first = fullPlan(), missing = first.quests.pop(), originalQualified = structuredClone(first.quests);
  const patch = { quests: [missing], character_dynamics: [{ title: '不得覆盖', content: 'UNREQUESTED_REPLACEMENT' }], interlude: { type: 'theater', title: '不能换型', content: 'UNREQUESTED_INTERLUDE' }, limitations: [] };
  const e = fixture({ responses: [JSON.stringify(first), JSON.stringify(patch)] });
  await e.c.generateDirectorPlan();
  assert.equal(e.requests.length, 2); assert.equal(e.selectionCount, 1);
  const firstPrompt = e.requests[0].messages[1].content, repairPrompt = e.requests[1].messages[1].content;
  assert.ok(repairPrompt.startsWith(firstPrompt + '\n\n[Complete the missing or invalid parts]'));
  for (const marker of ['WORLD_SOURCE', 'PRESET_SOURCE', 'MEMORY_SOURCE', 'HISTORY_SOURCE', 'CUSTOM_BLUEPRINT']) assert.ok(repairPrompt.includes(marker));
  assert.ok(!repairPrompt.includes('INTERLUDE_ONLY_CONTENT'));
  assert.ok(!repairPrompt.includes('PARALLEL_ONLY_CONTENT'));
  assert.equal(e.requests[1].messages[0].content, e.requests[0].messages[0].content);
  assert.deepEqual(plain(e.store.plan.quests.slice(0, 4)), originalQualified);
  assert.equal(e.store.plan.quests.length, 5);
  assert.equal(e.store.plan.character_dynamics[0].content, first.character_dynamics[0].content);
  assert.equal(e.store.plan.interlude.type, 'phone');
  assert.equal(e.store.plan.interlude.content, first.interlude.content);
  assert.equal(e.settings.logHistory[0].status, 'success');
  assert.equal(e.saves, 1); assert.equal(e.injects, 1);
});

test('remaining gaps after the one repair retain prior plan, history and injection selection', async () => {
  const incomplete = fullPlan(BASIC); incomplete.quests.pop();
  const e = fixture({ settings: BASIC, responses: [JSON.stringify(incomplete), JSON.stringify({ quests: [], limitations: [{ field: 'quests', missing: 1, reason: '明确的封闭设定不允许补充可接近的场景。' }] })] });
  e.store.history = [{ id: 'old-history', plan: { old: true } }];
  e.c.injectSelection.set('old-selection', 'keep');
  const old = e.store.plan;
  await e.c.generateDirectorPlan();
  assert.equal(e.requests.length, 2);
  assert.equal(e.store.plan, old);
  assert.equal(e.store.history[0].id, 'old-history');
  assert.equal(e.c.injectSelection.get('old-selection'), 'keep');
  assert.equal(e.saves, 0); assert.equal(e.injects, 0);
  const log = e.settings.logHistory[0];
  assert.equal(log.status, 'error');
  assert.match(log.error, /旧结果保留/);
  assert.ok(log.quality.issues.some(issue => issue.field === 'quests' && issue.missing === 1));
  assert.equal(log.limitations[0].missing, 1);
  assert.equal(log.response, JSON.stringify(incomplete));
});

test('source changes during first request prevent repair and adoption even when JSON is complete', async () => {
  const incomplete = fullPlan(BASIC); incomplete.quests.pop();
  const e = fixture({ settings: BASIC, responses: [({ context }) => { context.chat[0].mes += ' NEW_SOURCE'; return JSON.stringify(incomplete); }] });
  await e.c.generateDirectorPlan();
  assert.equal(e.requests.length, 1);
  assert.equal(e.store.plan.original, true); assert.equal(e.saves, 0); assert.equal(e.injects, 0);
  assert.match(e.settings.logHistory[0].error, /正文、记忆或创作设置已变化/);
});

test('source changes during repair cannot adopt late supplemental content', async () => {
  const incomplete = fullPlan(BASIC), missing = incomplete.quests.pop();
  const e = fixture({ settings: BASIC, responses: [JSON.stringify(incomplete), ({ context }) => { context.chat[1].mes += ' USER_REVISION'; return JSON.stringify({ quests: [missing], limitations: [] }); }] });
  await e.c.generateDirectorPlan();
  assert.equal(e.requests.length, 2); assert.equal(e.store.plan.original, true);
  assert.equal(e.saves, 0); assert.equal(e.injects, 0);
  assert.match(e.settings.logHistory[0].error, /正文、记忆或创作设置已变化/);
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
