// Notification tab of the chat toolkit: completion sound (built-in / link / local file), volume, background-tab flash,
// and the ST notification skin.
// Pure DOM over the actions handed in by qianmu-chat-ringtone.js; it stores nothing itself.
// Built-in and local sounds use the phone-OS pattern: tapping a row in the list auditions and selects it at once,
// so there is no separate preview button; the list is an in-panel sub-page reached by a back-arrow page switch.
const SOURCE_LABELS = [['builtin', '内置'], ['url', '链接'], ['local', '本地']];
const formatSize = bytes => bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;

export function mountChatRingtoneView({ root, actions, notify = () => {} }) {
  const document = root.ownerDocument;
  let disposed = false, last = null, page = 'main', audio = 'idle', eq = null;
  const run = async action => {
    try { await action(); } catch (error) { if (!disposed) notify(error?.message || '操作未完成，请重试。', 'warning'); }
  };
  const el = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const button = (label, className, action) => {
    const node = el('button', className, label); node.type = 'button';
    node.addEventListener('click', () => run(action)); return node;
  };
  const icon = name => { const i = el('i', `fa-solid ${name}`); i.setAttribute('aria-hidden', 'true'); return i; };
  const iconButton = (faName, title, className, action) => {
    const node = el('button', `qm-ring-iconbtn ${className}`.trim()); node.type = 'button';
    node.title = title; node.setAttribute('aria-label', title); node.append(icon(faName));
    node.addEventListener('click', () => run(action)); return node;
  };
  // Capsule (pill) switch. `after` places the track behind the text.
  const capsule = (label, checked, onChange, { after = false, ariaLabel = '' } = {}) => {
    const wrap = el('label', 'qm-ring-cap');
    const input = el('input'); input.type = 'checkbox'; input.checked = checked; input.className = 'qm-ring-cap-input';
    if (ariaLabel) input.setAttribute('aria-label', ariaLabel);
    input.addEventListener('change', () => run(() => onChange(input.checked)));
    const track = el('span', 'qm-ring-cap-track'); track.append(el('span', 'qm-ring-cap-knob'));
    const parts = label ? (after ? [el('span', 'qm-ring-cap-label', label), input, track] : [input, track, el('span', 'qm-ring-cap-label', label)]) : [input, track];
    wrap.append(...parts); return wrap;
  };
  const filePicker = (accept, onFile) => {
    const input = el('input'); input.type = 'file'; input.accept = accept; input.hidden = true;
    input.addEventListener('change', () => { const file = input.files?.[0]; input.value = ''; if (file) run(() => onFile(file)); });
    return input;
  };

  const presetLabel = id => actions.presets.find(p => p.id === id)?.label || '选择铃声';
  const presetGroups = () => {
    const map = new Map();
    for (const p of actions.presets) { if (!map.has(p.group)) map.set(p.group, []); map.get(p.group).push({ id: p.id, label: p.label }); }
    return [...map].map(([label, items]) => ({ label, items }));
  };

  // A list sub-page takes over the whole toolkit panel at the height the 通知 page had,
  // so opening it never stretches the panel; longer lists scroll inside.
  function lockPanel(on) {
    const panel = root.closest?.('.sd-floor-panel');
    if (!panel?.classList) return;
    if (on) {
      const height = panel.getBoundingClientRect?.().height;
      if (height > 0) panel.style.setProperty('--qm-ring-lock-h', `${Math.round(height)}px`);
      panel.classList.add('qm-ring-subpage-open');
    } else {
      panel.classList.remove('qm-ring-subpage-open');
      panel.style.removeProperty('--qm-ring-lock-h');
    }
  }
  // 列表里点选只存设置、不重画，所以回到上一级时按当前存着的设置画，刚选的铃声立刻显示出来。
  const fresh = () => actions.current?.() || last;
  function goMain() { actions.stopSound(); page = 'main'; lockPanel(false); render(fresh()); }
  function openList(kind) { lockPanel(true); page = kind; render(fresh()); }

  // Phone-OS style chooser: each row auditions + selects on tap; the filled radio marks the current pick.
  // Selection persists without a re-render (actions.select*), so tapping never resets the list scroll.
  function listPage({ title, groups, currentId, onPick, onDelete, headExtra = null }) {
    const wrap = el('div', 'qm-ring-subpage');
    const head = el('div', 'qm-ring-subhead');
    head.append(iconButton('fa-arrow-left', '返回', 'qm-ring-back', async () => goMain()), el('h4', '', title));
    if (headExtra) head.append(headExtra);
    wrap.append(head);
    const listEl = el('div', 'qm-ring-list'); listEl.setAttribute('role', 'radiogroup'); listEl.setAttribute('aria-label', title);
    const items = [];
    const paint = active => { for (const node of items) { const on = node.dataset.id === active; node.classList.toggle('is-active', on); node.setAttribute('aria-checked', String(on)); } };
    for (const group of groups) {
      if (!group.items.length) continue;
      if (group.label) listEl.append(el('div', 'qm-ring-list-group', group.label));
      for (const item of group.items) {
        const rowEl = el('div', 'qm-ring-list-row');
        const choose = el('button', `qm-ring-list-item${item.id === currentId ? ' is-active' : ''}`); choose.type = 'button';
        choose.setAttribute('role', 'radio'); choose.setAttribute('aria-checked', String(item.id === currentId)); choose.dataset.id = item.id;
        choose.append(el('span', 'qm-ring-list-name', item.label), el('span', 'qm-ring-radio'));
        // Mark the pick at once; the audition loads behind it. A failed pick restores the previous mark.
        choose.addEventListener('click', () => {
          const previous = items.find(node => node.classList.contains('is-active'))?.dataset.id;
          paint(item.id);
          run(async () => { try { await onPick(item.id); } catch (error) { paint(previous); throw error; } });
        });
        items.push(choose); rowEl.append(choose);
        if (onDelete) rowEl.append(iconButton('fa-trash', '删除', 'qm-ring-list-del', () => onDelete(item.id)));
        listEl.append(rowEl);
      }
    }
    if (!items.length) listEl.append(el('p', 'qm-ring-list-empty', onDelete ? '还没有本地铃声，点右上角＋上传。' : '暂无可选项。'));
    eq = audioBar();
    // C-14: the audio bar is its own strip card above the list (pinning it flush to the bottom never held up).
    wrap.append(eq, listEl);
    return wrap;
  }

  // Audio bar: a strip card between the sub-page head and the list, outside the scrollable list.
  // It follows the real audition: the bars are the live spectrum read from the playing sound (actions.audioLevels),
  // centre-out from low to high, rising quickly and settling softly. Nothing moves unless sound data really arrives:
  // idle, loading, a sound that cannot be analysed (cross-origin, no Web Audio) and reduced motion all draw a still row.
  const BAR = 2, GAP = 3, QUIET_FRAMES = 36;
  let loop = 0, bins = null, heights = [], quiet = 0, live = false;
  function audioBar() {
    const bar = el('div', 'qm-ring-eq'); bar.setAttribute('aria-hidden', 'true'); bar.dataset.audio = audio;
    bar.append(el('canvas', 'qm-ring-eq-canvas'));
    return bar;
  }
  const win = () => document.defaultView || null;
  const stillMotion = () => { try { return Boolean(win()?.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches); } catch (_) { return false; } };
  // One frame. levels: 0–1 per bar, or null for the still row (a dotted hairline).
  function drawBars(levels) {
    const canvas = eq?.querySelector?.('canvas'), ctx = canvas?.getContext?.('2d');
    if (!ctx) return 0;
    const ratio = win()?.devicePixelRatio || 1, width = canvas.clientWidth, height = canvas.clientHeight;
    if (!(width > 0 && height > 0)) return 0;
    if (canvas.width !== Math.round(width * ratio) || canvas.height !== Math.round(height * ratio)) { canvas.width = Math.round(width * ratio); canvas.height = Math.round(height * ratio); }
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, width, height);
    const count = Math.max(8, Math.floor((width + GAP) / (BAR + GAP))), left = (width - (count * (BAR + GAP) - GAP)) / 2, middle = height / 2;
    let color = '';
    try { color = win()?.getComputedStyle?.(eq)?.color || ''; } catch (_) {}
    ctx.fillStyle = '#7f7f7f'; if (color) ctx.fillStyle = color;
    for (let i = 0; i < count; i += 1) {
      const level = levels ? levels[i] || 0 : 0, tall = Math.max(BAR, level * (height - 6));
      ctx.globalAlpha = levels ? 0.35 + 0.65 * Math.min(1, level * 1.4) : 0.55;
      const x = left + i * (BAR + GAP), y = middle - tall / 2;
      if (typeof ctx.roundRect === 'function') { ctx.beginPath(); ctx.roundRect(x, y, BAR, tall, BAR / 2); ctx.fill(); } else ctx.fillRect(x, y, BAR, tall);
    }
    ctx.globalAlpha = 1;
    return count;
  }
  // Spectrum → bars, mirrored around the centre: low notes in the middle, highs toward both ends.
  // Returns null until the sound has produced any data at all; after that, silent stretches settle down smoothly.
  function spectrum(count) {
    const usable = Math.max(4, Math.floor(bins.length * 0.72)), out = new Array(count), half = (count - 1) / 2 || 1;
    let any = false;
    for (let i = 0; i < count; i += 1) {
      const distance = Math.abs(i - half) / half, index = Math.min(usable - 1, Math.floor(distance ** 1.4 * usable));
      const target = bins[index] / 255, current = heights[i] || 0;
      if (bins[index]) any = true;
      out[i] = heights[i] = current + (target - current) * (target > current ? 0.55 : 0.16);
    }
    if (any) live = true;
    return live ? out : null;
  }
  function stopLoop() { if (loop) win()?.cancelAnimationFrame?.(loop); loop = 0; heights = []; quiet = 0; live = false; }
  function frame() {
    loop = 0;
    if (disposed || !eq || audio !== 'playing') return;
    const count = Math.max(8, Math.floor(((eq.querySelector?.('canvas')?.clientWidth || 0) + GAP) / (BAR + GAP)));
    if (!bins) bins = new Uint8Array(128);
    const got = actions.audioLevels?.(bins) === true;
    const levels = got ? spectrum(count) : null;
    // Data never arrives (a source the browser keeps silent): give up and stay still instead of faking motion.
    quiet = levels ? 0 : quiet + 1;
    if (!got || quiet > QUIET_FRAMES) { drawBars(null); return; }
    drawBars(levels);
    loop = win()?.requestAnimationFrame?.(frame) || 0;
  }
  function paintAudio() {
    stopLoop();
    if (!eq) return;
    eq.dataset.audio = audio;
    drawBars(null);
    if (audio === 'playing' && !stillMotion() && typeof win()?.requestAnimationFrame === 'function') loop = win().requestAnimationFrame(frame);
  }
  function setAudio(next) {
    audio = ['loading', 'playing'].includes(next) ? next : 'idle';
    paintAudio();
  }

  function builtinListPage(s) {
    return listPage({ title: '选择内置铃声', groups: presetGroups(), currentId: s.soundPreset, onPick: id => actions.selectPreset(id) });
  }
  function localListPage(s) {
    const upload = filePicker('audio/*', file => actions.pickLocal(file));
    const add = iconButton('fa-plus', '上传本地铃声', 'qm-ring-list-add', async () => upload.click());
    add.append(upload);
    return listPage({
      title: '选择本地铃声', currentId: s.localId,
      groups: [{ label: '', items: s.localSounds.map(item => ({ id: item.id, label: `${item.name} · ${formatSize(item.size)}` })) }],
      onPick: id => actions.selectLocal(id), onDelete: id => actions.clearLocal(id), headExtra: add,
    });
  }

  function soundCard(s) {
    const card = el('section', 'qm-ring-card');
    const head = el('div', 'qm-ring-head');
    head.append(el('h4', '', '消息完成提示音'), capsule('', s.soundEnabled, on => actions.update({ soundEnabled: on }), { ariaLabel: '开启消息完成提示音' }));
    card.append(head);
    const sources = el('div', 'qm-ring-sources'); sources.setAttribute('role', 'tablist'); sources.setAttribute('aria-label', '提示音来源');
    for (const [id, label] of SOURCE_LABELS) {
      const node = button(label, s.soundSource === id ? 'is-active' : '', () => actions.update({ soundSource: id }));
      node.setAttribute('role', 'tab'); node.setAttribute('aria-selected', String(s.soundSource === id)); node.dataset.ringSource = id;
      sources.append(node);
    }
    card.append(sources);
    const row = el('div', 'qm-ring-source-row');
    if (s.soundSource === 'builtin') {
      // One picker button → the built-in list sub-page (tap a row to audition + select).
      const picker = button(presetLabel(s.soundPreset), 'qm-ring-picker', async () => openList('builtin'));
      picker.append(icon('fa-chevron-right'));
      row.append(picker);
    } else if (s.soundSource === 'url') {
      const input = el('input', 'qm-ring-url'); input.type = 'url'; input.inputMode = 'url'; input.maxLength = actions.limits.url;
      input.placeholder = 'https://…/铃声.mp3'; input.value = s.soundUrl;
      input.addEventListener('change', () => run(() => actions.update({ soundUrl: input.value })));
      row.append(input);
    } else {
      // Local library: one picker button → the local list sub-page, where rows audition + select and uploading lives in its header.
      const current = s.localSounds.find(item => item.id === s.localId);
      const picker = button(current ? current.name : '选择本地铃声', 'qm-ring-picker', async () => openList('local'));
      picker.append(icon('fa-chevron-right'));
      row.append(picker);
    }
    card.append(row);
    const volume = el('label', 'qm-ring-volume');
    const range = el('input'); range.type = 'range'; range.min = '0'; range.max = '100'; range.step = '1'; range.value = String(s.volume);
    const value = el('output', '', `${s.volume}%`);
    range.addEventListener('input', () => { value.textContent = `${range.value}%`; actions.setVolume(Number(range.value)); });
    range.addEventListener('change', () => actions.setVolume(Number(range.value), true));
    volume.append(el('span', '', '音量'), range, value);
    card.append(volume);
    return card;
  }

  // 「仅在切到后台时响铃」独立成卡，样式与消息完成提示音卡一致，胶囊开关在右侧。
  function backgroundCard(s) {
    const card = el('section', 'qm-ring-card');
    const head = el('div', 'qm-ring-head');
    head.append(el('h4', '', '仅在切到后台时响铃'), capsule('', s.soundOnlyHidden, on => actions.update({ soundOnlyHidden: on }), { ariaLabel: '仅在切到后台时响铃' }));
    card.append(head);
    return card;
  }

  function flashCard(s) {
    const card = el('section', 'qm-ring-card');
    const head = el('div', 'qm-ring-head');
    head.append(el('h4', '', '标签页闪烁提醒'), capsule('', s.flashEnabled, on => actions.update({ flashEnabled: on }), { ariaLabel: '开启标签页闪烁提醒' }));
    card.append(head);
    // 三个圆形可点图标在提醒文字之上：最左是标签页平时显示的固定图标，隔开一点；右边两个是闪烁时交替的图标。
    const icons = el('div', 'qm-ring-icons');
    const frames = actions.iconFrames();
    {
      const picker = filePicker('image/*,.ico,.cur', file => actions.pickFixedIcon(file));
      const cell = el('button', 'qm-ring-icon qm-ring-icon-fixed'); cell.type = 'button';
      cell.title = '点击更换标签页图标'; cell.setAttribute('aria-label', '更换标签页图标');
      const image = el('img'); image.alt = '标签页图标'; image.width = 28; image.height = 28; image.src = actions.fixedIcon();
      cell.append(image);
      cell.addEventListener('click', () => picker.click());
      cell.appendChild(picker);
      icons.append(el('span', 'qm-ring-icon-label', '固定小图标'), cell);
    }
    for (const slot of [0, 1]) {
      const picker = filePicker('image/*,.ico,.cur', file => actions.pickIcon(slot, file));
      const cell = el('button', 'qm-ring-icon'); cell.type = 'button';
      cell.title = `点击更换图标 ${slot + 1}`; cell.setAttribute('aria-label', `更换闪烁图标 ${slot + 1}`);
      const image = el('img'); image.alt = `闪烁图标 ${slot + 1}`; image.width = 28; image.height = 28;
      if (frames[slot]) image.src = frames[slot]; else cell.classList.add('is-empty');
      cell.append(image);
      cell.addEventListener('click', () => picker.click());
      cell.appendChild(picker);
      if (slot === 0) icons.append(el('span', 'qm-ring-icon-label', '闪烁小图标'));
      icons.append(cell);
    }
    card.append(icons);
    const text = el('div', 'qm-ring-field');
    const input = el('input', 'qm-ring-flash-text'); input.maxLength = actions.limits.flashText * 2; input.value = s.flashText; input.placeholder = '新消息';
    input.addEventListener('change', () => run(() => actions.update({ flashText: input.value })));
    // 预览 sits right after the 新消息 input.
    const test = iconButton('fa-eye', '预览', 'qm-ring-test', async () => { if (!actions.testFlash()) notify('请先填写提醒文字或设置图标。', 'warning'); });
    text.append(el('span', '', '提醒文字'), input, test);
    card.append(text);
    return card;
  }

  // Horizontal wheel picker: the value resting under the centre pointer is the choice; both sides fade out.
  // Scroll-snap does the physics; the choice is committed once scrolling settles (scrollend, or a short quiet
  // gap where scrollend is missing) and never while a finger is still down. Tapping a value or arrow keys also pick.
  let afterRender = [];
  function wheel(label, options, current, key) {
    const field = el('div', 'qm-ring-field qm-ring-toast-field qm-ring-wheel-field');
    const frame = el('div', 'qm-ring-wheel');
    // The key class comes first: render() restores focus by the first class name.
    const strip = el('div', `qm-ring-wheel-${key} qm-ring-wheel-strip`); strip.setAttribute('role', 'radiogroup'); strip.setAttribute('aria-label', `提示框${label}`); strip.tabIndex = 0;
    const n = options.length;
    const loop = n > 2; // too few values to copy convincingly: keep a plain strip
    const makeItem = ([value, text], real) => {
      const node = el('button', 'qm-ring-wheel-item', text); node.type = 'button'; node.tabIndex = -1;
      node.setAttribute('role', 'radio'); node.dataset.value = String(value);
      if (!real) { node.classList.add('is-copy'); node.setAttribute('aria-hidden', 'true'); }
      strip.append(node); return node;
    };
    // Seamless loop: flank the real strip with head/tail copies; once a settle lands the centre on a
    // copy, jump scrollLeft by one full set so the identical real value sits under the pointer (no motion).
    if (loop) options.forEach(opt => makeItem(opt, false));
    const items = options.map(opt => makeItem(opt, true));
    if (loop) options.forEach(opt => makeItem(opt, false));
    let index = Math.max(0, options.findIndex(([value]) => value === current)), touching = false, quiet = 0;
    const wrap = i => ((i % n) + n) % n; // head-tail cyclic: stepping past either end lands on the other
    const nearestChild = () => {
      const middle = strip.scrollLeft + strip.clientWidth / 2;
      const kids = loop ? Array.from(strip.children) : items;
      let best = 0, gap = Infinity;
      kids.forEach((node, i) => { const d = Math.abs(node.offsetLeft + node.offsetWidth / 2 - middle); if (d < gap) { gap = d; best = i; } });
      return best;
    };
    // When a settle rests the pointer over a head/tail copy, jump scrollLeft by one full set so the
    // identical real value sits under the pointer — no animation, so the loop reads as seamless.
    const relayout = () => {
      if (!loop || !strip.clientWidth) return;
      const child = nearestChild();
      if (child >= n && child < 2 * n) return; // already on the real middle band
      const real = items[child % n]; if (!real) return;
      strip.scrollLeft = real.offsetLeft - (strip.clientWidth - real.offsetWidth) / 2;
    };
    const mark = at => {
      items.forEach((node, i) => { node.classList.toggle('is-center', i === at); node.setAttribute('aria-checked', String(i === at)); });
      if (loop) for (const node of strip.children) node.classList.toggle('is-center', Number(node.dataset.value) === options[at]?.[0]);
    };
    const nearest = () => {
      if (!strip.clientWidth) return index; // not laid out yet: keep the saved value
      return loop ? nearestChild() % n : nearestChild();
    };
    // C-15: glide to the copy of the value nearest the pointer (a head/tail copy when the strip rests there),
    // never across a whole set back to the real band; relayout() then swaps to the real band without motion.
    const closest = at => {
      if (!loop || !strip.clientWidth) return items[at];
      const middle = strip.scrollLeft + strip.clientWidth / 2;
      let best = items[at], gap = Infinity;
      Array.from(strip.children).forEach((node, i) => { if (i % n !== at) return; const d = Math.abs(node.offsetLeft + node.offsetWidth / 2 - middle); if (d < gap) { gap = d; best = node; } });
      return best;
    };
    const centre = (at, smooth) => {
      const node = smooth ? closest(at) : items[at]; if (!node) return;
      const left = node.offsetLeft - (strip.clientWidth - node.offsetWidth) / 2;
      if (smooth && strip.scrollTo) strip.scrollTo({ left, behavior: 'smooth' }); else strip.scrollLeft = left;
    };
    const commit = at => {
      if (disposed || strip.isConnected === false || at < 0 || at >= options.length) return;
      index = at; mark(at);
      // C-15: a wheel pick saves quietly (no panel rebuild), so the strip never jumps back mid-glide.
      if (options[at][0] !== current) { current = options[at][0]; run(() => actions.update({ [key]: current }, { quiet: true })); }
    };
    const settle = () => { clearTimeout(quiet); quiet = 0; if (!touching) { commit(nearest()); relayout(); } };
    strip.addEventListener('scroll', () => { mark(nearest()); clearTimeout(quiet); quiet = setTimeout(settle, 160); }, { passive: true });
    strip.addEventListener('scrollend', settle);
    // A browser-driven touch scroll fires pointercancel while the finger is still down, so touch is
    // tracked with touch events; mouse/pen with pointer events.
    const release = () => { touching = false; clearTimeout(quiet); quiet = setTimeout(settle, 160); };
    strip.addEventListener('touchstart', () => { touching = true; }, { passive: true });
    for (const type of ['touchend', 'touchcancel']) strip.addEventListener(type, release, { passive: true });
    strip.addEventListener('pointerdown', event => { if (event?.pointerType !== 'touch') touching = true; });
    for (const type of ['pointerup', 'pointercancel']) strip.addEventListener(type, event => { if (event?.pointerType !== 'touch') release(); });
    // PC press-and-drag: a mouse/pen can scrub the strip horizontally (touch keeps native scroll).
    let drag = null, dragMoved = false;
    strip.addEventListener('pointerdown', event => {
      if (event?.pointerType === 'touch' || event.button !== 0) return;
      drag = { x: event.clientX, left: strip.scrollLeft }; dragMoved = false;
      strip.classList.add('is-dragging'); // suspend scroll-snap so the drag can't be yanked back
      try { strip.setPointerCapture?.(event.pointerId); } catch (_) {}
    });
    strip.addEventListener('pointermove', event => {
      if (!drag) return;
      const dx = event.clientX - drag.x;
      if (Math.abs(dx) > 3) dragMoved = true;
      strip.scrollLeft = drag.left - dx;
    });
    for (const type of ['pointerup', 'pointercancel', 'pointerleave']) strip.addEventListener(type, event => {
      if (!drag) return;
      drag = null;
      strip.classList.remove('is-dragging'); // restore snap, then glide to the nearest value
      if (dragMoved) centre(nearest(), true);
      try { strip.releasePointerCapture?.(event.pointerId); } catch (_) {}
    });
    // A vertical mouse wheel steps one value per notch instead of scrolling the panel; small trackpad
    // deltas accumulate first. Horizontal swipes are left to native scroll + snap.
    let wheelAcc = 0;
    strip.addEventListener('wheel', event => {
      if (Math.abs(event.deltaX) >= Math.abs(event.deltaY)) return;
      event.preventDefault();
      wheelAcc += event.deltaY; if (Math.abs(wheelAcc) < 40) return;
      const step = Math.sign(wheelAcc); wheelAcc = 0;
      index = wrap(nearest() + step); mark(index); centre(index, true); // head-tail loop
    }, { passive: false });
    strip.addEventListener('keydown', event => {
      const step = { ArrowLeft: -1, ArrowRight: 1 }[event.key]; if (!step) return;
      event.preventDefault(); const at = wrap(index + step); centre(at, true); commit(at); // head-tail loop
    });
    const kids = loop ? Array.from(strip.children) : items;
    kids.forEach((node, i) => node.addEventListener('click', () => { if (dragMoved) { dragMoved = false; return; } const at = loop ? i % n : i; centre(at, true); commit(at); relayout(); }));
    mark(index);
    afterRender.push(() => centre(index, false));
    frame.append(strip);
    field.append(el('span', '', label), frame);
    return field;
  }

  function toastCard(s) {
    const card = el('section', 'qm-ring-card');
    const head = el('div', 'qm-ring-head');
    head.append(el('h4', '', '提示框美化'), capsule('', s.toastSkin, on => actions.update({ toastSkin: on }), { ariaLabel: '开启提示框美化' }));
    card.append(head);
    const styles = el('div', 'qm-ring-sources qm-ring-toast-style'); styles.setAttribute('role', 'radiogroup'); styles.setAttribute('aria-label', '提示框样式');
    for (const [id, label] of actions.toastStyles) {
      const node = button(label, s.toastStyle === id ? 'is-active' : '', () => actions.update({ toastStyle: id }));
      node.setAttribute('role', 'radio'); node.setAttribute('aria-checked', String(s.toastStyle === id)); node.dataset.toastStyle = id;
      styles.append(node);
    }
    // The preview eye sits at the end of the style row.
    styles.append(iconButton('fa-eye', '预览', 'qm-ring-toast-test', async () => actions.previewToast()));
    card.append(styles);
    // 字号 / 停留时间: compact segmented rows.
    const segmented = (label, options, current, key) => {
      const field = el('div', 'qm-ring-field qm-ring-toast-field');
      const group = el('div', 'qm-ring-sources qm-ring-toast-seg'); group.setAttribute('role', 'radiogroup'); group.setAttribute('aria-label', `提示框${label}`);
      for (const [id, text] of options) {
        const node = button(text, current === id ? 'is-active' : '', () => actions.update({ [key]: id }));
        node.setAttribute('role', 'radio'); node.setAttribute('aria-checked', String(current === id));
        group.append(node);
      }
      field.append(el('span', '', label), group);
      return field;
    };
    card.append(segmented('字号', actions.toastFontSizes, s.toastFontSize, 'toastFontSize'),
      wheel('停留时间', actions.toastDurations || [], s.toastDuration, 'toastDuration'),
      wheel('堆叠数量', actions.toastStacks || [], s.toastStack, 'toastStack'));
    return card;
  }

  function render(s) {
    if (disposed) return;
    last = s; eq = null;
    if (page === 'builtin') { root.replaceChildren(builtinListPage(s)); root.querySelector('.qm-ring-list-item.is-active')?.scrollIntoView?.({ block: 'nearest' }); paintAudio(); return; }
    if (page === 'local') { root.replaceChildren(localListPage(s)); root.querySelector('.qm-ring-list-item.is-active')?.scrollIntoView?.({ block: 'nearest' }); paintAudio(); return; }
    stopLoop();
    const focused = document.activeElement && root.contains(document.activeElement) ? document.activeElement.className : '';
    afterRender = [];
    root.replaceChildren(soundCard(s), backgroundCard(s), flashCard(s), toastCard(s));
    for (const task of afterRender.splice(0)) task();
    if (focused) root.querySelector(`.${String(focused).split(' ')[0]}`)?.focus?.();
  }
  return Object.freeze({ render, setAudio, dispose() { disposed = true; stopLoop(); lockPanel(false); root.replaceChildren(); }, state: () => last });
}
