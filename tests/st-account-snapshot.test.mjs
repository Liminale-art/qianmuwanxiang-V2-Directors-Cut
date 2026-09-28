import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash, webcrypto} from 'node:crypto';
import {createStAccountStorage} from '../qianmu-st-account-storage.js';
import {createDocumentSession} from '../qianmu-document-session.js';
import {createTextCollection} from '../qianmu-text-collection.js';
import {createTextCollectionPanel} from '../qianmu-text-collection-panel.js';
import {textCollectionDom} from './helpers/text-collection-dom.mjs';

// Native files protocol exercised against synthetic HTTP only. Request counts
// are not browser layout, actual VPS timing or cross-device CAS guarantees.
const origin = 'https://st.fixture.invalid';
const namespace = 'st-user:snapshot-fixture';
const slot = 'text-collection';
const schema = 'qianmu.st-account-snapshot.v1';
const response = (body, status = 200) => new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status, headers: {'content-type': 'application/json'},
});
const counts = f => ({get: f.calls.filter(call => call.request.method === 'GET').length,
    post: f.calls.filter(call => call.request.method === 'POST').length});
const hash = text => createHash('sha256').update(text).digest('hex');
const value = text => ({version: 1, items: [{id: 'entry-one', text}]});

async function fixture(t, options = {}) {
    const files = new Map(), calls = [], clients = [];
    let owner = namespace, active = true, hook = null;
    const create = async (overrides = {}) => {
        const client = await createStAccountStorage({
            documentLayout: 'snapshot', ...options, ...overrides,
            resolveNamespace: async () => owner, isCurrent: () => active,
            headers: () => ({'X-CSRF-Token': 'synthetic', Authorization: 'never-send', 'x-api-key': 'never-send'}),
            origin, cryptoImpl: webcrypto,
            fetchImpl: async (url, request) => {
                const parsed = new URL(url), path = parsed.pathname;
                assert.equal(parsed.origin, origin);
                assert.equal(request.cache, 'no-store');
                assert.equal(request.redirect, 'error');
                assert.equal(request.credentials, 'same-origin');
                assert.equal(request.headers['X-CSRF-Token'], 'synthetic');
                assert.equal(request.headers.Authorization, undefined);
                assert.equal(request.headers['x-api-key'], undefined);
                const call = {url, path, request}; calls.push(call);
                const overridden = await hook?.(call);
                if (overridden) return overridden;
                if (path === '/api/files/upload') {
                    const {name, data} = JSON.parse(request.body);
                    assert.match(name, /^qianmu-v2-[a-f0-9]{64}-[a-z0-9-]+(?:\.snapshot)?\.json$/);
                    files.set(name, Buffer.from(data, 'base64').toString('utf8'));
                    return response({path: '/user/files/' + name});
                }
                assert.equal(request.method, 'GET');
                assert.match(path, /^\/user\/files\/qianmu-v2-[a-f0-9]{64}-[a-z0-9-]+(?:\.snapshot)?\.json$/);
                const body = files.get(path.split('/').at(-1));
                return body === undefined ? response({}, 404) : response(body);
            },
        });
        clients.push(client); return client;
    };
    t.after(() => clients.forEach(client => client.close()));
    const store = await create();
    return {store, create, calls, files, hook: next => { hook = next; }, reset: () => { calls.length = 0; },
        account: next => { owner = next; }, live: next => { active = next; }};
}
function session(t, store) {
    const current = createDocumentSession({store, slot, isCurrent: () => true});
    t.after(() => current.dispose()); return current;
}
async function seeded(t, options) {
    const f = await fixture(t, options);
    f.saved = await f.store.write(slot, value('Original\r\n\r\n纯文本 😀'), {expectedFingerprint: null});
    f.reset(); return f;
}

