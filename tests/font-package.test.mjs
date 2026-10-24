import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { BlobReader, BlobWriter, ZipReader, ZipWriter } from '../vendor/zip-js-2.24.0/index-native.min.js';
import { buildFontArchive, openFontArchive, FONT_ARCHIVE_METADATA_BYTES, FONT_ARCHIVE_CHUNK_BYTES } from '../qianmu-font-package.js';

const noWait = async () => {};
const local = (id = 'local-1') => ({ id, name: `字体 ${id}`, source: { kind: 'local', fileName: `${id}.ttf`, format: 'truetype' },
    faces: [{ urls: [], weight: '400', style: 'normal' }], tags: ['正文'] });
const web = (id = 'web-1') => ({ id, name: '网络字体', source: { kind: 'web', input: 'https://fonts.example/a.woff2' },
    faces: [{ urls: [{ url: 'https://fonts.example/a.woff2', format: 'woff2' }], weight: '400', style: 'normal' }] });
const sample = new Uint8Array(32);
new DataView(sample.buffer).setUint32(0, 0x00010000);
new DataView(sample.buffer).setUint16(4, 1);
new DataView(sample.buffer).setUint32(20, 28);
new DataView(sample.buffer).setUint32(24, 4);
const manifest = (fonts = [local()], originalSize = sample.length) => ({ type: 'qianmu-font-library', version: 2, fonts,
    previewText: '一蝶振翅，千幕万象。 AaBbCc123456', folders: ['正文'],
    localFiles: Object.fromEntries(fonts.filter(font => font.source.kind === 'local').map(font => [font.id, { path: `fonts/${font.id}.bin`, size: originalSize }])) });

async function archive(value = manifest(), extras = {}, options = {}) {
    const writer = new ZipWriter(new BlobWriter('application/zip'), { useWebWorkers: false, ...options });
    await writer.add('manifest.json', new BlobReader(new Blob([typeof value === 'string' ? value : JSON.stringify(value)])), { level: 0 });
    const entries = { 'fonts/local-1.bin': sample, ...extras };
    for (const [path, bytes] of Object.entries(entries)) if (bytes !== null) await writer.add(path, new BlobReader(new Blob([bytes])), { level: 0 });
    return writer.close();
}

function centralRecords(bytes) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), result = [];
    for (let cursor = 0; cursor <= bytes.length - 46; cursor += 1) {
        if (view.getUint32(cursor, true) !== 0x02014b50) continue;
        const nameLength = view.getUint16(cursor + 28, true);
        result.push({ offset: cursor, local: view.getUint32(cursor + 42, true),
            name: new TextDecoder().decode(bytes.subarray(cursor + 46, cursor + 46 + nameLength)) });
    }
    return result;
}

test('ZIP v2 round-trips mixed metadata and raw originals without base64; progress is per record', async () => {
    const input = [web(), local()], progress = [];
    const blob = await buildFontArchive(input, { readLocal: async id => { assert.equal(id, 'local-1'); return new Blob([sample]); },
        previewText: '一蝶振翅，千幕万象。 AaBbCc123456', folders: ['正文'], yieldTask: noWait, onProgress: value => progress.push(value) });
    assert.equal(blob.type, 'application/zip');
    const reader = new ZipReader(new BlobReader(blob), { useWebWorkers: false });
    const entries = await reader.getEntries();
    assert.deepEqual(entries.map(entry => entry.filename), ['fonts/local-1.bin', 'manifest.json']);
    assert.ok(entries.every(entry => entry.compressionMethod === 8));
    await reader.close();
    const unpacked = await openFontArchive(blob, { yieldTask: noWait });
    assert.deepEqual(unpacked.records, input);
    assert.equal(unpacked.previewText, '一蝶振翅，千幕万象。 AaBbCc123456');
    assert.deepEqual(unpacked.folders, ['正文']);
    assert.deepEqual(new Uint8Array(await (await unpacked.readLocal('local-1')).arrayBuffer()), sample);
    assert.deepEqual(progress, [{ done: 1, total: 2 }, { done: 2, total: 2 }]);
    await unpacked.close();
    await assert.rejects(unpacked.readLocal('local-1'), /已关闭/u);
});

