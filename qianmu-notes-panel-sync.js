// Optional account sync controls for the existing non-modal notes portal.
// No prose is injected into HTML and refresh never replaces the active editor.
import { qianmuNotesState, syncQianmuNotes } from './qianmu-notes.js?v=1.59.419';

const REFRESH_FIELDS = ['localRevision', 'revision', 'body', 'title', 'pinned', 'updatedAt', '_notesAccount'];
export function captureNotesRefresh(notes) {
  return new Map(notes.map(note => [note.id, { ...note }]));
}

// A read may finish after an edit, creation or deletion has already committed.
// Merge unrelated incoming changes, but never roll back that local work.
export function mergeNotesRefresh(current, incoming, baseline, keep = new Set()) {
  const currentById = new Map(current.map(note => [note.id, note]));
  const changed = note => !baseline.has(note.id) || REFRESH_FIELDS.some(key => note[key] !== baseline.get(note.id)[key]);
  const merged = new Map();
  for (const fresh of incoming) {
    const local = currentById.get(fresh.id);
    if (!local && baseline.has(fresh.id)) continue;
    if (local && (keep.has(local.id) || changed(local) || Number(local.localRevision || 0) > Number(fresh.localRevision || 0))) merged.set(local.id, local);
    else merged.set(fresh.id, Object.assign(local || {}, fresh));
  }
  for (const local of current) {
    if (!merged.has(local.id) && (keep.has(local.id) || changed(local))) merged.set(local.id, local);
  }
  return [...merged.values()];
}

export function createNotesPanelSync({ getRoot, refresh, retryLocal, hasUnsaved = () => false, notify, document = globalThis.document, window = globalThis.window } = {}) {
  let timer, refreshing, active = false, disposed = false, localFailure = '', lastNotice = '', writes = 0;
  function paint() {
    const root = getRoot(); if (!root) return;
    const state = qianmuNotesState();
    const failure = localFailure || (!writes && hasUnsaved() ? '请重试保存，或先复制保留编辑区的内容。' : '');
    const message = failure ? `保存未完成：${failure}` : state.error ? '暂未保存到 ST，连接恢复后会自动重试'
      : '';
    // Normal saves stay quiet; a failed save is never silently hidden with the status strip.
    if (message && message !== lastNotice) notify?.(message, 'warning');
    lastNotice = message;
  }
  async function sync({ quiet = true } = {}) {
    if (disposed || refreshing || writes) return refreshing;
    refreshing = (async () => {
      try { if (localFailure || hasUnsaved()) await retryLocal?.(); await syncQianmuNotes(); if (!disposed) await refresh(); }
      catch (error) { if (!disposed) { paint(); if (!quiet) notify?.(error.message || '便笺暂未同步，本机内容保留。', 'warning'); } }
      finally { refreshing = null; if (!disposed) paint(); }
    })();
    paint(); return refreshing;
  }
  const wake = () => { if (active && !document.hidden) void sync(); };
  return Object.freeze({
    mount() { if (disposed) return; active = true; paint(); if (!timer) { timer = setInterval(wake, 20000); window.addEventListener('online', wake); window.addEventListener('focus', wake); document.addEventListener('visibilitychange', wake); } },
    hide() { active = false; clearInterval(timer); timer = null; window.removeEventListener('online', wake); window.removeEventListener('focus', wake); document.removeEventListener('visibilitychange', wake); },
    changed(event) { if (disposed) return; paint(); if (event?.reason === 'conflict') notify?.('这条便笺在另一处也有修改，两个版本均已保留，请核对冲突副本。', 'warning'); },
    beginWrite() { writes++; paint(); },
    endWrite(error) { writes = Math.max(0, writes - 1); localFailure = error ? String(error.message || error) : ''; paint(); },
    fail(error) { localFailure = String(error.message || error); paint(); },
    sync, paint,
    dispose() { this.hide(); disposed = true; },
  });
}
