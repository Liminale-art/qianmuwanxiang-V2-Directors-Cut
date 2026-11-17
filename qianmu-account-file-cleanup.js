// 账户文件旧版本的盘点与清理（S5）的浏览器端。只访问本站固定的配套后端路由；后端没装或版本旧时返回 null，界面上就不出现这一项。
import { proseAssistantAccountForNamespace } from './qianmu-prose-assistant-source.js';

const BASE = '/api/plugins/qianmu-tts/storage/account-files';
const count = value => value && Number.isSafeInteger(value.count) && value.count >= 0 && Number.isSafeInteger(value.bytes) && value.bytes >= 0;

async function post(path, body, { headers, fetchImpl = globalThis.fetch, timeoutMs = 30000 } = {}) {
  const provided = new Headers(await headers?.()), requestHeaders = { Accept: 'application/json', 'Content-Type': 'application/json' };
  if (provided.has('x-csrf-token')) requestHeaders['X-CSRF-Token'] = provided.get('x-csrf-token');
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(path, { method: 'POST', credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: controller.signal, headers: requestHeaders, body: JSON.stringify(body) });
    if (!/^application\/json\b/i.test(response.headers?.get?.('content-type') || '')) return { missing: true };
    const value = await response.json().catch(() => null);
    if (!response.ok || value?.ok !== true) return { error: String(value?.error || '账户文件暂不可盘点') };
    return { value };
  } finally { clearTimeout(timer); }
}

// 返回 { cleanable:{count,bytes}, families:[…], total } ；后端不可用时返回 null（不当成零占用，也不报错打扰）。
export async function inspectAccountFiles({ resolveNamespace, ...transport } = {}) {
  try {
    const expectedAccount = await proseAssistantAccountForNamespace(await resolveNamespace());
    const result = await post(BASE, { version: 1, expectedAccount }, transport), value = result.value;
    if (!value || value.expectedAccount !== expectedAccount || !count(value.cleanable) || !count(value.total) || !Array.isArray(value.families)) return null;
    return { expectedAccount, cleanable: value.cleanable, total: value.total, other: value.other, families: value.families.filter(row => row && typeof row.family === 'string' && count(row.retained)) };
  } catch (_) { return null; }
}

// 清理白名单内各类的旧版本。返回 { removed:{count,bytes}, kept, failed }；失败时抛出可直接展示的中文原因。
export async function cleanAccountFiles(inventory, transport = {}) {
  const families = (inventory?.families || []).filter(row => row.cleanable === true && row.retained.count > 0).map(row => row.family);
  if (!families.length) return { removed: { count: 0, bytes: 0 }, kept: { count: 0, bytes: 0 }, failed: { count: 0 } };
  const result = await post(`${BASE}/clean`, { version: 1, expectedAccount: inventory.expectedAccount, families }, transport);
  if (!result.value || !count(result.value.removed)) throw new Error(result.error || '配套后端暂不支持清理账户文件，请更新后端。');
  return result.value;
}
