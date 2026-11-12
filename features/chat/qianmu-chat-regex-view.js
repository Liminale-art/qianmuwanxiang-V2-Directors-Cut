// Regex tab of the chat toolkit (D-a, read-only).
// Pure DOM over the actions handed in by qianmu-chat-regex.js; it stores nothing and writes nothing to ST.
// Two sections (global / current preset), each in original order or auto-grouped by name prefix.
const VIEW_LABELS = [['order', '原始顺序'], ['group', '自动分组']];

export function mountChatRegexView({ root, actions, notify = () => {} }) {
  const document = root.ownerDocument;
  let disposed = false;
  const el = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };

  function row(item) {
    const node = el('div', 'qm-regex-row');
    node.dataset.id = item.id;
    const dot = el('span', `qm-regex-dot${item.enabled ? ' is-on' : ''}`);
    dot.setAttribute('role', 'img');
    dot.setAttribute('aria-label', item.enabled ? '已启用' : '已停用');
    const name = el('span', 'qm-regex-name', item.name);
    const meta = [...item.placement, item.scope].filter(Boolean).join(' · ');
    node.append(dot, name, el('span', 'qm-regex-meta', meta || '未设作用位置'));
    if (!item.enabled) node.classList.add('is-off');
    return node;
  }

  function list(items, mode) {
    const box = el('div', 'qm-regex-list');
    if (!items.length) { box.append(el('p', 'qm-regex-empty', '没有正则脚本')); return box; }
    if (mode !== 'group') { box.append(...items.map(row)); return box; }
    for (const group of actions.group(items)) {
      const head = el('div', 'qm-regex-group', `${group.label}（${group.items.length}）`);
      box.append(head, ...group.items.map(row));
    }
    return box;
  }

  function section(title, note, items, mode, { unavailable = '' } = {}) {
    const card = el('section', 'qm-regex-card');
    const head = el('header', 'qm-regex-card-head');
    head.append(el('h4', 'qm-regex-title', title));
    if (note) head.append(el('span', 'qm-regex-note', note));
    card.append(head);
    if (unavailable) card.append(el('p', 'qm-regex-empty', unavailable));
    else card.append(list(items, mode));
    return card;
  }

  function render(state) {
    if (disposed || !state) return;
    const { view, sources } = state;
    const seg = el('div', 'qm-regex-views');
    seg.setAttribute('role', 'radiogroup');
    seg.setAttribute('aria-label', '列表视图');
    for (const [value, label] of VIEW_LABELS) {
      const b = el('button', value === view ? 'is-active' : '', label); b.type = 'button';
      b.setAttribute('role', 'radio'); b.setAttribute('aria-checked', String(value === view));
      b.addEventListener('click', () => { try { actions.setView(value); } catch (error) { notify(error?.message || '切换失败', 'warning'); } });
      seg.append(b);
    }
    const g = sources.global, p = sources.preset;
    const globalCard = section('全局正则', g.available ? `${g.items.length} 条` : '', g.items, view,
      { unavailable: g.available ? '' : '未读取到全局正则（正则扩展可能未加载）' });
    let presetNote = '';
    if (p.available) presetNote = `${p.name || '当前预设'} · ${p.items.length} 条${p.items.length && !p.allowed ? ' · 未被允许运行' : ''}`;
    const presetCard = section('预设正则', presetNote, p.items, view,
      { unavailable: p.available ? '' : '当前 ST 版本不支持预设正则' });
    const hint = el('p', 'qm-regex-hint', '只读预览：开关与批量操作将在后续版本提供，请暂在 ST 正则面板修改。');
    root.replaceChildren(seg, globalCard, presetCard, hint);
  }

  function dispose() { disposed = true; root.replaceChildren?.(); }
  return Object.freeze({ render, dispose });
}
