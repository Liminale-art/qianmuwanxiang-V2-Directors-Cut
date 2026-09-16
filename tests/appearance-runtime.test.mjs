import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createQianmuAppearanceRuntime } from '../qianmu-appearance-runtime.js';
import { updateAppearancePreferences } from '../qianmu-appearance-settings.js';
import { createQianmuThemeSnapshot } from '../qianmu-theme-surfaces.js';

function element() {
    const values = new Map(), attributes = new Map(); let writes = 0;
    return { nodeType: 1, ownerDocument: {}, isConnected: true, className: 'sd-theme-dream', children: [{ draft: 'keep' }], scrollTop: 83,
        get writes() { return writes; }, getAttribute: name => attributes.get(name) ?? null,
        setAttribute(name, value) { writes++; attributes.set(name, value); }, removeAttribute(name) { writes++; attributes.delete(name); },
        style: { getPropertyValue: name => values.get(name)?.value || '', getPropertyPriority: name => values.get(name)?.priority || '',
            setProperty(name, value, priority = '') { writes++; values.set(name, { value, priority }); }, removeProperty(name) { writes++; values.delete(name); } },
    };
}
const appearance = patch => updateAppearancePreferences({}, { family: 'glass', ...patch });

test('classic-only mount and synchronization leave roots and settings untouched', () => {
    const settings = { theme: 'dream' }, before = structuredClone(settings), root = element(); let coverReads = 0;
    const runtime = createQianmuAppearanceRuntime({ readSettings: () => settings, readCoverAccent() { coverReads++; } });
    const off = runtime.register(root); runtime.sync();
    assert.equal(runtime.size, 1); assert.equal(root.writes, 0); assert.equal(coverReads, 0); assert.deepEqual(settings, before);
    off(); off(); assert.equal(runtime.size, 0); assert.equal(root.writes, 0);
});

test('all attached roots update in place and late portals do not depend on a main panel', () => {
    let settings = { theme: 'dream', appearance: appearance({}) };
    const runtime = createQianmuAppearanceRuntime({ readSettings: () => settings }), a = element(), b = element();
    const child = a.children[0], off = runtime.register(a); runtime.register(b);
    settings = { ...settings, appearance: appearance({ family: 'editorial', mode: 'dark', accent: '#abc' }) }; runtime.sync();
    for (const root of [a, b]) { assert.equal(root.getAttribute('data-qm-theme'), 'editorial'); assert.equal(root.getAttribute('data-qm-mode'), 'dark'); }
    assert.equal(a.children[0], child); assert.equal(a.scrollTop, 83); assert.equal(a.className, 'sd-theme-dream');
    off(); a.isConnected = false; const late = element(); runtime.register(late);
    assert.equal(late.getAttribute('data-qm-theme'), 'editorial'); assert.equal(runtime.size, 2);
    runtime.dispose(); assert.equal(late.getAttribute('data-qm-theme'), null); assert.equal(runtime.size, 0);
});

test('cover is read only when requested and receives the saved harmony, never another gallery image', () => {
    let settings = { appearance: appearance({ harmony: 'complementary' }) }, calls = [];
    const runtime = createQianmuAppearanceRuntime({ readSettings: () => settings, readCoverAccent(harmony) { calls.push(harmony); return '#f65'; } }), root = element();
    runtime.register(root); assert.deepEqual(calls, ['complementary']);
    assert.equal(root.style.getPropertyValue('--sd-accent'), createQianmuThemeSnapshot({ theme: 'glass', mode: 'light', accent: '#ff6655' }).tokens['--sd-accent']);
    settings.appearance = appearance({ source: 'manual', accent: '#123' }); runtime.sync();
    assert.deepEqual(calls, ['complementary']);
    settings.appearance = appearance({ family: 'classic' }); runtime.sync(); assert.deepEqual(calls, ['complementary']);
    assert.equal(root.getAttribute('data-qm-theme'), null); runtime.dispose();
});

