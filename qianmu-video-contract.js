// 千幕动态镜头合同。纯数据层：不访问 DOM、设置、聊天、网络或媒体二进制。
export const QIANMU_VIDEO_SHOT_SCHEMA = 'qianmu.video-shot.v1';
export const QIANMU_MULTIMODAL_MANIFEST_SCHEMA = 'qianmu.multimodal-asset-manifest.v1';
export const QIANMU_H3_MODES = Object.freeze(['t2va', 'i2va', 'fl2va', 'l2va', 'ref2va']);
export const QIANMU_H3_ROUTE_MODES = Object.freeze(['auto', ...QIANMU_H3_MODES]);
export const QIANMU_H3_MODE_FAMILIES = Object.freeze({
  t2va: 'fl2va',
  i2va: 'fl2va',
  fl2va: 'fl2va',
  l2va: 'fl2va',
  ref2va: 'ref2va',
});
export const QIANMU_VIDEO_ASSET_ROLES = Object.freeze([
  'first_frame',
  'last_frame',
  'subject_reference',
  'style_reference',
  'motion_reference',
  'video_reference',
  'audio_reference',
]);

const ASSET_KINDS = Object.freeze(['image', 'video', 'audio']);
const LOCATOR_KINDS = Object.freeze(['indexeddb', 'gallery', 'chat', 'remote', 'upload']);
const RIGHTS_STATES = Object.freeze(['unknown', 'owned', 'licensed', 'consented', 'restricted']);
const UPLOAD_STATES = Object.freeze(['local', 'pending', 'uploading', 'ready', 'failed', 'expired']);
const RESOLUTIONS = Object.freeze(['768p', '2k']);

const plain = (value) => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const text = (value, max = 2000) => String(value ?? '').trim().slice(0, max);
const finite = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const clamp = (value, min, max, fallback = min) => Math.min(max, Math.max(min, finite(value, fallback)));
const boolOrNull = (value) => value == null ? null : Boolean(value);
const unique = (value, max = 40, itemMax = 240) => Array.isArray(value)
  ? [...new Set(value.map((item) => text(item, itemMax)).filter(Boolean))].slice(0, max)
  : [];

function hash(value) {
  let result = 2166136261;
  for (const char of String(value || '')) {
    result ^= char.charCodeAt(0);
    result = Math.imul(result, 16777619);
  }
  return (result >>> 0).toString(16).padStart(8, '0');
}

function safeLocatorRef(value) {
  const ref = text(value, 2048);
  return /^(?:data|blob):/i.test(ref) ? '' : ref;
}

function normalizeTimelineAnchor(value = {}) {
  const raw = plain(value) ? value : {};
  const floor = Number(raw.floor);
  return {
    chatKey: text(raw.chatKey || raw.chat_key, 512),
    floor: Number.isInteger(floor) && floor >= 0 ? floor : null,
    messageId: text(raw.messageId || raw.message_id, 200),
    paragraphAnchorId: text(raw.paragraphAnchorId || raw.paragraph_anchor_id, 200),
  };
}

