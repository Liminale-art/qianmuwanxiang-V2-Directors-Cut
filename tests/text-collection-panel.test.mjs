import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createDocumentSession} from '../qianmu-document-session.js';
import {createTextCollection} from '../qianmu-text-collection.js';
import {createTextCollectionPanel} from '../qianmu-text-collection-panel.js';
import {LUCIDE_ICON_MARKUP} from '../qianmu-icon-renderer.js';
import {textCollectionDom} from './helpers/text-collection-dom.mjs';
import {setCollectionEditorText, collectionEditorDisplayText} from './helpers/text-collection-editor.mjs';

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
function type(f, value) { const area = editor(f); assert.ok(area); setCollectionEditorText(area, value); }
const displayed = f => collectionEditorDisplayText(editor(f));

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
    click(f, '编辑收藏'); assert.equal(displayed(f), '  第一段\n\n第二段\n末行\n');
    click(f, '保存收藏'); await waitReady(f);
    assert.equal(f.writes, 0); assert.equal(f.collection.state().items[0].text, raw);
    click(f, '复制收藏正文'); await turn(); assert.deepEqual(f.copied, [raw]);
});

test('typed draft and caret are not replaced by collection refresh notifications', async t => {
    const f = fixture(t, [entry('one')]); await f.view.open();
    click(f, '阅读收藏：one'); click(f, '编辑收藏');
    const area = editor(f); type(f, '正在编辑的内容'); area.focus(); const paragraph = area.firstChild;
    await f.collection.refresh();
    assert.equal(editor(f), area); assert.equal(displayed(f), '正在编辑的内容');
    assert.equal(area.firstChild, paragraph); assert.equal(f.dom.doc.activeElement, area);
    f.view.close(); await f.view.open();
    assert.equal(editor(f), area); assert.equal(displayed(f), '正在编辑的内容');
    assert.equal(f.dom.visible(list(f)), true); assert.equal(f.dom.visible(area), false);
    click(f, '继续未保存的编辑'); assert.equal(f.dom.visible(area), true);
});

test('failed save retains editor and its draft across close/reopen and never reports success', async t => {
    const f = fixture(t, [entry('one')]); await f.view.open();
    click(f, '阅读收藏：one'); click(f, '编辑收藏'); type(f, '尚未保存的编辑稿');
    f.writeHook(() => { throw Error('PRIVATE internal transport detail'); });
    click(f, '保存收藏'); await waitReady(f);
    assert.equal(f.collection.state().needsRefresh, true);
    assert.equal(f.remote.value.items[0].text, '正文 one');
    assert.equal(displayed(f), '尚未保存的编辑稿');
    assert.doesNotMatch(f.dom.status()?.textContent || '', /PRIVATE|已保存|保存成功/);
    assert.ok(f.dom.status()?.textContent);
    f.view.close(); await f.view.open();
    assert.equal(displayed(f), '尚未保存的编辑稿'); assert.equal(f.writes, 1); assert.equal(f.reads, 1);
    assert.equal(f.dom.visible(list(f)), true); click(f, '继续未保存的编辑');
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
    assert.equal(save.disabled, true); assert.equal(editor(f).getAttribute('contenteditable'), 'false');
    await f.dom.wait(() => f.writes === 1);
    assert.equal(f.dom.get('关闭收藏').disabled, false);
    held.resolve(); await waitReady(f); assert.equal(f.writes, 1);
    assert.equal(text(f).textContent, '保存中的文本');
});

test('a floor-owned refresh reconciles a closed editor lost receipt without a duplicate capture', async t => {
    const f = fixture(t, null);
    await f.view.collect({text: '楼层核对保留原文', charName: '角色', userName: '用户', source: null});
    f.writeHook((value, _options, commit) => { commit(value); throw Error('lost receipt'); });
    click(f, '保存收藏'); await waitReady(f); f.view.close();
    await f.collection.refresh(); await f.view.open();
    assert.equal(f.dom.visible(list(f)), true);
    click(f, `阅读收藏：${f.collection.state().items[0].id}`);
    assert.equal(text(f).textContent, '楼层核对保留原文');
    assert.equal(f.dom.visible(editor(f)), false); assert.equal(f.writes, 1);
});

