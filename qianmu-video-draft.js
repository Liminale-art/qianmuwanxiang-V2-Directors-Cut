// 千幕动态镜头本地草稿合同。只保存编辑选择与稳定素材引用，不包含提示词、凭据、媒体或报价。
import {
  QIANMU_H3_ASPECT_RATIOS,
  QIANMU_H3_ROUTE_MODES,
  createVideoShotFromStoryboardFrames,
} from './qianmu-video-contract.js';

export const QIANMU_VIDEO_DRAFT_SCHEMA = 'qianmu.video-draft.v1';
export const QIANMU_VIDEO_DRAFT_SOURCE_KINDS = Object.freeze([
  'storyboard_frame',
  'inline_frame',
  'director_frame',
  'blank',
]);
export const QIANMU_VIDEO_DRAFT_TRACKS = Object.freeze(['main_camera', 'second_camera']);
export const QIANMU_VIDEO_DRAFT_RESOLUTIONS = Object.freeze(['768p', '2k']);

const plain = (value) => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const text = (value, max = 1000) => String(value ?? '').trim().slice(0, max);
const finite = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const integer = (value, min, max, fallback = min) => Math.min(max, Math.max(min, Math.round(finite(value, fallback))));
const stableId = (value, max = 200) => {
  const result = text(value, max);
  return /^[A-Za-z0-9._:-]+$/.test(result) ? result : '';
};
const uniqueIds = (value, max = 32) => [...new Set((Array.isArray(value) ? value : [])
  .map((item) => stableId(item)).filter(Boolean))].slice(0, max);

function hash(value) {
  let result = 2166136261;
  for (const char of String(value || '')) {
    result ^= char.charCodeAt(0);
    result = Math.imul(result, 16777619);
  }
  return (result >>> 0).toString(16).padStart(8, '0');
}

function nullableFloor(value) {
  if (value === '' || value === null || value === undefined) return null;
  const floor = Number(value);
  return Number.isInteger(floor) && floor >= 0 ? Math.min(1_000_000, floor) : null;
}

function normalizeOwner(value = {}) {
  const raw = plain(value) ? value : {};
  return {
    chatKey: text(raw.chatKey || raw.chat_key, 512),
    floor: nullableFloor(raw.floor),
    messageId: stableId(raw.messageId || raw.message_id),
    paragraphAnchorId: stableId(raw.paragraphAnchorId || raw.paragraph_anchor_id),
  };
}

function normalizedRoleMap(value = {}) {
  const raw = plain(value) ? value : {};
  return Object.fromEntries(Object.entries(raw).slice(0, 32).flatMap(([recordId, roles]) => {
    const id = stableId(recordId);
    const allowed = [...new Set((Array.isArray(roles) ? roles : [])
      .map((item) => text(item, 80))
      .filter((role) => ['subject_reference', 'style_reference', 'motion_reference'].includes(role)))].slice(0, 3);
    return id && allowed.length ? [[id, allowed]] : [];
  }));
}

function normalizedSubjectLabels(value = {}) {
  const raw = plain(value) ? value : {};
  return Object.fromEntries(Object.entries(raw).slice(0, 16).flatMap(([recordId, label]) => {
    const id = stableId(recordId);
    const normalized = text(label, 80);
    return id && /^<Subject [1-9]\d*>$/.test(normalized) ? [[id, normalized]] : [];
  }));
}

