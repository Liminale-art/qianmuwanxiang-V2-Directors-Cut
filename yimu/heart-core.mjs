// 心迹页的前端逻辑：日记整理（痕迹归成印象、从记忆里拾出年表节点）的请求与解析，
// 主模型顺带写的那则心迹的要求与摘取，以及开了注入时带进请求的那一小段。数据规则在 heart-contract.mjs。
import { composePrompt, heartNotePrompt, heartChroniclePrompt, heartDiaryPrompt } from './prompt-settings.mjs';
import { heartOf, gradeOf, SURE_WORDS, HEART_LIMITS } from './heart-contract.mjs';

export const HEART_TAG = '忆幕之心迹';
/** 攒够这么多条没看过的痕迹，就值得单独整理一次日记（阶段总结完成时不论多少都整理）。 */
export const DIARY_TRACE_TRIGGER = 12;
const DIARY_TRACE_BATCH = 40, CHRONICLE_ITEMS = 12;
const plain = value => String(value || '').normalize('NFKC').toLowerCase().trim();
const fill = (text, names) => String(text).replaceAll('{{char}}', names.char).replaceAll('{{user}}', names.user || '用户');
const pad = value => String(value).padStart(2, '0');
/** 缺剧情日期时退回现实里的日子。 */
export const realDay = at => { const d = new Date(at); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
export const traceDay = item => item.date || realDay(item.at);
const parseJson = response => { try { return JSON.parse(String(response || '').trim().replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/, '$1')); } catch { return null; } };
const rangeOf = entry => entry.source?.ranges?.length ? { start: Math.min(...entry.source.ranges.map(r => r.start)), end: Math.max(...entry.source.ranges.map(r => r.end)) } : entry.source ? { start: entry.source.start, end: entry.source.end } : null;

/** 这次日记整理有什么可做：还没看过的痕迹（观察日记），年表还没读到的记忆切片（关系年表）。没有就返回 null。 */
export function diaryWork(document, settings) {
    const heart = heartOf(document);
    const traces = settings.diary === false ? [] : (document.observations || []).filter(item => !item.used).slice(0, DIARY_TRACE_BATCH);
    const slices = settings.chronicle === false ? [] : (document.entries || [])
        .filter(entry => entry.kind === 'summary' && entry.status === 'active' && !entry.origin && !entry.replacedBy && entry.source?.start > heart.eventFloor)
        .sort((a, b) => a.source.start - b.source.start);
    return traces.length || slices.length ? { traces, slices, heart } : null;
}

export function diaryPrompt(settings, names, work) {
    const limit = settings.diaryChars || 60, parts = [], data = [];
    if (work.traces.length) {
        parts.push(`"impressions":[{"id":"沿用已有印象时填它的编号，新印象省略","about":"人名","text":"一句话，不超过${limit}字","traces":[归入这条印象的新痕迹序号],"was":"改口时填原先的说法，否则省略"}]`);
        data.push(`已有印象：${JSON.stringify(work.heart.impressions.map(item => ({ id: item.id, about: item.about, text: item.text, days: item.days.length })))}`,
            `新痕迹：${JSON.stringify(work.traces.map((item, index) => ({ n: index + 1, about: item.about, text: item.text, day: traceDay(item) })))}`);
    }
    if (work.slices.length) {
        parts.push('"events":[{"title":"不超过12字的短名","text":"一两句，不超过120字","floor":依据所在楼层整数}]');
        data.push(`已有年表：${JSON.stringify(work.heart.events.slice(-60).map(item => ({ title: item.title, floor: item.floor })))}`,
            `记忆：${JSON.stringify(work.slices.map(entry => ({ start: entry.source.start, end: entry.source.end, date: entry.scenes?.find(scene => scene?.date)?.date || '', text: entry.text })))}`);
    }
    const rules = [`输出一个JSON对象，不用Markdown：{${parts.join(',')}}。`];
    if (work.traces.length) rules.push('每条新痕迹至多归入一条印象；归不进已有印象的可以新开一条，哪怕暂时只有它一条依据——它会先留着，等别的日子再看见。impressions 只列这次有新痕迹归入或需要改口的，没有就返回空数组。');
    if (work.slices.length) rules.push(`events 的 floor 必须落在所给记忆的楼层范围内；已有年表里写过的不再写；这次最多 ${CHRONICLE_ITEMS} 条，没有节点返回空数组。`);
    const only = entry => entry.id === 'heart-diary' ? work.traces.length > 0 : entry.id === 'heart-chronicle' ? work.slices.length > 0 : true;
    return fill(composePrompt(settings, 'heart', { protocol: rules.join('\n'), data: data.join('\n'), only }), names);
}

