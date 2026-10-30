// Account-scoped ST settings only. Never put connection secrets in a memory document or backup.
import { summaryRequestBudget } from './budget.mjs';
import { normalizeVector, rankVectorCandidates } from './vector-contract.mjs';

const DEFAULTS = Object.freeze({ mode: 'inherit', apiUrl: '', apiKey: '', model: '', models: [], profileId: '', profileModel: '', profileConfigured: false, qianmuPresetId: '',
    temperature: 1, maxTokens: 32000, contextTokens: 1000000, stream: false, presets: [], selectedPreset: '', revision: 0 });
const VECTOR_DEFAULTS = Object.freeze({ apiUrl: '', apiKey: '', model: '', presets: [], selectedPreset: '', revision: 0 });
const RERANK_DEFAULTS = Object.freeze({ apiUrl: '', apiKey: '', model: '', topN: 6, presets: [], selectedPreset: '', revision: 0 });
const DEFAULT_RETRIEVAL_TIMEOUT_MS = 15000;
const MIN_RETRIEVAL_TIMEOUT_SECONDS = 5;
const MAX_RETRIEVAL_TIMEOUT_SECONDS = 60;
const FIELDS = ['apiUrl', 'apiKey', 'model', 'temperature', 'maxTokens', 'contextTokens', 'stream'];
const CONNECTION_FIELDS = ['mode', ...FIELDS, 'profileId', 'profileModel', 'profileConfigured', 'qianmuPresetId'];
const VECTOR_FIELDS = ['apiUrl', 'apiKey', 'model'];
const RERANK_FIELDS = ['apiUrl', 'apiKey', 'model', 'topN'];
const clone = value => structuredClone(value);
const text = value => typeof value === 'string' ? value.trim() : '';
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const fail = message => { throw new Error(message); };
const aborted = signal => { if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('忆幕任务已取消'); };

