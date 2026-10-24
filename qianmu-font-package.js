/** Font ZIP v2: metadata is validated before writes; local originals are read one at a time. */
import { Reader, Writer, ZipReader, ZipWriter } from './vendor/zip-js-2.24.0/index-native.min.js';
import { FONT_SOURCE_LIMITS, validateFontPackMetadata, validateLocalFontHeader } from './qianmu-font-sources.js?v=1.59.482-font-progress-2';

export const FONT_ARCHIVE_MANIFEST = 'manifest.json';
export const FONT_ARCHIVE_METADATA_BYTES = 8 * 1024 * 1024;
export const FONT_ARCHIVE_CHUNK_BYTES = 256 * 1024;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const unsafeKeys = new Set(['__proto__', 'constructor', 'prototype']);
const pause = () => new Promise((resolve) => setTimeout(resolve, 0));
const fail = (message) => { throw new Error(message); };
const plain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const size = (value) => Number.isSafeInteger(value) && value >= 0;
const fontPath = (id) => `fonts/${id}.bin`;

function scope(options = {}) {
    let closed = false;
    const check = () => { if (closed) fail('字体包已关闭'); options.guard?.(); };
    return { check, close() { closed = true; }, async tick() { check(); await (options.yieldTask || pause)(); check(); } };
}

/** Avoid BlobReader's direct stream optimization so every bounded input chunk yields and checks ownership. */
class FontBlobReader extends Reader {
    constructor(blob, context) { super(); this.blob = blob; this.size = blob.size; this.context = context; }
    createReadable(options = {}) { return super.createReadable({ ...options, chunkSize: FONT_ARCHIVE_CHUNK_BYTES }); }
    async readUint8Array(offset, length) {
        this.context.check();
        if (!size(offset) || !size(length) || offset > this.size) fail('字体包读取范围不正确');
        const end = Math.min(this.size, offset + length);
        const bytes = new Uint8Array(end - offset);
        for (let cursor = offset; cursor < end; cursor += FONT_ARCHIVE_CHUNK_BYTES) {
            await this.context.tick();
            const chunkEnd = Math.min(end, cursor + FONT_ARCHIVE_CHUNK_BYTES);
            const chunk = new Uint8Array(await this.blob.slice(cursor, chunkEnd).arrayBuffer());
            if (chunk.byteLength !== chunkEnd - cursor) fail('字体文件读取不完整，未导出不完整备份');
            bytes.set(chunk, cursor - offset);
            this.context.check();
        }
        return bytes;
    }
}

/** Keep compressed Blob parts instead of a whole-archive string or base64/ArrayBuffer copy. */
class FontBlobWriter extends Writer {
    constructor(context, limit = Number.MAX_SAFE_INTEGER, type = 'application/octet-stream') {
        super(); this.context = context; this.limit = limit; this.type = type; this.parts = []; this.length = 0;
    }
    async writeUint8Array(bytes) {
        this.context.check();
        if (!size(bytes?.byteLength) || bytes.byteLength > this.limit - this.length) fail('字体包解压大小与清单不一致');
        for (let offset = 0; offset < bytes.byteLength; offset += FONT_ARCHIVE_CHUNK_BYTES) {
            await this.context.tick();
            // Blob takes an immutable copy, including when a codec reuses its output buffer.
            const chunk = new Blob([bytes.subarray(offset, offset + FONT_ARCHIVE_CHUNK_BYTES)]);
            this.parts.push(chunk); this.length += chunk.size;
        }
    }
    getData() { this.context.check(); return new Blob(this.parts, { type: this.type }); }
    discard() { this.parts.length = 0; }
}

function requireBlob(blob) {
    if (!blob || !size(blob.size) || typeof blob.slice !== 'function' || typeof blob.arrayBuffer !== 'function') fail('请选择有效的字体包或字体文件');
}

function manifestBytes(metadata, localFiles) {
    const bytes = encoder.encode(JSON.stringify({ type: 'qianmu-font-library', version: 2, fonts: metadata.records,
        previewText: metadata.previewText, folders: metadata.folders, localFiles }));
    if (bytes.byteLength > FONT_ARCHIVE_METADATA_BYTES) fail('字体包目录资料过大');
    return bytes;
}