test('snapshot exposes only the narrow document API and writes one namespaced file through native files', async t => {
    const f = await fixture(t);
    assert.deepEqual(Object.keys(f.store).sort(), ['close', 'namespace', 'read', 'scope', 'write']);
    assert.equal((await f.store.read(slot)).exists, false);
    assert.deepEqual(counts(f), {get: 1, post: 0});
    f.reset();
    const document = value('正文\r\n\r\n无静默压缩😀');
    const saved = await f.store.write(slot, document, {expectedFingerprint: null});
    assert.deepEqual(counts(f), {get: 2, post: 1});
    assert.equal(f.files.size, 1);
    const [name, text] = [...f.files][0];
    assert.equal(name, `qianmu-v2-${f.store.scope}-${slot}.snapshot.json`);
    assert.equal(name.includes('snapshot-fixture'), false);
    assert.deepEqual(JSON.parse(text), {schema, scope: f.store.scope, slot, value: document});
    assert.equal(saved.fingerprint, hash(text));
    assert.equal(saved.persistence, 'st-account-file');
    assert.equal(saved.concurrency, 'optimistic-non-cas');
    assert.deepEqual(saved.value, document);
    const other = await f.create();
    f.reset();
    assert.deepEqual(await other.read(slot), saved);
    assert.deepEqual(counts(f), {get: 1, post: 0});
});

test('snapshot overwrites only its own one current file and keeps old versioned files untouched', async t => {
    const f = await fixture(t), legacy = await f.create({documentLayout: 'versioned'});
    await legacy.write(slot, value('Unrelated versioned original'), {expectedFingerprint: null});
    const oldFiles = new Map(f.files);
    assert.equal((await f.store.read(slot)).exists, false, 'no implicit reading or migration of legacy files');
    let saved = {fingerprint: null};
    for (let index = 0; index < 24; index++) {
        saved = await f.store.write(slot, value(`revision ${index}`), {expectedFingerprint: saved.fingerprint});
    }
    assert.equal(f.files.size, oldFiles.size + 1);
    for (const [name, text] of oldFiles) assert.equal(f.files.get(name), text);
    assert.deepEqual((await f.store.read(slot)).value, value('revision 23'));
    assert.deepEqual((await legacy.read(slot)).value, value('Unrelated versioned original'));
});

test('document session coalesces one cold snapshot read and all warm navigation performs zero reads', async t => {
    const f = await seeded(t), current = session(t, f.store);
    const [first, simultaneous] = await Promise.all([current.open(), current.open()]);
    assert.deepEqual(first, simultaneous);
    assert.deepEqual(counts(f), {get: 1, post: 0});
    f.reset();
    for (let index = 0; index < 5; index++) {
        const leave = current.subscribe(() => {});
        assert.deepEqual(await current.open(), first); leave();
    }
    assert.deepEqual(counts(f), {get: 0, post: 0});
    const saved = await current.save(value('Edited once'), {expectedFingerprint: first.fingerprint});
    assert.deepEqual(counts(f), {get: 2, post: 1});
    f.reset();
    assert.deepEqual(await current.open(), saved);
    assert.deepEqual(counts(f), {get: 0, post: 0});
});

test('unchanged snapshot still checks the remote base once but never uploads', async t => {
    const f = await seeded(t);
    assert.deepEqual(await f.store.write(slot, f.saved.value, {expectedFingerprint: f.saved.fingerprint}), f.saved);
    assert.deepEqual(counts(f), {get: 1, post: 0});
    const other = await f.create();
    const changed = await other.write(slot, value('Other page edit'), {expectedFingerprint: f.saved.fingerprint});
    f.reset();
    await assert.rejects(f.store.write(slot, f.saved.value, {expectedFingerprint: f.saved.fingerprint}), {
        code: 'st_account_storage_conflict', writeState: 'not_started',
    });
    assert.deepEqual(counts(f), {get: 1, post: 0});
    assert.deepEqual((await other.read(slot)).value, changed.value);
});

test('a stale snapshot editor retains its draft and never overwrites an already changed remote base', async t => {
    const f = await seeded(t), current = session(t, f.store);
    const first = await current.open(), external = value('External edit'), draft = value('My pending edit');
    await f.store.write(slot, external, {expectedFingerprint: first.fingerprint});
    f.reset();
    await assert.rejects(current.save(draft, {expectedFingerprint: first.fingerprint}), {
        code: 'st_account_storage_conflict', writeState: 'not_started',
    });
    assert.deepEqual(counts(f), {get: 1, post: 0});
    assert.deepEqual(current.state().document, first);
    assert.deepEqual(current.state().draft.value, draft);
    assert.equal(current.state().needsRefresh, true);
    f.reset();
    assert.deepEqual((await current.refresh()).value, external);
    assert.deepEqual(current.state().draft.value, draft);
    assert.deepEqual(counts(f), {get: 1, post: 0});
});

