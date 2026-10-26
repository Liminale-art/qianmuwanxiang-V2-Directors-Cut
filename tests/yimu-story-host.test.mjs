import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createHost } from '../yimu/host.mjs';
import { fingerprintMessages } from '../yimu/contract.mjs';

const clone = value => structuredClone(value);

test('boundary costs use the native ST confirm and only its affirmative result grants approval', async () => {
    const calls = []; let answer = 1;
    const ctx = {Popup: {show: {confirm: async (...args) => { calls.push(args); return answer; }}}};
    const host = createHost({getContext: () => ctx});
    const scope = {ranges: [{start: 2, end: 4}, {start: 6, end: 8}]};
    assert.equal(await host.confirmStoryBoundary(scope), true);
    assert.match(calls[0][1], /2—4、6—8/); assert.match(calls[0][1], /调用 2 次/); assert.match(calls[0][1], /可能产生费用/);
    assert.deepEqual(calls[0][2], {okButton: '继续建立', cancelButton: '取消'});
    for (answer of [0, null, -1, 2, true, '1']) assert.equal(await host.confirmStoryBoundary(scope), false);
    delete ctx.Popup;
    await assert.rejects(host.confirmStoryBoundary(scope), /无法确认/);
    await assert.rejects(host.confirmStoryBoundary({ranges: [{start: '<img>', end: 4}]}), /范围无效/);
    await assert.rejects(host.confirmStoryBoundary({ranges: []}), /范围无效/);
});

