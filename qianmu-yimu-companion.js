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
export function createYimuCompanionBridge({getState, resolveAccount, listKeys, readRecord, hash = fingerprint} = {}) {
    let mounted = null, epoch = 0, consumer = null;
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
    async function readSnapshot(request = {}) {
        if (request.confirmed !== true || !integer(request.confirmedReadTo)) throw fail('consent', '请先确认共同已读截止');
        if (request.confirmedLocalOwnership !== true) throw fail('ownership', '请确认这是我的本机伴读档案后再关联');
        const context = await capture(), keys = await listKeys();
        if (request.expectedAccount && request.expectedAccount !== context.account) throw fail('account', '账户已变化，请重新读取伴读目录');
        const item = catalog(await context.check(), Array.isArray(keys) ? keys : []).find(entry => entry.key === request.key);
        if (!item) throw fail('scope', '此伴读档案不属于当前书目、书友与人设范围');
        const record = await readRecord(item.key);
        const current = catalog(await context.check(), keys).find(entry => entry.key === item.key);
        if (!current || JSON.stringify(identity(current)) !== JSON.stringify(identity(item))) throw fail('changed', '伴读归属已变化，请重新选择');
        if (!record || record.bookId !== item.bookId || !Array.isArray(record.slices)) throw fail('missing', '本机伴读档案不存在或尚未保存');
        if (record.companionOwner && record.companionOwner.account !== context.account) throw fail('account', '此本机档案属于其他账户，未读取关联内容');
        const entries = [], omitted = {future: 0, unknown: 0, mixed: 0}, ids = new Set();
        for (const slice of record.slices) {
            const p = slice?.provenance, kind = p?.source === 'book' || p?.source === 'dialog' ? p.source : null;
            if (p?.source === 'mixed' || Array.isArray(p?.sources) && p.sources.some(source => source !== kind)) { omitted.mixed++; continue; }
            if (!kind || !p || p.bookId !== item.bookId || p.bucket !== item.key || !integer(p.readTo)
                || !text(slice.id) || ids.has(slice.id) || !text(slice.summary)) { omitted.unknown++; continue; }
            if (p.readTo > request.confirmedReadTo) { omitted.future++; continue; }
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
            const entry = {id: slice.id, kind, text: slice.summary.trim(), readTo: p.readTo,
                sourceLabel: kind === 'book' ? '书中情节（阅读背景）' : '伴读交流（共同经历）', source};
            entry.hash = await hash(entry); entries.push(entry);
        }
        await context.check();
        const snapshot = {version: 1, account: context.account, ...item, confirmedReadTo: request.confirmedReadTo,
            evidence: 'user-confirmed-snapshot', entries, omitted};
        delete snapshot.readTo; delete snapshot.ownership;
        snapshot.hash = await hash(snapshot);
        if (request.expectedHash && request.expectedHash !== snapshot.hash) throw fail('changed', '伴读摘要已变化，请重新预览并确认关联');
        await context.check(); return snapshot;
    }
    function setConsumer(fn) {
        if (typeof fn !== 'function') throw new TypeError('Companion consumer must be a function');
        consumer = fn; return () => clearConsumer(fn);
    }
    function clearConsumer(fn) { if (!fn || consumer === fn) consumer = null; }
    async function consume(selection = {}, purpose = 'companion') {
        if (!consumer) return emptyUse();
        const callback = consumer;
        let timer, expired = false;
        const read = async () => {
            const context = await capture(), state = await context.check();
            if (expired) return emptyUse();
            const story = state.story ? clone(state.story) : null;
            if (!story || !sameStory(story, story)) return emptyUse();
            const item = catalog(state, [selection.key]).find(row => row.key === selection.key);
            if (!item || identity(item).some((value, index) => value !== identity(selection)[index])) return emptyUse();
            const result = await callback({version: 1, purpose, account: context.account, ...item, story: clone(story)});
            const latest = await context.check();
            if (expired || callback !== consumer || !sameStory(story, latest.story)) return emptyUse();
            const current = catalog(latest, [item.key]).find(row => row.key === item.key);
            if (!current || JSON.stringify(identity(current)) !== JSON.stringify(identity(item))) return emptyUse();
            if (purpose === 'companion' && latest.currentKey !== item.key) return emptyUse();
            if (result?.active !== true) return emptyUse();
            return {active: true, text: text(result.text), consumedSliceIds: [...new Set((result.consumedSliceIds || []).filter(id => text(id)))]};
        };
        // Account resolution is part of the optional lookup too. A slow account
        // endpoint must not delay ordinary companion/mainline generation.
        try { return await Promise.race([read().catch(emptyUse), new Promise(resolve => {timer = setTimeout(() => {expired = true;resolve(emptyUse());}, 500);})]); }
        finally { clearTimeout(timer); }
    }
    async function filterMainline(pool) {
        if (!consumer || !Array.isArray(pool) || !pool.length) return pool;
        const groups = new Map();
        for (const slice of pool) if (text(slice?.__src)) groups.set(slice.__src, true);
        let state;
        try { state = requireState(); } catch { return pool; }
        const items = catalog(state, [...groups.keys()]), excluded = new Map();
        await Promise.all(items.map(async item => {
            const used = await consume(item, 'mainline');
            if (used.active) excluded.set(item.key, new Set(used.consumedSliceIds));
        }));
        return pool.filter(slice => !excluded.get(slice.__src)?.has(slice.id));
    }
    const api = Object.freeze({version: 1, list, readSnapshot, setConsumer, clearConsumer});
    return Object.freeze({api, consume, filterMainline,
        mount(target = globalThis) {
            if (target[YIMU_COMPANION_KEY] && target[YIMU_COMPANION_KEY] !== api) return false;
            mounted = target; target[YIMU_COMPANION_KEY] = api;
            if (typeof target.dispatchEvent === 'function' && typeof target.Event === 'function') target.dispatchEvent(new target.Event(YIMU_COMPANION_READY));
            return true;
        },
        unmount() { epoch++; consumer = null; if (mounted?.[YIMU_COMPANION_KEY] === api) delete mounted[YIMU_COMPANION_KEY]; mounted = null; },
    });
}
