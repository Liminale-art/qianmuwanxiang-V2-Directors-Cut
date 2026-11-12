// Regex tab of the chat toolkit (D-a: read-only skeleton).
// Lists SillyTavern's global regex scripts and the current preset's regex scripts, in original order or
// auto-grouped by name prefix. Nothing here writes back to ST: toggling, bulk switches, locating and the
// recycle bin are later slices. Every host read is capability-probed so an older ST degrades to a notice.

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

// Read-only snapshot of the two sources. `available:false` means this ST build lacks the capability.
export function readRegexSources(context) {
  const ctx = context && typeof context === 'object' ? context : {};
  const globalRaw = attempt(() => ctx.extensionSettings?.regex, undefined);
  const global = Object.freeze({ available: Array.isArray(globalRaw), items: Object.freeze(summarizeList(globalRaw)) });
  const manager = attempt(() => (typeof ctx.getPresetManager === 'function' ? ctx.getPresetManager() : null), null);
  const canRead = typeof manager?.readPresetExtensionField === 'function';
  if (!canRead) return Object.freeze({ global, preset: Object.freeze({ available: false, name: '', allowed: false, items: Object.freeze([]) }) });
  const presetRaw = attempt(() => manager.readPresetExtensionField({ path: 'regex_scripts' }), []);
  const name = text(attempt(() => manager.getSelectedPresetName?.(), ''));
  const apiId = text(attempt(() => manager.apiId, '')) || 'openai';
  const allowList = attempt(() => ctx.extensionSettings?.preset_allowed_regex?.[apiId], null);
  const allowed = Array.isArray(allowList) && !!name && allowList.includes(name);
  return Object.freeze({ global, preset: Object.freeze({ available: true, name, allowed, items: Object.freeze(summarizeList(presetRaw)) }) });
}

export function createChatRegex({ getContext = () => ({}), notify = () => {},
  loadView = () => import('./qianmu-chat-regex-view.js?v=1.59.496') } = {}) {
  let mounted = null, disposed = false, view = 'order';
  const state = () => Object.freeze({ view, sources: readRegexSources(attempt(() => getContext(), {})) });
  const refresh = () => mounted?.view?.render(state());
  const actions = Object.freeze({
    views: REGEX_VIEWS,
    placements: REGEX_PLACEMENTS,
    group: groupRegexScripts,
    setView(next) { view = REGEX_VIEWS.includes(next) ? next : 'order'; refresh(); },
    reload() { refresh(); },
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
  function unmount() { mounted?.view?.dispose?.(); mounted = null; }
  function dispose() { disposed = true; unmount(); }
  return Object.freeze({ mount, unmount, dispose, actions, state });
}
