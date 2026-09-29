import test from 'node:test';
import assert from 'node:assert/strict';
import {createTextCollectionView} from '../qianmu-text-collection-view.js';
import {createDocumentSession} from '../qianmu-document-session.js';
import {createTextCollection} from '../qianmu-text-collection.js';
import {textCollectionDom} from './helpers/text-collection-dom.mjs';

const turn = () => new Promise(resolve => setImmediate(resolve));
const gate = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return {promise, resolve}; };
const fingerprint = revision => revision.toString(16).padStart(64, '0');
const input = text => ({text, charName: '角色甲', userName: '用户乙', source: {chatId: 'chat-one', messageId: 'message-one'}});

function fixture(t) {
    const dom = textCollectionDom(), controllers = [], created = [], mounts = [], typography = [];
    let live = true, reads = 0, writes = 0, revision = 0, detachCount = 0, readHook, writeHook, receiptHook;
    let remote = {exists: false, fingerprint: null, value: null};
    const store = {
        async read(_slot, options) { reads++; options.guard(); await readHook?.(); options.guard(); return structuredClone(remote); },
        async write(_slot, value, options) {
            writes++; options.guard(); await writeHook?.(); options.guard();
            if (options.expectedFingerprint !== remote.fingerprint) throw Object.assign(Error('conflict'), {code: 'st_account_storage_conflict'});
            remote = {exists: true, fingerprint: fingerprint(++revision), value: structuredClone(value)};
            await receiptHook?.();
            return structuredClone(remote);
        },
    };
    const session = createDocumentSession({store, slot: 'text-collection-view-test', isCurrent: () => live});
    const collection = createTextCollection({session});
    const start = overrides => {
        const controller = new AbortController(); controllers.push(controller);
        const promise = createTextCollectionView({document: dom.doc, collection, isCurrent: () => live, signal: controller.signal,
            mountPortal(parent) { mounts.push(parent); return () => { detachCount++; }; },
            typography(parent) { typography.push(parent); }, ...overrides});
        // Keep rejected setup attempts observed even when a test deliberately
        // emits a stylesheet event before awaiting its rejection assertion.
        promise.then(view => { created.push(view); }, () => {});
        return {promise, controller};
    };
    const links = () => dom.doc.head.children.filter(node => node.tagName === 'LINK');
    async function ready(overrides) { const attempt = start(overrides); for (const link of links()) link.emit('load'); return attempt.promise; }
    t.after(async () => {
        for (const controller of controllers) controller.abort();
        for (const view of created) view.dispose();
        session.dispose(); await turn();
    });
    return {dom, session, collection, start, ready, links, mounts, typography,
        get reads() { return reads; }, get writes() { return writes; }, get detachCount() { return detachCount; },
        get remote() { return structuredClone(remote); }, readHook(fn) { readHook = fn; },
        writeHook(fn) { writeHook = fn; }, receiptHook(fn) { receiptHook = fn; }, deactivate() { live = false; }};
}
function click(f, label) {
    const node = f.dom.get(label); assert.ok(node, `missing ${label}`); assert.ok(f.dom.visible(node), `hidden ${label}`); node.click();
    return node;
}
async function editorReady(f) { await f.dom.wait(() => f.dom.visible(f.dom.get('收藏正文'))); }
async function saved(f, count = 1) { await f.dom.wait(() => f.collection.state().items.length === count && f.collection.state().phase === 'ready'); await turn(); }
const portals = f => f.dom.doc.body.querySelectorAll('.qm-collection-portal');
const listeners = (node, name) => node.listeners.get(name)?.size || 0;

test('the themed portal mounts only after both stylesheets load and remains one across panel reopen', async t => {
    const f = fixture(t), attempt = f.start(), links = f.links();
    assert.equal(links.length, 2); assert.equal(portals(f).length, 0); assert.equal(f.mounts.length, 0);
    assert.equal(new Set(links.map(link => link.href)).size, 2);
    assert.equal(links.every(link => link.rel === 'stylesheet'), true);
    links[0].emit('load'); await turn(); assert.equal(f.mounts.length, 0);
    links[1].emit('load'); const view = await attempt.promise;
    assert.equal(f.mounts.length, 1); assert.equal(f.typography.length, 1); assert.equal(portals(f).length, 1);
    assert.equal(f.mounts[0], view.parent); assert.equal(f.typography[0], view.parent);
    await view.panel.open(); view.panel.close(); await view.panel.open();
    assert.equal(f.reads, 1); assert.equal(f.mounts.length, 1); assert.equal(f.links().length, 2);
    view.dispose(); view.dispose();
    assert.equal(f.detachCount, 1); assert.equal(portals(f).length, 0); assert.equal(f.links().length, 0);
    assert.equal(f.collection.state().loaded, true);
    await f.collection.open(); assert.equal(f.reads, 1);
});

