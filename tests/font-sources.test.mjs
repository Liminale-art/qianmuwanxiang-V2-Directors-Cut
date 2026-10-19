import test from 'node:test';
import assert from 'node:assert/strict';
import {
    FONT_SOURCE_LIMITS, normalizeFontUrl, parseFontStylesheet, resolveWebFontSource,
    validateLocalFontBytes, createLocalFontRecord, validateFontRecord, exportFontPack, importFontPack,
} from '../qianmu-font-sources.js';

const css = (src = './font.woff2', extra = '') => `@font-face {font-family: "春日字体"; src: local('Old'),url('${src}') format('woff2'); ${extra}}`;

test('empty links have the concise user-facing error without attempting a request', async () => {
    for (const input of ['', '  \n\t']) await assert.rejects(() => resolveWebFontSource(input, { fetch: () => assert.fail('Empty sources must not request the network') }), /^Error: 链接不可为空$/);
});
const response = (text, url = 'https://fonts.example/style.css', headers = {}) => ({ ok: true, url,
    headers: { get: (key) => headers[key] || null }, text: async () => text });
const webRecord = () => ({ id: 'web-1', name: '网络字体', source: { kind: 'web', input: 'https://fonts.example/a.woff2', url: 'https://fonts.example/a.woff2' },
    faces: [{ urls: [{ url: 'https://fonts.example/a.woff2', format: 'woff2' }], weight: '400', style: 'normal' }], folder: '阅读', tags: ['中文', '正文'] });
const subsetCss = count => Array.from({ length: count }, (_, index) => `@font-face{font-family:"大字集";src:url("https://fonts.example/subset-${index}.woff2") format("woff2");font-weight:200 900;font-style:normal;unicode-range:U+${(0x4e00 + index).toString(16)};}`).join('\n');
function makeFont(format = 'truetype') {
    const size = format === 'woff' ? 68 : format === 'woff2' ? 52 : 32;
    const bytes = new Uint8Array(size);
    const view = new DataView(bytes.buffer);
    if (format === 'woff' || format === 'woff2') {
        bytes.set(new TextEncoder().encode(format === 'woff' ? 'wOFF' : 'wOF2'));
        view.setUint32(4, 0x00010000); view.setUint32(8, size); view.setUint16(12, 1);
        if (format === 'woff') { view.setUint32(48, 64); view.setUint32(52, 4); }
    } else {
        if (format === 'opentype') bytes.set(new TextEncoder().encode('OTTO'));
        else view.setUint32(0, 0x00010000);
        view.setUint16(4, 1); view.setUint32(20, 28); view.setUint32(24, 4);
    }
    return bytes;
}
const file = (bytes, name = '春日.ttf') => ({ size: bytes.length, name, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) });

test('direct web files resolve without fetching and keep query strings', async () => {
    for (const [extension, format] of [['woff2', 'woff2'], ['woff', 'woff'], ['ttf', 'truetype'], ['otf', 'opentype']]) {
        const records = await resolveWebFontSource(`https://fonts.example/春日.${extension}?v=3`, { fetchImpl: () => assert.fail('direct font should not prefetch') });
        assert.equal(records[0].name, '春日'); assert.equal(records[0].faces[0].urls[0].format, format);
        assert.match(records[0].faces[0].urls[0].url, /\?v=3$/u);
    }
});

test('long Web references have one consistent 8192-character metadata limit', async () => {
    const url = `https://fonts.example/a.woff2?signature=${'a'.repeat(3000)}`;
    const [font] = await resolveWebFontSource(url); font.id = 'long-url';
    assert.equal(validateFontRecord(font).source.input, url);
    assert.equal(importFontPack(exportFontPack([font])).records[0].faces[0].urls[0].url, url);
    assert.throws(() => normalizeFontUrl(`https://fonts.example/${'字'.repeat(3000)}.woff2`), /过长/u);
});