test('metadata-only archives round-trip without reading local originals', async () => {
    const result = await openFontArchive(await buildFontArchive([web()], { readLocal: () => assert.fail('No local files'), yieldTask: noWait }), { yieldTask: noWait });
    assert.deepEqual(result.records, [web()]);
    await assert.rejects(result.readLocal('web-1'), /没有此字体/u);
    await result.close();
});

test('export/import exceeds the former 96 MiB product ceiling with bounded chunk yields', { timeout: 30000 }, async () => {
    const chunk = new Uint8Array(1024 * 1024).fill(65), original = new Blob([sample, ...Array.from({ length: 100 }, () => chunk)]);
    let ticks = 0;
    const blob = await buildFontArchive([local()], { readLocal: async () => original, yieldTask: async () => { ticks++; } });
    assert.ok(blob.size < original.size / 20, 'ZIP must really compress the binary');
    assert.ok(ticks >= original.size / FONT_ARCHIVE_CHUNK_BYTES, 'large files yield throughout compression');
    const result = await openFontArchive(blob, { yieldTask: noWait });
    assert.equal((await result.readLocal('local-1')).size, original.size);
    await result.close();
});

test('forced ZIP64 archives are accepted without a 4 GiB-format assumption', async () => {
    const blob = await archive(manifest(), {}, { zip64: true });
    const bytes = new Uint8Array(await blob.arrayBuffer());
    assert.ok(bytes.some((_, i) => i < bytes.length - 3 && bytes[i] === 0x50 && bytes[i + 1] === 0x4b && bytes[i + 2] === 0x06 && bytes[i + 3] === 0x06));
    const result = await openFontArchive(blob, { yieldTask: noWait });
    assert.deepEqual(new Uint8Array(await (await result.readLocal('local-1')).arrayBuffer()), sample);
    await result.close();
});

test('guard cancellation interrupts an in-progress original and prevents reading the next font', async () => {
    let ticks = 0, reads = 0;
    await assert.rejects(buildFontArchive([local(), local('second')], { readLocal: async () => { reads++; return new Blob([sample, new Uint8Array(FONT_ARCHIVE_CHUNK_BYTES * 4)]); },
        guard: () => { if (ticks > 4) throw new Error('owner changed'); }, yieldTask: async () => { ticks++; } }), /owner changed/u);
    assert.equal(reads, 1);
});

test('export rejects missing, truncated and format-mismatched originals instead of writing unreadable backups', async () => {
    await assert.rejects(buildFontArchive([local()], { readLocal: async () => null, yieldTask: noWait }), /缺少.*local-1.*原件/u);
    await assert.rejects(buildFontArchive([local()], { readLocal: async () => new Blob(['not a font at all']), yieldTask: noWait }), /仅支持/u);
    const mismatch = local(); mismatch.source.format = 'woff';
    await assert.rejects(buildFontArchive([mismatch], { readLocal: async () => new Blob([sample]), yieldTask: noWait }), /不匹配/u);
    const truncated = { size: sample.length, arrayBuffer: async () => sample.buffer, slice: (start, end) => new Blob([sample.subarray(start, end - 1)]) };
    await assert.rejects(buildFontArchive([local()], { readLocal: async () => truncated, yieldTask: noWait }), /读取不完整/u);
    const badTable = sample.slice(); new DataView(badTable.buffer).setUint32(20, 1000);
    await assert.rejects(buildFontArchive([local()], { readLocal: async () => new Blob([badTable]), yieldTask: noWait }), /超出边界/u);
    const missingTable = sample.slice(); new DataView(missingTable.buffer).setUint16(4, 2);
    await assert.rejects(buildFontArchive([local()], { readLocal: async () => new Blob([missingTable]), yieldTask: noWait }), /表不完整/u);
});

