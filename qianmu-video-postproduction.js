// 千幕完整影片后期分层合同。只保存稳定引用与时间轴决策，不读媒体、不混音、不转码。

export const QIANMU_VIDEO_POSTPRODUCTION_SCHEMA = 'qianmu.video-postproduction.v1';
export const QIANMU_VIDEO_POSTPRODUCTION_LIMITS = Object.freeze({
  transitions: 119,
  subtitles: 500,
  audioPerRole: 240,
  totalAudio: 500,
});
export const QIANMU_VIDEO_TRANSITION_TYPES = Object.freeze(['cut', 'crossfade', 'dip_black']);
export const QIANMU_VIDEO_AUDIO_ROLES = Object.freeze(['dialogue', 'ambience', 'music']);

const plain = (value) => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const text = (value, max = 1000) => String(value ?? '').trim().slice(0, max);
const number = (value, min = 0, max = Number.MAX_SAFE_INTEGER, fallback = min) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
};
const stableId = (value, max = 200) => {
  const result = text(value, max);
  return /^[A-Za-z0-9._:-]+$/.test(result) ? result : '';
};

function hash(value) {
  let result = 2166136261;
  for (const char of String(value || '')) {
    result ^= char.charCodeAt(0);
    result = Math.imul(result, 16777619);
  }
  return (result >>> 0).toString(16).padStart(8, '0');
}

function milliseconds(raw = {}, key, secondsKey, fallback = 0) {
  const direct = raw[key] ?? raw[key.replace(/[A-Z]/g, (value) => `_${value.toLowerCase()}`)];
  if (direct !== undefined && direct !== null && direct !== '') return Math.round(Number(direct));
  const seconds = raw[secondsKey] ?? raw[secondsKey.replace(/[A-Z]/g, (value) => `_${value.toLowerCase()}`)];
  return seconds !== undefined && seconds !== null && seconds !== '' ? Math.round(Number(seconds) * 1000) : fallback;
}

function timelineContext(value = {}) {
  const raw = plain(value) ? value : {};
  const rawOwner = plain(raw.owner) ? raw.owner : {};
  const clips = (Array.isArray(raw.clips) ? raw.clips : []).slice(0, 120);
  const clipIds = [];
  const clipDurations = new Map();
  let summedDurationMs = 0;
  for (const clip of clips) {
    const clipId = stableId(clip?.clipId || clip?.clip_id);
    if (!clipId) continue;
    const durationMs = Math.max(100, Math.round(number(clip?.playback?.durationSeconds ?? clip?.playback?.duration_seconds, .1, 3600, .1) * 1000));
    clipIds.push(clipId);
    clipDurations.set(clipId, durationMs);
    summedDurationMs += durationMs;
  }
  const declaredDurationMs = Math.round(number(raw.durationSeconds ?? raw.duration_seconds, 0, 432000, 0) * 1000);
  return {
    timelineId: stableId(raw.timelineId || raw.timeline_id),
    chatKey: text(rawOwner.chatKey || rawOwner.chat_key, 512),
    durationMs: summedDurationMs || declaredDurationMs,
    clipIds,
    clipDurations,
    adjacent: new Set(clipIds.slice(0, -1).map((clipId, index) => `${clipId}\n${clipIds[index + 1]}`)),
  };
}

function normalizeTransition(value = {}, index = 0) {
  const raw = plain(value) ? value : {};
  const fromClipId = stableId(raw.fromClipId || raw.from_clip_id);
  const toClipId = stableId(raw.toClipId || raw.to_clip_id);
  const type = QIANMU_VIDEO_TRANSITION_TYPES.includes(raw.type) ? raw.type : 'cut';
  const durationMs = type === 'cut' ? 0 : Math.round(number(milliseconds(raw, 'durationMs', 'durationSeconds', 400), 100, 2000, 400));
  return {
    transitionId: stableId(raw.transitionId || raw.transition_id) || `transition-${hash(`${fromClipId}\n${toClipId}\n${index}`)}`,
    fromClipId,
    toClipId,
    type,
    durationMs,
  };
}

function normalizeSubtitle(value = {}, index = 0, durationMs = 0) {
  const raw = plain(value) ? value : {};
  const ceiling = Math.max(0, durationMs);
  const startMs = Math.round(number(milliseconds(raw, 'startMs', 'startSeconds'), 0, ceiling, 0));
  const endMs = Math.round(number(milliseconds(raw, 'endMs', 'endSeconds'), 0, ceiling, startMs));
  const kind = ['dialogue', 'narration', 'caption'].includes(raw.kind) ? raw.kind : 'dialogue';
  const source = plain(raw.source) ? raw.source : {};
  return {
    cueId: stableId(raw.cueId || raw.cue_id || raw.id) || `subtitle-${index + 1}`,
    startMs,
    endMs,
    text: text(raw.text, 1200),
    language: text(raw.language, 40),
    speakerId: stableId(raw.speakerId || raw.speaker_id, 160),
    kind,
    source: {
      kind: source.kind === 'dialogue' ? 'dialogue' : 'manual',
      refId: stableId(source.refId || source.ref_id),
    },
  };
}

