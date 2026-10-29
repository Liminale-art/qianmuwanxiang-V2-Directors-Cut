// Shared, data-only contract. Chat originals and connection secrets never live here.
import {invalidateDependentStages, sourceRanges, stageDependenciesValid, stageSourceFromParents, validateStageSource, hasCustomParents} from './stage-contract.mjs';
import {validateExcerpt, recallBlockReason, excerptDependenciesValid, invalidateDependentExcerpts, excerptRecords} from './recall-contract.mjs';
import {validateOrigin, validateLineage, validateCreation} from './story-contract.mjs';
import {validateCompanion, applyCompanionOperation} from './companion-contract.mjs';
import { validateScenes } from './scene-contract.mjs';
import { normalizeEntryOrder, insertEntryOrder, validatePlacement, validateMemoryTitle } from './timeline.mjs';
import { DEFAULT_PROMPTS, validatePromptConfig, resolvePromptConfig } from './prompt-settings.mjs';
export {sourceRanges, stageDependenciesValid, stageSourceFromParents, validateStageSource} from './stage-contract.mjs';
export {recallBlockReason, excerptDependenciesValid} from './recall-contract.mjs';
export const VERSION = '0.8.4';
export const SCHEMA = 7;
export const DEFAULTS = Object.freeze({ recent: 5, trigger: 50000, batch: 6000, budget: 0, preference: '', profileId: '', model: '',
    stageAuto: false, stageBasis: 'tokens', stageThreshold: 65000, stageRecent: 10, sliceChars: 2000, stageChars: 3000,
    recall: true, companionShareCustom: false, prompts: DEFAULT_PROMPTS });