test('only font faces survive extraction; arbitrary CSS and URLs never reach returned records', () => {
    const parsed = parseFontStylesheet(`body{display:none;background:url(https://evil.example/tracker)} .mes_text{font-size:999px} ${css()}`, { baseUrl: 'https://fonts.example/css/styles.css' });
    assert.deepEqual(parsed, { imports: [], faces: [{ name: '春日字体', face: { urls: [{ url: 'https://fonts.example/css/font.woff2', format: 'woff2' }], weight: '400', style: 'normal' } }] });
    assert.doesNotMatch(JSON.stringify(parsed), /evil|display|font-size/u);
});

test('Chinese subsets and variable descriptors are preserved, same-family faces remain one record', async () => {
    const input = `${css('/latin.woff2', 'font-weight: 100 900; unicode-range: U+0000-00ff; font-style: oblique -10deg 10deg; font-stretch: 80% 120%;')}
        ${css('/cjk.woff2', 'font-weight: 100 900; unicode-range: U+4E00-9FFF, U+3000-303f;')}`;
    const records = await resolveWebFontSource(input, { baseUrl: 'https://fonts.example/' });
    assert.equal(records.length, 1); assert.equal(records[0].faces.length, 2);
    assert.equal(records[0].faces[0].weight, '100 900'); assert.equal(records[0].faces[0].style, 'oblique -10deg 10deg');
    assert.equal(records[0].faces[0].stretch, '80% 120%'); assert.equal(records[0].faces[1].unicodeRange, 'U+4E00-9FFF, U+3000-303f');
    assert.equal(records[0].source.input, input);
});

test('a 672-subset variable CJK font preserves all faces and round trips alongside Web and local originals', async () => {
    const source = 'https://fonts.example/cjk.css', stylesheet = subsetCss(672);
    const [large] = await resolveWebFontSource(source, { fetchImpl: async () => response(stylesheet, source) });
    Object.assign(large, { id: 'cjk-large', folder: '正文', tags: ['中日韩', '可变字重'] });
    assert.equal(large.faces.length, 672); assert.equal(large.source.url, source);
    assert.deepEqual(large.faces, parseFontStylesheet(stylesheet).faces.map(value => value.face));
    assert.ok(large.faces.every(face => face.weight === '200 900' && face.style === 'normal'));
    const local = await createLocalFontRecord(file(makeFont())); Object.assign(local.record, { id: 'local-cjk-pack', tags: ['原件'] });
    const records = [large, webRecord(), local.record], original = structuredClone(records);
    const packed = exportFontPack(records, { localFiles: { [local.record.id]: local.bytes }, folders: ['正文', '阅读'], previewText: '一蝶振翅，万象入幕。' });
    const decoded = importFontPack(packed);
    assert.equal(JSON.parse(packed).version, 1); assert.deepEqual(decoded.records, records);
    assert.deepEqual(decoded.localFiles[local.record.id], local.bytes); assert.deepEqual(records, original);
    assert.equal(decoded.records[0].faces.at(-1).unicodeRange, 'U+509f');
});

test('per-family limit accepts 2048 unique faces, rejects 2049 and does not confuse parser declarations with stored faces', async () => {
    assert.equal(FONT_SOURCE_LIMITS.faces, 2048); assert.equal(FONT_SOURCE_LIMITS.sourceDeclarations, 8192);
    const allowed = subsetCss(2048), [font] = await resolveWebFontSource(allowed);
    assert.equal(font.faces.length, 2048); assert.deepEqual(validateFontRecord(font).faces, font.faces);
    const oversized = subsetCss(2049);
    assert.equal(parseFontStylesheet(oversized).faces.length, 2049);
    await assert.rejects(resolveWebFontSource(oversized), /单款字体分片过多/u);
    const invalid = { ...font, faces: parseFontStylesheet(oversized).faces.map(value => value.face) }, before = structuredClone(invalid);
    assert.throws(() => validateFontRecord(invalid), /字体分片数量不正确/u); assert.deepEqual(invalid, before);
});

