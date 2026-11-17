// User-confirmed, bounded reading summaries. This is not a second book store
// and does not claim that old browser archives have verified original sources.
const fail = message => { throw Object.assign(new Error(message), { status: 400, statusCode: 400 }); };
const text = (value, max = 300, allowEmpty = false) => {
    if (typeof value !== 'string' || value.length > max || !allowEmpty && !value.trim()) fail('伴读关联资料不完整或过长');
    return value;
};
const hash = value => { if (!/^[a-f0-9]{64}$/.test(value)) fail('伴读快照指纹无效'); return value; };
const integer = value => { if (!Number.isSafeInteger(value) || value < 0) fail('请明确确认共同已读范围'); return value; };
const positive = value => { if (!Number.isSafeInteger(value) || value < 1) fail('伴读关联资料不完整或过长'); return value; };
const IDENTITY = ['key', 'bookId', 'scope', 'persona', 'avatar'];

export const COMPANION_LIMITS = Object.freeze({ books: 12, entries: 200, bookChars: 200000, totalChars: 600000, notes: 20, noteChars: 200,
    terms: 40, keywords: 12, readLabel: 60 });

// Version 1 is one frozen snapshot of one book. Stored documents and backups keep
// it byte-for-byte; reading code upgrades it in memory only.
function validateSingle(value) {
    if (value.confirmed !== true || !Array.isArray(value.entries) || !value.entries.length || value.entries.length > 200) fail('没有可关联的已确认伴读摘要，请调整已读范围或先在伴读中整理记忆');
    const result = { version: 1, confirmed: true, account: text(value.account), key: text(value.key, 1500),
        bookId: text(value.bookId), scope: text(value.scope, 1000), persona: text(value.persona, 300, true), avatar: text(value.avatar),
        title: text(value.title), charName: text(value.charName, 300, true), userName: text(value.userName, 300, true),
        confirmedReadTo: integer(value.confirmedReadTo), hash: hash(value.hash) };
    if (!/^st-user:[^\u0000-\u001f]+$/.test(result.account) || result.key !== `${result.scope}::${result.bookId}`) fail('伴读账户或记录归属不一致');
    const ids = new Set(); let size = 0;
    result.entries = value.entries.map(item => {
        const id = text(item?.id, 300);
        if (ids.has(id) || !['book', 'dialog'].includes(item.kind)) fail('伴读来源重复或无法区分背景与交流');
        ids.add(id);
        const readTo = integer(item.readTo);
        if (readTo > result.confirmedReadTo) fail('伴读摘要超过共同已读截止');
        const body = text(item.text, 100000); size += body.length;
        if (size > 500000) fail('本次关联摘要过多，请缩小共同已读范围');
        return { id, kind: item.kind, text: body, readTo, hash: hash(item.hash), sourceLabel: item.kind === 'book' ? '书中情节（阅读背景）' : '伴读交流（共同经历）' };
    });
    return result;
}

function words(value, limit, min) {
    if (value == null) return [];
    if (!Array.isArray(value) || value.length > limit) fail('伴读关联资料不完整或过长');
    const seen = new Set();
    for (const item of value) {
        if (typeof item !== 'string' || item !== item.trim() || item.length < min || item.length > 40 || /[\u0000-\u001f]/.test(item)) fail('伴读关联资料不完整或过长');
        seen.add(item);
    }
    return [...seen];
}

