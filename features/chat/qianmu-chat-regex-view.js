// Regex tab of the chat toolkit (D-a list + D-b single toggle).
// Pure DOM over the actions handed in by qianmu-chat-regex.js; it stores nothing and never touches ST itself:
// a switch only calls actions.toggle(), which owns the write-back. Two sections (global / current preset),
// each in original order or auto-grouped by name prefix. A source that cannot be written shows a status dot.
// Rows show the script name only; page-level icon controls share one tool row (the list view is a single toggle).
const VIEW_LABELS = Object.freeze({ order: '原始顺序', group: '自动分组' });
const VIEW_ICONS = Object.freeze({ order: 'fa-list-ol', group: 'fa-layer-group' });

export function mountChatRegexView({ root, actions, notify = () => {} }) {
  const document = root.ownerDocument;
  let disposed = false;
  const el = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };

  function toggleButton(item, source, busy) {
    const key = `${source}:${item.id}`;
    const button = el('button', `qm-regex-switch${item.enabled ? ' is-on' : ''}`);
    button.type = 'button';
    button.dataset.key = key;
    button.setAttribute('role', 'switch');
    button.setAttribute('aria-checked', String(item.enabled));
    button.setAttribute('aria-label', `${item.name}：${item.enabled ? '已启用，点按停用' : '已停用，点按启用'}`);
    if (busy) { button.disabled = true; button.setAttribute('aria-busy', 'true'); }
    button.append(el('span', 'qm-regex-knob'));
    button.addEventListener('click', () => {
      if (button.disabled) return;
      Promise.resolve().then(() => actions.toggle({ source, id: item.id, name: item.name, enabled: !item.enabled }))
        .catch(error => notify(error?.message || '正则开关写回失败', 'warning'));
    });
    return button;
  }

  // 全开 / 全关 for a section or group of a writable source; each is disabled when it would change nothing.
  function batchTools(items, source, label, pending) {
    const box = el('span', 'qm-regex-batch');
    const busy = items.some(item => pending.includes(`${source}:${item.id}`));
    for (const [enabled, icon, verb] of [[true, 'fa-toggle-on', '全部启用'], [false, 'fa-toggle-off', '全部停用']]) {
      const button = el('button', 'qm-regex-tool qm-regex-batch-button'); button.type = 'button';
      button.dataset.key = `batch:${source}:${label}:${enabled ? 'on' : 'off'}`;
      button.setAttribute('aria-label', `${label}：${verb}`); button.title = `${label}：${verb}`;
      const glyph = el('i', `fa-solid ${icon}`); glyph.setAttribute('aria-hidden', 'true'); button.append(glyph);
      if (busy || !items.some(item => item.enabled !== enabled)) button.disabled = true;
      button.addEventListener('click', () => {
        if (button.disabled) return;
        Promise.resolve().then(() => actions.toggleMany({ source, items, enabled }))
          .catch(error => notify(error?.message || '正则批量开关写回失败', 'warning'));
      });
      box.append(button);
    }
    return box;
  }

  function row(item, source, { writable = false, pending = [], bound = () => false } = {}) {
    const node = el('div', 'qm-regex-row');
    node.dataset.id = item.id;
    const name = el('span', 'qm-regex-name', item.name);
    name.title = item.name;
    if (writable && bound(`${source}:${item.id}`)) {
      node.classList.add('is-bound');
      const mark = el('i', 'fa-solid fa-link qm-regex-bound-mark'); mark.setAttribute('aria-hidden', 'true');
      name.append(document.createTextNode(' '), mark);
      name.title = `${item.name}（已记入本聊天绑定）`;
    }
    if (writable) {
      node.classList.add('is-writable');
      node.append(name, toggleButton(item, source, pending.includes(`${source}:${item.id}`)));
    } else {
      const dot = el('span', `qm-regex-dot${item.enabled ? ' is-on' : ''}`);
      dot.setAttribute('role', 'img');
      dot.setAttribute('aria-label', item.enabled ? '已启用' : '已停用');
      node.append(dot, name);
    }
    if (!item.enabled) node.classList.add('is-off');
    return node;
  }

  function list(items, mode, source, options) {
    const box = el('div', 'qm-regex-list');
    const make = item => row(item, source, options);
    if (!items.length) { box.append(el('p', 'qm-regex-empty', '没有正则脚本')); return box; }
    if (mode !== 'group') { box.append(...items.map(make)); return box; }
    for (const group of actions.group(items)) {
      const head = el('div', 'qm-regex-group');
      head.append(el('span', 'qm-regex-group-label', `${group.label}（${group.items.length}）`));
      if (options.writable) head.append(batchTools(group.items, source, group.label, options.pending));
      box.append(head, ...group.items.map(make));
    }
    return box;
  }

  function section(title, note, items, mode, { unavailable = '', source = '', writable = false, pending = [], bound = () => false } = {}) {
    const card = el('section', 'qm-regex-card');
    const head = el('header', 'qm-regex-card-head');
    head.append(el('h4', 'qm-regex-title', title));
    if (note) head.append(el('span', 'qm-regex-note', note));
    if (!unavailable && writable && items.length) head.append(batchTools(items, source, title, pending));
    card.append(head);
    if (unavailable) card.append(el('p', 'qm-regex-empty', unavailable));
    else card.append(list(items, mode, source, { writable, pending, bound }));
    return card;
  }

  // Re-rendering swaps every node, so keep the keyboard focus on the same switch and the scroll offset.
  function focusedKey() {
    const active = document.activeElement;
    return active && typeof root.contains === 'function' && root.contains(active) ? active.dataset?.key || '' : '';
  }

  function render(state) {
    if (disposed || !state) return;
    const { view, sources } = state;
    const binding = state.binding && typeof state.binding === 'object' ? state.binding : { enabled: false, overrides: {} };
    const bound = key => binding.enabled && binding.overrides && Object.prototype.hasOwnProperty.call(binding.overrides, key);
    const pending = Array.isArray(state.pending) ? state.pending : [];
    const keep = focusedKey(), scroll = root.scrollTop;
    const tools = el('div', 'qm-regex-tools');
    const current = view === 'group' ? 'group' : 'order', next = current === 'group' ? 'order' : 'group';
    const toggleView = el('button', 'qm-regex-tool qm-regex-view-toggle'); toggleView.type = 'button';
    toggleView.dataset.key = 'view';
    toggleView.setAttribute('aria-pressed', String(current === 'group'));
    toggleView.setAttribute('aria-label', `列表视图：${VIEW_LABELS[current]}，点按切换为${VIEW_LABELS[next]}`);
    toggleView.title = `${VIEW_LABELS[current]}（点按切换为${VIEW_LABELS[next]}）`;
    const glyph = el('i', `fa-solid ${VIEW_ICONS[current]}`); glyph.setAttribute('aria-hidden', 'true');
    toggleView.append(glyph, el('span', 'qm-regex-tool-label', VIEW_LABELS[current]));
    toggleView.addEventListener('click', () => { try { actions.setView(next); } catch (error) { notify(error?.message || '切换失败', 'warning'); } });
    tools.append(toggleView);
    // C-11d：绑定此聊天总开关。开着时，随手拨动任一开关即记入本聊天，进聊天自动套用。
    if (typeof actions.setBindingEnabled === 'function') {
      const bindBtn = el('button', `qm-regex-tool qm-regex-bind-toggle${binding.enabled ? ' is-on' : ''}`); bindBtn.type = 'button';
      bindBtn.dataset.key = 'bind';
      bindBtn.setAttribute('aria-pressed', String(binding.enabled === true));
      bindBtn.setAttribute('aria-label', `绑定此聊天：${binding.enabled ? '已开启，进聊天自动套用' : '未开启'}`);
      bindBtn.title = binding.enabled ? '绑定此聊天（已开启：改动会记入本聊天，进聊天自动套用）' : '绑定此聊天（开启后改动记入本聊天，进聊天自动套用）';
      const bg = el('i', 'fa-solid fa-link'); bg.setAttribute('aria-hidden', 'true');
      bindBtn.append(bg, el('span', 'qm-regex-tool-label', '绑定'));
      bindBtn.addEventListener('click', () => {
        if (bindBtn.disabled) return;
        Promise.resolve().then(() => actions.setBindingEnabled(!binding.enabled))
          .catch(error => notify(error?.message || '绑定切换失败', 'warning'));
      });
      tools.append(bindBtn);
    }
    const g = sources.global, p = sources.preset;
    const globalCard = section('全局正则', g.available ? `${g.items.length} 条` : '', g.items, view,
      { unavailable: g.available ? '' : '未读取到全局正则（正则扩展可能未加载）', source: 'global', writable: g.writable === true, pending, bound });
    let presetNote = '';
    if (p.available) presetNote = `${p.name || '当前预设'} · ${p.items.length} 条${p.items.length && !p.allowed ? ' · 未被允许运行' : ''}`;
    const presetCard = section('预设正则', presetNote, p.items, view,
      { unavailable: p.available ? '' : '当前 ST 版本不支持预设正则', source: 'preset', writable: p.writable === true, pending, bound });
    const writable = g.writable === true || p.writable === true;
    const hint = el('p', 'qm-regex-hint', writable
      ? (binding.enabled
        ? '已绑定此聊天：现在拨动的开关会记入本聊天，下次进来自动套用；其它聊天不受影响。'
        : '开关即时写回 ST；连续切换后聊天会自动重载一次，让已显示的楼层按新正则重新渲染。')
      : '只读预览：当前 ST 不支持在此切换，请在 ST 正则面板修改。');
    root.replaceChildren(tools, globalCard, presetCard, hint);
    if (typeof scroll === 'number') root.scrollTop = scroll;
    if (keep) [...(root.querySelectorAll?.('[data-key]') || [])].find(node => node.dataset.key === keep)?.focus?.();
  }

  function dispose() { disposed = true; root.replaceChildren?.(); }
  return Object.freeze({ render, dispose });
}
