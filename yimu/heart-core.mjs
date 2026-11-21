// 心迹页的前端逻辑：日记整理（痕迹归成印象、从记忆里拾出年表节点）的请求与解析，
// 主模型顺带写的那则心迹的要求与摘取，以及开了注入时带进请求的那一小段。数据规则在 heart-contract.mjs。
import { composePrompt, heartNotePrompt, heartChroniclePrompt } from './prompt-settings.mjs';
import { heartOf, sureOf, SURE_WORDS, HEART_LIMITS } from './heart-contract.mjs';

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
export const CHRONICLE_PER_BATCH = 4;
export function chronicleAsk(settings, names, document) {
    const guide = settings?.chronicle === false || !String(names?.char || '').trim() ? '' : heartChroniclePrompt(settings);
    if (!guide) return null;
    return {
        protocol: fill(`另外返回 "events"：0 到 ${CHRONICLE_PER_BATCH} 条关系年表节点，直接依据这段正文。\n${guide}\n各种「第一次」（第一次正式接触、第一次去到对方的世界或住处）与婚礼这类仪式都算节点；只写这段正文里确实发生了的，日常相处不算；已有年表里写过的不再写；没有节点就返回空数组。格式：{"title":"不超过12字的短名","text":"一两句，不超过120字","floor":依据所在楼层整数}。`, names),
        data: `已有年表：${JSON.stringify(heartOf(document).events.slice(-60).map(item => ({ title: item.title, floor: item.floor })))}`,
    };
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

/** 读回整理结果。格式不对的逐条丢掉；整份读不出来才算失败。 */
export function parseDiary(response, work) {
    const parsed = parseJson(response);
    if (!parsed || typeof parsed !== 'object') throw new Error('日记整理结果不是有效 JSON，未采用');
    const known = new Set(work.heart.impressions.map(item => item.id)), taken = new Set();
    const impressions = (Array.isArray(parsed.impressions) ? parsed.impressions : []).flatMap(item => {
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

/** 这一轮回复要不要顺带写心迹：开关开着、聊天补全、有提示词、离上一则够远，并且这期间完成过一次阶段总结。
 *  同一层重新生成时照旧再要一次——只认最后留下的那条回复。 */
export function thoughtDue(document, settings, snapshot, type = '') {
    if (settings.thoughts !== true || snapshot?.mainApi !== 'openai' || !String(snapshot?.name || '').trim() || !heartNotePrompt(settings)) return null;
    const heart = heartOf(document), floor = snapshot.messages.length + (type === 'swipe' ? 0 : 1);
    if (heart.thoughtFloor && floor === heart.thoughtFloor) return { floor };
    if (floor - heart.thoughtFloor < (settings.thoughtCooldown || 30)) return null;
    const staged = (document.entries || []).some(entry => entry.kind === 'stage' && entry.status === 'active' && (rangeOf(entry)?.end ?? 0) > heart.thoughtFloor);
    return staged ? { floor } : null;
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
    if (!text || text.length > 2000) return { item: null, cleaned };
    const raw = (match[1].match(/对象\s*=\s*["“']([^"”']*)["”']/)?.[1] || '').trim().slice(0, 120);
    const user = String(names.user || '').trim(), char = String(names.char || '').trim(), key = plain(raw).replace(/[《》]/g, '');
    const group = !raw || key === plain(user) || ['你', '用户', '{{user}}'].includes(key) ? 'you'
        : ['自己', '我', '我自己', plain(char)].includes(key) ? 'self'
        : /[《》]/.test(raw) || books.some(title => plain(title) === key) ? 'books' : 'others';
    const about = group === 'you' ? user || '你' : group === 'self' ? '自己' : raw;
    return { item: { group, about, text }, cleaned };
}

/** 开了注入时带进请求的一小段：出场的人的印象最多三条，心迹最多一则（受「刚提过」冷却约束）。 */
export function heartInjection(document, settings, snapshot, { type = '', recalledAt = null } = {}) {
    if (settings.diaryInject !== true && settings.thoughtInject !== true) return { text: '', ids: [] };
    const heart = heartOf(document), end = snapshot.messages.length - (type === 'swipe' ? 1 : 0);
    const spoken = plain(snapshot.messages.slice(Math.max(0, end - Math.max(1, settings.recent || 3)), end).map(message => message.mes || '').join('\n'));
    const user = plain(snapshot.userName), present = name => { const key = plain(name).replace(/[《》]/g, ''); return key.length >= 1 && (key === user || key.length >= 2 && spoken.includes(key)); };
    const impressions = settings.diaryInject !== true ? [] : heart.impressions.map(item => ({ item, sure: sureOf(item.days.length) }))
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
