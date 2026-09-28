import test from 'node:test';
import assert from 'node:assert/strict';
import {createDocumentSession} from '../qianmu-document-session.js';
import {createTextCollection} from '../qianmu-text-collection.js';
import {createTextCollectionPanel} from '../qianmu-text-collection-panel.js';
import {LUCIDE_ICON_MARKUP} from '../qianmu-icon-renderer.js';
import {textCollectionDom} from './helpers/text-collection-dom.mjs';

const stamp = '2026-09-28T00:00:00.000Z';
const key = revision => revision.toString(16).padStart(64, '0');
const gate = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return {promise, resolve}; };
const turn = () => new Promise(resolve => setImmediate(resolve));
const entry = (id, text = `正文 ${id}`) => ({id, text, charName: '角色甲', userName: '读者乙', createdAt: stamp, updatedAt: stamp, source: {chatId: 'chat-one', messageId: `message-${id}`}});

function fixture(t, initial = []) {
    let live = true, revision = 1, readHook, writeHook, reads = 0, writes = 0, subscriptions = 0, id = 0;
    let remote = initial === null ? {exists: false, fingerprint: null, value: null}
        : {exists: true, fingerprint: key(revision), value: {version: 1, items: structuredClone(initial)}};
    const commit = value => { remote = {exists: true, fingerprint: key(++revision), value: structuredClone(value)}; return structuredClone(remote); };
    const store = {
        async read(_slot, options) {
            reads++; options.guard(); await readHook?.(options); options.guard();
            return structuredClone(remote);
        },
        async write(_slot, value, options) {
            writes++; options.guard();
            await writeHook?.(value, options, commit); options.guard();
            if (options.expectedFingerprint !== remote.fingerprint) throw Object.assign(Error('conflict'), {code: 'st_account_storage_conflict'});
            return commit(value);
        },
    };
    const session = createDocumentSession({store, slot: 'text-collection-panel-probe', isCurrent: () => live});
    const collection = createTextCollection({session, now: () => stamp, createId: () => `new-${++id}`});
    const presented = {...collection, subscribe(listener) {
        const unsubscribe = collection.subscribe(listener); subscriptions++;
        let removed = false;
        return () => { if (removed) return; removed = true; subscriptions--; unsubscribe(); };
    }};
    const dom = textCollectionDom(), copied = [];
    const view = createTextCollectionPanel({parent: dom.parent, collection: presented, isCurrent: () => live, copyText: async text => { copied.push(text); }});
    t.after(() => { view.dispose(); session.dispose(); });
    return {dom, view, collection, session, copied,
        get reads() { return reads; }, get writes() { return writes; }, get subscriptions() { return subscriptions; },
        get remote() { return structuredClone(remote); },
        readHook(fn) { readHook = fn; }, writeHook(fn) { writeHook = fn; }, deactivate() { live = false; },
    };
}

const click = (f, label) => { const control = f.dom.get(label); assert.ok(control, `missing ${label}`); assert.ok(f.dom.visible(control), `hidden ${label}`); control.click(); return control; };
const text = f => f.dom.byClass('qm-collection-text');
const editor = f => f.dom.get('收藏正文');
const list = f => f.dom.byClass('qm-collection-list');
async function waitReady(f) { await f.dom.wait(() => !['loading', 'refreshing', 'saving'].includes(f.collection.state().phase)); await turn(); }
function type(f, value) { const area = editor(f); assert.ok(area); area.value = value; area.emit('input'); }

test('capture, read, back, edit, save, select-delete and reopen use the same confirmed document', async t => {
    const f = fixture(t, null);
    assert.equal(await f.view.collect({text: '初始正文', charName: '角色甲', userName: '读者乙', source: null}), true);
    type(f, '收藏正文第一版'); click(f, '保存收藏'); await waitReady(f);
    assert.equal(f.collection.state().items.length, 1);
    const id = f.collection.state().items[0].id;
    assert.equal(f.collection.state().items[0].text, '收藏正文第一版');
    assert.equal(text(f).textContent, '收藏正文第一版');
    click(f, '返回收藏列表');
    click(f, `阅读收藏：${id}`);
    click(f, '编辑收藏'); type(f, '收藏正文第二版');
    click(f, '保存收藏'); await waitReady(f);
    assert.equal(text(f).textContent, '收藏正文第二版');
    click(f, '返回收藏列表'); click(f, '多选收藏'); click(f, `选择收藏：${id}`);
    click(f, '删除选中收藏'); await waitReady(f);
    assert.deepEqual(f.collection.state().items, []);
    assert.equal(f.writes, 3); assert.equal(f.reads, 1);
    f.view.close(); assert.equal(f.subscriptions, 0);
    await f.view.open(); assert.equal(f.subscriptions, 1);
    assert.deepEqual(f.collection.state().items, []); assert.equal(f.reads, 1);
});

