// 书摘成图 · 排版与出图。编辑页与导出用同一个 buildPage：编辑页把它放进影子根（样式与 ST 互不影响），
// 导出时把同一棵节点序列化进 SVG 的 foreignObject 再画到画布上——所见即所得，竖排、两端对齐、模板 CSS 都由浏览器排。
// 正文在各页正文框之间流动：逐框用真实排版量出能放下多少字（二分），排不下就加续页。
import {PAGE_WIDTH, MAX_PAGE_HEIGHT, MAX_PAGES, PAGE_BREAK, pageHeight} from './qianmu-excerpt-doc.js';

export const BASE_CSS = `
.page{position:relative;width:${PAGE_WIDTH}px;margin:0;overflow:hidden;background:var(--paper);color:var(--ink);font-size:24px;line-height:1.6;box-sizing:border-box;text-rendering:optimizeLegibility;-webkit-font-smoothing:antialiased;font-kerning:normal}
.page *{box-sizing:border-box}
.qm-bg{position:absolute;left:0;top:0;width:100%;height:100%;object-fit:cover;pointer-events:none;user-select:none;max-width:none}
.qm-el{position:absolute;margin:0;padding:0}
.qm-text,.qm-body{white-space:pre-wrap;overflow-wrap:break-word;line-break:strict;hanging-punctuation:none}
.qm-text{overflow:visible}
.qm-body{overflow:hidden;text-indent:2em}
.qm-v{writing-mode:vertical-rl;text-orientation:mixed}
.qm-body p{margin:0;text-indent:inherit}
.qm-body p+p{margin-block-start:var(--qm-gap,.55em)}
.qm-body p.qm-cont{text-indent:0}
.qm-image{overflow:hidden}
.qm-image>img{position:absolute;max-width:none;max-height:none;pointer-events:none;user-select:none}
.qm-image.qm-empty{border:1.5px solid currentColor}
.qm-image.qm-empty>svg{position:absolute;left:0;top:0;width:100%;height:100%;overflow:visible}
.qm-rect,.qm-ellipse{border:2px solid currentColor}
.qm-ellipse{border-radius:50%}
.qm-line{overflow:visible}
.qm-line>svg{position:absolute;left:0;top:0;overflow:visible}
`;

export const FONT_STACKS = Object.freeze({
    serif: '"Noto Serif SC","Source Han Serif SC","Songti SC","STSong","SimSun",serif',
    sans: '"Noto Sans SC","Source Han Sans SC","PingFang SC","Microsoft YaHei","Heiti SC",sans-serif',
    kai: '"LXGW WenKai","Kaiti SC","STKaiti","KaiTi",serif',
    mono: '"JetBrains Mono","SFMono-Regular",Consolas,monospace',
});

function fontFamily(key, families) {
    if (!key) return '';
    if (FONT_STACKS[key]) return FONT_STACKS[key];
    const family = families?.get?.(key);
    return family ? `"${String(family).replace(/["\\]/g, '')}",${FONT_STACKS.serif}` : '';
}

// 自适应比例时，正文框随正文伸缩，位于正文框下方的元素整体跟着上下移。
export function shiftFor(page, element, delta) {
    if (!delta) return {dy: 0, dh: 0};
    if (element.kind === 'body') return {dy: 0, dh: delta};
    const bottom = Math.max(...page.elements.filter(item => item.kind === 'body').map(item => item.y + item.h));
    return Number.isFinite(bottom) && element.y >= bottom - 1 ? {dy: delta, dh: 0} : {dy: 0, dh: 0};
}