test('export validates header/table bounds without reading or allocating the entire font at once', async () => {
    const blob = new Blob([sample, new Uint8Array(FONT_ARCHIVE_CHUNK_BYTES * 3)]);
    const lengths = [], boundedBlob = { size: blob.size, arrayBuffer: () => assert.fail('Whole original allocation is forbidden'),
        slice(start, end) { lengths.push(end - start); return blob.slice(start, end); } };
    await buildFontArchive([local()], { readLocal: async () => boundedBlob, yieldTask: noWait });
    assert.ok(lengths.every(length => length <= FONT_ARCHIVE_CHUNK_BYTES));
    assert.ok(lengths.length > 3);
});

test('unsafe ZIP paths and duplicate entries fail even when the manifest itself is valid', async () => {
    const unsafe = new Uint8Array(await (await archive()).arrayBuffer());
    const font = centralRecords(unsafe).find(record => record.name === 'fonts/local-1.bin');
    const name = new TextEncoder().encode('../escape0000.bin');
    assert.equal(name.length, font.name.length);
    unsafe.set(name, font.offset + 46); unsafe.set(name, font.local + 30);
    await assert.rejects(openFontArchive(new Blob([unsafe]), { yieldTask: noWait }));
    const duplicated = new Uint8Array(await (await archive(manifest([local(), local('local-2')]), { 'fonts/local-2.bin': sample })).arrayBuffer());
    const second = centralRecords(duplicated).find(record => record.name === 'fonts/local-2.bin');
    const firstName = new TextEncoder().encode('fonts/local-1.bin');
    duplicated.set(firstName, second.offset + 46); duplicated.set(firstName, second.local + 30);
    await assert.rejects(openFontArchive(new Blob([duplicated]), { yieldTask: noWait }), /duplicate|重复|ambiguous/i);
});

test('closing an archive while an original is reading cancels exposure of its partial Blob', async () => {
    const original = new Blob([sample, new Uint8Array(FONT_ARCHIVE_CHUNK_BYTES * 3)]);
    const blob = await buildFontArchive([local()], { readLocal: async () => original, yieldTask: noWait });
    let block = false, release;
    const result = await openFontArchive(blob, { yieldTask: async () => { if (block) { block = false; await new Promise(resolve => { release = resolve; }); } } });
    block = true;
    const pending = result.readLocal('local-1');
    while (!release) await new Promise(resolve => setTimeout(resolve, 0));
    await result.close(); release();
    await assert.rejects(pending, /已关闭/u);
});

test('font bodies are lazy and CRC corruption fails before returning a Blob', async () => {
    const bytes = new Uint8Array(await (await archive()).arrayBuffer()), view = new DataView(bytes.buffer);
    const font = centralRecords(bytes).find(record => record.name === 'fonts/local-1.bin');
    const start = font.local + 30 + view.getUint16(font.local + 26, true) + view.getUint16(font.local + 28, true);
    bytes[start] ^= 1;
    const result = await openFontArchive(new Blob([bytes]), { yieldTask: noWait });
    assert.equal(result.records.length, 1, 'opening validates structure but does not inflate all fonts');
    await assert.rejects(result.readLocal('local-1'), /CRC|signature|check/i);
    await result.close();
});

test('all local headers are validated before import can write the first font', async () => {
    const bytes = new Uint8Array(await (await archive()).arrayBuffer());
    const font = centralRecords(bytes).find(record => record.name === 'fonts/local-1.bin');
    bytes[font.local + 30] = 120;
    await assert.rejects(openFontArchive(new Blob([bytes]), { yieldTask: noWait }), /ambiguous|header|filename/i);
});

test('oversized expanded payloads cannot exceed the declared size', async () => {
    const value = manifest([local()], 1);
    const bytes = new Uint8Array(await (await archive(value, {}, { bufferedWrite: true, dataDescriptor: false })).arrayBuffer());
    const view = new DataView(bytes.buffer), font = centralRecords(bytes).find(record => record.name === 'fonts/local-1.bin');
    view.setUint32(font.offset + 24, 1, true); view.setUint32(font.local + 22, 1, true);
    const result = await openFontArchive(new Blob([bytes]), { yieldTask: noWait });
    await assert.rejects(result.readLocal('local-1'), /size|大小/i);
    await result.close();
});