test('snapshot invalid payload, missing fingerprint and invalid slots fail before any file request', async t => {
    const f = await fixture(t, {maxBytes: 1024});
    const cyclic = {}; cyclic.self = cyclic;
    for (const bad of [undefined, NaN, new Date(), {x: undefined}, [,,], cyclic, {text: '\ud800'}, {text: '文'.repeat(400)}]) {
        await assert.rejects(f.store.write(slot, bad, {expectedFingerprint: null}));
        assert.equal(f.calls.length, 0);
    }
    await assert.rejects(f.store.write(slot, value('Missing base')));
    assert.equal(f.calls.length, 0);
    for (const bad of ['../notes', 'notes/other', 'Notes', 'x'.repeat(97)]) {
        await assert.rejects(async () => f.store.read(bad));
        await assert.rejects(async () => f.store.write(bad, value('Bad slot'), {expectedFingerprint: null}));
    }
    assert.equal(f.calls.length, 0);
});

test('snapshot captures mutable caller input before queueing', async t => {
    const f = await fixture(t), input = value('Captured original');
    const pending = f.store.write(slot, input, {expectedFingerprint: null});
    input.items[0].text = 'Changed after click';
    assert.deepEqual((await pending).value, value('Captured original'));
});

test('a known pre-upload capacity failure keeps the editable draft and permits direct correction without refresh', async t => {
    const f = await seeded(t, {maxBytes: 1024}), current = session(t, f.store), first = await current.open();
    f.reset();
    const oversized = value('长'.repeat(500));
    await assert.rejects(current.save(oversized, {expectedFingerprint: first.fingerprint}), {
        code: 'st_account_storage_capacity', writeState: 'not_started',
    });
    assert.deepEqual(counts(f), {get: 0, post: 0});
    assert.deepEqual(current.state().document, first);
    assert.deepEqual(current.state().draft.value, oversized);
    assert.equal(current.state().needsRefresh, false, 'known rejection is not an unknown remote result');
    const corrected = value('Short corrected text');
    assert.deepEqual((await current.save(corrected, {expectedFingerprint: first.fingerprint})).value, corrected);
    assert.deepEqual(counts(f), {get: 2, post: 1}, 'correction does not require an extra explicit refresh');
    assert.equal(current.state().draft, null);
});

test('snapshot clients share same-realm write order so a simultaneous stale base is rejected before upload', async t => {
    const f = await seeded(t), other = await f.create();
    const results = await Promise.allSettled([
        f.store.write(slot, value('First click'), {expectedFingerprint: f.saved.fingerprint}),
        other.write(slot, value('Second stale click'), {expectedFingerprint: f.saved.fingerprint}),
    ]);
    assert.equal(results[0].status, 'fulfilled');
    assert.equal(results[1].status, 'rejected');
    assert.equal(results[1].reason.code, 'st_account_storage_conflict');
    assert.equal(results[1].reason.writeState, 'not_started');
    assert.deepEqual(counts(f), {get: 3, post: 1});
    assert.deepEqual((await other.read(slot)).value, value('First click'));
});

test('lost snapshot upload acknowledgement retains draft and explicit one-read refresh reconciles without another POST', async t => {
    const f = await seeded(t), current = session(t, f.store), first = await current.open();
    const draft = value('Accepted but response lost');
    let lose = true;
    f.hook(call => {
        if (call.request.method !== 'POST' || !lose) return;
        lose = false;
        const upload = JSON.parse(call.request.body);
        f.files.set(upload.name, Buffer.from(upload.data, 'base64').toString('utf8'));
        throw Error('synthetic lost acknowledgement after atomic write');
    });
    f.reset();
    await assert.rejects(current.save(draft, {expectedFingerprint: first.fingerprint}), {
        code: 'st_account_storage_connection', writeState: 'unconfirmed',
    });
    assert.deepEqual(counts(f), {get: 1, post: 1});
    assert.deepEqual(current.state().document, first);
    assert.deepEqual(current.state().draft.value, draft);
    assert.equal(current.state().needsRefresh, true);
    assert.deepEqual(await current.open(), first);
    await assert.rejects(current.save(draft, {expectedFingerprint: first.fingerprint}), {code: 'document_session_pending'});
    assert.deepEqual(counts(f), {get: 1, post: 1});
    f.reset();
    assert.deepEqual((await current.refresh()).value, draft);
    assert.equal(current.state().draft, null);
    assert.equal(current.state().needsRefresh, false);
    assert.deepEqual(counts(f), {get: 1, post: 0});
});

