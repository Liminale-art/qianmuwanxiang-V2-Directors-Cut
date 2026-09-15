import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeNarrativeContext, narrativeContextField, matchingNarrativeContexts, canRevealNarrativeContext } from '../qianmu-narrative-context.js';
import { normalizeNarrativeLedgerEntry, validateNarrativeLedgerEntry, canExposeNarrativeLedgerEntryToMainline, invalidateNarrativeLedgerEntries, adaptProductionPacketToNarrativeLedgerEntry } from '../qianmu-narrative-ledger.js';
import { normalizeQianmuProductionPacket } from '../qianmu-production-packet.js';
import { scoreNarrativeDirectorCandidate, normalizeDirectorCandidate } from '../qianmu-director-candidate.js';
import { createDirectorDecision, normalizeDirectorDecision, validateDirectorDecision } from '../qianmu-director-decision.js';
import { createDirectorWorkOrder, normalizeDirectorWorkOrder, directorWorkOrderToStoryboardShot, validateDirectorWorkOrder } from '../qianmu-director-work-order.js';
import { normalizeStoryboardShotSpec, storyboardDirectorDecisionSnapshot, storyboardProductionContext, storyboardProductionDeliveryPolicy,
  compareStoryboardSceneFingerprints, prepareStoryboardShotGroup, normalizeStoryboardState, createStoryboardWorkflowTicket,
  validateStoryboardShotSpec, compileStoryboardPrompt, adaptProductionPacketToStoryboardShotSpec } from '../qianmu-storyboard.js';

const context = (overrides = {}) => ({ schema: 'qianmu.narrative-context.v1', chatKey: 'chat-a',
  branch: { kind: 'mainline', id: 'mainline', fork: null }, claim: 'fact', time: { layer: 'present', label: '雨夜' },
  knowledge: { knownBy: ['user', 'alice'], hiddenFrom: [] }, ...overrides });
const parallel = () => context({ branch: { kind: 'parallel', id: 'branch-b', fork: { branchId: 'mainline', recordId: 'message-5', revisionId: 'swipe-1' } } });
const entry = (narrativeContext) => ({ owner: { chatKey: 'chat-a' },
  source: { kind: 'prose', recordId: 'message-10', revisionId: 'swipe-2', floor: 10, ...(narrativeContext === undefined ? {} : { narrativeContext }) },
  fact: { summary: 'Alice留在雨夜车站。' }, temporalState: narrativeContext?.time?.layer || 'present',
  confidence: { state: 'confirmed', score: 1 }, readerVisibility: { scope: 'mainline' }, continuity: { state: 'active' } });
const packet = (narrativeContext) => normalizeQianmuProductionPacket({ packetId: 'packet-a', eventId: 'event-a',
  timelineAnchor: { chatKey: 'chat-a', floor: 10 }, sourceRef: { field: 'world_updates', narrativeContext },
  visualIntent: { description: 'Alice留在雨夜车站。', evidenceRefs: ['paragraph-1'] }, characterState: [{ id: 'alice', name: 'Alice' }],
  sceneState: { time: '雨夜', location: '车站' } });

test('optional context preserves legacy absence, canonically bounds metadata and retains invalid presence', () => {
  assert.deepEqual(narrativeContextField({}), {});
  for (const value of [null, {}, { invalid: true }, context({ schema: 'unknown' }), context({ chatKey: 'a'.repeat(513) })]) {
    assert.deepEqual(narrativeContextField({ narrativeContext: value }), { narrativeContext: { invalid: true } });
  }
  const raw = context({ apiKey: 'secret', knowledge: { knownBy: ['user', 'alice', 'user'], hiddenFrom: [] } });
  const saved = normalizeNarrativeContext(raw);
  assert.deepEqual(saved.knowledge.knownBy, ['alice', 'user']);
  assert.deepEqual(normalizeNarrativeContext(saved), saved);
  assert.doesNotMatch(JSON.stringify(saved), /secret|apiKey/);
  assert.equal(matchingNarrativeContexts({}, { narrativeContext: saved }), false);
  assert.equal(matchingNarrativeContexts({ narrativeContext: saved }, { narrativeContext: raw }), true);
  assert.throws(() => normalizeNarrativeContext(parallel().branch), /来源/);
});

