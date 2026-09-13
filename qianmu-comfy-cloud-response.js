// Bounded response reading and identity/status projection; no submission, billing or retry.
import { bindComfyCloudTask, requireComfyCloudTaskId, planComfyCloudOperation } from './qianmu-comfy-cloud-protocol.js';
import { parseBoundedJson } from './qianmu-json-input.js';
import { comfyStillMime } from './qianmu-comfy-results.js';
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const fail = (code, message, taskId = '') => {
  throw Object.assign(new Error(message), { code: `comfy_cloud_response_${code}`, retryable: false,
    submissionState: taskId ? 'accepted' : 'unknown', ...(taskId ? { upstreamId: taskId } : {}) });
};

// Called only after response headers arrive. Header/connect deadlines belong to the
// operation runner; this deadline covers a body that never finishes or stops mid-stream.
async function readCloudResponse(response, { task, maxBytes, timeoutMs, signal }, { hardLimit, checkHeaders, decode }) {
  const original = task ? bindComfyCloudTask(task, task.taskId, task.links) : null;
  const ownErrors = new WeakSet();
  const error = (code, message) => {
    const result = Object.assign(new Error(message), { code: `comfy_cloud_response_${code}`, retryable: false,
      submissionState: original ? 'accepted' : 'unknown', ...(original ? { upstreamId: original.taskId } : {}) });
    ownErrors.add(result); return result;
  };
  let reader, timer, onAbort, interruption;
  const deadline = performance.now() + timeoutMs;
  const cancelBody = () => {
    // Never wait indefinitely for a broken stream's cancellation callback.
    try { Promise.resolve(reader ? reader.cancel() : response?.body?.cancel?.()).catch(() => {}); } catch (_) { /* Best effort cleanup. */ }
  };
  try {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > hardLimit
      || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) throw error('limits', '云端响应读取限制无效');
    if (signal?.aborted) throw error('cancelled', '已停止读取云端响应，原任务请到平台核查');
    if (!response?.ok) throw Object.assign(error('http', '云端请求未正常返回，请核查原任务'),
      { httpStatus: Number.isInteger(response?.status) ? response.status : 0 });
    checkHeaders(response, error);
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
      if (signal?.aborted) throw error('cancelled', '已停止读取云端响应，原任务请到平台核查');
      if (performance.now() >= deadline) throw error('timeout', '读取云端响应超时，请核查原任务，未重新提交');
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
    const result = decode(joined, error);
    if (signal?.aborted) throw error('cancelled', '已停止读取云端响应，原任务请到平台核查');
    if (performance.now() >= deadline) throw error('timeout', '读取云端响应超时，请核查原任务，未重新提交');
    return result;
  } catch (cause) {
    if (ownErrors.has(cause)) throw cause;
    throw error('stream', '读取云端响应失败，请核查原任务');
  } finally {
    clearTimeout(timer); if (onAbort) signal?.removeEventListener('abort', onAbort);
    cancelBody(); if (reader) { try { reader.releaseLock(); } catch (_) { /* Already released or broken. */ } }
  }
}

