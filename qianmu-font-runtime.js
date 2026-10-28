// FontFace, not an external stylesheet, is the only path by which catalog CSS
// reaches the page. Registering preview faces never applies a font to ST.
const PROSE_ROOT = '#chat .mes .mes_text:not([data-sd-prose-mixed="1"]):not(:has(style, .np-min-card, [data-sd-prose-exempt], > :is(div, section, article, p):is([class], [style]):not(.sd-prose-run)))';
const PROSE_RUN = '#chat .mes .mes_text[data-sd-prose-mixed="1"] > .sd-prose-run[data-sd-prose-run="1"]';
// ST temporarily replaces a message's rendered body with this textarea while
// a floor is being edited. It lives inside `.mes_text`, which is deliberately
// excluded from the broad interface selector below, so it needs an explicit
// prose-font target of its own.
const PROSE_EDIT = '#chat .mes .mes_text textarea.edit_textarea';
// Without the optional layout feature, mixed messages have no prose-run
// wrappers. Only their ordinary direct paragraphs are safe to select; raw
// text beside authored cards deliberately retains native typography.
const PROSE_MIXED_PARAGRAPH = '#chat .mes .mes_text:not([data-sd-prose-mixed="1"]):has(style, .np-min-card, [data-sd-prose-exempt], > :is(div, section, article, p):is([class], [style])) > :is(p, div):not([class], [style]):not(:has(style, .np-min-card, [data-sd-prose-exempt], :is(div, section, article, p):is([class], [style])))';
const PROSE_TEXT_EXEMPT = 'pre, code, kbd, samp, svg, canvas, .fa, .fas, .far, .fab, .fal, .fad, [class*="fa-"], [class*="icon"], .np-min-card, [data-sd-prose-exempt], [id^="story-director-"], :is(div, section, article, p):is([class], [style]):not(.sd-prose-run)';
const PROSE_TEXT_TARGET = `:is(${PROSE_ROOT}, ${PROSE_RUN}, ${PROSE_MIXED_PARAGRAPH}) :is(p, div, span, a, b, strong, em, i, u, s, q, blockquote, ul, ol, li, h1, h2, h3, h4, h5, h6, sub, sup, small):not(:is(${PROSE_TEXT_EXEMPT})):not(.mes_text :is(${PROSE_TEXT_EXEMPT}) *)`;
// Body carries state classes such as sd-prose-layout; those are not a Qianmu
// window and must not accidentally exempt the whole host interface.
const OWN_SURFACE = '[id^="story-director-"], :is([class^="sd-"], [class*=" sd-"], [class^="qm-"], [class*=" qm-"]):not(html):not(body)';
// Native ST message chrome/recent-chat text belongs to reading typography.
// Select the native leaves, not .mes or rich-card containers, so authored
// regex cards and icon/control typography never inherit this assignment.
const MESSAGE_META = '#chat > .mes > .mesAvatarWrapper > :is(.mesIDDisplay, .mes_timer, .tokenCounterDisplay), #chat > .mes > .mes_block > .ch_name :is(.name_text, .timestamp), #chat > .mes > .swipeRightBlock > .swipes-counter';
const RECENT_TEXT = '.welcomePanel .recentChatList > .recentChat > .recentChatInfo :is(.chatName, .chatName > strong, .chatName > span, .chatDate, .chatMessage, .chatStats small)';
const READING_META = `${MESSAGE_META}, ${RECENT_TEXT}`;
const READING_META_CONTAINERS = '#chat > .mes > .mesAvatarWrapper, #chat > .mes > .mes_block > .ch_name, #chat > .mes > .swipeRightBlock, .welcomePanel .recentChatList > .recentChat > .recentChatInfo';
const EXEMPT = 'textarea#send_textarea, .mes_text, .mes_text *, pre, pre *, code, code *, kbd, kbd *, samp, samp *, svg, svg *, canvas, i, .fa, .fas, .far, .fab, .fal, .fad, [class*="fa-"], [class*="fa-"] *, [class*="icon"], [class*="icon"] *, [data-sd-prose-exempt], [data-sd-prose-exempt] *, [style*="font-family" i], [style*="font-family" i] *';
// Do not style body or message/Qianmu ancestors: an excluded descendant must
// not inherit a changed font from an otherwise eligible host container.
const ST_TARGET = `html body :is(div, span, p, a, label, button, input, textarea, select, option, summary, legend, h1, h2, h3, h4, h5, h6, li, td, th, small):not(:is(${EXEMPT})):not(:is(${READING_META_CONTAINERS})):not(:is(${READING_META_CONTAINERS}) *):not(:is(${OWN_SURFACE})):not(:is(${OWN_SURFACE}) *):not(:has(textarea#send_textarea, .mes_text, ${OWN_SURFACE}, .ch_name .name_text, .ch_name .timestamp, .recentChatInfo))`;

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
function faceDescriptors(face) {
  const descriptors = { weight: weightValue(face.weight), style: descriptorStyle(face.style), display: 'swap' };
  if (face.unicodeRange) {
    if (typeof face.unicodeRange !== 'string' || !/^\s*U\+[0-9a-f?]+(?:-[0-9a-f]+)?(?:\s*,\s*U\+[0-9a-f?]+(?:-[0-9a-f]+)?)*\s*$/i.test(face.unicodeRange)) throw new Error('字体字符分段无效');
    descriptors.unicodeRange = face.unicodeRange;
  }
  const stretch = descriptorStretch(face.stretch);
  if (stretch) descriptors.stretch = stretch;
  return descriptors;
}