function normalizeAudioItem(value = {}, role = 'dialogue', index = 0, durationMs = 0) {
  const raw = plain(value) ? value : {};
  const source = plain(raw.source) ? raw.source : {};
  const ceiling = Math.max(0, durationMs);
  const startMs = Math.round(number(milliseconds(raw, 'startMs', 'startSeconds'), 0, ceiling, 0));
  const endMs = Math.round(number(milliseconds(raw, 'endMs', 'endSeconds'), 0, ceiling, startMs));
  const span = Math.max(0, endMs - startMs);
  return {
    audioId: stableId(raw.audioId || raw.audio_id || raw.id) || `${role}-${index + 1}`,
    role,
    label: text(raw.label, 160),
    source: {
      kind: 'audio_asset',
      assetId: stableId(source.assetId || source.asset_id || raw.assetId || raw.asset_id),
    },
    startMs,
    endMs,
    sourceOffsetMs: Math.round(number(milliseconds(raw, 'sourceOffsetMs', 'sourceOffsetSeconds'), 0, 86_400_000, 0)),
    gainDb: Number(number(raw.gainDb ?? raw.gain_db, -60, 12, 0).toFixed(2)),
    fadeInMs: Math.round(number(milliseconds(raw, 'fadeInMs', 'fadeInSeconds'), 0, span, 0)),
    fadeOutMs: Math.round(number(milliseconds(raw, 'fadeOutMs', 'fadeOutSeconds'), 0, span, 0)),
    loop: role !== 'dialogue' && Boolean(raw.loop),
    duckUnderDialogue: role !== 'dialogue' && raw.duckUnderDialogue !== false && raw.duck_under_dialogue !== false,
    speakerId: role === 'dialogue' ? stableId(raw.speakerId || raw.speaker_id, 160) : '',
    dialogueText: role === 'dialogue' ? text(raw.dialogueText || raw.dialogue_text || raw.text, 1200) : '',
  };
}

export function normalizeVideoPostproduction(value = {}, timelineValue = {}) {
  const raw = plain(value) ? value : {};
  const context = timelineContext(timelineValue);
  const rawOwner = plain(raw.owner) ? raw.owner : {};
  const rawAudio = plain(raw.audio) ? raw.audio : {};
  const durationMs = context.durationMs || Math.round(number(raw.durationMs ?? raw.duration_ms, 0, 432_000_000, 0));
  const createdAt = Math.round(number(raw.createdAt ?? raw.created_at, 0, Number.MAX_SAFE_INTEGER, 0));
  const updatedAt = Math.round(number(raw.updatedAt ?? raw.updated_at, createdAt, Number.MAX_SAFE_INTEGER, createdAt));
  let remainingAudio = QIANMU_VIDEO_POSTPRODUCTION_LIMITS.totalAudio;
  const audio = Object.fromEntries(QIANMU_VIDEO_AUDIO_ROLES.map((role) => {
    const items = (Array.isArray(rawAudio[role]) ? rawAudio[role] : [])
      .slice(0, Math.min(QIANMU_VIDEO_POSTPRODUCTION_LIMITS.audioPerRole, remainingAudio))
      .map((item, index) => normalizeAudioItem(item, role, index, durationMs));
    remainingAudio -= items.length;
    return [role, items];
  }));
  const mixRaw = plain(raw.mix) ? raw.mix : {};
  return {
    schema: QIANMU_VIDEO_POSTPRODUCTION_SCHEMA,
    timelineId: stableId(raw.timelineId || raw.timeline_id) || context.timelineId,
    owner: { chatKey: text(rawOwner.chatKey || rawOwner.chat_key, 512) || context.chatKey },
    durationMs,
    mode: raw.mode === 'layered' ? 'layered' : 'native_only',
    transitions: (Array.isArray(raw.transitions) ? raw.transitions : []).slice(0, QIANMU_VIDEO_POSTPRODUCTION_LIMITS.transitions)
      .map(normalizeTransition),
    subtitles: (Array.isArray(raw.subtitles) ? raw.subtitles : []).slice(0, QIANMU_VIDEO_POSTPRODUCTION_LIMITS.subtitles)
      .map((item, index) => normalizeSubtitle(item, index, durationMs)),
    audio,
    mix: {
      nativeAudio: 'timeline',
      duckMusicOnDialogue: mixRaw.duckMusicOnDialogue !== false && mixRaw.duck_music_on_dialogue !== false,
      masterGainDb: Number(number(mixRaw.masterGainDb ?? mixRaw.master_gain_db, -24, 6, 0).toFixed(2)),
    },
    createdAt,
    updatedAt,
  };
}