test('full capture through the real panel saves exact text and warm list/read reopen does not reread', async t => {
    const f = fixture(t), view = await f.ready(), raw = '  一段\r\n续句\r\n\r\n\r\n第二段\r\n';
    view.capture.open(input(raw)); click(f, '全文收藏'); await editorReady(f);
    assert.equal(f.dom.byClass('qm-collection-capture'), undefined);
    assert.equal(f.reads, 1); assert.equal(f.writes, 0);
    click(f, '保存收藏'); await saved(f);
    assert.equal(f.remote.value.items[0].text, raw); assert.equal(f.writes, 1);
    assert.deepEqual(f.remote.value.items[0].source, input(raw).source);
    click(f, '返回收藏列表');
    const list = f.dom.byClass('qm-collection-list'), row = list.children[0];
    list.scrollTop = 72; list.emit('scroll');
    click(f, '关闭收藏'); await view.panel.open();
    assert.equal(f.dom.byClass('qm-collection-list').children[0], row); assert.equal(list.scrollTop, 72);
    click(f, `阅读收藏：${f.remote.value.items[0].id}`); click(f, '返回收藏列表');
    assert.equal(f.reads, 1); assert.equal(f.writes, 1); assert.equal(f.mounts.length, 1);
});

test('paragraph capture saves once directly with exact text and never mounts the preview editor', async t => {
    const f = fixture(t), view = await f.ready();
    const raw = '  第一段\r\n续句\r\n \r\n\r\n\t第二段\r\n\r\n第三段';
    view.capture.open(input(raw)); click(f, '选段收藏'); click(f, '选择第 2 段'); click(f, '选择第 1 段');
    click(f, '确认选段'); await saved(f);
    assert.equal(f.remote.value.items[0].text, '  第一段\r\n续句\r\n \r\n\r\n\t第二段');
    assert.equal(f.reads, 1); assert.equal(f.writes, 1);
    assert.equal(f.dom.byClass('qm-collection-panel'), undefined);
    assert.equal(f.dom.byClass('qm-collection-capture'), undefined);
    await view.panel.open();
    assert.equal(f.dom.get('正文收藏').getAttribute('data-view'), 'list');
    assert.ok(f.dom.get(`阅读收藏：${f.remote.value.items[0].id}`));
    assert.equal(f.reads, 1); assert.equal(f.writes, 1);
});

test('direct selection save stays single-flight and a late receipt never opens or closes newer UI', async t => {
    const f = fixture(t), view = await f.ready(), pending = gate(); f.writeHook(() => pending.promise);
    view.capture.open(input('第一段\n\n第二段')); click(f, '选段收藏'); click(f, '选择第 2 段');
    const confirm = click(f, '确认选段'); confirm.click();
    await f.dom.wait(() => f.writes === 1);
    assert.equal(confirm.disabled, true); assert.equal(f.dom.byClass('qm-collection-panel'), undefined);
    view.capture.close(); view.capture.open(input('新楼层'));
    pending.resolve(); await saved(f);
    assert.equal(f.writes, 1); assert.equal(f.remote.value.items[0].text, '第二段');
    assert.equal(f.dom.byClass('qm-collection-panel'), undefined);
    assert.equal(f.dom.byClass('qm-collection-capture').open, true);
    click(f, '选段收藏'); assert.equal(f.dom.get('选择第 1 段').textContent, '新楼层');
});

test('only failed direct saves open the retained draft for an explicit retry', async t => {
    const f = fixture(t), view = await f.ready();
    f.writeHook(() => { throw Object.assign(Error('offline'), {writeState: 'not_started'}); });
    view.capture.open(input('不选\n\n  要保留的选段')); click(f, '选段收藏'); click(f, '选择第 2 段'); click(f, '确认选段');
    await editorReady(f); await turn();
    assert.equal(f.dom.byClass('qm-collection-capture'), undefined);
    assert.equal(f.dom.get('收藏正文').textContent, '  要保留的选段');
    assert.equal(f.collection.state().items.length, 0); assert.equal(f.writes, 1);
    f.writeHook(null); click(f, '保存收藏'); await saved(f);
    assert.equal(f.remote.value.items[0].text, '  要保留的选段');
    assert.equal(f.writes, 2); assert.equal(f.reads, 1);
});

