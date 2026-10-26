import { estimateTokens } from './core.mjs';
import { sourceRanges, stageSourceFromParents, hasCustomParents, recentStageEntryIds } from './stage-contract.mjs';
import { orderedEntries } from './timeline.mjs';
import { validateScenes, validateGeneratedLength, SCENE_PROMPT } from './scene-contract.mjs';
import { composePrompt } from './prompt-settings.mjs';

const refs = entry => entry.source?.parents || [];
const eligibleFine = entry => !entry.origin && entry.status === 'active'
    && (entry.kind === 'summary' && !entry.edited || entry.kind === 'manual' && entry.placement);
const startFloor = entry => entry.source?.start ?? entry.placement?.fromFloor ?? 0;
const endFloor = entry => entry.source?.end ?? entry.placement?.fromFloor ?? 0;

export function stageGroups(document, { start = 1, end = Infinity, recentCutoff = Infinity, automatic = false, stageRecent = 10 } = {}) {
    const stages = document.entries.filter(entry => entry.kind === 'stage' && !entry.replacedBy);
    // Existing stages own their parent group even when disabled/deleted. Repair
    // uses that same stage below; never silently create a parallel replacement.
    const blocked = new Set(stages.flatMap(stage => refs(stage).map(ref => ref.id)));
    if (automatic) for (const id of recentStageEntryIds(document, stageRecent)) blocked.add(id);
    const fine = orderedEntries(document).filter(entry => !entry.origin && ['summary', 'manual'].includes(entry.kind));
    const groups = []; let group = [];
    const flush = () => { if (group.length >= 2) groups.push(group); group = []; };
    for (const entry of fine) {
        if (!eligibleFine(entry) || blocked.has(entry.id) || startFloor(entry) < start || endFloor(entry) > end
            || entry.kind === 'summary' && entry.source.end > recentCutoff) { flush(); continue; }
        const lastSource = group.slice().reverse().find(item => item.kind === 'summary');
        if (entry.kind === 'summary' && lastSource && lastSource.source.end + 1 !== entry.source.start && entry.source.end + 1 !== lastSource.source.start) flush();
        group.push(entry);
    }
    flush(); return groups;
}

export function stageWeight(entries, basis) {
    if (basis === 'slices') return entries.length;
    if (basis === 'floors') return entries.reduce((n, entry) => n + (entry.source ? entry.source.end - entry.source.start + 1 : 0), 0);
    return entries.reduce((n, entry) => n + estimateTokens(entry.text), 0);
}

export function nextStage(document, settings, { force = false, start = 1, end = Infinity, recentCutoff = Infinity } = {}) {
    if (!document.enabled || !force && !settings.stageAuto) return null;
    if (force && Number.isFinite(end)) return planStageRange(document, settings, { start, end, recentCutoff });
    const retained = !force ? recentStageEntryIds(document, settings.stageRecent ?? 10) : new Set();
    for (const stage of document.entries.filter(entry => !entry.origin && entry.kind === 'stage' && entry.status === 'invalid' && !entry.edited && !hasCustomParents(entry, document))) {
        const parents = refs(stage).map(ref => document.entries.find(entry => entry.id === ref.id));
        if (parents.length < 2 || parents.some(entry => !entry || !eligibleFine(entry) || retained.has(entry.id))
            || startFloor(parents[0]) < start || endFloor(parents.at(-1)) > end || parents.some(entry => entry.kind === 'summary' && entry.source.end > recentCutoff)
            || parents.some((entry, i) => i > 0 && entry.kind === 'summary' && parents[i - 1].kind === 'summary' && entry.source.start !== parents[i - 1].source.end + 1)
            || stageWeight(parents, 'tokens') > (settings.inputCapacity ?? settings.batch)
            || settings.fitsStage && !settings.fitsStage(parents)) continue;
        return { parents, existing: stage };
    }
    const groups = stageGroups(document, { start, end, recentCutoff, automatic: !force, stageRecent: settings.stageRecent ?? 10 });
    for (const group of groups) {
        if (!force && stageWeight(group, settings.stageBasis) < settings.stageThreshold) continue;
        let size = 0; const parents = [];
        for (const entry of group) {
            const nextSize = estimateTokens(entry.text);
            if (size + nextSize > (settings.inputCapacity ?? settings.batch) || settings.fitsStage && !settings.fitsStage([...parents, entry])) break;
            size += nextSize; parents.push(entry);
        }
        if (parents.length < 2) continue;
        const ids = parents.map(e => e.id);
        const same = document.entries.find(entry => entry.kind === 'stage' && refs(entry).length === ids.length
            && refs(entry).every((ref, i) => ref.id === ids[i]) && entry.status !== 'deleted' && entry.status !== 'excluded');
        return { parents, existing: same || null };
    }
    return null;
}

