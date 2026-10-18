// FontFace, not an external stylesheet, is the only path by which catalog CSS
// reaches the page. Registering preview faces never applies a font to ST.
const PROSE_ROOT = '#chat .mes .mes_text:not([data-sd-prose-mixed="1"]):not(:has(style, .np-min-card, [data-sd-prose-exempt], > :is(div, section, article, p):is([class], [style]):not(.sd-prose-run)))';
const PROSE_RUN = '#chat .mes .mes_text[data-sd-prose-mixed="1"] > .sd-prose-run[data-sd-prose-run="1"]';
// Without the optional layout feature, mixed messages have no prose-run
// wrappers. Only their ordinary direct paragraphs are safe to select; raw
// text beside authored cards deliberately retains native typography.
const PROSE_MIXED_PARAGRAPH = '#chat .mes .mes_text:not([data-sd-prose-mixed="1"]):has(style, .np-min-card, [data-sd-prose-exempt], > :is(div, section, article, p):is([class], [style])) > :is(p, div):not([class], [style]):not(:has(style, .np-min-card, [data-sd-prose-exempt], :is(div, section, article, p):is([class], [style])))';
const PROSE_TEXT_EXEMPT = 'pre, code, kbd, samp, svg, canvas, .fa, .fas, .far, .fab, .fal, .fad, [class*="fa-"], [class*="icon"], .np-min-card, [data-sd-prose-exempt], [id^="story-director-"], :is(div, section, article, p):is([class], [style]):not(.sd-prose-run)';
const PROSE_TEXT_TARGET = `:is(${PROSE_ROOT}, ${PROSE_RUN}, ${PROSE_MIXED_PARAGRAPH}) :is(p, div, span, a, b, strong, em, i, u, s, q, blockquote, ul, ol, li, h1, h2, h3, h4, h5, h6, sub, sup, small):not(:is(${PROSE_TEXT_EXEMPT})):not(.mes_text :is(${PROSE_TEXT_EXEMPT}) *)`;
// Body carries state classes such as sd-prose-layout; those are not a Qianmu
// window and must not accidentally exempt the whole host interface.
const OWN_SURFACE = '[id^="story-director-"], :is([class^="sd-"], [class*=" sd-"], [class^="qm-"], [class*=" qm-"]):not(html):not(body)';
const EXEMPT = '.mes_text, .mes_text *, pre, pre *, code, code *, kbd, kbd *, samp, samp *, svg, svg *, canvas, i, .fa, .fas, .far, .fab, .fal, .fad, [class*="fa-"], [class*="fa-"] *, [class*="icon"], [class*="icon"] *, [data-sd-prose-exempt], [data-sd-prose-exempt] *, [style*="font-family" i], [style*="font-family" i] *';
// Do not style body or message/Qianmu ancestors: an excluded descendant must
// not inherit a changed font from an otherwise eligible host container.
const ST_TARGET = `html body :is(div, span, p, a, label, button, input, textarea, select, option, summary, legend, h1, h2, h3, h4, h5, h6, li, td, th, small):not(:is(${EXEMPT})):not(:is(${OWN_SURFACE})):not(:is(${OWN_SURFACE}) *):not(:has(.mes_text, ${OWN_SURFACE}))`;

export function fontPreviewFamily(id) {
  return `QianmuFont_${Array.from(String(id || '')).map((character) => character.codePointAt(0).toString(16)).join('_') || 'none'}`;
}

