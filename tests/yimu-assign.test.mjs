// 记忆文件的指定与打包：把另一份记忆带进当前聊天（独立记忆）、原文不同的备份导入、多份打成一个文件。
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createDocument, applyOperation, fingerprintMessages, portableMemories } from '../yimu/contract.mjs';
import { createYimuStore, chatStorageName } from '../yimu/server-store.mjs';
import { packBackups, unpackBackups, isBackupPack } from '../yimu/backup-runtime.mjs';

const source = { avatar: 'Hero.png', file: 'Old story', integrity: 'old-identity' };
const target = { avatar: 'Hero.png', file: 'New story', integrity: 'new-identity' };
const lines = (label, count) => Array.from({ length: count }, (_, i) => ({ name: i % 2 ? '甲' : '乙', is_user: i % 2 === 0, mes: `${label}第 ${i + 1} 层正文。`, send_date: String(i) }));
const oldMessages = lines('旧聊天', 12), newMessages = lines('新聊天', 6);

async function seededSource() {
    const hashes = await fingerprintMessages(oldMessages);
    let doc = applyOperation(createDocument(source), { id: 'enable', type: 'enable', enabled: true, expectedRevision: 0, range: { start: 1, end: 12, total: 12 } }).document;
    for (const [id, start, end] of [['a', 1, 2], ['b', 3, 4], ['c', 5, 6], ['d', 7, 8]]) doc = applyOperation(doc, { id: `add-${id}`, type: 'append', expectedEpoch: doc.epoch,
        entry: { id, kind: 'summary', title: `片${id}`, text: `切片 ${id} 的正文`, source: { start, end, hashes: hashes.slice(start - 1, end) },
            scenes: id === 'd' ? [{ world: '现世', date: '1999-01-02', place: '码头', evidence: { floors: [7] } }] : undefined } }).document;
    doc = applyOperation(doc, { id: 'stage', type: 'append', expectedEpoch: doc.epoch, entry: { id: 'st', kind: 'stage', text: '阶段摘要', source: { parents: ['a', 'b'].map(id => ({ id, revision: doc.entries.find(e => e.id === id).revision })) } } }).document;
    doc = applyOperation(doc, { id: 'add-manual', type: 'append', entry: { id: 'mine', kind: 'manual', text: '用户自己写的一条', source: null, placement: { binding: source, fromFloor: 8, hash: hashes[7] } } }).document;
    doc = applyOperation(doc, { id: 'drop-c', type: 'entry', action: 'delete', entryId: 'c', expectedRevision: doc.entries.find(e => e.id === 'c').revision }).document;
    return doc;
}

test('what travels: stages plus slices not folded into a stage, in order; deleted ones and floor evidence stay behind', async () => {
    const carried = portableMemories(await seededSource());
    assert.deepEqual(carried.map(item => item.text).sort(), ['切片 d 的正文', '用户自己写的一条', '阶段摘要'].sort());
    assert.ok(!carried.some(item => /切片 [abc] /.test(item.text)), '并入阶段的与已删除的不带');
    const d = carried.find(item => item.text === '切片 d 的正文');
    assert.equal(d.title, '片d'); assert.equal(d.scenes[0].place, '码头'); assert.deepEqual(d.scenes[0].evidence, { floors: [], user: true }, '旧聊天的楼层依据不带过去');
    assert.deepEqual(portableMemories(createDocument(source)), []);
});

