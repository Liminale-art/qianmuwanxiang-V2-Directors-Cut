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

// Exercise the actual composition and generation functions up to the transport
// boundary. Synthetic sentinels identify sources; no real model/network is used.
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
  between('const FACTION_TRENDS =', '\nfunction buildPlanDigest('),
  between('function makeStreamLogUpdater(', '// MIGRATED to qianmu-storyboard-utils.js (commit 19)'),
  source('getChatStore'), source('currentPlan'), source('directorDisplayPlan'),
];
const plain = value => JSON.parse(JSON.stringify(value));
const markers = ['CANDIDATE_OLD', 'ARCHIVE_OLD', 'HISTORY_ONLY_', 'FAILED_LOG_ONLY', 'INJECTION_ONLY', 'PARTIAL_ONLY'];
function plan(tag) {
  return {
    story_status: { title: `${tag}_TITLE`, directions: [
      { horizon: 'near', title: `${tag}_NEAR`, content: `${tag}：伙计把退货移到另一个柜台。` },
      { horizon: 'far', title: `${tag}_FAR`, content: `${tag}：到下一个集市日，商户商量新的交接办法。` },
    ] },
    quests: Array.from({ length: 5 }, (_, i) => ({ subject: '伙计', title: `${tag}来信${i}`, description: `${tag}第${i}份信到达街口，等待收信者。` })),
    character_dynamics: Array.from({ length: 2 }, (_, i) => ({ name: '阿岚', title: `${tag}事务${i}`, content: `阿岚核对${tag}第${i}份账目。` })),
    npc_updates: Array.from({ length: 3 }, (_, i) => ({ name: `${tag}_NPC_${i}`, next_action: `正在为第${i}家店铺检查送货路线。` })),
    chain_reactions: Array.from({ length: 3 }, (_, i) => ({ spark: `${tag}第${i}条路改道。`, chain: `第${i}车货转入后巷 → 掌柜通知收货人 → 邻街工坊调整排班` })),
    relation_undercurrents: Array.from({ length: 3 }, (_, i) => ({ parties: i === 2 ? ['邻居二', '铺主二', '伙计二'] : [`邻居${i}`, `铺主${i}`], tension: `${tag}第${i}张欠条还没有交还。` })),
    interlude: { type: 'phone', owner: '阿岚', title: `${tag}_PHONE`, conversation_kind: 'group', messages: Array.from({ length: 12 }, (_, i) => ({ sender: i % 2 ? '阿岚' : '老周', content: `${tag}_PHONE_MSG_${i}`, time: `08:${String(i).padStart(2, '0')}` })) },
    factions: Array.from({ length: 3 }, (_, i) => ({ id: `${tag}-f${i}`, name: `${tag}_FACTION_${i}`, standing: `第${i}处街坊仍在协调收货。` })),
    world_events: Array.from({ length: 2 }, (_, i) => ({ id: `${tag}-e${i}`, title: `${tag}_EVENT_${i}`, essence: `第${i}片街区开始整理货运入口。`, stage: '酝酿' })),
    limitations: [],
  };
}

