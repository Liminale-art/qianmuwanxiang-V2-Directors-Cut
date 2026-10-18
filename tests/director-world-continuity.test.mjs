import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import * as utils from '../qianmu-storyboard-utils.js';
import * as contract from '../qianmu-creative-contract.js';
import * as creative from '../qianmu-creative-prompts.js';
import * as runtime from '../qianmu-creative-runtime.js';
import * as live from '../qianmu-director-live.js';
import { migrateQianmuChatStoreV2 } from '../qianmu-data-migrations.js';
import { captureCurrentChatSource } from '../qianmu-current-chat-source.js';
import { createDirectorLeaveGuard } from '../qianmu-director-leave-guard.js';
import { captureDirectorSaveSnapshot } from '../qianmu-director-save-confirmation.js';
import { directorHostFixture } from './helpers/director-host-fixture.mjs';
import { createDirectorNavigation } from '../qianmu-director-navigation.js';

// Execute the real loader, input composition, generation, merge and clear
// handlers. The fixture only replaces UI, storage and model transport boundaries.
const entry = await fs.readFile(new URL('../index.js', import.meta.url), 'utf8');
function between(start, end) {
  const a = entry.indexOf(start), b = entry.indexOf(end, a + start.length);
  assert.ok(a >= 0 && b > a, start);
  return entry.slice(a, b);
}
function source(name) {
  const match = new RegExp(`^(?:async )?function ${name}\\(`, 'm').exec(entry);
  assert.ok(match, name);
  const tail = entry.slice(match.index), end = tail.indexOf('\n}');
  return tail.slice(0, end + 2);
}
const parts = [
  between('function directorHistorySelection(', '\nfunction validateApiSettings('),
  between('function normalizePlan(', '// directorItemText -'),
  between('function directorDedupePlan(', 'function makeStreamLogUpdater('),
  between('const INJ_LEN =', '\n/* ============================================================'),
  between('const FACTION_TRENDS =', '\nfunction buildPlanDigest('),
  between('function makeStreamLogUpdater(', '// MIGRATED to qianmu-storyboard-utils.js (commit 19)'),
  ...['getChatStore', 'currentPlan', 'directorDisplayPlan', 'directorGeopoliticsState', 'currentDirectorInjectionText', 'buildGeopoliticsDigest', 'bindGeopoliticsTabEvents', 'resetDirectorNarrativeBridge'].map(source),
  `function bindPlanClearFixture(root) {\n${between("  root.querySelector('.sd-clear-plan')?.addEventListener", '  // 尘寰群生：')}\n}`,
  `function bindHistoryLoadFixture(root) {\n${between("  root.querySelectorAll('.sd-load-history').forEach", "  root.querySelectorAll('.sd-delete-history').forEach")}\n}`,
];
const plain = value => JSON.parse(JSON.stringify(value));
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const baseWorld = () => ({
  factions: ['A', 'B', 'C'].map((x, i) => ({ id: `base-${x}`, name: `BASE_FACTION_${x}`, standing: `BASE_STANDING_${x}`, agenda: `BASE_AGENDA_${x}`, clues: [`BASE_CLUE_${x}`], trend: 'stable', scale: '区域性', origin: 1, lastTouched: 7 - i })),
  factionRelations: [{ a: 'base-A', b: 'base-B', kind: '中立', note: 'BASE_RELATION' }],
  worldEvents: ['A', 'B'].map(x => ({ id: `base-event-${x}`, title: `BASE_EVENT_${x}`, essence: `BASE_ESSENCE_${x}`, stage: '酝酿', status: 'active', origin: 1, lastTouched: 7, silentRounds: 2, trail: [{ round: 1, stage: '酝酿' }] })),
  geoSeq: 7,
});
function plan(tag, { reviseBase = false, stage = '蔓延', world = true } = {}) {
  const result = {
    story_status: { title: `${tag}_TITLE`, directions: ['near', 'far'].map(horizon => ({ horizon, title: `${tag}_${horizon}`, content: `${tag}_${horizon}：街坊另找了一处地方收货。` })) },
    quests: Array.from({ length: 5 }, (_, i) => ({ subject: '伙计', title: `${tag}_预演_${i}`, description: `第${i}批货送到街口，伙计带来${tag}的新通知。` })),
    character_dynamics: Array.from({ length: 2 }, (_, i) => ({ name: '阿岚', title: `${tag}_事务_${i}`, content: `阿岚核对${tag}第${i}份新账目。` })),
    npc_updates: Array.from({ length: 3 }, (_, i) => ({ name: `${tag}_NPC_${i}`, next_action: `正在为${tag}第${i}家店核对送货路线。` })),
    chain_reactions: Array.from({ length: 3 }, (_, i) => ({ spark: `${tag}第${i}条路临时改道。`, chain: `第${i}车货移入后巷 → 掌柜通知别处收货人 → 邻街工坊调整排班` })),
    relation_undercurrents: Array.from({ length: 3 }, (_, i) => ({ parties: i === 2 ? ['邻居二', '掌柜二', '伙计二'] : [`邻居${i}`, `掌柜${i}`], tension: `${tag}第${i}份借据尚未交还。` })),
    limitations: [],
  };
  if (world) {
    result.factions = Array.from({ length: 3 }, (_, i) => ({ id: `${tag}-f${i}`, name: `${tag}_FACTION_${i}`, standing: `${tag}_STANDING_${i}`, agenda: `${tag}_AGENDA_${i}`, clues: [`${tag}_CLUE_${i}`], trend: 'turbulent' }));
    result.world_events = Array.from({ length: 2 }, (_, i) => ({ id: `${tag}-e${i}`, title: `${tag}_EVENT_${i}`, essence: `${tag}_ESSENCE_${i}`, stage, touched: 'advance' }));
    if (reviseBase) {
      result.factions[0] = { ...result.factions[0], id: 'base-A', name: 'BASE_FACTION_A' };
      result.world_events[0] = { ...result.world_events[0], id: 'base-event-A', title: 'BASE_EVENT_A' };
      result.faction_relations = [{ between: ['base-A', 'base-C'], kind: '冲突', note: `${tag}_RELATION` }];
    } else result.faction_relations = [{ between: [`${tag}-f0`, `${tag}-f1`], kind: '同盟', note: `${tag}_RELATION` }];
  }
  return result;
}
function fixture({ responses = [], providerMode = 'external', persisted, chat, saveHook, injectHook, confirmHook, saveConfirmationHook } = {}) {
  let id = 0, saves = 0, injects = 0, resets = 0, chatKey = 'chat-one';
  const requests = [], toasts = [], stages = [];
  const initial = persisted || { ...baseWorld(), blueprint: 'SELECTED_BLUEPRINT', plan: plan('OLD_CANDIDATE', { world: false }), planAtLen: 1, lastPlanIdx: 0,
    history: [{ id: 'old-history', plan: plan('HISTORY_ONLY', { world: false }) }], injectOverride: 'OLD_OVERRIDE' };
  const context = { name1: '访客', chatId: 'chat-one', characterId: 0, characters: [{ chat: 'chat-one', avatar: 'fixture.png' }],
    getRequestHeaders: () => ({}), saveMetadata: async () => {}, extensionSettings: { gagaDogSummary: {} }, chatMetadata: { fixture: initial }, chat: chat || [
    { name: '阿岚', is_user: false, mes: 'PROSE_SOURCE：阿岚拿起手机。' },
    { name: '访客', is_user: true, mes: 'USER_SOURCE：我问起尚未交还的信。' },
  ] };
  const settings = { enabled: true, providerMode, streamEnabled: true, parallelSceneEnabled: false, interludeEnabled: false, geopoliticsEnabled: true,
    systemPrompt: creative.CREATIVE_SYSTEM_PROMPT, outputSchemaText: contract.createCreativeSchema(), contextOptions: { contextDepth: 8, includeChatHistory: true }, contextBudget: 100000, logHistory: [] };
  const c = vm.createContext({
    ...utils, ...contract, ...creative, ...runtime, ...live,
    settings, MODULE_NAME: 'fixture', BLUEPRINT_REVISION: 456, DEFAULT_BLUEPRINT: creative.CREATIVE_BLUEPRINT,
    DEFAULT_SYSTEM_PROMPT: creative.CREATIVE_SYSTEM_PROMPT, JSON_SCHEMA_TEXT: contract.createCreativeSchema(),
    ctx: () => context, getChatKey: () => chatKey, migrateQianmuChatStoreV2, acceptMigrationResult: (_scope, result) => result.value,
    contextScanCache: { presetScannedAt: 1, worldScannedAt: 1 },
    getCharacterName: () => '阿岚', getPersonaName: () => '访客', getCharacterDescription: () => 'CHAR_SOURCE', getPersonaDescription: () => 'PERSONA_SOURCE',
    getSelectedWorldBookNames: () => [], getSelectedPresetNames: () => [], cleanContextText: String, resolveMacro: async value => value,
    buildWorldContextText: async () => 'WORLD_SOURCE CHAR_SOURCE PERSONA_SOURCE 手机', buildPresetContextText: async () => 'PRESET_SOURCE',
    memoryHostFixture: { findExtension: () => ({ enabled: true }) }, readGagaMemoryContext: () => ({ text: 'MEMORY_SOURCE', status: 'ready', diagnostics: [], snapshot: { fingerprint: 'memory-one' } }),
    estimateTokens: text => Math.ceil(text.length / 4), uid: prefix => `${prefix}-${++id}`,
    busy: false, cancelRequested: false, abortController: null, directorRun: null, directorLiveLog: null,
    directorLeaveGuard: null, directorHostState: directorHostFixture().state, directorAutoRefresh: null, directorNavigation: null, createDirectorNavigation,
    directorUnconfirmedSaves: new WeakMap(), captureCurrentChatSource, createDirectorLeaveGuard, captureDirectorSaveSnapshot,
    confirmDirectorSave: async (_snapshot, { guard }) => { await guard(); await saveConfirmationHook?.({ c, context, settings, store: c.getChatStore() }); return { status: 'confirmed' }; },
    activeTab: 'dashboard', worldPage: 'geopolitics', MODAL_ID: 'fixture-panel', document: { getElementById: () => null, addEventListener() {}, removeEventListener() {} },
    AbortController, Date, console, structuredClone, clone: structuredClone,
    validateApiSettings: () => true, resolveImageAccountNamespace: async () => 'account-one',
    renderBusyState: () => {}, renderModal: () => {}, renderFloatButton: () => {}, rerenderIfOpen: () => {}, apiToast: () => {}, toast: (message, type) => toasts.push({ message, type }),
    pushLog: log => { settings.logHistory.push(log); return log; }, saveSettings: () => {},
    saveMetadata: async () => { saves++; await saveHook?.({ c, context, settings, store: c.getChatStore(), saves }); },
    applyDirectorInjection: async () => { injects++; await injectHook?.({ c, context, settings, store: c.getChatStore(), injects }); },
    injectSelection: new Map([['old-selection', true]]), resetCreativeSocialState: () => { resets++; }, clearDirectorInjection: () => {},
    storyboardState: () => ({ enabled: false }), FACTION_RELATION_KINDS: ['冲突', '同盟', '张力', '中立', '依附'],
    confirmDialog: async (...args) => confirmHook ? confirmHook({ c, context, store: c.getChatStore(), changeChat: () => { chatKey = 'chat-two'; context.chat = [...context.chat]; }, args }) : true,
    storyboardResetWorldAutomatic: () => {}, directorNarrativeBridgeEpoch: 0, directorWorldSourceRefreshKey: '', directorWorldEntryLinks: new Map(), directorProductionPacketState: {}, directorCandidatePoolState: {},
    callExternalApi: async (messages, onDelta, config, controller) => {
      const request = { messages, onDelta, config, controller }; requests.push(request);
      stages.push({ world: plain(c.directorRun.world), saved: plain(c.captureGeopoliticsArchive(c.getChatStore())) });
      const next = responses[requests.length - 1]; assert.notEqual(next, undefined, 'unexpected extra model request');
      const raw = typeof next === 'function' ? await next({ request, c, context, settings, store: c.getChatStore() }) : next;
      config.onResponse({ text: raw, reasoning: '', finishReason: 'stop', complete: true }); return raw;
    },
  });
  c.callSillyTavernModel = (user, system, onDelta, config) => c.callExternalApi([{ role: 'system', content: system }, { role: 'user', content: user }], onDelta, config, config.controller);
  vm.runInContext(parts.join('\n'), c); vm.runInContext('directorMemoryHostModule = memoryHostFixture;', c);
  c.getChatStore();
  const click = async (selector, id) => {
    let handler;
    const node = { dataset: { id }, addEventListener: (_event, fn) => { handler = fn; } };
    const root = { querySelector: query => query === selector ? node : null, querySelectorAll: query => query === selector ? [node] : [] };
    if (selector === '.sd-clear-plan') c.bindPlanClearFixture(root);
    else if (selector === '.sd-load-history') c.bindHistoryLoadFixture(root);
    else { c.activeTab = 'castworld'; c.bindGeopoliticsTabEvents(root); }
    assert.ok(handler, selector); await handler();
  };
  return { c, settings, context, requests, toasts, stages, click, get store() { return c.getChatStore(); }, get saves() { return saves; }, get injects() { return injects; }, get resets() { return resets; } };
}
const archive = f => plain(f.c.captureGeopoliticsArchive(f.store));
const sent = (f, n) => JSON.stringify(f.requests[n].messages);
const lastLog = f => f.settings.logHistory.at(-1);

