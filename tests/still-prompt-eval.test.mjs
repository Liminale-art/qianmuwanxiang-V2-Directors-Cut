import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, writeFile, rm, readFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {STILL_PROMPT_CASES, getStillPromptCase} from '../evaluation/still-prompts/cases.mjs';
import {emptyTranscript, validateTranscript, evaluateStillCase, auditStillCorpus, readEvaluationTranscript, MAX_TRANSCRIPT_BYTES} from '../scripts/still-prompt-eval.mjs';
import {authoredNarrative, authoredExpression} from './helpers/still-evaluation-fixture.mjs';
import {collectReleaseFiles} from '../scripts/build-release.mjs';

async function append(transcript, raw, metrics = {}) {
  const report = await evaluateStillCase(transcript.caseId, transcript);
  assert.equal(report.status, 'awaiting_response', JSON.stringify(report.failure));
  assert.ok(report.nextRequest);
  transcript.responses.push({requestDigest: report.nextRequest.requestDigest, raw: typeof raw === 'string' ? raw : JSON.stringify(raw), ...metrics});
  return report.nextRequest;
}
async function completed(id, metrics) {
  const transcript = emptyTranscript(id), narrative = authoredNarrative(id);
  await append(transcript, narrative, metrics);
  if (narrative.should_generate) await append(transcript, authoredExpression(id), metrics);
  return {transcript, report: await evaluateStillCase(id, transcript)};
}

test('eleven synthetic scenarios retain their chosen range, including all six kitchen shots', async () => {
  const result = await auditStillCorpus();
  assert.equal(result.cases.length, 11); assert.equal(new Set(result.cases.map(row => row.caseId)).size, 11);
  assert.equal(result.networkCalls, 0); assert.equal(result.releaseQualified, false);
  const six = result.cases.find(row => row.caseId === 'kitchen-six');
  assert.equal(six.status, 'awaiting_response'); assert.equal(six.effectiveMaxShots, 6); assert.deepEqual(six.desiredShots, {min: 6, max: 6});
  assert.match(six.requestDigest, /^[a-f0-9]{64}$/); assert.equal(result.cases.filter(row => row.status === 'awaiting_response').length, 11);
  assert.deepEqual(getStillPromptCase('kitchen-six').texts, getStillPromptCase('kitchen-three').texts);
});

for (const sample of STILL_PROMPT_CASES) test(`actual two-stage replay of authored fixture: ${sample.id}`, async () => {
  const {report} = await completed(sample.id);
  assert.equal(report.status, 'structurally_valid', JSON.stringify(report.failure));
  assert.equal(report.result.plan.shots.length, authoredNarrative(sample.id).shots.length);
  assert.equal(report.result.repairCalls, 0); assert.equal(report.releaseQualified, false);
  assert.equal(report.realModelQuality, 'not_established'); assert.equal(report.semanticReview.status, 'not_reviewed');
  assert.equal(report.metrics.totalTokens, null); assert.equal(report.metrics.modelLatencyMs, null); assert.equal(report.metrics.cost, null);
  assert.equal(report.syntheticMetadataSaves, sample.stream ? 0 : 1);
});

test('stage handoff keeps complete source only in narrative and carries verified continuity facts', async () => {
  const id = 'continuity', transcript = emptyTranscript(id), initial = await append(transcript, authoredNarrative(id));
  const first = JSON.stringify(JSON.parse(initial.messages[1].content));
  for (const text of getStillPromptCase(id).texts) assert.ok(first.includes(text));
  const report = await evaluateStillCase(id, transcript), second = JSON.parse(report.nextRequest.messages[1].content);
  assert.deepEqual(second.shots[0].active_state.map(row => row.value), ['removed', 'blue cup in right hand']);
  assert.equal(report.metrics.firstPass.narrative, true); assert.equal(report.metrics.firstPass.expression, null);
  assert.doesNotMatch(report.nextRequest.messages[1].content, /合成世界|合成角色|柏宁问他茶是否太烫/);
});

test('long selected text and current tail survive complete request; USER is not dropped', async () => {
  const report = await evaluateStillCase('long-window'), payload = JSON.parse(report.nextRequest.messages[1].content);
  const sent = JSON.stringify(payload);
  assert.deepEqual(payload.source_catalogue.map(row => row.passages.map(part => part.text).join('')), getStillPromptCase('long-window').texts);
  assert.equal(payload.source_catalogue[1].role, 'user');
  assert.match(sent, /CORPUS_TAIL_9217/);
});

test('streaming request captures tail but permits only the closed paragraph', async () => {
  const report = await evaluateStillCase('stream-ready'), payload = JSON.parse(report.nextRequest.messages[1].content);
  assert.deepEqual(payload.constraints.streaming.closed_target_paragraph_ids, ['P1']);
  assert.equal(payload.constraints.min_shots_target, 0); assert.match(report.nextRequest.messages[1].content, /他听到门外传来/);
});