function fixture({ responses = [], providerMode = 'external', persisted } = {}) {
  let id = 0, saves = 0, injects = 0;
  const requests = [], stages = [];
  const old = plan('CANDIDATE_OLD');
  const initial = persisted || {
    blueprint: 'SELECTED_BLUEPRINT', plan: old, planAtLen: 2, lastPlanIdx: 1, updatedAt: '2026-10-15T10:00:00Z',
    history: Array.from({ length: 4 }, (_, i) => ({ id: `h${i}`, plan: plan(`HISTORY_ONLY_${i}`) })),
    factions: [{ id: 'old-f', name: 'ARCHIVE_OLD_FACTION', standing: 'ARCHIVE_OLD_ROLE', clues: ['ARCHIVE_OLD_CLUE'] }],
    factionRelations: [{ a: 'old-f', b: 'other', note: 'ARCHIVE_OLD_LINK' }],
    worldEvents: [{ id: 'old-e', title: 'ARCHIVE_OLD_EVENT', essence: 'ARCHIVE_OLD_CAUSE', stage: '蔓延' }],
    injectOverride: 'INJECTION_ONLY_OVERRIDE',
  };
  const context = { name1: '访客', chatId: 'chat-one', characterId: 0, characters: [{ chat: 'chat-one', avatar: 'fixture.png' }],
    getRequestHeaders: () => ({}), saveMetadata: async () => {}, extensionSettings: { gagaDogSummary: {} }, chatMetadata: { fixture: initial }, chat: [
    { name: '阿岚', is_user: false, mes: 'PROSE_SOURCE：阿岚拿起手机，看见老周的消息。' },
    { name: '访客', is_user: true, mes: 'USER_SOURCE：我问起尚未交还的信。' },
  ] };
  const settings = { enabled: true, providerMode, streamEnabled: true, parallelSceneEnabled: false, interludeEnabled: true,
    geopoliticsEnabled: true, systemPrompt: creative.CREATIVE_SYSTEM_PROMPT, outputSchemaText: contract.createCreativeSchema(),
    contextOptions: { contextDepth: 5, includeChatHistory: true }, contextBudget: 100000,
    logHistory: [{ status: 'error', response: 'FAILED_LOG_ONLY', request: 'FAILED_LOG_ONLY_REQUEST' }] };
  const c = vm.createContext({
    ...utils, ...contract, ...creative, ...runtime, ...live,
    settings, MODULE_NAME: 'fixture', BLUEPRINT_REVISION: 453, DEFAULT_BLUEPRINT: creative.CREATIVE_BLUEPRINT,
    DEFAULT_SYSTEM_PROMPT: creative.CREATIVE_SYSTEM_PROMPT, JSON_SCHEMA_TEXT: contract.createCreativeSchema(),
    ctx: () => context, getChatKey: () => 'chat-one', migrateQianmuChatStoreV2, acceptMigrationResult: (_scope, result) => result.value,
    contextScanCache: { presetScannedAt: 1, worldScannedAt: 1 },
    getCharacterName: () => '阿岚', getPersonaName: () => '访客', getCharacterDescription: () => 'CHAR_SOURCE', getPersonaDescription: () => 'PERSONA_SOURCE',
    getSelectedWorldBookNames: () => [], getSelectedPresetNames: () => [], cleanContextText: String, resolveMacro: async value => value,
    buildWorldContextText: async () => 'WORLD_SOURCE CHAR_SOURCE PERSONA_SOURCE 手机', buildPresetContextText: async () => 'PRESET_SOURCE',
    memoryHostFixture: { findExtension: () => ({ enabled: true }) },
    readGagaMemoryContext: () => ({ text: 'MEMORY_SOURCE', status: 'ready', diagnostics: [], snapshot: { fingerprint: 'memory-one' } }),
    selectCreativeOptions: (s, options) => runtime.selectCreativeOptions(s, { ...options, random: () => 2.5 / 7 }),
    estimateTokens: text => Math.ceil(text.length / 4), uid: prefix => `${prefix}-${++id}`,
    busy: false, cancelRequested: false, abortController: null, directorRun: null, directorLiveLog: null,
    directorLeaveGuard: null, directorHostState: directorHostFixture().state, directorAutoRefresh: null, directorNavigation: null, createDirectorNavigation,
    directorUnconfirmedSaves: new WeakMap(), captureCurrentChatSource, createDirectorLeaveGuard, captureDirectorSaveSnapshot,
    confirmDirectorSave: async (_snapshot, { guard }) => { await guard(); return { status: 'confirmed' }; },
    activeTab: 'dashboard', MODAL_ID: 'fixture-panel', document: { getElementById: () => null, addEventListener() {}, removeEventListener() {} },
    AbortController, Date, console, structuredClone, clone: structuredClone,
    validateApiSettings: () => true, resolveImageAccountNamespace: async () => 'account-one',
    renderBusyState: () => {}, renderModal: () => {}, renderFloatButton: () => {}, rerenderIfOpen: () => {}, toast: () => {}, apiToast: () => {},
    pushLog: log => { settings.logHistory.push(log); return log; }, saveSettings: () => {},
    saveMetadata: async () => { saves++; }, applyDirectorInjection: async () => { injects++; }, injectSelection: new Map(), resetCreativeSocialState: () => {}, clearDirectorInjection: () => {},
    storyboardState: () => ({ enabled: false }), FACTION_RELATION_KINDS: ['冲突', '同盟', '张力', '中立', '依附'],
    callExternalApi: async (messages, onDelta, config, controller) => {
      const request = { messages, onDelta, config, controller };
      requests.push(request);
      stages.push({ visibleBeforeResponse: c.directorDisplayPlan(), savedBeforeResponse: c.currentPlan() });
      const next = responses[requests.length - 1];
      assert.notEqual(next, undefined, 'no extra model request or automatic repair');
      const raw = typeof next === 'function' ? await next({ request, c }) : next;
      config.onResponse({ text: raw, reasoning: '', finishReason: 'stop', complete: true });
      return raw;
    },
  });
  c.callSillyTavernModel = (user, system, onDelta, config) => c.callExternalApi([{ role: 'system', content: system }, { role: 'user', content: user }], onDelta, config, config.controller);
  vm.runInContext(parts.join('\n'), c);
  vm.runInContext('directorMemoryHostModule = memoryHostFixture;', c);
  c.getChatStore(); // Run the actual additive loader before snapshot comparisons.
  return { c, settings, context, requests, stages, get store() { return c.getChatStore(); }, get saves() { return saves; }, get injects() { return injects; } };
}

