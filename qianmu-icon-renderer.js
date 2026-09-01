// Qianmu-owned Phosphor icon renderer. Callers must pass a narrow Qianmu root.
// There is deliberately no document scan or mutation observer in this module.

export const QIANMU_PHOSPHOR_VERSION = '2.1.1';
export const QIANMU_ICON_SPRITE_URL = new URL('./assets/qianmu-phosphor-v1454.svg', import.meta.url).href;

export const QIANMU_SEMANTIC_ICONS = Object.freeze({
  'coread-entry': 'qm-user-coread-entry',
  'character-profile': 'qm-user-character-profile',
  'floor-tools': 'qm-user-floor-tools',
  backstage: 'qm-user-backstage',
  clear: 'qm-user-clear',
  context: 'qm-user-context',
  tasks: 'qm-user-tasks',
  screening: 'qm-user-screening',
  world: 'qm-user-world',
  'world-map': 'qm-user-world-map',
  bookmarks: 'qm-user-bookmarks',
  'voice-lines': 'qm-user-voice-lines',
  'voice-regenerate-all': 'qm-user-voice-regenerate-all',
  'image-regenerate': 'qm-user-image-regenerate',
  'voice-reextract': 'qm-user-voice-reextract',
  focus: 'qm-user-focus',
});

// Font Awesome names currently emitted by Qianmu. Explicit data-qm-icon values
// take precedence where the same legacy class has more than one meaning.
export const QIANMU_FA_ICON_MAP = Object.freeze({
  'fa-anchor': 'qm-regular-anchor',
  'fa-angle-right': 'qm-regular-caret-right',
  'fa-arrow-down': 'qm-regular-arrow-down',
  'fa-arrow-down-wide-short': 'qm-regular-sort-descending',
  'fa-arrow-left': 'qm-regular-arrow-left',
  'fa-arrow-right': 'qm-regular-arrow-right',
  'fa-arrow-right-arrow-left': 'qm-regular-arrows-left-right',
  'fa-arrow-rotate-left': 'qm-regular-arrow-counter-clockwise',
  'fa-arrow-trend-up': 'qm-duotone-trend-up',
  'fa-arrow-up': 'qm-regular-arrow-up',
  'fa-atom': 'qm-user-world-map',
  'fa-backward-step': 'qm-fill-skip-back',
  'fa-book': 'qm-duotone-book',
  'fa-book-bookmark': 'qm-duotone-book-bookmark',
  'fa-book-open': 'qm-duotone-book-open',
  'fa-book-open-reader': 'qm-duotone-book-open-text',
  'fa-bookmark': Object.freeze({ default: 'qm-regular-bookmark', regular: 'qm-regular-bookmark', solid: 'qm-fill-bookmark' }),
  'fa-box-archive': 'qm-duotone-archive',
  'fa-box-open': 'qm-duotone-package',
  'fa-broom': 'qm-user-clear',
  'fa-bullseye': 'qm-duotone-target',
  'fa-camera': 'qm-duotone-camera',
  'fa-check': 'qm-regular-check',
  'fa-check-double': 'qm-regular-checks',
  'fa-chevron-down': 'qm-regular-caret-down',
  'fa-chevron-left': 'qm-regular-caret-left',
  'fa-chevron-right': 'qm-regular-caret-right',
  'fa-chevron-up': 'qm-regular-caret-up',
  'fa-circle': 'qm-regular-circle',
  'fa-circle-check': 'qm-fill-check-circle',
  'fa-circle-info': 'qm-duotone-info',
  'fa-circle-minus': 'qm-fill-minus-circle',
  'fa-circle-play': Object.freeze({ default: 'qm-regular-play-circle', regular: 'qm-regular-play-circle', solid: 'qm-fill-play-circle' }),
  'fa-circle-question': 'qm-duotone-question',
  'fa-circle-stop': 'qm-fill-stop-circle',
  'fa-circle-user': 'qm-duotone-user-circle',
  'fa-clapperboard': 'qm-duotone-film-slate',
  'fa-clock': 'qm-duotone-clock',
  'fa-cloud-moon': 'qm-duotone-cloud-moon',
  'fa-comment-dots': 'qm-duotone-chat-dots',
  'fa-comments': 'qm-duotone-chats',
  'fa-compress': 'qm-regular-arrows-in',
  'fa-copy': 'qm-regular-copy',
  'fa-database': 'qm-duotone-database',
  'fa-diagram-project': 'qm-duotone-graph',
  'fa-download': 'qm-regular-download-simple',
  'fa-dice': 'qm-regular-arrows-clockwise',
  'fa-earth-asia': Object.freeze({ default: 'qm-duotone-globe-hemisphere-east', regular: 'qm-regular-globe-hemisphere-east', solid: 'qm-fill-globe-hemisphere-east' }),
  'fa-ellipsis': 'qm-regular-dots-three',
  'fa-eraser': 'qm-regular-eraser',
  'fa-expand': 'qm-regular-arrows-out',
  'fa-eye': 'qm-regular-eye',
  'fa-eye-slash': 'qm-regular-eye-slash',
  'fa-feather-pointed': 'qm-regular-feather',
  'fa-file-export': 'qm-regular-file-arrow-up',
  'fa-file-import': 'qm-regular-file-arrow-down',
  'fa-film': 'qm-duotone-film-strip',
  'fa-filter': 'qm-regular-funnel',
  'fa-flask-vial': 'qm-duotone-flask',
  'fa-floppy-disk': 'qm-fill-floppy-disk',
  'fa-folder': 'qm-duotone-folder',
  'fa-folder-minus': 'qm-duotone-folder-minus',
  'fa-folder-plus': 'qm-duotone-folder-plus',
  'fa-font': 'qm-regular-text-aa',
  'fa-forward-step': 'qm-fill-skip-forward',
  'fa-gauge-simple': 'qm-duotone-gauge',
  'fa-gear': 'qm-duotone-gear',
  'fa-grip-lines': 'qm-regular-list',
  'fa-headphones': 'qm-duotone-headphones',
  'fa-headphones-simple': 'qm-regular-headphones',
  'fa-highlighter': 'qm-regular-highlighter',
  'fa-hourglass-half': 'qm-user-focus',
  'fa-image': 'qm-duotone-image',
  'fa-images': 'qm-duotone-images',
  'fa-layer-group': 'qm-duotone-stack',
  'fa-lightbulb': 'qm-duotone-lightbulb',
  'fa-link': 'qm-regular-link',
  'fa-list': 'qm-regular-list',
  'fa-list-check': 'qm-duotone-list-checks',
  'fa-list-ol': 'qm-regular-list-numbers',
  'fa-list-ul': 'qm-regular-list-bullets',
  'fa-location-crosshairs': 'qm-regular-crosshair',
  'fa-magnifying-glass': 'qm-regular-magnifying-glass',
  'fa-masks-theater': 'qm-duotone-mask-happy',
  'fa-message': 'qm-duotone-chat',
  'fa-microchip': 'qm-duotone-cpu',
  'fa-microphone-lines': 'qm-duotone-microphone-stage',
  'fa-minus': 'qm-regular-minus',
  'fa-mug-hot': 'qm-duotone-coffee',
  'fa-note-sticky': 'qm-regular-note-pencil',
  'fa-palette': 'qm-duotone-palette',
  'fa-pause': 'qm-fill-pause',
  'fa-pen': 'qm-regular-pen',
  'fa-pen-fancy': 'qm-regular-pen-nib',
  'fa-pen-nib': 'qm-regular-pen-nib',
  'fa-pen-to-square': 'qm-regular-note-pencil',
  'fa-pencil': 'qm-regular-pencil-simple',
  'fa-play': 'qm-fill-play',
  'fa-plug-circle-check': 'qm-duotone-plugs-connected',
  'fa-plus': 'qm-regular-plus',
  'fa-puzzle-piece': 'qm-duotone-puzzle-piece',
  'fa-quote-left': 'qm-fill-quotes',
  'fa-robot': 'qm-duotone-robot',
  'fa-rotate': 'qm-regular-arrows-clockwise',
  'fa-rotate-left': 'qm-regular-arrow-counter-clockwise',
  'fa-rotate-right': 'qm-regular-arrow-clockwise',
  'fa-seedling': 'qm-duotone-plant',
  'fa-shield-halved': 'qm-duotone-shield',
  'fa-sliders': 'qm-regular-sliders',
  'fa-spinner': 'qm-regular-spinner-gap',
  'fa-square-check': 'qm-fill-check-square',
  'fa-star': Object.freeze({ default: 'qm-regular-star', regular: 'qm-regular-star', solid: 'qm-fill-star' }),
  'fa-star-half-stroke': 'qm-duotone-star-half',
  'fa-stop': 'qm-fill-stop',
  'fa-syringe': 'qm-duotone-syringe',
  'fa-table-cells-large': 'qm-duotone-squares-four',
  'fa-table-list': 'qm-regular-rows',
  'fa-tags': 'qm-duotone-tag',
  'fa-thumbtack': Object.freeze({ default: 'qm-regular-push-pin', regular: 'qm-regular-push-pin', solid: 'qm-fill-push-pin' }),
  'fa-trash': 'qm-regular-trash',
  'fa-trash-can': 'qm-regular-trash',
  'fa-triangle-exclamation': 'qm-duotone-warning',
  'fa-underline': 'qm-regular-text-underline',
  'fa-up-right-and-down-left-from-center': 'qm-regular-arrows-out-simple',
  'fa-upload': 'qm-regular-upload-simple',
  'fa-user': 'qm-duotone-user',
  'fa-user-plus': 'qm-duotone-user-plus',
  'fa-vector-square': 'qm-regular-selection',
  'fa-video': 'qm-duotone-video-camera',
  'fa-volume-high': 'qm-fill-speaker-high',
  'fa-wand-magic-sparkles': 'qm-duotone-magic-wand',
  'fa-wave-square': 'qm-regular-wave-sine',
  'fa-xmark': 'qm-regular-x',
});

