/**
 * Select an accent seed from a caller-owned, already downsampled RGBA image.
 * This is a bounded deterministic colour heuristic, not image understanding.
 * It returns no CSS or semantic tokens: use the theme palette's contrast and
 * danger-colour rules after selection. No browser, persistence or network I/O.
 */
export const MAX_IMAGE_ACCENT_PIXELS = 16_384;

const HUE_BINS = 24;

function normalizedHex(value) {
    if (typeof value !== 'string' || !/^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(value)) {
        throw new TypeError('fallback must be exactly #RGB or #RRGGBB.');
    }
    const hex = value.toLowerCase();
    return hex.length === 4 ? `#${[...hex.slice(1)].map((digit) => digit + digit).join('')}` : hex;
}

function rgbToHsl(r, g, b) {
    const high = Math.max(r, g, b), low = Math.min(r, g, b), span = high - low;
    const lightness = (high + low) / 510;
    if (!span) return [0, 0, lightness];
    const sector = high === r ? (g - b) / span : high === g ? (b - r) / span + 2 : (r - g) / span + 4;
    return [(sector * 60 + 360) % 360, span / (255 - Math.abs(high + low - 255)), lightness];
}

function toHex(channels) {
    return `#${channels.map((channel) => Math.round(channel).toString(16).padStart(2, '0')).join('')}`;
}

function hslToHex(hue, saturation, lightness) {
    const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
    const x = chroma * (1 - Math.abs((hue / 60) % 2 - 1));
    const base = lightness - chroma / 2;
    const sectors = [[chroma, x, 0], [x, chroma, 0], [0, chroma, x], [0, x, chroma], [x, 0, chroma], [chroma, 0, x]];
    return toHex(sectors[Math.floor(hue / 60) % 6].map((value) => (value + base) * 255));
}

function clamp(value, lower, upper) {
    return Math.min(upper, Math.max(lower, value));
}

/**
 * @param {{ pixels: Uint8Array|Uint8ClampedArray|number[], mode?: 'dominant'|'complementary', fallback?: string }} options
 * @returns {Readonly<{accent:string, source:'image'|'fallback', mode:string,
 *   dominant:string|null, sampledPixels:number, eligiblePixels:number, reason:string|null}>}
 */
export function selectImageAccent(options) {
    if (!options || typeof options !== 'object' || Array.isArray(options)) {
        throw new TypeError('An options object containing RGBA pixels is required.');
    }
    const { pixels, mode = 'dominant', fallback = '#8b584a' } = options;
    const safeFallback = normalizedHex(fallback);
    if (!['dominant', 'complementary'].includes(mode)) {
        throw new TypeError('mode must be dominant or complementary.');
    }
    if (!(pixels instanceof Uint8Array) && !(pixels instanceof Uint8ClampedArray) && !Array.isArray(pixels)) {
        throw new TypeError('pixels must be an unsigned byte array or an array of integer RGBA bytes.');
    }
    if (pixels.length > MAX_IMAGE_ACCENT_PIXELS * 4 || pixels.length % 4 !== 0) {
        throw new RangeError(`pixels must contain complete RGBA samples, at most ${MAX_IMAGE_ACCENT_PIXELS} pixels.`);
    }
    const sampledPixels = pixels.length / 4;
    // Each bin stores exact integer sums. Even the maximum accepted image stays
    // well below Number.MAX_SAFE_INTEGER, so reordering pixels cannot break ties.
    const bins = Array.from({ length: HUE_BINS }, () => ({ weight: 0, r: 0, g: 0, b: 0 }));
    let eligiblePixels = 0;
    for (let offset = 0; offset < pixels.length; offset += 4) {
        const [r, g, b, alpha] = [pixels[offset], pixels[offset + 1], pixels[offset + 2], pixels[offset + 3]];
        if (![r, g, b, alpha].every((value) => Number.isInteger(value) && value >= 0 && value <= 255)) {
            throw new TypeError('Every RGBA channel must be an integer between 0 and 255.');
        }
        const span = Math.max(r, g, b) - Math.min(r, g, b);
        const [hue, saturation, lightness] = rgbToHsl(r, g, b);
        // Ignore transparency and near-neutral highlights/shadows instead of
        // turning white borders, black bars or alpha RGB garbage into an accent.
        if (alpha < 32 || span < 24 || saturation < 0.12 || lightness < 0.10 || lightness > 0.90) continue;
        eligiblePixels += 1;
        const bin = bins[Math.floor(hue / 15) % HUE_BINS];
        // Area is primary. Chroma boosts a pixel by at most 1.5x, so a tiny vivid
        // object does not outrank a broad muted field merely by being saturated.
        const weight = alpha * (256 + Math.min(span, 128));
        bin.weight += weight;
        bin.r += r * weight; bin.g += g * weight; bin.b += b * weight;
    }
    if (!eligiblePixels) {
        return Object.freeze({
            accent: safeFallback, source: 'fallback', mode, dominant: null,
            sampledPixels, eligiblePixels, reason: sampledPixels ? 'no-usable-color' : 'empty',
        });
    }

    let selected = 0, bestScore = -1, bestCenter = -1;
    for (let index = 0; index < HUE_BINS; index += 1) {
        const score = bins[(index + HUE_BINS - 1) % HUE_BINS].weight + bins[index].weight + bins[(index + 1) % HUE_BINS].weight;
        // Circular neighbours prevent reds around 0/360 degrees from splitting.
        // Equal populations resolve by centre weight, then canonical hue order.
        if (score > bestScore || (score === bestScore && bins[index].weight > bestCenter)) {
            selected = index; bestScore = score; bestCenter = bins[index].weight;
        }
    }
    const cluster = [(selected + HUE_BINS - 1) % HUE_BINS, selected, (selected + 1) % HUE_BINS];
    const total = cluster.reduce((sum, index) => sum + bins[index].weight, 0);
    const rgb = ['r', 'g', 'b'].map((channel) => cluster.reduce((sum, index) => sum + bins[index][channel], 0) / total);
    const [hue, saturation, lightness] = rgbToHsl(...rgb);
    const complementary = mode === 'complementary';
    const accent = hslToHex(
        complementary ? (hue + 180) % 360 : hue,
        clamp(saturation, 0.20, complementary ? 0.48 : 0.62),
        complementary ? 0.50 : clamp(lightness, 0.40, 0.60),
    );
    return Object.freeze({
        accent, source: 'image', mode, dominant: toHex(rgb),
        sampledPixels, eligiblePixels, reason: null,
    });
}
