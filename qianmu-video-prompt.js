// Qianmu video prompt contract. Pure data only: no DOM, storage, network or task submission.
import { createQianmuChatCompletionResponseFormat } from './qianmu-llm-output.js';
import { normalizeVideoShotSpec } from './qianmu-video-contract.js';

export const QIANMU_VIDEO_PROMPT_PLAN_SCHEMA_ID = 'qianmu.video-prompt-plan.v1';
export const QIANMU_VIDEO_PROMPT_MAX_BYTES = 96 * 1024;
export const QIANMU_H3_PROMPT_MAX_CHARS = 7000;
export const QIANMU_VIDEO_SHOT_SIZES = Object.freeze([
  'ECU', 'CU', 'MCU', 'MS', 'MLS', 'WS', 'EWS', 'insert', 'detail',
]);

const plain = (value) => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const text = (value, max = 1200) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const finite = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const clamp = (value, min, max, fallback = min) => Math.min(max, Math.max(min, finite(value, fallback)));
const list = (value, maxItems = 12, maxChars = 240) => Array.isArray(value)
  ? [...new Set(value.map((item) => text(item, maxChars)).filter(Boolean))].slice(0, maxItems)
  : [];
const subjectId = (value) => text(value, 80).replace(/\s+/g, '-').replace(/[^\p{L}\p{N}._:-]/gu, '');
const subjectLabel = (value) => /^<Subject [1-9]\d*>$/.test(text(value, 80)) ? text(value, 80) : '';
const ownKeys = (value) => plain(value) ? Object.keys(value) : [];

const stringSchema = (maxLength) => ({ type: 'string', maxLength });
const stringArraySchema = (maxItems, maxLength) => ({
  type: 'array', maxItems, uniqueItems: true, items: stringSchema(maxLength),
});

export const QIANMU_VIDEO_PROMPT_RESPONSE_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['schema', 'shot_summary', 'subjects', 'environment', 'camera', 'temporal_beats', 'dialogue', 'ambient_audio', 'negative_constraints'],
  properties: {
    schema: { type: 'string', const: QIANMU_VIDEO_PROMPT_PLAN_SCHEMA_ID },
    shot_summary: stringSchema(1200),
    subjects: {
      type: 'array', maxItems: 6, items: {
        type: 'object', additionalProperties: false,
        required: ['subject_id', 'name', 'reference_label', 'identity', 'wardrobe', 'physical_state', 'blocking', 'action', 'expression', 'eye_line'],
        properties: {
          subject_id: stringSchema(80),
          name: stringSchema(120),
          reference_label: stringSchema(80),
          identity: stringArraySchema(12, 180),
          wardrobe: stringArraySchema(12, 180),
          physical_state: stringArraySchema(12, 180),
          blocking: stringSchema(500),
          action: stringSchema(700),
          expression: stringSchema(300),
          eye_line: stringSchema(240),
        },
      },
    },
    environment: {
      type: 'object', additionalProperties: false,
      required: ['location', 'time_light', 'atmosphere', 'continuity'],
      properties: {
        location: stringSchema(600), time_light: stringSchema(400),
        atmosphere: stringSchema(400), continuity: stringSchema(700),
      },
    },
    camera: {
      type: 'object', additionalProperties: false,
      required: ['shot_size', 'angle', 'lens', 'movement', 'composition', 'focus', 'axis'],
      properties: {
        shot_size: { type: 'string', enum: QIANMU_VIDEO_SHOT_SIZES },
        angle: stringSchema(240), lens: stringSchema(240), movement: stringSchema(500),
        composition: stringSchema(700), focus: stringSchema(400), axis: stringSchema(300),
      },
    },
    temporal_beats: {
      type: 'array', minItems: 1, maxItems: 6, items: {
        type: 'object', additionalProperties: false,
        required: ['start_seconds', 'end_seconds', 'subject_ids', 'visual', 'camera', 'sound'],
        properties: {
          start_seconds: { type: 'number', minimum: 0, maximum: 15 },
          end_seconds: { type: 'number', minimum: 0, maximum: 15 },
          subject_ids: stringArraySchema(6, 80),
          visual: stringSchema(700), camera: stringSchema(400), sound: stringSchema(400),
        },
      },
    },
    dialogue: {
      type: 'array', maxItems: 8, items: {
        type: 'object', additionalProperties: false,
        required: ['subject_id', 'text', 'delivery', 'start_seconds', 'end_seconds'],
        properties: {
          subject_id: stringSchema(80), text: stringSchema(600), delivery: stringSchema(300),
          start_seconds: { type: 'number', minimum: 0, maximum: 15 },
          end_seconds: { type: 'number', minimum: 0, maximum: 15 },
        },
      },
    },
    ambient_audio: stringArraySchema(12, 300),
    negative_constraints: stringArraySchema(12, 300),
  },
});

