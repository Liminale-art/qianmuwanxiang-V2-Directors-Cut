import { DEFAULTS, shownFloor, effectiveSettings, fingerprintMessages, sourceMatches } from './contract.mjs';
import { sourceRanges, stageDependenciesValid, hasCustomParents } from './stage-contract.mjs';
import { excerptDependenciesValid } from './recall-contract.mjs';
import { inheritedSourceValid, sourceLabel, sourceTimelineEnd, hasCompanionBook, COMPANION_BOOK_NOTICE } from './source-scope.mjs';
import { companionEntries, companionBooks } from './companion-contract.mjs';
import { orderForInjection, placementMatches, validatePlacement, validateMemoryTitle, memoryTitle, MEMORY_TITLE_LIMIT } from './timeline.mjs';
import { validateScenes, sceneProjection, sceneDependenciesValid, validateGeneratedLength, generatedTextLength, SCENE_PROMPT } from './scene-contract.mjs';
import { composePrompt } from './prompt-settings.mjs';
import { filterContextText } from './context-filter.mjs';
import { memoryWarmth, admitsAtWarmth, asksToRemember } from './decay.mjs';

export const estimateTokens = text => Math.ceil(Array.from(String(text)).reduce((n, ch) => n + (ch.codePointAt(0) > 127 ? 1 : 0.35), 0));
const canSummarize = message => message && typeof message.mes === 'string' && message.mes.trim()
    && !message.extra?.tool_invocations && !message.tool_calls && !message.tool_call_id;

// Hidden is ST's prompt/display flag, not permission to exclude story sources.
// It remains untouched; recent raw text and handled sources are counted separately.
export function initialRangePreview(document, messages, { start, end }, { recent = DEFAULTS.recent } = {}) {
    const result = { valid: false, hidden: [], recent: [], handled: [], unsupported: [], eligible: [] };
    if (!Array.isArray(messages) || !Number.isSafeInteger(start) || !Number.isSafeInteger(end)
        || start < 1 || end < start || end > messages.length || !Number.isSafeInteger(recent) || recent < 1) return result;
    result.valid = true;
    const last = Math.max(0, messages.length - recent);
    for (let floor = start; floor <= end; floor++) {
        const message = messages[floor - 1];
        if (message?.is_system) result.hidden.push(floor);
        if (floor > last) result.recent.push(floor);
        else if (floor <= (document?.lineage?.bridgeCount || 0) || document?.entries?.some(entry => !entry.origin && entry.kind === 'summary'
            && entry.source.start <= floor && entry.source.end >= floor)) result.handled.push(floor);
        else if (!canSummarize(message)) result.unsupported.push(floor);
        else result.eligible.push(floor);
    }
    return result;
}

export async function inspectSources(document, messages) {
    const hashes = await fingerprintMessages(messages);
    const invalid = document.entries.filter(entry => entry.source && entry.status === 'active' && (!(entry.origin ? inheritedSourceValid(entry, document, hashes) : sourceRanges(entry).every(range => sourceMatches(range, hashes)))
        || entry.kind === 'stage' && !stageDependenciesValid(entry, document)
        || !sceneDependenciesValid(entry, document)
        || entry.kind === 'excerpt' && !excerptDependenciesValid(entry, document)))
        .map(entry => ({ id: entry.id, revision: entry.revision }));
    return { hashes, invalid };
}

// Each batch is bounded by content, while the model splits it at narrative boundaries.
// Chosen initial gaps and explicit exclusions/deletions never get silently filled.
export function nextBatch(document, messages, settings, { force = false, historyOnly = false, limitEnd = Infinity } = {}) {
    if (!document.enabled || !document.initialRange || !force && !document.autoSummary) return null;
    const last = Math.min(Math.max(0, messages.length - settings.recent), historyOnly ? document.initialRange.end : Infinity, limitEnd);
    const capacity = settings.inputCapacity ?? settings.batch ?? settings.trigger;
    // A changed source is a quiet review state, not an automatic repair job.
    // Keep the old slice available for injection and let the user explicitly
    // choose redo/edit/delete from the memory page.
    const { start: initialStart, end: initialEnd, total: initialTotal } = document.initialRange;
    const eligible = floor => floor > (document.lineage?.bridgeCount || 0) && (floor <= initialEnd || floor > initialTotal) && canSummarize(messages[floor - 1])
        && !document.entries.some(entry => !entry.origin && entry.kind === 'summary' && entry.source.start <= floor && entry.source.end >= floor);
    const first = Array.from({ length: Math.max(0, last - initialStart + 1) }, (_, index) => initialStart + index).find(eligible);
    if (!first) return null;
    let targetEnd = last;
    if (!force && first > initialTotal) {
        // 楼层触发只数「保留区之外」的未整理楼层：最新保留层不算进度，它们本来就不总结。
        // 保留 5 层、触发 10 层时，只有保留区外攒够 10 层才动，而不是 6 层就动。
        const floors = settings.triggerFloors > 0 ? settings.triggerFloors : Infinity;
        let unsummarized = 0;
        for (let floor = first; floor <= last && unsummarized < floors; floor++) if (eligible(floor)) unsummarized++;
        if (unsummarized < floors) {
            // 楼层没到就退回 token 口径：两者先到先触发，但都只在保留区之外计算。
            let pending = 0; targetEnd = 0;
            for (let floor = first; floor <= last; floor++) if (eligible(floor)) {
                pending += estimateTokens(messages[floor - 1].mes);
                if (pending >= settings.trigger) { targetEnd = floor; break; }
            }
            if (!targetEnd) return null;
        }
    }
    let start = 0, end = 0, tokens = 0;
    for (let floor = first; floor <= targetEnd; floor++) {
        if (!eligible(floor)) { if (start) break; continue; }
        const size = estimateTokens(messages[floor - 1].mes);
        const fits = tokens + size <= capacity && (!settings.fitsSummaryBatch || settings.fitsSummaryBatch(messages, { start: start || floor, end: floor }));
        if (start && !fits) break;
        // A single very large floor is never silently truncated into a misleading summary.
        if (!start && !fits) throw new Error(`第 ${shownFloor(floor)} 层与总结提示词超过此连接的可用输入容量，请为忆幕选择容量足够的连接`);
        if (!start) start = floor;
        end = floor; tokens += size;
        if (tokens >= settings.trigger) break;
    }
    if (!start) return null;
    return { start, end, ...(!force && start > initialTotal && end < targetEnd ? { targetEnd } : {}) };
}