test('corrupt, foreign and different-content snapshot readbacks cannot confirm a save', async t => {
    for (const mode of ['syntax', 'scope', 'slot', 'duplicate', 'different']) {
        const f = await seeded(t), current = session(t, f.store), first = await current.open();
        const draft = value('Needs exact content confirmation');
        let uploaded = false;
        f.hook(call => {
            if (call.request.method === 'POST') { uploaded = true; return; }
            if (!uploaded) return;
            const name = call.path.split('/').at(-1), raw = f.files.get(name), document = JSON.parse(raw);
            if (mode === 'syntax') return response('{broken');
            if (mode === 'scope') document.scope = 'f'.repeat(64);
            if (mode === 'slot') document.slot = 'foreign-slot';
            if (mode === 'different') document.value = value('Another concurrently written complete value');
            if (mode === 'duplicate') return response(raw.replace('"slot":', '"slot":"duplicate","slot":'));
            return response(document);
        });
        f.reset();
        await assert.rejects(current.save(draft, {expectedFingerprint: first.fingerprint}), error => {
            assert.equal(error.writeState, 'unconfirmed'); return true;
        });
        assert.deepEqual(counts(f), {get: 2, post: 1});
        assert.deepEqual(current.state().document, first);
        assert.deepEqual(current.state().draft.value, draft);
        assert.equal(current.state().needsRefresh, true);
        f.hook(null); f.reset();
        assert.deepEqual((await current.refresh()).value, draft);
        assert.deepEqual(counts(f), {get: 1, post: 0});
    }
});

test('late account changes after snapshot upload reject adoption and do not start a readback under another account', async t => {
    const f = await seeded(t), current = session(t, f.store), first = await current.open();
    f.hook(call => {
        if (call.request.method !== 'POST') return;
        const {name, data} = JSON.parse(call.request.body);
        f.files.set(name, Buffer.from(data, 'base64').toString('utf8'));
        f.account('st-user:other');
        return response({path: '/user/files/' + name});
    });
    f.reset();
    const draft = value('Submitted to captured owner');
    await assert.rejects(current.save(draft, {expectedFingerprint: first.fingerprint}), {
        code: 'st_account_storage_account', writeState: 'unconfirmed',
    });
    assert.deepEqual(counts(f), {get: 1, post: 1});
    assert.deepEqual(current.state().document, first);
    assert.deepEqual(current.state().draft.value, draft);
    assert.equal(current.state().needsRefresh, true);
});

test('snapshot read and write still reject lost guards before transport and stale owners cannot read prior account files', async t => {
    const f = await seeded(t);
    await assert.rejects(f.store.read(slot, {guard: () => false}), {code: 'st_account_storage_scope'});
    await assert.rejects(f.store.write(slot, value('Never sent'), {expectedFingerprint: f.saved.fingerprint, guard: () => false}), {
        code: 'st_account_storage_scope', writeState: 'not_started',
    });
    assert.equal(f.calls.length, 0);
    f.account('st-user:other');
    await assert.rejects(f.store.read(slot), {code: 'st_account_storage_account'});
    assert.equal(f.calls.length, 0);
    const other = await f.create();
    assert.equal((await other.read(slot)).exists, false);
    assert.notEqual(other.scope, f.store.scope);
    assert.equal(f.files.size, 1);
});

test('snapshot upload receipt accepts only its exact native file path', async t => {
    for (const path of ['https://evil.invalid/file.json', '/user/files/foreign.json', '/user/files/../escape.json']) {
        const f = await fixture(t);
        f.hook(call => call.request.method === 'POST' ? response({path}) : null);
        await assert.rejects(f.store.write(slot, value('No foreign receipts'), {expectedFingerprint: null}), {
            code: 'st_account_storage_path', writeState: 'unconfirmed',
        });
        assert.deepEqual(counts(f), {get: 1, post: 1});
    }
});

