import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { readNotesDeviceState, saveNotesDeviceState } from '../qianmu-notes-device.js';

const key = 'qianmu.notes.device.v1';
const blank = () => ({ detached: false, position: { x: null, y: null }, panelSize: { width: null, height: null } });
const sample = () => ({ detached: true, position: { x: 0, y: 180.5 }, panelSize: { width: 560, height: 420 } });
function fixture(callback, { getError, setError, accessError } = {}) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, 'window'), data = new Map(), writes = [];
    const localStorage = {
        getItem(name) { if (getError) throw getError; return data.get(name) ?? null; },
        setItem(name, value) { if (setError) throw setError; writes.push([name, value]); data.set(name, value); },
    };
    const browser = {};
    Object.defineProperty(browser, 'localStorage', { get() { if (accessError) throw accessError; return localStorage; } });
    Object.defineProperty(globalThis, 'window', { value: browser, configurable: true });
    try { return callback({ data, writes }); }
    finally { if (previous) Object.defineProperty(globalThis, 'window', previous); else delete globalThis.window; }
}

test('first read migrates legacy geometry once and excludes all content and shared preferences', () => fixture(({ data, writes }) => {
    const legacy = { ...sample(), enabled: true, appearance: { tone: 'dark' }, editorFontSize: 18, body: 'must stay out', account: 'not a layout field' };
    const before = JSON.stringify(legacy);
    assert.deepEqual(readNotesDeviceState(legacy), sample());
    assert.equal(writes.length, 1);
    assert.deepEqual(JSON.parse(data.get(key)), { version: 1, ...sample() });
    assert.equal(JSON.stringify(legacy), before);
    assert.deepEqual(readNotesDeviceState(blank()), sample(), 'later ST geometry must not overwrite this device');
    assert.equal(writes.length, 1);
}));

test('a first default read also establishes local ownership rather than importing later shared settings', () => fixture(({ writes }) => {
    assert.deepEqual(readNotesDeviceState(), blank());
    assert.deepEqual(readNotesDeviceState(sample()), blank());
    assert.equal(writes.length, 1);
}));

test('explicit save persists unpinned geometry independently and read returns a fresh nested object', () => fixture(({ data, writes }) => {
    const state = sample(), before = JSON.stringify(state), result = saveNotesDeviceState(state);
    assert.deepEqual(result, state); assert.notEqual(result, state); assert.notEqual(result.position, state.position);
    result.position.x = 900;
    assert.equal(JSON.stringify(state), before);
    assert.deepEqual(readNotesDeviceState(), state);
    const first = readNotesDeviceState(); first.panelSize.width = 999;
    assert.deepEqual(readNotesDeviceState(), state);
    assert.equal(writes.length, 1); assert.equal(data.size, 1);
}));

test('finite fractional coordinates and documented bounds survive without lossy coercion', () => fixture(() => {
    const state = { detached: false, position: { x: 0.25, y: 100000 }, panelSize: { width: 1, height: 100000 } };
    saveNotesDeviceState(state); assert.deepEqual(readNotesDeviceState(), state);
    saveNotesDeviceState(blank()); assert.deepEqual(readNotesDeviceState(), blank());
}));

test('bad legacy geometry is cleaned to local defaults instead of propagating NaN or remote fields', () => fixture(() => {
    const malformed = { detached: 'true', position: { x: '35', y: Infinity }, panelSize: { width: -10, height: 100001 } };
    assert.deepEqual(readNotesDeviceState(malformed), blank());
    assert.deepEqual(readNotesDeviceState(sample()), blank());
}));

test('save rejects malformed, infinite, negative, over-limit and unknown fields before any write', () => fixture(({ writes }) => {
    const cases = [null, [], 'state', { detached: 'false' }, { position: [] }, { panelSize: 3 },
        { body: 'never stored' }, { position: { x: NaN } }, { position: { y: Infinity } }, { position: { x: -1 } },
        { position: { x: '24' } }, { position: { x: 100001 } }, { panelSize: { width: 0 } },
        { panelSize: { height: -Infinity } }, { panelSize: { height: 100001 } }, { panelSize: { body: 'not geometry' } }];
    for (const invalid of cases) assert.throws(() => saveNotesDeviceState(invalid), { code: 'notes_device_shape' });
    assert.deepEqual(writes, []);
}));

test('corrupt and future local records are preserved and never silently reassigned to fallback geometry', () => fixture(({ data, writes }) => {
    for (const raw of ['broken', 'null', '[]', JSON.stringify({ version: 2, ...sample() }),
        JSON.stringify({ version: 1, ...sample(), prose: 'retain original record' }),
        JSON.stringify({ version: 1, ...sample(), position: { x: -1, y: 20 } })]) {
        data.set(key, raw);
        assert.deepEqual(readNotesDeviceState(sample()), blank());
        assert.equal(data.get(key), raw); assert.equal(writes.length, 0);
    }
}));

test('quota failure during first migration is reported and does not claim local ownership', () => {
    const cause = new Error('synthetic quota');
    fixture(({ data, writes }) => {
        assert.throws(() => readNotesDeviceState(sample()), error => error.code === 'notes_device_storage' && error.cause === cause);
        assert.equal(data.size, 0); assert.equal(writes.length, 0);
    }, { setError: cause });
});

test('explicit save quota failure preserves the earlier local record', () => {
    const cause = new Error('synthetic quota');
    fixture(({ data, writes }) => {
        const raw = JSON.stringify({ version: 1, ...blank() }); data.set(key, raw);
        assert.throws(() => saveNotesDeviceState(sample()), error => error.code === 'notes_device_storage' && error.cause === cause);
        assert.equal(data.get(key), raw); assert.equal(writes.length, 0);
    }, { setError: cause });
});

test('blocked localStorage getters and failed reads throw without replacing stored geometry', () => {
    for (const kind of ['accessError', 'getError']) {
        const cause = new Error(`synthetic ${kind}`);
        fixture(({ writes }) => {
            assert.throws(() => readNotesDeviceState(sample()), error => error.code === 'notes_device_storage' && error.cause === cause);
            assert.equal(writes.length, 0);
        }, { [kind]: cause });
    }
});

test('without a browser reads are side-effect-free and saves refuse false durability', () => {
    const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
    delete globalThis.window;
    try {
        assert.deepEqual(readNotesDeviceState(), blank());
        assert.deepEqual(readNotesDeviceState(sample()), sample());
        assert.throws(() => saveNotesDeviceState(sample()), { code: 'notes_device_storage' });
    } finally { if (previous) Object.defineProperty(globalThis, 'window', previous); }
});

test('module has no network, cloud, account-setting, note-content or timer dependencies', async () => {
    const source = await readFile(new URL('../qianmu-notes-device.js', import.meta.url), 'utf8');
    assert.doesNotMatch(source, /^import\s|\bimport\(|fetch\(|indexedDB|saveSettings\(|sessionStorage|setTimeout\(|setInterval\(/m);
});
