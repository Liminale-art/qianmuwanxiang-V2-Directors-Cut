// Pure projection of a bounded, parsed job response. Not a download or storage
// grant: callers still need the original ledger/target authorization and bytes.
import { normalizeComfyCloudReceipt } from './qianmu-comfy-cloud-receipt.js';
import { readComfyCloudTaskStatus } from './qianmu-comfy-cloud-response.js';
import { comfyCloudAssetId } from './qianmu-comfy-cloud-protocol.js';

const nodeId = value => typeof value === 'string' && /^[a-zA-Z0-9_:-]{1,120}$/.test(value);
const mimes = new Set(['image/png', 'image/jpeg', 'image/webp']);
const kinds = new Set(['image', 'video', 'audio', 'text', 'file', 'latent']);
const MAX_BYTES = 48 * 1024 * 1024;

export function collectComfyCloudStillResults(rawReceipt, body) {
  const receipt = normalizeComfyCloudReceipt(rawReceipt), { task, stillOutput } = receipt;
  const fail = (code, message) => { throw Object.assign(new Error(message), {
    code: `comfy_cloud_results_${code}`, submissionState: 'accepted', upstreamId: task.taskId, retryable: false,
  }); };
  if (task.provider !== 'comfy-cloud') fail('unsupported', '此云平台的最终输出识别尚未就绪，原任务保留');
  const state = readComfyCloudTaskStatus(task, body);
  if (!state.terminal) return null;
  if (state.status !== 'succeeded') fail('execution', '云端任务未成功完成，请核查原任务');
  if (body.error != null) fail('status', '云端成功状态与错误信息冲突，未收片');
  if (!Array.isArray(body.outputs) || body.outputs.length > 4096) fail('shape', '云端输出清单无效或过大，未收片');
  const { execution } = stillOutput, selected = new Set(execution.outputNodeIds), previews = new Set(stillOutput.previewNodeIds);
  const seen = new Map(), finalIds = new Set(), outputs = []; let bytes = 0;
  for (const item of body.outputs) {
    if (!item || typeof item !== 'object' || Array.isArray(item) || !kinds.has(item.type)) fail('shape', '云端输出记录无法识别');
    if (item.job_id != null && item.job_id !== task.taskId) fail('identity', '云端混入其他任务输出，未收片');
    if (item.type !== 'image') {
      if (selected.has(item.node_id)) fail('type', '所选节点未返回静帧图片，请核查原任务');
      continue;
    }
    if (!nodeId(item.node_id)) fail('node', '云端缺少图片所属节点，未猜测最终成图');
    if (!comfyCloudAssetId(item.id) || !Number.isSafeInteger(item.size_bytes) || item.size_bytes < 1
      || typeof item.content_type !== 'string' || item.content_type.length > 120
      || !(item.hash === null || typeof item.hash === 'string' && /^blake3:[a-f0-9]{64}$/.test(item.hash))) {
      fail('asset', '云端图片资产信息不完整，未收片');
    }
    const record = { assetId: item.id.toLowerCase(), nodeId: item.node_id, mime: item.content_type,
      sizeBytes: item.size_bytes, hash: item.hash };
    const previous = seen.get(record.assetId);
    if (previous) {
      if (JSON.stringify(previous) !== JSON.stringify(record)) fail('conflict', '同一云端资产的输出信息冲突，未收片');
      continue;
    }
    seen.set(record.assetId, record);
    if (previews.has(record.nodeId)) continue;
    finalIds.add(record.assetId);
    if (finalIds.size > 8) fail('count', '云端实际输出超过八张，请核查原任务，勿重复生成');
    if (!selected.has(record.nodeId)) continue;
    if (!mimes.has(record.mime)) fail('type', '所选节点未返回支持的静帧格式');
    bytes += record.sizeBytes;
    if (bytes > MAX_BYTES) fail('size', '云端原图超过收片体积上限，请到平台获取原图');
    if (outputs.length >= execution.maxImages) fail('count', '云端图片数量超过本次收片约定');
    outputs.push(Object.freeze(record));
  }
  if (!outputs.length) fail('missing', '云端已结束，但没有所选节点的最终静帧');
  if (execution.automatic && finalIds.size !== 1
    || execution.expectedImages != null && outputs.length !== execution.expectedImages) fail('count', '云端成图数量与本次约定不一致，未收片');
  // Asset ids are durable identities. Signed URLs, filenames and provider error
  // text are deliberately not retained; they grant no later download authority.
  return Object.freeze({ version: 1, task, requestDigest: receipt.requestDigest, outputs: Object.freeze(outputs) });
}
