import test from 'node:test';
import assert from 'node:assert/strict';
import {createDocumentSession} from '../qianmu-document-session.js';
import {createTextCollection} from '../qianmu-text-collection.js';

const stamp = '2026-09-28T00:00:00.000Z';
const later = '2026-09-28T01:00:00.000Z';
const key = n => n.toString(16).padStart(64, '0');
const entry = (id = 'one', text = '正文') => ({id, text, charName: '角色', userName: '用户', createdAt: stamp, updatedAt: stamp, source: null});
const input = text => ({text, charName: '角色', userName: '用户'});
const gate = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return {promise, resolve}; };
function fixture(t, initial = {version: 1, items: [entry()]}) {
    let revision = 1, active = true, reads = 0, writes = 0, ids = 0, writeHook, readHook;
    let remote = initial === null ? {exists: false, value: null, fingerprint: null}
        : {exists: true, value: structuredClone(initial), fingerprint: key(revision)};
    const store = {
        async read(_slot, options) { reads++; options.guard(); await readHook?.(); return structuredClone(remote); },
        async write(_slot, value, options) {
            writes++; options.guard(); await writeHook?.(value, options);
            if (remote.fingerprint !== options.expectedFingerprint) throw Object.assign(Error('conflict'), {code: 'st_account_storage_conflict'});
            remote = {exists: true, value: structuredClone(value), fingerprint: key(++revision)};
            return structuredClone(remote);
        },
    };
    const session = createDocumentSession({store, slot: 'collection-probe', isCurrent: () => active});
    const collection = createTextCollection({session, now: () => later, createId: () => `generated-${++ids}`});
    t.after(() => session.dispose());
    return {session, collection,
        get reads() { return reads; }, get writes() { return writes; }, get generatedIds() { return ids; },
        get remote() { return structuredClone(remote); },
        replace(value) { remote = {exists: true, value: structuredClone(value), fingerprint: key(++revision)}; },
        writeHook(fn) { writeHook = fn; }, readHook(fn) { readHook = fn; }, deactivate() { active = false; },
    };
}

test('empty and populated documents stay loaded across subscriber detach and reopen', async t => {
    for (const initial of [null, {version: 1, items: [entry()]}]) {
        const f = fixture(t, initial), seen = [];
        assert.equal(f.collection.state().loaded, false);
        const leave = f.collection.subscribe(state => seen.push(state));
        const opened = await f.collection.open();
        assert.equal(opened.loaded, true);
        assert.equal(opened.items.length, initial ? 1 : 0);
        leave();
        const reattach = f.collection.subscribe(state => seen.push(state));
        assert.deepEqual(await f.collection.open(), opened);
        assert.equal(f.reads, 1);
        assert.equal(f.writes, 0);
        assert.equal(seen.at(-1).loaded, true);
        reattach();
    }
});

test('add captures immutable names, date and optional source while preserving exact text', async t => {
    const f = fixture(t, null), first = await f.collection.open();
    const text = '\r\n  前文\r\n\r\n\r\n后文  \n';
    const source = {chatId: 'chat-opaque', messageId: 'message-opaque'};
    const pending = f.collection.add({...input(text), source}, {expectedFingerprint: first.fingerprint});
    source.chatId = 'changed outside';
    const saved = await pending;
    assert.deepEqual(saved.items[0], {
        id: 'generated-1', text, charName: '角色', userName: '用户', createdAt: later, updatedAt: later,
        source: {chatId: 'chat-opaque', messageId: 'message-opaque'},
    });
    assert.equal(f.writes, 1);
    assert.equal((await f.collection.open()).items[0].text, text);
    assert.equal(f.reads, 1);
});

test('a capture may provide its own stable ID; duplicate ID is rejected without writes', async t => {
    const f = fixture(t, null), first = await f.collection.open();
    const saved = await f.collection.add({...input('正文'), id: 'capture-fixed-id'}, {expectedFingerprint: first.fingerprint});
    assert.equal(saved.items[0].id, 'capture-fixed-id');
    assert.equal(f.generatedIds, 0);
    await assert.rejects(f.collection.add({...input('正文'), id: 'capture-fixed-id'}, {expectedFingerprint: saved.fingerprint}), {code: 'text_collection_input'});
    assert.equal(f.writes, 1);
});

