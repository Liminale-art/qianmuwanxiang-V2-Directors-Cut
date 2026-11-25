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
// C-16 s4：开头序号前缀——(1) （2） 1. 1、 ——只是给同类条目编号，归类时剥掉（但不能把整名吃空）。
const LEAD_ORDINAL = /^\s*(?:[（(]\s*\d+\s*[）)]|\d+\s*[.、．])[-_·:：|｜/\s]*/u;
const EDGE_JUNK = /[-_·:：|｜/\s（()）【】[\]]/u;
const WORDY = /[A-Za-z0-9]/;

export function regexFamilyKey(name) {
  const raw = text(name);
  const bracket = raw.match(LEAD_BRACKET);
  const tag = bracket?.[1]?.trim() || '';
  let core = (tag ? raw.slice(bracket[0].length) : raw).replace(EXCLUSIVE_MARK, '').replace(EXCLUSIVE_TAIL, '');
  // C-16 s4：带开头序号前缀的条目标为 seq——同核心序列被少量异类打断时可桥接回一段。
  const seq = !tag && LEAD_ORDINAL.test(core) && core.replace(LEAD_ORDINAL, '').trim() !== '';
  if (!tag) { const lead = core.replace(LEAD_ORDINAL, ''); if (lead.trim()) core = lead; }
  for (let i = 0; i < 3; i += 1) {
    const next = stripOrdinal(core.replace(CIRCLED_TAIL, ''));
    if (next === core) break;
    core = next;
  }
  core = core.trim() || raw;
  const cut = core.search(SEPARATOR);
  return Object.freeze({ tag, core, head: cut > 0 ? core.slice(0, cut).trim() : '', seq });
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

// C-18：手动【标签】= 明确声明「属于名为该标签的组」。所以带【会话】的条目可以并入自动归出来的「会话」组
// （无标签一方的核心或分隔前缀恰为该标签），不再只能和同标签条目成段——否则「移入分组」只多了个前缀却进不了组。
const fitsTag = (tag, plain) => !plain.tag && (plain.core === tag || plain.head === tag);
function pairFamily(a, b) {
  if (a.tag || b.tag) {
    if (a.tag && a.tag === b.tag) return { mode: 'tag', label: a.tag };
    if (a.tag && fitsTag(a.tag, b)) return { mode: 'prefix', label: a.tag };
    if (b.tag && fitsTag(b.tag, a)) return { mode: 'prefix', label: b.tag };
    return null;
  }
  if (a.core === b.core) return { mode: 'prefix', label: a.core };
  if (a.head && a.head === b.head) return { mode: 'prefix', label: a.head };
  const pre = sharedEdge(a.core, b.core, false);
  if (pre) return { mode: 'prefix', label: pre };
  const suf = sharedEdge(a.core, b.core, true);
  return suf ? { mode: 'suffix', label: suf } : null;
}

// 段已定类别后，下一条能否并入；能则返回（可能收窄的）新标签。
function extendFamily(run, f) {
  if (run.mode === 'tag') return f.tag === run.label || fitsTag(run.label, f) ? run.label : '';
  if (f.tag) return f.tag === run.label ? run.label : '';
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
  const push = run => {
    loose = null;
    const n = (seen.get(run.label) || 0) + 1; seen.set(run.label, n);
    out.push({ key: n > 1 ? `${run.label}#${n}` : run.label, label: run.label, mode: run.mode, items: list.slice(run.from, run.to) });
  };
  for (let i = 0; i < list.length;) {
    // C-16 s4：带开头序号的同核心序列（(1)会话、(2)会话…）即便被 ≤2 条异类打断也桥接成一段。
    if (fams[i].seq) {
      const core = fams[i].core;
      const isMember = k => fams[k].seq && fams[k].core === core;
      let last = i, p = i + 1;
      while (p < list.length) {
        if (isMember(p)) { last = p; p += 1; continue; }
        let f = p; while (f < list.length && !isMember(f)) f += 1;
        if (f < list.length && f - p <= 2) { last = f; p = f + 1; continue; }
        break;
      }
      if (last > i) { push({ label: core, mode: 'prefix', from: i, to: last + 1 }); i = last + 1; continue; }
    }
    const pair = i + 1 < list.length ? pairFamily(fams[i], fams[i + 1]) : null;
    if (!pair) {
      if (!loose) { loose = { key: '', label: '', mode: '', items: [] }; out.push(loose); }
      loose.items.push(list[i]); i += 1; continue;
    }
    const run = { ...pair };
    let j = i + 2;
    for (; j < list.length; j += 1) { const next = extendFamily(run, fams[j]); if (!next) break; run.label = next; }
    // C-17 s8：成段后向后桥接——同一组被 1~2 条异类打断（会话-外框… /（10）不发送消息 / 会话-功能…）时接回一段，
    // 夹在中间的条目一并纳入，顺序不变。保守条件：后续条目必须落在同一标签上（不收窄标签）；
    // 被夹的条目不能带手动【标签】，两条被夹条目若自成一类也不吞并。
    for (;;) {
      let f = j;
      while (f < list.length && f - j < 3 && extendFamily(run, fams[f]) !== run.label) f += 1;
      const gap = f - j;
      if (gap < 1 || gap > 2 || f >= list.length) break;
      if (fams.slice(j, f).some(fam => fam.tag)) break;
      if (gap === 2 && pairFamily(fams[j], fams[j + 1])) break;
      for (j = f + 1; j < list.length; j += 1) { if (extendFamily(run, fams[j]) !== run.label) break; }
    }
    push({ label: run.label, mode: run.mode, from: i, to: j });
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

// C-18：条目要属于组 group 时应带的名字——名字本身就属于该组（核心/分隔前缀即组名）则不加标签（并去掉旧标签），
// 否则写【组名】。group 为空 = 去掉标签。
export function fitRegexGroupName(name, group) {
  const dest = text(group).replace(/[【】[\]]/gu, '').trim();
  const bare = tagRegexName(name, '');
  if (!dest) return bare;
  const fam = regexFamilyKey(bare);
  return fam.core === dest || fam.head === dest ? bare : tagRegexName(bare, dest);
}

// C-18：把一批条目真正放进组 group——改名（fitRegexGroupName）并挪到该组现有成员的末尾；该组还不存在时，
// 把这批条目收拢到其中第一条的位置（相邻同标签自然成组）。返回新数组（无变化返回 null）。
export function joinRegexGroup(list, indices, group) {
  const pick = new Set(indices);
  if (!pick.size) return null;
  const nameOf = script => text(script?.scriptName);
  const renamed = list.map((script, i) => {
    if (!pick.has(i)) return script;
    const to = fitRegexGroupName(nameOf(script), group);
    return to && to !== nameOf(script) ? { ...script, scriptName: to } : script;
  });
  const dest = text(group).replace(/[【】[\]]/gu, '').trim();
  let next = renamed;
  if (dest) {
    const moving = renamed.filter((_, i) => pick.has(i));
    const rest = renamed.filter((_, i) => !pick.has(i));
    const runs = groupAdjacentRegex(rest.map(script => ({ name: nameOf(script), script })));
    const home = [...runs].reverse().find(run => run.label === dest);
    let at;
    if (home) at = rest.indexOf(home.items[home.items.length - 1].script) + 1;
    else at = renamed.slice(0, Math.min(...pick)).filter((_, i) => !pick.has(i)).length;
    next = [...rest.slice(0, at), ...moving, ...rest.slice(at)];
  }
  return next.every((script, i) => script === list[i]) ? null : next;
}

// ── C-22：自定义分组（替代 C-19～C-21 的「固定分组＋聚拢」）─────────────────────────────
// 原则：列表永远按真实执行顺序显示，分组只是给「连续的」条目加组头，绝不为了凑组而重排显示。
// 每条正则可以有一个手动归属（存千幕设置，按 id）：
//   - 组名字符串 = 自定义分组，最高优先：该条目一定显示在这个组里；
//   - null       = 明确「不分组」：手动移出分组的条目，自动算法也不再把它折进组；
//   - 没有记录   = 交给相邻同类自动折叠（原有的稳定算法）。
// 自动折叠只在「没有手动归属的连续区段」内进行；相邻的同名段（自定义＋自动）合成一组显示。
// 自定义组成员若被别处调整顺序拆开，会如实显示为两段同名组，拖一下即可并回——不做任何隐式重排。
const NO_GROUP = null;
export const REGEX_NO_GROUP = NO_GROUP;
// C-26：预设内的千幕字段（ST 原生导出预设时随 extensions 一起导出；没装千幕的人只会多一个被忽略的字段）。
export const PRESET_GROUPS_PATH = 'qianmu.regexGroups';
export const PRESET_DEFAULTS_PATH = 'qianmu.regexDefaults';

// C-26：出厂开关——{ 脚本 id: 是否启用 }。只收真实 id。
export function normalizeRegexDefaults(raw) {
  const out = {};
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const [key, value] of Object.entries(raw)) {
      const id = text(key);
      if (id && !/^#\d+$/.test(id) && typeof value === 'boolean') out[id] = value;
    }
  }
  return Object.freeze(out);
}
export function snapshotRegexDefaults(items) {
  const out = {};
  for (const item of Array.isArray(items) ? items : []) {
    const id = text(item?.id);
    if (id && !/^#\d+$/.test(id)) out[id] = item.enabled === true;
  }
  return Object.freeze(out);
}
// 与出厂开关不同的条目（只比较两边都有的条目；预设新增的条目没有出厂值，不算差异）。
export function diffRegexDefaults(items, defaults) {
  const base = normalizeRegexDefaults(defaults);
  return (Array.isArray(items) ? items : [])
    .filter(item => Object.prototype.hasOwnProperty.call(base, text(item?.id)) && base[text(item.id)] !== (item.enabled === true))
    .map(item => ({ id: item.id, name: item.name, enabled: base[text(item.id)] }));
}

// C-26：重复正则——查找表达式与替换内容都相同（各自去首尾空白）的条目。返回 { id: 同组其它条目名[] }，只含有重复的条目。
// C-27：只比查找表达式会把「同一匹配、不同处理」的正常写法误标为重复，收紧为两者都相同。
export function findDuplicateRegex(scripts) {
  const byFind = new Map();
  (Array.isArray(scripts) ? scripts : []).forEach((script, index) => {
    const find = typeof script?.findRegex === 'string' ? script.findRegex.trim() : '';
    if (!find) return;
    const replace = typeof script?.replaceString === 'string' ? script.replaceString.trim() : '';
    const sig = JSON.stringify([find, replace]);
    const row = { id: text(script.id) || `#${index}`, name: text(script.scriptName) || '（未命名）' };
    if (!byFind.has(sig)) byFind.set(sig, []);
    byFind.get(sig).push(row);
  });
  const out = {};
  for (const rows of byFind.values()) {
    if (rows.length < 2) continue;
    for (const row of rows) out[row.id] = rows.filter(other => other !== row).map(other => other.name);
  }
  return Object.freeze(out);
}

// C-26：搜索——名字或组名包含关键词（不区分大小写，空白分词需全部命中）。
export function regexMatchesQuery(item, groupLabel, query) {
  const words = text(query).toLocaleLowerCase().split(/\s+/u).filter(Boolean);
  if (!words.length) return true;
  const hay = `${text(item?.name)} ${text(groupLabel)}`.toLocaleLowerCase();
  return words.every(word => hay.includes(word));
}

export function normalizeRegexAssign(raw) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw.assign && typeof raw.assign === 'object' ? raw.assign : raw) : {};
  const out = {};
  for (const [key, value] of Object.entries(src)) {
    const id = text(key);
    if (!id || /^#\d+$/.test(id)) continue;                  // 无真实 id 的条目不能稳定归组（下标会变）
    if (value === null) out[id] = NO_GROUP;
    else if (typeof value === 'string' && text(value)) out[id] = text(value).replace(/[【】[\]]/gu, '').trim();
  }
  return Object.freeze(out);
}
const cleanGroupName = name => text(name).replace(/[【】[\]]/gu, '').trim();

// 纯函数：给一批 id 设归属。name 为组名＝加入该组；name === null ＝明确不分组；name === undefined ＝清除（回到自动）。
export function setRegexAssign(assign, ids, name) {
  const next = { ...normalizeRegexAssign(assign) };
  const value = name === undefined ? undefined : name === null ? NO_GROUP : cleanGroupName(name);
  for (const raw of Array.isArray(ids) ? ids : []) {
    const id = text(raw);
    if (!id || /^#\d+$/.test(id)) continue;
    if (value === undefined || value === '') delete next[id]; else next[id] = value;
  }
  return Object.freeze(next);
}

// 纯函数：自定义组改名（所有归属于 from 的条目改归 to）。
export function renameRegexAssign(assign, from, to) {
  const src = cleanGroupName(from), dest = cleanGroupName(to);
  const next = { ...normalizeRegexAssign(assign) };
  if (!src || !dest || src === dest) return Object.freeze(next);
  for (const [id, value] of Object.entries(next)) if (value === src) next[id] = dest;
  return Object.freeze(next);
}

// 纯函数：显示用的段。items 为 [{id,name}]（真实顺序），返回 [{key,label,mode,items,custom}]，拼回恰为原列表。
export function groupRegexRuns(items, assign) {
  const list = Array.isArray(items) ? items : [];
  const map = normalizeRegexAssign(assign);
  const runs = [];
  let chunk = [];
  const flush = () => {
    if (!chunk.length) return;
    for (const run of groupAdjacentRegex(chunk)) runs.push({ label: run.label, mode: run.mode, items: [...run.items], custom: false });
    chunk = [];
  };
  for (const item of list) {
    const id = text(item?.id);
    if (!id || !Object.prototype.hasOwnProperty.call(map, id)) { chunk.push(item); continue; }
    flush();
    const label = map[id];
    const last = runs[runs.length - 1];
    if (label === NO_GROUP) { runs.push({ label: '', mode: '', items: [item], custom: false }); continue; }
    if (last && last.custom && last.label === label) last.items.push(item);
    else runs.push({ label, mode: 'custom', items: [item], custom: true });
  }
  flush();
  // 相邻同名段合成一组（自定义优先：任一为自定义，合并结果即为自定义组）；相邻散条合成一个无头段。
  const merged = [];
  for (const run of runs) {
    const prev = merged[merged.length - 1];
    if (prev && run.label && prev.label === run.label) { prev.items.push(...run.items); prev.custom = prev.custom || run.custom; if (prev.custom) prev.mode = 'custom'; continue; }
    if (prev && !run.label && !prev.label) { prev.items.push(...run.items); continue; }
    merged.push({ ...run });
  }
  const seen = new Map();
  return merged.map(run => {
    if (!run.label) return { key: '', label: '', mode: '', items: run.items, custom: false };
    const base = `${run.custom ? 'custom:' : ''}${run.label}`;
    const n = (seen.get(base) || 0) + 1; seen.set(base, n);
    return { key: n > 1 ? `${base}#${n}` : base, label: run.label, mode: run.mode, items: run.items, custom: run.custom };
  });
}

// 纯函数：把选中条目（保持相对顺序）挪到组 name 现有的最后一段末尾；该组不存在时收拢到第一条所在位置。
// 返回目标下标（供 moveRegexEntries 使用）。rows 为整个来源的 [{id,name}]，assign 为「已写入新归属」后的映射。
export function regexGroupInsertIndex(rows, indices, name, assign) {
  const pick = new Set(indices);
  const label = cleanGroupName(name);
  const rest = rows.map((row, i) => ({ row, i })).filter(entry => !pick.has(entry.i));
  const runs = groupRegexRuns(rest.map(entry => entry.row), assign);
  const home = [...runs].reverse().find(run => run.label === label);
  if (!home) return Math.min(...indices);
  const tail = home.items[home.items.length - 1];
  const at = rest.find(entry => entry.row === tail);
  return at ? at.i + 1 : Math.min(...indices);
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
  if (!canRead) return Object.freeze({ global: Object.freeze({ ...global, duplicates: findDuplicateRegex(globalRaw) }),
    preset: Object.freeze({ available: false, writable: false, name: '', apiId: '', allowed: false, items: Object.freeze([]), factory: Object.freeze({}), hasFactory: false, duplicates: Object.freeze({}) }) });
  const presetRaw = attempt(() => manager.readPresetExtensionField({ path: 'regex_scripts' }), []);
  const name = text(attempt(() => manager.getSelectedPresetName?.(), ''));
  const apiId = text(attempt(() => manager.apiId, '')) || 'openai';
  const allowList = attempt(() => ctx.extensionSettings?.preset_allowed_regex?.[apiId], null);
  const allowed = Array.isArray(allowList) && !!name && allowList.includes(name);
  const writable = Array.isArray(presetRaw) && typeof manager.writePresetExtensionField === 'function';
  // C-26：预设内的出厂开关、两个来源的重复正则（查找表达式相同）。
  const factory = normalizeRegexDefaults(attempt(() => manager.readPresetExtensionField({ path: PRESET_DEFAULTS_PATH }), null));
  return Object.freeze({
    global: Object.freeze({ ...global, duplicates: findDuplicateRegex(globalRaw) }),
    preset: Object.freeze({ available: true, writable, name, apiId, allowed, items: Object.freeze(summarizeList(presetRaw)),
      factory, hasFactory: Object.keys(factory).length > 0, duplicates: findDuplicateRegex(presetRaw) }) });
}

// C-26：一键允许当前预设的正则运行——写进 ST 原生同一份允许名单（extension_settings.preset_allowed_regex[apiId]），
// 与 ST 正则面板里的开关是同一处数据。返回是否真的新加入。
export function allowPresetRegex(context) {
  const ctx = context && typeof context === 'object' ? context : {};
  const manager = presetManager(ctx);
  const name = text(attempt(() => manager?.getSelectedPresetName?.(), ''));
  const apiId = text(attempt(() => manager?.apiId, '')) || 'openai';
  if (!name || !ctx.extensionSettings || typeof ctx.saveSettingsDebounced !== 'function') throw new Error('当前 ST 不支持在此允许预设正则');
  const table = ctx.extensionSettings.preset_allowed_regex && typeof ctx.extensionSettings.preset_allowed_regex === 'object'
    ? ctx.extensionSettings.preset_allowed_regex : (ctx.extensionSettings.preset_allowed_regex = {});
  if (!Array.isArray(table[apiId])) table[apiId] = [];
  if (table[apiId].includes(name)) return false;
  table[apiId].push(name);
  ctx.saveSettingsDebounced();
  return true;
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
export async function writeRegexStates(context, { source, changes, expectPreset = '' } = {}) {
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
    // C-25：写入前核对「当前选中的预设」仍是计划时那一个；中途被切走就整批放弃，绝不写进别的预设。
    if (text(expectPreset) && text(attempt(() => manager.getSelectedPresetName?.(), '')) !== text(expectPreset)) {
      throw new Error(`预设已切换（不再是「${text(expectPreset)}」），本次正则写入已取消`);
    }
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

// 编辑子页的「测试」：与 ST 引擎同一套替换语义的纯函数预览。查找串按 ST utils.regexFromString 解析——
// "/pat/flags" 取 flags；不带斜杠的串直接当正则源（不是纯文本！C-17 修：旧实现把它转义成字面量，导致预览永远原样输出）。
// {{match}} 即 $0，$1 / $<名> 取捕获组且先按「修剪掉」逐条剔除，缺组替换为空。不展开宏（预览只看正则本身）。
export function parseRegexLiteral(source) {
  const raw = typeof source === 'string' ? source : '';
  if (!raw) return null;
  try {
    const m = raw.match(/(\/?)(.+)\1([a-z]*)/i);
    if (!m) return null;
    if (m[3] && !/^(?!.*?(.).*?\1)[gmixXsuUAJ]+$/.test(m[3])) return new RegExp(raw);
    return new RegExp(m[2], m[3]);
  } catch (_) { return null; }
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
    return template.replace(/\$(\d+)|\$<([^>]+)>/g, (_, num, name) => {
      const hit = num !== undefined ? captures[Number(num)] : groups?.[name];
      return hit ? trim(hit) : '';
    });
  });
  return { ok: true, output, error: '' };
}

// ── C-17 s5：导入 / 导出 ─────────────────────────────────────────────────────
// 与 ST 原生正则文件同一格式：一个文件 = 一条脚本对象；也接受数组（多条一起导出时的格式）。
// 只收带名字或查找串的对象；补齐缺省字段；id 缺失或与已占用的 id 撞车时换新 id（不覆盖已有条目）。
export function parseRegexImport(texts, { taken = [], makeId = newRegexId } = {}) {
  const used = new Set((Array.isArray(taken) ? taken : []).map(text).filter(Boolean));
  const scripts = []; let skipped = 0;
  for (const raw of Array.isArray(texts) ? texts : [texts]) {
    let parsed;
    try { parsed = JSON.parse(String(raw ?? '')); } catch (_) { skipped += 1; continue; }
    for (const entry of Array.isArray(parsed) ? parsed : [parsed]) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry) || !(text(entry.scriptName) || text(entry.findRegex))) { skipped += 1; continue; }
      const script = blankRegexScript(structuredClone(entry));
      script.scriptName = text(script.scriptName) || '（未命名）';
      const id = text(script.id);
      if (!id || /^#\d+$/.test(id) || used.has(id)) script.id = makeId();
      used.add(text(script.id));
      scripts.push(script);
    }
  }
  return { scripts, skipped };
}
// 导出内容：单条 = 脚本对象本身（ST 原生导入可直接读）；多条 = 数组。
export function buildRegexExport(scripts) {
  const list = (Array.isArray(scripts) ? scripts : []).filter(script => script && typeof script === 'object');
  if (!list.length) return null;
  const safe = value => text(value).replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 60) || 'regex';
  return { name: list.length === 1 ? `regex-${safe(list[0].scriptName)}.json` : `regex-${list.length}条.json`,
    json: JSON.stringify(list.length === 1 ? list[0] : list, null, 4) };
}

