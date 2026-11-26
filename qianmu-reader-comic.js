// 伴读·漫画识图的纯逻辑：每本漫画一份记录（逐页画面稿、分段总结、人物表、阅读方向），
// 以及分批规划、提示词、模型回复解析、书友可见文字、按书友补建切片的判断。
// 不读写存储、不调模型、不碰页面；index.js 只负责接线。经 qianmu-reader.js 一并导出。

// 记录与伴读对话同存一个仓（随 ST 账户同步），键不带书友／人设：识图花钱，结果是这本书的事实。
export const COMIC_RECORD_PREFIX = 'comic::';
export const comicRecordKey = bookId => `${COMIC_RECORD_PREFIX}${bookId}`;
export const isComicRecordKey = key => String(key ?? '').startsWith(COMIC_RECORD_PREFIX);

export const COMIC_DIRECTIONS = Object.freeze([['rtl', '右到左（日漫）'], ['ltr', '左到右'], ['ttb', '上到下（条漫）']]);
const DIRECTION_RULES = {
  rtl: '日漫，右到左。每页从右上角那一格读起，同一行先右后左，读完一行再往下；同一格里的气泡也是先右后左、先上后下。',
  ltr: '左到右。每页从左上角那一格读起，同一行先左后右，读完一行再往下；同一格里的气泡也是先左后右、先上后下。',
  ttb: '条漫，上到下。自上而下逐格读，同一格里的气泡先上后下。',
};
const CAST_MAX = 80, PREVIOUS_TAIL = 400;

const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const clip = (value, max) => (typeof value === 'string' || typeof value === 'number' ? String(value).trim().slice(0, max) : '');
const pageNumber = value => { const n = Number(value); return Number.isInteger(n) && n >= 1 ? n : 0; };
const stamp = value => (Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : 0);
const castKey = name => String(name).replace(/\s+/g, '').toLowerCase();

function cleanKeywords(value, max = 8) {
  const list = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/[,，、\n]+/) : [];
  return [...new Set(list.map(item => clip(item, 40)).filter(Boolean))].slice(0, max);
}

// 对白：接受 [{speaker,text}]、["甲：话"]、整段多行文字。说话人认不出记「？」。
function cleanDialogue(value) {
  const rows = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/\n+/) : [];
  const out = [];
  for (const row of rows) {
    let speaker = '', text = '';
    if (typeof row === 'string') {
      const match = /^\s*([^：:\n]{1,20})[：:]\s*([\s\S]+)$/.exec(row);
      if (match) { speaker = match[1]; text = match[2]; } else text = row;
    } else if (plain(row)) {
      speaker = row.speaker ?? row.name ?? row.role ?? '';
      text = row.text ?? row.line ?? row.content ?? '';
    }
    text = clip(text, 600);
    if (!text) continue;
    out.push({ speaker: clip(speaker, 40) || '？', text });
    if (out.length >= 80) break;
  }
  return out;
}

function cleanPanels(value) {
  if (Array.isArray(value)) {
    return clip(value.map(item => (plain(item) ? clip(item.text ?? item.description ?? item.content ?? '', 1000) : clip(item, 1000))).filter(Boolean).join('\n'), 4000);
  }
  return clip(value, 4000);
}

function cleanPage(value) {
  if (!plain(value)) return null;
  const panels = cleanPanels(value.panels), dialogue = cleanDialogue(value.dialogue);
  return panels || dialogue.length ? { panels, dialogue, updatedAt: stamp(value.updatedAt) } : null;
}

/** 人物表：{name, look, note?, edited?}。空名丢弃，同名（忽略空白与大小写）只留第一个。 */
export function normalizeComicCast(list, { keepEdited = true } = {}) {
  const seen = new Set(), out = [];
  for (const item of Array.isArray(list) ? list : []) {
    if (!plain(item)) continue;
    const name = clip(item.name, 40), key = castKey(name);
    if (!name || seen.has(key)) continue;
    seen.add(key);
    const entry = { name, look: clip(item.look ?? item.appearance ?? '', 300) }, note = clip(item.note, 300);
    if (note) entry.note = note;
    if (keepEdited && item.edited === true) entry.edited = true;
    out.push(entry);
    if (out.length >= CAST_MAX) break;
  }
  return out;
}

