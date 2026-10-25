import * as fs from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import {createHash, randomUUID} from 'node:crypto';
import * as contract from './contract.mjs';

const STORE_DIRECTORY = '.yimu';
const MAX_DOCUMENT_BYTES = 64 * 1024 * 1024;
const MAX_SOURCE_LINE_BYTES = 32 * 1024 * 1024;
const digest = value => createHash('sha256').update(value).digest('hex');
// This is the exact canonical tuple used by contract.fingerprintMessages, hashed synchronously for a streamed server scan.
const messageHash = message => digest(JSON.stringify([String(message.name || ''), Boolean(message.is_user), Boolean(message.is_system),
    String(message.mes || ''), String(message.send_date ?? '')]));
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const clone = value => structuredClone(value);
const withReceipt = operation => {
    if (!operation || typeof operation !== 'object' || Array.isArray(operation)) fail('operation', '忆幕操作格式无效', 400);
    const {receipt: ignored, ...values} = operation;
    return {...values, receipt: digest(JSON.stringify(values))};
};
const sameFile = (a, b) => a?.ino > 0n && a.ino === b?.ino && a.dev === b?.dev;
const sameVersion = (a, b) => sameFile(a, b) && a.size === b.size && a.mtimeNs === b.mtimeNs;
const child = (parent, target) => {
    const relative = path.relative(parent, target);
    return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};
const error = (code, message, status = 409) => Object.assign(new Error(message), {code: `yimu_${code}`, status});
const fail = (code, message, status) => { throw error(code, message, status); };

function safeName(value) {
    return typeof value === 'string' && value.length > 0 && value.length <= 255
        && !/[\x00-\x1f\x7f<>:"/\\|?*]/.test(value) && !/[. ]$/.test(value)
        && value !== '.' && value !== '..' && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value);
}

export function normalizeStoreBinding(value) {
    const binding = contract.normalizeBinding(value);
    if (!safeName(binding.avatar) || !/\.png$/i.test(binding.avatar) || !safeName(binding.file)) {
        fail('binding', '聊天身份或文件名无效', 400);
    }
    return binding;
}

function trustedPath(value, hostCwd) {
    if (typeof value !== 'string' || !value || value.includes('\0') || /^[a-z]:[^\\/]/i.test(value)) {
        fail('account', '未取得有效的 ST 账户目录', 403);
    }
    const resolved = path.resolve(hostCwd, value);
    if (resolved === path.parse(resolved).root) fail('account', 'ST 账户目录范围无效', 403);
    return resolved;
}

export const chatStorageName = binding => `chat-${digest(JSON.stringify([binding.avatar, binding.file]))}.json`;

