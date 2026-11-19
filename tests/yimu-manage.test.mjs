import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createJournal, JOURNAL_RAW_LIMIT } from '../yimu/journal.mjs';
import { completedSlices } from '../yimu/stream-slices.mjs';
import { createDocument, applyOperation, fingerprintMessages } from '../yimu/contract.mjs';
import { createYimuStore, chatStorageName } from '../yimu/server-store.mjs';

const memoryStorage = () => { const map = new Map(); return { getItem: key => map.has(key) ? map.get(key) : null, setItem: (key, value) => { map.set(key, String(value)); }, removeItem: key => { map.delete(key); }, map }; };

test('the journal keeps the newest entries first, bounded in count and in raw size, on this device only', () => {
    const storage = memoryStorage(); let clock = 1000;
    const journal = createJournal({ storage, limit: 3, now: () => clock++ });
    const seen = []; const off = journal.subscribe(() => seen.push(journal.list().length));
    const first = journal.add({ kind: 'summary', status: 'loading', range: { start: 1, end: 10 } });
    journal.add({ kind: 'round', status: 'success', memories: 2 });
    assert.deepEqual(journal.list().map(item => item.kind), ['round', 'summary']);
    assert.equal(journal.update(first, { status: 'success', raw: '原'.repeat(JOURNAL_RAW_LIMIT + 50) }), true);
    const saved = journal.list().find(item => item.id === first);
    assert.equal(saved.status, 'success'); assert.match(saved.raw, /其余 50 字已省略/);
    assert.equal(journal.update('missing', { status: 'error' }), false);
    journal.add({ kind: 'round', status: 'blocked' }); journal.add({ kind: 'round', status: 'blocked' });
    assert.equal(journal.list().length, 3, '超出上限丢最旧的');
    assert.ok(!journal.list().some(item => item.id === first));
    assert.deepEqual(seen, [1, 2, 2, 3, 3]); off();
    // 另一个页面打开同一份本机存储：读得到；改返回的副本不影响日志。
    const again = createJournal({ storage, limit: 3 });
    assert.equal(again.list().length, 3); again.list()[0].status = 'tampered'; assert.notEqual(again.list()[0].status, 'tampered');
    again.clear(); assert.deepEqual(again.list(), []); assert.equal(JSON.parse(storage.map.get('yimu:journal:v1')).length, 0);
});

test('an entry still in progress when the page closed is shown as unfinished, and a full or broken store never throws', () => {
    const storage = memoryStorage();
    const journal = createJournal({ storage }); journal.add({ kind: 'summary', status: 'loading' });
    const reopened = createJournal({ storage }).list()[0];
    assert.equal(reopened.status, 'cancelled'); assert.match(reopened.error, /页面关闭时尚未完成/);
    // 流式过程中的高频更新只改内存，不落盘。
    const id = journal.add({ kind: 'summary', status: 'loading' }), before = storage.map.get('yimu:journal:v1');
    journal.update(id, { raw: '接收中' }, { persist: false });
    assert.equal(storage.map.get('yimu:journal:v1'), before); assert.equal(journal.list()[0].raw, '接收中');
    const full = { getItem: () => '不是 JSON', setItem() { throw new Error('quota'); } };
    const tolerant = createJournal({ storage: full });
    assert.deepEqual(tolerant.list(), []);
    assert.doesNotThrow(() => tolerant.add({ kind: 'round', status: 'success' }));
    assert.equal(tolerant.list().length, 1, '存不下时本次会话仍可看');
    assert.doesNotThrow(() => createJournal({ storage: null }).add({ kind: 'round' }));
});

test('only slices that are complete in the stream are shown; the one still being written is not', () => {
    const full = { slices: [{ start: 1, end: 3, title: '初见', text: '两人在桥边初见，她说：“{别走}”。', scenes: [{ place: '桥', evidence: { floors: [1] } }] }, { start: 4, end: 6, title: '同行', text: '结伴赶路。' }] };
    const text = JSON.stringify(full);
    assert.deepEqual(completedSlices(text).map(slice => [slice.start, slice.end, slice.title]), [[1, 3, '初见'], [4, 6, '同行']]);
    assert.equal(completedSlices(text)[0].text, '两人在桥边初见，她说：“{别走}”。');
    // 第二片写到一半：只出第一片。花括号与转义引号出现在正文字符串里不会误判。
    const cut = text.indexOf('"title":"同行"');
    assert.deepEqual(completedSlices(text.slice(0, cut)).map(slice => slice.title), ['初见']);
    const tricky = '{"slices":[{"start":1,"end":1,"text":"他说 \\"}{\\" 然后离开"},{"start":2,"end":2,"text":"未完';
    assert.deepEqual(completedSlices(tricky).map(slice => slice.text), ['他说 "}{" 然后离开']);
    for (const partial of ['', '{"sli', '{"slices":', '{"slices":[', '{"slices":[{"start":1', '不是 JSON']) assert.deepEqual(completedSlices(partial), []);
    assert.deepEqual(completedSlices(undefined), []);
    assert.deepEqual(completedSlices('{"slices":[{"start":1,"end":1,"text":"  "}]}'), [], '空正文的不算成形');
    assert.equal(completedSlices('```json\n' + text + '\n```').length, 2, '模型包了代码围栏也照常取');
});

