// 忆幕日志：只存在本机浏览器里，不进账户、不进聊天、不含密钥。
// 记两类事：每次整理（范围、耗时、模型原始返回、结果或失败原因）与每轮生成（带了几条、隐藏到哪层、为什么没带）。
// 条数与单条正文都有上限，写不下时丢最旧的；日志坏了或存不下，绝不影响整理与生成本身。
const KEY = 'yimu:journal:v1';
export const JOURNAL_LIMIT = 80;        // 最多保留多少条
export const JOURNAL_RAW_LIMIT = 24000; // 单条原始返回最多保留多少字

const clip = (value, limit) => {
    const text = typeof value === 'string' ? value : '';
    return text.length > limit ? `${text.slice(0, limit)}\n…（其余 ${text.length - limit} 字已省略）` : text;
};

export function createJournal({ storage = globalThis.localStorage ?? null, key = KEY, limit = JOURNAL_LIMIT, now = () => Date.now() } = {}) {
    let entries = [], sequence = 0;
    const listeners = new Set();
    try {
        const saved = JSON.parse(storage?.getItem(key) || '[]');
        // 上次页面关闭时还在进行的条目，结果已无从得知：如实标成未完成，而不是一直显示「进行中」。
        if (Array.isArray(saved)) entries = saved.filter(item => item && typeof item === 'object' && typeof item.id === 'string')
            .map(item => item.status === 'loading' ? { ...item, status: 'cancelled', error: item.error || '页面关闭时尚未完成' } : item);
    } catch { entries = []; }
    const persist = () => {
        // 存不下就再丢一半旧的重试；仍失败则放弃这次落盘（内存里的日志本次会话仍可看）。
        for (let keep = entries.length; keep >= 0; keep = Math.floor(keep / 2)) {
            try { storage?.setItem(key, JSON.stringify(entries.slice(0, keep))); return; } catch { if (!keep) return; }
        }
    };
    const publish = () => { for (const listener of listeners) try { listener(); } catch { /* 界面出错不影响记录 */ } };
    const tidy = entry => ({ ...entry, ...(entry.raw !== undefined ? { raw: clip(entry.raw, JOURNAL_RAW_LIMIT) } : {}),
        ...(entry.error !== undefined ? { error: clip(String(entry.error ?? ''), 600) } : {}) });
    return {
        /** 新的在前。返回的是副本，调用方改它不会改到日志。 */
        list() { return entries.map(entry => ({ ...entry })); },
        add(entry) {
            const id = `j${now().toString(36)}${(sequence++).toString(36)}`;
            entries = [tidy({ ...entry, id, at: now() }), ...entries].slice(0, limit);
            persist(); publish();
            return id;
        },
        /** persist:false 用于流式过程中的高频更新：只改内存、通知界面，不每个分块都写一次本机存储。 */
        update(id, patch, { persist: save = true } = {}) {
            const index = entries.findIndex(entry => entry.id === id);
            if (index < 0) return false;
            entries = entries.map((entry, at) => at === index ? tidy({ ...entry, ...patch, id: entry.id, at: entry.at }) : entry);
            if (save) persist();
            publish();
            return true;
        },
        clear() { entries = []; persist(); publish(); },
        subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    };
}
