import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {textCollectionFloorSources, collectionSourceKey} from '../qianmu-text-collection-source.js';

const time = '2026-09-28T08:00:00.001Z';
const later = '2026-09-28T08:00:01.002Z';
const message = overrides => ({is_user: false, is_system: false, name: '角色', send_date: time, mes: '正文', ...overrides});
function context(chat = [message()]) {
    return {characterId: 0, groupId: null, chatId: '聊天', characters: [{avatar: 'a.png', chat: '聊天'}, {avatar: 'b.png', chat: '聊天'}],
        groups: [{id: 'g', chat_id: '聊天'}, {id: 0, chat_id: '聊天'}], chat, chatMetadata: {integrity: 'copied-host-integrity'}, eventSource: new EventEmitter()};
}
const source = host => textCollectionFloorSources(host).get(host.chat[0]);
const listenerCount = host => host.eventSource.eventNames().reduce((sum, name) => sum + host.eventSource.listenerCount(name), 0);

test('source is an exact owner-qualified filename tuple and both source fields are strings', () => {
    const host = context(), actual = source(host);
    assert.deepEqual(JSON.parse(actual.chatId), ['character', 'char:a.png', '聊天', 'copied-host-integrity']);
    assert.deepEqual(JSON.parse(actual.messageId), ['assistant', time]);
    assert.ok(Object.isFrozen(actual)); assert.equal(listenerCount(host), 0);
});

test('same chat names, prose and copied integrity never merge different characters or groups', () => {
    const host = context(), a = source(host); host.characterId = 1; const b = source(host);
    host.groupId = 'g'; const group = source(host); host.groupId = 0; const zero = source(host);
    assert.equal(new Set([a, b, group, zero].map(collectionSourceKey)).size, 4);
    assert.deepEqual(JSON.parse(zero.chatId), ['group', 'group:0', '聊天', 'copied-host-integrity']);
});

test('editing prose or display names and deleting preceding floors preserve the source', () => {
    const target = message({send_date: later}), host = context([message(), target]);
    const before = textCollectionFloorSources(host).get(target);
    target.mes = '编辑后的正文'; target.name = '另一个显示名'; target.extra = {gen_id: 42}; host.chat.shift();
    assert.deepEqual(source(host), before);
});

test('ordinary swipe changes use the first swipe timestamp, not the active revision', () => {
    const target = message({swipes: ['甲', '乙'], swipe_id: 0, swipe_info: [{send_date: time}, {send_date: later}]}), host = context([target]);
    const before = source(host); target.swipe_id = 1; target.mes = '乙'; target.send_date = later; target.extra = {gen_id: 'changed'};
    assert.deepEqual(source(host), before);
});

test('missing or invalid first swipe timestamps fall back to a valid message timestamp', () => {
    for (const swipe_info of [undefined, [], [null], [{send_date: ''}], [{send_date: 1}], [{send_date: 'bad\nvalue'}]]) {
        assert.deepEqual(JSON.parse(source(context([message({swipe_info})])).messageId), ['assistant', time]);
    }
});

test('duplicate timestamps within one role are all unlinked, not disambiguated by floor, name, generation ID or text', () => {
    const a = message({extra: {gen_id: 1}}), b = message({name: '不同角色名', mes: '不同正文', extra: {gen_id: 2}}), c = message({send_date: later});
    const actual = textCollectionFloorSources(context([a, b, c]));
    assert.equal(actual.size, 1); assert.equal(actual.has(a), false); assert.equal(actual.has(b), false); assert.equal(actual.has(c), true);
    assert.equal(textCollectionFloorSources(context([a, a])).size, 0);
});

test('different roles distinguish timestamps, including prompt-excluded user and assistant floors', () => {
    const a = message({is_system: true}), b = message({is_user: true, is_system: true});
    const actual = textCollectionFloorSources(context([a, b]));
    assert.equal(actual.size, 2); assert.notEqual(collectionSourceKey(actual.get(a)), collectionSourceKey(actual.get(b)));
});

test('hiding the first floor or all floors preserves optional source links and makes no host writes', () => {
    const a = message(), b = message({send_date: later}), host = context([a, b]);
    const before = textCollectionFloorSources(host);
    a.is_system = true;
    assert.deepEqual(textCollectionFloorSources(host), before);
    b.is_system = true;
    const hidden = structuredClone({...host, eventSource: null});
    assert.deepEqual(textCollectionFloorSources(host), before);
    assert.deepEqual({...host, eventSource: null}, hidden);
    a.is_system = false; b.is_system = false;
    assert.deepEqual(textCollectionFloorSources(host), before);
    assert.equal(listenerCount(host), 0);
});

