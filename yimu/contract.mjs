// Shared, data-only contract. Chat originals and connection secrets never live here.
export const VERSION = '0.1.0';
export const DEFAULTS = Object.freeze({ recent: 5, trigger: 4000, batch: 6000, budget: 0, preference: '', profileId: '', model: '' });
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
    const bounds = { recent: [1, 2000], trigger: [256, 1000000], batch: [256, 100000], budget: [0, 1000000] };
    for (const [key, value] of Object.entries(input)) {
        requireThat(Object.hasOwn(DEFAULTS, key), '未知的忆幕设置');
        if (value === null && partial) { result[key] = null; continue; }
        if (bounds[key]) {
            requireThat(Number.isSafeInteger(value) && value >= bounds[key][0] && value <= bounds[key][1], '设置数值超出范围');
        } else requireThat(typeof value === 'string' && value.length <= (key === 'preference' ? 12000 : 300), '设置文字过长或无效');
        result[key] = value;
    }
    return partial ? result : { ...DEFAULTS, ...result };
}
export function effectiveSettings(document, defaults) { return { ...DEFAULTS, ...defaults?.values, ...document?.settings }; }
export function createDocument(binding) {
    return { schema: 1, revision: 0, binding: normalizeBinding(binding), enabled: false, epoch: 0, configRevision: 0, settings: {}, initialRange: null, entries: [], operations: [], receipts: {} };
}
export function createDefaults() { return { schema: 1, revision: 0, values: { ...DEFAULTS }, operations: [], receipts: {} }; }
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
    requireThat(raw?.schema === 1 && Number.isSafeInteger(raw.revision) && raw.revision >= 0 && Number.isSafeInteger(raw.epoch) && raw.epoch >= 0 && Number.isSafeInteger(raw.configRevision) && raw.configRevision >= 0 && typeof raw.enabled === 'boolean' && Array.isArray(raw.entries) && Array.isArray(raw.operations), '忆幕资料格式损坏，已停止写入');
    normalizeBinding(raw.binding); validateSettings(raw.settings);
    const ids = new Set();
    for (const entry of raw.entries) {
        identifier(entry.id); requireThat(!ids.has(entry.id), '记忆条目标识重复'); ids.add(entry.id);
        textValue(entry.text);
        requireThat(['summary', 'manual'].includes(entry.kind) && ['active', 'invalid', 'excluded', 'deleted'].includes(entry.status) && Number.isSafeInteger(entry.revision) && entry.revision > 0 && Array.isArray(entry.history) && Array.isArray(entry.conflicts), '记忆条目格式损坏');
        if (entry.kind === 'summary') validateSource(entry.source);
        else requireThat(entry.source === null, '手动补充不能伪造来源');
    }
    if (raw.movedTo) normalizeBinding(raw.movedTo);
    return raw;
}
export function validateDefaults(raw) {
    requireThat(raw?.schema === 1 && Number.isSafeInteger(raw.revision) && raw.revision >= 0 && Array.isArray(raw.operations), '忆幕默认设置损坏，已停止写入');
    validateSettings(raw.values, false); return raw;
}
function receipt(operation) { return operation.receipt || JSON.stringify(operation); }
function isDuplicate(document, operation) {
    if (!document.operations.includes(operation.id)) return false;
    requireThat(document.receipts?.[operation.id] === receipt(operation), '同一操作标识对应不同内容，未覆盖已存资料');
    return true;
}
function finish(document, operation, outcome = 'applied') {
    document.revision++;
    document.operations.push(operation.id);
    document.receipts = { ...document.receipts, [operation.id]: receipt(operation) };
    return { document, outcome };
}
function past(entry) { const { history, conflicts, candidate, ...rest } = entry; return clone(rest); }
function revise(entry, changes) { entry.history.push(past(entry)); Object.assign(entry, changes, { revision: entry.revision + 1 }); }
function submittedEntry(input) {
    requireThat(input && ['summary', 'manual'].includes(input.kind), '记忆类型无效');
    return { id: identifier(input.id), kind: input.kind, text: textValue(input.text), source: input.kind === 'summary' ? validateSource(input.source) : null };
}
function candidate(entry, operation, values, reason) {
    entry.conflicts.push({ id: operation.id, reason, ...clone(values) });
    return 'conflict';
}
export function applyOperation(current, operation) {
    validateDocument(current);
    const id = identifier(operation?.id);
    if (isDuplicate(current, operation)) return { document: clone(current), outcome: 'duplicate' };
    requireThat(!current.movedTo, '此聊天已重命名，请重新打开当前聊天');
    const doc = clone(current);
    const op = operation;
    if (op.type === 'enable' || op.type === 'settings') {
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
    } else if (op.type === 'append') {
        const value = submittedEntry(op.entry);
        if (doc.entries.some(e => e.id === value.id)) throw failure('此记忆条目已经存在', 409);
        if (value.kind === 'summary') {
            requireThat(doc.enabled && op.expectedEpoch === doc.epoch, '整理期间启用状态或设置已变化，本次结果未采用');
            // No overlapping automatic replacement, including deleted/excluded slices.
            requireThat(!doc.entries.some(e => e.source && e.source.start <= value.source.end && e.source.end >= value.source.start), '此来源已有记忆，请对已有条目重新总结');
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
        if (op.type === 'edit') values = { text: textValue(op.text), edited: true };
        else if (op.type === 'redo') {
            requireThat(doc.enabled && op.expectedEpoch === doc.epoch && entry.status !== 'deleted', '整理期间状态已变化，本次结果未采用');
            const submitted = submittedEntry(op.entry);
            requireThat(submitted.kind === 'summary' && submitted.id === entry.id, '重总结来源无效');
            values = { text: submitted.text, source: submitted.source, kind: 'summary', status: 'active' };
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
                case 'keepManual': revise(entry, { kind: 'manual', source: null, edited: true, status: 'active' }); break;
                case 'acceptCandidate': {
                    requireThat(entry.candidate, '没有待确认的重总结');
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
    validateDefaults(current); const id = identifier(op?.id);
    if (isDuplicate(current, op)) return { defaults: clone(current), outcome: 'duplicate' };
    requireThat(op.expectedRevision === current.revision, '默认设置已在另一设备修改，请刷新后再试');
    const changes = validateSettings(op.values);
    const values = validateSettings({ ...current.values, ...Object.fromEntries(Object.entries(changes).map(([key, value]) => [key, value === null ? DEFAULTS[key] : value])) }, false);
    return { defaults: { schema: 1, revision: current.revision + 1, values, operations: [...current.operations, id], receipts: { ...current.receipts, [id]: receipt(op) } }, outcome: 'applied' };
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
    return Boolean(source && source.start >= 1 && source.end <= hashes.length && source.hashes.length === source.end - source.start + 1 && source.hashes.every((hash, i) => hashes[source.start - 1 + i] === hash));
}