test('adopting writes independent custom slices anchored to the chat; nothing claims floors of this chat', async () => {
    const hashes = await fingerprintMessages(newMessages), placement = { binding: target, fromFloor: 1, hash: hashes[0] };
    const entries = portableMemories(await seededSource());
    const before = createDocument(target);
    const { document: doc } = applyOperation(before, { id: 'adopt_1', type: 'adopt', entries, placement });
    assert.equal(doc.entries.length, entries.length);
    assert.ok(doc.entries.every(entry => entry.kind === 'manual' && entry.source === null && !entry.origin && entry.status === 'active' && entry.placement.fromFloor === 1));
    assert.deepEqual(doc.entryOrder.map(id => doc.entries.find(entry => entry.id === id).text), entries.map(item => item.text), '先后顺序保持');
    assert.equal(applyOperation(doc, { id: 'adopt_1', type: 'adopt', entries, placement }).outcome, 'duplicate', '同一次操作重发不会带入两遍');
    assert.throws(() => applyOperation(before, { id: 'adopt_2', type: 'adopt', entries: [], placement }), /没有可带入的记忆/);
    assert.throws(() => applyOperation(before, { id: 'adopt_3', type: 'adopt', entries, placement: { ...placement, binding: source } }), /不属于当前聊天/);
});

async function serverFixture(t) {
    const parent = await fs.realpath(os.tmpdir()), root = await fs.mkdtemp(path.join(parent, 'yimu-assign-test-'));
    const account = path.join(root, 'account'), chats = path.join(account, 'chats');
    await fs.mkdir(path.join(chats, 'Hero'), { recursive: true });
    const request = { user: { profile: { handle: 'fixture' }, directories: { root: account, chats } } };
    const chatFile = name => path.join(chats, 'Hero', `${name}.jsonl`);
    const writeChat = (binding, messages) => fs.writeFile(chatFile(binding.file), [{ chat_metadata: { integrity: binding.integrity } }, ...messages].map(row => JSON.stringify(row)).join('\n'), 'utf8');
    t.after(() => fs.rm(root, { recursive: true }));
    const store = createYimuStore({ hostCwd: root });
    await writeChat(source, oldMessages); await writeChat(target, newMessages);
    const hashes = await fingerprintMessages(oldMessages);
    await store.change(request, source, { id: 'enable_s', type: 'enable', enabled: true, expectedRevision: 0, range: { start: 1, end: 12, total: 12 } });
    const epoch = (await store.read(request, source)).document.epoch;
    for (const [id, start, end] of [['a', 1, 2], ['b', 3, 4]]) await store.change(request, source, { id: `add_${id}`, type: 'append', expectedEpoch: epoch,
        entry: { id, kind: 'summary', text: `旧聊天的切片 ${id}`, source: { start, end, hashes: hashes.slice(start - 1, end) } } });
    return { store, request, chatFile, placement: { fromFloor: 1, hash: (await fingerprintMessages(newMessages))[0] } };
}

test('the server assigns another chat\'s memory file to this chat, leaving the original file and the chat text alone', async t => {
    const f = await serverFixture(t);
    const item = (await f.store.manageList(f.request)).items.find(value => value.binding.file === source.file);
    const result = await f.store.manageAssign(f.request, { name: item.name, target, placement: f.placement, id: 'assign_1' });
    assert.equal(result.adopted, 2);
    const doc = (await f.store.read(f.request, target)).document;
    assert.deepEqual(doc.entries.map(entry => [entry.kind, entry.text]), [['manual', '旧聊天的切片 a'], ['manual', '旧聊天的切片 b']]);
    assert.equal(doc.enabled, false, '带入不会顺手替用户启用忆幕');
    // 原文件原样；原聊天已不在时也照样能指定。
    assert.equal((await f.store.read(f.request, source)).document.entries.filter(entry => entry.kind === 'summary').length, 2);
    await fs.rm(f.chatFile(source.file));
    assert.equal((await f.store.manageAssign(f.request, { name: item.name, target, placement: f.placement, id: 'assign_2' })).adopted, 2);
    assert.equal((await f.store.read(f.request, target)).document.entries.length, 4, '再指定一次就是再带入一遍，由用户自己决定');
    // 拦下的情况：指定给自己、锚点不是这个聊天的首层原文、文件名不合法。
    await assert.rejects(f.store.manageAssign(f.request, { name: chatStorageName(target), target, placement: f.placement, id: 'assign_3' }), /当前聊天自己的记忆/);
    await assert.rejects(f.store.manageAssign(f.request, { name: item.name, target, placement: { fromFloor: 1, hash: 'f'.repeat(64) }, id: 'assign_4' }));
    await assert.rejects(f.store.manageAssign(f.request, { name: '../defaults.json', target, placement: f.placement, id: 'assign_5' }), /文件名无效/);
    assert.equal((await f.store.read(f.request, target)).document.entries.length, 4);
});