async function validateOriginal(reader, expectedFormat) {
    let header = await reader.readUint8Array(0, Math.min(reader.size, 48));
    if (header.length >= 16) {
        const view = new DataView(header.buffer), magic = view.getUint32(0);
        const directoryLength = magic === 0x774f4646 ? 44 + view.getUint16(12) * 20
            : [0x00010000, 0x4f54544f, 0x74727565].includes(magic) ? 12 + view.getUint16(4) * 16 : 0;
        if (directoryLength > header.length) header = await reader.readUint8Array(0, Math.min(reader.size, directoryLength));
    }
    if (validateLocalFontHeader(header, reader.size).format !== expectedFormat) fail('本地字体文件与资料不匹配');
}

export async function buildFontArchive(records, options = {}) {
    const context = scope(options), metadata = validateFontPackMetadata(records, options);
    const output = new FontBlobWriter(context, Number.MAX_SAFE_INTEGER, 'application/zip');
    const zip = new ZipWriter(output, { useWebWorkers: false, bufferedWrite: false });
    const localFiles = Object.create(null);
    let done = 0;
    try {
        // Fail oversized metadata before reading/compressing originals.
        manifestBytes(metadata, localFiles);
        for (const record of metadata.records) {
            await context.tick();
            if (record.source.kind === 'local') {
                if (typeof options.readLocal !== 'function') fail('缺少本地字体原件');
                const blob = await options.readLocal(record.id); context.check();
                if (!blob) fail(`本机缺少「${record.name}」原件，未导出不完整备份`);
                requireBlob(blob);
                if (!blob.size) fail('本地字体原件为空');
                const originalReader = new FontBlobReader(blob, context);
                await validateOriginal(originalReader, record.source.format);
                const path = fontPath(record.id);
                localFiles[record.id] = { path, size: blob.size };
                await zip.add(path, originalReader);
            }
            options.onProgress?.({ done: ++done, total: metadata.records.length });
        }
        const manifest = new Blob([manifestBytes(metadata, localFiles)], { type: 'application/json' });
        await zip.add(FONT_ARCHIVE_MANIFEST, new FontBlobReader(manifest, context));
        const blob = await zip.close(); context.check(); output.discard(); context.close();
        return blob;
    } catch (error) {
        try { await zip.close(); } catch { /* No workers or external handles remain. */ }
        output.discard(); context.close(); throw error;
    }
}

function uint64(view, offset) {
    const value = view.getBigUint64(offset, true);
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) fail('字体包大小超出当前浏览器可读取范围');
    return Number(value);
}

/** Bound the directory before zip.js allocates/parses it. Font payloads have no product byte ceiling. */
async function preflightDirectory(input, context) {
    if (input.size < 22) fail('字体包 ZIP 目录不完整');
    const tailStart = Math.max(0, input.size - 65557), tail = await input.readUint8Array(tailStart, input.size - tailStart);
    const view = new DataView(tail.buffer); let relative = -1;
    for (let cursor = tail.length - 22; cursor >= 0; cursor -= 1) {
        if (view.getUint32(cursor, true) === 0x06054b50 && cursor + 22 + view.getUint16(cursor + 20, true) === tail.length) { relative = cursor; break; }
    }
    if (relative < 0) fail('字体包 ZIP 目录不完整');
    const end = tailStart + relative;
    const disk = view.getUint16(relative + 4, true), directoryDisk = view.getUint16(relative + 6, true);
    if (![0, 0xffff].includes(disk) || ![0, 0xffff].includes(directoryDisk)) fail('不支持分卷字体包');
    let count = view.getUint16(relative + 10, true), directoryBytes = view.getUint32(relative + 12, true), directoryOffset = view.getUint32(relative + 16, true);
    if (view.getUint16(relative + 8, true) !== count) fail('字体包 ZIP 目录不一致');
    let directoryEnd = end;
    if (disk === 0xffff || directoryDisk === 0xffff || count === 0xffff || directoryBytes === 0xffffffff || directoryOffset === 0xffffffff) {
        if (end < 20) fail('字体包 ZIP64 目录不完整');
        const locatorBytes = await input.readUint8Array(end - 20, 20), locator = new DataView(locatorBytes.buffer);
        if (locator.getUint32(0, true) !== 0x07064b50 || locator.getUint32(4, true) || locator.getUint32(16, true) !== 1) fail('字体包 ZIP64 目录不正确');
        const position = uint64(locator, 8);
        if (position > end - 76) fail('字体包 ZIP64 目录不完整');
        const recordBytes = await input.readUint8Array(position, 56), record = new DataView(recordBytes.buffer);
        const recordSize = uint64(record, 4);
        if (record.getUint32(0, true) !== 0x06064b50 || recordSize < 44 || recordSize > FONT_ARCHIVE_METADATA_BYTES
            || position + 12 + recordSize !== end - 20 || record.getUint32(16, true) || record.getUint32(20, true)) fail('字体包 ZIP64 目录不正确');
        count = uint64(record, 32); directoryBytes = uint64(record, 40); directoryOffset = uint64(record, 48); directoryEnd = position;
        if (uint64(record, 24) !== count) fail('字体包 ZIP64 目录不一致');
    }
    if (count < 1 || count > FONT_SOURCE_LIMITS.records + 1 || directoryBytes > FONT_ARCHIVE_METADATA_BYTES
        || directoryOffset > directoryEnd || directoryBytes !== directoryEnd - directoryOffset) fail('字体包 ZIP 目录数量或大小不正确');
    context.check();
    return count;
}

