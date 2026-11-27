// 阅读页的配色与主题方案。
// 配色：纸色＋字色两样，其余（次要字、分隔线、按钮底）由样式表按这两样调出来；「跟随千幕」就是不另配。
// 配色单选只换颜色；方案：把配色和排版（字号、行距、段距、页宽、两端对齐）存成一套，点一下全部换上。
// 只管数据，不碰界面与存储。

export const READER_PAPERS = Object.freeze([
  { id: 'follow', name: '跟随千幕' },
  { id: 'white', name: '纸白', paper: '#fbfaf6', ink: '#2b2a27' },
  { id: 'cream', name: '米黄', paper: '#f3ead6', ink: '#3a3125' },
  { id: 'green', name: '豆绿', paper: '#e2ecd9', ink: '#2c3829' },
  { id: 'mist', name: '雾蓝', paper: '#e4eaf1', ink: '#252f3a' },
  { id: 'night', name: '夜墨', paper: '#1c1e22', ink: '#c8c4bc' },
  { id: 'custom', name: '自定' },
]);
const HEX = /^#[0-9a-f]{6}$/i;
const SCHEME_LIMIT = 12, NAME_CHARS = 16;
const hex = (value, fallback) => HEX.test(String(value || '')) ? String(value).toLowerCase() : fallback;
const clamp = (value, min, max, fallback) => { const n = Number(value); return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback; };
export const TYPE_KEYS = Object.freeze(['fontSizePx', 'lineHeight', 'paraSpacing', 'contentWidthRem', 'justify', 'spacingPreset']);

/** 当前配色：{ id, paper, ink }；跟随千幕时是 null。自定的两样存在 paperCustom 里。 */
export function readerPaperOf(c) {
  const id = READER_PAPERS.some(item => item.id === c?.readerPaper) ? c.readerPaper : 'follow';
  if (id === 'follow') return null;
  if (id === 'custom') return { id, paper: hex(c?.readerPaperCustom?.paper, '#f6f1e7'), ink: hex(c?.readerPaperCustom?.ink, '#2e2a24') };
  const item = READER_PAPERS.find(p => p.id === id);
  return { id, paper: item.paper, ink: item.ink };
}

/** 阅读层根节点 style 里要加的两个变量；跟随千幕时为空串。 */
export function readerPaperVars(c) {
  const p = readerPaperOf(c);
  return p ? `--rd-paper:${p.paper};--rd-ink:${p.ink};` : '';
}

function normalizeType(value) {
  return {
    fontSizePx: Math.round(clamp(value?.fontSizePx, 14, 30, 19)),
    lineHeight: Math.round(clamp(value?.lineHeight, 1.4, 2.6, 1.9) * 10) / 10,
    paraSpacing: Math.round(clamp(value?.paraSpacing, 0.4, 2.4, 1) * 10) / 10,
    contentWidthRem: Math.round(clamp(value?.contentWidthRem, 28, 66, 42)),
    justify: value?.justify === true,
    spacingPreset: ['compact', 'normal', 'loose', 'custom'].includes(value?.spacingPreset) ? value.spacingPreset : 'normal',
  };
}

/** 此刻的一整套：配色＋排版。 */
export function readerThemeSnapshot(c) {
  const paper = READER_PAPERS.some(item => item.id === c?.readerPaper) ? c.readerPaper : 'follow';
  return { paper, ...(paper === 'custom' ? { custom: { paper: hex(c?.readerPaperCustom?.paper, '#f6f1e7'), ink: hex(c?.readerPaperCustom?.ink, '#2e2a24') } } : {}), ...normalizeType(c) };
}

/** 存着的方案：名字、id、配色与排版；认不出的丢掉，最多 12 套。 */
export function normalizeReaderThemes(list) {
  const out = [], seen = new Set();
  for (const item of Array.isArray(list) ? list : []) {
    const id = String(item?.id || '').slice(0, 40), name = String(item?.name || '').trim().slice(0, NAME_CHARS);
    if (!id || !name || seen.has(id)) continue;
    seen.add(id);
    const snap = readerThemeSnapshot({ readerPaper: item.paper, readerPaperCustom: item.custom, ...item });
    out.push({ id, name, ...snap });
    if (out.length >= SCHEME_LIMIT) break;
  }
  return out;
}

/** 把一套方案换到设置上（直接改 c）。 */
export function applyReaderTheme(c, theme) {
  const snap = readerThemeSnapshot({ readerPaper: theme?.paper, readerPaperCustom: theme?.custom, ...theme });
  c.readerPaper = snap.paper;
  if (snap.custom) c.readerPaperCustom = { ...snap.custom };
  for (const key of TYPE_KEYS) c[key] = snap[key];
  return c;
}

/** 此刻的设置是不是正好就是这套方案。 */
export function sameReaderTheme(c, theme) {
  const a = readerThemeSnapshot(c), b = readerThemeSnapshot({ readerPaper: theme?.paper, readerPaperCustom: theme?.custom, ...theme });
  return JSON.stringify(a) === JSON.stringify(b);
}

/** 存一套新方案：名字重了就替换那一套，满 12 套时挤掉最早的。 */
export function saveReaderTheme(list, c, name, id) {
  const clean = String(name || '').trim().slice(0, NAME_CHARS);
  if (!clean) return normalizeReaderThemes(list);
  const rest = normalizeReaderThemes(list).filter(item => item.name !== clean);
  const next = [...rest, { id, name: clean, ...readerThemeSnapshot(c) }];
  return normalizeReaderThemes(next.slice(-SCHEME_LIMIT));
}
