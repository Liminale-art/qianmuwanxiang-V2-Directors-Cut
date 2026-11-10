// 千幕 · 模型接口兼容层：地址、鉴权、ST 代理请求体、错误文字与模型目录的唯一标准。
// 忆幕 · 伴读 · 分镜共用。本文件不 import 任何模块、不自行发起网络请求；
// 忆幕持逐字节副本 yimu/model-compat.mjs（守卫：tests/model-compat-sync.test.mjs）。

const SUFFIX = /\/(?:chat\/completions|completions|models|embeddings|rerank(?:ing)?)$/i;
const AUTH_TEXT = /\b(?:401|403)\b|unauthori[sz]ed|forbidden|invalid[ _-]?(?:api[ _-]?)?(?:key|token)|incorrect api key|authentication/i;
const object = value => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const failure = (code, message) => Object.assign(new Error(message), { code });

// 地址规则：
// 1. 去首尾空白与结尾斜杠；拒绝账号密码、查询参数、片段。
// 2. 以 # 结尾＝原样使用：去掉 #，不剥后缀、不补 /v1（兜底特殊网关）。
// 3. 剥一个已知接口后缀（/chat/completions /completions /models /embeddings /rerank）。
// 4. 只剩裸域名时补 /v1；已有路径（/api/v3、/api/paas/v4、/v1beta/openai…）一律保留。
export function resolveApiRoot(input) {
  const raw = String(input ?? '').trim();
  if (!raw) throw failure('MODEL_URL_MISSING', '请填写 API 地址');
  const verbatim = raw.endsWith('#');
  let url;
  try { url = new URL(verbatim ? raw.slice(0, -1) : raw); } catch (_) { throw failure('MODEL_URL_INVALID', 'API 地址格式无效'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw failure('MODEL_URL_UNSAFE', 'API 地址须为 HTTP(S)，且不含账号密码、查询参数或片段');
  }
  let path = url.pathname.replace(/\/+$/, '');
  if (!verbatim) {
    path = path.replace(SUFFIX, '').replace(/\/+$/, '');
    if (!path) path = '/v1';
  }
  return url.origin + path;
}

export const chatEndpoint = root => `${root}/chat/completions`;
export const modelsEndpoint = root => `${root}/models`;

// 鉴权候选：先标准 Bearer，401/403 时只再试一次裸 Key（鉴权失败发生在生成之前，不计费）。
// 无 Key 时显式给空值，防止 ST 代理带出它当前生效的 Key。
export function authCandidates(key) {
  const value = String(key ?? '').trim();
  if (/[\r\n\0]/.test(value)) throw failure('MODEL_KEY_INVALID', 'Key 含有换行或控制字符');
  const bare = value.replace(/^Bearer\s+/i, '');
  return bare ? [`Bearer ${bare}`, bare] : [''];
}

export function authRejected(value) {
  const status = Number(value?.status) || 0;
  if (status === 401 || status === 403) return true;
  return AUTH_TEXT.test(String(value?.message ?? ''));
}

// send(authorization) 返回 Response 或抛出带 status/message 的错误；仅在鉴权被拒时换裸 Key 重发一次。
// 注意：ST 代理非流式把上游 401 包成 200 + {error:{message:'Unauthorized'}}，调用方应把它抛成错误交此处判断。
export async function sendWithAuthFallback(key, send, { rejected = response => response?.status === 401 || response?.status === 403 } = {}) {
  const [primary, fallback] = authCandidates(key);
  let result;
  try { result = await send(primary); }
  catch (error) {
    if (fallback === undefined || error?.name === 'AbortError' || !authRejected(error)) throw error;
    return send(fallback);
  }
  if (fallback !== undefined && rejected(result)) {
    try { await result.body?.cancel?.(); } catch (_) {}
    return send(fallback);
  }
  return result;
}

// OpenAI 兼容生成体：可选字段只在有效时发送。
export function chatPayload({ model, messages, temperature, maxTokens = 0, stream = false, responseFormat = null } = {}) {
  const body = { model: String(model ?? '').trim(), messages, stream: Boolean(stream) };
  if (temperature !== undefined && temperature !== null && Number.isFinite(Number(temperature))) body.temperature = Number(temperature);
  if (Number(maxTokens) > 0) body.max_tokens = Math.trunc(Number(maxTokens));
  if (object(responseFormat)) body.response_format = responseFormat;
  return body;
}

export const probePayload = model => ({ model: String(model ?? '').trim(), messages: [{ role: 'user', content: '连接测试' }],
  temperature: 0, max_tokens: 1, stream: false });

// ST 后端 custom 渠道请求体。路由字段放在最后，业务字段不能覆盖它们。
// 头部统一用 JSON（ST 以 YAML 解析，JSON 是其子集），避免 Key 中的特殊字符被 YAML 误读。
export function stProxyBody(root, authorization, payload = {}) {
  return { ...payload, chat_completion_source: 'custom', custom_url: root, reverse_proxy: '', proxy_password: '',
    custom_include_headers: JSON.stringify({ Authorization: authorization || '' }), custom_include_body: '', custom_exclude_body: '' };
}

// ST 代理对上游失败常回 HTTP 200：/status 回 {error:true}，非流式 /generate 回 {error:{message}}。
// 必须读响应体判断，不能只看 response.ok。
export function proxyPayloadError(json) {
  if (!object(json) || !json.error) return '';
  const error = json.error;
  if (typeof error === 'string') return error;
  if (error === true) return String(json.message || '上游接口未通过检查');
  return String(error.message || error.error || json.message || '上游模型请求失败');
}

export function describeHttpFailure(status) {
  const code = Number(status) || 0;
  if (code === 401 || code === 403) return `鉴权失败（HTTP ${code}），请核对 Key 与权限`;
  if (code === 404) return '接口不存在（HTTP 404），请核对地址与模型名';
  if (code === 429) return '请求被限流或额度不足（HTTP 429），请稍后再试';
  if (code === 400) return '请求被拒绝（HTTP 400），请核对模型名、参数或 Key';
  if (code >= 500) return `上游服务异常（HTTP ${code}），请稍后再试或换用其他节点`;
  return `连接请求失败（HTTP ${code}）`;
}

export function redactSecrets(message, secrets = []) {
  let out = String(message ?? '');
  for (const secret of secrets) {
    const value = String(secret ?? '').trim().replace(/^Bearer\s+/i, '');
    if (value.length >= 4) out = out.split(value).join('[已隐藏]');
  }
  return out.replace(/Bearer\s+\S+/gi, 'Bearer [已隐藏]').replace(/\bsk-[A-Za-z0-9_-]{8,}/g, '[已隐藏]');
}

// 兼容 {data:[]} / {models:[]} / 顶层数组 / 以模型名为键的对象；元素可为字符串或 {id}/{name}。
// 带 error 的代理回执一律视为空目录，不把 {error:true,data:{data:[]}} 误读成名为 data 的模型。
export function parseModelList(data) {
  if (object(data) && data.error) return [];
  const out = [];
  const take = rows => { for (const row of rows) { const id = typeof row === 'string' ? row : row?.id ?? row?.name; if (typeof id === 'string') out.push(id); } };
  if (Array.isArray(data)) take(data);
  for (const key of ['data', 'models']) {
    const value = data?.[key];
    if (Array.isArray(value)) take(value);
    else if (object(value)) out.push(...Object.keys(value));
  }
  return [...new Set(out.map(id => id.trim()).filter(id => id && id.length <= 2048))].sort((a, b) => a.localeCompare(b));
}

// 连接测试：先查模型目录；目录不可用且已选模型时，补一次 1 token 生成探测。取消/超时不补发。
export async function probeConnection({ listModels, probe, model = '', retryable = error => error?.name !== 'AbortError' && error?.code !== 'MODEL_TIMEOUT' } = {}) {
  let listError;
  try { return { ok: true, scope: 'model-list', models: await listModels() }; }
  catch (error) { listError = error; }
  if (!String(model ?? '').trim() || typeof probe !== 'function' || !retryable(listError)) throw listError;
  await probe();
  return { ok: true, scope: 'chat-probe', models: [] };
}
