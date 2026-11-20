// 快捷轮盘：贴着千幕 logo 展开的半椭圆拨盘。
// logo 靠右时弧线向左凸，靠左时向右凸；弧线纵向拉长，内侧留出更多空间。入口沿弧线内侧排布、向两端淡出；
// 指针是一枚固定在弧线正中内侧的圆点，拨到圆点处的入口放大并在弧外显示名称。
// 与蜂巢格一样由长按 logo 展开并留在屏上；长按后不抬手继续移动则是挪动 logo（轮盘随即收起），与蜂巢格一致。
// 展开时圆形 logo 自己滑进弧线、排在最后一格（即主面板入口）；收起时滑回原位，盘里不再另放一枚 logo。
// 本模块只管轮盘自身的绘制与手势，不保存任何设置；入口、配色、打开动作都由调用方传入。

const EDGE = 80 * Math.PI / 180;      // 可见弧的边界角
const SLOTS = 2;                      // 指针上下各显示几格（共 5 格）
const GROW = 0.3;                     // 指针处入口放大的比例
const DOT = 3.5;                      // 指针圆点半径
const GAP = 9;                        // 弧线—圆点、圆点—入口之间的间距（两段相同）
const HOME = '__home';
const LEAVING_ID = 'qm-dial-leaving';   // 收起动画期间的 id：样式照常生效，但不再占用快捷盘图层的 id
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

// 轮盘的几何。弧线是半个椭圆：横向半径 rx 随悬浮入口大小与视口收放，纵向半径 ry 更长。
// 入口排在内侧的同心椭圆（ringX／ringY）上：指针处放大的入口与圆点、圆点与弧线之间各留 GAP。
export function quickDialGeometry({ centerX, centerY, width, height, size = 48 }) {
  const side = centerX > width / 2 ? 'right' : 'left';
  const reach = side === 'right' ? centerX : width - centerX;
  const chip = Math.round(clamp(size * 0.84, 34, 50));
  const rx = Math.round(clamp(Math.min(126 + (size - 32) * 0.8, reach - 96, height * 0.34), 100, 164));
  const ry = Math.round(Math.min(rx * 1.42, Math.max(rx, height * 0.47)));
  const inset = GAP * 2 + DOT * 2 + chip * (1 + GROW) / 2;
  const ringX = rx - inset, ringY = ry - inset, arc = arcTable(ringX, ringY);
  // 一格的间距：让上下各 SLOTS 格正好铺满可见弧，第 SLOTS+1 格落在边界之外。
  const reachable = arcLengthAt(arc, EDGE);
  const pitch = Math.max(chip + 8, (reachable - chip * GROW / 2) / (SLOTS + 0.9));
  const lift = pitch * SLOTS + chip;
  const y = height >= lift * 2 ? clamp(centerY, lift, height - lift) : height / 2;
  // 整盘向 logo 所靠的那条边收一些（最多 50px，圆心至多越过屏幕边 20px），弧线内侧不留一大片空。
  const near = side === 'right' ? width - centerX : centerX, shift = Math.round(clamp(near + 20, 0, 50));
  return { side, sign: side === 'right' ? -1 : 1, x: centerX + (side === 'right' ? shift : -shift), y, rx, ry, ringX, ringY, chip, pitch, dot: rx - GAP - DOT, arc };
}

