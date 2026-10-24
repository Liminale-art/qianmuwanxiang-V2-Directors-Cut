/** Only validated font faces reach the runtime. Short original inputs remain inert edit metadata. */
export const FONT_SOURCE_LIMITS = Object.freeze({
    // Font binaries intentionally have no product-defined size ceiling. The
    // browser, IndexedDB quota, and deployment transport may still reject an
    // allocation that the current environment cannot hold.
    fontBytes: Number.POSITIVE_INFINITY,
    // Legacy whole-string JSON/base64 packs only; ZIP and local uploads do not
    // use this aggregate limit. Retain it to safely read old user archives.
    totalLocalBytes: 96 * 1024 * 1024,
    cssBytes: 1024 * 1024,
    totalCssBytes: 2 * 1024 * 1024,
    cssSources: 12,
    importDepth: 3,
    // Raw declarations are bounded before deduplication; a stored family is
    // bounded separately so normal CJK subsets do not hit the parser budget.
    sourceDeclarations: 8192,
    faces: 2048,
    totalFaces: 8192,
    records: 200,
    packBytes: 132 * 1024 * 1024, // Legacy JSON parser only.
    previewLength: 500,
});

const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const FORMATS = new Set(['woff', 'woff2', 'truetype', 'opentype']);
const textEncoder = new TextEncoder();
const fail = (message) => { throw new Error(message); };
const object = (value) => value && typeof value === 'object' && !Array.isArray(value);

function boundedText(value, max, label, fallback = '') {
    if (value === undefined || value === null) return fallback;
    if (typeof value !== 'string' || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(value)) {
        fail(`${label}格式不正确或过长`);
    }
    return value.trim();
}

function safeId(value) {
    const id = boundedText(value, 96, '字体标识');
    if (!/^[a-zA-Z0-9_-]+$/u.test(id) || UNSAFE_KEYS.has(id)) fail('字体标识不正确');
    return id;
}

export function normalizeFontUrl(value, baseUrl) {
    const input = boundedText(value, 8192, '字体网址');
    if (!input) fail('字体网址不能为空');
    let parsed;
    try { parsed = new URL(input, baseUrl || undefined); } catch { fail('请填写有效的 HTTP 或 HTTPS 字体网址'); }
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
        fail('字体网址仅支持不含账号密码的 HTTP 或 HTTPS 地址');
    }
    if (parsed.href.length > 8192) fail('字体网址过长');
    return parsed.href;
}

