import { readAppearancePreferences } from './qianmu-appearance-settings.js';
import { createQianmuAppearanceRuntime } from './qianmu-appearance-runtime.js';
import { prepareQianmuPortalBaseline, createQianmuClassicPainter } from './qianmu-appearance-portals.js';
import { THEME_KEYS } from './qianmu-classic-palettes.js';

const SCROLL_TARGETS = '.sd-body,.sd-storyboard-scroll,.sd-note-list,.sd-notes-list-view,.sd-scroll,.sd-reader-body,.sd-reader-prose,.sd-theater-reader-scroll,.sd-theater-fs-body,.sd-storage-cleanup-list,.sd-storage-chat-groups,.sd-storyboard-lightbox-stage,.sd-storyboard-lightbox-detail,.sd-storyboard-video-viewer > aside,.sd-storyboard-video-draft-body,.sd-storyboard-video-draft-picker-grid,.sd-video-confirmation-body,.sd-storyboard-film-viewer > aside,.sd-storyboard-film-viewer-segments,.sd-storyboard-film-source-grid,dialog.sd-bundle-dialog > main,.sd-focus-voice-menu,.sd-focus-library-body,.sd-focus-voice-drawer-list,.sd-comfy-route-picker,.sd-comfy-route-dialog .popup-content,textarea';

// Load once, after the existing stylesheet. Classic sessions make no request.
export function loadQianmuAppearanceStyles(document, url, { timeoutMs = 8000, schedule = setTimeout, cancelSchedule = clearTimeout } = {}) {
    const link = document.createElement('link'); link.rel = 'stylesheet'; link.href = String(url);
    let settle, done = false, timer;
    const promise = new Promise(resolve => { settle = resolve; });
    function finish(loaded) {
        if (done) return; done = true; cancelSchedule(timer); link.onload = link.onerror = null;
        if (!loaded) link.remove(); settle(loaded);
    }
    link.onload = () => finish(true); link.onerror = () => finish(false);
    timer = schedule(() => finish(false), timeoutMs);
    document.head.appendChild(link);
    return { promise, cancel() { finish(false); link.remove(); } };
}

/** App-owned mount boundaries, not a document observer. Never renders or saves. */
export function createQianmuAppearanceSession({ readSettings, styleUrl, document = globalThis.document,
    readCoverAccent, loadStyles = () => loadQianmuAppearanceStyles(document, styleUrl), onError = () => {}, WeakReference = globalThis.WeakRef } = {}) {
    if (typeof readSettings !== 'function' || typeof loadStyles !== 'function' || typeof onError !== 'function') throw new TypeError('Appearance session callbacks are required.');
    let ready = false, loading = null, failed = false, epoch = 0, mounted = new WeakMap();
    const createRuntime = () => createQianmuAppearanceRuntime({
        readSettings: () => ready ? readSettings() : { theme: readSettings()?.theme }, readCoverAccent, WeakReference,
    });
    let runtime = createRuntime();
    function sync() {
        runtime.sync();
        if (!runtime.supported || ready || failed || readAppearancePreferences(readSettings()).family === 'classic') return Promise.resolve(ready);
        if (!loading) {
            const started = epoch;
            try { loading = loadStyles(); }
            catch (error) { failed = true; onError(error); return Promise.resolve(false); }
            loading.result = Promise.resolve(loading.promise).then(loaded => {
                if (started !== epoch) return false;
                ready = loaded === true; failed = !ready;
                if (ready) runtime.sync();
                else onError(new Error('Qianmu appearance stylesheet could not load; keeping classic.'));
                return ready;
            }, error => {
                if (started === epoch) { failed = true; onError(error); }
                return false;
            });
        }
        return loading.result;
    }
    function mount(root, { role = 'surface', tone = null, edgeIndex = 0 } = {}) {
        if (!root?.isConnected || !runtime.supported) return () => {};
        // Register only this caller-owned subtree's known scroll containers.
        const signature = `${role}/${tone}/${edgeIndex}`, prior = mounted.get(root);
        if (prior?.signature === signature && runtime.has(root)) { void sync(); return prior.off; }
        prior?.off();
        const release = runtime.register(root, { role, tone, edgeIndex,
            scrollTargets: () => [root, ...root.querySelectorAll(SCROLL_TARGETS)],
        });
        let active = true;
        const entry = { signature, off() { if (!active) return; active = false; release(); if (mounted.get(root) === entry) mounted.delete(root); } };
        mounted.set(root, entry); if (!ready) void sync(); return entry.off;
    }
    function mountNotes(ownerDocument) {
        const panel = ownerDocument.getElementById('qianmu-notes-panel-layer'), floating = ownerDocument.getElementById('qianmu-notes-float-layer');
        mount(panel); mount(floating);
        const entry = floating?.querySelector('.sd-detached-notes-entry');
        const appearance = readSettings()?.notes?.appearance || {};
        const index = Number(appearance.edgeIndex);
        mount(entry, { role: 'hive-entry', tone: appearance.tone === 'light' ? 'light' : 'dark', edgeIndex: Number.isFinite(index) ? Math.max(0, Math.trunc(index)) : 0 });
    }
    return Object.freeze({
        get supported() { return runtime.supported; },
        get ready() { return ready; },
        get status() { return !runtime.supported ? 'unsupported' : ready ? 'ready' : failed ? 'error' : loading ? 'loading' : 'idle'; },
        get size() { return runtime.size; },
        sync, mount, mountNotes,
        repaintClassic(options) {
            if (!runtime.supported) return;
            const key = readSettings()?.theme;
            runtime.rebaseClassic(createQianmuClassicPainter(document, THEME_KEYS.includes(key) ? key : 'light', options));
        },
        mountPortal(root, options) {
            if (!root?.isConnected || !runtime.supported) return () => {};
            if (!runtime.has(root) && readAppearancePreferences(readSettings()).family !== 'classic') prepareQianmuPortalBaseline(root, readSettings()?.theme);
            return mount(root, options);
        },
        mountHive(root) {
            mount(root);
            for (const button of root.querySelectorAll('[data-hive-tone]')) {
                mount(button, { role: 'hive-entry', tone: button.dataset.hiveTone === 'light' ? 'light' : 'dark', edgeIndex: Math.max(0, Math.trunc(Number(button.dataset.hiveEdgeIndex) || 0)) });
            }
        },
        retry() { if (failed) { failed = false; loading?.cancel(); loading = null; } return sync(); },
        reset() { epoch++; runtime.dispose(); loading?.cancel(); loading = null; ready = false; failed = false; mounted = new WeakMap(); runtime = createRuntime(); },
    });
}
