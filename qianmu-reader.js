// 千幕 · 伴读模块纯逻辑层（解析 / 分章 / 切片）
// 类比 features/tts/qianmu-tts.js：不碰 DOM、不读 settings、不依赖 index.js，纯函数 + 数据。
// 仅负责把「一段文本/一个文件」变成可阅读的章节结构 + 可召回的切片，召回打分另由调用方组合。
// 漫画识图的纯逻辑单独成文件，随本模块一并按需载入。
export * from './qianmu-reader-comic.js';

/* ============================================================
   一、TXT 编码嗅探
   浏览器 TextDecoder 支持 utf-8 / utf-16le / utf-16be / gbk / gb18030 / big5。
   先看 BOM，无 BOM 则各编码各解一遍，按「乱码评分」取最低分（替换符/空字符/控制符越少越好）。
   ============================================================ */

const TXT_ENCODINGS = ['utf-8', 'gb18030', 'big5', 'utf-16le', 'utf-16be'];

// 乱码评分：U+FFFD 替换符权重最高，其次 NUL，再次非常规控制符。分越低越像正常文本。
function scoreDecodedTextQuality(text) {
  if (!text) return Number.POSITIVE_INFINITY;
  let score = 0;
  const len = text.length;
  for (let i = 0; i < len; i++) {
    const code = text.charCodeAt(i);
    if (code === 0xFFFD) score += 1000;
    else if (code === 0) score += 200;
    else if (code < 9 || (code > 13 && code < 32)) score += 10;   // 排除 \t\n\r 之外的控制符
  }
  // 归一化到密度，避免长文本天然分高；空文本视为极差
  return len ? score / len : Number.POSITIVE_INFINITY;
}

// 从 ArrayBuffer 解码 TXT，自动选最优编码。返回字符串。
export function decodeTxtBuffer(buffer) {
  const bytes = new Uint8Array(buffer);
  // BOM 检测
  if (bytes.length >= 3 && bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF) {
    return new TextDecoder('utf-8').decode(bytes.subarray(3));
  }
  if (bytes.length >= 2 && bytes[0] === 0xFF && bytes[1] === 0xFE) {
    return new TextDecoder('utf-16le').decode(bytes.subarray(2));
  }
  if (bytes.length >= 2 && bytes[0] === 0xFE && bytes[1] === 0xFF) {
    return new TextDecoder('utf-16be').decode(bytes.subarray(2));
  }
  // 无 BOM：各编码试解，取乱码评分最低者
  let best = null, bestScore = Number.POSITIVE_INFINITY;
  for (const enc of TXT_ENCODINGS) {
    let decoded;
    try { decoded = new TextDecoder(enc).decode(bytes); }
    catch (_) { continue; }
    const sc = scoreDecodedTextQuality(decoded);
    if (sc < bestScore) { bestScore = sc; best = decoded; }
  }
  return best != null ? best : new TextDecoder('utf-8').decode(bytes);
}

/* ============================================================
   二、排版归一化
   统一中英文引号撇号、全角空格、压缩多余空行；不动正文语义。
   ============================================================ */

export function normalizeTextBlock(text) {
  let s = String(text || '');
  s = s.replace(/\r\n?/g, '\n');            // 统一换行
  s = s.replace(/　/g, '  ');           // 全角空格 → 两个半角（保留缩进感）
  s = s.replace(/ /g, ' ');            // 不间断空格
  s = s.replace(/[\t ]+\n/g, '\n');         // 行尾空白
  s = s.replace(/\n{3,}/g, '\n\n');         // 连续空行压到最多一个空行
  return s.trim();
}

/* ============================================================
   三、分章
   多套常见中文/英文章节正则；命中则按标题切分，未命中再按字数兜底。
   分章只服务「翻页阅读」——分错不影响记忆质量（记忆走句界滑窗切片，见第四节）。
   ============================================================ */

// 章节标题行的识别正则（逐行判定，需整行基本就是标题）。
const CHAPTER_PATTERNS = [
  // 第X章/卷/回/节/部/篇/集/幕（含中文数字与阿拉伯数字）
  /^\s{0,6}第\s*[0-9零一二三四五六七八九十百千万两壹贰叁肆伍陆柒捌玖拾佰仟]+\s*[章卷回节節部篇集幕折][^\n]{0,40}$/,
  // 序章/楔子/序言/前言/引子/后记/尾声/番外/终章 等特殊段
  /^\s{0,6}(序章|序言|序|楔子|引子|前言|后记|後記|尾声|尾聲|终章|終章|番外|后序|跋|附录|附錄|内容简介|作品相关)[^\n]{0,40}$/,
  // Chapter N / CHAPTER N
  /^\s{0,6}(chapter|CHAPTER|Chapter)\s+[0-9IVXLCDM]+[^\n]{0,40}$/,
  // 纯阿拉伯数字编号标题（1. / 01 / 1、）——较弱，放最后
  /^\s{0,6}[0-9]{1,3}\s*[、.．]\s*\S[^\n]{0,40}$/,
];

function looksLikeChapterTitle(line) {
  const t = line.trim();
  if (!t || t.length > 50) return false;
  return CHAPTER_PATTERNS.some((re) => re.test(t));
}

// 主分章入口。返回 [{ title, content }]。
// minChapters：低于此章数视为分章失败，退回字数兜底；fallbackCharCount：兜底每章字数。
export function splitChapters(text, opts = {}) {
  const minChapters = opts.minChapters ?? 2;
  const fallbackCharCount = clampCharCount(opts.fallbackCharCount ?? 2400);
  const normalized = normalizeTextBlock(text);
  if (!normalized) return [{ title: '全文', content: '' }];

  const lines = normalized.split('\n');
  const chapters = [];
  let cur = null;
  let preface = [];   // 第一个标题之前的内容（序/无题开头）

  for (const line of lines) {
    if (looksLikeChapterTitle(line)) {
      if (cur) chapters.push(cur);
      cur = { title: line.trim(), content: '' };
    } else if (cur) {
      cur.content += (cur.content ? '\n' : '') + line;
    } else {
      preface.push(line);
    }
  }
  if (cur) chapters.push(cur);

  // 把开头无题内容并为「前言」章（仅当确有正文时）
  const prefaceText = preface.join('\n').trim();
  if (prefaceText) chapters.unshift({ title: '前言', content: prefaceText });

  // 清理空章节
  const cleaned = chapters
    .map((c) => ({ title: c.title || '无题', content: c.content.trim() }))
    .filter((c) => c.content.length > 0);

  if (cleaned.length >= minChapters) return cleaned;

  // 分章失败 → 字数兜底
  return splitByCharCount(normalized, fallbackCharCount);
}

function clampCharCount(n) {
  const v = Number(n) || 2400;
  return Math.max(500, Math.min(50000, v));
}

// 按字数切分，每段尽量收在「安全句界」上。
export function splitByCharCount(text, charCount = 2400) {
  const target = clampCharCount(charCount);
  const s = normalizeTextBlock(text);
  if (!s) return [{ title: '全文', content: '' }];
  const chapters = [];
  let start = 0;
  let idx = 1;
  while (start < s.length) {
    let end = Math.min(start + target, s.length);
    if (end < s.length) end = pickSafeBoundary(s, end);
    const content = s.slice(start, end).trim();
    if (content) chapters.push({ title: `第 ${idx} 节`, content });
    idx++;
    start = end;
  }
  return chapters.length ? chapters : [{ title: '全文', content: s }];
}

/* ============================================================
   四、句界滑窗切片（给记忆/召回用，不依赖章节边界）
   512 字符目标 / 64 重叠 / 不跨章；每片结尾推到最近句界。
   回避小数点、列表序号、缩写造成的假句界。
   ============================================================ */

const CHUNK_SIZE = 512;
const CHUNK_OVERLAP = 64;
const MIN_CHUNK_TEXT_LENGTH = 20;

// 句末标点（中英）
const SENTENCE_ENDINGS = new Set(['。', '！', '？', '…', '.', '!', '?', ';', '；', '\n']);
// 句末标点后允许跟随并一并纳入的闭合符
const TRAILING_CLOSERS = new Set(['」', '』', '）', ')', ']', '】', '"', '”', '’', '》']);

// 判断 s[i] 处是否为安全句界（i 指向句末标点的下一个位置作为切点）
function isSafeSentenceEnd(s, i) {
  const ch = s[i - 1];
  if (!SENTENCE_ENDINGS.has(ch)) return false;
  // 小数点 3.14：句号两侧都是数字 → 不算
  if (ch === '.' && /[0-9]/.test(s[i - 2] || '') && /[0-9]/.test(s[i] || '')) return false;
  return true;
}

// 从 from 起向最近句界对齐：先向前找，找不到再向后找；都没有则返回 from。
function pickSafeBoundary(s, from) {
  const back = 120, fwd = 180;
  for (let i = from; i > from - back && i > 0; i--) {
    if (isSafeSentenceEnd(s, i)) return swallowClosers(s, i);
  }
  for (let i = from; i < from + fwd && i < s.length; i++) {
    if (isSafeSentenceEnd(s, i)) return swallowClosers(s, i);
  }
  return from;
}

// 句末标点后若紧跟闭合引号/括号，连同纳入
function swallowClosers(s, i) {
  let j = i;
  while (j < s.length && TRAILING_CLOSERS.has(s[j])) j++;
  return j;
}

// 对单章正文做切片。返回 [{ text, start, end }]（start/end 为章内偏移）。
export function chunkChapterText(text, opts = {}) {
  const size = opts.size || CHUNK_SIZE;
  const overlap = opts.overlap ?? CHUNK_OVERLAP;
  const step = Math.max(1, size - overlap);
  const s = String(text || '');
  const chunks = [];
  let start = 0;
  while (start < s.length) {
    let end = Math.min(start + size, s.length);
    if (end < s.length) end = pickSafeBoundary(s, end);
    if (end <= start) end = Math.min(start + size, s.length);   // 防呆
    const slice = s.slice(start, end).trim();
    if (slice.length >= MIN_CHUNK_TEXT_LENGTH) chunks.push({ text: slice, start, end });
    if (end >= s.length) break;
    start = Math.max(end - overlap, start + step);
  }
  return chunks;
}

