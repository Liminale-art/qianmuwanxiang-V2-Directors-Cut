import { sourceIdentityRequest, sourceIdentityResponse } from './qianmu-source-identity-contract.js';

const BASE = '/api/plugins/qianmu-tts/source-identity';
const fail = (message, identityWriteState = 'not_started') => Object.assign(new Error(message), { code: 'source_identity_client', identityWriteState, retryable: false });
const digest = async value => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))), byte => byte.toString(16).padStart(2, '0')).join('');

export function createSourceIdentityClient({ namespace, headers = () => ({}), fetchImpl = globalThis.fetch, guard = async () => {}, timeoutMs = 10000 } = {}) {
  if (typeof namespace !== 'string' || !/^st-user:.+/.test(namespace) || namespace.length > 512 || /[\u0000-\u001f\u007f]/.test(namespace)) throw fail('来源标识账户未确认');
  if (!Number.isFinite(timeoutMs)) throw fail('来源标识等待时间无效');
  const expected = digest(namespace.slice(8)).then(value => `st-user:${value}`);
  async function call(write, { confirmed = false, signal } = {}) {
    if (write && confirmed !== true) throw fail('请先确认初始化来源标识');
    const controller = new AbortController(); let started = false, timer, rejectCancellation;
    const state = () => write && started ? 'unconfirmed' : 'not_started';
    const cancellation = new Promise((_, reject) => { rejectCancellation = reject; });
    const abort = () => { controller.abort(); rejectCancellation(fail('来源标识操作已取消，请重新核对', state())); };
    signal?.addEventListener('abort', abort, { once: true });
    timer = setTimeout(() => { controller.abort(); rejectCancellation(fail('来源标识等待超时，请重新核对；不会自动初始化', state())); }, Math.max(100, Math.min(30000, timeoutMs)));
    try {
      if (signal?.aborted) abort();
      return await Promise.race([(async () => {
        await guard(); const expectedAccount = await expected; if (controller.signal.aborted) throw fail('来源标识操作已取消', state());
        const supplied = new Headers(await headers()), requestHeaders = { Accept: 'application/json' };
        if (supplied.has('x-csrf-token')) requestHeaders['X-CSRF-Token'] = supplied.get('x-csrf-token');
        const body = write ? JSON.stringify(sourceIdentityRequest({ version: 1, expectedAccount, confirmed: true })) : undefined;
        if (write) requestHeaders['Content-Type'] = 'application/json';
        await guard(); if (controller.signal.aborted) throw fail('来源标识操作已取消', state());
        started = true;
        const response = await fetchImpl(`${BASE}${write ? '/initialize' : ''}`, { method: write ? 'POST' : 'GET', ...(body ? { body } : {}), headers: requestHeaders,
          credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: controller.signal });
        if (!/^application\/json\b/i.test(response.headers?.get?.('content-type') || '') || Number(response.headers.get('content-length')) > 2048) throw fail('来源标识服务返回不兼容，请核对增强服务版本', state());
        const reader = response.body?.getReader?.(); if (!reader) throw fail('来源标识服务返回不完整', state());
        const cancelReader = () => { void reader.cancel().catch(() => {}); };
        controller.signal.addEventListener('abort', cancelReader, { once: true });
        let text = '', length = 0; const decoder = new TextDecoder('utf-8', { fatal: true });
        try {
          while (true) { if (controller.signal.aborted) throw fail('来源标识操作已取消', state()); const part = await reader.read(); if (part.done) break;
            length += part.value.byteLength; if (length > 2048) throw fail('来源标识返回过大，未继续读取', state()); text += decoder.decode(part.value, { stream: true }); }
          text += decoder.decode();
        } finally { controller.signal.removeEventListener('abort', cancelReader); cancelReader(); reader.releaseLock(); }
        let value; try { value = JSON.parse(text); } catch (_) { throw fail('来源标识服务返回内容损坏', state()); }
        if (!response.ok || value?.ok !== true) {
          const known = value?.version === 1 && value.ok === false && /^source_identity_[a-z_]+$/.test(value.code || '') && typeof value.message === 'string' && value.message.length <= 240;
          throw fail(known ? value.message : '来源标识未确认，请核对增强服务', state());
        }
        const parsed = sourceIdentityResponse(value);
        if (parsed.expectedAccount !== expectedAccount || write && parsed.state !== 'ready') throw fail('来源标识返回账户或初始化状态不一致', state());
        await guard(); if (controller.signal.aborted) throw fail('来源标识操作已取消', state());
        return parsed;
      })(), cancellation]);
    } catch (error) {
      if (error?.code === 'source_identity_client') throw error;
      throw fail('来源标识连接、内容或当前页面已变化，请保留备份重新核对', state());
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); controller.abort(); }
  }
  return Object.freeze({ inspect: options => call(false, options), initialize: options => call(true, options) });
}