test('world node fingerprints ignore injected/UI metadata, distinguish last-floor edits from changed prefixes, and capture only cloned world fields', () => {
  const f = fixture(), before = plain(f.store), node = plain(f.c.directorWorldNode(f.context.chat));
  f.context.chat[0].extra = { checked: true }; f.context.chat[0].send_date = 'changed';
  f.context.chat.push({ name: 'System', is_system: true, mes: 'INJECTED_ONLY', extra: { qianmu_injected: true } });
  assert.deepEqual(plain(f.c.directorWorldNode(f.context.chat)), node);
  f.context.chat[1].mes = 'last-floor swipe';
  const edit = f.c.directorWorldNode(f.context.chat); assert.equal(edit.parentHash, node.parentHash); assert.notEqual(edit.hash, node.hash);
  f.context.chat[0].mes = 'earlier-floor edit'; assert.notEqual(f.c.directorWorldNode(f.context.chat).parentHash, node.parentHash);
  const copy = f.c.captureGeopoliticsArchive(f.store);
  assert.deepEqual(Object.keys(copy).sort(), ['factionRelations', 'factions', 'geoSeq', 'worldEvents']);
  copy.factions[0].clues.push('COPY_ONLY'); copy.worldEvents[0].trail[0].stage = '落定';
  assert.deepEqual(plain(f.store), before);
});

