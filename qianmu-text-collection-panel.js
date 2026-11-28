import {qianmuIconElement} from './qianmu-icon-renderer.js?v=1.59.478';
import {createTextCollectionEditor} from './qianmu-text-collection-editor.js';
import {sameTextCollectionItem} from './qianmu-text-collection.js';
import {createTextCollectionOrganizationView} from './qianmu-text-collection-organization-view.js?v=1.59.419';
import {filterTextCollectionItems, textCollectionItemOrganization} from './qianmu-text-collection-organization.js';
import {normalizeTextCollectionTagRules, textCollectionPlainText} from './qianmu-text-collection-markup.js';

// Isolated candidate: the caller owns the account lifetime, themed parent and
// stylesheet. Closing this view does not dispose the collection's data session.
export const TEXT_COLLECTION_STYLESHEET = new URL('./qianmu-text-collection-panel.css', import.meta.url);
const PAGE_SIZE = 20;
const displayText = text => text.replace(/\r\n?/g, '\n').replace(/\n(?:[\t ]*\n){2,}/g, '\n\n');
const titleFor = item => `${item.charName || '未命名角色'} & ${item.userName || '未命名用户'} · ${new Date(item.createdAt).toLocaleDateString('zh-CN')}`;

// locateFloor() 每次调用都按当前打开的聊天现算一张对照表，返回「来源 → 楼层号或 null」；只有来源确实落在当前聊天、
// 且那一层还在时才有楼层号。onJumpFloor(楼层号) 沿用聊天工具包的跳层。两者缺省时不显示楼层标签。
// tagRules {read, write}：正文收藏的标签规则（工具栏里的规则卡片）。formatRaw(原文, {charName, source}) 返回 ST 格式化后的 HTML，
// 带原文的条目用它显示成楼层的样子；缺省或失败时照旧按纯文本段落显示。
export function createTextCollectionPanel({parent, collection, isCurrent, copyText, onExportImage, locateFloor, onJumpFloor, enabled, tagRules, formatRaw} = {}) {
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
    let query = '', multi = false, listKey = null, readKey = null;
    let listScroll = 0, readScroll = 0, notice = '', returnFocus = null;
    const loadedWindows = new Map();
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
    const backButton = button('返回收藏列表', 'arrow-left', () => { route = 'list'; notice = ''; render(); });
    headerTools.append(closeButton); header.append(backButton, cancelButton, heading, headerTools);
    const listView = make('section', 'qm-collection-list-view'), toolbar = make('nav', 'qm-collection-toolbar');
    const search = make('input'); search.type = 'search'; search.placeholder = '搜索关键词'; search.setAttribute('aria-label', '搜索收藏');
    search.addEventListener('input', () => {
        if (!current()) return;
        query = search.value; listScroll = 0; endSelection(); render();
    });
    // 多选按钮三态：进入多选 → 全选已加载 → 清空并退出。
    const multiButton = button('多选收藏', 'list-checks', () => {
        if (!multi) { multi = true; selection.clear(); }
        else if (allSelected()) endSelection();
        else for (const item of loadedItems()) selection.add(item.id);
        render();
    });
    const deleteButton = button('删除选中收藏', 'trash', removeSelected);
    const organizeView = createTextCollectionOrganizationView({parent, collection, isCurrent,
        onComplete: () => { endSelection(); render(); }});
    const organizeSelected = button('整理选中收藏', 'folder', () => organizeView.organize(selectedLoadedIds()));
    const foldersButton = button('管理文件夹', 'folder-plus', () => organizeView.folders());
    const rulesButton = button('标签规则', 'funnel', () => { rulesOpen = !rulesOpen; if (rulesOpen) { ruleRows = []; paintRules(); } render(); });
    toolbar.append(search, foldersButton, multiButton, rulesButton, organizeSelected, deleteButton);
    // 标签规则卡片：与取材同一套（标签名 + 屏蔽／提取 + 删除），只作用在「全文」收藏上。
    let rulesOpen = false, ruleRows = [];
    const rulesSheet = make('div', 'qm-collection-rules'); rulesSheet.setAttribute('aria-label', '收藏标签规则');
    const ruleList = make('div', 'qm-collection-rule-list');
    const addRule = button('添加标签', 'plus', () => { ruleRows.push({name: '', action: 'remove'}); paintRules(); });
    addRule.className = 'qm-collection-rule-add'; addRule.append(make('span', '', '添加标签'));
    rulesSheet.append(ruleList, addRule);
    function readRules() {
        try { return normalizeTextCollectionTagRules(tagRules?.read?.()); }
        catch (error) { console.warn('[Qianmu] Collection tag rules unavailable', error); return normalizeTextCollectionTagRules(undefined); }
    }
    function writeRules() {
        try { tagRules?.write?.(ruleRows.filter(rule => rule.name).map(rule => ({name: rule.name, action: rule.action}))); }
        catch (error) { console.warn('[Qianmu] Collection tag rules save failed', error); notice = '标签规则未保存，请重试。'; renderStatus(); }
    }
    function paintRules() {
        if (!ruleRows.length) ruleRows = readRules().filter(rule => rule.name);
        // 没有规则时留一行空白可填，与取材一致。
        if (!ruleRows.length) ruleRows = [{name: '', action: 'remove'}];
        ruleList.replaceChildren(...ruleRows.map((rule, index) => {
            const row = make('div', 'qm-collection-rule');
            const name = make('input'); name.type = 'text'; name.value = rule.name;
            name.placeholder = '标签名，如 thinking'; name.setAttribute('aria-label', `标签名 ${index + 1}`);
            name.addEventListener('change', () => {
                if (!current()) return;
                rule.name = normalizeTextCollectionTagRules([{name: name.value}])[0].name; name.value = rule.name; writeRules();
            });
            const action = make('select'); action.setAttribute('aria-label', `标签处理 ${index + 1}`);
            for (const [value, label] of [['remove', '屏蔽'], ['extract', '提取']]) {
                const option = make('option', '', label); option.value = value; action.append(option);
            }
            action.value = rule.action;
            action.addEventListener('change', () => { if (!current()) return; rule.action = action.value === 'extract' ? 'extract' : 'remove'; writeRules(); });
            const remove = button('删除', 'x', () => { ruleRows.splice(index, 1); writeRules(); paintRules(); });
            remove.setAttribute('aria-label', `删除标签 ${index + 1}`);
            row.append(name, action, remove); return row;
        }));
    }
    // 启用开关：关掉后楼层上不再出现收藏星标，已有收藏照常可看可用。
    const enabledSwitch = make('label', 'qm-collection-switch'), enabledInput = make('input');
    enabledInput.type = 'checkbox'; enabledInput.setAttribute('role', 'switch'); enabledInput.setAttribute('aria-label', '启用正文收藏');
    enabledInput.title = '启用正文收藏';
    enabledInput.addEventListener('change', () => { if (!current()) return; try { enabled?.write?.(enabledInput.checked); } catch (error) { console.warn('[Qianmu] Collection switch failed', error); enabledInput.checked = !enabledInput.checked; } });
    enabledSwitch.append(enabledInput, make('span'));
    enabledSwitch.hidden = typeof enabled?.write !== 'function';
    headerTools.insertBefore(enabledSwitch, closeButton);
    const resumeDraft = button('继续未保存的编辑', 'pencil-simple', () => { if (draft) startEditor(); });
    resumeDraft.className = 'qm-collection-resume';
    resumeDraft.append(make('span', '', '继续未保存的编辑'));
    const list = make('div', 'qm-collection-list');
    list.setAttribute('tabindex', '0'); list.setAttribute('aria-label', '收藏列表');
    list.addEventListener('scroll', () => {
        if (route !== 'list' || !visible || !current()) return;
        listScroll = list.scrollTop;
        if (list.clientHeight > 0 && list.scrollHeight - list.scrollTop - list.clientHeight < 96) loadMore();
    });
    const moreButton = button('显示更多收藏', 'arrow-down', loadMore);
    moreButton.className = 'qm-collection-more'; moreButton.append(make('span', '', '显示更多'));
    listView.append(toolbar, rulesSheet, resumeDraft, list);
    const reader = make('article', 'qm-collection-text');
    reader.addEventListener('scroll', () => { if (route === 'read') readScroll = reader.scrollTop; });
    const editorControl = createTextCollectionEditor({document: doc, onChange: text => {
        if (!current() || !draft || busy()) return;
        if (hasRaw(draft)) draft.raw = text; else draft.text = text;
        updateControls();
    }});
    const editor = editorControl.element;
    const footer = make('footer');
    const readActions = make('nav');
    const imageButton = button('收藏存图', 'image', () => {
        const item = activeItem();
        if (item && !busy()) onExportImage?.(structuredClone(item));
    });
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
        if (draft && draft.item.id !== item.id) {
            notice = '还有未保存的编辑，请返回列表继续或取消。'; renderStatus(); return;
        }
        if (!draft) draft = {item: structuredClone(item), text: item.text, ...hasRaw(item) ? {raw: item.raw} : {}, fingerprint: snapshot.fingerprint, isNew: false};
        startEditor();
    });
    const organizeButton = button('整理收藏', 'tag', () => { if (activeItem() && !busy()) organizeView.organize([selectedId]); });
    const saveButton = button('保存收藏', 'check', save);
    const floorButton = make('button', 'qm-collection-floor'); floorButton.type = 'button'; floorButton.hidden = true;
    floorButton.addEventListener('click', () => { if (current() && route === 'read') jumpToFloor(selectedId); });
    readActions.append(organizeButton, imageButton, copyButton, editButton, saveButton); footer.append(floorButton, readActions);
    const status = make('div', 'qm-collection-status'); status.setAttribute('role', 'status');
    const statusText = make('span'), reconcileButton = button('核对保存结果', 'arrows-clockwise', refresh);
    status.append(statusText, reconcileButton);
    dialog.append(header, listView, reader, editor, status, footer);
    // 多选时点列表或面板的空白处（不是条目、也不是工具栏的控件）退出多选。
    dialog.addEventListener('click', event => {
        if (!multi || route !== 'list' || busy() || !current()) return;
        for (let node = event.target; node && node !== dialog; node = node.parentNode) {
            if (['BUTTON', 'INPUT', 'SELECT', 'LABEL', 'OPTION', 'A'].includes(node.tagName)
                || node.classList?.contains('qm-collection-row') || node === rulesSheet) return;
        }
        endSelection(); render();
    });
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
    function hasRaw(value) { return typeof value?.raw === 'string'; }
    // 保存回执只认这条草稿自己的编号和确切内容（含原文）。
    function sameSaved(item, edit) { return item.id === edit.item.id && item.text === edit.text && item.raw === edit.raw; }
    function allSelected() { const items = loadedItems(); return items.length > 0 && items.every(item => selection.has(item.id)); }
    function formatted(raw, item) {
        if (typeof formatRaw !== 'function') return null;
        try {
            const html = formatRaw(raw, {charName: item.charName, source: item.source ?? null});
            return typeof html === 'string' ? html : null;
        } catch (error) { console.warn('[Qianmu] Collection formatting failed', error); return null; }
    }
    function plainParagraphs(text) {
        return displayText(text).split(/\n[\t ]*\n/).filter(value => value.trim()).map(value => make('p', '', value));
    }
    function endSelection() { multi = false; selection.clear(); }
    function busy() { return pending || ['loading', 'refreshing', 'saving'].includes(snapshot?.phase); }
    // focus=false：只把正文摆进编辑区，不抢焦点；用户点到文字才开始编辑（手机上不会一进来就弹输入法）。
    function startEditor(focus = true) {
        route = 'edit'; notice = ''; editorControl.setText(hasRaw(draft) ? draft.raw : draft.text); editor.scrollTop = 0;
        render();
        if (focus) editor.focus();
    }
    function renderStatus() {
        if (!visible) return;
        let text = notice;
        if (!text && snapshot?.error) {
            text = /capacity/.test(snapshot.error.code) && !snapshot.needsRefresh
                ? snapshot.loaded ? '收藏超过存储上限，本次未保存，修改已保留。' : '收藏文件过大，暂时无法读取。原件未改动。'
                : !snapshot.loaded ? '收藏暂时无法读取，请关闭后重新打开。'
                : snapshot.needsRefresh ? '保存未完成，修改已保留。请刷新核对后重试。'
                    : /conflict/.test(snapshot.error.code) ? '收藏已有更新，修改已保留。'
                        : '操作未完成，请重试。';
        }
        statusText.textContent = text;
        reconcileButton.hidden = route === 'list' || !snapshot?.error
            || !snapshot.needsRefresh && /capacity/.test(snapshot.error.code);
        reconcileButton.disabled = busy();
        status.hidden = !text && reconcileButton.hidden;
    }
    function updateControls() {
        const waiting = busy(), writable = snapshot?.loaded && !snapshot.needsRefresh;
        dialog.setAttribute('aria-busy', String(waiting));
        multiButton.disabled = waiting || !snapshot?.loaded || !filteredItems().length;
        multiButton.setAttribute('aria-pressed', String(multi));
        multiButton.title = !multi ? '多选收藏' : allSelected() ? '取消多选' : '全选已加载收藏';
        rulesButton.setAttribute('aria-pressed', String(rulesOpen));
        rulesButton.hidden = typeof tagRules?.write !== 'function';
        for (const node of list.querySelectorAll('.qm-collection-delete')) node.disabled = waiting || !writable;
        deleteButton.hidden = !multi;
        deleteButton.disabled = waiting || !writable || !selection.size;
        organizeSelected.hidden = !multi;
        organizeSelected.disabled = waiting || !writable || !selection.size;
        foldersButton.disabled = waiting || !writable;
        organizeButton.disabled = waiting || !writable;
        editButton.disabled = waiting || !writable || !activeItem();
        imageButton.disabled = waiting || !activeItem();
        cancelButton.disabled = waiting;
        saveButton.disabled = waiting || !writable || !(hasRaw(draft) ? draft.raw : draft?.text)?.trim();
        editorControl.setReadOnly(waiting);
        search.disabled = !snapshot?.loaded;
        resumeDraft.hidden = !draft;
        resumeDraft.disabled = waiting;
    }
    function windowKey() { return query.trim().toLocaleLowerCase(); }
    function filteredItems() {
        return filterTextCollectionItems(snapshot || {items: []}, {query});
    }
    function loadedItems() { return filteredItems().slice(0, loadedWindows.get(windowKey()) || PAGE_SIZE); }
    function selectedLoadedIds() { return loadedItems().filter(item => selection.has(item.id)).map(item => item.id); }
    function loadMore() {
        if (!current() || route !== 'list') return;
        const key = windowKey(), count = loadedWindows.get(key) || PAGE_SIZE;
        if (count >= filteredItems().length) return;
        loadedWindows.set(key, count + PAGE_SIZE); renderList();
    }
    function renderList() {
        const items = filteredItems(), count = loadedWindows.get(windowKey()) || PAGE_SIZE;
        const visibleItems = items.slice(0, count);
        if (selection.size) {
            const visibleIds = new Set(visibleItems.map(item => item.id));
            for (const id of selection) if (!visibleIds.has(id)) selection.delete(id);
            if (!selection.size) endSelection();
        }
        const key = JSON.stringify([snapshot?.loaded, snapshot?.fingerprint,
            !snapshot?.loaded && Boolean(snapshot?.error), query, multi]);
        if (key !== listKey) {
            listKey = key;
            list.replaceChildren();
        }
        moreButton.remove();
        const existingCount = list.querySelectorAll('.qm-collection-row').length;
        const rows = visibleItems.slice(existingCount).map(item => {
                const row = make('div', 'qm-collection-row');
                const link = make('button', 'qm-collection-entry'); link.type = 'button';
                link.setAttribute('aria-label', `${multi ? '选择' : '阅读'}收藏：${item.id}`);
                link.dataset.itemId = item.id;
                const name = make('span', 'qm-collection-name', titleFor(item));
                const preview = make('span', 'qm-collection-preview', item.text.replace(/\s+/g, ' '));
                link.append(name, preview);
                const organization = textCollectionItemOrganization(snapshot, item.id);
                if (organization.tags.length) link.append(make('span', 'qm-collection-tags', organization.tags.join(' · ')));
                link.addEventListener('click', () => {
                    if (!current()) return;
                    if (multi) {
                        if (busy()) return;
                        if (selection.has(item.id)) selection.delete(item.id); else selection.add(item.id);
                        if (!selection.size) endSelection();
                        renderList(); updateControls(); return;
                    }
                    // 每次打开都重新排版：当前聊天、楼层与正则可能已经变了。
                    selectedId = item.id; route = 'read'; readScroll = 0; readKey = null; notice = ''; render();
                });
                row.append(link);
                // 行尾删除：直接删，与多选删除一致；多选时不显示。
                if (!multi) {
                    const remove = button('删除收藏', 'trash', () => removeIds([item.id]));
                    remove.classList.add('qm-collection-delete'); remove.setAttribute('aria-label', `删除收藏：${item.id}`);
                    row.append(remove);
                }
                return row;
            });
        list.append(...rows);
        if (!visibleItems.length && !list.children.length) list.append(make('p', 'qm-collection-empty', snapshot?.loaded
            ? query ? '没有找到收藏' : '还没有收藏' : snapshot?.error ? '' : '正在读取…'));
        for (const entry of list.querySelectorAll('.qm-collection-entry')) {
            if (multi) entry.setAttribute('aria-pressed', String(selection.has(entry.dataset.itemId)));
            else entry.removeAttribute('aria-pressed');
            entry.disabled = multi && busy();
        }
        if (visibleItems.length < items.length) list.append(moreButton);
        list.scrollTop = listScroll;
        paintListFloors();
    }
    // 楼层标签：每次绘制都按当前聊天重新核对，换了聊天、楼层被删或来源对不上就不显示。
    let floorFailureLogged = false;
    function floorLookup() {
        if (typeof locateFloor !== 'function' || typeof onJumpFloor !== 'function') return () => null;
        let find;
        try { find = locateFloor(); } catch (error) {
            if (!floorFailureLogged) { floorFailureLogged = true; console.warn('[Qianmu] Collection floor lookup failed', error); }
            return () => null;
        }
        if (typeof find !== 'function') return () => null;
        return source => { const floor = find(source); return Number.isSafeInteger(floor) && floor >= 0 ? floor : null; };
    }
    function paintFloorTag(tag, floor) {
        tag.textContent = `#${floor}`; tag.dataset.floor = String(floor);
        tag.title = `跳到第 ${floor} 层`; tag.setAttribute('aria-label', `跳到第 ${floor} 层`);
    }
    function paintListFloors() {
        const find = floorLookup(), byId = new Map((snapshot?.items || []).map(item => [item.id, item]));
        for (const row of list.querySelectorAll('.qm-collection-row')) {
            const id = row.querySelector('.qm-collection-entry')?.dataset.itemId, item = byId.get(id);
            const floor = multi || !item ? null : find(item.source);
            let tag = row.querySelector('.qm-collection-floor');
            if (floor === null) { tag?.remove(); continue; }
            if (!tag) {
                tag = make('button', 'qm-collection-floor'); tag.type = 'button';
                tag.addEventListener('click', () => { if (current()) jumpToFloor(id); });
                row.insertBefore(tag, row.querySelector('.qm-collection-delete'));
            }
            paintFloorTag(tag, floor);
        }
    }
    function jumpToFloor(id) {
        const item = snapshot?.items.find(entry => entry.id === id), floor = item ? floorLookup()(item.source) : null;
        if (floor === null) { render(); return; }
        close();
        Promise.resolve().then(() => onJumpFloor(floor)).catch(error => console.warn('[Qianmu] Collection floor jump failed', error));
    }
    function render() {
        if (!visible || !current()) return;
        const item = activeItem();
        if (route === 'read' && !item) { route = 'list'; selectedId = null; }
        heading.textContent = route === 'list' ? '正文收藏' : titleFor(route === 'edit' ? draft.item : item);
        dialog.setAttribute('data-view', route);
        listView.hidden = route !== 'list'; reader.hidden = route !== 'read'; editor.hidden = route !== 'edit';
        footer.hidden = route === 'list'; backButton.hidden = route !== 'read'; cancelButton.hidden = route !== 'edit';
        editButton.hidden = route !== 'read'; saveButton.hidden = route !== 'edit';
        copyButton.hidden = organizeButton.hidden = route !== 'read';
        foldersButton.hidden = route !== 'list';
        if (route !== 'list') rulesOpen = false;
        rulesSheet.hidden = !rulesOpen;
        enabledSwitch.hidden = route !== 'list' || typeof enabled?.write !== 'function';
        enabledInput.checked = enabled?.read?.() !== false;
        imageButton.hidden = route !== 'read' || typeof onExportImage !== 'function';
        if (route === 'list') renderList();
        if (route === 'read') {
            const key = JSON.stringify([item.id, item.text, item.raw ?? null]);
            if (key !== readKey) {
                readKey = key;
                // 带原文的条目按楼层的样子显示：ST 格式化结果放进 mes_text 容器，让正则自带的样式照样生效。
                const html = hasRaw(item) ? formatted(item.raw, item) : null;
                if (html !== null) {
                    const body = make('div', 'mes_text qm-collection-raw');
                    body.innerHTML = html;
                    reader.replaceChildren(body);
                } else reader.replaceChildren(...plainParagraphs(item.text));
            }
            reader.scrollTop = readScroll;
        }
        const readFloor = route === 'read' ? floorLookup()(item.source) : null;
        floorButton.hidden = readFloor === null;
        if (readFloor !== null) paintFloorTag(floorButton, readFloor);
        updateControls(); renderStatus();
    }
    async function refresh() {
        if (!current() || busy()) return;
        notice = '';
        try {
            const refreshed = await collection.refresh();
            if (!current()) return;
            endSelection();
            // Reconcile only the captured ID and exact desired text, never a
            // similar-looking entry. An unknown write is not replayed.
            if (draft && refreshed.items.some(item => sameSaved(item, draft))) {
                selectedId = draft.item.id; draft = null; route = 'read';
            }
        } catch { /* The model supplies a sanitized actionable status below. */ }
        render();
    }
    async function save() {
        if (!current() || busy() || !draft) return;
        if (hasRaw(draft)) {
            // 编辑的是原文（与 ST 的楼层编辑一样）；纯文本按格式化结果重新得到。
            draft.raw = editorControl.getText();
            const html = formatted(draft.raw, draft.item);
            draft.text = textCollectionPlainText(html ?? draft.raw);
        } else draft.text = editorControl.getText();
        const edit = draft, saveOpening = opening; pending = true; notice = ''; updateControls();
        try {
            const options = {expectedFingerprint: edit.fingerprint};
            const raw = hasRaw(edit) ? {raw: edit.raw} : {};
            if (edit.isNew) await collection.add({id: edit.item.id, text: edit.text,
                charName: edit.item.charName, userName: edit.item.userName, source: edit.item.source ?? null, ...raw}, options);
            else await collection.edit(edit.item.id, hasRaw(edit) ? {text: edit.text, raw: edit.raw} : edit.text, options);
            if (!current()) return;
            draft = null;
            if (opening === saveOpening) { selectedId = edit.item.id; route = 'read'; readScroll = 0; }
        } catch (error) {
            if (draft === edit) draft.receiptUnknown = collection.state().needsRefresh === true;
            if (current()) notice = snapshot?.needsRefresh || /capacity/.test(snapshot?.error?.code || '') ? ''
                : /conflict|missing/.test(error?.code || '') ? '收藏已有更新，修改已保留。'
                    : /capacity/.test(error?.code || '') ? '收藏超过存储上限，本次未保存，修改已保留。'
                        : '保存未完成，修改已保留。';
        } finally { pending = false; render(); }
    }
    async function removeSelected() {
        if (!current() || busy() || !selection.size) return;
        const ids = selectedLoadedIds();
        if (!ids.length) { endSelection(); render(); return; }
        await removeIds(ids);
    }
    async function removeIds(ids) {
        if (!current() || busy() || !snapshot?.loaded || snapshot.needsRefresh) return;
        pending = true; notice = ''; updateControls();
        try {
            await collection.remove(ids, {expectedFingerprint: snapshot.fingerprint});
            if (!current()) return;
            endSelection();
        } catch { if (current()) notice = '删除未完成，请刷新后重试。'; }
        finally { pending = false; render(); }
    }
    async function open() {
        if (!current()) return false;
        const requestedOpening = ++opening;
        route = 'list'; notice = '';
        if (!visible) {
            returnFocus = doc.activeElement; visible = true; parent.append(dialog);
            dialog.showModal();
            unsubscribe = collection.subscribe(value => {
                snapshot = value;
                // A floor action can reconcile the shared document while this
                // view is closed. Adopt only this draft's exact receipt.
                if (draft?.receiptUnknown && !value.needsRefresh && value.loaded
                    && value.items.some(item => sameSaved(item, draft))) {
                    selectedId = draft.item.id; draft = null;
                    if (route === 'edit') route = 'read';
                }
                // Classification or another item can change while a draft is
                // kept. Accept that document only if this exact base item is
                // untouched; never rebase over a changed/deleted original.
                if (draft && value.loaded && !value.needsRefresh && !['loading', 'refreshing', 'saving'].includes(value.phase)) {
                    const saved = value.items.find(item => item.id === draft.item.id);
                    if (draft.isNew ? !saved : saved && sameTextCollectionItem(saved, draft.item)) draft.fingerprint = value.fingerprint;
                }
                if (value.loaded) {
                    const hadSelection = selection.size > 0;
                    const existing = new Set(value.items.map(item => item.id));
                    for (const id of selection) if (!existing.has(id)) selection.delete(id);
                    if (hadSelection && !selection.size) endSelection();
                }
                render();
            });
        }
        try { await collection.open(); }
        catch { /* Keep the view retryable; never show a read failure as empty. */ }
        if (!current() || !visible || requestedOpening !== opening) return false;
        render(); return visible;
    }
    async function collect(input, selection = {}) {
        const captureCurrent = () => !selection.signal?.aborted && (!selection.isCurrent || selection.isCurrent());
        if (!captureCurrent()) return false;
        const immediate = selection.saveImmediately === true;
        // Selected paragraphs already had their review step in the picker.
        // Prepare the same draft/save path without mounting the library dialog.
        const opened = immediate ? collection.open().then(value => {
            if (!current()) return false;
            snapshot = value; return value.loaded;
        }) : open(), requestedOpening = opening;
        if (!await opened || requestedOpening !== opening || busy() || !snapshot?.loaded) return false;
        if (!captureCurrent()) { if (!immediate) close(); return false; }
        if (draft) {
            if (immediate) await open();
            notice = '还有未保存的编辑，请先继续或取消。'; render(); return immediate;
        }
        if (typeof input?.text !== 'string' || !input.text.trim()
            || typeof input.charName !== 'string' || typeof input.userName !== 'string') return false;
        // The capture keeps its ID through retries, including a lost receipt.
        let source;
        try { source = structuredClone(input.source ?? null); } catch { return false; }
        const raw = typeof input.raw === 'string' && input.raw.trim() ? {raw: input.raw} : {};
        const item = {text: input.text, charName: input.charName, userName: input.userName, source,
            id: crypto.randomUUID(), createdAt: new Date().toISOString(), ...raw};
        selectedId = null;
        draft = {item, text: input.text, ...raw, fingerprint: snapshot.fingerprint, isNew: true};
        startEditor(false);
        if (immediate) {
            await save();
            if (!captureCurrent() || requestedOpening !== opening) return false;
            // Only a failed save exposes the retained draft for retry. Reuse
            // the existing receipt reconciliation, never resubmit on navigation.
            if (draft) { await open(); if (captureCurrent() && draft) startEditor(); }
        }
        return true;
    }
    function close() {
        if (!visible) return;
        visible = false; opening++; unsubscribe?.(); unsubscribe = null;
        endSelection();
        organizeView.close();
        dialog.close(); dialog.remove();
        if (returnFocus?.isConnected) returnFocus.focus({preventScroll: true});
    }
    function dispose() {
        close(); disposed = true; draft = null; snapshot = null; selection.clear();
        organizeView.dispose(); loadedWindows.clear(); list.replaceChildren(); reader.replaceChildren(); editorControl.clear();
    }
    return Object.freeze({open, collect, close, dispose});
}
