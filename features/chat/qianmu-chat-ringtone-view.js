// Notification tab of the chat toolkit: completion sound (built-in / link / local file), volume, background-tab flash,
// and the ST notification skin.
// Pure DOM over the actions handed in by qianmu-chat-ringtone.js; it stores nothing itself.
// Built-in and local sounds use the phone-OS pattern: tapping a row in the list auditions and selects it at once,
// so there is no separate preview button; the list is an in-panel sub-page reached by a back-arrow page switch.
const SOURCE_LABELS = [['builtin', '内置'], ['url', '链接'], ['local', '本地']];
const formatSize = bytes => bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;

export function mountChatRingtoneView({ root, actions, notify = () => {} }) {
  const document = root.ownerDocument;
  let disposed = false, last = null, page = 'main';
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
  function goMain() { actions.stopSound(); page = 'main'; lockPanel(false); render(last); }
  function openList(kind) { lockPanel(true); page = kind; render(last); }

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
    wrap.append(listEl);
    return wrap;
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
      segmented('停留时间', actions.toastDurations, s.toastDuration, 'toastDuration'));
    // 堆叠数量: how many notifications show at once; empty or 0 = unlimited (ST's own behaviour).
    const stackField = el('div', 'qm-ring-field qm-ring-toast-field qm-ring-toast-stack');
    const stack = el('input', 'qm-ring-stack-input'); stack.type = 'number'; stack.inputMode = 'numeric';
    stack.min = '0'; stack.max = String(actions.toastStackMax); stack.step = '1';
    stack.value = s.toastStack ? String(s.toastStack) : ''; stack.placeholder = '不限'; stack.setAttribute('aria-label', '提示框堆叠显示数量（留空为不限）');
    stack.addEventListener('change', () => run(() => {
      const value = Math.round(Number(stack.value || 0));
      return actions.update({ toastStack: Number.isFinite(value) ? Math.min(actions.toastStackMax, Math.max(0, value)) : 0 });
    }));
    stackField.append(el('span', '', '堆叠数量'), stack, el('span', 'qm-ring-stack-hint', `条 · 最多 ${actions.toastStackMax}`));
    card.append(stackField);
    return card;
  }

  function render(s) {
    if (disposed) return;
    last = s;
    if (page === 'builtin') { root.replaceChildren(builtinListPage(s)); root.querySelector('.qm-ring-list-item.is-active')?.scrollIntoView?.({ block: 'nearest' }); return; }
    if (page === 'local') { root.replaceChildren(localListPage(s)); root.querySelector('.qm-ring-list-item.is-active')?.scrollIntoView?.({ block: 'nearest' }); return; }
    const focused = document.activeElement && root.contains(document.activeElement) ? document.activeElement.className : '';
    root.replaceChildren(soundCard(s), backgroundCard(s), flashCard(s), toastCard(s));
    if (focused) root.querySelector(`.${String(focused).split(' ')[0]}`)?.focus?.();
  }
  return Object.freeze({ render, dispose() { disposed = true; lockPanel(false); root.replaceChildren(); }, state: () => last });
}
