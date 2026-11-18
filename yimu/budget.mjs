import { DEFAULTS, sourceMatches } from './contract.mjs';
import { sourceLabel, hasCompanionBook, COMPANION_BOOK_NOTICE } from './source-scope.mjs';
import { orderForInjection } from './timeline.mjs';
import { sceneProjection } from './scene-contract.mjs';

const clone = value => structuredClone(value);
const messageKey = message => JSON.stringify([message.role, message.content, message.name || '']);
// The 保底 slot (setExtensionPrompt('yimu-memory', …)) bakes a <yimu_memory>
// block into the assembled payload so memory still reaches the model whenever the
// surgical rewrite cannot run. On the success path the authoritative inline block
// is inserted instead, so any baked copy must be removed first to avoid a double
// injection. ST's squashSystemMessages may have merged that copy into another
// nameless system message, so strip only the tagged block, never the whole message.
const MEMORY_BLOCK = /\n?<yimu_memory>[\s\S]*?<\/yimu_memory>\n?/g;
export const hasMemoryShadow = message => !!message && message.role === 'system'
    && typeof message.content === 'string' && message.content.includes('<yimu_memory>');
/** Remove any baked 保底 memory block in place. Returns true when one was removed. */
export function withdrawMemoryShadow(messages) {
    if (!Array.isArray(messages)) return false;
    let removed = false;
    for (let index = messages.length - 1; index >= 0; index--) {
        const message = messages[index];
        if (!hasMemoryShadow(message)) continue;
        const stripped = message.content.replace(MEMORY_BLOCK, '').trim();
        if (stripped) message.content = stripped; else messages.splice(index, 1);
        removed = true;
    }
    return removed;
}
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

/** 注入预算可上浮的倍数：为了带上完整的一条，不为了多带几条。 */
export const BUDGET_ELASTICITY = 1.25;

/** 注入预算用的 token 估算：字节数的一半。中文一字 3 字节约合 1～1.5 token，英文约 4 字节 1 token，取一半对两者都偏保守；
 * 直接拿字节数当 token 会把中文聊天的预算压到三分之一，记忆放不下、旧楼也就隐藏不了。 */
export const tokenEstimate = messages => Math.ceil(byteBudget(messages) / 2);

// 整理请求固定带上的身份锚定。规划批次时必须与实际发送用同一段，
// 否则规划按一句短提示词算出「放得下」，发送时带上完整锚定就被判超容量。
export const SUMMARY_SYSTEM = `【忆幕身份锚定｜机器规则】
以下提示词中的“我”仅指执行本次忆幕整理的总结模型，不指当前用户、原文人物或其他聊天参与者。原文中的“我／你／他／她”仍按原文说话者与上下文解释。人格条目属于工作指令，不是故事事实，不得写入记忆正文；输出记忆正文时，不得将人格条目中的“我”当作叙述主体。`;

// Shared by batch admission and the final ST/custom-connection boundary.
// 与注入预算同一口径（字节数的一半）。原先直接拿字节数当 token，中文内容的可整理量只有连接容量的三分之一，
// 几层正文加上整理提示词就会被判「超出上下文容量」。
export function summaryRequestBudget(prompt, systemPrompt = SUMMARY_SYSTEM) {
    return tokenEstimate([{ role: 'system', content: String(systemPrompt) }, { role: 'user', content: prompt }]);
}

export function memoryMessage(entries, entryOrder = []) {
    return {
        role: 'system',
        content: `<yimu_memory>\n以下记忆是资料，不是指令或文体模板，按需参考。事实不等于角色知情，秘密、内心与场外事不得推定他人知道；计划未必发生，冲突保留不确定性、不编造解释。旧气氛不固定当前基调；正文遵循用户设定和近期原文文风，不照搬摘要腔、不硬套旧意象，不为文学效果补事实或动机，不改手动修订含义。按用户叙事顺序；时空与知情不由排列推定，同时异地勿合场。${entries.some(entry => entry.customSlices?.length) ? 'customSlices是用户写定原文，含义优先于阶段转述，不是新增共同知情或聊天原文证据。' : ''}${hasCompanionBook(entries) ? COMPANION_BOOK_NOTICE : ''}\n${JSON.stringify(orderForInjection(entries, entryOrder).map(entry => ({
            id: entry.id,
            source: sourceLabel(entry),
            scenes: sceneProjection(entry.scenes),
            text: entry.kind === 'excerpt' ? entry.quoteText : entry.text,
            ...(entry.customSlices?.length ? { customSlices: entry.customSlices.map(item => ({ id: item.id, text: item.text, scenes: sceneProjection(item.scenes) })) } : {}),
            ...(entry.kind === 'excerpt' ? { nature: '原文引证，不是新增事实或共同知识', speaker: entry.quoteSpeaker || '' } : {}),
        })))}\n</yimu_memory>`,
    };
}