test('snapshot timeout after upload starts remains unconfirmed and does not blindly retry', async t => {
    const f = await fixture(t, {timeoutMs: 100});
    f.hook(call => call.request.method === 'POST' ? new Promise(() => {}) : null);
    await assert.rejects(f.store.write(slot, value('Awaiting confirmation'), {expectedFingerprint: null}), {
        code: 'st_account_storage_timeout', writeState: 'unconfirmed',
    });
    assert.deepEqual(counts(f), {get: 1, post: 1});
});

test('snapshot native protocol and real collection panel complete capture/read/back/edit/batch-delete/reopen without navigation reads', async t => {
    const f = await fixture(t), current = session(t, f.store), dom = textCollectionDom();
    const collection = createTextCollection({session: current, now: () => '2026-09-28T00:00:00.000Z'});
    const view = createTextCollectionPanel({parent: dom.parent, collection, isCurrent: () => true, copyText: async () => {}});
    t.after(() => view.dispose());
    const click = label => {
        const control = dom.get(label);
        assert.ok(control, `missing collection control: ${label}`);
        assert.ok(dom.visible(control), `hidden collection control: ${label}`);
        assert.equal(control.disabled, false, `disabled collection control: ${label}`);
        control.click();
    };
    const type = text => { const editor = dom.get('收藏正文'); editor.value = text; editor.emit('input'); };
    const settled = async () => {
        await dom.wait(() => !['loading', 'refreshing', 'saving'].includes(collection.state().phase));
        await new Promise(resolve => setImmediate(resolve));
    };
    let mutations = 0;
    const save = async label => {
        const before = counts(f); click(label); await settled();
        const after = counts(f);
        assert.deepEqual({get: after.get - before.get, post: after.post - before.post}, {get: 2, post: 1});
        mutations++;
        assert.equal(f.files.size, 1, 'all mutations update only the collection snapshot file');
        assert.equal(collection.state().error, null);
    };

    assert.equal(await view.collect({text: '第一段完整正文', charName: '角色甲', userName: '读者乙', source: null}), true);
    assert.deepEqual(counts(f), {get: 1, post: 0}, 'the empty collection is loaded once');
    type('第一条收藏正文'); await save('保存收藏');
    const firstId = collection.state().items[0].id;
    assert.equal(dom.byClass('qm-collection-text').textContent, '第一条收藏正文');

    const navigationStart = counts(f);
    click('返回收藏列表');
    const list = dom.byClass('qm-collection-list');
    list.scrollTop = 73; list.emit('scroll');
    const row = dom.get(`阅读收藏：${firstId}`);
    click(`阅读收藏：${firstId}`); click('返回收藏列表');
    assert.equal(dom.byClass('qm-collection-list'), list);
    assert.equal(dom.get(`阅读收藏：${firstId}`), row);
    assert.equal(list.scrollTop, 73);
    view.close(); assert.equal(await view.open(), true); await settled();
    assert.equal(dom.byClass('qm-collection-list'), list);
    assert.equal(dom.get(`阅读收藏：${firstId}`), row);
    assert.equal(list.scrollTop, 73);
    assert.deepEqual(counts(f), navigationStart, 'reading, returning and reopening never refresh the snapshot');

    click(`阅读收藏：${firstId}`); click('编辑收藏'); type('第一条编辑后的正文'); await save('保存收藏');
    assert.equal(dom.byClass('qm-collection-text').textContent, '第一条编辑后的正文');
    click('返回收藏列表');
    assert.equal(await view.collect({text: '第二条完整正文', charName: '角色甲', userName: '读者乙', source: null}), true);
    await save('保存收藏');
    const secondId = collection.state().items.find(item => item.id !== firstId).id;
    click('返回收藏列表'); click('多选收藏');
    click(`选择收藏：${firstId}`); click(`选择收藏：${secondId}`);
    await save('删除选中收藏');
    assert.deepEqual(collection.state().items, []);
    assert.deepEqual(JSON.parse([...f.files.values()][0]).value.items, []);
    assert.equal(mutations, 4, 'two captures, one edit and one batch removal');
    assert.deepEqual(counts(f), {get: 1 + mutations * 2, post: mutations});
    const finished = counts(f);
    view.close(); assert.equal(await view.open(), true); await settled();
    assert.deepEqual(collection.state().items, []);
    assert.deepEqual(counts(f), finished, 'even an empty confirmed collection is reused on reopen');
});