test('one-step back and warm reopen reuse list nodes, search and scroll without a read', async t => {
    const f = fixture(t, [entry('one'), entry('two')]);
    await f.view.open();
    const search = f.dom.get('搜索收藏'); assert.equal(search.placeholder, '搜索关键词');
    search.value = '正文'; search.emit('input');
    const oldList = list(f), oldRow = f.dom.get('阅读收藏：one'); oldList.scrollTop = 137; oldList.emit('scroll');
    click(f, '阅读收藏：one'); click(f, '返回收藏列表');
    assert.equal(list(f), oldList); assert.equal(f.dom.get('阅读收藏：one'), oldRow); assert.equal(list(f).scrollTop, 137);
    f.view.close(); await f.view.open();
    assert.equal(list(f), oldList); assert.equal(f.dom.get('阅读收藏：one'), oldRow);
    assert.equal(list(f).scrollTop, 137); assert.equal(f.dom.get('搜索收藏').value, '正文'); assert.equal(f.reads, 1);
});

test('CRLF and extra blank lines remain exact after opening edit, unchanged save and copy', async t => {
    const raw = '  第一段\r\n\r\n\r\n第二段\r\n末行\r\n';
    const f = fixture(t, [entry('one', raw)]); await f.view.open();
    click(f, '阅读收藏：one'); assert.match(text(f).textContent, /第一段/); assert.match(text(f).textContent, /第二段/);
    click(f, '编辑收藏'); assert.equal(editor(f).value, '  第一段\n\n第二段\n末行\n');
    click(f, '保存收藏'); await waitReady(f);
    assert.equal(f.writes, 0); assert.equal(f.collection.state().items[0].text, raw);
    click(f, '复制收藏正文'); await turn(); assert.deepEqual(f.copied, [raw]);
});

test('typed draft and caret are not replaced by collection refresh notifications', async t => {
    const f = fixture(t, [entry('one')]); await f.view.open();
    click(f, '阅读收藏：one'); click(f, '编辑收藏');
    const area = editor(f); type(f, '正在编辑的内容'); area.focus(); area.setSelectionRange(3, 3);
    await f.collection.refresh();
    assert.equal(editor(f), area); assert.equal(area.value, '正在编辑的内容');
    assert.equal(area.selectionStart, 3); assert.equal(f.dom.doc.activeElement, area);
    f.view.close(); await f.view.open();
    assert.equal(editor(f), area); assert.equal(area.value, '正在编辑的内容');
});

test('failed save retains editor and its draft across close/reopen and never reports success', async t => {
    const f = fixture(t, [entry('one')]); await f.view.open();
    click(f, '阅读收藏：one'); click(f, '编辑收藏'); type(f, '尚未保存的编辑稿');
    f.writeHook(() => { throw Error('PRIVATE internal transport detail'); });
    click(f, '保存收藏'); await waitReady(f);
    assert.equal(f.collection.state().needsRefresh, true);
    assert.equal(f.remote.value.items[0].text, '正文 one');
    assert.equal(editor(f).value, '尚未保存的编辑稿');
    assert.doesNotMatch(f.dom.status()?.textContent || '', /PRIVATE|已保存|保存成功/);
    assert.ok(f.dom.status()?.textContent);
    f.view.close(); await f.view.open();
    assert.equal(editor(f).value, '尚未保存的编辑稿'); assert.equal(f.writes, 1); assert.equal(f.reads, 1);
    assert.equal(f.dom.get('保存收藏').disabled, true);
});

