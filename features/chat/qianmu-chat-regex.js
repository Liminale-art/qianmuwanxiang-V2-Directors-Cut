// Regex tab of the chat toolkit (D-a list + D-b single toggle + C-11 batch toggle).
// Lists SillyTavern's global regex scripts and the current preset's regex scripts, in original order or
// auto-grouped by name prefix. A single script can be switched on/off and is written back the way ST's own
// regex panel does it (global: extension settings + saveSettingsDebounced; preset: writePresetExtensionField),
// then the open chat is reloaded once so already-rendered messages pick up the change. A batch (a whole
// section or group) is written the same way in one save. Locating and the recycle bin are later slices. Every host call is capability-probed: a source whose write
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

// Locates every change first and refuses the whole batch if any row went stale, so a batch never half-applies.
function locateAll(list, changes) {
  const slots = new Map();
  for (const change of changes) {
    const index = locateRegexScript(list, change);
    if (index < 0) throw stale();
    slots.set(index, change.enabled !== true);
  }
  return slots;
}

// Writes the on/off state of one or more scripts of one source back to ST in a single save.
// Resolves to the number of scripts whose state actually changed.
export async function writeRegexStates(context, { source, changes } = {}) {
  const ctx = context && typeof context === 'object' ? context : {};
  const batch = (Array.isArray(changes) ? changes : []).filter(change => change && text(change.id));
  if (source === 'global') {
    const list = attempt(() => ctx.extensionSettings?.regex, undefined);
    if (!Array.isArray(list) || typeof ctx.saveSettingsDebounced !== 'function') throw new Error('当前 ST 不支持在此修改全局正则');
    const slots = locateAll(list, batch);
    let changed = 0;
    for (const [index, disabled] of slots) if ((list[index].disabled === true) !== disabled) { list[index].disabled = disabled; changed += 1; }
    if (changed) ctx.saveSettingsDebounced();
    return changed;
  }
  if (source === 'preset') {
    const manager = presetManager(ctx);
    if (typeof manager?.readPresetExtensionField !== 'function' || typeof manager?.writePresetExtensionField !== 'function') throw new Error('当前 ST 不支持在此修改预设正则');
    const list = manager.readPresetExtensionField({ path: 'regex_scripts' });
    const slots = locateAll(list, batch);
    let changed = 0;
    const value = list.map((script, i) => {
      if (!slots.has(i) || (script?.disabled === true) === slots.get(i)) return script;
      changed += 1; return { ...script, disabled: slots.get(i) };
    });
    if (changed) await manager.writePresetExtensionField({ path: 'regex_scripts', value });
    return changed;
  }
  throw new Error('未知的正则来源');
}

// Writes one script's on/off state back to ST. Resolves to the script's new `enabled`.
export async function writeRegexToggle(context, { source, id, name, enabled } = {}) {
  await writeRegexStates(context, { source, changes: [{ id, name, enabled: enabled === true }] });
  return enabled === true;
}

// ── C-11d：正则绑定聊天 ──────────────────────────────────────────────────────
// ST 的正则 disabled 是全局/预设级、写盘的，直接按聊天改会泄漏到别的聊天。于是用「全局默认 + 每聊天覆盖」：
// 进聊天时把 默认 ⊕ 本聊天 overrides 解析成每条脚本的目标态，与 live flags 逐条比较，只写差异，
// 且仅当被改脚本影响显示（非「仅提示词」）时才需要重载聊天。离开有覆盖的聊天后，默认值把未被覆盖的条目复位，
// 避免一个聊天的开关泄漏到下一个聊天。只绑定有真实 id 的脚本；synthetic「#index」行不可绑定（重排会指错）。

// 绑定 key：全局按 id，预设按「预设名 + id」，预设换名后旧覆盖自然失配（安全空转）。
const BINDING_SOURCES = Object.freeze(['global', 'preset']);
const isRealId = id => text(id) && !/^#\d+$/.test(text(id));
export function regexBindingKey(source, presetName, id) {
  if (source === 'global') return `global:${text(id)}`;
  if (source === 'preset') return `preset:${text(presetName)}:${text(id)}`;
  return '';
}

// 把 readRegexSources 的快照摊平成 [{source, key, id, name, enabled, display}]，只含可写且有真实 id 的脚本。
function flattenBindableScripts(sources) {
  const snap = sources && typeof sources === 'object' ? sources : {};
  const rows = [];
  for (const source of BINDING_SOURCES) {
    const bucket = snap[source];
    if (!bucket || bucket.writable !== true || !Array.isArray(bucket.items)) continue;
    const presetName = source === 'preset' ? bucket.name : '';
    for (const item of bucket.items) {
      if (!isRealId(item?.id)) continue;
      rows.push({ source, key: regexBindingKey(source, presetName, item.id), id: item.id, name: item.name,
        enabled: item.enabled === true, display: item.scope !== '仅提示词' });
    }
  }
  return rows;
}

