import { bindingKey, effectiveSettings, fingerprintMessages } from './contract.mjs';
import { parseSummary, summaryPrompt } from './core.mjs';
import { recallFits } from './recall.mjs';

export async function storyFingerprint(messages) {
    const hashes = await fingerprintMessages(messages);
    const subtle = globalThis.crypto?.subtle ?? (await import('node:crypto')).webcrypto.subtle;
    const bytes = await subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(hashes)));
    return Array.from(new Uint8Array(bytes), value => value.toString(16).padStart(2, '0')).join('');
}

export function createStoryActions({ state, host, api, emit, id, lifecycle, refresh }) {
    const records = new Map();
    const recordFor = binding => {
        const key = bindingKey(binding);
        if (!records.has(key)) records.set(key, {view: {}, pending: null});
        return records.get(key);
    };
    const same = (a, b) => !!a && !!b && bindingKey(a) === bindingKey(b);
    const assertLifecycle = (snapshot, stamp) => {
        const life = lifecycle();
        if (life.disposed || life.generating || life.generation !== stamp || !same(snapshot.binding, state.snapshot?.binding)) throw new Error('当前聊天或生成状态已变化，未继续建立故事');
    };
    const assertCurrent = async (snapshot, stamp) => {
        assertLifecycle(snapshot, stamp);
        const current = await host.snapshot();
        assertLifecycle(snapshot, stamp);
        // This guard compares two local snapshots, not the canonical disk proof.
        // Keep it synchronous after the final lifecycle check so a generation
        // starting during an asynchronous fingerprint cannot slip through.
        if (!same(snapshot.binding, current.binding) || JSON.stringify(current.messages) !== JSON.stringify(snapshot.messages)) throw new Error('当前原文已变化，请重新核对续接范围');
        return current;
    };
    const action = async function storyAction(type, payload = {}) {
        const snapshot = structuredClone(await host.snapshot()), stamp = lifecycle().generation;
        const record = recordFor(snapshot.binding), view = record.view;
        if (view.busy) return false;
        state.story = view;
        view.busy = true; view.error = ''; emit();
        try {
            if (type === 'storyPlan') {
                if (record.pending) throw new Error('上次建立结果尚未确认，请先继续本次建立以核对结果');
                view.result = null; view.receipt = null; view.plan = null;
                await assertCurrent(snapshot, stamp);
                const plan = await api.planStory(snapshot.binding, payload);
                await assertCurrent(snapshot, stamp);
                if (plan.sourceFingerprint !== await storyFingerprint(snapshot.messages)) throw new Error('当前正文尚未完整保存到 ST，请保存后重新核对范围');
                await assertCurrent(snapshot, stamp);
                view.plan = plan; view.status = ''; return plan;
            }
            if (type === 'storyOpen') {
                if (!view.result?.receipt) throw new Error('尚无可确认的新聊天');
                const transferNote = view.result.transferNote;
                const opened = await host.openStory(view.result, { sourceSnapshot: snapshot,
                    isCurrent: () => !lifecycle().disposed && !lifecycle().generating && lifecycle().generation === stamp });
                view.status = opened.opened ? '已打开新故事。' : opened.message;
                if (opened.opened) await refresh({ auto: false });
                return {...opened, ...(transferNote ? {transferNote} : {})};
            }
            if (type !== 'storyCreate' || !view.plan) throw new Error('请先核对续接或分支范围');
            const plan = view.plan;
            if (!same(plan.sourceBinding, snapshot.binding)) throw new Error('来源聊天已变化，请重新核对范围');
            await assertCurrent(snapshot, stamp);
            if (payload.retry && !record.pending) throw new Error('没有需要继续核对的建立操作，请重新核对范围');
            if (record.pending && !payload.retry && JSON.stringify(record.pending.choices) !== JSON.stringify(payload.manualChoices || [])) throw new Error('上次创建结果尚未确认，请先用原选择重试核对');
            if (!record.pending) {
                if (plan.sourceFingerprint !== await storyFingerprint(snapshot.messages) || plan.sourceRevision !== state.document?.revision
                    || plan.defaultsRevision !== state.defaults?.revision) throw new Error('原文、记忆或设置已变化，请重新核对继承范围');
                await assertCurrent(snapshot, stamp);
                const settings = effectiveSettings(state.document, state.defaults), summaries = [];
                const connection = typeof host.summaryConnection === 'function' ? host.summaryConnection(settings) : null;
                if (plan.boundaries?.length) {
                    if (typeof host.confirmStoryBoundary !== 'function') throw new Error('当前环境无法确认续接的总结调用，未调用 API');
                    const approved = await host.confirmStoryBoundary({ranges: plan.boundaries.map(boundary => ({start: boundary.source.start, end: boundary.source.end}))});
                    if (approved !== true) { view.plan = null; view.status = ''; return {cancelled: true}; }
                    await assertCurrent(snapshot, stamp);
                    if (plan.sourceRevision !== state.document?.revision || plan.defaultsRevision !== state.defaults?.revision
                        || connection && JSON.stringify(connection) !== JSON.stringify(host.summaryConnection(settings))) {
                        throw new Error('确认期间记忆或总结连接已变化，请重新建立以核对范围');
                    }
                }
                const budgetSettings = connection ? {...settings, profileId: connection.mode === 'profile' ? connection.profileId : ''} : settings;
                const budgetSnapshot = connection ? {...snapshot, maxContext: connection.contextTokens, maxResponse: connection.maxTokens} : snapshot;
                for (const boundary of plan.boundaries || []) {
                    const batch = { start: boundary.source.start, end: boundary.source.end };
                    const messages = Array.from({ length: batch.end }, () => ({}));
                    for (const message of boundary.messages) messages[message.floor - 1] = message;
                    const prompt = summaryPrompt(messages, batch, settings);
                    if (!recallFits(prompt, budgetSettings, budgetSnapshot)) throw new Error('截止处原文超出当前整理容量，请调整忆幕连接或选择更早的完整记忆边界');
                    view.status = `正在整理截止处第 ${batch.start}—${batch.end} 层；不会读取后续剧情。`; emit();
                    await assertCurrent(snapshot, stamp);
                    const response = await host.generate(prompt, { profileId: settings.profileId, model: settings.model, ...(connection ? {connection} : {}) });
                    await assertCurrent(snapshot, stamp);
                    const hashes = Array(batch.start - 1).fill(''); hashes.push(...boundary.source.hashes);
                    summaries.push({ id: boundary.id, entries: parseSummary(response, batch, hashes, settings) });
                }
                record.pending = { choices: structuredClone(payload.manualChoices || []), operation: { id: id(), planId: plan.planId,
                    mode: plan.mode, cutoff: plan.cutoff, manualChoices: payload.manualChoices || [], boundarySummaries: summaries } };
                view.pending = true;
            }
            let result;
            const releaseFailed = failed => {
                if (failed?.status !== 'failed' && failed?.receipt?.status !== 'failed') return false;
                record.pending = null; view.pending = false; view.plan = null;
                view.result = null; view.receipt = null; view.status = '';
                return true;
            };
            try { result = await api.createStory(snapshot.binding, record.pending.operation); }
            catch (error) {
                const found = await api.storyResult(snapshot.binding, { id: record.pending.operation.id }).catch(() => null);
                if (found?.status === 'complete' || found?.receipt?.status === 'complete') result = found;
                else if (releaseFailed(found)) throw new Error(found.message || '本次建立已确认失败，请重新核对继承范围；原聊天保持不变');
                else {
                    // Only an explicit rejection plus a server-confirmed absence
                    // releases the operation. Timeouts/unknown outcomes keep its ID.
                    if (Number.isInteger(error.status) && error.status >= 400 && error.status < 500 && found?.status === 'missing') {
                        record.pending = null; view.pending = false; view.plan = null;
                    }
                    throw error;
                }
            }
            if (releaseFailed(result)) throw new Error(result.message || '本次建立已确认失败，请重新核对继承范围；原聊天保持不变');
            if (result?.receipt?.status !== 'complete') throw new Error('新故事尚未完整建立；请用同一次操作重试，不会重复创建');
            const skipped = plan.skippedManualCount || 0, missing = plan.unrepresentedFloorCount || 0;
            const omitted = [skipped ? `${skipped} 份人工记忆` : '', missing ? `${missing} 层较早正文` : ''].filter(Boolean);
            const transferNote = omitted.length ? `${omitted.join('、')}留在原聊天` : '';
            view.result = {...result, ...(transferNote ? {transferNote} : {})}; view.receipt = result.receipt; record.pending = null; view.pending = false;
            const detail = transferNote ? `；${transferNote}` : '';
            view.status = `已建立新聊天：${result.receipt.target?.file || result.binding?.file}${detail}`;
            let openResult = null;
            if (same(snapshot.binding, state.snapshot?.binding) && !lifecycle().generating && lifecycle().generation === stamp) {
                const opened = await host.openStory(result, { sourceSnapshot: snapshot,
                    isCurrent: () => !lifecycle().disposed && !lifecycle().generating && lifecycle().generation === stamp });
                openResult = opened;
                if (opened.opened) { view.status = `已建立并打开新故事，原聊天保持不变。${detail}`; await refresh({ auto: false }); }
                else view.status += `；${opened.message || '请从此角色聊天记录打开。'}`;
            }
            return {...view.result, ...(openResult ? {openResult} : {})};
        } catch (error) { view.error = error.message; throw error; }
        finally { view.busy = false; emit(); }
    };
    const direct = async (type, payload = {}) => {
        if (type === 'storyContinue') {
            await action('storyPlan', {cutoff:payload.cutoff});
            return action('storyCreate', {manualChoices:[]});
        }
        return action(type, payload);
    };
    direct.forBinding = binding => recordFor(binding).view;
    return direct;
}