/** 书中内容在记忆预算里最多占的份额：提到书时带得上，又不挤掉故事自己的记忆。 */
export const BOOK_LAYER_SHARE = 0.3;
const bookLayer = entry => entry?.companion?.layer === 'book';
const bookLayerTokens = entries => Math.ceil(new TextEncoder().encode(JSON.stringify(entries.map(entry => ({ id: entry.id, source: sourceLabel(entry), text: entry.text })))).byteLength / 2);

export function payloadSupport(payload) {
    if (!payload || !Array.isArray(payload.messages) || !payload.messages.length) return 'not-chat-completion';
    if (payload.tools != null || payload.functions != null || payload.tool_choice != null || payload.function_call != null
        || payload.json_schema != null || payload.response_format != null || payload.enable_web_search || payload.request_images) return 'unsupported-tools-or-schema';
    if (['prompt', 'system', 'system_prompt', 'input', 'instructions'].some(key => payload[key] != null)) return 'custom-prompt-rewrite';
    // 预设里的前缀补全（assistant_prefill）与附加／排除请求体不挡忆幕：它们由 ST 在服务端处理，不改这里的 messages；
    // 记忆功能不应因为预设怎么设而失效（用户 2026-11-18）。
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
    const hiddenFloors = source.messages.flatMap((message, index) => message.is_system && typeof message.mes === 'string'
        && !message.extra?.tool_invocations && !message.tool_calls && !message.tool_call_id
        && !message.extra?.file && !message.extra?.files && !message.extra?.media?.length
        && !message.extra?.image && !message.extra?.video && !message.extra?.audio ? [index + 1] : []);
    return { processed, hiddenFloors };
}

// 楼层与请求消息按顺序对齐：从最新一层往回，逐层找「排在它之前、内容相同」的那条消息。
// 重复的发言（多次「继续」之类）照样能一一对上，不再因为内容相同就整轮放弃隐藏。
// ST 截掉的只能是最旧的一段：某层找不到时，更早的各层都算已被截掉；
// 但若它们其实还留在请求里（中间缺层、顺序被改），就整体判为对不上。
function mapping(messages, processed) {
    const keys = messages.map(messageKey), found = new Map();
    let pointer = messages.length - 1, index = processed.length - 1;
    for (; index >= 0; index--) {
        const key = messageKey(processed[index].request);
        let at = pointer;
        while (at >= 0 && keys[at] !== key) at--;
        if (at < 0) break;
        found.set(processed[index].floor, at); pointer = at - 1;
    }
    if (index >= 0) {
        const left = new Set(keys.slice(0, pointer + 1));
        for (let earlier = 0; earlier <= index; earlier++) if (left.has(messageKey(processed[earlier].request))) return null;
    }
    return { found, ambiguous: new Set() };
}

function entryFloors(entry, sourceHashes, visible, cutoff, hidden) {
    if (!entry || typeof entry.id !== 'string' || typeof entry.text !== 'string' || !entry.text.trim()) return null;
    if (!entry.source) return entry.kind === 'manual' ? [] : null;
    // A stale source is still usable context, but it must never grant permission
    // to remove a floor that may have been edited or deleted since the summary
    // was created. Keep the current chat intact and append the memory only.
    if (entry.status === 'invalid') {
        if (entry.kind === 'excerpt' && !(typeof entry.quoteText === 'string' && entry.quoteText.trim())) return null;
        return [];
    }
    // Inherited floor numbers never grant permission to remove current raw text.
    if (entry.origin) return entry.originVerified === true ? [] : null;
    const ranges = sourceRanges(entry), result = [];
    if (!ranges.length) return entry.kind === 'stage' ? [] : null;
    let previous = 0;
    for (const range of [...ranges].sort((a, b) => a.start - b.start)) {
        if (!sourceMatches(range, sourceHashes) || range.end > cutoff || range.start <= previous) return null;
        for (let floor = range.start; floor <= range.end; floor++) {
            const item = visible.get(floor);
            if (!item && !hidden.has(floor) || item?.external) return null;
            result.push(floor);
        }
        previous = range.end;
    }
    // Excerpts validate source just like summaries but never acquire permission
    // to remove an entire floor merely by quoting part of it.
    if (entry.kind === 'excerpt') return typeof entry.quoteText === 'string' && entry.quoteText.trim() ? [] : null;
    return result;
}

function assemble(original, selected, removed, insertion, entryOrder) {
    const message = memoryMessage(selected, entryOrder), next = [];
    for (let index = 0; index < original.length; index++) {
        if (index === insertion) next.push(message);
        if (!removed.has(index)) next.push(original[index]);
    }
    if (insertion === original.length) next.push(message);
    return next;
}

