// One authenticated, pinned server egress boundary for the native Comfy API.
// This is per-operation authorization, not a persistent administrator allowlist.
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { ImageGatewayError, validateGatewayBaseUrl } from './qianmu-image-gateway.js';
import { imageServiceAccount, imageServiceAccountStillMatches } from './qianmu-image-service-access.js';
import { planComfyCloudOperation, bindComfyCloudTask } from './qianmu-comfy-cloud-protocol.js';
import { planComfyCloudAssetMetadata } from './qianmu-comfy-cloud-asset.js';

// Only the explicit cloud factory can add this capability; native callers stay native.
const CLOUD_PLAN = Symbol('verified cloud operation');

const fail = (code, message, status = 400) => Object.assign(new ImageGatewayError(status, `comfy_transport_${code}`, message), { submissionState: 'not_submitted' });
const oneSegment = value => {
  try { const decoded = decodeURIComponent(value); return decoded.length > 0 && decoded.length <= 240 && !/[\u0000-\u001f\u007f/\\?#%]/.test(decoded) && !['.', '..'].includes(decoded); }
  catch (_) { return false; }
};
const safeRoot = raw => {
  if (typeof raw !== 'string' || raw.length > 2048 || /[\u0000-\u0020\u007f\\]/.test(raw)) throw fail('address', 'Comfy API 根地址无效');
  let base; try { base = new URL(raw); } catch (_) { throw fail('address', 'Comfy API 根地址无效'); }
  if (!['https:', 'http:'].includes(base.protocol) || base.username || base.password || base.search || base.hash) throw fail('address', 'Comfy API 根地址不能包含账户、查询参数或锚点');
  // Reject ambiguous proxy paths before URL normalization can erase dot segments.
  const rawPath = raw.replace(/^[a-z]+:\/\/[^/]+/i, '').replace(/\/+$/, '');
  if (rawPath && (!rawPath.startsWith('/') || rawPath.slice(1).split('/').some(segment => !oneSegment(segment)))) throw fail('address', '请填写无跳转、无路径歧义的 Comfy API 根地址');
  return base;
};

export function normalizeComfyTarget(raw) {
  const base = safeRoot(raw);
  base.pathname = base.pathname.replace(/\/+$/, '') || '/';
  return base.toString().replace(/\/$/, '');
}

function addressList(addresses) {
  if (!Array.isArray(addresses) || !addresses.length || addresses.length > 32) throw fail('address', 'Comfy 地址解析结果无效');
  return addresses.map(item => {
    let address = String(item?.address || ''); const family = isIP(address);
    if (!family || (item.family != null && item.family !== family)) throw fail('address', 'Comfy 地址解析结果无效');
    if (family === 6) address = new URL(`http://[${address}]`).hostname.slice(1, -1);
    const ip = address.toLowerCase();
    // Also exclude transition/translated ranges, even under private opt-in.
    if ((family === 4 && (/^(?:0\.|169\.254\.)/.test(ip) || Number(ip.split('.')[0]) >= 224))
      || (family === 6 && ((ip !== '::1' && !/^(?:[23][0-9a-f]{3}:|f[cd][0-9a-f]{2}:)/.test(ip))
        || /^2002:|^2001:(?::|0:|2:|db8:)/.test(ip)))) throw fail('unsafe_target', '此地址不属于允许访问的 Comfy 主机');
    return Object.freeze({ address, family });
  });
}

function allowedOperation(base, url, method, operation) {
  const prefix = `${base.pathname.replace(/\/+$/, '')}/`;
  if (url.origin !== base.origin || url.username || url.password || url.hash || !url.pathname.startsWith(prefix)) return false;
  const route = url.pathname.slice(prefix.length);
  if (operation === 'check') return method === 'GET' && route === 'system_stats' && !url.search;
  if (operation === 'models') return method === 'GET' && route === 'object_info' && !url.search;
  if (operation === 'readiness') return method === 'GET' && route.startsWith('object_info/') && oneSegment(route.slice(12)) && !url.search;
  if (operation === 'recover' && method === 'GET' && route === 'queue' && !url.search) return true;
  if (!['generate', 'recover'].includes(operation)) return false;
  if (operation === 'recover' && method !== 'GET') return false;
  if (method === 'POST') return ['prompt', 'upload/image'].includes(route) && !url.search;
  if (method !== 'GET') return false;
  if (route.startsWith('history/')) return oneSegment(route.slice(8)) && !url.search;
  if (route !== 'view') return false;
  const params = url.searchParams;
  if ([...params.keys()].some(key => !['filename', 'subfolder', 'type'].includes(key) || params.getAll(key).length !== 1)) return false;
  if (!oneSegment(params.get('filename') || '') || params.get('type') !== 'output') return false;
  const folder = params.get('subfolder');
  return !folder || folder.split('/').every(oneSegment);
}

export function pinnedComfyFetch(base, addresses, { operation, requestImpl, assertCurrent = () => {}, beforeRequest, signal, [CLOUD_PLAN]: cloudPlan } = {}) {
  base = new URL(base); // Do not retain a caller-mutable URL or DNS answer array.
  const host = base.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const list = addressList(addresses);
  if (isIP(host) && (list.length !== 1 || list[0].address !== host)) throw fail('address', 'Comfy 地址与解析结果不一致');
  return async (rawUrl, init = {}) => {
    assertCurrent(); signal?.throwIfAborted();
    const url = new URL(rawUrl), method = String(init.method || 'GET').toUpperCase();
    const allowed = cloudPlan ? base.origin === cloudPlan.origin && url.href === cloudPlan.url && method === cloudPlan.method
      : allowedOperation(base, url, method, operation);
    if (!allowed) throw fail('target_changed', 'Comfy 请求目标或操作已变化');
    await beforeRequest?.(); assertCurrent(); signal?.throwIfAborted();
    const headers = new Headers(init.headers);
    const headerNames = ['authorization', 'content-type', 'accept'];
    if (cloudPlan?.protocol === 'comfy-cloud-v2' && cloudPlan.createsJob) headerNames.push('idempotency-key');
    if ([...headers.keys()].some(key => !headerNames.includes(key))) throw fail('headers', 'Comfy 请求包含不允许的转发头');
    if (headers.has('idempotency-key') && !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(headers.get('idempotency-key'))) throw fail('headers', '云端幂等编号无效');
    if (cloudPlan?.provider === 'runninghub' && cloudPlan.taskId) {
      let body; try { if (typeof init.body === 'string' && init.body.length <= 4096) body = JSON.parse(init.body); } catch (_) { /* Denied below. */ }
      const keys = cloudPlan.operation === 'cancel' ? ['taskId', 'apiKey'] : ['taskId'];
      if (!body || Array.isArray(body) || body.taskId !== cloudPlan.taskId || Object.keys(body).some(key => !keys.includes(key))
        || (Object.hasOwn(body, 'apiKey') && (typeof body.apiKey !== 'string' || body.apiKey.length > 2048))) throw fail('body', '云端请求与原任务编号不匹配');
    }
    if (cloudPlan?.provider === 'comfy-cloud' && cloudPlan.operation === 'cancel' && init.body != null) throw fail('body', '云端取消操作不接受额外参数');
    if (method === 'GET' && init.body != null) throw fail('body', 'Comfy 只读请求不能携带正文');
    // Web Request supplies the correct multipart boundary without buffering the image.
    const combined = signal && init.signal ? AbortSignal.any([signal, init.signal]) : signal || init.signal;
    const packet = new Request(url, { method, headers, body: init.body, signal: combined });
    combined?.throwIfAborted();
    return new Promise((resolve, reject) => {
      let outgoing;
      try {
        outgoing = (requestImpl || (base.protocol === 'https:' ? httpsRequest : httpRequest))(url, {
          method, signal: combined, headers: Object.fromEntries(packet.headers), maxHeaderSize: 16384, agent: false,
          lookup(hostname, options, callback) {
            if (hostname.toLowerCase().replace(/^\[|\]$/g, '') !== host) { callback(fail('target_changed', 'Comfy 主机已变化')); return; }
            if (options?.all) callback(null, list.map(item => ({ ...item })));
            else { const item = list.find(value => !options?.family || value.family === options.family); if (item) callback(null, item.address, item.family); else callback(fail('address', 'Comfy 地址族不匹配')); }
          },
        }, incoming => {
          try {
            // Cloud submit responses are internal acceptance evidence, not UI
            // delivery. Drain/persist the original id even after login changes;
            // the submission coordinator must verify again before delivery.
            // Query/cancel and native Comfy retain their response account gate.
            if (!cloudPlan?.createsJob) assertCurrent();
            if (incoming.statusCode >= 300 && incoming.statusCode < 400) throw fail('redirect', 'Comfy 接口发生跳转，未跟随', 502);
            const responseHeaders = new Headers();
            for (const [key, value] of Object.entries(incoming.headers)) if (value !== undefined) responseHeaders.set(key, Array.isArray(value) ? value.join(', ') : String(value));
            const empty = [204, 205, 304].includes(incoming.statusCode); if (empty) incoming.resume();
            // Pull only when the bounded consumer asks. Eager adapter prefetch
            // can race an immediate HTTP/MIME rejection and enqueue after cancel.
            resolve(new Response(empty ? null : Readable.toWeb(incoming, { strategy: { highWaterMark: 0 } }), { status: incoming.statusCode, headers: responseHeaders }));
          } catch (error) { incoming.destroy(); reject(error); }
        });
        outgoing.once('error', reject);
        if (packet.body) pipeline(Readable.fromWeb(packet.body), outgoing).catch(reject);
        else outgoing.end();
      } catch (error) { outgoing?.destroy?.(); packet.body?.cancel().catch(() => {}); reject(error); }
    });
  };
}

export async function createComfyServerTransport(req, input, { operation, resolveHost = lookup, requestImpl, signal, dnsTimeoutMs = 5000, authorizeTarget, [CLOUD_PLAN]: cloudPlan } = {}) {
  let account;
  try { account = imageServiceAccount(req); } catch (_) { throw fail('authentication_required', '请先登录 ST 账户再连接 Comfy', 401); }
  const allowPrivateNetwork = input?.allowPrivateNetwork === true;
  if (allowPrivateNetwork && !account.admin) throw fail('private_admin', 'ST 私网连接需要管理员明确允许；也可使用浏览器直连', 403);
  const assertCurrent = () => {
    let current; try { current = imageServiceAccount(req); } catch (_) { /* Expired account is denied below. */ }
    if (!current || current.namespace !== account.namespace || (allowPrivateNetwork && !current.admin)) throw fail('account_changed', 'ST 账户或私网权限已变化，请重新连接', 401);
    signal?.throwIfAborted();
  };
  const rawBase = safeRoot(input?.baseUrl);
  if (cloudPlan && (allowPrivateNetwork || rawBase.origin !== cloudPlan.origin || typeof authorizeTarget !== 'function')) throw fail('cloud_authorization', '云端连接尚未获得目标授权');
  if (!allowPrivateNetwork && rawBase.protocol !== 'https:') throw fail('address', '远程 Comfy 地址必须使用 HTTPS');
  assertCurrent();
  const verifyTarget = await authorizeTarget?.(req, { baseUrl: rawBase.toString(), allowPrivateNetwork });
  if (cloudPlan && typeof verifyTarget !== 'function') throw fail('cloud_authorization', '云端连接缺少持续授权校验');
  assertCurrent();
  const verify = async () => { assertCurrent(); await verifyTarget?.(); assertCurrent(); };
  let addresses, timer;
  const resolveOnce = async (host, settings) => {
    if (addresses) return addresses;
    const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(fail('dns_timeout', 'Comfy 地址解析超时')), Math.max(1, Math.min(5000, dnsTimeoutMs))); });
    let abort;
    const cancelled = new Promise((_, reject) => { abort = () => reject(signal.reason); signal?.addEventListener('abort', abort, { once: true }); });
    try {
      const result = await Promise.race([resolveHost(host, settings), timeout, cancelled]);
      addresses = addressList(Array.isArray(result) ? result : [result]);
      assertCurrent(); return addresses;
    } catch (error) {
      if (signal?.aborted || error instanceof ImageGatewayError) throw error;
      throw fail('dns', '无法解析 Comfy 地址，请核对域名与 ST 主机网络');
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
  };
  // Resolve once ourselves so validation cannot swallow an authentication/DNS error.
  await resolveOnce(rawBase.hostname.replace(/^\[|\]$/g, ''), { all: true, verbatim: true });
  const base = await validateGatewayBaseUrl(rawBase.toString(), { allowPrivateNetwork, resolveHost: async () => addresses });
  await verify();
  return { base, assertCurrent, verify, fetchImpl: pinnedComfyFetch(base, addresses, { operation, requestImpl, assertCurrent, beforeRequest: verify, signal, [CLOUD_PLAN]: cloudPlan }) };
}

