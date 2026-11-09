// 千幕影片时间线纯数据合同。只编排稳定本地引用，不读取媒体、不联网、不执行转码。

export const QIANMU_VIDEO_TIMELINE_SCHEMA = 'qianmu.video-timeline.v1';
export const QIANMU_VIDEO_TIMELINE_MAX_CLIPS = 120;

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

function owner(value = {}) {
  const raw = plain(value) ? value : {};
  const floorValue = raw.floor;
  const floorNumber = Number(floorValue);
  return {
    chatKey: text(raw.chatKey || raw.chat_key, 512),
    floor: floorValue !== '' && floorValue !== null && floorValue !== undefined && Number.isInteger(floorNumber) && floorNumber >= 0
      ? Math.min(1_000_000, floorNumber) : null,
    messageId: stableId(raw.messageId || raw.message_id),
  };
}

function normalizeClip(value = {}, index = 0) {
  const raw = plain(value) ? value : {};
  const kind = raw.kind === 'motion' ? 'motion' : 'still';
  const source = plain(raw.source) ? raw.source : {};
  const durationSeconds = number(raw.playback?.durationSeconds ?? raw.playback?.duration_seconds ?? raw.durationSeconds, 0.1, 3600, kind === 'motion' ? 0.1 : 3);
  return {
    clipId: stableId(raw.clipId || raw.clip_id) || `clip-${index + 1}`,
    kind,
    title: text(raw.title, 160),
    source: {
      assetId: kind === 'motion' ? stableId(source.assetId || source.asset_id) : '',
      recordId: stableId(source.recordId || source.record_id),
      posterRecordId: stableId(source.posterRecordId || source.poster_record_id),
    },
    owner: owner(raw.owner),
    playback: {
      durationSeconds,
      audio: kind === 'motion' && raw.playback?.audio !== 'mute' ? 'native' : 'mute',
    },
  };
}

export function normalizeVideoTimeline(value = {}) {
  const raw = plain(value) ? value : {};
  const rawClips = Array.isArray(raw.clips) ? raw.clips.slice(0, QIANMU_VIDEO_TIMELINE_MAX_CLIPS) : [];
  const clips = rawClips.map(normalizeClip);
  const timelineOwner = owner(raw.owner);
  const createdAt = Math.round(number(raw.createdAt || raw.created_at, 0, Number.MAX_SAFE_INTEGER));
  const updatedAt = Math.round(number(raw.updatedAt || raw.updated_at, createdAt, Number.MAX_SAFE_INTEGER, createdAt));
  return {
    schema: QIANMU_VIDEO_TIMELINE_SCHEMA,
    timelineId: stableId(raw.timelineId || raw.timeline_id),
    title: text(raw.title, 160),
    owner: timelineOwner,
    status: raw.status === 'ready' ? 'ready' : 'draft',
    playbackMode: 'sequential',
    clips,
    durationSeconds: Number(clips.reduce((sum, clip) => sum + clip.playback.durationSeconds, 0).toFixed(3)),
    createdAt,
    updatedAt,
  };
}

export function validateVideoTimeline(value = {}) {
  const timeline = normalizeVideoTimeline(value);
  const issues = [];
  if (!timeline.timelineId) issues.push('timeline_id_missing');
  if (!timeline.owner.chatKey) issues.push('timeline_owner_missing');
  if (!timeline.clips.length) issues.push('timeline_clips_missing');
  const clipIds = new Set();
  timeline.clips.forEach((clip, index) => {
    if (!clip.clipId) issues.push(`timeline_clip_id_missing:${index}`);
    else if (clipIds.has(clip.clipId)) issues.push(`timeline_clip_id_duplicate:${index}`);
    else clipIds.add(clip.clipId);
    if (timeline.owner.chatKey && clip.owner.chatKey !== timeline.owner.chatKey) issues.push(`timeline_clip_owner_mismatch:${index}`);
    if (clip.kind === 'motion' && (!clip.source.assetId || !clip.source.recordId)) issues.push(`timeline_motion_source_invalid:${index}`);
    if (clip.kind === 'still' && !clip.source.recordId) issues.push(`timeline_still_source_invalid:${index}`);
  });
  return { ok: issues.length === 0, issues: [...new Set(issues)], timeline };
}

function motionSource(value = {}) {
  const raw = plain(value) ? value : {};
  return {
    assetId: stableId(raw.assetId || raw.asset_id),
    recordId: stableId(raw.recordId || raw.record_id),
    sourceRecordId: stableId(raw.sourceRecordId || raw.source_record_id),
    owner: owner(raw.owner),
    durationSeconds: number(raw.technical?.durationSeconds ?? raw.durationSeconds, 0.1, 3600, 0.1),
  };
}