test('prompt-excluded duplicate timestamps still make both links ambiguous rather than choosing the visible floor', () => {
    const a = message(), b = message({is_system: true});
    assert.equal(textCollectionFloorSources(context([a, b])).size, 0);
});

test('legacy ST dates stay verbatim and do not depend on browser date parsing', () => {
    const legacy = '2026-9-28 @12h 34m 56s 123ms', target = message({send_date: legacy});
    assert.deepEqual(JSON.parse(source(context([target])).messageId), ['assistant', legacy]);
    assert.equal(textCollectionFloorSources(context([target, message({send_date: legacy})])).size, 0);
    assert.deepEqual(JSON.parse(source(context([message({send_date: new Date(time)})])).messageId), ['assistant', time]);
});

test('missing, empty, control-containing or unbounded timestamps provide no source; no IDs are minted', () => {
    for (const send_date of [undefined, null, '', '  ', 123, 'date\n', 'date\u007f', 'x'.repeat(161), new Date(NaN), {}]) {
        const target = message({send_date}), host = context([target]);
        assert.equal(textCollectionFloorSources(host).size, 0);
        assert.equal(Object.hasOwn(target, 'extra'), false);
    }
});

test('missing chat location, duplicate avatar and invalid metadata yield no guessed source', () => {
    for (const patch of [{chatId: ''}, {chatMetadata: null}, {chatMetadata: {integrity: {}}}, {characterId: undefined},
        {characters: [{avatar: 'a.png', chat: 'other'}]}, {characters: [{avatar: 'a.png', chat: '聊天'}, {avatar: 'a.png', chat: '聊天'}]},
        {groupId: 'missing'}, {chatId: '../escape'}]) {
        const host = {...context(), ...patch}; assert.equal(textCollectionFloorSources(host).size, 0); assert.equal(listenerCount(host), 0);
    }
    for (const host of [null, undefined, [], 'chat', {}]) assert.equal(textCollectionFloorSources(host).size, 0);
});

test('legacy missing integrity stays missing; read-only helper does not create host metadata', () => {
    const host = context(); delete host.chatMetadata.integrity; const before = structuredClone({...host, eventSource: null});
    assert.deepEqual(JSON.parse(source(host).chatId), ['character', 'char:a.png', '聊天', null]);
    assert.deepEqual({...host, eventSource: null}, before); assert.equal(listenerCount(host), 0);
});

test('rename, first-swipe deletion and file replacement may lose the weak link without changing existing sources', () => {
    const target = message({swipe_info: [{send_date: time}, {send_date: later}]}), host = context([target]), before = source(host);
    host.chatId = '改名'; host.characters[0].chat = '改名'; assert.notEqual(source(host).chatId, before.chatId);
    target.swipe_info.shift(); target.send_date = later; assert.notEqual(source(host).messageId, before.messageId);
    host.chatMetadata.integrity = 'replacement'; assert.notEqual(source(host).chatId, before.chatId);
    assert.deepEqual(JSON.parse(before.chatId), ['character', 'char:a.png', '聊天', 'copied-host-integrity']);
    assert.deepEqual(JSON.parse(before.messageId), ['assistant', time]);
});

test('successful and immediately-invalidated captures retain no event listeners', () => {
    const host = context(), emitter = host.eventSource, types = []; host.event_types = {CHAT_CHANGED: 'custom-change'};
    const originalOn = emitter.on.bind(emitter); emitter.on = (type, listener) => {types.push(type); return originalOn(type, listener);};
    assert.equal(textCollectionFloorSources(host).size, 1); assert.ok(types.includes('custom-change')); assert.equal(listenerCount(host), 0);
    emitter.on = (type, listener) => {originalOn(type, listener); listener(); return emitter;};
    assert.equal(textCollectionFloorSources(host).size, 0); assert.equal(listenerCount(host), 0);
});

test('source indexing never reads prose and tolerates absent or malformed message entries', () => {
    const target = message(); Object.defineProperty(target, 'mes', {get() {throw new Error('Prose must not be read');}});
    const host = context([null, undefined, 42, [], {}, target]); assert.equal(textCollectionFloorSources(host).get(target).messageId, JSON.stringify(['assistant', time]));
});

test('tuple source keys are collision-safe and null for missing or malformed optional sources', () => {
    assert.notEqual(collectionSourceKey({chatId: 'a,b', messageId: 'c'}), collectionSourceKey({chatId: 'a', messageId: 'b,c'}));
    for (const value of [null, undefined, [], {}, {chatId: 'a'}, {chatId: 'a', messageId: ''}, {chatId: 'a', messageId: 1}, {chatId: 'a', messageId: 'b', extra: true}]) assert.equal(collectionSourceKey(value), null);
});
