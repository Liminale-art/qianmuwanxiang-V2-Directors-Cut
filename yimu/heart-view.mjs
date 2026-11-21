// 心迹与观察日记：全屏的独立页面。三套主题各是一份完整的页面，放在 iframe 里，
// 所以不受千幕、忆幕本体主题的影响；左上角退出，右上角换主题，选过的主题记在本机。
// 这里只负责开合、换主题与把数据交给页面；页面长什么样全在 yimu/heart/ 的主题文件里。
import { HEART_THEMES } from './heart-themes.mjs';
import { gradeOf, SURE_WORDS } from './heart-contract.mjs';
import { fillPlan, FILL_BATCH_FLOORS } from './core.mjs';

const THEME_KEY = 'yimu:heart-theme:v1', FILL_PER_KEY = 'yimu:heart-fill-per:v1';
/** 补全每批几层：用户自己定，1–200，记在本机。 */
export const fillPerOf = value => { const n = Number(value); return Number.isSafeInteger(n) && n >= 1 && n <= 200 ? n : FILL_BATCH_FLOORS; };
const realDay = at => { const d = new Date(at); return `${d.getMonth() + 1}月${d.getDate()}日`; };
const dayOf = item => item.date || realDay(item.at);

/** 页面要的数据。每一项都带记下的时刻（at，系统时间），页面按它做日期筛选。
 *  impressions：在够多个不同日子里看见过、已成印象的（最近有动静的在前）；
 *  loose：还在留意的——没看过的痕迹，以及日子还不够的印象（新的在前）；
 *  thoughts：心迹（新的在前）；events：关系年表（按剧情先后）。 */
export function heartData(state = {}, floors = null, { fillPer = FILL_BATCH_FLOORS } = {}) {
    const document = state.document || {}, heart = document.heart || {};
    const observations = Array.isArray(document.observations) ? document.observations : [];
    const graded = (heart.impressions || []).map(item => ({ item, sure: gradeOf(item) }));
    const loose = [
        ...observations.filter(item => !item.used).map(item => ({ kind: 'trace', id: item.id, about: item.about, text: item.text, day: dayOf(item), floor: item.floor, at: item.at })),
        ...graded.filter(({ sure }) => sure === 0).map(({ item }) => ({ kind: 'impression', id: item.id, about: item.about, text: item.text, day: item.days.at(-1).day, at: item.updatedAt })),
    ].sort((a, b) => b.at - a.at).slice(0, 60);
    return {
        char: state.snapshot?.name || '', user: state.snapshot?.userName || '', avatar: state.snapshot?.avatarUrl || '',
        // 楼层计数：这个聊天多少层、和这个角色一共多少层（所有聊天合计，只增不减）。
        ...(floors?.total > 0 ? { floors: { chat: floors.chat || 0, total: floors.total } } : {}),
        // 补全：能不能做、大约几次请求、正在做到第几批。
        // last：能补到的最后一层（页面上从 0 数）；per：每批几层，页面据此估算请求次数。
        tools: (() => { const plan = document.enabled === true ? fillPlan(document, state.snapshot?.messages || []) : [];
            return { ready: document.enabled === true, pending: observations.filter(item => !item.used).length, batches: plan.length, first: plan.length ? plan[0].start - 1 : 0, last: plan.length ? plan.at(-1).end - 1 : 0, per: fillPer,
                fill: state.fillJob ? { done: state.fillJob.done, total: state.fillJob.total } : null, floors: state.snapshot?.messages?.length || 0 }; })(),
        impressions: graded.filter(({ sure }) => sure >= 1).sort((a, b) => b.item.updatedAt - a.item.updatedAt).map(({ item, sure }) => ({ id: item.id, about: item.about, say: item.text, sure, word: SURE_WORDS[sure], ...(item.own ? { own: true } : {}),
            days: item.days.map(day => [day.day, day.text]), stamps: item.days.map(day => day.at), ...(item.was ? { was: item.was } : {}), at: item.updatedAt })),
        loose,
        thoughts: [...(heart.thoughts || [])].reverse().map(item => ({ id: item.id, group: item.group, about: THOUGHT_LABELS[item.group](item.about), who: item.about, say: item.text, when: realDay(item.at), floor: item.floor, at: item.at })),
        events: (heart.events || []).map(item => ({ id: item.id, title: item.title, text: item.text, date: item.date || '', when: realDay(item.at), floor: item.floor, at: item.at })),
    };
}
const THOUGHT_LABELS = { you: name => `对${name}`, self: () => '对自己', others: name => `对${name}`, books: name => `读${/[《》]/.test(name) ? name : `《${name}》`}` };

const REMOVABLE = new Set(['impression', 'thought', 'event', 'trace']);
const EDITABLE = new Set(['impression', 'thought', 'event']);
const line = (value, limit) => typeof value === 'string' ? value.trim().slice(0, limit) : '';
/** 页面交来的表单：只取认识的字段。楼层在页面上从 0 数，存的时候从 1 数；没填就不带。 */
function heartFields(kind, raw = {}) {
    const floor = /^\d+$/.test(String(raw.floor ?? '').trim()) ? Number(raw.floor) + 1 : undefined;
    if (kind === 'event') return { title: line(raw.title, 60), text: line(raw.text, 600), date: line(raw.date, 60), ...(floor ? { floor } : {}) };
    return { about: line(raw.about, 120), text: line(raw.text, kind === 'thought' ? 2000 : 400), ...(kind === 'thought' && floor ? { floor } : {}) };
}