test('two same-node runs replace discarded world additions and restore omitted baseline facts, clues, relations and event trails', async () => {
  for (const providerMode of ['external', 'sillytavern']) {
    const f = fixture({ providerMode, responses: [JSON.stringify(plan('FIRST', { reviseBase: true, stage: '落定' })), JSON.stringify(plan('SECOND'))] });
    const base = archive(f);
    await f.c.generateDirectorPlan();
    assert.equal(lastLog(f).status, 'success'); assert.equal(f.store.geoSeq, 8);
    assert.match(JSON.stringify(archive(f)), /FIRST_CLUE_0|FIRST_RELATION/);
    assert.equal(f.store.worldEvents.find(e => e.id === 'base-event-A').status, 'closed');
    assert.deepEqual(plain(f.store.geoNodeCheckpoint.base), base);
    await f.c.generateDirectorPlan();
    assert.equal(lastLog(f).status, 'success'); assert.equal(f.requests.length, 2);
    assert.equal(f.stages[1].world.mode, 'reroll'); assert.equal(f.store.geoSeq, 8);
    assert.doesNotMatch(sent(f, 1), /FIRST_|OLD_CANDIDATE|HISTORY_ONLY/);
    assert.match(sent(f, 1), /BASE_STANDING_A|BASE_ESSENCE_A/);
    const current = archive(f); assert.doesNotMatch(JSON.stringify(current), /FIRST_/); assert.match(JSON.stringify(current), /SECOND_/);
    assert.deepEqual(current.factions.find(x => x.id === 'base-A'), base.factions[0]);
    assert.deepEqual(current.worldEvents.find(x => x.id === 'base-event-A'), base.worldEvents[0]);
    assert.ok(current.factionRelations.some(x => x.note === 'BASE_RELATION'));
    assert.deepEqual(plain(f.store.geoNodeCheckpoint.base), base);
    assert.equal(f.store.geoNodeCheckpoint.archiveHash, utils.hashText(JSON.stringify(current)));
    assert.equal(f.saves, 2); assert.equal(f.injects, 2);
  }
});

