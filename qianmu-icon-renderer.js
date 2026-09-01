// Qianmu Line icon renderer. Every glyph is embedded in this module so a rendered
// icon never depends on a second asset request, an icon font, a CDN, or a cache hit.
// Callers must pass a narrow Qianmu root; there is deliberately no page-wide scan.

export const QIANMU_ICON_SYSTEM_VERSION = '1.0.0';
export const QIANMU_ICON_SYSTEM_NAME = '千幕线描';

export const QIANMU_SEMANTIC_ICONS = Object.freeze({
  'coread-entry': 'qm-signature-coread',
  'character-profile': 'qm-signature-character',
  'floor-tools': 'qm-signature-floor-tools',
  backstage: 'qm-signature-backstage',
  clear: 'qm-signature-clear',
  context: 'qm-signature-context',
  tasks: 'qm-signature-tasks',
  screening: 'qm-signature-screening',
  world: 'qm-signature-world',
  'world-map': 'qm-signature-world-map',
  bookmarks: 'qm-signature-bookmarks',
  'voice-lines': 'qm-signature-voice-lines',
  'voice-regenerate-all': 'qm-signature-voice-regenerate',
  'image-regenerate': 'qm-signature-image-regenerate',
  'voice-reextract': 'qm-signature-voice-reextract',
  focus: 'qm-signature-focus',
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

// 24px, 1.65px stroke, rounded joins. Signature glyphs intentionally use
// asymmetry, framing corners, and small orbital marks to echo a director's
// viewfinder without turning ordinary controls into decorative illustrations.
const INLINE_GLYPHS = Object.freeze({
  spark: '<path d="M12 3.5l1.15 4.1a4.5 4.5 0 0 0 3.25 3.25L20.5 12l-4.1 1.15a4.5 4.5 0 0 0-3.25 3.25L12 20.5l-1.15-4.1a4.5 4.5 0 0 0-3.25-3.25L3.5 12l4.1-1.15a4.5 4.5 0 0 0 3.25-3.25Z"/>',
  'signature-coread': '<path d="M4 6.2c2.8-.7 5.2-.25 8 1.55 2.8-1.8 5.2-2.25 8-1.55v11.6c-2.9-.65-5.3-.2-8 1.55-2.7-1.75-5.1-2.2-8-1.55Z"/><path d="M12 7.75v11.6M7.2 10h1.9M14.9 10h1.9"/>',
  'signature-character': '<circle cx="12" cy="8" r="3"/><path d="M5.5 19c.75-3.25 3-5 6.5-5s5.75 1.75 6.5 5M18.5 5.5l1-1m-1 4h1.5"/>',
  'signature-floor-tools': '<path d="M4 17.5h4v-4h4v-4h4v-4h4M4 20h16"/><circle cx="6" cy="7" r="1.5"/>',
  'signature-backstage': '<path d="M5 4.5c3 2.3 4.7 4.8 5 7.5-.3 2.7-2 5.2-5 7.5M19 4.5c-3 2.3-4.7 4.8-5 7.5.3 2.7 2 5.2 5 7.5M10 12h4"/>',
  'signature-clear': '<path d="M6.5 17.5 15.8 8.2l-4-4L2.5 13.5l4 4Z"/><path d="m12.5 11.5 4 4M7.5 20h13"/>',
  'signature-context': '<path d="M4 6.5h5l1.4 2H20v9H4Z"/><path d="M7 12h6M15.8 12h1.2M7 15h4"/>',
  'signature-tasks': '<circle cx="6" cy="6" r="1.5"/><circle cx="18" cy="12" r="1.5"/><circle cx="6" cy="18" r="1.5"/><path d="M7.5 6h3.2c2.2 0 2.4 2.4 3.5 4.2.7 1.1 1.4 1.8 2.3 1.8M7.5 18h3.2c2.2 0 2.4-2.4 3.5-4.2"/>',
  'signature-screening': '<path d="M4 6.5h16v11H4Z"/><path d="M7 6.5v11M17 6.5v11M4 10h3m10 0h3M4 14h3m10 0h3"/>',
  'signature-world': '<circle cx="12" cy="12" r="7.5"/><path d="M4.8 14.2c3.1-1.2 5.2-.7 7.1.5 2.1 1.35 4.1 1.35 7.1-.2M9.5 4.9c1.2 1.5 1.25 3.2.1 4.35-1.2 1.2-1.1 2.5.4 3.35"/><circle cx="19.5" cy="5" r="1"/>',
  'signature-world-map': '<path d="m3.5 6 5-2 7 2 5-2v14l-5 2-7-2-5 2Z"/><path d="M8.5 4v14M15.5 6v14"/><circle cx="12" cy="10" r="1.4"/>',
  'signature-bookmarks': '<path d="M7 4.5h10v15l-5-3.2-5 3.2Z"/><path d="M4.5 7v13.5M19.5 7v13.5"/>',
  'signature-voice-lines': '<path d="M5 8.5v7M8.5 6v12M12 9.5v5M15.5 5v14M19 8v8"/>',
  'signature-voice-regenerate': '<path d="M7 8a6.5 6.5 0 0 1 10.7-1.2L20 9M17 16a6.5 6.5 0 0 1-10.7 1.2L4 15"/><path d="M20 5v4h-4M4 19v-4h4M11 9v6l4-3Z"/>',
  'signature-image-regenerate': '<path d="M4 6h10v10H4Z"/><path d="m5.5 14 3.1-3.2 2.2 2 1.7-1.7L14 13M15.5 7.2A4.5 4.5 0 1 1 16 16"/><path d="M15.5 4.5v2.7h2.7"/>',
  'signature-voice-reextract': '<path d="M5 7h9M5 11h7M5 15h5"/><path d="M15 12.5a4 4 0 1 1-.5 4.8M15 12.5V16h3.5"/>',
  'signature-focus': '<path d="M7 4h10M7 20h10M8 4c0 4 1.4 5.2 4 8-2.6 2.8-4 4-4 8M16 4c0 4-1.4 5.2-4 8 2.6 2.8 4 4 4 8"/><circle cx="12" cy="16" r=".8"/>',
  anchor: '<path d="M12 3v15M8.5 6.5h7M5 13a7 7 0 0 0 14 0M5 13H2.8M19 13h2.2"/><circle cx="12" cy="3.8" r="1.5"/>',
  archive: '<path d="M4 8h16v11H4ZM3 5h18v3H3Z"/><path d="M9 12h6"/>',
  'arrow-left': '<path d="m14.5 5-7 7 7 7M7.5 12H21"/>',
  'arrow-right': '<path d="m9.5 5 7 7-7 7M3 12h13.5"/>',
  'arrow-up': '<path d="m5 14.5 7-7 7 7M12 7.5V21"/>',
  'arrow-down': '<path d="m5 9.5 7 7 7-7M12 3v13.5"/>',
  'caret-left': '<path d="m14.5 6-6 6 6 6"/>',
  'caret-right': '<path d="m9.5 6 6 6-6 6"/>',
  'caret-up': '<path d="m6 14.5 6-6 6 6"/>',
  'caret-down': '<path d="m6 9.5 6 6 6-6"/>',
  refresh: '<path d="M19 8a7.5 7.5 0 1 0 .2 7.7M19 8V4m0 4h-4"/>',
  swap: '<path d="M4 8h14m-3-3 3 3-3 3M20 16H6m3-3-3 3 3 3"/>',
  'arrows-out': '<path d="M9 4H4v5M4 4l6 6M15 4h5v5M20 4l-6 6M9 20H4v-5M4 20l6-6M15 20h5v-5M20 20l-6-6"/>',
  'arrows-in': '<path d="M10 10 4 4m0 5V4h5M14 10l6-6m-5 0h5v5M10 14l-6 6m0-5v5h5M14 14l6 6m-5 0h5v-5"/>',
  sort: '<path d="M7 5v14m-3-3 3 3 3-3M13 7h7M13 12h5M13 17h3"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  minus: '<path d="M5 12h14"/>',
  x: '<path d="m6 6 12 12M18 6 6 18"/>',
  check: '<path d="m4.5 12.5 4.5 4.5L19.5 6.5"/>',
  checks: '<path d="m2.5 12.5 4 4 9-9M10.5 15.5l2.5 2.5 8.5-10"/>',
  circle: '<circle cx="12" cy="12" r="8"/>',
  'check-circle': '<circle cx="12" cy="12" r="8"/><path d="m8 12 2.7 2.7L16.5 9"/>',
  'minus-circle': '<circle cx="12" cy="12" r="8"/><path d="M8 12h8"/>',
  'play-circle': '<circle cx="12" cy="12" r="8"/><path d="m10 8.5 5 3.5-5 3.5Z"/>',
  'stop-circle': '<circle cx="12" cy="12" r="8"/><rect x="9" y="9" width="6" height="6" rx="1"/>',
  play: '<path d="m8 5.5 10 6.5-10 6.5Z"/>',
  pause: '<path d="M9 6v12M15 6v12"/>',
  stop: '<rect x="7" y="7" width="10" height="10" rx="1.5"/>',
  'skip-back': '<path d="M7 6v12M17 6l-8 6 8 6Z"/>',
  'skip-forward': '<path d="M17 6v12M7 6l8 6-8 6Z"/>',
  book: '<path d="M5 4.5h11.5A2.5 2.5 0 0 1 19 7v12H7.5A2.5 2.5 0 0 1 5 16.5Z"/><path d="M5 16.5A2.5 2.5 0 0 1 7.5 14H19"/>',
  'book-open': '<path d="M3.5 5.5c3.2-.6 5.8 0 8.5 2 2.7-2 5.3-2.6 8.5-2v13c-3.2-.6-5.8 0-8.5 2-2.7-2-5.3-2.6-8.5-2Z"/><path d="M12 7.5v13"/>',
  bookmark: '<path d="M7.5 4.5h9v15l-4.5-3-4.5 3Z"/>',
  camera: '<path d="M4 8V5h3M20 8V5h-3M4 16v3h3M20 16v3h-3"/><circle cx="12" cy="12" r="3.5"/><circle cx="12" cy="12" r="1"/>',
  user: '<circle cx="12" cy="8" r="3"/><path d="M5 19c.7-3.5 3-5 7-5s6.3 1.5 7 5"/>',
  'user-plus': '<circle cx="10" cy="8" r="3"/><path d="M4 19c.7-3.5 2.8-5 6-5 2.5 0 4.3.9 5.3 2.8M18 9v6m-3-3h6"/>',
  chat: '<path d="M4 5.5h16v11H9l-5 3Z"/>',
  'chat-dots': '<path d="M4 5.5h16v11H9l-5 3Z"/><path d="M8 11h.1M12 11h.1M16 11h.1"/>',
  chats: '<path d="M4 5h13v9H8l-4 2.5ZM9 14v3h7l4 2.5V9h-3"/>',
  clock: '<circle cx="12" cy="12" r="8"/><path d="M12 7v5l3.5 2"/>',
  'cloud-moon': '<path d="M9 17.5H6.5a3.5 3.5 0 0 1-.4-7A5.5 5.5 0 0 1 16.5 9a4.3 4.3 0 0 1 .5 8.5h-3"/><path d="M9.5 4.5a4 4 0 0 0 4 4 4 4 0 0 1-4-4Z"/>',
  coffee: '<path d="M5 8h12v5a6 6 0 0 1-6 6 6 6 0 0 1-6-6ZM17 10h1.5a2.5 2.5 0 0 1 0 5H17M4 21h15M8 3v2M12 3v2"/>',
  copy: '<rect x="7" y="7" width="11" height="12" rx="1.5"/><path d="M15 7V5H6a1 1 0 0 0-1 1v10h2"/>',
  cpu: '<rect x="6" y="6" width="12" height="12" rx="2"/><rect x="9" y="9" width="6" height="6" rx="1"/><path d="M9 3v3m6-3v3M9 18v3m6-3v3M3 9h3m-3 6h3m12-6h3m-3 6h3"/>',
  crosshair: '<circle cx="12" cy="12" r="6"/><path d="M12 3v4M12 17v4M3 12h4M17 12h4"/>',
  database: '<ellipse cx="12" cy="6.5" rx="7" ry="3"/><path d="M5 6.5v5c0 1.7 3.1 3 7 3s7-1.3 7-3v-5M5 11.5v5c0 1.7 3.1 3 7 3s7-1.3 7-3v-5"/>',
  dots: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
  download: '<path d="M12 4v11m-4-4 4 4 4-4M5 20h14"/>',
  upload: '<path d="M12 16V5m-4 4 4-4 4 4M5 20h14"/>',
  eraser: '<path d="m4 14 8.5-8.5 6 6-7.5 7.5H7Z"/><path d="m9.5 8.5 6 6M11 19h9"/>',
  eye: '<path d="M3 12s3.2-5 9-5 9 5 9 5-3.2 5-9 5-9-5-9-5Z"/><circle cx="12" cy="12" r="2.5"/>',
  'eye-slash': '<path d="M4 4l16 16M9.5 7.4A8.8 8.8 0 0 1 12 7c5.8 0 9 5 9 5a13 13 0 0 1-2.1 2.6M6.2 8.2A13.6 13.6 0 0 0 3 12s3.2 5 9 5c1 0 2-.15 2.8-.45"/>',
  feather: '<path d="M5 19c4.5-1.2 9.2-5.8 14-14 1.3 6.7-2.4 12-9.5 12H5Z"/><path d="M5 19 15 9"/>',
  film: '<rect x="3.5" y="5" width="17" height="14" rx="1.5"/><path d="M7 5v14M17 5v14M3.5 9h3.5m10 0h3.5M3.5 15h3.5m10 0h3.5"/>',
  'film-slate': '<path d="M4 9h16v11H4Z"/><path d="m4 9-1-4 16-3 1 4Z"/><path d="m7 4.3 3 3m3-4.2 3 3M8 13h8"/>',
  flask: '<path d="M9 3h6M10 3v6l-5 9a1.5 1.5 0 0 0 1.3 2.3h11.4A1.5 1.5 0 0 0 19 18l-5-9V3M7.5 15h9"/>',
  save: '<path d="M5 4h12l2 2v14H5Z"/><path d="M8 4v6h8V4M8 20v-6h8v6"/>',
  folder: '<path d="M3.5 6h7l2 2h8v11h-17Z"/>',
  filter: '<path d="M4 5h16l-6.3 7v6l-3.4 1v-7Z"/>',
  gauge: '<path d="M4 17a8 8 0 0 1 16 0M12 17l4-6M6.5 17h11"/>',
  gear: '<path d="M4 7h9M17 7h3M4 12h3M11 12h9M4 17h10M18 17h2"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="16" cy="17" r="2"/>',
  globe: '<circle cx="12" cy="12" r="8"/><path d="M4 12h16M12 4c2.2 2.2 3.3 4.9 3.3 8s-1.1 5.8-3.3 8c-2.2-2.2-3.3-4.9-3.3-8S9.8 6.2 12 4Z"/>',
  graph: '<path d="M4 19V5M4 19h16M7 15l4-4 3 2 5-6"/><circle cx="7" cy="15" r="1"/><circle cx="11" cy="11" r="1"/><circle cx="14" cy="13" r="1"/><circle cx="19" cy="7" r="1"/>',
  headphones: '<path d="M4 13v-1a8 8 0 0 1 16 0v1M4 13h3v6H5a1 1 0 0 1-1-1ZM20 13h-3v6h2a1 1 0 0 0 1-1Z"/>',
  highlighter: '<path d="m6 15 8.5-8.5 3 3L9 18H6ZM4 20h11M12.5 8.5l3 3"/>',
  image: '<rect x="3.5" y="5" width="17" height="14" rx="2"/><circle cx="9" cy="10" r="1.5"/><path d="m5.5 17 4.5-4 3 2.5 2-2 3.5 3.5"/>',
  info: '<circle cx="12" cy="12" r="8"/><path d="M12 11v5M12 8h.01"/>',
  question: '<circle cx="12" cy="12" r="8"/><path d="M9.5 9a2.7 2.7 0 1 1 3.2 2.7c-.7.2-.7.8-.7 1.3M12 16h.01"/>',
  warning: '<path d="M12 4 21 20H3Z"/><path d="M12 9v5M12 17h.01"/>',
  lightbulb: '<path d="M8.5 15.5A6 6 0 1 1 15.5 15.5L14.5 18h-5ZM9.5 21h5"/>',
  link: '<path d="m9.5 14.5-1 1a3.5 3.5 0 1 1-5-5l3-3a3.5 3.5 0 0 1 5 0M14.5 9.5l1-1a3.5 3.5 0 0 1 5 5l-3 3a3.5 3.5 0 0 1-5 0M8.5 12h7"/>',
  list: '<path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01"/>',
  'list-numbers': '<path d="M9 6h11M9 12h11M9 18h11M4 5h1v3M4 11h2l-2 3h2M4 17h2l-1 1 1 1H4"/>',
  'list-checks': '<path d="M10 6h10M10 12h10M10 18h10M3 6l1.5 1.5L7 5M3 12l1.5 1.5L7 11M3 18l1.5 1.5L7 17"/>',
  wand: '<path d="m5 19 10-10 4 4L9 23ZM4 4v3M2.5 5.5h3M14 2v3M12.5 3.5h3M20 5v3M18.5 6.5h3"/>',
  search: '<circle cx="10.5" cy="10.5" r="6"/><path d="m15 15 5 5"/>',
  mask: '<path d="M4 8c2-1.7 4.7-2.5 8-2.5S18 6.3 20 8v5c0 3.8-3.1 6-8 6s-8-2.2-8-6Z"/><path d="M7 11c1-1 2-1 3 0M14 11c1-1 2-1 3 0M9 15c2 1.3 4 1.3 6 0"/>',
  microphone: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M6.5 11a5.5 5.5 0 0 0 11 0M12 16.5V21M9 21h6"/>',
  note: '<path d="M5 4h14v12l-4 4H5Z"/><path d="M15 20v-4h4M8 8h8M8 12h6"/>',
  pen: '<path d="m5 19 1-4L16.5 4.5l3 3L9 18ZM14.5 6.5l3 3M5 19l4-1"/>',
  palette: '<path d="M12 4a8 8 0 1 0 0 16h1.3a1.7 1.7 0 0 0 1.2-2.9l-.4-.4a1.7 1.7 0 0 1 1.2-2.9H20A8 8 0 0 0 12 4Z"/><circle cx="8" cy="9" r=".8"/><circle cx="12" cy="7" r=".8"/><circle cx="16" cy="9.5" r=".8"/>',
  plant: '<path d="M12 21V9M12 13c-4.5 0-7-2.3-7-6 4.5 0 7 2.3 7 6ZM12 16c4.5 0 7-2.3 7-6-4.5 0-7 2.3-7 6Z"/>',
  plug: '<path d="M8 4v5M16 4v5M6 9h12v2a6 6 0 0 1-6 6 6 6 0 0 1-6-6ZM12 17v4"/>',
  pin: '<path d="m8 4 8 0-1 6 3 3v1H6v-1l3-3ZM12 14v7"/>',
  puzzle: '<path d="M4 5h6a2 2 0 1 1 4 0h6v6a2 2 0 1 0 0 4v5h-6a2 2 0 1 0-4 0H4v-5a2 2 0 1 0 0-4Z"/>',
  quotes: '<path d="M5 9h5v5H6c0 2-1 3-3 4M14 9h5v5h-4c0 2-1 3-3 4"/>',
  robot: '<rect x="5" y="7" width="14" height="11" rx="2"/><path d="M12 3v4M8.5 12h.01M15.5 12h.01M9 15h6M3 11v4M21 11v4"/>',
  selection: '<path d="M8 4H4v4M16 4h4v4M20 16v4h-4M8 20H4v-4"/><rect x="8" y="8" width="8" height="8" rx="1"/>',
  shield: '<path d="m12 3 7 3v5c0 4.5-2.5 7.7-7 10-4.5-2.3-7-5.5-7-10V6Z"/><path d="m9 12 2 2 4-4"/>',
  sliders: '<path d="M4 7h6M14 7h6M4 12h10M18 12h2M4 17h3M11 17h9"/><circle cx="12" cy="7" r="2"/><circle cx="16" cy="12" r="2"/><circle cx="9" cy="17" r="2"/>',
  speaker: '<path d="M5 10h4l5-4v12l-5-4H5ZM17 9a4 4 0 0 1 0 6M19 6a8 8 0 0 1 0 12"/>',
  spinner: '<path d="M12 3a9 9 0 1 1-8.2 5.3"/>',
  squares: '<rect x="4" y="4" width="6" height="6" rx="1"/><rect x="14" y="4" width="6" height="6" rx="1"/><rect x="4" y="14" width="6" height="6" rx="1"/><rect x="14" y="14" width="6" height="6" rx="1"/>',
  stack: '<path d="m12 4 9 4-9 4-9-4ZM3 12l9 4 9-4M3 16l9 4 9-4"/>',
  star: '<path d="m12 3 2.7 5.5 6.1.9-4.4 4.3 1 6.1-5.4-2.9-5.4 2.9 1-6.1-4.4-4.3 6.1-.9Z"/>',
  tag: '<path d="M4 5h7l9 9-6 6-9-9Z"/><circle cx="8.5" cy="8.5" r="1"/>',
  target: '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="4"/><circle cx="12" cy="12" r="1"/>',
  text: '<path d="M5 6h14M9 6v13M15 6v13M7 19h4M13 19h4"/>',
  trash: '<path d="M5 7h14M9 7V4h6v3M7 7l1 13h8l1-13M10 10v6M14 10v6"/>',
  video: '<rect x="3.5" y="6" width="12" height="12" rx="2"/><path d="m15.5 10 5-3v10l-5-3Z"/>',
  wave: '<path d="M3 12h3l2-6 4 12 3-9 2 6h4"/>',
});

const GLYPH_ALIASES = Object.freeze({
  'arrow-clockwise': 'refresh', 'arrow-counter-clockwise': 'refresh', 'arrows-clockwise': 'refresh',
  'arrows-left-right': 'swap', 'arrows-out-simple': 'arrows-out', 'sort-descending': 'sort',
  'book-bookmark': 'book', 'book-open-text': 'book-open', bookmarks: 'signature-bookmarks',
  'check-square': 'check-circle', 'user-circle': 'user', 'character-profile': 'signature-character',
  'file-arrow-down': 'download', 'download-simple': 'download', 'file-arrow-up': 'upload', 'upload-simple': 'upload',
  'film-strip': 'film', 'voice-lines': 'signature-voice-lines', 'voice-reextract': 'signature-voice-reextract',
  'voice-regenerate-all': 'signature-voice-regenerate', 'image-regenerate': 'signature-image-regenerate',
  'floppy-disk': 'save', 'folder-minus': 'folder', 'folder-plus': 'folder', funnel: 'filter',
  'globe-hemisphere-east': 'globe', 'trend-up': 'graph', 'headphones-simple': 'headphones',
  images: 'image', screening: 'signature-screening', 'list-bullets': 'list', rows: 'list', tasks: 'signature-tasks',
  'magic-wand': 'wand', 'magnifying-glass': 'search', 'mask-happy': 'mask', message: 'chat',
  'microphone-stage': 'microphone', 'note-pencil': 'note', 'pencil-simple': 'pen', 'pen-nib': 'pen',
  'plugs-connected': 'plug', 'push-pin': 'pin', 'squares-four': 'squares', 'star-half': 'star',
  'text-aa': 'text', 'text-underline': 'text', 'video-camera': 'video', 'speaker-high': 'speaker',
  backstage: 'signature-backstage', clear: 'signature-clear', context: 'signature-context',
  'coread-entry': 'signature-coread', focus: 'signature-focus', 'floor-tools': 'signature-floor-tools',
  world: 'signature-world', 'world-map': 'signature-world-map',
  archive: 'archive', package: 'archive', circle: 'circle', 'circle-check': 'check-circle',
  'stethoscope': 'wave', syringe: 'pen', 'highlighter': 'highlighter', 'selection': 'selection',
  'dots-three': 'dots', 'puzzle-piece': 'puzzle', 'spinner-gap': 'spinner', 'wave-sine': 'wave',
});

export const QIANMU_INLINE_GLYPH_COUNT = Object.keys(INLINE_GLYPHS).length;

const SVG_NS = 'http://www.w3.org/2000/svg';
const ICON_CLASS = 'qm-glyph-icon';
const ICON_DATA = 'data-qm-glyph';
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

function glyphNameFor(symbol) {
  const raw = String(symbol || '').trim();
  if (raw.startsWith('qm-signature-')) return raw.slice(3);
  const base = raw.replace(/^qm-(?:duotone|regular|fill|user)-/, '');
  return GLYPH_ALIASES[base] || base;
}

function glyphMarkupFor(symbol) {
  return INLINE_GLYPHS[glyphNameFor(symbol)] || INLINE_GLYPHS.spark;
}

function paintGlyph(svg, symbol) {
  if (!svg || svg.getAttribute(ICON_DATA) === symbol) return false;
  svg.setAttribute(ICON_DATA, symbol);
  svg.innerHTML = glyphMarkupFor(symbol);
  return true;
}

export function qianmuIconElement(value, options = {}) {
  const symbol = resolveQianmuIcon(value, options.weight);
  const doc = options.document || globalThis.document;
  if (!symbol || !doc?.createElementNS) return null;
  const svg = doc.createElementNS(SVG_NS, 'svg');
  svg.classList.add('qm-glyph-svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.65');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  paintGlyph(svg, symbol);
  return svg;
}

export function qianmuIconMarkup(value, options = {}) {
  const symbol = resolveQianmuIcon(value, options.weight);
  if (!symbol) return '';
  const extra = String(options.className || '').replace(/["<>]/g, '').trim();
  const classes = `${ICON_CLASS}${extra ? ` ${extra}` : ''}`;
  return `<i class="${classes}" data-qm-icon="${symbol}" ${ICON_DATA}="${symbol}"><svg class="qm-glyph-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false" ${ICON_DATA}="${symbol}">${glyphMarkupFor(symbol)}</svg></i>`;
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
  let svg = Array.from(icon.children || []).find((child) => child.matches?.('svg.qm-glyph-svg, svg.qm-phosphor-svg')) || null;
  if (!svg) {
    svg = qianmuIconElement(symbol, { document: icon.ownerDocument });
    if (!svg) return false;
    icon.appendChild(svg);
  } else {
    svg.classList.remove('qm-phosphor-svg');
    svg.classList.add('qm-glyph-svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '1.65');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    paintGlyph(svg, symbol);
  }
  paintGlyph(svg, symbol);
  icon.classList.remove('qm-phosphor-icon');
  if (!icon.classList.contains(ICON_CLASS)) icon.classList.add(ICON_CLASS);
  if (icon.getAttribute(ICON_DATA) !== symbol) icon.setAttribute(ICON_DATA, symbol);
  if (icon.getAttribute('data-qm-phosphor-icon')) icon.removeAttribute('data-qm-phosphor-icon');
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