const TOP_KEYS = new Set(['schema', 'shot_summary', 'subjects', 'environment', 'camera', 'temporal_beats', 'dialogue', 'ambient_audio', 'negative_constraints']);
const SUBJECT_KEYS = new Set(['subject_id', 'name', 'reference_label', 'identity', 'wardrobe', 'physical_state', 'blocking', 'action', 'expression', 'eye_line']);
const ENVIRONMENT_KEYS = new Set(['location', 'time_light', 'atmosphere', 'continuity']);
const CAMERA_KEYS = new Set(['shot_size', 'angle', 'lens', 'movement', 'composition', 'focus', 'axis']);
const BEAT_KEYS = new Set(['start_seconds', 'end_seconds', 'subject_ids', 'visual', 'camera', 'sound']);
const DIALOGUE_KEYS = new Set(['subject_id', 'text', 'delivery', 'start_seconds', 'end_seconds']);

function noteUnexpected(value, allowed, path, warnings) {
  for (const key of ownKeys(value)) if (!allowed.has(key)) warnings.push(`unexpected_key:${path}.${key}`);
}

function requireKeys(value, keys, path, issues) {
  if (!plain(value)) {
    issues.push(`object_invalid:${path}`);
    return;
  }
  for (const key of keys) if (!Object.hasOwn(value, key)) issues.push(`key_missing:${path}.${key}`);
}

function normalizeSubject(value = {}, index = 0) {
  const raw = plain(value) ? value : {};
  return {
    subject_id: subjectId(raw.subject_id) || `subject-${index + 1}`,
    name: text(raw.name, 120),
    reference_label: subjectLabel(raw.reference_label),
    identity: list(raw.identity, 12, 180),
    wardrobe: list(raw.wardrobe, 12, 180),
    physical_state: list(raw.physical_state, 12, 180),
    blocking: text(raw.blocking, 500),
    action: text(raw.action, 700),
    expression: text(raw.expression, 300),
    eye_line: text(raw.eye_line, 240),
  };
}

function normalizeBeat(value = {}, durationSeconds = 6) {
  const raw = plain(value) ? value : {};
  const start = clamp(raw.start_seconds, 0, durationSeconds, 0);
  const end = clamp(raw.end_seconds, start, durationSeconds, Math.min(durationSeconds, start + 1));
  return {
    start_seconds: start,
    end_seconds: end,
    subject_ids: list(raw.subject_ids, 6, 80).map(subjectId).filter(Boolean),
    visual: text(raw.visual, 700),
    camera: text(raw.camera, 400),
    sound: text(raw.sound, 400),
  };
}

function normalizeDialogue(value = {}, durationSeconds = 6) {
  const raw = plain(value) ? value : {};
  const start = clamp(raw.start_seconds, 0, durationSeconds, 0);
  const end = clamp(raw.end_seconds, start, durationSeconds, Math.min(durationSeconds, start + 2));
  return {
    subject_id: subjectId(raw.subject_id),
    text: text(raw.text, 600),
    delivery: text(raw.delivery, 300),
    start_seconds: start,
    end_seconds: end,
  };
}

export function normalizeVideoPromptPlan(value = {}, shotSpecValue = {}) {
  const raw = plain(value) ? value : {};
  const shot = normalizeVideoShotSpec(shotSpecValue);
  const environment = plain(raw.environment) ? raw.environment : {};
  const camera = plain(raw.camera) ? raw.camera : {};
  return {
    schema: QIANMU_VIDEO_PROMPT_PLAN_SCHEMA_ID,
    shot_summary: text(raw.shot_summary, 1200),
    subjects: (Array.isArray(raw.subjects) ? raw.subjects : []).slice(0, 6).map(normalizeSubject),
    environment: {
      location: text(environment.location, 600),
      time_light: text(environment.time_light, 400),
      atmosphere: text(environment.atmosphere, 400),
      continuity: text(environment.continuity, 700),
    },
    camera: {
      shot_size: QIANMU_VIDEO_SHOT_SIZES.includes(camera.shot_size) ? camera.shot_size : 'MS',
      angle: text(camera.angle, 240),
      lens: text(camera.lens, 240),
      movement: text(camera.movement, 500),
      composition: text(camera.composition, 700),
      focus: text(camera.focus, 400),
      axis: text(camera.axis, 300),
    },
    temporal_beats: (Array.isArray(raw.temporal_beats) ? raw.temporal_beats : []).slice(0, 6)
      .map((beat) => normalizeBeat(beat, shot.durationSeconds)),
    dialogue: (Array.isArray(raw.dialogue) ? raw.dialogue : []).slice(0, 8)
      .map((line) => normalizeDialogue(line, shot.durationSeconds)),
    ambient_audio: list(raw.ambient_audio, 12, 300),
    negative_constraints: list(raw.negative_constraints, 12, 300),
  };
}

