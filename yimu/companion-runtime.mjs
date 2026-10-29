import { bindingKey } from './contract.mjs';
import { validateCompanion, sameCompanionContext } from './companion-contract.mjs';
import { memoryMessage, byteBudget } from './budget.mjs';
import { buildPlan, filterCompanionEntries } from './core.mjs';

export const COMPANION_BRIDGE = Symbol.for('qianmu.yimu.companion.v1');
export const COMPANION_READY = 'qianmu:yimu-companion-ready';
export function createCompanionActions({ state, api, change, emit, lifecycle, bridge = () => globalThis[COMPANION_BRIDGE], id }) {
    let attached = null, destroyed = false;
    const empty = () => ({active: false, text: '', consumedSliceIds: []});
    const linkedMessage = entries => ({role: 'system', content: `以下是用户明确关联的故事资料，不代表书中人物知道它，也不把书中事件当作亲历。\n${memoryMessage(entries).content}`});
    const consume = async context => {
        if (destroyed || lifecycle().disposed || lifecycle().paused || !state.document?.enabled || !state.sourceAvailable
            || !['companion', 'mainline'].includes(context?.purpose)
            || !sameCompanionContext(state.document.companion, context, state.snapshot?.binding)) return empty();
        const binding = structuredClone(state.snapshot.binding), expected = state.document.revision;
        if (state.document.movedTo || bindingKey(state.document.binding) !== bindingKey(binding)) return empty();
        const snapshot = structuredClone(state.snapshot), owner = attached;
        const current = () => !destroyed && !lifecycle().disposed && !lifecycle().paused && attached === owner && state.sourceAvailable
            && state.document?.enabled && state.document.revision === expected && state.snapshot && bindingKey(binding) === bindingKey(state.snapshot.binding)
            && sameCompanionContext(state.document.companion, context, binding);
        // An explicit active association is required in both directions. A
        // different story/branch never borrows a similarly named companion.
        let timer;
        const fresh = await Promise.race([Promise.resolve().then(() => api.read(binding)).catch(() => null), new Promise(resolve => {timer = setTimeout(() => resolve(null), 500);})]);
        clearTimeout(timer);
        if (!fresh?.sourceAvailable || !fresh.document.enabled || fresh.document.movedTo || fresh.document.revision !== expected
            || bindingKey(fresh.document.binding) !== bindingKey(binding)
            || !current() || !sameCompanionContext(fresh.document.companion, context, binding)) return empty();
        const consumedSliceIds = fresh.document.companion.entries.map(entry => entry.id);
        // Mainline uses this callback only to avoid a second copy from the old
        // companion injector. Do not send story text back for that purpose.
        if (context.purpose === 'mainline') return {active: true, text: '', consumedSliceIds};
        const invalid = new Set(fresh.invalidSourceIds || []), entries = [];
        const sourceDocument = structuredClone(fresh.document);
        sourceDocument.companion = null;
        // Preserve authoritative stages even when invalid. Removing their records
        // here would expose automatic children whose meaning the user overrode.
        for (const entry of sourceDocument.entries) if (invalid.has(entry.id) && entry.status === 'active') entry.status = 'invalid';
        const plan = await buildPlan(sourceDocument, fresh.defaults, snapshot);
        const shareCustom = Object.hasOwn(fresh.document.settings || {}, 'companionShareCustom')
            ? fresh.document.settings.companionShareCustom === true
            : fresh.defaults?.values?.companionShareCustom === true;
        const shareable = filterCompanionEntries(plan.entries, sourceDocument, { includeCustom: shareCustom });
        // Use whole valid memories, not books or the story's unprocessed raw.
        for (const entry of shareable) {
            if (entry.kind === 'excerpt' && !entries.some(parent => parent.id === entry.parent.id
                || parent.kind === 'stage' && parent.source.parents.some(ref => ref.id === entry.parent.id))) continue;
            const next = [...entries, entry];
            if (byteBudget([linkedMessage(next)]) > 6000) continue;
            entries.push(entry);
        }
        if (!current()) return empty();
        return { active: true, text: entries.length ? linkedMessage(entries).content : '',
            consumedSliceIds };
    };
    // Bound the entire optional read/selection step, not only its server read.
    // A late result has no write or publication path after the caller continues.
    const consumer = async context => {
        let timer;
        try { return await Promise.race([consume(context).catch(empty), new Promise(resolve => {timer = setTimeout(() => resolve(empty()), 500);})]); }
        finally { clearTimeout(timer); }
    };
    function connect() {
        const current = bridge();
        if (destroyed || current === attached) return;
        attached?.clearConsumer?.(consumer); attached = null;
        if (current?.version === 1 && typeof current.setConsumer === 'function' && typeof current.readSnapshot === 'function' && typeof current.list === 'function') {
            attached = current; attached.setConsumer(consumer);
        }
    }
    async function action(type, payload = {}) {
        connect();
        // Clearing an account-backed snapshot needs no local companion archive
        // or Qianmu bridge, including on a different device.
        if (!attached && type !== 'companionClear') throw new Error('请先启用支持忆幕关联的千幕版本，并在伴读中打开要关联的书籍');
        if (destroyed || !state.snapshot?.binding || !state.document) throw new Error('请先读取当前聊天的忆幕');
        const binding = structuredClone(state.snapshot.binding), key = bindingKey(binding), owner = attached;
        const view = state.companion ||= {};
        if (view.busy) return false;
        const current = () => !destroyed && !lifecycle().disposed && state.companion === view && attached === owner
            && state.snapshot && bindingKey(state.snapshot.binding) === key;
        view.busy = true; view.error = ''; view.status = ''; emit();
        try {
            if (type === 'companionList') {
                const list = await attached.list();
                if (!current()) return;
                view.list = list; view.preview = null; view.query = null; view.omitted = null;
            } else if (type === 'companionPreview') {
                view.preview = null; view.query = null;
                const item = view.list?.items?.find(item => item.key === payload.key);
                if (!item || !view.list.account) throw new Error('请先选择当前账户的伴读记录');
                if (payload.confirmedLocalOwnership !== true || !Number.isSafeInteger(payload.confirmedReadTo) || payload.confirmedReadTo < 0) throw new Error('请先确认本机档案归属与共同已读截止');
                const query = { key: payload.key, confirmedReadTo: payload.confirmedReadTo, confirmed: true,
                    confirmedLocalOwnership: true, expectedAccount: view.list.account };
                const preview = await attached.readSnapshot(query);
                if (!current()) return;
                if (preview.account !== view.list.account || ['key','bookId','scope','persona','avatar'].some(field => preview[field] !== item[field])) throw new Error('账户或伴读归属已变化，请重新读取目录');
                view.omitted = preview.omitted;
                view.preview = validateCompanion({ ...preview, confirmed: true }); view.query = query;
                view.expectedRevision = state.document.revision;
            } else if (type === 'companionSave') {
                if (!view.preview || !view.query) throw new Error('请先预览并确认要关联的伴读摘要');
                const checked = validateCompanion({...await attached.readSnapshot({...view.query, expectedHash: view.preview.hash}), confirmed:true});
                if (!current()) return;
                if (JSON.stringify(checked) !== JSON.stringify(view.preview)) throw new Error('伴读摘要已变化，请重新预览后确认');
                const result = await change(binding, {id: id(), type: 'companion', action: 'set', expectedRevision: view.expectedRevision, snapshot: view.preview});
                if (!current()) return;
                if (!result?.document?.companion || JSON.stringify(validateCompanion(result.document.companion)) !== JSON.stringify(checked)) throw new Error('关联保存尚未确认，请保留预览并刷新核对');
                view.preview = null; view.status = '已关联本次确认的伴读摘要；后续阅读不会自动扩大范围。';
            } else if (type === 'companionClear') {
                const result = await change(binding, {id: id(), type: 'companion', action: 'clear', expectedRevision: state.document.revision});
                if (!current()) return;
                if (!result?.document || result.document.companion != null) throw new Error('解除结果尚未确认，请刷新核对');
                view.preview = null; view.status = '已解除此聊天的伴读关联，原伴读档案未改变。';
            } else throw new Error('未知的伴读关联操作');
            return true;
        } catch (error) { if (current()) view.error = error.message; throw error; }
        finally { view.busy = false; if (current()) emit(); }
    }
    return { action, connect, destroy() { destroyed = true; attached?.clearConsumer?.(consumer); attached = null; } };
}