async function fixture({document, continuation=false}={}) {
    const source = { avatar: 'actor.png', file: 'Original', integrity: 'original-integrity' };
    const target = { ...source, file: continuation?'忆幕续接-Original-new':'New story', integrity: 'new-integrity' };
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
    const host = createHost({ getContext: () => ctx, document, fetcher: async (url, options) => {
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

function recentFixture() {
    const row=(avatar,file,group='')=>({dataset:{avatar,file,group},hidden:true,classes:new Set(['hidden']),classList:{remove(value){this.owner.classes.delete(value);}}});
    const rows=[row('actor.png','Other'),row('different.png','忆幕续接-Original-new'),row('actor.png','忆幕续接-Original-new')];
    for(const item of rows)item.classList.owner=item;
    const list={rows,querySelectorAll(selector){assert.equal(selector,'.recentChat');return this.rows;},get firstChild(){return this.rows[0];},
        insertBefore(item,before){this.rows.splice(this.rows.indexOf(item),1);const index=this.rows.indexOf(before);this.rows.splice(index<0?0:index,0,item);}};
    const document={querySelector(selector){assert.equal(selector,'#chat .welcomePanel .recentChatList');return list;}};
    return{document,list,rows};
}

test('only the newest verified continuation is revealed once in the native welcome list without changing dates or pins',async t=>{
    const dom=recentFixture(),f=await fixture({document:dom.document,continuation:true});t.after(f.unsubscribe);
    const original=clone(f.disk.get(f.target.file)),target=dom.rows[2];target.pinned=false;dom.rows[0].pinned=true;
    assert.equal((await f.host.openStory(f.result,{sourceSnapshot:f.sourceSnapshot})).opened,true);
    f.ctx.eventSource.emit('changed');assert.notEqual(dom.list.rows[0],target,'not on the welcome page yet');
    f.ctx.chatId=undefined;f.ctx.eventSource.emit('changed');
    assert.equal(dom.list.rows[0],target);assert.equal(target.hidden,false);assert.equal(target.classes.has('hidden'),false);
    assert.equal(target.pinned,false);assert.equal(dom.list.rows[1].pinned,true);assert.deepEqual(f.disk.get(f.target.file),original);
    dom.list.rows.reverse();const first=dom.list.rows[0];f.ctx.eventSource.emit('changed');assert.equal(dom.list.rows[0],first,'one-shot handoff, not a persistent sort override');
});

test('recent reveal skips failed verification, backups, changed account ownership, duplicate identities and disposal',async t=>{
    for(const mode of ['invalid-target','backup','account','duplicate','dispose']){
        const dom=recentFixture(),f=await fixture({document:dom.document,continuation:true});t.after(f.unsubscribe);
        f.ctx.extensionSettings={};const first=dom.list.rows[0];
        if(mode==='invalid-target')f.disk.get(f.target.file)[1].mes='changed';
        if(mode==='backup')await f.host.openBackup({...f.result,receipt:{...f.receipt,hashes:f.receipt.bridge.hashes}},{sourceSnapshot:f.sourceSnapshot});
        else await f.host.openStory(f.result,{sourceSnapshot:f.sourceSnapshot});
        if(mode==='account')f.ctx.extensionSettings={};
        if(mode==='duplicate')dom.list.rows.push({...dom.list.rows[2]});
        if(mode==='dispose')f.unsubscribe();
        f.ctx.chatId=undefined;f.ctx.eventSource.emit('changed');assert.equal(dom.list.rows[0],first,mode);
    }
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

test('first backup open accepts only empty native timer initialization without saving or normalizing either chat', async t => {
    const emptyStates = [undefined, {}, { sticky: {} }, { cooldown: {} }, { cooldown: {}, sticky: {} }];
    for (const saved of emptyStates) for (const live of emptyStates) {
        const f = await fixture(); t.after(f.unsubscribe);
        if (saved !== undefined) f.disk.get(f.source.file)[0].chat_metadata.timedWorldInfo = clone(saved);
        if (live !== undefined) f.ctx.chatMetadata.timedWorldInfo = clone(live);
        const diskBefore = clone(f.disk.get(f.source.file)), metadata = f.ctx.chatMetadata, metadataBefore = clone(metadata);
        const result = { binding: f.target, receipt: { ...f.receipt, hashes: f.receipt.bridge.hashes } };
        assert.equal((await f.host.openBackup(result, { sourceSnapshot: f.sourceSnapshot })).opened, true);
        assert.deepEqual(f.opens, ['New story']); assert.deepEqual(f.disk.get(f.source.file), diskBefore);
        assert.deepEqual(metadata, metadataBefore, 'comparison must not mutate the original metadata object');
    }
});

test('empty timer maps added during either read do not cause a false source change', async t => {
    for (const initializeAt of ['Original', 'New story']) {
        const f = await fixture(); t.after(f.unsubscribe);
        f.setRead(async file => {
            if (file === initializeAt) f.ctx.chatMetadata.timedWorldInfo = { sticky: {}, cooldown: {} };
            return clone(f.disk.get(file));
        });
        assert.equal((await f.host.openStory(f.result, { sourceSnapshot: f.sourceSnapshot })).opened, true);
    }
});

test('existing timers are retained while empty sibling maps and object key order are harmless', async t => {
    const f = await fixture(); t.after(f.unsubscribe);
    f.disk.get(f.source.file)[0].chat_metadata = { integrity: f.source.integrity,
        timedWorldInfo: { sticky: { entry: { start: 1, end: 4 } } }, plugin: { first: 1, second: 2 } };
    f.ctx.chatMetadata = { plugin: { second: 2, first: 1 }, timedWorldInfo: {
        cooldown: {}, sticky: { entry: { end: 4, start: 1 } } }, integrity: f.source.integrity };
    const before = clone(f.disk.get(f.source.file));
    assert.equal((await f.host.openStory(f.result, { sourceSnapshot: f.sourceSnapshot })).opened, true);
    assert.deepEqual(f.disk.get(f.source.file), before);
});

test('real or unknown timer differences, malformed maps, and other metadata changes still block opening', async t => {
    const values = [{ sticky: { entry: { start: 1, end: 4 } } }, { cooldown: { entry: {} } },
        { unknown: {} }, { sticky: null }, { sticky: [] }, { sticky: '' }, [], null, 'pending'];
    for (const value of values) for (const side of ['disk', 'live']) {
        const f = await fixture(); t.after(f.unsubscribe);
        const metadata = side === 'disk' ? f.disk.get(f.source.file)[0].chat_metadata : f.ctx.chatMetadata;
        metadata.timedWorldInfo = clone(value);
        assert.equal((await f.host.openStory(f.result, { sourceSnapshot: f.sourceSnapshot })).reason, 'source-not-saved');
        assert.equal(f.opens.length, 0);
    }
    const f = await fixture(); t.after(f.unsubscribe);
    f.ctx.chatMetadata.timedWorldInfo = { sticky: {}, cooldown: {} };
    f.ctx.chatMetadata.plugin = { items: [2, 1] }; f.disk.get(f.source.file)[0].chat_metadata.plugin = { items: [1, 2] };
    assert.equal((await f.host.openStory(f.result, { sourceSnapshot: f.sourceSnapshot })).reason, 'source-not-saved');
    assert.equal(f.opens.length, 0);
});

test('real timer or metadata changes during reads still cancel opening', async t => {
    for (const change of [ctx => { ctx.chatMetadata.timedWorldInfo = { sticky: { entry: { end: 9 } } }; },
        ctx => { ctx.chatMetadata.plugin = { pending: true }; }, ctx => { ctx.characters[0].avatar = 'other.png'; },
        ctx => { ctx.chatMetadata.integrity = 'other-integrity'; }]) {
        const f = await fixture(); t.after(f.unsubscribe);
        f.setRead(async file => { change(f.ctx); return clone(f.disk.get(file)); });
        assert.equal((await f.host.openStory(f.result, { sourceSnapshot: f.sourceSnapshot })).reason, 'source-changed');
        assert.equal(f.opens.length, 0);
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
