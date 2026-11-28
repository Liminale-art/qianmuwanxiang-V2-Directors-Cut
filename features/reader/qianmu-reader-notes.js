// 伴读笔记（划线、批注、书签）的数据形状与旧笔记的一次性换算。纯函数，不碰 DOM、不读设置、不存盘。
//
// 一本书一条记录 { v:1, notes:[…], updatedAt }，存在 IndexedDB 的 reader_notes，经账户镜像跨设备。
// 每条笔记：{ id, kind:'highlight'|'bookmark', from, to, ch, text, hlStyle, color, annotation, tags, favorite, at, updatedAt }。
// from／to 是全局投影位置（见 qianmu-reader-model.js），ch 只用于显示；text 是创建时截下的原文。
// 旧书的划线只记了章号和文字（有的还有逐段的 segments）。换算时在那一章里找这段字：
//   · 只找到一处：锚定在那里；
//   · 找到几处：第一处成为这条划线，其余几处列进 candidates，由用户在「未定位」一组里逐处挑；
//   · 一处都找不到：from = null，进「未定位」。
// 找的时候忽略所有空白：旧渲染器在有空行的书里会把单换行并成空格，选区文字里的换行也因浏览器而异。

export const NOTES_RECORD_VERSION = 1;
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const finite = value => (value === null || value === undefined || value === '' ? null : Number.isFinite(Number(value)) ? Number(value) : null);
const IMAGE_GAP = /^(?:⟦img:\d+⟧)*$/;

/** 这条划线在正文里有确定的位置。 */
export const notePlaced = note => Number.isFinite(note?.from) && Number.isFinite(note?.to) && note.to > note.from;

/** 读入的记录（本机、账户、备份包）：格式不对的条目丢掉，绝不抛错。不像一条记录时返回 null。 */
export function normalizeNotesRecord(raw) {
  if (!plain(raw) || !Array.isArray(raw.notes)) return null;
  const seen = new Set(), notes = [];
  for (const note of raw.notes) {
    if (!plain(note) || (note.kind !== 'highlight' && note.kind !== 'bookmark')) continue;
    const id = String(note.id || '');
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const from = finite(note.from), to = finite(note.to);
    const next = { ...note, id, from, ch: Math.max(0, Math.floor(finite(note.ch) ?? 0)) };
    if (note.kind === 'highlight') next.to = to;
    if (Array.isArray(note.candidates)) {
      const candidates = note.candidates.filter(item => plain(item) && Number.isFinite(item.from) && Number.isFinite(item.to) && item.to > item.from).map(({ from: a, to: b }) => ({ from: a, to: b }));
      if (candidates.length) next.candidates = candidates; else delete next.candidates;
    }
    notes.push(next);
  }
  return { v: NOTES_RECORD_VERSION, notes, updatedAt: Math.max(0, finite(raw.updatedAt) ?? 0) };
}

export const emptyNotesRecord = () => ({ v: NOTES_RECORD_VERSION, notes: [], updatedAt: 0 });

// 去掉全部空白后的文字，以及每个字在原文里的下标。
function compact(text) {
  const source = String(text || ''), map = new Int32Array(source.length);
  let out = '', n = 0;
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    if (/\s/.test(char)) continue;
    out += char; map[n++] = i;
  }
  return { text: out, map };
}

/**
 * 在一章正文里找旧划线：parts 是按段的文字（没有 segments 时就是整段文字）。
 * 返回章内区间 [{from, to}]，按出现先后排，互不重叠。各段之间只允许隔着空白或插图占位。
 */
export function locateLegacyText(content, parts, compacted = null) {
  const body = compacted || compact(content);
  const pieces = (Array.isArray(parts) ? parts : [parts]).map(part => compact(part).text).filter(Boolean);
  if (!pieces.length || !body.text) return [];
  const found = [];
  let from = 0, last = 0;
  for (;;) {
    const at = body.text.indexOf(pieces[0], from);
    if (at < 0) break;
    from = at + pieces[0].length;
    if (at < last) continue;
    let end = at + pieces[0].length, whole = true;
    for (const piece of pieces.slice(1)) {
      const next = body.text.indexOf(piece, end);
      if (next < 0 || !IMAGE_GAP.test(body.text.slice(end, next))) { whole = false; break; }
      end = next + piece.length;
    }
    if (!whole) continue;
    found.push({ from: body.map[at], to: body.map[end - 1] + 1 });
    last = end;
  }
  return found;
}