export function validateVideoPromptPlan(value = {}, shotSpecValue = {}) {
  const raw = plain(value) ? value : {};
  const shot = normalizeVideoShotSpec(shotSpecValue);
  const plan = normalizeVideoPromptPlan(raw, shot);
  const issues = [];
  const warnings = [];
  noteUnexpected(raw, TOP_KEYS, '$', warnings);
  if (raw.schema !== QIANMU_VIDEO_PROMPT_PLAN_SCHEMA_ID) issues.push('schema_invalid');
  if (!Array.isArray(raw.subjects)) issues.push('subjects_invalid');
  if (!plain(raw.environment)) issues.push('environment_invalid');
  if (!plain(raw.camera)) issues.push('camera_invalid');
  if (!Array.isArray(raw.temporal_beats) || !raw.temporal_beats.length) issues.push('temporal_beats_missing');
  if (!Array.isArray(raw.dialogue)) issues.push('dialogue_invalid');
  if (!Array.isArray(raw.ambient_audio)) issues.push('ambient_audio_invalid');
  if (!Array.isArray(raw.negative_constraints)) issues.push('negative_constraints_invalid');
  requireKeys(raw, TOP_KEYS, '$', issues);
  requireKeys(raw.environment, ENVIRONMENT_KEYS, '$.environment', issues);
  requireKeys(raw.camera, CAMERA_KEYS, '$.camera', issues);
  if (!QIANMU_VIDEO_SHOT_SIZES.includes(raw.camera?.shot_size)) issues.push('camera_shot_size_invalid');
  noteUnexpected(raw.environment, ENVIRONMENT_KEYS, '$.environment', warnings);
  noteUnexpected(raw.camera, CAMERA_KEYS, '$.camera', warnings);

  const expected = new Map(shot.characters.map((character) => [character.characterId, character]));
  const declared = new Set();
  const labels = new Set();
  plan.subjects.forEach((subject, index) => {
    requireKeys(raw.subjects?.[index], SUBJECT_KEYS, `$.subjects[${index}]`, issues);
    noteUnexpected(raw.subjects?.[index], SUBJECT_KEYS, `$.subjects[${index}]`, warnings);
    if (!subjectId(raw.subjects?.[index]?.subject_id)) issues.push(`subject_id_missing:${index}`);
    for (const key of ['identity', 'wardrobe', 'physical_state']) {
      if (!Array.isArray(raw.subjects?.[index]?.[key])) issues.push(`subject_${key}_invalid:${index}`);
    }
    if (raw.subjects?.[index]?.reference_label && !subject.reference_label) issues.push(`subject_label_invalid:${subject.subject_id}`);
    if (declared.has(subject.subject_id)) issues.push(`subject_duplicate:${subject.subject_id}`);
    declared.add(subject.subject_id);
    if (expected.size && !expected.has(subject.subject_id)) issues.push(`subject_unknown:${subject.subject_id}`);
    const expectedSubject = expected.get(subject.subject_id);
    if (expectedSubject?.subjectLabel && subject.reference_label !== expectedSubject.subjectLabel) {
      issues.push(`subject_label_mismatch:${subject.subject_id}`);
    }
    if (subject.reference_label) {
      if (labels.has(subject.reference_label)) issues.push(`subject_label_duplicate:${subject.reference_label}`);
      labels.add(subject.reference_label);
    }
  });
  for (const id of expected.keys()) if (!declared.has(id)) issues.push(`subject_missing:${id}`);

  plan.temporal_beats.forEach((beat, index) => {
    requireKeys(raw.temporal_beats?.[index], BEAT_KEYS, `$.temporal_beats[${index}]`, issues);
    noteUnexpected(raw.temporal_beats?.[index], BEAT_KEYS, `$.temporal_beats[${index}]`, warnings);
    if (!Array.isArray(raw.temporal_beats?.[index]?.subject_ids)) issues.push(`beat_subjects_invalid:${index}`);
    if (!beat.visual) issues.push(`beat_visual_missing:${index}`);
    beat.subject_ids.forEach((id) => { if (!declared.has(id)) issues.push(`beat_subject_unknown:${index}:${id}`); });
  });
  plan.dialogue.forEach((line, index) => {
    requireKeys(raw.dialogue?.[index], DIALOGUE_KEYS, `$.dialogue[${index}]`, issues);
    noteUnexpected(raw.dialogue?.[index], DIALOGUE_KEYS, `$.dialogue[${index}]`, warnings);
    if (!line.subject_id || !declared.has(line.subject_id)) issues.push(`dialogue_subject_unknown:${index}:${line.subject_id || 'empty'}`);
    if (!line.text) issues.push(`dialogue_text_missing:${index}`);
  });
  if (!plan.shot_summary && !plan.temporal_beats.some((beat) => beat.visual)) issues.push('visual_intent_missing');
  return { ok: issues.length === 0, issues: [...new Set(issues)], warnings: [...new Set(warnings)], plan, shot };
}