// Internal adapter boundary only; no public cloud route/capability is enabled yet.
export async function createComfyCloudServerTransport(req, { binding, operation, task }, options = {}) {
  const plan = planComfyCloudOperation(binding, operation, task);
  return createCloudPlannedTransport(req, plan, options);
}

// Exact metadata GET only. The coordinator supplies an asset grant backed by the
// original job output; neither a browser asset id nor a plan is that permission.
export async function createComfyCloudAssetTransport(req, { task: rawTask, assetId }, options = {}) {
  const task = bindComfyCloudTask(rawTask, rawTask?.taskId, rawTask?.links), plan = planComfyCloudAssetMetadata(task, assetId);
  try {
    let account;
    try { account = imageServiceAccount(req); } catch (_) { throw fail('authentication_required', '请先登录ST账户再读取原图片信息', 401); }
    const check = () => {
      options.signal?.throwIfAborted();
      if (!imageServiceAccountStillMatches(req, account)) throw fail('account_changed', 'ST账户已变化，未读取原图片信息', 401);
    };
    if (typeof options.authorizeAsset !== 'function' || typeof options.authorizeTarget !== 'function') throw fail('asset_authorization', '原图片或云连接尚未获得读取授权', 403);
    check(); const verifyAsset = await options.authorizeAsset(req, Object.freeze({ task, assetId: plan.assetId }), account); check();
    if (typeof verifyAsset !== 'function') throw fail('asset_authorization', '原图片缺少持续归属校验', 403);
    const verify = async () => { check(); await verifyAsset(); check(); };
    await verify();
    return await createCloudPlannedTransport(req, plan, { ...options, authorizeTarget: async (...args) => {
      await verify(); const verifyTarget = await options.authorizeTarget(...args); await verify();
      if (typeof verifyTarget !== 'function') throw fail('cloud_authorization', '云连接缺少持续授权校验');
      return async () => { await verify(); await verifyTarget(); await verify(); };
    } });
  } catch (cause) {
    const error = cause instanceof ImageGatewayError ? cause : fail('asset_unavailable', '原图片信息暂不可读，请核查原任务', 502);
    error.submissionState = 'accepted'; error.upstreamId = task.taskId; throw error;
  }
}