test('a direct save receipt updates the library but cannot navigate a later reopened list', async t => {
    const f = fixture(t), view = await f.ready(), pending = gate(); f.writeHook(() => pending.promise);
    view.capture.open(input('选中内容')); click(f, '选段收藏'); click(f, '选择第 1 段'); click(f, '确认选段');
    await f.dom.wait(() => f.writes === 1); view.capture.close(); await view.panel.open();
    assert.equal(f.dom.get('正文收藏').getAttribute('data-view'), 'list');
    pending.resolve(); await saved(f);
    assert.equal(f.dom.get('正文收藏').getAttribute('data-view'), 'list');
    assert.ok(f.dom.get(`阅读收藏：${f.collection.state().items[0].id}`));
    assert.equal(f.writes, 1); assert.equal(f.reads, 1);
});

test('an unconfirmed direct save uses existing receipt reconciliation without another upload', async t => {
    const f = fixture(t), view = await f.ready();
    f.receiptHook(() => { throw Error('receipt lost'); });
    view.capture.open(input('原段\n\n收藏段')); click(f, '选段收藏'); click(f, '选择第 2 段'); click(f, '确认选段');
    await editorReady(f); await turn();
    assert.equal(f.collection.state().needsRefresh, true); assert.equal(f.writes, 1);
    assert.equal(f.dom.get('保存收藏').disabled, true);
    const originalId = f.remote.value.items[0].id;
    click(f, '核对保存结果'); await saved(f);
    assert.equal(f.collection.state().items[0].id, originalId);
    assert.equal(f.collection.state().items[0].text, '收藏段');
    assert.equal(f.writes, 1); assert.equal(f.reads, 2);
    assert.equal(f.dom.get('正文收藏').getAttribute('data-view'), 'read');
});

test('closing selected paragraphs before a cold read completes prevents the save', async t => {
    const f = fixture(t), view = await f.ready(), pending = gate(); f.readHook(() => pending.promise);
    view.capture.open(input('尚未读取\n\n不得保存')); click(f, '选段收藏'); click(f, '选择第 2 段'); click(f, '确认选段');
    await f.dom.wait(() => f.reads === 1); view.capture.close(); pending.resolve(); await turn();
    assert.equal(f.writes, 0); assert.equal(f.collection.state().items.length, 0);
    assert.equal(f.dom.byClass('qm-collection-panel'), undefined);
    assert.equal(f.dom.byClass('qm-collection-capture'), undefined);
});

test('direct selection cannot overwrite a previously retained editing draft', async t => {
    const f = fixture(t), view = await f.ready();
    await view.panel.collect(input('先前编辑稿')); view.panel.close();
    view.capture.open(input('新的选段')); click(f, '选段收藏'); click(f, '选择第 1 段'); click(f, '确认选段');
    await f.dom.wait(() => f.dom.visible(f.dom.get('继续未保存的编辑'))); await turn();
    assert.equal(f.writes, 0); assert.equal(f.dom.byClass('qm-collection-capture'), undefined);
    click(f, '继续未保存的编辑'); assert.equal(f.dom.get('收藏正文').textContent, '先前编辑稿');
});

test('aborting unfinished style setup settles immediately and removes both links without a portal', async t => {
    const f = fixture(t), attempt = f.start(), links = f.links();
    attempt.controller.abort(); await assert.rejects(attempt.promise, /closed/);
    assert.equal(f.links().length, 0); assert.equal(portals(f).length, 0); assert.equal(f.mounts.length, 0);
    for (const link of links) { assert.equal(listeners(link, 'load'), 0); assert.equal(listeners(link, 'error'), 0); }
    for (const link of links) link.emit('load'); await turn(); assert.equal(f.mounts.length, 0);
    assert.equal(f.reads, 0);
});

test('an already-aborted owner cannot create styles or a portal', async t => {
    const f = fixture(t), stopped = new AbortController(); stopped.abort();
    const attempt = f.start({signal: stopped.signal});
    await assert.rejects(attempt.promise, /no longer current/);
    assert.equal(f.links().length, 0); assert.equal(f.mounts.length, 0);
});

test('partially loaded styles fail cleanly and a fresh explicit setup succeeds without duplicate portal', async t => {
    const f = fixture(t), failed = f.start(), links = f.links();
    links[0].emit('load'); links[1].emit('error');
    await assert.rejects(failed.promise, /样式加载失败/);
    assert.equal(f.links().length, 0); assert.equal(portals(f).length, 0);
    assert.equal(f.mounts.length, 0); assert.equal(f.detachCount, 0);
    const view = await f.ready(); assert.equal(f.mounts.length, 1); assert.equal(f.links().length, 2);
    for (const link of links) link.emit('load'); await turn();
    assert.equal(portals(f).length, 1); assert.equal(f.mounts.length, 1);
    await view.panel.open(); assert.equal(f.reads, 1);
});

