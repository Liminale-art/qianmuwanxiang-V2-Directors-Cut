import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  QIANMU_H3_PROMPT_MAX_CHARS,
  QIANMU_VIDEO_PROMPT_PLAN_SCHEMA_ID,
  QIANMU_VIDEO_PROMPT_RESPONSE_SCHEMA,
  buildVideoPromptPlanRequest,
  compileH3VideoPrompt,
  createVideoPromptPlanFromShotSpec,
  normalizeVideoPromptPlan,
  parseVideoPromptPlanResponse,
  validateVideoPromptPlan,
} from '../qianmu-video-prompt.js';

const shot = {
  durationSeconds: 6,
  intent: { summary: 'A opens the kitchen door while B keeps stirring.' },
  characters: [
    {
      characterId: 'a', name: 'A', subjectLabel: '<Subject 1>',
      appearance: { identity: ['red hair'], wardrobe: ['white shirt, coat removed'], physicalState: ['dry hair'] },
      performance: { blocking: 'left of frame', action: 'opens the door', expression: 'alert' },
    },
    {
      characterId: 'b', name: 'B', subjectLabel: '<Subject 2>',
      appearance: { identity: ['black hair'], wardrobe: ['blue apron'], physicalState: ['flour on hands'] },
      performance: { blocking: 'at the stove', action: 'keeps stirring', expression: 'calm' },
    },
  ],
};

const plan = {
  schema: QIANMU_VIDEO_PROMPT_PLAN_SCHEMA_ID,
  shot_summary: 'A enters; B continues cooking without turning around.',
  subjects: [
    { subject_id: 'a', name: 'A', reference_label: '<Subject 1>', identity: ['red hair'], wardrobe: ['white shirt'], physical_state: ['dry hair'], blocking: 'left doorway', action: 'opens door', expression: 'alert', eye_line: 'toward B' },
    { subject_id: 'b', name: 'B', reference_label: '<Subject 2>', identity: ['black hair'], wardrobe: ['blue apron'], physical_state: ['flour on hands'], blocking: 'at stove', action: 'stirs soup', expression: 'calm', eye_line: 'toward pot' },
  ],
  environment: { location: 'small kitchen', time_light: 'warm evening practicals', atmosphere: 'quiet', continuity: 'same cookware positions' },
  camera: { shot_size: 'MS', angle: 'eye level', lens: 'normal lens', movement: 'slow dolly in', composition: 'A left, B right', focus: 'rack from A to B', axis: 'stay on established axis' },
  temporal_beats: [
    { start_seconds: 0, end_seconds: 3, subject_ids: ['a'], visual: 'A opens the door', camera: 'hold', sound: 'door latch' },
    { start_seconds: 3, end_seconds: 6, subject_ids: ['b'], visual: 'B keeps stirring', camera: 'rack focus', sound: 'simmering pot' },
  ],
  dialogue: [{ subject_id: 'b', text: 'You are late.', delivery: 'quietly', start_seconds: 4, end_seconds: 5.5 }],
  ambient_audio: ['soft kitchen room tone'],
  negative_constraints: ['no wardrobe reset', 'no identity transfer'],
};

test('the response schema is strict, bounded and explicitly owns every subject field', () => {
  assert.equal(QIANMU_VIDEO_PROMPT_RESPONSE_SCHEMA.additionalProperties, false);
  assert.equal(QIANMU_VIDEO_PROMPT_RESPONSE_SCHEMA.properties.subjects.maxItems, 6);
  assert.equal(QIANMU_VIDEO_PROMPT_RESPONSE_SCHEMA.properties.subjects.items.additionalProperties, false);
  assert.ok(QIANMU_VIDEO_PROMPT_RESPONSE_SCHEMA.properties.subjects.items.required.includes('wardrobe'));
  assert.ok(QIANMU_VIDEO_PROMPT_RESPONSE_SCHEMA.properties.dialogue.items.required.includes('subject_id'));
});

test('normalization strips extra fields without allowing them into the provider prompt', () => {
  const normalized = normalizeVideoPromptPlan({ ...plan, api_key: 'secret', subjects: [{ ...plan.subjects[0], hidden: 'x' }] }, { ...shot, characters: [shot.characters[0]] });
  assert.equal(normalized.api_key, undefined);
  assert.equal(normalized.subjects[0].hidden, undefined);
  const validation = validateVideoPromptPlan({ ...plan, api_key: 'secret' }, shot);
  assert.equal(validation.ok, true);
  assert.ok(validation.warnings.includes('unexpected_key:$.api_key'));
});

test('unknown, duplicate and mismatched subject bindings fail closed', () => {
  const unknown = structuredClone(plan);
  unknown.subjects[1].subject_id = 'c';
  assert.ok(validateVideoPromptPlan(unknown, shot).issues.includes('subject_unknown:c'));
  assert.ok(validateVideoPromptPlan(unknown, shot).issues.includes('subject_missing:b'));

  const duplicate = structuredClone(plan);
  duplicate.subjects[1].subject_id = 'a';
  assert.ok(validateVideoPromptPlan(duplicate, shot).issues.includes('subject_duplicate:a'));

  const mismatch = structuredClone(plan);
  mismatch.subjects[0].reference_label = '<Subject 2>';
  assert.ok(validateVideoPromptPlan(mismatch, shot).issues.includes('subject_label_mismatch:a'));
});

