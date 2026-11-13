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

  function row(item, source, { writable = false, pending = [], bound = () => false, managing = false, selected = () => false, group = '' } = {}) {
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
    if (managing && writable) {
      node.classList.add('is-managing');
      const key = `${source}:${item.id}`, on = selected(key);
      if (on) node.classList.add('is-selected');
      const check = el('button', `qm-regex-check${on ? ' is-on' : ''}`); check.type = 'button';
      check.dataset.key = `sel:${key}`;
      check.setAttribute('role', 'checkbox'); check.setAttribute('aria-checked', String(on));
      check.setAttribute('aria-label', `${item.name}：${on ? '已选，点按取消' : '点按选中'}`);
      const tick = el('i', 'fa-solid fa-check qm-regex-check-mark'); tick.setAttribute('aria-hidden', 'true');
      check.append(tick);
      check.addEventListener('click', () => { try { actions.setSelected?.(key, !on); } catch (error) { notify(error?.message || '选择失败', 'warning'); } });
      const openEdit = () => { try { actions.openEditor?.({ source, id: item.id, name: item.name }); } catch (error) { notify(error?.message || '打开编辑失败', 'warning'); } };
      name.classList.add('is-editable'); name.setAttribute('role', 'button'); name.setAttribute('tabindex', '0');
      name.dataset.key = `edit:${key}`;
      name.addEventListener('click', openEdit);
      const reorder = el('div', 'qm-regex-reorder');
      const step = (dir, label) => {
        const b = el('button', 'qm-regex-step'); b.type = 'button';
        b.dataset.key = `move:${dir}:${key}`;
        b.setAttribute('aria-label', `${item.name}：${label}`); b.title = label;
        const ic = el('i', `fa-solid fa-chevron-${dir === 'up' ? 'up' : 'down'}`); ic.setAttribute('aria-hidden', 'true');
        b.append(ic);
        b.addEventListener('click', () => { try { actions.moveRow?.({ source, item: { id: item.id, name: item.name }, dir, group }); } catch (error) { notify(error?.message || '移动失败', 'warning'); } });
        return b;
      };
      reorder.append(step('up', '上移'), step('down', '下移'));
      node.append(check, name, reorder);
      if (!item.enabled) node.classList.add('is-off');
      return node;
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
    if (mode !== 'group') { box.append(...items.map(item => row(item, source, { ...options, group: '' }))); return box; }
    for (const group of actions.group(items)) {
      const key = `group:${source}:${group.label}`;
      const head = el('div', `qm-regex-group${isFolded(key) ? ' is-folded' : ''}`);
      head.append(foldButton(key, group.label, 'qm-regex-group-label', `${group.label}（${group.items.length}）`));
      if (options.managing && options.writable) head.append(groupRename(group, source));
      else if (options.writable) head.append(batchSwitch(group.items, source, group.label, options.pending));
      box.append(head);
      if (!isFolded(key)) box.append(...group.items.map(item => row(item, source, { ...options, group: group.label })));
    }
    return box;
  }

  // 管理态分组头：改名按钮，把整组条目移入新组名（空 = 移出分组）。用 prompt 式输入框简洁落地。
  function groupRename(group, source) {
    const wrap = el('div', 'qm-regex-group-edit');
    const field = el('input', 'qm-regex-group-input');
    field.type = 'text'; field.value = group.label === '未分组' ? '' : group.label;
    field.dataset.key = `grename:${source}:${group.label}`;
    field.setAttribute('aria-label', `分组「${group.label}」改名（留空移出分组）`);
    field.placeholder = '分组名';
    const apply = () => {
      const to = field.value.trim();
      if (to === (group.label === '未分组' ? '' : group.label)) return;
      const payload = group.items.map(it => ({ source, id: it.id, name: it.name, from: group.label }));
      Promise.resolve().then(() => actions.regroup({ items: payload, to }))
        .catch(error => notify(error?.message || '分组修改失败', 'warning'));
    };
    field.addEventListener('change', apply);
    wrap.append(field);
    return wrap;
  }

  function section(title, note, items, mode, { unavailable = '', source = '', writable = false, pending = [], bound = () => false, managing = false, selected = () => false } = {}) {
    const key = `card:${source}`, folded = isFolded(key);
    const card = el('section', `qm-regex-card${folded ? ' is-folded' : ''}${managing && writable ? ' is-managing' : ''}`);
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
    else card.append(list(items, mode, source, { writable, pending, bound, managing, selected }));
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

  // ST 原生正则编辑器的作用位置：1 用户输入 / 2 AI 输出 / 3 快捷命令 / 5 世界书 / 6 推理。
  const PLACEMENTS = Object.freeze([[1, '用户输入'], [2, 'AI 输出'], [3, '快捷命令'], [5, '世界书'], [6, '推理']]);
  const SUBSTITUTE = Object.freeze([[0, '不替换'], [1, '原样宏'], [2, '转义宏']]);

  // 可拖拽高度 + 一键展开的文本域。resize:vertical 由 CSS 给，展开按钮加/去 is-tall 类。
  function growTextarea(key, label, value, rows = 3) {
    const wrap = el('div', 'qm-regex-field');
    const bar = el('div', 'qm-regex-field-bar');
    const tag = el('label', 'qm-regex-field-label', label); tag.setAttribute('for', `qm-regex-f-${key}`);
    const expand = el('button', 'qm-regex-expand'); expand.type = 'button';
    expand.setAttribute('aria-label', `${label}：展开/收起编辑框`); expand.title = '展开/收起';
    const ei = el('i', 'fa-solid fa-up-right-and-down-left-from-center'); ei.setAttribute('aria-hidden', 'true');
    expand.append(ei);
    bar.append(tag, expand);
    const area = el('textarea', 'qm-regex-textarea');
    area.id = `qm-regex-f-${key}`; area.dataset.key = `field:${key}`;
    area.value = value == null ? '' : String(value);
    area.setAttribute('rows', String(rows));
    expand.addEventListener('click', () => { if (area.classList?.contains('is-tall')) area.classList.remove('is-tall'); else area.classList?.add('is-tall'); });
    wrap.append(bar, area);
    return { wrap, area };
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
    nameField.value = data.scriptName == null ? '' : String(data.scriptName);
    nameField.placeholder = '正则名称';
    const nameLabel = el('label', 'qm-regex-field-label', '名称'); nameLabel.setAttribute('for', 'qm-regex-name');
    const nameWrap = el('div', 'qm-regex-field'); nameWrap.append(nameLabel, nameField);
    form.append(nameWrap);

    const find = growTextarea('findRegex', '查找正则', data.findRegex, 2);
    const replace = growTextarea('replaceString', '替换为', data.replaceString, 3);
    const trim = growTextarea('trimStrings', '修剪掉（每行一条）', (Array.isArray(data.trimStrings) ? data.trimStrings : []).join('\n'), 2);
    form.append(find.wrap, replace.wrap, trim.wrap);

    // 作用位置多选
    const placeSet = new Set((Array.isArray(data.placement) ? data.placement : [2]).map(Number));
    const placeBox = el('div', 'qm-regex-checks');
    placeBox.append(el('span', 'qm-regex-field-label', '作用位置'));
    const placeChecks = new Map();
    for (const [value, label] of PLACEMENTS) {
      const b = el('button', `qm-regex-chip${placeSet.has(value) ? ' is-on' : ''}`); b.type = 'button';
      b.dataset.key = `place:${value}`;
      b.setAttribute('role', 'checkbox'); b.setAttribute('aria-checked', String(placeSet.has(value)));
      b.setAttribute('aria-label', label); b.append(el('span', '', label));
      b.addEventListener('click', () => { const on = !b.classList?.contains('is-on'); if (on) b.classList?.add('is-on'); else b.classList?.remove('is-on'); b.setAttribute('aria-checked', String(on)); });
      placeChecks.set(value, b); placeBox.append(b);
    }
    form.append(placeBox);

    // 布尔开关：仅显示 / 仅提示词 / 编辑时运行 / 已禁用
    const flagDefs = [['markdownOnly', '仅作用于显示', data.markdownOnly === true], ['promptOnly', '仅作用于提示词', data.promptOnly === true],
      ['runOnEdit', '编辑时运行', data.runOnEdit !== false], ['disabled', '已停用', data.disabled === true]];
    const flagBox = el('div', 'qm-regex-flags');
    const flagChecks = new Map();
    for (const [key, label, on] of flagDefs) {
      const b = el('button', `qm-regex-chip${on ? ' is-on' : ''}`); b.type = 'button';
      b.dataset.key = `flag:${key}`;
      b.setAttribute('role', 'checkbox'); b.setAttribute('aria-checked', String(on));
      b.setAttribute('aria-label', label); b.append(el('span', '', label));
      b.addEventListener('click', () => { const next = !b.classList?.contains('is-on'); if (next) b.classList?.add('is-on'); else b.classList?.remove('is-on'); b.setAttribute('aria-checked', String(next)); });
      flagChecks.set(key, b); flagBox.append(b);
    }
    form.append(flagBox);

    // 宏替换模式 + 深度
    const subSel = el('select', 'qm-regex-select'); subSel.dataset.key = 'field:substituteRegex';
    for (const [value, label] of SUBSTITUTE) { const o = el('option', '', label); o.value = String(value); if (Number(data.substituteRegex || 0) === value) o.selected = true; subSel.append(o); }
    subSel.value = String(Number(data.substituteRegex || 0));
    const subLabel = el('label', 'qm-regex-field-label', '宏替换'); subLabel.setAttribute('for', 'qm-regex-sub'); subSel.id = 'qm-regex-sub';
    const subWrap = el('div', 'qm-regex-field'); subWrap.append(subLabel, subSel);
    const depthMin = el('input', 'qm-regex-input qm-regex-depth'); depthMin.type = 'number'; depthMin.dataset.key = 'field:minDepth';
    depthMin.value = data.minDepth == null ? '' : String(data.minDepth); depthMin.placeholder = '最小深度';
    const depthMax = el('input', 'qm-regex-input qm-regex-depth'); depthMax.type = 'number'; depthMax.dataset.key = 'field:maxDepth';
    depthMax.value = data.maxDepth == null ? '' : String(data.maxDepth); depthMax.placeholder = '最大深度';
    const depthWrap = el('div', 'qm-regex-field qm-regex-depths');
    depthWrap.append(el('span', 'qm-regex-field-label', '深度范围'), depthMin, depthMax);
    form.append(subWrap, depthWrap);

    // 测试：拿当前表单字段跑纯函数预览，不写 ST。
    const testIn = growTextarea('testInput', '测试输入', '', 2);
    const testOut = el('pre', 'qm-regex-testout', '');
    const testBtn = el('button', 'qm-regex-selact', '测试'); testBtn.type = 'button'; testBtn.dataset.key = 'editor-test';
    testBtn.setAttribute('aria-label', '用当前字段测试替换效果');
    const collect = () => ({
      scriptName: nameField.value.trim(),
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
    testBtn.addEventListener('click', () => {
      try {
        const preview = typeof actions.preview === 'function' ? actions.preview(collect(), testIn.area.value) : { ok: true, output: testIn.area.value };
        testOut.textContent = preview.ok ? preview.output : `⚠ ${preview.error || '正则无效'}`;
      } catch (error) { testOut.textContent = `⚠ ${error?.message || '测试失败'}`; }
    });
    const testWrap = el('div', 'qm-regex-test');
    testWrap.append(testIn.wrap, testBtn, testOut);
    form.append(testWrap);

    // 底部动作：保存 / 取消
    const foot = el('div', 'qm-regex-editor-foot');
    const cancel = el('button', 'qm-regex-selact is-quiet', '取消'); cancel.type = 'button'; cancel.dataset.key = 'editor-cancel';
    cancel.addEventListener('click', () => { try { actions.closeEditor?.(); } catch (error) { notify(error?.message || '取消失败', 'warning'); } });
    const save = el('button', 'qm-regex-selact is-primary', '保存'); save.type = 'button'; save.dataset.key = 'editor-save';
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
    // 回收站视图：替换正则卡，显示「已删除」列表 + 还原；底部小字说明内存态。
    if (recycle.open) { root.replaceChildren(tools, recycleList(recycle)); if (typeof scroll === 'number') root.scrollTop = scroll; return; }
    const common = { pending, bound, managing, selected };
    const globalCard = section('全局正则', g.available ? `${g.items.length} 条` : '', g.items, view,
      { unavailable: g.available ? '' : '未读取到全局正则（正则扩展可能未加载）', source: 'global', writable: g.writable === true, ...common });
    let presetNote = '';
    if (p.available) presetNote = `${p.items.length} 条${p.items.length && !p.allowed ? ' · 未被允许运行' : ''}`;   // C-14e：预设名已在页顶快切里，卡内不再重复
    const presetCard = section('预设正则', presetNote, p.items, view,
      { unavailable: p.available ? '' : '当前 ST 版本不支持预设正则', source: 'preset', writable: p.writable === true, ...common });
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
      act('移入分组', '', 'group', its => { const to = askGroup(); if (to === null) return; return actions.regroup({ items: its, to }); }),
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
    const value = prompt('移入分组名（留空＝移出分组）：', '');
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
