import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createHost } from '../yimu/host.mjs';
import { fingerprintMessages } from '../yimu/contract.mjs';

const clone = value => structuredClone(value);
async function fixture() {
    const source = { avatar: 'actor.png', file: 'Original', integrity: 'original-integrity' };
    const target = { ...source, file: 'New story', integrity: 'new-integrity' };
    const messages = Array.from({ length: 8 }, (_, index) => ({ name: index % 2 ? 'Actor' : 'User', is_user: !(index % 2), mes: `Floor ${index + 1}`, send_date: `date-${index}` }));
    const bridge = clone(messages.slice(-5));
    const disk = new Map([[source.file, [{ chat_metadata: { integrity: source.integrity } }, ...clone(messages)]],
        [target.file, [{ chat_metadata: { integrity: target.integrity } }, ...clone(bridge)]]]);
    const requests = [], opens = [], writes = [];
    const ctx = { groupId: null, characterId: 0, characters: [{ avatar: source.avatar, name: 'Actor' }], chatId: source.file,
        chatMetadata: { integrity: source.integrity }, chat: clone(messages), eventSource: new EventEmitter(),
        eventTypes: { GENERATION_STARTED: 'started', GENERATION_ENDED: 'ended', CHAT_CHANGED: 'changed' },
        getRequestHeaders: () => ({ 'X-CSRF-Token': 'synthetic-only' }), setExtensionPrompt: (...args) => writes.push(args),
        saveChat: () => assert.fail('must not save chat'), saveMetadata: () => assert.fail('must not save metadata'),
        async openCharacterChat(file) { opens.push(file); const rows = clone(disk.get(file)); ctx.chatId = file; ctx.chatMetadata = rows.shift().chat_metadata; ctx.chat = rows; },
    };
    let read = async file => clone(disk.get(file));
    const host = createHost({ getContext: () => ctx, fetcher: async (url, options) => {
        const body = JSON.parse(options.body); requests.push({ url, options, body });
        return { ok: true, json: () => read(body.file_name) };
    } });
    const unsubscribe = host.subscribe(() => {});
    const receipt = { id: 'operation-one', status: 'complete', target, bridge: { count: 5, hashes: await fingerprintMessages(bridge) } };
    return { host, ctx, disk, requests, opens, writes, source, target, receipt, result: { binding: target, receipt }, unsubscribe,
        sourceSnapshot: await host.snapshot(), setRead(fn) { read = fn; } };
}

test('native opening verifies saved source and target, never saves either chat, and proves loaded identity', async t => {
    const f = await fixture(); t.after(f.unsubscribe); const original = clone(f.disk.get(f.source.file));
    const result = await f.host.openStory(f.result, { sourceSnapshot: f.sourceSnapshot });
    assert.equal(result.opened, true); assert.deepEqual(result.binding, f.target); assert.deepEqual(f.opens, ['New story']);
    assert.deepEqual(f.disk.get(f.source.file), original);
    assert.deepEqual(f.requests.map(r => r.body.file_name), ['New story', 'Original']);
    assert.ok(f.requests.every(r => r.url === '/api/chats/get' && r.options.headers['X-CSRF-Token'] === 'synthetic-only'));
    const loaded = await f.host.snapshot();
    const again = await f.host.openStory(f.result, { sourceSnapshot: loaded });
    assert.equal(again.alreadyOpen, true); assert.equal(f.opens.length, 1);
});

test('backup role choices retain unique avatar identity, and complete restoration verifies the whole target without switching roles', async t => {
    const f = await fixture(); t.after(f.unsubscribe);
    f.ctx.characters.push({ avatar: 'other.png', name: 'Actor' }, { avatar: 'other.png', name: 'Duplicate entry' });
    const choices = f.host.characters(); assert.deepEqual(choices, [{ avatar: 'actor.png', name: 'Actor' }, { avatar: 'other.png', name: 'Actor' }]);
    choices[0].name = 'changed'; assert.equal(f.ctx.characters[0].name, 'Actor');
    const result = { binding: f.target, receipt: { id: 'restore', status: 'complete', target: f.target, hashes: f.receipt.bridge.hashes } };
    f.disk.get(f.target.file).push({ mes: 'unconfirmed extra floor' });
    assert.equal((await f.host.openBackup(result, { sourceSnapshot: f.sourceSnapshot })).opened, false); assert.equal(f.opens.length, 0);
    f.disk.get(f.target.file).pop();
    assert.equal((await f.host.openBackup(result, { sourceSnapshot: f.sourceSnapshot })).opened, true);
    assert.equal(f.ctx.characterId, 0);
});

