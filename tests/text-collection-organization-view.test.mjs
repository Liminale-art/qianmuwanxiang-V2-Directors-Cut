import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {createDocumentSession} from '../qianmu-document-session.js';
import {createTextCollection, documentFromTextCollectionState} from '../qianmu-text-collection.js';
import {createTextCollectionOrganizationView} from '../qianmu-text-collection-organization-view.js';
import {createTextCollectionBackup, readTextCollectionBackup} from '../qianmu-text-collection-backup.js';
import {textCollectionDom} from './helpers/text-collection-dom.mjs';

const stamp = '2026-09-28T00:00:00.000Z';
const row = (id, text = ' 原文\r\n\r\n\r\n末尾 ') => ({id, text, charName: '角色', userName: 'USER', createdAt: stamp, updatedAt: stamp, source: null});
const document = () => ({version: 2, items: [row('one'), row('two')], organization: {
    folders: [{id: 'first', name: '旅程'}, {id: 'second', name: '纪念'}],
    entries: [{itemId: 'one', folderId: 'first', tags: ['甲']}, {itemId: 'two', folderId: 'second', tags: ['乙']}],
}});
const receipt = value => ({exists: true, value: structuredClone(value), fingerprint: createHash('sha256').update(JSON.stringify(value)).digest('hex')});
const turn = () => new Promise(done => setImmediate(done));
const gate = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return {promise, resolve}; };
function fixture(t, initial = document()) {
    const dom = textCollectionDom(); let remote = receipt(initial), live = true, reads = 0, writes = 0, ids = 0, hook;
    const session = createDocumentSession({slot: 'classification-ui-test', isCurrent: () => live, store: {
        async read(_slot, request) { request.guard(); reads++; return structuredClone(remote); },
        async write(_slot, value, request) {
            request.guard(); if (remote.fingerprint !== request.expectedFingerprint) throw Error('conflict');
            await hook?.(); request.guard(); writes++; remote = receipt(value); return structuredClone(remote);
        },
    }});
    const collection = createTextCollection({session, now: () => stamp, createId: () => `created-${++ids}`});
    const view = createTextCollectionOrganizationView({parent: dom.parent, collection, isCurrent: () => live});
    t.after(() => { view.dispose(); session.dispose(); });
    return {dom, collection, view, get remote() { return structuredClone(remote.value); }, get reads() { return reads; }, get writes() { return writes; },
        hook(value) { hook = value; }, deactivate() { live = false; }, replace(value) { remote = receipt(value); }};
}
const dialog = f => f.dom.byClass('qm-collection-organize');
function click(f, label) { const node = f.dom.get(label); assert.ok(node, `missing ${label}`); assert.ok(f.dom.visible(node)); node.click(); return node; }
function edit(f, label, value, event = 'input') { const node = f.dom.get(label); assert.ok(node, `missing ${label}`); node.value = value; node.emit(event); return node; }
async function settled(f) { await f.dom.wait(() => !dialog(f) || dialog(f).getAttribute('aria-busy') !== 'true'); }

test('folder creation, rename and delete share the loaded document and never remove prose', async t => {
    const f = fixture(t); await f.collection.open(); f.view.folders();
    edit(f, '新文件夹名称', ' 新文件夹 '); click(f, '新建文件夹'); await settled(f);
    assert.equal(f.writes, 1); assert.equal(f.remote.organization.folders[2].name, '新文件夹');
    edit(f, '文件夹名称：created-1', '后来'); click(f, '保存文件夹：created-1'); await settled(f);
    assert.equal(f.remote.organization.folders[2].name, '后来'); assert.equal(f.writes, 2);
    click(f, '删除文件夹：first'); await settled(f);
    assert.equal(f.writes, 3); assert.deepEqual(f.remote.items, document().items);
    assert.deepEqual(f.remote.organization.entries[0], {itemId: 'one', folderId: null, tags: ['甲']});
    f.view.close(); f.view.folders(); assert.equal(f.reads, 1); assert.equal(f.writes, 3);
});