function assertIsolated(request, extra = []) {
  const sent = JSON.stringify(request.messages);
  for (const marker of [...markers, ...extra]) assert.ok(!sent.includes(marker), `not sent: ${marker}`);
  for (const marker of ['PROSE_SOURCE', 'USER_SOURCE', 'MEMORY_SOURCE', 'WORLD_SOURCE', 'PRESET_SOURCE', 'SELECTED_BLUEPRINT']) assert.ok(sent.includes(marker), `kept source: ${marker}`);
  assert.match(sent, /同楼层独立重推演/);
  assert.doesNotMatch(sent, /candidate_reference|上次推演参考|世界格局延续参考|上轮趣味防重复参照/);
}

test('four retained histories and the current plan never leak into two consecutive same-floor requests', async () => {
  for (const providerMode of ['external', 'sillytavern']) {
    const e = fixture({ providerMode, responses: [JSON.stringify(plan('FRESH_FIRST')), JSON.stringify(plan('FRESH_SECOND'))] });
    await e.c.generateDirectorPlan();
    assert.equal(e.requests.length, 1);
    assertIsolated(e.requests[0]);
    assert.equal(e.store.history.length, 5, 'ordinary bounded history saves the successful replacement');
    assert.ok(JSON.stringify(e.store.history).includes('HISTORY_ONLY_0'));
    e.store.lastPlanIdx = -1; // Switching the automatic counter cannot erase planAtLen.
    await e.c.generateDirectorPlan();
    assert.equal(e.requests.length, 2);
    assertIsolated(e.requests[1], ['FRESH_FIRST']);
    assert.match(JSON.stringify(e.store.plan), /FRESH_SECOND/);
    assert.equal(e.saves, 2); assert.equal(e.injects, 2);
    for (const stage of e.stages) {
      assert.equal(stage.visibleBeforeResponse, null, 'loading temporarily hides saved output');
      assert.ok(stage.savedBeforeResponse, 'loading does not delete the saved plan');
    }
    assert.equal(e.settings.logHistory.filter(log => log.kind === 'director').every(log => log.status === 'success'), true);
  }
});

test('legacy floor anchors, clearing only the current view and rollback all retain source isolation', async () => {
  for (const mode of ['legacy', 'clear', 'rollback', 'counter-reset']) {
    const e = fixture({ responses: [() => { throw new Error('OFFLINE_EXPECTED_STOP'); }] });
    if (mode === 'legacy') e.store.planAtLen = 0;
    if (mode === 'clear') e.store.plan = null;
    if (mode === 'rollback') e.context.chat.pop();
    if (mode === 'counter-reset') e.store.lastPlanIdx = -1;
    const before = plain(e.store);
    await e.c.generateDirectorPlan();
    assert.equal(e.requests.length, mode === 'rollback' ? 0 : 1, mode);
    if (mode === 'rollback') {
      assert.equal(e.settings.logHistory.at(-1).errorCode, 'WORLD_NODE_MISMATCH');
      assert.deepEqual(plain(e.store), before, 'unsafe legacy rewind is stopped before the model or any archive write');
      assert.equal(e.saves, 0); assert.equal(e.injects, 0);
      continue;
    }
    const sent = JSON.stringify(e.requests[0].messages);
    for (const marker of markers) assert.ok(!sent.includes(marker), `${mode}: ${marker}`);
    assert.match(sent, /同楼层独立重推演/);
    assert.deepEqual(plain(e.store), before, 'failed request never clears historical or current data');
    assert.equal(e.saves, 0); assert.equal(e.injects, 0);
  }
});