export function fontScopeCss(scope, family, selection = {}) {
  if (!/^QianmuFont_[a-zA-Z0-9_]+$/.test(family)) return '';
  const weight = selectedWeight(selection.weight), style = styleValue(selection.style);
  // Important declarations in this narrowly scoped layer outrank unlayered
  // host/font-provider rules. This avoids an unbounded specificity contest and
  // never rewrites another extension's stylesheet or its enabled state.
  const layer = css => `@layer qianmu-font-application {\n${css}\n}`;
  const font = `font-family:${quoted(family)},var(--mainFontFamily,system-ui,sans-serif) !important;`;
  if (scope === 'body') return layer(`textarea#send_textarea,\n${PROSE_EDIT},\n${PROSE_ROOT},\n${PROSE_RUN},\n${PROSE_MIXED_PARAGRAPH},\n${READING_META} { ${font} font-weight:${weight} !important; font-style:${style} !important; }\n${PROSE_EDIT} { font-size:var(--sd-prose-font-size, inherit) !important; }\n${PROSE_TEXT_TARGET} { ${font} }`);
  if (scope !== 'st') return '';
  // Classic Qianmu panels may follow the applied interface family without
  // widening ST_TARGET or changing the host's native --mainFontFamily. Paper
  // and minimal themes keep their own fonts; removing this sheet restores the
  // original cascade, including while an unverified replacement is loading.
  return layer(`:root { --qm-interface-font:${quoted(family)},var(--mainFontFamily,system-ui,sans-serif); }\n${ST_TARGET} { ${font} }\n${ST_TARGET}:not(:is(b, b *, strong, strong *, h1, h2, h3, h4, h5, h6)) { font-weight:${weight} !important; }\n${ST_TARGET}:not(:is(em, em *, i, i *)) { font-style:${style} !important; }`);
}