// The only truth is the authenticated ST account directory. No raw chat is copied.
export function createYimuStore({hostCwd = process.cwd(), io = fs, lockTimeoutMs = 1500} = {}) {
    if (!path.isAbsolute(hostCwd) || !Number.isSafeInteger(lockTimeoutMs) || lockTimeoutMs < 0 || lockTimeoutMs > 10000) {
        throw new TypeError('Invalid Yimu storage configuration');
    }
    hostCwd = path.resolve(hostCwd);
    const stat = target => io.lstat(target, {bigint: true});

    function context(request) {
        const user = request?.user;
        const rootValue = user?.directories?.root;
        const chatsValue = user?.directories?.chats;
        const handle = user?.profile?.handle;
        if (typeof handle !== 'string' || !handle) fail('account', '未取得当前 ST 账户', 403);
        const root = trustedPath(rootValue, hostCwd);
        const chats = trustedPath(chatsValue, hostCwd);
        if (!child(root, chats)) fail('account', 'ST 聊天目录不属于当前账户', 403);
        return {
            root, chats, folder: path.join(root, STORE_DIRECTORY), roots: new Map(),
            guard() {
                if (request.user !== user || user.profile?.handle !== handle || user.directories?.root !== rootValue || user.directories?.chats !== chatsValue) {
                    fail('account', 'ST 账户已改变，未继续保存', 403);
                }
            },
        };
    }

    async function checkDirectory(ctx, directory) {
        ctx.guard();
        const before = await stat(directory);
        const prior = ctx.roots.get(directory);
        if (!before.isDirectory() || before.isSymbolicLink() || path.resolve(await io.realpath(directory)) !== directory
            || (prior && !sameFile(before, prior))) fail('path', '忆幕目录为链接或已变化，未继续操作', 409);
        ctx.roots.set(directory, before);
        ctx.guard();
    }

    async function checkRoot(ctx) {
        // realpath also rejects a redirected ancestor, not just a final symlink.
        await checkDirectory(ctx, ctx.root);
    }

    async function prepare(ctx) {
        await checkRoot(ctx);
        try { await io.mkdir(ctx.folder, {mode: 0o700}); }
        catch (caught) { if (caught?.code !== 'EEXIST') throw caught; }
        await checkRoot(ctx);
        await checkDirectory(ctx, ctx.folder);
    }

    async function checkStore(ctx) {
        await checkRoot(ctx);
        await checkDirectory(ctx, ctx.folder);
    }

    async function readFile(ctx, name, validate, empty) {
        await checkStore(ctx);
        const target = path.join(ctx.folder, name);
        let before;
        try { before = await stat(target); }
        catch (caught) {
            if (caught?.code === 'ENOENT') return {value: empty(), fingerprint: null};
            throw caught;
        }
        if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size < 1n || before.size > BigInt(MAX_DOCUMENT_BYTES)) {
            fail('corrupt', '忆幕资料异常，未覆盖原文件', 503);
        }
        const file = await io.open(target, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
        try {
            const opened = await file.stat({bigint: true});
            if (!sameVersion(before, opened) || opened.nlink !== 1n) fail('changed', '忆幕资料读取期间已变化');
            const bytes = Buffer.alloc(Number(opened.size) + 1);
            let length = 0;
            while (length < bytes.length) {
                ctx.guard();
                const chunk = await file.read(bytes, length, bytes.length - length, length);
                if (!chunk.bytesRead) break;
                length += chunk.bytesRead;
            }
            const after = await file.stat({bigint: true});
            const current = await stat(target);
            if (BigInt(length) !== opened.size || !sameVersion(opened, after) || !sameVersion(after, current)
                || !current.isFile() || current.isSymbolicLink() || current.nlink !== 1n) fail('changed', '忆幕资料读取期间已变化');
            let envelope;
            try { envelope = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes.subarray(0, length))); }
            catch { fail('corrupt', '忆幕资料无法完整读取，未覆盖原文件', 503); }
            if (envelope?.schema !== 1 || typeof envelope.checksum !== 'string' || !Object.hasOwn(envelope, 'value')
                || Object.keys(envelope).length !== 3 || digest(JSON.stringify(envelope.value)) !== envelope.checksum) {
                fail('corrupt', '忆幕资料校验失败，未覆盖原文件', 503);
            }
            let value;
            try { value = validate(envelope.value); }
            catch { fail('corrupt', '忆幕资料格式无效，未覆盖原文件', 503); }
            await checkStore(ctx);
            return {value, fingerprint: current};
        } finally { await file.close(); }
    }

    async function targetUnchanged(ctx, name, prior) {
        let current;
        try { current = await stat(path.join(ctx.folder, name)); }
        catch (caught) { if (caught?.code === 'ENOENT' && !prior) return; throw caught; }
        if (!prior || !sameVersion(prior, current) || !current.isFile() || current.isSymbolicLink() || current.nlink !== 1n) {
            fail('changed', '忆幕资料已改变，未覆盖');
        }
    }

    async function writeFile(ctx, name, value, prior, validate) {
        const raw = JSON.stringify(value);
        const body = JSON.stringify({schema: 1, value, checksum: digest(raw)});
        if (Buffer.byteLength(body) > MAX_DOCUMENT_BYTES) fail('capacity', '忆幕资料超过安全保存容量，未截断任何内容', 507);
        const temporaryName = `.write-${randomUUID()}.tmp`;
        const temporaryPath = path.join(ctx.folder, temporaryName);
        let file, identity, renamed = false;
        try {
            await checkStore(ctx);
            file = await io.open(temporaryPath, 'wx', 0o600);
            identity = await file.stat({bigint: true});
            await file.writeFile(body, 'utf8');
            await file.sync();
            identity = await file.stat({bigint: true});
            await file.close();
            file = null;
            await checkStore(ctx);
            await targetUnchanged(ctx, name, prior);
            const staged = await stat(temporaryPath);
            if (!sameVersion(identity, staged) || !staged.isFile() || staged.isSymbolicLink() || staged.nlink !== 1n) {
                fail('changed', '待保存资料已变化，未覆盖原文件');
            }
            ctx.guard();
            await io.rename(temporaryPath, path.join(ctx.folder, name));
            renamed = true;
            if (process.platform !== 'win32') {
                const directory = await io.open(ctx.folder, 'r');
                try { await directory.sync(); } finally { await directory.close(); }
            }
            const saved = await readFile(ctx, name, validate, () => null);
            if (JSON.stringify(saved.value) !== raw) fail('unconfirmed', '忆幕保存尚未确认，请保留本次修改', 503);
        } finally {
            if (file) await file.close();
            if (identity && !renamed) {
                await checkStore(ctx);
                try {
                    const current = await stat(temporaryPath);
                    if (!sameFile(identity, current) || !current.isFile() || current.isSymbolicLink() || current.nlink !== 1n) {
                        fail('path', '忆幕临时文件已变化，未自动清理', 503);
                    }
                    await io.unlink(temporaryPath);
                } catch (caught) { if (caught?.code !== 'ENOENT') throw caught; }
            }
        }
    }

    async function exclusive(ctx, name, task) {
        const target = path.join(ctx.folder, `${name}.lock`);
        const deadline = Date.now() + lockTimeoutMs;
        let file, identity;
        while (!file) {
            await checkStore(ctx);
            try { file = await io.open(target, 'wx', 0o600); }
            catch (caught) {
                if (caught?.code !== 'EEXIST') throw caught;
                const occupied = await stat(target).catch(caught => { if (caught?.code === 'ENOENT') return null; throw caught; });
                if (!occupied) continue;
                if (!occupied.isFile() || occupied.isSymbolicLink() || occupied.nlink !== 1n || occupied.size > 512n) {
                    fail('lock', '忆幕保存锁异常，未自动清理', 503);
                }
                // Never delete another process's lock, including a stale one.
                if (Date.now() >= deadline) fail('busy', '忆幕资料正在保存或上次保存中断，请稍后重试；持续失败请核对服务器保存锁', 423);
                await new Promise(resolve => setTimeout(resolve, 20));
            }
        }
        try {
            identity = await file.stat({bigint: true});
            await file.writeFile(JSON.stringify({owner: randomUUID(), pid: process.pid}), 'utf8');
            await file.sync();
            return await task();
        } finally {
            await file.close();
            await checkStore(ctx);
            const current = await stat(target);
            if (!sameFile(identity, current) || !current.isFile() || current.isSymbolicLink() || current.nlink !== 1n) {
                fail('lock', '忆幕保存锁已变化，未自动清理', 503);
            }
            await io.unlink(target);
        }
    }

    function sourcePath(ctx, binding) {
        const avatar = binding.avatar.slice(0, -4);
        if (!safeName(avatar)) fail('binding', '角色文件名无效', 400);
        const folder = path.join(ctx.chats, avatar);
        const target = path.join(folder, `${binding.file}.jsonl`);
        if (!child(ctx.chats, folder) || !child(folder, target)) fail('binding', '聊天文件范围无效', 400);
        return {folder, target};
    }

    async function verifySource(ctx, binding, source = null, inspectEntries = null) {
        await checkRoot(ctx);
        await checkDirectory(ctx, ctx.chats);
        const {folder, target} = sourcePath(ctx, binding);
        await checkDirectory(ctx, folder);
        const before = await stat(target);
        if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n) fail('source', '聊天原文文件异常，未采用整理结果');
        const file = await io.open(target, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
        try {
            const opened = await file.stat({bigint: true});
            if (!sameVersion(before, opened) || opened.nlink !== 1n) fail('source_changed', '聊天原文读取期间已变化');
            let floor = -1, verified = 0, nextWindow = 0;
            const windows = (inspectEntries || []).map(entry => ({id: entry.id, source: entry.source})).sort((a, b) => a.source.start - b.source.start);
            const active = new Set(), invalid = new Set();
            const fingerprint = inspectEntries ? createHash('sha256').update(`${binding.integrity}\n`) : null;
            for await (const line of sourceLines(file, ctx)) {
                ctx.guard();
                if (Buffer.byteLength(line) > MAX_SOURCE_LINE_BYTES) fail('source', '聊天单层内容超过安全核对容量，未采用整理结果');
                let message;
                try { message = JSON.parse(line); }
                catch { fail('source', '聊天原文格式无效，未采用整理结果'); }
                floor++;
                if (floor === 0) {
                    if (String(message?.chat_metadata?.integrity || '') !== binding.integrity) fail('source_identity', '聊天身份已变化，未采用整理结果');
                    if (!source && !inspectEntries) break;
                    continue;
                }
                const hash = messageHash(message);
                if (source && floor >= source.start && floor <= source.end) {
                    if (hash !== source.hashes[floor - source.start]) fail('source_changed', '对应聊天原文已改变，未采用整理结果');
                    verified++;
                }
                if (inspectEntries) {
                    fingerprint.update(`${hash}\n`);
                    while (nextWindow < windows.length && windows[nextWindow].source.start <= floor) active.add(windows[nextWindow++]);
                    for (const window of active) {
                        if (floor > window.source.end) { active.delete(window); continue; }
                        if (hash !== window.source.hashes[floor - window.source.start]) invalid.add(window.id);
                    }
                }
                if (source && floor >= source.end && !inspectEntries) break;
            }
            if (floor < 0) fail('source', '聊天原文为空，未采用整理结果');
            if (source && verified !== source.end - source.start + 1) fail('source_changed', '对应聊天楼层已不存在，未采用整理结果');
            const after = await file.stat({bigint: true});
            const current = await stat(target);
            if (!sameVersion(opened, after) || !sameVersion(after, current) || current.isSymbolicLink() || current.nlink !== 1n) {
                fail('source_changed', '聊天原文读取期间已变化，未采用整理结果');
            }
            await checkDirectory(ctx, folder);
            await checkRoot(ctx);
            if (inspectEntries) {
                for (const window of windows) if (window.source.end > floor) invalid.add(window.id);
                return {invalidSourceIds: [...invalid], sourceFingerprint: fingerprint.digest('hex'), sourceFloorCount: floor};
            }
            return true;
        } finally {
            await file.close();
        }
    }

    // Explicit reads keep ownership of the descriptor (including Node 18) until final identity checks.
    async function* sourceLines(file, ctx) {
        const buffer = Buffer.alloc(64 * 1024), decoder = new TextDecoder('utf-8', {fatal: true});
        let pending = '', position = 0;
        while (true) {
            ctx.guard();
            const {bytesRead} = await file.read(buffer, 0, buffer.length, position);
            position += bytesRead;
            try { pending += decoder.decode(buffer.subarray(0, bytesRead), {stream: bytesRead !== 0}); }
            catch { fail('source', '聊天原文编码无效，未采用整理结果'); }
            let end;
            while ((end = pending.indexOf('\n')) !== -1) {
                const line = pending.slice(0, end).replace(/\r$/, '');
                pending = pending.slice(end + 1);
                yield line;
            }
            if (Buffer.byteLength(pending) > MAX_SOURCE_LINE_BYTES) fail('source', '聊天单层内容超过安全核对容量，未采用整理结果');
            if (!bytesRead) {
                if (pending) yield pending.replace(/\r$/, '');
                break;
            }
        }
    }

    async function requireSource(ctx, binding, source = null) {
        try { return await verifySource(ctx, binding, source); }
        catch (caught) {
            if (caught?.code === 'ENOENT') fail('source_missing', '找不到对应的 ST 聊天文件，未采用本次结果', 404);
            if (caught?.code === 'EACCES' || caught?.code === 'EPERM') fail('source_access', '无法读取对应的 ST 聊天文件，未采用本次结果', 403);
            throw caught;
        }
    }

    const documentRead = (ctx, binding) => readFile(ctx, chatStorageName(binding), contract.validateDocument, () => contract.createDocument(binding));
    const defaultsRead = ctx => readFile(ctx, 'defaults.json', contract.validateDefaults, contract.createDefaults);
    function assertBinding(document, binding) {
        if (!equal(document.binding, binding)) fail('binding_changed', '该聊天路径已属于其他聊天，原有忆幕资料已保留');
    }

    async function read(request, rawBinding) {
        const binding = normalizeStoreBinding(rawBinding), ctx = context(request);
        await prepare(ctx);
        const [{value: document}, {value: defaults}] = await Promise.all([documentRead(ctx, binding), defaultsRead(ctx)]);
        assertBinding(document, binding);
        let sourceAvailable = false, evidence = {invalidSourceIds: [], sourceFingerprint: null, sourceFloorCount: null};
        try {
            evidence = await verifySource(ctx, binding, null, document.entries.filter(entry => entry.status === 'active' && entry.source));
            sourceAvailable = true;
        }
        catch (caught) { if (caught?.code === 'yimu_account') throw caught; }
        return {document, defaults, sourceAvailable: sourceAvailable && !document.movedTo, ...evidence};
    }

    async function change(request, rawBinding, operation) {
        const binding = normalizeStoreBinding(rawBinding), ctx = context(request);
        await prepare(ctx);
        const summaryWithDefaults = ['append', 'redo'].includes(operation?.type) && operation?.entry?.kind === 'summary'
            && operation.expectedDefaultsRevision !== undefined;
        if (summaryWithDefaults && (!Number.isSafeInteger(operation.expectedDefaultsRevision) || operation.expectedDefaultsRevision < 0)) {
            fail('defaults_revision', '整理所依据的默认设置版本无效', 400);
        }
        const commit = () => exclusive(ctx, chatStorageName(binding), async () => {
            const current = await documentRead(ctx, binding);
            assertBinding(current.value, binding);
            const result = contract.applyOperation(current.value, withReceipt(operation));
            if (!equal(result.document, current.value)) {
                if (summaryWithDefaults) {
                    const actualDefaults = await defaultsRead(ctx);
                    if (actualDefaults.value.revision !== operation.expectedDefaultsRevision) {
                        fail('defaults_changed', '整理期间全局默认设置已改变，本次结果未采用');
                    }
                }
                if (current.value.movedTo) fail('moved', '该聊天已改名，请重新打开当前聊天');
                // A new file cannot claim an unverified chat path. Existing manual notes remain editable when originals go missing.
                if (!current.fingerprint) await requireSource(ctx, binding);
                if ((operation?.type === 'append' || operation?.type === 'redo') && operation.entry?.source) {
                    await requireSource(ctx, binding, operation.entry.source);
                }
                for (const entry of result.document.entries) {
                    const previous = current.value.entries.find(value => value.id === entry.id);
                    if (entry.status === 'active' && entry.source && (previous?.status !== 'active'
                        || previous.revision !== entry.revision || !equal(previous?.source, entry.source))) {
                        try { await requireSource(ctx, binding, entry.source); }
                        catch (caught) {
                            // Undo/restore/choosing a retained edit must remain possible after the source changes.
                            // Preserve that chosen text, but never revive it as validated memory. Candidate adoption stays strict.
                            const canRetain = operation?.type === 'entry' && operation.entryId === entry.id
                                && ['undo', 'restore', 'acceptConflict'].includes(operation.action)
                                && ['yimu_source_missing', 'yimu_source_changed', 'yimu_source_identity'].includes(caught?.code);
                            if (!canRetain) throw caught;
                            entry.status = 'invalid';
                        }
                    }
                }
                await writeFile(ctx, chatStorageName(binding), result.document, current.fingerprint, contract.validateDocument);
            }
            return result;
        });
        // All summary writers take defaults before chat, so settings cannot change between the check and commit.
        return summaryWithDefaults ? exclusive(ctx, 'defaults.json', commit) : commit();
    }

    async function defaults(request, operation) {
        const ctx = context(request);
        await prepare(ctx);
        return exclusive(ctx, 'defaults.json', async () => {
            const current = await defaultsRead(ctx);
            const result = contract.applyDefaultsOperation(current.value, withReceipt(operation));
            if (!equal(result.defaults, current.value)) await writeFile(ctx, 'defaults.json', result.defaults, current.fingerprint, contract.validateDefaults);
            return result;
        });
    }

    async function rename(request, rawBinding, rawNewBinding) {
        const binding = normalizeStoreBinding(rawBinding), newBinding = normalizeStoreBinding(rawNewBinding), ctx = context(request);
        if (binding.avatar !== newBinding.avatar || binding.integrity !== newBinding.integrity || binding.file === newBinding.file) {
            fail('rename', '只能关联同角色、同聊天身份的文件改名', 400);
        }
        await prepare(ctx);
        const names = [chatStorageName(binding), chatStorageName(newBinding)].sort();
        return exclusive(ctx, names[0], () => exclusive(ctx, names[1], async () => {
            const oldPath = sourcePath(ctx, binding).target;
            try { await stat(oldPath); fail('rename', '原聊天仍存在，不能将副本自动认作改名'); }
            catch (caught) { if (caught?.code !== 'ENOENT') throw caught; }
            await requireSource(ctx, newBinding);
            const previous = await documentRead(ctx, binding);
            assertBinding(previous.value, binding);
            if (!previous.fingerprint) fail('rename', '原聊天没有可迁移的忆幕资料', 404);
            const target = await documentRead(ctx, newBinding);
            if (previous.value.movedTo) {
                if (!equal(previous.value.movedTo, newBinding) || !target.fingerprint) fail('rename', '原聊天已迁移至其他文件');
                assertBinding(target.value, newBinding);
                return {document: target.value};
            }
            const document = {...clone(previous.value), binding: newBinding};
            delete document.movedTo;
            contract.validateDocument(document);
            // An interrupted transfer may have written the destination already. Only an exact match is resumable.
            if (target.fingerprint && !equal(target.value, document)) fail('rename', '目标聊天已有忆幕资料，未覆盖');
            if (!target.fingerprint) await writeFile(ctx, chatStorageName(newBinding), document, null, contract.validateDocument);
            const marked = {...previous.value, movedTo: newBinding};
            contract.validateDocument(marked);
            await writeFile(ctx, chatStorageName(binding), marked, previous.fingerprint, contract.validateDocument);
            return {document};
        }));
    }

    return Object.freeze({read, change, defaults, rename});
}
