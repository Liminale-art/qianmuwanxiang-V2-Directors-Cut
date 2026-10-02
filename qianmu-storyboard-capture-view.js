import {qianmuIconElement} from './qianmu-icon-renderer.js?v=1.59.419';

// Like the collection view: one owned body portal, an inherited Qianmu palette,
// and a native child dialog. No ST Popup, host mutations, storage or generation.
const active = new WeakMap();
export function closeStoryboardCaptureChooser(document = globalThis.document) { active.get(document)?.(); }

export function openStoryboardCaptureChooser({document = globalThis.document, paragraphs, mountPortal, isCurrent, proseElement, signal} = {}) {
    if (!document?.body || !Array.isArray(paragraphs) || paragraphs.some(text => typeof text !== 'string')
        || typeof mountPortal !== 'function' || typeof isCurrent !== 'function') throw new TypeError('Capture chooser requires its owner and paragraphs');
    closeStoryboardCaptureChooser(document);
    if (signal?.aborted || !isCurrent()) return Promise.resolve(null);
    const make = (tag, className, text) => {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined) node.textContent = text;
        return node;
    };
    const parent = make('section', 'qm-storyboard-capture-portal'), dialog = make('dialog', 'qm-storyboard-capture');
    const returnFocus = document.activeElement, window = document.defaultView;
    const heading = make('h2', '', '本层插画'), header = make('header');
    const choices = make('section', 'qm-storyboard-capture-choices');
    const confirmation = make('section', 'qm-storyboard-capture-confirm');
    const list = make('div', 'qm-storyboard-capture-paragraphs sd-scroll');
    const footer = make('footer'), count = make('span', 'qm-storyboard-capture-count');
    const selected = new Set(), rows = [];
    let page = 'choice', lastIndex = -1, scroll = 0, done = false, release;
    dialog.setAttribute('aria-label', '本层插画'); count.setAttribute('aria-live', 'polite');
    list.setAttribute('aria-label', '正文段落');
    let resolveResult, rejectResult;
    const result = new Promise((resolve, reject) => { resolveResult = resolve; rejectResult = reject; });
    function finish(value = null, error) {
        if (done) return;
        const restoreFocus = dialog.contains(document.activeElement);
        done = true; signal?.removeEventListener('abort', cancel); window?.removeEventListener?.('pagehide', cancel);
        if (active.get(document) === cancel) active.delete(document);
        try { if (dialog.open) dialog.close(); } catch (failure) { error ??= failure; }
        try { release?.(); } catch (failure) { error ??= failure; } finally { parent.remove(); }
        if (restoreFocus && returnFocus?.isConnected) returnFocus.focus({preventScroll: true});
        if (error) rejectResult(error); else resolveResult(value);
    }
    function cancel() { finish(); }
    function current() {
        if (done) return false;
        try { if (isCurrent() === true && !signal?.aborted) return true; } catch { /* Retired owner. */ }
        cancel(); return false;
    }
    function button(label, action, icon) {
        const node = make('button'); node.type = 'button'; node.setAttribute('aria-label', label); node.title = label;
        if (icon) {
            const glyph = qianmuIconElement(`qm-regular-${icon}`, {document});
            if (glyph) node.append(glyph);
        } else node.textContent = label;
        node.addEventListener('click', event => { if (!node.disabled && current()) action(event); });
        return node;
    }
    const back = button('返回插画方式', () => {
        if (page === 'paragraphs') scroll = list.scrollTop;
        page = 'choice'; render(); manual.focus();
    }, 'arrow-left');
    const close = button('关闭本层插画', cancel, 'x');
    header.append(back, heading, close);
    function choice(label, description, nextPage) {
        const node = button(label, () => {
            page = nextPage; render();
            if (page === 'paragraphs') { list.scrollTop = scroll; rows[0]?.focus({preventScroll: true}); }
            else confirm.focus();
        });
        node.className = 'qm-storyboard-capture-choice';
        node.replaceChildren(make('b', '', label), make('small', '', description));
        return node;
    }
    const auto = choice('本层重新提取', '重拍整层，完整保存后替换正文插画；旧作保留。', 'auto');
    const manual = choice('手动选段补图', '选择正文段落，只追加一幅插画。', 'paragraphs');
    manual.disabled = !paragraphs.length;
    choices.append(auto, manual);
    confirmation.append(make('p', '', '将重新提取整层并生成新版，可能产生模型与生图费用。新版完整保存后替换正文，旧作仍保留在阅片室。'));
    const confirm = button('继续', () => {
        if (page === 'auto') finish({mode: 'auto', indexes: []});
        else if (page === 'paragraphs' && selected.size) finish({mode: 'manual_supplement', indexes: [...selected].sort((a, b) => a - b)});
    });
    confirm.className = 'qm-storyboard-capture-submit';
    footer.append(count, confirm);
    for (const [index, text] of paragraphs.entries()) {
        const node = button(`选择第 ${index + 1} 段`, event => {
            const checked = !selected.has(index);
            const start = event.shiftKey && lastIndex >= 0 ? Math.min(lastIndex, index) : index;
            const end = event.shiftKey && lastIndex >= 0 ? Math.max(lastIndex, index) : index;
            for (let cursor = start; cursor <= end; cursor++) checked ? selected.add(cursor) : selected.delete(cursor);
            lastIndex = index; render();
        });
        node.className = 'qm-storyboard-capture-paragraph'; node.textContent = text;
        node.setAttribute('aria-pressed', 'false'); rows.push(node); list.append(node);
    }
    function render() {
        dialog.setAttribute('data-page', page);
        heading.textContent = page === 'paragraphs' ? '选择段落' : page === 'auto' ? '本层重新提取' : '本层插画';
        dialog.setAttribute('aria-label', heading.textContent);
        choices.hidden = page !== 'choice'; confirmation.hidden = page !== 'auto'; list.hidden = page !== 'paragraphs';
        footer.hidden = back.hidden = page === 'choice'; count.hidden = page !== 'paragraphs';
        count.textContent = selected.size ? `已选 ${selected.size} 段` : '点击段落选择';
        confirm.disabled = page === 'paragraphs' && !selected.size;
        const label = page === 'auto' ? '继续重新提取' : '继续补图';
        confirm.textContent = label; confirm.setAttribute('aria-label', label); confirm.title = label;
        rows.forEach((node, index) => node.setAttribute('aria-pressed', String(selected.has(index))));
    }
    dialog.append(header, choices, confirmation, list, footer);
    dialog.addEventListener('cancel', event => { event.preventDefault(); cancel(); });
    dialog.addEventListener('close', () => { if (!dialog.open) cancel(); });
    // Keep native Tab/Enter/Space editing behavior; contain only this dialog's events.
    for (const type of ['keydown', 'keyup', 'keypress', 'beforeinput', 'input', 'paste', 'cut']) dialog.addEventListener(type, event => event.stopPropagation());
    try {
        parent.append(dialog); document.body.append(parent); release = mountPortal(parent);
        const style = window?.getComputedStyle?.(proseElement || document.body);
        if (style) for (const [property, value] of [['--qm-prose-font', style.fontFamily], ['--qm-prose-size', style.getPropertyValue('--sd-prose-font-size') || style.fontSize]]) {
            if (value) parent.style.setProperty(property, value);
        }
        active.set(document, cancel); signal?.addEventListener('abort', cancel, {once: true}); window?.addEventListener?.('pagehide', cancel, {once: true});
        render(); dialog.showModal(); (paragraphs.length ? manual : auto).focus();
    } catch (error) { finish(null, error); }
    return result;
}