function normalizeAsset(value, index = 0) {
  const raw = plain(value) ? value : {};
  const kind = ASSET_KINDS.includes(raw.kind) ? raw.kind : 'image';
  const roles = unique(raw.roles || (raw.role ? [raw.role] : []), QIANMU_VIDEO_ASSET_ROLES.length, 80)
    .filter((role) => QIANMU_VIDEO_ASSET_ROLES.includes(role));
  const locatorRaw = plain(raw.locator) ? raw.locator : {};
  const locatorKind = LOCATOR_KINDS.includes(locatorRaw.kind) ? locatorRaw.kind : 'indexeddb';
  const locatorRef = safeLocatorRef(locatorRaw.ref || raw.storageRef || raw.storage_ref);
  const sourceRaw = plain(raw.sourceRef || raw.source_ref) ? (raw.sourceRef || raw.source_ref) : {};
  const rightsRaw = plain(raw.rights) ? raw.rights : {};
  const technicalRaw = plain(raw.technical) ? raw.technical : {};
  const uploadRaw = plain(raw.upload) ? raw.upload : {};
  const id = text(raw.assetId || raw.asset_id || raw.id, 200)
    || `asset-${hash(`${kind}|${locatorKind}|${locatorRef}|${index}`)}`;
  const subjectLabel = /^<Subject [1-9]\d*>$/.test(text(raw.subjectLabel || raw.subject_label, 80))
    ? text(raw.subjectLabel || raw.subject_label, 80)
    : '';
  return {
    assetId: id,
    kind,
    roles,
    subjectLabel,
    fingerprint: text(raw.fingerprint || raw.sha256, 200),
    locator: { kind: locatorKind, ref: locatorRef },
    sourceRef: {
      type: text(sourceRaw.type, 80),
      chatKey: text(sourceRaw.chatKey || sourceRaw.chat_key, 512),
      floor: Number.isInteger(Number(sourceRaw.floor)) && Number(sourceRaw.floor) >= 0 ? Number(sourceRaw.floor) : null,
      recordId: text(sourceRaw.recordId || sourceRaw.record_id, 200),
      versionId: text(sourceRaw.versionId || sourceRaw.version_id, 200),
    },
    rights: {
      status: RIGHTS_STATES.includes(rightsRaw.status) ? rightsRaw.status : 'unknown',
      attribution: text(rightsRaw.attribution, 1000),
      commercialAllowed: boolOrNull(rightsRaw.commercialAllowed ?? rightsRaw.commercial_allowed),
      personConsent: boolOrNull(rightsRaw.personConsent ?? rightsRaw.person_consent),
    },
    technical: {
      mimeType: text(technicalRaw.mimeType || technicalRaw.mime_type, 120),
      width: Math.max(0, Math.round(finite(technicalRaw.width, 0))),
      height: Math.max(0, Math.round(finite(technicalRaw.height, 0))),
      durationSeconds: Math.max(0, finite(technicalRaw.durationSeconds || technicalRaw.duration_seconds, 0)),
      bytes: Math.max(0, Math.round(finite(technicalRaw.bytes, 0))),
    },
    upload: {
      state: UPLOAD_STATES.includes(uploadRaw.state) ? uploadRaw.state : 'local',
      providerId: text(uploadRaw.providerId || uploadRaw.provider_id, 120),
      remoteId: text(uploadRaw.remoteId || uploadRaw.remote_id, 300),
      expiresAt: Math.max(0, Math.round(finite(uploadRaw.expiresAt || uploadRaw.expires_at, 0))),
      error: text(uploadRaw.error, 1000),
    },
  };
}

function mergeDuplicateAsset(current, incoming) {
  return {
    ...current,
    roles: [...new Set([...current.roles, ...incoming.roles])],
    subjectLabel: current.subjectLabel || incoming.subjectLabel,
  };
}

