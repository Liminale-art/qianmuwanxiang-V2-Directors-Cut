// Import archives are account-owned documents, never synthetic chat bindings.
import { fingerprintMessages } from './contract.mjs';
const clone = value => structuredClone(value);
// 多份记忆打成一个文件：一行标记、一行清单（每份的文件名与字节数），后面依次接各份备份原样的字节。
// 拆开后每一份仍是普通的 .yimu.gz，走原有的导入流程。
const PACK_MAGIC = 'YIMUPACK1';
export const isBackupPack = name => /\.yimupack$/i.test(String(name || ''));
export function packBackups(results, { BlobType = globalThis.Blob, now = new Date() } = {}) {
    const list = results.map(item => ({ name: item.filename, size: item.blob.size }));
    const pad = value => String(value).padStart(2, '0');
    const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
    return { blob: new BlobType([`${PACK_MAGIC}\n${JSON.stringify(list)}\n`, ...results.map(item => item.blob)], { type: 'application/octet-stream' }), filename: `忆幕记忆包-${results.length}份-${stamp}.yimupack` };
}
export async function unpackBackups(file) {
    const head = new Uint8Array(await file.slice(0, Math.min(file.size, 4 * 1024 * 1024)).arrayBuffer());
    const first = head.indexOf(10), second = first < 0 ? -1 : head.indexOf(10, first + 1);
    const decoder = new TextDecoder('utf-8', { fatal: true });
    if (second < 0 || decoder.decode(head.slice(0, first)) !== PACK_MAGIC) throw new Error('这不是忆幕的记忆包');
    let list; try { list = JSON.parse(decoder.decode(head.slice(first + 1, second))); } catch { throw new Error('记忆包清单已损坏'); }
    if (!Array.isArray(list) || !list.length || list.length > 2000) throw new Error('记忆包清单已损坏');
    let offset = second + 1; const parts = [];
    for (const item of list) {
        if (typeof item?.name !== 'string' || !Number.isSafeInteger(item.size) || item.size < 1 || offset + item.size > file.size) throw new Error('记忆包内容不完整');
        const part = file.slice(offset, offset + item.size); offset += item.size;
        parts.push({ name: item.name, stream: () => part.stream(), size: part.size, slice: (...args) => part.slice(...args), arrayBuffer: () => part.arrayBuffer() });
    }
    if (offset !== file.size) throw new Error('记忆包内容不完整');
    return parts;
}
const same = (a, b) => !!a && !!b && a.avatar === b.avatar && a.file === b.file && a.integrity === b.integrity;

export function saveBackupDownload({ blob, filename }, { document = globalThis.document, url = globalThis.URL } = {}) {
    const href = url.createObjectURL(blob), link = document.createElement('a');
    link.href = href; link.download = filename || '忆幕备份.yimu.gz'; link.hidden = true;
    document.body.append(link); link.click(); link.remove();
    setTimeout(() => url.revokeObjectURL(href), 60000);
}

