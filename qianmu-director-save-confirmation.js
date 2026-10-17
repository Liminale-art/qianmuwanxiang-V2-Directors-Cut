import { chatFileTarget } from './qianmu-chat-file-target.js';
import { parseBoundedJson } from './qianmu-json-input.js';

const SNAPSHOT_BYTES = 32 * 1024 * 1024;
const RESPONSE_BYTES = 64 * 1024 * 1024;
const TIMEOUT_MS = 15000;
const snapshots = new WeakMap();
const object = value => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const failure = () => Object.assign(new Error('尚未确认保存，请保留本次内容后核对'), { code: 'DIRECTOR_SAVE_UNCONFIRMED' });
const parse = (text, maxBytes) => parseBoundedJson(text, { maxBytes, maxDepth: 40, maxNodes: 500000, label: '聊天保存核验' });

function equal(left, right) {
    if (left === right) return true;
    if (!left || !right || typeof left !== 'object' || typeof right !== 'object' || Array.isArray(left) !== Array.isArray(right)) return false;
    const keys = Object.keys(left);
    return keys.length === Object.keys(right).length && keys.every(key => Object.hasOwn(right, key) && equal(left[key], right[key]));
}

/**
 * Freeze the JSON projection the native ST writer will serialize, not references
 * into its editable chat. This is not a disk baseline, a write, or a receipt.
 * Capture errors occur before the caller invokes the host save.
 */
export function captureDirectorSaveSnapshot({ target, metadata, messages } = {}) {
    const selected = chatFileTarget(target);
    if (!object(metadata) || !Array.isArray(messages) || !messages.every(object)) throw Error('聊天保存快照无效');
    // Both native character and group writers use this header and copy metadata.
    // JSON projection intentionally follows ST for Dates, undefined and its
    // non-enumerable legacy media aliases; no live message is normalized here.
    const rows = parse(JSON.stringify([{ chat_metadata: { ...metadata }, user_name: 'unused', character_name: 'unused' }, ...messages]), SNAPSHOT_BYTES);
    if (!object(rows[0]?.chat_metadata) || !rows.every(object)) throw Error('聊天保存快照无效');
    const token = Object.freeze({});
    snapshots.set(token, { target: selected, rows });
    return token;
}

function endpointFor(origin) {
    const base = new URL(origin);
    if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.pathname !== '/' || base.search || base.hash) throw failure();
    if (globalThis.location?.origin && globalThis.location.origin !== base.origin) throw failure();
    return new URL('/api/chats/export', base.origin).href;
}

function cancelQuietly(stream) {
    try { Promise.resolve(stream?.cancel?.()).catch(() => {}); } catch (_) { /* Best-effort read cancellation only. */ }
}

function exportedRows(text, wantedLength) {
    if (typeof text !== 'string' || !text.length || text.length > SNAPSHOT_BYTES || new TextEncoder().encode(text).byteLength > SNAPSHOT_BYTES) throw failure();
    // Formatting, object-key order and one terminal newline are insignificant;
    // empty/invalid middle rows are never skipped and arrays remain ordered.
    const lines = text.replace(/^\uFEFF/, '').replace(/\r?\n$/, '').split(/\r?\n/);
    if (lines.length !== wantedLength) throw failure();
    return lines.map(line => {
        const value = parse(line, SNAPSHOT_BYTES);
        if (!object(value)) throw failure();
        // ST writes JSON.stringify numbers. Do not let JSON.parse round a
        // different disk number into the expected value (large group gen_id
        // values are legitimate, so rejecting every unsafe integer is wrong).
        const tokens = /"(?:[^"\\]|\\[\s\S])*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g;
        for (let token; (token = tokens.exec(line));) {
            if (token[0][0] !== '"' && token[0] !== JSON.stringify(Number(token[0]))) throw failure();
        }
        return value;
    });
}

/**
 * Observe the fixed target through native read-only JSONL export. The caller's
 * guard must verify the original account/source before and after asynchronous
 * work. This does not prevent a writer race or establish server-side account CAS.
 * Never writes, retries, restores metadata, or substitutes /get for export.
 */