test('repeated source declarations deduplicate before the per-family limit but remain bounded at 8192 raw declarations', async () => {
    const one = '@font-face{font-family:a;src:url(https://f.example/a.woff2)}';
    const [font] = await resolveWebFontSource(one.repeat(8192));
    assert.equal(font.faces.length, 1); assert.equal(font.faces[0].urls[0].url, 'https://f.example/a.woff2');
    await assert.rejects(resolveWebFontSource(one.repeat(8193)), /字体来源声明过多/u);
    const urls = ['https://fonts.example/first.css', 'https://fonts.example/second.css'], calls = [];
    await assert.rejects(resolveWebFontSource(urls.map(url => `@import "${url}";`).join('\n'), { fetchImpl: async url => {
        calls.push(url); return response(one.repeat(url === urls[0] ? 4096 : 4097), url);
    } }), /字体来源声明过多/u);
    assert.deepEqual(calls, urls);
});

test('font grouping preserves each family and distinct variants while deduplicating equivalent declarations in first-seen order', async () => {
    const first = '@font-face{font-family:"First";src:url(https://fonts.example/a.woff2);font-weight:400;unicode-range:U+4e00;}';
    const italic = first.replace('font-weight:400;', 'font-weight:400;font-style:italic;');
    const bold = first.replace('font-weight:400;', 'font-weight:700;');
    const other = first.replace('"First"', '"Other"');
    const result = await resolveWebFontSource(first + italic + first + bold + other + other + italic);
    assert.deepEqual(result.map(font => font.name), ['First', 'Other']);
    assert.deepEqual(result[0].faces.map(face => [face.weight, face.style]), [['400', 'normal'], ['400', 'italic'], ['700', 'normal']]);
    assert.equal(result[1].faces.length, 1); assert.deepEqual(result[1].faces[0], result[0].faces[0]);
});

test('quoted CSS braces/semicolons, comments and CSS escapes do not break parsing', () => {
    const parsed = parseFontStylesheet(`/* prefix */ @font-face {font-family:'A\\20 B';src:url("https://fonts.example/a;b{c}.woff2") format("woff2-variations");font-weight: bold}`);
    assert.equal(parsed.faces[0].name, 'A B'); assert.equal(parsed.faces[0].face.weight, '700');
    assert.equal(parsed.faces[0].face.urls[0].format, 'woff2');
    assert.match(decodeURIComponent(parsed.faces[0].face.urls[0].url), /a;b\{c\}/u);
});

test('stylesheet import resolves relative paths, credentials omitted, cycles terminate', async () => {
    const calls = [];
    const sources = new Map([
        ['https://fonts.example/a.css', '@import "./b.css"; ' + css('./a.woff2')],
        ['https://fonts.example/b.css', '@import url("./a.css"); ' + css('./b.woff2')],
    ]);
    const records = await resolveWebFontSource('@import url("https://fonts.example/a.css");', { fetchImpl: async (url, options) => {
        calls.push(url); assert.equal(options.credentials, 'omit'); assert.equal(options.referrerPolicy, 'no-referrer');
        return response(sources.get(url), url);
    } });
    assert.deepEqual(calls, [...sources.keys()]); assert.equal(records[0].faces.length, 2);
});

test('stylesheet redirects provide the base for relative font files', async () => {
    const result = await resolveWebFontSource('https://fonts.example/start', { fetchImpl: async () => response(css('../final.woff2'), 'https://cdn.example/css/a.css') });
    assert.equal(result[0].faces[0].urls[0].url, 'https://cdn.example/final.woff2');
    assert.deepEqual(result[0].source, { kind: 'web', input: 'https://fonts.example/start', url: 'https://fonts.example/start' });
});

