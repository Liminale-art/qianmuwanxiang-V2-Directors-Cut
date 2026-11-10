// Ringtone tab of the chat toolkit: completion sound (built-in / link / local file), volume, and background-tab flash.
// Pure DOM over the actions handed in by qianmu-chat-ringtone.js; it stores nothing itself.
const SOURCE_LABELS = [['builtin', '内置'], ['url', '链接'], ['local', '本地']];
const formatSize = bytes => bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;

export function mountChatRingtoneView({ root, actions, notify = () => {} }) {
  const document = root.ownerDocument;
  let disposed = false, last = null;
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
  const toggle = (label, checked, onChange, className = '') => {
    const wrap = el('label', `qm-ring-toggle ${className}`.trim());
    const input = el('input'); input.type = 'checkbox'; input.checked = checked;
    input.addEventListener('change', () => run(() => onChange(input.checked)));
    wrap.append(input, el('span', '', label)); return wrap;
  };
  const filePicker = (accept, onFile) => {
    const input = el('input'); input.type = 'file'; input.accept = accept; input.hidden = true;
    input.addEventListener('change', () => { const file = input.files?.[0]; input.value = ''; if (file) run(() => onFile(file)); });
    return input;
  };

  function soundCard(s) {
    const card = el('section', 'qm-ring-card');
    const head = el('div', 'qm-ring-head');
    head.append(el('h4', '', '消息完成提示音'), toggle(s.soundEnabled ? '已开启' : '已关闭', s.soundEnabled, on => actions.update({ soundEnabled: on }), 'qm-ring-switch'));
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
      const select = el('select', 'qm-ring-preset'); select.setAttribute('aria-label', '内置铃声');
      const groups = new Map();
      for (const preset of actions.presets) {
        if (!groups.has(preset.group)) { const group = el('optgroup'); group.label = preset.group; groups.set(preset.group, group); select.append(group); }
        const option = el('option', '', preset.label); option.value = preset.id; option.selected = preset.id === s.soundPreset;
        groups.get(preset.group).append(option);
      }
      select.addEventListener('change', () => run(() => actions.update({ soundPreset: select.value })));
      row.append(select);
    } else if (s.soundSource === 'url') {
      const input = el('input', 'qm-ring-url'); input.type = 'url'; input.inputMode = 'url'; input.maxLength = actions.limits.url;
      input.placeholder = 'https://…/铃声.mp3'; input.value = s.soundUrl;
      input.addEventListener('change', () => run(() => actions.update({ soundUrl: input.value })));
      row.append(input);
    } else {
      const picker = filePicker('audio/*', file => actions.pickLocal(file));
      const name = el('span', 'qm-ring-local-name', s.localName ? `${s.localName} · ${formatSize(s.localSize)}` : '尚未选择音频');
      row.append(name, picker, button(s.localName ? '更换' : '选择文件', 'qm-ring-pick', () => picker.click()));
      if (s.localName) row.append(button('移除', 'qm-ring-clear', () => actions.clearLocal()));
    }
    const playing = actions.playing();
    const preview = button(playing ? '停止' : '试听', 'qm-ring-preview', () => actions.preview());
    preview.dataset.ringPreview = '1'; row.append(preview);
    card.append(row);
    if (s.soundSource === 'local') card.append(el('p', 'qm-ring-note', `只保存在当前浏览器，不随账户同步；单个文件不超过 ${formatSize(actions.limits.localSoundBytes)}。`));
    const volume = el('label', 'qm-ring-volume');
    const range = el('input'); range.type = 'range'; range.min = '0'; range.max = '100'; range.step = '1'; range.value = String(s.volume);
    const value = el('output', '', `${s.volume}%`);
    range.addEventListener('input', () => { value.textContent = `${range.value}%`; actions.setVolume(Number(range.value)); });
    range.addEventListener('change', () => actions.setVolume(Number(range.value), true));
    volume.append(el('span', '', '音量'), range, value);
    card.append(volume, toggle('仅在页面切到后台时响铃', s.soundOnlyHidden, on => actions.update({ soundOnlyHidden: on })));
    return card;
  }

  function flashCard(s) {
    const card = el('section', 'qm-ring-card');
    const head = el('div', 'qm-ring-head');
    head.append(el('h4', '', '标签页闪烁提醒'), toggle(s.flashEnabled ? '已开启' : '已关闭', s.flashEnabled, on => actions.update({ flashEnabled: on }), 'qm-ring-switch'));
    card.append(head, el('p', 'qm-ring-note', '页面在后台时收到回复，标签页标题与图标交替闪烁，回到页面即停止。'));
    const text = el('label', 'qm-ring-field');
    const input = el('input', 'qm-ring-flash-text'); input.maxLength = actions.limits.flashText * 2; input.value = s.flashText; input.placeholder = '新消息';
    input.addEventListener('change', () => run(() => actions.update({ flashText: input.value })));
    text.append(el('span', '', '提醒文字'), input);
    card.append(text);
    const icons = el('div', 'qm-ring-icons');
    const frames = actions.iconFrames();
    for (const slot of [0, 1]) {
      const cell = el('div', 'qm-ring-icon');
      const image = el('img'); image.alt = `闪烁图标 ${slot + 1}`; image.width = 32; image.height = 32;
      if (frames[slot]) image.src = frames[slot]; else image.hidden = true;
      const picker = filePicker('image/*,.ico,.cur', file => actions.pickIcon(slot, file));
      cell.append(image, picker, button(`换图 ${slot + 1}`, 'qm-ring-pick', () => picker.click()));
      icons.append(cell);
    }
    card.append(icons);
    const tools = el('div', 'qm-ring-tools');
    if (s.iconSource === 'custom') tools.append(button('恢复默认图标', 'qm-ring-clear', () => actions.clearIcons()));
    tools.append(button('试看 6 秒', 'qm-ring-test', () => { if (!actions.testFlash()) notify('请先填写提醒文字或设置图标。', 'warning'); }));
    card.append(tools, el('p', 'qm-ring-note', '可上传 PNG、JPG、WebP、GIF、SVG 或 ICO，会自动转成标签页可用的方形图标。'));
    return card;
  }

  function render(s) {
    if (disposed) return;
    last = s;
    const focused = document.activeElement && root.contains(document.activeElement) ? document.activeElement.className : '';
    root.replaceChildren(soundCard(s), flashCard(s));
    if (focused) root.querySelector(`.${String(focused).split(' ')[0]}`)?.focus?.();
  }
  return Object.freeze({ render, dispose() { disposed = true; root.replaceChildren(); }, state: () => last });
}