function cssUnquote(value) {
    const trimmed = value.trim();
    const inner = /^(["']).*\1$/su.test(trimmed) ? trimmed.slice(1, -1) : trimmed;
    return inner.replace(/\\([0-9a-f]{1,6})\s?|\\([^\r\n])/giu, (_, hex, char) => {
        if (!hex) return char;
        const code = Number.parseInt(hex, 16);
        return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '\ufffd';
    });
}

function stripComments(css) {
    let result = '', quote = '';
    for (let i = 0; i < css.length; i += 1) {
        const char = css[i];
        if (quote) {
            result += char;
            if (char === '\\') result += css[++i] || '';
            else if (char === quote) quote = '';
        } else if (char === '"' || char === "'") { quote = char; result += char; }
        else if (char === '/' && css[i + 1] === '*') {
            const end = css.indexOf('*/', i + 2);
            if (end < 0) fail('字体样式包含未结束的注释');
            result += ' '; i = end + 1;
        } else result += char;
    }
    if (quote) fail('字体样式包含未结束的引号');
    return result;
}

function splitCss(value, separator) {
    const items = [];
    let start = 0, quote = '', depth = 0;
    for (let i = 0; i < value.length; i += 1) {
        const char = value[i];
        if (quote) {
            if (char === '\\') i += 1;
            else if (char === quote) quote = '';
        } else if (char === '"' || char === "'") quote = char;
        else if (char === '(' || char === '[') depth += 1;
        else if (char === ')' || char === ']') depth -= 1;
        else if (char === separator && depth === 0) { items.push(value.slice(start, i)); start = i + 1; }
    }
    items.push(value.slice(start));
    return items;
}

function fontWeight(value = '400') {
    const weight = boundedText(value, 32, '字体粗细').toLowerCase().replace(/\s+/gu, ' ');
    if (weight === 'normal') return '400';
    if (weight === 'bold') return '700';
    const numbers = weight.split(' ').map(Number);
    if (!/^\d{1,4}(?: \d{1,4})?$/u.test(weight) || numbers.some((n) => n < 1 || n > 1000)
        || (numbers.length === 2 && numbers[0] > numbers[1])) fail('字体粗细声明不正确');
    return weight;
}

function fontStyle(value = 'normal') {
    const style = boundedText(value, 64, '字体风格').toLowerCase().replace(/\s+/gu, ' ');
    if (!/^(?:normal|italic|oblique(?: -?\d{1,2}(?:\.\d+)?deg){0,2})$/u.test(style)) fail('字体风格声明不正确');
    const angles = [...style.matchAll(/(-?\d+(?:\.\d+)?)deg/gu)].map((m) => Number(m[1]));
    if (angles.some((n) => n < -90 || n > 90) || (angles.length === 2 && angles[0] > angles[1])) fail('字体倾斜角度不正确');
    return style;
}

function fontStretch(value) {
    const stretch = boundedText(value, 64, '字体宽度').toLowerCase().replace(/\s+/gu, ' ');
    if (/^(?:normal|ultra-condensed|extra-condensed|condensed|semi-condensed|semi-expanded|expanded|extra-expanded|ultra-expanded)$/u.test(stretch)) return stretch;
    if (!/^\d{1,3}(?:\.\d+)?%(?: \d{1,3}(?:\.\d+)?%)?$/u.test(stretch)) fail('字体宽度声明不正确');
    const numbers = stretch.split(' ').map(Number.parseFloat);
    if (numbers.some((n) => n <= 0) || (numbers.length === 2 && numbers[0] > numbers[1])) fail('字体宽度声明不正确');
    return stretch;
}

function unicodeRange(value) {
    const range = boundedText(value, 16384, '字体字符范围');
    const parts = range.split(',').map((item) => item.trim());
    if (!parts.length || parts.some((part) => !/^U\+(?:[0-9a-f]{1,6}(?:-[0-9a-f]{1,6})?|[0-9a-f]{0,5}\?{1,6})$/iu.test(part))) {
        fail('字体字符范围不正确');
    }
    for (const part of parts) {
        const [start, end = start] = part.slice(2).split('-');
        if (Number.parseInt(start.replace(/\?/gu, '0'), 16) > Number.parseInt(end.replace(/\?/gu, 'f'), 16)
            || Number.parseInt(end.replace(/\?/gu, 'f'), 16) > 0x10ffff) fail('字体字符范围不正确');
    }
    return parts.join(', ');
}

function formatName(value) {
    const format = cssUnquote(String(value)).toLowerCase().replace(/-variations$/u, '');
    return FORMATS.has(format) ? format : undefined;
}

function parseFontFace(body, baseUrl) {
    const descriptors = Object.create(null);
    for (const declaration of splitCss(body, ';')) {
        const colon = declaration.indexOf(':');
        if (colon < 0) continue;
        const key = declaration.slice(0, colon).trim().toLowerCase();
        if (['font-family', 'src', 'font-weight', 'font-style', 'font-stretch', 'unicode-range'].includes(key)) {
            descriptors[key] = declaration.slice(colon + 1).trim();
        }
    }
    if (!descriptors['font-family'] || !descriptors.src) return null;
    const name = boundedText(cssUnquote(descriptors['font-family']), 160, '字体名称');
    if (!name) fail('字体样式缺少字体名称');
    const urls = [];
    for (const source of splitCss(descriptors.src, ',')) {
        const urlMatch = source.match(/^\s*url\(\s*((?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^)"']+))\s*\)/iu);
        if (!urlMatch) continue; // local() cannot be portable; never evaluate arbitrary CSS.
        const format = source.slice(urlMatch[0].length).match(/^\s*format\(\s*([^)]*)\)/iu);
        const entry = { url: normalizeFontUrl(cssUnquote(urlMatch[1]), baseUrl) };
        const normalized = format && formatName(format[1]);
        if (normalized) entry.format = normalized;
        urls.push(entry);
        if (urls.length > 8) fail('同一字体分片的备用链接过多');
    }
    if (!urls.length) return null;
    const face = { urls, weight: fontWeight(descriptors['font-weight']), style: fontStyle(descriptors['font-style']) };
    if (descriptors['font-stretch']) face.stretch = fontStretch(descriptors['font-stretch']);
    if (descriptors['unicode-range']) face.unicodeRange = unicodeRange(descriptors['unicode-range']);
    return { name, face };
}

/** Extract only font declarations and imports. Ordinary CSS is never returned or installed. */
export function parseFontStylesheet(css, { baseUrl } = {}) {
    if (typeof css !== 'string' || textEncoder.encode(css).byteLength > FONT_SOURCE_LIMITS.cssBytes) fail('字体样式过大');
    const source = stripComments(css);
    const faces = [], imports = [];
    function scan(text, nesting = 0) {
        if (nesting > 8) fail('字体样式嵌套过深');
        let start = 0, quote = '', parentheses = 0;
        for (let i = 0; i < text.length; i += 1) {
            const char = text[i];
            if (quote) {
                if (char === '\\') i += 1;
                else if (char === quote) quote = '';
                continue;
            }
            if (char === '"' || char === "'") { quote = char; continue; }
            if (char === '(') { parentheses += 1; continue; }
            if (char === ')') { parentheses -= 1; continue; }
            if (parentheses) continue;
            if (char === ';') {
                const header = text.slice(start, i).trim();
                const match = header.match(/^@import\s+(?:url\(\s*((?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^)"']+))\s*\)|("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'))/iu);
                if (match) imports.push(normalizeFontUrl(cssUnquote(match[1] || match[2]), baseUrl));
                start = i + 1;
            } else if (char === '{') {
                const header = text.slice(start, i).trim();
                let end = i + 1, depth = 1, innerQuote = '';
                for (; end < text.length && depth; end += 1) {
                    const current = text[end];
                    if (innerQuote) {
                        if (current === '\\') end += 1;
                        else if (current === innerQuote) innerQuote = '';
                    } else if (current === '"' || current === "'") innerQuote = current;
                    else if (current === '{') depth += 1;
                    else if (current === '}') depth -= 1;
                }
                if (depth) fail('字体样式包含未结束的声明');
                const body = text.slice(i + 1, end - 1);
                if (/^@font-face$/iu.test(header)) {
                    const face = parseFontFace(body, baseUrl);
                    if (face) faces.push(face);
                    if (faces.length > FONT_SOURCE_LIMITS.sourceDeclarations) fail('字体来源声明过多');
                } else if (/^@(media|supports|layer)\b/iu.test(header)) scan(body, nesting + 1);
                i = end - 1; start = end;
            }
        }
    }
    scan(source);
    return { faces, imports };
}

function htmlDecode(value) {
    return value.replace(/&amp;/giu, '&').replace(/&quot;/giu, '"').replace(/&#39;|&apos;/giu, "'")
        .replace(/&lt;/giu, '<').replace(/&gt;/giu, '>');
}

function inputSource(input, baseUrl) {
    const value = boundedText(input, FONT_SOURCE_LIMITS.cssBytes, '字体来源');
    if (!value) fail('链接不可为空');
    // Use the existing bounded metadata field, not the expanded remote CSS.
    // Long pasted styles still retain every parsed face; no origin is guessed.
    const remembered = value.length <= 8192 ? value : '内嵌字体样式';
    if (/^(?:https?:\/\/|\/\/)/iu.test(value) && !/[\r\n<>]/u.test(value)) {
        return { url: normalizeFontUrl(value, baseUrl), input: value };
    }
    if (/^\s*</u.test(value)) {
        const styles = [...value.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style\s*>/giu)].map((m) => m[1]);
        const imports = [];
        for (const link of value.matchAll(/<link\b[^>]*>/giu)) {
            const attributes = Object.create(null);
            for (const attr of link[0].matchAll(/([\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gu)) attributes[attr[1].toLowerCase()] = htmlDecode(attr[2] ?? attr[3] ?? attr[4]);
            if (attributes.href && /(?:^|\s)stylesheet(?:\s|$)/iu.test(attributes.rel || '')) imports.push(normalizeFontUrl(attributes.href, baseUrl));
        }
        if (!styles.length && !imports.length) fail('请提供字体文件链接、字体样式或 stylesheet 引用');
        return { css: styles.join('\n'), imports, input: !styles.length && imports.length === 1 ? imports[0] : remembered };
    }
    return { css: value, input: remembered };
}

function checkAbort(signal) {
    if (signal?.aborted) throw new DOMException('字体来源读取已取消', 'AbortError');
}

async function readCssResponse(response, signal) {
    checkAbort(signal);
    const declared = Number(response.headers?.get?.('content-length'));
    if (declared > FONT_SOURCE_LIMITS.cssBytes) fail('字体样式过大');
    if (response.body?.getReader) {
        const reader = response.body.getReader();
        const cancel = () => { void reader.cancel().catch(() => {}); };
        signal?.addEventListener('abort', cancel, { once: true });
        const decoder = new TextDecoder();
        let bytes = 0, text = '';
        try {
            for (;;) {
                const result = await reader.read();
                checkAbort(signal);
                if (result.done) break;
                bytes += result.value.byteLength;
                if (bytes > FONT_SOURCE_LIMITS.cssBytes) { await reader.cancel(); fail('字体样式过大'); }
                text += decoder.decode(result.value, { stream: true });
            }
            return text + decoder.decode();
        } finally { signal?.removeEventListener('abort', cancel); reader.releaseLock(); }
    }
    const text = await response.text();
    checkAbort(signal);
    if (textEncoder.encode(text).byteLength > FONT_SOURCE_LIMITS.cssBytes) fail('字体样式过大');
    return text;
}

function directFontFormat(url) {
    const extension = new URL(url).pathname.match(/\.(woff2?|ttf|otf)$/iu)?.[1]?.toLowerCase();
    return ({ woff: 'woff', woff2: 'woff2', ttf: 'truetype', otf: 'opentype' })[extension];
}

function urlFontName(url) {
    const file = new URL(url).pathname.split('/').pop();
    let name = file || '网络字体';
    try { name = decodeURIComponent(name); } catch { /* Retain the visible encoded file name. */ }
    return name.replace(/\.(woff2?|ttf|otf)$/iu, '').slice(0, 160) || '网络字体';
}

/** Resolve public web-font URLs/CSS without credentials, page CSS or a proxy. */
async function resolveWebFontSourceInternal(input, { fetchImpl = globalThis.fetch, baseUrl, signal, name } = {}) {
    checkAbort(signal);
    const source = inputSource(input, baseUrl);
    if (source.url && directFontFormat(source.url)) {
        return [{ name: boundedText(name, 160, '字体名称') || urlFontName(source.url), source: { kind: 'web', input: source.input, url: source.url },
            faces: [{ urls: [{ url: source.url, format: directFontFormat(source.url) }], weight: '400', style: 'normal' }] }];
    }
    const visited = new Set(), found = [];
    let totalBytes = 0;
    function appendDeclarations(faces) {
        if (found.length + faces.length > FONT_SOURCE_LIMITS.sourceDeclarations) fail('字体来源声明过多');
        found.push(...faces);
    }
    async function parse(css, currentBase, depth) {
        checkAbort(signal);
        totalBytes += textEncoder.encode(css).byteLength;
        if (totalBytes > FONT_SOURCE_LIMITS.totalCssBytes) fail('字体样式总量过大');
        const parsed = parseFontStylesheet(css, { baseUrl: currentBase });
        appendDeclarations(parsed.faces);
        for (const url of parsed.imports) await load(url, depth + 1);
    }
    async function load(url, depth) {
        checkAbort(signal);
        if (visited.has(url)) return;
        if (depth > FONT_SOURCE_LIMITS.importDepth) fail('字体样式引用层级过深');
        if (visited.size >= FONT_SOURCE_LIMITS.cssSources) fail('字体样式引用过多');
        visited.add(url);
        if (typeof fetchImpl !== 'function') fail('当前环境无法读取网络字体样式');
        let response;
        try { response = await fetchImpl(url, { credentials: 'omit', referrerPolicy: 'no-referrer', signal }); }
        catch (error) {
            if (signal?.aborted || error?.name === 'AbortError') throw error;
            fail('字体样式读取失败，请检查网址、网络或跨域权限');
        }
        if (!response?.ok) fail(`字体样式读取失败${response?.status ? `（${response.status}）` : ''}`);
        checkAbort(signal);
        const currentBase = response.url ? normalizeFontUrl(response.url) : url;
        const type = response.headers?.get?.('content-type') || '';
        if (/^(?:font\/|application\/(?:font-|x-font-|vnd\.ms-opentype))/iu.test(type)) {
            appendDeclarations([{ name: boundedText(name, 160, '字体名称') || urlFontName(currentBase), face: { urls: [{ url: currentBase }], weight: '400', style: 'normal' } }]);
        } else await parse(await readCssResponse(response, signal), currentBase, depth);
    }
    if (source.url) await load(source.url, 0);
    else {
        await parse(source.css || '', baseUrl, 0);
        for (const url of source.imports || []) await load(url, 0);
    }
    const grouped = new Map();
    for (const { name: family, face } of found) {
        const key = family.toLowerCase();
        if (!grouped.has(key)) grouped.set(key, { record: { name: family, source: { kind: 'web', input: source.input, ...(source.url ? { url: source.url } : {}) }, faces: [] }, signatures: new Set() });
        const group = grouped.get(key), signature = JSON.stringify(face);
        if (group.signatures.has(signature)) continue;
        group.signatures.add(signature); group.record.faces.push(face);
        if (group.record.faces.length > FONT_SOURCE_LIMITS.faces) fail('单款字体分片过多');
    }
    if (!grouped.size) fail('未找到可用的网络字体声明；请确认链接允许跨域读取且包含 @font-face');
    if (grouped.size > FONT_SOURCE_LIMITS.records) fail('一次引入的字体种类过多');
    const records = [...grouped.values()].map(group => group.record);
    if (name && records.length === 1) records[0].name = boundedText(name, 160, '字体名称') || records[0].name;
    return records;
}

/** A timeout covers imports AND response bodies, including fetches that ignore cancellation. */
export async function resolveWebFontSource(input, { signal, timeoutMs = 12000, ...options } = {}) {
    checkAbort(signal);
    const controller = new AbortController();
    let timer, cancel;
    const interrupted = new Promise((_, reject) => {
        cancel = () => { reject(new DOMException('字体来源读取已取消', 'AbortError')); controller.abort(); };
        signal?.addEventListener('abort', cancel, { once: true });
        timer = setTimeout(() => { reject(new Error('字体样式读取超时，请检查网址或网络')); controller.abort(); },
            Math.max(1, Math.min(Number(timeoutMs) || 12000, 60000)));
    });
    try { return await Promise.race([resolveWebFontSourceInternal(input, { ...options, signal: controller.signal }), interrupted]); }
    finally { clearTimeout(timer); signal?.removeEventListener('abort', cancel); }
}

function fontBytes(value) {
    if (value instanceof Uint8Array) return value;
    if (value instanceof ArrayBuffer) return new Uint8Array(value);
    fail('字体文件数据不正确');
}

/** Header/table bounds are checked here; the browser still validates the actual font on load. */
export function validateLocalFontBytes(value) {
    const bytes = fontBytes(value);
    return validateLocalFontHeader(bytes, bytes.byteLength);
}

/** Also accepts a bounded header + complete table directory read from an immutable font Blob. */
export function validateLocalFontHeader(value, byteLength) {
    const bytes = fontBytes(value);
    if (!Number.isSafeInteger(byteLength) || byteLength < bytes.byteLength) fail('字体文件大小不正确');
    if (bytes.byteLength < 12) fail('字体文件不完整');
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const signature = String.fromCharCode(...bytes.subarray(0, 4));
    let format;
    if (signature === 'wOFF' || signature === 'wOF2') {
        format = signature === 'wOFF' ? 'woff' : 'woff2';
        const minimum = format === 'woff' ? 44 : 48;
        if (bytes.length < minimum || view.getUint32(8) !== byteLength || !view.getUint16(12) || view.getUint16(14) !== 0) fail('字体文件头不完整');
        if (format === 'woff') {
            const count = view.getUint16(12);
            if (44 + count * 20 > bytes.length) fail('字体文件表不完整');
            for (let i = 0; i < count; i += 1) {
                const offset = 44 + i * 20;
                if (view.getUint32(offset + 4) + view.getUint32(offset + 8) > byteLength) fail('字体文件表超出边界');
            }
        }
    } else if (signature === 'OTTO' || signature === 'true' || view.getUint32(0) === 0x00010000) {
        format = signature === 'OTTO' ? 'opentype' : 'truetype';
        const count = view.getUint16(4);
        if (!count || 12 + count * 16 > bytes.length) fail('字体文件表不完整');
        for (let i = 0; i < count; i += 1) {
            const offset = 12 + i * 16;
            if (view.getUint32(offset + 8) + view.getUint32(offset + 12) > byteLength) fail('字体文件表超出边界');
        }
    } else fail('仅支持 WOFF、WOFF2、TTF 和 OTF 字体文件');
    return { format, byteLength };
}

/** Read only bounded SFNT metadata. Compressed WOFF/WOFF2 stays unspecified, not guessed. */
function localFontDescriptors(bytes, format) {
    const descriptor = { weight: '400', style: 'normal', known: false };
    if (!['truetype', 'opentype'].includes(format)) return descriptor;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const tables = new Map();
    for (let index = 0; index < view.getUint16(4); index += 1) {
        const position = 12 + index * 16;
        const tag = String.fromCharCode(...bytes.subarray(position, position + 4));
        if (['OS/2', 'head', 'fvar'].includes(tag)) tables.set(tag, { offset: view.getUint32(position + 8), length: view.getUint32(position + 12) });
    }
    const head = tables.get('head');
    if (head?.length >= 46) {
        descriptor.known = true;
        const style = view.getUint16(head.offset + 44);
        if (style & 1) descriptor.weight = '700';
        if (style & 2) descriptor.style = 'italic';
    }
    const os2 = tables.get('OS/2');
    if (os2?.length >= 6) {
        const weight = view.getUint16(os2.offset + 4);
        if (weight >= 1 && weight <= 1000) { descriptor.weight = String(weight); descriptor.known = true; }
        if (os2.length >= 64) {
            const selection = view.getUint16(os2.offset + 62);
            if (selection & 1) descriptor.style = 'italic';
            else if (selection & 512) descriptor.style = 'oblique';
        }
    }
    const fvar = tables.get('fvar');
    if (fvar?.length >= 16) {
        const axesOffset = view.getUint16(fvar.offset + 4), count = view.getUint16(fvar.offset + 8), size = view.getUint16(fvar.offset + 10);
        if (count <= 64 && size >= 20 && axesOffset >= 16 && axesOffset + size * count <= fvar.length) {
            for (let index = 0; index < count; index += 1) {
                const position = fvar.offset + axesOffset + index * size;
                const tag = String.fromCharCode(...bytes.subarray(position, position + 4));
                if (tag !== 'wght') continue;
                const low = view.getInt32(position + 4) / 65536, high = view.getInt32(position + 12) / 65536;
                if (Number.isInteger(low) && Number.isInteger(high) && low >= 1 && high <= 1000 && low <= high) {
                    descriptor.weight = low === high ? String(low) : `${low} ${high}`;
                    descriptor.known = true;
                }
            }
        }
    }
    return descriptor;
}

export async function createLocalFontRecord(file, { name } = {}) {
    if (!file || typeof file.arrayBuffer !== 'function' || !Number.isFinite(file.size)) fail('请选择有效的字体文件');
    const bytes = new Uint8Array(await file.arrayBuffer());
    const { format } = validateLocalFontBytes(bytes);
    const { known, ...descriptors } = localFontDescriptors(bytes, format);
    const fileName = boundedText(file.name || '本地字体', 240, '文件名');
    return { record: { name: boundedText(name, 160, '字体名称') || fileName.replace(/\.(woff2?|ttf|otf)$/iu, '').slice(0, 160),
        source: { kind: 'local', fileName, format, variantKnown: known }, faces: [{ urls: [], ...descriptors }] }, bytes };
}

function assertPlainTree(value, depth = 0) {
    if (depth > 12) fail('字体资料嵌套过深');
    if (!value || typeof value !== 'object') return;
    for (const key of Object.keys(value)) {
        if (UNSAFE_KEYS.has(key)) fail('字体资料包含不安全的字段');
        assertPlainTree(value[key], depth + 1);
    }
}

export function validateFontRecord(value) {
    if (!object(value)) fail('字体资料格式不正确');
    assertPlainTree(value);
    const name = boundedText(value.name, 160, '字体名称');
    if (!name || !object(value.source) || !['web', 'local', 'builtin'].includes(value.source.kind)) fail('字体资料缺少名称或来源');
    const local = value.source.kind === 'local', builtin = value.source.kind === 'builtin';
    const source = local
        ? { kind: 'local', fileName: boundedText(value.source.fileName, 240, '文件名'), format: formatName(value.source.format) }
        : builtin
            ? { kind: 'builtin', key: safeId(value.source.key), ...(value.source.format ? { format: formatName(value.source.format) || fail('内置字体文件格式不正确') } : {}) }
            : { kind: 'web', input: boundedText(value.source.input, 8192, '字体来源') };
    if (local && (!source.fileName || !source.format)) fail('本地字体来源不完整');
    if (local && typeof value.source.variantKnown === 'boolean') source.variantKnown = value.source.variantKnown;
    if (builtin && typeof value.source.variantKnown === 'boolean') source.variantKnown = value.source.variantKnown;
    if (!local && !builtin && value.source.url) source.url = normalizeFontUrl(value.source.url);
    if (!Array.isArray(value.faces) || !value.faces.length || value.faces.length > FONT_SOURCE_LIMITS.faces || ((local || builtin) && value.faces.length !== 1)) fail('字体分片数量不正确');
    const faces = value.faces.map((item) => {
        if (!object(item) || !Array.isArray(item.urls) || item.urls.length > 8 || (!local && !builtin && !item.urls.length) || ((local || builtin) && item.urls.length)) fail('字体文件链接不正确');
        const face = { urls: item.urls.map((entry) => {
            if (!object(entry)) fail('字体文件链接不正确');
            const url = { url: normalizeFontUrl(entry.url) };
            if (entry.format) {
                const format = formatName(entry.format);
                if (!format) fail('字体文件格式不正确');
                url.format = format;
            }
            return url;
        }), weight: fontWeight(item.weight), style: fontStyle(item.style) };
        if (item.unicodeRange) face.unicodeRange = unicodeRange(item.unicodeRange);
        if (item.stretch) face.stretch = fontStretch(item.stretch);
        return face;
    });
    const result = { name, source, faces };
    if (value.id !== undefined) result.id = safeId(value.id);
    if (value.folder !== undefined) result.folder = boundedText(value.folder, 80, '文件夹');
    if (value.tags !== undefined) {
        if (!Array.isArray(value.tags) || value.tags.length > 32) fail('字体标签过多');
        result.tags = [...new Set(value.tags.map((tag) => boundedText(tag, 80, '标签')).filter(Boolean))];
    }
    return result;
}

function encodeBase64(bytes) {
    let binary = '';
    for (let start = 0; start < bytes.length; start += 32768) binary += String.fromCharCode(...bytes.subarray(start, start + 32768));
    return btoa(binary);
}

function decodeBase64(value) {
    if (typeof value !== 'string' || value.length > Math.ceil(FONT_SOURCE_LIMITS.fontBytes / 3) * 4
        || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(value)) fail('字体文件编码不正确或过大');
    let binary;
    try { binary = atob(value); } catch { fail('字体文件编码不正确'); }
    return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

export function validateFontPackMetadata(records, { previewText = '', folders = [] } = {}) {
    if (!Array.isArray(records) || records.length > FONT_SOURCE_LIMITS.records) fail('字体数量超过上限');
    const clean = records.map(validateFontRecord);
    const ids = new Set();
    let faces = 0;
    for (const record of clean) {
        if (!record.id || ids.has(record.id)) fail('字体标识缺失或重复');
        ids.add(record.id); faces += record.faces.length;
    }
    if (faces > FONT_SOURCE_LIMITS.totalFaces) fail('字体包分片总量过多，请分批导出后再使用');
    if (!Array.isArray(folders) || folders.length > 200) fail('字体文件夹过多');
    return { records: clean, previewText: boundedText(previewText, FONT_SOURCE_LIMITS.previewLength, '预览文案'),
        folders: [...new Set(folders.map((folder) => boundedText(folder, 80, '文件夹')).filter(Boolean))] };
}

export function exportFontPack(records, { localFiles = {}, previewText = '', folders = [] } = {}) {
    const metadata = validateFontPackMetadata(records, { previewText, folders });
    const binaries = Object.create(null);
    let total = 0;
    for (const record of metadata.records.filter((item) => item.source.kind === 'local')) {
        const bytes = fontBytes(localFiles instanceof Map ? localFiles.get(record.id) : localFiles[record.id]);
        const { format } = validateLocalFontBytes(bytes);
        if (format !== record.source.format) fail('本地字体文件与资料不匹配');
        total += bytes.byteLength;
        if (total > FONT_SOURCE_LIMITS.totalLocalBytes) fail('所选本地字体超过 96 MB，请分批导出');
        binaries[record.id] = encodeBase64(bytes);
    }
    const text = JSON.stringify({ type: 'qianmu-font-library', version: 1, fonts: metadata.records, localFiles: binaries,
        previewText: metadata.previewText, folders: metadata.folders });
    if (textEncoder.encode(text).byteLength > FONT_SOURCE_LIMITS.packBytes) fail('字体包过大');
    return text;
}

export function importFontPack(text) {
    if (typeof text !== 'string' || text.length > FONT_SOURCE_LIMITS.packBytes || textEncoder.encode(text).byteLength > FONT_SOURCE_LIMITS.packBytes) fail('字体包过大');
    let value;
    try {
        value = JSON.parse(text, (key, item) => {
            if (UNSAFE_KEYS.has(key)) fail('字体包包含不安全的字段');
            return item;
        });
    } catch { fail('字体包格式不正确或包含不安全的字段'); }
    if (!object(value) || value.type !== 'qianmu-font-library' || value.version !== 1 || !object(value.localFiles)) fail('不是支持的千幕字体包');
    const metadata = validateFontPackMetadata(value.fonts, value);
    const localRecords = new Map(metadata.records.filter((record) => record.source.kind === 'local').map((record) => [record.id, record]));
    if (Object.keys(value.localFiles).length !== localRecords.size) fail('字体包中的本地文件与字体清单不一致');
    const localFiles = Object.create(null);
    let total = 0;
    for (const [id, encoded] of Object.entries(value.localFiles)) {
        if (!localRecords.has(id)) fail('字体包包含未关联的本地文件');
        const bytes = decodeBase64(encoded);
        const { format } = validateLocalFontBytes(bytes);
        if (format !== localRecords.get(id).source.format) fail('本地字体文件与资料不匹配');
        total += bytes.byteLength;
        if (total > FONT_SOURCE_LIMITS.totalLocalBytes) fail('本地字体总量不能超过 96 MB');
        localFiles[id] = bytes;
    }
    return { ...metadata, localFiles };
}
