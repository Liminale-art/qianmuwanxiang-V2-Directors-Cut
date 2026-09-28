import test from 'node:test';
import assert from 'node:assert/strict';
import {createDocumentSession} from '../qianmu-document-session.js';

const key = n => n.toString(16).padStart(64, '0');
const gate = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return {promise, resolve}; };
function fixture(initial = {items: [{id: 'one', text: '正文一'}]}) {
    let revision = 1, active = true, remote = {exists: true, value: initial, fingerprint: key(1)};
    let readHook, writeHook, reads = 0, writes = 0, closes = 0;
    const store = {
        async read(slot, options) {
            reads++; options.guard(); assert.equal(slot, 'session-probe');
            const value = structuredClone(remote);
            await readHook?.(options);
            return value;
        },
        async write(slot, value, options) {
            writes++; options.guard(); assert.equal(slot, 'session-probe');
            const replacement = await writeHook?.(value, options);
            if (replacement) return replacement;
            if (options.expectedFingerprint !== remote.fingerprint) throw Object.assign(Error('conflict'), {code: 'st_account_storage_conflict'});
            remote = {exists: true, value: structuredClone(value), fingerprint: key(++revision)};
            return structuredClone(remote);
        },
        close() { closes++; },
    };
    const session = createDocumentSession({store, slot: 'session-probe', isCurrent: () => active});
    return {session, store, readHook(fn) { readHook = fn; }, writeHook(fn) { writeHook = fn; },
        remote(value) { remote = structuredClone(value); }, get record() { return structuredClone(remote); },
        get reads() { return reads; }, get writes() { return writes; }, get closes() { return closes; },
        deactivate() { active = false; },
    };
}

test('cold list and detail opens share one read; panel unsubscribe/reopen keeps the confirmed document', async () => {
    const f = fixture(), held = gate(), updates = [];
    f.readHook(() => held.promise);
    const unsubscribe = f.session.subscribe(state => updates.push(state.phase));
    const list = f.session.open(), detail = f.session.open();
    held.resolve();
    const first = await list;
    assert.deepEqual(await detail, first);
    assert.equal(f.reads, 1);
    unsubscribe();
    let restored;
    const detach = f.session.subscribe(state => { restored = state.document; });
    assert.deepEqual(restored, first);
    assert.deepEqual(await f.session.open(), first);
    assert.equal(f.reads, 1);
    assert.deepEqual(updates, ['idle', 'loading', 'ready']);
    detach(); f.session.dispose();
});

test('saved edits and deletion immediately become the shared view without a second session read', async () => {
    const f = fixture(), first = await f.session.open();
    const next = {items: [{id: 'one', text: '正文已编辑'}]};
    const saved = await f.session.save(next, {expectedFingerprint: first.fingerprint});
    assert.deepEqual((await f.session.open()).value, next);
    const deleted = await f.session.save({items: []}, {expectedFingerprint: saved.fingerprint});
    assert.deepEqual((await f.session.open()).value, {items: []});
    assert.equal(f.reads, 1); assert.equal(f.writes, 2);
    assert.equal(f.session.state().draft, null);
    assert.equal(f.session.state().document.fingerprint, deleted.fingerprint);
});

test('in-flight saves merge only identical content and base revision', async () => {
    const f = fixture(), first = await f.session.open(), held = gate();
    f.writeHook(() => held.promise);
    const value = {items: []}, options = {expectedFingerprint: first.fingerprint};
    const a = f.session.save(value, options), b = f.session.save(structuredClone(value), options);
    await assert.rejects(f.session.save(value, {expectedFingerprint: key(9)}), {code: 'document_session_busy'});
    await assert.rejects(f.session.save({items: ['different']}, options), {code: 'document_session_busy'});
    held.resolve(); assert.deepEqual(await a, await b);
    assert.equal(f.writes, 1);
});

test('caller mutations and view snapshots cannot modify an in-flight write or the shared document', async () => {
    const f = fixture(), first = await f.session.open(), held = gate();
    first.value.items[0].text = 'caller changed';
    assert.equal(f.session.state().document.value.items[0].text, '正文一');
    f.writeHook(() => held.promise);
    const input = {items: [{id: 'one', text: 'captured'}]}, write = f.session.save(input, {expectedFingerprint: first.fingerprint});
    input.items[0].text = 'changed after submit';
    f.session.state().draft.value.items[0].text = 'changed snapshot';
    held.resolve(); await write;
    assert.equal(f.record.value.items[0].text, 'captured');
});