async function entryBlob(entry, context, limit) {
    const output = new FontBlobWriter(context, limit);
    try {
        const blob = await entry.getData(output, { checkCrc32: true, useWebWorkers: false });
        context.check();
        if (blob.size !== limit) fail('字体包文件大小与清单不一致');
        return blob;
    } finally { output.discard(); }
}

export async function openFontArchive(file, options = {}) {
    requireBlob(file);
    const context = scope(options), input = new FontBlobReader(file, context);
    let reader;
    try {
        const count = await preflightDirectory(input, context);
        reader = new ZipReader(input, { useWebWorkers: false, strictness: 'strict', checkCrc32: true });
        const entries = new Map();
        for await (const entry of reader.getEntriesGenerator()) {
            await context.tick();
            if (entries.size >= count || entries.has(entry.filename) || entry.directory || entry.encrypted
                || !size(entry.uncompressedSize) || !size(entry.compressedSize)
                || ![0, 8].includes(entry.compressionMethod)
                || !(entry.filename === FONT_ARCHIVE_MANIFEST || /^fonts\/[A-Za-z0-9_-]+\.bin$/u.test(entry.filename))) fail('字体包包含不支持或重复的文件');
            entries.set(entry.filename, entry);
        }
        if (entries.size !== count) fail('字体包 ZIP 目录数量不一致');
        // Validate every local header and data range before any original can be handed to the importer.
        for (const entry of entries.values()) {
            await context.tick();
            await entry.getData(undefined, { checkOverlappingEntryOnly: true, useWebWorkers: false });
        }
        const manifestEntry = entries.get(FONT_ARCHIVE_MANIFEST);
        if (!manifestEntry || manifestEntry.uncompressedSize > FONT_ARCHIVE_METADATA_BYTES) fail('字体包缺少有效清单或清单过大');
        const manifestBlob = await entryBlob(manifestEntry, context, manifestEntry.uncompressedSize);
        let manifest;
        try {
            manifest = JSON.parse(decoder.decode(await manifestBlob.arrayBuffer()), (key, value) => {
                if (unsafeKeys.has(key)) fail('字体包包含不安全的字段');
                return value;
            });
        } catch { fail('字体包清单格式不正确'); }
        if (!plain(manifest) || manifest.type !== 'qianmu-font-library' || manifest.version !== 2 || !plain(manifest.localFiles)) fail('不是支持的千幕字体压缩包');
        const metadata = validateFontPackMetadata(manifest.fonts, manifest);
        const localRecords = metadata.records.filter((record) => record.source.kind === 'local');
        if (Object.keys(manifest.localFiles).length !== localRecords.length || entries.size !== localRecords.length + 1) fail('字体包原件与清单不一致');
        const originals = new Map();
        for (const record of localRecords) {
            const declared = manifest.localFiles[record.id], path = fontPath(record.id), entry = entries.get(path);
            if (!plain(declared) || declared.path !== path || !size(declared.size) || declared.size < 1 || !entry
                || declared.size !== entry.uncompressedSize) fail('字体包原件缺失或大小与清单不一致');
            originals.set(record.id, entry);
        }
        let reading = false;
        return { ...metadata,
            async readLocal(id) {
                context.check();
                const entry = originals.get(id);
                if (!entry) fail('字体包中没有此字体原件');
                if (reading) fail('请等待当前字体原件读取完成');
                reading = true;
                try { return await entryBlob(entry, context, entry.uncompressedSize); }
                finally { reading = false; }
            },
            async close() { context.close(); originals.clear(); entries.clear(); await reader.close(); },
        };
    } catch (error) {
        context.close();
        if (reader) try { await reader.close(); } catch { /* Keep the original validation error. */ }
        throw error;
    }
}
