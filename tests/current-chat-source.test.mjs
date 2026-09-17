import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import { captureCurrentChatSource as capture } from '../qianmu-current-chat-source.js';
import { chatFileTarget } from '../qianmu-chat-file-target.js';
import { createCurrentChatCharacterReceiptClient as receiptClient } from '../qianmu-chat-character-receipt-client.js';

function fixture() {
    const eventSource = new EventEmitter(); let epoch = 0;
    const context = { characterId: 0, groupId: null, chatId: 'Chat A', characters: [{ avatar: 'A.png', name: 'same', chat: 'Chat A' }, { avatar: 'B.png', name: 'same', chat: 'Chat A' }],
        groups: [{ id: 'g', chat_id: 'Chat A' }], chat: [], chatMetadata: { integrity: 'host-integrity', story_director_liminale: { keep: true } }, eventSource };
    return { context, options: { getContext: () => context, epoch: () => epoch }, changeEpoch() { epoch++; }, emit: (...args) => eventSource.emit(...args),
        listeners: () => eventSource.eventNames().reduce((sum, name) => sum + eventSource.listenerCount(name), 0) };
}
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };

test('shared source freezes exact file owner and locator without leaking or modifying host objects', () => {
    const f = fixture(), before = JSON.stringify(f.context.chatMetadata), s = capture(f.options);
    assert.deepEqual(s.target, { kind: 'character', chatId: 'Chat A', avatar: 'A.png' });
    assert.deepEqual(s.source, { ownerKey: 'char:A.png', chatKey: 'Chat A' }); assert.equal(s.integrity, 'host-integrity');
    assert.ok(Object.isFrozen(s) && Object.isFrozen(s.source) && Object.isFrozen(s.target));
    assert.equal(Object.hasOwn(s, 'metadata'), false); assert.equal(Object.hasOwn(s, 'messages'), false);
    assert.equal(f.listeners(), 5); s.close(); assert.equal(f.listeners(), 0); assert.equal(JSON.stringify(f.context.chatMetadata), before);
});
test('same display names and cloned host integrity do not merge independent characters or group zero', () => {
    const f = fixture(), a = capture(f.options); f.context.characterId = 1; const b = capture(f.options);
    assert.notDeepEqual(a.source, b.source); assert.equal(a.integrity, b.integrity); assert.equal(a.isCurrent(), false); b.close();
    f.context.groupId = 0; f.context.groups = [{ id: 0, chat_id: 'Chat A' }]; const g = capture(f.options);
    assert.deepEqual(g.source, { ownerKey: 'group:0', chatKey: 'Chat A' }); g.close(); assert.equal(f.listeners(), 0);
});
test('legacy missing integrity remains absent and is not silently minted into metadata', () => {
    const f = fixture(); delete f.context.chatMetadata.integrity; const before = JSON.stringify(f.context.chatMetadata), s = capture(f.options);
    assert.equal(s.integrity, null); assert.equal(s.isCurrent(), true); s.close(); assert.equal(JSON.stringify(f.context.chatMetadata), before);
});
test('in-place integrity replacement invalidates forever even if host object and filenames are reused', () => {
    const f = fixture(), s = capture(f.options); f.context.chatMetadata.integrity = 'replacement';
    assert.equal(s.isCurrent(), false); f.context.chatMetadata.integrity = 'host-integrity'; assert.equal(s.isCurrent(), false); assert.equal(f.listeners(), 0);
});
test('temporarily invalid context cannot revive an observed invalidated source', () => {
    const f = fixture(), metadata = f.context.chatMetadata, s = capture(f.options); f.context.chatMetadata = null;
    assert.equal(s.isCurrent(), false); f.context.chatMetadata = metadata; assert.equal(s.isCurrent(), false); assert.equal(f.listeners(), 0);
});
test('reload, A-B-A epoch, replaced emitter and duplicate avatar identities invalidate source', () => {
    for (const change of [f => { f.context.chat = []; }, f => { f.context.chatMetadata = structuredClone(f.context.chatMetadata); },
        f => { f.context.chatMetadata.story_director_liminale = {}; }, f => f.changeEpoch(), f => { f.context.eventSource = new EventEmitter(); },
        f => { f.context.characters.push({ avatar: 'A.png', chat: 'Chat A' }); }]) {
        const f = fixture(), s = capture(f.options); change(f); assert.equal(s.isCurrent(), false); assert.equal(f.listeners(), 0);
    }
});
test('owner-qualified rename invalidates only matching old source and never adopts requested new filename', () => {
    const f = fixture(), s = capture(f.options);
    f.emit('chat_renamed', { avatarId: 'B.png', oldFileName: 'Chat A.jsonl', newFileName: 'other.jsonl' }); assert.equal(s.isCurrent(), true);
    f.emit('chat_renamed', { avatarId: 'A.png', oldFileName: 'Other.jsonl', newFileName: 'Chat A.jsonl' }); assert.equal(s.isCurrent(), true);
    f.emit('chat_renamed', { avatarId: 'A.png', oldFileName: 'Chat A.jsonl', newFileName: 'UNTRUSTED?.jsonl' });
    assert.equal(s.isCurrent(), false); assert.equal(s.source.chatKey, 'Chat A'); assert.equal(f.context.chatId, 'Chat A'); assert.equal(f.listeners(), 0);
});
test('group rename respects the exact group and does not fall back to a character avatar', () => {
    const f = fixture(); f.context.groupId = 'g'; const s = capture(f.options);
    f.emit('chat_renamed', { groupId: 'other', oldFileName: 'Chat A.jsonl' }); assert.equal(s.isCurrent(), true);
    f.emit('chat_renamed', { avatarId: 'A.png', oldFileName: 'Chat A.jsonl' }); assert.equal(s.isCurrent(), true);
    f.emit('chat_renamed', { groupId: 'g', oldFileName: 'Chat A.jsonl' }); assert.equal(s.isCurrent(), false); assert.equal(f.listeners(), 0);
});
test('ownerless or malformed matching rename is conservative cancellation, not a move', () => {
    for (const event of [undefined, {}, { oldFileName: 'Chat A.jsonl' }, { oldFileName: 'Chat A.jsonl', groupId: {} }]) {
        const f = fixture(), s = capture(f.options), before = JSON.stringify(f.context.chatMetadata); f.emit('chat_renamed', event);
        assert.equal(s.isCurrent(), false); assert.equal(JSON.stringify(f.context.chatMetadata), before); assert.equal(f.listeners(), 0);
    }
});
test('deletion without owner can cancel a same-name scope but never deletes metadata or artifacts', () => {
    const f = fixture(), before = JSON.stringify(f.context.chatMetadata), s = capture(f.options);
    f.emit('chat_deleted', 'Other'); f.emit('group_chat_deleted', 'Chat A'); assert.equal(s.isCurrent(), true);
    f.emit('chat_deleted', 'Chat A'); assert.equal(s.isCurrent(), false); assert.equal(JSON.stringify(f.context.chatMetadata), before); assert.equal(f.listeners(), 0);
    const g = fixture(); g.context.groupId = 'g'; const group = capture(g.options); g.emit('chat_deleted', 'Chat A'); assert.equal(group.isCurrent(), true);
    g.emit('group_chat_deleted', 'Chat A'); assert.equal(group.isCurrent(), false); assert.equal(g.listeners(), 0);
});
test('change and load notifications cancel without relying on delayed host epoch updates', () => {
    for (const event of ['chat_changed','chat_loaded']) {
        const f = fixture(), s = capture(f.options); if (event === 'chat_loaded') f.context.chatMetadata = structuredClone(f.context.chatMetadata);
        f.emit(event); assert.equal(s.isCurrent(), false); assert.equal(f.listeners(), 0);
    }
});
test('trailing host load notification does not invalidate the fresh scope rendered after CHAT_CHANGED', () => {
    const f = fixture(), old = capture(f.options); f.emit('chat_changed'); assert.equal(old.isCurrent(), false);
    const current = capture(f.options); f.emit('chat_loaded', { detail: { id: 0 } });
    assert.equal(current.isCurrent(), true); assert.equal(f.listeners(), 5); current.close(); assert.equal(f.listeners(), 0);
});
test('custom host event names and off-only emitters retain exact listener ownership', () => {
    const f = fixture(), emitter = f.context.eventSource;
    f.context.eventTypes = { CHAT_CHANGED: 'custom-change' }; f.context.eventSource = { on: emitter.on.bind(emitter), off: emitter.off.bind(emitter) };
    const s = capture(f.options); f.emit('chat_changed'); assert.equal(s.isCurrent(), true); f.emit('custom-change'); assert.equal(s.isCurrent(), false); assert.equal(f.listeners(), 0);
});
test('partially installed listeners and immediately replayed events cannot leak a borrowed scope', () => {
    for (const replay of [false,true]) {
        const f = fixture(), emitter = f.context.eventSource; let count = 0;
        f.context.eventSource = { removeListener: emitter.removeListener.bind(emitter), on(type, listener) {
            emitter.on(type, listener); count++; if (replay && count === 1) listener(); else if (!replay && count === 2) throw Error('subscription failed');
        } };
        assert.throws(() => capture(f.options)); assert.equal(f.listeners(), 0);
    }
});
test('read-only callers without a removable emitter rely on explicit epoch, never attach unremovable listeners', () => {
    const f = fixture(); let attached = 0; f.context.eventSource = { on() { attached++; } };
    const s = capture(f.options); assert.equal(attached, 0); f.changeEpoch(); assert.equal(s.isCurrent(), false);
});
test('invalid target and integrity inputs fail before acquiring event listeners', () => {
    for (const patch of [{ chatId: '' }, { characters: [{ avatar: 'A.png', chat: 'Other' }] }, { chatMetadata: { integrity: {} } }, { chatMetadata: { integrity: 'x\ny' } }, { groupId: 'missing' }]) {
        const f = fixture(); Object.assign(f.context, patch); assert.throws(() => capture(f.options)); assert.equal(f.listeners(), 0);
    }
    for (const target of [{ kind: 'group', chatId: '../escape' }, { kind: 'group', chatId: 'a\ud800' }, { kind: 'character', chatId: 'a', avatar: 'name.jpg' }, { kind: 'group', chatId: 'a', namespace: 'invented' }]) assert.throws(() => chatFileTarget(target));
});
test('receipt creation failures release shared source listeners', async () => {
    const f = fixture(); await assert.rejects(receiptClient({ ...f.options, account: async () => { throw Error('account not ready'); } })); assert.equal(f.listeners(), 0);
});
test('rename during account resolution prevents delayed receipt request and releases listeners', async () => {
    const f = fixture(), gate = deferred(), entered = deferred(); let calls = 0;
    const task = receiptClient({ ...f.options, account: async () => { entered.resolve(); await gate.promise; return 'st-user:alice'; }, fetchImpl: async () => { calls++; } });
    const rejected = assert.rejects(task); await entered.promise; f.emit('chat_renamed', { avatarId: 'A.png', oldFileName: 'Chat A.jsonl', newFileName: 'New.jsonl' }); gate.resolve(); await rejected;
    assert.equal(calls, 0); assert.equal(f.listeners(), 0);
});
test('existing receipt clients reject replaced integrity and are fully disposed on close', async () => {
    const f = fixture(); let calls = 0;
    const client = await receiptClient({ ...f.options, account: async () => 'st-user:alice', fetchImpl: async () => { calls++; } });
    assert.equal(f.listeners(), 5); f.context.chatMetadata.integrity = 'replacement'; await assert.rejects(client.inspect()); assert.equal(calls, 0); client.close(); assert.equal(f.listeners(), 0);
    const g = fixture(), closed = await receiptClient({ ...g.options, account: async () => 'st-user:alice' }); closed.close(); closed.close(); assert.equal(g.listeners(), 0); assert.throws(() => closed.assertCurrent());
});
test('same-name deletion in an in-flight receipt cannot produce a successful current-source result', async () => {
    const f = fixture(), gate = deferred(), entered = deferred(); let calls = 0;
    const client = await receiptClient({ ...f.options, account: async () => 'st-user:alice', fetchImpl: async (_url, options) => {
        calls++; const body = JSON.parse(options.body); entered.resolve(); await gate.promise;
        return Response.json({ ok: true, version: 1, expectedAccount: body.expectedAccount, target: body.target, state: 'absent', collection: null, proof: 'read-only-snapshot' });
    } });
    const rejection = assert.rejects(client.inspect()); await entered.promise; f.emit('chat_deleted', 'Chat A'); gate.resolve(); await rejection;
    assert.equal(calls, 1); assert.equal(f.listeners(), 0); client.close();
});
test('shared source and filename modules have no narrative, account, database or network imports', async () => {
    const source = await readFile(new URL('../qianmu-current-chat-source.js', import.meta.url), 'utf8'), target = await readFile(new URL('../qianmu-chat-file-target.js', import.meta.url), 'utf8');
    assert.deepEqual([...source.matchAll(/from '([^']+)'/g)].map(match => match[1]), ['./qianmu-chat-file-target.js']);
    for (const code of [source,target]) assert.doesNotMatch(code, /fetch\(|indexedDB|localStorage|\.put\(|\.delete\(|saveMetadata\(|randomUUID\(/);
});
