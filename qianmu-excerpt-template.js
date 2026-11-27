// 书摘成图 · 模板：HTML＋CSS 写成的页面底版。内置模板与用户自建模板走同一套格式与同一个解析器。
// 解析器自带（不依赖浏览器的 DOMParser），只认白名单里的标签、属性与样式；脚本、事件属性、外部链接一概丢弃。
// 输出的是普通对象，由 qianmu-excerpt-doc.js 实例化成可编辑的稿件。

export const PAGE_WIDTH = 1080;
export const TEMPLATE_SOURCE_LIMIT = 200_000;
export const ELEMENT_KINDS = Object.freeze(['text', 'body', 'image', 'rect', 'ellipse', 'line', 'dialog']);
const KIND_SET = new Set(ELEMENT_KINDS);

const VOID = new Set(['br', 'hr', 'wbr', 'meta', 'link', 'img', 'input', 'source', 'col', 'area', 'base', 'embed', 'param', 'track']);
const RAW = new Set(['script', 'style', 'textarea', 'title', 'xmp', 'iframe', 'noembed', 'noframes', 'noscript', 'plaintext', 'template', 'object']);
const HTML_TAGS = new Set(['div', 'span', 'p', 'br', 'b', 'strong', 'i', 'em', 'u', 's', 'small', 'sub', 'sup', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'section', 'article', 'header', 'footer', 'figure', 'figcaption', 'blockquote', 'hr', 'ul', 'ol', 'li']);
const SVG_TAGS = new Set(['svg', 'g', 'path', 'line', 'rect', 'circle', 'ellipse', 'polyline', 'polygon']);
const SVG_ATTRS = new Set(['viewbox', 'd', 'x', 'y', 'x1', 'y1', 'x2', 'y2', 'cx', 'cy', 'r', 'rx', 'ry', 'width', 'height', 'points', 'fill', 'stroke',
    'stroke-width', 'stroke-linecap', 'stroke-linejoin', 'stroke-dasharray', 'opacity', 'fill-opacity', 'stroke-opacity', 'transform', 'preserveaspectratio']);
const SVG_CASE = {viewbox: 'viewBox', preserveaspectratio: 'preserveAspectRatio'};

const ENTITIES = {amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ensp: ' ', emsp: ' ', thinsp: ' ', mdash: '—', ndash: '–', hellip: '…', middot: '·', ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’', times: '×'};
function decodeEntities(text) {
    return text.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,8});/gi, (match, body) => {
        if (body[0] === '#') {
            const code = body[1] === 'x' || body[1] === 'X' ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10);
            return Number.isInteger(code) && code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : '';
        }
        return ENTITIES[body.toLowerCase()] ?? match;
    });
}