export const QIANMU_CURRENT_FA_ICON_COUNT = Object.keys(QIANMU_FA_ICON_MAP).length;

const SVG_NS = 'http://www.w3.org/2000/svg';
const XLINK_NS = 'http://www.w3.org/1999/xlink';
const ICON_CLASS = 'qm-phosphor-icon';
const ICON_DATA = 'data-qm-phosphor-icon';
const ICON_HOST_SELECTOR = 'i[class*="fa-"], [data-qm-icon]';
const TRANSIENT_STATE_ICONS = new Set(['fa-spinner', 'fa-circle-stop', 'fa-stop', 'fa-pause', 'fa-play']);

export const QIANMU_ICON_ROOT_SELECTOR = [
  '#story-director-modal',
  '#story-director-settings',
  '#story-director-float',
  '#story-director-quick-wheel',
  '#story-director-floor-nav',
  '#qianmu-notes-float-layer',
  '#story-director-input-entry',
  '#story-director-input-button',
  '#sd-reader-portal',
  '#sd-coread-notice-layer',
  '.sd-reader-portal',
  '.sd-reader-refill-overlay',
  '.sd-reader-comic-review',
  '.sd-reader-book-drag-ghost',
  '.sd-focus-voice-drawer-portal',
  '.sd-tts-bar',
  '.sd-tts-toolbar',
  '.sd-tts-popup',
  '.sd-tts-glue',
  '.sd-storyboard-message-action',
  '.sd-storyboard-inline',
  '.sd-storyboard-lightbox',
  '.sd-lib-edit-form',
  '.sd-thread-edit-form',
  '.sd-conflict-form',
  '.sd-reader-fontcss-form',
  '.sd-reader-collection-pick-form',
  '.sd-reader-bookedit-form',
].join(',');

