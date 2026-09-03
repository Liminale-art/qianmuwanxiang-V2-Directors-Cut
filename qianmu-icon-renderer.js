/** @license Lucide Static v1.39.0 — ISC; see THIRD_PARTY_NOTICES.md */
// Local Lucide subset renderer. Every selected glyph ships with Qianmu, so a rendered
// icon never depends on a second asset request, an icon font, a CDN, or a cache hit.
// Callers must pass a narrow Qianmu root; there is deliberately no page-wide scan.

export const LUCIDE_SOURCE_VERSION = '1.39.0';
export const LUCIDE_STROKE_WIDTH = 2.5;

export const LUCIDE_GLYPH_NAMES = Object.freeze({
  "anchor": "anchor",
  "archive": "archive",
  "arrow-clockwise": "rotate-cw",
  "arrow-counter-clockwise": "rotate-ccw",
  "arrow-down": "arrow-down",
  "arrow-left": "arrow-left",
  "arrow-right": "arrow-right",
  "arrow-up": "arrow-up",
  "arrows-clockwise": "refresh-cw",
  "arrows-in": "minimize-2",
  "arrows-left-right": "arrow-left-right",
  "arrows-out": "maximize-2",
  "arrows-out-simple": "maximize",
  "backstage": "drama",
  "book": "book",
  "book-bookmark": "book-marked",
  "book-open": "book-open",
  "book-open-text": "book-open-text",
  "bookmark": "bookmark",
  "bookmarks": "book-marked",
  "camera": "camera",
  "caret-down": "chevron-down",
  "caret-left": "chevron-left",
  "caret-right": "chevron-right",
  "caret-up": "chevron-up",
  "character": "contact-round",
  "chat": "message-square",
  "chat-dots": "message-square-more",
  "chats": "messages-square",
  "check": "check",
  "check-circle": "circle-check-big",
  "check-square": "square-check-big",
  "checks": "check-check",
  "circle": "circle",
  "clear": "brush-cleaning",
  "clock": "clock",
  "cloud-moon": "cloud-moon",
  "coffee": "coffee",
  "context": "folder-search",
  "copy": "copy",
  "coread": "book-open",
  "cpu": "cpu",
  "crosshair": "crosshair",
  "database": "database",
  "dots-three": "ellipsis",
  "download-simple": "download",
  "eraser": "eraser",
  "eye": "eye",
  "eye-slash": "eye-off",
  "feather": "feather",
  "file-arrow-down": "file-down",
  "file-arrow-up": "file-up",
  "film-slate": "clapperboard",
  "film-strip": "film",
  "flask": "flask-conical",
  "floor-tools": "layout-dashboard",
  "floppy-disk": "save",
  "focus": "hourglass",
  "folder": "folder",
  "folder-minus": "folder-minus",
  "folder-plus": "folder-plus",
  "funnel": "funnel",
  "gauge": "gauge",
  "gear": "settings",
  "globe-hemisphere-east": "earth",
  "graph": "network",
  "headphones": "headphones",
  "highlighter": "highlighter",
  "image": "image",
  "image-regenerate": "refresh-cw",
  "images": "images",
  "info": "info",
  "lightbulb": "lightbulb",
  "link": "link",
  "list": "list",
  "list-bullets": "list",
  "list-checks": "list-checks",
  "list-numbers": "list-ordered",
  "magic-wand": "wand-sparkles",
  "magnifying-glass": "search",
  "mask-happy": "drama",
  "microphone-stage": "mic-vocal",
  "minus": "minus",
  "minus-circle": "circle-minus",
  "note-pencil": "notebook-pen",
  "package": "package-open",
  "palette": "palette",
  "pause": "pause",
  "pen": "pen",
  "pen-nib": "pen-tool",
  "pencil-simple": "pencil",
  "plant": "sprout",
  "play": "play",
  "play-circle": "circle-play",
  "plugs-connected": "plug-zap",
  "plus": "plus",
  "push-pin": "pin",
  "puzzle-piece": "puzzle",
  "question": "circle-question-mark",
  "quotes": "quote",
  "robot": "bot",
  "rows": "rows-3",
  "screening": "clapperboard",
  "selection": "scan",
  "shield": "shield",
  "skip-back": "skip-back",
  "skip-forward": "skip-forward",
  "sliders": "sliders-horizontal",
  "sort-descending": "arrow-down-wide-narrow",
  "speaker-high": "volume-2",
  "spinner-gap": "loader-circle",
  "squares-four": "grid-2x2",
  "stack": "layers-2",
  "star": "star",
  "star-half": "star-half",
  "stop": "square",
  "stop-circle": "circle-stop",
  "syringe": "syringe",
  "tag": "tag",
  "target": "target",
  "tasks": "list-checks",
  "text-aa": "type",
  "text-underline": "underline",
  "trash": "trash-2",
  "trend-up": "trending-up",
  "upload-simple": "upload",
  "user": "user",
  "user-circle": "circle-user-round",
  "user-plus": "user-plus",
  "video-camera": "video",
  "voice-lines": "audio-lines",
  "voice-reextract": "list-restart",
  "voice-regenerate": "refresh-cw",
  "warning": "triangle-alert",
  "wave-sine": "audio-waveform",
  "world": "globe",
  "world-map": "map",
  "x": "x"
});

