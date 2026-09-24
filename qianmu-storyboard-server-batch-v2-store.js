// Server-only, metadata-only v2 batch ledger. Importing this module does not
// register a route, submit a provider request, or authorize a fee.
import * as fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { imageServiceAccount, imageServiceAccountStillMatches } from './qianmu-image-service-access.js';
import {
  batchPublicView,
  createStoryboardServerBatchBusinessError,
  isStoryboardServerBatchBusinessError,
  normalizeBatchRecord,
  normalizePreparedBatch,
  storyboardServerBatchKey,
} from './qianmu-storyboard-server-batch-contract.js';
import { decideStoryboardBatchV2Prepare, storyboardBatchV2Location } from './qianmu-storyboard-server-batch-layout.js';

const SCHEMA = 'qianmu.storyboard-batch-disk.v2';
const MAX_RECORD_BYTES = 72 * 1024;
const MAX_SHARD_RECORDS = 256;
const MAX_PENDING = 64;
const BATCH_ID = '[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}';
const RECORD_NAME = new RegExp(`^(\\d{16})-(${BATCH_ID})\\.json$`);
const SHARD_NAME = /^[a-f0-9]{2}$/;
const ACCOUNT_PROBE_ID = '00000000-0000-4000-8000-000000000000';
const hash = value => createHash('sha256').update(value).digest('hex');
const sameFile = (a, b) => a.dev === b.dev && a.ino === b.ino;
const isMissing = cause => cause?.code === 'ENOENT';
const storageErrors = new WeakSet();
const storageError = (code, message, status = 409) => {
  const error = Object.assign(new Error(message), {
    name: 'StoryboardServerBatchV2StorageError', code: `storyboard_server_batch_v2_storage_${code}`,
    status, submissionState: 'not_submitted',
  });
  storageErrors.add(error);
  return error;
};
const safeError = cause => storageErrors.has(cause) || isStoryboardServerBatchBusinessError(cause)
  ? cause : storageError('unavailable', '分镜批次记录暂不可用，未授权新请求', 503);
const accountChanged = () => createStoryboardServerBatchBusinessError(
  'account_changed', 'ST 账户已变化，请以原账户核对批次', 401);

function strictCursor(cursor) {
  if (cursor === null) return null;
  try {
    if (!cursor || typeof cursor !== 'object' || Array.isArray(cursor)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(cursor))) throw Error();
    const fields = ['batchId', 'createdAt', 'digest'];
    const names = Reflect.ownKeys(cursor);
    if (names.length !== fields.length || names.some(name => !fields.includes(name))
      || fields.some(name => !Object.hasOwn(Object.getOwnPropertyDescriptor(cursor, name) || {}, 'value'))
      || !Number.isSafeInteger(cursor.createdAt) || cursor.createdAt < 0
      || typeof cursor.digest !== 'string' || !/^[a-f0-9]{64}$/.test(cursor.digest)
      || typeof cursor.batchId !== 'string' || !new RegExp(`^${BATCH_ID}$`).test(cursor.batchId)) throw Error();
    return Object.freeze({ batchId: cursor.batchId, createdAt: cursor.createdAt,
      digest: cursor.digest });
  } catch (_) {
    throw storageError('cursor', '批次目录游标无效');
  }
}

const filename = record => `${String(record.createdAt).padStart(16, '0')}-${record.batchId}.json`;
const sortRows = (a, b) => b.createdAt - a.createdAt
  || (a.batchId < b.batchId ? -1 : a.batchId > b.batchId ? 1 : 0);
const cursorFor = record => ({ batchId: record.batchId, createdAt: record.createdAt,
  digest: record.digest });