test('a forward floor adopts the latest world as its entering baseline; its reroll replaces only that floor and does not accumulate stages', async () => {
  const f = fixture({ responses: [JSON.stringify(plan('NODE_ONE', { reviseBase: true, stage: '蔓延' })), JSON.stringify(plan('NODE_TWO', { reviseBase: true, stage: '落定' })), JSON.stringify(plan('NODE_TWO_B', { reviseBase: true, stage: '消退' }))] });
  await f.c.generateDirectorPlan(); const first = archive(f);
  f.context.chat.push({ name: '阿岚', is_user: false, mes: 'NEXT_PROSE：工坊收到另一份通知。' });
  await f.c.generateDirectorPlan();
  assert.equal(f.stages[1].world.mode, 'advance'); assert.equal(f.store.geoSeq, 9);
  assert.match(sent(f, 1), /NODE_ONE_STANDING|NODE_ONE_ESSENCE/);
  assert.deepEqual(plain(f.store.geoNodeCheckpoint.base), first);
  await f.c.generateDirectorPlan();
  assert.equal(f.stages[2].world.mode, 'reroll'); assert.equal(f.store.geoSeq, 9);
  assert.match(sent(f, 2), /NODE_ONE_STANDING/); assert.doesNotMatch(sent(f, 2), /NODE_TWO_/);
  assert.doesNotMatch(JSON.stringify(archive(f)), /NODE_TWO_(?!B)/);
  assert.deepEqual(plain(f.store.worldEvents.find(e => e.id === 'base-event-A').trail), [{ round: 1, stage: '酝酿' }, { round: 8, stage: '蔓延' }, { round: 9, stage: '消退' }]);
});

test('refresh and clearing only the current plan preserve the entering baseline and same-node isolation', async () => {
  const first = fixture({ responses: [JSON.stringify(plan('BEFORE_REFRESH'))] });
  await first.c.generateDirectorPlan(); const saved = plain(first.store);
  const f = fixture({ persisted: saved, chat: plain(first.context.chat), responses: [JSON.stringify(plan('AFTER_CLEAR'))] });
  const checkpoint = plain(f.store.geoNodeCheckpoint), world = archive(f);
  assert.equal(f.saves, 0); assert.deepEqual(archive(f), world);
  await f.click('.sd-clear-plan');
  assert.equal(f.store.plan, null); assert.deepEqual(plain(f.store.geoNodeCheckpoint), checkpoint); assert.deepEqual(archive(f), world);
  await f.c.generateDirectorPlan();
  assert.equal(f.stages[0].world.mode, 'reroll'); assert.doesNotMatch(sent(f, 0), /BEFORE_REFRESH/);
  assert.doesNotMatch(JSON.stringify(archive(f)), /BEFORE_REFRESH/); assert.equal(f.store.geoSeq, world.geoSeq);
});

test('a last-floor edit or swipe and injected checkbox metadata reroll from the same entering world without treating injection as a new node', async () => {
  const f = fixture({ responses: [JSON.stringify(plan('ORIGINAL')), JSON.stringify(plan('EDITED')), JSON.stringify(plan('SYNTHETIC'))] });
  await f.c.generateDirectorPlan(); const base = plain(f.store.geoNodeCheckpoint.base), oldHash = f.store.geoNodeCheckpoint.node.hash;
  f.context.chat[1].mes = 'SWIPED_PROSE：改问另一件事。';
  await f.c.generateDirectorPlan(); assert.equal(f.stages[1].world.mode, 'reroll'); assert.notEqual(f.store.geoNodeCheckpoint.node.hash, oldHash);
  assert.deepEqual(plain(f.store.geoNodeCheckpoint.base), base); assert.equal(f.store.geoSeq, 8);
  f.context.chat[1].extra = { checked: true }; f.context.chat.push({ name: 'System', is_system: true, mes: 'SYNTHETIC_INJECTION_ONLY', extra: { qianmu_injected: true } });
  await f.c.generateDirectorPlan();
  assert.equal(f.stages[2].world.mode, 'reroll'); assert.equal(f.store.geoNodeCheckpoint.node.length, 2);
  assert.doesNotMatch(sent(f, 2), /SYNTHETIC_INJECTION_ONLY|EDITED_/); assert.deepEqual(plain(f.store.geoNodeCheckpoint.base), base);
});

test('network failure, incomplete output, truncation, cancellation and source edits never commit a replacement or checkpoint', async () => {
  const seed = fixture({ responses: [JSON.stringify(plan('SAVED'))] }); await seed.c.generateDirectorPlan();
  for (const mode of ['network', 'incomplete', 'truncated', 'cancelled', 'source-changed']) {
    const response = ({ request, c, context }) => {
      if (mode === 'network') throw new Error('OFFLINE_NETWORK_FAILURE');
      if (mode === 'incomplete') { const partial = plan('PARTIAL'); partial.world_events.pop(); return JSON.stringify(partial); }
      if (mode === 'truncated') {
        const raw = '{"factions":[{"id":"partial","name":"PARTIAL_WORLD","standing":"PARTIAL_CHANGE"}],"world_events":[';
        request.onDelta(raw); throw Object.assign(new Error('OFFLINE_TRUNCATED'), { modelResponse: { text: raw, complete: false, interrupted: true, finishReason: 'length' } });
      }
      if (mode === 'cancelled') { c.cancelRequested = true; request.controller.abort(); }
      if (mode === 'source-changed') context.chat[1].mes = 'USER_CHANGED_SOURCE_DURING_REQUEST';
      return JSON.stringify(plan('UNADOPTED'));
    };
    const f = fixture({ persisted: plain(seed.store), responses: [response] }), before = plain(f.store);
    await f.c.generateDirectorPlan();
    assert.equal(f.requests.length, 1, mode); assert.equal(f.saves, 0, mode); assert.equal(f.injects, 0, mode);
    assert.deepEqual(plain(f.store), before, mode); assert.equal(f.c.injectSelection.size, 1, mode); assert.equal(f.resets, 0, mode);
    assert.equal(lastLog(f).status, mode === 'cancelled' ? 'cancelled' : 'error', mode);
  }
});

