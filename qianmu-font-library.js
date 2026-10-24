import { normalizeFontLibrary, mergeFontLibraryRecords, updateFontLibrary, fontLibraryTags } from './qianmu-font-library-state.js?v=1.59.475';
import { FONT_SOURCE_LIMITS, resolveWebFontSource, createLocalFontRecord, validateFontRecord, exportFontPack, importFontPack } from './qianmu-font-sources.js?v=1.59.475';
import { createFontLibraryView } from './qianmu-font-library-view.js?v=1.59.482-font-ui-1';
import { createFontRuntime } from './qianmu-font-runtime.js?v=1.59.476';
import { createFontLocalStore } from './qianmu-font-local-store.js';
import { createFontAccountSync } from './qianmu-font-account-sync.js';
import { readBuiltinFont } from './qianmu-font-builtins.js';

function fontInputName(value) {
  if (value === undefined) return '';
  if (typeof value !== 'string' || value.length > 160 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) throw new Error('字体名称无效或过长');
  return value.trim();
}

// Original input is display/edit data only. Legacy inline records do not retain
// their origin: leave the field empty rather than guessing a URL or expanding
// hundreds of already-validated font fragments back into the editor.
function editableWebSource(font) {
  if (font.source.kind !== 'web') return '';
  if (font.source.url) return font.source.url;
  return font.source.input && font.source.input !== '内嵌字体样式' ? font.source.input : '';
}

