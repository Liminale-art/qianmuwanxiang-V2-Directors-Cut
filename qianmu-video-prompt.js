// Qianmu video prompt contract. Pure data only: no DOM, storage, network or task submission.
import { createQianmuChatCompletionResponseFormat } from './qianmu-llm-output.js';
import { normalizeMultimodalAssetManifest, normalizeVideoShotSpec } from './qianmu-video-contract.js';

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

function inferredBeatSubjectIds(beat, subjects) {
  const visual = text(beat?.visual, 700).toLocaleLowerCase();
  if (!visual) return [];
  const matched = subjects.filter((subject) => {
    const names = [subject.subject_id, subject.name].map((item) => text(item, 120).toLocaleLowerCase()).filter(Boolean);
    const actions = [subject.action].map((item) => text(item, 700).toLocaleLowerCase()).filter((item) => item.length >= 3);
    return names.some((item) => visual.includes(item)) || actions.some((item) => visual.includes(item));
  }).map((subject) => subject.subject_id);
  return matched.length ? matched : (subjects.length === 1 ? [subjects[0].subject_id] : []);
}

/** Creates a zero-network prompt plan from an already structured storyboard shot. */
export function createVideoPromptPlanFromShotSpec(shotSpecValue = {}) {
  const shot = normalizeVideoShotSpec(shotSpecValue);
  const subjects = shot.characters.map((character) => ({
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
  }));
  const beats = shot.beats.slice(0, 6).map((beat) => ({
    start_seconds: beat.startSeconds,
    end_seconds: beat.endSeconds,
    subject_ids: inferredBeatSubjectIds(beat, subjects),
    visual: beat.visual,
    camera: beat.camera,
    sound: beat.sound,
  }));
  const represented = new Set(beats.flatMap((beat) => beat.subject_ids));
  for (const subject of subjects) {
    if (beats.length >= 6 || represented.has(subject.subject_id) || !subject.action) continue;
    beats.push({
      start_seconds: 0,
      end_seconds: shot.durationSeconds,
      subject_ids: [subject.subject_id],
      visual: `${subject.name || subject.subject_id}: ${subject.action}`,
      camera: '',
      sound: '',
    });
  }
  if (!beats.length) {
    beats.push({
      start_seconds: 0,
      end_seconds: shot.durationSeconds,
      subject_ids: subjects.length === 1 ? [subjects[0].subject_id] : [],
      visual: shot.intent.summary || shot.intent.scene,
      camera: shot.camera.movement,
      sound: '',
    });
  }
  const lightFacts = shot.continuityLedger.requiredFacts.filter((item) => /(?:time|light|weather|时间|光|天气)/i.test(item));
  return normalizeVideoPromptPlan({
    schema: QIANMU_VIDEO_PROMPT_PLAN_SCHEMA_ID,
    shot_summary: shot.intent.summary || shot.intent.scene,
    subjects,
    environment: {
      location: shot.intent.scene,
      time_light: lightFacts.join('; '),
      atmosphere: shot.intent.visualStyle,
      continuity: shot.continuityLedger.requiredFacts.join('; '),
    },
    camera: {
      shot_size: QIANMU_VIDEO_SHOT_SIZES.includes(shot.camera.shotSize) ? shot.camera.shotSize : 'MS',
      angle: shot.camera.angle,
      lens: shot.camera.lens,
      movement: shot.camera.movement,
      composition: shot.camera.framing,
      focus: '',
      axis: shot.camera.axis || shot.continuityLedger.axisRule,
    },
    temporal_beats: beats,
    dialogue: shot.audio.dialogue.map((line) => ({
      subject_id: line.characterId,
      text: line.text,
      delivery: line.delivery,
      start_seconds: line.startSeconds,
      end_seconds: line.endSeconds,
    })),
    ambient_audio: shot.audio.ambience,
    negative_constraints: shot.continuityLedger.forbiddenRegressions,
  }, shot);
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
    'Write generated visual, camera, atmosphere and sound fields in English. Preserve only dialogue, lyrics and visible scene text in their original language.',
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

export const QIANMU_H3_BASE_PROMPT_SECTIONS = Object.freeze([
  'integrated_multimodal_description', 'overall_soundscape', 'non_diegetic_music',
]);
export const QIANMU_H3_REFERENCE_PROMPT_SECTIONS = Object.freeze([
  'subject_definitions', 'summary', 'retention_analysis', 'detailed_description',
  'overall_soundscape', 'non_diegetic_music',
]);

const sentence = (value, max = 900) => text(value, max).replace(/\s*([.;!?])\s*/g, '$1 ').trim();
const sentenceList = (values, maxItems = 8, maxItem = 180) => list(values, maxItems, maxItem).join('; ');
const timecode = (seconds) => {
  const millis = Math.max(0, Math.round(finite(seconds, 0) * 1000));
  const minutes = Math.floor(millis / 60000);
  const remainder = millis % 60000;
  return `${String(minutes).padStart(2, '0')}:${String(Math.floor(remainder / 1000)).padStart(2, '0')}.${String(remainder % 1000).padStart(3, '0')}`;
};
const languageLabel = (value) => {
  const source = String(value || '');
  if (/\p{Script=Hiragana}|\p{Script=Katakana}/u.test(source)) return 'Japanese';
  if (/\p{Script=Hangul}/u.test(source)) return 'Korean';
  if (/\p{Script=Han}/u.test(source)) return 'Chinese';
  return 'English';
};

function referenceLabels(spec, manifestValue = {}) {
  const manifest = normalizeMultimodalAssetManifest(manifestValue);
  const selected = new Set(spec.route.inputs.referenceAssetIds || []);
  const counters = { image: 0, video: 0, audio: 0 };
  const prefix = { image: 'Picture', video: 'Video', audio: 'Audio' };
  return manifest.assets.filter((asset) => selected.has(asset.assetId)).map((asset) => {
    counters[asset.kind] += 1;
    return { asset, label: `<${prefix[asset.kind]} ${counters[asset.kind]}>` };
  });
}

function subjectSpeakerMap(plan) {
  const speaking = new Set(plan.dialogue.map((line) => line.subject_id));
  return new Map(plan.subjects.filter((subject) => speaking.has(subject.subject_id)).map((subject, index) => [subject.subject_id, `S${index + 1}`]));
}

function subjectDescription(subject, speakerMap, { reference = false } = {}) {
  const label = reference && subject.reference_label ? subject.reference_label : (subject.name || subject.subject_id);
  const speaker = speakerMap.get(subject.subject_id);
  const identity = sentenceList(subject.identity, 8, 150);
  const wardrobe = sentenceList(subject.wardrobe, 8, 150);
  const state = sentenceList(subject.physical_state, 8, 150);
  return `${label}${speaker ? ` (${speaker})` : ''}, ${[
    identity && `identity: ${identity}`,
    wardrobe && `wardrobe: ${wardrobe}`,
    state && `current physical state: ${state}`,
    subject.blocking && `position: ${sentence(subject.blocking, 360)}`,
    subject.action && `action: ${sentence(subject.action, 500)}`,
    subject.expression && `expression: ${sentence(subject.expression, 220)}`,
    subject.eye_line && `eye line: ${sentence(subject.eye_line, 180)}`,
  ].filter(Boolean).join('; ') || 'preserving the established appearance and position'}`;
}

function cameraDescription(plan) {
  return [
    plan.camera.shot_size && `${plan.camera.shot_size} framing`,
    sentence(plan.camera.angle, 180),
    sentence(plan.camera.lens, 180),
    sentence(plan.camera.composition, 420),
    sentence(plan.camera.focus, 240),
    sentence(plan.camera.movement, 360),
    sentence(plan.camera.axis, 220),
  ].filter(Boolean).join(', ');
}

function dialogueDescriptions(plan, speakerMap, { reference = false } = {}) {
  return plan.dialogue.map((line) => {
    const subject = plan.subjects.find((item) => item.subject_id === line.subject_id);
    const owner = reference && subject?.reference_label ? subject.reference_label : (subject?.name || line.subject_id);
    const speaker = speakerMap.get(line.subject_id) || 'S1';
    const spoken = sentence(line.text, 600);
    return `From ${timecode(line.start_seconds)} to ${timecode(line.end_seconds)}, ${owner} (${speaker}) ${sentence(line.delivery, 220) || 'speaks naturally'}: <d>[${languageLabel(spoken)}] ${spoken}</d>.`;
  });
}

function timelineDescription(plan, shot, { reference = false, references = [] } = {}) {
  const speakerMap = subjectSpeakerMap(plan);
  const visualStyle = sentence(shot.intent.visualStyle, 420);
  const atmosphere = sentence(plan.environment.atmosphere, 320);
  const style = visualStyle || (atmosphere ? `Cinematic audiovisual scene with ${atmosphere}` : 'Cinematic audiovisual scene');
  const opening = [
    `[Shot 1] ${style}.`,
    sentence(plan.shot_summary || shot.intent.summary || shot.intent.scene, 900),
    cameraDescription(plan) && `The camera uses ${cameraDescription(plan)}.`,
    sentence(plan.environment.location, 420) && `The location is ${sentence(plan.environment.location, 420)}.`,
    sentence(plan.environment.time_light, 300) && `Time and lighting: ${sentence(plan.environment.time_light, 300)}.`,
    sentence(plan.environment.continuity, 520) && `Continuity remains: ${sentence(plan.environment.continuity, 520)}.`,
    plan.negative_constraints.length && `Visual continuity constraints: ${sentenceList(plan.negative_constraints, 8, 220)}.`,
    ...plan.subjects.map((subject) => `${subjectDescription(subject, speakerMap, { reference })}.`),
  ].filter(Boolean);
  if (reference) {
    const styleRefs = references.filter(({ asset }) => asset.roles.includes('style_reference')).map(({ label }) => label);
    const motionRefs = references.filter(({ asset }) => asset.roles.includes('motion_reference')).map(({ label }) => label);
    if (styleRefs.length) opening.push(`The visual treatment follows ${styleRefs.join(' and ')} as style references.`);
    if (motionRefs.length) opening.push(`Visible motion follows ${motionRefs.join(' and ')} as motion references without transferring identity.`);
  } else if (shot.route.mode === 'i2va') {
    opening.push('The opening composition, identities, wardrobe, objects, lighting and spatial relationships are anchored to <Picture 1>.');
  } else if (shot.route.mode === 'fl2va') {
    opening.push('The shot begins from <Picture 1> and develops continuously toward the final state and composition in <Picture 2>.');
  } else if (shot.route.mode === 'l2va') {
    opening.push('The action and composition progressively converge on <Picture 1> at the end of the shot.');
  }
  const beats = plan.temporal_beats.map((beat) => {
    const owners = beat.subject_ids.map((id) => {
      const subject = plan.subjects.find((item) => item.subject_id === id);
      return reference && subject?.reference_label ? subject.reference_label : (subject?.name || id);
    }).filter(Boolean);
    return `From ${timecode(beat.start_seconds)} to ${timecode(beat.end_seconds)}, ${owners.length ? `${owners.join(' and ')}: ` : ''}${sentence(beat.visual, 650)}${beat.camera ? ` The camera movement is ${sentence(beat.camera, 320)}.` : ''}${beat.sound ? ` Synchronized sound: ${sentence(beat.sound, 300)}.` : ''}`;
  });
  return [...opening, ...beats, ...dialogueDescriptions(plan, speakerMap, { reference })].join(' ');
}

function baseAlignment(mode, durationSeconds) {
  if (mode === 'i2va') return 'For the target video, at 0.00 seconds into the target video, <Picture 1> (from [Shot 1]) is fully referenced.';
  if (mode === 'fl2va') return `How the reference pictures align with the target video — Picture 1 (from Shot 1) aligns with the 0.00-second mark of the target video; Picture 2 (from Shot 1) aligns with the ${Number(durationSeconds).toFixed(2)}-second mark of the target video.`;
  if (mode === 'l2va') return `How the reference pictures align with the target video — <Picture 1> (from [Shot 1]) aligns with the ${Number(durationSeconds).toFixed(2)}-second mark of the target video.`;
  return '';
}

function soundscape(plan) {
  const sounds = [...plan.ambient_audio, ...plan.temporal_beats.map((beat) => beat.sound).filter(Boolean)];
  return sounds.slice(0, 12).map((item) => sentence(item, 260)).filter(Boolean).join('. ') || 'Ambient sound follows the described location and visible physical actions.';
}

function referenceSections(plan, shot, manifestValue) {
  const references = referenceLabels(shot, manifestValue);
  const speakerMap = subjectSpeakerMap(plan);
  const refBySubject = new Map(references.filter(({ asset }) => asset.subjectLabel).map(({ asset, label }) => [asset.subjectLabel, label]));
  const subjectDefinitions = [];
  const retention = [];
  for (const subject of plan.subjects.filter((item) => item.reference_label)) {
    const source = refBySubject.get(subject.reference_label);
    subjectDefinitions.push(`${subject.reference_label} is ${subjectDescription(subject, speakerMap, { reference: false })}${source ? `, with visible identity and wardrobe drawn from ${source}` : ''}.`);
    retention.push(`${subject.reference_label} (appears in [Shot 1]): fully_preserved - identity, wardrobe and distinguishing features remain assigned only to this subject.`);
  }
  for (const { asset, label } of references) {
    if (asset.subjectLabel && refBySubject.get(asset.subjectLabel) === label) continue;
    const role = asset.roles.includes('style_reference') ? 'visual style and treatment'
      : asset.roles.includes('motion_reference') ? 'visible motion and action rhythm'
        : asset.kind === 'video' ? 'temporal and camera structure'
          : asset.kind === 'audio' ? 'audio character and timing'
            : 'shot planning and composition';
    subjectDefinitions.push(`${label} is the reference for ${role} in [Shot 1].`);
    retention.push(`${label} (${role}): ${asset.kind === 'audio' ? 'reference' : 'weak_reference'} - only the defined reference role is carried into the target video.`);
  }
  const labels = references.map((item) => item.label);
  const subjectLabels = plan.subjects.map((item) => item.reference_label).filter(Boolean);
  const summaryLabels = [...subjectLabels, ...labels].join(', ');
  return {
    subject_definitions: subjectDefinitions.join('\n'),
    summary: `[reference generation] ${sentence(plan.shot_summary || shot.intent.summary || shot.intent.scene, 1000)}${summaryLabels ? ` The target video uses ${summaryLabels} only for their defined reference roles.` : ''}`,
    retention_analysis: retention.join('\n'),
    detailed_description: timelineDescription(plan, shot, { reference: true, references }),
    overall_soundscape: soundscape(plan),
    non_diegetic_music: sentence(shot.audio.music, 900) || 'N/A',
  };
}

function baseSections(plan, shot) {
  return {
    integrated_multimodal_description: timelineDescription(plan, shot),
    overall_soundscape: soundscape(plan),
    non_diegetic_music: sentence(shot.audio.music, 900) || 'N/A',
  };
}

function sectionPrompt(sections, order, prefix = '') {
  const blockSections = new Set(['subject_definitions', 'retention_analysis', 'detailed_description']);
  const body = order.map((key) => `${key}:${blockSections.has(key) ? '\n' : ' '}${sections[key] || 'N/A'}`).join('\n\n');
  return prefix ? `${prefix}\n\n${body}` : body;
}

function timecodeSeconds(value) {
  const match = String(value || '').match(/^(\d{2}):(\d{2})\.(\d{3})$/);
  return match ? Number(match[1]) * 60 + Number(match[2]) + Number(match[3]) / 1000 : NaN;
}

export function validateH3CompiledPrompt(promptValue, shotSpecValue = {}, manifestValue = {}) {
  const prompt = String(promptValue || '').trim();
  const shot = normalizeVideoShotSpec(shotSpecValue, manifestValue);
  const order = shot.route.mode === 'ref2va' ? QIANMU_H3_REFERENCE_PROMPT_SECTIONS : QIANMU_H3_BASE_PROMPT_SECTIONS;
  const issues = [];
  const warnings = [];
  if (!prompt) issues.push('h3_prompt_missing');
  if (prompt.length > QIANMU_H3_PROMPT_MAX_CHARS) issues.push('h3_prompt_too_long');
  let previous = -1;
  for (const key of order) {
    const index = prompt.indexOf(`${key}:`);
    if (index < 0) issues.push(`h3_section_missing:${key}`);
    else if (index <= previous) issues.push(`h3_section_order_invalid:${key}`);
    previous = Math.max(previous, index);
  }
  const alignment = baseAlignment(shot.route.mode, shot.durationSeconds);
  if (alignment && !prompt.startsWith(`${alignment}\n\n`)) issues.push(`h3_alignment_invalid:${shot.route.mode}`);
  if (shot.route.mode === 't2va' && !prompt.startsWith('integrated_multimodal_description:')) issues.push('h3_t2va_prefix_invalid');
  if (shot.route.mode === 'ref2va' && !prompt.startsWith('subject_definitions:')) issues.push('h3_ref_prefix_invalid');
  const allowedLabels = new Set([
    ...(shot.route.mode === 'ref2va' ? referenceLabels(shot, manifestValue).map((item) => item.label) : []),
    ...(shot.route.mode === 'i2va' || shot.route.mode === 'l2va' ? ['<Picture 1>'] : []),
    ...(shot.route.mode === 'fl2va' ? ['<Picture 1>', '<Picture 2>'] : []),
    ...shot.characters.map((character) => character.subjectLabel).filter(Boolean),
  ]);
  for (const label of prompt.match(/<(?:Subject|Picture|Video|Audio) [1-9]\d*>/g) || []) {
    if (!allowedLabels.has(label)) issues.push(`h3_reference_unresolved:${label}`);
  }
  for (const match of prompt.matchAll(/\b(\d{2}:\d{2}\.\d{3})\b/g)) {
    if (timecodeSeconds(match[1]) > shot.durationSeconds) issues.push(`h3_time_out_of_range:${match[1]}`);
  }
  const withoutDialogue = prompt.replace(/<d>\[[^\]]+\][\s\S]*?<\/d>/g, '').replace(/"[^"\n]*"/g, '');
  const cjkCount = (withoutDialogue.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu) || []).length;
  if (cjkCount > Math.max(12, Math.round(withoutDialogue.length * 0.02))) warnings.push('h3_english_rewrite_required');
  return {
    ok: issues.length === 0,
    submissionReady: issues.length === 0 && warnings.length === 0,
    issues: [...new Set(issues)],
    warnings: [...new Set(warnings)],
    prompt,
    mode: shot.route.mode,
    sections: order,
  };
}