/** 合并模型提议的人物：只添加表里没有的名字；已有条目不改不删，唯一例外是没被用户动过且外貌为空的条目补上外貌。 */
export function mergeComicCast(cast, proposed) {
  const merged = normalizeComicCast(cast);
  for (const item of normalizeComicCast(proposed, { keepEdited: false })) {
    const index = merged.findIndex(entry => castKey(entry.name) === castKey(item.name));
    if (index < 0) { if (merged.length < CAST_MAX) merged.push(item); continue; }
    if (!merged[index].edited && !merged[index].look && item.look) merged[index] = { ...merged[index], look: item.look };
  }
  return merged;
}

function cleanSegments(list) {
  const out = [];
  const rows = (Array.isArray(list) ? list : []).filter(plain).map(item => ({
    fromPage: pageNumber(item.fromPage), toPage: pageNumber(item.toPage), summary: clip(item.summary, 4000),
    keywords: cleanKeywords(item.keywords), updatedAt: stamp(item.updatedAt),
  })).filter(item => item.fromPage && item.toPage >= item.fromPage && item.summary)
    .sort((a, b) => a.fromPage - b.fromPage || b.updatedAt - a.updatedAt);
  for (const item of rows) if (!out.length || out.at(-1).toPage < item.fromPage) out.push(item);   // 分段互不重叠
  return out;
}

/**
 * 把存下来的记录（或空）整理成固定形状。旧版写在书籍记录上的 comicDescriptions 作为兜底并入：
 * 只补进尚无分段覆盖的页，原有内容照常可见。
 */
export function normalizeComicRecord(raw, bookId = '', legacyDescriptions = null) {
  const source = plain(raw) ? raw : {};
  const pages = {};
  for (const [key, value] of Object.entries(plain(source.pages) ? source.pages : {})) {
    const page = pageNumber(key), detail = cleanPage(value);
    if (page && detail) pages[page] = detail;
  }
  const own = cleanSegments(source.segments);
  const legacy = cleanSegments(Object.values(plain(legacyDescriptions) ? legacyDescriptions : {}))
    .filter(item => !own.some(segment => segment.fromPage <= item.toPage && segment.toPage >= item.fromPage));
  const record = {
    kind: 'comic', version: 1, bookId: String(source.bookId || bookId || ''),
    direction: DIRECTION_RULES[source.direction] ? source.direction : 'rtl',
    cast: normalizeComicCast(source.cast), pages,
    segments: [...own, ...legacy].sort((a, b) => a.fromPage - b.fromPage),
    lastBatch: null,
  };
  if (plain(source.lastBatch) && pageNumber(source.lastBatch.images)) {
    const last = { images: pageNumber(source.lastBatch.images), at: stamp(source.lastBatch.at) };
    for (const key of ['input', 'output']) if (Number.isFinite(source.lastBatch[key]) && source.lastBatch[key] >= 0) last[key] = source.lastBatch[key];
    record.lastBatch = last;
  }
  return record;
}

const describedSet = record => {
  const set = new Set(Object.keys(record?.pages || {}).map(Number));
  for (const segment of record?.segments || []) for (let page = segment.fromPage; page <= segment.toPage; page++) set.add(page);
  return set;
};

/** 读到 current（页下标）为止：已读几页、其中几页已建稿、几页有图而未建稿、当前页是否已建稿。 */
export function comicStatus(record, current, hasImage = () => true) {
  const set = describedSet(record), read = Math.max(0, Math.floor(Number(current) || 0)) + 1;
  let described = 0, missing = 0;
  for (let page = 1; page <= read; page++) {
    if (set.has(page)) described++;
    else if (hasImage(page - 1)) missing++;
  }
  return { read, described, missing, currentDescribed: set.has(read) };
}

