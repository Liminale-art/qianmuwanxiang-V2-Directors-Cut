import { feedbackPlatform, feedbackDiagnostics, feedbackReport } from './qianmu-feedback-report.js?v=1.59.384';

// Opaque account/runtime identities keep drafts separate without inspecting
// settings or persisting private user text into host storage.
const drafts = new WeakMap();

export function mountFeedback(host, { scope, environment = {}, isCurrent = () => true, applyIcons = () => {}, download } = {}) {
    if (!scope || typeof scope !== 'object') throw new TypeError('反馈草稿需要独立的会话范围。');
    const doc = host.ownerDocument;
    let draft = drafts.get(scope);
    if (!draft) { draft = { description: '' }; drafts.set(scope, draft); }
    let live = true, busy = false, revision = 0;
    const current = () => live && host.isConnected && isCurrent();
    const listeners = [];
    const listen = (node, type, fn) => { node.addEventListener(type, fn); listeners.push(() => node.removeEventListener(type, fn)); };
    const make = (tag, text, className) => {
        const node = doc.createElement(tag);
        if (text !== undefined) node.textContent = text;
        if (className) node.className = className;
        return node;
    };
    const form = make('div', undefined, 'sd-feedback-form');
    const field = make('label', undefined, 'sd-feedback-field');
    const description = make('textarea', undefined, 'text_pole');
    description.rows = 6; description.value = draft.description;
    description.placeholder = '例如：打开角色库后一直停在加载中。\n操作：分镜 → 角色库；预期显示档案，实际没有内容。';
    description.setAttribute('aria-label', '问题描述');
    field.append(description);
    // Copy only explicitly whitelisted primitives. Do not spread environment:
    // other fields may contain secrets or getters that must never be touched.
    const diagnostics = {};
    for (const row of feedbackDiagnostics(environment)) diagnostics[row.key] = row.key === 'backendStatus' ? Object.getOwnPropertyDescriptor(environment, row.key).value : row.value;
    Object.assign(diagnostics, feedbackPlatform(doc.defaultView?.navigator?.userAgent));
    const status = make('p', '', 'sd-feedback-status'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
    const actions = make('div', undefined, 'sd-feedback-actions');
    const action = (label, icon) => {
        const button = make('button', undefined, 'sd-btn'); button.type = 'button';
        const symbol = make('i', undefined, `fa-solid ${icon}`); symbol.setAttribute('aria-hidden', 'true');
        button.append(symbol, make('span', label)); actions.append(button); return button;
    };
    const copy = action('复制报告', 'fa-copy'), save = action('保存报告', 'fa-download');
    form.append(field, actions, status);
    host.replaceChildren(form); applyIcons(host);

    function update() {
        revision++;
        status.textContent = '';
        copy.disabled = save.disabled = busy || !draft.description.trim();
    }
    listen(description, 'input', () => {
        if (!current()) return;
        draft.description = description.value; update();
    });
    listen(copy, 'click', async () => {
        if (!current() || copy.disabled) return;
        busy = true; copy.disabled = save.disabled = true;
        const ticket = revision;
        let message;
        try {
            const clipboard = doc.defaultView?.navigator?.clipboard;
            if (typeof clipboard?.writeText !== 'function') throw new Error('unavailable');
            await clipboard.writeText(feedbackReport({ description: draft.description, diagnostics }));
            message = '报告已复制，尚未发送。';
        } catch { message = '复制未成功，请保存报告。'; }
        finally { busy = false; if (current()) { const unchanged = revision === ticket; update(); if (unchanged) status.textContent = message; } }
    });
    listen(save, 'click', () => {
        if (!current() || save.disabled) return;
        try {
            if (typeof download !== 'function') throw new Error('unavailable');
            download(new Blob([feedbackReport({ description: draft.description, diagnostics })], { type: 'text/plain;charset=utf-8' }), 'qianmu-feedback.txt');
            status.textContent = '已发起报告下载，尚未发送。';
        } catch { status.textContent = '未能发起下载，请复制报告。'; }
    });
    update();
    if (draft.focus && current() && (!doc.activeElement || doc.activeElement === doc.body)) {
        description.focus({ preventScroll: true }); description.setSelectionRange(draft.focus.start, draft.focus.end);
    }
    return (discard = false) => {
        if (discard) drafts.delete(scope);
        if (!live) return;
        draft.focus = doc.activeElement === description ? { start: description.selectionStart, end: description.selectionEnd } : null;
        live = false; listeners.splice(0).forEach(remove => remove()); host.replaceChildren();
    };
}