test('new factual markers do not grant knowledge or promote predictions and parallel facts into the mainline', () => {
  assert.equal(canRevealNarrativeContext(context(), 'user'), true);
  assert.equal(canRevealNarrativeContext(context(), 'bob'), false);
  for (const value of [parallel(), context({ claim: 'prediction' }), context({ time: { layer: 'future', label: '明日' } }),
    context({ knowledge: { knownBy: ['user'], hiddenFrom: ['user'] } }), context({ knowledge: { knownBy: [], hiddenFrom: [] } })]) {
    const normalized = normalizeNarrativeLedgerEntry(entry(value));
    assert.equal(canExposeNarrativeLedgerEntryToMainline(normalized, 'user'), false);
    const candidate = scoreNarrativeDirectorCandidate(normalized, { chatKey: 'chat-a', viewerId: 'user' });
    assert.equal(candidate.recommendation, 'manual_review');
    assert.deepEqual(candidate.narrativeContext, normalizeNarrativeContext(value));
  }
  assert.equal(canExposeNarrativeLedgerEntryToMainline(entry(), 'user'), true, 'legacy behavior is unchanged');
});

test('invalid or foreign context cannot disappear during entry and candidate normalization', () => {
  for (const value of [null, { invalid: true }, context({ chatKey: 'chat-b' })]) {
    const normalized = normalizeNarrativeLedgerEntry(entry(value));
    assert.equal(validateNarrativeLedgerEntry(normalized).ok, false);
    assert.equal(canExposeNarrativeLedgerEntryToMainline(normalized, 'user'), false);
    assert.equal(scoreNarrativeDirectorCandidate(normalized, { chatKey: 'chat-a' }).recommendation, 'reject');
  }
});

test('parallel identity differs from mainline even with identical visible content', () => {
  const main = normalizeNarrativeLedgerEntry(entry(context()));
  const fork = normalizeNarrativeLedgerEntry(entry(parallel()));
  assert.notEqual(main.entryId, fork.entryId);
  assert.deepEqual(normalizeNarrativeLedgerEntry(fork), fork);
  const legacy = normalizeNarrativeLedgerEntry(entry());
  assert.equal(legacy.entryId, normalizeNarrativeLedgerEntry(legacy).entryId);
});

test('context survives packet, ledger, candidate, approved decision, work order and history snapshot', () => {
  const value = parallel();
  value.claim = 'prediction';
  const source = packet(value);
  const before = structuredClone(source);
  const ledgerEntry = adaptProductionPacketToNarrativeLedgerEntry(source);
  assert.deepEqual(ledgerEntry.source.narrativeContext, normalizeNarrativeContext(value));
  const candidate = normalizeDirectorCandidate(scoreNarrativeDirectorCandidate(ledgerEntry, { chatKey: 'chat-a', viewerId: 'user' }));
  const result = createDirectorDecision(candidate, source, { chatKey: 'chat-a', ledgerEntryId: ledgerEntry.entryId, explicitApproval: true, approvedAt: 100 });
  assert.equal(result.ok, true, result.issues.join(','));
  const decision = normalizeDirectorDecision(result.decision);
  assert.equal(decision.truthMode, 'speculative');
  assert.deepEqual(decision.source.narrativeContext, normalizeNarrativeContext(value));
  const dispatch = createDirectorWorkOrder(decision, 'storyboard', 'chat-a', { createdAt: 200 });
  assert.equal(dispatch.ok, true);
  const order = normalizeDirectorWorkOrder(dispatch.workOrder);
  assert.deepEqual(order.source.narrativeContext, normalizeNarrativeContext(value));
  const shot = normalizeStoryboardShotSpec({ ...directorWorkOrderToStoryboardShot(order, 'chat-a'), directorDecision: decision });
  assert.equal(shot.narrativeLayer, 'imagined');
  const history = JSON.parse(JSON.stringify({ snapshot: { shotSpec: shot } }));
  assert.deepEqual(storyboardDirectorDecisionSnapshot(history).source.narrativeContext, normalizeNarrativeContext(value));
  assert.deepEqual(storyboardProductionContext(history).narrativeContext, normalizeNarrativeContext(value));
  assert.deepEqual(source, before);
});

