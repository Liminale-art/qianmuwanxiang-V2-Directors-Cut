import { comfyReferencePath } from './qianmu-comfy-reference-contract.js';

export const IMAGE_RESTORE_VERSION = 1;
// Gallery originals support 24 MiB. Role/Comfy reference selections retain their own 16 MiB limits.
export const IMAGE_RESTORE_MAX_BYTES = 24 * 1024 * 1024;
export const imageRestoreError = (code, message, status = 409) => Object.assign(new Error(message), { code: `image_restore_${code}`, message, status, submissionState: 'not_submitted' });
const fail = (code, message) => { throw imageRestoreError(code, message, 400); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
export const imageRestoreAccount = value => typeof value === 'string' && /^st-user:[a-f0-9]{64}$/.test(value);

// Portable image locations only. Never accept a server disk path or let a receipt address private service directories.
export function imageRestoreReceipt(value) {
  if (!object(value) || Object.keys(value).some(key => !['url', 'sha256', 'mime', 'bytes'].includes(key)) || typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.sha256)
    || !Number.isSafeInteger(value.bytes) || value.bytes < 1 || value.bytes > IMAGE_RESTORE_MAX_BYTES || !['image/png', 'image/jpeg', 'image/webp'].includes(value.mime)) fail('receipt', '原图恢复收据无效或单张超过 24 MiB');
  let url; try { url = comfyReferencePath(value.url); } catch (_) { fail('path', '原图恢复仅限当前 ST 的图片目录'); }
  if (url !== value.url) fail('path', '原图恢复路径须为完整的 /user/images/ 路径');
  const components = url.slice('/user/images/'.length).split('/').map(part => decodeURIComponent(part));
  if (components.length > 8 || components.some(part => !part || part.startsWith('.') || /[<>:"|?*\\\u0000-\u001f\u007f]/.test(part) || /[. ]$/.test(part)
    || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part) || new TextEncoder().encode(part).byteLength > 255)) fail('path', '原图路径不兼容安全恢复，请保留原文件核对');
  const extension = components.at(-1).split('.').at(-1).toLowerCase();
  if (!(value.mime === 'image/jpeg' ? ['jpg', 'jpeg'] : [value.mime.split('/')[1]]).includes(extension)) fail('format', '原图扩展名与格式不符');
  return { url, sha256: value.sha256, mime: value.mime, bytes: value.bytes };
}
export function imageRestoreRequest(value, { write = false } = {}) {
  const fields = ['version', 'expectedAccount', 'receipt', ...(write ? ['confirmed', 'data'] : [])];
  if (!object(value) || Object.keys(value).some(key => !fields.includes(key)) || value.version !== IMAGE_RESTORE_VERSION || !imageRestoreAccount(value.expectedAccount)) fail('request', '原图恢复请求格式或账户校验无效');
  const receipt = imageRestoreReceipt(value.receipt);
  if (write && (value.confirmed !== true || typeof value.data !== 'string' || value.data.length !== 4 * Math.ceil(receipt.bytes / 3) || !/^[A-Za-z0-9+/]*={0,2}$/.test(value.data))) fail('consent', '请确认恢复并提供完整原图');
  return { version: IMAGE_RESTORE_VERSION, expectedAccount: value.expectedAccount, receipt, ...(write ? { confirmed: true, data: value.data } : {}) };
}
export function imageRestoreErrorPayload(error) {
  const known = typeof error?.code === 'string' && error.code.startsWith('image_restore_');
  return { status: known && Number.isInteger(error.status) && error.status >= 400 && error.status <= 599 ? error.status : 503, body: { ok: false, version: 1, code: known ? error.code : 'image_restore_storage',
    message: known ? error.message : '原图恢复未确认，请保留备份并核对文件状态', submissionState: 'not_submitted' } };
}
