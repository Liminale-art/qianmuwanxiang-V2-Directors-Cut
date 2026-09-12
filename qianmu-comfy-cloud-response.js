// Bounded response reading and identity/status projection; no submission, billing or retry.
import { bindComfyCloudTask, requireComfyCloudTaskId, planComfyCloudOperation } from './qianmu-comfy-cloud-protocol.js';
import { parseBoundedJson } from './qianmu-json-input.js';
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const fail = (code, message, taskId = '') => {
  throw Object.assign(new Error(message), { code: `comfy_cloud_response_${code}`, retryable: false,
    submissionState: taskId ? 'accepted' : 'unknown', ...(taskId ? { upstreamId: taskId } : {}) });
};

// Called only after response headers arrive. Header/connect deadlines belong to the
// operation runner; this deadline covers a body that never finishes or stops mid-stream.
export async function readComfyCloudJsonResponse(response, { task, maxBytes = 1024 * 1024, timeoutMs = 15000, signal } = {}) {
  const original = task ? bindComfyCloudTask(task, task.taskId, task.links) : null;
  const ownErrors = new WeakSet();
  const error = (code, message) => {
    const result = Object.assign(new Error(message), { code: `comfy_cloud_response_${code}`, retryable: false,
      submissionState: original ? 'accepted' : 'unknown', ...(original ? { upstreamId: original.taskId } : {}) });
    ownErrors.add(result); return result;
  };
  let reader, timer, onAbort, interruption;
  const cancelBody = () => {
    // Never wait indefinitely for a broken stream's cancellation callback.
    try { Promise.resolve(reader ? reader.cancel() : response?.body?.cancel?.()).catch(() => {}); } catch (_) { /* Best effort cleanup. */ }
  };
  try {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 2 * 1024 * 1024
      || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) throw error('limits', '云端响应读取限制无效');
    if (signal?.aborted) throw error('cancelled', '已停止读取云端响应，原任务请到平台核查');
    if (!response?.ok) throw Object.assign(error('http', '云端请求未正常返回，请核查原任务'),
      { httpStatus: Number.isInteger(response?.status) ? response.status : 0 });
    const mime = String(response.headers?.get?.('content-type') || '').split(';', 1)[0].trim().toLowerCase();
    if (!/^application\/(?:json|[a-z0-9!#$&^_.+-]+\+json)$/.test(mime)) throw error('type', '云端未返回JSON数据，原任务状态尚未确认');
    const declared = response.headers?.get?.('content-length');
    if (declared !== null && declared !== undefined && (!/^\d+$/.test(declared) || !Number.isSafeInteger(Number(declared)) || Number(declared) > maxBytes)) {
      throw error('size', '云端响应超过读取上限或长度无效，未截断接收');
    }
    if (!response.body?.getReader || response.body.locked) throw error('stream', '云端响应无法安全读取');
    reader = response.body.getReader();
    const interrupted = new Promise((_, reject) => {
      const stop = reason => { interruption = reason; reject(reason); cancelBody(); };
      timer = setTimeout(() => stop(error('timeout', '读取云端响应超时，请核查原任务，未重新提交')), timeoutMs);
      onAbort = () => stop(error('cancelled', '已停止读取云端响应，原任务请到平台核查'));
      signal?.addEventListener('abort', onAbort, { once: true });
    });
    const chunks = []; let bytes = 0;
    while (true) {
      const part = await Promise.race([reader.read(), interrupted]);
      if (interruption) throw interruption;
      if (part.done) break;
      if (!(part.value instanceof Uint8Array)) throw error('stream', '云端响应流格式无效');
      bytes += part.value.byteLength;
      if (bytes > maxBytes || chunks.length >= 16384) throw error('size', '云端响应超过读取上限，未截断接收');
      chunks.push(new Uint8Array(part.value));
    }
    const joined = new Uint8Array(bytes); let offset = 0;
    for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.byteLength; }
    let body;
    try { body = parseBoundedJson(new TextDecoder('utf-8', { fatal: true }).decode(joined), { maxBytes, maxDepth: 32, maxNodes: 100000, label: '云端响应' }); }
    catch (_) { throw error('json', '云端JSON数据无效或超限，请核查原任务'); }
    if (!object(body)) throw error('shape', '云端未返回有效任务数据');
    return body;
  } catch (cause) {
    if (ownErrors.has(cause)) throw cause;
    throw error('stream', '读取云端响应失败，请核查原任务');
  } finally {
    clearTimeout(timer); if (onAbort) signal?.removeEventListener('abort', onAbort);
    cancelBody(); if (reader) { try { reader.releaseLock(); } catch (_) { /* Already released or broken. */ } }
  }
}

export function readComfyCloudAcceptance(binding, body) {
  planComfyCloudOperation(binding, 'submit'); // Reject unrecognized local bindings before interpreting a remote body.
  if (!object(body)) fail('shape', '云端提交结果无法确认，请勿重复生成');
  const cloud = binding.provider === 'comfy-cloud';
  if (!cloud && (body.code !== 0 || !object(body.data))) fail('acceptance', '云端未确认提交结果，请核查原任务');
  const id = cloud ? body.id : body.data.taskId;
  try { requireComfyCloudTaskId(binding, id); }
  catch (_) { fail('identity', '云端未返回有效任务编号，请勿重复生成'); }
  try { return bindComfyCloudTask(binding, id, cloud ? body.urls : undefined); }
  catch (_) { fail('links', '云端已返回任务编号，但查询地址无法确认，请核查原任务', id); }
}

const cloudStates = Object.freeze({ queued: 'queued', running: 'running', succeeded: 'succeeded',
  canceling: 'canceling', canceled: 'canceled', failed: 'failed', expired: 'expired' });
const rhStates = Object.freeze({ QUEUED: 'queued', RUNNING: 'running', SUCCESS: 'succeeded', FAILED: 'failed' });
export function readComfyCloudTaskStatus(task, body) {
  task = bindComfyCloudTask(task, task?.taskId, task?.links);
  planComfyCloudOperation(task, 'query', task);
  const id = task.taskId, cloud = task.provider === 'comfy-cloud';
  if (!object(body)) fail('shape', '云端任务状态暂不可读，原任务仍保留', id);
  if ((cloud ? body.id : body.taskId) !== id) fail('identity', '云端返回了其他任务的状态，未应用', id);
  const states = cloud ? cloudStates : rhStates;
  if (typeof body.status !== 'string' || !Object.hasOwn(states, body.status)) fail('status', '云端任务状态暂不识别，请核查原任务', id);
  if (cloud) {
    let refreshed;
    try { refreshed = bindComfyCloudTask(task, id, body.urls); }
    catch (_) { fail('links', '云端原任务查询地址无法确认，未切换目标', id); }
    if (refreshed.links.self !== task.links.self || refreshed.links.cancel !== task.links.cancel) fail('links', '云端原任务查询地址已变化，未切换目标', id);
  } else if (typeof body.errorCode !== 'string' || (body.status !== 'FAILED' && body.errorCode !== '')) {
    fail('status', '云端任务状态与错误信息不一致，请核查原任务', id);
  }
  const status = states[body.status];
  // Succeeded means platform execution ended, not that outputs were verified or archived.
  return Object.freeze({ task, status, terminal: ['succeeded', 'canceled', 'failed', 'expired'].includes(status) });
}