/** 关系年表跟着每一批切片总结走：总结请求里本来就带着这段正文，顺带让模型直接依据正文拾出节点（用户 2026-11-21）。
 *  返回并进总结请求的两段文字（输出要求、已有年表）；年表关着、提示词停用或没有角色名时返回 null。 */
export const CHRONICLE_PER_BATCH = 2; // 用户 2026-11-25：每批 1–2 条，只留真正的节点
export function chronicleAsk(settings, names, document) {
    const guide = settings?.chronicle === false || !String(names?.char || '').trim() ? '' : heartChroniclePrompt(settings);
    if (!guide) return null;
    return {
        // 衔接语是用户 2026-11-21 的修订稿；中间接用户可编辑的「关系年表」提示词，末尾是固定的格式。
        protocol: fill(`另外返回"events"字段：从本次正文中提取 0–${CHRONICLE_PER_BATCH} 条关系年表节点。节点覆盖各类具备里程碑意义的首次事件（如首次正式接触、首次进入新环境、确认关系等）与仪式性事件（如婚礼）；仅收录本次正文内明确发生的内容，日常相处不计入；已录入既有年表的节点不再重复输出，无符合条件的节点则返回空数组。\n${guide}\n格式：{"title":"不超过12字的短名","text":"一两句，不超过120字","floor":依据所在楼层整数}。`, names),
        // 参照最近两段阶段总结：看得到前情，才判断得出这一段算不算关系上的节点。
        data: [`已有年表：${JSON.stringify(heartOf(document).events.slice(-60).map(item => ({ title: item.title, floor: item.floor })))}`,
            ...((document?.entries || []).filter(entry => entry.kind === 'stage' && entry.status === 'active').slice(-2).map(entry => `前情（阶段总结）：${JSON.stringify({ title: entry.title || '', text: entry.text })}`))].join('\n'),
    };
}
/** 从正文补全：只要痕迹与年表节点，不出切片。observation、chronicle 是切片总结里用的那两段输出要求，原样沿用。 */
export function fillPrompt(settings, rows, { observation = '', chronicle = null } = {}) {
    const fields = [observation ? '"traces":[]' : '', chronicle ? '"events":[]' : ''].filter(Boolean).join(',');
    return composePrompt(settings, 'heart', { only: () => false,
        protocol: [`输出一个JSON对象，不用Markdown：{${fields}}。`, observation, chronicle?.protocol].filter(Boolean).join('\n'),
        data: [`原文：${JSON.stringify(rows)}`, chronicle?.data].filter(Boolean).join('\n') });
}
/** 从切片总结的返回里读出年表节点：楼层必须落在这一批里，格式不对的逐条丢掉。 */
export function parseChronicle(response, { start, end }, slices = []) {
    const parsed = parseJson(response), seen = new Set();
    return (Array.isArray(parsed?.events) ? parsed.events : []).flatMap(item => {
        const title = typeof item?.title === 'string' ? item.title.trim().slice(0, 60) : '', text = typeof item?.text === 'string' ? item.text.trim() : '';
        const floor = Number.isSafeInteger(item?.floor) && item.floor >= start && item.floor <= end ? item.floor : null;
        if (!title || !text || text.length > 600 || floor === null || seen.has(`${floor}\n${title}`)) return [];
        seen.add(`${floor}\n${title}`);
        const date = slices.find(entry => entry.source.start <= floor && entry.source.end >= floor)?.scenes?.find(scene => scene?.date)?.date;
        return [{ title, text, floor, ...(date ? { date: String(date).slice(0, 60) } : {}) }];
    }).slice(0, CHRONICLE_PER_BATCH);
}

/** 心间存照跟着切片总结走（用户 2026-11-24：分开调用有分裂感，存照读不到原文就像第三方流水账）。
 *  总结请求里本来就带着这段正文：让模型以 {{char}} 的眼光，把这一批刚留意到的事连同已有印象直接归拢成心间存照。
 *  返回并进总结请求的两段文字；存照关着、提示词停用或没有角色名时返回 null（那时只记痕迹，等手动合订）。 */
