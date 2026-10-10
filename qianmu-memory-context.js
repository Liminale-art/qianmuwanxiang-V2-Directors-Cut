// Read-only interoperability with gaga-dog-summary schema 6/7.
// Field/provenance contract is intentionally kept to the plugin's approved
// story fields; no upstream implementation, prompts, settings, or persistent
// state are imported.
export const GAGA_MEMORY_KEY = 'gagaDogSummary';
export const GAGA_MEMORY_SCHEMA = 7;
export const GAGA_MEMORY_SUPPORTED_SCHEMAS = Object.freeze(new Set([6, GAGA_MEMORY_SCHEMA]));

const record = value => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const list = value => Array.isArray(value) ? value : [];
const text = value => typeof value === 'string' ? value : '';
const modes = new Set(['novel', 'structured', 'mixed']);
const productions = new Set(['manual', 'layered']);
const own = (value, key) => Object.prototype.hasOwnProperty.call(value || {}, key);

function canonical(value) {
    if (Array.isArray(value)) return value.map(canonical);
    if (!record(value)) return value;
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
}
function same(left, right) { return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right)); }

// FNV-1a is the stored upstream source-ref wire format, not a security digest.
function wireHash(value) {
    let result = 0x811c9dc5;
    for (let index = 0; index < value.length; index++) result = Math.imul(result ^ value.charCodeAt(index), 0x01000193);
    return (result >>> 0).toString(16).padStart(8, '0');
}
function sourceText(value, limit) {
    return String(value ?? '').replace(/<think>[\s\S]*?<\/think>/gi, '')
        .replace(/```(?:json|jsonl|text)?/gi, '').replace(/```/g, '').replace(/\u0000/g, '').trim().slice(0, limit);
}
function sourceRef(message, index) {
    const content = sourceText(message?.mes ?? message?.content, 6000);
    const full = sourceText(message?.mes ?? message?.content, 300000);
    const name = String(message?.name ?? message?.sender ?? (message?.is_user ? 'User' : 'Character'));
    return {
        index, key: `${message?.send_date ?? message?.date ?? ''}|${name}|${wireHash(content)}|${index}`,
        messageId: text(message?.extra?.gagaDogMessageId || message?.extra?.gaga_dog_message_id), name,
        hash: wireHash(`${name}\n${content}`), fullHash: wireHash(`${name}\n${full}`), fullLength: full.length,
    };
}
function flattenRefs(value) {
    // Schema 6 facts can contain one nested refs array from the producer's fallback.
    return list(value).flatMap(item => Array.isArray(item) ? item : [item]);
}
function refsMatch(refsValue, current) {
    const refs = flattenRefs(refsValue);
    if (!refs.length) return 'unknown';
    const byKey = new Map(current.map(item => [item.key, item]));
    const byId = new Map(current.filter(item => item.messageId).map(item => [item.messageId, item]));
    const byContent = new Map(current.map(item => [`${item.name}|${item.fullHash}`, item]));
    for (const ref of refs) {
        if (!record(ref) || !text(ref.hash)) return 'unknown';
        // Newer plugin records retain a stable message id. Older records use
        // the key/index pair; content fallback covers migrations that rebuilt
        // a key after a harmless chat move without weakening hash checks.
        const indexed = Number.isInteger(ref.index) ? current[ref.index] : null;
        const byIdMatch = ref.messageId && byId.get(ref.messageId);
        const byKeyMatch = ref.key && byKey.get(ref.key);
        const byContentMatch = ref.messageId && ref.fullHash && ref.name && byContent.get(`${ref.name}|${ref.fullHash}`);
        const now = byIdMatch
            || byKeyMatch
            // Content fallback is only safe for the new stable-id wire form;
            // legacy refs without an id must continue to detect reindex/date
            // changes through their original key/index provenance.
            || byContentMatch
            || indexed;
        if (!now || now.hash !== ref.hash || (ref.fullHash && now.fullHash !== ref.fullHash)) return 'changed';
        if (ref.key && !byIdMatch && !byKeyMatch && !byContentMatch && indexed?.key !== ref.key) return 'changed';
        if (ref.fullHash ? now.fullHash !== ref.fullHash : now.fullLength > 6000) return ref.fullHash ? 'changed' : 'unknown';
    }
    return 'valid';
}
const rangeOf = range => record(range) ? { start: range.start, end: range.end } : null;
const metadataFields = ['id', 'updatedAt', 'createdAt', 'userLocked', 'certainty', 'truthStatus', 'status', 'importance', 'mentionOnly'];
const recordFields = {
    facts: ['text', 'kind', 'subjects'],
    state: ['key', 'value', 'previous'],
    threads: ['text'],
    timeline: ['time', 'text', 'order'],
    npcs: ['name', 'aliases', 'identity', 'firstAppearance', 'relationship', 'notableActions', 'lastStatus', 'openThreads'],
    sceneCards: ['title', 'text', 'time', 'location', 'participants', 'turningPoints'],
};
function projectedRecord(value, kind) {
    if (!record(value)) return null;
    const result = {};
    for (const key of [...metadataFields, ...recordFields[kind]]) {
        const item = value[key];
        if (typeof item === 'string' || typeof item === 'boolean' || (typeof item === 'number' && Number.isFinite(item))) result[key] = item;
        else if (Array.isArray(item)) result[key] = item.filter(entry => typeof entry === 'string');
    }
    return result;
}
function recordsOf(state, kind) {
    return kind === 'state' ? Object.values(record(state.state) ? state.state : {}) : list(state[kind]);
}
function recordsProjection(state) {
    return Object.fromEntries(Object.keys(recordFields).map(kind => [kind, recordsOf(state, kind).map(item => projectedRecord(item, kind))]));
}
function recordIdentity(item, kind, index) {
    return text(item?.id) || (kind === 'state' ? text(item?.key) : '') || `${kind}:${index}`;
}
function hasRemovedRecords(state, baseline) {
    return Object.keys(recordFields).some(kind => {
        const current = new Set(recordsOf(state, kind).map((item, index) => recordIdentity(item, kind, index)));
        return recordsOf(baseline, kind).some((item, index) => !current.has(recordIdentity(item, kind, index)));
    });
}
function hasContent(state) {
    return Boolean(text(state.recap).trim() || Object.values(state.summaryArtifacts || {}).some(value => text(value).trim())
        || Object.keys(recordFields).some(kind => recordsOf(state, kind).length) || list(state.roundCapsules).length);
}
function contentNotInArtifact(value, kind, artifact) {
    const result = {};
    for (const key of recordFields[kind]) {
        const item = value[key];
        if (typeof item === 'string' && item.trim() && !artifact.includes(item)) result[key] = item;
        else if (Array.isArray(item)) {
            const missing = item.filter(entry => entry.trim() && !artifact.includes(entry));
            if (missing.length) result[key] = missing;
        }
    }
    if (!Object.keys(result).length) return null;
    for (const key of metadataFields) if (own(value, key)) result[key] = value[key];
    if (kind === 'npcs' && value.name) result.name = value.name;
    if (kind === 'state' && value.key) result.key = value.key;
    return result;
}
function relevantScene(item, query) {
    const lower = text(query).toLocaleLowerCase();
    return Boolean(lower && [...list(item.participants), ...list(item.keywords)]
        .some(term => typeof term === 'string' && term.trim().length >= 2 && lower.includes(term.trim().toLocaleLowerCase())));
}

