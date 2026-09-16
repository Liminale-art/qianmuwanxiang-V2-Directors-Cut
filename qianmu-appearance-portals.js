import { QIANMU_THEME_PROPERTIES } from './qianmu-theme-surfaces.js';

const CLASSIC_KEYS = new Set(['light', 'dark', 'summer', 'candy', 'kraft', 'dream']);
/** A portal may have copied NEW colors from the main panel before registration.
 * Replace only those copied inline aliases with their clean classic baseline, so
 * reversible theme ownership never mistakes new colors for the classic original.
 * The probe shares the actual stylesheet declarations, has no duplicate ID, and
 * is removed synchronously even if computed-style resolution fails. */
export function prepareQianmuPortalBaseline(root, themeKey) {
    const properties = QIANMU_THEME_PROPERTIES.filter(name => root.style.getPropertyValue(name));
    if (!properties.length) return;
    const document = root.ownerDocument, probe = document.createElement('div');
    probe.className = `qm-classic-theme-probe sd-theme-${CLASSIC_KEYS.has(themeKey) ? themeKey : 'light'}`;
    probe.hidden = true; probe.setAttribute('aria-hidden', 'true');
    probe.style.setProperty('display', 'none', 'important');
    document.body.appendChild(probe);
    try {
        const computed = document.defaultView.getComputedStyle(probe);
        const values = properties.map(name => [name, computed.getPropertyValue(name).trim()]);
        for (const [name, value] of values) {
            if (value) root.style.setProperty(name, value);
            else root.style.removeProperty(name);
        }
    } finally { probe.remove(); }
}
