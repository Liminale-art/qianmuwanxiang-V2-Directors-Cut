// R2-03 server-only prepared batch contract. A validated record is deliberately
// unrunnable: these commitments are neither image requests nor fee authority.
import { createHash } from 'node:crypto';

export const STORYBOARD_SERVER_BATCH_VERSION = 1;
export const STORYBOARD_SERVER_BATCH_MAX_BYTES = 64 * 1024;
const KEY_DOMAIN = 'qianmu.storyboard-batch-key.v1';
const HASH = /^[a-f0-9]{64}$/;
const ACCOUNT = /^st-user:[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const STREAM_BATCH_ID = /^stream-[a-f0-9]{64}$/;
const REVISION_PLAN_ID = /^story-[a-f0-9]{8}$/;
// qianmu-storyboard-utils.uid(prefix): prefix-base36-time-base36-counter-
// 8 hex from randomUUID, or 1..7 base36 from its Math.random fallback.
// A zero-length fallback suffix is not a usable persistent identity.
const NATIVE_UID = /^(story|shotbatch|shotjob|shotdraft|shotplan)-([0-9a-z]{1,11})-([0-9a-z]{1,4})-([a-f0-9]{8}|[0-9a-z]{1,7})$/;
const INPUT_FIELDS = ['version', 'batchId', 'originBatch', 'source', 'requestedMode', 'planDigest', 'routeDigest', 'shots'];
const RECORD_FIELDS = [...INPUT_FIELDS, 'expectedAccount', 'digest', 'state', 'stateRevision', 'createdAt', 'updatedAt'];
const MIN_SHOT_BYTES = Buffer.byteLength(JSON.stringify({ shotId: 'shotplan-0-0-0', attemptId: 'shotjob-0-0-0', shotIndex: 0, requestIndex: 1, contentDigest: '0'.repeat(64) }));
const BUSINESS_CODES = new Set(['conflict', 'not_found', 'revision', 'account_changed', 'identity']);
const businessErrorBrand = new WeakSet();

const fail = (message, status = 400) => {
  throw Object.assign(new Error(message), {
    code: 'storyboard_server_batch_contract', status, submissionState: 'not_submitted',
  });
};
const sha256 = value => createHash('sha256').update(value).digest('hex');
const validHash = value => typeof value === 'string' && HASH.test(value);
const validAccount = value => typeof value === 'string' && ACCOUNT.test(value);
const validUuid = value => typeof value === 'string' && UUID.test(value);
const validTime = value => Number.isSafeInteger(value) && value >= 0;
function validNativeUid(value, prefixes) {
  const match = typeof value === 'string' && NATIVE_UID.exec(value);
  if (!match || !prefixes.includes(match[1])) return false;
  const time = Number.parseInt(match[2], 36), counter = Number.parseInt(match[3], 36);
  return Number.isSafeInteger(time) && time >= 0 && time.toString(36) === match[2]
    && Number.isSafeInteger(counter) && counter >= 0 && counter <= 999999
    && counter.toString(36) === match[3];
}
const validOriginBatchId = value => typeof value === 'string' && STREAM_BATCH_ID.test(value)
  || validNativeUid(value, ['shotbatch']);
const validOriginPlanId = value => typeof value === 'string'
  && (STREAM_BATCH_ID.test(value) || REVISION_PLAN_ID.test(value) || validNativeUid(value, ['story']));
const validAttemptId = value => validNativeUid(value, ['shotjob']);
const validShotId = value => validNativeUid(value, ['shotdraft', 'shotplan']);

// Storage may let these known application refusals pass through unchanged.
// Name/code strings alone are forgeable and may expose an unrelated error's
// private message, so only errors minted here carry the private brand.
export function createStoryboardServerBatchBusinessError(code, message, status = 409) {
  if (!BUSINESS_CODES.has(code) || typeof message !== 'string' || !message || message.length > 200
    || /[\u0000-\u001f\u007f]/.test(message) || !Number.isInteger(status) || status < 400 || status > 599) {
    fail('分镜批次业务错误类型无效');
  }
  const error = Object.assign(new Error(message), {
    name: 'StoryboardServerBatchError', code: `storyboard_server_batch_${code}`,
    status, submissionState: 'not_submitted',
  });
  businessErrorBrand.add(error);
  return Object.freeze(error);
}
export function isStoryboardServerBatchBusinessError(cause) {
  return businessErrorBrand.has(cause);
}

function exactObject(value, fields) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail('分镜批次字段无效，未创建任务');
  const names = Reflect.ownKeys(value);
  if (names.length !== fields.length || names.some(name => typeof name !== 'string' || !fields.includes(name))) {
    fail('分镜批次包含额外或缺失字段，未创建任务');
  }
  for (const name of fields) {
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) fail('分镜批次不能包含动态字段，未创建任务');
  }
  return value;
}