export function normalizeVideoDraft(value = {}) {
  const raw = plain(value) ? value : {};
  const owner = normalizeOwner(raw.owner || raw.timelineAnchor || raw.timeline_anchor);
  const sourceRaw = plain(raw.source) ? raw.source : {};
  const selectionRaw = plain(raw.selection) ? raw.selection : {};
  const settingsRaw = plain(raw.settings) ? raw.settings : {};
  const timingRaw = plain(raw.timing) ? raw.timing : {};
  const sourceKind = QIANMU_VIDEO_DRAFT_SOURCE_KINDS.includes(sourceRaw.kind) ? sourceRaw.kind : 'blank';
  const sourceRecordId = stableId(sourceRaw.recordId || sourceRaw.record_id);
  const createdAt = Math.max(0, Math.round(finite(timingRaw.createdAt || timingRaw.created_at || raw.createdAt || raw.created_at)));
  const draftSeed = `${owner.chatKey}|${owner.floor ?? ''}|${sourceKind}|${sourceRecordId}|${createdAt}`;
  const firstRecordId = stableId(selectionRaw.firstRecordId || selectionRaw.first_record_id);
  const lastRecordId = stableId(selectionRaw.lastRecordId || selectionRaw.last_record_id);
  const referenceRecordIds = uniqueIds(selectionRaw.referenceRecordIds || selectionRaw.reference_record_ids);
  return {
    schema: QIANMU_VIDEO_DRAFT_SCHEMA,
    draftId: stableId(raw.draftId || raw.draft_id || raw.id) || `video-draft-${hash(draftSeed)}`,
    revision: integer(raw.revision, 1, 9999, 1),
    owner,
    source: {
      kind: sourceKind,
      track: QIANMU_VIDEO_DRAFT_TRACKS.includes(sourceRaw.track) ? sourceRaw.track : 'main_camera',
      recordId: sourceRecordId,
      sourceShotId: stableId(sourceRaw.sourceShotId || sourceRaw.source_shot_id),
    },
    selection: {
      firstRecordId,
      lastRecordId,
      referenceRecordIds,
      referenceRoles: normalizedRoleMap(selectionRaw.referenceRoles || selectionRaw.reference_roles),
      subjectLabels: normalizedSubjectLabels(selectionRaw.subjectLabels || selectionRaw.subject_labels),
    },
    settings: {
      requestedMode: QIANMU_H3_ROUTE_MODES.includes(settingsRaw.requestedMode || settingsRaw.requested_mode)
        ? (settingsRaw.requestedMode || settingsRaw.requested_mode) : 'auto',
      durationSeconds: integer(settingsRaw.durationSeconds ?? settingsRaw.duration_seconds, 4, 15, 6),
      resolution: QIANMU_VIDEO_DRAFT_RESOLUTIONS.includes(String(settingsRaw.resolution || '').toLowerCase())
        ? String(settingsRaw.resolution).toLowerCase() : '768p',
      aspectRatio: QIANMU_H3_ASPECT_RATIOS.includes(String(settingsRaw.aspectRatio || settingsRaw.aspect_ratio || '').toLowerCase())
        ? String(settingsRaw.aspectRatio || settingsRaw.aspect_ratio).toLowerCase() : (sourceRecordId ? 'adaptive' : '16:9'),
      fps: integer(settingsRaw.fps, 1, 60, 24),
    },
    direction: text(raw.direction || raw.userDirection || raw.user_direction, 1600),
    timing: {
      createdAt,
      updatedAt: Math.max(createdAt, Math.round(finite(timingRaw.updatedAt || timingRaw.updated_at || raw.updatedAt || raw.updated_at, createdAt))),
    },
  };
}

export function createVideoDraftFromStoryboardFrame(recordValue = {}, options = {}) {
  const record = plain(recordValue) ? recordValue : {};
  const config = plain(options) ? options : {};
  const recordId = stableId(record.id || record.recordId || record.record_id);
  const chatKey = text(record.chatKey || record.messageRef?.chatKey || config.chatKey || config.chat_key, 512);
  const now = Math.max(0, Math.round(finite(config.now, Date.now())));
  const loop = config.loop === true;
  return normalizeVideoDraft({
    draftId: config.draftId || config.draft_id,
    owner: {
      chatKey,
      floor: record.floor ?? config.floor,
      messageId: record.messageId || record.messageRef?.messageId || config.messageId,
      paragraphAnchorId: record.paragraphAnchorId || record.paragraph_anchor_id || config.paragraphAnchorId,
    },
    source: {
      kind: QIANMU_VIDEO_DRAFT_SOURCE_KINDS.includes(config.sourceKind || config.source_kind)
        ? (config.sourceKind || config.source_kind) : 'storyboard_frame',
      track: record.productionTrack || record.production_track || config.track,
      recordId,
      sourceShotId: record.sourceShotId || record.source_shot_id || record.shotId || record.shot_id,
    },
    selection: {
      firstRecordId: recordId,
      lastRecordId: loop ? recordId : '',
      referenceRecordIds: config.referenceRecordIds || config.reference_record_ids,
    },
    settings: {
      requestedMode: loop ? 'fl2va' : (config.requestedMode || config.requested_mode || 'auto'),
      durationSeconds: config.durationSeconds || config.duration_seconds,
      resolution: config.resolution,
      aspectRatio: config.aspectRatio || config.aspect_ratio || 'adaptive',
      fps: config.fps,
    },
    timing: { createdAt: now, updatedAt: now },
  });
}

