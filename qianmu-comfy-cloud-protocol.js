// Cloud request plans only. No IO, credentials, workflow edits or automatic protocol fallback.
// Separate from the native Comfy gateway. Plans are not account/target authorization.
// Contracts: Comfy-Org/docs openapi-v2.yaml; RunningHub API 425749013/425767306/425749015.
export const COMFY_CLOUD_PROTOCOL_VERSION = 1;
export const comfyCloudAssetId = value => typeof value === 'string' && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(value) ? value.toLowerCase() : '';
const fail = (code, message) => { throw Object.assign(new Error(message), { code: `comfy_cloud_${code}`, retryable: false }); };
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const protocols = Object.freeze({
  'comfy-cloud-v2': 'comfy-cloud',
  'runninghub-workflow-v1': 'runninghub',
});
const routes = {
  'comfy-cloud-v2': {
    submit: ['POST', '/api/v2/jobs', 'submit'],
    query: ['GET', '/api/v2/jobs/', 'read'],
    cancel: ['POST', '/api/v2/jobs/', 'cancel'],
  },
  // Submission and cancellation use RH's workflow contract; its documented v2 query
  // is POST too, but must never count as a new job or authorize another generation.
  'runninghub-workflow-v1': {
    submit: ['POST', '/task/openapi/create', 'submit'],
    query: ['POST', '/openapi/v2/query', 'read'],
    outputs: ['POST', '/task/openapi/outputs', 'read'],
    cancel: ['POST', '/task/openapi/cancel', 'cancel'],
  },
};

