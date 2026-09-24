// R2-03 server-only v2 layout checkpoint. This module makes no directories,
// reads no files, and never authorizes an image request or a fee. The v1
// store has no production route; v2 is fresh-only, never a v1 migration.
// Partition persistence and directory pagination are NOT implemented here.
import { createHash } from 'node:crypto';
import {
  batchPublicView,
  createStoryboardServerBatchBusinessError,
  normalizeBatchRecord,
  storyboardServerBatchKey,
} from './qianmu-storyboard-server-batch-contract.js';

const ACCOUNT_DOMAIN = 'qianmu.storyboard-batch-account-directory.v2';
const SHARD_DOMAIN = 'qianmu.storyboard-batch-shard.v2';
const sha256 = value => createHash('sha256').update(value).digest('hex');
const conflict = message => { throw createStoryboardServerBatchBusinessError('conflict', message); };

// Both path-derived pieces are hashes of contract-validated identities, never
// request-provided directory names. The 2-hex shard is a location, not a claim
// that the legacy 128-file limit or the future list performance is solved.
export function storyboardBatchV2Location(expectedAccount, batchId) {
  const key = storyboardServerBatchKey(expectedAccount, batchId);
  const accountDirectory = sha256(JSON.stringify([ACCOUNT_DOMAIN, expectedAccount]));
  const shard = sha256(JSON.stringify([SHARD_DOMAIN, batchId])).slice(0, 2);
  return Object.freeze({
    key,
    segments: Object.freeze(['.qianmu-service', 'storyboard-batches-v2', accountDirectory, shard]),
  });
}

// A future store must prove the entire v1 directory is ABSENT, not merely that
// this batch ID was not found. It must repeat that check under its own durable
// cross-process write lock. Any unexpected v1 directory is preserved for
// offline review; there is no fallback write, migration, route or execution.
export function decideStoryboardBatchV2Prepare(prepared, inspection = {}) {
  let fields;
  try {
    if (inspection && typeof inspection === 'object' && !Array.isArray(inspection)
      && [Object.prototype, null].includes(Object.getPrototypeOf(inspection))) {
      fields = Object.getOwnPropertyDescriptors(inspection);
    }
  } catch (_) { /* A proxy trap is not a trusted inspection result. */ }
  if (!fields || Reflect.ownKeys(fields).some(key => !['legacyDirectoryStatus', 'v2Record'].includes(key))
    || !Object.hasOwn(fields.legacyDirectoryStatus || {}, 'value')
    || fields.legacyDirectoryStatus.value !== 'absent'
    || (fields.v2Record && !Object.hasOwn(fields.v2Record, 'value'))) {
    conflict('旧批次目录未确认不存在，未新建或覆盖批次');
  }
  const location = storyboardBatchV2Location(prepared?.expectedAccount, prepared?.batchId);
  const incoming = normalizeBatchRecord(prepared, location.key);
  if (incoming.state !== 'prepared_unrunnable') {
    throw createStoryboardServerBatchBusinessError('identity', '只接受新准备的批次，不复制已停止的旧记录', 400);
  }
  const existing = fields.v2Record?.value == null ? null : normalizeBatchRecord(fields.v2Record.value, location.key);
  if (existing && existing.digest !== incoming.digest) conflict('同一批次编号已有不同内容，未覆盖原批次');
  return Object.freeze(existing
    ? { kind: 'existing_v2', location, view: batchPublicView(existing) }
    : { kind: 'insert_v2', location, record: incoming });
}
