// Authenticated HTTP access to the metadata-only v2 batch ledger. Nothing in
// these routes retains prompts, images or credentials, or starts generation.
import { Buffer } from 'node:buffer';
import { imageServiceAccount } from './qianmu-image-service-access.js';
import { createStoryboardServerBatchV2Store } from './qianmu-storyboard-server-batch-v2-store.js';

const BASE = '/image/storyboard/batches/v2';
const MAX_BODY_BYTES = 72 * 1024;
const WINDOW_MS = 60_000;
const MAX_ACCOUNTS = 512;
const MAX_IN_FLIGHT = 16;
const MAX_ACCOUNT_IN_FLIGHT = 4;
const MAX_WRITES_PER_WINDOW = 30;
const MAX_READS_PER_WINDOW = 120;
const routeErrorBrand = new WeakSet();
const responses = Object.freeze({
  storyboard_server_batch_contract: [400, '批次元数据无效，未创建任务'],
  storyboard_server_batch_conflict: [409, '批次记录冲突，请核对原批次'],
  storyboard_server_batch_not_found: [404, '原批次不存在'],
  storyboard_server_batch_revision: [409, '原批次已变化，请重新核对'],
  storyboard_server_batch_account_changed: [401, 'ST 账户已变化，请重新核对'],
  storyboard_server_batch_identity: [400, '批次身份无效'],
  storyboard_server_batch_v2_storage_root: [503, 'ST 数据目录不可用'],
  storyboard_server_batch_v2_storage_unavailable: [503, '批次记录暂不可用'],
  storyboard_server_batch_v2_storage_closed: [503, '批次记录已暂停'],
  storyboard_server_batch_v2_storage_clock: [503, '服务端时间无效'],
  storyboard_server_batch_v2_storage_busy: [503, '批次记录正忙，请稍后重试'],
  storyboard_server_batch_v2_storage_full: [507, '批次记录已达安全容量'],
  storyboard_server_batch_v2_storage_cursor: [409, '批次目录已变化，请重新打开'],
  storyboard_server_batch_v2_storage_changed: [409, '批次记录已变化，请重新核对'],
  storyboard_server_batch_v2_storage_temporary: [409, '批次记录存在未决写入'],
  storyboard_server_batch_v2_storage_path: [409, '批次目录异常，请核查'],
  storyboard_server_batch_v2_storage_record: [409, '批次记录异常，请核查'],
  storyboard_server_batch_v2_storage_corrupt: [409, '批次记录损坏，请核查'],
  storyboard_server_batch_v2_storage_identity: [409, '批次记录身份异常，请核查'],
  storyboard_server_batch_v2_storage_duplicate: [409, '批次记录重复，请核查'],
});

function routeError(code, message, status) {
  const error = Object.assign(new Error(message), { code: `storyboard_batch_http_${code}`, status });
  routeErrorBrand.add(error);
  return error;
}

function exactBody(value, allowed, required = allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw routeError('body', '批次请求格式无效', 400);
  }
  const names = Reflect.ownKeys(value);
  if (names.some(name => typeof name !== 'string' || !allowed.includes(name))
    || required.some(name => !names.includes(name))
    || names.some(name => !Object.hasOwn(Object.getOwnPropertyDescriptor(value, name) || {}, 'value'))) {
    throw routeError('body', '批次请求字段无效', 400);
  }
  return value;
}

function checkedHeaders(request) {
  const headers = request?.headers || {};
  const contentType = headers['content-type'];
  if (typeof contentType !== 'string' || !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(contentType)) {
    throw routeError('content_type', '仅接受 JSON 批次请求', 415);
  }
  const length = headers['content-length'];
  if (length !== undefined && (typeof length !== 'string' || !/^\d{1,7}$/.test(length)
    || Number(length) > MAX_BODY_BYTES)) {
    throw routeError('size', '批次元数据超过安全容量', 413);
  }
  const site = headers['sec-fetch-site'];
  if (site !== undefined && !['none', 'same-origin'].includes(site)) {
    throw routeError('origin', '批次请求来源无效', 403);
  }
  const origin = headers.origin;
  if (origin !== undefined) {
    const host = headers.host;
    let parsed;
    try { parsed = new URL(origin); } catch (_) { throw routeError('origin', '批次请求来源无效', 403); }
    // ST owns cookie authentication and its CSRF middleware. This additional
    // check rejects an explicit foreign Origin without trusting proxy-added
    // forwarded headers (which vary across local and VPS deployments).
    if (typeof origin !== 'string' || !/^https?:$/.test(parsed.protocol) || origin !== parsed.origin
      || typeof host !== 'string' || !host || parsed.host.toLowerCase() !== host.toLowerCase()) {
      throw routeError('origin', '批次请求来源无效', 403);
    }
  }
}

function checkedBodyBytes(body) {
  let serialized;
  try { serialized = JSON.stringify(body); }
  catch (_) { throw routeError('body', '批次请求格式无效', 400); }
  if (typeof serialized !== 'string') throw routeError('body', '批次请求格式无效', 400);
  if (Buffer.byteLength(serialized) > MAX_BODY_BYTES) {
    throw routeError('size', '批次元数据超过安全容量', 413);
  }
}

