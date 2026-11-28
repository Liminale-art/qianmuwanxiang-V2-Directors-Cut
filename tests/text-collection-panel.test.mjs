import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createDocumentSession} from '../qianmu-document-session.js';
import {createTextCollection} from '../qianmu-text-collection.js';
import {createTextCollectionPanel} from '../qianmu-text-collection-panel.js';
import {ICONSAX_GLYPH_NAMES, ICONSAX_ICON_MARKUP} from '../qianmu-icon-renderer.js';
import {textCollectionDom} from './helpers/text-collection-dom.mjs';
import {setCollectionEditorText, collectionEditorDisplayText} from './helpers/text-collection-editor.mjs';

const stamp = '2026-09-28T00:00:00.000Z';
const key = revision => revision.toString(16).padStart(64, '0');
const gate = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return {promise, resolve}; };
const turn = () => new Promise(resolve => setImmediate(resolve));
const entry = (id, text = `正文 ${id}`) => ({id, text, charName: '角色甲', userName: '读者乙', createdAt: stamp, updatedAt: stamp, source: {chatId: 'chat-one', messageId: `message-${id}`}});

function fixture(t, initial = [], options = {}) {
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
    const view = createTextCollectionPanel({parent: dom.parent, collection: presented, isCurrent: () => live, copyText: async text => { copied.push(text); }, ...options});
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
        '关闭收藏': 'x', '多选收藏': 'list-checks', '删除选中收藏': 'trash',
        '返回收藏列表': 'arrow-left', '管理文件夹': 'folder-plus', '整理收藏': 'tag',
        '复制收藏正文': 'copy', '编辑收藏': 'pencil-simple', '取消编辑': 'arrow-left', '保存收藏': 'check',
        '标签规则': 'funnel', '删除收藏：one': 'trash',
    };
    for (const [label, glyph] of Object.entries(expected)) {
        const icon = f.dom.get(label).children.find(node => node.tagName === 'SVG');
        assert.ok(icon, label);
        assert.equal(icon.getAttribute('data-qm-glyph'), `qm-regular-${glyph}`, label);
        const official = ICONSAX_GLYPH_NAMES[glyph];
        assert.ok(official && ICONSAX_ICON_MARKUP[official], `${label}: registered semantic, not fallback`);
        const variants = [...icon.innerHTML.matchAll(/<g data-qm-icon-variant="(outline|bold|twotone)"([^>]*)>([\s\S]*?)<\/g>(?=<g data-qm-icon-variant=|$)/g)];
        assert.deepEqual(variants.map(match => match[1]), glyph === 'star' ? ['outline'] : ['outline', 'bold', 'twotone'], label);
        for (const [, variant, attrs, body] of variants) {
            const artworkVariant = official === 'refresh-arrow-02' && variant === 'bold' ? 'outline' : variant;
            assert.equal(body, ICONSAX_ICON_MARKUP[official][artworkVariant], `${label}/${variant}`);
            if (official === 'refresh-arrow-02') assert.notEqual(body, ICONSAX_ICON_MARKUP[official].bold, 'refresh excludes Bold artwork in every theme');
            assert.equal(/\sdata-qm-icon-fixed(?:\s|$)/.test(attrs), glyph === 'star', `${label}: uncollected state stays outlined in every theme`);
        }
        assert.equal(icon.getAttribute('stroke'), 'none', label);
        assert.equal(icon.getAttribute('stroke-width'), '2.5', label);
    }
});

