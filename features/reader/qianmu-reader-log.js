// 伴读的阅读记录：真正在读的时长、读过的字、读完的书，以及最近一次书友对话的几句。
// 时长与微醺记录同一套规则（createUsageTracker）：页面看得见、两次操作相隔不超过两分钟才算，最后一次操作后的空闲不算；
// 只在一本书打开着的时候算。按天、按钟点、按书友由它记，这里再按书记一份。
// 读过的字：读位往前走了多少字；往回翻不扣，回翻后重读到原处之前不重复算；一下跳得太远（目录、拖进度）不算。
// 只存数字和最近对话的几句摘录，不存书的正文；不发任何请求。
import { createUsageTracker, normalizeUsage, usageSummary, dayKey, zoneShift } from '../../qianmu-usage-tracker.js?v=1.59.629';

export const READ_JUMP_CHARS = 12000;
const PALS_PER_BOOK = 12, BOOK_LIMIT = 600, DAY_LIMIT = 800, PAL_LIMIT = 400, TALK_LINES = 4, TALK_CHARS = 160;
const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;
const num = value => Number.isFinite(value) && value > 0 ? value : 0;
const entries = value => Object.entries(value && typeof value === 'object' ? value : {});
const clip = (value, size) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, size);

function normalizeTalk(value) {
    if (!value || typeof value !== 'object' || !value.bookId) return null;
    const lines = (Array.isArray(value.lines) ? value.lines : []).map(line => ({ who: line?.who === 'user' ? 'user' : 'pal', text: clip(line?.text, TALK_CHARS) })).filter(line => line.text).slice(-TALK_LINES);
    if (!lines.length) return null;
    return { bookId: clip(value.bookId, 120), at: num(value.at), pal: { key: clip(value.pal?.key, 240), name: clip(value.pal?.name, 120) }, user: clip(value.user, 120), lines };
}

/** 读入已存的记录；格式不对的部分丢掉，绝不抛错。 */
export function normalizeReaderLog(value) {
    const out = { time: normalizeUsage(value?.time), books: {}, days: {}, pals: {}, talk: normalizeTalk(value?.talk) };
    for (const [id, item] of entries(value?.books)) {
        if (!id || id.length > 120 || !item || typeof item !== 'object') continue;
        const pals = Array.isArray(item.pals) ? [...new Set(item.pals.filter(key => typeof key === 'string' && key && key.length <= 240))].slice(0, PALS_PER_BOOK) : [];
        out.books[id] = { ms: Math.round(num(item.ms)), chars: Math.round(num(item.chars)), mark: Math.round(num(item.mark)), last: num(item.last), ...(num(item.done) ? { done: num(item.done) } : {}), ...(pals.length ? { pals } : {}) };
    }
    for (const [key, chars] of entries(value?.days)) if (DAY_KEY.test(key) && num(chars)) out.days[key] = Math.round(chars);
    for (const [key, item] of entries(value?.pals)) {
        if (!key || key.length > 240 || !item || typeof item !== 'object') continue;
        out.pals[key] = { name: clip(item.name, 120), chars: Math.round(num(item.chars)), last: num(item.last), ...(item.avatar ? { avatar: clip(item.avatar, 600) } : {}) };
    }
    return out;
}

/** 读位从 last 走到 pos，这一步算多少字。mark 是这本书算到过的最远处，回翻后重读到它之前都不算。 */
export function readAdvance({ mark = 0, last = null, pos, limit = READ_JUMP_CHARS }) {
    const at = Math.max(0, Math.round(Number(pos) || 0));
    if (!Number.isFinite(last) || last === null) return { add: 0, mark, last: at };
    const step = at - last;
    if (step <= 0 || step > limit) return { add: 0, mark, last: at };
    return { add: Math.max(0, at - Math.max(mark, last)), mark: Math.max(mark, at), last: at };
}