export const HEART_EXPORT_FORMAT = 'yimu-heart';
/** 把当前主题的页面连同数据做成一份单独的网页：离线能看，日期筛选照常可用；里面带着原始资料，日后可以再导入。 */
export function heartExportHtml(theme, data, heart = null, { at = Date.now() } = {}) {
    const payload = JSON.stringify({ format: HEART_EXPORT_FORMAT, version: 1, exportedAt: at, theme: theme.id, data, heart }).replace(/</g, '\\u003c');
    const tail = `<script type="application/json" id="yimu-heart-export">${payload}</script>\n<script>document.body.dataset.standalone = '1'; window.yimuRender(JSON.parse(document.getElementById('yimu-heart-export').textContent).data);</script>\n`;
    const at2 = theme.html.lastIndexOf('</body>');
    if (at2 < 0) throw new Error('主题页面不完整，无法导出');
    return theme.html.slice(0, at2) + tail + theme.html.slice(at2);
}
/** 从一份导出的网页里取回原始资料；不是忆幕导出的、或里面没有资料时说明原因。 */
export function parseHeartExport(text) {
    const match = String(text || '').match(/<script type="application\/json" id="yimu-heart-export">([\s\S]*?)<\/script>/);
    if (!match) throw new Error('这不是忆幕导出的心迹页');
    let value; try { value = JSON.parse(match[1]); } catch { throw new Error('这份心迹页读不出来'); }
    if (value?.format !== HEART_EXPORT_FORMAT || value.version !== 1) throw new Error('这不是忆幕导出的心迹页');
    if (!value.heart || typeof value.heart !== 'object') throw new Error('这份心迹页里没有可并入的内容');
    return value.heart;
}
const pad2 = value => String(value).padStart(2, '0');
async function inlineImage(url, view) {
    if (!url || typeof view.fetch !== 'function' || typeof view.FileReader !== 'function') return '';
    const response = await view.fetch(url);
    if (!response.ok) return '';
    const blob = await response.blob();
    return new Promise((resolve, reject) => { const reader = new view.FileReader(); reader.onload = () => resolve(String(reader.result || '')); reader.onerror = () => reject(reader.error); reader.readAsDataURL(blob); });
}
function saveFile(name, text, document) {
    const view = document.defaultView || globalThis, url = view.URL.createObjectURL(new view.Blob([text], { type: 'text/html;charset=utf-8' }));
    const link = document.createElement('a'); link.href = url; link.download = name; link.style.display = 'none';
    document.body.append(link); link.click(); link.remove();
    setTimeout(() => view.URL.revokeObjectURL(url), 30000);
}