test('cold read failure stays retryable and never masquerades as an empty saved library', async t => {
    const f = fixture(t, [entry('one')]);
    f.readHook(() => { throw Error('PRIVATE server reason'); }); await f.view.open();
    assert.equal(f.collection.state().loaded, false);
    assert.match(f.dom.status().textContent, /无法读取|读取失败/);
    assert.doesNotMatch(f.dom.status().textContent, /PRIVATE/);
    assert.doesNotMatch(list(f).textContent, /还没有收藏/);
    f.readHook(null); click(f, '关闭收藏'); await f.view.open(); await waitReady(f);
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
    assert.equal(f.dom.visible(f.dom.get('删除选中收藏')), false);
    click(f, '多选收藏');
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

test('search replaces classification dropdowns and matches folders tags roles and text locally', async t => {
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
    assert.equal(f.dom.get('筛选文件夹'), undefined); assert.equal(f.dom.get('筛选标签'), undefined);
    assert.equal(f.dom.byClass('qm-collection-filters'), undefined);
    search.value = '角色甲'; search.emit('input'); assert.ok(f.dom.get('阅读收藏：n0'));
    search.value = '第60段'; search.emit('input'); assert.ok(f.dom.get('阅读收藏：n60'));
    search.value = ''; search.emit('input');
    f.view.close(); await f.view.open(); assert.equal(list(f).querySelectorAll('.qm-collection-entry').length, 60);
    assert.equal(f.reads, 1); assert.equal(f.writes, 2);
});

test('second multi click selects only loaded rows and never selects a later appended row implicitly', async t => {
    const f = fixture(t, Array.from({length: 55}, (_, i) => entry(`n${i}`))); await f.view.open();
    click(f, '多选收藏');
    assert.equal(list(f).querySelectorAll('.qm-collection-entry[aria-pressed="true"]').length, 0);
    click(f, '多选收藏');
    assert.equal(list(f).querySelectorAll('.qm-collection-entry[aria-pressed="true"]').length, 20);
    click(f, '显示更多收藏');
    assert.equal(list(f).querySelectorAll('.qm-collection-entry').length, 40);
    assert.equal(list(f).querySelectorAll('.qm-collection-entry[aria-pressed="true"]').length, 20);
    click(f, '多选收藏');
    assert.equal(list(f).querySelectorAll('.qm-collection-entry[aria-pressed="true"]').length, 40);
    click(f, '删除选中收藏'); await waitReady(f);
    assert.deepEqual(f.collection.state().items.map(item => item.id), Array.from({length: 15}, (_, i) => `n${i + 40}`));
    assert.equal(f.dom.visible(f.dom.get('删除选中收藏')), false);
    assert.equal(f.dom.visible(f.dom.get('整理选中收藏')), false);
    assert.equal(f.reads, 1); assert.equal(f.writes, 1);
});

test('unselecting the last row retracts actions, and searching cannot keep hidden selections', async t => {
    const f = fixture(t, [entry('one', '甲段'), entry('two', '乙段')]); await f.view.open();
    click(f, '多选收藏'); click(f, '选择收藏：one'); click(f, '选择收藏：one');
    assert.equal(f.dom.get('多选收藏').getAttribute('aria-pressed'), 'false');
    assert.equal(f.dom.visible(f.dom.get('整理选中收藏')), false);
    assert.equal(f.dom.visible(f.dom.get('删除选中收藏')), false);
    click(f, '多选收藏'); click(f, '选择收藏：one');
    const search = f.dom.get('搜索收藏'); search.value = '乙段'; search.emit('input');
    assert.equal(f.dom.visible(f.dom.get('删除选中收藏')), false);
    click(f, '多选收藏'); click(f, '多选收藏'); click(f, '删除选中收藏'); await waitReady(f);
    assert.deepEqual(f.collection.state().items.map(item => item.id), ['one']);
    assert.equal(f.writes, 1); assert.equal(f.reads, 1);
});

test('folder operations and successful batch organization retract parent selection controls', async t => {
    const f = fixture(t, [entry('one'), entry('two')]); await f.view.open();
    click(f, '多选收藏'); click(f, '多选收藏'); click(f, '管理文件夹');
    f.dom.get('新文件夹名称').value = '片段'; click(f, '新建文件夹'); await waitReady(f);
    assert.equal(f.dom.visible(f.dom.get('删除选中收藏')), false);
    assert.equal(f.dom.get('多选收藏').getAttribute('aria-pressed'), 'false');
    click(f, '返回收藏');
    click(f, '多选收藏'); click(f, '多选收藏'); click(f, '整理选中收藏');
    const tags = f.dom.get('收藏标签'); tags.value = '高光'; tags.emit('input'); click(f, '保存分类'); await waitReady(f);
    assert.equal(f.dom.byClass('qm-collection-organize'), undefined);
    assert.equal(f.dom.visible(f.dom.get('整理选中收藏')), false);
    assert.equal(f.collection.state().organization.entries.length, 2);
    assert.equal(f.writes, 2); assert.equal(f.reads, 1);
});

test('failed deletion retains its selection for retry instead of silently retracting actions', async t => {
    const f = fixture(t, [entry('one')]); await f.view.open();
    click(f, '多选收藏'); click(f, '多选收藏');
    f.writeHook(() => { throw Object.assign(Error('unavailable'), {writeState: 'not_started'}); });
    click(f, '删除选中收藏'); await waitReady(f);
    assert.equal(f.dom.visible(f.dom.get('删除选中收藏')), true);
    assert.equal(f.dom.get('选择收藏：one').getAttribute('aria-pressed'), 'true');
    assert.equal(f.collection.state().items.length, 1);
    f.writeHook(null); click(f, '删除选中收藏'); await waitReady(f);
    assert.equal(f.collection.state().items.length, 0);
    assert.equal(f.dom.visible(f.dom.get('删除选中收藏')), false);
});

test('closing multi selection returns to the ordinary warm list without another read', async t => {
    const f = fixture(t, [entry('one'), entry('two')]); await f.view.open();
    click(f, '多选收藏'); click(f, '多选收藏');
    f.view.close(); await f.view.open();
    assert.equal(f.dom.get('多选收藏').getAttribute('aria-pressed'), 'false');
    assert.equal(f.dom.visible(f.dom.get('删除选中收藏')), false);
    assert.ok(f.dom.get('阅读收藏：one')); assert.ok(f.dom.get('阅读收藏：two'));
    assert.equal(f.reads, 1); assert.equal(f.writes, 0);
});

test('a closed in-flight classification cannot leave a delete target outside the current search', async t => {
    const f = fixture(t, [entry('one')]), held = gate(); await f.view.open();
    await f.collection.organize(['one'], {tags: ['旧标签']}, {expectedFingerprint: f.collection.state().fingerprint});
    const search = f.dom.get('搜索收藏'); search.value = '旧标签'; search.emit('input');
    click(f, '多选收藏'); click(f, '多选收藏'); click(f, '整理选中收藏');
    const tags = f.dom.get('收藏标签'); tags.value = '新标签'; tags.emit('input');
    f.writeHook(() => held.promise); click(f, '保存分类');
    await f.dom.wait(() => f.writes === 2); click(f, '关闭分类编辑');
    held.resolve(); await waitReady(f);
    assert.equal(list(f).querySelectorAll('.qm-collection-entry').length, 0);
    assert.equal(f.dom.visible(f.dom.get('删除选中收藏')), false);
    assert.equal(f.dom.get('删除选中收藏').disabled, true);
    f.dom.get('删除选中收藏').click(); await turn();
    assert.equal(f.writes, 2); assert.equal(f.collection.state().items.length, 1);
    search.value = ''; search.emit('input'); assert.ok(f.dom.get('阅读收藏：one'));
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
    assert.match(css, /font-family: var\(--qm-body-font, var\(--qm-prose-font, var\(--sd-font, inherit\)\)\); font-size: var\(--sd-prose-font-size, var\(--qm-prose-size, 1em\)\); letter-spacing: var\(--qm-prose-letter-spacing, normal\); line-height: 1\.55; text-align: justify/);
    assert.match(css, /margin: 0 0 \.75em;[^}]*text-indent: 2em/);
    assert.doesNotMatch(css, /textarea\)[^}]*font-size: 16px/);
});

