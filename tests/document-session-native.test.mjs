import test from 'node:test';
import assert from 'node:assert/strict';
import {createDocumentSession} from '../qianmu-document-session.js';
import {characterNativeFixture} from './helpers/character-native-fixture.mjs';

// Real native file adapter, entirely synthetic in-memory HTTP. Request counts
// describe the protocol, not VPS latency or a new single-request save path.
const slot = 'rebuild-probe';
const value = text => ({version: 1, items: [{id: 'entry-one', text}]});
const counts = f => ({
    get: f.calls.filter(call => call.request.method === 'GET').length,
    post: f.calls.filter(call => call.request.method === 'POST').length,
});
function session(t, store) {
    const current = createDocumentSession({store, slot, isCurrent: () => true});
    t.after(() => current.dispose());
    return current;
}
async function seeded(t) {
    const f = await characterNativeFixture(t);
    await f.storage.write(slot, value('Original synthetic text'), {expectedFingerprint: null});
    f.reset();
    return f;
}
function loseUploadAcknowledgement(f, schema) {
    let pending = true;
    f.hook(call => {
        if (!pending || call.request.method !== 'POST') return;
        const upload = JSON.parse(call.request.body);
        const text = Buffer.from(upload.data, 'base64').toString('utf8');
        const record = JSON.parse(text);
        if (record.slot !== slot || record.schema !== schema) return;
        pending = false;
        f.files.set(upload.name, text);
        throw Error('synthetic upload accepted, acknowledgement lost');
    });
}

test('native session merges cold reads and keeps list/detail/return/reopen in its confirmed view', async t => {
    const f = await seeded(t), current = session(t, f.storage);
    const [first, parallel] = await Promise.all([current.open(), current.open()]);
    assert.deepEqual(first, parallel);
    assert.deepEqual(counts(f), {get: 2, post: 0});

    const seen = [];
    const leave = current.subscribe(state => seen.push(state));
    assert.equal(seen.at(-1).document.value.items[0].text, 'Original synthetic text');
    leave();
    f.reset();
    const returnToList = current.subscribe(state => seen.push(state));
    assert.deepEqual(await current.open(), first);
    assert.deepEqual(counts(f), {get: 0, post: 0}, 'panel unsubscribe does not end the page-owned document');
    returnToList();

    const saved = await current.save(value('Edited synthetic text'), {expectedFingerprint: first.fingerprint});
    assert.deepEqual(counts(f), {get: 4, post: 2}, 'existing save protocol still uses six file HTTP requests');
    assert.equal(saved.value.items[0].text, 'Edited synthetic text');
    f.reset();
    assert.deepEqual(await current.open(), saved);
    assert.deepEqual(counts(f), {get: 0, post: 0});

    // Removing an item is an explicit document edit, not deleting ST chat files.
    const removed = await current.save({version: 1, items: []}, {expectedFingerprint: saved.fingerprint});
    assert.deepEqual(removed.value.items, []);
    assert.deepEqual(counts(f), {get: 4, post: 2});
    f.reset();
    assert.deepEqual((await current.open()).value.items, []);
    assert.deepEqual(counts(f), {get: 0, post: 0});
    assert.deepEqual((await f.storage.read(slot)).value, removed.value);
});

test('separate native sessions see external edits only after explicit refresh', async t => {
    const f = await seeded(t), otherStore = await f.createStorage();
    t.after(() => otherStore.close());
    const first = session(t, f.storage), other = session(t, otherStore);
    const baseline = await first.open();
    await other.open();
    const saved = await first.save(value('Changed from another session'), {expectedFingerprint: baseline.fingerprint});
    f.reset();
    assert.deepEqual(await other.open(), baseline, 'warm open is not an implicit remote refresh');
    assert.deepEqual(counts(f), {get: 0, post: 0});
    assert.deepEqual(await other.refresh(), saved);
    assert.deepEqual(counts(f), {get: 2, post: 0});
    assert.equal(other.state().draft, null);
});

