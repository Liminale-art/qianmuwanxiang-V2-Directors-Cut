// 千幕 · 轻量便笺数据层
// 固定便笺写入 IndexedDB；未固定便笺只存在当前页面运行态，重开 ST 自动消失。

import * as blobStore from './qianmu-blobstore.js';

const temporaryNotes = new Map();

const text = (value, limit) => Array.from(String(value ?? '')).slice(0, limit).join('');
const number = (value, fallback, min, max) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(min, Math.min(max, parsed)) : fallback;
};

export function normalizeQianmuNote(input = {}) {
  const now = Date.now();
  const id = text(input.id || `note-${now}-${Math.random().toString(36).slice(2, 8)}`, 120);
  return {
    schemaVersion: 1,
    id,
    title: text(input.title, 120),
    body: text(input.body, 20000),
    pinned: Boolean(input.pinned),
    floating: Boolean(input.floating),
    minimized: Boolean(input.minimized),
    x: number(input.x, 24, 0, 100000),
    y: number(input.y, 96, 0, 100000),
    width: number(input.width, 280, 220, 520),
    height: number(input.height, 220, 120, 620),
    zOrder: number(input.zOrder, 1, 1, 1000000),
    createdAt: number(input.createdAt, now, 0, Number.MAX_SAFE_INTEGER),
    updatedAt: number(input.updatedAt, now, 0, Number.MAX_SAFE_INTEGER),
  };
}

export function createQianmuNote(input = {}) {
  return normalizeQianmuNote({ ...input, createdAt: Date.now(), updatedAt: Date.now() });
}

export async function listQianmuNotes({strict = false} = {}) {
  if (strict && !blobStore.blobStoreAvailable()) throw new Error('无法读取固定便笺库，未开始导入。');
  const persistent = strict ? await blobStore.listNotes({requireCommit:true})
    : blobStore.blobStoreAvailable() ? await blobStore.listNotes().catch(() => []) : [];
  const merged = new Map(persistent.map((note) => [note.id, normalizeQianmuNote({ ...note, pinned: true })]));
  for (const [id, note] of temporaryNotes) if (!merged.has(id)) merged.set(id, normalizeQianmuNote(note));
  return [...merged.values()].sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0));
}

export async function saveQianmuNote(input) {
  const note = normalizeQianmuNote({ ...input, updatedAt: Date.now() });
  if (note.pinned && blobStore.blobStoreAvailable()) {
    temporaryNotes.delete(note.id);
    await blobStore.putNote(note.id, note);
  } else {
    temporaryNotes.set(note.id, note);
    if (blobStore.blobStoreAvailable()) await blobStore.deleteNote(note.id).catch(() => {});
  }
  return note;
}

export async function saveImportedQianmuNote(input, {check}) {
  check();
  if (!blobStore.blobStoreAvailable()) throw new Error('固定便笺储存不可用，未保存为临时便笺。');
  const note = normalizeQianmuNote({...input, pinned:true, floating:false, updatedAt:Date.now()});
  if (temporaryNotes.has(note.id)) throw new Error('便笺 ID 已被占用，原内容保留，请重新导入。');
  await blobStore.addNote(note.id, note, {check});
  return note;
}

export async function deleteQianmuNote(noteId) {
  const id = String(noteId || '');
  temporaryNotes.delete(id);
  if (blobStore.blobStoreAvailable()) await blobStore.deleteNote(id).catch(() => {});
}

export function clearTemporaryQianmuNotes() {
  temporaryNotes.clear();
}

// Import data only. The caller owns activity admission, view updates and notices.
export async function importQianmuNotesBackup(file, {check, read, write, uid}) {
  if (Number(file.size) > 12 * 1024 * 1024) throw new Error('便笺备份文件超过 12 MB');
  const payload = JSON.parse(await file.text());
  check();
  if (payload?.type !== 'qianmu-notes' || Number(payload?.version) !== 1 || !Array.isArray(payload?.notes)) {
    throw new Error('不是有效的千幕固定便笺备份');
  }
  const incoming = payload.notes.slice(0, 1000);
  const occupiedIds = new Set((await read()).map((note) => note.id));
  check();
  let imported = 0;
  const failed = [];
  for (let index = 0; index < incoming.length; index++) {
    check();
    const raw = incoming[index];
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) { failed.push(`第 ${index + 1} 条格式无效`); continue; }
    let id = String(raw.id || '').trim().slice(0, 120);
    if (!id || occupiedIds.has(id)) id = uid('note-import');
    occupiedIds.add(id);
    try {
      await write(normalizeQianmuNote({ ...raw, id, pinned: true, floating: false }));
      imported++;
    } catch (error) {
      failed.push(`第 ${index + 1} 条：${error?.message || error}`);
    }
  }
  return {imported, failed};
}
