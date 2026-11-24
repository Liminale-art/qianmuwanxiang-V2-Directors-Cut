// 「玻璃」提示框的液态折射。backdrop-filter 只能用 url(#…) 引用同一页面里的 SVG 滤镜，
// 所以这枚滤镜以带 id 的节点挂到页面上一次，样式表里不写任何内嵌 SVG。
// 折射像一块透镜：中间几乎不变形，越靠胶囊边缘，透过来的背景越被往里拉弯（位移图按胶囊形状算出，画在 canvas 上）；
// 红绿蓝三个通道的位移略有差别，边缘带一点色散。
// 只有 Chromium 内核会把 url() 滤镜用在背景上；其它浏览器（或画不出位移图时）不挂标记，样式退回普通毛玻璃。
export const TOAST_LIQUID_FILTER_ID = 'qm-toast-liquid';
export const TOAST_LIQUID_ATTR = 'data-qm-toast-liquid';
const HOLDER_ID = 'qm-toast-liquid-defs';
const SVG_NS = 'http://www.w3.org/2000/svg';
// 位移图的尺寸按常见的一行提示框的比例画；实际提示框更宽或更高时整张拉伸贴上，边缘仍是边缘。
const MAP_WIDTH = 480, MAP_HEIGHT = 64;
// 负值：从边缘往里取样，边缘处的背景被放大、拉弯，像透过一块凸透镜。三通道略有差别形成色散。
export const TOAST_LIQUID_SCALES = Object.freeze([['r', -40], ['g', -36], ['b', -32]]);

export function toastLiquidSupported(navigator) {
  const brands = navigator?.userAgentData?.brands;
  if (Array.isArray(brands) && brands.some(item => /Chromium/i.test(item?.brand || ''))) return true;
  const agent = String(navigator?.userAgent || '');
  // iOS 上各家浏览器都是 WebKit 内核，即使界面写着 Chrome 也不支持。
  return /\b(?:Chrome|Chromium)\/\d+/.test(agent) && !/\b(?:CriOS|EdgiOS|FxiOS|OPiOS)\b|iPhone|iPad|iPod/.test(agent);
}

/** 胶囊形透镜的位移图：R 是横向、G 是纵向，128 为不动；越靠边缘越强，方向朝外（滤镜里用负值，于是向里取样）。 */
export function lensMapPixels(width = MAP_WIDTH, height = MAP_HEIGHT) {
  const data = new Uint8ClampedArray(width * height * 4), radius = height / 2, band = radius * 0.92;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const px = x + 0.5, py = y + 0.5, cx = Math.min(Math.max(px, radius), width - radius);
    const vx = px - cx, vy = py - radius, length = Math.hypot(vx, vy);
    const inside = radius - length, t = Math.min(1, Math.max(0, 1 - inside / band)), strength = t * t * t;
    const nx = length ? vx / length : 0, ny = length ? vy / length : 0, at = (y * width + x) * 4;
    data[at] = Math.round(128 + 127 * strength * nx); data[at + 1] = Math.round(128 + 127 * strength * ny); data[at + 2] = 128; data[at + 3] = 255;
  }
  return data;
}

function lensMapUrl(document) {
  try {
    const canvas = document.createElement?.('canvas'), context = canvas?.getContext?.('2d');
    if (!context || typeof canvas.toDataURL !== 'function') return '';
    canvas.width = MAP_WIDTH; canvas.height = MAP_HEIGHT;
    const image = context.createImageData(MAP_WIDTH, MAP_HEIGHT); image.data.set(lensMapPixels());
    context.putImageData(image, 0, 0);
    return canvas.toDataURL('image/png');
  } catch { return ''; }
}

const CHANNEL_MATRIX = { r: '1 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0', g: '0 0 0 0 0  0 1 0 0 0  0 0 0 0 0  0 0 0 1 0', b: '0 0 0 0 0  0 0 0 0 0  0 0 1 0 0  0 0 0 1 0' };

function buildFilter(document, map) {
  const node = (tag, attributes = {}) => {
    const element = document.createElementNS(SVG_NS, tag);
    for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, String(value));
    return element;
  };
  const holder = node('svg', {id: HOLDER_ID, width: 0, height: 0, 'aria-hidden': 'true', focusable: 'false'});
  holder.setAttribute('style', 'position:absolute;width:0;height:0;overflow:hidden;pointer-events:none');
  const filter = node('filter', {id: TOAST_LIQUID_FILTER_ID, x: 0, y: 0, width: '100%', height: '100%', 'color-interpolation-filters': 'sRGB'});
  // 位移图铺满整个滤镜区域（不保持比例）：提示框多宽多高，透镜就贴多宽多高。
  filter.append(node('feImage', {href: map, preserveAspectRatio: 'none', result: 'lens'}));
  for (const [name, scale] of TOAST_LIQUID_SCALES) {
    filter.append(
      node('feDisplacementMap', {in: 'SourceGraphic', in2: 'lens', scale, xChannelSelector: 'R', yChannelSelector: 'G', result: `${name}-shift`}),
      node('feColorMatrix', {in: `${name}-shift`, type: 'matrix', values: CHANNEL_MATRIX[name], result: name}),
    );
  }
  filter.append(node('feBlend', {in: 'r', in2: 'g', mode: 'screen', result: 'rg'}), node('feBlend', {in: 'rg', in2: 'b', mode: 'screen', result: 'bent'}),
    node('feGaussianBlur', {in: 'bent', stdDeviation: 0.4}));
  holder.append(filter);
  return holder;
}

/** 挂上滤镜并在 <html> 上标记；不支持的浏览器、或画不出位移图时去掉标记。可反复调用，只会挂一次。 */
export function ensureToastLiquid(document = globalThis.document) {
  const root = document?.documentElement;
  if (!root?.setAttribute || !document.body) return false;
  if (!toastLiquidSupported(document.defaultView?.navigator)) { root.removeAttribute(TOAST_LIQUID_ATTR); return false; }
  if (!document.getElementById(TOAST_LIQUID_FILTER_ID)) {
    const map = lensMapUrl(document);
    if (!map) { root.removeAttribute(TOAST_LIQUID_ATTR); return false; }
    document.getElementById(HOLDER_ID)?.remove();
    document.body.append(buildFilter(document, map));
  }
  root.setAttribute(TOAST_LIQUID_ATTR, '');
  return true;
}