test('a full-text capture lays the text out for editing without taking focus; tapping the text is what starts editing', async t => {
    const f = fixture(t, null), before = f.dom.doc.activeElement;
    assert.equal(await f.view.collect({text: '整段正文', charName: '角色甲', userName: '读者乙', source: null}), true);
    assert.equal(f.dom.visible(editor(f)), true); assert.equal(displayed(f), '整段正文');
    assert.notEqual(f.dom.doc.activeElement, editor(f), 'no focus: a phone keyboard does not pop up on its own');
    assert.equal(f.dom.doc.activeElement, before);
    assert.equal(editor(f).getAttribute('contenteditable') !== 'false', true, 'still editable the moment it is tapped');
    click(f, '保存收藏'); await waitReady(f);
    click(f, '编辑收藏'); assert.equal(f.dom.doc.activeElement, editor(f), 'choosing to edit a saved entry still focuses the editor');
});

test('entries from the open chat show a floor tag that jumps there; other chats, missing floors and multi-select show none', async t => {
    const floors = new Map([['message-one', 12], ['message-two', 0]]), jumps = [];
    let lookups = 0, chatOpen = true;
    const f = fixture(t, [entry('one'), entry('two'), entry('three')], {
        locateFloor: () => { lookups++; return source => chatOpen && source?.chatId === 'chat-one' ? floors.get(source.messageId) ?? null : null; },
        onJumpFloor: floor => { jumps.push(floor); return true; },
    });
    await f.view.open();
    const tags = () => Object.fromEntries(f.dom.all().filter(node => node.classList.contains('qm-collection-floor') && f.dom.visible(node))
        .map(node => [node.parentNode.querySelector('.qm-collection-entry')?.dataset.itemId ?? 'read', node.textContent]));
    assert.deepEqual(tags(), {one: '#12', two: '#0'}, 'floor 0 is a real floor; an entry without a live floor has no tag');
    assert.equal(f.dom.get('跳到第 12 层').tagName, 'BUTTON');
    assert.ok(lookups >= 1 && lookups < 3 * 10, 'a lookup table per paint, not one per entry and paint');
    click(f, '多选收藏'); assert.deepEqual(tags(), {}, 'no jump targets while selecting');
    f.view.close(); await f.view.open(); assert.deepEqual(tags(), {one: '#12', two: '#0'});
    floors.delete('message-one');
    f.view.close(); await f.view.open();
    assert.deepEqual(tags(), {two: '#0'}, 'a deleted floor drops its tag on the next paint');
    floors.set('message-one', 12);
    f.view.close(); await f.view.open();
    click(f, '阅读收藏：one'); assert.deepEqual(tags(), {read: '#12'}, 'the reading page carries the same tag');
    floors.set('message-one', 15);
    f.dom.all().find(node => node.getAttribute('aria-label') === '跳到第 12 层' && f.dom.visible(node)).click();
    await turn(); assert.deepEqual(jumps, [15], 'the floor is looked up again at the tap, never taken from a stale paint');
    assert.equal(f.dom.all().some(node => node.classList.contains('qm-collection-panel')), false, 'the panel steps aside for the chat');
    chatOpen = false; await f.view.open();
    assert.deepEqual(tags(), {}, 'another chat: no tags');
    chatOpen = true; floors.clear(); await f.view.open();
    assert.deepEqual(tags(), {});
});

