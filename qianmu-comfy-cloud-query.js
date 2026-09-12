// One authenticated status read, not a scheduler, submitter, downloader or public route.
import { bindComfyCloudTask } from './qianmu-comfy-cloud-protocol.js';
import { readComfyCloudJsonResponse, readComfyCloudTaskStatus } from './qianmu-comfy-cloud-response.js';
import { createComfyCloudServerTransport } from './qianmu-comfy-server-transport.js';
import { imageServiceAccount, imageServiceAccountStillMatches } from './qianmu-image-service-access.js';

export async function queryComfyCloudTask(req, task, { apiKey, authorizeTask, authorizeTarget, timeoutMs = 15000,
  signal, resolveHost, requestImpl, maxBytes } = {}) {
  const original = bindComfyCloudTask(task, task?.taskId, task?.links);
  const ownErrors = new WeakSet();
  const fail = (code, message) => {
    const error = Object.assign(new Error(message), { code: `comfy_cloud_query_${code}`, submissionState: 'accepted', upstreamId: original.taskId, retryable: false });
    ownErrors.add(error); return error;
  };
  let account; try { account = imageServiceAccount(req); } catch (_) { throw fail('account', '请先登录原ST账户核查云端任务'); }
  if (typeof apiKey !== 'string' || !/^[\x21-\x7e]{1,2048}$/.test(apiKey)) throw fail('key', '云端Key无效，请核对当前连接');
  if (typeof authorizeTask !== 'function' || typeof authorizeTarget !== 'function') throw fail('authorization', '云端原任务尚未获得查询授权');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) throw fail('timeout_config', '云端查询等待时间无效');
  const controller = new AbortController(), deadline = performance.now() + timeoutMs;
  let timer, onAbort, interruption, response, stage = 'authorization';
  const check = () => {
    if (interruption) throw interruption;
    if (!imageServiceAccountStillMatches(req, account)) throw fail('account', 'ST账户已变化，未交付云端原任务状态');
  };
  const stopped = new Promise((_, reject) => {
    const stop = error => { interruption ||= error; reject(interruption); controller.abort(interruption); };
    timer = setTimeout(() => stop(fail('timeout', '云端任务查询超时，原任务仍保留，未重新提交')), timeoutMs);
    onAbort = () => stop(fail('cancelled', '已停止查询，云端原任务仍保留'));
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
  const work = async () => {
    check();
    // The service coordinator must supply this grant from its original stored task,
    // not from a caller-supplied namespace. Keep rechecking through delivery.
    const verifyTask = await authorizeTask(req, original, account); check();
    if (typeof verifyTask !== 'function') throw fail('authorization', '云端原任务缺少持续归属校验');
    const verify = async () => { check(); await verifyTask(); check(); };
    await verify(); stage = 'connection';
    const transport = await createComfyCloudServerTransport(req, { binding: original, operation: 'query', task: original }, {
      signal: controller.signal, resolveHost, requestImpl,
      authorizeTarget: async (...args) => {
        await verify(); const verifyTarget = await authorizeTarget(...args); check();
        if (typeof verifyTarget !== 'function') throw fail('authorization', '云端连接缺少持续授权校验');
        return async () => { await verify(); await verifyTarget(); check(); };
      },
    });
    check(); stage = 'request';
    response = await transport.fetchImpl(transport.plan.url, { method: transport.plan.method,
      headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json', ...(transport.plan.body ? { 'Content-Type': 'application/json' } : {}) },
      ...(transport.plan.body ? { body: JSON.stringify(transport.plan.body) } : {}), signal: controller.signal,
    });
    check(); stage = 'response';
    const body = await readComfyCloudJsonResponse(response, { task: original, maxBytes, signal: controller.signal,
      timeoutMs: Math.max(1, Math.ceil(deadline - performance.now())) });
    check(); const result = readComfyCloudTaskStatus(original, body);
    stage = 'delivery'; await transport.verify(); check();
    return result;
  };
  try { return await Promise.race([work(), stopped]); }
  catch (cause) {
    if (interruption) throw interruption;
    if (ownErrors.has(cause)) throw cause;
    if (stage === 'response' && cause?.code === 'comfy_cloud_response_timeout') throw fail('timeout', '云端任务查询超时，原任务仍保留，未重新提交');
    const error = fail(stage, '云端原任务状态暂无法确认，请核查原连接与任务记录');
    if (Number.isInteger(response?.status) && !response.ok) error.httpStatus = response.status;
    throw error;
  } finally {
    clearTimeout(timer); signal?.removeEventListener('abort', onAbort);
    controller.abort();
    try { Promise.resolve(response?.body?.cancel?.()).catch(() => {}); } catch (_) { /* Already read/locked; aborted transport owns cleanup. */ }
  }
}
