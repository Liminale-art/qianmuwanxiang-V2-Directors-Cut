// Maintainer-only offline replay. No provider client, fetch, ST file adapter,
// credentials, paid submission, or user-data discovery is used here.
import {createHash} from 'node:crypto';
import {open} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import * as contract from '../qianmu-storyboard-contract.js';
import {STORYBOARD_NARRATIVE_SCHEMA} from '../qianmu-storyboard-focused-extraction.js';
import {CORPUS_REVISION, STILL_PROMPT_CASES, getStillPromptCase} from '../evaluation/still-prompts/cases.mjs';

export const TRANSCRIPT_SCHEMA = 'qianmu.still-evaluation.transcript.v1';
export const MAX_TRANSCRIPT_BYTES = 4 * 1024 * 1024;
const clone = value => JSON.parse(JSON.stringify(value));
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const canonical = value => Array.isArray(value) ? value.map(canonical) : object(value)
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
export const evaluationDigest = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const fail = message => { throw Object.assign(new Error(message), {code: 'evaluation_input'}); };
const keys = (value, required, optional = []) => {
  if (!object(value) || required.some(key => !Object.hasOwn(value, key)) || Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) fail('评估记录字段不完整或含未支持字段');
};
const finiteCount = n => Number.isSafeInteger(n) && n >= 0;

export function emptyTranscript(id) {
  const sample = getStillPromptCase(id);
  return {schema: TRANSCRIPT_SCHEMA, corpusRevision: CORPUS_REVISION, caseId: id, caseDigest: evaluationDigest(sample), responses: []};
}

export function validateTranscript(value, id) {
  keys(value, ['schema', 'corpusRevision', 'caseId', 'caseDigest', 'responses']);
  const expected = emptyTranscript(id);
  for (const key of ['schema', 'corpusRevision', 'caseId', 'caseDigest']) if (value[key] !== expected[key]) fail('评估记录与当前合成语料不一致');
  if (!Array.isArray(value.responses) || value.responses.length > 5) fail('只接受两阶段和共享三次修复以内的记录');
  for (const row of value.responses) {
    keys(row, ['requestDigest', 'raw'], ['usage', 'latencyMs']);
    if (typeof row.requestDigest !== 'string' || !/^[0-9a-f]{64}$/.test(row.requestDigest) || typeof row.raw !== 'string' || Buffer.byteLength(row.raw) > 1024 * 1024) fail('返回原文或请求摘要无效');
    if (row.usage !== undefined) {
      keys(row.usage, [], ['inputTokens', 'outputTokens', 'totalTokens']);
      if (!Object.keys(row.usage).length || Object.values(row.usage).some(n => !finiteCount(n))) fail('token 实测计数无效');
      if (['inputTokens', 'outputTokens', 'totalTokens'].every(key => Object.hasOwn(row.usage, key)) && row.usage.totalTokens !== row.usage.inputTokens + row.usage.outputTokens) fail('token 总计不一致');
    }
    if (row.latencyMs !== undefined && (!Number.isFinite(row.latencyMs) || row.latencyMs < 0)) fail('实测耗时无效');
  }
  if (Buffer.byteLength(JSON.stringify(value)) > MAX_TRANSCRIPT_BYTES) fail('评估记录超过本地读取上限');
  return clone(value);
}

// One already-open file, bounded read, fatal UTF-8, no directory walks or writes.
export async function readEvaluationTranscript(filename, id) {
  const handle = await open(filename, 'r');
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size > MAX_TRANSCRIPT_BYTES) fail('请选择不超过 4 MiB 的评估 JSON 文件');
    const bytes = Buffer.alloc(before.size + 1); let length = 0;
    while (length < bytes.length) {
      const result = await handle.read(bytes, length, bytes.length - length, null);
      if (!result.bytesRead) break;
      length += result.bytesRead;
    }
    const after = await handle.stat();
    if (length !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) fail('读取期间评估文件发生变化');
    return validateTranscript(JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes.subarray(0, length))), id);
  } finally { await handle.close(); }
}