const THIRD_PARTY_BOUNDARY_SELECTOR = [
  '.sd-preserve-external-icon',
  '.sd-wheel-external-svg',
  '.sd-quick-docked-origin',
  '.sd-quick-docked-activating',
  '[data-qm-icon-preserve]',
  '[data-qianmu-icon-skip]',
].join(',');

function isElement(value) {
  return !!value && value.nodeType === 1 && typeof value.matches === 'function';
}

function fontAwesomeWeight(value = '') {
  const classes = String(value).split(/\s+/);
  if (classes.includes('fa-regular')) return 'regular';
  if (classes.includes('fa-solid')) return 'solid';
  return '';
}

function fontAwesomeIconName(value = '') {
  return String(value).split(/\s+/).find((name) => /^fa-(?!solid$|regular$|brands$|spin$)[a-z0-9-]+$/.test(name)) || '';
}

export function resolveQianmuIcon(value, requestedWeight = '') {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (raw.startsWith('qm-')) return raw;
  if (QIANMU_SEMANTIC_ICONS[raw]) return QIANMU_SEMANTIC_ICONS[raw];
  const name = QIANMU_FA_ICON_MAP[raw] ? raw : fontAwesomeIconName(raw);
  const mapped = QIANMU_FA_ICON_MAP[name];
  if (!mapped) return '';
  if (typeof mapped === 'string') return mapped;
  const weight = String(requestedWeight || fontAwesomeWeight(raw)).replace(/^fa-/, '');
  return mapped[weight] || mapped.default || mapped.regular || mapped.solid || '';
}

