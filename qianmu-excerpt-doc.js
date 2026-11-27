// 书摘成图 · 稿件模型：一份稿 = 模板样式 + 若干页（每页一组可编辑元素）+ 一段正文（在各页正文框里依次流动）。
// 纯数据与校验，不碰 DOM。正文是收藏原文的副本，在这里怎么改都不回写收藏。
import {PAGE_WIDTH, ELEMENT_KINDS, BUILTIN_TEMPLATES, parseExcerptTemplate, resolveFields, hasFieldToken,
    sanitizeCss, sanitizeClass, sanitizeDecor, normalizeHex} from './qianmu-excerpt-template.js';

export {PAGE_WIDTH};
export const MAX_PAGE_HEIGHT = 15000;       // iOS 画布面积上限约 1678 万像素，1080 宽时留一点余量
export const MAX_PAGES = 60;
export const RATIOS = Object.freeze([
    Object.freeze({key: 'tpl', label: '原版'}),
    Object.freeze({key: 'auto', label: '自适应'}),
    Object.freeze({key: '1:1', label: '1:1'}),
    Object.freeze({key: '4:5', label: '4:5'}),
    Object.freeze({key: '3:4', label: '3:4'}),
    Object.freeze({key: '2:3', label: '2:3'}),
    Object.freeze({key: '9:16', label: '9:16'}),
]);
const RATIO_KEYS = new Set(RATIOS.map(ratio => ratio.key));
const KIND_SET = new Set(ELEMENT_KINDS);
export const PAGE_BREAK = '\f';

export function newId(prefix = 'e') {
    const random = globalThis.crypto?.randomUUID?.().replaceAll('-', '').slice(0, 12) || Math.random().toString(36).slice(2, 14);
    return `${prefix}_${random}`;
}

const clamp = (value, min, max, fallback) => {
    const number = Number(value);
    return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
};
const round = value => Math.round(value * 100) / 100;
const isRecord = value => !!value && typeof value === 'object' && !Array.isArray(value);
const shortString = (value, limit) => typeof value === 'string' ? value.slice(0, limit) : '';

// 页高：原版 = 模板设计高；自适应以模板设计高为基准，渲染时按正文伸缩；其余按宽 1080 换算。
export function pageHeight(doc) {
    const ratio = doc?.ratio;
    if (!ratio || ratio === 'tpl' || ratio === 'auto') return doc?.template?.height || 1440;
    const [a, b] = ratio.split(':').map(Number);
    return Math.round(PAGE_WIDTH * b / a);
}

// 正文副本：统一换行，空行并为段落分隔（段距由排版控制），保留分页符。
export function normalizeBody(text) {
    return String(text ?? '').replace(/\r\n?/g, '\n').replace(/[ \t]+\n/g, '\n').replace(/\n(?:[ \t]*\n)+/g, '\n')
        .replace(/\n?\f\n?/g, PAGE_BREAK).replace(/^\n+|\n+$/g, '').slice(0, 200_000);
}

const FONT_KEYS = new Set(['serif', 'sans', 'kai', 'mono']);
const ALIGNS = new Set(['left', 'center', 'right', 'justify']);
const WEIGHTS = new Set([300, 400, 500, 600, 700, 900]);
// 用户在成图页上改的样式。没写的项沿用模板的类样式。
export function normalizeProps(raw) {
    const props = {};
    if (!isRecord(raw)) return props;
    if (typeof raw.font === 'string' && (FONT_KEYS.has(raw.font) || /^[\w-]{1,120}$/.test(raw.font))) props.font = raw.font;
    const number = (key, min, max) => { if (raw[key] !== undefined && raw[key] !== null && Number.isFinite(Number(raw[key]))) props[key] = round(clamp(raw[key], min, max, min)); };
    number('size', 6, 400); number('lh', 0.6, 5); number('ls', -0.5, 3); number('indent', 0, 8); number('gap', 0, 6);
    number('opacity', 0, 1); number('strokeWidth', 0, 60); number('radius', 0, 540); number('rotate', -180, 180);
    for (const key of ['color', 'stroke', 'nameColor']) { const hex = normalizeHex(raw[key]); if (hex) props[key] = hex; }
    if (raw.fill === 'none') props.fill = 'none'; else { const hex = normalizeHex(raw.fill); if (hex) props.fill = hex; }
    if (ALIGNS.has(raw.align)) props.align = raw.align;
    if (WEIGHTS.has(Number(raw.weight))) props.weight = Number(raw.weight);
    if (typeof raw.italic === 'boolean') props.italic = raw.italic;
    if (typeof raw.dash === 'boolean') props.dash = raw.dash;
    return props;
}

