// Regex tab of the chat toolkit (D-a list + D-b single toggle).
// Pure DOM over the actions handed in by qianmu-chat-regex.js; it stores nothing and never touches ST itself:
// a switch only calls actions.toggle(), which owns the write-back. Two sections (global / current preset),
// each in original order with adjacent same-family runs folded. A source that cannot be written shows a status dot.
// Rows show the script name only; page-level icon controls share one tool row (grouping has no view toggle since C-15 s9).
// C-12: a preset quick switch heads the page — a native-style select over the active API's presets that only
// calls actions.selectPreset(); a link mark shows which preset this chat is bound to.
// C-15 s6: the dropdown drops its「预设」label and groups version series into <optgroup>s (same catalogue logic as 幕外目录).
import { groupPresetNames } from '../../qianmu-st-context-sources.js?v=1.59.450';
// C-15 s9: one list mode — original order with adjacent same-family runs folded under a header (no view toggle).

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

  function row(item, source, { writable = false, pending = [], bound = () => false, managing = false, selected = () => false, group = '', siblings = [], selectedKeys = [], picking = [], busy = [] } = {}) {
    const node = el('div', 'qm-regex-row');
    node.dataset.id = item.id;
    // C-16 s1：结构性写回涉及本行 → 名前转圈、行内按钮全禁用，直到写回结束。
    const working = busy.includes(`${source}:${item.id}`);
    const name = el('span', 'qm-regex-name', working ? undefined : item.name);
    if (working) {
      node.classList.add('is-busy'); node.setAttribute('aria-busy', 'true');
      const spin = el('i', 'fa-solid fa-spinner fa-spin qm-regex-busy-mark'); spin.setAttribute('aria-hidden', 'true');
      name.append(spin, document.createTextNode(` ${item.name}`));
    }
    name.title = item.name;
    if (writable && bound(`${source}:${item.id}`)) {
      node.classList.add('is-bound');
      const mark = el('i', 'fa-solid fa-link qm-regex-bound-mark'); mark.setAttribute('aria-hidden', 'true');
      name.append(document.createTextNode(' '), mark);
      name.title = `${item.name}（已记入本聊天绑定）`;
    }
    if (managing && writable) {
      node.classList.add('is-managing');
      const key = `${source}:${item.id}`, on = selected(key);
      if (on) node.classList.add('is-selected');
      const picked = picking.some(p => p.source === source && String(p.id) === String(item.id));
      if (picked) node.classList.add('is-picking');
      const check = el('button', `qm-regex-check${on ? ' is-on' : ''}`); check.type = 'button';
      check.dataset.key = `sel:${key}`;
      check.setAttribute('role', 'checkbox'); check.setAttribute('aria-checked', String(on));
      check.setAttribute('aria-label', `${item.name}：${on ? '已选，点按取消' : '点按选中'}`);
      const tick = el('i', 'fa-solid fa-check qm-regex-check-mark'); tick.setAttribute('aria-hidden', 'true');
      check.append(tick);
      check.addEventListener('click', () => { try { actions.setSelected?.(key, !on); } catch (error) { notify(error?.message || '选择失败', 'warning'); } });
      // 拾取载荷：若本行在多选内，整批同源选择一起拾起；否则只拾本行。
      const pickItems = () => {
        if (on && selectedKeys.length > 1) {
          const picks = selectedKeys.map(k => { const [s, ...r] = String(k).split(':'); const id = r.join(':');
            const found = siblings.find(it => String(it.id) === id); return s === source && found ? { source, id, name: found.name } : null; }).filter(Boolean);
          if (picks.length) return picks;
        }
        return [{ source, id: item.id, name: item.name }];
      };
      // 行尾图标：拾取移动 / 编辑 / 复制 / 删除。拖拽与拾取走同一落定路径。
      const act = el('div', 'qm-regex-rowact');
      const iconBtn = (cls, keyName, label, glyph, run) => {
        const b = el('button', `qm-regex-rowbtn ${cls}`); b.type = 'button';
        b.dataset.key = `${keyName}:${key}`;
        b.setAttribute('aria-label', `${item.name}：${label}`); b.title = label;
        const ic = el('i', `fa-solid ${glyph}`); ic.setAttribute('aria-hidden', 'true'); b.append(ic);
        if (working) b.disabled = true;
        b.addEventListener('click', () => { if (b.disabled) return; Promise.resolve().then(run).catch(error => notify(error?.message || `${label}失败`, 'warning')); });
        return b;
      };
      const grip = iconBtn('qm-regex-grip' + (picked ? ' is-picking' : ''), 'pick', picked ? '放下（取消移动）' : '拾取移动', 'fa-up-down-left-right', () => actions.pickMove?.({ source, items: pickItems() }));
      grip.draggable = true;
      grip.addEventListener?.('dragstart', event => { try { actions.pickMove?.({ source, items: pickItems() }); event?.dataTransfer && (event.dataTransfer.effectAllowed = 'move'); } catch (_) {} });
      const openEdit = () => actions.openEditor?.({ source, id: item.id, name: item.name });
      name.classList.add('is-editable'); name.setAttribute('role', 'button'); name.setAttribute('tabindex', '0');
      name.dataset.key = `edit:${key}`;
      name.addEventListener('click', () => { try { openEdit(); } catch (error) { notify(error?.message || '打开编辑失败', 'warning'); } });
      act.append(
        grip,
        iconBtn('', 'rowedit', '编辑', 'fa-pen', openEdit),
        iconBtn('', 'rowcopy', '复制', 'fa-copy', () => actions.copyMany?.({ items: [{ source, id: item.id, name: item.name }] })),
        iconBtn('is-danger', 'rowdel', '删除', 'fa-trash-can', () => { if (!confirmDelete(1)) return; return actions.removeMany?.({ items: [{ source, id: item.id, name: item.name }] }); }),
      );
      node.append(check, name, act);
      if (!item.enabled) node.classList.add('is-off');
      return node;
    }
    if (writable) {
      node.classList.add('is-writable');
      node.append(name, toggleButton(item, source, working || pending.includes(`${source}:${item.id}`)));
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
    const picking = Array.isArray(options.picking) ? options.picking : [];
    // C-16 s3：拾取态时每张可写卡都显示落点——同源＝排序，异源（预设↔全局）＝移入。
    const pickingFrom = picking.length ? (picking[0]?.source || source) : '';
    const dropHere = picking.length > 0 && options.writable;
    const across = dropHere && pickingFrom !== source;
    if (!items.length) {
      // 空列表：异源拾取时仍给一个末尾落点（可把条目移入空的预设/全局），否则显示占位文案。
      if (dropHere) box.append(dropTarget(source, null, across));
      else box.append(el('p', 'qm-regex-empty', '没有正则脚本'));
      return box;
    }
    // 拾取态：每条前插「插入到此前」落点（拖拽也 drop 到这里），列表尾再补一个末尾落点。
    const rowOf = (item, group) => {
      const node = row(item, source, { ...options, group });
      return dropHere ? [dropTarget(source, item, across), node] : [node];
    };
    // C-15 s9：单一模式「原始顺序 + 相邻同类折叠」——mode 参数不再区分；段按原顺序排列，散条段不加组头。
    const runs = typeof actions.group === 'function' ? actions.group(items) : [{ key: '', label: '', items }];
    for (const group of runs) {
      if (!group.label) { for (const item of group.items) box.append(...rowOf(item, '')); continue; }
      const key = `group:${source}:${group.key || group.label}`;
      const head = el('div', `qm-regex-group${isFolded(key) ? ' is-folded' : ''}`);
      // 管理态：折叠箭头 + 可双击改名的组名 + 整组拾取/拖拽；落点放在组头前（折叠时也能插到组前）。
      if (options.managing && options.writable) {
        if (dropHere) box.append(dropTarget(source, group.items[0], across));
        head.classList.add('is-managing');
        head.append(foldButton(key, group.label, 'qm-regex-group-label', ''), groupName(group, source),
          el('span', 'qm-regex-group-count', `（${group.items.length}）`), groupGrip(group, source, picking));
        box.append(head);
        if (!isFolded(key)) group.items.forEach((item, i) => box.append(...(i ? rowOf(item, group.label) : [row(item, source, { ...options, group: group.label })])));
        continue;
      }
      head.append(foldButton(key, group.label, 'qm-regex-group-label', `${group.label}（${group.items.length}）`));
      if (options.writable) head.append(batchSwitch(group.items, source, group.label, options.pending));
      box.append(head);
      if (!isFolded(key)) for (const item of group.items) box.append(...rowOf(item, group.label));
    }
    if (dropHere) box.append(dropTarget(source, null, across));
    return box;
  }

  // C-15 s7：拾取态落点。dropTarget 是独立「插入到此」节点：before 省略＝末尾落点；点按或 drop 都走 dropMove。
  // C-16 s3：across＝异源落点（把拾取条目移入另一来源），加 is-across 标记与「移入预设/全局」文案。
  function dropTarget(source, before, across = false) {
    const spot = el('button', `qm-regex-drop${across ? ' is-across' : ''}`); spot.type = 'button';
    spot.dataset.key = before ? `drop:${source}:${before.id}` : `drop:${source}:end`;
    const dest = source === 'preset' ? '预设' : '全局';
    const label = across
      ? (before ? `移入${dest}「${before.name}」之前` : `移入${dest}末尾`)
      : (before ? `移动到「${before.name}」之前` : '移动到末尾');
    spot.setAttribute('aria-label', label); spot.title = label;
    const run = () => actions.dropMove?.({ source, before: before ? { id: before.id, name: before.name } : null });
    const go = () => { Promise.resolve().then(run).catch(error => notify(error?.message || '移动失败', 'warning')); };
    spot.addEventListener('click', go);
    spot.addEventListener('dragover', event => { event?.preventDefault?.(); });
    spot.addEventListener('drop', event => { event?.preventDefault?.(); go(); });
    return spot;
  }

  // C-15 s9：组名双击（触屏双点同样生效，按时间戳判定、不用定时器）就地改名。改名 = 给整组写【标签】（不改名字正文），
  // 手动标签优先于自动归类；手动组清空名字 = 去掉标签回到自动归类；自动组清空 = 不改。Enter 提交、Esc 取消、失焦提交。
  function groupName(group, source) {
    const wrap = el('span', 'qm-regex-group-name');
    const label = el('span', 'qm-regex-group-title', group.label);
    label.dataset.key = `gname:${source}:${group.key || group.label}`;
    label.setAttribute('role', 'button'); label.setAttribute('tabindex', '0');
    label.setAttribute('aria-label', `分组「${group.label}」：双击改名`); label.title = '双击改名';
    let lastTap = 0, open = false;
    const start = () => {
      if (open) return;
      open = true;
      const field = el('input', 'qm-regex-group-input');
      field.type = 'text'; field.value = group.label; field.placeholder = group.mode === 'tag' ? '留空＝取消手动分组' : '分组名';
      field.dataset.key = `grename:${source}:${group.key || group.label}`;
      field.setAttribute('aria-label', `分组「${group.label}」改名`);
      let done = false;
      const finish = commit => {
        if (done) return;
        done = true; open = false;
        const to = String(field.value || '').trim();
        const changed = commit && to !== group.label && (to || group.mode === 'tag');
        if (!changed) { wrap.replaceChildren(label); return; }
        const payload = group.items.map(it => ({ source, id: it.id, name: it.name }));
        Promise.resolve().then(() => actions.retag?.({ items: payload, tag: to }))
          .catch(error => notify(error?.message || '分组改名失败', 'warning'));
      };
      field.addEventListener('keydown', event => {
        if (event?.key === 'Enter') { event.preventDefault?.(); finish(true); }
        else if (event?.key === 'Escape') { event.preventDefault?.(); finish(false); }
      });
      field.addEventListener('blur', () => finish(true));
      wrap.replaceChildren(field);
      try { field.focus?.(); field.select?.(); } catch (_) {}
    };
    label.addEventListener('dblclick', start);
    label.addEventListener('click', event => {
      const now = Number(event?.timeStamp) || Date.now();
      if (now - lastTap < 400) { lastTap = 0; start(); } else lastTap = now;
    });
    label.addEventListener('keydown', event => { if (event?.key === 'Enter' || event?.key === 'F2') { event.preventDefault?.(); start(); } });
    wrap.append(label);
    return wrap;
  }

  // C-15 s9：整组拾取/拖拽——载荷为全部成员（按显示顺序），落定沿用 dropMove（成员相对顺序不变）。
  function groupGrip(group, source, picking) {
    const members = group.items.map(it => ({ source, id: it.id, name: it.name }));
    const picked = picking.length === members.length && members.every(m => picking.some(p => p.source === source && String(p.id) === String(m.id)));
    const b = el('button', `qm-regex-rowbtn qm-regex-grip qm-regex-group-grip${picked ? ' is-picking' : ''}`); b.type = 'button';
    b.dataset.key = `gpick:${source}:${group.key || group.label}`;
    const label = picked ? '放下（取消移动）' : '整组拾取移动';
    b.setAttribute('aria-label', `分组「${group.label}」：${label}`); b.title = label;
    const ic = el('i', 'fa-solid fa-up-down-left-right'); ic.setAttribute('aria-hidden', 'true'); b.append(ic);
    b.draggable = true;
    b.addEventListener('click', () => { Promise.resolve().then(() => actions.pickMove?.({ source, items: members })).catch(error => notify(error?.message || '拾取失败', 'warning')); });
    b.addEventListener('dragstart', event => { try { actions.pickMove?.({ source, items: members }); event?.dataTransfer && (event.dataTransfer.effectAllowed = 'move'); } catch (_) {} });
    return b;
  }

  function section(title, note, items, mode, { unavailable = '', source = '', writable = false, pending = [], bound = () => false, managing = false, selected = () => false, siblings = [], selectedKeys = [], picking = [], busy = [], writing = false } = {}) {
    const key = `card:${source}`, folded = isFolded(key);
    const card = el('section', `qm-regex-card${folded ? ' is-folded' : ''}${managing && writable ? ' is-managing' : ''}`);
    // C-16 s1：结构性写回进行中整卡锁定（防重复点击），读屏也知道在忙。
    if (writing && writable) { card.classList.add('is-locked'); card.setAttribute('aria-busy', 'true'); }
    const head = el('header', 'qm-regex-card-head');
    const heading = el('h4', 'qm-regex-title');
    heading.append(foldButton(key, title, 'qm-regex-card-fold', title));
    head.append(heading);
    if (note) head.append(el('span', 'qm-regex-note', note));
    if (!unavailable && writable && !managing && items.length) head.append(batchSwitch(items, source, title, pending));
    if (!unavailable && writable && managing) head.append(newButton(source));
    card.append(head);
    if (folded) return card;
    if (unavailable) card.append(el('p', 'qm-regex-empty', unavailable));
    else card.append(list(items, mode, source, { writable, pending, bound, managing, selected, siblings, selectedKeys, picking, busy }));
    return card;
  }

  // 管理态卡头「新建」：开编辑子页的新建模式。
  function newButton(source) {
    const button = el('button', 'qm-regex-tool qm-regex-new qm-regex-new-icon'); button.type = 'button';
    button.dataset.key = `new:${source}`;
    button.setAttribute('aria-label', '新建正则'); button.title = '新建正则';
    const ic = el('i', 'fa-solid fa-plus'); ic.setAttribute('aria-hidden', 'true');
    button.append(ic);
    button.addEventListener('click', () => { try { actions.openEditor?.({ isNew: true, source }); } catch (error) { notify(error?.message || '新建失败', 'warning'); } });
    return button;
  }

  // Re-rendering swaps every node, so keep the keyboard focus on the same switch and the scroll offset.
  function focusedKey() {
    const active = document.activeElement;
    return active && typeof root.contains === 'function' && root.contains(active) ? active.dataset?.key || '' : '';
  }

  // 预设快切：一行「预设」+ 下拉。选中即走原生切换；本聊天绑定的预设名旁带链环标记。
  function presetSwitch(presets, binding) {
    const box = el('div', 'qm-regex-preset');
    const select = el('select', 'qm-regex-preset-select');
    select.dataset.key = 'preset';
    select.id = 'qm-regex-preset-select';
    const boundName = binding.enabled ? binding.preset || '' : '';
    const names = [...presets.names];
    if (presets.current && !names.includes(presets.current)) names.unshift(presets.current);
    // C-15 s6：选项按版本系列折进 <optgroup>（同幕外目录逻辑，零浮层风险）；绑定预设仍带「（本聊天）」。
    const option = name => {
      const node = el('option', '', name === boundName ? `${name}（本聊天）` : name);
      node.value = name;
      if (name === presets.current) node.selected = true;
      return node;
    };
    for (const row of groupPresetNames(names)) {
      if (!row.grouped) { select.append(option(row.name)); continue; }
      const group = el('optgroup');
      group.label = row.base;
      for (const item of row.items) group.append(option(item.name));
      select.append(group);
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
    box.append(select);
    if (boundName) {
      const mark = el('i', `fa-solid fa-link qm-regex-preset-bound${boundName === presets.current ? '' : ' is-off'}`);
      mark.setAttribute('aria-hidden', 'true');
      box.title = boundName === presets.current ? '已是本聊天绑定的预设' : `本聊天绑定的是「${boundName}」`;
      box.append(mark);
    }
    return box;
  }

  // 编辑子页接管整个工具包面板（仿铃声列表的 lockPanel）：锁住当前高度，长表单内部滚动。
  function lockPanel(on) {
    const panel = root.closest?.('.sd-floor-panel');
    if (!panel?.classList) return;
    if (on) {
      if (!panel.classList.contains('qm-regex-subpage-open')) {
        const height = panel.getBoundingClientRect?.().height;
        if (height > 0) panel.style?.setProperty?.('--qm-regex-lock-h', `${Math.round(height)}px`);
      }
      panel.classList.add('qm-regex-subpage-open');
    } else {
      panel.classList.remove('qm-regex-subpage-open');
      panel.style?.removeProperty?.('--qm-regex-lock-h');
    }
  }

  // ST 原生正则编辑器的作用范围：1 用户输入 / 2 AI 输出 / 3 快捷命令 / 5 世界书 / 6 推理。
  const PLACEMENTS = Object.freeze([[1, '用户输入'], [2, 'AI 输出'], [3, '快捷命令'], [5, '世界书'], [6, '推理']]);
  const SUBSTITUTE = Object.freeze([[0, '不替换'], [1, '原样宏'], [2, '转义宏']]);

  // 可拖拽高度 + 一键展开的文本域。resize:vertical 由 CSS 给，展开按钮加/去 is-tall 类。
  // highlight=true 时在文本域后叠一层只读 <pre> 着色层（文字透明 + 光标可见），实现轻量语法高亮，无第三方依赖。
  function growTextarea(key, label, value, rows = 3, { highlight = false } = {}) {
    const wrap = el('div', 'qm-regex-field');
    const bar = el('div', 'qm-regex-field-bar');
    const tag = el('label', 'qm-regex-field-label', label); tag.setAttribute('for', `qm-regex-f-${key}`);
    const expand = el('button', 'qm-regex-expand'); expand.type = 'button';
    expand.setAttribute('aria-label', `${label}：展开/收起编辑框`); expand.title = '展开/收起';
    const ei = el('i', 'fa-solid fa-up-right-and-down-left-from-center'); ei.setAttribute('aria-hidden', 'true');
    expand.append(ei);
    bar.append(tag, expand);
    const area = el('textarea', `qm-regex-textarea${highlight ? ' is-code' : ''}`);
    area.id = `qm-regex-f-${key}`; area.dataset.key = `field:${key}`;
    area.value = value == null ? '' : String(value);
    area.setAttribute('rows', String(rows));
    expand.addEventListener('click', () => { if (area.classList?.contains('is-tall')) area.classList.remove('is-tall'); else area.classList?.add('is-tall'); });
    if (!highlight) { wrap.append(bar, area); return { wrap, area }; }
    const box = el('div', 'qm-regex-codebox');
    const pre = el('pre', 'qm-regex-hl'); pre.setAttribute('aria-hidden', 'true');
    const paint = () => { try { pre.replaceChildren(...highlightSpans(area.value)); } catch (_) {} };
    paint();
    area.addEventListener('input', paint);
    area.addEventListener('scroll', () => { pre.scrollTop = area.scrollTop; pre.scrollLeft = area.scrollLeft; });
    box.append(pre, area);
    wrap.append(bar, box);
    return { wrap, area };
  }

  // 纯着色：{{宏}} / $1·$&·$<名> 反向引用 / \x 转义 / ()[]{} 分组 / .*+?|^$ 元字符；其余为普通文本。
  const HL_RE = /(\{\{[^}]*\}\})|(\$(?:\d+|&|<[^>]*>))|(\\[\s\S])|([()\[\]{}])|([.*+?|^$])/g;
  const HL_CLASS = ['qm-hl-macro', 'qm-hl-ref', 'qm-hl-esc', 'qm-hl-group', 'qm-hl-meta'];
  function highlightSpans(value) {
    const str = value == null ? '' : String(value);
    const nodes = [];
    const pushText = t => { if (t) nodes.push(document.createTextNode(t)); };
    let last = 0, m;
    HL_RE.lastIndex = 0;
    while ((m = HL_RE.exec(str))) {
      pushText(str.slice(last, m.index));
      const gi = [1, 2, 3, 4, 5].find(i => m[i] != null);
      const span = el('span', HL_CLASS[gi - 1], m[0]);
      nodes.push(span);
      last = m.index + m[0].length;
      if (m[0] === '') HL_RE.lastIndex++;   // 防零宽死循环
    }
    pushText(str.slice(last));
    pushText('​');   // 末行占位，防尾随换行塌陷
    return nodes;
  }

  // 编辑页分组候选：本来源已有的【标签】与自动折叠出的组名（去重，按出现顺序）。
  function groupChoices(state, source) {
    const items = state?.sources?.[source]?.items;
    if (!Array.isArray(items) || typeof actions.familyKey !== 'function') return [];
    const out = new Set();
    for (const item of items) { const tag = actions.familyKey(item?.name).tag; if (tag) out.add(tag); }
    if (typeof actions.group === 'function') for (const run of actions.group(items)) if (run.label) out.add(run.label);
    return [...out];
  }

  function renderEditor(state) {
    const editing = state.editing;
    const isNew = editing.isNew === true;
    const source = editing.source;
    const base = isNew ? null : (typeof actions.readScript === 'function' ? actions.readScript({ source, id: editing.id, name: editing.name }) : null);
    if (!isNew && !base) { notify('这条正则已不存在，返回列表', 'warning'); try { actions.closeEditor?.(); } catch (_) {} return; }
    const data = base || {};
    const wrap = el('div', 'qm-regex-editor');
    const subhead = el('div', 'qm-regex-subhead');
    const back = el('button', 'qm-regex-back'); back.type = 'button';
    back.dataset.key = 'editor-back';
    back.setAttribute('aria-label', '返回正则列表');
    const bi = el('i', 'fa-solid fa-arrow-left'); bi.setAttribute('aria-hidden', 'true'); back.append(bi);
    back.addEventListener('click', () => { try { actions.closeEditor?.(); } catch (error) { notify(error?.message || '返回失败', 'warning'); } });
    subhead.append(back, el('h4', 'qm-regex-subtitle', isNew ? `新建${source === 'preset' ? '预设' : '全局'}正则` : '编辑正则'));

    const form = el('div', 'qm-regex-form');
    const nameField = el('input', 'qm-regex-input'); nameField.type = 'text';
    nameField.id = 'qm-regex-name'; nameField.dataset.key = 'field:scriptName';
    const origName = data.scriptName == null ? '' : String(data.scriptName);
    const fam = typeof actions.familyKey === 'function' && typeof actions.tagName === 'function' ? actions.familyKey(origName) : null;
    const origTag = fam?.tag || '';
    const origBody = origTag ? actions.tagName(origName, '') : origName;
    nameField.value = origBody;
    nameField.placeholder = '脚本名称';
    const nameLabel = el('label', 'qm-regex-field-label', '脚本名称'); nameLabel.setAttribute('for', 'qm-regex-name');
    const nameWrap = el('div', 'qm-regex-field'); nameWrap.append(nameLabel, nameField);
    form.append(nameWrap);
    // C-15 s9：分组 = 名字开头的【标签】；可选已有组（datalist）或填新组名，留空 = 交给相邻同类自动归类。
    let groupField = null;
    if (fam) {
      groupField = el('input', 'qm-regex-input qm-regex-group-field'); groupField.type = 'text';
      groupField.id = 'qm-regex-group'; groupField.dataset.key = 'field:group';
      groupField.value = origTag; groupField.placeholder = '留空＝自动归类';
      const known = groupChoices(state, source);
      const groupLabel = el('label', 'qm-regex-field-label', '分组'); groupLabel.setAttribute('for', 'qm-regex-group');
      const groupWrap = el('div', 'qm-regex-field'); groupWrap.append(groupLabel, groupField);
      if (known.length) {
        const list = el('datalist'); list.id = 'qm-regex-group-list';
        for (const name of known) { const o = el('option'); o.value = name; list.append(o); }
        groupField.setAttribute('list', list.id); groupWrap.append(list);
      }
      form.append(groupWrap);
    }

    const find = growTextarea('findRegex', '查找正则表达式', data.findRegex, 2, { highlight: true });
    const replace = growTextarea('replaceString', '替换为', data.replaceString, 3, { highlight: true });
    const trim = growTextarea('trimStrings', '修剪掉', (Array.isArray(data.trimStrings) ? data.trimStrings : []).join('\n'), 2);
    form.append(find.wrap, replace.wrap, trim.wrap);

    // 圆点式多选：选中显示实心圆点。作用范围与其他选项各自 3 等分列。
    const optButton = (keyName, value, label, on) => {
      const b = el('button', `qm-regex-opt${on ? ' is-on' : ''}`); b.type = 'button';
      b.dataset.key = `${keyName}:${value}`;
      b.setAttribute('role', 'checkbox'); b.setAttribute('aria-checked', String(on));
      b.setAttribute('aria-label', label);
      const dot = el('span', 'qm-regex-opt-dot'); dot.setAttribute('aria-hidden', 'true');
      b.append(dot, el('span', 'qm-regex-opt-text', label));
      b.addEventListener('click', () => { const next = !b.classList?.contains('is-on'); if (next) b.classList?.add('is-on'); else b.classList?.remove('is-on'); b.setAttribute('aria-checked', String(next)); });
      return b;
    };

    // 作用范围多选（ST：placement）
    const placeSet = new Set((Array.isArray(data.placement) ? data.placement : [2]).map(Number));
    const placeField = el('div', 'qm-regex-field');
    placeField.append(el('span', 'qm-regex-field-label', '作用范围'));
    const placeGrid = el('div', 'qm-regex-optgrid');
    const placeChecks = new Map();
    for (const [value, label] of PLACEMENTS) { const b = optButton('place', value, label, placeSet.has(value)); placeChecks.set(value, b); placeGrid.append(b); }
    placeField.append(placeGrid);
    form.append(placeField);

    // 其他选项（ST：已禁用 / 在编辑时运行 / 仅影响显示 / 仅影响后端提示词）
    const flagDefs = [['disabled', '已禁用', data.disabled === true], ['runOnEdit', '在编辑时运行', data.runOnEdit !== false],
      ['markdownOnly', '仅影响显示', data.markdownOnly === true], ['promptOnly', '仅影响后端提示词', data.promptOnly === true]];
    const flagField = el('div', 'qm-regex-field');
    flagField.append(el('span', 'qm-regex-field-label', '其他选项'));
    const flagGrid = el('div', 'qm-regex-optgrid');
    const flagChecks = new Map();
    for (const [key, label, on] of flagDefs) { const b = optButton('flag', key, label, on); flagChecks.set(key, b); flagGrid.append(b); }
    flagField.append(flagGrid);
    form.append(flagField);

    // 正则表达式查找时的宏 + 最小/最大深度：同排。
    const subSel = el('select', 'qm-regex-select'); subSel.dataset.key = 'field:substituteRegex';
    for (const [value, label] of SUBSTITUTE) { const o = el('option', '', label); o.value = String(value); if (Number(data.substituteRegex || 0) === value) o.selected = true; subSel.append(o); }
    subSel.value = String(Number(data.substituteRegex || 0));
    const subLabel = el('label', 'qm-regex-field-label', '正则表达式查找时的宏'); subLabel.setAttribute('for', 'qm-regex-sub'); subSel.id = 'qm-regex-sub';
    const subWrap = el('div', 'qm-regex-field qm-regex-macro'); subWrap.append(subLabel, subSel);
    const depthMin = el('input', 'qm-regex-input qm-regex-depth'); depthMin.type = 'number'; depthMin.dataset.key = 'field:minDepth';
    depthMin.value = data.minDepth == null ? '' : String(data.minDepth); depthMin.placeholder = '最小深度';
    const depthMax = el('input', 'qm-regex-input qm-regex-depth'); depthMax.type = 'number'; depthMax.dataset.key = 'field:maxDepth';
    depthMax.value = data.maxDepth == null ? '' : String(data.maxDepth); depthMax.placeholder = '最大深度';
    const depthWrap = el('div', 'qm-regex-field qm-regex-depths');
    depthWrap.append(el('span', 'qm-regex-field-label', '最小 / 最大深度'), depthMin, depthMax);
    const macroRow = el('div', 'qm-regex-macro-row');
    macroRow.append(subWrap, depthWrap);
    form.append(macroRow);

    // 测试模式：默认折叠；展开后输入 + 预览（预览为空时隐藏）。拿当前表单字段跑纯函数，不写 ST。
    const testIn = growTextarea('testInput', '测试模式 · 输入', '', 2);
    const testOut = el('pre', 'qm-regex-testout', '');
    const testBtn = el('button', 'qm-regex-selact', '运行测试'); testBtn.type = 'button'; testBtn.dataset.key = 'editor-test';
    testBtn.setAttribute('aria-label', '用当前字段测试替换效果');
    const composeName = (body, tag) => {
      if (!fam || !body) return body;
      if (body === origBody && tag === origTag) return origName;
      return tag ? actions.tagName(body, tag) : body;
    };
    const collect = () => ({
      scriptName: composeName(nameField.value.trim(), groupField ? groupField.value.trim() : origTag),
      findRegex: find.area.value,
      replaceString: replace.area.value,
      trimStrings: trim.area.value.split('\n').map(s => s.trim()).filter(Boolean),
      placement: [...placeChecks].filter(([, b]) => b.classList?.contains('is-on')).map(([v]) => v),
      markdownOnly: flagChecks.get('markdownOnly').classList?.contains('is-on') === true,
      promptOnly: flagChecks.get('promptOnly').classList?.contains('is-on') === true,
      runOnEdit: flagChecks.get('runOnEdit').classList?.contains('is-on') === true,
      disabled: flagChecks.get('disabled').classList?.contains('is-on') === true,
      substituteRegex: Number(subSel.value) || 0,
      minDepth: depthMin.value === '' ? null : Number(depthMin.value),
      maxDepth: depthMax.value === '' ? null : Number(depthMax.value),
    });
    const showOut = text => {
      testOut.textContent = text == null ? '' : String(text);
      if (testOut.textContent) testOut.classList?.remove('is-empty'); else testOut.classList?.add('is-empty');
    };
    showOut('');
    testBtn.addEventListener('click', () => {
      try {
        const preview = typeof actions.preview === 'function' ? actions.preview(collect(), testIn.area.value) : { ok: true, output: testIn.area.value };
        showOut(preview.ok ? preview.output : `⚠ ${preview.error || '正则无效'}`);
      } catch (error) { showOut(`⚠ ${error?.message || '测试失败'}`); }
    });
    const testBody = el('div', 'qm-regex-test-body');
    testBody.append(testIn.wrap, testBtn, testOut);
    const testWrap = el('details', 'qm-regex-test');
    const testSummary = el('summary', 'qm-regex-test-summary', '测试模式'); testSummary.dataset.key = 'editor-test-toggle';
    testWrap.append(testSummary, testBody);
    form.append(testWrap);

    // 底部动作：取消（左）/ 保存（右），图标小按钮分置两端。
    const foot = el('div', 'qm-regex-editor-foot');
    const cancel = el('button', 'qm-regex-footbtn is-quiet', ''); cancel.type = 'button'; cancel.dataset.key = 'editor-cancel';
    cancel.setAttribute('aria-label', '取消'); cancel.title = '取消';
    const ci = el('i', 'fa-solid fa-xmark'); ci.setAttribute('aria-hidden', 'true'); cancel.append(ci);
    cancel.addEventListener('click', () => { try { actions.closeEditor?.(); } catch (error) { notify(error?.message || '取消失败', 'warning'); } });
    const save = el('button', 'qm-regex-footbtn is-primary', ''); save.type = 'button'; save.dataset.key = 'editor-save';
    save.setAttribute('aria-label', '保存'); save.title = '保存';
    const si = el('i', 'fa-solid fa-check'); si.setAttribute('aria-hidden', 'true'); save.append(si);
    save.addEventListener('click', () => {
      const script = collect();
      if (!script.scriptName) { notify('请先填写正则名称', 'warning'); return; }
      const run = isNew
        ? actions.insert({ source, script })
        : actions.saveScript({ source, id: editing.id, name: editing.name, script });
      Promise.resolve().then(() => run).then(result => { if (result !== null) actions.closeEditor?.(); })
        .catch(error => notify(error?.message || '保存失败', 'warning'));
    });
    foot.append(cancel, save);

    wrap.replaceChildren(subhead, form, foot);
    root.replaceChildren(wrap);
  }

  function render(state) {
    if (disposed || !state) return;
    if (state.editing && typeof actions.saveScript === 'function') { lockPanel(true); renderEditor(state); return; }
    lockPanel(false);
    const { view, sources } = state;
    const binding = state.binding && typeof state.binding === 'object' ? state.binding : { enabled: false, overrides: {} };
    const bound = key => binding.enabled && binding.overrides && Object.prototype.hasOwnProperty.call(binding.overrides, key);
    const pending = Array.isArray(state.pending) ? state.pending : [];
    const keep = focusedKey(), scroll = root.scrollTop;
    const tools = el('div', 'qm-regex-tools');
    // C-15 s9：视图切换按钮移除（单一模式）；控制器仍保留 setView 便于回退。
    // C-11d：绑定此聊天总开关。开着时，随手拨动任一开关即记入本聊天，进聊天自动套用。
    if (typeof actions.setBindingEnabled === 'function') {
      const bindBtn = el('button', `qm-regex-tool qm-regex-bind-toggle${binding.enabled ? ' is-on' : ''}`); bindBtn.type = 'button';
      bindBtn.dataset.key = 'bind';
      bindBtn.setAttribute('aria-pressed', String(binding.enabled === true));
      bindBtn.setAttribute('aria-label', `绑定此聊天：${binding.enabled ? '已开启，进聊天自动套用预设与正则' : '未开启'}`);
      bindBtn.title = binding.enabled ? '绑定此聊天（已开启：预设与正则改动会记入本聊天，进聊天自动套用）' : '绑定此聊天（开启后记住当前预设，预设与正则改动记入本聊天，进聊天自动套用）';
      const bg = el('i', 'fa-solid fa-link'); bg.setAttribute('aria-hidden', 'true');
      bindBtn.append(bg, el('span', 'qm-regex-tool-label', '绑定此聊天'));
      bindBtn.addEventListener('click', () => {
        if (bindBtn.disabled) return;
        Promise.resolve().then(() => actions.setBindingEnabled(!binding.enabled))
          .catch(error => notify(error?.message || '绑定切换失败', 'warning'));
      });
      tools.append(bindBtn);
    }
    const managing = state.managing === true;
    const selectedSet = new Set(Array.isArray(state.selected) ? state.selected : []);
    const selected = key => selectedSet.has(key);
    // C-15 s7：拾取移动——当前拾起的条目（同源）；视图据此在同源行前/列表尾显示插入位。
    const picking = Array.isArray(state.picking) ? state.picking : [];
    const g = sources.global, p = sources.preset;
    const anyWritable = g.writable === true || p.writable === true;
    // C-14f：管理态总开关（仅可写时出现）。进管理态后行变多选 + 排序 + 点名编辑，批量操作走底部工具条。
    if (anyWritable && typeof actions.setManaging === 'function') {
      const manageBtn = el('button', `qm-regex-tool qm-regex-manage-toggle${managing ? ' is-on' : ''}`); manageBtn.type = 'button';
      manageBtn.dataset.key = 'manage';
      manageBtn.setAttribute('aria-pressed', String(managing));
      manageBtn.setAttribute('aria-label', `管理条目：${managing ? '已开启，可多选/排序/编辑' : '未开启'}`);
      manageBtn.title = managing ? '管理条目（已开启：多选、删除、复制、排序、改分组、新建、点名编辑）' : '管理条目（多选、删除、复制、排序、改分组、新建、点名编辑）';
      const mg = el('i', 'fa-solid fa-sliders'); mg.setAttribute('aria-hidden', 'true');
      manageBtn.append(mg, el('span', 'qm-regex-tool-label', '管理'));
      manageBtn.addEventListener('click', () => { try { actions.setManaging(!managing); } catch (error) { notify(error?.message || '管理切换失败', 'warning'); } });
      tools.append(manageBtn);
    }
    // C-15 s5：回收站。有被删条目时出现；点按切到「已删除」列表，再点返回正则列表。
    const recycle = state.recycle && typeof state.recycle === 'object' ? state.recycle : { open: false, count: 0, items: [] };
    if (typeof actions.setRecycle === 'function' && (recycle.count > 0 || recycle.open)) {
      const binBtn = el('button', `qm-regex-tool qm-regex-recycle-toggle${recycle.open ? ' is-on' : ''}`); binBtn.type = 'button';
      binBtn.dataset.key = 'recycle';
      binBtn.setAttribute('aria-pressed', String(recycle.open));
      binBtn.setAttribute('aria-label', recycle.open ? '回收站：已打开，点按返回正则列表' : `回收站：${recycle.count} 条已删除，点按查看`);
      binBtn.title = recycle.open ? '回收站（返回正则列表）' : `回收站（${recycle.count} 条已删除，可还原）`;
      const bi = el('i', 'fa-solid fa-trash-can'); bi.setAttribute('aria-hidden', 'true');
      binBtn.append(bi, el('span', 'qm-regex-tool-label', recycle.open ? '返回' : `回收站 ${recycle.count}`));
      binBtn.addEventListener('click', () => { try { actions.setRecycle(!recycle.open); } catch (error) { notify(error?.message || '回收站切换失败', 'warning'); } });
      tools.append(binBtn);
    }
    // C-16 s1：写回 / 重绘聊天进行中的状态提示（工具行尾小转圈），让用户知道操作已被接收。
    if (state.writing === true || state.reloading === true) {
      const status = el('span', 'qm-regex-status');
      status.dataset.key = 'status';
      status.setAttribute('role', 'status');
      const si = el('i', 'fa-solid fa-spinner fa-spin'); si.setAttribute('aria-hidden', 'true');
      status.append(si, el('span', 'qm-regex-status-text', state.writing === true ? '写入中' : '刷新聊天中'));
      tools.append(status);
    }
    // 回收站视图：替换正则卡，显示「已删除」列表 + 还原；底部小字说明内存态。
    if (recycle.open) { root.replaceChildren(tools, recycleList(recycle)); if (typeof scroll === 'number') root.scrollTop = scroll; return; }
    const busy = Array.isArray(state.busy) ? state.busy : [];
    const common = { pending, bound, managing, selected, selectedKeys: [...selectedSet], picking, busy, writing: state.writing === true };
    const globalCard = section('全局正则', g.available ? `${g.items.length} 条` : '', g.items, view,
      { unavailable: g.available ? '' : '未读取到全局正则（正则扩展可能未加载）', source: 'global', writable: g.writable === true, siblings: g.items, ...common });
    let presetNote = '';
    if (p.available) presetNote = `${p.items.length} 条${p.items.length && !p.allowed ? ' · 未被允许运行' : ''}`;   // C-14e：预设名已在页顶快切里，卡内不再重复
    const presetCard = section('预设正则', presetNote, p.items, view,
      { unavailable: p.available ? '' : '当前 ST 版本不支持预设正则', source: 'preset', writable: p.writable === true, siblings: p.items, ...common });
    const presets = state.presets && typeof state.presets === 'object' ? state.presets : { available: false, names: [] };
    const head = presets.available && typeof actions.selectPreset === 'function' ? [presetSwitch(presets, binding)] : [];
    // 管理态选择工具条随状态条件渲染（撤销已并入回收站）。
    const bars = [];
    if (managing) bars.push(selectionBar([...selectedSet], sources));
    root.replaceChildren(...head, tools, ...bars, globalCard, presetCard);
    if (typeof scroll === 'number') root.scrollTop = scroll;
    if (keep) [...(root.querySelectorAll?.('[data-key]') || [])].find(node => node.dataset.key === keep)?.focus?.();
  }

  // 多选工具条：全选/清空、删除（二次确认）、复制、复制到另一来源、移入分组、取消管理。
  function selectionBar(keys, sources) {
    const bar = el('div', 'qm-regex-selbar');
    const items = keys.map(key => {
      const [source, ...rest] = String(key).split(':'); const id = rest.join(':');
      const found = (sources?.[source]?.items || []).find(item => String(item.id) === id);
      return found ? { source, id, name: found.name } : null;
    }).filter(Boolean);
    const count = items.length;
    bar.append(el('span', 'qm-regex-selbar-count', `已选 ${count} 条`));
    const act = (label, className, key, run) => {
      const b = el('button', `qm-regex-selact ${className}`); b.type = 'button';
      b.dataset.key = `sel-act:${key}`;
      b.setAttribute('aria-label', label); b.title = label;
      b.append(el('span', 'qm-regex-selact-text', label));
      if (!count && key !== 'cancel') { b.disabled = true; }
      b.addEventListener('click', () => { if (b.disabled) return; Promise.resolve().then(() => run(items)).catch(error => notify(error?.message || `${label}失败`, 'warning')); });
      return b;
    };
    bar.append(
      act('删除', 'is-danger', 'del', its => { if (!confirmDelete(its.length)) return; return actions.removeMany({ items: its }); }),
      act('复制', '', 'copy', its => actions.copyMany({ items: its })),
      // C-15 s9：移入分组 = 写【标签】（与双击改名同一模型）；留空 = 去掉标签回到自动归类。
      act('移入分组', '', 'group', its => { const to = askGroup(); if (to === null) return; return typeof actions.retag === 'function' ? actions.retag({ items: its, tag: to }) : actions.regroup({ items: its, to }); }),
      act('取消', 'is-quiet', 'cancel', () => actions.setManaging(false)),
    );
    return bar;
  }

  // 二次确认 / 分组名输入：优先用宿主的原生对话框；测试 fake DOM 无 window 时放行（默认不阻断）。
  function confirmDelete(n) {
    const confirm = root.ownerDocument?.defaultView?.confirm;
    return typeof confirm === 'function' ? confirm(`确定删除选中的 ${n} 条正则？可在回收站还原。`) : true;
  }
  function askGroup() {
    const prompt = root.ownerDocument?.defaultView?.prompt;
    if (typeof prompt !== 'function') return '';
    const value = prompt('移入分组名（留空＝取消手动分组）：', '');
    return value === null ? null : String(value).trim();
  }

  // C-15 s5：回收站列表。样式同正则卡；每条尾部换成还原图标。顶部「全部还原」，底部内存态小字。
  function recycleList(recycle) {
    const card = el('section', 'qm-regex-card qm-regex-recycle');
    const head = el('header', 'qm-regex-card-head');
    head.append(el('h4', 'qm-regex-title', '已删除'));
    head.append(el('span', 'qm-regex-note', `${recycle.count} 条`));
    if (recycle.count && typeof actions.undoRemove === 'function') {
      const all = el('button', 'qm-regex-tool qm-regex-recycle-all'); all.type = 'button';
      all.dataset.key = 'recycle-all';
      all.setAttribute('aria-label', `全部还原 ${recycle.count} 条`); all.title = '全部还原';
      const ic = el('i', 'fa-solid fa-rotate-left'); ic.setAttribute('aria-hidden', 'true');
      all.append(ic, el('span', 'qm-regex-tool-label', '全部还原'));
      all.addEventListener('click', () => { Promise.resolve().then(() => actions.undoRemove({})).catch(error => notify(error?.message || '还原失败', 'warning')); });
      head.append(all);
    }
    card.append(head);
    const box = el('div', 'qm-regex-list');
    if (!recycle.items.length) box.append(el('p', 'qm-regex-empty', '回收站是空的'));
    for (const entry of recycle.items) {
      const node = el('div', 'qm-regex-row qm-regex-trash-row');
      node.dataset.key = `trash:${entry.key}`;
      const name = el('span', 'qm-regex-name', entry.name); name.title = entry.name;
      if (entry.source === 'preset') name.append(document.createTextNode(entry.preset ? `（预设「${entry.preset}」）` : '（预设）'));
      const restore = el('button', 'qm-regex-trash-restore'); restore.type = 'button';
      restore.dataset.key = `restore:${entry.key}`;
      restore.setAttribute('aria-label', `还原「${entry.name}」`); restore.title = '还原';
      const ri = el('i', 'fa-solid fa-rotate-left'); ri.setAttribute('aria-hidden', 'true');
      restore.append(ri);
      restore.addEventListener('click', () => { Promise.resolve().then(() => actions.undoRemove({ keys: [entry.key] })).catch(error => notify(error?.message || '还原失败', 'warning')); });
      node.append(name, restore);
      box.append(node);
    }
    card.append(box);
    card.append(el('p', 'qm-regex-recycle-note', '刷新或重启 ST 后自动清空'));
    return card;
  }

  function dispose() { disposed = true; lockPanel(false); root.replaceChildren?.(); }
  return Object.freeze({ render, dispose });
}
