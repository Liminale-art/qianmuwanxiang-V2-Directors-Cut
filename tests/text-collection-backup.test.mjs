import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createTextCollectionOwner} from '../qianmu-text-collection-owner.js';
import {createTextCollectionBackup, readTextCollectionBackup, prepareTextCollectionRestore, TEXT_COLLECTION_BACKUP_BYTES} from '../qianmu-text-collection-backup.js';
import {ST_ACCOUNT_STORAGE_LIMITS, createStAccountStorage} from '../qianmu-st-account-storage.js';

const stamp = '2026-09-28T00:00:00.000Z', origin = 'https://fixture.invalid', scope = 'a'.repeat(64);
const row = (id = 'one', text = ' 原文\r\n\r\n\r\n尾  ') => ({id, text, charName: '角色', userName: '读者', createdAt: stamp, updatedAt: stamp, source: {chatId: 'chat', messageId: 'message'}});
const document = (...items) => ({version: 1, items});
const backup = (value = document(row()), place = {}) => createTextCollectionBackup(value, {origin, scope, now: () => stamp, ...place});
const file = payload => new Blob([JSON.stringify(payload)], {type: 'application/json'});
const gate = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return {promise, resolve}; };
const turn = () => new Promise(done => setImmediate(done));
const receipt = value => ({exists: true, fingerprint: createHash('sha256').update(JSON.stringify(value)).digest('hex'), value: structuredClone(value)});

test('backup roundtrip preserves complete plaintext, names, dates and same-place source', async () => {
    const value = document(row()), payload = backup(value), restored = await readTextCollectionBackup(file(payload));
    assert.deepEqual(restored.document, value);
    const prepared = await prepareTextCollectionRestore(restored, document(), {origin, scope});
    assert.deepEqual(prepared.document, value); assert.equal(prepared.count, 1);
    assert.equal(JSON.stringify(payload).includes('st-user:'), false);
});

test('strict import rejects unknown fields, duplicate keys, bad origins, IDs and large files before writes', async () => {
    for (const value of [
        {...backup(), unknown: true}, {...backup(), version: 2}, {...backup(), origin: 'https://fixture.invalid/path'},
        {...backup(), scope: 'st-user:private'}, {...backup(), document: document(row(), row())},
        {...backup(), document: document({...row(), unknown: 'do not discard'})},
        {...backup(), document: document({...row(), source: {...row().source, hidden: 'do not discard'}})},
        {...backup(), document: document({...row(), updatedAt: 'unknown'})},
    ]) await assert.rejects(readTextCollectionBackup(file(value)));
    await assert.rejects(readTextCollectionBackup(new Blob(['{"type":"qianmu-text-collection","type":"ignored"}'])), /重复字段/);
    await assert.rejects(readTextCollectionBackup({size: TEXT_COLLECTION_BACKUP_BYTES + 1, text() { throw Error('must not read'); }}), /上限/);
});

test('same IDs merge without overwrite; deterministic copies make repeated import a no-op', async () => {
    const current = document(row('one', '当前正文')), payload = backup();
    const prepared = await prepareTextCollectionRestore(payload, current, {origin, scope});
    assert.equal(prepared.count, 1); assert.match(prepared.document.items[0].id, /^import-[a-f0-9]{64}$/);
    assert.equal(prepared.document.items[0].text, row().text); assert.equal(current.items[0].text, '当前正文');
    const next = document(...current.items, ...prepared.document.items);
    const repeated = await prepareTextCollectionRestore(payload, next, {origin, scope});
    assert.equal(repeated.count, 0); assert.equal(repeated.skipped, 1);
    next.items[1].text = '副本后来修改';
    await assert.rejects(prepareTextCollectionRestore(payload, next, {origin, scope}), /副本已被修改/);
});

test('cross-account and cross-origin restore strip only weak source links', async () => {
    for (const place of [{origin: 'https://other.invalid', scope}, {origin, scope: 'b'.repeat(64)}]) {
        const prepared = await prepareTextCollectionRestore(backup(), document(), place);
        assert.deepEqual(prepared.document.items, [{...row(), source: null}]);
        assert.equal((await prepareTextCollectionRestore(backup(), prepared.document, place)).count, 0);
    }
});

test('capacity rejects the combined full document, not partial rows or arbitrary item counts', async () => {
    const large = row('large', 'x'.repeat(ST_ACCOUNT_STORAGE_LIMITS.bytes - 1000));
    const payload = backup(document(large));
    await assert.rejects(prepareTextCollectionRestore(payload, document(row('existing', 'z'.repeat(2000))), {origin, scope}), /超过存储上限/);
    const many = document(...Array.from({length: 3000}, (_, index) => row(String(index), '文')));
    assert.equal((await prepareTextCollectionRestore(backup(many), document(), {origin, scope})).count, 3000);
});