test('request digests are reproducible, stage/order/corpus bound and do not accept altered records', async () => {
  const id = 'contact', first = await evaluateStillCase(id), again = await evaluateStillCase(id);
  assert.equal(first.nextRequest.requestDigest, again.nextRequest.requestDigest);
  const {transcript} = await completed(id);
  const reversed = structuredClone(transcript); reversed.responses.reverse();
  await assert.rejects(evaluateStillCase(id, reversed), /请求\/阶段\/修复顺序/);
  for (const key of ['schema', 'corpusRevision', 'caseId', 'caseDigest']) {
    const bad = structuredClone(transcript); bad[key] = 'foreign'; assert.throws(() => validateTranscript(bad, id), /不一致/);
  }
  const extra = structuredClone(transcript); extra.responses.push(extra.responses[1]);
  await assert.rejects(evaluateStillCase(id, extra), /多余返回/);
});

test('shared three-repair budget spans stages; missing recording is resumable, not a provider failure', async () => {
  const id = 'contact', transcript = emptyTranscript(id);
  await append(transcript, '{bad');
  const waiting = await evaluateStillCase(id, transcript);
  assert.equal(waiting.status, 'awaiting_response'); assert.equal(waiting.nextRequest.repair, true);
  assert.equal(waiting.metrics.firstPass.narrative, false);
  await append(transcript, authoredNarrative(id)); // First repair.
  await append(transcript, '{broken-expression');
  await append(transcript, '{still-broken'); // Second repair.
  await append(transcript, authoredExpression(id)); // Third repair, not another three per stage.
  const report = await evaluateStillCase(id, transcript);
  assert.equal(report.status, 'structurally_valid'); assert.equal(report.result.repairCalls, 3);
  assert.equal(report.metrics.consumedCalls, 5); assert.equal(report.metrics.consumedRepairCalls, 3);
  assert.deepEqual(report.metrics.firstPass, {narrative: false, expression: false});
});

test('exhausted narrative repair stops after three, with no expression or fabricated success', async () => {
  const transcript = emptyTranscript('contact');
  for (let i = 0; i < 4; i++) await append(transcript, '{invalid');
  const report = await evaluateStillCase('contact', transcript);
  assert.equal(report.status, 'contract_failed'); assert.equal(report.failure.stage, 'narrative');
  assert.equal(report.metrics.consumedRepairCalls, 3); assert.equal(report.result, null);
});

for (const raw of ['', 'x'.repeat(70 * 1024)]) test(`unsafe output stops without repair (${raw.length} chars)`, async () => {
  const transcript = emptyTranscript('contact'); await append(transcript, raw);
  const report = await evaluateStillCase('contact', transcript);
  assert.equal(report.status, 'contract_failed'); assert.equal(report.metrics.consumedCalls, 1); assert.equal(report.nextRequest, null);
});

test('recorded metrics stay explicitly unverified; partial metrics never silently become zero', async () => {
  const measured = {usage: {inputTokens: 10, outputTokens: 5, totalTokens: 15}, latencyMs: 12.5};
  const {transcript, report} = await completed('contact', measured);
  assert.equal(report.metrics.totalTokens, 30); assert.equal(report.metrics.modelLatencyMs, 25);
  assert.match(report.metrics.metricSource, /not_independently_verified/);
  delete transcript.responses[1].usage; delete transcript.responses[1].latencyMs;
  const partial = await evaluateStillCase('contact', transcript);
  assert.equal(partial.metrics.totalTokens, null); assert.equal(partial.metrics.modelLatencyMs, null);
});

test('untrusted transcript fields, counts, sizes and claimed metrics are rejected', async () => {
  const base = emptyTranscript('contact'), row = {requestDigest: 'a'.repeat(64), raw: '{}'};
  for (const change of [v => { v.apiKey = 'not-a-key'; }, v => { v.responses = Array(6).fill(row); },
    v => { v.responses = [{...row, raw: 3}]; }, v => { v.responses = [{...row, raw: 'x'.repeat(1024 * 1024 + 1)}]; },
    v => { v.responses = [{...row, usage: {inputTokens: -1}}]; }, v => { v.responses = [{...row, latencyMs: -1}]; },
    v => { v.responses = [{...row, usage: {inputTokens: 1, outputTokens: 2, totalTokens: 9}}]; },
    v => { v.responses = [{...row, usage: {cost: 0}}]; }]) {
    const value = structuredClone(base); change(value); assert.throws(() => validateTranscript(value, 'contact'));
  }
  const six = emptyTranscript('kitchen-six'); six.responses = [row];
  await assert.rejects(evaluateStillCase('kitchen-six', six), /请求\/阶段\/修复顺序/);
});