test('link/style snippets retain inert original edit text but extract only font faces and decode URL entities', async () => {
    const calls = [];
    const input = `<link rel="preconnect" href="https://ignored.example"><link rel='stylesheet' href='https://fonts.example/css?family=A&amp;display=swap'><script>alert(1)</script>
        <style>body{color:red}${css('https://fonts.example/local.woff2')}</style>`;
    const result = await resolveWebFontSource(input, { fetchImpl: async (url) => { calls.push(url); return response(css('/remote.woff2'), url); } });
    assert.deepEqual(calls, ['https://fonts.example/css?family=A&display=swap']); assert.equal(result[0].faces.length, 2);
    assert.equal(result[0].source.input, input);
    assert.doesNotMatch(JSON.stringify(result[0].faces), /alert|color:red|ignored/u);
    assert.deepEqual(result[0].faces.map(face => face.urls[0].url), ['https://fonts.example/local.woff2', 'https://fonts.example/remote.woff2']);
});

test('short import plus body input stays concise through validation and packs without losing remote subsets', async () => {
    const input = '@import url("https://fonts.example/578/main/result.css");\nbody { font-family: "春日字体"; font-weight: normal; }';
    const remote = Array.from({ length: 200 }, (_, index) => css(`./${index}.woff2`, `font-weight: 100 900; font-style: ${index % 2 ? 'italic' : 'normal'}; unicode-range: U+${(0x4e00 + index).toString(16)};`)).join('\n');
    const [font] = await resolveWebFontSource(input, { fetchImpl: async () => response(remote, 'https://fonts.example/578/main/result.css') });
    assert.equal(font.source.input, input); assert.equal(font.faces.length, 200);
    assert.equal(font.faces[0].urls[0].url, 'https://fonts.example/578/main/0.woff2');
    assert.equal(font.faces.at(-1).unicodeRange, 'U+4ec7'); assert.equal(font.faces.at(-1).style, 'italic');
    assert.ok(font.faces.every(face => face.weight === '100 900'));
    font.id = 'imported-subsets';
    assert.deepEqual(validateFontRecord(font), font);
    assert.deepEqual(importFontPack(exportFontPack([font])).records[0], font);
    assert.doesNotMatch(JSON.stringify(font.faces), /body|font-family/u);
});

test('overlong original CSS retains full validated faces without overfilling source metadata or guessing an origin', async () => {
    const declarations = css('https://fonts.example/a.woff2', 'unicode-range: U+4e00;') + css('https://fonts.example/b.woff2', 'font-weight: 700; unicode-range: U+4e01;');
    const input = '/*' + 'x'.repeat(8192) + '*/' + declarations;
    const [font] = await resolveWebFontSource(input);
    assert.deepEqual(font.source, { kind: 'web', input: '内嵌字体样式' });
    assert.deepEqual(font.faces, parseFontStylesheet(declarations).faces.map(item => item.face));
    assert.equal(validateFontRecord(font).faces.length, 2);
    for (const invalid of ['', ' ', null, {}, declarations + '\u0001', '@font-face {font-family:"unclosed']) {
        await assert.rejects(resolveWebFontSource(invalid));
    }
});

test('nested media/supports/layer font faces are supported without applying conditional page CSS', () => {
    const result = parseFontStylesheet(`@media screen { @supports (font-tech: variations) { @layer fonts { ${css('https://fonts.example/a.woff2')} } } }`);
    assert.equal(result.faces.length, 1);
});

test('all unsafe URL forms and credential URLs are rejected, including inside CSS/imports', async () => {
    for (const url of ['javascript:alert(1)', 'data:font/woff2;base64,aA==', 'file:///C:/a.ttf', 'https://a:b@fonts.example/a.woff2']) {
        assert.throws(() => normalizeFontUrl(url));
        assert.throws(() => parseFontStylesheet(css(url)));
    }
    await assert.rejects(resolveWebFontSource('@import "https://a:b@fonts.example/style.css";'));
    await assert.rejects(resolveWebFontSource('https://fonts.example/a.css', { fetchImpl: async () => response(css('/a.woff2'), 'file:///C:/a.css') }));
});

