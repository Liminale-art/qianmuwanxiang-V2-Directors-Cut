import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createTextCollectionFloor} from '../qianmu-text-collection-floor.js';
import {LUCIDE_ICON_MARKUP} from '../qianmu-icon-renderer.js';
import {textCollectionDom} from './helpers/text-collection-dom.mjs';

const turn = () => new Promise(resolve => setImmediate(resolve));
const gate = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return {promise, resolve, reject}; };
const source = (chatId = 'chat-one', messageId = 'message-one') => ({chatId, messageId});

function fixture(t, chat = [{mes: '正文', is_user: false}, {mes: '回复', is_user: true}]) {
    const dom = textCollectionDom(), root = dom.parent;
    let items = [], context = {chat}, toggle = async () => {};
    const sources = new Map(chat.map((message, i) => [message, source('chat-one', `message-${i}`)]));
    const errors = [], calls = [], iconCalls = [];
    const floor = createTextCollectionFloor({getContext: () => context, getSourceMap: () => sources, getItems: () => items,
        onToggle: payload => { calls.push(payload); return toggle(payload); }, onError: error => errors.push(error), applyIcons: button => iconCalls.push(button)});
    t.after(() => floor.dispose());
    function appendMessage(index, parent = root, inner = 'extraMesButtons') {
        const element = dom.doc.createElement('div'); element.className = 'mes'; element.setAttribute('mesid', index);
        const toolbar = dom.doc.createElement('div'); toolbar.className = 'mes_buttons';
        if (inner) { const tools = dom.doc.createElement('div'); tools.className = inner; toolbar.appendChild(tools); }
        element.appendChild(toolbar); parent.appendChild(element); return element;
    }
    const elements = chat.map((_, i) => appendMessage(i));
    const button = (index = 0) => elements[index].querySelector('.qm-collection-star');
    const click = (target = button()) => {
        const event = {target, prevented: false, stopped: false, preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; }};
        return {handled: floor.handleClick(event), event};
    };
    return {dom, root, floor, elements, button, click, sources, errors, calls, iconCalls, appendMessage,
        get items() { return items; }, set items(value) { items = value; }, setContext(value) { context = value; }, setToggle(fn) { toggle = fn; }};
}

test('adds one scoped theme-inheriting star per non-system message without rebuilding on refresh', t => {
    const f = fixture(t, [{mes: 'AI'}, {mes: 'USER', is_user: true}, {mes: 'system', is_system: true}]);
    const unrelated = f.dom.doc.createElement('button'); unrelated.className = 'host-wallpaper-control'; f.root.appendChild(unrelated);
    f.floor.refresh(f.root);
    const first = f.button(), glyph = first.firstChild;
    assert.equal(f.root.querySelectorAll('.qm-collection-star').length, 2);
    assert.equal(first.getAttribute('aria-pressed'), 'false');
    assert.equal(first.getAttribute('aria-label'), '收藏正文');
    assert.equal(glyph.innerHTML, LUCIDE_ICON_MARKUP.star);
    assert.equal(glyph.getAttribute('fill'), 'none');
    f.floor.refresh(f.root); f.floor.refresh(f.root);
    assert.equal(f.button(), first); assert.equal(f.button().firstChild, glyph);
    assert.equal(f.iconCalls.length, 2);
    assert.equal(unrelated.parentNode, f.root);
    assert.equal(f.calls.length, 0);
});

test('toolbar fallback and malformed floor IDs never point at another message', t => {
    const f = fixture(t);
    f.elements[0].querySelector('.extraMesButtons').className = 'mes_buttons_inner';
    f.elements[1].querySelector('.extraMesButtons').remove();
    f.appendMessage(''); f.appendMessage('0junk'); f.appendMessage('-1'); f.appendMessage('9007199254740992'); f.appendMessage('9');
    f.floor.refresh(f.root);
    assert.equal(f.root.querySelectorAll('.qm-collection-star').length, 2);
    assert.equal(f.button(0).parentNode.className, 'mes_buttons_inner');
    assert.equal(f.button(1).parentNode.className, 'mes_buttons');
});

test('confirmed same-source entries fill a star; a click removes all IDs of that floor only', async t => {
    const f = fixture(t);
    f.items = [{id: 'a', source: source('chat-one', 'message-0')},
        {id: 'b', source: source('chat-one', 'message-0')}, {id: 'other-chat', source: source('chat-two', 'message-0')},
        {id: 'other-floor', source: source('chat-one', 'message-1')}, {id: 'unlinked', source: null}];
    f.floor.refresh(f.root);
    assert.equal(f.button().getAttribute('aria-pressed'), 'true');
    assert.equal(f.button().firstChild.getAttribute('fill'), 'currentColor');
    assert.equal(f.button().getAttribute('aria-label'), '取消本层收藏');
    f.setToggle(({ids}) => { f.items = f.items.filter(item => !ids.includes(item.id)); });
    const action = f.click(f.button().firstChild);
    assert.deepEqual([action.handled, action.event.prevented, action.event.stopped], [true, true, true]);
    assert.deepEqual(f.calls[0].ids, ['a', 'b']);
    await turn();
    assert.equal(f.button().getAttribute('aria-pressed'), 'false');
    assert.equal(f.button(1).getAttribute('aria-pressed'), 'true');
});