test('lost acknowledgement refresh confirms capture without another submission', async t => {
    const f = fixture(t, null);
    await f.view.collect({text: '已写入但回执丢失', charName: '角色', userName: '用户', source: null});
    f.writeHook((value, _options, commit) => { commit(value); throw Error('lost receipt'); });
    click(f, '保存收藏'); await waitReady(f); assert.equal(f.writes, 1);
    assert.equal(f.remote.value.items.length, 1); assert.equal(f.collection.state().items.length, 0);
    click(f, '核对保存结果'); await waitReady(f);
    assert.equal(f.collection.state().items.length, 1); assert.equal(f.collection.state().needsRefresh, false);
    assert.equal(f.writes, 1); assert.equal(text(f).textContent, '已写入但回执丢失');
    f.view.close(); await f.view.open(); assert.equal(f.writes, 1); assert.equal(f.reads, 2);
});

test('save and mutation controls disable synchronously, so double click writes once', async t => {
    const f = fixture(t, [entry('one')]), held = gate(); await f.view.open();
    click(f, '阅读收藏：one'); click(f, '编辑收藏'); type(f, '保存中的文本');
    f.writeHook(() => held.promise);
    const save = click(f, '保存收藏'); save.click();
    assert.equal(save.disabled, true); assert.equal(editor(f).readOnly, true);
    await f.dom.wait(() => f.writes === 1);
    assert.equal(f.dom.get('关闭收藏').disabled, false);
    held.resolve(); await waitReady(f); assert.equal(f.writes, 1);
    assert.equal(text(f).textContent, '保存中的文本');
});

test('closing during save neither cancels page-owned storage nor mutates detached UI', async t => {
    const f = fixture(t, [entry('one')]), held = gate(); await f.view.open();
    click(f, '阅读收藏：one'); click(f, '编辑收藏'); type(f, '关闭后完成');
    f.writeHook(() => held.promise); click(f, '保存收藏'); await f.dom.wait(() => f.writes === 1);
    f.view.close(); assert.equal(f.subscriptions, 0); assert.equal(f.dom.all().some(node => node.tagName === 'DIALOG'), false);
    held.resolve(); await waitReady(f);
    assert.equal(f.collection.state().items[0].text, '关闭后完成');
    await f.view.open(); assert.equal(text(f).textContent, '关闭后完成'); assert.equal(f.reads, 1);
});

test('owner change blocks writes and stale cold-read completion cannot mount content', async t => {
    const f = fixture(t, [entry('one')]), held = gate(); f.readHook(() => held.promise);
    const opened = f.view.open(); await f.dom.wait(() => f.reads === 1);
    f.deactivate(); held.resolve(); assert.equal(await opened, false);
    assert.equal(f.dom.all().some(node => node.tagName === 'DIALOG'), false); assert.equal(f.writes, 0);
    assert.equal(await f.view.collect({text: 'other-account', charName: 'A', userName: 'B', source: null}), false);
    assert.equal(f.writes, 0);
});

test('owner loss with an open editor rejects the next save without a write', async t => {
    const f = fixture(t, [entry('one')]); await f.view.open();
    click(f, '阅读收藏：one'); click(f, '编辑收藏'); type(f, '不得保存');
    f.deactivate(); click(f, '保存收藏'); await turn();
    assert.equal(f.writes, 0); assert.equal(f.remote.value.items[0].text, '正文 one');
    assert.equal(f.dom.all().some(node => node.tagName === 'DIALOG'), false);
});

test('HTML-looking content is literal text and editor key/input events stay inside the panel', async t => {
    const raw = '<img src=x onerror="alert(1)">\n<script>secret()</script>';
    const f = fixture(t, [entry('one', raw)]); await f.view.open();
    click(f, '阅读收藏：one'); assert.equal(text(f).textContent, raw);
    assert.equal(f.dom.all().some(node => ['IMG', 'SCRIPT'].includes(node.tagName)), false);
    click(f, '编辑收藏'); let hostInputs = 0, hostKeys = 0;
    f.dom.doc.body.addEventListener('input', () => { hostInputs++; });
    f.dom.doc.body.addEventListener('keydown', () => { hostKeys++; });
    editor(f).emit('input'); editor(f).emit('keydown', {key: 'a'});
    assert.equal(hostInputs, 0); assert.equal(hostKeys, 0);
    click(f, '取消编辑'); assert.equal(f.writes, 0); assert.equal(text(f).textContent, raw);
});

