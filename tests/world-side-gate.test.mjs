import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import * as ledgerRuntime from '../qianmu-narrative-ledger.js';
import * as candidateRuntime from '../qianmu-director-candidate.js';
import {
  STORYBOARD_SCHEMA_VERSION,
  createStoryboardDefaults,
  normalizeStoryboardState,
} from '../qianmu-storyboard.js';
import {
  adaptProductionPacketToNarrativeLedgerEntry,
  canExposeNarrativeLedgerEntryToMainline,
} from '../qianmu-narrative-ledger.js';

const source = await readFile(new URL('../index.js', import.meta.url), 'utf8');
const styles = await readFile(new URL('../style.css', import.meta.url), 'utf8');

test('world-side shots are an explicit default-off storyboard setting', () => {
  assert.equal(STORYBOARD_SCHEMA_VERSION, 24);
  assert.deepEqual(createStoryboardDefaults().directorBridge, { worldSideShotsEnabled: false });
  const migrated = normalizeStoryboardState({ schemaVersion: 23, directorBridge: { worldSideShotsEnabled: true } });
  assert.deepEqual(migrated.directorBridge, { worldSideShotsEnabled: false }, 'upgrades require a fresh explicit opt-in');
  const current = normalizeStoryboardState({ schemaVersion: 24, directorBridge: { worldSideShotsEnabled: true } });
  assert.equal(current.directorBridge.worldSideShotsEnabled, true);
});

test('disabled world-side mode returns before loading production or candidate chunks', () => {
  const refresh = source.slice(source.indexOf('async function refreshDirectorProductionPackets'), source.indexOf('const RUNTIME_LOCK_KEY'));
  const gate = refresh.indexOf("if (!storyboard.enabled || !storyboard.directorBridge?.worldSideShotsEnabled)");
  assert.ok(gate >= 0);
  assert.ok(gate < refresh.indexOf("featureRuntime.load('productionPacket')"));
  assert.ok(gate < refresh.indexOf('refreshDirectorCandidatePool(packets, context,'));
  const init = source.slice(source.indexOf('function init()'), source.indexOf('function cleanupRuntime'));
  assert.doesNotMatch(init, /featureRuntime\.load\('(productionPacket|narrativeLedger|directorCandidates)'\)/);
});

test('late async bridge results cannot repopulate state after opt-out or chat change', () => {
  const refresh = source.slice(source.indexOf('async function refreshDirectorCandidatePool'), source.indexOf('const RUNTIME_LOCK_KEY'));
  assert.match(refresh, /const requestEpoch = \+\+directorNarrativeBridgeEpoch/);
  assert.match(refresh, /requestEpoch !== directorNarrativeBridgeEpoch/);
  assert.match(refresh, /!currentStoryboard\.directorBridge\?\.worldSideShotsEnabled/);
  const reset = source.slice(source.indexOf('function resetDirectorNarrativeBridge'), source.indexOf('async function refreshDirectorCandidatePool'));
  assert.match(reset, /directorNarrativeBridgeEpoch\+\+/);
});

test('slow decision confirmation rechecks source epoch, chat and explicit switch', () => {
  const generate = source.slice(source.indexOf('async function storyboardGenerateProductionPacket'), source.indexOf('async function storyboardGenerate(root'));
  assert.match(generate, /const actionEpoch = directorNarrativeBridgeEpoch/);
  const decisionLoad = generate.indexOf("featureRuntime.load('directorDecision')");
  const epochCheck = generate.indexOf('actionEpoch !== directorNarrativeBridgeEpoch');
  assert.ok(decisionLoad >= 0 && epochCheck > decisionLoad);
  assert.match(generate, /currentChatKey !== String\(getChatKey\(\) \|\| ''\)/);
  assert.match(generate, /!currentState\.directorBridge\?\.worldSideShotsEnabled/);
});

test('the workbench exposes one compact switch and hides stale director material while disabled', () => {
  const card = source.slice(source.indexOf('function renderStoryboardAutomationCard'), source.indexOf('function renderStoryboardCompilerContextPanel'));
  assert.match(card, /class="sd-storyboard-world-side"[\s\S]*<span>造物之眼<\/span>/);
  const production = source.slice(source.indexOf('function renderStoryboardProductionSources'), source.indexOf('function renderStoryboardCreate'));
  assert.match(production, /if \(!state\.directorBridge\?\.worldSideShotsEnabled\) return ''/);
  assert.match(styles, /sd-storyboard-automation-options[^\n]*repeat\(2, minmax\(0, 1fr\)\)/);
});

