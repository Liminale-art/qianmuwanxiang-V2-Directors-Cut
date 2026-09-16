import { THEME_KEYS } from './qianmu-classic-palettes.js';
import { readAppearancePreferences, updateAppearancePreferences } from './qianmu-appearance-settings.js';

/** The app owns its existing native settings save. No new persistence or renderer. */
export function selectQianmuClassicTheme({ settings, themeKey, session, save, resolveLogo }) {
    if (!settings || !THEME_KEYS.includes(themeKey) || typeof save !== 'function' || typeof resolveLogo !== 'function') throw new TypeError('Invalid classic appearance action.');
    const before = { theme: settings.theme, appearance: settings.appearance, hasAppearance: Object.hasOwn(settings, 'appearance'), hasTheme: Object.hasOwn(settings, 'theme') };
    // Validate a future/unknown preference record BEFORE changing settings or DOM.
    const next = before.hasAppearance ? updateAppearancePreferences(settings, { family: 'classic' }) : null;
    const changed = before.theme !== themeKey || readAppearancePreferences(settings).family !== 'classic';
    if (!changed) return false;
    try {
        settings.theme = themeKey;
        if (next) settings.appearance = next;
        session.repaintClassic({ resolveLogo });
        save(); // Native debounced save requested; not a promise of durable disk completion.
    } catch (error) {
        if (before.hasTheme) settings.theme = before.theme; else delete settings.theme;
        if (before.hasAppearance) settings.appearance = before.appearance; else delete settings.appearance;
        try { session.repaintClassic({ resolveLogo }); } catch { /* Preserve the original error. */ }
        throw error;
    }
    return true;
}