test('closing during save neither cancels page-owned storage nor mutates detached UI', async t => {
    const f = fixture(t, [entry('one')]), held = gate(); await f.view.open();
    click(f, '阅读收藏：one'); click(f, '编辑收藏'); type(f, '关闭后完成');
    f.writeHook(() => held.promise); click(f, '保存收藏'); await f.dom.wait(() => f.writes === 1);
    f.view.close(); assert.equal(f.subscriptions, 0); assert.equal(f.dom.all().some(node => node.tagName === 'DIALOG'), false);
    held.resolve(); await waitReady(f);
    assert.equal(f.collection.state().items[0].text, '关闭后完成');
    await f.view.open(); assert.equal(f.dom.visible(list(f)), true);
    click(f, '阅读收藏：one'); assert.equal(text(f).textContent, '关闭后完成'); assert.equal(f.reads, 1);
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
        '返回收藏列表': 'arrow-left', '管理文件夹': 'folder-plus', '整理收藏': 'tag',
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
    assert.equal(displayed(f), '本地未确认编辑稿');
    assert.match(f.dom.status().textContent, /已有更新|未完成/);
    assert.doesNotMatch(f.dom.status().textContent, /已保存|保存成功/);
    assert.equal(f.collection.state().items[0].text, '其他设备已保存的新正文');
    f.writeHook(null); click(f, '保存收藏'); await waitReady(f);
    assert.equal(f.writes, 1); assert.equal(f.remote.value.items[0].text, '其他设备已保存的新正文');
    assert.equal(f.dom.visible(f.dom.get('复制收藏正文')), false);
    assert.equal(displayed(f), '本地未确认编辑稿');
    click(f, '取消编辑'); assert.equal(text(f).textContent, '其他设备已保存的新正文');
    click(f, '编辑收藏'); assert.equal(displayed(f), '其他设备已保存的新正文');
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
    assert.equal(f.dom.visible(list(f)), true);
    click(f, `阅读收藏：${f.collection.state().items[0].id}`);
    assert.equal(f.dom.visible(text(f)), true); assert.equal(text(f).textContent, '回执丢失但已完整保存');
    assert.equal(f.dom.visible(editor(f)), false); assert.equal(f.writes, 1); assert.equal(f.reads, 2);
    assert.doesNotMatch(f.dom.status().textContent, /保存未完成|已有更新/);
});