test('edit updates only content and update time; unchanged exact text writes nothing', async t => {
    const original = {...entry(), source: {chatId: 'past-chat', messageId: 'past-message'}};
    const f = fixture(t, {version: 1, items: [original]}), first = await f.collection.open();
    assert.deepEqual(await f.collection.edit('one', original.text, {expectedFingerprint: first.fingerprint}), first);
    assert.equal(f.writes, 0);
    const text = '更改\r\n\r\n\r\n  正文';
    const edited = await f.collection.edit('one', text, {expectedFingerprint: first.fingerprint});
    assert.deepEqual(edited.items[0], {...original, text, updatedAt: later});
    assert.equal(f.writes, 1);
});

test('multi-selection removes once without touching remaining entries or refreshing', async t => {
    const f = fixture(t, {version: 1, items: [entry('one'), entry('two'), entry('three')]}), first = await f.collection.open();
    const saved = await f.collection.remove(['one', 'three', 'one'], {expectedFingerprint: first.fingerprint});
    assert.deepEqual(saved.items, [entry('two')]);
    assert.equal(f.writes, 1);
    assert.equal(f.reads, 1);
    assert.deepEqual((await f.collection.open()).items, [entry('two')]);
});

test('all mutations require explicit exact snapshot, including null for a new library', async t => {
    const f = fixture(t, null);
    await assert.rejects(f.collection.add(input('未打开'), {expectedFingerprint: null}), {code: 'text_collection_unopened'});
    await f.collection.open();
    for (const options of [undefined, {}, {expectedFingerprint: undefined}, {expectedFingerprint: key(9)}]) {
        await assert.rejects(f.collection.add(input('不能保存'), options), {code: 'text_collection_conflict'});
    }
    assert.equal(f.writes, 0);
    const added = await f.collection.add(input('正文'), {expectedFingerprint: null});
    await assert.rejects(f.collection.edit(added.items[0].id, '新稿', {expectedFingerprint: null}), {code: 'text_collection_conflict'});
    await assert.rejects(f.collection.remove([added.items[0].id], {}), {code: 'text_collection_conflict'});
    assert.equal(f.writes, 1);
});

test('bad inputs never write or silently drop supplied fields', async t => {
    const f = fixture(t), opened = await f.collection.open(), options = {expectedFingerprint: opened.fingerprint};
    for (const value of [null, {}, input('  '), {...input('正文'), extra: 'unrecognized'}, {...input('正文'), source: {chatId: 'chat', messageId: 3}}, {...input('正文'), id: ''}]) {
        await assert.rejects(f.collection.add(value, options), {code: 'text_collection_input'});
    }
    for (const text of ['', '  ', null, 3]) await assert.rejects(f.collection.edit('one', text, options), {code: 'text_collection_input'});
    await assert.rejects(f.collection.edit('missing', '正文', options), {code: 'text_collection_missing'});
    for (const ids of [[], null, ['one', 2], ['one', '']]) await assert.rejects(f.collection.remove(ids, options), {code: 'text_collection_input'});
    await assert.rejects(f.collection.remove(['one', 'missing'], options), {code: 'text_collection_missing'});
    assert.equal(f.writes, 0);
});

test('unknown versions, malformed records and unknown fields are not mistaken for an empty library', async t => {
    const corrupt = [
        {version: 2, items: []}, {version: 1}, {version: 1, items: [], extra: 'must not drop'},
        {version: 1, items: [entry(), entry()]}, {version: 1, items: [{...entry(), text: ''}]},
        {version: 1, items: [{...entry(), createdAt: 'unknown'}]},
        {version: 1, items: [{...entry(), extra: 'must not drop'}]},
        {version: 1, items: [{...entry(), source: {chatId: 'chat', messageId: 'id', extra: 1}}]},
    ];
    for (const value of corrupt) {
        const f = fixture(t, value), observed = [];
        const detach = f.collection.subscribe(state => observed.push(state));
        await assert.rejects(f.collection.open(), {code: 'text_collection_document'});
        const invalid = f.collection.state();
        assert.equal(invalid.phase, 'error');
        assert.equal(invalid.loaded, false);
        assert.deepEqual(invalid.items, []);
        assert.equal(invalid.fingerprint, null);
        assert.equal(observed.at(-1).error.code, 'text_collection_document');
        await assert.rejects(f.collection.add(input('正文'), {expectedFingerprint: null}), {code: 'text_collection_unopened'});
        assert.equal(f.writes, 0);
        detach();
    }
});

test('refresh of corrupt data does not expose actionable old records', async t => {
    const f = fixture(t), first = await f.collection.open();
    f.replace({version: 7, items: [entry('other')]});
    await assert.rejects(f.collection.refresh(), {code: 'text_collection_document'});
    assert.equal(f.collection.state().loaded, false);
    assert.deepEqual(f.collection.state().items, []);
    await assert.rejects(f.collection.remove(['one'], {expectedFingerprint: first.fingerprint}), {code: 'text_collection_unopened'});
    assert.equal(f.writes, 0);
});