export function createFontRuntime({ document = globalThis.document, readLocal = async () => null, readBuiltin = async () => null, onStatus = () => {}, accountKey = '', beforeApply = () => {}, afterApply = () => {}, FontFace: FontFaceClass = globalThis.FontFace, Blob: BlobClass = globalThis.Blob, URL: UrlApi = globalThis.URL, loadTimeout = 12000 } = {}) {
  const slots = new Map(), applied = new Map(), retired = new Set(), probes = new Set();
  let generation = 0, revision = 0, disposed = false, styleElement = null;
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
    if (slot.released) return;
    slot.released = true;
    for (const face of slot.faces) document.fonts?.delete(face);
    if (slot.objectUrl) UrlApi.revokeObjectURL(slot.objectUrl);
  }
  function ensure(font) {
    const signature = JSON.stringify([font.source?.kind, font.source?.key, font.faces]);
    let slot = slots.get(font.id);
    if (slot?.signature === signature) return slot.ready;
    // An edited source gets a fresh family. Keep only any still-applied old
    // face until its replacement verifies; a failed edit must not erase it.
    if (slot) retired.add(slot);
    slot = { id: font.id, signature, family: `${fontPreviewFamily(font.id)}_r${++revision}`, faces: [], specs: font.faces, objectUrl: '', ready: null };
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
      } else if (font.source?.kind === 'builtin') {
        const builtin = await readBuiltin(font.source.key);
        if (disposed || slots.get(font.id) !== slot) return null;
        if (!builtin) throw new Error('内置字体未随当前版本提供');
        if (typeof builtin === 'string') localSource = `url(${quoted(builtin)})`;
        else {
          const bytes = BlobClass && builtin instanceof BlobClass ? builtin : BlobClass ? new BlobClass([builtin], { type: 'font/woff2' }) : null;
          if (!bytes?.size) throw new Error('内置字体原件为空');
          slot.objectUrl = UrlApi.createObjectURL(bytes);
          localSource = `url(${quoted(slot.objectUrl)})`;
        }
      }
      for (const face of Array.isArray(font.faces) ? font.faces : []) {
        const source = localSource || faceSource(face);
        if (!source) continue;
        const registered = new FontFaceClass(slot.family, source, faceDescriptors(face));
        document.fonts.add(registered); slot.faces.push(registered);
      }
      if (!slot.faces.length) throw new Error('没有可用的字体文件');
      notify(font.id, 'available');
      return slot;
    })().catch((error) => {
      if (!disposed && slots.get(font.id) === slot) notify(font.id, 'error', error?.message || '字体加载失败');
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
    family: id => slots.get(id)?.family || fontPreviewFamily(id),
    isApplied(scope, font, selection = {}) {
      if (disposed || !font || !selection.enabled || selection.fontId !== font.id) return false;
      const entry = applied.get(scope), slot = slots.get(font.id);
      return !!entry && entry.slot === slot && entry.id === font.id && slot.signature === JSON.stringify([font.source?.kind, font.source?.key, font.faces])
      && selectedWeight(entry.selection.weight) === selectedWeight(selection.weight) && styleValue(entry.selection.style) === styleValue(selection.style);
    },
    async verifyWebFont(font, selection, sample) {
      if (disposed || font.source?.kind !== 'web' || !FontFaceClass || !document.fonts?.add) throw new Error('字体暂不可验证，已保留原条目');
      const probe = { family: `${fontPreviewFamily(font.id)}_probe${++revision}`, faces: [], specs: font.faces };
      probes.add(probe);
      try {
        for (const face of font.faces || []) {
          const source = faceSource(face);
          if (!source) throw new Error('字体链接无效');
          const registered = new FontFaceClass(probe.family, source, faceDescriptors(face));
          document.fonts.add(registered); probe.faces.push(registered);
        }
        if (!probe.faces.length) throw new Error('没有可用的字体文件');
        const selected = selection || font.faces[0];
        await load(probe, { ...selected, style: String(selected?.style || 'normal').split(' ')[0] }, sample, true);
        if (disposed) throw new Error('字体库已关闭，未覆盖原条目');
      } finally { removeSlot(probe); probes.delete(probe); }
    },
    async sync(state = {}, previewIds = [], { onApplied } = {}) {
      if (disposed) return;
      const turn = ++generation;
      const fonts = new Map((Array.isArray(state.fonts) ? state.fonts : []).filter((font) => typeof font?.id === 'string').map((font) => [font.id, font]));
      const choices = state.enabled === false ? { body: null, st: null }
        : state.mode === 'shared' ? { body: state.shared, st: state.shared } : { body: state.body, st: state.st };
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
        if (prior?.slot === slot && prior.selection.weight === selection.weight && prior.selection.style === selection.style) return;
        try {
          await verify(slot, selection, true);
          if (disposed || generation !== turn) return;
          applied.set(scope, { id: slot.id, family: slot.family, slot, selection: { ...selection } });
          notify(slot.id, 'ready');
        } catch (error) {
          if (!disposed && generation === turn) notify(slot.id, 'error', error?.message || '字体加载失败，已保留原字体');
        }
      }));
      if (!disposed && generation === turn) { paint(); try { onApplied?.(); } catch (_) {} }
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
      const retained = new Set([...applied.values()].map(entry => entry.slot));
      for (const slot of retired) if (!retained.has(slot)) { removeSlot(slot); retired.delete(slot); }
    },
    dispose() {
      disposed = true; generation++;
      applied.clear(); paint();
      for (const slot of slots.values()) removeSlot(slot);
      for (const slot of retired) removeSlot(slot);
      retired.clear();
      for (const probe of probes) removeSlot(probe);
      probes.clear();
      slots.clear();
    },
  };
}
