import { bindingKey, effectiveSettings, fingerprintMessages, sourceMatches } from './contract.mjs';
import { buildPlan, inspectSources, nextBatch, parseSummary, summaryPrompt } from './core.mjs';
import { nextStage, parseStage, stagePrompt } from './layers.mjs';
import { stageSourceFromParents } from './stage-contract.mjs';

const uniqueId = () => globalThis.crypto?.randomUUID?.() || `ym_${Date.now()}_${Math.random().toString(36).slice(2)}`;
const equalBinding = (a, b) => !!a && !!b && bindingKey(a) === bindingKey(b);
const clone = value => structuredClone(value);

/** Browser-lifetime coordinator, not a background server or a second source database. */
export function createController({ host, api, onChange = () => {}, countTokens = null, id = uniqueId, defer = fn => setTimeout(fn, 0) }) {
    const state = { loading: false, error: '', status: '', snapshot: null, document: null, defaults: null, busy: false, profiles: [], lastUsed: null, sourceAvailable: false, invalidSourceIds: [] };
    let sequence = 0, disposed = false, generation = 0, generating = false, prepared = null, refreshing = null;
    const jobs = new Map(), localStops = new Set(), failedJobs = new Set();
    let refreshTimer = null, generationRefresh = null;
    const emit = () => { if (!disposed) onChange({ ...state, paused: state.snapshot && localStops.has(bindingKey(state.snapshot.binding)) }); };
    const isCurrent = binding => equalBinding(state.snapshot?.binding, binding);
    const adopt = (binding, result) => {
        if (!disposed && isCurrent(binding)) {
            if (result.document && (!state.document || result.document.revision >= state.document.revision)) state.document = result.document;
            if (result.defaults && (!state.defaults || result.defaults.revision >= state.defaults.revision)) state.defaults = result.defaults;
            if (typeof result.sourceAvailable === 'boolean') state.sourceAvailable = result.sourceAvailable;
            if (Array.isArray(result.invalidSourceIds)) state.invalidSourceIds = result.invalidSourceIds;
            emit();
        }
    };

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

    async function refresh({ quiet = false, auto = false } = {}) {
        const ticket = ++sequence;
        if (!quiet) { state.loading = true; state.error = ''; emit(); }
        const task = (async () => {
            let identified = false;
            try {
                const snapshot = await host.snapshot();
                identified = true;
                if (ticket !== sequence || disposed) return;
                const switched = !equalBinding(snapshot.binding, state.snapshot?.binding);
                if (switched) {
                    host.clear(); prepared = null;
                    state.document = null; state.defaults = null; state.lastUsed = null; state.status = ''; state.error = ''; state.sourceAvailable = false; state.busy = false; state.invalidSourceIds = [];
                }
                state.snapshot = snapshot; state.profiles = host.profiles(); emit();
                await api.health();
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
                if (auto && !disposed) defer(() => start().catch(() => {}));
            } catch (error) {
                if (ticket !== sequence || disposed) return;
                if (!identified) {
                    state.snapshot = null; state.document = null; state.defaults = null; state.lastUsed = null;
                    state.busy = false; state.status = ''; state.invalidSourceIds = [];
                }
                host.clear(); prepared = null; state.sourceAvailable = false; state.error = error.message; state.loading = false; emit();
            }
        })();
        refreshing = task;
        try { await task; } finally { if (refreshing === task) refreshing = null; }
    }

    async function start({ force = false, entryId = null } = {}) {
        if (disposed || generating || !state.document?.enabled || !state.sourceAvailable || !state.snapshot) return;
        const binding = clone(state.snapshot.binding), key = bindingKey(binding);
        if (jobs.has(key) || localStops.has(key)) return;
        const doc = clone(state.document);
        const failedKey = `${key}:${doc.epoch}`;
        if (!force && failedJobs.has(failedKey)) return;
        failedJobs.delete(failedKey);
        const controller = new AbortController(); jobs.set(key, controller);
        let jobDocument = doc, snapshot = clone(state.snapshot);
        const defaults = clone(state.defaults);
        const settings = effectiveSettings(doc, defaults);
        // Batch size accounts for summary instructions/output and never truncates a source floor.
        if (!settings.profileId) settings.batch = Math.min(settings.batch, Math.max(256, Math.floor((snapshot.maxContext || 8192) * 0.45)));
        let processed = false;
        try {
            for (;;) {
                if (controller.signal.aborted || disposed || localStops.has(key)) break;
                const live = await host.snapshot().catch(() => null);
                if (live && equalBinding(live.binding, binding)) snapshot = live;
                const fresh = await api.read(binding);
                jobDocument = fresh.document; adopt(binding, fresh);
                if (!fresh.sourceAvailable || !jobDocument.enabled || jobDocument.epoch !== doc.epoch || fresh.defaults.revision !== defaults.revision) break;
                let batch;
                if (entryId) {
                    const entry = jobDocument.entries.find(e => e.id === entryId);
                    if (!entry?.source || entry.status === 'deleted') throw new Error('此条记忆没有可重新总结的来源');
                    batch = { start: entry.source.start, end: entry.source.end, redo: clone(entry) };
                    if (batch.end > snapshot.messages.length) throw new Error('对应原文楼层已不存在，请先处理来源变化');
                } else batch = nextBatch(jobDocument, snapshot.messages, settings, { force });
                if (!batch) break;
                const hashes = await fingerprintMessages(snapshot.messages);
                const frozenSource = { start: batch.start, end: batch.end, hashes: hashes.slice(batch.start - 1, batch.end) };
                if (isCurrent(binding)) { state.status = `正在整理第 ${batch.start}—${batch.end} 层`; emit(); }
                const response = await host.generate(summaryPrompt(snapshot.messages, batch, settings), { profileId: settings.profileId, model: settings.model, signal: controller.signal });
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
                if (entryId || !isCurrent(binding) || generating) break;
            }
            if (processed && isCurrent(binding) && !controller.signal.aborted) { state.status = '本轮整理已完成；有效记忆从下一次生成开始使用。'; emit(); }
        } catch (error) {
            if (!controller.signal.aborted && !disposed) {
                failedJobs.add(failedKey);
                if (isCurrent(binding)) { state.error = error.message; state.status = '本轮整理未完成；原文与已保存记忆保留。'; emit(); }
            }
        } finally {
            if (jobs.get(key) === controller) jobs.delete(key);
            if (!disposed && !controller.signal.aborted && !failedJobs.has(failedKey) && isCurrent(binding)) defer(() => startStage().catch(() => {}));
            emit();
        }
    }

    async function startStage({ force = false, start: first = 1, end: last = Infinity, entryId = null } = {}) {
        if (disposed || generating || !state.document?.enabled || !state.sourceAvailable || !state.snapshot) return;
        const binding = clone(state.snapshot.binding), key = bindingKey(binding);
        if (jobs.has(key) || localStops.has(key)) return;
        const initial = clone(state.document), defaults = clone(state.defaults);
        const settings = effectiveSettings(initial, defaults);
        if (!force && !settings.stageAuto) return;
        const failedKey = `${key}:${initial.epoch}:stage`;
        if (!force && failedJobs.has(failedKey)) return;
        failedJobs.delete(failedKey);
        const controller = new AbortController(); jobs.set(key, controller);
        let processed = false, cursor = first;
        try {
            for (;;) {
                if (disposed || controller.signal.aborted || generating || localStops.has(key)) break;
                const snapshot = await host.snapshot();
                if (!equalBinding(snapshot.binding, binding)) break;
                const fresh = await api.read(binding); adopt(binding, fresh);
                const document = clone(fresh.document);
                for (const entry of document.entries) if (fresh.invalidSourceIds?.includes(entry.id) && entry.status === 'active') entry.status = 'invalid';
                if (!fresh.sourceAvailable || !document.enabled || document.epoch !== initial.epoch || fresh.defaults.revision !== defaults.revision) break;
                const batchSettings = { ...settings };
                if (!settings.profileId) batchSettings.batch = Math.min(settings.batch, Math.max(256, Math.floor((snapshot.maxContext || 8192) * 0.45)));
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
                const response = await host.generate(stagePrompt(group.parents, settings), { profileId: settings.profileId, model: settings.model, signal: controller.signal });
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
        if (!state.snapshot || !state.document || !state.defaults) throw new Error('请先打开单人聊天并读取忆幕');
        const snapshot = await host.snapshot();
        if (!equalBinding(snapshot.binding, state.snapshot.binding)) { await refresh(); throw new Error('当前聊天已变化，请重新操作'); }
        const binding = clone(snapshot.binding), doc = clone(state.document), key = bindingKey(binding);
        if (type === 'stage' || type === 'redo' && doc.entries.find(e => e.id === payload.entryId)?.kind === 'stage') {
            if (jobs.has(key)) return false;
            state.error = ''; emit(); defer(() => startStage({ force: true, start: payload.start, end: payload.end, entryId: type === 'redo' ? payload.entryId : null })); return true;
        }
        if (type === 'summarize' || type === 'retry' || type === 'redo') {
            if (jobs.has(key)) return false;
            state.error = ''; emit(); defer(() => start({ force: true, entryId: type === 'redo' ? payload.entryId : null })); return true;
        }
        let operation = { id: id() };
        if (type === 'enable') {
            if (!payload.enabled) { localStops.add(key); jobs.get(key)?.abort(); host.clear(); prepared = null; state.lastUsed = null; }
            operation = { ...operation, type, enabled: payload.enabled, expectedRevision: payload.expectedRevision ?? doc.configRevision, range: payload.range };
        } else if (type === 'settings') {
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
                state.status = type === 'enable' ? payload.enabled ? '忆幕已为此聊天开启。' : '忆幕已关闭，记忆仍保留。' : '已保存';
                if (type === 'enable' && payload.enabled || type === 'settings') defer(() => start().catch(() => {}));
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
        doc.entries = doc.entries.filter(entry => !state.invalidSourceIds.includes(entry.id));
        try {
            const snapshot = await host.snapshot();
            if (!equalBinding(snapshot.binding, doc.binding)) return;
            const plan = await buildPlan(doc, defaults, snapshot, { countTokens, type });
            if (ticket !== generation || disposed || !state.document?.enabled || localStops.has(bindingKey(doc.binding)) || state.document?.epoch !== doc.epoch) return;
            const result = host.prepare(coreChat, plan, snapshot, type);
            if (result.prepared) prepared = { session: result.session, generation: ticket, binding: clone(doc.binding), revision: doc.revision, defaultsRevision: defaults.revision, epoch: doc.epoch };
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
            defer(() => refresh({ quiet: true, auto: true })); return;
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
        destroy() { disposed = true; sequence++; generation++; clearTimeout(refreshTimer); for (const job of jobs.values()) job.abort(); host.clear(); },
        async settled() { await refreshing; },
    };
}