/** Manual summary batch size in floors. A user preference of the manual card only;
 * the automatic trigger, recent floors and floor trigger never shape manual batches. */
export const MANUAL_BATCH_FLOORS = 20;
export const MANUAL_BATCH_LIMIT = 2000;
export const manualBatchFloors = value => Number.isSafeInteger(value) && value >= 1 && value <= MANUAL_BATCH_LIMIT ? value : MANUAL_BATCH_FLOORS;

/** Read-only manual scope preview. Never relabel part of an old summary as if its
 * text only described the remainder. Expand to complete affected slices first;
 * the caller must show and confirm these actual bounds before sending originals.
 * New floors are cut every batchFloors floors, shortened only when the connection
 * cannot hold them; a floor is never truncated. Existing slices are redone whole. */
export function planManualRange(document, messages, settings, requestedRange, { batchFloors } = {}) {
    const perBatch = manualBatchFloors(batchFloors);
    const requested = { start: requestedRange?.start, end: requestedRange?.end };
    if (!Array.isArray(messages) || !Number.isSafeInteger(requested.start) || !Number.isSafeInteger(requested.end)
        || requested.start < 1 || requested.end < requested.start || requested.end > messages.length) throw new Error('请选择有效的起止楼层');
    const range = { ...requested };
    const discarded = (document?.entries || []).filter(entry => entry.kind === 'summary' && !entry.origin && entry.discarded);
    // A purged deletion has no old text left to redo or preserve. Only this explicit
    // manual planner may create fresh summaries there; the deletion guard remains.
    const summaries = (document?.entries || []).filter(entry => entry.kind === 'summary' && !entry.origin && !entry.discarded && !entry.replacedBy)
        .sort((a, b) => a.source.start - b.source.start || a.source.end - b.source.end);
    for (let changed = true; changed;) {
        changed = false;
        for (const entry of summaries) if (entry.source.start <= range.end && entry.source.end >= range.start) {
            const start = Math.min(range.start, entry.source.start), end = Math.max(range.end, entry.source.end);
            changed ||= start !== range.start || end !== range.end;
            range.start = start; range.end = end;
        }
    }
    if (range.end > messages.length) throw new Error('已有记忆的对应楼层已不存在，请先处理来源变化');
    if (range.start <= (document?.lineage?.bridgeCount || 0)) throw new Error('此范围含续接原文，请从新剧情开始整理；继承记忆可直接修订');
    if (summaries.some(entry => ['deleted', 'excluded'].includes(entry.status) && entry.source.start <= range.end && entry.source.end >= range.start)) {
        throw new Error('此范围含已删除或暂不使用的记忆，请先恢复或调整范围');
    }
    const overlapping = summaries.filter(entry => entry.source.start <= range.end && entry.source.end >= range.start);
    if (overlapping.some((entry, index) => index > 0 && entry.source.start <= overlapping[index - 1].source.end)) throw new Error('已有切片范围重叠，请先处理记忆冲突');
    const batchLimit = settings?.inputCapacity ?? settings?.batch ?? settings?.trigger;
    if (!Number.isSafeInteger(batchLimit) || batchLimit < 1) throw new Error('此连接的可用输入容量无效，请检查 API 设置');
    for (let floor = range.start; floor <= range.end; floor++) if (!canSummarize(messages[floor - 1])) {
        throw new Error(`第 ${shownFloor(floor)} 层为空或含工具调用，请调整整理范围`);
    }
    const batches = [];
    // 批次按「每批 N 层」切，不按既有切片的边界切：一层一片的旧记忆不会再把一次整理拆成一楼一次。
    // 能整批替换的只有「自动生成、未人工改过」的切片。人工改过的切片当成分界：本批到它之前结束，
    // 它自己留给用户单独重做，绝不会被顺带覆盖。
    const owned = summaries.filter(entry => !entry.edited);
    for (let floor = range.start; floor <= range.end;) {
        // 人工改过的切片：用户明确从它开头重新整理时，只重做这一条，结果作为待选版本给用户挑，
        // 绝不和别的楼层混在一批里被顺带覆盖。
        const edited = summaries.find(entry => entry.edited && entry.source.start === floor);
        if (edited) {
            batches.push({ start: edited.source.start, end: edited.source.end, redo: structuredClone(edited) });
            floor = edited.source.end + 1;
            continue;
        }
        let end = Math.min(range.end, floor + perBatch - 1);
        // 终点落在旧切片中间时延到它结束，保证整条切片被完整重做、不被截成两半。
        for (let changed = true; changed;) {
            changed = false;
            for (const entry of owned) {
                if (entry.source.start >= floor && entry.source.start <= end && entry.source.end > end) { end = Math.min(range.end, entry.source.end); changed = true; }
            }
        }
        // 人工改过的切片整条落在本批里就把它让出去；起点在本批内也让它从下一批开始。
        const manual = summaries.filter(entry => entry.edited && entry.source.end >= floor)
            .sort((a, b) => a.source.start - b.source.start)[0];
        if (manual && manual.source.start <= end) end = manual.source.start - 1;
        if (end < floor) { floor = manual.source.end + 1; continue; }
        let tokens = messages.slice(floor - 1, end).reduce((total, item) => total + estimateTokens(item.mes), 0);
        // 连接放不下时整批缩小；只缩到本批终点不落进任何旧切片中间为止，缩不下去就如实报容量不足。
        const straddles = stop => owned.some(entry => entry.source.start >= floor && entry.source.start <= stop && entry.source.end > stop);
        let blocked = false;
        while ((tokens > batchLimit || settings.fitsSummaryBatch && !settings.fitsSummaryBatch(messages, { start: floor, end })) && end > floor) {
            if (straddles(end - 1)) { blocked = true; break; }
            end--; blocked = false;
            tokens = messages.slice(floor - 1, end).reduce((total, item) => total + estimateTokens(item.mes), 0);
        }
        if (blocked || tokens > batchLimit && end === floor || settings.fitsSummaryBatch && !settings.fitsSummaryBatch(messages, { start: floor, end })) {
            throw new Error(`第 ${shownFloor(floor)}—${shownFloor(end)} 层与总结提示词超过此连接的可用输入容量，请缩小整理范围或选择容量足够的连接`);
        }
        // 本批覆盖到的整条自动切片一起替换，一次请求重做这一段。
        const replaces = owned.filter(entry => entry.source.start >= floor && entry.source.end <= end)
            .map(entry => ({ id: entry.id, revision: entry.revision, source: structuredClone(entry.source) }));
        const discardedSources = discarded.filter(entry => entry.source.start <= end && entry.source.end >= floor)
            .map(entry => ({ id: entry.id, revision: entry.revision, source: structuredClone(entry.source) }));
        batches.push({ start: floor, end, ...(replaces.length ? { replaces } : {}), ...(discardedSources.length ? { discardedSources } : {}) });
        floor = end + 1;
    }
    return { requestedRange: requested, range, expanded: range.start !== requested.start || range.end !== requested.end, batches };
}