// 小型 HTML 分词：得到 {tag, attrs, children} / {text} 的树。只为模板服务，够用即可：未闭合的标签在父级结束时一起收掉。
export function parseHtmlTree(source) {
    const root = {tag: '#root', attrs: {}, children: []}, stack = [root];
    const text = String(source ?? '');
    let index = 0;
    const top = () => stack[stack.length - 1];
    const attrPattern = /\s*([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/y;
    while (index < text.length) {
        if (text.startsWith('<!--', index)) {
            const end = text.indexOf('-->', index + 4);
            index = end < 0 ? text.length : end + 3; continue;
        }
        if (text[index] === '<' && (text[index + 1] === '!' || text[index + 1] === '?')) {
            const end = text.indexOf('>', index);
            index = end < 0 ? text.length : end + 1; continue;
        }
        if (text[index] === '<') {
            const open = /^<(\/?)([a-zA-Z][a-zA-Z0-9-]*)/.exec(text.slice(index, index + 64));
            if (!open) { top().children.push({text: '<'}); index++; continue; }
            const tag = open[2].toLowerCase();
            if (open[1]) {
                const end = text.indexOf('>', index);
                index = end < 0 ? text.length : end + 1;
                const at = stack.map(node => node.tag).lastIndexOf(tag);
                if (at > 0) stack.length = at;
                continue;
            }
            index += open[0].length;
            const attrs = {};
            for (;;) {
                attrPattern.lastIndex = index;
                const match = attrPattern.exec(text);
                if (!match || !match[1]) break;
                const name = match[1].toLowerCase();
                if (!(name in attrs) && Object.keys(attrs).length < 64) attrs[name] = decodeEntities(match[2] ?? match[3] ?? match[4] ?? '');
                index = attrPattern.lastIndex;
            }
            const close = text.indexOf('>', index);
            const selfClosing = close > 0 && text[close - 1] === '/';
            index = close < 0 ? text.length : close + 1;
            if (RAW.has(tag)) {
                const lower = text.toLowerCase(), end = lower.indexOf(`</${tag}`, index);
                const content = text.slice(index, end < 0 ? text.length : end);
                index = end < 0 ? text.length : (text.indexOf('>', end) + 1 || text.length);
                if (tag === 'style') top().children.push({tag: 'style', attrs: {}, children: [], css: content});
                continue;
            }
            const node = {tag, attrs, children: []};
            top().children.push(node);
            if (!VOID.has(tag) && !selfClosing && stack.length < 64) stack.push(node);
            continue;
        }
        const next = text.indexOf('<', index);
        const end = next < 0 ? text.length : next;
        top().children.push({text: decodeEntities(text.slice(index, end))});
        index = end;
    }
    return root;
}

// 样式只去掉会向外取资源或执行的写法；data: 地址保留（可内嵌纹理与字体）。
export function sanitizeCss(css, limit = 100_000) {
    let value = String(css ?? '').slice(0, limit);
    value = value.replace(/\/\*[\s\S]*?\*\//g, '');
    // 先把十六进制转义还原，免得用转义拼出被禁的关键字。
    value = value.replace(/\\([0-9a-fA-F]{1,6})\s?/g, (match, hex) => {
        const code = Number.parseInt(hex, 16);
        return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) && !/["'\\\n]/.test(String.fromCodePoint(code)) ? String.fromCodePoint(code) : '';
    }).replace(/\\([a-zA-Z])/g, '$1');
    value = value.replace(/</g, '');
    value = value.replace(/@import[^;]*;?/gi, '');
    value = value.replace(/url\s*\(\s*(['"]?)([\s\S]*?)\1\s*\)/gi, (match, quote, address) => /^data:/i.test(address.trim()) && !/^data:text\/html/i.test(address.trim()) ? match : 'none');
    value = value.replace(/(?:-webkit-)?image-set\s*\(|\bsrc\s*\(/gi, 'x-blocked(');
    value = value.replace(/expression\s*\(|javascript\s*:|-moz-binding|behavior\s*:/gi, '');
    return value;
}

function escapeText(value) { return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function escapeAttr(value) { return escapeText(value).replace(/"/g, '&quot;'); }
const CLASS_TOKEN = /^[A-Za-z_][\w-]{0,63}$/;
export function sanitizeClass(value) {
    return String(value ?? '').split(/\s+/).filter(token => CLASS_TOKEN.test(token) && !/^qm-/.test(token)).slice(0, 12).join(' ');
}

function cleanAttrs(node, svg) {
    const out = [];
    for (const [name, raw] of Object.entries(node.attrs || {})) {
        const value = String(raw).slice(0, 2000);
        if (name === 'class') { const cls = sanitizeClass(value); if (cls) out.push(['class', cls]); }
        else if (name === 'style') { const style = sanitizeCss(value, 4000).replace(/[{}]/g, ''); if (style.trim()) out.push(['style', style]); }
        else if (/^data-[a-z0-9-]{1,40}$/.test(name) && name !== 'data-qm' && name !== 'data-id') out.push([name, value.slice(0, 200)]);
        else if (svg && SVG_ATTRS.has(name) && !/url\s*\(|javascript/i.test(value)) out.push([SVG_CASE[name] || name, value]);
    }
    return out;
}

// 装饰层：白名单标签原样输出（转义过），其余整段丢掉。
export function serializeDecor(nodes, depth = 0, svg = false) {
    let html = '';
    for (const node of nodes || []) {
        if (node.text !== undefined) { html += escapeText(node.text); continue; }
        if (depth > 40 || node.tag === 'style') continue;
        const inSvg = svg || node.tag === 'svg';
        if (!(inSvg ? SVG_TAGS.has(node.tag) : HTML_TAGS.has(node.tag))) continue;
        const attrs = cleanAttrs(node, inSvg).map(([name, value]) => ` ${name}="${escapeAttr(value)}"`).join('');
        if (node.tag === 'br' || node.tag === 'hr') { html += `<${node.tag}${attrs}>`; continue; }
        html += `<${node.tag}${attrs}>${serializeDecor(node.children, depth + 1, inSvg)}</${node.tag}>`;
    }
    return html;
}
export function sanitizeDecor(html) { return serializeDecor(parseHtmlTree(String(html ?? '').slice(0, TEMPLATE_SOURCE_LIMIT)).children); }

function plainText(nodes) {
    let text = '';
    for (const node of nodes || []) {
        if (node.text !== undefined) text += node.text;
        else if (node.tag === 'br') text += '\n';
        else if (node.tag !== 'style') {
            const inner = plainText(node.children);
            text += ['p', 'div', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6'].includes(node.tag) && text && !text.endsWith('\n') ? `\n${inner}` : inner;
        }
    }
    return text;
}

const GEOMETRY = ['left', 'top', 'width', 'height'];
// 行内样式拆成几何（px）与其余声明；其余声明作为该元素的模板基础样式保留。
function splitStyle(style) {
    const geometry = {}, rest = [];
    for (const declaration of sanitizeCss(style || '', 4000).replace(/[{}]/g, '').split(';')) {
        const at = declaration.indexOf(':');
        if (at < 0) continue;
        const name = declaration.slice(0, at).trim().toLowerCase(), value = declaration.slice(at + 1).trim();
        if (!name || !value) continue;
        if (GEOMETRY.includes(name)) {
            const number = Number.parseFloat(value);
            if (Number.isFinite(number) && /^-?[\d.]+(?:px)?$/.test(value)) geometry[name] = number;
        } else if (name !== 'position' && name !== 'z-index') rest.push(`${name}:${value}`);
    }
    return {geometry, base: rest.join(';')};
}

function finite(value, fallback, min, max) {
    const number = Number(value);
    return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
}

function readElement(node, kind, height) {
    const {geometry, base} = splitStyle(node.attrs.style);
    const element = {
        kind,
        x: finite(geometry.left, 80, -PAGE_WIDTH, PAGE_WIDTH * 2),
        y: finite(geometry.top, 80, -height, height * 2),
        w: finite(geometry.width, kind === 'line' ? 300 : 240, 0, PAGE_WIDTH * 3),
        h: finite(geometry.height, kind === 'line' ? 0 : 120, 0, 40000),
        cls: sanitizeClass(node.attrs.class),
        base,
    };
    if (kind === 'text') {
        element.src = plainText(node.children).replace(/^\s*\n|\n\s*$/g, '').replace(/[ \t]*\n[ \t]*/g, '\n').trim();
        if (node.attrs['data-field']) element.field = String(node.attrs['data-field']).slice(0, 32);
    }
    if (kind === 'text' || kind === 'body' || kind === 'dialog') element.vertical = 'data-vertical' in node.attrs || /writing-mode\s*:\s*vertical/i.test(base);
    if (kind === 'dialog' && node.attrs['data-look'] === 'bubble') element.look = 'bubble';
    if (kind === 'line') element.dir = node.attrs['data-dir'] === 'up' ? -1 : 1;
    return element;
}

function readPage(node, fallbackHeight) {
    const height = finite(node.attrs['data-height'], fallbackHeight, 300, 20000);
    const elements = [], decor = [];
    for (const child of node.children) {
        const kind = child.attrs?.['data-qm'];
        if (child.tag && KIND_SET.has(kind)) elements.push(readElement(child, kind, height));
        else if (child.tag !== 'style') decor.push(child);
    }
    return {height, decor: serializeDecor(decor).trim(), elements};
}

function collectCss(node, out) {
    for (const child of node.children || []) {
        if (child.tag === 'style') out.push(child.css || '');
        else if (child.children) collectCss(child, out);
    }
    return out;
}

function findSections(node, out = []) {
    for (const child of node.children || []) {
        if (child.tag === 'section' && child.attrs['data-page']) out.push(child);
        else if (child.children && child.tag !== 'section') findSections(child, out);
    }
    return out;
}

const HEX = /^#[0-9a-f]{6}$/i;
export function normalizeHex(value, fallback = '') {
    const text = String(value ?? '').trim();
    if (HEX.test(text)) return text.toLowerCase();
    if (/^#[0-9a-f]{3}$/i.test(text)) return `#${[...text.slice(1)].map(char => char + char).join('')}`.toLowerCase();
    return fallback;
}

// 解析模板源码。失败时给出一句能照着改的话。
export function parseExcerptTemplate(source) {
    const text = String(source ?? '');
    if (!text.trim()) return {ok: false, error: '模板是空的'};
    if (text.length > TEMPLATE_SOURCE_LIMIT) return {ok: false, error: '模板超过 200KB'};
    const tree = parseHtmlTree(text);
    const sections = findSections(tree);
    const firstNode = sections.find(node => node.attrs['data-page'] === 'first') || sections[0];
    if (!firstNode) return {ok: false, error: '没有找到 <section data-page="first">'};
    const restNode = sections.find(node => node !== firstNode && node.attrs['data-page'] === 'rest');
    const first = readPage(firstNode, 1440);
    const rest = restNode ? readPage(restNode, first.height) : null;
    if (!first.elements.length && !first.decor) return {ok: false, error: '第一页里没有任何元素'};
    const attrs = firstNode.attrs;
    return {ok: true, template: {
        name: String(attrs['data-name'] || '').trim().slice(0, 40) || '未命名模板',
        height: first.height,
        paper: normalizeHex(attrs['data-paper'], '#ffffff'),
        ink: normalizeHex(attrs['data-ink'], '#222222'),
        css: sanitizeCss(collectCss(tree, []).join('\n')),
        first: {decor: first.decor, elements: first.elements},
        rest: rest ? {decor: rest.decor, elements: rest.elements} : null,
    }};
}

// ── 占位字段 ────────────────────────────────────────────────────────────────
export const FIELD_TOKENS = Object.freeze(['char', 'user', 'pair', 'floor', 'date', 'md', 'time', 'weekday', 'lunar', 'year', 'book', 'author', 'note']);

function parseHostDate(value) {
    if (typeof value !== 'string' || !value.trim()) return null;
    const direct = Date.parse(value);
    if (Number.isFinite(direct)) return new Date(direct);
    // ST 旧格式：「2026-9-28 @12h 05m 33s 123ms」
    const match = /^(\d{4})-(\d{1,2})-(\d{1,2})\s*@(\d{1,2})h\s*(\d{1,2})m/.exec(value.trim());
    if (match) return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), Number(match[4]), Number(match[5]));
    // ST 新格式：「November 26, 2026 9:05pm」
    const spoken = /^([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})\s+(\d{1,2}):(\d{2})\s*(am|pm)?/i.exec(value.trim());
    if (spoken) {
        const month = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'].indexOf(spoken[1].slice(0, 3).toLowerCase());
        let hour = Number(spoken[4]) % 12;
        if (spoken[6]?.toLowerCase() === 'pm') hour += 12; else if (!spoken[6]) hour = Number(spoken[4]);
        if (month >= 0) return new Date(Number(spoken[3]), month, Number(spoken[2]), hour, Number(spoken[5]));
    }
    return null;
}

function lunarDay(day) {
    const digits = ['', '一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];
    if (day <= 10) return `初${digits[day]}`;
    if (day < 20) return `十${digits[day - 10]}`;
    if (day === 20) return '二十';
    if (day < 30) return `廿${digits[day - 20]}`;
    return '三十';
}

// 收藏的来源标识里记着那一层第一次生成的时刻（[角色, 时刻]）；楼层号只在当前聊天里能对上。
// 伴读里另有书名、作者与这条摘录的笔记。
export function excerptFields({charName = '', userName = '', floor = null, sentAt = '', createdAt = '', book = '', author = '', note = ''} = {}) {
    const char = String(charName || '').trim(), user = String(userName || '').trim();
    const date = parseHostDate(sentAt) || parseHostDate(createdAt);
    const pad = value => String(value).padStart(2, '0');
    let lunar = '';
    if (date) {
        try {
            const parts = new Intl.DateTimeFormat('zh-CN-u-ca-chinese', {year: 'numeric', month: 'long', day: 'numeric'}).formatToParts(date);
            const get = type => parts.find(part => part.type === type)?.value || '';
            const year = get('yearName');
            const day = Number.parseInt(get('day'), 10);
            lunar = get('month') && day >= 1 && day <= 30 ? `${year ? `${year}年` : ''}${get('month')}${lunarDay(day)}` : '';
        } catch { lunar = ''; }
    }
    return {
        char, user,
        pair: char && user ? `${char} 与 ${user}` : char || user,
        floor: Number.isInteger(floor) && floor >= 0 ? String(floor) : '',
        date: date ? `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日` : '',
        md: date ? `${date.getMonth() + 1}/${date.getDate()}` : '',
        time: date ? `${pad(date.getHours())}:${pad(date.getMinutes())}` : '',
        weekday: date ? ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'][date.getDay()] : '',
        lunar,
        year: date ? String(date.getFullYear()) : '',
        book: String(book || '').trim(), author: String(author || '').trim(), note: String(note || '').trim(),
    };
}

export function resolveFields(text, fields = {}) {
    return String(text ?? '').replace(/\{\{\s*([a-z]+)\s*\}\}/g, (match, name) => FIELD_TOKENS.includes(name) ? String(fields[name] ?? '') : match);
}
export function hasFieldToken(text) { return /\{\{\s*[a-z]+\s*\}\}/.test(String(text ?? '')); }

// ── 内置模板 ────────────────────────────────────────────────────────────────
// 五套都按用户给的参照版式排；图片位置一律是留空的叉线框，点一下即可选图。

const BOOK = `<style>
.page { font-family: "Noto Serif SC", "Source Han Serif SC", "Songti SC", serif; }
.corner { font: 30px/1.15 "Avenir Next", "Helvetica Neue", Arial, sans-serif; letter-spacing: .04em; text-align: center; }
.title { font-size: 54px; line-height: 1.25; letter-spacing: .06em; }
.ink-bar { background: #d4d4d4; opacity: .55; border-radius: 6px; }
.text { font-size: 30px; line-height: 2; text-align: justify; color: #3a3a3a; }
</style>
<section data-page="first" data-name="书页 · 竖题" data-height="1920" data-paper="#ffffff" data-ink="#2b2b2b">
  <div data-qm="text" data-field="floor" class="corner" style="left:900px;top:250px;width:140px;height:44px">{{floor}}</div>
  <div data-qm="line" data-dir="up" style="left:912px;top:300px;width:116px;height:12px"></div>
  <div data-qm="text" data-field="md" class="corner" style="left:900px;top:318px;width:140px;height:44px">{{md}}</div>
  <div data-qm="rect" class="ink-bar" style="left:218px;top:606px;width:22px;height:212px"></div>
  <div data-qm="text" data-field="pair" data-vertical class="title" style="left:200px;top:612px;width:150px;height:430px">{{pair}}</div>
  <div data-qm="body" class="text" style="left:220px;top:1080px;width:735px;height:620px"></div>
</section>
<section data-page="rest" data-height="1920">
  <div data-qm="text" data-field="floor" class="corner" style="left:900px;top:250px;width:140px;height:44px">{{floor}}</div>
  <div data-qm="line" data-dir="up" style="left:912px;top:300px;width:116px;height:12px"></div>
  <div data-qm="text" data-field="md" class="corner" style="left:900px;top:318px;width:140px;height:44px">{{md}}</div>
  <div data-qm="body" class="text" style="left:220px;top:470px;width:735px;height:1230px"></div>
</section>`;

const MAGAZINE = `<style>
.page { font-family: "Noto Serif SC", "Source Han Serif SC", "Songti SC", serif; }
.title { font-size: 64px; line-height: 1.32; text-align: center; letter-spacing: .02em; }
.subtitle { font-size: 42px; line-height: 1.3; text-align: center; font-weight: 700; }
.byline { font-size: 19px; text-align: center; font-weight: 700; letter-spacing: .08em; }
.spine { font-size: 17px; letter-spacing: .06em; }
.col { font-size: 23px; line-height: 1.78; text-align: justify; }
.folio { font-size: 17px; text-align: center; }
</style>
<section data-page="first" data-name="杂志 · 双栏" data-height="1528" data-paper="#e7dcd6" data-ink="#1f1c1b">
  <div data-qm="text" data-field="pair" class="title" style="left:120px;top:210px;width:840px;height:96px">{{pair}}</div>
  <div data-qm="text" data-field="date" class="subtitle" style="left:120px;top:340px;width:840px;height:60px">{{date}}</div>
  <div data-qm="text" class="byline" style="left:120px;top:440px;width:840px;height:30px">摘自第 {{floor}} 层 · {{char}}</div>
  <div data-qm="text" data-vertical class="spine" style="left:44px;top:640px;width:30px;height:330px">{{char}} · {{user}}</div>
  <div data-qm="body" class="col" style="left:100px;top:640px;width:422px;height:790px"></div>
  <div data-qm="body" class="col" style="left:560px;top:640px;width:422px;height:790px"></div>
  <div data-qm="text" data-field="floor" class="folio" style="left:440px;top:1462px;width:200px;height:26px">{{floor}}</div>
</section>
<section data-page="rest" data-height="1528">
  <div data-qm="text" data-vertical class="spine" style="left:44px;top:120px;width:30px;height:330px">{{char}} · {{user}}</div>
  <div data-qm="body" class="col" style="left:100px;top:120px;width:422px;height:1310px"></div>
  <div data-qm="body" class="col" style="left:560px;top:120px;width:422px;height:1310px"></div>
  <div data-qm="text" data-field="floor" class="folio" style="left:440px;top:1462px;width:200px;height:26px">{{floor}}</div>
</section>`;

const FEATURE = `<style>
.page { font-family: "Noto Sans SC", "Source Han Sans SC", "PingFang SC", "Microsoft YaHei", sans-serif; }
.running { font-size: 21px; font-weight: 600; letter-spacing: .02em; }
.running.r { text-align: right; }
.caption { font-size: 15px; font-weight: 700; text-align: right; }
.headline { font-size: 64px; line-height: 1.3; font-weight: 500; }
.deck { font-size: 34px; font-weight: 800; letter-spacing: .01em; }
.credit { font-size: 19px; font-weight: 700; }
.story { font-size: 20px; line-height: 1.9; text-align: justify; }
.folio { font-size: 20px; font-weight: 600; }
</style>
<section data-page="first" data-name="人物 · 图文" data-height="1528" data-paper="#ffffff" data-ink="#141414">
  <div data-qm="text" class="running" style="left:52px;top:46px;width:560px;height:30px">{{char}} ｜ {{user}}</div>
  <div data-qm="text" data-field="date" class="running r" style="left:560px;top:46px;width:468px;height:30px">{{date}}</div>
  <div data-qm="image" style="left:52px;top:104px;width:976px;height:530px"></div>
  <div data-qm="text" data-field="time" class="caption" style="left:628px;top:652px;width:400px;height:22px">{{weekday}} {{time}}</div>
  <div data-qm="text" data-field="char" class="headline" style="left:52px;top:756px;width:310px;height:170px">{{char}}</div>
  <div data-qm="text" data-field="user" class="deck" style="left:52px;top:944px;width:310px;height:46px">{{user}}</div>
  <div data-qm="text" class="credit" style="left:52px;top:1010px;width:310px;height:28px">第 {{floor}} 层</div>
  <div data-qm="body" class="story" style="left:392px;top:760px;width:636px;height:700px"></div>
  <div data-qm="text" data-field="floor" class="folio" style="left:52px;top:1476px;width:200px;height:28px">{{floor}}</div>
</section>
<section data-page="rest" data-height="1528">
  <div data-qm="text" class="running" style="left:52px;top:46px;width:560px;height:30px">{{char}} ｜ {{user}}</div>
  <div data-qm="text" data-field="date" class="running r" style="left:560px;top:46px;width:468px;height:30px">{{date}}</div>
  <div data-qm="body" class="story" style="left:392px;top:120px;width:636px;height:1340px"></div>
  <div data-qm="text" data-field="floor" class="folio" style="left:52px;top:1476px;width:200px;height:28px">{{floor}}</div>
</section>`;

const POEM = `<style>
.page { font-family: "Noto Serif SC", "Source Han Serif SC", "Songti SC", serif; }
.date { font-size: 36px; line-height: 1.2; }
.lunar { font-size: 17px; line-height: 1.5; }
.verse { font-size: 20px; line-height: 1.62; }
.name { font-size: 40px; font-weight: 700; letter-spacing: .02em; }
.sub { font-size: 34px; font-weight: 700; }
.sign { font-size: 21px; }
</style>
<section data-page="first" data-name="诗页 · 半幅" data-height="1440" data-paper="#eeedea" data-ink="#d8211e">
  <div data-qm="image" style="left:0px;top:0px;width:1080px;height:628px"></div>
  <div data-qm="text" data-field="md" class="date" style="left:110px;top:92px;width:240px;height:46px">{{md}}</div>
  <div data-qm="text" class="lunar" style="left:56px;top:146px;width:300px;height:56px">{{lunar}}
{{weekday}}</div>
  <div data-qm="body" class="verse" style="left:112px;top:346px;width:370px;height:360px"></div>
  <div data-qm="body" class="verse" style="left:596px;top:568px;width:380px;height:370px"></div>
  <div data-qm="text" data-field="pair" class="name" style="left:172px;top:1042px;width:720px;height:54px">{{pair}}</div>
  <div data-qm="text" data-field="date" class="sub" style="left:172px;top:1110px;width:720px;height:46px">{{date}}</div>
  <div data-qm="text" class="sign" style="left:172px;top:1222px;width:500px;height:32px">/ {{char}}</div>
</section>
<section data-page="rest" data-height="1440">
  <div data-qm="text" data-field="md" class="date" style="left:110px;top:92px;width:240px;height:46px">{{md}}</div>
  <div data-qm="body" class="verse" style="left:112px;top:220px;width:370px;height:1080px"></div>
  <div data-qm="body" class="verse" style="left:596px;top:220px;width:380px;height:1080px"></div>
</section>`;

// 伴读：摘录、笔记与书友对话一页，出处在底部。
const COREAD = `<style>
.page { font-family: "Noto Serif SC", "Source Han Serif SC", "Songti SC", serif; }
.bar { background: #b37d6b; border: 0; border-radius: 4px; }
.label { font-size: 26px; letter-spacing: .06em; opacity: .7; }
.quote { font-size: 42px; line-height: 1.72; text-indent: 0; text-align: justify; --qm-gap: .6em; }
.note { font-size: 27px; line-height: 1.7; opacity: .82; }
.rule { color: #b37d6b; }
.talk { font-size: 25px; line-height: 1.6; --qm-gap: .55em; --qm-who: #b37d6b; }
.book { font-size: 31px; font-weight: 600; }
.author { font-size: 24px; opacity: .6; }
</style>
<section data-page="first" data-name="书摘 · 共读" data-height="1440" data-paper="#f2ede3" data-ink="#302c2a">
  <div data-qm="rect" class="bar" style="left:86px;top:86px;width:8px;height:110px"></div>
  <div data-qm="text" data-field="pair" class="label" style="left:122px;top:96px;width:820px;height:36px">共读 · {{pair}}</div>
  <div data-qm="text" data-field="date" class="label" style="left:122px;top:146px;width:820px;height:36px">{{date}}</div>
  <div data-qm="body" class="quote" style="left:122px;top:250px;width:836px;height:560px"></div>
  <div data-qm="line" class="rule" style="left:122px;top:846px;width:54px;height:0px"></div>
  <div data-qm="text" data-field="note" class="note" style="left:122px;top:880px;width:836px;height:120px">{{note}}</div>
  <div data-qm="dialog" class="talk" style="left:122px;top:1030px;width:836px;height:230px"></div>
  <div data-qm="text" data-field="book" class="book" style="left:122px;top:1300px;width:836px;height:42px">《{{book}}》</div>
  <div data-qm="text" data-field="author" class="author" style="left:122px;top:1352px;width:836px;height:32px">{{author}}</div>
</section>
<section data-page="rest" data-height="1440">
  <div data-qm="rect" class="bar" style="left:86px;top:86px;width:8px;height:60px"></div>
  <div data-qm="text" data-field="pair" class="label" style="left:122px;top:96px;width:820px;height:36px">共读 · {{pair}}</div>
  <div data-qm="body" class="quote" style="left:122px;top:200px;width:836px;height:1060px"></div>
  <div data-qm="text" data-field="book" class="book" style="left:122px;top:1300px;width:836px;height:42px">《{{book}}》</div>
  <div data-qm="text" data-field="author" class="author" style="left:122px;top:1352px;width:836px;height:32px">{{author}}</div>
</section>`;

const NIGHT = `<style>
.page { font-family: "Noto Serif SC", "Source Han Serif SC", "Songti SC", serif; }
.v-title { font-size: 40px; letter-spacing: .08em; }
.v-note { font-size: 16px; letter-spacing: .04em; }
.v-text { font-size: 22px; line-height: 1.78; text-align: justify; }
.v-quote { font-size: 30px; line-height: 1.7; }
.v-cap { font-size: 15px; letter-spacing: .06em; }
.frame { color: #f2efe9; }
</style>
<section data-page="first" data-name="夜读 · 竖排" data-height="1440" data-paper="#121010" data-ink="#f2efe9">
  <div data-qm="line" style="left:1000px;top:60px;width:0px;height:380px"></div>
  <div data-qm="text" data-field="char" data-vertical class="v-title" style="left:930px;top:84px;width:56px;height:220px">{{char}}</div>
  <div data-qm="text" data-field="date" data-vertical class="v-note" style="left:896px;top:88px;width:28px;height:330px">{{date}} {{time}}</div>
  <div data-qm="line" style="left:878px;top:60px;width:0px;height:380px"></div>
  <div data-qm="body" data-vertical class="v-text" style="left:480px;top:90px;width:380px;height:430px"></div>
  <div data-qm="image" class="frame" style="left:392px;top:596px;width:366px;height:480px"></div>
  <div data-qm="body" data-vertical class="v-quote" style="left:120px;top:60px;width:230px;height:860px"></div>
  <div data-qm="text" data-vertical class="v-cap" style="left:1030px;top:1180px;width:24px;height:200px">第{{floor}}层 · {{user}}</div>
  <div data-qm="text" data-field="pair" data-vertical class="v-cap" style="left:56px;top:60px;width:24px;height:400px">{{pair}}</div>
</section>
<section data-page="rest" data-height="1440">
  <div data-qm="line" style="left:1000px;top:60px;width:0px;height:380px"></div>
  <div data-qm="text" data-field="char" data-vertical class="v-title" style="left:930px;top:84px;width:56px;height:220px">{{char}}</div>
  <div data-qm="body" data-vertical class="v-text" style="left:120px;top:90px;width:740px;height:1260px"></div>
  <div data-qm="text" data-vertical class="v-cap" style="left:1030px;top:1180px;width:24px;height:200px">第{{floor}}层 · {{user}}</div>
</section>`;

export const BUILTIN_TEMPLATES = Object.freeze([
    Object.freeze({id: 'builtin:book', source: BOOK}),
    Object.freeze({id: 'builtin:magazine', source: MAGAZINE}),
    Object.freeze({id: 'builtin:feature', source: FEATURE}),
    Object.freeze({id: 'builtin:poem', source: POEM}),
    Object.freeze({id: 'builtin:night', source: NIGHT}),
    Object.freeze({id: 'builtin:coread', source: COREAD, scope: 'reader'}),
]);

// 交给自建模板的人（或交给 AI 代写）的说明与底版。
export const TEMPLATE_GUIDE = `千幕书摘模板说明（可以整段交给 AI 代写）

一个模板是一段 HTML＋CSS：
1. <style> 里写样式。页面根节点类名是 .page，宽度固定 1080px。可用变量 var(--paper)（纸色）与 var(--ink)（文字色）。
2. 每种页面一个 <section data-page="…">：first 是第一页；rest 是正文排不下时接着用的页（可省，省略时沿用 first）。
   first 上可写 data-name="模板名" data-height="1440"（页高，宽固定 1080）data-paper="#ffffff" data-ink="#222222"。
3. section 里带 data-qm 的元素可在成图页上拖动、缩放、改样式，必须用行内 style 写 left/top/width/height（px）：
   data-qm="body"     正文框。正文按出现顺序依次流入各个正文框，排不下自动加页。加 data-vertical 为竖排（从右往左读）。
   data-qm="text"     文本框。可写占位：{{char}} 角色名、{{user}} 用户名、{{pair}} 两人名、{{floor}} 楼层号、
                      {{date}} 日期、{{md}} 月/日、{{time}} 时刻、{{weekday}} 星期、{{lunar}} 农历、{{year}} 年份；
                      伴读里另有 {{book}} 书名、{{author}} 作者、{{note}} 这条摘录的笔记（{{char}} 是书友）。
   data-qm="image"    图片框，留空时是叉线框，点一下选图。
   data-qm="rect" / data-qm="ellipse"   矩形、圆形。
   data-qm="line"     线条：从框的左上连到右下；高为 0 是横线，宽为 0 是竖线；加 data-dir="up" 改为左下连到右上。
   data-qm="dialog"   书友对话（伴读）：选入的对话一句一行；加 data-look="bubble" 为气泡样式，默认是「名字：话」。
                      每句是 .qm-say（书友 .is-friend／你 .is-user），名字 .qm-who，话 .qm-line，句距用变量 --qm-gap。
   这些元素可以带 class，用 <style> 里的类来定字号、字体、颜色、行距等；用户在成图页上改的会盖在上面。
   正文框的段首缩进用 text-indent（默认 2em），段距用变量 --qm-gap（默认 .55em）。
4. 不带 data-qm 的元素是固定装饰（线、色块、SVG 纹样、固定文字），照原样画在最底层。
5. 不能用：脚本、事件属性、<img>（图片请用图片框）、外部链接（url() 只认 data: 地址）。`;

export const TEMPLATE_STARTER = `<style>
.page { font-family: "Noto Serif SC", serif; }
.title { font-size: 56px; line-height: 1.3; text-align: center; }
.meta { font-size: 20px; text-align: center; letter-spacing: .1em; }
.text { font-size: 28px; line-height: 1.9; text-align: justify; }
</style>
<section data-page="first" data-name="我的模板" data-height="1440" data-paper="#f6f1e9" data-ink="#2a2522">
  <div data-qm="text" class="title" style="left:120px;top:150px;width:840px;height:80px">{{pair}}</div>
  <div data-qm="text" class="meta" style="left:120px;top:250px;width:840px;height:30px">{{date}} · 第 {{floor}} 层</div>
  <div data-qm="line" style="left:440px;top:320px;width:200px;height:0px"></div>
  <div data-qm="body" class="text" style="left:140px;top:380px;width:800px;height:940px"></div>
</section>
<section data-page="rest">
  <div data-qm="body" class="text" style="left:140px;top:140px;width:800px;height:1180px"></div>
</section>`;
