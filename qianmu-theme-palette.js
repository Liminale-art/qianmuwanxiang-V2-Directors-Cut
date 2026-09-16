/**
 * Pure, opaque sRGB palette tokens for the optional Qianmu theme studies.
 * Color mathematics: https://www.w3.org/TR/css-color-4/#ok-lab
 * Contrast: https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html
 *
 * The OKLCH gamut fit below is a bounded constant-hue/chroma-reduction search,
 * not an implementation of the browser's complete CSS gamut-mapping algorithm.
 * No image, logo, DOM, host theme, storage, or network is read or changed here.
 */

const MIN_TEXT_CONTRAST = 4.5;
const BASES = {
    editorial: {
        light: {
            bg: [0.958, 0.012, 85], surface: [0.979, 0.009, 85], raised: [0.993, 0.004, 85],
            ink: [0.245, 0.010, 65], muted: [0.475, 0.012, 65], line: [0.835, 0.015, 85],
        },
        dark: {
            bg: [0.205, 0.010, 65], surface: [0.240, 0.010, 65], raised: [0.285, 0.011, 65],
            ink: [0.925, 0.010, 85], muted: [0.735, 0.013, 85], line: [0.375, 0.014, 65],
        },
    },
    glass: {
        light: {
            // White canvas and neutral opaque fallbacks; colored diffusion stays in the glow roles.
            bg: [1, 0, 0], surface: [0.980, 0, 0], raised: [0.993, 0, 0],
            ink: [0.245, 0.023, 255], muted: [0.475, 0.024, 255], line: [0.830, 0.023, 255],
        },
        dark: {
            bg: [0.165, 0.025, 255], surface: [0.220, 0.024, 255], raised: [0.275, 0.025, 255],
            ink: [0.940, 0.008, 255], muted: [0.745, 0.018, 255], line: [0.380, 0.030, 255],
        },
    },
};

function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}

function normalizeHex(value) {
    if (typeof value !== 'string' || ![4, 7].includes(value.length)
        || !/^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(value)) {
        throw new TypeError('accent must be exactly #RGB or #RRGGBB.');
    }
    const hex = value.toLowerCase();
    return hex.length === 4 ? `#${[...hex.slice(1)].map((digit) => digit + digit).join('')}` : hex;
}

function linearChannels(hex) {
    return [1, 3, 5].map((offset) => {
        const encoded = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
        return encoded <= 0.04045 ? encoded / 12.92 : ((encoded + 0.055) / 1.055) ** 2.4;
    });
}

function hexToOklch(hex) {
    const [r, g, b] = linearChannels(hex);
    const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
    const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
    const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
    const lightness = 0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s;
    const a = 1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s;
    const labB = 0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s;
    const chroma = Math.hypot(a, labB);
    // Neutral seeds have no meaningful hue: do not invent a colored accent.
    if (chroma < 0.00001) return [lightness, 0, 0];
    return [lightness, chroma, (Math.atan2(labB, a) * 180 / Math.PI + 360) % 360];
}

function oklchToLinear(lightness, chroma, hue) {
    const angle = hue * Math.PI / 180;
    const a = chroma * Math.cos(angle);
    const b = chroma * Math.sin(angle);
    const l = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3;
    const m = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3;
    const s = (lightness - 0.0894841775 * a - 1.2914855480 * b) ** 3;
    return [
        4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
        -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
        -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s,
    ];
}

function isInGamut(channels) {
    return channels.every((channel) => channel >= -1e-9 && channel <= 1 + 1e-9);
}

function color(lightness, chroma, hue) {
    const safeLightness = clamp(lightness, 0, 1);
    let channels = oklchToLinear(safeLightness, chroma, hue);
    if (!isInGamut(channels)) {
        let low = 0;
        let high = chroma;
        for (let step = 0; step < 28; step += 1) {
            const middle = (low + high) / 2;
            if (isInGamut(oklchToLinear(safeLightness, middle, hue))) low = middle;
            else high = middle;
        }
        channels = oklchToLinear(safeLightness, low, hue);
    }
    return `#${channels.map((channel) => {
        // Clamping only removes floating-point residue after the chroma fit.
        const linear = clamp(channel, 0, 1);
        const encoded = linear <= 0.0031308 ? linear * 12.92 : 1.055 * linear ** (1 / 2.4) - 0.055;
        return Math.round(encoded * 255).toString(16).padStart(2, '0');
    }).join('')}`;
}