/** 隐藏边界：可见的永远是最近「正文保留层数」层，之前被总结覆盖过的楼层一律原生隐藏。
 *  这是独立规则，不由「本轮注入了哪几条记忆」决定——否则注入少一次，旧楼就会多露出一次。
 *  只在「确实有有效切片覆盖」时才隐藏（fail-closed）：宁可多留原文，绝不出现原文与记忆同时消失。
 *  返回隐藏前沿（从 1 起连续被覆盖到的最大楼层）和本次应处于隐藏状态的楼层。 */
export function hiddenFloorsFor(document, messages, { recent = DEFAULTS.recent, excludeEnd = 0 } = {}) {
    const total = Array.isArray(messages) ? messages.length - Math.max(0, excludeEnd) : 0;
    if (!total) return { frontier: 0, floors: [] };
    // 只有整个范围都被覆盖才算：缺口之后的内容不能因为后面又被总结过就跟着藏起来。
    const covered = new Uint8Array(total + 1);
    for (const entry of document?.entries || []) {
        if (entry.kind !== 'summary' || entry.origin || entry.discarded || !['active', 'invalid'].includes(entry.status)) continue;
        // 这里只读范围、不校验来源：隐藏边界每轮都要算，不能因为某条旧数据的指纹不全就中断整轮。
        const ranges = Array.isArray(entry.source?.ranges) ? entry.source.ranges : entry.source ? [entry.source] : [];
        for (const range of ranges) {
            if (!Number.isSafeInteger(range?.start) || !Number.isSafeInteger(range?.end)) continue;
            for (let floor = Math.max(1, range.start); floor <= Math.min(total, range.end); floor++) covered[floor] = 1;
        }
    }
    let frontier = 0;
    while (frontier + 1 <= total && covered[frontier + 1]) frontier++;
    const keep = Math.min(total, Math.max(0, recent));
    const limit = Math.max(0, total - keep);
    // 保留区永远保留原文，即使它已经被总结覆盖过（手动总结也不动这几层）。
    const end = Math.min(frontier, limit);
    const floors = [];
    for (let floor = 1; floor <= end; floor++) floors.push(floor);
    return { frontier, floors, keep, total };
}

/** Default manual range: continue after the latest usable local slice up to the
 * current last floor. Invalid (source-changed) slices do not advance it, so they
 * are offered again; this is only a suggestion and never overrides user input. */
export function manualRangeDefault(document, messages, invalidIds = []) {
    const total = Array.isArray(messages) ? messages.length : 0;
    if (!total) return null;
    let start = (document?.lineage?.bridgeCount || 0) + 1;
    for (const entry of document?.entries || []) {
        if (entry.kind !== 'summary' || entry.origin || entry.discarded || entry.status === 'invalid' || invalidIds.includes(entry.id)) continue;
        if (Number.isSafeInteger(entry.source?.end)) start = Math.max(start, entry.source.end + 1);
    }
    while (start <= total && !canSummarize(messages[start - 1])) start++;
    return start > total ? { start: total, end: total, complete: true } : { start, end: total, complete: false };
}

