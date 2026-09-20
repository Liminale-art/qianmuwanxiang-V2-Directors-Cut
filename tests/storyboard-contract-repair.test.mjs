import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  STORYBOARD_CONTRACT_REPAIR_MAX_BYTES,
  STORYBOARD_PLAN_RESPONSE_SCHEMA_ID,
  buildStoryboardContractRepairMessages,
  createStoryboardContractManualFallback,
  parseStoryboardContractResponse,
  repairStoryboardContractOnce,
} from '../qianmu-storyboard-contract.js';

const validPlan = {
  schema: STORYBOARD_PLAN_RESPONSE_SCHEMA_ID,
  should_generate: true,
  skip_reason: '',
  shots: [{
    source_paragraph_ids: ['P1'],
    insert_after: 'P1',
    narrative_layer: 'present',
    narrative_purpose: '交代雨夜空间',
    shot_role: 'establishing',
    shot_scale: 'wide_shot',
    subject: '雨夜的空房间',
    scene: { location: '房间', time: '夜晚', lighting: ['窗外冷光'], environment: ['雨痕'] },
    characters: [],
    shared_relations: [],
    composition: { ratio_id: '3:2', orientation: 'landscape', camera_side: 'axis-side-a', angle: 'eye-level', focus: '人物与房间纵深', negative_space: '', intent: '保留环境纵深', continuity_key: 'room-night' },
    prompt_atoms: { global: ['rainy room'], character_ids: [], scene_negative: ['people'] },
    sensitive: false,
    safety_notes: [],
  }],
  continuity_updates: [],
  decisions: ['建立场景'],
};

const options = {
  kind: 'plan',
  allowedParagraphIds: ['P1'],
  allowedRatioIds: ['3:2'],
  maxShots: 1,
};

const malformed = '{"schema":"qianmu.storyboard.plan.v1" "should_generate":true}';
const initial = parseStoryboardContractResponse(malformed, options);
assert.equal(initial.ok, false);

const missingCommaPlan = JSON.stringify(validPlan).replace(',"should_generate"', ' "should_generate"');
const locallyCommaRepaired = parseStoryboardContractResponse(missingCommaPlan, options);
assert.equal(locallyCommaRepaired.ok, true);
assert.ok(locallyCommaRepaired.normalization.includes('missing_comma'));

const trailingCommaPlan = JSON.stringify(validPlan).replace('"decisions":["建立场景"]}', '"decisions":["建立场景"],}');
const locallyTrailingRepaired = parseStoryboardContractResponse(trailingCommaPlan, options);
assert.equal(locallyTrailingRepaired.ok, true);
assert.ok(locallyTrailingRepaired.normalization.includes('trailing_comma'));

const repairMessages = buildStoryboardContractRepairMessages(malformed, initial, options);
assert.equal(repairMessages.length, 2);
assert.equal(repairMessages[0].role, 'system');
assert.match(repairMessages[0].content, /不得续写/);
const repairPayload = JSON.parse(repairMessages[1].content);
assert.equal(repairPayload.target_schema, STORYBOARD_PLAN_RESPONSE_SCHEMA_ID);
assert.equal(repairPayload.original_response, malformed);
assert.deepEqual(Object.keys(repairPayload).sort(), ['original_response', 'target_schema', 'validation_errors']);
assert.ok(repairPayload.validation_errors.every((entry) => !Object.hasOwn(entry, 'context')), 'repair payload must not carry prose context');

let calls = 0;
const repaired = await repairStoryboardContractOnce({
  raw: malformed,
  validation: initial,
  options,
  request: async (messages) => {
    calls += 1;
    assert.deepEqual(messages, repairMessages);
    return JSON.stringify(validPlan);
  },
});
assert.equal(calls, 1);
assert.equal(repaired.ok, true);
assert.equal(repaired.repairAttempted, true);
assert.equal(repaired.repairCalls, 1);
assert.equal(repaired.data.shots[0].insert_after, 'P1');
assert.ok(repaired.originalErrors.some((entry) => entry.code === 'required'));

calls = 0;
const failedRepair = await repairStoryboardContractOnce({
  raw: malformed,
  validation: initial,
  options,
  request: async () => {
    calls += 1;
    return '{still invalid';
  },
});
assert.equal(calls, 1, 'a failed repair must never recurse');
assert.equal(failedRepair.ok, false);
assert.equal(failedRepair.requiresRepair, false);
assert.equal(failedRepair.repairCalls, 1);

