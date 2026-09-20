import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createQianmuAppearanceSession, loadQianmuAppearanceStyles } from '../qianmu-appearance-session.js';

function element() {
    const styles = new Map(), attrs = new Map();
    return { nodeType: 1, ownerDocument: {}, isConnected: true, scrollTop: 0, scrollLeft: 0, querySelectorAll: () => [],
        getAttribute: key => attrs.get(key) ?? null, setAttribute: (key, value) => attrs.set(key, value), removeAttribute: key => attrs.delete(key),
        style: { getPropertyValue: key => styles.get(key)?.value || '', getPropertyPriority: key => styles.get(key)?.priority || '', setProperty: (key, value, priority = '') => styles.set(key, { value, priority }), removeProperty: key => styles.delete(key) },
    };
}
const preference = { version: 1, family: 'glass', mode: 'light' };
function eventElement() {
    const root = element(), listeners = new Map();
    root.addEventListener = (type, fn) => { const group = listeners.get(type) || new Set(); group.add(fn); listeners.set(type, group); };
    root.removeEventListener = (type, fn) => listeners.get(type)?.delete(fn);
    root.listenerCount = type => listeners.get(type)?.size || 0;
    return root;
}
function fixture() {
    let settings = { theme: 'light' }, loads = [], errors = [];
    const session = createQianmuAppearanceSession({ readSettings: () => settings, onError: error => errors.push(error), loadStyles: () => {
        const load = { cancelled: 0 }; load.promise = new Promise(resolve => load.resolve = resolve); load.cancel = () => { load.cancelled++; load.resolve(false); }; loads.push(load); return load;
    } });
    return { session, loads, errors, set: value => settings = value };
}

test('classic mounts are inert, idempotent and do not request the optional skin', async () => {
    const f = fixture(), root = element(), off = f.session.mount(root);
    assert.equal(f.session.status,'idle');
    assert.equal(f.session.mount(root), off); await f.session.sync(); assert.equal(f.loads.length, 0); assert.equal(f.session.size, 1); assert.equal(root.getAttribute('data-qm-theme'), null);
    off(); off(); assert.equal(f.session.size, 0); f.session.reset();
});

test('owned mounts isolate input once and release it on unmount, detach, role changes and reset', async () => {
    const f = fixture(), root = eventElement(), portal = eventElement();
    const off = f.session.mount(root); f.session.mount(root);
    assert.equal(root.listenerCount('keydown'), 1);
    f.session.mount(root, { role: 'notes-entry' }); off(); assert.equal(root.listenerCount('keydown'), 1);
    const releasePortal = f.session.mountPortal(portal); assert.equal(portal.listenerCount('paste'), 1);
    releasePortal(); releasePortal(); assert.equal(portal.listenerCount('paste'), 0);
    root.isConnected = false; await f.session.sync(); assert.equal(root.listenerCount('keydown'), 0);
    root.isConnected = true; f.session.mount(root); f.session.mountPortal(portal);
    f.session.reset(); assert.equal(root.listenerCount('keydown'), 0); assert.equal(portal.listenerCount('paste'), 0);
    f.session.mount(root); assert.equal(root.listenerCount('keydown'), 1); f.session.reset();
});

test('skin load is shared and new colors are applied only after successful loading', async () => {
    const f = fixture(), a = element(), b = element(); f.set({ theme: 'light', appearance: preference });
    f.session.mount(a); f.session.mount(b); const ready = f.session.sync();
    assert.equal(f.session.status,'loading');
    assert.equal(f.loads.length, 1); assert.equal(a.getAttribute('data-qm-theme'), null); assert.equal(f.session.ready, false);
    f.loads[0].resolve(true); assert.equal(await ready, true);
    assert.equal(f.session.status,'ready');
    assert.equal(a.getAttribute('data-qm-theme'), 'glass'); assert.equal(b.getAttribute('data-qm-theme'), 'glass'); assert.equal(f.session.ready, true);
    f.session.reset(); assert.equal(f.loads[0].cancelled, 1); assert.equal(a.getAttribute('data-qm-theme'), null);
});

test('load completion reads current preferences, never a stale choice', async () => {
    const f = fixture(), root = element(); f.set({ appearance: preference }); f.session.mount(root);
    f.set({ appearance: { ...preference, family: 'editorial', mode: 'dark' } }); const ready = f.session.sync(); f.loads[0].resolve(true); await ready;
    assert.equal(root.getAttribute('data-qm-theme'), 'editorial'); assert.equal(root.getAttribute('data-qm-mode'), 'dark'); f.session.reset();
});