/** Count independent fine/custom slices once; stage/excerpt reading layers are not extra originals. */
export function summaryCoverage(document, messages, settings) {
    const covered = new Set(), entries = document?.entries || [];
    const active = entries.filter(entry => entry.kind === 'summary' && ['active', 'invalid'].includes(entry.status)
        && (!entry.origin || entry.originVerified === true));
    for (const entry of active) {
        // Inherited source numbers belong to another chat, not the local floor counter.
        if (entry.origin) continue;
        for (let floor = entry.source.start; floor <= Math.min(entry.source.end, messages.length); floor++) covered.add(floor);
    }
    let pendingFloors = 0, pendingRange = null;
    const range = document?.initialRange, last = Math.max(0, messages.length - settings.recent);
    if (range) for (let floor = Math.max(range.start, (document?.lineage?.bridgeCount || 0) + 1); floor <= last; floor++) {
        if (!(floor <= range.end || floor > range.total) || !canSummarize(messages[floor - 1])) continue;
        const handled = entries.some(entry => !entry.origin && entry.kind === 'summary' && entry.source.start <= floor && entry.source.end >= floor);
        if (!handled) { pendingFloors++; pendingRange = pendingRange ? { ...pendingRange, end: floor } : { start: floor, end: floor }; }
    }
    const custom = entries.filter(entry => entry.kind === 'manual' && entry.status === 'active' && !entry.origin?.unresolved
        && entry.placementVerified !== false && (() => {
            if (!entry.placement) return !entry.origin; // Retain the count of legacy source-free user originals.
            try {
                const placement = validatePlacement(entry.placement, { binding: entry.origin?.binding || document.binding });
                return entry.origin ? entry.placementVerified === true && placement.fromFloor + (entry.origin.offset || 0) <= messages.length + (document.lineage?.offset || 0)
                    : placement.fromFloor <= messages.length;
            } catch { return false; }
        })());
    return { sliceCount: active.length + custom.length, organizedFloors: covered.size, pendingFloors, pendingRange };
}

/** 开启自动总结之前就存在的楼层，目前只能手动补。返回第一段连续可整理的楼层，
 *  供一键填入范围；中间夹着已整理或不可整理的楼层时到此为止，补完这一段按钮会再出现。
 *  只看原文保留层以外的部分。 */
export function preEnablePending(document, messages, settings) {
    const range = document?.initialRange;
    if (!range || !Array.isArray(messages) || !messages.length) return null;
    const entries = document?.entries || [];
    const last = Math.min(range.total, Math.max(0, messages.length - (settings?.recent ?? DEFAULTS.recent)));
    let start = 0, end = 0, count = 0;
    for (let floor = Math.max(1, (document?.lineage?.bridgeCount || 0) + 1); floor <= last; floor++) {
        if (!canSummarize(messages[floor - 1])) continue;
        // 与统计口径一致：任何切片覆盖过的楼层都算已整理，包括被删除或屏蔽的那条，
        // 这样填进去的范围不会立刻被「含已删除记忆」拦下。
        if (entries.some(entry => !entry.origin && entry.kind === 'summary'
            && entry.source.start <= floor && entry.source.end >= floor)) continue;
        if (!start) start = floor;
        else if (floor !== end + 1) break;
        end = floor; count++;
    }
    return start ? { start, end, count } : null;
}

/** 相邻碎片合并。模型常把一层写成一片，切片数量一多压缩就白做。
 *  只并「连续、场景相容、其中一片明显偏短」的相邻切片，且合并后仍在上限内。
 *  场景相容包括两种情况：两片都有依据且场景字段完全一致；或两片都没有场景信息（最常见的模型输出）。
 *  换地点、换时间、换视角、回忆／梦境等不同场景一律保留原样。 */
export const FRAGMENT_RATIO = 0.5;
const sceneSignature = scene => JSON.stringify([scene?.world, scene?.timeline, scene?.date, scene?.period, scene?.place, scene?.nature]);
const sceneUnproven = scene => !(scene?.evidence?.floors || []).length && !scene?.evidence?.inheritedFrom
    && (scene?.nature || 'unknown') === 'unknown' && !scene?.world && !scene?.timeline && !scene?.date && !scene?.period && !scene?.place;
const scenesCompatible = (a, b) => sceneUnproven(a) && sceneUnproven(b)
    || (a?.evidence?.floors || []).length > 0 && (b?.evidence?.floors || []).length > 0 && sceneSignature(a) === sceneSignature(b);
export function coalesceFragments(entries, settings = {}) {
    const cap = settings.sliceChars ?? 2000;
    if (!Array.isArray(entries) || !Number.isSafeInteger(cap) || cap < 1) return entries;
    const out = [];
    for (const entry of entries) {
        const last = out.at(-1);
        const mergeable = last && last.kind === 'summary' && entry.kind === 'summary'
            && last.source.end + 1 === entry.source.start
            && (last.scenes || []).length === 1 && (entry.scenes || []).length === 1
            && scenesCompatible(last.scenes[0], entry.scenes[0])
            && Math.min(generatedTextLength(last), generatedTextLength(entry)) < cap * FRAGMENT_RATIO
            && generatedTextLength({ ...last, text: [last.text, entry.text].join('\n'),
                scenes: [mergeScenes(last.scenes[0], entry.scenes[0])] }) <= cap;
        if (!mergeable) { out.push(entry); continue; }
        const longer = generatedTextLength(entry) > generatedTextLength(last) ? entry : last;
        out[out.length - 1] = { ...last, title: longer.title, text: [last.text, entry.text].join('\n'),
            scenes: [mergeScenes(last.scenes[0], entry.scenes[0])],
            source: { ...last.source, end: entry.source.end, hashes: [...last.source.hashes, ...entry.source.hashes] } };
    }
    return out;
}
function mergeScenes(a, b) {
    const floors = [...new Set([...(a?.evidence?.floors || []), ...(b?.evidence?.floors || [])])].sort((x, y) => x - y);
    return { ...a, event: [a?.event, b?.event].filter(Boolean).join('；'), evidence: { ...(a?.evidence || {}), floors },
        ...(a?.characters?.length || b?.characters?.length ? { characters: [...new Set([...(a?.characters || []), ...(b?.characters || [])])] } : {}) };
}