test('missing cross-origin permission and HTTP failures are honest failures', async () => {
    await assert.rejects(resolveWebFontSource('https://fonts.example/css', { fetchImpl: async () => { throw new TypeError('Failed to fetch'); } }), /跨域权限/u);
    await assert.rejects(resolveWebFontSource('https://fonts.example/css', { fetchImpl: async () => ({ ok: false, status: 403 }) }), /403/u);
    await assert.rejects(resolveWebFontSource('https://fonts.example/css', { fetchImpl: async () => response('<html>login</html>') }), /未找到/u);
});

test('abort signal is forwarded and cancellation is not disguised as a CORS error', async () => {
    const controller = new AbortController(); controller.abort();
    await assert.rejects(resolveWebFontSource('https://fonts.example/css', { signal: controller.signal, fetchImpl: async (_url, options) => {
        assert.equal(options.signal, controller.signal); throw new DOMException('Aborted', 'AbortError');
    } }), { name: 'AbortError' });
});

test('resolver timeout covers a stalled fetch and cancels the supplied fetch signal', async () => {
    let forwarded;
    await assert.rejects(resolveWebFontSource('https://fonts.example/css', { timeoutMs: 5, fetchImpl: async (_url, options) => {
        forwarded = options.signal; return new Promise(() => {});
    } }), /读取超时/u);
    assert.equal(forwarded.aborted, true);
});

test('caller cancellation aborts a stalled body and preserves AbortError', async () => {
    let cancelled = false;
    const controller = new AbortController();
    const stream = new ReadableStream({ cancel() { cancelled = true; } });
    const pending = resolveWebFontSource('https://fonts.example/css', { signal: controller.signal,
        fetchImpl: async () => ({ ok: true, body: stream, headers: { get: () => null } }) });
    await Promise.resolve(); await Promise.resolve(); controller.abort();
    await assert.rejects(pending, { name: 'AbortError' });
    assert.equal(cancelled, true);
});

test('CSS fetch and parse are bounded by bytes, imports and nesting', async () => {
    assert.throws(() => parseFontStylesheet(' '.repeat(FONT_SOURCE_LIMITS.cssBytes + 1)), /过大/u);
    await assert.rejects(resolveWebFontSource('https://fonts.example/css', { fetchImpl: async () => response('', undefined, { 'content-length': FONT_SOURCE_LIMITS.cssBytes + 1 }) }), /过大/u);
    await assert.rejects(resolveWebFontSource('https://fonts.example/0.css', { fetchImpl: async (url) => {
        const index = Number(new URL(url).pathname.match(/\d+/u)[0]); return response(`@import './${index + 1}.css';`, url);
    } }), /层级过深/u);
    assert.throws(() => parseFontStylesheet('@media a{'.repeat(10) + css('/a.woff2') + '}'.repeat(10), { baseUrl: 'https://fonts.example' }), /嵌套过深/u);
});

test('streamed CSS bytes are bounded and oversized stream is cancelled', async () => {
    let cancelled = false;
    const stream = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(FONT_SOURCE_LIMITS.cssBytes + 1)); }, cancel() { cancelled = true; } });
    await assert.rejects(resolveWebFontSource('https://fonts.example/css', { fetchImpl: async () => ({ ok: true, body: stream, headers: { get: () => null } }) }), /过大/u);
    assert.equal(cancelled, true);
});

test('descriptor injection and malformed ranges are rejected instead of being installed', () => {
    for (const extra of ['font-weight: 900 100', 'font-style: italic !important', 'font-stretch: expression(alert(1))', 'unicode-range: U+110000', 'unicode-range: U+FFFF-0000']) {
        assert.throws(() => parseFontStylesheet(css('https://fonts.example/a.woff2', extra)));
    }
    assert.throws(() => parseFontStylesheet('@font-face {font-family:"broken;src:url(a)'));
});

