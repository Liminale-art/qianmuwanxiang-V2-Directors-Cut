// 书架的排序、标签与搜索。只管数据，不碰界面与存储。
// 排序：选一个字段，再选升序或降序（换字段时回到这个字段顺手的方向）。存成「字段-方向」，如 addedAt-desc。
// 标签：一本书可以有多个；标签可改名（与已有的同名时合并）、删除、配颜色。颜色没配时按名字从一组色里取，同名总是同色。
// 搜索：书名、作者、标签、合集、书友，可以只在其中一项里找；每项各命中几本，给界面显示。

export const SHELF_SORTS = Object.freeze([
  { field: 'lastReadAt', name: '最近阅读', dir: 'desc' },
  { field: 'addedAt', name: '添加时间', dir: 'desc' },
  { field: 'together', name: '共读时长', dir: 'desc' },
  { field: 'progress', name: '进度', dir: 'desc' },
  { field: 'length', name: '篇幅', dir: 'desc' },
  { field: 'title', name: '书名', dir: 'asc' },
  { field: 'author', name: '作者', dir: 'asc' },
]);

export const SHELF_SEARCH_FIELDS = Object.freeze([
  { field: 'all', name: '全部' },
  { field: 'title', name: '书名' },
  { field: 'author', name: '作者' },
  { field: 'tags', name: '标签' },
  { field: 'collection', name: '合集' },
  { field: 'pals', name: '书友' },
]);

export const TAG_PALETTE = Object.freeze(['#d9734e', '#d9a03a', '#7ba653', '#3e9d8a', '#4a8cc4', '#7a6ccc', '#c15c97', '#8a8f98']);
const HEX = /^#[0-9a-f]{6}$/i;
const TAG_LIMIT = 12, TAG_CHARS = 20;

/** 「字段-方向」拆开；认不出的回到最近添加。 */
export function parseShelfSort(key) {
  const [field, dir] = String(key || '').split('-');
  const known = SHELF_SORTS.find(item => item.field === field) || SHELF_SORTS[1];
  return { field: known.field, dir: dir === 'asc' || dir === 'desc' ? dir : known.dir, name: known.name };
}
/** 换字段：用这个字段顺手的方向。 */
export function shelfSortFor(field) { const known = SHELF_SORTS.find(item => item.field === field) || SHELF_SORTS[1]; return `${known.field}-${known.dir}`; }
/** 只翻方向。 */
export function flipShelfSort(key) { const { field, dir } = parseShelfSort(key); return `${field}-${dir === 'asc' ? 'desc' : 'asc'}`; }

/** 排好的新数组。together(book)：和书友一起读了多久（毫秒）。名字相同的按添加时间新到旧。 */
export function sortShelfBooks(books, key, { together = () => 0 } = {}) {
  const { field, dir } = parseShelfSort(key), mul = dir === 'asc' ? 1 : -1;
  const value = book => {
    switch (field) {
      case 'title': return String(book.title || '');
      case 'author': return String(book.author || '');
      case 'progress': return Number(book.progress) || 0;
      case 'lastReadAt': return Number(book.lastReadAt) || 0;
      case 'length': return Number(book.charCount ?? book.pageCount) || 0;
      case 'together': return Number(together(book)) || 0;
      default: return Number(book.addedAt) || 0;
    }
  };
  return [...(Array.isArray(books) ? books : [])].sort((a, b) => {
    const va = value(a), vb = value(b);
    const order = typeof va === 'string' ? va.localeCompare(vb, 'zh') : va - vb;
    return mul * order || (Number(b.addedAt) || 0) - (Number(a.addedAt) || 0);
  });
}

/** 用户输入的标签：逗号、顿号、分号或空格分开；去空、去重、截短，最多 12 个。 */
export function normalizeTags(input) {
  const list = Array.isArray(input) ? input : String(input ?? '').split(/[,，、;；\s]+/);
  const out = [];
  for (const item of list) { const tag = String(item ?? '').trim().slice(0, TAG_CHARS); if (tag && !out.includes(tag)) out.push(tag); }
  return out.slice(0, TAG_LIMIT);
}

/** 书架上所有标签与各有几本，按本数多到少、再按名字。 */
export function shelfTags(books) {
  const counts = new Map();
  for (const book of Array.isArray(books) ? books : []) for (const tag of normalizeTags(book?.tags || [])) counts.set(tag, (counts.get(tag) || 0) + 1);
  return [...counts].map(([tag, count]) => ({ tag, count })).sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag, 'zh'));
}

export function tagColor(tag, colors = {}) {
  const picked = colors?.[tag];
  if (HEX.test(String(picked || ''))) return picked.toLowerCase();
  let hash = 0; for (const ch of String(tag)) hash = (hash * 31 + ch.codePointAt(0)) >>> 0;
  return TAG_PALETTE[hash % TAG_PALETTE.length];
}

/**
 * 一次改完标签：edits = [{ from, to, color, remove }]。改名到已有的名字就并进去；删掉的从每本书上拿掉。
 * 直接改 books 里每本书的 tags，返回新的颜色表（删掉或改走的名字不再留颜色）。
 */
export function applyTagEdits(books, colors = {}, edits = []) {
  const map = new Map(), nextColors = {};
  for (const edit of Array.isArray(edits) ? edits : []) {
    const from = String(edit?.from || ''); if (!from) continue;
    const to = edit.remove ? '' : (normalizeTags([edit.to ?? from])[0] || from);
    map.set(from, to);
    if (to && HEX.test(String(edit.color || ''))) nextColors[to] = edit.color.toLowerCase();
  }
  for (const book of Array.isArray(books) ? books : []) {
    if (!Array.isArray(book?.tags) || !book.tags.length) continue;
    book.tags = normalizeTags(book.tags.map(tag => map.has(tag) ? map.get(tag) : tag).filter(Boolean));
  }
  const alive = new Set(shelfTags(books).map(item => item.tag));
  for (const [tag, color] of Object.entries(colors || {})) if (alive.has(tag) && !map.has(tag) && !(tag in nextColors) && HEX.test(String(color))) nextColors[tag] = color.toLowerCase();
  for (const tag of Object.keys(nextColors)) if (!alive.has(tag)) delete nextColors[tag];
  return nextColors;
}

/** 一本书可搜的几项（都转成小写）。collection：所在合集名；pals：一起读过的书友名字。 */
export function bookSearchFields(book, { collection = '', pals = [] } = {}) {
  const low = value => String(value || '').toLowerCase();
  return { title: low(book?.title), author: low(book?.author), tags: normalizeTags(book?.tags || []).map(low), collection: low(collection), pals: (Array.isArray(pals) ? pals : []).map(low).filter(Boolean) };
}

/** 这本书在 field 这一项里有没有 query。field 为 all 时任一项都算。 */
export function matchBook(fields, query, field = 'all') {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return true;
  const hit = name => { const value = fields?.[name]; return Array.isArray(value) ? value.some(item => item.includes(q)) : String(value || '').includes(q); };
  return field === 'all' ? ['title', 'author', 'tags', 'collection', 'pals'].some(hit) : hit(field);
}

/** 每一项各命中几本（「全部」是任一项命中的本数）。 */
export function searchCounts(list, query) {
  const out = {};
  for (const { field } of SHELF_SEARCH_FIELDS) out[field] = (Array.isArray(list) ? list : []).filter(fields => matchBook(fields, query, field)).length;
  return out;
}