const clone = value => structuredClone(value);
export function failure(message, status = 400) { return Object.assign(new Error(message), { status, statusCode: status }); }
function requireThat(ok, message) { if (!ok) throw failure(message); }
export function normalizeBinding(value) {
    requireThat(value && typeof value === 'object', '尚未打开单人聊天');
    const result = {};
    for (const key of ['avatar', 'file', 'integrity']) {
        const text = value[key];
        requireThat(typeof text === 'string' && text.trim() === text && text.length > 0 && text.length <= 240 && !/[\x00-\x1f/\\]/.test(text), '聊天身份不完整或无效');
        requireThat(!['.', '..'].includes(text) && !text.includes(':'), '聊天身份无效');
        result[key] = text;
    }
    return result;
}
export const bindingKey = binding => JSON.stringify(normalizeBinding(binding));
export function validateSettings(input, partial = true) {
    requireThat(input && typeof input === 'object' && !Array.isArray(input), '设置格式无效');
    const result = {};
    const bounds = { recent: [1, 2000], trigger: [256, 1000000], batch: [256, 100000], budget: [0, 1000000], stageThreshold: [1, 1000000],
        stageRecent: [0, 2000], sliceChars: [1, 100000], stageChars: [1, 100000] };
    for (const [key, value] of Object.entries(input)) {
        requireThat(Object.hasOwn(DEFAULTS, key), '未知的忆幕设置');
        if (value === null && partial) { result[key] = null; continue; }
        if (key === 'stageAuto' || key === 'recall' || key === 'companionShareCustom') requireThat(typeof value === 'boolean', '忆幕开关设置无效');
        else if (key === 'stageBasis') requireThat(['tokens', 'floors', 'slices'].includes(value), '阶段整理依据无效');
        else if (key === 'prompts') { result[key] = validatePromptConfig(value); continue; }
        else if (bounds[key]) {
            requireThat(Number.isSafeInteger(value) && (value === 0 && !['sliceChars', 'stageChars'].includes(key) || value >= bounds[key][0]) && value <= bounds[key][1], '设置数值超出范围');
        } else requireThat(typeof value === 'string' && value.length <= (key === 'preference' ? 12000 : 300), '设置文字过长或无效');
        result[key] = value;
    }
    return partial ? result : { ...DEFAULTS, ...result };
}
export function effectiveSettings(document, defaults) {
    const settings = { ...DEFAULTS, ...defaults?.values, ...document?.settings };
    for (const key of ['recent', 'trigger']) if (settings[key] === 0) settings[key] = DEFAULTS[key];
    // Legacy batch is retained on disk only. Trigger is the single input target;
    // runtime may narrow this derived cap to the actual connection window.
    settings.batch = settings.trigger;
    if (settings.stageThreshold === 0) settings.stageThreshold = { tokens: 65000, floors: 100, slices: 12 }[settings.stageBasis];
    if (!document?.settings?.prompts && (!defaults?.values?.prompts || JSON.stringify(defaults.values.prompts) === JSON.stringify(DEFAULT_PROMPTS))) {
        settings.prompts = resolvePromptConfig({ preference: settings.preference });
    }
    return settings;
}
export function createDocument(binding) {
    return { schema: SCHEMA, revision: 0, binding: normalizeBinding(binding), enabled: false, autoSummary: false, epoch: 0, configRevision: 0, settings: {}, initialRange: null, entries: [], entryOrder: [], operations: [], receipts: {} };
}
export function createDefaults() { return { schema: SCHEMA, revision: 0, values: { ...DEFAULTS }, operations: [], receipts: {} }; }
function validateSource(source) {
    requireThat(source && Number.isSafeInteger(source.start) && source.start >= 1 && Number.isSafeInteger(source.end) && source.end >= source.start, '来源楼层范围无效');
    requireThat(Array.isArray(source.hashes) && source.hashes.length === source.end - source.start + 1 && source.hashes.every(x => /^[a-f0-9]{64}$/.test(x)), '来源指纹不完整');
    return { start: source.start, end: source.end, hashes: [...source.hashes] };
}
function textValue(text) {
    requireThat(typeof text === 'string' && text.trim().length > 0 && text.length <= 100000, '记忆正文为空或过长');
    return text.trim();
}
function identifier(value) { requireThat(typeof value === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(value), '操作或条目标识无效'); return value; }
export function validateDocument(raw) {
    requireThat([1, 2, 3, 4, 5, 6, SCHEMA].includes(raw?.schema) && Number.isSafeInteger(raw.revision) && raw.revision >= 0 && Number.isSafeInteger(raw.epoch) && raw.epoch >= 0 && Number.isSafeInteger(raw.configRevision) && raw.configRevision >= 0 && typeof raw.enabled === 'boolean' && Array.isArray(raw.entries) && Array.isArray(raw.operations), '忆幕资料格式损坏，已停止写入');
    if (raw.schema !== SCHEMA) raw = {...clone(raw), schema: SCHEMA, autoSummary: raw.schema < 6 ? raw.enabled : raw.autoSummary};
    requireThat(typeof raw.autoSummary === 'boolean', '自动总结状态无效');
    raw = clone(raw);
    normalizeBinding(raw.binding); validateSettings(raw.settings);
    if (raw.lineage) raw.lineage = validateLineage(raw.lineage);
    if (raw.creation) validateCreation(raw.creation);
    if (raw.companion) raw.companion = validateCompanion(raw.companion);
    const ids = new Set();
    for (const entry of raw.entries) {
        identifier(entry.id); requireThat(!ids.has(entry.id), '记忆条目标识重复'); ids.add(entry.id);
        delete entry.originVerified;
        delete entry.placementVerified;
        if (entry.origin) entry.origin = validateOrigin(entry.origin);
        textValue(entry.text);
        if (entry.title !== undefined) entry.title = validateMemoryTitle(entry.title);
        if (entry.discardedSources !== undefined) entry.discardedSources = validateDiscardedSources(entry.discardedSources);
        if (entry.discarded !== undefined) requireThat(entry.discarded === true && entry.status === 'deleted'
            && entry.text === '已删除' && !entry.title && !entry.history?.length && !entry.conflicts?.length && !entry.candidate,
        '已清除的删除记录无效');
        requireThat(['summary', 'manual', 'stage', 'excerpt'].includes(entry.kind) && ['active', 'invalid', 'excluded', 'deleted'].includes(entry.status) && Number.isSafeInteger(entry.revision) && entry.revision > 0 && Array.isArray(entry.history) && Array.isArray(entry.conflicts), '记忆条目格式损坏');
        if (entry.kind === 'summary') validateSource(entry.source);
        else if (entry.kind === 'stage') validateStageSource(entry.source);
        else if (entry.kind === 'excerpt') validateExcerpt(entry);
        else requireThat(entry.source === null, '自定义切片不能伪造原文来源');
        entry.scenes = validateScenes(entry.scenes, entry.kind === 'summary' ? entry.source : {});
        if (entry.kind === 'manual') entry.placement = validatePlacement(entry.placement);
        for (const version of [...entry.history, ...entry.conflicts, ...(entry.candidate ? [entry.candidate] : [])]) {
            if (version.title !== undefined) version.title = validateMemoryTitle(version.title);
            if (version.discardedSources !== undefined) version.discardedSources = validateDiscardedSources(version.discardedSources);
            version.scenes = validateScenes(version.scenes, version.kind === 'summary' ? version.source : {});
            if (version.kind === 'manual') version.placement = validatePlacement(version.placement);
            delete version.originVerified; delete version.placementVerified;
        }
    }
    raw.entryOrder = normalizeEntryOrder(raw);
    if (raw.movedTo) normalizeBinding(raw.movedTo);
    return raw;
}
export function validateDefaults(raw) {
    requireThat([1, 2, 3, 4, 5, 6, SCHEMA].includes(raw?.schema) && Number.isSafeInteger(raw.revision) && raw.revision >= 0 && Array.isArray(raw.operations), '忆幕默认设置损坏，已停止写入');
    if (raw.schema !== SCHEMA) raw = {...clone(raw), schema: SCHEMA, values: {...DEFAULTS, ...raw.values,
        prompts: raw.values?.prompts ? validatePromptConfig(raw.values.prompts) : resolvePromptConfig({ preference: raw.values?.preference })}};
    validateSettings(raw.values, false); return raw;
}
function receipt(operation) { return operation.receipt || JSON.stringify(operation); }
function isDuplicate(document, operation) {
    if (!document.operations.includes(operation.id)) return false;
    requireThat(document.receipts?.[operation.id] === receipt(operation), '同一操作标识对应不同内容，未覆盖已存资料');
    return true;
}
function finish(document, operation, outcome = 'applied') {
    if (operation.type === 'entry' && operation.action === 'delete') pruneDeletedEntries(document);
    document.entryOrder = normalizeEntryOrder(document);
    invalidateDependentStages(document);
    invalidateDependentExcerpts(document);
    document.revision++;
    document.operations.push(operation.id);
    document.receipts = { ...document.receipts, [operation.id]: receipt(operation) };
    return { document: validateDocument(document), outcome };
}
function past(entry) { const { history, conflicts, candidate, ...rest } = entry; return clone(rest); }
function revise(entry, changes) {
    entry.history.push(past(entry));
    if (typeof changes.text === 'string' && changes.text !== entry.text || Object.hasOwn(changes, 'title') && changes.title !== (entry.title || '')) delete entry.textUndoRevision;
    Object.assign(entry, changes, { revision: entry.revision + 1 });
}
export function canUndoText(entry) {
    return !entry?.discarded && (entry?.history || []).some(previous => (previous.text !== entry.text || (previous.title || '') !== (entry.title || '')) && previous.revision < (entry.textUndoRevision ?? Infinity));
}
/** Keep source-only deletion guards so older backups and auto-summary cannot revive discarded stories. */
export function pruneDeletedEntries(document) {
    const deleted = document.entries.filter(entry => entry.status === 'deleted' && !entry.replacedBy && !entry.discarded);
    const order = new Map(document.entries.map((entry, index) => [entry.id, index]));
    deleted.sort((a, b) => (b.deletedRevision ?? -1) - (a.deletedRevision ?? -1) || order.get(b.id) - order.get(a.id));
    for (const entry of deleted.slice(10)) {
        const retained = Object.fromEntries(['id', 'kind', 'source', 'origin', 'placement', 'parent', 'quote', 'deletedRevision']
            .filter(key => Object.hasOwn(entry, key)).map(key => [key, clone(entry[key])]));
        for (const key of Object.keys(entry)) delete entry[key];
        Object.assign(entry, retained, { text: '已删除', revision: document.revision + 1, status: 'deleted', discarded: true,
            edited: false, scenes: [], history: [], conflicts: [], candidate: null });
    }
    return document;
}
function submittedEntry(input, document) {
    requireThat(input && ['summary', 'manual', 'stage'].includes(input.kind), '记忆类型无效');
    requireThat(!input.origin, '继承来源只能通过明确的故事创建写入');
    if (input.kind === 'stage') requireThat(!input.source?.parents?.some(ref => document.entries.find(entry => entry.id === ref.id)?.origin), '继承记忆不在新聊天自动重新整理');
    const source = input.kind === 'stage' ? stageSourceFromParents(document, input.source?.parents, { includeCustom: input.source?.includeCustom === undefined ? true : input.source.includeCustom })
        : input.kind === 'summary' ? validateSource(input.source) : null;
    const sceneInput = input.kind === 'manual' && Array.isArray(input.scenes)
        ? input.scenes.map(scene => ({ ...scene, evidence: { ...scene.evidence, user: true } })) : input.scenes;
    const scenes = validateScenes(sceneInput, { ...(input.kind === 'summary' ? source : {}), allowUser: input.kind === 'manual' });
    if (input.kind === 'stage') {
        for (const scene of scenes) requireThat(scene.evidence.floors.every(floor => source.ranges.some(range => floor >= range.start && floor <= range.end)), '阶段时空标记引用了范围外原文；自定义内容应引用父切片版本');
    }
    for (const scene of scenes) if (scene.evidence.inheritedFrom) {
        const ref = scene.evidence.inheritedFrom;
        const parent = document.entries.find(entry => entry.id === ref.id && entry.revision === ref.revision && entry.status === 'active');
        requireThat(parent && (input.kind === 'stage' || source?.start > Math.max(0, ...sourceRanges(parent).map(range => range.end))), '时空继承依据已变化，未采用');
        if (!scene.evidence.floors.length) requireThat((parent.scenes || []).some(previous => ['world', 'timeline', 'date', 'period', 'place', 'event'].every(key => !scene[key] || scene[key] === previous[key])
            && scene.characters.every(character => previous.characters?.includes(character))), '时空继承标记没有对应依据');
    }
    const placement = input.kind === 'manual' ? validatePlacement(input.placement, { binding: document.binding }) : undefined;
    if (input.kind === 'manual') requireThat(placement, '请为自定义切片选择有效的插入楼层');
    return { id: identifier(input.id), kind: input.kind, text: textValue(input.text), ...(input.title !== undefined ? { title: validateMemoryTitle(input.title) } : {}), source, scenes, ...(input.kind === 'manual' ? { placement } : {}) };
}
function requireUnusedStageParents(document, submitted) {
    if (submitted.kind !== 'stage') return;
    const parents = new Set(submitted.source.parents.map(parent => parent.id));
    requireThat(!document.entries.some(entry => entry.kind === 'stage' && !entry.replacedBy && entry.id !== submitted.id
        && entry.source.parents.some(parent => parents.has(parent.id))), '此范围已有阶段摘要，请对已有阶段重新总结');
}
export function validateDiscardedSources(value) {
    requireThat(Array.isArray(value) && value.length > 0, '已清除来源引用无效');
    const ids = new Set();
    return value.map(ref => {
        requireThat(ref && !ids.has(ref.id) && Number.isSafeInteger(ref.revision) && ref.revision > 0, '已清除来源引用无效');
        const id = identifier(ref.id); ids.add(id);
        return { id, revision: ref.revision, source: validateSource(ref.source) };
    });
}
function requireSummaryRange(document, submitted, discardedSources) {
    const overlaps = document.entries.filter(entry => entry.kind === 'summary' && !entry.origin && entry.source
        && entry.source.start <= submitted.source.end && entry.source.end >= submitted.source.start);
    if (discardedSources === undefined) {
        requireThat(!overlaps.length, '此来源已有记忆，请对已有条目重新总结');
        return;
    }
    // An explicit manual range may regenerate purged sources, never restore their
    // old contents or bypass a retained deletion, shield or current/manual edit.
    const references = validateDiscardedSources(discardedSources);
    requireThat(references.length === overlaps.length
        && overlaps.every(entry => entry.discarded === true && entry.status === 'deleted'
            && references.some(ref => ref.id === entry.id && ref.revision === entry.revision && JSON.stringify(ref.source) === JSON.stringify(entry.source))),
    '所选已清除来源已变化，请重新确认手动整理范围');
    submitted.discardedSources = references;
}
function replaceStageOwners(document, submitted, replacements = []) {
    requireThat(Array.isArray(replacements), '阶段替换范围无效');
    if (!replacements.length) return;
    requireThat(submitted.kind === 'stage', '阶段替换范围无效');
    const parents = new Set(submitted.source.parents.map(ref => ref.id)), ids = new Set();
    for (const ref of replacements) {
        const previous = document.entries.find(entry => entry.id === ref.id && entry.kind === 'stage' && entry.revision === ref.revision);
        requireThat(previous && !ids.has(ref.id) && !previous.replacedBy && !previous.edited && !hasCustomParents(previous, document) && !['deleted', 'excluded'].includes(previous.status)
            && previous.source.parents.every(parent => parents.has(parent.id)), '已有阶段已变化或包含人工修订，请对该阶段单独重新总结');
        ids.add(ref.id);
        revise(previous, { status: 'deleted', candidate: null, replacedBy: submitted.id });
    }
}
function candidate(entry, operation, values, reason) {
    entry.conflicts.push({ id: operation.id, reason, ...clone(values) });
    return 'conflict';
}
function initialScope(range) {
    requireThat(range && Number.isSafeInteger(range.start) && Number.isSafeInteger(range.end) && Number.isSafeInteger(range.total)
        && range.start >= 1 && range.total >= 0 && range.total >= range.end
        && (range.end >= range.start || range.start === 1 && range.end === 0), '请确认首次整理的起止楼层');
    return { start: range.start, end: range.end, total: range.total };
}
export function applyOperation(current, operation, {excerpt = null} = {}) {
    current = validateDocument(current);
    const id = identifier(operation?.id);
    if (isDuplicate(current, operation)) return { document: clone(current), outcome: 'duplicate' };
    requireThat(!current.movedTo, '此聊天已重命名，请重新打开当前聊天');
    requireThat(current.creation?.status !== 'pending', '故事创建尚未完成，请先核对创建结果');
    const doc = clone(current);
    const op = operation;
    if (op.type === 'reorder') {
        requireThat(op.expectedRevision === doc.revision, '切片列表已在另一设备变化，请刷新后重新排列');
        doc.entryOrder = normalizeEntryOrder({ ...doc, entryOrder: op.entryOrder }, { strict: true });
        for (const [entryId, value] of Object.entries(op.placements || {})) {
            const entry = doc.entries.find(item => item.id === entryId && item.kind === 'manual' && !item.origin);
            requireThat(entry, '只能修改当前聊天自定义切片的适用位置');
            const placement = validatePlacement(value, { binding: doc.binding });
            requireThat(placement, '自定义切片适用位置不可清空');
            if (JSON.stringify(entry.placement) !== JSON.stringify(placement)) revise(entry, { placement });
        }
    } else if (op.type === 'companion') {
        applyCompanionOperation(doc, op);
    } else if (['enable', 'autoSummary', 'history', 'settings'].includes(op.type)) {
        requireThat(op.expectedRevision === doc.configRevision, '此聊天设置已在另一设备修改，请刷新后再试');
        if (op.type === 'enable') {
            requireThat(typeof op.enabled === 'boolean', '启用状态无效');
            if (!doc.initialRange && op.range) doc.initialRange = initialScope(op.range);
            doc.enabled = op.enabled;
        } else if (op.type === 'autoSummary') {
            requireThat(typeof op.value === 'boolean', '自动总结状态无效');
            requireThat(!op.value || doc.enabled, '请先启用忆幕');
            doc.autoSummary = op.value;
            if (!doc.initialRange && op.range) doc.initialRange = initialScope(op.range);
        } else if (op.type === 'history') {
            requireThat(!doc.initialRange, '历史楼层范围已确认；请使用手动总结补充');
            doc.initialRange = initialScope(op.range);
        } else {
            for (const [key, value] of Object.entries(validateSettings(op.values))) {
                if (value === null) delete doc.settings[key]; else doc.settings[key] = value;
            }
        }
        doc.epoch++; doc.configRevision++;
    } else if (op.type === 'recall') {
        requireThat(doc.enabled && op.expectedEpoch === doc.epoch && doc.settings.recall !== false, '原文回查已关闭或设置已变化');
        requireThat(op.expectedRevision === doc.revision, '回查期间记忆已变化，本次补充未采用');
        const reason = recallBlockReason(doc, op.parent); requireThat(!reason, reason);
        const value = {...validateExcerpt(excerpt), id: identifier(op.entryId)};
        requireThat(JSON.stringify(value.parent) === JSON.stringify(op.parent) && excerptDependenciesValid(value, doc), '原文补充的父来源已变化');
        requireThat(!doc.entries.some(entry => entry.id === value.id), '此原文补充标识已存在');
        const previous = excerptRecords(doc, value.parent.id);
        if (previous.some(entry => JSON.stringify(entry.source) === JSON.stringify(value.source) && JSON.stringify(entry.quote) === JSON.stringify(value.quote))) return finish(doc, op, 'duplicate');
        requireThat(!previous.some(entry => entry.source.start === value.source.start && entry.quote.start < value.quote.end && entry.quote.end > value.quote.start), '此原文位置已有补充或排除记录，不重复提取');
        requireThat(new Set(previous.map(entry => entry.id)).size < 2, '此细摘要已有两条原文补充，不自动追加');
        doc.entries.push({...value, revision: 1, status: 'active', edited: false, history: [], conflicts: [], candidate: null});
        insertEntryOrder(doc, value, value.parent.id);
    } else if (op.type === 'append') {
        const value = submittedEntry(op.entry, doc);
        if (doc.entries.some(e => e.id === value.id)) throw failure('此记忆条目已经存在', 409);
        replaceStageOwners(doc, value, op.replaceStages);
        requireUnusedStageParents(doc, value);
        if (value.kind !== 'manual') {
            requireThat(doc.enabled && op.expectedEpoch === doc.epoch, '整理期间启用状态或设置已变化，本次结果未采用');
            // Ordinary/automatic append still rejects all overlap. Only explicitly
            // named, revision-checked purged sources can be manually summarized anew.
            if (value.kind === 'summary') requireSummaryRange(doc, value, op.discardedSources);
            requireThat(!doc.lineage || value.source.start > doc.lineage.bridgeCount || value.kind === 'stage', '衔接原文不是新剧情，不重复整理');
        }
        doc.entries.push({ ...value, revision: 1, status: 'active',
            edited: value.kind === 'manual',
            history: [], conflicts: [], candidate: null });
        insertEntryOrder(doc, value, Object.hasOwn(op, 'afterId') ? op.afterId : op.entry.afterId);
    } else if (op.type === 'invalidate') {
        for (const record of op.entries || []) {
            const entry = doc.entries.find(e => e.id === record.id);
            if (entry?.source && entry.revision === record.revision && entry.status !== 'invalid') {
                // User exclusions/deletions remain exclusions/deletions, never auto-return.
                if (entry.status === 'active') revise(entry, { status: 'invalid', candidate: null });
            }
        }
    } else {
        const entry = doc.entries.find(e => e.id === op.entryId);
        requireThat(entry, '记忆条目不存在');
        requireThat(!entry.discarded, '此删除记录已超出保留数量，不能恢复');
        let values;
        if (op.type === 'edit' && op.scenes !== undefined) requireThat(Array.isArray(op.scenes), '切片场景格式无效');
        if (op.type === 'edit') values = { text: textValue(op.text), edited: true,
            ...(op.title !== undefined ? { title: validateMemoryTitle(op.title) } : {}),
            ...(op.scenes !== undefined ? { scenes: validateScenes(op.scenes.map(scene => ({ ...scene, evidence: { ...scene.evidence, user: true } })), entry.kind === 'summary' ? entry.source : {}) } : {}),
            ...(entry.kind === 'excerpt' ? { kind: 'manual', source: null, parent: null, quote: null,
                placement: { binding: clone(doc.binding), fromFloor: entry.source.start, hash: entry.source.hashes[0] },
                status: entry.status === 'excluded' ? 'excluded' : 'active' } : {}) };
        else if (op.type === 'redo') {
            requireThat(!entry.origin, '继承摘要请在原聊天重新整理；当前分支可手动修订');
            requireThat(doc.enabled && op.expectedEpoch === doc.epoch && entry.status !== 'deleted', '整理期间状态已变化，本次结果未采用');
            const submitted = submittedEntry(op.entry, doc);
            requireThat(['summary', 'stage'].includes(submitted.kind) && submitted.kind === entry.kind && submitted.id === entry.id, '重总结来源无效');
            if (submitted.kind === 'summary') requireThat(submitted.source.start === entry.source.start && submitted.source.end === entry.source.end, '重新总结不能改变已有切片的楼层范围');
            requireUnusedStageParents(doc, submitted);
            values = { text: submitted.text, ...(submitted.title !== undefined ? { title: submitted.title } : {}), source: submitted.source, kind: submitted.kind, scenes: submitted.scenes,
                status: entry.status === 'excluded' ? 'excluded' : 'active' };
        } else requireThat(op.type === 'entry', '未知的记忆操作');
        if (op.expectedRevision !== entry.revision) {
            if (values) return finish(doc, op, candidate(entry, op, values, '此条记忆已在另一设备修改'));
            throw failure('此条记忆已变化，请刷新后再操作', 409);
        }
        if (op.type === 'edit') revise(entry, values);
        else if (op.type === 'redo' && (entry.edited || hasCustomParents(entry, doc))) {
            entry.candidate = { id, ...values }; entry.revision++;
        } else if (op.type === 'redo') revise(entry, { ...values, candidate: null });
        else {
            switch (op.action) {
                case 'exclude': revise(entry, { status: 'excluded' }); break;
                case 'restore':
                    requireThat(entry.status === 'excluded', '只有暂不使用的条目可恢复');
                    revise(entry, { status: 'active' }); break;
                case 'delete': revise(entry, { status: 'deleted', candidate: null, deletedRevision: doc.revision + 1 }); break;
                case 'undoText': {
                    const previous = entry.history.slice().reverse().find(version => (version.text !== entry.text || (version.title || '') !== (entry.title || '')) && version.revision < (entry.textUndoRevision ?? Infinity));
                    requireThat(previous, '没有可撤回的文字修改');
                    const values = Object.fromEntries(['text', 'kind', 'source', 'origin', 'placement', 'parent', 'quote', 'scenes', 'edited'].map(key => [key, clone(previous[key] ?? (key === 'scenes' ? validateScenes() : null))]));
                    values.title = previous.title || '';
                    if (entry.kind === 'manual' && previous.kind === 'manual') values.placement = clone(entry.placement);
                    Object.assign(entry, values, { revision: entry.revision + 1, candidate: null, textUndoRevision: previous.revision });
                    break;
                }
                case 'undo': {
                    requireThat(!entry.replacedBy, '此阶段已被新范围替代，原切片仍保留');
                    requireThat(entry.status === 'deleted' && entry.history.length > 0, '请使用撤回文字修改；此操作仅用于撤回删除');
                    const previous = entry.history.pop();
                    const rev = entry.revision + 1;
                    const conflicts = entry.conflicts;
                    Object.assign(entry, previous, { revision: rev, candidate: null, conflicts });
                    // The server rechecks any activated source before committing this operation.
                    break;
                }
                case 'keepManual': {
                    const first = sourceRanges(entry)[0];
                    revise(entry, { kind: 'manual', source: null, origin: null, edited: true,
                        placement: first ? { binding: clone(doc.binding), fromFloor: first.start, hash: first.hashes[0] } : null,
                        status: entry.status === 'excluded' ? 'excluded' : 'active' }); break;
                }
                case 'acceptCandidate': {
                    requireThat(entry.candidate, '没有待确认的重总结');
                    requireThat(entry.kind !== 'stage' || stageDependenciesValid({...entry, ...entry.candidate, id: entry.id}, doc), '阶段候选的细摘要来源已变化，未采用');
                    revise(entry, { ...entry.candidate, id: entry.id, edited: true, candidate: null,
                        status: entry.status === 'excluded' ? 'excluded' : entry.candidate.status }); break;
                }
                case 'discardCandidate': entry.candidate = null; entry.revision++; break;
                case 'acceptConflict': {
                    const selected = entry.conflicts.find(c => c.id === op.conflictId);
                    requireThat(selected, '待选择的版本不存在');
                    const { id: ignored, reason, ...data } = selected;
                    revise(entry, { ...data, edited: true, candidate: null,
                        status: entry.status === 'excluded' ? 'excluded' : data.status || entry.status });
                    entry.conflicts = entry.conflicts.filter(c => c.id !== op.conflictId); break;
                }
                case 'discardConflict': entry.conflicts = entry.conflicts.filter(c => c.id !== op.conflictId); entry.revision++; break;
                default: throw failure('未知的条目操作');
            }
        }
    }
    return finish(doc, op);
}
export function applyDefaultsOperation(current, op) {
    current = validateDefaults(current); const id = identifier(op?.id);
    if (isDuplicate(current, op)) return { defaults: clone(current), outcome: 'duplicate' };
    requireThat(op.expectedRevision === current.revision, '默认设置已在另一设备修改，请刷新后再试');
    const changes = validateSettings(op.values);
    const values = validateSettings({ ...current.values, ...Object.fromEntries(Object.entries(changes).map(([key, value]) => [key, value === null ? DEFAULTS[key] : value])) }, false);
    return { defaults: { schema: SCHEMA, revision: current.revision + 1, values, operations: [...current.operations, id], receipts: { ...current.receipts, [id]: receipt(op) } }, outcome: 'applied' };
}
export async function fingerprintMessages(messages) {
    const subtle = globalThis.crypto?.subtle ?? (typeof process !== 'undefined' && process.versions?.node ? (await import('node:crypto')).webcrypto.subtle : null);
    requireThat(subtle, '当前页面缺少安全指纹能力，请使用 HTTPS 或本机地址');
    return Promise.all(messages.map(async message => {
        const bytes = new TextEncoder().encode(JSON.stringify([String(message.name || ''), Boolean(message.is_user), Boolean(message.is_system), String(message.mes || ''), String(message.send_date ?? '')]));
        return Array.from(new Uint8Array(await subtle.digest('SHA-256', bytes)), x => x.toString(16).padStart(2, '0')).join('');
    }));
}
export function sourceMatches(source, hashes) {
    try {
        const ranges = sourceRanges(source);
        return Boolean(ranges.length && Array.isArray(hashes) && ranges.every(range => range.end <= hashes.length
            && range.hashes.every((hash, i) => hashes[range.start - 1 + i] === hash)));
    } catch { return false; }
}
