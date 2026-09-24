// Server-only metadata ledger for a frozen batch. This scope has no executor,
// provider credential, prompt body, reference asset, or HTTP route.
import { createImageServiceStore } from './qianmu-image-service-store.js';
import { imageServiceAccount, imageServiceAccountStillMatches } from './qianmu-image-service-access.js';
import {
  batchPublicView,
  createStoryboardServerBatchBusinessError,
  normalizeBatchRecord,
  normalizePreparedBatch,
  storyboardServerBatchKey,
} from './qianmu-storyboard-server-batch-contract.js';

const fail = (code, message, status = 409) => Object.assign(new Error(message), {
  name: 'StoryboardServerBatchError', code: `storyboard_server_batch_${code}`,
  status, submissionState: 'not_submitted',
});

export function createStoryboardServerBatchStore({ dataRoot, store, now = Date.now } = {}) {
  const ledger = store ?? createImageServiceStore({ dataRoot, scope: 'storyboard-batch' });
  if (typeof ledger.transaction !== 'function' || typeof ledger.inspectChannel !== 'function'
    || typeof ledger.close !== 'function' || typeof now !== 'function') {
    throw fail('storage', '分镜批次缺少可信的持久记录服务');
  }

  const current = (request, account) => {
    if (!imageServiceAccountStillMatches(request, account)) {
      throw createStoryboardServerBatchBusinessError('account_changed', 'ST 账户已变化，请以原账户核对批次', 401);
    }
  };
  const time = () => {
    const value = now();
    if (!Number.isSafeInteger(value) || value < 0) throw fail('clock', '服务端时间无效，未更改批次记录');
    return value;
  };
  const read = (request, batchId) => {
    const account = imageServiceAccount(request);
    return { account, key: storyboardServerBatchKey(account.namespace, batchId) };
  };

  async function prepare(request, input) {
    const account = imageServiceAccount(request);
    const prepared = normalizePreparedBatch(input, account.namespace, time());
    const key = storyboardServerBatchKey(account.namespace, prepared.batchId);
    const result = await ledger.transaction(key, previous => {
      current(request, account);
      if (previous) {
        const existing = normalizeBatchRecord(previous, key);
        if (existing.digest !== prepared.digest) {
          throw createStoryboardServerBatchBusinessError('conflict', '同一批次编号已有不同内容，未覆盖原批次');
        }
        return { state: previous, result: batchPublicView(existing), unchanged: true };
      }
      return { state: prepared, result: batchPublicView(prepared) };
    });
    current(request, account);
    return result;
  }

  async function query(request, batchId) {
    const { account, key } = read(request, batchId);
    const raw = await ledger.inspectChannel(key);
    current(request, account);
    if (!raw) return null;
    const record = normalizeBatchRecord(raw, key);
    if (record.expectedAccount !== account.namespace) throw createStoryboardServerBatchBusinessError('identity', '原批次归属不匹配，未交付记录');
    return batchPublicView(record);
  }

  async function stop(request, batchId, expectedRevision) {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
      throw createStoryboardServerBatchBusinessError('revision', '请先核对原批次版本后再停止', 400);
    }
    const { account, key } = read(request, batchId);
    const result = await ledger.transaction(key, previous => {
      current(request, account);
      if (!previous) throw createStoryboardServerBatchBusinessError('not_found', '原批次不存在，请核对后重试', 404);
      const existing = normalizeBatchRecord(previous, key);
      if (existing.expectedAccount !== account.namespace) throw createStoryboardServerBatchBusinessError('identity', '原批次归属不匹配，未更改记录');
      if (existing.state === 'stopped_unrunnable') {
        return { state: previous, result: batchPublicView(existing), unchanged: true };
      }
      if (existing.stateRevision !== expectedRevision) {
        throw createStoryboardServerBatchBusinessError('revision', '原批次已变化，请重新核对后再停止');
      }
      const stoppedAt = Math.max(time(), existing.updatedAt);
      const stopped = normalizeBatchRecord({
        ...existing, state: 'stopped_unrunnable', stateRevision: existing.stateRevision + 1,
        updatedAt: stoppedAt, stoppedAt,
      }, key);
      return { state: stopped, result: batchPublicView(stopped) };
    });
    current(request, account);
    return result;
  }

  return Object.freeze({ prepare, query, stop, close: () => ledger.close() });
}
