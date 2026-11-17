// Optional, explicit companion sharing. This bridge never owns or migrates a reader archive.
export const YIMU_COMPANION_KEY = Symbol.for('qianmu.yimu.companion.v1');
export const YIMU_COMPANION_READY = 'qianmu:yimu-companion-ready';
const text = value => typeof value === 'string' ? value.trim() : '';
const integer = value => Number.isSafeInteger(value) && value >= 0;
const fail = (code, message) => Object.assign(new Error(message), {code: `yimu_companion_${code}`});
const sameStory = (a, b) => !!a && !!b && ['avatar', 'file', 'integrity'].every(key => text(a[key]) && a[key] === b[key]);
const emptyUse = () => ({active: false, text: '', consumedSliceIds: []});
const clone = value => structuredClone(value);

async function fingerprint(value) {
    const bytes = new TextEncoder().encode(JSON.stringify(value));
    if (!globalThis.crypto?.subtle) throw fail('hash', '当前环境无法核对伴读快照，请使用安全连接');
    return [...new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes))].map(n => n.toString(16).padStart(2, '0')).join('');
}

function identity(item) {
    return [item.key, item.bookId, item.scope, item.persona, item.avatar];
}

/** getState returns a live settings owner plus metadata only; readRecord is called solely after consent. */
export function createYimuCompanionBridge({getState, resolveAccount, listKeys, readRecord, readDictionary = () => null, hash = fingerprint} = {}) {
    let mounted = null, epoch = 0, consumer = null, link = null;
    const accountName = async () => {
        try { return await resolveAccount(); }
        catch { throw fail('account', '尚未确认当前 ST 账户，请稍后重新读取伴读目录'); }
    };
    const requireState = () => {
        const state = getState();
        if (!state?.available || !state.owner || !state.coread) throw fail('unavailable', '千幕伴读当前不可用');
        return state;
    };
    async function capture() {
        const state = requireState(), owner = state.owner, coread = state.coread, ticket = epoch, account = await accountName();
        if (!/^st-user:[^\u0000-\u001f]+$/.test(account || '')) throw fail('account', '尚未确认当前 ST 账户');
        const check = async () => {
            const currentAccount = await accountName();
            const live = requireState();
            if (epoch !== ticket || live.owner !== owner || live.coread !== coread || currentAccount !== account) {
                throw fail('changed', '账户或伴读页面已变化，请重新选择');
            }
            return live;
        };
        await check(); return {state, account, check};
    }
    function catalog(state, keys) {
        const books = new Map();
        for (const book of [...(state.coread.books || []), ...(state.coread.retainedMemoryBooks || [])]) {
            if (text(book?.id) && !books.has(book.id)) books.set(book.id, book);
        }
        const sessions = new Map(), ambiguous = new Set();
        for (const session of state.coread.companionSessions || []) {
            if (!text(session?.scope) || !text(session?.avatar) || typeof session.userAvatar !== 'string') continue;
            const prior = sessions.get(session.scope);
            if (prior && (prior.avatar !== session.avatar || prior.userAvatar !== session.userAvatar)) ambiguous.add(session.scope);
            else sessions.set(session.scope, session);
        }
        const stored = new Set(keys.map(String)), items = [];
        for (const session of sessions.values()) for (const book of books.values()) {
            if (ambiguous.has(session.scope)) continue;
            const key = `${session.scope}::${book.id}`;
            if (!stored.has(key)) continue;
            const charName = text(state.characters?.find(item => item.avatar === session.avatar)?.name);
            const userName = text(state.personas?.find(item => item.key === session.userAvatar)?.name);
            if (!charName || !userName) continue;
            const boundary = state.boundaries?.[book.id];
            items.push({key, bookId: book.id, scope: session.scope, persona: session.userAvatar, avatar: session.avatar,
                title: text(book.title) || '未命名书籍', charName, userName,
                readTo: integer(boundary?.readTo) ? boundary.readTo : null, ownership: 'unverified'});
        }
        return items;
    }
    async function list() {
        const context = await capture(), keys = await listKeys();
        const state = await context.check();
        return {version: 1, account: context.account, items: catalog(state, Array.isArray(keys) ? keys : [])};
    }
    const word = value => typeof value === 'string' && !/[\u0000-\u001f]/.test(value) ? value.trim() : '';
    const unique = (list, min, limit) => [...new Set(list.map(word).filter(item => item.length >= min && item.length <= 40))].slice(0, limit);
    // Retrieval words the reader already keeps for a book slice; they let the story find it when the book comes up.
    function sliceKeywords(slice) {
        const list = Array.isArray(slice.keywords) ? [...slice.keywords] : [];
        if (slice.synonyms && typeof slice.synonyms === 'object' && !Array.isArray(slice.synonyms)) {
            for (const [canon, aliases] of Object.entries(slice.synonyms)) list.push(canon, ...(Array.isArray(aliases) ? aliases : []));
        }
        return unique(list, 1, 12);
    }
    // The title plus the bound dictionary's names that this book's shared memories actually use.
    function bookTerms(title, entries) {
        let dictionary = null;
        try { dictionary = readDictionary(); } catch { dictionary = null; }
        const body = entries.map(entry => `${entry.text}\n${entry.keywords.join('\n')}`).join('\n'), list = [title];
        for (const [canon, aliases] of Object.entries(dictionary && typeof dictionary === 'object' ? dictionary : {})) {
            const group = [canon, ...(Array.isArray(aliases) ? aliases : [])].map(word).filter(Boolean);
            if (group.some(item => item.length >= 2 && body.includes(item))) list.push(...group);
        }
        return unique(list, 2, 40);
    }
    // Consent-free core shared by the Yimu picker and the reader's own link/update flow.
    async function buildSnapshot(context, item, keys, {confirmedReadTo, readLabel = ''} = {}) {
        const record = await readRecord(item.key);
        const state = await context.check(), current = catalog(state, keys).find(entry => entry.key === item.key);
        if (!current || JSON.stringify(identity(current)) !== JSON.stringify(identity(item))) throw fail('changed', '伴读归属已变化，请重新选择');
        if (!record || record.bookId !== item.bookId || !Array.isArray(record.slices)) throw fail('missing', '本机伴读档案不存在或尚未保存');
        let entries = []; const omitted = {future: 0, unknown: 0, mixed: 0}, ids = new Set();
        for (const slice of record.slices) {
            const p = slice?.provenance, kind = p?.source === 'book' || p?.source === 'dialog' ? p.source : null;
            if (p?.source === 'mixed' || Array.isArray(p?.sources) && p.sources.some(source => source !== kind)) { omitted.mixed++; continue; }
            if (!kind || !p || p.bookId !== item.bookId || p.bucket !== item.key || !integer(p.readTo)
                || !text(slice.id) || /^note:/.test(slice.id) || ids.has(slice.id) || !text(slice.summary)) { omitted.unknown++; continue; }
            if (p.readTo > confirmedReadTo) { omitted.future++; continue; }
            const source = {bookId: item.bookId, bucket: item.key, readTo: p.readTo};
            if (kind === 'book') {
                if (!integer(p.charFrom) || !integer(p.charTo) || p.charTo <= p.charFrom || p.charTo > p.readTo) { omitted.unknown++; continue; }
                if (slice.coveredTo != null && slice.coveredTo !== p.charTo) { omitted.unknown++; continue; }
                Object.assign(source, {charFrom: p.charFrom, charTo: p.charTo});
                for (const field of ['chapterFrom', 'chapterTo']) if (integer(p[field])) source[field] = p[field];
            } else {
                if (!integer(p.dialogFrom) || !integer(p.dialogTo) || p.dialogTo < p.dialogFrom
                    || !Array.isArray(p.dialogMessageIds) || p.dialogMessageIds.length !== p.dialogTo - p.dialogFrom + 1
                    || new Set(p.dialogMessageIds).size !== p.dialogMessageIds.length || p.dialogMessageIds.some(id => !text(id))) { omitted.unknown++; continue; }
                Object.assign(source, {dialogFrom: p.dialogFrom, dialogTo: p.dialogTo, dialogMessageIds: [...new Set(p.dialogMessageIds)]});
            }
            ids.add(slice.id);
            const entry = {id: slice.id, kind, text: slice.summary.trim(), readTo: p.readTo, keywords: kind === 'book' ? sliceKeywords(slice) : [], source};
            entry.hash = await hash(entry); entries.push(entry);
        }
        // A long book keeps what was read last; the earliest slices give way first.
        const size = list => list.reduce((sum, entry) => sum + entry.text.length, 0);
        if (entries.length > 200 || size(entries) > 200000) {
            const keep = new Set(), order = entries.map((entry, index) => ({entry, index})).sort((a, b) => b.entry.readTo - a.entry.readTo || b.index - a.index);
            let total = 0;
            for (const {entry} of order) { if (keep.size >= 200 || total + entry.text.length > 200000) break; keep.add(entry); total += entry.text.length; }
            omitted.overflow = entries.length - keep.size; entries = entries.filter(entry => keep.has(entry));
        }
        const meta = [...(state.coread.books || []), ...(state.coread.retainedMemoryBooks || [])].find(book => book?.id === item.bookId);
        const total = Number(meta?.charCount) || 0, live = state.boundaries?.[item.bookId];
        const label = word(readLabel).slice(0, 60) || (live?.readTo === confirmedReadTo && word(live.label).slice(0, 60))
            || (total > 0 ? `${Math.max(0, Math.min(100, Math.round(confirmedReadTo / total * 100)))}%` : '');
        const snapshot = {version: 2, account: context.account, ...item, confirmedReadTo, readLabel: label, terms: bookTerms(item.title, entries),
            evidence: 'user-confirmed-snapshot', entries, omitted};
        delete snapshot.readTo; delete snapshot.ownership;
        snapshot.hash = await hash(snapshot);
        await context.check(); return snapshot;
    }
    async function readSnapshot(request = {}) {
        if (request.confirmed !== true || !integer(request.confirmedReadTo)) throw fail('consent', '请先确认共同已读截止');
        if (request.confirmedLocalOwnership !== true) throw fail('ownership', '请确认这是我的本机伴读档案后再关联');
        const context = await capture(), keys = await listKeys();
        if (request.expectedAccount && request.expectedAccount !== context.account) throw fail('account', '账户已变化，请重新读取伴读目录');
        const item = catalog(await context.check(), Array.isArray(keys) ? keys : []).find(entry => entry.key === request.key);
        if (!item) throw fail('scope', '此伴读档案不属于当前书目、书友与人设范围');
        const snapshot = await buildSnapshot(context, item, keys, request);
        if (request.expectedHash && request.expectedHash !== snapshot.hash) throw fail('changed', '伴读摘要已变化，请重新预览并确认关联');
        return snapshot;
    }
    function setConsumer(fn) {
        if (typeof fn !== 'function') throw new TypeError('Companion consumer must be a function');
        consumer = fn; return () => clearConsumer(fn);
    }
    function clearConsumer(fn) { if (!fn || consumer === fn) consumer = null; }
    async function consume(selection = {}, purpose = 'companion', {query} = {}) {
        if (!consumer || purpose !== 'companion') return emptyUse();
        const callback = consumer;
        let timer, expired = false;
        const read = async () => {
            const context = await capture(), state = await context.check();
            if (expired) return emptyUse();
            const story = state.story ? clone(state.story) : null;
            if (!story || !sameStory(story, story)) return emptyUse();
            const item = catalog(state, [selection.key]).find(row => row.key === selection.key);
            if (!item || identity(item).some((value, index) => value !== identity(selection)[index])) return emptyUse();
            const result = await callback({version: 2, purpose, account: context.account, ...item, story: clone(story), query: String(query || '').slice(0, 2000)});
            const latest = await context.check();
            if (expired || callback !== consumer || !sameStory(story, latest.story)) return emptyUse();
            const current = catalog(latest, [item.key]).find(row => row.key === item.key);
            if (!current || JSON.stringify(identity(current)) !== JSON.stringify(identity(item))) return emptyUse();
            if (latest.currentKey !== item.key) return emptyUse();
            if (result?.active !== true) return emptyUse();
            return {active: true, text: text(result.text), consumedSliceIds: [...new Set((result.consumedSliceIds || []).filter(id => text(id)))]};
        };
        // Account resolution is part of the optional lookup too. A slow account
        // endpoint must not delay ordinary companion generation.
        try { return await Promise.race([read().catch(emptyUse), new Promise(resolve => {timer = setTimeout(() => {expired = true;resolve(emptyUse());}, 500);})]); }
        finally { clearTimeout(timer); }
    }
    // 忆幕 registers how to look up and change the open story's link. The reader
    // never writes a story document itself.
    function setLink(handlers) {
        if (!handlers || ['status', 'update', 'unlink'].some(name => typeof handlers[name] !== 'function')) throw new TypeError('Companion link handlers must be functions');
        link = handlers; return () => clearLink(handlers);
    }
    function clearLink(handlers) { if (!handlers || link === handlers) link = null; }
    // Same rule as consume: the exact book/companion/persona archive, and the story chat that is open right now.
    async function linkContext(selection) {
        const context = await capture(), state = await context.check();
        const story = state.story ? clone(state.story) : null;
        if (!story || !sameStory(story, story)) throw fail('story', '请先打开要关联的故事聊天');
        const item = catalog(state, [selection?.key]).find(row => row.key === selection?.key);
        if (!item || identity(item).some((value, index) => value !== identity(selection)[index])) throw fail('scope', '此伴读档案不属于当前书目、书友与人设范围');
        const still = async handlers => {
            const latest = await context.check();
            if (handlers !== link || !sameStory(story, latest.story)) throw fail('changed', '故事聊天已切换，请回到要关联的故事后再试');
        };
        const {readTo, ownership, ...owner} = item;
        return {context, item, still, payload: {version: 2, account: context.account, ...owner, story}};
    }
    const within = (work, ms) => {
        let timer;
        return Promise.race([work, new Promise((_, reject) => { timer = setTimeout(() => reject(fail('timeout', '忆幕没有回应，请稍后再试')), ms); })]).finally(() => clearTimeout(timer));
    };
    async function linkStatus(selection = {}) {
        const handlers = link;
        if (!handlers) return null;
        try {
            return await within((async () => {
                const {still, payload} = await linkContext(selection);
                const result = await handlers.status(payload);
                await still(handlers);
                if (!result || typeof result.linked !== 'boolean') return null;
                if (!result.linked) return {linked: false, confirmedReadTo: null, entryHashes: {}, readLabel: '', updatedAt: 0};
                return {linked: true, confirmedReadTo: integer(result.confirmedReadTo) ? result.confirmedReadTo : null,
                    entryHashes: {...(result.entryHashes || {})}, readLabel: text(result.readLabel), updatedAt: integer(result.updatedAt) ? result.updatedAt : 0};
            })(), 3000);
        } catch { return null; }
    }
    async function snapshot(selection = {}, {confirmedReadTo, readLabel = ''} = {}) {
        if (!integer(confirmedReadTo)) throw fail('consent', '请先确认共同已读截止');
        const {context, item} = await linkContext(selection);
        return buildSnapshot(context, item, [item.key], {confirmedReadTo, readLabel});
    }
    async function linkUpdate(selection = {}, {confirmedReadTo, readLabel = '', note = ''} = {}) {
        const handlers = link;
        if (!handlers) throw fail('unavailable', '忆幕当前不可用');
        if (!integer(confirmedReadTo)) throw fail('consent', '请先确认共同已读截止');
        const {context, item, still, payload} = await linkContext(selection);
        const value = await buildSnapshot(context, item, [item.key], {confirmedReadTo, readLabel});
        await still(handlers);
        // The reader's single confirmation dialog is the ownership and read-range consent.
        const result = await within(Promise.resolve(handlers.update(payload, {snapshot: value, note: text(note).slice(0, 200), confirmed: true, confirmedLocalOwnership: true})), 20000);
        if (result?.linked !== true) throw fail('unconfirmed', '关联尚未确认');
        return {linked: true, readLabel: value.readLabel, entries: value.entries.length};
    }
    async function unlink(selection = {}) {
        const handlers = link;
        if (!handlers) throw fail('unavailable', '忆幕当前不可用');
        const {still, payload} = await linkContext(selection);
        await still(handlers);
        const result = await within(Promise.resolve(handlers.unlink(payload)), 20000);
        if (result?.linked !== false) throw fail('unconfirmed', '解除尚未确认');
        return {linked: false};
    }
    const api = Object.freeze({version: 2, list, readSnapshot, setConsumer, clearConsumer, setLink, clearLink});
    return Object.freeze({api, consume, linkAvailable: () => !!link, linkStatus, snapshot, linkUpdate, unlink,
        mount(target = globalThis) {
            if (target[YIMU_COMPANION_KEY] && target[YIMU_COMPANION_KEY] !== api) return false;
            mounted = target; target[YIMU_COMPANION_KEY] = api;
            if (typeof target.dispatchEvent === 'function' && typeof target.Event === 'function') target.dispatchEvent(new target.Event(YIMU_COMPANION_READY));
            return true;
        },
        unmount() { epoch++; consumer = null; link = null; if (mounted?.[YIMU_COMPANION_KEY] === api) delete mounted[YIMU_COMPANION_KEY]; mounted = null; },
    });
}