test('all four local font formats are accepted, bytes remain separate from record metadata', async () => {
    for (const format of ['truetype', 'opentype', 'woff', 'woff2']) {
        const bytes = makeFont(format); const created = await createLocalFontRecord(file(bytes), { name: '选择的名称' });
        assert.equal(created.record.source.format, format); assert.equal(created.record.name, '选择的名称');
        assert.deepEqual(created.bytes, bytes); assert.deepEqual(created.record.faces[0].urls, []);
        assert.doesNotMatch(JSON.stringify(created.record), /base64|data:|blob:/u);
    }
});

test('local SFNT OS/2 and fvar metadata supplies actual weight/style instead of filename guesses', async () => {
    const bytes = new Uint8Array(160), view = new DataView(bytes.buffer);
    view.setUint32(0, 0x00010000); view.setUint16(4, 2);
    bytes.set(new TextEncoder().encode('OS/2'), 12); view.setUint32(20, 44); view.setUint32(24, 64);
    bytes.set(new TextEncoder().encode('fvar'), 28); view.setUint32(36, 108); view.setUint32(40, 36);
    view.setUint16(48, 600); view.setUint16(106, 1);
    view.setUint16(112, 16); view.setUint16(116, 1); view.setUint16(118, 20);
    bytes.set(new TextEncoder().encode('wght'), 124); view.setInt32(128, 100 * 65536); view.setInt32(136, 900 * 65536);
    const created = await createLocalFontRecord(file(bytes, 'misleading-normal.ttf'));
    assert.equal(created.record.source.variantKnown, true);
    assert.equal(created.record.faces[0].weight, '100 900'); assert.equal(created.record.faces[0].style, 'italic');
    view.setUint16(118, 1000); // Invalid optional fvar cannot escape its table; retain trustworthy OS/2.
    const staticOnly = await createLocalFontRecord(file(bytes));
    assert.equal(staticOnly.record.faces[0].weight, '600');
});

test('compressed local files do not invent a variable family from their filename', async () => {
    const created = await createLocalFontRecord(file(makeFont('woff2'), 'bold-italic-variable.woff2'));
    assert.equal(created.record.source.variantKnown, false);
    assert.equal(created.record.faces[0].weight, '400'); assert.equal(created.record.faces[0].style, 'normal');
});

test('local upload checks size before reading and rejects disguised files/truncated tables', async () => {
    await assert.rejects(createLocalFontRecord({ size: FONT_SOURCE_LIMITS.fontBytes + 1, arrayBuffer: () => assert.fail('must not read oversized upload') }), /32 MB/u);
    assert.throws(() => validateLocalFontBytes(new TextEncoder().encode('<svg><script>alert(1)</script></svg>')), /仅支持/u);
    assert.throws(() => validateLocalFontBytes(makeFont('truetype').subarray(0, 12)), /表不完整/u);
    const escaped = makeFont(); new DataView(escaped.buffer).setUint32(20, 999); assert.throws(() => validateLocalFontBytes(escaped), /超出边界/u);
    const wrongLength = makeFont('woff'); new DataView(wrongLength.buffer).setUint32(8, 500); assert.throws(() => validateLocalFontBytes(wrongLength), /文件头/u);
});

test('record validation allows expected fields only and preserves classifications', () => {
    const value = { ...webRecord(), arbitraryPageStyle: 'body{display:none}', tags: ['中文', '中文', '正文'] };
    assert.deepEqual(validateFontRecord(value), webRecord());
    assert.throws(() => validateFontRecord(JSON.parse('{"name":"x","__proto__":{"polluted":true}}')), /不安全/u);
    assert.equal({}.polluted, undefined);
    const invalid = webRecord(); invalid.faces[0].urls[0].url = 'blob:local'; assert.throws(() => validateFontRecord(invalid));
});

