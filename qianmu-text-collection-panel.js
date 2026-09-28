import {qianmuIconElement} from './qianmu-icon-renderer.js';

// Isolated candidate: the caller owns the account lifetime, themed parent and
// stylesheet. Closing this view does not dispose the collection's data session.
export const TEXT_COLLECTION_STYLESHEET = new URL('./qianmu-text-collection-panel.css', import.meta.url);
const PAGE_SIZE = 20;
const displayText = text => text.replace(/\r\n?/g, '\n').replace(/\n(?:[\t ]*\n){2,}/g, '\n\n');
const titleFor = item => `${item.charName || '未命名角色'} & ${item.userName || '未命名用户'} · ${new Date(item.createdAt).toLocaleDateString('zh-CN')}`;

export function createTextCollectionPanel({parent, collection, isCurrent, copyText} = {}) {
    const doc = parent?.ownerDocument;
    if (!doc || !collection || typeof isCurrent !== 'function') throw new TypeError('Collection panel requires its owner');
    const make = (tag, className, text) => {
        const node = doc.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined) node.textContent = text;
        return node;
    };
    let visible = false, disposed = false, unsubscribe = null, pending = false, opening = 0;
    let snapshot = null, route = 'list', selectedId = null, draft = null;
    let query = '', page = 0, multi = false, listKey = null, readKey = null;
    let listScroll = 0, readScroll = 0, notice = '', returnFocus = null;
    const selection = new Set();
    const dialog = make('dialog', 'qm-collection-panel');
    dialog.setAttribute('aria-label', '正文收藏');
    const header = make('header'), heading = make('h2', '', '正文收藏'), headerTools = make('nav');
    const button = (label, icon, action) => {
        const node = make('button');
        node.type = 'button'; node.title = label; node.setAttribute('aria-label', label);
        const glyph = qianmuIconElement(`qm-regular-${icon}`, {document: doc});
        if (glyph) node.append(glyph);
        node.addEventListener('click', () => { if (!node.disabled && current()) action(); });
        return node;
    };
    function current() {
        if (disposed) return false;
        if (isCurrent() !== true) { dispose(); return false; }
        return true;
    }
    const closeButton = button('关闭收藏', 'x', close);
    const cancelButton = button('取消编辑', 'arrow-left', () => {
        if (busy()) return;
        draft = null; notice = ''; route = selectedId ? 'read' : 'list'; render();
    });
    headerTools.append(cancelButton, closeButton); header.append(heading, headerTools);
    const listView = make('section', 'qm-collection-list-view'), toolbar = make('nav', 'qm-collection-toolbar');
    const search = make('input'); search.type = 'search'; search.placeholder = '搜索关键词'; search.setAttribute('aria-label', '搜索收藏');
    search.addEventListener('input', () => {
        if (!current()) return;
        query = search.value; page = 0; listScroll = 0; render();
    });
    const refreshButton = button('刷新收藏', 'arrows-clockwise', refresh);
    const multiButton = button('多选收藏', 'list-checks', () => { multi = !multi; selection.clear(); render(); });
    const deleteButton = button('删除选中收藏', 'trash', removeSelected);
    toolbar.append(search, refreshButton, multiButton, deleteButton);
    const list = make('div', 'qm-collection-list');
    list.addEventListener('scroll', () => { if (route === 'list') listScroll = list.scrollTop; });
    const paging = make('nav', 'qm-collection-paging');
    const previousButton = button('上一页收藏', 'arrow-left', () => { page--; listScroll = 0; render(); });
    const nextButton = button('下一页收藏', 'arrow-right', () => { page++; listScroll = 0; render(); });
    const pageLabel = make('span'); paging.append(previousButton, pageLabel, nextButton);
    listView.append(toolbar, list, paging);
    const reader = make('article', 'qm-collection-text');
    reader.addEventListener('scroll', () => { if (route === 'read') readScroll = reader.scrollTop; });
    const editor = make('textarea', 'qm-collection-editor'); editor.setAttribute('aria-label', '收藏正文');
    editor.addEventListener('input', () => {
        if (!current() || !draft || busy()) return;
        // Keep the untouched source separately: textarea normalizes CRLF even
        // when a user has not typed. Opening an editor must not rewrite text.
        draft.text = editor.value === draft.displayOriginal ? draft.item.text : editor.value;
        updateControls();
    });
    const footer = make('footer');
    const backButton = button('返回收藏列表', 'arrow-left', () => { route = 'list'; notice = ''; render(); });
    const readActions = make('nav');
    const copyButton = button('复制收藏正文', 'copy', async () => {
        const item = activeItem();
        if (!item && !draft) return;
        try {
            await (copyText || (text => doc.defaultView.navigator.clipboard.writeText(text)))(route === 'edit' ? draft.text : item.text);
            if (current()) { notice = '已复制'; renderStatus(); }
        } catch { if (current()) { notice = '复制未完成，请重试。'; renderStatus(); } }
    });
    const editButton = button('编辑收藏', 'pencil-simple', () => {
        const item = activeItem(); if (!item || busy()) return;
        draft = {item: structuredClone(item), text: item.text, displayOriginal: displayText(item.text), fingerprint: snapshot.fingerprint, isNew: false};
        startEditor();
    });
    const saveButton = button('保存收藏', 'star', save);
    readActions.append(copyButton, editButton, saveButton); footer.append(backButton, readActions);
    const status = make('div', 'qm-collection-status'); status.setAttribute('role', 'status');
    const statusText = make('span'), reconcileButton = button('核对保存结果', 'arrows-clockwise', refresh);
    status.append(statusText, reconcileButton);
    dialog.append(header, listView, reader, editor, status, footer);
    dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
    // Native close events are queued. An old close must not dismiss a dialog
    // that has already been reopened by the time that event is delivered.
    dialog.addEventListener('close', () => { if (!dialog.open) close(); });
    // Only this dialog's events are isolated. No host listeners, observers or
    // document-wide selectors, and no prevention of native editing/Tab behavior.
    for (const type of ['keydown', 'keyup', 'keypress', 'beforeinput', 'input', 'paste', 'cut']) {
        dialog.addEventListener(type, event => event.stopPropagation());
    }

    function activeItem() { return snapshot?.items.find(item => item.id === selectedId); }
    function busy() { return pending || ['loading', 'refreshing', 'saving'].includes(snapshot?.phase); }
    function startEditor() {
        route = 'edit'; notice = ''; editor.value = displayText(draft.text); editor.scrollTop = 0;
        render(); editor.focus();
    }
    function renderStatus() {
        if (!visible) return;
        let text = notice;
        if (!text && snapshot?.error) {
            text = !snapshot.loaded ? '收藏暂时无法读取，请刷新重试。'
                : snapshot.needsRefresh ? '保存未完成，修改已保留。请刷新核对后重试。'
                    : /conflict/.test(snapshot.error.code) ? '收藏已有更新，修改已保留。请复制后重新打开。'
                        : '操作未完成，请重试。';
        }
        statusText.textContent = text;
        reconcileButton.hidden = route === 'list' || !snapshot?.error;
        reconcileButton.disabled = busy();
        status.hidden = !text && reconcileButton.hidden;
    }
    function updateControls() {
        const waiting = busy(), writable = snapshot?.loaded && !snapshot.needsRefresh;
        dialog.setAttribute('aria-busy', String(waiting));
        refreshButton.disabled = waiting;
        multiButton.disabled = waiting || !snapshot?.loaded;
        multiButton.setAttribute('aria-pressed', String(multi));
        deleteButton.hidden = !multi;
        deleteButton.disabled = waiting || !writable || !selection.size;
        editButton.disabled = waiting || !writable || !activeItem();
        cancelButton.disabled = waiting;
        saveButton.disabled = waiting || !writable || !draft?.text.trim();
        editor.readOnly = waiting;
        search.disabled = !snapshot?.loaded;
    }
    function renderList() {
        const normalizedQuery = query.trim().toLocaleLowerCase();
        const items = (snapshot?.items || []).filter(item => !normalizedQuery ||
            `${titleFor(item)}\n${item.text}`.toLocaleLowerCase().includes(normalizedQuery));
        const pages = Math.max(1, Math.ceil(items.length / PAGE_SIZE));
        page = Math.min(Math.max(page, 0), pages - 1);
        const visibleItems = items.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
        const key = JSON.stringify([snapshot?.loaded, snapshot?.fingerprint,
            !snapshot?.loaded && Boolean(snapshot?.error), query, page, multi, [...selection]]);
        if (key !== listKey) {
            listKey = key;
            const rows = visibleItems.map(item => {
                const row = make('div', 'qm-collection-row');
                if (multi) {
                    const checkbox = make('input'); checkbox.type = 'checkbox'; checkbox.checked = selection.has(item.id);
                    checkbox.setAttribute('aria-label', `选择收藏：${item.id}`);
                    checkbox.addEventListener('change', () => {
                        if (!current() || busy()) return;
                        if (checkbox.checked) selection.add(item.id); else selection.delete(item.id);
                        updateControls();
                    });
                    row.append(checkbox);
                }
                const link = make('button', 'qm-collection-entry'); link.type = 'button'; link.setAttribute('aria-label', `阅读收藏：${item.id}`);
                const name = make('span', 'qm-collection-name', titleFor(item));
                const preview = make('span', 'qm-collection-preview', item.text.replace(/\s+/g, ' '));
                link.append(name, preview);
                link.addEventListener('click', () => {
                    if (!current()) return;
                    selectedId = item.id; route = 'read'; readScroll = 0; notice = ''; render();
                });
                row.append(link); return row;
            });
            list.replaceChildren(...rows);
            if (!rows.length) list.append(make('p', 'qm-collection-empty', snapshot?.loaded
                ? query ? '没有找到收藏' : '还没有收藏' : snapshot?.error ? '' : '正在读取…'));
        }
        for (const checkbox of list.querySelectorAll('input[type="checkbox"]')) checkbox.disabled = busy();
        previousButton.disabled = page === 0; nextButton.disabled = page + 1 === pages;
        pageLabel.textContent = `${page + 1} / ${pages}`; paging.hidden = pages <= 1;
        list.scrollTop = listScroll;
    }
    function render() {
        if (!visible || !current()) return;
        const item = activeItem();
        if (route === 'read' && !item) { route = 'list'; selectedId = null; }
        heading.textContent = route === 'list' ? '正文收藏' : titleFor(route === 'edit' ? draft.item : item);
        listView.hidden = route !== 'list'; reader.hidden = route !== 'read'; editor.hidden = route !== 'edit';
        footer.hidden = route === 'list'; backButton.hidden = route === 'edit'; cancelButton.hidden = route !== 'edit';
        editButton.hidden = route !== 'read'; saveButton.hidden = route !== 'edit';
        if (route === 'list') renderList();
        if (route === 'read') {
            const key = `${item.id}\0${item.text}`;
            if (key !== readKey) {
                readKey = key;
                reader.replaceChildren(...displayText(item.text).split(/\n[\t ]*\n/).filter(text => text.trim())
                    .map(text => make('p', '', text)));
            }
            reader.scrollTop = readScroll;
        }
        updateControls(); renderStatus();
    }
    async function refresh() {
        if (!current() || busy()) return;
        notice = '';
        try {
            const refreshed = await collection.refresh();
            if (!current()) return;
            // Reconcile only the captured ID and exact desired text, never a
            // similar-looking entry. An unknown write is not replayed.
            if (draft && refreshed.items.some(item => item.id === draft.item.id && item.text === draft.text)) {
                selectedId = draft.item.id; draft = null; route = 'read';
            }
        } catch { /* The model supplies a sanitized actionable status below. */ }
        render();
    }
    async function save() {
        if (!current() || busy() || !draft) return;
        const edit = draft; pending = true; notice = ''; updateControls();
        try {
            const options = {expectedFingerprint: edit.fingerprint};
            if (edit.isNew) await collection.add({id: edit.item.id, text: edit.text,
                charName: edit.item.charName, userName: edit.item.userName, source: edit.item.source ?? null}, options);
            else await collection.edit(edit.item.id, edit.text, options);
            if (!current()) return;
            selectedId = edit.item.id; draft = null; route = 'read'; readScroll = 0;
        } catch (error) {
            if (current()) notice = snapshot?.needsRefresh ? ''
                : /conflict|missing/.test(error?.code || '') ? '收藏已有更新，修改已保留。请复制后重新打开。'
                    : '保存未完成，修改已保留。';
        } finally { pending = false; render(); }
    }
    async function removeSelected() {
        if (!current() || busy() || !selection.size) return;
        const ids = [...selection]; pending = true; notice = ''; updateControls();
        try {
            await collection.remove(ids, {expectedFingerprint: snapshot.fingerprint});
            if (!current()) return;
            selection.clear(); multi = false;
        } catch { if (current()) notice = '删除未完成，请刷新后重试。'; }
        finally { pending = false; render(); }
    }
    async function open() {
        if (!current()) return false;
        if (!visible) {
            returnFocus = doc.activeElement; visible = true; opening++; parent.append(dialog);
            dialog.showModal();
            unsubscribe = collection.subscribe(value => {
                snapshot = value;
                if (value.loaded) {
                    const existing = new Set(value.items.map(item => item.id));
                    for (const id of selection) if (!existing.has(id)) selection.delete(id);
                }
                render();
            });
        }
        const requestedOpening = opening;
        try { await collection.open(); }
        catch { /* Keep the view retryable; never show a read failure as empty. */ }
        if (!current() || !visible || requestedOpening !== opening) return false;
        render(); return visible;
    }
    async function collect(input) {
        const opened = open(), requestedOpening = opening;
        if (!await opened || requestedOpening !== opening || busy() || !snapshot?.loaded) return false;
        if (draft) { route = 'edit'; render(); return false; }
        if (typeof input?.text !== 'string' || !input.text.trim()
            || typeof input.charName !== 'string' || typeof input.userName !== 'string') return false;
        // The capture keeps its ID through retries, including a lost receipt.
        let source;
        try { source = structuredClone(input.source ?? null); } catch { return false; }
        const item = {text: input.text, charName: input.charName, userName: input.userName, source,
            id: crypto.randomUUID(), createdAt: new Date().toISOString()};
        selectedId = null;
        draft = {item, text: input.text, displayOriginal: displayText(input.text), fingerprint: snapshot.fingerprint, isNew: true};
        startEditor(); return true;
    }
    function close() {
        if (!visible) return;
        visible = false; opening++; unsubscribe?.(); unsubscribe = null;
        dialog.close(); dialog.remove();
        if (returnFocus?.isConnected) returnFocus.focus({preventScroll: true});
    }
    function dispose() {
        close(); disposed = true; draft = null; snapshot = null; selection.clear();
        list.replaceChildren(); reader.replaceChildren(); editor.value = '';
    }
    return Object.freeze({open, collect, close, dispose});
}