// 椭圆上「走过的弧长 → 参数角」对照表（四分之一圈）。入口按弧长等距排布，才不会越往两端越挤。
const ARC_STEPS = 120;
function arcTable(a, b) {
  const table = [0], step = Math.PI / 2 / ARC_STEPS;
  for (let i = 1; i <= ARC_STEPS; i++) {
    const mid = (i - 0.5) * step;
    table.push(table[i - 1] + Math.hypot(a * Math.sin(mid), b * Math.cos(mid)) * step);
  }
  return table;
}
function arcLengthAt(table, angle) { const at = angle / (Math.PI / 2) * ARC_STEPS, low = Math.min(ARC_STEPS - 1, Math.floor(at)); return table[low] + (table[low + 1] - table[low]) * (at - low); }
// 沿入口所在的椭圆走 offset 像素（带符号）对应的参数角；超出四分之一圈时返回略大于直角的值（即不可见）。
export function quickDialAngle(offset, geo) {
  const table = geo.arc, distance = Math.abs(offset), sign = offset < 0 ? -1 : 1;
  if (distance >= table[ARC_STEPS]) return sign * Math.PI * 0.6;
  let low = 0, high = ARC_STEPS;
  while (high - low > 1) { const mid = (low + high) >> 1; if (table[mid] <= distance) low = mid; else high = mid; }
  return sign * (low + (distance - table[low]) / (table[high] - table[low])) * (Math.PI / 2 / ARC_STEPS);
}

// 半边可见弧上能排下多少个入口间距。
// 入口数足够铺满可见弧时首尾相接循环；较少时两端到头（越界部分带阻尼）。
export function quickDialCyclic(count) { return count >= SLOTS * 2 + 3; }

// 第 index 个入口在「当前停在 position」时相对指针隔了几格（带符号，循环时取近的一边）。
export function quickDialDelta(index, position, count, cyclic) {
  let delta = index - position;
  if (cyclic) {
    delta = ((delta % count) + count) % count;
    if (delta > count / 2) delta -= count;
  }
  return delta;
}

// 相隔 delta 格的入口沿弧线离指针多远（像素）。指针处的入口会放大，两侧的入口整体让开放大出来的那一半，
// 所以相邻入口边到边的间隙在拨动过程中始终不变。
export function quickDialOffset(delta, geo) {
  return delta * geo.pitch + clamp(delta, -1, 1) * geo.chip * GROW / 2;
}

// 指针上下各 SLOTS 格清晰可见，最外一格略淡，再往外淡出。
export function quickDialOpacity(delta) { return 1 - clamp((Math.abs(delta) - (SLOTS - 0.6)) / 1.5, 0, 1); }

export function quickDialSelected(position, count, cyclic) {
  const index = Math.round(position);
  return cyclic ? ((index % count) + count) % count : clamp(index, 0, count - 1);
}