test('missing and changed targets cannot enter ST empty-chat greeting creation', async t => {
    for (const change of [f => f.disk.set(f.target.file, []), f => { f.disk.get(f.target.file)[0].chat_metadata.integrity = 'other'; },
        f => { f.disk.get(f.target.file)[1].mes = 'changed'; }, f => f.disk.get(f.target.file).pop()]) {
        const f = await fixture(); t.after(f.unsubscribe); change(f);
        assert.equal((await f.host.openStory(f.result, { sourceSnapshot: f.sourceSnapshot })).opened, false);
        assert.equal(f.opens.length, 0); assert.equal(f.ctx.chatId, f.source.file);
    }
});

test('unsaved source body or metadata blocks navigation without forcing a save', async t => {
    for (const change of [f => { f.disk.get(f.source.file)[1].mes = 'disk older'; }, f => { f.ctx.chatMetadata.pending = true; }]) {
        const f = await fixture(); t.after(f.unsubscribe); change(f);
        const result = await f.host.openStory(f.result, { sourceSnapshot: f.sourceSnapshot });
        assert.equal(result.reason, 'source-not-saved'); assert.equal(f.opens.length, 0);
    }
});

test('source edits, navigation, generation and cancellation during reads do not steal the current interface', async t => {
    for (const change of [f => { f.ctx.chatId = 'Elsewhere'; }, f => { f.ctx.chat[0].mes = 'edited'; },
        f => f.ctx.eventSource.emit('started', 'normal', {}, false), (_f, active) => { active.value = false; }]) {
        const f = await fixture(); t.after(f.unsubscribe); const active = { value: true };
        f.setRead(async file => { change(f, active); return clone(f.disk.get(file)); });
        const result = await f.host.openStory(f.result, { sourceSnapshot: f.sourceSnapshot, isCurrent: () => active.value });
        assert.equal(result.reason, 'source-changed'); assert.equal(f.opens.length, 0);
    }
});

test('generation blocks opening but a token-preview dry run does not', async t => {
    const f = await fixture(); t.after(f.unsubscribe);
    f.ctx.eventSource.emit('started', 'normal', {}, false);
    assert.equal((await f.host.openStory(f.result, { sourceSnapshot: f.sourceSnapshot })).opened, false);
    assert.equal(f.requests.length, 0);
    f.ctx.eventSource.emit('ended'); f.ctx.eventSource.emit('started', 'normal', {}, true);
    assert.equal((await f.host.openStory(f.result, { sourceSnapshot: f.sourceSnapshot })).opened, true);
});

test('native swallowed failure and a different loaded identity are not reported as successful opening', async t => {
    for (const native of [async () => {}, async function () { this.chatMetadata.integrity = 'wrong-file'; }]) {
        const f = await fixture(); t.after(f.unsubscribe); f.ctx.openCharacterChat = native;
        const result = await f.host.openStory(f.result, { sourceSnapshot: f.sourceSnapshot });
        assert.equal(result.opened, false); assert.equal(result.reason, 'open-unconfirmed');
        assert.deepEqual(f.disk.get(f.target.file).length, 6, 'confirmed file is retained');
    }
});

test('a pending open excludes duplicate attempts and incomplete receipts never read or create', async t => {
    const f = await fixture(); t.after(f.unsubscribe); let release, began;
    const started = new Promise(resolve => { began = resolve; });
    f.setRead(file => { began(); return new Promise(resolve => { release = () => resolve(clone(f.disk.get(file))); }); });
    const pending = f.host.openStory(f.result, { sourceSnapshot: f.sourceSnapshot }); await started;
    assert.equal((await f.host.openStory(f.result, { sourceSnapshot: f.sourceSnapshot })).reason, 'opening');
    f.ctx.chatId = 'other'; release(); await pending; assert.equal(f.opens.length, 0);
    const count = f.requests.length;
    assert.equal((await f.host.openStory({ binding: f.target, receipt: { ...f.receipt, status: 'pending' } }, { sourceSnapshot: f.sourceSnapshot })).reason, 'unconfirmed-receipt');
    assert.equal(f.requests.length, count);
});