function stillSource(value = {}) {
  const raw = plain(value) ? value : {};
  return {
    recordId: stableId(raw.id || raw.recordId || raw.record_id),
    owner: owner({
      chatKey: raw.chatKey || raw.chat_key,
      floor: raw.floor,
      messageId: raw.messageId || raw.message_id,
    }),
  };
}

export function buildVideoTimeline(value = {}, options = {}) {
  const raw = plain(value) ? value : {};
  const timelineOwner = owner(raw.owner);
  const motion = new Map((Array.isArray(raw.motionItems) ? raw.motionItems : [])
    .map(motionSource).filter((item) => item.assetId).map((item) => [item.assetId, item]));
  const stills = new Map((Array.isArray(raw.stillRecords) ? raw.stillRecords : [])
    .map(stillSource).filter((item) => item.recordId).map((item) => [item.recordId, item]));
  const selections = Array.isArray(raw.selections) ? raw.selections : [];
  const issues = [];
  if (!timelineOwner.chatKey) issues.push('timeline_owner_missing');
  if (!selections.length) issues.push('timeline_clips_missing');
  if (selections.length > QIANMU_VIDEO_TIMELINE_MAX_CLIPS) issues.push('timeline_clip_limit_exceeded');
  const defaultStillDuration = number(options.defaultStillDuration ?? options.default_still_duration, 1, 30, 3);
  const clips = [];

  selections.slice(0, QIANMU_VIDEO_TIMELINE_MAX_CLIPS).forEach((selectionValue, index) => {
    const selection = plain(selectionValue) ? selectionValue : {};
    const kind = selection.kind === 'still' ? 'still' : selection.kind === 'motion' ? 'motion' : '';
    if (!kind) { issues.push(`timeline_clip_kind_invalid:${index}`); return; }
    const sourceId = stableId(selection.assetId || selection.asset_id || selection.recordId || selection.record_id);
    if (!sourceId) { issues.push(`timeline_clip_source_missing:${index}`); return; }
    const source = kind === 'motion' ? motion.get(sourceId) : stills.get(sourceId);
    if (!source) { issues.push(`timeline_clip_not_found:${index}`); return; }
    if (!timelineOwner.chatKey || source.owner.chatKey !== timelineOwner.chatKey) {
      issues.push(`timeline_clip_owner_mismatch:${index}`);
      return;
    }
    const durationSeconds = kind === 'motion'
      ? source.durationSeconds
      : number(selection.durationSeconds || selection.duration_seconds, 1, 30, defaultStillDuration);
    const sourceKey = kind === 'motion' ? source.assetId : source.recordId;
    clips.push(normalizeClip({
      clipId: stableId(selection.clipId || selection.clip_id) || `clip-${hash(`${timelineOwner.chatKey}\n${kind}\n${sourceKey}\n${index}`)}`,
      kind,
      title: selection.title || (Number.isInteger(source.owner.floor) ? `第 ${source.owner.floor} 层` : ''),
      source: kind === 'motion'
        ? { assetId: source.assetId, recordId: source.recordId, posterRecordId: source.sourceRecordId }
        : { recordId: source.recordId, posterRecordId: source.recordId },
      owner: source.owner,
      playback: { durationSeconds, audio: kind === 'motion' && selection.audio !== 'mute' ? 'native' : 'mute' },
    }, index));
  });

  const now = Math.round(number(options.now, 0, Number.MAX_SAFE_INTEGER, Date.now()));
  const timeline = normalizeVideoTimeline({
    timelineId: stableId(raw.timelineId || raw.timeline_id) || `timeline-${hash(`${timelineOwner.chatKey}\n${clips.map((clip) => clip.clipId).join('\n')}`)}`,
    title: raw.title,
    owner: timelineOwner,
    status: issues.length === 0 && clips.length > 0 ? 'ready' : 'draft',
    clips,
    createdAt: now,
    updatedAt: now,
  });
  const validation = validateVideoTimeline(timeline);
  const allIssues = [...new Set([...issues, ...validation.issues])];
  validation.timeline.status = allIssues.length === 0 ? 'ready' : 'draft';
  return { ok: allIssues.length === 0, issues: allIssues, timeline: validation.timeline };
}

export function moveVideoTimelineClip(value = {}, fromIndex, toIndex, options = {}) {
  const timeline = normalizeVideoTimeline(value);
  const from = Number(fromIndex);
  const to = Number(toIndex);
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < 0 || from >= timeline.clips.length || to >= timeline.clips.length) {
    return { ok: false, issue: 'timeline_reorder_out_of_range', timeline };
  }
  if (from !== to) {
    const [clip] = timeline.clips.splice(from, 1);
    timeline.clips.splice(to, 0, clip);
  }
  timeline.updatedAt = Math.round(number(options.now, timeline.createdAt, Number.MAX_SAFE_INTEGER, Date.now()));
  return { ok: true, issue: '', timeline: normalizeVideoTimeline(timeline) };
}