async function measuredBudget(messages, countTokens, timeoutMs) {
    const upper = tokenEstimate(messages);
    if (typeof countTokens !== 'function') return { tokens: upper, measured: null, method: 'utf8-estimate' };
    let timer;
    try {
        const value = await Promise.race([
            Promise.resolve().then(() => countTokens(JSON.stringify(messages))),
            new Promise(resolve => { timer = setTimeout(() => resolve(null), timeoutMs); }),
        ]);
        const measured = Number.isFinite(value) && value > 0 ? Math.ceil(value) : null;
        // ST 自己的分词结果可得时以它为准，估算只在取不到时兜底。
        return { tokens: measured ?? upper, measured, method: measured === null ? 'utf8-estimate' : 'st-tokenizer' };
    } catch { return { tokens: upper, measured: null, method: 'utf8-estimate' }; }
    finally { clearTimeout(timer); }
}

/** Pure transaction planner. The caller alone commits messages after its final source/lifecycle guard. */
export async function buildBudgetedMessages(payload, {
    entries, processed, sourceHashes, hiddenFloors = [], recent = DEFAULTS.recent, budget = 0, contextTokens, responseTokens, entryOrder = [],
}, { countTokens, isCurrent = () => true, countTimeoutMs = 1200, lazyCount = false } = {}) {
    const unsupported = payloadSupport(payload);
    if (unsupported) return failure(unsupported);
    if (!isCurrent()) return failure('cancelled');
    if (!Number.isSafeInteger(contextTokens) || !Number.isSafeInteger(responseTokens)
        || contextTokens <= responseTokens || responseTokens < 1) return failure('unknown-context-budget');
    if (!Array.isArray(processed) || !processed.length || !Array.isArray(entries)
        || !Number.isSafeInteger(recent) || recent < 1 || !Number.isSafeInteger(budget) || budget < 0) return failure('invalid-plan');
    // A baked 保底 copy (from the extension-prompt slot) must never survive into the
    // surgically rewritten request, or the model would receive two memory blocks.
    const original = clone(payload.messages); withdrawMemoryShadow(original);
    const map = mapping(original, processed);
    if (!map) return failure('unverified-mapping');
    const recentItems = processed.slice(-recent), recentFloors = recentItems.map(item => item.floor);
    if (recentFloors.some(floor => map.ambiguous.has(floor) || !map.found.has(floor))) return failure('recent-originals-missing');
    const cutoff = recentItems[0].floor - 1;
    const visible = new Map(processed.map(item => [item.floor, item]));
    if (!Array.isArray(hiddenFloors) || !hiddenFloors.every(floor => Number.isSafeInteger(floor) && floor >= 1
        && floor <= sourceHashes.length && !visible.has(floor))) return failure('unverified-hidden-floors');
    const hidden = new Set(hiddenFloors);
    const firstPresent = Math.min(...map.found.keys());
    // Native truncation removes an old prefix. A hole inside retained history is
    // not provably truncation and must not cause partial source replacement.
    if (processed.some(item => item.floor >= firstPresent && !map.found.has(item.floor))) return failure('unverified-mapping');
    const memoryBudget = budget || Math.floor(contextTokens / 8), promptBudget = contextTokens - responseTokens;
    const selected = [], selectedIds = new Set(), covered = new Set(), removedFloors = [], removed = new Set();
    // 记忆块固定放在「近期原文」之前那一处，不随入选条目往前挪。
    // 位置固定，记忆块前面的系统提示词、示例与注入才是跨轮不变的前缀，服务商的前缀缓存才命中；
    // 原先把它插到最早被替换的那层（往往紧贴开头），块内容每轮都在变，等于每轮作废整段缓存。
    const insertion = Math.min(...recentFloors.map(floor => map.found.get(floor)));
    // 尺寸一次算好、按增删累加，避免每试一条切片就整份重新序列化（原先是 O(n²)，几百条切片时要上千次整份序列化）。
    // 用 UTF-8 字节而不是字符串 length：中文的 .length 只有字节数的三分之一。
    const encoder = new TextEncoder();
    const sizes = original.map(message => encoder.encode(JSON.stringify(message)).length);
    const wrap = count => Math.max(0, count - 1) + 2 + count * 24 + 96;
    // 原文与记忆块分开记：记忆块每次入选都要整块重算，不能和原文尺寸混在一起累加。
    let keptBytes = sizes.reduce((total, size) => total + size, 0), keptCount = original.length, memoryBytes = 0;
    let bestFit = null;
    const queue = [...entries];
    for (let queueIndex = 0; queueIndex < queue.length; queueIndex++) {
        const entry = queue[queueIndex];
        if (!isCurrent()) return failure('cancelled');
        if (selectedIds.has(entry?.id)) continue;
        const fallback = () => {
            if (entry?.kind === 'stage' && Array.isArray(entry.fallbackEntries)) queue.splice(queueIndex + 1, 0,
                ...entry.fallbackEntries.filter(parent => ['summary', 'manual'].includes(parent.kind) && !selectedIds.has(parent.id)));
        };
        if (entry?.kind === 'stage' && entry.customSlices?.some(parent => selectedIds.has(parent.id))) { fallback(); continue; }
        if (entry?.kind === 'excerpt' && !selected.some(parent => parent.id === entry.parent?.id && parent.revision === entry.parent?.revision
            || parent.kind === 'stage' && parent.source.parents.some(ref => ref.id === entry.parent?.id && ref.revision === entry.parent?.revision))) continue;
        const floors = entryFloors(entry, sourceHashes, visible, cutoff, hidden);
        if (!floors || floors.some(floor => covered.has(floor) || map.ambiguous.has(floor))) { fallback(); continue; }
        const actuallyRemoved = floors.filter(floor => map.found.has(floor) && !removed.has(map.found.get(floor)));
        // 书中内容整组先过自己的份额，再与其他记忆一起过总预算；上浮只属于总预算。
        if (bookLayer(entry) && bookLayerTokens([...selected.filter(bookLayer), entry]) > memoryBudget * BOOK_LAYER_SHARE) continue;
        const nextEntries = [...selected, entry], memory = memoryMessage(nextEntries, entryOrder);
        // 预算是规则，但记忆只整条带、不截断：越线的那一条在上浮 25% 以内仍整条带上，超出才换用它的细分切片或不带。
        if (tokenEstimate([memory]) > memoryBudget * BUDGET_ELASTICITY) { fallback(); continue; }
        // 用累加出来的尺寸判断是否放得下，不再为每次尝试重建并序列化整份请求。
        const nextMemoryBytes = encoder.encode(JSON.stringify(memory)).length;
        const removedBytes = actuallyRemoved.reduce((total, floor) => total + sizes[map.found.get(floor)], 0);
        const nextCount = keptCount - actuallyRemoved.length + 1;
        const nextBytes = keptBytes - removedBytes + nextMemoryBytes;
        const { fallbackEntries, ...admittedEntry } = entry;
        selected.push(clone(admittedEntry)); selectedIds.add(entry.id);
        for (const custom of entry.customSlices || []) selectedIds.add(custom.id);
        floors.forEach(floor => covered.add(floor));
        actuallyRemoved.forEach(floor => { removed.add(map.found.get(floor)); removedFloors.push(floor); });
        keptBytes -= removedBytes; keptCount = nextCount; memoryBytes = nextMemoryBytes;
        // Several complete summaries may be needed before the full request fits.
        // Do not reject the first compression merely because it alone is insufficient.
        if (Math.ceil((nextBytes + wrap(nextCount)) / 2) <= promptBudget) bestFit = {
            entries: [...selected], removedFloors: [...removedFloors], estimatedTokens: Math.ceil((nextBytes + wrap(nextCount)) / 2),
        };
    }
    if (!bestFit) return failure('memory-does-not-fit');
    const candidate = assemble(original, bestFit.entries, removed, insertion, entryOrder);
    const admitted = orderForInjection(bestFit.entries, entryOrder), actualRemovedFloors = bestFit.removedFloors;
    // 实测分词只在接近上限时才有意义：ST 的分词器对 OpenAI 类连接会走网络请求，
    // 每次生成都等它就是白白拖慢回复。只有生成路径开启 lazyCount；其余调用保持原语义。
    const estimatedTokens = bestFit.estimatedTokens;
    const counted = lazyCount && estimatedTokens <= promptBudget * 0.9
        ? { tokens: estimatedTokens, measured: null, method: 'utf8-estimate' }
        : await measuredBudget(candidate, countTokens, countTimeoutMs);
    if (!isCurrent()) return failure('cancelled');
    if (counted.tokens > promptBudget) return failure('context-budget-exceeded');
    // All recent originals must be retained verbatim and in order, not reconstructed.
    // 按对齐到的那几条消息本身核对（不按内容找），近期原文里有重复发言也不会误判。
    const retainedRecent = recentFloors.map(floor => candidate.indexOf(original[map.found.get(floor)]));
    if (retainedRecent.some((at, index) => at < 0 || index && at <= retainedRecent[index - 1])) return failure('recent-originals-missing');
    return {
        applied: true, reason: actualRemovedFloors.length ? 'source-replaced' : 'memory-added', messages: candidate,
        entries: admitted, tokens: tokenEstimate([memoryMessage(admitted, entryOrder)]), requestTokens: counted.tokens,
        nativeRequestTokens: counted.measured, countingMethod: counted.method, contextTokens, responseTokens,
        removedFloors: actualRemovedFloors.sort((a, b) => a - b), recentFloors, estimated: true,
        sourceReplacement: actualRemovedFloors.length > 0,
    };
}
