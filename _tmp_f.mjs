import { readFileSync, writeFileSync } from 'node:fs';
const f = 'qianmu-font-runtime.js'; let s = readFileSync(f, 'utf8');
const rep = (a, b) => { if (!s.includes(a)) throw new Error('missing: ' + a.slice(0, 80)); s = s.replace(a, b); };
rep("const ST_TARGET = `", `// Beautify themes paint the top-bar drawer labels ("参数"/"连接"…) as ::before text with their own
// font-family !important. The element is an icon (exempt above), so the label pseudo is targeted
// on its own. Font Awesome stays first so plain ST keeps its glyph icons; CJK label text has no
// glyph there and falls through to the chosen family.
const ST_LABEL_PSEUDO = '#top-settings-holder > .drawer > .drawer-toggle > .drawer-icon::before';
// Reading-meta pseudo text drawn by such themes on message chrome (e.g. "正在阅读").
const READING_META_PSEUDO = '#chat > .mes > .mesAvatarWrapper::after';
const ST_TARGET = \``);
rep("${READING_META} { ${font} font-weight:${weight} !important; font-style:${style} !important; }\n", "${READING_META} { ${font} font-weight:${weight} !important; font-style:${style} !important; }\n${READING_META_PSEUDO} { ${font} }\n");
rep("ST_TARGET}:not(:is(em, em *, i, i *)) { font-style:${style} !important; }`);", "ST_TARGET}:not(:is(em, em *, i, i *)) { font-style:${style} !important; }\n${ST_LABEL_PSEUDO} { font-family:var(--fa-style-family,\"Font Awesome 6 Free\"),${quoted(family)},var(--mainFontFamily,system-ui,sans-serif) !important; }`);");
writeFileSync(f, s);
