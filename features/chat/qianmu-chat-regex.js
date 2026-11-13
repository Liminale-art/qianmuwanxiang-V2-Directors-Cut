// Regex tab of the chat toolkit (D-a list + D-b single toggle + C-11 batch toggle + C-12 preset quick switch).
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

// C-15 s9：单一模式「原始顺序 + 相邻同类折叠」——永不重排（显示顺序 = 执行顺序），只把相邻同类折成一段。
// 【X】/[X] 标签 = 显式分组（手动命名写的就是它），优先于一切自动规则；否则剥掉互斥标记（(A选一)、B选一、二选一…）
// 与尾部序号（-1、(2)、①②…），再按相邻两条的「相同核心 / 相同分隔前缀 / 共同前缀≥2 / 共同尾词≥2」成段。
const EXCLUSIVE_MARK = /^\s*[（(]?\s*[A-Za-zＡ-Ｚ一二三四五六七八九十多]\s*选\s*[一1壹]\s*[）)]?[-_·:：|｜/\s]*/u;
const EXCLUSIVE_TAIL = /[-_·:：|｜/\s]*[（(]\s*[A-Za-zＡ-Ｚ一二三四五六七八九十多]\s*选\s*[一1壹]\s*[）)]\s*$/u;
const CIRCLED_TAIL = /[\s\-_]*[①-⑳❶-❿⓫-⓴]+\s*$/u;
const EDGE_JUNK = /[-_·:：|｜/\s（()）【】[\]]/u;
const WORDY = /[A-Za-z0-9]/;

export function regexFamilyKey(name) {
  const raw = text(name);
  const bracket = raw.match(LEAD_BRACKET);
  const tag = bracket?.[1]?.trim() || '';
  let core = (tag ? raw.slice(bracket[0].length) : raw).replace(EXCLUSIVE_MARK, '').replace(EXCLUSIVE_TAIL, '');
  for (let i = 0; i < 3; i += 1) {
    const next = stripOrdinal(core.replace(CIRCLED_TAIL, ''));
    if (next === core) break;
    core = next;
  }
  core = core.trim() || raw;
  const cut = core.search(SEPARATOR);
  return Object.freeze({ tag, core, head: cut > 0 ? core.slice(0, cut).trim() : '' });
}

// 两串的共同前缀（fromEnd=共同尾巴），去掉边缘分隔/括号；拉丁词不在词中间截断；需 ≥2 字且含文字，否则返回空。
function sharedEdge(a, b, fromEnd) {
  const x = fromEnd ? [...a].reverse() : [...a], y = fromEnd ? [...b].reverse() : [...b];
  let n = 0;
  while (n < x.length && n < y.length && x[n] === y[n]) n += 1;
  if (n > 0 && WORDY.test(x[n - 1]) && ((n < x.length && WORDY.test(x[n])) || (n < y.length && WORDY.test(y[n])))) {
    while (n > 0 && WORDY.test(x[n - 1])) n -= 1;
  }
  const part = x.slice(0, n);
  while (part.length && EDGE_JUNK.test(part[part.length - 1])) part.pop();
  if (fromEnd) part.reverse();
  while (part.length && EDGE_JUNK.test(part[0])) part.shift();
  return part.length >= 2 && /\p{L}/u.test(part.join('')) ? part.join('') : '';
}

function pairFamily(a, b) {
  if (a.tag || b.tag) return a.tag && a.tag === b.tag ? { mode: 'tag', label: a.tag } : null;
  if (a.core === b.core) return { mode: 'prefix', label: a.core };
  if (a.head && a.head === b.head) return { mode: 'prefix', label: a.head };
  const pre = sharedEdge(a.core, b.core, false);
  if (pre) return { mode: 'prefix', label: pre };
  const suf = sharedEdge(a.core, b.core, true);
  return suf ? { mode: 'suffix', label: suf } : null;
}

// 段已定类别后，下一条能否并入；能则返回（可能收窄的）新标签。
function extendFamily(run, f) {
  if (run.mode === 'tag') return f.tag === run.label ? run.label : '';
  if (f.tag) return '';
  if (f.core === run.label || f.head === run.label) return run.label;
  return sharedEdge(run.label, f.core, run.mode === 'suffix');
}

