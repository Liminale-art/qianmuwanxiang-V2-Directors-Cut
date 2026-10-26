// A package can add memory, not take over this account's settings or replay operations.
// Source identity/mapping and the atomic write are the store's responsibility.
import {createHash} from 'node:crypto';
import {bindingKey, failure, validateDocument, pruneDeletedEntries} from './contract.mjs';
import {invalidateDependentStages} from './stage-contract.mjs';
import {invalidateDependentExcerpts} from './recall-contract.mjs';
import {normalizeEntryOrder} from './timeline.mjs';
import {validateScenes} from './scene-contract.mjs';

const clone = value => structuredClone(value);
const stable = value => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
const digest = value => createHash('sha256').update(stable(value)).digest('hex');
const same = (a, b) => stable(a) === stable(b);
const hidden = new Set(['history', 'conflicts', 'candidate', 'originVerified', 'placementVerified', 'quoteText', 'quoteSpeaker', 'reason']);
const rawVersion = entry => Object.fromEntries(Object.entries(entry).filter(([key]) => !hidden.has(key)));
const version = entry => {
    const result = rawVersion(entry);
    if (result.kind) result.scenes = validateScenes(result.scenes, result.kind === 'summary' ? result.source : {});
    if (result.kind === 'manual') result.placement ??= null;
    return result;
};
const asVersion = (value, base) => version({...version(base), ...rawVersion(value), id: base.id});
const payload = value => Object.fromEntries(Object.entries(version(value)).filter(([key]) => key !== 'id'));
const content = value => Object.fromEntries(Object.entries(payload(value)).filter(([key]) => key !== 'revision'));
const identifier = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(value);
const versions = entry => [...(entry.history || []), version(entry)];
const known = (entry, value) => versions(entry).some(item => same(payload(item), payload(value)))
    || !!entry.candidate && same(payload(asVersion(entry.candidate, entry)), payload(value))
    || (entry.conflicts || []).some(item => same(payload(asVersion(item, entry)), payload(value)));

// A larger counter alone is not ancestry. Every receiver version must be present
// verbatim, and the shared revision numbers may not carry competing payloads.
function descendsFrom(next, previous) {
    if (next.revision <= previous.revision) return false;
    const history = next.history || [];
    return versions(previous).every(old => history.some(item => same(version(item), version(old))))
        && history.filter(item => item.revision <= previous.revision).every(item =>
            !versions(previous).some(old => old.revision === item.revision && !same(version(item), version(old))));
}

function overlaps(a, b, document) {
    if (a.kind !== 'summary' || b.kind !== 'summary' || !a.source || !b.source) return false;
    const first = a.origin?.binding || document.binding, second = b.origin?.binding || document.binding;
    return bindingKey(first) === bindingKey(second) && a.source.start <= b.source.end && a.source.end >= b.source.start;
}

