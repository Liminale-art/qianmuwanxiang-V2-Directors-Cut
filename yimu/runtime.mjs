import { SERVICE_VERSION, DEFAULTS, shownFloor, bindingKey, effectiveSettings, fingerprintMessages, sourceMatches } from './contract.mjs';
import { buildPlan, inspectSources, nextBatch, parseSummary, summaryPrompt, planManualRange, manualBatchFloors, initialRangePreview, estimateTokens, hiddenFloorsFor } from './core.mjs';
import { nextStage, parseStage, stagePrompt, planStageRange } from './layers.mjs';
import { stageSourceFromParents } from './stage-contract.mjs';
import { recallCandidates, parseRecallRequest, recallPrompt, parseRecallQuote, recallFits } from './recall.mjs';
import { recallBlockReason } from './recall-contract.mjs';
import { createStoryActions } from './story-runtime.mjs';
import { createCompanionActions } from './companion-runtime.mjs';
import { createBackupActions } from './backup-runtime.mjs';
import { validateGeneratedLength } from './scene-contract.mjs';
import { summaryRequestBudget, SUMMARY_SYSTEM } from './budget.mjs';
import { memoryTitle } from './timeline.mjs';
import { isNewerYimuVersion } from './release-version.mjs';
import { buildRetrievalCandidates, retrievalContext } from './retrieval-contract.mjs';
import { discoverVectorCandidates, discoverRerankCandidates } from './vector-contract.mjs';

const uniqueId = () => globalThis.crypto?.randomUUID?.() || `ym_${Date.now()}_${Math.random().toString(36).slice(2)}`;
const equalBinding = (a, b) => !!a && !!b && bindingKey(a) === bindingKey(b);
const clone = value => structuredClone(value);

