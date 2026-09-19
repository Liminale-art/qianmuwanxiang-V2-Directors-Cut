import { captureTextCollectionSource, createTextCollection, textCollectionRecord, textCollectionListLabel, textCollectionPreview, textCollectionText } from './qianmu-text-collection.js';
import { notesSyncOperationId } from './qianmu-notes-sync-contract.js';
import { createPlainTextRangeMapper } from './qianmu-plain-text-range.js';

// This chooser deliberately owns only its textarea selection. Opening it is an
// explicit floor-menu action; it never observes or intercepts document selection.
export function openTextCollectionCapture({ parent, source, onSave, isCurrent = () => true } = {}) {
    const document = parent?.ownerDocument, view = document?.defaultView;
    if (!document || !view || !parent.isConnected) throw new TypeError('收藏容器不可用');
    if (typeof onSave !== 'function' || typeof isCurrent !== 'function') throw new TypeError('收藏需要保存与有效性回调');
    const captured = captureTextCollectionSource(source);
    const rangeMapper = createPlainTextRangeMapper(captured.text);
    const dialog = document.createElement('dialog');
    dialog.className = 'qm-text-collection-dialog';
    dialog.setAttribute('aria-label', '收藏正文');
    const controller = new view.AbortController();
    const previouslyFocused = document.activeElement;
    let closed = false, pending = false, mode = null, draft = null, editing = false, start = 0, end = 0, resolve;
    const finished = new Promise(done => { resolve = done; });
    const listeners = [];
    const listen = (target, name, handler) => {
        target.addEventListener(name, handler);
        listeners.push(() => target.removeEventListener(name, handler));
    };
    const element = (tag, text, className) => {
        const node = document.createElement(tag);
        if (text !== undefined) node.textContent = text;
        if (className) node.className = className;
        return node;
    };
    const button = (text, action) => {
        const node = element('button', text);
        node.type = 'button'; node.dataset.collectionAction = action;
        return node;
    };
    const header = element('header'), title = element('strong', '收藏正文'), cancel = button('取消', 'cancel');
    header.append(title, cancel);
    const main = element('main'), choices = element('div', undefined, 'qm-text-collection-choices');
    choices.append(button('选段', 'selection'), button('全文', 'full'));
    const preview = element('div', undefined, 'qm-text-collection-capture');
    const instruction = element('p');
    const textarea = element('textarea');
    textarea.dataset.collectionText = ''; textarea.readOnly = true;
    textarea.setAttribute('aria-label', '正文纯文本'); textarea.spellcheck = false;
    preview.append(instruction, textarea); preview.hidden = true;
    main.append(choices, preview);
    const footer = element('footer'), status = element('p'), actions = element('div', undefined, 'qm-text-collection-actions');
    status.dataset.collectionStatus = ''; status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
    const back = button('返回选择', 'back'), edit = button('编辑收藏', 'edit'), save = button('保存收藏', 'save');
    save.className = 'qm-text-collection-save'; actions.append(back, edit, save); actions.hidden = true;
    footer.append(status, actions); dialog.append(header, main, footer);

    function finish(result) {
        if (closed) return;
        closed = true;
        controller.abort(); observer.disconnect(); listeners.splice(0).forEach(remove => remove());
        if (dialog.open) dialog.close();
        dialog.remove();
        // An abort only stops this chooser waiting. It is not a promise that a
        // persistence adapter has rolled back a write already accepted upstream.
        if (previouslyFocused?.isConnected && document.visibilityState !== 'hidden') previouslyFocused.focus({ preventScroll: true });
        resolve(result);
    }
    const stop = () => finish(null);
    function alive() {
        let current = false;
        try { current = isCurrent() === true; } catch (_) { /* Fail closed on source/account guard errors. */ }
        if (closed) return false;
        if (!current || !parent.isConnected || !dialog.isConnected) { stop(); return false; }
        return true;
    }
    function rangeValid() {
        return mode && Number.isInteger(start) && Number.isInteger(end) && start >= 0 && end <= captured.text.length && end > start && rangeMapper.isBoundary(start) && rangeMapper.isBoundary(end) && captured.text.slice(start, end).trim().length > 0;
    }
    function controls() {
        let valid=true;if(editing)try{textCollectionText(editedValue());}catch{valid=false;}
        save.disabled = pending || !rangeValid() || !valid;
        edit.disabled=pending||Boolean(draft)||!rangeValid();edit.hidden=editing;
        back.disabled = pending || Boolean(draft); textarea.disabled = pending;textarea.readOnly=!editing||Boolean(draft);
        dialog.setAttribute('aria-busy', String(pending));
    }
    function editedValue(){
        const original=captured.text.slice(start,end);
        // Textareas normalize line endings; merely opening the editor is not an edit.
        return textarea.value===original.replace(/\r\n?/g,'\n')?original:textarea.value;
    }
    function captureSelection() {
        if (!alive() || pending || editing || draft || mode !== 'selection') return;
        // Mobile selection handles may collapse after a button takes focus.
        // Only the focused textarea can change the cached range; saving uses
        // that cache after focus leaves it instead of replacing it on blur.
        if (document.activeElement !== textarea) return;
        const nextStart = rangeMapper.toSource(textarea.selectionStart), nextEnd = rangeMapper.toSource(textarea.selectionEnd);
        if (nextStart !== start || nextEnd !== end) {
            start = nextStart; end = nextEnd; draft = null; status.textContent = '';
        }
        controls();
    }
    function choose(nextMode) {
        mode = nextMode; draft = null; editing = false; start = 0; end = mode === 'full' ? captured.text.length : 0;
        back.textContent='返回选择';textarea.setAttribute('aria-label','正文纯文本');
        choices.hidden = true; preview.hidden = false; actions.hidden = false;
        textarea.value = captured.text;
        instruction.textContent = mode === 'full' ? '将保存本层全文；原文保持不变。' : '在下方正文中选择需要收藏的文字。';
        status.textContent = ''; controls();
        textarea.focus({ preventScroll: true }); textarea.setSelectionRange(0, 0);
    }
    async function submit() {
        if (!alive() || pending) return;
        // Refresh before a programmatic/keyboard save only while still focused;
        // pointer activation already captured the range before focus moved.
        captureSelection(); if (!rangeValid()) return;
        try {
            draft ??= createTextCollection({ id: notesSyncOperationId(view.crypto), source: captured, mode, ...(mode === 'selection' ? { start, end } : {}), ...(editing ? {text:editedValue()} : {}), createdAt: Date.now() });
        } catch (_) { status.textContent = '无法创建收藏，请重新选择后重试。'; return; }
        pending = true; controls(); status.textContent = '正在保存…';
        try {
            const acknowledgement = await onSave(draft, { signal: controller.signal });
            if (!alive()) return;
            if (!acknowledgement || acknowledgement.id !== draft.id || !Number.isInteger(acknowledgement.revision) || acknowledgement.revision < 1) {
                throw new Error('Missing persistence acknowledgement');
            }
            status.textContent = '收藏已保存';
            finish({ id: acknowledgement.id, revision: acknowledgement.revision });
        } catch (cause) {
            if (!alive()) return;
            pending = false; controls();
            status.textContent = '未确认保存成功。可重试或取消；重试会沿用本次收藏标识。';
            if (cause?.localSaved === true) status.textContent = '服务器未确认保存成功；本机待存已保留，刷新后仍在此设备。可重试，关闭不会删除待存。';
            if (/^text_collection_sync_[a-z_]+$/.test(cause?.code || '') && typeof cause.message === 'string' && cause.message.length <= 240) status.textContent += ` ${cause.message}`;
            status.textContent+=' 本次稿件已锁定，重试沿用同一内容；仍可复制文字。';
            if (!editing && mode === 'selection') textarea.setSelectionRange(rangeMapper.toDisplay(start), rangeMapper.toDisplay(end));
        }
    }
    listen(dialog, 'click', event => {
        const action = event.target.closest?.('[data-collection-action]')?.dataset.collectionAction;
        if (action === 'cancel') { stop(); return; }
        if (!alive() || pending) return;
        if (action === 'full' || action === 'selection') {if(!draft)choose(action);}
        else if (action === 'save') void submit();
        else if (action === 'edit' && !draft && !editing) {
            captureSelection();if(!rangeValid())return;editing=true;textarea.value=captured.text.slice(start,end);textarea.setAttribute('aria-label','编辑收藏文字');
            instruction.textContent='只修改收藏副本，不改变正文或原选段范围。返回重选会放弃本次修改。';back.textContent='放弃重选';controls();textarea.focus({preventScroll:true});textarea.setSelectionRange(0,0);
        }
        else if (action === 'back' && !draft) {
            mode = null; draft = null; editing = false; start = 0; end = 0;
            choices.hidden = false; preview.hidden = true; actions.hidden = true;
            textarea.value = ''; status.textContent = '';
            choices.querySelector('button').focus({ preventScroll: true });
        }
    });
    // Local events include keyboard selection and mobile selection handles.
    // No preventDefault or propagation suppression is applied to these events.
    for (const name of ['select', 'keyup', 'pointerup', 'touchend']) listen(textarea, name, captureSelection);
    listen(save, 'pointerdown', captureSelection);
    listen(edit, 'pointerdown', captureSelection);
    listen(textarea,'input',()=>{if(alive()&&!pending&&editing&&!draft){status.textContent='';controls();}});
    listen(dialog, 'cancel', event => { event.preventDefault(); stop(); });
    listen(dialog, 'close', stop); listen(view, 'pagehide', stop);
    const observer = new view.MutationObserver(() => { if (!parent.isConnected || !dialog.isConnected) stop(); });
    parent.append(dialog); observer.observe(document.documentElement, { childList: true, subtree: true });
    if (alive()) {
        try { dialog.showModal(); } catch (_) { stop(); }
    }
    return { element: dialog, finished, stop, dispose: stop };
}