function errorPayload(error) {
  const unavailable = () => ({ status: 503, body: { ok: false, code: 'storyboard_batch_unavailable',
    message: '批次记录暂不可用', submissionState: 'not_submitted' } });
  let code, errorStatus;
  try {
    code = typeof error?.code === 'string' ? error.code : '';
    errorStatus = error?.status;
  } catch (_) { return unavailable(); }
  if (routeErrorBrand.has(error) && Number.isInteger(errorStatus) && errorStatus >= 400 && errorStatus <= 599) {
    return { status: errorStatus, body: { ok: false, code, message: error.message,
      submissionState: 'not_submitted' } };
  }
  if (code === 'image_service_authentication_required') {
    return { status: 401, body: { ok: false, code: 'storyboard_batch_authentication_required',
      message: '请先登录 ST 账户', submissionState: 'not_submitted' } };
  }
  const known = Object.hasOwn(responses, code) ? responses[code] : null;
  if (known) {
    const status = code === 'storyboard_server_batch_contract' && errorStatus === 413 ? 413
      : code === 'storyboard_server_batch_revision' && errorStatus === 400 ? 400 : known[0];
    return { status, body: { ok: false, code, message: known[1], submissionState: 'not_submitted' } };
  }
  return unavailable();
}

export function installStoryboardServerBatchV2Routes(router, { dataRoot, register,
  serviceOptions = {}, enableWrites = false } = {}) {
  let service, inFlight = 0;
  const accounts = new Map();
  function lease(namespace, writing) {
    const now = Date.now();
    for (const [key, value] of accounts) {
      if (now - value.windowStarted >= WINDOW_MS && value.inFlight === 0) accounts.delete(key);
    }
    let state = accounts.get(namespace);
    if (!state) {
      if (accounts.size >= MAX_ACCOUNTS) throw routeError('busy', '批次请求正忙，请稍后重试', 503);
      state = { windowStarted: now, reads: 0, writes: 0, inFlight: 0 };
      accounts.set(namespace, state);
    }
    if (now - state.windowStarted >= WINDOW_MS) {
      state.windowStarted = now; state.reads = 0; state.writes = 0;
    }
    if (inFlight >= MAX_IN_FLIGHT || state.inFlight >= MAX_ACCOUNT_IN_FLIGHT) {
      throw routeError('busy', '批次请求正忙，请稍后重试', 503);
    }
    const key = writing ? 'writes' : 'reads';
    if (state[key] >= (writing ? MAX_WRITES_PER_WINDOW : MAX_READS_PER_WINDOW)) {
      throw routeError('rate', '批次请求过于频繁，请稍后重试', 429);
    }
    state[key]++; state.inFlight++; inFlight++;
    return () => { state.inFlight--; inFlight--; };
  }
  function forAccount() {
    if (!service) {
      service = createStoryboardServerBatchV2Store({ ...serviceOptions, dataRoot: dataRoot() });
      register?.(service);
    }
    return service;
  }
  const actions = Object.freeze({
    prepare: { write: true,
      parse: body => exactBody(body, ['version', 'batchId', 'originBatch', 'source',
        'requestedMode', 'planDigest', 'routeDigest', 'shots']),
      run: (store, req, input) => store.prepare(req, input) },
    query: { write: false, parse: body => exactBody(body, ['batchId']).batchId,
      run: (store, req, batchId) => store.query(req, batchId) },
    list: { write: false, parse: body => exactBody(body, ['cursor', 'limit'], []),
      run: (store, req, options) => store.listOwned(req, options) },
    stop: { write: true, parse: body => exactBody(body, ['batchId', 'expectedRevision']),
      run: (store, req, input) => {
      return store.stop(req, input.batchId, input.expectedRevision);
    } },
  });
  for (const [action, config] of Object.entries(actions)) {
    // Production installs only read routes. In-process rate limits are not a
    // durable disk quota; both writes wait for the next capacity gate.
    if (config.write && enableWrites !== true) continue;
    router.post(`${BASE}/${action}`, async (req, res) => {
      res.set('Cache-Control', 'no-store');
      res.set('X-Content-Type-Options', 'nosniff');
      let release;
      try {
        const account = imageServiceAccount(req);
        checkedHeaders(req);
        checkedBodyBytes(req.body);
        release = lease(account.namespace, config.write);
        const input = config.parse(req.body);
        const result = await config.run(forAccount(), req, input);
        if (!res.destroyed && !res.writableEnded) {
          return res.json({ ok: true, schemaVersion: 1,
            ...(action === 'list' ? { page: result } : { batch: result }) });
        }
      } catch (error) {
        const { status, body } = errorPayload(error);
        if (!res.destroyed && !res.writableEnded) return res.status(status).json(body);
      } finally { release?.(); }
      return undefined;
    });
  }
}