async function openCase(sample) {
  let active = true, saves = 0, window, store;
  const host = {chatId: `evaluation-${sample.id}`, characterId: 0,
    characters: [{avatar: 'synthetic-evaluation.png', chat: `evaluation-${sample.id}`}], chatMetadata: {story_director_liminale: {}},
    chat: sample.texts.map((mes, index) => ({mes, name: sample.roles[index] === 'user' ? '柏宁' : '阿岚', is_user: sample.roles[index] === 'user', send_date: String(index), ...(sample.stream ? {gen_started: 'synthetic-stream'} : {})})),
    async saveMetadata() { saves++; }};
  const floor = sample.texts.length - 1;
  const options = {floor, referenceFloors: floor, getContext: () => host, epoch: () => 0, isCurrent: () => active,
    resolveNamespace: async () => 'st-user:synthetic-evaluation', readText: message => message.mes,
    readParagraphs: message => message.mes.split('\n\n').filter(text => text.trim()).map((text, index) => ({id: `P${index + 1}`, text}))};
  const close = () => { active = false; store?.close(); window?.close(); };
  try {
    const streamFrame = sample.stream ? await contract.captureStoryboardStreamFrame(options) : null;
    if (sample.stream && !streamFrame) fail('流式合成窗口未建立，不回落为终稿');
    window = await contract.captureStoryboardCompilerSources({...options, streamFrame});
    store = contract.openStoryboardCompilerContinuity(window);
    const context = {floor, messages: window.messages, paragraphs: window.paragraphs, currentCharacter: sample.currentCharacter, persona: sample.persona, world: sample.world,
      compilerSources: window, continuity: await store.read()};
    const request = contract.buildStoryboardPlanContractRequest(context, {focused: true, providerId: 'novel', minShots: sample.minShots, maxShots: sample.maxShots,
      promptFormats: sample.promptFormats, allowedRatioIds: sample.allowedRatioIds});
    return {context, request, guard: window.guard, publish: records => store.publish(records), close, get saves() { return saves; }};
  } catch (error) { close(); throw error; }
}

function envelope(messages, definition) {
  const value = {stage: definition.schemaId === STORYBOARD_NARRATIVE_SCHEMA ? 'narrative' : 'expression', repair: definition.repair === true,
    messages: clone(messages), schemaId: definition.schemaId, schema: clone(definition.schema), maxTokens: definition.maxTokens,
    ...(definition.temperature !== undefined ? {temperature: definition.temperature} : {})};
  return {...value, requestDigest: evaluationDigest(value)};
}