test('a candidate cannot be paired with a packet from a different or missing branch context', () => {
  const value = parallel(); value.claim = 'prediction';
  const source = packet(value), ledgerEntry = adaptProductionPacketToNarrativeLedgerEntry(source);
  const candidate = scoreNarrativeDirectorCandidate(ledgerEntry, { chatKey: 'chat-a' });
  for (const changed of [packet(context({ claim: 'prediction' })), { ...source, sourceRef: {} }]) {
    const result = createDirectorDecision(candidate, changed, { chatKey: 'chat-a', ledgerEntryId: ledgerEntry.entryId, explicitApproval: true });
    assert.equal(result.ok, false);
    assert.equal(result.decision, null);
  }
});

test('branch lifecycle events isolate mainline and parallel entries, while exact fork evidence expires dependents', () => {
  const main = normalizeNarrativeLedgerEntry(entry(context())), fork = normalizeNarrativeLedgerEntry(entry(parallel()));
  const ledger = { owner: { chatKey: 'chat-a' }, entries: [main, fork], revision: 0 };
  const mainOnly = invalidateNarrativeLedgerEntries(ledger, { chatKey: 'chat-a', kind: 'message_revised', floor: 10 });
  assert.deepEqual(mainOnly.invalidatedEntryIds, [main.entryId]);
  const branchOnly = invalidateNarrativeLedgerEntries(ledger, { chatKey: 'chat-a', branchId: 'branch-b', kind: 'message_revised', floor: 10 });
  assert.deepEqual(branchOnly.invalidatedEntryIds, [fork.entryId]);
  const changedFork = invalidateNarrativeLedgerEntries(ledger, { chatKey: 'chat-a', kind: 'swipe_changed', revisionId: 'swipe-1' });
  assert.deepEqual(changedFork.invalidatedEntryIds, [fork.entryId]);
  const invalidBranch = invalidateNarrativeLedgerEntries(ledger, { chatKey: 'chat-a', branchId: '', kind: 'message_revised', floor: 10 });
  assert.deepEqual(invalidBranch.invalidatedEntryIds, []);
});

const approved = value => {
  const source = packet(value), ledgerEntry = adaptProductionPacketToNarrativeLedgerEntry(source);
  const candidate = scoreNarrativeDirectorCandidate(ledgerEntry, { chatKey: 'chat-a', viewerId: 'user' });
  const result = createDirectorDecision(candidate, source, { chatKey: 'chat-a', ledgerEntryId: ledgerEntry.entryId, explicitApproval: true, approvedAt: 100 });
  assert.equal(result.ok, true, result.issues.join(','));
  return result.decision;
};

test('neither fact metadata nor explicit approval promotes simulation authority', () => {
  const decision = approved(context());
  assert.equal(decision.truthMode, 'speculative');
  const { workOrder } = createDirectorWorkOrder(decision, 'storyboard', 'chat-a');
  const shot = normalizeStoryboardShotSpec(directorWorkOrderToStoryboardShot(workOrder, 'chat-a'));
  assert.equal(shot.narrativeLayer, 'imagined');
  const result = storyboardProductionDeliveryPolicy({ ...shot, productionContext: { ...shot.productionContext, autoInsert: true } }, { target: 'floor' });
  assert.equal(result.target, 'gallery'); assert.equal(result.inlineByDefault, false);
});

test('a past prose fact stays a memory, whereas a parallel prose fact cannot become canon', () => {
  for (const value of [context({ time: { layer: 'past', label: '十年前' } }), parallel()]) {
    const ledgerEntry = normalizeNarrativeLedgerEntry(entry(value));
    const candidate = scoreNarrativeDirectorCandidate(ledgerEntry, { chatKey: 'chat-a', viewerId: 'user' });
    const { decision, ok } = createDirectorDecision(candidate, packet(value), { chatKey: 'chat-a', ledgerEntryId: ledgerEntry.entryId, explicitApproval: true });
    assert.equal(ok, true);
    const { workOrder } = createDirectorWorkOrder(decision, 'storyboard', 'chat-a');
    const shot = normalizeStoryboardShotSpec(directorWorkOrderToStoryboardShot(workOrder, 'chat-a'));
    assert.equal(shot.narrativeLayer, value.branch.kind === 'parallel' ? 'imagined' : 'memory');
  }
});