export function normalizeMultimodalAssetManifest(value = {}) {
  const raw = plain(value) ? value : {};
  const assets = [];
  const byIdentity = new Map();
  for (const [index, rawAsset] of (Array.isArray(raw.assets) ? raw.assets : []).slice(0, 64).entries()) {
    const asset = normalizeAsset(rawAsset, index);
    const identity = asset.fingerprint ? `fingerprint:${asset.fingerprint}` : `id:${asset.assetId}`;
    if (byIdentity.has(identity)) {
      const position = byIdentity.get(identity);
      assets[position] = mergeDuplicateAsset(assets[position], asset);
      continue;
    }
    byIdentity.set(identity, assets.length);
    assets.push(asset);
  }
  const budgetRaw = plain(raw.budget) ? raw.budget : {};
  const duration = assets.reduce((sum, asset) => sum + asset.technical.durationSeconds, 0);
  const bytes = assets.reduce((sum, asset) => sum + asset.technical.bytes, 0);
  const seed = `${text(raw.shotId || raw.shot_id, 200)}|${assets.map((asset) => asset.assetId).join('|')}`;
  return {
    schema: QIANMU_MULTIMODAL_MANIFEST_SCHEMA,
    manifestId: text(raw.manifestId || raw.manifest_id, 200) || `manifest-${hash(seed)}`,
    shotId: text(raw.shotId || raw.shot_id, 200),
    assets,
    budget: {
      maxAssets: Math.round(clamp(budgetRaw.maxAssets ?? budgetRaw.max_assets, 1, 64, 16)),
      maxImages: Math.round(clamp(budgetRaw.maxImages ?? budgetRaw.max_images, 0, 48, 12)),
      maxVideos: Math.round(clamp(budgetRaw.maxVideos ?? budgetRaw.max_videos, 0, 16, 4)),
      maxAudio: Math.round(clamp(budgetRaw.maxAudio ?? budgetRaw.max_audio, 0, 24, 8)),
      maxReferenceDurationSeconds: clamp(budgetRaw.maxReferenceDurationSeconds ?? budgetRaw.max_reference_duration_seconds, 0, 3600, 60),
    },
    usage: {
      assets: assets.length,
      images: assets.filter((asset) => asset.kind === 'image').length,
      videos: assets.filter((asset) => asset.kind === 'video').length,
      audio: assets.filter((asset) => asset.kind === 'audio').length,
      referenceDurationSeconds: duration,
      bytes,
    },
  };
}

export function validateMultimodalAssetManifest(value = {}) {
  const manifest = normalizeMultimodalAssetManifest(value);
  const issues = [];
  for (const key of ['assets', 'images', 'videos', 'audio']) {
    const budgetKey = `max${key[0].toUpperCase()}${key.slice(1)}`;
    if (manifest.usage[key] > manifest.budget[budgetKey]) issues.push(`budget_${key}_exceeded`);
  }
  if (manifest.usage.referenceDurationSeconds > manifest.budget.maxReferenceDurationSeconds) issues.push('budget_duration_exceeded');
  manifest.assets.forEach((asset) => {
    if (!asset.locator.ref && !(asset.upload.state === 'ready' && asset.upload.remoteId)) issues.push(`asset_locator_missing:${asset.assetId}`);
    if (asset.rights.status === 'restricted') issues.push(`asset_rights_restricted:${asset.assetId}`);
    if (asset.subjectLabel && asset.kind !== 'image' && asset.kind !== 'video' && asset.kind !== 'audio') issues.push(`subject_kind_invalid:${asset.assetId}`);
  });
  return { ok: issues.length === 0, issues: [...new Set(issues)], manifest };
}

export function storyboardFrameAssetId(record = {}, fallbackChatKey = '') {
  const raw = plain(record) ? record : {};
  const recordId = text(raw.id || raw.recordId || raw.record_id, 200);
  const chatKey = text(raw.chatKey || raw.messageRef?.chatKey || fallbackChatKey, 512);
  return recordId ? `storyboard-frame-${hash(`${chatKey}|${recordId}`)}` : '';
}