export function summaryPrompt(messages, batch, settings, { recallCandidates = [], previousContext = [] } = {}) {
    const source = messages.slice(batch.start - 1, batch.end).map((message, i) => ({
        floor: batch.start + i, speaker: String(message.name || ''), role: message.is_user ? 'user' : 'character', text: filterContextText(message.mes || '', settings.contextRules),
    }));
    return composePrompt(settings, 'summary', {
        protocol: `输出一个JSON对象，不用Markdown：{"slices":[{"start":起始楼层整数,"end":结束楼层整数,"title":"不超过${MEMORY_TITLE_LIMIT}字的正文事件短名","text":"精炼、自足的记忆","scenes":[]}]}。title依据本片原文的主要事件起名，不超过${MEMORY_TITLE_LIMIT}个Unicode字符，不用楼层、时间或套话充当事件名，不新增正文没有的事实。
slices必须依次完整覆盖第${batch.start}至${batch.end}层，不得越界、重叠或漏层；每片正文非空。每片正文及可见场景文字合计不得超过 ${settings.sliceChars ?? 2000} 字，按非空白Unicode字符计（标点、英文、数字各计一），不是输入token量；不得靠删除事实边界或截断原文规避。
切片数量取决于场景与结算点，不取决于楼层数；不得一层一片。
${SCENE_PROMPT}
有据继承时 evidence 可另含 inheritedFrom:{id,revision}，只能引用本次提供的上文锚点，不得编造ID、版本或从当前排列推定日期。
${recallCandidates.length ? '本批确有明确旧细节缺口时，可额外返回recallRequests:[{"parentId":"目录中的id","question":"具体问题"}]，最多一个；无需要省略或[]。' : ''}`,
        data: `来源有效的上文锚点：${JSON.stringify(previousContext)}\n原文：${JSON.stringify(source)}${recallCandidates.length ? `\n可回查的旧细摘要目录：${JSON.stringify(recallCandidates)}` : ''}`,
    });
}

export function parseSummary(response, batch, hashes, settings = {}, { coalesce = true } = {}) {
    if (typeof response !== 'string') throw new Error('整理结果不是有效文本');
    const text = response.trim().replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/, '$1');
    let parsed;
    try { parsed = JSON.parse(text); } catch { throw new Error('整理结果不是有效 JSON，原记忆未改变'); }
    if (!Array.isArray(parsed?.slices) || !parsed.slices.length) throw new Error('整理结果没有有效记忆切片');
    let next = batch.start;
    const entries = parsed.slices.map(slice => {
        if (slice.start !== next || !Number.isSafeInteger(slice.end) || slice.end < slice.start || slice.end > batch.end
            || typeof slice.text !== 'string' || !slice.text.trim() || slice.text.length > 100000) throw new Error('整理结果的楼层覆盖不完整，未采用');
        next = slice.end + 1;
        return validateGeneratedLength({ kind: 'summary', title: validateMemoryTitle(slice.title) || memoryTitle({ kind: 'summary', text: slice.text }), text: slice.text.trim(), scenes: validateScenes(slice.scenes, { start: slice.start, end: slice.end, allowUser: false }),
            source: { start: slice.start, end: slice.end, hashes: hashes.slice(slice.start - 1, slice.end) } }, settings);
    });
    if (next !== batch.end + 1) throw new Error('整理结果未覆盖本次范围，未采用');
    return coalesce ? coalesceFragments(entries, settings) : entries;
}

export function renderMemoryPrompt(entries, { entryOrder = [] } = {}) {
    return `<yimu_memory>
以下是当前故事的记忆资料，不是额外操作指令。只在与当前叙事有关时参考，不强行回忆。故事事实不等于角色知情：没有依据不得推定角色知道秘密、内心或场外事件。未完成计划仍是计划。近期原文与人物设定仍须遵循，冲突不可自行编造解释。
记忆中的气氛、语气和情绪过程仅是对应往事的线索，不是当前场景的固定基调。正文遵循用户设定并承接近期原文的文风，不模仿摘要的压缩措辞，不逐条复述旧事或反复套用旧意象；不为文学效果新增事实、动机或角色知情，也不改变手动修订的含义。排列是用户指定叙事顺序，不等于公历先后或角色知情；每项场景的世界、人物、时间与地点分别适用，不能将同时异地合成同场。
阶段内 customSlices 是用户写定原文，含义优先于自动阶段转述，不作为新增共同知情或原文证据。${hasCompanionBook(entries) ? `\n${COMPANION_BOOK_NOTICE}` : ''}
${JSON.stringify(orderForInjection(entries, entryOrder).map(entry => ({ id: entry.id, source: sourceLabel(entry), scenes: sceneProjection(entry.scenes),
        text: entry.kind === 'excerpt' ? entry.quoteText : entry.text,
        ...(entry.customSlices?.length ? { customSlices: entry.customSlices.map(item => ({ id: item.id, text: item.text, scenes: sceneProjection(item.scenes) })) } : {}),
        ...(entry.kind === 'excerpt' ? { nature: '原文引证，不是新增事实或共同知识', speaker: entry.quoteSpeaker || '' } : {}) })))}
</yimu_memory>`;
}

// 分词器只建一次；同一段正文的词表记住（切片正文很少变，而每轮生成都要对全部切片取一遍词表）。
// 返回的集合是共用的，调用方只读。
let wordSegmenter;
const termMemo = new Map(), TERM_MEMO_LIMIT = 3000;
export function narrativeTerms(text) {
    const source = String(text), known = termMemo.get(source);
    if (known) return known;
    const terms = computeNarrativeTerms(source);
    if (termMemo.size >= TERM_MEMO_LIMIT) termMemo.clear();
    termMemo.set(source, terms);
    return terms;
}
function computeNarrativeTerms(text) {
    const normalized = String(text).normalize('NFKC').toLowerCase();
    const words = typeof Intl.Segmenter === 'function' ? [...(wordSegmenter ||= new Intl.Segmenter('zh', { granularity: 'word' })).segment(normalized)]
        .filter(part => part.isWordLike).map(part => part.segment) : normalized.match(/[\p{L}\p{N}]+/gu) || [];
    return new Set(words.filter(word => word.length > 1).slice(-200));
}