// ── C-17 s9：把千幕的写回同步到 ST 原生正则面板 ──────────────────────────────────
// 千幕写的是 ST 的真数据（全局设置 / 预设字段），导出预设时带出的就是当前状态；但 ST 原生面板的列表是
// 它自己上次渲染的 DOM，只在它自己的时机重画，所以看上去「没同步」。这里只改已渲染节点的外观：
// 勾选态对齐 disabled、已删除的条目移除、顺序对齐；不派发事件、不调用 ST 内部函数、缺节点即跳过。
// 新增条目没有现成节点，留给 ST 下次自己重画。返回对齐过的节点数。
const NATIVE_REGEX_LISTS = Object.freeze({ global: 'saved_regex_scripts', preset: 'saved_preset_scripts' });
export function syncNativeRegexList(context, { root } = {}) {
  const ctx = context && typeof context === 'object' ? context : {};
  const doc = root || attempt(() => globalThis.document, null);
  if (!doc || typeof doc.getElementById !== 'function') return 0;
  const idOf = node => text(attempt(() => node.getAttribute('id'), ''));
  let synced = 0;
  for (const source of ['global', 'preset']) {
    const box = attempt(() => doc.getElementById(NATIVE_REGEX_LISTS[source]), null);
    if (!box) continue;
    const list = attempt(() => (source === 'global' ? ctx.extensionSettings?.regex : presetManager(ctx)?.readPresetExtensionField?.({ path: 'regex_scripts' })), null);
    if (!Array.isArray(list)) continue;
    const byId = new Map(attempt(() => [...box.children], []).filter(node => node && idOf(node)).map(node => [idOf(node), node]));
    const live = list.filter(script => text(script?.id) && byId.has(text(script.id)));
    if (!live.length) continue;                               // 认不出这份列表：不动
    const keep = new Set(list.map(script => text(script?.id)).filter(Boolean));
    for (const [id, node] of byId) if (!keep.has(id)) attempt(() => { node.remove(); return true; }, false);
    const shown = attempt(() => [...box.children], []).filter(node => keep.has(idOf(node)));
    const ordered = live.map(script => byId.get(text(script.id)));
    if (shown.length === ordered.length && shown.some((node, i) => node !== ordered[i])) attempt(() => { for (const node of ordered) box.appendChild(node); return true; }, false);
    for (const script of live) {
      const check = attempt(() => byId.get(text(script.id)).querySelector('.disable_regex'), null);
      if (!check) continue;
      const disabled = script.disabled === true;
      if (check.checked !== disabled) check.checked = disabled;
      synced += 1;
    }
  }
  return synced;
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
    // C-23：1.59.501～510 的开关写入用的是 `preset:<id>`（缺预设名），与这里的 `preset:<预设名>:<id>` 对不上，
    // 预设正则的绑定因此从未生效。新写入已统一；旧键仍按「当前预设」兼容读取。
    const legacy = `${row.source}:${row.id}`;
    const has = (map, key) => Object.prototype.hasOwnProperty.call(map, key);
    const pick = has(over, row.key) ? over[row.key] : has(over, legacy) ? over[legacy]
      : has(base, row.key) ? base[row.key] : has(base, legacy) ? base[legacy] : null;
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

// 批量删预设：逐个走 ST 原生删除（PresetManager.deletePreset，和原生「删除预设」按钮同一条路），原生下拉随之同步；
// 删到正在用的那个时由 ST 自己切到剩下的第一个，所以它排在最后删。每删掉一个发一次 PRESET_DELETED、最后存一次设置，与原生一致。
// 只删当前名单里真有的名字（原生对不存在的名字会误删最后一个）；删完名单里还在、或 ST 说没删成的，算没删掉。
export async function deletePresets(context, names) {
  const ctx = context && typeof context === 'object' ? context : {};
  const manager = presetManager(ctx);
  if (!canSwitchPresets(manager) || typeof manager.deletePreset !== 'function') throw new Error('当前 ST 不支持在此删除预设');
  const listed = () => readPresetChoices(ctx).names;
  const known = new Set(listed()), current = text(attempt(() => manager.getSelectedPresetName(), ''));
  const wanted = [...new Set((Array.isArray(names) ? names : []).map(text).filter(name => name && known.has(name)))];
  const ordered = [...wanted.filter(name => name !== current), ...wanted.filter(name => name === current)];
  const deleted = [], failed = [];
  const emitter = ctx.eventSource && typeof ctx.eventSource.emit === 'function' ? ctx.eventSource : null;
  const deletedType = attempt(() => ctx.eventTypes?.PRESET_DELETED || ctx.event_types?.PRESET_DELETED, '') || 'preset_deleted';
  for (const name of ordered) {
    if (!listed().includes(name)) continue;
    let result;
    try { result = await manager.deletePreset(name); } catch (_) { result = false; }
    if (result === false || listed().includes(name)) { failed.push(name); continue; }
    deleted.push(name);
    if (emitter) { try { await emitter.emit(deletedType, { apiId: manager.apiId, name }); } catch (_) { /* 别的监听者出错不影响删除结果 */ } }
  }
  if (deleted.length) attempt(() => ctx.saveSettingsDebounced?.(), null);
  return Object.freeze({ deleted: Object.freeze(deleted), failed: Object.freeze(failed) });
}

// 纯函数：从一份正则开关记录里去掉这些预设名下的条目（`preset:<预设名>:<id>`）。没有变化时原样返回同一个对象。
export function dropPresetKeys(map, names) {
  const value = map && typeof map === 'object' ? map : {};
  const prefixes = (Array.isArray(names) ? names : []).map(name => `preset:${text(name)}:`).filter(prefix => prefix.length > 8);
  const keys = Object.keys(value).filter(key => prefixes.some(prefix => key.startsWith(prefix)));
  if (!keys.length) return value;
  const next = { ...value };
  for (const key of keys) delete next[key];
  return next;
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
// C-16 s2：结构性写回（删除/复制/移动/分组）用更短的静默窗，操作后尽快重绘，减少「等很久没反应」的卡顿感。
export const REGEX_STRUCTURAL_DELAY = 250;

// C-16 s2：轻量重绘——只重画已渲染的楼层，避开整聊 reloadCurrentChat 的卡顿。
// 读 #chat 里已渲染的 .mes[mesid]，对每条调用 updateMessageBlock(id, chat[id]) 重新套用显示正则，
// 有 eventSource 时补发 MESSAGE_UPDATED（与 ST 原生编辑后同一信号，让其它监听者跟进）。
// 返回实际重绘的楼层数；缺少 chat / updateMessageBlock / 可查询的文档时返回 -1，交给调用方回退整聊重载。
export async function rerenderRenderedMessages(context, { root } = {}) {
  const ctx = context && typeof context === 'object' ? context : null;
  const chat = ctx && Array.isArray(ctx.chat) ? ctx.chat : null;
  if (!ctx || !chat || typeof ctx.updateMessageBlock !== 'function') return -1;
  const doc = root || attempt(() => globalThis.document, null);
  if (!doc || typeof doc.querySelectorAll !== 'function') return -1;
  const nodes = attempt(() => doc.querySelectorAll('#chat .mes[mesid]'), []);
  const rows = nodes ? [...nodes] : [];
  const emitter = ctx.eventSource && typeof ctx.eventSource.emit === 'function' ? ctx.eventSource : null;
  const updatedType = attempt(() => ctx.eventTypes?.MESSAGE_UPDATED, '') || 'message_updated';
  let count = 0;
  for (const node of rows) {
    const id = Number(attempt(() => node.getAttribute('mesid'), null));
    if (!Number.isInteger(id) || id < 0 || id >= chat.length) continue;   // 未映射的 mesid 跳过
    ctx.updateMessageBlock(id, chat[id]);
    if (emitter) await emitter.emit(updatedType, id);
    count += 1;
  }
  return count;
}

// C-17 s5：默认的选文件 / 存文件走浏览器自带能力；控制器把它们当依赖注入，测试里换成桩。
function defaultPickFiles() {
  const doc = attempt(() => globalThis.document, null);
  if (!doc?.body || typeof doc.createElement !== 'function') return Promise.reject(new Error('当前环境无法选择文件'));
  return new Promise(resolve => {
    const picker = doc.createElement('input');
    picker.type = 'file'; picker.accept = '.json,application/json'; picker.multiple = true; picker.hidden = true;
    let settled = false;
    const finish = files => { if (settled) return; settled = true; picker.remove(); resolve(files); };
    picker.addEventListener('change', async () => {
      try { finish(await Promise.all([...(picker.files || [])].map(file => file.text()))); } catch (_) { finish([]); }
    }, { once: true });
    picker.addEventListener('cancel', () => finish([]), { once: true });
    doc.body.append(picker);
    picker.click();
  });
}
function defaultSaveFile({ name, json }) {
  const doc = attempt(() => globalThis.document, null);
  if (!doc?.body || typeof Blob !== 'function' || typeof URL?.createObjectURL !== 'function') throw new Error('当前环境无法保存文件');
  const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
  const link = doc.createElement('a');
  link.href = url; link.download = name; link.hidden = true;
  doc.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function createChatRegex({ getContext = () => ({}), notify = () => {},
  pickFiles = defaultPickFiles, saveFile = defaultSaveFile,
  canReload = () => true, timers = { set: (fn, ms) => setTimeout(fn, ms), clear: id => clearTimeout(id) },
  // C-11d 绑定存取（默认空操作 → 未接线时整套绑定完全惰性，不写 ST）：
  // readBinding 读本聊天覆盖（只读，无副作用）；writeBinding 持久化本聊天覆盖；
  // readDefaults 读全局默认基线；writeDefaults 持久化全局默认（首次为某条建覆盖时抓当前 live 态作基线，保证离开聊天能复位不泄漏）。
  readBinding = () => ({ enabled: false, overrides: {} }), writeBinding = () => {},
  readDefaults = () => ({}), writeDefaults = () => {},
  // C-19：固定分组存取（组名 → 成员 id），存千幕自己的设置；未接线时整套固定分组惰性，不写任何东西。
  // C-22：手动分组归属存取（id → 组名 / null），存千幕自己的设置；未接线时整套手动分组惰性，不写任何东西。
  readGroups = () => ({}), writeGroups = () => {},
  loadView = () => import('./qianmu-chat-regex-view.js?v=1.59.605') } = {}) {
  let mounted = null, disposed = false, view = 'order', reloadTimer = null, reloadPending = false, applying = false;
  let presetBusy = false, missingNoticed = '';
  const pending = new Set();
  const folded = new Set();   // C-14e：卡片/分组折叠态（card:global / group:preset:xx），跨页签保持
  // C-14f：管理态（多选 / 拖动 / 分组改名）、编辑子页目标、结构性写回中。都只活在本次会话。
  // C-15 s5：回收站——被删条目累积在内存里（刷新/重启即清空），可逐条或整批还原。
  // C-15 s7：拾取移动——拾起的条目（单条或整批同源选择）暂存在 picking，点插入位即落定；拖拽走同一条落定路径。
  let managing = false, editing = null, writing = false, recycleOpen = false;
  // C-16 s1：busy＝结构性写回正在处理的条目键（行内转圈 + 锁定），reloading＝写回后正在重绘聊天。
  let reloading = false;
  const busy = new Set();
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
  // C-22：手动分组归属（id → 组名 / null=明确不分组）。读是纯只读；写走宿主持久化。
  // C-26：分组按来源分开存——预设正则的分组写进预设自身 `extensions.qianmu.regexGroups`（随 ST 原生导出走），
  // 全局正则的分组仍存千幕设置。currentAssign 返回两者合并后的视图；saveAssign 按 id 所在来源拆开写回。
  // 预设里还没有分组字段时，千幕设置里该预设条目的旧分组仍可读，并在第一次写入时搬进预设。
  const presetIds = () => new Set((readRegexSources(context()).preset.items || []).map(item => text(item.id)).filter(Boolean));
  const presetAssignRaw = () => {
    const manager = presetManager(context());
    const value = attempt(() => manager?.readPresetExtensionField?.({ path: PRESET_GROUPS_PATH }), null);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  };
  const currentAssign = () => {
    const local = normalizeRegexAssign(attempt(() => readGroups(), {}));
    const embedded = presetAssignRaw();
    if (!embedded) return local;
    const inPreset = presetIds();
    const merged = {};
    for (const [id, value] of Object.entries(local)) if (!inPreset.has(id)) merged[id] = value;
    return normalizeRegexAssign({ ...merged, ...normalizeRegexAssign(embedded) });
  };
  let presetGroupWrite = Promise.resolve();
  const saveAssign = next => {
    const all = normalizeRegexAssign(next);
    const inPreset = presetIds();
    const local = {}, preset = {};
    for (const [id, value] of Object.entries(all)) (inPreset.has(id) ? preset : local)[id] = value;
    try { writeGroups(local); } catch (_) { /* 存不下去也不能让面板崩 */ }
    const manager = presetManager(context());
    if (typeof manager?.writePresetExtensionField !== 'function') return;
    // 预设没有任何分组且原本也没有字段：不写，避免给未用分组的预设凭空加字段。
    if (!Object.keys(preset).length && !presetAssignRaw()) return;
    const name = text(attempt(() => manager.getSelectedPresetName?.(), ''));
    presetGroupWrite = presetGroupWrite.then(() => manager.writePresetExtensionField({ name, path: PRESET_GROUPS_PATH, value: preset })).catch(() => {});
  };
  const sameAssign = (a, b) => {
    const x = normalizeRegexAssign(a), y = normalizeRegexAssign(b);
    const keys = new Set([...Object.keys(x), ...Object.keys(y)]);
    for (const key of keys) if (x[key] !== y[key] || Object.prototype.hasOwnProperty.call(x, key) !== Object.prototype.hasOwnProperty.call(y, key)) return false;
    return true;
  };
  // 某个来源当前的显示分段（真实顺序）。
  const runsOf = (source, assign = currentAssign()) => groupRegexRuns(readRegexSources(context())[source]?.items || [], assign);
  const currentChatId = () => attempt(() => { const ctx = context(); return typeof ctx.getCurrentChatId === 'function' ? ctx.getCurrentChatId() : ctx.chatId; }, null);
  const state = () => {
    const b = currentBinding();
    return Object.freeze({ view, pending: Object.freeze([...pending]), folded: Object.freeze([...folded]),
      managing, writing, reloading, busy: Object.freeze([...busy]), selected: Object.freeze([...selected]), editing: editing ? Object.freeze({ ...editing }) : null,
      // C-15 s7：拾取移动——拾起的条目（同源），视图据此显示插入位；空数组＝未拾取。
      picking: Object.freeze(picking.map(entry => Object.freeze({ ...entry }))),
      // C-15 s5：回收站。最近删除在前；每条带还原键。开着时视图改显「已删除」列表。
      recycle: Object.freeze({ open: recycleOpen, count: removed.length,
        items: Object.freeze([...removed].reverse().map(entry => Object.freeze({
          key: entry.key, source: entry.source, preset: entry.preset,
          name: text(entry.script?.scriptName) || '（未命名）' }))) }),
      binding: Object.freeze({ enabled: b.enabled, overrides: Object.freeze({ ...b.overrides }), preset: b.preset }),
      presets: Object.freeze({ ...readPresetChoices(context()), busy: presetBusy }),
      groups: currentAssign(),
      query,
      sources: readRegexSources(context()) });
  };
  // 每次写回后对齐 ST 原生面板里已渲染的列表（见 syncNativeRegexList）；失败不影响千幕自己的面板。
  const syncNative = () => { try { syncNativeRegexList(context()); } catch (_) { /* 原生面板不在或结构不同：跳过 */ } };
  const refresh = () => mounted?.view?.render(state());

  // ST re-applies display regexes only when messages are rendered again, exactly like its own panel does
  // after a toggle. Never reload mid-generation: wait until the host is idle.
  // C-25：lightOnly＝只做已渲染楼层的轻量重绘，绝不退回整聊重载（绑定套用、聊天切换中用）；
  // chatId＝排队时所在聊天，到点若聊天已换就不动。
  let reloadLightOnly = false, reloadChat = '';
  function scheduleReload(delay = REGEX_RELOAD_DELAY, { lightOnly = false, chatId = '' } = {}) {
    // 多次排队合并：任一次要求「只轻量」都保持轻量；聊天以最近一次为准。
    reloadLightOnly = reloadPending ? (reloadLightOnly || lightOnly) : lightOnly;
    reloadChat = text(chatId) || text(currentChatId());
    reloadPending = true;
    if (reloadTimer !== null) timers.clear(reloadTimer);
    reloadTimer = timers.set(() => { reloadTimer = null; void flushReload(); }, delay);
  }
  async function flushReload() {
    if (!reloadPending || disposed) return;
    if (reloadTimer !== null) { timers.clear(reloadTimer); reloadTimer = null; }
    if (attempt(() => canReload(), true) === false) { scheduleReload(REGEX_RELOAD_DELAY * 2, { lightOnly: reloadLightOnly, chatId: reloadChat }); return; }
    reloadPending = false;
    const ctx = context();
    const lightOnly = reloadLightOnly, forChat = reloadChat;
    reloadLightOnly = false; reloadChat = '';
    if (forChat && text(currentChatId()) !== forChat) return;   // 排队后聊天已换：旧聊天的重绘作废
    if (applying) { scheduleReload(REGEX_RELOAD_DELAY, { lightOnly, chatId: forChat }); return; }   // 套用中不重绘
    reloading = true; refresh();
    try {
      // C-16 s2：先走轻量重绘（只重画已渲染楼层），只有它不可用/抛错时才退回整聊重载。
      let painted = -1;
      try { painted = await rerenderRenderedMessages(ctx); } catch (_) { painted = -1; }
      if (painted < 0 && !lightOnly) {
        const chatId = attempt(() => (typeof ctx.getCurrentChatId === 'function' ? ctx.getCurrentChatId() : ctx.chatId), null);
        if (chatId && (!forChat || text(chatId) === forChat) && typeof ctx.reloadCurrentChat === 'function') await ctx.reloadCurrentChat();
      }
    } catch (error) { notify(error?.message || '聊天重载失败，正则改动将在下次进入聊天时生效', 'warning'); }
    finally { reloading = false; if (!disposed) refresh(); }
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

  // ── C-25：绑定套用的稳定性防护 ─────────────────────────────────────────────────
  // 实测：进一个已绑定聊天、预设加载中又手动换预设时，突然切回绑定预设、正则短时间内反复加载，偶发丢聊天。
  // 对照 ST 源码定位到的竞态链：
  //   ①千幕在 CHAT_CHANGED 里切预设（selectPreset 是异步的），ST 自己的 autoSelectPreset 也挂在 CHAT_CHANGED；
  //   ②切预设触发 ST 正则扩展的 PRESET_CHANGED 检查（可能弹「允许运行」确认并 reloadCurrentChat）；
  //   ③千幕写完开关后排一次重载，reloadCurrentChat 内部会再发 CHAT_CHANGED → 千幕再次套用；
  //   ④套用中途用户又换了预设/聊天，旧一轮的「切回绑定预设」照样执行——表现为突然切回、反复加载。
  // 防护：
  //   - 套用串行化：同一时刻只跑一轮，期间再来的请求只记「需要再跑一次」，结束后用最新状态跑最后一轮。
  //   - 会话令牌：每次聊天变化／用户手动操作都使令牌失效；进行中的一轮在每个 await 之后核对，失效即放弃，
  //     绝不在聊天已经换掉之后去切预设或写开关。
  //   - 预设只在「真正进入一个新聊天」时按绑定切一次；同一聊天里后续的 CHAT_CHANGED（重载引发）不再切预设。
  //   - 用户手动换了预设 = 该聊天的预设绑定立即停用（不自动套回，需用户重新开启），本次会话内不再抢回。
  //   - 熔断：同一聊天 10 秒内套用写入超过 3 轮即停止自动套用并提示，避免与宿主互相触发成环。
  //   - 套用期间、聊天切换中不排整聊重载（只做已渲染楼层的轻量重绘），重载前再次核对聊天未变。
  let applySession = 0, applyQueued = false, lastAppliedChat = '';
  const applyHistory = [];
  const bumpSession = () => { applySession += 1; return applySession; };
  const stillCurrent = (token, chatId) => token === applySession && !disposed && currentChatId() === chatId;
  function tripped(chatId) {
    const now = attempt(() => Date.now(), 0);
    while (applyHistory.length && now - applyHistory[0].at > 10000) applyHistory.shift();
    return applyHistory.filter(entry => entry.chat === chatId).length >= 3;
  }

  // 进聊天时先切到本聊天绑定的预设（预设正则的覆盖 key 带预设名，必须先切再算），
  // 再把 全局默认 ⊕ 本聊天覆盖 套用到 live 正则：逐条比较只写差异，仅显示类改动才重载。
  async function applyBinding({ entering = false } = {}) {
    if (disposed) return 0;
    if (applying) { applyQueued = true; return 0; }
    const chatId = currentChatId();
    if (!chatId) return 0;                                   // 欢迎屏/无聊天：不动
    // C-23：未开绑定的聊天也要复位到全局默认基线，否则会沿用上一个已绑定聊天改出来的开关（泄漏）。
    const bindOn = bindingEnabled();
    if (!bindOn && !Object.keys(attempt(() => readDefaults(), {}) || {}).length) return 0;
    if (tripped(chatId)) {
      if (missingNoticed !== `loop\n${chatId}`) { missingNoticed = `loop\n${chatId}`; notify('检测到绑定套用与宿主反复触发，已暂停本聊天的自动套用。可在快切里关闭再开启绑定恢复。', 'warning'); }
      return 0;
    }
    const token = applySession;
    applying = true;
    let changed = 0, reload = false;
    try {
      // 预设只在「真正进入新聊天」时切一次；同一聊天里后续触发（重载回声、手动开关）不再动预设。
      const freshEntry = entering || lastAppliedChat !== chatId;
      lastAppliedChat = chatId;
      const bound = bindOn && freshEntry ? currentBinding().preset : '';
      if (bound) {
        try {
          const moved = await moveToPreset(bound);
          if (!stillCurrent(token, chatId)) return 0;        // 切预设期间聊天已换／用户已手动操作：放弃本轮
          if (moved.switched) {
            changed += 1; reload = moved.reload;
            notify(`已切换到本聊天绑定的预设「${bound}」`, 'info');
          }
        } catch (error) {
          if (!stillCurrent(token, chatId)) return 0;
          if (deletedPresets.has(bound)) {
            // 这个预设是在快切里删掉的：本聊天对它的绑定随之清掉，不再提示。
            const b = currentBinding();
            saveBinding({ preset: '', overrides: dropPresetKeys(b.overrides, [bound]) });
          } else {
            // 绑定的预设被删/改名：每个聊天只提示一次，跳过预设、正则照常套用。
            const notice = `${chatId}\n${bound}`;
            if (missingNoticed !== notice) { missingNoticed = notice; notify(`本聊天绑定的预设「${bound}」无法切换（${error?.message || '未知原因'}），已跳过`, 'warning'); }
          }
        }
      }
      if (!stillCurrent(token, chatId)) return 0;
      const sources = readRegexSources(context());
      const plan = resolveRegexTarget({ defaults: attempt(() => readDefaults(), {}), overrides: bindOn ? readOverrides() : {}, sources });
      let regexChanged = 0;
      try {
        for (const source of BINDING_SOURCES) {
          if (!plan.changes[source].length) continue;
          if (!stillCurrent(token, chatId)) break;
          regexChanged += await writeRegexStates(context(), { source, changes: plan.changes[source], expectPreset: source === 'preset' ? sources.preset.name : '' }) || 0;
        }
      } catch (error) {
        if (stillCurrent(token, chatId)) notify(error?.message || '正则绑定套用失败', 'warning');
      }
      changed += regexChanged;
      if (regexChanged) syncNative();
      if (regexChanged && plan.affectsDisplay) reload = true;
      if (changed) applyHistory.push({ chat: chatId, at: attempt(() => Date.now(), 0) });
    } finally {
      applying = false;
    }
    if (reload && stillCurrent(token, chatId)) scheduleReload(REGEX_RELOAD_DELAY, { lightOnly: true, chatId });
    refresh();
    if (applyQueued) { applyQueued = false; if (!disposed) void applyBinding(); }
    return changed;
  }

  // 聊天内预设快切：走原生切换。C-25：用户手动换预设 = 本聊天的预设绑定停用（不自动套回，也不把新预设记成绑定），
  // 正则覆盖保留；需要绑定新预设时由用户重新开启「绑定此聊天」。
  async function selectPreset(name) {
    const target = text(name);
    if (!target || presetBusy || disposed) return false;
    bumpSession();                                             // 进行中的套用作废，不会再切回旧预设
    presetBusy = true; refresh();
    let reload = false;
    try {
      reload = (await moveToPreset(target)).reload;
      const binding = currentBinding();
      if (binding.enabled && binding.preset && binding.preset !== target) {
        saveBinding({ enabled: false });
        notify(`已切换到预设「${target}」，本聊天的绑定已暂停（需要时重新开启绑定）`, 'info');
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

  // 快切里批量删预设。删掉的预设名下的绑定记录一并清掉：全局默认里的、当前聊天的（绑定的预设与它名下的正则开关）。
  // 别的聊天的记录存在各自的聊天文件里，读不到；本次打开期间进到那些聊天时再顺手清（见 applyBinding）。
  const deletedPresets = new Set();
  async function removePresets(names) {
    const list = (Array.isArray(names) ? names : []).map(text).filter(Boolean);
    if (!list.length || presetBusy || disposed) return 0;
    bumpSession();
    presetBusy = true; refresh();
    try {
      const { deleted, failed } = await deletePresets(context(), list);
      for (const name of deleted) deletedPresets.add(name);
      if (deleted.length) {
        const defaults = attempt(() => readDefaults(), {}) || {}, nextDefaults = dropPresetKeys(defaults, deleted);
        if (nextDefaults !== defaults) writeDefaults(nextDefaults);
        if (text(currentChatId())) {
          const b = currentBinding(), overrides = dropPresetKeys(b.overrides, deleted), lostPreset = deleted.includes(b.preset);
          if (lostPreset || overrides !== b.overrides) saveBinding({ overrides, ...(lostPreset ? { preset: '' } : {}) });
        }
      }
      if (failed.length) notify(deleted.length ? `已删除 ${deleted.length} 个预设，${failed.length} 个没删掉` : '预设没删掉', 'warning');
      else if (deleted.length) notify(`已删除 ${deleted.length} 个预设`, 'success');
      return deleted.length;
    } catch (error) {
      notify(error?.message || '预设没删掉', 'warning');
      return 0;
    } finally {
      presetBusy = false;
      refresh();
    }
  }

  // C-23：绑定键必须与 resolveRegexTarget 一致——预设正则带当前预设名（`preset:<预设名>:<id>`）。
  const bindKey = (source, id) => regexBindingKey(source, source === 'preset' ? readRegexSources(context()).preset.name : '', id);
  // C-23：开关被拨动后记账。开着绑定 = 记入本聊天覆盖；没开绑定 = 若该条已有全局默认基线，同步更新基线
  // （未绑定聊天的开关就是「全局态」，进其它未绑定聊天时据此复位）。
  function recordToggle(source, id, enabled) {
    if (!isRealId(id)) return;
    const key = bindKey(source, id);
    if (bindingEnabled()) { setBindingOverride({ key, enabled: enabled === true, liveEnabled: enabled !== true }); return; }
    const defaults = attempt(() => readDefaults(), {}) || {};
    if (!Object.prototype.hasOwnProperty.call(defaults, key)) return;
    writeDefaults({ ...defaults, [key]: { enabled: enabled === true } });
  }

  async function toggle({ source, id, name, enabled } = {}) {
    const key = `${source}:${id}`;
    if (pending.has(key) || writing) return null;
    bumpSession();                                             // C-25：手动开关作废进行中的套用，避免旧一轮覆盖刚拨的状态
    pending.add(key); refresh();
    try {
      const next = await writeRegexToggle(context(), { source, id, name, enabled });
      // 「懒人」绑定：开着绑定时，用户在本聊天随手拨动开关 = 记住这条。基线抓拨动前的态，其它聊天据此复位。
      recordToggle(source, id, enabled === true);
      syncNative();
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
    bumpSession();
    keys.forEach(key => pending.add(key)); refresh();
    try {
      const changed = await writeRegexStates(context(), { source, changes });
      if (changed) for (const change of changes) recordToggle(source, change.id, change.enabled);
      if (changed) { syncNative(); scheduleReload(); }
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
  // C-27：开「绑定此聊天」= 把此刻看到的一切记为本聊天的样子——当前预设＋全部正则（全局与当前预设）的开关，
  // 覆盖本聊天之前的记录；不再反向套用旧记录（避免一开绑定开关就被翻动）。之后再拨开关即静默覆盖该条记录。
  // 关闭只停用，不清记录；再打开时以「此刻」重新记一次。
  async function setBindingEnabled(on) {
    bumpSession();
    if (on !== true) { saveBinding({ enabled: false }); refresh(); return; }
    const choices = readPresetChoices(context());
    const sources = readRegexSources(context());
    const overrides = {};
    const defaults = { ...(attempt(() => readDefaults(), {}) || {}) };
    let defaultsTouched = false;
    for (const source of BINDING_SOURCES) {
      const bucket = sources[source];
      if (!bucket?.writable) continue;
      for (const item of bucket.items) {
        if (!isRealId(item.id)) continue;
        const key = regexBindingKey(source, source === 'preset' ? bucket.name : '', item.id);
        overrides[key] = { enabled: item.enabled === true };
        // 基线（全局默认）缺失的条目以此刻状态补上，保证离开本聊天时别的聊天能复位，不泄漏。
        if (!Object.prototype.hasOwnProperty.call(defaults, key)) { defaults[key] = { enabled: item.enabled === true }; defaultsTouched = true; }
      }
    }
    if (defaultsTouched) writeDefaults(defaults);
    const patch = { enabled: true, overrides };
    if (choices.available && choices.current) patch.preset = choices.current;
    saveBinding(patch);
    lastAppliedChat = text(currentChatId());   // 刚记下的就是当前状态，同一聊天无需再套用
    refresh();
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
  // C-26：清空本聊天记下的正则开关（预设绑定与「绑定此聊天」开关保持不变）。之后进本聊天按出厂开关/全局状态走。
  function clearBindingOverrides() {
    const count = Object.keys(currentBinding().overrides).length;
    if (!count) return 0;
    bumpSession();
    saveBinding({ overrides: {} });
    notify(`已清空本聊天记下的 ${count} 条正则开关`, 'success');
    refresh();
    return count;
  }
  // C-26：出厂开关。保存＝把当前预设正则的开关组合写进预设（随原生导出）；恢复＝把预设正则拨回出厂值，
  // 一次写回、一次轻量重绘；开着绑定时同时记入本聊天，保证下次进来仍是出厂值。
  // C-27：保存/恢复默认设置期间，等待态显示在预设正则各自的开关上（pending → 开关转灰禁用），而不是按钮转圈。
  // 不走 structural（它要求 pending 为空），用自己的互斥：同一时刻只跑一次，期间开关不可拨。
  let factoryBusy = false;
  async function withPresetSwitchesBusy(run) {
    if (factoryBusy || writing || disposed) return null;
    factoryBusy = true;
    const keys = (readRegexSources(context()).preset.items || []).filter(item => text(item.id)).map(item => `preset:${item.id}`);
    keys.forEach(key => pending.add(key)); refresh();
    try { return await run(); }
    catch (error) { notify(error?.message || '操作失败', 'warning'); return null; }
    finally { keys.forEach(key => pending.delete(key)); factoryBusy = false; refresh(); }
  }
  const saveFactoryDefaults = () => withPresetSwitchesBusy(async () => {
    const ctx = context();
    const manager = presetManager(ctx);
    if (typeof manager?.writePresetExtensionField !== 'function') throw new Error('当前 ST 不支持在此保存默认设置');
    const snap = snapshotRegexDefaults(readRegexSources(ctx).preset.items);
    if (!Object.keys(snap).length) throw new Error('当前预设没有可记录的正则');
    await manager.writePresetExtensionField({ name: text(manager.getSelectedPresetName?.()), path: PRESET_DEFAULTS_PATH, value: snap });
    notify(`已把 ${Object.keys(snap).length} 条预设正则的开关存为默认设置（随预设导出）`, 'success');
    return Object.keys(snap).length;
  });
  async function restoreFactoryDefaults() {
    const preset = readRegexSources(context()).preset;
    const changes = diffRegexDefaults(preset.items, preset.factory);
    if (!preset.hasFactory) { notify('当前预设还没有默认设置', 'info'); return 0; }
    if (!changes.length) { notify('已是默认设置', 'info'); return 0; }
    bumpSession();
    const changed = await withPresetSwitchesBusy(async () => {
      const out = await writeRegexStates(context(), { source: 'preset', changes, expectPreset: preset.name });
      for (const change of changes) recordToggle('preset', change.id, change.enabled);
      return out;
    });
    if (changed) { syncNative(); scheduleReload(REGEX_RELOAD_DELAY, { lightOnly: true }); notify(`已恢复 ${changed} 条正则的默认设置`, 'success'); }
    return changed || 0;
  }
  // C-26：一键允许当前预设的正则运行（ST 原生同一份允许名单）。
  function allowPreset() {
    try {
      if (allowPresetRegex(context())) { scheduleReload(REGEX_RELOAD_DELAY, { lightOnly: true }); notify('已允许当前预设的正则运行', 'success'); }
    } catch (error) { notify(error?.message || '允许失败', 'warning'); }
    refresh();
  }
  // C-26：搜索关键词只活在本次会话（视图据此过滤）。
  let query = '';
  function setQuery(value) { query = String(value ?? '').slice(0, 80); refresh(); }
  // C-16 s3：跨源移动后，把本聊天覆盖与全局默认里属于这些条目的绑定键从 旧源:id 迁到 新源:id，
  // 否则移走后旧键永久失配、新源下又没有记录，等于悄悄丢了用户的绑定。只迁移存在的键，不新建。
  function migrateBindingKeys(fromSource, toSource, moving) {
    if (fromSource === toSource) return;
    const ids = (Array.isArray(moving) ? moving : []).map(item => text(item?.id)).filter(Boolean);
    if (!ids.length) return;
    const remap = (map, prevKey, nextKey) => {
      if (!map || typeof map !== 'object' || !Object.prototype.hasOwnProperty.call(map, prevKey)) return false;
      const out = { ...map }; out[nextKey] = out[prevKey]; delete out[prevKey]; return out;
    };
    let overrides = currentBinding().overrides, overChanged = false;
    let defaults = attempt(() => readDefaults(), {}) || {}, defChanged = false;
    const presetName = readRegexSources(context()).preset.name;
    for (const id of ids) {
      // C-23：键与 resolveRegexTarget 一致（预设带预设名）；旧版缺预设名的键一并迁走。
      const next = regexBindingKey(toSource, presetName, id);
      for (const prev of [regexBindingKey(fromSource, presetName, id), `${fromSource}:${id}`]) {
        if (prev === next) continue;
        const o = remap(overrides, prev, next); if (o) { overrides = o; overChanged = true; }
        const d = remap(defaults, prev, next); if (d) { defaults = d; defChanged = true; }
      }
    }
    if (overChanged) saveBinding({ overrides });
    if (defChanged) writeDefaults(defaults);
  }
  // ── C-14f 条目管理 ──
  // 结构性写回一次只跑一个，且与开关写回互斥；成功后清掉已不存在的选择，按需排一次重载。
  // keys：本次涉及的条目（"source:id"），写回期间在视图里转圈锁定。
  async function structural(label, run, keys = []) {
    if (writing || disposed || pending.size) return null;
    writing = true;
    for (const key of keys) if (text(key)) busy.add(String(key));
    refresh();
    try {
      const out = await run(context());
      if (out?.reload) scheduleReload(REGEX_STRUCTURAL_DELAY);
      return out?.result ?? true;
    } catch (error) {
      notify(error?.message || `${label}失败`, 'warning');
      return null;
    } finally {
      writing = false; busy.clear(); syncNative();
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
  const keysOf = (items, source) => (Array.isArray(items) ? items : [])
    .filter(item => item && text(item.id)).map(item => `${source || item.source}:${item.id}`);
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
    // C-22：删掉的行连同手动归属一起记下（还原时放回），并从归属表里清除。
    if (staged.length) {
      const assign = currentAssign();
      const gone = [];
      staged.forEach(entry => {
        const id = text(entry.script?.id);
        entry.hadAssign = !!id && Object.prototype.hasOwnProperty.call(assign, id);
        entry.assign = entry.hadAssign ? assign[id] : undefined;
        if (entry.hadAssign) gone.push(id);
      });
      if (gone.length) saveAssign(setRegexAssign(assign, gone, undefined));
      refresh();
    }
    if (count) { removed.push(...staged); notify(`已删除 ${count} 条正则，可在回收站还原`, 'success'); }
    return { reload, result: count };
  }, keysOf(items));
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
    // C-22：还原的条目恢复删除前的手动归属（原位插回，所以原组仍是连续的）。
    let assign = currentAssign(), touched = false;
    for (const entry of chosen) {
      if (!done.has(entry.key) || !entry.hadAssign || !text(entry.script?.id)) continue;
      assign = setRegexAssign(assign, [text(entry.script.id)], entry.assign); touched = true;
    }
    if (touched) saveAssign(assign);
    for (let i = removed.length - 1; i >= 0; i -= 1) if (done.has(removed[i].key)) removed.splice(i, 1);
    if (!removed.length) recycleOpen = false;
    refresh();
    return { reload, result: count };
  });
  function setRecycle(on) { recycleOpen = on === true && removed.length > 0; if (recycleOpen) { managing = false; selected.clear(); picking = []; } refresh(); }
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
  }, keysOf(items));
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
  // C-20：快速连点会两次打到同一个把手上——第二次若当成「再次拾取」就会把刚拾起的状态取消，落点随之消失，
  // 用户接着点原位置就会感觉「移不动」。同一组在 350ms 内的重复拾取视为误触，直接忽略。
  let lastPick = { key: '', at: 0 };
  function pickMove({ source, items } = {}) {
    if (writing || disposed) return;
    const list = (Array.isArray(items) ? items : [])
      .filter(item => item && BINDING_SOURCES.includes(source) && text(item.id))
      .map(item => ({ source, id: text(item.id), name: text(item.name) }));
    if (!list.length) return;
    const sig = `${source}|${list.map(item => item.id).join(',')}`;
    const now = attempt(() => performance.now(), 0) || Date.now();
    if (sig === lastPick.key && now - lastPick.at < 350) return;
    lastPick = { key: sig, at: now };
    const same = picking.length === list.length
      && picking.every((p, i) => p.source === list[i].source && p.id === list[i].id);
    picking = same ? [] : list;
    if (picking.length) notify('请选择移动位置', 'info');
    refresh();
  }
  function cancelPick() { if (picking.length) { picking = []; refresh(); } }
  // 落定：把拾取（或拖拽传入）的条目移到目标位 before 之前（before 省略＝移到末尾）；完成后清空拾取。
  // 同源＝排序（moveRegexEntries）；跨源（预设↔全局）＝先插目标、后删源，绝不半途丢条目。
  // 目标位按 id 在原始数组里定位（跨「原始顺序 / 自动分组」两种视图都正确），拖拽与点插入走同一路径。
  // C-22：落点决定分组归属——group 非空（组内首位/成员之间/组内末尾）= 加入该组；
  // group 为空（组头之前、散条之间、列表末尾）= 离开分组（必要时明确标「不分组」，自动折叠不会再把它拉回去）。
  // members = 落点所在组移动前的成员（视图传入），自动组被插入时用来整组转成自定义。
  const dropMove = ({ source, items, before = null, group = '', members = [] } = {}) => {
    const chosen = (Array.isArray(items) && items.length ? items : picking).filter(item => item && text(item.id));
    picking = [];
    lastPick = { key: '', at: 0 };   // 落定后连点去抖作废，下一次拾取同一条立即生效
    if (!chosen.length) { refresh(); return null; }
    // 拾取的条目当前所在来源（pickMove 为每条打上 source）；缺失时按落点来源处理（同源）。
    const origin = BINDING_SOURCES.includes(text(chosen[0].source)) ? chosen[0].source : source;
    const moving = chosen.map(item => ({ id: item.id, name: item.name }));
    const movingIds = moving.map(item => text(item.id)).filter(isRealId);
    const join = text(group).replace(/[【】[\]]/gu, '').trim();
    // C-22：落点决定归属——组内落点＝加入该组；若该组是自动组，整组成员一起转成自定义（否则插入会把它拆散）。
    // 成员取「移动之前」的显示分段：视图传入落点所在组的成员；没传时按组名在目标来源里找。
    const targetMembers = !join ? [] : (Array.isArray(members) && members.length
      ? members.map(text)
      : runsOf(source).filter(run => run.label === join).flatMap(run => run.items.map(item => text(item.id)))).filter(isRealId);
    // 整组拖到组外（组头把手）= 搬动这个组，不是解散：保留原归属。
    const movingSet = new Set(moving.map(item => text(item.id)));
    const wholeRun = !join && runsOf(origin).some(run => run.label && run.items.length === movingSet.size && run.items.every(item => movingSet.has(text(item.id))));
    // 移动写完后结算归属；返回是否真的改了归属。
    const settle = dest => {
      const prev = currentAssign();
      let next = prev;
      if (join) next = setRegexAssign(prev, [...targetMembers, ...movingIds], join);
      else if (!wholeRun) {
        // 组外落点：先清掉手动归属；若落点处的自动折叠仍会把它算进某组，就明确标「不分组」——自定义优先于自动。
        next = setRegexAssign(prev, movingIds, undefined);
        const runs = groupRegexRuns(readRegexSources(context())[dest]?.items || [], next);
        const stuck = movingIds.filter(id => runs.some(run => run.label && run.items.some(item => text(item.id) === id)));
        if (stuck.length) next = setRegexAssign(next, stuck, REGEX_NO_GROUP);
      }
      if (sameAssign(prev, next)) return false;
      saveAssign(next);
      return true;
    };
    const anchorIndex = (raw, by) => by && text(by.id)
      ? (() => { const at = locateRegexScript(raw, by); if (at < 0) throw stale(); return at; })()
      : raw.length;
    if (origin === source) {
      return structural('调整顺序', async ctx => {
        let moved = false;
        const out = await editRegexList(ctx, source, raw => {
          const indices = locateIndices(raw, moving);
          const next = moveRegexEntries(raw, indices, anchorIndex(raw, before));
          if (next.every((script, i) => script === raw[i])) return { next: null, result: false };
          moved = true;
          return { next, touched: indices.map(i => raw[i]), result: true };
        });
        // 顺序没变也要结算归属（例如组末尾那条落到组外紧邻处 = 只是移出分组）。
        const grouped = settle(source);
        if (moved) syncNative();
        if (moved || grouped) notify(moved ? `${moving.length} 项已移至指定位置` : join ? `${moving.length} 项已加入分组「${join}」` : `${moving.length} 项已移出分组`, 'success');
        else notify('位置没有变化', 'info');
        return { ...out, result: moved || grouped };
      }, keysOf(moving, source));
    }
    // 跨源：先把整批（保留 id 的深拷贝）插入目标源，成功后再从原源删除，最后迁移绑定键。
    // 若第二步删除失败，目标已存一份、原源仍在 —— 条目绝不丢失，只是重复，提示 warning 由 structural 兜底。
    return structural('移动正则', async ctx => {
      const fromList = readRawList(ctx, origin);
      const pickIdx = locateIndices(fromList, moving);
      if (pickIdx.length !== moving.length) throw stale();
      const scripts = pickIdx.map(i => structuredClone(fromList[i]));
      const destOut = await editRegexList(ctx, source, raw => {
        const next = [...raw]; next.splice(anchorIndex(raw, before), 0, ...scripts);
        return { next, touched: scripts, result: scripts.length };
      });
      const srcOut = await editRegexList(ctx, origin, raw => {
        const idx = locateIndices(raw, moving);
        const { next } = removeRegexEntries(raw, idx);
        return { next, touched: idx.map(i => raw[i]), result: idx.length };
      });
      migrateBindingKeys(origin, source, moving);
      settle(source);
      notify(`${moving.length} 项已移至${source === 'preset' ? '预设' : '全局'}`, 'success');
      return { reload: destOut.reload || srcOut.reload, result: moving.length };
    }, keysOf(moving, origin));
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
    return { next, touched: [raw[index], entry], result: entry.id };
  }), keysOf([{ id }], source));
  // C-18：双击改名——只改名字，其它字段不动。
  const rename = ({ source, id, name, to } = {}) => {
    const next = text(to);
    if (!next || next === text(name)) return Promise.resolve(false);
    return saveScript({ source, id, name, script: { scriptName: next } });
  };
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
  }, keysOf(items));
  // C-22：移入分组（多选栏 / 编辑页分组栏）= 设自定义归属，并把条目挪到该组现有最后一段的末尾
  // （组还不存在时收拢到第一条所在位置），这样它们在真实顺序里也连成一段。条目名字不再被改动。
  // tag 空 = 清除手动归属，回到自动折叠（不挪位置）。
  const retag = ({ items, tag = '' } = {}) => {
    const targets = (Array.isArray(items) ? items : []).filter(item => item && text(item.id));
    return structural('调整分组', async ctx => {
      const label = text(tag).replace(/[【】[\]]/gu, '').trim();
      if (!targets.length) return { reload: false, result: 0 };
      const ids = targets.map(item => text(item.id)).filter(isRealId);
      if (!ids.length) throw new Error('这几条正则没有固定 id，无法手动分组');
      const next = setRegexAssign(currentAssign(), ids, label || undefined);
      saveAssign(next);
      let reload = false;
      if (label) {
        for (const [source, list] of bySource(targets)) {
          const out = await editRegexList(ctx, source, raw => {
            const indices = locateIndices(raw, list);
            const rows = raw.map((script, i) => summarizeRegexScript(script, i));
            const runs = groupRegexRuns(rows, next).filter(run => run.label === label);
            const pick = new Set(indices.map(i => rows[i].id));
            // 已经都在同一段该组里：不挪。
            if (runs.length === 1 && [...pick].every(id => runs[0].items.some(item => item.id === id))) return { next: null, result: 0 };
            const moved = moveRegexEntries(raw, indices, regexGroupInsertIndex(rows, indices, label, next));
            if (moved.every((script, i) => script === raw[i])) return { next: null, result: 0 };
            return { next: moved, touched: indices.map(i => raw[i]), result: indices.length };
          });
          reload ||= out.reload;
        }
        syncNative();
      }
      refresh();
      return { reload, result: targets.length };
    }, keysOf(targets));
  };
  // C-22：组名改名（双击）。members = 这一段组的成员：全部改归新名（自动组改名即转成自定义）；
  // 同名自定义组被拆成多段时，其余段一起改名。to 为空 = 取消自定义，回到自动折叠。
  const renameGroup = ({ from = '', to = '', members = [] } = {}) => structural('分组改名', async () => {
    const label = text(to).replace(/[【】[\]]/gu, '').trim();
    const ids = (Array.isArray(members) ? members : []).map(item => text(item?.id ?? item)).filter(isRealId);
    let next = currentAssign();
    if (!label) {
      next = setRegexAssign(next, [...ids, ...Object.keys(next).filter(id => next[id] === text(from))], undefined);
    } else {
      if (text(from)) next = renameRegexAssign(next, from, label);
      next = setRegexAssign(next, ids, label);
    }
    saveAssign(next);
    refresh();
    return { reload: false, result: true };
  });
  // C-22：取消自定义分组——该组（含被拆开的同名段）的手动归属全部清除，回到自动折叠。
  const unfixGroup = ({ name, members = [] } = {}) => {
    const label = text(name);
    if (!label) return false;
    const now = currentAssign();
    const ids = [...(Array.isArray(members) ? members : []).map(item => text(item?.id ?? item)), ...Object.keys(now).filter(id => now[id] === label)];
    saveAssign(setRegexAssign(now, ids, undefined));
    refresh();
    return true;
  };
  // C-19：管理态与回收站互斥——打开一个就关掉另一个，避免两套状态同时挂着互相打架。
  function setManaging(on) { managing = on === true; if (managing) recycleOpen = false; if (!managing) { selected.clear(); picking = []; } refresh(); }
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
  // C-17 s5：导入到指定来源末尾（可一次选多个文件）。先选文件、再走与其它管理操作相同的写回路径：一次保存、不半写。
  async function importMany({ source = 'global' } = {}) {
    if (writing || disposed) return null;
    let texts;
    try {
      if (!BINDING_SOURCES.includes(source)) throw new Error('未知的正则来源');
      readRawList(context(), source);                           // 来源不可写时先报错，不让用户白选文件
      texts = await pickFiles();
    } catch (error) { notify(error?.message || '导入正则失败', 'warning'); return null; }
    if (!Array.isArray(texts) || !texts.length) return 0;
    let skipped = 0;
    const count = await structural('导入正则', async ctx => {
      const out = await editRegexList(ctx, source, raw => {
        const taken = BINDING_SOURCES.flatMap(key => attempt(() => readRawList(ctx, key), [])).map(script => script?.id);
        const parsed = parseRegexImport(texts, { taken });
        skipped = parsed.skipped;
        if (!parsed.scripts.length) return { next: null, result: 0 };
        return { next: [...raw, ...parsed.scripts], touched: parsed.scripts, result: parsed.scripts.length };
      });
      return { reload: out.reload, result: out.result || 0 };
    });
    if (count === null) return null;
    if (count) notify(`已导入 ${count} 条正则到${source === 'preset' ? '预设' : '全局'}${skipped ? `，跳过 ${skipped} 项无效内容` : ''}`, 'success');
    else notify('没有找到可导入的正则', 'warning');
    return count;
  }
  // 导出选中的条目（只读，不经写回锁）：单条 = ST 原生单文件格式，多条 = 一个数组文件。
  async function exportMany({ items } = {}) {
    try {
      const scripts = [];
      for (const [source, list] of bySource(items)) {
        const raw = readRawList(context(), source);
        for (const index of locateIndices(raw, list).sort((x, y) => x - y)) scripts.push(structuredClone(raw[index]));
      }
      const file = buildRegexExport(scripts);
      if (!file) return 0;
      await saveFile(file);
      notify(`已导出 ${scripts.length} 条正则`, 'success');
      return scripts.length;
    } catch (error) {
      notify(error?.message || '导出正则失败', 'warning');
      return null;
    }
  }

  const actions = Object.freeze({
    views: REGEX_VIEWS,
    placements: REGEX_PLACEMENTS,
    // C-22：按真实顺序分段——自定义归属优先，其余相邻同类自动折叠。
    group: (items, assign) => groupRegexRuns(items, assign ?? currentAssign()),
    customGroupNames: () => [...new Set(Object.values(currentAssign()).filter(Boolean))],
    familyKey: regexFamilyKey,
    tagName: tagRegexName,
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
    deletePresets: removePresets,
    readScript, removeMany, undoRemove, setRecycle, copyMany, move, moveRow, pickMove, cancelPick, dropMove, insert, saveScript, rename, regroup, retag,
    setManaging, setSelected, openEditor, closeEditor, importMany, exportMany,
    renameGroup, unfixGroup,
    clearBindingOverrides, saveFactoryDefaults, restoreFactoryDefaults, allowPreset, setQuery,
    matches: regexMatchesQuery,
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
  // C-25：只有聊天真的换了才作废进行中的一轮并按「进入新聊天」处理（会切一次绑定预设）；
  // 同一聊天的 CHAT_CHANGED（reloadCurrentChat 的回声）只做正则对齐，不再切预设。
  let seenChat = '';
  const events = Object.freeze({
    chatChanged: () => {
      const now = text(currentChatId());
      const entering = now !== seenChat;
      seenChat = now;
      if (entering) { bumpSession(); lastAppliedChat = ''; }
      void applyBinding({ entering });
    },
    presetChanged: () => { refresh(); },
  });
  // Warms the view module only (no mount, no data read) so the first open does not wait on a download.
  const preload = () => loadView().then(() => true, () => false);
  return Object.freeze({ mount, unmount, dispose, actions, state, applyBinding, events, preload });
}
