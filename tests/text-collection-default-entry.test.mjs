import test from 'node:test';
import assert from 'node:assert/strict';
import {createTextCollectionOwner} from '../qianmu-text-collection-owner.js';
import {textCollectionDom} from './helpers/text-collection-dom.mjs';

test('default local chunk loader reaches the shipped view and opens it without an injected viewFactory', async t => {
    const dom = textCollectionDom(); let reads = 0, mounts = 0, closes = 0;
    const owner = createTextCollectionOwner({document: dom.doc, window: new EventTarget(),
        isCurrent: () => true, resolveNamespace: async () => 'st-user:default-entry', headers: () => ({}),
        mountPortal() { mounts++; return () => { closes++; }; },
        storeFactory: async () => ({
            async read() { reads++; return {exists: false, fingerprint: null, value: null}; },
            async write() { throw Error('Entry test must not write'); }, close() {},
        }),
    });
    t.after(() => owner.dispose());
    const opening = owner.open();
    await dom.wait(() => dom.doc.head.querySelectorAll('link').length === 2, 'Default lazy entry did not load');
    dom.doc.head.querySelectorAll('link').forEach(link => link.emit('load'));
    assert.equal(await opening, true); assert.equal(reads, 1); assert.equal(mounts, 1);
    dom.get('关闭收藏').click(); assert.equal(await owner.open(), true);
    assert.equal(reads, 1); assert.equal(mounts, 1);
    owner.dispose(); assert.equal(closes, 1); assert.equal(dom.doc.head.querySelectorAll('link').length, 0);
});

async function imageEntry(t, {beforeEncode} = {}) {
    const dom = textCollectionDom(), downloads = [], draws = [], canvases = [];
    let reads = 0, identities = 0, namespace = 'st-user:default-entry', closed = 0;
    const item = {id: 'one', text: '今夜月色很美。', charName: '角色', userName: '用户',
        createdAt: '2026-09-28T00:00:00.000Z', updatedAt: '2026-09-28T00:00:00.000Z', source: null};
    const createElement = dom.doc.createElement;
    dom.doc.createElement = tag => {
        if (tag !== 'canvas') return createElement(tag);
        const context = {
            measureText(value) { return {width: Array.from(value).length * Number.parseFloat(this.font)}; },
            fillRect() {}, fillText(text) { draws.push(text); },
        };
        const canvas = {width: 0, height: 0, getContext: () => context,
            toBlob(done) { beforeEncode?.(); done(new Blob(['isolated PNG encoding double'], {type: 'image/png'})); }};
        canvases.push(canvas); return canvas;
    };
    dom.doc.defaultView.getComputedStyle = () => ({color: 'rgb(22, 44, 66)', backgroundColor: 'rgba(245, 246, 247, 0.5)', fontFamily: 'serif'});
    // The view, panel, dialog, export engine and loader are all production defaults.
    const owner = createTextCollectionOwner({document: dom.doc, window: new EventTarget(), isCurrent: () => true,
        resolveNamespace: async () => { identities++; return namespace; }, headers: () => ({}),
        download: async (blob, filename) => { downloads.push({blob, filename}); },
        storeFactory: async () => ({
            async read() { reads++; return {exists: true, fingerprint: '1'.repeat(64), value: {version: 1, items: [structuredClone(item)]}}; },
            async write() { throw Error('Reading and image export must never write the library'); }, close() { closed++; },
        }),
    });
    t.after(() => owner.dispose());
    const pending = owner.open();
    await dom.wait(() => dom.doc.head.querySelectorAll('link').length === 2);
    dom.doc.head.querySelectorAll('link').forEach(link => link.emit('load'));
    assert.equal(await pending, true);
    dom.get('阅读收藏：one').click();
    assert.ok(dom.visible(dom.get('收藏存图')));
    dom.get('收藏存图').click();
    assert.equal(dom.byClass('qm-collection-image-dialog').open, true);
    return {dom, owner, item, downloads, draws, canvases, get reads() { return reads; }, get identities() { return identities; },
        get closed() { return closed; }, account(value) { namespace = value; }};
}

test('shipped owner-to-view entry opens the real image dialog and passes account/download wiring', async t => {
    const f = await imageEntry(t), before = f.identities;
    assert.equal(f.dom.get('页眉').value, '角色 & 用户');
    f.dom.get('页眉').value = '自定义页眉'; f.dom.get('页尾').value = '纪念日';
    f.dom.get('下载图片').click();
    await f.dom.wait(() => f.dom.byClass('qm-collection-image-status').textContent.includes('已发起 1 张图片下载'));
    assert.equal(f.identities - before, 2, 'verify the account before encoding and before download');
    assert.equal(f.downloads.length, 1); assert.equal(f.downloads[0].blob.type, 'image/png');
    assert.equal(f.downloads[0].filename, '千幕收藏-001.png');
    assert.deepEqual(f.draws, ['自定义页眉', f.item.text, '纪念日']);
    assert.equal(f.canvases.length, 1); assert.equal(f.canvases[0].width, 0); assert.equal(f.canvases[0].height, 0);
    assert.equal(f.reads, 1, 'image export does not reload the collection');
    f.dom.get('关闭收藏存图').click();
    f.dom.get('返回收藏列表').click(); f.dom.get('关闭收藏').click();
    assert.equal(await f.owner.open(), true); assert.equal(f.reads, 1);
});

test('real default image action refuses an account switch before any canvas or download', async t => {
    const f = await imageEntry(t);
    f.account('st-user:other'); f.dom.get('下载图片').click();
    await f.dom.wait(() => f.owner.state() === null);
    assert.equal(f.downloads.length, 0); assert.equal(f.canvases.length, 0); assert.equal(f.closed, 1);
    assert.equal(f.dom.byClass('qm-collection-image-dialog'), undefined);
});

test('default image entry also rechecks the account after an encoded page, before download', async t => {
    let f;
    f = await imageEntry(t, {beforeEncode: () => f.account('st-user:other')});
    f.dom.get('下载图片').click();
    await f.dom.wait(() => f.owner.state() === null && f.canvases[0]?.width === 0);
    assert.equal(f.downloads.length, 0); assert.equal(f.canvases.length, 1);
    assert.equal(f.reads, 1); assert.equal(f.closed, 1);
    assert.equal(f.dom.byClass('qm-collection-image-dialog'), undefined);
});
