import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { ensureToastLiquid, toastLiquidSupported, lensMapPixels, TOAST_LIQUID_FILTER_ID, TOAST_LIQUID_ATTR } from '../qianmu-toast-liquid.js';
import { validateReleasePlan } from '../scripts/build-release.mjs';

const root = new URL('../', import.meta.url);

function documentDouble(userAgent, brands, { canvas = true } = {}) {
  const byId = new Map(), attrs = {};
  const element = tag => {
    const node = { tagName: tag, attrs: {}, children: [], parentNode: null,
      setAttribute(name, value) { this.attrs[name] = String(value); if (name === 'id') byId.set(String(value), this); },
      append(...nodes) { for (const child of nodes) { child.parentNode = this; this.children.push(child); } },
      remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(child => child !== this); byId.delete(this.attrs.id); this.parentNode = null; },
    };
    return node;
  };
  const body = element('body');
  return {
    body, byId,
    documentElement: { setAttribute(name, value) { attrs[name] = String(value); }, removeAttribute(name) { delete attrs[name]; }, attrs },
    defaultView: { navigator: { userAgent, userAgentData: brands ? { brands } : undefined } },
    createElementNS: (_ns, tag) => element(tag),
    createElement: tag => tag === 'canvas' && canvas ? { getContext: () => ({ createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }), putImageData() {} }), toDataURL: () => 'data:image/png;base64,AAAA' } : element(tag),
    getElementById: id => byId.get(id) || null,
  };
}

const CHROME = 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36';
const SAFARI = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const IOS_CHROME = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/130.0 Mobile/15E148 Safari/604.1';
const FIREFOX = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:132.0) Gecko/20100101 Firefox/132.0';

test('only Chromium engines get the refraction filter; WebKit and Gecko keep plain frosted glass', () => {
  assert.equal(toastLiquidSupported({ userAgent: CHROME }), true);
  assert.equal(toastLiquidSupported({ userAgent: '', userAgentData: { brands: [{ brand: 'Chromium', version: '130' }] } }), true, 'client hints, where exposed');
  for (const agent of [SAFARI, IOS_CHROME, FIREFOX, '']) assert.equal(toastLiquidSupported({ userAgent: agent }), false, agent);
});

test('the filter is mounted once as a page node with a fixed id, and the html mark follows support', () => {
  const doc = documentDouble(CHROME);
  assert.equal(ensureToastLiquid(doc), true); assert.equal(ensureToastLiquid(doc), true);
  assert.equal(doc.body.children.length, 1, 'mounted once');
  const holder = doc.body.children[0], filter = holder.children[0];
  assert.equal(filter.tagName, 'filter'); assert.equal(filter.attrs.id, TOAST_LIQUID_FILTER_ID);
  assert.equal(holder.attrs['aria-hidden'], 'true');
  const steps = filter.children.map(node => node.tagName);
  assert.equal(steps[0], 'feImage', 'a lens map drawn for the capsule');
  assert.equal(filter.children[0].attrs.href, 'data:image/png;base64,AAAA'); assert.equal(filter.children[0].attrs.preserveAspectRatio, 'none', 'stretched over whatever size the toast has');
  assert.equal(steps.filter(tag => tag === 'feDisplacementMap').length, 3, 'one shift per colour channel for dispersion at the rim');
  const scales = filter.children.filter(node => node.tagName === 'feDisplacementMap').map(node => Number(node.attrs.scale));
  assert.ok(new Set(scales).size === 3 && scales.every(value => value < 0), 'sampled inward: the rim bends like a lens, each channel slightly differently');
  assert.ok(!steps.includes('feTurbulence'), 'no noise ripple: refraction follows the shape');
  const plain = documentDouble(CHROME, undefined, { canvas: false });
  assert.equal(ensureToastLiquid(plain), false, 'no map can be drawn → plain frosted glass'); assert.equal(TOAST_LIQUID_ATTR in plain.documentElement.attrs, false);
  assert.equal(doc.documentElement.attrs[TOAST_LIQUID_ATTR], '');
  const safari = documentDouble(SAFARI);
  safari.documentElement.setAttribute(TOAST_LIQUID_ATTR, '');
  assert.equal(ensureToastLiquid(safari), false);
  assert.equal(safari.body.children.length, 0); assert.equal(TOAST_LIQUID_ATTR in safari.documentElement.attrs, false);
  assert.equal(ensureToastLiquid(null), false);
});

test('the glass toast references the filter only behind the Chromium mark, with an opaque fallback without blur', async () => {
  const css = await readFile(new URL('style.css', root), 'utf8');
  const iris = css.split('\n').filter(line => line.includes('data-qm-toast="iris"')).join('\n');
  assert.match(iris, /html\[data-qm-toast="iris"\]\[data-qm-toast-liquid\] body #toast-container > div \{ --lq-tint: color-mix\(in srgb, var\(--qm-toast-bg\) 1\d%, transparent\); backdrop-filter: url\(#qm-toast-liquid\) blur\([12]px\)/, 'behind the mark: nearly clear, the lens does the work');
  assert.equal(iris.match(/url\(#qm-toast-liquid\)/g).length, 2, 'standard and prefixed declaration, both behind the mark');
  assert.match(iris, /html\[data-qm-toast="iris"\] body\.no-blur #toast-container > div \{ --lq-tint: color-mix\(in srgb, var\(--qm-toast-bg\) 9\d%, transparent\) !important; --lq-ink: var\(--qm-toast-ink\); --lq-text-halo: transparent; backdrop-filter: none !important;/, 'ST "no blur": an opaque card with the toast theme\'s own ink instead of an unreadable clear one, even over the clear liquid tint');
  assert.doesNotMatch(iris.split(/\r?\n/).find(line => line.includes('#toast-container > div { --iris-glow')), /0 0 \d+px color-mix\(in srgb, var\(--qm-toast-status\)/, 'no status-coloured glow around the frame; the bell carries the status');
  assert.match(css, /@supports not \(\(backdrop-filter: blur\(1px\)\) or \(-webkit-backdrop-filter: blur\(1px\)\)\) \{\s*html\[data-qm-toast="iris"\] body #toast-container > div \{ --lq-tint: color-mix\(in srgb, var\(--qm-toast-bg\) 9\d%/);
  assert.doesNotMatch(css, /data:image\/svg\+xml[^"]*fe(?:Turbulence|DisplacementMap)/, 'no filter is embedded in a stylesheet data URI');
  const index = await readFile(new URL('index.js', root), 'utf8');
  assert.match(index, /getLook:\(\)=>\(ensureToastLiquid\(document\),qianmuToastLook\(\)\)/, 'mounted when the toast skin is applied');
});

test('the release plan accepts the stylesheet and ships the filter module', async () => {
  const config = JSON.parse(await readFile(new URL('release-files.json', root), 'utf8'));
  assert.ok(config.files.includes('qianmu-toast-liquid.js'));
  await validateReleasePlan(); // throws on any unlisted local dependency
});

test('the lens map is still in the middle and bends outward toward the capsule rim', () => {
  const width = 480, height = 64, data = lensMapPixels(width, height), at = (x, y) => { const i = (y * width + x) * 4; return [data[i], data[i + 1]]; };
  assert.deepEqual(at(240, 32), [128, 128], 'centre: no shift');
  assert.ok(at(240, 1)[1] < 110 && at(240, 62)[1] > 146, 'top and bottom rims push vertically, in opposite directions');
  assert.ok(at(1, 32)[0] < 110 && at(478, 32)[0] > 146, 'the round ends push sideways');
  assert.equal(at(240, 1)[0], 128, 'along the straight edge there is no sideways shift');
});