export function elementCss(element, {families, dy = 0, dh = 0, z = 1} = {}) {
    const p = element.props || {};
    const parts = [`left:${element.x}px`, `top:${element.y + dy}px`, `width:${element.w}px`, `height:${element.h + dh}px`, `z-index:${z}`];
    if (element.base) parts.push(element.base);
    const family = fontFamily(p.font, families);
    if (family) parts.push(`font-family:${family}`);
    if (p.size !== undefined) parts.push(`font-size:${p.size}px`);
    if (p.lh !== undefined) parts.push(`line-height:${p.lh}`);
    if (p.ls !== undefined) parts.push(`letter-spacing:${p.ls}em`);
    if (p.color && element.kind !== 'line') parts.push(`color:${p.color}`);
    if (p.align) parts.push(`text-align:${p.align}`);
    if (p.weight !== undefined) parts.push(`font-weight:${p.weight}`);
    if (p.italic !== undefined) parts.push(`font-style:${p.italic ? 'italic' : 'normal'}`);
    if (p.indent !== undefined) parts.push(`text-indent:${p.indent}em`);
    if (p.gap !== undefined) parts.push(`--qm-gap:${p.gap}em`);
    if (p.opacity !== undefined) parts.push(`opacity:${p.opacity}`);
    if (p.rotate) parts.push(`transform:rotate(${p.rotate}deg)`);
    if (element.kind === 'rect' || element.kind === 'ellipse' || element.kind === 'image') {
        if (p.fill) parts.push(`background:${p.fill === 'none' ? 'transparent' : p.fill}`);
        if (p.stroke) parts.push(`border-color:${p.stroke}`, 'border-style:' + (p.dash ? 'dashed' : 'solid'));
        else if (p.dash) parts.push('border-style:dashed');
        if (p.strokeWidth !== undefined) parts.push(`border-width:${p.strokeWidth}px`, `border-style:${p.dash ? 'dashed' : 'solid'}`);
        if (p.radius !== undefined && element.kind !== 'ellipse') parts.push(`border-radius:${p.radius}px`);
    }
    return parts.join(';');
}

// 图片按「铺满框」放，再按缩放与取景中心平移；取景不出框。
export function imageGeometry(frameW, frameH, image) {
    const base = Math.max(frameW / image.w, frameH / image.h), scale = base * (image.zoom || 1);
    const w = image.w * scale, h = image.h * scale;
    const left = Math.min(0, Math.max(frameW - w, frameW / 2 - image.cx * w));
    const top = Math.min(0, Math.max(frameH - h, frameH / 2 - image.cy * h));
    return {w, h, left, top};
}

const SVG_NS = 'http://www.w3.org/2000/svg';
function svg(document, tag, attrs) {
    const node = document.createElementNS(SVG_NS, tag);
    for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
    return node;
}

export function bodyParagraphs(body, start, end) {
    const text = body.slice(start, end);
    const cont = start > 0 && body[start - 1] !== '\n' && body[start - 1] !== PAGE_BREAK;
    return {paragraphs: text.split('\n'), cont};
}

export function fillParagraphs(document, box, paragraphs, cont) {
    box.replaceChildren(...paragraphs.map((text, index) => {
        const p = document.createElement('p');
        if (index === 0 && cont) p.className = 'qm-cont';
        if (text) p.textContent = text; else p.append(document.createElement('br'));
        return p;
    }));
}

export function buildElement(document, doc, page, element, layoutPage, ctx, z) {
    const {dy, dh} = shiftFor(page, element, layoutPage?.delta || 0);
    const node = document.createElement('div');
    const vertical = element.vertical ? ' qm-v' : '';
    const empty = element.kind === 'image' && !element.image ? ' qm-empty' : '';
    node.className = `qm-el qm-${element.kind}${vertical}${empty}${element.cls ? ` ${element.cls}` : ''}`;
    node.dataset.id = element.id;
    node.setAttribute('style', elementCss(element, {families: ctx.families, dy, dh, z}));
    if (element.kind === 'text') node.textContent = element.text;
    else if (element.kind === 'body') {
        const slice = layoutPage?.slices?.[element.id];
        if (slice) { const {paragraphs, cont} = bodyParagraphs(doc.body, slice.start, slice.end); if (slice.end > slice.start) fillParagraphs(document, node, paragraphs, cont); }
    } else if (element.kind === 'image') {
        if (element.image) {
            const src = ctx.imageSrc?.(element.image.id);
            if (src) {
                const img = document.createElement('img');
                const g = imageGeometry(element.w, element.h + dh, element.image);
                img.setAttribute('src', src); img.setAttribute('alt', '');
                img.setAttribute('style', `left:${g.left}px;top:${g.top}px;width:${g.w}px;height:${g.h}px`);
                node.append(img);
            }
        } else {
            const mark = svg(document, 'svg', {viewBox: `0 0 ${Math.max(1, element.w)} ${Math.max(1, element.h + dh)}`, preserveAspectRatio: 'none'});
            const stroke = {stroke: 'currentColor', 'stroke-width': 1.2, 'vector-effect': 'non-scaling-stroke'};
            mark.append(svg(document, 'line', {x1: 0, y1: 0, x2: element.w, y2: element.h + dh, ...stroke}), svg(document, 'line', {x1: element.w, y1: 0, x2: 0, y2: element.h + dh, ...stroke}));
            node.append(mark);
        }
    } else if (element.kind === 'line') {
        const p = element.props || {}, width = p.strokeWidth ?? 1.5;
        const w = Math.max(element.w, 0), h = Math.max(element.h, 0);
        const mark = svg(document, 'svg', {width: Math.max(1, w), height: Math.max(1, h)});
        const [y1, y2] = element.dir === -1 ? [h, 0] : [0, h];
        const attrs = {x1: 0, y1, x2: w, y2, stroke: p.stroke || 'currentColor', 'stroke-width': width, 'stroke-linecap': 'butt'};
        if (p.dash) attrs['stroke-dasharray'] = `${width * 4} ${width * 3}`;
        mark.append(svg(document, 'line', attrs));
        node.append(mark);
    }
    return node;
}