// stamped: the anchor/seq/updatedAt fields only Yimu writes are present and checked.
function validateBook(value, stamped) {
    if (!value || typeof value !== 'object' || !Array.isArray(value.entries)) fail('没有可关联的共读记忆，请先在伴读中整理记忆');
    const book = { key: text(value.key, 1500), bookId: text(value.bookId), scope: text(value.scope, 1000),
        persona: text(value.persona, 300, true), avatar: text(value.avatar), title: text(value.title),
        charName: text(value.charName, 300, true), userName: text(value.userName, 300, true),
        confirmedReadTo: integer(value.confirmedReadTo), readLabel: text(value.readLabel ?? '', COMPANION_LIMITS.readLabel, true),
        terms: words(value.terms, COMPANION_LIMITS.terms, 2), hash: hash(value.hash) };
    if (/[\u0000-\u001f]/.test(book.readLabel) || book.key !== `${book.scope}::${book.bookId}`) fail('伴读账户或记录归属不一致');
    if (stamped) { book.seq = positive(value.seq); book.updatedAt = integer(value.updatedAt); }
    const ids = new Set(); let size = 0, notes = 0, slices = 0;
    book.entries = value.entries.map(item => {
        const id = text(item?.id, 300), kind = item.kind;
        if (ids.has(id) || !['book', 'dialog', 'note'].includes(kind)) fail('伴读来源重复或无法区分背景与交流');
        if ((kind === 'note') !== /^note:[1-9]\d{0,8}$/.test(id) || kind === 'note' && !stamped) fail('伴读来源重复或无法区分背景与交流');
        ids.add(id);
        if (kind === 'note') notes++; else slices++;
        const readTo = integer(item.readTo);
        if (readTo > book.confirmedReadTo) fail('伴读摘要超过共同已读截止');
        const body = text(item.text, kind === 'note' ? COMPANION_LIMITS.noteChars : 100000); size += body.length;
        // The layer decides what may ever be presented as lived experience, so it is derived here and never read from the input.
        const entry = { id, kind, layer: kind === 'book' ? 'book' : 'shared', text: body, readTo,
            keywords: kind === 'book' ? words(item.keywords, COMPANION_LIMITS.keywords, 1) : [], hash: hash(item.hash) };
        if (stamped) {
            entry.anchor = item.anchor == null ? null : { floor: positive(item.anchor.floor), hash: hash(item.anchor.hash) };
            entry.seq = positive(item.seq);
            if (entry.seq > book.seq) fail('伴读关联资料不完整或过长');
        }
        return entry;
    });
    if (!slices && !notes) fail('没有可关联的共读记忆，请先在伴读中整理记忆');
    if (slices > COMPANION_LIMITS.entries || notes > COMPANION_LIMITS.notes || size > COMPANION_LIMITS.bookChars) fail('这本书的共读记忆过多，请缩小已读范围');
    return { book, size };
}

/** The reader's own fields for one book, before Yimu stamps anchors and sequence numbers. */
export function validateBookSnapshot(value) {
    const account = text(value?.account);
    if (!/^st-user:[^\u0000-\u001f]+$/.test(account)) fail('伴读账户或记录归属不一致');
    return { account, ...validateBook(value, false).book };
}

export function validateCompanion(value) {
    if (value?.version === 1) return validateSingle(value);
    if (!value || value.version !== 2 || !Array.isArray(value.books) || !value.books.length) fail('没有可关联的已确认伴读摘要，请调整已读范围或先在伴读中整理记忆');
    if (value.books.length > COMPANION_LIMITS.books) fail(`一个故事最多关联 ${COMPANION_LIMITS.books} 本书`);
    const account = text(value.account);
    if (!/^st-user:[^\u0000-\u001f]+$/.test(account)) fail('伴读账户或记录归属不一致');
    const keys = new Set(); let total = 0;
    const books = value.books.map(item => {
        const { book, size } = validateBook(item, true);
        if (keys.has(book.key)) fail('伴读账户或记录归属不一致');
        keys.add(book.key); total += size;
        return book;
    });
    if (total > COMPANION_LIMITS.totalChars) fail('关联的共读记忆过多，请先解除不再需要的书');
    return { version: 2, account, books };
}

/** In-memory only: an old single snapshot reads as a one-book list. Never written back by reading. */
export function upgradeCompanion(value) {
    if (!value) return null;
    const valid = validateCompanion(value);
    if (valid.version === 2) return valid;
    return { version: 2, account: valid.account, books: [{ ...Object.fromEntries(IDENTITY.map(key => [key, valid[key]])),
        title: valid.title, charName: valid.charName, userName: valid.userName, confirmedReadTo: valid.confirmedReadTo, readLabel: '',
        terms: valid.title.trim().length >= 2 && valid.title.trim().length <= 40 ? [valid.title.trim()] : [], hash: valid.hash, seq: 1, updatedAt: 0,
        entries: valid.entries.map(item => ({ id: item.id, kind: item.kind, layer: item.kind === 'book' ? 'book' : 'shared', text: item.text,
            readTo: item.readTo, keywords: [], hash: item.hash, anchor: null, seq: 1 })) }] };
}

