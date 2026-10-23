import { parseBoundedJson } from './qianmu-json-input.js';
import { buildNativeBackupCatalog } from './qianmu-chat-backup-catalog.js';

// Native ST 1.19 backup-to-character-copy recovery. No open-chat state is changed.
// The import route is NOT exclusive-create: a random operation prefix and a
// preflight listing reduce collisions, but cannot provide a server transaction.
export const CHAT_RECOVERY_PREVIEW_FLOORS = 5;
export const CHAT_RECOVERY_LIMITS = Object.freeze({ bytes: 16 * 1024 * 1024, messages: 50000, previewChars: 14000 });
export const NATIVE_BACKUP_POLICY_PATH = '/api/plugins/qianmu-tts/st-backup-policy';
export const NATIVE_BACKUP_POLICY_LIMITS = Object.freeze({ min: 1, max: 500, defaultValue: 50 });
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const clone = value => structuredClone(value);
const fault = (code, message) => Object.assign(new Error(message), { code });
const need = (ok, code, message) => { if (!ok) throw fault(code, message); };
const fileName = value => typeof value === 'string' && value.length > 0 && new TextEncoder().encode(value).length <= 255 && !/[<>:"|?*\\/\u0000-\u001f\u007f-\u009f]/.test(value) && !/[. ]$/.test(value) && !/^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(value) && value !== '.' && value !== '..';
const backupName = value => fileName(value) && value.startsWith('chat_') && value.endsWith('.jsonl');
const escapeRegExp = value => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function importPrefix(target, existingNames) {
    // Feed ST's native importer a stable Qianmu sequence. It supplies the
    // humanized date/time; the temporary `imported` suffix is removed after
    // the write has been confirmed.
    const label = String(target?.name || '').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '').replace(/[. ]+$/g, '').trim() || '角色';
    const base = `${label}-QM`, matcher = new RegExp(`^${escapeRegExp(base)}(\\d+)\\s+-\\s+`);
    let highest = 0;
    for (const name of Array.isArray(existingNames) ? existingNames : []) {
        const match = typeof name === 'string' ? matcher.exec(name) : null;
        if (!match) continue;
        const number = Number(match[1]);
        if (Number.isSafeInteger(number) && number > highest) highest = number;
    }
    return `${base}${highest + 1}`;
}
const parse = (text, maxBytes) => parseBoundedJson(text, { maxBytes, maxDepth: 40, maxNodes: 500000, label: '聊天找回' });
const cancelQuietly = stream => { try { Promise.resolve(stream?.cancel?.()).catch(() => {}); } catch {} };
const identityFailure = error => ['account', 'http-401', 'http-403'].includes(error?.code);
const nativeBackupPolicyState = () => ({ availability: 'unknown', busy: false, error: '', notice: '', value: null,
    min: NATIVE_BACKUP_POLICY_LIMITS.min, max: NATIVE_BACKUP_POLICY_LIMITS.max, defaultValue: NATIVE_BACKUP_POLICY_LIMITS.defaultValue,
    writable: false, source: '', requiresRestart: true });
function httpFailure(status, path) {
    if (status === 401 || status === 403) return '登录或请求校验未通过，请刷新 ST 后重试（' + status + '）';
    if (status === 404) return path.endsWith('/download') ? '这份备份已不存在，请刷新备份列表（404）' : '当前 ST 未提供此备份接口（404）';
    if (status === 500) return 'ST 读取或处理备份失败（500），请查看 ST 服务日志';
    if ([502, 503, 504].includes(status)) return 'ST 服务或连接代理暂不可用（' + status + '），请稍后重试';
    return 'ST 返回了未预期的状态（' + status + '），未继续操作';
}
// Canonical JSON equality checks every retained metadata/message field, not
// only the count, last message, or integrity token. Object key order may change
// in ST's native JSONL importer; array order and all actual values must not.
function canonical(value, depth = 0) {
    need(depth <= 128, 'format', '备份结构过深，未开始恢复');
    if (Array.isArray(value)) return '[' + value.map(item => canonical(item, depth + 1)).join(',') + ']';
    if (plain(value)) return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key], depth + 1)).join(',') + '}';
    need(typeof value !== 'number' || Number.isFinite(value), 'format', '备份包含不能原样保留的数值，未开始恢复');
    return JSON.stringify(value);
}