// 一页的节点树。ctx：families（字体库 id → 已注册的字体名）、imageSrc（图片 id → 地址）。
export function buildPage(document, doc, page, layoutPage, ctx = {}) {
    const height = layoutPage?.h || pageHeight(doc);
    const root = document.createElement('div');
    root.className = 'page';
    root.setAttribute('style', `--paper:${doc.paper};--ink:${doc.ink};height:${height}px`);
    if (doc.bg?.image) {
        const src = ctx.imageSrc?.(doc.bg.image);
        if (src) {
            const img = document.createElement('img');
            img.className = 'qm-bg'; img.setAttribute('src', src); img.setAttribute('alt', '');
            img.setAttribute('style', `opacity:${doc.bg.opacity ?? 1}`);
            root.append(img);
        }
    }
    if (page.decor) {
        const holder = document.createElement('template');
        holder.innerHTML = page.decor;
        root.append(holder.content);
    }
    page.elements.forEach((element, index) => root.append(buildElement(document, doc, page, element, layoutPage, ctx, index + 1)));
    return root;
}

// ── 测量与分页 ─────────────────────────────────────────────────────────────
const CLOSING = /[，。、；：！？）》」』〕】〉”’…—·,.;:!?)\]}%]/;
const OPENING = /[（《「『〔【〈“‘([{]/;
export function adjustBreak(body, start, count) {
    let end = start + count;
    if (end >= body.length || count <= 0) return count;
    const code = body.charCodeAt(end);
    if (code >= 0xdc00 && code <= 0xdfff) end--;
    for (let guard = 0; guard < 4 && end > start + 1 && CLOSING.test(body[end]); guard++) end--;
    for (let guard = 0; guard < 3 && end > start + 1 && OPENING.test(body[end - 1]); guard++) end--;
    if (/[A-Za-z0-9]/.test(body[end - 1] || '') && /[A-Za-z0-9]/.test(body[end] || '')) {
        const space = body.lastIndexOf(' ', end);
        if (space > start && end - space < 24) end = space + 1;
    }
    return Math.max(0, end - start);
}

export function createMeasurer(document, css) {
    const host = document.createElement('div');
    host.setAttribute('aria-hidden', 'true');
    host.style.cssText = 'position:fixed;left:-40000px;top:0;width:1080px;height:0;overflow:hidden;visibility:hidden;pointer-events:none;contain:layout style';
    const shadow = host.attachShadow({mode: 'open'});
    const style = document.createElement('style');
    style.textContent = `${BASE_CSS}\n${css || ''}`;
    const page = document.createElement('div');
    page.className = 'page'; page.style.height = '20000px';
    shadow.append(style, page);
    document.body.append(host);
    let box = null;
    return {
        prepare(doc, element, ctx, dh) {
            page.style.setProperty('--paper', doc.paper); page.style.setProperty('--ink', doc.ink);
            box?.remove();
            box = buildElement(document, doc, {elements: [element]}, element, {delta: 0, slices: {}}, ctx, 1);
            box.style.height = `${element.h + dh}px`; box.style.top = '0px';
            page.append(box);
            return box;
        },
        fits(vertical) {
            return vertical ? box.scrollWidth <= box.clientWidth + 1 : box.scrollHeight <= box.clientHeight + 1;
        },
        fill(paragraphs, cont) { fillParagraphs(document, box, paragraphs, cont); },
        naturalHeight() { box.style.height = 'auto'; const value = box.scrollHeight; return value; },
        dispose() { host.remove(); },
    };
}

function fitCount(measurer, doc, element, ctx, dh, start, limit) {
    const total = limit - start;
    if (total <= 0) return 0;
    measurer.prepare(doc, element, ctx, dh);
    const body = doc.body;
    const fits = count => {
        const {paragraphs, cont} = bodyParagraphs(body, start, start + count);
        measurer.fill(paragraphs, cont);
        return measurer.fits(element.vertical);
    };
    if (fits(total)) return total;
    let low = 0, high = total - 1;
    while (low < high) {
        const middle = Math.ceil((low + high) / 2);
        if (fits(middle)) low = middle; else high = middle - 1;
    }
    return adjustBreak(body, start, low);
}

function flowPage(measurer, doc, bodies, ctx, delta, pos, segmentEnd) {
    const slices = {};
    let cursor = pos;
    for (const element of bodies) {
        if (doc.body[cursor] === '\n' && cursor < segmentEnd) cursor++;
        const count = fitCount(measurer, doc, element, ctx, delta, cursor, segmentEnd);
        slices[element.id] = {start: cursor, end: cursor + count};
        cursor += count;
    }
    return {slices, cursor};
}

function solveDelta(measurer, doc, page, bodies, ctx, pos, segmentEnd, baseHeight) {
    const minHeight = Math.min(...bodies.map(element => element.h));
    const low = -Math.max(0, minHeight - 48), high = MAX_PAGE_HEIGHT - baseHeight;
    const reaches = delta => flowPage(measurer, doc, bodies, ctx, delta, pos, segmentEnd).cursor >= segmentEnd;
    if (segmentEnd <= pos || reaches(low)) return low;
    if (!reaches(high)) return high;
    let a = low, b = high;
    // 只有一个横排正文框时，先量自然高度，通常一两次就定。
    if (bodies.length === 1 && !bodies[0].vertical) {
        measurer.prepare(doc, bodies[0], ctx, 0);
        const start = doc.body[pos] === '\n' ? pos + 1 : pos;
        const {paragraphs, cont} = bodyParagraphs(doc.body, start, segmentEnd);
        measurer.fill(paragraphs, cont);
        const guess = Math.ceil(measurer.naturalHeight() - bodies[0].h) + 2;
        if (guess > a && guess < b) { if (reaches(guess)) b = guess; else a = guess; }
    }
    while (b - a > 4) {
        const middle = Math.floor((a + b) / 2);
        if (reaches(middle)) b = middle; else a = middle;
    }
    return b;
}

// 排整份稿：返回每页的高度、伸缩量与各正文框分到的正文区间；需要时在 doc.pages 末尾补续页、去掉排空的自动续页。
export function layoutDoc(doc, {measurer, ctx = {}, makePage}) {
    const body = doc.body, auto = doc.ratio === 'auto', baseHeight = pageHeight(doc);
    const pages = [];
    let pos = 0, stuck = false;
    for (let index = 0; ; index++) {
        if (index >= doc.pages.length) {
            if (pos >= body.length || doc.pages.length >= MAX_PAGES || typeof makePage !== 'function') break;
            const next = makePage();
            if (!next.elements.some(element => element.kind === 'body')) break;
            doc.pages.push(next);
        }
        const page = doc.pages[index];
        const bodies = page.elements.filter(element => element.kind === 'body').sort((a, b) => a.flow - b.flow);
        const breakAt = body.indexOf(PAGE_BREAK, pos);
        const segmentEnd = breakAt < 0 ? body.length : breakAt;
        const startedAt = pos;
        let delta = 0, slices = {};
        if (bodies.length) {
            if (auto) delta = solveDelta(measurer, doc, page, bodies, ctx, pos, segmentEnd, baseHeight);
            const flowed = flowPage(measurer, doc, bodies, ctx, delta, pos, segmentEnd);
            slices = flowed.slices; pos = flowed.cursor;
            if (pos >= segmentEnd && segmentEnd < body.length) pos = segmentEnd + 1;
            else if (pos === startedAt && pos < body.length) stuck = true;
        }
        pages.push({id: page.id, h: Math.max(120, baseHeight + delta), delta, slices, start: startedAt,
            breakBefore: startedAt > 0 && body[startedAt - 1] === PAGE_BREAK ? startedAt - 1 : -1});
        if (stuck) break;
    }
    // 去掉末尾没分到正文的自动续页。
    while (doc.pages.length > 1) {
        const last = doc.pages[doc.pages.length - 1], entry = pages.find(item => item.id === last.id);
        const empty = !entry || Object.values(entry.slices).every(slice => slice.end <= slice.start);
        if (!last.auto || !empty) break;
        doc.pages.pop();
        const at = pages.findIndex(item => item.id === last.id);
        if (at >= 0) pages.splice(at, 1);
    }
    return {pages, remaining: Math.max(0, body.length - pos), stuck};
}

// ── 导出 ───────────────────────────────────────────────────────────────────
export async function blobToDataUrl(blob) {
    if (typeof FileReader !== 'function') {
        const bytes = new Uint8Array(await blob.arrayBuffer());
        let binary = '';
        for (let at = 0; at < bytes.length; at += 8192) binary += String.fromCharCode(...bytes.subarray(at, at + 8192));
        return `data:${blob.type || 'application/octet-stream'};base64,${btoa(binary)}`;
    }
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(reader.error || new Error('读取失败'));
        reader.readAsDataURL(blob);
    });
}

function rangesIntersect(range, text) {
    if (!range) return true;
    const spans = range.split(',').map(item => item.trim().replace(/^U\+/i, '').split('-')).map(([a, b = a]) => [Number.parseInt(a.replace(/\?/g, '0'), 16), Number.parseInt(b.replace(/\?/g, 'f'), 16)]);
    for (const char of text) {
        const code = char.codePointAt(0);
        if (spans.some(([a, b]) => code >= a && code <= b)) return true;
    }
    return false;
}

// 字体库里的字体要内嵌进 SVG（SVG 图里读不到页面已注册的字体）；分片网络字体只带用得到的那几片。
export async function embedFonts(usage, {faces, fetch: fetcher = globalThis.fetch, signal}) {
    const families = new Map(), rules = [];
    let index = 0;
    for (const [id, text] of usage) {
        const list = await faces(id);
        if (!list?.length) continue;
        const family = `QmX${++index}`;
        let added = 0;
        for (const face of list) {
            if (!rangesIntersect(face.unicodeRange, text)) continue;
            try {
                const response = await fetcher(face.url, {signal, credentials: 'omit'});
                if (!response.ok) continue;
                const data = await blobToDataUrl(await response.blob());
                rules.push(`@font-face{font-family:"${family}";src:url("${data}");font-weight:${face.weight || 400};font-style:${face.style || 'normal'};${face.unicodeRange ? `unicode-range:${face.unicodeRange};` : ''}font-display:block}`);
                added++;
            } catch (error) { if (error?.name === 'AbortError') throw error; }
        }
        if (added) families.set(id, family);
    }
    return {families, css: rules.join('\n')};
}

const XHTML = 'http://www.w3.org/1999/xhtml';
export function pageSvg(document, pageNode, css, width, height) {
    const wrapper = document.createElementNS(XHTML, 'div');
    wrapper.setAttribute('style', `width:${width}px;height:${height}px;margin:0;padding:0`);
    const style = document.createElementNS(XHTML, 'style');
    style.textContent = css;
    wrapper.append(style, pageNode);
    const xml = new document.defaultView.XMLSerializer().serializeToString(wrapper);
    return `<svg xmlns="${SVG_NS}" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><foreignObject x="0" y="0" width="${width}" height="${height}">${xml}</foreignObject></svg>`;
}

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
export async function svgToPng(document, markup, width, height, signal) {
    const view = document.defaultView;
    const image = new view.Image();
    image.decoding = 'sync';
    image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(markup)}`;
    await image.decode();
    if (signal?.aborted) throw new DOMException('已停止', 'AbortError');
    const canvas = document.createElement('canvas');
    canvas.width = width; canvas.height = height;
    const context = canvas.getContext('2d');
    try {
        // SVG 里的内嵌字体在部分浏览器（Safari）第一次画时还没就绪：画一次、稍等、清掉再画。
        context.drawImage(image, 0, 0, width, height);
        await pause(120);
        context.clearRect(0, 0, width, height);
        context.drawImage(image, 0, 0, width, height);
        return await new Promise((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('图片生成失败')), 'image/png'));
    } finally { canvas.width = canvas.height = 0; }
}
