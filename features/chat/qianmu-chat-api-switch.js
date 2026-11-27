// API 快切的数据整理（界面在 qianmu-api-quick.js，入口在 ST 的 API 连接面板里）。
// 连接本身全在 ST：extension_settings.connectionManager.profiles／selectedProfile；密钥在 ST 的密钥库（profile['secret-id']），千幕不存密钥。
// 千幕只存自己的整理（settings.apiSwitch）：置顶、分组（自定组名、移入移出）、最近使用时刻。

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
