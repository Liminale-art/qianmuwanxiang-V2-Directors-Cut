// Server-only reservation ledger. No network, executor, in-memory fallback or
// completion inferred from a provider accepting a task. The host owns the store.
import { createHash, randomUUID } from 'node:crypto';
import { imageServiceAccount, imageServiceAccountStillMatches } from './qianmu-image-service-access.js';
import { planComfyCloudOperation } from './qianmu-comfy-cloud-protocol.js';
import { normalizeComfyCloudIntent } from './qianmu-comfy-cloud-receipt.js';
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
  return Object.freeze({
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
      current(); return result;
    },
  });
}