test('the first failed stylesheet also releases the other still-waiting stylesheet', async t => {
    const f = fixture(t), attempt = f.start(), links = f.links();
    links[0].emit('error'); await assert.rejects(attempt.promise, /样式加载失败/);
    assert.equal(f.links().length, 0); assert.equal(portals(f).length, 0);
    assert.equal(listeners(links[1], 'load'), 0); assert.equal(listeners(links[1], 'error'), 0);
});

test('an owner changing while styles are loading cannot attach its stale portal', async t => {
    const f = fixture(t), attempt = f.start(), links = f.links();
    links[0].emit('load'); f.deactivate(); links[1].emit('load');
    await assert.rejects(attempt.promise, /no longer current/);
    assert.equal(f.links().length, 0); assert.equal(f.mounts.length, 0); assert.equal(portals(f).length, 0);
});

test('a theme failure after mounting detaches that theme and removes styles and portal', async t => {
    const f = fixture(t), attempt = f.start({typography() { throw Error('typography unavailable'); }});
    for (const link of f.links()) link.emit('load');
    await assert.rejects(attempt.promise, /typography unavailable/);
    assert.equal(f.mounts.length, 1); assert.equal(f.detachCount, 1);
    assert.equal(f.links().length, 0); assert.equal(portals(f).length, 0);
});

test('owner abort disposes open capture, panel and styles without disposing the shared document', async t => {
    const f = fixture(t), attempt = f.start(); for (const link of f.links()) link.emit('load');
    const view = await attempt.promise; await view.panel.open(); view.capture.open(input('一段'));
    attempt.controller.abort();
    assert.equal(portals(f).length, 0); assert.equal(f.links().length, 0);
    assert.equal(f.dom.byClass('qm-collection-panel'), undefined); assert.equal(f.dom.byClass('qm-collection-capture'), undefined);
    assert.equal(f.detachCount, 1); await f.collection.open(); assert.equal(f.reads, 1);
    assert.equal(await view.panel.open(), false); assert.equal(view.capture.open(input('二段')), false);
});

test('closing the capture during an asynchronous panel read prevents a late editor or write', async t => {
    const f = fixture(t), pending = gate(); f.readHook(() => pending.promise);
    const view = await f.ready(); view.capture.open(input('必须取消的原文')); click(f, '全文收藏');
    await f.dom.wait(() => f.reads === 1);
    assert.ok(f.dom.byClass('qm-collection-panel')); view.capture.close(); pending.resolve(); await turn();
    assert.equal(f.dom.byClass('qm-collection-panel'), undefined); assert.equal(f.dom.byClass('qm-collection-capture'), undefined);
    assert.equal(f.writes, 0); assert.equal(f.collection.state().items.length, 0);
    await view.panel.open(); assert.equal(f.dom.visible(f.dom.get('收藏正文')), false); assert.equal(f.reads, 1);
});

test('aborting the whole view during an asynchronous capture read prevents late portal content', async t => {
    const f = fixture(t), pending = gate(); f.readHook(() => pending.promise);
    const attempt = f.start(); for (const link of f.links()) link.emit('load'); const view = await attempt.promise;
    view.capture.open(input('延迟读取')); click(f, '全文收藏'); await f.dom.wait(() => f.reads === 1);
    attempt.controller.abort(); pending.resolve(); await turn();
    assert.equal(portals(f).length, 0); assert.equal(f.dom.byClass('qm-collection-panel'), undefined);
    assert.equal(f.writes, 0); assert.equal(f.detachCount, 1); assert.equal(f.collection.state().items.length, 0);
});

test('a cancelled capture cannot close a newer capture sharing the same pending document read', async t => {
    const f = fixture(t), pending = gate(); f.readHook(() => pending.promise);
    const view = await f.ready(); view.capture.open(input('已取消的前一层')); click(f, '全文收藏');
    await f.dom.wait(() => f.reads === 1); view.capture.close();
    view.capture.open(input('新一层正文')); click(f, '全文收藏');
    pending.resolve(); await turn();
    assert.equal(f.dom.visible(f.dom.get('收藏正文')), true);
    assert.equal(f.dom.get('收藏正文').textContent, '新一层正文');
    assert.equal(f.writes, 0); assert.equal(f.reads, 1);
});

test('a cancelled capture cannot close a newly requested library while their cold read is shared', async t => {
    const f = fixture(t), pending = gate(); f.readHook(() => pending.promise);
    const view = await f.ready(); view.capture.open(input('已取消正文')); click(f, '全文收藏');
    await f.dom.wait(() => f.reads === 1); view.capture.close();
    const reopened = view.panel.open(); pending.resolve();
    assert.equal(await reopened, true); await turn();
    assert.equal(f.dom.visible(f.dom.byClass('qm-collection-list-view')), true);
    assert.equal(f.dom.visible(f.dom.get('收藏正文')), false);
    assert.equal(f.writes, 0); assert.equal(f.reads, 1);
});