test('portable font pack round trips local bytes, web references, folders/tags and preview text', async () => {
    const local = await createLocalFontRecord(file(makeFont())); local.record.id = 'local-1'; local.record.folder = '本地';
    const original = [webRecord(), local.record];
    const encoded = exportFontPack(original, { localFiles: { 'local-1': local.bytes }, previewText: '山有木兮木有枝 ABC 0123', folders: ['阅读', '本地'] });
    const pack = importFontPack(encoded);
    assert.deepEqual(pack.records, original); assert.deepEqual(pack.localFiles['local-1'], local.bytes);
    assert.equal(pack.previewText, '山有木兮木有枝 ABC 0123'); assert.deepEqual(pack.folders, ['阅读', '本地']);
    assert.equal(Object.getPrototypeOf(pack.localFiles), null);
    assert.deepEqual(JSON.parse(encoded).fonts[1].faces[0].urls, []);
});

test('Web-only packs need no local storage or embedded files', () => {
    const encoded = exportFontPack([webRecord()]); const decoded = importFontPack(encoded);
    assert.deepEqual(decoded.records, [webRecord()]); assert.deepEqual(Object.keys(decoded.localFiles), []);
});

test('a single v1 JSON pack carries multiple Web families and distinct local originals with legacy metadata intact', async () => {
    const first = await createLocalFontRecord(file(makeFont('truetype'), '本地常规.ttf'), { name: '本地常规' });
    const second = await createLocalFontRecord(file(makeFont('opentype'), '本地艺术.otf'), { name: '本地艺术' });
    Object.assign(first.record, { id: 'local-first', folder: '旧版目录', tags: ['中文', '正文'] });
    Object.assign(second.record, { id: 'local-second', folder: '', tags: ['艺术'] });
    const otherWeb = { ...webRecord(), id: 'web-2', name: '另一款网络字体', source: { kind: 'web', input: 'https://fonts.example/second.css', url: 'https://fonts.example/second.css' },
        faces: [{ urls: [{ url: 'https://fonts.example/second.woff2', format: 'woff2' }], weight: '100 900', style: 'normal', unicodeRange: 'U+4E00-9FFF' }], tags: ['可变字重'] };
    const records = [webRecord(), first.record, otherWeb, second.record], localFiles = new Map([[first.record.id, first.bytes], [second.record.id, second.bytes]]);
    const encoded = exportFontPack(records, { localFiles, folders: ['阅读', '旧版目录', '旧版空目录'], previewText: '一包多款，不含应用偏好' });
    const wire = JSON.parse(encoded), decoded = importFontPack(encoded);
    assert.equal(wire.type, 'qianmu-font-library'); assert.equal(wire.version, 1);
    assert.equal(wire.fonts.length, 4); assert.deepEqual(Object.keys(wire.localFiles), [first.record.id, second.record.id]);
    assert.deepEqual(decoded.records, records); assert.deepEqual(decoded.localFiles[first.record.id], first.bytes); assert.deepEqual(decoded.localFiles[second.record.id], second.bytes);
    assert.notDeepEqual(decoded.localFiles[first.record.id], decoded.localFiles[second.record.id]);
    assert.deepEqual(decoded.folders, ['阅读', '旧版目录', '旧版空目录']); assert.equal(decoded.previewText, '一包多款，不含应用偏好');
    assert.throws(() => exportFontPack(records, { localFiles: { [first.record.id]: first.bytes } }), /文件数据/u);
    const incomplete = structuredClone(wire); delete incomplete.localFiles[second.record.id];
    assert.throws(() => importFontPack(JSON.stringify(incomplete)), /不一致/u);
    const wrongSecond = structuredClone(wire); wrongSecond.localFiles[second.record.id] = wrongSecond.localFiles[first.record.id];
    assert.throws(() => importFontPack(JSON.stringify(wrongSecond)), /不匹配/u);
});

