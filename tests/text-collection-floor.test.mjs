import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createTextCollectionFloor} from '../qianmu-text-collection-floor.js';
import {textCollectionDom} from './helpers/text-collection-dom.mjs';

const turn = () => new Promise(resolve => setImmediate(resolve));
const gate = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return {promise, resolve, reject}; };
const source = (chatId = 'chat-one', messageId = 'message-one') => ({chatId, messageId});

function fixture(t, chat = [{mes: '正文', is_user: false}, {mes: '回复', is_user: false}]) {
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

test('adds one font-independent heart per character floor including prompt-excluded floors, never user floors', t => {
    const f = fixture(t, [{mes: 'AI'}, {mes: 'USER', is_user: true}, {mes: 'hidden character', is_system: true}]);
    const unrelated = f.dom.doc.createElement('button'); unrelated.className = 'host-wallpaper-control'; f.root.appendChild(unrelated);
    f.floor.refresh(f.root);
    const first = f.button(), glyph = first.firstChild;
    assert.equal(f.root.querySelectorAll('.qm-collection-star').length, 2);
    assert.equal(f.button(1), null);
    assert.ok(f.button(2));
    assert.equal(first.getAttribute('aria-pressed'), 'false');
    assert.equal(first.getAttribute('aria-label'), '收藏正文');
    assert.equal(glyph.tagName, 'SVG');
    assert.equal(glyph.className, 'qm-collection-star-glyph');
    assert.equal(glyph.getAttribute('fill'), 'none');
    assert.equal(glyph.getAttribute('stroke'), 'currentColor');
    assert.equal(glyph.getAttribute('stroke-width'), '2.5');
    assert.equal(glyph.firstChild.tagName, 'PATH');
    assert.equal(glyph.firstChild.getAttribute('d'), 'M12 21C10.2 19.4 2 13.7 2 8.4C2 5.3 4.3 3 7.3 3C9.2 3 10.9 4 12 5.6C13.1 4 14.8 3 16.7 3C19.7 3 22 5.3 22 8.4C22 13.7 13.8 19.4 12 21Z');
    assert.equal(glyph.firstChild.hasAttribute('fill'), false, 'the same heart inherits the confirmed SVG fill instead of fixing a filled theme shape');
    assert.equal(glyph.firstChild.hasAttribute('vector-effect'), false);
    assert.equal(glyph.hasAttribute('data-qianmu-icon-skip'), true);
    f.floor.refresh(f.root); f.floor.refresh(f.root);
    assert.equal(f.button(), first); assert.equal(f.button().firstChild, glyph);
    assert.equal(f.iconCalls.length, 2);
    assert.equal(unrelated.parentNode, f.root);
    assert.equal(f.calls.length, 0);
});

test('role changes remove only collection controls and a stale click cannot add or delete user content', t => {
    const chat = [{mes: 'char', is_user: false}], f = fixture(t, chat);
    const native = f.dom.doc.createElement('button'); native.className = 'mes_edit'; f.elements[0].append(native);
    f.floor.refresh(f.root); const old = f.button();
    chat[0].is_user = true;
    assert.equal(f.click(old).handled, true); assert.equal(f.calls.length, 0);
    assert.equal(f.button(), null); assert.equal(native.isConnected, true);
    chat[0].is_user = 'false'; f.floor.refresh(); assert.ok(f.button());
    f.elements[0].setAttribute('is_user', 'true'); f.floor.refresh();
    assert.equal(f.button(), null); assert.equal(f.calls.length, 0);
    f.elements[0].setAttribute('is_user', 'false'); f.floor.refresh(); assert.ok(f.button());
});

test('toolbar fallback and malformed floor IDs never point at another message', t => {
    const f = fixture(t);
    f.elements[0].querySelector('.extraMesButtons').className = 'mes_buttons_inner';
    f.elements[1].querySelector('.extraMesButtons').remove();
    f.appendMessage(''); f.appendMessage('0junk'); f.appendMessage('-1'); f.appendMessage('9007199254740992'); f.appendMessage('9');
    f.floor.refresh(f.root);
    assert.equal(f.root.querySelectorAll('.qm-collection-star').length, 2);
    assert.equal(f.button(0).parentNode.className, 'mes_buttons');
    assert.equal(f.button(1).parentNode.className, 'mes_buttons');
});

test('confirmed same-source entries fill a heart; a click removes all IDs of that floor only', async t => {
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
    assert.equal(f.button().firstChild.getAttribute('fill'), 'none');
    assert.equal(f.button(1).getAttribute('aria-pressed'), 'true');
});

test('classic, Bold and Twotone appearance roots retain the same hollow/filled heart and skip marker', t => {
    const f = fixture(t); f.floor.refresh(f.root);
    const button = f.button(), glyph = button.firstChild, heart = glyph.firstChild;
    const contour = heart.getAttribute('d');
    for (const theme of ['classic', 'editorial', 'glass']) {
        if (theme === 'classic') f.root.removeAttribute('data-qm-theme');
        else f.root.setAttribute('data-qm-theme', theme);
        for (const collected of [true, false]) {
            f.items = collected ? [{id: 'saved', source: source('chat-one', 'message-0')}] : [];
            f.floor.refresh(f.root);
            assert.equal(f.button(), button); assert.equal(button.firstChild, glyph); assert.equal(glyph.firstChild, heart);
            assert.equal(glyph.getAttribute('fill'), collected ? 'currentColor' : 'none');
            assert.equal(button.getAttribute('aria-pressed'), String(collected));
            assert.equal(glyph.getAttribute('stroke-width'), '2.5');
            assert.equal(glyph.hasAttribute('data-qianmu-icon-skip'), true);
            assert.equal(heart.getAttribute('d'), contour);
            assert.equal(glyph.children.length, 1, 'no appearance variant can be inserted into the owned state glyph');
        }
    }
    assert.equal(f.iconCalls.length, 2, 'theme/status changes do not recreate or repass controls to the icon renderer');
    assert.equal(f.calls.length, 0, 'appearance changes never dispatch a collection operation');
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

test('extra tools changing do not rebuild the star; replacement toolbar and removed messages release owned controls', t => {
    const f = fixture(t); f.floor.refresh(f.root); const old = f.button();
    f.elements[0].querySelector('.extraMesButtons').remove(); f.floor.refresh(f.root);
    assert.equal(old.isConnected, true); assert.equal(f.button(), old);
    f.elements[0].querySelector('.mes_buttons').remove();
    const toolbar = f.dom.doc.createElement('div'); toolbar.className = 'mes_buttons'; f.elements[0].appendChild(toolbar);
    f.floor.refresh(f.root);
    assert.equal(old.isConnected, false); assert.notEqual(f.button(), old);
    f.elements[1].remove(); f.floor.refresh(f.root);
    assert.equal(f.elements[1].querySelector('.qm-collection-star'), null);
    f.elements[0].querySelector('.mes_buttons').remove(); f.floor.refresh(f.root);
    assert.equal(f.root.querySelectorAll('.qm-collection-star').length, 0);
});

test('star sits immediately before storyboard, after host edit, regardless of injection order', t => {
    const f = fixture(t), toolbar = f.elements[0].querySelector('.mes_buttons');
    const edit = f.dom.doc.createElement('div'); edit.className = 'mes_edit'; toolbar.append(edit);
    const storyboard = f.dom.doc.createElement('button'); storyboard.className = 'sd-storyboard-message-action';
    f.floor.refresh(f.root); const star = f.button();
    assert.equal(edit.nextSibling, star);
    // The real entry injects collection before storyboard on first render.
    toolbar.append(storyboard); f.floor.refresh(f.root);
    assert.equal(edit.nextSibling, star); assert.equal(star.nextSibling, storyboard);
    const extra = f.dom.doc.createElement('button'); extra.className = 'third-party';
    toolbar.insertBefore(extra, storyboard); f.floor.refresh(f.root);
    assert.equal(extra.nextSibling, star); assert.equal(star.nextSibling, storyboard); assert.equal(f.button(), star);
    // Existing storyboard toolbar is also respected on a cold collection mount.
    const secondToolbar = f.elements[1].querySelector('.mes_buttons');
    const secondStoryboard = f.dom.doc.createElement('button'); secondStoryboard.className = 'sd-storyboard-message-action';
    secondToolbar.insertBefore(secondStoryboard, f.button(1)); f.floor.refresh(f.root);
    assert.equal(f.button(1).nextSibling, secondStoryboard);
    assert.equal(f.iconCalls.length, 2);
});

test('changing prompt exclusion does not remove the star or block add/cancel actions', async t => {
    const message = {mes: '已隐藏的正文', is_user: false, is_system: true}, f = fixture(t, [message]);
    f.floor.refresh(f.root); const star = f.button();
    f.click(); await turn(); assert.equal(f.calls.length, 1); assert.deepEqual(f.calls[0].ids, []);
    f.items = [{id: 'saved', source: source('chat-one', 'message-0')}];
    f.floor.refresh(f.root); assert.equal(star.getAttribute('aria-pressed'), 'true');
    message.is_system = false; f.floor.refresh(f.root); assert.equal(f.button(), star);
    message.is_system = true; f.click(); await turn();
    assert.deepEqual(f.calls[1].ids, ['saved']); assert.equal(f.button(), star);
    assert.equal(message.is_system, true); assert.equal(message.mes, '已隐藏的正文');
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
    const glyphStyle = css.match(/button\.qm-collection-star > \.qm-collection-star-glyph\s*\{([^}]+)\}/)?.[1] || '';
    assert.match(glyphStyle, /width: 1\.1em/); assert.match(glyphStyle, /height: 1\.1em/);
    assert.doesNotMatch(glyphStyle, /vector-effect|overflow/);
    assert.doesNotMatch(css, /#[\da-f]{3,8}\b|\.mes_buttons\s*\{|\.mes\s*\{/i);
});
