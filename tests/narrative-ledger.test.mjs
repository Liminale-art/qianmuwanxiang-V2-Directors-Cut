import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  QIANMU_NARRATIVE_ENTRY_SCHEMA,
  QIANMU_NARRATIVE_LEDGER_SCHEMA,
  adaptProductionPacketToNarrativeLedgerEntry,
  canExposeNarrativeLedgerEntryToMainline,
  invalidateNarrativeLedgerEntries,
  normalizeNarrativeLedger,
  normalizeNarrativeLedgerEntry,
  validateNarrativeLedger,
  validateNarrativeLedgerEntry,
} from '../qianmu-narrative-ledger.js';
import { adaptDirectorPlanToProductionPackets } from '../qianmu-production-packet.js';

const proseFact = {
  owner: { chatKey: 'chat-a' },
  source: { kind: 'prose', authority: 'canon', recordId: 'message-12', floor: 12, revisionId: 'swipe-2' },
  fact: { subjectIds: ['alice'], predicate: 'wears', object: 'red coat', summary: 'Alice 穿着红外套。' },
  temporalState: 'present',
  confidence: { state: 'confirmed', score: 1 },
  readerVisibility: { scope: 'mainline' },
  continuity: { state: 'active', conditions: [{ kind: 'swipe_changed', refId: 'swipe-2' }] },
};

test('prose facts keep canonical source identity and may reach the mainline', () => {
  const result = validateNarrativeLedgerEntry(proseFact, 'chat-a');
  assert.equal(result.ok, true);
  assert.equal(result.entry.schema, QIANMU_NARRATIVE_ENTRY_SCHEMA);
  assert.equal(result.entry.source.authority, 'canon');
  assert.equal(result.entry.source.floor, 12);
  assert.equal(result.entry.confidence.state, 'confirmed');
  assert.equal(canExposeNarrativeLedgerEntryToMainline(result.entry, 'user'), true);
});

test('simulation possibilities cannot self-promote into prose facts or reader-visible truth', () => {
  const raw = {
    owner: { chatKey: 'chat-a' },
    source: { kind: 'simulation', authority: 'canon', recordId: 'director-plan-7', field: 'npc_updates' },
    fact: { summary: 'Alice 或许会烧掉来信。' },
    confidence: { state: 'confirmed', score: 1 },
    readerVisibility: { scope: 'mainline', viewerIds: ['user'] },
    continuity: { state: 'active' },
  };
  const result = validateNarrativeLedgerEntry(raw, 'chat-a');
  assert.equal(result.ok, false);
  assert.ok(result.issues.includes('source_authority_mismatch'));
  assert.ok(result.issues.includes('simulation_cannot_confirm'));
  assert.ok(result.issues.includes('simulation_cannot_reveal'));
  assert.equal(result.entry.source.authority, 'possibility');
  assert.equal(result.entry.confidence.state, 'possible');
  assert.equal(result.entry.confidence.score, .69);
  assert.equal(result.entry.readerVisibility.scope, 'director_only');
  assert.equal(canExposeNarrativeLedgerEntryToMainline(result.entry, 'user'), false);
});

test('unknown sources fail closed as director-only possibilities', () => {
  const raw = { owner: { chatKey: 'chat-a' }, source: { kind: 'model_guess', recordId: 'x' }, fact: { summary: '未知来源。' } };
  const result = validateNarrativeLedgerEntry(raw, 'chat-a');
  assert.equal(result.ok, false);
  assert.ok(result.issues.includes('source_kind_invalid'));
  assert.equal(result.entry.source.kind, 'simulation');
  assert.equal(result.entry.readerVisibility.scope, 'director_only');
});

test('mainline exposure validates source completeness and authority before applying defaults', () => {
  for (const raw of [
    { ...proseFact, owner: {} },
    { ...proseFact, source: { ...proseFact.source, recordId: '' } },
    { ...proseFact, fact: {} },
    { ...proseFact, source: { ...proseFact.source, authority: 'possibility' } },
    { ...proseFact, schema: 'qianmu.narrative-entry.v999' },
  ]) {
    assert.equal(canExposeNarrativeLedgerEntryToMainline(raw, 'user'), false);
    assert.equal(validateNarrativeLedgerEntry(raw).ok, false);
  }
});

