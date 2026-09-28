import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createTextCollectionCapture, TEXT_COLLECTION_CAPTURE_STYLESHEET} from '../qianmu-text-collection-capture.js';
import {textCollectionDom} from './helpers/text-collection-dom.mjs';

const turn = () => new Promise(resolve => setImmediate(resolve));
const gate = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return {promise, resolve}; };
const input = (text = '第一段\n\n第二段\n\n第三段') => ({text, charName: '角色甲', userName: '用户乙', source: {chatId: 'chat-one', messageId: 'message-one'}});

function fixture(t, callback = async () => true) {
    const dom = textCollectionDom(), calls = [];
    let live = true;
    const view = createTextCollectionCapture({parent: dom.parent, isCurrent: () => live, onSelect: async (...args) => {
        calls.push(args); return callback(...args);
    }});
    t.after(() => view.dispose());
    return {dom, view, calls, deactivate() { live = false; }};
}
function click(f, label) {
    const node = f.dom.get(label);
    assert.ok(node, `missing ${label}`); assert.ok(f.dom.visible(node), `hidden ${label}`); node.click();
    return node;
}
const dialog = f => f.dom.byClass('qm-collection-capture');
const paragraphs = f => f.dom.byClass('qm-collection-capture-paragraphs');

test('opens only the compact choice and full-text selection preserves every character', async t => {
    const f = fixture(t), source = input(' \r\n首句\r\n\r\n\r\n  第二段\t \r\n');
    assert.equal(f.view.open(source), true);
    assert.equal(dialog(f).getAttribute('data-mode'), 'choice');
    assert.equal(paragraphs(f).children.length, 0);
    assert.equal(f.dom.visible(paragraphs(f)), false);
    assert.equal(f.dom.visible(f.dom.get('确认选段')), false);
    click(f, '全文收藏'); await turn();
    assert.deepEqual(f.calls[0][0], source);
    assert.equal(dialog(f), undefined);
    assert.equal(TEXT_COLLECTION_CAPTURE_STYLESHEET.pathname.endsWith('/qianmu-text-collection-capture.css'), true);
});

test('paragraph clicks toggle selection and submit in original order rather than click order', async t => {
    const f = fixture(t); f.view.open(input()); click(f, '选段收藏');
    assert.equal(f.dom.get('确认选段').disabled, true);
    click(f, '选择第 3 段'); click(f, '选择第 1 段');
    click(f, '选择第 2 段'); click(f, '选择第 2 段');
    assert.equal(f.dom.get('选择第 2 段').getAttribute('aria-pressed'), 'false');
    click(f, '确认选段'); await turn();
    assert.equal(f.calls.length, 1); assert.equal(f.calls[0][0].text, '第一段\n\n第三段');
});

test('consecutive selected paragraphs preserve separators and indentation without executing markup', async t => {
    const f = fixture(t), raw = '  <img src=x onerror=alert(1)>\r\n续行\r\n \r\n\r\n\t第二段\r\n\r\n第三段';
    f.view.open(input(raw)); click(f, '选段收藏');
    assert.equal(paragraphs(f).children.length, 3);
    assert.equal(f.dom.get('选择第 1 段').textContent, '  <img src=x onerror=alert(1)>\r\n续行');
    assert.equal(f.dom.all().filter(node => node.tagName === 'IMG').length, 0);
    click(f, '选择第 2 段'); click(f, '选择第 1 段'); click(f, '确认选段'); await turn();
    assert.equal(f.calls[0][0].text, '  <img src=x onerror=alert(1)>\r\n续行\r\n \r\n\r\n\t第二段');
});

test('choosing all paragraphs preserves the complete original including outer blank lines', async t => {
    const f = fixture(t), raw = '\r\n\r\n甲\r\n\r\n乙\r\n\r\n';
    f.view.open(input(raw)); click(f, '选段收藏');
    assert.equal(paragraphs(f).children.length, 2);
    click(f, '选择第 2 段'); click(f, '选择第 1 段'); click(f, '确认选段'); await turn();
    assert.equal(f.calls[0][0].text, raw);
});

test('a single CRLF or CR inside a paragraph does not create extra paragraphs', async t => {
    const f = fixture(t), raw = '一行\r\n二行\r三行';
    f.view.open(input(raw)); click(f, '选段收藏');
    assert.equal(paragraphs(f).children.length, 1);
    click(f, '选择第 1 段'); click(f, '确认选段'); await turn();
    assert.equal(f.calls[0][0].text, raw);
});

