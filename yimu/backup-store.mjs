import path from 'node:path';
import {constants} from 'node:fs';
import {createHash, randomUUID} from 'node:crypto';
import * as contract from './contract.mjs';
import {collectBackupSources, portableDocument, validateBackupHeader, restoreBackupDocument} from './backup-contract.mjs';
import {encodeBackup, decodeBackup} from './backup-codec.mjs';
import {mergeBackupDocument} from './backup-merge.mjs';

const clone = value => structuredClone(value);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const idValid = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(value);
const hashValid = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const sameFile = (a, b) => a?.ino > 0n && a.ino === b?.ino && a.dev === b?.dev;
const sameVersion = (a, b) => sameFile(a, b) && a.size === b.size && a.mtimeNs === b.mtimeNs;
const MAX_LINE_BYTES = 32 * 1024 * 1024;
const MAX_COMPRESSED_BYTES = 2 * 1024 * 1024 * 1024;
const unavailable = code => ['ENOENT', 'yimu_source_missing', 'yimu_source_identity', 'yimu_source_changed', 'yimu_source', 'yimu_source_access'].includes(code);
const terminal = code => ['yimu_backup_changed', 'yimu_backup_collision', 'yimu_backup_raw', 'yimu_source', 'yimu_source_identity', 'yimu_source_changed', 'yimu_source_missing'].includes(code);