test('native optimistic conflict rejects a stale save without overwriting external data', async t => {
    const f = await seeded(t), current = session(t, f.storage);
    const baseline = await current.open(), external = value('External preserved content');
    await f.storage.write(slot, external, {expectedFingerprint: baseline.fingerprint});
    f.reset();
    const draft = value('Unsent local changes');
    await assert.rejects(current.save(draft, {expectedFingerprint: baseline.fingerprint}), {code: 'st_account_storage_conflict'});
    assert.deepEqual(counts(f), {get: 1, post: 0});
    assert.deepEqual(current.state().document, baseline);
    assert.deepEqual(current.state().draft.value, draft);
    assert.equal(current.state().needsRefresh, true);
    const refreshed = await current.refresh();
    assert.deepEqual(refreshed.value, external);
    assert.deepEqual(current.state().draft.value, draft, 'refresh does not erase a different local draft');
    assert.equal(current.state().needsRefresh, false);
    assert.equal(counts(f).post, 0);
});

test('lost committed head acknowledgement retains draft until explicit read reconciles it, without a second POST', async t => {
    const f = await seeded(t), current = session(t, f.storage);
    const baseline = await current.open(), draft = value('Committed despite response loss');
    loseUploadAcknowledgement(f, 'qianmu.st-account-head.v1');
    f.reset();
    await assert.rejects(current.save(draft, {expectedFingerprint: baseline.fingerprint}), {
        code: 'st_account_storage_connection', writeState: 'unconfirmed',
    });
    assert.deepEqual(counts(f), {get: 2, post: 2});
    assert.deepEqual(current.state().document, baseline);
    assert.deepEqual(current.state().draft.value, draft);
    assert.equal(current.state().needsRefresh, true);
    assert.deepEqual(await current.open(), baseline);
    await assert.rejects(current.save(draft, {expectedFingerprint: baseline.fingerprint}), {code: 'document_session_pending'});
    assert.deepEqual(counts(f), {get: 2, post: 2}, 'neither warm open nor blocked retry resends uploads');

    f.reset();
    const reconciled = await current.refresh();
    assert.deepEqual(reconciled.value, draft);
    assert.notEqual(reconciled.fingerprint, baseline.fingerprint);
    assert.equal(current.state().draft, null);
    assert.equal(current.state().needsRefresh, false);
    assert.deepEqual(counts(f), {get: 2, post: 0});
});

test('lost body acknowledgement does not claim a published save when explicit refresh still reads the old head', async t => {
    const f = await seeded(t), current = session(t, f.storage);
    const baseline = await current.open(), draft = value('Body retained, head not published');
    loseUploadAcknowledgement(f, 'qianmu.st-account-document.v1');
    f.reset();
    await assert.rejects(current.save(draft, {expectedFingerprint: baseline.fingerprint}), {
        code: 'st_account_storage_connection', writeState: 'unconfirmed',
    });
    assert.deepEqual(counts(f), {get: 1, post: 1});
    f.reset();
    assert.deepEqual(await current.refresh(), baseline);
    assert.deepEqual(current.state().draft.value, draft);
    assert.notEqual(current.state().error, null);
    assert.deepEqual(counts(f), {get: 2, post: 0}, 'refresh only observes; it does not resume publication');
});

test('disposing one native document session leaves another session using the same adapter functional', async t => {
    const f = await seeded(t), first = session(t, f.storage), other = session(t, f.storage);
    await first.open();
    const baseline = await other.open();
    first.dispose();
    await assert.rejects(first.open(), {code: 'document_session_closed'});
    f.reset();
    const saved = await other.save(value('Adapter remains owned by caller'), {expectedFingerprint: baseline.fingerprint});
    assert.deepEqual(counts(f), {get: 4, post: 2});
    assert.deepEqual(await other.refresh(), saved);
    assert.deepEqual((await f.storage.read(slot)).value, saved.value);
});