export function compileH3VideoPrompt(planValue = {}, shotSpecValue = {}, options = {}) {
  const validation = validateVideoPromptPlan(planValue, shotSpecValue);
  if (!validation.ok) return { ...validation, prompt: '', length: 0 };
  const { plan } = validation;
  const manifest = normalizeMultimodalAssetManifest(options.manifest);
  const shot = normalizeVideoShotSpec(shotSpecValue, manifest);
  const sections = shot.route.mode === 'ref2va' ? referenceSections(plan, shot, manifest) : baseSections(plan, shot);
  const prompt = sectionPrompt(
    sections,
    shot.route.mode === 'ref2va' ? QIANMU_H3_REFERENCE_PROMPT_SECTIONS : QIANMU_H3_BASE_PROMPT_SECTIONS,
    shot.route.mode === 'ref2va' ? '' : baseAlignment(shot.route.mode, shot.durationSeconds),
  );
  const promptValidation = validateH3CompiledPrompt(prompt, shot, manifest);
  return {
    ...validation,
    ok: validation.ok && promptValidation.ok,
    prompt,
    length: prompt.length,
    mode: shot.route.mode,
    format: shot.route.mode === 'ref2va' ? 'official_ref_six_section' : 'official_base_three_section',
    promptValidation,
    submissionReady: promptValidation.submissionReady,
    manualDirectionApplied: Boolean(text(options.manualDirection, 1800)),
  };
}