test('legacy worlds are preserved as first bases, never written on read, and hidden from same-floor candidate input', async () => {
  for (const sameFloor of [false, true]) {
    const persisted = { ...baseWorld(), blueprint: 'SELECTED_BLUEPRINT', plan: plan('LEGACY_CANDIDATE', { world: false }), planAtLen: sameFloor ? 2 : 1, lastPlanIdx: sameFloor ? 1 : 0, history: [] };
    const f = fixture({ persisted, responses: [JSON.stringify(plan('FRESH')), JSON.stringify(plan('FRESH_REROLL'))] });
    const before = archive(f); assert.equal(f.saves, 0); assert.ok(!Object.hasOwn(f.store, 'geoNodeCheckpoint'));
    const run = {}; await f.c.buildPrompt(run);
    assert.equal(run.world.mode, 'initial'); assert.equal(run.world.referenceAllowed, !sameFloor);
    assert.equal(f.saves, 0); assert.ok(!Object.hasOwn(f.store, 'geoNodeCheckpoint')); assert.deepEqual(archive(f), before);
    await f.c.generateDirectorPlan(); await f.c.generateDirectorPlan();
    assert.deepEqual(plain(f.store.geoNodeCheckpoint.base), before); assert.equal(f.store.geoSeq, 8);
    assert.ok(archive(f).factions.some(x => x.name === 'BASE_FACTION_A'));
    if (sameFloor) for (const n of [0, 1]) assert.doesNotMatch(sent(f, n), /BASE_STANDING|BASE_ESSENCE|LEGACY_CANDIDATE/);
    else for (const n of [0, 1]) assert.match(sent(f, n), /BASE_STANDING_A/);
    assert.doesNotMatch(sent(f, 1), /FRESH_|LEGACY_CANDIDATE/);
  }
});

test('rewinds, changed earlier prefixes, unsupported checkpoints and externally edited archives block before any model call', async () => {
  const seed = fixture({ responses: [JSON.stringify(plan('SAVED'))] }); await seed.c.generateDirectorPlan();
  for (const mode of ['rewind', 'prefix-edit', 'prefix-edit-and-grow', 'bad-checkpoint', 'external-world']) {
    const f = fixture({ persisted: plain(seed.store) });
    if (mode === 'rewind') f.context.chat.pop();
    if (mode.startsWith('prefix-edit')) f.context.chat[0].mes = 'CHANGED_EARLIER_PROSE';
    if (mode === 'prefix-edit-and-grow') f.context.chat.push({ name: '阿岚', mes: 'NEW_BRANCH' });
    if (mode === 'bad-checkpoint') f.store.geoNodeCheckpoint.version = 99;
    if (mode === 'external-world') f.store.factions[0].standing = 'USER_MANUAL_WORLD_EDIT';
    const before = plain(f.store); await f.c.generateDirectorPlan();
    assert.equal(f.requests.length, 0, mode); assert.equal(f.saves, 0, mode); assert.equal(f.injects, 0, mode);
    assert.deepEqual(plain(f.store), before, mode); assert.equal(lastLog(f).errorCode, 'WORLD_NODE_MISMATCH', mode);
  }
  const legacy = fixture(); legacy.store.planAtLen = 3; const before = plain(legacy.store);
  await legacy.c.generateDirectorPlan(); assert.equal(legacy.requests.length, 0); assert.deepEqual(plain(legacy.store), before);
});

test('world disabled runs neither reference nor mutate world; re-enabling follows the real world checkpoint or blocks a changed branch', async () => {
  const f = fixture({ responses: [JSON.stringify(plan('WORLD_ONE')), JSON.stringify(plan('WORLD_OFF', { world: false })), JSON.stringify(plan('WORLD_TWO'))] });
  await f.c.generateDirectorPlan(); const world = archive(f), checkpoint = plain(f.store.geoNodeCheckpoint);
  f.settings.geopoliticsEnabled = false; f.context.chat.push({ name: '阿岚', mes: 'NEXT_PROSE' });
  await f.c.generateDirectorPlan(); assert.equal(lastLog(f).status, 'success'); assert.deepEqual(archive(f), world); assert.deepEqual(plain(f.store.geoNodeCheckpoint), checkpoint);
  assert.doesNotMatch(sent(f, 1), /WORLD_ONE_STANDING|BASE_STANDING|世界格局延续参考/);
  f.settings.geopoliticsEnabled = true; await f.c.generateDirectorPlan();
  assert.equal(f.stages[2].world.mode, 'advance'); assert.equal(f.store.geoSeq, 9); assert.match(sent(f, 2), /WORLD_ONE_STANDING/);
  f.context.chat[0].mes = 'EARLIER_BRANCH_CHANGED'; f.settings.geopoliticsEnabled = false;
  const g = fixture({ persisted: plain(f.store), chat: plain(f.context.chat), responses: [JSON.stringify(plan('OFF_ON_CHANGED_BRANCH', { world: false }))] });
  g.settings.geopoliticsEnabled = false; const prior = archive(g); await g.c.generateDirectorPlan();
  assert.equal(lastLog(g).status, 'success'); assert.deepEqual(archive(g), prior);
  g.settings.geopoliticsEnabled = true; await g.c.generateDirectorPlan(); assert.equal(g.requests.length, 1); assert.equal(lastLog(g).errorCode, 'WORLD_NODE_MISMATCH');
});

test('a rejected invoked save retains its candidate and prior history without treating an unknown disk result as a rollback', async () => {
  const seed = fixture({ responses: [JSON.stringify(plan('SAVED'))] }); await seed.c.generateDirectorPlan();
  const f = fixture({ persisted: plain(seed.store), responses: [JSON.stringify(plan('SAVE_FAILED'))], saveHook: () => { throw new Error('OFFLINE_SAVE_REJECTED'); } });
  const before = plain(f.store); await f.c.generateDirectorPlan();
  assert.match(JSON.stringify(f.store.plan), /SAVE_FAILED/);
  assert.match(JSON.stringify(archive(f)), /SAVE_FAILED/);
  assert.deepEqual(plain(f.store.history.slice(1)), before.history);
  assert.deepEqual(plain(f.c.directorInputStore(f.store)), before);
  assert.equal(f.c.currentDirectorInjectionText(), ''); assert.equal(f.c.buildGeopoliticsDigest(), '');
  assert.equal(f.saves, 1); assert.equal(f.injects, 0);
  assert.equal(f.c.injectSelection.size, 1); assert.equal(f.resets, 0);
  assert.equal(lastLog(f).errorCode, 'DIRECTOR_SAVE_UNCONFIRMED'); assert.equal(lastLog(f).errorCause, 'OFFLINE_SAVE_REJECTED');
  assert.equal(lastLog(f).saveState, 'unconfirmed'); assert.notEqual(lastLog(f).resultSaved, true);
  assert.match(lastLog(f).response, /SAVE_FAILED/);
});

