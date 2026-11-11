// Notification tab of the chat toolkit: completion sound (built-in / link / local file), volume, background-tab flash,
// and the ST notification skin.
// Pure DOM over the actions handed in by qianmu-chat-ringtone.js; it stores nothing itself.
const SOURCE_LABELS = [['builtin', '内置'], ['url', '链接'], ['local', '本地']];
const formatSize = bytes => bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;

export function mountChatRingtoneView({ root, actions, notify = () => {} }) {
  const document = root.ownerDocument;
  let disposed = false, last = null, previewBtn = null, sheet = null;
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

  function closeSheet() { if (sheet) { sheet.remove(); sheet = null; } }
  // One grouped bottom sheet for the mobile preset picker and the local-sound picker.
  function openSheet({ title, groups, currentId, onPick, onDelete }) {
    closeSheet();
    const overlay = el('div', 'qm-ring-sheet'); sheet = overlay;
    overlay.addEventListener('click', event => { if (event.target === overlay) closeSheet(); });
    const panel = el('div', 'qm-ring-sheet-panel');
    const head = el('div', 'qm-ring-sheet-head');
    head.append(el('h4', '', title), iconButton('fa-xmark', '关闭', 'qm-ring-sheet-close', async () => closeSheet()));
    panel.append(head);
    const body = el('div', 'qm-ring-sheet-body');
    if (!groups.length || groups.every(g => !g.items.length)) body.append(el('p', 'qm-ring-sheet-empty', '还没有可选项。'));
    for (const group of groups) {
      if (!group.items.length) continue;
      if (group.label) body.append(el('div', 'qm-ring-sheet-group', group.label));
      for (const item of group.items) {
        const rowEl = el('div', `qm-ring-sheet-item${item.id === currentId ? ' is-active' : ''}`);
        const pick = button(item.label, 'qm-ring-sheet-pick', async () => { closeSheet(); await onPick(item.id); });
        if (item.id === currentId) pick.append(icon('fa-check'));
        rowEl.append(pick);
        if (onDelete) rowEl.append(iconButton('fa-trash', '删除', 'qm-ring-sheet-del', () => onDelete(item.id)));
        body.append(rowEl);
      }
    }
    panel.append(body); overlay.append(panel); root.append(overlay);
  }

  const presetLabel = id => actions.presets.find(p => p.id === id)?.label || '选择铃声';
  const presetGroups = () => {
    const map = new Map();
    for (const p of actions.presets) { if (!map.has(p.group)) map.set(p.group, []); map.get(p.group).push({ id: p.id, label: p.label }); }
    return [...map].map(([label, items]) => ({ label, items }));
  };

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
      // PC keeps the native grouped select; mobile swaps to a custom grouped sheet (CSS toggles which shows).
      const select = el('select', 'qm-ring-preset'); select.setAttribute('aria-label', '内置铃声');
      const groups = new Map();
      for (const preset of actions.presets) {
        if (!groups.has(preset.group)) { const group = el('optgroup'); group.label = preset.group; groups.set(preset.group, group); select.append(group); }
        const option = el('option', '', preset.label); option.value = preset.id; option.selected = preset.id === s.soundPreset;
        groups.get(preset.group).append(option);
      }
      select.addEventListener('change', () => run(() => actions.update({ soundPreset: select.value })));
      const picker = button(presetLabel(s.soundPreset), 'qm-ring-picker qm-ring-picker-builtin', async () =>
        openSheet({ title: '选择内置铃声', groups: presetGroups(), currentId: s.soundPreset, onPick: id => actions.update({ soundPreset: id }) }));
      picker.append(icon('fa-chevron-down'));
      row.append(select, picker);
    } else if (s.soundSource === 'url') {
      const input = el('input', 'qm-ring-url'); input.type = 'url'; input.inputMode = 'url'; input.maxLength = actions.limits.url;
      input.placeholder = 'https://…/铃声.mp3'; input.value = s.soundUrl;
      input.addEventListener('change', () => run(() => actions.update({ soundUrl: input.value })));
      row.append(input);
    } else {
      // Local library: a custom picker (lists all cached sounds, each deletable) + upload + preview, three in one row.
      const current = s.localSounds.find(item => item.id === s.localId);
      const picker = button(current ? current.name : '选择本地铃声', 'qm-ring-picker', async () => {
        // 空列表时静默无反应：不弹出任何弹层或提示。
        if (!s.localSounds.length) return;
        openSheet({
          title: '本地铃声', currentId: s.localId,
          groups: [{ label: '', items: s.localSounds.map(item => ({ id: item.id, label: `${item.name} · ${formatSize(item.size)}` })) }],
          onPick: id => actions.selectLocal(id),
          onDelete: id => actions.clearLocal(id),
        });
      });
      picker.append(icon('fa-chevron-down'));
      const upload = filePicker('audio/*', file => actions.pickLocal(file));
      row.append(picker, upload, iconButton('fa-arrow-up-from-bracket', '上传本地音频', 'qm-ring-upload', async () => upload.click()));
    }
    previewBtn = iconButton(actions.playing() ? 'fa-stop' : 'fa-play', actions.playing() ? '停止' : '预览', 'qm-ring-preview', () => actions.preview());
    previewBtn.dataset.ringPreview = '1';
    row.append(previewBtn);
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
    card.append(el('p', 'qm-ring-note', '开启后，只有当浏览器标签切到后台时才会响铃；留在当前聊天时保持安静。'));
    return card;
  }

  function flashCard(s) {
    const card = el('section', 'qm-ring-card');
    const head = el('div', 'qm-ring-head');
    head.append(el('h4', '', '标签页闪烁提醒'), capsule('', s.flashEnabled, on => actions.update({ flashEnabled: on }), { ariaLabel: '开启标签页闪烁提醒' }));
    card.append(head);
    // 两个圆形可点图标移至提醒文字之上；点击图片本身即更换（并预览），无相机角标。
    const icons = el('div', 'qm-ring-icons');
    const frames = actions.iconFrames();
    for (const slot of [0, 1]) {
      const picker = filePicker('image/*,.ico,.cur', file => actions.pickIcon(slot, file));
      const cell = el('button', 'qm-ring-icon'); cell.type = 'button';
      cell.title = `点击更换图标 ${slot + 1}`; cell.setAttribute('aria-label', `更换闪烁图标 ${slot + 1}`);
      const image = el('img'); image.alt = `闪烁图标 ${slot + 1}`; image.width = 40; image.height = 40;
      if (frames[slot]) image.src = frames[slot]; else cell.classList.add('is-empty');
      cell.append(image);
      cell.addEventListener('click', () => picker.click());
      cell.appendChild(picker);
      icons.append(cell);
    }
    card.append(icons);
    if (s.iconSource === 'custom') {
      const tools = el('div', 'qm-ring-tools');
      tools.append(button('恢复默认图标', 'qm-ring-clear', () => actions.clearIcons()));
      card.append(tools);
    }
    const text = el('div', 'qm-ring-field');
    const input = el('input', 'qm-ring-flash-text'); input.maxLength = actions.limits.flashText * 2; input.value = s.flashText; input.placeholder = '新消息';
    input.addEventListener('change', () => run(() => actions.update({ flashText: input.value })));
    // 预览 sits right after the 新消息 input.
    const test = iconButton('fa-eye', '预览', 'qm-ring-test', async () => { if (!actions.testFlash()) notify('请先填写提醒文字或设置图标。', 'warning'); });
    text.append(el('span', '', '提醒文字'), input, test);
    card.append(text);
    return card;
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
    card.append(styles);
    const row = el('div', 'qm-ring-source-row');
    const positions = el('div', 'qm-ring-sources qm-ring-toast-pos'); positions.setAttribute('role', 'radiogroup'); positions.setAttribute('aria-label', '提示框位置');
    for (const [id, label] of actions.toastPositions) {
      const node = button(label, s.toastPosition === id ? 'is-active' : '', () => actions.update({ toastPosition: id }));
      node.setAttribute('role', 'radio'); node.setAttribute('aria-checked', String(s.toastPosition === id)); node.dataset.toastPosition = id;
      positions.append(node);
    }
    row.append(positions, iconButton('fa-eye', '预览', 'qm-ring-toast-test', async () => actions.previewToast()));
    card.append(row);
    return card;
  }

  function render(s) {
    if (disposed) return;
    last = s; closeSheet();
    const focused = document.activeElement && root.contains(document.activeElement) ? document.activeElement.className : '';
    root.replaceChildren(soundCard(s), backgroundCard(s), flashCard(s), toastCard(s));
    if (focused) root.querySelector(`.${String(focused).split(' ')[0]}`)?.focus?.();
  }
  // Update only the preview button so preview's pause/ended events never re-render an open picker.
  function syncPlaying(playing) {
    if (disposed || !previewBtn) return;
    previewBtn.replaceChildren(icon(playing ? 'fa-stop' : 'fa-play'));
    const title = playing ? '停止' : '预览';
    previewBtn.title = title; previewBtn.setAttribute('aria-label', title);
  }
  return Object.freeze({ render, syncPlaying, dispose() { disposed = true; closeSheet(); root.replaceChildren(); }, state: () => last });
}