/** Merge an already validated/mapped portable document under the target's lock. */
export function mergeBackupDocument(current, incoming, {operationId, packageId} = {}) {
    if (!identifier(operationId) || typeof packageId !== 'string' || !packageId || packageId.length > 200) {
        throw failure('备份合并操作标识无效');
    }
    const receiver = validateDocument(clone(current)), imported = validateDocument(clone(incoming));
    if (bindingKey(receiver.binding) !== bindingKey(imported.binding)) throw failure('备份记忆尚未映射到目标聊天', 409);
    const signature = digest(['backup-merge', packageId, receiver.binding, imported]);
    const counts = {added: 0, updated: 0, conflicts: 0, skipped: 0};
    if (receiver.operations.includes(operationId)) {
        if (receiver.receipts?.[operationId] !== signature) throw failure('同一次备份操作已有不同内容，未覆盖资料', 409);
        return {document: receiver, outcome: 'duplicate', counts};
    }
    const document = clone(receiver), addedIds = new Set();
    const byId = new Map(document.entries.map(entry => [entry.id, entry]));
    function addConflict(target, value, base, reason = '导入备份中的另一版，当前版本保持不变') {
        const full = asVersion(value, base);
        if (known(target, full)) return false;
        const id = `backup_${digest([packageId, base.id, full]).slice(0, 48)}`;
        target.conflicts.push({...clone(full), id, reason: value.reason || reason});
        counts.conflicts++;
        return true;
    }
    function sidecars(target, source, {history = true} = {}) {
        for (const previous of source.history || []) {
            if (known(target, previous)) continue;
            if (history && previous.id === target.id && previous.revision < target.revision
                && !target.history.some(item => item.revision === previous.revision && !same(version(item), version(previous)))) {
                target.history.push(clone(previous));
            } else addConflict(target, previous, source, '导入备份中的修订历史，当前版本保持不变');
        }
        for (const other of source.conflicts || []) addConflict(target, other, source);
        if (source.candidate) addConflict(target, source.candidate, source, '导入备份中的待确认版本，未自动采用');
        target.history.sort((a, b) => a.revision - b.revision);
    }
    for (const source of imported.entries) {
        let target = byId.get(source.id);
        // A retired deletion keeps identity/source guards only. An old archive
        // must not refill its purged body, edit history, candidates or conflicts.
        if (target?.discarded || target && source.discarded) { counts.skipped++; continue; }
        if (!target) {
            // Different IDs cannot bypass a protected/deleted slice or create
            // two active automatic accounts of the same source range.
            const overlapping = source.status === 'active' ? document.entries.filter(entry => overlaps(entry, source, document)) : [];
            // Fresh summaries explicitly regenerated after a purged deletion may
            // coexist with that exact guard. Old archives have no such provenance.
            if (overlapping.some(entry => entry.discarded && !source.discardedSources?.some(ref => ref.id === entry.id
                && ref.revision === entry.revision && same(ref.source, entry.source)))) { counts.skipped++; continue; }
            const overlap = overlapping.find(entry => !entry.discarded);
            if (overlap) {
                const before = stable(overlap);
                addConflict(overlap, source, source, `同一原文范围已有切片，导入条目 ${source.id} 已保留为另一版`);
                sidecars(overlap, source, {history: false});
                if (stable(overlap) !== before) counts.updated++; else counts.skipped++;
                continue;
            }
            target = clone(source);
            document.entries.push(target); byId.set(target.id, target); addedIds.add(target.id); counts.added++;
            continue;
        }
        const before = stable(target);
        if (same(version(target), version(source))) sidecars(target, source);
        else if (descendsFrom(source, target)
            && !(target.edited && !source.edited)
            && !(target.status !== 'active' && source.status === 'active')) {
            const next = {...clone(version(source)), history: clone(target.history), conflicts: clone(target.conflicts), candidate: clone(target.candidate ?? null)};
            sidecars(next, source);
            document.entries[document.entries.indexOf(target)] = next; byId.set(next.id, next); target = next;
        } else if (descendsFrom(target, source) || same(content(target), content(source))) {
            // A stale ancestor / identical contents do not move the current
            // revision backwards, but extra archived edits still survive.
            sidecars(target, source);
        } else {
            addConflict(target, source, source);
            sidecars(target, source, {history: false});
        }
        if (stable(target) !== before) counts.updated++; else counts.skipped++;
    }
    const previousOrder = normalizeEntryOrder(receiver);
    const appended = normalizeEntryOrder(imported).filter(id => addedIds.has(id));
    document.entryOrder = [...previousOrder, ...appended];
    // All non-memory fields, including settings, enablement, companion and
    // initialRange, originated in receiver and are deliberately left untouched.
    if (same(document, receiver)) return {document: receiver, outcome: 'duplicate', counts};
    pruneDeletedEntries(document);
    invalidateDependentStages(document);
    invalidateDependentExcerpts(document);
    document.revision++;
    document.operations.push(operationId);
    document.receipts = {...document.receipts, [operationId]: signature};
    return {document: validateDocument(document), outcome: 'merged', counts};
}