test('single-item tags use normal separators and explicit clearing, without changing the folder or dates', async t => {
    const f = fixture(t); await f.collection.open(); f.view.organize(['one']);
    assert.equal(f.dom.get('收藏标签').value, '甲'); assert.equal(f.dom.get('收藏文件夹').value, 'first');
    edit(f, '收藏标签', '旅途, 明信片、回忆；Travel,travel'); click(f, '保存分类'); await settled(f);
    assert.equal(dialog(f), undefined); assert.equal(f.writes, 1);
    assert.deepEqual(f.remote.organization.entries[0], {itemId: 'one', folderId: 'first', tags: ['旅途', '明信片', '回忆', 'Travel']});
    assert.deepEqual(f.remote.items, document().items);
    f.view.organize(['one']); edit(f, '收藏标签', ''); click(f, '保存分类'); await settled(f);
    assert.deepEqual(f.remote.organization.entries[0], {itemId: 'one', folderId: 'first', tags: []}); assert.equal(f.writes, 2); assert.equal(f.reads, 1);
});

test('mixed batch keeps untouched folders and tags, and no-change save is zero I/O', async t => {
    const f = fixture(t); await f.collection.open(); f.view.organize(['one', 'two']);
    assert.equal(f.dom.get('收藏文件夹').value, 'mixed'); assert.equal(f.dom.get('收藏标签').value, '');
    click(f, '保存分类'); assert.equal(dialog(f), undefined); assert.equal(f.writes, 0);
    f.view.organize(['one', 'two']); edit(f, '收藏文件夹', '', 'change'); click(f, '保存分类'); await settled(f);
    assert.deepEqual(f.remote.organization.entries, [{itemId: 'one', folderId: null, tags: ['甲']}, {itemId: 'two', folderId: null, tags: ['乙']}]);
    f.view.organize(['one', 'two']); edit(f, '收藏标签', '一起'); click(f, '保存分类'); await settled(f);
    assert.deepEqual(f.remote.organization.entries, [{itemId: 'one', folderId: null, tags: ['一起']}, {itemId: 'two', folderId: null, tags: ['一起']}]);
    f.view.organize(['one', 'two']); edit(f, '收藏标签', ''); click(f, '保存分类'); await settled(f);
    assert.deepEqual(f.remote.organization.entries, []); assert.equal(f.writes, 3); assert.equal(f.reads, 1);
});

test('a classification error keeps entered text and selection for one explicit retry', async t => {
    const f = fixture(t); await f.collection.open(); f.view.organize(['one']);
    edit(f, '收藏标签', '未保存的标签'); edit(f, '收藏文件夹', 'second', 'change');
    f.hook(() => { throw Object.assign(Error('private error details'), {writeState: 'not_started'}); });
    click(f, '保存分类'); await settled(f);
    assert.equal(f.dom.get('收藏标签').value, '未保存的标签'); assert.equal(f.dom.get('收藏文件夹').value, 'second');
    assert.equal(dialog(f).open, true); assert.equal(f.writes, 0); assert.equal(f.dom.status().textContent.includes('private'), false);
    f.hook(null); click(f, '保存分类'); await settled(f);
    assert.equal(f.writes, 1); assert.deepEqual(f.remote.organization.entries[0], {itemId: 'one', folderId: 'second', tags: ['未保存的标签']});
});

test('duplicate folder names retain the input instead of rebuilding or silently overwriting', async t => {
    const f = fixture(t); await f.collection.open(); f.view.folders();
    edit(f, '新文件夹名称', '旅程'); click(f, '新建文件夹'); await settled(f);
    assert.equal(f.dom.get('新文件夹名称').value, '旅程'); assert.equal(f.writes, 0); assert.equal(f.dom.status().hidden, false);
    edit(f, '新文件夹名称', '不同的名称'); click(f, '新建文件夹'); await settled(f);
    assert.equal(f.remote.organization.folders[2].name, '不同的名称'); assert.equal(f.writes, 1);
});

