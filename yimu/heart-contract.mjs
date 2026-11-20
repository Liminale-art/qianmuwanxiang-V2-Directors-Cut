// 心迹页的三样东西：印象（观察日记）、心迹、关系年表。只有数据规则，前后端共用。
// 痕迹（document.observations）是原料：同一件事在不同的日子里被看见够多次，才凝成一条印象。
const fail = message => { throw Object.assign(new Error(message), { status: 400, statusCode: 400 }); };
const need = (ok, message) => { if (!ok) fail(message); };
const clone = value => structuredClone(value);
const idOf = value => { need(typeof value === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(value), '心迹条目标识无效'); return value; };
const str = (value, limit, label) => { const text = typeof value === 'string' ? value.trim() : ''; need(text && text.length <= limit, `${label}无效或过长`); return text; };
const stamp = value => { need(Number.isSafeInteger(value) && value >= 0, '心迹的记录时间无效'); return value; };
const floorOf = value => { need(Number.isSafeInteger(value) && value >= 1, '心迹的依据楼层无效'); return value; };

export const HEART_LIMITS = Object.freeze({ impressions: 300, thoughts: 300, events: 300, days: 12, batch: 40 });
export const THOUGHT_GROUPS = Object.freeze(['you', 'self', 'others', 'books']);
/** 把握程度只看「在几个不同的日子里看见过」：3 个日子起步，6 个日子笃定。不到 3 个的还只是留意，不算印象。 */
export const sureOf = days => days >= 6 ? 3 : days >= 4 ? 2 : days >= 3 ? 1 : 0;
export const SURE_WORDS = Object.freeze(['还在留意', '也许', '我觉得', '笃定']);

function validateDay(value) {
    need(value && typeof value === 'object' && !Array.isArray(value), '印象的依据无效');
    return { day: str(value.day, 60, '印象的日子'), text: str(value.text, 300, '印象的依据'), at: stamp(value.at) };
}
function validateImpression(value) {
    need(value && typeof value === 'object' && !Array.isArray(value), '印象格式无效');
    need(Array.isArray(value.days) && value.days.length >= 1 && value.days.length <= HEART_LIMITS.days, '印象的依据数量无效');
    const result = { id: idOf(value.id), about: str(value.about, 120, '印象的对象'), text: str(value.text, 400, '印象'), days: value.days.map(validateDay), at: stamp(value.at), updatedAt: stamp(value.updatedAt) };
    need(new Set(result.days.map(item => item.day)).size === result.days.length, '印象的日子重复');
    if (value.was !== undefined && value.was !== '') result.was = str(value.was, 400, '原先的印象');
    return result;
}
function validateThought(value) {
    need(value && typeof value === 'object' && !Array.isArray(value), '心迹格式无效');
    need(THOUGHT_GROUPS.includes(value.group), '心迹的对象类别无效');
    return { id: idOf(value.id), group: value.group, about: str(value.about, 120, '心迹的对象'), text: str(value.text, 2000, '心迹'), floor: floorOf(value.floor), at: stamp(value.at) };
}
function validateEvent(value) {
    need(value && typeof value === 'object' && !Array.isArray(value), '年表条目格式无效');
    const result = { id: idOf(value.id), title: str(value.title, 60, '年表标题'), text: str(value.text, 600, '年表内容'), floor: floorOf(value.floor), at: stamp(value.at) };
    if (value.date !== undefined && value.date !== '') result.date = str(value.date, 60, '年表日期');
    return result;
}
function unique(list, label) { const ids = new Set(); for (const item of list) { need(!ids.has(item.id), `${label}标识重复`); ids.add(item.id); } return list; }

export function validateHeart(value) {
    need(value && typeof value === 'object' && !Array.isArray(value), '心迹资料格式无效');
    const list = (key, check, label) => { const items = value[key] ?? []; need(Array.isArray(items) && items.length <= HEART_LIMITS[key], `${label}数量无效`); return unique(items.map(check), label); };
    const mark = key => { const number = value[key] ?? 0; need(Number.isSafeInteger(number) && number >= 0, '心迹的进度无效'); return number; };
    return { impressions: list('impressions', validateImpression, '印象'), thoughts: list('thoughts', validateThought, '心迹'), events: list('events', validateEvent, '年表'),
        eventFloor: mark('eventFloor'), thoughtFloor: mark('thoughtFloor') };
}
export const emptyHeart = () => ({ impressions: [], thoughts: [], events: [], eventFloor: 0, thoughtFloor: 0 });
export const heartOf = document => document?.heart ? clone(document.heart) : emptyHeart();
export const HEART_OPERATIONS = Object.freeze(['heartDiary', 'heartThought', 'heartRemove']);