function normalizeImage(raw) {
    if (!isRecord(raw) || typeof raw.id !== 'string' || !/^img_[\w-]{1,64}$/.test(raw.id)) return null;
    const w = clamp(raw.w, 1, 20000, 0), h = clamp(raw.h, 1, 20000, 0);
    if (!w || !h) return null;
    return {id: raw.id, w, h, cx: clamp(raw.cx, 0, 1, 0.5), cy: clamp(raw.cy, 0, 1, 0.5), zoom: round(clamp(raw.zoom, 1, 8, 1))};
}

// 书友对话的一句：who 是 user（你）或 friend（书友）；id 是伴读对话里那条消息的编号（用来在挑选时打勾）。
export function normalizeLines(raw) {
    return (Array.isArray(raw) ? raw : []).slice(0, 40).filter(isRecord).map(line => ({
        id: typeof line.id === 'string' ? line.id.slice(0, 64) : '', who: line.who === 'user' ? 'user' : 'friend',
        name: shortString(line.name, 40), text: shortString(line.text, 2000),
    })).filter(line => line.text.trim());
}

export function normalizeElement(raw, pageH = 1440) {
    if (!isRecord(raw) || !KIND_SET.has(raw.kind)) return null;
    const element = {
        id: typeof raw.id === 'string' && /^[\w-]{1,48}$/.test(raw.id) ? raw.id : newId(),
        kind: raw.kind,
        x: round(clamp(raw.x, -PAGE_WIDTH, PAGE_WIDTH * 2, 0)),
        y: round(clamp(raw.y, -pageH, MAX_PAGE_HEIGHT * 2, 0)),
        w: round(clamp(raw.w, 0, PAGE_WIDTH * 3, 100)),
        h: round(clamp(raw.h, 0, MAX_PAGE_HEIGHT * 2, 100)),
        cls: sanitizeClass(raw.cls),
        base: sanitizeCss(shortString(raw.base, 4000), 4000).replace(/[{}]/g, ''),
        props: normalizeProps(raw.props),
    };
    if (element.kind === 'text') {
        element.text = shortString(raw.text, 5000);
        element.src = typeof raw.src === 'string' ? raw.src.slice(0, 2000) : null;
        if (typeof raw.field === 'string' && /^[a-z]{1,32}$/.test(raw.field)) element.field = raw.field;
    }
    if (element.kind === 'text' || element.kind === 'body' || element.kind === 'dialog') element.vertical = raw.vertical === true;
    if (element.kind === 'dialog') { element.look = raw.look === 'bubble' ? 'bubble' : 'script'; element.lines = normalizeLines(raw.lines); }
    if (element.kind === 'body') element.flow = Math.round(clamp(raw.flow, 0, 999, 0));
    if (element.kind === 'line') element.dir = raw.dir === -1 ? -1 : 1;
    if (element.kind === 'image') element.image = normalizeImage(raw.image);
    if (element.kind !== 'line') { element.w = Math.max(element.w, 4); element.h = Math.max(element.h, 4); }
    return element;
}

function normalizeLayout(raw, pageH) {
    if (!isRecord(raw)) return null;
    const elements = (Array.isArray(raw.elements) ? raw.elements : []).slice(0, 300).map(item => normalizeElement(item, pageH)).filter(Boolean);
    const ids = new Set();
    for (const element of elements) { if (ids.has(element.id)) element.id = newId(); ids.add(element.id); }
    return {decor: sanitizeDecor(shortString(raw.decor, 200_000)), elements};
}

function normalizeTemplateInfo(raw) {
    if (!isRecord(raw)) return null;
    return {name: shortString(raw.name, 40) || '未命名模板', css: sanitizeCss(shortString(raw.css, 120_000)), height: Math.round(clamp(raw.height, 300, 20000, 1440))};
}

function normalizeBackground(raw) {
    const bg = isRecord(raw) ? raw : {};
    return {image: typeof bg.image === 'string' && /^img_[\w-]{1,64}$/.test(bg.image) ? bg.image : '', opacity: round(clamp(bg.opacity, 0, 1, 1)),
        w: clamp(bg.w, 0, 20000, 0), h: clamp(bg.h, 0, 20000, 0)};
}