export function createBackupActions({ state, host, api, emit, id, lifecycle = () => ({}), refresh = async () => {}, download = saveBackupDownload }) {
    const view = state.backup ||= { archives: [], roles: [], selected: null, document: null, exportPlan: null, busy: false, error: '', status: '' };
    const restores = new Map();
    let alive = true, upload = null;
    view.items ||= [];
    const active = () => alive && !lifecycle().disposed;
    const publish = () => { if (active()) emit(); };
    const roles = () => { view.roles = host.characters?.() || []; };
    const putArchive = archive => {
        if (!archive?.id) throw new Error('备份资料尚未确认保存');
        view.archives = [archive, ...view.archives.filter(item => item.id !== archive.id)];
        return archive;
    };
    const record = archiveId => {
        if (!restores.has(archiveId)) restores.set(archiveId, { pending: null, result: null });
        return restores.get(archiveId);
    };
    const showRecord = archiveId => {
        const saved = record(archiveId); view.restorePending = !!saved.pending; view.result = saved.result;
    };
    const setResult = (archiveId, result) => {
        const saved = record(archiveId);
        if (result?.status === 'failed' || result?.receipt?.status === 'failed') {
            saved.pending = null; saved.result = null;
            if (view.selected?.id === archiveId) showRecord(archiveId);
            throw new Error(result.message || '本次恢复已确认失败，原有资料保留，请重新核对后操作');
        }
        if (result?.status === 'pending' || result?.receipt?.status === 'pending') {
            const request = result.request || (result.receipt?.id ? { id: result.receipt.id } : null);
            if (request?.id) saved.pending = clone(request);
            if (view.selected?.id === archiveId) showRecord(archiveId);
            return false;
        }
        if (result?.receipt?.status !== 'complete' || !result.binding) return false;
        saved.pending = null; saved.result = result;
        if (view.selected?.id === archiveId) showRecord(archiveId);
        return true;
    };
    const readArchive = async archiveId => {
        const result = await api.backupRead(archiveId);
        if (!active()) return result;
        view.selected = putArchive(result.archive); view.document = result.document; showRecord(archiveId);
        return result;
    };
    async function refreshList() {
        roles(); const result = await api.backupList();
        if (active()) { view.archives = result.archives || []; view.loaded = true; publish(); }
        return result;
    }
    async function processImport(item) {
        try {
            item.error = '';
            if (!item.archive) {
                if(!/\.yimu\.gz$/i.test(item.name)||typeof item.file?.stream!=='function'){
                    item.status='failed';throw new Error('仅支持忆幕自己的 .yimu.gz 备份包');
                }
                item.status = 'uploading'; publish();
                let uploaded;
                try {uploaded = await api.backupUpload(item.file, item.uploadId);}
                catch (error) {
                    const found = await api.backupUploadResult(item.uploadId).catch(() => null);
                    if (found?.status === 'complete' && found.archive) uploaded = found;
                    else {item.status = found?.status === 'failed' || error.status >= 400 && error.status < 500 && found?.status === 'missing' ? 'failed' : 'upload-unknown'; throw new Error(found?.message || error.message);}
                }
                if (!uploaded?.archive?.id) {item.status = 'upload-unknown'; throw new Error('上传结果尚未确认，请核对本次导入。');}
                item.archive = uploaded.archive;
            }
            item.status = item.restoreRequest ? 'restoring' : 'matching'; publish();
            let result;
            if (item.restoreRequest) {
                try {result = await api.backupRestore(item.archive.id, item.restoreRequest);}
                catch (error) {
                    const found = await api.backupResult(item.archive.id, {id: item.restoreRequest.id}).catch(() => null);
                    if (found?.receipt?.status === 'complete') result = found;
                    else {item.status = 'merge-unknown'; throw error;}
                }
                if (result?.receipt?.status !== 'complete') {item.status = 'merge-unknown'; throw new Error('找回结果尚未确认，请核对本次导入，不会重复创建聊天。');}
            } else {
                try {result = await api.backupApply(item.archive.id, {id: item.applyId, ...(item.targetBinding ? {targetBinding: item.targetBinding} : {}), ...(item.detach ? {detach: item.detach} : {})});}
                catch (error) {item.status = 'merge-unknown'; throw error;}
                if (result?.status === 'selection') {item.status = 'selection'; item.candidates = result.candidates || []; item.message = result.message; publish(); return;}
                if (result?.status !== 'complete') {item.status = 'merge-unknown'; throw new Error('合并结果尚未确认，请核对本次导入。');}
            }
            item.result = result; item.status = 'complete'; item.file = null;
            item.message = result.receipt ? `已另建聊天：${result.binding.file}；忆幕保持关闭。` : result.outcome === 'duplicate'
                ? `内容相同，已跳过：${result.binding.file}` : `已导入：${result.binding.file}${result.counts?.conflicts ? `；${result.counts.conflicts} 处差异已保留双方` : ''}${result.message ? `；${result.message}` : ''}`;
            if (state.snapshot && same(state.snapshot.binding, result.binding)) await refresh({auto: false});
        } catch (error) {
            if (['uploading','matching','restoring'].includes(item.status)) item.status = 'failed';
            item.error = error.message || '此备份尚未导入';
        }
        publish();
    }
    async function action(type, payload = {}) {
        if (!active() || view.busy) return false;
        view.busy = true; view.error = ''; view.status = ''; roles(); publish();
        try {
            if (type === 'backupQuickExport') {
                const snapshot = await host.snapshot(), plan = await api.backupPlan(snapshot.binding);
                const current = await host.snapshot();
                if (!same(snapshot.binding, current.binding)) throw new Error('当前聊天已变化，请重新导出');
                if (payload.includeOriginals && payload.planId && plan.planId !== payload.planId) throw new Error('来源清单已变化，请重新选择聊天原件');
                const sourceIds = payload.includeOriginals ? payload.sourceIds || [plan.primarySourceId] : [];
                if (sourceIds.some(sourceId => !plan.sources.some(source => source.id === sourceId && source.available))) throw new Error('所选聊天原件不可用，请重新选择');
                const result = await api.backupExport(snapshot.binding, {planId: plan.planId, sourceIds});
                if (active()) {await download(result); view.status = '备份已生成，已发起下载。';}
                return result;
            }
            if (type === 'backupExportFile') {
                // 管理页里按文件导出：不要求那个聊天正开着，也不要求它的聊天原件还在。
                const binding = payload.binding;
                if (!binding) throw new Error('没有可导出的记忆文件');
                const plan = await api.backupPlan(binding);
                const result = await api.backupExport(binding, {planId: plan.planId, sourceIds: []});
                if (active()) {await download(result); view.status = '备份已生成，已发起下载。';}
                return result;
            }
            if (type === 'backupExportPack') {
                // 管理页多选导出：每个聊天各出一份备份，再打成一个文件下载。
                const bindings = Array.isArray(payload.bindings) ? payload.bindings : [];
                if (!bindings.length) throw new Error('没有可导出的记忆文件');
                const results = [];
                for (const binding of bindings) { const plan = await api.backupPlan(binding); results.push(await api.backupExport(binding, {planId: plan.planId, sourceIds: []})); }
                const packed = results.length === 1 ? results[0] : packBackups(results);
                if (active()) {await download(packed); view.status = results.length === 1 ? '备份已生成，已发起下载。' : `${results.length} 份记忆已打包，已发起下载。`;}
                return packed;
            }
            if (type === 'backupImport' && Array.isArray(payload.files)) {
                // 记忆包先拆成一份份备份，再和单份备份一样处理。
                const files = [];
                for (const file of payload.files) {
                    if (!isBackupPack(file?.name)) { files.push(file); continue; }
                    try { files.push(...await unpackBackups(file)); }
                    catch (error) { view.items.push({id: id(), uploadId: id(), applyId: id(), file: null, name: file.name, status: 'failed', error: error.message}); }
                }
                payload = {...payload, files};
                const items = payload.files.map(file => ({id: id(), uploadId: id(), applyId: id(), file, name: file?.name || '未知文件', status: 'queued', error: ''}));
                view.items.push(...items); publish();
                for (const item of items) {
                    if (!active()) break;
                    if (!/\.yimu\.gz$/i.test(item.name) || typeof item.file?.stream !== 'function') {item.status = 'failed'; item.error = '仅支持忆幕自己的 .yimu.gz 备份或 .yimupack 记忆包'; publish(); continue;}
                    await processImport(item);
                }
                return {items};
            }
            if (['backupResolve','backupRetry','backupCancel'].includes(type)) {
                const item = view.items.find(value => value.id === payload.itemId);
                if (!item) throw new Error('找不到这次导入，请重新选择文件');
                if (type === 'backupCancel') {item.status = 'cancelled'; item.file = null; item.error = ''; item.message = '已取消关联；备份原件已保留，未写入聊天。'; publish(); return;}
                if (type === 'backupResolve') {
                    if (item.status !== 'selection') throw new Error('这份备份不需要选择目标');
                    if (payload.detach) {
                        // 作为独立记忆带入当前聊天：锚在这个聊天的首层，由服务端落成自定义切片。
                        const snapshot = await host.snapshot();
                        if (!snapshot?.binding || !snapshot.messages?.length) throw new Error('请先打开要带入记忆的聊天');
                        const hashes = await fingerprintMessages(snapshot.messages);
                        item.targetBinding = clone(snapshot.binding); item.detach = {placement: {fromFloor: 1, hash: hashes[0]}};
                    } else if (payload.targetBinding) {
                        const candidate = item.candidates.find(value => same(value.binding, payload.targetBinding));
                        if (!candidate) throw new Error('请选择此列表中的聊天');
                        item.targetBinding = clone(candidate.binding); item.detach = null;
                    } else if (payload.targetAvatar && item.archive.sources?.some(source => source.id === item.archive.primarySourceId && source.included)) {
                        if (!view.roles.some(role => role.avatar === payload.targetAvatar)) throw new Error('请选择当前账户角色');
                        item.restoreRequest = {id: id(), targetAvatar: payload.targetAvatar, sourceIds: item.archive.sources.filter(source => source.included).map(source => source.id)};
                    } else throw new Error('请选择聊天，或选择角色找回包内原件');
                }
                if (['complete','cancelled'].includes(item.status)) return item.result;
                await processImport(item); return item;
            }
            if (type === 'backupList') return await refreshList();
            if (type === 'backupRead') {
                const result = await readArchive(payload.archiveId);
                const found = await api.backupResult(payload.archiveId).catch(() => null);
                if (active() && found) setResult(payload.archiveId, found);
                return result;
            }
            if (type === 'backupPlan') {
                const snapshot = await host.snapshot();
                const result = await api.backupPlan(snapshot.binding);
                const current = await host.snapshot();
                if (!same(snapshot.binding, current.binding)) throw new Error('当前聊天已变化，请重新选择导出范围');
                if (active()) view.exportPlan = { ...result, binding: clone(snapshot.binding) };
                return result;
            }
            if (type === 'backupExport') {
                const plan = view.exportPlan;
                if (!plan) throw new Error('请先核对导出范围');
                const current = await host.snapshot();
                if (!same(current.binding, plan.binding)) throw new Error('当前聊天已变化，请重新选择导出范围');
                const sourceIds = payload.includeOriginals ? payload.sourceIds || [] : [];
                if (sourceIds.some(sourceId => !plan.sources.some(source => source.id === sourceId && source.available))) throw new Error('所选聊天原件不可用，请重新核对导出范围');
                const result = await api.backupExport(plan.binding, { planId: plan.planId, sourceIds });
                if (active()) { await download(result); view.status = sourceIds.length ? '备份包已生成，已发起下载。' : '记忆资料备份已生成，未附带聊天原件，已发起下载。'; }
                return result;
            }
            if (type === 'backupImport') {
                if (!upload) {
                    const file = payload.file;
                    if (!file || typeof file.name !== 'string' || !/\.yimu\.gz$/i.test(file.name) || typeof file.stream !== 'function') throw new Error('请选择忆幕自己的 .yimu.gz 备份包');
                    upload = { id: id(), file }; view.uploadPending = true;
                } else if (!payload.retry) throw new Error('上次上传结果尚未确认，请先核对本次上传');
                view.status = '正在上传并核对备份包…'; publish();
                let result;
                try { result = await api.backupUpload(upload.file, upload.id); }
                catch (error) {
                    const found = await api.backupUploadResult(upload.id).catch(() => null);
                    if (found?.status === 'complete' && found.archive) result = found;
                    else if (found?.status === 'failed') {
                        upload = null; view.uploadPending = false; view.uploadReset = (view.uploadReset || 0) + 1;
                        throw new Error(found.message || '此备份包已确认无法导入，请重新选择忆幕备份包');
                    }
                    else {
                        if (error.status >= 400 && error.status < 500 && found?.status === 'missing') { upload = null; view.uploadPending = false; view.uploadReset = (view.uploadReset || 0) + 1; }
                        throw error;
                    }
                }
                if (!result?.archive?.id) throw new Error('上传结果尚未确认，请核对本次上传');
                upload = null; view.uploadPending = false; view.uploadReset = (view.uploadReset || 0) + 1;
                if (active()) { putArchive(result.archive); await readArchive(result.archive.id); view.status = '备份包已导入为独立资料；未创建聊天，也未启用忆幕。'; }
                return result;
            }
            if (type === 'backupRestore') {
                const archive = view.selected;
                if (!archive) throw new Error('请先打开一份已导入资料');
                const saved = record(archive.id);
                if (saved.result) { showRecord(archive.id); return saved.result; }
                if (!saved.pending) {
                    if (payload.retry) throw new Error('没有需要继续核对的恢复操作');
                    if (!view.roles.some(role => role.avatar === payload.targetAvatar)) throw new Error('请明确选择一个当前账户内的角色');
                    const sourceIds = payload.sourceIds || [];
                    if (sourceIds.some(sourceId => !archive.sources.some(source => source.id === sourceId && source.included))) throw new Error('所选原件不在此备份包内');
                    let useCurrentBinding;
                    if (payload.useCurrent) {
                        const snapshot = await host.snapshot();
                        if (!same(snapshot.binding, payload.currentBinding)) throw new Error('当前聊天已变化，请重新确认匹配来源');
                        useCurrentBinding = clone(snapshot.binding);
                    }
                    if (!sourceIds.includes(archive.primarySourceId) && !useCurrentBinding) throw new Error('请选择包内主聊天原件，或明确使用当前聊天核对来源');
                    saved.pending = { id: id(), targetAvatar: payload.targetAvatar, sourceIds: [...sourceIds], ...(useCurrentBinding ? { useCurrentBinding } : {}) };
                    showRecord(archive.id);
                } else if (!payload.retry) throw new Error('上次恢复结果尚未确认，请先继续核对本次恢复');
                view.status = '正在核对来源并建立新副本…'; publish();
                let result;
                try { result = await api.backupRestore(archive.id, saved.pending); }
                catch (error) {
                    const found = await api.backupResult(archive.id, { id: saved.pending.id }).catch(() => null);
                    if (setResult(archive.id, found)) result = found;
                    else {
                        if (error.status >= 400 && error.status < 500 && found?.status === 'missing') { saved.pending = null; showRecord(archive.id); }
                        throw error;
                    }
                }
                if (!setResult(archive.id, result)) throw new Error('恢复结果尚未确认，请继续核对本次恢复；不会另建重复副本');
                if (active()) view.status = `已恢复为新聊天：${result.binding.file}。忆幕保持关闭，原聊天和原记忆未覆盖。`;
                return result;
            }
            if (type === 'backupOpen') {
                const result = view.selected && record(view.selected.id).result;
                if (!result) throw new Error('尚无已确认的恢复副本');
                const sourceSnapshot = await host.snapshot().catch(() => null);
                if (!sourceSnapshot || sourceSnapshot.binding.avatar !== result.binding.avatar) {
                    view.status = `副本已保留，请在所选角色的聊天记录中打开：${result.binding.file}`;
                    return { opened: false };
                }
                const stamp = lifecycle().generation;
                const opened = await host.openBackup(result, { sourceSnapshot, isCurrent: () => active() && !lifecycle().generating && lifecycle().generation === stamp });
                if (active()) view.status = opened.opened ? '已打开恢复副本，忆幕保持关闭。' : opened.message;
                if (opened.opened) await refresh({ auto: false });
                return opened;
            }
            throw new Error('未知的备份操作');
        } catch (error) { if (active()) view.error = error.message; throw error; }
        finally { view.busy = false; publish(); }
    }
    return { action, refreshList, destroy() { alive = false; upload = null; restores.clear(); } };
}
