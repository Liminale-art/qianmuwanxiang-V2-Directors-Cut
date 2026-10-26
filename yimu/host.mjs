// The only ST-facing layer. No direct chat writes, global connection switches or fetch patches.
import { fingerprintMessages } from './contract.mjs';
import { buildBudgetedMessages, captureCore, payloadSupport, summaryRequestBudget } from './budget.mjs';
import { createApiSettings } from './api-settings.mjs';

export const MEMORY_PROMPT_KEY = 'yimu-memory';

const SUMMARY_SYSTEM = '你是忆幕的整理助手。';
const EVENTS = [
    'CHAT_CHANGED', 'CHAT_LOADED', 'CHAT_RENAMED', 'CHAT_DELETED',
    'MESSAGE_SENT', 'MESSAGE_RECEIVED', 'MESSAGE_EDITED', 'MESSAGE_UPDATED',
    'MESSAGE_DELETED', 'MESSAGE_SWIPED', 'MESSAGE_SWIPE_DELETED',
    'GENERATION_STARTED', 'GENERATION_AFTER_COMMANDS', 'GENERATION_STOPPED', 'GENERATION_ENDED',
    'GENERATE_AFTER_DATA', 'CHAT_COMPLETION_PROMPT_READY', 'CHAT_COMPLETION_SETTINGS_READY',
];
const CLEAR_EVENTS = new Set(['CHAT_CHANGED', 'CHAT_LOADED', 'CHAT_DELETED', 'GENERATION_STARTED', 'GENERATION_STOPPED', 'GENERATION_ENDED']);
const GENERATION_TYPES = new Set(['normal', 'swipe', 'regenerate']);
const clone = value => structuredClone(value);
const text = value => typeof value === 'string' ? value.trim() : '';
const aborted = signal => {
    if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('忆幕任务已取消');
};

function bindingOf(ctx) {
    if (!ctx || ctx.groupId !== undefined && ctx.groupId !== null && ctx.groupId !== '') {
        throw new Error('忆幕首版仅支持单人聊天');
    }
    const character = ctx.characters?.[ctx.characterId];
    const binding = {
        avatar: text(character?.avatar),
        file: text(ctx.chatId || ctx.getCurrentChatId?.()),
        integrity: text(ctx.chatMetadata?.integrity),
    };
    if (!binding.avatar || !binding.file || !Array.isArray(ctx.chat)) throw new Error('请先打开一个角色的聊天');
    if (!binding.integrity) throw new Error('当前聊天尚无稳定的来源标识，请先完成 ST 的聊天保存');
    return binding;
}

function sameBinding(a, b) {
    return !!a && !!b && a.avatar === b.avatar && a.file === b.file && a.integrity === b.integrity;
}

function sameMessages(a, b) {
    return JSON.stringify(a) === JSON.stringify(b);
}

const plainObject = value => value !== null && typeof value === 'object'
    && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const orderedJson = value => JSON.stringify(value, (_key, item) => plainObject(item)
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);

function sameMetadata(a, b) {
    const comparable = metadata => {
        if (!plainObject(metadata) || !plainObject(metadata.timedWorldInfo)) return metadata;
        const timed = { ...metadata.timedWorldInfo }, result = { ...metadata };
        // ST initializes these empty maps even for a prompt preview. Only their
        // empty shape is disposable; real timers and unknown fields must match.
        for (const key of ['sticky', 'cooldown']) {
            if (plainObject(timed[key]) && Object.keys(timed[key]).length === 0) delete timed[key];
        }
        if (Object.keys(timed).length) result.timedWorldInfo = timed;
        else delete result.timedWorldInfo;
        return result;
    };
    return orderedJson(comparable(a)) === orderedJson(comparable(b));
}

function hasToolMessage(message) {
    return message?.role === 'tool' || Array.isArray(message?.extra?.tool_invocations)
        || Array.isArray(message?.tool_calls) || message?.tool_call_id != null;
}

const generationType = type => type || 'normal';

function routeOf(ctx) {
    const settings = ctx.chatCompletionSettings;
    return {
        mainApi: text(ctx.mainApi), source: text(settings?.chat_completion_source),
        model: text(ctx.getChatCompletionModel?.()),
        context: Number(settings?.openai_max_context), response: Number(settings?.openai_max_tokens),
        names: Number(settings?.names_behavior ?? 0), userName: text(ctx.name1),
    };
}

