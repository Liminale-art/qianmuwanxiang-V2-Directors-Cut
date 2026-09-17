// Plain ZIP, stored entries only: PKWARE APPNOTE 4.3.7/4.3.12/4.3.16.
// https://pkware.cachefly.net/webdocs/casestudies/APPNOTE.TXT
// No archive reader, compression, encryption, executable entries or arbitrary paths.
export const ORIGINAL_IMAGE_EXPORT_BYTES = 128 * 1048576;
const table = Uint32Array.from({ length: 256 }, (_, n) => {
    for (let bit = 0; bit < 8; bit++) n = (n >>> 1) ^ (n & 1 ? 0xedb88320 : 0);
    return n >>> 0;
});
const fail = message => { throw Error(message); };
export async function buildOriginalImageZip(entries, { guard = async () => {}, yieldTask = () => new Promise(resolve => setTimeout(resolve, 0)) } = {}) {
    if (!Array.isArray(entries) || !entries.length || entries.length > 102) fail('原图压缩包条目数量无效');
    const names = new Set(); let total = 22;
    const files = Array.from(entries, row => {
        if (!row || typeof row.name !== 'string' || !/^(?:images\/[0-9]{3}\.(?:png|jpg|webp)|source\.json|README\.txt)$/.test(row.name)
            || names.has(row.name) || !(row.blob instanceof Blob) || !Number.isSafeInteger(row.blob.size) || row.blob.size < 1) fail('原图压缩包文件名或内容无效');
        names.add(row.name); const name = new TextEncoder().encode(row.name);
        total += 76 + name.length * 2 + row.blob.size;
        return { name, blob: row.blob };
    });
    if (total > ORIGINAL_IMAGE_EXPORT_BYTES) fail('所选原图压缩包超过 128 MiB，请减少选择后重试');
    await guard(); const parts = [], central = []; let offset = 0, centralBytes = 0;
    const date = new Date(), year = Math.max(1980, Math.min(2107, date.getFullYear()));
    const dosDate = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
    const dosTime = (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >>> 1);
    for (const { name, blob } of files) {
        let crc = 0xffffffff;
        for (let at = 0; at < blob.size; at += 524288) {
            await guard(); const bytes = new Uint8Array(await blob.slice(at, at + 524288).arrayBuffer()); await guard();
            for (const byte of bytes) crc = table[(crc ^ byte) & 255] ^ (crc >>> 8);
            await yieldTask(); await guard();
        }
        crc = (crc ^ 0xffffffff) >>> 0;
        const local = new Uint8Array(30 + name.length), l = new DataView(local.buffer);
        l.setUint32(0, 0x04034b50, true); l.setUint16(4, 20, true); l.setUint16(6, 0x800, true);
        l.setUint16(10, dosTime, true); l.setUint16(12, dosDate, true); l.setUint32(14, crc, true);
        l.setUint32(18, blob.size, true); l.setUint32(22, blob.size, true); l.setUint16(26, name.length, true); local.set(name, 30);
        const directory = new Uint8Array(46 + name.length), d = new DataView(directory.buffer);
        d.setUint32(0, 0x02014b50, true); d.setUint16(4, 20, true); d.setUint16(6, 20, true); d.setUint16(8, 0x800, true);
        d.setUint16(12, dosTime, true); d.setUint16(14, dosDate, true); d.setUint32(16, crc, true);
        d.setUint32(20, blob.size, true); d.setUint32(24, blob.size, true); d.setUint16(28, name.length, true);
        d.setUint32(42, offset, true); directory.set(name, 46);
        parts.push(local, blob); central.push(directory); offset += local.length + blob.size; centralBytes += directory.length;
    }
    const end = new Uint8Array(22), e = new DataView(end.buffer);
    e.setUint32(0, 0x06054b50, true); e.setUint16(8, files.length, true); e.setUint16(10, files.length, true);
    e.setUint32(12, centralBytes, true); e.setUint32(16, offset, true);
    await guard(); return new Blob([...parts, ...central, end], { type: 'application/zip' });
}