test('return to choice keeps local selection but full mode never displays selected text', async t => {
    const f = fixture(t); f.view.open(input()); click(f, '选段收藏');
    click(f, '选择第 2 段'); click(f, '返回收藏范围');
    assert.equal(f.dom.visible(paragraphs(f)), false);
    click(f, '选段收藏');
    assert.equal(f.dom.get('选择第 2 段').getAttribute('aria-pressed'), 'true');
    click(f, '返回收藏范围'); click(f, '全文收藏'); await turn();
    assert.equal(f.calls[0][0].text, input().text);
});

test('paragraph return is the first header control before its title', t => {
    const f = fixture(t); f.view.open(input()); click(f, '选段收藏');
    const header = dialog(f).querySelector('header');
    assert.equal(header.children[0], f.dom.get('返回收藏范围'));
    assert.equal(header.children[1].tagName, 'H2');
    assert.equal(header.children.at(-1), f.dom.get('关闭收藏范围'));
});

test('capture CSS uses content height and bounded inner scrolling rather than fixed-inset auto stretch', async () => {
    const css = await readFile(TEXT_COLLECTION_CAPTURE_STYLESHEET, 'utf8');
    const root = css.match(/\.qm-collection-capture\s*\{([^}]+)\}/)?.[1];
    assert.match(root, /height:\s*fit-content;/);
    assert.match(root, /min-height:\s*0;/);
    assert.match(root, /max-height:\s*min\(680px, calc\(100dvh - 40px\)\);/);
    assert.doesNotMatch(root, /height:\s*auto;/);
    assert.match(css, /\.qm-collection-capture-paragraphs\s*\{[^}]*min-height:\s*0;[^}]*overflow:\s*auto;/);
    const paragraph = css.match(/\.qm-collection-capture-paragraph\s*\{([^}]+)\}/)?.[1];
    for (const expected of ['margin: 0 0 .75em;', 'text-align: justify;', 'text-indent: 2em;', 'line-height: 1.55;', 'font-size: var(--qm-prose-size, 1em);']) assert.ok(paragraph.includes(expected));
    const selected = css.match(/\.qm-collection-capture-paragraph\[aria-pressed="true"\]\s*\{([^}]+)\}/)?.[1];
    assert.match(selected, /background:\s*color-mix/);
    assert.match(selected, /box-shadow:\s*none;/);
    assert.doesNotMatch(selected, /inset|border/);
});

test('close and native escape discard selection without handing off or saving', async t => {
    const f = fixture(t), trigger = f.dom.doc.createElement('button'); f.dom.parent.append(trigger); trigger.focus();
    f.view.open(input()); click(f, '选段收藏'); click(f, '选择第 1 段');
    const event = dialog(f).emit('cancel'); await turn();
    assert.equal(event.defaultPrevented, true); assert.equal(f.calls.length, 0);
    assert.equal(dialog(f), undefined); assert.equal(f.dom.doc.activeElement, trigger);
    f.view.open(input()); click(f, '选段收藏');
    assert.equal(f.dom.get('选择第 1 段').getAttribute('aria-pressed'), 'false');
    click(f, '关闭收藏范围'); await turn(); assert.equal(f.calls.length, 0);
});

test('repeated confirmation while a handoff is pending invokes only one callback', async t => {
    const pending = gate(), f = fixture(t, () => pending.promise);
    f.view.open(input()); click(f, '选段收藏'); click(f, '选择第 1 段');
    click(f, '确认选段'); click(f, '确认选段');
    assert.equal(f.calls.length, 1);
    assert.equal(dialog(f).getAttribute('aria-busy'), 'true');
    assert.equal(f.dom.get('选择第 1 段').disabled, true);
    assert.equal(f.view.open(input('不得替换在途内容')), false);
    pending.resolve(true); await turn(); assert.equal(dialog(f), undefined);
});

test('false and rejected callbacks preserve the exact selection for an explicit retry', async t => {
    let attempts = 0;
    const f = fixture(t, () => { attempts++; if (attempts === 1) return false; if (attempts === 2) throw Error('private failure'); return true; });
    f.view.open(input()); click(f, '选段收藏'); click(f, '选择第 2 段');
    for (let i = 0; i < 2; i++) {
        click(f, '确认选段'); await turn();
        assert.equal(f.dom.get('选择第 2 段').getAttribute('aria-pressed'), 'true');
        assert.equal(f.dom.get('确认选段').disabled, false);
        assert.equal(f.dom.status().textContent, '未打开收藏编辑，请重试。');
        assert.equal(f.dom.status().textContent.includes('private'), false);
    }
    click(f, '确认选段'); await turn();
    assert.equal(f.calls.length, 3); assert.equal(f.calls.every(([item]) => item.text === '第二段'), true);
    assert.equal(dialog(f), undefined);
});

