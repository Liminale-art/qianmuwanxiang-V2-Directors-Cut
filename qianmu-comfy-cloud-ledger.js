// Server-only reservation ledger. No network, executor, in-memory fallback or
// completion inferred from a provider accepting a task. The host owns the store.
import { createHash, randomUUID } from 'node:crypto';
import { imageServiceAccount, imageServiceAccountStillMatches } from './qianmu-image-service-access.js';
import { planComfyCloudOperation, requireComfyCloudTaskId } from './qianmu-comfy-cloud-protocol.js';
import { normalizeComfyCloudIntent, assertComfyCloudReceiptForIntent } from './qianmu-comfy-cloud-receipt.js';
import { normalizeComfyCloudChannel } from './qianmu-comfy-cloud-channel-state.js';

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
  return Object.freeze({
    submission(reservation) {
      const context = issued.get(reservation);
      if (!context) throw fail('ticket', '原云任务未获得本会话提交票据');
      if (context.ticket) return context.ticket;
      let attempted = false, granted = false;
      context.ticket = Object.freeze({
        async beforeSubmit() {
          context.current();
          if (attempted) throw fail('duplicate', '此票据已用于提交，未再次提交');
          attempted = true;
          await transactOwned(reservation, row => {
            context.current();
            if (row.status !== 'reserved' || row.upstreamId) throw fail('ticket_changed', '原云任务不允许再次提交');
            row.status = 'submitting';
          });
          context.current(); granted = true;
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
