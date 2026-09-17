import { QIANMU_THEME_PROPERTIES } from './qianmu-theme-surfaces.js';
import { THEME_KEYS, QUICK_HIVE_THEME_PALETTES, READER_PORTAL_BG } from './qianmu-classic-palettes.js';

const CLASSIC_KEYS = new Set(THEME_KEYS);
/** A portal may have copied NEW colors from the main panel before registration.
 * Replace only those copied inline aliases with their clean classic baseline, so
 * reversible theme ownership never mistakes new colors for the classic original.
 * The probe shares the actual stylesheet declarations, has no duplicate ID, and
 * is removed synchronously even if computed-style resolution fails. */
export function prepareQianmuPortalBaseline(root, themeKey) {
    const properties = QIANMU_THEME_PROPERTIES.filter(name => root.style.getPropertyValue(name));
    if (!properties.length) return;
    const tokens = readClassicTokens(root.ownerDocument, themeKey);
    for (const name of properties) {
        if (tokens[name]) root.style.setProperty(name, tokens[name]);
        else root.style.removeProperty(name);
    }
}

function readClassicTokens(document, themeKey) {
    const probe = document.createElement('div');
    probe.className = `qm-classic-theme-probe sd-theme-${CLASSIC_KEYS.has(themeKey) ? themeKey : 'light'}`;
    probe.hidden = true; probe.setAttribute('aria-hidden', 'true');
    probe.style.setProperty('display', 'none', 'important');
    document.body.appendChild(probe);
    try {
        const computed = document.defaultView.getComputedStyle(probe);
        return Object.fromEntries(QIANMU_THEME_PROPERTIES.map(name => [name, computed.getPropertyValue(name).trim()]));
    } finally { probe.remove(); }
}

/** Run only after the runtime has released its temporary new-theme overrides.
 * The caller owns these roots. No child replacement, random colours or host scan. */
export function createQianmuClassicPainter(document, themeKey, { resolveLogo } = {}) {
    if (!CLASSIC_KEYS.has(themeKey)) throw new TypeError('Unknown classic theme.');
    const tokens = readClassicTokens(document, themeKey), palette = QUICK_HIVE_THEME_PALETTES[themeKey];
    const logo = resolveLogo?.(themeKey);
    return (root, { role = 'surface', tone = null, edgeIndex = 0 } = {}) => {
        for (const prefix of ['sd-theme-', 'sd-hive-theme-']) {
            const existing = THEME_KEYS.map(key => prefix + key).filter(name => root.classList.contains(name));
            if (existing.length) { root.classList.remove(...existing); root.classList.add(prefix + themeKey); }
        }
        if (root.id !== 'story-director-modal') for (const name of QIANMU_THEME_PROPERTIES) {
            if (!root.style.getPropertyValue(name)) continue;
            const priority = root.style.getPropertyPriority(name);
            if (tokens[name]) root.style.setProperty(name, tokens[name], priority);
            else root.style.removeProperty(name);
        }
        if (role === 'reader') {
            root.style.setProperty('--sd-portal-bg', READER_PORTAL_BG[themeKey]);
            root.style.setProperty('background-color', READER_PORTAL_BG[themeKey]);
            for (const name of QIANMU_THEME_PROPERTIES) if (tokens[name]) root.style.setProperty(name, tokens[name]);
        }
        if (role === 'hive-entry' || role === 'notes-entry') {
            const mode = tone || (themeKey === 'dark' ? 'dark' : 'light');
            for (const [name, value] of [['--sd-wheel-glass-fill', palette[mode + 'Fill']], ['--sd-wheel-icon', palette[mode + 'Icon']], ['--sd-wheel-edge', palette.edges[edgeIndex % palette.edges.length]], ['background-color', palette[mode + 'Fill']], ['color', palette[mode + 'Icon']]]) root.style.setProperty(name, value, 'important');
        }
        if (role === 'hive-main') {
            root.style.setProperty('--sd-float-edge', palette.mainEdge, 'important');
            root.style.setProperty('background-color', palette.mainFill, 'important');
            const image = root.querySelector('img');
            if (image && logo && image.getAttribute('src') !== logo) image.setAttribute('src', logo);
        }
    };
}