export function reviseVideoDraft(currentValue = {}, patchValue = {}, options = {}) {
  const current = normalizeVideoDraft(currentValue);
  const patch = plain(patchValue) ? patchValue : {};
  const candidate = normalizeVideoDraft({
    ...current,
    ...patch,
    draftId: current.draftId,
    owner: { ...current.owner, ...(plain(patch.owner) ? patch.owner : {}) },
    source: { ...current.source, ...(plain(patch.source) ? patch.source : {}) },
    selection: { ...current.selection, ...(plain(patch.selection) ? patch.selection : {}) },
    settings: { ...current.settings, ...(plain(patch.settings) ? patch.settings : {}) },
    revision: current.revision + 1,
    timing: { ...current.timing, updatedAt: Math.max(current.timing.updatedAt, Math.round(finite(options.now, Date.now()))) },
  });
  if (candidate.owner.chatKey !== current.owner.chatKey) return { ok: false, issue: 'draft_owner_immutable', draft: current };
  return { ok: true, issue: '', draft: candidate };
}

export function validateVideoDraft(value = {}) {
  const draft = normalizeVideoDraft(value);
  const issues = [];
  if (!draft.draftId) issues.push('draft_id_missing');
  if (!draft.owner.chatKey) issues.push('owner_chat_missing');
  if (draft.source.kind !== 'blank' && !draft.source.recordId) issues.push('source_record_missing');
  const selected = new Set([
    draft.selection.firstRecordId,
    draft.selection.lastRecordId,
    ...draft.selection.referenceRecordIds,
  ].filter(Boolean));
  if (draft.source.recordId && !selected.has(draft.source.recordId)) issues.push('source_record_not_selected');
  return { ok: issues.length === 0, issues: [...new Set(issues)], draft };
}

export function compileVideoDraftSelection(value = {}, recordsValue = []) {
  const validation = validateVideoDraft(value);
  const draft = validation.draft;
  const records = (Array.isArray(recordsValue) ? recordsValue : []).filter(plain);
  const requestedIds = [...new Set([
    draft.selection.firstRecordId,
    draft.selection.lastRecordId,
    ...draft.selection.referenceRecordIds,
  ].filter(Boolean))];
  const recordById = new Map();
  const issues = [...validation.issues];
  for (const record of records) {
    const recordId = stableId(record.id || record.recordId || record.record_id);
    if (!recordId || !requestedIds.includes(recordId)) continue;
    const explicitChat = text(record.chatKey || record.messageRef?.chatKey, 512);
    if (explicitChat && explicitChat !== draft.owner.chatKey) {
      issues.push(`record_owner_mismatch:${recordId}`);
      continue;
    }
    recordById.set(recordId, { ...record, chatKey: explicitChat || draft.owner.chatKey });
  }
  for (const recordId of requestedIds) if (!recordById.has(recordId) && !issues.includes(`record_owner_mismatch:${recordId}`)) issues.push(`record_missing:${recordId}`);
  const usable = requestedIds.map((recordId) => recordById.get(recordId)).filter(Boolean);
  const built = createVideoShotFromStoryboardFrames({
    sourceShotId: draft.source.sourceShotId,
    timelineAnchor: draft.owner,
    durationSeconds: draft.settings.durationSeconds,
    resolution: draft.settings.resolution,
    aspectRatio: draft.settings.aspectRatio,
    fps: draft.settings.fps,
    intent: { summary: draft.direction },
  }, usable, {
    chatKey: draft.owner.chatKey,
    shotId: draft.source.sourceShotId || `video-shot-${hash(draft.draftId)}`,
    sourceShotId: draft.source.sourceShotId,
    firstRecordId: draft.selection.firstRecordId,
    lastRecordId: draft.selection.lastRecordId,
    referenceRecordIds: draft.selection.referenceRecordIds,
    referenceRoles: draft.selection.referenceRoles,
    subjectLabels: draft.selection.subjectLabels,
    requestedMode: draft.settings.requestedMode,
  });
  if (!built.spec.route.ready) issues.push(...built.spec.route.missingRequirements.map((item) => `route_input_missing:${item}`));
  return {
    schema: QIANMU_VIDEO_DRAFT_SCHEMA,
    ok: issues.length === 0,
    issues: [...new Set(issues)],
    readyForPrompt: issues.length === 0,
    readyForSubmission: false,
    draft,
    spec: built.spec,
    manifest: built.manifest,
  };
}