// 从存储读回的稿件一律重新校验：任何一项坏了只丢那一项，整份坏了返回 null（照新稿开）。
export function normalizeDoc(raw) {
    if (!isRecord(raw) || raw.v !== 1) return null;
    const template = normalizeTemplateInfo(raw.template);
    if (!template) return null;
    const doc = {v: 1, templateId: shortString(raw.templateId, 80), template, ratio: RATIO_KEYS.has(raw.ratio) ? raw.ratio : 'tpl'};
    const height = pageHeight(doc);
    doc.paper = normalizeHex(raw.paper, '#ffffff');
    doc.ink = normalizeHex(raw.ink, '#222222');
    doc.bg = normalizeBackground(raw.bg);
    doc.pages = (Array.isArray(raw.pages) ? raw.pages : []).slice(0, MAX_PAGES).map(page => {
        const layout = normalizeLayout(page, height);
        return layout && {id: typeof page.id === 'string' && /^[\w-]{1,48}$/.test(page.id) ? page.id : newId('p'), kind: page.kind === 'rest' ? 'rest' : 'first', auto: page.auto === true, ...layout};
    }).filter(Boolean);
    if (!doc.pages.length) return null;
    doc.restLayout = normalizeLayout(raw.restLayout, height) || {decor: '', elements: []};
    doc.body = normalizeBody(raw.body).replace(/\f{2,}/g, PAGE_BREAK);
    doc.fields = isRecord(raw.fields) ? Object.fromEntries(Object.entries(raw.fields).filter(([key, value]) => /^[a-z]{1,16}$/.test(key) && typeof value === 'string').map(([key, value]) => [key, value.slice(0, 200)])) : {};
    return doc;
}

// 占位都没值时剩下的只有这些连接符，这样的文本框不出现。
const EMPTY_FIELD_MARKS = /[\s·｜|/、，,第层《》“”]/g;

// 模板里的一页 → 稿里的一页：给元素编号、填占位字段、按页高缩放纵向位置。
function instantiateLayout(layout, fields, scaleY, lines = []) {
    const elements = [];
    let flow = 0;
    for (const source of layout?.elements || []) {
        const element = normalizeElement({...source, id: newId(), y: source.y * scaleY, h: source.h * scaleY}, MAX_PAGE_HEIGHT);
        if (!element) continue;
        if (element.kind === 'text') {
            const src = typeof source.src === 'string' ? source.src : null;
            if (src !== null) {
                element.src = src;
                element.text = resolveFields(src, fields);
                // 占位全是空值（比如不在当前聊天、没有楼层号）时，这个文本框就不出现。
                if (hasFieldToken(src) && !element.text.replace(EMPTY_FIELD_MARKS, '')) continue;
            } else element.text = String(source.text ?? '');
        }
        if (element.kind === 'body') element.flow = flow++;
        if (element.kind === 'dialog') { element.lines = normalizeLines(lines); if (!element.lines.length) continue; }
        elements.push(element);
    }
    return {decor: layout?.decor || '', elements};
}

export function builtinTemplate(id) {
    const entry = BUILTIN_TEMPLATES.find(item => item.id === id);
    return entry ? parseExcerptTemplate(entry.source).template : null;
}

// 用模板起一份新稿。
export function createDoc({template, templateId, body, fields = {}, ratio = 'tpl', lines = []}) {
    const doc = {v: 1, templateId, template: {name: template.name, css: template.css, height: template.height}, ratio: RATIO_KEYS.has(ratio) ? ratio : 'tpl',
        paper: template.paper, ink: template.ink, bg: {image: '', opacity: 1, w: 0, h: 0}, body: normalizeBody(body), fields: {...fields}};
    const scale = pageHeight(doc) / template.height;
    doc.pages = [{id: newId('p'), kind: 'first', auto: false, ...instantiateLayout(template.first, fields, scale, lines)}];
    doc.restLayout = instantiateLayout(template.rest || template.first, fields, scale, lines);
    return doc;
}

// 方案 = 稿件去掉内容：保留模板样式、比例、纸色、背景、首页与续页的元素（文本框记占位原样，没改过的跟着新收藏换名字）。
function schemeLayout(page) {
    return {decor: page.decor, elements: page.elements.map(element => {
        const copy = structuredClone(element);
        if (copy.kind === 'text' && copy.src !== null) delete copy.text;
        if (copy.kind === 'dialog') copy.lines = [];   // 对话是内容，方案只记它的位置与样式
        return copy;
    })};
}
export function schemeFromDoc(doc) {
    const rest = doc.pages.find(page => page.kind === 'rest');
    return {v: 1, templateId: doc.templateId, template: structuredClone(doc.template), ratio: doc.ratio, paper: doc.paper, ink: doc.ink,
        bg: structuredClone(doc.bg), first: schemeLayout(doc.pages[0]), rest: schemeLayout(rest || doc.restLayout)};
}