test('invalid, foreign and forged canonical contexts remain closed after normalization and dispatch', () => {
  const decision = approved(parallel());
  const { workOrder } = createDirectorWorkOrder(decision, 'storyboard', 'chat-a');
  for (const value of [null, context({ schema: 'v-next' }), context({ chatKey: 'chat-b' })]) {
    const changed = normalizeDirectorDecision({ ...decision, source: { ...decision.source, narrativeContext: value } });
    assert.equal(validateDirectorDecision(changed).ok, false);
    assert.equal(createDirectorWorkOrder(changed, 'storyboard', 'chat-a').workOrder, null);
    const changedOrder = normalizeDirectorWorkOrder({ ...workOrder, source: { ...workOrder.source, narrativeContext: value } });
    assert.equal(validateDirectorWorkOrder(changedOrder, 'storyboard', 'chat-a').ok, false);
    assert.equal(directorWorkOrderToStoryboardShot(changedOrder, 'chat-a'), null);
  }
  assert.equal(validateDirectorDecision({ ...decision, truthMode: 'canon' }).ok, false);
  assert.equal(validateDirectorWorkOrder({ ...workOrder, truthMode: 'canon' }).ok, false);
});

test('restricted provenance cannot auto-insert even when packet IDs or the normal confirmation hint are missing', () => {
  for (const value of [null, parallel(), context({ claim: 'prediction' }), context({ knowledge: { knownBy: ['alice'], hiddenFrom: [] } })]) {
    const result = storyboardProductionDeliveryPolicy({ productionContext: { narrativeContext: value, autoInsert: true, truthMode: 'canon' } }, { target: 'latest', chatKey: 'chat-a' });
    assert.equal(result.requiresExplicitInsert, true); assert.equal(result.target, 'gallery');
  }
  const visible = { productionContext: { narrativeContext: context(), autoInsert: true, truthMode: 'canon' } };
  assert.equal(storyboardProductionDeliveryPolicy(visible, { chatKey: 'chat-b' }).requiresExplicitInsert, true);
  assert.equal(storyboardProductionDeliveryPolicy(visible, { chatKey: 'chat-a' }).requiresExplicitInsert, false);
  assert.equal(storyboardProductionDeliveryPolicy({}, { target: 'latest' }).requiresExplicitInsert, false);
});

test('malformed or inconsistent shot provenance cannot compile or enter even a manually arranged batch', () => {
  const decision = approved(parallel());
  const { workOrder } = createDirectorWorkOrder(decision, 'storyboard', 'chat-a');
  const base = normalizeStoryboardShotSpec({ ...directorWorkOrderToStoryboardShot(workOrder, 'chat-a'), directorDecision: decision });
  for (const value of [null, context(), context({ chatKey: 'chat-b' })]) {
    const shot = normalizeStoryboardShotSpec({ ...base, productionContext: { ...base.productionContext, narrativeContext: value } });
    assert.equal(validateStoryboardShotSpec(shot).valid, false);
    assert.throws(() => compileStoryboardPrompt({ providerId: 'novel', shot }), { code: 'narrative_context_invalid' });
    const batch = prepareStoryboardShotGroup({ shots: [shot], manual: true, chatKey: 'chat-a' });
    assert.equal(batch.shots.length, 0); assert.equal(batch.skipped[0].reason, 'narrative_context_invalid');
  }
  const stripped = structuredClone(base); delete stripped.productionContext.narrativeContext;
  assert.equal(validateStoryboardShotSpec(stripped).valid, false, 'a remaining snapshot/fingerprint is not a legacy opt-out');
});