test('encrypted entries are rejected without requesting a password', async () => {
    await assert.rejects(openFontArchive(await archive(manifest(), {}, { password: 'test-only', zipCrypto: true }), { yieldTask: noWait }), /不支持/u);
});

for (const [label, mutate] of [
    ['missing originals', async () => archive(manifest(), { 'fonts/local-1.bin': null })],
    ['undeclared originals', async () => archive(manifest(), { 'fonts/extra.bin': sample })],
    ['unsafe paths', async () => archive(manifest(), { '../escape': sample }, { filenameValidation: 'tolerant' })],
    ['invalid source metadata', async () => { const value = manifest(); value.fonts[0].name = ''; return archive(value); }],
    ['mismatched sizes', async () => archive(manifest([local()], 1))],
    ['non-finite sizes', async () => { const value = manifest(); value.localFiles['local-1'].size = 'Infinity'; return archive(value); }],
    ['unsafe JSON fields', async () => archive('{"type":"qianmu-font-library","version":2,"__proto__":{}}')],
    ['wrong schema', async () => { const value = manifest(); value.version = 1; return archive(value); }],
    ['duplicate metadata IDs', async () => archive(manifest([local(), local()]))],
    ['oversized manifest', async () => archive(' '.repeat(FONT_ARCHIVE_METADATA_BYTES + 1))],
]) test(`archive rejects ${label} before exposing the import handle`, async () => {
    await assert.rejects(async () => openFontArchive(await mutate(), { yieldTask: noWait }));
});

test('directory-entry limits reject oversized directories before reading/decompressing metadata', async () => {
    const bytes = new Uint8Array(await (await archive()).arrayBuffer()), view = new DataView(bytes.buffer);
    view.setUint16(bytes.length - 22 + 8, 202, true); view.setUint16(bytes.length - 22 + 10, 202, true);
    await assert.rejects(openFontArchive(new Blob([bytes]), { yieldTask: noWait }), /目录数量/u);
});

test('bundled JavaScript codec works offline without native compression or Worker support', () => {
    const script = `globalThis.CompressionStream=undefined;globalThis.DecompressionStream=undefined;globalThis.Worker=undefined;globalThis.fetch=()=>{throw new Error('network forbidden');};
        const {buildFontArchive,openFontArchive}=await import('./qianmu-font-package.js');
        const font=${JSON.stringify(local())};const bytes=new Uint8Array(10000).fill(42);bytes.set(${JSON.stringify([...sample])});
        const blob=await buildFontArchive([font],{readLocal:async()=>new Blob([bytes]),yieldTask:async()=>{}});
        if(blob.size>=bytes.length)throw new Error('not compressed');
        const result=await openFontArchive(blob,{yieldTask:async()=>{}});
        const data=new Uint8Array(await(await result.readLocal('local-1')).arrayBuffer());
        if(data.length!==bytes.length||data[9999]!==42)throw new Error('bad fallback');
        await result.close();console.log('fallback verified');`;
    const output = execFileSync(process.execPath, ['--input-type=module', '-e', script], { cwd: new URL('..', import.meta.url), encoding: 'utf8' });
    assert.match(output, /fallback verified/u);
});

test('vendor bundle and license match pinned unmodified upstream SHA-256', async () => {
    const descriptor = JSON.parse(await readFile(new URL('../vendor/zip-js-2.24.0/VENDOR.json', import.meta.url), 'utf8'));
    assert.equal(descriptor.version, '2.24.0');
    for (const [name, expected] of Object.entries(descriptor.files)) {
        const bytes = await readFile(new URL(`../vendor/zip-js-2.24.0/${name}`, import.meta.url));
        assert.equal(bytes.length, expected.bytes); assert.equal(createHash('sha256').update(bytes).digest('hex'), expected.sha256);
    }
});
