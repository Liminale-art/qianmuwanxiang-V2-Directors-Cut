// Plain-text editing with real paragraphs. The browser owns caret movement,
// Enter/Shift+Enter, undo and IME; typing never rebuilds the editable subtree.
const BLOCKS = new Set(['P', 'DIV', 'LI', 'BLOCKQUOTE', 'PRE', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6']);
const IGNORED = new Set(['SCRIPT', 'STYLE', 'TEMPLATE', 'NOSCRIPT']);
const displayText = text => text.replace(/\r\n?/g, '\n').replace(/\n(?:[\t ]*\n){2,}/g, '\n\n');

function plainText(node) {
    if (IGNORED.has(node.tagName)) return '';
    if (node.nodeType === 3) return node.textContent || '';
    if (node.tagName === 'BR') return '\n';
    const children = Array.from(node.childNodes || []);
    if (!children.length) return node.textContent || '';
    const parts = [];
    let inline = '', hasInline = false;
    const flush = () => {
        if (hasInline) parts.push(inline);
        inline = ''; hasInline = false;
    };
    children.forEach((child, index) => {
        // A final BR is the browser's editable caret placeholder. Shift+Enter
        // at the end has two BRs; retain the first as the actual line break.
        if (BLOCKS.has(node.tagName) && child.tagName === 'BR' && index === children.length - 1) return;
        if (BLOCKS.has(child.tagName)) { flush(); parts.push(plainText(child)); }
        else if (!IGNORED.has(child.tagName)) { hasInline = true; inline += plainText(child); }
    });
    flush();
    return parts.join('\n\n');
}

export function createTextCollectionEditor({document, onChange} = {}) {
    if (!document?.createElement || typeof onChange !== 'function') throw new TypeError('Collection editor requires a document and change callback');
    const element = document.createElement('div');
    element.className = 'qm-collection-editor';
    element.setAttribute('aria-label', '收藏正文');
    element.setAttribute('role', 'textbox');
    element.setAttribute('aria-multiline', 'true');
    element.setAttribute('spellcheck', 'false');
    element.tabIndex = 0;
    let original = '', baseline = '', lastNotified = '', readOnly = null, composing = false;
    let nativePlainText = false;

    function getText() {
        const displayed = plainText(element).replace(/\r\n?/g, '\n');
        return displayed === baseline ? original : displayed;
    }
    function publish() {
        if (readOnly || composing) return;
        const text = getText();
        if (text !== lastNotified) { lastNotified = text; onChange(text); }
    }
    function setText(raw) {
        if (typeof raw !== 'string') throw new TypeError('Collection editor text must be plain text');
        original = lastNotified = raw;
        composing = false;
        const content = displayText(raw).split(/\n[\t ]*\n/).filter(text => text.trim());
        const paragraphs = (content.length ? content : ['']).map(text => {
            const p = document.createElement('p');
            const lines = text.split('\n');
            for (let index = 0; index < lines.length; index++) {
                if (index) p.append(document.createElement('br'));
                // Empty spans distinguish an explicit terminal source newline
                // from the BR placeholder inserted by the browser while typing.
                const span = document.createElement('span'); span.textContent = lines[index]; p.append(span);
            }
            return p;
        });
        element.replaceChildren(...paragraphs);
        baseline = plainText(element);
    }
    function setReadOnly(value) {
        const next = !!value;
        if (readOnly === next) return;
        readOnly = next;
        const mode = readOnly ? 'false' : 'plaintext-only';
        try { element.contentEditable = mode; }
        catch { element.contentEditable = readOnly ? 'false' : 'true'; }
        nativePlainText = !readOnly && element.contentEditable === 'plaintext-only';
        element.setAttribute('contenteditable', readOnly ? 'false' : nativePlainText ? 'plaintext-only' : 'true');
        element.setAttribute('aria-readonly', String(readOnly));
    }
    element.addEventListener('beforeinput', event => {
        if (readOnly || /^format/.test(event.inputType || '')) event.preventDefault();
    });
    element.addEventListener('input', event => { if (!event.isComposing) publish(); });
    element.addEventListener('compositionstart', () => { composing = true; });
    element.addEventListener('compositionend', () => { composing = false; publish(); });
    element.addEventListener('paste', event => {
        if (readOnly) { event.preventDefault(); return; }
        // Modern Chromium's plaintext-only paste preserves native undo and
        // selection while stripping HTML. Do not replace that editing action.
        if (nativePlainText) return;
        event.preventDefault();
        const text = event.clipboardData?.getData('text/plain');
        if (typeof text !== 'string') return;
        // Legacy fallback inserts only text through the native undo stack.
        if (document.execCommand?.('insertText', false, text)) publish();
    });
    element.addEventListener('drop', event => {
        if (readOnly || !nativePlainText || event.dataTransfer?.files?.length) event.preventDefault();
    });
    setReadOnly(false); setText('');
    return Object.freeze({element, setText, getText, setReadOnly, clear: () => setText('')});
}