/**
 * 已读而未建稿的页分成批（页下标，闭区间），从前往后。绝不越过 current，绝不包含已建稿的页，每批不超过 pagesPerBatch。
 * closed＝这一批后面不会再长出新页（已凑满，或后面接着的是已建稿页／无图页）。
 */
export function planComicBatches({ record, current, pagesPerBatch = 3, hasImage = () => true } = {}) {
  const set = describedSet(record), last = Math.floor(Number(current)), size = Math.max(1, Math.min(8, Math.round(Number(pagesPerBatch) || 3)));
  const batches = [];
  let start = -1;
  const close = (end, open) => {
    for (let from = start; from <= end; from += size) {
      const to = Math.min(end, from + size - 1);
      batches.push({ from, to, closed: to - from + 1 === size || !open });
    }
    start = -1;
  };
  for (let index = 0; index <= last; index++) {
    const pending = !set.has(index + 1) && !!hasImage(index);
    if (pending && start < 0) start = index;
    if (!pending && start >= 0) close(index - 1, false);
  }
  if (start >= 0) close(last, true);
  return batches;
}

/** 跟读用：只取「不会再变」的一批——凑满的、被隔开的，或已读到全书最后一页时剩下的零头。 */
export function nextComicAutoBatch(input = {}) {
  const atEnd = Number(input.total) > 0 && Number(input.current) >= Number(input.total) - 1;
  return planComicBatches(input).find(batch => batch.closed || atEnd) || null;
}

// 用户 2026-11-17 修订稿。{{direction}} 处填入这本书设置的阅读方向；格式与两句字段说明为程序解析所需，原样保留。
export const COMIC_VISION_PROMPT = `你是漫画阅读记录员，依照给定页序逐页读取画面，所有记录均以画面可见内容为唯一依据。

【阅读顺序】
{{direction}}遵循这一阅读排布顺序，依次记录分格内容与对白条目。

【人物命名】
画面人物外貌与人物表条目匹配时，采用表内对应称呼；未匹配人物以直观外貌特征指代，并同步在人物表中新增对应条目（写入 cast）。仅当画面或对白明确标注姓名时，使用对应姓名称谓。

【单页记录】
panels：按阅读顺序逐格记录，每格对应一句表述，清晰呈现画面内的人物、场景、动作、神态与关键物件。
dialogue：逐条如实抄录对话气泡、旁白框与核心拟声词，完整保留原文原貌。可明确识别说话主体时标注对应speaker，无法识别时标注「？」；字迹无法辨识的内容标注「（看不清）」。

【整段汇总】
summary：将对应页码内容整合为连贯的第三人称情节记录，篇幅控制在120–300字，梳理清晰人物、事件与因果逻辑，承接上文叙事脉络。
keywords：提取3–8个核心检索词，优先选取人名、地点、核心事件、关键物件，便于后续回溯检索。

【输出规范】
记录范围严格限定于当前画面承载的信息，所有表述均有明确画面支撑。最终输出为单一JSON，不加代码块、不加解释：
{"pages":[{"page":页码,"panels":"…","dialogue":[{"speaker":"…","text":"…"}]}],"summary":"…","keywords":["…"],"cast":[{"name":"…","look":"…"}]}
pages 与本次给出的页码一一对应；没有对白给 []。cast 只放这几页新出现、人物表里没有的人物，没有就给 []。`;

