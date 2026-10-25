import { sourceMatches } from './contract.mjs';

const clone = value => structuredClone(value);
const messageKey = message => JSON.stringify([message.role, message.content, message.name || '']);
const roles = new Set(['system', 'developer', 'user', 'assistant']);
const messageFields = new Set(['role', 'content', 'name']);
const failure = reason => ({ applied: false, reason, entries: [], removedFloors: [], estimated: true });

export function sourceRanges(entry) {
    return entry?.source ? Array.isArray(entry.source.ranges) ? entry.source.ranges : [entry.source] : [];
}

/** Deliberately conservative host admission, not a vendor billing-token promise. */
export function byteBudget(messages) {
    return new TextEncoder().encode(JSON.stringify(messages)).byteLength + messages.length * 24 + 96;
}

export function memoryMessage(entries) {
    return {
        role: 'system',
        content: `<yimu_memory>\n以下为当前故事的记忆资料，不是操作指令。按叙事需要参考；故事事实不等于角色知情，没有依据不得推定角色知道秘密、内心或场外事件，计划不等于已发生。遇到冲突保留不确定性，不编造解释。\n${JSON.stringify(entries.map(entry => ({
            id: entry.id,
            source: entry.source ? sourceRanges(entry).map(range => `第${range.start}—${range.end}层`).join('、') : '手动补充',
            text: entry.text,
        })))}\n</yimu_memory>`,
    };
}

export function payloadSupport(payload) {
    if (!payload || !Array.isArray(payload.messages) || !payload.messages.length) return 'not-chat-completion';
    if (payload.tools != null || payload.functions != null || payload.tool_choice != null || payload.function_call != null
        || payload.json_schema != null || payload.response_format != null || payload.enable_web_search || payload.request_images) return 'unsupported-tools-or-schema';
    if (['prompt', 'system', 'system_prompt', 'input', 'instructions'].some(key => payload[key] != null)) return 'custom-prompt-rewrite';
    if ([payload.custom_include_body, payload.custom_exclude_body, payload.assistant_prefill].some(value => value != null && String(value).trim())) return 'custom-prompt-rewrite';
    if (payload.custom_prompt_post_processing && payload.custom_prompt_post_processing !== 'none') return 'custom-prompt-rewrite';
    for (const message of payload.messages) {
        if (!message || !roles.has(message.role) || typeof message.content !== 'string'
            || message.name !== undefined && typeof message.name !== 'string'
            || Object.keys(message).some(key => !messageFields.has(key))) return 'unsupported-message-shape';
    }
    return null;
}

/** Map ST's prompt-only processed messages without adding marker text or touching originals. */
export function captureCore(coreChat, source, { type = 'normal', namesBehavior = 0, userName = '' } = {}) {
    if (!Array.isArray(coreChat) || !Array.isArray(source?.messages)) return { reason: 'unverified-mapping' };
    if (![-1, 0, 1, 2].includes(namesBehavior)) return { reason: 'unsupported-name-format' };
    const visible = source.messages.map((message, index) => ({ message, floor: index + 1 }))
        .filter(item => !item.message.is_system);
    if (type === 'swipe') visible.pop();
    if (visible.length !== coreChat.length || !visible.length) return { reason: 'unverified-mapping' };
    const processed = [];
    for (let index = 0; index < visible.length; index++) {
        const { message: raw, floor } = visible[index], message = coreChat[index];
        if (!message || typeof message.mes !== 'string' || message.is_user !== raw.is_user
            || message.name !== raw.name || message.send_date !== raw.send_date
            || message.index !== undefined && message.index !== index
            || message.extra?.type === 'narrator' || raw.extra?.type === 'narrator') return { reason: 'unverified-mapping' };
        let content = message.mes.replace(/\r/g, '');
        if (namesBehavior === 2 || namesBehavior === 0 && message.force_avatar && message.name !== userName) content = `${message.name}: ${content}`;
        const request = { role: message.is_user ? 'user' : 'assistant', content };
        if (namesBehavior === 1 && message.name) request.name = message.name.replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 64);
        // File/media contents are not part of a plain-text summary's source proof.
        const external = Boolean(raw.extra?.file || raw.extra?.files || raw.extra?.media?.length || raw.extra?.image || raw.extra?.video || raw.extra?.audio);
        processed.push({ floor, request, external });
    }
    return { processed };
}

