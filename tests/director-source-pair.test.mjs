import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeQianmuProductionPacket } from '../qianmu-production-packet.js';
import { adaptProductionPacketToNarrativeLedgerEntry, normalizeNarrativeLedgerEntry } from '../qianmu-narrative-ledger.js';
import { scoreNarrativeDirectorCandidate } from '../qianmu-director-candidate.js';
import { createDirectorDecision, canConsumeDirectorDecision } from '../qianmu-director-decision.js';

const fixture = () => {
  const packet = normalizeQianmuProductionPacket({ packetId: 'packet-a', eventId: 'event-a',
    timelineAnchor: { chatKey: 'chat-a', floor: 7, messageId: 'message-7', revisionId: 'swipe-2' },
    sourceRef: { field: 'npc_updates', itemId: 'alice-update' },
    visualIntent: { duty: 'reaction', subject: 'the letter', description: 'Alice reads the letter.', evidenceRefs: ['paragraph-1'] },
    characterState: [{ id: 'alice', name: 'Alice' }], continuityRefs: ['cause-a'],
  });
  const ledgerEntry = adaptProductionPacketToNarrativeLedgerEntry(packet);
  const candidate = scoreNarrativeDirectorCandidate(ledgerEntry, { chatKey: 'chat-a', viewerId: 'user' });
  const options = { chatKey: 'chat-a', ledgerEntryId: ledgerEntry.entryId, ledgerEntry, explicitApproval: true, approvedAt: 100 };
  return { packet, ledgerEntry, candidate, options };
};

test('world confirmation accepts its exact source entry without mutating it or changing saved receipt shape', () => {
  const f = fixture(), before = structuredClone(f);
  const result = createDirectorDecision(f.candidate, f.packet, f.options);
  assert.equal(result.ok, true, result.issues.join(','));
  assert.equal(canConsumeDirectorDecision(result.decision, 'storyboard', 'chat-a'), true);
  assert.deepEqual(f, before);
  const legacyOptions = { ...f.options }; delete legacyOptions.ledgerEntry;
  assert.deepEqual(result.decision, createDirectorDecision(f.candidate, f.packet, legacyOptions).decision);
});

test('another packet, revision, floor or fact cannot borrow an existing candidate within the same chat', () => {
  const f = fixture();
  const mutations = [p => { p.packetId = 'packet-b'; }, p => { p.eventId = 'event-b'; },
    p => { p.timelineAnchor.floor = 8; }, p => { p.timelineAnchor.revisionId = 'swipe-3'; },
    p => { p.timelineAnchor.messageId = 'message-8'; }, p => { p.sourceRef.itemId = 'bob-update'; },
    p => { p.sourceRef.field = 'world_updates'; }, p => { p.visualIntent.description = 'Alice burns the letter.'; },
    p => { p.visualIntent.subject = 'a photograph'; }, p => { p.visualIntent.evidenceRefs = ['paragraph-2']; },
    p => { p.characterState[0].id = 'bob'; }, p => { p.continuityRefs = ['cause-b']; }];
  for (const mutate of mutations) {
    const packet = structuredClone(f.packet); mutate(packet);
    const result = createDirectorDecision(f.candidate, packet, f.options);
    assert.equal(result.ok, false, JSON.stringify(packet));
    assert.equal(result.decision, null);
  }
});

test('a supplied but missing, foreign, superseded or malformed source entry is not treated as a legacy omission', () => {
  const f = fixture();
  const variants = [null, undefined, {}, { ...f.ledgerEntry, schema: 'unknown' },
    { ...f.ledgerEntry, owner: { chatKey: 'chat-b' } },
    { ...f.ledgerEntry, entryId: 'different' },
    { ...f.ledgerEntry, continuity: { state: 'invalidated', invalidatedBy: ['source_deleted:message-7'] } },
    { ...f.ledgerEntry, source: { ...f.ledgerEntry.source, recordId: '' } }];
  for (const ledgerEntry of variants) {
    const result = createDirectorDecision(f.candidate, f.packet, { ...f.options, ledgerEntry });
    assert.equal(result.ok, false, JSON.stringify(ledgerEntry));
    assert.equal(result.decision, null);
  }
});

test('candidate identity and factual projection must still match its actual ledger entry', () => {
  const f = fixture();
  for (const patch of [{ candidateId: 'unrelated' }, { sourceKind: 'prose' }, { factDigest: 'Other event.' },
    { subjectIds: ['bob'] }, { temporalState: 'future' }, { direction: { ...f.candidate.direction, shotSignature: 'unrelated' } }]) {
    const result = createDirectorDecision({ ...f.candidate, ...patch }, f.packet, f.options);
    assert.equal(result.ok, false, JSON.stringify(patch)); assert.equal(result.decision, null);
  }
});

test('an unsupported packet schema cannot be reinterpreted under a source confirmation', () => {
  const f = fixture();
  const denied = createDirectorDecision(f.candidate, { ...f.packet, schema: 'future' }, f.options);
  assert.equal(denied.ok, false); assert.equal(denied.decision, null);
  const legacy = structuredClone(f.packet); delete legacy.schema;
  assert.equal(createDirectorDecision(f.candidate, legacy, f.options).ok, true);
});

test('source entry normalization is stable and unchanged metadata does not need a new candidate', () => {
  const f = fixture();
  const ledgerEntry = normalizeNarrativeLedgerEntry({ ...f.ledgerEntry, updatedAt: 'later audit', createdAt: 'earlier audit' });
  const result = createDirectorDecision(f.candidate, f.packet, { ...f.options, ledgerEntry });
  assert.equal(result.ok, true, result.issues.join(','));
});

test('exact parallel provenance, unknown floors and a custom shot direction survive source pairing', () => {
  const f = fixture();
  f.packet.timelineAnchor.floor = null;
  f.packet.sourceRef.narrativeContext = { schema: 'qianmu.narrative-context.v1', chatKey: 'chat-a', claim: 'prediction',
    branch: { kind: 'parallel', id: 'branch-b', fork: { branchId: 'mainline', recordId: 'message-3', revisionId: 'swipe-1' } },
    time: { layer: 'future', label: '明日' }, knowledge: { knownBy: ['alice'], hiddenFrom: ['user'] } };
  const ledgerEntry = adaptProductionPacketToNarrativeLedgerEntry(f.packet);
  const candidate = scoreNarrativeDirectorCandidate(ledgerEntry, { chatKey: 'chat-a', viewerId: 'user',
    directionByEntryId: { [ledgerEntry.entryId]: { duty: 'detail', framing: 'close up', shotSignature: 'a close up of the letter', narrativeValue: 80 } } });
  const options = { ...f.options, ledgerEntry, ledgerEntryId: ledgerEntry.entryId };
  const result = createDirectorDecision(candidate, f.packet, options);
  assert.equal(result.ok, true, result.issues.join(',')); assert.equal(result.decision.truthMode, 'speculative');
  assert.equal(ledgerEntry.source.floor, null);
  const changed = structuredClone(f.packet); changed.sourceRef.narrativeContext.branch.id = 'branch-c';
  assert.equal(createDirectorDecision(candidate, changed, options).decision, null);
});