export function mountHeartView({ document = globalThis.document, storage = globalThis.localStorage ?? null, getState = () => ({}), getFloors = () => null, onAction = async () => false, themes = HEART_THEMES, save = saveFile, onNotice = () => {} } = {}) {
    if (!document?.createElement) throw new TypeError('心迹页缺少文档容器');
    const view = document.defaultView || globalThis;
    let layer = null, frame = null, opened = false, fed = '', floors = null;
    const saved = () => { try { return storage?.getItem(THEME_KEY) || ''; } catch { return ''; } };
    let themeId = themes.some(theme => theme.id === saved()) ? saved() : themes[0].id;
    const current = () => themes.find(theme => theme.id === themeId) || themes[0];
    const fillPer = () => { try { return fillPerOf(storage?.getItem(FILL_PER_KEY)); } catch { return FILL_BATCH_FLOORS; } };
    // 把数据交给页面。changedOnly：只在数据与上次交出去的不同时才交（面板每次刷新都会来问一遍，页面不必跟着重画）。
    const feed = ({ changedOnly = false } = {}) => {
        try {
            const data = heartData(getState(), floors, { fillPer: fillPer() }), signature = JSON.stringify(data);
            if (changedOnly && signature === fed || typeof frame?.contentWindow?.yimuRender !== 'function') return;
            frame.contentWindow.yimuRender(data); fed = signature;
        } catch { /* 页面还没准备好：等它的 load */ }
    };
    function show() {
        if (!layer) return;
        const next = document.createElement('iframe');
        next.className = 'ym-heart-frame'; next.setAttribute('title', `心迹 · ${current().name}`); next.dataset.theme = current().id;
        next.addEventListener('load', () => feed());
        next.srcdoc = current().html;
        if (frame) frame.remove();
        frame = next; fed = ''; layer.append(frame);
    }
    function onMessage(event) {
        if (!opened || !frame || event.source !== frame.contentWindow) return;
        const type = event.data?.yimuHeart;
        if (type === 'exit') close();
        else if (type === 'export') void exportPage();
        else if (type === 'remove') {
            const { kind, id } = event.data;
            if (!REMOVABLE.has(kind) || typeof id !== 'string' || !id) return;
            // 删掉之后把最新的数据交给页面（状态变化时多半已经交过）；没删成就原样重交一次，让页面上那个按钮复原。
            Promise.resolve().then(() => onAction('heartRemove', { kind, itemId: id }))
                .catch(error => { console.warn('[忆幕] 心迹条目没有删掉', error); return false; })
                .then(done => { if (opened) feed({ changedOnly: done !== false }); });
        }
        else if (type === 'edit' || type === 'add') {
            const { kind, id } = event.data;
            if (!EDITABLE.has(kind) || type === 'edit' && (typeof id !== 'string' || !id)) return;
            const fields = heartFields(kind, event.data.fields);
            if (!fields.text || kind === 'event' && !fields.title || kind !== 'event' && !fields.about) { onNotice('还有没填的地方', 'warning'); return; }
            Promise.resolve().then(() => type === 'edit' ? onAction('heartEdit', { kind, itemId: id, ...fields }) : onAction('heartAdd', { kind, item: fields }))
                .catch(error => { console.warn('[忆幕] 心迹条目没有存下', error); return false; })
                .then(done => { if (done === false) onNotice('没有存下，请再试一次', 'error'); if (opened) feed({ changedOnly: done !== false }); });
        }
        else if (type === 'bind') {
            // 「待凝定的印象」旁的合订：把还没看过的留意合订成日记。做不成的原因由面板的提示说明。
            Promise.resolve().then(() => onAction('heartDiary', {}))
                .catch(error => { console.warn('[忆幕] 合订没有完成', error); return false; })
                .then(() => { if (opened) feed(); });
        }
        else if (type === 'fill' || type === 'fillStop') {
            // 页面上的楼层从 0 数；给了范围就只补那一段。
            const floorAt = value => /^\d+$/.test(String(value ?? '').trim()) ? Number(value) + 1 : null, start = floorAt(event.data.start), end = floorAt(event.data.end);
            const per = fillPerOf(event.data.per);
            if (type === 'fill') try { storage?.setItem(FILL_PER_KEY, String(per)); } catch { /* 记不下就只在这次生效 */ }
            Promise.resolve().then(() => onAction(type === 'fill' ? 'heartFill' : 'stop', type === 'fill' ? { perBatch: per, ...(start && end && end >= start ? { range: { start, end } } : {}) } : {}))
                .catch(error => { console.warn('[忆幕] 补全没有开始', error); return false; })
                .then(() => { if (opened) feed(); });
        }
        else if (type === 'theme') {
            const index = themes.findIndex(theme => theme.id === themeId);
            themeId = themes[(index + 1) % themes.length].id;
            try { storage?.setItem(THEME_KEY, themeId); } catch { /* 记不下就只在这次生效 */ }
            show();
        }
    }
    async function exportPage() {
        try {
            const state = getState(), data = heartData(state, floors), now = new Date();
            // 头像换成内嵌的图，离线也能看；取不到就不带头像。
            try { data.avatar = await inlineImage(data.avatar, view); } catch (error) { console.warn('[忆幕] 导出时没取到头像', error); data.avatar = ''; }
            const name = `心迹-${String(data.char || '未名').replace(/[\\/:*?"<>|]/g, '_')}-${now.getFullYear()}${pad2(now.getMonth() + 1)}${pad2(now.getDate())}.html`;
            save(name, heartExportHtml(current(), data, state.document?.heart || null, { at: now.getTime() }), document);
            onNotice('已导出为网页', 'success');
        } catch (error) { console.warn('[忆幕] 心迹页没有导出成', error); onNotice(`导出未完成：${error?.message || '未知错误'}`, 'error'); }
    }
    function open() {
        // 打开时数一次楼层；别的聊天窗口的条数取回来后再补一次。数不出来（群聊、宿主不给）就不显示这一行。
        try { floors = getFloors(next => { floors = next; if (opened) feed({ changedOnly: true }); }); } catch (error) { console.warn('[忆幕] 楼层计数没取到', error); floors = null; }
        if (opened) return;
        opened = true;
        layer = document.createElement('div'); layer.className = 'ym-heart-layer'; layer.setAttribute('role', 'dialog'); layer.setAttribute('aria-label', '心迹与心间存照');
        // 忆幕的面板是顶层对话框：全屏页放进同一个对话框里才能盖在它上面；找不到就放进页面。
        (document.querySelector?.('#yimu-dialog[open]') || document.body).append(layer);
        view.addEventListener?.('message', onMessage);
        show();
    }
    function close() {
        if (!opened) return;
        opened = false; view.removeEventListener?.('message', onMessage);
        layer?.remove(); layer = null; frame = null; fed = '';
    }
    /** 面板状态变了就来问一次：页面开着、数据确实变了才重交。 */
    const update = () => { if (opened) feed({ changedOnly: true }); };
    return { open, close, update, get opened() { return opened; }, get theme() { return themeId; }, destroy: close };
}