export function createReaderLog({ load = () => null, save = () => {}, now = () => Date.now(), visible = () => true, focused = () => true, busy = () => false, ...timing } = {}) {
    const data = normalizeReaderLog(load());
    let open = null;   // { bookId, pal: {key,name,avatar}|null, last }
    const persist = () => save(data);
    const bookOf = id => data.books[id] ||= { ms: 0, chars: 0, mark: 0, last: 0 };
    const trim = () => {
        const books = Object.entries(data.books).sort((a, b) => b[1].last - a[1].last);
        for (const [id] of books.slice(BOOK_LIMIT)) delete data.books[id];
        const days = Object.keys(data.days).sort();
        for (const key of days.slice(0, Math.max(0, days.length - DAY_LIMIT))) delete data.days[key];
        const pals = Object.entries(data.pals).sort((a, b) => b[1].last - a[1].last);
        for (const [key] of pals.slice(PAL_LIMIT)) delete data.pals[key];
    };
    const tracker = createUsageTracker({
        load: () => data.time, save: () => { trim(); persist(); }, now, focused, busy,
        visible: () => !!open && visible(),
        character: () => open?.pal || null,
        onBook: add => { if (!open) return; const book = bookOf(open.bookId); book.ms += add; book.last = now(); },
        ...timing,
    });
    data.time = tracker.data;
    return {
        /** 打开一本书。pos：此刻的读位（字），作为算字的起点。 */
        open(bookId, { pal = null, pos = 0 } = {}) {
            if (open) this.close();
            if (!bookId) return;
            const key = pal?.key ? String(pal.key) : '';
            open = { bookId: String(bookId), pal: key ? { key, name: String(pal.name || ''), ...(pal.avatar ? { avatar: String(pal.avatar) } : {}) } : null, last: Math.max(0, Math.round(Number(pos) || 0)) };
            const at = now(), book = bookOf(open.bookId);
            book.last = at;
            if (key) book.pals = [key, ...(book.pals || []).filter(item => item !== key)].slice(0, PALS_PER_BOOK);   // 这本书和谁读过（最近的在前）
            if (key) { const item = data.pals[key] ||= { name: '', chars: 0, last: 0 }; item.last = at; if (open.pal.name) item.name = clip(open.pal.name, 120); if (open.pal.avatar) item.avatar = clip(open.pal.avatar, 600); }
            tracker.touch();
            persist();
        },
        /** 关书：这一段记到最后一次操作为止，存一次。 */
        close() { if (!open) return; tracker.flush(); open = null; tracker.pause(); trim(); persist(); },
        /** 读位变了。done：这本书读到了末尾。 */
        progress(pos, { done = false } = {}) {
            if (!open) return 0;
            const book = bookOf(open.bookId), step = readAdvance({ mark: book.mark, last: open.last, pos });
            open.last = step.last; book.mark = step.mark;
            const at = now();
            if (step.add) {
                const key = dayKey(at + zoneShift(at, data.time.zone));
                data.days[key] = (data.days[key] || 0) + step.add;
                book.chars += step.add;
                if (open.pal) (data.pals[open.pal.key] ||= { name: open.pal.name, chars: 0, last: at }).chars += step.add;
            }
            if (done && !book.done) book.done = at;
            if (step.add || done) persist();
            return step.add;
        },
        /** 最近一次书友对话：只留最后几句，每句截短。at：最后一句的时间。 */
        talk({ bookId, at = 0, pal = null, user = '', lines = [] } = {}) {
            const next = normalizeTalk({ bookId, at: num(at) || now(), pal, user, lines });
            if (!next) return;
            data.talk = next; persist();
        },
        get reading() { return open ? open.bookId : ''; },
        touch: () => tracker.touch(), pause: () => tracker.pause(), tick: () => tracker.tick(),
        flush() { tracker.flush(); trim(); persist(); },
        setZone: zone => tracker.setZone(zone),
        get data() { return data; },
    };
}

// ---- 给界面用的汇总 ----
/** books：书架上的书（只认还在书架上的）；at：现在。 */
export function readerSummary(value, books = [], at = Date.now()) {
    const log = normalizeReaderLog(value), wall = at + zoneShift(at, log.time.zone), time = usageSummary(log.time, wall);
    const shelf = new Map((Array.isArray(books) ? books : []).filter(book => book?.id).map(book => [book.id, book]));
    const ranked = Object.entries(log.books).filter(([id, item]) => shelf.has(id) && (item.ms > 0 || item.chars > 0))
        .map(([id, item]) => ({ id, ...item, book: shelf.get(id) })).sort((a, b) => b.ms - a.ms || b.chars - a.chars);
    const keys = new Set([...Object.keys(log.time.chars), ...Object.keys(log.pals)]);
    const pals = [...keys].map(key => { const t = log.time.chars[key] || {}, c = log.pals[key] || {}; return { key, name: c.name || t.name || '', avatar: c.avatar || t.avatar || '', ms: t.ms || 0, chars: c.chars || 0, last: c.last || 0 }; })
        .filter(item => item.ms > 0 || item.chars > 0).sort((a, b) => b.ms - a.ms || b.chars - a.chars);
    const allChars = Object.values(log.days).reduce((sum, n) => sum + n, 0);
    return {
        today: { ms: time.today, chars: log.days[dayKey(wall)] || 0 },
        week: time.week, month: time.month, year: time.year, all: { ms: time.all, chars: allChars },
        streak: time.streak, longest: time.longest, activeDays: time.activeDays,
        books: ranked, read: ranked.length, finished: ranked.filter(item => item.done).length,
        pals, lastPal: [...pals].sort((a, b) => b.last - a.last)[0] || null,
        talk: log.talk && shelf.has(log.talk.bookId) ? { ...log.talk, book: shelf.get(log.talk.bookId) } : null,
    };
}