// 跨全书切片（带 chapterIndex）。chapters=[{title,content}]。
export function chunkBook(chapters, opts = {}) {
  const out = [];
  (chapters || []).forEach((ch, ci) => {
    for (const c of chunkChapterText(ch.content || '', opts)) {
      out.push({ chapterIndex: ci, chapterTitle: ch.title || '', text: c.text, start: c.start, end: c.end });
    }
  });
  return out;
}

/* ============================================================
   五、内容签名（FNV-1a）—— 判断书内容是否变更、是否需重建索引
   ============================================================ */

export function contentSignature(text) {
  let h = 0x811c9dc5;
  const s = String(text || '');
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16) + ':' + s.length;
}

/* ============================================================
   六、统计工具
   ============================================================ */

export function countChars(text) {
  return String(text || '').length;
}

export function totalChars(chapters) {
  return (chapters || []).reduce((sum, c) => sum + countChars(c.content), 0);
}

/* ============================================================
   七、共读记忆来源与防剧透水位（纯数据层）
   ============================================================ */

export const COREAD_SLICE_SCHEMA_VERSION = 3;

// 对外统一为三种用户可理解的来源；mixed 只用于旧切片被跨来源合并后的兼容记录。
export function normalizeCoreadSource(source) {
  const raw = String(source || '').toLowerCase();
  if (raw === 'text' || raw === 'book') return 'book';
  if (raw === 'mainline') return 'mainline';
  if (raw === 'mixed') return 'mixed';
  return 'dialog';
}

function finiteOrNull(value) {
  if (value == null || value === '') return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function cleanPositiveInts(values) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map((value) => Math.round(Number(value)))
    .filter((value) => Number.isFinite(value) && value > 0))]
    .sort((a, b) => a - b);
}

// 旧切片在载入时补齐 provenance；不删除旧字段，保证已发布版本仍能读取同一份导出数据。
export function normalizeCoreadSlice(rawSlice, context = {}) {
  const raw = rawSlice && typeof rawSlice === 'object' ? rawSlice : {};
  const oldProvenance = raw.provenance && typeof raw.provenance === 'object' ? raw.provenance : {};
  const source = normalizeCoreadSource(oldProvenance.source || raw.src);
  const coveredFrom = finiteOrNull(raw.coveredFrom);
  const coveredTo = finiteOrNull(raw.coveredTo);
  const fallbackBoundary = context.boundary && typeof context.boundary === 'object' ? context.boundary : {};
  const createdAt = finiteOrNull(oldProvenance.createdAt) ?? finiteOrNull(raw.ts) ?? Date.now();
  // 书中内容的 coveredTo 是不可放宽的硬边界：即使旧元数据写过更小 readTo，也不能提前放行。
  const storedReadTo = finiteOrNull(oldProvenance.readTo);
  const readTo = source === 'book'
    ? (coveredTo ?? storedReadTo ?? finiteOrNull(fallbackBoundary.readTo))
    : (storedReadTo ?? finiteOrNull(fallbackBoundary.readTo));
  const sources = [...new Set((Array.isArray(oldProvenance.sources) ? oldProvenance.sources : [source])
    .map(normalizeCoreadSource))];
  const provenance = {
    version: COREAD_SLICE_SCHEMA_VERSION,
    source,
    sources,
    bookId: String(oldProvenance.bookId || context.bookId || ''),
    bucket: String(oldProvenance.bucket || context.bucket || ''),
    createdAt,
    readTo,
    readChapter: finiteOrNull(oldProvenance.readChapter) ?? finiteOrNull(fallbackBoundary.chapterIndex),
    readProgress: finiteOrNull(oldProvenance.readProgress) ?? finiteOrNull(fallbackBoundary.progress),
    charFrom: finiteOrNull(oldProvenance.charFrom) ?? (source === 'book' ? coveredFrom : null),
    charTo: finiteOrNull(oldProvenance.charTo) ?? (source === 'book' ? coveredTo : null),
    chapterFrom: finiteOrNull(oldProvenance.chapterFrom),
    chapterTo: finiteOrNull(oldProvenance.chapterTo),
    dialogFrom: finiteOrNull(oldProvenance.dialogFrom) ?? (source === 'dialog' ? coveredFrom : null),
    dialogTo: finiteOrNull(oldProvenance.dialogTo) ?? (source === 'dialog' ? coveredTo : null),
    dialogArchived: oldProvenance.dialogArchived === true,
    dialogMessageIds: [...new Set((Array.isArray(oldProvenance.dialogMessageIds) ? oldProvenance.dialogMessageIds : [])
      .map((value) => String(value || '')).filter(Boolean))],
    mainlineFloors: cleanPositiveInts(oldProvenance.mainlineFloors || raw.mainlineFloors),
  };
  return {
    ...raw,
    src: source === 'book' ? 'text' : source,
    ts: finiteOrNull(raw.ts) ?? createdAt,
    provenance,
  };
}

// 防剧透判断只看切片形成时已知到哪里；正文切片天然以 coveredTo 为硬边界。
// 旧数据首次载入时尽量以当前读位补迁移水位；若仍无法确认，则在保护开启时保守隔离。
export function isCoreadSliceVisibleAtBoundary(slice, boundary, protectionEnabled = true) {
  if (!protectionEnabled) return true;
  const current = finiteOrNull(boundary?.readTo);
  const normalized = normalizeCoreadSlice(slice, { boundary });
  const knowledgeEnd = finiteOrNull(normalized.provenance?.readTo);
  // 开启保护但任一侧没有可比较水位时采取保守隔离；用户可显式关闭开关恢复全部旧数据。
  if (current == null || knowledgeEnd == null) return false;
  return knowledgeEnd <= current;
}

export function filterCoreadSlicesAtBoundary(slices, boundary, protectionEnabled = true) {
  return (Array.isArray(slices) ? slices : [])
    .filter((slice) => isCoreadSliceVisibleAtBoundary(slice, boundary, protectionEnabled));
}

// 伴读对谈切片的消息区间。纯 dialog 可参与“重新总结替换”；mixed 仅可用于
// 计算连续覆盖水位，避免跨来源压缩后重复总结已经写入融合记忆的对话。
function coreadDialogRange(rawSlice, includeMixed = false) {
  const slice = normalizeCoreadSlice(rawSlice);
  if (slice.provenance?.dialogArchived === true) return null;
  const source = normalizeCoreadSource(slice.provenance?.source || slice.src);
  const sources = Array.isArray(slice.provenance?.sources)
    ? slice.provenance.sources.map(normalizeCoreadSource)
    : [source];
  if (source !== 'dialog' && !(includeMixed && sources.includes('dialog'))) return null;
  const from = finiteOrNull(slice.provenance?.dialogFrom)
    ?? (source === 'dialog' ? finiteOrNull(slice.coveredFrom) : null);
  const to = finiteOrNull(slice.provenance?.dialogTo)
    ?? (source === 'dialog' ? finiteOrNull(slice.coveredTo) : null);
  if (from == null || to == null) return null;
  return {
    from: Math.max(0, Math.floor(Math.min(from, to))),
    to: Math.max(0, Math.floor(Math.max(from, to))),
  };
}

// 求手动总结区间与既有对谈切片的重叠闭包。
// 例：新范围命中 A，A 扩展后又命中 B，则 A/B 必须一起确认、一起替换，不能只算第一层。
export function expandCoreadDialogRange(slices, fromIndex, toIndex) {
  const rawFrom = finiteOrNull(fromIndex);
  const rawTo = finiteOrNull(toIndex);
  if (rawFrom == null || rawTo == null) return { from: 0, to: -1, overlaps: [] };
  let from = Math.max(0, Math.floor(Math.min(rawFrom, rawTo)));
  let to = Math.max(0, Math.floor(Math.max(rawFrom, rawTo)));
  const candidates = (Array.isArray(slices) ? slices : [])
    .map((slice) => ({ slice, range: coreadDialogRange(slice, false) }))
    .filter((item) => item.range)
    .sort((a, b) => (a.range.from - b.range.from) || (a.range.to - b.range.to));
  const selected = new Set();
  let changed = true;
  while (changed) {
    changed = false;
    for (const item of candidates) {
      if (selected.has(item.slice) || item.range.from > to || item.range.to < from) continue;
      selected.add(item.slice);
      const nextFrom = Math.min(from, item.range.from);
      const nextTo = Math.max(to, item.range.to);
      changed = nextFrom !== from || nextTo !== to || changed;
      from = nextFrom;
      to = nextTo;
    }
  }
  return { from, to, overlaps: candidates.filter((item) => selected.has(item.slice)).map((item) => item.slice) };
}

// cursor 表示“从 summaryFloor 开始已被连续覆盖到哪里”，而不是曾总结过的最大下标。
// 中间有空洞就停在空洞前，避免手动总结后段时让自动总结永久跳过前段。
export function calculateCoreadDialogCursor(slices, messageCount, summaryFloor = 0) {
  const count = Math.max(0, Math.floor(Number(messageCount) || 0));
  let cursor = Math.max(0, Math.min(count, Math.floor(Number(summaryFloor) || 0)));
  const ranges = (Array.isArray(slices) ? slices : [])
    .map((slice) => coreadDialogRange(slice, true))
    .filter(Boolean)
    .sort((a, b) => (a.from - b.from) || (a.to - b.to));
  for (const range of ranges) {
    if (range.to < cursor) continue;
    if (range.from > cursor) break;
    cursor = Math.min(count, Math.max(cursor, range.to + 1));
    if (cursor >= count) break;
  }
  return cursor;
}

