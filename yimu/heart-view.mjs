// 心迹与观察日记：全屏的独立页面。三套主题各是一份完整的页面，放在 iframe 里，
// 所以不受千幕、忆幕本体主题的影响；左上角退出，右上角换主题，选过的主题记在本机。
// 这里只负责开合、换主题与把数据交给页面；页面长什么样全在 yimu/heart/ 的主题文件里。
import { HEART_THEMES } from './heart-themes.mjs';

const THEME_KEY = 'yimu:heart-theme:v1';
const pad = value => String(value).padStart(2, '0');
const dayOf = item => item.date || (() => { const d = new Date(item.at); return `${d.getMonth() + 1}月${d.getDate()}日`; })();

/** 页面要的数据。印象与心迹的生成还没接上，这两项暂时为空；「还在留意的」是已记下的痕迹，新的在前。 */
export function heartData(state = {}) {
    const observations = Array.isArray(state.document?.observations) ? state.document.observations : [];
    return {
        char: state.snapshot?.name || '', user: state.snapshot?.userName || '', avatar: state.snapshot?.avatarUrl || '',
        impressions: [], thoughts: [],
        loose: [...observations].reverse().slice(0, 40).map(item => ({ about: item.about, text: item.text, day: dayOf(item), floor: item.floor })),
    };
}

export function mountHeartView({ document = globalThis.document, storage = globalThis.localStorage ?? null, getState = () => ({}), themes = HEART_THEMES } = {}) {
    if (!document?.createElement) throw new TypeError('心迹页缺少文档容器');
    const view = document.defaultView || globalThis;
    let layer = null, frame = null, opened = false;
    const saved = () => { try { return storage?.getItem(THEME_KEY) || ''; } catch { return ''; } };
    let themeId = themes.some(theme => theme.id === saved()) ? saved() : themes[0].id;
    const current = () => themes.find(theme => theme.id === themeId) || themes[0];
    const feed = () => { try { frame?.contentWindow?.yimuRender?.(heartData(getState())); } catch { /* 页面还没准备好：等它的 load */ } };
    function show() {
        if (!layer) return;
        const next = document.createElement('iframe');
        next.className = 'ym-heart-frame'; next.setAttribute('title', `心迹 · ${current().name}`); next.dataset.theme = current().id;
        next.addEventListener('load', feed);
        next.srcdoc = current().html;
        if (frame) frame.remove();
        frame = next; layer.append(frame);
    }
    function onMessage(event) {
        if (!opened || !frame || event.source !== frame.contentWindow) return;
        const type = event.data?.yimuHeart;
        if (type === 'exit') close();
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
        layer?.remove(); layer = null; frame = null;
    }
    return { open, close, get opened() { return opened; }, get theme() { return themeId; }, destroy: close };
}