test('overlapping clicks reject busy before producing another ID or another save', async t => {
    const f = fixture(t, null), first = await f.collection.open(), held = gate();
    f.writeHook(() => held.promise);
    const saving = f.collection.add(input('只收藏一次'), {expectedFingerprint: first.fingerprint});
    assert.equal(f.collection.state().phase, 'saving');
    await assert.rejects(f.collection.add(input('只收藏一次'), {expectedFingerprint: first.fingerprint}), {code: 'text_collection_busy'});
    assert.equal(f.generatedIds, 1);
    held.resolve();
    assert.equal((await saving).items.length, 1);
    assert.equal(f.writes, 1);
});

test('explicit refresh keeps confirmed display but blocks writes until the read finishes', async t => {
    const f = fixture(t), first = await f.collection.open(), held = gate();
    f.readHook(() => held.promise);
    const refresh = f.collection.refresh();
    assert.equal(f.collection.state().phase, 'refreshing');
    assert.deepEqual(f.collection.state().items, first.items);
    await assert.rejects(f.collection.edit('one', '不能插队', {expectedFingerprint: first.fingerprint}), {code: 'text_collection_busy'});
    await assert.rejects(f.collection.remove(['one'], {expectedFingerprint: first.fingerprint}), {code: 'text_collection_busy'});
    held.resolve();
    await refresh;
    assert.equal(f.writes, 0);
});

test('invalid clock or generated ID cannot publish a malformed new entry', async t => {
    for (const overrides of [{now: () => 'invalid'}, {createId: () => ''}, {createId: () => 'one'}]) {
        const f = fixture(t), collection = createTextCollection({session: f.session, now: () => later, createId: () => 'new', ...overrides});
        const first = await collection.open();
        await assert.rejects(collection.add(input('正文'), {expectedFingerprint: first.fingerprint}), {code: 'text_collection_input'});
        assert.equal(f.writes, 0);
    }
});

test('failed save retains confirmed display and exact draft without retry on navigation', async t => {
    const f = fixture(t), first = await f.collection.open();
    f.writeHook(() => { throw Error('offline'); });
    const text = '\n 编辑稿\r\n\r\n';
    await assert.rejects(f.collection.edit('one', text, {expectedFingerprint: first.fingerprint}), /offline/);
    assert.deepEqual(f.collection.state().items, first.items);
    assert.equal(f.collection.state().needsRefresh, true);
    assert.equal(f.session.state().draft.value.items[0].text, text);
    await f.collection.open();
    await assert.rejects(f.collection.edit('one', text, {expectedFingerprint: first.fingerprint}), {code: 'text_collection_pending'});
    assert.equal(f.writes, 1);
    await f.collection.refresh();
    assert.equal(f.collection.state().needsRefresh, false);
    assert.equal(f.collection.state().error.code, 'document_session_unsaved');
    assert.equal(f.session.state().draft.value.items[0].text, text);
    assert.equal(f.writes, 1);
    f.writeHook(null);
    const saved = await f.collection.edit('one', text, {expectedFingerprint: first.fingerprint});
    assert.equal(saved.items[0].text, text);
    assert.equal(f.writes, 2);
});

test('every returned and subscriber snapshot is detached from stored records', async t => {
    const f = fixture(t), first = await f.collection.open();
    first.items[0].text = 'caller changed';
    f.collection.state().items.length = 0;
    const leave = f.collection.subscribe(state => { if (state.items.length) state.items[0].charName = 'subscriber changed'; });
    assert.deepEqual(f.collection.state().items, [entry()]);
    leave();
    const second = await f.collection.open();
    second.items[0].source = {chatId: 'changed', messageId: 'changed'};
    assert.deepEqual(f.remote.value.items, [entry()]);
});

test('an invalid account owner makes collection reads and writes reject without I/O', async t => {
    const f = fixture(t), first = await f.collection.open();
    f.deactivate();
    assert.throws(() => f.collection.state(), {code: 'document_session_closed'});
    await assert.rejects(f.collection.open(), {code: 'document_session_closed'});
    await assert.rejects(f.collection.edit('one', '不能写入', {expectedFingerprint: first.fingerprint}), {code: 'document_session_closed'});
    assert.equal(f.writes, 0);
    assert.equal(f.reads, 1);
});
