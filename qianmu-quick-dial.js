// 快捷圆盘：贴着千幕 logo 展开的半圆拨盘。
// logo 靠右时弧线向左凸，靠左时向右凸；入口沿弧线排布、向两端淡出；指针固定在弧线正中，
// 拨到指针处的入口放大并在弧外显示名称。按住 logo 直接滑动即可拨动，松手打开指针处的入口。
// 本模块只管圆盘自身的绘制与手势，不保存任何设置；入口、配色、打开动作都由调用方传入。

const STEP = 23 * Math.PI / 180;      // 相邻入口的夹角
const EDGE = 88 * Math.PI / 180;      // 超过这个角度的入口不显示
const FADE = 40 * Math.PI / 180;      // 淡出带宽度
const HOME = '__home';
const DETACHABLE = new Set(['notes', 'assistant', 'floor']);
const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
const escapeHtml = value => String(value ?? '').replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));

// 两枚十六进制颜色按比例混合；任一写法认不出时返回空串（样式里有回退色）。
function parseHex(value) {
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(value || '').trim())?.[1];
  if (!hex) return null;
  const full = hex.length === 3 ? [...hex].map(ch => ch + ch).join('') : hex;
  return [0, 2, 4].map(at => parseInt(full.slice(at, at + 2), 16));
}
export function quickDialTone(from, to, ratio) {
  const a = parseHex(from), b = parseHex(to);
  if (!a || !b) return '';
  return '#' + a.map((value, at) => Math.round(value + (b[at] - value) * clamp(ratio, 0, 1)).toString(16).padStart(2, '0')).join('');
}

// 圆盘的几何：圆心取 logo 中心（上下留出至少两格入口的余地），半径随悬浮入口大小与视口收放。
export function quickDialGeometry({ centerX, centerY, width, height, size = 48 }) {
  const side = centerX > width / 2 ? 'right' : 'left';
  const reach = side === 'right' ? centerX : width - centerX;
  const radius = Math.round(clamp(Math.min(132 + (size - 32) * 0.9, reach - 96, height * 0.46), 104, 176));
  const lift = radius * 0.62 + 8;
  const y = height >= lift * 2 ? clamp(centerY, lift, height - lift) : height / 2;
  const chip = Math.round(clamp(size * 0.74, 30, 44));
  return { side, sign: side === 'right' ? -1 : 1, x: centerX, y, radius, ring: radius * 0.79, focus: radius * 0.6, chip };
}

// 入口数足够铺满半圆时首尾相接循环；较少时两端到头（越界部分带阻尼）。
export function quickDialCyclic(count) { return count * STEP >= Math.PI * 1.05; }

// 第 index 个入口在「当前停在 position」时相对指针的角度。
export function quickDialAngle(index, position, count) {
  let delta = index - position;
  if (quickDialCyclic(count)) {
    delta = ((delta % count) + count) % count;
    if (delta > count / 2) delta -= count;
  }
  return delta * STEP;
}

export function quickDialSelected(position, count) {
  const index = Math.round(position);
  return quickDialCyclic(count) ? ((index % count) + count) % count : clamp(index, 0, count - 1);
}

function arcMarkup({ sign, radius }, uid) {
  const box = radius + 30, sweep = sign < 0 ? 0 : 1, half = 21, edge = Math.sqrt(radius * radius - half * half), tip = radius - 15;
  const drop = `M ${sign * edge} ${-half} C ${sign * (edge - 1)} ${-half * 0.42} ${sign * tip} ${-half * 0.36} ${sign * tip} 0 C ${sign * tip} ${half * 0.36} ${sign * (edge - 1)} ${half * 0.42} ${sign * edge} ${half} A ${radius} ${radius} 0 0 ${sign < 0 ? 1 : 0} ${sign * edge} ${-half} Z`;
  const arc = `M 0 ${-radius} A ${radius} ${radius} 0 0 ${sweep} 0 ${radius}`;
  return `<svg class="qm-dial-arc" viewBox="${-box} ${-box} ${box * 2} ${box * 2}" width="${box * 2}" height="${box * 2}" style="left:${-box}px;top:${-box}px" aria-hidden="true">
    <defs><linearGradient id="${uid}" gradientUnits="userSpaceOnUse" x1="0" y1="${-radius}" x2="0" y2="${radius}">
      <stop offset="0" style="stop-color:var(--qd-c1);stop-opacity:0"/><stop offset=".2" style="stop-color:var(--qd-c1)"/><stop offset=".5" style="stop-color:var(--qd-mid)"/><stop offset=".8" style="stop-color:var(--qd-c2)"/><stop offset="1" style="stop-color:var(--qd-c2);stop-opacity:0"/>
    </linearGradient></defs>
    <path class="qm-dial-glow" d="${arc}" stroke="url(#${uid})"/><path class="qm-dial-line" d="${arc}" stroke="url(#${uid})"/>
    <path class="qm-dial-drop" d="${drop}" style="transform-origin:${sign * radius}px 0"/><circle class="qm-dial-dot" cx="${sign * (radius - 27)}" cy="0" r="3.4"/>
  </svg>`;
}