// 把一串条目按字数上限切成连续批次，返回各批的条目下标闭区间 [{from, to}]。
// 只增加批次、不裁内容：单条超过上限时独占一批；空条目（长度 0）并入相邻批次。
// cap ≤ 0 表示不限，整串一批；joinCost 是拼接时每两条非空条目之间的分隔符字数。
export function planCoreadBatches(lengths, cap, joinCost = 0) {
  const list = Array.isArray(lengths) ? lengths : [];
  if (!list.length) return [];
  const limit = Math.floor(Number(cap) || 0);
  const join = Math.max(0, Math.floor(Number(joinCost) || 0));
  const batches = [];
  let from = 0;
  let used = 0;
  let filled = false;
  for (let i = 0; i < list.length; i++) {
    const len = Math.max(0, Math.floor(Number(list[i]) || 0));
    if (!len) continue;
    if (limit > 0 && filled && used + join + len > limit) {
      batches.push({ from, to: i - 1 });
      from = i;
      used = 0;
      filled = false;
    }
    used += (filled ? join : 0) + len;
    filled = true;
  }
  batches.push({ from, to: list.length - 1 });
  return batches;
}

// 把正文 [from, to) 切成连续字符区间 [{from, to}]，每段不超过 cap 字（cap ≤ 0 整段一批）。
// 优先在换行处分段；单行超过上限时按上限硬切——正文硬切只增加批次，不丢字。
export function planCoreadTextSpans(text, from, to, cap) {
  const source = String(text || '');
  const start = Math.max(0, Math.min(source.length, Math.floor(Number(from) || 0)));
  const end = Math.max(start, Math.min(source.length, Math.floor(Number(to) || 0)));
  if (end <= start) return [];
  const limit = Math.floor(Number(cap) || 0);
  if (limit <= 0) return [{ from: start, to: end }];
  const lengths = [];
  let pos = start;
  while (pos < end) {
    const newline = source.indexOf('\n', pos);
    const lineEnd = newline < 0 || newline >= end ? end : newline + 1;
    let rest = lineEnd - pos;
    while (rest > limit) { lengths.push(limit); rest -= limit; }
    if (rest > 0) lengths.push(rest);
    pos = lineEnd;
  }
  const offsets = [start];
  for (const len of lengths) offsets.push(offsets[offsets.length - 1] + len);
  return planCoreadBatches(lengths, limit).map((batch) => ({ from: offsets[batch.from], to: offsets[batch.to + 1] }));
}

// 已读正文 [0, upTo) 中尚未被正文切片覆盖的字符区间。融合切片按其记录的正文范围计入。
// 用区间并集而不是「最大 coveredTo」：全书蒸馏之后，没蒸到的段落仍能被增量蒸馏补上。
export function coreadUncoveredTextRanges(slices, upTo) {
  const end = Math.max(0, Math.floor(Number(upTo) || 0));
  const covered = [];
  for (const raw of (Array.isArray(slices) ? slices : [])) {
    const provenance = raw?.provenance && typeof raw.provenance === 'object' ? raw.provenance : {};
    const source = normalizeCoreadSource(provenance.source || raw?.src);
    const sources = Array.isArray(provenance.sources) ? provenance.sources.map(normalizeCoreadSource) : [source];
    if (source !== 'book' && !(source === 'mixed' && sources.includes('book'))) continue;
    const from = finiteOrNull(provenance.charFrom) ?? (source === 'book' ? finiteOrNull(raw.coveredFrom) : null);
    const to = finiteOrNull(provenance.charTo) ?? (source === 'book' ? finiteOrNull(raw.coveredTo) : null);
    if (from == null || to == null || to <= from) continue;
    covered.push({ from: Math.max(0, from), to });
  }
  covered.sort((a, b) => (a.from - b.from) || (a.to - b.to));
  const gaps = [];
  let cursor = 0;
  for (const range of covered) {
    if (cursor >= end) break;
    if (range.from > cursor) gaps.push({ from: cursor, to: Math.min(range.from, end) });
    cursor = Math.max(cursor, range.to);
  }
  if (cursor < end) gaps.push({ from: cursor, to: end });
  return gaps;
}

// 切片的形成时间：近景排序用它，不用 coveredTo（各来源的 coveredTo 不是同一种坐标）。
export function coreadSliceCreatedAt(slice) {
  return finiteOrNull(slice?.provenance?.createdAt) ?? finiteOrNull(slice?.ts) ?? 0;
}

/* ============================================================
   八、阶段总结（纯数据层）
   细切片之上加一层，原切片不删。对话与书中内容分开合，各按自己的坐标判连续：
   对话是消息下标（闭区间），正文是字符位（半开区间），漫画字符位为空时退回页下标。
   ============================================================ */

// 出厂默认（用户 2026-11-26 定）：每 100 条合一条阶段，最近 20 条不合，每条阶段 800 字以内。
export const COREAD_STAGE_DEFAULTS = Object.freeze({ trigger: 100, keep: 20, chars: 800 });

// 切片内容指纹：summary + keywords。阶段记下每条父切片的指纹，父切片被改过就对不上。
export function coreadSliceFingerprint(slice) {
  const text = `${slice?.summary || ''}\u0001${(slice?.keywords || []).join(',')}`;
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) >>> 0;
  return `${text.length}_${h.toString(36)}`;
}

// 能进阶段的切片来源与坐标；不能进的返回 null（旧的合并切片、融合记忆、正文回响、已归档对谈、坐标缺失）。
export function coreadStagePosition(rawSlice) {
  if (!rawSlice || typeof rawSlice !== 'object' || rawSlice.compressed === true || rawSlice.stage === true) return null;
  const slice = normalizeCoreadSlice(rawSlice);
  const p = slice.provenance;
  if (p.source === 'dialog') {
    if (p.dialogArchived || p.dialogFrom == null || p.dialogTo == null) return null;
    return { source: 'dialog', from: Math.min(p.dialogFrom, p.dialogTo), to: Math.max(p.dialogFrom, p.dialogTo) };
  }
  if (p.source !== 'book' || p.sources.length !== 1) return null;
  if (p.charFrom != null && p.charTo != null && p.charTo > p.charFrom) {
    return { source: 'book', from: p.charFrom, to: p.charTo, chapterFrom: p.chapterFrom, chapterTo: p.chapterTo };
  }
  if (p.chapterFrom != null) {
    const to = p.chapterTo ?? p.chapterFrom;
    return { source: 'book', pages: true, from: Math.min(p.chapterFrom, to), to: Math.max(p.chapterFrom, to), chapterFrom: p.chapterFrom, chapterTo: to };
  }
  return null;
}

function coreadStageContiguous(prev, next) {
  if (prev.source !== next.source || !!prev.pages !== !!next.pages) return false;
  if (prev.source === 'dialog' || prev.pages) return next.from <= prev.to + 1;
  return next.from <= prev.to;
}

const STAGE_STATUSES = new Set(['active', 'invalid', 'deleted']);

// 读档时补齐阶段字段；缺 stages 的旧档读成空数组。阶段的形状与切片相同（带 stage: true），召回与防剧透函数可以直接用。
export function normalizeCoreadStage(rawStage, context = {}) {
  const raw = rawStage && typeof rawStage === 'object' ? rawStage : {};
  const parents = (Array.isArray(raw.parents) ? raw.parents : [])
    .filter((item) => item && typeof item.id === 'string' && item.id)
    .map((item) => ({ id: item.id, fp: String(item.fp || '') }));
  const slice = normalizeCoreadSlice({ ...raw, stage: true }, context);
  return {
    ...slice,
    keywords: Array.isArray(raw.keywords) ? raw.keywords.map(String).filter(Boolean) : [],
    synonyms: raw.synonyms && typeof raw.synonyms === 'object' && !Array.isArray(raw.synonyms) ? raw.synonyms : {},
    parents,
    status: STAGE_STATUSES.has(raw.status) ? raw.status : 'active',
    edited: raw.edited === true,
  };
}

export function normalizeCoreadStages(stages, context = {}) {
  return (Array.isArray(stages) ? stages : []).filter((stage) => stage && typeof stage === 'object' && typeof stage.id === 'string' && stage.id)
    .map((stage) => normalizeCoreadStage(stage, context));
}

// 阶段此刻的状态：用户删过的是 deleted；父切片缺了或内容变了是 invalid（不再注入，没被用户改过的会自动重建）。
export function coreadStageStatus(stage, slices) {
  if (!stage || stage.status === 'deleted') return 'deleted';
  const byId = new Map((Array.isArray(slices) ? slices : []).map((slice) => [slice?.id, slice]));
  if (!stage.parents?.length) return 'invalid';
  for (const parent of stage.parents) {
    const slice = byId.get(parent.id);
    if (!slice || coreadSliceFingerprint(slice) !== parent.fp) return 'invalid';
  }
  return 'active';
}

// 规划这一轮要合的阶段。返回 [{ source, parents: [切片], replaces: [被顶替的失效阶段 id] }]。
// opts: trigger（几条合一条）、keep（每个来源最近几条不合）、boundary／protection（只合当前读位下可见的）、
// cap（一组送去总结的切片字数上限，0 不限；超了只取放得下的前段，剩下的等下一次）、joinCost（每条之间的分隔字数）。
export function planCoreadStages(slices, stages, opts = {}) {
  const trigger = Math.max(2, Math.floor(Number(opts.trigger) || COREAD_STAGE_DEFAULTS.trigger));
  const keep = Math.max(0, Math.floor(Number(opts.keep ?? COREAD_STAGE_DEFAULTS.keep) || 0));
  const cap = Math.max(0, Math.floor(Number(opts.cap) || 0));
  const join = Math.max(0, Math.floor(Number(opts.joinCost) || 0));
  const list = Array.isArray(slices) ? slices : [];
  // 有效阶段、用户删过的阶段、用户改过的失效阶段都占住自己的切片；没改过的失效阶段让出切片，等着被重建顶替。
  const locked = new Set(), freed = new Map();
  for (const stage of Array.isArray(stages) ? stages : []) {
    const status = coreadStageStatus(stage, list);
    const ids = (stage.parents || []).map((parent) => parent.id);
    if (status === 'invalid' && !stage.edited) { for (const id of ids) freed.set(id, [...(freed.get(id) || []), stage.id]); }
    else for (const id of ids) locked.add(id);
  }
  const visible = new Set(filterCoreadSlicesAtBoundary(list, opts.boundary, opts.protection !== false));
  const bySource = new Map();
  for (const slice of list) {
    if (!visible.has(slice)) continue;
    const position = coreadStagePosition(slice);
    if (!position) continue;
    const key = `${position.source}${position.pages ? ':pages' : ''}`;
    if (!bySource.has(key)) bySource.set(key, []);
    bySource.get(key).push({ slice, position });
  }
  const groups = [];
  for (const items of bySource.values()) {
    items.sort((a, b) => (a.position.from - b.position.from) || (a.position.to - b.position.to));
    const older = items.slice(0, Math.max(0, items.length - keep));
    const runs = [];
    let run = [];
    for (const item of older) {
      if (locked.has(item.slice.id)) { if (run.length) runs.push(run); run = []; continue; }
      if (run.length && !coreadStageContiguous(run[run.length - 1].position, item.position)) { runs.push(run); run = []; }
      run.push(item);
    }
    if (run.length) runs.push(run);
    for (let rest of runs) {
      while (rest.length >= trigger) {
        let take = trigger;
        if (cap > 0) {
          let used = 0, fit = 0;
          for (const item of rest.slice(0, trigger)) {
            const cost = String(item.slice.summary || '').length + (fit ? join : 0);
            if (used + cost > cap) break;
            used += cost; fit++;
          }
          take = fit;
        }
        if (take < 2) break;
        const parents = rest.slice(0, take).map((item) => item.slice);
        const replaces = [...new Set(parents.flatMap((slice) => freed.get(slice.id) || []))];
        groups.push({ source: rest[0].position.source, parents, replaces });
        rest = rest.slice(take);
      }
    }
  }
  return groups;
}

