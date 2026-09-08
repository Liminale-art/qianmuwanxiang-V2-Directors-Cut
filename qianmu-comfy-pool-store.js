// Lazy, account-scoped selection configuration. No workflow graphs, media, credentials or execution permissions.
import { normalizeComfyAutoPool } from './qianmu-comfy-selection.js';
import { assertComfyRouteNamespace } from './qianmu-comfy-route-contract.js';

export const COMFY_POOL_DOCUMENT_SCHEMA = 'qianmu.comfy.pool-document.v1';
export const COMFY_POOL_LIMITS = Object.freeze({ plans: 32, versions: 64, documentBytes: 256 * 1024, totalBytes: 16 * 1024 * 1024 });
const error = (code, message) => Object.assign(new Error(message), { code: `comfy_pool_${code}`, submissionState: 'not_submitted' });
const fail = (code, message) => { throw error(code, message); };
const identifier = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,160}$/.test(value);
const bytes = value => new TextEncoder().encode(JSON.stringify(value)).byteLength;
const nameOf = value => {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 80 || /[\u0000-\u001f\u007f]/.test(value)) fail('name', '请填写 1 至 80 字的候选方案名');
  return value.trim();
};
const account = value => { try { return assertComfyRouteNamespace(value); } catch (_) { fail('account', '无法确认候选方案所属的 ST 账户'); } };
const keyFor = (namespace, id) => {
  account(namespace); if (!identifier(id)) fail('identity', '候选方案编号无效'); return JSON.stringify([namespace, id]);
};
const versionKey = (namespace, id, revision) => {
  keyFor(namespace, id); if (!identifier(revision)) fail('identity', '候选方案版本编号无效'); return JSON.stringify([namespace, id, revision]);
};
const poolOf = (pool, namespace) => {
  let normalized; try { normalized = normalizeComfyAutoPool(pool); } catch (cause) { fail('invalid', cause.message || '候选方案无效'); }
  if (normalized.namespace !== account(namespace)) fail('account', '候选方案属于另一账户，请在当前账户重新绑定工作流');
  if (bytes(normalized) > COMFY_POOL_LIMITS.documentBytes) fail('capacity', '候选方案过大，请拆分方案或减少参考图绑定');
  return normalized;
};
export function exportComfyPoolDocument(name, pool, namespace) {
  return { schema: COMFY_POOL_DOCUMENT_SCHEMA, name: nameOf(name), pool: poolOf(pool, namespace) };
}
export function importComfyPoolDocument(contents, namespace) {
  account(namespace);
  if (typeof contents !== 'string' || new TextEncoder().encode(contents).byteLength > 1024 * 1024) fail('import', '候选方案文件须小于 1 MB');
  let raw; try { raw = JSON.parse(contents); } catch (_) { fail('import', '候选方案文件不是有效 JSON'); }
  if (raw?.schema !== COMFY_POOL_DOCUMENT_SCHEMA) fail('version', '候选方案文件版本不兼容');
  const value = exportComfyPoolDocument(raw.name, raw.pool, namespace);
  // Import is a new draft, never permission to turn on an imported automation or a scene lock.
  const wasEnabled = value.pool.enabled || value.pool.candidates.some(candidate => candidate.enabled);
  value.pool.enabled = false; value.pool.candidates.forEach(candidate => { candidate.enabled = false; });
  return { name: value.name, pool: value.pool, requiresReview: true, disabledImportedChoices: wasEnabled };
}

