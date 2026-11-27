import { bindingKey, fingerprintMessages } from './contract.mjs';
import { validateCompanion, validateBookSnapshot, mergeCompanionBook, removeCompanionBook, linkedBook, sameCompanionContext } from './companion-contract.mjs';
import { memoryMessage, byteBudget, sourceRanges } from './budget.mjs';
import { buildPlan, filterCompanionEntries, renderMemoryPrompt } from './core.mjs';

export const COMPANION_BRIDGE = Symbol.for('qianmu.yimu.companion.v1');
export const COMPANION_BRIDGE_VERSION = 2;
export const COMPANION_READY = 'qianmu:yimu-companion-ready';
export function createCompanionActions({ state, api, change, emit, lifecycle, bridge = () => globalThis[COMPANION_BRIDGE], id, now = () => Date.now() }) {
    let attached = null, destroyed = false, linking = false;
    const empty = () => ({active: false, text: '', consumedSliceIds: []});
    const linkedMessage = entries => ({role: 'system', content: `以下是用户明确关联的故事资料，不代表书中人物知道它，也不把书中事件当作亲历。\n${memoryMessage(entries).content}`});
    const consume = async context => {
        if (destroyed || lifecycle().disposed || lifecycle().paused || !state.document?.enabled || !state.sourceAvailable
            || context?.purpose !== 'companion'
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
            || !current()) return empty();
        const book = linkedBook(fresh.document.companion, context, binding);
        if (!book) return empty();
        const consumedSliceIds = book.entries.filter(entry => entry.kind !== 'note').map(entry => entry.id);
        const invalid = new Set(fresh.invalidSourceIds || []), entries = [];
        const sourceDocument = structuredClone(fresh.document);
        // The story's reading memories came from the reader; they are never sent back to it.
        sourceDocument.companion = null;
        // Preserve authoritative stages even when invalid. Removing their records
        // here would expose automatic children whose meaning the user overrode.
        for (const entry of sourceDocument.entries) if (invalid.has(entry.id) && entry.status === 'active') entry.status = 'invalid';
        // The companion's own question decides which story memories are relevant.
        const plan = await buildPlan(sourceDocument, fresh.defaults, snapshot, { queryText: typeof context.query === 'string' ? context.query.slice(0, 2000) : '' });
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
    // 千幕幕外「联动忆幕」：只读当前打开的故事聊天的记忆，选法与生成前注入正文时相同（同一份设置、同一个预算）。
    // excludeFrom：千幕自己带上的参考楼层从第几层起；与这些楼层有重叠的切片不带，以那几层的原文为准。不写入任何东西。
    const story = async context => {
        if (destroyed || lifecycle().disposed || lifecycle().paused || !state.document?.enabled || !state.sourceAvailable || !state.snapshot?.binding) return empty();
        const binding = structuredClone(state.snapshot.binding), snapshot = structuredClone(state.snapshot);
        if (state.document.movedTo || bindingKey(state.document.binding) !== bindingKey(binding)) return empty();
        let timer;
        const fresh = await Promise.race([Promise.resolve().then(() => api.read(binding)).catch(() => null), new Promise(resolve => {timer = setTimeout(() => resolve(null), 2000);})]);
        clearTimeout(timer);
        if (!fresh?.sourceAvailable || !fresh.document.enabled || fresh.document.movedTo || bindingKey(fresh.document.binding) !== bindingKey(binding)) return empty();
        if (!state.snapshot || bindingKey(state.snapshot.binding) !== bindingKey(binding)) return empty();
        const document = structuredClone(fresh.document), invalid = new Set(fresh.invalidSourceIds || []);
        for (const entry of document.entries) if (invalid.has(entry.id) && entry.status === 'active') entry.status = 'invalid';
        const plan = await buildPlan(document, fresh.defaults, snapshot, { queryText: typeof context.query === 'string' ? context.query.slice(0, 2000) : '' });
        const from = Number.isInteger(context.excludeFrom) && context.excludeFrom > 0 ? context.excludeFrom : Infinity;
        const overlaps = entry => sourceRanges(entry).some(range => range.end >= from);
        const kept = [];
        for (const entry of plan.entries) {
            if (entry.kind === 'excerpt') { if (kept.some(parent => parent.id === entry.parent?.id)) kept.push(entry); continue; }
            if (!entry.origin && overlaps(entry)) continue;
            kept.push(entry);
        }
        return { active: true, text: kept.length ? renderMemoryPrompt(kept, { entryOrder: document.entryOrder }) : '', consumedSliceIds: [] };
    };
    // Bound the entire optional read/selection step, not only its server read.
    // A late result has no write or publication path after the caller continues.
    const consumer = async context => {
        let timer;
        const work = context?.purpose === 'story' ? story(context) : consume(context);
        try { return await Promise.race([work.catch(empty), new Promise(resolve => {timer = setTimeout(() => resolve(empty()), context?.purpose === 'story' ? 3000 : 500);})]); }
        finally { clearTimeout(timer); }
    };
    // Only Yimu knows where in the story a reading memory belongs: the last floor at this moment.
    const anchorNow = async () => {
        const messages = state.snapshot?.messages || [];
        return messages.length ? { floor: messages.length, hash: (await fingerprintMessages(messages)).at(-1) } : null;
    };
    const noteHash = async (key, text) => (await fingerprintMessages([{ name: 'companion-note', mes: JSON.stringify([key, text]) }]))[0];
    const confirmed = (result, next) => next ? !!result?.document?.companion && JSON.stringify(validateCompanion(result.document.companion)) === JSON.stringify(next)
        : !!result?.document && result.document.companion == null;
    async function store(binding, expectedRevision, value, note = '') {
        const said = typeof note === 'string' ? note.trim().slice(0, 200) : '';
        const next = mergeCompanionBook(state.document.companion, value, { anchor: await anchorNow(), now: now(),
            note: said ? { text: said, hash: await noteHash(value.key, said) } : null });
        return { next, result: await change(binding, { id: id(), type: 'companion', action: 'set', expectedRevision, snapshot: next }) };
    }
    async function remove(binding, key) {
        const next = key ? removeCompanionBook(state.document.companion, key) : null;
        const result = await change(binding, next ? { id: id(), type: 'companion', action: 'set', expectedRevision: state.document.revision, snapshot: next }
            : { id: id(), type: 'companion', action: 'clear', expectedRevision: state.document.revision });
        return { next, result };
    }
    // The reader may look up or change a link only for the story chat Yimu has open.
    const storyOpen = context => !destroyed && !lifecycle().disposed && !!state.document && !state.document.movedTo && !!state.snapshot?.binding
        && !!context?.story && ['avatar', 'file', 'integrity'].every(key => typeof context.story[key] === 'string' && context.story[key] === state.snapshot.binding[key])
        && bindingKey(state.document.binding) === bindingKey(state.snapshot.binding);
    const exclusive = async work => {
        if (linking) throw new Error('正在更新关联，请稍候');
        linking = true;
        try { return await work(); } finally { linking = false; if (!destroyed) emit(); }
    };
    const linkHandlers = {
        status(context) {
            if (!storyOpen(context)) return null;
            const book = linkedBook(state.document.companion, context, state.snapshot.binding);
            if (!book) return { linked: false };
            return { linked: true, confirmedReadTo: book.confirmedReadTo, readLabel: book.readLabel, updatedAt: book.updatedAt,
                entryHashes: Object.fromEntries(book.entries.filter(entry => entry.kind !== 'note').map(entry => [entry.id, entry.hash])) };
        },
        update: (context, payload = {}) => exclusive(async () => {
            if (!storyOpen(context)) throw new Error('请先打开要关联的故事聊天');
            if (payload.confirmed !== true || payload.confirmedLocalOwnership !== true) throw new Error('请先确认要关联的共读记忆');
            const binding = structuredClone(state.snapshot.binding), value = validateBookSnapshot(payload.snapshot);
            if (value.account !== context.account || ['key', 'bookId', 'scope', 'persona', 'avatar'].some(field => value[field] !== context[field])) throw new Error('伴读账户或记录归属不一致');
            const { next, result } = await store(binding, state.document.revision, value, payload.note);
            if (!confirmed(result, next)) throw new Error('关联保存尚未确认');
            if (state.companion) state.companion.preview = null;
            return { linked: true };
        }),
        unlink: context => exclusive(async () => {
            if (!storyOpen(context)) throw new Error('请先打开要关联的故事聊天');
            if (!linkedBook(state.document.companion, context, state.snapshot.binding)) return { linked: false };
            const { next, result } = await remove(structuredClone(state.snapshot.binding), context.key);
            if (!confirmed(result, next)) throw new Error('解除结果尚未确认');
            return { linked: false };
        }),
    };
    function detach() { attached?.clearConsumer?.(consumer); attached?.clearLink?.(linkHandlers); attached = null; }
    function connect() {
        const current = bridge();
        if (destroyed || current === attached) return;
        detach();
        // An older Qianmu (version 1) cannot carry several books; stay unattached so neither side shows a half-working entry.
        if (current?.version === COMPANION_BRIDGE_VERSION && ['setConsumer', 'readSnapshot', 'list', 'setLink'].every(name => typeof current[name] === 'function')) {
            attached = current; attached.setConsumer(consumer); attached.setLink(linkHandlers);
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
                view.pick = typeof payload?.key === 'string' ? payload.key : '';
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
                view.preview = validateBookSnapshot(preview); view.query = query;
                view.expectedRevision = state.document.revision;
            } else if (type === 'companionSave') {
                if (!view.preview || !view.query) throw new Error('请先预览并确认要关联的伴读摘要');
                const checked = validateBookSnapshot(await attached.readSnapshot({...view.query, expectedHash: view.preview.hash}));
                if (!current()) return;
                if (JSON.stringify(checked) !== JSON.stringify(view.preview)) throw new Error('伴读摘要已变化，请重新预览后确认');
                const { next, result } = await store(binding, view.expectedRevision, checked);
                if (!current()) return;
                if (!confirmed(result, next)) throw new Error('关联保存尚未确认，请保留预览并刷新核对');
                view.preview = null; view.list = null; view.status = '已关联。之后读了新内容，关闭阅读器时会问你要不要更新。';
            } else if (type === 'companionClear') {
                const { next, result } = await remove(binding, typeof payload?.key === 'string' ? payload.key : '');
                if (!current()) return;
                if (!confirmed(result, next)) throw new Error('解除结果尚未确认，请刷新核对');
                view.preview = null; view.status = next ? '已解除这本书的关联，原伴读档案未改变。' : '已解除此聊天的伴读关联，原伴读档案未改变。';
            } else throw new Error('未知的伴读关联操作');
            return true;
        } catch (error) { if (current()) view.error = error.message; throw error; }
        finally { view.busy = false; if (current()) emit(); }
    }
    return { action, connect, destroy() { destroyed = true; detach(); } };
}
