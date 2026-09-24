import * as fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { imageServiceAccount, imageServiceAccountStillMatches } from './qianmu-image-service-access.js';
import { assistantStorageRequest, assistantStorageResponse, assistantStorageError, assistantStorageErrorPayload, assistantCatalogueRequest, assistantCatalogueResponse, ASSISTANT_CATALOGUE_LIMITS, ASSISTANT_STORAGE_LIMITS as LIMIT } from './qianmu-assistant-storage-contract.js';
import { parseBoundedJson } from './qianmu-json-input.js';

const sha = text => createHash('sha256').update(text).digest('hex');
const fail = (code, message, status) => { throw assistantStorageError(code, message, status); };
const child = (root, target) => { const relative = path.relative(root, target); return relative !== '' && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative); };
const sameFile = (a, b) => a?.ino > 0n && a.dev >= 0n && a.ino === b?.ino && a.dev === b?.dev;
const sameVersion = (a, b) => sameFile(a, b) && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
const regular = stat => stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1n;
const stamp = stat => sha([stat.dev, stat.ino, stat.mtimeNs, stat.ctimeNs].join(':'));

// Read only small heads and stat matching assistant files. Do not read history
// bodies, unrelated modules, chat files or models; never write/repair/delete.
export function createAssistantStorageService({ dataRoot, io = fs, timeoutMs = LIMIT.timeoutMs } = {}) {
    if (typeof dataRoot !== 'string' || !dataRoot || dataRoot.includes('\0') || !Number.isFinite(timeoutMs) || timeoutMs < 100 || timeoutMs > 30000) fail('setup', '盘点环境尚未就绪', 503);
    const root = path.resolve(dataRoot);
    if (root === path.parse(root).root) fail('setup', '盘点范围无效', 503);
    let closed = false;
    const pending = new Set(), lstat = file => io.lstat(file, { bigint: true });
    function capture(req, raw, signal) {
        let account;
        try { account = imageServiceAccount(req); } catch { fail('account', '请先登录 ST', 401); }
        const input = assistantStorageRequest(raw);
        if (input.expectedAccount !== account.namespace) fail('account', '盘点账户已变化', 401);
        const original = { root: req.user?.directories?.root, files: req.user?.directories?.files };
        if (Object.values(original).some(value => typeof value !== 'string' || !value || value.includes('\0'))) fail('setup', '账户文件目录不可用', 503);
        const accountRoot = path.resolve(original.root), folder = path.resolve(original.files);
        if (!child(root, accountRoot) || !child(accountRoot, folder)) fail('path', '文件目录不属于当前账户', 403);
        const scope = sha(`qianmu.st-account-document.v1\0st-user:${req.user.profile.handle}`), deadline = Date.now() + timeoutMs;
        return { input, folder, scope, directories: new Map(), guard() {
            if (closed || signal.aborted || Date.now() >= deadline || !imageServiceAccountStillMatches(req, account)
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
        return context.directories.get(context.folder);
    }
    async function scan(context) {
        await roots(context);
        const pattern = new RegExp(`^qianmu-v2-${context.scope}-assistant-([a-f0-9]{64})(?:-([a-f0-9]{64}))?\\.json$`);
        const selected = new Map(), directory = await io.opendir(context.folder); let scanned = 0;
        try {
            for await (const entry of directory) {
                context.guard(); if (++scanned > LIMIT.scan) fail('capacity', '文件盘点超过范围，未返回截断统计');
                const match = pattern.exec(entry.name); if (!match) continue;
                if (selected.size >= LIMIT.files) fail('capacity', '助手文件超过本次盘点范围');
                if (!entry.isFile() || entry.isSymbolicLink() || selected.has(entry.name)) fail('path', '助手文件入口无效');
                const stat = await lstat(path.join(context.folder, entry.name)); context.guard();
                if (!regular(stat) || stat.size < 0n || stat.size > BigInt(Number.MAX_SAFE_INTEGER)) fail('path', '助手文件不是独立常规文件');
                selected.set(entry.name, { slot: 'assistant-' + match[1], fingerprint: match[2] || null, stat });
            }
        } finally { try { await directory.close(); } catch (error) { if (error.code !== 'ERR_DIR_CLOSED') throw error; } }
        await roots(context); return selected;
    }
    async function readHead(context, name, observed) {
        await roots(context);
        const filename = path.join(context.folder, name), before = await lstat(filename);
        if (!regular(before) || !sameVersion(before, observed) || before.size < 1n || before.size > 4096n) fail('changed', '助手入口已变化或格式无效');
        const handle = await io.open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
        try {
            const opened = await handle.stat({ bigint: true }); context.guard();
            if (!regular(opened) || !sameVersion(before, opened)) fail('changed', '助手入口打开前已变化');
            const buffer = Buffer.alloc(Number(opened.size) + 1); let length = 0;
            while (length < buffer.length) { context.guard(); const part = await handle.read(buffer, length, buffer.length - length, length); context.guard(); if (!part.bytesRead) break; length += part.bytesRead; }
            const after = await handle.stat({ bigint: true }), current = await lstat(filename);
            if (BigInt(length) !== opened.size || !regular(after) || !regular(current) || !sameVersion(opened, after) || !sameVersion(after, current)) fail('changed', '助手入口读取期间已变化');
            let value;
            try { value = parseBoundedJson(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length)), { maxBytes: 4096, maxDepth: 4, maxNodes: 32, label: '助手文件入口' }); }
            catch { fail('content', '助手入口损坏，未当成空库'); }
            await roots(context); return value;
        } finally { await handle.close(); }
    }
    async function inspect(req, input, signal, catalogue=false) {
        const page=catalogue?assistantCatalogueRequest(input):null;
        const context = capture(req, page?{version:page.version,expectedAccount:page.expectedAccount}:input, signal), generation = stamp(await roots(context)), files = await scan(context), active = new Set();
        if (stamp(await roots(context)) !== generation) fail('changed', '目录在扫描期间已变化');
        const heads=[...files].filter(([,file])=>!file.fingerprint).sort(([a],[b])=>a<b?-1:a>b?1:0),entries=[];
        const snapshot=page?sha(JSON.stringify([...files].sort(([a],[b])=>a<b?-1:a>b?1:0).map(([name,{stat}])=>[name,String(stat.size),stamp(stat)]))):null;
        if(page&&(page.offset>heads.length||page.snapshot!==null&&page.snapshot!==snapshot))fail('changed','助手目录已变化，请从第一页刷新');
        const result = { ok: true, version: 1, expectedAccount: context.input.expectedAccount, scope: 'st-account-assistant-files', observation: 'file-sizes-not-disk-allocation', contentVerified: false,
            heads: { count: 0, bytes: 0 }, current: { count: 0, bytes: 0 }, retained: { count: 0, bytes: 0 }, total: { count: 0, bytes: 0 } };
        function add(target, stat) { target.count++; target.bytes += Number(stat.size); if (!Number.isSafeInteger(target.bytes)) fail('capacity', '文件大小超过统计精度'); }
        for (const [name, file] of page?heads.slice(page.offset,page.offset+ASSISTANT_CATALOGUE_LIMITS.page):heads) {
            const head = await readHead(context, name, file.stat);
            if (!head || typeof head !== 'object' || Array.isArray(head) || Object.keys(head).sort().join(',') !== 'fingerprint,schema,scope,slot' || head.schema !== 'qianmu.st-account-head.v1'
                || head.scope !== context.scope || head.slot !== file.slot || typeof head.fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(head.fingerprint)) fail('content', '助手入口与账户范围不符');
            const body = name.slice(0, -5) + '-' + head.fingerprint + '.json';
            if (!files.has(body) || active.has(body)) fail('missing', '助手当前版本文件缺失，未作为零占用', 404);
            active.add(body); add(result.heads, file.stat);
            if(page)entries.push({version:1,scope:context.scope,slot:file.slot,fingerprint:head.fingerprint,bytes:Number(files.get(body).stat.size)});
        }
        for (const [name, file] of files) { add(result.total, file.stat); if (file.fingerprint) add(active.has(name) ? result.current : result.retained, file.stat); }
        // A second metadata pass rejects additions/removals and in-place file
        // changes, not only mutable head replacements. No partial summary escapes.
        const final = await scan(context);
        if (final.size !== files.size || [...files].some(([name, file]) => !sameVersion(file.stat, final.get(name)?.stat)) || stamp(await roots(context)) !== generation) fail('changed', '盘点期间文件已变化，请刷新');
        context.guard(); return page?assistantCatalogueResponse({ok:true,version:1,expectedAccount:page.expectedAccount,scope:context.scope,offset:page.offset,snapshot,total:heads.length,
            nextOffset:page.offset+entries.length<heads.length?page.offset+entries.length:null,entries},page):assistantStorageResponse(result, context.input.expectedAccount);
    }
    return Object.freeze({ inspect(req, input, { signal, catalogue=false } = {}) {
        if (closed || pending.size >= LIMIT.pending) return Promise.reject(assistantStorageError('busy', '盘点正忙或已关闭', 503));
        const controller = new AbortController(); let rejectStop;
        const stopped = new Promise((_, reject) => { rejectStop = reject; });
        const abort = () => { controller.abort(); rejectStop(assistantStorageError('changed', '盘点已取消或超时')); };
        pending.add(abort); signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort();
        const timer = setTimeout(abort, timeoutMs), work = Promise.resolve().then(() => inspect(req, input, controller.signal,catalogue));
        void work.finally(() => pending.delete(abort)).catch(() => {});
        return Promise.race([work, stopped]).catch(error => {
            if (/^assistant_storage_/.test(error?.code || '')) throw error;
            if (error?.code === 'ENOENT') fail('missing', '文件目录不存在或已变化，未当成空库', 404);
            fail('unavailable', '助手文件暂不可盘点，原件未修改', 503);
        }).finally(() => { clearTimeout(timer); signal?.removeEventListener('abort', abort); controller.abort(); });
    }, async close() { closed = true; for (const abort of pending) abort(); } });
}

export function installAssistantStorageRoutes(router, { dataRoot, register, serviceOptions = {} }) {
    let service;
    for(const route of ['/assistant/storage','/assistant/history-catalogue'])router.post(route, async (req, res) => {
        res.set('Cache-Control', 'no-store'); res.set('X-Content-Type-Options', 'nosniff');
        const controller = new AbortController(), abort = () => controller.abort(), onClose = () => { if (!res.writableEnded) abort(); };
        req.once?.('aborted', abort); res.once?.('close', onClose);
        try {
            try { imageServiceAccount(req); } catch { fail('account', '请先登录 ST', 401); }
            if (!service) { service = createAssistantStorageService({ ...serviceOptions, dataRoot: dataRoot() }); register(service); }
            const result = await service.inspect(req, req.body, { signal: controller.signal,catalogue:route==='/assistant/history-catalogue' });
            if (!res.destroyed && !res.writableEnded) return res.json(result);
        } catch (error) { const result = assistantStorageErrorPayload(error); if (!res.destroyed && !res.writableEnded) return res.status(result.status).json(result.body); }
        finally { req.off?.('aborted', abort); res.off?.('close', onClose); }
    });
}
