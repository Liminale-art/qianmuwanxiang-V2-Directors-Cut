import test from 'node:test';
import assert from 'node:assert/strict';
import {createTextCollectionOwner} from '../qianmu-text-collection-owner.js';

const gate = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return {promise, resolve}; };
const turn = () => new Promise(resolve => setImmediate(resolve));
const stamp = '2026-09-28T00:00:00.000Z';
const source = {chatId: 'one', messageId: 'first'};
const input = {text: '原文', charName: '角色', userName: '读者', source};
const item = (id, origin = source) => ({...input, id, source: origin, createdAt: stamp, updatedAt: stamp});

function fixture(t, items = []) {
    let namespace = 'st-user:a', live = true, reads = 0, writes = 0, stores = 0, closed = 0, views = 0;
    let readHook, writeHook, createHook, viewHook, acknowledgementHook;
    const records = new Map(), presentations = [], notifications = [], window = new EventTarget();
    const initial = list => ({exists: true, fingerprint: '1'.repeat(64), value: {version: 1, items: structuredClone(list)}});
    records.set(namespace, initial(items));
    const owner = createTextCollectionOwner({resolveNamespace: async () => namespace, isCurrent: () => live,
        headers: () => ({}), window, notify: (...args) => notifications.push(args),
        async storeFactory(options) {
            stores++; const account = await options.resolveNamespace(); await createHook?.();
            const check = async request => { request.guard(); await options.resolveNamespace(); request.guard(); };
            return {
                async read(_slot, request) {
                    reads++; await check(request); await readHook?.(); await check(request);
                    return structuredClone(records.get(account) || {exists: false, fingerprint: null, value: null});
                },
                async write(_slot, value, request) {
                    writes++; await check(request); await writeHook?.(); await check(request);
                    const previous = records.get(account);
                    assert.equal(request.expectedFingerprint, previous?.fingerprint || null);
                    const next = {exists: true, fingerprint: String(writes + 1).repeat(64), value: structuredClone(value)};
                    records.set(account, next); await acknowledgementHook?.(); return structuredClone(next);
                }, close() { closed++; },
            };
        },
        async viewFactory(options) {
            views++; await viewHook?.();
            const result = {options, disposals: 0, captures: [], captureCloses: 0, opens: 0,
                parent: {}, panel: {async open() { result.opens++; await options.collection.open(); return true; }},
                capture: {open(value) { result.captures.push(value); return true; }, close() { result.captureCloses++; }},
                dispose() { result.disposals++; },
            };
            presentations.push(result); return result;
        },
    });
    t.after(() => owner.dispose());
    return {owner, window, records, presentations, notifications,
        get reads() { return reads; }, get writes() { return writes; }, get stores() { return stores; },
        get views() { return views; }, get closed() { return closed; },
        account(value) { namespace = value; }, inactive() { live = false; },
        readHook(fn) { readHook = fn; }, writeHook(fn) { writeHook = fn; },
        createHook(fn) { createHook = fn; }, viewHook(fn) { viewHook = fn; },
        acknowledgementHook(fn) { acknowledgementHook = fn; },
    };
}

test('page pre-read and repeated opens share one document; chat change closes capture only', async t => {
    const f = fixture(t, [item('a')]);
    await Promise.all(Array.from({length: 20}, () => f.owner.warm()));
    assert.equal(f.stores, 1); assert.equal(f.reads, 1); assert.equal(f.views, 0);
    await f.owner.open(); await f.owner.open(); f.owner.chatChanged(); await f.owner.open();
    assert.equal(f.views, 1); assert.equal(f.reads, 1); assert.equal(f.closed, 0);
    assert.equal(f.owner.state().items.length, 1);
    f.owner.state().items[0].text = 'outside'; assert.equal(f.owner.state().items[0].text, '原文');
});

test('solid star removes all captures of this floor in one write, not another floor', async t => {
    const f = fixture(t, [item('a'), item('b'), item('other', {...source, messageId: 'other'})]);
    assert.equal(await f.owner.toggle(input, undefined, 'remove'), true);
    assert.equal(f.writes, 1); assert.equal(f.views, 0);
    assert.deepEqual(f.owner.state().items.map(item => item.id), ['other']);
});

test('empty star captures a full text snapshot; it does not write until the editor saves', async t => {
    const f = fixture(t), hold = gate(); f.readHook(() => hold.promise);
    const value = {...input, text: '完整\r\n\r\n正文'}, pending = f.owner.toggle(value);
    value.text = '后来正文'; value.charName = '后来名字';
    hold.resolve(); assert.equal(await pending, true);
    assert.equal(f.writes, 0); assert.equal(f.presentations[0].captures[0].text, '完整\r\n\r\n正文');
    assert.equal(f.presentations[0].captures[0].charName, '角色');
});