export const LUCIDE_ICON_MARKUP = Object.freeze({
  "anchor": "<path d=\"M12 6v16\"/><path d=\"m19 13 2-1a9 9 0 0 1-18 0l2 1\"/><path d=\"M9 11h6\"/><circle cx=\"12\" cy=\"4\" r=\"2\"/>",
  "archive": "<rect width=\"20\" height=\"5\" x=\"2\" y=\"3\" rx=\"1\"/><path d=\"M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8\"/><path d=\"M10 12h4\"/>",
  "arrow-down": "<path d=\"M12 5v14\"/><path d=\"m19 12-7 7-7-7\"/>",
  "arrow-down-wide-narrow": "<path d=\"m3 16 4 4 4-4\"/><path d=\"M7 20V4\"/><path d=\"M11 4h10\"/><path d=\"M11 8h7\"/><path d=\"M11 12h4\"/>",
  "arrow-left": "<path d=\"m12 19-7-7 7-7\"/><path d=\"M19 12H5\"/>",
  "arrow-left-right": "<path d=\"M8 3 4 7l4 4\"/><path d=\"M4 7h16\"/><path d=\"m16 21 4-4-4-4\"/><path d=\"M20 17H4\"/>",
  "arrow-right": "<path d=\"M5 12h14\"/><path d=\"m12 5 7 7-7 7\"/>",
  "arrow-up": "<path d=\"m5 12 7-7 7 7\"/><path d=\"M12 19V5\"/>",
  "audio-lines": "<path d=\"M2 10v3\"/><path d=\"M6 6v11\"/><path d=\"M10 3v18\"/><path d=\"M14 8v7\"/><path d=\"M18 5v13\"/><path d=\"M22 10v3\"/>",
  "audio-waveform": "<path d=\"M2 13a2 2 0 0 0 2-2V7a2 2 0 0 1 4 0v13a2 2 0 0 0 4 0V4a2 2 0 0 1 4 0v13a2 2 0 0 0 4 0v-4a2 2 0 0 1 2-2\"/>",
  "book": "<path d=\"M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H19a1 1 0 0 1 1 1v18a1 1 0 0 1-1 1H6.5a1 1 0 0 1 0-5H20\"/>",
  "book-marked": "<path d=\"M10 2v8l3-3 3 3V2\"/><path d=\"M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H19a1 1 0 0 1 1 1v18a1 1 0 0 1-1 1H6.5a1 1 0 0 1 0-5H20\"/>",
  "book-open": "<path d=\"M12 5v16\"/><path d=\"M20.001 19A2 2 0 0022 17V5a2 2 0 00-1.999-2L16 3.002A5 5 0 0012 5a5 5 0 00-4-2H4a2 2 0 00-2 2v12a2 2 0 001.999 2H8a5 5 0 014 2 5 5 0 014-2z\"/>",
  "book-open-text": "<path d=\"M12 5v16\"/><path d=\"M16 13h2\"/><path d=\"M16 9h2\"/><path d=\"M20.001 19A2 2 0 0022 17V5a2 2 0 00-1.999-2L16 3.002A5 5 0 0012 5a5 5 0 00-4-2H4a2 2 0 00-2 2v12a2 2 0 001.999 2H8a5 5 0 014 2 5 5 0 014-2z\"/><path d=\"M6 13h2\"/><path d=\"M6 9h2\"/>",
  "bookmark": "<path d=\"M17 3a2 2 0 0 1 2 2v15a1 1 0 0 1-1.496.868l-4.512-2.578a2 2 0 0 0-1.984 0l-4.512 2.578A1 1 0 0 1 5 20V5a2 2 0 0 1 2-2z\"/>",
  "bot": "<path d=\"M12 8V4H8\"/><rect width=\"16\" height=\"12\" x=\"4\" y=\"8\" rx=\"2\"/><path d=\"M2 14h2\"/><path d=\"M20 14h2\"/><path d=\"M15 13v2\"/><path d=\"M9 13v2\"/>",
  "brush-cleaning": "<path d=\"m16 22-1-4\"/><path d=\"M19 14a1 1 0 0 0 1-1v-1a2 2 0 0 0-2-2h-3a1 1 0 0 1-1-1V4a2 2 0 0 0-4 0v5a1 1 0 0 1-1 1H6a2 2 0 0 0-2 2v1a1 1 0 0 0 1 1\"/><path d=\"M19 14H5l-1.973 6.767A1 1 0 0 0 4 22h16a1 1 0 0 0 .973-1.233z\"/><path d=\"m8 22 1-4\"/>",
  "camera": "<path d=\"M13.997 4a2 2 0 0 1 1.76 1.05l.486.9A2 2 0 0 0 18.003 7H20a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2h1.997a2 2 0 0 0 1.759-1.048l.489-.904A2 2 0 0 1 10.004 4z\"/><circle cx=\"12\" cy=\"13\" r=\"3\"/>",
  "check": "<path d=\"M20 6 9 17l-5-5\"/>",
  "check-check": "<path d=\"M18 6 7 17l-5-5\"/><path d=\"m22 10-7.5 7.5L13 16\"/>",
  "chevron-down": "<path d=\"m6 9 6 6 6-6\"/>",
  "chevron-left": "<path d=\"m15 18-6-6 6-6\"/>",
  "chevron-right": "<path d=\"m9 18 6-6-6-6\"/>",
  "chevron-up": "<path d=\"m18 15-6-6-6 6\"/>",
  "circle": "<circle cx=\"12\" cy=\"12\" r=\"10\"/>",
  "circle-check-big": "<path d=\"M21.801 10A10 10 0 1 1 17 3.335\"/><path d=\"m9 11 3 3L22 4\"/>",
  "circle-minus": "<circle cx=\"12\" cy=\"12\" r=\"10\"/><path d=\"M8 12h8\"/>",
  "circle-play": "<path d=\"M9 9.003a1 1 0 0 1 1.517-.859l4.997 2.997a1 1 0 0 1 0 1.718l-4.997 2.997A1 1 0 0 1 9 14.996z\"/><circle cx=\"12\" cy=\"12\" r=\"10\"/>",
  "circle-question-mark": "<circle cx=\"12\" cy=\"12\" r=\"10\"/><path d=\"M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3\"/><path d=\"M12 17h.01\"/>",
  "circle-stop": "<circle cx=\"12\" cy=\"12\" r=\"10\"/><rect x=\"9\" y=\"9\" width=\"6\" height=\"6\" rx=\"1\"/>",
  "circle-user-round": "<path d=\"M17.925 20.056a6 6 0 0 0-11.851.001\"/><circle cx=\"12\" cy=\"11\" r=\"4\"/><circle cx=\"12\" cy=\"12\" r=\"10\"/>",
  "clapperboard": "<path d=\"m12.296 3.464 3.02 3.956\"/><path d=\"M20.2 6 3 11l-.9-2.4c-.3-1.1.3-2.2 1.3-2.5l13.5-4c1.1-.3 2.2.3 2.5 1.3z\"/><path d=\"M3 11h18v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z\"/><path d=\"m6.18 5.276 3.1 3.899\"/>",
  "clock": "<circle cx=\"12\" cy=\"12\" r=\"10\"/><path d=\"M12 6v6l4 2\"/>",
  "cloud-moon": "<path d=\"M13 16a3 3 0 0 1 0 6H7a5 5 0 1 1 4.9-6z\"/><path d=\"M18.376 14.512a6 6 0 0 0 3.461-4.127c.148-.625-.659-.97-1.248-.714a4 4 0 0 1-5.259-5.26c.255-.589-.09-1.395-.716-1.248a6 6 0 0 0-4.594 5.36\"/>",
  "coffee": "<path d=\"M10 2v2\"/><path d=\"M14 2v2\"/><path d=\"M16 8a1 1 0 0 1 1 1v8a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4V9a1 1 0 0 1 1-1h14a4 4 0 1 1 0 8h-1\"/><path d=\"M6 2v2\"/>",
  "contact-round": "<path d=\"M16 2v2\"/><path d=\"M17.915 21a6 6 0 10-12 0\"/><path d=\"M8 2v2\"/><circle cx=\"12\" cy=\"11\" r=\"4\"/><rect x=\"3\" y=\"3\" width=\"18\" height=\"18\" rx=\"2\"/>",
  "copy": "<rect width=\"14\" height=\"14\" x=\"8\" y=\"8\" rx=\"2\" ry=\"2\"/><path d=\"M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2\"/>",
  "cpu": "<path d=\"M12 20v2\"/><path d=\"M12 2v2\"/><path d=\"M17 20v2\"/><path d=\"M17 2v2\"/><path d=\"M2 12h2\"/><path d=\"M2 17h2\"/><path d=\"M2 7h2\"/><path d=\"M20 12h2\"/><path d=\"M20 17h2\"/><path d=\"M20 7h2\"/><path d=\"M7 20v2\"/><path d=\"M7 2v2\"/><rect x=\"4\" y=\"4\" width=\"16\" height=\"16\" rx=\"2\"/><rect x=\"8\" y=\"8\" width=\"8\" height=\"8\" rx=\"1\"/>",
  "crosshair": "<circle cx=\"12\" cy=\"12\" r=\"10\"/><line x1=\"22\" x2=\"18\" y1=\"12\" y2=\"12\"/><line x1=\"6\" x2=\"2\" y1=\"12\" y2=\"12\"/><line x1=\"12\" x2=\"12\" y1=\"6\" y2=\"2\"/><line x1=\"12\" x2=\"12\" y1=\"22\" y2=\"18\"/>",
  "database": "<ellipse cx=\"12\" cy=\"5\" rx=\"9\" ry=\"3\"/><path d=\"M3 5V19A9 3 0 0 0 21 19V5\"/><path d=\"M3 12A9 3 0 0 0 21 12\"/>",
  "download": "<path d=\"M12 15V3\"/><path d=\"M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4\"/><path d=\"m7 10 5 5 5-5\"/>",
  "drama": "<path d=\"M10 11h.01\"/><path d=\"M14 6h.01\"/><path d=\"M18 6h.01\"/><path d=\"M6.5 13.1h.01\"/><path d=\"M22 5c0 9-4 12-6 12s-6-3-6-12c0-2 2-3 6-3s6 1 6 3\"/><path d=\"M17.4 9.9c-.8.8-2 .8-2.8 0\"/><path d=\"M10.1 7.1C9 7.2 7.7 7.7 6 8.6c-3.5 2-4.7 3.9-3.7 5.6 4.5 7.8 9.5 8.4 11.2 7.4.9-.5 1.9-2.1 1.9-4.7\"/><path d=\"M9.1 16.5c.3-1.1 1.4-1.7 2.4-1.4\"/>",
  "earth": "<path d=\"M21.54 15H17a2 2 0 0 0-2 2v4.54\"/><path d=\"M7 3.34V5a3 3 0 0 0 3 3a2 2 0 0 1 2 2c0 1.1.9 2 2 2a2 2 0 0 0 2-2c0-1.1.9-2 2-2h3.17\"/><path d=\"M11 21.95V18a2 2 0 0 0-2-2a2 2 0 0 1-2-2v-1a2 2 0 0 0-2-2H2.05\"/><circle cx=\"12\" cy=\"12\" r=\"10\"/>",
  "ellipsis": "<circle cx=\"12\" cy=\"12\" r=\"1\"/><circle cx=\"19\" cy=\"12\" r=\"1\"/><circle cx=\"5\" cy=\"12\" r=\"1\"/>",
  "eraser": "<path d=\"M21 21H8a2 2 0 0 1-1.42-.587l-3.994-3.999a2 2 0 0 1 0-2.828l10-10a2 2 0 0 1 2.829 0l5.999 6a2 2 0 0 1 0 2.828L12.834 21\"/><path d=\"m5.082 11.09 8.828 8.828\"/>",
  "eye": "<path d=\"M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0\"/><circle cx=\"12\" cy=\"12\" r=\"3\"/>",
  "eye-off": "<path d=\"M10.733 5.076a10.744 10.744 0 0 1 11.205 6.575 1 1 0 0 1 0 .696 10.747 10.747 0 0 1-1.444 2.49\"/><path d=\"M14.084 14.158a3 3 0 0 1-4.242-4.242\"/><path d=\"M17.479 17.499a10.75 10.75 0 0 1-15.417-5.151 1 1 0 0 1 0-.696 10.75 10.75 0 0 1 4.446-5.143\"/><path d=\"m2 2 20 20\"/>",
  "feather": "<path d=\"M14.086 18.412A2 2 0 0112.67 19H5v-7.672a2 2 0 01.586-1.414L11.75 3.75a6 6 0 118.49 8.49z\"/><path d=\"M16 8 2 22\"/><path d=\"M17.488 15H9\"/>",
  "file-down": "<path d=\"M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z\"/><path d=\"M14 2v5a1 1 0 0 0 1 1h5\"/><path d=\"M12 18v-6\"/><path d=\"m9 15 3 3 3-3\"/>",
  "file-up": "<path d=\"M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z\"/><path d=\"M14 2v5a1 1 0 0 0 1 1h5\"/><path d=\"M12 12v6\"/><path d=\"m15 15-3-3-3 3\"/>",
  "film": "<rect width=\"18\" height=\"18\" x=\"3\" y=\"3\" rx=\"2\"/><path d=\"M7 3v18\"/><path d=\"M3 7.5h4\"/><path d=\"M3 12h18\"/><path d=\"M3 16.5h4\"/><path d=\"M17 3v18\"/><path d=\"M17 7.5h4\"/><path d=\"M17 16.5h4\"/>",
  "flask-conical": "<path d=\"M14 2v6a2 2 0 0 0 .245.96l5.51 10.08A2 2 0 0 1 18 22H6a2 2 0 0 1-1.755-2.96l5.51-10.08A2 2 0 0 0 10 8V2\"/><path d=\"M6.453 15h11.094\"/><path d=\"M8.5 2h7\"/>",
  "folder": "<path d=\"M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z\"/>",
  "folder-minus": "<path d=\"M9 13h6\"/><path d=\"M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z\"/>",
  "folder-plus": "<path d=\"M12 10v6\"/><path d=\"M9 13h6\"/><path d=\"M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z\"/>",
  "folder-search": "<path d=\"M10.7 20H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H20a2 2 0 0 1 2 2v4.1\"/><path d=\"m21 21-1.9-1.9\"/><circle cx=\"17\" cy=\"17\" r=\"3\"/>",
  "funnel": "<path d=\"M10 20a1 1 0 0 0 .553.895l2 1A1 1 0 0 0 14 21v-7a2 2 0 0 1 .517-1.341L21.74 4.67A1 1 0 0 0 21 3H3a1 1 0 0 0-.742 1.67l7.225 7.989A2 2 0 0 1 10 14z\"/>",
  "gauge": "<path d=\"m12 14 4-4\"/><path d=\"M3.34 19a10 10 0 1 1 17.32 0\"/>",
  "globe": "<circle cx=\"12\" cy=\"12\" r=\"10\"/><path d=\"M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20\"/><path d=\"M2 12h20\"/>",
  "grid-2x2": "<path d=\"M12 3v18\"/><path d=\"M3 12h18\"/><rect x=\"3\" y=\"3\" width=\"18\" height=\"18\" rx=\"2\"/>",
  "headphones": "<path d=\"M3 14h3a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-7a9 9 0 0 1 18 0v7a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3\"/>",
  "highlighter": "<path d=\"m9 11-6 6v3h9l3-3\"/><path d=\"m22 12-4.6 4.6a2 2 0 0 1-2.8 0l-5.2-5.2a2 2 0 0 1 0-2.8L14 4\"/>",
  "hourglass": "<path d=\"M5 22h14\"/><path d=\"M5 2h14\"/><path d=\"M17 22v-4.172a2 2 0 0 0-.586-1.414L12 12l-4.414 4.414A2 2 0 0 0 7 17.828V22\"/><path d=\"M7 2v4.172a2 2 0 0 0 .586 1.414L12 12l4.414-4.414A2 2 0 0 0 17 6.172V2\"/>",
  "image": "<rect width=\"18\" height=\"18\" x=\"3\" y=\"3\" rx=\"2\" ry=\"2\"/><circle cx=\"9\" cy=\"9\" r=\"2\"/><path d=\"m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21\"/>",
  "images": "<path d=\"m22 11-1.296-1.296a2.4 2.4 0 0 0-3.408 0L11 16\"/><path d=\"M4 8a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2\"/><circle cx=\"13\" cy=\"7\" r=\"1\" fill=\"currentColor\"/><rect x=\"8\" y=\"2\" width=\"14\" height=\"14\" rx=\"2\"/>",
  "info": "<circle cx=\"12\" cy=\"12\" r=\"10\"/><path d=\"M12 16v-4\"/><path d=\"M12 8h.01\"/>",
  "layers-2": "<path d=\"M13 13.74a2 2 0 0 1-2 0L2.5 8.87a1 1 0 0 1 0-1.74L11 2.26a2 2 0 0 1 2 0l8.5 4.87a1 1 0 0 1 0 1.74z\"/><path d=\"m20 14.285 1.5.845a1 1 0 0 1 0 1.74L13 21.74a2 2 0 0 1-2 0l-8.5-4.87a1 1 0 0 1 0-1.74l1.5-.845\"/>",
  "layout-dashboard": "<rect width=\"7\" height=\"9\" x=\"3\" y=\"3\" rx=\"1\"/><rect width=\"7\" height=\"5\" x=\"14\" y=\"3\" rx=\"1\"/><rect width=\"7\" height=\"9\" x=\"14\" y=\"12\" rx=\"1\"/><rect width=\"7\" height=\"5\" x=\"3\" y=\"16\" rx=\"1\"/>",
  "lightbulb": "<path d=\"M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5\"/><path d=\"M9 18h6\"/><path d=\"M10 22h4\"/>",
  "link": "<path d=\"M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71\"/><path d=\"M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71\"/>",
  "list": "<path d=\"M3 5h.01\"/><path d=\"M3 12h.01\"/><path d=\"M3 19h.01\"/><path d=\"M8 5h13\"/><path d=\"M8 12h13\"/><path d=\"M8 19h13\"/>",
  "list-checks": "<path d=\"M13 5h8\"/><path d=\"M13 12h8\"/><path d=\"M13 19h8\"/><path d=\"m3 17 2 2 4-4\"/><path d=\"m3 7 2 2 4-4\"/>",
  "list-ordered": "<path d=\"M11 5h10\"/><path d=\"M11 12h10\"/><path d=\"M11 19h10\"/><path d=\"M4 4h1v5\"/><path d=\"M4 9h2\"/><path d=\"M6.5 20H3.4c0-1 2.6-1.925 2.6-3.5a1.5 1.5 0 0 0-2.6-1.02\"/>",
  "list-restart": "<path d=\"M21 5H3\"/><path d=\"M7 12H3\"/><path d=\"M7 19H3\"/><path d=\"M12 18a5 5 0 0 0 9-3 4.5 4.5 0 0 0-4.5-4.5c-1.33 0-2.54.54-3.41 1.41L11 14\"/><path d=\"M11 10v4h4\"/>",
  "loader-circle": "<path d=\"M21 12a9 9 0 1 1-6.219-8.56\"/>",
  "map": "<path d=\"M14.106 5.553a2 2 0 0 0 1.788 0l3.659-1.83A1 1 0 0 1 21 4.619v12.764a1 1 0 0 1-.553.894l-4.553 2.277a2 2 0 0 1-1.788 0l-4.212-2.106a2 2 0 0 0-1.788 0l-3.659 1.83A1 1 0 0 1 3 19.381V6.618a1 1 0 0 1 .553-.894l4.553-2.277a2 2 0 0 1 1.788 0z\"/><path d=\"M15 5.764v15\"/><path d=\"M9 3.236v15\"/>",
  "maximize": "<path d=\"M8 3H5a2 2 0 0 0-2 2v3\"/><path d=\"M21 8V5a2 2 0 0 0-2-2h-3\"/><path d=\"M3 16v3a2 2 0 0 0 2 2h3\"/><path d=\"M16 21h3a2 2 0 0 0 2-2v-3\"/>",
  "maximize-2": "<path d=\"M15 3h6v6\"/><path d=\"m21 3-7 7\"/><path d=\"m3 21 7-7\"/><path d=\"M9 21H3v-6\"/>",
  "message-square": "<path d=\"M22 17a2 2 0 0 1-2 2H6.828a2 2 0 0 0-1.414.586l-2.202 2.202A.71.71 0 0 1 2 21.286V5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2z\"/>",
  "message-square-more": "<path d=\"M22 17a2 2 0 0 1-2 2H6.828a2 2 0 0 0-1.414.586l-2.202 2.202A.71.71 0 0 1 2 21.286V5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2z\"/><path d=\"M12 11h.01\"/><path d=\"M16 11h.01\"/><path d=\"M8 11h.01\"/>",
  "messages-square": "<path d=\"M16 10a2 2 0 0 1-2 2H6.828a2 2 0 0 0-1.414.586l-2.202 2.202A.71.71 0 0 1 2 14.286V4a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z\"/><path d=\"M20 9a2 2 0 0 1 2 2v10.286a.71.71 0 0 1-1.212.502l-2.202-2.202A2 2 0 0 0 17.172 19H10a2 2 0 0 1-2-2v-1\"/>",
  "mic-vocal": "<path d=\"m11 7.601-5.994 8.19a1 1 0 0 0 .1 1.298l.817.818a1 1 0 0 0 1.314.087L15.09 12\"/><path d=\"M16.5 21.174C15.5 20.5 14.372 20 13 20c-2.058 0-3.928 2.356-6 2-2.072-.356-2.775-3.369-1.5-4.5\"/><circle cx=\"16\" cy=\"7\" r=\"5\"/>",
  "minimize-2": "<path d=\"m14 10 7-7\"/><path d=\"M20 10h-6V4\"/><path d=\"m3 21 7-7\"/><path d=\"M4 14h6v6\"/>",
  "minus": "<path d=\"M5 12h14\"/>",
  "network": "<rect x=\"16\" y=\"16\" width=\"6\" height=\"6\" rx=\"1\"/><rect x=\"2\" y=\"16\" width=\"6\" height=\"6\" rx=\"1\"/><rect x=\"9\" y=\"2\" width=\"6\" height=\"6\" rx=\"1\"/><path d=\"M5 16v-3a1 1 0 0 1 1-1h12a1 1 0 0 1 1 1v3\"/><path d=\"M12 12V8\"/>",
  "notebook-pen": "<path d=\"M13.4 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-7.4\"/><path d=\"M2 6h4\"/><path d=\"M2 10h4\"/><path d=\"M2 14h4\"/><path d=\"M2 18h4\"/><path d=\"M21.378 5.626a1 1 0 1 0-3.004-3.004l-5.01 5.012a2 2 0 0 0-.506.854l-.837 2.87a.5.5 0 0 0 .62.62l2.87-.837a2 2 0 0 0 .854-.506z\"/>",
  "package-open": "<path d=\"M12 22v-9\"/><path d=\"M15.17 2.21a1.67 1.67 0 0 1 1.63 0L21 4.57a1.93 1.93 0 0 1 0 3.36L8.82 14.79a1.655 1.655 0 0 1-1.64 0L3 12.43a1.93 1.93 0 0 1 0-3.36z\"/><path d=\"M20 13v3.87a2.06 2.06 0 0 1-1.11 1.83l-6 3.08a1.93 1.93 0 0 1-1.78 0l-6-3.08A2.06 2.06 0 0 1 4 16.87V13\"/><path d=\"M21 12.43a1.93 1.93 0 0 0 0-3.36L8.83 2.2a1.64 1.64 0 0 0-1.63 0L3 4.57a1.93 1.93 0 0 0 0 3.36l12.18 6.86a1.636 1.636 0 0 0 1.63 0z\"/>",
  "palette": "<path d=\"M12 22a1 1 0 0 1 0-20 10 9 0 0 1 10 9 5 5 0 0 1-5 5h-2.25a1.75 1.75 0 0 0-1.4 2.8l.3.4a1.75 1.75 0 0 1-1.4 2.8z\"/><circle cx=\"13.5\" cy=\"6.5\" r=\".5\" fill=\"currentColor\"/><circle cx=\"17.5\" cy=\"10.5\" r=\".5\" fill=\"currentColor\"/><circle cx=\"6.5\" cy=\"12.5\" r=\".5\" fill=\"currentColor\"/><circle cx=\"8.5\" cy=\"7.5\" r=\".5\" fill=\"currentColor\"/>",
  "pause": "<rect x=\"14\" y=\"3\" width=\"5\" height=\"18\" rx=\"1\"/><rect x=\"5\" y=\"3\" width=\"5\" height=\"18\" rx=\"1\"/>",
  "pen": "<path d=\"M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z\"/>",
  "pen-tool": "<path d=\"M15.707 21.293a1 1 0 0 1-1.414 0l-1.586-1.586a1 1 0 0 1 0-1.414l5.586-5.586a1 1 0 0 1 1.414 0l1.586 1.586a1 1 0 0 1 0 1.414z\"/><path d=\"m18 13-1.375-6.874a1 1 0 0 0-.746-.776L3.235 2.028a1 1 0 0 0-1.207 1.207L5.35 15.879a1 1 0 0 0 .776.746L13 18\"/><path d=\"m2.3 2.3 7.286 7.286\"/><circle cx=\"11\" cy=\"11\" r=\"2\"/>",
  "pencil": "<path d=\"M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z\"/><path d=\"m15 5 4 4\"/>",
  "pin": "<path d=\"M12 17v5\"/><path d=\"M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z\"/>",
  "play": "<path d=\"M5 5a2 2 0 0 1 3.008-1.728l11.997 6.998a2 2 0 0 1 .003 3.458l-12 7A2 2 0 0 1 5 19z\"/>",
  "plug-zap": "<path d=\"M6.3 20.3a2.4 2.4 0 0 0 3.4 0L12 18l-6-6-2.3 2.3a2.4 2.4 0 0 0 0 3.4Z\"/><path d=\"m2 22 3-3\"/><path d=\"M7.5 13.5 10 11\"/><path d=\"M10.5 16.5 13 14\"/><path d=\"m18 3-4 4h6l-4 4\"/>",
  "plus": "<path d=\"M5 12h14\"/><path d=\"M12 5v14\"/>",
  "puzzle": "<path d=\"M15.39 4.39a1 1 0 0 0 1.68-.474 2.5 2.5 0 1 1 3.014 3.015 1 1 0 0 0-.474 1.68l1.683 1.682a2.414 2.414 0 0 1 0 3.414L19.61 15.39a1 1 0 0 1-1.68-.474 2.5 2.5 0 1 0-3.014 3.015 1 1 0 0 1 .474 1.68l-1.683 1.682a2.414 2.414 0 0 1-3.414 0L8.61 19.61a1 1 0 0 0-1.68.474 2.5 2.5 0 1 1-3.014-3.015 1 1 0 0 0 .474-1.68l-1.683-1.682a2.414 2.414 0 0 1 0-3.414L4.39 8.61a1 1 0 0 1 1.68.474 2.5 2.5 0 1 0 3.014-3.015 1 1 0 0 1-.474-1.68l1.683-1.682a2.414 2.414 0 0 1 3.414 0z\"/>",
  "quote": "<path d=\"M16 3a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2 1 1 0 0 1 1 1v1a2 2 0 0 1-2 2 1 1 0 0 0-1 1v2a1 1 0 0 0 1 1 6 6 0 0 0 6-6V5a2 2 0 0 0-2-2z\"/><path d=\"M5 3a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2 1 1 0 0 1 1 1v1a2 2 0 0 1-2 2 1 1 0 0 0-1 1v2a1 1 0 0 0 1 1 6 6 0 0 0 6-6V5a2 2 0 0 0-2-2z\"/>",
  "refresh-cw": "<path d=\"M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8\"/><path d=\"M21 3v5h-5\"/><path d=\"M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16\"/><path d=\"M8 16H3v5\"/>",
  "rotate-ccw": "<path d=\"M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8\"/><path d=\"M3 3v5h5\"/>",
  "rotate-cw": "<path d=\"M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8\"/><path d=\"M21 3v5h-5\"/>",
  "rows-3": "<rect width=\"18\" height=\"18\" x=\"3\" y=\"3\" rx=\"2\"/><path d=\"M21 9H3\"/><path d=\"M21 15H3\"/>",
  "save": "<path d=\"M15.2 3a2 2 0 0 1 1.4.6l3.8 3.8a2 2 0 0 1 .6 1.4V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z\"/><path d=\"M17 21v-7a1 1 0 0 0-1-1H8a1 1 0 0 0-1 1v7\"/><path d=\"M7 3v4a1 1 0 0 0 1 1h7\"/>",
  "scan": "<path d=\"M3 7V5a2 2 0 0 1 2-2h2\"/><path d=\"M17 3h2a2 2 0 0 1 2 2v2\"/><path d=\"M21 17v2a2 2 0 0 1-2 2h-2\"/><path d=\"M7 21H5a2 2 0 0 1-2-2v-2\"/>",
  "search": "<path d=\"m21 21-4.34-4.34\"/><circle cx=\"11\" cy=\"11\" r=\"8\"/>",
  "settings": "<path d=\"M9.671 4.136a2.34 2.34 0 0 1 4.659 0 2.34 2.34 0 0 0 3.319 1.915 2.34 2.34 0 0 1 2.33 4.033 2.34 2.34 0 0 0 0 3.831 2.34 2.34 0 0 1-2.33 4.033 2.34 2.34 0 0 0-3.319 1.915 2.34 2.34 0 0 1-4.659 0 2.34 2.34 0 0 0-3.32-1.915 2.34 2.34 0 0 1-2.33-4.033 2.34 2.34 0 0 0 0-3.831A2.34 2.34 0 0 1 6.35 6.051a2.34 2.34 0 0 0 3.319-1.915\"/><circle cx=\"12\" cy=\"12\" r=\"3\"/>",
  "shield": "<path d=\"M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z\"/>",
  "skip-back": "<path d=\"M17.971 4.285A2 2 0 0 1 21 6v12a2 2 0 0 1-3.029 1.715l-9.997-5.998a2 2 0 0 1-.003-3.432z\"/><path d=\"M3 20V4\"/>",
  "skip-forward": "<path d=\"M21 4v16\"/><path d=\"M6.029 4.285A2 2 0 0 0 3 6v12a2 2 0 0 0 3.029 1.715l9.997-5.998a2 2 0 0 0 .003-3.432z\"/>",
  "sliders-horizontal": "<path d=\"M10 5H3\"/><path d=\"M12 19H3\"/><path d=\"M14 3v4\"/><path d=\"M16 17v4\"/><path d=\"M21 12h-9\"/><path d=\"M21 19h-5\"/><path d=\"M21 5h-7\"/><path d=\"M8 10v4\"/><path d=\"M8 12H3\"/>",
  "sparkles": "<path d=\"M11.017 2.814a1 1 0 0 1 1.966 0l1.051 5.558a2 2 0 0 0 1.594 1.594l5.558 1.051a1 1 0 0 1 0 1.966l-5.558 1.051a2 2 0 0 0-1.594 1.594l-1.051 5.558a1 1 0 0 1-1.966 0l-1.051-5.558a2 2 0 0 0-1.594-1.594l-5.558-1.051a1 1 0 0 1 0-1.966l5.558-1.051a2 2 0 0 0 1.594-1.594z\"/><path d=\"M20 2v4\"/><path d=\"M22 4h-4\"/><circle cx=\"4\" cy=\"20\" r=\"2\"/>",
  "sprout": "<path d=\"M14 9.536V7a4 4 0 0 1 4-4h1.5a.5.5 0 0 1 .5.5V5a4 4 0 0 1-4 4 4 4 0 0 0-4 4c0 2 1 3 1 5a5 5 0 0 1-1 3\"/><path d=\"M4 9a5 5 0 0 1 8 4 5 5 0 0 1-8-4\"/><path d=\"M5 21h14\"/>",
  "square": "<rect width=\"18\" height=\"18\" x=\"3\" y=\"3\" rx=\"2\"/>",
  "square-check-big": "<path d=\"M21 10.656V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h12.344\"/><path d=\"m9 11 3 3L22 4\"/>",
  "star": "<path d=\"M11.525 2.295a.53.53 0 0 1 .95 0l2.31 4.679a2.123 2.123 0 0 0 1.595 1.16l5.166.756a.53.53 0 0 1 .294.904l-3.736 3.638a2.123 2.123 0 0 0-.611 1.878l.882 5.14a.53.53 0 0 1-.771.56l-4.618-2.428a2.122 2.122 0 0 0-1.973 0L6.396 21.01a.53.53 0 0 1-.77-.56l.881-5.139a2.122 2.122 0 0 0-.611-1.879L2.16 9.795a.53.53 0 0 1 .294-.906l5.165-.755a2.122 2.122 0 0 0 1.597-1.16z\"/>",
  "star-half": "<path d=\"M12 18.338a2.1 2.1 0 0 0-.987.244L6.396 21.01a.53.53 0 0 1-.77-.56l.881-5.139a2.12 2.12 0 0 0-.611-1.879L2.16 9.795a.53.53 0 0 1 .294-.906l5.165-.755a2.12 2.12 0 0 0 1.597-1.16l2.309-4.679A.53.53 0 0 1 12 2\"/>",
  "syringe": "<path d=\"m18 2 4 4\"/><path d=\"m17 7 3-3\"/><path d=\"M19 9 8.7 19.3c-1 1-2.5 1-3.4 0l-.6-.6c-1-1-1-2.5 0-3.4L15 5\"/><path d=\"m9 11 4 4\"/><path d=\"m5 19-3 3\"/><path d=\"m14 4 6 6\"/>",
  "tag": "<path d=\"M12.586 2.586A2 2 0 0 0 11.172 2H4a2 2 0 0 0-2 2v7.172a2 2 0 0 0 .586 1.414l8.704 8.704a2.426 2.426 0 0 0 3.42 0l6.58-6.58a2.426 2.426 0 0 0 0-3.42z\"/><circle cx=\"7.5\" cy=\"7.5\" r=\".5\" fill=\"currentColor\"/>",
  "target": "<circle cx=\"12\" cy=\"12\" r=\"10\"/><circle cx=\"12\" cy=\"12\" r=\"6\"/><circle cx=\"12\" cy=\"12\" r=\"2\"/>",
  "trash-2": "<path d=\"M10 11v6\"/><path d=\"M14 11v6\"/><path d=\"M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6\"/><path d=\"M3 6h18\"/><path d=\"M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2\"/>",
  "trending-up": "<path d=\"M16 7h6v6\"/><path d=\"m22 7-8.5 8.5-5-5L2 17\"/>",
  "triangle-alert": "<path d=\"m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3\"/><path d=\"M12 9v4\"/><path d=\"M12 17h.01\"/>",
  "type": "<path d=\"M12 4v16\"/><path d=\"M4 7V5a1 1 0 0 1 1-1h14a1 1 0 0 1 1 1v2\"/><path d=\"M9 20h6\"/>",
  "underline": "<path d=\"M6 4v6a6 6 0 0 0 12 0V4\"/><line x1=\"4\" x2=\"20\" y1=\"20\" y2=\"20\"/>",
  "upload": "<path d=\"M12 3v12\"/><path d=\"m17 8-5-5-5 5\"/><path d=\"M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4\"/>",
  "user": "<path d=\"M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2\"/><circle cx=\"12\" cy=\"7\" r=\"4\"/>",
  "user-plus": "<path d=\"M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2\"/><circle cx=\"9\" cy=\"7\" r=\"4\"/><line x1=\"19\" x2=\"19\" y1=\"8\" y2=\"14\"/><line x1=\"22\" x2=\"16\" y1=\"11\" y2=\"11\"/>",
  "video": "<path d=\"m16 13 5.223 3.482a.5.5 0 0 0 .777-.416V7.87a.5.5 0 0 0-.752-.432L16 10.5\"/><rect x=\"2\" y=\"6\" width=\"14\" height=\"12\" rx=\"2\"/>",
  "volume-2": "<path d=\"M11 4.702a.705.705 0 0 0-1.203-.498L6.413 7.587A1.4 1.4 0 0 1 5.416 8H3a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2.416a1.4 1.4 0 0 1 .997.413l3.383 3.384A.705.705 0 0 0 11 19.298z\"/><path d=\"M16 9a5 5 0 0 1 0 6\"/><path d=\"M19.364 18.364a9 9 0 0 0 0-12.728\"/>",
  "wand-sparkles": "<path d=\"m21.64 3.64-1.28-1.28a1.21 1.21 0 0 0-1.72 0L2.36 18.64a1.21 1.21 0 0 0 0 1.72l1.28 1.28a1.2 1.2 0 0 0 1.72 0L21.64 5.36a1.2 1.2 0 0 0 0-1.72\"/><path d=\"m14 7 3 3\"/><path d=\"M5 6v4\"/><path d=\"M19 14v4\"/><path d=\"M10 2v2\"/><path d=\"M7 8H3\"/><path d=\"M21 16h-4\"/><path d=\"M11 3H9\"/>",
  "x": "<path d=\"M18 6 6 18\"/><path d=\"m6 6 12 12\"/>"
});

