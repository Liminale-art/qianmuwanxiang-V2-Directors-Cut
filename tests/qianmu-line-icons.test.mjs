import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';

import {
  ICONSAX_GLYPH_NAMES,
  ICONSAX_ICON_MARKUP,
  ICONSAX_STROKE_WIDTH,
  QIANMU_CURRENT_FA_ICON_COUNT,
  QIANMU_FA_ICON_MAP,
  QIANMU_ICON_SYSTEM_NAME,
  QIANMU_ICON_SYSTEM_VERSION,
  QIANMU_INLINE_GLYPH_COUNT,
  QIANMU_SEMANTIC_ICONS,
  applyQianmuIcons,
  qianmuIconElement,
  qianmuIconMarkup,
  refreshQianmuIcon,
  resolveQianmuIcon,
} from '../qianmu-icon-renderer.js';

const rootUrl = new URL('../', import.meta.url);
const rendererSource = await readFile(new URL('qianmu-icon-renderer.js', rootUrl), 'utf8');
const indexSource = await readFile(new URL('index.js', rootUrl), 'utf8');
const styleSource = await readFile(new URL('style.css', rootUrl), 'utf8');
const themeSource = await readFile(new URL('qianmu-theme-skins.css', rootUrl), 'utf8');
const vibeViewSource = await readFile(new URL('qianmu-vibe-library-view.js', rootUrl), 'utf8');
const manifest = JSON.parse(await readFile(new URL('manifest.json', rootUrl), 'utf8'));
const packageJson = JSON.parse(await readFile(new URL('package.json', rootUrl), 'utf8'));
const thirdPartyNotices = await readFile(new URL('THIRD_PARTY_NOTICES.md', rootUrl), 'utf8');

const faUtilityClasses = new Set(['fa-brands', 'fa-regular', 'fa-solid', 'fa-spin', 'fa-xs']);
const currentFaNames = [...new Set(
  [...(indexSource+'\n'+vibeViewSource).matchAll(/\bfa-[a-z0-9-]+\b/g)]
    .map((match) => match[0])
    .filter((name) => !faUtilityClasses.has(name)),
)].sort();

assert.equal(QIANMU_ICON_SYSTEM_NAME, 'Iconsax · 千幕 2.5');
assert.match(QIANMU_ICON_SYSTEM_VERSION, /^iconsax-[a-z0-9.-]+$/);
assert.equal(ICONSAX_STROKE_WIDTH, 2.5);
assert.equal(QIANMU_INLINE_GLYPH_COUNT, Object.keys(ICONSAX_ICON_MARKUP).length);
assert.ok(QIANMU_INLINE_GLYPH_COUNT >= 120, 'Iconsax 本地子集应覆盖语义入口与高频工具');
assert.equal(QIANMU_INLINE_GLYPH_COUNT, 127, 'audited subset contains 117 Iconsax and ten familiar-action glyphs');
assert.equal(QIANMU_CURRENT_FA_ICON_COUNT, Object.keys(QIANMU_FA_ICON_MAP).length);
for(const name of currentFaNames)assert.ok(QIANMU_FA_ICON_MAP[name], `实际使用的 FA 类名 ${name} 必须有确定语义；保留旧映射不要求旧控件仍存在`);

const glyphBody = (markup) => String(markup).match(/<svg[^>]*>([\s\S]*?)<\/svg>/)?.[1] || '';
const semanticName = symbol => symbol.replace(/^qm-(?:duotone|regular|fill|user|signature)-/, '');
const variantNames = ['outline', 'bold', 'twotone'];
const groups = body => [...body.matchAll(/<g data-qm-icon-variant="(outline|bold|twotone)"([^>]*)>([\s\S]*?)<\/g>(?=<g data-qm-icon-variant=|$)/g)]
  .map(([full, variant, attrs, geometry]) => [full, variant, /\sdata-qm-icon-fixed(?:\s|$)/.test(attrs) ? ' data-qm-icon-fixed' : undefined, geometry]);