// The local ST settings and IndexedDB store remain the source of truth for this
// device. A separate account catalog mirrors directory metadata and choices
// when the deployment exposes ST account storage; font binaries stay local and
// are carried only by an explicit font-package export. Deployments without
// account storage remain fully local without a user-facing sync switch.
export function createFontLibrary({ getOwner, save, resolveNamespace, isCurrent, document = globalThis.document,
  notify = () => {}, download, confirm = async () => false, beforeApply, afterApply, closePanel, getPreviewFontSize = () => 18,
  localStoreFactory = createFontLocalStore, runtimeFactory = createFontRuntime, viewFactory = createFontLibraryView,
  webResolver = resolveWebFontSource, localReader = createLocalFontRecord, accountSyncFactory = createFontAccountSync,
  builtinReader = readBuiltinFont } = {}) {
  let owner = null, namespace = '', store = null, runtime = null, accountSync = null, view = null, portal = null, container = null;
  let accountSyncHydrated = false;
  let generation = 0, lifecycle = 0, operation = 0, disposed = false, busy = false, previewIds = [], previewChoices = {}, attached = null, removeEntry = null, webAbort = null, viewSession = null, viewIdentity = null, applicationNotice = null;
  let accountPushTail = Promise.resolve(), accountPushTimer = null, accountPushRevision = 0, accountHydration = null;
  const ACCOUNT_PUSH_DEBOUNCE_MS = 120;
  const statuses = new Map();
  const makeId = () => `f_${globalThis.crypto.randomUUID().replaceAll('-', '')}`;
  const localId = async bytes => 'local_' + Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), b => b.toString(16).padStart(2, '0')).join('');
  const exportChunkBytes = 4 * 1024 * 1024;
  async function readBlobForExport(blob, guard) {
    if (!blob || !Number.isSafeInteger(blob.size) || blob.size < 1) throw new Error('字体原件无法读取，未导出不完整备份');
    let bytes;
    try { bytes = new Uint8Array(blob.size); } catch (_) { throw new Error('字体原件过大，无法稳定导出；请分批导出'); }
    if (typeof blob.slice !== 'function') {
      const value = await blob.arrayBuffer(); guard();
      if (value.byteLength !== blob.size) throw new Error('字体原件读取不完整，未导出不完整备份');
      bytes.set(new Uint8Array(value)); return bytes;
    }
    for (let offset = 0; offset < blob.size; offset += exportChunkBytes) {
      guard();
      const chunk = new Uint8Array(await blob.slice(offset, Math.min(blob.size, offset + exportChunkBytes)).arrayBuffer());
      if (!chunk.length || offset + chunk.length > blob.size) throw new Error('字体原件读取不完整，未导出不完整备份');
      bytes.set(chunk, offset);
      // Let the panel paint and process cancellation between large files/chunks.
      if (offset + chunk.length < blob.size) await new Promise(resolve => setTimeout(resolve, 0));
    }
    guard();
    return bytes;
  }
  const read = () => normalizeFontLibrary(getOwner()?.fontLibrary);
  const current = token => !disposed && token === generation && isCurrent() && getOwner() === owner;
  const assertCurrent = token => { if (!current(token)) throw new Error('字体库所属设置已变化，请重新打开'); };
  function status(id, value) {
    statuses.set(id, value);
    view?.setFontStatus(id, value.status === 'error' ? value.message || '字体暂不可用' : value.status === 'loading' ? '加载中…' : '');
  }
  function release() {
    if (accountPushTimer) { clearTimeout(accountPushTimer); accountPushTimer = null; }
    accountPushRevision++; accountPushTail = Promise.resolve(); accountHydration = null;
    webAbort?.abort(); webAbort = null;
    generation++; runtime?.dispose(); store?.dispose(); accountSync?.close?.(); runtime = null; store = null; accountSync = null; accountSyncHydrated = false; namespace = ''; owner = null; viewSession = null; applicationNotice = null; statuses.clear();
  }
  async function ensure() {
    const candidate = getOwner(), epoch = lifecycle;
    if (disposed || !candidate || !isCurrent()) throw new Error('字体库暂不可用');
    let resolved;
    try { resolved = await resolveNamespace(); }
    catch { throw new Error('暂未确认当前 ST 账户，请稍后再打开字体库'); }
    if (disposed || epoch !== lifecycle || !isCurrent() || getOwner() !== candidate) throw new Error('设置来源已变化');
    if (owner !== candidate || namespace !== resolved || !runtime) {
      close(false); release(); owner = candidate; namespace = resolved;
      store = localStoreFactory({ namespace });
      try { accountSync = accountSyncFactory?.({}); } catch { accountSync = null; }
      runtime = runtimeFactory({ document, readLocal: id => store.get(id), readBuiltin: builtinReader, accountKey: namespace, onStatus: status, beforeApply, afterApply });
      if (accountSync && !accountSyncHydrated) {
        // Opening the panel must not wait for the account-file round trip. The
        // local IndexedDB catalog is immediately usable; a later successful
        // hydration merges remote metadata and refreshes the already-open UI.
        accountSyncHydrated = true;
        const syncRef = accountSync, token = generation, initialSettings = candidate.fontLibrary, local = normalizeFontLibrary(initialSettings), localStore = store;
        let task;
        task = Promise.resolve().then(() => syncRef.hydrate(local, { localStore })).then(hydrated => {
          // Do not let a late remote read overwrite a local edit made while
          // hydration was in flight. That edit is the next queued push's
          // source of truth; the user should never see it disappear.
          if (!current(token) || accountSync !== syncRef || owner !== candidate || candidate.fontLibrary !== initialSettings) return hydrated;
          if (hydrated?.state && JSON.stringify(hydrated.state) !== JSON.stringify(read())) {
            candidate.fontLibrary = normalizeFontLibrary(hydrated.state);
            try { save(candidate); } catch (_) { return hydrated; }
            updateEntry(); view?.render?.();
          }
          return hydrated;
        }).then(hydrated => {
          if (hydrated?.changed && current(token) && accountSync === syncRef) void sync().catch(() => {});
          return hydrated;
        }).catch(() => {}).finally(() => { if (accountHydration === task) accountHydration = null; });
        accountHydration = task;
      }
    }
    return generation;
  }
  function updateEntry() {
    if (!attached?.isConnected) return;
    const node = attached.querySelector('[data-font-library-summary]');
    if (!node) return;
    try {
      const state = read(), name = target => state[target].enabled ? state.fonts.find(font => font.id === state[target].fontId)?.name || '原生字体' : '原生字体';
      node.textContent = !state.enabled ? '当前：字体未启用' : state.mode === 'shared' ? `当前：全部 · ${name('shared')}` : `当前：正文 · ${name('body')} / 界面 · ${name('st')}`;
    } catch { node.textContent = '当前：配置待检查'; }
    node.title = node.textContent;
  }
  async function sync() {
    if (disposed) return;
    // Do not resolve identity or open IndexedDB for users who never use fonts.
    if (!getOwner()?.fontLibrary && !runtime) return;
    const token = await ensure(); assertCurrent(token);
    const notice = applicationNotice;
    await runtime.sync({ ...read(), previewChoices }, previewIds, { onApplied: () => completeApplicationNotice(notice) }); assertCurrent(token); updateEntry();
  }
  function completeApplicationNotice(notice) {
    if (!notice || applicationNotice !== notice) return;
    applicationNotice = null;
    if (!current(notice.token) || operation !== notice.operation || owner.fontLibrary !== notice.settings || (notice.viewIdentity && viewIdentity !== notice.viewIdentity)) return;
    if (!notice.scopes.every(scope => runtime?.isApplied?.(scope, notice.font, notice.selection))) { try { notify('字体应用未完成，请检查来源或字重', 'warning'); } catch (_) {} return; }
    try { notify(`字体已应用于${notice.label}`, 'success'); } catch (_) {}
  }
  function commit(next, token) {
    assertCurrent(token);
    const target = owner, previous = target.fontLibrary, staged = normalizeFontLibrary(next);
    target.fontLibrary = staged;
    try { save(target); } catch (error) { if (target.fontLibrary === staged) target.fontLibrary = previous; throw error; }
    updateEntry();
  }
  function scheduleAccountPush(token) {
    if (!accountSync || !current(token)) return;
    const revision = ++accountPushRevision;
    if (accountPushTimer) clearTimeout(accountPushTimer);
    accountPushTimer = setTimeout(() => {
      accountPushTimer = null;
      accountPushTail = accountPushTail.catch(() => {}).then(async () => {
        if (!accountSync || !current(token) || revision !== accountPushRevision) return;
        try {
          // Account-directory reconciliation is deliberately silent. Font
          // binaries never leave this browser, so a toast here would suggest
          // a cross-device file transfer that did not happen.
          await accountSync.push(read(), { localStore: store });
        } catch (_) { /* Local IndexedDB remains authoritative; retry on a later edit/open. */ }
      });
      void accountPushTail.catch(() => {});
    }, ACCOUNT_PUSH_DEBOUNCE_MS);
  }
  function uiState() {
    const state = read(), requestedSize = Number(getPreviewFontSize());
    const defaultPreviewSize = Number.isFinite(requestedSize) && requestedSize >= 1 && requestedSize <= 200 ? requestedSize : 18;
    return { ...state, defaultPreviewSize, entries: state.fonts.map(font => ({ ...font, sourceType: font.source.kind, editableSource: editableWebSource(font), editableSourceMissing: font.source.kind === 'web' && !editableWebSource(font), variantKnown: font.source.variantKnown,
      weights: [...new Set(font.faces.map(face => face.weight || '400'))],
      styles: [...new Set(font.faces.map(face => face.style || 'normal'))], status: statuses.get(font.id)?.status === 'error' ? statuses.get(font.id).message : '' })) };
  }
  async function visible(ids, choices = previewChoices, identity = viewIdentity) {
    if (identity !== viewIdentity) return;
    previewIds = ids; previewChoices = choices;
    try { await sync(); } catch (error) { if (identity === viewIdentity) view?.setStatus(error.message, { error: true }); }
  }
  async function action(type, payload = {}, originView = null) {
    if (disposed) throw new Error('字体库已关闭，请重新打开');
    if (originView && originView !== viewIdentity) throw new Error('字体库已关闭，请重新打开');
    // Accept both action-object and positional view callbacks.
    if (typeof type === 'object') { payload = type.payload || type; type = type.type; }
    if (type === 'set-preview' && owner && current(generation)) {
      commit(updateFontLibrary(read(), type, payload), generation);
      scheduleAccountPush(generation);
      void visible(previewIds); return;
    }
    if (busy) throw new Error('上一项字体操作尚未完成');
    busy = true; applicationNotice = null; const operationToken = ++operation;
    try {
      const token = await ensure(), original = owner.fontLibrary;
      const guard = () => { assertCurrent(token); if (owner.fontLibrary !== original) throw new Error('字体库已变化，未覆盖新的选择'); };
      let next, revealFontId = '', editedFontId = '';
      if (type === 'add-web' || type === 'edit-web') {
        const tags = payload.tags === undefined ? undefined : fontLibraryTags(payload.tags);
        const name = fontInputName(payload.name);
        const originalFont = type === 'edit-web' ? read().fonts.find(font => font.id === payload.id) : null;
        if (type === 'edit-web' && originalFont?.source.kind !== 'web') throw new Error('原网络字体已变化，请重新打开编辑');
        webAbort = new AbortController();
        const aborter = webAbort;
        let records;
        try {
          const editable = originalFont && editableWebSource(originalFont);
          records = originalFont && (payload.source === editable || (!editable && typeof payload.source === 'string' && !payload.source.trim()))
            ? [{ ...originalFont, name: name || originalFont.name }]
            : await webResolver(payload.source, { name, baseUrl: document.baseURI, signal: aborter.signal });
        }
        finally { if (webAbort === aborter) webAbort = null; }
        guard();
        if (originalFont) {
          if (records.length !== 1) throw new Error('链接包含多个字体，请改用单一字体来源');
          next = updateFontLibrary(read(), 'replace-web', { id: originalFont.id, record: records[0], tags });
          if (JSON.stringify(originalFont.faces) !== JSON.stringify(next.fonts.find(font => font.id === originalFont.id).faces)) {
            const replacement = next.fonts.find(font => font.id === originalFont.id);
            const effective = next.mode === 'shared' ? ['shared'] : ['body', 'st'];
            const target = effective.find(key => next[key].enabled && next[key].fontId === originalFont.id);
            await runtime.verifyWebFont(replacement, target ? next[target] : replacement.faces[0], next.previewText);
            guard();
          }
          editedFontId = originalFont.id;
        } else {
          next = mergeFontLibraryRecords(read(), records.map(record => ({ ...record, ...(tags === undefined ? {} : { tags }) })), makeId).state;
          revealFontId = next.fonts.find(font => !read().fonts.some(previous => previous.id === font.id))?.id || '';
        }
      } else if (type === 'add-local') {
        const files = Array.from(payload.files || []);
        if (!files.length || files.length > 20) throw new Error('一次请选择1–20个字体文件');
        const metadata = payload.metadata;
        if (metadata !== undefined && (!Array.isArray(metadata) || metadata.length !== files.length)) throw new Error('字体名称与标签未对应全部文件');
        const details = files.map((_file, index) => {
          const value = metadata?.[index];
          if (value === undefined && metadata === undefined) return null;
          if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error('字体名称与标签无效');
          return { name: fontInputName(value.name), tags: fontLibraryTags(value.tags === undefined ? [] : value.tags) };
        });
        const parsed = [];
        for (const [index, file] of files.entries()) {
          const item = await localReader(file); guard();
          item.record.id = await localId(item.bytes); guard();
          if (details[index]) item.record = { ...item.record, ...details[index], name: details[index].name || item.record.name };
          validateFontRecord(item.record);
          parsed.push(item);
        }
        if (parsed.reduce((sum, item) => sum + item.bytes.byteLength, 0) > FONT_SOURCE_LIMITS.totalLocalBytes) throw new Error('本次上传字体总量过大');
        const merged = mergeFontLibraryRecords(read(), parsed.map(item => item.record), makeId); next = merged.state;
        revealFontId = next.fonts.find(font => !read().fonts.some(previous => previous.id === font.id))?.id || '';
        for (const item of parsed) { await store.put(merged.mapping.get(item.record.id), item.bytes, 'application/octet-stream'); guard(); }
      } else if (type === 'import') {
        if (!payload.file || payload.file.size > FONT_SOURCE_LIMITS.packBytes) throw new Error('字体包过大或不可读取');
        const pack = importFontPack(await payload.file.text()); guard();
        const canonicalFiles = Object.create(null);
        for (const record of pack.records.filter(font => font.source.kind === 'local')) {
          const bytes = pack.localFiles[record.id];
          if (!bytes) throw new Error('字体包缺少本地原件');
          record.id = await localId(bytes); guard(); canonicalFiles[record.id] = bytes;
        }
        const merged = mergeFontLibraryRecords(read(), pack.records, makeId); next = merged.state;
        revealFontId = next.fonts.find(font => !read().fonts.some(previous => previous.id === font.id))?.id || '';
        next.folders = [...new Set([...next.folders, ...(pack.folders || [])])];
        for (const [id, bytes] of Object.entries(canonicalFiles)) {
          const target = merged.mapping.get(id); if (!target) continue;
          await store.put(target, bytes, 'application/octet-stream'); guard();
        }
        // Imported fonts never replace active choices. Restore the sample only
        // into a previously empty collection, not over a user's current draft.
        if (!read().fonts.length && typeof pack.previewText === 'string') next.previewText = pack.previewText;
      } else if (type === 'export') {
        const state = read(), ids = payload.ids ? new Set(payload.ids) : null;
        const fonts = state.fonts.filter(font => !ids || ids.has(font.id));
        if (!fonts.length) throw new Error('请先添加或选择字体');
        const localFiles = Object.create(null);
        let localTotal = 0;
        for (const font of fonts.filter(font => font.source.kind === 'local')) {
          const blob = await store.get(font.id); guard();
          if (!blob) throw new Error(`本机缺少「${font.name}」原件，未导出不完整备份`);
          if (!Number.isSafeInteger(blob.size) || blob.size < 1 || localTotal + blob.size > FONT_SOURCE_LIMITS.totalLocalBytes) throw new Error('所选本地字体超过 96 MB，请分批导出');
          localTotal += blob.size;
          localFiles[font.id] = await readBlobForExport(blob, guard);
        }
        const packed = exportFontPack(fonts, { localFiles, folders: state.folders, previewText: state.previewText }); guard();
        download(new Blob([packed], { type: 'application/json' }), `qianmu-fonts-${Date.now()}.json`);
        if (current(token) && (!originView || originView === viewIdentity)) view?.setStatus('字体包已导出'); return;
      } else {
        if (type === 'delete-fonts' && !await confirm('移除字体', '移除选中的字体及本机原件？正在使用的字体将恢复原生字体。')) return;
        guard(); next = updateFontLibrary(read(), type === 'delete-font' ? 'delete-fonts' : type, type === 'delete-font' ? { ids: [payload.id] } : payload);
      }
      guard(); const previous = read(); commit(next, token);
      if (type === 'apply-font' && current(token) && (!originView || originView === viewIdentity)) {
        const target = payload.target, label = { body: '正文', st: '界面', shared: '全部' }[target], scopes = target === 'shared' ? ['body', 'st'] : [target];
        if (next.enabled === false) { try { notify(`已保存${label}字体选择，字体库尚未启用`, 'info'); } catch (_) {} }
        else applicationNotice = { token, operation: operationToken, settings: owner.fontLibrary, viewIdentity: originView, scopes, label,
          font: next.fonts.find(font => font.id === payload.fontId), selection: next[target] };
      }
      if (type === 'add-web' || type === 'edit-web') {
        const draftTags = typeof viewSession?.webTags === 'string' ? [...new Set(viewSession.webTags.split(/[,，]/).map(value => value.trim()).filter(Boolean))] : [];
        if (viewSession?.webSource === payload.source && viewSession.webName === (payload.name || '') && (viewSession.editWebId || '') === (editedFontId || '') && JSON.stringify(draftTags) === JSON.stringify(payload.tags || [])) {
          viewSession = { ...viewSession, webSource: '', webName: '', webTags: '', editWebId: '', editWebSourceMissing: false };
        }
        if (!originView || originView !== viewIdentity) view?.clearWebDraft?.(payload);
      }
      if (type === 'update-fonts' && typeof payload.name === 'string' && payload.ids?.length === 1 && viewSession?.renameId === payload.ids[0] && viewSession.renameDraft === payload.name) {
        const draft = viewSession.renameTags, tags = payload.tags ?? next.fonts.find(font => font.id === payload.ids[0])?.tags ?? [];
        const sameTags = (payload.tags === undefined && draft === undefined) || (typeof draft === 'string' && (draft === tags.join(', ') || JSON.stringify([...new Set(draft.split(/[,，]/).map(value => value.trim()).filter(Boolean))]) === JSON.stringify(tags)));
        if (sameTags) viewSession = { ...viewSession, renameId: '', renameDraft: '', renameTags: '' };
      }
      if (type === 'delete-fonts' || type === 'delete-font') {
        const deleted = previous.fonts.filter(font => font.source.kind === 'local' && !next.fonts.some(item => item.id === font.id));
        try { await store.delete(deleted.map(font => font.id)); } catch { if (current(token) && (!originView || originView === viewIdentity)) view?.setStatus('已移除条目，本机原件清理未完成', { error: true }); }
      }
      scheduleAccountPush(token);
      if (current(token)) {
        // The originating view owns its one final redraw/reveal. Preview loading
        // must not hold a successful save behind a redundant old-page sync.
        if (originView) {
          if (viewIdentity !== originView) {
            if (view) view.render(); // A reopened view keeps its own page and draft.
            else void sync().catch(() => {});
          }
        } else { view?.render(); await sync(); }
      }
      return { ...(revealFontId ? { revealFontId } : {}), ...(editedFontId ? { editedFontId } : {}) };
    } catch (error) {
      error.userMessage ||= error.message || '字体操作未完成，请保留原资料后重试';
      throw error;
    } finally { if (operationToken === operation) busy = false; }
  }
  function close(syncRuntime = true) {
    if (view?.captureSession) viewSession = view.captureSession();
    view?.destroy(); view = null; viewIdentity = null; applicationNotice = null; container?.remove(); container = null; previewIds = []; previewChoices = {};
    if (portal) portal.classList.remove('qm-font-library-open');
    portal = null;
    if (syncRuntime && !disposed && runtime && isCurrent()) void sync().catch(() => {});
  }
  async function open(root) {
    try {
      await ensure(); if (!root.isConnected) return;
      close(); portal = root; root.classList.add('qm-font-library-open');
      container = document.createElement('section'); container.className = 'sd-window qm-font-window';
      container.setAttribute('role', 'dialog'); container.setAttribute('aria-modal', 'true'); container.setAttribute('aria-label', '字体库管理');
      root.querySelector('.sd-floor-shell').appendChild(container);
      const identity = {}; viewIdentity = identity;
      view = viewFactory({ root: container, getState: uiState, onAction: payload => action(payload, {}, identity), onVisibleFonts: (ids, choices) => visible(ids, choices, identity), initialSession: viewSession,
        notify: (text, level) => { if (identity === viewIdentity && current(generation)) notify(text, level); },
        onBack: () => { close(); root.querySelector('[data-font-library]')?.focus(); },
        onClose: () => closePanel ? closePanel() : root.querySelector('.sd-floor-close')?.click(),
        fontFamily: id => runtime.family(id) });
      container.querySelector?.('[data-font-action="back"]')?.focus({ preventScroll: true });
    } catch (error) { if (portal === root) close(); notify(error.message || '字体库打开失败', 'warning'); }
  }
  function attach(root) {
    detach(); attached = root;
    const button = root.querySelector('[data-font-library]');
    const clicked = () => { void open(root); };
    const outside = event => {
      if (!container || portal !== root || ![root, root.querySelector('.sd-floor-shell'), root.querySelector('.sd-floor-backdrop')].includes(event.target)) return;
      event.stopPropagation();
      if (closePanel) closePanel(); else root.querySelector('.sd-floor-close')?.click();
    };
    button?.addEventListener('click', clicked);
    root.addEventListener?.('click', outside, true);
    removeEntry = () => { button?.removeEventListener('click', clicked); root.removeEventListener?.('click', outside, true); };
    updateEntry();
  }
  function detach() { close(); removeEntry?.(); removeEntry = null; attached = null; }
  function dispose() { disposed = true; lifecycle++; operation++; detach(); release(); busy = false; }
  function activate() { if (disposed) { disposed = false; lifecycle++; } }
  return { attach, detach, sync, dispose, activate, action, read };
}