test('reader failure happens before any root mutation or pruning', () => {
    let fail = false;
    const runtime = createQianmuAppearanceRuntime({ readSettings: () => ({ appearance: appearance({}) }), readCoverAccent() { if (fail) throw Error('cover unavailable'); return '#abc'; } });
    const a = element(), b = element(); runtime.register(a); runtime.register(b);
    const counts = [a.writes, b.writes], prefs = runtime.preferences; fail = true;
    assert.throws(() => runtime.sync(), /cover unavailable/); assert.deepEqual([a.writes, b.writes], counts); assert.equal(runtime.preferences, prefs);
    assert.throws(() => runtime.register(element()), /cover unavailable/); assert.equal(runtime.size, 2); runtime.dispose();
});

test('unchanged sync has no redundant writes but repairs a classic owner token overwrite', () => {
    const runtime = createQianmuAppearanceRuntime({ readSettings: () => ({ appearance: appearance({}) }) }), root = element(); runtime.register(root);
    const value = root.style.getPropertyValue('--sd-text'), writes = root.writes; runtime.sync(); assert.equal(root.writes, writes);
    root.style.setProperty('--sd-text', 'classic-new'); runtime.sync(); assert.equal(root.style.getPropertyValue('--sd-text'), value);
    runtime.dispose(); assert.equal(root.style.getPropertyValue('--sd-text'), 'classic-new');
});

test('hive registration preserves tone, border index, position and important classic baseline', () => {
    let settings = { appearance: appearance({}) }; const root = element();
    root.style.setProperty('left', '20px'); root.style.setProperty('background-color', 'red', 'important');
    const runtime = createQianmuAppearanceRuntime({ readSettings: () => settings }); runtime.register(root, { role: 'hive-entry', tone: 'dark', edgeIndex: 4 });
    for (const mode of ['light', 'dark']) {
        settings.appearance = appearance({ mode }); runtime.sync();
        const expected = createQianmuThemeSnapshot({ theme: 'glass', mode, accent: settings.appearance.accent });
        assert.equal(root.style.getPropertyValue('--sd-wheel-icon'), expected.hive.dark.icon);
        assert.equal(root.style.getPropertyValue('--sd-wheel-edge'), expected.hive.dark.edges[1]); assert.equal(root.style.getPropertyValue('left'), '20px');
    }
    runtime.dispose(); assert.equal(root.style.getPropertyValue('background-color'), 'red'); assert.equal(root.style.getPropertyPriority('background-color'), 'important');
});

test('missed unmount disposal is pruned; an old disposer cannot remove a remounted root', () => {
    const runtime = createQianmuAppearanceRuntime({ readSettings: () => ({ appearance: appearance({}) }) }), root = element();
    const old = runtime.register(root); root.isConnected = false; runtime.sync();
    assert.equal(runtime.size, 0); assert.equal(root.getAttribute('data-qm-theme'), null);
    root.isConnected = true; const current = runtime.register(root); old();
    assert.equal(runtime.size, 1); assert.equal(root.getAttribute('data-qm-theme'), 'glass');
    current(); assert.equal(runtime.size, 0); runtime.dispose(); old(); current();
});

test('collected weak entries are removed without dereferencing a dead root', () => {
    const refs = []; class TestWeakReference { constructor(root) { this.root = root; refs.push(this); } deref() { return this.root; } }
    const runtime = createQianmuAppearanceRuntime({ readSettings: () => ({}), WeakReference: TestWeakReference });
    runtime.register(element()); refs[0].root = undefined; runtime.sync(); assert.equal(runtime.size, 0); runtime.dispose();
});

test('owner-supplied scroll targets restore native anchoring on both axes after palette changes', () => {
    const root = element(), scroller = { isConnected: true, scrollTop: 80, scrollLeft: 14 };
    root.contains = node => node === scroller;
    const set = root.style.setProperty;
    root.style.setProperty = (...args) => { set(...args); scroller.scrollTop += 32; scroller.scrollLeft += 9; };
    let settings = { appearance: appearance({}) };
    const runtime = createQianmuAppearanceRuntime({ readSettings: () => settings });
    runtime.register(root, { scrollTargets: () => [scroller, scroller] });
    assert.deepEqual([scroller.scrollTop, scroller.scrollLeft], [80, 14]);
    settings.appearance = appearance({ mode: 'dark' }); runtime.sync();
    assert.deepEqual([scroller.scrollTop, scroller.scrollLeft], [80, 14]); runtime.dispose();
});

