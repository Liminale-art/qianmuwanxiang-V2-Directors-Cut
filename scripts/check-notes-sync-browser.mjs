// Two independent devices plus same-device tabs, real browser IndexedDB, and an
// injected synthetic service. No HTTP notes client, real ST account or user data.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.QIANMU_PLAYWRIGHT_MODULE || 'playwright');
const browser = await chromium.launch({ channel: process.env.QIANMU_BROWSER_CHANNEL || undefined, headless: true });
const contexts = [], checks = [], errors = [], accounts = new Map();
let external = 0, calls = 0;
const deadline = setTimeout(() => { console.error('Notes sync browser check exceeded 120 seconds'); void browser.close(); }, 120000);
const account = namespace => {
    if (!accounts.has(namespace)) accounts.set(namespace, { revision: 0, rows: new Map(), receipts: new Map() });
    return accounts.get(namespace);
};
const expected = namespace => 'st-user:' + createHash('sha256').update(namespace.slice(8)).digest('hex');
function service({ namespace, kind, request }) {
    calls++;
    assert.match(namespace, /^st-user:synthetic-/);
    const state = account(namespace), expectedAccount = expected(namespace);
    if (kind === 'list') return { ok: true, version: 1, expectedAccount, revision: state.revision, notes: [...state.rows.values()] };
    assert.equal(kind, 'write');
    assert.deepEqual(Object.keys(request).sort(), ['baseRevision', 'deleted', 'id', 'mutationId', 'note']);
    assert.deepEqual(Object.keys(request.note).sort(), ['body', 'createdAt', 'pinned', 'title'], 'geometry is never sent to the synthetic service');
    const fingerprint = JSON.stringify(request), remembered = state.receipts.get(request.mutationId);
    if (remembered) { assert.equal(remembered.fingerprint, fingerprint); return remembered.result; }
    const previous = state.rows.get(request.id);
    if ((previous?.revision || 0) !== request.baseRevision) return { ok: false, version: 1, expectedAccount, revision: state.revision,
        code: 'notes_sync_conflict', message: 'Synthetic edit conflict', writeState: 'not_started', note: previous || null };
    const revision = ++state.revision;
    const note = { id: request.id, ...request.note, updatedAt: Date.now(), revision, deleted: request.deleted };
    if (note.deleted) Object.assign(note, { title: '', body: '', pinned: false });
    state.rows.set(note.id, note);
    const result = { ok: true, version: 1, expectedAccount, revision, note };
    state.receipts.set(request.mutationId, { fingerprint, result });
    return result;
}
async function device() {
    const context = await browser.newContext(); contexts.push(context);
    await context.exposeBinding('syntheticNotesRPC', (_, request) => structuredClone(service(request)));
    await context.route('**/*', async route => {
        const url = new URL(route.request().url());
        if (url.origin === 'https://qianmu.test') {
            if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><meta charset="utf-8"><title>Isolated notes sync</title>' });
            if (/^\/qianmu-[a-z0-9-]+\.js$/.test(url.pathname)) return route.fulfill({ contentType: 'text/javascript', body: await readFile(new URL('..' + url.pathname, import.meta.url)) });
        }
        external++; return route.abort();
    });
    return context;
}
async function boot(page, namespace = 'st-user:synthetic-a') {
    if (page.url() !== 'https://qianmu.test/') await page.goto('https://qianmu.test/');
    await page.evaluate(async namespace => {
        Object.assign(window, await import('/qianmu-notes-sync-runtime.js'), await import('/qianmu-notes-sync-store.js'), await import('/qianmu-notes-device.js'));
        window.runtime?.close(); window.store?.close();
        window.fixture = { namespace, offline: false, events: [], hold: null, held: false, release: null, wrongAccount: false, loseAck: false, wrongAck: false };
        const client = {
            async write(request) {
                if (fixture.offline) throw Error('Synthetic offline');
                if (fixture.hold === 'write') { fixture.held = true; await new Promise(resolve => fixture.release = resolve); }
                const result = await syntheticNotesRPC({ namespace, kind: 'write', request });
                if (fixture.loseAck) { fixture.loseAck = false; throw Error('Synthetic acknowledgement lost'); }
                if (fixture.wrongAck && result.ok) result.note.body = 'wrong acknowledgement body';
                return result;
            },
            async list() {
                if (fixture.offline) throw Error('Synthetic offline');
                const result = await syntheticNotesRPC({ namespace, kind: 'list' });
                if (fixture.hold === 'list') { fixture.held = true; await new Promise(resolve => fixture.release = resolve); }
                if (fixture.wrongAccount) result.expectedAccount = 'st-user:' + '0'.repeat(64);
                return result;
            },
        };
        window.store = createNotesSyncStore();
        window.runtime = createNotesSyncRuntime({ namespace, store, client, guard: () => fixture.namespace === namespace, onChange: event => fixture.events.push(event) });
        window.note = (id, body, pinned = false) => ({ id, title: '', body, pinned, createdAt: Date.now(), updatedAt: Date.now() });
    }, namespace);
}
const list = page => page.evaluate(() => runtime.list());
const sync = page => page.evaluate(() => runtime.sync());

