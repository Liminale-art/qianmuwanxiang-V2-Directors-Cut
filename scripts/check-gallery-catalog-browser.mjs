// Isolated native IndexedDB tests, including real 1k/10k/50k metadata fixtures.
// No ST chats, image files, existing databases, credentials or remote services.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)(process.env.QIANMU_PLAYWRIGHT_MODULE || 'playwright');
const browser = await chromium.launch({ channel: process.env.QIANMU_BROWSER_CHANNEL || undefined, headless: true });
const context = await browser.newContext(), errors = []; let external = 0;
const timer = setTimeout(() => { void browser.close(); }, 240000);
await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin === 'https://qianmu.test' && url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: '<!doctype html>' });
    if (url.origin === 'https://qianmu.test' && /^\/qianmu-gallery-catalog-(contract|store)\.js$/.test(url.pathname)) return route.fulfill({ contentType: 'application/javascript', body: await readFile(new URL('..' + url.pathname, import.meta.url)) });
    external++; return route.abort();
});
try {
    const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message)); await page.goto('https://qianmu.test/');
    const result = await page.evaluate(async () => {
        const { createGalleryCatalogStore: create } = await import('/qianmu-gallery-catalog-store.js');
        const { galleryCatalogKey: key } = await import('/qianmu-gallery-catalog-contract.js');
        const checks = [], scales = [], check = (name, passed) => { if (!passed) throw Error(name); checks.push(name); };
        const rejects = async (name, operation, code) => { let error; try { await operation(); } catch (cause) { error = cause; } check(name, Boolean(error) && (!code || error.code === 'gallery_catalog_' + code)); };
        const ns = 'st-user:alice', other = 'st-user:bob', source = { ownerKey: 'char:Alice.png', chatKey: 'Chat same name' };
        const entry = (id, extra = {}) => ({ id, kind: 'still', createdAt: 100, tags: ['海岸','旅人'], ...extra });
        const store = create(), peer = create();
        const empty = await store.page(ns); check('empty index is explicit and has no fabricated source', empty.rows.length === 0 && empty.revision === 0 && empty.totalIndexed === 0);
        let head = await store.upsert(ns, source, ['a','b','c','d'].map(id => entry(id)), { expectedRevision: 0 });
        check('four records stored atomically', head.count === 4 && head.changed === 4 && head.revision === 1);
        await store.upsert(other, source, [entry('foreign')], { expectedRevision: 0 });
        check('account isolation excludes foreign works and byte totals', (await store.page(other)).totalIndexed === 1 && (await store.page(ns)).totalIndexed === 4);
        const beforeNoop = await store.page(ns, { limit: 2 });
        head = await store.upsert(ns, source, [entry('a')], { expectedRevision: head.revision });
        check('identical upsert preserves cursor revision and usage', head.changed === 0 && head.revision === beforeNoop.revision && head.bytes === beforeNoop.indexedBytes);
        const afterNoop = await store.page(ns, { limit: 2, cursor: beforeNoop.nextCursor });
        check('same timestamp pages cover unique stable keys', [...beforeNoop.rows,...afterNoop.rows].map(row => row.recordId).join(',') === 'd,c,b,a');
        check('terminal empty page is bounded and explicit', (await store.page(ns, { limit: 2, cursor: afterNoop.nextCursor })).nextCursor === null);
        await rejects('cross-account cursor rejected', () => store.page(other, { cursor: beforeNoop.nextCursor }), 'cursor');
        await rejects('cross-filter cursor rejected', () => store.page(ns, { ownerKey: source.ownerKey, cursor: beforeNoop.nextCursor }), 'cursor');
        head = await store.upsert(ns, { ...source, ownerKey: 'char:Other.png' }, [entry('a')], { expectedRevision: head.revision });
        head = await store.upsert(ns, { ...source, ownerKey: 'group:123' }, [entry('a')], { expectedRevision: head.revision });
        check('same named chat and same record IDs retain distinct owners', (await store.page(ns)).rows.filter(row => row.recordId === 'a').length === 3);
        check('owner and chat compound indexes are exact', (await store.page(ns, source)).rows.length === 4 && (await store.page(ns, { ownerKey: 'group:123' })).rows.length === 1);
        await rejects('index updates invalidate old pagination instead of mixing snapshots', () => store.page(ns, { limit: 2, cursor: beforeNoop.nextCursor }), 'stale');
        const common = head.revision, contenders = await Promise.allSettled([
            store.upsert(ns, source, [entry('peer-a')], { expectedRevision: common }), peer.upsert(ns, source, [entry('peer-b')], { expectedRevision: common }),
        ]);
        check('two tabs with same revision commit only one update', contenders.filter(row => row.status === 'fulfilled').length === 1 && contenders.find(row => row.status === 'rejected').reason.code === 'gallery_catalog_conflict');
        let latest = await store.page(ns); const unchanged = JSON.stringify(latest);
        await rejects('old writer does not overwrite current index', () => store.upsert(ns, source, [entry('a', { label: 'stale' })], { expectedRevision: common }), 'conflict');
        await rejects('reused identity cannot change kind', () => store.upsert(ns, source, [entry('a', { kind: 'motion' })], { expectedRevision: latest.revision }), 'identity');
        await rejects('reused identity cannot change chronological position', () => store.upsert(ns, source, [entry('a', { createdAt: 101 })], { expectedRevision: latest.revision }), 'identity');
        check('failed identity edits leave all rows and accounting intact', JSON.stringify(await store.page(ns)) === unchanged);
        head = await store.upsert(ns, source, [entry('movie', { kind: 'motion', tags: ['海岸'] }), entry('a', { label: 'renamed', tags: ['海岸'] })], { expectedRevision: latest.revision });
        check('motion and still are disjoint using persisted kind', (await store.page(ns, { kind: 'motion' })).rows[0].recordId === 'movie' && !(await store.page(ns)).rows.some(row => row.recordId === 'movie'));
        check('keyword intersection excludes single-tag rows', !(await store.page(ns, { tags: ['海岸','旅人'] })).rows.some(row => row.recordId === 'a' && row.ownerKey === source.ownerKey));
        check('old keyword index entries are removed on metadata update', !(await store.page(ns, { ...source, tags: ['旅人'] })).rows.some(row => row.recordId === 'a'));
        check('removing keywords does not alter original record identity', (await store.page(ns, source)).rows.some(row => row.recordId === 'a' && row.label === 'renamed' && row.createdAt === 100));
        latest = await store.page(ns); const beforeQuota = JSON.stringify(latest), nativePut = IDBObjectStore.prototype.put;
        try {
            let writes = 0; IDBObjectStore.prototype.put = function (...args) { if (this.name === 'entries' && ++writes === 2) throw new DOMException('synthetic quota', 'QuotaExceededError'); return nativePut.apply(this, args); };
            await rejects('quota failure rejects whole batch', () => store.upsert(ns, source, [entry('quota-a'),entry('quota-b')], { expectedRevision: latest.revision }));
        } finally { IDBObjectStore.prototype.put = nativePut; }
        check('quota failure rolls back first row and header', JSON.stringify(await store.page(ns)) === beforeQuota);
        try {
            let current = true; IDBObjectStore.prototype.put = function (...args) { const request = nativePut.apply(this, args); if (this.name === 'state') request.addEventListener('success', () => { current = false; }); return request; };
            await rejects('account change before commit aborts transaction', () => store.upsert(ns, source, [entry('late')], { expectedRevision: latest.revision, isCurrent: () => current }), 'changed');
        } finally { IDBObjectStore.prototype.put = nativePut; }
        check('stale context writes neither row nor header', JSON.stringify(await store.page(ns)) === beforeQuota);
        await rejects('removal requires explicit confirmation', () => store.remove(ns, [key(latest.rows[0])], { expectedRevision: latest.revision }), 'consent');
        await rejects('removal cannot select another account', () => store.remove(ns, [[other,source.ownerKey,source.chatKey,'foreign']], { expectedRevision: latest.revision, confirmed: true }), 'source');
        const removed = await store.remove(ns, [key(latest.rows[0])], { expectedRevision: latest.revision, confirmed: true });
        check('removal updates metadata accounting only', removed.removed === 1 && removed.count === latest.totalIndexed - 1 && removed.bytes < latest.indexedBytes);
        const noRemove = await store.remove(ns, [key(latest.rows[0])], { expectedRevision: removed.revision, confirmed: true });
        check('repeat missing removal does not churn revision', noRemove.removed === 0 && noRemove.revision === removed.revision);
        const beforeRemoveFailure = JSON.stringify(await store.page(ns)), removable = (await store.page(ns)).rows.slice(0,2).map(key), nativeDelete = IDBObjectStore.prototype.delete;
        try {
            let deletes = 0; IDBObjectStore.prototype.delete = function (...args) { if (this.name === 'entries' && ++deletes === 2) throw Error('synthetic delete failure'); return nativeDelete.apply(this, args); };
            await rejects('mid-batch index removal failure is not reported as successful', () => store.remove(ns, removable, { expectedRevision: noRemove.revision, confirmed: true }));
        } finally { IDBObjectStore.prototype.delete = nativeDelete; }
        check('failed removal rolls back the already removed row and accounting', JSON.stringify(await store.page(ns)) === beforeRemoveFailure);
        const reopenBefore = JSON.stringify(await store.page(ns)); store.close(); peer.close();
        const reopened = create(); check('metadata and cursor ordering survive actual database reopen', JSON.stringify(await reopened.page(ns)) === reopenBefore); reopened.close();

        const cancelled = create({ dbName: 'qianmu-gallery-cancelled' }); await cancelled.page(ns);
        try {
            IDBObjectStore.prototype.put = function (...args) { const request = nativePut.apply(this,args); if (this.name === 'state') request.addEventListener('success', () => cancelled.close()); return request; };
            await rejects('closing the owning session aborts a still-uncommitted write', () => cancelled.upsert(ns, source, [entry('cancelled')], { expectedRevision: 0 }));
        } finally { IDBObjectStore.prototype.put = nativePut; }
        const afterCancel = create({ dbName: 'qianmu-gallery-cancelled' });
        check('closed session leaves no partially committed rows after reopen', (await afterCancel.page(ns)).totalIndexed === 0); afterCancel.close();

        const changedRead = create({ dbName: 'qianmu-gallery-read-change' }); await changedRead.upsert(ns, source, [entry('read')], { expectedRevision: 0 });
        const nativeCursor = IDBIndex.prototype.openCursor; let readCurrent = true;
        try {
            IDBIndex.prototype.openCursor = function (...args) { const request = nativeCursor.apply(this,args); request.addEventListener('success', () => { readCurrent = false; }); return request; };
            await rejects('account changes during paged reads do not deliver prior-account results', () => changedRead.page(ns, {}, { isCurrent: () => readCurrent }), 'changed');
        } finally { IDBIndex.prototype.openCursor = nativeCursor; changedRead.close(); }

        // Instrument native methods: reads must never call getAll, touch Blob data, or walk source chats.
        const nativeGetAll = IDBObjectStore.prototype.getAll, nativeIndexAll = IDBIndex.prototype.getAll, nativeBlob = Blob.prototype.arrayBuffer;
        let bulkReads = 0, blobReads = 0;
        IDBObjectStore.prototype.getAll = IDBIndex.prototype.getAll = function () { bulkReads++; throw Error('unbounded read'); };
        Blob.prototype.arrayBuffer = function () { blobReads++; throw Error('unexpected original read'); };
        try {
            for (const size of [1000,10000,50000]) {
                const scale = create({ dbName: 'qianmu-gallery-scale-' + size, timeoutMs: 30000 }), start = performance.now(); let revision = 0;
                for (let offset = 0; offset < size; offset += 200) {
                    const rows = Array.from({ length: Math.min(200, size - offset) }, (_, j) => {
                        const i = offset + j; return entry(String(i).padStart(6, '0'), { createdAt: Math.floor(i / 10), tags: i === 0 ? ['wide','rare'] : ['wide'] });
                    });
                    revision = (await scale.upsert(ns, source, rows, { expectedRevision: revision })).revision;
                }
                const indexedMs = performance.now() - start, readAt = performance.now(), first = await scale.page(ns, { limit: 40 }), readMs = performance.now() - readAt;
                const owners = await scale.scopes(ns), chats = await scale.scopes(ns, { ownerKey: source.ownerKey });
                check(size + ' rows: role and chat directories each touch one row without scanning all works', owners.rows.length === 1 && owners.visited === 1 && chats.rows.length === 1 && chats.visited === 1 && !owners.nextCursor && !chats.nextCursor);
                check(size + ' rows: first page touches exactly 40 metadata records', first.totalIndexed === size && first.rows.length === 40 && first.visited === 40);
                const second = await scale.page(ns, { limit: 40, cursor: first.nextCursor });
                check(size + ' rows: time ties do not duplicate or omit at page boundary', new Set([...first.rows,...second.rows].map(row => row.recordId)).size === 80 && first.rows[0].recordId === String(size - 1).padStart(6,'0') && second.rows.at(-1).recordId === String(size - 80).padStart(6,'0'));
                const rare = await scale.page(ns, { tags: ['rare','wide'] });
                check(size + ' rows: tag index finds intersection without a full scan', rare.rows.length === 1 && rare.visited === 1 && rare.rows[0].recordId === '000000');
                const absent = await scale.page(ns, { ownerKey: 'char:Missing.png' });
                check(size + ' rows: absent owner reads no unrelated records', absent.rows.length === 0 && absent.visited === 0);
                // First alphabetic tag is deliberately common; predicate miss still has a bounded continuation.
                const bounded = await scale.page(ns, { tags: ['wide','zz-absent'] });
                check(size + ' rows: sparse intersection yields a bounded nonempty continuation cursor', bounded.rows.length === 0 && bounded.visited === 512 && bounded.nextCursor !== null);
                const boundedNext = await scale.page(ns, { tags: ['wide','zz-absent'], cursor: bounded.nextCursor });
                check(size + ' rows: sparse continuation advances rather than rereading the same records', boundedNext.visited <= 512 && (!boundedNext.nextCursor || JSON.stringify(boundedNext.nextCursor.after) !== JSON.stringify(bounded.nextCursor.after)));
                if (size === 1000) {
                    let cursor = null; const ids = []; do { const part = await scale.page(ns, { limit: 60, cursor }); ids.push(...part.rows.map(row => row.recordId)); cursor = part.nextCursor; } while (cursor);
                    check('complete 1k traversal has no duplicates, gaps or unstable time ties', ids.length === size && new Set(ids).size === size && ids.every((id, i) => id === String(size-i-1).padStart(6,'0')));
                }
                scales.push({ count: size, firstPageVisited: first.visited, indexedBytes: first.indexedBytes, indexedMs: Math.round(indexedMs), firstPageMs: Math.round(readMs * 100) / 100 }); scale.close();
            }
        } finally { IDBObjectStore.prototype.getAll = nativeGetAll; IDBIndex.prototype.getAll = nativeIndexAll; Blob.prototype.arrayBuffer = nativeBlob; }
        check('all scale queries avoid bulk and original-byte reads', bulkReads === 0 && blobReads === 0);

        // Corrupt a synthetic database directly; production methods must fail closed without rewriting it.
        const damaged = create({ dbName: 'qianmu-gallery-damaged' }); await damaged.upsert(ns, source, [entry('x')], { expectedRevision: 0 }); damaged.close();
        const raw = await new Promise((resolve, reject) => { const r = indexedDB.open('qianmu-gallery-damaged'); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
        await new Promise((resolve, reject) => { const tx = raw.transaction('state','readwrite'); tx.objectStore('state').delete(ns); tx.oncomplete = resolve; tx.onabort = () => reject(tx.error); }); raw.close();
        const corrupted = create({ dbName: 'qianmu-gallery-damaged' }); await rejects('missing index header is not misreported as an empty library', () => corrupted.page(ns), 'index');
        await rejects('missing index header cannot be implicitly repaired by overwrite', () => corrupted.upsert(ns, source, [entry('new')], { expectedRevision: 0 }), 'index'); corrupted.close();
        const databases = await indexedDB.databases(); check('all databases belong to synthetic gallery fixtures only', databases.every(row => row.name.startsWith('qianmu-gallery-')));
        return { checks, scales, realIndexedDB: true, bulkReads, blobReads, limits: 'derived metadata foundation only; no production integration, thumbnails, cloud archive or physical device claims' };
    });
    assert.equal(external, 0); assert.deepEqual(errors, []); console.log(JSON.stringify({ ...result, external, errors }));
} finally { clearTimeout(timer); await context.close(); await browser.close(); }
