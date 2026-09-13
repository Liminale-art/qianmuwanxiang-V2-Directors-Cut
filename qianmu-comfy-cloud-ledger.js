// Server-only reservation ledger. No network, executor, in-memory fallback or
// completion inferred from a provider accepting a task. The host owns the store.
import { createHash, randomUUID } from 'node:crypto';
import { imageServiceAccount, imageServiceAccountStillMatches } from './qianmu-image-service-access.js';
import { planComfyCloudOperation, requireComfyCloudTaskId, bindComfyCloudTask } from './qianmu-comfy-cloud-protocol.js';
import { normalizeComfyCloudIntent, assertComfyCloudReceiptForIntent } from './qianmu-comfy-cloud-receipt.js';
import { normalizeComfyCloudChannel } from './qianmu-comfy-cloud-channel-state.js';
import { normalizeComfyCloudStage } from './qianmu-comfy-cloud-stage-contract.js';

const fail = (reason, message) => Object.assign(new Error(message), { code: `image_service_cloud_${reason}`, status: 409, retryable: false });
const id = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,240}$/.test(value);

export function comfyCloudResourceKey(connection, apiKey) {
  const { provider, origin } = planComfyCloudOperation(connection, 'submit');
  if (typeof apiKey !== 'string' || !/^[\x21-\x7e]{1,2048}$/.test(apiKey)) throw fail('key', '云端Key无效，请核对当前连接');
  // Same actual credential shares occupancy across ST accounts. Neither the ST
  // user nor protocol revision can be used to evade that occupancy. Do not infer
  // endpoint aliases, account concurrency tiers or physical hardware identity.
  return createHash('sha256').update(JSON.stringify(['qianmu.cloud-resource.v1', provider, origin, apiKey])).digest('hex');
}