const responseMime = response => String(response.headers?.get?.('content-type') || '').split(';', 1)[0].trim().toLowerCase();
export async function readComfyCloudJsonResponse(response, { task, maxBytes = 1024 * 1024, timeoutMs = 15000, signal } = {}) {
  return readCloudResponse(response, { task, maxBytes, timeoutMs, signal }, {
    hardLimit: 2 * 1024 * 1024,
    checkHeaders: (response, error) => {
      if (!/^application\/(?:json|[a-z0-9!#$&^_.+-]+\+json)$/.test(responseMime(response))) throw error('type', '云端未返回JSON数据，原任务状态尚未确认');
    },
    decode: (bytes, error) => {
      let body;
      try { body = parseBoundedJson(new TextDecoder('utf-8', { fatal: true }).decode(bytes), { maxBytes, maxDepth: 32, maxNodes: 100000, label: '云端响应' }); }
      catch (_) { throw error('json', '云端JSON数据无效或超限，请核查原任务'); }
      if (!object(body)) throw error('shape', '云端未返回有效任务数据');
      return body;
    },
  });
}

// The descriptor must come from the original job/asset. This checks byte count
// and still-container type, not decoded pixels, CRC or the platform's BLAKE3 hash.
// Network deadline and the final owner/source grant remain the caller's duty.
export async function readComfyCloudImageResponse(response, { task, mime, sizeBytes, timeoutMs = 60000, signal } = {}) {
  return readCloudResponse(response, { task, maxBytes: sizeBytes, timeoutMs, signal }, {
    hardLimit: 48 * 1024 * 1024,
    checkHeaders: (response, error) => {
      if (!task || !['image/png', 'image/jpeg', 'image/webp'].includes(mime)) throw error('limits', '缺少原任务图片约定');
      const declared = response.headers?.get?.('content-length'), encoding = response.headers?.get?.('content-encoding');
      if (response.status !== 200 || ![mime, 'application/octet-stream'].includes(responseMime(response)) || encoding && encoding.toLowerCase() !== 'identity') throw error('type', '云端未返回约定的完整原图');
      if (declared != null && Number(declared) !== sizeBytes) throw error('image_size', '图片长度与原任务记录不一致，未入库');
    },
    decode: (bytes, error) => {
      if (bytes.byteLength !== sizeBytes) throw error('image_size', '图片未完整接收或与原记录不一致，未入库');
      let actual;
      try { actual = comfyStillMime(bytes); }
      catch (cause) { throw error('image_invalid', cause?.code === 'comfy_animated_output' ? '云端返回了动画，未加入静帧' : '原图格式无效或容器不完整，未入库'); }
      if (actual !== mime) throw error('image_type', '图片实际格式与原任务记录不一致，未入库');
      return { bytes, mime: actual };
    },
  });
}

// RH gives a type and URL, not a trusted byte count. Bound actual bytes by the
// remaining whole-job budget, and honor Content-Length when the CDN supplies it.
export async function readRunningHubImageResponse(response, { task, mime, maxBytes, timeoutMs = 60000, signal } = {}) {
  return readCloudResponse(response, { task, maxBytes, timeoutMs, signal }, {
    hardLimit: 48 * 1024 * 1024,
    checkHeaders: (response, error) => {
      const encoding = response.headers?.get?.('content-encoding');
      if (task?.provider !== 'runninghub' || !['image/png', 'image/jpeg', 'image/webp'].includes(mime)
        || response.status !== 200 || ![mime, 'application/octet-stream'].includes(responseMime(response))
        || encoding && encoding.toLowerCase() !== 'identity') throw error('type', '平台未返回约定的完整原图');
    },
    decode: (bytes, error) => {
      const declared = response.headers?.get?.('content-length');
      if (!bytes.byteLength || declared != null && Number(declared) !== bytes.byteLength) throw error('image_size', '原图未完整接收，未入库');
      let actual; try { actual = comfyStillMime(bytes); }
      catch (_) { throw error('image_invalid', '原图格式无效、容器不完整或返回了动画，未加入静帧'); }
      if (actual !== mime) throw error('image_type', '图片实际格式与原任务记录不一致，未入库');
      return { bytes, mime: actual };
    },
  });
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
function runningHubUsage(value) {
  if (!object(value)) return null;
  // Preserve platform decimal strings; missing/malformed never becomes zero,
  // and task-level costs must not be multiplied by the number of output files.
  const fields=['consumeCoins','consumeMoney','thirdPartyConsumeMoney','taskCostTime'];
  const entries=fields.map(key=>[key,typeof value[key]==='string'&&/^(?:0|[1-9]\d{0,15})(?:\.\d{1,12})?$/.test(value[key])?value[key]:null]);
  return entries.some(([,value])=>value!==null)?Object.freeze(Object.fromEntries(entries)):null;
}
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
  const usage=cloud?null:runningHubUsage(body.usage);
  return Object.freeze({ task, status, terminal: ['succeeded', 'canceled', 'failed', 'expired'].includes(status),...(usage?{usage}:{}) });
}