/** 「第12章 · 37%」; comics count pages. Empty when the position is unknown. */
export function formatReadLabel({chapterIndex, progress, comic = false} = {}) {
    const parts = [];
    if (integer(chapterIndex)) parts.push(`第${chapterIndex + 1}${comic ? '页' : '章'}`);
    if (Number.isFinite(progress)) parts.push(`${Math.max(0, Math.min(100, Math.round(progress)))}%`);
    return parts.join(' · ');
}

export const LINK_TEXT = Object.freeze({
    updateTitle: '更新关联伴读', updateOk: '更新', updateCancel: '先不用', notePlaceholder: '这次发生了什么（可不填）',
    updated: '已更新到当前故事', updateFailed: '没更新成功，可稍后在忆幕里更新',
    linkTitle: '关联伴读', linkOk: '关联', linkCancel: '取消',
    linked: '已关联。之后读了新内容，关闭阅读器时会问你要不要更新。', linkFailed: '没关联成功，请稍后再试',
    noStory: '请先打开要关联的故事聊天', nothing: '这本书还没有可关联的共读记忆',
});
const fresh = (value, status) => value.entries.filter(entry => status.entryHashes[entry.id] !== entry.hash).length;

/**
 * Offer to bring newly made reading memories into the linked story. captured is
 * taken before the reader closes: {selection, confirmedReadTo, readLabel}.
 * Asks at most once, and only when a slice is new or changed (always: ask anyway).
 */