function exactArray(value) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || !Number.isSafeInteger(value.length)
    || value.length < 1 || value.length > Math.floor(STORYBOARD_SERVER_BATCH_MAX_BYTES / MIN_SHOT_BYTES)) {
    fail('分镜批次镜头数量超出元数据安全容量，未创建任务', 413);
  }
  if (Reflect.ownKeys(value).length !== value.length + 1) fail('分镜批次镜头列表不完整，未创建任务');
  for (let i = 0; i < value.length; i++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) fail('分镜批次镜头列表不完整，未创建任务');
  }
  return value;
}

function boundedJson(value) {
  let json;
  try { json = JSON.stringify(value); } catch { fail('分镜批次元数据无效，未创建任务'); }
  if (typeof json !== 'string' || Buffer.byteLength(json) > STORYBOARD_SERVER_BATCH_MAX_BYTES) {
    fail('分镜批次元数据超过安全容量，未截断、未创建任务', 413);
  }
  return json;
}

export function storyboardServerBatchKey(expectedAccount, batchId) {
  if (!validAccount(expectedAccount) || !validUuid(batchId)) fail('分镜批次账户或编号无效，未创建任务');
  return sha256(JSON.stringify([KEY_DOMAIN, expectedAccount, batchId]));
}

function frozenFields(input, expectedAccount) {
  exactObject(input, INPUT_FIELDS);
  if (input.version !== STORYBOARD_SERVER_BATCH_VERSION || !validUuid(input.batchId) || !validAccount(expectedAccount)
    || !['automatic', 'manual'].includes(input.requestedMode)
    || !validHash(input.planDigest) || !validHash(input.routeDigest)) fail('分镜批次身份或摘要无效，未创建任务');
  exactObject(input.originBatch, ['batchId', 'batchStartedAt']);
  if (!validOriginBatchId(input.originBatch.batchId) || !Number.isSafeInteger(input.originBatch.batchStartedAt)
    || input.originBatch.batchStartedAt < 1) fail('原页面批次身份无效，未创建任务');
  exactObject(input.source, ['chatHash', 'floor', 'sourceDigest', 'originPlanId']);
  if (!validHash(input.source.chatHash) || !Number.isSafeInteger(input.source.floor) || input.source.floor < 0
    || !validHash(input.source.sourceDigest) || !validOriginPlanId(input.source.originPlanId)
    || (STREAM_BATCH_ID.test(input.originBatch.batchId)
      && input.originBatch.batchId !== input.source.originPlanId)) {
    fail('分镜批次来源无效，未创建任务');
  }
  const shotIndexById = new Map(), shotIdByIndex = new Map(), attemptIds = new Set();
  let previousShotIndex = -1, previousRequestIndex = 0;
  const shots = exactArray(input.shots).map(shot => {
    exactObject(shot, ['shotId', 'attemptId', 'shotIndex', 'requestIndex', 'contentDigest']);
    if (!validShotId(shot.shotId) || !validAttemptId(shot.attemptId) || !validHash(shot.contentDigest)
      || !Number.isSafeInteger(shot.shotIndex) || shot.shotIndex < 0
      || !Number.isSafeInteger(shot.requestIndex) || shot.requestIndex < 1 || shot.requestIndex > 20
      || shot.shotIndex < previousShotIndex
      || shot.shotIndex === previousShotIndex && shot.requestIndex <= previousRequestIndex
      || shotIndexById.has(shot.shotId) && shotIndexById.get(shot.shotId) !== shot.shotIndex
      || shotIdByIndex.has(shot.shotIndex) && shotIdByIndex.get(shot.shotIndex) !== shot.shotId
      || attemptIds.has(shot.attemptId)) {
      fail('分镜批次镜头或尝试编号无效、重复，未创建任务');
    }
    previousShotIndex = shot.shotIndex; previousRequestIndex = shot.requestIndex;
    shotIndexById.set(shot.shotId, shot.shotIndex);
    shotIdByIndex.set(shot.shotIndex, shot.shotId);
    attemptIds.add(shot.attemptId);
    return { shotId: shot.shotId, attemptId: shot.attemptId, shotIndex: shot.shotIndex,
      requestIndex: shot.requestIndex, contentDigest: shot.contentDigest };
  });
  const frozen = {
    version: STORYBOARD_SERVER_BATCH_VERSION, batchId: input.batchId, expectedAccount,
    originBatch: { batchId: input.originBatch.batchId, batchStartedAt: input.originBatch.batchStartedAt },
    source: { chatHash: input.source.chatHash, floor: input.source.floor,
      sourceDigest: input.source.sourceDigest, originPlanId: input.source.originPlanId },
    requestedMode: input.requestedMode, planDigest: input.planDigest, routeDigest: input.routeDigest, shots,
  };
  // The original inlineOrder and job/plan-shot IDs are lossless presentation
  // mapping only. Neither they nor requestedMode authorize charging, execution,
  // or result ownership. Fixed property order defines the server digest.
  boundedJson(frozen);
  return frozen;
}