export function bindComfyCloudProtocol(raw, protocol) {
  if (typeof protocol !== 'string' || !Object.hasOwn(protocols, protocol)) fail('protocol', '云端工作流协议未确认');
  if (typeof raw !== 'string' || raw.length > 2048 || !/^https:\/\/[^/?#]+(?:\/[^?#]*)?$/i.test(raw)
    || /[\u0000-\u0020\u007f\\]/.test(raw)) fail('address', '云端地址无效，请填写官方 API 地址');
  let url; try { url = new URL(raw); } catch (_) { fail('address', '云端地址无效，请填写官方 API 地址'); }
  if (url.username || url.password || url.port || url.search || url.hash) fail('address', '云端地址不能包含账户、参数或自定义端口');
  const host = url.hostname;
  const provider = host === 'cloud.comfy.org' || /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.run\.comfy\.app$/.test(host)
    ? 'comfy-cloud' : ['www.runninghub.cn', 'www.runninghub.ai'].includes(host) ? 'runninghub' : '';
  if (!provider || provider !== protocols[protocol]) fail('platform', '云端平台与所选协议不匹配，未切换连接');
  // Inspect the raw path: URL parsing alone would silently erase ../ segments.
  const path = raw.replace(/^https:\/\/[^/]+/i, '');
  const roots = provider === 'comfy-cloud' ? ['', '/', '/api/v2', '/api/v2/']
    : ['', '/', '/task/openapi', '/task/openapi/', '/openapi/v2', '/openapi/v2/'];
  if (!roots.includes(path)) fail('path', '请填写云端 API 根地址，不使用任务或控制台链接');
  return Object.freeze({ version: COMFY_CLOUD_PROTOCOL_VERSION, provider, protocol, origin: url.origin });
}

// Recognize only documented platform hosts; user-owned native endpoints keep
// their existing transport. A malformed known-cloud root must not fall back.
export function resolveStoryboardComfyCloud(connection) {
  const raw=connection?.baseUrl;if(typeof raw!=='string'||!raw)return null;
  let host;try{host=new URL(raw).hostname;}catch(_){return null;}
  const protocol=host==='cloud.comfy.org'||/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.run\.comfy\.app$/.test(host)
    ?'comfy-cloud-v2':['www.runninghub.cn','www.runninghub.ai'].includes(host)?'runninghub-workflow-v1':null;
  if(!protocol)return null;
  return bindComfyCloudProtocol(raw,protocol);
}

function checkedBinding(value) {
  if (!object(value) || value.version !== COMFY_CLOUD_PROTOCOL_VERSION) fail('binding', '云端连接记录版本无效');
  const canonical = bindComfyCloudProtocol(value.origin, value.protocol);
  if (canonical.origin !== value.origin || canonical.provider !== value.provider) fail('binding', '云端连接记录不一致');
  return canonical;
}

// Read-only account probes, separate from v2 job execution. Serverless has no
// documented standalone probe in the shared contract; never invent a job id.
export function planComfyCloudConnectionCheck(binding) {
  const current = checkedBinding(binding);
  if (current.provider === 'comfy-cloud' && current.origin !== 'https://cloud.comfy.org') return null;
  const runninghub = current.provider === 'runninghub';
  return Object.freeze({ ...current, operation: 'check', effect: 'read', createsJob: false,
    method: runninghub ? 'POST' : 'GET', url: `${current.origin}${runninghub ? '/uc/openapi/accountStatus' : '/api/queue'}`, redirect: 'error' });
}

// Public generation rollout boundary, shared by the page and HTTP entry point.
// Recovery retains all previously accepted platform/deployment identities.
export function requireComfyCloudImageSubmission(binding, { automatic = false } = {}) {
  const current = checkedBinding(binding);
  if (current.provider !== 'comfy-cloud') fail('submission_scope', '此平台的新任务收片尚未接通，未提交生成');
  if (current.origin !== 'https://cloud.comfy.org') fail('submission_scope', '部署专属工作流的输入绑定尚未接通，请先使用 Comfy Cloud 主站');
  if (automatic) fail('submission_scope', '云工作流暂仅支持手动确认生成，自动选流尚未开放');
  return current;
}

function checkedJobLinks(binding, taskId, links) {
  if (!object(links)) fail('links', '云端未返回原任务查询地址，请核查原任务');
  const paths = {};
  for (const name of ['self', 'cancel']) {
    const raw = links[name];
    if (typeof raw !== 'string' || raw.length > 2048 || /[\u0000-\u0020\u007f\\%?#]/.test(raw)
      || !(raw.startsWith('/') && !raw.startsWith('//') || raw.startsWith('https://'))) fail('links', '云端原任务地址无效');
    let url; try { url = new URL(raw, binding.origin); } catch (_) { fail('links', '云端原任务地址无效'); }
    const path = raw.startsWith('/') ? raw : raw.replace(/^https:\/\/[^/]+/, '');
    if (url.origin !== binding.origin || url.username || url.password || url.pathname !== path) fail('links', '云端原任务地址已改变');
    const suffix = `/api/v2/jobs/${taskId}${name === 'cancel' ? '/cancel' : ''}`;
    if (!path.endsWith(suffix)) fail('links', '云端地址与原任务编号不一致');
    const prefix = path.slice(0, -suffix.length);
    if (prefix && !/^\/deployment\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(prefix)) fail('links', '云端任务地址前缀暂不支持');
    paths[name] = `${binding.origin}${path}`;
  }
  if (paths.cancel !== `${paths.self}/cancel`) fail('links', '云端查询和取消地址不属于同一任务');
  return Object.freeze(paths);
}

export function requireComfyCloudTaskId(binding, taskId) {
  const current = checkedBinding(binding);
  const pattern = current.provider === 'runninghub' ? /^[0-9]{1,64}$/ : /^[a-zA-Z0-9_-]{1,240}$/;
  // Task ids are strings, especially RH's integers beyond Number's safe precision.
  if (typeof taskId !== 'string' || !pattern.test(taskId)) fail('task', '云端原任务编号无效');
  return taskId;
}

export function bindComfyCloudTask(binding, taskId, links) {
  const current = checkedBinding(binding);
  requireComfyCloudTaskId(current, taskId);
  const urls = current.provider === 'comfy-cloud' ? checkedJobLinks(current, taskId, links) : undefined;
  return Object.freeze({ ...current, taskId, ...(urls ? { links: urls } : {}) });
}

export function planComfyCloudOperation(binding, operation, task) {
  const current = checkedBinding(binding), allowed = routes[current.protocol];
  if (typeof operation !== 'string' || !Object.hasOwn(allowed, operation)) fail('operation', '此云端操作尚未支持');
  const [method, route, effect] = allowed[operation];
  let path = route, body, taskId;
  if (operation !== 'submit') {
    const original = bindComfyCloudTask(task, task?.taskId, task?.links);
    if (original.origin !== current.origin || original.protocol !== current.protocol || original.provider !== current.provider) {
      fail('task_binding', '请回原云端连接核查该任务，未切换平台');
    }
    taskId = original.taskId;
    // Follow verified response links, including serverless mount prefixes.
    if (current.provider === 'comfy-cloud') path = original.links[operation === 'cancel' ? 'cancel' : 'self'].slice(current.origin.length);
    else body = Object.freeze({ taskId });
  } else if (task !== undefined) fail('task_replay', '已有任务不能作为新的提交，请先核查原任务');
  return Object.freeze({ ...current, operation, effect, method, url: `${current.origin}${path}`,
    createsJob: effect === 'submit', ...(taskId ? { taskId } : {}), ...(body ? { body } : {}),
    // The transport must authorize this exact operation before adding credentials.
    redirect: 'error',
  });
}
