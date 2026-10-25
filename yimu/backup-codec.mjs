import {Readable} from 'node:stream';
import {createGzip, createGunzip} from 'node:zlib';
import {createHash} from 'node:crypto';

export const BACKUP_FORMAT = 'yimu-backup';
export const BACKUP_FORMAT_VERSION = 1;
export const BACKUP_LIMITS = Object.freeze({headerBytes: 64 * 1024 * 1024, chunkBytes: 64 * 1024,
    compressedBytes: 2 * 1024 ** 3, expandedBytes: 8 * 1024 ** 3, sources: 256});
const hash = value => createHash('sha256').update(value).digest('hex');
const fail = message => {throw Object.assign(new Error(message), {code: 'yimu_backup_format', status: 400});};
const keys = (value, expected) => value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === expected.length && expected.every(key => Object.hasOwn(value, key));
const sourceId = id => typeof id === 'string' && /^source_(0|[1-9]\d{0,5})$/.test(id);
const checksum = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const record = value => Buffer.from(JSON.stringify(value) + '\n', 'utf8');

function headerSources(header) {
    if (!header || header.format !== BACKUP_FORMAT || header.version !== BACKUP_FORMAT_VERSION
        || !header.document || typeof header.document !== 'object' || !Array.isArray(header.sources)
        || !header.sources.length || header.sources.length > BACKUP_LIMITS.sources) fail('仅支持忆幕自身的备份格式和已支持版本');
    const ids = new Set();
    for (const source of header.sources) {
        if (!sourceId(source?.id) || ids.has(source.id) || typeof source.attached !== 'boolean') fail('备份来源清单无效或重复');
        ids.add(source.id);
    }
    return header.sources.filter(source => source.attached);
}

/** Native gzip wraps a small, strict framing format, not an arbitrary archive
 * extractor. Original JSONL bytes travel in bounded frames and are not parsed
 * or rewritten here. No member name ever becomes a filesystem path. */
export async function* encodeBackup({header, sources = []}) {
    const expected = headerSources(header), receipts = [];
    let expanded = 0;
    const frame = value => {
        const bytes = record(value); expanded += bytes.length;
        if (expanded > BACKUP_LIMITS.expandedBytes) fail('备份展开数据超过安全处理范围');
        return bytes;
    };
    async function* frames() {
        const first = frame({type: 'header', header});
        if (first.length > BACKUP_LIMITS.headerBytes) fail('记忆资料超过单包安全处理范围');
        yield first;
        let index = 0;
        for await (const source of sources) {
            const manifest = expected[index++];
            if (!manifest || source.id !== manifest.id || !source.stream) fail('备份原件与已选择的来源不一致');
            const digest = createHash('sha256'); let size = 0;
            for await (const input of source.stream) {
                if (!(input instanceof Uint8Array)) fail('备份原件不是字节流');
                for (let offset = 0; offset < input.byteLength; offset += BACKUP_LIMITS.chunkBytes) {
                    const bytes = Buffer.from(input.buffer, input.byteOffset + offset, Math.min(BACKUP_LIMITS.chunkBytes, input.byteLength - offset));
                    if (manifest.bytes != null && size + bytes.length > manifest.bytes) fail('打包期间聊天原件已变大，本次备份未完成');
                    digest.update(bytes);
                    yield frame({type: 'data', id: source.id, offset: size, data: bytes.toString('base64')});
                    size += bytes.length;
                }
            }
            const receipt = {id: source.id, bytes: size, sha256: digest.digest('hex')};
            if (manifest.bytes != null && manifest.bytes !== size || manifest.sha256 != null && manifest.sha256 !== receipt.sha256) fail('打包期间聊天原件已变化，本次备份未完成');
            receipts.push(receipt); yield frame({type: 'end-file', ...receipt});
        }
        if (index !== expected.length) fail('备份缺少已选择的聊天原件');
        yield frame({type: 'end', headerSha256: hash(JSON.stringify(header)), files: receipts});
    }
    const input = Readable.from(frames()), gzip = createGzip({level: 6});
    input.on('error', error => gzip.destroy(error)); input.pipe(gzip);
    let compressed = 0;
    try {
        for await (const chunk of gzip) {
            compressed += chunk.length;
            if (compressed > BACKUP_LIMITS.compressedBytes) fail('压缩备份超过安全处理范围');
            yield chunk;
        }
    } finally {input.destroy(); gzip.destroy();}
}

/** Hooks write only caller-owned staging data. A successful return, not an
 * early file event, confirms the entire package and gzip trailer were valid. */