function jsonText(raw) {
  if (plain(raw)) return raw;
  let source = String(raw ?? '').trim();
  if (new TextEncoder().encode(source).byteLength > QIANMU_VIDEO_PROMPT_MAX_BYTES) throw new Error('response_too_large');
  const fenced = source.match(/^```(?:json)?\s*\r?\n([\s\S]*?)\r?\n```$/i);
  if (fenced) source = fenced[1].trim();
  const parsed = JSON.parse(source);
  if (!plain(parsed)) throw new TypeError('response_root_must_be_object');
  return parsed;
}

export function parseVideoPromptPlanResponse(raw, shotSpecValue = {}) {
  try {
    return validateVideoPromptPlan(jsonText(raw), shotSpecValue);
  } catch (error) {
    return {
      ok: false,
      issues: [`json_invalid:${text(error?.message || error, 240)}`],
      warnings: [],
      plan: null,
      shot: normalizeVideoShotSpec(shotSpecValue),
    };
  }
}

function compactShotInput(shot, options = {}) {
  return {
    schema: 'qianmu.video-prompt-input.v1',
    language: text(options.language || 'zh-CN', 20),
    selected_narrative: text(options.selectedText || options.sourceText, 16000),
    manual_direction: text(options.manualDirection, 1800),
    duration_seconds: shot.durationSeconds,
    aspect_ratio: shot.aspectRatio,
    visual_intent: shot.intent,
    subjects: shot.characters.map((character) => ({
      subject_id: character.characterId,
      name: character.name,
      reference_label: character.subjectLabel,
      identity: character.appearance.identity,
      wardrobe: character.appearance.wardrobe,
      physical_state: character.appearance.physicalState,
      blocking: character.performance.blocking,
      action: character.performance.action,
      expression: character.performance.expression,
      eye_line: character.performance.eyeLine,
    })),
    camera: shot.camera,
    continuity: shot.continuityLedger,
    source_beats: shot.beats,
    source_dialogue: shot.audio.dialogue,
    source_ambience: shot.audio.ambience,
  };
}

export function buildVideoPromptPlanRequest(shotSpecValue = {}, options = {}) {
  const shot = normalizeVideoShotSpec(shotSpecValue);
  const system = [
    `Return only JSON matching ${QIANMU_VIDEO_PROMPT_PLAN_SCHEMA_ID}.`,
    'Use the supplied subject_id as the sole owner of identity, wardrobe, blocking, action and dialogue.',
    'Never transfer attributes or actions between subjects. Cross-subject interaction must list every involved subject_id.',
    'Preserve current wardrobe and physical state unless the selected narrative explicitly changes them.',
    'Write one compact, filmable shot. Use temporal beats for visible change; do not invent unseen plot facts.',
    'manual_direction has highest priority when it conflicts with automatic fields.',
    'Root keys: schema, shot_summary, subjects, environment, camera, temporal_beats, dialogue, ambient_audio, negative_constraints.',
    'Subject keys: subject_id, name, reference_label, identity, wardrobe, physical_state, blocking, action, expression, eye_line.',
    'Beat keys: start_seconds, end_seconds, subject_ids, visual, camera, sound. Dialogue keys: subject_id, text, delivery, start_seconds, end_seconds.',
    'Use exact JSON keys and no prose, markdown or extra keys.',
  ].join(' ');
  return {
    schema: QIANMU_VIDEO_PROMPT_PLAN_SCHEMA_ID,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: JSON.stringify(compactShotInput(shot, options)) },
    ],
    responseFormat: createQianmuChatCompletionResponseFormat(QIANMU_VIDEO_PROMPT_RESPONSE_SCHEMA, {
      mode: options.structuredOutputMode || 'json_schema',
      name: 'qianmu_video_prompt_plan',
      strict: true,
    }),
  };
}