test('unchanged saves and stale editor versions issue no write', async () => {
    const f = fixture(), first = await f.session.open();
    await f.session.save(first.value, {expectedFingerprint: first.fingerprint});
    await assert.rejects(f.session.save({items: []}, {expectedFingerprint: key(99)}), {code: 'document_session_conflict'});
    assert.equal(f.writes, 0);
});

test('failed saves preserve both last confirmed content and draft; only explicit refresh can clear uncertainty', async () => {
    const f = fixture(), first = await f.session.open(), target = {items: [{id: 'two', text: '未确认稿'}]};
    f.writeHook(() => { throw Error('network unavailable'); });
    await assert.rejects(f.session.save(target, {expectedFingerprint: first.fingerprint}), /network unavailable/);
    assert.deepEqual(f.session.state().document, first);
    assert.deepEqual(f.session.state().draft.value, target);
    assert.equal(f.session.state().needsRefresh, true);
    await f.session.open();
    assert.equal(f.reads, 1);
    await assert.rejects(f.session.save(target, {expectedFingerprint: first.fingerprint}), {code: 'document_session_pending'});
    await f.session.refresh();
    assert.deepEqual(f.session.state().draft.value, target);
    assert.equal(f.session.state().error.code, 'document_session_unsaved');
    assert.equal(f.writes, 1);
});

test('refresh can reconcile an acknowledgement lost after persistence, without replaying a save', async () => {
    const f = fixture(), first = await f.session.open(), target = {items: []};
    f.writeHook(value => {
        f.remote({exists: true, fingerprint: key(2), value});
        throw Object.assign(Error('lost receipt'), {writeState: 'unconfirmed'});
    });
    await assert.rejects(f.session.save(target, {expectedFingerprint: first.fingerprint}));
    await f.session.refresh();
    assert.equal(f.session.state().draft, null);
    assert.equal(f.session.state().error, null);
    assert.deepEqual(f.session.state().document.value, target);
    assert.equal(f.writes, 1);
});

test('refresh queued behind a save reads the final version and keeps the old view visible while waiting', async () => {
    const f = fixture(), first = await f.session.open(), entered = gate(), held = gate();
    f.writeHook(async () => { entered.resolve(); await held.promise; });
    const writing = f.session.save({items: []}, {expectedFingerprint: first.fingerprint});
    await entered.promise;
    const refreshing = f.session.refresh();
    assert.deepEqual(await f.session.open(), first);
    assert.equal(f.reads, 1);
    held.resolve();
    const [saved, refreshed] = await Promise.all([writing, refreshing]);
    assert.deepEqual(saved, refreshed);
    assert.equal(f.reads, 2);
});

test('a save cannot race an earlier refresh and overwrite a newer remote version', async () => {
    const f = fixture(), first = await f.session.open(), held = gate();
    f.remote({exists: true, value: {items: ['remote']}, fingerprint: key(2)});
    f.readHook(() => held.promise);
    const refreshing = f.session.refresh();
    await assert.rejects(f.session.save({items: []}, {expectedFingerprint: first.fingerprint}), {code: 'document_session_busy'});
    held.resolve(); await refreshing;
    await assert.rejects(f.session.save({items: []}, {expectedFingerprint: first.fingerprint}), {code: 'document_session_conflict'});
    assert.equal(f.writes, 0);
});

test('a failed initial read can be retried and does not create a fake empty library', async () => {
    const f = fixture();
    f.readHook(() => { throw Error('read failed'); });
    await assert.rejects(f.session.open(), /read failed/);
    assert.equal(f.session.state().document, null);
    f.readHook(null);
    assert.equal((await f.session.open()).exists, true);
    assert.equal(f.reads, 2); assert.equal(f.writes, 0);
});

test('empty documents remain cached and can be saved with a null initial fingerprint', async () => {
    const f = fixture(); f.remote({exists: false, value: null, fingerprint: null});
    const first = await f.session.open(); await f.session.open();
    assert.equal(f.reads, 1);
    await f.session.save({items: []}, {expectedFingerprint: first.fingerprint});
    assert.equal(f.writes, 1);
});

