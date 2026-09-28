import test from 'node:test';
import assert from 'node:assert/strict';
import {createTextCollectionEditor} from '../qianmu-text-collection-editor.js';
import {textCollectionDom} from './helpers/text-collection-dom.mjs';

// This is a DOM/edit-event contract double, not a browser caret or IME proof.
function fixture(options = {}) {
    const dom = textCollectionDom(), changes = [];
    if (options.legacy) {
        const createElement = dom.doc.createElement;
        dom.doc.createElement = tag => {
            const node = createElement(tag);
            let editable = 'inherit';
            Object.defineProperty(node, 'contentEditable', {get: () => editable, set(value) {
                if (value === 'plaintext-only') throw new SyntaxError('Unsupported token');
                editable = value;
            }});
            return node;
        };
    }
    const editor = createTextCollectionEditor({document: dom.doc, onChange: text => changes.push(text)});
    dom.parent.append(editor.element);
    const span = text => { const node = dom.doc.createElement('span'); node.textContent = text; return node; };
    const br = () => dom.doc.createElement('br');
    const block = (tag, ...nodes) => {
        const node = dom.doc.createElement(tag); node.append(...nodes.map(value => typeof value === 'string' ? span(value) : value)); return node;
    };
    const edit = (...paragraphs) => {
        editor.element.replaceChildren(...paragraphs.map(value => typeof value === 'string' ? block('p', value) : value));
        editor.element.emit('input');
    };
    return {...dom, editor, changes, span, br, block, edit};
}

test('editor is a multiline plaintext-only native editor with real paragraphs', () => {
    const f = fixture(); f.editor.setText('第一段\n\n第二段');
    assert.equal(f.editor.element.tagName, 'DIV');
    assert.equal(f.editor.element.className, 'qm-collection-editor');
    assert.equal(f.editor.element.getAttribute('role'), 'textbox');
    assert.equal(f.editor.element.getAttribute('aria-label'), '收藏正文');
    assert.equal(f.editor.element.getAttribute('aria-multiline'), 'true');
    assert.equal(f.editor.element.getAttribute('contenteditable'), 'plaintext-only');
    assert.deepEqual(f.editor.element.children.map(node => node.tagName), ['P', 'P']);
    assert.deepEqual(f.changes, []);
});

test('leading and trailing empty paragraphs match the reader without rewriting the original', () => {
    const f = fixture(), raw = '\r\n\r\n正文\r\n\r\n'; f.editor.setText(raw);
    assert.deepEqual(f.editor.element.children.map(node => node.textContent), ['正文']);
    assert.equal(f.editor.getText(), raw);
    f.editor.setText(''); assert.equal(f.editor.element.children.length, 1);
    assert.equal(f.editor.getText(), '');
});

test('unchanged read-only mode performs no editing-mode attribute writes during typing', () => {
    const f = fixture(); let writes = 0;
    const originalSet = f.editor.element.setAttribute;
    f.editor.element.setAttribute = function (...args) { writes++; return originalSet.apply(this, args); };
    f.editor.setReadOnly(false); f.editor.setReadOnly(false); assert.equal(writes, 0);
    f.editor.setReadOnly(true); assert.equal(writes, 2);
    f.editor.setReadOnly(true); assert.equal(writes, 2);
    f.editor.setReadOnly(false); assert.equal(writes, 4);
});

test('opening and emitting an unchanged input retain original CRLF, whitespace and extra blank lines', () => {
    const f = fixture(), raw = '\r\n\r\n  第一段\r\n续行\r\n \r\n\r\n\r\n\t第二段\r\n';
    f.editor.setText(raw); f.editor.element.emit('input');
    assert.equal(f.editor.getText(), raw);
    assert.deepEqual(f.changes, []);
    assert.equal(f.editor.element.children.length, 2);
    assert.equal(f.editor.element.children[1].textContent, '\t第二段');
});

