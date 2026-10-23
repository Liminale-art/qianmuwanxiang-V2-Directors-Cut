import test from 'node:test';
import assert from 'node:assert/strict';
import { createFontAccountSync } from '../qianmu-font-account-sync.js';

const localFont = (id = 'local_' + 'a'.repeat(64)) => ({
    version: 1, enabled: true, syncLocalOriginals: false, fonts: [{
        id, name: '测试字体', source: { kind: 'local', fileName: 'test.ttf', format: 'truetype' },
        faces: [{ urls: [], weight: '400', style: 'normal' }], folder: '', tags: [],
    }], folders: [], pinnedIds: [], sortBy: 'name', sortOrder: 'asc', previewText: '示例', mode: 'separate',
    body: { fontId: '', weight: '400', style: 'normal', enabled: false },
    st: { fontId: '', weight: '400', style: 'normal', enabled: false },
    shared: { fontId: '', weight: '400', style: 'normal', enabled: false },
});

function fixture() {
    let catalog = null, sequence = 0;
    const immutable = new Map(), local = new Map();
    const storage = {
        async read(slot) {
            assert.equal(slot, 'font-library');
            return catalog ? { exists: true, value: catalog, fingerprint: 'a'.repeat(64) } : { exists: false, value: null, fingerprint: null };
        },
        async write(slot, value, { expectedFingerprint }) {
            assert.equal(slot, 'font-library');
            assert.equal(expectedFingerprint, catalog ? 'a'.repeat(64) : null);
            catalog = structuredClone(value); sequence++;
            return { exists: true, value: catalog, fingerprint: String.fromCharCode(97 + sequence).repeat(64) };
        },
        async preserveImmutable(slot, value) {
            const reference = { version: 1, scope: 'b'.repeat(64), slot, fingerprint: 'c'.repeat(64), bytes: 100 + sequence };
            immutable.set(slot, structuredClone(value));
            return { exists: true, value, fingerprint: reference.fingerprint, reference };
        },
        async readImmutable(reference) {
            const value = immutable.get(reference.slot);
            return value ? { exists: true, value, fingerprint: reference.fingerprint, reference } : null;
        },
        close() {},
    };
    const localStore = {
        async get(id) { return local.get(id) || null; },
        async put(id, bytes) { local.set(id, new Blob([bytes], { type: 'application/octet-stream' })); },
    };
    return { storage, localStore, local, immutable, get catalog() { return catalog; } };
}

test('font account sync publishes the directory and originals by default', async () => {
    const f = fixture(), sync = createFontAccountSync({ storageFactory: () => f.storage }), state = localFont();
    f.local.set(state.fonts[0].id, new Blob([new Uint8Array([0, 1, 2, 3])]));
    const result = await sync.hydrate(state, { localStore: f.localStore });
    assert.equal(result.synced, true);
    assert.equal(Object.keys(f.catalog.originals).length, 1);
    assert.equal(f.immutable.size, 1);
    sync.close();
});

test('font account sync keeps automatically uploaded originals immutable', async () => {
    const f = fixture(), sync = createFontAccountSync({ storageFactory: () => f.storage }), state = localFont();
    const id = state.fonts[0].id;
    f.local.set(id, new Blob([new Uint8Array([0, 1, 2, 3])]));
    await sync.hydrate({ ...state, syncLocalOriginals: false }, { localStore: f.localStore });
    assert.equal(f.immutable.size, 1);
    assert.ok(f.catalog.originals[id]);
    assert.match(f.catalog.originals[id].slot, /^fontasset-/);
    assert.equal(f.catalog.library.syncLocalOriginals, undefined);
    sync.close();
});
