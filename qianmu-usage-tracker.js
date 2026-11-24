// 使用时长：按现实时间统计「在酒馆里真正在用」的时间，与故事内容无关。
// 只算两次操作（点按、滚动、打字）之间的时间，且两次相隔不超过 idleMs；最后一次操作之后的空闲不算。正在等回复也算一次操作。
// 页面看不见时不计；电脑上窗口没有焦点时也不计，但正在生成时照常计。手机上不看焦点。
// 两份数：每天的总时长（days）与每个角色的聊天交互时长（chars）。角色那份按头像文件名记，删了聊天、甚至删了角色也留着。
// 另有一份 token 账（tokens）：每天正文聊天发出与收到的估算 token，见 createTokenMeter。
// 这里只管计数与存取，不发任何请求。

export const USAGE_VERSION = 1;
const DAY_LIMIT = 800, CHAR_LIMIT = 400;
const pad = value => String(value).padStart(2, '0');
export const dayKey = at => { const d = new Date(at); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const num = value => Number.isFinite(value) && value > 0 ? value : 0;
const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;

/** token 账：{ since, days: { 日期: { sent, received } } }。格式不对的丢掉。 */
function normalizeTokens(value) {
    const out = { since: num(value?.since), days: {} };
    for (const [key, item] of Object.entries(value?.days && typeof value.days === 'object' ? value.days : {})) {
        if (!DAY_KEY.test(key) || !item || typeof item !== 'object') continue;
        const sent = Math.round(num(item.sent)), received = Math.round(num(item.received));
        if (sent || received) out.days[key] = { sent, received };
    }
    return out;
}

/** 读入已存的统计；格式不对的部分丢掉，绝不抛错。 */
export function normalizeUsage(value) {
    const out = { version: USAGE_VERSION, since: 0, days: {}, hours: Array(24).fill(0), chars: {} };
    if (!value || typeof value !== 'object') return out;
    out.since = num(value.since);
    if (typeof value.zone === 'string' && value.zone && value.zone.length <= 64) out.zone = value.zone;
    if (value.tokens && typeof value.tokens === 'object') out.tokens = normalizeTokens(value.tokens);
    for (const [key, ms] of Object.entries(value.days && typeof value.days === 'object' ? value.days : {})) if (DAY_KEY.test(key) && num(ms)) out.days[key] = Math.round(ms);
    if (Array.isArray(value.hours)) out.hours = out.hours.map((_, hour) => Math.round(num(value.hours[hour])));
    for (const [key, item] of Object.entries(value.chars && typeof value.chars === 'object' ? value.chars : {})) {
        if (!key || key.length > 240 || !item || typeof item !== 'object') continue;
        out.chars[key] = { name: String(item.name || '').slice(0, 120), ms: Math.round(num(item.ms)), last: num(item.last), ...(item.avatar ? { avatar: String(item.avatar).slice(0, 600) } : {}) };
    }
    return out;
}

/** 自选时区下的「钟面」比本机快或慢多少毫秒：把时间加上它，再按本机时间取年月日时，得到的就是那个时区的年月日时。
 * 没选（跟随系统）或时区名不认识时是 0。 */
export function zoneShift(at, zone) {
    if (!zone) return 0;
    try {
        const parts = {};
        for (const part of new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' }).formatToParts(new Date(at))) parts[part.type] = Number(part.value);
        return new Date(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second).getTime() - Math.floor(at / 1000) * 1000;
    } catch { return 0; }
}

/** 电脑上窗口有没有焦点；手机（只有触屏、不能悬停）上一律当作有，不看焦点。 */
export function windowFocused({ document = globalThis.document, window = globalThis } = {}) {
    try { if (window?.matchMedia?.('(hover: none) and (pointer: coarse)')?.matches) return true; } catch { /* 老浏览器 */ }
    return typeof document?.hasFocus === 'function' ? document.hasFocus() !== false : true;
}

export function createUsageTracker({ load = () => null, save = () => {}, now = () => Date.now(), character = () => null, visible = () => true, busy = () => false, focused = () => true,
    idleMs = 120000, tickMs = 15000, saveEveryMs = 180000 } = {}) {
    const data = normalizeUsage(load());
    // 一段「在用」：从一次操作起，之后每次操作离上一次不超过 idleMs 就连上；booked 是这段里已经记到账上的位置。
    // 账只记到最后一次操作为止，所以停下来以后的空闲尾巴自然不算。
    let lastActive = 0, booked = 0, lastTick = 0, unsaved = 0, dirty = false, tokensDirty = false, lastSave = now();
    const flush = () => { if (!dirty && !tokensDirty) return; dirty = false; tokensDirty = false; unsaved = 0; lastSave = now(); save(data); };
    const trim = () => {
        const days = Object.keys(data.days).sort();
        for (const key of days.slice(0, Math.max(0, days.length - DAY_LIMIT))) delete data.days[key];
        const chars = Object.entries(data.chars).sort((a, b) => b[1].last - a[1].last);
        for (const [key] of chars.slice(CHAR_LIMIT)) delete data.chars[key];
        if (data.tokens) { const tokenDays = Object.keys(data.tokens.days).sort(); for (const key of tokenDays.slice(0, Math.max(0, tokenDays.length - DAY_LIMIT))) delete data.tokens.days[key]; }
    };
    // 能不能算：页面要看得见；电脑上窗口还要有焦点——但生成中不看焦点（等回复时可能在别的窗口里做事）。
    const countable = (generating = busy()) => visible() && (generating || focused());
    /** 把这一段从上次记到的位置记到 upTo。哪一天、几点钟按所选时区的钟面算；since 与 last 仍记真实时刻。 */
    function book(upTo) {
        const add = upTo - booked;
        if (!(add > 0)) return 0;
        booked = upTo;
        if (!data.since) data.since = upTo;
        const wall = upTo + zoneShift(upTo, data.zone), key = dayKey(wall);
        data.days[key] = (data.days[key] || 0) + add;
        data.hours[new Date(wall).getHours()] += add;
        const who = character();
        if (who?.key) {
            const item = data.chars[who.key] ||= { name: '', ms: 0, last: 0 };
            item.ms += add; if (who.name) item.name = String(who.name).slice(0, 120); if (who.avatar) item.avatar = String(who.avatar).slice(0, 600);
        }
        dirty = true; unsaved += add;
        return add;
    }
    /** 这一段到此为止：记到最后一次操作，之后的不算。 */
    function end() { const add = lastActive ? book(lastActive) : 0; lastActive = 0; booked = 0; return add; }
    /** 一次操作。算不了（看不见，或电脑上没焦点又没在生成）时不算，并把正在记的那段收住。 */
    function activity(at) {
        if (!countable()) return end();
        let add = 0;
        if (lastActive && at - lastActive > idleMs) add = end(); // 隔得太久：前一段收住，从这次重新起
        if (!lastActive) booked = at;
        lastActive = Math.max(lastActive, at);
        return add;
    }
    /** 每个节拍：正在等回复、看流式输出也算一次操作；把这一段记到最后一次操作为止。
     * 节拍停了很久（标签页被挂起、电脑睡着）：醒来时前一段只记到睡着前，睡着的时间不算。 */
    function tick() {
        const at = now(), since = lastTick ? at - lastTick : 0;
        lastTick = at;
        let add = since > tickMs * 2 ? end() : 0;
        if (busy()) add += activity(at);
        else if (!countable()) add += end();
        if (lastActive) add += book(lastActive);
        // 存盘节流：攒够 saveEveryMs 的时长存一次；token 账有新数时，离上次存盘满 saveEveryMs 也存。
        if ((dirty && unsaved >= saveEveryMs) || (tokensDirty && at - lastSave >= saveEveryMs)) { trim(); flush(); }
        return add;
    }
    return {
        /** 有过一次操作。节拍停了很久之后的第一次操作也一样：睡着的那段不算。 */
        touch() { const at = now(); if (!lastTick) lastTick = at; else if (at - lastTick > tickMs * 2) { end(); lastTick = at; } activity(at); },
        /** 窗口失去焦点：电脑上这一段到此为止（正在生成时照常算）；手机上不看焦点，照常。 */
        pause() { if (!countable()) end(); },
        tick,
        /** 正文聊天的一次生成：发出与收到的 token（估算或渠道回报的）。按所选时区记在当天。 */
        addTokens({ sent = 0, received = 0 } = {}) {
            sent = Math.round(num(sent)); received = Math.round(num(received));
            if (!sent && !received) return;
            const at = now(), tokens = data.tokens ||= { since: 0, days: {} };
            if (!tokens.since) tokens.since = at;
            const key = dayKey(at + zoneShift(at, data.zone)), day = tokens.days[key] ||= { sent: 0, received: 0 };
            day.sent += sent; day.received += received;
            tokensDirty = true;
            if (at - lastSave >= saveEveryMs) { trim(); flush(); }
        },
        /** 这个角色刚有一条新消息（发出或收到）：记下最后一次聊天的时间。 */
        message() {
            const who = character(); if (!who?.key) return;
            const item = data.chars[who.key] ||= { name: '', ms: 0, last: 0 };
            item.last = now(); if (who.name) item.name = String(who.name).slice(0, 120); if (who.avatar) item.avatar = String(who.avatar).slice(0, 600);
            dirty = true;
        },
        flush() { tick(); trim(); flush(); },
        /** 换时区：空串是跟随系统。只影响之后记的账；已经记下的日子与钟点不重算。 */
        setZone(zone) {
            tick();
            let next = typeof zone === 'string' && zone.length <= 64 ? zone : '';
            if (next) { try { new Intl.DateTimeFormat('en-US', { timeZone: next }); } catch { next = ''; } }
            if (next) data.zone = next; else delete data.zone;
            dirty = true; trim(); flush();
        },
        get data() { return data; },
    };
}

// ---- 给界面用的汇总 ----
const DAY = 86400000;
const startOfDay = at => { const d = new Date(at); d.setHours(0, 0, 0, 0); return d.getTime(); };
const addDays = (at, n) => { const d = new Date(at); d.setDate(d.getDate() + n); return d.getTime(); };
/** 时长写成人话：不足一分钟、X 分钟、X 小时 Y 分。 */
export function durationText(ms) {
    const minutes = Math.floor(num(ms) / 60000);
    if (minutes < 1) return ms > 0 ? '不到 1 分钟' : '0 分钟';
    if (minutes < 60) return `${minutes} 分钟`;
    const hours = Math.floor(minutes / 60), rest = minutes % 60;
    return rest ? `${hours} 小时 ${rest} 分` : `${hours} 小时`;
}
/** 大数字用的短写法：「2:50」这样的时:分。 */
export const clockText = ms => { const minutes = Math.floor(num(ms) / 60000); return `${Math.floor(minutes / 60)}:${pad(minutes % 60)}`; };

/** 大数字：从分钟起步；位数多到格子放不下时才换成小时、再换成天。单位是跟在数字后面的小字。 */
export function compactTime(ms) {
    const minutes = Math.floor(num(ms) / 60000);
    if (minutes < 10000) return { value: String(minutes), unit: 'min' };
    const hours = minutes / 60;
    if (hours < 10000) return { value: hours < 1000 ? hours.toFixed(1) : String(Math.round(hours)), unit: 'h' };
    return { value: String(Math.round(hours / 24)), unit: 'd' };
}
const weekStartOf = at => { const day = startOfDay(at); return addDays(day, -((new Date(day).getDay() + 6) % 7)); };
/** 默认看的那一段：十三周（一个季度那么长），整周起头，最后一格是今天，所以格子总是铺满。shift：往前或往后翻整段。 */
export function quarterRange(at, shift = 0) {
    const today = startOfDay(at), monday = addDays(weekStartOf(today), shift * 91);
    return { from: addDays(monday, -84), to: shift ? addDays(monday, 6) : today };
}
/** 热力格：一列一周（周一到周日），列数跟着所选范围走。越深用得越久；范围外与还没到的日子不画。
 * values：按日期给的数（默认是每天的时长；token 模式传每天发出加收到的总数）。 */
export function heatCells(data, from, to, at = Date.now(), values = null) {
    const usage = normalizeUsage(data), days = values || usage.days, today = startOfDay(at), start = startOfDay(Math.min(from, to)), end = startOfDay(Math.max(from, to));
    const first = weekStartOf(start), weeks = Math.round((weekStartOf(end) - first) / (7 * DAY)) + 1, cells = [];
    let max = 0, total = 0;
    for (let column = 0; column < weeks; column++) for (let row = 0; row < 7; row++) {
        const time = addDays(first, column * 7 + row), inside = time >= start && time <= end && time <= today, ms = inside ? days[dayKey(time)] || 0 : null;
        if (ms) { max = Math.max(max, ms); total += ms; }
        cells.push({ time, ms, column, row, today: time === today });
    }
    for (const cell of cells) cell.level = cell.ms === null ? -1 : !cell.ms ? 0 : Math.min(4, 1 + Math.floor(cell.ms / Math.max(1, max) * 3.999));
    return { cells, weeks, from: start, to: end, total };
}

export function usageSummary(data, at = Date.now()) {
    const usage = normalizeUsage(data), today = startOfDay(at), of = time => usage.days[dayKey(time)] || 0;
    const sumFrom = from => { let total = 0; for (let day = from; day <= today; day = addDays(day, 1)) total += of(day); return total; };
    const monthStart = new Date(today); monthStart.setDate(1);
    const yearStart = new Date(today); yearStart.setMonth(0, 1);
    const all = Object.values(usage.days).reduce((a, b) => a + b, 0), activeDays = Object.keys(usage.days).length;
    // 连续天数：今天还没用也不算断（从昨天往前数）。
    let streak = 0; for (let day = of(today) ? today : addDays(today, -1); of(day); day = addDays(day, -1)) streak++;
    let longest = 0, run = 0, previous = null;
    for (const key of Object.keys(usage.days).sort()) { const time = new Date(`${key}T00:00:00`).getTime(); run = previous !== null && Math.round((time - previous) / DAY) === 1 ? run + 1 : 1; longest = Math.max(longest, run); previous = time; }
    const peak = usage.hours.reduce((best, ms, hour) => ms > usage.hours[best] ? hour : best, 0);
    const chars = Object.entries(usage.chars).map(([key, item]) => ({ key, ...item })).filter(item => item.ms > 0 || item.last > 0).sort((a, b) => b.ms - a.ms || b.last - a.last);
    const first = Object.keys(usage.days).sort()[0];
    return { today: of(today), week: sumFrom(weekStartOf(today)), month: sumFrom(monthStart.getTime()), year: sumFrom(yearStart.getTime()), all, activeDays,
        streak, longest, peak: usage.hours[peak] ? peak : null, since: usage.since, firstDay: first ? new Date(`${first}T00:00:00`).getTime() : 0,
        chars, top: chars[0]?.ms || 0, recent: [...chars].sort((a, b) => b.last - a.last)[0] || null };
}

// ---- token 账 ----
/** 每天发出加收到的总数，给热力格用。 */
export function tokenTotals(data) {
    const days = normalizeUsage(data).tokens?.days || {}, out = {};
    for (const [key, item] of Object.entries(days)) out[key] = item.sent + item.received;
    return out;
}
export function tokenSummary(data, at = Date.now()) {
    const tokens = normalizeUsage(data).tokens || { since: 0, days: {} }, today = startOfDay(at), zero = () => ({ sent: 0, received: 0, total: 0 });
    const add = (sum, item) => { if (item) { sum.sent += item.sent; sum.received += item.received; sum.total += item.sent + item.received; } return sum; };
    const sumFrom = from => { const sum = zero(); for (let day = from; day <= today; day = addDays(day, 1)) add(sum, tokens.days[dayKey(day)]); return sum; };
    const monthStart = new Date(today); monthStart.setDate(1);
    const yearStart = new Date(today); yearStart.setMonth(0, 1);
    const keys = Object.keys(tokens.days).sort(), all = zero();
    let peak = null;
    for (const key of keys) { const item = tokens.days[key], total = item.sent + item.received; add(all, item); if (!peak || total > peak.total) peak = { day: new Date(`${key}T00:00:00`).getTime(), total }; }
    return { today: add(zero(), tokens.days[dayKey(today)]), week: sumFrom(weekStartOf(today)), month: sumFrom(monthStart.getTime()), year: sumFrom(yearStart.getTime()), all,
        activeDays: keys.length, average: keys.length ? Math.round(all.total / keys.length) : 0, peak, since: tokens.since, firstDay: keys[0] ? new Date(`${keys[0]}T00:00:00`).getTime() : 0 };
}
/** token 数的短写法：不到一千照写，再大换成 k、M、B。 */
export function compactTokens(value) {
    const n = Math.round(num(value));
    if (n < 1000) return { value: String(n), unit: 'tok' };
    for (const [size, unit] of [[1e9, 'B'], [1e6, 'M'], [1e3, 'k']]) {
        if (n < size) continue;
        const scaled = n / size;
        return { value: scaled < 100 ? String(Math.floor(scaled * 10) / 10) : String(Math.floor(scaled)), unit };
    }
    return { value: String(n), unit: 'tok' };
}
export const tokenText = value => { const { value: shown, unit } = compactTokens(value); return unit === 'tok' ? shown : `${shown}${unit}`; };

/** 估算 token：中日韩等非 ASCII 字符每个 1，ASCII 每个约 0.35（与忆幕的估算同一口径）。 */
export function estimateTextTokens(text) {
    let n = 0;
    for (const ch of String(text ?? '')) n += ch.codePointAt(0) > 127 ? 1 : 0.35;
    return Math.ceil(n);
}
/** 一份请求里的文字：整段提示词，或一串消息（内容可能分成几块，图片等不算）。 */
function promptTexts(prompt) {
    if (typeof prompt === 'string') return [prompt];
    if (!Array.isArray(prompt)) return [];
    const out = [];
    for (const message of prompt) {
        const content = typeof message === 'string' ? message : message?.content;
        if (typeof content === 'string') out.push(content);
        else if (Array.isArray(content)) for (const part of content) if (typeof part?.text === 'string') out.push(part.text);
    }
    return out;
}
// 正文聊天的生成：用户发言触发的普通生成、重新生成、滑动、继续、代拟。别的（后台、插件、只拼提示词的）一概不记。
const CHAT_TYPES = new Set(['normal', 'regenerate', 'swipe', 'continue', 'impersonate']);
const FOREIGN_REPLIES = new Set(['first_message', 'extension', 'command']);
/**
 * token 账的事件接线。发出：正文生成拼好的最终请求（生成开始后、请求发出前的那一份数据，只拼不发的不算）；
 * 收到：这次生成落进聊天的回复（继续只算接上的那一截；代拟是填进输入框的那段）。
 * 估算放到当前事件之后再做，不拖慢生成，也不发任何请求。插件在正文生成途中插进来的生成会让这一次分不清，宁可不记。
 */
export function createTokenMeter({ getContext = () => ({}), record = () => {}, defer = fn => setTimeout(fn, 0) } = {}) {
    let starting = null, waiting = null;
    const later = fn => defer(() => { try { fn(); } catch (error) { console.warn('[微醺记录] token 没记上', error); } });
    return Object.freeze({
        generationStarted(type, options, dryRun) {
            if (dryRun) return;
            const kind = type || 'normal';
            if (!CHAT_TYPES.has(kind) || options?.quiet_prompt) { starting = null; return; }
            const chat = getContext()?.chat, last = Array.isArray(chat) ? chat[chat.length - 1] : null;
            starting = { type: kind, base: kind === 'continue' && last && !last.is_user ? String(last.mes ?? '') : '' };
            waiting = null;
        },
        afterData(data, dryRun) {
            if (dryRun || !starting || !data || typeof data !== 'object') return;
            const texts = promptTexts(data.prompt ?? data.input ?? data.messages);
            waiting = starting; starting = null;
            if (texts.length) later(() => record({ sent: texts.reduce((sum, text) => sum + estimateTextTokens(text), 0) }));
        },
        messageReceived(id, type) {
            if (!waiting || waiting.type === 'impersonate' || FOREIGN_REPLIES.has(type)) return;
            const message = getContext()?.chat?.[Number(id)];
            if (!message || message.is_user || message.is_system) return;
            const { type: kind, base } = waiting; waiting = null;
            const text = String(message.mes ?? ''), reasoning = kind === 'continue' ? '' : String(message.extra?.reasoning ?? '');
            later(() => {
                const reply = !base ? estimateTextTokens(text) : text.startsWith(base) ? estimateTextTokens(text.slice(base.length)) : Math.max(0, estimateTextTokens(text) - estimateTextTokens(base));
                record({ received: reply + estimateTextTokens(reasoning) });
            });
        },
        impersonateReady(text) {
            if (waiting?.type !== 'impersonate') return;
            waiting = null;
            later(() => record({ received: estimateTextTokens(text) }));
        },
        chatChanged() { starting = null; waiting = null; },
    });
}

/** 接到页面上：操作与可见性用捕获阶段听（面板会拦住冒泡），每个节拍记一次账，离开页面时存盘。返回停止函数。 */
export function startUsageTracking(tracker, { document = globalThis.document, window = globalThis, tickMs = 15000 } = {}) {
    const touch = () => tracker.touch(), options = { capture: true, passive: true };
    // 移动鼠标、滑动手指也算在用：只读不点的时候不该被当成挂机；重新动一下就立刻接着计。
    const names = ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart', 'touchmove', 'scroll'];
    for (const name of names) document.addEventListener(name, touch, options);
    const leave = () => { if (document.visibilityState === 'hidden') tracker.flush(); else tracker.touch(); };
    document.addEventListener('visibilitychange', leave);
    const bye = () => tracker.flush();
    window.addEventListener('pagehide', bye);
    // 电脑上切到别的窗口：这一段到此为止。
    const blur = () => tracker.pause?.();
    window.addEventListener('blur', blur);
    const timer = window.setInterval(() => tracker.tick(), tickMs);
    return () => { for (const name of names) document.removeEventListener(name, touch, options); document.removeEventListener('visibilitychange', leave); window.removeEventListener('pagehide', bye); window.removeEventListener('blur', blur); window.clearInterval(timer); tracker.flush(); };
}