// 纯函数：给定全局默认绑定、本聊天覆盖绑定、当前 live 快照，算出应写回的差异。
// 目标态优先级：本聊天覆盖 > 全局默认 > 维持现状（不写）。返回 { changes:{global:[],preset:[]}, affectsDisplay }。
export function resolveRegexTarget({ defaults = {}, overrides = {}, sources = {} } = {}) {
  const base = defaults && typeof defaults === 'object' ? defaults : {};
  const over = overrides && typeof overrides === 'object' ? overrides : {};
  const changes = { global: [], preset: [] };
  let affectsDisplay = false;
  for (const row of flattenBindableScripts(sources)) {
    const pick = Object.prototype.hasOwnProperty.call(over, row.key) ? over[row.key]
      : Object.prototype.hasOwnProperty.call(base, row.key) ? base[row.key] : null;
    if (!pick || typeof pick !== 'object') continue;        // 两处都没有 → 维持现状
    const target = pick.enabled === true;
    if (target === row.enabled) continue;                   // 已是目标态 → 不写
    changes[row.source].push({ id: row.id, name: row.name, enabled: target });
    if (row.display) affectsDisplay = true;
  }
  return Object.freeze({ changes: Object.freeze({ global: Object.freeze(changes.global), preset: Object.freeze(changes.preset) }), affectsDisplay });
}

// Quiet window before the chat reload, so flipping several switches in a row re-renders the chat once.
export const REGEX_RELOAD_DELAY = 700;

