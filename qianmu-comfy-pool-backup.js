import { COMFY_POOL_LIMITS } from './qianmu-comfy-pool-store.js';
import { normalizeComfyAutoPool } from './qianmu-comfy-selection.js';
import { assertComfyRouteNamespace } from './qianmu-comfy-route-contract.js';
import { comfyLibraryBackupDigest } from './qianmu-comfy-library-backup.js';

export const COMFY_POOL_BACKUP_SCHEMA = 'qianmu.comfy.pool-backup.v1';
export const COMFY_POOL_BACKUP_BYTES = 24 * 1024 * 1024;
const fail = message => { throw Object.assign(new Error(message), { code: 'comfy_pool_backup', submissionState: 'not_submitted' }); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const integer = (value, min = 0, max = Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(value) && value >= min && value <= max;
const id = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,160}$/.test(value);
const size = value => new TextEncoder().encode(JSON.stringify(value)).byteLength;
const canonical = value => JSON.stringify(value, (_, item) => object(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
const equal = (a, b) => canonical(a) === canonical(b);
const only = (value, keys) => { if (!object(value) || Object.keys(value).some(key => !keys.includes(key))) fail('候选方案备份含未知字段，请保留原文件'); };
const fields = ['id', 'revision', 'version', 'name', 'createdAt', 'updatedAt', 'archived', 'bytes', 'totalBytes', 'candidateCount', 'enabled', 'styleLock'];
const clean = value => Object.fromEntries(fields.filter(key => Object.hasOwn(value, key)).map(key => [key, structuredClone(value[key])]));
function metadata(value) {
  only(value, fields);
  if (!id(value.id) || !id(value.revision) || !integer(value.version, 1, COMFY_POOL_LIMITS.versions)
    || typeof value.name !== 'string' || !value.name || value.name !== value.name.trim() || value.name.length > 80 || /[\u0000-\u001f\u007f]/.test(value.name)
    || !integer(value.createdAt) || !integer(value.updatedAt, value.createdAt) || typeof value.archived !== 'boolean'
    || !integer(value.bytes, 1, COMFY_POOL_LIMITS.documentBytes) || !integer(value.totalBytes, value.bytes, COMFY_POOL_LIMITS.totalBytes)
    || !integer(value.candidateCount, 0, 32) || typeof value.enabled !== 'boolean' || typeof value.styleLock !== 'boolean') fail('候选方案版本索引无效');
}

export function validateComfyPoolBackup(value) {
  only(value, ['schema', 'namespace', 'credentialsIncluded', 'pools']);
  if (value.schema !== COMFY_POOL_BACKUP_SCHEMA || value.credentialsIncluded !== false || !Array.isArray(value.pools) || value.pools.length > COMFY_POOL_LIMITS.plans) fail('候选方案库备份格式或数量无效');
  assertComfyRouteNamespace(value.namespace);
  const ids = new Set(); let bytes = 0, versions = 0;
  for (const row of value.pools) {
    only(row, ['head', 'versions']); metadata(row.head);
    if (ids.has(row.head.id)) fail('候选方案编号重复'); ids.add(row.head.id);
    if (!Array.isArray(row.versions) || row.versions.length !== row.head.version) fail('候选方案缺少历史版本');
    const revisions = new Set(); let sum = 0, updatedAt = row.head.createdAt;
    for (let i = 0; i < row.versions.length; i++) {
      const version = row.versions[i]; only(version, ['meta', 'pool']); metadata(version.meta); const meta = version.meta;
      if (meta.id !== row.head.id || meta.version !== i + 1 || revisions.has(meta.revision) || meta.archived !== false
        || meta.createdAt !== row.head.createdAt || meta.updatedAt < updatedAt) fail('候选方案历史顺序或归属不符');
      revisions.add(meta.revision); updatedAt = meta.updatedAt;
      let pool; try { pool = normalizeComfyAutoPool(version.pool); } catch (_) { fail('候选方案原文无效，请保留原件核对'); }
      if (!equal(pool, version.pool)) fail('候选方案含无法无损保留的字段，未改写原文');
      const documentBytes = size(pool); sum += documentBytes;
      if (pool.namespace !== value.namespace || pool.id !== meta.id || pool.revision !== meta.revision || meta.bytes !== documentBytes || meta.totalBytes !== sum
        || meta.candidateCount !== pool.candidates.length || meta.enabled !== pool.enabled || meta.styleLock !== pool.styleLock) fail('候选方案索引与原文不符');
    }
    const tail = row.versions.at(-1).meta;
    if (row.head.updatedAt < tail.updatedAt || !equal(row.head, { ...tail, archived: row.head.archived, updatedAt: row.head.updatedAt })) fail('候选方案最新指针与历史不符');
    bytes += sum; versions += row.versions.length;
    if (bytes > COMFY_POOL_LIMITS.totalBytes) fail('候选方案库原文超过容量上限');
  }
  if (size(value) > COMFY_POOL_BACKUP_BYTES) fail('候选方案备份超过 24 MiB');
  return { count: ids.size, versions, bytes };
}

export function packComfyPoolRecords(namespace, records) {
  assertComfyRouteNamespace(namespace);
  for (const row of records) {
    only(row.head, [...fields, 'key', 'namespace']);
    for (const version of row.versions) only(version.meta, [...fields, 'key', 'namespace', 'poolKey']);
  }
  const pools = records.map(({ head, versions }) => ({ head: clean(head), versions: versions.map(({ meta, pool }) => ({ meta: clean(meta), pool: structuredClone(pool) })).sort((a, b) => a.meta.version - b.meta.version) })).sort((a, b) => a.head.id.localeCompare(b.head.id));
  const value = { schema: COMFY_POOL_BACKUP_SCHEMA, namespace, credentialsIncluded: false, pools };
  validateComfyPoolBackup(value); return value;
}

export function unpackComfyPoolRecord(namespace, row) {
  assertComfyRouteNamespace(namespace);
  const key = JSON.stringify([namespace, row.head.id]);
  return { head: { ...structuredClone(row.head), namespace, key }, versions: row.versions.map(({ meta, pool }) => {
    // A pool's account is part of its fixed bindings, not just its storage key. Never silently relabel it.
    if (pool.namespace !== namespace) fail('候选方案备份属于另一 ST 账户，请先重新绑定连接与参考图');
    const docKey = JSON.stringify([namespace, meta.id, meta.revision]);
    return { meta: { ...structuredClone(meta), namespace, key: docKey, poolKey: key }, document: {
      key: docKey, namespace, id: meta.id, revision: meta.revision, version: meta.version, name: meta.name, pool: structuredClone(pool), bytes: meta.bytes,
    } };
  }) };
}

export function planComfyPoolRestore(local, incoming, { maxBytes = COMFY_POOL_LIMITS.totalBytes } = {}) {
  const localUsage = validateComfyPoolBackup(local), sourceUsage = validateComfyPoolBackup(incoming);
  if (local.namespace !== incoming.namespace) fail('此备份仅可恢复至同一 ST 账户；跨账户须重新绑定连接与参考图');
  if (!integer(maxBytes, 1, COMFY_POOL_LIMITS.totalBytes)) fail('候选方案恢复容量配置无效');
  const current = new Map(local.pools.map(row => [row.head.id, row])), writes = [];
  let added = 0, extended = 0, kept = 0, addedVersions = 0, addedBytes = 0;
  for (const row of incoming.pools) {
    const old = current.get(row.head.id);
    if (old) {
      for (let i = 0; i < Math.min(old.versions.length, row.versions.length); i++) if (!equal(old.versions[i], row.versions[i])) fail('候选方案存在不同的同编号版本，未覆盖本机数据');
      if (old.head.version >= row.head.version) { kept++; continue; } extended++;
    } else added++;
    const versions = row.versions.slice(old?.versions.length || 0);
    addedVersions += versions.length; addedBytes += versions.reduce((sum, version) => sum + version.meta.bytes, 0); writes.push({ head: row.head, versions });
  }
  if (localUsage.count + added > COMFY_POOL_LIMITS.plans || localUsage.bytes + addedBytes > maxBytes) fail('合并后候选方案超过数量或容量上限，未自动清理');
  return { writes, summary: { added, extended, kept, addedVersions, addedBytes, sourceCount: sourceUsage.count, sourceVersions: sourceUsage.versions } };
}
export const comfyPoolBackupDigest = comfyLibraryBackupDigest;