test('a backup whose text does not match can be brought into a chosen chat as independent memory; same-character chats are offered first', async t => {
    const f = await serverFixture(t);
    const plan = await f.store.backupPlan(f.request, source);
    const exported = await f.store.backupExport(f.request, source, { planId: plan.planId, sourceIds: [] });
    const chunks = []; for await (const chunk of exported.stream) chunks.push(Buffer.from(chunk));
    await fs.rm(f.chatFile(source.file)); // 原聊天没了：自动认主认不出来
    await fs.mkdir(path.join(path.dirname(path.dirname(f.chatFile('x'))), 'Other'), { recursive: true });
    await fs.writeFile(path.join(path.dirname(path.dirname(f.chatFile('x'))), 'Other', 'Elsewhere.jsonl'), [{ chat_metadata: { integrity: 'else-identity' } }, ...lines('别处', 3)].map(row => JSON.stringify(row)).join('\n'), 'utf8');
    const uploaded = await f.store.backupUpload(f.request, (async function* () { yield Buffer.concat(chunks); })(), 'upload_1');
    const asked = await f.store.backupApply(f.request, uploaded.archive.id, { id: 'apply_1' });
    assert.equal(asked.status, 'selection');
    assert.deepEqual(asked.candidates.map(candidate => [candidate.binding.file, candidate.sameCharacter]), [['New story', true], ['Elsewhere', false]], '同名角色的聊天排在前面');
    const done = await f.store.backupApply(f.request, uploaded.archive.id, { id: 'apply_2', targetBinding: target, detach: { placement: f.placement } });
    assert.equal(done.status, 'complete'); assert.equal(done.outcome, 'adopted'); assert.match(done.message, /2 条独立记忆/);
    const doc = (await f.store.read(f.request, target)).document;
    assert.deepEqual(doc.entries.map(entry => [entry.kind, entry.status, entry.text]), [['manual', 'active', '旧聊天的切片 a'], ['manual', 'active', '旧聊天的切片 b']]);
    assert.equal((await f.store.backupApply(f.request, uploaded.archive.id, { id: 'apply_2', targetBinding: target, detach: { placement: f.placement } })).repeated, true, '同一次导入重发不会带入两遍');
});

test('several backups pack into one file and unpack into the same bytes', async () => {
    const one = new Blob([new Uint8Array([1, 2, 3, 10, 4])]), two = new Blob(['第二份\n带换行的内容']);
    const packed = packBackups([{ blob: one, filename: '甲.yimu.gz' }, { blob: two, filename: '乙.yimu.gz' }], { now: new Date(2026, 10, 19, 21, 5) });
    assert.equal(packed.filename, '忆幕记忆包-2份-20261119-2105.yimupack'); assert.equal(isBackupPack(packed.filename), true); assert.equal(isBackupPack('甲.yimu.gz'), false);
    const parts = await unpackBackups(packed.blob);
    assert.deepEqual(parts.map(part => part.name), ['甲.yimu.gz', '乙.yimu.gz']);
    assert.deepEqual([...new Uint8Array(await parts[0].arrayBuffer())], [1, 2, 3, 10, 4]);
    assert.equal(new TextDecoder().decode(await parts[1].arrayBuffer()), '第二份\n带换行的内容');
    assert.equal(typeof parts[0].stream, 'function');
    await assert.rejects(unpackBackups(new Blob(['不是记忆包'])), /不是忆幕的记忆包/);
    await assert.rejects(unpackBackups(packed.blob.slice(0, packed.blob.size - 3)), /不完整/);
});