test('without a floor locator, or when it fails, the list renders exactly as before', async t => {
    const warn = console.warn; const warnings = []; console.warn = (...args) => warnings.push(args); t.after(() => { console.warn = warn; });
    const f = fixture(t, [entry('one')], {locateFloor: () => { throw Error('host gone'); }, onJumpFloor: () => true});
    await f.view.open(); f.view.close(); await f.view.open();
    assert.ok(f.dom.get('阅读收藏：one'));
    assert.equal(f.dom.all().some(node => node.classList.contains('qm-collection-floor') && f.dom.visible(node)), false);
    assert.equal(warnings.length, 1, 'reported once, not on every paint');
    const plain = fixture(t, [entry('one')], {locateFloor: () => () => 3});
    await plain.view.open();
    assert.equal(plain.dom.all().some(node => node.classList.contains('qm-collection-floor') && plain.dom.visible(node)), false, 'no jump action: no tag');
});

test('multi-select button cycles enter → select all loaded → clear and leave; titles follow', async t => {
    const f = fixture(t, [entry('one'), entry('two')]); await f.view.open();
    const multi = f.dom.get('多选收藏'), pressed = () => list(f).querySelectorAll('.qm-collection-entry[aria-pressed="true"]').length;
    assert.equal(multi.title, '多选收藏');
    click(f, '多选收藏'); assert.equal(multi.getAttribute('aria-pressed'), 'true'); assert.equal(pressed(), 0);
    assert.equal(multi.title, '全选已加载收藏'); assert.ok(f.dom.visible(f.dom.get('删除选中收藏')));
    click(f, '多选收藏'); assert.equal(pressed(), 2); assert.equal(multi.title, '取消多选');
    click(f, '多选收藏'); assert.equal(multi.getAttribute('aria-pressed'), 'false'); assert.equal(pressed(), 0);
    assert.equal(multi.title, '多选收藏'); assert.equal(f.dom.visible(f.dom.get('删除选中收藏')), false);
    click(f, '多选收藏'); click(f, '选择收藏：one'); click(f, '选择收藏：two');
    assert.equal(multi.title, '取消多选', 'selecting every row by hand reaches the same last step');
    assert.equal(f.writes, 0);
});

