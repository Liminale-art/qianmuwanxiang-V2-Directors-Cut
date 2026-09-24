// Size observations of owned ST files, not a conversation export or authority to
// delete anything. No account handle, path, chat key or file name is returned.
export const ASSISTANT_STORAGE_LIMITS = Object.freeze({ scan: 500000, files: 20000, pending: 2, timeoutMs: 10000, responseBytes: 4096 });
const own = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
    && Reflect.ownKeys(value).length === keys.length && keys.every(key => Object.getOwnPropertyDescriptor(value, key)?.enumerable && Object.hasOwn(Object.getOwnPropertyDescriptor(value, key) || {}, 'value'));
export const assistantStorageError = (code, message, status = 409) => Object.assign(Error(message), { code: 'assistant_storage_' + code, status });
const fail = () => { throw assistantStorageError('contract', '场外特助文件盘点格式无效', 400); };
export function assistantStorageRequest(value) {
    if (!own(value, ['version', 'expectedAccount']) || value.version !== 1 || typeof value.expectedAccount !== 'string' || !/^st-user:[a-f0-9]{64}$/.test(value.expectedAccount)) fail();
    return Object.freeze({ version: 1, expectedAccount: value.expectedAccount });
}
export function assistantStorageResponse(value, expectedAccount) {
    assistantStorageRequest({ version: 1, expectedAccount });
    if (!own(value, ['ok', 'version', 'expectedAccount', 'scope', 'heads', 'current', 'retained', 'total', 'observation', 'contentVerified']) || value.ok !== true || value.version !== 1 || value.contentVerified !== false
        || value.expectedAccount !== expectedAccount || value.scope !== 'st-account-assistant-files' || value.observation !== 'file-sizes-not-disk-allocation') fail();
    const copy = { ok: true, version: 1, expectedAccount, scope: value.scope, observation: value.observation, contentVerified: false };
    for (const key of ['heads', 'current', 'retained', 'total']) {
        const row = value[key];
        if (!own(row, ['count', 'bytes']) || !Number.isSafeInteger(row.count) || row.count < 0 || row.count > ASSISTANT_STORAGE_LIMITS.files || !Number.isSafeInteger(row.bytes) || row.bytes < 0 || (!row.count && row.bytes)) fail();
        copy[key] = Object.freeze({ count: row.count, bytes: row.bytes });
    }
    if (copy.heads.count !== copy.current.count || copy.total.count !== copy.heads.count + copy.current.count + copy.retained.count
        || copy.total.bytes !== copy.heads.bytes + copy.current.bytes + copy.retained.bytes) fail();
    return Object.freeze(copy);
}
export function assistantStorageErrorPayload(error) {
    const known = ['contract','setup','account','path','changed','capacity','content','missing','busy','unavailable'].some(code => error?.code === 'assistant_storage_' + code);
    return { status: known && [400,401,403,404,409,429,503].includes(error.status) ? error.status : 503,
        body: { ok: false, code: known ? error.code : 'assistant_storage_unavailable', message: '场外特助 ST 文件暂未完成盘点，原件未修改。' } };
}