/** Construct an adapter with an injectable, current-context reader for isolated tests. */
export function createHost({
    getContext = () => globalThis.SillyTavern?.getContext?.(),
    onError = () => {},
    fetcher = (...args) => globalThis.fetch(...args),
    document = globalThis.document,
} = {}) {
    let generation = 0;
    let generating = false, opening = null, recentStory = null;
    const sessions = new WeakMap(), promoteFinalListeners = new Set();
    const connectionApi = createApiSettings({ getContext, fetchImpl: fetcher });

    function context() {
        const ctx = getContext();
        if (!ctx) throw new Error('当前 ST 尚未准备好忆幕所需接口');
        return ctx;
    }

    async function snapshot() {
        const ctx = context();
        const binding = bindingOf(ctx);
        return {
            binding,
            messages: clone(ctx.chat),
            name: text(ctx.characters?.[ctx.characterId]?.name || ctx.name2),
            avatarUrl: typeof ctx.getThumbnailUrl === 'function' ? ctx.getThumbnailUrl('avatar', binding.avatar)
                : `/thumbnail?type=avatar&file=${encodeURIComponent(binding.avatar)}`,
            mainApi: text(ctx.mainApi),
            maxContext: Number(ctx.mainApi === 'openai' ? ctx.chatCompletionSettings?.openai_max_context : ctx.maxContext) || 0,
            maxResponse: Number(ctx.chatCompletionSettings?.openai_max_tokens) || 0,
        };
    }

    function characters() {
        const seen = new Set();
        return (context().characters || []).flatMap(character => {
            const avatar = text(character?.avatar), name = text(character?.name);
            if (!avatar || !name || seen.has(avatar) || /[\x00-\x1f/\\]/.test(avatar)) return [];
            seen.add(avatar); return [{ avatar, name }];
        });
    }

    async function confirmStoryBoundary({ranges} = {}) {
        if (!Array.isArray(ranges) || !ranges.length || ranges.some(range => !Number.isSafeInteger(range?.start)
            || !Number.isSafeInteger(range?.end) || range.start < 1 || range.end < range.start)) throw new Error('续接边界范围无效，未调用总结 API');
        const popup = context().Popup?.show;
        if (typeof popup?.confirm !== 'function') throw new Error('当前 ST 无法确认续接的总结调用，未调用 API，请更新 ST 后重试');
        const floors = ranges.map(range => `${range.start}—${range.end}`).join('、');
        return await popup.confirm('整理续接边界？', `续接需要重新总结第 ${floors} 层，将使用当前总结 API 调用 ${ranges.length} 次，可能产生费用。只处理截止前正文，原聊天保持不变。是否继续？`,
            {okButton: '继续建立', cancelButton: '取消'}) === 1;
    }

    // ST awaits its first CHAT_CHANGED listener to render the welcome page.
    // Reveal only this session's newest confirmed continuation there once.
    // Do not alter native pin settings, message dates or recent-chat requests.
    function revealRecentStory() {
        if (!recentStory) return;
        const ctx = getContext();
        if (!ctx || ctx.extensionSettings !== recentStory.owner) { recentStory = null; return; }
        if (ctx.chatId || ctx.getCurrentChatId?.()) return;
        const list = document?.querySelector?.('#chat .welcomePanel .recentChatList');
        if (!list) return;
        const target = recentStory; recentStory = null;
        const rows = [...list.querySelectorAll('.recentChat')].filter(row => !row.dataset.group
            && row.dataset.avatar === target.avatar && row.dataset.file === target.file);
        if (rows.length !== 1) return;
        const row = rows[0]; row.classList.remove('hidden'); row.hidden = false;
        list.insertBefore(row, list.firstChild);
    }

    // Creation is owned by the account-scoped server transaction. This method
    // only checks its receipt and opens an existing file through ST itself.
    async function openStory(result, { sourceSnapshot, isCurrent = () => true } = {}) {
        const failed = (reason, message) => ({ opened: false, reason, message });
        if (opening) return failed('opening', '正在打开已建立的聊天，请稍候。');
        const target = result?.binding, receipt = result?.receipt, bridge = receipt?.bridge;
        if (receipt?.status !== 'complete' || !sameBinding(receipt.target, target) || !bridge
            || !Number.isSafeInteger(bridge.count) || bridge.count < 1
            || !Array.isArray(bridge.hashes) || bridge.hashes.length !== bridge.count
            || !bridge.hashes.every(hash => typeof hash === 'string' && /^[a-f0-9]{64}$/.test(hash))) {
            return failed('unconfirmed-receipt', '新聊天尚未完整确认，未打开。');
        }
        const safe = value => typeof value === 'string' && value.length > 0 && value.length <= 255 && !/[\x00-\x1f/\\]/.test(value);
        if (![target.avatar, target.file, target.integrity].every(safe) || !sourceSnapshot?.binding || !Array.isArray(sourceSnapshot.messages)) {
            return failed('invalid-target', '新聊天身份无效，未打开。');
        }
        let ctx;
        try { ctx = context(); } catch { return failed('host-unavailable', 'ST 尚未准备好，新聊天已保留。'); }
        const sourceMetadata = clone(ctx.chatMetadata);
        const busy = () => generating || context().streamingProcessor?.isFinished === false && context().streamingProcessor?.isStopped !== true;
        const current = () => {
            try { return isCurrent() === true && !busy() && sameBinding(bindingOf(context()), sourceSnapshot.binding)
                && sameMessages(context().chat, sourceSnapshot.messages) && sameMetadata(context().chatMetadata, sourceMetadata); }
            catch { return false; }
        };
        if (!current() || target.avatar !== sourceSnapshot.binding.avatar) return failed('source-changed', '当前聊天已变化或仍在生成，新聊天已保留，未自动切换。');
        if (typeof ctx.openCharacterChat !== 'function') return failed('host-unavailable', '当前 ST 不支持直接打开；新聊天已保留在角色聊天记录中。');
        opening = receipt.id || target.file;
        const readChat = async binding => {
            const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 10000);
            try {
                const response = await fetcher('/api/chats/get', { method: 'POST', cache: 'no-store', signal: controller.signal,
                    headers: { ...context().getRequestHeaders?.(), 'Content-Type': 'application/json' },
                    body: JSON.stringify({ avatar_url: binding.avatar, file_name: binding.file }) });
                if (!response.ok) throw new Error('读取聊天失败');
                const rows = await response.json();
                if (!Array.isArray(rows) || rows.length < 2 || rows[0]?.chat_metadata?.integrity !== binding.integrity) throw new Error('聊天身份尚未核实');
                return rows;
            } finally { clearTimeout(timer); }
        };
        try {
            const targetRows = await readChat(target);
            const hashes = await fingerprintMessages(targetRows.slice(1, bridge.count + 1));
            if (!sameMessages(hashes, bridge.hashes) || receipt.fullChat && targetRows.length !== bridge.count + 1) return failed('target-changed', '新聊天的衔接内容已变化，未自动打开。');
            if (!receipt.fullChat && target.file.startsWith('忆幕续接-')) recentStory = {...target, owner: ctx.extensionSettings};
            if (!current()) return failed('source-changed', '当前聊天已变化或仍在生成，新聊天已保留，未自动切换。');
            if (sameBinding(target, sourceSnapshot.binding)) return { opened: true, binding: clone(target), alreadyOpen: true };
            // Native clearChat cancels pending saves. Never navigate away from
            // unsaved source text/metadata and never force a save on its behalf.
            const sourceRows = await readChat(sourceSnapshot.binding);
            const savedHashes = await fingerprintMessages(sourceRows.slice(1));
            const expected = await fingerprintMessages(sourceSnapshot.messages);
            if (!sameMessages(savedHashes, expected) || !sameMetadata(sourceRows[0].chat_metadata, sourceMetadata)) {
                return failed('source-not-saved', '当前聊天还有未确认保存的内容，新聊天已保留；待 ST 保存后再打开。');
            }
            if (!current()) return failed('source-changed', '当前聊天已变化或仍在生成，新聊天已保留，未自动切换。');
            clear();
            await ctx.openCharacterChat(target.file);
            const loaded = await snapshot();
            const loadedHashes = await fingerprintMessages(loaded.messages.slice(0, bridge.count));
            if (!sameBinding(loaded.binding, target) || !sameMessages(loadedHashes, bridge.hashes) || receipt.fullChat && loaded.messages.length !== bridge.count) {
                return failed('open-unconfirmed', '新聊天已建立，但尚未确认打开；请从角色聊天记录中打开。');
            }
            return { opened: true, binding: clone(target) };
        } catch {
            return failed('open-unconfirmed', '新聊天已保留，读取或打开尚未确认；请稍后重试打开。');
        } finally { opening = null; }
    }

    function openBackup(result, options) {
        const receipt = result?.receipt;
        if (receipt?.status !== 'complete' || !Array.isArray(receipt.hashes) || !receipt.hashes.length) {
            return Promise.resolve({ opened: false, reason: 'unconfirmed-receipt', message: '恢复副本尚未完整确认，未打开。' });
        }
        return openStory({ ...result, receipt: { ...receipt, fullChat: true, bridge: { count: receipt.hashes.length, hashes: receipt.hashes } } }, options);
    }

    function clear() {
        generation++;
        const ctx = getContext();
        if (typeof ctx?.setExtensionPrompt !== 'function') return false;
        ctx.setExtensionPrompt(MEMORY_PROMPT_KEY, '', 1, 0, false, 0);
        return true;
    }

    function profiles() {
        return connectionApi.qianmuProfiles();
    }

    async function generate(prompt, { profileId = '', model = '', connection, signal, systemPrompt = SUMMARY_SYSTEM, maxTokens } = {}) {
        aborted(signal);
        if (typeof prompt !== 'string' || !prompt.trim()) throw new Error('没有可整理的聊天原文');
        const ctx = context();
        const selected = connection || connectionApi.effectiveConnection({ profileId, model });
        connectionApi.assertCurrent(selected);
        if (selected.mode === 'external' || selected.mode === 'qianmu') return connectionApi.generate(prompt, { connection: selected, signal, systemPrompt, maxTokens });
        if (selected.mode === 'st' && selected.contextTokens > 0 && summaryRequestBudget(prompt, systemPrompt)
            + selected.maxTokens > selected.contextTokens) throw new Error('整理内容超出此连接的上下文容量，请缩小整理范围或选择容量足够的连接');
        if (selected.mode === 'profile' && !selected.profileId) throw new Error('请选择 ST 连接预设');
        profileId = selected.profileId; model = selected.model; maxTokens ??= 2048;
        let result;
        if (profileId) {
            const service = ctx.ConnectionManagerRequestService;
            if (typeof service?.sendRequest !== 'function') throw new Error('当前 ST 不支持独立的忆幕连接');
            if (!Number.isSafeInteger(maxTokens) || maxTokens < 1) throw new Error('忆幕输出长度无效');
            result = await service.sendRequest(profileId, [
                { role: 'system', content: String(systemPrompt) },
                { role: 'user', content: prompt },
            ], maxTokens, { stream: false, signal, extractData: true, includePreset: false },
            text(model) ? { model: text(model) } : {});
        } else {
            if (text(model)) throw new Error('单独选择忆幕模型时，请同时选择连接');
            if (typeof ctx.generateRaw !== 'function') throw new Error('当前 ST 不支持后台整理接口');
            // ST owns cancellation for generateRaw. Never call global stopGeneration:
            // cancellation/disable discards a late answer without stopping normal chat.
            result = await ctx.generateRaw({ prompt, systemPrompt: String(systemPrompt), trimNames: false });
        }
        aborted(signal);
        connectionApi.assertCurrent(selected);
        const content = typeof result === 'string' ? result : result?.content;
        if (typeof content !== 'string' || !content.trim()) throw new Error('忆幕没有收到可用的整理结果');
        return content;
    }

    function prepare(coreChat, plan, source, type = 'normal') {
        clear();
        const fallback = reason => ({ prepared: false, reason, session: null });
        type = generationType(type);
        if (!Array.isArray(plan?.entries) || !plan.entries.length) return fallback('empty');
        if (!GENERATION_TYPES.has(type)) return fallback('unsupported-generation');
        let ctx, binding;
        try { ctx = context(); binding = bindingOf(ctx); } catch { return fallback('not-single-chat'); }
        if (!sameBinding(binding, source?.binding) || !sameMessages(ctx.chat, source?.messages)) return fallback('source-changed');
        const route = routeOf(ctx);
        if (route.mainApi !== 'openai') return fallback('text-completion-boundary-unavailable');
        if (!route.model || !route.source || !Number.isSafeInteger(route.context) || route.context < 1) return fallback('unknown-context-budget');
        if (!Array.isArray(coreChat)) return fallback('unverified-mapping');
        const liveMessages = new Set(ctx.chat);
        if (coreChat === ctx.chat || coreChat.some(message => liveMessages.has(message))) return fallback('live-chat-reference');
        if (source.messages.some(hasToolMessage) || coreChat.some(hasToolMessage)) return fallback('unsupported-tools');
        const captured = captureCore(coreChat, source, { type, namesBehavior: route.names, userName: route.userName });
        if (captured.reason) return fallback(captured.reason);
        const session = Object.freeze({ binding: Object.freeze(clone(binding)), type });
        sessions.set(session, { generation, route, source: clone(source), plan: clone(plan), processed: captured.processed, hiddenFloors: captured.hiddenFloors, used: false });
        for (const promote of promoteFinalListeners) promote();
        return { prepared: true, reason: 'awaiting-final-request', session };
    }

    async function applyPrepared(payload, session, { isCurrent = () => true } = {}) {
        const fallback = reason => ({ applied: false, reason, entries: [], removedFloors: [], estimated: true });
        const record = sessions.get(session);
        if (!record || record.used || record.running || record.generation !== generation) return fallback('expired-session');
        if (generationType(payload?.type) !== session.type) return fallback('different-generation');
        const unsupported = payloadSupport(payload);
        if (unsupported) return fallback(unsupported);
        const current = () => {
            if (record.used || record.generation !== generation || isCurrent() !== true) return false;
            const ctx = context();
            return sameBinding(bindingOf(ctx), record.source.binding) && sameMessages(ctx.chat, record.source.messages)
                && sameMessages(routeOf(ctx), record.route);
        };
        record.running = true;
        try {
            if (!current()) return fallback('source-or-route-changed');
            if (payload.model !== record.route.model || payload.chat_completion_source !== record.route.source) return fallback('different-route');
            // ST rewrites system roles for o1 before this hook; adding a new system
            // message afterwards would bypass that conversion.
            if (/^(openai\/)?o1(?:$|[-.])/.test(payload.model)) return fallback('unsupported-system-role');
            const responseTokens = Math.max(Number(payload.max_tokens) || 0, Number(payload.max_completion_tokens) || 0);
            const frozenPayload = JSON.stringify(payload);
            const sourceHashes = await fingerprintMessages(record.source.messages);
            if (!current() || JSON.stringify(payload) !== frozenPayload) return fallback('request-changed');
            const ctx = context();
            const result = await buildBudgetedMessages(payload, {
                entries: record.plan.entries, entryOrder: record.plan.entryOrder, processed: record.processed, sourceHashes,
                hiddenFloors: record.hiddenFloors,
                recent: record.plan.settings?.recent ?? 5, budget: record.plan.settings?.budget ?? 0,
                contextTokens: record.route.context, responseTokens,
            }, { countTokens: typeof ctx.getTokenCountAsync === 'function' ? value => ctx.getTokenCountAsync(value) : null, isCurrent: current });
            if (!result.applied) return result;
            if (!current() || JSON.stringify(payload) !== frozenPayload) return fallback('request-changed');
            // The sole commit point: no early deletions, markers or partial writes.
            payload.messages = result.messages;
            record.used = true;
            const { messages: ignored, ...receipt } = result;
            return receipt;
        } catch { return fallback('budget-or-source-unavailable'); }
        finally { record.running = false; }
    }

    function subscribe(callback) {
        if (typeof callback !== 'function') throw new TypeError('忆幕事件回调无效');
        const ctx = context();
        const events = ctx.eventTypes || ctx.event_types;
        const emitter = ctx.eventSource;
        if (!events || typeof emitter?.on !== 'function') return () => {};
        const remove = typeof emitter.removeListener === 'function' ? emitter.removeListener.bind(emitter)
            : typeof emitter.off === 'function' ? emitter.off.bind(emitter) : null;
        if (!remove) return () => {};
        const subscriptions = [];
        for (const name of EVENTS) {
            const event = events[name];
            if (!event) continue;
            const listener = (...args) => {
                if (name === 'GENERATION_STARTED' && args[2] !== true) generating = true;
                if (name === 'GENERATION_STOPPED' || name === 'GENERATION_ENDED') generating = false;
                // ST can assemble a token-preview dry run while a real request is
                // preparing. It must not clear that real request's memory slot.
                if (CLEAR_EVENTS.has(name) && !(name === 'GENERATION_STARTED' && args[2] === true)) clear();
                try {
                    if (name === 'CHAT_CHANGED') revealRecentStory();
                    // ST awaits listeners. In particular, final payload admission
                    // must finish before ST starts its network request.
                    const pending = callback(name, args);
                    return pending?.catch ? pending.catch(onError) : pending;
                } catch (error) { onError(error); }
            };
            emitter.on(event, listener);
            subscriptions.push([event, listener]);
            if (name === 'CHAT_COMPLETION_SETTINGS_READY' && typeof emitter.makeLast === 'function') {
                const promote = () => emitter.makeLast(event, listener);
                promoteFinalListeners.add(promote); promote();
                subscriptions.at(-1).push(promote);
            }
        }
        let active = true;
        return () => {
            if (!active) return;
            active = false;
            recentStory = null;
            for (const [event, listener, promote] of subscriptions) {
                remove(event, listener);
                if (promote) promoteFinalListeners.delete(promote);
            }
            clear();
        };
    }

    return { snapshot, generate, profiles, characters, clear, prepare, applyPrepared, subscribe, openStory, openBackup, confirmStoryBoundary,
        connectionApi, summaryConnection: settings => connectionApi.effectiveConnection(settings) };
}
