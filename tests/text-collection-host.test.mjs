import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createTextCollectionHost} from '../qianmu-text-collection-host.js';
import {createTextCollectionPanel} from '../qianmu-text-collection-panel.js';
import {createTextCollectionCapture} from '../qianmu-text-collection-capture.js';
import {textCollectionDom} from './helpers/text-collection-dom.mjs';
import {QIANMU_HIVE_COMMANDS, upgradeProseHiveCommands} from '../qianmu-hive-commands.js';

const turn = () => new Promise(resolve => setImmediate(resolve));
function fixture(t) {
    const dom = textCollectionDom(), root = dom.parent, window = new EventTarget();
    let live = true, reads = 0, writes = 0, stores = 0, view, context;
    let remote = {exists: false, fingerprint: null, value: null};
    const css = {fontFamily: 'serif', fontSize: '18px', lineHeight: '30px', getPropertyValue: () => ''};
    dom.doc.defaultView.getComputedStyle = () => css;
    const makeContext = () => ({chatId: 'test-chat', characterId: 0, groupId: null,
        characters: [{avatar: 'actor.png', chat: 'test-chat'}], chatMetadata: {integrity: 'chat-integrity'},
        chat: [{mes: '第一段\n\n第二段', is_user: false, send_date: '2026-09-28T00:00:00.000Z'}]});
    context = makeContext();
    function renderFloor() {
        root.replaceChildren();
        const element = dom.doc.createElement('div'); element.className = 'mes'; element.setAttribute('mesid', '0');
        const toolbar = dom.doc.createElement('div'); toolbar.className = 'mes_buttons';
        const prose = dom.doc.createElement('div'); prose.className = 'mes_text'; prose.textContent = context.chat[0].mes;
        prose.cloneNode = () => ({querySelectorAll: () => [], textContent: prose.textContent});
        element.append(toolbar, prose); root.append(element);
    }
    renderFloor();
    const host = createTextCollectionHost({getContext: () => context, names: () => ({charName: '角色', userName: '用户'}),
        document: dom.doc, window, isCurrent: () => live, resolveNamespace: async () => 'st-user:test', headers: () => ({}),
        async storeFactory() {
            stores++; return {
                async read(_slot, {guard}) { reads++; guard(); return structuredClone(remote); },
                async write(_slot, value, {guard, expectedFingerprint}) {
                    writes++; guard(); assert.equal(expectedFingerprint, remote.fingerprint);
                    remote = {exists: true, fingerprint: String(writes).repeat(64), value: structuredClone(value)};
                    return structuredClone(remote);
                }, close() {},
            };
        },
        async viewFactory({collection, isCurrent}) {
            const parent = dom.doc.createElement('section'); dom.doc.body.append(parent);
            parent.style.setProperty = (key, value) => { parent.style[key] = value; };
            parent.style.removeProperty = key => { delete parent.style[key]; };
            const panel = createTextCollectionPanel({parent, collection, isCurrent});
            const capture = createTextCollectionCapture({parent, isCurrent, onSelect: (input, scope) => panel.collect(input, scope)});
            view = {parent, collection, panel, capture, dispose() { capture.dispose(); panel.dispose(); parent.remove(); }};
            return view;
        },
    });
    t.after(() => host.dispose());
    const star = () => root.querySelector('.qm-collection-star');
    const click = () => host.handleClick({target: star(), preventDefault() {}, stopPropagation() {}});
    const action = label => { const node = dom.get(label); assert.ok(node, label); node.click(); };
    return {host, dom, root, window, star, click, action, renderFloor,
        get context() { return context; }, set context(value) { context = value; },
        get view() { return view; }, get reads() { return reads; }, get writes() { return writes; }, get stores() { return stores; },
        inactive() { live = false; },
    };
}

test('floor choice, editor save, confirmed star, read/back/reopen and whole-floor removal share one real session', async t => {
    const f = fixture(t); f.host.refresh(f.root); await turn();
    assert.equal(f.reads, 1); const star = f.star(); assert.equal(f.click(), true);
    await f.dom.wait(() => f.dom.get('全文收藏')); f.action('全文收藏');
    await f.dom.wait(() => f.dom.visible(f.dom.byClass('qm-collection-editor')));
    assert.equal(f.dom.get('保存收藏').disabled, false);
    f.action('保存收藏'); await turn();
    assert.equal(f.view.collection.state().items.length, 1, JSON.stringify({state: f.view.collection.state(), status: f.dom.status()?.textContent}));
    await f.dom.wait(() => star.getAttribute('aria-pressed') === 'true');
    assert.equal(f.writes, 1); assert.equal(f.view.collection.state().items[0].text, '第一段\n\n第二段');
    f.action('返回收藏列表'); f.action('关闭收藏'); await f.host.open();
    assert.equal(f.reads, 1); assert.equal(f.stores, 1); assert.equal(f.star(), star);
    assert.equal(f.view.parent.style['--qm-prose-size'], '18px');
    f.action('关闭收藏'); f.click(); await f.dom.wait(() => star.getAttribute('aria-pressed') === 'false');
    assert.equal(f.writes, 2); assert.equal(f.view.collection.state().items.length, 0);
    assert.equal(f.reads, 1);
});