test('clicking empty list or panel space leaves multi-select; rows and toolbar controls do not', async t => {
    const f = fixture(t, [entry('one'), entry('two')], {tagRules: {read: () => undefined, write() {}}}); await f.view.open();
    const multi = f.dom.get('多选收藏');
    click(f, '多选收藏'); click(f, '选择收藏：one');
    f.dom.get('搜索收藏').emit('click'); click(f, '标签规则'); click(f, '标签规则');
    assert.equal(multi.getAttribute('aria-pressed'), 'true', 'toolbar controls keep the selection');
    list(f).querySelector('.qm-collection-row').emit('click');
    assert.equal(multi.getAttribute('aria-pressed'), 'true', 'a row keeps the selection');
    list(f).emit('click');
    assert.equal(multi.getAttribute('aria-pressed'), 'false'); assert.equal(f.dom.visible(f.dom.get('删除选中收藏')), false);
    click(f, '多选收藏'); f.dom.byClass('qm-collection-panel').emit('click');
    assert.equal(multi.getAttribute('aria-pressed'), 'false', 'the panel background leaves too');
});

test('each list row ends with a direct delete that hides during multi-select', async t => {
    const f = fixture(t, [entry('one'), entry('two')]); await f.view.open();
    const row = list(f).querySelector('.qm-collection-row');
    assert.equal(row.children.at(-1).getAttribute('aria-label'), '删除收藏：one', 'delete is the last control of the row');
    click(f, '多选收藏'); assert.equal(f.dom.get('删除收藏：one'), undefined);
    click(f, '多选收藏'); click(f, '多选收藏');
    click(f, '删除收藏：one'); await waitReady(f);
    assert.deepEqual(f.collection.state().items.map(item => item.id), ['two']); assert.equal(f.writes, 1);
    f.writeHook(() => { throw Object.assign(Error('offline'), {code: 'st_account_storage_unavailable'}); });
    click(f, '删除收藏：two'); await waitReady(f);
    assert.equal(f.collection.state().items.length, 1, 'a failed delete keeps the row');
    assert.notEqual(f.dom.status().textContent, '');
});

test('a floor tag stays before the row delete button', async t => {
    const f = fixture(t, [entry('one')], {locateFloor: () => () => 3, onJumpFloor: () => {}}); await f.view.open();
    const row = list(f).querySelector('.qm-collection-row');
    assert.deepEqual(row.children.map(node => node.getAttribute('aria-label')), ['阅读收藏：one', '跳到第 3 层', '删除收藏：one']);
});