function fixture(t, value = document(row())) {
    let namespace = 'st-user:a', live = true, remote = receipt(value), reads = 0, writes = 0, confirmations = 0;
    let readHook, writeHook, receiptHook, confirmHook, collection;
    const downloads = [], notices = [];
    const owner = createTextCollectionOwner({origin, resolveNamespace: async () => namespace, isCurrent: () => live, headers: () => ({}),
        window: new EventTarget(), download: (...args) => downloads.push(args), notify: (...args) => notices.push(args),
        confirm: async (...args) => { confirmations++; return confirmHook ? confirmHook(...args) : true; },
        async viewFactory(options) {
            collection = options.collection;
            return {parent: {}, panel: {open: async () => { await collection.open(); return true; }}, capture: {close() {}}, dispose() {}};
        },
        async storeFactory(options) {
            const account = await options.resolveNamespace();
            const check = async request => { request.guard(); assert.equal(await options.resolveNamespace(), account); request.guard(); };
            return {scope, async read(_slot, request) { reads++; await check(request); await readHook?.(); await check(request); return structuredClone(remote); },
                async write(_slot, next, request) {
                    await check(request); await writeHook?.(); await check(request);
                    if (request.expectedFingerprint !== remote.fingerprint) throw Object.assign(Error('conflict'), {code: 'st_account_storage_conflict', writeState: 'not_started'});
                    if (new TextEncoder().encode(JSON.stringify(next)).length > ST_ACCOUNT_STORAGE_LIMITS.bytes) throw Object.assign(Error('capacity'), {code: 'st_account_storage_capacity', writeState: 'not_started'});
                    writes++; remote = receipt(next); await receiptHook?.(); return structuredClone(remote);
                }, close() {},
            };
        },
    });
    t.after(() => owner.dispose());
    return {owner, downloads, notices, get reads() { return reads; }, get writes() { return writes; }, get confirmations() { return confirmations; }, get collection() { return collection; },
        get remote() { return structuredClone(remote); }, replace(value) { remote = receipt(value); }, account(value) { namespace = value; },
        inactive() { live = false; }, readHook(value) { readHook = value; }, writeHook(value) { writeHook = value; },
        receiptHook(value) { receiptHook = value; }, confirmHook(value) { confirmHook = value; }};
}

test('export and scan each explicitly read once; normal reopening continues with that same account session', async t => {
    const f = fixture(t); await f.owner.warm();
    f.replace(document(row('new', '异端原文')));
    assert.deepEqual(await f.owner.exportBackup(), {status: 'exported', count: 1});
    assert.equal(f.reads, 2); assert.equal(f.writes, 0);
    const payload = await readTextCollectionBackup(f.downloads[0][0]);
    assert.equal(payload.document.items[0].text, '异端原文');
    const stats = await f.owner.summary(); assert.equal(stats.count, 1); assert.equal(stats.bytes, new TextEncoder().encode(JSON.stringify(f.remote.value)).length);
    assert.equal(stats.fingerprint, f.remote.fingerprint); assert.equal(f.reads, 3);
    await f.owner.warm(); assert.equal(f.reads, 3);
});

test('import commits one complete batch and skips a repeated identical backup', async t => {
    const f = fixture(t); const payload = backup(document(row('two'), row('three')));
    assert.deepEqual(await f.owner.importBackup(file(payload)), {status: 'imported', count: 2, skipped: 0});
    assert.equal(f.writes, 1); assert.deepEqual(f.remote.value.items.map(item => item.id), ['one', 'two', 'three']);
    assert.deepEqual(await f.owner.importBackup(file(payload)), {status: 'imported', count: 0, skipped: 2});
    assert.equal(f.writes, 1); assert.equal(f.confirmations, 1);
});

test('cancelled import and clear write nothing; clear confirmed selection does not ask twice', async t => {
    const f = fixture(t); f.confirmHook(() => false);
    assert.equal((await f.owner.importBackup(file(backup(document(row('new')))))).status, 'cancelled');
    assert.equal((await f.owner.clear()).status, 'cancelled'); assert.equal(f.writes, 0);
    const previous = f.remote.fingerprint;
    const result = await f.owner.clear({confirmed: true, expectedFingerprint: previous});
    assert.equal(result.count, 1); assert.equal(f.writes, 1); assert.equal(f.confirmations, 2); assert.deepEqual(f.remote.value.items, []);
});

