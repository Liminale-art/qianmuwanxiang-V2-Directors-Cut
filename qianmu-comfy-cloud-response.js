// Identity/status projection only: no output adoption, billing, credentials or automatic retry.
import { bindComfyCloudTask, requireComfyCloudTaskId, planComfyCloudOperation } from './qianmu-comfy-cloud-protocol.js';
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const fail = (code, message, taskId = '') => {
  throw Object.assign(new Error(message), { code: `comfy_cloud_response_${code}`, retryable: false,
    submissionState: taskId ? 'accepted' : 'unknown', ...(taskId ? { upstreamId: taskId } : {}) });
};

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