/** 一批的识图请求文字。每次都带人物表与上一段总结的结尾，让称呼前后一致。from/to 为页下标。 */
export function buildComicVisionPrompt({ title = '', record, from, to } = {}) {
  const current = normalizeComicRecord(record), first = from + 1, last = to + 1;
  const numbers = Array.from({ length: last - first + 1 }, (_, i) => first + i);
  const previous = current.segments.filter(segment => segment.toPage < first).at(-1);
  const cast = current.cast.map(entry => `- ${entry.name}：${entry.look || '外貌未记'}${entry.note ? `（${entry.note}）` : ''}`).join('\n');
  return {
    system: COMIC_VISION_PROMPT.replace('{{direction}}', DIRECTION_RULES[current.direction]),
    user: [
      `《${title || '未命名漫画'}》第 ${first}${last > first ? `–${last}` : ''} 页。图片依次是第 ${numbers.join('、')} 页。`,
      `【人物表】\n${cast || '（暂无）'}`,
      previous ? `【上文】\n${previous.summary.length > PREVIOUS_TAIL ? '…' : ''}${previous.summary.slice(-PREVIOUS_TAIL)}` : '',
    ].filter(Boolean).join('\n\n'),
  };
}

/**
 * 解析模型回复。parsed＝已用宽松解析抠出的对象（可为 null）；salvaged＝解析失败时从原文抢救出的散文总结。
 * 页码对不上时按顺序对位；总结缺失而有逐页内容时用画面稿拼一段。什么都没有返回 null，绝不把空稿当成功。
 */
export function parseComicVisionReply(parsed, { from, to, title = '', salvaged = '' } = {}) {
  const source = plain(parsed) ? parsed : {}, expected = [];
  for (let page = from + 1; page <= to + 1; page++) expected.push(page);
  const rows = Array.isArray(source.pages) ? source.pages
    : plain(source.pages) ? Object.entries(source.pages).map(([page, value]) => (plain(value) ? { page, ...value } : { page, panels: value })) : [];
  const pages = {};
  rows.forEach((row, index) => {
    const item = plain(row) ? row : { panels: row };
    const detail = cleanPage({ panels: item.panels ?? item.description ?? item.content, dialogue: item.dialogue ?? item.dialog ?? item.lines });
    if (!detail) return;
    let page = pageNumber(Number(item.page ?? item.pageNumber ?? item.no));
    if (!expected.includes(page) || pages[page]) page = expected[index];
    if (page && !pages[page]) pages[page] = { panels: detail.panels, dialogue: detail.dialogue };
  });
  const order = Object.keys(pages).map(Number).sort((a, b) => a - b);
  const summary = clip(source.summary ?? source.description, 4000) || clip(salvaged, 4000)
    || clip(order.map(page => pages[page].panels).filter(Boolean).join(' '), 600);
  if (!summary) return null;
  let keywords = cleanKeywords(source.keywords);
  if (!keywords.length) keywords = cleanKeywords([title, '漫画']);
  return { pages, summary, keywords, cast: normalizeComicCast(source.cast, { keepEdited: false }) };
}

const figure = (usage, keys) => {
  for (const key of keys) { const value = usage[key]; if (value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value)) && Number(value) >= 0) return Number(value); }
  return null;
};
/** 模型回报的用量里读出输入／输出 token；没报就是 null，不估算。 */
export function comicUsageFigures(usage) {
  if (!plain(usage)) return null;
  const input = figure(usage, ['prompt_tokens', 'input_tokens', 'promptTokenCount']);
  const output = figure(usage, ['completion_tokens', 'output_tokens', 'candidatesTokenCount']);
  return input === null && output === null ? null : { input, output };
}

/** 把一批结果写进记录（返回新记录）：替换该范围内原有的页稿与分段，合并人物，记下这一批的图片数与用量。 */
export function applyComicBatch(record, { from, to }, result, { now = Date.now(), images = 0, usage = null } = {}) {
  const current = normalizeComicRecord(record), first = from + 1, last = to + 1;
  const pages = {};
  for (const [key, value] of Object.entries(current.pages)) if (Number(key) < first || Number(key) > last) pages[key] = value;
  for (const [key, value] of Object.entries(result.pages || {})) {
    const page = pageNumber(key), detail = cleanPage(value);
    if (page >= first && page <= last && detail) pages[page] = { ...detail, updatedAt: now };
  }
  const segments = cleanSegments([
    ...current.segments.filter(segment => segment.toPage < first || segment.fromPage > last),
    { fromPage: first, toPage: last, summary: result.summary, keywords: result.keywords, updatedAt: now },
  ]);
  const lastBatch = { images: Math.max(1, Math.round(Number(images) || last - first + 1)), at: now }, figures = comicUsageFigures(usage);
  for (const key of ['input', 'output']) if (figures && figures[key] !== null) lastBatch[key] = figures[key];
  return { ...current, pages, segments, cast: mergeComicCast(current.cast, result.cast), lastBatch };
}

