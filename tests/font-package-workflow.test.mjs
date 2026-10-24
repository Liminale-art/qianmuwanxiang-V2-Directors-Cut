import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createFontLibrary } from '../qianmu-font-library.js';
import { buildFontArchive, openFontArchive } from '../qianmu-font-package.js';

const FONT_BYTES = 25 * 1024 * 1024;
const CHUNK_BYTES = 1024 * 1024;
const pause = () => new Promise(resolve => setTimeout(resolve, 0));

async function digest(blob) {
    const hash = createHash('sha256');
    for (let offset = 0; offset < blob.size; offset += CHUNK_BYTES) hash.update(new Uint8Array(await blob.slice(offset, offset + CHUNK_BYTES).arrayBuffer()));
    return hash.digest('hex');
}

function original(index) {
    const header = new Uint8Array(32), view = new DataView(header.buffer);
    view.setUint32(0, 0x00010000); view.setUint16(4, 1);
    view.setUint32(20, 28); view.setUint32(24, FONT_BYTES - 28);
    header[31] = index + 1;
    const chunk = new Uint8Array(CHUNK_BYTES).fill(index + 1);
    // These are header/table-valid synthetic fonts, not browser-renderable font fixtures.
    const blob = new Blob([header, ...Array.from({ length: 24 }, () => chunk), chunk.subarray(32)]);
    const record = { id: `source_${index}`, name: `大字体 ${index + 1}`, source: { kind: 'local', fileName: `large-${index + 1}.ttf`, format: 'truetype' },
        faces: [{ urls: [], weight: '400', style: 'normal' }], tags: ['大字体', '本地'] };
    return { blob, record };
}

