import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  canConsumeDirectorDecision,
  createDirectorDecision,
  normalizeDirectorDecision,
  revokeDirectorDecision,
  validateDirectorDecision,
} from '../qianmu-director-decision.js';
import { createDirectorWorkOrder, canConsumeDirectorWorkOrder } from '../qianmu-director-work-order.js';
import { adaptProductionPacketToStoryboardShotSpec, storyboardProductionContext } from '../qianmu-storyboard.js';

const candidate = (overrides = {}) => ({
  candidateId: 'candidate-a', owner: { chatKey: 'chat-a' }, entryId: 'simulation-packet-a',
  sourceKind: 'simulation', recommendation: 'manual_review', total: 64,
  gates: { sourceValid: true, factConsistency: true, spoilerSafe: false, shotDistinct: true },
  ...overrides,
});
const packet = (overrides = {}) => ({
  packetId: 'packet-a', eventId: 'event-a', timelineAnchor: { chatKey: 'chat-a' },
  sourceRef: { field: 'npc_updates' },
  visualIntent: { duty: 'reaction', shotPattern: 'single_reaction', subject: '来信', description: 'Alice 烧掉来信。' },
  audioIntent: { dialogue: ['Alice：到此为止。'], ambience: ['雨声'] },
  perceivedConsequence: { summary: '灰烬落入水池。' },
  ...overrides,
});

test('manual-review candidates require explicit approval before any consumer can use them', () => {
  const denied = createDirectorDecision(candidate(), packet(), {
    chatKey: 'chat-a', ledgerEntryId: 'simulation-packet-a', approvedAt: 100,
    outputs: { storyboard: true },
  });
  assert.equal(denied.ok, false);
  assert.ok(denied.issues.includes('explicit_approval_required'));
  const approved = createDirectorDecision(candidate(), packet(), {
    chatKey: 'chat-a', ledgerEntryId: 'simulation-packet-a', explicitApproval: true, approvedAt: 100,
    outputs: { storyboard: true },
  });
  assert.equal(approved.ok, true);
  assert.equal(approved.decision.truthMode, 'speculative');
  assert.equal(canConsumeDirectorDecision(approved.decision, 'storyboard', 'chat-a'), true);
  assert.equal(canConsumeDirectorDecision(approved.decision, 'voice', 'chat-a'), false);
});

test('rejected, mismatched and cross-chat sources cannot produce a usable decision', () => {
  const rejected = createDirectorDecision(candidate({ recommendation: 'reject' }), packet(), {
    chatKey: 'chat-a', ledgerEntryId: 'simulation-packet-a', explicitApproval: true, outputs: { storyboard: true },
  });
  assert.ok(rejected.issues.includes('candidate_rejected'));
  const foreign = createDirectorDecision(candidate(), packet({ timelineAnchor: { chatKey: 'chat-b' } }), {
    chatKey: 'chat-a', ledgerEntryId: 'wrong-entry', explicitApproval: true, outputs: { storyboard: true },
  });
  assert.ok(foreign.issues.includes('owner_chat_mismatch'));
  assert.ok(foreign.issues.includes('ledger_entry_mismatch'));
  assert.equal(canConsumeDirectorDecision(foreign.decision, 'storyboard', 'chat-b'), false);
});