test('pending action disables only that message, suppresses repeats and never optimistically fills', async t => {
    const f = fixture(t), pending = gate(); f.setToggle(() => pending.promise);
    f.floor.refresh(f.root); f.click(); f.click();
    assert.equal(f.calls.length, 1);
    assert.equal(f.button().disabled, true); assert.equal(f.button(1).disabled, false);
    assert.equal(f.button().getAttribute('aria-pressed'), 'false');
    f.floor.refresh(f.root);
    assert.equal(f.button().disabled, true);
    f.items = [{id: 'saved', source: source('chat-one', 'message-0')}]; pending.resolve(); await turn();
    assert.equal(f.button().disabled, false); assert.equal(f.button().getAttribute('aria-pressed'), 'true');
});

test('failed save retains confirmed state and reports its error to the owner', async t => {
    const f = fixture(t), failure = Error('write rejected');
    f.floor.refresh(f.root); f.setToggle(() => { throw failure; }); f.click(); await turn();
    assert.deepEqual(f.errors, [failure]); assert.equal(f.button().disabled, false);
    assert.equal(f.button().getAttribute('aria-pressed'), 'false');
});

test('unlinked messages may add text but never delete another unlinked capture', async t => {
    const f = fixture(t); f.sources.clear(); f.items = [{id: 'no-source', source: null}]; f.floor.refresh(f.root);
    f.click(); await turn();
    assert.equal(f.calls[0].source, null); assert.deepEqual(f.calls[0].ids, []);
    assert.equal(f.button().getAttribute('aria-pressed'), 'false');
});

test('same-floor object replacement discards a stale click instead of acting on the new message', t => {
    const f = fixture(t); f.floor.refresh(f.root); const old = f.button();
    f.setContext({chat: [{mes: 'different'}, {mes: 'other'}]});
    assert.equal(f.click(old).handled, true);
    assert.equal(f.calls.length, 0); assert.notEqual(f.button(), old);
});

test('click uses current confirmed IDs rather than its last painted state', async t => {
    const f = fixture(t); f.floor.refresh(f.root);
    f.items = [{id: 'just-confirmed', source: source('chat-one', 'message-0')}];
    f.click(); await turn(); assert.deepEqual(f.calls[0].ids, ['just-confirmed']);
});

test('unrelated and forged buttons are not claimed', t => {
    const f = fixture(t); f.floor.refresh(f.root);
    for (const className of ['mes_button host-action', 'qm-collection-star']) {
        const other = f.dom.doc.createElement('button'); other.className = className; f.root.appendChild(other);
        const action = f.click(other);
        assert.deepEqual([action.handled, action.event.prevented, action.event.stopped], [false, false, false]);
    }
    assert.equal(f.calls.length, 0);
});

test('replaced or missing toolbar and removed messages release only owned controls', t => {
    const f = fixture(t); f.floor.refresh(f.root); const old = f.button();
    f.elements[0].querySelector('.extraMesButtons').remove(); f.floor.refresh(f.root);
    assert.equal(old.isConnected, false); assert.notEqual(f.button(), old);
    f.elements[1].remove(); f.floor.refresh(f.root);
    assert.equal(f.elements[1].querySelector('.qm-collection-star'), null);
    f.elements[0].querySelector('.mes_buttons').remove(); f.floor.refresh(f.root);
    assert.equal(f.root.querySelectorAll('.qm-collection-star').length, 0);
});

test('root replacement and disposal ignore late operations without mutating the new page', async t => {
    const f = fixture(t), pending = gate(); f.setToggle(() => pending.promise);
    f.floor.refresh(f.root); const oldButton = f.button(); f.click();
    const nextRoot = f.dom.doc.createElement('section'); f.dom.doc.body.appendChild(nextRoot);
    const nextMessage = f.appendMessage(0, nextRoot); f.floor.refresh(nextRoot);
    const nextButton = nextMessage.querySelector('.qm-collection-star');
    assert.equal(oldButton.isConnected, false); assert.equal(nextButton.disabled, false);
    f.items = [{id: 'late', source: source('chat-one', 'message-0')}]; pending.resolve(); await turn();
    assert.equal(nextButton.getAttribute('aria-pressed'), 'false');
    f.floor.dispose(); f.floor.refresh(nextRoot);
    assert.equal(nextMessage.querySelector('.qm-collection-star'), null);
    assert.equal(f.click(nextButton).handled, false);
});

test('failure after disposal is not delivered into a replacement owner', async t => {
    const f = fixture(t), pending = gate(); f.setToggle(() => pending.promise);
    f.floor.refresh(f.root); f.click(); f.floor.dispose(); pending.reject(Error('late')); await turn();
    assert.deepEqual(f.errors, []); assert.equal(f.root.querySelectorAll('.qm-collection-star').length, 0);
});

test('all style selectors stay on the owned star without fixing host colors or toolbar layout', async () => {
    const css = await readFile(new URL('../qianmu-text-collection-floor.css', import.meta.url), 'utf8');
    const selectors = [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{/g)].map(match => match[1].trim());
    assert.ok(selectors.every(selector => selector.startsWith('button.qm-collection-star')));
    assert.match(css, /color: inherit/); assert.match(css, /background: transparent/); assert.match(css, /border: 0/);
    assert.doesNotMatch(css, /#[\da-f]{3,8}\b|\.mes_buttons\s*\{|\.mes\s*\{/i);
});