// A single bounded page only. Storage, paging and record editing belong to the
// later persistent collection manager, not an in-memory imitation of one.
export function renderTextCollectionRows({ container, records, onOpen } = {}) {
    const document = container?.ownerDocument;
    if (!document || !Array.isArray(records) || records.length > 50 || typeof onOpen !== 'function') throw new TypeError('收藏列表需要有效容器、最多 50 项记录及打开回调');
    const fragment = document.createDocumentFragment(), listeners = [];
    let disposed = false;
    for (const record of records.map(textCollectionRecord)) {
        const row = document.createElement('button'); row.type = 'button';
        row.className = 'qm-text-collection-row'; row.dataset.collectionId = record.id;
        const label = document.createElement('span'), preview = document.createElement('small');
        label.dataset.collectionLabel = ''; preview.dataset.collectionPreview = '';
        label.textContent = textCollectionListLabel(record);
        preview.textContent = textCollectionPreview(record);
        row.title = label.textContent; row.append(label, preview);
        const open = () => { if (!disposed && container.contains(row)) onOpen(record); };
        row.addEventListener('click', open); listeners.push(() => row.removeEventListener('click', open));
        fragment.append(row);
    }
    container.replaceChildren(fragment);
    return () => { disposed = true; listeners.splice(0).forEach(remove => remove()); };
}