test('view disposal detaches one subscription but leaves the page document usable', async t => {
    const f = fixture(t, [entry('one')]);
    await Promise.all([f.view.open(), f.view.open()]); assert.equal(f.subscriptions, 1); assert.equal(f.reads, 1);
    f.view.dispose(); assert.equal(f.subscriptions, 0); assert.equal(f.dom.all().some(node => node.tagName === 'DIALOG'), false);
    assert.equal((await f.collection.open()).items[0].id, 'one'); assert.equal(f.reads, 1);
    assert.equal(await f.view.open(), false);
});

test('local control icons carry their intended glyph instead of an unresolved fallback', async t => {
    const f = fixture(t, [entry('one')]); await f.view.open();
    const expected = {
        '关闭收藏': 'x', '刷新收藏': 'refresh-cw', '多选收藏': 'list-checks', '删除选中收藏': 'trash-2',
        '上一页收藏': 'arrow-left', '下一页收藏': 'arrow-right', '返回收藏列表': 'arrow-left',
        '复制收藏正文': 'copy', '编辑收藏': 'pencil', '取消编辑': 'arrow-left', '保存收藏': 'star',
    };
    for (const [label, glyph] of Object.entries(expected)) {
        const icon = f.dom.get(label).children.find(node => node.tagName === 'SVG');
        assert.ok(icon, label); assert.equal(icon.innerHTML, LUCIDE_ICON_MARKUP[glyph], label);
        assert.equal(icon.getAttribute('stroke'), 'currentColor', label);
    }
});

test('cold read failure stays retryable and never masquerades as an empty saved library', async t => {
    const f = fixture(t, [entry('one')]);
    f.readHook(() => { throw Error('PRIVATE server reason'); }); await f.view.open();
    assert.equal(f.collection.state().loaded, false);
    assert.match(f.dom.status().textContent, /无法读取|读取失败/);
    assert.doesNotMatch(f.dom.status().textContent, /PRIVATE/);
    assert.doesNotMatch(list(f).textContent, /还没有收藏/);
    f.readHook(null); click(f, '刷新收藏'); await waitReady(f);
    assert.ok(f.dom.get('阅读收藏：one')); assert.equal(f.reads, 2); assert.equal(f.writes, 0);
});

test('conflicting remote refresh preserves local draft; stale save cannot overwrite and cancel reveals current text', async t => {
    const f = fixture(t, [entry('one', '原始正文')]); await f.view.open();
    click(f, '阅读收藏：one'); click(f, '编辑收藏'); type(f, '本地未确认编辑稿');
    f.writeHook((_value, _options, commit) => {
        commit({version: 1, items: [entry('one', '其他设备已保存的新正文')]});
        throw Error('lost response while remote differs');
    });
    click(f, '保存收藏'); await waitReady(f);
    click(f, '核对保存结果'); await waitReady(f);
    assert.equal(editor(f).value, '本地未确认编辑稿');
    assert.match(f.dom.status().textContent, /已有更新|未完成/);
    assert.doesNotMatch(f.dom.status().textContent, /已保存|保存成功/);
    assert.equal(f.collection.state().items[0].text, '其他设备已保存的新正文');
    f.writeHook(null); click(f, '保存收藏'); await waitReady(f);
    assert.equal(f.writes, 1); assert.equal(f.remote.value.items[0].text, '其他设备已保存的新正文');
    click(f, '复制收藏正文'); await turn(); assert.deepEqual(f.copied, ['本地未确认编辑稿']);
    click(f, '取消编辑'); assert.equal(text(f).textContent, '其他设备已保存的新正文');
    click(f, '编辑收藏'); assert.equal(editor(f).value, '其他设备已保存的新正文');
});