// 段：{ key, label, mode, items }。成组段 label 非空、≥2 条；散条连续合为一个 label 为空的段。
// key 在同名段重复出现时带 #n，供折叠状态区分；拼回所有段的 items 恰为原列表。
export function groupAdjacentRegex(items) {
  const list = Array.isArray(items) ? items : [];
  const fams = list.map(item => regexFamilyKey(item?.name));
  const out = [], seen = new Map();
  let loose = null;
  for (let i = 0; i < list.length;) {
    const pair = i + 1 < list.length ? pairFamily(fams[i], fams[i + 1]) : null;
    if (!pair) {
      if (!loose) { loose = { key: '', label: '', mode: '', items: [] }; out.push(loose); }
      loose.items.push(list[i]); i += 1; continue;
    }
    loose = null;
    const run = { ...pair };
    let j = i + 2;
    for (; j < list.length; j += 1) { const next = extendFamily(run, fams[j]); if (!next) break; run.label = next; }
    const n = (seen.get(run.label) || 0) + 1; seen.set(run.label, n);
    out.push({ key: n > 1 ? `${run.label}#${n}` : run.label, label: run.label, mode: run.mode, items: list.slice(i, j) });
    i = j;
  }
  return out;
}

// 手动命名 = 写入开头的【标签】（替换已有标签），不改名字正文；tag 为空 = 去掉标签。
export function tagRegexName(name, tag) {
  const raw = text(name), dest = text(tag).replace(/[【】[\]]/gu, '').trim();
  const bracket = raw.match(LEAD_BRACKET);
  const body = bracket ? raw.slice(bracket[0].length).trim() : raw;
  if (!dest) return body || raw;
  return `【${dest}】${body}`;
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

// ── C-14f：条目管理（删除 / 复制 / 拖动排序 / 新建 / 编辑 / 分组）──────────────────────────────────
// 与开关走同一条写回路径：读 ST 原始数组 → 在副本上改 → 全局就地换内容（保住 ST 持有的数组引用）+ saveSettingsDebounced；
// 预设写一份新数组经 writePresetExtensionField。定位一律走 locateRegexScript，任何一条失效整批拒绝，绝不半写。
const SEPARATOR_RUN = /^[-_·:：|｜/\s]+/u;
const newRegexId = () => attempt(() => globalThis.crypto.randomUUID(), '') || `qm-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

// 与 ST 原生「新建正则」同一组字段；作用位置默认 AI 输出。
export function blankRegexScript(patch = {}) {
  return { id: newRegexId(), scriptName: '', findRegex: '', replaceString: '', trimStrings: [], placement: [2], disabled: false,
    markdownOnly: false, promptOnly: false, runOnEdit: true, substituteRegex: 0, minDepth: null, maxDepth: null, ...patch };
}

// 纯函数：按下标删除，返回新数组 + 被删条目（含原下标，供撤销按原位插回）。
export function removeRegexEntries(list, indices) {
  const drop = new Set(indices);
  const removed = [...drop].sort((a, b) => a - b).map(index => ({ index, script: list[index] }));
  return { next: list.filter((_, i) => !drop.has(i)), removed };
}

// 纯函数：把被删条目按原下标插回（升序插，下标即最终位置）；已有同 id 的跳过，避免重复。
export function restoreRegexEntries(list, removed) {
  const next = [...list];
  const ids = new Set(next.map(script => text(script?.id)).filter(Boolean));
  for (const { index, script } of [...removed].sort((a, b) => a.index - b.index)) {
    if (text(script?.id) && ids.has(text(script.id))) continue;
    next.splice(Math.min(index, next.length), 0, script);
  }
  return next;
}

// 纯函数：副本换新 id、名字加后缀；copyRegexEntries 让每条副本紧跟在原条目后。
export function cloneRegexScript(script, { makeId = newRegexId, suffix = ' 副本' } = {}) {
  const copy = structuredClone(script && typeof script === 'object' ? script : {});
  copy.id = makeId();
  copy.scriptName = `${text(script?.scriptName) || '（未命名）'}${suffix}`;
  return copy;
}
export function copyRegexEntries(list, indices, options = {}) {
  const pick = new Set(indices);
  const next = [];
  list.forEach((script, i) => { next.push(script); if (pick.has(i)) next.push(cloneRegexScript(script, options)); });
  return next;
}

// 纯函数：把选中的条目（保持相对顺序）整体移到原数组下标 to 之前（to = list.length 即末尾）。
export function moveRegexEntries(list, indices, to) {
  const pick = new Set(indices);
  const moving = list.filter((_, i) => pick.has(i));
  const rest = list.filter((_, i) => !pick.has(i));
  const before = list.slice(0, Math.max(0, Math.min(Number(to) || 0, list.length))).filter((_, i) => !pick.has(i)).length;
  rest.splice(before, 0, ...moving);
  return rest;
}

// 纯函数：分组由名字前缀自动得出，所以「改分组」就是改名字前缀。from 为原组名（未分组为空）。
// 【旧】→【新】，或开头旧前缀换成新前缀；to 为空 = 移出分组（去掉前缀与紧随的分隔符）；未分组条目加「新-」前缀。
export function assignRegexGroup(name, { from = '', to = '' } = {}) {
  const raw = text(name), src = text(from), dest = text(to);
  if (!src) return dest ? `${dest}-${raw}` : raw;
  const bracket = raw.match(LEAD_BRACKET);
  if (bracket && bracket[1].trim() === src) {
    const rest = raw.slice(bracket[0].length);
    return dest ? `【${dest}】${rest}` : (rest.replace(SEPARATOR_RUN, '') || raw);
  }
  if (raw.startsWith(src)) {
    const rest = raw.slice(src.length);
    return dest ? `${dest}${rest}` : (rest.replace(SEPARATOR_RUN, '') || raw);
  }
  return raw;
}

function readRawList(ctx, source) {
  if (source === 'global') {
    const list = attempt(() => ctx.extensionSettings?.regex, undefined);
    if (!Array.isArray(list) || typeof ctx.saveSettingsDebounced !== 'function') throw new Error('当前 ST 不支持在此修改全局正则');
    return list;
  }
  if (source === 'preset') {
    const manager = presetManager(ctx);
    if (typeof manager?.readPresetExtensionField !== 'function' || typeof manager?.writePresetExtensionField !== 'function') throw new Error('当前 ST 不支持在此修改预设正则');
    const list = manager.readPresetExtensionField({ path: 'regex_scripts' });
    return Array.isArray(list) ? list : [];
  }
  throw new Error('未知的正则来源');
}
async function writeRawList(ctx, source, next) {
  if (source === 'global') {
    const list = ctx.extensionSettings.regex;
    list.splice(0, list.length, ...next);
    ctx.saveSettingsDebounced();
    return;
  }
  await presetManager(ctx).writePresetExtensionField({ path: 'regex_scripts', value: next });
}
// 改动是否影响已显示楼层：涉及任一启用中、非「仅提示词」的脚本才需要重载。
const touchesDisplay = scripts => scripts.some(script => script && script.disabled !== true && script.promptOnly !== true);

// 读 → 改 → 写，一个来源一次保存。mutate(list) 返回 { next, touched, result }，next 为空表示无改动、不写盘。
export async function editRegexList(context, source, mutate) {
  const ctx = context && typeof context === 'object' ? context : {};
  const list = readRawList(ctx, source);
  const out = mutate(list) || {};
  if (!out.next) return { changed: false, reload: false, result: out.result };
  await writeRawList(ctx, source, out.next);
  return { changed: true, reload: touchesDisplay(out.touched || []), result: out.result };
}
const locateIndices = (list, items) => [...locateAll(list, items.map(item => ({ ...item, enabled: true }))).keys()];

// 编辑子页的「测试」：与 ST 引擎同一套替换语义的纯函数预览——"/pat/flags" 或纯文本模式，
// {{match}} 即 $0，$1 / $<名> 取捕获组且先按「修剪掉」逐条剔除。不展开宏（预览只看正则本身）。
export function parseRegexLiteral(source) {
  const raw = typeof source === 'string' ? source : '';
  if (!raw) return null;
  const literal = /^\/([\s\S]+)\/([dgimsuvy]*)$/.exec(raw);
  try { return literal ? new RegExp(literal[1], literal[2]) : new RegExp(raw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')); }
  catch (_) { return null; }
}
export function previewRegexScript({ findRegex = '', replaceString = '', trimStrings = [] } = {}, input = '') {
  const pattern = parseRegexLiteral(findRegex);
  if (!pattern) return { ok: !findRegex, output: String(input), error: findRegex ? '查找正则无效' : '' };
  const trims = (Array.isArray(trimStrings) ? trimStrings : []).filter(Boolean);
  const trim = value => trims.reduce((out, cut) => out.split(cut).join(''), String(value ?? ''));
  const template = String(replaceString).replace(/{{match}}/gi, '$0');
  const output = String(input).replace(pattern, (...args) => {
    const hasGroups = typeof args.at(-1) === 'object' && args.at(-1) !== null;
    const groups = hasGroups ? args.at(-1) : {};
    const captures = args.slice(0, hasGroups ? -3 : -2);
    return template.replace(/\$(\d+)|\$<([^>]+)>/g, (_, num, name) => trim(num !== undefined ? captures[Number(num)] : groups?.[name]));
  });
  return { ok: true, output, error: '' };
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

// ── C-12：预设绑定 + 聊天内预设快切 ──────────────────────────────────────────────
// 只记预设「名字」、不分 API：用当前 API 的原生 PresetManager 查名切换（findPreset + selectPreset，
// 与在 ST 原生下拉里点选同一路径），预设内容与保存都交给 ST，千幕不旁路写盘。
// ST 自带的「按角色名自动选预设」同挂 CHAT_CHANGED 且注册更早，千幕后执行，故用户显式绑定天然优先。
const canSwitchPresets = manager => ['getAllPresets', 'getSelectedPresetName', 'findPreset', 'selectPreset']
  .every(name => typeof manager?.[name] === 'function');

// 当前 API 下的预设名单与选中项；available:false 表示此 ST 不支持在此快切。
export function readPresetChoices(context) {
  const ctx = context && typeof context === 'object' ? context : {};
  const manager = presetManager(ctx);
  if (!canSwitchPresets(manager)) return Object.freeze({ available: false, current: '', names: Object.freeze([]) });
  const raw = attempt(() => manager.getAllPresets(), []);
  const names = [...new Set((Array.isArray(raw) ? raw : []).map(text).filter(Boolean))];
  const current = text(attempt(() => manager.getSelectedPresetName(), ''));
  return Object.freeze({ available: true, current, names: Object.freeze(names) });
}

// 纯函数：本聊天绑定的预设名 vs 当前选中 → none（无绑定/已是它）| missing（预设已不存在）| switch。
export function resolvePresetTarget({ bound = '', current = '', names = [] } = {}) {
  const name = text(bound);
  if (!name || name === text(current)) return Object.freeze({ action: 'none', name });
  if (!(Array.isArray(names) ? names : []).includes(name)) return Object.freeze({ action: 'missing', name });
  return Object.freeze({ action: 'switch', name });
}

// 走原生选预设。新版 ST 的 selectPreset 在预设完全套用后才 resolve；旧版同步返回，await 一样成立。
export async function switchPreset(context, name) {
  const manager = presetManager(context && typeof context === 'object' ? context : {});
  if (!canSwitchPresets(manager)) throw new Error('当前 ST 不支持在此切换预设');
  const value = attempt(() => manager.findPreset(text(name)), undefined);
  if (value === undefined || value === null) throw new Error(`预设「${text(name)}」已不存在`);
  await manager.selectPreset(value);
  return true;
}

// 预设正则对已显示楼层的影响签名：仅在被允许运行时，取启用中的显示类脚本 id。
// 切预设前后签名不同才需要重载聊天，两个预设都没有显示类正则时不白白重载。
export function presetDisplaySignature(sources) {
  const preset = sources?.preset;
  if (!preset || preset.allowed !== true || !Array.isArray(preset.items)) return '';
  return preset.items.filter(item => item?.enabled === true && item.scope !== '仅提示词').map(item => item.id).join('\n');
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
  loadView = () => import('./qianmu-chat-regex-view.js?v=1.59.502') } = {}) {
  let mounted = null, disposed = false, view = 'order', reloadTimer = null, reloadPending = false, applying = false;
  let presetBusy = false, missingNoticed = '';
  const pending = new Set();
  const folded = new Set();   // C-14e：卡片/分组折叠态（card:global / group:preset:xx），跨页签保持
  // C-14f：管理态（多选 / 拖动 / 分组改名）、编辑子页目标、结构性写回中。都只活在本次会话。
  // C-15 s5：回收站——被删条目累积在内存里（刷新/重启即清空），可逐条或整批还原。
  // C-15 s7：拾取移动——拾起的条目（单条或整批同源选择）暂存在 picking，点插入位即落定；拖拽走同一条落定路径。
  let managing = false, editing = null, writing = false, recycleOpen = false;
  const removed = [];
  let picking = [];
  const selected = new Set();
  const context = () => attempt(() => getContext(), {});
  // 本聊天绑定的规范形：{ enabled, overrides, preset }。所有写入都在它之上打补丁，绝不丢掉其它字段。
  const currentBinding = () => {
    const b = attempt(() => readBinding(), {}) || {};
    return { enabled: b.enabled === true, overrides: b.overrides && typeof b.overrides === 'object' ? b.overrides : {}, preset: text(b.preset) };
  };
  const saveBinding = patch => {
    const next = { ...currentBinding(), ...patch };
    const value = { enabled: next.enabled === true, overrides: next.overrides };
    if (text(next.preset)) value.preset = text(next.preset);
    writeBinding(value);
  };
  const readOverrides = () => currentBinding().overrides;
  const bindingEnabled = () => currentBinding().enabled;
  const currentChatId = () => attempt(() => { const ctx = context(); return typeof ctx.getCurrentChatId === 'function' ? ctx.getCurrentChatId() : ctx.chatId; }, null);
  const state = () => {
    const b = currentBinding();
    return Object.freeze({ view, pending: Object.freeze([...pending]), folded: Object.freeze([...folded]),
      managing, writing, selected: Object.freeze([...selected]), editing: editing ? Object.freeze({ ...editing }) : null,
      // C-15 s7：拾取移动——拾起的条目（同源），视图据此显示插入位；空数组＝未拾取。
      picking: Object.freeze(picking.map(entry => Object.freeze({ ...entry }))),
      // C-15 s5：回收站。最近删除在前；每条带还原键。开着时视图改显「已删除」列表。
      recycle: Object.freeze({ open: recycleOpen, count: removed.length,
        items: Object.freeze([...removed].reverse().map(entry => Object.freeze({
          key: entry.key, source: entry.source, preset: entry.preset,
          name: text(entry.script?.scriptName) || '（未命名）' }))) }),
      binding: Object.freeze({ enabled: b.enabled, overrides: Object.freeze({ ...b.overrides }), preset: b.preset }),
      presets: Object.freeze({ ...readPresetChoices(context()), busy: presetBusy }),
      sources: readRegexSources(context()) });
  };
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

  // 切到指定预设（已是它则不动），返回 { switched, reload }：reload 仅当预设正则的显示签名前后不同。
  async function moveToPreset(name) {
    const choices = readPresetChoices(context());
    const target = resolvePresetTarget({ bound: name, current: choices.current, names: choices.names });
    if (!choices.available || target.action === 'none') return { switched: false, reload: false };
    if (target.action === 'missing') throw new Error(`预设「${target.name}」已不存在`);
    const before = presetDisplaySignature(readRegexSources(context()));
    await switchPreset(context(), target.name);
    return { switched: true, reload: before !== presetDisplaySignature(readRegexSources(context())) };
  }

  // 进聊天时先切到本聊天绑定的预设（预设正则的覆盖 key 带预设名，必须先切再算），
  // 再把 全局默认 ⊕ 本聊天覆盖 套用到 live 正则：逐条比较只写差异，仅显示类改动才重载。
  // reloadCurrentChat 会再触发 chatChanged→applyBinding，但第二次比较已无差异即停，天然幂等不成环。
  async function applyBinding() {
    if (disposed || applying) return 0;
    if (!bindingEnabled()) return 0;
    const chatId = currentChatId();
    if (!chatId) return 0;                                   // 欢迎屏/无聊天：不动
    applying = true;
    let changed = 0, reload = false;
    try {
      const bound = currentBinding().preset;
      try {
        const moved = await moveToPreset(bound);
        if (moved.switched) { changed += 1; reload = moved.reload; }
      } catch (error) {
        // 绑定的预设被删/改名：每个聊天只提示一次，跳过预设、正则照常套用。
        const notice = `${chatId}\n${bound}`;
        if (missingNoticed !== notice) { missingNoticed = notice; notify(`本聊天绑定的预设「${bound}」无法切换（${error?.message || '未知原因'}），已跳过`, 'warning'); }
      }
      const plan = resolveRegexTarget({ defaults: attempt(() => readDefaults(), {}), overrides: readOverrides(), sources: readRegexSources(context()) });
      let regexChanged = 0;
      try {
        for (const source of BINDING_SOURCES) {
          if (!plan.changes[source].length) continue;
          regexChanged += await writeRegexStates(context(), { source, changes: plan.changes[source] }) || 0;
        }
      } catch (error) {
        notify(error?.message || '正则绑定套用失败', 'warning');
      }
      changed += regexChanged;
      if (regexChanged && plan.affectsDisplay) reload = true;
    } finally {
      applying = false;
    }
    if (reload) scheduleReload();
    refresh();
    return changed;
  }

  // 聊天内预设快切：走原生切换；绑定开着时顺手记入本聊天，并补一次正则绑定（预设正则的覆盖随预设名走）。
  async function selectPreset(name) {
    const target = text(name);
    if (!target || presetBusy || disposed) return false;
    presetBusy = true; refresh();
    let reload = false;
    try {
      reload = (await moveToPreset(target)).reload;
      if (bindingEnabled()) {
        saveBinding({ preset: target });
        presetBusy = false;
        await applyBinding();
      }
      return true;
    } catch (error) {
      notify(error?.message || '预设切换失败', 'warning');
      return false;
    } finally {
      presetBusy = false;
      if (reload) scheduleReload();
      refresh();
    }
  }

  async function toggle({ source, id, name, enabled } = {}) {
    const key = `${source}:${id}`;
    if (pending.has(key) || writing) return null;
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
    if (!changes.length || writing || keys.some(key => pending.has(key))) return 0;
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
  // 开/关「绑定此聊天」总开关。打开时若本聊天还没记预设，就记下当前预设（懒人：开绑定 = 记住此刻的预设+正则），
  // 随后立即套用一次。关闭只停用，不清掉已记的预设与覆盖，再打开即恢复。
  async function setBindingEnabled(on) {
    const patch = { enabled: on === true };
    if (on === true && !currentBinding().preset) {
      const choices = readPresetChoices(context());
      if (choices.available && choices.current) patch.preset = choices.current;
    }
    saveBinding(patch);
    refresh();
    if (on === true) await applyBinding(); else refresh();
  }
  // 把某条脚本纳入/移出本聊天覆盖；纳入时同时确保它在全局默认里有基线。
  function setBindingOverride({ key, enabled, liveEnabled } = {}) {
    if (!text(key)) return;
    ensureDefault(key, liveEnabled);
    const overrides = { ...currentBinding().overrides };
    overrides[key] = { enabled: enabled === true };
    saveBinding({ overrides });
    refresh();
  }
  function clearBindingOverride(key) {
    if (!text(key)) return;
    const current = currentBinding().overrides;
    if (!Object.prototype.hasOwnProperty.call(current, key)) return;
    const overrides = { ...current }; delete overrides[key];
    saveBinding({ overrides });
    refresh();
  }
  // ── C-14f 条目管理 ──
  // 结构性写回一次只跑一个，且与开关写回互斥；成功后清掉已不存在的选择，按需排一次重载。
  async function structural(label, run) {
    if (writing || disposed || pending.size) return null;
    writing = true; refresh();
    try {
      const out = await run(context());
      if (out?.reload) scheduleReload();
      return out?.result ?? true;
    } catch (error) {
      notify(error?.message || `${label}失败`, 'warning');
      return null;
    } finally {
      writing = false;
      const live = readRegexSources(context());
      const keys = new Set(BINDING_SOURCES.flatMap(source => live[source].items.map(item => `${source}:${item.id}`)));
      for (const key of [...selected]) if (!keys.has(key)) selected.delete(key);
      refresh();
    }
  }
  const bySource = items => {
    const out = new Map();
    for (const item of Array.isArray(items) ? items : []) {
      if (!item || !BINDING_SOURCES.includes(item.source) || !text(item.id)) continue;
      if (!out.has(item.source)) out.set(item.source, []);
      out.get(item.source).push({ id: item.id, name: item.name, ...(item.from !== undefined ? { from: item.from } : {}) });
    }
    return out;
  };
  const presetNameNow = () => readRegexSources(context()).preset.name;
  // 编辑子页读原始字段（深拷贝，视图改不到 ST 的对象）。
  function readScript({ source, id, name } = {}) {
    try {
      const list = readRawList(context(), source);
      const index = locateRegexScript(list, { id, name });
      return index < 0 ? null : structuredClone(list[index]);
    } catch (_) { return null; }
  }
  // 删除：整批写回；被删条目逐条进回收站（含原下标），可逐条或整批还原。回收站是内存态，刷新/重启即清空。
  let removedSeq = 0;
  const removeMany = ({ items } = {}) => structural('删除正则', async ctx => {
    const staged = []; let reload = false, count = 0;
    for (const [source, list] of bySource(items)) {
      const out = await editRegexList(ctx, source, raw => {
        const { next, removed: gone } = removeRegexEntries(raw, locateIndices(raw, list));
        return { next, touched: gone.map(entry => entry.script), result: gone };
      });
      const preset = source === 'preset' ? presetNameNow() : '';
      for (const entry of out.result) staged.push({ key: `trash-${++removedSeq}`, source, preset, index: entry.index, script: entry.script });
      count += out.result.length; reload ||= out.reload;
    }
    if (count) { removed.push(...staged); notify(`已删除 ${count} 条正则，可在回收站还原`, 'success'); }
    return { reload, result: count };
  });
  // 还原：keys 省略＝全部还原；否则只还原指定条目。预设已切换则拒绝还原到别的预设里。还原成功的从回收站移除。
  const undoRemove = ({ keys } = {}) => structural('撤销删除', async ctx => {
    const pick = Array.isArray(keys) ? new Set(keys.map(String)) : null;
    const chosen = removed.filter(entry => !pick || pick.has(entry.key));
    if (!chosen.length) return { result: 0 };
    const batches = new Map();
    for (const entry of chosen) {
      if (entry.source === 'preset' && entry.preset !== presetNameNow()) throw new Error(`删除发生在预设「${entry.preset}」，切回该预设后再还原`);
      if (!batches.has(entry.source)) batches.set(entry.source, []);
      batches.get(entry.source).push(entry);
    }
    let reload = false, count = 0; const done = new Set();
    for (const [source, entries] of batches) {
      const out = await editRegexList(ctx, source, raw => ({ next: restoreRegexEntries(raw, entries), touched: entries.map(entry => entry.script) }));
      reload ||= out.reload; count += entries.length;
      for (const entry of entries) done.add(entry.key);
    }
    for (let i = removed.length - 1; i >= 0; i -= 1) if (done.has(removed[i].key)) removed.splice(i, 1);
    if (!removed.length) recycleOpen = false;
    return { reload, result: count };
  });
  function setRecycle(on) { recycleOpen = on === true && removed.length > 0; refresh(); }
  // 复制：to 省略或同源 = 原地复制（紧跟原条目、名字加「副本」）；to 为另一来源 = 原名复制到那一来源末尾。
  const copyMany = ({ items, to = '' } = {}) => structural('复制正则', async ctx => {
    let reload = false, count = 0;
    for (const [source, list] of bySource(items)) {
      if (!to || to === source) {
        const out = await editRegexList(ctx, source, raw => {
          const indices = locateIndices(raw, list);
          return { next: copyRegexEntries(raw, indices), touched: indices.map(i => raw[i]), result: indices.length };
        });
        reload ||= out.reload; count += out.result;
        continue;
      }
      const from = readRawList(ctx, source);
      const copies = locateIndices(from, list).map(i => cloneRegexScript(from[i], { suffix: '' }));
      const out = await editRegexList(ctx, to, raw => ({ next: [...raw, ...copies], touched: copies, result: copies.length }));
      reload ||= out.reload; count += out.result;
    }
    if (count) notify(`已复制 ${count} 条正则`, 'success');
    return { reload, result: count };
  });
  // 排序：把条目整体移到原始下标 to 之前（拖动与上移/下移都走这里）。
  const move = ({ source, items, to } = {}) => structural('调整顺序', ctx => editRegexList(ctx, source, raw => {
    const indices = locateIndices(raw, (Array.isArray(items) ? items : []).map(item => ({ id: item.id, name: item.name })));
    const next = moveRegexEntries(raw, indices, to);
    if (next.every((script, i) => script === raw[i])) return { next: null, result: false };
    return { next, touched: indices.map(i => raw[i]), result: true };
  }));
  // 上移/下移一格：按原始下标与相邻条目对调（管理态列表的无拖动兜底）。
  const moveRow = ({ source, item, dir } = {}) => structural('调整顺序', ctx => editRegexList(ctx, source, raw => {
    const index = locateRegexScript(raw, item);
    if (index < 0) throw stale();
    const swap = dir === 'up' ? index - 1 : index + 1;
    if (swap < 0 || swap >= raw.length) return { next: null, result: false };
    const next = [...raw]; [next[index], next[swap]] = [next[swap], next[index]];
    return { next, touched: [raw[index], raw[swap]], result: true };
  }));
  // C-15 s7：拾取移动。拾起同源的一条或整批（当前多选），视图据此显示插入位；再次拾取同一组＝取消。
  function pickMove({ source, items } = {}) {
    if (writing || disposed) return;
    const list = (Array.isArray(items) ? items : [])
      .filter(item => item && BINDING_SOURCES.includes(source) && text(item.id))
      .map(item => ({ source, id: text(item.id), name: text(item.name) }));
    const same = picking.length === list.length && list.length > 0
      && picking.every((p, i) => p.source === list[i].source && p.id === list[i].id);
    picking = same ? [] : list;
    refresh();
  }
  function cancelPick() { if (picking.length) { picking = []; refresh(); } }
  // 落定：把拾取（或拖拽传入）的同源条目移到目标条目 before 之前（before 省略＝移到末尾）；完成后清空拾取。
  // 目标位按 id 在原始数组里定位（跨「原始顺序 / 自动分组」两种视图都正确），拖拽与点插入走同一路径。
  const dropMove = ({ source, items, before = null } = {}) => {
    const chosen = (Array.isArray(items) && items.length ? items : picking).filter(item => item && item.source === source);
    picking = [];
    if (!chosen.length) { refresh(); return null; }
    const moving = chosen.map(item => ({ id: item.id, name: item.name }));
    return structural('调整顺序', ctx => editRegexList(ctx, source, raw => {
      const indices = locateIndices(raw, moving);
      const to = before && text(before.id)
        ? (() => { const at = locateRegexScript(raw, before); if (at < 0) throw stale(); return at; })()
        : raw.length;
      const next = moveRegexEntries(raw, indices, to);
      if (next.every((script, i) => script === raw[i])) return { next: null, result: false };
      return { next, touched: indices.map(i => raw[i]), result: true };
    }));
  };
  // 新建：插到来源末尾（或指定下标），返回新 id。
  const insert = ({ source, script, index } = {}) => structural('新建正则', ctx => editRegexList(ctx, source, raw => {
    const entry = blankRegexScript(script && typeof script === 'object' ? script : {});
    if (!text(entry.scriptName)) throw new Error('请先填写正则名称');
    const at = Number.isInteger(index) ? Math.max(0, Math.min(index, raw.length)) : raw.length;
    const next = [...raw]; next.splice(at, 0, entry);
    return { next, touched: [entry], result: entry.id };
  }));
  // 编辑保存：按原 id/名定位、原位替换；有真实 id 的保持 id 不变（绑定与排序不受影响）。
  const saveScript = ({ source, id, name, script } = {}) => structural('保存正则', ctx => editRegexList(ctx, source, raw => {
    const index = locateRegexScript(raw, { id, name });
    if (index < 0) throw stale();
    const entry = { ...raw[index], ...(script && typeof script === 'object' ? script : {}) };
    entry.id = text(raw[index]?.id) || text(entry.id) || newRegexId();
    if (!text(entry.scriptName)) throw new Error('请先填写正则名称');
    const next = [...raw]; next[index] = entry;
    return { next, touched: [raw[index], entry], result: true };
  }));
  // 分组改名 / 移入移出分组：都是改名字前缀。from 为原组名（未分组传空或「未分组」；单条可带自己的 from），to 为新组名（空 = 移出）。
  const regroup = ({ items, from = '', to = '' } = {}) => structural('调整分组', async ctx => {
    let count = 0;
    const plain = value => (text(value) === UNGROUPED_LABEL ? '' : text(value));
    for (const [source, list] of bySource(items)) {
      const out = await editRegexList(ctx, source, raw => {
        const origin = new Map();
        for (const item of list) {
          const index = locateRegexScript(raw, item);
          if (index < 0) throw stale();
          origin.set(index, plain(item.from ?? from));
        }
        let hits = 0;
        const next = raw.map((script, i) => {
          if (!origin.has(i)) return script;
          const renamed = assignRegexGroup(text(script?.scriptName), { from: origin.get(i), to });
          if (!renamed || renamed === text(script?.scriptName)) return script;
          hits += 1; return { ...script, scriptName: renamed };
        });
        return hits ? { next, touched: [], result: hits } : { next: null, result: 0 };
      });
      count += out.result || 0;
    }
    return { reload: false, result: count };
  });
  function setManaging(on) { managing = on === true; if (!managing) { selected.clear(); picking = []; } refresh(); }
  function setSelected(keys, on = true) {
    for (const key of Array.isArray(keys) ? keys : [keys]) { if (!text(key)) continue; if (on) selected.add(String(key)); else selected.delete(String(key)); }
    refresh();
  }
  function openEditor(target = {}) {
    if (target.isNew) editing = { isNew: true, source: BINDING_SOURCES.includes(target.source) ? target.source : 'global' };
    else if (BINDING_SOURCES.includes(target.source) && text(target.id)) editing = { isNew: false, source: target.source, id: text(target.id), name: text(target.name) };
    else return;
    refresh();
  }
  function closeEditor() { editing = null; refresh(); }

  const actions = Object.freeze({
    views: REGEX_VIEWS,
    placements: REGEX_PLACEMENTS,
    group: groupAdjacentRegex,   // C-15 s9：单一模式「原始顺序 + 相邻同类折叠」；groupRegexScripts 保留导出便于回退
    preview: previewRegexScript,
    placementLabels: REGEX_PLACEMENTS,
    bindingKey: regexBindingKey,
    setView(next) { view = REGEX_VIEWS.includes(next) ? next : 'order'; refresh(); },
    isFolded: key => folded.has(String(key)),
    setFolded(key, on) { if (!text(key)) return; if (on) folded.add(String(key)); else folded.delete(String(key)); refresh(); },
    reload() { refresh(); },
    toggle,
    toggleMany,
    setBindingEnabled,
    setBindingOverride,
    clearBindingOverride,
    selectPreset,
    readScript, removeMany, undoRemove, setRecycle, copyMany, move, moveRow, pickMove, cancelPick, dropMove, insert, saveScript, regroup,
    setManaging, setSelected, openEditor, closeEditor,
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
  // C-14f：同时退出编辑子页与管理态（下次打开回到列表）；折叠态保留。
  function unmount() {
    mounted?.view?.dispose?.(); mounted = null;
    editing = null; managing = false; selected.clear();
    if (reloadPending && reloadTimer !== null) void flushReload();
  }
  function dispose() {
    disposed = true; reloadPending = false;
    if (reloadTimer !== null) { timers.clear(reloadTimer); reloadTimer = null; }
    unmount();
  }
  // 进聊天钩子：index.js 把 CHAT_CHANGED / appReady 接到这里，自动套用本聊天绑定。
  // presetChanged 只刷新面板：ST 的自动选预设也会发这个事件，拿它记绑定会把用户的选择冲掉。
  const events = Object.freeze({ chatChanged: () => { void applyBinding(); }, presetChanged: () => { refresh(); } });
  return Object.freeze({ mount, unmount, dispose, actions, state, applyBinding, events });
}