export function impressionAsk(settings, names, document) {
    const guide = settings?.diary === false || !String(names?.char || '').trim() ? '' : heartDiaryPrompt(settings);
    if (!guide) return null;
    const limit = settings.diaryChars || 60;
    return {
        // 衔接语是助手写的（2026-11-24），待用户审；中间接用户可编辑的「心间存照」提示词，末尾是固定的格式。
        protocol: fill(`另外返回"impressions"字段：读完这段正文，以{{char}}自己的眼光，把上面"traces"里这次留意到的事归进{{char}}心里的印象。\n${guide}\n只列这次有新痕迹归入、或需要改口的印象，没有就返回空数组。每条新痕迹至多归入一条；归不进已有印象的可新开一条。格式：{"id":"沿用已有印象时填它的编号，新印象省略","about":"人名","text":"一句话，不超过${limit}字","traces":[归入这条印象的痕迹在"traces"里的序号，从1数起],"was":"改口时填原先的说法，否则省略"}。`, names),
        data: `已有印象：${JSON.stringify(heartOf(document).impressions.map(item => ({ id: item.id, about: item.about, text: item.text, days: item.days.length })))}`,
    };
}
/** 从切片总结的返回里读出印象。traces 是这一批刚存下的痕迹（顺序与返回里的 "traces" 一致）。 */
export function parseImpressions(response, traces, heart) {
    const parsed = parseJson(response);
    return parsed && typeof parsed === 'object' ? readImpressions(parsed, { traces, heart }) : [];
}
/** 读回整理结果。格式不对的逐条丢掉；整份读不出来才算失败。 */
export function parseDiary(response, work) {
    const parsed = parseJson(response);
    if (!parsed || typeof parsed !== 'object') throw new Error('日记整理结果不是有效 JSON，未采用');
    const impressions = readImpressions(parsed, work);
    const first = work.slices[0]?.source.start ?? 1, last = work.slices.at(-1)?.source.end ?? 0, seen = new Set();
    const events = (Array.isArray(parsed.events) ? parsed.events : []).flatMap(item => {
        const title = typeof item?.title === 'string' ? item.title.trim().slice(0, 60) : '', text = typeof item?.text === 'string' ? item.text.trim() : '';
        const floor = Number.isSafeInteger(item?.floor) && item.floor >= first && item.floor <= last ? item.floor : null;
        if (!title || !text || text.length > 600 || floor === null || seen.has(`${floor}\n${title}`)) return [];
        seen.add(`${floor}\n${title}`);
        const date = work.slices.find(entry => entry.source.start <= floor && entry.source.end >= floor)?.scenes?.find(scene => scene?.date)?.date;
        return [{ title, text, floor, ...(date ? { date: String(date).slice(0, 60) } : {}) }];
    }).slice(0, CHRONICLE_ITEMS);
    return { impressions, events };
}
function readImpressions(parsed, work) {
    const known = new Set(work.heart.impressions.map(item => item.id)), taken = new Set();
    return (Array.isArray(parsed.impressions) ? parsed.impressions : []).flatMap(item => {
        const about = typeof item?.about === 'string' ? item.about.trim().slice(0, 120) : '', text = typeof item?.text === 'string' ? item.text.trim() : '';
        if (!about || !text || text.length > 400) return [];
        const traces = (Array.isArray(item.traces) ? item.traces : []).flatMap(n => {
            const trace = Number.isSafeInteger(n) ? work.traces[n - 1] : null;
            if (!trace || taken.has(trace.id)) return [];
            taken.add(trace.id);
            return [{ id: trace.id, day: traceDay(trace).slice(0, 60) }];
        });
        const id = typeof item.id === 'string' && known.has(item.id) ? item.id : undefined;
        if (!id && !traces.length) return [];
        const was = id && typeof item.was === 'string' && item.was.trim() ? item.was.trim().slice(0, 400) : undefined;
        return [{ ...(id ? { id } : {}), about, text, traces, ...(was ? { was } : {}) }];
    }).slice(0, HEART_LIMITS.batch);
}

/** 这一轮回复要不要顺带写心迹：开关开着、聊天补全、有提示词、离上一则够远（用户 2026-11-21：不再要求期间完成过阶段总结）。
 *  同一层重新生成时照旧再要一次——只认最后留下的那条回复。 */
