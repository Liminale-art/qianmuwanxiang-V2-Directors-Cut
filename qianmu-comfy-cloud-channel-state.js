// Cloud ledger metadata only; no executor or automatic transition on remote acceptance.
// Reuse local row identity/time checks, not the native queue's completion semantics.
import { normalizeImageServiceChannel } from './qianmu-image-service-queue.js';
import { normalizeComfyCloudReceipt, normalizeComfyCloudIntent, assertComfyCloudReceiptForIntent } from './qianmu-comfy-cloud-receipt.js';
import { normalizeRunningHubUsage, normalizeRunningHubObservation } from './qianmu-runninghub-usage.js';

export const COMFY_CLOUD_CHANNEL_SCHEMA = 'qianmu.comfy-cloud-channel.v1';
const keys = ['namespace', 'attemptId', 'requestDigest', 'ownerId', 'fence', 'status', 'automatic', 'createdAt', 'updatedAt', 'upstreamId', 'cloudReceipt', 'cloudIntent', 'cloudDelivery', 'cloudObservation', 'cloudTerminal'];
const fail = () => { throw Object.assign(new Error('云任务记录不完整，请先核查原任务'), { code: 'image_service_cloud_state', status: 409, retryable: false }); };
function fields(value, allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail();
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!allowed.includes(key) || descriptor.get || descriptor.set) fail();
  }
}
function delivery(value, row) {
  const required = ['schema', 'state', 'cacheReceipt', 'bytes', 'imageCount', 'storedAt'];
  fields(value, [...required, 'archivedAt', 'usage']);
  if (required.some(name => !Object.hasOwn(value, name))) fail();
  if (value.schema !== 'qianmu.comfy-cloud-delivery.v1' || !['stored', 'archived'].includes(value.state)
    || typeof value.cacheReceipt !== 'string' || !/^[a-f0-9]{64}$/.test(value.cacheReceipt)
    || !Number.isSafeInteger(value.bytes) || value.bytes < 1 || value.bytes > 48 * 1024 * 1024
    || !Number.isSafeInteger(value.imageCount) || value.imageCount < 1 || value.imageCount > 8 || value.bytes < value.imageCount
    || !Number.isSafeInteger(value.storedAt) || value.storedAt < row.createdAt || value.storedAt > row.updatedAt
    || row.status !== 'succeeded' || !row.cloudIntent || !['comfy-cloud', 'runninghub'].includes(row.cloudReceipt?.task.provider)) fail();
  const { execution } = row.cloudReceipt.stillOutput;
  if (value.imageCount > execution.maxImages || execution.expectedImages != null && value.imageCount !== execution.expectedImages
    || execution.automatic && value.imageCount !== 1) fail();
  if (value.state === 'archived') {
    if (!Object.hasOwn(value, 'archivedAt') || !Number.isSafeInteger(value.archivedAt) || value.archivedAt < value.storedAt || value.archivedAt > row.updatedAt) fail();
  } else if (Object.hasOwn(value, 'archivedAt')) fail();
  const usage = Object.hasOwn(value,'usage') ? (row.cloudReceipt.task.provider === 'runninghub' ? normalizeRunningHubUsage(value.usage) : fail()) : undefined;
  return Object.freeze({ schema: value.schema, state: value.state, cacheReceipt: value.cacheReceipt, bytes: value.bytes,
    imageCount: value.imageCount, storedAt: value.storedAt, ...(value.state === 'archived' ? { archivedAt: value.archivedAt } : {}), ...(usage ? {usage} : {}) });
}
export function normalizeComfyCloudChannel(value, channelKey) {
  try {
    const base = normalizeImageServiceChannel(undefined, channelKey);
    if (value == null) return { ...base, schema: COMFY_CLOUD_CHANNEL_SCHEMA };
    fields(value, ['schema', 'channelKey', 'entries']);
    if (value.schema !== COMFY_CLOUD_CHANNEL_SCHEMA || value.channelKey !== channelKey || !Array.isArray(value.entries) || value.entries.length > 4096) fail();
    for (const row of value.entries) fields(row, keys);
    const normalized = normalizeImageServiceChannel({ ...value, schema: base.schema }, channelKey);
    normalized.entries.forEach((row, index) => {
      const raw = value.entries[index];
      if (Object.hasOwn(raw, 'cloudIntent')) {
        const intent = normalizeComfyCloudIntent(raw.cloudIntent);
        if (intent.requestDigest !== row.requestDigest || intent.stillOutput.execution.automatic !== row.automatic
          || intent.workflow.binding && intent.workflow.binding.namespace !== row.namespace) fail();
        row.cloudIntent = intent;
      }
      // Historical uncertain evidence remains readable, but new reservations
      // must have a frozen pre-submit identity before any network request.
      if (['reserved', 'submitting'].includes(row.status) && !row.cloudIntent) fail();
      if (Object.hasOwn(raw, 'cloudReceipt')) {
        const receipt = normalizeComfyCloudReceipt(raw.cloudReceipt);
        if (receipt.task.taskId !== row.upstreamId || receipt.requestDigest !== row.requestDigest
          || receipt.stillOutput.execution.automatic !== row.automatic
          || receipt.workflow.binding && receipt.workflow.binding.namespace !== row.namespace) fail();
        row.cloudReceipt = receipt;
        if (row.cloudIntent) assertComfyCloudReceiptForIntent(receipt, row.cloudIntent, row.upstreamId);
      }
      // An accepted id may exist without usable links/output evidence. Keep it
      // uncertain for investigation rather than dropping the id or authorizing a replay.
      if (row.status === 'succeeded' && !row.cloudReceipt) fail();
      // "acknowledged" already means manual review of an uncertain charge in
      // the shared queue. Never reinterpret it as a browser archive receipt.
      // Legacy rows have no delivery proof; do not invent one during reads.
      if (Object.hasOwn(raw, 'cloudDelivery')) row.cloudDelivery = delivery(raw.cloudDelivery, row);
      if(Object.hasOwn(raw,'cloudObservation')){
        const observation=normalizeRunningHubObservation(raw.cloudObservation);
        if(row.cloudReceipt?.task.provider!=='runninghub'||observation.observedAt<row.createdAt||observation.observedAt>row.updatedAt)fail();
        row.cloudObservation=observation;
      }
      if(Object.hasOwn(raw,'cloudTerminal')){
        const terminal=raw.cloudTerminal;fields(terminal,['status','observedAt']);
        if(!['failed','canceled','expired'].includes(terminal.status)||!Number.isSafeInteger(terminal.observedAt)
          ||terminal.observedAt<row.createdAt||terminal.observedAt>row.updatedAt||row.status!=='failed'||!row.cloudReceipt||row.cloudDelivery
          ||row.cloudObservation&&row.cloudObservation.status!==terminal.status)fail();
        row.cloudTerminal=Object.freeze({status:terminal.status,observedAt:terminal.observedAt});
      }
    });
    return { ...normalized, schema: COMFY_CLOUD_CHANNEL_SCHEMA };
  } catch (_) { fail(); }
}
