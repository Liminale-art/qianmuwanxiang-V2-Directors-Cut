import { assistantStorageRequest, assistantStorageResponse, assistantCatalogueRequest, assistantCatalogueResponse, ASSISTANT_CATALOGUE_LIMITS, ASSISTANT_STORAGE_LIMITS as LIMIT } from './qianmu-assistant-storage-contract.js';
import { proseAssistantAccountForNamespace } from './qianmu-prose-assistant-source.js';
import { parseBoundedJson } from './qianmu-json-input.js';

const stale = () => Object.assign(Error('场外特助盘点账户或页面已变化'), { code: 'prose_assistant_storage_stale' });
const unavailable = () => Error('ST 助手文件尚未盘点，请确认配套后端可用后刷新；未读取不代表零占用。');
const messages = Object.freeze({ assistant_storage_account: 'ST 登录账户已变化，请重新打开储存页面。', assistant_storage_changed: '助手文件在盘点期间变化或读取已停止，请刷新核对。',
    assistant_storage_capacity: '助手文件超过本次盘点范围，未将部分结果当成总量。', assistant_storage_missing: 'ST 助手目录或当前版本文件缺失，未按零占用处理。',
    assistant_storage_path: 'ST 助手文件路径或链接检查未通过，请保留原件。', assistant_storage_content: 'ST 助手文件入口校验失败，请保留原件。' });

// Read-only, fixed same-origin route. No chat/model/key, no automatic retries and
// no fallback to a different host. ST history saving does not depend on this API.
export const collectAssistantNativeStorage=options=>requestAssistantStorage(options);
export async function collectAssistantHistoryPage(options){
    const result=await requestAssistantStorage(options,true);
    if(result.status!=='ready')throw Object.assign(Error(result.error),{code:'assistant_history_catalogue_unavailable'});return result;
}
async function requestAssistantStorage({ resolveNamespace, isCurrent, headers, fetchImpl = globalThis.fetch, timeoutMs = 6000, signal, offset=0, snapshot=null } = {},catalogue=false) {
    const BASE='/api/plugins/qianmu-tts/assistant/'+(catalogue?'history-catalogue':'storage'),responseBytes=catalogue?ASSISTANT_CATALOGUE_LIMITS.responseBytes:LIMIT.responseBytes;
    if (typeof resolveNamespace !== 'function' || typeof isCurrent !== 'function' || typeof fetchImpl !== 'function') throw stale();
    const controller = new AbortController(); let namespace, timer, rejectStop, notice = '';
    const stopped = new Promise((_, reject) => { rejectStop = reject; });
    const abort = () => { controller.abort(); rejectStop(unavailable()); };
    signal?.addEventListener('abort', abort, { once: true });
    const alive = () => { if (isCurrent() !== true) throw stale(); if (controller.signal.aborted) throw unavailable(); };
    const guard = async () => { alive(); const value = await resolveNamespace(); alive(); if (typeof value !== 'string' || !/^st-user:.+/.test(value) || namespace !== undefined && value !== namespace) throw stale(); namespace = value; };
    const work = async () => {
        await guard(); const expectedAccount = await proseAssistantAccountForNamespace(namespace); await guard();
        const request = catalogue?assistantCatalogueRequest({version:1,expectedAccount,offset,snapshot}):assistantStorageRequest({ version: 1, expectedAccount }), provided = new Headers(await headers?.());
        const requestHeaders = { Accept: 'application/json', 'Content-Type': 'application/json' };
        if (provided.has('x-csrf-token')) requestHeaders['X-CSRF-Token'] = provided.get('x-csrf-token'); await guard();
        let response, reader, cancel;
        try {
            response = await fetchImpl(BASE, { method: 'POST', credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: controller.signal, headers: requestHeaders, body: JSON.stringify(request) });
            await guard();
            if (response.redirected || response.type === 'opaqueredirect' || response.status >= 300 && response.status < 400) throw unavailable();
            if (response.url) {
                const url = new URL(response.url);
                if (!['http:', 'https:'].includes(url.protocol) || url.pathname !== BASE || url.search || url.hash || url.username || url.password
                    || globalThis.location?.origin && url.origin !== globalThis.location.origin) throw unavailable();
            }
            if ([401, 403].includes(response.status)) throw stale();
            if (!/^application\/json\b/i.test(response.headers?.get?.('content-type') || '') || Number(response.headers.get('content-length')) > responseBytes) {
                if (response.status === 404) notice = '配套后端尚未提供助手文件盘点，请更新后端；日常助手保存不受影响。'; throw unavailable();
            }
            reader = response.body?.getReader?.(); if (!reader) throw unavailable();
            cancel = () => { void reader.cancel().catch(() => {}); }; controller.signal.addEventListener('abort', cancel, { once: true });
            let text = '', bytes = 0; const decoder = new TextDecoder('utf-8', { fatal: true });
            while (true) { const part = await reader.read(); await guard(); if (part.done) break; bytes += part.value.byteLength; if (bytes > responseBytes) throw unavailable(); text += decoder.decode(part.value, { stream: true }); }
            text += decoder.decode(); const value = parseBoundedJson(text, { maxBytes: responseBytes, maxDepth: 5, maxNodes: catalogue?240:80, label: '助手文件盘点' });
            if (!response.ok || value?.ok !== true) { notice = Object.hasOwn(messages, value?.code) ? messages[value.code] : ''; throw unavailable(); }
            const result = catalogue?assistantCatalogueResponse(value,request):assistantStorageResponse(value, expectedAccount); await guard(); return Object.freeze({ namespace, status: 'ready', ...result });
        } finally {
            if (reader) { controller.signal.removeEventListener('abort', cancel); cancel(); try { reader.releaseLock(); } catch {} }
            else try { void response?.body?.cancel?.().catch(() => {}); } catch {}
        }
    };
    if (signal?.aborted) abort();
    timer = setTimeout(abort, Number.isFinite(timeoutMs) ? Math.max(100, Math.min(30000, timeoutMs)) : 6000);
    try { return await Promise.race([work(), stopped]); }
    catch (error) {
        if (isCurrent() !== true || error?.code === 'prose_assistant_storage_stale') throw stale();
        return Object.freeze({ namespace, status: 'unavailable', bytes: null, files: null,
            error: notice || unavailable().message });
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); controller.abort(); }
}
