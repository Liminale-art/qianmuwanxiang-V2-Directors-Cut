// Add-only, account-local image restoration. No upstream network, task submission, overwrite, rename-over or public disk paths.
import * as fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { imageServiceAccount, imageServiceAccountStillMatches } from './qianmu-image-service-access.js';
import { comfyReferenceStillMime } from './qianmu-comfy-results.js';
import { imageRestoreError, imageRestoreRequest, IMAGE_RESTORE_MAX_BYTES } from './qianmu-image-restore-contract.js';

const digest = value => createHash('sha256').update(value).digest('hex');
const fail = (code, message, status) => { throw imageRestoreError(code, message, status); };
const missing = cause => cause?.code === 'ENOENT';
// Windows file IDs can exceed Number.MAX_SAFE_INTEGER. Keep complete identities, sizes and timestamps as BigInt.
const sameFile = (a, b) => typeof a.ino === 'bigint' && a.ino > 0n && typeof a.dev === 'bigint' && a.dev >= 0n && a.ino === b.ino && a.dev === b.dev;
const child = (root, candidate) => { const relative = path.relative(root, candidate); return relative !== '' && !relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative); };
const stageFolder = '.qianmu-restore-v1';

export function createImageRestoreService({ dataRoot, io = fs } = {}) {
  if (typeof dataRoot !== 'string' || !dataRoot || dataRoot.includes('\0')) fail('setup', '增强服务缺少可信的 ST 数据目录', 503);
  const configuredRoot = path.resolve(dataRoot);
  if (configuredRoot === path.parse(configuredRoot).root) fail('setup', '增强服务数据目录无效', 503);
  const pending = new Set(), accounts = new Set(); let closed = false;
  const lstat = filename => io.lstat(filename, { bigint: true });
  async function checkedDirectory(target) {
    const stat = await lstat(target);
    if (!stat.isDirectory() || stat.isSymbolicLink() || path.resolve(await io.realpath(target)) !== target) fail('path', '原图恢复目录为链接或已变化');
    return stat;
  }
  function capture(request, signal) {
    let account; try { account = imageServiceAccount(request); } catch (_) { fail('account', '请先登录 ST 账户恢复原图', 401); }
    const directories = request?.user?.directories;
    if (!directories || typeof directories.root !== 'string' || typeof directories.userImages !== 'string' || !directories.root || !directories.userImages
      || directories.root.includes('\0') || directories.userImages.includes('\0')) fail('setup', 'ST 尚未提供当前账户的图片目录', 503);
    const originalRoot = directories.root, originalImages = directories.userImages, root = path.resolve(originalRoot), images = path.resolve(originalImages);
    if (!child(configuredRoot, root) || !child(root, images)) fail('path', '原图目录不属于当前 ST 账户');
    const guard = () => {
      if (closed || signal?.aborted || !imageServiceAccountStillMatches(request, account) || request.user?.directories?.root !== originalRoot || request.user?.directories?.userImages !== originalImages) fail('changed', '原图恢复账户或会话已变化，请核对后续接');
    };
    return { account, root, images, guard };
  }
  async function checkedRoots(context) {
    context.guard(); await checkedDirectory(configuredRoot);
    // Validate every ancestor, not only the final image directory.
    let cursor = configuredRoot;
    for (const part of path.relative(configuredRoot, context.images).split(path.sep)) { cursor = path.join(cursor, part); await checkedDirectory(cursor); }
    context.guard();
  }
  async function locate(context, receipt, create = false) {
    await checkedRoots(context);
    const parts = receipt.url.slice('/user/images/'.length).split('/').map(part => decodeURIComponent(part)), filename = parts.pop();
    let folder = context.images;
    for (const part of parts) {
      folder = path.join(folder, part); context.guard();
      if (create) { try { await io.mkdir(folder, { mode: 0o700 }); } catch (cause) { if (cause?.code !== 'EEXIST') throw cause; } }
      try { await checkedDirectory(folder); } catch (cause) { if (!create && missing(cause)) return null; throw cause; }
    }
    context.guard(); return { folder, target: path.join(folder, filename) };
  }
  async function readFile(target, receipt, allowLinked = false) {
    let before; try { before = await lstat(target); } catch (cause) { if (missing(cause)) return null; throw cause; }
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n && !(allowLinked && before.nlink === 2n)) fail('path', '已有原图是链接或非常规文件，未读取或覆盖');
    if (before.size !== BigInt(receipt.bytes)) return { matches: false, stat: before };
    const handle = await io.open(target, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    try {
      const opened = await handle.stat({ bigint: true });
      if (!sameFile(before, opened) || opened.size !== before.size || opened.nlink !== before.nlink) fail('changed', '原图读取时文件已变化');
      const bytes = Buffer.alloc(receipt.bytes + 1); let length = 0;
      while (length < bytes.length) { const part = await handle.read(bytes, length, bytes.length - length, length); if (!part.bytesRead) break; length += part.bytesRead; }
      const after = await handle.stat({ bigint: true });
      if (length !== receipt.bytes || !sameFile(after, opened) || after.size !== opened.size || after.mtimeNs !== opened.mtimeNs || after.nlink !== opened.nlink) fail('changed', '原图内容在核对期间已变化');
      const buffer = bytes.subarray(0, length); let mime; try { mime = comfyReferenceStillMime(buffer); } catch (_) { return { matches: false, stat: after }; }
      return { matches: mime === receipt.mime && digest(buffer) === receipt.sha256, stat: after };
    } finally { await handle.close(); }
  }
  const stagePrefix = receipt => `${digest(receipt.url)}-${receipt.sha256}-`;
  async function linkedStage(context, receipt, stat) {
    const folder = path.join(context.images, stageFolder); try { await checkedDirectory(folder); } catch (cause) { if (missing(cause)) return null; throw cause; }
    const directory = await io.opendir(folder); let examined = 0, found = null;
    for await (const entry of directory) {
      if (++examined > 256) fail('staging', '原图恢复暂存过多，请先保全核对');
      if (!entry.name.startsWith(stagePrefix(receipt)) || !/^[a-f0-9]{64}-[a-f0-9]{64}-[a-f0-9-]{36}\.ready$/.test(entry.name)) continue;
      const filename = path.join(folder, entry.name), row = await lstat(filename);
      if (sameFile(row, stat) && row.isFile() && !row.isSymbolicLink() && row.nlink === 2n) { if (found) fail('staging', '原图恢复暂存归属不唯一'); found = { filename, stat: row }; }
    }
    context.guard(); return found;
  }
  async function existing(context, receipt, location, cleanup = false) {
    if (!location) return null;
    let stat; try { stat = await lstat(location.target); } catch (cause) { if (missing(cause)) return null; throw cause; }
    let ownStage = null;
    if (stat.nlink === 2n && stat.isFile() && !stat.isSymbolicLink()) ownStage = await linkedStage(context, receipt, stat);
    const result = await readFile(location.target, receipt, Boolean(ownStage)); context.guard();
    if (cleanup && result?.matches && ownStage) {
      await checkedRoots(context); await checkedDirectory(path.dirname(ownStage.filename)); context.guard();
      const latest = await lstat(ownStage.filename);
      if (!latest.isFile() || latest.isSymbolicLink() || !sameFile(latest, ownStage.stat)) fail('changed', '原图暂存已变化，未清理');
      await io.unlink(ownStage.filename); // Only our proven second link; the complete published original remains intact.
      await sync(path.dirname(ownStage.filename));
    }
    return result;
  }
  async function sync(folder) {
    if (process.platform === 'win32') return;
    const handle = await io.open(folder, 'r'); try { await handle.sync(); } finally { await handle.close(); }
  }
  async function publish(context, receipt, bytes) {
    const location = await locate(context, receipt, true), folder = path.join(context.images, stageFolder);
    try { await io.mkdir(folder, { mode: 0o700 }); } catch (cause) { if (cause?.code !== 'EEXIST') throw cause; }
    await checkedDirectory(folder);
    const listing = await io.opendir(folder); let count = 0;
    for await (const _ of listing) if (++count >= 256) fail('staging', '原图恢复暂存过多，请先保全核对');
    const base = path.join(folder, `${stagePrefix(receipt)}${randomUUID()}`), partial = base + '.part', ready = base + '.ready';
    let handle, owned = null, prepared = false, linked = false;
    try {
      context.guard(); handle = await io.open(partial, 'wx', 0o600); owned = await handle.stat({ bigint: true });
      await handle.writeFile(bytes); await handle.sync(); await handle.close(); handle = null;
      await checkedRoots(context); await checkedDirectory(folder); context.guard();
      await io.rename(partial, ready); prepared = true; await sync(folder);
      const staged = await readFile(ready, receipt);
      if (!staged?.matches || !sameFile(staged.stat, owned)) fail('content', '原图暂存内容核对失败，未发布');
      const checked = await locate(context, receipt, false); if (!checked || checked.target !== location.target) fail('changed', '原图恢复位置已变化');
      context.guard();
      try { await io.link(ready, location.target); linked = true; }
      catch (cause) { if (cause?.code !== 'EEXIST') throw cause; }
      // Hard-link publication is atomic and cannot replace an existing destination. No rename-over or unsafe fallback.
      await sync(location.folder);
    } finally {
      if (handle) await handle.close().catch(() => {});
      if (owned) {
        const temporary = prepared ? ready : partial;
        await checkedDirectory(folder);
        let current; try { current = await lstat(temporary); } catch (cause) { if (!missing(cause)) throw cause; }
        if (current) {
          if (!current.isFile() || current.isSymbolicLink() || !sameFile(current, owned)) fail('changed', '原图暂存文件已变化，未删除');
          await io.unlink(temporary); await sync(folder);
        }
      }
    }
    const result = await existing(context, receipt, await locate(context, receipt), true);
    if (!result?.matches) fail('conflict', '原图位置已存在不同内容，未覆盖；请保留双方原件');
    return linked ? 'created' : 'reused';
  }
  async function task(request, raw, write, signal) {
    const context = capture(request, signal), input = imageRestoreRequest(raw, { write });
    if (context.account.namespace !== input.expectedAccount) fail('account', 'ST 登录账户与备份目标不一致', 401);
    if (closed || pending.size >= 2 || accounts.has(context.account.namespace)) fail('busy', '原图正在核对或恢复，请等待当前操作结束', 429);
    accounts.add(context.account.namespace);
    const work = (async () => {
      context.guard(); const receipt = input.receipt; let bytes;
      if (write) {
        bytes = Buffer.from(input.data, 'base64'); let mime;
        try { mime = comfyReferenceStillMime(bytes); } catch (_) { fail('format', '恢复文件不是完整静态 PNG、JPEG 或 WebP', 400); }
        if (bytes.length !== receipt.bytes || bytes.toString('base64') !== input.data || mime !== receipt.mime || digest(bytes) !== receipt.sha256) fail('content', '原图内容与恢复收据不符', 400);
      }
      const result = await existing(context, receipt, await locate(context, receipt), write);
      context.guard();
      if (!write) return { ok: true, version: 1, expectedAccount: context.account.namespace, receipt, state: result ? result.matches ? 'present' : 'conflict' : 'missing' };
      if (result && !result.matches) fail('conflict', '同名原图内容不同，未覆盖；请保留双方原件');
      const state = result ? 'reused' : await publish(context, receipt, bytes); context.guard();
      return { ok: true, version: 1, expectedAccount: context.account.namespace, receipt, state };
    })();
    pending.add(work);
    try { return await work; } finally { pending.delete(work); accounts.delete(context.account.namespace); }
  }
  return Object.freeze({
    // Preserve the legacy reference limit field for already-installed clients which compare it exactly.
    async capabilities(request) { const context = capture(request); await checkedRoots(context); return { ok: true, version: 1, expectedAccount: context.account.namespace, originalPaths: true, missingOnly: true, automaticReplay: false, maxImageBytes: 16 * 1024 * 1024, maxGalleryImageBytes: IMAGE_RESTORE_MAX_BYTES }; },
    inspect: (request, input, { signal } = {}) => task(request, input, false, signal),
    restore: (request, input, { signal } = {}) => task(request, input, true, signal),
    async close() { closed = true; await Promise.allSettled([...pending]); },
  });
}