/** 用户在卡片里改的人物表与阅读方向，整份写回（返回新记录）。 */
export function comicRecordWithSheet(record, { direction, cast } = {}) {
  const current = normalizeComicRecord(record);
  return { ...current, direction: DIRECTION_RULES[direction] ? direction : current.direction, cast: cast === undefined ? current.cast : normalizeComicCast(cast) };
}

/** 用户改了某段切片的文字：范围完全对上的分段总结跟着改。没有对上或内容没变时原样返回同一个对象。 */
export function comicRecordWithSummary(record, fromPage, toPage, { summary, keywords } = {}, now = Date.now()) {
  const text = clip(summary, 4000), keys = cleanKeywords(keywords);
  const index = (record?.segments || []).findIndex(segment => segment.fromPage === fromPage && segment.toPage === toPage);
  if (index < 0 || !text) return record;
  const old = record.segments[index];
  if (old.summary === text && old.keywords.join('\u0001') === keys.join('\u0001')) return record;
  const segments = record.segments.slice();
  segments[index] = { ...old, summary: text, keywords: keys, updatedAt: now };
  return { ...record, segments };
}

const pageBlock = (page, detail) => [
  `【漫画第 ${page} 页】`,
  detail.panels ? `画面：${detail.panels}` : '',
  detail.dialogue.length ? `对白：\n${detail.dialogue.map(line => `${line.speaker}：${line.text}`).join('\n')}` : '',
].filter(Boolean).join('\n');

/**
 * 书友能看到的漫画文字，只到当前页为止。当前页及前面几页用逐页画面稿（最多 6 页、占预算六成），
 * 更早的用分段总结（由近到远装到预算用完），按页序输出。分段跨过当前页的不取，防剧透。
 */
export function comicVisibleText(record, current, budget = 6000) {
  const page = Math.max(0, Math.floor(Number(current) || 0)) + 1, cap = Math.max(200, Number(budget) || 6000), detailCap = Math.floor(cap * 0.6);
  const details = [], summaries = [], detailed = new Set();
  let used = 0;
  for (let p = page; p >= 1 && p > page - 12 && details.length < 6; p--) {
    const detail = record?.pages?.[p];
    if (!detail) continue;
    const text = pageBlock(p, detail);
    if (details.length && used + text.length > detailCap) break;
    details.unshift(text); detailed.add(p); used += text.length;
  }
  const older = (record?.segments || []).filter(segment => segment.toPage <= page).sort((a, b) => b.toPage - a.toPage);
  for (const segment of older) {
    let covered = true;
    for (let p = segment.fromPage; p <= segment.toPage; p++) if (!detailed.has(p)) { covered = false; break; }
    if (covered) continue;
    const text = `【漫画第 ${segment.fromPage}${segment.toPage > segment.fromPage ? `–${segment.toPage}` : ''} 页·概要】\n${segment.summary}`;
    if ((details.length || summaries.length) && used + text.length > cap) break;
    summaries.unshift(text); used += text.length;
  }
  return [...summaries, ...details].join('\n\n');
}

