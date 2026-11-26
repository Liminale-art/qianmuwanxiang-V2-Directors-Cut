// 聊天工具包 · API 快切（用户 2026-11-26 定版）：ST 原生「连接配置」（Connection Profiles）的前端快切。
// 连接本身全在 ST：extension_settings.connectionManager.profiles／selectedProfile；密钥在 ST 的密钥库（profile['secret-id']），千幕不读不写密钥。
// 千幕只存自己的整理（settings.apiSwitch）：置顶、分组（自定组名、移入移出）、最近使用时刻。不做绑定，每条只显示 ST 原生里它带着的预设与模型。
// 切换走原生下拉 #connection_profiles 的 change，与 ST 的 /profile 命令同一条路；新建用 /profile-create（从当前连接新建，和原生「新建」一样）。

const text = value => (typeof value === 'string' ? value.trim() : '');
const plain = value => !!value && typeof value === 'object' && !Array.isArray(value);
const attempt = (run, fallback) => { try { return run(); } catch (_) { return fallback; } };

// ST 里的连接配置。available:false 表示没有装或停用了 ST 的连接管理器。
export function readProfiles(context) {
  const manager = attempt(() => context?.extensionSettings?.connectionManager, null);
  if (!plain(manager) || !Array.isArray(manager.profiles)) return Object.freeze({ available: false, selected: '', profiles: Object.freeze([]) });
  const profiles = manager.profiles.filter(plain).filter(item => text(item.id) && text(item.name)).map(item => Object.freeze({
    id: text(item.id), name: text(item.name), mode: item.mode === 'tc' ? 'tc' : 'cc', api: text(item.api), url: text(item['api-url']),
    model: text(item.model), preset: text(item.preset), hasSecret: !!text(item['secret-id']),
  }));
  const selected = text(manager.selectedProfile);
  return Object.freeze({ available: true, selected: profiles.some(item => item.id === selected) ? selected : '', profiles: Object.freeze(profiles) });
}

// 千幕这边的整理。只留认得的字段；分组里的成员去重、一条只在一个组里。
export function normalizeSwitchState(raw) {
  const source = plain(raw) ? raw : {}, seen = new Set();
  const pinned = [...new Set((Array.isArray(source.pinned) ? source.pinned : []).map(text).filter(Boolean))];
  const groups = (Array.isArray(source.groups) ? source.groups : []).filter(plain).map(group => ({
    id: text(group.id), name: text(group.name) || '未命名分组',
    ids: (Array.isArray(group.ids) ? group.ids : []).map(text).filter(id => id && !seen.has(id) && seen.add(id)),
  })).filter(group => group.id);
  const recent = {};
  for (const [id, at] of Object.entries(plain(source.recent) ? source.recent : {})) if (text(id) && Number.isFinite(Number(at))) recent[text(id)] = Number(at);
  return { pinned, groups, recent };
}

// 列表的排法（用户定）：置顶在最上；再是各个分组；其余按最近使用排（没用过的按名字）。一条只出现一次，置顶优先。
export function arrangeProfiles(profiles, rawState) {
  const state = normalizeSwitchState(rawState), list = Array.isArray(profiles) ? profiles : [];
  const byId = new Map(list.map(item => [item.id, item]));
  const pinned = state.pinned.map(id => byId.get(id)).filter(Boolean), used = new Set(pinned.map(item => item.id));
  const groups = state.groups.map(group => {
    const items = group.ids.map(id => byId.get(id)).filter(item => item && !used.has(item.id));
    for (const item of items) used.add(item.id);
    return { id: group.id, name: group.name, items };
  });
  const others = list.filter(item => !used.has(item.id))
    .sort((a, b) => (state.recent[b.id] || 0) - (state.recent[a.id] || 0) || a.name.localeCompare(b.name));
  return { pinned, groups, others };
}

export const togglePinned = (rawState, id) => {
  const state = normalizeSwitchState(rawState);
  return { ...state, pinned: state.pinned.includes(id) ? state.pinned.filter(item => item !== id) : [...state.pinned, id] };
};
// 移到某个分组（groupId 为空即移出分组）。
export const moveToGroup = (rawState, id, groupId) => {
  const state = normalizeSwitchState(rawState);
  return { ...state, groups: state.groups.map(group => ({ ...group, ids: [...group.ids.filter(item => item !== id), ...(group.id === groupId ? [id] : [])] })) };
};
export const markUsed = (rawState, id, now = Date.now()) => {
  const state = normalizeSwitchState(rawState);
  return id ? { ...state, recent: { ...state.recent, [id]: now } } : state;
};

