import { normalizeFontLibrary, mergeFontLibraryRecords, updateFontLibrary } from './qianmu-font-library-state.js?v=1.59.467';
import { FONT_SOURCE_LIMITS, resolveWebFontSource, createLocalFontRecord, exportFontPack, importFontPack } from './qianmu-font-sources.js';
import { createFontLibraryView } from './qianmu-font-library-view.js?v=1.59.467';
import { createFontRuntime } from './qianmu-font-runtime.js?v=1.59.467';
import { createFontLocalStore } from './qianmu-font-local-store.js';

// Web references live in the ordinary ST extension settings. Uploaded originals
// are device/account scoped and never enter chat metadata or ST user/files.
export function createFontLibrary({ getOwner, save, resolveNamespace, isCurrent, document = globalThis.document,
  notify = () => {}, download, confirm = async () => false, beforeApply, afterApply, closePanel, getPreviewFontSize = () => 18,
  localStoreFactory = createFontLocalStore, runtimeFactory = createFontRuntime, viewFactory = createFontLibraryView,
  webResolver = resolveWebFontSource, localReader = createLocalFontRecord } = {}) {
  let owner = null, namespace = '', store = null, runtime = null, view = null, portal = null, container = null;
  let generation = 0, lifecycle = 0, operation = 0, disposed = false, busy = false, previewIds = [], previewChoices = {}, attached = null, removeEntry = null, webAbort = null, viewSession = null;
  const statuses = new Map();
  const makeId = () => `f_${globalThis.crypto.randomUUID().replaceAll('-', '')}`;
  const localId = async bytes => 'local_' + Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), b => b.toString(16).padStart(2, '0')).join('');
  const read = () => normalizeFontLibrary(getOwner()?.fontLibrary);
  const current = token => !disposed && token === generation && isCurrent() && getOwner() === owner;
  const assertCurrent = token => { if (!current(token)) throw new Error('字体库所属设置已变化，请重新打开'); };
  function status(id, value) {
    statuses.set(id, value);
    view?.setFontStatus(id, value.status === 'error' ? value.message || '字体暂不可用' : value.status === 'loading' ? '加载中…' : '');
  }
  function release() {
    webAbort?.abort(); webAbort = null;
    generation++; runtime?.dispose(); store?.dispose(); runtime = null; store = null; namespace = ''; owner = null; viewSession = null; statuses.clear();
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
      runtime = runtimeFactory({ document, readLocal: id => store.get(id), accountKey: namespace, onStatus: status, beforeApply, afterApply });
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
    await runtime.sync({ ...read(), previewChoices }, previewIds); assertCurrent(token); updateEntry();
  }
  function commit(next, token) {
    assertCurrent(token);
    const target = owner, previous = target.fontLibrary, staged = normalizeFontLibrary(next);
    target.fontLibrary = staged;
    try { save(target); } catch (error) { if (target.fontLibrary === staged) target.fontLibrary = previous; throw error; }
    updateEntry();
  }
  function uiState() {
    const state = read(), requestedSize = Number(getPreviewFontSize());
    const defaultPreviewSize = Number.isFinite(requestedSize) && requestedSize >= 1 && requestedSize <= 200 ? requestedSize : 18;
    return { ...state, defaultPreviewSize, entries: state.fonts.map(font => ({ ...font, sourceType: font.source.kind, variantKnown: font.source.variantKnown,
      weights: [...new Set(font.faces.map(face => face.weight || '400'))],
      styles: [...new Set(font.faces.map(face => face.style || 'normal'))], status: statuses.get(font.id)?.status === 'error' ? statuses.get(font.id).message : '' })) };
  }
  async function visible(ids, choices = previewChoices) {
    previewIds = ids; previewChoices = choices;
    try { await sync(); } catch (error) { view?.setStatus(error.message, { error: true }); }
  }
  async function action(type, payload = {}) {
    if (disposed) throw new Error('字体库已关闭，请重新打开');
    // Accept both action-object and positional view callbacks.
    if (typeof type === 'object') { payload = type.payload || type; type = type.type; }
    if (type === 'set-preview' && owner && current(generation)) {
      commit(updateFontLibrary(read(), type, payload), generation);
      void visible(previewIds); return;
    }
    if (busy) throw new Error('上一项字体操作尚未完成');
    busy = true; const operationToken = ++operation;
    try {
      const token = await ensure(), original = owner.fontLibrary;
      const guard = () => { assertCurrent(token); if (owner.fontLibrary !== original) throw new Error('字体库已变化，未覆盖新的选择'); };
      let next;
      if (type === 'add-web') {
        webAbort = new AbortController();
        const aborter = webAbort;
        let records;
        try { records = await webResolver(payload.source, { name: payload.name, baseUrl: document.baseURI, signal: aborter.signal }); }
        finally { if (webAbort === aborter) webAbort = null; }
        guard();
        next = mergeFontLibraryRecords(read(), records, makeId).state;
      } else if (type === 'add-local') {
        const files = Array.from(payload.files || []);
        if (!files.length || files.length > 20) throw new Error('一次请选择1–20个字体文件');
        const parsed = [];
        for (const file of files) {
          const item = await localReader(file); guard();
          item.record.id = await localId(item.bytes); guard();
          parsed.push(item);
        }
        if (parsed.reduce((sum, item) => sum + item.bytes.byteLength, 0) > FONT_SOURCE_LIMITS.totalLocalBytes) throw new Error('本次上传字体总量过大');
        const merged = mergeFontLibraryRecords(read(), parsed.map(item => item.record), makeId); next = merged.state;
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
        for (const font of fonts.filter(font => font.source.kind === 'local')) {
          const blob = await store.get(font.id); guard();
          if (!blob) throw new Error(`本机缺少「${font.name}」原件，未导出不完整备份`);
          localFiles[font.id] = new Uint8Array(await blob.arrayBuffer()); guard();
        }
        const packed = exportFontPack(fonts, { localFiles, folders: state.folders, previewText: state.previewText }); guard();
        download(new Blob([packed], { type: 'application/json' }), `qianmu-fonts-${Date.now()}.json`);
        view?.setStatus('字体包已导出'); return;
      } else {
        if (type === 'delete-fonts' && !await confirm('移除字体', '移除选中的字体及本机原件？正在使用的字体将恢复原生字体。')) return;
        guard(); next = updateFontLibrary(read(), type, payload);
      }
      guard(); const previous = read(); commit(next, token);
      if (type === 'add-web') {
        if (viewSession?.webSource === payload.source && viewSession.webName === (payload.name || '')) {
          viewSession = { ...viewSession, webSource: '', webName: '' };
        }
        view?.clearWebDraft?.(payload);
      }
      if (type === 'delete-fonts') {
        const deleted = previous.fonts.filter(font => font.source.kind === 'local' && !next.fonts.some(item => item.id === font.id));
        try { await store.delete(deleted.map(font => font.id)); } catch { view?.setStatus('已移除条目，本机原件清理未完成', { error: true }); }
      }
      if (current(token)) { view?.render(); await sync(); }
    } catch (error) {
      error.userMessage ||= error.message || '字体操作未完成，请保留原资料后重试';
      throw error;
    } finally { if (operationToken === operation) busy = false; }
  }
  function close(syncRuntime = true) {
    if (view?.captureSession) viewSession = view.captureSession();
    view?.destroy(); view = null; container?.remove(); container = null; previewIds = []; previewChoices = {};
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
      view = viewFactory({ root: container, getState: uiState, onAction: action, onVisibleFonts: visible, initialSession: viewSession,
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
    button?.addEventListener('click', clicked);
    removeEntry = () => button?.removeEventListener('click', clicked);
    updateEntry();
  }
  function detach() { close(); removeEntry?.(); removeEntry = null; attached = null; }
  function dispose() { disposed = true; lifecycle++; operation++; detach(); release(); busy = false; }
  function activate() { if (disposed) { disposed = false; lifecycle++; } }
  return { attach, detach, sync, dispose, activate, action, read };
}