export function createQuickDial({
  id, items, iconMarkup, run, palette, isDark, logoUrl, floatSize, recall, remember, applyIcons, bindItem, onClosed,
  document = globalThis.document, window = globalThis.window,
} = {}) {
  let view = null, serial = 0;
  const reduced = () => !!window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;

  function viewportBox() {
    const vv = window.visualViewport;
    return { left: Number(vv?.offsetLeft || 0), top: Number(vv?.offsetTop || 0), width: Number(vv?.width || window.innerWidth), height: Number(vv?.height || window.innerHeight) };
  }

  function layout() {
    if (!view) return;
    const { geo, list, nodes, cyclic } = view, count = list.length, selected = quickDialSelected(view.position, count);
    for (let index = 0; index < count; index++) {
      const node = nodes[index], angle = quickDialAngle(index, view.position, count), away = Math.abs(angle);
      if (away >= EDGE) { if (!node.hidden) node.hidden = true; continue; }
      if (node.hidden) node.hidden = false;
      const near = Math.max(0, 1 - away / STEP), radius = geo.ring - (geo.ring - geo.focus) * near;
      node.style.translate = `${(geo.sign * radius * Math.cos(angle)).toFixed(1)}px ${(radius * Math.sin(angle)).toFixed(1)}px`;
      node.style.opacity = Math.min(1, (EDGE - away) / FADE).toFixed(3);
      node.style.setProperty('--qd-grow', (1 + 0.5 * near).toFixed(3));
      // 入口底色沿弧线由上到下在两枚主题色之间过渡；按 5% 一档取色，拨动时不必每帧改写。
      const shade = Math.round((Math.sin(angle) + 1) * 10);
      if (node._qdShade !== shade) { node._qdShade = shade; const tone = quickDialTone(view.tones[0], view.tones[1], shade / 20); if (tone) node.style.setProperty('--qd-tone', tone); }
    }
    view.root.classList.toggle('is-open-ended', !cyclic);
    if (selected === view.selected) return;
    const first = view.selected < 0;
    nodes[view.selected]?.classList.remove('is-current');
    nodes[selected]?.classList.add('is-current');
    view.selected = selected;
    view.label.textContent = list[selected].label;
    if (first || reduced()) return;
    // 入口拨到指针处：液滴轻弹一下。
    view.drop?.animate?.([{ transform: 'scale(1, 1)' }, { transform: 'scale(1.5, .86)' }, { transform: 'scale(.9, 1.05)' }, { transform: 'scale(1, 1)' }], { duration: 300, easing: 'cubic-bezier(.3, 1.5, .5, 1)' });
  }

  function limit(position) {
    if (!view || view.cyclic) return position;
    const last = view.list.length - 1;
    return position < 0 ? position * 0.3 : position > last ? last + (position - last) * 0.3 : position;
  }

  function settle(target, done) {
    if (!view) return;
    cancelAnimationFrame(view.frame);
    const current = view, from = view.position, started = performance.now(), duration = reduced() ? 0 : 170;
    const tick = now => {
      if (view !== current) return;
      const t = duration ? Math.min(1, (now - started) / duration) : 1, eased = 1 - (1 - t) ** 3;
      view.position = from + (target - from) * eased;
      layout();
      if (t < 1) view.frame = requestAnimationFrame(tick);
      else done?.();
    };
    tick(started);
  }

  function nearest() {
    return view.cyclic ? Math.round(view.position) : clamp(Math.round(view.position), 0, view.list.length - 1);
  }

  function activate(index) {
    if (!view) return;
    const item = view.list[quickDialSelected(index, view.list.length)];
    remember?.(item.id === HOME ? '' : item.id);
    close();
    run?.(item.id === HOME ? null : item.id);
  }

  function close() {
    if (!view) return;
    const current = view; view = null;
    cancelAnimationFrame(current.frame);
    current.stop();
    current.root.remove();
    current.origin.classList?.remove('sd-wheel-active');
    onClosed?.(current.origin);
  }

  // 一次拨动：从 from 位置起，按手指的纵向位移转动。松手时停到最近一格；停在别的入口上就打开它。
  function beginSlide(startY) {
    return { startY, from: view.position, origin: quickDialSelected(view.position, view.list.length), slid: false };
  }
  function slideTo(slide, y, slop) {
    if (!view) return;
    const dy = y - slide.startY;
    if (!slide.slid && Math.abs(dy) <= slop) return;
    if (!slide.slid) { slide.slid = true; cancelAnimationFrame(view.frame); view.root.classList.add('is-sliding'); }
    view.position = limit(slide.from - dy / view.geo.ring / STEP);
    layout();
  }
  function endSlide(slide, cancelled) {
    if (!view) return;
    view.root.classList.remove('is-sliding');
    if (!slide.slid) return;
    const target = cancelled ? slide.from : nearest();
    const picked = quickDialSelected(target, view.list.length);
    settle(target, () => { if (!cancelled && picked !== slide.origin) activate(target); });
  }

  function open(origin) {
    close();
    const list = [{ id: HOME, label: '千幕', home: true }, ...(items?.() || [])];
    const box = viewportBox(), rect = origin.getBoundingClientRect();
    const geo = quickDialGeometry({ centerX: rect.left + rect.width / 2 - box.left, centerY: rect.top + rect.height / 2 - box.top, width: box.width, height: box.height, size: Number(floatSize?.()) || 48 });
    const colors = palette?.() || {}, edges = colors.edges?.length ? colors.edges : ['#c99b51', '#77736d'];
    const root = document.createElement('div');
    root.id = id;
    root.className = `qm-dial qm-dial-${geo.side}${isDark?.() ? ' is-dark' : ''}`;
    root.dataset.qianmuTransient = '';
    Object.assign(root.style, { left: `${box.left}px`, top: `${box.top}px`, width: `${box.width}px`, height: `${box.height}px` });
    root.style.setProperty('--qd-c1', edges[0]);
    root.style.setProperty('--qd-c2', edges[1] || colors.mainEdge || edges[0]);
    root.style.setProperty('--qd-accent', colors.mainEdge || edges[0]);
    root.style.setProperty('--qd-r', `${geo.radius}px`);
    root.style.setProperty('--qd-chip', `${geo.chip}px`);
    const dots = [-1, 1].map(end => `<span class="qm-dial-more" style="translate:${(geo.sign * geo.ring * Math.cos(EDGE)).toFixed(1)}px ${(end * geo.ring * Math.sin(EDGE)).toFixed(1)}px" aria-hidden="true">···</span>`).join('');
    root.innerHTML = `<div class="qm-dial-backdrop"></div><div class="qm-dial-stage" style="left:${geo.x}px;top:${geo.y}px"><div class="qm-dial-scrim"></div>${arcMarkup(geo, `qm-dial-g${++serial}`)}${dots}<div class="qm-dial-items" role="menu" aria-label="千幕快捷圆盘"></div><div class="qm-dial-label" aria-live="polite"></div></div>`;
    const holder = root.querySelector('.qm-dial-items');
    const nodes = list.map((item, index) => {
      const node = document.createElement('button');
      node.type = 'button';
      node.className = `qm-dial-item${item.home ? ' is-home' : ''}${item.external ? ' is-external' : ''}`;
      node.dataset.index = String(index);
      node.dataset.command = item.id;
      node.dataset.hiveTone = isDark?.() ? 'dark' : 'light';
      node.dataset.hiveEdgeIndex = '0';
      node.setAttribute('role', 'menuitem');
      node.setAttribute('aria-label', item.label);
      if (item.external) node.setAttribute('data-qm-icon-preserve', '');
      node.innerHTML = `<span class="qm-dial-chip">${item.home ? `<img src="${escapeHtml(logoUrl?.() || '')}" alt="" draggable="false">` : iconMarkup(item)}</span>`;
      holder.appendChild(node);
      if (!item.home) {
        // 收纳图标的兜底、三个可拖出入口的拖出逻辑都由调用方绑定；它们写的提示语按圆盘的说法改回。
        bindItem?.(node, item, { itemSize: geo.chip, itemHeight: geo.chip });
        node.removeAttribute('title');
        node.setAttribute('aria-label', item.label);
      }
      return node;
    });
    const remembered = recall?.(), start = Math.max(0, list.findIndex(item => item.id === remembered));
    document.body.appendChild(root);
    applyIcons?.(root);
    view = { root, origin, geo, list, nodes, tones: [edges[0], edges[1] || colors.mainEdge || edges[0]], cyclic: quickDialCyclic(list.length), position: start, selected: -1, frame: 0, stop: () => {},
      label: root.querySelector('.qm-dial-label'), drop: root.querySelector('.qm-dial-drop') };
    root._qmCleanup = close;
    origin.classList?.add('sd-wheel-active');
    layout();
    view.stop = bindStage(root);
    return root;
  }

  // 圆盘留在屏上时的手势：在盘面任意处上下拖动＝拨动；点入口＝打开；点空白＝收起。
  // 便笺／场外特助／聊天工具包停在指针处时，横向把它拖出圆盘可成为独立悬浮入口（沿用蜂巢的拖出逻辑）。
  function bindStage(root) {
    const backdrop = root.querySelector('.qm-dial-backdrop');
    let gesture = null;
    const down = event => {
      if (gesture || event.isPrimary === false || (event.button != null && event.button !== 0)) return;
      const node = event.target.closest?.('.qm-dial-item'), index = node ? Number(node.dataset.index) : -1;
      const detach = node && DETACHABLE.has(node.dataset.command) && index === view.selected;
      gesture = { id: event.pointerId, x: event.clientX, y: event.clientY, index, detach, mode: '', slide: beginSlide(event.clientY) };
      // 不在指针处的可拖出入口只参与拨动，不让拖出逻辑接手。
      if (node && DETACHABLE.has(node.dataset.command) && !detach) event.stopPropagation();
      if (!detach) { try { backdrop.setPointerCapture(event.pointerId); } catch { /* 拿不到捕获时仍按普通事件处理 */ } }
    };
    const move = event => {
      if (!gesture || event.pointerId !== gesture.id || !view) return;
      const dx = event.clientX - gesture.x, dy = event.clientY - gesture.y;
      if (gesture.detach && !gesture.mode) {
        if (Math.hypot(dx, dy) <= 8) return;
        gesture.mode = Math.abs(dx) > Math.abs(dy) ? 'detach' : 'slide';
      }
      if (gesture.mode === 'detach') return;
      if (gesture.detach) event.stopPropagation();
      slideTo(gesture.slide, event.clientY, event.pointerType === 'touch' ? 7 : 4);
      if (gesture.slide.slid) event.preventDefault();
    };
    const up = (event, cancelled = false) => {
      if (!gesture || event.pointerId !== gesture.id) return;
      const done = gesture; gesture = null;
      try { backdrop.releasePointerCapture(done.id); } catch { /* 未捕获 */ }
      if (!view || done.mode === 'detach') return;
      if (done.slide.slid) return endSlide(done.slide, cancelled);
      if (cancelled) return;
      if (done.index >= 0) activate(done.index);
      else close();
    };
    const cancel = event => up(event, true);
    const wheel = event => {
      if (!view) return;
      event.preventDefault();
      view.position = nearest();
      const next = view.position + Math.sign(event.deltaY);
      settle(view.cyclic ? next : clamp(next, 0, view.list.length - 1));
    };
    const key = event => {
      if (!view) return;
      if (event.key === 'Escape') return close();
      const step = event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : 0;
      if (step) { event.preventDefault(); const next = nearest() + step; return settle(view.cyclic ? next : clamp(next, 0, view.list.length - 1)); }
      if (event.key === 'Enter') { event.preventDefault(); activate(nearest()); }
    };
    // 键盘或读屏触发的点击没有指针事件，单独处理。
    const click = event => {
      const node = event.detail === 0 && event.target.closest?.('.qm-dial-item');
      if (node) activate(Number(node.dataset.index));
    };
    const outside = event => {
      if (!view) return;
      const target = event.target;
      if (target === view.origin || root.contains(target) || view.origin.contains?.(target)) return;
      close();
    };
    const gone = () => close();
    root.addEventListener('pointerdown', down, true);
    root.addEventListener('pointermove', move, true);
    root.addEventListener('pointerup', up, true);
    root.addEventListener('pointercancel', cancel, true);
    root.addEventListener('wheel', wheel, { passive: false });
    root.addEventListener('click', click);
    document.addEventListener('keydown', key, true);
    document.addEventListener('pointerdown', outside, true);
    window.visualViewport?.addEventListener('resize', gone);
    window.addEventListener('orientationchange', gone);
    return () => {
      document.removeEventListener('keydown', key, true);
      document.removeEventListener('pointerdown', outside, true);
      window.visualViewport?.removeEventListener('resize', gone);
      window.removeEventListener('orientationchange', gone);
    };
  }

  // logo 上的一次按压。按下圆盘立刻展开；随手上下滑＝拨动，松手打开指针处的入口；
  // 不滑就松手＝圆盘留在屏上；按住不动满 liftAfter 毫秒＝收起圆盘、改为拖动 logo（由 onLift 接手）。
  function press(origin, event, { onLift, liftAfter = 480 } = {}) {
    if (view) { close(); return { move() {}, release: () => 'closed' }; }
    open(origin);
    const slide = beginSlide(event.clientY), slop = event.pointerType === 'touch' ? 7 : 4, startX = event.clientX;
    let lifted = false;
    const timer = setTimeout(() => { if (!view || slide.slid) return; lifted = true; close(); onLift?.(); }, liftAfter);
    return {
      move(next) {
        if (lifted) return;
        if (!slide.slid && Math.hypot(next.clientX - startX, next.clientY - slide.startY) > slop) clearTimeout(timer);
        slideTo(slide, next.clientY, slop);
      },
      release(cancelled = false) {
        clearTimeout(timer);
        if (lifted) return 'lifted';
        if (cancelled) { close(); return 'cancelled'; }
        endSlide(slide, false);
        return slide.slid ? 'slid' : 'opened';
      },
    };
  }

  return Object.freeze({ open, close, press, get isOpen() { return !!view; } });
}