test('production packets become director-only ledger possibilities', () => {
  const entry = adaptProductionPacketToNarrativeLedgerEntry({
    packetId: 'packet-a', eventId: 'event-a',
    timelineAnchor: { chatKey: 'chat-a', floor: 8, revisionId: 'swipe-2', time: '稍后' },
    sourceRef: { field: 'npc_updates', itemId: 'alice-update' },
    characterState: [{ id: 'alice', name: 'Alice' }],
    visualIntent: { duty: 'reaction', subject: '烧焦的信', description: 'Alice 在空厨房烧掉来信。', evidenceRefs: ['plan-8'] },
  });
  assert.equal(entry.source.kind, 'simulation');
  assert.equal(entry.source.authority, 'possibility');
  assert.equal(entry.source.recordId, 'packet-a');
  assert.equal(entry.temporalState, 'future');
  assert.equal(entry.readerVisibility.scope, 'director_only');
  assert.equal(canExposeNarrativeLedgerEntryToMainline(entry, 'user'), false);
});

test('the actual bridge preserves unknown current-floor context before candidate scoring', async () => {
  const refresh = source.slice(source.indexOf('async function refreshDirectorCandidatePool('), source.indexOf('async function refreshDirectorProductionPackets('));
  const context = vm.createContext({
    featureRuntime: { load: async name => ({ narrativeLedger: ledgerRuntime, directorCandidates: candidateRuntime })[name] },
    directorNarrativeBridgeEpoch: 0, directorCandidatePoolState: null,
    storyboardState: () => ({ enabled: true, directorBridge: { worldSideShotsEnabled: true } }),
    getChatKey: () => 'chat-a', console,
  });
  vm.runInContext(refresh, context);
  const packet = { packetId: 'packet-a', timelineAnchor: { chatKey: 'chat-a', floor: 10 }, visualIntent: { description: '巷口雨声渐响。' } };
  for (const floor of [undefined, null, '', '  ', false, [], {}]) {
    const pool = await context.refreshDirectorCandidatePool([packet], { chatKey: 'chat-a', floor });
    assert.equal(pool.candidates[0].dimensions.rhythmDistance, 50, String(floor));
    assert.equal(pool.candidates[0].recommendation, 'manual_review');
  }
  const pool = await context.refreshDirectorCandidatePool([packet], { chatKey: 'chat-a', floor: 10 });
  assert.equal(pool.candidates[0].dimensions.rhythmDistance, 0);
});

test('generation rechecks both the explicit setting and candidate rejection', () => {
  const generate = source.slice(source.indexOf('async function storyboardGenerateProductionPacket'), source.indexOf('async function storyboardGenerate(root'));
  assert.match(generate, /if \(!state\.directorBridge\?\.worldSideShotsEnabled\)/);
  assert.match(generate, /directorProductionPacketState\.chatKey !== currentChatKey/);
  assert.match(generate, /directorCandidatePoolState\.chatKey !== currentChatKey/);
  assert.match(generate, /candidate\.recommendation === 'reject'/);
  const bindingStart = source.indexOf("root.querySelector('.sd-storyboard-world-side')?.addEventListener");
  const binding = source.slice(bindingStart, source.indexOf("if (state.view === 'create')", bindingStart));
  assert.match(binding, /resetDirectorNarrativeBridge\(\)/);
  assert.match(binding, /refreshDirectorProductionPackets\(plan/);
});

test('chat switches and extension cleanup discard all ephemeral bridge state', () => {
  assert.match(source, /const rerenderHandler = async \(\) => \{[\s\S]*resetDirectorNarrativeBridge\(\)/);
  const cleanupStart = source.indexOf('function cleanupRuntime');
  const cleanup = source.slice(cleanupStart, source.indexOf('installStartupFallback', cleanupStart));
  assert.match(cleanup, /clean\('director candidate pool', \(\) => resetDirectorNarrativeBridge\(\)\)/);
});

test('message mutations and plan clearing release stale candidates without treating lazy loading as a mutation', () => {
  const handlers = source.slice(source.indexOf('const runBackgroundDirectorRefresh = async'), source.indexOf('function init()'));
  assert.match(handlers, /const refreshHandler = \(messageIndex, generationType\) => \{\s*resetDirectorNarrativeBridge\(\)/);
  assert.match(handlers, /const ttsMessageEditedHandler = \(messageRef\) => \{\s*resetDirectorNarrativeBridge\(\)/);
  assert.match(handlers, /const storyboardMessageDeletedHandler = async \(\) => \{\s*resetDirectorNarrativeBridge\(\)/);
  assert.match(handlers, /const storyboardMessageVersionHandler = \(\) => \{\s*resetDirectorNarrativeBridge\(\)/);
  assert.match(handlers, /MORE_MESSAGES_LOADED[^\n]*storyboardMoreMessagesLoadedHandler/);
  const moreLoaded = handlers.slice(handlers.indexOf('const storyboardMoreMessagesLoadedHandler'), handlers.indexOf('const pairs'));
  assert.doesNotMatch(moreLoaded, /resetDirectorNarrativeBridge/);
  const reviewBindings = source.slice(source.indexOf("root.querySelector('.sd-clear-plan')"), source.indexOf("root.querySelectorAll('.sd-delete-history')"));
  assert.match(reviewBindings, /store\.plan = null;\s*resetDirectorNarrativeBridge\(\)/);
  assert.match(reviewBindings, /getChatStore\(\)\.plan = restored;[\s\S]*resetDirectorNarrativeBridge\(\)/);
});
