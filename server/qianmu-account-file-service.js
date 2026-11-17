// 账户文件旧版本的盘点与清理（S5）。
// 千幕「带版本」的账户文件每次保存都新增一份正文（`<前缀>-<指纹>.json`），入口文件（`<前缀>.json`）指向当前那份，旧的留在磁盘上。
// 这里只做两件事：按槽位统计「当前／旧版本／无入口的原件」各占多少；对明确列在白名单里的槽位，删除不再被入口指向的旧正文。
// 不读正文内容、不改写任何文件；无入口的正文（角色原件、Vibe 原件等按指纹被引用的不可变文件）一律不碰；
// 其他账户范围的文件只计数。刚写入不久的正文（可能是保存到一半、入口尚未切换）也不删。
import * as fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { imageServiceAccount, imageServiceAccountStillMatches } from './qianmu-image-service-access.js';

export const ACCOUNT_FILE_LIMITS = Object.freeze({ scan: 200000, files: 60000, heads: 6000, timeoutMs: 25000, freshMs: 10 * 60 * 1000, keep: 1 });
// 只有这些槽位的旧正文确认没有任何地方按指纹引用：场外特助的对话历史与目录、正文收藏。
// 其余槽位只统计，待逐类核对引用关系后再加入。
export const ACCOUNT_FILE_CLEANABLE = Object.freeze(['assistant-*', 'assistant-conversations', 'text-collection']);

const sha = text => createHash('sha256').update(text).digest('hex');
const error = (code, message, status = 409) => Object.assign(new Error(message), { code: `account_files_${code}`, status });
const fail = (code, message, status) => { throw error(code, message, status); };
const child = (root, target) => { const relative = path.relative(root, target); return relative !== '' && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative); };
const sameFile = (a, b) => a?.ino > 0n && a.dev >= 0n && a.ino === b?.ino && a.dev === b?.dev;
const sameVersion = (a, b) => sameFile(a, b) && a.size === b.size && a.mtimeNs === b.mtimeNs;
const regular = stat => stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1n;
const HEX = '[a-f0-9]{64}';

/** 槽位归类：把槽位名末尾的摘要换成 `*`，同一类功能的众多槽位并成一行。 */
export function accountFileFamily(slot) { return String(slot).replace(/-[a-f0-9]{16,64}$/, '-*'); }

export function accountFilesErrorPayload(cause) {
    const known = /^account_files_/.test(cause?.code || '');
    return { status: known ? cause.status || 409 : 503, body: { ok: false, code: known ? cause.code : 'account_files_unavailable', error: known ? cause.message : '账户文件暂不可盘点，原件未修改' } };
}

