import { captureTextCollectionSource, createTextCollection, textCollectionRecord, textCollectionListLabel, textCollectionPreview, textCollectionText } from './qianmu-text-collection.js';
import { notesSyncOperationId } from './qianmu-notes-sync-contract.js';
import { qianmuIconElement } from './qianmu-icon-renderer.js';
import { textCollectionParagraphs, textCollectionParagraphSelection } from './qianmu-text-collection-paragraphs.js';
import { applyCollectionProseStyle, collectionEditorText, collectionEditorValue } from './qianmu-text-collection-presentation.js';

// Paragraph selection is local; account setup may finish later, but is always
// verified before a record is created or written. No document selection hooks.
export function openTextCollectionCapture({ parent, source, sourceElement, resolveSource, onSave, isCurrent = () => true } = {}) {
    const document = parent?.ownerDocument, view = document?.defaultView;
    if (!document || !view || !parent.isConnected) throw new TypeError('收藏容器不可用');
    if (typeof onSave !== 'function' || typeof isCurrent !== 'function') throw new TypeError('收藏需要保存与有效性回调');
    if (resolveSource !== undefined && typeof resolveSource !== 'function') throw new TypeError('收藏来源回调无效');
    const captured = resolveSource ? Object.freeze({ ...source, text: textCollectionText(source?.text) }) : captureTextCollectionSource(source);
    const paragraphs = textCollectionParagraphs(captured.text), selected = new Set();
    const dialog = document.createElement('dialog');
    dialog.className = 'qm-text-collection-dialog qm-text-collection-panel qm-text-collection-capture-dialog qm-text-collection-chooser';
    dialog.setAttribute('aria-label', '收藏正文');
    applyCollectionProseStyle(dialog, sourceElement, parent);
    const controller = new view.AbortController();
    const previouslyFocused = document.activeElement;
    let closed = false, pending = false, mode = null, draft = null, editing = false, selection = null, resolve;
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
    const button = (text, action, icon) => {
        const node = element('button', icon ? undefined : text);
        node.type = 'button'; node.dataset.collectionAction = action;
        node.title = text; node.setAttribute('aria-label', text);
        if (icon) { node.className = 'qm-text-collection-icon'; node.append(qianmuIconElement(`qm-regular-${icon}`, { document })); }
        return node;
    };
    const header = element('header'), title = element('strong', '收藏正文'), cancel = button('取消', 'cancel', 'x');
    const back = button('返回选择', 'back', 'arrow-left'), tools = element('div', undefined, 'qm-text-collection-header-tools');
    back.hidden = true; tools.append(back, cancel); header.append(title, tools);
    const main = element('main'), choices = element('div', undefined, 'qm-text-collection-choices');
    choices.append(button('选段', 'selection'), button('全文', 'full'));
    const preview = element('div', undefined, 'qm-text-collection-capture');
    const instruction = element('p');
    const paragraphList = element('div', undefined, 'qm-text-collection-paragraphs');
    paragraphList.setAttribute('aria-label', '点击选择收藏段落');
    const paragraphButtons = paragraphs.map((paragraph, index) => {
        const node = element('button', paragraph.text, 'qm-text-collection-paragraph');
        node.type = 'button'; node.dataset.collectionParagraph = String(index); node.setAttribute('aria-pressed', 'false'); paragraphList.append(node); return node;
    });
    const textarea = element('textarea');
    textarea.dataset.collectionText = ''; textarea.readOnly = true; textarea.hidden = true;
    textarea.setAttribute('aria-label', '正文纯文本'); textarea.spellcheck = false;
    preview.append(instruction, paragraphList, textarea); preview.hidden = true;
    main.append(choices, preview);
    const footer = element('footer'), status = element('p'), actions = element('div', undefined, 'qm-text-collection-actions qm-text-collection-capture-actions');
    status.dataset.collectionStatus = ''; status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
    const edit = button('编辑收藏', 'edit', 'pencil-simple'), save = button('保存收藏', 'save', 'star');
    save.classList.add('qm-text-collection-save'); actions.append(edit, save); actions.hidden = true;
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
        return mode && selection && selection.text.trim().length > 0;
    }
    function controls() {
        let valid=true;if(editing)try{textCollectionText(editedValue());}catch{valid=false;}
        save.disabled = pending || !rangeValid() || !valid;
        edit.disabled=pending||Boolean(draft)||!rangeValid();edit.hidden=editing;
        back.disabled = pending || Boolean(draft); textarea.disabled = pending;textarea.readOnly=!editing||Boolean(draft);
        paragraphButtons.forEach((node, index) => { node.disabled = pending || Boolean(draft) || mode === 'full'; node.setAttribute('aria-pressed', String(mode === 'selection' && selected.has(index))); });
        dialog.setAttribute('aria-busy', String(pending));
    }
    function editedValue(){
        return collectionEditorValue(selection.text, textarea.value);
    }
    function choose(nextMode) {
        mode = nextMode; draft = null; editing = false; selected.clear(); selection = mode === 'full' ? { start: 0, end: captured.text.length, text: captured.text } : null;
        dialog.classList.remove('qm-text-collection-chooser');
        back.title='返回选择';back.setAttribute('aria-label',back.title);back.hidden=false;textarea.setAttribute('aria-label','正文纯文本');
        choices.hidden = true; preview.hidden = false; actions.hidden = false; paragraphList.hidden = false; textarea.hidden = true;
        instruction.textContent = mode === 'full' ? '' : '点击段落，可多选'; instruction.hidden = mode === 'full';
        status.textContent = ''; controls();
    }
    async function submit() {
        if (!alive() || pending || !rangeValid()) return;
        pending = true; controls(); status.textContent = '正在保存…';
        try {
            if (!draft) {
                const authorized = resolveSource ? await resolveSource({ signal: controller.signal }) : captured;
                if (!alive()) return;
                for (const key of ['text', 'chatId', 'messageId', 'replyId', 'charName', 'userName']) if (authorized?.[key] !== captured[key]) throw Error('收藏来源已变化，请重新打开');
                draft = createTextCollection({ id: notesSyncOperationId(view.crypto), source: authorized, mode,
                    ...(mode === 'selection' ? { start: selection.start, end: selection.end } : {}), text: editing ? editedValue() : selection.text, createdAt: Date.now() });
            }
            const acknowledgement = await onSave(draft, { signal: controller.signal });
            if (!alive()) return;
            if (!acknowledgement || acknowledgement.id !== draft.id || !Number.isInteger(acknowledgement.revision) || acknowledgement.revision < 1) {
                throw new Error('Missing persistence acknowledgement');
            }
            status.textContent = '收藏已保存';
            finish({ id: acknowledgement.id, revision: acknowledgement.revision,
                ...(typeof acknowledgement.expectedAccount === 'string' ? { expectedAccount: acknowledgement.expectedAccount } : {}) });
        } catch (cause) {
            if (!alive()) return;
            pending = false; controls();
            status.textContent = '保存未完成，请重试。';
            if (/^text_collection_sync_[a-z_]+$/.test(cause?.code || '') && typeof cause.message === 'string' && cause.message.length <= 240) status.textContent += ` ${cause.message}`;
            if (draft) status.textContent+=' 当前内容已保留。';
        }
    }
    listen(dialog, 'click', event => {
        const action = event.target.closest?.('[data-collection-action]')?.dataset.collectionAction;
        if (action === 'cancel') { stop(); return; }
        if (!alive() || pending) return;
        const paragraph = event.target.closest?.('[data-collection-paragraph]');
        if (paragraph && mode === 'selection' && !editing && !draft) {
            const index = Number(paragraph.dataset.collectionParagraph);
            if (selected.has(index)) selected.delete(index); else selected.add(index);
            selection = selected.size ? textCollectionParagraphSelection(captured.text, [...selected]) : null;
            status.textContent = ''; controls(); return;
        }
        if (action === 'full' || action === 'selection') {if(!draft)choose(action);}
        else if (action === 'save') void submit();
        else if (action === 'edit' && !draft && !editing) {
            if(!rangeValid())return;editing=true;textarea.value=collectionEditorText(selection.text);textarea.hidden=false;paragraphList.hidden=true;textarea.setAttribute('aria-label','编辑收藏文字');
            dialog.classList.add('is-editing');
            instruction.hidden=true;back.title='放弃修改并返回选择';back.setAttribute('aria-label',back.title);controls();textarea.focus({preventScroll:true});textarea.setSelectionRange(0,0);
        }
        else if (action === 'back' && !draft) {
            mode = null; draft = null; editing = false; selection = null; selected.clear(); back.hidden = true;
            dialog.classList.remove('is-editing');dialog.classList.add('qm-text-collection-chooser');
            choices.hidden = false; preview.hidden = true; actions.hidden = true;
            textarea.value = ''; status.textContent = '';
            choices.querySelector('button').focus({ preventScroll: true });
        }
    });
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