try {
    const aContext = await device(), bContext = await device();
    const a = await aContext.newPage(), b = await bContext.newPage();
    for (const page of [a, b]) page.on('pageerror', error => errors.push(error.message));
    await boot(a); await boot(b);
    const saved = await a.evaluate(() => runtime.save(note('first', '未常驻便笺也自动保存')));
    assert.equal(saved.pinned, false);
    assert.equal((await list(b)).length, 0, 'independent contexts do not share IndexedDB');
    await a.reload(); await boot(a);
    assert.equal((await list(a))[0].body, saved.body);
    checks.push('non-prominent note survives a fresh document in real IDB, while a second device starts empty');
    await sync(a); await sync(b);
    assert.equal((await list(b))[0].body, saved.body);
    assert.equal((await list(b))[0].pinned, false);
    checks.push('the internal sync drain transfers complete unpinned prose across independent browser storage contexts (no UI sync button)');

    await a.evaluate(async () => { const current = (await runtime.list())[0]; await runtime.save({ ...current, pinned: true }); await runtime.sync(); await runtime.save({ ...(await runtime.list())[0], pinned: false }); await runtime.sync(); });
    await sync(b); assert.equal((await list(b))[0].pinned, false); assert.equal((await list(b))[0].body, saved.body);
    checks.push('pin and unpin synchronize prominence without deleting or making prose temporary');

    await a.evaluate(async () => { window.stale = (await runtime.list()).find(row => row.id === 'first'); await runtime.save({ ...stale, body: '设备 A 正文' }); });
    await b.evaluate(async () => { window.stale = (await runtime.list()).find(row => row.id === 'first'); await runtime.save({ ...stale, body: '设备 B 正文' }); });
    await sync(a); await sync(b); await sync(a);
    for (const page of [a, b]) {
        const rows = await list(page);
        assert.ok(rows.some(row => row.body === '设备 A 正文')); assert.ok(rows.some(row => row.body === '设备 B 正文'));
    }
    assert.ok((await list(b)).some(row => row.syncConflictOf === 'first'), 'conflict origin retains its local provenance marker');
    checks.push('concurrent two-device edit retains both versions with a discoverable conflict copy');

    const tab = await aContext.newPage(); tab.on('pageerror', error => errors.push(error.message)); await boot(tab);
    await Promise.all([a.evaluate(async () => { window.tabBase = (await runtime.list()).find(row => row.id === 'first'); }), tab.evaluate(async () => { window.tabBase = (await runtime.list()).find(row => row.id === 'first'); })]);
    await a.evaluate(() => runtime.save({ ...tabBase, body: '同设备标签 A' }));
    await tab.evaluate(() => runtime.save({ ...tabBase, body: '同设备标签 B' }));
    let local = await list(a);
    assert.ok(local.some(row => row.body === '同设备标签 A')); assert.ok(local.some(row => row.body === '同设备标签 B'));
    checks.push('two tabs sharing real IDB serialize their writes and preserve a stale-tab edit as a copy');

    await a.evaluate(() => { fixture.offline = true; });
    await a.evaluate(() => runtime.save(note('offline', '离线后仍完整保存')));
    await assert.rejects(sync(a), /Synthetic offline/);
    assert.ok((await list(a)).some(row => row.id === 'offline'));
    assert.ok(await a.evaluate(() => runtime.status.pending > 0));
    await a.reload(); await boot(a); assert.ok((await list(a)).some(row => row.id === 'offline'));
    await sync(a); await sync(b); assert.ok((await list(b)).some(row => row.id === 'offline'));
    checks.push('offline edits remain durable pending work across reload and arrive on the other device after reconnect');

    await a.evaluate(async () => { const current = (await runtime.list()).find(row => row.id === 'offline'); await runtime.remove(current.id, { localRevision: current.localRevision }); });
    await sync(a); await sync(b);
    assert.ok(!(await list(b)).some(row => row.id === 'offline'));
    await b.reload(); await boot(b); await sync(b); assert.ok(!(await list(b)).some(row => row.id === 'offline'));
    checks.push('a confirmed deletion propagates as a tombstone and does not resurrect after reload or another pull');

    await a.evaluate(async () => { const current = await runtime.save(note('unsent', '未发送即删除')); await runtime.remove(current.id, { localRevision: current.localRevision }); });
    await sync(a); assert.equal(account('st-user:synthetic-a').rows.has('unsent'), false);
    checks.push('deleting an unsent local note never submits a create that could resurrect it remotely');

    await a.evaluate(async () => { await runtime.save(note('inflight-delete', '创建发送后删除')); fixture.hold = 'write'; window.pendingSync = runtime.sync(); });
    await a.waitForFunction(() => fixture.held);
    await a.evaluate(async () => {
        const current = (await runtime.list()).find(row => row.id === 'inflight-delete');
        await runtime.remove(current.id, { localRevision: current.localRevision }); fixture.hold = null; fixture.release();
    });
    await a.evaluate(() => pendingSync); await sync(b);
    assert.equal(account('st-user:synthetic-a').rows.get('inflight-delete').deleted, true);
    assert.ok(!(await list(b)).some(row => row.id === 'inflight-delete'));
    checks.push('deletion while create acknowledgement is pending finishes with a remote tombstone, not a resurrected note');

    await a.evaluate(async () => { await runtime.save(note('lost-ack', '确认丢失后原操作重试')); fixture.loseAck = true; });
    await assert.rejects(sync(a), /acknowledgement lost/);
    const revisionAfterLostAck = account('st-user:synthetic-a').revision;
    await sync(a);
    assert.equal(account('st-user:synthetic-a').revision, revisionAfterLostAck);
    assert.equal((await list(a)).filter(row => row.id === 'lost-ack').length, 1);
    checks.push('lost acknowledgement retries the same durable mutation receipt without duplicating server revisions or notes');

    await a.evaluate(async () => { await runtime.save(note('bad-ack', '正文不能被错误回执替换')); fixture.wrongAck = true; });
    await assert.rejects(sync(a));
    assert.equal((await list(a)).find(row => row.id === 'bad-ack').body, '正文不能被错误回执替换');
    assert.ok(await a.evaluate(() => runtime.status.pending > 0));
    await a.evaluate(() => { fixture.wrongAck = false; }); await sync(a);
    checks.push('mismatched acknowledgement preserves local prose and pending mutation until a matching confirmation arrives');

    await a.evaluate(() => runtime.save(note('delete-both', '双方都决定删除'))); await sync(a); await sync(b);
    for (const page of [a, b]) await page.evaluate(async () => {
        const current = (await runtime.list()).find(row => row.id === 'delete-both');
        await runtime.remove(current.id, { localRevision: current.localRevision });
    });
    await sync(a); await sync(b); await sync(a);
    for (const page of [a, b]) assert.ok(!(await list(page)).some(row => row.id === 'delete-both' || row.body === '双方都决定删除'));
    checks.push('same-intent deletion on both devices accepts the remote tombstone without recreating a conflict copy');

    await a.evaluate(async () => { const current = (await runtime.list()).find(row => row.id === 'first'); window.beforeDelete = current; await runtime.remove(current.id, { localRevision: current.localRevision }); });
    const recovered = await a.evaluate(() => runtime.save({ ...beforeDelete, body: '迟到编辑应成为独立副本' }));
    assert.notEqual(recovered.id, 'first'); assert.equal(recovered.syncConflictOf, 'first');
    assert.ok(!(await list(a)).some(row => row.id === 'first'));
    checks.push('late edit of a locally deleted ID is preserved separately without reviving the deleted identity');

    await boot(b, 'st-user:synthetic-b'); assert.deepEqual(await list(b), []); await sync(b); assert.deepEqual(await list(b), []);
    await b.evaluate(() => runtime.save(note('other-account', '另一个账户'))); await sync(b);
    assert.equal(account('st-user:synthetic-a').rows.has('other-account'), false);
    await boot(b); assert.ok((await list(b)).some(row => row.body === '设备 B 正文')); assert.ok(!(await list(b)).some(row => row.id === 'other-account'));
    checks.push('account namespaces isolate local IDB, outboxes, synthetic service originals, and account restoration');

    await b.evaluate(() => { fixture.hold = 'list'; window.pendingSync = runtime.sync().then(() => ({ ok: true }), error => ({ error: error.message })); });
    await b.waitForFunction(() => fixture.held);
    await b.evaluate(() => { fixture.namespace = 'st-user:synthetic-b'; fixture.release(); });
    assert.match((await b.evaluate(() => pendingSync)).error, /账户已变化/);
    await boot(b); await b.evaluate(() => { fixture.wrongAccount = true; });
    await assert.rejects(sync(b), /另一账户/); await b.evaluate(() => { fixture.wrongAccount = false; });
    checks.push('late account-switch responses and responses naming another account cannot overwrite the local library');

    const aGeometry = { detached: true, position: { x: 90, y: 220 }, panelSize: { width: 700, height: 500 } };
    const bGeometry = { detached: false, position: { x: 12, y: 48 }, panelSize: { width: 300, height: 400 } };
    await a.evaluate(value => saveNotesDeviceState(value), aGeometry); await b.evaluate(value => saveNotesDeviceState(value), bGeometry);
    await a.reload(); await boot(a);
    assert.deepEqual(await a.evaluate(value => readNotesDeviceState(value), bGeometry), aGeometry);
    assert.deepEqual(await b.evaluate(() => readNotesDeviceState()), bGeometry);
    checks.push('device geometry persists locally and is unaffected by shared-account content sync or another device fallback');

    const migration = await a.evaluate(async () => {
        const legacy = [note('legacy-original', '旧库原文', true)];
        let denied = false; try { await runtime.importLegacy(legacy, { receipt: 'synthetic-legacy-receipt' }); } catch { denied = true; }
        const absent = !(await runtime.list()).some(row => row.id === 'legacy-original');
        const first = await runtime.importLegacy(legacy, { confirmed: true, receipt: 'synthetic-legacy-receipt' });
        const repeat = await runtime.importLegacy(legacy, { confirmed: true, receipt: 'synthetic-legacy-receipt' });
        return { denied, absent, first, repeat };
    });
    assert.equal(migration.denied && migration.absent, true); assert.equal(migration.first.imported, 1); assert.equal(migration.repeat.imported, 0); assert.equal(migration.repeat.repeated, true);
    await a.reload(); await boot(a);
    const repeated = await a.evaluate(() => runtime.importLegacy([note('legacy-original', '旧库原文', true)], { confirmed: true, receipt: 'synthetic-legacy-receipt' }));
    assert.equal(repeated.repeated, true); assert.equal(repeated.imported, 0);
    checks.push('legacy adoption requires explicit consent and its committed receipt prevents duplicates after reload');

    const atomic = await a.evaluate(async () => {
        const before = await store.read(fixture.namespace), put = IDBObjectStore.prototype.put;
        let failed = false;
        try {
            IDBObjectStore.prototype.put = function (...args) { const request = put.apply(this, args); if (this.name === 'accounts') request.addEventListener('success', () => this.transaction.abort(), { once: true }); return request; };
            try { await runtime.save(note('aborted', '不能假报已保存')); } catch { failed = true; }
        } finally { IDBObjectStore.prototype.put = put; }
        return { failed, same: JSON.stringify(await store.read(fixture.namespace)) === JSON.stringify(before) };
    });
    assert.equal(atomic.failed && atomic.same, true);
    checks.push('native IDB request success followed by transaction abort never claims a note is durably saved');

    const quota = await a.evaluate(async () => {
        const before = await store.read(fixture.namespace), put = IDBObjectStore.prototype.put;
        let failed = false;
        try {
            IDBObjectStore.prototype.put = function (...args) { if (this.name === 'accounts') throw new DOMException('Synthetic quota', 'QuotaExceededError'); return put.apply(this, args); };
            try { await runtime.save(note('quota', '配额不足保持已有原文')); } catch { failed = true; }
        } finally { IDBObjectStore.prototype.put = put; }
        return { failed, same: JSON.stringify(await store.read(fixture.namespace)) === JSON.stringify(before) };
    });
    assert.equal(quota.failed && quota.same, true);
    checks.push('native write quota failure leaves all prior local content and outbox state unchanged');

    // The actual public facade is exercised with an injected synthetic client:
    // merely seeing an old unowned library is not consent to upload it.
    const facade = await a.evaluate(async () => {
        runtime.close(); store.close();
        const api = await import('/qianmu-notes.js'), db = await import('/qianmu-blobstore.js');
        const namespace = 'st-user:synthetic-facade';
        api.configureQianmuNotes({ resolveNamespace: async () => namespace,
            createRuntime: options => createNotesSyncRuntime({ ...options, client: {
                write: request => syntheticNotesRPC({ namespace, kind: 'write', request }),
                list: () => syntheticNotesRPC({ namespace, kind: 'list' }),
            } }),
        });
        const legacy = api.normalizeQianmuNote({ id: 'unowned-legacy', body: '旧账户未知的完整原文', pinned: true });
        await db.putNote(legacy.id, legacy);
        const old = await api.listLegacyQianmuNotes(), before = await api.listQianmuNotes();
        let refused = false; try { await api.adoptLegacyQianmuNotes({ namespace }); } catch { refused = true; }
        const afterCancelled = await api.listQianmuNotes();
        const adopted = await api.adoptLegacyQianmuNotes({ confirmed: true, namespace });
        const again = await api.adoptLegacyQianmuNotes({ confirmed: true, namespace });
        const originalsRetained = (await api.listLegacyQianmuNotes()).some(row => row.id === legacy.id && row.body === legacy.body);
        await api.syncQianmuNotes();
        const saved = await api.listQianmuNotes();
        await db.clearStorageItems(['notes']);
        const afterLegacyCleanup = await api.listQianmuNotes();
        await api.syncQianmuNotes();
        await api.clearTemporaryQianmuNotes();
        return { old: old.length, before: before.length, refused, afterCancelled: afterCancelled.length, adopted, again, originalsRetained,
            saved: saved.map(row => row.body), afterLegacyCleanup: afterLegacyCleanup.map(row => row.body) };
    });
    assert.equal(facade.old, 1); assert.equal(facade.before, 0); assert.equal(facade.refused, true); assert.equal(facade.afterCancelled, 0);
    assert.equal(facade.adopted.imported, 1); assert.equal(facade.again.repeated, true); assert.equal(facade.originalsRetained, true);
    assert.deepEqual(facade.afterLegacyCleanup, facade.saved);
    assert.equal([...account('st-user:synthetic-facade').rows.values()].filter(row => !row.deleted).length, 1);
    checks.push('public facade reads unowned legacy notes without adoption, requires account consent, and leaves legacy originals after idempotent adoption');
    checks.push('explicit legacy-local cleanup does not remove account-local prose or send a cloud deletion');
    assert.equal(external, 0); assert.deepEqual(errors, []);
    console.log(JSON.stringify({ passed: checks.length, checks, errors, external, syntheticServiceCalls: calls, productionDataRead: false,
        scope: 'actual runtime/store/device modules in independent browser contexts with a injected synthetic client; not real service deployment or HTTP-client verification' }));
} finally {
    clearTimeout(deadline); for (const context of contexts) await context.close(); await browser.close();
}
