// 封面母版的纯几何层：只接收面板可用空间，不读取主题、图片或浏览器状态。
const COVER_DESIGNS = Object.freeze({
  landscape: Object.freeze({ width: 1120, height: 700 }),
  portrait: Object.freeze({ width: 390, height: 640 }),
});
const PORTRAIT_PANEL_THRESHOLD = 640;
const ORIENTATIONS = Object.freeze(['auto', 'landscape', 'portrait']);
const COMPOSITION_VARIANTS = Object.freeze(['auto', 'left', 'right']);

function requireDimension(value, name) {
  if (!Number.isFinite(value)) throw new TypeError(`${name} must be a finite number`);
  if (value < 0) throw new RangeError(`${name} must not be negative`);
}

/**
 * Fit a fixed-ratio cover master inside the available panel, centered on both axes.
 * Auto orientation uses the panel width, never the device or image aspect ratio.
 * A zero-sized panel produces a zero-scale frame; dimensions are never rounded.
 */
export function fitCoverFrame({ width, height, orientation = 'auto', maxScale = 1 } = {}) {
  requireDimension(width, 'width');
  requireDimension(height, 'height');
  if (!ORIENTATIONS.includes(orientation)) {
    throw new RangeError('orientation must be auto, landscape, or portrait');
  }
  if (!Number.isFinite(maxScale)) throw new TypeError('maxScale must be a finite number');
  if (maxScale <= 0) throw new RangeError('maxScale must be greater than zero');

  const selectedOrientation = orientation === 'auto'
    ? (width < PORTRAIT_PANEL_THRESHOLD ? 'portrait' : 'landscape')
    : orientation;
  const design = COVER_DESIGNS[selectedOrientation];
  const scale = width === 0 || height === 0
    ? 0
    : Math.min(width / design.width, height / design.height, maxScale);
  const fittedWidth = design.width * scale;
  const fittedHeight = design.height * scale;

  return {
    orientation: selectedOrientation,
    designWidth: design.width,
    designHeight: design.height,
    width: fittedWidth,
    height: fittedHeight,
    scale,
    x: Math.max(0, (width - fittedWidth) / 2),
    y: Math.max(0, (height - fittedHeight) / 2),
  };
}

/** Select an editorial composition without choosing, cropping, or reordering images. */
export function selectCoverComposition({ count, variant = 'auto' } = {}) {
  if (!Number.isInteger(count)) throw new TypeError('count must be an integer');
  if (count < 0 || count > 3) throw new RangeError('count must be between zero and three');
  if (!COMPOSITION_VARIANTS.includes(variant)) {
    throw new RangeError('variant must be auto, left, or right');
  }
  if (count === 0) return 'typographic';
  if (count === 1) return `solo-${variant === 'auto' ? 'right' : variant}`;
  return count === 2 ? 'diptych' : 'triptych';
}