export function createComfyPoolStore({ indexedDB = globalThis.indexedDB, keyRange = globalThis.IDBKeyRange,
  dbName = 'qianmu-comfy-pools', timeoutMs = 6000, maxBytes = COMFY_POOL_LIMITS.totalBytes, now = Date.now } = {}) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > COMFY_POOL_LIMITS.totalBytes) fail('capacity', '候选方案仓容量配置无效');
  const stores = ['heads', 'versions', 'documents'], timeout = Math.max(100, Math.min(15000, Number(timeoutMs) || 6000));
  let database = null, opening = null, closed = false; const pending = new Set();
  const storageError = () => error('storage', '候选方案仓暂不可用，请检查浏览器储存空间');
  function open() {
    if (closed) return Promise.reject(error('closed', '候选方案仓会话已结束'));
    if (database) return Promise.resolve(database); if (opening) return opening;
    const promise = new Promise((resolve, reject) => {
      let request, done = false;
      const finish = (cause, value) => { if (done) { value?.close(); return; } done = true; clearTimeout(timer); cause ? reject(cause) : resolve(value); };
      const timer = setTimeout(() => finish(error('timeout', '候选方案仓读取超时，请关闭旧页面后重试')), timeout);
      try { request = indexedDB.open(dbName, 1); } catch (_) { finish(storageError()); return; }
      request.onupgradeneeded = () => {
        if (done || closed) { request.transaction?.abort(); return; }
        for (const name of stores) if (!request.result.objectStoreNames.contains(name)) {
          const store = request.result.createObjectStore(name, { keyPath: 'key' });
          if (name === 'heads') store.createIndex('namespace', 'namespace');
          if (name === 'versions') store.createIndex('poolKey', 'poolKey');
        }
      };
      request.onerror = () => finish(storageError());
      request.onblocked = () => finish(error('blocked', '候选方案仓被旧页面占用，请关闭后重试'));
      request.onsuccess = () => {
        const value = request.result;
        if (done || closed) { value.close(); finish(error('closed', '候选方案仓会话已结束')); return; }
        database = value;
        const release = () => { if (database === value) { database = null; opening = null; } };
        value.onversionchange = () => { value.close(); release(); }; value.onclose = release; finish(null, value);
      };
    }); opening = promise; void promise.catch(() => { if (opening === promise) opening = null; }); return promise;
  }
  async function operation(names, mode, work, isCurrent = () => true) {
    const current = () => { if (isCurrent() !== true) fail('changed', '候选方案备份页面已变化'); };
    current(); const db = await open(); current(); if (closed) fail('closed', '候选方案仓会话已结束');
    return new Promise((resolve, reject) => {
      let tx, result, failure, done = false;
      const finish = cause => {
        if (done) return; done = true; clearTimeout(timer); pending.delete(tx);
        cause || closed ? reject(cause || error('closed', '候选方案仓会话已结束')) : resolve(result);
      };
      const abort = cause => { failure = typeof cause?.code === 'string' && cause.code.startsWith('comfy_pool_') ? cause : storageError(); try { tx.abort(); } catch (_) { finish(failure); } };
      const timer = setTimeout(() => { failure = error('timeout', '操作结果尚未确认，请刷新核对后再试'); try { tx?.abort(); } catch (_) {} finish(failure); }, timeout);
      try { tx = db.transaction(names, mode); pending.add(tx); } catch (_) { finish(storageError()); return; }
      tx.oncomplete = () => { try { current(); finish(); } catch (cause) { finish(cause); } }; tx.onabort = () => finish(failure || storageError()); tx.onerror = () => { failure ||= storageError(); };
      const read = (request, receive) => { request.onsuccess = () => { try { current(); receive(request.result); } catch (cause) { abort(cause); } }; };
      try { work(tx, read, value => { result = value; }); } catch (cause) { abort(cause); }
    });
  }
  const integer = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max;
  const metadata = (row, namespace, historical = false) => {
    if (!row || row.namespace !== namespace || !identifier(row.id) || !identifier(row.revision)
      || row.key !== (historical ? versionKey(namespace, row.id, row.revision) : keyFor(namespace, row.id))
      || historical && row.poolKey !== keyFor(namespace, row.id)
      || !integer(row.version, 1, COMFY_POOL_LIMITS.versions) || nameOf(row.name) !== row.name
      || !integer(row.bytes, 1, COMFY_POOL_LIMITS.documentBytes) || !integer(row.totalBytes, row.bytes, COMFY_POOL_LIMITS.totalBytes)
      || !integer(row.candidateCount, 0, 32) || !integer(row.createdAt, 0, Number.MAX_SAFE_INTEGER) || !integer(row.updatedAt, row.createdAt, Number.MAX_SAFE_INTEGER)
      || typeof row.archived !== 'boolean' || typeof row.enabled !== 'boolean' || typeof row.styleLock !== 'boolean') fail('index', '候选方案索引异常，不会覆盖原数据');
    const { key, id, revision, version, name, createdAt, updatedAt, archived, totalBytes, candidateCount, enabled, styleLock } = row;
    return { key, namespace, id, revision, version, name, createdAt, updatedAt, archived, bytes: row.bytes, totalBytes, candidateCount, enabled, styleLock };
  };
  const heads = (tx, read, namespace, receive) => read(tx.objectStore('heads').index('namespace').getAll(keyRange.only(namespace), COMFY_POOL_LIMITS.plans + 1), rows => {
    if (rows.length > COMFY_POOL_LIMITS.plans) fail('capacity', '候选方案数量超过上限，请先核查');
    receive(rows.map(row => metadata(row, namespace)));
  });
  const sort = rows => rows.sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
  async function snapshot(namespace, isCurrent) {
    account(namespace); return operation(stores, 'readonly', (tx, read, set) => {
      read(tx.objectStore('heads').index('namespace').getAll(keyRange.only(namespace), COMFY_POOL_LIMITS.plans + 1), all => {
        if (all.length > COMFY_POOL_LIMITS.plans) fail('capacity', '候选方案数量超过备份上限');
        const records = []; let pendingHeads = all.length;
        const complete = () => {
          const expected = records.flatMap(row => row.versions.map(version => version.meta.key)).sort();
          const prefix = JSON.stringify([namespace]).slice(0, -1) + ',', range = keyRange.bound(prefix, prefix + '\uffff'); let checked = 0;
          for (const name of ['documents', 'versions']) read(tx.objectStore(name).getAllKeys(range, COMFY_POOL_LIMITS.plans * COMFY_POOL_LIMITS.versions + 1), keys => {
            if (JSON.stringify(keys.sort()) !== JSON.stringify(expected)) fail('backup', '候选方案存在未关联或缺失的历史原件，请先保全核对');
            if (++checked === 2) set(records);
          });
        };
        if (!pendingHeads) { complete(); return; }
        for (const head of all) {
          metadata(head, namespace);
          read(tx.objectStore('versions').index('poolKey').getAll(keyRange.only(head.key), COMFY_POOL_LIMITS.versions + 1), rows => {
            if (rows.length !== head.version || rows.length > COMFY_POOL_LIMITS.versions) fail('backup', '候选方案历史版本缺失或超限');
            const record = { head, versions: [] }; records.push(record); let pendingDocuments = rows.length;
            for (const meta of rows) {
              metadata(meta, namespace, true); if (meta.id !== head.id) fail('backup', '候选方案历史版本归属不符');
              read(tx.objectStore('documents').get(meta.key), row => {
                if (!row || row.key !== meta.key || row.namespace !== namespace || row.id !== head.id || row.revision !== meta.revision
                  || row.version !== meta.version || row.name !== meta.name || row.bytes !== meta.bytes
                  || Object.keys(row).some(key => !['key', 'namespace', 'id', 'revision', 'version', 'name', 'pool', 'bytes'].includes(key))) fail('backup', '候选方案原文缺失或归属不符');
                record.versions.push({ meta, pool: row.pool }); if (!--pendingDocuments && !--pendingHeads) complete();
              });
            }
          });
        }
      });
    }, isCurrent);
  }
  return Object.freeze({
    async backup(namespace, { isCurrent = () => true } = {}) {
      const codec = await import('./qianmu-comfy-pool-backup.js'), records = await snapshot(namespace, isCurrent);
      const value = codec.packComfyPoolRecords(namespace, records); if (isCurrent() !== true) fail('changed', '候选方案备份页面已变化'); return value;
    },
    async restoreBackup(namespace, input, { expectedDigest, confirmed = false, isCurrent = () => true } = {}) {
      if (confirmed !== true || typeof expectedDigest !== 'string' || !/^[a-f0-9]{64}$/.test(expectedDigest)) fail('backup', '请先核对并确认候选方案库恢复');
      const incoming = structuredClone(input), codec = await import('./qianmu-comfy-pool-backup.js'); codec.validateComfyPoolBackup(incoming);
      if (incoming.namespace !== account(namespace)) fail('backup', '候选方案备份属于另一 ST 账户，请重新绑定连接与参考图');
      const records = await snapshot(namespace, isCurrent), local = codec.packComfyPoolRecords(namespace, records);
      if (await codec.comfyPoolBackupDigest(local) !== expectedDigest) fail('conflict', '候选方案库在确认后已变化，请重新核对');
      const plan = codec.planComfyPoolRestore(local, incoming, { maxBytes }), writes = plan.writes.map(row => codec.unpackComfyPoolRecord(namespace, row));
      return operation(stores, 'readwrite', (tx, read, set) => read(tx.objectStore('heads').index('namespace').getAll(keyRange.only(namespace), COMFY_POOL_LIMITS.plans + 1), all => {
        const ordered = rows => rows.slice().sort((a, b) => a.id.localeCompare(b.id));
        if (JSON.stringify(ordered(all)) !== JSON.stringify(ordered(records.map(row => row.head)))) fail('conflict', '候选方案库在准备期间已变化，未覆盖');
        for (const row of writes) {
          for (const version of row.versions) { tx.objectStore('documents').add(version.document); tx.objectStore('versions').add(version.meta); }
          tx.objectStore('heads').put(row.head);
        }
        set(plan.summary);
      }), isCurrent);
    },
    async list(namespace, { archived = false } = {}) {
      account(namespace); return operation(['heads'], 'readonly', (tx, read, set) => heads(tx, read, namespace, rows => set(sort(rows.filter(row => row.archived === Boolean(archived))))));
    },
    async versions(namespace, id) {
      const key = keyFor(namespace, id); return operation(['versions'], 'readonly', (tx, read, set) => {
        read(tx.objectStore('versions').index('poolKey').getAll(keyRange.only(key), COMFY_POOL_LIMITS.versions + 1), rows => {
          if (rows.length > COMFY_POOL_LIMITS.versions) fail('capacity', '候选方案版本超过上限');
          set(rows.map(row => { if (row.id !== id) fail('index', '候选方案版本归属异常'); return metadata(row, namespace, true); }).sort((a, b) => b.version - a.version));
        });
      });
    },
    async load(namespace, id, revision) {
      const key = versionKey(namespace, id, revision); return operation(['documents'], 'readonly', (tx, read, set) => {
        read(tx.objectStore('documents').get(key), row => {
          if (!row) { set(null); return; }
          if (row.key !== key || row.namespace !== namespace || row.id !== id || row.revision !== revision || !integer(row.version, 1, COMFY_POOL_LIMITS.versions)) fail('index', '候选方案正文归属异常');
          const pool = poolOf(row.pool, namespace), name = nameOf(row.name);
          if (pool.id !== id || pool.revision !== revision || bytes(pool) !== row.bytes) fail('index', '候选方案正文与版本不符');
          set({ id, revision, version: row.version, name, pool });
        });
      });
    },
    async save(namespace, { id = '', expectedRevision = '', name, pool } = {}) {
      account(namespace); name = nameOf(name); const captured = poolOf(pool, namespace);
      if (id) {
        versionKey(namespace, id, expectedRevision);
        if (captured.id !== id || captured.revision !== expectedRevision) fail('conflict', '草稿与原候选方案版本不符，请重新载入或另存');
      } else if (expectedRevision) fail('conflict', '新候选方案不能覆盖已有版本');
      if (!globalThis.crypto?.randomUUID) fail('identity', '请使用 HTTPS 或本机地址保存候选方案');
      const poolId = id || globalThis.crypto.randomUUID(), revision = globalThis.crypto.randomUUID(), key = keyFor(namespace, poolId);
      const saved = poolOf({ ...captured, id: poolId, revision }, namespace), documentBytes = bytes(saved);
      return operation(stores, 'readwrite', (tx, read, set) => {
        const headStore = tx.objectStore('heads'); read(headStore.get(key), raw => {
          const previous = raw ? metadata(raw, namespace) : null;
          if (id && !previous || previous && previous.revision !== expectedRevision) fail('conflict', '候选方案已被另一页修改，请重新载入或另存');
          if (previous?.archived) fail('archived', '请先恢复已归档的候选方案');
          heads(tx, read, namespace, rows => {
            if (!previous && rows.length >= COMFY_POOL_LIMITS.plans || (previous?.version || 0) >= COMFY_POOL_LIMITS.versions
              || rows.reduce((sum, row) => sum + row.totalBytes, 0) + documentBytes > maxBytes) fail('capacity', '候选方案仓达到数量、版本或容量上限，请先导出并整理归档方案');
            const at = now(); if (!integer(at, previous?.updatedAt || 0, Number.MAX_SAFE_INTEGER)) fail('clock', '本机时间发生回退，请校准后再保存');
            const version = (previous?.version || 0) + 1, docKey = versionKey(namespace, poolId, revision);
            const row = { key, namespace, id: poolId, revision, version, name, createdAt: previous?.createdAt ?? at, updatedAt: at,
              archived: false, bytes: documentBytes, totalBytes: (previous?.totalBytes || 0) + documentBytes,
              candidateCount: saved.candidates.length, enabled: saved.enabled, styleLock: saved.styleLock };
            tx.objectStore('documents').add({ key: docKey, namespace, id: poolId, revision, version, name, pool: saved, bytes: documentBytes });
            tx.objectStore('versions').add({ ...row, key: docKey, poolKey: key }); headStore.put(row); set(metadata(row, namespace));
          });
        });
      });
    },
    async archive(namespace, id, expectedRevision, archived = true) {
      const key = keyFor(namespace, id); versionKey(namespace, id, expectedRevision);
      if (typeof archived !== 'boolean') fail('invalid', '归档状态无效');
      return operation(['heads'], 'readwrite', (tx, read, set) => {
        const store = tx.objectStore('heads'); read(store.get(key), raw => {
          if (!raw) fail('conflict', '候选方案已不存在'); const previous = metadata(raw, namespace);
          if (previous.revision !== expectedRevision) fail('conflict', '候选方案已变化，请刷新后再操作');
          const at = now(); if (!integer(at, previous.updatedAt, Number.MAX_SAFE_INTEGER)) fail('clock', '本机时间发生回退，请校准后再操作');
          const next = { ...previous, archived, updatedAt: at }; store.put(next); set(next);
        });
      });
    },
    async purge(namespace, id, expectedRevision) {
      const key = keyFor(namespace, id); versionKey(namespace, id, expectedRevision);
      return operation(stores, 'readwrite', (tx, read, set) => {
        const store = tx.objectStore('heads'); read(store.get(key), raw => {
          if (!raw) fail('conflict', '候选方案已不存在'); const row = metadata(raw, namespace);
          if (row.revision !== expectedRevision || !row.archived) fail('conflict', '仅可永久清理仍未变化的归档方案');
          let removed = 0; const request = tx.objectStore('versions').index('poolKey').openCursor(keyRange.only(key));
          read(request, cursor => {
            if (!cursor) { if (removed !== row.version) fail('index', '候选方案历史索引不完整，请先导出核查'); store.delete(key); set({ removed, bytes: row.totalBytes }); return; }
            const version = metadata(cursor.value, namespace, true);
            if (version.id !== id || ++removed > COMFY_POOL_LIMITS.versions) fail('index', '候选方案历史归属异常');
            tx.objectStore('documents').delete(version.key); cursor.delete(); cursor.continue();
          });
        });
      });
    },
    async usage(namespace) {
      account(namespace); return operation(['heads'], 'readonly', (tx, read, set) => heads(tx, read, namespace, rows => set({
        count: rows.length, archived: rows.filter(row => row.archived).length, versions: rows.reduce((sum, row) => sum + row.version, 0),
        bytes: rows.reduce((sum, row) => sum + row.totalBytes, 0), limit: maxBytes,
      })));
    },
    close() { closed = true; for (const tx of pending) try { tx.abort(); } catch (_) {} database?.close(); database = null; opening = null; },
  });
}
