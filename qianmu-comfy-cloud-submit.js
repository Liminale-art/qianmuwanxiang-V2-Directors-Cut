// One submission, not a generation scheduler or completion/result delivery API.
import { prepareComfyCloudSubmission } from './qianmu-comfy-cloud-prepare.js';
import { comfyCloudResourceKey } from './qianmu-comfy-cloud-ledger.js';
import { createComfyCloudServerTransport } from './qianmu-comfy-server-transport.js';
import { readComfyCloudJsonResponse, readComfyCloudAcceptance } from './qianmu-comfy-cloud-response.js';
import { COMFY_CLOUD_RECEIPT_SCHEMA } from './qianmu-comfy-cloud-receipt.js';
import { imageServiceAccount, imageServiceAccountStillMatches } from './qianmu-image-service-access.js';

export async function submitComfyCloudTask(req, { request, apiKey, expectedAccount, attemptId } = {}, {
  ledger, authorizeTarget, timeoutMs = 15000, signal, resolveHost, requestImpl, maxBytes,
} = {}) {
  const account = imageServiceAccount(req), prepared = prepareComfyCloudSubmission(request);
  comfyCloudResourceKey(prepared.intent.connection, apiKey);
  let knownId = '', attempted = false, dispatched = false, cancelled = signal?.aborted === true, interruption, response, ticket, stage = 'authorization';
  const ownErrors = new WeakSet();
  const fail = (reason, message) => {
    const error = Object.assign(new Error(message), { code: `comfy_cloud_submit_${reason}`, retryable: false,
      submissionState: knownId ? 'accepted' : attempted ? 'unknown' : 'not_submitted',
      ...(knownId && reason !== 'account' ? { upstreamId: knownId } : {}), needsReview: attempted });
    ownErrors.add(error); return error;
  };
  if (expectedAccount !== account.namespace || typeof attemptId !== 'string' || !/^[a-zA-Z0-9_-]{1,240}$/.test(attemptId)) throw fail('identity', '云任务账户或请求编号未确认');
  if (typeof ledger?.reserve !== 'function' || typeof ledger?.submission !== 'function' || typeof authorizeTarget !== 'function') throw fail('authorization', '云任务缺少持久记录或连接授权');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) throw fail('timeout_config', '云任务提交等待时间无效');
  const controller = new AbortController(), deadline = performance.now() + timeoutMs;
  const check = () => {
    if (interruption) throw interruption;
    if (performance.now() >= deadline) throw fail('timeout', '提交等待超时，请核查原任务，未重新提交');
    if (cancelled && !dispatched) throw fail('cancelled', '已取消等待，未继续提交云任务');
    if (!imageServiceAccountStillMatches(req, account)) throw fail('account', 'ST账户已变化，未交付云任务状态');
  };
  let timer, onAbort;
  const stopped = new Promise((_, reject) => {
    timer = setTimeout(() => {
      interruption = fail('timeout', '提交等待超时，请核查原任务，未重新提交');
      controller.abort(); reject(interruption);
    }, timeoutMs);
    // After dispatch this is a UI cancellation, not permission to forget a
    // potentially paid task. The independent deadline still bounds the drain.
    onAbort = () => { cancelled = true; if (!dispatched) {
      interruption = fail('cancelled', '已取消等待，未继续提交云任务'); controller.abort(); reject(interruption);
    } };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
  const work = async () => {
    try {
      check();
      const transport = await createComfyCloudServerTransport(req, { binding: prepared.intent.connection, operation: 'submit' }, {
        signal: controller.signal, resolveHost, requestImpl,
        authorizeTarget: async (...args) => {
          check(); const verify = await authorizeTarget(...args); check();
          if (typeof verify !== 'function') throw fail('authorization', '云连接缺少持续授权校验');
          return async () => { check(); await verify(); check(); };
        },
      });
      check(); stage = 'reservation';
      const reservation = await ledger.reserve(req, { apiKey, expectedAccount, attemptId, intent: prepared.intent });
      ticket = ledger.submission(reservation); check();
      const cloud = prepared.intent.connection.provider === 'comfy-cloud';
      const body = JSON.stringify(cloud ? prepared.body : { ...prepared.body, apiKey });
      stage = 'submission'; attempted = true; await ticket.beforeSubmit(); check();
      dispatched = true;
      response = await transport.fetchImpl(transport.plan.url, { method: 'POST', headers: {
        Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', Accept: 'application/json',
        ...(cloud ? { 'Idempotency-Key': reservation.fence } : {}),
      }, body, signal: controller.signal });
      // Do not check the page/account here: bounded acceptance must first be
      // stored for the owner captured before dispatch, even after disconnection.
      stage = 'response';
      const value = await readComfyCloudJsonResponse(response, { maxBytes, signal: controller.signal,
        timeoutMs: Math.max(1, Math.ceil(deadline - performance.now())) });
      let task;
      try { task = readComfyCloudAcceptance(prepared.intent.connection, value); knownId = task.taskId; }
      catch (error) {
        if (error.submissionState === 'accepted' && error.upstreamId) {
          knownId = error.upstreamId; await ticket.recordAccepted(knownId);
        }
        throw error;
      }
      stage = 'record';
      await ticket.recordAccepted(knownId, { schema: COMFY_CLOUD_RECEIPT_SCHEMA, task,
        requestDigest: prepared.intent.requestDigest, workflow: prepared.intent.workflow, stillOutput: prepared.intent.stillOutput });
      check(); stage = 'delivery'; await transport.verify(); check();
      if (cancelled) throw fail('cancelled', '已停止等待，原云任务已保留，未重新提交');
      return Object.freeze({ ok: true, status: 'accepted', task, locator: Object.freeze({ version: 1, channelKey: reservation.channelKey, attemptId }) });
    } catch (cause) {
      let cleanupFailed = false;
      if (ticket) {
        try { if (attempted) await ticket.markUncertain(); else await ticket.releaseUnsent(); }
        catch (_) { cleanupFailed = true; }
      }
      const error = ownErrors.has(cause) ? cause : fail(stage, '云任务提交状态暂无法确认，请核查原连接与任务记录');
      if (cleanupFailed) { error.recordCleanupFailed = true; error.needsReview = true; }
      if (response && !response.ok && Number.isInteger(response.status)) error.httpStatus = response.status;
      throw error;
    }
  };
  try { return await Promise.race([work(), stopped]); }
  finally {
    clearTimeout(timer); signal?.removeEventListener('abort', onAbort); controller.abort();
    try { Promise.resolve(response?.body?.cancel?.()).catch(() => {}); } catch (_) { /* Bounded transport owns any remaining stream. */ }
  }
}
