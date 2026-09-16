import { readAppearancePreferences, appearanceThemeOptions } from './qianmu-appearance-settings.js';
import { createQianmuThemeSurfaceController } from './qianmu-theme-surfaces.js';

/**
 * Explicit, weakly held mount registry. No document query, observer, polling, renderer,
 * storage or provider calls. Register attached roots at their own mount boundary;
 * dispose them on unmount when possible. Detached roots are also pruned on sync/mount.
 * Each weak-map value owns its surface controller, not the global registry, so a
 * missed caller disposal cannot strongly retain a detached document tree forever.
 * Owners may supply scrollTargets() for their known scroll containers. Snapshot
 * them before palette writes and restore after layout to counter native anchoring.
 */
export function createQianmuAppearanceRuntime({ readSettings, readCoverAccent = () => null, WeakReference = globalThis.WeakRef } = {}) {
    if (typeof readSettings !== 'function' || typeof readCoverAccent !== 'function') throw new TypeError('Appearance readers are required.');
    const supported = typeof WeakReference === 'function', roots = new WeakMap(), references = new Set();
    let disposed = false, preferences = null;
    const assertLive = () => { if (disposed) throw new Error('Appearance runtime is disposed.'); };
    function current() {
        const next = readAppearancePreferences(readSettings());
        const accent = supported && next.family !== 'classic' && next.source === 'cover' ? readCoverAccent(next.harmony) : null;
        return { preferences: next, options: supported ? appearanceThemeOptions(next, accent) : null };
    }
    function prune() {
        for (const ref of references) {
            const root = ref.deref();
            if (root?.isConnected) continue;
            if (root) { roots.get(root)?.controller.dispose(); roots.delete(root); }
            references.delete(ref);
        }
    }
    function captureScroll(entries) {
        const positions = new Map();
        for (const { root, scrollTargets } of entries) for (const target of scrollTargets()) {
            if (!target?.isConnected || (target !== root && !root.contains?.(target))) throw new TypeError('Scroll targets must belong to the registered root.');
            if (!positions.has(target)) positions.set(target, { top: target.scrollTop, left: target.scrollLeft });
        }
        return () => {
            for (const [target, position] of positions) {
                if (!target.isConnected) continue;
                // Reading scroll offsets resolves pending layout/anchoring first.
                if (target.scrollTop !== position.top) target.scrollTop = position.top;
                if (target.scrollLeft !== position.left) target.scrollLeft = position.left;
            }
        };
    }
    return Object.freeze({
        supported,
        get preferences() { return preferences; },
        get size() { prune(); return references.size; },
        sync() {
            assertLive();
            // Finish preference/cover reads before changing any existing surface.
            const next = current(); prune();
            const entries = [...references].map(ref => roots.get(ref.deref())).filter(Boolean);
            const restoreScroll = captureScroll(entries);
            try { for (const entry of entries) entry.controller.setTheme(next.options); }
            finally { restoreScroll(); }
            preferences = next.preferences;
            return preferences;
        },
        register(root, { scrollTargets = () => [], ...options } = {}) {
            assertLive();
            if (!supported) return () => {};
            if (!root?.isConnected) throw new TypeError('Register an attached Qianmu root.');
            if (roots.has(root)) throw new Error('Appearance root is already registered.');
            if (typeof scrollTargets !== 'function') throw new TypeError('Scroll targets must be supplied by their owner.');
            const next = current(); prune();
            const controller = createQianmuThemeSurfaceController();
            const restoreScroll = captureScroll([{ root, scrollTargets }]);
            try { controller.register(root, options); controller.setTheme(next.options); }
            catch (error) { controller.dispose(); throw error; }
            finally { restoreScroll(); }
            const ref = new WeakReference(root), entry = { root, controller, ref, scrollTargets };
            roots.set(root, entry); references.add(ref); preferences = next.preferences;
            let active = true;
            return () => {
                if (!active) return; active = false;
                controller.dispose(); references.delete(ref);
                if (roots.get(root) === entry) roots.delete(root);
            };
        },
        dispose() {
            if (disposed) return; disposed = true;
            for (const ref of references) {
                const root = ref.deref();
                if (root) { roots.get(root)?.controller.dispose(); roots.delete(root); }
            }
            references.clear(); preferences = null;
        },
    });
}