test('a floor without a source remains collectable and never guesses a deletion', async t => {
    const f = fixture(t, [item('a', null)]);
    assert.equal(await f.owner.toggle({...input, source: null}), true);
    assert.equal(f.writes, 0); assert.equal(f.presentations[0].captures.length, 1);
});

test('switching chat or replacing the floor while loading cancels capture without losing the account document', async t => {
    const f = fixture(t), hold = gate(); f.readHook(() => hold.promise);
    const pending = f.owner.toggle(input); await turn(); f.owner.chatChanged(); hold.resolve();
    assert.equal(await pending, false); assert.equal(f.views, 0); assert.equal(f.closed, 0);
    assert.equal(await f.owner.toggle(input, () => false), false); assert.equal(f.views, 0);
    assert.equal(await f.owner.open(), true); assert.equal(f.reads, 1);
});

test('explicit account change retires the old panel/session and never presents old entries', async t => {
    const f = fixture(t, [item('a')]); await f.owner.open();
    f.account('st-user:b'); await f.owner.open();
    assert.equal(f.presentations[0].disposals, 1); assert.equal(f.closed, 1);
    assert.equal(f.stores, 2); assert.deepEqual(f.owner.state().items, []);
});

test('write failure keeps confirmed stars, makes no retry, and reports once', async t => {
    const f = fixture(t, [item('a')]); f.writeHook(() => { throw Error('offline'); });
    assert.equal(await f.owner.toggle(input, undefined, 'remove'), false); await turn();
    assert.equal(f.writes, 1); assert.equal(f.owner.state().items.length, 1);
    assert.equal(f.owner.state().needsRefresh, true); assert.equal(f.notifications.length, 1);
});

test('a failed cold read is retryable on explicit open, not cached as an empty library', async t => {
    const f = fixture(t, [item('a')]); f.readHook(() => { throw Error('offline'); });
    assert.equal(await f.owner.warm(), false); assert.equal(f.owner.state().loaded, false);
    assert.equal(f.notifications.length, 0); f.readHook(null);
    assert.equal(await f.owner.open(), true); assert.equal(f.reads, 2); assert.equal(f.stores, 1);
});

test('dispose during store creation closes the late store and never opens a panel', async t => {
    const f = fixture(t), hold = gate(); f.createHook(() => hold.promise);
    const pending = f.owner.open(); await turn(); f.owner.dispose(); hold.resolve();
    assert.equal(await pending, false); assert.equal(f.closed, 1); assert.equal(f.views, 0);
    assert.equal(f.notifications.length, 0);
});

test('dispose during view creation disposes the late view and closes its store', async t => {
    const f = fixture(t), hold = gate(); f.viewHook(() => hold.promise);
    const pending = f.owner.open(); await turn(); f.owner.dispose(); hold.resolve();
    assert.equal(await pending, false); assert.equal(f.presentations[0].disposals, 1); assert.equal(f.closed, 1);
});

test('pagehide closes only the owner and invalidates pending work', async t => {
    const f = fixture(t, [item('a')]); await f.owner.open(); f.window.dispatchEvent(new Event('pagehide'));
    assert.equal(f.closed, 1); assert.equal(f.presentations[0].disposals, 1); assert.equal(f.owner.state(), null);
    assert.equal(await f.owner.open(), false); assert.equal(f.stores, 1);
});

test('an empty-star click after a lost add receipt confirms the add and never deletes it', async t => {
    const f = fixture(t); await f.owner.open();
    f.acknowledgementHook(() => { throw Error('receipt lost'); });
    await assert.rejects(f.presentations[0].options.collection.add(input, {expectedFingerprint: '1'.repeat(64)}));
    assert.equal(f.owner.state().items.length, 0); assert.equal(f.owner.state().needsRefresh, true);
    f.acknowledgementHook(null);
    assert.equal(await f.owner.toggle(input, undefined, 'collect'), true);
    assert.equal(f.owner.state().items.length, 1); assert.equal(f.writes, 1);
    assert.equal(f.presentations[0].captures.length, 0);
});

test('a solid-star click after a lost remove receipt ends the removal without reopening capture', async t => {
    const f = fixture(t, [item('a')]); f.acknowledgementHook(() => { throw Error('receipt lost'); });
    assert.equal(await f.owner.toggle(input, undefined, 'remove'), false);
    assert.equal(f.owner.state().items.length, 1); f.acknowledgementHook(null);
    assert.equal(await f.owner.toggle(input, undefined, 'remove'), true);
    assert.equal(f.owner.state().items.length, 0); assert.equal(f.writes, 1); assert.equal(f.views, 0);
});

test('an account change between visible star and click does not remove the new account collection', async t => {
    const f = fixture(t, [item('a')]); await f.owner.warm();
    f.records.set('st-user:b', structuredClone(f.records.get('st-user:a'))); f.account('st-user:b');
    assert.equal(await f.owner.toggle(input, undefined, 'remove'), false);
    assert.equal(f.writes, 0); assert.equal(f.records.get('st-user:b').value.items.length, 1);
});
