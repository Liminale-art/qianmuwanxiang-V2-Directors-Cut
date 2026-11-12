// Regex tab of the chat toolkit (D-a list + D-b single toggle).
// Lists SillyTavern's global regex scripts and the current preset's regex scripts, in original order or
// auto-grouped by name prefix. A single script can be switched on/off and is written back the way ST's own
// regex panel does it (global: extension settings + saveSettingsDebounced; preset: writePresetExtensionField),
// then the open chat is reloaded once so already-rendered messages pick up the change. Bulk switches,
// locating and the recycle bin are later slices. Every host call is capability-probed: a source whose write
// path is missing stays read-only instead of failing.

// ST regex placement enum (upstream extensions/regex/engine.js regex_placement); 0 is the retired markdown slot.
export const REGEX_PLACEMENTS = Object.freeze({ 1: '用户输入', 2: 'AI 输出', 3: '快捷命令', 5: '世界书', 6: '推理' });
export const REGEX_VIEWS = Object.freeze(['order', 'group']);
export const UNGROUPED_LABEL = '未分组';

const attempt = (read, fallback) => { try { const value = read(); return value ?? fallback; } catch (_) { return fallback; } };
const text = value => typeof value === 'string' ? value.trim() : '';

// Trailing ordinals that only number siblings: "-1" "_2" "#4" " 5" "（3）" "(3)".
const ORDINAL_TAIL = /\s*(?:[-_#]\s*\d+|[（(]\s*\d+\s*[）)]|\s\d+)\s*$/u;
const LEAD_BRACKET = /^\s*[【[]([^】\]]+)[】\]]/u;
const SEPARATOR = /[-_·:：|｜/\s]/u;

export function stripOrdinal(name) {
  let out = text(name);
  for (let i = 0; i < 3 && ORDINAL_TAIL.test(out); i += 1) out = out.replace(ORDINAL_TAIL, '');
  return out.trim();
}

// The cluster key of a script name: a leading 【tag】, else the part before the first separator,
// else the whole name once trailing ordinals are dropped (so "xxx-1" / "xxx-2" share "xxx").
export function regexGroupKey(name) {
  const raw = text(name);
  const bracket = raw.match(LEAD_BRACKET);
  if (bracket?.[1]?.trim()) return bracket[1].trim();
  const base = stripOrdinal(raw);
  const cut = base.search(SEPARATOR);
  const head = cut > 0 ? base.slice(0, cut).trim() : base;
  return head || base;
}

// Groups keep first-appearance order and need at least two members; the rest fall into 未分组 (last).
export function groupRegexScripts(items) {
  const list = Array.isArray(items) ? items : [];
  const buckets = new Map();
  for (const item of list) {
    const key = regexGroupKey(item?.name);
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(item);
  }
  const groups = [], loose = [];
  for (const [key, members] of buckets) {
    if (key && members.length >= 2) groups.push({ key, label: key, items: members });
    else loose.push(...members);
  }
  if (loose.length) {
    const order = new Map(list.map((item, i) => [item, i]));
    loose.sort((a, b) => order.get(a) - order.get(b));
    groups.push({ key: '', label: UNGROUPED_LABEL, items: loose });
  }
  return groups;
}

export function summarizeRegexScript(raw, index = 0) {
  const script = raw && typeof raw === 'object' ? raw : {};
  const placement = (Array.isArray(script.placement) ? script.placement : [])
    .map(p => REGEX_PLACEMENTS[p]).filter(Boolean);
  const scope = script.markdownOnly ? '仅显示' : script.promptOnly ? '仅提示词' : '';
  return Object.freeze({
    id: text(script.id) || `#${index}`,
    name: text(script.scriptName) || '（未命名）',
    enabled: script.disabled !== true,
    placement: Object.freeze(placement),
    scope,
  });
}

const summarizeList = list => (Array.isArray(list) ? list : []).map(summarizeRegexScript);

const presetManager = ctx => attempt(() => (typeof ctx.getPresetManager === 'function' ? ctx.getPresetManager() : null), null);

// Snapshot of the two sources. `available:false` means this ST build lacks the capability;
// `writable:false` means it can be listed but not switched from here.
export function readRegexSources(context) {
  const ctx = context && typeof context === 'object' ? context : {};
  const globalRaw = attempt(() => ctx.extensionSettings?.regex, undefined);
  const global = Object.freeze({ available: Array.isArray(globalRaw), writable: Array.isArray(globalRaw) && typeof ctx.saveSettingsDebounced === 'function',
    items: Object.freeze(summarizeList(globalRaw)) });
  const manager = presetManager(ctx);
  const canRead = typeof manager?.readPresetExtensionField === 'function';
  if (!canRead) return Object.freeze({ global, preset: Object.freeze({ available: false, writable: false, name: '', allowed: false, items: Object.freeze([]) }) });
  const presetRaw = attempt(() => manager.readPresetExtensionField({ path: 'regex_scripts' }), []);
  const name = text(attempt(() => manager.getSelectedPresetName?.(), ''));
  const apiId = text(attempt(() => manager.apiId, '')) || 'openai';
  const allowList = attempt(() => ctx.extensionSettings?.preset_allowed_regex?.[apiId], null);
  const allowed = Array.isArray(allowList) && !!name && allowList.includes(name);
  const writable = Array.isArray(presetRaw) && typeof manager.writePresetExtensionField === 'function';
  return Object.freeze({ global, preset: Object.freeze({ available: true, writable, name, allowed, items: Object.freeze(summarizeList(presetRaw)) }) });
}

// Finds the script a list row stands for. Real ids win; a synthetic "#index" id (script saved without an id)
// only resolves when that slot still carries the same name, so a list that shifted meanwhile is refused.
export function locateRegexScript(list, { id, name } = {}) {
  if (!Array.isArray(list) || !text(id)) return -1;
  const byId = list.findIndex(script => text(script?.id) === id);
  if (byId >= 0) return byId;
  const slot = /^#(\d+)$/.exec(id);
  if (!slot) return -1;
  const index = Number(slot[1]);
  return index < list.length && !text(list[index]?.id) && summarizeRegexScript(list[index], index).name === name ? index : -1;
}

const stale = () => new Error('这条正则已在别处被修改或移除，列表已刷新，请重试');

// Writes one script's on/off state back to ST. Resolves to the script's new `enabled`.
export async function writeRegexToggle(context, { source, id, name, enabled } = {}) {
  const ctx = context && typeof context === 'object' ? context : {};
  const disabled = enabled !== true;
  if (source === 'global') {
    const list = attempt(() => ctx.extensionSettings?.regex, undefined);
    if (!Array.isArray(list) || typeof ctx.saveSettingsDebounced !== 'function') throw new Error('当前 ST 不支持在此修改全局正则');
    const index = locateRegexScript(list, { id, name });
    if (index < 0) throw stale();
    list[index].disabled = disabled;
    ctx.saveSettingsDebounced();
    return !disabled;
  }
  if (source === 'preset') {
    const manager = presetManager(ctx);
    if (typeof manager?.readPresetExtensionField !== 'function' || typeof manager?.writePresetExtensionField !== 'function') throw new Error('当前 ST 不支持在此修改预设正则');
    const list = manager.readPresetExtensionField({ path: 'regex_scripts' });
    const index = locateRegexScript(list, { id, name });
    if (index < 0) throw stale();
    const value = list.map((script, i) => (i === index ? { ...script, disabled } : script));
    await manager.writePresetExtensionField({ path: 'regex_scripts', value });
    return !disabled;
  }
  throw new Error('未知的正则来源');
}

// Quiet window before the chat reload, so flipping several switches in a row re-renders the chat once.
export const REGEX_RELOAD_DELAY = 700;

export function createChatRegex({ getContext = () => ({}), notify = () => {},
  canReload = () => true, timers = { set: (fn, ms) => setTimeout(fn, ms), clear: id => clearTimeout(id) },
  loadView = () => import('./qianmu-chat-regex-view.js?v=1.59.499') } = {}) {
  let mounted = null, disposed = false, view = 'order', reloadTimer = null, reloadPending = false;
  const pending = new Set();
  const context = () => attempt(() => getContext(), {});
  const state = () => Object.freeze({ view, pending: Object.freeze([...pending]), sources: readRegexSources(context()) });
  const refresh = () => mounted?.view?.render(state());

  // ST re-applies display regexes only when messages are rendered again, exactly like its own panel does
  // after a toggle. Never reload mid-generation: wait until the host is idle.
  function scheduleReload(delay = REGEX_RELOAD_DELAY) {
    reloadPending = true;
    if (reloadTimer !== null) timers.clear(reloadTimer);
    reloadTimer = timers.set(() => { reloadTimer = null; void flushReload(); }, delay);
  }
  async function flushReload() {
    if (!reloadPending || disposed) return;
    if (reloadTimer !== null) { timers.clear(reloadTimer); reloadTimer = null; }
    if (attempt(() => canReload(), true) === false) { scheduleReload(REGEX_RELOAD_DELAY * 2); return; }
    reloadPending = false;
    const ctx = context();
    const chatId = attempt(() => (typeof ctx.getCurrentChatId === 'function' ? ctx.getCurrentChatId() : ctx.chatId), null);
    if (!chatId || typeof ctx.reloadCurrentChat !== 'function') return;
    try { await ctx.reloadCurrentChat(); } catch (error) { notify(error?.message || '聊天重载失败，正则改动将在下次进入聊天时生效', 'warning'); }
  }

  async function toggle({ source, id, name, enabled } = {}) {
    const key = `${source}:${id}`;
    if (pending.has(key)) return null;
    pending.add(key); refresh();
    try {
      const next = await writeRegexToggle(context(), { source, id, name, enabled });
      scheduleReload();
      return next;
    } catch (error) {
      notify(error?.message || '正则开关写回失败', 'warning');
      return null;
    } finally {
      pending.delete(key); refresh();
    }
  }
  const actions = Object.freeze({
    views: REGEX_VIEWS,
    placements: REGEX_PLACEMENTS,
    group: groupRegexScripts,
    setView(next) { view = REGEX_VIEWS.includes(next) ? next : 'order'; refresh(); },
    reload() { refresh(); },
    toggle,
  });
  async function mount(host) {
    if (!host) return;
    if (mounted?.host === host) { refresh(); return; }
    unmount(); disposed = false;
    const token = {}; mounted = { host, token, view: null };
    const module = await loadView();
    if (disposed || mounted?.token !== token || !host.isConnected) return;
    mounted.view = module.mountChatRegexView({ root: host, actions, notify });
    refresh();
  }
  // Closing the toolkit applies a pending reload right away instead of waiting out the quiet window.
  function unmount() { mounted?.view?.dispose?.(); mounted = null; if (reloadPending && reloadTimer !== null) void flushReload(); }
  function dispose() {
    disposed = true; reloadPending = false;
    if (reloadTimer !== null) { timers.clear(reloadTimer); reloadTimer = null; }
    unmount();
  }
  return Object.freeze({ mount, unmount, dispose, actions, state });
}
