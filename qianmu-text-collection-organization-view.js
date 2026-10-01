import {qianmuIconElement} from './qianmu-icon-renderer.js?v=1.59.415';
import {textCollectionItemOrganization} from './qianmu-text-collection-organization.js';

// Classification edits use the same document and explicit save as prose edits.
// This small owned dialog never opens a second library or refreshes storage.
export function createTextCollectionOrganizationView({parent, collection, isCurrent, onComplete} = {}) {
    const doc = parent.ownerDocument;
    const make = (tag, text) => {
        const node = doc.createElement(tag);
        if (text !== undefined) node.textContent = text;
        return node;
    };
    let visible = false, disposed = false, pending = false, generation = 0, returnFocus = null;
    let ids = [], fingerprint = null, folderTouched = false, tagsTouched = false;
    const dialog = make('dialog'); dialog.className = 'qm-collection-organize';
    const header = make('header'), heading = make('h2'), body = make('section'), status = make('p');
    status.className = 'qm-collection-organize-status'; status.setAttribute('role', 'status');
    const button = (label, icon, action) => {
        const node = make('button'); node.type = 'button'; node.title = label; node.setAttribute('aria-label', label);
        const glyph = qianmuIconElement(`qm-regular-${icon}`, {document: doc});
        if (glyph) node.append(glyph);
        node.addEventListener('click', () => { if (!node.disabled && active()) action(); });
        return node;
    };
    const back = button('返回收藏', 'arrow-left', close), dismiss = button('关闭分类编辑', 'x', close);
    header.append(back, heading, dismiss); dialog.append(header, body, status);
    dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
    dialog.addEventListener('close', () => { if (!dialog.open) close(); });
    for (const type of ['keydown', 'keyup', 'keypress', 'beforeinput', 'input', 'change', 'paste', 'cut', 'click']) {
        dialog.addEventListener(type, event => event.stopPropagation());
    }
    function active() {
        if (disposed) return false;
        if (isCurrent() !== true) { dispose(); return false; }
        return visible;
    }
    function busy(value) {
        pending = value; dialog.setAttribute('aria-busy', String(value));
        for (const tag of ['input', 'select', 'textarea', 'button']) {
            for (const control of body.querySelectorAll(tag)) control.disabled = value;
        }
    }
    function begin(title) {
        if (disposed || isCurrent() !== true || pending) return false;
        generation++; returnFocus = doc.activeElement; visible = true;
        heading.textContent = title; dialog.setAttribute('aria-label', title);
        status.textContent = ''; status.hidden = true; body.replaceChildren();
        busy(false);
        if (!dialog.isConnected) parent.append(dialog);
        if (!dialog.open) dialog.showModal();
        return true;
    }
    async function run(action, done) {
        if (!active() || pending) return;
        const request = generation; status.textContent = ''; status.hidden = true; busy(true);
        try {
            await action();
            if (active() && request === generation) { onComplete?.(); done(); }
        } catch {
            if (active() && request === generation) {
                status.textContent = collection.state().needsRefresh
                    ? '保存未完成，请返回列表刷新后重试。' : '未完成，请检查名称后重试。';
                status.hidden = false;
            }
        } finally { if (request === generation) busy(false); }
    }
    function input(label, value = '') {
        const field = make('input'); field.type = 'text'; field.value = value; field.setAttribute('aria-label', label);
        return field;
    }
    function folders() {
        if (!begin('文件夹')) return;
        renderFolders();
    }
    function renderFolders() {
        const state = collection.state(), newRow = make('div'); newRow.className = 'qm-collection-folder-row';
        const name = input('新文件夹名称'); name.placeholder = '新建文件夹'; name.maxLength = 80;
        newRow.append(name, button('新建文件夹', 'plus', () => {
            if (!name.value.trim()) { name.focus(); return; }
            run(() => collection.createFolder(name.value, {expectedFingerprint: collection.state().fingerprint}), renderFolders);
        }));
        body.replaceChildren(newRow);
        for (const folder of state.organization?.folders || []) {
            const row = make('div'); row.className = 'qm-collection-folder-row';
            const field = input(`文件夹名称：${folder.id}`, folder.name); field.maxLength = 80;
            row.append(field,
                button(`保存文件夹：${folder.id}`, 'check', () => {
                    if (!field.value.trim()) { field.focus(); return; }
                    run(() => collection.renameFolder(folder.id, field.value, {expectedFingerprint: state.fingerprint}), renderFolders);
                }),
                button(`删除文件夹：${folder.id}`, 'trash', () =>
                    run(() => collection.removeFolder(folder.id, {expectedFingerprint: state.fingerprint}), renderFolders)));
            body.append(row);
        }
    }
    function organize(itemIds) {
        const state = collection.state();
        const nextIds = [...new Set(itemIds)].filter(id => state.items.some(item => item.id === id));
        if (!nextIds.length || !begin(nextIds.length > 1 ? `整理 ${nextIds.length} 条收藏` : '整理收藏')) return;
        ids = nextIds;
        fingerprint = state.fingerprint; folderTouched = false; tagsTouched = false;
        const values = ids.map(id => textCollectionItemOrganization(state, id));
        const folderLabel = make('label', '文件夹'), folder = make('select'); folder.setAttribute('aria-label', '收藏文件夹');
        const option = (value, label) => { const node = make('option', label); node.value = value; folder.append(node); };
        const sameFolder = values.every(value => value.folderId === values[0].folderId);
        if (!sameFolder) option('mixed', '保持原文件夹');
        option('', '按角色归组');
        for (const entry of state.organization?.folders || []) option(entry.id, entry.name);
        folder.value = sameFolder ? values[0].folderId || '' : 'mixed';
        folder.addEventListener('change', () => { folderTouched = true; }); folderLabel.append(folder);
        const tagLabel = make('label', '标签'), tags = input('收藏标签');
        const sameTags = values.every(value => JSON.stringify(value.tags) === JSON.stringify(values[0].tags));
        tags.value = sameTags ? values[0].tags.join('、') : '';
        tags.placeholder = sameTags ? '用逗号分隔' : '保留原标签；输入后替换';
        tags.addEventListener('input', () => { tagsTouched = true; }); tagLabel.append(tags);
        const footer = make('footer');
        footer.append(button('保存分类', 'check', () => {
            const patch = {};
            if (folderTouched && folder.value !== 'mixed') patch.folderId = folder.value || null;
            if (tagsTouched) patch.tags = [...new Set(tags.value.split(/[,，、;；\n]/).map(tag => tag.trim()).filter(Boolean))];
            if (!Object.keys(patch).length) { onComplete?.(); close(); return; }
            run(() => collection.organize(ids, patch, {expectedFingerprint: fingerprint}), close);
        }));
        body.append(folderLabel, tagLabel, footer);
    }
    function close() {
        if (!visible) return;
        visible = false; generation++; pending = false; dialog.close(); dialog.remove();
        if (returnFocus?.isConnected) returnFocus.focus({preventScroll: true});
    }
    function dispose() { close(); disposed = true; ids = []; body.replaceChildren(); }
    return Object.freeze({folders, organize, close, dispose});
}