// 由一组父切片与模型结果组出阶段记录。坐标取父切片的首尾，知情水位取父切片里最晚的。
export function buildCoreadStage(parents, result, context = {}) {
  const list = (Array.isArray(parents) ? parents : []).map((slice) => normalizeCoreadSlice(slice));
  if (!list.length) throw new Error('阶段没有父切片');
  const positions = list.map(coreadStagePosition);
  if (positions.some((position) => !position)) throw new Error('阶段的父切片不能合并');
  const source = positions[0].source;
  const nums = (key) => list.map((slice) => slice.provenance[key]).filter((value) => value != null);
  const min = (key) => (nums(key).length ? Math.min(...nums(key)) : null);
  const max = (key) => (nums(key).length ? Math.max(...nums(key)) : null);
  if (!context.id) throw new Error('阶段缺少编号');
  const createdAt = finiteOrNull(context.now) ?? Date.now();
  const from = Math.min(...positions.map((position) => position.from));
  const to = Math.max(...positions.map((position) => position.to));
  // 书中内容的 coveredTo 同时是防剧透硬边界，必须是字符位（漫画按页判连续，但边界仍按字符位）。
  return normalizeCoreadStage({
    id: String(context.id),
    src: source === 'book' ? 'text' : 'dialog',
    summary: String(result?.summary || ''),
    keywords: Array.isArray(result?.keywords) ? result.keywords : [],
    synonyms: result?.synonyms || {},
    ts: createdAt,
    coveredFrom: source === 'book' ? min('charFrom') : from,
    coveredTo: source === 'book' ? max('charTo') : to,
    parents: list.map((slice) => ({ id: slice.id, fp: coreadSliceFingerprint(slice) })),
    status: 'active',
    provenance: {
      source, sources: [source], createdAt,
      bookId: list[0].provenance.bookId, bucket: list[0].provenance.bucket,
      readTo: max('readTo'),
      readChapter: max('readChapter'), readProgress: max('readProgress'),
      charFrom: min('charFrom'), charTo: max('charTo'),
      chapterFrom: min('chapterFrom'), chapterTo: max('chapterTo'),
      dialogFrom: source === 'dialog' ? from : null, dialogTo: source === 'dialog' ? to : null,
      dialogMessageIds: [...new Set(list.flatMap((slice) => slice.provenance.dialogMessageIds))],
    },
  }, context);
}

/* ============================================================
   九、总结提示词（三组可编辑条目 ＋ 代码里的固定协议）
   条目只写「怎么整理」；开头说明、日期、输出格式与字数上限由协议补上，不出现在可编辑条目里。
   默认文本为用户 2026-11-26 审定稿。
   ============================================================ */

export const COREAD_PROMPT_KINDS = Object.freeze(['dialog', 'book', 'stage']);
export const COREAD_PROMPT_LABELS = Object.freeze({ dialog: '对话总结', book: '正文总结', stage: '阶段总结' });
// 每条切片字数上限的出厂值；阶段的见 COREAD_STAGE_DEFAULTS.chars。超过上限 1.5 倍整条不收。
export const COREAD_SLICE_CHARS = 300;
export const COREAD_OVER_LIMIT = 1.5;

const DIALOG_RULE = '将读者与书友的共读对话，蒸馏为可复用的客观记忆文本，全程以第三人称事实陈述呈现，不加入主观评判。\n\n【核心规则】\n1. 身份边界严格隔离：对话方为现实中的「读者」「书友」，书籍角色仅为讨论对象。严禁将读者/书友的评论、推测、感想等同于书中角色的实际言行；书中角色不视为对话参与者。\n2. 内容记录规范：① 专名保留，人名、地名、作品名、专有概念沿用原文完整表述，不缩写、不泛化、不意译；② 原话摘引，对话中的核心论断、关键观点、原文摘句以双引号直引，句数按需适配总篇幅；③ 变化标注，态度转向、认知更新、共识达成等关键转变统一以「原状态 变为 新状态」格式标注。\n3. 详略尺度控制：深度对谈（剧情分析、人物解读、观点交锋）完整记录核心逻辑与结论；闲聊寒暄、过渡性表述仅记核心意图与结论；不遗漏影响后续共读理解的关键信息。\n4. 行文禁用破折号（——），不以破折号补充说明或制造停顿；改用逗号、句号或直接陈述。';
const BOOK_RULE = '只记正文中确实发生的情节、人物、场景、关键转折，全程第三人称客观陈述，不加评论、不作书评。\n专名（人名/地名/作品内概念）沿用原文完整表述，不缩写、不意译。\n未完结的情节与伏笔保持开放，不替原作下结论。\n行文禁用破折号（——）。';
const STAGE_RULE = '把按顺序排列的多条伴读记忆整理为一条阶段记忆，供日后快速回顾这一段；原记忆保留不删。\n1. 只依据给出的记忆，不补写后文，不推测尚未读到的情节。\n2. 留住因果骨架：书中情节写清前因、转折与结果；共读交流写清聊过的话题、双方的看法与态度变化，变化沿用「原状态 变为 新状态」的写法。\n3. 书中角色的言行与读者、书友的评论和推测分开叙述，不混写。\n4. 专名沿用原文完整表述；关键原话可保留双引号直引，择要而取。\n5. 尚未解开的疑问、猜测与伏笔保留下来，写明仍未确定。\n6. 行文禁用破折号（——）。';

const PROMPT_DEFAULTS = Object.freeze({
  dialog: [{ id: 'sum-format', builtin: true, order: 0, title: '总结要求', text: DIALOG_RULE }],
  book: [{ id: 'book-rule', builtin: true, order: 0, title: '整理要求', text: BOOK_RULE }],
  stage: [{ id: 'stage-rule', builtin: true, order: 0, title: '阶段整理', text: STAGE_RULE }],
});

export function defaultCoreadSummaryPrompts() {
  return Object.fromEntries(COREAD_PROMPT_KINDS.map((kind) => [kind, PROMPT_DEFAULTS[kind].map((item) => ({ ...item }))]));
}

// 三组各自归一：缺组或空组填内置默认；条目字段补齐、按 order 排好并规整成连续序号。
export function normalizeCoreadSummaryPrompts(raw, makeId = () => `sum-${Math.random().toString(36).slice(2, 10)}`) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const defaults = defaultCoreadSummaryPrompts();
  return Object.fromEntries(COREAD_PROMPT_KINDS.map((kind) => {
    const list = (Array.isArray(source[kind]) ? source[kind] : []).filter((item) => item && typeof item === 'object' && !Array.isArray(item));
    if (!list.length) return [kind, defaults[kind]];
    const items = list.map((item, i) => ({
      id: String(item.id || makeId()),
      builtin: item.builtin === true,
      order: Number.isFinite(item.order) ? item.order : i,
      title: String(item.title || '未命名提示词'),
      text: String(item.text || ''),
    })).sort((a, b) => a.order - b.order).map((item, i) => ({ ...item, order: i }));
    return [kind, items];
  }));
}

// 恢复内置默认：三组的内置条目换回出厂文本，自定义条目保留在后面。
export function restoreCoreadSummaryPrompts(prompts) {
  const current = normalizeCoreadSummaryPrompts(prompts);
  const defaults = defaultCoreadSummaryPrompts();
  return Object.fromEntries(COREAD_PROMPT_KINDS.map((kind) => {
    const custom = current[kind].filter((item) => !item.builtin);
    return [kind, [...defaults[kind], ...custom].map((item, i) => ({ ...item, order: i }))];
  }));
}

