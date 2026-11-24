// 「玻璃」提示框的液态折射。backdrop-filter 只能用 url(#…) 引用同一页面里的 SVG 滤镜，
// 所以这枚滤镜以带 id 的节点挂到页面上一次，样式表里不写任何内嵌 SVG。
// 只有 Chromium 内核会把 url() 滤镜用在背景上；其它浏览器不挂标记，样式退回普通毛玻璃加高光边。
export const TOAST_LIQUID_FILTER_ID = 'qm-toast-liquid';
export const TOAST_LIQUID_ATTR = 'data-qm-toast-liquid';
const HOLDER_ID = 'qm-toast-liquid-defs';
const SVG_NS = 'http://www.w3.org/2000/svg';

export function toastLiquidSupported(navigator) {
  const brands = navigator?.userAgentData?.brands;
  if (Array.isArray(brands) && brands.some(item => /Chromium/i.test(item?.brand || ''))) return true;
  const agent = String(navigator?.userAgent || '');
  // iOS 上各家浏览器都是 WebKit 内核，即使界面写着 Chrome 也不支持。
  return /\b(?:Chrome|Chromium)\/\d+/.test(agent) && !/\b(?:CriOS|EdgiOS|FxiOS|OPiOS)\b|iPhone|iPad|iPod/.test(agent);
}

// 三个颜色通道各按略有不同的强度位移，再叠回一起：折射边缘带一点细微的色散。
const CHANNELS = [['r', 15, '1 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0'], ['g', 12, '0 0 0 0 0  0 1 0 0 0  0 0 0 0 0  0 0 0 1 0'], ['b', 9, '0 0 0 0 0  0 0 0 0 0  0 0 1 0 0  0 0 0 1 0']];

function buildFilter(document) {
  const node = (tag, attributes = {}) => {
    const element = document.createElementNS(SVG_NS, tag);
    for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, String(value));
    return element;
  };
  const holder = node('svg', {id: HOLDER_ID, width: 0, height: 0, 'aria-hidden': 'true', focusable: 'false'});
  holder.setAttribute('style', 'position:absolute;width:0;height:0;overflow:hidden;pointer-events:none');
  const filter = node('filter', {id: TOAST_LIQUID_FILTER_ID, x: 0, y: 0, width: '100%', height: '100%', 'color-interpolation-filters': 'sRGB'});
  filter.append(
    node('feTurbulence', {type: 'fractalNoise', baseFrequency: '0.011 0.034', numOctaves: 2, seed: 7, result: 'noise'}),
    node('feGaussianBlur', {in: 'noise', stdDeviation: 1.6, result: 'flow'}),
  );
  for (const [name, scale, values] of CHANNELS) {
    filter.append(
      node('feDisplacementMap', {in: 'SourceGraphic', in2: 'flow', scale, xChannelSelector: 'R', yChannelSelector: 'G', result: `${name}-shift`}),
      node('feColorMatrix', {in: `${name}-shift`, type: 'matrix', values, result: name}),
    );
  }
  filter.append(node('feBlend', {in: 'r', in2: 'g', mode: 'screen', result: 'rg'}), node('feBlend', {in: 'rg', in2: 'b', mode: 'screen'}));
  holder.append(filter);
  return holder;
}

/** 挂上滤镜并在 <html> 上标记；不支持的浏览器去掉标记。可反复调用，只会挂一次。 */
export function ensureToastLiquid(document = globalThis.document) {
  const root = document?.documentElement;
  if (!root?.setAttribute || !document.body) return false;
  if (!toastLiquidSupported(document.defaultView?.navigator)) { root.removeAttribute(TOAST_LIQUID_ATTR); return false; }
  if (!document.getElementById(TOAST_LIQUID_FILTER_ID)) {
    document.getElementById(HOLDER_ID)?.remove();
    document.body.append(buildFilter(document));
  }
  root.setAttribute(TOAST_LIQUID_ATTR, '');
  return true;
}
