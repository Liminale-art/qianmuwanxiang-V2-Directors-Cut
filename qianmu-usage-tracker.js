// 使用时长：按现实时间统计「在酒馆里真正在用」的时间，与故事内容无关。
// 只在页面可见、且最近有过操作（点按、滚动、打字）或正在等回复时才计时；挂着不动超过 idleMs 就停。
// 两份数：每天的总时长（days）与每个角色的聊天交互时长（chars）。角色那份按头像文件名记，删了聊天、甚至删了角色也留着。
// 这里只管计数与存取，不读聊天内容、不发任何请求。

export const USAGE_VERSION = 1;
const DAY_LIMIT = 800, CHAR_LIMIT = 400;
const pad = value => String(value).padStart(2, '0');
export const dayKey = at => { const d = new Date(at); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const num = value => Number.isFinite(value) && value > 0 ? value : 0;

/** 读入已存的统计；格式不对的部分丢掉，绝不抛错。 */
export function normalizeUsage(value) {
    const out = { version: USAGE_VERSION, since: 0, days: {}, hours: Array(24).fill(0), chars: {} };
    if (!value || typeof value !== 'object') return out;
    out.since = num(value.since);
    for (const [key, ms] of Object.entries(value.days && typeof value.days === 'object' ? value.days : {})) if (/^\d{4}-\d{2}-\d{2}$/.test(key) && num(ms)) out.days[key] = Math.round(ms);
    if (Array.isArray(value.hours)) out.hours = out.hours.map((_, hour) => Math.round(num(value.hours[hour])));
    for (const [key, item] of Object.entries(value.chars && typeof value.chars === 'object' ? value.chars : {})) {
        if (!key || key.length > 240 || !item || typeof item !== 'object') continue;
        out.chars[key] = { name: String(item.name || '').slice(0, 120), ms: Math.round(num(item.ms)), last: num(item.last), ...(item.avatar ? { avatar: String(item.avatar).slice(0, 600) } : {}) };
    }
    return out;
}

export function createUsageTracker({ load = () => null, save = () => {}, now = () => Date.now(), character = () => null, visible = () => true, busy = () => false,
    idleMs = 120000, tickMs = 15000, saveEveryMs = 180000 } = {}) {
    const data = normalizeUsage(load());
    let lastActive = 0, lastTick = 0, unsaved = 0, dirty = false;
    const flush = () => { if (!dirty) return; dirty = false; unsaved = 0; save(data); };
    const trim = () => {
        const days = Object.keys(data.days).sort();
        for (const key of days.slice(0, Math.max(0, days.length - DAY_LIMIT))) delete data.days[key];
        const chars = Object.entries(data.chars).sort((a, b) => b[1].last - a[1].last);
        for (const [key] of chars.slice(CHAR_LIMIT)) delete data.chars[key];
    };
    /** 记到账上。一次最多记两个节拍：标签页被挂起很久后醒来，不把睡着的时间算进去。 */
    function tick() {
        const at = now(), since = lastTick ? at - lastTick : 0;
        lastTick = at;
        if (!(since > 0) || !visible()) return 0;
        if (busy()) lastActive = at; // 正在等回复、看流式输出也算在用
        if (!lastActive || at - lastActive > idleMs) return 0;
        const add = Math.min(since, tickMs * 2);
        if (!data.since) data.since = at;
        const key = dayKey(at);
        data.days[key] = (data.days[key] || 0) + add;
        data.hours[new Date(at).getHours()] += add;
        const who = character();
        if (who?.key) {
            const item = data.chars[who.key] ||= { name: '', ms: 0, last: 0 };
            item.ms += add; if (who.name) item.name = String(who.name).slice(0, 120); if (who.avatar) item.avatar = String(who.avatar).slice(0, 600);
        }
        dirty = true; unsaved += add;
        if (unsaved >= saveEveryMs) { trim(); flush(); }
        return add;
    }
    return {
        /** 有过一次操作。 */
        touch() { const at = now(); if (!lastTick) lastTick = at; lastActive = at; },
        tick,
        /** 这个角色刚有一条新消息（发出或收到）：记下最后一次聊天的时间。 */
        message() {
            const who = character(); if (!who?.key) return;
            const item = data.chars[who.key] ||= { name: '', ms: 0, last: 0 };
            item.last = now(); if (who.name) item.name = String(who.name).slice(0, 120); if (who.avatar) item.avatar = String(who.avatar).slice(0, 600);
            dirty = true;
        },
        flush() { tick(); trim(); flush(); },
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
/** 一个季度的起止（shift：往前或往后几个季度）。 */
export function quarterRange(at, shift = 0) {
    const d = new Date(at), quarter = Math.floor(d.getMonth() / 3) + shift;
    return { from: new Date(d.getFullYear(), quarter * 3, 1).getTime(), to: new Date(d.getFullYear(), quarter * 3 + 3, 0).getTime() };
}
/** 热力格：一列一周（周一到周日），列数跟着所选范围走。越深用得越久；范围外与还没到的日子不画。 */
export function heatCells(data, from, to, at = Date.now()) {
    const usage = normalizeUsage(data), today = startOfDay(at), start = startOfDay(Math.min(from, to)), end = startOfDay(Math.max(from, to));
    const first = weekStartOf(start), weeks = Math.round((weekStartOf(end) - first) / (7 * DAY)) + 1, cells = [];
    let max = 0, total = 0;
    for (let column = 0; column < weeks; column++) for (let row = 0; row < 7; row++) {
        const time = addDays(first, column * 7 + row), inside = time >= start && time <= end && time <= today, ms = inside ? usage.days[dayKey(time)] || 0 : null;
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
    const timer = window.setInterval(() => tracker.tick(), tickMs);
    return () => { for (const name of names) document.removeEventListener(name, touch, options); document.removeEventListener('visibilitychange', leave); window.removeEventListener('pagehide', bye); window.clearInterval(timer); tracker.flush(); };
}
