import {qianmuIconElement} from './qianmu-icon-renderer.js?v=1.59.418';

export const TEXT_COLLECTION_CAPTURE_STYLESHEET = new URL('./qianmu-text-collection-capture.css', import.meta.url);

// Keep offsets into the original text. Displaying or selecting paragraphs must
// not normalize the full-text capture or remove indentation from selected text.
function paragraphRanges(text) {
    const ranges = [];
    const breaks = /(?:\r\n|\r(?!\n)|\n)[\t ]*(?:\r\n|\r(?!\n)|\n)(?:[\t ]*(?:\r\n|\r(?!\n)|\n))*/g;
    let start = 0;
    for (const match of text.matchAll(breaks)) {
        if (text.slice(start, match.index).trim()) ranges.push({start, end: match.index});
        start = match.index + match[0].length;
    }
    if (text.slice(start).trim()) ranges.push({start, end: text.length});
    return ranges;
}

export function createTextCollectionCapture({parent, isCurrent, onSelect} = {}) {
    const doc = parent?.ownerDocument;
    if (!doc || typeof isCurrent !== 'function' || typeof onSelect !== 'function') {
        throw new TypeError('Collection capture requires its owner and selection callback');
    }
    const make = (tag, className, text) => {
        const node = doc.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined) node.textContent = text;
        return node;
    };
    let disposed = false, visible = false, pending = false, generation = 0;
    let input = null, ranges = null, mode = 'choice', controller = null, returnFocus = null;
    const selected = new Set();
    const dialog = make('dialog', 'qm-collection-capture');
    dialog.setAttribute('aria-label', '收藏正文范围');
    const header = make('header'), heading = make('h2', '', '收藏正文');
    const iconButton = (label, icon, action) => {
        const node = make('button'); node.type = 'button';
        node.title = label; node.setAttribute('aria-label', label);
        const glyph = qianmuIconElement(`qm-regular-${icon}`, {document: doc});
        if (glyph) node.append(glyph);
        node.addEventListener('click', () => { if (!node.disabled && current()) action(); });
        return node;
    };
    const backButton = iconButton('返回收藏范围', 'arrow-left', () => {
        if (pending) return;
        mode = 'choice'; status.textContent = ''; render(); partialButton.focus();
    });
    const closeButton = iconButton('关闭收藏范围', 'x', close);
    header.append(backButton, heading, closeButton);
    const choices = make('div', 'qm-collection-capture-choices');
    const partialButton = make('button', '', '选段'), fullButton = make('button', '', '全文');
    partialButton.type = fullButton.type = 'button';
    partialButton.setAttribute('aria-label', '选段收藏'); fullButton.setAttribute('aria-label', '全文收藏');
    partialButton.addEventListener('click', () => {
        if (!current() || pending || !visible) return;
        mode = 'paragraphs'; status.textContent = ''; prepareParagraphs(); render();
        paragraphs.querySelector('button')?.focus();
    });
    fullButton.addEventListener('click', () => { if (current() && !pending && visible) submit(input.text); });
    choices.append(partialButton, fullButton);
    const paragraphs = make('div', 'qm-collection-capture-paragraphs');
    const footer = make('footer'), count = make('span');
    count.setAttribute('aria-live', 'polite');
    const confirmButton = iconButton('确认选段', 'star', () => {
        if (!pending && selected.size) submit(selectedText());
    });
    footer.append(count, confirmButton);
    const status = make('p', 'qm-collection-capture-status'); status.setAttribute('role', 'status');
    dialog.append(header, choices, paragraphs, status, footer);
    dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
    dialog.addEventListener('close', () => { if (!dialog.open) close(); });
    for (const type of ['keydown', 'keyup', 'keypress', 'beforeinput', 'input', 'paste', 'cut']) {
        dialog.addEventListener(type, event => event.stopPropagation());
    }

    function current() {
        if (disposed) return false;
        let valid = false;
        try { valid = isCurrent() === true; } catch { /* A missing owner is not a usable capture. */ }
        if (!valid) dispose();
        return valid;
    }
    function render() {
        if (!visible || !current()) return;
        dialog.setAttribute('data-mode', mode);
        dialog.setAttribute('aria-busy', String(pending));
        heading.textContent = mode === 'paragraphs' ? '选择段落' : '收藏正文';
        choices.hidden = mode !== 'choice';
        paragraphs.hidden = footer.hidden = backButton.hidden = mode !== 'paragraphs';
        partialButton.disabled = fullButton.disabled = backButton.disabled = pending;
        confirmButton.disabled = pending || !selected.size;
        count.textContent = selected.size ? `已选 ${selected.size} 段` : '点击段落选择';
        status.hidden = !status.textContent;
        for (const button of paragraphs.querySelectorAll('button')) button.disabled = pending;
    }
    function prepareParagraphs() {
        if (ranges) return;
        ranges = paragraphRanges(input.text);
        paragraphs.replaceChildren(...ranges.map((range, index) => {
            const node = make('button', 'qm-collection-capture-paragraph', input.text.slice(range.start, range.end));
            node.type = 'button'; node.setAttribute('aria-label', `选择第 ${index + 1} 段`);
            node.setAttribute('aria-pressed', 'false');
            node.addEventListener('click', () => {
                if (!current() || !visible || pending) return;
                if (selected.has(index)) selected.delete(index); else selected.add(index);
                node.setAttribute('aria-pressed', String(selected.has(index)));
                status.textContent = ''; render();
            });
            return node;
        }));
    }
    function selectedText() {
        if (selected.size === ranges.length) return input.text;
        const indexes = [...selected].sort((left, right) => left - right);
        return indexes.map((index, position) => {
            const range = ranges[index], previous = indexes[position - 1];
            const separator = position === 0 ? '' : previous + 1 === index
                ? input.text.slice(ranges[previous].end, range.start) : '\n\n';
            return separator + input.text.slice(range.start, range.end);
        }).join('');
    }
    async function submit(text) {
        if (!visible || !current() || pending || !text.trim()) return;
        pending = true; status.textContent = ''; controller = new AbortController(); render();
        const capturedGeneration = generation, attemptController = controller;
        const active = () => !attemptController.signal.aborted && capturedGeneration === generation && visible && current();
        const payload = structuredClone({...input, text});
        try {
            const accepted = await onSelect(payload, {signal: attemptController.signal, isCurrent: active,
                saveImmediately: mode === 'paragraphs'});
            if (!active()) return;
            if (accepted === true) { close(mode === 'paragraphs'); return; }
            status.textContent = mode === 'paragraphs' ? '收藏未完成，所选段落已保留，请重试。' : '未打开收藏编辑，请重试。';
        } catch {
            if (active()) status.textContent = mode === 'paragraphs' ? '收藏未完成，所选段落已保留，请重试。' : '未打开收藏编辑，请重试。';
        } finally {
            if (capturedGeneration === generation && visible && current()) {
                pending = false; controller = null; render();
            }
        }
    }
    function open(value) {
        if (!current() || pending) return false;
        if (typeof value?.text !== 'string' || !value.text.trim()
            || typeof value.charName !== 'string' || typeof value.userName !== 'string') return false;
        let copy;
        try { copy = structuredClone({text: value.text, charName: value.charName, userName: value.userName, source: value.source ?? null}); }
        catch { return false; }
        if (!visible) returnFocus = doc.activeElement;
        generation++; input = copy; ranges = null; selected.clear(); mode = 'choice';
        status.textContent = ''; paragraphs.replaceChildren(); paragraphs.scrollTop = 0;
        visible = true; parent.append(dialog); render();
        if (!dialog.open) dialog.showModal();
        partialButton.focus(); return true;
    }
    function close(restoreFocus = true) {
        if (!visible) return;
        const ownedFocus = dialog.contains(doc.activeElement);
        visible = false; generation++; controller?.abort(); controller = null; pending = false;
        input = null; ranges = null; selected.clear(); paragraphs.replaceChildren(); status.textContent = '';
        dialog.close(); dialog.remove();
        if (restoreFocus && ownedFocus && returnFocus?.isConnected) returnFocus.focus({preventScroll: true});
        returnFocus = null;
    }
    function dispose() { close(); disposed = true; }
    return Object.freeze({open, close, dispose});
}
