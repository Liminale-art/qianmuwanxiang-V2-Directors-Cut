import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  QIANMU_DIRECTOR_CANDIDATE_POOL_SCHEMA,
  buildNarrativeDirectorCandidatePool,
  normalizeDirectorCandidate,
  scoreNarrativeDirectorCandidate,
} from '../qianmu-director-candidate.js';

const fact = (overrides = {}) => ({
  owner: { chatKey: 'chat-a' },
  source: { kind: 'prose', authority: 'canon', recordId: 'message-10', floor: 10 },
  fact: { subjectIds: ['alice'], summary: 'Alice 把烧焦的来信藏进红外套。' },
  temporalState: 'present',
  confidence: { state: 'confirmed', score: 1 },
  readerVisibility: { scope: 'mainline' },
  continuity: { state: 'active' },
  evidenceRefs: ['paragraph-2'],
  ...overrides,
});

test('visible active prose facts pass all director gates with deterministic dimensions', () => {
  const result = scoreNarrativeDirectorCandidate(fact(), {
    chatKey: 'chat-a', viewerId: 'user', currentFloor: 11,
    directionByEntryId: {}, recentShotSignatures: ['wide kitchen two shot'],
  });
  assert.equal(result.gates.sourceValid, true);
  assert.equal(result.gates.factConsistency, true);
  assert.equal(result.gates.spoilerSafe, true);
  assert.equal(result.gates.shotDistinct, true);
  assert.equal(result.dimensions.continuityRisk, 10);
  assert.equal(result.dimensions.rhythmDistance, 12);
  assert.equal(result.recommendation, 'automatic');
  assert.ok(result.total > 0 && result.total <= 100);
});

test('unknown source floors keep neutral rhythm distance instead of assuming the first floor', () => {
  for (const floor of [undefined, null, '', '  ', false, [], {}]) {
    const result = scoreNarrativeDirectorCandidate(fact({ source: { ...fact().source, floor } }), { chatKey: 'chat-a', currentFloor: 0 });
    assert.equal(result.dimensions.rhythmDistance, 50, `source floor: ${String(floor)}`);
    assert.equal(result.gates.sourceValid, true, 'a record may have an ID without a floor');
  }
});

test('missing or invalid current floors keep neutral rhythm distance across context aliases', () => {
  for (const key of ['currentFloor', 'current_floor']) {
    for (const floor of [undefined, null, '', '  ', false, true, [], [0], {}, -1, .5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1]) {
      const result = scoreNarrativeDirectorCandidate(fact(), { chatKey: 'chat-a', [key]: floor });
      assert.equal(result.dimensions.rhythmDistance, 50, `${key}: ${String(floor)}`);
    }
  }
});

test('valid zero and numeric-string floors retain deterministic rhythm scoring', () => {
  for (const [sourceFloor, currentFloor, expected] of [[0, 0, 0], ['0', '1', 12], [10, '11', 12], ['12', 10, 24]]) {
    const result = scoreNarrativeDirectorCandidate(fact({ source: { ...fact().source, floor: sourceFloor } }), { chatKey: 'chat-a', currentFloor });
    assert.equal(result.dimensions.rhythmDistance, expected);
  }
});

test('simulation stays in manual review even when its narrative value is high', () => {
  const simulation = fact({
    source: { kind: 'simulation', authority: 'possibility', recordId: 'plan-4', floor: 11 },
    confidence: { state: 'possible', score: .6 },
    readerVisibility: { scope: 'director_only' },
  });
  const normalized = scoreNarrativeDirectorCandidate(simulation, {
    chatKey: 'chat-a', currentFloor: 11,
    directionByEntryId: { },
  });
  assert.equal(normalized.sourceKind, 'simulation');
  assert.equal(normalized.gates.spoilerSafe, false);
  assert.equal(normalized.dimensions.spoilerRisk, 100);
  assert.equal(normalized.recommendation, 'manual_review');
  assert.ok(normalized.blockers.includes('reader_visibility_unconfirmed'));
});