export function normalizeScheme(raw) {
    if (!isRecord(raw) || raw.v !== 1) return null;
    const template = normalizeTemplateInfo(raw.template);
    if (!template) return null;
    const scheme = {v: 1, templateId: shortString(raw.templateId, 80), template, ratio: RATIO_KEYS.has(raw.ratio) ? raw.ratio : 'tpl'};
    const height = pageHeight(scheme);
    const keepSrc = layout => {
        // normalizeElement 会给缺 text 的文本框补空串；方案里要分清「跟字段走」与「写死的字」。
        const normalized = normalizeLayout(layout, height);
        if (!normalized) return null;
        normalized.elements.forEach((element, index) => {
            const source = layout.elements?.[index];
            if (element.kind === 'text' && typeof source?.src === 'string' && typeof source.text !== 'string') delete element.text;
        });
        return normalized;
    };
    scheme.first = keepSrc(raw.first);
    if (!scheme.first) return null;
    scheme.rest = keepSrc(raw.rest) || {decor: '', elements: []};
    scheme.paper = normalizeHex(raw.paper, '#ffffff');
    scheme.ink = normalizeHex(raw.ink, '#222222');
    scheme.bg = normalizeBackground(raw.bg);
    return scheme;
}

function layoutFromScheme(layout, fields, lines = []) {
    const elements = [];
    for (const source of layout.elements) {
        const element = {...structuredClone(source), id: newId()};
        if (element.kind === 'text') {
            if (typeof element.text !== 'string') {
                element.text = resolveFields(element.src || '', fields);
                if (hasFieldToken(element.src) && !element.text.replace(EMPTY_FIELD_MARKS, '')) continue;
            }
        }
        if (element.kind === 'dialog') { element.lines = normalizeLines(lines); if (!element.lines.length) continue; }
        elements.push(element);
    }
    return {decor: layout.decor, elements};
}

// 用方案（含「上次的设置」）起一份新稿。
export function createDocFromScheme(scheme, {body, fields = {}, lines = []}) {
    const doc = {v: 1, templateId: scheme.templateId, template: structuredClone(scheme.template), ratio: scheme.ratio, paper: scheme.paper, ink: scheme.ink,
        bg: structuredClone(scheme.bg), body: normalizeBody(body), fields: {...fields}};
    doc.pages = [{id: newId('p'), kind: 'first', auto: false, ...layoutFromScheme(scheme.first, fields, lines)}];
    doc.restLayout = layoutFromScheme(scheme.rest, fields, lines);
    return doc;
}

// 换比例：各页元素的纵向位置与高度按页高等比换算，字号不动。
export function setRatio(doc, ratio) {
    if (!RATIO_KEYS.has(ratio) || doc.ratio === ratio) return false;
    const before = pageHeight(doc);
    doc.ratio = ratio;
    const factor = pageHeight(doc) / before;
    if (factor !== 1) {
        for (const layout of [...doc.pages, doc.restLayout]) {
            for (const element of layout.elements) { element.y = round(element.y * factor); element.h = round(element.h * factor); }
        }
    }
    return true;
}

// 续页：沿用稿里最后一张续页（用户在续页上的改动跟着走），没有就用模板的续页版式。
export function makeContinuationPage(doc) {
    const last = [...doc.pages].reverse().find(page => page.kind === 'rest');
    const source = last || doc.restLayout;
    const page = {id: newId('p'), kind: 'rest', auto: true, decor: source.decor, elements: source.elements.map(element => ({...structuredClone(element), id: newId()}))};
    return page;
}

export function cloneDoc(doc) { return structuredClone(doc); }

// ── 设置里的书摘成图资料（随账户）：上次的版式按入口分开（正文收藏 last／伴读 lastReader），方案与自建模板共用 ──
export const SCHEME_LIMIT = 50, TEMPLATE_LIMIT = 30;
export function normalizeStudioSettings(raw) {
    const value = isRecord(raw) ? raw : {};
    const last = normalizeScheme(value.last), lastReader = normalizeScheme(value.lastReader);
    const schemes = (Array.isArray(value.schemes) ? value.schemes : []).slice(0, SCHEME_LIMIT).map(item => {
        const scheme = isRecord(item) && normalizeScheme(item.scheme);
        return scheme && {id: typeof item.id === 'string' && /^[\w-]{1,48}$/.test(item.id) ? item.id : newId('s'), name: shortString(item.name, 40).trim() || '未命名方案', scheme};
    }).filter(Boolean);
    const templates = (Array.isArray(value.templates) ? value.templates : []).slice(0, TEMPLATE_LIMIT).map(item => {
        if (!isRecord(item) || typeof item.source !== 'string' || !parseExcerptTemplate(item.source).ok) return null;
        return {id: typeof item.id === 'string' && /^[\w-]{1,48}$/.test(item.id) ? item.id : newId('t'), source: item.source.slice(0, 200_000), updatedAt: Number(item.updatedAt) || 0};
    }).filter(Boolean);
    return {last, lastReader, schemes, templates};
}