test('different branches never merge scenes or overwrite and age each other’s continuity', () => {
  const firstContext = parallel(), otherContext = parallel(); otherContext.branch.id = 'branch-c';
  const shot = (id, value, state) => adaptProductionPacketToStoryboardShotSpec(packet(value), {
    id, sceneId: 'same-scene', continuityUpdates: { outfit: { alice: state }, facts: [{ id: `${id}-gaze`, category: 'action', subject: 'alice', key: 'gaze', value: state, persistence: 'momentary' }] },
  });
  const a = shot('a', firstContext, 'coat removed'), b = shot('b', otherContext, 'coat worn');
  assert.equal(compareStoryboardSceneFingerprints(a.sceneFingerprint, b.sceneFingerprint).sameScene, false);
  assert.notEqual(a.sceneFingerprint.id, b.sceneFingerprint.id);
  const output = prepareStoryboardShotGroup({ shots: [a, b], maxShots: 2 });
  assert.equal(output.shots.length, 2, JSON.stringify(output.skipped)); assert.equal(output.sceneGroups.length, 2);
  assert.equal(output.continuityLedger.outfit.alice, 'coat removed');
  assert.equal(output.continuityLedger.facts[0].status, 'active');
  assert.equal(output.continuityLedger.facts.some(fact => fact.id === 'b-gaze'), false);
  const ticket = createStoryboardWorkflowTicket({ continuityLedger: output.continuityLedger, continuityLedgerLayer: output.continuityLedgerLayer });
  const stored = normalizeStoryboardState(JSON.parse(JSON.stringify({ shotPlans: [{ ...ticket, id: 'plan-a' }] }))).shotPlans[0];
  assert.deepEqual(stored.continuityLedger.narrativeContext, normalizeNarrativeContext(firstContext));
  const next = prepareStoryboardShotGroup({ shots: [b], continuityLedger: stored.continuityLedger, continuityLedgerLayer: stored.continuityLedgerLayer });
  assert.equal(next.continuityLedger.facts.some(fact => fact.id === 'a-gaze'), false);
  const unchanged = prepareStoryboardShotGroup({ shots: [a], continuityLedger: { ...stored.continuityLedger, props: { ticket: 'alice' } }, continuityLedgerLayer: stored.continuityLedgerLayer });
  assert.equal(unchanged.continuityLedger.props.ticket, 'alice');
  const legacy = prepareStoryboardShotGroup({ shots: [{ id: 'legacy', sourceParagraphIds: ['p1'], narrativePurpose: 'leaving', narrativeLayer: 'imagined' }], continuityLedger: stored.continuityLedger, manual: true });
  assert.equal(legacy.continuityLedger.outfit.alice, undefined);
});

test('source edits cannot invalidate a foreign chat or another branch through a numeric floor alone', () => {
  const fork = normalizeNarrativeLedgerEntry(entry(parallel())), ledger = { owner: { chatKey: 'chat-a' }, entries: [fork] };
  for (const event of [
    { chatKey: 'chat-b', kind: 'swipe_changed', revisionId: 'swipe-1' },
    { chatKey: 'chat-a', branchId: 'branch-c', kind: 'swipe_changed', revisionId: 'swipe-1' },
    { chatKey: 'chat-a', kind: 'source_deleted', floor: 5 },
    { chatKey: 'chat-a', kind: 'manual', entryIds: [fork.entryId] },
  ]) assert.deepEqual(invalidateNarrativeLedgerEntries(ledger, event).invalidatedEntryIds, []);
  assert.deepEqual(invalidateNarrativeLedgerEntries(ledger, { chatKey: 'chat-a', branchId: 'branch-b', kind: 'manual', entryIds: [fork.entryId] }).invalidatedEntryIds, [fork.entryId]);
});

test('a lightweight wrapper cannot erase or contradict the narrative boundary in a saved shot', () => {
  const shot = adaptProductionPacketToStoryboardShotSpec(packet(parallel()));
  const value = { productionContext: {}, snapshot: { shotSpec: shot } };
  assert.deepEqual(storyboardProductionContext(value).narrativeContext, normalizeNarrativeContext(parallel()));
  assert.equal(storyboardProductionDeliveryPolicy(value).target, 'gallery');
  value.productionContext.narrativeContext = context();
  assert.deepEqual(storyboardProductionContext(value).narrativeContext, { invalid: true });
  assert.equal(storyboardProductionDeliveryPolicy(value).target, 'gallery');
});

test('a rejected first shot does not contaminate the valid branch selected for continuity', () => {
  const bad = adaptProductionPacketToStoryboardShotSpec(packet(null));
  const good = adaptProductionPacketToStoryboardShotSpec(packet(parallel()), { id: 'good', continuityUpdates: { props: { letter: 'alice' } } });
  const result = prepareStoryboardShotGroup({ shots: [bad, good], manual: true });
  assert.equal(result.shots.length, 1); assert.equal(result.shots[0].id, 'good');
  assert.equal(result.continuityLedger.props.letter, 'alice');
  assert.deepEqual(result.continuityLedger.narrativeContext, normalizeNarrativeContext(parallel()));
});