// 组出发给总结模型的系统提示词。ctx: items（这一组的条目）、user、char、title、progress（读至进度）、
// date（开了「记下日期」时的年月日）、part／total（正文第几段）、count／source（阶段合了几条、哪种来源）、chars（字数上限）。
export function buildCoreadSummaryPrompt(kind, ctx = {}) {
  if (!COREAD_PROMPT_KINDS.includes(kind)) throw new Error(`未知的总结种类：${kind}`);
  const title = String(ctx.title || '未命名');
  const user = String(ctx.user || '读者');
  const char = String(ctx.char || '书友');
  const progress = String(ctx.progress || '');
  const date = String(ctx.date || '');
  const chars = Math.max(1, Math.floor(Number(ctx.chars) || (kind === 'stage' ? COREAD_STAGE_DEFAULTS.chars : COREAD_SLICE_CHARS)));
  const items = (Array.isArray(ctx.items) ? ctx.items : []).slice().sort((a, b) => a.order - b.order)
    .filter((item) => String(item.text || '').trim());
  let head;
  if (kind === 'dialog') head = `下面是「${user}」伴读《${title}》${progress ? `（${progress}）` : ''}时与书友「${char}」讨论这本书的一段对话。请把这段对话整理成记忆。`;
  else if (kind === 'book') head = `下面是《${title}》中已读过的一段正文原文${Number(ctx.total) > 1 ? `（第 ${ctx.part}／${ctx.total} 段）` : ''}。请把它整理成第三人称客观的情节记忆。`;
  else head = `下面是「${user}」伴读《${title}》时按顺序排列的 ${Math.max(0, Math.floor(Number(ctx.count) || 0))} 条${ctx.source === 'book' ? '书中内容' : '共读交流'}记忆。请把它们整理成一条阶段记忆。`;
  const parts = [`你是伴读记忆整理助手。${head}`];
  if (items.length) parts.push(`【整理要求】\n${items.map((item, i) => `${i + 1}. ${item.title}：${item.text}`).join('\n')}`);
  if (date && kind !== 'stage') {
    parts.push(kind === 'dialog'
      ? `这段对话发生于${date}${progress ? `，${progress}` : ''}；请在总结开头自然带出年月日与读至进度。`
      : `这段阅读发生于${date}；请在总结开头自然带出该年月日。`);
  }
  parts.push(`【输出】只输出纯 JSON：{"summary": "不超过 ${chars} 字的第三人称记忆正文", "keywords": ["3 至 10 个高辨识度检索词，优先人名、核心事件、关键概念"], "synonyms": {"标准词": ["本段出现过的别称、简称、指代"]}}。\n- synonyms：为 keywords 里的关键人物、概念补上这里出现过的别称、简称、指代（如外号、全名与简称的对应、「他／她」在此处具体指谁），用于日后检索；没有可补的给 {}，不要硬凑。\n不要代码块标记，不要额外解释。`);
  return parts.join('\n\n');
}

// 重试时追加在用户消息末尾的提醒：格式没解析出来，或 summary 超出上限 1.5 倍。
export function coreadSummaryRetryNote(reason, chars) {
  if (reason === 'long') return `\n\n【重要】上一次的 summary 超出字数上限。请压到 ${chars} 字以内，仍只输出 {"summary":"...","keywords":["..."],"synonyms":{}} 的纯 JSON。`;
  return '\n\n【重要】上一次输出无法解析为 JSON。请严格只输出 {"summary":"...","keywords":["..."],"synonyms":{}} 的纯 JSON，不要解释、不要代码块标记。';
}

export function coreadSummaryTooLong(summary, chars) {
  const limit = Math.max(1, Math.floor(Number(chars) || 0));
  return String(summary || '').length > limit * COREAD_OVER_LIMIT;
}

// 召回用的记忆池：当前读位下可见的有效阶段，加上没被这些阶段盖住的可见细切片。
// 阶段因读位回退被隔离时，它的父切片里仍可见的那些回到池里。
export function coreadRecallPool(slices, stages, boundary, protection = true) {
  const list = Array.isArray(slices) ? slices : [];
  const live = (Array.isArray(stages) ? stages : []).filter((stage) => coreadStageStatus(stage, list) === 'active');
  const shown = filterCoreadSlicesAtBoundary(live, boundary, protection);
  const covered = new Set(shown.flatMap((stage) => stage.parents.map((parent) => parent.id)));
  return [...shown, ...filterCoreadSlicesAtBoundary(list, boundary, protection).filter((slice) => !covered.has(slice.id))];
}

// 全书绝对字符位 → 章节下标；offset 视为字符位置，超界时夹到首尾章节。
export function chapterIndexAtOffset(chapters, offset) {
  const list = Array.isArray(chapters) ? chapters : [];
  if (!list.length) return null;
  const target = Math.max(0, Number(offset) || 0);
  let cursor = 0;
  for (let i = 0; i < list.length; i++) {
    const end = cursor + String(list[i]?.content || '').length;
    if (target < end || i === list.length - 1) return i;
    cursor = end;
  }
  return list.length - 1;
}

/* ============================================================
   八、HTML → 纯文本（EPUB/MOBI 共用）
   块级标签换行、去脚本样式、解实体；保留段落感，交给分章/切片。
   ============================================================ */

const HTML_NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’', hellip: '…',
  mdash: '—', ndash: '–', middot: '·', copy: '©', reg: '®', trade: '™',
};

export function decodeHtmlEntities(s) {
  return String(s || '').replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X'
        ? parseInt(body.slice(2), 16)
        : parseInt(body.slice(1), 10);
      if (Number.isFinite(code) && code > 0 && code <= 0x10FFFF) {
        try { return String.fromCodePoint(code); } catch (_) { return m; }
      }
      return m;
    }
    const named = HTML_NAMED_ENTITIES[body.toLowerCase()];
    return named != null ? named : m;
  });
}

// 把一段 HTML 抽成纯文本：去 <head>/<script>/<style>，块级标签转换行，其余标签删掉，最后解实体+归一化。
export function stripHtmlToText(html) {
  let s = String(html || '');
  s = s.replace(/<!--[\s\S]*?-->/g, '');
  s = s.replace(/<head[\s\S]*?<\/head>/gi, '');
  s = s.replace(/<(script|style)[\s\S]*?<\/\1>/gi, '');
  // 块级/换行标签 → 换行
  s = s.replace(/<\s*br\s*\/?\s*>/gi, '\n');
  s = s.replace(/<\/(p|div|h[1-6]|li|tr|section|article|blockquote|figure|figcaption|pre)\s*>/gi, '\n');
  s = s.replace(/<\s*(p|div|h[1-6]|li|tr|section|article|blockquote|figure|figcaption|pre)(\s[^>]*)?>/gi, '\n');
  // 其余标签删除
  s = s.replace(/<[^>]+>/g, '');
  s = decodeHtmlEntities(s);
  return normalizeTextBlock(s);
}

