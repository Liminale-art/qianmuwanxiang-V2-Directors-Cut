// Account-scoped ST settings only. Never put connection secrets in a memory document or backup.
import { byteBudget } from './budget.mjs';

const DEFAULTS = Object.freeze({ mode: 'inherit', apiUrl: '', apiKey: '', model: '', models: [],
    temperature: 0.7, maxTokens: 2048, contextTokens: 32768, stream: false, presets: [], selectedPreset: '', revision: 0 });
const FIELDS = ['apiUrl', 'apiKey', 'model', 'temperature', 'maxTokens', 'contextTokens', 'stream'];
const clone = value => structuredClone(value);
const text = value => typeof value === 'string' ? value.trim() : '';
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const fail = message => { throw new Error(message); };
const aborted = signal => { if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('忆幕任务已取消'); };

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
        if (!['mode', ...FIELDS].includes(key)) fail('未知的连接设置');
        if (key === 'mode') { if (!['inherit', 'st', 'profile', 'external'].includes(value)) fail('连接方式无效'); }
        else if (key === 'stream') { if (typeof value !== 'boolean') fail('流式设置无效'); }
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
    const settings = { ...clone(DEFAULTS), ...validate(Object.fromEntries(Object.entries(raw).filter(([key]) => ['mode', ...FIELDS].includes(key)))) };
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

async function completion(response, config, signal) {
    const readContent = content => typeof content === 'string' ? content : Array.isArray(content)
        ? content.filter(part => part?.type === 'text' && typeof part.text === 'string').map(part => part.text).join('') : '';
    const check = json => { if (json?.error) fail(errorText(json.error, config)); };
    if (!String(response.headers?.get?.('content-type') || '').includes('text/event-stream')) {
        const json = await response.json(); check(json);
        const reason = json?.choices?.[0]?.finish_reason;
        if (reason === 'length' || reason === 'max_tokens') fail('整理结果达到输出上限，未保存；请提高最大输出或缩小整理范围');
        if (reason && !['stop', 'end_turn'].includes(reason)) fail('服务未完整结束整理，结果未保存');
        return readContent(json?.choices?.[0]?.message?.content ?? json?.content);
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
        const choice = json?.choices?.[0]; output += readContent(choice?.delta?.content ?? choice?.message?.content);
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
    createId = () => globalThis.crypto.randomUUID(), statusTimeoutMs = 20000 } = {}) {
    const listeners = new Set(); let saving = Promise.resolve();
    const context = () => getContext() || fail('ST 尚未准备好连接设置');
    const read = () => savedConfig(context());
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
            next.revision = current.revision + Number(['mode', ...FIELDS].some(key => next[key] !== current[key]));
            const owned = { ...previous, api: next }; ctx.extensionSettings.yimu = owned;
            try { await ctx.saveSettingsDebounced(); }
            catch { if (ctx.extensionSettings.yimu === owned) ctx.extensionSettings.yimu = before; fail('连接设置未保存，请重试'); }
            notify(); return read();
        });
        saving = pending; return pending;
    };
    const update = patch => { const values = validate(patch); return commit(current => ({ ...current, ...values, selectedPreset: '' })); };
    function effectiveConnection(legacy = {}) {
        const config = read(), ctx = context();
        if (config.mode === 'external') return { mode: 'external', profileId: '', model: config.model,
            contextTokens: config.contextTokens, maxTokens: config.maxTokens, revision: config.revision };
        if (config.mode === 'profile' || config.mode === 'inherit' && text(legacy.profileId)) return { mode: 'profile', profileId: text(legacy.profileId), model: text(legacy.model), contextTokens: 0, maxTokens: 2048, revision: config.revision };
        return { mode: 'st', profileId: '', model: config.mode === 'inherit' ? text(legacy.model) : '',
            contextTokens: Number(ctx.mainApi === 'openai' ? ctx.chatCompletionSettings?.openai_max_context : ctx.maxContext) || 0,
            maxTokens: Number(ctx.chatCompletionSettings?.openai_max_tokens) || 2048, revision: config.revision };
    }
    const assertCurrent = connection => {
        if (connection && read().revision !== connection.revision) fail('整理连接已变化，本次结果未采用');
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
    async function generate(prompt, { connection, signal, systemPrompt = '', maxTokens } = {}) {
        await saving.catch(() => {}); const config = read(); assertCurrent(connection);
        if (config.mode !== 'external') fail('当前未选择独立连接');
        if (!text(config.model)) fail('请选择或填写整理模型');
        if (!text(prompt)) fail('没有可整理的聊天原文');
        const outputTokens = maxTokens === undefined ? config.maxTokens : Math.min(config.maxTokens, maxTokens);
        if (!Number.isSafeInteger(outputTokens) || outputTokens < 1) fail('整理输出长度无效');
        const messages = [{ role: 'system', content: String(systemPrompt) }, { role: 'user', content: prompt }];
        if (byteBudget(messages) + outputTokens > config.contextTokens) fail('整理内容超出此连接的上下文容量，请缩小整理范围或提高上下文 Token 数');
        try {
            const response = await request('/api/backends/chat-completions/generate', config,
                { model: config.model, messages, temperature: config.temperature, max_tokens: outputTokens, stream: config.stream }, signal);
            const result = await completion(response, config, signal); aborted(signal); assertCurrent(connection || { revision: config.revision });
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
    return { read, update, effectiveConnection, assertCurrent, generate, fetchModels, testConnection, savePreset, loadPreset, deletePreset,
        subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); } };
}