const binding = { avatar: 'Manage.png', file: 'Managed chat', integrity: 'manage-identity' };
const messages = Array.from({ length: 12 }, (_, i) => ({ name: i % 2 ? '甲' : '乙', is_user: i % 2 === 0, mes: `合成第 ${i + 1} 层正文。`, send_date: String(i) }));
async function seeded() {
    const hashes = await fingerprintMessages(messages);
    let doc = applyOperation(createDocument(binding), { id: 'enable', type: 'enable', enabled: true, expectedRevision: 0, range: { start: 1, end: 12, total: 12 } }).document;
    for (const [id, start, end] of [['a', 1, 2], ['b', 3, 4], ['c', 5, 6]]) doc = applyOperation(doc, { id: `add-${id}`, type: 'append', expectedEpoch: doc.epoch,
        entry: { id, kind: 'summary', text: `切片 ${id} 的正文`, source: { start, end, hashes: hashes.slice(start - 1, end) } } }).document;
    doc = applyOperation(doc, { id: 'stage', type: 'append', expectedEpoch: doc.epoch, entry: { id: 'st', kind: 'stage', text: '阶段摘要', source: { parents: ['a', 'b'].map(id => ({ id, revision: doc.entries.find(e => e.id === id).revision })) } } }).document;
    doc = applyOperation(doc, { id: 'add-manual', type: 'append', entry: { id: 'mine', kind: 'manual', text: '用户自己写的一条', source: null, placement: { binding, fromFloor: 8, hash: hashes[7] } } }).document;
    doc = applyOperation(doc, { id: 'drop-c', type: 'entry', action: 'delete', entryId: 'c', expectedRevision: doc.entries.find(e => e.id === 'c').revision }).document;
    return { doc, hashes };
}

test('purge clears only Yimu\'s own document: everything, everything but custom slices, or just the old records', async () => {
    const { doc } = await seeded();
    assert.throws(() => applyOperation(doc, { id: 'p0', type: 'purge', scope: 'floors', expectedRevision: doc.revision }), /清理范围无效/);
    assert.throws(() => applyOperation(doc, { id: 'p1', type: 'purge', scope: 'all', expectedRevision: doc.revision - 1 }), /已在别处变化/);
    const all = applyOperation(doc, { id: 'p2', type: 'purge', scope: 'all', expectedRevision: doc.revision }).document;
    assert.deepEqual(all.entries, []); assert.deepEqual(all.entryOrder, []);
    assert.equal(all.enabled, true, '启用状态保留'); assert.deepEqual(all.initialRange, doc.initialRange, '自动总结起点保留');
    assert.deepEqual(all.operations, ['p2'], '旧操作回执（含每条记忆的原文）一并丢掉');
    const keep = applyOperation(doc, { id: 'p3', type: 'purge', scope: 'all', keepManual: true, expectedRevision: doc.revision }).document;
    assert.deepEqual(keep.entries.map(entry => entry.id), ['mine']); assert.equal(keep.entries[0].text, '用户自己写的一条');
    const traces = applyOperation(doc, { id: 'p4', type: 'purge', scope: 'traces', expectedRevision: doc.revision }).document;
    assert.deepEqual(traces.entries.map(entry => entry.id).sort(), ['a', 'b', 'mine', 'st'], '只清掉已删除的那条');
    assert.equal(traces.entries.find(entry => entry.id === 'st').status, 'active');
    // 仍被别的条目引用的旧记录不清：阶段摘要依赖它。
    const withDeletedParent = structuredClone(doc); withDeletedParent.entries.find(entry => entry.id === 'a').status = 'deleted';
    const guarded = applyOperation(withDeletedParent, { id: 'p5', type: 'purge', scope: 'traces', expectedRevision: withDeletedParent.revision }).document;
    assert.ok(guarded.entries.some(entry => entry.id === 'a'), '被阶段摘要引用的旧记录保留');
    assert.ok(!guarded.entries.some(entry => entry.id === 'c'));
});

