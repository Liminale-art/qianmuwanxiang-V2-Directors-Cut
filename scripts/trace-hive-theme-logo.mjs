// Maintainer-only vector derivation, never imported by the extension.
// Trace the bundled original PNG, including its transparent film perforations.
// No artistic redrawing, network requests, or source image changes.
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const sharp = require(process.env.QIANMU_SHARP_MODULE || 'sharp');
const { data, info } = await sharp(fileURLToPath(new URL('../qianmulogo.png', import.meta.url))).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
const { width, height } = info;
const layers = [new Uint8Array(width * height), new Uint8Array(width * height)];
for (let pixel = 0; pixel < width * height; pixel++) {
    const offset = pixel * 4;
    if (data[offset + 3] < 96) continue;
    layers[data[offset] + data[offset + 1] + data[offset + 2] < 390 ? 0 : 1][pixel] = 1;
}
function simplify(points, epsilon = .85) {
    if (points.length < 3) return points;
    const start = points[0], end = points.at(-1), dx = end[0] - start[0], dy = end[1] - start[1], length = dx * dx + dy * dy;
    let furthest = 0, index = 0;
    for (let i = 1; i < points.length - 1; i++) {
        const t = length ? Math.max(0, Math.min(1, ((points[i][0] - start[0]) * dx + (points[i][1] - start[1]) * dy) / length)) : 0;
        const distance = (points[i][0] - start[0] - t * dx) ** 2 + (points[i][1] - start[1] - t * dy) ** 2;
        if (distance > furthest) { furthest = distance; index = i; }
    }
    return furthest > epsilon ** 2 ? [...simplify(points.slice(0, index + 1), epsilon).slice(0, -1), ...simplify(points.slice(index), epsilon)] : [start, end];
}
function trace(mask) {
    const edges = new Map(), stride = width + 1;
    const key = (x, y) => y * stride + x;
    const occupied = (x, y) => x >= 0 && y >= 0 && x < width && y < height && mask[y * width + x];
    function edge(x, y, nextX, nextY, direction) {
        const start = key(x, y), list = edges.get(start) || [];
        list.push({ end: key(nextX, nextY), direction }); edges.set(start, list);
    }
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) if (occupied(x, y)) {
        if (!occupied(x, y - 1)) edge(x, y, x + 1, y, 0);
        if (!occupied(x + 1, y)) edge(x + 1, y, x + 1, y + 1, 1);
        if (!occupied(x, y + 1)) edge(x + 1, y + 1, x, y + 1, 2);
        if (!occupied(x - 1, y)) edge(x, y + 1, x, y, 3);
    }
    const paths = [];
    while (edges.size) {
        const start = edges.keys().next().value, points = [];
        let cursor = start, previous = null;
        do {
            points.push([cursor % stride, Math.floor(cursor / stride)]);
            const list = edges.get(cursor);
            if (!list?.length) throw Error('Open logo contour');
            const rank = direction => previous === null ? 0 : [1, 0, 3, 2][(direction - previous + 4) % 4];
            list.sort((a, b) => rank(a.direction) - rank(b.direction));
            const next = list.shift(); if (!list.length) edges.delete(cursor);
            cursor = next.end; previous = next.direction;
        } while (cursor !== start);
        const area = Math.abs(points.reduce((sum, p, i) => { const n = points[(i + 1) % points.length]; return sum + p[0] * n[1] - n[0] * p[1]; }, 0)) / 2;
        if (area < 6) continue; // Subpixel specks at a 48 px hive size, not structural holes.
        const reduced = simplify([...points, points[0]]).slice(0, -1);
        if (reduced.length >= 3) paths.push('M' + reduced.map(point => point.join(',')).join('L') + 'Z');
    }
    return paths.join('');
}
const paths = layers.map(trace);
const source = `// Mechanically traced from qianmulogo.png by scripts/trace-hive-theme-logo.mjs.\n// Keep the original butterfly, stars, Mobius ribbon and film perforations.\n// CSS custom properties recolor the two original regions without rebuilding DOM.\nexport const QIANMU_HIVE_THEME_LOGO = '<svg class="qm-hive-theme-logo" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" aria-hidden="true" focusable="false" style="display:none"><path fill="var(--qm-ink)" fill-rule="evenodd" d="${paths[0]}"/><path fill="var(--qm-accent)" fill-rule="evenodd" d="${paths[1]}"/></svg>';\n`;
process.stdout.write(source);