function styleValue(value) { return value === 'italic' || value === 'oblique' ? value : 'normal'; }
function descriptorStyle(value) {
  const style = String(value || 'normal').trim().toLowerCase().replace(/\s+/g, ' ');
  if (!/^(?:normal|italic|oblique(?: -?\d{1,2}(?:\.\d+)?deg){0,2})$/.test(style)) return 'normal';
  const angles = [...style.matchAll(/(-?\d+(?:\.\d+)?)deg/g)].map((match) => Number(match[1]));
  return angles.every((angle) => angle >= -90 && angle <= 90) && (angles.length < 2 || angles[0] <= angles[1]) ? style : 'normal';
}
function descriptorStretch(value) {
  const stretch = String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
  if (/^(?:normal|ultra-condensed|extra-condensed|condensed|semi-condensed|semi-expanded|expanded|extra-expanded|ultra-expanded)$/.test(stretch)) return stretch;
  if (/^(?:[1-9]\d{0,2}(?:\.\d+)?%)(?:\s+[1-9]\d{0,2}(?:\.\d+)?%)?$/.test(stretch)) return stretch;
  return '';
}
function weightValue(value) {
  const text = String(value ?? '400').trim();
  if (/^(?:[1-9]\d{0,2}|1000)(?:\s+(?:[1-9]\d{0,2}|1000))?$/.test(text)) return text;
  return text === 'bold' ? '700' : '400';
}
function selectedWeight(value) { return weightValue(value).split(/\s+/)[0]; }
function declaredProbe(faces, selection) {
  const style = styleValue(selection.style), weight = Number(selectedWeight(selection.weight));
  const matching = faces.filter((face) => {
    const ownStyle = String(face.style || '').startsWith('oblique') ? 'oblique' : styleValue(face.style);
    const [low, high = low] = weightValue(face.weight).split(/\s+/).map(Number);
    return ownStyle === style && weight >= low && weight <= high;
  });
  for (const face of matching.length ? matching : faces) {
    if (!face.unicodeRange) continue;
    for (const item of face.unicodeRange.split(',')) {
      const [first, last = first] = item.trim().replace(/^U\+/i, '').split('-');
      let point = Number.parseInt(first.replace(/\?/g, '0'), 16);
      const end = Number.parseInt(last.replace(/\?/g, 'f'), 16);
      if (!Number.isFinite(point) || !Number.isFinite(end) || end > 0x10ffff || point > end) continue;
      if (point < 32 && end >= 32) point = 32;
      if (point >= 0xd800 && point <= 0xdfff) point = 0xe000;
      if (point <= end) return String.fromCodePoint(point);
    }
  }
  return '';
}
function webUrl(value) {
  try {
    const parsed = new URL(String(value));
    if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password) return null;
    return parsed.href;
  } catch (_) { return null; }
}
function quoted(value) { return JSON.stringify(String(value)); }
function faceSource(face) {
  return (Array.isArray(face?.urls) ? face.urls : []).flatMap((source) => {
    const url = webUrl(source?.url);
    if (!url) return [];
    const format = ['woff', 'woff2', 'truetype', 'opentype'].includes(source.format) ? ` format(${quoted(source.format)})` : '';
    return [`url(${quoted(url)})${format}`];
  }).join(', ');
}

export function fontScopeCss(scope, family, selection = {}) {
  if (!/^QianmuFont_[a-zA-Z0-9_]+$/.test(family)) return '';
  const weight = selectedWeight(selection.weight), style = styleValue(selection.style);
  // Important declarations in this narrowly scoped layer outrank unlayered
  // host/font-provider rules. This avoids an unbounded specificity contest and
  // never rewrites another extension's stylesheet or its enabled state.
  const layer = css => `@layer qianmu-font-application {\n${css}\n}`;
  const font = `font-family:${quoted(family)},var(--mainFontFamily,system-ui,sans-serif) !important;`;
  if (scope === 'body') return layer(`${PROSE_ROOT},\n${PROSE_RUN},\n${PROSE_MIXED_PARAGRAPH} { ${font} font-weight:${weight} !important; font-style:${style} !important; }\n${PROSE_TEXT_TARGET} { ${font} }`);
  if (scope !== 'st') return '';
  return layer(`${ST_TARGET} { ${font} }\n${ST_TARGET}:not(:is(b, b *, strong, strong *, h1, h2, h3, h4, h5, h6)) { font-weight:${weight} !important; }\n${ST_TARGET}:not(:is(em, em *, i, i *)) { font-style:${style} !important; }`);
}