test('snapshot preflight failure restores only owned staging before the host is invoked', async () => {
  const seed = fixture({ responses: [JSON.stringify(plan('SAVED'))] }); await seed.c.generateDirectorPlan();
  const f = fixture({ persisted: plain(seed.store), responses: [JSON.stringify(plan('NOT_SUBMITTED'))] });
  const before = plain(f.store);
  f.c.captureDirectorSaveSnapshot = () => { throw new Error('OFFLINE_CAPTURE_REJECTED'); };
  await f.c.generateDirectorPlan();
  assert.deepEqual(plain(f.store), before); assert.equal(f.saves, 0); assert.equal(f.injects, 0);
  assert.equal(f.c.directorPendingSave(f.store), null); assert.equal(lastLog(f).saveState, 'not_submitted');
  assert.equal(lastLog(f).errorCause, 'OFFLINE_CAPTURE_REJECTED'); assert.match(lastLog(f).response, /NOT_SUBMITTED/);
});

for (const hadUnknown of [false, true]) test(`staged metadata is quarantined before an awaiting pre-save guard and restores ${hadUnknown ? 'the prior unknown quarantine' : 'the prior verified input'} on pre-submit failure`, async () => {
  const responses = [...(hadUnknown ? [JSON.stringify(plan('EARLIER_UNKNOWN'))] : []), JSON.stringify(plan('STAGING_WINDOW'))];
  const f = fixture({ responses, saveHook: () => { throw new Error('EARLIER_UNKNOWN_SAVE'); } });
  if (hadUnknown) await f.c.generateDirectorPlan();
  const before = plain(f.store), previousPending = f.c.directorPendingSave(f.store), savesBefore = f.saves;
  const gate = deferred(), reached = deferred(), setterCalls = [];
  f.c.resolveImageAccountNamespace = () => {
    if (f.store.plan?.story_status?.title === 'STAGING_WINDOW_TITLE') { reached.resolve(); return gate.promise; }
    return 'account-one';
  };
  vm.runInContext([source('getInjectApi'), source('applyDirectorInjection').replace('async function applyDirectorInjection(', 'async function applyActualDirectorInjection(')].join('\n'), f.c);
  f.settings.injectEnabled = true; f.context.setExtensionPrompt = (...args) => setterCalls.push(args);
  const run = f.c.generateDirectorPlan(); await reached.promise;
  assert.equal(f.saves, savesBefore); assert.ok(f.c.directorPendingSave(f.store));
  assert.equal(f.c.currentDirectorInjectionText(), ''); assert.equal(f.c.buildGeopoliticsDigest(), '');
  await f.c.applyActualDirectorInjection({ strict: true });
  assert.equal(setterCalls.at(-1)[1], '', 'the real setter path must not publish staged candidate text');
  assert.doesNotMatch(JSON.stringify(f.c.directorInputStore(f.store)), /STAGING_WINDOW/);
  gate.reject(new Error('POST_STAGING_GUARD_FAILED')); await run;
  assert.deepEqual(plain(f.store), before); assert.equal(f.saves, savesBefore); assert.equal(f.injects, 0);
  assert.equal(f.c.directorPendingSave(f.store), previousPending); assert.equal(lastLog(f).saveState, 'not_submitted');
});

test('successive unknown saves never advance the world from an unconfirmed candidate, including world off and on', async () => {
  for (const startsWithWorld of [false, true]) {
    const tags = startsWithWorld ? ['UNKNOWN_WORLD_A', 'UNKNOWN_OFF', 'UNKNOWN_WORLD_B', 'CONFIRMED_FINAL'] : ['UNKNOWN_OFF', 'UNKNOWN_WORLD_A', 'UNKNOWN_WORLD_B', 'CONFIRMED_FINAL'];
    const f = fixture({ responses: tags.map(tag => JSON.stringify(plan(tag, { world: tag !== 'UNKNOWN_OFF' }))),
      saveHook: ({ saves }) => { if (saves < 4) throw new Error('OFFLINE_UNKNOWN'); } });
    const baseline = archive(f);
    for (let i = 0; i < tags.length; i++) {
      f.settings.geopoliticsEnabled = tags[i] !== 'UNKNOWN_OFF';
      if (i) f.context.chat.push({ name: '阿岚', mes: `FORWARD_PROSE_${i}` });
      await f.c.generateDirectorPlan();
      assert.doesNotMatch(sent(f, i), /UNKNOWN_(?:WORLD_A|WORLD_B|OFF)/, `unconfirmed input at ${i}`);
      if (f.settings.geopoliticsEnabled) assert.deepEqual(f.stages[i].world.base, baseline);
      if (i < 3) {
        assert.equal(lastLog(f).saveState, 'unconfirmed');
        assert.equal(f.c.currentDirectorInjectionText(), ''); assert.equal(f.c.buildGeopoliticsDigest(), '');
      }
    }
    assert.equal(f.saves, 4); assert.equal(f.injects, 1); assert.equal(lastLog(f).saveState, 'confirmed');
    assert.equal(f.c.directorPendingSave(f.store), null);
    assert.match(f.c.buildGeopoliticsDigest(), /CONFIRMED_FINAL/);
    assert.doesNotMatch(JSON.stringify(archive(f)), /UNKNOWN_/);
  }
});

