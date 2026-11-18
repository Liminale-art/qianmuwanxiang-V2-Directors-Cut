// 楼层上的「本层原文已被忆幕记忆替代」标记。
// 忆幕的隐藏只发生在发出给模型的请求里，从不改动聊天本身，所以 ST 的幽灵图标不会出现；
// 这个标记属于忆幕自己，作用是把「这一轮带了记忆、换掉了这层原文」直接摆在楼层上。
// 只追加一个只读小节点，不改消息数据、不监听正文、不伪造 ST 的 is_system 状态。
const MARKS = 'ym-floor-mark';

function ghost(document) {
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('class', 'ym-floor-mark-glyph');
    const path = document.createElementNS(NS, 'path');
    path.setAttribute('d', 'M5 20.5V10a7 7 0 0 1 14 0v10.5l-2.8-1.9-2.9 2.1-2.6-2-2.8 2-2.9-2.2Z');
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', 'currentColor');
    path.setAttribute('stroke-width', '1.8');
    path.setAttribute('stroke-linejoin', 'round');
    svg.append(path);
    for (const cx of [9.2, 14.8]) {
        const eye = document.createElementNS(NS, 'circle');
        eye.setAttribute('cx', String(cx)); eye.setAttribute('cy', '10');
        eye.setAttribute('r', '1.15'); eye.setAttribute('fill', 'currentColor');
        svg.append(eye);
    }
    return svg;
}

/**
 * @param {{ document?: Document, label?: string }} options
 * @returns {(floors: number[], key?: string) => void} 每次状态变化时调用；key 变化（换了聊天）时清空。
 */
export function mountMessageMarks({ document = globalThis.document, label = '本层原文已被忆幕记忆替代（只影响发给模型的请求，聊天本身不变）' } = {}) {
    let floors = new Set(), identity = null, disposed = false;
    const applied = new Map(); // floor → 节点，便于擦掉
    const chat = () => document.getElementById('chat');

    function node(floor) {
        const mark = document.createElement('span');
        mark.className = MARKS;
        mark.dataset.ymFloor = String(floor);
        mark.title = label;
        mark.setAttribute('aria-label', label);
        mark.append(ghost(document));
        const text = document.createElement('span');
        text.className = 'ym-floor-mark-text'; text.textContent = '忆幕';
        mark.append(text);
        return mark;
    }

    function messageOf(floor) {
        // ST 的 mesid 是聊天数组下标；忆幕的楼层号从 1 起且含隐藏消息，故相差 1。
        return chat()?.querySelector(`.mes[mesid="${floor - 1}"]`) || null;
    }

    function clearAll() {
        for (const [floor, mark] of applied) { mark.remove(); applied.delete(floor); }
    }

    function paint() {
        if (disposed) return;
        for (const [floor, mark] of applied) {
            const host = messageOf(floor);
            // 楼层被 ST 重画（滑动、编辑）后旧节点已脱离，换挂到新节点上。
            if (!host || !mark.isConnected) { mark.remove(); applied.delete(floor); }
            else if (mark.parentElement?.closest('.mes') !== host) {
                mark.remove();
                (host.querySelector('.ch_name .flex-container') || host.querySelector('.ch_name'))?.append(mark);
            }
        }
        for (const floor of floors) {
            if (applied.has(floor)) continue;
            const host = messageOf(floor);
            const anchor = host && (host.querySelector('.ch_name .flex-container') || host.querySelector('.ch_name'));
            if (!anchor) continue;
            const mark = node(floor); anchor.append(mark); applied.set(floor, mark);
        }
    }

    // 只观察聊天容器的直接子节点（楼层增删、滑动后整块重画），不观察正文内容。
    const Observer = document.defaultView?.MutationObserver;
    let observer = null;
    if (Observer) {
        observer = new Observer(() => paint());
    }
    const attach = () => {
        const host = chat();
        if (host && observer) { observer.observe(host, { childList: true }); return true; }
        return false;
    };
    if (!attach()) {
        // 忆幕可能在聊天列表就绪前加载；等到容器出现再挂观察。
        const retry = document.defaultView?.setInterval?.(() => { if (attach()) document.defaultView.clearInterval(retry); }, 1000);
    }

    const update = (nextFloors = [], key = '') => {
        if (disposed) return;
        if (key !== identity) { identity = key; floors = new Set(); clearAll(); }
        floors = new Set((Array.isArray(nextFloors) ? nextFloors : []).filter(Number.isSafeInteger));
        paint();
    };
    update.dispose = () => { disposed = true; observer?.disconnect(); clearAll(); };
    return update;
}