export function normalizePreparedBatch(input, expectedAccount, now = Date.now()) {
  const frozen = frozenFields(input, expectedAccount);
  if (!validTime(now)) fail('分镜批次创建时间无效，未创建任务');
  const record = {
    ...frozen, digest: sha256(JSON.stringify(frozen)), state: 'prepared_unrunnable',
    stateRevision: 1, createdAt: now, updatedAt: now,
  };
  boundedJson(record);
  return record;
}

export function normalizeBatchRecord(raw, key) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) fail('分镜批次记录损坏，请核查原记录');
  const stopped = Object.getOwnPropertyDescriptor(raw, 'state')?.value === 'stopped_unrunnable';
  exactObject(raw, stopped ? [...RECORD_FIELDS, 'stoppedAt'] : RECORD_FIELDS);
  const frozen = frozenFields(Object.fromEntries(INPUT_FIELDS.map(field => [field, raw[field]])), raw.expectedAccount);
  if (typeof key !== 'string' || key !== storyboardServerBatchKey(raw.expectedAccount, raw.batchId)
    || !validHash(raw.digest) || raw.digest !== sha256(JSON.stringify(frozen))) {
    fail('分镜批次身份或摘要不符，请核查原记录');
  }
  if (!validTime(raw.createdAt) || !validTime(raw.updatedAt) || raw.updatedAt < raw.createdAt
    || !Number.isSafeInteger(raw.stateRevision)
    || !(raw.state === 'prepared_unrunnable' && raw.stateRevision === 1 && raw.updatedAt === raw.createdAt
      || stopped && raw.stateRevision === 2 && validTime(raw.stoppedAt) && raw.stoppedAt === raw.updatedAt)) {
    fail('分镜批次状态损坏，请核查原记录');
  }
  const record = { ...frozen, digest: raw.digest, state: raw.state, stateRevision: raw.stateRevision,
    createdAt: raw.createdAt, updatedAt: raw.updatedAt, ...(stopped ? { stoppedAt: raw.stoppedAt } : {}) };
  boundedJson(record);
  return record;
}

export function batchPublicView(record) {
  const normalized = normalizeBatchRecord(record, storyboardServerBatchKey(record?.expectedAccount, record?.batchId));
  return {
    version: normalized.version, batchId: normalized.batchId, state: normalized.state,
    stateRevision: normalized.stateRevision, shotCount: normalized.shots.length,
    digest: normalized.digest, createdAt: normalized.createdAt, updatedAt: normalized.updatedAt,
    ...(normalized.state === 'stopped_unrunnable' ? { stoppedAt: normalized.stoppedAt } : {}),
  };
}