export function buildStoryboardFrameManifest(records = [], options = {}) {
  const config = plain(options) ? options : {};
  const firstRecordId = text(config.firstRecordId || config.first_record_id, 200);
  const lastRecordId = text(config.lastRecordId || config.last_record_id, 200);
  const referenceRecordIds = new Set(unique(config.referenceRecordIds || config.reference_record_ids, 32, 200));
  const referenceRoles = plain(config.referenceRoles || config.reference_roles) ? (config.referenceRoles || config.reference_roles) : {};
  const subjectLabels = plain(config.subjectLabels || config.subject_labels) ? (config.subjectLabels || config.subject_labels) : {};
  const assets = [];
  for (const rawRecord of (Array.isArray(records) ? records : []).filter(plain).slice(0, 64)) {
    const recordId = text(rawRecord.id || rawRecord.recordId || rawRecord.record_id, 200);
    if (!recordId) continue;
    const roles = [];
    if (recordId === firstRecordId) roles.push('first_frame');
    if (recordId === lastRecordId) roles.push('last_frame');
    if (referenceRecordIds.has(recordId)) roles.push('subject_reference');
    unique(referenceRoles[recordId], QIANMU_VIDEO_ASSET_ROLES.length, 80).forEach((role) => roles.push(role));
    const normalizedRoles = [...new Set(roles)].filter((role) => QIANMU_VIDEO_ASSET_ROLES.includes(role));
    if (!normalizedRoles.length) continue;
    const chatKey = text(rawRecord.chatKey || rawRecord.messageRef?.chatKey || config.chatKey || config.chat_key, 512);
    const assetId = storyboardFrameAssetId(rawRecord, chatKey);
    assets.push({
      assetId,
      kind: 'image',
      roles: normalizedRoles,
      subjectLabel: text(subjectLabels[recordId], 80),
      fingerprint: text(rawRecord.assetFingerprint || rawRecord.asset_fingerprint, 200) || `storyboard:${chatKey}:${recordId}`,
      locator: { kind: 'gallery', ref: `${chatKey}\u241f${recordId}` },
      sourceRef: {
        type: 'storyboard_record',
        chatKey,
        floor: rawRecord.floor,
        recordId,
        versionId: rawRecord.variantRootId || rawRecord.variant_root_id || rawRecord.groupId || rawRecord.group_id || rawRecord.taskId || rawRecord.task_id,
      },
      rights: plain(rawRecord.rights) ? rawRecord.rights : { status: 'unknown' },
      technical: {
        mimeType: rawRecord.mimeType || rawRecord.mime_type,
        width: rawRecord.width,
        height: rawRecord.height,
        bytes: rawRecord.bytes,
      },
      upload: { state: 'local' },
    });
  }
  return normalizeMultimodalAssetManifest({
    manifestId: config.manifestId || config.manifest_id,
    shotId: config.shotId || config.shot_id,
    assets,
    budget: config.budget,
  });
}

export function createVideoShotFromStoryboardFrames(shotValue = {}, records = [], options = {}) {
  const config = plain(options) ? options : {};
  const manifest = buildStoryboardFrameManifest(records, config);
  const assetForRecord = (recordId) => manifest.assets.find((asset) => asset.sourceRef.recordId === text(recordId, 200)) || null;
  const first = assetForRecord(config.firstRecordId || config.first_record_id);
  const last = assetForRecord(config.lastRecordId || config.last_record_id);
  const references = new Set(unique(config.referenceRecordIds || config.reference_record_ids, 32, 200));
  const referenceAssetIds = manifest.assets
    .filter((asset) => references.has(asset.sourceRef.recordId)
      || asset.roles.some((role) => ['subject_reference', 'style_reference', 'motion_reference', 'video_reference', 'audio_reference'].includes(role)))
    .map((asset) => asset.assetId);
  const rawShot = plain(shotValue) ? shotValue : {};
  const spec = normalizeVideoShotSpec({
    ...rawShot,
    shotId: config.shotId || config.shot_id || rawShot.shotId || rawShot.shot_id,
    sourceShotId: config.sourceShotId || config.source_shot_id || rawShot.sourceShotId || rawShot.source_shot_id,
    keyframes: { ...(plain(rawShot.keyframes) ? rawShot.keyframes : {}), firstAssetId: first?.assetId || '', lastAssetId: last?.assetId || '' },
    references: { ...(plain(rawShot.references) ? rawShot.references : {}), assetIds: referenceAssetIds },
    requestedMode: config.requestedMode || config.requested_mode || rawShot.requestedMode || rawShot.route?.requestedMode || 'auto',
  }, manifest);
  return { spec, manifest };
}