test('bounded local file reader accepts complete records and rejects oversized / invalid UTF8', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'qianmu-still-eval-'));
  try {
    const filename = path.join(dir, 'record.json'), value = emptyTranscript('contact');
    await writeFile(filename, JSON.stringify(value)); assert.deepEqual(await readEvaluationTranscript(filename, 'contact'), value);
    await writeFile(filename, Buffer.from([0xff])); await assert.rejects(readEvaluationTranscript(filename, 'contact'));
    await writeFile(filename, 'x'.repeat(MAX_TRANSCRIPT_BYTES + 1)); await assert.rejects(readEvaluationTranscript(filename, 'contact'), /4 MiB/);
  } finally {
    assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(dir).startsWith('qianmu-still-eval-'));
    await rm(dir, {recursive: true, force: true});
  }
});

test('offline audit needs no network and produces no release assets', async () => {
  const oldFetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error('network is forbidden in evaluation'); };
  try { assert.equal((await auditStillCorpus()).cases.length, 11); assert.equal((await completed('contact')).report.status, 'structurally_valid'); }
  finally { globalThis.fetch = oldFetch; }
  const files = await collectReleaseFiles();
  assert.equal(files.some(file => file.startsWith('evaluation/') || file === 'scripts/still-prompt-eval.mjs'), false);
  const source = await readFile(new URL('../scripts/still-prompt-eval.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /process\.env|writeFile|fetch\(|https?:\/\//);
});

test('CLI rejects network flags and prepares six shots without changing runtime settings', () => {
  const script = new URL('../scripts/still-prompt-eval.mjs', import.meta.url);
  const run = args => spawnSync(process.execPath, [fileURLToPath(script), ...args], {encoding: 'utf8'});
  const six = run(['--case', 'kitchen-six']); assert.equal(six.status, 0, six.stderr); assert.equal(JSON.parse(six.stdout).effectiveMaxShots, 6);
  const bad = run(['--api', 'https://invalid.example']); assert.equal(bad.status, 1); assert.match(bad.stderr, /用法/);
});

test('syntax-only code fences use real normalization without consuming a model repair', async () => {
  const transcript = emptyTranscript('contact');
  await append(transcript, '```json\n' + JSON.stringify(authoredNarrative('contact')) + '\n```');
  await append(transcript, authoredExpression('contact'));
  const report = await evaluateStillCase('contact', transcript);
  assert.equal(report.status, 'structurally_valid'); assert.equal(report.result.repairCalls, 0);
  assert.equal(report.metrics.firstPass.narrative, true);
});

test('wrong paragraph evidence requests repair from production validators, not custom scoring', async () => {
  const transcript = emptyTranscript('contact'), narrative = authoredNarrative('contact');
  narrative.shots[0].state_point.evidence = '正文没有这一句';
  await append(transcript, narrative);
  const report = await evaluateStillCase('contact', transcript);
  assert.equal(report.status, 'awaiting_response'); assert.equal(report.nextRequest.stage, 'narrative');
  assert.equal(report.nextRequest.repair, true); assert.equal(report.metrics.firstPass.narrative, false);
});

test('semantically bad but shaped output never becomes a quality pass', async () => {
  const transcript = emptyTranscript('contact'), expression = authoredExpression('contact');
  expression.shots[0].prompt_renderings.tags.global = 'invented dragon in outer space';
  await append(transcript, authoredNarrative('contact')); await append(transcript, expression);
  const report = await evaluateStillCase('contact', transcript);
  assert.equal(report.status, 'structurally_valid'); assert.equal(report.semanticReview.status, 'not_reviewed');
  assert.equal(report.realModelQuality, 'not_established'); assert.equal(report.releaseQualified, false);
});

test('invalid second-stage digest is an input error, not a hidden expression-model failure', async () => {
  const {transcript} = await completed('contact');
  transcript.responses[1].requestDigest = 'b'.repeat(64);
  await assert.rejects(evaluateStillCase('contact', transcript), {code: 'evaluation_input'});
});

test('six expression IDs preserve narrative order even when their response rows arrive reversed', async () => {
  const transcript=emptyTranscript('kitchen-six'),expression=authoredExpression('kitchen-six');
  expression.shots.reverse();await append(transcript,authoredNarrative('kitchen-six'));await append(transcript,expression);
  const report=await evaluateStillCase('kitchen-six',transcript);
  assert.equal(report.status,'structurally_valid');assert.equal(report.result.repairCalls,0);
  assert.deepEqual(report.result.plan.shots.map(row=>row.insert_after),['P1','P2','P3','P4','P5','P6']);
});

test('expanded expression IDs still reject zero, padded, seventh and duplicated shot identifiers', async () => {
  for(const shot_id of ['S0','S06','S7','S1']){
    const transcript=emptyTranscript('kitchen-six'),expression=authoredExpression('kitchen-six');
    expression.shots[5].shot_id=shot_id;await append(transcript,authoredNarrative('kitchen-six'));await append(transcript,expression);
    const report=await evaluateStillCase('kitchen-six',transcript);
    assert.equal(report.status,'awaiting_response');assert.equal(report.nextRequest.stage,'expression');assert.equal(report.nextRequest.repair,true);
  }
});