const sliceRange = slice => {
  const provenance = plain(slice?.provenance) ? slice.provenance : {};
  const sources = Array.isArray(provenance.sources) && provenance.sources.length ? provenance.sources : [provenance.source || slice?.src];
  if (!sources.some(source => ['book', 'text'].includes(String(source || '').toLowerCase()))) return null;
  const from = provenance.chapterFrom ?? slice?.chapterFrom, to = provenance.chapterTo ?? slice?.chapterTo;
  if (from === null || from === undefined || to === null || to === undefined) return null;
  return Number.isInteger(Number(from)) && Number.isInteger(Number(to)) && Number(to) >= Number(from) ? [Number(from), Number(to)] : null;
};
const cleanRanges = list => (Array.isArray(list) ? list : [])
  .filter(range => Array.isArray(range) && Number.isInteger(range[0]) && Number.isInteger(range[1]) && range[1] >= range[0]).map(range => [range[0], range[1]]).slice(-500);
const within = (ranges, from, to) => ranges.some(range => range[0] <= from && range[1] >= to);

/**
 * 当前书友（记忆桶）缺切片的分段：已建稿、在已读范围内、没有任何正文切片盖住它、也没被用户在这个桶里删掉过。
 * 这些分段可直接用存好的总结补建切片，不调模型。
 */
export function comicSegmentsNeedingSlices(record, slices, current, dismissed = []) {
  const page = Math.floor(Number(current)) + 1, covered = (Array.isArray(slices) ? slices : []).map(sliceRange).filter(Boolean), skipped = cleanRanges(dismissed);
  return (record?.segments || []).filter(segment => segment.toPage <= page
    && !within(covered, segment.fromPage - 1, segment.toPage - 1) && !within(skipped, segment.fromPage - 1, segment.toPage - 1));
}

/** 漫画记忆一条最多几页（用户 2026-11-26 定 10）：识图仍按批，记忆把相邻的分段并起来，不调模型。 */
export const COMIC_SLICE_PAGES = 10;

/** 页范围内各分段的总结按页序接起来，关键词去重（最多 8 个）。合并的切片与重新识别后改写切片都用它。 */
export function comicSliceText(record, fromPage, toPage) {
  const parts = (record?.segments || []).filter(segment => segment.fromPage >= fromPage && segment.toPage <= toPage).sort((a, b) => a.fromPage - b.fromPage);
  return { summary: parts.map(segment => segment.summary).filter(Boolean).join('\n'), keywords: [...new Set(parts.flatMap(segment => segment.keywords || []))].slice(0, 8),
    updatedAt: Math.max(0, ...parts.map(segment => Number(segment.updatedAt) || 0)) };
}

/**
 * 把还没有切片的分段并成一条条记忆：页连续的相邻分段合在一起，合起来不超过 pages 页（单段本身超过的单独一条）。
 * final=false（跟读时）：末尾那组若还放得下下一段就先不落，等读到更多页；final=true（手动补齐）全部落下。
 * 返回 [{ fromPage, toPage, summary, keywords, updatedAt }]。
 */
export function planComicSlices(record, segments, { pages = COMIC_SLICE_PAGES, final = false } = {}) {
  const limit = Math.max(1, Math.floor(Number(pages) || COMIC_SLICE_PAGES));
  const span = item => item.toPage - item.fromPage + 1;
  const groups = [];
  let current = null;
  for (const segment of [...(segments || [])].sort((a, b) => a.fromPage - b.fromPage)) {
    if (current && segment.fromPage === current.toPage + 1 && span(current) + span(segment) <= limit) { current.toPage = segment.toPage; current.last = segment; continue; }
    if (current) groups.push(current);
    current = { fromPage: segment.fromPage, toPage: segment.toPage, last: segment };
  }
  if (current && (final || span(current) + span(current.last) > limit)) groups.push(current);
  return groups.map(group => ({ fromPage: group.fromPage, toPage: group.toPage, ...comicSliceText(record, group.fromPage, group.toPage) }));
}