test('loading a history revision after an unknown save cannot release the world injection gate', async () => {
  const f = fixture({ responses: [JSON.stringify(plan('UNKNOWN_WORLD')), JSON.stringify(plan('AFTER_HISTORY'))],
    saveHook: ({ saves }) => { if (saves === 1) throw new Error('OFFLINE_UNKNOWN'); } });
  const baseline = archive(f); await f.c.generateDirectorPlan();
  const pending = f.c.directorPendingSave(f.store), priorRevision = f.store.directorPlanRevisionId;
  await f.click('.sd-load-history', 'old-history');
  assert.notEqual(f.store.directorPlanRevisionId, priorRevision);
  assert.equal(f.c.directorPendingSave(f.store), pending);
  assert.equal(f.c.currentDirectorInjectionText(), ''); assert.equal(f.c.buildGeopoliticsDigest(), '');
  assert.match(JSON.stringify(archive(f)), /UNKNOWN_WORLD/, 'the retained archive itself is not silently rolled back');
  assert.deepEqual(plain(f.c.captureGeopoliticsArchive(f.c.directorInputStore(f.store))), baseline);
  await f.c.generateDirectorPlan();
  assert.doesNotMatch(sent(f, 1), /UNKNOWN_WORLD/); assert.deepEqual(f.stages[1].world.base, baseline);
  assert.equal(f.c.directorPendingSave(f.store), null); assert.equal(lastLog(f).saveState, 'confirmed');
});

test('explicit world clearing after an unknown result remains empty in the next request rather than reviving the saved baseline', async () => {
  const f = fixture({ responses: [JSON.stringify(plan('UNKNOWN_BEFORE_CLEAR')), JSON.stringify(plan('AFTER_CLEAR'))],
    saveHook: ({ saves }) => { if (saves === 1) throw new Error('OFFLINE_UNKNOWN'); } });
  await f.c.generateDirectorPlan();
  f.c.directorLiveLog = null; // Dismiss the failed-response read-only preview before using the live archive controls.
  await f.click('.sd-geo-clear');
  assert.deepEqual(archive(f), { factions: [], factionRelations: [], worldEvents: [], geoSeq: 0 });
  assert.deepEqual(plain(f.c.captureGeopoliticsArchive(f.c.directorInputStore(f.store))), archive(f));
  await f.c.generateDirectorPlan();
  assert.equal(f.stages[1].world.mode, 'initial');
  assert.doesNotMatch(sent(f, 1), /UNKNOWN_BEFORE_CLEAR|BASE_FACTION|BASE_EVENT/);
  assert.doesNotMatch(JSON.stringify(archive(f)), /UNKNOWN_BEFORE_CLEAR|BASE_FACTION|BASE_EVENT/);
  assert.equal(f.store.geoSeq, 1); assert.equal(lastLog(f).saveState, 'confirmed');
});

test('save failure does not restore a world or plan that the user cleared while persistence was pending', async () => {
  const seed = fixture({ responses: [JSON.stringify(plan('SAVED'))] }); await seed.c.generateDirectorPlan();
  const f = fixture({ persisted: plain(seed.store), responses: [JSON.stringify(plan('PENDING_SAVE'))], saveHook: ({ store }) => {
    store.factions = []; store.factionRelations = []; store.worldEvents = []; store.geoSeq = 0; delete store.geoNodeCheckpoint; store.plan = null;
    throw new Error('OFFLINE_SAVE_REJECTED_AFTER_USER_CLEAR');
  } });
  const history = plain(f.store.history); await f.c.generateDirectorPlan();
  assert.deepEqual(archive(f), { factions: [], factionRelations: [], worldEvents: [], geoSeq: 0 }); assert.ok(!Object.hasOwn(f.store, 'geoNodeCheckpoint'));
  assert.equal(f.store.plan, null); assert.deepEqual(plain(f.store.history.slice(1)), history); assert.equal(f.injects, 0);
  const input = f.c.directorInputStore(f.store);
  assert.equal(input.plan, null); assert.deepEqual(plain(f.c.captureGeopoliticsArchive(input)), archive(f));
  assert.ok(!Object.hasOwn(input, 'geoNodeCheckpoint'));
});

test('saved world survives a later injection failure and the log honestly separates saved result from incomplete synchronization', async () => {
  const f = fixture({ responses: [JSON.stringify(plan('SAVED_BEFORE_INJECT_FAILURE'))], injectHook: () => { throw new Error('OFFLINE_INJECTION_REJECTED'); } });
  await f.c.generateDirectorPlan();
  assert.match(JSON.stringify(archive(f)), /SAVED_BEFORE_INJECT_FAILURE/); assert.equal(f.store.geoSeq, 8); assert.ok(f.store.geoNodeCheckpoint);
  assert.equal(f.saves, 1); assert.equal(f.injects, 1); assert.equal(lastLog(f).resultSaved, true);
  assert.match(lastLog(f).error, /已保存.*同步未完成/);
  assert.equal(f.c.directorLiveLog, null);
  assert.equal(f.c.directorDisplayPlan(), f.store.plan, 'a saved result is not presented as an unadopted partial preview');
  assert.equal(f.c.directorGeopoliticsState().readOnly, false);
  assert.equal(f.c.directorGeopoliticsState().store, f.store);
  const warning = f.toasts.at(-1); assert.equal(warning.type, 'warning'); assert.match(warning.message, /已保存/); assert.doesNotMatch(warning.message, /未采用|原档案未改动|保留原内容/);
});

