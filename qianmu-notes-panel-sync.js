// Optional account sync controls for the existing non-modal notes portal.
// No prose is injected into HTML and refresh never replaces the active editor.
import { qianmuNotesState, syncQianmuNotes, listLegacyQianmuNotes, adoptLegacyQianmuNotes } from './qianmu-notes.js';

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

export function createNotesPanelSync({ getRoot, refresh, retryLocal, hasUnsaved = () => false, confirm, download, notify, document = globalThis.document, window = globalThis.window } = {}) {
  let timer, refreshing, active = false, disposed = false, localFailure = '', writes = 0, legacy = [], legacyRead = false;
  function paint() {
    const root = getRoot(); if (!root) return;
    let bar = root.querySelector('.sd-notes-sync');
    if (!bar) {
      bar = document.createElement('div'); bar.className = 'sd-notes-sync';
      const status = document.createElement('span'); status.className = 'sd-notes-sync-status'; status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
      const retry = document.createElement('button'); retry.type = 'button'; retry.className = 'sd-note-sync-retry'; retry.textContent = '同步'; retry.onclick = () => void sync({ quiet: false });
      const old = document.createElement('button'); old.type = 'button'; old.className = 'sd-note-legacy'; old.textContent = '旧便笺'; old.onclick = () => void showLegacy();
      bar.append(status, retry, old); root.querySelector('.sd-notes-panel > header')?.after(bar);
    }
    const state = qianmuNotesState();
    const failure = localFailure || (!writes && hasUnsaved() ? '请重试保存，或先复制保留编辑区的内容。' : '');
    const message = failure ? `本机保存未完成：${failure}` : writes ? '正在保存到本机…'
      : state.state === 'synced' ? '已同步' : state.state === 'syncing' ? '本机已保存 · 正在同步…'
        : state.error ? `本机内容保留 · ${state.error}` : state.pending ? `本机已保存 · ${state.pending} 条待同步` : state.namespace ? '本机内容已保留 · 尚未同步' : '正在确认账户…';
    bar.querySelector('.sd-notes-sync-status').textContent = message;
    bar.title = state.conflicts ? `发现 ${state.conflicts} 条冲突，两个版本均已保留，请核对带有冲突标记的便笺。` : message;
    bar.dataset.state = failure || state.error ? 'error' : state.state;
    bar.querySelector('.sd-note-sync-retry').disabled = Boolean(refreshing || writes);
    const old = bar.querySelector('.sd-note-legacy'); old.hidden = !legacy.length; old.textContent = `旧便笺 (${legacy.length})`;
  }
  async function sync({ quiet = true } = {}) {
    if (disposed || refreshing || writes) return refreshing;
    refreshing = (async () => {
      try { if (!quiet && (localFailure || hasUnsaved())) await retryLocal?.(); await syncQianmuNotes(); if (!disposed) await refresh(); }
      catch (error) { if (!disposed) { paint(); if (!quiet) notify?.(error.message || '便笺暂未同步，本机内容保留。', 'warning'); } }
      finally { refreshing = null; if (!disposed) paint(); }
    })();
    paint(); return refreshing;
  }
  async function inspectLegacy() {
    if (legacyRead || disposed) return;
    try { legacy = await listLegacyQianmuNotes(); legacyRead = true; paint(); }
    catch (error) { notify?.(`旧便笺读取失败，原库未改动：${error.message}`, 'warning'); }
  }
  async function showLegacy() {
    const root = getRoot(); if (!root || !legacy.length || root.querySelector('.sd-note-legacy-review')) return;
    const namespace = qianmuNotesState().namespace;
    const panel = document.createElement('section'); panel.className = 'sd-note-legacy-review'; panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-label', '旧设备便笺');
    const text = document.createElement('p'); text.textContent = '这些旧便笺尚未归属账户，仅存于本浏览器。可以先查看或导出；确认归入当前账户后才会跨端同步，旧库原件仍保留。';
    const select = document.createElement('select'); select.setAttribute('aria-label', '选择旧便笺');
    legacy.forEach((note, i) => { const option = document.createElement('option'); option.value = String(i); option.textContent = `${i + 1} · ${String(note.title || note.body || '空便笺').slice(0, 40)}`; select.append(option); });
    const body = document.createElement('textarea'); body.readOnly = true; body.setAttribute('aria-label', '旧便笺原文');
    const show = () => { body.value = String(legacy[Number(select.value)]?.body || ''); }; select.onchange = show; show();
    const actions = document.createElement('div');
    const button = (label, handler) => { const node = document.createElement('button'); node.type = 'button'; node.textContent = label; node.onclick = handler; actions.append(node); return node; };
    button('导出原件', () => download(new Blob([JSON.stringify({ type: 'qianmu-notes', version: 1, notes: legacy, exportedAt: new Date().toISOString() })], { type: 'application/json' }), 'qianmu-legacy-notes.json'));
    const adopt = button('归入当前账户', async () => {
      adopt.disabled = true;
      try {
        if (!namespace) throw new Error('请先确认当前 ST 账户。');
        const accountLabel = (namespace.startsWith('st-user:') ? namespace.slice(8) : namespace).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
        if (!await confirm('确认旧便笺归属', `将本浏览器的 ${legacy.length} 条旧便笺归入 ST 账户「${accountLabel}」，此账户的其他设备将能读取。相同编号不会覆盖已有内容，旧库原件不删除。是否继续？`)) return;
        if (!panel.isConnected || disposed || namespace !== qianmuNotesState().namespace) throw new Error('便笺账户或页面已变化，未迁移。');
        await adoptLegacyQianmuNotes({ confirmed: true, namespace });
        if (disposed) return;
        notify?.('旧便笺已保存在当前账户的本机队列中；原件保留，同步完成后可跨端读取。', 'success');
        panel.remove(); await refresh(); void sync();
      } catch (error) { notify?.(error.message || '旧便笺未迁移，原件保留。', 'warning'); }
      finally { if (adopt.isConnected) adopt.disabled = false; }
    });
    button('关闭', () => { panel.remove(); getRoot()?.querySelector('.sd-note-legacy')?.focus(); });
    panel.append(text, select, body, actions); root.querySelector('.sd-notes-panel')?.append(panel); select.focus();
  }
  const wake = () => { if (active && !document.hidden) void sync(); };
  return Object.freeze({
    mount() { if (disposed) return; active = true; paint(); void inspectLegacy(); if (!timer) { timer = setInterval(wake, 20000); window.addEventListener('online', wake); window.addEventListener('focus', wake); document.addEventListener('visibilitychange', wake); } },
    hide() { active = false; clearInterval(timer); timer = null; window.removeEventListener('online', wake); window.removeEventListener('focus', wake); document.removeEventListener('visibilitychange', wake); },
    changed(event) { if (disposed) return; paint(); if (event?.reason === 'conflict') notify?.('这条便笺在另一处也有修改，两个版本均已保留，请核对冲突副本。', 'warning'); },
    beginWrite() { writes++; paint(); },
    endWrite(error) { writes = Math.max(0, writes - 1); localFailure = error ? String(error.message || error) : ''; paint(); },
    fail(error) { localFailure = String(error.message || error); paint(); },
    sync, paint,
    dispose() { this.hide(); disposed = true; },
  });
}