/**
 * Keep companion sharing deliberately small and explicit. Normal source-backed
 * Yimu slices are shareable once the chat association is enabled. Custom slices
 * are private by default; a stage that contains one is also withheld as a
 * whole, because a generated stage is not safely separable back into its
 * manual and source-backed portions. This is a policy filter, not a validity
 * check: source hashes and disabled/deleted entries have already been handled
 * by selectMemories/buildPlan.
 */
export function filterCompanionEntries(entries = [], document = {}, { includeCustom = false } = {}) {
    if (includeCustom) return entries;
    const byId = new Map((document.entries || []).map(entry => [entry.id, entry]));
    const hasCustomParent = entry => {
        if (entry.kind === 'manual') return true;
        if (entry.kind === 'stage') return (entry.source?.parents || []).some(ref => byId.get(ref.id)?.kind === 'manual')
            || (entry.customSlices || []).length > 0;
        if (entry.kind === 'excerpt') return byId.get(entry.parent?.id)?.kind === 'manual';
        return false;
    };
    return entries.filter(entry => !hasCustomParent(entry));
}

export function selectMemories(document, snapshot, settings, hashes, type = '', semantic = null, queryText = '', recalledAt = null) {
    const visibleEnd = snapshot.messages.length - (type === 'swipe' ? 1 : 0);
    const cutoff = visibleEnd - settings.recent;
    const usable = document.entries.filter(entry => {
        if (!['active', 'invalid'].includes(entry.status)) return false;
        // Invalid source-backed entries remain usable. Their old text is still
        // valuable context, while final admission deliberately keeps the raw
        // edited/deleted floors instead of replacing them.
        const stale = entry.status === 'invalid';
        // A missing quotation is not a source-change case: there is no text to
        // inject, so keep the existing fail-closed behavior for excerpts.
        if (entry.kind === 'excerpt' && !(typeof entry.quoteText === 'string' && entry.quoteText.trim())) return false;
        if (entry.kind === 'manual') return placementMatches(entry, document, hashes, visibleEnd);
        const sceneValid = sceneDependenciesValid(entry, document);
        const sourceValid = entry.origin
            ? inheritedSourceValid(entry, document, hashes) && sourceTimelineEnd(entry, document) <= (document.lineage?.offset || 0) + cutoff
            : sourceRanges(entry).every(range => range.end <= cutoff && sourceMatches(range, hashes));
        const stageValid = entry.kind !== 'stage' || stageDependenciesValid(entry, document) && entry.source.parents.every(ref => {
            const parent = document.entries.find(item => item.id === ref.id);
            return parent?.kind !== 'manual' || placementMatches(parent, document, hashes, visibleEnd);
        });
        const excerptValid = entry.kind !== 'excerpt' || excerptDependenciesValid(entry, document);
        return stale || sceneValid && sourceValid && stageValid && excerptValid;
    });
    // A changed/disabled hand-edited stage must not be silently bypassed by its automatic children.
    const authoritativeStages = document.entries.filter(entry => entry.kind === 'stage' && !entry.replacedBy && (entry.edited || ['excluded', 'deleted'].includes(entry.status)));
    const protectedParents = new Set(authoritativeStages
        .flatMap(entry => entry.source.parents.map(ref => ref.id)));
    // A caller-supplied query (the companion's own question) replaces the story's recent window for relevance only.
    const asked = typeof queryText === 'string' ? queryText.trim() : '';
    const recent = asked || snapshot.messages.slice(Math.max(0, visibleEnd - settings.recent), visibleEnd).map(m => m.mes || '').join('\n');
    const query = narrativeTerms(recent);
    // Linked reading memories. The shared layer (what the two said and noted while
    // reading) competes on the same wording as story memories; book content does not.
    const books = companionBooks(document.companion), linked = companionEntries(document.companion, books);
    const shared = linked.filter(entry => entry.companion.layer === 'shared'), pool = [...usable, ...shared];
    const terms = new Map(pool.map(entry => [entry.id, narrativeTerms(entry.text)]));
    const frequency = new Map();
    for (const values of terms.values()) for (const term of values) frequency.set(term, (frequency.get(term) || 0) + 1);
    const lexical = entry => [...query].reduce((score, term) => score + (terms.get(entry.id)?.has(term) ? Math.log(1 + pool.length / (frequency.get(term) || 1)) : 0), 0);
    // 向量相似度（可选）只参与排序：把各条的相似度拉到 0～1，再按关键词得分的量级加进去。
    // 它不能让失效、屏蔽或删除的条目回来，也不改变谁有权替换原文。
    const similar = usable.map(entry => semantic?.get?.(entry.id)).filter(Number.isFinite);
    const low = Math.min(...similar), span = Math.max(...similar) - low, scale = similar.length ? Math.max(1, ...usable.map(lexical)) : 0;
    const relevance = entry => lexical(entry) + (similar.length && Number.isFinite(semantic.get(entry.id)) ? (span > 0 ? (semantic.get(entry.id) - low) / span : 1) * scale : 0);
    // 遗忘：按剧情进度衰减。淡去的需要更明确的相关，沉底的只有强线索才唤起；
    // 钉住的不参与衰减。这只是门槛，不改变谁排前面，也不改变谁有权替换原文。
    const floorNow = visibleEnd;
    const warmthOf = entry => memoryWarmth(entry, { floor: floorNow, lastUsedFloor: recalledAt?.get?.(entry.id) ?? null, settings });
    const strongHint = asksToRemember(recent);
    // 一条记忆里的专名直接出现在当前正文里，才算「明确点名」。
    const namedNow = entry => [...narrativeTerms(entry.text)].some(term => term.length >= 2 && query.has(term));
    const chosenStages = [];
    const overlaps = (a, b) => a.source.parents.some(ref => b.source.parents.some(other => other.id === ref.id));
    // A stale automatic stage only stands in while no current reading exists. If
    // every parent is still injectable (e.g. the user revised one), the parents
    // are the newer truth and must not be hidden behind the old stage text.
    const supersededByParents = entry => entry.status === 'invalid' && !entry.edited && !hasCustomParents(entry, document)
        && entry.source.parents.every(ref => usable.some(item => item.id === ref.id && item.status === 'active'));
    const stageCandidates = usable.filter(entry => entry.kind === 'stage' && !supersededByParents(entry)
        && !authoritativeStages.some(other => other.id !== entry.id && overlaps(entry, other)));
    // Old/externally altered data must not inject competing readings for the same
    // source. Protected human stages take precedence; ambiguous automatic stages
    // fall back to their valid fine summaries instead of choosing a random winner.
    for (const stage of stageCandidates.filter(entry => !stageCandidates.some(other => other.id !== entry.id && overlaps(entry, other)))) {
        const children = usable.filter(entry => stage.source.parents.some(ref => ref.id === entry.id));
        const detailNeeded = settings.recall !== false && !stage.edited && children.some(child => relevance(child) > relevance(stage) && relevance(child) > 0);
        if (!detailNeeded) chosenStages.push(stage);
    }
    const grouped = new Set(chosenStages.flatMap(stage => stage.source.parents.map(ref => ref.id)));
    const candidates = [...chosenStages, ...usable.filter(entry => !['stage', 'excerpt'].includes(entry.kind) && !grouped.has(entry.id) && !protectedParents.has(entry.id))];
    const end = entry => sourceTimelineEnd(entry, document) + (entry.origin ? 0 : document.lineage?.offset || 0);
    const currentBackground = new Set(candidates.filter(entry => entry.kind !== 'manual').sort((a, b) => end(b) - end(a)).slice(0, 2).map(e => e.id));
    const protectedContent = entry => entry.edited || entry.kind === 'manual' || hasCustomParents(entry, document);
    // 遗忘门槛：人工内容（编辑过的、自定义切片、含自定义的）不受衰减影响——那是用户自己写定的东西。
    const warmEligible = entry => {
        if (protectedContent(entry)) return true;
        const warmth = warmthOf(entry);
        if (warmth === 'fresh') return true;
        return admitsAtWarmth({ warmth, score: relevance(entry), strong: strongHint || namedNow(entry) });
    };
    const selected = candidates.filter(entry => warmEligible(entry)
        && (protectedContent(entry) || currentBackground.has(entry.id) || relevance(entry) > 0));
    selected.sort((a, b) => Number(protectedContent(b)) - Number(protectedContent(a)) || relevance(b) - relevance(a) || Number(currentBackground.has(b.id)) - Number(currentBackground.has(a.id)) || end(b) - end(a));
    // A saved excerpt accompanies its selected parent reading layer; it is never
    // allowed to stand in for a whole source floor on its own.
    const story = selected.flatMap(entry => [entry.kind === 'stage' && entry.source.parents.some(ref => document.entries.find(item => item.id === ref.id)?.kind === 'manual')
        ? { ...entry, customSlices: entry.source.parents.map(ref => document.entries.find(item => item.id === ref.id)).filter(parent => parent?.kind === 'manual')
            .map(parent => ({ id: parent.id, text: parent.text, scenes: parent.scenes })),
            fallbackEntries: entry.source.parents.map(ref => document.entries.find(item => item.id === ref.id)).filter(parent => parent && usable.some(item => item.id === parent.id))
                .sort((a, b) => Number(b.kind === 'manual') - Number(a.kind === 'manual')) }
        : entry, ...usable.filter(item => item.kind === 'excerpt'
        && (item.parent.id === entry.id || entry.kind === 'stage' && entry.source.parents.some(ref => ref.id === item.parent.id)))]);
    if (!linked.length) return story;
    const newest = (a, b) => b.companion.seq - a.companion.seq || b.companion.readTo - a.companion.readTo;
    // Shared layer: what bears on the current wording, the latest two exchanges of
    // each book and every note; six at most, so reading never crowds out the story.
    const wanted = new Set();
    for (const book of books) {
        const own = shared.filter(entry => entry.companion.book === book.key);
        for (const entry of own.filter(item => item.companion.kind !== 'note').sort(newest).slice(0, 2)) wanted.add(entry.id);
        for (const entry of own) if (entry.companion.kind === 'note' || relevance(entry) > 0) wanted.add(entry.id);
    }
    const sharedChosen = shared.filter(entry => wanted.has(entry.id)).sort((a, b) => relevance(b) - relevance(a) || newest(a, b)).slice(0, SHARED_LAYER_LIMIT);
    // Book layer: a book's content is brought only when that book is being talked
    // about. Each book has its own gate, so mentioning one never pulls another.
    const plain = value => String(value || '').normalize('NFKC').toLowerCase().trim(), spoken = plain(recent);
    const mentioned = value => { const term = plain(value); return term.length >= 2 && spoken.includes(term); };
    const scored = semantic ? [...semantic].filter(([, value]) => Number.isFinite(value)) : [];
    // A similarity lead only means something against competition: with fewer than
    // three scored story memories every book slice would lead and the gate would never close.
    const bookIds = new Set(linked.filter(entry => entry.companion.layer === 'book').map(entry => entry.id));
    const leaders = new Set(scored.filter(([id]) => !bookIds.has(id)).length < BOOK_LAYER_LIMIT ? []
        : scored.slice().sort((a, b) => b[1] - a[1]).slice(0, BOOK_LAYER_LIMIT).map(([id]) => id));
    const open = books.map(book => {
        const own = linked.filter(entry => entry.companion.book === book.key && entry.companion.layer === 'book'), title = plain(book.title);
        return own.length && (mentioned(title) || title && spoken.includes(`《${title}》`) || book.terms.some(mentioned)
            || own.some(entry => entry.companion.keywords.some(mentioned) || leaders.has(entry.id))) ? own : [];
    }).filter(own => own.length);
    const gated = open.flat(), bookTerms = new Map(gated.map(entry => [entry.id, narrativeTerms(`${entry.text}\n${entry.companion.keywords.join(' ')}`)]));
    const bookFrequency = new Map();
    for (const values of bookTerms.values()) for (const term of values) bookFrequency.set(term, (bookFrequency.get(term) || 0) + 1);
    const bookLexical = new Map(gated.map(entry => [entry.id, [...query].reduce((score, term) => score + (bookTerms.get(entry.id).has(term)
        ? Math.log(1 + (pool.length + gated.length) / ((frequency.get(term) || 0) + bookFrequency.get(term))) : 0), 0)]));
    const floor = Math.min(...scored.map(item => item[1])), width = Math.max(...scored.map(item => item[1])) - floor, weight = Math.max(1, ...bookLexical.values());
    const bookScore = new Map(gated.map(entry => [entry.id, bookLexical.get(entry.id) + 2 * entry.companion.keywords.filter(mentioned).length
        + (Number.isFinite(semantic?.get?.(entry.id)) ? (width > 0 ? (semantic.get(entry.id) - floor) / width : 1) * weight : 0)]));
    const furthest = (a, b) => b.companion.readTo - a.companion.readTo;
    const bookChosen = []; let bookChars = 0;
    for (const entry of open.flatMap(own => {
        const hits = own.filter(item => bookScore.get(item.id) > 0);
        // Only the book itself was named: recall where the two had got to.
        return hits.length ? hits : own.slice().sort(furthest).slice(0, BOOK_LAYER_LIMIT);
    }).sort((a, b) => bookScore.get(b.id) - bookScore.get(a.id) || furthest(a, b))) {
        if (bookChosen.length >= BOOK_LAYER_LIMIT) break;
        if (bookChars + entry.text.length > BOOK_LAYER_CHARS) continue;
        bookChosen.push(entry); bookChars += entry.text.length;
    }
    // Where it reads in the narrative: after the slice covering the floor it was
    // shared at. A since-edited floor still places it by number; it is never withheld.
    const covering = at => { const found = document.entries.filter(entry => entry.kind === 'summary' && !entry.origin && sourceRanges(entry).some(range => range.start <= at && range.end >= at));
        return (found.find(entry => ['active', 'invalid'].includes(entry.status)) || found[0])?.id; };
    const placed = entry => { const afterId = entry.companion.anchor ? covering(entry.companion.anchor.floor) : undefined; return afterId ? { ...entry, afterId } : entry; };
    return [...story, ...sharedChosen.map(placed), ...bookChosen.map(placed)];
}