test('switching back to classic during loading does not flash the abandoned theme', async () => {
    const f = fixture(), root = element(); f.set({ appearance: preference }); f.session.mount(root); const ready = f.session.sync();
    f.set({ theme: 'dream' }); await f.session.sync(); f.loads[0].resolve(true); await ready;
    assert.equal(root.getAttribute('data-qm-theme'), null); f.session.reset();
});

test('failed styles retain classic and report once, with an explicit retry path', async () => {
    const f = fixture(), root = element(); f.set({ appearance: preference }); f.session.mount(root); let ready = f.session.sync();
    f.loads[0].resolve(false); assert.equal(await ready, false); await f.session.sync(); f.session.mount(element());
    assert.equal(f.session.status,'error');
    assert.equal(f.errors.length, 1); assert.equal(f.loads.length, 1); assert.equal(root.getAttribute('data-qm-theme'), null);
    ready = f.session.retry(); assert.equal(f.loads.length, 2); f.loads[1].resolve(true); assert.equal(await ready, true);
    assert.equal(root.getAttribute('data-qm-theme'), 'glass'); f.session.reset();
});

test('reset cancels a pending style load and stale completion cannot repaint new roots', async () => {
    const f = fixture(), old = element(); f.set({ appearance: preference }); f.session.mount(old); const first = f.session.sync();
    f.session.reset(); const next = element(); f.session.mount(next); const second = f.session.sync();
    f.loads[0].resolve(true); assert.equal(await first, false); assert.equal(next.getAttribute('data-qm-theme'), null);
    f.loads[1].resolve(true); assert.equal(await second, true); assert.equal(next.getAttribute('data-qm-theme'), 'glass'); assert.equal(old.getAttribute('data-qm-theme'), null); f.session.reset();
});

test('a pruned element can be reattached without a stale mount record suppressing registration', async () => {
    const f = fixture(), root = element(); f.set({ appearance: preference }); const off = f.session.mount(root); const ready = f.session.sync(); f.loads[0].resolve(true); await ready;
    root.isConnected = false; await f.session.sync(); assert.equal(f.session.size, 0);
    root.isConnected = true; f.session.mount(root); off(); assert.equal(f.session.size, 1); assert.equal(root.getAttribute('data-qm-theme'), 'glass'); f.session.reset();
});

test('hive main and entries retain position while owning their inline important colors', async () => {
    const f = fixture(), root = element(), main = element(), button = element(); button.dataset = { hiveTone: 'dark', hiveEdgeIndex: '2' }; root.querySelectorAll = selector => selector === '[data-hive-tone]' ? [button] : [];
    main.style.setProperty('background-color', 'red', 'important'); main.style.setProperty('--sd-float-edge', 'blue', 'important'); button.style.setProperty('color', 'pink', 'important'); button.style.setProperty('left', '17px');
    f.set({ appearance: preference }); f.session.mount(main, { role: 'hive-main' }); f.session.mountHive(root); const ready = f.session.sync(); f.loads[0].resolve(true); await ready;
    assert.notEqual(main.style.getPropertyValue('--sd-float-edge'), 'blue'); assert.notEqual(button.style.getPropertyValue('color'), 'pink'); assert.equal(button.style.getPropertyValue('left'), '17px');
    f.set({ theme: 'light' }); await f.session.sync(); assert.equal(main.style.getPropertyValue('background-color'), 'red'); assert.equal(main.style.getPropertyPriority('background-color'), 'important'); assert.equal(button.style.getPropertyValue('color'), 'pink'); f.session.reset();
});

test('mountNotes gives detached entry a theme-following role without rewriting saved classic appearance', async () => {
    const f = fixture(), floating = element(), entry = element();
    const settings = { theme: 'dream', notes: { appearance: { tone: 'dark', edgeIndex: 0 } }, appearance: { ...preference, accent: '#d24962' } };
    floating.querySelector = () => entry;
    const document = { getElementById: id => id === 'qianmu-notes-float-layer' ? floating : null };
    entry.style.setProperty('left', '80px');
    f.set(settings); f.session.mountNotes(document); const ready = f.session.sync(); f.loads[0].resolve(true); await ready;
    const before = { icon: entry.style.getPropertyValue('--sd-wheel-icon'), fill: entry.style.getPropertyValue('background-color') };
    assert.equal(entry.style.getPropertyValue('--sd-wheel-edge'), entry.style.getPropertyValue('--qm-accent'));
    assert.match(before.icon, /color-mix/);
    settings.appearance = { ...settings.appearance, mode: 'dark', accent: '#3c78bb' }; await f.session.sync();
    assert.notEqual(entry.style.getPropertyValue('--sd-wheel-icon'), before.icon);
    assert.notEqual(entry.style.getPropertyValue('background-color'), before.fill);
    assert.equal(entry.style.getPropertyValue('--sd-wheel-edge'), entry.style.getPropertyValue('--qm-accent'));
    assert.deepEqual(settings.notes.appearance, { tone: 'dark', edgeIndex: 0 });
    assert.equal(entry.style.getPropertyValue('left'), '80px');
    assert.equal(f.session.size, 2); f.session.reset();
});

