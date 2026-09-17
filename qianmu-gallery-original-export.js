import { projectGalleryCatalogEntry, galleryCatalogAccount } from './qianmu-gallery-catalog-contract.js';
import { buildOriginalImageZip, ORIGINAL_IMAGE_EXPORT_BYTES } from './qianmu-original-image-zip.js';

export const ORIGINAL_IMAGE_EXPORT_COUNT = 100;
// A files-only consumer of verified originals, not a QMB restore format or whole-chat backup.
export async function exportGalleryOriginals({ namespace, rows, target, headers, guard, parentSignal, signal,
    createHistoricalClient, createRecordClient, loadImage, save, onProgress = () => {}, timeoutMs = 600000 } = {}) {
    namespace = galleryCatalogAccount(namespace);
    if (!Array.isArray(rows) || !rows.length || rows.length > ORIGINAL_IMAGE_EXPORT_COUNT || typeof save !== 'function') throw Error('请选 1 至 100 张同一聊天的原图');
    const selected = Array.from(rows, row => {
        if (!row || row.namespace !== namespace || row.kind !== 'still') throw Error('所选原图属于另一账户或不支持此类型');
        return projectGalleryCatalogEntry(namespace, { ownerKey: row.ownerKey, chatKey: row.chatKey }, { id: row.recordId, createdAt: row.createdAt, tags: row.tags, kind: 'still' });
    });
    const source = { ownerKey: selected[0].ownerKey, chatKey: selected[0].chatKey };
    if (new Set(selected.map(row => row.recordId)).size !== selected.length || selected.some(row => row.ownerKey !== source.ownerKey || row.chatKey !== source.chatKey)) throw Error('本次须选择同一聊天的不同原图，不合并同名角色或聊天');
    const controller = new AbortController(), readers = new Set(); let rejectCancellation;
    const cancellation = new Promise((_, reject) => rejectCancellation = reject);
    const closeReaders = () => { for (const reader of readers) { readers.delete(reader); reader.close(); } };
    const abort = () => { controller.abort(); closeReaders(); rejectCancellation(Error('原图批量导出已取消或超时，未下载缺件包')); };
    const check = async () => { if (controller.signal.aborted) throw Error('原图批量导出已取消'); await guard(); if (controller.signal.aborted) throw Error('原图批量导出已取消'); };
    const signals = [parentSignal, signal].filter(Boolean); for (const item of signals) item.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort, Math.max(100, Math.min(600000, Number(timeoutMs) || 600000)));
    try {
        if (signals.some(item => item.aborted)) abort();
        return await Promise.race([(async () => {
            await check();
            const options = { namespace, target: target(source), headers, guard: check };
            const receiptReader = createHistoricalClient(options); readers.add(receiptReader);
            const recordReader = createRecordClient(options); readers.add(recordReader);
            const receipt = await receiptReader.inspect({ signal: controller.signal }); await check();
            if (receipt.state !== 'present') throw Error('原聊天没有静帧记录，未导出空包');
            const files = [], images = []; let bytes = 0;
            for (const row of selected) {
                await check(); onProgress({ phase: 'reading', completed: images.length, total: selected.length });
                const result = await recordReader.read({ recordId: row.recordId, createdAt: row.createdAt, gallerySha256: receipt.gallery.sha256 }, { signal: controller.signal }); await check();
                if (result.record.id !== row.recordId || result.record.createdAt !== row.createdAt) throw Error('来源返回了另一张画面，未导出');
                const media = await loadImage(result.record.url, { guard: check, signal: controller.signal }); await check();
                const extension = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' }[media.blob?.type];
                if (!(media.blob instanceof Blob) || typeof extension !== 'string' || !Number.isSafeInteger(media.blob.size) || media.blob.size < 1 || media.blob.size > 24 * 1048576) throw Error('原图格式或大小不完整，未输出缺件包');
                bytes += media.blob.size; if (bytes > ORIGINAL_IMAGE_EXPORT_BYTES) throw Error('所选原图超过 128 MiB，请减少选择后重试');
                const name = `images/${String(images.length + 1).padStart(3, '0')}.${extension}`;
                files.push({ name, blob: media.blob });
                images.push({ file: name, recordId: result.record.id, createdAt: result.record.createdAt, tags: result.record.tags, bytes: media.blob.size });
            }
            await check(); onProgress({ phase: 'packing', completed: images.length, total: selected.length });
            const manifest = { type: 'qianmu-original-images', version: 1, exportedAt: new Date().toISOString(), scope: 'selected-catalog-stills', source, images,
                note: '仅含本次明确选择并读取的原图及来源清单，不代表全部聊天、永久归属或可恢复的千幕联包。原图自带元数据保留。' };
            const archive = await buildOriginalImageZip([
                { name: 'source.json', blob: new Blob([JSON.stringify(manifest, null, 2)], { type: 'application/json' }) },
                { name: 'README.txt', blob: new Blob(['千幕原图导出\n仅导出所选目录条目当前可读取的图片，非全部聊天备份，不可作为千幕联包恢复。\nsource.json 包含角色文件/群组、聊天名、画面编号、生成时间和标签。图片自带元数据原样保留，可能含生成参数，分享前请检查。\n原聊天、原图及目录未因导出而被修改或清理。\n'], { type: 'text/plain' }) },
                ...files,
            ], { guard: check }); await check();
            const after = await receiptReader.inspect({ signal: controller.signal }); await check();
            if (after.state !== 'present' || after.gallery.sha256 !== receipt.gallery.sha256) throw Error('打包期间原聊天静帧已变化，请重新导出');
            const filename = `qianmu-originals-selected-${images.length}-${Date.now()}.zip`;
            await save(archive, filename); return { filename, count: images.length, bytes: archive.size };
        })(), cancellation]);
    } finally { clearTimeout(timer); for (const item of signals) item.removeEventListener('abort', abort); controller.abort(); closeReaders(); }
}