async function serverFixture(t) {
    const parent = await fs.realpath(os.tmpdir()), root = await fs.mkdtemp(path.join(parent, 'yimu-manage-test-'));
    const account = path.join(root, 'account'), chats = path.join(account, 'chats');
    await fs.mkdir(path.join(chats, 'Manage'), { recursive: true });
    const request = { user: { profile: { handle: 'fixture' }, directories: { root: account, chats } } };
    const chatFile = name => path.join(chats, 'Manage', `${name}.jsonl`);
    const writeChat = (name, identity) => fs.writeFile(chatFile(name), [{ chat_metadata: { integrity: identity } }, ...messages].map(row => JSON.stringify(row)).join('\n'), 'utf8');
    t.after(() => fs.rm(root, { recursive: true }));
    return { store: createYimuStore({ hostCwd: root }), request, account, writeChat, chatFile };
}

test('the server lists every chat\'s memory file for this account and deletes one only when it still matches', async t => {
    const f = await serverFixture(t);
    const other = { avatar: 'Manage.png', file: 'Gone chat', integrity: 'gone-identity' };
    await f.writeChat(binding.file, binding.integrity); await f.writeChat(other.file, other.integrity);
    assert.deepEqual((await f.store.manageList(f.request)).items, []);
    for (const [index, target] of [binding, other].entries()) await f.store.change(f.request, target, { id: `enable_${index}`, type: 'enable', enabled: true, expectedRevision: 0, range: { start: 1, end: 12, total: 12 } });
    const hashes = await fingerprintMessages(messages);
    const epoch = (await f.store.read(f.request, binding)).document.epoch;
    await f.store.change(f.request, binding, { id: 'add', type: 'append', expectedEpoch: epoch, entry: { id: 'slice', kind: 'summary', text: '一条切片', source: { start: 1, end: 2, hashes: hashes.slice(0, 2) } } });
    await fs.rm(f.chatFile(other.file)); // 原聊天被删了，忆幕文件还在
    const { items } = await f.store.manageList(f.request);
    assert.equal(items.length, 2);
    const mine = items.find(item => item.binding.file === binding.file), gone = items.find(item => item.binding.file === other.file);
    assert.equal(mine.name, chatStorageName(binding)); assert.equal(mine.slices, 1); assert.equal(mine.sourceExists, true); assert.equal(mine.enabled, true); assert.ok(mine.bytes > 0);
    assert.equal(gone.sourceExists, false); assert.equal(gone.slices, 0);
    assert.ok(!JSON.stringify(items).includes('一条切片'), '列表不带记忆正文');
    // 修订号对不上、文件名与聊天不符、文件名不合法：都不删。
    await assert.rejects(f.store.manageDelete(f.request, { name: mine.name, binding, expectedRevision: mine.revision - 1 }), /已有新的修改/);
    await assert.rejects(f.store.manageDelete(f.request, { name: mine.name, binding: other, expectedRevision: mine.revision }), /不符/);
    await assert.rejects(f.store.manageDelete(f.request, { name: '../defaults.json' }), /文件名无效/);
    assert.equal((await f.store.manageList(f.request)).items.length, 2);
    assert.deepEqual(await f.store.manageDelete(f.request, { name: gone.name, binding: other, expectedRevision: gone.revision }), { deleted: true, name: gone.name });
    assert.deepEqual((await f.store.manageList(f.request)).items.map(item => item.binding.file), [binding.file]);
    assert.deepEqual(await f.store.manageDelete(f.request, { name: gone.name }), { deleted: false, missing: true });
    // 聊天原文从不触碰；默认设置等其他文件也不在列表里。
    assert.ok((await fs.stat(f.chatFile(binding.file))).size > 0);
    await f.store.defaults(f.request);
    assert.equal((await f.store.manageList(f.request)).items.length, 1);
});

test('one chat\'s memory can be exported from the file list even after its chat file is gone', async t => {
    const f = await serverFixture(t);
    await f.writeChat(binding.file, binding.integrity);
    await f.store.change(f.request, binding, { id: 'enable_x', type: 'enable', enabled: true, expectedRevision: 0, range: { start: 1, end: 12, total: 12 } });
    const hashes = await fingerprintMessages(messages), epoch = (await f.store.read(f.request, binding)).document.epoch;
    await f.store.change(f.request, binding, { id: 'add_x', type: 'append', expectedEpoch: epoch, entry: { id: 'slice', kind: 'summary', text: '要导出的一条切片', source: { start: 1, end: 2, hashes: hashes.slice(0, 2) } } });
    await fs.rm(f.chatFile(binding.file));
    const plan = await f.store.backupPlan(f.request, binding);
    assert.ok(plan.planId);
    const result = await f.store.backupExport(f.request, binding, { planId: plan.planId, sourceIds: [] });
    const chunks = []; for await (const chunk of result.stream) chunks.push(Buffer.from(chunk));
    assert.ok(Buffer.concat(chunks).length > 0, '只含记忆的备份可以生成');
    assert.match(result.filename, /\.yimu\.gz$/);
});