test('scan fingerprint and external cleanup guard prevent deleting new or unrelated content', async t => {
    const f = fixture(t), stats = await f.owner.summary();
    f.replace(document(row(), row('later')));
    await assert.rejects(f.owner.clear({confirmed: true, expectedFingerprint: stats.fingerprint}), {code: 'text_collection_conflict'});
    assert.equal(f.writes, 0); assert.equal(f.remote.value.items.length, 2);
    const hold = gate(); let current = true; f.readHook(() => hold.promise);
    const pending = f.owner.clear({confirmed: true, check: () => { if (!current) throw Error('stale cleanup'); }});
    await turn(); current = false; hold.resolve(); await assert.rejects(pending, /stale cleanup/); assert.equal(f.writes, 0);
});

test('save in flight rejects clear immediately instead of queuing deletion after save', async t => {
    const f = fixture(t), hold = gate(); f.writeHook(() => hold.promise);
    const pending = f.owner.importBackup(file(backup(document(row('new')))));
    await turn(); assert.equal(f.owner.busy, true);
    await assert.rejects(f.owner.clear({confirmed: true}), {code: 'text_collection_busy'});
    hold.resolve(); await pending; assert.equal(f.remote.value.items.length, 2); assert.equal(f.writes, 1);
});

test('a remote change after import confirmation never gets overwritten', async t => {
    const f = fixture(t); f.confirmHook(() => { f.replace(document(row('remote', '他处新文'))); return true; });
    await assert.rejects(f.owner.importBackup(file(backup(document(row('new'))))), /conflict/);
    assert.equal(f.writes, 0); assert.equal(f.remote.value.items[0].id, 'remote');
    assert.equal(f.owner.state().needsRefresh, true);
});

test('lost import receipt is not retried automatically; explicit retry reconciles without duplicates', async t => {
    const f = fixture(t); f.receiptHook(() => { throw Error('lost receipt'); });
    const payload = backup(document(row('new')));
    await assert.rejects(f.owner.importBackup(file(payload)), /lost receipt/); assert.equal(f.writes, 1);
    await f.owner.warm(); assert.equal(f.writes, 1); assert.equal(f.owner.state().needsRefresh, true);
    f.receiptHook(null);
    assert.equal((await f.owner.importBackup(file(payload))).count, 0); assert.equal(f.writes, 1);
    assert.deepEqual(f.remote.value.items.map(item => item.id), ['one', 'new']);
});

test('account, page and scan lifecycle changes prevent later downloads or writes', async t => {
    for (const mode of ['account', 'page']) {
        const f = fixture(t), hold = gate(); f.readHook(() => hold.promise);
        const pending = f.owner.exportBackup(); await turn();
        if (mode === 'account') f.account('st-user:b'); else f.inactive();
        hold.resolve(); await assert.rejects(pending); assert.equal(f.downloads.length, 0); assert.equal(f.writes, 0);
    }
    const f = fixture(t), hold = gate(); f.confirmHook(() => hold.promise);
    const pending = f.owner.importBackup(file(backup(document(row('new'))))); await turn();
    f.account('st-user:b'); hold.resolve(true); await assert.rejects(pending); assert.equal(f.writes, 0);
    await assert.rejects(f.owner.summary(() => false));
});

test('failed batch preserves remote originals and does not erase a different unsaved draft', async t => {
    const f = fixture(t); f.writeHook(() => { throw Object.assign(Error('offline'), {writeState: 'not_started'}); });
    await assert.rejects(f.owner.importBackup(file(backup(document(row('new'))))), /offline/);
    assert.equal(f.writes, 0); assert.deepEqual(f.remote.value, document(row()));
    f.writeHook(null);
    await assert.rejects(f.owner.clear({confirmed: true}), {code: 'text_collection_pending'});
    assert.equal(f.writes, 0);
    assert.equal((await f.owner.importBackup(file(backup(document(row('new')))))).count, 1);
    assert.equal(f.writes, 1);
});

test('import confirmation cannot replace a failed edit draft created while it was waiting', async t => {
    const f = fixture(t), hold = gate(); await f.owner.open();
    f.confirmHook(() => hold.promise);
    const pending = f.owner.importBackup(file(backup(document(row('new', '备份正文')))));
    await turn(); assert.equal(f.confirmations, 1);
    const draft = ' 编辑稿\r\n\r\n完整保留  ';
    f.writeHook(() => { throw Object.assign(Error('offline'), {writeState: 'not_started'}); });
    await assert.rejects(f.collection.edit('one', draft, {expectedFingerprint: f.collection.state().fingerprint}), /offline/);
    f.writeHook(null); hold.resolve(true);
    await assert.rejects(pending, {code: 'text_collection_pending'});
    assert.equal(f.writes, 0); assert.deepEqual(f.remote.value, document(row()));
    assert.equal(f.owner.state().error.message, 'offline');
    await assert.rejects(f.owner.clear({confirmed: true}), {code: 'text_collection_pending'});
    assert.equal(f.writes, 0);
    await f.collection.edit('one', draft, {expectedFingerprint: f.collection.state().fingerprint});
    assert.equal(f.writes, 1); assert.equal(f.remote.value.items[0].text, draft);
    assert.equal(f.remote.value.items.length, 1);
});