test('legacy and v1 visibility remain viewer-scoped without rewriting saved records', () => {
  const legacy = { ...proseFact, readerVisibility: { scope: 'limited', viewerIds: ['alice', 'user'], hiddenFrom: ['user'] } };
  const before = structuredClone(legacy);
  for (const entry of [legacy, normalizeNarrativeLedgerEntry(legacy)]) {
    assert.equal(validateNarrativeLedgerEntry(entry).ok, true);
    assert.equal(canExposeNarrativeLedgerEntryToMainline(entry, 'alice'), true);
    assert.equal(canExposeNarrativeLedgerEntryToMainline(entry, 'user'), false);
    assert.equal(canExposeNarrativeLedgerEntryToMainline(entry, 'bob'), false);
    assert.equal(canExposeNarrativeLedgerEntryToMainline(entry), false);
  }
  assert.deepEqual(legacy, before);
  const unknown = validateNarrativeLedger({ schema: 'qianmu.narrative-ledger.v999', owner: { chatKey: 'chat-a' }, entries: [proseFact] });
  assert.equal(unknown.ok, false);
  assert.ok(unknown.issues.includes('ledger_schema_unsupported'));
});

test('ledger validation is bounded, chat-owned and rejects duplicate facts', () => {
  const first = normalizeNarrativeLedgerEntry(proseFact);
  const otherChat = { ...proseFact, owner: { chatKey: 'chat-b' }, entryId: 'other' };
  const result = validateNarrativeLedger({
    owner: { chatKey: 'chat-a' },
    entries: [first, { ...first }, otherChat],
  });
  assert.equal(result.ledger.schema, QIANMU_NARRATIVE_LEDGER_SCHEMA);
  assert.equal(result.ok, false);
  assert.ok(result.issues.includes('entry_1_duplicate_id'));
  assert.ok(result.issues.includes('entry_2_owner_chat_mismatch'));
});

test('normalization strips prompts, credentials, URLs and arbitrary payloads', () => {
  const normalized = normalizeNarrativeLedgerEntry({
    ...proseFact,
    prompt: 'secret prompt',
    apiKey: 'secret-key',
    url: 'https://example.invalid/image.png',
    blob: new Blob(['x']),
    source: { ...proseFact.source, response: { raw: 'provider data' } },
    fact: { ...proseFact.fact, imageData: 'data:image/png;base64,AAAA' },
  });
  const serialized = JSON.stringify(normalized);
  assert.doesNotMatch(serialized, /secret prompt|secret-key|example\.invalid|provider data|base64/);
});

test('source lifecycle events invalidate matching facts but retain their audit trail', () => {
  const swipeFact = normalizeNarrativeLedgerEntry(proseFact);
  const otherFact = normalizeNarrativeLedgerEntry({
    ...proseFact,
    entryId: 'other-fact',
    source: { ...proseFact.source, recordId: 'message-15', floor: 15, revisionId: 'swipe-8' },
    continuity: { state: 'active', conditions: [{ kind: 'source_deleted', refId: 'message-15' }] },
  });
  const original = { owner: { chatKey: 'chat-a' }, entries: [swipeFact, otherFact], revision: 3 };
  const result = invalidateNarrativeLedgerEntries(original, {
    chatKey: 'chat-a', kind: 'swipe_changed', revisionId: 'swipe-2', updatedAt: '2026-09-03T10:00:00Z',
  });
  assert.deepEqual(result.invalidatedEntryIds, [swipeFact.entryId]);
  assert.equal(result.ledger.revision, 4);
  assert.equal(result.ledger.entries[0].continuity.state, 'invalidated');
  assert.deepEqual(result.ledger.entries[0].continuity.invalidatedBy, ['swipe_changed:swipe-2']);
  assert.equal(result.ledger.entries[1].continuity.state, 'active');
  assert.equal(canExposeNarrativeLedgerEntryToMainline(result.ledger.entries[0], 'user'), false);
  assert.equal(original.entries[0].continuity.state, 'active', 'the source ledger is not mutated');
});

test('floor deletion, explicit supersession and cross-chat requests fail safely', () => {
  const ledger = { owner: { chatKey: 'chat-a' }, entries: [proseFact], revision: 1 };
  const foreign = invalidateNarrativeLedgerEntries(ledger, { chatKey: 'chat-b', kind: 'source_deleted', floor: 12 });
  assert.equal(foreign.issue, 'owner_chat_mismatch');
  assert.equal(foreign.ledger.entries[0].continuity.state, 'active');
  const deleted = invalidateNarrativeLedgerEntries(ledger, { chatKey: 'chat-a', kind: 'source_deleted', floor: 12 });
  assert.equal(deleted.ledger.entries[0].continuity.state, 'invalidated');
  const superseded = invalidateNarrativeLedgerEntries(ledger, {
    chatKey: 'chat-a', kind: 'superseded', entryIds: [deleted.ledger.entries[0].entryId],
  });
  assert.equal(superseded.ledger.entries[0].continuity.state, 'superseded');
  const repeated = invalidateNarrativeLedgerEntries(deleted.ledger, { chatKey: 'chat-a', kind: 'source_deleted', floor: 12 });
  assert.equal(repeated.ledger.revision, deleted.ledger.revision, 'repeated events remain idempotent');
});