// 设置页里的入口排序：按住入口拖到新位置。拖动只改顺序，不改选中状态；松手后回报新的顺序。
export function bindQuickDialReorder(list, { selector = '[data-command]', onReorder, document = globalThis.document } = {}) {
  if (!list) return;
  let drag = null;
  const items = () => [...list.querySelectorAll(selector)];
  const stopScroll = event => { if (drag?.active) event.preventDefault(); };
  list.addEventListener('touchmove', stopScroll, { passive: false });
  list.addEventListener('pointerdown', event => {
    const node = event.target.closest?.(selector);
    if (!node || drag || event.isPrimary === false || (event.button != null && event.button !== 0)) return;
    const touch = event.pointerType === 'touch';
    drag = { node, id: event.pointerId, x: event.clientX, y: event.clientY, active: false, touch, timer: 0 };
    // 触屏上先按住片刻再拖，避免和页面滚动抢手势。
    if (touch) drag.timer = setTimeout(() => { if (drag) start(); }, 260);
  });
  function start() {
    drag.active = true;
    drag.node.classList.add('is-reordering');
    try { drag.node.setPointerCapture(drag.id); } catch { /* 无捕获也能拖 */ }
  }
  list.addEventListener('pointermove', event => {
    if (!drag || event.pointerId !== drag.id) return;
    const dx = event.clientX - drag.x, dy = event.clientY - drag.y;
    if (!drag.active) {
      if (Math.hypot(dx, dy) <= 6) return;
      if (drag.touch) { clearTimeout(drag.timer); drag = null; return; }
      start();
    }
    event.preventDefault();
    const under = document.elementsFromPoint(event.clientX, event.clientY).find(node => node !== drag.node && node.matches?.(selector) && list.contains(node));
    if (under) {
      const all = items(), before = all.indexOf(drag.node) > all.indexOf(under);
      list.insertBefore(drag.node, before ? under : under.nextSibling);
      drag.moved = true;
    }
  });
  const finish = event => {
    if (!drag || event.pointerId !== drag.id) return;
    const done = drag; drag = null;
    clearTimeout(done.timer);
    done.node.classList.remove('is-reordering');
    if (!done.active) return;
    // 拖过之后紧跟着的那次点击不算「切换选中」。
    const swallow = click => { click.stopPropagation(); click.preventDefault(); };
    list.addEventListener('click', swallow, { capture: true, once: true });
    setTimeout(() => list.removeEventListener('click', swallow, true), 0);
    if (done.moved) onReorder?.(items().map(node => node.dataset.command));
  };
  list.addEventListener('pointerup', finish);
  list.addEventListener('pointercancel', finish);
}