export async function offerLinkUpdate(bridge, captured, {ask, notify = () => {}, always = false, status = null} = {}) {
    const {selection} = captured || {};
    if (!selection || !integer(captured.confirmedReadTo)) return 'skipped';
    const known = status || await bridge.linkStatus(selection);
    if (!known?.linked) return 'unlinked';
    // Leafing back to an earlier page never takes already shared memories away from the story.
    const back = integer(known.confirmedReadTo) && known.confirmedReadTo > captured.confirmedReadTo;
    const confirmedReadTo = back ? known.confirmedReadTo : captured.confirmedReadTo, readLabel = back ? known.readLabel : captured.readLabel || '';
    let value;
    try { value = await bridge.snapshot(selection, {confirmedReadTo, readLabel}); }
    catch (error) { if (always) notify(error?.code === 'yimu_companion_missing' ? LINK_TEXT.nothing : LINK_TEXT.updateFailed, 'warning'); return 'unreadable'; }
    const count = fresh(value, known);
    if (!count && !always) return 'unchanged';
    const where = value.readLabel || '当前位置';
    const note = await ask({title: LINK_TEXT.updateTitle, okButton: LINK_TEXT.updateOk, cancelButton: LINK_TEXT.updateCancel, placeholder: LINK_TEXT.notePlaceholder,
        body: count ? `这次读到 ${where}，多了 ${count} 条共读记忆。要更新到当前故事吗？` : `这次读到 ${where}。要更新到当前故事吗？`});
    if (note == null) return 'declined';
    try { await bridge.linkUpdate(selection, {confirmedReadTo, readLabel: value.readLabel, note}); }
    catch { notify(LINK_TEXT.updateFailed, 'warning'); return 'failed'; }
    notify(LINK_TEXT.updated, 'success'); return 'updated';
}