test('a failed partial remains display-only across retry and refresh, never a request source', async () => {
  const partial = '{"npc_updates":[{"name":"PARTIAL_ONLY_NPC","next_action":"PARTIAL_ONLY_ACTION"}],"quests":[';
  const e = fixture({ responses: [({ request }) => {
    request.onDelta(partial);
    throw Object.assign(new Error('OFFLINE_EXPECTED_PARTIAL'), { modelResponse: { text: partial, complete: false, interrupted: true } });
  }, () => { throw new Error('OFFLINE_EXPECTED_RETRY_STOP'); }] });
  const before = plain(e.store);
  await e.c.generateDirectorPlan();
  assert.equal(e.requests.length, 1);
  assertIsolated(e.requests[0]);
  assert.match(JSON.stringify(e.c.directorDisplayPlan()), /PARTIAL_ONLY_NPC/);
  assert.equal(e.c.directorDisplayPlan()._streamPreview, true);
  assert.deepEqual(plain(e.store), before);
  await e.c.generateDirectorPlan();
  assert.equal(e.requests.length, 2);
  assertIsolated(e.requests[1]);
  assert.deepEqual(plain(e.store), before);
  const reloaded = fixture({ persisted: plain(e.store) });
  assert.deepEqual(plain(reloaded.store.plan), before.plan, 'actual loader keeps the saved plan across refresh');
  assert.deepEqual(plain(reloaded.store.history), before.history, 'all four histories survive refresh');
  assert.deepEqual(plain(reloaded.c.directorDisplayPlan()), before.plan, 'an in-memory failed preview is not restored as the current plan');
});

test('a new prose floor resumes the current candidate and archive, not all history or failed previews', async () => {
  const e = fixture({ responses: [() => { throw new Error('OFFLINE_EXPECTED_STOP'); }] });
  e.context.chat.push({ name: '阿岚', is_user: false, mes: 'NEW_PROSE_SOURCE：阿岚收到回信。' });
  e.store.lastPlanIdx = e.context.chat.length - 1; // Automatic scheduler's pre-request reset.
  await e.c.generateDirectorPlan();
  assert.equal(e.requests.length, 1);
  const sent = JSON.stringify(e.requests[0].messages);
  assert.match(sent, /CANDIDATE_OLD_NPC_0/);
  assert.match(sent, /ARCHIVE_OLD_ROLE/);
  assert.match(sent, /NEW_PROSE_SOURCE/);
  assert.match(sent, /上轮趣味防重复参照/);
  assert.doesNotMatch(sent, /HISTORY_ONLY_|FAILED_LOG_ONLY|INJECTION_ONLY|同楼层独立重推演/);
});

test('an already materialized injected message is excluded when the saved floor includes it', async () => {
  const e = fixture({ responses: [() => { throw new Error('OFFLINE_EXPECTED_STOP'); }] });
  e.context.chat.push({ name: 'System', is_system: true, mes: 'INJECTION_ONLY_SYNTHETIC', extra: { qianmu_injected: true } });
  e.store.planAtLen = e.context.chat.length;
  await e.c.generateDirectorPlan();
  assertIsolated(e.requests[0]);
});

test('additive loading of an older nested store keeps its histories but excludes their contents from a reroll', async () => {
  const old = fixture().store;
  const { blueprint, plan: previous, history, factions, worldEvents, factionRelations } = plain(old);
  const e = fixture({ persisted: { inference: { blueprint, plan: previous, history, factions, worldEvents, lastPlanIdx: 1 }, factionRelations },
    responses: [() => { throw new Error('OFFLINE_EXPECTED_STOP'); }] });
  assert.deepEqual(plain(e.store.plan), previous);
  assert.deepEqual(plain(e.store.history), history);
  assert.equal(e.store.planAtLen, 0, 'legacy records use the valid lastPlanIdx fallback');
  await e.c.generateDirectorPlan();
  assert.equal(e.requests.length, 1);
  assertIsolated(e.requests[0]);
  assert.deepEqual(plain(e.store.history), history);
});

test('repeated returned names are not evidence that a preceding candidate name entered the next request', async () => {
  const first = plan('FRESH_ONE'), second = plan('FRESH_TWO');
  first.npc_updates[0].name = second.npc_updates[0].name = 'RETURNED_SAME_NAME';
  const e = fixture({ responses: [JSON.stringify(first), JSON.stringify(second)] });
  await e.c.generateDirectorPlan();
  await e.c.generateDirectorPlan();
  assert.equal(e.requests.length, 2);
  assertIsolated(e.requests[1], ['FRESH_ONE', 'RETURNED_SAME_NAME']);
  assert.equal(e.store.plan.npc_updates[0].name, 'RETURNED_SAME_NAME');
  // This is only an input/output separation proof, not a model-quality result.
});