test('bad receipts do not erase pending input or the previously confirmed value', async () => {
    for (const receipt of [null, {}, {exists: true, value: {}, fingerprint: 'invalid'}, {exists: false, value: null, fingerprint: null},
        {exists: true, value: {items: ['wrong']}, fingerprint: key(2)}]) {
        const f = fixture(), first = await f.session.open();
        const store = {...f.store, write: async () => receipt};
        const session = createDocumentSession({store, slot: 'session-probe', isCurrent: () => true});
        await session.open();
        await assert.rejects(session.save({items: []}, {expectedFingerprint: first.fingerprint}), {code: 'document_session_receipt'});
        assert.deepEqual(session.state().document, first);
        assert.deepEqual(session.state().draft.value, {items: []});
    }
});

test('non-JSON drafts are rejected before submission without replacing pending content', async () => {
    const f = fixture(), first = await f.session.open(), circular = {}; circular.self = circular;
    for (const value of [undefined, {missing: undefined}, {bad: NaN}, [,,], new Date(), {big: 1n}, circular]) {
        await assert.rejects(f.session.save(value, {expectedFingerprint: first.fingerprint}));
    }
    assert.equal(f.writes, 0); assert.equal(f.session.state().draft, null);
});

test('subscriber exceptions do not convert a successful save into a failure', async () => {
    const f = fixture();
    f.session.subscribe(() => { throw Error('view failed'); });
    const first = await f.session.open();
    const result = await f.session.save({items: []}, {expectedFingerprint: first.fingerprint});
    assert.deepEqual(f.session.state().document, result);
    assert.equal(f.session.state().error, null);
});

test('coalesced callers receive independent documents, not a shared mutable result', async () => {
    const f = fixture();
    const list = f.session.open(), detail = f.session.open();
    list.then(record => { record.value.items[0].text = 'mutated by list'; });
    assert.equal((await detail).value.items[0].text, '正文一');
    assert.equal(f.reads, 1);
    const base = f.session.state().document.fingerprint, target = {items: [{text: 'saved'}]};
    const save = f.session.save(target, {expectedFingerprint: base});
    const duplicate = f.session.save(target, {expectedFingerprint: base});
    save.then(record => { record.value.items[0].text = 'mutated by first caller'; });
    assert.equal((await duplicate).value.items[0].text, 'saved');
    assert.equal(f.session.state().document.value.items[0].text, 'saved');
    assert.equal(f.writes, 1);
});

test('disposing from an unchanged-save notification cannot replace its valid receipt with null', async () => {
    const f = fixture(), first = await f.session.open();
    let disposeOnNotice = false;
    f.session.subscribe(() => { if (disposeOnNotice) f.session.dispose(); });
    disposeOnNotice = true;
    assert.deepEqual(await f.session.save(first.value, {expectedFingerprint: first.fingerprint}), first);
    assert.equal(f.writes, 0);
});

test('dispose aborts only its operations and late responses cannot revive a discarded session', async () => {
    for (const operation of ['read', 'write']) {
        const f = fixture(), entered = gate(), held = gate();
        let options;
        const delayed = async (_, received) => { options = received; entered.resolve(); await held.promise; };
        let pending;
        if (operation === 'read') {
            f.readHook(received => delayed(null, received)); pending = f.session.open();
        } else {
            const first = await f.session.open();
            f.writeHook(delayed); pending = f.session.save({items: []}, {expectedFingerprint: first.fingerprint});
        }
        await entered.promise;
        let notifications = 0; f.session.subscribe(() => { notifications++; });
        const before = notifications;
        f.session.dispose(); assert.equal(options.signal.aborted, true);
        held.resolve();
        await assert.rejects(pending, {code: 'document_session_closed'});
        assert.equal(notifications, before); assert.equal(f.closes, 0);
        assert.throws(() => f.session.state(), {code: 'document_session_closed'});
        await assert.rejects(f.session.open(), {code: 'document_session_closed'});
    }
});

test('owner invalidation rejects warm reads as well as writes without further storage calls', async () => {
    const f = fixture(), first = await f.session.open(); f.deactivate();
    await assert.rejects(f.session.open(), {code: 'document_session_closed'});
    await assert.rejects(f.session.save({items: []}, {expectedFingerprint: first.fingerprint}), {code: 'document_session_closed'});
    assert.throws(() => f.session.state(), {code: 'document_session_closed'});
    assert.equal(f.reads, 1); assert.equal(f.writes, 0);
});