export function companionBooks(value) {
    try { return upgradeCompanion(value)?.books || []; } catch { return []; }
}

/**
 * Add one book or refresh it. A slice the story already carries keeps the floor
 * and update number it was first shared at, even when its text was revised; new
 * slices are placed at the current floor; slices the reader no longer has are dropped.
 */
export function mergeCompanionBook(current, snapshot, { anchor = null, now = 0, note = null } = {}) {
    const base = upgradeCompanion(current), fresh = validateBookSnapshot(snapshot), { account, ...book } = fresh;
    if (base && base.account !== account) fail('伴读账户或记录归属不一致');
    const prior = base?.books.find(item => item.key === book.key), seq = (prior?.seq || 0) + 1;
    const known = new Map((prior?.entries || []).map(item => [item.id, item]));
    const entries = book.entries.map(item => ({ ...item, anchor: known.has(item.id) ? known.get(item.id).anchor : anchor,
        seq: known.has(item.id) ? known.get(item.id).seq : seq }));
    const notes = (prior?.entries || []).filter(item => item.kind === 'note')
        .map(item => ({ ...item, readTo: Math.min(item.readTo, book.confirmedReadTo) }));
    const said = typeof note?.text === 'string' ? note.text.trim().slice(0, COMPANION_LIMITS.noteChars) : '';
    if (said) notes.push({ id: `note:${seq}`, kind: 'note', layer: 'shared', text: said, readTo: book.confirmedReadTo, keywords: [], hash: note.hash, anchor, seq });
    const merged = { ...book, seq, updatedAt: now, entries: [...entries, ...notes.slice(-COMPANION_LIMITS.notes)] };
    const others = (base?.books || []).filter(item => item.key !== book.key);
    return validateCompanion({ version: 2, account, books: prior ? base.books.map(item => item.key === book.key ? merged : item) : [...others, merged] });
}

/** The stored value without one book; null once no book is left. */
export function removeCompanionBook(current, key) {
    const base = upgradeCompanion(current), books = (base?.books || []).filter(item => item.key !== key);
    return books.length ? validateCompanion({ version: 2, account: base.account, books }) : null;
}

export function applyCompanionOperation(document, operation) {
    if (operation.expectedRevision !== document.revision) throw Object.assign(new Error('此聊天记忆已变化，请重新预览后确认关联'), {status: 409});
    if (operation.action === 'clear') document.companion = null;
    else if (operation.action === 'set') document.companion = validateCompanion(operation.snapshot);
    else fail('未知的伴读关联操作');
    document.epoch++;
    return document;
}

// A short stable tag per book for injected ids; not a security boundary.
function bookTag(key) {
    let value = 0x811c9dc5;
    for (let index = 0; index < key.length; index++) value = Math.imul(value ^ key.charCodeAt(index), 0x01000193) >>> 0;
    return value.toString(16).padStart(8, '0');
}

/** Injection candidates. source:null on purpose: reading memories never gain the right to replace a story floor. */
export function companionEntries(value, books = companionBooks(value)) {
    return books.flatMap(book => {
        const tag = bookTag(book.key);
        return book.entries.map(item => ({ id: `companion_${tag}_${item.hash.slice(0, 16)}`, kind: 'manual',
            text: item.text, source: null, status: 'active', edited: true, revision: 1,
            companion: { book: book.key, layer: item.layer, kind: item.kind, title: book.title, readTo: item.readTo, readLabel: book.readLabel,
                sourceId: item.id, anchor: item.anchor, seq: item.seq, keywords: item.keywords, charName: book.charName, userName: book.userName } }));
    });
}

/** The linked book that is exactly the reader's current book, companion and persona in this story chat. */
export function linkedBook(value, context, binding) {
    if (!value || !context || !context.story || !['avatar', 'file', 'integrity'].every(key => typeof binding?.[key] === 'string' && binding[key].trim() && context.story[key] === binding[key])) return null;
    let linked; try { linked = upgradeCompanion(value); } catch { return null; }
    if (!linked || linked.account !== context.account) return null;
    return linked.books.find(book => IDENTITY.every(key => book[key] === context[key])) || null;
}

export function sameCompanionContext(snapshot, context, binding) {
    return !!linkedBook(snapshot, context, binding);
}