/**
 * 旧笔记（settings 里 meta.notes）→ 新记录。projection 为这本书的投影（createProjection）。
 * 结果只由旧笔记和正文决定（updatedAt 取最晚一条的时间），两台设备各自换算会得到同一份。
 */
export function convertLegacyNotes(legacy, projection) {
  const notes = [], seen = new Set(), cache = new Map();
  const count = projection?.starts?.length || 0;
  const chapterText = index => {
    if (!cache.has(index)) cache.set(index, compact(projection.chapters[index]?.content || ''));
    return cache.get(index);
  };
  let latest = 0;
  for (const [index, raw] of (Array.isArray(legacy) ? legacy : []).entries()) {
    if (!plain(raw) || (raw.kind !== 'highlight' && raw.kind !== 'bookmark')) continue;
    let id = String(raw.id || '') || `legacy-${index}`;
    if (seen.has(id)) id = `${id}-${index}`;
    seen.add(id);
    const { chapterIndex, segments, ...rest } = raw;
    const at = Math.max(0, finite(raw.at) ?? 0);
    latest = Math.max(latest, at);
    const ci = finite(chapterIndex), inBook = ci !== null && Number.isInteger(ci) && ci >= 0 && ci < count;
    const ch = inBook ? ci : Math.max(0, Math.floor(ci ?? 0));
    const note = { ...rest, id, kind: raw.kind, ch, at, updatedAt: at };
    if (raw.kind === 'bookmark') {
      note.from = inBook ? projection.starts[ci] : null;
      notes.push(note);
      continue;
    }
    const parts = Array.isArray(segments) && segments.some(part => String(part || '').trim()) ? segments : [raw.text];
    const places = inBook ? locateLegacyText('', parts, chapterText(ci)) : [];
    const start = inBook ? projection.starts[ci] : 0;
    note.from = places.length ? start + places[0].from : null;
    note.to = places.length ? start + places[0].to : null;
    if (places.length > 1) note.candidates = places.slice(1).map(place => ({ from: start + place.from, to: start + place.to }));
    notes.push(note);
  }
  return { v: NOTES_RECORD_VERSION, notes, updatedAt: latest || 1 };
}

/**
 * 一章里要画的区间（章内坐标），给旧渲染器包 <mark> 用。pick：旧划线另外几处待挑的位置。
 * 跨章的划线只取落在本章的一段。
 */
export function chapterMarks(notes, chapterStart, chapterLength) {
  const out = [], end = chapterStart + chapterLength;
  const add = (from, to, item) => {
    const a = Math.max(from, chapterStart), b = Math.min(to, end);
    if (b > a) out.push({ ...item, from: a - chapterStart, to: b - chapterStart });
  };
  for (const note of Array.isArray(notes) ? notes : []) {
    if (note?.kind !== 'highlight') continue;
    if (notePlaced(note)) add(note.from, note.to, { id: note.id, hlStyle: note.hlStyle, color: note.color });
    for (const [index, place] of (note.candidates || []).entries()) add(place.from, place.to, { id: note.id, pick: index });
  }
  return out;
}

/** 把旧划线待挑的第 index 处留成一条独立的划线（样式、颜色照旧，批注不带过去）。 */
export function keepCandidate(record, noteId, index, { id, now, chapterOf = () => 0 }) {
  const notes = (record?.notes || []).flatMap(note => {
    if (note.id !== noteId || !note.candidates?.[index]) return [note];
    const place = note.candidates[index], rest = note.candidates.filter((_, i) => i !== index);
    const { candidates: _drop, annotation: _note, tags: _tags, favorite: _fav, ...base } = note;
    const kept = { ...base, id, from: place.from, to: place.to, ch: chapterOf(place.from), annotation: '', at: now, updatedAt: now };
    const { candidates: _old, ...origin } = note;
    return [rest.length ? { ...note, candidates: rest, updatedAt: now } : { ...origin, updatedAt: now }, kept];
  });
  return { ...record, notes, updatedAt: now };
}

/** 不要旧划线待挑的第 index 处。 */
export function dropCandidate(record, noteId, index, { now }) {
  const notes = (record?.notes || []).map(note => {
    if (note.id !== noteId || !note.candidates?.[index]) return note;
    const rest = note.candidates.filter((_, i) => i !== index), { candidates: _old, ...origin } = note;
    return rest.length ? { ...note, candidates: rest, updatedAt: now } : { ...origin, updatedAt: now };
  });
  return { ...record, notes, updatedAt: now };
}
