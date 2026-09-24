import { FEEDBACK_CONTACT, FEEDBACK_TEXT_LIMIT, FEEDBACK_MODULES, feedbackPlatform, feedbackDiagnostics, feedbackReport, feedbackMailLink } from './qianmu-feedback-report.js?v=1.59.365';

// Scope is an opaque identity, not a settings source. Weak keys allow old
// accounts/runtime settings to be collected; drafts never go into ST/storage.
const drafts = new WeakMap();

export function mountFeedback(host, { scope, environment = {}, isCurrent = () => true, applyIcons = () => {}, download, contact = FEEDBACK_CONTACT } = {}) {
    if (!scope || typeof scope !== 'object') throw new TypeError('反馈草稿需要独立的会话范围。');
    const doc = host.ownerDocument;
    let draft = drafts.get(scope);
    if (!draft) { draft = { description: '', steps: '', module: '其他', excluded: [] }; drafts.set(scope, draft); }
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
    const hint = make('p', '仅在当前页面整理，不自动发送。不要填写 Key、私有地址或不想分享的正文。', 'sd-muted');
    const field = (label, control) => { const wrapper = make('label', undefined, 'sd-feedback-field'); wrapper.append(make('span', label), control); return wrapper; };
    const module = make('select', undefined, 'text_pole');
    module.setAttribute('aria-label', '反馈功能模块');
    for (const name of FEEDBACK_MODULES) { const option = make('option', name); option.value = name; module.append(option); }
    module.value = draft.module;
    const description = make('textarea', undefined, 'text_pole');
    description.rows = 3; description.value = draft.description; description.maxLength = FEEDBACK_TEXT_LIMIT;
    description.setAttribute('aria-label', '问题描述');
    const steps = make('textarea', undefined, 'text_pole');
    steps.rows = 2; steps.value = draft.steps; steps.maxLength = FEEDBACK_TEXT_LIMIT;
    steps.setAttribute('aria-label', '复现步骤');
    const extra = make('details', undefined, 'sd-feedback-optional');
    extra.open = !!draft.steps; extra.append(make('summary', '复现步骤（选填）'), field('如何遇到这个问题', steps));
    // The host supplies only picked version/status primitives. Platform output
    // contains family names, not the UA, device model, address or local paths.
    const platform = feedbackPlatform(doc.defaultView?.navigator?.userAgent);
    const diagnostics = {};
    for (const row of feedbackDiagnostics(environment)) diagnostics[row.key] = row.key === 'backendStatus' ? Object.getOwnPropertyDescriptor(environment, row.key).value : row.value;
    Object.assign(diagnostics, platform);
    const details = make('details', undefined, 'sd-feedback-optional');
    details.append(make('summary', '附带诊断（可取消）'));
    const rows = feedbackDiagnostics(diagnostics);
    for (const row of rows) {
        const label = make('label', undefined, 'sd-feedback-diagnostic');
        const toggle = make('input'); toggle.type = 'checkbox'; toggle.checked = !draft.excluded.includes(row.key);
        toggle.setAttribute('aria-label', `附带${row.label}`);
        label.append(toggle, make('span', `${row.label}：${row.value}`)); details.append(label);
        listen(toggle, 'change', () => {
            if (!current()) return;
            draft.excluded = toggle.checked ? draft.excluded.filter(key => key !== row.key) : [...new Set([...draft.excluded, row.key])];
            update();
        });
    }
    details.append(make('p', '只包含可识别的版本、状态和系统/浏览器类别；不读取正文、提示词、角色资料或原始日志。未知版本不猜测。', 'sd-muted'));
    const previewSection = make('details', undefined, 'sd-feedback-optional'); previewSection.open = true;
    const preview = make('pre', undefined, 'sd-feedback-preview'); preview.tabIndex = 0; preview.setAttribute('aria-label', '反馈报告完整预览');
    previewSection.append(make('summary', '报告预览'), preview);
    const status = make('p', '', 'sd-feedback-status'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
    const actions = make('div', undefined, 'sd-feedback-actions');
    const action = (label, icon) => {
        const button = make('button', undefined, 'sd-btn'); button.type = 'button';
        const symbol = make('i', undefined, `fa-solid ${icon}`); symbol.setAttribute('aria-hidden', 'true');
        button.append(symbol, make('span', label)); actions.append(button); return button;
    };
    const copy = action('复制报告', 'fa-copy'), save = action('保存报告', 'fa-download');
    const contactPanel = make('div', undefined, 'sd-feedback-contact');
    const mail = feedbackMailLink(contact);
    if (mail) {
        contactPanel.append(make('p', `千幕专用反馈邮箱：${mail.address}`, 'sd-muted'));
        const link = make('a', '打开邮件应用', 'sd-btn'); link.href = mail.href;
        const recipient = make('button', '复制邮箱地址', 'sd-btn'); recipient.type = 'button';
        contactPanel.append(link, recipient);
        listen(link, 'click', event => {
            if (!current()) { event.preventDefault(); return; }
            status.textContent = '已请求打开邮件应用，尚未发送。请粘贴核对后的报告并自行发送。';
        });
        listen(recipient, 'click', () => copyText(mail.address, '邮箱地址已复制。'));
    } else contactPanel.append(make('p', '反馈邮箱尚未配置，当前可复制或保存报告。未提交、未发送。', 'sd-muted'));
    contactPanel.append(make('p', '截图可在邮件中手动添加，请避开私密内容。邮件发送后，收件方可看到你的发件地址。', 'sd-muted'));
    form.append(hint, field('功能模块', module), field('问题描述', description), extra, details, previewSection, actions, status, contactPanel);
    host.replaceChildren(form); applyIcons(host);

    function update() {
        revision++;
        status.textContent = '';
        try {
            preview.textContent = feedbackReport({ ...draft, diagnostics });
            copy.disabled = save.disabled = busy;
        } catch (error) {
            preview.textContent = error.message;
            copy.disabled = save.disabled = true;
        }
    }
    for (const [control, key] of [[description, 'description'], [steps, 'steps'], [module, 'module']]) listen(control, key === 'module' ? 'change' : 'input', () => {
        if (!current()) return;
        draft[key] = control.value; update();
    });
    async function copyText(text, success) {
        if (!current() || busy) return;
        busy = true; copy.disabled = save.disabled = true;
        const ticket = revision;
        let message;
        try {
            const clipboard = doc.defaultView?.navigator?.clipboard;
            if (typeof clipboard?.writeText !== 'function') throw new Error('unavailable');
            await clipboard.writeText(text); message = success;
        } catch { message = '复制未成功，请保存报告，或在预览中手动选择复制。'; }
        finally { busy = false; if (current()) { const unchanged = revision === ticket; update(); if (unchanged) status.textContent = message; } }
    }
    listen(copy, 'click', () => { if (current() && !copy.disabled) return copyText(preview.textContent, '报告已复制，尚未发送。'); });
    listen(save, 'click', () => {
        if (!current() || save.disabled) return;
        try {
            if (typeof download !== 'function') throw new Error('unavailable');
            download(new Blob([preview.textContent], { type: 'text/plain;charset=utf-8' }), 'qianmu-feedback.txt');
            status.textContent = '已发起报告下载，尚未发送。';
        } catch { status.textContent = '未能发起下载，请复制报告。'; }
    });
    update();
    if (draft.focus && current() && (!doc.activeElement || doc.activeElement === doc.body)) {
        const control = draft.focus.key === 'description' ? description : steps;
        control.focus({ preventScroll: true }); control.setSelectionRange(draft.focus.start, draft.focus.end);
    }
    return (discard = false) => {
        if (discard) drafts.delete(scope);
        if (!live) return;
        draft.focus = null;
        for (const [control, key] of [[description, 'description'], [steps, 'steps']]) if (doc.activeElement === control) draft.focus = { key, start: control.selectionStart, end: control.selectionEnd };
        live = false; listeners.splice(0).forEach(remove => remove()); host.replaceChildren();
    };
}
