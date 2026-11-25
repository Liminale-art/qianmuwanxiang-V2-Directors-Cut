// Shared, data-only contract. Chat originals and connection secrets never live here.
import {invalidateDependentStages, sourceRanges, stageDependenciesValid, stageSourceFromParents, validateStageSource, hasCustomParents} from './stage-contract.mjs';
import {validateExcerpt, recallBlockReason, excerptDependenciesValid, invalidateDependentExcerpts, excerptRecords} from './recall-contract.mjs';
import {validateOrigin, validateLineage, validateCreation} from './story-contract.mjs';
import {validateCompanion, applyCompanionOperation} from './companion-contract.mjs';
import { validateScenes } from './scene-contract.mjs';
import { normalizeEntryOrder, insertEntryOrder, validatePlacement, validateMemoryTitle } from './timeline.mjs';
import { DEFAULT_PROMPTS, validatePromptConfig, resolvePromptConfig } from './prompt-settings.mjs';
import { DEFAULT_CONTEXT_RULES, validateContextRules } from './context-filter.mjs';
import { validateHeart, applyHeartOperation, HEART_OPERATIONS } from './heart-contract.mjs';
export {sourceRanges, stageDependenciesValid, stageSourceFromParents, validateStageSource} from './stage-contract.mjs';
export {recallBlockReason, excerptDependenciesValid} from './recall-contract.mjs';
// Frontend assets and the server plugin are released independently.  The
// Shared contract file is copied to both sides. Keep VERSION as the legacy
// service alias for existing data/tests; UI and packaging use the explicit
// FRONTEND_VERSION/SERVICE_VERSION names below.
export const FRONTEND_VERSION = '0.8.78';
export const SERVICE_VERSION = '0.8.35';
export const VERSION = SERVICE_VERSION;
// Floors are 1-based internally and in storage (floor N = messages[N - 1]); ST numbers
// its messages from #0. Every floor number shown to the user goes through shownFloor so
// labels match the chat, and inputs convert back with floorValue.
export const shownFloor = floor => floor - 1;
export const floorField = floor => Number.isSafeInteger(floor) && floor >= 1 ? String(floor - 1) : '';
export const floorValue = text => String(text ?? '').trim() === '' ? 0 : Number(text) + 1;
export const SCHEMA = 8;
export const DEFAULTS = Object.freeze({ recent: 5, trigger: 50000, triggerFloors: 10, batch: 6000, budget: 0, maxSlices: 12, recallCooldown: 6, summarySlices: 4, preference: '', profileId: '', model: '',
    stageAuto: true, stageBasis: 'tokens', stageThreshold: 20000, stageRecent: 10, sliceChars: 2000, stageChars: 3000,
    recall: false, companionShareCustom: false, vectorEnabled: false, rerankEnabled: false, prompts: DEFAULT_PROMPTS,
    // 心迹页：观察日记与关系年表跟着整理走（默认开）；心迹由主模型顺带写（默认关）；两处注入都默认关。
    diary: true, diaryAuto: true, chronicle: true, diaryChars: 60, diaryInject: false, thoughts: false, thoughtChars: 200, thoughtCooldown: 10, thoughtInject: false,
    contextRules: DEFAULT_CONTEXT_RULES });
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
    const bounds = { recent: [1, 2000], trigger: [256, 1000000], triggerFloors: [1, 2000], batch: [256, 100000], budget: [0, 1000000], maxSlices: [0, 2000], recallCooldown: [0, 2000], summarySlices: [0, 2000], stageThreshold: [1, 1000000],
        stageRecent: [0, 2000], sliceChars: [1, 100000], stageChars: [1, 100000], diaryChars: [10, 400], thoughtChars: [20, 2000], thoughtCooldown: [1, 2000] };
    for (const [key, value] of Object.entries(input)) {
        requireThat(Object.hasOwn(DEFAULTS, key), '未知的忆幕设置');
        if (value === null && partial) { result[key] = null; continue; }
        if (['stageAuto', 'recall', 'companionShareCustom', 'vectorEnabled', 'rerankEnabled', 'diary', 'diaryAuto', 'chronicle', 'diaryInject', 'thoughts', 'thoughtInject'].includes(key)) requireThat(typeof value === 'boolean', '忆幕开关设置无效');
        else if (key === 'stageBasis') requireThat(['tokens', 'floors', 'slices'].includes(value), '阶段整理依据无效');
        else if (key === 'prompts') { result[key] = validatePromptConfig(value); continue; }
        else if (key === 'contextRules') { result[key] = validateContextRules(value); continue; }
        else if (bounds[key]) {
            requireThat(Number.isSafeInteger(value) && (value === 0 && !['sliceChars', 'stageChars', 'diaryChars', 'thoughtChars', 'thoughtCooldown'].includes(key) || value >= bounds[key][0]) && value <= bounds[key][1], '设置数值超出范围');
        } else requireThat(typeof value === 'string' && value.length <= (key === 'preference' ? 12000 : 300), '设置文字过长或无效');
        result[key] = value;
    }
    return partial ? result : { ...DEFAULTS, ...result };
}
export function effectiveSettings(document, defaults) {
    // 忆幕的设置都是账户全局的（用户 2026-11-24：不分聊天）。聊天里以前单独存过的值只在还没读到全局默认时兜底。
    const settings = { ...DEFAULTS, ...document?.settings, ...defaults?.values };
    // 「原文回查与补充」已去掉（用户 2026-11-24）：旧资料里存着的开关一律当作关。已存下的原文摘录照常可读。
    settings.recall = false;
    for (const key of ['recent', 'trigger']) if (settings[key] === 0) settings[key] = DEFAULTS[key];
    // Legacy batch is retained on disk only. Trigger is the single input target;
    // runtime may narrow this derived cap to the actual connection window.
    settings.batch = settings.trigger;
    // `floors` was the old UI choice. Keep old files readable, but run them
    // with the supported token basis so the removed choice cannot reappear.
    if (settings.stageBasis === 'floors') {
        settings.stageBasis = 'tokens';
        if (settings.stageThreshold === 100) settings.stageThreshold = DEFAULTS.stageThreshold;
    }
    if (settings.stageThreshold === 0) settings.stageThreshold = { tokens: 65000, slices: 12 }[settings.stageBasis];
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
function validateTemporalFields(entry) {
    // P3.5-A: Optional temporal metadata for fact lifecycle tracking.
    // These fields enable "what was true when" queries without changing current retrieval behavior.
    if (entry.validFrom !== undefined) {
        requireThat(Number.isSafeInteger(entry.validFrom) && entry.validFrom >= 1, 'validFrom 必须为正整数楼层');
    }
    if (entry.validTo !== undefined) {
        requireThat(Number.isSafeInteger(entry.validTo) && entry.validTo >= 1, 'validTo 必须为正整数楼层');
        if (entry.validFrom !== undefined) {
            requireThat(entry.validTo >= entry.validFrom, 'validTo 不能早于 validFrom');
        }
    }
    if (entry.observedAt !== undefined) {
        requireThat(Number.isSafeInteger(entry.observedAt) && entry.observedAt >= 1, 'observedAt 必须为正整数楼层');
    }
    if (entry.supersedes !== undefined) {
        requireThat(Array.isArray(entry.supersedes) && entry.supersedes.length <= 64, 'supersedes 必须为数组且不超过 64 项');
        entry.supersedes = entry.supersedes.map(id => {
            identifier(id);
            return id;
        });
    }
    if (entry.factStatus !== undefined) {
        requireThat(['active', 'ended', 'uncertain'].includes(entry.factStatus), 'factStatus 必须为 active/ended/uncertain');
    }
}
// 观察日记的原料「痕迹」：每次切片总结顺带记下的一句「看到了什么」。只存不注入；
// 同一件事在不同日子反复出现，才会在观察日记里凝成印象。（字段叫 observations，
// 以免和清理范围里的 traces——已删除与被替换的旧记录——混淆。）
export const OBSERVATION_LIMIT = 1000;
const OBSERVATION_BATCH = 3;
function validateObservation(value) {
    requireThat(value && typeof value === 'object' && !Array.isArray(value), '痕迹格式无效');
    const about = typeof value.about === 'string' ? value.about.trim() : '', text = typeof value.text === 'string' ? value.text.trim() : '';
    requireThat(about && about.length <= 120 && text && text.length <= 300, '痕迹内容无效');
    requireThat(Number.isSafeInteger(value.floor) && value.floor >= 1 && Number.isSafeInteger(value.at) && value.at >= 0, '痕迹的依据无效');
    const result = { id: identifier(value.id), about, text, floor: value.floor, at: value.at };
    if (value.date !== undefined && value.date !== '') { requireThat(typeof value.date === 'string' && value.date.length <= 60, '痕迹的日期无效'); result.date = value.date.trim(); }
    if (value.used === true) result.used = true; // 已经归进过印象（或看过、不成印象）的痕迹
    return result;
}
export function validateObservations(value) {
    requireThat(Array.isArray(value) && value.length <= OBSERVATION_LIMIT, '痕迹数量无效');
    const ids = new Set();
    return value.map(item => { const result = validateObservation(item); requireThat(!ids.has(result.id), '痕迹标识重复'); ids.add(result.id); return result; });
}
/** 从模型返回里取痕迹：格式不对的逐条丢掉，从不因为它让整次总结失败。 */
export function parseObservations(response, { start = 1, end = Infinity } = {}) {
    let parsed;
    try { parsed = JSON.parse(String(response || '').trim().replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/, '$1')); } catch { return []; }
    if (!Array.isArray(parsed?.traces)) return [];
    const seen = new Set();
    // n：这条在模型返回的 "traces" 里是第几条（从 1 数起）。同一次返回里的印象按这个序号指认痕迹；它不存进资料。
    return parsed.traces.flatMap((item, index) => {
        const about = typeof item?.about === 'string' ? item.about.trim().slice(0, 120) : '', text = typeof item?.text === 'string' ? item.text.trim().slice(0, 300) : '';
        const floor = Number.isSafeInteger(item?.floor) && item.floor >= start && item.floor <= end ? item.floor : null;
        if (!about || !text || floor === null || seen.has(`${about}\n${text}`)) return [];
        seen.add(`${about}\n${text}`);
        return [{ about, text, floor, n: index + 1 }];
    }).slice(0, OBSERVATION_BATCH);
}
export function validateDocument(raw) {
    requireThat([1, 2, 3, 4, 5, 6, 7, SCHEMA].includes(raw?.schema) && Number.isSafeInteger(raw.revision) && raw.revision >= 0 && Number.isSafeInteger(raw.epoch) && raw.epoch >= 0 && Number.isSafeInteger(raw.configRevision) && raw.configRevision >= 0 && typeof raw.enabled === 'boolean' && Array.isArray(raw.entries) && Array.isArray(raw.operations), '忆幕资料格式损坏，已停止写入');
    if (raw.schema !== SCHEMA) raw = {...clone(raw), schema: SCHEMA, autoSummary: raw.schema < 6 ? raw.enabled : raw.autoSummary};
    requireThat(typeof raw.autoSummary === 'boolean', '自动总结状态无效');
    raw = clone(raw);
    normalizeBinding(raw.binding); validateSettings(raw.settings);
    if (raw.lineage) raw.lineage = validateLineage(raw.lineage);
    if (raw.creation) validateCreation(raw.creation);
    if (raw.companion) raw.companion = validateCompanion(raw.companion);
    if (raw.observations !== undefined) raw.observations = validateObservations(raw.observations);
    if (raw.heart !== undefined) raw.heart = validateHeart(raw.heart);
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
        // 钉住：永不沉底、列表固定在上方；不提高带入优先级。屏蔽的永不带入，两者互斥。
        if (entry.pinned !== undefined) requireThat(typeof entry.pinned === 'boolean', '钉住标记无效');
        if (entry.pinned === false) delete entry.pinned;
        if (entry.pinned && ['excluded', 'deleted'].includes(entry.status)) delete entry.pinned;
        validateTemporalFields(entry);
        if (entry.kind === 'summary') validateSource(entry.source);
        else if (entry.kind === 'stage') validateStageSource(entry.source);
        else if (entry.kind === 'excerpt') validateExcerpt(entry);
        else requireThat(entry.source === null, '自定义切片不能伪造原文来源');
        entry.scenes = validateScenes(entry.scenes, entry.kind === 'summary' ? entry.source : {});
        if (entry.kind === 'manual') entry.placement = validatePlacement(entry.placement);
        for (const version of [...entry.history, ...entry.conflicts, ...(entry.candidate ? [entry.candidate] : [])]) {
            if (version.title !== undefined) version.title = validateMemoryTitle(version.title);
            if (version.discardedSources !== undefined) version.discardedSources = validateDiscardedSources(version.discardedSources);
            validateTemporalFields(version);
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
    // 早先版本留下的、仍带全文的「已被替换」记录，顺手压成最小记录。
    for (const entry of document.entries) if (entry.kind === 'summary' && entry.replacedBy && !entry.discarded) compactReplaced(document, entry);
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
    const temporal = {};
    if (input.validFrom !== undefined) temporal.validFrom = input.validFrom;
    if (input.validTo !== undefined) temporal.validTo = input.validTo;
    if (input.observedAt !== undefined) temporal.observedAt = input.observedAt;
    if (input.supersedes !== undefined) temporal.supersedes = input.supersedes;
    if (input.factStatus !== undefined) temporal.factStatus = input.factStatus;
    return { id: identifier(input.id), kind: input.kind, text: textValue(input.text), ...(input.title !== undefined ? { title: validateMemoryTitle(input.title) } : {}), source, scenes, ...(input.kind === 'manual' ? { placement } : {}), ...temporal };
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
function requireSummaryRange(document, submitted, discardedSources, replaces, replaceRange) {
    // 已被新切片替换掉的旧记录（replacedBy）只是留痕，不占来源：同一批的后续切片、以后的再次总结都不受它阻挡。
    const overlaps = document.entries.filter(entry => entry.kind === 'summary' && !entry.origin && entry.source && !entry.replacedBy
        && entry.source.start <= submitted.source.end && entry.source.end >= submitted.source.start);
    if (replaces !== undefined) {
        // 手动总结按「每批 N 层」切段：一批覆盖到的旧切片整组换掉。
        // 这里只做「能不能换」的判断，不要求修订号与计划时完全一致——批次之间会自然产生修订
        // （前几批的替换、来源核对留下的失效标记），拿旧修订号去卡只会让正常总结反复报「记忆已变化」。
        // 真正必须守住的边界是：只换自动生成、未人工改过、且范围完整落在本段内的切片；
        // 已人工修订或含自定义内容的切片一律不换（它们会作为分界把本批隔开）。
        requireThat(Array.isArray(replaces) && replaces.length > 0, '待替换的记忆引用无效');
        // 一批通常产出多条切片：要换掉的旧切片按「整批范围」核对，而不是按本批第一条切片的范围——
        // 否则第一条切片范围之外的旧切片全被判成「记忆已变化」，正常总结反而走不通。
        const scope = replaceRange ?? submitted.source;
        requireThat(Number.isSafeInteger(scope?.start) && Number.isSafeInteger(scope?.end) && scope.start >= 1 && scope.end >= scope.start
            && scope.start <= submitted.source.start && scope.end >= submitted.source.end, '待替换的记忆范围无效');
        const ids = new Set();
        for (const ref of replaces) {
            requireThat(ref && typeof ref.id === 'string' && !ids.has(ref.id), '待替换的记忆引用无效');
            ids.add(ref.id);
            const entry = document.entries.find(item => item.id === ref.id && item.kind === 'summary');
            requireThat(entry && !entry.edited && !entry.origin && entry.status !== 'deleted'
                && !hasCustomParents(entry, document)
                && entry.source.start >= scope.start && entry.source.end <= scope.end,
            '此范围内的记忆已变化，请刷新后重试');
        }
        // 段内若出现本批没列出的自动切片，说明计划之后又生成了新的：这种情况下本批照常写入，
        // 由替换逻辑把它们一并归档，不再整批作废。
        submitted.replaces = replaces.map(ref => ({ id: ref.id, revision: ref.revision }));
        if (discardedSources !== undefined) submitted.discardedSources = validateDiscardedSources(discardedSources);
        return;
    }
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
function replaceSummaryOwners(document, submitted, replacements = []) {
    if (!replacements?.length) return;
    requireThat(submitted.kind === 'summary', '记忆替换范围无效');
    for (const ref of replacements) {
        // 按编号找（修订号在批次之间会自然变化，校验已在 requireSummaryRange 里做过）。
        const previous = document.entries.find(entry => entry.id === ref.id && entry.kind === 'summary');
        if (!previous) continue;
        previous.replacedBy = submitted.id;
        compactReplaced(document, previous);
    }
}
// 被新切片替换掉的旧切片不能撤回（范围已由新切片接管），留着全文与修订历史只会让文件越总结越大。
// 只保留最小记录：编号、来源范围与「被谁替换」——足以防止旧备份把它当成有效记忆带回来。
function compactReplaced(document, entry) {
    const retained = Object.fromEntries(['id', 'kind', 'source', 'replacedBy', 'deletedRevision'].filter(key => Object.hasOwn(entry, key)).map(key => [key, clone(entry[key])]));
    const revision = entry.revision + 1;
    for (const key of Object.keys(entry)) delete entry[key];
    Object.assign(entry, retained, { text: '已删除', revision, status: 'deleted', discarded: true, edited: false, scenes: [], history: [], conflicts: [], candidate: null,
        deletedRevision: retained.deletedRevision ?? document.revision + 1 });
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
export const ADOPT_LIMIT = 2000;
/** 一份记忆文件里「值得带走」的内容，按时间顺序：阶段总结，加上没有并入任何阶段的切片与自定义切片。
 *  已删除、被替换、已丢弃、来源待核对的都不带；摘录与修订历史也不带。 */
export function portableMemories(document) {
    const entries = document?.entries || [], order = new Map((document?.entryOrder || []).map((value, index) => [value, index]));
    const usable = entry => entry.status === 'active' && !entry.replacedBy && !entry.discarded && !entry.origin?.unresolved && typeof entry.text === 'string' && entry.text.trim();
    const staged = new Set(entries.filter(entry => entry.kind === 'stage' && usable(entry)).flatMap(entry => (entry.source?.parents || []).map(ref => ref.id)));
    return entries.filter(entry => ['stage', 'summary', 'manual'].includes(entry.kind) && usable(entry) && !staged.has(entry.id))
        .sort((a, b) => (order.get(a.id) ?? Infinity) - (order.get(b.id) ?? Infinity))
        .map(entry => ({ ...(entry.title ? { title: entry.title } : {}), text: entry.text,
            scenes: (entry.scenes || []).map(scene => ({ ...Object.fromEntries(['world', 'timeline', 'date', 'period', 'place', 'event', 'characters', 'nature'].filter(key => scene[key] !== undefined).map(key => [key, clone(scene[key])])),
                evidence: { floors: [], user: true } })) }));
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
            // 自动总结从哪一层算起可以重定：旧楼很多时用户选「不从首层总结」，起点改到当时那一层。
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
        // 先按修订号校验本批要换掉的旧切片，再真正替换：替换会改 revision，校验必须在它之前。
        if (value.kind === 'summary') requireSummaryRange(doc, value, op.discardedSources, op.replaces, op.replaceRange);
        replaceStageOwners(doc, value, op.replaceStages);
        replaceSummaryOwners(doc, value, op.replaces);
        requireUnusedStageParents(doc, value);
        if (value.kind !== 'manual') {
            requireThat(doc.enabled && op.expectedEpoch === doc.epoch, '整理期间启用状态或设置已变化，本次结果未采用');
            requireThat(!doc.lineage || value.source.start > doc.lineage.bridgeCount || value.kind === 'stage', '衔接原文不是新剧情，不重复整理');
        }
        doc.entries.push({ ...value, revision: 1, status: 'active',
            edited: value.kind === 'manual',
            history: [], conflicts: [], candidate: null });
        insertEntryOrder(doc, value, Object.hasOwn(op, 'afterId') ? op.afterId : op.entry.afterId);
    } else if (op.type === 'observe') {
        // 记下一批痕迹。同一段楼层重新总结时，旧的那批痕迹由新的一批替换，不会越记越多。
        requireThat(Array.isArray(op.items) && op.items.length <= OBSERVATION_BATCH, '痕迹数量无效');
        requireThat(op.range && Number.isSafeInteger(op.range.start) && op.range.start >= 1 && Number.isSafeInteger(op.range.end) && op.range.end >= op.range.start, '痕迹范围无效');
        requireThat(Number.isSafeInteger(op.at) && op.at >= 0, '痕迹的记录时间无效');
        const kept = (doc.observations || []).filter(item => item.floor < op.range.start || item.floor > op.range.end);
        const added = op.items.map((item, index) => {
            requireThat(Number.isSafeInteger(item?.floor) && item.floor >= op.range.start && item.floor <= op.range.end, '痕迹的依据不在本次总结范围内');
            return validateObservation({ ...item, id: `${id}_${index}`.slice(0, 100), at: op.at });
        });
        doc.observations = [...kept, ...added].slice(-OBSERVATION_LIMIT);
    } else if (HEART_OPERATIONS.includes(op.type)) {
        applyHeartOperation(doc, op, id);
    } else if (op.type === 'adopt') {
        // 把另一份记忆文件（别的聊天、或原文对不上的备份）带进当前聊天。
        // 那些记忆描述的不是这个聊天的楼层，所以一律落成自定义切片：照常注入，
        // 但不参与隐藏楼层、不会被自动重新总结，也不冒充这个聊天的来源范围。
        requireThat(Array.isArray(op.entries) && op.entries.length >= 1 && op.entries.length <= ADOPT_LIMIT, '没有可带入的记忆');
        const placement = validatePlacement(op.placement, { binding: doc.binding });
        requireThat(placement, '请先打开要带入记忆的聊天');
        let after; // 第一条按楼层自动落位（锚在首层，排在最前），其余依次接在后面，保持原来的先后。
        op.entries.forEach((item, index) => {
            const value = submittedEntry({ id: `${id}_${index}`.slice(0, 100), kind: 'manual', title: item?.title, text: item?.text, scenes: item?.scenes, placement }, doc);
            requireThat(!doc.entries.some(entry => entry.id === value.id), '此记忆条目已经存在');
            doc.entries.push({ ...value, revision: 1, status: 'active', edited: true, history: [], conflicts: [], candidate: null });
            insertEntryOrder(doc, value, after); after = value.id;
        });
    } else if (op.type === 'purge') {
        // 清理当前聊天的记忆。三种范围，全部只动忆幕自己的文档，聊天原文不碰：
        //   all        清空全部条目（keepManual 为真时保留用户自己写的自定义切片）
        //   traces     只清留痕：已删除的记录与被新切片替换掉的旧切片
        // 设置、启用状态与自动总结起点保留，所以清完可以直接重新总结。
        requireThat(['all', 'traces'].includes(op.scope), '清理范围无效');
        requireThat(op.expectedRevision === doc.revision, '记忆已在别处变化，请刷新后再清理');
        if (op.scope === 'all') {
            delete doc.observations; delete doc.heart; // 痕迹、印象、心迹与年表跟着记忆一起清
            const kept = op.keepManual === true ? doc.entries.filter(entry => entry.kind === 'manual' && entry.status !== 'deleted' && !entry.origin) : [];
            // 留下的自定义切片不能再指向已清掉的条目。
            for (const entry of kept) for (const scene of entry.scenes || []) if (scene.evidence?.inheritedFrom) delete scene.evidence.inheritedFrom;
            doc.entries = kept; doc.entryOrder = kept.map(entry => entry.id);
            // 旧操作的回执里存着每条记忆的原文，清空时一并丢掉，文件才真的变小。
            doc.operations = []; doc.receipts = {};
        } else {
            const referenced = new Set();
            for (const entry of doc.entries) {
                if (entry.status === 'deleted') continue;
                for (const ref of entry.source?.parents || []) referenced.add(ref.id);
                if (entry.parent?.id) referenced.add(entry.parent.id);
                for (const scene of entry.scenes || []) if (scene.evidence?.inheritedFrom?.id) referenced.add(scene.evidence.inheritedFrom.id);
            }
            // 仍被别的条目引用的留痕不清（清了会让引用它的条目失去依据）。
            doc.entries = doc.entries.filter(entry => entry.status !== 'deleted' || referenced.has(entry.id));
            const kept = new Set(doc.entries.map(entry => entry.id));
            doc.entryOrder = (doc.entryOrder || []).filter(entryId => kept.has(entryId));
        }
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
                case 'exclude': revise(entry, { status: 'excluded', pinned: undefined }); break;
                case 'restore':
                    requireThat(entry.status === 'excluded', '只有暂不使用的条目可恢复');
                    revise(entry, { status: 'active' }); break;
                case 'pin': {
                    // 钉住＝永不沉底、列表固定在上方；不提高带入优先级。与屏蔽互斥。
                    requireThat(!['excluded', 'deleted'].includes(entry.status), '已屏蔽或已删除的记忆不能钉住');
                    requireThat(!entry.origin?.unresolved, '继承来源尚未核对的记忆不能钉住');
                    revise(entry, { pinned: true }); break;
                }
                case 'unpin': revise(entry, { pinned: undefined }); break;
                case 'acceptSource': {
                    // 用户确认「正文变了也照旧用这条切片」：把来源指纹换成现在的原文，切片恢复正常。不改内容、不升条目修订号，
                    // 所以引用它的阶段总结也不会因此失效。服务端会按现在的聊天核对这组新指纹。
                    requireThat(entry.source && Array.isArray(entry.source.hashes) && entry.kind === 'summary' && !entry.origin, '这条记忆没有可确认的原文来源');
                    requireThat(Array.isArray(op.hashes) && op.hashes.length === entry.source.end - entry.source.start + 1 && op.hashes.every(x => typeof x === 'string' && /^[a-f0-9]{64}$/.test(x)), '确认用的原文指纹无效');
                    entry.source = { ...entry.source, hashes: [...op.hashes] };
                    if (entry.status === 'invalid') entry.status = 'active';
                    break;
                }
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
// Every floor is fingerprinted again on each refresh, each generation and each summary batch, while almost
// all floors are unchanged between calls. The digest of one floor depends only on its identity fields,
// so it is remembered by those fields (bounded; a changed floor simply misses and is hashed afresh).
//
// 隐藏标记（is_system）不参与指纹，该位固定按「未隐藏」计算：忆幕自己会按「保留最近 N 层」隐藏旧楼，
// 而隐藏从不改变那一层写了什么。它参与指纹会自相矛盾——忆幕刚隐藏的楼层来源指纹立刻对不上，
// 自己的切片被判失效，手动总结的下一批随即报「此范围内的记忆已变化」。
// 元组形状不变（该位恒为 false），所以楼层未隐藏时生成的旧指纹原样匹配，不需要兼容层。
// 服务端 server-store.mjs 与 backup-store.mjs 各有一份同步实现，三处必须一致。
const FINGERPRINT_MEMO = new Map(), FINGERPRINT_MEMO_LIMIT = 6000;
export async function fingerprintMessages(messages) {
    const subtle = globalThis.crypto?.subtle ?? (typeof process !== 'undefined' && process.versions?.node ? (await import('node:crypto')).webcrypto.subtle : null);
    requireThat(subtle, '当前页面缺少安全指纹能力，请使用 HTTPS 或本机地址');
    return Promise.all(messages.map(async message => {
        const key = JSON.stringify([String(message.name || ''), Boolean(message.is_user), false, String(message.mes || ''), String(message.send_date ?? '')]);
        const known = FINGERPRINT_MEMO.get(key);
        if (known) return known;
        const hash = Array.from(new Uint8Array(await subtle.digest('SHA-256', new TextEncoder().encode(key))), x => x.toString(16).padStart(2, '0')).join('');
        if (FINGERPRINT_MEMO.size >= FINGERPRINT_MEMO_LIMIT) FINGERPRINT_MEMO.clear();
        FINGERPRINT_MEMO.set(key, hash);
        return hash;
    }));
}
export function sourceMatches(source, hashes) {
    try {
        const ranges = sourceRanges(source);
        return Boolean(ranges.length && Array.isArray(hashes) && ranges.every(range => range.end <= hashes.length
            && range.hashes.every((hash, i) => hashes[range.start - 1 + i] === hash)));
    } catch { return false; }
}