calls = 0;
const alreadyValid = await repairStoryboardContractOnce({
  raw: JSON.stringify(validPlan),
  options,
  request: async () => { calls += 1; return ''; },
});
assert.equal(alreadyValid.ok, true);
assert.equal(alreadyValid.repairCalls, 0);
assert.equal(calls, 0, 'valid JSON must not spend a repair call');

calls = 0;
const locallyRepairedWithoutRequest = await repairStoryboardContractOnce({
  raw: missingCommaPlan,
  options,
  request: async () => { calls += 1; return ''; },
});
assert.equal(locallyRepairedWithoutRequest.ok, true);
assert.equal(locallyRepairedWithoutRequest.repairCalls, 0);
assert.equal(calls, 0, 'deterministic local normalization must run before a paid repair call');

calls = 0;
const oversized = await repairStoryboardContractOnce({
  raw: `{"schema":"${STORYBOARD_PLAN_RESPONSE_SCHEMA_ID}","padding":"${'x'.repeat(STORYBOARD_CONTRACT_REPAIR_MAX_BYTES)}"}`,
  options,
  request: async () => { calls += 1; return ''; },
});
assert.equal(oversized.repairAttempted, false);
assert.equal(oversized.repairSkipped, 'unsafe_or_oversized');
assert.equal(calls, 0, 'oversized output must not be echoed into another paid request');

const requestFailure = await repairStoryboardContractOnce({
  raw: malformed,
  validation: initial,
  options,
  request: async () => { throw new Error('offline'); },
});
assert.equal(requestFailure.repairCalls, 1);
assert.equal(requestFailure.errors[0].code, 'repair_request_failed');
assert.match(requestFailure.errors[0].message, /offline/);

const fallback = createStoryboardContractManualFallback({
  floor: 12,
  paragraphs: ['较早段落', '她把湿透的信按在桌上，雨声骤然加重。'],
  forcedParagraphIndex: 1,
}, { ratioId: '3:2' });
assert.equal(fallback.manualRequired, true);
assert.equal(fallback.shots.length, 1);
assert.equal(fallback.paragraphIndex, 1);
assert.equal(fallback.shots[0].shotSpec.insertAfter, 'P2');
assert.equal(fallback.shots[0].shotSpec.composition.ratioId, '3:2');
assert.match(fallback.prompt, /湿透的信/);
assert.doesNotMatch(JSON.stringify(fallback), /still invalid|offline/, '手动草稿只能来自可信正文，不能复用失败模型输出');

const indexSource = await readFile(new URL('../index.js', import.meta.url), 'utf8');
const resultSource = await readFile(new URL('../qianmu-storyboard-compiler-result.js', import.meta.url), 'utf8');
assert.match(indexSource, /return runtime\.resolveStoryboardCompilerResult\(raw,context,capabilities,state,contractRequest,inputGuard,/, 'the actual compiler delegates to the lazy result processor');
assert.match(resultSource, /initial\.ok \? initial : focused\s*\?[\s\S]*: await contract\.repairStoryboardContract\(/, 'the focused stages cannot fall through to a second independent repair budget');
assert.match(await readFile(new URL('../qianmu-storyboard-compiler-transport.js',import.meta.url),'utf8'), /source=requestOptions\.temperature\?\?profile\?\.temperature\?\?0\.35/, 'ordinary compiler calls must retain the saved profile temperature');
assert.match(resultSource, /request: async \(messages\) => \{[\s\S]*await context\.casting\?\.assertCurrent\(\);[\s\S]*repairMessages = messages;\s*return \(inputGuard\?\.compilerAttempt\?\.call\|\|storyboardCallCompiler\)\(messages,[\s\S]*temperature: 0,[\s\S]*maxTokens: contractRequest\?\.maxTokens \|\| 1800/, 'paid repair verifies identity, retains messages and passes through request diagnostics');
assert.match(resultSource, /initialErrors:[\s\S]*finalErrors:/, 'repair diagnostics must remain attached to the compiler stage');
assert.match(resultSource, /localNormalization: \(result\.normalization \|\| \[\]\)\.slice\(0, 8\)/, 'deterministic local repairs must be visible in bounded diagnostics');
assert.match(resultSource, /if \(!result\.ok\) throw contract\.storyboardContractFailure\(result\)/, '格式失败明确停止，不将失败结果伪装为静帧候选');
assert.match(indexSource, /plan\.manualReviewRequired = manualRequired[\s\S]*plan\.autoGenerate = false/, '合同失败不得继续自动生图');
assert.match(indexSource, /return !manualRequired/, '自动调用方必须收到停止信号');

console.log('Storyboard one-shot contract repair OK');