test('chat switch closes only capture; an existing saved passage remains available without rereading', async t => {
    const f = fixture(t); f.host.refresh(f.root); f.click();
    await f.dom.wait(() => f.dom.get('全文收藏')); f.action('全文收藏');
    await f.dom.wait(() => f.dom.visible(f.dom.byClass('qm-collection-editor'))); f.action('保存收藏');
    await f.dom.wait(() => f.star().getAttribute('aria-pressed') === 'true'); f.action('关闭收藏');
    f.context = {...f.context, chatId: 'different-chat', characters: [{avatar: 'actor.png', chat: 'different-chat'}],
        chat: [{...f.context.chat[0]}], chatMetadata: {integrity: 'different'}};
    f.renderFloor(); f.host.refresh(f.root); assert.equal(f.star().getAttribute('aria-pressed'), 'false');
    await f.host.open(); assert.equal(f.view.collection.state().items.length, 1); assert.equal(f.reads, 1);
});

test('refresh and unrelated clicks do not reread or touch host controls; disabled host adds nothing', async t => {
    const f = fixture(t); const hostControl = f.dom.doc.createElement('button'); f.dom.doc.body.append(hostControl);
    f.host.refresh(f.root); await turn(); const star = f.star(), glyph = star.firstChild;
    for (let n = 0; n < 25; n++) f.host.refresh(f.root);
    await turn(); assert.equal(f.star(), star); assert.equal(star.firstChild, glyph); assert.equal(f.reads, 1);
    assert.equal(f.host.handleClick({target: hostControl}), false); assert.equal(hostControl.isConnected, true);
    f.host.dispose(); assert.equal(f.star(), null); assert.equal(hostControl.isConnected, true);
    f.host.refresh(f.root); assert.equal(f.star(), null);
});

test('pagehide retires the document; an explicit later action can create a fresh owner', async t => {
    const f = fixture(t); f.host.refresh(f.root); await turn();
    f.window.dispatchEvent(new Event('pagehide')); await f.host.open();
    assert.equal(f.stores, 2); assert.equal(f.reads, 2);
});

test('pageshow restores floor actions even when no hive or unrelated host event opens first', async t => {
    const f = fixture(t); f.host.refresh(f.root); await turn();
    f.window.dispatchEvent(new Event('pagehide')); f.window.dispatchEvent(new Event('pageshow')); await turn();
    assert.equal(f.stores, 2); assert.equal(f.reads, 2); assert.equal(f.click(), true);
    await f.dom.wait(() => f.dom.visible(f.dom.get('全文收藏')));
});

test('hive upgrade adds the new command only once and respects a later user removal', () => {
    assert.equal(QIANMU_HIVE_COMMANDS.filter(item => item.id === 'text-collection').length, 1);
    const settings = {proseHiveVersion: 2, quickWheelCustomOrder: ['collections', 'notes'], quickWheelCustomEnabled: ['assistant']};
    upgradeProseHiveCommands(settings);
    assert.deepEqual(settings.quickWheelCustomOrder, ['notes', 'text-collection']);
    assert.deepEqual(settings.quickWheelCustomEnabled, ['assistant', 'text-collection']);
    settings.quickWheelCustomEnabled = []; upgradeProseHiveCommands(settings);
    assert.deepEqual(settings.quickWheelCustomEnabled, []);
});

test('host wiring is before storyboard gating and user-render callback performs no generation', async () => {
    const entry = await readFile(new URL('../index.js', import.meta.url), 'utf8');
    assert.match(entry, /if \(proseFloorTools\.collectionClick\(event\)\) return;/);
    assert.match(entry, /if \(id === 'text-collection'\) return proseFloorTools\.openCollection\(\);/);
    assert.match(entry, /const collectionRenderedHandler = \(\) => proseFloorTools\.refreshCollection\(document\.getElementById\('chat'\)\);/);
    assert.match(entry, /types\.USER_MESSAGE_RENDERED[^\n]+collectionRenderedHandler/);
    assert.match(entry, /mountPortal\(root,\{inheritTheme:true\}\)/);
});