export function createAccountFileService({ dataRoot, io = fs, now = () => Date.now(), timeoutMs = ACCOUNT_FILE_LIMITS.timeoutMs, freshMs = ACCOUNT_FILE_LIMITS.freshMs } = {}) {
    if (typeof dataRoot !== 'string' || !dataRoot || dataRoot.includes('\0')) fail('setup', '盘点环境尚未就绪', 503);
    const root = path.resolve(dataRoot);
    if (root === path.parse(root).root) fail('setup', '盘点范围无效', 503);
    let closed = false, busy = false;
    const lstat = file => io.lstat(file, { bigint: true });

    function capture(req, raw) {
        let account;
        try { account = imageServiceAccount(req); } catch { fail('account', '请先登录 ST', 401); }
        if (!raw || typeof raw !== 'object' || Array.isArray(raw) || raw.version !== 1 || raw.expectedAccount !== account.namespace) fail('account', '盘点账户已变化', 401);
        const original = { root: req.user?.directories?.root, files: req.user?.directories?.files };
        if (Object.values(original).some(value => typeof value !== 'string' || !value || value.includes('\0'))) fail('setup', '账户文件目录不可用', 503);
        const accountRoot = path.resolve(original.root), folder = path.resolve(original.files);
        if (!child(root, accountRoot) || !child(accountRoot, folder)) fail('path', '文件目录不属于当前账户', 403);
        const scope = sha(`qianmu.st-account-document.v1\0st-user:${req.user.profile.handle}`), deadline = now() + timeoutMs;
        return { folder, scope, account: account.namespace, directories: new Map(), guard() {
            if (closed || now() >= deadline || !imageServiceAccountStillMatches(req, account)
                || req.user?.directories?.root !== original.root || req.user?.directories?.files !== original.files) fail('changed', '盘点已停止或账户已变化');
        } };
    }
    async function roots(context) {
        context.guard(); let at = root; const directories = [at];
        for (const part of path.relative(root, context.folder).split(path.sep)) { at = path.join(at, part); directories.push(at); }
        for (const directory of directories) {
            const stat = await lstat(directory), prior = context.directories.get(directory);
            if (!stat.isDirectory() || stat.isSymbolicLink() || path.resolve(await io.realpath(directory)) !== directory || prior && !sameFile(prior, stat)) fail('path', '目录是链接或已更换');
            context.directories.set(directory, stat); context.guard();
        }
    }
    async function readSmall(context, name, observed) {
        const filename = path.join(context.folder, name);
        const handle = await io.open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
        try {
            const opened = await handle.stat({ bigint: true }); context.guard();
            if (!regular(opened) || !sameVersion(observed, opened)) fail('changed', '文件在盘点期间已变化，请重试');
            const buffer = Buffer.alloc(Number(opened.size)); let length = 0;
            while (length < buffer.length) { const part = await handle.read(buffer, length, buffer.length - length, length); if (!part.bytesRead) break; length += part.bytesRead; }
            try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length))); } catch { return null; }
        } finally { await handle.close(); }
    }

    // 一次完整盘点：槽位 → { head, bodies }；另计其他账户范围与快照文件。
    async function scan(context) {
        await roots(context);
        const mine = new RegExp(`^qianmu-v2-${context.scope}-(.+)\\.json$`), any = /^qianmu-v2-[a-f0-9]{64}-.+\.json$/;
        const files = [], other = { count: 0, bytes: 0 }, directory = await io.opendir(context.folder); let scanned = 0;
        try {
            for await (const entry of directory) {
                context.guard(); if (++scanned > ACCOUNT_FILE_LIMITS.scan) fail('capacity', '目录内文件过多，未返回不完整的统计');
                if (!any.test(entry.name)) continue;
                if (!entry.isFile() || entry.isSymbolicLink()) fail('path', '账户文件入口无效');
                const stat = await lstat(path.join(context.folder, entry.name)); context.guard();
                if (!regular(stat) || stat.size > BigInt(Number.MAX_SAFE_INTEGER)) fail('path', '账户文件不是独立常规文件');
                const match = mine.exec(entry.name);
                if (!match) { other.count++; other.bytes += Number(stat.size); continue; }
                if (files.length >= ACCOUNT_FILE_LIMITS.files) fail('capacity', '账户文件超过本次盘点范围');
                files.push({ name: entry.name, rest: match[1], stat });
            }
        } finally { try { await directory.close(); } catch (cause) { if (cause.code !== 'ERR_DIR_CLOSED') throw cause; } }
        // 入口文件很小且自带标记。文件名不足以区分「槽位 assistant-<摘要> 的入口」与「槽位 assistant 的某版正文」，所以读内容确认。
        const slots = new Map(), snapshots = { count: 0, bytes: 0 }, slotOf = name => { if (!slots.has(name)) slots.set(name, { head: null, bodies: [] }); return slots.get(name); };
        const pendingBodies = []; let heads = 0;
        for (const file of files) {
            if (file.rest.endsWith('.snapshot')) { snapshots.count++; snapshots.bytes += Number(file.stat.size); continue; }
            let head = null;
            if (file.stat.size > 0n && file.stat.size <= 4096n) {
                if (++heads > ACCOUNT_FILE_LIMITS.heads * 4) fail('capacity', '账户文件入口过多，未返回不完整的统计');
                const value = await readSmall(context, file.name, file.stat);
                if (value && typeof value === 'object' && value.schema === 'qianmu.st-account-head.v1' && value.scope === context.scope && value.slot === file.rest
                    && typeof value.fingerprint === 'string' && new RegExp(`^${HEX}$`).test(value.fingerprint)) head = value.fingerprint;
            }
            if (head) { const slot = slotOf(file.rest); if (slot.head) fail('content', '同一槽位出现两个入口'); slot.head = { fingerprint: head, file }; }
            else pendingBodies.push(file);
        }
        const loose = { count: 0, bytes: 0 }, bodyName = new RegExp(`^(.+)-(${HEX})$`);
        for (const file of pendingBodies) {
            const match = bodyName.exec(file.rest);
            if (!match) { loose.count++; loose.bytes += Number(file.stat.size); continue; }
            slotOf(match[1]).bodies.push({ fingerprint: match[2], file });
        }
        await roots(context);
        return { slots, other, snapshots, loose };
    }

    function summarize(found) {
        const families = new Map(), add = (target, stat) => { target.count++; target.bytes += Number(stat.size); };
        const total = { count: found.other.count + found.snapshots.count + found.loose.count, bytes: found.other.bytes + found.snapshots.bytes + found.loose.bytes };
        for (const [name, slot] of found.slots) {
            const family = accountFileFamily(name);
            if (!families.has(family)) families.set(family, { family, cleanable: ACCOUNT_FILE_CLEANABLE.includes(family), slots: 0, current: { count: 0, bytes: 0 }, retained: { count: 0, bytes: 0 }, originals: { count: 0, bytes: 0 } });
            const row = families.get(family); row.slots++;
            if (slot.head) { add(row.current, slot.head.file.stat); add(total, slot.head.file.stat); }
            for (const body of slot.bodies) {
                add(total, body.file.stat);
                // 没有入口的槽位：正文是按指纹被引用的不可变原件，不算旧版本。
                add(!slot.head ? row.originals : body.fingerprint === slot.head.fingerprint ? row.current : row.retained, body.file.stat);
            }
        }
        const rows = [...families.values()].sort((a, b) => b.retained.bytes - a.retained.bytes || (a.family < b.family ? -1 : 1));
        const cleanable = rows.filter(row => row.cleanable).reduce((sum, row) => ({ count: sum.count + row.retained.count, bytes: sum.bytes + row.retained.bytes }), { count: 0, bytes: 0 });
        return { families: rows, cleanable, total, other: found.other, snapshots: found.snapshots, unrecognized: found.loose };
    }

    async function inspect(req, raw) {
        const context = capture(req, raw);
        return { ok: true, version: 1, expectedAccount: context.account, observation: 'file-sizes-not-disk-allocation', ...summarize(await scan(context)) };
    }

    async function clean(req, raw) {
        const context = capture(req, raw), requested = raw.families;
        if (!Array.isArray(requested) || !requested.length || requested.length > ACCOUNT_FILE_CLEANABLE.length
            || requested.some(family => typeof family !== 'string' || !ACCOUNT_FILE_CLEANABLE.includes(family)) || new Set(requested).size !== requested.length) fail('contract', '清理范围无效', 400);
        const found = await scan(context), removed = { count: 0, bytes: 0 }, kept = { count: 0, bytes: 0 }, failed = { count: 0 };
        const cutoff = BigInt(now() - freshMs) * 1000000n;
        for (const [name, slot] of found.slots) {
            if (!slot.head || !requested.includes(accountFileFamily(name))) continue;
            // 入口指向的那份必须在场，否则这个槽位状态不明，整槽不动。
            if (!slot.bodies.some(body => body.fingerprint === slot.head.fingerprint)) { for (const body of slot.bodies) { kept.count++; kept.bytes += Number(body.file.stat.size); } continue; }
            const old = slot.bodies.filter(body => body.fingerprint !== slot.head.fingerprint).sort((a, b) => a.file.stat.mtimeNs < b.file.stat.mtimeNs ? 1 : -1);
            for (const [index, body] of old.entries()) {
                const size = Number(body.file.stat.size);
                // 保留最近一份旧版本；刚写入不久的也保留（可能是另一处正在保存、入口还没切过去）。
                if (index < ACCOUNT_FILE_LIMITS.keep || body.file.stat.mtimeNs > cutoff) { kept.count++; kept.bytes += size; continue; }
                context.guard();
                const filename = path.join(context.folder, body.file.name);
                try {
                    const live = await lstat(filename);
                    if (!regular(live) || !sameVersion(live, body.file.stat)) { kept.count++; kept.bytes += size; continue; }
                    // 删除前再读一次入口：期间入口若改指这份正文，就不删。
                    const head = await readSmall(context, slot.head.file.name, await lstat(path.join(context.folder, slot.head.file.name)));
                    if (!head || head.fingerprint !== slot.head.fingerprint) { kept.count++; kept.bytes += size; continue; }
                    await io.unlink(filename); removed.count++; removed.bytes += size;
                } catch (cause) { if (/^account_files_/.test(cause?.code || '')) throw cause; failed.count++; }
            }
        }
        return { ok: true, version: 1, expectedAccount: context.account, removed, kept, failed };
    }

    const exclusive = async work => {
        if (closed || busy) fail('busy', '账户文件正在盘点或清理，请稍后再试', 503);
        busy = true;
        try { return await work(); }
        catch (cause) {
            if (/^account_files_/.test(cause?.code || '')) throw cause;
            if (cause?.code === 'ENOENT') fail('missing', '文件目录不存在或已变化', 404);
            fail('unavailable', '账户文件暂不可盘点，原件未修改', 503);
        } finally { busy = false; }
    };
    return Object.freeze({ inspect: (req, raw) => exclusive(() => inspect(req, raw)), clean: (req, raw) => exclusive(() => clean(req, raw)), async close() { closed = true; } });
}

export function installAccountFileRoutes(router, { dataRoot, register, serviceOptions = {} }) {
    let service;
    for (const [route, method] of [['/storage/account-files', 'inspect'], ['/storage/account-files/clean', 'clean']]) router.post(route, async (req, res) => {
        res.set('Cache-Control', 'no-store'); res.set('X-Content-Type-Options', 'nosniff');
        try {
            if (!service) { service = createAccountFileService({ ...serviceOptions, dataRoot: dataRoot() }); register(service); }
            const result = await service[method](req, req.body);
            if (!res.destroyed && !res.writableEnded) return res.json(result);
        } catch (cause) { const result = accountFilesErrorPayload(cause); if (!res.destroyed && !res.writableEnded) return res.status(result.status).json(result.body); }
    });
}