export function inspectChatRecoveryJsonl(text) {
    need(typeof text === 'string' && new TextEncoder().encode(text).byteLength <= CHAT_RECOVERY_LIMITS.bytes, 'size', '备份超过可安全预览的大小，未开始恢复');
    const lines = text.replace(/^\uFEFF/, '').replace(/(?:\r?\n)+$/, '').split(/\r?\n/);
    need(lines.length > 1 && lines.length <= CHAT_RECOVERY_LIMITS.messages + 1, 'format', '备份没有可找回的正文，或消息数量过多');
    let rows;
    try {
        need(lines.every(line => line.trim()), 'format', '备份中间有空行，未开始恢复');
        rows = parse('[' + lines.join(',') + ']', CHAT_RECOVERY_LIMITS.bytes + 2);
        // Native ST serializes numbers with JSON.stringify. Reject alternate
        // tokens that JSON.parse would silently round, including decimals.
        const tokens = /"(?:[^"\\]|\\[\s\S])*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g;
        for (let token; (token = tokens.exec(text));) if (token[0][0] !== '"') need(token[0] === JSON.stringify(Number(token[0])), 'format', '备份包含不能原样保留的数值，未开始恢复');
    } catch (error) { throw fault('format', error?.code ? error.message : '备份结构不完整或含不安全字段，未开始恢复'); }
    const header = rows[0];
    need(plain(header) && !Object.hasOwn(header, 'mes') && (Object.hasOwn(header, 'chat_metadata') || Object.hasOwn(header, 'user_name') || Object.hasOwn(header, 'character_name')), 'format', '备份聊天头无效，未开始恢复');
    need(!Object.hasOwn(header, 'chat_metadata') || plain(header.chat_metadata), 'format', '备份资料格式无效，未开始恢复');
    need(rows.slice(1).every(row => plain(row) && typeof row.mes === 'string'), 'format', '备份正文格式不完整，未开始恢复');
    // ST's import route flattens Chub swipe objects. Do not accept a source it
    // would silently transform, even though a later readback could detect it.
    need(rows.every(row => !Object.hasOwn(row, 'swipes') || Array.isArray(row.swipes) && row.swipes.every(swipe => typeof swipe === 'string')), 'format', '此备份的候选回复格式无法原样导入，未开始恢复');
    canonical(rows);
    return { rows, messageCount: rows.length - 1 };
}

function previewOf(name, source) {
    const messages = source.rows.slice(1);
    // Keep preview work bounded for very long chats without altering the source
    // used by recovery. The newest five complete floors are the most useful
    // identity check; every selected floor remains fully readable and collapsible.
    // Show the newest floor first without changing the source row order used
    // by recovery.
    const start = Math.max(0, messages.length - CHAT_RECOVERY_PREVIEW_FLOORS);
    const previewMessages = messages.slice(start).map((row, index) => ({
        floor: start + index + 1,
        name: String(row.name || '未命名'),
        text: row.mes,
    })).reverse();
    const text = previewMessages.map(row => `第 ${row.floor} 条 · ${row.name}\n${row.text}`).join('\n\n');
    return {
        name,
        messageCount: source.messageCount,
        previewStart: start + 1,
        previewFloorLimit: CHAT_RECOVERY_PREVIEW_FLOORS,
        previewMessages,
        participants: [...new Set(messages.map(row => String(row.name || '').trim()).filter(Boolean))].slice(0, 20),
        text,
        canRecover: true,
    };
}

