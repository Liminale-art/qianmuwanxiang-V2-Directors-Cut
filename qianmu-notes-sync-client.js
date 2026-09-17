// Same-origin ST transport only. No provider URL, token, or note geometry is accepted.
import { NOTES_SYNC_LIMITS, notesSyncWriteRequest, notesSyncListResponse, notesSyncWriteResponse, notesSyncConflictResponse } from './qianmu-notes-sync-contract.js';
import { notesLocalNamespace } from './qianmu-notes-sync-store.js';

const BASE = '/api/plugins/qianmu-tts/notes';
const failure = (code, message, writeState = 'not_started') => Object.assign(new Error(message), { code: `notes_sync_${code}`, writeState });
const digest = async value => 'st-user:' + Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))), byte => byte.toString(16).padStart(2, '0')).join('');

export function createNotesSyncClient({ namespace, headers = () => ({}), guard = async () => {}, fetchImpl = globalThis.fetch, timeoutMs = 15000 } = {}) {
  notesLocalNamespace(namespace);
  if (!Number.isFinite(timeoutMs) || typeof fetchImpl !== 'function') throw failure('unavailable', '便笺同步环境尚未就绪');
  const requests = new Set(); let closed = false, expected;
  const origin = globalThis.location?.origin;
  if (origin !== undefined && !/^https?:\/\//.test(origin)) throw failure('unavailable', '便笺同步需要在当前 ST 站点中使用');
  async function call(input, { signal } = {}) {
    const write = input !== null, path = BASE + (write ? '/write' : '');
    const controller = new AbortController(); let started = false, reader, response, rejectCancellation;
    const state = () => write && started ? 'unconfirmed' : 'not_started';
    const cancellation = new Promise((_, reject) => { rejectCancellation = reject; });
    const cancel = message => { controller.abort(); rejectCancellation(failure('cancelled', message, state())); };
    const abort = () => cancel('便笺同步已取消，本机内容保留');
    const check = async () => {
      if (closed || controller.signal.aborted) throw failure('cancelled', '便笺同步会话已变化，本机内容保留', state());
      if (await guard() === false) throw failure('account', '便笺账户已变化，未采用返回内容', state());
      if (closed || controller.signal.aborted) throw failure('cancelled', '便笺同步会话已变化，本机内容保留', state());
    };
    requests.add(abort); signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => cancel('便笺同步超时，本机内容保留；下次会核对同一次保存'), Math.max(100, Math.min(30000, timeoutMs)));
    try {
      if (signal?.aborted) abort();
      return await Promise.race([(async () => {
        await check();
        if (!globalThis.crypto?.subtle?.digest) throw failure('unavailable', '跨端同步需要通过 HTTPS 或本机 localhost 打开 ST；便笺仍保存在当前浏览器');
        const expectedAccount = await (expected ||= digest(namespace.slice(8)));
        const payload = write ? notesSyncWriteRequest({ ...input, version: 1, expectedAccount }) : null;
        const supplied = new Headers(await headers()), requestHeaders = { Accept: 'application/json' };
        if (supplied.has('x-csrf-token')) requestHeaders['X-CSRF-Token'] = supplied.get('x-csrf-token');
        if (write) requestHeaders['Content-Type'] = 'application/json';
        await check(); started = true;
        response = await fetchImpl(origin ? new URL(path, origin).href : path, {
          method: write ? 'POST' : 'GET', ...(write ? { body: JSON.stringify(payload) } : {}), headers: requestHeaders,
          credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: controller.signal,
        });
        await check();
        if (response.redirected || response.type === 'opaqueredirect' || response.status >= 300 && response.status < 400) throw failure('response', '便笺服务发生跳转，未继续同步', state());
        if (response.url) {
          const actual = new URL(response.url);
          if (actual.pathname !== path || actual.search || actual.hash || origin && actual.origin !== origin) throw failure('response', '便笺返回不是当前 ST 同源服务，未采用', state());
        }
        if ([404, 405, 501].includes(response.status)) throw failure('unavailable', '请安装或更新当前 ST 的千幕后端并重启 ST；便笺已保存在本机', state());
        if ([401, 403].includes(response.status)) throw failure('account', '便笺同步登录或校验已失效，请重新登录或刷新 ST；本机内容保留', state());
        const limit = write ? 512 * 1024 : NOTES_SYNC_LIMITS.bytes;
        if (!/^application\/json\b/i.test(response.headers?.get?.('content-type') || '') || Number(response.headers.get('content-length')) > limit) throw failure('response', '便笺服务返回不兼容或过大，未截断或覆盖本机内容', state());
        reader = response.body?.getReader?.(); if (!reader) throw failure('response', '便笺返回不完整，本机内容保留', state());
        const decoder = new TextDecoder('utf-8', { fatal: true }); let text = '', bytes = 0;
        while (true) {
          const part = await reader.read(); await check(); if (part.done) break;
          bytes += part.value.byteLength; if (bytes > limit) throw failure('response', '便笺返回超过安全读取上限，未采用部分目录', state());
          text += decoder.decode(part.value, { stream: true });
        }
        text += decoder.decode(); const value = JSON.parse(text);
        let parsed;
        if (write && response.status === 409 && value?.code === 'notes_sync_conflict') parsed = notesSyncConflictResponse(value);
        else if (!response.ok || value?.ok !== true) {
          const known = value?.version === 1 && value.ok === false && /^notes_sync_[a-z_]+$/.test(value.code || '') && typeof value.message === 'string' && value.message.length <= 240;
          throw failure('service', known ? value.message : '便笺服务暂不可用，本机内容保留', state());
        } else parsed = write ? notesSyncWriteResponse(value) : notesSyncListResponse(value);
        if (parsed.expectedAccount !== expectedAccount || write && parsed.note && parsed.note.id !== payload.id) throw failure('account', '便笺返回账户或编号不一致，未采用', state());
        await check(); return parsed;
      })(), cancellation]);
    } catch (error) {
      if (/^notes_sync_/.test(error?.code || '')) { error.writeState = state(); throw error; }
      throw failure('connection', '便笺连接中断或返回损坏，本机内容保留；保存结果将通过原操作编号核对', state());
    } finally {
      clearTimeout(timer); signal?.removeEventListener('abort', abort); requests.delete(abort); controller.abort();
      try { void (reader ? reader.cancel() : response?.body?.cancel?.())?.catch(() => {}); } catch (_) {}
      try { reader?.releaseLock(); } catch (_) {}
    }
  }
  return Object.freeze({ list: options => call(null, options), write: (input, options) => call(input, options), close() { closed = true; for (const abort of requests) abort(); requests.clear(); } });
}