export function thoughtDue(document, settings, snapshot, type = '') {
    if (settings.thoughts !== true || snapshot?.mainApi !== 'openai' || !String(snapshot?.name || '').trim() || !heartNotePrompt(settings)) return null;
    const heart = heartOf(document), floor = snapshot.messages.length + (type === 'swipe' ? 0 : 1);
    if (heart.thoughtFloor && floor === heart.thoughtFloor) return { floor };
    return floor - heart.thoughtFloor < (settings.thoughtCooldown || 10) ? null : { floor };
}
export function thoughtRequest(settings, names) {
    const base = heartNotePrompt(settings);
    if (!base) return '';
    return fill(`${base}\n格式：<${HEART_TAG} 对象="写的是谁：{{user}}、自己、某个人的名字，或书名">不超过 ${settings.thoughtChars || 200} 字</${HEART_TAG}>。这一段放在回复最末，只出现一次；没有就整段省略。`, names);
}
const THOUGHT_BLOCK = new RegExp(`<${HEART_TAG}([^>]*)>([\\s\\S]*?)(?:</${HEART_TAG}>|$)`);
/** 从回复里摘出心迹。返回 { item, cleaned }：item 为空表示这次没写；cleaned 是去掉这一段后的正文。 */
export function takeThought(message, names, { books = [] } = {}) {
    const source = String(message || ''), match = source.match(THOUGHT_BLOCK);
    if (!match) return { item: null, cleaned: source };
    const cleaned = (source.slice(0, match.index) + source.slice(match.index + match[0].length)).replace(/\s+$/, '');
    const text = match[2].trim();
    // 回复在这一段中途被截断（没有收尾标签）：半句心里话不收，正文里照样去掉。
    if (!text || text.length > 2000 || !match[0].includes(`</${HEART_TAG}>`)) return { item: null, cleaned };
    const raw = (match[1].match(/对象\s*=\s*["“']([^"”']*)["”']/)?.[1] || '').trim().slice(0, 120);
    const user = String(names.user || '').trim(), char = String(names.char || '').trim(), key = plain(raw).replace(/[《》]/g, '');
    const group = !raw || key === plain(user) || ['你', '用户', '{{user}}'].includes(key) ? 'you'
        : ['自己', '我', '我自己', plain(char)].includes(key) ? 'self'
        : /[《》]/.test(raw) || books.some(title => plain(title) === key) ? 'books' : 'others';
    const about = group === 'you' ? user || '你' : group === 'self' ? '自己' : raw;
    return { item: { group, about, text }, cleaned };
}

/** 心间存照改由主模型写回复时顺带写（用户 2026-11-25：总结模型看不到预设与角色卡，写出来与正文割裂）。
 *  与心迹同一个间隔（「心迹与存照间隔层数」）；同一层重新生成时照旧再要一次，只认最后留下的那条回复。 */
export const IMPRESSION_TAG = '忆幕之存照';
export const IMPRESSIONS_PER_ROUND = 2;
export function impressionDue(document, settings, snapshot, type = '') {
    if (settings.diary === false || snapshot?.mainApi !== 'openai' || !String(snapshot?.name || '').trim() || !heartDiaryPrompt(settings)) return null;
    const heart = heartOf(document), last = heart.impressionFloor || 0, floor = snapshot.messages.length + (type === 'swipe' ? 0 : 1);
    if (last && floor === last) return { floor };
    return floor - last < (settings.thoughtCooldown || 10) ? null : { floor };
}
/** 给主模型的要求：用户可编辑的「心间存照」提示词，接一段固定的格式与已有印象（好让它延展或改口，而不是另起一条重复的）。
 *  衔接语是用户 2026-11-25 的修订稿（已定稿）。 */
