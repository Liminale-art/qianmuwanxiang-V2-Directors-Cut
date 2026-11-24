// 聊天工具包从备份找回聊天后，副本是新的聊天身份：服务端按原聊天身份找到原来的忆幕记忆，复制一份给副本。
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fingerprintMessages } from '../yimu/contract.mjs';
import { createYimuStore } from '../yimu/server-store.mjs';

const original = { avatar: 'Hero.png', file: 'Old story', integrity: 'old-identity' };
const copy = { avatar: 'Hero.png', file: 'Hero - recovered', integrity: 'copy-identity' };
const other = { avatar: 'Other.png', file: 'Other - recovered', integrity: 'other-copy' };
const messages = Array.from({ length: 8 }, (_, i) => ({ name: i % 2 ? '甲' : '乙', is_user: i % 2 === 0, mes: `第 ${i + 1} 层正文。`, send_date: String(i) }));

async function fixture(t) {
    const parent = await fs.realpath(os.tmpdir()), root = await fs.mkdtemp(path.join(parent, 'yimu-follow-test-'));
    const account = path.join(root, 'account'), chats = path.join(account, 'chats');
    for (const folder of ['Hero', 'Other']) await fs.mkdir(path.join(chats, folder), { recursive: true });
    const request = { user: { profile: { handle: 'fixture' }, directories: { root: account, chats } } };
    const chatFile = binding => path.join(chats, binding.avatar.replace(/\.png$/, ''), `${binding.file}.jsonl`);
    const writeChat = binding => fs.writeFile(chatFile(binding), [{ chat_metadata: { integrity: binding.integrity } }, ...messages].map(row => JSON.stringify(row)).join('\n'), 'utf8');
    t.after(() => fs.rm(root, { recursive: true }));
    const store = createYimuStore({ hostCwd: root });
    for (const binding of [original, copy, other]) await writeChat(binding);
    const hashes = await fingerprintMessages(messages);
    await store.change(request, original, { id: 'enable_o', type: 'enable', enabled: true, expectedRevision: 0, range: { start: 1, end: 8, total: 8 } });
    const epoch = (await store.read(request, original)).document.epoch;
    for (const [id, start, end] of [['a', 1, 2], ['b', 3, 4]]) await store.change(request, original, { id: `add_${id}`, type: 'append', expectedEpoch: epoch,
        entry: { id, kind: 'summary', text: `切片 ${id}`, source: { start, end, hashes: hashes.slice(start - 1, end) } } });
    return { store, request, chatFile };
}

test('a recovered copy receives the original memory, sources intact; the original stays as it was', async t => {
    const f = await fixture(t);
    const result = await f.store.manageFollow(f.request, { source: { integrity: original.integrity }, target: copy });
    assert.deepEqual(result, { copied: true, slices: 2 });
    const doc = (await f.store.read(f.request, copy)).document;
    assert.deepEqual(doc.binding, copy);
    assert.equal(doc.enabled, true);
    assert.deepEqual(doc.entries.map(entry => [entry.id, entry.source.start, entry.source.end]), [['a', 1, 2], ['b', 3, 4]]);
    assert.equal((await f.store.read(f.request, original)).document.entries.length, 2, '原记忆不动');
});

test('works after the original chat file is gone, and into another character', async t => {
    const f = await fixture(t);
    await fs.rm(f.chatFile(original));
    assert.equal((await f.store.manageFollow(f.request, { source: { integrity: original.integrity }, target: other })).copied, true);
    assert.equal((await f.store.read(f.request, other)).document.entries.length, 2);
});

test('never overwrites a copy that already has memory, and does nothing when no memory matches', async t => {
    const f = await fixture(t);
    await f.store.manageFollow(f.request, { source: { integrity: original.integrity }, target: copy });
    assert.deepEqual(await f.store.manageFollow(f.request, { source: { integrity: original.integrity }, target: copy }), { copied: false, exists: true });
    assert.deepEqual(await f.store.manageFollow(f.request, { source: { integrity: 'nobody' }, target: other }), { copied: false, missing: true });
    assert.equal((await f.store.read(f.request, other)).document.entries.length, 0);
    await assert.rejects(f.store.manageFollow(f.request, { source: { integrity: copy.integrity }, target: copy }), /身份相同/);
    await assert.rejects(f.store.manageFollow(f.request, { source: { integrity: original.integrity }, target: { ...copy, file: 'missing' } }), /找不到/);
});