function normalizeCharacterPerformance(value, index = 0) {
  const raw = plain(value) ? value : {};
  const appearance = plain(raw.appearance) ? raw.appearance : {};
  const performance = plain(raw.performance) ? raw.performance : {};
  const id = text(raw.characterId || raw.character_id || raw.id || raw.name, 160) || `character-${index + 1}`;
  return {
    characterId: id,
    name: text(raw.name || id, 160),
    subjectLabel: /^<Subject [1-9]\d*>$/.test(text(raw.subjectLabel || raw.subject_label, 80)) ? text(raw.subjectLabel || raw.subject_label, 80) : '',
    appearance: {
      identity: unique(appearance.identity, 20, 300),
      wardrobe: unique(appearance.wardrobe, 20, 300),
      physicalState: unique(appearance.physicalState || appearance.physical_state, 20, 300),
    },
    performance: {
      action: text(performance.action || raw.action, 1500),
      expression: text(performance.expression || raw.expression, 600),
      eyeLine: text(performance.eyeLine || performance.eye_line || raw.eyeLine, 400),
      blocking: text(performance.blocking || raw.blocking, 1000),
    },
  };
}

function normalizeBeat(value, durationSeconds, index = 0) {
  const raw = plain(value) ? value : {};
  const start = clamp(raw.startSeconds ?? raw.start_seconds, 0, durationSeconds, 0);
  const end = clamp(raw.endSeconds ?? raw.end_seconds, start, durationSeconds, Math.min(durationSeconds, start + 1));
  return {
    beatId: text(raw.beatId || raw.beat_id || raw.id, 160) || `beat-${index + 1}`,
    startSeconds: start,
    endSeconds: end,
    visual: text(raw.visual || raw.action, 2000),
    camera: text(raw.camera, 1000),
    sound: text(raw.sound, 1000),
  };
}

function normalizeDialogue(value, durationSeconds, index = 0) {
  const raw = plain(value) ? value : {};
  const start = clamp(raw.startSeconds ?? raw.start_seconds, 0, durationSeconds, 0);
  const end = clamp(raw.endSeconds ?? raw.end_seconds, start, durationSeconds, Math.min(durationSeconds, start + 2));
  return {
    dialogueId: text(raw.dialogueId || raw.dialogue_id || raw.id, 160) || `dialogue-${index + 1}`,
    characterId: text(raw.characterId || raw.character_id, 160),
    text: text(raw.text || raw.line, 2000),
    startSeconds: start,
    endSeconds: end,
    delivery: text(raw.delivery, 600),
  };
}

function referencedAssets(spec, manifest) {
  const assetById = new Map(manifest.assets.map((asset) => [asset.assetId, asset]));
  const first = assetById.get(spec.keyframes.firstAssetId) || manifest.assets.find((asset) => asset.roles.includes('first_frame')) || null;
  const last = assetById.get(spec.keyframes.lastAssetId) || manifest.assets.find((asset) => asset.roles.includes('last_frame')) || null;
  const referenceIds = new Set(spec.references.assetIds);
  const references = manifest.assets.filter((asset) => referenceIds.has(asset.assetId)
    || asset.roles.some((role) => ['subject_reference', 'style_reference', 'motion_reference', 'video_reference', 'audio_reference'].includes(role)));
  return { first, last, references };
}