test('editing and undoing to the displayed baseline recover the original exact text', () => {
    const f = fixture(), raw = '第一段\r\n\r\n\r\n第二段'; f.editor.setText(raw);
    const first = f.editor.element.children[0], text = first.children[0];
    text.textContent = '第一段改'; f.editor.element.emit('input');
    assert.equal(f.editor.getText(), '第一段改\n\n第二段');
    assert.equal(f.editor.element.children[0], first, 'input never redraws caret-containing nodes');
    text.textContent = '第一段'; f.editor.element.emit('input');
    assert.equal(f.editor.getText(), raw);
    assert.deepEqual(f.changes, ['第一段改\n\n第二段', raw]);
});

test('ordinary Enter becomes a paragraph; Shift+Enter remains a soft line break', () => {
    const f = fixture(); f.editor.setText('第一行第二行');
    f.edit('第一行', '第二行');
    assert.equal(f.editor.getText(), '第一行\n\n第二行');
    f.edit(f.block('p', '第一行', f.br(), '第二行'));
    assert.equal(f.editor.getText(), '第一行\n第二行');
    assert.equal(f.editor.element.emit('beforeinput', {inputType: 'insertParagraph'}).defaultPrevented, false);
    assert.equal(f.editor.element.emit('beforeinput', {inputType: 'insertLineBreak'}).defaultPrevented, false);
});

test('a browser final caret BR is not saved, but a real final Shift+Enter is retained', () => {
    const f = fixture();
    f.edit(f.block('p', '正文', f.br()));
    assert.equal(f.editor.getText(), '正文');
    f.edit(f.block('p', '正文', f.br(), f.br()));
    assert.equal(f.editor.getText(), '正文\n');
    f.edit(f.block('p', '正文'), f.block('p', f.br()));
    assert.equal(f.editor.getText(), '正文\n\n');
    f.edit(f.block('p', f.br()));
    assert.equal(f.editor.getText(), '');
});

test('native div paragraphs and mixed inline roots serialize without HTML', () => {
    const f = fixture();
    f.edit(f.span('第一段'), f.block('div', '第二段', f.br(), '续行'), f.block('p', '第三段'));
    assert.equal(f.editor.getText(), '第一段\n\n第二段\n续行\n\n第三段');
    f.edit(f.block('div', '外层', f.block('div', '嵌套段落')));
    assert.equal(f.editor.getText(), '外层\n\n嵌套段落');
    f.edit(f.block('p', f.block('span', '行一', f.br()), f.span('行二')));
    assert.equal(f.editor.getText(), '行一\n行二', 'a BR inside an inline span is content, not a block caret placeholder');
});

test('HTML-like source is literal text, never interpolated or rendered as markup', () => {
    const f = fixture(), raw = '<img src=x onerror=bad()>\n\n<script>private()</script>';
    f.editor.setText(raw);
    assert.equal(f.editor.getText(), raw);
    assert.equal(f.all().some(node => ['IMG', 'SCRIPT'].includes(node.tagName)), false);
    f.edit(f.block('p', '<b>同样是纯文</b>'));
    assert.equal(f.editor.getText(), '<b>同样是纯文</b>');
});

test('composition is not redrawn or published halfway; final input is deduplicated', () => {
    const f = fixture(); f.editor.setText('你好');
    const text = f.editor.element.children[0].children[0];
    f.editor.element.emit('compositionstart');
    text.textContent = '你好shi'; f.editor.element.emit('input', {isComposing: true});
    assert.deepEqual(f.changes, []);
    text.textContent = '你好世界'; f.editor.element.emit('input', {isComposing: true});
    assert.equal(f.editor.getText(), '你好世界');
    f.editor.element.emit('compositionend'); f.editor.element.emit('input', {isComposing: false});
    assert.deepEqual(f.changes, ['你好世界']);
    assert.equal(f.editor.element.children[0].children[0], text);
});

