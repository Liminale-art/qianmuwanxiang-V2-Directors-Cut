// 心迹与观察日记：全屏的独立页面。三套主题各是一份完整的页面，放在 iframe 里，
// 所以不受千幕、忆幕本体主题的影响；左上角退出，右上角换主题，选过的主题记在本机。
// 这里只负责开合、换主题与把数据交给页面；页面长什么样全在 yimu/heart/ 的主题文件里。
import { HEART_THEMES } from './heart-themes.mjs';
import { sureOf, SURE_WORDS } from './heart-contract.mjs';

const THEME_KEY = 'yimu:heart-theme:v1';
const realDay = at => { const d = new Date(at); return `${d.getMonth() + 1}月${d.getDate()}日`; };
const dayOf = item => item.date || realDay(item.at);

/** 页面要的数据。每一项都带记下的时刻（at，系统时间），页面按它做日期筛选。
 *  impressions：在够多个不同日子里看见过、已成印象的（最近有动静的在前）；
 *  loose：还在留意的——没看过的痕迹，以及日子还不够的印象（新的在前）；
 *  thoughts：心迹（新的在前）；events：关系年表（按剧情先后）。 */
export function heartData(state = {}) {
    const document = state.document || {}, heart = document.heart || {};
    const observations = Array.isArray(document.observations) ? document.observations : [];
    const graded = (heart.impressions || []).map(item => ({ item, sure: sureOf(item.days.length) }));
    const loose = [
        ...observations.filter(item => !item.used).map(item => ({ about: item.about, text: item.text, day: dayOf(item), floor: item.floor, at: item.at })),
        ...graded.filter(({ sure }) => sure === 0).map(({ item }) => ({ about: item.about, text: item.text, day: item.days.at(-1).day, at: item.updatedAt })),
    ].sort((a, b) => b.at - a.at).slice(0, 60);
    return {
        char: state.snapshot?.name || '', user: state.snapshot?.userName || '', avatar: state.snapshot?.avatarUrl || '',
        impressions: graded.filter(({ sure }) => sure >= 1).sort((a, b) => b.item.updatedAt - a.item.updatedAt).map(({ item, sure }) => ({ id: item.id, about: item.about, say: item.text, sure, word: SURE_WORDS[sure],
            days: item.days.map(day => [day.day, day.text]), stamps: item.days.map(day => day.at), ...(item.was ? { was: item.was } : {}), at: item.updatedAt })),
        loose,
        thoughts: [...(heart.thoughts || [])].reverse().map(item => ({ id: item.id, group: item.group, about: THOUGHT_LABELS[item.group](item.about), say: item.text, when: realDay(item.at), floor: item.floor, at: item.at })),
        events: (heart.events || []).map(item => ({ id: item.id, title: item.title, text: item.text, date: item.date || '', when: realDay(item.at), floor: item.floor, at: item.at })),
    };
}
const THOUGHT_LABELS = { you: name => `对${name}`, self: () => '对自己', others: name => `对${name}`, books: name => `读${/[《》]/.test(name) ? name : `《${name}》`}` };

const REMOVABLE = new Set(['impression', 'thought', 'event']);

export function mountHeartView({ document = globalThis.document, storage = globalThis.localStorage ?? null, getState = () => ({}), onAction = async () => false, themes = HEART_THEMES } = {}) {
    if (!document?.createElement) throw new TypeError('心迹页缺少文档容器');
    const view = document.defaultView || globalThis;
    let layer = null, frame = null, opened = false, fed = '';
    const saved = () => { try { return storage?.getItem(THEME_KEY) || ''; } catch { return ''; } };
    let themeId = themes.some(theme => theme.id === saved()) ? saved() : themes[0].id;
    const current = () => themes.find(theme => theme.id === themeId) || themes[0];
    // 把数据交给页面。changedOnly：只在数据与上次交出去的不同时才交（面板每次刷新都会来问一遍，页面不必跟着重画）。
    const feed = ({ changedOnly = false } = {}) => {
        try {
            const data = heartData(getState()), signature = JSON.stringify(data);
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
        else if (type === 'remove') {
            const { kind, id } = event.data;
            if (!REMOVABLE.has(kind) || typeof id !== 'string' || !id) return;
            // 删掉之后把最新的数据交给页面（状态变化时多半已经交过）；没删成就原样重交一次，让页面上那个按钮复原。
            Promise.resolve().then(() => onAction('heartRemove', { kind, itemId: id }))
                .catch(error => { console.warn('[忆幕] 心迹条目没有删掉', error); return false; })
                .then(done => { if (opened) feed({ changedOnly: done !== false }); });
        }
        else if (type === 'theme') {
            const index = themes.findIndex(theme => theme.id === themeId);
            themeId = themes[(index + 1) % themes.length].id;
            try { storage?.setItem(THEME_KEY, themeId); } catch { /* 记不下就只在这次生效 */ }
            show();
        }
    }
    function open() {
        if (opened) return;
        opened = true;
        layer = document.createElement('div'); layer.className = 'ym-heart-layer'; layer.setAttribute('role', 'dialog'); layer.setAttribute('aria-label', '心迹与观察日记');
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