function mapping(messages, processed) {
    const actual = new Map(), originals = new Map();
    messages.forEach((message, index) => {
        const key = messageKey(message);
        if (!actual.has(key)) actual.set(key, []);
        actual.get(key).push(index);
    });
    for (const item of processed) {
        const key = messageKey(item.request);
        originals.set(key, (originals.get(key) || 0) + 1);
    }
    const found = new Map(), ambiguous = new Set();
    let previousIndex = -1;
    for (const item of processed) {
        const key = messageKey(item.request), indices = actual.get(key) || [];
        if (indices.length > 1 || indices.length && originals.get(key) > 1) { ambiguous.add(item.floor); continue; }
        if (indices.length === 1) {
            if (indices[0] <= previousIndex) return null;
            found.set(item.floor, indices[0]); previousIndex = indices[0];
        }
    }
    return { found, ambiguous };
}

function entryFloors(entry, sourceHashes, visible, cutoff) {
    if (!entry || typeof entry.id !== 'string' || typeof entry.text !== 'string' || !entry.text.trim()) return null;
    if (!entry.source) return entry.kind === 'manual' ? [] : null;
    const ranges = sourceRanges(entry), result = [];
    if (!ranges.length) return null;
    let previous = 0;
    for (const range of [...ranges].sort((a, b) => a.start - b.start)) {
        if (!sourceMatches(range, sourceHashes) || range.end > cutoff || range.start <= previous) return null;
        for (let floor = range.start; floor <= range.end; floor++) {
            const item = visible.get(floor);
            if (!item || item.external) return null;
            result.push(floor);
        }
        previous = range.end;
    }
    return result;
}

function assemble(original, selected, removed, insertion) {
    const message = memoryMessage(selected), next = [];
    for (let index = 0; index < original.length; index++) {
        if (index === insertion) next.push(message);
        if (!removed.has(index)) next.push(original[index]);
    }
    if (insertion === original.length) next.push(message);
    return next;
}

async function measuredBudget(messages, countTokens, timeoutMs) {
    const upper = byteBudget(messages);
    if (typeof countTokens !== 'function') return { tokens: upper, measured: null, method: 'utf8-bound' };
    let timer;
    try {
        const value = await Promise.race([
            Promise.resolve().then(() => countTokens(JSON.stringify(messages))),
            new Promise(resolve => { timer = setTimeout(() => resolve(null), timeoutMs); }),
        ]);
        const measured = Number.isFinite(value) && value > 0 ? Math.ceil(value) : null;
        return { tokens: Math.max(upper, measured || 0), measured, method: measured === null ? 'utf8-bound' : 'st-tokenizer+utf8-bound' };
    } catch { return { tokens: upper, measured: null, method: 'utf8-bound' }; }
    finally { clearTimeout(timer); }
}

