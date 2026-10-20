import { parseBoundedJson } from './qianmu-json-input.js';
import { buildNativeBackupCatalog, normalizeAutomaticBackupEntries } from './qianmu-chat-backup-catalog.js';

// Native ST 1.19 backup-to-character-copy recovery. No open-chat state is changed.
// The import route is NOT exclusive-create: a random operation prefix and a
// preflight listing reduce collisions, but cannot provide a server transaction.
export const CHAT_RECOVERY_PREVIEW_FLOORS = 5;
export const CHAT_RECOVERY_LIMITS = Object.freeze({ bytes: 16 * 1024 * 1024, messages: 50000, previewChars: 14000 });
export const CHAT_BACKUP_RETENTION_DAYS = Object.freeze([3, 7, 15, 30]);
export const DEFAULT_CHAT_BACKUP_RETENTION_DAYS = 30;
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const clone = value => structuredClone(value);
const fault = (code, message) => Object.assign(new Error(message), { code });
const need = (ok, code, message) => { if (!ok) throw fault(code, message); };
const fileName = value => typeof value === 'string' && value.length > 0 && new TextEncoder().encode(value).length <= 255 && !/[<>:"|?*\\/\u0000-\u001f\u007f-\u009f]/.test(value) && !/[. ]$/.test(value) && !/^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(value) && value !== '.' && value !== '..';
const backupName = value => fileName(value) && value.startsWith('chat_') && value.endsWith('.jsonl');
const parse = (text, maxBytes) => parseBoundedJson(text, { maxBytes, maxDepth: 40, maxNodes: 500000, label: '聊天找回' });
const cancelQuietly = stream => { try { Promise.resolve(stream?.cancel?.()).catch(() => {}); } catch {} };
const BACKUP_API = '/api/plugins/qianmu-tts/chat-backups';
const automaticState = () => ({ availability: 'unknown', busy: false, error: '', status: null, configurationUnknown: false });
const identityFailure = error => ['account', 'http-401', 'http-403'].includes(error?.code);
function httpFailure(status, path) {
    if (status === 401 || status === 403) return '登录或请求校验未通过，请刷新 ST 后重试（' + status + '）';
    if (status === 404) return path.startsWith(BACKUP_API) ? '自动备份需要安装或更新千幕增强服务至 v1.59.482'
        : path.endsWith('/download') ? '这份备份已不存在，请刷新备份列表（404）' : '当前 ST 未提供此备份接口（404）';
    if (status === 500) return 'ST 读取或处理备份失败（500），请查看 ST 服务日志';
    if ([502, 503, 504].includes(status)) return 'ST 服务或连接代理暂不可用（' + status + '），请稍后重试';
    return 'ST 返回了未预期的状态（' + status + '），未继续操作';
}
const automaticFailures = Object.freeze({
    chat_backup_host: '当前 ST 无法提供可靠的后台账户目录，请核对增强服务与 ST 版本',
    chat_backup_capacity: '保留每份聊天的有效副本后空间不足，请提高备份上限；未删除保底副本',
    chat_backup_disk_unknown: '无法核实设备剩余空间，自动备份已暂停',
    chat_backup_disk_full: '设备剩余空间不足，自动备份已暂停并保留旧副本',
    chat_backup_corrupt: '备份索引或设置校验失败，请保留文件并核查增强服务日志',
    chat_backup_verify: '备份内容校验失败，未覆盖原聊天或自动重试',
    chat_backup_changed: '文件在处理期间变化，请稍后重新核对',
    chat_backup_path: '聊天或备份目录无法安全核对，请检查目录权限与链接',
    chat_backup_storage: '备份存储暂不可用，已有聊天和备份保持不变',
    chat_backup_missing: '这份自动备份已不存在，请刷新备份列表',
    chat_backup_busy: '备份任务正在处理，请稍后再试',
});
function automaticStatus(value) {
    const maxVersionsPerChat = value?.maxVersionsPerChat === undefined ? 0 : value.maxVersionsPerChat;
    const retentionDays = value?.retentionDays === undefined ? DEFAULT_CHAT_BACKUP_RETENTION_DAYS : value.retentionDays;
    need(value?.ok === true && value.version === 1 && typeof value.enabled === 'boolean'
        && Number.isInteger(value.intervalMinutes) && value.intervalMinutes >= 15 && value.intervalMinutes <= 1440
        && Number.isInteger(value.limitMiB) && value.limitMiB >= 256 && value.limitMiB <= 10240
        && Number.isSafeInteger(maxVersionsPerChat) && maxVersionsPerChat >= 0 && maxVersionsPerChat <= 20000
        && Number.isInteger(retentionDays) && CHAT_BACKUP_RETENTION_DAYS.includes(retentionDays)
        && Number.isSafeInteger(value.usedBytes) && value.usedBytes >= 0
        && value.retention === 'rotate-oldest-keep-one', 'response', '增强服务返回的备份状态不完整，请更新服务后重试');
    return { ...value, maxVersionsPerChat, retentionDays, retentionDaysSupported: Object.hasOwn(value, 'retentionDays') };
}
function automaticEntries(result) {
    const ids = new Set();
    need(result?.ok === true && result.version === 1 && Array.isArray(result.entries) && result.entries.every(row => {
        if (!plain(row) || typeof row.id !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(row.id) || ids.has(row.id)
            || !fileName(row.avatar) || !row.avatar.endsWith('.png') || !fileName(row.chatFile) || !row.chatFile.endsWith('.jsonl')
            || !Number.isSafeInteger(row.messageCount) || row.messageCount < 1 || row.messageCount > CHAT_RECOVERY_LIMITS.messages
            || !Number.isSafeInteger(row.sizeBytes) || row.sizeBytes < 1 || row.sizeBytes > CHAT_RECOVERY_LIMITS.bytes
            || typeof row.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(row.sha256) || typeof row.createdAt !== 'string') return false;
        ids.add(row.id); return true;
    }), 'response', '定时备份列表不完整，请重新读取，不猜测损坏记录');
    return normalizeAutomaticBackupEntries(result.entries);
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
    let disposed = false, operation = 0, previewRevision = 0, active = false, owner = '', source = null, pending = null, uncertainConfiguration = false;
    let state = { phase: 'idle', busy: false, error: '', backups: [], preview: null, result: null, automaticBackup: automaticState() };
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
    async function response(path, body, token, { form = false, beforeSend = () => {}, download = false, maxBytes = CHAT_RECOVERY_LIMITS.bytes } = {}) {
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
                    // BaiBai Tools replaces only the native list with its account-scoped
                    // fast-list response. This exact alias is not valid for any readback
                    // or write route, and does not admit queries, fragments or redirects.
                    const nativeListAlias = path === '/api/backups/chat/get'
                        && result.url === new URL('/api/plugins/baibaoku/v1/chat-backups/fast-list', base).href;
                    need(!result.url || result.url === new URL(path, base).href || nativeListAlias, 'source', '备份响应地址与预期不符，未读取数据；请核对相关插件或代理配置');
                    if (!result.ok && path.startsWith(BACKUP_API) && ![401, 403].includes(result.status) && /^application\/json(?:\s*;|$)/i.test(mime)) {
                        let detail;
                        try { detail = parse(await boundedText(result, 4096, controller.signal, check), 4096); } catch {}
                        await guard(token); check();
                        if (detail?.ok === false && detail.version === 1 && Object.hasOwn(automaticFailures, detail.code)) throw fault('http-' + result.status, automaticFailures[detail.code]);
                    }
                    need(result.ok && result.status === 200, 'http-' + result.status, httpFailure(result.status, path));
                    need((download ? /^(?:application\/(?:jsonl|x-ndjson|ndjson|octet-stream|json)|text\/plain)(?:\s*;|$)/i : /^application\/json(?:\s*;|$)/i).test(mime), 'response', 'ST 返回的不是预期备份数据，请刷新后重试；仍失败时核对服务或代理配置');
                    const raw = await boundedText(result, maxBytes, controller.signal, check);
                    await guard(token); check(); return raw;
                } finally { cancelQuietly(result.body); }
            })(), cancelled]);
        } finally { clearTimeout(timer); controller.signal.removeEventListener('abort', onAbort); controller.abort(); requests.delete(controller); }
    }
    async function json(path, body, token) {
        const maxBytes = path === '/api/chats/export' ? CHAT_RECOVERY_LIMITS.bytes * 2 + 4096 : CHAT_RECOVERY_LIMITS.bytes;
        const raw = await response(path, body, token, { maxBytes });
        try { return parse(raw, maxBytes); } catch { throw fault('response', 'ST 返回资料不完整，请稍后核实'); }
    }
    async function download(name, token) {
        const entry = state.backups.find(row => row.name === name);
        if (entry?.source === 'qianmu') {
            const text = await response(BACKUP_API + '/read', { expectedAccount: owner, id: entry.id }, token, { download: true });
            return { text, ...inspectChatRecoveryJsonl(text) };
        }
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
    function publicResult(status, file = '') {
        return { status, target: clone(pending.target), fileName: file, operationId: pending.id, messageCount: pending.messageCount };
    }
    async function verifyPending(token) {
        need(pending?.submitted, 'verify', '没有需要核实的找回操作');
        const names = await listChats(pending.target, token);
        const existing = pending.existingNames instanceof Set
            ? pending.existingNames
            : new Set(Array.isArray(pending.existingNames) ? pending.existingNames : []);
        const candidates = names.filter(name => name.startsWith(pending.prefix + ' - ') && !existing.has(name));
        if (candidates.length !== 1 || pending.fileName && candidates[0] !== pending.fileName) {
            state.result = publicResult(candidates.length > 1 ? 'conflict' : 'unknown', pending.fileName || '');
            state.phase = 'unknown';
            state.error = candidates.length > 1 ? '找到多份同次副本，未继续创建，请核对聊天文件' : '尚未确认副本，请稍后点“核实结果”，不要重复创建';
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
        pending.verified = true; state.result = publicResult('verified', name); state.phase = 'verified'; state.error = '';
        return snapshot();
    }
    async function run(phase, action, { bind = false } = {}) {
        need(!active, 'busy', '正在处理上一项找回操作');
        const token = ++operation; live(token); active = true; state.busy = true; state.phase = phase; state.error = ''; emit();
        try {
            if (bind) {
                const account = await accountNow(); live(token);
                need(typeof account === 'string' && account, 'account', '暂未确认当前 ST 账户');
                if (owner && owner !== account) { source = null; pending = null; uncertainConfiguration = false; state.backups = []; state.preview = null; state.result = null; state.automaticBackup = automaticState(); }
                owner = account;
                state.automaticBackup.configurationUnknown = uncertainConfiguration;
            }
            await guard(token); await action(token); state.busy = false; return snapshot();
        } catch (error) {
            if (!disposed && token === operation) {
                state.phase = pending?.submitted && !pending.verified && !identityFailure(error) ? 'unknown' : 'error';
                state.error = error?.code ? error.message : '操作未完成，请稍后核实';
                if (identityFailure(error)) { source = null; state.backups = []; state.preview = null; state.result = null; state.automaticBackup = automaticState(); }
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
        load() {
            return run('loading', async token => {
                let rows = [], nativeError = null, automaticRows = [];
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
                try {
                    const result = await json(BACKUP_API + '/list', { expectedAccount: owner }, token);
                    automaticRows = automaticEntries(result);
                    state.automaticBackup.availability = 'available';
                    state.automaticBackup.error = '';
                } catch (error) {
                    if (identityFailure(error) || error?.code === 'context') throw error;
                    state.automaticBackup.error = error?.message || '定时备份暂不可读取';
                    state.automaticBackup.availability = error?.code === 'http-404' ? 'unavailable' : 'unknown';
                }
                if (nativeError && !automaticRows.length) throw nativeError;
                state.backups = [...natives, ...automaticRows];
                if (nativeError) state.error = nativeError.message + '；当前仅显示千幕定时备份。';
                state.phase = pending?.submitted ? pending.verified ? 'verified' : 'unknown' : 'ready';
                // A transient identity lookup failure hides private details.
                // Rebinding the SAME confirmed account may reveal its receipt
                // again; a different account has already cleared pending above.
                if (pending?.submitted) {
                    state.result = publicResult(pending.verified ? 'verified' : 'unknown', pending.fileName || '');
                    if (!pending.verified) state.error = '尚未确认副本，请先点“核实上次结果”，不要重复创建';
                }
            }, { bind: true });
        },
        inspectAutomaticBackup() {
            const phase = state.phase;
            return run(phase, async token => {
                state.automaticBackup.busy = true; emit();
                try {
                    const value = automaticStatus(await json(BACKUP_API + '/status', { expectedAccount: owner }, token));
                    uncertainConfiguration = false;
                    state.automaticBackup = { availability: 'available', busy: false, error: '', status: value, configurationUnknown: false };
                } catch (error) {
                    state.automaticBackup = { ...automaticState(), configurationUnknown: state.automaticBackup.configurationUnknown, availability: error?.code === 'http-404' ? 'unavailable' : 'unknown', error: error.message };
                    throw error;
                } finally { state.automaticBackup.busy = false; state.phase = phase; }
            }, { bind: true });
        },
        configureAutomaticBackup(input) {
            const phase = state.phase;
            return run(phase, async token => {
                const maxVersionsPerChat = input?.maxVersionsPerChat === undefined ? state.automaticBackup.status?.maxVersionsPerChat ?? 0 : input.maxVersionsPerChat;
                const retentionDays = input?.retentionDays === undefined ? state.automaticBackup.status?.retentionDays ?? DEFAULT_CHAT_BACKUP_RETENTION_DAYS : input.retentionDays;
                need(typeof input?.enabled === 'boolean' && Number.isInteger(input.intervalMinutes) && input.intervalMinutes >= 15 && input.intervalMinutes <= 1440
                    && Number.isInteger(input.limitMiB) && input.limitMiB >= 256 && input.limitMiB <= 10240
                    && Number.isSafeInteger(maxVersionsPerChat) && maxVersionsPerChat >= 0 && maxVersionsPerChat <= 20000
                    && Number.isInteger(retentionDays) && CHAT_BACKUP_RETENTION_DAYS.includes(retentionDays),
                'configuration', '备份间隔为15–1440整数分钟，空间为256–10240 MB；版本数为1–20000整数，留空不限；保留周期只能是3、7、15或30天');
                need(!uncertainConfiguration, 'configuration', '上次设置结果未确认，请重新展开自动备份后核对');
                need(state.automaticBackup.availability === 'available' && state.automaticBackup.status, 'configuration', '请先读取当前账户的备份设置');
                state.automaticBackup.busy = true; uncertainConfiguration = true; state.automaticBackup.configurationUnknown = true; emit();
                try {
                    const value = automaticStatus(await json(BACKUP_API + '/configure', { expectedAccount: owner, enabled: input.enabled, intervalMinutes: input.intervalMinutes, limitMiB: input.limitMiB, maxVersionsPerChat, retentionDays }, token));
                    need(value.enabled === input.enabled && value.intervalMinutes === input.intervalMinutes && value.limitMiB === input.limitMiB
                        && value.maxVersionsPerChat === maxVersionsPerChat && value.retentionDays === retentionDays && value.retentionDaysSupported === true,
                    'configuration', '备份设置未完整确认，请重新展开自动备份核对；如服务较旧，请先同步更新增强服务');
                    uncertainConfiguration = false;
                    state.automaticBackup = { availability: 'available', busy: false, error: '', status: value, configurationUnknown: false };
                } catch (error) {
                    state.automaticBackup.error = '设置结果尚未确认，请重新展开自动备份核对；不会自动重复提交。';
                    throw error;
                } finally { state.automaticBackup.busy = false; state.phase = phase; }
            });
        },
        preview(name) {
            return run('previewing', async token => {
                need(!pending?.submitted || pending.verified, 'unverified', '请先核实上一份副本，不要重复创建');
                need(state.backups.some(row => row.name === name), 'source', '请从当前账户的备份清单中选择');
                const candidate = await download(name, token);
                source = { ...candidate, name }; pending = null; state.result = null; state.preview = { ...previewOf(name, source), revision: ++previewRevision }; state.phase = 'ready';
            });
        },
        recover(avatar) {
            if (pending?.submitted) return run('recovering', verifyPending);
            return run('recovering', async token => {
                need(source && state.preview?.canRecover, 'source', '请先预览要找回的备份');
                const target = targetFor(avatar), original = source;
                const fresh = await download(original.name, token);
                need(fresh.text === original.text, 'source-changed', '备份内容已变化，请重新预览');
                const id = crypto.randomUUID(); need(/^[a-f\d-]{36}$/i.test(id), 'random', '安全标识生成失败，未创建副本');
                const integrity = crypto.randomUUID(); need(/^[a-f\d-]{36}$/i.test(integrity) && integrity !== original.rows[0].chat_metadata?.integrity, 'random', '新副本校验标识生成失败');
                const rows = clone(original.rows); rows[0].chat_metadata ??= {}; rows[0].chat_metadata.integrity = integrity;
                // ST appends its own timestamp to character_name. A human
                // descriptor is more useful in the recent-chat list than a
                // message-count suffix or an exposed operation UUID. The
                // preflight snapshot below keeps repeated recoveries distinct.
                const prefix = '千幕备份';
                const names = await listChats(target, token);
                const form = new FormData(); form.set('file_type', 'jsonl'); form.set('avatar_url', target.avatar); form.set('character_name', prefix); form.set('user_name', 'User');
                form.set('file', new Blob([rows.map(row => JSON.stringify(row)).join('\n')], { type: 'application/jsonl' }), prefix + '.jsonl');
                await guard(token); sameTarget(target);
                pending = { id, prefix, existingNames: names, target, expected: canonical(rows), messageCount: original.messageCount, submitted: false, verified: false, fileName: '' };
                try {
                    const raw = await response('/api/chats/import', form, token, { form: true, beforeSend: () => { sameTarget(target); pending.submitted = true; state.result = publicResult('unknown'); } });
                    let result; try { result = parse(raw, CHAT_RECOVERY_LIMITS.bytes); } catch {}
                    if (result?.res === true && Array.isArray(result.fileNames) && result.fileNames.length === 1 && fileName(result.fileNames[0]) && result.fileNames[0].startsWith(prefix + ' - ') && result.fileNames[0].endsWith('.jsonl')) pending.fileName = result.fileNames[0];
                } catch (error) {
                    // A rejected/lost response cannot prove that no file was
                    // written. Only inspect this same operation; never repost.
                    if (!pending?.submitted) throw error;
                    await guard(token);
                }
                await verifyPending(token);
            });
        },
        verify() { return run('recovering', verifyPending); },
        dispose() { disposed = true; operation++; for (const controller of requests) controller.abort(); source = null; pending = null; owner = ''; state = { phase: 'idle', busy: false, error: '', backups: [], preview: null, result: null, automaticBackup: automaticState() }; },
    });
}