test('tag rules sheet edits the same rows as 取材 and saves only named rules', async t => {
    let stored; const writes = [];
    const f = fixture(t, [entry('one')], {tagRules: {read: () => stored, write: value => { stored = value; writes.push(structuredClone(value)); }}});
    await f.view.open();
    const sheet = f.dom.byClass('qm-collection-rules');
    assert.equal(f.dom.visible(sheet), false);
    click(f, '标签规则'); assert.ok(f.dom.visible(sheet));
    assert.equal(f.dom.get('标签名 1').value, 'thinking', 'unset settings show the default rule');
    assert.equal(f.dom.get('标签处理 1').value, 'remove');
    click(f, '添加标签'); const name = f.dom.get('标签名 2'); name.value = ' <status> '; name.emit('change');
    assert.deepEqual(writes.at(-1), [{name: 'thinking', action: 'remove'}, {name: 'status', action: 'remove'}]);
    assert.equal(name.value, 'status');
    const action = f.dom.get('标签处理 2'); action.value = 'extract'; action.emit('change');
    assert.deepEqual(stored, [{name: 'thinking', action: 'remove'}, {name: 'status', action: 'extract'}]);
    click(f, '添加标签'); assert.equal(writes.length, 2, 'a blank new row saves nothing yet');
    click(f, '删除标签 1'); assert.deepEqual(stored, [{name: 'status', action: 'extract'}]);
    click(f, '删除标签 1'); click(f, '删除标签 1');
    assert.deepEqual(stored, [], 'deleting every rule stores none'); assert.ok(f.dom.get('标签名 1'), 'one blank row stays to fill');
    click(f, '标签规则'); assert.equal(f.dom.visible(sheet), false);
    click(f, '标签规则'); assert.equal(f.dom.get('标签名 1').value, '');
    assert.equal(f.writes, 0, 'rules never touch the collection document');
});

test('items with raw read through ST formatting inside a mes_text container; others stay plain paragraphs', async t => {
    const calls = [];
    const raw = {...entry('raw', 'HP 10'), raw: '<status>HP 10</status>'};
    const f = fixture(t, [entry('plain', '甲\n\n乙'), raw, {...entry('broken', '纯文本'), raw: '<x>'}], {formatRaw: (value, meta) => {
        calls.push([value, meta]); if (value === '<x>') throw Error('formatter failed');
        return `<div class="bar">${value.replace(/<\/?status>/g, '')}</div>`;
    }});
    await f.view.open();
    click(f, '阅读收藏：raw');
    const body = text(f).children[0];
    assert.equal(text(f).children.length, 1);
    assert.equal(body.className, 'mes_text qm-collection-raw');
    assert.equal(body.innerHTML, '<div class="bar">HP 10</div>');
    assert.deepEqual(calls[0], ['<status>HP 10</status>', {charName: '角色甲', source: raw.source}]);
    click(f, '返回收藏列表'); click(f, '阅读收藏：plain');
    assert.deepEqual(text(f).children.map(node => [node.tagName, node.textContent]), [['P', '甲'], ['P', '乙']]);
    click(f, '返回收藏列表'); click(f, '阅读收藏：broken');
    assert.deepEqual(text(f).children.map(node => node.textContent), ['纯文本'], 'a formatter failure falls back to plain text');
});

test('editing a raw item edits its source and re-derives the plain text on save', async t => {
    const f = fixture(t, [{...entry('raw', '旧状态'), raw: '<b>旧状态</b>'}], {formatRaw: value => value.replace(/\*(.+?)\*/g, '<em>$1</em>')});
    await f.view.open(); click(f, '阅读收藏：raw'); click(f, '编辑收藏');
    assert.equal(displayed(f), '<b>旧状态</b>', 'the editor shows the raw source');
    type(f, '<p>*新*状态</p>\n\n<p>第二段 &amp; 尾</p>'); click(f, '保存收藏'); await waitReady(f);
    const saved = f.collection.state().items[0];
    assert.equal(saved.raw, '<p>*新*状态</p>\n\n<p>第二段 &amp; 尾</p>');
    assert.equal(saved.text, '新状态\n\n第二段 & 尾');
    assert.equal(f.writes, 1);
});

test('a full-text capture with raw opens the editor on the source and saves raw with its derived text', async t => {
    const f = fixture(t, null);
    assert.equal(await f.view.collect({text: '整层', raw: '<b>整层</b>', charName: '角色甲', userName: '读者乙', source: null}), true);
    assert.equal(displayed(f), '<b>整层</b>');
    click(f, '保存收藏'); await waitReady(f);
    const saved = f.collection.state().items[0];
    assert.deepEqual([saved.text, saved.raw], ['整层', '<b>整层</b>']);
    assert.equal(f.dom.visible(text(f)), true, 'the saved receipt opens the reader');
    assert.equal(f.collection.state().needsRefresh, false);
});
