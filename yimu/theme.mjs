const TOKENS = Object.freeze({
    '--ym-ink': ['--qm-ink', '--sd-text'],
    '--ym-muted': ['--qm-muted', '--sd-muted'],
    '--ym-surface': ['--qm-bg', '--sd-window-bg'],
    '--ym-card': ['--qm-surface', '--sd-card', '--sd-glass'],
    '--ym-raised': ['--qm-raised', '--sd-input-bg', '--sd-folder-head'],
    '--ym-border': ['--qm-line', '--sd-border', '--sd-hairline'],
    '--ym-accent': ['--qm-accent', '--sd-accent'],
    '--ym-on-accent': ['--qm-on-accent', '--sd-primary-text'],
    '--ym-danger': ['--qm-danger', '--sd-danger'],
    '--ym-glow-1': ['--qm-glow-1'],
    '--ym-glow-2': ['--qm-glow-2'],
    '--ym-card-material': ['--qm-skin-material'],
    '--ym-card-shadow': ['--qm-skin-shadow'],
    '--ym-card-filter': ['--qm-skin-filter'],
    '--ym-window-material': ['--qm-skin-window'],
    '--ym-title-gradient': ['--sd-title-grad'],
    '--ym-type-page-title': ['--qm-type-page-title'],
    '--ym-type-feature-title': ['--qm-type-feature-title'],
    '--ym-type-card-title': ['--qm-type-card-title'],
    '--ym-type-body': ['--qm-type-body'],
    '--ym-type-label': ['--qm-type-label'],
    '--ym-type-caption': ['--qm-type-caption'],
});
const SOURCE_IDS = ['story-director-modal', 'story-director-float'];
const ATTRIBUTES = ['class', 'style', 'data-qm-theme', 'data-qm-mode'];
// qianmu-font-runtime excludes owned qm-/sd- surfaces from its layered ST
// !important font rules. Join that same boundary instead of fighting it with
// a second font cascade (layered !important rules beat unlayered ones).
const FONT_SURFACE_CLASS = 'qm-yimu-surface';
// Same opaque reader surfaces as qianmu-classic-palettes.js. Kept local so the
// independently installed Yimu bundle never imports the Qianmu extension.
const CLASSIC_SURFACES = Object.freeze({
    light: '#f3efe7', dark: '#1c1e22', summer: '#e9f5ee',
    candy: '#faf0f4', kraft: '#f1e7cf', dream: '#f0eff8',
});

/** Read the optional Qianmu surface without sharing its settings or lifetime. */
export function mountTheme(root, { document = root?.ownerDocument || globalThis.document } = {}) {
    const window = document?.defaultView;
    if (!root?.style?.setProperty || !root.style.getPropertyValue || !window?.getComputedStyle) {
        return { sync() {}, destroy() {} };
    }
    const originals = new Map();
    const written = new Map();
    const originalAttributes = new Map();
    const writtenAttributes = new Map();
    const classTokens = () => String(root.getAttribute('class') || '').split(/\s+/).filter(Boolean);
    const ownsFontClass = !classTokens().includes(FONT_SURFACE_CLASS);
    if (ownsFontClass) root.setAttribute('class', [...classTokens(), FONT_SURFACE_CLASS].join(' '));
    let source = null;
    let disposed = false;
    const read = (style, name) => String(style?.getPropertyValue?.(name) || '').trim();
    const findSource = () => SOURCE_IDS.map(id => document.getElementById?.(id))
        .find(node => node && node !== root && node.isConnected !== false) || null;
    function put(name, value) {
        if (!originals.has(name)) originals.set(name, read(root.style, name));
        const next = value || originals.get(name);
        if (read(root.style, name) !== next) {
            if (next) root.style.setProperty(name, next);
            else root.style.removeProperty(name);
        }
        written.set(name, next);
    }
    function attribute(name, value) {
        if (!originalAttributes.has(name)) originalAttributes.set(name, root.getAttribute(name));
        if (root.getAttribute(name) !== value) root.setAttribute(name, value);
        writtenAttributes.set(name, value);
    }
    const Observer = window.MutationObserver;
    const sourceObserver = Observer ? new Observer(() => sync()) : null;
    const bodyObserver = Observer ? new Observer(() => {
        if (!disposed && findSource() !== source) sync();
    }) : null;
    function sync() {
        if (disposed) return;
        const next = findSource();
        if (next !== source) {
            sourceObserver?.disconnect();
            source = next;
            if (source) sourceObserver?.observe(source, { attributes: true, attributeFilter: ATTRIBUTES });
        }
        const style = source ? window.getComputedStyle(source) : null;
        const usable = !!(read(style, '--qm-ink') || read(style, '--sd-text'));
        const family = usable ? source.getAttribute('data-qm-theme') : '';
        const theme = family === 'editorial' || family === 'glass' ? family : 'classic';
        const dark = usable && (source.getAttribute('data-qm-mode') === 'dark'
            || (!family && source.classList?.contains('sd-theme-dark')));
        for (const [target, candidates] of Object.entries(TOKENS)) {
            put(target, usable ? candidates.map(name => read(style, name)).find(Boolean) || '' : '');
        }
        if (usable && theme === 'classic') {
            const key = Object.keys(CLASSIC_SURFACES).find(name => source.classList?.contains(`sd-theme-${name}`))
                || (dark ? 'dark' : 'light');
            // --sd-window-bg is translucent; detached reader-like panels use
            // the classic portal base, not the modal's blur layer.
            put('--ym-surface', read(style, '--sd-portal-bg') || CLASSIC_SURFACES[key]);
        }
        attribute('data-ym-theme', theme);
        attribute('data-ym-mode', dark ? 'dark' : 'light');
        // Consume the actual installed Qianmu font resource and computed family.
        // Do not keep a second, approximately matching paper/glass font stack here.
        const fontTokens = theme === 'editorial' ? ['--qm-editorial-font']
            : theme === 'glass' ? ['--qm-glass-font'] : ['--qm-interface-font', '--sd-font', '--mainFontFamily'];
        put('--ym-font', usable ? fontTokens.map(name => read(style, name)).find(Boolean)
            || String(style.fontFamily || '').trim() : '');
    }
    if (document.body) bodyObserver?.observe(document.body, { childList: true });
    document.fonts?.addEventListener?.('loadingdone', sync);
    sync();
    return {
        sync,
        destroy() {
            if (disposed) return;
            disposed = true;
            sourceObserver?.disconnect();
            bodyObserver?.disconnect();
            document.fonts?.removeEventListener?.('loadingdone', sync);
            for (const [name, value] of written) {
                if (read(root.style, name) !== value) continue;
                const before = originals.get(name);
                if (before) root.style.setProperty(name, before);
                else root.style.removeProperty(name);
            }
            for (const [name, value] of writtenAttributes) {
                if (root.getAttribute(name) !== value) continue;
                const before = originalAttributes.get(name);
                if (before === null) root.removeAttribute(name);
                else root.setAttribute(name, before);
            }
            if (ownsFontClass) {
                const remaining = classTokens().filter(name => name !== FONT_SURFACE_CLASS);
                if (remaining.length) root.setAttribute('class', remaining.join(' '));
                else root.removeAttribute('class');
            }
            source = null;
        },
    };
}
