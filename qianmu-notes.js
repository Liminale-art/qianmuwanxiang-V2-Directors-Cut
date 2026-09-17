// 千幕 · 轻量便笺数据层
// All notes are durable. Pinning controls prominence, never whether prose survives.
// The account-scoped sync store is separate from the legacy, unowned notes store.

import * as blobStore from './qianmu-blobstore.js';
import {readLibraryBackupFile,confirmLibraryRestore,NOTE_TEXT_LIMITS} from './qianmu-library-backup.js';
import {notesSyncOperationId} from './qianmu-notes-sync-contract.js';

let configuration = null, session = null, opening = null, closing = null, epoch = 0, syncTimer = null;
const localWrites = new Set();
const changed = () => new Error('便笺账户或会话已变化，原内容保留，请重新打开便笺。');

export function configureQianmuNotes(options) {
  configuration = options;
}

export function qianmuNotesState() {
  return { namespace: session?.namespace || '', ...(session?.runtime.status || { state: 'local-only', pending: 0, error: '', conflicts: 0 }) };
}

async function notesSession(expectedNamespace, admittedEpoch) {
  // A write admitted before close must finish the opening/session chain that
  // close is draining. New callers still wait outside that drain boundary.
  if (closing && admittedEpoch === undefined) await closing;
  if (admittedEpoch !== undefined && admittedEpoch !== epoch) throw changed();
  if (!configuration) throw new Error('便笺账户尚未就绪，请重新打开。');
  const token = epoch, namespace = await configuration.resolveNamespace();
  if (token !== epoch || expectedNamespace && expectedNamespace !== namespace) throw changed();
  if (session?.namespace === namespace) return session;
  if (opening) { await opening; return notesSession(expectedNamespace, admittedEpoch); }
  opening = (async () => {
    if (session) { await session.runtime.close(); session = null; configuration.onChange?.({ reason: 'account' }); }
    const { createNotesSyncRuntime } = configuration.createRuntime ? { createNotesSyncRuntime: configuration.createRuntime } : await import('./qianmu-notes-sync-runtime.js');
    const guard = async () => {
      if (token !== epoch || namespace !== await configuration.resolveNamespace() || token !== epoch) throw changed();
    };
    await guard();
    const client = configuration.createRuntime ? null : (await import('./qianmu-notes-sync-client.js')).createNotesSyncClient({ namespace, headers: configuration.headers, guard });
    await guard();
    const runtime = createNotesSyncRuntime({ namespace, client, guard,
      onChange: event => { if (token === epoch && session?.namespace === namespace) configuration.onChange?.(event); } });
    if (token !== epoch) { await runtime.close(); throw changed(); }
    session = { namespace, runtime, guard };
    return session;
  })();
  try { return await opening; } finally { opening = null; }
}

function withOwner(note, namespace) { return { ...note, _notesAccount: namespace }; }
function queueSync() {
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => { syncTimer = null; void syncQianmuNotes().catch(() => {}); }, 650);
}
async function localWrite(action) {
  const operation = action(); localWrites.add(operation);
  try { return await operation; } finally { localWrites.delete(operation); }
}

export async function syncQianmuNotes() {
  const current = await notesSession();
  await current.runtime.sync(); await current.guard();
  return qianmuNotesState();
}

// Legacy data has no account evidence. Inspection/export is local; adoption is explicit.
export async function listLegacyQianmuNotes() {
  if (!blobStore.blobStoreAvailable()) return [];
  return blobStore.listNotes({ requireCommit: true });
}
export async function adoptLegacyQianmuNotes({ confirmed = false, namespace } = {}) {
  if (confirmed !== true || !namespace) throw new Error('请先确认旧便笺所属的 ST 账户。');
  if (!globalThis.crypto?.subtle?.digest) throw new Error('旧便笺归属核验需要 HTTPS 或本机 localhost；原件仍可查看和导出，未迁移。');
  const current = await notesSession(namespace), notes = await listLegacyQianmuNotes();
  const content = notes.map(({ id, title, body, pinned, createdAt, updatedAt }) => ({ id, title, body, pinned, createdAt, updatedAt })).sort((a, b) => String(a.id).localeCompare(String(b.id)));
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(content)));
  const receipt = Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('');
  await current.guard();
  const result = await localWrite(() => current.runtime.importLegacy(notes, { confirmed: true, receipt }));
  queueSync(); return result;
}