test('failed confirmation returns no approved object that another consumer could accidentally use', () => {
  const options = { chatKey: 'chat-a', ledgerEntryId: 'simulation-packet-a', explicitApproval: true, approvedAt: 100, outputs: { storyboard: true, voice: true, subtitle: true, film: true } };
  const cases = [
    [candidate(), packet(), { ...options, explicitApproval: false }],
    [candidate({ recommendation: 'reject' }), packet(), options],
    [candidate(), packet(), { ...options, ledgerEntryId: 'wrong-entry' }],
    [candidate(), packet({ timelineAnchor: { chatKey: 'chat-b' } }), options],
    [candidate(), packet({ packetId: '' }), options],
    [candidate(), packet(), { ...options, outputs: {} }],
  ];
  for (const [rawCandidate, rawPacket, config] of cases) {
    const result = createDirectorDecision(rawCandidate, rawPacket, config);
    assert.equal(result.ok, false);
    for (const consumer of ['storyboard', 'voice', 'subtitle', 'film']) {
      assert.equal(canConsumeDirectorDecision(result.decision, consumer, 'chat-a'), false);
      const dispatch = createDirectorWorkOrder(result.decision, consumer, 'chat-a', { createdAt: 200 });
      assert.equal(dispatch.ok, false);
      assert.equal(canConsumeDirectorWorkOrder(dispatch.workOrder, consumer, 'chat-a'), false);
    }
    assert.equal(result.decision, null);
  }
});

test('candidate gates cannot be bypassed by changing the recommendation or by explicit approval', () => {
  const options = { chatKey: 'chat-a', ledgerEntryId: 'simulation-packet-a', explicitApproval: true, approvedAt: 100, outputs: { storyboard: true } };
  for (const gate of ['sourceValid', 'factConsistency', 'shotDistinct']) {
    const result = createDirectorDecision(candidate({ gates: { ...candidate().gates, [gate]: false } }), packet(), options);
    assert.equal(result.ok, false, gate);
    assert.ok(result.issues.includes('candidate_gate_failed'));
    assert.equal(result.decision, null);
  }
  const invalidAuto = createDirectorDecision(candidate({ recommendation: 'automatic' }), packet(), options);
  assert.equal(invalidAuto.ok, false, 'automatic candidates must also be safe for the reader');
  const automatic = candidate({ sourceKind: 'prose', recommendation: 'automatic', gates: { ...candidate().gates, spoilerSafe: true } });
  assert.equal(createDirectorDecision(automatic, packet(), { ...options, explicitApproval: false }).ok, false, 'never fabricate explicit approval');
  assert.equal(createDirectorDecision(automatic, packet(), options).ok, true);
  const future = createDirectorDecision(candidate({ schema: 'qianmu.director-candidate.v999' }), packet(), options);
  assert.equal(future.ok, false);
  assert.ok(future.issues.includes('candidate_schema_unsupported'));
  assert.equal(future.decision, null);
  const misleading = createDirectorDecision(candidate({ gates: { ...candidate().gates, sourceValid: 'false' } }), packet(), options);
  assert.equal(misleading.ok, false);
});

test('unknown decision schemas cannot be dispatched while schema-less legacy decisions remain usable', () => {
  const { decision } = createDirectorDecision(candidate(), packet(), { chatKey: 'chat-a', ledgerEntryId: 'simulation-packet-a', explicitApproval: true, approvedAt: 100 });
  const legacy = structuredClone(decision);
  delete legacy.schema;
  assert.equal(canConsumeDirectorDecision(legacy, 'storyboard', 'chat-a'), true);
  const future = { ...decision, schema: 'qianmu.director-decision.v999' };
  assert.equal(canConsumeDirectorDecision(future, 'storyboard', 'chat-a'), false);
  const result = createDirectorWorkOrder(future, 'storyboard', 'chat-a', { createdAt: 200 });
  assert.equal(result.ok, false);
  assert.equal(result.workOrder, null);
});

test('revocation immediately closes every downstream consumer', () => {
  const result = createDirectorDecision(candidate(), packet(), {
    chatKey: 'chat-a', ledgerEntryId: 'simulation-packet-a', explicitApproval: true, approvedAt: 100,
    outputs: { storyboard: true, subtitle: true, film: true },
  });
  const revoked = revokeDirectorDecision(result.decision, 200);
  assert.equal(revoked.status, 'revoked');
  assert.equal(revoked.approval.revision, 2);
  assert.equal(validateDirectorDecision(revoked).ok, true);
  assert.equal(canConsumeDirectorDecision(revoked, 'storyboard', 'chat-a'), false);
  assert.equal(canConsumeDirectorDecision(revoked, 'subtitle', 'chat-a'), false);
  assert.equal(canConsumeDirectorDecision(revoked, 'film', 'chat-a'), false);
});

