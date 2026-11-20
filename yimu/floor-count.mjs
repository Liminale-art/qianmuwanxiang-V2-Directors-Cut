// 楼层计数：和每个角色一共聊了多少层。只做计数，不读消息内容、不碰记忆与聊天本身。
// 记法：每个聊天文件记下「见过的最大楼层数」，角色的总数是它名下所有聊天之和。于是——
//   · 只增不减：删楼层、删聊天文件都不会让数字变小（那份记录留着）；
//   · 所有聊天窗口都算：当前打开的聊天随时更新，其余聊天从酒馆的聊天列表里取条数；
//   · 只按角色（头像文件名）记，与用户用哪个身份无关。
// 聊天改名时靠聊天自带的标识认出是同一个，不会算两遍（改名前至少打开过一次才认得出）。
// 存在酒馆的账户设置里（extensionSettings 的 qm_floor_counts），千幕与忆幕读写的是同一份。
// 本文件在千幕与忆幕里各有一份、内容完全相同（两个扩展分开发行，互相不能导入），有测试核对。

export const FLOOR_KEY = 'qm_floor_counts';
const whole = value => Number.isSafeInteger(value) && value > 0 ? value : 0;
const fileKey = value => String(value ?? '').replace(/\.jsonl$/i, '').slice(0, 300);
const plain = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};

/** 读入已存的计数；格式不对的部分丢掉，绝不抛错。 */
export function normalizeFloors(value) {
    const out = { version: 1, chars: {} };
    for (const [avatar, raw] of Object.entries(plain(plain(value).chars))) {
        if (!avatar || avatar.length > 300) continue;
        const item = { name: String(plain(raw).name || '').slice(0, 120), chats: {}, ids: {} };
        for (const [file, count] of Object.entries(plain(plain(raw).chats))) if (fileKey(file) && whole(count)) item.chats[fileKey(file)] = count;
        for (const [id, file] of Object.entries(plain(plain(raw).ids))) if (id && id.length <= 100 && item.chats[fileKey(file)]) item.ids[id] = fileKey(file);
        out.chars[avatar] = item;
    }
    return out;
}

const entry = (store, avatar, name) => {
    const item = store.chars[avatar] ||= { name: '', chats: {}, ids: {} };
    if (name && item.name !== name) item.name = String(name).slice(0, 120);
    return item;
};

/** 记一个聊天当前的楼层数。返回有没有变。id 是聊天自带的标识（改名后不变），可不给。 */
export function recordChat(store, avatar, { file, count, id = '', name = '' } = {}) {
    const key = fileKey(file);
    if (!avatar || !key) return false;
    const before = JSON.stringify(store.chars[avatar] || null), item = entry(store, avatar, name);
    const known = id ? item.ids[id] : '';
    if (known && known !== key) { // 同一个聊天改了名：把旧名下的数挪过来，不留两份
        item.chats[key] = Math.max(whole(item.chats[key]), whole(item.chats[known]));
        delete item.chats[known];
    }
    if (whole(count) > whole(item.chats[key])) item.chats[key] = count;
    if (id && id.length <= 100 && item.chats[key]) item.ids[id] = key;
    return JSON.stringify(item) !== before;
}

/** 记这个角色名下所有聊天的条数（酒馆聊天列表给的）。列表里没有的聊天（已删除）原样留着。 */
export function recordList(store, avatar, list, name = '') {
    let changed = false;
    for (const row of Array.isArray(list) ? list : []) if (recordChat(store, avatar, { file: row?.file_name ?? row?.file, count: row?.chat_items ?? row?.count, name })) changed = true;
    return changed;
}

export const chatFloors = (store, avatar, file) => whole(store?.chars?.[avatar]?.chats?.[fileKey(file)]);
export const floorTotal = (store, avatar) => Object.values(plain(store?.chars?.[avatar]?.chats)).reduce((sum, count) => sum + whole(count), 0);
/** 按楼层数从多到少排的角色。 */
export function floorRanking(store) {
    return Object.keys(plain(store?.chars)).map(key => ({ key, name: store.chars[key].name || '', floors: floorTotal(store, key) })).filter(item => item.floors > 0).sort((a, b) => b.floors - a.floors || a.key.localeCompare(b.key));
}

/** 接到酒馆上。touch()：记下当前聊天并返回 { chat, total }（群聊或没开聊天时是 null），不发请求；
 * sync()：把这个角色的聊天列表过一遍（一次请求，同一角色十分钟内不重复），有变化返回 true。 */
export function createFloorCounter({ getContext, fetch = globalThis.fetch?.bind(globalThis), now = () => Date.now(), syncEveryMs = 600000 } = {}) {
    const ready = new WeakSet(), synced = new Map();
    const open = () => {
        const ctx = getContext?.();
        if (!ctx?.extensionSettings || ctx.groupId) return null;
        const character = ctx.characters?.[ctx.characterId];
        if (!character?.avatar) return null;
        let store = ctx.extensionSettings[FLOOR_KEY];
        if (!store || !ready.has(store)) { store = ctx.extensionSettings[FLOOR_KEY] = normalizeFloors(store); ready.add(store); }
        return { ctx, store, avatar: character.avatar, name: character.name || '' };
    };
    const store = () => { const at = getContext?.()?.extensionSettings?.[FLOOR_KEY]; return at && ready.has(at) ? at : normalizeFloors(at); };
    async function sync(force = false) {
        const at = open();
        if (!at || typeof fetch !== 'function') return false;
        if (!force && synced.has(at.avatar) && now() - synced.get(at.avatar) < syncEveryMs) return false;
        synced.set(at.avatar, now());
        try {
            const response = await fetch('/api/characters/chats', { method: 'POST', headers: { 'Content-Type': 'application/json', ...(at.ctx.getRequestHeaders?.() || {}) }, body: JSON.stringify({ avatar_url: at.avatar }) });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const list = await response.json();
            if (!recordList(at.store, at.avatar, list, at.name)) return false;
            at.ctx.saveSettingsDebounced?.();
            return true;
        } catch (error) { synced.delete(at.avatar); console.warn('[楼层计数] 没取到这个角色的聊天列表，稍后再试', error); return false; }
    }
    function touch() {
        const at = open();
        if (!at) return null;
        const file = at.ctx.chatId;
        if (file && recordChat(at.store, at.avatar, { file, count: Array.isArray(at.ctx.chat) ? at.ctx.chat.length : 0, id: at.ctx.chatMetadata?.integrity || '', name: at.name })) at.ctx.saveSettingsDebounced?.();
        return { chat: file ? chatFloors(at.store, at.avatar, file) : 0, total: floorTotal(at.store, at.avatar) };
    }
    return { touch, sync, store };
}
