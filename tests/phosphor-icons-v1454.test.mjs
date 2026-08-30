import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, readFile } from 'node:fs/promises';

import {
  QIANMU_CURRENT_FA_ICON_COUNT,
  QIANMU_FA_ICON_MAP,
  QIANMU_ICON_SPRITE_URL,
  QIANMU_SEMANTIC_ICONS,
  applyQianmuIcons,
  refreshQianmuIcon,
  resolveQianmuIcon,
} from '../qianmu-icon-renderer.js';

const rootUrl = new URL('../', import.meta.url);
const rendererSource = await readFile(new URL('qianmu-icon-renderer.js', rootUrl), 'utf8');
const indexSource = await readFile(new URL('index.js', rootUrl), 'utf8');
const spriteSource = await readFile(new URL('assets/qianmu-phosphor-v1454.svg', rootUrl), 'utf8');
const manifest = JSON.parse(await readFile(new URL('manifest.json', rootUrl), 'utf8'));
const packageJson = JSON.parse(await readFile(new URL('package.json', rootUrl), 'utf8'));

const symbolIds = new Set([...spriteSource.matchAll(/<symbol\b[^>]*\bid="([^"]+)"/g)].map((match) => match[1]));
const customSymbolHashes = Object.freeze({
  'qm-user-coread-entry': '5b8089085be11202e6fb3aea8aa14e31181ba0ded0caaf150d64aa9ce9f3235a',
  'qm-user-character-profile': 'b54700a7e740cccb16103829c4213dc723c55d6cfd59aa45c402ddf7d45a71be',
  'qm-user-floor-tools': 'df13c4306e439acfc065d75260cc1dc182db914b42958d83dd8e1622c891f38d',
  'qm-user-backstage': 'e26a6a0b53b21dd260531fd661fb390b5d6a5b837512c90167c09017f76f524e',
  'qm-user-clear': '60338408d38b6fb3a37c63472bb9a0da03951a7dd81b95bb6a3ec6652557a2bd',
  'qm-user-context': '536effd97ff2214de338b4f9a5ee4309113a05d99da28b2a55fbf093f3a7d842',
  'qm-user-tasks': '48aa03457316a3776226e06e39038c8cfe4c1a552b5a8916ac18682d4fe69237',
  'qm-user-screening': 'd8799e0dbe33fa80ae0ea68a231eb26aa7953d9e9c6b87b60b55e0880b91ade0',
  'qm-user-world': '116b2077c9dabfa68e22606af644eb27b97ae4e7a531ba3b61f2992800648748',
  'qm-user-world-map': '2ad73b0b6976baafad74ae8ff2aad666a9b7d955e863cdd4102122ca1a2ed47b',
  'qm-user-bookmarks': '7c6148ae0e7f29242a9960983365c2c347e73f2b40364c22e3f9cff869ad26c7',
  'qm-user-voice-lines': 'c1be7f4f06e8611bec64940d2a80532e1d9a82b1ade3e4f28c91685400c2474c',
  'qm-user-voice-regenerate-all': 'b4e932ebdb196d5b56b043a1e15c2ee2a4543bba33b67844343e57962d31d22d',
  'qm-user-image-regenerate': 'd533024596f643e9d773321c9917b471df6f8d50f00f986cb9a4d5c7cdeda6c8',
  'qm-user-voice-reextract': '75479e005344afbf06d515c67585675d9f1c8c30fe25e92ca4e9f4b4071f0d6c',
  'qm-user-focus': '5f84f2c8a96d8df673bf94774ab3ef1e7fe8a47e0fcc52065dde0445314e8eba',
});
const faUtilityClasses = new Set(['fa-brands', 'fa-regular', 'fa-solid', 'fa-spin', 'fa-xs']);
const currentFaNames = [...new Set(
  [...indexSource.matchAll(/\bfa-[a-z0-9-]+\b/g)]
    .map((match) => match[0])
    .filter((name) => !faUtilityClasses.has(name)),
)].sort();

assert.equal(currentFaNames.length, 131, '入口当前发出的 Font Awesome 图标名基线必须保持为 131 个');
assert.equal(QIANMU_CURRENT_FA_ICON_COUNT, 131);
assert.deepEqual(Object.keys(QIANMU_FA_ICON_MAP).sort(), currentFaNames, '映射表必须精确覆盖入口实际使用的每个 FA 名');

for (const name of currentFaNames) {
  const mapping = QIANMU_FA_ICON_MAP[name];
  assert.ok(mapping, `${name} 缺少 Phosphor 映射`);
  const variants = typeof mapping === 'string' ? [mapping] : Object.values(mapping);
  for (const symbol of new Set(variants)) {
    assert.ok(symbolIds.has(symbol), `${name} 指向 sprite 中不存在的 symbol：${symbol}`);
  }
  assert.ok(symbolIds.has(resolveQianmuIcon(name)), `${name} 的默认解析结果必须存在于 sprite`);
}

const customSymbols = Object.values(QIANMU_SEMANTIC_ICONS);
assert.equal(Object.keys(QIANMU_SEMANTIC_ICONS).length, 16, '自定义语义图标必须完整保留 16 个');
assert.equal(new Set(customSymbols).size, 16, '自定义语义图标不得互相复用 symbol');
assert.deepEqual(
  [...symbolIds].filter((id) => id.startsWith('qm-user-')).sort(),
  [...customSymbols].sort(),
  'sprite 中的自定义 symbol 必须与语义注册表一一对应',
);
for (const [semantic, symbol] of Object.entries(QIANMU_SEMANTIC_ICONS)) {
  assert.equal(resolveQianmuIcon(semantic), symbol);
  assert.ok(symbolIds.has(symbol), `${semantic} 对应的自定义 symbol 不存在：${symbol}`);
  const inner = spriteSource.match(new RegExp(`<symbol id="${symbol}"[^>]*>([\\s\\S]*?)<\\/symbol>`))?.[1];
  assert.ok(inner, `${semantic} 对应的自定义 symbol 内容不能为空`);
  assert.equal(
    createHash('sha256').update(inner).digest('hex'),
    customSymbolHashes[symbol],
    `${semantic} 必须逐字保留用户指定 SVG 的内部图形`,
  );
}

assert.equal(symbolIds.size, 146, 'sprite 应由 130 个 Phosphor symbol 与 16 个自定义 symbol 组成');
assert.match(QIANMU_ICON_SPRITE_URL, /\/assets\/qianmu-phosphor-v1454\.svg$/);
assert.doesNotMatch(rendererSource, /\bMutationObserver\b/, '局部图标渲染器严禁恢复 MutationObserver');
assert.doesNotMatch(
  rendererSource,
  /(?:globalThis\.)?document\s*\.\s*(?:querySelector(?:All)?|getElementsBy(?:ClassName|TagName)|body\b)/,
  '渲染器不得默认扫描 document 或 body',
);
assert.match(rendererSource, /export function applyQianmuIcons\(root\)/, 'apply 必须要求调用方显式传入局部根');
assert.doesNotMatch(indexSource, /applyQianmuIcons\(\s*(?:document|document\.body|globalThis\.document)\s*\)/, '入口不得把全页传给图标渲染器');

assert.equal(manifest.version, '1.56.1');
assert.equal(packageJson.version, manifest.version);
assert.equal(manifest.js, `index.js?v=${manifest.version}`);
assert.equal(manifest.css, `style.css?v=${manifest.version}`);
assert.match(indexSource, /from '\.\/qianmu-icon-renderer\.js\?v=1\.56\.1';/, '图标渲染器 import 必须按发布版本破缓存');
assert.doesNotMatch(indexSource, /from '\.\/qianmu-icon-renderer\.js';/, '不得保留未版本化的渲染器 import');
assert.match(indexSource, /b\.innerHTML = '<i class="fa-regular fa-circle-play"><\/i>';\s*applyQianmuIcons\(b\);/, '停止连播后的播放图标必须原位刷新');
assert.match(indexSource, /button\.innerHTML = '<i class="fa-solid fa-spinner fa-spin"><\/i>保存中';\s*applyQianmuIcons\(button\);/, '切片保存状态必须使用局部图标刷新');
assert.match(indexSource, /button\.innerHTML = '<i class="fa-solid fa-spinner fa-spin"><\/i>重构中';\s*applyQianmuIcons\(button\);/, '切片重构状态必须使用局部图标刷新');
await assert.rejects(access(new URL('qianmu-icons.js', rootUrl)), undefined, '旧观察器文件不得恢复');
await assert.rejects(access(new URL('assets/qianmu-phosphor-icons.svg', rootUrl)), undefined, '旧 sprite 文件名不得恢复');

class FakeClassList {
  constructor(host, initial = '') {
    this.host = host;
    this.set(initial);
  }

  set(value) {
    this.names = new Set(String(value || '').split(/\s+/).filter(Boolean));
  }

  add(...names) {
    let changed = false;
    for (const name of names) {
      if (name && !this.names.has(name)) {
        this.names.add(name);
        changed = true;
      }
    }
    if (changed && this.host.stats) this.host.stats.writes += 1;
  }

  remove(...names) {
    let changed = false;
    for (const name of names) changed = this.names.delete(name) || changed;
    if (changed && this.host.stats) this.host.stats.writes += 1;
  }

  contains(name) {
    return this.names.has(name);
  }

  toString() {
    return [...this.names].join(' ');
  }
}

function selectorParts(selector) {
  return String(selector || '').split(',').map((part) => part.trim()).filter(Boolean);
}

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
  }

  get className() {
    return this.classList.toString();
  }

  set className(value) {
    this.classList.set(value);
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
    const key = String(name);
    const next = String(value);
    if (this.attributes.get(key) === next) return;
    this.attributes.set(key, next);
    if (this.stats) this.stats.writes += 1;
  }

  setAttributeNS(_namespace, name, value) {
    this.setAttribute(name, value);
  }

  getAttribute(name) {
    return this.attributes.has(String(name)) ? this.attributes.get(String(name)) : null;
  }

  matches(selector) {
    return selectorParts(selector).some((part) => this.matchesOne(part));
  }

  matchesOne(selector) {
    if (selector === 'use') return this.tagName === 'USE';
    if (selector === 'svg.qm-phosphor-svg') return this.tagName === 'SVG' && this.classList.contains('qm-phosphor-svg');
    if (selector === 'i[class*="fa-"]') return this.tagName === 'I' && [...this.classList.names].some((name) => name.startsWith('fa-'));
    if (/^#[a-z0-9_-]+$/i.test(selector)) return this.id === selector.slice(1);
    if (/^\.[a-z0-9_-]+$/i.test(selector)) return this.classList.contains(selector.slice(1));
    const attribute = selector.match(/^\[([a-z0-9_-]+)\]$/i);
    if (attribute) return this.attributes.has(attribute[1]);
    return false;
  }

  closest(selector) {
    for (let node = this; node; node = node.parentElement) {
      if (node.matches(selector)) return node;
    }
    return null;
  }

  querySelectorAll(selector) {
    if (this.stats) this.stats.queries += 1;
    const matches = [];
    const visit = (node) => {
      for (const child of node.children) {
        if (child.matches(selector)) matches.push(child);
        visit(child);
      }
    };
    visit(this);
    return matches;
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }
}

