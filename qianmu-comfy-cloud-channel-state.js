// Cloud ledger metadata only; no executor or automatic transition on remote acceptance.
// Reuse local row identity/time checks, not the native queue's completion semantics.
import { normalizeImageServiceChannel } from './qianmu-image-service-queue.js';
import { normalizeComfyCloudReceipt, normalizeComfyCloudIntent, assertComfyCloudReceiptForIntent } from './qianmu-comfy-cloud-receipt.js';

export const COMFY_CLOUD_CHANNEL_SCHEMA = 'qianmu.comfy-cloud-channel.v1';
const keys = ['namespace', 'attemptId', 'requestDigest', 'ownerId', 'fence', 'status', 'automatic', 'createdAt', 'updatedAt', 'upstreamId', 'cloudReceipt', 'cloudIntent'];
const fail = () => { throw Object.assign(new Error('云任务记录不完整，请先核查原任务'), { code: 'image_service_cloud_state', status: 409, retryable: false }); };
function fields(value, allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail();
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!allowed.includes(key) || descriptor.get || descriptor.set) fail();
  }
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
    });
    return { ...normalized, schema: COMFY_CLOUD_CHANNEL_SCHEMA };
  } catch (_) { fail(); }
}
