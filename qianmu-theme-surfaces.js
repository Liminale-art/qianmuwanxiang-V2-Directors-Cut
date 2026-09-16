import { createThemePalette } from './qianmu-theme-palette.js';

// Explicit opt-in surfaces only. No host lookup, observer, renderer, storage or network.
const ALIASES = Object.freeze({
    '--sd-window-bg': '--qm-bg', '--sd-text': '--qm-ink', '--sd-muted': '--qm-muted',
    '--sd-border': '--qm-line', '--sd-hairline': '--qm-line', '--sd-glass': '--qm-surface',
    '--sd-glass-weak': '--qm-raised', '--sd-card': '--qm-surface', '--sd-folder-head': '--qm-raised',
    '--sd-sticky-bg': '--qm-bg', '--sd-pre': '--qm-raised', '--sd-input-bg': '--qm-raised',
    '--sd-accent': '--qm-accent', '--sd-check-mark': '--qm-on-accent',
    '--sd-primary': '--qm-accent', '--sd-primary-text': '--qm-on-accent',
    '--sd-danger': '--qm-danger', '--sd-on-danger': '--qm-on-danger',
});

/** Opaque fallback tokens; glass composition and readability still need renderer-level checks. */
export function createQianmuThemeSnapshot(options = {}) {
    const palette = createThemePalette(options);
    const tokens = { ...palette.css };
    for (const [alias, token] of Object.entries(ALIASES)) tokens[alias] = palette.css[token];
    const hive = {};
    for (const mode of ['light', 'dark']) {
        const { css } = mode === palette.mode ? palette : createThemePalette({ ...options, mode });
        hive[mode] = Object.freeze({
            fill: `color-mix(in srgb, ${css['--qm-surface']} 60%, transparent)`,
            icon: css['--qm-ink'],
            edges: Object.freeze([css['--qm-line'], css['--qm-accent'], css['--qm-glow-2']]),
        });
    }
    return Object.freeze({ ...palette, tokens: Object.freeze(tokens), hive: Object.freeze(hive) });
}

function surfaceOptions({ role = 'surface', tone = null, edgeIndex = 0 } = {}) {
    if (!['surface', 'hive-entry', 'hive-main'].includes(role)) throw new TypeError('Unknown theme surface role.');
    if (tone !== null && tone !== 'light' && tone !== 'dark') throw new TypeError('Invalid hive tone.');
    if (!Number.isSafeInteger(edgeIndex) || edgeIndex < 0) throw new TypeError('Invalid hive edge index.');
    return Object.freeze({ role, tone, edgeIndex });
}

const readStyle = (root, name) => ({ value: root.style.getPropertyValue(name), priority: root.style.getPropertyPriority(name) });
const sameStyle = (a, b) => a.value === b.value && a.priority === b.priority;
function writeStyle(root, name, value) {
    if (value.value) root.style.setProperty(name, value.value, value.priority);
    else root.style.removeProperty(name);
}

/**
 * Register each main panel, portal or floating entry at its own mount boundary.
 * setTheme(null) restores classic inline values; unregister/dispose release references.
 * Children, focus, input, geometry, drag capture, listeners and media are never rebuilt.
 * Existing classic classes are deliberately not removed. Late portals get the same snapshot
 * even when the main panel is absent. Callers own mounting/unmounting; no global DOM scans.
 */
export function createQianmuThemeSurfaceController() {
    const surfaces = new Map();
    let snapshot = null, disposed = false;
    const assertLive = () => { if (disposed) throw new Error('Theme surface controller is disposed.'); };

    function patchStyle(record, name, value, priority = '') {
        const now = readStyle(record.root, name), held = record.styles.get(name);
        // An intervening owner edit becomes the new restoration baseline, not stale startup state.
        const before = held && sameStyle(now, held.applied) ? held.before : now;
        const next = { value, priority };
        if (!sameStyle(now, next)) writeStyle(record.root, name, next);
        record.styles.set(name, { before, applied: readStyle(record.root, name) });
    }
    function patchAttribute(record, name, value) {
        const now = record.root.getAttribute(name), held = record.attributes.get(name);
        const before = held && now === held.applied ? held.before : now;
        if (now !== value) record.root.setAttribute(name, value);
        record.attributes.set(name, { before, applied: value });
    }
    function restore(record) {
        for (const [name, held] of record.styles) {
            if (sameStyle(readStyle(record.root, name), held.applied)) writeStyle(record.root, name, held.before);
        }
        for (const [name, held] of record.attributes) {
            if (record.root.getAttribute(name) !== held.applied) continue;
            if (held.before === null) record.root.removeAttribute(name);
            else record.root.setAttribute(name, held.before);
        }
        record.styles.clear(); record.attributes.clear();
    }
    function apply(record) {
        if (!snapshot) { restore(record); return; }
        for (const [name, value] of Object.entries(snapshot.tokens)) patchStyle(record, name, value);
        patchAttribute(record, 'data-qm-theme', snapshot.theme);
        patchAttribute(record, 'data-qm-mode', snapshot.mode);
        if (record.options.role === 'hive-entry') {
            const { tone, edgeIndex } = record.options;
            const visual = snapshot.hive[tone || snapshot.mode];
            patchStyle(record, '--sd-wheel-glass-fill', visual.fill, 'important');
            patchStyle(record, '--sd-wheel-icon', visual.icon, 'important');
            patchStyle(record, '--sd-wheel-edge', visual.edges[edgeIndex % visual.edges.length], 'important');
            patchStyle(record, 'color', visual.icon, 'important');
            // Existing hive buttons lock their fill inline; update only its color longhand,
            // preserving any separately owned background image, position and repeat settings.
            patchStyle(record, 'background-color', visual.fill, 'important');
        }
        if (record.options.role === 'hive-main') {
            const visual = snapshot.hive[snapshot.mode];
            patchStyle(record, '--sd-float-edge', snapshot.tokens['--sd-accent'], 'important');
            patchStyle(record, 'background-color', visual.fill, 'important');
        }
    }
    return Object.freeze({
        get snapshot() { return snapshot; },
        get size() { return surfaces.size; },
        setTheme(options) {
            assertLive();
            // Validate and finish all palette work before touching a live surface.
            const next = options === null ? null : createQianmuThemeSnapshot(options);
            snapshot = next;
            for (const record of surfaces.values()) apply(record);
            return next;
        },
        register(root, options) {
            assertLive();
            if (!root || root.nodeType !== 1 || !root.style || !root.getAttribute
                || root === root.ownerDocument?.body || root === root.ownerDocument?.documentElement) {
                throw new TypeError('Register a Qianmu element, never the host body or document root.');
            }
            if (surfaces.has(root)) throw new Error('Theme surface is already registered.');
            const record = { root, options: surfaceOptions(options), styles: new Map(), attributes: new Map() };
            surfaces.set(root, record);
            try { apply(record); } catch (error) { restore(record); surfaces.delete(root); throw error; }
            let active = true;
            return () => {
                if (!active) return;
                active = false;
                if (surfaces.get(root) !== record) return;
                restore(record); surfaces.delete(root);
            };
        },
        dispose() {
            if (disposed) return;
            for (const record of surfaces.values()) restore(record);
            surfaces.clear(); snapshot = null; disposed = true;
        },
    });
}