/** The reader centre's 「关联伴读」 button: link the open book, or update it when it is linked already. */
export async function runLink(bridge, captured, {ask, confirm, notify = () => {}} = {}) {
    const {selection, confirmedReadTo, readLabel = ''} = captured || {};
    if (!selection || !integer(confirmedReadTo)) { notify(LINK_TEXT.nothing, 'info'); return 'skipped'; }
    const status = await bridge.linkStatus(selection);
    if (!status) { notify(LINK_TEXT.noStory, 'info'); return 'unavailable'; }
    if (status.linked) return offerLinkUpdate(bridge, captured, {ask, notify, always: true, status});
    let value;
    try { value = await bridge.snapshot(selection, {confirmedReadTo, readLabel}); }
    catch { notify(LINK_TEXT.nothing, 'info'); return 'unreadable'; }
    if (!value.entries.length) { notify(LINK_TEXT.nothing, 'info'); return 'unreadable'; }
    const agreed = await confirm({title: LINK_TEXT.linkTitle, okButton: LINK_TEXT.linkOk, cancelButton: LINK_TEXT.linkCancel,
        body: `把《${value.title}》读到 ${value.readLabel || '当前位置'} 的共读记忆关联到当前故事？`});
    if (!agreed) return 'declined';
    try { await bridge.linkUpdate(selection, {confirmedReadTo, readLabel: value.readLabel, note: ''}); }
    catch (error) { notify(/最多关联|过多/.test(error?.message || '') ? error.message : LINK_TEXT.linkFailed, 'warning'); return 'failed'; }
    notify(LINK_TEXT.linked, 'success'); return 'linked';
}