test('post-save guards clear obsolete selections only while this run still owns the chat and saved plan', async () => {
  for (const change of ['settings', 'chat', 'plan']) {
    // This boundary explicitly returns confirmed, then exposes a competing change
    // to the caller's post-confirmation guard; it is not the native save promise.
    const f = fixture({ responses: [JSON.stringify(plan('SAVED_BEFORE_GUARD'))], saveConfirmationHook: ({ c, context, settings, store }) => {
      if (change === 'settings') settings.temperature = 1.1;
      else {
        c.injectSelection.clear(); c.injectSelection.set('new-user-selection', true);
        if (change === 'chat') context.chat = [...context.chat];
        else store.plan = plan('USER_SELECTED_DIFFERENT_PLAN', { world: false });
      }
    } });
    await f.c.generateDirectorPlan();
    assert.equal(f.saves, 1, change); assert.equal(f.injects, 0, change); assert.equal(lastLog(f).resultSaved, true, change);
    assert.match(JSON.stringify(archive(f)), /SAVED_BEFORE_GUARD/, change); assert.equal(f.c.directorLiveLog, null, change);
    if (change === 'settings') {
      assert.equal(f.c.injectSelection.size, 0); assert.equal(f.resets, 1);
      assert.equal(f.c.directorDisplayPlan(), f.store.plan); assert.match(JSON.stringify(f.store.plan), /SAVED_BEFORE_GUARD/);
      assert.match(f.toasts.at(-1).message, /已保存.*同步未完成/);
    } else {
      assert.deepEqual([...f.c.injectSelection.keys()], ['new-user-selection'], change); assert.equal(f.resets, 0, change);
      if (change === 'plan') assert.match(JSON.stringify(f.c.directorDisplayPlan()), /USER_SELECTED_DIFFERENT_PLAN/);
    }
  }
});

test('world injection digest suppresses legacy rewinds, checkpoint rewinds and edited last floors until a matching world is saved', async () => {
  const legacy = fixture(); legacy.store.planAtLen = 2; legacy.store.lastPlanIdx = 1;
  assert.ok(!Object.hasOwn(legacy.store, 'directorPlanRevisionId'));
  assert.equal(legacy.c.directorPendingSave(legacy.store), null);
  assert.equal(legacy.c.currentDirectorInjectionText(), 'OLD_OVERRIDE', 'a legacy store without a revision is not mistaken for an unknown save');
  assert.match(legacy.c.buildGeopoliticsDigest(), /BASE_EVENT_A/);
  legacy.context.chat.pop(); assert.equal(legacy.c.buildGeopoliticsDigest(), '', 'a legacy world cannot be injected after rewinding before its saved floor');
  const seed = fixture({ responses: [JSON.stringify(plan('SAVED_FOR_DIGEST'))] }); await seed.c.generateDirectorPlan();
  assert.match(seed.c.buildGeopoliticsDigest(), /SAVED_FOR_DIGEST/);
  for (const change of ['rewind', 'last-edit', 'prefix-edit']) {
    const f = fixture({ persisted: plain(seed.store) });
    if (change === 'rewind') f.context.chat.pop();
    else f.context.chat[change === 'last-edit' ? 1 : 0].mes = 'EDITED_PROSE';
    const before = plain(f.store); assert.equal(f.c.buildGeopoliticsDigest(), '', change);
    assert.deepEqual(plain(f.store), before, change); assert.equal(f.saves, 0, change);
  }
  const edited = fixture({ persisted: plain(seed.store), responses: [JSON.stringify(plan('ADOPTED_AFTER_EDIT'))] });
  edited.context.chat[1].mes = 'EDITED_PROSE'; assert.equal(edited.c.buildGeopoliticsDigest(), '');
  await edited.c.generateDirectorPlan(); assert.match(edited.c.buildGeopoliticsDigest(), /ADOPTED_AFTER_EDIT/);
  edited.context.chat.push({ name: '阿岚', mes: 'FOLLOWING_PROSE' });
  assert.match(edited.c.buildGeopoliticsDigest(), /ADOPTED_AFTER_EDIT/, 'forward prose may still consume the last saved world');
});

test('the real history-load handler restores only narrative cards and does not replace world data or its entering checkpoint', async () => {
  const f = fixture({ responses: [JSON.stringify(plan('CURRENT_WORLD')), JSON.stringify(plan('AFTER_HISTORY_LOAD'))] });
  await f.c.generateDirectorPlan();
  const archived = plan('HISTORICAL_WITH_WORLD', { reviseBase: true });
  f.store.history.push({ id: 'historical-with-world', createdAt: '2026-10-15T01:00:00Z', plan: archived });
  const world = archive(f), checkpoint = plain(f.store.geoNodeCheckpoint), planAtLen = f.store.planAtLen;
  await f.click('.sd-load-history', 'historical-with-world');
  assert.match(JSON.stringify(f.store.plan), /HISTORICAL_WITH_WORLD/);
  for (const field of ['factions', 'faction_relations', 'world_events']) assert.ok(!Object.hasOwn(f.store.plan, field));
  assert.deepEqual(archive(f), world); assert.deepEqual(plain(f.store.geoNodeCheckpoint), checkpoint); assert.equal(f.store.planAtLen, planAtLen);
  assert.equal(f.c.directorLiveLog, null);
  await f.c.generateDirectorPlan();
  assert.equal(f.stages[1].world.mode, 'reroll'); assert.doesNotMatch(sent(f, 1), /HISTORICAL_WITH_WORLD|CURRENT_WORLD/);
  assert.equal(f.store.geoSeq, world.geoSeq); assert.deepEqual(plain(f.store.geoNodeCheckpoint.base), checkpoint.base);
});

test('the real world-clear handler removes its checkpoint, permits a fresh baseline, and does not clear after chat ownership changes', async () => {
  const f = fixture({ responses: [JSON.stringify(plan('BEFORE_WORLD_CLEAR')), JSON.stringify(plan('AFTER_WORLD_CLEAR'))] });
  await f.c.generateDirectorPlan(); await f.click('.sd-geo-clear');
  assert.deepEqual(archive(f), { factions: [], factionRelations: [], worldEvents: [], geoSeq: 0 }); assert.ok(!Object.hasOwn(f.store, 'geoNodeCheckpoint'));
  await f.c.generateDirectorPlan(); assert.equal(f.stages[1].world.mode, 'initial'); assert.equal(f.store.geoSeq, 1);
  assert.doesNotMatch(sent(f, 1), /BEFORE_WORLD_CLEAR/);
  const g = fixture({ persisted: plain(f.store), confirmHook: ({ changeChat }) => { changeChat(); return true; } }), before = plain(g.store);
  await g.click('.sd-geo-clear'); assert.deepEqual(plain(g.store), before); assert.equal(g.saves, 0); assert.equal(g.injects, 0);
});