export function validateVideoPostproduction(value = {}, timelineValue = {}) {
  const raw = plain(value) ? value : {};
  const context = timelineContext(timelineValue);
  const project = normalizeVideoPostproduction(raw, timelineValue);
  const issues = [];
  if (!project.timelineId) issues.push('postproduction_timeline_missing');
  if (!project.owner.chatKey) issues.push('postproduction_owner_missing');
  if (context.timelineId && project.timelineId !== context.timelineId) issues.push('postproduction_timeline_mismatch');
  if (context.chatKey && project.owner.chatKey !== context.chatKey) issues.push('postproduction_owner_mismatch');
  if (!project.durationMs) issues.push('postproduction_duration_missing');
  if (raw.mode && !['native_only', 'layered'].includes(raw.mode)) issues.push('postproduction_mode_invalid');
  if (Array.isArray(raw.transitions) && raw.transitions.length > QIANMU_VIDEO_POSTPRODUCTION_LIMITS.transitions) issues.push('postproduction_transition_limit_exceeded');
  if (Array.isArray(raw.subtitles) && raw.subtitles.length > QIANMU_VIDEO_POSTPRODUCTION_LIMITS.subtitles) issues.push('postproduction_subtitle_limit_exceeded');
  const transitionIds = new Set();
  const boundaries = new Set();
  project.transitions.forEach((transition, index) => {
    if (!transition.fromClipId || !transition.toClipId) issues.push(`postproduction_transition_source_missing:${index}`);
    const boundary = `${transition.fromClipId}\n${transition.toClipId}`;
    if (context.clipIds.length && !context.adjacent.has(boundary)) issues.push(`postproduction_transition_not_adjacent:${index}`);
    if (transitionIds.has(transition.transitionId)) issues.push(`postproduction_transition_id_duplicate:${index}`);
    transitionIds.add(transition.transitionId);
    if (boundaries.has(boundary)) issues.push(`postproduction_transition_boundary_duplicate:${index}`);
    boundaries.add(boundary);
    const maximum = Math.min(context.clipDurations.get(transition.fromClipId) || 2000, context.clipDurations.get(transition.toClipId) || 2000, 2000);
    if (transition.type !== 'cut' && transition.durationMs > maximum) issues.push(`postproduction_transition_duration_exceeded:${index}`);
    const sourceType = raw.transitions?.[index]?.type;
    if (sourceType && !QIANMU_VIDEO_TRANSITION_TYPES.includes(sourceType)) issues.push(`postproduction_transition_type_invalid:${index}`);
  });
  const subtitleIds = new Set();
  project.subtitles.forEach((cue, index) => {
    const sourceKind = raw.subtitles?.[index]?.kind;
    if (sourceKind && !['dialogue', 'narration', 'caption'].includes(sourceKind)) issues.push(`postproduction_subtitle_kind_invalid:${index}`);
    if (!cue.text) issues.push(`postproduction_subtitle_text_missing:${index}`);
    if (cue.endMs <= cue.startMs) issues.push(`postproduction_subtitle_range_invalid:${index}`);
    if (subtitleIds.has(cue.cueId)) issues.push(`postproduction_subtitle_id_duplicate:${index}`);
    subtitleIds.add(cue.cueId);
  });
  const audioIds = new Set();
  let totalAudio = 0;
  if (plain(raw.audio)) {
    for (const role of Object.keys(raw.audio)) if (!QIANMU_VIDEO_AUDIO_ROLES.includes(role)) issues.push(`postproduction_audio_role_invalid:${text(role, 80) || 'empty'}`);
  }
  for (const role of QIANMU_VIDEO_AUDIO_ROLES) {
    const rawItems = Array.isArray(raw.audio?.[role]) ? raw.audio[role] : [];
    if (rawItems.length > QIANMU_VIDEO_POSTPRODUCTION_LIMITS.audioPerRole) issues.push(`postproduction_audio_role_limit_exceeded:${role}`);
    totalAudio += rawItems.length;
    project.audio[role].forEach((item, index) => {
      if (!item.source.assetId) issues.push(`postproduction_audio_source_missing:${role}:${index}`);
      if (item.endMs <= item.startMs) issues.push(`postproduction_audio_range_invalid:${role}:${index}`);
      if (audioIds.has(item.audioId)) issues.push(`postproduction_audio_id_duplicate:${role}:${index}`);
      audioIds.add(item.audioId);
    });
  }
  if (totalAudio > QIANMU_VIDEO_POSTPRODUCTION_LIMITS.totalAudio) issues.push('postproduction_audio_limit_exceeded');
  project.mode = issues.length ? 'native_only' : project.mode;
  return { ok: issues.length === 0, issues: [...new Set(issues)], project };
}

export function createEmptyVideoPostproduction(timelineValue = {}) {
  return normalizeVideoPostproduction({}, timelineValue);
}
