import { VERSION, bindingKey, effectiveSettings, fingerprintMessages, sourceMatches } from './contract.mjs';
import { buildPlan, inspectSources, nextBatch, parseSummary, summaryPrompt, planManualRange, initialRangePreview } from './core.mjs';
import { nextStage, parseStage, stagePrompt } from './layers.mjs';
import { stageSourceFromParents } from './stage-contract.mjs';
import { recallCandidates, parseRecallRequest, recallPrompt, parseRecallQuote, recallFits } from './recall.mjs';
import { recallBlockReason } from './recall-contract.mjs';
import { createStoryActions } from './story-runtime.mjs';
import { createCompanionActions } from './companion-runtime.mjs';
import { createBackupActions } from './backup-runtime.mjs';

const uniqueId = () => globalThis.crypto?.randomUUID?.() || `ym_${Date.now()}_${Math.random().toString(36).slice(2)}`;
const equalBinding = (a, b) => !!a && !!b && bindingKey(a) === bindingKey(b);
const clone = value => structuredClone(value);

/** Browser-lifetime coordinator, not a background server or a second source database. */
export function createController({ host, api, onChange = () => {}, countTokens = null, id = uniqueId, defer = fn => setTimeout(fn, 0) }) {
    const state = { loading: false, error: '', status: '', snapshot: null, document: null, defaults: null, busy: false, profiles: [], lastUsed: null, sourceAvailable: false, invalidSourceIds: [],
        service: { status: 'unknown', version: '', requiredVersion: VERSION } };
    let sequence = 0, serviceSequence = 0, disposed = false, generation = 0, generating = false, prepared = null, refreshing = null;
    const jobs = new Map(), localStops = new Set(), failedJobs = new Set();
    let refreshTimer = null, generationRefresh = null;
    const emit = () => { if (!disposed) onChange({ ...state, paused: state.snapshot && localStops.has(bindingKey(state.snapshot.binding)) }); };
    const isCurrent = binding => equalBinding(state.snapshot?.binding, binding);
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
        // A legacy ST profile has no reliable window metadata. Keep its existing
        // explicit batch cap; an external/ST connection must provide real limits.
        if (connection && connection.mode !== 'profile' && (!Number.isSafeInteger(context) || context <= output + 512)) {
            throw new Error('此连接的上下文不足，请检查连接设置');
        }
        if (context > 0) settings.batch = Math.min(settings.batch, Math.max(1, Math.min(Math.floor(context * 0.45), context - output - 512)));
        return { settings, connection, options: { profileId: settings.profileId, model: settings.model, ...(connection ? { connection } : {}) } };
    }

    async function change(binding, operation) {
        try { const result = await api.change(binding, operation); adopt(binding, result); return result; }
        catch (error) {
            // One read can confirm an acknowledged-lost write; never blindly repeat a mutation.
            try {
                const fresh = await api.read(binding); adopt(binding, fresh);
                if (fresh.document.operations.includes(operation.id)) return { ...fresh, outcome: 'confirmed' };
            } catch { /* The original error remains the factual result. */ }
            throw error;
        }
    }

    async function checkService() {
        const ticket = ++serviceSequence;
        state.service = { status: 'checking', version: '', requiredVersion: VERSION }; emit();
        try {
            const value = await api.health();
            if (!disposed && ticket === serviceSequence) {
                state.service = { status: 'ok', version: typeof value?.version === 'string' ? value.version : '', requiredVersion: VERSION }; emit();
            }
        } catch (error) {
            if (!disposed && ticket === serviceSequence) {
                state.service = { status: error?.code === 'yimu_version' ? 'mismatch' : 'error', version: typeof error?.currentVersion === 'string' ? error.currentVersion : '', requiredVersion: VERSION }; emit();
            }
            throw error;
        }
    }

    async function refresh({ quiet = false, auto = false } = {}) {
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
                catch (error) { identityFailed = true; throw serviceError || error; }
                if (ticket !== sequence || disposed) return;
                const switched = !equalBinding(snapshot.binding, state.snapshot?.binding);
                if (switched) {
                    host.clear(); prepared = null;
                    state.document = null; state.defaults = null; state.lastUsed = null; state.status = ''; state.error = ''; state.sourceAvailable = false; state.busy = false; state.invalidSourceIds = [];
                    state.story = storyActions.forBinding(snapshot.binding); state.companion = {};
                }
                state.snapshot = snapshot; state.profiles = host.profiles(); emit();
                if (serviceError) throw serviceError;
                if (quiet) await checkService();
                const data = await api.read(snapshot.binding);
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
                if (!data.sourceAvailable) { host.clear(); state.error = '当前聊天原件尚未通过核对；记忆已保留，暂不参与生成。请在 ST 保存聊天后刷新。'; }
                state.loading = false; emit();
                if (auto && !disposed) deferFor(snapshot.binding, () => start().catch(() => {}), refreshGeneration);
            } catch (error) {
                if (ticket !== sequence || disposed) return;
                if (identityFailed) {
                    state.snapshot = null; state.document = null; state.defaults = null; state.lastUsed = null;
                    state.busy = false; state.status = ''; state.invalidSourceIds = [];
                }
                host.clear(); prepared = null; state.sourceAvailable = false; state.error = error.message; state.loading = false; emit();
            }
        })();
        refreshing = task;
        try { await task; } finally { if (refreshing === task) refreshing = null; }
    }

    async function start({ force = false, entryId = null, range: requestedRange = null, expectedRange = null, historyOnly = false } = {}) {
        if (disposed || generating || !state.document?.enabled || !state.sourceAvailable || !state.snapshot || !force && !state.document.autoSummary) return;
        const binding = clone(state.snapshot.binding), key = bindingKey(binding);
        if (jobs.has(key) || localStops.has(key)) return;
        const doc = clone(state.document), runGeneration = generation;
        const failedKey = `${key}:${doc.epoch}`;
        if (!force && failedJobs.has(failedKey)) return;
        failedJobs.delete(failedKey);
        const controller = new AbortController(); jobs.set(key, controller);
        let jobDocument = doc, snapshot = clone(state.snapshot);
        const defaults = clone(state.defaults);
        const settings = effectiveSettings(doc, defaults);
        let processed = false, recallAttempted = false, noWork = false;
        try {
            const run = summaryRun(settings, snapshot);
            const manualPlan = requestedRange ? planManualRange(doc, snapshot.messages, settings, requestedRange) : null;
            if (manualPlan && (expectedRange?.start !== manualPlan.range.start || expectedRange?.end !== manualPlan.range.end)) {
                throw new Error('已有切片范围已变化，请确认当前整理范围后重试');
            }
            const plannedHashes = manualPlan ? await fingerprintMessages(snapshot.messages) : null;
            let manualIndex = 0;
            for (;;) {
                if (controller.signal.aborted || disposed || localStops.has(key)) break;
                const live = await host.snapshot().catch(() => null);
                if (live && equalBinding(live.binding, binding)) snapshot = live;
                const fresh = await api.read(binding);
                jobDocument = fresh.document; adopt(binding, fresh);
                if (!fresh.sourceAvailable || !jobDocument.enabled || jobDocument.epoch !== doc.epoch || fresh.defaults.revision !== defaults.revision) break;
                let batch;
                if (manualPlan) {
                    batch = manualPlan.batches[manualIndex];
                    if (!batch) break;
                    if (batch.redo) {
                        const current = jobDocument.entries.find(entry => entry.id === batch.redo.id);
                        if (!current || current.revision !== batch.redo.revision) throw new Error('待整理的切片已变化，请刷新后重试');
                    } else if (jobDocument.entries.some(entry => entry.kind === 'summary' && !entry.origin
                        && entry.source.start <= batch.end && entry.source.end >= batch.start)) throw new Error('此范围已新增记忆，请刷新后确认整理范围');
                } else if (entryId) {
                    const entry = jobDocument.entries.find(e => e.id === entryId);
                    if (!entry?.source || entry.status === 'deleted') throw new Error('此条记忆没有可重新总结的来源');
                    if (entry.origin) throw new Error('这是独立继承的记忆，可在此手动修订；自动重总结不会跨故事改写');
                    batch = { start: entry.source.start, end: entry.source.end, redo: clone(entry) };
                    if (batch.end > snapshot.messages.length) throw new Error('对应原文楼层已不存在，请先处理来源变化');
                } else batch = nextBatch(jobDocument, snapshot.messages, settings, { force, historyOnly });
                if (!batch) { noWork = true; break; }
                const hashes = await fingerprintMessages(snapshot.messages);
                const frozenSource = { start: batch.start, end: batch.end, hashes: hashes.slice(batch.start - 1, batch.end) };
                if (manualPlan && !sourceMatches({ start: manualPlan.range.start, end: manualPlan.range.end,
                    hashes: plannedHashes.slice(manualPlan.range.start - 1, manualPlan.range.end) }, hashes)) throw new Error('整理期间所选原文已变化，请确认后重试');
                const candidateDocument = clone(jobDocument);
                for (const entry of candidateDocument.entries) if (fresh.invalidSourceIds?.includes(entry.id)) entry.status = 'invalid';
                const candidates = !manualPlan && !historyOnly && !entryId && !recallAttempted ? recallCandidates(candidateDocument, settings, snapshot.messages, batch, hashes) : [];
                if (isCurrent(binding)) { state.status = `正在整理第 ${batch.start}—${batch.end} 层`; emit(); }
                const response = await host.generate(summaryPrompt(snapshot.messages, batch, settings, { recallCandidates: candidates }), { ...run.options, signal: controller.signal });
                if (controller.signal.aborted || disposed || localStops.has(key)) break;
                const beforeSave = await api.read(binding); adopt(binding, beforeSave);
                if (beforeSave.defaults.revision !== defaults.revision || !beforeSave.document.enabled || beforeSave.document.epoch !== doc.epoch) throw new Error('整理期间设置已变化，本次结果未采用');
                const after = await host.snapshot().catch(() => null);
                if (after && equalBinding(after.binding, binding)) {
                    const latestHashes = await fingerprintMessages(after.messages);
                    if (!sourceMatches(frozenSource, latestHashes)) throw new Error('整理期间原文已变化，本次结果未采用');
                }
                let slices = parseSummary(response, batch, hashes);
                // Redo replaces exactly one existing slice, never creates overlapping entries.
                if (batch.redo) slices = [{ kind: 'summary', text: slices.map(s => s.text).join('\n\n'), source: frozenSource }];
                for (const slice of slices) {
                    if (controller.signal.aborted || disposed || localStops.has(key)) break;
                    const operation = { id: id(), type: batch.redo ? 'redo' : 'append', expectedEpoch: doc.epoch, expectedDefaultsRevision: defaults.revision,
                        entry: { ...slice, id: batch.redo?.id || id() } };
                    if (batch.redo) { operation.entryId = batch.redo.id; operation.expectedRevision = batch.redo.revision; }
                    const result = await change(binding, operation); jobDocument = result.document; processed = true;
                    if (result.outcome === 'conflict') {
                        if (isCurrent(binding)) state.status = '此条记忆存在另一版修订，两版均已保留，请在条目内选择。';
                        return;
                    }
                }
                const request = parseRecallRequest(response, candidates);
                if (request && !recallAttempted) {
                    recallAttempted = true; // At most one bounded extraction in this entire background run.
                    await completeRecall({ binding, key, controller, doc, defaults, settings, snapshot, request, triggerSource: frozenSource, slices, recallGeneration: runGeneration, connection: run.connection });
                }
                if (manualPlan) manualIndex++;
                if (entryId || !isCurrent(binding) || generating) break;
            }
            if (processed && isCurrent(binding) && !controller.signal.aborted) { state.status = '本轮整理已完成；有效记忆从下一次生成开始使用。'; emit(); }
            else if (force && noWork && isCurrent(binding) && !controller.signal.aborted) {
                const preview = historyOnly && doc.initialRange ? initialRangePreview(jobDocument, snapshot.messages, doc.initialRange, settings) : null;
                state.status = preview?.valid && preview.recent.length === doc.initialRange.end - doc.initialRange.start + 1
                    ? '所选楼层保留为近期原文，暂不整理' : '所选范围暂无待整理楼层';
                emit();
            }
        } catch (error) {
            if (!controller.signal.aborted && !disposed) {
                failedJobs.add(failedKey);
                if (isCurrent(binding)) { state.error = error.message; state.status = '本轮整理未完成；原文与已保存记忆保留。'; emit(); }
            }
        } finally {
            if (jobs.get(key) === controller) jobs.delete(key);
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
            const fresh = await api.read(binding); adopt(binding, fresh);
            const parent = fresh.document.entries.find(entry => entry.id === request.parentId);
            if (!active() || !fresh.sourceAvailable || recallBlockReason(fresh.document, parent)) return;
            const source = await api.recallSource(binding, { parentId: request.parentId, parentRevision: request.parentRevision,
                expectedEpoch: doc.epoch, expectedDefaultsRevision: defaults.revision, triggerSource });
            if (!active()) return;
            const prompt = recallPrompt(source, request, fresh.document, slices);
            const recallSnapshot = connection && connection.mode !== 'profile' ? { ...snapshot, maxContext: connection.contextTokens, maxResponse: connection.maxTokens } : snapshot;
            if (!recallFits(prompt, { ...settings, profileId: connection?.mode === 'profile' ? settings.profileId : connection ? '' : settings.profileId }, recallSnapshot)) return;
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
            if (active()) adopt(binding, await api.read(binding)); // Excerpts materialize from ST originals only on read.
        } catch {
            // Optional recall never rolls back good summaries, retries a model in a
            // loop, or turns a failed/unknown write into a success notification.
            if (active()) { state.status = '本次原文补充未采用，已保存的记忆保持不变。'; emit(); }
        }
    }

    async function startStage({ force = false, start: first = 1, end: last = Infinity, entryId = null } = {}) {
        if (disposed || generating || !state.document?.enabled || !state.sourceAvailable || !state.snapshot) return;
        const binding = clone(state.snapshot.binding), key = bindingKey(binding);
        if (jobs.has(key) || localStops.has(key)) return;
        const initial = clone(state.document), defaults = clone(state.defaults);
        const settings = effectiveSettings(initial, defaults);
        if (!force && (!settings.stageAuto || !initial.autoSummary)) return;
        const failedKey = `${key}:${initial.epoch}:stage`;
        if (!force && failedJobs.has(failedKey)) return;
        failedJobs.delete(failedKey);
        const controller = new AbortController(); jobs.set(key, controller);
        let processed = false, cursor = first;
        try {
            const run = summaryRun(settings, state.snapshot);
            for (;;) {
                if (disposed || controller.signal.aborted || generating || localStops.has(key)) break;
                const snapshot = await host.snapshot();
                if (!equalBinding(snapshot.binding, binding)) break;
                const fresh = await api.read(binding); adopt(binding, fresh);
                const document = clone(fresh.document);
                for (const entry of document.entries) if (fresh.invalidSourceIds?.includes(entry.id) && entry.status === 'active') entry.status = 'invalid';
                if (!fresh.sourceAvailable || !document.enabled || document.epoch !== initial.epoch || fresh.defaults.revision !== defaults.revision) break;
                const batchSettings = { ...settings };
                let group;
                if (entryId) {
                    const entry = document.entries.find(e => e.id === entryId && e.kind === 'stage' && !['deleted', 'excluded'].includes(e.status));
                    if (!entry) throw new Error('阶段摘要已变化，请刷新后重试');
                    // Redo adopts CURRENT fine revisions only after verifying all still compressible.
                    const refs = entry.source.parents.map(ref => ({ id: ref.id, revision: document.entries.find(e => e.id === ref.id)?.revision }));
                    stageSourceFromParents(document, refs);
                    group = { existing: entry, parents: refs.map(ref => document.entries.find(e => e.id === ref.id)) };
                } else group = nextStage(document, batchSettings, { force, start: cursor, end: last, recentCutoff: snapshot.messages.length - settings.recent });
                if (!group) {
                    if (force && !processed && isCurrent(binding)) state.status = '没有可合并的连续细摘要；人工修订和近期原文保持原样。';
                    break;
                }
                const refs = group.parents.map(e => ({ id: e.id, revision: e.revision }));
                const source = stageSourceFromParents(document, refs);
                const startFloor = source.ranges[0].start, endFloor = source.ranges.at(-1).end;
                if (endFloor > snapshot.messages.length - settings.recent) throw new Error('此阶段涉及近期原文，本轮不压缩');
                if (isCurrent(binding)) { state.status = `正在整理第 ${startFloor}—${endFloor} 层的阶段摘要`; emit(); }
                const response = await host.generate(stagePrompt(group.parents, settings), { ...run.options, signal: controller.signal });
                if (disposed || controller.signal.aborted || localStops.has(key)) break;
                const latest = await api.read(binding); adopt(binding, latest);
                if (!latest.document.enabled || latest.document.epoch !== initial.epoch || latest.defaults.revision !== defaults.revision) throw new Error('整理期间设置已改变，阶段结果未采用');
                stageSourceFromParents(latest.document, refs); // Exact revisions, not just matching floor labels.
                const entry = { ...parseStage(response, group.parents), id: group.existing?.id || id() };
                const operation = { id: id(), type: group.existing ? 'redo' : 'append', expectedEpoch: initial.epoch, expectedDefaultsRevision: defaults.revision, entry };
                if (group.existing) { operation.entryId = group.existing.id; operation.expectedRevision = group.existing.revision; }
                const result = await change(binding, operation); processed = true;
                if (result.outcome === 'conflict') { if (isCurrent(binding)) state.status = '阶段摘要的两版修订均已保留，请在条目内选择。'; return; }
                if (entryId || !isCurrent(binding)) break;
                cursor = endFloor + 1;
            }
            if (processed && isCurrent(binding) && !controller.signal.aborted) state.status = '阶段整理已完成；细摘要和人工修订仍保留。';
        } catch (error) {
            if (!controller.signal.aborted && !disposed) {
                failedJobs.add(failedKey);
                if (isCurrent(binding)) { state.error = error.message; state.status = '阶段整理未完成，已有内容未被覆盖。'; }
            }
        } finally { if (jobs.get(key) === controller) jobs.delete(key); emit(); }
    }

    async function action(type, payload = {}) {
        if (disposed) return false;
        if (type === 'refresh') return refresh({ auto: false });
        // Import archives are usable on the homepage too. They do not require
        // or manufacture a current-chat identity, and survive chat switches.
        if (type.startsWith('backup')) {
            if (state.service.status !== 'ok') await checkService();
            return backupActions.action(type, payload);
        }
        if (!state.snapshot || !state.document || !state.defaults) throw new Error('请先打开单人聊天并读取忆幕');
        const snapshot = await host.snapshot();
        if (!equalBinding(snapshot.binding, state.snapshot.binding)) { await refresh(); throw new Error('当前聊天已变化，请重新操作'); }
        const binding = clone(snapshot.binding), doc = clone(state.document), key = bindingKey(binding), actionGeneration = generation;
        if (type === 'enable' && !payload.enabled) {
            localStops.add(key); jobs.get(key)?.abort(); host.clear(); prepared = null; state.lastUsed = null; emit();
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
        if (type === 'stage' || type === 'redo' && doc.entries.find(e => e.id === payload.entryId)?.kind === 'stage') {
            if (jobs.has(key)) return false;
            state.error = ''; emit(); deferFor(binding, () => startStage({ force: true, start: payload.start, end: payload.end, entryId: type === 'redo' ? payload.entryId : null }), actionGeneration); return true;
        }
        if (type === 'summarize' || type === 'retry' || type === 'redo') {
            if (jobs.has(key)) return false;
            state.error = ''; emit(); deferFor(binding, () => start({ force: true, entryId: type === 'redo' ? payload.entryId : null }), actionGeneration); return true;
        }
        if (type === 'summarizeRange') {
            if (jobs.has(key)) return false;
            const plan = planManualRange(doc, snapshot.messages, effectiveSettings(doc, state.defaults), payload.range);
            if (payload.expectedRange?.start !== plan.range.start || payload.expectedRange?.end !== plan.range.end) {
                throw new Error(`已有切片覆盖第 ${plan.range.start}—${plan.range.end} 层，请确认范围后开始`);
            }
            state.error = ''; emit();
            const range = clone(payload.range), expectedRange = clone(payload.expectedRange);
            deferFor(binding, () => start({ force: true, range, expectedRange }), actionGeneration);
            return true;
        }
        let operation = { id: id() };
        if (type === 'enable') {
            operation = { ...operation, type, enabled: payload.enabled, expectedRevision: payload.expectedRevision ?? doc.configRevision, range: payload.range };
        } else if (type === 'autoSummary' || type === 'history') {
            operation = { ...operation, type, expectedRevision: payload.expectedRevision ?? doc.configRevision,
                ...(type === 'autoSummary' ? { value: payload.value, range: payload.initialRange } : { range: payload.range }) };
        } else if (type === 'settings') {
            if (payload.values?.recall === false) jobs.get(key)?.abort();
            if (payload.global) {
                for (const job of jobs.values()) job.abort();
                state.busy = true; emit();
                const op = { id: id(), expectedRevision: payload.expectedRevision ?? state.defaults.revision, values: payload.values };
                try { const result = await api.defaults(op); adopt(binding, result); if (isCurrent(binding)) state.error = ''; return true; }
                catch (error) { if (isCurrent(binding)) state.error = error.message; throw error; }
                finally { if (isCurrent(binding)) { state.busy = false; emit(); } }
            }
            operation = { ...operation, type, expectedRevision: payload.expectedRevision ?? doc.configRevision, values: payload.values };
        } else if (type === 'manual') operation = { ...operation, type: 'append', entry: { id: id(), kind: 'manual', text: payload.text, source: null } };
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
                    : type === 'history' ? payload.range.end > 0 ? '准备整理历史楼层' : '' : '已保存';
                if (type === 'history' && payload.range.end > 0) deferFor(binding, () => start({ force: true, historyOnly: true }).catch(() => {}), actionGeneration);
                else if (type === 'enable' && payload.enabled || type === 'settings' || type === 'autoSummary' && payload.value) deferFor(binding, () => start().catch(() => {}), actionGeneration);
            }
            return true;
        } catch (error) { if (isCurrent(binding)) state.error = error.message; throw error; }
        finally { if (isCurrent(binding)) { state.busy = false; emit(); } }
    }

    async function intercept(coreChat, contextSize, abort, type = '') {
        host.clear(); prepared = null;
        if (generationRefresh) {
            let timer;
            const ready = await Promise.race([generationRefresh.then(() => true, () => false), new Promise(resolve => { timer = setTimeout(() => resolve(false), 500); })]);
            clearTimeout(timer);
            if (!ready) return; // A slow storage read never holds normal generation hostage.
        }
        if (disposed || !state.document?.enabled || !state.sourceAvailable || !state.snapshot || localStops.has(bindingKey(state.snapshot.binding))) return;
        const ticket = generation;
        const doc = clone(state.document), defaults = clone(state.defaults);
        // Keep disabled/invalid authoritative stages in the document so their
        // automatic children cannot bypass a human revision during selection.
        for (const entry of doc.entries) if (state.invalidSourceIds.includes(entry.id) && entry.status === 'active') entry.status = 'invalid';
        try {
            const snapshot = await host.snapshot();
            if (!equalBinding(snapshot.binding, doc.binding)) return;
            const plan = await buildPlan(doc, defaults, snapshot, { countTokens, type });
            if (ticket !== generation || disposed || !state.document?.enabled || localStops.has(bindingKey(doc.binding)) || state.document?.epoch !== doc.epoch) return;
            const result = host.prepare(coreChat, plan, snapshot, type);
            if (result.prepared) prepared = { session: result.session, generation: ticket, binding: clone(doc.binding), revision: doc.revision, defaultsRevision: defaults.revision, epoch: doc.epoch,
                foreignIds: plan.entries.filter(entry => entry.origin).map(entry => entry.id) };
        } catch { host.clear(); /* Failure retains ST's unchanged original context. */ }
    }

    async function event(name, args = []) {
        if (disposed) return;
        if (name === 'GENERATION_STARTED') {
            if (args[2]) return;
            generation++; generating = true; prepared = null; state.lastUsed = null; host.clear();
            generationRefresh = refresh({ quiet: true, auto: false });
            return;
        }
        if (name === 'GENERATION_STOPPED' || name === 'GENERATION_ENDED') {
            generating = false; prepared = null; host.clear();
            if (state.snapshot?.binding) deferFor(state.snapshot.binding, () => refresh({ quiet: true, auto: true }));
            return;
        }
        if (name === 'GENERATE_AFTER_DATA') {
            if (args[1] || Array.isArray(args[0]?.prompt)) return; // ST also emits this intermediate event for chat completion.
            // Text/instruct payloads do not expose a reliable message boundary. Keep them untouched.
            if (prepared) { prepared = null; host.clear(); state.status = '当前请求不支持安全原文替换，本轮保留 ST 原上下文。'; emit(); }
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
                    || verified.defaults.revision !== pending.defaultsRevision || pending.foreignIds.some(id => verified.invalidSourceIds?.includes(id)
                        || verified.document.entries.find(entry => entry.id === id)?.originVerified !== true)) {
                    if (pending === prepared) { prepared = null; host.clear(); } return;
                }
            }
            const result = await host.applyPrepared(args[0], pending.session, { isCurrent: isCurrentRequest });
            if (!isCurrentRequest()) return;
            if (result.applied) {
                state.lastUsed = { entries: clone(result.entries), tokens: result.tokens, estimated: true, status: 'prepared',
                    sourceReplacement: result.removedFloors.length > 0, removedFloors: result.removedFloors, recentFloors: result.recentFloors,
                    requestTokens: result.requestTokens, contextTokens: result.contextTokens, responseTokens: result.responseTokens };
                prepared = null; emit();
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
            if (name === 'CHAT_CHANGED' || name === 'CHAT_LOADED' || name === 'CHAT_DELETED') { generation++; host.clear(); prepared = null; }
            clearTimeout(refreshTimer);
            refreshTimer = setTimeout(() => refresh({ quiet: true, auto: !generating }), 80);
        }
    }

    return {
        state, refresh, action, start, startStage, intercept, event,
        destroy() { disposed = true; sequence++; generation++; clearTimeout(refreshTimer); for (const job of jobs.values()) job.abort(); companionActions.destroy(); backupActions.destroy(); host.clear(); },
        async settled() { await refreshing; },
    };
}