// Missing recordings return the exact next request. They are not fabricated
// model failures, nor an invitation for this tool to contact a provider.
export async function evaluateStillCase(id, supplied = emptyTranscript(id)) {
  const sample = getStillPromptCase(id), transcript = validateTranscript(supplied, id), env = await openCase(sample);
  const report = {caseId: id, corpusRevision: CORPUS_REVISION, caseDigest: transcript.caseDigest,
    status: 'awaiting_response', desiredShots: {min: sample.minShots, max: sample.maxShots}, effectiveMaxShots: env.request.maxShots,
    semanticReview: {status: 'not_reviewed', checks: sample.checks}, realModelQuality: 'not_established', releaseQualified: false,
    calls: [], nextRequest: null, result: null, failure: null};
  let pending, inputError;
  const take = async (messages, definition) => {
    const next = envelope(messages, definition), row = transcript.responses[report.calls.length];
    if (!row) { pending = next; throw new Error('evaluation awaits recorded response'); }
    if (row.requestDigest !== next.requestDigest) { inputError = '记录对应的请求/阶段/修复顺序不一致'; fail(inputError); }
    report.calls.push({stage: next.stage, repair: next.repair, requestDigest: next.requestDigest,
      responseBytes: Buffer.byteLength(row.raw), usage: row.usage || null, latencyMs: row.latencyMs ?? null});
    return row.raw;
  };
  try {
    if (env.request.maxShots < sample.maxShots) {
      if (transcript.responses.length) fail('当前合同无法承接该镜头区间，不能回放缩减版本冒称通过');
      report.status = 'unsupported_shot_range';
    } else {
      try {
        const raw = await take(env.request.messages, env.request);
        const result = await contract.completeStoryboardFocusedExtraction({raw, context: env.context, request: env.request, guard: env.guard, publish: env.publish, call: take});
        report.status = 'structurally_valid';
        report.result = {plan: JSON.parse(result.raw), trace: clone(result.trace), stages: result.meta.stages,
          repairCalls: result.meta.repairCalls, persistence: result.meta.persistence};
      } catch (error) {
        if (inputError) fail(inputError);
        if (pending) report.nextRequest = pending;
        else if (error?.code === 'storyboard_contract_failed') {
          report.status = 'contract_failed'; report.failure = clone(error.diagnostic);
        } else throw error; // Infrastructure/test-tool defects are not model-quality failures.
      }
      if (report.calls.length !== transcript.responses.length) fail('记录含未被实际链路消费的多余返回');
    }
    const total = key => {
      if (!report.calls.length || report.calls.some(row => row.usage?.[key] === undefined)) return null;
      const value = report.calls.reduce((sum, row) => sum + row.usage[key], 0);
      if (!Number.isSafeInteger(value)) fail('token 汇总超出精确计数范围');
      return value;
    };
    const latency = report.calls.length && report.calls.every(row => row.latencyMs !== null) ? report.calls.reduce((sum, row) => sum + row.latencyMs, 0) : null;
    if (latency !== null && !Number.isFinite(latency)) fail('耗时汇总超出计数范围');
    report.metrics = {consumedCalls: report.calls.length, consumedRepairCalls: report.calls.filter(row => row.repair).length,
      inputTokens: total('inputTokens'), outputTokens: total('outputTokens'), totalTokens: total('totalTokens'),
      modelLatencyMs: latency,
      metricSource: 'optional_recorded_values_not_independently_verified', cost: null,
      firstPass: Object.fromEntries(['narrative', 'expression'].map(stage => [stage,
        report.calls.some(row => row.stage === stage && row.repair) || report.failure?.stage === stage || report.nextRequest?.stage === stage && report.nextRequest.repair ? false
          : report.result?.stages.some(row => row.stage === stage) || report.failure?.completedStages?.includes(stage) || stage === 'narrative' && report.nextRequest?.stage === 'expression' ? true : null]))};
    report.syntheticMetadataSaves = env.saves;
    return report;
  } finally { env.close(); }
}

export async function auditStillCorpus() {
  const rows = [];
  for (const sample of STILL_PROMPT_CASES) {
    const report = await evaluateStillCase(sample.id);
    rows.push({caseId: sample.id, title: sample.title, status: report.status, desiredShots: report.desiredShots, effectiveMaxShots: report.effectiveMaxShots,
      requestDigest: report.nextRequest?.requestDigest || null, semanticReview: 'not_reviewed'});
  }
  return {corpusRevision: CORPUS_REVISION, syntheticOnly: true, networkCalls: 0, releaseQualified: false, cases: rows};
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    let output;
    if (!args.length) output = await auditStillCorpus();
    else if ((args.length === 2 || args.length === 4) && args[0] === '--case' && (args.length === 2 || args[2] === '--responses')) {
      output = await evaluateStillCase(args[1], args.length === 4 ? await readEvaluationTranscript(args[3], args[1]) : emptyTranscript(args[1]));
      if (output.status === 'contract_failed' || output.status === 'unsupported_shot_range') process.exitCode = 2;
    } else fail('用法：node scripts/still-prompt-eval.mjs [--case 编号 [--responses 本地记录.json]]');
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error?.code === 'evaluation_input' ? error.message : '评估工具未完成，请核查本地记录与语料合同；不是模型质量结论'}\n`);
    process.exitCode = 1;
  }
}