// A package is the sole archive of optional originals. Temporary raw files exist only
// during an explicit restore; completed originals live in ST's ordinary chat folder.
export function createBackupHandlers({io, context, prepare, exclusive, documentRead, readFile, read, requireSource, requireForeignSource,
    sourcePath, checkDirectory, checkRoot, checkStore, writeFile, normalizeStoreBinding, chatStorageName, fail, digest}) {
    const archiveName = id => `archive-${id}.json`;
    const packageName = id => `backup-${id}.yimu.gz`;
    const uploadName = id => `backup-upload-${digest(id)}.json`;
    const needId = id => {if (!idValid(id)) fail('backup_id', '备份操作标识无效', 400); return id;};
    const needArchiveId = id => {if (!hashValid(id)) fail('backup_id', '备份归档标识无效', 400); return id;};
    const validateRecord = value => {
        if (!value || !hashValid(value.id) || !hashValid(value.compressedHash) || !Number.isSafeInteger(value.compressedBytes)
            || value.compressedBytes < 1 || !value.header || value.id !== value.packageDigest) fail('backup_corrupt', '备份归档索引无效，未继续操作', 503);
        validateBackupHeader(value.header); return value;
    };
    const archiveRead = (ctx, id) => readFile(ctx, archiveName(needArchiveId(id)), validateRecord, () => null);
    const missingArchive = value => {if (!value) fail('backup_missing', '找不到此忆幕备份归档', 404); return value;};
    const preview = value => ({id: value.id, title: value.header.document.binding.file, createdAt: value.header.createdAt,
        entriesCount: value.header.document.entries.length, primarySourceId: 'source_0',
        sources: value.header.sources.map(source => ({...clone(source), label: `${source.binding.avatar.replace(/\.png$/i, '')} · ${source.binding.file}`, included: source.attached})),
        ...(value.restoration ? {restoration: {status: value.restoration.status, ...(value.restoration.receipt ? {target: clone(value.restoration.receipt.target)} : {})}} : {})});
    const publicRestoration = value => ({status: value.status, archiveId: value.archiveId, request: clone(value.request),
        ...(value.receipt ? {receipt: clone(value.receipt), binding: clone(value.receipt.target)} : {}), ...(value.message ? {message: value.message} : {})});

    async function* guardedFile(ctx, target, folder, expected = null) {
        await checkRoot(ctx); await checkDirectory(ctx, folder);
        const before = await io.lstat(target, {bigint: true});
        if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || expected && !sameVersion(before, expected)) fail('backup_changed', '备份来源文件已变化或不是独立文件');
        const file = await io.open(target, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
        try {
            const opened = await file.stat({bigint: true});
            if (!sameVersion(before, opened) || opened.nlink !== 1n) fail('backup_changed', '备份来源文件读取期间已变化');
            const buffer = Buffer.alloc(64 * 1024); let position = 0;
            while (true) {
                ctx.guard(); const {bytesRead} = await file.read(buffer, 0, buffer.length, position);
                if (!bytesRead) break;
                position += bytesRead; yield Buffer.from(buffer.subarray(0, bytesRead));
            }
            const after = await file.stat({bigint: true}), current = await io.lstat(target, {bigint: true});
            if (!sameVersion(opened, after) || !sameVersion(after, current) || current.nlink !== 1n || current.isSymbolicLink() || BigInt(position) !== opened.size) fail('backup_changed', '备份来源文件读取期间已变化');
            await checkDirectory(ctx, folder); await checkRoot(ctx);
        } finally {await file.close();}
    }

    function rawScanner(binding, {onLine = null, collectHashes = false} = {}) {
        const decoder = new TextDecoder('utf-8', {fatal: true}), bytesHash = createHash('sha256'), contentHash = createHash('sha256').update('[');
        let pending = '', bytes = 0, floor = -1, ended = false;
        const hashes = [];
        async function line(text) {
            if (Buffer.byteLength(text) > MAX_LINE_BYTES) fail('backup_raw', '聊天单层内容超过安全处理容量，未截断导入', 413);
            let value; try {value = JSON.parse(text);} catch {fail('backup_raw', '备份中的 ST 聊天原件格式无效', 400);}
            floor++;
            if (floor === 0) {
                if (!value || typeof value !== 'object' || Array.isArray(value) || String(value.chat_metadata?.integrity || '') !== binding.integrity) fail('backup_raw', '备份中的 ST 聊天身份与来源说明不符', 400);
            } else {
                if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.mes !== 'string') fail('backup_raw', '备份中的聊天正文格式无效', 400);
                const hash = digest(JSON.stringify([String(value.name || ''), Boolean(value.is_user), Boolean(value.is_system), String(value.mes || ''), String(value.send_date ?? '')]));
                contentHash.update(`${floor === 1 ? '' : ','}${JSON.stringify(hash)}`);
                if (collectHashes) hashes.push(hash);
            }
            if (onLine) await onLine(value, floor, text);
        }
        return {
            async push(chunk) {
                if (ended) fail('backup_raw', '原件内容在结束后仍有数据', 400);
                bytes += chunk.byteLength; bytesHash.update(chunk);
                try {pending += decoder.decode(chunk, {stream: true});} catch {fail('backup_raw', '聊天原件编码无效', 400);}
                let end;
                while ((end = pending.indexOf('\n')) !== -1) {const text = pending.slice(0, end).replace(/\r$/, ''); pending = pending.slice(end + 1); await line(text);}
                if (Buffer.byteLength(pending) > MAX_LINE_BYTES) fail('backup_raw', '聊天单层内容超过安全处理容量，未截断导入', 413);
            },
            async finish() {
                if (ended) fail('backup_raw', '原件结束记录重复', 400); ended = true;
                try {pending += decoder.decode();} catch {fail('backup_raw', '聊天原件编码不完整', 400);}
                if (pending) await line(pending.replace(/\r$/, ''));
                if (floor < 0) fail('backup_raw', '聊天原件为空', 400);
                return {bytes, sha256: bytesHash.digest('hex'), fingerprint: contentHash.update(']').digest('hex'), floorCount: floor, ...(collectHashes ? {hashes} : {})};
            },
        };
    }

    async function scanSource(ctx, binding, {foreign = false} = {}) {
        const proof = foreign ? await requireForeignSource(ctx, binding, null, []) : await requireSource(ctx, binding, null, []);
        const resolvedBinding = proof.resolvedBinding || binding;
        const {target, folder} = sourcePath(ctx, resolvedBinding), identity = await io.lstat(target, {bigint: true});
        const scanner = rawScanner(resolvedBinding);
        for await (const chunk of guardedFile(ctx, target, folder, identity)) await scanner.push(chunk);
        return {proof: await scanner.finish(), resolvedBinding, target, folder, identity};
    }

    async function preparePlan(ctx, binding, request) {
        const stored = await documentRead(ctx, binding), document = stored.value;
        if (!stored.fingerprint || !same(document.binding, binding) || document.movedTo) fail('backup_document', '当前聊天尚无可导出的忆幕资料', 404);
        if (document.companion && document.companion.account !== `st-user:${request.user.profile.handle}`) fail('account', '伴读关联不属于当前账户', 403);
        const portable = portableDocument(document), sources = [], streams = new Map();
        for (const source of collectBackupSources(portable)) {
            let scan = null;
            if (!source.unresolved) {
                try {scan = await scanSource(ctx, normalizeStoreBinding(source.binding), {foreign: source.id !== 'source_0'});}
                catch (caught) {if (!unavailable(caught.code)) throw caught;}
            }
            const descriptor = {id: source.id, binding: clone(source.binding), available: Boolean(scan), attached: false,
                bytes: scan?.proof.bytes || 0, floorCount: scan?.proof.floorCount || 0,
                ...(scan ? {sha256: scan.proof.sha256, fingerprint: scan.proof.fingerprint} : {})};
            sources.push(descriptor); if (scan) streams.set(source.id, scan);
        }
        const planId = digest(JSON.stringify([portable, sources]));
        return {portable, sources, streams, planId, documentRevision: document.revision};
    }

    async function backupPlan(request, rawBinding) {
        const ctx = context(request), binding = normalizeStoreBinding(rawBinding); await prepare(ctx);
        const plan = await preparePlan(ctx, binding, request);
        return {planId: plan.planId, documentRevision: plan.documentRevision, primarySourceId: 'source_0', title: binding.file,
            sources: plan.sources.map(source => ({...source, label: `${source.binding.avatar.replace(/\.png$/i, '')} · ${source.binding.file}`}))};
    }

    async function backupExport(request, rawBinding, operation) {
        const ctx = context(request), binding = normalizeStoreBinding(rawBinding); await prepare(ctx);
        const plan = await preparePlan(ctx, binding, request);
        if (plan.planId !== operation?.planId) fail('backup_changed', '记忆或来源已变化，请重新选择导出范围');
        const ids = operation.sourceIds;
        if (!Array.isArray(ids) || new Set(ids).size !== ids.length || ids.some(id => !plan.streams.has(id))) fail('backup_selection', '所选聊天原件不存在或尚未通过核对', 400);
        const header = {format: 'yimu-backup', version: 1, packageId: randomUUID(), createdAt: new Date().toISOString(), document: plan.portable,
            sources: plan.sources.map(source => ({...source, attached: ids.includes(source.id)}))};
        validateBackupHeader(header);
        const sources = header.sources.filter(source => source.attached).map(source => {
            const scan = plan.streams.get(source.id); return {id: source.id, stream: guardedFile(ctx, scan.target, scan.folder, scan.identity)};
        });
        return {filename: `忆幕备份-${new Date().toISOString().slice(0, 10)}.yimu.gz`, stream: encodeBackup({header, sources})};
    }

    async function unlinkOwned(ctx, target, identity) {
        await checkStore(ctx);
        let current; try {current = await io.lstat(target, {bigint: true});} catch (caught) {if (caught.code === 'ENOENT') return; throw caught;}
        if (!sameFile(current, identity) || !current.isFile() || current.isSymbolicLink() || current.nlink !== 1n) fail('backup_temp', '备份临时文件身份已变化，未自动清理', 503);
        await io.unlink(target);
    }

    async function decodeValidated(input, handlers = {}) {
        let header; const scanners = new Map();
        const result = await decodeBackup(input, {
            validateHeader: validateBackupHeader,
            async onHeader(value) {header = validateBackupHeader(value); if (handlers.onHeader) await handlers.onHeader(header);},
            async onFileStart(id) {
                const source = header.sources.find(item => item.id === id);
                if (!source) fail('backup_raw', '备份附件未列入来源清单', 400);
                scanners.set(id, rawScanner(source.binding, {onLine: handlers.onLine ? (value, floor, line) => handlers.onLine(id, value, floor, line) : null}));
                if (handlers.onFileStart) await handlers.onFileStart(id);
            },
            async onFileChunk(id, bytes) {await scanners.get(id).push(bytes);},
            async onFileEnd(receipt) {
                const source = header.sources.find(item => item.id === receipt.id), proof = await scanners.get(receipt.id).finish();
                if (proof.bytes !== source.bytes || proof.sha256 !== source.sha256 || proof.fingerprint !== source.fingerprint || proof.floorCount !== source.floorCount) fail('backup_raw', '备份附件与来源指纹不一致，未导入', 400);
                if (handlers.onFileEnd) await handlers.onFileEnd(receipt, proof);
            },
        });
        return result;
    }

    async function backupUpload(request, input, operationId) {
        const ctx = context(request), id = needId(operationId); await prepare(ctx);
        await exclusive(ctx, uploadName(id), async () => {
            const existing = await readFile(ctx, uploadName(id), value => value, () => null);
            if (!existing.value) await writeFile(ctx, uploadName(id), {id, status: 'pending'}, null, value => value);
        });
        const temporaryPath = path.join(ctx.folder, `.backup-upload-${randomUUID()}.tmp`);
        let file, identity, published = false;
        try {
            await checkStore(ctx); file = await io.open(temporaryPath, 'wx', 0o600); identity = await file.stat({bigint: true});
            let compressedBytes = 0; const compressedHash = createHash('sha256');
            async function* spool() {
                for await (const value of input) {
                    ctx.guard(); const bytes = Buffer.from(value); compressedBytes += bytes.length;
                    if (compressedBytes > MAX_COMPRESSED_BYTES) fail('backup_capacity', '备份压缩文件超过安全处理容量，未截断导入', 413);
                    await file.writeFile(bytes); compressedHash.update(bytes); yield bytes;
                }
            }
            const decoded = await decodeValidated(spool());
            await file.sync(); await file.close(); file = null;
            const archiveId = decoded.packageDigest, bytesHash = compressedHash.digest('hex'); needArchiveId(archiveId);
            // Upload identity precedes package publication. Concurrent reuse of one
            // operation id for different bytes cannot publish a second archive.
            const archive = await exclusive(ctx, uploadName(id), async () => {
                const current = await readFile(ctx, uploadName(id), value => value, () => null);
                if (current.value?.archiveId && current.value.archiveId !== archiveId) fail('backup_collision', '本次上传标识已用于另一份备份，未替换');
                const archive = await exclusive(ctx, archiveName(archiveId), async () => {
                    const existing = await archiveRead(ctx, archiveId);
                    if (existing.value) {
                        await verifyArchiveFile(ctx, existing.value);
                        return existing.value;
                    }
                    const target = path.join(ctx.folder, packageName(archiveId));
                    let occupied = null; try {occupied = await io.lstat(target, {bigint: true});} catch (caught) {if (caught.code !== 'ENOENT') throw caught;}
                    if (occupied) {
                        const actual = await compressedProof(ctx, target);
                        if (actual.sha256 !== bytesHash || actual.bytes !== compressedBytes) fail('backup_collision', '同一备份标识已有不同文件，未覆盖');
                    } else {
                        await checkStore(ctx);
                        const current = await io.lstat(temporaryPath, {bigint: true});
                        if (!sameFile(identity, current) || current.nlink !== 1n || current.isSymbolicLink()) fail('backup_temp', '待保存备份已变化');
                        // The per-package lock owns this name; never overwrite a pre-existing package.
                        await io.link(temporaryPath, target); await io.unlink(temporaryPath); published = true;
                    }
                    const record = {id: archiveId, packageDigest: archiveId, compressedBytes, compressedHash: bytesHash, header: validateBackupHeader(decoded.header), restoration: null, restorationHistory: []};
                    await writeFile(ctx, archiveName(archiveId), record, null, validateRecord);
                    return record;
                });
                await writeFile(ctx, uploadName(id), {id, status: 'complete', archiveId}, current.fingerprint, value => value);
                return archive;
            });
            return {archive: preview(archive)};
        } catch (caught) {
            if ([400, 413, 422].includes(caught?.status) || caught?.code === 'yimu_backup_format' || caught?.code === 'yimu_backup_raw') {
                await exclusive(ctx, uploadName(id), async () => {
                    const current = await readFile(ctx, uploadName(id), value => value, () => null);
                    if (current.value?.status !== 'complete') await writeFile(ctx, uploadName(id), {id, status: 'failed', message: caught.message}, current.fingerprint, value => value);
                });
            }
            throw caught;
        } finally {
            if (file) await file.close();
            if (identity && !published) await unlinkOwned(ctx, temporaryPath, identity);
        }
    }

    async function compressedProof(ctx, target) {
        const hash = createHash('sha256'); let bytes = 0;
        for await (const chunk of guardedFile(ctx, target, ctx.folder)) {hash.update(chunk); bytes += chunk.length;}
        return {sha256: hash.digest('hex'), bytes};
    }
    async function verifyArchiveFile(ctx, record) {
        const proof = await compressedProof(ctx, path.join(ctx.folder, packageName(record.id)));
        if (proof.sha256 !== record.compressedHash || proof.bytes !== record.compressedBytes) fail('backup_corrupt', '备份归档文件校验失败，未继续恢复', 503);
    }
    async function backupUploadResult(request, id) {
        const ctx = context(request); needId(id); await prepare(ctx);
        const result = await readFile(ctx, uploadName(id), value => value, () => null);
        if (!result.value) return {status: 'missing'};
        if (result.value.status === 'failed') return {status: 'failed', message: result.value.message};
        if (!result.value.archiveId) return {status: 'pending'};
        const archive = missingArchive((await archiveRead(ctx, result.value.archiveId)).value);
        return {status: 'complete', archive: preview(archive)};
    }
    async function backupList(request) {
        const ctx = context(request); await prepare(ctx); await checkStore(ctx);
        const archives = [];
        for (const name of await io.readdir(ctx.folder)) if (/^archive-[a-f0-9]{64}\.json$/.test(name)) {
            const item = await archiveRead(ctx, name.slice(8, -5)); if (item.value) archives.push(preview(item.value));
        }
        await checkStore(ctx); archives.sort((a, b) => b.createdAt.localeCompare(a.createdAt)); return {archives};
    }
    async function backupRead(request, id) {
        const ctx = context(request); await prepare(ctx); const record = missingArchive((await archiveRead(ctx, id)).value);
        await verifyArchiveFile(ctx, record);
        const decoded = await decodeValidated(guardedFile(ctx, path.join(ctx.folder, packageName(id)), ctx.folder));
        const header = validateBackupHeader(decoded.header);
        if (decoded.packageDigest !== id || !same(header, record.header)) fail('backup_corrupt', '备份归档资料与索引不一致', 503);
        return {archive: preview(record), document: header.document};
    }

    // Discovery runs only for an explicit import, never while opening/reading a chat.
    // The ordinary ST files remain read-only; no side index becomes another truth.
    async function importChats(ctx) {
        await checkRoot(ctx); await checkDirectory(ctx, ctx.chats);
        const chats = []; let incomplete = false;
        for (const folderName of await io.readdir(ctx.chats)) {
            const folder = path.join(ctx.chats, folderName);
            let directory; try {directory = await io.lstat(folder, {bigint: true});} catch {incomplete = true; continue;}
            if (!directory.isDirectory() || directory.isSymbolicLink()) continue;
            try {await checkDirectory(ctx, folder);} catch {incomplete = true; continue;}
            for (const name of await io.readdir(folder)) {
                if (!name.endsWith('.jsonl')) continue;
                let binding;
                try {
                    const target = path.join(folder, name), decoder = new TextDecoder('utf-8', {fatal: true});
                    let header = '';
                    for await (const chunk of guardedFile(ctx, target, folder)) {
                        header += decoder.decode(chunk, {stream: true});
                        const end = header.indexOf('\n');
                        if (end >= 0) {header = header.slice(0, end); break;}
                        if (Buffer.byteLength(header) > MAX_LINE_BYTES) throw new Error('header capacity');
                    }
                    const value = JSON.parse(header), integrity = value?.chat_metadata?.integrity;
                    binding = normalizeStoreBinding({avatar: `${folderName}.png`, file: name.slice(0, -6), integrity});
                    const scanned = await scanSource(ctx, binding);
                    chats.push({binding, proof: scanned.proof, label: `${folderName} · ${binding.file}`});
                } catch {ctx.guard(); incomplete = true;}
            }
        }
        await checkRoot(ctx); await checkDirectory(ctx, ctx.chats);
        return {chats, incomplete};
    }

    const sourceEqual = (source, chat) => !!source?.available && source.fingerprint === chat.proof.fingerprint && source.floorCount === chat.proof.floorCount;
    const identityEqual = (a, b) => contract.bindingKey(a) === contract.bindingKey(b);
    function uniqueMatch(source, chats, incomplete) {
        const matching = chats.filter(chat => sourceEqual(source, chat));
        const original = matching.find(chat => identityEqual(chat.binding, source.binding));
        return original || (!incomplete && matching.length === 1 ? matching[0] : null);
    }

    async function backupApply(request, archiveId, input = {}) {
        const ctx = context(request), operationId = needId(input.id); await prepare(ctx);
        const record = missingArchive((await archiveRead(ctx, archiveId)).value);
        const operationName = `backup-apply-${digest(operationId)}.json`;
        const selected = input.targetBinding ? normalizeStoreBinding(input.targetBinding) : null;
        return exclusive(ctx, operationName, async () => {
            const prior = await readFile(ctx, operationName, value => value, () => null);
            if (prior.value) {
                if (prior.value.archiveId !== archiveId || selected && !identityEqual(prior.value.binding, selected)) fail('backup_collision', '本次导入标识已用于其他目标，未重复合并');
                if (prior.value.status === 'complete') return {...prior.value, repeated: true};
                const saved = await documentRead(ctx, prior.value.binding);
                if (prior.value.result && saved.value.operations.includes(operationId)) {
                    await writeFile(ctx, operationName, prior.value.result, prior.fingerprint, value => value);
                    return {...prior.value.result, repeated: true};
                }
            }
            await verifyArchiveFile(ctx, record);
            const {chats, incomplete} = await importChats(ctx), primary = record.header.sources[0];
            const frozen = prior.value?.binding || selected;
            const target = frozen ? chats.find(chat => identityEqual(chat.binding, frozen)) : uniqueMatch(primary, chats, incomplete);
            if (frozen && !target) fail('backup_source', '所选聊天已不存在或无法核对，请重新选择');
            if (!target) return {status: 'selection', archiveId, reason: chats.filter(chat => sourceEqual(primary, chat)).length > 1 ? 'multiple' : 'unmatched',
                message: incomplete ? '部分聊天未能读取，请选择要导入的聊天，或取消。' : '请选择要导入的聊天，或取消。',
                candidates: chats.map(chat => ({binding: chat.binding, label: chat.label, exact: sourceEqual(primary, chat)}))};
            const exact = sourceEqual(primary, target), mappings = {source_0: target.binding};
            if(prior.value?.result?.exact&&!exact)fail('backup_changed','本次导入原本匹配的聊天正文已变化，未改换来源');
            for (const source of record.header.sources.slice(1)) {
                const match = uniqueMatch(source, chats, incomplete);
                if (match && !Object.values(mappings).some(value => identityEqual(value, match.binding))) mappings[source.id] = match.binding;
            }
            const restored = restoreBackupDocument(record.header.document, {binding: target.binding, mappings});
            if (!exact) {
                // Explicitly choosing a different text is permission to retain data,
                // never proof that old summaries describe the selected raw source.
                const unverified = (version, current = null) => {
                    const effective = current ? {...current, ...version} : version;
                    if (!effective.source && !effective.placement && effective.kind !== 'manual') return;
                    const oldBinding = value => record.header.sources.find(source => mappings[source.id] && identityEqual(mappings[source.id], value))?.binding || value;
                    version.origin = {binding: clone(oldBinding(effective.origin?.binding || target.binding)), offset: effective.origin?.offset || 0, unresolved: true};
                    if (effective.placement) version.placement = {...clone(effective.placement), binding: clone(oldBinding(effective.placement.binding))};
                    if (!['deleted', 'excluded'].includes(effective.status)) version.status = 'invalid';
                };
                for (const entry of restored.document.entries) {
                    unverified(entry); for (const version of entry.history) unverified(version);
                    for (const version of entry.conflicts) unverified(version, entry);
                    if (entry.candidate) unverified(entry.candidate, entry);
                }
            }
            return exclusive(ctx, chatStorageName(target.binding), async () => {
                for (const source of record.header.sources) if (mappings[source.id]) {
                    const checked = await scanSource(ctx, mappings[source.id]);
                    if ((source.id !== 'source_0' || exact) && !sourceEqual(source, checked)) fail('backup_changed', '匹配的原文已变化，未继续合并');
                }
                const saved = await documentRead(ctx, target.binding);
                if (!identityEqual(saved.value.binding, target.binding) || saved.value.movedTo) fail('backup_changed', '目标忆幕身份已变化，未合并');
                const merged = mergeBackupDocument(saved.value, restored.document, {operationId, packageId: archiveId});
                // Recheck all verified dependencies immediately before the one atomic write.
                for (const source of record.header.sources) if (mappings[source.id]) {
                    const checked = await scanSource(ctx, mappings[source.id]);
                    if ((source.id !== 'source_0' || exact) && !sourceEqual(source, checked)) fail('backup_changed', '合并期间原文已变化，未保存');
                }
                const result = {status: 'complete', archiveId, binding: clone(target.binding), outcome: merged.outcome, counts: merged.counts,
                    exact, unresolvedSources: restored.warnings.length, ...(exact ? {} : {message: '原文不一致，相关记忆已保留，核对前不会用于回复。'})};
                await writeFile(ctx, operationName, {status:'pending',archiveId,binding:clone(target.binding),result}, prior.fingerprint, value => value);
                const pending = await readFile(ctx, operationName, value => value, () => null);
                if (merged.outcome !== 'duplicate') await writeFile(ctx, chatStorageName(target.binding), merged.document, saved.fingerprint, contract.validateDocument, saved.legacyBytes);
                await writeFile(ctx, operationName, result, pending.fingerprint, value => value);
                return result;
            });
        });
    }

    async function verifyAvatar(ctx, avatar) {
        normalizeStoreBinding({avatar, file: 'check', integrity: 'check'});
        if (!ctx.characters) fail('backup_avatar', '未取得当前 ST 账户的角色目录', 403);
        const relative = path.relative(ctx.root, ctx.characters);
        if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) fail('backup_avatar', '角色目录不属于当前 ST 账户', 403);
        await checkDirectory(ctx, ctx.characters);
        const target = path.join(ctx.characters, avatar);
        let current; try {current = await io.lstat(target, {bigint: true});} catch (caught) {if (caught.code === 'ENOENT') fail('backup_avatar', '所选角色文件已不存在，请重新选择', 404); throw caught;}
        if (!current.isFile() || current.isSymbolicLink() || current.nlink !== 1n) fail('backup_avatar', '所选角色不是当前账户的独立角色文件', 403);
        const file = await io.open(target, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
        try {
            const opened = await file.stat({bigint: true}), signature = Buffer.alloc(8);
            const {bytesRead} = await file.read(signature, 0, 8, 0);
            if (!sameVersion(current, opened) || bytesRead !== 8 || !signature.equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) fail('backup_avatar', '所选文件不是有效的 ST 角色图片', 400);
            const after = await io.lstat(target, {bigint: true});
            if (!sameVersion(opened, after) || after.isSymbolicLink() || after.nlink !== 1n) fail('backup_avatar', '所选角色读取期间已变化');
        } finally {await file.close();}
        await checkDirectory(ctx, ctx.characters);
        await checkDirectory(ctx, ctx.chats);
        const {folder} = sourcePath(ctx, {avatar, file: 'check', integrity: 'check'});
        try {await io.mkdir(folder, {mode: 0o700});} catch (caught) {if (caught.code !== 'EEXIST') throw caught;}
        await checkDirectory(ctx, folder);
    }

    function normalizeRestore(record, input) {
        const id = needId(input?.id), targetAvatar = input.targetAvatar;
        normalizeStoreBinding({avatar: targetAvatar, file: 'check', integrity: 'check'});
        const sourceIds = input.sourceIds || [];
        if (!Array.isArray(sourceIds) || sourceIds.length !== new Set(sourceIds).size || sourceIds.some(sourceId => !record.header.sources.some(source => source.id === sourceId && source.attached))) fail('backup_selection', '只能恢复本包实际附带且明确选中的原件', 400);
        const useCurrentBinding = input.useCurrentBinding ? normalizeStoreBinding(input.useCurrentBinding) : null;
        if (!sourceIds.includes('source_0') && !useCurrentBinding) fail('backup_source', '本包未选主聊天原件；请保留归档，或明确匹配当前聊天后另建副本', 409);
        if (sourceIds.includes('source_0') && useCurrentBinding) fail('backup_selection', '主聊天原件与当前聊天匹配方式只能选择一种', 400);
        const request = {id, targetAvatar, sourceIds: record.header.sources.filter(source => sourceIds.includes(source.id)).map(source => source.id), ...(useCurrentBinding ? {useCurrentBinding} : {})};
        const mappings = {};
        for (const source of record.header.sources.filter(source => request.sourceIds.includes(source.id) || source.id === 'source_0' && useCurrentBinding)) {
            const hash = digest(JSON.stringify([record.id, id, source.id]));
            mappings[source.id] = {avatar: targetAvatar, file: `${Array.from(source.binding.file).slice(0, 55).join('')}-忆幕恢复-${hash.slice(0, 16)}`, integrity: `yimu-backup-${hash}`};
            normalizeStoreBinding(mappings[source.id]);
        }
        return {request, mappings};
    }

    async function currentMatch(ctx, record, operation) {
        if (!operation.useCurrentBinding) return null;
        const source = record.header.sources.find(item => item.id === 'source_0');
        if (!source.available || !hashValid(source.fingerprint)) fail('backup_source', '本包没有完整的主聊天指纹，不能凭名称匹配当前聊天');
        const scan = await scanSource(ctx, operation.useCurrentBinding);
        if (scan.proof.fingerprint !== source.fingerprint || scan.proof.floorCount !== source.floorCount) fail('backup_changed', '当前聊天正文与备份主来源不一致，未建立副本');
        return scan;
    }

    async function stageSources(ctx, record, operation, mappings) {
        const staged = new Map(), opened = new Map(), current = await currentMatch(ctx, record, operation);
        async function start(id) {
            if (!mappings[id]) return;
            const temporaryPath = path.join(ctx.folder, `.backup-restore-${randomUUID()}.tmp`);
            const file = await io.open(temporaryPath, 'wx', 0o600), identity = await file.stat({bigint: true});
            staged.set(id, {path: temporaryPath, identity, binding: mappings[id]}); opened.set(id, file);
        }
        async function line(id, value, floor, original) {
            const file = opened.get(id); if (!file) return;
            const text = floor === 0 ? JSON.stringify({user_name: String(value.user_name || 'unused'), character_name: String(value.character_name || 'unused'),
                chat_metadata: {integrity: mappings[id].integrity, yimu_backup: {archiveId: record.id, operationId: operation.id, sourceId: id}}}) : original;
            await file.writeFile(text + '\n', 'utf8');
        }
        async function end(id) {const file = opened.get(id); if (file) {await file.sync(); await file.close(); opened.delete(id);}}
        try {
            await verifyArchiveFile(ctx, record);
            const decoded = await decodeValidated(guardedFile(ctx, path.join(ctx.folder, packageName(record.id)), ctx.folder), {
                onFileStart: async id => {if (operation.sourceIds.includes(id)) await start(id);}, onLine: line, onFileEnd: receipt => end(receipt.id),
            });
            if (decoded.packageDigest !== record.id || !same(validateBackupHeader(decoded.header), record.header)) fail('backup_corrupt', '备份资料与归档索引不一致', 503);
            if (current) {
                await start('source_0'); const scanner = rawScanner(operation.useCurrentBinding, {onLine: (value, floor, text) => line('source_0', value, floor, text)});
                for await (const bytes of guardedFile(ctx, current.target, current.folder, current.identity)) await scanner.push(bytes);
                const proof = await scanner.finish(), expected = record.header.sources[0];
                if (proof.fingerprint !== expected.fingerprint || proof.floorCount !== expected.floorCount) fail('backup_changed', '当前聊天在准备恢复时已变化');
                await end('source_0');
            }
            for (const [id, value] of staged) {
                const scanner = rawScanner(value.binding, {collectHashes: id === 'source_0'});
                for await (const bytes of guardedFile(ctx, value.path, ctx.folder)) await scanner.push(bytes);
                value.proof = await scanner.finish();
            }
            return staged;
        } catch (caught) {
            for (const file of opened.values()) await file.close();
            for (const value of staged.values()) await unlinkOwned(ctx, value.path, value.identity);
            throw caught;
        }
    }

    async function createOnly(ctx, staged) {
        const {folder, target} = sourcePath(ctx, staged.binding); await checkDirectory(ctx, folder);
        let existing; try {existing = await io.lstat(target, {bigint: true});} catch (caught) {if (caught.code !== 'ENOENT') throw caught;}
        if (existing) {
            const proof = await scanSource(ctx, staged.binding);
            if (proof.proof.sha256 !== staged.proof.sha256 || proof.proof.fingerprint !== staged.proof.fingerprint) fail('backup_collision', '恢复目标已存在不同内容，未覆盖');
            return;
        }
        let file;
        try {
            file = await io.open(target, 'wx', 0o600);
            for await (const bytes of guardedFile(ctx, staged.path, ctx.folder)) await file.writeFile(bytes);
            await file.sync(); await file.close(); file = null;
            if (process.platform !== 'win32') {const directory = await io.open(folder, 'r'); try {await directory.sync();} finally {await directory.close();}}
            const proof = await scanSource(ctx, staged.binding);
            if (proof.proof.sha256 !== staged.proof.sha256) fail('backup_changed', '新聊天文件尚未完整核实');
        } finally {
            if (file) await file.close();
            // ST can see and edit a create-only destination immediately. Never unlink
            // it after an error: even the same inode may already contain the user's work.
            // The receipt keeps a partial target distinct from a confirmed restore.
        }
    }

    async function verifyRestored(ctx, restoration, {includeDocument = true} = {}) {
        const hashes = [], receipt = restoration.receipt;
        for (const source of receipt.restoredSources) {
            const proof = await scanSource(ctx, source.binding);
            if (proof.proof.fingerprint !== source.fingerprint || proof.proof.floorCount !== source.floorCount) fail('backup_changed', '已建立的聊天副本正文发生变化，请从 ST 聊天记录检查');
        }
        if (!includeDocument) return null;
        const saved = await documentRead(ctx, receipt.target);
        if (!saved.fingerprint) return null;
        if (!same(saved.value.binding, receipt.target)) fail('backup_collision', '恢复目标的忆幕身份不同，未覆盖');
        if (restoration.status !== 'complete' && digest(JSON.stringify(saved.value)) !== restoration.documentHash) fail('backup_collision', '待完成恢复目标已有其他忆幕资料，未覆盖');
        return saved.value;
    }

    async function persistRestoration(ctx, current, restoration) {
        const value = clone(current.value); value.restoration = restoration;
        await writeFile(ctx, archiveName(value.id), value, current.fingerprint, validateRecord);
        return await archiveRead(ctx, value.id);
    }

    async function backupRestore(request, id, input) {
        const ctx = context(request); await prepare(ctx); needArchiveId(id);
        let initial = missingArchive((await archiveRead(ctx, id)).value);
        if (initial.restoration?.status === 'complete') return backupResult(request, id, {});
        if (initial.restoration?.status === 'pending') {
            if (input?.id !== initial.restoration.request.id) return publicRestoration(initial.restoration);
            if (Object.keys(input).length === 1) input = initial.restoration.request;
            else if (!same(normalizeRestore(initial, input).request, initial.restoration.request)) fail('backup_collision', '本次恢复标识已有不同选择，未更换目标');
        }
        if ([initial.restoration, ...(initial.restorationHistory || [])].some(item => item?.status === 'failed' && item.request.id === input?.id)) fail('backup_failed', '此恢复已确认失败，请保留已有文件并重新选择另建副本');
        const prepared = normalizeRestore(initial, input);
        await verifyAvatar(ctx, prepared.request.targetAvatar);
        const staged = await stageSources(ctx, initial, prepared.request, prepared.mappings);
        try {
            return await exclusive(ctx, archiveName(id), async () => {
                let current = await archiveRead(ctx, id), record = missingArchive(current.value);
                if (record.restoration?.status === 'complete') return publicRestoration(record.restoration);
                if (record.restoration?.status === 'pending' && !same(record.restoration.request, prepared.request)) return publicRestoration(record.restoration);
                const restored = restoreBackupDocument(record.header.document, {binding: prepared.mappings.source_0, mappings: prepared.mappings});
                const document = contract.validateDocument(restored.document); document.enabled = false;
                const receipt = {id: prepared.request.id, status: 'pending', archiveId: id, target: clone(document.binding), sourceFingerprint: staged.get('source_0').proof.fingerprint,
                    hashes: staged.get('source_0').proof.hashes, documentRevision: document.revision,
                    restoredSources: [...staged].map(([sourceId, value]) => ({id: sourceId, binding: value.binding, fingerprint: value.proof.fingerprint, floorCount: value.proof.floorCount}))};
                let restoration = {archiveId: id, status: 'pending', request: prepared.request, receipt, documentHash: digest(JSON.stringify(document)), warnings: restored.warnings || []};
                if (!record.restoration || record.restoration.status === 'failed') {
                    if (record.restoration) {
                        record = {...record, restorationHistory: [...(record.restorationHistory || []), record.restoration]};
                        await writeFile(ctx, archiveName(id), record, current.fingerprint, validateRecord); current = await archiveRead(ctx, id);
                    }
                    // Refuse occupied targets before saving the new plan; never adopt an arbitrary same-name file.
                    for (const value of staged.values()) {
                        try {await io.lstat(sourcePath(ctx, value.binding).target); fail('backup_collision', '目标聊天已存在，未覆盖');}
                        catch (caught) {if (caught.code !== 'ENOENT') throw caught;}
                    }
                    const memory = await documentRead(ctx, document.binding);
                    if (memory.fingerprint) fail('backup_collision', '目标忆幕资料已存在，未覆盖');
                    current = await persistRestoration(ctx, current, restoration);
                } else {
                    restoration = record.restoration;
                    if (!same(restoration.receipt, receipt) || restoration.documentHash !== digest(JSON.stringify(document))) fail('backup_changed', '恢复准备结果与已记录的计划不一致，未覆盖');
                }
                try {
                    await currentMatch(ctx, record, prepared.request);
                    for (const value of staged.values()) await createOnly(ctx, value);
                    await verifyRestored(ctx, restoration, {includeDocument: false});
                    await currentMatch(ctx, record, prepared.request);
                    await exclusive(ctx, chatStorageName(document.binding), async () => {
                        const memory = await documentRead(ctx, document.binding);
                        if (memory.fingerprint && digest(JSON.stringify(memory.value)) !== restoration.documentHash) fail('backup_collision', '目标忆幕资料已被编辑，未覆盖');
                        if (!memory.fingerprint) await writeFile(ctx, chatStorageName(document.binding), document, null, contract.validateDocument);
                    });
                    if (!await verifyRestored(ctx, restoration)) fail('backup_changed', '新忆幕副本尚未核实');
                    await currentMatch(ctx, record, prepared.request);
                    restoration = {...restoration, status: 'complete', receipt: {...restoration.receipt, status: 'complete'}};
                    await persistRestoration(ctx, current, restoration);
                    return {...publicRestoration(restoration), document, warnings: restoration.warnings};
                } catch (caught) {
                    if (terminal(caught.code)) await persistRestoration(ctx, current, {...restoration, status: 'failed', message: caught.message, receipt: {...restoration.receipt, status: 'failed'}});
                    throw caught;
                }
            });
        } finally {for (const value of staged.values()) await unlinkOwned(ctx, value.path, value.identity);}
    }

    async function backupResult(request, id, query = {}) {
        const ctx = context(request); await prepare(ctx); needArchiveId(id);
        return exclusive(ctx, archiveName(id), async () => {
            let current = await archiveRead(ctx, id); const record = missingArchive(current.value);
            let restoration = record.restoration;
            if (query?.id && restoration?.request.id !== query.id) restoration = (record.restorationHistory || []).find(item => item.request.id === query.id);
            if (!restoration) return {status: 'missing', archiveId: id};
            if (restoration.status === 'failed') return publicRestoration(restoration);
            try {
                if (restoration.status === 'pending') await currentMatch(ctx, record, restoration.request);
                let allPresent = true;
                for (const source of restoration.receipt.restoredSources) {
                    try {await io.lstat(sourcePath(ctx, source.binding).target);} catch (caught) {if (caught.code === 'ENOENT') {allPresent = false; break;} throw caught;}
                }
                if (!allPresent && restoration.status === 'pending') return publicRestoration(restoration);
                const document = await verifyRestored(ctx, restoration);
                if (!document) return publicRestoration(restoration);
                if (restoration.status === 'pending') {
                    restoration = {...restoration, status: 'complete', receipt: {...restoration.receipt, status: 'complete'}};
                    await persistRestoration(ctx, current, restoration);
                }
                return {...publicRestoration(restoration), document};
            } catch (caught) {
                if (restoration.status === 'pending' && terminal(caught.code)) {
                    restoration = {...restoration, status: 'failed', receipt: {...restoration.receipt, status: 'failed'}, message: caught.message};
                    await persistRestoration(ctx, current, restoration); return publicRestoration(restoration);
                }
                throw caught;
            }
        });
    }

    return {backupPlan, backupExport, backupUpload, backupUploadResult, backupList, backupRead, backupApply, backupRestore, backupResult};
}