function vectorRoot(value) {
    const input = text(value);
    if (!input) fail('请填写向量 API URL');
    let url;
    try { url = new URL(input); } catch { fail('向量 API URL 格式无效'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) fail('向量 API URL 需为 HTTP 或 HTTPS 地址，不包含密码、查询参数或片段');
    url.pathname = url.pathname.replace(/\/embeddings\/?$/i, '').replace(/\/+$/, '');
    return url.toString().replace(/\/+$/, '');
}

function validateVector(patch) {
    if (!object(patch)) fail('向量连接设置无效');
    const out = {};
    for (const [key, value] of Object.entries(patch)) {
        if (!VECTOR_FIELDS.includes(key)) fail('未知的向量连接设置');
        if (key === 'apiUrl') out[key] = value === '' ? '' : vectorRoot(value);
        else if (typeof value !== 'string' || value.length > (key === 'apiKey' ? 8192 : 2048) || /[\r\n\x00]/.test(value)) fail('向量连接内容无效');
        else out[key] = value.trim();
    }
    return out;
}

function presetName(value) {
    const name = text(value);
    if (!name || name.length > 120) fail('请输入 1—120 字的预设名称');
    return name;
}

function providerPresets(raw, fields, validate) {
    if (!Array.isArray(raw)) return [];
    return raw.map(item => {
        if (!object(item) || !text(item.id) || !text(item.name)) return null;
        try {
            const values = validate(Object.fromEntries(fields.map(key => [key, item[key]]).filter(([, value]) => value !== undefined)));
            return { id: text(item.id), name: text(item.name), ...values };
        } catch { return null; }
    }).filter(Boolean);
}

function savedVector(ctx) {
    const raw = ctx?.extensionSettings?.yimu?.vector;
    if (!object(raw)) return clone(VECTOR_DEFAULTS);
    const result = { ...clone(VECTOR_DEFAULTS), ...validateVector(Object.fromEntries(Object.entries(raw).filter(([key]) => VECTOR_FIELDS.includes(key)))) };
    result.presets = providerPresets(raw.presets, VECTOR_FIELDS, validateVector);
    result.selectedPreset = result.presets.some(item => item.id === raw.selectedPreset) ? text(raw.selectedPreset) : '';
    result.revision = Number.isSafeInteger(raw.revision) && raw.revision >= 0 ? raw.revision : 0;
    return result;
}

function rerankRoot(value) {
    const input = text(value);
    if (!input) fail('请填写重排 API URL');
    let url;
    try { url = new URL(input); } catch { fail('重排 API URL 格式无效'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) fail('重排 API URL 需为 HTTP 或 HTTPS 地址，不包含密码、查询参数或片段');
    url.pathname = url.pathname.replace(/\/(?:rerank|reranking)\/?$/i, '').replace(/\/+$/, '');
    return url.toString().replace(/\/+$/, '');
}

function validateRerank(patch) {
    if (!object(patch)) fail('重排连接设置无效');
    const out = {};
    for (const [key, value] of Object.entries(patch)) {
        if (!RERANK_FIELDS.includes(key)) fail('未知的重排连接设置');
        if (key === 'apiUrl') out[key] = value === '' ? '' : rerankRoot(value);
        else if (key === 'topN') { if (!Number.isSafeInteger(value) || value < 1 || value > 64) fail('重排保留数须在 1—64 之间'); out[key] = value; }
        else if (typeof value !== 'string' || value.length > (key === 'apiKey' ? 8192 : 2048) || /[\r\n\x00]/.test(value)) fail('重排连接内容无效');
        else out[key] = value.trim();
    }
    return out;
}

function savedRerank(ctx) {
    const raw = ctx?.extensionSettings?.yimu?.rerank;
    if (!object(raw)) return clone(RERANK_DEFAULTS);
    const result = { ...clone(RERANK_DEFAULTS), ...validateRerank(Object.fromEntries(Object.entries(raw).filter(([key]) => RERANK_FIELDS.includes(key)))) };
    result.presets = providerPresets(raw.presets, RERANK_FIELDS, validateRerank);
    result.selectedPreset = result.presets.some(item => item.id === raw.selectedPreset) ? text(raw.selectedPreset) : '';
    result.revision = Number.isSafeInteger(raw.revision) && raw.revision >= 0 ? raw.revision : 0;
    return result;
}

function savedRetrievalTimeout(ctx) {
    const raw = ctx?.extensionSettings?.yimu?.retrievalTimeoutMs;
    const ms = Number.isSafeInteger(raw) && raw >= MIN_RETRIEVAL_TIMEOUT_SECONDS * 1000 && raw <= MAX_RETRIEVAL_TIMEOUT_SECONDS * 1000
        ? raw : DEFAULT_RETRIEVAL_TIMEOUT_MS;
    const revision = Number.isSafeInteger(ctx?.extensionSettings?.yimu?.retrievalTimeoutRevision)
        && ctx.extensionSettings.yimu.retrievalTimeoutRevision >= 0 ? ctx.extensionSettings.yimu.retrievalTimeoutRevision : 0;
    return { ms, seconds: ms / 1000, revision };
}

function validateRetrievalTimeout(value) {
    const seconds = value === '' || value === undefined || value === null ? DEFAULT_RETRIEVAL_TIMEOUT_MS / 1000 : Number(value);
    if (!Number.isSafeInteger(seconds) || seconds < MIN_RETRIEVAL_TIMEOUT_SECONDS || seconds > MAX_RETRIEVAL_TIMEOUT_SECONDS) {
        fail(`候选请求超时时间须在 ${MIN_RETRIEVAL_TIMEOUT_SECONDS}—${MAX_RETRIEVAL_TIMEOUT_SECONDS} 秒之间`);
    }
    return seconds * 1000;
}

export function apiRoot(value) {
    const input = text(value);
    if (!input) fail('请填写 API URL');
    let url;
    try { url = new URL(input); } catch { fail('API URL 格式无效'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) fail('API URL 需为 HTTP 或 HTTPS 地址，不包含密码、查询参数或片段');
    url.pathname = url.pathname.replace(/\/(?:chat\/completions|models)\/?$/, '').replace(/\/+$/, '');
    return url.toString().replace(/\/+$/, '');
}

function validate(patch) {
    if (!object(patch)) fail('连接设置无效');
    const out = {};
    for (const [key, value] of Object.entries(patch)) {
        if (!CONNECTION_FIELDS.includes(key)) fail('未知的连接设置');
        if (key === 'mode') { if (!['inherit', 'st', 'profile', 'qianmu', 'external'].includes(value)) fail('连接方式无效'); }
        else if (key === 'stream' || key === 'profileConfigured') { if (typeof value !== 'boolean') fail('连接开关设置无效'); }
        else if (key === 'temperature') { if (!Number.isFinite(value) || value < 0 || value > 2) fail('温度须在 0—2 之间'); }
        else if (key === 'maxTokens' || key === 'contextTokens') {
            if (!Number.isSafeInteger(value) || value < (key === 'contextTokens' ? 256 : 1) || value > 10000000) fail('Token 数值超出范围');
        } else if (typeof value !== 'string' || value.length > (key === 'apiKey' ? 8192 : 2048) || /[\r\n\x00]/.test(value)) fail('连接内容无效');
        out[key] = typeof value === 'string' ? value.trim() : value;
    }
    return out;
}

function savedConfig(ctx) {
    const raw = ctx?.extensionSettings?.yimu?.api;
    if (!object(raw)) return clone(DEFAULTS);
    const settings = { ...clone(DEFAULTS), ...validate(Object.fromEntries(Object.entries(raw).filter(([key]) => CONNECTION_FIELDS.includes(key)))) };
    settings.models = Array.isArray(raw.models) ? [...new Set(raw.models.filter(value => typeof value === 'string' && value.length <= 2048))] : [];
    settings.presets = Array.isArray(raw.presets) ? raw.presets.filter(p => object(p) && text(p.id) && text(p.name)).map(p => ({
        id: text(p.id), name: text(p.name), ...validate(Object.fromEntries(FIELDS.filter(key => p[key] !== undefined).map(key => [key, p[key]]))),
    })) : [];
    settings.selectedPreset = text(raw.selectedPreset);
    settings.revision = Number.isSafeInteger(raw.revision) && raw.revision >= 0 ? raw.revision : 0;
    return settings;
}

function errorText(error, config) {
    let message = typeof error === 'string' ? error : error?.message || '连接请求失败';
    for (const secret of [config.apiKey, config.apiUrl].filter(Boolean)) message = String(message).split(secret).join('[已隐藏]');
    return String(message).replace(/Bearer\s+\S+/gi, 'Bearer [已隐藏]').slice(0, 240);
}

async function completion(response, config, signal, onChunk) {
    const readContent = content => typeof content === 'string' ? content : Array.isArray(content)
        ? content.filter(part => part?.type === 'text' && typeof part.text === 'string').map(part => part.text).join('') : '';
    const check = json => { if (json?.error) fail(errorText(json.error, config)); };
    if (!String(response.headers?.get?.('content-type') || '').includes('text/event-stream')) {
        const json = await response.json(); check(json);
        const reason = json?.choices?.[0]?.finish_reason;
        if (reason === 'length' || reason === 'max_tokens') fail('整理结果达到输出上限，未保存；请提高最大输出或缩小整理范围');
        if (reason && !['stop', 'end_turn'].includes(reason)) fail('服务未完整结束整理，结果未保存');
        const result = readContent(json?.choices?.[0]?.message?.content ?? json?.content);
        if (result) onChunk?.(result, result);
        return result;
    }
    const reader = response.body?.getReader?.();
    if (!reader) fail('当前浏览器无法读取流式结果');
    const decoder = new TextDecoder(); let pending = '', output = '', complete = false, finish = '';
    const consume = block => {
        const data = block.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
        if (!data) return;
        if (data.trim() === '[DONE]') { complete = true; return; }
        let json; try { json = JSON.parse(data); } catch { fail('流式结果格式不完整，未保存'); }
        check(json);
        const choice = json?.choices?.[0];
        const delta = readContent(choice?.delta?.content ?? choice?.message?.content);
        output += delta;
        if (delta) onChunk?.(delta, output);
        if (choice?.finish_reason) finish = choice.finish_reason;
    };
    try {
        while (!complete) {
            aborted(signal); const chunk = await reader.read();
            pending += decoder.decode(chunk.value || new Uint8Array(), { stream: !chunk.done }).replace(/\r\n/g, '\n');
            let boundary;
            while ((boundary = pending.indexOf('\n\n')) >= 0) { consume(pending.slice(0, boundary)); pending = pending.slice(boundary + 2); }
            if (chunk.done) { if (pending.trim()) consume(pending); break; }
        }
        aborted(signal);
        if (finish === 'length' || finish === 'max_tokens') fail('整理结果达到输出上限，未保存；请提高最大输出或缩小整理范围');
        if (finish && !['stop', 'end_turn'].includes(finish)) fail('服务未完整结束整理，结果未保存');
        if (!complete && !['stop', 'end_turn'].includes(finish)) fail('连接提前结束，整理结果未完整确认');
        return output;
    } finally { try { await reader.cancel(); } catch {} reader.releaseLock?.(); }
}

export function createApiSettings({ getContext = () => globalThis.SillyTavern?.getContext?.(), fetchImpl = (...args) => globalThis.fetch(...args),
    createId = () => globalThis.crypto.randomUUID(), statusTimeoutMs = 20000, retrievalTimeoutMs = undefined } = {}) {
    const fixedCandidateTimeout = Number.isFinite(retrievalTimeoutMs) ? Math.max(1, Math.trunc(retrievalTimeoutMs)) : null;
    const listeners = new Set(); let saving = Promise.resolve();
    const context = () => getContext() || fail('ST 尚未准备好连接设置');
    const read = () => savedConfig(context());
    const vectorRead = () => savedVector(context());
    const rerankRead = () => savedRerank(context());
    const retrievalTimeoutRead = () => savedRetrievalTimeout(context());
    // Same account-owned apiProfiles used by the companion dialog. Never copy its credentials into yimu settings.
    const qianmuOwner = () => context().extensionSettings?.story_director_liminale;
    const qianmuProfiles = () => (Array.isArray(qianmuOwner()?.apiProfiles) ? qianmuOwner().apiProfiles : [])
        .filter(profile => object(profile) && text(profile.id)).map(profile => ({ id: text(profile.id), name: text(profile.name), model: text(profile.model) }));
    const livePreset = id => {
        const owner = qianmuOwner(), profile = (Array.isArray(owner?.apiProfiles) ? owner.apiProfiles : []).find(item => text(item?.id) === id);
        if (!profile) fail('所选千幕 API 预设已不存在，请重新选择');
        if (!text(profile.apiUrl) || !text(profile.model)) fail('所选千幕 API 预设缺少地址或模型，请在千幕中完善');
        return { owner, profile };
    };
    let presetSerial = 0;
    const presetTickets = new Map();
    const presetSignature = profile => JSON.stringify([profile.id, profile.apiUrl, profile.apiKey, profile.model, profile.temperature]);
    const notify = () => { for (const listener of listeners) { try { listener(); } catch {} } };
    const commit = transform => {
        const pending = saving.catch(() => {}).then(async () => {
            const ctx = context();
            if (!object(ctx.extensionSettings) || typeof ctx.saveSettingsDebounced !== 'function') fail('当前 ST 无法保存连接设置');
            const before = ctx.extensionSettings.yimu;
            const previous = object(before) ? before : {};
            const current = savedConfig(ctx), next = transform(current);
            if (!next) return read();
            // Model discovery and saving a preset do not change the active connection.
            next.revision = current.revision + Number(CONNECTION_FIELDS.some(key => next[key] !== current[key]));
            const owned = { ...previous, api: next }; ctx.extensionSettings.yimu = owned;
            try { await ctx.saveSettingsDebounced(); }
            catch { if (ctx.extensionSettings.yimu === owned) ctx.extensionSettings.yimu = before; fail('连接设置未保存，请重试'); }
            notify(); return read();
        });
        saving = pending; return pending;
    };
    const commitVector = transform => {
        const pending = saving.catch(() => {}).then(async () => {
            const ctx = context();
            if (!object(ctx.extensionSettings) || typeof ctx.saveSettingsDebounced !== 'function') fail('当前 ST 无法保存向量设置');
            const before = ctx.extensionSettings.yimu;
            const previous = object(before) ? before : {};
            const current = savedVector(ctx), next = transform(current);
            if (!next) return vectorRead();
            next.revision = current.revision + Number(VECTOR_FIELDS.some(key => next[key] !== current[key]));
            const owned = { ...previous, vector: next }; ctx.extensionSettings.yimu = owned;
            try { await ctx.saveSettingsDebounced(); }
            catch { if (ctx.extensionSettings.yimu === owned) ctx.extensionSettings.yimu = before; fail('向量设置未保存，请重试'); }
            notify(); return vectorRead();
        });
        saving = pending; return pending;
    };
    const commitRerank = transform => {
        const pending = saving.catch(() => {}).then(async () => {
            const ctx = context();
            if (!object(ctx.extensionSettings) || typeof ctx.saveSettingsDebounced !== 'function') fail('当前 ST 无法保存重排设置');
            const before = ctx.extensionSettings.yimu;
            const previous = object(before) ? before : {};
            const current = savedRerank(ctx), next = transform(current);
            if (!next) return rerankRead();
            next.revision = current.revision + Number(RERANK_FIELDS.some(key => next[key] !== current[key]));
            const owned = { ...previous, rerank: next }; ctx.extensionSettings.yimu = owned;
            try { await ctx.saveSettingsDebounced(); }
            catch { if (ctx.extensionSettings.yimu === owned) ctx.extensionSettings.yimu = before; fail('重排设置未保存，请重试'); }
            notify(); return rerankRead();
        });
        saving = pending; return pending;
    };
    const updateRetrievalTimeout = value => {
        const milliseconds = validateRetrievalTimeout(value);
        const pending = saving.catch(() => {}).then(async () => {
            const ctx = context();
            if (!object(ctx.extensionSettings) || typeof ctx.saveSettingsDebounced !== 'function') fail('当前 ST 无法保存候选请求设置');
            const before = ctx.extensionSettings.yimu;
            const previous = object(before) ? before : {};
            const current = savedRetrievalTimeout(ctx);
            if (current.ms === milliseconds) return retrievalTimeoutRead();
            const owned = { ...previous, retrievalTimeoutMs: milliseconds, retrievalTimeoutRevision: current.revision + 1 };
            ctx.extensionSettings.yimu = owned;
            try { await ctx.saveSettingsDebounced(); }
            catch { if (ctx.extensionSettings.yimu === owned) ctx.extensionSettings.yimu = before; fail('候选请求设置未保存，请重试'); }
            notify(); return retrievalTimeoutRead();
        });
        saving = pending; return pending;
    };
    const update = patch => { const values = validate(patch); return commit(current => ({ ...current, ...values, selectedPreset: '' })); };
    function effectiveConnection(legacy = {}) {
        const config = read(), ctx = context();
        if (config.mode === 'external') return { mode: 'external', profileId: '', model: config.model,
            contextTokens: config.contextTokens, maxTokens: config.maxTokens, revision: config.revision };
        if (config.mode === 'qianmu') {
            if (!config.qianmuPresetId) fail('请选择千幕 API 预设');
            const live = livePreset(config.qianmuPresetId), ticket = ++presetSerial;
            presetTickets.set(ticket, { owner: live.owner, signature: presetSignature(live.profile), id: config.qianmuPresetId });
            if (presetTickets.size > 32) presetTickets.delete(presetTickets.keys().next().value);
            return { mode: 'qianmu', qianmuPresetId: config.qianmuPresetId, model: text(live.profile.model),
                contextTokens: config.contextTokens, maxTokens: config.maxTokens, revision: config.revision, presetTicket: ticket };
        }
        if (config.mode === 'profile' || config.mode === 'inherit' && text(legacy.profileId)) return { mode: 'profile',
            profileId: config.mode === 'profile' && config.profileConfigured ? config.profileId : text(legacy.profileId),
            model: config.mode === 'profile' && config.profileConfigured ? config.profileModel : text(legacy.model),
            contextTokens: 0, maxTokens: 2048, revision: config.revision };
        return { mode: 'st', profileId: '', model: config.mode === 'inherit' ? text(legacy.model) : '',
            contextTokens: Number(ctx.mainApi === 'openai' ? ctx.chatCompletionSettings?.openai_max_context : ctx.maxContext) || 0,
            maxTokens: Number(ctx.chatCompletionSettings?.openai_max_tokens) || 2048, revision: config.revision };
    }
    const assertCurrent = connection => {
        if (connection && read().revision !== connection.revision) fail('整理连接已变化，本次结果未采用');
        if (connection?.mode === 'qianmu') {
            const expected = presetTickets.get(connection.presetTicket), config = read();
            if (!expected || config.mode !== 'qianmu' || config.qianmuPresetId !== expected.id) fail('千幕 API 预设已变化，本次结果未采用');
            const live = livePreset(expected.id);
            if (expected.owner !== live.owner || expected.signature !== presetSignature(live.profile)) fail('千幕 API 预设已变化，本次结果未采用');
        }
    };
    async function request(path, config, body, signal) {
        aborted(signal);
        // Explicit empty Authorization prevents ST's active custom key leaking to a keyless local endpoint.
        const auth = config.apiKey ? /^Bearer\s/i.test(config.apiKey) ? config.apiKey : `Bearer ${config.apiKey}` : '';
        const response = await fetchImpl(path, { method: 'POST', cache: 'no-store', signal,
            headers: { ...context().getRequestHeaders?.(), 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_completion_source: 'custom', custom_url: apiRoot(config.apiUrl),
                custom_include_headers: JSON.stringify({ Authorization: auth }), custom_include_body: '', custom_exclude_body: '', ...body }) });
        aborted(signal);
        if (!response.ok) fail(`连接请求失败（HTTP ${response.status}）`);
        return response;
    }
    async function models(config, signal) {
        aborted(signal);
        const controller = new AbortController(), cancel = () => controller.abort(signal.reason);
        signal?.addEventListener('abort', cancel, { once: true });
        const timer = setTimeout(() => controller.abort(new Error('连接请求超时，请检查地址与服务状态')), statusTimeoutMs);
        try {
            const response = await request('/api/backends/chat-completions/status', config, {}, controller.signal);
            const json = await response.json(); aborted(controller.signal);
            if (json?.error) fail(errorText(json.error, config));
            const list = Array.isArray(json) ? json : json?.data ?? json?.models;
            if (!Array.isArray(list)) fail('连接未返回可用的模型列表');
            return [...new Set(list.map(item => typeof item === 'string' ? item : item?.id || item?.name).filter(item => typeof item === 'string' && item.trim() && item.length <= 2048))];
        } catch (error) {
            if (controller.signal.aborted) throw new Error(errorText(controller.signal.reason, config));
            throw new Error(errorText(error, config));
        } finally { clearTimeout(timer); signal?.removeEventListener('abort', cancel); }
    }
    async function fetchModels({ signal } = {}) {
        await saving.catch(() => {}); const config = read();
        const list = await models(config, signal);
        await commit(current => {
            if (current.apiUrl !== config.apiUrl || current.apiKey !== config.apiKey) fail('连接已变化，请重新拉取模型');
            return { ...current, models: list };
        });
        return list;
    }
    async function testConnection({ signal } = {}) {
        await saving.catch(() => {}); const config = read();
        await models(config, signal);
        if (read().apiUrl !== config.apiUrl || read().apiKey !== config.apiKey) fail('连接已变化，请重新测试');
        return { ok: true, scope: 'model-list' };
    }
    async function generate(prompt, { connection, signal, systemPrompt = '', maxTokens, onChunk } = {}) {
        await saving.catch(() => {}); let config = read();
        connection ||= config.mode === 'qianmu' ? effectiveConnection() : { revision: config.revision };
        assertCurrent(connection);
        if (!['external', 'qianmu'].includes(config.mode)) fail('当前未选择独立连接或千幕 API 预设');
        if (config.mode === 'qianmu') {
            const { profile } = livePreset(config.qianmuPresetId);
            config = { ...config, apiUrl: text(profile.apiUrl), apiKey: text(profile.apiKey), model: text(profile.model),
                temperature: Number.isFinite(profile.temperature) ? profile.temperature : DEFAULTS.temperature };
        }
        if (!text(config.model)) fail('请选择或填写整理模型');
        if (!text(prompt)) fail('没有可整理的聊天原文');
        const outputTokens = maxTokens === undefined ? config.maxTokens : Math.min(config.maxTokens, maxTokens);
        if (!Number.isSafeInteger(outputTokens) || outputTokens < 1) fail('整理输出长度无效');
        const messages = [{ role: 'system', content: String(systemPrompt) }, { role: 'user', content: prompt }];
        if (summaryRequestBudget(prompt, systemPrompt) + outputTokens > config.contextTokens) fail('整理内容超出此连接的上下文容量，请缩小整理范围或提高上下文 Token 数');
        try {
            const response = await request('/api/backends/chat-completions/generate', config,
                { model: config.model, messages, temperature: config.temperature, max_tokens: outputTokens, stream: config.stream }, signal);
            const result = await completion(response, config, signal, onChunk); aborted(signal); assertCurrent(connection || { revision: config.revision });
            if (!result.trim()) fail('忆幕没有收到可用的整理结果');
            return result;
        } catch (error) { aborted(signal); throw new Error(errorText(error, config)); }
    }
    function savePreset(name) {
        const label = text(name); if (!label || label.length > 120) return Promise.reject(new Error('请输入 1—120 字的预设名称'));
        return commit(current => {
            const existing = current.presets.find(preset => preset.name === label), id = existing?.id || createId();
            const preset = { id, name: label, ...Object.fromEntries(FIELDS.map(key => [key, current[key]])) };
            return { ...current, selectedPreset: id, presets: [...current.presets.filter(item => item.id !== id), preset] };
        });
    }
    const loadPreset = id => commit(current => {
        const preset = current.presets.find(item => item.id === id); if (!preset) fail('该连接预设已不存在');
        return { ...current, ...Object.fromEntries(FIELDS.map(key => [key, preset[key] ?? DEFAULTS[key]])), mode: 'external', selectedPreset: id, models: [] };
    });
    const deletePreset = id => commit(current => ({ ...current, presets: current.presets.filter(item => item.id !== id), selectedPreset: current.selectedPreset === id ? '' : current.selectedPreset }));
    const updateVector = patch => { const values = validateVector(patch); return commitVector(current => ({ ...current, ...values, selectedPreset: '' })); };
    const updateRerank = patch => { const values = validateRerank(patch); return commitRerank(current => ({ ...current, ...values, selectedPreset: '' })); };
    const saveVectorPreset = name => {
        const label = presetName(name);
        return commitVector(current => {
            const existing = current.presets.find(item => item.name === label), id = existing?.id || createId();
            const preset = { id, name: label, ...Object.fromEntries(VECTOR_FIELDS.map(key => [key, current[key]])) };
            return { ...current, selectedPreset: id, presets: [...current.presets.filter(item => item.id !== id), preset] };
        });
    };
    const loadVectorPreset = id => commitVector(current => {
        const preset = current.presets.find(item => item.id === id); if (!preset) fail('该向量预设已不存在');
        return { ...current, ...Object.fromEntries(VECTOR_FIELDS.map(key => [key, preset[key] ?? ''])), selectedPreset: id };
    });
    const deleteVectorPreset = id => commitVector(current => ({ ...current, presets: current.presets.filter(item => item.id !== id), selectedPreset: current.selectedPreset === id ? '' : current.selectedPreset }));
    const saveRerankPreset = name => {
        const label = presetName(name);
        return commitRerank(current => {
            const existing = current.presets.find(item => item.name === label), id = existing?.id || createId();
            const preset = { id, name: label, ...Object.fromEntries(RERANK_FIELDS.map(key => [key, current[key]])) };
            return { ...current, selectedPreset: id, presets: [...current.presets.filter(item => item.id !== id), preset] };
        });
    };
    const loadRerankPreset = id => commitRerank(current => {
        const preset = current.presets.find(item => item.id === id); if (!preset) fail('该重排预设已不存在');
        return { ...current, ...Object.fromEntries(RERANK_FIELDS.map(key => [key, preset[key] ?? (key === 'topN' ? RERANK_DEFAULTS.topN : '')])), selectedPreset: id };
    });
    const deleteRerankPreset = id => commitRerank(current => ({ ...current, presets: current.presets.filter(item => item.id !== id), selectedPreset: current.selectedPreset === id ? '' : current.selectedPreset }));
    const vectorEndpoint = config => {
        const root = vectorRoot(config.apiUrl);
        return /\/v1$/i.test(root) ? `${root}/embeddings` : `${root}/v1/embeddings`;
    };
    const providerAuth = config => config.apiKey ? /^Bearer\s/i.test(config.apiKey) ? config.apiKey : `Bearer ${config.apiKey}` : '';
    const providerRequest = async (kind, config, { method = 'POST', body, signal } = {}) => {
        const endpoint = kind === 'vector' ? vectorEndpoint(config) : rerankEndpoint(config);
        const controller = new AbortController();
        let timedOut = false;
        const timer = setTimeout(() => { timedOut = true; controller.abort(new Error('连接请求超时，请检查地址与服务状态')); }, statusTimeoutMs);
        const relay = () => controller.abort(signal?.reason instanceof Error ? signal.reason : new Error('忆幕任务已取消'));
        if (signal?.aborted) relay(); else signal?.addEventListener('abort', relay, { once: true });
        const auth = providerAuth(config);
        const call = authorization => fetchImpl(endpoint, { method, cache: 'no-store', signal: controller.signal,
            headers: { 'Content-Type': 'application/json', ...(authorization ? { Authorization: authorization } : {}) },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
        try {
            let response = await call(auth);
            if (!response.ok && (response.status === 401 || response.status === 403) && config.apiKey && auth !== config.apiKey) response = await call(config.apiKey);
            aborted(signal);
            if (!response.ok) fail(errorText(new Error(`连接请求失败（HTTP ${response.status}）`), config));
            return response;
        } catch (error) {
            aborted(signal);
            if (timedOut) fail(errorText(new Error('连接请求超时，请检查地址与服务状态'), config));
            throw new Error(errorText(error, config));
        } finally {
            clearTimeout(timer); signal?.removeEventListener('abort', relay);
        }
    };
    const providerModelList = json => {
        const list = Array.isArray(json) ? json : json?.data ?? json?.models;
        if (!Array.isArray(list)) fail('连接未返回可用的模型列表');
        return [...new Set(list.map(item => typeof item === 'string' ? item : item?.id || item?.name)
            .filter(item => typeof item === 'string' && item.trim() && item.length <= 2048))];
    };
    async function fetchProviderModels(kind, { signal } = {}) {
        const config = kind === 'vector' ? vectorRead() : rerankRead();
        if (!config.apiUrl) fail(kind === 'vector' ? '请填写向量 API URL' : '请填写重排 API URL');
        const root = kind === 'vector' ? vectorRoot(config.apiUrl) : rerankRoot(config.apiUrl);
        const controller = new AbortController(); let timedOut = false;
        const timer = setTimeout(() => { timedOut = true; controller.abort(new Error('连接请求超时，请检查地址与服务状态')); }, statusTimeoutMs);
        const relay = () => controller.abort(signal?.reason instanceof Error ? signal.reason : new Error('忆幕任务已取消'));
        if (signal?.aborted) relay(); else signal?.addEventListener('abort', relay, { once: true });
        const auth = providerAuth(config);
        try {
            const call = authorization => fetchImpl(`${root}/models`, { method: 'GET', cache: 'no-store', signal: controller.signal,
                headers: { ...(authorization ? { Authorization: authorization } : {}) } });
            let response = await call(auth);
            if (!response.ok && (response.status === 401 || response.status === 403) && config.apiKey && auth !== config.apiKey) response = await call(config.apiKey);
            aborted(signal);
            if (!response.ok) fail(errorText(new Error(`模型列表请求失败（HTTP ${response.status}）`), config));
            return providerModelList(await response.json());
        } catch (error) {
            aborted(signal);
            if (timedOut) fail(errorText(new Error('连接请求超时，请检查地址与服务状态'), config));
            throw new Error(errorText(error, config));
        } finally { clearTimeout(timer); signal?.removeEventListener('abort', relay); }
    }
    async function testProviderConnection(kind, { signal } = {}) {
        const config = kind === 'vector' ? vectorRead() : rerankRead();
        if (!config.apiUrl) fail(kind === 'vector' ? '请填写向量 API URL' : '请填写重排 API URL');
        if (!config.model) fail(kind === 'vector' ? '请填写向量模型' : '请填写重排模型');
        const body = kind === 'vector'
            ? { model: config.model, input: ['忆幕连接测试'] }
            : { model: config.model, query: '忆幕连接测试', documents: ['忆幕连接测试'], top_n: 1 };
        await providerRequest(kind, config, { body, signal });
        return { ok: true, provider: kind };
    }
    const fetchVectorModels = options => fetchProviderModels('vector', options);
    const fetchRerankModels = options => fetchProviderModels('rerank', options);
    const testVectorConnection = options => testProviderConnection('vector', options);
    const testRerankConnection = options => testProviderConnection('rerank', options);
    async function vectorCandidates({ query = '', candidates = [], limit = 6, signal } = {}) {
        const config = vectorRead();
        const safeQuery = text(query);
        const safeCandidates = (Array.isArray(candidates) ? candidates : []).filter(candidate => candidate?.id && text(candidate.text)).slice(0, 64).map(candidate => ({
            id: String(candidate.id), text: text(candidate.text).slice(0, 20000), title: text(candidate.title), start: candidate.start, end: candidate.end,
        }));
        if (!safeQuery || !safeCandidates.length) return [];
        if (!config.apiUrl || !config.model) return [];
        const auth = config.apiKey ? /^Bearer\s/i.test(config.apiKey) ? config.apiKey : `Bearer ${config.apiKey}` : '';
        const scope = requestScope(signal, '向量候选请求超时，已回退关键词召回');
        try {
            const call = authorization => fetchImpl(vectorEndpoint(config), { method: 'POST', cache: 'no-store', signal: scope.signal,
                headers: { 'Content-Type': 'application/json', ...(authorization ? { Authorization: authorization } : {}) },
                body: JSON.stringify({ model: config.model, input: [safeQuery, ...safeCandidates.map(candidate => candidate.text)] }) });
            let response = await call(auth);
            if (!response.ok && (response.status === 401 || response.status === 403) && config.apiKey && auth !== config.apiKey) response = await call(config.apiKey);
            aborted(signal);
            if (!response.ok) fail(errorText(new Error(`向量接口请求失败（HTTP ${response.status}）`), config));
            let json; try { json = await response.json(); } catch { fail('向量接口返回格式无效'); }
            const data = Array.isArray(json?.data) ? json.data : [];
            const vectors = new Array(safeCandidates.length + 1);
            data.forEach((item, index) => { const target = Number.isSafeInteger(item?.index) ? item.index : index; vectors[target] = item?.embedding; });
            const queryVector = normalizeVector(vectors[0]);
            if (!queryVector) fail('向量接口未返回有效查询向量');
            const ranked = rankVectorCandidates(safeCandidates.map((candidate, index) => ({ ...candidate, vector: vectors[index + 1] })), queryVector, { limit });
            if (!ranked.length) fail('向量接口未返回可比较的候选向量');
            return ranked;
        } catch (error) {
            aborted(signal);
            if (scope.timedOut()) throw new Error('向量候选请求超时，已回退关键词召回');
            throw new Error(errorText(error, config));
        } finally { scope.dispose(); }
    }
    const rerankEndpoint = config => {
        const root = rerankRoot(config.apiUrl);
        return /\/v1$/i.test(root) ? `${root}/rerank` : `${root}/v1/rerank`;
    };
    const requestScope = (signal, message) => {
        const controller = new AbortController();
        let timedOut = false;
        const timer = setTimeout(() => { timedOut = true; controller.abort(new Error(message)); }, fixedCandidateTimeout ?? retrievalTimeoutRead().ms);
        const relay = () => controller.abort(signal?.reason instanceof Error ? signal.reason : new Error('忆幕任务已取消'));
        if (signal?.aborted) relay();
        else signal?.addEventListener('abort', relay, { once: true });
        return { signal: controller.signal, timedOut: () => timedOut, dispose() { clearTimeout(timer); signal?.removeEventListener('abort', relay); } };
    };
    async function rerankCandidates({ query = '', candidates = [], limit = 6, signal } = {}) {
        const config = rerankRead();
        const safeQuery = text(query);
        const safeCandidates = (Array.isArray(candidates) ? candidates : []).filter(candidate => candidate?.id && text(candidate.text)).slice(0, 64).map(candidate => ({
            id: String(candidate.id), text: text(candidate.text).slice(0, 20000), title: text(candidate.title), start: candidate.start, end: candidate.end,
        }));
        if (!safeQuery || !safeCandidates.length) return [];
        if (!config.apiUrl || !config.model) return [];
        const topN = Math.max(1, Math.min(Number.isSafeInteger(limit) ? limit : config.topN, config.topN, 64));
        const auth = config.apiKey ? /^Bearer\s/i.test(config.apiKey) ? config.apiKey : `Bearer ${config.apiKey}` : '';
        const scope = requestScope(signal, '重排候选请求超时，已保留当前顺序');
        try {
            const call = authorization => fetchImpl(rerankEndpoint(config), { method: 'POST', cache: 'no-store', signal: scope.signal,
                headers: { 'Content-Type': 'application/json', ...(authorization ? { Authorization: authorization } : {}) },
                body: JSON.stringify({ model: config.model, query: safeQuery.slice(0, 20000), documents: safeCandidates.map(candidate => candidate.text), top_n: topN }) });
            let response = await call(auth);
            if (!response.ok && (response.status === 401 || response.status === 403) && config.apiKey && auth !== config.apiKey) response = await call(config.apiKey);
            aborted(signal);
            if (!response.ok) fail(errorText(new Error(`重排接口请求失败（HTTP ${response.status}）`), config));
            let json; try { json = await response.json(); } catch { fail('重排接口返回格式无效'); }
            const rows = Array.isArray(json?.results) ? json.results : Array.isArray(json?.data) ? json.data : [];
            const ranked = rows.map(row => {
                const index = Number.isSafeInteger(row?.index) ? row.index : -1;
                const score = Number(row?.relevance_score ?? row?.score);
                const candidate = safeCandidates[index];
                return candidate && Number.isFinite(score) ? { id: candidate.id, score } : null;
            }).filter(Boolean);
            if (!ranked.length) fail('重排接口未返回有效候选');
            return ranked;
        } catch (error) {
            aborted(signal);
            if (scope.timedOut()) throw new Error('重排候选请求超时，已保留当前顺序');
            throw new Error(errorText(error, config));
        } finally { scope.dispose(); }
    }
    return { read, update, effectiveConnection, assertCurrent, generate, fetchModels, testConnection, savePreset, loadPreset, deletePreset, qianmuProfiles,
        vectorRead, updateVector, saveVectorPreset, loadVectorPreset, deleteVectorPreset, vectorCandidates,
        fetchVectorModels, testVectorConnection,
        rerankRead, updateRerank, saveRerankPreset, loadRerankPreset, deleteRerankPreset, rerankCandidates,
        fetchRerankModels, testRerankConnection,
        retrievalTimeoutRead, updateRetrievalTimeout,
        subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); } };
}