test('invalid sources cannot acquire a safe visibility gate from normalized prose defaults', () => {
  for (const entry of [
    fact({ source: { ...fact().source, authority: 'possibility' } }),
    fact({ owner: { chatKey: 'chat-b' } }),
    fact({ schema: 'qianmu.narrative-entry.v999' }),
  ]) {
    const result = scoreNarrativeDirectorCandidate(entry, { chatKey: 'chat-a', viewerId: 'user' });
    assert.equal(result.gates.sourceValid, false);
    assert.equal(result.gates.spoilerSafe, false);
    assert.equal(result.dimensions.spoilerRisk, 100);
    assert.equal(result.recommendation, 'reject');
    assert.ok(result.blockers.some(issue => issue.startsWith('source:')));
  }
});

test('contradicted or near-duplicate shots are rejected instead of filling a shot quota', () => {
  const entry = fact({ entryId: 'coat-fact' });
  const contradicted = scoreNarrativeDirectorCandidate(entry, { chatKey: 'chat-a', contradictedEntryIds: ['coat-fact'] });
  assert.equal(contradicted.gates.factConsistency, false);
  assert.equal(contradicted.dimensions.continuityRisk, 100);
  assert.equal(contradicted.recommendation, 'reject');
  const duplicate = scoreNarrativeDirectorCandidate(entry, {
    chatKey: 'chat-a',
    directionByEntryId: { 'coat-fact': { shotSignature: 'Alice red coat letter closeup' } },
    recentShotSignatures: ['Alice red coat letter closeup'],
  });
  assert.equal(duplicate.dimensions.shotNovelty, 0);
  assert.equal(duplicate.gates.shotDistinct, false);
  assert.equal(duplicate.recommendation, 'reject');
});

test('candidate pools are bounded, ranked and retain rejected audit reasons', () => {
  const entries = Array.from({ length: 125 }, (_, index) => fact({
    entryId: `fact-${index}`,
    source: { ...fact().source, recordId: `message-${index}`, floor: index },
    fact: { summary: `叙事事实 ${index}` },
  }));
  const pool = buildNarrativeDirectorCandidatePool(entries, { chatKey: 'chat-a', viewerId: 'user', currentFloor: 124 });
  assert.equal(pool.schema, QIANMU_DIRECTOR_CANDIDATE_POOL_SCHEMA);
  assert.equal(pool.candidates.length, 120);
  assert.ok(pool.candidates.every((item, index, all) => index === 0 || all[index - 1].total >= item.total));
  assert.equal(pool.summary.automatic + pool.summary.manualReview + pool.summary.rejected, 120);
});

test('candidate normalization strips media, prompts and provider payloads', () => {
  const normalized = normalizeDirectorCandidate({
    candidateId: 'candidate-a', owner: { chatKey: 'chat-a' }, entryId: 'fact-a', recommendation: 'automatic',
    factDigest: '门外雨声', prompt: 'secret prompt', apiKey: 'secret', url: 'https://example.invalid',
    blob: new Blob(['x']), providerResponse: { result: 'raw' },
  });
  assert.doesNotMatch(JSON.stringify(normalized), /secret prompt|secret|example\.invalid|providerResponse|raw/);
});

test('candidate permission gates require actual booleans rather than truthy strings or objects', () => {
  for (const value of ['false', 'true', 1, [], {}, null, undefined]) {
    const gates = Object.fromEntries(['sourceValid', 'factConsistency', 'spoilerSafe', 'shotDistinct'].map(key => [key, value]));
    assert.deepEqual(normalizeDirectorCandidate({ gates }).gates, { sourceValid: false, factConsistency: false, spoilerSafe: false, shotDistinct: false });
  }
  assert.deepEqual(normalizeDirectorCandidate({ gates: { source_valid: true, fact_consistency: true, spoiler_safe: true, shot_distinct: true } }).gates,
    { sourceValid: true, factConsistency: true, spoilerSafe: true, shotDistinct: true });
});

test('director candidate scoring remains an idle release chunk', async () => {
  const source = await readFile(new URL('../index.js', import.meta.url), 'utf8');
  const release = JSON.parse(await readFile(new URL('../release-files.json', import.meta.url), 'utf8'));
assert.match(source, /directorCandidates:\s*\{[\s\S]*import\('\.\/qianmu-director-candidate\.js\?v=1\.59\.202'\)/);
  const init = source.slice(source.indexOf('function init()'), source.indexOf('function destroy()'));
  assert.doesNotMatch(init, /featureRuntime\.load\('directorCandidates'\)/);
  assert.ok(release.files.includes('qianmu-director-candidate.js'));
});