test('input and callback mutation cannot change the retained capture', async t => {
    const original = input(), observed = [];
    const f = fixture(t, value => { observed.push(structuredClone(value)); value.text = 'callback overwrite'; value.source.chatId = 'callback overwrite'; return false; });
    f.view.open(original); original.text = 'outside overwrite'; original.source.chatId = 'outside overwrite';
    click(f, '全文收藏'); await turn();
    click(f, '选段收藏');
    assert.equal(f.dom.get('选择第 1 段').textContent, '第一段');
    click(f, '选择第 1 段'); click(f, '确认选段'); await turn();
    assert.equal(observed[0].text, input().text);
    assert.equal(observed[1].text, '第一段');
    assert.equal(observed.every(value => value.source.chatId === 'chat-one'), true);
    assert.equal(f.dom.get('选择第 1 段').textContent, '第一段');
});

test('closing during handoff aborts its guard and late completion cannot close a new capture', async t => {
    const pending = gate(), f = fixture(t, () => pending.promise);
    f.view.open(input()); click(f, '全文收藏');
    const scope = f.calls[0][1]; assert.equal(scope.isCurrent(), true);
    f.view.close(); assert.equal(scope.signal.aborted, true); assert.equal(scope.isCurrent(), false);
    f.view.open(input('新楼层')); pending.resolve(true); await turn();
    assert.equal(dialog(f).open, true); click(f, '选段收藏');
    assert.equal(f.dom.get('选择第 1 段').textContent, '新楼层');
});

test('a queued native close event does not dismiss an immediately reopened dialog', async t => {
    const f = fixture(t); f.view.open(input()); f.view.close(); f.view.open(input('重新打开'));
    await turn(); assert.equal(dialog(f).open, true);
});

test('stale owner prevents handoff and removes private capture content', async t => {
    const f = fixture(t); f.view.open(input()); click(f, '选段收藏');
    f.deactivate(); click(f, '选择第 1 段'); await turn();
    assert.equal(f.calls.length, 0); assert.equal(dialog(f), undefined); assert.equal(f.view.open(input()), false);
});

test('owner becoming stale during handoff rejects its continuation', async t => {
    const pending = gate(), f = fixture(t, () => pending.promise);
    f.view.open(input()); click(f, '全文收藏'); f.deactivate();
    assert.equal(f.calls[0][1].isCurrent(), false);
    pending.resolve(true); await turn();
    assert.equal(dialog(f), undefined); assert.equal(f.calls[0][1].signal.aborted, true);
});

test('successful handoff keeps focus in the new editor instead of returning to the floor', async t => {
    let editor;
    const f = fixture(t, () => { editor = f.dom.doc.createElement('textarea'); f.dom.parent.append(editor); editor.focus(); return true; });
    const trigger = f.dom.doc.createElement('button'); f.dom.parent.append(trigger); trigger.focus();
    f.view.open(input()); click(f, '全文收藏'); await turn();
    assert.equal(f.dom.doc.activeElement, editor);
});

test('keyboard isolation stays within the capture dialog and leaves default actions intact', t => {
    const f = fixture(t); let outside = 0;
    f.dom.parent.addEventListener('keydown', () => outside++);
    f.view.open(input());
    const event = f.dom.get('全文收藏').emit('keydown', {key: 'Tab'});
    assert.equal(event.defaultPrevented, false); assert.equal(outside, 0);
    const external = f.dom.doc.createElement('input'); f.dom.parent.append(external); external.emit('keydown');
    assert.equal(outside, 1);
});

test('invalid and empty captures do not replace a valid open selection; dispose is final', t => {
    const f = fixture(t); assert.equal(f.view.open(input()), true);
    assert.equal(f.view.open(input(' \r\n\t')), false);
    assert.equal(f.view.open({text: 'text'}), false);
    assert.equal(f.view.open({...input(), source: {bad() {}}}), false);
    click(f, '选段收藏'); assert.equal(f.dom.get('选择第 1 段').textContent, '第一段');
    f.view.dispose(); f.view.dispose(); assert.equal(f.view.open(input()), false); assert.equal(f.calls.length, 0);
});

test('long full captures are not truncated or subject to an invented paragraph limit', async t => {
    const f = fixture(t), raw = '完整文本'.repeat(80000) + '\n\n结尾标记';
    f.view.open(input(raw)); click(f, '全文收藏'); await turn();
    assert.equal(f.calls[0][0].text, raw);
});