test('missing and invalid source floors stay unanchored through repeated normalization', () => {
  for (const floor of [undefined, null, '', '  ', false, true, [], [0], {}, -1, .5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1]) {
    const input = { ...proseFact, source: { ...proseFact.source, floor } };
    const entry = normalizeNarrativeLedgerEntry(input);
    assert.equal(entry.source.floor, null, `not a floor: ${String(floor)}`);
    assert.deepEqual(normalizeNarrativeLedgerEntry(entry), entry);
    const ledger = normalizeNarrativeLedger({ owner: { chatKey: 'chat-a' }, entries: [entry] });
    assert.deepEqual(normalizeNarrativeLedger(ledger), ledger);
    assert.equal(validateNarrativeLedger(ledger).ok, true, 'legacy records need not invent a floor to remain readable');
  }
});

test('real floor zero and legacy numeric strings keep their existing source identity', () => {
  for (const [floor, expected] of [[0, 0], ['0', 0], [' 12 ', 12], [12, 12]]) {
    const entry = normalizeNarrativeLedgerEntry({ ...proseFact, entryId: 'saved-fact', source: { ...proseFact.source, floor } });
    assert.equal(entry.entryId, 'saved-fact');
    assert.equal(entry.source.floor, expected);
    assert.deepEqual(normalizeNarrativeLedgerEntry(entry), entry);
    const result = invalidateNarrativeLedgerEntries({ owner: { chatKey: 'chat-a' }, entries: [entry] }, {
      chatKey: 'chat-a', kind: 'source_deleted', floor,
    });
    assert.deepEqual(result.invalidatedEntryIds, ['saved-fact']);
  }
});

test('unanchored world packets do not become floor-zero facts or expire with floor zero', () => {
  const [packet] = adaptDirectorPlanToProductionPackets({ world_updates: [{ title: '雨声', content: '巷口雨声渐响。' }] }, { chatKey: 'chat-a' });
  assert.equal(packet.timelineAnchor.floor, null);
  const worldEntry = adaptProductionPacketToNarrativeLedgerEntry(packet);
  assert.equal(worldEntry.source.floor, null);
  const firstFloor = { ...proseFact, entryId: 'first-floor', source: { ...proseFact.source, floor: 0 } };
  const ledger = normalizeNarrativeLedger({ owner: { chatKey: 'chat-a' }, entries: [firstFloor, worldEntry], revision: 5 });
  const original = structuredClone(ledger);
  for (const kind of ['source_deleted', 'message_revised', 'swipe_changed']) {
    const result = invalidateNarrativeLedgerEntries(ledger, { chatKey: 'chat-a', kind, floor: 0 });
    assert.deepEqual(result.invalidatedEntryIds, ['first-floor']);
    assert.equal(result.ledger.revision, 6);
    assert.deepEqual(result.ledger.entries[1], worldEntry);
  }
  assert.deepEqual(ledger, original, 'lifecycle evaluation does not mutate historical input');
  const exact = invalidateNarrativeLedgerEntries(ledger, { chatKey: 'chat-a', kind: 'source_deleted', recordId: packet.packetId });
  assert.deepEqual(exact.invalidatedEntryIds, [worldEntry.entryId], 'an exact source reference still expires unanchored records');
  assert.equal(canExposeNarrativeLedgerEntryToMainline(worldEntry), false);
});

test('empty or invalid event floors do not expire real first-floor records', () => {
  const entry = { ...proseFact, source: { ...proseFact.source, floor: 0 } };
  const ledger = normalizeNarrativeLedger({ owner: { chatKey: 'chat-a' }, entries: [entry], revision: 5 });
  for (const kind of ['source_deleted', 'message_revised', 'swipe_changed']) {
    for (const floor of [undefined, null, '', '  ', false, true, [], [0], {}, -1, .5, Infinity, NaN]) {
      const result = invalidateNarrativeLedgerEntries(ledger, { chatKey: 'chat-a', kind, floor });
      assert.deepEqual(result.invalidatedEntryIds, [], `${kind}: ${String(floor)}`);
      assert.deepEqual(result.ledger, ledger);
    }
  }
});

test('the ledger contract remains a lazy release chunk', async () => {
  const source = await readFile(new URL('../index.js', import.meta.url), 'utf8');
  const release = JSON.parse(await readFile(new URL('../release-files.json', import.meta.url), 'utf8'));
assert.match(source, /narrativeLedger:\s*\{[\s\S]*import\('\.\/qianmu-narrative-ledger\.js\?v=1\.59\.182'\)/);
  const init = source.slice(source.indexOf('function init()'), source.indexOf('function destroy()'));
  assert.doesNotMatch(init, /featureRuntime\.load\('narrativeLedger'\)/);
  assert.ok(release.files.includes('qianmu-narrative-ledger.js'));
});