const SHARED_LAYER_LIMIT = 6, BOOK_LAYER_LIMIT = 3, BOOK_LAYER_CHARS = 2400, BOOK_LAYER_CANDIDATES = 60;
/** Book-layer texts offered to the optional similarity scoring: the furthest-read first. */
function bookLayerCandidates(document) {
    return companionEntries(document.companion).filter(entry => entry.companion.layer === 'book')
        .sort((a, b) => b.companion.readTo - a.companion.readTo).slice(0, BOOK_LAYER_CANDIDATES).map(entry => ({ id: entry.id, text: entry.text }));
}

export async function buildPlan(document, defaults, snapshot, { countTokens = null, type = '', semanticScores = null, queryText = '' } = {}) {
    const empty = { prompt: '', coveredRanges: [], memoryIds: [], entries: [], tokens: 0, estimated: !countTokens };
    if (!document.enabled || document.movedTo) return empty;
    const settings = effectiveSettings(document, defaults);
    const hashes = await fingerprintMessages(snapshot.messages);
    // 当前聊天开了向量时，生成前用最近几条消息问一次相似度；拿不到（未配置、超时、出错）就按关键词排序。
    let semantic = null;
    if (settings.vectorEnabled === true && typeof semanticScores === 'function') {
        const visibleEnd = snapshot.messages.length - (type === 'swipe' ? 1 : 0);
        const asked = typeof queryText === 'string' ? queryText.trim() : '';
        const query = asked || snapshot.messages.slice(Math.max(0, visibleEnd - settings.recent), visibleEnd).map(message => message.mes || '').join('\n');
        const candidates = document.entries.filter(entry => ['active', 'invalid'].includes(entry.status) && entry.kind !== 'excerpt' && typeof entry.text === 'string' && entry.text.trim())
            .map(entry => ({ id: entry.id, text: entry.text })).concat(bookLayerCandidates(document));
        try { semantic = await semanticScores({ query, candidates }); } catch { semantic = null; }
        if (!(semantic instanceof Map) || !semantic.size) semantic = null;
    }
    const selected = selectMemories(document, snapshot, settings, hashes, type, semantic, queryText);
    if (!selected.length) return empty;
    const prompt = renderMemoryPrompt(selected, { entryOrder: document.entryOrder });
    // This is selection, not admission. Only the final-payload adapter may remove raw text.
    return { prompt, coveredRanges: selected.filter(entry => entry.kind !== 'excerpt' && !entry.origin).flatMap(sourceRanges), memoryIds: selected.map(e => e.id), entries: structuredClone(selected), entryOrder: [...(document.entryOrder || [])], settings, semantic: Boolean(semantic),
        tokens: countTokens ? await countTokens(prompt) : estimateTokens(prompt), estimated: true };
}