export function createComfyCloudLedger({ store, ownerId = randomUUID(), now = Date.now } = {}) {
  if (typeof store?.transaction !== 'function' || !id(ownerId) || typeof now !== 'function') throw fail('storage', '云任务缺少持久记录服务');
  const issued = new WeakMap();
  const transactOwned = (reservation, change) => store.transaction(reservation.channelKey, value => {
    const state = normalizeComfyCloudChannel(value, reservation.channelKey);
    const row = state.entries.find(item => item.namespace === reservation.namespace && item.attemptId === reservation.attemptId);
    if (!row || row.ownerId !== ownerId || row.fence !== reservation.fence || row.requestDigest !== reservation.requestDigest
      || JSON.stringify(row.cloudIntent) !== JSON.stringify(reservation.cloudIntent)) throw fail('ticket_changed', '原云任务票据已变化，请核查原任务');
    change(row); row.updatedAt = Math.max(now(), row.updatedAt);
    return { state: normalizeComfyCloudChannel(state, reservation.channelKey) };
  });
  async function authorizeOriginal(req, { channelKey, attemptId, apiKey } = {}, rawTask, archiveOnly = false) {
    const account = imageServiceAccount(req), task = bindComfyCloudTask(rawTask, rawTask?.taskId, rawTask?.links);
    if (typeof store.inspectChannel !== 'function' || !id(attemptId)
      || (archiveOnly ? typeof channelKey !== 'string' || !/^[a-f0-9]{64}$/.test(channelKey) : channelKey !== comfyCloudResourceKey(task, apiKey))) {
      throw fail('query_identity', '请使用原云连接与原任务核查');
    }
    const current = () => { if (!imageServiceAccountStillMatches(req, account)) throw fail('account_changed', 'ST账户已变化，未交付云任务状态'); };
    const signature = row => JSON.stringify([row.ownerId, row.fence, row.requestDigest, row.cloudIntent, row.cloudReceipt]);
    const read = async () => {
      current();
      const state = normalizeComfyCloudChannel(await store.inspectChannel(channelKey), channelKey); current();
      const row = state.entries.find(item => item.namespace === account.namespace && item.attemptId === attemptId);
      if (!row?.cloudIntent || !row.cloudReceipt || row.upstreamId !== task.taskId
        || JSON.stringify(row.cloudReceipt.task) !== JSON.stringify(task)) throw fail('query_identity', '原云任务凭据不完整或不匹配，请先核查');
      return { signature: signature(row), receipt: row.cloudReceipt, delivery: row.cloudDelivery || null,
        identity: Object.freeze({ namespace: row.namespace, channelKey, attemptId: row.attemptId, requestDigest: row.requestDigest, fence: row.fence }) };
    };
    const { signature: original, receipt, identity } = await read();
    const verifiedRead = async () => {
      const snapshot = await read();
      if (snapshot.signature !== original) throw fail('query_changed', '原云任务归属或收据已变化，未交付查询结果');
      return snapshot;
    };
    const verify = async () => { await verifiedRead(); return receipt; };
    async function recordStored(cache, { signal } = {}) {
      const check = () => { current(); if (signal?.aborted) throw fail('delivery_cancelled', '已停止确认暂存，原图仍保留'); };
      check(); await verify();
      if (typeof cache?.load !== 'function') throw fail('delivery_storage', '缺少原图完整回读服务');
      // Host-owned cache must perform the full file/hash read. A metadata-only
      // ready flag or a browser-supplied receipt cannot settle paid occupancy.
      const result = await cache.load(identity); check(); await verify();
      if (result?.ok !== true || result.ready !== true || typeof result.receipt !== 'string' || !/^[a-f0-9]{64}$/.test(result.receipt)) throw fail('delivery_missing', '原图尚未完整暂存，未确认完成');
      const cloud = normalizeComfyCloudStage(result.cloud, identity);
      if (JSON.stringify(cloud.receipt) !== JSON.stringify(receipt) || result.provider !== task.provider || result.upstreamId !== task.taskId
        || result.model !== receipt.stillOutput.model || !Array.isArray(result.images) || result.images.length !== cloud.images.length
        || result.images.some((image, index) => !(image.bytes instanceof Uint8Array) || image.bytes.byteLength !== cloud.selection[index].sizeBytes)) throw fail('delivery_mismatch', '暂存原图与原任务不符，未确认完成');
      const summary = { cacheReceipt: result.receipt, bytes: cloud.selection.reduce((sum, image) => sum + image.sizeBytes, 0), imageCount: cloud.images.length };
      check();
      // Cache IO is complete before entering the ledger transaction, avoiding
      // re-entrant operations on the same host store queue.
      const saved = await store.transaction(channelKey, raw => {
        check();
        const state = normalizeComfyCloudChannel(raw, channelKey);
        const row = state.entries.find(item => item.namespace === identity.namespace && item.attemptId === identity.attemptId);
        if (!row || signature(row) !== original || !['submitting', 'uncertain', 'acknowledged', 'succeeded'].includes(row.status)) throw fail('query_changed', '原云任务已变化，未确认暂存');
        if (row.cloudDelivery) {
          if (Object.keys(summary).some(key => row.cloudDelivery[key] !== summary[key])) throw fail('delivery_conflict', '原任务已关联其他暂存凭证，未覆盖');
        } else {
          const at = Math.max(now(), row.updatedAt);
          row.status = 'succeeded'; row.updatedAt = at;
          row.cloudDelivery = { schema: 'qianmu.comfy-cloud-delivery.v1', state: 'stored', ...summary, storedAt: at };
        }
        const normalized = normalizeComfyCloudChannel(state, channelKey);
        return { state: normalized, result: normalized.entries.find(item => item.namespace === identity.namespace && item.attemptId === identity.attemptId).cloudDelivery };
      });
      check(); await verify();
      return Object.freeze({ result, delivery: saved });
    }
    async function recordArchived(cache, { receipt: cacheReceipt, archived, signal } = {}) {
      const check = () => { current(); if (signal?.aborted) throw fail('delivery_cancelled', '已停止归档确认，原记录和暂存仍保留'); };
      check();
      if (archived !== true || typeof cacheReceipt !== 'string' || !/^[a-f0-9]{64}$/.test(cacheReceipt)) throw fail('archive_confirmation', '请先保存原图，再确认归档');
      const before = (await verifiedRead()).delivery; check();
      if (!before || before.cacheReceipt !== cacheReceipt) throw fail('archive_receipt', '归档凭证与原暂存不符，未确认或清理');
      // A previous durable ACK may have already removed some/all image files.
      // Only that exact recorded receipt permits cleanup retry without rereading
      // missing bytes. First-time ACK always revalidates the complete original.
      if (before.state === 'archived') return before;
      await recordStored(cache, { signal }); check();
      const saved = await store.transaction(channelKey, raw => {
        check();
        const state = normalizeComfyCloudChannel(raw, channelKey);
        const row = state.entries.find(item => item.namespace === identity.namespace && item.attemptId === identity.attemptId);
        const delivery = row?.cloudDelivery;
        if (!row || signature(row) !== original || row.status !== 'succeeded' || !delivery
          || ['cacheReceipt', 'bytes', 'imageCount', 'storedAt'].some(key => delivery[key] !== before[key])) throw fail('archive_changed', '原暂存记录已变化，未确认归档');
        if (delivery.state !== 'archived') {
          const at = Math.max(now(), row.updatedAt);
          row.updatedAt = at; row.cloudDelivery = { ...delivery, state: 'archived', archivedAt: at };
        }
        const normalized = normalizeComfyCloudChannel(state, channelKey);
        return { state: normalized, result: normalized.entries.find(item => item.namespace === identity.namespace && item.attemptId === identity.attemptId).cloudDelivery };
      });
      check(); await verify();
      return saved;
    }
    // Server-internal evidence only. The identity and verifier originate in the
    // same read; do not acquire a fresh fence after downloading or expose this
    // object as an HTTP response. It does not grant target IO or submission.
    return Object.freeze({ identity, receipt, verify, ...(archiveOnly ? {} : { recordStored }), recordArchived, readDelivery: async () => (await verifiedRead()).delivery });
  }
  return Object.freeze({
    submission(reservation) {
      const context = issued.get(reservation);
      if (!context) throw fail('ticket', '原云任务未获得本会话提交票据');
      if (context.ticket) return context.ticket;
      let attempted = false, granted = false, halted = false;
      context.ticket = Object.freeze({
        async releaseUnsent() {
          if (attempted) throw fail('ticket_changed', '已进入提交阶段，不能按未发送释放');
          halted = true;
          await transactOwned(reservation, row => {
            if (row.status !== 'reserved' || row.upstreamId) throw fail('ticket_changed', '原预留不允许按未发送释放');
            row.status = 'released';
          });
        },
        async markUncertain() {
          if (!attempted) throw fail('ticket_changed', '尚未进入提交阶段，请核对原预留');
          halted = true;
          await transactOwned(reservation, row => {
            if (!['submitting', 'uncertain'].includes(row.status)) throw fail('ticket_changed', '原任务已不在提交阶段');
            row.status = 'uncertain';
          });
        },
        async beforeSubmit() {
          context.current();
          if (halted) throw fail('ticket_changed', '此云任务已停止获取提交许可');
          if (attempted) throw fail('duplicate', '此票据已用于提交，未再次提交');
          attempted = true;
          await transactOwned(reservation, row => {
            context.current();
            if (row.status !== 'reserved' || row.upstreamId) throw fail('ticket_changed', '原云任务不允许再次提交');
            row.status = 'submitting';
          });
          context.current();
          if (halted) throw fail('ticket_changed', '此云任务已转为核查，未继续提交');
          granted = true;
        },
        async recordAccepted(upstreamId, rawReceipt) {
          if (!granted) throw fail('ticket', '云任务尚未获得提交授权');
          requireComfyCloudTaskId(reservation.cloudIntent.connection, upstreamId);
          try {
            // Record the id first even if links/output evidence is incomplete.
            // No current-login check here: this stores evidence for the original
            // owner after disconnection; it grants no new network or delivery IO.
            const accepted = row => {
              if (!['submitting', 'uncertain'].includes(row.status) || row.upstreamId && row.upstreamId !== upstreamId) throw fail('ticket_changed', '原云任务受理编号已变化');
              row.upstreamId = upstreamId;
            };
            await transactOwned(reservation, accepted);
            if (rawReceipt !== undefined) {
              const receipt = assertComfyCloudReceiptForIntent(rawReceipt, reservation.cloudIntent, upstreamId);
              await transactOwned(reservation, row => {
                accepted(row);
                if (row.cloudReceipt && JSON.stringify(row.cloudReceipt) !== JSON.stringify(receipt)) throw fail('ticket_changed', '原云任务收据已变化');
                row.cloudReceipt = receipt;
              });
            }
          } catch (_) {
            throw Object.assign(fail('acceptance_unconfirmed', '云端已受理，原任务记录尚待核查，未重新提交'), { submissionState: 'accepted', upstreamId });
          }
        },
      });
      return context.ticket;
    },
    async authorizeQuery(req, locator, rawTask) {
      // New sessions may inspect old tasks, but never recreate their submission
      // tickets. Target authorization remains a separate transport requirement.
      return (await authorizeOriginal(req, locator, rawTask)).verify;
    },
    authorizeStaging: (req, locator, task) => authorizeOriginal(req, locator, task),
    // Local archive authority is account scoped, not dependent on retaining a
    // provider Key. This cannot create a submission ticket or settle new files.
    authorizeArchive: (req, locator, task) => authorizeOriginal(req, locator, task, true),
    async reserve(req, { apiKey, expectedAccount, attemptId, intent: rawIntent } = {}) {
      const account = imageServiceAccount(req);
      if (expectedAccount !== account.namespace || !id(attemptId)) throw fail('identity', '云任务账户或请求编号未确认');
      const intent = normalizeComfyCloudIntent(rawIntent), channelKey = comfyCloudResourceKey(intent.connection, apiKey);
      if (intent.workflow.binding && intent.workflow.binding.namespace !== account.namespace) throw fail('identity', '工作流方案不属于当前ST账户');
      const current = () => { if (!imageServiceAccountStillMatches(req, account)) throw fail('account_changed', 'ST账户已变化，未继续提交云任务'); };
      current();
      const result = await store.transaction(channelKey, value => {
        current();
        const state = normalizeComfyCloudChannel(value, channelKey);
        const previous = state.entries.find(row => row.namespace === account.namespace && row.attemptId === attemptId);
        if (previous) throw fail(previous.requestDigest === intent.requestDigest ? 'duplicate' : 'conflict', '此云请求已存在，请核查原任务，未重复提交');
        if (state.entries.some(row => ['reserved', 'submitting', 'uncertain'].includes(row.status))) throw fail('occupied', '此云连接仍有未完成或待核查任务，请先核查原任务');
        if (state.entries.length >= 4096) throw fail('full', '云任务记录已满，请先导出或整理');
        const at = now();
        const row = { namespace: account.namespace, attemptId, requestDigest: intent.requestDigest, ownerId, fence: randomUUID(),
          status: 'reserved', automatic: intent.stillOutput.execution.automatic, createdAt: at, updatedAt: at, cloudIntent: intent };
        state.entries.push(row);
        const normalized = normalizeComfyCloudChannel(state, channelKey);
        return { state: normalized, result: Object.freeze({ channelKey, ...normalized.entries.at(-1) }) };
      });
      // A changed login after the write must not receive authority. Keep the
      // durable reservation for the original account; never pretend it vanished.
      current(); issued.set(result, { current }); return result;
    },
  });
}