export async function confirmDirectorSave(snapshot, {
    fetchImpl = globalThis.fetch, headers = () => ({}), guard,
    origin = globalThis.location?.origin, timeoutMs = TIMEOUT_MS, signal,
} = {}) {
    let timer, controller, onAbort;
    try {
        const captured = snapshots.get(snapshot);
        if (!captured || typeof fetchImpl !== 'function' || typeof guard !== 'function'
            || !Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > TIMEOUT_MS) throw failure();
        const endpoint = endpointFor(origin);
        controller = new AbortController();
        let rejectCancellation;
        const cancellation = new Promise((_, reject) => { rejectCancellation = reject; });
        onAbort = () => { controller.abort(); rejectCancellation(failure()); };
        timer = setTimeout(onAbort, timeoutMs);
        signal?.addEventListener('abort', onAbort, { once: true });
        const deadline = Date.now() + timeoutMs;
        const check = () => { if (controller.signal.aborted || signal?.aborted || Date.now() >= deadline) throw failure(); };
        const guarded = async () => { check(); const result = await guard(); check(); if (result === false) throw failure(); };
        if (signal?.aborted) onAbort();
        return await Promise.race([(async () => {
            await guarded();
            const provided = new Headers(typeof headers === 'function' ? await headers() : headers);
            check();
            const requestHeaders = { 'Content-Type': 'application/json', Accept: 'application/json' };
            if (provided.has('x-csrf-token')) requestHeaders['X-CSRF-Token'] = provided.get('x-csrf-token');
            const { target, rows } = captured;
            const request = { file: `${target.chatId}.jsonl`, format: 'jsonl', is_group: target.kind === 'group' };
            if (target.kind === 'character') request.avatar_url = target.avatar;
            await guarded();
            const response = await fetchImpl(endpoint, {
                method: 'POST', credentials: 'same-origin', cache: 'no-store', redirect: 'error',
                signal: controller.signal, headers: requestHeaders, body: JSON.stringify(request),
            });
            if (controller.signal.aborted || signal?.aborted) { cancelQuietly(response?.body); throw failure(); }
            const responseUrl = response?.url;
            const length = response?.headers?.get?.('content-length');
            if (!response?.ok || response.status !== 200 || response.redirected || ['opaque', 'opaqueredirect'].includes(response.type)
                || (responseUrl && responseUrl !== endpoint)
                || !/^application\/json(?:\s*;|$)/i.test(response.headers?.get?.('content-type') || '')
                || (length !== null && length !== undefined && (!/^\d+$/.test(length) || !Number.isSafeInteger(Number(length)) || Number(length) > RESPONSE_BYTES))) {
                cancelQuietly(response?.body); throw failure();
            }
            const reader = response.body?.getReader?.();
            if (!reader) throw failure();
            const cancelReader = () => cancelQuietly(reader);
            controller.signal.addEventListener('abort', cancelReader, { once: true });
            let text = '', bytes = 0;
            const decoder = new TextDecoder('utf-8', { fatal: true });
            try {
                while (true) {
                    check(); const part = await reader.read(); check();
                    if (part.done) break;
                    if (!(part.value instanceof Uint8Array)) throw failure();
                    bytes += part.value.byteLength;
                    if (bytes > RESPONSE_BYTES) throw failure();
                    text += decoder.decode(part.value, { stream: true });
                }
                text += decoder.decode();
            } finally {
                controller.signal.removeEventListener('abort', cancelReader);
                cancelReader();
                try { reader.releaseLock(); } catch (_) { /* A timed-out reader may still be settling. */ }
            }
            check();
            const envelope = parse(text, RESPONSE_BYTES);
            if (!object(envelope) || typeof envelope.result !== 'string' || !equal(exportedRows(envelope.result, rows.length), rows)) throw failure();
            await guarded();
            return Object.freeze({ status: 'confirmed' });
        })(), cancellation]);
    } catch (_) {
        // A read failure says nothing about whether the earlier host write ran.
        // Do not expose returned server text, original content or credentials.
        throw failure();
    } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        controller?.abort();
    }
}