const text = (value, limit) => Array.from(String(value ?? '')).slice(0, limit).join('');
const number = (value, fallback, min, max) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(min, Math.min(max, parsed)) : fallback;
};

export function normalizeQianmuNote(input = {}) {
  const now = Date.now();
  const id = text(input.id || `note-${now}-${Math.random().toString(36).slice(2, 8)}`, NOTE_TEXT_LIMITS.id);
  return {
    schemaVersion: 1,
    id,
    title: text(input.title, NOTE_TEXT_LIMITS.title),
    body: text(input.body, NOTE_TEXT_LIMITS.body),
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

export async function listQianmuNotes() {
  const current = await notesSession(), notes = await current.runtime.list();
  await current.guard();
  return notes.map(note => withOwner(note, current.namespace)).sort((a, b) => Number(b.pinned) - Number(a.pinned) || Number(b.updatedAt || 0) - Number(a.updatedAt || 0));
}

export async function getQianmuNotesStorage() {
  const current = await notesSession(), summary = await current.runtime.summary();
  await current.guard();
  return summary;
}

export async function saveQianmuNote(input, { namespace = input?._notesAccount } = {}) {
  if (closing) throw changed();
  const admittedEpoch = epoch;
  const { _notesAccount, ...note } = input;
  return localWrite(async () => {
    const current = await notesSession(namespace, admittedEpoch);
    const saved = await current.runtime.save(note);
    await current.guard(); queueSync();
    return withOwner(saved, current.namespace);
  });
}

export async function saveImportedQianmuNote(input, {check}) {
  check();
  const current = await notesSession(); check();
  // Imports always receive fresh IDs; a concurrent tab cannot turn an import into an overwrite.
  const note = normalizeQianmuNote({ ...input, id: `note-import-${notesSyncOperationId()}`, floating: false, updatedAt: Date.now() });
  const saved = await localWrite(() => current.runtime.save(note));
  queueSync();
  return withOwner(saved, current.namespace);
}

export async function deleteQianmuNote(noteId, { namespace, localRevision } = {}) {
  const current = await notesSession(namespace);
  await localWrite(() => current.runtime.remove(String(noteId || ''), { localRevision }));
  await current.guard(); queueSync();
}

export async function clearTemporaryQianmuNotes() {
  if (closing) return closing;
  clearTimeout(syncTimer); syncTimer = null;
  closing = (async () => {
    await Promise.allSettled([...localWrites]);
    epoch++; clearTimeout(syncTimer); syncTimer = null;
    const previous = session; session = null;
    await previous?.runtime.close();
  })();
  try { await closing; } finally { closing = null; }
}

// Import data only. The caller owns activity admission, view updates and notices.
export async function importQianmuNotesBackup(file, {check, confirm, read, write, uid, progress = {imported:0, failed:[]}}) {
  const payload = await readLibraryBackupFile(file,'qianmu-notes',{check});
  if(!await confirmLibraryRestore(payload,{confirm,check}))return {...progress,cancelled:true};
  const incoming = payload.notes;
  const occupiedIds = new Set((await read()).map((note) => note.id));
  check();
  const failed = progress.failed;
  for (let index = 0; index < incoming.length; index++) {
    check();
    const raw = incoming[index];
    let id = raw.id || '';
    if (!id || occupiedIds.has(id)) id = uid('note-import');
    occupiedIds.add(id);
    try {
      await write(normalizeQianmuNote({ ...raw, id, pinned: Boolean(raw.pinned), floating: false }));
      progress.imported++;
    } catch (error) {
      failed.push(`第 ${index + 1} 条：${error?.message || error}`);
    }
  }
  return progress;
}