export function createStoryboardServerBatchV2Store({ dataRoot, fileSystem = fs, now = Date.now,
  lockWaitMs = 250 } = {}) {
  if (typeof dataRoot !== 'string' || !path.isAbsolute(dataRoot) || dataRoot.includes('\0')
    || path.resolve(dataRoot) === path.parse(path.resolve(dataRoot)).root || typeof now !== 'function'
    || !Number.isSafeInteger(lockWaitMs) || lockWaitMs < 0 || lockWaitMs > 2000) {
    throw storageError('root', '增强服务缺少可信的 ST 数据目录');
  }
  const io = fileSystem;
  let closed = false, poisoned = false, pending = 0, tail = Promise.resolve();
  const active = new Set();
  const assertOpen = () => {
    if (closed || poisoned) throw storageError('closed', '分镜批次记录已暂停，请先核查服务状态', 503);
  };
  const current = (request, account) => {
    if (!imageServiceAccountStillMatches(request, account)) throw accountChanged();
  };
  const time = () => {
    let value;
    try { value = now(); } catch (_) { throw storageError('clock', '服务端时间无效，未更改批次记录'); }
    if (!Number.isSafeInteger(value) || value < 0) throw storageError('clock', '服务端时间无效，未更改批次记录');
    return value;
  };
  const enqueue = (operation, serial = true) => {
    try {
      assertOpen();
      if (pending >= MAX_PENDING) throw storageError('busy', '分镜批次记录等待已满，请稍后重试', 503);
      pending++;
      const work = (serial ? tail : Promise.resolve()).then(async () => { assertOpen(); return operation(); });
      const guarded = work.catch(cause => { throw safeError(cause); });
      const settled = guarded.then(value => { pending--; return value; }, cause => { pending--; throw cause; });
      active.add(settled);
      void settled.finally(() => { active.delete(settled); }).catch(() => {});
      if (serial) tail = settled.then(() => {}, () => {});
      return settled;
    } catch (cause) { return Promise.reject(safeError(cause)); }
  };
  async function checkedDirectory(target, create = false) {
    if (create) {
      try { await io.mkdir(target, { mode: 0o700 }); }
      catch (cause) { if (cause?.code !== 'EEXIST') throw cause; }
    }
    let before;
    try { before = await io.lstat(target); }
    catch (cause) { if (!create && isMissing(cause)) return false; throw cause; }
    if (!before.isDirectory() || before.isSymbolicLink() || path.resolve(await io.realpath(target)) !== path.resolve(target)) {
      throw storageError('path', '分镜批次目录不符合安全要求');
    }
    return true;
  }
  async function rootPath() {
    // The host may intentionally mount its trusted dataRoot through a junction.
    // Resolve only that host-supplied root, then forbid links in our own child
    // path and reject a resolved volume root.
    const resolved = await io.realpath(dataRoot);
    if (path.resolve(resolved) === path.parse(path.resolve(resolved)).root
      || !await checkedDirectory(resolved)) throw storageError('root', 'ST 数据目录无效');
    return path.resolve(resolved);
  }
  async function legacyAbsent(root) {
    const service = path.join(root, '.qianmu-service');
    if (!await checkedDirectory(service)) return;
    try { await io.lstat(path.join(service, 'storyboard-batches-v1')); }
    catch (cause) { if (isMissing(cause)) return; throw cause; }
    // Even an empty directory, regular file or symlink is not an absent v1
    // namespace. Never migrate, delete, or silently fall back to that writer.
    throw createStoryboardServerBatchBusinessError('conflict', '旧批次目录仍存在，未新建或更改 v2 批次');
  }
  async function accountPath(root, namespace, create) {
    const segments = storyboardBatchV2Location(namespace, ACCOUNT_PROBE_ID).segments.slice(0, 3);
    let parent = root;
    for (const segment of segments) {
      const next = path.join(parent, segment);
      if (!await checkedDirectory(next, create)) return null;
      parent = next;
    }
    return parent;
  }
  async function shardPath(accountDirectory, namespace, batchId, create = false) {
    const shard = storyboardBatchV2Location(namespace, batchId).segments[3];
    const target = path.join(accountDirectory, shard);
    return await checkedDirectory(target, create) ? target : null;
  }
  async function syncDirectory(directory) {
    // Node cannot fsync a Windows directory. File data is synced before the
    // same-directory rename; power-loss durability still depends on the volume.
    if (process.platform === 'win32') return;
    const handle = await io.open(directory, constants.O_RDONLY);
    try { await handle.sync(); } finally { await handle.close(); }
  }
  async function shardRows(directory, namespace, shard) {
    const entries = await io.readdir(directory, { withFileTypes: true });
    if (entries.some(entry => /^\.write-[a-f0-9-]{36}\.tmp$/.test(entry.name))) {
      // A write may have completed between directory enumeration and our lock
      // check. The reader retries once; a surviving orphan then fails closed.
      throw storageError('temporary', '分镜批次目录存在未决写入，请先核查');
    }
    if (entries.length > MAX_SHARD_RECORDS) throw storageError('full', '分镜批次分片已达到安全容量');
    const rows = [];
    for (const entry of entries) {
      const match = RECORD_NAME.exec(entry.name);
      if (!match || !entry.isFile() || storyboardBatchV2Location(namespace, match[2]).segments[3] !== shard) {
        throw storageError('path', '分镜批次目录包含异常文件，请先核查');
      }
      const createdAt = Number(match[1]);
      if (!Number.isSafeInteger(createdAt) || String(createdAt).padStart(16, '0') !== match[1]) {
        throw storageError('path', '分镜批次文件名无效，请先核查');
      }
      rows.push({ batchId: match[2], createdAt, directory, name: entry.name });
    }
    return rows;
  }
  async function findRow(accountDirectory, namespace, batchId) {
    const directory = await shardPath(accountDirectory, namespace, batchId);
    if (!directory) return null;
    const shard = path.basename(directory);
    const matches = (await shardRows(directory, namespace, shard)).filter(row => row.batchId === batchId);
    if (matches.length > 1) throw storageError('duplicate', '分镜批次编号出现重复记录，请先核查');
    return matches[0] || null;
  }
  async function readRecord(row, namespace) {
    const target = path.join(row.directory, row.name);
    let before;
    try { before = await io.lstat(target); }
    catch (cause) { if (isMissing(cause)) throw storageError('changed', '读取时分镜批次记录已变化'); throw cause; }
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1
      || before.size < 1 || before.size > MAX_RECORD_BYTES) {
      throw storageError('record', '分镜批次记录类型或大小异常，请先核查');
    }
    const handle = await io.open(target, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    try {
      const opened = await handle.stat();
      if (!sameFile(before, opened) || !opened.isFile() || opened.nlink !== 1 || opened.size !== before.size) {
        throw storageError('changed', '读取时分镜批次记录已变化');
      }
      const bytes = Buffer.alloc(opened.size + 1);
      let length = 0;
      while (length < bytes.length) {
        const chunk = await handle.read(bytes, length, bytes.length - length, length);
        if (!chunk.bytesRead) break;
        length += chunk.bytesRead;
      }
      const after = await handle.stat();
      if (length !== opened.size || !sameFile(opened, after) || after.size !== opened.size) {
        throw storageError('changed', '读取时分镜批次记录已变化');
      }
      let named;
      try { named = await io.lstat(target); }
      catch (cause) { if (isMissing(cause)) throw storageError('changed', '读取时分镜批次记录已变化'); throw cause; }
      if (!named.isFile() || named.isSymbolicLink() || named.nlink !== 1 || !sameFile(after, named)) {
        throw storageError('changed', '读取时分镜批次记录已变化');
      }
      let envelope;
      try { envelope = JSON.parse(bytes.toString('utf8', 0, length)); }
      catch (_) { throw storageError('corrupt', '分镜批次记录内容损坏，请先核查'); }
      const key = storyboardServerBatchKey(namespace, row.batchId);
      if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)
        || Object.keys(envelope).sort().join(',') !== 'checksum,key,record,schema'
        || envelope.schema !== SCHEMA || envelope.key !== key
        || !envelope.record || envelope.checksum !== hash(JSON.stringify(envelope.record))) {
        throw storageError('corrupt', '分镜批次记录校验失败，请先核查');
      }
      const record = normalizeBatchRecord(envelope.record, key);
      if (record.expectedAccount !== namespace || record.batchId !== row.batchId
        || record.createdAt !== row.createdAt || filename(record) !== row.name) {
        throw storageError('identity', '分镜批次记录与文件名不符，请先核查');
      }
      return record;
    } finally { await handle.close(); }
  }
  async function atomicWrite(row, namespace, record, expectedPresent) {
    await checkedDirectory(row.directory);
    const key = storyboardServerBatchKey(namespace, row.batchId);
    const normalized = normalizeBatchRecord(record, key);
    const body = JSON.stringify({ schema: SCHEMA, key,
      checksum: hash(JSON.stringify(normalized)), record: normalized });
    if (Buffer.byteLength(body) > MAX_RECORD_BYTES) throw storageError('full', '分镜批次记录超过安全容量');
    const temporary = path.join(row.directory, `.write-${randomUUID()}.tmp`);
    const target = path.join(row.directory, row.name);
    let handle, created = false, renameAttempted = false;
    try {
      handle = await io.open(temporary, 'wx', 0o600); created = true;
      await handle.writeFile(body); await handle.sync(); await handle.close(); handle = undefined;
      let found = false;
      try { await io.lstat(target); found = true; }
      catch (cause) { if (!isMissing(cause)) throw cause; }
      if (found !== expectedPresent) throw storageError('changed', '写入前分镜批次记录已变化');
      renameAttempted = true;
      await io.rename(temporary, target);
      await syncDirectory(row.directory);
      const readback = await readRecord(row, namespace);
      if (JSON.stringify(readback) !== JSON.stringify(normalized)) {
        throw storageError('changed', '分镜批次写后校验失败，请先核查');
      }
      return readback;
    } catch (cause) {
      // rename may have committed before an exception. Never guess its result
      // or re-submit through a process whose outcome is uncertain.
      if (renameAttempted) poisoned = true;
      throw cause;
    } finally {
      if (handle) await handle.close().catch(() => { poisoned = true; });
      if (created && !renameAttempted) await io.unlink(temporary).catch(() => { poisoned = true; });
    }
  }
  async function exclusive(accountDirectory, operation) {
    const lock = path.join(accountDirectory, '.transaction.lock');
    let handle, owner;
    const deadline = Date.now() + lockWaitMs;
    while (!handle) {
      try { handle = await io.open(lock, 'wx', 0o600); }
      catch (cause) {
        if (cause?.code !== 'EEXIST') throw cause;
        if (Date.now() >= deadline) throw storageError('busy', '分镜批次记录正在写入或等待恢复', 503);
        await new Promise(resolve => setTimeout(resolve, 25));
        await checkedDirectory(accountDirectory);
      }
    }
    try {
      owner = await handle.stat();
      await handle.writeFile(JSON.stringify({ schema: 'qianmu.storyboard-batch-lock.v2',
        owner: randomUUID(), pid: process.pid }));
      await handle.sync();
      await checkedDirectory(accountDirectory);
      return await operation();
    } finally {
      await handle.close().catch(() => { poisoned = true; });
      try {
        await checkedDirectory(accountDirectory);
        const currentLock = await io.lstat(lock);
        if (!owner || !currentLock.isFile() || currentLock.isSymbolicLink()
          || currentLock.nlink !== 1 || !sameFile(owner, currentLock)) {
          throw storageError('changed', '分镜批次写入锁已变化，请先核查');
        }
        await io.unlink(lock);
        await syncDirectory(accountDirectory);
      } catch (cause) { poisoned = true; throw cause; }
    }
  }
  async function lockPresent(accountDirectory) {
    try { await io.lstat(path.join(accountDirectory, '.transaction.lock')); return true; }
    catch (cause) { if (isMissing(cause)) return false; throw cause; }
  }
  async function readConsistently(accountDirectory, operation) {
    const deadline = Date.now() + lockWaitMs;
    let retriedChange = false;
    for (;;) {
      if (!await checkedDirectory(accountDirectory)) {
        throw storageError('changed', '读取时分镜批次目录已变化');
      }
      if (await lockPresent(accountDirectory)) {
        if (Date.now() >= deadline) throw storageError('busy', '分镜批次记录正在写入或等待恢复', 503);
        await new Promise(resolve => setTimeout(resolve, 25));
        continue;
      }
      let result, failure;
      try { result = await operation(); } catch (cause) { failure = cause; }
      if (!await checkedDirectory(accountDirectory)) {
        throw storageError('changed', '读取时分镜批次目录已变化');
      }
      const writing = await lockPresent(accountDirectory);
      const changed = storageErrors.has(failure)
        && ['storyboard_server_batch_v2_storage_changed', 'storyboard_server_batch_v2_storage_busy',
          'storyboard_server_batch_v2_storage_temporary'].includes(failure.code);
      if (writing || changed && !retriedChange) {
        retriedChange ||= changed;
        if (Date.now() >= deadline) throw storageError('busy', '分镜批次记录正在写入或等待恢复', 503);
        await new Promise(resolve => setTimeout(resolve, 25));
        continue;
      }
      if (failure?.code === 'storyboard_server_batch_v2_storage_temporary') {
        throw storageError('path', '分镜批次目录包含遗留临时文件，请先核查');
      }
      if (failure) throw failure;
      return result;
    }
  }
  async function allRows(accountDirectory, namespace) {
    const entries = await io.readdir(accountDirectory, { withFileTypes: true });
    const rows = [];
    for (const entry of entries) {
      if (entry.name === '.transaction.lock' && entry.isFile()) {
        throw storageError('busy', '分镜批次记录正在写入或等待恢复', 503);
      }
      if (!SHARD_NAME.test(entry.name) || !entry.isDirectory()) {
        throw storageError('path', '分镜批次账户目录包含异常文件，请先核查');
      }
      const directory = path.join(accountDirectory, entry.name);
      await checkedDirectory(directory);
      rows.push(...await shardRows(directory, namespace, entry.name));
    }
    const seen = new Set();
    for (const row of rows) {
      if (seen.has(row.batchId)) throw storageError('duplicate', '分镜批次编号出现重复记录，请先核查');
      seen.add(row.batchId);
    }
    return rows.sort(sortRows);
  }

  async function prepare(request, input) {
    const account = imageServiceAccount(request);
    const prepared = normalizePreparedBatch(input, account.namespace, time());
    return enqueue(async () => {
      const root = await rootPath();
      await legacyAbsent(root);
      const directory = await accountPath(root, account.namespace, true);
      const result = await exclusive(directory, async () => {
        await legacyAbsent(root);
        current(request, account);
        const existingRow = await findRow(directory, account.namespace, prepared.batchId);
        const existing = existingRow ? await readRecord(existingRow, account.namespace) : null;
        const decision = decideStoryboardBatchV2Prepare(prepared, {
          legacyDirectoryStatus: 'absent', v2Record: existing,
        });
        if (decision.kind === 'existing_v2') return decision.view;
        const shard = await shardPath(directory, account.namespace, prepared.batchId, true);
        if ((await shardRows(shard, account.namespace, path.basename(shard))).length >= MAX_SHARD_RECORDS) {
          throw storageError('full', '分镜批次分片已达到安全容量');
        }
        const row = { batchId: prepared.batchId, createdAt: prepared.createdAt,
          directory: shard, name: filename(prepared) };
        current(request, account);
        return batchPublicView(await atomicWrite(row, account.namespace, decision.record, false));
      });
      current(request, account);
      return result;
    });
  }
  async function query(request, batchId) {
    const account = imageServiceAccount(request);
    storyboardBatchV2Location(account.namespace, batchId);
    return enqueue(async () => {
      const root = await rootPath();
      await legacyAbsent(root);
      const directory = await accountPath(root, account.namespace, false);
      if (!directory) { current(request, account); return null; }
      const record = await readConsistently(directory, async () => {
        await legacyAbsent(root);
        current(request, account);
        const row = await findRow(directory, account.namespace, batchId);
        return row ? readRecord(row, account.namespace) : null;
      });
      current(request, account);
      return record ? batchPublicView(record) : null;
    }, false);
  }
  async function listOwned(request, options = {}) {
    const account = imageServiceAccount(request);
    let cursor, limit;
    try {
      if (!options || typeof options !== 'object' || Array.isArray(options)
        || ![Object.prototype, null].includes(Object.getPrototypeOf(options))) throw Error();
      const names = Reflect.ownKeys(options);
      if (names.some(name => !['cursor', 'limit'].includes(name))) throw Error();
      const cursorField = Object.getOwnPropertyDescriptor(options, 'cursor');
      const limitField = Object.getOwnPropertyDescriptor(options, 'limit');
      if (cursorField && !Object.hasOwn(cursorField, 'value')
        || limitField && !Object.hasOwn(limitField, 'value')) throw Error();
      cursor = cursorField ? cursorField.value : null;
      limit = limitField ? limitField.value : 40;
    } catch (_) { throw storageError('cursor', '批次目录分页信息无效'); }
    const anchor = strictCursor(cursor);
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
      throw storageError('cursor', '批次目录分页数量无效');
    }
    return enqueue(async () => {
      const root = await rootPath();
      await legacyAbsent(root);
      const directory = await accountPath(root, account.namespace, false);
      if (!directory) {
        if (anchor) throw storageError('cursor', '批次目录游标已变化，请重新打开目录');
        current(request, account);
        return { entries: [], total: 0, nextCursor: null, full: false };
      }
      const page = await readConsistently(directory, async () => {
        await legacyAbsent(root);
        current(request, account);
        if (anchor) {
          const anchorRow = await findRow(directory, account.namespace, anchor.batchId);
          if (!anchorRow) throw storageError('cursor', '批次目录游标已变化，请重新打开目录');
          const actual = await readRecord(anchorRow, account.namespace);
          if (JSON.stringify(cursorFor(actual)) !== JSON.stringify(anchor)) {
            throw storageError('cursor', '批次目录游标已变化，请重新打开目录');
          }
        }
        const rows = await allRows(directory, account.namespace);
        const start = anchor ? rows.findIndex(row => row.batchId === anchor.batchId) + 1 : 0;
        if (anchor && start === 0) throw storageError('cursor', '批次目录游标已变化，请重新打开目录');
        const slice = rows.slice(start, start + limit);
        const entries = [];
        for (const row of slice) entries.push(batchPublicView(await readRecord(row, account.namespace)));
        // Live ordered view, not a cross-page snapshot: later inserts ahead
        // of the anchor do not retroactively appear on page two.
        return { entries, total: rows.length,
          nextCursor: start + entries.length < rows.length ? cursorFor(entries.at(-1)) : null,
          full: false };
      });
      current(request, account);
      return page;
    }, false);
  }
  async function stop(request, batchId, expectedRevision) {
    const account = imageServiceAccount(request);
    storyboardBatchV2Location(account.namespace, batchId);
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
      throw createStoryboardServerBatchBusinessError('revision', '请先核对原批次版本后再停止', 400);
    }
    return enqueue(async () => {
      const root = await rootPath();
      await legacyAbsent(root);
      const directory = await accountPath(root, account.namespace, false);
      if (!directory) {
        current(request, account);
        throw createStoryboardServerBatchBusinessError('not_found', '原批次不存在，请核对后重试', 404);
      }
      const result = await exclusive(directory, async () => {
        await legacyAbsent(root);
        current(request, account);
        const row = await findRow(directory, account.namespace, batchId);
        if (!row) throw createStoryboardServerBatchBusinessError('not_found', '原批次不存在，请核对后重试', 404);
        const existing = await readRecord(row, account.namespace);
        if (existing.state === 'stopped_unrunnable') return batchPublicView(existing);
        if (existing.stateRevision !== expectedRevision) {
          throw createStoryboardServerBatchBusinessError('revision', '原批次已变化，请重新核对后再停止');
        }
        const stoppedAt = Math.max(time(), existing.updatedAt);
        const stopped = normalizeBatchRecord({ ...existing, state: 'stopped_unrunnable', stateRevision: 2,
          updatedAt: stoppedAt, stoppedAt }, storyboardServerBatchKey(account.namespace, batchId));
        current(request, account);
        return batchPublicView(await atomicWrite(row, account.namespace, stopped, true));
      });
      current(request, account);
      return result;
    });
  }
  return Object.freeze({ prepare, query, listOwned, stop,
    close() { closed = true; return Promise.allSettled([...active]); },
    inspect() { return { closed, paused: poisoned, pending }; } });
}
