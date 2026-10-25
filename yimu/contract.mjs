// Shared, data-only contract. Chat originals and connection secrets never live here.
import {invalidateDependentStages, sourceRanges, stageDependenciesValid, stageSourceFromParents, validateStageSource} from './stage-contract.mjs';
import {validateExcerpt, recallBlockReason, excerptDependenciesValid, invalidateDependentExcerpts, excerptRecords} from './recall-contract.mjs';
import {validateOrigin, validateLineage, validateCreation} from './story-contract.mjs';
import {validateCompanion, applyCompanionOperation} from './companion-contract.mjs';
export {sourceRanges, stageDependenciesValid, stageSourceFromParents, validateStageSource} from './stage-contract.mjs';
export {recallBlockReason, excerptDependenciesValid} from './recall-contract.mjs';
export const VERSION = '0.5.0';
export const SCHEMA = 5;
export const DEFAULTS = Object.freeze({ recent: 5, trigger: 4000, batch: 6000, budget: 0, preference: '', profileId: '', model: '',
    stageAuto: false, stageBasis: 'tokens', stageThreshold: 6000, recall: true });
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
    const bounds = { recent: [1, 2000], trigger: [256, 1000000], batch: [256, 100000], budget: [0, 1000000], stageThreshold: [1, 1000000] };
    for (const [key, value] of Object.entries(input)) {
        requireThat(Object.hasOwn(DEFAULTS, key), '未知的忆幕设置');
        if (value === null && partial) { result[key] = null; continue; }
        if (key === 'stageAuto' || key === 'recall') requireThat(typeof value === 'boolean', '忆幕开关设置无效');
        else if (key === 'stageBasis') requireThat(['tokens', 'floors', 'slices'].includes(value), '阶段整理依据无效');
        else if (bounds[key]) {
            requireThat(Number.isSafeInteger(value) && value >= bounds[key][0] && value <= bounds[key][1], '设置数值超出范围');
        } else requireThat(typeof value === 'string' && value.length <= (key === 'preference' ? 12000 : 300), '设置文字过长或无效');
        result[key] = value;
    }
    return partial ? result : { ...DEFAULTS, ...result };
}
export function effectiveSettings(document, defaults) { return { ...DEFAULTS, ...defaults?.values, ...document?.settings }; }
export function createDocument(binding) {
    return { schema: SCHEMA, revision: 0, binding: normalizeBinding(binding), enabled: false, epoch: 0, configRevision: 0, settings: {}, initialRange: null, entries: [], operations: [], receipts: {} };
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
    requireThat([1, 2, 3, 4, SCHEMA].includes(raw?.schema) && Number.isSafeInteger(raw.revision) && raw.revision >= 0 && Number.isSafeInteger(raw.epoch) && raw.epoch >= 0 && Number.isSafeInteger(raw.configRevision) && raw.configRevision >= 0 && typeof raw.enabled === 'boolean' && Array.isArray(raw.entries) && Array.isArray(raw.operations), '忆幕资料格式损坏，已停止写入');
    if (raw.schema !== SCHEMA) raw = {...clone(raw), schema: SCHEMA};
    raw = clone(raw);
    normalizeBinding(raw.binding); validateSettings(raw.settings);
    if (raw.lineage) raw.lineage = validateLineage(raw.lineage);
    if (raw.creation) validateCreation(raw.creation);
    if (raw.companion) raw.companion = validateCompanion(raw.companion);
    const ids = new Set();
    for (const entry of raw.entries) {
        identifier(entry.id); requireThat(!ids.has(entry.id), '记忆条目标识重复'); ids.add(entry.id);
        delete entry.originVerified;
        if (entry.origin) entry.origin = validateOrigin(entry.origin);
        textValue(entry.text);
        requireThat(['summary', 'manual', 'stage', 'excerpt'].includes(entry.kind) && ['active', 'invalid', 'excluded', 'deleted'].includes(entry.status) && Number.isSafeInteger(entry.revision) && entry.revision > 0 && Array.isArray(entry.history) && Array.isArray(entry.conflicts), '记忆条目格式损坏');
        if (entry.kind === 'summary') validateSource(entry.source);
        else if (entry.kind === 'stage') validateStageSource(entry.source);
        else if (entry.kind === 'excerpt') validateExcerpt(entry);
        else requireThat(entry.source === null, '手动补充不能伪造来源');
    }
    if (raw.movedTo) normalizeBinding(raw.movedTo);
    return raw;
}
export function validateDefaults(raw) {
    requireThat([1, 2, 3, 4, SCHEMA].includes(raw?.schema) && Number.isSafeInteger(raw.revision) && raw.revision >= 0 && Array.isArray(raw.operations), '忆幕默认设置损坏，已停止写入');
    if (raw.schema !== SCHEMA) raw = {...clone(raw), schema: SCHEMA, values: {...DEFAULTS, ...raw.values}};
    validateSettings(raw.values, false); return raw;
}
function receipt(operation) { return operation.receipt || JSON.stringify(operation); }
function isDuplicate(document, operation) {
    if (!document.operations.includes(operation.id)) return false;
    requireThat(document.receipts?.[operation.id] === receipt(operation), '同一操作标识对应不同内容，未覆盖已存资料');
    return true;
}
function finish(document, operation, outcome = 'applied') {
    invalidateDependentStages(document);
    invalidateDependentExcerpts(document);
    document.revision++;
    document.operations.push(operation.id);
    document.receipts = { ...document.receipts, [operation.id]: receipt(operation) };
    return { document, outcome };
}
function past(entry) { const { history, conflicts, candidate, ...rest } = entry; return clone(rest); }
function revise(entry, changes) { entry.history.push(past(entry)); Object.assign(entry, changes, { revision: entry.revision + 1 }); }
function submittedEntry(input, document) {
    requireThat(input && ['summary', 'manual', 'stage'].includes(input.kind), '记忆类型无效');
    requireThat(!input.origin, '继承来源只能通过明确的故事创建写入');
    if (input.kind === 'stage') requireThat(!input.source?.parents?.some(ref => document.entries.find(entry => entry.id === ref.id)?.origin), '继承记忆不在新聊天自动重新整理');
    const source = input.kind === 'stage' ? stageSourceFromParents(document, input.source?.parents)
        : input.kind === 'summary' ? validateSource(input.source) : null;
    return { id: identifier(input.id), kind: input.kind, text: textValue(input.text), source };
}
function requireUnusedStageParents(document, submitted) {
    if (submitted.kind !== 'stage') return;
    const parents = new Set(submitted.source.parents.map(parent => parent.id));
    requireThat(!document.entries.some(entry => entry.kind === 'stage' && entry.id !== submitted.id
        && entry.source.parents.some(parent => parents.has(parent.id))), '此范围已有阶段摘要，请对已有阶段重新总结');
}
function candidate(entry, operation, values, reason) {
    entry.conflicts.push({ id: operation.id, reason, ...clone(values) });
    return 'conflict';
}
export function applyOperation(current, operation, {excerpt = null} = {}) {
    current = validateDocument(current);
    const id = identifier(operation?.id);
    if (isDuplicate(current, operation)) return { document: clone(current), outcome: 'duplicate' };
    requireThat(!current.movedTo, '此聊天已重命名，请重新打开当前聊天');
    requireThat(current.creation?.status !== 'pending', '故事创建尚未完成，请先核对创建结果');
    const doc = clone(current);
    const op = operation;
    if (op.type === 'companion') {
        applyCompanionOperation(doc, op);
    } else if (op.type === 'enable' || op.type === 'settings') {
        requireThat(op.expectedRevision === doc.configRevision, '此聊天设置已在另一设备修改，请刷新后再试');
        if (op.type === 'enable') {
            requireThat(typeof op.enabled === 'boolean', '启用状态无效');
            if (op.enabled && !doc.initialRange) {
                const range = op.range;
                requireThat(range && Number.isSafeInteger(range.start) && Number.isSafeInteger(range.end) && Number.isSafeInteger(range.total) && range.start >= 1 && range.total >= range.end && (range.end >= range.start || range.start === 1 && range.end === 0 && range.total === 0), '请确认首次整理的起止楼层');
                doc.initialRange = clone(range);
            }
            doc.enabled = op.enabled;
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
    } else if (op.type === 'append') {
        const value = submittedEntry(op.entry, doc);
        if (doc.entries.some(e => e.id === value.id)) throw failure('此记忆条目已经存在', 409);
        requireUnusedStageParents(doc, value);
        if (value.kind !== 'manual') {
            requireThat(doc.enabled && op.expectedEpoch === doc.epoch, '整理期间启用状态或设置已变化，本次结果未采用');
            // No overlapping automatic replacement, including deleted/excluded slices.
            if (value.kind === 'summary') requireThat(!doc.entries.some(e => e.kind === 'summary' && !e.origin && e.source && e.source.start <= value.source.end && e.source.end >= value.source.start), '此来源已有记忆，请对已有条目重新总结');
            requireThat(!doc.lineage || value.source.start > doc.lineage.bridgeCount || value.kind === 'stage', '衔接原文不是新剧情，不重复整理');
        }
        doc.entries.push({ ...value, revision: 1, status: 'active', edited: value.kind === 'manual', history: [], conflicts: [], candidate: null });
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
        let values;
        if (op.type === 'edit') values = { text: textValue(op.text), edited: true, ...(entry.kind === 'excerpt' ? {kind: 'manual', source: null, parent: null, quote: null, status: 'active'} : {}) };
        else if (op.type === 'redo') {
            requireThat(!entry.origin, '继承摘要请在原聊天重新整理；当前分支可手动修订');
            requireThat(doc.enabled && op.expectedEpoch === doc.epoch && entry.status !== 'deleted', '整理期间状态已变化，本次结果未采用');
            const submitted = submittedEntry(op.entry, doc);
            requireThat(['summary', 'stage'].includes(submitted.kind) && submitted.kind === entry.kind && submitted.id === entry.id, '重总结来源无效');
            requireUnusedStageParents(doc, submitted);
            values = { text: submitted.text, source: submitted.source, kind: submitted.kind, status: 'active' };
        } else requireThat(op.type === 'entry', '未知的记忆操作');
        if (op.expectedRevision !== entry.revision) {
            if (values) return finish(doc, op, candidate(entry, op, values, '此条记忆已在另一设备修改'));
            throw failure('此条记忆已变化，请刷新后再操作', 409);
        }
        if (op.type === 'edit') revise(entry, values);
        else if (op.type === 'redo' && entry.edited) {
            entry.candidate = { id, ...values }; entry.revision++;
        } else if (op.type === 'redo') revise(entry, { ...values, candidate: null });
        else {
            switch (op.action) {
                case 'exclude': revise(entry, { status: 'excluded' }); break;
                case 'restore':
                    requireThat(entry.status === 'excluded', '只有暂不使用的条目可恢复');
                    revise(entry, { status: 'active' }); break;
                case 'delete': revise(entry, { status: 'deleted', candidate: null }); break;
                case 'undo': {
                    requireThat(entry.history.length > 0, '没有可撤回的版本');
                    const previous = entry.history.pop();
                    const rev = entry.revision + 1;
                    const conflicts = entry.conflicts;
                    Object.assign(entry, previous, { revision: rev, candidate: null, conflicts });
                    // The server rechecks any activated source before committing this operation.
                    break;
                }
                case 'keepManual': revise(entry, { kind: 'manual', source: null, origin: null, edited: true, status: 'active' }); break;
                case 'acceptCandidate': {
                    requireThat(entry.candidate, '没有待确认的重总结');
                    requireThat(entry.kind !== 'stage' || stageDependenciesValid({...entry, ...entry.candidate, id: entry.id}, doc), '阶段候选的细摘要来源已变化，未采用');
                    revise(entry, { ...entry.candidate, id: entry.id, edited: true, candidate: null }); break;
                }
                case 'discardCandidate': entry.candidate = null; entry.revision++; break;
                case 'acceptConflict': {
                    const selected = entry.conflicts.find(c => c.id === op.conflictId);
                    requireThat(selected, '待选择的版本不存在');
                    const { id: ignored, reason, ...data } = selected;
                    revise(entry, { ...data, edited: true, candidate: null });
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