/** 应用一次心迹操作，直接改 doc（调用方已复制过）。opId 用来给新条目编号。 */
export function applyHeartOperation(doc, op, opId) {
    const heart = heartOf(doc), at = stamp(op.at ?? 0);
    if (op.type === 'heartDiary') {
        // 一次日记整理的结果：新痕迹归进印象（沿用已有的，或新开一条），年表添上新的节点。
        need(Array.isArray(op.impressions) && op.impressions.length <= HEART_LIMITS.batch && Array.isArray(op.events) && op.events.length <= HEART_LIMITS.batch, '日记整理结果无效');
        const traces = new Map((doc.observations || []).map(item => [item.id, item])), used = new Set();
        op.impressions.forEach((item, index) => {
            need(item && typeof item === 'object' && Array.isArray(item.traces) && item.traces.length <= 60, '印象的依据无效');
            const fresh = item.traces.flatMap(ref => {
                const trace = traces.get(ref?.id);
                if (!trace) return []; // 整理期间这条痕迹已被重新总结换掉：跳过，不让整次结果作废。
                used.add(trace.id);
                return [{ day: str(ref.day, 60, '印象的日子'), text: trace.text, at: trace.at }];
            });
            const existing = typeof item.id === 'string' ? heart.impressions.find(entry => entry.id === item.id) : null;
            if (!existing && !fresh.length) return;
            const target = existing || { id: `${opId}_i${index}`.slice(0, 100), about: str(item.about, 120, '印象的对象'), text: '', days: [], at, updatedAt: at };
            const text = str(item.text, 400, '印象');
            if (existing && item.was !== undefined && item.was !== '' && text !== existing.text) target.was = str(item.was, 400, '原先的印象');
            target.text = text;
            const days = new Map(target.days.map(day => [day.day, day]));
            for (const day of fresh) if (!days.has(day.day)) days.set(day.day, day);
            // 只留最近的十二个日子作依据；笃定只要六个，够用。
            target.days = [...days.values()].sort((a, b) => a.at - b.at).slice(-HEART_LIMITS.days);
            if (fresh.length || text !== existing?.text) target.updatedAt = at;
            if (!existing) heart.impressions.push(target);
        });
        for (const ref of Array.isArray(op.used) ? op.used : []) if (traces.has(ref)) used.add(ref);
        if (used.size) doc.observations = (doc.observations || []).map(item => used.has(item.id) ? { ...item, used: true } : item);
        op.events.forEach((item, index) => {
            const event = validateEvent({ ...item, id: `${opId}_e${index}`.slice(0, 100), at });
            if (!heart.events.some(entry => entry.floor === event.floor && entry.title === event.title)) heart.events.push(event);
        });
        heart.events.sort((a, b) => a.floor - b.floor || a.at - b.at);
        if (op.eventFloor !== undefined) { need(Number.isSafeInteger(op.eventFloor) && op.eventFloor >= 0, '年表进度无效'); heart.eventFloor = Math.max(heart.eventFloor, op.eventFloor); }
    } else if (op.type === 'heartThought') {
        // 一则心迹。同一楼层重新生成时，新的顶掉旧的；模型这次没写（item 为空）也记下问过，不必每轮都问。
        const floor = floorOf(op.floor);
        heart.thoughts = heart.thoughts.filter(entry => entry.floor !== floor);
        if (op.item) {
            heart.thoughts.push(validateThought({ ...op.item, id: `${opId}_t`.slice(0, 100), floor, at }));
            heart.thoughts.sort((a, b) => a.floor - b.floor || a.at - b.at);
        }
        heart.thoughtFloor = Math.max(heart.thoughtFloor, floor);
    } else if (op.type === 'heartRemove') {
        const key = { impression: 'impressions', thought: 'thoughts', event: 'events' }[op.kind];
        need(key, '要删除的心迹类别无效');
        const before = heart[key].length;
        heart[key] = heart[key].filter(entry => entry.id !== op.itemId);
        need(heart[key].length < before, '这一条已经不在了');
    } else fail('未知的心迹操作');
    for (const key of ['impressions', 'thoughts', 'events']) if (heart[key].length > HEART_LIMITS[key]) heart[key] = heart[key].slice(-HEART_LIMITS[key]);
    doc.heart = validateHeart(heart);
}

/** 两份心迹资料合并（导入备份时用）：按标识去重，已有的不被覆盖。 */
export function mergeHeart(current, imported) {
    if (!imported) return current ? clone(current) : undefined;
    const base = current ? clone(current) : emptyHeart(), extra = validateHeart(imported);
    for (const key of ['impressions', 'thoughts', 'events']) {
        const have = new Set(base[key].map(item => item.id));
        base[key] = [...base[key], ...extra[key].filter(item => !have.has(item.id))].slice(-HEART_LIMITS[key]);
    }
    base.thoughts.sort((a, b) => a.floor - b.floor || a.at - b.at); base.events.sort((a, b) => a.floor - b.floor || a.at - b.at);
    base.eventFloor = Math.max(base.eventFloor, extra.eventFloor); base.thoughtFloor = Math.max(base.thoughtFloor, extra.thoughtFloor);
    return validateHeart(base);
}
/** 故事续接：印象整份带走（它不属于哪一层），心迹与年表只带续接点之前的。 */
export function carryHeart(heart, cutoff) {
    if (!heart) return undefined;
    const value = validateHeart(heart);
    const carried = { impressions: value.impressions, thoughts: value.thoughts.filter(item => item.floor <= cutoff), events: value.events.filter(item => item.floor <= cutoff),
        eventFloor: Math.min(value.eventFloor, cutoff), thoughtFloor: Math.min(value.thoughtFloor, cutoff) };
    return carried.impressions.length || carried.thoughts.length || carried.events.length ? carried : undefined;
}