/** Browser-lifetime coordinator, not a background server or a second source database. */
export function createController({ host, api, onChange = () => {}, onNotice = () => {}, countTokens = null, id = uniqueId, defer = fn => setTimeout(fn, 0), latestService = null, sourceRetryMs = 350, interceptWaitMs = 1500, semanticWaitMs = 1200, serviceFreshMs = 60000, roundStore = globalThis.localStorage ?? null }) {
    // ST 保存聊天时会整份替换聊天文件。服务端核对原文若恰好跨在这次保存上，就会报「来源不可用」——
    // 这只是撞上了保存，并非原文真的变了。稍等片刻重读一次即可分辨；确实不可用（聊天已迁走、
    // 创建未完成、原件缺失）时第二次仍是同样结果，照常按不可用处理。
    async function readSource(binding) {
        const first = await api.read(binding);
        if (first?.sourceAvailable !== false || first.document?.movedTo || (first.document?.creation && first.document.creation.status !== 'complete')) return first;
        await new Promise(resolve => setTimeout(resolve, sourceRetryMs));
        return api.read(binding);
    }
    const state = { loading: false, error: '', errorPage: '', status: '', streamPreview: '', snapshot: null, document: null, defaults: null, busy: false, profiles: [], lastUsed: null, lastSkip: null, requestSize: null, retrieval: { mode: 'lexical', vector: { status: 'planned' }, rerank: { status: 'planned' }, candidates: [], lastRun: null }, failedWork: null, sourceAvailable: false, invalidSourceIds: [],
        service: { status: 'unknown', version: '', requiredVersion: SERVICE_VERSION } };
    let sequence = 0, serviceSequence = 0, disposed = false, generation = 0, generating = false, prepared = null, refreshing = null, skipSeq = 0, offered = false;
    const jobs = new Map(), localStops = new Set(), failedJobs = new Map(), failures = new Map();
    const cancelledRounds = new Map();
    let refreshTimer = null, generationRefresh = null;
    // Entry/enable rounds announce a catch-up start; settle polling covers ST
    // paths that start a round but never block input (slash-command aborts).
    let catchUp = true, settleTimer = null, settleIdle = 0, saveTimer = null, saveWaits = 0;
    const SETTLE_POLL_MS = 3000, SAVE_POLL_MS = 1500, SAVE_POLL_LIMIT = 8;
    const hostBusy = () => { try { return typeof host.busyGenerating === 'function' ? host.busyGenerating() : null; } catch { return null; } };
    // 手动发起的整理不能悄悄不动：做不了就说明原因。「正在生成」的标记若已过期（ST 实际并没有在生成），就地清掉再继续。
    const manualStartReady = key => {
        if (jobs.has(key)) throw new Error('已有一轮整理在进行，请等它结束或先停止');
        if (generating) {
            if (hostBusy() === true) throw new Error('正在生成回复，等回复结束后再总结');
            generating = false; clearTimeout(settleTimer); settleTimer = null; settleIdle = 0;
        }
        if (!state.sourceAvailable) throw new Error('当前聊天原件尚未通过核对，请保存聊天后重新打开忆幕');
        localStops.delete(key);
    };
    const settled = () => {
        clearTimeout(settleTimer); settleTimer = null; settleIdle = 0;
        generating = false; prepared = null; host.clear();
        countPendingRequest();
        if (state.snapshot?.binding) deferFor(state.snapshot.binding, () => refresh({ quiet: true, auto: true }));
    };
    const pollSettle = stamp => {
        clearTimeout(settleTimer);
        settleTimer = setTimeout(() => {
            if (disposed || !generating || stamp !== generation) return;
            const busy = hostBusy();
            if (busy === null) return; // No live signal: rely on ST events only.
            settleIdle = busy === false ? settleIdle + 1 : 0;
            if (settleIdle >= 2) settled(); else pollSettle(stamp);
        }, SETTLE_POLL_MS);
    };
    // ST saves the chat file after the reply ends. Retry quietly until the
    // file has caught up, instead of failing a round on a half-saved source.
    const waitForSave = () => {
        clearTimeout(saveTimer);
        if (disposed || saveWaits >= SAVE_POLL_LIMIT) { saveWaits = 0; return; }
        saveWaits++;
        saveTimer = setTimeout(() => { saveTimer = null; if (!disposed) void refresh({ quiet: true, auto: true }); }, SAVE_POLL_MS);
    };
    const snapshotState = () => ({ ...state,
        busy: state.busy || Boolean(state.snapshot && jobs.has(bindingKey(state.snapshot.binding))),
        failedWork: state.snapshot ? failures.get(bindingKey(state.snapshot.binding)) || null : null,
        activeEntryId: state.snapshot ? jobs.get(bindingKey(state.snapshot.binding))?.entryId || null : null,
        manualJob: state.snapshot && jobs.get(bindingKey(state.snapshot.binding))?.manual ? { ...jobs.get(bindingKey(state.snapshot.binding)).manual } : null,
        paused: state.snapshot && localStops.has(bindingKey(state.snapshot.binding)) });
    // 记忆调阅的「上一轮」记录按聊天存在本机（只存条目编号与数字，不存正文），重开 ST 后还能看到。
    // 新一轮生成开始时内存里的记录会先清空，但本机那份留到下一次有结果时才被替换。
    // 「被想起就回暖」的楼层表也放在同一份记录里，不再单开一个键。
    let roundSaved = null;
    const roundKey = binding => `yimu:last-round:${bindingKey(binding)}`;
    const readRound = binding => {
        try { return JSON.parse(roundStore?.getItem(roundKey(binding)) || 'null'); } catch { return null; }
    };
    const writeRound = (binding, record) => { try { roundStore?.setItem(roundKey(binding), JSON.stringify(record)); } catch { /* 存不下不影响使用 */ } };
    const rememberRound = () => {
        const used = state.lastUsed, skip = state.lastSkip, binding = state.snapshot?.binding;
        if (!binding || !used && !skip || used?.restoredAt || skip?.restoredAt || roundSaved === (used || skip)) return;
        roundSaved = used || skip;
        const record = { at: Date.now(), recall: readRound(binding)?.recall || {},
            used: used ? { memoryIds: (used.entries || []).map(entry => entry.id), tokens: used.tokens, estimated: true, status: used.status, semantic: used.semantic === true,
            sourceReplacement: used.sourceReplacement, removedFloors: used.removedFloors, recentFloors: used.recentFloors, requestTokens: used.requestTokens, contextTokens: used.contextTokens, responseTokens: used.responseTokens } : null,
            skip: used ? null : { stage: skip.stage, reason: skip.reason, offered: skip.offered === true, ...(skip.message ? { message: skip.message } : {}) } };
        writeRound(binding, record);
    };
    // 「被想起就回暖」：记下每条记忆最近一次被带进请求的楼层。与上一轮记录同一份本机数据，不回传账户。
    const recallAtMap = binding => {
        const saved = readRound(binding)?.recall;
        return saved && typeof saved === 'object' ? new Map(Object.entries(saved)) : null;
    };
    const rememberRecall = (binding, entries) => {
        const current = recallAtMap(binding) || new Map(), floor = state.snapshot?.messages?.length || 0;
        for (const entry of entries || []) if (entry?.id) current.set(entry.id, floor);
        // 上限：只留最近 300 条，防止长期聊天的本机记录无限增长。
        const recall = Object.fromEntries([...current].slice(-300));
        const record = readRound(binding) || { at: Date.now() };
        writeRound(binding, { ...record, recall });
    };
    const restoreRound = binding => {
        if (state.lastUsed || state.lastSkip || generating) return;
        const record = readRound(binding);
        if (!record || !Number.isFinite(record.at)) return;
        // 只取回上一次真正注入的记忆（条目与 token，记忆调阅里要看）；「本轮未改写请求」这类
        // 上一轮的提示不再挂到面板上，重新打开时从空白开始。
        if (record.used && Array.isArray(record.used.memoryIds)) state.lastUsed = { ...record.used, restoredAt: record.at };
    };
    const emit = () => { if (!disposed) { rememberRound(); onChange(snapshotState()); } };
    const isCurrent = binding => equalBinding(state.snapshot?.binding, binding);
    // A streamed summary reports every chunk. Each report used to repaint the whole panel (every memory card
    // included); the preview text is kept current on every chunk, and the panel is told at most ~8 times a second.
    let streamTimer = null;
    const streamChunk = binding => (_chunk, accumulated) => {
        if (disposed || !isCurrent(binding) || typeof accumulated !== 'string') return;
        state.streamPreview = accumulated.slice(-12000);
        if (streamTimer === null) streamTimer = setTimeout(() => { streamTimer = null; emit(); }, 120);
    };
    const notice = (message, tone = 'success') => {
        if (disposed || typeof onNotice !== 'function' || typeof message !== 'string' || !message) return;
        try { onNotice(message, tone); } catch { /* Notifications must never affect persistence. */ }
    };
    async function generateWithRetries(prompt, options, { binding, label, start, end, retryState } = {}) {
        let lastError;
        for (let retry = 0; retry <= 3; retry++) {
            if (options.signal?.aborted || disposed) throw lastError || new Error('本次整理已中止');
            try { return await host.generate(prompt, options); }
            catch (error) {
                lastError = error;
                if (options.signal?.aborted || disposed || localStops.has(bindingKey(binding))) throw error;
                if (retry === 0) notice(`本次${label}失败，发起重试：${error?.message || '未知错误'}`, 'warning');
                if (isCurrent(binding)) {
                    state.status = `正在重试${label}（${retry + 1}/3）· 楼层${shownFloor(start)}–${shownFloor(end)}`;
                    emit();
                }
            }
        }
        if (retryState) retryState.exhausted = true;
        throw lastError || new Error('未知错误');
    }
    const deferFor = (binding, task, stamp = generation) => {
        const target = clone(binding);
        defer(async () => {
            if (disposed || generation !== stamp || !isCurrent(target)) return;
            const snapshot = await host.snapshot().catch(() => null);
            if (disposed || generation !== stamp || !isCurrent(target) || !equalBinding(snapshot?.binding, target)) return;
            return task();
        });
    };
    const lifecycle = () => ({disposed, generation, generating, paused: state.snapshot && localStops.has(bindingKey(state.snapshot.binding))});
    const storyActions = createStoryActions({state, host, api, emit, id, lifecycle, refresh});
    const companionActions = createCompanionActions({state, api, change, emit, id, lifecycle});
    const backupActions = createBackupActions({state, host, api, emit, id, lifecycle, refresh});
    const adopt = (binding, result) => {
        if (!disposed && isCurrent(binding)) {
            if (result.document && (!state.document || result.document.revision >= state.document.revision)) state.document = result.document;
            if (result.defaults && (!state.defaults || result.defaults.revision >= state.defaults.revision)) state.defaults = result.defaults;
            if (typeof result.sourceAvailable === 'boolean') state.sourceAvailable = result.sourceAvailable;
            if (Array.isArray(result.invalidSourceIds)) state.invalidSourceIds = result.invalidSourceIds;
            emit();
        }
    };

    function summaryRun(settings, snapshot) {
        const connection = typeof host.summaryConnection === 'function' ? host.summaryConnection(settings) : null;
        const context = connection ? connection.contextTokens : settings.profileId ? 0 : snapshot.maxContext || 8192;
        const output = connection?.maxTokens || snapshot.maxResponse || 2048;
        if (connection?.mode === 'profile' && !context) throw new Error('旧版 ST 连接无法确认上下文容量，请在 API设置中重新选择连接方式');
        if (!Number.isSafeInteger(context) || context <= output + 512) {
            throw new Error('此连接的上下文不足，请检查连接设置');
        }
        // The trigger is a preferred batch size, not a second connection limit.
        // Reserve output and framing here; the host checks the complete prompt again.
        settings.inputCapacity = context - output - 512;
        settings.batch = Math.min(settings.trigger, settings.inputCapacity);
        // 规划与实际发送必须同一口径：发送时固定带身份锚定，所以规划也要算上它。
        const fitsPrompt = prompt => summaryRequestBudget(prompt, SUMMARY_SYSTEM) + output <= context;
        settings.fitsSummaryBatch = (messages, batch) => fitsPrompt(summaryPrompt(messages, batch, settings));
        settings.fitsStage = parents => fitsPrompt(stagePrompt(parents, settings));
        return { settings, connection, fitsPrompt, options: { profileId: settings.profileId, model: settings.model, ...(connection ? { connection } : {}) } };
    }

    // 原生隐藏的落点。忆幕只改自己决定要改的楼层，并且每次都从当前聊天重新核对，
    // 绝不凭一份旧记录去改别的楼层：用户手动隐藏的那几层永远是用户自己的事。
    // 关闭忆幕、停用或原文不再成立时，把忆幕隐藏过、但现在不该隐藏的楼层还原。
    // 隐藏失败不能再被悄悄吞掉：曾因漏了一个导入，隐藏整条链路从未生效却毫无痕迹。
    const reportHideFailure = error => { try { console.warn('[忆幕] 隐藏旧楼未完成：', error); } catch { /* 无控制台 */ } };
    async function syncHidden(document, settings, { restoreAll = false } = {}) {
        if (typeof host.applyHidden !== 'function' || !state.snapshot?.binding) return null;
        const messages = state.snapshot.messages || [];
        const want = restoreAll || !document?.enabled ? []
            : hiddenFloorsFor(document, messages, { recent: settings?.recent ?? DEFAULTS.recent }).floors;
        // 「哪些楼是忆幕藏的」记在消息自身（extra.yimu_hidden），host 据此只还原忆幕自己藏过的楼层。
        return host.applyHidden(want, state.snapshot.binding);
    }

    function positionAfter(entry, document, snapshot) {
        if (!entry) return snapshot.messages.length;
        if (entry.origin) return Math.min(snapshot.messages.length, document.lineage?.bridgeCount || document.lineage?.bridgeHashes?.length || snapshot.messages.length);
        if (entry.placement) return entry.placement.fromFloor;
        const ranges = entry.source?.ranges || (entry.source ? [entry.source] : []);
        if (ranges.length) return Math.max(...ranges.map(range => range.end));
        if (entry.kind === 'stage') return Math.max(1, ...entry.source.parents.map(ref => positionAfter(document.entries.find(item => item.id === ref.id), document, snapshot)));
        return snapshot.messages.length;
    }

    function insertionAfter(entry, document) {
        if (entry?.kind !== 'stage') return entry?.id;
        const parents = new Set(entry.source.parents.map(ref => ref.id));
        const ids = new Set([entry.id, ...parents, ...document.entries.filter(item => item.kind === 'excerpt' && parents.has(item.parent?.id)).map(item => item.id)]);
        return (document.entryOrder || document.entries.map(item => item.id)).filter(id => ids.has(id)).at(-1) || entry.id;
    }

    async function change(binding, operation) {
        try { const result = await api.change(binding, operation); adopt(binding, result); return result; }
        catch (error) {
            // One read can confirm an acknowledged-lost write; never blindly repeat a mutation.
            try {
                const fresh = await readSource(binding); adopt(binding, fresh);
                if (fresh.document.operations.includes(operation.id)) return { ...fresh, outcome: 'confirmed' };
            } catch { /* The original error remains the factual result. */ }
            throw error;
        }
    }

    // 后台静默刷新（一轮生成至少三次）不必每次都先探一遍服务：刚确认过正常就直接读数据，读失败自会报出来。
    let serviceOkAt = 0;
    const serviceFresh = () => state.service?.status === 'ok' && Date.now() - serviceOkAt < serviceFreshMs;
    async function checkService() {
        const ticket = ++serviceSequence;
        state.service = { status: 'checking', version: '', requiredVersion: SERVICE_VERSION }; emit();
        try {
            const value = await api.health();
            if (!disposed && ticket === serviceSequence) {
                const version = typeof value?.version === 'string' ? value.version : '';
                state.service = { status: 'ok', version, requiredVersion: SERVICE_VERSION }; serviceOkAt = Date.now(); emit();
                // A published service newer than the running one is a soft notice, never a block.
                if (typeof latestService === 'function') Promise.resolve().then(() => latestService()).then(latest => {
                    if (disposed || ticket !== serviceSequence || state.service.status !== 'ok' || !isNewerYimuVersion(version, latest)) return;
                    state.service = { ...state.service, latest }; emit();
                }).catch(() => {});
            }
        } catch (error) {
            if (!disposed && ticket === serviceSequence) {
                state.service = { status: error?.code === 'yimu_version' ? 'mismatch' : 'error', version: typeof error?.currentVersion === 'string' ? error.currentVersion : '', requiredVersion: SERVICE_VERSION }; emit();
            }
            throw error;
        }
    }

    async function refresh({ quiet = false, auto = false, probe = true } = {}) {
        companionActions.connect();
        const ticket = ++sequence, refreshGeneration = generation;
        if (!quiet) { state.loading = true; state.error = ''; emit(); }
        const task = (async () => {
            let identityFailed = false;
            try {
                // Manual opening/refresh can verify installation on ST's homepage
                // without requiring a real chat. Quiet homepage work stays unchanged.
                let serviceError = null;
                if (!quiet) try { await checkService(); } catch (error) { serviceError = error; }
                if (ticket !== sequence || disposed) return;
                let snapshot;
                try { snapshot = await host.snapshot(); }
                catch (error) {
                    identityFailed = true;
                    if (!serviceError && (!quiet || state.service.status === 'ok') && typeof api.defaults === 'function') {
                        const data = await api.defaults();
                        if (ticket !== sequence || disposed) return;
                        host.clear(); prepared = null;
                        state.snapshot = null; state.document = null; state.lastUsed = null; state.lastSkip = null; state.requestSize = null; state.retrieval = { mode: 'lexical', vector: { status: 'planned' }, rerank: { status: 'planned' }, candidates: [], lastRun: null }; state.sourceAvailable = false; state.invalidSourceIds = [];
                        state.story = {}; state.companion = {};
                        state.defaults = data.defaults; state.profiles = host.profiles(); state.busy = false; state.streamPreview = ''; state.status = '';
                        state.error = error.message === '请先打开一个角色的聊天' ? '' : error.message;
                        state.errorPage = 'overview'; state.loading = false; emit(); return;
                    }
                    throw serviceError || error;
                }
                if (ticket !== sequence || disposed) return;
                const switched = !equalBinding(snapshot.binding, state.snapshot?.binding);
                if (switched) {
                    host.clear(); prepared = null;
                    state.document = null; state.defaults = null; state.lastUsed = null; state.lastSkip = null; state.requestSize = null; state.retrieval = { mode: 'lexical', vector: { status: 'planned' }, rerank: { status: 'planned' }, candidates: [], lastRun: null }; state.streamPreview = ''; state.status = ''; state.error = ''; state.sourceAvailable = false; state.busy = false; state.invalidSourceIds = [];
                    state.story = storyActions.forBinding(snapshot.binding); state.companion = {};
                }
                state.snapshot = snapshot; state.profiles = host.profiles(); emit();
                if (serviceError) throw serviceError;
                // 生成前的那次刷新不先探服务：探测是一次额外的网络往返，而紧接着的读取本身失败就会如实报出来。
                // 用户两次发言通常间隔超过一分钟，按「刚确认过就跳过」的规则几乎每轮都会多等这一趟。
                if (quiet && probe && !serviceFresh()) await checkService();
                const data = await readSource(snapshot.binding);
                if (ticket !== sequence || disposed) return;
                const live = await host.snapshot();
                if (!equalBinding(live.binding, snapshot.binding)) return;
                state.snapshot = live;
                adopt(snapshot.binding, data);
                const inspection = await inspectSources(state.document, live.messages);
                for (const entry of state.document.entries) {
                    if (state.invalidSourceIds.includes(entry.id) && entry.status === 'active' && !inspection.invalid.some(i => i.id === entry.id)) inspection.invalid.push({ id: entry.id, revision: entry.revision });
                }
                if (ticket !== sequence || disposed) return;
                if (inspection.invalid.length) {
                    // Invalidations are persisted independently; an error still excludes them at injection time.
                    try { await change(snapshot.binding, { id: id(), type: 'invalidate', entries: inspection.invalid }); }
                    catch (error) { state.error = error.message; }
                }
                if (!data.sourceAvailable) { host.clear(); offered = false; state.error = '当前聊天原件尚未通过核对；请保存聊天后重新打开忆幕。'; }
                state.loading = false; restoreRound(snapshot.binding); emit();
                // 隐藏随原文一起核对：删层、改层、停用之后边界可能变了，这里只做核对与还原。
                // 生成进行中绝不改聊天——ST 已经装配好本轮消息，这时改会让两边对不上、本轮丢掉记忆。
                if (!generating) void syncHidden(state.document, effectiveSettings(state.document, state.defaults)).catch(reportHideFailure);
                if (auto && !disposed) deferFor(snapshot.binding, () => start().catch(() => {}), refreshGeneration);
            } catch (error) {
                if (ticket !== sequence || disposed) return;
                if (identityFailed) {
                    state.snapshot = null; state.document = null; state.defaults = null; state.lastUsed = null; state.lastSkip = null; state.requestSize = null; state.retrieval = { mode: 'lexical', vector: { status: 'planned' }, rerank: { status: 'planned' }, candidates: [], lastRun: null };
                    state.busy = false; state.streamPreview = ''; state.status = ''; state.invalidSourceIds = [];
                }
                host.clear(); prepared = null; state.sourceAvailable = false; state.error = error.message; state.errorPage = 'overview'; state.loading = false; emit();
            }
        })();
        refreshing = task;
        try { await task; } finally { if (refreshing === task) refreshing = null; }
    }

    async function start({ force = false, entryId = null, range: requestedRange = null, expectedRange = null, batchFloors, historyOnly = false, errorPage = entryId ? 'memory' : requestedRange || historyOnly ? 'overview' : 'memory' } = {}) {
        if (disposed || generating || !state.document?.enabled || !state.sourceAvailable || !state.snapshot || !force && !state.document.autoSummary) {
            if (force && !disposed && state.snapshot) { state.error = generating ? '正在生成回复，等回复结束后再总结' : !state.sourceAvailable ? '当前聊天原件尚未通过核对，请保存聊天后重新打开忆幕' : '此聊天尚未启用忆幕'; state.errorPage = errorPage; emit(); }
            return;
        }
        // Automatic rounds never overlap a reply that is still streaming.
        if (!force && hostBusy() === true) { waitForSave(); return; }
        const binding = clone(state.snapshot.binding), key = bindingKey(binding);
        if (jobs.has(key) || localStops.has(key)) {
            if (force) { state.error = jobs.has(key) ? '已有一轮整理在进行，请等它结束或先停止' : '此聊天的忆幕已停用，请重新启用后再总结'; state.errorPage = errorPage; emit(); }
            return;
        }
        const doc = clone(state.document), runGeneration = generation;
        const cancelled = cancelledRounds.get(key);
        if (!force && cancelled?.epoch === doc.epoch && cancelled.total === state.snapshot.messages.length) return;
        cancelledRounds.delete(key);
        const failedKey = `${key}:${doc.epoch}`;
        // A failed automatic round waits for new floors, then retries once per floor count.
        if (!force && failedJobs.get(failedKey) === state.snapshot.messages.length) return;
        failedJobs.delete(failedKey);
        const announce = catchUp && !force; catchUp = false;
        if (!force) { clearTimeout(saveTimer); saveTimer = null; }
        const controller = new AbortController(); controller.entryId = entryId; jobs.set(key, controller);
        state.streamPreview = '';
        emit();
        let jobDocument = doc, snapshot = clone(state.snapshot);
        const defaults = clone(state.defaults);
        const settings = effectiveSettings(doc, defaults);
        const vectorConfig = typeof host.connectionApi?.vectorRead === 'function' ? host.connectionApi.vectorRead() : null;
        const rerankConfig = typeof host.connectionApi?.rerankRead === 'function' ? host.connectionApi.rerankRead() : null;
        const vectorStatus = settings.vectorEnabled === true
            ? vectorConfig?.apiUrl && vectorConfig?.model ? 'planned' : 'unavailable'
            : 'disabled';
        const rerankStatus = settings.rerankEnabled === true
            ? rerankConfig?.apiUrl && rerankConfig?.model ? 'planned' : 'unavailable'
            : 'disabled';
        state.retrieval = { mode: 'lexical', sourceRecall: settings.recall !== false, vector: { status: vectorStatus,
            ...(vectorStatus === 'unavailable' ? { reason: '尚未配置向量候选接口，已回退关键词召回' } : {}) }, rerank: { status: rerankStatus,
            ...(rerankStatus === 'unavailable' ? { reason: '尚未配置重排候选接口，已保留当前顺序' } : {}) }, candidates: [], lastRun: null };
        emit();
        let processed = false, recallAttempted = false, noWork = false, failedBatch = null, failedSource = null, targetEnd = null, awaitingSave = false, announced = false;
        const retryState = { exhausted: false };
        let manualPlan = null;
        try {
            const run = summaryRun(settings, snapshot);
            manualPlan = requestedRange ? planManualRange(doc, snapshot.messages, settings, requestedRange, { batchFloors }) : null;
            if (manualPlan && (expectedRange?.start !== manualPlan.range.start || expectedRange?.end !== manualPlan.range.end)) {
                throw new Error('已有切片范围已变化，请确认当前整理范围后重试');
            }
            // Manual progress is visible to the view; pausing stops after the current batch.
            if (manualPlan) { controller.manual = { done: 0, total: manualPlan.batches.length, pausing: false }; emit(); }
            const plannedHashes = manualPlan ? await fingerprintMessages(snapshot.messages) : null;
            let manualIndex = 0;
            for (;;) {
                if (controller.signal.aborted || disposed || localStops.has(key)) break;
                const live = await host.snapshot().catch(() => null);
                if (live && equalBinding(live.binding, binding)) snapshot = live;
                const fresh = await readSource(binding);
                jobDocument = fresh.document; adopt(binding, fresh);
                if (!fresh.sourceAvailable || !jobDocument.enabled || jobDocument.epoch !== doc.epoch || fresh.defaults.revision !== defaults.revision) break;
                if (!force && !processed && Number.isSafeInteger(fresh.sourceFloorCount) && fresh.sourceFloorCount < snapshot.messages.length) { awaitingSave = true; break; }
                let batch;
                if (manualPlan) {
                    batch = manualPlan.batches[manualIndex];
                    if (!batch) break;
                    if (batch.redo) {
                        const current = jobDocument.entries.find(entry => entry.id === batch.redo.id);
                        if (!current || current.revision !== batch.redo.revision) throw new Error('待整理的切片已变化，请刷新后重试');
                    } else {
                        // 只核「要换的旧切片是否还在、还能换」，不核修订号：批次之间会自然产生修订
                        // （前几批的替换、来源核对留下的失效标记），拿旧修订号卡会让正常总结反复中断。
                        for (const ref of batch.replaces || []) {
                            const current = jobDocument.entries.find(entry => entry.id === ref.id);
                            if (!current || current.kind !== 'summary' || current.edited || current.status === 'deleted') {
                                throw new Error('此范围内的记忆已变化，请刷新后重试');
                            }
                        }
                        // 段内若是人工改过或丢弃的来源，仍按原规则处理；自动切片由本批一并替换。
                        const replacedIds = new Set((batch.replaces || []).map(ref => ref.id));
                        const overlaps = jobDocument.entries.filter(entry => entry.kind === 'summary' && !entry.origin && !entry.replacedBy
                            && entry.source.start <= batch.end && entry.source.end >= batch.start);
                        if (overlaps.some(entry => !replacedIds.has(entry.id) && !entry.edited
                            && (!entry.discarded || !batch.discardedSources?.some(ref => ref.id === entry.id
                                && JSON.stringify(ref.source) === JSON.stringify(entry.source))))
                            || (batch.discardedSources || []).some(ref => !overlaps.some(entry => entry.id === ref.id))) {
                            throw new Error('此范围的记忆已变化，请刷新后确认整理范围');
                        }
                    }
                } else if (entryId) {
                    const entry = jobDocument.entries.find(e => e.id === entryId);
                    if (!entry?.source || entry.status === 'deleted') throw new Error('此条记忆没有可重新总结的来源');
                    if (entry.origin) throw new Error('这是独立继承的记忆，可在此手动修订；自动重总结不会跨故事改写');
                    batch = { start: entry.source.start, end: entry.source.end, redo: clone(entry) };
                    if (batch.end > snapshot.messages.length) throw new Error('对应原文楼层已不存在，请先处理来源变化');
                } else batch = nextBatch(jobDocument, snapshot.messages, settings, { force: force || targetEnd !== null, historyOnly, limitEnd: targetEnd ?? Infinity });
                if (!batch) { noWork = true; break; }
                if (targetEnd === null && batch.targetEnd !== undefined) targetEnd = batch.targetEnd;
                controller.entryId = batch.redo?.id || entryId;
                if (snapshot.messages.slice(batch.start - 1, batch.end).reduce((total, item) => total + estimateTokens(item.mes || ''), 0) > settings.inputCapacity) throw new Error('完整切片超过此连接的可用输入容量，请选择容量足够的连接');
                const hashes = await fingerprintMessages(snapshot.messages);
                const frozenSource = { start: batch.start, end: batch.end, hashes: hashes.slice(batch.start - 1, batch.end) };
                failedBatch = clone(batch); failedSource = clone(frozenSource);
                if (manualPlan && !sourceMatches({ start: manualPlan.range.start, end: manualPlan.range.end,
                    hashes: plannedHashes.slice(manualPlan.range.start - 1, manualPlan.range.end) }, hashes)) throw new Error('整理期间所选原文已变化，请确认后重试');
                const candidateDocument = clone(jobDocument);
                for (const entry of candidateDocument.entries) if (fresh.invalidSourceIds?.includes(entry.id)) entry.status = 'invalid';
                let candidates = !manualPlan && !historyOnly && !entryId && !recallAttempted ? recallCandidates(candidateDocument, settings, snapshot.messages, batch, hashes) : [];
                const retrieval = buildRetrievalCandidates({
                    localCandidates: candidates,
                    context: retrievalContext(candidateDocument, { beforeFloor: batch.start, invalidIds: fresh.invalidSourceIds }),
                });
                candidates = retrieval.candidates.filter(candidate => candidate.kind === 'local');
                let vector = { status: 'disabled', candidates: [], reason: '当前聊天未启用向量候选' };
                if (settings.vectorEnabled === true) {
                    const vectorConfig = typeof host.connectionApi?.vectorRead === 'function' ? host.connectionApi.vectorRead() : null;
                    if (!vectorConfig?.apiUrl || !vectorConfig?.model || typeof host.vectorCandidates !== 'function') {
                        vector = { status: 'unavailable', candidates: [], reason: '尚未配置向量候选接口，已回退关键词召回' };
                    } else {
                        const pool = buildRetrievalCandidates({
                            localCandidates: candidateDocument.entries.filter(entry => entry.kind === 'summary' && entry.status === 'active' && !entry.origin && entry.source).map(entry => ({
                                id: entry.id, revision: entry.revision, start: entry.source.start, end: entry.source.end, title: entry.title || '记忆切片', text: entry.text,
                            })),
                            context: retrievalContext(candidateDocument, { beforeFloor: batch.start, invalidIds: fresh.invalidSourceIds }),
                        }).candidates.filter(candidate => candidate.kind === 'local');
                        const queryText = snapshot.messages.slice(batch.start - 1, batch.end).map(message => message?.mes || message?.message || '').join('\n');
                        vector = await discoverVectorCandidates({ provider: request => host.vectorCandidates(request), query: queryText, candidates: pool, context: retrievalContext(candidateDocument, { beforeFloor: batch.start, invalidIds: fresh.invalidSourceIds }), limit: 6, signal: controller.signal });
                        if (vector.status === 'ready' && vector.candidates.length) {
                            const seen = new Set(candidates.map(candidate => candidate.id));
                            for (const candidate of vector.candidates) {
                                if (seen.has(candidate.id) || candidates.length >= 6) continue;
                                seen.add(candidate.id); candidates.push({ ...candidate, reason: '向量相似候选 · 仅作候选，未写入记忆' });
                            }
                        }
                    }
                }
                let rerank = { status: 'disabled', candidates: [], reason: '当前聊天未启用重排候选' };
                if (settings.rerankEnabled === true) {
                    const rerankConfig = typeof host.connectionApi?.rerankRead === 'function' ? host.connectionApi.rerankRead() : null;
                    if (!rerankConfig?.apiUrl || !rerankConfig?.model || typeof host.rerankCandidates !== 'function') {
                        rerank = { status: 'unavailable', candidates: [], reason: '尚未配置重排候选接口，已保留当前顺序' };
                    } else {
                        const queryText = snapshot.messages.slice(batch.start - 1, batch.end).map(message => message?.mes || message?.message || '').join('\n');
                        rerank = await discoverRerankCandidates({
                            provider: request => host.rerankCandidates(request), query: queryText, candidates,
                            context: retrievalContext(candidateDocument, { beforeFloor: batch.start, invalidIds: fresh.invalidSourceIds }),
                            limit: Math.min(candidates.length || 1, rerankConfig.topN || 6), signal: controller.signal,
                        });
                        if (rerank.status === 'ready' && rerank.candidates.length) {
                            const byId = new Map(candidates.map(candidate => [candidate.id, candidate]));
                            const ordered = rerank.candidates.map(candidate => byId.get(candidate.id)).filter(Boolean);
                            const used = new Set(ordered.map(candidate => candidate.id));
                            candidates = [...ordered, ...candidates.filter(candidate => !used.has(candidate.id))];
                        }
                    }
                }
                if (isCurrent(binding)) {
                    state.retrieval = { mode: 'lexical', sourceRecall: settings.recall !== false, vector: { status: vector.status, reason: vector.reason }, rerank: { status: rerank.status, reason: rerank.reason },
                        candidates: candidates.map(candidate => ({ id: candidate.id, start: candidate.start, end: candidate.end, title: candidate.title || '记忆切片', kind: candidate.kind || 'local', sourceLabel: candidate.sourceLabel || '忆幕', reason: candidate.reason })),
                        lastRun: { count: candidates.length, localCount: candidates.length, externalCount: 0, at: retrieval.at } };
                    emit();
                }
                const progress = manualPlan ? `第 ${manualIndex + 1}／${manualPlan.batches.length} 批，` : '';
                if (isCurrent(binding)) { state.status = `正在整理${progress}第 ${shownFloor(batch.start)}—${shownFloor(batch.end)} 层`; emit(); }
                if (announce && !announced) { announced = true; notice(`忆幕：已达自动总结触发值，开始整理楼层${shownFloor(batch.start)}–${shownFloor(batch.end)}`, 'info'); }
                else notice(`忆幕切片总结中：${progress}楼层${shownFloor(batch.start)}–${shownFloor(batch.end)}`, 'info');
                let previousContext = jobDocument.entries.filter(entry => entry.status === 'active' && entry.kind === 'summary'
                    && !entry.origin && entry.source.end < batch.start && sourceMatches(entry.source, hashes) && entry.scenes?.length)
                    .sort((a, b) => b.source.end - a.source.end).slice(0, 1).map(entry => ({ id: entry.id, revision: entry.revision, scenes: entry.scenes }));
                if (controller.signal.aborted) break;
                // Keyword/vector candidates are always discovered for the check chain; only
                // source recall turns them into a requestable catalog in the summary prompt.
                let catalog = settings.recall === false ? [] : candidates;
                let prompt = summaryPrompt(snapshot.messages, batch, settings, { recallCandidates: catalog, previousContext });
                // Optional historical hints may use only spare room. Source floors are never truncated.
                if (!run.fitsPrompt(prompt) && catalog.length) {
                    candidates = []; catalog = [];
                    if (isCurrent(binding)) {
                        state.retrieval = { ...state.retrieval, candidates: [], lastRun: { ...(state.retrieval.lastRun || {}), count: 0, at: Date.now(), fallback: '预算不足，沿用关键词路径但本轮未带入候选' } };
                        emit();
                    }
                    prompt = summaryPrompt(snapshot.messages, batch, settings, { previousContext });
                }
                if (!run.fitsPrompt(prompt) && previousContext.length) { previousContext = []; prompt = summaryPrompt(snapshot.messages, batch, settings); }
                if (!run.fitsPrompt(prompt)) throw new Error('完整切片与总结提示词超过此连接的可用输入容量，请选择容量足够的连接');
                const response = await generateWithRetries(prompt, { ...run.options, signal: controller.signal, onChunk: streamChunk(binding) },
                    { binding, label: '切片总结', start: batch.start, end: batch.end, retryState });
                if (isCurrent(binding)) { state.streamPreview = ''; emit(); }
                if (controller.signal.aborted || disposed || localStops.has(key)) break;
                const beforeSave = await readSource(binding); adopt(binding, beforeSave);
                if (beforeSave.defaults.revision !== defaults.revision || !beforeSave.document.enabled || beforeSave.document.epoch !== doc.epoch) throw new Error('整理期间设置已变化，本次结果未采用');
                const after = await host.snapshot().catch(() => null);
                if (after && equalBinding(after.binding, binding)) {
                    const latestHashes = await fingerprintMessages(after.messages);
                    if (!sourceMatches(frozenSource, latestHashes)) throw new Error('整理期间原文已变化，本次结果未采用');
                }
                // 整段重做本来就要把结果重新组合成一条，不再做碎片合并。
                let slices = parseSummary(response, batch, hashes, settings, { coalesce: !batch.redo });
                // Redo replaces exactly one existing slice, never creates overlapping entries.
                if (batch.redo) {
                    const text = slices.map(s => s.text).join('\n\n');
                    const title = slices.length === 1 ? slices[0].title : batch.redo.title || memoryTitle({ kind: 'summary', text });
                    slices = [{ kind: 'summary', title, text, scenes: slices.flatMap(s => s.scenes || []), source: frozenSource }];
                }
                slices.forEach(slice => validateGeneratedLength(slice, settings));
                for (const slice of slices) {
                    if (controller.signal.aborted || disposed || localStops.has(key)) break;
                    const operation = { id: id(), type: batch.redo ? 'redo' : 'append', expectedEpoch: doc.epoch, expectedDefaultsRevision: defaults.revision,
                        entry: { ...slice, id: batch.redo?.id || id() } };
                    if (batch.redo) { operation.entryId = batch.redo.id; operation.expectedRevision = batch.redo.revision; }
                    // 本批覆盖的旧切片随这一批一起换掉（都带修订号），不逐条重做。
                    else if (manualPlan && batch.replaces?.length && slice === slices[0]) { operation.replaces = clone(batch.replaces); operation.replaceRange = { start: batch.start, end: batch.end }; }
                    else if (manualPlan && batch.discardedSources) {
                        const discardedSources = batch.discardedSources.filter(ref => doc.entries.some(entry => entry.id === ref.id
                            && entry.source.start <= slice.source.end && entry.source.end >= slice.source.start));
                        if (discardedSources.length) operation.discardedSources = clone(discardedSources);
                    }
                    const result = await change(binding, operation); jobDocument = result.document; processed = true;
                    if (!batch.redo) failedBatch.start = slice.source.end + 1;
                    if (result.outcome === 'conflict') {
                        if (isCurrent(binding)) state.status = '此条记忆存在另一版修订，两版均已保留，请在条目内选择。';
                        return;
                    }
                }
                const request = parseRecallRequest(response, catalog);
                if (request && !recallAttempted) {
                    recallAttempted = true; // At most one bounded extraction in this entire background run.
                    await completeRecall({ binding, key, controller, doc, defaults, settings, snapshot, request, triggerSource: frozenSource, slices, recallGeneration: runGeneration, connection: run.connection });
                }
                failedBatch = null; failedSource = null;
                notice(`本次总结已存至记忆，总结范围：${shownFloor(batch.start)}–${shownFloor(batch.end)}`, 'success');
                failures.delete(key);
                if (manualPlan) { manualIndex++; controller.manual.done = manualIndex; emit(); }
                if (entryId || !isCurrent(binding) || generating || controller.manual?.pausing) break;
            }
            // Saved batches stay saved. A paused or interrupted manual run reports what
            // is left; the manual range default already follows the next unsummarized floor.
            const remaining = manualPlan && processed && !controller.signal.aborted ? manualPlan.batches[manualIndex] : null;
            if (remaining && isCurrent(binding)) {
                failures.delete(key); saveWaits = 0;
                state.status = `已暂停：完成 ${manualIndex}／${manualPlan.batches.length} 批；剩余第 ${shownFloor(remaining.start)}—${shownFloor(manualPlan.range.end)} 层，请确认范围后点“开始总结”继续`;
                emit();
            } else if (processed && isCurrent(binding) && !controller.signal.aborted) { failures.delete(key); saveWaits = 0; state.status = '本轮整理已完成'; emit(); }
            else if (awaitingSave) { if (announce && !announced) catchUp = true; waitForSave(); }
            else if (force && noWork && isCurrent(binding) && !controller.signal.aborted) {
                const preview = historyOnly && doc.initialRange ? initialRangePreview(jobDocument, snapshot.messages, doc.initialRange, settings) : null;
                state.status = preview?.valid && preview.recent.length === doc.initialRange.end - doc.initialRange.start + 1
                    ? '所选楼层保留为近期原文，暂不整理' : '所选范围暂无待整理楼层';
                emit();
            }
        } catch (error) {
            if (!controller.signal.aborted && !disposed) {
                failedJobs.set(failedKey, isCurrent(binding) ? state.snapshot.messages.length : snapshot.messages.length);
                if (failedBatch && failedBatch.start <= failedBatch.end) failures.set(key, { kind: 'summary', entryId: failedBatch.redo?.id || entryId,
                    range: { start: failedBatch.start, end: failedBatch.end }, ...(manualPlan ? { batchFloors } : {}), source: failedSource, epoch: doc.epoch, defaultsRevision: defaults.revision, error: error.message });
                if (isCurrent(binding)) { state.error = error.message; state.errorPage = errorPage; state.status = '本轮整理未完成；原文与已保存记忆保留。'; emit(); }
                if (retryState.exhausted) notice(`本次总结重试3次均失败：${error?.message || '未知错误'}`, 'error');
                else if (!controller.signal.aborted) notice(`本次总结失败：${error?.message || '未知错误'}`, 'error');
            }
        } finally {
            if (jobs.get(key) === controller) jobs.delete(key);
            if (isCurrent(binding)) state.streamPreview = '';
            // 隐藏在整轮结束后做一次：每次隐藏都要把整份聊天交给 ST 保存，多批总结若每批保存一次，
            // 慢网络下会连着上传好几份聊天，还会让用户下一次发言排在这些保存后面。生成中不动聊天。
            if (processed && !disposed && !generating && isCurrent(binding)) await syncHidden(state.document, effectiveSettings(state.document, state.defaults)).catch(reportHideFailure);
            if (!disposed && !controller.signal.aborted && !failedJobs.has(failedKey) && isCurrent(binding)) deferFor(binding, () => startStage().catch(() => {}), runGeneration);
            emit();
        }
    }

    async function completeRecall({ binding, key, controller, doc, defaults, settings, snapshot, request, triggerSource, slices, recallGeneration, connection }) {
        const active = () => !disposed && !controller.signal.aborted && generation === recallGeneration && !generating && !localStops.has(key) && isCurrent(binding)
            && state.document?.enabled && state.document.epoch === doc.epoch && state.defaults?.revision === defaults.revision
            && effectiveSettings(state.document, state.defaults).recall !== false;
        if (!active() || typeof api.recallSource !== 'function') return;
        try {
            const fresh = await readSource(binding); adopt(binding, fresh);
            const parent = fresh.document.entries.find(entry => entry.id === request.parentId);
            if (!active() || !fresh.sourceAvailable || recallBlockReason(fresh.document, parent)) return;
            const source = await api.recallSource(binding, { parentId: request.parentId, parentRevision: request.parentRevision,
                expectedEpoch: doc.epoch, expectedDefaultsRevision: defaults.revision, triggerSource });
            if (!active()) return;
            const prompt = recallPrompt(source, request, fresh.document, slices, settings);
            const recallSnapshot = connection && connection.mode !== 'profile' ? { ...snapshot, maxContext: connection.contextTokens, maxResponse: connection.maxTokens } : snapshot;
            if (!recallFits(prompt, { ...settings, profileId: connection?.mode === 'profile' ? connection.profileId : connection ? '' : settings.profileId }, recallSnapshot)) return;
            state.status = '正在核对一处相关原文；正常聊天不受阻塞。'; emit();
            const response = await host.generate(prompt, { profileId: settings.profileId, model: settings.model, signal: controller.signal, maxTokens: 1024, ...(connection ? { connection } : {}) });
            if (!active()) return;
            const quote = parseRecallQuote(response, source);
            if (!quote) return;
            const latestSnapshot = await host.snapshot();
            if (!equalBinding(latestSnapshot.binding, binding)) return;
            const hashes = await fingerprintMessages(latestSnapshot.messages);
            if (!sourceMatches(triggerSource, hashes) || !sourceMatches(source.source, hashes) || !active()) return;
            await change(binding, { id: id(), type: 'recall', entryId: id(), expectedRevision: source.documentRevision,
                expectedEpoch: doc.epoch, expectedDefaultsRevision: defaults.revision, parent: source.parent, triggerSource, quote });
            if (active()) adopt(binding, await readSource(binding)); // Excerpts materialize from ST originals only on read.
        } catch {
            // Optional recall never rolls back good summaries, retries a model in a
            // loop, or turns a failed/unknown write into a success notification.
            if (active()) { state.status = '本次原文补充未采用，已保存的记忆保持不变。'; emit(); }
        }
    }

    async function startStage({ force = false, start: first = 1, end: last = Infinity, entryId = null, includeCustom = false } = {}) {
        if (disposed || generating || !state.document?.enabled || !state.sourceAvailable || !state.snapshot) return;
        const binding = clone(state.snapshot.binding), key = bindingKey(binding);
        if (jobs.has(key) || localStops.has(key)) return;
        const initial = clone(state.document), defaults = clone(state.defaults), initialTotal = state.snapshot.messages.length;
        const cancelled = cancelledRounds.get(key);
        if (!force && cancelled?.epoch === initial.epoch && cancelled.total === state.snapshot.messages.length) return;
        cancelledRounds.delete(key);
        const settings = effectiveSettings(initial, defaults);
        if (!force && (!settings.stageAuto || !initial.autoSummary)) return;
        const failedKey = `${key}:${initial.epoch}:stage`;
        if (!force && failedJobs.get(failedKey) === state.snapshot.messages.length) return;
        failedJobs.delete(failedKey);
        const controller = new AbortController(); controller.entryId = entryId; jobs.set(key, controller);
        state.streamPreview = '';
        emit();
        let processed = false, cursor = first, failedStage = null;
        const retryState = { exhausted: false };
        try {
            const run = summaryRun(settings, state.snapshot);
            for (;;) {
                failedStage = null;
                if (!entryId && cursor > last) break;
                if (disposed || controller.signal.aborted || generating || localStops.has(key)) break;
                const snapshot = await host.snapshot();
                if (!equalBinding(snapshot.binding, binding)) break;
                const fresh = await readSource(binding); adopt(binding, fresh);
                const document = clone(fresh.document);
                for (const entry of document.entries) if (fresh.invalidSourceIds?.includes(entry.id) && entry.status === 'active') entry.status = 'invalid';
                if (!fresh.sourceAvailable || !document.enabled || document.epoch !== initial.epoch || fresh.defaults.revision !== defaults.revision) break;
                const batchSettings = { ...settings };
                let group;
                if (entryId) {
                    const entry = document.entries.find(e => e.id === entryId && e.kind === 'stage' && e.status !== 'deleted');
                    if (!entry) throw new Error('阶段摘要已变化，请刷新后重试');
                    // Redo adopts CURRENT fine revisions only after verifying all still compressible.
                    const refs = entry.source.parents.map(ref => ({ id: ref.id, revision: document.entries.find(e => e.id === ref.id)?.revision }));
                    stageSourceFromParents(document, refs, { includeCustom: entry.source.includeCustom !== false });
                    group = { existing: entry, parents: refs.map(ref => document.entries.find(e => e.id === ref.id)) };
                } else group = force && Number.isFinite(last)
                    ? planStageRange(document, batchSettings, { start: cursor, end: last, recentCutoff: snapshot.messages.length - settings.recent, includeCustom })
                    : nextStage(document, batchSettings, { force, start: cursor, end: last, recentCutoff: snapshot.messages.length - settings.recent });
                if (!group) {
                    if (force && !processed && isCurrent(binding)) state.status = '没有可合并的连续细摘要；人工修订和近期原文保持原样。';
                    break;
                }
                const refs = group.parents.map(e => ({ id: e.id, revision: e.revision }));
                const useCustom = group.includeCustom ?? (group.existing?.source?.includeCustom !== false);
                const source = stageSourceFromParents(document, refs, { automatic: !force, stageRecent: settings.stageRecent, includeCustom: useCustom });
                controller.entryId = group.existing?.id || entryId;
                const points = group.parents.flatMap(entry => entry.source?.ranges || (entry.source ? [entry.source] : entry.placement ? [{start: entry.placement.fromFloor, end: entry.placement.fromFloor}] : []));
                const startFloor = Math.min(...points.map(range => range.start)), endFloor = Math.max(...points.map(range => range.end));
                if (!Number.isFinite(startFloor) || !Number.isFinite(endFloor)) throw new Error('此范围缺少可核对的叙事位置，请先定位自定义切片');
                if (source.ranges.some(range => range.end > snapshot.messages.length - settings.recent)) throw new Error('此阶段涉及近期原文，本轮不压缩');
                failedStage = { kind: 'stage', entryId: group.existing?.id || entryId, range: { start: startFloor, end: endFloor },
                    parents: refs, includeCustom: useCustom, epoch: initial.epoch, defaultsRevision: defaults.revision };
                if (isCurrent(binding)) { state.status = `正在整理第 ${shownFloor(startFloor)}—${shownFloor(endFloor)} 层的阶段摘要`; emit(); }
                notice(`忆幕阶段总结中：楼层${shownFloor(startFloor)}–${shownFloor(endFloor)}`, 'info');
                if (group.parents.reduce((total, entry) => total + estimateTokens(entry.text), 0) > settings.inputCapacity || !settings.fitsStage(group.parents)) throw new Error('完整阶段超过此连接的可用输入容量，请选择容量足够的连接');
                if (controller.signal.aborted) break;
                const response = await generateWithRetries(stagePrompt(group.parents, settings),
                    { ...run.options, signal: controller.signal, onChunk: streamChunk(binding) },
                    { binding, label: '阶段总结', start: startFloor, end: endFloor, retryState });
                if (isCurrent(binding)) { state.streamPreview = ''; emit(); }
                if (disposed || controller.signal.aborted || localStops.has(key)) break;
                const latest = await readSource(binding); adopt(binding, latest);
                if (disposed || controller.signal.aborted || localStops.has(key)) break;
                if (!latest.document.enabled || latest.document.epoch !== initial.epoch || latest.defaults.revision !== defaults.revision) throw new Error('整理期间设置已改变，阶段结果未采用');
                stageSourceFromParents(latest.document, refs, { automatic: !force, stageRecent: settings.stageRecent, includeCustom: useCustom });
                const entry = { ...parseStage(response, group.parents, settings, { includeCustom: useCustom }), id: group.existing?.id || id() };
                const operation = { id: id(), type: group.existing ? 'redo' : 'append', expectedEpoch: initial.epoch, expectedDefaultsRevision: defaults.revision, automaticStage: !force, entry };
                if (!group.existing && group.replaceStages?.length) operation.replaceStages = clone(group.replaceStages);
                if (group.existing) { operation.entryId = group.existing.id; operation.expectedRevision = group.existing.revision; }
                const result = await change(binding, operation); processed = true;
                if (result.outcome === 'conflict') { if (isCurrent(binding)) state.status = '阶段摘要的两版修订均已保留，请在条目内选择。'; return; }
                failedStage = null; failures.delete(key);
                notice(`本次总结已存至记忆，总结范围：${shownFloor(startFloor)}–${shownFloor(endFloor)}`, 'success');
                if (entryId || !isCurrent(binding)) break;
                cursor = endFloor + 1;
            }
            if (processed && isCurrent(binding) && !controller.signal.aborted) { failures.delete(key); state.status = '阶段总结已完成'; }
        } catch (error) {
            if (!controller.signal.aborted && !disposed) {
                failedJobs.set(failedKey, isCurrent(binding) ? state.snapshot.messages.length : initialTotal);
                if (failedStage) failures.set(key, { ...failedStage, error: error.message });
                if (isCurrent(binding)) { state.error = error.message; state.errorPage = 'memory'; state.status = '阶段整理未完成，已有内容未被覆盖。'; }
                if (retryState.exhausted) notice(`本次总结重试3次均失败：${error?.message || '未知错误'}`, 'error');
                else if (!controller.signal.aborted) notice(`本次总结失败：${error?.message || '未知错误'}`, 'error');
            }
        } finally {
            if (jobs.get(key) === controller) jobs.delete(key);
            if (isCurrent(binding)) state.streamPreview = '';
            emit();
        }
    }

    async function executeAction(type, payload = {}) {
        if (disposed) return false;
        if (type === 'refresh') return refresh({ auto: false });
        // Import archives are usable on the homepage too. They do not require
        // or manufacture a current-chat identity, and survive chat switches.
        if (type.startsWith('backup')) {
            if (state.service.status !== 'ok') await checkService();
            return backupActions.action(type, payload);
        }
        if (type === 'settings' && payload.global) {
            const stamp = generation, target = state.snapshot?.binding ? clone(state.snapshot.binding) : null;
            const current = () => !disposed && stamp === generation && (target ? isCurrent(target) : !state.snapshot);
            if (state.service.status !== 'ok') await checkService();
            const loadedDefaults = state.defaults || (await api.defaults()).defaults;
            if (!current()) throw new Error('当前页面已变化，请重新操作');
            if (!state.defaults || loadedDefaults.revision > state.defaults.revision) state.defaults = loadedDefaults;
            for (const job of jobs.values()) job.abort();
            const operation = { id: id(), expectedRevision: payload.expectedRevision ?? state.defaults.revision, values: payload.values };
            const before = state.defaults;
            state.busy = true; state.error = ''; state.status = ''; emit();
            try {
                let result;
                try { result = await api.defaults(operation); }
                catch (error) {
                    const confirmed = await api.defaults().catch(() => null);
                    if (!confirmed?.defaults?.operations?.includes(operation.id)) throw error;
                    result = confirmed;
                }
                if (current()) {
                    if (state.defaults === before || !state.defaults || result.defaults.revision >= state.defaults.revision) state.defaults = result.defaults;
                    state.error = ''; state.errorPage = '';
                }
                return true;
            } finally { if (current()) { state.busy = false; emit(); } }
        }
        if (!state.snapshot || !state.document || !state.defaults) throw new Error('请先打开单人聊天并读取忆幕');
        const actionBinding = clone(state.snapshot.binding), actionGeneration = generation;
        const snapshot = await host.snapshot();
        if (disposed || actionGeneration !== generation || !equalBinding(snapshot.binding, actionBinding) || !equalBinding(state.snapshot?.binding, actionBinding)) {
            if (!disposed && equalBinding(state.snapshot?.binding, actionBinding)) await refresh();
            throw new Error('当前聊天已变化，请重新操作');
        }
        const binding = clone(actionBinding), doc = clone(state.document), key = bindingKey(binding);
        if (type === 'stop') {
            const job = jobs.get(key);
            if (!job || payload.entryId && job.entryId !== payload.entryId) return false;
            cancelledRounds.set(key, { epoch: doc.epoch, total: snapshot.messages.length });
            job.abort(); if (jobs.get(key) === job) jobs.delete(key);
            failures.delete(key); state.error = ''; state.errorPage = ''; state.status = '已中止本次整理'; emit(); return true;
        }
        if (type === 'pauseManual') {
            const job = jobs.get(key);
            if (!job?.manual || job.manual.pausing) return false;
            job.manual.pausing = true; state.status = '本批完成后暂停'; emit(); return true;
        }
        if (type === 'enable' && !payload.enabled) {
            localStops.add(key); jobs.get(key)?.abort(); host.clear(); prepared = null; state.lastUsed = null; state.lastSkip = null;
            // 停用忆幕：忆幕隐藏过的楼层立刻还原成正常原文。
            await syncHidden({ enabled: false }, effectiveSettings(doc, state.defaults), { restoreAll: true }).catch(reportHideFailure);
            emit();
        }
        if (type === 'autoSummary' && payload.value === false) jobs.get(key)?.abort();
        if (['error', 'mismatch'].includes(state.service.status)) throw new Error('忆幕服务尚不可用，请先刷新检测；当前修改可继续保留。');
        if (type.startsWith('story')) {
            jobs.get(key)?.abort();
            return storyActions(type, payload);
        }
        if (type.startsWith('companion')) return companionActions.action(type, payload);
        if (['stage', 'summarize', 'summarizeRange', 'retry', 'redo'].includes(type)
            || type === 'history' && payload.range?.end > 0 || type === 'autoSummary' && payload.value) {
            if (!doc.enabled || localStops.has(key)) throw new Error('请先启用忆幕');
            if (!state.sourceAvailable) throw new Error('当前聊天原文尚未通过核对，请保存聊天后刷新');
        }
        if (type === 'retry') {
            const failure = failures.get(key);
            if (!failure) throw new Error('没有待重试的整理任务');
            if (jobs.has(key)) throw new Error('正在整理此聊天');
            if (failure.epoch !== doc.epoch || failure.defaultsRevision !== state.defaults.revision) throw new Error('整理设置已改变，请重新选择整理范围');
            if (failure.source && !sourceMatches(failure.source, await fingerprintMessages(snapshot.messages))) throw new Error('对应原文已变化，请重新选择整理范围');
            if (failure.parents?.some(ref => doc.entries.find(entry => entry.id === ref.id)?.revision !== ref.revision)) throw new Error('所选切片已变化，请重新选择阶段范围');
            state.error = ''; emit();
            if (failure.kind === 'stage') deferFor(binding, () => startStage({ force: true, ...failure.range, start: failure.range.start, end: failure.range.end, entryId: failure.entryId, includeCustom: failure.includeCustom ?? false }), actionGeneration);
            else if (failure.entryId) deferFor(binding, () => start({ force: true, entryId: failure.entryId }), actionGeneration);
            else {
                const plan = planManualRange(doc, snapshot.messages, summaryRun(effectiveSettings(doc, state.defaults), snapshot).settings, failure.range, { batchFloors: failure.batchFloors });
                deferFor(binding, () => start({ force: true, range: failure.range, expectedRange: plan.range, batchFloors: failure.batchFloors }), actionGeneration);
            }
            return true;
        }
        if (type === 'stage' || type === 'redo' && doc.entries.find(e => e.id === payload.entryId)?.kind === 'stage') {
            if (jobs.has(key)) return false;
            if (type === 'stage' && Number.isFinite(payload.end)) {
                const plan = planStageRange(doc, summaryRun(effectiveSettings(doc, state.defaults), snapshot).settings, { start: payload.start, end: payload.end,
                    recentCutoff: snapshot.messages.length - effectiveSettings(doc, state.defaults).recent, includeCustom: payload.includeCustom ?? false });
                if (plan.expanded && (payload.expectedRange?.start !== plan.range.start || payload.expectedRange?.end !== plan.range.end)) {
                    throw new Error(`完整阶段范围为 ${shownFloor(plan.range.start)}—${shownFloor(plan.range.end)} 层，请确认范围后开始`);
                }
            }
            state.error = ''; emit(); deferFor(binding, () => startStage({ force: true, start: payload.start, end: payload.end, entryId: type === 'redo' ? payload.entryId : null, includeCustom: payload.includeCustom ?? false }), actionGeneration); return true;
        }
        if (type === 'summarize' || type === 'redo') {
            manualStartReady(key);
            state.error = ''; emit(); deferFor(binding, () => start({ force: true, entryId: type === 'redo' ? payload.entryId : null }), actionGeneration); return true;
        }
        if (type === 'summarizeRange') {
            manualStartReady(key);
            const batchFloors = manualBatchFloors(payload.batchFloors);
            const plan = planManualRange(doc, snapshot.messages, summaryRun(effectiveSettings(doc, state.defaults), snapshot).settings, payload.range, { batchFloors });
            if (payload.expectedRange?.start !== plan.range.start || payload.expectedRange?.end !== plan.range.end) {
                throw new Error(`已有切片覆盖第 ${shownFloor(plan.range.start)}—${shownFloor(plan.range.end)} 层，请确认范围后开始`);
            }
            state.error = ''; emit();
            const range = clone(payload.range), expectedRange = clone(payload.expectedRange);
            deferFor(binding, () => start({ force: true, range, expectedRange, batchFloors }), actionGeneration);
            return true;
        }
        let operation = { id: id() };
        if (type === 'enable') {
            operation = { ...operation, type, enabled: payload.enabled, expectedRevision: payload.expectedRevision ?? doc.configRevision, range: payload.range };
        } else if (type === 'autoSummary' || type === 'history') {
            operation = { ...operation, type, expectedRevision: payload.expectedRevision ?? doc.configRevision,
                ...(type === 'autoSummary' ? { value: payload.value, range: payload.initialRange } : { range: payload.range }) };
        } else if (type === 'settings') {
            jobs.get(key)?.abort();
            operation = { ...operation, type, expectedRevision: payload.expectedRevision ?? doc.configRevision, values: payload.values };
        } else if (type === 'manual') {
            const after = doc.entries.find(entry => entry.id === payload.afterId);
            const fromFloor = payload.fromFloor ?? positionAfter(after, doc, snapshot);
            if (!Number.isSafeInteger(fromFloor) || fromFloor < 1 || fromFloor > snapshot.messages.length) throw new Error('请先选择有效的自定义切片位置');
            const hashes = await fingerprintMessages(snapshot.messages);
            operation = { ...operation, type: 'append', entry: { id: id(), kind: 'manual', title: payload.title ?? '', text: payload.text, source: null,
                placement: { binding, fromFloor, hash: hashes[fromFloor - 1] }, scenes: payload.scenes || [], afterId: insertionAfter(after, doc) } };
        } else if (type === 'reorder') {
            const entryOrder = payload.entryOrder;
            if (!Array.isArray(entryOrder)) throw new Error('切片顺序无效');
            const moved = doc.entries.find(entry => entry.id === payload.movedId), placements = {};
            if (moved?.kind === 'manual') {
                const index = entryOrder.indexOf(moved.id);
                const before = entryOrder.slice(0, index).reverse().map(id => doc.entries.find(entry => entry.id === id)).find(entry => entry && entry.status !== 'deleted' && !entry.origin && (entry.source || entry.placement));
                const fromFloor = before ? positionAfter(before, doc, snapshot) : 1;
                const hashes = await fingerprintMessages(snapshot.messages);
                if (!hashes[fromFloor - 1]) throw new Error('叙事位置尚未通过核对');
                placements[moved.id] = { binding, fromFloor, hash: hashes[fromFloor - 1] };
            }
            operation = { ...operation, type: 'reorder', expectedRevision: payload.expectedRevision ?? doc.revision, entryOrder, placements };
        }
        else if (type === 'edit' || type === 'entry') {
            const entry = doc.entries.find(e => e.id === payload.entryId);
            if (!entry) throw new Error('记忆条目不存在');
            operation = { ...operation, ...payload, id: operation.id, type, expectedRevision: payload.expectedRevision ?? entry.revision };
        } else throw new Error('未知的忆幕操作');
        state.busy = true; state.error = ''; emit();
        try {
            const result = await change(binding, operation);
            if (type === 'enable' && payload.enabled) localStops.delete(key);
            if (result.outcome === 'conflict') { if (isCurrent(binding)) state.status = '两版修订均已保留，请在条目内选择。'; return false; }
            if (isCurrent(binding)) {
                state.status = ['enable', 'autoSummary'].includes(type) ? ''
                    : type === 'history' ? payload.range.end > 0 ? '准备整理历史楼层' : '' : '';
                if (type === 'history' && payload.range.end > 0) deferFor(binding, () => start({ force: true, historyOnly: true }).catch(() => {}), actionGeneration);
                else if (type === 'enable' && payload.enabled || type === 'settings' || type === 'autoSummary' && payload.value) {
                    if (type !== 'settings') catchUp = true;
                    deferFor(binding, () => start().catch(() => {}), actionGeneration);
                }
            }
            return true;
        } catch (error) { if (isCurrent(binding)) state.error = error.message; throw error; }
        finally { if (isCurrent(binding)) { state.busy = false; emit(); } }
    }

    async function action(type, payload = {}) {
        const stamp = generation, binding = state.snapshot?.binding ? clone(state.snapshot.binding) : null;
        const page = payload.errorPage || (type === 'settings' ? payload.values?.prompts ? 'overview' : 'settings'
            : /^(story|companion|backup)/.test(type) ? type.match(/^(story|companion|backup)/)[0]
            : ['enable', 'autoSummary', 'history', 'summarizeRange', 'summarize'].includes(type) ? 'overview' : 'memory');
        try { return await executeAction(type, payload); }
        catch (error) {
            if (!disposed && stamp === generation && (binding ? isCurrent(binding) : !state.snapshot)) {
                state.error = error.message; state.errorPage = page; emit();
            }
            throw error;
        }
    }

    const OFFER_ON_SKIP = new Set(['unsupported-generation', 'unverified-mapping', 'unsupported-name-format', 'unknown-context-budget', 'unsupported-tools', 'live-chat-reference', 'source-changed']);
    async function intercept(coreChat, contextSize, abort, type = '') {
        host.clear(); prepared = null; offered = false;
        // 用户刚发出的消息会排一次稍后的刷新；它若在本轮准备好之后才跑，会把刚读到的状态顶掉。这里提前跑掉，并等到最新一次刷新结束。
        // 这次读取是刻意的：它能发现别的设备、别处改动过的记忆与原文，省掉它就会注入过期内容（有专门的回归测试）。
        // 因此它只等一次、且有上限（interceptWaitMs），超时本轮不带记忆、照常生成。
        if (refreshTimer) { clearTimeout(refreshTimer); refreshTimer = null; generationRefresh = refresh({ quiet: true, auto: false, probe: false }); }
        if (generationRefresh) {
            const deadline = Date.now() + interceptWaitMs;
            let ready = true, waited;
            do {
                waited = refreshing || generationRefresh;
                let timer;
                ready = await Promise.race([Promise.resolve(waited).then(() => true, () => false), new Promise(resolve => { timer = setTimeout(() => resolve(false), Math.max(0, deadline - Date.now())); })]);
                clearTimeout(timer);
            } while (ready && refreshing && refreshing !== waited);
            // A slow storage read never holds normal generation hostage — but the round says why it carried no memory.
            if (!ready) { if (!disposed && state.document?.enabled) { state.lastSkip = { stage: 'refresh', reason: 'refresh-timeout', at: ++skipSeq }; emit(); } return; }
        }
        if (disposed || !state.document?.enabled || !state.snapshot || localStops.has(bindingKey(state.snapshot.binding))) return;
        if (!state.sourceAvailable) { state.lastSkip = { stage: 'refresh', reason: 'source-unverified', at: ++skipSeq }; emit(); return; }
        const ticket = generation;
        const doc = clone(state.document), defaults = clone(state.defaults);
        // Keep disabled/invalid authoritative stages in the document so their
        // automatic children cannot bypass a human revision during selection.
        for (const entry of doc.entries) if (state.invalidSourceIds.includes(entry.id) && entry.status === 'active') entry.status = 'invalid';
        try {
            // 隐藏只能在 ST 装配 coreChat 之前改：这里已经拿到构造好的消息，再动聊天会让两边对不上
            // （prepare 会判 source-changed）。隐藏统一由 refresh 与总结完成后同步，见 syncHidden。
            const snapshot = await host.snapshot();
            if (!equalBinding(snapshot.binding, doc.binding)) return;
            // 向量相似度限时取：到点没回来本轮就按关键词排序，请求继续在后台跑完、把向量记下，下一轮即可用上。
            const semanticScores = typeof host.vectorScores !== 'function' ? null : request => {
                const pending = Promise.resolve().then(() => host.vectorScores(request)).catch(() => null);
                let timer;
                return Promise.race([pending, new Promise(resolve => { timer = setTimeout(() => resolve(null), semanticWaitMs); })]).finally(() => clearTimeout(timer));
            };
            // 不传 countTokens：ST 的分词器对 OpenAI 类连接要发网络请求，而这是每轮生成前都要跑的路径。
            // 记忆块大小用 estimateTokens 估算即可（只用于记忆调阅里显示「约多少 token」）。
            const plan = await buildPlan(doc, defaults, snapshot, { type, semanticScores, recalledAt: recallAtMap(snapshot.binding) });
            if (ticket !== generation || disposed || !state.document?.enabled || localStops.has(bindingKey(doc.binding)) || state.document?.epoch !== doc.epoch) return;
            // 隐藏不在这里做：ST 已按当前聊天装配好本轮消息，此刻再改聊天会让两边对不上，本轮反而丢掉记忆。
            // 隐藏统一在总结完成后与刷新时应用（见 syncHidden），下一轮装配时自然生效。
            const result = host.prepare(coreChat, plan, snapshot, type);
            if (result.prepared) { prepared = { session: result.session, generation: ticket, binding: clone(doc.binding), revision: doc.revision, defaultsRevision: defaults.revision, epoch: doc.epoch, semantic: plan.semantic === true,
                foreignIds: plan.entries.filter(entry => entry.origin).map(entry => entry.id) };
                // 保底：把记忆写入持久注入槽，由 ST 烘焙进本轮 payload。若最终请求边界无法安全
                // 改写（能力/路由受限等），这段记忆仍随原请求送达模型；成功改写时
                // budget.withdrawMemoryShadow 会先移除烘焙副本，避免重复注入。此处不隐藏旧楼。
                // 含继承（origin）记忆的方案改写需在最终边界重核，烘焙槽无法事后回核，故不走保底，
                // 维持原有仅改写路径——这也让下方 verify 分支下 offered 恒为 false，语义一致。
                offered = prepared.foreignIds.length ? false : host.offer(plan.prompt); }
            else if (ticket === generation && isCurrent(doc.binding) && result.reason !== 'empty') {
                // 原文替换做不了（续写、楼层对不上、带工具消息等）时，不再整轮没有记忆：仍以保底方式把记忆附在本轮请求里。
                // 后台静默生成、文本补全、群聊不附加；含继承记忆的方案同上不走保底。
                offered = OFFER_ON_SKIP.has(result.reason) && type !== 'quiet' && !plan.entries.some(entry => entry.origin) ? host.offer(plan.prompt) : false;
                state.lastSkip = { stage: 'prepare', reason: result.reason || 'unknown', at: ++skipSeq, offered }; emit();
            }
        } catch (error) {
            host.clear(); // Failure retains ST's unchanged original context.
            if (ticket === generation && !disposed) { state.lastSkip = { stage: 'plan', reason: 'plan-error', message: String(error?.message || error).slice(0, 200), at: ++skipSeq }; emit(); }
        }
    }

    // 本轮实际发出的请求有多大：用户看不到忆幕对聊天记录的改动，就必须能直接看到请求的体积。
    // 先用零等待的估算立刻显示，等 ST 的分词器算完再换成实测；分词在请求发出之后才跑，
    // 不在生成路径上等（ST 对 OpenAI 类连接是逐条网络请求，等它就会拖慢回复）。
    // 估算口径与正文一致：中日韩等宽字符按 1 token，ASCII 按 0.35（原先按字节数的一半算高估约一倍）。
    function estimateRequestTokens(messages) {
        const raw = JSON.stringify(messages);
        let tokens = 0;
        for (const ch of raw) tokens += ch.codePointAt(0) > 127 ? 1 : 0.35;
        return Math.ceil(tokens);
    }
    let measureTicket = 0;
    function measureRequest(messages, patch = {}) {
        if (!Array.isArray(messages) || !messages.length) return;
        const ticket = ++measureTicket, text = JSON.stringify(messages);
        const route = state.snapshot?.route || {};
        const base = { contextTokens: Number(route.context) || null, responseTokens: Number(route.response) || null,
            messageCount: messages.length, at: Date.now(), ...patch };
        state.requestSize = { tokens: estimateRequestTokens(messages), method: 'estimate', ...base };
        emit();
        // 实测要把整份请求再上传给 ST 的分词接口。此刻生成请求正要发出，两份大请求会抢同一条上行带宽，
        // 所以只先记下，等这一轮回复结束（settled）再去量；期间换了聊天或又发了一轮，这份读数作废。
        pendingCount = { ticket, text };
    }
    let pendingCount = null;
    function countPendingRequest() {
        const pending = pendingCount; pendingCount = null;
        if (!pending || pending.ticket !== measureTicket || disposed) return;
        let counted = null;
        try { counted = host.countTokens?.(pending.text); } catch { return; }
        if (counted && typeof counted.then === 'function') Promise.resolve(counted).then(value => {
            if (pending.ticket !== measureTicket || disposed || !state.requestSize) return;
            if (!Number.isFinite(value) || value <= 0) return;
            state.requestSize = { ...state.requestSize, tokens: Math.ceil(value), method: 'st-tokenizer' };
            emit();
        }).catch(() => {});
    }

    async function event(name, args = []) {
        if (disposed) return;
        if (name === 'GENERATION_STARTED') {
            if (args[2]) return;
            generation++; generating = true; prepared = null; offered = false; state.lastUsed = null; state.lastSkip = null; host.clear();
            settleIdle = 0; pollSettle(generation);
            generationRefresh = refresh({ quiet: true, auto: false, probe: false });
            return;
        }
        if (name === 'GENERATION_STOPPED' || name === 'GENERATION_ENDED' || name === 'GENERATION_SETTLED') {
            if (name === 'GENERATION_SETTLED' && !generating) return;
            settled();
            return;
        }
        if (name === 'GENERATE_AFTER_DATA') {
            if (args[1] || Array.isArray(args[0]?.prompt)) return; // ST also emits this intermediate event for chat completion.
            // Text/instruct payloads do not expose a reliable message boundary. Keep them untouched.
            // 文本/指令补全无可靠消息边界，不做原文替换，也不主张保底投递（文本模式对注入槽的
            // 取用与 chat-completion 不同，不过度声明）。保持原回退语义。
            if (prepared) { prepared = null; host.clear(); state.lastSkip = { stage: 'boundary', reason: 'text-completion-boundary-unavailable', at: ++skipSeq }; state.status = '当前请求不支持安全原文替换，本轮保留 ST 原上下文。'; emit(); }
            return;
        }
        if (name === 'CHAT_COMPLETION_PROMPT_READY') {
            // 最终请求已经装配完（含 ST 自己的全部注入与忆幕的记忆改写）：这时统计的才是用户真正付出的 token。
            const data = args[0];
            if (data && data.dryRun !== true && Array.isArray(data.chat)) void measureRequest(data.chat);
            return;
        }
        if (name === 'CHAT_COMPLETION_SETTINGS_READY') {
            if (!prepared || !isCurrent(prepared.binding)) return;
            const pending = prepared;
            const isCurrentRequest = () => !disposed && pending === prepared && pending.generation === generation && isCurrent(pending.binding)
                && !localStops.has(bindingKey(pending.binding)) && state.document?.enabled && state.document.revision === pending.revision
                && state.document.epoch === pending.epoch && state.defaults?.revision === pending.defaultsRevision && state.sourceAvailable;
            if (pending.foreignIds?.length) {
                // The current browser cannot observe edits in ancestor files.
                // Recheck them at the final request boundary; a slow/unavailable
                // source keeps the ordinary ST request, never blocks chatting.
                let timer;
                const verified = await Promise.race([api.read(pending.binding).catch(() => null),
                    new Promise(resolve => { timer = setTimeout(() => resolve(null), 500); })]);
                clearTimeout(timer);
                if (!isCurrentRequest() || !verified?.sourceAvailable || verified.document.revision !== pending.revision
                    || verified.defaults.revision !== pending.defaultsRevision || pending.foreignIds.some(id =>
                        verified.document.entries.find(entry => entry.id === id)?.originVerified !== true)) {
                    if (pending === prepared) { prepared = null; host.clear(); state.lastSkip = { stage: 'verify', reason: 'origin-reverify-failed', at: ++skipSeq }; emit(); } return;
                }
            }
            const result = await host.applyPrepared(args[0], pending.session, { isCurrent: isCurrentRequest });
            if (!isCurrentRequest()) {
                // 准备好之后状态又变了（文档修订、来源核对、停用…）：本轮不改写。同一轮内如实记下原因。
                if (!disposed && pending === prepared && pending.generation === generation && isCurrent(pending.binding)) { state.lastSkip = { stage: 'apply', reason: 'source-or-route-changed', at: ++skipSeq, offered }; emit(); }
                return;
            }
            if (result.applied) {
                state.lastUsed = { entries: clone(result.entries), tokens: result.tokens, estimated: true, status: 'prepared', semantic: pending.semantic === true,
                    sourceReplacement: result.removedFloors.length > 0, removedFloors: result.removedFloors, recentFloors: result.recentFloors,
                    requestTokens: result.requestTokens, contextTokens: result.contextTokens, responseTokens: result.responseTokens };
                state.lastSkip = null;
                // 这一轮真正带进去的记忆都算「被想起」，从现在起重新计暖。
                rememberRecall(pending.binding, result.entries);
                prepared = null; offered = false; emit();
            } else {
                // 诊断：未能做原文替换/隐藏旧楼。但若已成功写入保底注入槽（offered），这段记忆
                // 已在装配前烘焙进本轮 payload，仍送达模型——此时为「保底注入、未隐藏旧楼」，
                // 而非完全回退。记录 offered 供「记忆调阅」如实说明。
                state.lastSkip = { stage: 'apply', reason: result.reason || 'unknown', at: ++skipSeq, offered };
                emit();
            }
            return;
        }
        if (name === 'CHAT_RENAMED' && state.snapshot) {
            const info = args[0], current = state.snapshot.binding;
            // ST may finish loading the NEW name before emitting CHAT_RENAMED.
            if (info && [info.oldFileName, info.newFileName].includes(current.file) && !info.groupId && (info.avatarId === current.avatar || info.avatarId === undefined)) {
                const old = { ...current, file: info.oldFileName }, next = { ...current, file: info.newFileName };
                try { await api.rename(old, next); }
                catch (error) { if (isCurrent(current)) { state.error = error.message; emit(); } }
            }
        }
        if (name.startsWith('CHAT_') || name.startsWith('MESSAGE_')) {
            if (name === 'CHAT_CHANGED' || name === 'CHAT_LOADED' || name === 'CHAT_DELETED') {
                generation++; host.clear(); prepared = null;
                // Re-entering a chat retries a failed automatic round and announces it.
                catchUp = true; failedJobs.clear(); saveWaits = 0; clearTimeout(saveTimer); saveTimer = null;
            }
            clearTimeout(refreshTimer);
            refreshTimer = setTimeout(() => { refreshTimer = null; refresh({ quiet: true, auto: !generating }); }, 80);
        }
    }

    return {
        get state() { return snapshotState(); }, refresh, action, start, startStage, intercept, event,
        destroy() { disposed = true; sequence++; generation++; clearTimeout(refreshTimer); clearTimeout(settleTimer); clearTimeout(saveTimer); for (const job of jobs.values()) job.abort(); companionActions.destroy(); backupActions.destroy(); host.clear(); },
        async settled() { await refreshing; },
    };
}
