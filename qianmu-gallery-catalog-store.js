import { GALLERY_CATALOG_VERSION, GALLERY_CATALOG_LIMITS as limits, galleryCatalogError, galleryCatalogAccount,
    galleryCatalogSource, projectGalleryCatalogEntry, galleryCatalogKey, galleryCatalogStoredRow, galleryCatalogStoredEntry,
    galleryCatalogQuery, galleryCatalogMatches } from './qianmu-gallery-catalog-contract.js';

// Lazy, derived metadata only. Not opened on import or wired to live chat saves yet.
// Existing media, recipes, source identities and receipts remain their respective authorities.
export function createGalleryCatalogStore({ indexedDB = globalThis.indexedDB, keyRange = globalThis.IDBKeyRange,
    dbName = 'qianmu-gallery-catalog', timeoutMs = 8000 } = {}) {
    let database = null, opening = null, closed = false;
    const pending = new Set(), timeout = Math.max(100, Math.min(30000, Number(timeoutMs) || 8000));
    const fail = (code, message) => { throw galleryCatalogError(code, message); };
    const check = guard => { if (closed) fail('closed', '图库目录会话已关闭'); if (guard() !== true) fail('changed', '图库目录的账户或页面已变化'); };
    function open() {
        if (closed) return Promise.reject(galleryCatalogError('closed', '图库目录会话已关闭'));
        if (database) return Promise.resolve(database); if (opening) return opening;
        const attempt = new Promise((resolve, reject) => {
            let request, done = false;
            const finish = (error, db) => { if (done) { db?.close(); return; } done = true; clearTimeout(timer); error ? reject(error) : resolve(db); };
            const timer = setTimeout(() => finish(galleryCatalogError('timeout', '图库目录打开超时，请稍后重试')), timeout);
            try { request = indexedDB.open(dbName, 1); } catch (_) { finish(galleryCatalogError('storage', '图库目录暂不可用')); return; }
            request.onupgradeneeded = () => {
                if (done || closed) { request.transaction?.abort(); return; }
                const db = request.result, store = db.createObjectStore('entries', { keyPath: 'key' });
                store.createIndex('namespace', 'namespace');
                store.createIndex('time', ['namespace', 'kind', 'createdAt', 'ownerKey', 'chatKey', 'recordId']);
                store.createIndex('owner', ['namespace', 'kind', 'ownerKey', 'createdAt', 'chatKey', 'recordId']);
                store.createIndex('chat', ['namespace', 'kind', 'ownerKey', 'chatKey', 'createdAt', 'recordId']);
                store.createIndex('tag', 'tagKeys', { multiEntry: true });
                db.createObjectStore('state', { keyPath: 'namespace' });
            };
            request.onblocked = () => finish(galleryCatalogError('blocked', '图库目录被旧页面占用，请关闭后重试'));
            request.onerror = () => finish(galleryCatalogError('storage', '图库目录打开失败，原作品未修改'));
            request.onsuccess = () => {
                const db = request.result;
                if (done || closed) { db.close(); finish(galleryCatalogError('closed', '图库目录会话已结束')); return; }
                database = db;
                const release = () => { if (database === db) { database = null; opening = null; } };
                db.onversionchange = () => { db.close(); release(); }; db.onclose = release; finish(null, db);
            };
        });
        opening = attempt; void attempt.catch(() => { if (opening === attempt) opening = null; }); return attempt;
    }
    async function operation(mode, guard, work) {
        check(guard); const db = await open(); check(guard);
        return new Promise((resolve, reject) => {
            let tx, result, failure, done = false;
            const finish = error => { if (done) return; done = true; clearTimeout(timer); pending.delete(tx); error ? reject(error) : resolve(result); };
            const abort = error => { failure = error; try { tx?.abort(); } catch (_) { finish(error); } };
            const timer = setTimeout(() => { const error = galleryCatalogError('timeout', '图库目录操作结果未确认，请重新读取核对'); abort(error); finish(error); }, timeout);
            try { tx = db.transaction(['entries', 'state'], mode); pending.add(tx); } catch (_) { finish(galleryCatalogError('storage', '图库目录暂不可用')); return; }
            tx.oncomplete = () => { try { check(guard); finish(); } catch (error) { finish(error); } };
            tx.onabort = () => finish(failure || galleryCatalogError('storage', '图库目录操作未完成，原作品未修改'));
            tx.onerror = () => { failure ||= galleryCatalogError('storage', '图库目录储存不足或读写失败'); };
            const read = (request, next) => { request.onsuccess = () => { if (done) return; try { check(guard); next(request.result); } catch (error) { abort(error); } }; };
            try { work(tx, read, value => { result = value; }); } catch (error) { abort(error); }
        });
    }
    function state(tx, read, namespace, next) {
        read(tx.objectStore('state').get(namespace), row => {
            if (row) {
                if (Object.keys(row).length !== 4 || row.namespace !== namespace || !Number.isSafeInteger(row.revision) || row.revision < 1
                    || !Number.isSafeInteger(row.count) || row.count < 0 || row.count > limits.entries || !Number.isSafeInteger(row.bytes) || row.bytes < 0 || row.bytes > limits.bytes) fail('index', '图库目录计值异常，请保留资料核对');
                next({ ...row }); return;
            }
            // A missing header with existing rows is damage, not an empty library to overwrite.
            read(tx.objectStore('entries').index('namespace').count(keyRange.only(namespace)), count => {
                if (count) fail('index', '图库目录计值缺失，未覆盖旧索引'); next({ namespace, revision: 0, count: 0, bytes: 0 });
            });
        });
    }
    return {
        async page(namespace, input = {}, { isCurrent = () => true } = {}) {
            const query = galleryCatalogQuery(namespace, structuredClone(input));
            return operation('readonly', isCurrent, (tx, read, set) => state(tx, read, namespace, header => {
                if (query.cursor && query.cursor.revision !== header.revision) fail('stale', '图库目录已更新，请重新载入第一页');
                const range = keyRange.bound(query.prefix, query.cursor?.after ?? [...query.prefix, []], false, true);
                const request = tx.objectStore('entries').index(query.index).openCursor(range, 'prev');
                const rows = []; let visited = 0;
                const finish = after => set({ version: GALLERY_CATALOG_VERSION, namespace, revision: header.revision,
                    totalIndexed: header.count, indexedBytes: header.bytes, rows, visited,
                    nextCursor: after ? { version: GALLERY_CATALOG_VERSION, signature: query.signature, revision: header.revision, after } : null });
                read(request, cursor => {
                    if (!cursor) { finish(null); return; }
                    visited++; const row = galleryCatalogStoredEntry(cursor.value, namespace);
                    if (galleryCatalogMatches(row, query)) rows.push(row);
                    if (rows.length >= query.limit || visited >= limits.scan) finish(cursor.key);
                    else cursor.continue();
                });
            }));
        },
        async upsert(namespace, source, entries, { expectedRevision, isCurrent = () => true } = {}) {
            namespace = galleryCatalogAccount(namespace); source = galleryCatalogSource(source);
            if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || expectedRevision === Number.MAX_SAFE_INTEGER) fail('revision', '请先读取当前目录版本再更新');
            if (!Array.isArray(entries) || !entries.length || entries.length > limits.batch) fail('batch', '图库索引每批须为 1 至 200 项');
            const rows = Array.from(entries, entry => galleryCatalogStoredRow(projectGalleryCatalogEntry(namespace, source, entry)));
            if (new Set(rows.map(row => JSON.stringify(row.key))).size !== rows.length) fail('duplicate', '同一批图库记录编号重复，未写入');
            return operation('readwrite', isCurrent, (tx, read, set) => state(tx, read, namespace, header => {
                if (header.revision !== expectedRevision) fail('conflict', '另一页面已更新图库目录，请重读后再保存');
                const store = tx.objectStore('entries'); let at = 0, changed = 0;
                const next = () => {
                    if (at === rows.length) {
                        if (changed) { header.revision++; read(tx.objectStore('state').put(header), () => set({ ...header, changed })); }
                        else set({ ...header, changed }); return;
                    }
                    const row = rows[at++];
                    read(store.get(row.key), previous => {
                        if (previous) {
                            galleryCatalogStoredEntry(previous, namespace);
                            if (header.count < 1 || header.bytes < previous.bytes) fail('index', '图库目录计值与已有记录不符');
                            if (previous.createdAt !== row.createdAt || previous.kind !== row.kind) fail('identity', '已有作品的类型或生成时间变化，请核对原记录');
                            if (previous.label === row.label && JSON.stringify(previous.tags) === JSON.stringify(row.tags)) { next(); return; }
                            header.bytes -= previous.bytes;
                        } else header.count++;
                        header.bytes += row.bytes;
                        if (header.count > limits.entries || header.bytes > limits.bytes || header.bytes < row.bytes) fail('capacity', '图库目录达到容量边界，未删除旧作品或截断结果');
                        store.put(row); changed++; next();
                    });
                }; next();
            }));
        },
        // Explicit derived-index removal only. Never delete a media file or source chat.
        async remove(namespace, keys, { expectedRevision, confirmed = false, isCurrent = () => true } = {}) {
            namespace = galleryCatalogAccount(namespace);
            if (confirmed !== true || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || expectedRevision === Number.MAX_SAFE_INTEGER) fail('consent', '请确认移除目录引用并提供当前版本');
            if (!Array.isArray(keys) || !keys.length || keys.length > limits.batch) fail('batch', '目录移除范围无效');
            const captured = keys.map(value => {
                if (!Array.isArray(value) || value.length !== 4 || value[0] !== namespace) fail('source', '目录引用属于另一账户或范围无效');
                return galleryCatalogKey(projectGalleryCatalogEntry(namespace, { ownerKey: value[1], chatKey: value[2] }, { id: value[3], kind: 'still', createdAt: 0 }));
            });
            if (new Set(captured.map(value => JSON.stringify(value))).size !== captured.length) fail('duplicate', '目录移除范围重复');
            return operation('readwrite', isCurrent, (tx, read, set) => state(tx, read, namespace, header => {
                if (header.revision !== expectedRevision) fail('conflict', '图库目录已变化，请重新核对移除范围');
                const store = tx.objectStore('entries'); let at = 0, removed = 0;
                const next = () => {
                    if (at === captured.length) {
                        if (removed) { header.revision++; read(tx.objectStore('state').put(header), () => set({ ...header, removed })); }
                        else set({ ...header, removed }); return;
                    }
                    const key = captured[at++]; read(store.get(key), row => {
                        if (row) { galleryCatalogStoredEntry(row, namespace); header.count--; header.bytes -= row.bytes;
                            if (header.count < 0 || header.bytes < 0) fail('index', '图库目录计值不符，未移除'); store.delete(key); removed++; }
                        next();
                    });
                }; next();
            }));
        },
        close() { closed = true; for (const tx of pending) { try { tx.abort(); } catch (_) {} } database?.close(); database = null; opening = null; },
    };
}