test('closing an in-flight save cannot close, disable or rewrite a newly opened dialog', async t => {
    const f = fixture(t), hold = gate(); await f.collection.open(); f.view.organize(['one']);
    f.hook(() => hold.promise); edit(f, '收藏标签', '原来的保存'); click(f, '保存分类');
    assert.equal(dialog(f).getAttribute('aria-busy'), 'true');
    click(f, '关闭分类编辑'); f.view.organize(['two']);
    assert.equal(dialog(f).getAttribute('aria-busy'), 'false');
    edit(f, '收藏标签', '新窗口尚未保存'); hold.resolve(); await turn();
    assert.equal(dialog(f).open, true); assert.equal(f.dom.get('收藏标签').value, '新窗口尚未保存');
    assert.equal(f.dom.get('保存分类').disabled, false); assert.equal(f.writes, 1);
    assert.deepEqual(f.remote.organization.entries[1].tags, ['乙']);
});

test('a blocked replacement while saving cannot change the item IDs of the current editor retry', async t => {
    const f = fixture(t), hold = gate(); await f.collection.open(); f.view.organize(['one']);
    f.hook(async () => { await hold.promise; throw Object.assign(Error('offline'), {writeState: 'not_started'}); });
    edit(f, '收藏标签', '仍然只改第一条'); click(f, '保存分类'); f.view.organize(['two']);
    hold.resolve(); await settled(f); f.hook(null);
    assert.equal(f.dom.get('收藏标签').value, '仍然只改第一条'); click(f, '保存分类'); await settled(f);
    assert.deepEqual(f.remote.organization.entries[0].tags, ['仍然只改第一条']);
    assert.deepEqual(f.remote.organization.entries[1].tags, ['乙']); assert.equal(f.writes, 1);
});

test('account invalidation before clicking or during persistence prevents writes and removes the dialog', async t => {
    for (const during of [false, true]) {
        const f = fixture(t), hold = gate(); await f.collection.open(); f.view.organize(['one']); edit(f, '收藏标签', '不得跨账户');
        if (during) { f.hook(() => hold.promise); click(f, '保存分类'); f.deactivate(); hold.resolve(); await turn(); }
        else { f.deactivate(); click(f, '保存分类'); }
        assert.equal(f.writes, 0); assert.equal(dialog(f), undefined); assert.deepEqual(f.remote, document());
    }
});

test('UI edits roundtrip in the existing complete backup with no additional document read', async t => {
    const f = fixture(t); await f.collection.open(); f.view.organize(['one', 'two']);
    edit(f, '收藏文件夹', 'second', 'change'); edit(f, '收藏标签', '一起,纪念'); click(f, '保存分类'); await settled(f);
    const payload = createTextCollectionBackup(documentFromTextCollectionState(f.collection.state()), {origin: 'https://fixture.invalid', scope: 'a'.repeat(64), now: () => stamp});
    const restored = await readTextCollectionBackup(new Blob([JSON.stringify(payload)]));
    assert.deepEqual(restored.document, f.remote); assert.equal(f.reads, 1); assert.equal(f.writes, 1);
});

test('queued close and input events stay scoped; short classification interface has only its actual controls', async t => {
    const f = fixture(t); await f.collection.open(); f.view.organize(['one']); f.view.close(); f.view.organize(['two']); await turn();
    assert.equal(dialog(f).open, true); assert.equal(f.dom.get('收藏标签').value, '乙');
    let outside = 0;
    for (const type of ['keydown', 'input', 'change', 'paste', 'click']) {
        f.dom.parent.addEventListener(type, () => outside++);
        assert.equal(f.dom.get('收藏标签').emit(type).defaultPrevented, false);
    }
    assert.equal(outside, 0); assert.equal(dialog(f).textContent.includes(row('one').text), false);
    assert.equal(f.dom.all().filter(node => node.tagName === 'INPUT').length, 1);
    assert.equal(f.dom.all().filter(node => node.tagName === 'SELECT').length, 1);
    assert.ok(dialog(f).textContent.length < 80); assert.equal(f.writes, 0);
    const css = await readFile(new URL('../qianmu-text-collection-organization-view.css', import.meta.url), 'utf8');
    assert.match(css, /height:\s*fit-content/); assert.match(css, /min-height:\s*0/);
});