async function boundedText(response, maxBytes, signal, check) {
    const declared = response.headers?.get?.('content-length');
    need(declared == null || /^\d+$/.test(declared) && Number.isSafeInteger(Number(declared)) && Number(declared) <= maxBytes, 'size', '返回内容过大或长度无效，未继续处理');
    const reader = response.body?.getReader?.();
    need(reader, 'response', 'ST 返回内容不可读取，请稍后核实');
    const onAbort = () => cancelQuietly(reader);
    signal.addEventListener('abort', onAbort, { once: true });
    const chunks = []; let length = 0;
    try {
        for (;;) {
            check(); const part = await reader.read(); check(); if (part.done) break;
            need(part.value instanceof Uint8Array, 'response', 'ST 返回内容无效，请稍后核实');
            length += part.value.byteLength;
            need(length <= maxBytes, 'size', '返回内容过大，未继续处理'); chunks.push(part.value);
        }
        const bytes = new Uint8Array(length); let offset = 0;
        for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
        return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } finally { signal.removeEventListener('abort', onAbort); cancelQuietly(reader); try { reader.releaseLock(); } catch {} }
}

export function createChatRecovery({ fetch: request = globalThis.fetch, getRequestHeaders, resolveAccount, getCharacters, isCurrent = () => true, onChange = () => {}, crypto = globalThis.crypto, origin = globalThis.location?.origin, timeoutMs = 15000 } = {}) {
    for (const callback of [request, getRequestHeaders, resolveAccount, getCharacters, isCurrent, onChange]) need(typeof callback === 'function', 'configuration', '聊天找回尚未就绪');
    need(typeof crypto?.randomUUID === 'function', 'configuration', '当前浏览器不支持安全创建找回副本');
    const base = new URL(origin);
    need(['http:', 'https:'].includes(base.protocol) && base.pathname === '/' && !base.username && !base.password && !base.search && !base.hash && (!globalThis.location?.origin || globalThis.location.origin === base.origin), 'configuration', '聊天找回来源无效');
    need(Number.isFinite(timeoutMs) && timeoutMs >= 1 && timeoutMs <= 15000, 'configuration', '聊天找回读取时限无效');
    const requests = new Set();
    let disposed = false, operation = 0, previewRevision = 0, active = false, owner = '', source = null, pending = null;
    let state = { phase: 'idle', busy: false, error: '', backups: [], preview: null, result: null, recovered: [], nativeBackupPolicy: nativeBackupPolicyState() };
    const snapshot = () => clone(state);
    const emit = () => { if (!disposed && isCurrent()) { try { onChange(snapshot()); } catch {} } };
    const live = token => { need(!disposed && token === operation && isCurrent(), 'context', '找回页面已变化，请重新打开'); };
    async function accountNow() { try { return await resolveAccount(); } catch { throw fault('account', '暂未确认当前 ST 账户，未继续操作'); } }
    async function guard(token, account = owner) {
        live(token); const current = await accountNow(); live(token);
        need(typeof current === 'string' && current && current === account, 'account', 'ST 账户已变化，未继续操作');
    }
    function targetFor(avatar) {
        need(typeof avatar === 'string' && fileName(avatar) && avatar.endsWith('.png'), 'target', '请选择要存放副本的角色');
        const matches = getCharacters().filter(item => item?.avatar === avatar), target = matches[0];
        need(matches.length === 1, 'target', '目标角色不存在或不唯一，请重新选择');
        need(target && typeof target.name === 'string' && target.name.trim(), 'target', '目标角色已变化，请重新选择');
        return { avatar, name: target.name };
    }
    function sameTarget(target) { const current = targetFor(target.avatar); need(current.name === target.name, 'target', '目标角色已改名，请重新选择'); }
    async function response(path, body, token, { form = false, beforeSend = () => {}, download = false, maxBytes = CHAT_RECOVERY_LIMITS.bytes, allowErrorStatus = false } = {}) {
        const controller = new AbortController(); requests.add(controller);
        let timer, rejectCancellation;
        const cancelled = new Promise((_, reject) => { rejectCancellation = reject; });
        const onAbort = () => rejectCancellation(fault(disposed ? 'context' : 'timeout', disposed ? '找回页面已变化，请重新打开' : '读取超时，请稍后核实'));
        controller.signal.addEventListener('abort', onAbort, { once: true });
        timer = setTimeout(() => controller.abort(), timeoutMs);
        const check = () => { live(token); need(!controller.signal.aborted, 'timeout', '读取超时，请稍后核实'); };
        try {
            return await Promise.race([(async () => {
                await guard(token); check();
                const provided = new Headers(getRequestHeaders()), headers = new Headers({ Accept: download ? 'application/jsonl, application/octet-stream, text/plain' : 'application/json' });
                if (provided.has('x-csrf-token')) headers.set('X-CSRF-Token', provided.get('x-csrf-token'));
                if (!form) headers.set('content-type', 'application/json');
                check(); beforeSend();
                const result = await request(path, { method: 'POST', credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: controller.signal, headers, body: form ? body : JSON.stringify(body) });
                try {
                    check(); await guard(token); check();
                    const mime = result.headers?.get?.('content-type') || '';
                    need(!result.redirected && !['opaque', 'opaqueredirect'].includes(result.type), 'source', 'ST 请求发生跳转或无法核实来源，未读取备份；请核对访问地址或代理配置');
                    // The optional BaiBai acceleration may serve ST's native
                    // chat list through its exact fast-list alias. It is still
                    // the native list contract; no Qianmu backup route is
                    // accepted here.
                    const nativeListAlias = path === '/api/backups/chat/get'
                        && result.url === new URL('/api/plugins/baibaoku/v1/chat-backups/fast-list', base).href;
                    need(!result.url || result.url === new URL(path, base).href || nativeListAlias, 'source', '备份响应地址与预期不符，未读取数据；请核对相关插件或代理配置');
                    need(allowErrorStatus || result.ok && result.status === 200, 'http-' + result.status, httpFailure(result.status, path));
                    need((download ? /^(?:application\/(?:jsonl|x-ndjson|ndjson|octet-stream|json)|text\/plain)(?:\s*;|$)/i : /^application\/json(?:\s*;|$)/i).test(mime), 'response', 'ST 返回的不是预期备份数据，请刷新后重试；仍失败时核对服务或代理配置');
                    const raw = await boundedText(result, maxBytes, controller.signal, check);
                    await guard(token); check(); return raw;
                } finally { cancelQuietly(result.body); }
            })(), cancelled]);
        } finally { clearTimeout(timer); controller.signal.removeEventListener('abort', onAbort); controller.abort(); requests.delete(controller); }
    }
    async function json(path, body, token, { allowErrorStatus = false } = {}) {
        const maxBytes = path === '/api/chats/export' ? CHAT_RECOVERY_LIMITS.bytes * 2 + 4096 : CHAT_RECOVERY_LIMITS.bytes;
        const raw = await response(path, body, token, { maxBytes, allowErrorStatus });
        try { return parse(raw, maxBytes); } catch { throw fault('response', 'ST 返回资料不完整，请稍后核实'); }
    }
    async function download(name, token) {
        const entry = state.backups.find(row => row.name === name);
        need(backupName(name), 'source', '备份名称无效');
        const text = await response('/api/backups/chat/download', { name }, token, { download: true });
        return { text, ...inspectChatRecoveryJsonl(text) };
    }
    async function listChats(target, token) {
        sameTarget(target);
        const rows = await json('/api/characters/chats', { avatar_url: target.avatar, simple: true }, token);
        sameTarget(target);
        need(Array.isArray(rows) && rows.every(row => fileName(row?.file_name) && row.file_name.endsWith('.jsonl')), 'target-list', '暂未确认目标角色的聊天目录，未创建副本');
        return rows.map(row => row.file_name);
    }
    const withoutImportedSuffix = name => typeof name === 'string' && / imported\.jsonl$/.test(name)
        ? name.replace(/ imported\.jsonl$/, '.jsonl') : name;
    async function renameImportedChat(target, name, token) {
        const renamed = withoutImportedSuffix(name);
        if (renamed === name) return name;
        need(fileName(renamed), 'rename', '聊天备份已导入，但目标文件名无效，请稍后核实');
        const result = await json('/api/chats/rename', {
            avatar_url: target.avatar, original_file: name, renamed_file: renamed, is_group: false,
        }, token);
        need(result?.ok === true, 'rename', '聊天备份已导入，但文件名调整未确认，请稍后核实');
        sameTarget(target);
        return renamed;
    }
    function normalizeNativeBackupPolicy(value) {
        need(plain(value) && value.ok === true && value.available === true, 'native-policy', value?.message || '当前部署未提供 ST 原生备份设置接口');
        const min = Number.isSafeInteger(value.min) ? value.min : NATIVE_BACKUP_POLICY_LIMITS.min;
        const max = Number.isSafeInteger(value.max) ? value.max : NATIVE_BACKUP_POLICY_LIMITS.max;
        const numberOfBackups = Number.isSafeInteger(value.value) && value.value >= min ? value.value : null;
        need(numberOfBackups !== null, 'native-policy', 'ST 原生备份设置返回的数量无效');
        return { availability: 'available', busy: false, error: '', notice: String(value.message || ''), value: numberOfBackups,
            min, max, defaultValue: Number.isSafeInteger(value.defaultValue) ? value.defaultValue : NATIVE_BACKUP_POLICY_LIMITS.defaultValue,
            writable: value.writable === true, source: typeof value.source === 'string' ? value.source : '', requiresRestart: value.requiresRestart !== false };
    }
    async function nativeBackupPolicyRequest(token, action = 'read', numberOfBackups) {
        const value = await json(NATIVE_BACKUP_POLICY_PATH, { action, ...(action === 'write' ? { numberOfBackups } : {}) }, token, { allowErrorStatus: true });
        if (value?.ok !== true) throw fault(`native-policy-${String(value?.code || 'service')}`, String(value?.message || 'ST 原生备份设置暂不可用'));
        return normalizeNativeBackupPolicy(value);
    }
    function retainNativePolicyError(error, prior = state.nativeBackupPolicy) {
        const unavailable = ['native-policy-unavailable', 'native-policy-account', 'http-404', 'http-405'].includes(error?.code);
        state.nativeBackupPolicy = { ...nativeBackupPolicyState(), ...prior, availability: unavailable ? 'unavailable' : 'error', busy: false,
            writable: false, error: error?.message || 'ST 原生备份设置暂不可用', notice: '' };
    }
    function publicResult(status, file = '') {
        return { status, target: clone(pending.target), fileName: file, operationId: pending.id, messageCount: pending.messageCount };
    }
    async function verifyPending(token) {
        need(pending?.submitted, 'verify', '没有需要核实的找回操作');
        const names = await listChats(pending.target, token);
        const existing = pending.existingNames instanceof Set
            ? pending.existingNames
            : new Set(Array.isArray(pending.existingNames) ? pending.existingNames : []);
        let candidates = names.filter(name => name.startsWith(pending.prefix + ' - ') && !existing.has(name));
        // ST's native importer appends ` imported.jsonl`. If the import
        // response was lost, or the rename response was lost, discover that
        // one candidate and finish the same operation without reposting it.
        if (candidates.length === 1) {
            const candidate = candidates[0], renamed = withoutImportedSuffix(candidate);
            if (renamed !== candidate && (!pending.fileName || pending.fileName === renamed)) {
                pending.fileName = renamed;
                await renameImportedChat(pending.target, candidate, token);
                const refreshed = await listChats(pending.target, token);
                candidates = refreshed.filter(name => name.startsWith(pending.prefix + ' - ') && !existing.has(name));
            }
        }
        if (candidates.length !== 1 || pending.fileName && candidates[0] !== pending.fileName) {
            state.result = publicResult(candidates.length > 1 ? 'conflict' : 'unknown', pending.fileName || '');
            state.phase = 'unknown';
            state.error = candidates.length > 1 ? '找到多份同次副本，未继续创建，请核对聊天文件' : '本次核实暂未发现新副本；可以继续读取其他备份，稍后再核实。';
            return snapshot();
        }
        const name = candidates[0]; pending.fileName = name;
        const result = await json('/api/chats/export', { avatar_url: pending.target.avatar, file: name, exportfilename: name, format: 'jsonl', is_group: false }, token);
        sameTarget(pending.target);
        need(typeof result?.result === 'string', 'verify', '副本读回失败，请稍后核实');
        let actual;
        try { actual = inspectChatRecoveryJsonl(result.result); } catch { actual = null; }
        if (!actual || canonical(actual.rows) !== pending.expected) {
            state.result = publicResult('conflict', name); state.phase = 'unknown'; state.error = '副本内容与备份不一致，未覆盖或删除任何文件，请核对';
            return snapshot();
        }
        pending.verified = true;
        const recovered = Array.isArray(state.recovered) ? state.recovered.filter(row => row.sourceName !== pending.sourceName || row.target?.avatar !== pending.target.avatar) : [];
        recovered.push({ sourceName: pending.sourceName, fileName: name, target: clone(pending.target), operationId: pending.id, messageCount: pending.messageCount });
        state.recovered = recovered;
        state.result = publicResult('verified', name); state.phase = 'verified'; state.error = '';
        return snapshot();
    }
    async function run(phase, action, { bind = false } = {}) {
        need(!active, 'busy', '正在处理上一项找回操作');
        const token = ++operation; live(token); active = true; state.busy = true; state.phase = phase; state.error = ''; emit();
        try {
            if (bind) {
                const account = await accountNow(); live(token);
                need(typeof account === 'string' && account, 'account', '暂未确认当前 ST 账户');
                if (owner && owner !== account) { source = null; pending = null; state.backups = []; state.preview = null; state.result = null; state.recovered = []; state.nativeBackupPolicy = nativeBackupPolicyState(); }
                owner = account;
            }
            await guard(token); await action(token); state.busy = false; return snapshot();
        } catch (error) {
            if (!disposed && token === operation) {
                state.phase = pending?.submitted && !pending.verified && !identityFailure(error) ? 'unknown' : 'error';
                state.error = error?.code ? error.message : '操作未完成，请稍后核实';
                if (identityFailure(error)) { source = null; state.backups = []; state.preview = null; state.result = null; state.recovered = []; state.nativeBackupPolicy = nativeBackupPolicyState(); }
                else if (pending?.submitted && !pending.verified) state.result = publicResult('unknown', pending.fileName || '');
            }
            throw error;
        } finally {
            active = false;
            if (!disposed && token === operation) { state.busy = false; emit(); }
        }
    }
    return Object.freeze({
        snapshot,
        inspectNativeBackupPolicy() {
            return run('native-policy', async token => {
                const prior = state.nativeBackupPolicy;
                state.nativeBackupPolicy = { ...prior, busy: true, error: '', notice: '' }; emit();
                try { state.nativeBackupPolicy = await nativeBackupPolicyRequest(token); }
                catch (error) {
                    if (identityFailure(error) || error?.code === 'context') throw error;
                    retainNativePolicyError(error, prior);
                }
            }, { bind: true });
        },
        configureNativeBackupPolicy(numberOfBackups) {
            return run('native-policy', async token => {
                const prior = state.nativeBackupPolicy;
                need(prior.availability === 'available', 'native-policy', '当前部署未提供 ST 原生备份设置接口');
                need(prior.writable === true, 'native-policy', '当前由 ST 环境变量控制，请修改部署环境变量并重启 ST');
                need(Number.isSafeInteger(numberOfBackups) && numberOfBackups >= prior.min && numberOfBackups <= prior.max,
                    'native-policy', `ST 原生每聊天备份数须为 ${prior.min}–${prior.max} 的整数`);
                state.nativeBackupPolicy = { ...prior, busy: true, error: '', notice: '' }; emit();
                try {
                    state.nativeBackupPolicy = await nativeBackupPolicyRequest(token, 'write', numberOfBackups);
                    if (!state.nativeBackupPolicy.notice) state.nativeBackupPolicy.notice = state.nativeBackupPolicy.requiresRestart ? '已保存，重启 ST 后生效' : '当前值未变化';
                } catch (error) {
                    if (identityFailure(error) || error?.code === 'context') throw error;
                    retainNativePolicyError(error, prior);
                }
            }, { bind: true });
        },
        load() {
            return run('loading', async token => {
                // A fresh list read starts a new browsing round. Keep the
                // durable recovered markers, but do not keep the old success
                // banner pinned above the newly loaded list.
                state.result = null;
                state.error = '';
                state.phase = 'loading';
                emit();
                let rows = [], nativeError = null;
                try {
                    rows = await json('/api/backups/chat/get', {}, token);
                    need(Array.isArray(rows), 'response', 'ST 备份清单暂不可用');
                } catch (error) { if (identityFailure(error) || error?.code === 'context') throw error; nativeError = error; rows = []; }
                const natives = await buildNativeBackupCatalog(rows.filter(row => backupName(row?.file_name)).map(row => ({
                    name: row.file_name, size: String(row.file_size || ''), messageCount: Number.isSafeInteger(row.chat_items) && row.chat_items >= 0 ? row.chat_items : null,
                    // ST's native `/api/backups/chat/get` computes last_mes from
                    // the final JSONL floor's send_date (falling back to the
                    // file mtime only for an empty chat). Do not replace this
                    // with the backup filename timestamp.
                    lastMessageAt: typeof row.last_mes === 'string' || typeof row.last_mes === 'number' ? row.last_mes : '', excerpt: String(row.mes || '').slice(0, 240),
                })), getCharacters(), { yieldToMain: async () => { await new Promise(resolve => setTimeout(resolve, 0)); live(token); } });
                await guard(token);
                const priorPolicy = state.nativeBackupPolicy;
                state.nativeBackupPolicy = { ...priorPolicy, busy: true, error: '', notice: '' }; emit();
                try { state.nativeBackupPolicy = await nativeBackupPolicyRequest(token); }
                catch (error) {
                    if (identityFailure(error) || error?.code === 'context') throw error;
                    retainNativePolicyError(error, priorPolicy);
                }
                if (nativeError) throw nativeError;
                state.backups = natives;
                state.phase = pending?.submitted && !pending.verified ? 'unknown' : 'ready';
                // A transient identity lookup failure hides private details.
                // Rebinding the SAME confirmed account may reveal its receipt
                // again; a different account has already cleared pending above.
                if (pending?.submitted && !pending.verified) {
                    state.result = publicResult('unknown', pending.fileName || '');
                    if (!pending.verified) state.error = '本次找回尚未确认；可以继续读取其他备份，稍后再核实。';
                }
            }, { bind: true });
        },
        preview(name) {
            return run('previewing', async token => {
                need(state.backups.some(row => row.name === name), 'source', '请从当前账户的备份清单中选择');
                const candidate = await download(name, token);
                // An unconfirmed import remains frozen for verification, but it
                // must not prevent the user from reading other backups. Clear a
                // completed receipt when a new source is chosen; keep an
                // unconfirmed receipt until verification resolves it.
                const unresolvedPending = pending?.submitted && !pending.verified;
                const samePendingSource = unresolvedPending && pending.sourceName === name;
                source = { ...candidate, name };
                if (!unresolvedPending || !samePendingSource) { pending = null; state.result = null; state.error = ''; }
                state.preview = { ...previewOf(name, source), revision: ++previewRevision }; state.phase = 'ready';
            });
        },
        recover(avatar) {
            // An uncertain import blocks only the exact same source/target
            // pair. A different target or a newly previewed source is a
            // separate recovery operation and must remain usable; the old
            // operation is never reposted automatically.
            if (source?.name && Array.isArray(state.recovered)
                && state.recovered.some(row => row.sourceName === source.name && row.target?.avatar === avatar)) return snapshot();
            if (pending?.verified && source?.name === pending.sourceName && avatar === pending.target?.avatar) return snapshot();
            if (pending?.submitted && source?.name === pending.sourceName && avatar === pending.target?.avatar) return run('recovering', verifyPending);
            return run('recovering', async token => {
                need(source && state.preview?.canRecover, 'source', '请先预览要找回的备份');
                const target = targetFor(avatar), original = source;
                const fresh = await download(original.name, token);
                need(fresh.text === original.text, 'source-changed', '备份内容已变化，请重新预览');
                const id = crypto.randomUUID(); need(/^[a-f\d-]{36}$/i.test(id), 'random', '安全标识生成失败，未创建副本');
                const integrity = crypto.randomUUID(); need(/^[a-f\d-]{36}$/i.test(integrity) && integrity !== original.rows[0].chat_metadata?.integrity, 'random', '新副本校验标识生成失败');
                const rows = clone(original.rows); rows[0].chat_metadata ??= {}; rows[0].chat_metadata.integrity = integrity;
                const names = await listChats(target, token);
                const prefix = importPrefix(target, names);
                const form = new FormData(); form.set('file_type', 'jsonl'); form.set('avatar_url', target.avatar); form.set('character_name', prefix); form.set('user_name', 'User');
                // SillyTavern's global upload middleware binds the import
                // upload under `avatar`; using `file` leaves request.file
                // empty and the native route rejects the import with 400.
                form.set('avatar', new Blob([rows.map(row => JSON.stringify(row)).join('\n')], { type: 'application/jsonl' }), prefix + '.jsonl');
                await guard(token); sameTarget(target);
                pending = { id, prefix, sourceName: original.name, existingNames: names, target, expected: canonical(rows), messageCount: original.messageCount, submitted: false, verified: false, renamePending: false, fileName: '' };
                try {
                    const raw = await response('/api/chats/import', form, token, { form: true, beforeSend: () => { sameTarget(target); pending.submitted = true; state.result = publicResult('unknown'); } });
                    let result; try { result = parse(raw, CHAT_RECOVERY_LIMITS.bytes); } catch {}
                    if (result?.res === false) throw fault('import', '聊天备份找回失败：ST 未创建副本');
                    if (result?.res === true && Array.isArray(result.fileNames) && result.fileNames.length === 1 && fileName(result.fileNames[0]) && result.fileNames[0].startsWith(prefix + ' - ') && result.fileNames[0].endsWith('.jsonl')) {
                        const importedName = result.fileNames[0];
                        pending.fileName = withoutImportedSuffix(importedName);
                        if (pending.fileName !== importedName) {
                            pending.renamePending = true;
                            await renameImportedChat(target, importedName, token);
                            pending.renamePending = false;
                        }
                    }
                } catch (error) {
                    // A 4xx response is a definitive server rejection (for
                    // example the wrong multipart field). It cannot represent
                    // a write that succeeded after the response was lost, so
                    // clear the receipt and let the caller try another file.
                    if ((/^http-4\d\d$/.test(error?.code) || error?.code === 'import') && !pending?.renamePending) {
                        pending = null; state.result = null; state.error = error.message;
                        throw error;
                    }
                    // A rejected/lost response cannot prove that no file was
                    // written. Only inspect this same operation; never repost.
                    if (!pending?.submitted) throw error;
                    await guard(token);
                }
                await verifyPending(token);
            });
        },
        verify() { return run('recovering', verifyPending); },
        dispose() { disposed = true; operation++; for (const controller of requests) controller.abort(); source = null; pending = null; owner = ''; state = { phase: 'idle', busy: false, error: '', backups: [], preview: null, result: null, recovered: [], nativeBackupPolicy: nativeBackupPolicyState() }; },
    });
}