function hrefFor(symbol) {
  return `${QIANMU_ICON_SPRITE_URL}#${symbol}`;
}

export function qianmuIconElement(value, options = {}) {
  const symbol = resolveQianmuIcon(value, options.weight);
  const doc = options.document || globalThis.document;
  if (!symbol || !doc?.createElementNS) return null;
  const svg = doc.createElementNS(SVG_NS, 'svg');
  const use = doc.createElementNS(SVG_NS, 'use');
  const href = hrefFor(symbol);
  svg.classList.add('qm-phosphor-svg');
  svg.setAttribute('viewBox', '0 0 256 256');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  use.setAttribute('href', href);
  use.setAttributeNS(XLINK_NS, 'xlink:href', href);
  svg.appendChild(use);
  return svg;
}

export function qianmuIconMarkup(value, options = {}) {
  const symbol = resolveQianmuIcon(value, options.weight);
  if (!symbol) return '';
  const extra = String(options.className || '').replace(/["<>]/g, '').trim();
  const classes = `${ICON_CLASS}${extra ? ` ${extra}` : ''}`;
  const href = hrefFor(symbol).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<i class="${classes}" data-qm-icon="${symbol}" ${ICON_DATA}="${symbol}"><svg class="qm-phosphor-svg" viewBox="0 0 256 256" aria-hidden="true" focusable="false"><use href="${href}"></use></svg></i>`;
}

function ownedScope(root) {
  if (isElement(root)) {
    if (root.matches(QIANMU_ICON_ROOT_SELECTOR) || root.closest(QIANMU_ICON_ROOT_SELECTOR)) return root;
  }
  return null;
}

function belongsToQianmu(icon) {
  return isElement(icon)
    && !icon.closest(THIRD_PARTY_BOUNDARY_SELECTOR)
    && !!icon.closest(QIANMU_ICON_ROOT_SELECTOR);
}

function requestedSymbol(icon, explicitValue = '') {
  const faName = fontAwesomeIconName(icon.className);
  if (TRANSIENT_STATE_ICONS.has(faName)) return resolveQianmuIcon(icon.className);
  return resolveQianmuIcon(explicitValue || icon.getAttribute('data-qm-icon')) || resolveQianmuIcon(icon.className);
}

function renderIcon(icon, explicitValue = '') {
  if (!belongsToQianmu(icon)) return false;
  const symbol = requestedSymbol(icon, explicitValue);
  if (!symbol) return false;
  let svg = Array.from(icon.children || []).find((child) => child.matches?.('svg.qm-phosphor-svg')) || null;
  if (!svg) {
    svg = qianmuIconElement(symbol, { document: icon.ownerDocument });
    if (!svg) return false;
    icon.appendChild(svg);
  }
  const use = svg.querySelector('use');
  const href = hrefFor(symbol);
  if (use?.getAttribute('href') !== href) {
    use?.setAttribute('href', href);
    use?.setAttributeNS(XLINK_NS, 'xlink:href', href);
  }
  if (!icon.classList.contains(ICON_CLASS)) icon.classList.add(ICON_CLASS);
  if (icon.getAttribute(ICON_DATA) !== symbol) icon.setAttribute(ICON_DATA, symbol);
  return true;
}

export function refreshQianmuIcon(icon, value = '') {
  return isElement(icon) ? renderIcon(icon, value) : false;
}

export function applyQianmuIcons(root) {
  const scope = ownedScope(root);
  if (!scope) return 0;
  let count = 0;
  if (isElement(scope) && scope.matches(ICON_HOST_SELECTOR)) count += Number(renderIcon(scope));
  scope.querySelectorAll(ICON_HOST_SELECTOR).forEach((icon) => { count += Number(renderIcon(icon)); });
  return count;
}