export function createFontRuntime({ document = globalThis.document, readLocal = async () => null, onStatus = () => {}, accountKey = '', beforeApply = () => {}, afterApply = () => {}, FontFace: FontFaceClass = globalThis.FontFace, URL: UrlApi = globalThis.URL, loadTimeout = 12000 } = {}) {
  const slots = new Map(), applied = new Map();
  let generation = 0, disposed = false, styleElement = null;
  const notify = (id, status, message = '') => { try { onStatus(id, { status, message }); } catch (_) {} };
  function paint() {
    const css = ['body', 'st'].map((scope) => {
      const entry = applied.get(scope);
      return entry ? fontScopeCss(scope, entry.family, entry.selection) : '';
    }).filter(Boolean).join('\n');
    if ((styleElement?.textContent || '') === css) return;
    let anchor;
    try { anchor = beforeApply(); } catch (_) {}
    if (!css) {
      styleElement?.remove(); styleElement = null;
      try { afterApply(anchor); } catch (_) {}
      return;
    }
    if (!styleElement) {
      styleElement = document.createElement('style');
      styleElement.dataset.qianmuFontRuntime = '1';
      (document.head || document.documentElement).appendChild(styleElement);
    }
    styleElement.textContent = css;
    try { afterApply(anchor); } catch (_) {}
  }
  function removeSlot(slot) {
    for (const face of slot.faces) document.fonts?.delete(face);
    if (slot.objectUrl) UrlApi.revokeObjectURL(slot.objectUrl);
  }
  function ensure(font) {
    let slot = slots.get(font.id);
    if (slot) return slot.ready;
    slot = { id: font.id, family: fontPreviewFamily(font.id), faces: [], specs: font.faces, objectUrl: '', ready: null };
    slots.set(font.id, slot);
    slot.ready = (async () => {
      if (!FontFaceClass || !document.fonts?.add) throw new Error('此浏览器不支持字体加载');
      let localSource = '';
      if (font.source?.kind === 'local') {
        if (!accountKey) throw new Error('尚未确认当前账户，无法读取本地字体');
        const blob = await readLocal(font.id);
        if (disposed || slots.get(font.id) !== slot) return null;
        if (!blob?.size) throw new Error('此设备没有该字体，请重新上传或导入');
        slot.objectUrl = UrlApi.createObjectURL(blob);
        localSource = `url(${quoted(slot.objectUrl)})`;
      }
      for (const face of Array.isArray(font.faces) ? font.faces : []) {
        const source = localSource || faceSource(face);
        if (!source) continue;
        const descriptors = { weight: weightValue(face.weight), style: descriptorStyle(face.style), display: 'swap' };
        if (face.unicodeRange) {
          if (typeof face.unicodeRange !== 'string' || !/^\s*U\+[0-9a-f?]+(?:-[0-9a-f]+)?(?:\s*,\s*U\+[0-9a-f?]+(?:-[0-9a-f]+)?)*\s*$/i.test(face.unicodeRange)) throw new Error('字体字符分段无效');
          descriptors.unicodeRange = face.unicodeRange;
        }
        const stretch = descriptorStretch(face.stretch);
        if (stretch) descriptors.stretch = stretch;
        const registered = new FontFaceClass(slot.family, source, descriptors);
        document.fonts.add(registered); slot.faces.push(registered);
      }
      if (!slot.faces.length) throw new Error('没有可用的字体文件');
      notify(font.id, 'available');
      return slot;
    })().catch((error) => {
      if (!disposed) notify(font.id, 'error', error?.message || '字体加载失败');
      removeSlot(slot); if (slots.get(font.id) === slot) slots.delete(font.id);
      return null;
    });
    return slot.ready;
  }
  async function load(slot, selection, sample, allowProbe = false) {
    let timer, finished = false;
    const requestedGeneration = generation;
    try {
      const request = `${styleValue(selection.style)} ${selectedWeight(selection.weight)} 16px ${quoted(slot.family)}`;
      const attempt = async () => {
        let result = await document.fonts.load(request, String(sample || '千幕 Aa 0123').slice(0, 100));
        // Applying a valid subset is independent of the user's sample text.
        // One declared-range probe is enough; never load every font fragment.
        const probe = !result?.length && allowProbe && !disposed && !finished && generation === requestedGeneration ? declaredProbe(slot.specs, selection) : '';
        if (probe) result = await document.fonts.load(request, probe);
        if (!result?.length) throw new Error('当前样字未匹配字体，请检查字符范围或字重');
        return result;
      };
      await Promise.race([
        attempt(),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('字体加载超时，请检查 Web 地址或网络')), loadTimeout); }),
      ]);
    } finally { finished = true; clearTimeout(timer); }
  }
  return {
    family: fontPreviewFamily,
    async sync(state = {}, previewIds = []) {
      if (disposed) return;
      const turn = ++generation;
      const fonts = new Map((Array.isArray(state.fonts) ? state.fonts : []).filter((font) => typeof font?.id === 'string').map((font) => [font.id, font]));
      const choices = state.mode === 'shared' ? { body: state.shared, st: state.shared } : { body: state.body, st: state.st };
      const needed = new Set(previewIds.filter((id) => fonts.has(id)));
      for (const [scope, selection] of Object.entries(choices)) {
        if (applied.has(scope) && !fonts.has(applied.get(scope).id)) applied.delete(scope);
        if (selection?.enabled && fonts.has(selection.fontId)) needed.add(selection.fontId);
        else applied.delete(scope);
      }
      // Disabled/removed assignments take effect immediately, including while a
      // different face is in flight. A failed replacement leaves the old one.
      paint();
      const pending = new Map([...needed].map((id) => [id, ensure(fonts.get(id))]));
      const loading = new Map();
      function verify(slot, selection, active = false) {
        const key = `${slot.id}|${selectedWeight(selection.weight)}|${styleValue(selection.style)}|${active ? 'active' : 'preview'}`;
        if (!loading.has(key)) {
          notify(slot.id, 'loading');
          loading.set(key, load(slot, selection, state.previewText, active));
        }
        return loading.get(key);
      }
      await Promise.all(Object.entries(choices).map(async ([scope, selection]) => {
        if (!selection?.enabled || !pending.has(selection.fontId)) return;
        const slot = await pending.get(selection.fontId);
        if (!slot || disposed || generation !== turn) return;
        const prior = applied.get(scope);
        if (prior?.id === slot.id && prior.selection.weight === selection.weight && prior.selection.style === selection.style) return;
        try {
          await verify(slot, selection, true);
          if (disposed || generation !== turn) return;
          applied.set(scope, { id: slot.id, family: slot.family, selection: { ...selection } });
          notify(slot.id, 'ready');
        } catch (error) {
          if (!disposed && generation === turn) notify(slot.id, 'error', error?.message || '字体加载失败，已保留原字体');
        }
      }));
      if (!disposed && generation === turn) paint();
      await Promise.all(previewIds.filter((id) => pending.has(id)).map(async (id) => {
        const slot = await pending.get(id);
        if (!slot || disposed || generation !== turn) return;
        const firstFace = fonts.get(id)?.faces?.[0] || {};
        try {
          const selected = state.previewChoices?.[id];
          await verify(slot, selected || { weight: firstFace.weight, style: String(firstFace.style || '').startsWith('oblique') ? 'oblique' : firstFace.style });
          if (!disposed && generation === turn) notify(id, 'ready');
        } catch (error) {
          if (!disposed && generation === turn) notify(id, 'error', error?.message || '字体预览加载失败');
        }
      }));
      await Promise.all(pending.values());
      if (disposed || generation !== turn) return;
      paint();
      for (const entry of applied.values()) needed.add(entry.id);
      for (const [id, slot] of slots) if (!needed.has(id)) { removeSlot(slot); slots.delete(id); }
    },
    dispose() {
      disposed = true; generation++;
      applied.clear(); paint();
      for (const slot of slots.values()) removeSlot(slot);
      slots.clear();
    },
  };
}