test('clear confirmation cannot erase a failed edit draft created while it was waiting', async t => {
    const f = fixture(t), hold = gate(); await f.owner.open();
    f.confirmHook(() => hold.promise);
    const pending = f.owner.clear();
    await turn(); assert.equal(f.confirmations, 1);
    const draft = '刚刚编辑的完整正文\n\n末尾';
    f.writeHook(() => { throw Object.assign(Error('capacity'), {writeState: 'not_started'}); });
    await assert.rejects(f.collection.edit('one', draft, {expectedFingerprint: f.collection.state().fingerprint}), /capacity/);
    f.writeHook(null); hold.resolve(true);
    await assert.rejects(pending, {code: 'text_collection_pending'});
    assert.equal(f.writes, 0); assert.deepEqual(f.remote.value, document(row()));
    assert.equal(f.owner.state().error.message, 'capacity');
    await assert.rejects(f.owner.clear({confirmed: true}), {code: 'text_collection_pending'});
    assert.equal(f.writes, 0);
    await f.collection.edit('one', draft, {expectedFingerprint: f.collection.state().fingerprint});
    assert.equal(f.writes, 1); assert.equal(f.remote.value.items[0].text, draft);
});

async function nativeFixture(t) {
    const files = new Map(), requests = [], downloads = [];
    let hook;
    const owner = createTextCollectionOwner({origin, resolveNamespace: async () => 'st-user:synthetic', isCurrent: () => true,
        headers: () => ({'X-CSRF-Token': 'synthetic'}), window: new EventTarget(), confirm: async () => true,
        download: (...args) => downloads.push(args),
        storeFactory: options => createStAccountStorage({...options, origin,
            fetchImpl: async (url, request) => {
                const path = new URL(url).pathname; requests.push({path, method: request.method}); await hook?.(path, request);
                if (request.method === 'POST') {
                    assert.equal(path, '/api/files/upload'); const {name, data} = JSON.parse(request.body);
                    files.set(name, Buffer.from(data, 'base64').toString('utf8'));
                    return new Response(JSON.stringify({path: `/user/files/${name}`}));
                }
                const text = files.get(path.split('/').at(-1));
                return new Response(text || '{}', {status: text === undefined ? 404 : 200});
            },
        }),
    });
    t.after(() => owner.dispose());
    return {owner, files, requests, downloads, reset() { requests.length = 0; }, hook(fn) { hook = fn; }};
}

test('actual owner to native snapshot import/export/clear stays one file and never edits chat files', async t => {
    const f = await nativeFixture(t);
    const imported = await f.owner.importBackup(file(backup(document(row('one'), row('two')))));
    assert.equal(imported.count, 2); assert.equal(f.files.size, 1);
    assert.deepEqual(f.requests.map(call => call.method), ['GET', 'GET', 'POST', 'GET']);
    assert.match([...f.files.keys()][0], /^qianmu-v2-[a-f0-9]{64}-text-collection\.snapshot\.json$/);
    f.reset(); await f.owner.exportBackup();
    assert.deepEqual(f.requests.map(call => call.method), ['GET']);
    const payload = await readTextCollectionBackup(f.downloads[0][0]);
    assert.deepEqual(payload.document.items, [row('one'), row('two')].map(item => ({...item, source: null})));
    f.reset(); await f.owner.importBackup(f.downloads[0][0]);
    assert.deepEqual(f.requests.map(call => call.method), ['GET']);
    f.reset(); await f.owner.clear({confirmed: true, expectedFingerprint: f.owner.state().fingerprint});
    assert.deepEqual(f.requests.map(call => call.method), ['GET', 'GET', 'POST', 'GET']);
    assert.equal(f.files.size, 1); assert.deepEqual(JSON.parse([...f.files.values()][0]).value.items, []);
    assert.equal(f.requests.some(call => call.path.includes('chat') || call.path.includes('settings')), false);
});

test('native write boundary rechecks cleanup guard after the pre-upload remote read', async t => {
    const f = await nativeFixture(t); await f.owner.importBackup(file(backup())); f.reset();
    let valid = true, gets = 0;
    f.hook((_path, request) => { if (request.method === 'GET' && ++gets === 2) valid = false; });
    await assert.rejects(f.owner.clear({confirmed: true, check() { if (!valid) throw Error('cleanup expired'); }}));
    assert.deepEqual(f.requests.map(call => call.method), ['GET', 'GET']);
    assert.equal(JSON.parse([...f.files.values()][0]).value.items.length, 1);
});