// 从一段 HTML 里取标题：优先 <title>，再 <h1>~<h3>。取不到返回 ''。
function pickHtmlTitle(html) {
  const mt = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  if (mt && mt[1].trim()) return decodeHtmlEntities(mt[1]).replace(/\s+/g, ' ').trim().slice(0, 50);
  const mh = /<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/i.exec(html);
  if (mh) {
    const t = decodeHtmlEntities(mh[1].replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
    if (t) return t.slice(0, 50);
  }
  return '';
}

/* ============================================================
   八、EPUB 解析（需外部传入 JSZip 构造器，保持本模块纯净）
   读 container.xml → OPF → spine 顺序 → 逐篇 XHTML 抽文 → 章节。
   返回 { title, author, chapters:[{title,content}] }。
   ============================================================ */

// 解析 OPF 相对路径（相对于 opf 所在目录）
function resolveHref(base, href) {
  const cleaned = String(href || '').split('#')[0].replace(/^\.\//, '');
  if (!base) return cleaned;
  const stack = base.split('/');
  stack.pop();   // 去掉 opf 文件名，保留目录
  for (const seg of cleaned.split('/')) {
    if (seg === '..') stack.pop();
    else if (seg && seg !== '.') stack.push(seg);
  }
  return stack.join('/');
}

// 从 zip 里按大小写不敏感取文件（EPUB 路径大小写偶有出入）
function zipFile(zip, path) {
  if (!path) return null;
  if (zip.files[path]) return zip.files[path];
  const lower = path.toLowerCase();
  const key = Object.keys(zip.files).find((k) => k.toLowerCase() === lower);
  return key ? zip.files[key] : null;
}

// deflate-raw 解压（浏览器原生 DecompressionStream，Chrome/Edge 103+ / 现代内核均有）。
async function inflateRaw(bytes) {
  if (typeof DecompressionStream === 'undefined') throw new Error('NO_INFLATE');
  const ds = new DecompressionStream('deflate-raw');
  const stream = new Blob([bytes]).stream().pipeThrough(ds);
  const ab = await new Response(stream).arrayBuffer();
  return new Uint8Array(ab);
}

// 原生 ZIP 读取器（够用子集：读中央目录 → 定位本地头 → stored/deflate 解压）。
// 返回 { files: { path: { async(type) } } }，接口与 JSZip 兼容，parseEpub 无需改动。
async function openZipNative(arrayBuffer) {
  const buf = arrayBuffer instanceof ArrayBuffer ? arrayBuffer : arrayBuffer.buffer;
  const bytes = new Uint8Array(buf);
  const dv = new DataView(buf);
  const u16 = (o) => dv.getUint16(o, true);
  const u32 = (o) => dv.getUint32(o, true);
  const n = bytes.length;
  // 从尾部找 EOCD（结束中央目录记录）签名 0x06054b50
  let eocd = -1;
  for (let i = n - 22; i >= Math.max(0, n - 22 - 65535); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('EPUB_BAD_ZIP');
  const cdCount = u16(eocd + 10);
  const cdOffset = u32(eocd + 16);
  if (cdOffset === 0xFFFFFFFF) throw new Error('EPUB_ZIP64');   // ZIP64 罕见于 EPUB，不支持
  const entries = {};
  let p = cdOffset;
  for (let i = 0; i < cdCount && p + 46 <= n; i++) {
    if (dv.getUint32(p, true) !== 0x02014b50) break;   // 中央目录条目签名
    const method = u16(p + 10);
    const compSize = u32(p + 20);
    const nameLen = u16(p + 28);
    const extraLen = u16(p + 30);
    const commentLen = u16(p + 32);
    const localOff = u32(p + 42);
    const name = new TextDecoder('utf-8').decode(bytes.subarray(p + 46, p + 46 + nameLen));
    entries[name] = { method, compSize, localOff };
    p += 46 + nameLen + extraLen + commentLen;
  }
  const rawBytes = (entry) => {
    const lp = entry.localOff;
    if (dv.getUint32(lp, true) !== 0x04034b50) throw new Error('EPUB_BAD_ZIP');   // 本地头签名
    const start = lp + 30 + u16(lp + 26) + u16(lp + 28);   // 30 + 文件名长 + 扩展域长
    return bytes.subarray(start, start + entry.compSize);
  };
  const files = {};
  for (const [name, entry] of Object.entries(entries)) {
    files[name] = {
      async: async (type) => {
        const comp = rawBytes(entry);
        let out;
        if (entry.method === 0) out = comp;                     // stored
        else if (entry.method === 8) out = await inflateRaw(comp); // deflate
        else throw new Error('EPUB_UNSUPPORTED_METHOD');
        return type === 'string' ? decodeTxtBuffer(out) : out;
      },
    };
  }
  return { files };
}

// 正则字面量转义（锚点名做动态正则用）。
function escapeRegExp(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// 拆 href 为 { file(相对 base 解析后的全路径), anchor }。同文件锚点（#foo）→ file=base。
function splitHref(href, base) {
  const raw = String(href || '');
  const hashIdx = raw.indexOf('#');
  const path = hashIdx >= 0 ? raw.slice(0, hashIdx) : raw;
  const anchor = hashIdx >= 0 ? raw.slice(hashIdx + 1) : '';
  const file = path ? resolveHref(base, path) : base;
  return { file, anchor };
}

// 解析 EPUB3 nav.xhtml 的 toc <nav>：按文档顺序取 <a href>label</a>。返回 [{label,file,anchor}]。
function parseNavXhtml(xhtml, navBase) {
  let block = /<nav\b[^>]*epub:type\s*=\s*["'][^"']*\btoc\b[^"']*["'][^>]*>([\s\S]*?)<\/nav>/i.exec(xhtml);
  if (!block) block = /<nav\b[^>]*>([\s\S]*?)<\/nav>/i.exec(xhtml);
  if (!block) return [];
  const entries = [];
  const aRe = /<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = aRe.exec(block[1])) !== null) {
    const label = decodeHtmlEntities(m[2].replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
    const { file, anchor } = splitHref(m[1], navBase);
    if (label && file) entries.push({ label: label.slice(0, 80), file, anchor });
  }
  return entries;
}

// 解析 EPUB2 toc.ncx 的 navPoint：按文档顺序取 <text> + <content src>。返回 [{label,file,anchor}]。
function parseNcx(ncx, ncxBase) {
  const entries = [];
  const re = /<navPoint\b[\s\S]*?<text>([\s\S]*?)<\/text>[\s\S]*?<content\b[^>]*src\s*=\s*["']([^"']+)["']/gi;
  let m;
  while ((m = re.exec(ncx)) !== null) {
    const label = decodeHtmlEntities(m[1].replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
    const { file, anchor } = splitHref(m[2], ncxBase);
    if (label && file) entries.push({ label: label.slice(0, 80), file, anchor });
  }
  return entries;
}

// 取 EPUB 目录（优先 EPUB3 nav，退 EPUB2 NCX）。返回 [{label,file(全路径),anchor}]，取不到返回 []。
async function parseEpubToc(zip, opfPath, opf, manifest, hrefOf) {
  // EPUB3：manifest properties 含 nav 的项
  const navId = Object.keys(manifest).find((id) => /\bnav\b/.test(manifest[id]?.props || ''));
  if (navId) {
    const navBase = resolveHref(opfPath, hrefOf(navId));
    const f = zipFile(zip, navBase);
    if (f) {
      try {
        const entries = parseNavXhtml(await f.async('string'), navBase);
        if (entries.length) return entries;
      } catch (_) {}
    }
  }
  // EPUB2：spine 的 toc 属性 → manifest id；否则按 media-type / 扩展名找 ncx
  let ncxId = '';
  const spineTag = /<spine\b[^>]*>/i.exec(opf);
  if (spineTag) {
    const tocAttr = /\btoc\s*=\s*["']([^"']+)["']/i.exec(spineTag[0]);
    if (tocAttr && manifest[tocAttr[1]]) ncxId = tocAttr[1];
  }
  if (!ncxId) ncxId = Object.keys(manifest).find((id) => /dtbncx/i.test(manifest[id]?.type || '') || /\.ncx$/i.test(hrefOf(id) || '')) || '';
  if (ncxId) {
    const ncxBase = resolveHref(opfPath, hrefOf(ncxId));
    const f = zipFile(zip, ncxBase);
    if (f) {
      try {
        const entries = parseNcx(await f.async('string'), ncxBase);
        if (entries.length) return entries;
      } catch (_) {}
    }
  }
  return [];
}

// 在 HTML 里定位锚点（id/name）所在标签的起始 '<' 位置。找不到返回 -1。
function findAnchorPos(html, anchor) {
  if (!anchor) return -1;
  const re = new RegExp(`(?:\\bid|\\bname)\\s*=\\s*["']${escapeRegExp(anchor)}["']`, 'i');
  const m = re.exec(html);
  if (!m) return -1;
  const lt = html.lastIndexOf('<', m.index);
  return lt >= 0 ? lt : m.index;
}

// 按锚点把单篇 HTML 切成多段。entries 顺序即目录顺序（第一条从文件头起）。
// 任一非首锚点找不到 / 位置非递增 → 返回 null（放弃锚点切分，整篇作一章）。
function splitHtmlByAnchors(html, entries) {
  const cuts = [];
  for (let i = 0; i < entries.length; i++) {
    if (i === 0) { cuts.push({ label: entries[0].label, pos: 0 }); continue; }
    const pos = findAnchorPos(html, entries[i].anchor);
    if (pos < 0) return null;
    cuts.push({ label: entries[i].label, pos });
  }
  for (let i = 1; i < cuts.length; i++) if (cuts[i].pos <= cuts[i - 1].pos) return null;
  const out = [];
  for (let i = 0; i < cuts.length; i++) {
    const start = cuts[i].pos;
    const end = i + 1 < cuts.length ? cuts[i + 1].pos : html.length;
    out.push({ label: cuts[i].label, html: html.slice(start, end) });
  }
  return out;
}

// 把 XHTML 里的 <img>/SVG <image> 换成正文占位符「⟦img:n⟧」（独占段落），图字节收进 images（去重·全书连续编号）。
// imgRegistry：已抽图 zip 路径 → 序号。data:/http(s): 外链图跳过（删标签）。返回替换后的 HTML。
async function injectImagePlaceholders(html, fileFull, zip, imgRegistry, images) {
  const tagRe = /<img\b[^>]*>|<image\b[^>]*>/gi;
  const srcRe = /(?:\bsrc|xlink:href|\bhref)\s*=\s*["']([^"']+)["']/i;
  const matches = [];
  let m;
  while ((m = tagRe.exec(html)) !== null) {
    const src = (srcRe.exec(m[0]) || [])[1];
    if (src && !/^data:/i.test(src) && !/^https?:/i.test(src)) matches.push({ tag: m[0], src });
  }
  if (!matches.length) return html;
  let out = html;
  for (const it of matches) {
    const path = resolveHref(fileFull, it.src);
    let n = imgRegistry.get(path);
    if (n == null) {
      const f = zipFile(zip, path);
      if (f) {
        try {
          const bytes = await f.async('uint8array');
          if (bytes && bytes.length) {
            n = images.length + 1;
            const mime = /\.png$/i.test(path) ? 'image/png'
              : /\.gif$/i.test(path) ? 'image/gif'
                : /\.webp$/i.test(path) ? 'image/webp'
                  : /\.svg$/i.test(path) ? 'image/svg+xml' : 'image/jpeg';
            images.push({ n, bytes, mime });
            imgRegistry.set(path, n);
          }
        } catch (_) {}
      }
    }
    // 用 function 替换避免 $ 被当特殊模式；只替第一处（与 matches 逐一对应）
    const placeholder = n != null ? `\n\n⟦img:${n}⟧\n\n` : '\n';
    out = out.replace(it.tag, () => placeholder);
  }
  return out;
}

// 去掉正文开头与章节标题重复的那一行（EPUB 里标题常同时是 HTML <h*> 又落进正文，
// 阅读器又单独渲染 <h2>标题</h2>，会重复一次）。只削首行、宽松匹配（去空白/标点后相等或互含）。
function normalizeTitleForCompare(s) {
  return String(s || '').replace(/[\s　]+/g, '').replace(/[「」『』（）()【】《》·・.,，。:：、"“”'']/g, '').toLowerCase();
}
function stripLeadingTitle(content, title) {
  const t = String(title || '').trim();
  if (!t) return content;
  const nt = normalizeTitleForCompare(t);
  if (!nt) return content;
  const lines = String(content || '').split('\n');
  const isTitleLine = (raw) => {
    const s = raw.trim();
    if (!s || s.length > 60) return false;
    const ns = normalizeTitleForCompare(s);
    return !!ns && (ns === nt || (ns.length >= 2 && nt.includes(ns)) || (nt.length >= 2 && ns.includes(nt)));
  };
  // 跳过开头的空行与图片占位符，逐条削去与标题等价/互含的首部行（EPUB 常 <h1>+<h2> 双标题，或标题前置装饰图 ⟦img⟧）。
  let i = 0, removedTitle = false;
  while (i < lines.length) {
    const s = lines[i].trim();
    if (!s) { i++; continue; }                     // 空行：跳过
    if (/^⟦img:\d+⟧$/.test(s)) { i++; continue; }  // 装饰图占位符：跳过（保留在正文里，只是不挡标题识别）
    if (isTitleLine(lines[i])) { lines[i] = ''; removedTitle = true; i++; continue; }  // 标题行：清空
    break;                                          // 遇到首个正文行：停
  }
  if (!removedTitle) return content;
  return lines.join('\n').replace(/^\n+/, '');
}

// 由 spine 文档 + 目录组装章节。目录可用(≥2命中)则按目录/锚点切；否则退回「一 spine 文件一章」。
function buildEpubChapters(spineDocs, toc) {
  const perSpine = () => spineDocs.map((d, i) => {
    const title = pickHtmlTitle(d.html) || `第 ${i + 1} 篇`;
    return { title, content: stripLeadingTitle(stripHtmlToText(d.html), title) };
  }).filter((c) => c.content && c.content.length >= 2);

  const usable = (toc || []).filter((e) => spineDocs.some((d) => d.fileFull === e.file));
  if (usable.length < 2) return perSpine();

  const chapters = [];
  const push = (title, rawContent) => {
    const content = stripLeadingTitle(rawContent, title);
    if (content && content.length >= 2) chapters.push({ title, content });
  };
  for (const doc of spineDocs) {
    const es = usable.filter((e) => e.file === doc.fileFull);
    if (!es.length) { push(pickHtmlTitle(doc.html) || `第 ${chapters.length + 1} 篇`, stripHtmlToText(doc.html)); continue; }
    if (es.length === 1) { push(es[0].label, stripHtmlToText(doc.html)); continue; }
    const parts = splitHtmlByAnchors(doc.html, es);
    if (!parts) { push(es[0].label, stripHtmlToText(doc.html)); }
    else { for (const p of parts) push(p.label, stripHtmlToText(p.html)); }
  }
  const cleaned = chapters.filter((c) => c.content && c.content.length >= 2);
  return cleaned.length >= 2 ? cleaned : perSpine();
}

// JSZip 可传（优先用），不传则走原生 ZIP 读取器（ST 不稳定暴露 JSZip 时的默认路径）。
export async function parseEpub(arrayBuffer, JSZip) {
  const zip = (typeof JSZip === 'function')
    ? await JSZip.loadAsync(arrayBuffer)
    : await openZipNative(arrayBuffer);

  // 1) container.xml → OPF 路径
  const containerFile = zipFile(zip, 'META-INF/container.xml');
  let opfPath = '';
  if (containerFile) {
    const cx = await containerFile.async('string');
    const m = /<rootfile[^>]*full-path\s*=\s*["']([^"']+)["']/i.exec(cx);
    if (m) opfPath = m[1];
  }
  if (!opfPath) {
    const guess = Object.keys(zip.files).find((k) => /\.opf$/i.test(k));
    if (guess) opfPath = guess;
  }
  if (!opfPath) throw new Error('EPUB_NO_OPF');

  const opfFile = zipFile(zip, opfPath);
  if (!opfFile) throw new Error('EPUB_NO_OPF');
  const opf = await opfFile.async('string');

  // 2) 元数据
  const titleM = /<dc:title[^>]*>([\s\S]*?)<\/dc:title>/i.exec(opf) || /<title[^>]*>([\s\S]*?)<\/title>/i.exec(opf);
  const authorM = /<dc:creator[^>]*>([\s\S]*?)<\/dc:creator>/i.exec(opf);
  const title = titleM ? decodeHtmlEntities(titleM[1].replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim() : '';
  const author = authorM ? decodeHtmlEntities(authorM[1].replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim() : '';

  // 3) manifest：id → { href, type, props }（type/props 用于找封面）
  const manifest = {};
  const manifestBlock = /<manifest[^>]*>([\s\S]*?)<\/manifest>/i.exec(opf);
  const manifestXml = manifestBlock ? manifestBlock[1] : opf;
  const itemRe = /<item\b[^>]*>/gi;
  let im;
  while ((im = itemRe.exec(manifestXml)) !== null) {
    const tag = im[0];
    const id = (/id\s*=\s*["']([^"']+)["']/i.exec(tag) || [])[1];
    const href = (/href\s*=\s*["']([^"']+)["']/i.exec(tag) || [])[1];
    const type = (/media-type\s*=\s*["']([^"']+)["']/i.exec(tag) || [])[1] || '';
    const props = (/properties\s*=\s*["']([^"']+)["']/i.exec(tag) || [])[1] || '';
    if (id && href) manifest[id] = { href, type, props };
  }
  const hrefOf = (id) => manifest[id]?.href;

  // 4) spine：阅读顺序
  const spine = [];
  const spineBlock = /<spine[^>]*>([\s\S]*?)<\/spine>/i.exec(opf);
  if (spineBlock) {
    const refRe = /<itemref\b[^>]*idref\s*=\s*["']([^"']+)["'][^>]*>/gi;
    let sm;
    while ((sm = refRe.exec(spineBlock[1])) !== null) spine.push(sm[1]);
  }
  // spine 空 → 退回 manifest 里所有 (x)html 项
  const orderIds = spine.length ? spine
    : Object.keys(manifest).filter((id) => /\.x?html?$/i.test(hrefOf(id) || ''));

  // 5) 逐篇读 XHTML → 埋图占位符 → 保留 HTML（章节切分在 buildEpubChapters 里按目录/锚点做）
  const images = [];
  const imgRegistry = new Map();
  const spineDocs = [];
  for (const id of orderIds) {
    const href = hrefOf(id);
    if (!href || !/\.x?html?$/i.test(href)) continue;
    const fileFull = resolveHref(opfPath, href);
    const f = zipFile(zip, fileFull);
    if (!f) continue;
    let html = '';
    try { html = await f.async('string'); } catch (_) { continue; }
    try { html = await injectImagePlaceholders(html, fileFull, zip, imgRegistry, images); } catch (_) {}
    spineDocs.push({ id, fileFull, html });
  }

  // 6) 目录（NCX/nav）→ 章节切分（含单文件多锚点切分）；取不到目录退回一 spine 一章
  const toc = await parseEpubToc(zip, opfPath, opf, manifest, hrefOf);
  const chapters = buildEpubChapters(spineDocs, toc);

  // 7) 封面：优先 manifest properties="cover-image"，再 <meta name="cover" content="id">，
  //    再 id/href 含 cover 的图片项；取到就抽字节 + mime，交上层存 blob。
  const cover = await extractEpubCover(zip, opfPath, opf, manifest, hrefOf);

  return { title, author, chapters, cover, images };
}

// 找并读取 EPUB 封面图。返回 { bytes:Uint8Array, mime } 或 null。
async function extractEpubCover(zip, opfPath, opf, manifest, hrefOf) {
  const imgType = (id) => /^image\//i.test(manifest[id]?.type || '') || /\.(jpe?g|png|gif|webp)$/i.test(hrefOf(id) || '');
  let coverId = '';
  // a) properties="cover-image"（EPUB3 规范）
  coverId = Object.keys(manifest).find((id) => /\bcover-image\b/.test(manifest[id]?.props || '') && imgType(id)) || '';
  // b) <meta name="cover" content="coverId">（EPUB2 惯例）
  if (!coverId) {
    const mm = /<meta[^>]*name\s*=\s*["']cover["'][^>]*content\s*=\s*["']([^"']+)["']/i.exec(opf)
      || /<meta[^>]*content\s*=\s*["']([^"']+)["'][^>]*name\s*=\s*["']cover["']/i.exec(opf);
    if (mm && manifest[mm[1]] && imgType(mm[1])) coverId = mm[1];
  }
  // c) id 或 href 含 cover 的图片项
  if (!coverId) coverId = Object.keys(manifest).find((id) => imgType(id) && (/cover/i.test(id) || /cover/i.test(hrefOf(id) || ''))) || '';
  if (!coverId) return null;
  const f = zipFile(zip, resolveHref(opfPath, hrefOf(coverId)));
  if (!f) return null;
  try {
    const bytes = await f.async('uint8array');
    if (!bytes || !bytes.length) return null;
    const href = hrefOf(coverId);
    const mime = manifest[coverId]?.type
      || (/\.png$/i.test(href) ? 'image/png' : /\.gif$/i.test(href) ? 'image/gif' : /\.webp$/i.test(href) ? 'image/webp' : 'image/jpeg');
    return { bytes, mime };
  } catch (_) { return null; }
}

// CBZ/ZIP 漫画：按自然文件名顺序抽取图片，一页一章。隐藏文件与 __MACOSX 元数据自动跳过。
// 返回结构沿用 EPUB 的 chapters/cover/images，所以上层可复用同一套 IndexedDB 与阅读器懒加载链路。
export async function parseComicArchive(arrayBuffer, JSZip) {
  const zip = (typeof JSZip === 'function')
    ? await JSZip.loadAsync(arrayBuffer)
    : await openZipNative(arrayBuffer);
  const names = Object.keys(zip.files || {})
    .filter((name) => !/(^|\/)__MACOSX\//i.test(name) && !/(^|\/)\./.test(name) && /\.(?:jpe?g|png|webp|gif|avif)$/i.test(name))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
  if (!names.length) throw new Error('COMIC_NO_IMAGES');
  const images = [];
  for (const [index, name] of names.entries()) {
    const file = zipFile(zip, name);
    if (!file) continue;
    const bytes = await file.async('uint8array');
    if (!bytes?.length) continue;
    const mime = /\.png$/i.test(name) ? 'image/png'
      : /\.webp$/i.test(name) ? 'image/webp'
        : /\.gif$/i.test(name) ? 'image/gif'
          : /\.avif$/i.test(name) ? 'image/avif'
            : 'image/jpeg';
    images.push({ n: index + 1, bytes, mime, name });
  }
  if (!images.length) throw new Error('COMIC_NO_IMAGES');
  const chapters = images.map((image, index) => ({ title: `第 ${index + 1} 页`, content: `⟦img:${image.n}⟧` }));
  const first = images[0];
  return {
    chapters,
    images,
    cover: { bytes: first.bytes, mime: first.mime },
    pageCount: images.length,
  };
}

/* ============================================================
   九、MOBI 解析（无外部依赖）
   PalmDB 记录表 → PalmDOC/MOBI 头 → 文本记录（无压缩或 PalmDOC LZ77）→
   正文 / recindex 图片资源。经典 MOBI 漫画通常以一段 pagebreak HTML 描述页序，
   图片从 firstImageIndex 起按 recindex(1-based) 存在后续 PalmDB 记录中。
   不支持 HUFF/CDIC 压缩与 KF8/AZW3 新容器（抛错让上层提示）。
   返回 { title, author, text, chapters?, images?, cover?, pageCount? }。
   ============================================================ */

// PalmDOC (LZ77) 解压单条记录
function palmDocDecompress(bytes) {
  const out = [];
  let i = 0;
  const n = bytes.length;
  while (i < n) {
    const b = bytes[i++];
    if (b === 0) {
      out.push(0);
    } else if (b >= 1 && b <= 8) {
      for (let j = 0; j < b && i < n; j++) out.push(bytes[i++]);
    } else if (b <= 0x7F) {
      out.push(b);
    } else if (b >= 0xC0) {
      out.push(32, b ^ 0x80);   // 空格 + 字符
    } else {
      // 0x80..0xBF：两字节，距离/长度对
      if (i >= n) break;
      const b2 = bytes[i++];
      const dist = ((b << 8 | b2) >> 3) & 0x07FF;
      const len = (b2 & 0x07) + 3;
      if (dist === 0) break;
      let srcpos = out.length - dist;
      for (let j = 0; j < len; j++) {
        if (srcpos < 0 || srcpos >= out.length) break;
        out.push(out[srcpos++]);
      }
    }
  }
  return Uint8Array.from(out);
}

function readU16BE(dv, off) { return dv.getUint16(off, false); }
function readU32BE(dv, off) { return dv.getUint32(off, false); }

export function parseMobi(arrayBuffer) {
  const buf = arrayBuffer instanceof ArrayBuffer ? arrayBuffer : arrayBuffer.buffer;
  const dv = new DataView(buf);
  const bytes = new Uint8Array(buf);
  if (bytes.length < 78) throw new Error('MOBI_TOO_SMALL');

  // PalmDB 记录数（偏移 76 起 U16BE），记录偏移表从 78 起，每条 8 字节（4 offset + 4 attr/uid）
  const numRecords = readU16BE(dv, 76);
  const recOffsets = [];
  for (let i = 0; i < numRecords; i++) {
    recOffsets.push(readU32BE(dv, 78 + i * 8));
  }
  recOffsets.push(bytes.length);   // 末尾哨兵
  const recData = (idx) => bytes.subarray(recOffsets[idx], recOffsets[idx + 1]);

  // 记录 0 = PalmDOC 头 + MOBI 头 + EXTH
  const rec0 = recData(0);
  const rdv = new DataView(rec0.buffer, rec0.byteOffset, rec0.byteLength);
  const compression = readU16BE(rdv, 0);        // 1=无压缩 2=PalmDOC 17480=HUFF/CDIC
  const textRecordCount = readU16BE(rdv, 8);
  const recordSize = readU16BE(rdv, 10);        // 一般 4096
  let encoding = 1252;
  let fullName = '';
  let author = '';
  let extraFlags = 0;
  let firstImageIndex = 0;

  // MOBI 头识别（rec0 偏移 16 起 "MOBI"）
  const hasMobiHeader = rec0.length >= 20 && rec0[16] === 0x4D && rec0[17] === 0x4F && rec0[18] === 0x42 && rec0[19] === 0x49;
  if (hasMobiHeader) {
    const mobiHeaderLen = readU32BE(rdv, 20);
    encoding = readU32BE(rdv, 28);              // 65001=UTF-8 1252=win1252
    // extraFlags 在 rec0 偏移 0xF2（U16BE）；仅当 MOBI 头够长且 rec0 覆盖到该位置时才读
    try { if (16 + mobiHeaderLen >= 0xF4 && rec0.length >= 0xF4) extraFlags = readU16BE(rdv, 0xF2); } catch (_) {}
    // firstImageIndex 位于 PalmDOC 记录 0 的绝对偏移 0x6c（即 MOBI 头相对偏移 0x5c）。
    // 0 / 0xffffffff 表示没有图片资源。
    try {
      const value = readU32BE(rdv, 0x6C);
      if (value > 0 && value !== 0xFFFFFFFF && value < numRecords) firstImageIndex = value;
    } catch (_) {}
    // 书名：fullName offset/length（MOBI 头偏移 0x54/0x58，均相对 rec0 起点=16）
    try {
      const nameOff = readU32BE(rdv, 0x54);
      const nameLen = readU32BE(rdv, 0x58);
      if (nameOff && nameLen && nameOff + nameLen <= rec0.length) {
        fullName = decodeBytes(rec0.subarray(nameOff, nameOff + nameLen), encoding);
      }
    } catch (_) {}
    // EXTH（在 MOBI 头之后，标志 rec0 偏移 0x80 bit6）
    try {
      const exthFlags = readU32BE(rdv, 0x80);
      if (exthFlags & 0x40) {
        const exthStart = 16 + mobiHeaderLen;
        if (rec0[exthStart] === 0x45 && rec0[exthStart + 1] === 0x58 && rec0[exthStart + 2] === 0x54 && rec0[exthStart + 3] === 0x48) {
          const count = readU32BE(rdv, exthStart + 8);
          let p = exthStart + 12;
          for (let i = 0; i < count && p + 8 <= rec0.length; i++) {
            const type = readU32BE(rdv, p);
            const len = readU32BE(rdv, p + 4);
            if (len < 8) break;
            const val = rec0.subarray(p + 8, p + len);
            if (type === 100 && !author) author = decodeBytes(val, encoding).trim();      // creator
            else if (type === 503 && !fullName) fullName = decodeBytes(val, encoding).trim(); // updated title
            p += len;
          }
        }
      }
    } catch (_) {}
  }

  if (compression !== 1 && compression !== 2) {
    throw new Error('MOBI_HUFFCDIC_UNSUPPORTED');   // HUFF/CDIC 或 KF8：不支持
  }

  // extraFlags 决定每条文本记录尾部要剥掉的多字节区（否则会混入乱码）
  const trimTrailing = (rec) => {
    let end = rec.length;
    let flags = extraFlags;
    // bit1..（高位）每置位剥一段变长尾；bit0 剥 1 字节
    for (let bit = 1; bit < 16; bit++) {
      if (flags & (1 << bit)) {
        end -= backwardVarLen(rec, end);
      }
    }
    if (flags & 1) {
      if (end > 0) end -= (rec[end - 1] & 0x3) + 1;
    }
    return rec.subarray(0, Math.max(0, end));
  };

  // 文本记录：记录 1 .. textRecordCount
  const parts = [];
  const count = Math.min(textRecordCount, numRecords - 1);
  for (let i = 1; i <= count; i++) {
    let rec = recData(i);
    if (!rec || !rec.length) continue;
    rec = trimTrailing(rec);
    const chunk = compression === 2 ? palmDocDecompress(rec) : rec;
    parts.push(chunk);
  }
  // 合并
  let total = 0;
  for (const p of parts) total += p.length;
  const merged = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { merged.set(p, off); off += p.length; }

  const html = decodeBytes(merged, encoding);
  const text = stripHtmlToText(html);
  // 书名兜底：EXTH/fullName 没有则从正文首个标题猜
  const title = (fullName || pickHtmlTitle(html) || '').trim();
  const media = extractMobiImages(html, firstImageIndex, recData, numRecords);
  return { title, author: author || '', text, ...media };
}

function mobiImageType(bytes) {
  if (!bytes || bytes.length < 4) return '';
  if (bytes[0] === 0xFF && bytes[1] === 0xD8) return 'image/jpeg';
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47) return 'image/png';
  const head = String.fromCharCode(...bytes.subarray(0, Math.min(6, bytes.length)));
  if (head === 'GIF87a' || head === 'GIF89a') return 'image/gif';
  if (head.slice(0, 4) === 'RIFF' && bytes.length >= 12 && String.fromCharCode(...bytes.subarray(8, 12)) === 'WEBP') return 'image/webp';
  return '';
}

// 把经典 MOBI 的 <img recindex="00001"> 页序转成与 EPUB/CBZ 相同的占位符章节。
// 只提取正文实际引用的记录，避免把封面缩略图、索引记录等内部资源误当漫画页。
function extractMobiImages(html, firstImageIndex, recData, numRecords) {
  if (!firstImageIndex || !html) return {};
  const refs = [];
  const imgRe = /<img\b[^>]*\brecindex\s*=\s*["']?(\d+)["']?[^>]*>/gi;
  let match;
  while ((match = imgRe.exec(html)) !== null) {
    const ref = Number.parseInt(match[1], 10);
    if (!Number.isFinite(ref) || ref < 1 || refs.some((item) => item.ref === ref)) continue;
    const alt = (/\balt\s*=\s*["']([^"']*)["']/i.exec(match[0]) || [])[1] || '';
    refs.push({ ref, alt: decodeHtmlEntities(alt).trim() });
  }
  if (!refs.length) return {};
  const images = [];
  const chapters = [];
  for (const item of refs) {
    const recordIndex = firstImageIndex + item.ref - 1;
    if (recordIndex < 0 || recordIndex >= numRecords) continue;
    const raw = recData(recordIndex);
    const mime = mobiImageType(raw);
    if (!mime || !raw?.length) continue;
    const n = images.length + 1;
    // 导入器会立即逐页写入 IndexedDB；这里保留视图可避免 70MB 漫画解析时再复制一整份峰值内存。
    const bytes = raw;
    images.push({ n, bytes, mime, recindex: item.ref });
    chapters.push({ title: item.alt || (n === 1 ? '封面' : `第 ${n - 1} 页`), content: `⟦img:${n}⟧` });
  }
  if (!images.length) return {};
  return {
    chapters,
    images,
    cover: { bytes: images[0].bytes, mime: images[0].mime },
    pageCount: images.length,
  };
}

// 变长尾长度：MOBI 文本记录尾部「多字节 trailing 区」的大小，编码在该区最后 1~4 字节里。
// 规则：从末字节往前读，每字节低 7 位拼进长度，高位(0x80)置 1 的那个字节即为长度编码的最前字节（停止）。
function backwardVarLen(rec, end) {
  let size = 0;
  for (let i = end - 1; i >= 0 && i >= end - 4; i--) {
    const b = rec[i];
    size = (size << 7) | (b & 0x7F);
    if (b & 0x80) break;
  }
  return size > 0 && size <= end ? size : 0;
}

// 按编码解码字节（65001→utf-8，其余→windows-1252/gbk 尽力）
function decodeBytes(bytes, encoding) {
  const enc = encoding === 65001 ? 'utf-8' : (encoding === 1252 ? 'windows-1252' : 'utf-8');
  try { return new TextDecoder(enc).decode(bytes); }
  catch (_) { try { return new TextDecoder('utf-8').decode(bytes); } catch (__) { return ''; } }
}
