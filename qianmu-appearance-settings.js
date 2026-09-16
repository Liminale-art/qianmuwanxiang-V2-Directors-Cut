// Additive preferences: settings.theme remains the user's last classic choice.
// Reading old/invalid/future settings never rewrites the original configuration.
export const APPEARANCE_VERSION = 1;
export const APPEARANCE_DEFAULT_ACCENT = '#5c79d3';
const choices = Object.freeze({ family: ['classic', 'editorial', 'glass'], mode: ['light', 'dark'], source: ['cover', 'manual'], harmony: ['dominant', 'complementary'] });
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const color = value => {
    if (typeof value !== 'string' || !/^#(?:[a-f\d]{3}|[a-f\d]{6})$/i.test(value)) return null;
    const hex = value.toLowerCase(); return hex.length === 4 ? '#' + [...hex.slice(1)].map(char => char + char).join('') : hex;
};

export function readAppearancePreferences(settings = {}) {
    const value = record(settings?.appearance) && settings.appearance.version === APPEARANCE_VERSION ? settings.appearance : {};
    return Object.freeze({ version: APPEARANCE_VERSION,
        family: choices.family.includes(value.family) ? value.family : 'classic',
        mode: choices.mode.includes(value.mode) ? value.mode : settings?.theme === 'dark' ? 'dark' : 'light',
        accent: color(value.accent) || APPEARANCE_DEFAULT_ACCENT,
        source: choices.source.includes(value.source) ? value.source : 'cover',
        harmony: choices.harmony.includes(value.harmony) ? value.harmony : 'dominant',
    });
}

/** Validate a UI edit; the caller owns the native settings save and error reporting. */
export function updateAppearancePreferences(settings, patch) {
    if (!record(patch)) throw new TypeError('Appearance changes must be an object.');
    if (record(settings?.appearance) && settings.appearance.version !== undefined && settings.appearance.version !== APPEARANCE_VERSION) {
        throw new TypeError('Unsupported appearance version; keep the original settings.');
    }
    const next = { ...readAppearancePreferences(settings) };
    for (const [key, value] of Object.entries(patch)) {
        if (key === 'accent') {
            const hex = color(value); if (!hex) throw new TypeError('Accent must be #RGB or #RRGGBB.'); next.accent = hex;
        } else if (Object.hasOwn(choices, key) && choices[key].includes(value)) next[key] = value;
        else throw new TypeError(`Invalid appearance field: ${key}`);
    }
    return Object.freeze(next);
}

/** Cover analysis is supplied by the cover owner; never decode media or read gallery data here. */
export function appearanceThemeOptions(preferences, coverAccent = null) {
    if (preferences.family === 'classic') return null;
    const sampled = preferences.source === 'cover' ? color(coverAccent) : null;
    return Object.freeze({ theme: preferences.family, mode: preferences.mode, accent: sampled || preferences.accent });
}