export function impressionRequest(settings, names, document) {
    const base = heartDiaryPrompt(settings);
    if (!base) return '';
    const limit = settings.diaryChars || 60;
    const existing = heartOf(document).impressions.slice(-40).map(item => ({ 编号: item.id, 对象: item.about, 印象: item.text }));
    return fill(`${base}\n本轮正文完成后，可追加0–${IMPRESSIONS_PER_ROUND}条以{{char}}内心对{{user}}或其他角色的印象，单条独立成段：<${IMPRESSION_TAG} 对象="对应人物" 把握体察确信层级="也许、我觉得或笃定" 沿用="延展或修正既有印象时填写对应编号，新印象不填">不超过 ${limit} 字</${IMPRESSION_TAG}>。本轮无全新体察则整段省略。与已有印象同源同指的内容，沿用原编号延展表述，不重复增设独立条目。\n已有印象：${JSON.stringify(existing)}`, names);
}
const IMPRESSION_BLOCK = new RegExp(`<${IMPRESSION_TAG}([^>]*)>([\\s\\S]*?)(?:</${IMPRESSION_TAG}>|$)`, 'g');
const SURE_OF_WORD = { '也许': 1, '我觉得': 2, '笃定': 3 };
// 属性名只认开头（「把握」也认「把握体察确信层级」这类写长了的名字）。
const attribute = (raw, name) => (raw.match(new RegExp(`${name}[^=\\s"“']*\\s*=\\s*["“']([^"”']*)["”']`))?.[1] || '').trim();
/** 从回复里摘出存照。返回 { items, cleaned }：items 为空表示这次没写；cleaned 是去掉这些段后的正文。 */
export function takeImpressions(message, names, document, { day = '' } = {}) {
    const source = String(message || ''), known = new Set(heartOf(document).impressions.map(item => item.id)), items = [], used = new Set();
    const cleaned = source.replace(IMPRESSION_BLOCK, (whole, raw, body) => {
        const text = String(body || '').trim(), about = attribute(raw, '对象').slice(0, 120) || String(names.user || '').trim();
        if (!whole.includes(`</${IMPRESSION_TAG}>`)) return ''; // 截断在半句：不收
        const keep = attribute(raw, '沿用'), sure = SURE_OF_WORD[attribute(raw, '把握')];
        if (text && text.length <= 400 && about && items.length < IMPRESSIONS_PER_ROUND) {
            const id = known.has(keep) && !used.has(keep) ? keep : undefined;
            if (id) used.add(id);
            items.push({ ...(id ? { id } : {}), about, text, ...(sure ? { sure } : {}), direct: { day: String(day || '').slice(0, 60) } });
        }
        return '';
    }).replace(/\s+$/, '');
    return { items: items.filter(item => item.direct.day), cleaned };
}

/** 开了注入时带进请求的一小段：出场的人的印象最多三条，心迹最多一则（受「刚提过」冷却约束）。 */
export function heartInjection(document, settings, snapshot, { type = '', recalledAt = null } = {}) {
    if (settings.diaryInject !== true && settings.thoughtInject !== true) return { text: '', ids: [] };
    const heart = heartOf(document), end = snapshot.messages.length - (type === 'swipe' ? 1 : 0);
    const spoken = plain(snapshot.messages.slice(Math.max(0, end - Math.max(1, settings.recent || 3)), end).map(message => message.mes || '').join('\n'));
    const user = plain(snapshot.userName), present = name => { const key = plain(name).replace(/[《》]/g, ''); return key.length >= 1 && (key === user || key.length >= 2 && spoken.includes(key)); };
    const impressions = settings.diaryInject !== true ? [] : heart.impressions.map(item => ({ item, sure: gradeOf(item) }))
        .filter(({ item, sure }) => sure >= 1 && present(item.about))
        .sort((a, b) => b.sure - a.sure || b.item.updatedAt - a.item.updatedAt).slice(0, 3);
    const cooldown = settings.recallCooldown || 0;
    const thought = settings.thoughtInject !== true ? null : [...heart.thoughts].reverse().find(item => {
        if (!['you', 'self'].includes(item.group) && !present(item.about)) return false;
        const last = recalledAt?.get?.(`heart:${item.id}`);
        return !(cooldown > 0 && Number.isFinite(last) && end - last < cooldown);
    });
    if (!impressions.length && !thought) return { text: '', ids: [] };
    const char = String(snapshot.name || '').trim() || '角色';
    const body = { ...(impressions.length ? { impressions: impressions.map(({ item, sure }) => ({ about: item.about, text: item.text, sure: SURE_WORDS[sure] })) } : {}),
        ...(thought ? { thought: { about: thought.about, text: thought.text } } : {}) };
    return { ids: thought ? [`heart:${thought.id}`] : [],
        text: `<yimu_heart>\n以下是${char}心里对人的印象与看法：是心里话，不是事实，也不必说出口；只在自然的时候影响态度与措辞，不照着复述。\n${JSON.stringify(body)}\n</yimu_heart>` };
}
