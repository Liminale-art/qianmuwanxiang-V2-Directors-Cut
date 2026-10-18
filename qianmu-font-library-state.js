import { validateFontRecord } from './qianmu-font-sources.js?v=1.59.472';

export const FONT_LIBRARY_SAMPLE = '一蝶振翅，万象入幕。';
const LEGACY_FONT_LIBRARY_SAMPLE = '风过长街，故事仍在继续。The quick brown fox 0123456789.';
const fail = message => { throw new Error(message); };
const plain = value => value && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const text = (value, max, label) => {
  if (typeof value !== 'string' || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) fail(`${label}无效或过长`);
  return value;
};
export function fontLibraryId(value) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,96}$/.test(value)) fail('字体标识无效');
  return value;
}
const names = (values, limit, label) => {
  if (!Array.isArray(values) || values.length > limit) fail(`${label}数量过多`);
  return [...new Set(values.map(value => text(value, 80, label).trim()).filter(Boolean))];
};
export const fontLibraryTags = values => names(values, 32, '标签');
const blankAssignment = () => ({ fontId: '', weight: '400', style: 'normal', enabled: false });
function supportedAssignment(assignment, faces) {
  const styleOf = face => String(face.style || 'normal').split(' ')[0];
  const style = faces.some(face => styleOf(face) === assignment.style) ? assignment.style : styleOf(faces[0]);
  const desired = assignment.weight === 'bold' ? 700 : assignment.weight === 'normal' ? 400 : Number(assignment.weight);
  const supported = faces.filter(face => styleOf(face) === style).map(face => {
    const [low, high = low] = String(face.weight || '400').split(' ').map(Number);
    return Math.max(low, Math.min(high, desired));
  });
  const weight = supported.reduce((best, value) => Math.abs(value - desired) < Math.abs(best - desired) ? value : best);
  return { ...assignment, style, weight: String(weight) };
}
export function fontAssignment(value = {}) {
  if (!plain(value)) fail('字体应用设置无效');
  const fontId = value.fontId ? fontLibraryId(value.fontId) : '';
  const weight = String(value.weight ?? '400'), style = String(value.style ?? 'normal');
  if (!/^(?:normal|bold|[1-9]\d{0,2}|1000)$/.test(weight) || !/^(?:normal|italic|oblique)$/.test(style)) fail('字重或字形无效');
  return { fontId, weight, style, enabled: Boolean(fontId && value.enabled !== false) };
}
export function normalizeFontLibrary(value) {
  if (value == null) return { version: 1, enabled: true, fonts: [], folders: [], pinnedIds: [], sortBy: 'name', sortOrder: 'asc', previewText: FONT_LIBRARY_SAMPLE, mode: 'separate', body: blankAssignment(), st: blankAssignment(), shared: blankAssignment() };
  if (!plain(value) || value.version !== 1 || !Array.isArray(value.fonts) || value.fonts.length > 200) fail('字体库格式无效，未覆盖原资料');
  if (JSON.stringify(value).length > 3 * 1024 * 1024) fail('字体库配置过大');
  if (value.enabled !== undefined && typeof value.enabled !== 'boolean') fail('字体启用设置无效');
  const seen = new Set();
  const fonts = value.fonts.map(font => {
    const id = fontLibraryId(font?.id);
    if (seen.has(id)) fail('字体库包含重复标识');
    seen.add(id);
    const record = validateFontRecord(font);
    if (record.source.kind === 'local' && record.faces.some(face => face.urls.length)) fail('本地字体原件不能存入扩展配置');
    return { ...record, id, folder: text(font.folder || '', 80, '文件夹').trim(), tags: names(font.tags || [], 32, '标签') };
  });
  const pinned = value.pinnedIds === undefined ? [] : value.pinnedIds;
  if (!Array.isArray(pinned) || pinned.length > 200) fail('字体置顶设置无效');
  const pinnedIds = Array.from(pinned, fontLibraryId);
  if (new Set(pinnedIds).size !== pinnedIds.length) fail('字体置顶设置包含重复条目');
  const sortBy = value.sortBy === undefined ? 'name' : value.sortBy, sortOrder = value.sortOrder === undefined ? 'asc' : value.sortOrder;
  if (!['name', 'added'].includes(sortBy) || !['asc', 'desc'].includes(sortOrder)) fail('字体排序设置无效');
  const result = {
    version: 1, enabled: value.enabled !== false, fonts, folders: names(value.folders || [], 200, '文件夹'),
    pinnedIds: pinnedIds.filter(id => seen.has(id)), sortBy, sortOrder,
    previewText: text(value.previewText == null || value.previewText === LEGACY_FONT_LIBRARY_SAMPLE ? FONT_LIBRARY_SAMPLE : value.previewText, 500, '预览文案'),
    mode: value.mode === 'shared' ? 'shared' : 'separate',
    body: fontAssignment(value.body), st: fontAssignment(value.st), shared: fontAssignment(value.shared),
  };
  for (const font of fonts) if (font.folder && !result.folders.includes(font.folder)) result.folders.push(font.folder);
  for (const key of ['body', 'st', 'shared']) if (!seen.has(result[key].fontId)) result[key] = blankAssignment();
  return result;
}
export function fontRecordSignature(font) {
  return JSON.stringify([font.source.kind, font.source.kind === 'local' ? font.id : font.faces]);
}
export function mergeFontLibraryRecords(state, records, makeId) {
  const next = normalizeFontLibrary(state), mapping = new Map();
  for (const source of records) {
    const record = validateFontRecord(source), sourceId = source.id || '';
    const existing = next.fonts.find(item => fontRecordSignature(item) === fontRecordSignature({ ...record, id: sourceId }));
    if (existing) { if (sourceId) mapping.set(sourceId, existing.id); continue; }
    let id = sourceId || makeId();
    if (next.fonts.some(item => item.id === id)) id = makeId();
    next.fonts.push({ ...record, id: fontLibraryId(id), folder: source.folder || '', tags: source.tags || [] });
    if (sourceId) mapping.set(sourceId, id);
  }
  return { state: normalizeFontLibrary(next), mapping };
}
export function updateFontLibrary(state, type, payload = {}) {
  const next = normalizeFontLibrary(state);
  if (type === 'set-enabled') {
    if (typeof payload.enabled !== 'boolean') fail('字体启用设置无效');
    next.enabled = payload.enabled;
  } else if (type === 'set-font-pinned') {
    const id = fontLibraryId(payload.id);
    if (typeof payload.pinned !== 'boolean') fail('字体置顶设置无效');
    if (!next.fonts.some(font => font.id === id)) fail('字体已不在库中');
    if (!payload.pinned) next.pinnedIds = next.pinnedIds.filter(item => item !== id);
    else if (!next.pinnedIds.includes(id)) next.pinnedIds.push(id);
  } else if (type === 'set-sort-order') {
    const by = payload.by === undefined ? next.sortBy : payload.by;
    if (!['name', 'added'].includes(by) || !['asc', 'desc'].includes(payload.order)) fail('字体排序设置无效');
    next.sortBy = by; next.sortOrder = payload.order;
  } else if (type === 'set-mode') {
    if (!['separate', 'shared'].includes(payload.mode)) fail('字体应用方式无效');
    next.mode = payload.mode;
  } else if (type === 'replace-web') {
    const id = fontLibraryId(payload.id), index = next.fonts.findIndex(font => font.id === id);
    if (index < 0 || next.fonts[index].source.kind !== 'web') fail('原网络字体已变化，请重新打开编辑');
    const record = validateFontRecord(payload.record);
    if (record.source.kind !== 'web') fail('只能替换网络字体来源');
    const previous = next.fonts[index];
    next.fonts[index] = { ...record, id, folder: previous.folder, tags: payload.tags === undefined ? previous.tags : fontLibraryTags(payload.tags) };
    if (JSON.stringify(previous.faces) !== JSON.stringify(record.faces)) {
      for (const target of ['body', 'st', 'shared']) if (next[target].fontId === id) next[target] = supportedAssignment(next[target], record.faces);
    }
  } else if (type === 'apply-font') {
    if (!['body', 'st', 'shared'].includes(payload.target)) fail('字体目标无效');
    const assignment = fontAssignment({ ...payload, enabled: true });
    if (!assignment.fontId || !next.fonts.some(font => font.id === assignment.fontId)) fail('字体已不在库中');
    next[payload.target] = assignment;
    next.mode = payload.target === 'shared' ? 'shared' : 'separate';
  } else if (type === 'restore-font') {
    if (!['body', 'st', 'shared'].includes(payload.target)) fail('字体目标无效');
    const id = fontLibraryId(payload.fontId);
    // A stale dropdown must not clear a newer choice or a dormant preference.
    const effective = next.mode === 'shared' ? payload.target === 'shared' : payload.target !== 'shared';
    if (effective && next[payload.target].enabled && next[payload.target].fontId === id) {
      if (payload.target === 'shared') next.mode = 'separate';
      else next[payload.target] = blankAssignment();
    }
  } else if (type === 'set-assignment') {
    if (!['body', 'st', 'shared'].includes(payload.target)) fail('字体目标无效');
    next[payload.target] = fontAssignment(payload);
    if (next[payload.target].fontId && !next.fonts.some(font => font.id === next[payload.target].fontId)) fail('字体已不在库中');
  } else if (type === 'set-preview') next.previewText = text(payload.text, 500, '预览文案');
  else if (type === 'add-folder') {
    const folder = text(payload.name, 80, '文件夹').trim();
    if (folder && !next.folders.includes(folder)) next.folders.push(folder);
  } else if (type === 'delete-folder') {
    const folder = text(payload.name, 80, '文件夹');
    next.folders = next.folders.filter(name => name !== folder);
    for (const font of next.fonts) if (font.folder === folder) font.folder = '';
  } else if (type === 'update-fonts' || type === 'delete-fonts') {
    const ids = new Set((payload.ids || []).map(fontLibraryId));
    if (type === 'delete-fonts') next.fonts = next.fonts.filter(font => !ids.has(font.id));
    else for (const font of next.fonts) if (ids.has(font.id)) {
      if (payload.folder !== undefined) font.folder = text(payload.folder, 80, '文件夹').trim();
      if (payload.tags !== undefined) font.tags = names(payload.tags, 32, '标签');
      if (payload.name !== undefined) font.name = text(payload.name, 160, '字体名称').trim() || font.name;
    }
  } else fail('未知字体库操作');
  return normalizeFontLibrary(next);
}
