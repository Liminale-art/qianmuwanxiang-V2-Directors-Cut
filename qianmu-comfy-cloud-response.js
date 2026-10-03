// Bounded response reading and identity/status projection; no submission, billing or retry.
import { bindComfyCloudTask, requireComfyCloudTaskId, planComfyCloudOperation } from './qianmu-comfy-cloud-protocol.js';
import { parseBoundedJson } from './qianmu-json-input.js';
import { readRunningHubUsage } from './qianmu-runninghub-usage.js';
import { comfyStillMime } from './qianmu-comfy-results.js';
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const fail = (code, message, taskId = '', providerCode) => {
  throw Object.assign(new Error(message), { code: `comfy_cloud_response_${code}`, retryable: false,
    submissionState: taskId ? 'accepted' : 'unknown', ...(taskId ? { upstreamId: taskId } : {}),
    ...(Number.isSafeInteger(providerCode) && Math.abs(providerCode) <= 2147483647 ? {providerCode} : {}) });
};

// Closed, metadata-only error projection. Never retain a message, stack, URL,
// response body, workflow or credential; diagnostics grant no retry authority.
const diagnosticStages = {authorization:'连接授权',preflight:'任务预查',readiness:'节点检查',references:'参考图准备',reservation:'任务预留',submission:'提交请求',response:'响应校验',record:'受理记录',delivery:'状态交付',query:'任务查询',outputs:'输出核对',file:'原图读取',save:'原图暂存',readback:'暂存回读'};
const diagnosticReasons = {
  http: ['平台 HTTP 响应异常，请核查原任务', ['comfy_cloud_response_http']],
  response_format: ['平台响应格式无法确认，请核查原任务', ['comfy_cloud_response_type','comfy_cloud_response_json','comfy_cloud_response_shape','comfy_cloud_response_size','comfy_cloud_response_limits']],
  response_read: ['平台响应未完整读取，请核查原任务', ['comfy_cloud_response_stream']],
  acceptance: ['平台受理响应未获确认，请核对平台记录及错误码', ['comfy_cloud_response_acceptance','comfy_cloud_response_identity','comfy_cloud_response_links']],
  timeout: ['等待超时，请核查原任务', ['comfy_cloud_response_timeout','comfy_cloud_submit_timeout','comfy_cloud_query_timeout','runninghub_download_timeout','comfy_cloud_digest_timeout','comfy_transport_dns_timeout','ETIMEDOUT']],
  cancelled: ['等待已停止，请核查原任务', ['comfy_cloud_response_cancelled','comfy_cloud_submit_cancelled','comfy_cloud_query_cancelled','runninghub_download_cancelled','comfy_cloud_receive_cancelled','comfy_cloud_digest_cancelled']],
  account: ['账户校验变化，请回原账户核查', ['comfy_cloud_submit_account','comfy_cloud_submit_identity','comfy_cloud_query_account','runninghub_download_account','comfy_transport_account_changed','comfy_transport_authentication_required','image_service_cloud_account_changed']],
  authorization: ['连接授权未完成，请核对原连接', ['comfy_cloud_submit_authorization','comfy_cloud_query_authorization','comfy_cloud_query_key','runninghub_download_authorization','comfy_cloud_receive_authorization','comfy_transport_cloud_authorization','comfy_cloud_access_account','comfy_cloud_access_target','comfy_cloud_access_policy']],
  connection: ['连接或地址校验未完成，请核对原连接', ['comfy_transport_cloud_unavailable','comfy_transport_dns','comfy_transport_address','comfy_transport_unsafe_target','comfy_transport_target_changed','comfy_transport_redirect','ENOTFOUND','EAI_AGAIN','ECONNRESET','ECONNREFUSED']],
  ledger: ['原任务记录校验未完成，请核查原记录', ['image_service_cloud_storage','image_service_cloud_occupied','image_service_cloud_full','image_service_cloud_conflict','image_service_cloud_duplicate','image_service_cloud_ticket','image_service_cloud_ticket_changed','image_service_cloud_acceptance_unconfirmed']],
  references: ['参考图准备未完成，请核对原素材', ['comfy_cloud_submit_references']],
  readiness: ['节点或模型检查未通过，请手动核对', ['comfy_cloud_submit_readiness']],
  task_status: ['平台任务状态格式不一致，请核查原任务', ['comfy_cloud_response_status','runninghub_results_state']],
  task_identity: ['平台结果与原任务不匹配，请核查原记录', ['runninghub_results_identity','image_service_cloud_query_identity','image_service_cloud_query_changed']],
  output_evidence: ['平台输出节点信息不完整，请核查原图', ['runninghub_results_evidence']],
  output_match: ['平台两份输出信息不一致，请核查原图', ['runninghub_results_match','runninghub_results_duplicate']],
  output_type: ['平台输出地址或图片类型不符合约定，请核查原图', ['runninghub_results_url','runninghub_results_type']],
  output_count: ['平台图片数量与约定不一致，请核查原图', ['runninghub_results_count']],
  image_integrity: ['原图格式或完整性未通过校验，请保留原任务', ['comfy_cloud_response_image_size','comfy_cloud_response_image_invalid','comfy_cloud_response_image_type','comfy_cloud_digest_bytes','comfy_cloud_digest_expected','comfy_cloud_digest_limits','comfy_cloud_digest_mismatch','comfy_cloud_digest_unavailable']],
  storage: ['原图暂存或回读未完成，请保留原任务', ['image_service_result_storage','image_service_result_path','image_service_result_corrupt','image_service_result_changed','image_service_result_full','image_service_result_missing','image_service_result_image','image_service_storage_unavailable','image_service_storage_busy','image_service_cloud_delivery_storage','image_service_cloud_delivery_missing','image_service_cloud_delivery_mismatch','image_service_cloud_delivery_conflict','comfy_cloud_receive_readback']],
  unclassified: ['未能确认具体原因，请核查原任务', []],
};
const diagnosticCodes = new Map(Object.entries(diagnosticReasons).flatMap(([reason,[,codes]])=>codes.map(code=>[code,reason])));
const ownData = (value,key) => {
  try { return value && Object.getOwnPropertyDescriptor(value,key)?.value; } catch (_) { return undefined; }
};
export function normalizeComfyCloudFailureDiagnostic(value) {
  const stage=ownData(value,'stage');if(typeof stage!=='string'||!Object.hasOwn(diagnosticStages,stage))return null;
  const selected=ownData(value,'reason');
  const reason=typeof selected==='string'&&Object.hasOwn(diagnosticReasons,selected)?selected:diagnosticCodes.get(ownData(value,'causeCode'))||'unclassified';
  const result={stage,reason},httpStatus=ownData(value,'httpStatus'),providerCode=ownData(value,'providerCode');
  if(Number.isInteger(httpStatus)&&httpStatus>=100&&httpStatus<=599)result.httpStatus=httpStatus;
  if(Number.isSafeInteger(providerCode)&&Math.abs(providerCode)<=2147483647)result.providerCode=providerCode;
  for(const key of ['attempted','dispatched','hasKnownTaskId','recordCleanupFailed']){
    const flag=ownData(value,key);if(typeof flag==='boolean')result[key]=flag;
  }
  return Object.freeze(result);
}
// Read failures keep the earliest closed diagnosis through wrapper errors.
// Accessors, inherited fields and arbitrary exception text are never inspected.
export function comfyCloudReadFailureDiagnostic(cause, {stage,httpStatus,providerCode} = {}) {
  const child=normalizeComfyCloudFailureDiagnostic(ownData(cause,'cloudDiagnostic'));
  if(child)return child;
  const causeCode=ownData(cause,'code');
  return normalizeComfyCloudFailureDiagnostic({stage,causeCode,
    ...(stage==='query'&&causeCode==='comfy_cloud_response_identity'?{reason:'task_identity'}:{}),
    httpStatus:httpStatus??ownData(cause,'httpStatus'),providerCode:providerCode??ownData(cause,'providerCode'),hasKnownTaskId:true});
}
export function describeComfyCloudFailureDiagnostic(value) {
  const detail=normalizeComfyCloudFailureDiagnostic(value);if(!detail)return '';
  const parts=[`${diagnosticStages[detail.stage]}：${diagnosticReasons[detail.reason][0]}`];
  if(detail.httpStatus!==undefined)parts.push(`HTTP ${detail.httpStatus}`);
  if(detail.providerCode!==undefined)parts.push(`平台码 ${detail.providerCode}`);
  // Internal flags are not a second user-facing status. "dispatched" means
  // entering the pinned transport, not proof the provider received any bytes.
  return `〔${parts.join('；')}〕`;
}

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
  return readCloudJson(response, { task, maxBytes, timeoutMs, signal }, { hardLimit: 2 * 1024 * 1024, maxNodes: 100000 });
}
// A whole catalog is larger than a task reply. Keep a separate bounded reader;
// do not relax the existing task/receipt response limits.
export async function readComfyCloudDefinitionsResponse(response, { maxBytes = 16 * 1024 * 1024, timeoutMs = 15000, signal } = {}) {
  return readCloudJson(response, { maxBytes, timeoutMs, signal }, { hardLimit: 16 * 1024 * 1024, maxNodes: 500000 });
}
async function readCloudJson(response, { task, maxBytes, timeoutMs, signal }, { hardLimit, maxNodes }) {
  return readCloudResponse(response, { task, maxBytes, timeoutMs, signal }, {
    hardLimit,
    checkHeaders: (response, error) => {
      if (!/^application\/(?:json|[a-z0-9!#$&^_.+-]+\+json)$/.test(responseMime(response))) throw error('type', '云端未返回JSON数据，原任务状态尚未确认');
    },
    decode: (bytes, error) => {
      let body;
      try { body = parseBoundedJson(new TextDecoder('utf-8', { fatal: true }).decode(bytes), { maxBytes, maxDepth: 32, maxNodes, label: '云端响应' }); }
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
  if (!cloud && (body.code !== 0 || !object(body.data))) fail('acceptance', '云端未确认提交结果，请核查原任务', '', body.code);
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
  const usage=cloud?null:readRunningHubUsage(body.usage);
  return Object.freeze({ task, status, terminal: ['succeeded', 'canceled', 'failed', 'expired'].includes(status),...(usage?{usage}:{}) });
}
