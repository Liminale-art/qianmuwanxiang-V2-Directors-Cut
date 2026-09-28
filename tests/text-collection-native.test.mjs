import test from 'node:test';
import assert from 'node:assert/strict';
import {createDocumentSession} from '../qianmu-document-session.js';
import {createTextCollection} from '../qianmu-text-collection.js';
import {characterNativeFixture} from './helpers/character-native-fixture.mjs';

// This runs the existing native adapter over synthetic in-memory HTTP only.
// Request counts are protocol evidence, not real VPS timing measurements.
const slot = 'collection-model-probe', stamp = '2026-09-28T00:00:00.000Z';
const entry = id => ({id, text: `收藏 ${id}`, charName: '角色', userName: '用户', createdAt: stamp, updatedAt: stamp, source: null});
const value = {version: 1, items: [entry('one'), entry('two'), entry('three')]};
const counts = f => ({get: f.calls.filter(call => call.request.method === 'GET').length, post: f.calls.filter(call => call.request.method === 'POST').length});
async function fixture(t) {
    const f = await characterNativeFixture(t);
    await f.storage.write(slot, value, {expectedFingerprint: null});
    f.reset();
    const session = createDocumentSession({store: f.storage, slot, isCurrent: () => true});
    const collection = createTextCollection({session, now: () => stamp, createId: () => 'generated'});
    t.after(() => session.dispose());
    return {...f, native: f, session, collection};
}

test('cold model opens share one native read; read/return/reopen performs zero HTTP', async t => {
    const {native: f, collection} = await fixture(t);
    const [first, parallel] = await Promise.all([collection.open(), collection.open()]);
    assert.deepEqual(first, parallel);
    assert.deepEqual(counts(f), {get: 2, post: 0});
    const states = [], leave = collection.subscribe(state => states.push(state));
    assert.equal(states.at(-1).items[0].text, '收藏 one');
    leave();
    f.reset();
    const returnToList = collection.subscribe(state => states.push(state));
    assert.deepEqual(await collection.open(), first);
    assert.deepEqual(counts(f), {get: 0, post: 0});
    assert.deepEqual(states.at(-1).items, value.items);
    returnToList();
});

test('batch deletion publishes one complete native document and warm reopens need no reread', async t => {
    const {native: f, collection} = await fixture(t), first = await collection.open();
    f.reset();
    const removed = await collection.remove(['one', 'three'], {expectedFingerprint: first.fingerprint});
    assert.deepEqual(removed.items, [entry('two')]);
    assert.deepEqual(counts(f), {get: 4, post: 2}, 'one existing adapter save, not one save per deleted item');
    f.reset();
    assert.deepEqual((await collection.open()).items, [entry('two')]);
    assert.deepEqual(counts(f), {get: 0, post: 0});
    assert.deepEqual((await f.storage.read(slot)).value, {version: 1, items: [entry('two')]});
});

test('native external conflict is never overwritten by a stale editor', async t => {
    const {native: f, collection, session} = await fixture(t), first = await collection.open();
    const external = {version: 1, items: [{...entry('one'), text: '另一端已保存'}, entry('two'), entry('three')]};
    await f.storage.write(slot, external, {expectedFingerprint: first.fingerprint});
    f.reset();
    await assert.rejects(collection.edit('one', '本地待保存稿', {expectedFingerprint: first.fingerprint}), {code: 'st_account_storage_conflict'});
    assert.deepEqual(counts(f), {get: 1, post: 0});
    assert.equal(collection.state().items[0].text, '收藏 one');
    assert.equal(session.state().draft.value.items[0].text, '本地待保存稿');
    f.reset();
    const refreshed = await collection.refresh();
    assert.equal(refreshed.items[0].text, '另一端已保存');
    assert.deepEqual(counts(f), {get: 2, post: 0});
    await assert.rejects(collection.edit('one', '本地待保存稿', {expectedFingerprint: first.fingerprint}), {code: 'text_collection_conflict'});
    assert.deepEqual(counts(f), {get: 2, post: 0});
});

test('lost capture acknowledgement is reconciled by stable ID and explicit refresh without another upload', async t => {
    const {native: f, collection, session} = await fixture(t), first = await collection.open();
    let pending = true;
    f.hook(call => {
        if (!pending || call.request.method !== 'POST') return;
        const upload = JSON.parse(call.request.body), text = Buffer.from(upload.data, 'base64').toString('utf8');
        const record = JSON.parse(text);
        if (record.slot !== slot || record.schema !== 'qianmu.st-account-head.v1') return;
        pending = false;
        f.files.set(upload.name, text);
        throw Error('synthetic acknowledgement lost after publication');
    });
    f.reset();
    const input = {id: 'capture-kept', text: '\r\n Exact capture\r\n\r\n', charName: '角色', userName: '用户'};
    await assert.rejects(collection.add(input, {expectedFingerprint: first.fingerprint}), {code: 'st_account_storage_connection', writeState: 'unconfirmed'});
    assert.deepEqual(counts(f), {get: 2, post: 2});
    assert.equal(collection.state().items.length, 3);
    assert.equal(collection.state().needsRefresh, true);
    assert.equal(session.state().draft.value.items.at(-1).id, 'capture-kept');
    await collection.open();
    await assert.rejects(collection.add(input, {expectedFingerprint: first.fingerprint}), {code: 'text_collection_pending'});
    assert.deepEqual(counts(f), {get: 2, post: 2});
    f.reset();
    const confirmed = await collection.refresh();
    assert.equal(confirmed.items.find(item => item.id === 'capture-kept').text, input.text);
    assert.equal(confirmed.items.length, 4);
    assert.equal(confirmed.needsRefresh, false);
    assert.equal(session.state().draft, null);
    assert.deepEqual(counts(f), {get: 2, post: 0});
    await assert.rejects(collection.add(input, {expectedFingerprint: confirmed.fingerprint}), {code: 'text_collection_input'});
    assert.deepEqual(counts(f), {get: 2, post: 0}, 'confirmed ID cannot be submitted twice');
});