function arcMarkup({ sign, rx, ry, dot }, uid) {
  const boxX = rx + 30, boxY = ry + 30, arc = `M 0 ${-ry} A ${rx} ${ry} 0 0 ${sign < 0 ? 0 : 1} 0 ${ry}`;
  return `<svg class="qm-dial-arc" viewBox="${-boxX} ${-boxY} ${boxX * 2} ${boxY * 2}" width="${boxX * 2}" height="${boxY * 2}" style="left:${-boxX}px;top:${-boxY}px" aria-hidden="true">
    <defs><linearGradient id="${uid}" gradientUnits="userSpaceOnUse" x1="0" y1="${-ry}" x2="0" y2="${ry}">
      <stop offset="0" style="stop-color:var(--qd-c1);stop-opacity:0"/><stop offset=".22" style="stop-color:var(--qd-c1)"/><stop offset=".5" style="stop-color:var(--qd-mid)"/><stop offset=".78" style="stop-color:var(--qd-c2)"/><stop offset="1" style="stop-color:var(--qd-c2);stop-opacity:0"/>
    </linearGradient></defs>
    <path class="qm-dial-glow qm-dial-glow-wide" d="${arc}" stroke="url(#${uid})"/><path class="qm-dial-glow" d="${arc}" stroke="url(#${uid})"/><path class="qm-dial-line" d="${arc}" stroke="url(#${uid})"/>
    <circle class="qm-dial-dot" cx="${sign * dot}" cy="0" r="${DOT}" style="transform-origin:${sign * dot}px 0"/>
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
    const { geo, list, nodes, cyclic } = view, count = list.length, selected = quickDialSelected(view.position, count, cyclic);
    for (let index = 0; index < count; index++) {
      const node = nodes[index], delta = quickDialDelta(index, view.position, count, cyclic);
      const away = Math.abs(delta);
      if (away >= SLOTS + 0.9) { if (!node.hidden) node.hidden = true; continue; }
      if (node.hidden) node.hidden = false;
      const angle = quickDialAngle(quickDialOffset(delta, geo), geo);
      node.style.translate = `${(geo.sign * geo.ringX * Math.cos(angle)).toFixed(1)}px ${(geo.ringY * Math.sin(angle)).toFixed(1)}px`;
      node.style.opacity = quickDialOpacity(delta).toFixed(3);
      node.style.setProperty('--qd-grow', (1 + GROW * Math.max(0, 1 - Math.abs(delta))).toFixed(3));
    }
    if (selected === view.selected) return;
    const first = view.selected < 0;
    nodes[view.selected]?.classList.remove('is-current');
    nodes[selected]?.classList.add('is-current');
    view.selected = selected;
    view.label.textContent = list[selected].label;
    if (first || reduced()) return;
    // 入口拨到指针处：圆点轻弹一下。
    view.dot?.animate?.([{ transform: 'scale(1)' }, { transform: 'scale(1.9)' }, { transform: 'scale(.85)' }, { transform: 'scale(1)' }], { duration: 280, easing: 'cubic-bezier(.3, 1.5, .5, 1)' });
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
    current.root.classList.add('is-settling');
    const tick = now => {
      if (view !== current) return;
      const t = duration ? Math.min(1, (now - started) / duration) : 1, eased = 1 - (1 - t) ** 3;
      view.position = from + (target - from) * eased;
      layout();
      if (t < 1) view.frame = requestAnimationFrame(tick);
      else { current.root.classList.remove('is-settling'); done?.(); }
    };
    tick(started);
  }

  function nearest() {
    return view.cyclic ? Math.round(view.position) : clamp(Math.round(view.position), 0, view.list.length - 1);
  }

  // 打开入口：先让它回缩再弹回，随后收起轮盘、打开对应面板。
  function activate(index) {
    if (!view || view.leaving) return;
    const current = view, at = quickDialSelected(index, view.list.length, view.cyclic), item = view.list[at];
    const finish = () => {
      if (view !== current) return;
      remember?.(item.id === HOME ? '' : item.id);
      close();
      run?.(item.id === HOME ? null : item.id);
    };
    const chip = current.nodes[at]?.firstElementChild;
    if (reduced() || typeof chip?.animate !== 'function') return finish();
    current.leaving = true;
    const motion = chip.animate([{ transform: 'scale(1)' }, { transform: 'scale(.8)', offset: .42 }, { transform: 'scale(1.08)', offset: .8 }, { transform: 'scale(1)' }], { duration: 240, easing: 'ease-out' });
    motion.onfinish = motion.oncancel = finish;
  }

  // 主面板入口在「logo 原位」与「盘上的格子」之间滑动。back=true 为收起时滑回。返回动画（没有可滑的则为 null）。
  function flyHome(current, back) {
    const node = current.home, from = current.homeFrom;
    if (!node || !from || reduced() || typeof node.animate !== 'function') return null;
    const [tx, ty] = node.hidden ? [current.geo.sign * current.geo.ringX, 0] : String(node.style.translate || '0px 0px').split(' ').map(parseFloat);
    // 格子停在指针处时自身已放大，起止帧按它折算，滑动全程 logo 与圆框都是悬浮入口的大小比例。
    const grow = parseFloat(node.style.getPropertyValue('--qd-grow')) || 1;
    const away = { transform: `translate(${(from.x - tx).toFixed(1)}px, ${(from.y - (ty || 0)).toFixed(1)}px) scale(${(from.scale / grow).toFixed(3)})`, opacity: 1 }, home = { transform: 'none' };
    if (node.hidden) { if (!back) return null; node.hidden = false; node.style.translate = `${tx}px 0px`; node.style.opacity = '1'; }
    return node.animate(back ? [home, away] : [away, home], { duration: back ? 190 : 260, easing: 'cubic-bezier(.25, .9, .3, 1)', fill: back ? 'forwards' : 'none' });
  }

  function close() {
    if (!view) return;
    const current = view; view = null;
    cancelAnimationFrame(current.frame);
    current.stop();
    const done = () => { current.root.remove(); current.origin.classList?.remove('sd-wheel-away'); };
    // 立即让出快捷盘图层的身份与指针，盘面淡出、logo 滑回原位后再移除。
    current.root.id = LEAVING_ID;
    current.root.classList.add('is-leaving');
    // logo 滑回时恢复成和悬浮入口一样的大小与样式（它此刻可能正停在指针处、处于放大染色状态）。
    current.home?.classList.remove('is-current');
    current.home?.style.setProperty('--qd-grow', '1');
    const motion = flyHome(current, true);
    if (motion) { motion.onfinish = motion.oncancel = done; setTimeout(done, 400); } else done();
    current.origin.classList?.remove('sd-wheel-active');
    onClosed?.(current.origin);
  }

  // 一次拨动：从当前位置起，按手指的纵向位移转动。松手时停到最近一格；停在别的入口上就打开它。
  function beginSlide(startY) {
    return { startY, from: view.position, origin: quickDialSelected(view.position, view.list.length, view.cyclic), slid: false };
  }
  function slideTo(slide, y, slop) {
    if (!view || view.leaving) return;
    const dy = y - slide.startY;
    if (!slide.slid && Math.abs(dy) <= slop) return;
    if (!slide.slid) { slide.slid = true; cancelAnimationFrame(view.frame); view.root.classList.add('is-sliding'); }
    view.position = limit(slide.from - dy / view.geo.pitch);
    layout();
  }
  function endSlide(slide, cancelled) {
    if (!view) return;
    view.root.classList.remove('is-sliding');
    if (!slide.slid) return;
    const target = cancelled ? slide.from : nearest();
    const picked = quickDialSelected(target, view.list.length, view.cyclic);
    settle(target, () => { if (!cancelled && picked !== slide.origin) activate(target); });
  }

  function open(origin) {
    close();
    const list = [...(items?.() || []), { id: HOME, label: '千幕', home: true }];
    const box = viewportBox(), rect = origin.getBoundingClientRect();
    const geo = quickDialGeometry({ centerX: rect.left + rect.width / 2 - box.left, centerY: rect.top + rect.height / 2 - box.top, width: box.width, height: box.height, size: Number(floatSize?.()) || 48 });
    // 配色与入口样式都从悬浮入口本身读取：它在各主题、日夜间下已经是对的，盘上的入口照它的样子画，滑入滑出不变样。
    const colors = palette?.() || {}, look = window.getComputedStyle?.(origin), sheen = window.getComputedStyle?.(origin, '::before');
    const accent = look?.getPropertyValue('--sd-float-edge').trim() || colors.mainEdge || colors.edges?.[0] || '#c99b51';
    const cyclic = quickDialCyclic(list.length);
    const root = document.createElement('div');
    root.id = id;
    root.className = `qm-dial qm-dial-${geo.side}${isDark?.() ? ' is-dark' : ''}${cyclic ? '' : ' is-open-ended'}`;
    root.dataset.qianmuTransient = '';
    Object.assign(root.style, { left: `${box.left}px`, top: `${box.top}px`, width: `${box.width}px`, height: `${box.height}px` });
    root.style.setProperty('--qd-c1', accent);
    root.style.setProperty('--qd-c2', accent);
    root.style.setProperty('--qd-accent', accent);
    if (look?.backgroundColor && look.backgroundColor !== 'rgba(0, 0, 0, 0)') root.style.setProperty('--qd-chip-bg', look.backgroundColor);
    if (sheen?.backgroundImage && sheen.backgroundImage !== 'none') root.style.setProperty('--qd-chip-sheen', sheen.backgroundImage);
    const blur = look?.backdropFilter || look?.webkitBackdropFilter;
    if (blur && blur !== 'none') root.style.setProperty('--qd-chip-blur', blur);
    root.style.setProperty('--qd-r', `${geo.rx}px`);
    root.style.setProperty('--qd-chip', `${geo.chip}px`);
    root.innerHTML = `<div class="qm-dial-backdrop"></div><div class="qm-dial-stage" style="left:${geo.x}px;top:${geo.y}px">${arcMarkup(geo, `qm-dial-g${++serial}`)}<div class="qm-dial-items" role="menu" aria-label="千幕快捷轮盘"></div><div class="qm-dial-label" aria-live="polite"></div></div>`;
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
        // 收纳图标的兜底、三个可拖出入口的拖出逻辑都由调用方绑定；它们写的提示语按轮盘的说法改回。
        bindItem?.(node, item, { itemSize: geo.chip, itemHeight: geo.chip });
        node.removeAttribute('title');
        node.setAttribute('aria-label', item.label);
      }
      return node;
    });
    // logo 那一格直接沿用悬浮入口此刻显示的那枚标志：纸间／极简主题下入口画的是随主题着色的矢量标志而不是原图，
    // 盘里照抄它本身、它的两枚主题色，以及它在圆框里的占比与偏移，滑入滑出前后才是同一个样子。
    const mark = [...(origin.children || [])].find(node => /^(img|svg)$/i.test(node.tagName) && !node.classList.contains('sd-hive-hex-outline') && window.getComputedStyle(node).display !== 'none');
    const homeChip = nodes[list.length - 1]?.firstElementChild;
    if (mark && homeChip && rect.width > 0) {
      const style = window.getComputedStyle(mark), box = mark.getBoundingClientRect(), pad = side => parseFloat(style[`padding${side}`]) || 0;
      const width = box.width - pad('Left') - pad('Right'), height = box.height - pad('Top') - pad('Bottom'), ratio = geo.chip / rect.width;
      const dx = (box.left + pad('Left') + width / 2 - rect.left - rect.width / 2) * ratio, dy = (box.top + pad('Top') + height / 2 - rect.top - rect.height / 2) * ratio;
      const copy = mark.cloneNode(true);
      copy.removeAttribute('class'); copy.removeAttribute('id'); copy.setAttribute('draggable', 'false');
      copy.style.cssText = `display:block;width:${(width / rect.width * 100).toFixed(2)}%;height:${(height / rect.height * 100).toFixed(2)}%;padding:0;margin:0;position:static;transform:none;translate:${dx.toFixed(2)}px ${dy.toFixed(2)}px;object-fit:contain;pointer-events:none;`;
      for (const name of ['--qm-ink', '--qm-accent']) { const value = look?.getPropertyValue(name).trim(); if (value) copy.style.setProperty(name, value); }
      copy.classList.add('qm-dial-logo');
      homeChip.replaceChildren(copy);
    }
    const remembered = recall?.(), start = Math.max(0, list.findIndex(item => item.id === remembered));
    document.body.appendChild(root);
    applyIcons?.(root);
    view = { root, origin, geo, list, nodes, cyclic, position: start, selected: -1, frame: 0, leaving: false, stop: () => {},
      label: root.querySelector('.qm-dial-label'), dot: root.querySelector('.qm-dial-dot') };
    root._qmCleanup = close;
    origin.classList?.add('sd-wheel-active');
    layout();
    view.stop = bindStage(root);
    // logo 滑进弧线：悬浮入口自身隐去，由盘里的主面板入口从它的位置滑到自己的格子上。
    view.home = nodes[list.length - 1];
    view.homeFrom = { x: rect.left + rect.width / 2 - box.left - geo.x, y: rect.top + rect.height / 2 - box.top - geo.y, scale: rect.height / geo.chip };
    origin.classList?.add('sd-wheel-away');
    // 格子若正停在指针处，它的放大不走过渡、直接到位，滑入的起点才正好是悬浮入口的大小。
    if (homeChip?.style) { homeChip.style.transition = 'none'; void homeChip.offsetWidth; requestAnimationFrame(() => { homeChip.style.transition = ''; }); }
    flyHome(view, false);
    return root;
  }

  // 轮盘留在屏上时的手势：在盘面任意处上下拖动＝拨动；点入口＝打开；点空白＝收起。
  // 便笺／场外特助／聊天工具包停在指针处时，横向把它拖出轮盘可成为独立悬浮入口（沿用蜂巢的拖出逻辑）。
  function bindStage(root) {
    const backdrop = root.querySelector('.qm-dial-backdrop');
    let gesture = null;
    const down = event => {
      if (gesture || !view || event.isPrimary === false || (event.button != null && event.button !== 0)) return;
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
    const step = by => { const next = nearest() + by; settle(view.cyclic ? next : clamp(next, 0, view.list.length - 1)); };
    const wheel = event => {
      if (!view || view.leaving) return;
      event.preventDefault();
      step(Math.sign(event.deltaY));
    };
    const key = event => {
      if (!view) return;
      if (event.key === 'Escape') return close();
      if (view.leaving) return;
      const by = event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : 0;
      if (by) { event.preventDefault(); return step(by); }
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

  return Object.freeze({ open, close, get isOpen() { return !!view; } });
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

/** 快捷格每行放几个：先按可用宽度定一行最多几格，再把格子均分到各行（各行最多差一格），末行不会只剩一两格。
 * min 是一格至少多宽：四个字的入口名要一行放得下。 */
export function tidyCellRows(count, width, { min = 54, gap = 5, most = 9 } = {}) {
  const total = Math.max(0, Math.floor(Number(count) || 0));
  if (!total) return [];
  const fit = width > 0 ? Math.max(3, Math.min(most, Math.floor((width + gap) / (min + gap)))) : 4;
  const rows = Math.ceil(total / fit), base = Math.floor(total / rows), extra = total % rows;
  return Array.from({ length: rows }, (_, row) => base + (row < extra ? 1 : 0));
}

// 设置页里的快捷格：跟着面板宽度重排。每格记下自己那一行有几格（--qm-row），宽度由样式按它平分；高度全表一致。
// 拖动排序会挪动节点，所以节点一变就重排一次。返回停止函数。
export function bindQuickCellLayout(list, { selector = '[data-command]', gap = 5, window = globalThis } = {}) {
  if (!list) return () => {};
  let last = '';
  const layout = () => {
    const cells = [...list.querySelectorAll(selector)], width = list.clientWidth || 0, rows = tidyCellRows(cells.length, width, { gap });
    const widest = Math.max(1, ...rows), height = width > 0 ? Math.round(Math.max(62, Math.min(72, (width - (widest - 1) * gap) / widest / 1.12))) : 0;
    const signature = `${rows.join(',')}|${height}|${cells.map(cell => cell.dataset?.command).join(',')}`;
    if (signature === last) return;
    last = signature;
    let index = 0;
    for (const size of rows) for (let n = 0; n < size; n++) cells[index++]?.style?.setProperty('--qm-row', String(size));
    if (height) list.style?.setProperty('--qm-cell-h', `${height}px`);
  };
  layout();
  const observers = [];
  const watch = (Observer, options) => {
    if (typeof Observer !== 'function') return;
    const observer = new Observer(() => { if (list.isConnected === false) stop(); else layout(); });
    observer.observe(list, options); observers.push(observer);
  };
  function stop() { for (const observer of observers.splice(0)) observer.disconnect(); }
  watch(window.ResizeObserver);
  watch(window.MutationObserver, { childList: true });
  return stop;
}