export async function decodeBackup(stream, {validateHeader, onHeader, onFileStart, onFileChunk, onFileEnd} = {}) {
    let compressedBytes = 0, expandedBytes = 0, header = null, expected = [], index = 0, current = null, ended = false;
    let externalFailed = false, externalError;
    const trusted = async (hook, ...args) => {
        if (!hook) return;
        try { return await hook(...args); }
        catch (error) { externalFailed = true; externalError = error; throw error; }
    };
    const receipts = [], decoder = new TextDecoder('utf-8', {fatal: true});
    async function* incoming() {
        try {
            for await (const bytes of stream) {
                if (!(bytes instanceof Uint8Array)) fail('备份上传内容无效');
                compressedBytes += bytes.byteLength;
                if (compressedBytes > BACKUP_LIMITS.compressedBytes) fail('压缩备份超过安全处理范围');
                yield bytes;
            }
        } catch (error) {
            if (error?.code !== 'yimu_backup_format') {externalFailed = true; externalError = error;}
            throw error;
        }
    }
    async function accept(bytes) {
        if (ended) fail('备份结束标记之后仍有内容');
        let value;
        try {value = JSON.parse(decoder.decode(bytes));} catch {fail('备份记录无法完整读取');}
        // The own-format writer emits canonical JSON frames. Requiring that
        // exact representation rejects duplicate keys and ambiguous encodings
        // without a second permissive JSON parser or schema interpretation.
        if (!Buffer.from(JSON.stringify(value), 'utf8').equals(bytes)) fail('备份记录包含重复字段或非规范编码');
        if (!header) {
            if (!keys(value, ['type', 'header']) || value.type !== 'header') fail('这不是忆幕自身的备份包');
            expected = headerSources(value.header);
            await trusted(validateHeader, value.header);
            header = value.header; await trusted(onHeader, header); return;
        }
        if (value?.type === 'data') {
            if (!keys(value, ['type', 'id', 'offset', 'data']) || !sourceId(value.id) || expected[index]?.id !== value.id
                || typeof value.data !== 'string' || !value.data.length || value.data.length > Math.ceil(BACKUP_LIMITS.chunkBytes / 3) * 4
                || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value.data)) fail('备份原件分块无效或顺序不完整');
            if (!current) {current = {id: value.id, bytes: 0, hash: createHash('sha256')}; await trusted(onFileStart, value.id);}
            if (current.id !== value.id || value.offset !== current.bytes) fail('备份原件分块重复或缺失');
            const data = Buffer.from(value.data, 'base64');
            if (data.length > BACKUP_LIMITS.chunkBytes || data.toString('base64') !== value.data) fail('备份原件分块编码无效');
            if (expected[index].bytes != null && current.bytes + data.length > expected[index].bytes) fail('备份原件超过清单声明大小');
            current.hash.update(data); current.bytes += data.length;
            await trusted(onFileChunk, value.id, data); return;
        }
        if (value?.type === 'end-file') {
            if (!keys(value, ['type', 'id', 'bytes', 'sha256']) || expected[index]?.id !== value.id || !checksum(value.sha256)) fail('备份原件结束校验无效');
            if (!current) {current = {id: value.id, bytes: 0, hash: createHash('sha256')}; await trusted(onFileStart, value.id);}
            const receipt = {id: current.id, bytes: current.bytes, sha256: current.hash.digest('hex')}, manifest = expected[index];
            if (value.id !== receipt.id || value.bytes !== receipt.bytes || value.sha256 !== receipt.sha256
                || manifest.bytes != null && manifest.bytes !== receipt.bytes || manifest.sha256 != null && manifest.sha256 !== receipt.sha256) fail('备份原件长度或校验不一致');
            receipts.push(receipt); current = null; index++; await trusted(onFileEnd, receipt); return;
        }
        if (!keys(value, ['type', 'headerSha256', 'files']) || value.type !== 'end' || current || index !== expected.length
            || value.headerSha256 !== hash(JSON.stringify(header)) || !equal(value.files, receipts)) fail('备份包不完整或整体校验失败');
        ended = true;
    }
    const input = Readable.from(incoming()), gunzip = createGunzip();
    input.on('error', error => gunzip.destroy(error)); input.pipe(gunzip);
    let parts = [], length = 0;
    try {
        for await (const chunk of gunzip) {
            expandedBytes += chunk.length;
            if (expandedBytes > BACKUP_LIMITS.expandedBytes) fail('备份展开数据超过安全处理范围');
            let start = 0;
            while (start < chunk.length) {
                const newline = chunk.indexOf(10, start), end = newline < 0 ? chunk.length : newline;
                const part = chunk.subarray(start, end); length += part.length;
                if (length > (header ? 96 * 1024 : BACKUP_LIMITS.headerBytes)) fail('备份单条记录超过安全处理范围');
                if (part.length) parts.push(part);
                if (newline < 0) break;
                await accept(parts.length === 1 ? parts[0] : Buffer.concat(parts, length));
                parts = []; length = 0; start = newline + 1;
            }
        }
        if (length || !header || !ended || current || index !== expected.length) fail('备份包未完整结束，未导入');
        return {header, packageDigest: hash(JSON.stringify(header) + '\n' + JSON.stringify(receipts)), sourceReceipts: receipts, compressedBytes, expandedBytes};
    } catch (error) {
        if (externalFailed) throw externalError;
        if (error?.code === 'yimu_backup_format') throw error;
        // Preserve meaningful validation/storage failures raised by trusted hooks.
        if (Number.isInteger(error?.status)) throw error;
        fail('备份压缩数据损坏或上传中断，未导入');
    } finally {input.destroy(); gunzip.destroy();}
}
