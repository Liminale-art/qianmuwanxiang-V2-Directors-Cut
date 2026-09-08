import { parseStrictStoryboardJson } from './qianmu-storyboard-package-input.js';
import { vibeDigest } from './qianmu-vibe-file.js';
import { assertComfyRouteNamespace } from './qianmu-comfy-route-contract.js';
import { sourceIdentityResponse, sourceIdentityForNamespace } from './qianmu-source-identity-contract.js';

// Uncompressed, length-delimited Blob sections. No archive paths, extraction, executable entries or whole-file arrayBuffer.
export const STORYBOARD_BUNDLE_SCHEMA = 'qianmu.storyboard.bundle.v3';
export const STORYBOARD_BUNDLE_LIMITS = Object.freeze({ total: 512 * 1048576, manifest: 1048576, entries: 1031,
  storyboard: 128 * 1048576, workflows: 80 * 1048576, pools: 24 * 1048576, characters: 24 * 1048576, 'legacy-vibes': 2 * 1048576, 'chat-evidence': 24 * 1048576, 'subject-evidence': 4 * 1048576, image: 16 * 1048576 });
const magic = new TextEncoder().encode('QIANMU-BUNDLE/1\n'), prefixBytes = magic.length + 4;
export async function isStoryboardBundleFile(file) {
  if (!(file instanceof Blob)) return false;
  const bytes = new Uint8Array(await file.slice(0, magic.length).arrayBuffer());
  return bytes.length === magic.length && bytes.every((value, index) => value === magic[index]);
}
const fixed = ['storyboard', 'workflows', 'pools', 'characters'];
const documents = [...fixed, 'legacy-vibes', 'chat-evidence', 'subject-evidence'];
const fail = message => { throw Object.assign(new Error(message), { code: 'storyboard_bundle', submissionState: 'not_submitted' }); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const only = (value, keys) => { if (!object(value) || Object.keys(value).some(key => !keys.includes(key))) fail('资源包含未知字段，请保留原文件'); };
const kind = id => documents.includes(id) ? id : typeof id === 'string' && /^image:[a-f0-9]{64}$/.test(id) ? 'image' : '';
const text = bytes => { try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch (_) { fail('资源包不是完整 UTF-8'); } };
function inspectManifest(value) {
  only(value, ['schema', 'namespace', 'chatKey', 'createdAt', 'credentialsIncluded', 'scope', 'entries', ...(value?.schema === STORYBOARD_BUNDLE_SCHEMA ? ['source'] : [])]);
  if (![STORYBOARD_BUNDLE_SCHEMA, 'qianmu.storyboard.bundle.v2', 'qianmu.storyboard.bundle.v1'].includes(value.schema) || value.credentialsIncluded !== false || value.scope !== 'current-chat-and-libraries') fail('资源包版本或范围无效');
  if (value.schema === STORYBOARD_BUNDLE_SCHEMA && sourceIdentityResponse(value.source).state !== 'ready') fail('资源包缺少完整来源标识');
  assertComfyRouteNamespace(value.namespace);
  if (typeof value.chatKey !== 'string' || !value.chatKey || value.chatKey.length > 1024 || /[\u0000-\u001f\u007f]/.test(value.chatKey)
    || !Number.isSafeInteger(value.createdAt) || value.createdAt < 0 || !Array.isArray(value.entries) || value.entries.length < 4 || value.entries.length > STORYBOARD_BUNDLE_LIMITS.entries) fail('资源包来源或目录无效');
  const ids = new Set(); let total = 0;
  for (const row of value.entries) {
    only(row, ['id', 'bytes', 'sha256', 'mime']); const type = kind(row.id);
    if (!type || ids.has(row.id) || !hash(row.sha256) || !Number.isSafeInteger(row.bytes) || row.bytes < 1 || row.bytes > STORYBOARD_BUNDLE_LIMITS[type]) fail('资源包分段身份、大小或摘要无效');
    if (type === 'image' ? row.id !== `image:${row.sha256}` || !['image/png', 'image/jpeg', 'image/webp'].includes(row.mime) : Object.hasOwn(row, 'mime')) fail('资源包原件类型无效');
    ids.add(row.id); total += row.bytes;
  }
  if (fixed.some(id => !ids.has(id)) || total > STORYBOARD_BUNDLE_LIMITS.total) fail('资源包缺少必需分段或超过 512 MiB');
  if ((value.schema !== 'qianmu.storyboard.bundle.v1') !== ids.has('legacy-vibes')) fail('资源包版本与旧 Vibe 原图目录不符');
  return total;
}

export async function buildStoryboardBundle({ namespace, chatKey, entries, source = null, createdAt = Date.now() }, { guard = async () => {} } = {}) {
  if (!Array.isArray(entries) || entries.length > STORYBOARD_BUNDLE_LIMITS.entries) fail('资源包分段清单无效');
  // Capture file handles, not their contents. Reject the aggregate before reading a single large segment.
  const parts = entries.map(row => ({ id: row.id, file: row.file, ...(Object.hasOwn(row, 'mime') ? { mime: row.mime } : {}) }));
  if (parts.some(row => !(row.file instanceof Blob))) fail('资源包分段必须是本机文件');
  const capturedSource = source === null ? null : sourceIdentityResponse(source);
  const manifest = { schema: capturedSource ? STORYBOARD_BUNDLE_SCHEMA : parts.some(row => row.id === 'legacy-vibes') ? 'qianmu.storyboard.bundle.v2' : 'qianmu.storyboard.bundle.v1', namespace, chatKey, createdAt, credentialsIncluded: false, scope: 'current-chat-and-libraries',
    ...(capturedSource ? { source: capturedSource } : {}),
    entries: parts.map(row => ({ id: row.id, bytes: row.file.size, sha256: kind(row.id) === 'image' ? row.id.slice(6) : '0'.repeat(64), ...(row.mime ? { mime: row.mime } : {}) })) };
  const total = inspectManifest(manifest);
  if (total + prefixBytes + new TextEncoder().encode(JSON.stringify(manifest)).length > STORYBOARD_BUNDLE_LIMITS.total) fail('资源包超过 512 MiB，未读取大文件');
  await guard();
  if (capturedSource) { await sourceIdentityForNamespace(capturedSource, namespace); await guard(); }
  for (let index = 0; index < parts.length; index++) {
    const bytes = new Uint8Array(await parts[index].file.arrayBuffer()); await guard();
    if (bytes.byteLength !== manifest.entries[index].bytes) fail('资源包分段读取大小不符');
    const sha256 = await vibeDigest(bytes); await guard();
    if (kind(parts[index].id) === 'image' && sha256 !== parts[index].id.slice(6)) fail('资源包原件内容摘要不符');
    manifest.entries[index].sha256 = sha256;
  }
  const encoded = new TextEncoder().encode(JSON.stringify(manifest));
  if (encoded.length > STORYBOARD_BUNDLE_LIMITS.manifest) fail('资源包目录过大');
  const length = new Uint8Array(4); new DataView(length.buffer).setUint32(0, encoded.length, true);
  const file = new Blob([magic, length, encoded, ...parts.map(row => row.file)], { type: 'application/vnd.qianmu.bundle' });
  if (file.size > STORYBOARD_BUNDLE_LIMITS.total) fail('资源包超过 512 MiB，未输出缺件包');
  const fingerprint = await vibeDigest(encoded); await guard(); return { file, manifest, fingerprint };
}

export async function openStoryboardBundle(file, { guard = async () => {} } = {}) {
  if (!(file instanceof Blob) || file.size < prefixBytes + 2 || file.size > STORYBOARD_BUNDLE_LIMITS.total) fail('请选择 512 MiB 以内的千幕分段资源包');
  await guard(); const prefix = new Uint8Array(await file.slice(0, prefixBytes).arrayBuffer()); await guard();
  if (prefix.length !== prefixBytes || magic.some((byte, index) => byte !== prefix[index])) fail('不是支持的千幕分段资源包，请保留原文件');
  const length = new DataView(prefix.buffer, prefix.byteOffset, prefix.byteLength).getUint32(magic.length, true);
  if (!length || length > STORYBOARD_BUNDLE_LIMITS.manifest || prefixBytes + length > file.size) fail('资源包目录长度无效');
  const encoded = new Uint8Array(await file.slice(prefixBytes, prefixBytes + length).arrayBuffer()); await guard();
  if (encoded.byteLength !== length) fail('资源包目录不完整');
  const manifest = parseStrictStoryboardJson(text(encoded), { maxBytes: STORYBOARD_BUNDLE_LIMITS.manifest });
  const contentBytes = inspectManifest(manifest);
  if (manifest.source) { await sourceIdentityForNamespace(manifest.source, manifest.namespace); await guard(); }
  if (contentBytes + prefixBytes + length !== file.size) fail('资源包内容被截断或含多余数据');
  const rows = new Map(); let offset = prefixBytes + length;
  for (const row of manifest.entries) { rows.set(row.id, { ...row, offset }); offset += row.bytes; }
  const read = async id => {
    const row = rows.get(id); if (!row) fail('资源包分段不存在'); await guard();
    const part = file.slice(row.offset, row.offset + row.bytes, row.mime || 'application/json'), bytes = new Uint8Array(await part.arrayBuffer()); await guard();
    if (bytes.byteLength !== row.bytes || await vibeDigest(bytes) !== row.sha256) fail('资源包分段内容校验失败，未恢复任何数据');
    await guard(); return { row: { id: row.id, bytes: row.bytes, sha256: row.sha256, ...(row.mime ? { mime: row.mime } : {}) }, bytes, file: part };
  };
  const fingerprint = await vibeDigest(encoded); await guard();
  return Object.freeze({ manifest: structuredClone(manifest), fileBytes: file.size, fingerprint, read,
    async readJson(id) { if (!documents.includes(id)) fail('原图不能作为 JSON 分段读取'); const part = await read(id); return parseStrictStoryboardJson(text(part.bytes), { maxBytes: STORYBOARD_BUNDLE_LIMITS[id] }); },
  });
}