/**
 * Pass only the current host context; never obtain chatMetadata from a cache.
 * settings is extensionSettings.gagaDogSummary, not all extension settings.
 * pluginAvailable=false handles a host-disabled/uninstalled extension with residual metadata.
 * Call again before applying an async result and compare snapshot.fingerprint plus host identity.
 * All returned text is untrusted historical source material, not system instructions.
 */
export function readGagaMemoryContext({ chatMetadata, chat, settings, pluginAvailable, chatKey = '', recentStartIndex, query = '' } = {}) {
    const state = record(chatMetadata?.[GAGA_MEMORY_KEY]) ? chatMetadata[GAGA_MEMORY_KEY] : null;
    const blocks = [], diagnostics = [];
    const diagnose = (code, scope = '') => {
        if (!diagnostics.some(item => item.code === code && item.scope === scope)) diagnostics.push({ code, ...(scope ? { scope } : {}) });
    };
    let status = 'empty';
    const current = Array.isArray(chat) ? chat.map(sourceRef) : [];
    const production = settings?.memoryMode ?? state?.memoryMode;
    const summaryMode = state?.summaryMode;
    const snapshot = {
        provider: 'gaga-dog-summary', chatKey: text(chatKey), schemaVersion: state?.schemaVersion ?? null,
        production: productions.has(production) ? production : null, summaryMode: modes.has(summaryMode) ? summaryMode : null,
        checkpointIds: [], ranges: [], pending: Boolean(state?.pending), revisionState: 'none', fingerprint: '',
    };
    const finish = () => {
        // Only already-approved memory fields participate, never credentials or director/DIY data.
        const revision = state ? {
            enabled: state.enabled, schemaVersion: state.schemaVersion, lastProcessedIndex: state.lastProcessedIndex,
            summaryMode: state.summaryMode, recap: state.recap,
            summaryArtifacts: Object.fromEntries(['novel', 'structured', 'mixed'].map(key => [key, text(state.summaryArtifacts?.[key])])),
            records: recordsProjection(state),
            checkpoints: list(state.checkpoints).map(item => ({ id: item?.id, status: item?.status, range: item?.range })),
            capsules: list(state.roundCapsules).map(item => ({ id: item?.id, text: item?.text, revision: item?.revision,
                updatedAt: item?.updatedAt, sourceRange: item?.sourceRange, title: item?.title, storyTime: item?.storyTime,
                participants: list(item?.participants), npcs: list(item?.npcs).map(npc => projectedRecord(npc, 'npcs')) })),
        } : null;
        const stamp = JSON.stringify(canonical([snapshot.chatKey, pluginAvailable !== false, settings?.workshopEnabled !== false,
            production, revision, current, status, blocks, diagnostics]));
        snapshot.fingerprint = `gaga-memory:${snapshot.schemaVersion || 'unknown'}:${stamp.length}:${wireHash(stamp)}:${wireHash([...stamp].reverse().join(''))}`;
        return { status, blocks, snapshot, diagnostics, text: blocks.map(block => `【${block.label}】\n${block.text}`).join('\n\n') };
    };
    if (pluginAvailable === false || !state) { status = 'unavailable'; return finish(); }
    if (settings?.workshopEnabled === false || state.enabled === false) { status = 'disabled'; return finish(); }
    if (!GAGA_MEMORY_SUPPORTED_SCHEMAS.has(state.schemaVersion) || !productions.has(production) || !modes.has(summaryMode)) {
        status = 'unsupported'; diagnose('unsupported_memory_schema_or_mode'); return finish();
    }
    if (!hasContent(state)) return finish();
    if (!Array.isArray(chat)) { status = 'unverified'; diagnose('chat_source_unavailable'); return finish(); }
    const checkpoints = list(state.checkpoints);
    let aggregateValid = checkpoints.length > 0;
    for (const checkpoint of checkpoints) {
        const validity = refsMatch(checkpoint?.range?.refs, current);
        if (checkpoint?.status !== 'committed' || validity !== 'valid') {
            aggregateValid = false;
            diagnose(validity === 'changed' ? 'memory_source_changed' : 'memory_source_unverified', 'summary');
        }
    }
    if (!checkpoints.length && (text(state.recap).trim() || Object.values(state.summaryArtifacts || {}).some(value => text(value).trim()))) {
        diagnose('memory_source_unverified', 'summary');
    }
    const selected = own(state.summaryArtifacts, summaryMode) ? text(state.summaryArtifacts[summaryMode]) : text(state.recap);
    const latest = checkpoints.at(-1);
    const baseline = record(latest?.memorySnapshot) ? latest.memorySnapshot : null;
    let allowRecords = false;
    let recordCorrections = false;
    let artifactForComparison = selected;
    let removedRecords = false;
    if (aggregateValid) {
        snapshot.checkpointIds = checkpoints.map(item => text(item.id));
        snapshot.ranges.push(...checkpoints.map(item => rangeOf(item.range)).filter(Boolean));
        if (selected.trim()) blocks.push({ kind: 'summary', label: { novel: '小说版记忆', structured: '结构化记忆', mixed: '混合版记忆' }[summaryMode],
            text: selected, source: { checkpointIds: [...snapshot.checkpointIds], summaryMode } });
        if (baseline) {
            const baselineArtifact = own(baseline.summaryArtifacts, summaryMode) ? text(baseline.summaryArtifacts[summaryMode]) : text(baseline.recap);
            const artifactChanged = selected !== baselineArtifact;
            const recordsChanged = !same(recordsProjection(state), recordsProjection(baseline));
            snapshot.revisionState = artifactChanged ? (recordsChanged ? 'unresolved' : 'artifact_edited') : (recordsChanged ? 'records_edited' : 'synchronized');
            // There is no artifact revision clock upstream. Never merge stale records back into edited prose.
            allowRecords = !artifactChanged;
            recordCorrections = recordsChanged && !artifactChanged;
            removedRecords = recordCorrections && hasRemovedRecords(state, baseline);
            if (removedRecords) {
                // A stale aggregate may still contain a deliberately deleted fact. Do not re-send it.
                const summaryIndex = blocks.findIndex(block => block.kind === 'summary');
                if (summaryIndex >= 0) blocks.splice(summaryIndex, 1);
                artifactForComparison = '';
                diagnose('artifact_withheld_after_record_removal');
            }
            if (artifactChanged && Object.keys(recordFields).some(kind => recordsOf(state, kind).length)) {
                diagnose(recordsChanged ? 'artifact_record_order_unknown' : 'records_withheld_for_edited_artifact');
            }
        } else {
            snapshot.revisionState = 'unknown'; diagnose('record_revision_baseline_missing');
        }
    }
    if (allowRecords) {
        if (recordCorrections) blocks.push({ kind: 'revision_notice', label: '记忆修订依据',
            text: removedRecords ? '结构记录已有删改，未同步的旧成品本次未引用。下列资料仅来自当前结构记录。'
                : '当前成品仍与最近已提交版本一致，结构记录此后已有修订。成品涉及这些修订字段时，当前结构记录是更新后的依据。',
            source: { revisionState: 'records_edited' } });
        for (const kind of Object.keys(recordFields)) {
            const output = [];
            const baselineRecords = new Map(recordsOf(baseline || {}, kind).map((item, index) => [recordIdentity(item, kind, index), projectedRecord(item, kind)]));
            for (const [index, original] of recordsOf(state, kind).entries()) {
                if (!record(original)) continue;
                if (kind === 'threads' && !original.userLocked && original.status !== 'open') continue;
                if (kind === 'state' && !original.userLocked && original.status === 'resolved') continue;
                if (kind === 'sceneCards' && !relevantScene(original, query)) continue;
                const refs = kind === 'sceneCards' ? original.sourceRange?.refs : original.sourceRefs;
                const validity = refsMatch(refs, current);
                if (validity !== 'valid') { diagnose(validity === 'changed' ? 'record_source_changed' : 'record_source_unverified', kind); continue; }
                const projected = projectedRecord(original, kind);
                const changed = recordCorrections && !same(projected, baselineRecords.get(recordIdentity(original, kind, index)));
                const missing = changed ? projected : contentNotInArtifact(projected, kind, artifactForComparison);
                if (missing) output.push(missing);
            }
            if (output.length) blocks.push({ kind, label: `${recordCorrections ? '当前修订的' : ''}${{
                facts: '事实记录', state: '状态记录', threads: '未结事项', timeline: '时间记录', npcs: '人物记录', sceneCards: '相关旧场景',
            }[kind]}`, text: JSON.stringify(output), source: { checkpointIds: [...snapshot.checkpointIds], revisionState: snapshot.revisionState } });
        }
        if (recordCorrections) diagnose('records_newer_than_artifact');
    }
    if (production === 'layered') {
        const recent = Number.isInteger(recentStartIndex) && recentStartIndex >= 0 ? recentStartIndex : Number.POSITIVE_INFINITY;
        const active = list(state.roundCapsules).filter(item => Number(item?.sourceRange?.end) > Number(state.lastProcessedIndex ?? -1))
            .sort((left, right) => Number(left?.sourceRange?.start) - Number(right?.sourceRange?.start));
        let chainInvalid = !aggregateValid && checkpoints.length > 0;
        for (const capsule of active) {
            const validity = refsMatch(capsule?.sourceRange?.refs, current);
            if (validity !== 'valid') { chainInvalid = true; diagnose(validity === 'changed' ? 'capsule_source_changed' : 'capsule_source_unverified'); }
            if (chainInvalid || !text(capsule?.text).trim()) continue;
            const range = rangeOf(capsule.sourceRange);
            if (Number(range.start) >= recent) continue;
            const content = { title: text(capsule.title), text: capsule.text, storyTime: text(capsule.storyTime),
                participants: list(capsule.participants).filter(item => typeof item === 'string'),
                npcs: list(capsule.npcs).map(item => projectedRecord(item, 'npcs')).filter(Boolean) };
            blocks.push({ kind: 'capsule', label: '近期剧情胶囊', text: JSON.stringify(content), source: {
                id: text(capsule.id), range, revision: capsule.revision ?? null, updatedAt: capsule.updatedAt ?? null,
            } });
            snapshot.ranges.push(range);
        }
    }
    const uncertain = diagnostics.some(item => item.code !== 'records_newer_than_artifact');
    status = blocks.length ? (uncertain ? 'partial' : 'ready') : (diagnostics.length ? 'unverified' : 'empty');
    return finish();
}