export function resolveH3VideoMode(specValue = {}, manifestValue = {}, requestedMode = 'auto') {
  const spec = plain(specValue) ? specValue : {};
  const manifest = normalizeMultimodalAssetManifest(manifestValue);
  const requested = QIANMU_H3_ROUTE_MODES.includes(requestedMode) ? requestedMode : 'auto';
  const refs = referencedAssets({
    keyframes: plain(spec.keyframes) ? spec.keyframes : { firstAssetId: '', lastAssetId: '' },
    references: plain(spec.references) ? spec.references : { assetIds: [] },
  }, manifest);
  const requirements = {
    t2va: [],
    i2va: refs.first ? [] : ['first_frame'],
    l2va: refs.last ? [] : ['last_frame'],
    fl2va: [...(refs.first ? [] : ['first_frame']), ...(refs.last ? [] : ['last_frame'])],
    ref2va: refs.references.length ? [] : ['reference_asset'],
  };
  let mode = requested;
  let reasonCode = 'manual_override';
  if (requested === 'auto') {
    if (refs.references.length) mode = 'ref2va';
    else if (refs.first && refs.last) mode = 'fl2va';
    else if (refs.first) mode = 'i2va';
    else if (refs.last) mode = 'l2va';
    else mode = 't2va';
    reasonCode = refs.references.length ? 'reference_assets_present'
      : refs.first && refs.last ? 'first_last_frames_present'
        : refs.first ? 'first_frame_present'
          : refs.last ? 'last_frame_present'
            : 'text_only';
  }
  const missingRequirements = requirements[mode];
  const reasons = {
    reference_assets_present: '存在主体、风格、动作、视频或音频参考，使用完整参考模式。',
    first_last_frames_present: '首帧与尾帧齐全，使用首尾帧连续生成。',
    first_frame_present: '仅有首帧，从当前画面向后发展。',
    last_frame_present: '仅有尾帧，反推合理开场并收束至目标画面。',
    text_only: '没有媒体条件，使用纯文本音视频生成。',
    manual_override: '由用户在镜头详情中明确指定模式。',
    manual_override_missing_inputs: '保留用户指定模式，但提交前仍需补齐必要素材。',
  };
  if (requested !== 'auto' && missingRequirements.length) reasonCode = 'manual_override_missing_inputs';
  return {
    requestedMode: requested,
    mode,
    modelFamily: QIANMU_H3_MODE_FAMILIES[mode],
    reasonCode,
    reason: reasons[reasonCode],
    ready: missingRequirements.length === 0,
    missingRequirements,
    inputs: {
      firstFrameAssetId: refs.first?.assetId || '',
      lastFrameAssetId: refs.last?.assetId || '',
      referenceAssetIds: refs.references.map((asset) => asset.assetId),
    },
  };
}