test('queued native close from the previous opening cannot close an immediately reopened panel', async t => {
    const f = fixture(t, [entry('one')]); await f.view.open();
    const dialog = f.dom.get('正文收藏');
    f.view.close(); assert.equal(dialog.open, false); assert.equal(f.subscriptions, 0);
    await f.view.open(); assert.equal(dialog.open, true); assert.equal(f.subscriptions, 1);
    await turn();
    assert.equal(f.dom.get('正文收藏'), dialog); assert.equal(dialog.open, true);
    assert.equal(f.subscriptions, 1); assert.equal(f.reads, 1);
});

test('lost-ack reconciliation finishing while closed is retained on reopen without resubmission', async t => {
    const f = fixture(t, null), held = gate();
    await f.view.collect({text: '回执丢失但已完整保存', charName: '角色甲', userName: '读者乙', source: null});
    f.writeHook((value, _options, commit) => { commit(value); throw Error('lost receipt'); });
    click(f, '保存收藏'); await waitReady(f); assert.equal(f.writes, 1);
    f.readHook(() => held.promise); click(f, '核对保存结果');
    await f.dom.wait(() => f.reads === 2); f.view.close(); assert.equal(f.subscriptions, 0);
    held.resolve(); await waitReady(f);
    assert.equal(f.collection.state().needsRefresh, false);
    await f.view.open();
    assert.equal(f.dom.visible(text(f)), true); assert.equal(text(f).textContent, '回执丢失但已完整保存');
    assert.equal(f.dom.visible(editor(f)), false); assert.equal(f.writes, 1); assert.equal(f.reads, 2);
    assert.doesNotMatch(f.dom.status().textContent, /保存未完成|已有更新/);
});

test('local filtering, pagination and deleting two selected entries require no extra reads', async t => {
    const initial = Array.from({length: 25}, (_, index) => entry(`item-${index}`, `正文片段 ${index} 独立词${index}`));
    const f = fixture(t, initial); await f.view.open();
    assert.ok(f.dom.get('阅读收藏：item-0')); assert.equal(f.dom.get('阅读收藏：item-24'), undefined);
    click(f, '下一页收藏'); assert.ok(f.dom.get('阅读收藏：item-24'));
    click(f, '上一页收藏');
    const search = f.dom.get('搜索收藏'); search.value = '独立词24'; search.emit('input');
    assert.ok(f.dom.get('阅读收藏：item-24')); assert.equal(f.dom.get('阅读收藏：item-0'), undefined);
    search.value = ''; search.emit('input');
    click(f, '多选收藏'); click(f, '选择收藏：item-0'); click(f, '选择收藏：item-1');
    click(f, '删除选中收藏'); await waitReady(f);
    assert.equal(f.collection.state().items.length, 23);
    assert.equal(f.collection.state().items.some(item => ['item-0', 'item-1'].includes(item.id)), false);
    assert.equal(f.writes, 1); assert.equal(f.reads, 1);
});

test('closing a pending capture prevents its late opening from replacing the next floor capture', async t => {
    const f = fixture(t, null), held = gate();
    f.readHook(() => held.promise);
    const first = f.view.collect({text: '已经取消的楼层', charName: '甲', userName: '乙'});
    await f.dom.wait(() => f.reads === 1);
    f.view.close();
    const second = f.view.collect({text: '重新选择的楼层', charName: '丙', userName: '丁'});
    held.resolve();
    assert.deepEqual(await Promise.all([first, second]), [false, true]);
    assert.equal(editor(f).value, '重新选择的楼层');
    assert.equal(f.writes, 0); assert.equal(f.reads, 1);
});

test('confirmed removal prunes stale selections so remaining entries can be deleted', async t => {
    const f = fixture(t, [entry('one'), entry('two')]); await f.view.open();
    click(f, '多选收藏'); click(f, '选择收藏：one');
    // A second page consumer changes the same confirmed document. Remote
    // refresh publishes the same subscription shape; selection is view-owned.
    await f.collection.remove(['one'], {expectedFingerprint: f.collection.state().fingerprint});
    assert.equal(f.dom.get('阅读收藏：one'), undefined);
    assert.equal(f.dom.get('删除选中收藏').disabled, true);
    click(f, '选择收藏：two'); click(f, '删除选中收藏'); await waitReady(f);
    assert.deepEqual(f.collection.state().items, []); assert.equal(f.writes, 2);
});
