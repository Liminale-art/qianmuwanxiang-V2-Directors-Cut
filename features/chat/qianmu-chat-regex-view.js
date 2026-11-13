// Regex tab of the chat toolkit (D-a list + D-b single toggle).
// Pure DOM over the actions handed in by qianmu-chat-regex.js; it stores nothing and never touches ST itself:
// a switch only calls actions.toggle(), which owns the write-back. Two sections (global / current preset),
// each in original order or auto-grouped by name prefix. A source that cannot be written shows a status dot.
// Rows show the script name only; page-level icon controls share one tool row (the list view is a single toggle).
// C-12: a preset quick switch heads the page — a native-style select over the active API's presets that only
// calls actions.selectPreset(); a link mark shows which preset this chat is bound to.
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

  // C-14e：一个分区/分组只给一个胶囊总开关——全部开着时为开（点按全部停用），否则点按全部启用；部分开着显示半态。
  function batchSwitch(items, source, label, pending) {
    const on = items.length > 0 && items.every(item => item.enabled);
    const mixed = !on && items.some(item => item.enabled);
    const button = el('button', `qm-regex-pill${on ? ' is-on' : ''}${mixed ? ' is-mixed' : ''}`); button.type = 'button';
    button.dataset.key = `batch:${source}:${label}`;
    button.setAttribute('role', 'switch');
    button.setAttribute('aria-checked', String(on));
    const verb = on ? '已全部启用，点按全部停用' : mixed ? '部分启用，点按全部启用' : '已全部停用，点按全部启用';
    button.setAttribute('aria-label', `${label}：${verb}`); button.title = `${label}：${verb}`;
    if (items.some(item => pending.includes(`${source}:${item.id}`))) { button.disabled = true; button.setAttribute('aria-busy', 'true'); }
    button.append(el('span', 'qm-regex-pill-knob'));
    button.addEventListener('click', event => {
      event?.stopPropagation?.();
      if (button.disabled) return;
      Promise.resolve().then(() => actions.toggleMany({ source, items, enabled: !on }))
        .catch(error => notify(error?.message || '正则批量开关写回失败', 'warning'));
    });
    return button;
  }

  // C-14e：卡片与分组都可折叠；折叠态存在控制器里（视图不存状态），切页签回来仍保持。
  const isFolded = key => typeof actions.isFolded === 'function' && actions.isFolded(key);
  function foldButton(key, label, className, text) {
    const folded = isFolded(key);
    const button = el('button', `qm-regex-fold ${className}`); button.type = 'button';
    button.dataset.key = `fold:${key}`;
    button.setAttribute('aria-expanded', String(!folded));
    button.setAttribute('aria-label', `${label}：${folded ? '已折叠，点按展开' : '点按折叠'}`);
    const chevron = el('i', 'fa-solid fa-chevron-down qm-regex-fold-mark'); chevron.setAttribute('aria-hidden', 'true');
    button.append(chevron, el('span', 'qm-regex-fold-text', text));
    button.addEventListener('click', () => { try { actions.setFolded?.(key, !folded); } catch (error) { notify(error?.message || '折叠失败', 'warning'); } });
    return button;
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
      const key = `group:${source}:${group.label}`;
      const head = el('div', `qm-regex-group${isFolded(key) ? ' is-folded' : ''}`);
      head.append(foldButton(key, group.label, 'qm-regex-group-label', `${group.label}（${group.items.length}）`));
      if (options.writable) head.append(batchSwitch(group.items, source, group.label, options.pending));
      box.append(head);
      if (!isFolded(key)) box.append(...group.items.map(make));
    }
    return box;
  }

  function section(title, note, items, mode, { unavailable = '', source = '', writable = false, pending = [], bound = () => false } = {}) {
    const key = `card:${source}`, folded = isFolded(key);
    const card = el('section', `qm-regex-card${folded ? ' is-folded' : ''}`);
    const head = el('header', 'qm-regex-card-head');
    const heading = el('h4', 'qm-regex-title');
    heading.append(foldButton(key, title, 'qm-regex-card-fold', title));
    head.append(heading);
    if (note) head.append(el('span', 'qm-regex-note', note));
    if (!unavailable && writable && items.length) head.append(batchSwitch(items, source, title, pending));
    card.append(head);
    if (folded) return card;
    if (unavailable) card.append(el('p', 'qm-regex-empty', unavailable));
    else card.append(list(items, mode, source, { writable, pending, bound }));
    return card;
  }

  // Re-rendering swaps every node, so keep the keyboard focus on the same switch and the scroll offset.
  function focusedKey() {
    const active = document.activeElement;
    return active && typeof root.contains === 'function' && root.contains(active) ? active.dataset?.key || '' : '';
  }

  // 预设快切：一行「预设」+ 下拉。选中即走原生切换；本聊天绑定的预设名旁带链环标记。
  function presetSwitch(presets, binding) {
    const box = el('div', 'qm-regex-preset');
    const label = el('label', 'qm-regex-preset-label', '预设');
    const select = el('select', 'qm-regex-preset-select');
    select.dataset.key = 'preset';
    const id = 'qm-regex-preset-select'; select.id = id; label.setAttribute('for', id);
    const boundName = binding.enabled ? binding.preset || '' : '';
    const names = [...presets.names];
    if (presets.current && !names.includes(presets.current)) names.unshift(presets.current);
    for (const name of names) {
      const option = el('option', '', name === boundName ? `${name}（本聊天）` : name);
      option.value = name;
      if (name === presets.current) option.selected = true;
      select.append(option);
    }
    select.value = presets.current;
    select.setAttribute('aria-label', boundName ? `切换预设（本聊天绑定：${boundName}）` : '切换预设');
    if (presets.busy || !names.length) { select.disabled = true; if (presets.busy) select.setAttribute('aria-busy', 'true'); }
    select.addEventListener('change', () => {
      const next = select.value;
      if (!next || next === presets.current) return;
      Promise.resolve().then(() => actions.selectPreset(next))
        .catch(error => notify(error?.message || '预设切换失败', 'warning'));
    });
    box.append(label, select);
    if (boundName) {
      const mark = el('i', `fa-solid fa-link qm-regex-preset-bound${boundName === presets.current ? '' : ' is-off'}`);
      mark.setAttribute('aria-hidden', 'true');
      box.title = boundName === presets.current ? '已是本聊天绑定的预设' : `本聊天绑定的是「${boundName}」`;
      box.append(mark);
    }
    return box;
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
      bindBtn.setAttribute('aria-label', `绑定此聊天：${binding.enabled ? '已开启，进聊天自动套用预设与正则' : '未开启'}`);
      bindBtn.title = binding.enabled ? '绑定此聊天（已开启：预设与正则改动会记入本聊天，进聊天自动套用）' : '绑定此聊天（开启后记住当前预设，预设与正则改动记入本聊天，进聊天自动套用）';
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
    if (p.available) presetNote = `${p.items.length} 条${p.items.length && !p.allowed ? ' · 未被允许运行' : ''}`;   // C-14e：预设名已在页顶快切里，卡内不再重复
    const presetCard = section('预设正则', presetNote, p.items, view,
      { unavailable: p.available ? '' : '当前 ST 版本不支持预设正则', source: 'preset', writable: p.writable === true, pending, bound });
    const writable = g.writable === true || p.writable === true;
    const hint = el('p', 'qm-regex-hint', writable
      ? (binding.enabled
        ? '已绑定此聊天：现在切的预设、拨动的开关都会记入本聊天，下次进来自动套用；其它聊天不受影响。'
        : '开关即时写回 ST；连续切换后聊天会自动重载一次，让已显示的楼层按新正则重新渲染。')
      : '只读预览：当前 ST 不支持在此切换，请在 ST 正则面板修改。');
    const presets = state.presets && typeof state.presets === 'object' ? state.presets : { available: false, names: [] };
    const head = presets.available && typeof actions.selectPreset === 'function' ? [presetSwitch(presets, binding)] : [];
    root.replaceChildren(...head, tools, globalCard, presetCard, hint);
    if (typeof scroll === 'number') root.scrollTop = scroll;
    if (keep) [...(root.querySelectorAll?.('[data-key]') || [])].find(node => node.dataset.key === keep)?.focus?.();
  }

  function dispose() { disposed = true; root.replaceChildren?.(); }
  return Object.freeze({ render, dispose });
}