test('stylesheet ownership removes handlers on success, failure and cancellation', async () => {
    const links = [], document = { createElement: () => ({ remove() { this.removed = true; } }), head: { appendChild: link => links.push(link) } };
    const a = loadQianmuAppearanceStyles(document, 'https://qianmu.test/skin.css'); assert.equal(links[0].rel, 'stylesheet'); links[0].onload(); assert.equal(await a.promise, true); assert.equal(links[0].onerror, null); a.cancel(); assert.equal(links[0].removed, true);
    const b = loadQianmuAppearanceStyles(document, 'b.css'); links[1].onerror(); assert.equal(await b.promise, false); assert.equal(links[1].removed, true);
    const c = loadQianmuAppearanceStyles(document, 'c.css'); c.cancel(); c.cancel(); assert.equal(await c.promise, false); assert.equal(links[2].onload, null);
});

test('production mounts use explicit lifecycle boundaries and keep the classic notes sync order', async () => {
    const entry = await readFile(new URL('../index.js', import.meta.url), 'utf8');
    assert.match(entry, /restoreStoryboardNav\(\);\s*appearanceSession\.mount\(modal\);/);
    assert.match(entry, /function syncNotesTheme\(\) \{\s*void appearanceSession\.sync\(\);\s*syncQianmuNotesTheme\([\s\S]*?appearanceSession\.mountNotes\(document\);/);
    assert.match(entry, /bindFloatingNoteEvents\(layer\);\s*appearanceSession\.mountNotes\(document\);/);
    assert.match(entry, /applyFloatPosition\(btn\);\s*appearanceSession\.mount\(btn,\{role:'hive-main'\}\);/);
    assert.match(entry, /appearanceSession\.mountHive\(root\);/); assert.match(entry, /clean\('appearance', \(\) => appearanceSession\.reset\(\)\);/);
});

test('a stalled stylesheet is bounded and cancellation clears its timer and listeners', async () => {
    let expire, cleared = [], link;
    const document = { createElement: () => ({ remove() { this.removed = true; } }), head: { appendChild: value => link = value } };
    const pending = loadQianmuAppearanceStyles(document, 'slow.css', { timeoutMs: 100, schedule: (callback, ms) => { assert.equal(ms, 100); expire = callback; return 7; }, cancelSchedule: id => cleared.push(id) });
    expire(); assert.equal(await pending.promise, false); assert.equal(link.removed, true); assert.equal(link.onload, null); assert.deepEqual(cleared, [7]); pending.cancel(); assert.deepEqual(cleared, [7]);
});

test('synchronous and asynchronous loader failures are consumed and leave mounted roots classic', async () => {
    for (const loadStyles of [() => { throw Error('load denied'); }, () => ({ promise: Promise.reject(Error('load denied')), cancel() {} })]) {
        let errors = [];
        const session = createQianmuAppearanceSession({ readSettings: () => ({ appearance: preference }), loadStyles, onError: error => errors.push(error.message) });
        const root = element(); session.mount(root); await session.sync(); await session.sync();
        assert.deepEqual(errors, ['load denied']); assert.equal(root.getAttribute('data-qm-theme'), null); session.reset();
    }
});

test('unsupported weak references add no mounts or stylesheet request; invalid owners fail fast', async () => {
    const session = createQianmuAppearanceSession({ readSettings: () => ({ appearance: preference }), WeakReference: null, loadStyles: () => assert.fail('unexpected stylesheet request') });
    assert.equal(session.status,'unsupported');
    session.mount(element()); const portal=element();portal.style.setProperty('--sd-text','untouched');session.mountPortal(portal);assert.equal(portal.style.getPropertyValue('--sd-text'),'untouched');
    assert.equal(await session.sync(), false); assert.equal(session.size, 0); session.reset();
    assert.throws(() => createQianmuAppearanceSession(), TypeError);
});

test('late native dialog scroll is captured through its actual modal parent without a second mount', async () => {
    const f = fixture(), root = element(), main = element(); let attached = false;
    root.contains = node => attached && node === main;
    root.querySelectorAll = selector => attached && selector.includes('dialog.sd-bundle-dialog > main') ? [main] : [];
    f.set({ appearance: preference }); f.session.mount(root); const ready = f.session.sync(); f.loads[0].resolve(true); await ready;
    attached = true; main.scrollTop = 137; main.scrollLeft = 9;
    const paint = root.style.setProperty;
    root.style.setProperty = (...args) => { paint(...args); if (args[0] === '--sd-text') { main.scrollTop = 205; main.scrollLeft = 0; } };
    f.set({ appearance: { ...preference, mode: 'dark' } }); await f.session.sync();
    assert.equal(main.scrollTop, 137); assert.equal(main.scrollLeft, 9); assert.equal(f.session.size, 1);
    attached = false; main.isConnected = false; await f.session.sync(); f.session.reset();
});

test('production native reviews retain the modal ancestry used by inherited appearance and scroll protection', async () => {
    const source = await readFile(new URL('../index.js', import.meta.url), 'utf8');
    const body = name => source.match(new RegExp(`^async function ${name}\\([\\s\\S]*?(?=^(?:async )?function |$(?![\\s\\S]))`, 'm'))?.[0] || '';
    assert.match(body('storyboardOpenRestoreStorage'), /manager\.openMappingRegistry:manager\.openRestoreStorageManager\)\(\{parent:modal/);
    assert.match(body('storyboardOpenRestoreStorage'), /modal\s*=\s*document\.getElementById\(MODAL_ID\)/);
    assert.match(body('storyboardOpenUserAliases'), /openUserAliasReview\(\{parent:document\.getElementById\(MODAL_ID\)/);
    for (const name of ['storyboardReviewRecordLink', 'storyboardImportBundle']) {
        assert.match(body(name), /const parent = document\.getElementById\(MODAL_ID\)/);
        assert.match(body(name), /openStoryboard(?:Link|Bundle)Review\(\{ parent,/);
    }
});

test('late focus voice, library and drawer scrolling belongs to the existing modal registration', async () => {
    for (const selector of ['.sd-focus-voice-menu', '.sd-focus-library-body', '.sd-focus-voice-drawer-list']) {
        const f = fixture(), root = element(), scroll = element(); let attached = false;
        root.contains = node => attached && node === scroll;
        root.querySelectorAll = query => attached && query.split(',').includes(selector) ? [scroll] : [];
        f.set({ appearance: preference }); f.session.mount(root); const ready = f.session.sync(); f.loads[0].resolve(true); await ready;
        attached = true; scroll.scrollTop = 173;
        const paint = root.style.setProperty;
        root.style.setProperty = (...args) => { paint(...args); if (args[0] === '--sd-text') scroll.scrollTop = 0; };
        f.set({ appearance: { ...preference, family: 'editorial', mode: 'dark' } }); await f.session.sync();
        assert.equal(scroll.scrollTop, 173, selector); assert.equal(f.session.size, 1);
        attached = false; scroll.isConnected = false; f.session.reset();
    }
});

test('late theater reading scroll belongs to the existing modal registration', async () => {
    const f = fixture(), root = element(), scroll = element(); let attached = false;
    root.contains = node => attached && node === scroll;
    root.querySelectorAll = query => attached && query.split(',').includes('.sd-theater-reader-scroll') ? [scroll] : [];
    f.set({ appearance: preference }); f.session.mount(root); const ready = f.session.sync(); f.loads[0].resolve(true); await ready;
    attached = true; scroll.scrollTop = 193; scroll.scrollLeft = 11;
    const paint = root.style.setProperty;
    root.style.setProperty = (...args) => { paint(...args); if (args[0] === '--sd-text') { scroll.scrollTop = 0; scroll.scrollLeft = 0; } };
    f.set({ appearance: { ...preference, family: 'editorial', mode: 'dark' } }); await f.session.sync();
    assert.equal(scroll.scrollTop, 193); assert.equal(scroll.scrollLeft, 11); assert.equal(f.session.size, 1);
    attached = false; scroll.isConnected = false; f.session.reset();
});

test('motion viewer keeps its existing detail scroll through a palette layout change', async () => {
    const f = fixture(), root = element(), detail = element();
    root.contains = node => node === detail;
    root.querySelectorAll = query => query.split(',').includes('.sd-storyboard-video-viewer > aside') ? [detail] : [];
    f.set({ appearance: preference });
    const off = f.session.mountPortal(root, { role: 'media' }), ready = f.session.sync();
    f.loads[0].resolve(true); await ready; detail.scrollTop = 149;
    const paint = root.style.setProperty;
    root.style.setProperty = (...args) => { paint(...args); if (args[0] === '--sd-text') detail.scrollTop = 0; };
    f.set({ appearance: { ...preference, family: 'editorial', mode: 'dark' } }); await f.session.sync();
    assert.equal(detail.scrollTop, 149); assert.equal(root.getAttribute('data-qm-mode'), 'dark');
    off(); assert.equal(f.session.size, 0); f.session.reset();
});

test('fixed-workflow popup captures its own native scroll areas and releases them with its owner', async () => {
    const f=fixture(),root=element(),scrollers=[element(),element()];
    root.contains=node=>scrollers.includes(node);
    root.querySelectorAll=selectors=>['.sd-comfy-route-picker','.sd-comfy-route-dialog .popup-content'].flatMap((selector,index)=>selectors.split(',').includes(selector)?[scrollers[index]]:[]);
    f.set({appearance:preference});const off=f.session.mountPortal(root),ready=f.session.sync();f.loads[0].resolve(true);await ready;
    scrollers.forEach((node,index)=>{node.scrollTop=70+index;node.scrollLeft=3;});
    const paint=root.style.setProperty;
    root.style.setProperty=(...args)=>{paint(...args);if(args[0]==='--sd-text')scrollers.forEach(node=>{node.scrollTop=0;node.scrollLeft=0;});};
    f.set({appearance:{...preference,mode:'dark'}});await f.session.sync();
    assert.deepEqual(scrollers.map(node=>[node.scrollTop,node.scrollLeft]),[[70,3],[71,3]]);
    off();off();assert.equal(f.session.size,0);assert.equal(root.getAttribute('data-qm-theme'),null);f.session.reset();
});

test('video draft picker and confirmation retain their separate scroll offsets through palette writes', async () => {
    for (const selector of ['.sd-storyboard-video-draft-picker-grid', '.sd-video-confirmation-body']) {
        const f = fixture(), root = element(), scroll = element();
        root.contains = node => node === scroll;
        root.querySelectorAll = query => query.split(',').includes(selector) ? [scroll] : [];
        f.set({ appearance: preference });
        const off = f.session.mountPortal(root, { role: 'media' }), ready = f.session.sync();
        f.loads[0].resolve(true); await ready; scroll.scrollTop = 171; scroll.scrollLeft = 3;
        const paint = root.style.setProperty;
        root.style.setProperty = (...args) => { paint(...args); if (args[0] === '--sd-text') { scroll.scrollTop = 0; scroll.scrollLeft = 0; } };
        f.set({ appearance: { ...preference, family: 'editorial', mode: 'dark' } }); await f.session.sync();
        assert.equal(scroll.scrollTop, 171, selector); assert.equal(scroll.scrollLeft, 3, selector);
        off(); assert.equal(f.session.size, 0); f.session.reset();
    }
});

test('film viewer keeps independent detail and segment-strip scroll through palette writes', async () => {
    for (const selector of ['.sd-storyboard-film-viewer > aside', '.sd-storyboard-film-viewer-segments']) {
        const f = fixture(), root = element(), scroll = element();
        root.contains = node => node === scroll;
        root.querySelectorAll = query => query.split(',').includes(selector) ? [scroll] : [];
        f.set({ appearance: preference });
        const off = f.session.mountPortal(root, { role: 'media' }), ready = f.session.sync();
        f.loads[0].resolve(true); await ready; scroll.scrollTop = 181; scroll.scrollLeft = 133;
        const paint = root.style.setProperty;
        root.style.setProperty = (...args) => { paint(...args); if (args[0] === '--sd-text') { scroll.scrollTop = 0; scroll.scrollLeft = 0; } };
        f.set({ appearance: { ...preference, family: 'editorial', mode: 'dark' } }); await f.session.sync();
        assert.equal(scroll.scrollTop, 181, selector); assert.equal(scroll.scrollLeft, 133, selector);
        off(); assert.equal(f.session.size, 0); f.session.reset();
    }
});

test('film source grids retain their scroll while an editor changes appearance', async () => {
    const f = fixture(), root = element(), scroll = element();
    root.contains = node => node === scroll;
    root.querySelectorAll = query => query.split(',').includes('.sd-storyboard-film-source-grid') ? [scroll] : [];
    f.set({ appearance: preference });
    const off = f.session.mount(root), ready = f.session.sync(); f.loads[0].resolve(true); await ready;
    scroll.scrollTop = 137;
    const paint = root.style.setProperty;
    root.style.setProperty = (...args) => { paint(...args); if (args[0] === '--sd-text') scroll.scrollTop = 0; };
    f.set({ appearance: { ...preference, family: 'editorial', mode: 'dark' } }); await f.session.sync();
    assert.equal(scroll.scrollTop, 137); off(); f.session.reset();
});
