// Migration labels, not credentials or proof of authenticity. A complete server clone retains these labels.
export const SOURCE_IDENTITY_VERSION = 1;
export const SOURCE_IDENTITY_SCHEMA = 'qianmu.source.identity.v1';
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const keys = (value, fields) => object(value) && Object.keys(value).length === fields.length && Object.keys(value).every(key => fields.includes(key));
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
const account = value => typeof value === 'string' && /^st-user:[a-f0-9]{64}$/.test(value);
export const sourceIdentityError = (code, message, status = 409) => Object.assign(new Error(message), { code: `source_identity_${code}`, status, identityWriteState: 'not_started' });
const fail = message => { throw sourceIdentityError('contract', message, 400); };

export function sourceIdentityRecord(value, kind) {
  if (!['instance', 'account'].includes(kind) || !keys(value, ['schema', 'kind', 'id']) || value.schema !== SOURCE_IDENTITY_SCHEMA || value.kind !== kind || !uuid(value.id)) fail('来源标识文件损坏或版本不兼容，请保留原文件核对');
  return { schema: SOURCE_IDENTITY_SCHEMA, kind, id: value.id };
}
export function sourceIdentityRequest(value) {
  if (!keys(value, ['version', 'expectedAccount', 'confirmed']) || value.version !== SOURCE_IDENTITY_VERSION || !account(value.expectedAccount) || value.confirmed !== true) fail('请确认初始化当前 ST 的来源标识');
  return { version: SOURCE_IDENTITY_VERSION, expectedAccount: value.expectedAccount, confirmed: true };
}
export function sourceIdentityResponse(value) {
  if (!keys(value, ['ok', 'version', 'expectedAccount', 'state', 'instanceId', 'accountId', 'proof', 'automaticRebinding']) || value.ok !== true || value.version !== SOURCE_IDENTITY_VERSION
    || !account(value.expectedAccount) || !(value.instanceId === null || uuid(value.instanceId)) || !(value.accountId === null || uuid(value.accountId))
    || value.state !== (value.instanceId && value.accountId ? 'ready' : 'uninitialized') || value.proof !== 'installation-labels' || value.automaticRebinding !== false) fail('来源标识返回格式不兼容，不能用于迁移核对');
  return { ...value };
}
export async function sourceIdentityForNamespace(value, namespace) {
  const source = sourceIdentityResponse(value);
  if (source.state !== 'ready' || typeof namespace !== 'string' || !namespace.startsWith('st-user:')) fail('备份来源标识尚未完整初始化');
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(namespace.slice(8))));
  const expected = `st-user:${Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')}`;
  if (source.expectedAccount !== expected) fail('备份来源标识与账户不一致');
  return source;
}
export function sourceIdentityLabelsMatch(source, target) {
  const a = sourceIdentityResponse(source), b = sourceIdentityResponse(target);
  return a.state === 'ready' && b.state === 'ready' && ['expectedAccount', 'instanceId', 'accountId'].every(key => a[key] === b[key]);
}
export function sourceIdentityErrorPayload(error) {
  const known = typeof error?.code === 'string' && /^source_identity_[a-z_]+$/.test(error.code);
  return { status: known && Number.isInteger(error.status) && error.status >= 400 && error.status <= 599 ? error.status : 503,
    body: { ok: false, version: SOURCE_IDENTITY_VERSION, code: known ? error.code : 'source_identity_storage',
      message: known ? error.message : '来源标识未确认，请保留现有文件并核对增强服务', identityWriteState: error?.identityWriteState === 'unconfirmed' ? 'unconfirmed' : 'not_started' } };
}