test('local filtering, incremental rendering and whole-row selection require no extra reads', async t => {
    const initial = Array.from({length: 25}, (_, index) => entry(`item-${index}`, `正文片段 ${index} 独立词${index}`));
    const f = fixture(t, initial); await f.view.open();
    assert.ok(f.dom.get('阅读收藏：item-0')); assert.equal(f.dom.get('阅读收藏：item-24'), undefined);
    const first = f.dom.get('阅读收藏：item-0');
    list(f).clientHeight = 400; list(f).scrollHeight = 1300; list(f).scrollTop = 890; list(f).emit('scroll');
    assert.ok(f.dom.get('阅读收藏：item-24')); assert.equal(first, f.dom.get('阅读收藏：item-0'));
    f.view.close(); await f.view.open(); assert.ok(f.dom.get('阅读收藏：item-24'));
    const search = f.dom.get('搜索收藏'); search.value = '独立词24'; search.emit('input');
    assert.ok(f.dom.get('阅读收藏：item-24')); assert.equal(f.dom.get('阅读收藏：item-0'), undefined);
    search.value = ''; search.emit('input');
    click(f, '多选收藏'); click(f, '选择收藏：item-0'); click(f, '选择收藏：item-1');
    assert.equal(f.dom.get('选择收藏：item-0').getAttribute('aria-pressed'), 'true');
    assert.equal(list(f).querySelectorAll('input').length, 0);
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
    assert.equal(displayed(f), '重新选择的楼层');
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

test('capacity rejection keeps full draft and explains that refresh cannot repair capacity', async t => {
    const f = fixture(t, [entry('one')]); await f.view.open();
    click(f, '阅读收藏：one'); click(f, '编辑收藏');
    const fullText = '完整保留\r\n'.repeat(100);
    type(f, fullText);
    f.writeHook(() => { throw Object.assign(Error('private byte limit'), {code: 'st_account_storage_capacity', writeState: 'not_started'}); });
    click(f, '保存收藏'); await waitReady(f);
    assert.equal(f.collection.state().needsRefresh, false);
    assert.equal(displayed(f), fullText.replace(/\r\n/g, '\n'));
    assert.match(f.dom.status().textContent, /超过存储上限/);
    assert.doesNotMatch(f.dom.status().textContent, /请刷新|private/);
    assert.equal(f.dom.visible(f.dom.get('核对保存结果')), false);
    f.view.close(); await f.view.open();
    assert.equal(displayed(f), fullText.replace(/\r\n/g, '\n'));
    assert.equal(f.reads, 1);
});

test('oversized verification after upload stays unconfirmed with reconciliation available', async t => {
    const f = fixture(t, [entry('one')]); await f.view.open();
    click(f, '阅读收藏：one'); click(f, '编辑收藏'); type(f, '已提交但确认超限');
    f.writeHook((value, _options, commit) => {
        commit(value);
        throw Object.assign(Error('oversized verification'), {code: 'st_account_storage_capacity', writeState: 'unconfirmed'});
    });
    click(f, '保存收藏'); await waitReady(f);
    assert.equal(f.collection.state().needsRefresh, true);
    assert.equal(f.dom.visible(f.dom.get('核对保存结果')), true);
    assert.doesNotMatch(f.dom.status().textContent, /本次未保存/);
    click(f, '核对保存结果'); await waitReady(f);
    assert.equal(text(f).textContent, '已提交但确认超限');
    assert.equal(f.writes, 1);
});

test('opening a second item cannot silently edit or save the retained first item draft', async t => {
    const f = fixture(t, [entry('one'), entry('two')]); await f.view.open();
    click(f, '阅读收藏：one'); click(f, '编辑收藏'); type(f, '仅属于第一条的稿');
    f.view.close(); await f.view.open(); click(f, '阅读收藏：two'); click(f, '编辑收藏');
    assert.equal(f.dom.visible(editor(f)), false); assert.equal(text(f).textContent, '正文 two');
    assert.match(f.dom.status().textContent, /未保存/); assert.equal(f.writes, 0);
    click(f, '返回收藏列表'); click(f, '继续未保存的编辑'); assert.equal(displayed(f), '仅属于第一条的稿');
    click(f, '保存收藏'); await waitReady(f);
    assert.equal(f.collection.state().items.find(item => item.id === 'one').text, '仅属于第一条的稿');
    assert.equal(f.collection.state().items.find(item => item.id === 'two').text, '正文 two');
});

test('an unrelated classification or item write does not invalidate an untouched prose draft', async t => {
    const f = fixture(t, [entry('one'), entry('two')]); await f.view.open();
    click(f, '阅读收藏：one'); click(f, '编辑收藏'); type(f, '继续可保存的正文');
    f.view.close();
    await f.collection.createFolder('旅途', {expectedFingerprint: f.collection.state().fingerprint});
    await f.collection.edit('two', '另一条的新文', {expectedFingerprint: f.collection.state().fingerprint});
    await f.view.open(); click(f, '继续未保存的编辑'); click(f, '保存收藏'); await waitReady(f);
    assert.equal(f.collection.state().items.find(item => item.id === 'one').text, '继续可保存的正文');
    assert.equal(f.collection.state().items.find(item => item.id === 'two').text, '另一条的新文');
    assert.equal(f.collection.state().organization.folders[0].name, '旅途');
    assert.equal(f.reads, 1); assert.equal(f.writes, 3);
});

test('classification filters search folders tags roles and text locally with persistent loaded windows', async t => {
    const f = fixture(t, Array.from({length: 61}, (_, i) => entry(`n${i}`, `第${i}段`))); await f.view.open();
    assert.equal(list(f).querySelectorAll('.qm-collection-entry').length, 20);
    click(f, '显示更多收藏'); click(f, '显示更多收藏');
    assert.equal(list(f).querySelectorAll('.qm-collection-entry').length, 60);
    await f.collection.createFolder('旅行', {expectedFingerprint: f.collection.state().fingerprint});
    const folderId = f.collection.state().organization.folders[0].id;
    await f.collection.organize(['n60'], {folderId, tags: ['远方']}, {expectedFingerprint: f.collection.state().fingerprint});
    const search = f.dom.get('搜索收藏'); search.value = '旅行'; search.emit('input');
    assert.deepEqual(list(f).querySelectorAll('.qm-collection-entry').map(node => node.dataset.itemId), ['n60']);
    search.value = '远方'; search.emit('input'); assert.ok(f.dom.get('阅读收藏：n60'));
    search.value = ''; search.emit('input');
    assert.equal(list(f).querySelectorAll('.qm-collection-entry').length, 60);
    const folders = f.dom.get('筛选文件夹'); folders.value = `folder:${folderId}`; folders.emit('change');
    assert.deepEqual(list(f).querySelectorAll('.qm-collection-entry').map(node => node.dataset.itemId), ['n60']);
    folders.value = 'char:角色甲'; folders.emit('change');
    assert.equal(f.dom.get('阅读收藏：n60'), undefined); assert.ok(f.dom.get('阅读收藏：n0'));
    folders.value = ''; folders.emit('change');
    f.view.close(); await f.view.open(); assert.equal(list(f).querySelectorAll('.qm-collection-entry').length, 60);
    assert.equal(f.reads, 1); assert.equal(f.writes, 2);
});

test('header returns are left of title, copy is reading-only and short reading selects adaptive sizing', async t => {
    const f = fixture(t, [entry('one', '一句话')]); await f.view.open();
    click(f, '阅读收藏：one'); const panel = f.dom.get('正文收藏');
    assert.equal(panel.getAttribute('data-view'), 'read');
    assert.equal(panel.children[0].children[0], f.dom.get('返回收藏列表'));
    assert.equal(f.dom.visible(f.dom.get('复制收藏正文')), true);
    click(f, '编辑收藏');
    assert.equal(panel.getAttribute('data-view'), 'edit');
    assert.equal(panel.children[0].children[1], f.dom.get('取消编辑'));
    assert.equal(f.dom.visible(f.dom.get('复制收藏正文')), false);
    f.view.close(); await f.view.open();
    assert.equal(panel.getAttribute('data-view'), 'list'); assert.equal(f.dom.visible(list(f)), true);
    const css = await readFile(new URL('../qianmu-text-collection-panel.css', import.meta.url), 'utf8');
    assert.match(css, /\[data-view="read"\][^{]*\{[^}]*height: fit-content/);
    assert.match(css, /font-size: var\(--qm-prose-size, 1em\); line-height: 1\.55; text-align: justify/);
    assert.match(css, /margin: 0 0 \.75em;[^}]*text-indent: 2em/);
    assert.doesNotMatch(css, /textarea\)[^}]*font-size: 16px/);
});