test('stable subject ids support Chinese character names without collapsing ownership', () => {
  const chineseShot = {
    ...shot,
    characters: [{ ...shot.characters[0], characterId: '阿绫', name: '阿绫' }],
  };
  const chinesePlan = {
    ...structuredClone(plan),
    subjects: [{ ...plan.subjects[0], subject_id: '阿绫', name: '阿绫' }],
    temporal_beats: [{ ...plan.temporal_beats[0], subject_ids: ['阿绫'] }],
    dialogue: [{ ...plan.dialogue[0], subject_id: '阿绫' }],
  };
  const result = compileH3VideoPrompt(chinesePlan, chineseShot);
  assert.equal(result.ok, true);
  assert.match(result.prompt, /\[SUBJECT 阿绫 <Subject 1>\]/);
});

test('beats and dialogue may only reference declared subject ids', () => {
  const invalid = structuredClone(plan);
  invalid.temporal_beats[0].subject_ids.push('ghost');
  invalid.dialogue[0].subject_id = 'ghost';
  const result = validateVideoPromptPlan(invalid, shot);
  assert.ok(result.issues.includes('beat_subject_unknown:0:ghost'));
  assert.ok(result.issues.includes('dialogue_subject_unknown:0:ghost'));
});

test('manual direction is first and character ownership stays separated in the H3 prompt', () => {
  const result = compileH3VideoPrompt(plan, shot, { manualDirection: 'Keep B motionless until second 3.' });
  assert.equal(result.ok, true);
  assert.equal(result.manualDirectionApplied, true);
  assert.ok(result.prompt.startsWith('[USER DIRECTION — HIGHEST PRIORITY]'));
  assert.match(result.prompt, /\[SUBJECT a <Subject 1>\][^\n]*red hair[^\n]*white shirt[^\n]*opens door/);
  assert.match(result.prompt, /\[SUBJECT b <Subject 2>\][^\n]*black hair[^\n]*blue apron[^\n]*stirs soup/);
  assert.match(result.prompt, /\[DIALOGUE 4-5\.5s \| b\] You are late\./);
  assert.ok(result.length <= QIANMU_H3_PROMPT_MAX_CHARS);
});

test('an existing structured shot creates a deterministic zero-network prompt plan', () => {
  const planFromShot = createVideoPromptPlanFromShotSpec({
    ...shot,
    camera: { shotSize: 'MCU', angle: 'eye level', movement: 'slow dolly', framing: 'A left, B right', axis: 'hall side' },
    beats: [{ startSeconds: 0, endSeconds: 3, visual: 'A opens the door', camera: 'hold', sound: 'latch' }],
    audio: { dialogue: [{ characterId: 'b', text: 'You are late.', startSeconds: 4, endSeconds: 5, delivery: 'quietly' }], ambience: ['simmering'] },
    continuityLedger: { requiredFacts: ['A:coat:removed'], forbiddenRegressions: ['no coat reset'] },
  });
  const result = validateVideoPromptPlan(planFromShot, {
    ...shot,
    camera: { shotSize: 'MCU' },
    beats: [{ startSeconds: 0, endSeconds: 3, visual: 'A opens the door' }],
    audio: { dialogue: [{ characterId: 'b', text: 'You are late.' }] },
  });
  assert.equal(result.ok, true);
  assert.deepEqual(planFromShot.temporal_beats[0].subject_ids, ['a']);
  assert.ok(planFromShot.temporal_beats.some((beat) => beat.subject_ids.includes('b') && /stirring/.test(beat.visual)));
  assert.equal(planFromShot.dialogue[0].subject_id, 'b');
  assert.equal(planFromShot.subjects[0].wardrobe[0], 'white shirt, coat removed');
});

test('the LLM request is compact, JSON-only and does not perform network work', () => {
  const request = buildVideoPromptPlanRequest(shot, {
    selectedText: 'A enters the kitchen. B keeps stirring.',
    manualDirection: 'Keep B still at first.',
  });
  assert.equal(request.schema, QIANMU_VIDEO_PROMPT_PLAN_SCHEMA_ID);
  assert.equal(request.responseFormat.type, 'json_schema');
  assert.equal(request.responseFormat.json_schema.strict, true);
  assert.match(request.messages[0].content, /Return only JSON/);
  assert.match(request.messages[0].content, /sole owner/);
  assert.equal(JSON.parse(request.messages[1].content).subjects[1].subject_id, 'b');
  assert.doesNotMatch(request.messages.map((message) => message.content).join('\n'), /fetch\(|api[_ -]?key/i);
});

test('the parser accepts exact JSON or a single JSON fence, and rejects prose wrappers', () => {
  assert.equal(parseVideoPromptPlanResponse(JSON.stringify(plan), shot).ok, true);
  assert.equal(parseVideoPromptPlanResponse(`\`\`\`json\n${JSON.stringify(plan)}\n\`\`\``, shot).ok, true);
  assert.equal(parseVideoPromptPlanResponse(`Here is the result: ${JSON.stringify(plan)}`, shot).ok, false);
});

test('the prompt contract stays lazy and is included in the release whitelist', async () => {
  const [indexSource, releaseSource] = await Promise.all([
    readFile(new URL('../index.js', import.meta.url), 'utf8'),
    readFile(new URL('../release-files.json', import.meta.url), 'utf8'),
  ]);
  assert.match(indexSource, /videoPrompt:\s*\{[\s\S]*import\('\.\/qianmu-video-prompt\.js\?v=1\.58\.69'\)/);
  assert.equal(JSON.parse(releaseSource).files.includes('qianmu-video-prompt.js'), true);
  assert.doesNotMatch(indexSource.slice(0, indexSource.indexOf('const featureRuntime')), /qianmu-video-prompt/);
});
