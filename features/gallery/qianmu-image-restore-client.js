import { imageRestoreRequest, imageRestoreReceipt, IMAGE_RESTORE_MAX_BYTES } from './qianmu-image-restore-contract.js';

const BASE = '/api/plugins/qianmu-tts/image/restore';
const fail = (message, imageWriteState = 'not_started') => Object.assign(new Error(message), {
  code: 'image_restore_client', imageWriteState, retryable: false, submissionState: 'not_submitted',
});
const digest = async value => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))), byte => byte.toString(16).padStart(2, '0')).join('');
const equalReceipt = (a, b) => ['url', 'sha256', 'mime', 'bytes'].every(key => a[key] === b[key]);

// The browser namespace contains the ST handle; only its digest is sent to the service.
// A failed write response is always unconfirmed, even if no GENERATION was submitted.
export function createImageRestoreClient({ namespace, headers = () => ({}), fetchImpl = globalThis.fetch, guard = async () => {}, timeoutMs = 60000 } = {}) {
  if (typeof namespace !== 'string' || !/^st-user:.+/.test(namespace) || namespace.length > 512 || /[\u0000-\u001f\u007f]/.test(namespace)) throw fail('原图恢复账户未确认');
  const account = digest(namespace.slice(8)).then(value => `st-user:${value}`);
  let maxBytes = 0;
  async function call(action, body, { write = false } = {}) {
    await guard(); const controller = new AbortController(); let timer, started = false;
    const state = () => write && started ? 'unconfirmed' : 'not_started';
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(fail('原图恢复等待超时，请核对原文件；不会自动重传', state())); }, Math.max(100, Math.min(120000, timeoutMs)));
    });
    try {
      return await Promise.race([(async () => {
        // Only ST's CSRF token is relevant. Never forward upstream credentials or arbitrary caller headers.
        const supplied = new Headers(headers()), requestHeaders = { Accept: 'application/json' };
        if (supplied.has('x-csrf-token')) requestHeaders['X-CSRF-Token'] = supplied.get('x-csrf-token');
        if (body) requestHeaders['Content-Type'] = 'application/json';
        const serialized = body ? JSON.stringify(body) : undefined;
        started = true;
        const response = await fetchImpl(`${BASE}/${action}`, { method: body ? 'POST' : 'GET', headers: requestHeaders,
          ...(body ? { body: serialized } : {}), credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: controller.signal });
        if (!/^application\/json\b/i.test(response.headers?.get?.('content-type') || '') || Number(response.headers.get('content-length')) > 16384) throw fail('原图恢复服务返回不兼容或过大，请核对增强服务版本', state());
        const reader = response.body?.getReader?.(); if (!reader) throw fail('原图恢复服务返回不完整', state());
        let text = '', count = 0; const decoder = new TextDecoder('utf-8', { fatal: true });
        try {
          while (true) {
            const part = await reader.read(); if (part.done) break;
            count += part.value.byteLength; if (count > 16384) throw fail('原图恢复服务返回过大，未继续读取', state());
            text += decoder.decode(part.value, { stream: true });
          }
          text += decoder.decode();
        } finally { void reader.cancel().catch(() => {}); reader.releaseLock(); }
        let value; try { value = JSON.parse(text); } catch (_) { throw fail('原图恢复服务返回内容损坏', state()); }
        if (value?.version !== 1) throw fail('原图恢复协议不兼容，请更新增强服务', state());
        if (!response.ok || value.ok !== true) {
          const known = value.ok === false && /^image_restore_[a-z_]+$/.test(value.code || '') && typeof value.message === 'string' && value.message.length <= 240;
          throw fail(known ? value.message : '原图恢复未确认，请保留备份核对', state());
        }
        if (value.expectedAccount !== await account) throw fail('原图恢复返回了另一账户，未接纳结果', state());
        await guard(); return value;
      })(), timeout]);
    } catch (error) {
      if (error?.code === 'image_restore_client') throw error;
      throw fail('原图恢复连接或页面状态已变化，请保留备份并核对原文件', state());
    } finally { clearTimeout(timer); controller.abort(); }
  }
  async function capabilities() {
    const value = await call('capabilities');
    const limit = value.maxGalleryImageBytes ?? value.maxImageBytes;
    if (value.originalPaths !== true || value.missingOnly !== true || value.automaticReplay !== false || !Number.isSafeInteger(value.maxImageBytes)
      || value.maxImageBytes < 16 * 1024 * 1024 || value.maxImageBytes > IMAGE_RESTORE_MAX_BYTES
      || !Number.isSafeInteger(limit) || limit < value.maxImageBytes || limit > IMAGE_RESTORE_MAX_BYTES) throw fail('增强服务尚未支持只补缺件的原图恢复，请先更新后端');
    maxBytes = limit; return value;
  }
  async function execute(receipt, data, confirmed, write) {
    // Capture immutable primitives before any await; never read a changed caller receipt after confirmation.
    const frozen = imageRestoreReceipt(receipt);
    if (write && confirmed !== true) throw fail('请先确认恢复原图');
    const body = imageRestoreRequest({ version: 1, expectedAccount: await account, receipt: frozen, ...(write ? { data, confirmed: true } : {}) }, { write });
    await guard(); if (!maxBytes) await capabilities(); await guard();
    if (frozen.bytes > maxBytes) throw fail('此原图超过当前增强服务的恢复上限，请更新后端；未上传或覆盖图片');
    const value = await call(write ? 'restore' : 'inspect', body, { write });
    let returned; try { returned = imageRestoreReceipt(value.receipt); } catch (_) { throw fail('原图恢复返回收据无效', write ? 'unconfirmed' : 'not_started'); }
    if (!equalReceipt(returned, frozen) || !(write ? ['created', 'reused'] : ['present', 'missing', 'conflict']).includes(value.state)) throw fail('原图恢复结果与所选文件不符', write ? 'unconfirmed' : 'not_started');
    return { receipt: returned, state: value.state };
  }
  return Object.freeze({ capabilities, inspect: receipt => execute(receipt, undefined, false, false),
    restore: (receipt, data, { confirmed = false } = {}) => execute(receipt, data, confirmed, true) });
}
