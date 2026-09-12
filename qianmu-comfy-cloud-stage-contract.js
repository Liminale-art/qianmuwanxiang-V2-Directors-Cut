// Pure, closed staging metadata. Identity and the complete selection must come
// from the original ledger/query, never a browser claim. This grants no IO.
import { normalizeComfyCloudReceipt } from './qianmu-comfy-cloud-receipt.js';
import { comfyCloudAssetId } from './qianmu-comfy-cloud-protocol.js';

export const COMFY_CLOUD_STAGE_SCHEMA = 'qianmu.comfy-cloud-stage.v1';
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const platformHash = value => value === null || typeof value === 'string' && /^blake3:[a-f0-9]{64}$/.test(value);
const invalid = () => { throw Object.assign(new Error('云端原图暂存证据缺失或不一致，未应用'), { code: 'comfy_cloud_stage_invalid', retryable: false }); };
function fields(value, names) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid();
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!names.includes(key) || descriptor.get || descriptor.set) invalid();
  }
  if (names.some(name => !Object.hasOwn(value, name))) invalid();
}
function identity(value) {
  const names = ['namespace', 'channelKey', 'attemptId', 'requestDigest', 'fence']; fields(value, names);
  const result = {};
  for (const name of names) {
    const item = value[name];
    if (typeof item !== 'string' || !item || item.length > 240 || /[\u0000-\u001f\u007f]/.test(item)
      || ['channelKey', 'requestDigest'].includes(name) && !digest(item)) invalid();
    result[name] = item;
  }
  return Object.freeze(result);
}
function array(value) {
  if (!Array.isArray(value) || !value.length || value.length > 8 || Object.getPrototypeOf(value) !== Array.prototype) invalid();
  const keys = Reflect.ownKeys(value);
  if (keys.length !== value.length + 1) invalid();
  for (const key of keys) {
    if (key !== 'length' && (typeof key !== 'string' || !/^(?:0|[1-9]\d*)$/.test(key) || Number(key) >= value.length)) invalid();
    const property = Object.getOwnPropertyDescriptor(value, key); if (property.get || property.set) invalid();
  }
}

export function normalizeComfyCloudStage(value, expectedIdentity) {
  try {
    fields(value, ['schema', 'identity', 'receipt', 'selection', 'images']);
    if (value.schema !== COMFY_CLOUD_STAGE_SCHEMA) invalid();
    const owner = identity(value.identity), expected = identity(expectedIdentity), receipt = normalizeComfyCloudReceipt(value.receipt);
    if (JSON.stringify(owner) !== JSON.stringify(expected) || receipt.requestDigest !== owner.requestDigest || receipt.task.provider !== 'comfy-cloud') invalid();
    const { execution, previewNodeIds } = receipt.stillOutput;
    array(value.selection); array(value.images);
    if (value.selection.length > execution.maxImages
      || execution.expectedImages != null && value.selection.length !== execution.expectedImages || execution.automatic && value.selection.length !== 1
      || value.images.length !== value.selection.length) invalid();
    const seen = new Set(), selection = [], images = []; let total = 0;
    for (let index = 0; index < value.selection.length; index++) {
      const row = value.selection[index], image = value.images[index];
      fields(row, ['assetId', 'nodeId', 'mime', 'sizeBytes', 'hash']); fields(image, ['assetId', 'hash', 'integrity']);
      const assetId = comfyCloudAssetId(row.assetId);
      if (!assetId || seen.has(assetId) || comfyCloudAssetId(image.assetId) !== assetId || typeof row.nodeId !== 'string' || !/^[a-zA-Z0-9_:-]{1,120}$/.test(row.nodeId) || !execution.outputNodeIds.includes(row.nodeId)
        || previewNodeIds.includes(row.nodeId) || !['image/png', 'image/jpeg', 'image/webp'].includes(row.mime)
        || !Number.isSafeInteger(row.sizeBytes) || row.sizeBytes < 1 || (total += row.sizeBytes) > 48 * 1024 * 1024
        || !platformHash(row.hash) || !platformHash(image.hash) || row.hash !== null && row.hash !== image.hash) invalid();
      seen.add(assetId);
      const proof = image.integrity;
      fields(proof, ['version', 'sizeBytes', 'sha256', 'blake3', 'platformHash', 'platformVerified']);
      if (proof.version !== 1 || proof.sizeBytes !== row.sizeBytes || !digest(proof.sha256) || !digest(proof.blake3)
        || proof.platformHash !== image.hash || (image.hash === null ? proof.platformVerified !== null
          : proof.platformVerified !== true || image.hash !== `blake3:${proof.blake3}`)) invalid();
      selection.push(Object.freeze({ assetId, nodeId: row.nodeId, mime: row.mime, sizeBytes: row.sizeBytes, hash: row.hash }));
      images.push(Object.freeze({ assetId, hash: image.hash, integrity: Object.freeze({ version: 1, sizeBytes: proof.sizeBytes,
        sha256: proof.sha256, blake3: proof.blake3, platformHash: proof.platformHash, platformVerified: proof.platformVerified }) }));
    }
    const result = { schema: COMFY_CLOUD_STAGE_SCHEMA, identity: owner, receipt, selection: Object.freeze(selection), images: Object.freeze(images) };
    if (new TextEncoder().encode(JSON.stringify(result)).byteLength > 16 * 1024) invalid();
    return Object.freeze(result);
  } catch (_) { invalid(); }
}