async function createCloudPlannedTransport(req, plan, options) {
  const requestImpl = options.requestImpl || httpsRequest;
  let sent = false;
  const annotate = cause => {
    const error = cause instanceof ImageGatewayError ? cause : fail('cloud_unavailable', '云端请求暂不可用，请核查原任务', 502);
    error.submissionState = plan.taskId ? 'accepted' : sent ? 'unknown' : 'not_submitted';
    if (plan.taskId) error.upstreamId = plan.taskId;
    return error;
  };
  try {
    const transport = await createComfyServerTransport(req, { baseUrl: plan.origin }, { ...options, operation: 'cloud', [CLOUD_PLAN]: plan,
      requestImpl: (...args) => {
        // Recheck at dispatch too: concurrent calls may both pass the outer check
        // before their awaited authorization checks finish.
        if (plan.createsJob && sent) throw fail('cloud_replay', '此云端提交已发出，请核查原任务，未重复提交');
        sent = true; return requestImpl(...args);
      },
    });
    const fetchImpl = async (url, init) => {
      try {
        if (plan.createsJob && sent) throw fail('cloud_replay', '此云端提交已发出，请核查原任务，未重复提交');
        return await transport.fetchImpl(url, init);
      } catch (error) { throw annotate(error); }
    };
    return { ...transport, plan, fetchImpl,
      assertCurrent: () => { try { transport.assertCurrent(); } catch (error) { throw annotate(error); } },
      verify: async () => { try { await transport.verify(); } catch (error) { throw annotate(error); } },
    };
  } catch (error) { throw annotate(error); }
}