export function createChatRegex({ getContext = () => ({}), notify = () => {},
  canReload = () => true, timers = { set: (fn, ms) => setTimeout(fn, ms), clear: id => clearTimeout(id) },
  // C-11d 绑定存取（默认空操作 → 未接线时整套绑定完全惰性，不写 ST）：
  // readBinding 读本聊天覆盖（只读，无副作用）；writeBinding 持久化本聊天覆盖；
  // readDefaults 读全局默认基线；writeDefaults 持久化全局默认（首次为某条建覆盖时抓当前 live 态作基线，保证离开聊天能复位不泄漏）。
  readBinding = () => ({ enabled: false, overrides: {} }), writeBinding = () => {},
  readDefaults = () => ({}), writeDefaults = () => {},
  loadView = () => import('./qianmu-chat-regex-view.js?v=1.59.499') } = {}) {
  let mounted = null, disposed = false, view = 'order', reloadTimer = null, reloadPending = false, applying = false;
  const pending = new Set();
  const context = () => attempt(() => getContext(), {});
  const readOverrides = () => { const b = attempt(() => readBinding(), {}); return b && typeof b === 'object' && b.overrides && typeof b.overrides === 'object' ? b.overrides : {}; };
  const bindingEnabled = () => attempt(() => readBinding(), {})?.enabled === true;
  const state = () => Object.freeze({ view, pending: Object.freeze([...pending]),
    binding: Object.freeze({ enabled: bindingEnabled(), overrides: Object.freeze({ ...readOverrides() }) }),
    sources: readRegexSources(context()) });
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

  // 进聊天时把 全局默认 ⊕ 本聊天覆盖 套用到 live 正则：逐条比较只写差异，仅显示类改动才重载。
  // reloadCurrentChat 会再触发 chatChanged→applyBinding，但第二次比较已无差异即停，天然幂等不成环。
  async function applyBinding() {
    if (disposed || applying) return 0;
    if (!bindingEnabled()) return 0;
    const chatId = attempt(() => { const ctx = context(); return typeof ctx.getCurrentChatId === 'function' ? ctx.getCurrentChatId() : ctx.chatId; }, null);
    if (!chatId) return 0;                                   // 欢迎屏/无聊天：不动
    const plan = resolveRegexTarget({ defaults: attempt(() => readDefaults(), {}), overrides: readOverrides(), sources: readRegexSources(context()) });
    const total = plan.changes.global.length + plan.changes.preset.length;
    if (!total) { refresh(); return 0; }
    applying = true;
    let changed = 0;
    try {
      for (const source of BINDING_SOURCES) {
        if (!plan.changes[source].length) continue;
        changed += await writeRegexStates(context(), { source, changes: plan.changes[source] }) || 0;
      }
    } catch (error) {
      notify(error?.message || '正则绑定套用失败', 'warning');
    } finally {
      applying = false;
    }
    if (changed && plan.affectsDisplay) scheduleReload();
    refresh();
    return changed;
  }

  async function toggle({ source, id, name, enabled } = {}) {
    const key = `${source}:${id}`;
    if (pending.has(key)) return null;
    pending.add(key); refresh();
    try {
      const next = await writeRegexToggle(context(), { source, id, name, enabled });
      // 「懒人」绑定：开着绑定时，用户在本聊天随手拨动开关 = 记住这条。基线抓拨动前的态，其它聊天据此复位。
      if (bindingEnabled() && isRealId(id)) setBindingOverride({ key, enabled: enabled === true, liveEnabled: enabled !== true });
      scheduleReload();
      return next;
    } catch (error) {
      notify(error?.message || '正则开关写回失败', 'warning');
      return null;
    } finally {
      pending.delete(key); refresh();
    }
  }
  // Switches a whole section or group of one source in one write and one reload. Rows already in the wanted
  // state are skipped; a row being written elsewhere blocks the batch instead of racing it.
  async function toggleMany({ source, items, enabled } = {}) {
    const changes = (Array.isArray(items) ? items : []).filter(item => item && text(item.id) && item.enabled !== (enabled === true))
      .map(item => ({ id: item.id, name: item.name, enabled: enabled === true }));
    const keys = changes.map(change => `${source}:${change.id}`);
    if (!changes.length || keys.some(key => pending.has(key))) return 0;
    keys.forEach(key => pending.add(key)); refresh();
    try {
      const changed = await writeRegexStates(context(), { source, changes });
      if (bindingEnabled()) for (const change of changes) if (isRealId(change.id)) setBindingOverride({ key: `${source}:${change.id}`, enabled: change.enabled, liveEnabled: !change.enabled });
      if (changed) scheduleReload();
      return changed;
    } catch (error) {
      notify(error?.message || '正则批量开关写回失败', 'warning');
      return null;
    } finally {
      keys.forEach(key => pending.delete(key)); refresh();
    }
  }
  // 当某条脚本首次纳入绑定时，把它当前的 live 态写入全局默认基线——这样别的聊天不覆盖它时会复位到基线，
  // 而不是停留在上一个聊天改出来的态，根治「一个聊天的开关泄漏到下一个聊天」。
  function ensureDefault(key, liveEnabled) {
    const defaults = attempt(() => readDefaults(), {}) || {};
    if (Object.prototype.hasOwnProperty.call(defaults, key)) return;
    writeDefaults({ ...defaults, [key]: { enabled: liveEnabled === true } });
  }
  // 开/关「绑定此聊天」总开关。打开后立即套用一次。
  async function setBindingEnabled(on) {
    const b = attempt(() => readBinding(), {}) || {};
    writeBinding({ enabled: on === true, overrides: b.overrides && typeof b.overrides === 'object' ? b.overrides : {} });
    refresh();
    if (on === true) await applyBinding(); else refresh();
  }
  // 把某条脚本纳入/移出本聊天覆盖；纳入时同时确保它在全局默认里有基线。
  function setBindingOverride({ key, enabled, liveEnabled } = {}) {
    if (!text(key)) return;
    ensureDefault(key, liveEnabled);
    const b = attempt(() => readBinding(), {}) || {};
    const overrides = { ...(b.overrides && typeof b.overrides === 'object' ? b.overrides : {}) };
    overrides[key] = { enabled: enabled === true };
    writeBinding({ enabled: b.enabled === true, overrides });
    refresh();
  }
  function clearBindingOverride(key) {
    if (!text(key)) return;
    const b = attempt(() => readBinding(), {}) || {};
    if (!b.overrides || typeof b.overrides !== 'object' || !Object.prototype.hasOwnProperty.call(b.overrides, key)) return;
    const overrides = { ...b.overrides }; delete overrides[key];
    writeBinding({ enabled: b.enabled === true, overrides });
    refresh();
  }
  const actions = Object.freeze({
    views: REGEX_VIEWS,
    placements: REGEX_PLACEMENTS,
    group: groupRegexScripts,
    bindingKey: regexBindingKey,
    setView(next) { view = REGEX_VIEWS.includes(next) ? next : 'order'; refresh(); },
    reload() { refresh(); },
    toggle,
    toggleMany,
    setBindingEnabled,
    setBindingOverride,
    clearBindingOverride,
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
  // 进聊天钩子：index.js 把 CHAT_CHANGED / appReady 接到这里，自动套用本聊天绑定。
  const events = Object.freeze({ chatChanged: () => { void applyBinding(); } });
  return Object.freeze({ mount, unmount, dispose, actions, state, applyBinding, events });
}