test('pack rejects missing/unreferenced files, duplicate ids, invalid bytes and prototype fields', async () => {
    const local = await createLocalFontRecord(file(makeFont())); local.record.id = 'local-1';
    assert.throws(() => exportFontPack([local.record]), /文件数据/u);
    assert.throws(() => exportFontPack([webRecord(), webRecord()]), /重复/u);
    const base = JSON.parse(exportFontPack([local.record], { localFiles: { 'local-1': local.bytes } }));
    const missing = structuredClone(base); missing.localFiles = {}; assert.throws(() => importFontPack(JSON.stringify(missing)), /不一致/u);
    const unknown = structuredClone(base); unknown.localFiles.other = unknown.localFiles['local-1']; assert.throws(() => importFontPack(JSON.stringify(unknown)), /不一致/u);
    const invalid = structuredClone(base); invalid.localFiles['local-1'] = 'aA==not-base64'; assert.throws(() => importFontPack(JSON.stringify(invalid)), /编码/u);
    assert.throws(() => importFontPack('{"type":"qianmu-font-library","version":1,"fonts":[],"localFiles":{},"__proto__":{}}'), /不安全/u);
    const mismatch = structuredClone(base); mismatch.fonts[0].source.format = 'opentype'; assert.throws(() => importFontPack(JSON.stringify(mismatch)), /不匹配/u);
});

test('font count, preview text, malformed metadata and ranges are bounded on pack import', () => {
    assert.throws(() => exportFontPack([webRecord()], { previewText: '字'.repeat(FONT_SOURCE_LIMITS.previewLength + 1) }), /预览文案/u);
    assert.throws(() => exportFontPack(Array.from({ length: FONT_SOURCE_LIMITS.records + 1 }, (_, i) => ({ ...webRecord(), id: `f-${i}` }))), /字体数量/u);
    assert.throws(() => importFontPack('not json'), /格式/u);
    const metadata = JSON.parse(exportFontPack([webRecord()])); metadata.fonts[0].faces[0].weight = '400; color:red'; assert.throws(() => importFontPack(JSON.stringify(metadata)), /粗细/u);
});

test('multi-megabyte local exports round trip without regex or argument-stack overflow', async () => {
    const bytes = new Uint8Array(2 * 1024 * 1024); bytes.set(makeFont());
    new DataView(bytes.buffer).setUint32(24, bytes.length - 28);
    const local = await createLocalFontRecord(file(bytes)); local.record.id = 'large';
    const pack = importFontPack(exportFontPack([local.record], { localFiles: { large: bytes } }));
    assert.deepEqual(pack.localFiles.large, bytes);
});

test('multiple Chinese subset families do not exhaust the per-source face allowance on export', () => {
    const fonts = Array.from({ length: 3 }, (_, index) => ({ ...webRecord(), id: `font-${index}`,
        faces: Array.from({ length: 200 }, (_, sub) => ({ urls: [{ url: `https://fonts.example/${index}/${sub}.woff2` }], weight: '400', style: 'normal', unicodeRange: 'U+4E00-9FFF' })) }));
    assert.equal(importFontPack(exportFontPack(fonts)).records.length, 3);
});

test('font packs keep the 8192-face aggregate limit, preserve every allowed face and reject excess without truncating', () => {
    const fonts = Array.from({ length: 4 }, (_, index) => ({ ...webRecord(), id: `large-family-${index}`,
        faces: Array.from({ length: 2048 }, (_, sub) => ({ urls: [{ url: `https://fonts.example/${index}/${sub}.woff2` }], weight: '200 900', style: 'normal', unicodeRange: `U+${(0x4e00 + sub).toString(16)}` })) }));
    assert.equal(FONT_SOURCE_LIMITS.totalFaces, 8192);
    const original = structuredClone(fonts), packed = exportFontPack(fonts), decoded = importFontPack(packed);
    assert.deepEqual(decoded.records, original); assert.deepEqual(fonts, original);
    const excessive = [...fonts, { ...webRecord(), id: 'one-extra-face' }], excessiveBefore = structuredClone(excessive);
    assert.throws(() => exportFontPack(excessive), /分片总量过多.*请分批导出/u);
    assert.throws(() => importFontPack(JSON.stringify({ type: 'qianmu-font-library', version: 1, fonts: excessive, localFiles: {} })), /分片总量过多/u);
    assert.deepEqual(excessive, excessiveBefore);
});
