import test from 'node:test';
import assert from 'node:assert/strict';
import {createProseFloorTools} from '../qianmu-prose-floor-tools.js';

const gate = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return {promise, resolve}; };
const turn = () => new Promise(resolve => setImmediate(resolve));
function fixture(t) {
    const window = new EventTarget(); let stores = 0, closes = 0, views = 0, wait;
    const tools = createProseFloorTools({window, getContext: () => ({chat: []}), names: () => ({charName: '', userName: ''}),
        resolveNamespace: async () => 'st-user:floor-test', isCurrent: () => true, headers: () => ({}),
        storeFactory: async () => {
            stores++; await wait?.(); return {
                read: async () => ({exists: false, fingerprint: null, value: null}),
                write: async () => { throw Error('Lifecycle must not write'); }, close() { closes++; },
            };
        },
        viewFactory: async ({collection}) => {
            views++; return {panel: {open: async () => { await collection.open(); return true; }}, capture: {close() {}}, dispose() {}};
        },
    });
    t.after(() => tools.dispose());
    return {tools, window, hold(fn) { wait = fn; }, get stores() { return stores; }, get closes() { return closes; }, get views() { return views; }};
}

test('host disable and re-enable create one new account document without online recovery or hive reads', async t => {
    const f = fixture(t); f.tools.refreshCollection(null); await f.tools.openCollection();
    assert.equal(f.stores, 1); f.tools.renderHive(); f.window.dispatchEvent(new Event('online'));
    await turn(); assert.equal(f.stores, 1);
    f.tools.dispose(); assert.equal(f.closes, 1);
    f.tools.refreshCollection(null); await f.tools.openCollection();
    assert.equal(f.stores, 2); assert.equal(f.views, 2); assert.equal(f.closes, 1);
});

test('late account setup from a disabled host cannot mount a view in its replacement', async t => {
    const f = fixture(t), held = gate(); f.hold(() => held.promise);
    const old = f.tools.openCollection(); await turn(); f.tools.dispose();
    f.hold(null); assert.equal(await f.tools.openCollection(), true); held.resolve();
    assert.equal(await old, false); assert.equal(f.stores, 2); assert.equal(f.views, 1); assert.equal(f.closes, 1);
});