test('decision normalization keeps only bounded creative lanes and stable references', () => {
  const result = createDirectorDecision(candidate(), packet(), {
    chatKey: 'chat-a', ledgerEntryId: 'simulation-packet-a', explicitApproval: true, outputs: { storyboard: true },
  });
  const normalized = normalizeDirectorDecision({
    ...result.decision, prompt: 'secret prompt', apiKey: 'secret', url: 'https://example.invalid',
    blob: new Blob(['x']), providerResponse: { raw: true },
  });
  assert.match(normalized.lanes.visual.description, /Alice/);
  assert.deepEqual(normalized.lanes.dialogue, ['Alice：到此为止。']);
  assert.doesNotMatch(JSON.stringify(normalized), /secret prompt|secret|example\.invalid|providerResponse|blob/);
});

test('world-side storyboard generation creates and consumes the decision before compiling prompts', async () => {
  const source = await readFile(new URL('../index.js', import.meta.url), 'utf8');
  const generate = source.slice(source.indexOf('async function storyboardGenerateProductionPacket'), source.indexOf('async function storyboardGenerate(root'));
  assert.match(generate, /featureRuntime\.load\('directorDecision'\)/);
  assert.match(generate, /createDirectorDecision\(candidate, packet/);
  assert.match(generate, /canConsumeDirectorDecision\(result\.decision, 'storyboard', currentChatKey\)/);
  assert.ok(generate.indexOf('createDirectorDecision(candidate, packet') < generate.indexOf('compileStoryboardPrompt'));
  assert.match(generate, /createDirectorWorkOrder\(decision, 'storyboard', currentChatKey/);
  assert.match(generate, /directorWorkOrderToStoryboardShot\(workOrder, currentChatKey\)/);
  const commonGenerate = source.slice(source.indexOf('async function storyboardGenerate(root'), source.indexOf('async function storyboardRunQueuedJob'));
  assert.match(commonGenerate, /productionDraft[\s\S]*decisionStatus !== 'approved'/);
});

test('approved decision identity survives storyboard shot normalization', () => {
  const result = createDirectorDecision(candidate(), packet(), {
    chatKey: 'chat-a', ledgerEntryId: 'simulation-packet-a', explicitApproval: true, approvedAt: 100,
    outputs: { storyboard: true },
  });
  const shot = adaptProductionPacketToStoryboardShotSpec(packet(), {
    productionContext: {
      packetId: 'packet-a', eventId: 'event-a', track: 'second_camera', canonLevel: 'director', autoInsert: false,
      decisionId: result.decision.decisionId, decisionStatus: result.decision.status, truthMode: result.decision.truthMode,
    },
  });
  assert.deepEqual(storyboardProductionContext(shot), {
    packetId: 'packet-a', eventId: 'event-a', track: 'second_camera', canonLevel: 'director', autoInsert: false,
    decisionId: result.decision.decisionId, decisionStatus: 'approved', truthMode: 'speculative',
  });
});

test('director decision stays lazy and ships in the release boundary', async () => {
  const source = await readFile(new URL('../index.js', import.meta.url), 'utf8');
  const release = JSON.parse(await readFile(new URL('../release-files.json', import.meta.url), 'utf8'));
  const {version}=JSON.parse(await readFile(new URL('../manifest.json',import.meta.url),'utf8'));
  assert.match(source, /directorDecision:\s*\{[\s\S]*import\('\.\/qianmu-director-decision\.js\?v=\d+\.\d+\.\d+'\)/);
  assert.ok(source.includes(`import('./qianmu-director-decision.js?v=${version}')`));
  const init = source.slice(source.indexOf('function init()'), source.indexOf('function cleanupRuntime'));
  assert.doesNotMatch(init, /featureRuntime\.load\('directorDecision'\)/);
  assert.ok(release.files.includes('qianmu-director-decision.js'));
});
