// Standalone adaptation of qianmu-main-tabs.js: same fixed-hitbox decorations,
// timings and geometry; no dependency on Qianmu's settings or DOM lifetime.
export function mountYimuNavigation(container, { document = container?.ownerDocument || globalThis.document,
    tabs = [], selected = tabs[0]?.[0], onNavigate = () => {} } = {}) {
    if (!container || !document?.createElement) throw new TypeError('忆幕导航缺少容器');
    const buttons = new Map(), decorations = new Map(), removers = [];
    const window = document.defaultView || globalThis;
    let current = selected, disposed = false, animations = [], previousTheme = '';
    const el = (tag, cls) => { const node = document.createElement(tag); node.className = cls; return node; };
    container.className = 'ym-nav-shell'; container.setAttribute('aria-label', '忆幕页面');
    container.removeAttribute('role');
    const bar = el('div', 'ym-nav'); bar.setAttribute('role', 'tablist');
    const listen = (node, name, handler, options) => { node.addEventListener(name, handler, options); removers.push(() => node.removeEventListener?.(name, handler, options)); };
    for (const [id, label] of tabs) {
        const button = el('button', 'ym-nav-button'); button.type = 'button'; button.id = `ym-tab-${id}`; button.dataset.tab = id;
        button.setAttribute('aria-label', label);
        button.setAttribute('role', 'tab'); button.setAttribute('aria-controls', `ym-page-${id}`);
        const text = el('span', 'ym-nav-label'); text.textContent = label;
        const mark = el('span', 'ym-nav-mark'), dot = el('span', 'ym-nav-dot');
        mark.setAttribute('aria-hidden', 'true'); dot.setAttribute('aria-hidden', 'true');
        const svg = document.createElementNS?.('http://www.w3.org/2000/svg', 'svg') || document.createElement('svg');
        svg.setAttribute('class', 'ym-nav-capsule'); svg.setAttribute('aria-hidden', 'true'); svg.setAttribute('focusable', 'false');
        const rect = document.createElementNS?.('http://www.w3.org/2000/svg', 'rect') || document.createElement('rect');
        for (const [name, value] of Object.entries({ width: '100%', height: '100%', ry: '50%', pathLength: '1' })) rect.setAttribute(name, value);
        svg.append(rect); button.append(text, mark, dot, svg); bar.append(button);
        buttons.set(id, button); decorations.set(id, { text, mark, dot, rect });
        listen(button, 'click', () => { if (!button.disabled) onNavigate(id); });
    }
    container.append(bar);
    const cancel = () => { for (const animation of animations) animation.cancel(); animations = []; };
    const theme = () => container.closest?.('[data-ym-theme]')?.getAttribute('data-ym-theme') || 'classic';
    const animate = (node, frames, duration) => { if (node?.animate) try { animations.push(node.animate(frames, { duration, easing: 'cubic-bezier(.25,.7,.3,1)' })); } catch {} };
    function select(id, { animate: shouldAnimate = true } = {}) {
        if (disposed || !buttons.has(id)) return;
        const old = buttons.get(current), next = buttons.get(id), prior = decorations.get(current), part = decorations.get(id), family = theme();
        const changedTheme = previousTheme && previousTheme !== family; previousTheme = family;
        const moving = family === 'classic' && animations.some(animation => ['running', 'pending'].includes(animation.playState));
        const painted = moving ? prior?.mark.getBoundingClientRect?.() : null;
        const lineOpacity = moving ? Number.parseFloat(window.getComputedStyle?.(prior.mark).opacity) || 0 : 1;
        const dotOpacity = moving ? Number.parseFloat(window.getComputedStyle?.(prior.dot).opacity) || 0 : 0;
        for (const [key, button] of buttons) { button.setAttribute('aria-selected', String(key === id)); button.tabIndex = key === id ? 0 : -1; }
        if (old === next) { if (changedTheme) cancel(); current = id; refresh(); return; }
        cancel(); current = id;
        if (shouldAnimate && old && !changedTheme && !window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches) {
            if (family === 'glass') animate(part.rect, [{ strokeDasharray: '1', strokeDashoffset: '.92', opacity: .55 }, { strokeDasharray: '1', strokeDashoffset: '0', opacity: 1 }], 380);
            else if (family === 'editorial') {
                animate(part.mark, [{ transform: 'translate(-50%, 50%) scale(.25)', opacity: .4 }, { transform: 'translate(-50%, 50%) scale(1.15)', opacity: 1, offset: .7 }, { transform: 'translate(-50%, 50%) scale(1)', opacity: 1 }], 300);
                animate(part.text, [{ transform: 'translateY(0)' }, { transform: 'translateY(-4px)', offset: .5 }, { transform: 'translateY(-2px)' }], 300);
            } else {
                const a = painted || old.getBoundingClientRect?.(), b = next.getBoundingClientRect?.();
                const width = part.mark.getBoundingClientRect?.().width, oldWidth = prior.mark.getBoundingClientRect?.().width || width;
                const delta = a && b ? a.left + a.width / 2 - b.left - b.width / 2 : NaN;
                const position = distance => `translate(calc(-50% + ${distance}px), 50%)`;
                if (Number.isFinite(delta) && width > 0) {
                    animate(part.mark, [{ transform: `${position(delta)} scaleX(${(painted?.width || oldWidth) / width})`, opacity: lineOpacity }, { transform: `${position(delta * .8)} scaleX(${5 / width})`, opacity: 0, offset: .28 }, { transform: `${position(delta * .15)} scaleX(${5 / width})`, opacity: 0, offset: .7 }, { transform: 'translate(-50%, 50%) scaleX(1)', opacity: 1 }], 360);
                    animate(part.dot, [{ transform: position(delta), opacity: dotOpacity }, { transform: position(delta * .8), opacity: 1, offset: .28 }, { transform: position(delta * .15), opacity: 1, offset: .7 }, { transform: 'translate(-50%, 50%)', opacity: 0 }], 360);
                }
            }
        }
        refresh();
    }
    function refresh() {
        if (disposed) return;
        const active = buttons.get(current), viewport = bar.getBoundingClientRect?.(), item = active?.getBoundingClientRect?.();
        if (viewport && item) { if (item.left < viewport.left) bar.scrollLeft += item.left - viewport.left; else if (item.right > viewport.right) bar.scrollLeft += item.right - viewport.right; }
    }
    listen(bar, 'keydown', event => {
        const ids = [...buttons.keys()], index = ids.indexOf(current);
        const next = event.key === 'ArrowRight' ? (index + 1) % ids.length : event.key === 'ArrowLeft' ? (index + ids.length - 1) % ids.length : event.key === 'Home' ? 0 : event.key === 'End' ? ids.length - 1 : undefined;
        if (next !== undefined) { event.preventDefault(); event.stopPropagation(); onNavigate(ids[next]); buttons.get(ids[next])?.focus(); }
    });
    const Resize = window.ResizeObserver, observer = Resize ? new Resize(() => { cancel(); refresh(); }) : null;
    observer?.observe(bar); select(selected, { animate: false });
    return { buttons, select, refresh, destroy() { if (disposed) return; disposed = true; cancel(); observer?.disconnect(); for (const remove of removers) remove(); bar.remove(); buttons.clear(); decorations.clear(); } };
}