export function normalizeVideoShotSpec(value = {}, manifestValue = {}) {
  const raw = plain(value) ? value : {};
  const durationSeconds = clamp(raw.durationSeconds ?? raw.duration_seconds, 4, 15, 6);
  const keyframesRaw = plain(raw.keyframes) ? raw.keyframes : {};
  const referencesRaw = plain(raw.references) ? raw.references : {};
  const cameraRaw = plain(raw.camera) ? raw.camera : {};
  const audioRaw = plain(raw.audio) ? raw.audio : {};
  const policyRaw = plain(raw.referencePolicy || raw.reference_policy) ? (raw.referencePolicy || raw.reference_policy) : {};
  const ledgerRaw = plain(raw.continuityLedger || raw.continuity_ledger) ? (raw.continuityLedger || raw.continuity_ledger) : {};
  const shotSeed = `${text(raw.sourceShotId || raw.source_shot_id, 200)}|${JSON.stringify(normalizeTimelineAnchor(raw.timelineAnchor || raw.timeline_anchor))}`;
  const spec = {
    schema: QIANMU_VIDEO_SHOT_SCHEMA,
    shotId: text(raw.shotId || raw.shot_id || raw.id, 200) || `video-shot-${hash(shotSeed)}`,
    sourceShotId: text(raw.sourceShotId || raw.source_shot_id, 200),
    timelineAnchor: normalizeTimelineAnchor(raw.timelineAnchor || raw.timeline_anchor),
    durationSeconds,
    fps: Math.round(clamp(raw.fps, 1, 60, 24)),
    resolution: RESOLUTIONS.includes(String(raw.resolution || '').toLowerCase()) ? String(raw.resolution).toLowerCase() : '768p',
    intent: {
      summary: text(raw.intent?.summary || raw.summary, 2000),
      scene: text(raw.intent?.scene || raw.scene, 2000),
      visualStyle: text(raw.intent?.visualStyle || raw.intent?.visual_style || raw.visualStyle, 1200),
    },
    beats: (Array.isArray(raw.beats) ? raw.beats : []).slice(0, 24).map((beat, index) => normalizeBeat(beat, durationSeconds, index)),
    characters: (Array.isArray(raw.characters) ? raw.characters : []).slice(0, 16).map(normalizeCharacterPerformance),
    camera: {
      shotSize: text(cameraRaw.shotSize || cameraRaw.shot_size, 120),
      angle: text(cameraRaw.angle, 240),
      movement: text(cameraRaw.movement, 600),
      lens: text(cameraRaw.lens, 240),
      axis: text(cameraRaw.axis, 240),
      framing: text(cameraRaw.framing, 1000),
    },
    audio: {
      dialogue: (Array.isArray(audioRaw.dialogue) ? audioRaw.dialogue : []).slice(0, 32).map((line, index) => normalizeDialogue(line, durationSeconds, index)),
      ambience: unique(audioRaw.ambience, 32, 500),
      music: text(audioRaw.music, 1200),
    },
    keyframes: {
      firstAssetId: text(keyframesRaw.firstAssetId || keyframesRaw.first_asset_id, 200),
      lastAssetId: text(keyframesRaw.lastAssetId || keyframesRaw.last_asset_id, 200),
    },
    references: {
      assetIds: unique(referencesRaw.assetIds || referencesRaw.asset_ids, 32, 200),
    },
    referencePolicy: {
      preserveIdentity: policyRaw.preserveIdentity !== false,
      preserveWardrobe: policyRaw.preserveWardrobe !== false,
      preserveProps: policyRaw.preserveProps !== false,
      preserveScene: policyRaw.preserveScene !== false,
      preserveVoice: policyRaw.preserveVoice !== false,
      allowCompositionChange: policyRaw.allowCompositionChange !== false,
    },
    continuityLedger: {
      previousShotId: text(ledgerRaw.previousShotId || ledgerRaw.previous_shot_id, 200),
      requiredFacts: unique(ledgerRaw.requiredFacts || ledgerRaw.required_facts, 80, 500),
      forbiddenRegressions: unique(ledgerRaw.forbiddenRegressions || ledgerRaw.forbidden_regressions, 80, 500),
      axisRule: text(ledgerRaw.axisRule || ledgerRaw.axis_rule, 500),
      motionHandoff: text(ledgerRaw.motionHandoff || ledgerRaw.motion_handoff, 800),
      audioHandoff: text(ledgerRaw.audioHandoff || ledgerRaw.audio_handoff, 800),
    },
  };
  spec.route = resolveH3VideoMode(spec, manifestValue, raw.route?.requestedMode || raw.route?.requested_mode || raw.requestedMode || 'auto');
  return spec;
}

export function validateVideoShotSpec(value = {}, manifestValue = {}) {
  const manifestResult = validateMultimodalAssetManifest(manifestValue);
  const spec = normalizeVideoShotSpec(value, manifestResult.manifest);
  const issues = [...manifestResult.issues];
  if (!spec.intent.summary && !spec.intent.scene && !spec.beats.some((beat) => beat.visual)) issues.push('visual_intent_missing');
  if (!spec.route.ready) issues.push(...spec.route.missingRequirements.map((requirement) => `route_input_missing:${requirement}`));
  const characterIds = new Set(spec.characters.map((character) => character.characterId));
  spec.audio.dialogue.forEach((line) => {
    if (line.characterId && !characterIds.has(line.characterId)) issues.push(`dialogue_character_missing:${line.dialogueId}`);
  });
  return { ok: issues.length === 0, issues: [...new Set(issues)], spec, manifest: manifestResult.manifest };
}