function luminance(hex) {
    const [r, g, b] = linearChannels(hex);
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrastRatio(foreground, background) {
    const a = luminance(foreground);
    const b = luminance(background);
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

function worstContrast(foreground, backgrounds) {
    return Math.min(...backgrounds.map((background) => contrastRatio(foreground, background)));
}

function readableText([lightness, chroma, hue], backgrounds, mode) {
    const endpoint = mode === 'light' ? 0 : 1;
    // Verify the final 8-bit hex, not the higher-precision intermediate color.
    for (let step = 0; step <= 100; step += 1) {
        const candidate = color(lightness + (endpoint - lightness) * step / 100, chroma, hue);
        if (worstContrast(candidate, backgrounds) >= MIN_TEXT_CONTRAST) return candidate;
    }
    // All authored bases are light or dark together, so one endpoint is safe.
    throw new RangeError('Theme surfaces cannot share a readable text color.');
}

function actionText(background) {
    return contrastRatio('#ffffff', background) >= contrastRatio('#000000', background)
        ? '#ffffff' : '#000000';
}

/**
 * Build an immutable palette. `accent` returns the normalized user seed;
 * `css['--qm-accent']` is its mode-appropriate, gamut-fitted action color.
 *
 * contrast.text / contrast.muted are the worst ratios across the three opaque
 * bg/surface/raised tokens; contrast.action is on-accent against accent.
 * These numbers DO NOT certify translucent glass over arbitrary content,
 * accent-colored text, borders, focus indicators, images, or whole-page WCAG.
 * A renderer must separately verify its actual composited backgrounds.
 *
 * @param {{theme?: 'editorial'|'glass', mode?: 'light'|'dark', accent?: string}} [options]
 * @returns {{theme: string, mode: string, accent: string, css: Readonly<Record<string, string>>, contrast: Readonly<{text: number, muted: number, action: number}>}}
 */
export function createThemePalette({ theme = 'editorial', mode = 'light', accent = '#8b584a' } = {}) {
    if (theme !== 'editorial' && theme !== 'glass') {
        throw new TypeError('theme must be editorial or glass.');
    }
    if (mode !== 'light' && mode !== 'dark') {
        throw new TypeError('mode must be light or dark.');
    }
    const seed = normalizeHex(accent);
    const [seedLightness, seedChroma, seedHue] = hexToOklch(seed);
    const dark = mode === 'dark';
    const glass = theme === 'glass';
    const base = BASES[theme][mode];
    const background = color(...base.bg);
    const surface = color(...base.surface);
    const raised = color(...base.raised);
    const backgrounds = [background, surface, raised];
    const accentChroma = Math.min(seedChroma, glass ? 0.20 : 0.16);
    const action = color(clamp(seedLightness, dark ? 0.67 : 0.38, dark ? 0.80 : 0.60), accentChroma, seedHue);
    const ink = readableText(base.ink, backgrounds, mode);
    const muted = readableText(base.muted, backgrounds, mode);
    const onAccent = actionText(action);
    const danger = color(dark ? 0.73 : 0.54, 0.18, 25);
    const css = Object.freeze({
        '--qm-bg': background,
        '--qm-surface': surface,
        '--qm-raised': raised,
        '--qm-ink': ink,
        '--qm-muted': muted,
        '--qm-line': color(...base.line),
        '--qm-accent': action,
        '--qm-on-accent': onAccent,
        '--qm-accent-soft': color(dark ? 0.33 : 0.92, Math.min(accentChroma * 0.35, 0.045), seedHue),
        '--qm-glow-1': color(dark ? 0.44 : 0.86, Math.min(accentChroma * (glass ? 0.70 : 0.35), glass ? 0.11 : 0.05), seedHue),
        '--qm-glow-2': color(dark ? 0.37 : 0.90, Math.min(accentChroma * (glass ? 0.50 : 0.22), glass ? 0.085 : 0.035), (seedHue + 55) % 360),
        '--qm-danger': danger,
        '--qm-on-danger': actionText(danger),
    });
    const contrast = Object.freeze({
        text: worstContrast(ink, backgrounds),
        muted: worstContrast(muted, backgrounds),
        action: contrastRatio(onAccent, action),
    });
    return Object.freeze({ theme, mode, accent: seed, css, contrast });
}