test('100 MiB ZIP controller workflow commits large fonts individually, skips duplicate writes and exports intact originals', { timeout: 60000 }, async () => {
    const originals = Array.from({ length: 4 }, (_, index) => original(index));
    const bySource = new Map(originals.map(item => [item.record.id, item.blob]));
    const expected = new Map();
    for (const item of originals) {
        assert.equal(item.blob.size, FONT_BYTES);
        expected.set(item.record.name, await digest(item.blob));
    }
    assert.equal(new Set(expected.values()).size, 4, 'each large fixture has distinct original bytes');
    const file = await buildFontArchive(originals.map(item => item.record), { readLocal: async id => bySource.get(id),
        folders: ['大字体'], previewText: '一念起幕，万象成诗。 AaBbCc123456', yieldTask: async () => {} });
    assert.ok(file.size < 100 * 1024 * 1024 / 20, 'fixture uses actual compression, not an uncompressed ZIP envelope');

    const owner = {}, binaries = new Map(), puts = [], saves = [], notices = [], progress = [], downloads = [];
    let active = true, shownView;
    const entry = { addEventListener(_type, handler) { this.click = handler; }, removeEventListener() {}, focus() {} };
    const root = { isConnected: true, classList: { add() {}, remove() {} },
        querySelector: selector => selector === '[data-font-library]' ? entry : selector === '.sd-floor-shell' ? { appendChild() {} } : null };
    const library = createFontLibrary({ getOwner: () => owner, isCurrent: () => active, resolveNamespace: async () => 'memory-only',
        save: value => saves.push({ count: value.fontLibrary.fonts.length, puts: puts.length, snapshot: structuredClone(value.fontLibrary) }),
        document: { baseURI: 'https://st.example/', createElement: () => ({ remove() {}, setAttribute() {} }) },
        accountSyncFactory: () => null,
        notify: (text, level) => notices.push({ text, level, count: owner.fontLibrary?.fonts.length }),
        download: (blob, name) => downloads.push({ blob, name }),
        localStoreFactory: () => ({ get: async id => binaries.get(id) || null,
            put: async (id, bytes) => { puts.push({ id, size: bytes.byteLength }); binaries.set(id, new Blob([bytes])); },
            delete: async ids => ids.forEach(id => binaries.delete(id)), dispose() {} }),
        runtimeFactory: () => ({ sync: async () => {}, family: id => id, dispose() {} }),
        viewFactory: options => {
            shownView = { render() {}, destroy() {},
                setProgress(value) { progress.push(value ? { ...value, saved: owner.fontLibrary?.fonts.length || 0 } : null); },
                setStatus(text, { error = false } = {}) { options.notify(text, error ? 'warning' : 'info'); } };
            return shownView;
        },
    });
    try {
        library.attach(root); entry.click();
        for (let attempt = 0; !shownView && attempt < 200; attempt++) await pause();
        assert.ok(shownView, 'minimal in-memory panel is ready to capture controller progress and notices');

        await library.action('import', { file });
        assert.deepEqual(saves.map(value => value.count), [1, 2, 3, 4], '25 MiB originals exceed the 16 MiB threshold and each commits independently');
        assert.deepEqual(saves.map(value => value.puts), [1, 2, 3, 4], 'each directory commit follows its own completed original write');
        assert.equal(puts.length, 4); assert.ok(puts.every(value => value.size === FONT_BYTES));
        assert.equal(binaries.size, 4); assert.equal(owner.fontLibrary.fonts.length, 4);
        assert.deepEqual(progress.filter(value => value?.phase === 'import' && value.done > 0).map(value => [value.done, value.total, value.saved]),
            [[1, 4, 1], [2, 4, 2], [3, 4, 3], [4, 4, 4]]);
        assert.equal(progress.at(-1), null, 'progress clears only after the import has completed');
        assert.deepEqual(notices, [{ text: '字体包导入成功', level: 'info', count: 4 }]);
        for (const font of owner.fontLibrary.fonts) {
            const stored = binaries.get(font.id), expectedDigest = expected.get(font.name);
            assert.equal(stored.size, FONT_BYTES); assert.equal(await digest(stored), expectedDigest);
            assert.equal(font.id, `local_${expectedDigest}`, 'the stored identity is derived from the complete original bytes');
        }

        const before = structuredClone(owner.fontLibrary), previousSaves = saves.length, previousPuts = puts.length;
        progress.length = 0;
        await library.action('import', { file });
        assert.equal(puts.length, previousPuts, 'reimport skips all four already present originals');
        assert.equal(saves.length, previousSaves, 'unchanged directory metadata is not saved again');
        assert.deepEqual(owner.fontLibrary, before);
        assert.equal(notices.length, 2, 'each complete operation produces exactly one completion notification');
        assert.deepEqual(notices[1], { text: '字体包导入成功', level: 'info', count: 4 });
        assert.ok(progress.some(value => value?.phase === 'import' && value.done === 4 && value.total === 4));
        assert.equal(progress.at(-1), null);

        progress.length = 0;
        await library.action('export');
        assert.equal(downloads.length, 1); assert.match(downloads[0].name, /^qianmu-fonts-\d+\.zip$/u);
        assert.equal(downloads[0].blob.type, 'application/zip');
        assert.ok(progress.some(value => value?.phase === 'export' && value.done === 4 && value.total === 4));
        assert.equal(progress.at(-1), null);
        assert.deepEqual(notices.at(-1), { text: '字体包已导出', level: 'info', count: 4 });
        assert.equal(saves.length, previousSaves); assert.equal(puts.length, previousPuts);
        const exported = await openFontArchive(downloads[0].blob, { yieldTask: async () => {} });
        try {
            assert.equal(exported.records.length, 4);
            assert.equal(exported.previewText, '一念起幕，万象成诗。 AaBbCc123456');
            assert.deepEqual(exported.folders, ['大字体']);
            let restoredBytes = 0;
            for (const font of exported.records) {
                const blob = await exported.readLocal(font.id); restoredBytes += blob.size;
                assert.equal(blob.size, FONT_BYTES); assert.equal(await digest(blob), expected.get(font.name));
            }
            assert.equal(restoredBytes, 100 * 1024 * 1024);
        } finally { await exported.close(); }
    } finally { active = false; library.dispose(); }
});