function addLine(lines, value, maxChars) {
  const clean = text(value, maxChars);
  if (!clean) return;
  const used = lines.reduce((sum, line) => sum + line.length + 1, 0);
  const remaining = QIANMU_H3_PROMPT_MAX_CHARS - used;
  if (remaining <= 1) return;
  lines.push(clean.length <= remaining ? clean : `${clean.slice(0, Math.max(0, remaining - 1))}…`);
}

function joined(values) {
  return list(values, 12, 180).join('; ');
}

export function compileH3VideoPrompt(planValue = {}, shotSpecValue = {}, options = {}) {
  const validation = validateVideoPromptPlan(planValue, shotSpecValue);
  if (!validation.ok) return { ...validation, prompt: '', length: 0 };
  const { plan, shot } = validation;
  const lines = [];
  const manualDirection = text(options.manualDirection, 1800);
  if (manualDirection) addLine(lines, `[USER DIRECTION — HIGHEST PRIORITY] ${manualDirection}`, 1900);
  addLine(lines, `[SHOT] ${plan.shot_summary || shot.intent.summary || shot.intent.scene}`, 1400);
  addLine(lines, '[OWNERSHIP] Every identity, wardrobe, state, action and spoken line belongs exclusively to its subject_id. Never transfer them between subjects.', 300);
  plan.subjects.forEach((subject) => {
    const label = subject.reference_label ? ` ${subject.reference_label}` : '';
    addLine(lines, `[SUBJECT ${subject.subject_id}${label}] name=${subject.name || subject.subject_id}; identity=${joined(subject.identity) || 'preserve reference'}; wardrobe=${joined(subject.wardrobe) || 'preserve current'}; physical_state=${joined(subject.physical_state) || 'preserve current'}; blocking=${subject.blocking || 'preserve spatial relation'}; action=${subject.action || 'natural stillness'}; expression=${subject.expression || 'contextual'}; eye_line=${subject.eye_line || 'contextual'}`, 1700);
  });
  plan.temporal_beats.forEach((beat) => addLine(lines,
    `[BEAT ${beat.start_seconds}-${beat.end_seconds}s | ${beat.subject_ids.join('+') || 'environment'}] visual=${beat.visual}; camera=${beat.camera || 'continue'}; sound=${beat.sound || 'continue'}`,
    1200));
  addLine(lines, `[CAMERA] size=${plan.camera.shot_size}; angle=${plan.camera.angle}; lens=${plan.camera.lens}; movement=${plan.camera.movement}; composition=${plan.camera.composition}; focus=${plan.camera.focus}; axis=${plan.camera.axis}`, 1400);
  addLine(lines, `[ENVIRONMENT] location=${plan.environment.location}; time_light=${plan.environment.time_light}; atmosphere=${plan.environment.atmosphere}; continuity=${plan.environment.continuity}`, 1500);
  plan.dialogue.forEach((line) => addLine(lines,
    `[DIALOGUE ${line.start_seconds}-${line.end_seconds}s | ${line.subject_id}] ${line.text}; delivery=${line.delivery || 'natural'}`,
    1000));
  addLine(lines, `[AUDIO] ${joined(plan.ambient_audio)}`, 900);
  addLine(lines, `[CONTINUITY] required=${joined(shot.continuityLedger.requiredFacts)}; forbidden_regressions=${joined(shot.continuityLedger.forbiddenRegressions)}; motion_handoff=${shot.continuityLedger.motionHandoff}; audio_handoff=${shot.continuityLedger.audioHandoff}`, 1600);
  addLine(lines, `[AVOID] ${joined(plan.negative_constraints)}`, 1000);
  const prompt = lines.join('\n').slice(0, QIANMU_H3_PROMPT_MAX_CHARS);
  return { ...validation, prompt, length: prompt.length, manualDirectionApplied: Boolean(manualDirection) };
}