test('scroll targets are resolved anew by the owner, so rerendered containers do not leave stale references', () => {
    const root = element(); let scroller = { isConnected: true, scrollTop: 60, scrollLeft: 3 };
    root.contains = node => node === scroller;
    const set = root.style.setProperty; root.style.setProperty = (...args) => { set(...args); scroller.scrollTop = 150; };
    let settings = { appearance: appearance({}) };
    const runtime = createQianmuAppearanceRuntime({ readSettings: () => settings });
    runtime.register(root, { scrollTargets: () => [scroller] });
    const old = scroller; old.isConnected = false; scroller = { isConnected: true, scrollTop: 42, scrollLeft: 0 };
    settings.appearance = appearance({ mode: 'dark' }); runtime.sync();
    assert.equal(scroller.scrollTop, 42); assert.equal(old.scrollTop, 60); runtime.dispose();
});

test('host or detached scroll targets are rejected before mutating existing surfaces', () => {
    const root = element(), alien = { isConnected: true, scrollTop: 0, scrollLeft: 0 };
    const runtime = createQianmuAppearanceRuntime({ readSettings: () => ({ appearance: appearance({}) }) });
    assert.throws(() => runtime.register(root, { scrollTargets: [] }), TypeError);
    assert.throws(() => runtime.register(root, { scrollTargets: () => [alien] }), /belong/);
    assert.equal(root.writes, 0); assert.equal(runtime.size, 0);
    let targets = [];
    runtime.register(root, { scrollTargets: () => targets }); const writes = root.writes;
    targets = [alien]; assert.throws(() => runtime.sync(), /belong/); assert.equal(root.writes, writes);
    runtime.dispose();
});

test('invalid roots, options and duplicates fail cleanly; the host body is never a target', () => {
    const runtime = createQianmuAppearanceRuntime({ readSettings: () => ({ appearance: appearance({}) }) }), root = element();
    assert.throws(() => runtime.register(null), TypeError); root.isConnected = false; assert.throws(() => runtime.register(root), /attached/); root.isConnected = true;
    root.ownerDocument.body = root; assert.throws(() => runtime.register(root), TypeError); root.ownerDocument.body = null;
    assert.throws(() => runtime.register(root, { role: 'body' }), TypeError); assert.equal(runtime.size, 0); assert.equal(root.writes, 0);
    runtime.register(root); assert.throws(() => runtime.register(root), /already/); assert.equal(runtime.size, 1); runtime.dispose();
});

test('browsers without weak references remain classic and never read media', () => {
    const root = element(), runtime = createQianmuAppearanceRuntime({ readSettings: () => ({ appearance: appearance({}) }), WeakReference: null, readCoverAccent() { throw Error('must not read'); } });
    assert.equal(runtime.supported, false); runtime.register(root)(); runtime.sync(); assert.equal(runtime.size, 0); assert.equal(root.writes, 0); runtime.dispose();
});

test('dispose restores all live roots, is idempotent and forbids reuse', () => {
    const runtime = createQianmuAppearanceRuntime({ readSettings: () => ({ appearance: appearance({}) }) }), a = element(), b = element();
    runtime.register(a); runtime.register(b); runtime.dispose(); runtime.dispose();
    assert.equal(runtime.size, 0); assert.equal(runtime.preferences, null); assert.equal(a.getAttribute('data-qm-theme'), null); assert.equal(b.getAttribute('data-qm-theme'), null);
    assert.throws(() => runtime.sync(), /disposed/); assert.throws(() => runtime.register(a), /disposed/);
    assert.throws(() => createQianmuAppearanceRuntime(), TypeError);
});

test('appearance runtime has no hidden DOM scan, renderer, observer, persistence or network effects', async () => {
    for (const file of ['qianmu-appearance-runtime.js', 'qianmu-appearance-settings.js']) {
        const source = await readFile(new URL('../' + file, import.meta.url), 'utf8');
        assert.doesNotMatch(source, /innerHTML|replaceChildren|replaceWith|\.focus\(|setSelectionRange|MutationObserver|querySelector|localStorage|indexedDB|fetch\(|setInterval|setTimeout|className\s*=/);
    }
});