test('native plaintext-only paste owns the undo stack; no custom HTML insertion occurs', () => {
    const f = fixture(); f.editor.setText('开头');
    let commands = 0; f.doc.execCommand = () => commands++;
    const event = f.editor.element.emit('paste', {clipboardData: {getData() { throw Error('Native plaintext-only paste does not need custom clipboard reads'); }}});
    assert.equal(event.defaultPrevented, false); assert.equal(commands, 0);
    // Simulate the plain DOM result of the browser's default paste action.
    f.edit('开头<p>文字不是HTML</p>', '第二段');
    assert.equal(f.editor.getText(), '开头<p>文字不是HTML</p>\n\n第二段');
});

test('legacy paste strips HTML and inserts only text through the native undo command', () => {
    const f = fixture({legacy: true}), calls = [];
    f.editor.setText('原文');
    f.doc.execCommand = (command, ui, value) => {
        calls.push([command, ui, value]); f.editor.element.replaceChildren(f.block('p', value)); return true;
    };
    const types = [];
    const event = f.editor.element.emit('paste', {clipboardData: {getData(type) { types.push(type); return '<b>纯文</b>'; }}});
    assert.equal(event.defaultPrevented, true);
    assert.deepEqual(types, ['text/plain']);
    assert.deepEqual(calls, [['insertText', false, '<b>纯文</b>']]);
    assert.equal(f.editor.getText(), '<b>纯文</b>');
    assert.deepEqual(f.changes, ['<b>纯文</b>']);
});

test('unsupported legacy paste cannot inject HTML when native insertion is unavailable', () => {
    const f = fixture({legacy: true}); f.editor.setText('原文');
    assert.equal(f.editor.element.emit('paste', {clipboardData: {getData: () => '<img src=x>'}}).defaultPrevented, true);
    assert.equal(f.editor.getText(), '原文'); assert.deepEqual(f.changes, []);
});

test('read-only blocks native mutation and paste; enabling restores plaintext-only', () => {
    const f = fixture(); f.editor.setText('保持正文'); f.editor.setReadOnly(true);
    assert.equal(f.editor.element.getAttribute('contenteditable'), 'false');
    assert.equal(f.editor.element.getAttribute('aria-readonly'), 'true');
    assert.equal(f.editor.element.emit('beforeinput', {inputType: 'insertText'}).defaultPrevented, true);
    assert.equal(f.editor.element.emit('paste').defaultPrevented, true);
    assert.equal(f.editor.element.emit('drop').defaultPrevented, true);
    f.editor.element.emit('input'); assert.deepEqual(f.changes, []);
    f.editor.setReadOnly(false);
    assert.equal(f.editor.element.getAttribute('contenteditable'), 'plaintext-only');
    assert.equal(f.editor.element.emit('beforeinput', {inputType: 'insertText'}).defaultPrevented, false);
});

test('formatting commands and file drops are blocked without blocking ordinary text input', () => {
    const f = fixture();
    assert.equal(f.editor.element.emit('beforeinput', {inputType: 'formatBold'}).defaultPrevented, true);
    assert.equal(f.editor.element.emit('beforeinput', {inputType: 'insertText'}).defaultPrevented, false);
    assert.equal(f.editor.element.emit('drop', {dataTransfer: {files: ['image.png']}}).defaultPrevented, true);
    assert.equal(f.editor.element.emit('drop', {dataTransfer: {files: []}}).defaultPrevented, false);
});

test('clear removes previous private content and resets the original baseline without callback', () => {
    const f = fixture(); f.editor.setText('私有正文'); f.editor.clear();
    assert.equal(f.editor.getText(), ''); assert.equal(f.editor.element.textContent, '');
    assert.deepEqual(f.changes, []);
    f.editor.setText('新正文'); assert.equal(f.editor.getText(), '新正文');
    assert.throws(() => f.editor.setText({text: 'bad'}), TypeError);
    assert.equal(f.editor.getText(), '新正文');
});

test('full large text and all paragraphs are retained without a local editor length limit', () => {
    const f = fixture(), raw = Array.from({length: 1200}, (_, index) => `第${index}段${'正文'.repeat(50)}`).join('\r\n\r\n');
    f.editor.setText(raw);
    assert.equal(f.editor.element.children.length, 1200);
    assert.equal(f.editor.getText(), raw);
    assert.deepEqual(f.changes, []);
});