const fallbackGlyph = glyphBody(qianmuIconMarkup('qm-unknown-glyph'));
assert.deepEqual(groups(fallbackGlyph).map(match => match[1]), variantNames);
for (const [, variant, fixed, body] of groups(fallbackGlyph)) {
  assert.equal(fixed, undefined);
  assert.equal(body, ICONSAX_ICON_MARKUP['magic-star'][variant]);
}
for (const name of currentFaNames) {
  const symbol = resolveQianmuIcon(name);
  assert.ok(symbol, `${name} 缺少解析结果`);
  const markup = qianmuIconMarkup(name);
  assert.match(markup, /<svg class="qm-glyph-svg"/);
  assert.doesNotMatch(markup, /<use\b|https?:|\.svg#/i, `${name} 不得发起图标资源请求`);
  // A deliberate magic-star semantic may equal the fallback geometry. Check the
  // registered mapping itself, not incidental inequality with that valid icon.
  const officialName = ICONSAX_GLYPH_NAMES[semanticName(symbol)];
  assert.ok(officialName && Object.hasOwn(ICONSAX_ICON_MARKUP, officialName), `${name} 必须有明确映射，不得隐式退回占位图形`);
  const state = /^qm-(regular|fill)-(?:star|bookmark|push-pin)$/.exec(symbol);
  const fixed = state ? (state[1] === 'fill' ? 'bold' : 'outline') : semanticName(symbol) === 'spinner-gap' ? 'outline' : '';
  const variants = groups(glyphBody(markup));
  assert.deepEqual(variants.map(match => match[1]), fixed ? [fixed] : variantNames, `${name}: complete theme/state geometry`);
  for (const [, variant, isFixed, body] of variants) {
    assert.equal(body, ICONSAX_ICON_MARKUP[officialName][variant], name);
    assert.equal(Boolean(isFixed), Boolean(fixed), name);
  }
}

const semanticSymbols = Object.values(QIANMU_SEMANTIC_ICONS);
assert.equal(Object.keys(QIANMU_SEMANTIC_ICONS).length, 16);
assert.equal(new Set(semanticSymbols).size, 16, '顶层语义图标不得复用同一签名');
for (const [semantic, symbol] of Object.entries(QIANMU_SEMANTIC_ICONS)) {
  assert.equal(resolveQianmuIcon(semantic), symbol);
  assert.match(symbol, /^qm-signature-/);
  assert.match(qianmuIconMarkup(semantic), /<path|<circle|<rect/);
  const official = ICONSAX_GLYPH_NAMES[semanticName(symbol)];
  assert.ok(official && ICONSAX_ICON_MARKUP[official], `${semantic}: creative entrances still require an explicit local mapping`);
  assert.deepEqual(groups(glyphBody(qianmuIconMarkup(semantic))).map(match => match[1]), variantNames);
}
for (const [semantic, official] of Object.entries(ICONSAX_GLYPH_NAMES)) assert.ok(ICONSAX_ICON_MARKUP[official], `${semantic}: ${official} must be bundled`);

assert.doesNotMatch(rendererSource, /new URL\(|fetch\(|XMLHttpRequest|<use\b|xlink:href/i, '图标渲染器不得依赖任何二次资源请求');
assert.match(rendererSource, /ICONSAX_STROKE_WIDTH = 2\.5/);
assert.doesNotMatch(rendererSource, /stroke-width=['"](?:1\.65|2)['"]/, '千幕图标不得退回旧描边粗细');
assert.doesNotMatch(rendererSource, /\b(?:localStorage|sessionStorage|indexedDB|caches)\b/, '内联图标不建立另一套运行时存储或缓存');
assert.doesNotMatch(rendererSource, /\bMutationObserver\b/);
assert.doesNotMatch(
  rendererSource,
  /(?:globalThis\.)?document\s*\.\s*(?:querySelector(?:All)?|getElementsBy(?:ClassName|TagName)|body\b)/,
  '图标渲染器不得扫描整页',
);
assert.match(styleSource, /\.qm-glyph-icon > svg\.qm-glyph-svg/);
assert.doesNotMatch(styleSource, /qm-phosphor-spin/);
await assert.rejects(access(new URL('assets/qianmu-phosphor-v1454.svg', rootUrl)));
await assert.rejects(access(new URL('assets/PHOSPHOR-LICENSE.txt', rootUrl)));
assert.match(thirdPartyNotices, /Iconsax/);
assert.match(thirdPartyNotices, /(?:MIT|Iconsax)[\s\S]*(?:License|license|许可)/);
assert.match(thirdPartyNotices, /Lucide Static `1\.39\.0`/);
assert.match(thirdPartyNotices, /ISC License[\s\S]*Lucide Icons and Contributors/);

// Audit the actual bundled bodies, not merely the generator input. Repeated
// copies of a glyph must remain safe and collision-free in one document.
const allowedTags = new Set(['path', 'circle', 'rect', 'ellipse', 'polygon', 'polyline', 'line', 'g']);
const allowedAttributes = new Set(['d', 'cx', 'cy', 'r', 'x', 'y', 'x1', 'x2', 'y1', 'y2', 'width', 'height', 'rx', 'ry', 'points', 'fill', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin', 'stroke-miterlimit', 'stroke-dasharray', 'stroke-dashoffset', 'fill-rule', 'clip-rule', 'opacity', 'fill-opacity', 'stroke-opacity', 'transform']);
const familiarActions = new Set(['qianmu-anchor', 'qianmu-minimize', 'qianmu-check', 'qianmu-checks', 'qianmu-pin', 'qianmu-close', 'qianmu-star', 'qianmu-star-half', 'qianmu-play', 'qianmu-stop']);
assert.deepEqual(Object.keys(ICONSAX_ICON_MARKUP).filter(name => name.startsWith('qianmu-')).sort(), [...familiarActions].sort(), 'only the explicitly retained familiar actions use legacy geometry');
for (const [semantic, official] of Object.entries({star: 'qianmu-star', 'star-half': 'qianmu-star-half', bookmark: 'archive', 'image-regenerate': 'refresh-arrow-02'})) {
  assert.equal(ICONSAX_GLYPH_NAMES[semantic], official, `${semantic}: recognized action silhouette must not be replaced by a misleading source-name match`);
}
function assertSafeGlyph(body, label) {
  assert.equal(typeof body, 'string', label);
  assert.match(body, /<(?:path|circle|rect|ellipse|polygon|polyline|line)\b/, `${label}: nonempty geometry`);
  assert.doesNotMatch(body, /(?:https?:|data:|javascript:|url\s*\(|&|[<>]\s*!)/i, `${label}: inline geometry only`);
  const stack = [];
  let consumed = '';
  for (const match of body.matchAll(/<(\/?)([a-z][a-z0-9-]*)([^<>]*?)(\/?)>/gi)) {
    const [tag, closing, name, attributes, selfClosing] = match;
    consumed += tag;
    assert.ok(allowedTags.has(name), `${label}: disallowed tag ${name}`);
    if (closing) {
      assert.equal(attributes.trim(), '', label);
      assert.equal(selfClosing, '', label);
      assert.equal(stack.pop(), name, `${label}: balanced SVG`);
      continue;
    }
    let rest = attributes;
    const seen = new Set();
    rest = rest.replace(/\s+([a-z][a-z0-9-]*)="([^"<>]*)"/gi, (_attr, key, value) => {
      assert.ok(allowedAttributes.has(key), `${label}: disallowed attribute ${key}`);
      assert.equal(seen.has(key), false, `${label}: duplicate attribute ${key}`); seen.add(key);
      if (key === 'stroke-width') assert.equal(value, '2.5', `${label}: requested stroke width`);
      if (key === 'fill' || key === 'stroke') assert.ok(['none', 'currentColor'].includes(value), `${label}: inherited theme ink`);
      return '';
    });
    assert.equal(rest.trim(), '', `${label}: well-formed attributes`);
    if (!selfClosing) stack.push(name);
  }
  assert.equal(stack.length, 0, `${label}: closed SVG`);
  assert.equal(consumed.replace(/\s/g, ''), body.replace(/\s/g, ''), `${label}: no text or malformed markup`);
}
for (const [name, variants] of Object.entries(ICONSAX_ICON_MARKUP)) {
  assert.deepEqual(Object.keys(variants).sort(), [...variantNames].sort(), `${name}: all three bundled families`);
  for (const [variant, body] of Object.entries(variants)) {
    assertSafeGlyph(body, `${name}/${variant}`);
    assert.doesNotMatch(body, /\bid\s*=/i, `${name}/${variant}: no duplicated IDs when rendered repeatedly`);
    if (variant === 'bold' && !familiarActions.has(name)) {
      assert.doesNotMatch(body, /stroke="currentColor"/, `${name}: Iconsax Bold remains filled geometry, not an inflated outline`);
      assert.match(body, /fill="currentColor"/, `${name}: filled artwork must not inherit the outer SVG fill=none`);
    }
    if (familiarActions.has(name)) assert.match(body, /stroke="currentColor" stroke-width="2\.5"/, `${name}: retained action adopts the requested stroke width`);
  }
}
for (const unsafe of [
  '<script>alert(1)</script>', '<image href="https://example.invalid/icon.svg"/>',
  '<path d="M0 0" onload="alert(1)"/>', '<path id="duplicate" d="M0 0"/>',
  '<path d="M0 0" fill="url(#paint)"/>', '<path d="M0 0" style="stroke:red"/>',
  '<foreignObject><path d="M0 0"/></foreignObject>', '<path d="M0 0" stroke-width="1.5"/>',
]) assert.throws(() => assertSafeGlyph(unsafe, 'unsafe fixture'), assert.AssertionError);

for (const payload of ['qm-x" onload="alert(1)', 'qm-x><script>alert(1)</script>', 'qm-x\nstyle=bad', 'qm-x&evil;']) {
  assert.equal(resolveQianmuIcon(payload), '', 'malformed explicit symbols are rejected');
  assert.equal(qianmuIconMarkup(payload), '', 'explicit symbols cannot become SVG/HTML attributes');
}
const escapedClass = qianmuIconMarkup('fa-camera', {className: 'extra" onclick="bad<svg>&'});
assert.equal((escapedClass.match(/<svg\b/g) || []).length, 1);
assert.doesNotMatch(escapedClass, /" onclick="|bad<svg>/);
assert.match(escapedClass, /extra&quot; onclick=&quot;bad&lt;svg&gt;&amp;/);

for (const [variant, defaultDisplay] of [['outline', 'inline'], ['bold', 'none'], ['twotone', 'none']]) {
  assert.ok(styleSource.includes(`svg.qm-glyph-svg > g[data-qm-icon-variant="${variant}"] { display: var(--qm-icon-${variant}-display, ${defaultDisplay}); }`), `${variant}: classic defaults work for wrapped and bare SVG controls`);
}
assert.match(styleSource, /svg\.qm-glyph-svg > g\[data-qm-icon-fixed\] \{ display: inline; \}/);
for (const [theme, active] of [['editorial', 'bold'], ['glass', 'twotone']]) {
  const rule = themeSource.match(new RegExp(`:is\\(#story-director-modal, \\[data-qm-theme\\]\\)\\[data-qm-theme="${theme}"\\] \\{([^}]*)\\}`))?.[1] || '';
  for (const variant of variantNames) assert.ok(rule.includes(`--qm-icon-${variant}-display: ${variant === active ? 'inline' : 'none'};`), `${theme}: exactly one icon family`);
}

assert.match(manifest.version, /^\d+\.\d+\.\d+$/, '发行版本必须是有效的三段版本号');
assert.equal(packageJson.version, manifest.version);
assert.equal(manifest.js, `index.js?v=${manifest.version}`);
assert.equal(manifest.css, `style.css?v=${manifest.version}`);
assert.match(indexSource, /from '\.\/qianmu-icon-renderer\.js\?v=\d+\.\d+\.\d+';/);

class FakeClassList {
  constructor(host, initial = '') { this.host = host; this.set(initial); }
  set(value) { this.names = new Set(String(value || '').split(/\s+/).filter(Boolean)); }
  add(...names) {
    let changed = false;
    for (const name of names) if (name && !this.names.has(name)) { this.names.add(name); changed = true; }
    if (changed && this.host.stats) this.host.stats.writes += 1;
  }
  remove(...names) {
    let changed = false;
    for (const name of names) changed = this.names.delete(name) || changed;
    if (changed && this.host.stats) this.host.stats.writes += 1;
  }
  contains(name) { return this.names.has(name); }
  toString() { return [...this.names].join(' '); }
}

function selectorParts(selector) { return String(selector || '').split(',').map((part) => part.trim()).filter(Boolean); }

class FakeElement {
  constructor(tagName = 'div', options = {}) {
    this.nodeType = 1;
    this.tagName = String(tagName).toUpperCase();
    this.id = options.id || '';
    this.attributes = new Map(Object.entries(options.attributes || {}));
    this.children = [];
    this.parentElement = null;
    this.ownerDocument = options.ownerDocument || null;
    this.stats = options.stats || this.ownerDocument?.stats || null;
    this.classList = new FakeClassList(this, options.className || '');
    this._innerHTML = '';
  }
  get className() { return this.classList.toString(); }
  set className(value) { this.classList.set(value); }
  get innerHTML() { return this._innerHTML; }
  set innerHTML(value) {
    const next = String(value || '');
    if (this._innerHTML === next) return;
    this._innerHTML = next;
    if (this.stats) this.stats.writes += 1;
  }
  appendChild(child) {
    child.parentElement = this;
    child.ownerDocument ||= this.ownerDocument;
    child.stats ||= this.stats;
    this.children.push(child);
    if (this.stats) this.stats.writes += 1;
    return child;
  }
  setAttribute(name, value) {
    const key = String(name), next = String(value);
    if (this.attributes.get(key) === next) return;
    this.attributes.set(key, next);
    if (this.stats) this.stats.writes += 1;
  }
  getAttribute(name) { return this.attributes.has(String(name)) ? this.attributes.get(String(name)) : null; }
  removeAttribute(name) {
    if (this.attributes.delete(String(name)) && this.stats) this.stats.writes += 1;
  }
  matches(selector) { return selectorParts(selector).some((part) => this.matchesOne(part)); }
  matchesOne(selector) {
    if (selector === 'svg.qm-glyph-svg') return this.tagName === 'SVG' && this.classList.contains('qm-glyph-svg');
    if (selector === 'svg.qm-phosphor-svg') return this.tagName === 'SVG' && this.classList.contains('qm-phosphor-svg');
    if (selector === 'i[class*="fa-"]') return this.tagName === 'I' && [...this.classList.names].some((name) => name.startsWith('fa-'));
    if (/^#[a-z0-9_-]+$/i.test(selector)) return this.id === selector.slice(1);
    if (/^\.[a-z0-9_-]+$/i.test(selector)) return this.classList.contains(selector.slice(1));
    const attribute = selector.match(/^\[([a-z0-9_-]+)\]$/i);
    return attribute ? this.attributes.has(attribute[1]) : false;
  }
  closest(selector) {
    for (let node = this; node; node = node.parentElement) if (node.matches(selector)) return node;
    return null;
  }
  querySelectorAll(selector) {
    if (this.stats) this.stats.queries += 1;
    const matches = [];
    const visit = (node) => {
      for (const child of node.children) { if (child.matches(selector)) matches.push(child); visit(child); }
    };
    visit(this);
    return matches;
  }
}

class FakeDocument {
  constructor(stats = { queries: 0, writes: 0 }) {
    this.nodeType = 9;
    this.stats = stats;
    this.body = new FakeElement('body', { ownerDocument: this, stats });
  }
  createElementNS(_namespace, tagName) { return new FakeElement(tagName, { ownerDocument: this, stats: this.stats }); }
}

function makeOwnedRoot(id = 'story-director-modal') {
  const stats = { queries: 0, writes: 0 };
  const document = new FakeDocument(stats);
  const root = new FakeElement('section', { id, ownerDocument: document, stats });
  return { document, root, stats };
}

assert.equal(applyQianmuIcons(), 0);
const local = makeOwnedRoot();
// The motion viewer mounts directly under body, not inside the main modal.
// Its existing caller must not silently depend on an external icon font.
const motion = makeOwnedRoot('isolated-motion-owner');
motion.root.classList.add('sd-storyboard-video-viewer');
const motionIcons = ['fa-xmark', 'fa-download', 'fa-trash-can'].map(name => motion.root.appendChild(
  new FakeElement('i', { className: `fa-solid ${name}`, ownerDocument: motion.document, stats: motion.stats }),
));
assert.equal(applyQianmuIcons(motion.root), 3, '独立动态查看器应识别为千幕本地图标作用域');
assert.ok(motionIcons.every(icon => icon.children.length === 1 && icon.children[0].classList.contains('qm-glyph-svg')));
const motionGlyphs = motionIcons.map(icon => icon.children[0]);
const motionWrites = motion.stats.writes;
assert.equal(applyQianmuIcons(motion.root), 3);
assert.deepEqual(motionIcons.map(icon => icon.children[0]), motionGlyphs);
assert.equal(motion.stats.writes, motionWrites);
const draftOwner = makeOwnedRoot('isolated-draft-owner');
draftOwner.root.classList.add('sd-storyboard-video-draft-layer');
const draftIcons = ['fa-xmark', 'fa-arrow-left', 'fa-plus', 'fa-images', 'fa-shield-halved', 'fa-floppy-disk'].map(name => draftOwner.root.appendChild(
  new FakeElement('i', { className: `fa-solid ${name}`, ownerDocument: draftOwner.document, stats: draftOwner.stats }),
));
assert.equal(applyQianmuIcons(draftOwner.root), 6, '独立动态草稿及嵌套核对页应有本地图标');
const draftGlyphs = draftIcons.map(icon => icon.children[0]), draftWrites = draftOwner.stats.writes;
assert.ok(draftGlyphs.every(icon => icon?.classList.contains('qm-glyph-svg')));
assert.equal(applyQianmuIcons(draftOwner.root), 6);
assert.deepEqual(draftIcons.map(icon => icon.children[0]), draftGlyphs);
assert.equal(draftOwner.stats.writes, draftWrites);
const filmOwner = makeOwnedRoot('isolated-film-owner');
filmOwner.root.classList.add('sd-storyboard-film-viewer');
const filmIcons = ['fa-xmark', 'fa-backward-step', 'fa-play', 'fa-forward-step', 'fa-video', 'fa-image'].map(name => filmOwner.root.appendChild(
  new FakeElement('i', { className: `fa-solid ${name}`, ownerDocument: filmOwner.document, stats: filmOwner.stats }),
));
assert.equal(applyQianmuIcons(filmOwner.root), 6, '影片预览独立根应拥有本地控制及分段图标');
assert.ok(filmIcons.every(icon => icon.children[0]?.classList.contains('qm-glyph-svg')));
const filmWrites = filmOwner.stats.writes;
assert.equal(applyQianmuIcons(filmOwner.root), 6);
assert.equal(filmOwner.stats.writes, filmWrites);
const camera = local.root.appendChild(new FakeElement('i', { className: 'fa-solid fa-camera', ownerDocument: local.document, stats: local.stats }));
assert.equal(applyQianmuIcons(local.root), 1);
assert.equal(camera.getAttribute('data-qm-glyph'), 'qm-duotone-camera');
assert.ok(camera.classList.contains('qm-glyph-icon'));
assert.equal(camera.children.length, 1);
assert.ok(camera.children[0].classList.contains('qm-glyph-svg'));
assert.match(camera.children[0].innerHTML, /<path|<circle/);
assert.doesNotMatch(camera.children[0].innerHTML, /<use\b/);

const firstSvg = camera.children[0];
const writesAfterFirstApply = local.stats.writes;
assert.equal(applyQianmuIcons(local.root), 1);
assert.equal(camera.children[0], firstSvg);
assert.equal(local.stats.writes, writesAfterFirstApply, '重复渲染应保持零 DOM 写入');

camera.className = 'fa-solid fa-play qm-glyph-icon';
assert.equal(refreshQianmuIcon(camera), true);
assert.equal(camera.children[0], firstSvg);
assert.equal(camera.getAttribute('data-qm-glyph'), 'qm-fill-play');
const playGlyph = firstSvg.innerHTML;
assert.match(playGlyph, /<path|<polygon/);
camera.className = 'fa-solid fa-pause qm-glyph-icon';
assert.equal(refreshQianmuIcon(camera), true);
assert.equal(camera.children[0], firstSvg);
assert.equal(camera.getAttribute('data-qm-glyph'), 'qm-fill-pause');
assert.match(firstSvg.innerHTML, /<path|<rect/);
assert.notEqual(firstSvg.innerHTML, playGlyph);

// Changing appearance must not replace nodes, reset transport state or turn an
// unselected marker into a filled marker just because Bold is the active theme.
for (const [faName, semantic] of [['fa-star', 'star'], ['fa-bookmark', 'bookmark'], ['fa-thumbtack', 'push-pin']]) {
  const marker = local.root.appendChild(new FakeElement('i', {className: `fa-regular ${faName}`, ownerDocument: local.document, stats: local.stats}));
  assert.equal(refreshQianmuIcon(marker), true);
  const markerSvg = marker.children[0];
  for (const [weight, variant] of [['regular', 'outline'], ['solid', 'bold'], ['regular', 'outline']]) {
    marker.className = `fa-${weight} ${faName} qm-glyph-icon`;
    assert.equal(refreshQianmuIcon(marker), true);
    assert.equal(marker.children[0], markerSvg, `${semantic}: state changes reuse the same SVG`);
    assert.deepEqual(groups(markerSvg.innerHTML).map(match => [match[1], Boolean(match[2])]), [[variant, true]]);
    assert.equal(groups(markerSvg.innerHTML)[0][3], ICONSAX_ICON_MARKUP[ICONSAX_GLYPH_NAMES[semantic]][variant]);
    for (const theme of ['editorial', 'glass', 'classic']) {
      local.root.setAttribute('data-qm-theme', theme);
      const writes = local.stats.writes;
      assert.equal(refreshQianmuIcon(marker), true);
      assert.equal(local.stats.writes, writes, `${semantic}/${theme}: changing appearance never repaints state`);
      assert.deepEqual(groups(markerSvg.innerHTML).map(match => [match[1], Boolean(match[2])]), [[variant, true]]);
    }
  }
}

const transient = local.root.appendChild(new FakeElement('i', {
  className: 'fa-solid fa-camera', attributes: {'data-qm-icon': 'qm-signature-backstage'}, ownerDocument: local.document, stats: local.stats,
}));
assert.equal(refreshQianmuIcon(transient), true);
const transientSvg = transient.children[0];
for (const [faName, expected] of [['fa-spinner', 'qm-regular-spinner-gap'], ['fa-stop', 'qm-fill-stop'], ['fa-play', 'qm-fill-play']]) {
  transient.className = `fa-solid ${faName} qm-glyph-icon`;
  assert.equal(refreshQianmuIcon(transient), true);
  assert.equal(transient.children[0], transientSvg);
  assert.equal(transient.getAttribute('data-qm-glyph'), expected, 'loading/stop/play outrank the original semantic entrance');
  if (faName === 'fa-spinner') assert.deepEqual(groups(transientSvg.innerHTML).map(match => [match[1], Boolean(match[2])]), [['outline', true]]);
}
transient.className = 'fa-solid fa-camera qm-glyph-icon';
assert.equal(refreshQianmuIcon(transient), true);
assert.equal(transient.getAttribute('data-qm-glyph'), 'qm-signature-backstage');
assert.equal(transient.children[0], transientSvg);
assert.deepEqual(groups(transientSvg.innerHTML).map(match => match[1]), variantNames);

const direct = qianmuIconElement('fa-camera', {document: local.document});
assert.ok(direct, 'bare SVG API remains available to collection and assistant');
assert.equal(direct.getAttribute('stroke'), 'none', 'Bold never inherits an extra outer stroke');
assert.equal(direct.getAttribute('stroke-width'), '2.5');
assert.equal(direct.getAttribute('aria-hidden'), 'true');
assert.equal(direct.getAttribute('focusable'), 'false');
assert.equal(direct.innerHTML, glyphBody(qianmuIconMarkup('fa-camera')), 'DOM and markup APIs carry identical local geometry');
assert.equal(qianmuIconElement('qm-x" onload="bad', {document: local.document}), null);

const external = makeOwnedRoot('story-director-quick-wheel');
const boundary = external.root.appendChild(new FakeElement('span', { className: 'sd-preserve-external-icon', ownerDocument: external.document, stats: external.stats }));
const externalIcon = boundary.appendChild(new FakeElement('i', { className: 'fa-solid fa-camera', ownerDocument: external.document, stats: external.stats }));
assert.equal(applyQianmuIcons(external.root), 0);
assert.equal(externalIcon.children.length, 0);

const outside = new FakeElement('section', { ownerDocument: local.document, stats: local.stats });
outside.appendChild(new FakeElement('i', { className: 'fa-solid fa-camera', ownerDocument: local.document, stats: local.stats }));
assert.equal(applyQianmuIcons(outside), 0);

// ST bundles only the solid icon font. The collection star is an explicit local
// SVG and must keep both outline/filled states even in a Qianmu-owned scope.
const collectionRoot = makeOwnedRoot(), collectionButton = collectionRoot.root.appendChild(
  new FakeElement('button', {className: 'mes_button interactable qm-collection-star', ownerDocument: collectionRoot.document}),
);
const collectionStar = collectionButton.appendChild(new FakeElement('svg', {
  className: 'qm-collection-star-glyph', attributes: {'data-qianmu-icon-skip': '', 'stroke-width': '2.5'}, ownerDocument: collectionRoot.document,
}));
for (const fill of ['none', 'currentColor']) {
  collectionStar.setAttribute('fill', fill);
  const writes = collectionRoot.stats.writes;
  assert.equal(applyQianmuIcons(collectionButton), 0);
  assert.equal(refreshQianmuIcon(collectionStar), false);
  assert.equal(collectionStar.getAttribute('fill'), fill);
  assert.equal(collectionStar.getAttribute('stroke-width'), '2.5');
  assert.equal(collectionStar.children.length, 0);
  assert.equal(collectionRoot.stats.writes, writes);
}
const collectionFloorSource = await readFile(new URL('qianmu-text-collection-floor.js', rootUrl), 'utf8');
assert.match(collectionFloorSource, /glyph\.setAttribute\('data-qianmu-icon-skip', ''\)/);

const largeStats = { queries: 0, writes: 0 };
const largeDocument = new FakeDocument(largeStats);
for (let index = 0; index < 10_000; index += 1) {
  largeDocument.body.appendChild(new FakeElement('i', { className: index % 2 ? 'fa-solid fa-camera' : 'third-party-node', ownerDocument: largeDocument, stats: largeStats }));
}
assert.equal(applyQianmuIcons(largeDocument), 0);
assert.equal(applyQianmuIcons(largeDocument.body), 0);
assert.equal(largeStats.queries, 0, '拒绝 document/body 时不得执行全页查询');

console.log('Iconsax local icon families, safe geometry, state and ownership contracts OK');