// 名字里带 | 或 {{ 会被斜杠命令拆开或当成宏，新建与改名时不收。
export function checkProfileName(name, profiles, exceptId = '') {
  const value = text(name);
  if (!value) return '名称不能为空';
  if (/[|]|\{\{/.test(value) || value === '<None>') return '名称里不能有 | 或 {{';
  if ((Array.isArray(profiles) ? profiles : []).some(item => item.name === value && item.id !== exceptId)) return '已有同名的连接';
  return '';
}

// 改一条连接的名称、服务地址、模型、预设（ST 原生的同名字段）；空着的地址与预设视为不设。
export function patchProfile(context, id, patch) {
  const manager = context?.extensionSettings?.connectionManager;
  const profile = (manager?.profiles || []).find(item => item?.id === id);
  if (!profile) throw new Error('这条连接已不存在');
  const problem = checkProfileName(patch.name, readProfiles(context).profiles, id);
  if (problem) throw new Error(problem);
  profile.name = text(patch.name);
  for (const [key, value] of [['api-url', patch.url], ['model', patch.model], ['preset', patch.preset]]) {
    if (value === undefined) continue;
    if (text(value)) profile[key] = text(value); else delete profile[key];
  }
  attempt(() => context.saveSettingsDebounced?.(), null);
  return profile;
}

// 某种模式下可选的预设名（cc 用对话补全的预设，tc 用当前文本补全的预设）。
export function presetNames(context, mode) {
  const manager = attempt(() => context.getPresetManager?.(mode === 'cc' ? 'openai' : undefined), null);
  const raw = attempt(() => manager?.getAllPresets?.(), []);
  return [...new Set((Array.isArray(raw) ? raw : []).map(text).filter(Boolean))];
}

const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
const SOURCE_NAMES = { openai: 'OpenAI', claude: 'Claude', custom: '自定义', openrouter: 'OpenRouter', makersuite: 'Google', deepseek: 'DeepSeek', mistralai: 'Mistral', cohere: 'Cohere', groq: 'Groq', xai: 'xAI' };

// 一行：名字 + 小标签（来源、模型、预设，映射 ST 原生里这条连接带着的值）+ 置顶 + 更多。
export function renderProfileRow(item, { active = false, pinned = false, open = '' } = {}, esc = escapeHtml) {
  const tags = [item.api && (SOURCE_NAMES[item.api] || item.api), item.model && `模型 ${item.model}`, item.preset && `预设 ${item.preset}`].filter(Boolean)
    .map(tag => `<span class="qm-api-tag">${esc(tag)}</span>`).join('');
  return `<div class="qm-api-row${active ? ' is-active' : ''}" data-id="${esc(item.id)}">
      <button type="button" class="qm-api-pick" aria-pressed="${active}" title="切换到这条连接"><span class="qm-api-name">${active ? '<i class="fa-solid fa-circle-check" aria-hidden="true"></i>' : ''}${esc(item.name)}</span><span class="qm-api-tags">${tags || '<span class="qm-api-tag is-empty">未记预设与模型</span>'}</span></button>
      <button type="button" class="qm-api-icon qm-api-pin${pinned ? ' is-on' : ''}" aria-pressed="${pinned}" title="${pinned ? '取消置顶' : '置顶'}" aria-label="${pinned ? '取消置顶' : '置顶'}"><i class="fa-solid fa-thumbtack" aria-hidden="true"></i></button>
      <button type="button" class="qm-api-icon qm-api-more" aria-expanded="${open === 'more' || open === 'edit'}" title="更多" aria-label="更多"><i class="fa-solid fa-ellipsis" aria-hidden="true"></i></button>
    </div>`;
}

export function renderSwitchPage({ data, state, openId = '', openKind = '', presets = [] }, esc = escapeHtml) {
  if (!data.available) return `<div class="qm-api-card"><p class="qm-api-empty">没有找到 ST 的「连接配置」。请在 ST 的扩展里启用 Connection Profiles 后再来。</p></div>`;
  const arranged = arrangeProfiles(data.profiles, state), current = data.profiles.find(item => item.id === data.selected);
  const pinnedIds = new Set(normalizeSwitchState(state).pinned);
  const row = item => renderProfileRow(item, { active: item.id === data.selected, pinned: pinnedIds.has(item.id), open: item.id === openId ? openKind : '' }, esc)
    + (item.id === openId && openKind === 'more' ? renderMoreMenu(item, normalizeSwitchState(state), esc) : '')
    + (item.id === openId && openKind === 'edit' ? renderEditPanel(item, presets, esc) : '');
  const block = (id, title, items, head = '') => `<section class="qm-api-group" data-group="${esc(id)}"><div class="qm-api-group-head"><h4>${esc(title)}</h4>${head}</div>${items.length ? items.map(row).join('') : '<p class="qm-api-empty">空</p>'}</section>`;
  const groupHead = group => `<span class="qm-api-group-acts"><button type="button" class="qm-api-icon qm-api-group-rename" data-group="${esc(group.id)}" title="改组名" aria-label="改组名"><i class="fa-solid fa-pen" aria-hidden="true"></i></button><button type="button" class="qm-api-icon qm-api-group-del" data-group="${esc(group.id)}" title="删除分组（里面的连接回到最近使用）" aria-label="删除分组"><i class="fa-solid fa-trash" aria-hidden="true"></i></button></span>`;
  return `<div class="qm-api-card qm-api-current">
      <div class="qm-api-group-head"><h4>当前连接</h4><span class="qm-api-tools"><button type="button" class="qm-api-text qm-api-create" title="用 ST 当前的连接设置新建一条">＋ 新建</button><button type="button" class="qm-api-text qm-api-group-add">＋ 分组</button></span></div>
      ${current ? renderProfileRow(current, { active: true, pinned: pinnedIds.has(current.id) }, esc).replace('qm-api-row', 'qm-api-row qm-api-row-current') : '<p class="qm-api-empty">ST 现在没有选中连接配置。</p>'}
    </div>
    <div class="qm-api-card qm-api-list">
      ${arranged.pinned.length ? block('pinned', '置顶', arranged.pinned) : ''}
      ${arranged.groups.map(group => block(group.id, group.name, group.items, groupHead(group))).join('')}
      ${block('others', '最近使用', arranged.others)}
    </div>`;
}

function renderMoreMenu(item, state, esc) {
  const inGroup = state.groups.find(group => group.ids.includes(item.id))?.id || '';
  const options = [`<option value=""${inGroup ? '' : ' selected'}>不放进分组</option>`, ...state.groups.map(group => `<option value="${esc(group.id)}"${group.id === inGroup ? ' selected' : ''}>${esc(group.name)}</option>`)].join('');
  return `<div class="qm-api-menu" data-id="${esc(item.id)}">
      <button type="button" class="qm-api-text qm-api-edit">编辑</button>
      <label class="qm-api-move"><span>分组</span><select class="qm-api-group-pick" aria-label="移到分组">${options}</select></label>
      <button type="button" class="qm-api-text qm-api-del">删除</button>
    </div>`;
}

// 便捷填写面板：名称、服务地址、模型、预设；密钥仍由 ST 保管（这里只说明有没有）。
function renderEditPanel(item, presets, esc) {
  const presetOptions = [`<option value=""${item.preset ? '' : ' selected'}>不切换预设</option>`, ...[...new Set([...(item.preset ? [item.preset] : []), ...presets])]
    .map(name => `<option value="${esc(name)}"${name === item.preset ? ' selected' : ''}>${esc(name)}</option>`)].join('');
  const field = (label, cls, value, placeholder = '') => `<label class="qm-api-field"><span>${label}</span><input type="text" class="${cls}" value="${esc(value)}" placeholder="${esc(placeholder)}" spellcheck="false" autocomplete="off"></label>`;
  return `<div class="qm-api-edit-panel" data-id="${esc(item.id)}">
      ${field('名称', 'qm-api-f-name', item.name)}
      ${item.api === 'custom' || item.url ? field('服务地址', 'qm-api-f-url', item.url, 'https://…/v1') : ''}
      ${field('模型', 'qm-api-f-model', item.model, '例如 gpt-4o')}
      <label class="qm-api-field"><span>预设</span><select class="qm-api-f-preset">${presetOptions}</select></label>
      <p class="qm-api-note">${item.hasSecret ? '密钥：ST 已为这条连接存好' : '密钥：跟随 ST 当前'}</p>
      <div class="qm-api-edit-acts"><button type="button" class="qm-api-text qm-api-cancel">取消</button><button type="button" class="qm-api-text is-primary qm-api-save">保存</button></div>
    </div>`;
}

// 控制器。getContext：ST 上下文；getOwner/save：千幕设置（存 apiSwitch）；notify／confirm／prompt：提示与弹窗。
export function createChatApiSwitch({ getContext, getOwner, save, notify = () => {}, confirm = async () => true, prompt = async () => null, doc = globalThis.document, uid = () => `grp-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}` } = {}) {
  let host = null, openId = '', openKind = '';
  const ctx = () => getContext?.() || {};
  const owner = () => getOwner?.() || {};
  const state = () => normalizeSwitchState(owner().apiSwitch);
  const write = next => { owner().apiSwitch = normalizeSwitchState(next); save?.(); };
  const select = () => doc?.getElementById?.('connection_profiles') || null;

  function render() {
    if (!host?.isConnected) return;
    const data = readProfiles(ctx());
    const item = data.profiles.find(profile => profile.id === openId);
    if (!item) { openId = ''; openKind = ''; }
    host.innerHTML = renderSwitchPage({ data, state: state(), openId, openKind, presets: item && openKind === 'edit' ? presetNames(ctx(), item.mode) : [] });
  }

  // 走原生下拉切换（与 /profile 同一路径），等 ST 说套用完。
  async function apply(id) {
    const node = select();
    if (!node) throw new Error('没有找到 ST 的连接配置下拉，切换不了');
    if (![...node.options].some(option => option.value === id)) throw new Error('ST 的下拉里没有这条连接，请重开页面');
    const context = ctx(), type = context.eventTypes?.CONNECTION_PROFILE_LOADED || 'connection_profile_loaded';
    const loaded = new Promise(resolve => { const timer = setTimeout(resolve, 8000); context.eventSource?.once?.(type, () => { clearTimeout(timer); resolve(); }); });
    node.value = id;
    node.dispatchEvent(new Event('change'));
    await loaded;
    write(markUsed(state(), id));
  }
  // 改名后原生下拉里那一项的文字跟着改；删掉的那项移走。
  const syncOption = (id, name) => { const option = [...(select()?.options || [])].find(item => item.value === id); if (option) { if (name == null) option.remove(); else option.textContent = name; } };

  async function onClick(event) {
    const target = event.target;
    const row = target.closest('.qm-api-row, .qm-api-menu, .qm-api-edit-panel');
    const id = row?.dataset.id || '';
    try {
      if (target.closest('.qm-api-pick')) {
        if (id === readProfiles(ctx()).selected) return;
        target.closest('.qm-api-pick').disabled = true;
        await apply(id); notify(`已切换到「${readProfiles(ctx()).profiles.find(item => item.id === id)?.name || ''}」`, 'success'); render(); return;
      }
      if (target.closest('.qm-api-pin')) { write(togglePinned(state(), id)); render(); return; }
      if (target.closest('.qm-api-more')) { const same = openId === id && openKind; openId = same ? '' : id; openKind = same ? '' : 'more'; render(); return; }
      if (target.closest('.qm-api-edit')) { openKind = 'edit'; render(); host.querySelector('.qm-api-f-name')?.focus(); return; }
      if (target.closest('.qm-api-cancel')) { openId = ''; openKind = ''; render(); return; }
      if (target.closest('.qm-api-save')) {
        const panel = target.closest('.qm-api-edit-panel'), value = cls => panel.querySelector(cls)?.value ?? '';
        const url = panel.querySelector('.qm-api-f-url') ? value('.qm-api-f-url') : undefined;   // 没有地址栏的来源不改地址
        const profile = patchProfile(ctx(), id, { name: value('.qm-api-f-name'), url, model: value('.qm-api-f-model'), preset: value('.qm-api-f-preset') });
        syncOption(id, profile.name);
        const context = ctx();
        await context.eventSource?.emit?.(context.eventTypes?.CONNECTION_PROFILE_UPDATED || 'connection_profile_updated', profile, profile);
        // 改的正是当前连接：重新套用一次才生效
        if (readProfiles(ctx()).selected === id) await apply(id);
        openId = ''; openKind = ''; notify('连接已保存。', 'success'); render(); return;
      }
      if (target.closest('.qm-api-del')) {
        const data = readProfiles(ctx()), item = data.profiles.find(profile => profile.id === id);
        if (!item || !await confirm('删除连接', `删除 ST 里的连接配置「${item.name}」？不可恢复。`)) return;
        const manager = ctx().extensionSettings.connectionManager, index = manager.profiles.findIndex(profile => profile?.id === id);
        if (index < 0) return;
        const [removed] = manager.profiles.splice(index, 1);
        if (manager.selectedProfile === id) { manager.selectedProfile = null; const node = select(); if (node) node.value = ''; }
        syncOption(id, null);
        write({ ...moveToGroup(state(), id, ''), pinned: state().pinned.filter(item2 => item2 !== id) });
        ctx().saveSettingsDebounced?.();
        await ctx().eventSource?.emit?.(ctx().eventTypes?.CONNECTION_PROFILE_DELETED || 'connection_profile_deleted', removed);
        openId = ''; openKind = ''; notify('已删除。', 'info'); render(); return;
      }
      if (target.closest('.qm-api-create')) {
        const data = readProfiles(ctx());
        const name = await prompt('新建连接', '用 ST 现在的连接设置新建一条，起个名：', '');
        if (name == null) return;
        const problem = checkProfileName(name, data.profiles);
        if (problem) { notify(problem, 'warning'); return; }
        const run = ctx().executeSlashCommandsWithOptions;
        if (typeof run !== 'function') throw new Error('当前 ST 不支持在此新建连接');
        await run(`/profile-create ${text(name)}`, { handleParserErrors: true, handleExecutionErrors: true });
        const made = readProfiles(ctx()).profiles.find(item => item.name === text(name));
        if (!made) throw new Error('ST 没有建成这条连接');
        write(markUsed(state(), made.id)); notify(`已新建「${made.name}」。`, 'success'); render(); return;
      }
      if (target.closest('.qm-api-group-add')) {
        const name = text(await prompt('新建分组', '分组名：', '') || '');
        if (!name) return;
        write({ ...state(), groups: [...state().groups, { id: uid(), name, ids: [] }] }); render(); return;
      }
      const rename = target.closest('.qm-api-group-rename');
      if (rename) {
        const group = state().groups.find(item => item.id === rename.dataset.group);
        const name = text(await prompt('改组名', '新的分组名：', group?.name || '') || '');
        if (!group || !name) return;
        write({ ...state(), groups: state().groups.map(item => (item.id === group.id ? { ...item, name } : item)) }); render(); return;
      }
      const drop = target.closest('.qm-api-group-del');
      if (drop) {
        const group = state().groups.find(item => item.id === drop.dataset.group);
        if (!group || !await confirm('删除分组', `删除分组「${group.name}」？里面的连接不会删，回到「最近使用」。`)) return;
        write({ ...state(), groups: state().groups.filter(item => item.id !== group.id) }); render(); return;
      }
    } catch (error) { notify(error?.message || '操作没有完成', 'warning'); render(); }
  }
  function onChange(event) {
    const pick = event.target.closest('.qm-api-group-pick');
    if (!pick) return;
    write(moveToGroup(state(), pick.closest('.qm-api-menu').dataset.id, pick.value)); openId = ''; openKind = ''; render();
  }

  return Object.freeze({
    mount(section) {
      if (host !== section) {
        host = section;
        section.addEventListener('click', event => { void onClick(event); });
        section.addEventListener('change', onChange);
      }
      render();
    },
    // 在 ST 原生里切换／新建／改／删连接时：记最近使用，开着的页面跟着刷新。
    events: Object.freeze({
      profileLoaded(name) {
        const item = readProfiles(ctx()).profiles.find(profile => profile.name === text(name));
        if (item) write(markUsed(state(), item.id));
        render();
      },
      profilesChanged() { render(); },
    }),
  });
}