/** Manual range preview, with whole existing owners expanded before any model request. */
export function planStageRange(document, settings, { start, end, recentCutoff = Infinity } = {}) {
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start) throw new Error('请选择有效的阶段起止楼层');
    const requestedRange = { start, end }, range = { start, end };
    const narrative = orderedEntries(document).filter(entry => !entry.origin && ['summary', 'manual'].includes(entry.kind));
    const owners = document.entries.filter(entry => entry.kind === 'stage' && !entry.replacedBy);
    let selected = [];
    for (let changed = true; changed;) {
        changed = false;
        selected = narrative.filter(entry => startFloor(entry) <= range.end && endFloor(entry) >= range.start);
        for (const entry of selected) {
            const first = Math.min(range.start, startFloor(entry)), last = Math.max(range.end, endFloor(entry));
            changed ||= first !== range.start || last !== range.end; range.start = first; range.end = last;
        }
        const selectedIds = new Set(selected.map(entry => entry.id));
        for (const stage of owners.filter(stage => refs(stage).some(ref => selectedIds.has(ref.id)))) {
            for (const ref of refs(stage)) {
                const parent = document.entries.find(entry => entry.id === ref.id);
                if (!parent) throw new Error('阶段来源已变化，请刷新后重试');
                const first = Math.min(range.start, startFloor(parent)), last = Math.max(range.end, endFloor(parent));
                changed ||= first !== range.start || last !== range.end; range.start = first; range.end = last;
            }
        }
    }
    selected = narrative.filter(entry => startFloor(entry) >= range.start && endFloor(entry) <= range.end);
    if (selected.some(entry => entry.kind === 'summary' && entry.source.end > recentCutoff)) throw new Error('所选阶段涉及近期原文，请调整范围');
    if (selected.length < 2 || selected.some(entry => !eligibleFine(entry))) throw new Error('选择至少两份连续有效切片；人工修订的自动切片请单独处理');
    stageSourceFromParents(document, selected.map(entry => ({ id: entry.id, revision: entry.revision })));
    if (stageWeight(selected, 'tokens') > (settings.inputCapacity ?? settings.batch) || settings.fitsStage && !settings.fitsStage(selected)) throw new Error('阶段范围超过此连接的可用输入容量，请缩小范围或选择容量足够的连接');
    const selectedIds = new Set(selected.map(entry => entry.id));
    const owned = owners.filter(stage => refs(stage).some(ref => selectedIds.has(ref.id)));
    if (owned.some(stage => ['excluded', 'deleted'].includes(stage.status))) throw new Error('此范围含注入屏蔽或已删除的阶段，请先恢复或调整范围');
    const existing = owned.length === 1 && refs(owned[0]).length === selected.length
        && refs(owned[0]).every((ref, i) => ref.id === selected[i].id) ? owned[0] : null;
    if (!existing && owned.some(stage => stage.edited || hasCustomParents(stage, document))) throw new Error('已有阶段含人工内容，请对该阶段单独重新总结');
    return { requestedRange, range, expanded: start !== range.start || end !== range.end, parents: selected, existing,
        replaceStages: existing ? [] : owned.map(stage => ({ id: stage.id, revision: stage.revision })) };
}

export function stagePrompt(parents, settings) {
    return composePrompt(settings, 'stage', {
        protocol: `将按叙事顺序排列的切片整理为阶段摘要，原切片不删除。只输出JSON：{"text":"自足、精炼的阶段摘要","scenes":[]}。正文及可见场景文字合计不得超过 ${settings.stageChars ?? 3000} 字，按非空白Unicode字符计（标点、英文、数字各计一），不是输入token量。${SCENE_PROMPT}\n自定义切片属于用户明确写定内容，必须保留其含义与知情边界，不能把它当原文证据、虚构共同经历或用压缩改写其事实。自定义场景继承只用 evidence.inheritedFrom:{id,revision} 引用本次父切片，不将其适用楼层当作原文证据；没有有据时间则留空。不同场景、多视角同时异地事件不得合成同场。`,
        data: `切片：${JSON.stringify(parents.map(e => ({ id: e.id, revision: e.revision, kind: e.kind,
            start: startFloor(e), end: endFloor(e), scenes: e.scenes, text: e.text })))}`,
    });
}

export function parseStage(response, parents, settings = {}) {
    let result;
    try { result = JSON.parse(String(response).trim().replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/, '$1')); }
    catch { throw new Error('阶段整理结果不是有效 JSON，原记忆未改变'); }
    if (typeof result?.text !== 'string' || !result.text.trim() || result.text.length > 100000) throw new Error('阶段整理没有返回有效正文，原记忆未改变');
    return validateGeneratedLength({ kind: 'stage', text: result.text.trim(), scenes: validateScenes(result.scenes, { allowUser: false }),
        source: { parents: parents.map(e => ({ id: e.id, revision: e.revision })), ranges: parents.flatMap(sourceRanges) } }, settings);
}