export const QIANMU_ICON_SYSTEM_VERSION = `lucide-${LUCIDE_SOURCE_VERSION}`;
export const QIANMU_ICON_SYSTEM_NAME = 'Lucide · 千幕 2.5';

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
  'fa-ban': 'qm-regular-stop-circle',
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

export const QIANMU_INLINE_GLYPH_COUNT = Object.keys(LUCIDE_ICON_MARKUP).length;

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
  return String(symbol || '').trim().replace(/^qm-(?:duotone|regular|fill|user|signature)-/, '');
}

function glyphMarkupFor(symbol) {
  const lucideName = LUCIDE_GLYPH_NAMES[glyphNameFor(symbol)] || 'sparkles';
  return LUCIDE_ICON_MARKUP[lucideName] || LUCIDE_ICON_MARKUP.sparkles;
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
  svg.setAttribute('stroke-width', String(LUCIDE_STROKE_WIDTH));
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
  return `<i class="${classes}" data-qm-icon="${symbol}" ${ICON_DATA}="${symbol}"><svg class="qm-glyph-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${LUCIDE_STROKE_WIDTH}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false" ${ICON_DATA}="${symbol}">${glyphMarkupFor(symbol)}</svg></i>`;
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
    svg.setAttribute('stroke-width', String(LUCIDE_STROKE_WIDTH));
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
