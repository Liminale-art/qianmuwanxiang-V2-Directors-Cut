import * as fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { imageServiceAccount, imageServiceAccountStillMatches } from './qianmu-image-service-access.js';
import { SOURCE_IDENTITY_SCHEMA, sourceIdentityError, sourceIdentityRecord, sourceIdentityRequest, sourceIdentityResponse } from './qianmu-source-identity-contract.js';

const marker = '.qianmu-source-identity.json';
const fail = (code, message, status) => { throw sourceIdentityError(code, message, status); };
const sameFile = (a, b) => typeof a?.ino === 'bigint' && a.ino > 0n && typeof a.dev === 'bigint' && a.dev >= 0n && a.ino === b?.ino && a.dev === b.dev;
const child = (root, target) => { const relative = path.relative(root, target); return relative !== '' && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative); };

// No initialization at module load, service startup or inspection. Only fixed marker filenames under host-authorized roots.
export function createSourceIdentityService({ dataRoot, io = fs } = {}) {
  if (typeof dataRoot !== 'string' || !dataRoot || dataRoot.includes('\0')) fail('setup', '增强服务缺少可信的 ST 数据目录', 503);
  const configuredRoot = path.resolve(dataRoot);
  if (configuredRoot === path.parse(configuredRoot).root) fail('setup', '增强服务数据目录无效', 503);
  let closed = false, writing = false;
  const pending = new Set(), lstat = filename => io.lstat(filename, { bigint: true });
  function capture(request, signal) {
    let account; try { account = imageServiceAccount(request); } catch (_) { fail('account', '请先登录 ST 账户核对来源标识', 401); }
    const originalRoot = request?.user?.directories?.root;
    if (typeof originalRoot !== 'string' || !originalRoot || originalRoot.includes('\0')) fail('setup', 'ST 尚未提供当前账户目录', 503);
    const root = path.resolve(originalRoot);
    if (!child(configuredRoot, root)) fail('path', '来源标识目录不属于当前 ST 账户');
    const context = { account, root, directories: new Map(), writeStarted: false, guard() {
      if (closed || signal?.aborted || !imageServiceAccountStillMatches(request, account) || request.user?.directories?.root !== originalRoot) fail('changed', '来源标识账户或会话已变化，请重新核对');
    } };
    context.guard(); return context;
  }
  async function checkedRoots(context) {
    context.guard(); let cursor = configuredRoot;
    const directories = [cursor];
    for (const part of path.relative(configuredRoot, context.root).split(path.sep)) { cursor = path.join(cursor, part); directories.push(cursor); }
    for (const directory of directories) {
      const stat = await lstat(directory), prior = context.directories.get(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink() || path.resolve(await io.realpath(directory)) !== directory || prior && !sameFile(stat, prior)) fail('path', '来源标识目录为链接或已变化，未继续操作');
      context.directories.set(directory, stat); context.guard();
    }
  }
  async function read(context, folder, kind) {
    await checkedRoots(context); const target = path.join(folder, marker);
    let before; try { before = await lstat(target); } catch (error) { if (error?.code === 'ENOENT') return null; throw error; }
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n) fail('path', '来源标识为链接或非常规文件，未读取或覆盖');
    if (before.size < 1n || before.size > 1024n) fail('content', '来源标识文件损坏或过大，请保留原文件核对');
    const handle = await io.open(target, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    try {
      const opened = await handle.stat({ bigint: true });
      if (!sameFile(before, opened) || before.size !== opened.size || before.mtimeNs !== opened.mtimeNs || opened.nlink !== 1n) fail('changed', '来源标识读取时文件已变化');
      const buffer = Buffer.alloc(1025); let length = 0;
      while (length < buffer.length) { context.guard(); const part = await handle.read(buffer, length, buffer.length - length, length); if (!part.bytesRead) break; length += part.bytesRead; }
      const after = await handle.stat({ bigint: true }), current = await lstat(target);
      if (BigInt(length) !== opened.size || !sameFile(after, opened) || after.size !== opened.size || after.mtimeNs !== opened.mtimeNs || after.nlink !== 1n
        || !current.isFile() || current.isSymbolicLink() || !sameFile(current, after) || current.size !== after.size || current.mtimeNs !== after.mtimeNs || current.nlink !== 1n) fail('changed', '来源标识在核对期间已变化');
      let value; try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length))); } catch (_) { fail('content', '来源标识内容损坏，请保留原文件核对'); }
      await checkedRoots(context); return sourceIdentityRecord(value, kind);
    } finally { await handle.close(); }
  }
  async function createMissing(context, folder, kind) {
    // Exclusive creation cannot overwrite an existing label. A failed/partial file is preserved, never rotated or retried automatically.
    await checkedRoots(context); context.guard(); let handle;
    try { handle = await io.open(path.join(folder, marker), 'wx', 0o600); context.writeStarted = true; }
    catch (error) { if (error?.code === 'EEXIST') return read(context, folder, kind); throw error; }
    const value = sourceIdentityRecord({ schema: SOURCE_IDENTITY_SCHEMA, kind, id: randomUUID() }, kind);
    try { await handle.writeFile(JSON.stringify(value) + '\n'); await handle.sync(); } finally { await handle.close(); }
    if (process.platform !== 'win32') { const directory = await io.open(folder, 'r'); try { await directory.sync(); } finally { await directory.close(); } }
    const saved = await read(context, folder, kind);
    if (!saved || saved.id !== value.id) fail('changed', '新来源标识写入尚未确认，请保留原文件核对');
    return saved;
  }
  async function execute(request, input, signal, write) {
    const body = write ? sourceIdentityRequest(input) : null, context = capture(request, signal);
    if (body && body.expectedAccount !== context.account.namespace) fail('account', '来源标识账户不一致，未初始化', 401);
    if (writing) fail('busy', '来源标识正在初始化，请稍后重新核对');
    if (write) writing = true;
    try {
      // Inspect both first. A damaged account marker must not cause an otherwise missing instance marker to be created.
      let instance = await read(context, configuredRoot, 'instance'), account = await read(context, context.root, 'account');
      if (write) {
        instance ||= await createMissing(context, configuredRoot, 'instance');
        account ||= await createMissing(context, context.root, 'account');
      }
      // Re-read both before acknowledging; labels are not cached across operations or accounts.
      const finalInstance = await read(context, configuredRoot, 'instance'), finalAccount = await read(context, context.root, 'account');
      if (instance?.id !== finalInstance?.id || account?.id !== finalAccount?.id) fail('changed', '来源标识在核对期间已变化');
      context.guard();
      return sourceIdentityResponse({ ok: true, version: 1, expectedAccount: context.account.namespace, state: instance && account ? 'ready' : 'uninitialized',
        instanceId: instance?.id || null, accountId: account?.id || null, proof: 'installation-labels', automaticRebinding: false });
    } catch (error) {
      if (context.writeStarted) error.identityWriteState = 'unconfirmed';
      throw error;
    } finally { if (write) writing = false; }
  }
  function track(request, input, options, write) {
    if (pending.size >= 8) return Promise.reject(sourceIdentityError('busy', '来源标识核对请求过多，请稍后重试', 429));
    const operation = execute(request, input, options?.signal, write); pending.add(operation);
    void operation.finally(() => pending.delete(operation)).catch(() => {}); return operation;
  }
  return Object.freeze({ inspect: (request, options) => track(request, null, options, false), initialize: (request, input, options) => track(request, input, options, true),
    async close() { closed = true; await Promise.allSettled([...pending]); } });
}