class FakeDocument {
  constructor(stats = { queries: 0, writes: 0 }) {
    this.nodeType = 9;
    this.stats = stats;
    this.body = new FakeElement('body', { ownerDocument: this, stats });
  }

  createElementNS(_namespace, tagName) {
    return new FakeElement(tagName, { ownerDocument: this, stats: this.stats });
  }

  querySelectorAll() {
    this.stats.queries += 1;
    return [];
  }
}

function makeOwnedRoot(id = 'story-director-modal') {
  const stats = { queries: 0, writes: 0 };
  const document = new FakeDocument(stats);
  const root = new FakeElement('section', { id, ownerDocument: document, stats });
  return { document, root, stats };
}

function iconHref(icon) {
  return icon.querySelector('use')?.getAttribute('href') || '';
}

assert.equal(applyQianmuIcons(), 0, '缺少显式根时必须保持静默');

const local = makeOwnedRoot();
const camera = local.root.appendChild(new FakeElement('i', {
  className: 'fa-solid fa-camera',
  ownerDocument: local.document,
  stats: local.stats,
}));
assert.equal(applyQianmuIcons(local.root), 1, '显式千幕局部根应完成图标渲染');
assert.equal(camera.getAttribute('data-qm-phosphor-icon'), 'qm-duotone-camera');
assert.equal(camera.children.length, 1);
assert.match(iconHref(camera), /qianmu-phosphor-v1454\.svg#qm-duotone-camera$/);

const firstSvg = camera.children[0];
const writesAfterFirstApply = local.stats.writes;
assert.equal(applyQianmuIcons(local.root), 1);
assert.equal(camera.children.length, 1, '重复 apply 不得叠加 SVG');
assert.equal(camera.children[0], firstSvg, '重复 apply 应复用原 SVG 节点');
assert.equal(local.stats.writes, writesAfterFirstApply, '重复 apply 必须保持零 DOM 写入');

camera.className = 'fa-solid fa-play qm-phosphor-icon';
assert.equal(refreshQianmuIcon(camera), true);
assert.match(iconHref(camera), /#qm-fill-play$/);
camera.className = 'fa-solid fa-pause qm-phosphor-icon';
assert.equal(refreshQianmuIcon(camera), true, '动态状态图标应支持单节点原位刷新');
assert.equal(camera.children.length, 1);
assert.equal(camera.children[0], firstSvg);
assert.equal(camera.getAttribute('data-qm-phosphor-icon'), 'qm-fill-pause');
assert.match(iconHref(camera), /#qm-fill-pause$/);

const external = makeOwnedRoot('story-director-quick-wheel');
const externalBoundary = external.root.appendChild(new FakeElement('span', {
  className: 'sd-preserve-external-icon',
  ownerDocument: external.document,
  stats: external.stats,
}));
const externalIcon = externalBoundary.appendChild(new FakeElement('i', {
  className: 'fa-solid fa-camera',
  ownerDocument: external.document,
  stats: external.stats,
}));
assert.equal(applyQianmuIcons(external.root), 0, '第三方边界中的图标不得计入渲染');
assert.equal(externalIcon.className, 'fa-solid fa-camera');
assert.equal(externalIcon.children.length, 0);
assert.equal(externalIcon.getAttribute('data-qm-phosphor-icon'), null);

const outside = new FakeElement('section', { ownerDocument: local.document, stats: local.stats });
outside.appendChild(new FakeElement('i', { className: 'fa-solid fa-camera', ownerDocument: local.document, stats: local.stats }));
assert.equal(applyQianmuIcons(outside), 0, '非千幕局部根不得被处理');

const fragmentStats = { queries: 0 };
const unrelatedFragment = {
  nodeType: 11,
  querySelectorAll() { fragmentStats.queries += 1; return []; },
};
assert.equal(applyQianmuIcons(unrelatedFragment), 0, '任意 DocumentFragment 不得被当作千幕根');
assert.equal(fragmentStats.queries, 0, '拒绝 DocumentFragment 时不得开始查询');

const largeStats = { queries: 0, writes: 0 };
const largeDocument = new FakeDocument(largeStats);
for (let index = 0; index < 10_000; index += 1) {
  largeDocument.body.appendChild(new FakeElement('i', {
    className: index % 2 ? 'fa-solid fa-camera' : 'third-party-node',
    ownerDocument: largeDocument,
    stats: largeStats,
  }));
}
assert.equal(applyQianmuIcons(largeDocument), 0, 'document 必须在扫描前被拒绝');
assert.equal(applyQianmuIcons(largeDocument.body), 0, 'body 必须在扫描前被拒绝');
assert.equal(largeStats.queries, 0, '即使页面有 10000 个节点，也不得执行一次 document/body 查询');

console.log('v1.54.0 Phosphor icon boundary and coverage contract OK');
