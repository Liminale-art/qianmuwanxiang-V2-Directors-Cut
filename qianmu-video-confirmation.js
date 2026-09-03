// 千幕 H3 付费前确认合同。只核对本地草稿并生成短时费用确认快照，不创建任务、不上传素材、不联网。
import { normalizeVideoCostQuote } from './qianmu-video-budget.js';
import { validateVideoShotSpec } from './qianmu-video-contract.js';
import { estimateMiniMaxH3Cost } from './qianmu-video-pricing.js';
import { validateH3CompiledPrompt } from './qianmu-video-prompt.js';

export const QIANMU_VIDEO_CONFIRMATION_SCHEMA = 'qianmu.video-confirmation.v1';
export const QIANMU_VIDEO_CONFIRMATION_TTL_MS = 5 * 60 * 1000;

const plain = (value) => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const text = (value, max = 1000) => String(value ?? '').trim().slice(0, max);
const time = (value, fallback = Date.now()) => Math.max(0, Math.round(Number.isFinite(Number(value)) ? Number(value) : fallback));

function hash(value) {
  let result = 2166136261;
  for (const char of String(value || '')) {
    result ^= char.charCodeAt(0);
    result = Math.imul(result, 16777619);
  }
  return (result >>> 0).toString(16).padStart(8, '0');
}

function gatewayReady(value = {}) {
  const service = plain(value) ? value : {};
  return service.status === 'ready'
    && Array.isArray(service.services)
    && service.services.map((item) => text(item, 80)).includes('minimax-h3');
}

function selectedAssetSnapshot(spec, manifest) {
  const inputs = plain(spec.route?.inputs) ? spec.route.inputs : {};
  const selected = new Set([
    inputs.firstFrameAssetId,
    inputs.lastFrameAssetId,
    ...(Array.isArray(inputs.referenceAssetIds) ? inputs.referenceAssetIds : []),
  ].map((item) => text(item, 200)).filter(Boolean));
  return manifest.assets
    .filter((asset) => selected.has(asset.assetId))
    .map((asset) => ({
      assetId: asset.assetId,
      kind: asset.kind,
      roles: [...asset.roles].sort(),
      fingerprint: asset.fingerprint,
      subjectLabel: asset.subjectLabel,
    }))
    .sort((left, right) => left.assetId.localeCompare(right.assetId));
}

function fingerprintFor(spec, manifest, prompt, estimate, owner = {}) {
  const rawFloor = owner.floor;
  const floor = Number(rawFloor);
  return `h3-review-${hash(JSON.stringify({
    shotId: spec.shotId,
    chatKey: text(owner.chatKey || owner.chat_key, 512),
    floor: rawFloor !== '' && rawFloor !== null && rawFloor !== undefined && Number.isInteger(floor) && floor >= 0 ? floor : null,
    mode: spec.route.mode,
    routeInputs: spec.route.inputs,
    durationSeconds: spec.durationSeconds,
    resolution: spec.resolution,
    aspectRatio: spec.aspectRatio,
    assets: selectedAssetSnapshot(spec, manifest),
    prompt,
    price: estimate.available ? {
      region: estimate.region,
      currency: estimate.currency,
      total: estimate.total,
      verifiedAt: estimate.verifiedAt,
    } : { region: estimate.region, reason: estimate.reason },
  }))}`;
}

export function createVideoGenerationConfirmation(value = {}, options = {}) {
  const raw = plain(value) ? value : {};
  const now = time(options.now, Date.now());
  const region = raw.region === 'china' || raw.region === 'cn' ? 'china' : 'global';
  const checked = validateVideoShotSpec(raw.spec, raw.manifest);
  const promptSource = String(raw.prompt || '').trim();
  const promptValidation = validateH3CompiledPrompt(promptSource, checked.spec, checked.manifest);
  const estimate = estimateMiniMaxH3Cost(checked.spec, checked.manifest, { region });
  const acknowledgements = plain(raw.acknowledgements) ? raw.acknowledgements : {};
  const blockers = [];
  if (!gatewayReady(raw.service)) blockers.push('h3_gateway_unavailable');
  if (raw.credentialConfigured !== true) blockers.push('h3_credential_missing');
  blockers.push(...checked.issues);
  blockers.push(...promptValidation.issues);
  if (!promptValidation.submissionReady && !promptValidation.issues.length) blockers.push(...promptValidation.warnings);
  if (!estimate.available) blockers.push(`h3_cost_unavailable:${estimate.reason || 'unknown'}`);

  const fingerprint = fingerprintFor(checked.spec, checked.manifest, promptSource, estimate, raw.owner);
  const confirmationIssues = [];
  if (!acknowledgements.cost) confirmationIssues.push('cost_confirmation_required');
  if (!acknowledgements.materialRights) confirmationIssues.push('material_rights_confirmation_required');
  if (!acknowledgements.h3License) confirmationIssues.push('h3_license_confirmation_required');
  if (checked.spec.resolution === '2k' && !acknowledgements.highResolution) {
    confirmationIssues.push('high_resolution_confirmation_required');
  }
  const readyForConfirmation = blockers.length === 0;
  const confirmed = readyForConfirmation && confirmationIssues.length === 0;
  const quote = confirmed ? normalizeVideoCostQuote({
    quoteId: `h3-quote-${fingerprint.slice(-8)}-${now}`,
    provider: 'minimax-h3',
    model: 'MiniMax-H3',
    unit: 'usd',
    estimatedUnits: estimate.total,
    maximumUnits: estimate.total,
    displayLabel: estimate.displayLabel,
    createdAt: now,
    expiresAt: now + QIANMU_VIDEO_CONFIRMATION_TTL_MS,
    input: {
      durationSeconds: checked.spec.durationSeconds,
      resolution: checked.spec.resolution,
      count: 1,
      includesAudio: true,
    },
  }) : null;

  return {
    schema: QIANMU_VIDEO_CONFIRMATION_SCHEMA,
    fingerprint,
    readyForConfirmation,
    confirmed,
    readyForTaskCreation: confirmed,
    blockers: [...new Set(blockers)],
    confirmationIssues: readyForConfirmation ? confirmationIssues : [],
    acknowledgements: {
      cost: Boolean(acknowledgements.cost),
      materialRights: Boolean(acknowledgements.materialRights),
      h3License: Boolean(acknowledgements.h3License),
      highResolution: Boolean(acknowledgements.highResolution),
    },
    summary: {
      mode: checked.spec.route.mode,
      durationSeconds: checked.spec.durationSeconds,
      resolution: checked.spec.resolution,
      aspectRatio: checked.spec.aspectRatio,
      selectedAssetCount: selectedAssetSnapshot(checked.spec, checked.manifest).length,
      promptLength: promptSource.length,
      promptDigest: hash(promptSource),
    },
    costPreview: {
      available: estimate.available,
      region: estimate.region,
      currency: estimate.currency,
      total: estimate.total,
      displayLabel: estimate.displayLabel,
      breakdown: estimate.breakdown.map((item) => ({ id: item.id, label: item.label, amount: item.amount })),
      verifiedAt: estimate.verifiedAt,
      sourceUrl: estimate.sourceUrl,
      lockedPrice: false,
    },
    quote,
  };
}