/** 用户删掉了一条漫画切片：记下它盖住的页范围，之后不再自动补回。 */
export function comicDismissRange(dismissed, slice) {
  const ranges = cleanRanges(dismissed), range = sliceRange(slice);
  return range && !within(ranges, range[0], range[1]) ? [...ranges, range] : ranges;
}
/** 用户清空了全部记忆：现有分段都不再自动补回（之后新识别的页不受影响）。 */
export const comicDismissAll = record => (record?.segments || []).map(segment => [segment.fromPage - 1, segment.toPage - 1]);
/** 用户主动重新识别某一段：撤掉与它相交的「不再补回」。 */
export const comicUndismiss = (dismissed, from, to) => cleanRanges(dismissed).filter(range => range[1] < from || range[0] > to);

// ── 页面片段（沿用伴读中心现有卡片与控件的类名）────────────────────────────────────────────────
/** 「已建稿 X / 已读 Y 页」；busy 为正在识别的一批；withUsage 时附上一批的图片数与模型回报的 token。 */
export function renderComicStat(status, { lastBatch = null, busy = null, withUsage = false } = {}) {
  let html = `已建稿 <b>${status.described}</b> / 已读 ${status.read} 页`;
  if (busy) html += ` · 正在识别第 ${busy.from + 1}${busy.to > busy.from ? `–${busy.to + 1}` : ''} 页`;
  if (withUsage && lastBatch) {
    const parts = [`上一批 ${lastBatch.images} 张图`];
    if (Number.isFinite(lastBatch.input)) parts.push(`输入 ${lastBatch.input}`);
    if (Number.isFinite(lastBatch.output)) parts.push(`输出 ${lastBatch.output}`);
    html += `<br>${parts.join(' · ')}${parts.length > 1 ? ' token' : ''}`;
  }
  return html;
}

export function renderComicCastRow(entry, esc) {
  return `<div class="sd-reader-comic-castrow" data-note="${esc(entry?.note || '')}"${entry?.edited ? ' data-edited="1"' : ''}>
    <input class="sd-reader-minput sd-reader-comic-cast-name" placeholder="称呼" maxlength="40" value="${esc(entry?.name || '')}">
    <input class="sd-reader-minput sd-reader-comic-cast-look" placeholder="外貌特征" maxlength="300" value="${esc(entry?.look || '')}">
    <button type="button" class="sd-reader-mbtn sd-reader-comic-cast-del" title="删除"><i class="fa-solid fa-trash"></i></button>
  </div>`;
}

export function comicFillLabel(status, filling) {
  return filling ? '停止' : status.missing ? `补齐未识别的 ${status.missing} 页` : '已读的页都识别过了';
}

/** 记忆档案页里漫画专用的两张卡：识图进度与补齐、人物表。 */
export function renderComicMemoryCards({ record, status, filling = null }, esc) {
  return `
    <div class="sd-reader-mcard sd-reader-comic-memory">
      <div class="sd-reader-mcard-head"><i class="fa-solid fa-images"></i> 漫画识图</div>
      <div class="sd-reader-mrow">
        <span class="sd-reader-mrow-lab">阅读方向</span>
        <select class="sd-reader-minput sd-reader-comic-direction">${COMIC_DIRECTIONS.map(([value, label]) => `<option value="${value}"${record.direction === value ? ' selected' : ''}>${label}</option>`).join('')}</select>
      </div>
      <div class="sd-reader-mstate sd-reader-comic-stat">${renderComicStat(status, { busy: filling?.batch })}</div>
      <div class="sd-reader-mactions">
        <button type="button" class="sd-reader-mbtn sd-reader-comic-fill${filling ? ' sd-btn-danger' : ''}"${filling || status.missing ? '' : ' disabled'}>${comicFillLabel(status, filling)}</button>
      </div>
    </div>
    <details class="sd-reader-mcard sd-reader-comic-cast">
      <summary class="sd-reader-mcard-head"><i class="fa-solid fa-user-group"></i> 人物表</summary>
      <div class="sd-reader-comic-castlist">${record.cast.map(entry => renderComicCastRow(entry, esc)).join('')}</div>
      <button type="button" class="sd-reader-mbtn sd-reader-comic-cast-add"><i class="fa-solid fa-plus"></i> 添加人物</button>
    </details>`;
}