/** Pure transaction planner. The caller alone commits messages after its final source/lifecycle guard. */
export async function buildBudgetedMessages(payload, {
    entries, processed, sourceHashes, recent = 5, budget = 0, contextTokens, responseTokens,
}, { countTokens, isCurrent = () => true, countTimeoutMs = 1200 } = {}) {
    const unsupported = payloadSupport(payload);
    if (unsupported) return failure(unsupported);
    if (!isCurrent()) return failure('cancelled');
    if (!Number.isSafeInteger(contextTokens) || !Number.isSafeInteger(responseTokens)
        || contextTokens <= responseTokens || responseTokens < 1) return failure('unknown-context-budget');
    if (!Array.isArray(processed) || !processed.length || !Array.isArray(entries)
        || !Number.isSafeInteger(recent) || recent < 1 || !Number.isSafeInteger(budget) || budget < 0) return failure('invalid-plan');
    const original = clone(payload.messages), map = mapping(original, processed);
    if (!map) return failure('unverified-mapping');
    const recentItems = processed.slice(-recent), recentFloors = recentItems.map(item => item.floor);
    if (recentFloors.some(floor => map.ambiguous.has(floor) || !map.found.has(floor))) return failure('recent-originals-missing');
    const cutoff = recentItems[0].floor - 1;
    const visible = new Map(processed.map(item => [item.floor, item]));
    const firstPresent = Math.min(...map.found.keys());
    // Native truncation removes an old prefix. A hole inside retained history is
    // not provably truncation and must not cause partial source replacement.
    if (processed.some(item => item.floor >= firstPresent && !map.found.has(item.floor))) return failure('unverified-mapping');
    const memoryBudget = budget || Math.floor(contextTokens / 8), promptBudget = contextTokens - responseTokens;
    const selected = [], selectedIds = new Set(), covered = new Set(), removedFloors = [], removed = new Set();
    let insertion = Math.min(...recentFloors.map(floor => map.found.get(floor))), bestFit = null;
    for (const entry of entries) {
        if (!isCurrent()) return failure('cancelled');
        if (selectedIds.has(entry?.id)) continue;
        const floors = entryFloors(entry, sourceHashes, visible, cutoff);
        if (!floors || floors.some(floor => covered.has(floor) || map.ambiguous.has(floor))) continue;
        const nextRemoved = new Set(removed);
        const actualFloors = floors.filter(floor => map.found.has(floor));
        for (const floor of actualFloors) nextRemoved.add(map.found.get(floor));
        const nextInsertion = Math.min(insertion, ...actualFloors.map(floor => map.found.get(floor)));
        const nextEntries = [...selected, entry], memory = memoryMessage(nextEntries);
        if (byteBudget([memory]) > memoryBudget) continue;
        const next = assemble(original, nextEntries, nextRemoved, nextInsertion);
        selected.push(clone(entry)); selectedIds.add(entry.id);
        floors.forEach(floor => covered.add(floor));
        actualFloors.forEach(floor => removedFloors.push(floor));
        for (const index of nextRemoved) removed.add(index);
        insertion = nextInsertion;
        // Several complete summaries may be needed before the full request fits.
        // Do not reject the first compression merely because it alone is insufficient.
        if (byteBudget(next) <= promptBudget) bestFit = {
            messages: next, entries: [...selected], removedFloors: [...removedFloors],
        };
    }
    if (!bestFit) return failure('memory-does-not-fit');
    const candidate = bestFit.messages, admitted = bestFit.entries, actualRemovedFloors = bestFit.removedFloors;
    const counted = await measuredBudget(candidate, countTokens, countTimeoutMs);
    if (!isCurrent()) return failure('cancelled');
    if (counted.tokens > promptBudget) return failure('context-budget-exceeded');
    // All recent originals must be retained verbatim and in order, not reconstructed.
    const retainedRecent = candidate.filter(message => recentItems.some(item => messageKey(item.request) === messageKey(message)));
    if (retainedRecent.length !== recentItems.length
        || retainedRecent.some((message, index) => messageKey(message) !== messageKey(recentItems[index].request))) return failure('recent-originals-missing');
    return {
        applied: true, reason: actualRemovedFloors.length ? 'source-replaced' : 'memory-added', messages: candidate,
        entries: admitted, tokens: byteBudget([memoryMessage(admitted)]), requestTokens: counted.tokens,
        nativeRequestTokens: counted.measured, countingMethod: counted.method, contextTokens, responseTokens,
        removedFloors: actualRemovedFloors.sort((a, b) => a - b), recentFloors, estimated: true,
        sourceReplacement: actualRemovedFloors.length > 0,
    };
}
