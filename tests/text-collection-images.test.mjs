import test from 'node:test';
import assert from 'node:assert/strict';
import { exportTextCollectionImages, layoutTextCollectionImages } from '../qianmu-text-collection-images.js';

// These are synthetic layout/encoding doubles, not browser screenshots or font QA.
const measure = (value, font) => ({ width: Array.from(value).length * Number.parseFloat(font) });
const normalize = value => value.replace(/\r\n?/g, '\n').replace(/\n(?:[ \t]*\n)+/g, '\n');
const textOf = (pages, kind = 'body') => pages.flatMap(page => page.commands.filter(line => line.kind === kind)).map(line => line.text + line.breakAfter).join('');
async function layout(options) {
    const pages = [];
    for await (const page of layoutTextCollectionImages({ measureText: measure, yieldControl: async () => {}, ...options })) pages.push(page);
    return pages;
}
function fixture({ measureImpl = measure, encode, contextAvailable = true } = {}) {
    const events = [], files = [], images = [], created = [];
    let draws = [];
    const context = {
        font: '', fillStyle: '', textAlign: '', textBaseline: '',
        measureText(value) { return measureImpl(value, this.font); },
        fillRect(x, y, width, height) { events.push(['background', this.fillStyle, width, height]); },
        fillText(value, x, y, maxWidth) { draws.push({ value, x, y, maxWidth, font: this.font, align: this.textAlign, color: this.fillStyle }); },
    };
    let width = 0, height = 0;
    const canvas = {
        get width() { return width; }, set width(value) { width = value; events.push(['width', value]); },
        get height() { return height; }, set height(value) { height = value; events.push(['height', value]); },
        getContext(kind, options) { assert.equal(kind, '2d'); assert.equal(options.alpha, false); return contextAvailable ? context : null; },
        toBlob(done, type) {
            assert.equal(type, 'image/png');
            images.push({ width, height, draws });
            draws = [];
            events.push(['encode', images.length]);
            if (encode) encode(done, images.length);
            else done(new Blob(['encoded synthetic page'], { type: 'image/png' }));
        },
    };
    const document = { createElement(tag) { assert.equal(tag, 'canvas'); created.push(tag); return canvas; } };
    const download = async (blob, filename) => { files.push({ blob, filename }); events.push(['download', files.length]); };
    return { canvas, context, document, download, events, files, images, created };
}

test('short sentence is a square and its text block is centered', async () => {
    const [page] = await layout({ text: '今夜月色很美。' });
    assert.equal(page.width, 1080);
    assert.equal(page.height, 1080);
    assert.equal(page.commands.length, 1);
    const [line] = page.commands;
    assert.equal(line.align, 'center');
    assert.equal(line.x, 540);
    assert.equal(line.y + line.lineHeight / 2, 540);
});

test('short paragraph remains centered vertically but starts with a 2em indent', async () => {
    const [page] = await layout({ text: '这是需要换行的短段落。'.repeat(5) });
    assert.equal(page.height, 1080);
    assert.ok(page.commands.length > 1);
    const first = page.commands[0];
    assert.equal(first.indent, first.fontSize * 2);
    assert.equal(first.x, 96 + first.indent);
    assert.equal(page.commands[1].x, 96);
    const last = page.commands.at(-1);
    assert.equal((first.y + last.y + last.lineHeight) / 2, 540);
});

test('normal labels occupy the top-left and bottom-right, without titles or ornament', async () => {
    const [page] = await layout({ text: '正文', header: 'CHAR & USER', footer: '2026-09-28' });
    const header = page.commands.find(line => line.kind === 'header');
    const footer = page.commands.find(line => line.kind === 'footer');
    assert.equal(header.align, 'left');
    assert.equal(header.x, 96);
    assert.equal(header.y, 96);
    assert.equal(footer.align, 'right');
    assert.equal(footer.x, 1080 - 96);
    assert.equal(footer.y + footer.lineHeight, 1080 - 96);
    assert.deepEqual(page.commands.map(line => line.kind), ['header', 'body', 'footer']);
});

test('body typography uses 1.55 line height, .75em paragraph gap and 2em indentation', async () => {
    const pages = await layout({text: `${'段落内容'.repeat(30)}\n\n第二段`});
    const rows = pages.flatMap(page => page.commands).filter(line => line.kind === 'body');
    for (const row of rows) {
        assert.equal(row.lineHeight, row.fontSize * 1.55);
        assert.equal(row.indent, row.paragraphStart ? row.fontSize * 2 : 0);
        assert.equal(row.height, row.lineHeight + (row.breakAfter ? row.fontSize * .75 : 0));
        assert.equal(row.justify, !row.paragraphEnd);
    }
    assert.equal(rows.at(-1).justify, false);
});

test('36 to 44 pixel prose sizes scale all body spacing and preserve full long text', async () => {
    const text = `${'字号随正文调整🧭。'.repeat(400)}\n\n完整结尾`;
    const small = await layout({text, fontSize: 36});
    const large = await layout({text, fontSize: 44});
    assert.equal(textOf(small), normalize(text)); assert.equal(textOf(large), normalize(text));
    assert.ok(large.length > small.length && large.length > 3);
    for (const page of large) for (const row of page.commands.filter(line => line.kind === 'body')) {
        assert.equal(row.fontSize, 44); assert.equal(row.lineHeight, 44 * 1.55);
        assert.equal(row.height, row.lineHeight + (row.breakAfter ? 44 * .75 : 0));
        assert.equal(row.indent, row.paragraphStart ? 88 : 0);
        assert.ok(row.y + row.lineHeight <= page.height - 96 + 1e-8);
    }
    const f = fixture();
    await exportTextCollectionImages({...f, text: '短句', fontSize: 44, fontFamily: '"正文宋体", serif', yieldControl: async () => {}});
    assert.equal(f.images[0].draws[0].font, '44px "正文宋体", serif');
    assert.equal(f.images[0].height, 1080); assert.equal(f.images[0].draws[0].align, 'center');
});

test('unknown or unsafe font sizes fall back without clipping source text', async () => {
    for (const fontSize of [undefined, null, NaN, Infinity, -1, 0, 1, 193, 100000, '44px', {}]) {
        const text = '保留完整正文'.repeat(20), pages = await layout({text, fontSize});
        assert.equal(textOf(pages), text);
        assert.ok(pages.flatMap(page => page.commands).every(line => line.fontSize === 36));
    }
    for (const fontSize of [12, 192]) {
        const text = '边界字号也保留全部正文'.repeat(100), pages = await layout({text, fontSize, header: '页眉'.repeat(100), footer: '页尾'.repeat(100)});
        assert.equal(textOf(pages), text);
        assert.ok(pages.flatMap(page => page.commands).filter(line => line.kind === 'body').every(line => line.fontSize === fontSize));
    }
});

test('CJK soft wraps reach both page edges while final and single lines are not spread', async () => {
    const f = fixture(), text = '山'.repeat(31);
    const [page] = await layout({text});
    await exportTextCollectionImages({...f, text, yieldControl: async () => {}});
    const rows = page.commands.filter(line => line.kind === 'body');
    const first = f.images[0].draws.filter(draw => draw.y === rows[0].y);
    assert.ok(first.length > 1);
    assert.equal(first.map(draw => draw.value).join(''), rows[0].text);
    assert.equal(first[0].x, rows[0].x);
    const lastEdge = first.at(-1).x + measure(first.at(-1).value, first.at(-1).font).width;
    assert.ok(Math.abs(lastEdge - (rows[0].x + rows[0].width)) < .000001);
    const final = f.images[0].draws.filter(draw => draw.y === rows.at(-1).y);
    assert.equal(final.length, 1);
    assert.equal(final[0].value, rows.at(-1).text);
    assert.equal(f.images[0].draws.map(draw => draw.value).join(''), text);
});

test('Latin justification keeps words together and preserves all spaces', async () => {
    const text = 'Alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo.';
    const f = fixture();
    await exportTextCollectionImages({...f, text, yieldControl: async () => {}});
    assert.equal(f.images[0].draws.map(draw => draw.value).join(''), text);
    assert.ok(f.images[0].draws.some(draw => draw.value === 'Alpha '));
    assert.equal(f.images[0].draws.some(draw => draw.value === 'A'), false);
});

test('long body has no three-image or thirty-thousand-character limit', async () => {
    const text = '风起时，我们继续走。'.repeat(3400) + '完整结尾🧭';
    assert.ok(text.length > 30000);
    const pages = await layout({ text, header: '两人的故事', footer: '2026-09-28' });
    assert.ok(pages.length > 3);
    assert.equal(textOf(pages), text);
    for (const page of pages) {
        assert.equal(page.width, 1080);
        assert.equal(page.height, 1440);
        assert.equal(page.commands.filter(line => line.kind === 'header').map(line => line.text).join(''), '两人的故事');
        assert.equal(page.commands.filter(line => line.kind === 'footer').map(line => line.text).join(''), '2026-09-28');
    }
});

test('CRLF, blank paragraphs and whitespace normalize only visual spacing without losing words', async () => {
    const text = '  开头留空  \r\n\r\n第二段\t尾部 \r第三段\n \n\n末尾\n';
    const pages = await layout({ text });
    assert.equal(textOf(pages), normalize(text));
    const starts = pages.flatMap(page => page.commands).filter(line => line.paragraphStart);
    assert.ok(starts.length >= 4);
    assert.ok(starts.every(line => line.indent === 72));
});

test('Unicode surrogate, combining, flag and joined emoji clusters remain indivisible', async () => {
    const symbols = ['🧭', '👩🏽‍🚀', '🇨🇳', 'e\u0301', '✈️'];
    for (const symbol of symbols) {
        const text = '甲'.repeat(22) + symbol + '乙'.repeat(200);
        const pages = await layout({ text });
        assert.equal(textOf(pages), text);
        const containing = pages.flatMap(page => page.commands).filter(line => line.text.includes(symbol));
        assert.equal(containing.length, 1, symbol);
        for (const { text: line } of pages.flatMap(page => page.commands)) {
            assert.doesNotMatch(line, /^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/u);
        }
    }
});

test('fallback segmentation still keeps surrogate pairs and composite emoji intact', async () => {
    const descriptor = Object.getOwnPropertyDescriptor(Intl, 'Segmenter');
    try {
        Object.defineProperty(Intl, 'Segmenter', { ...descriptor, value: undefined });
        const text = '甲'.repeat(22) + '👩🏽‍🚀🇨🇳e\u0301' + '乙'.repeat(200);
        const pages = await layout({ text });
        assert.equal(textOf(pages), text);
        for (const expected of ['👩🏽‍🚀', '🇨🇳', 'e\u0301']) {
            assert.ok(pages.flatMap(page => page.commands).some(line => line.text.includes(expected)));
        }
    } finally { Object.defineProperty(Intl, 'Segmenter', descriptor); }
});

test('unusually wide single glyph is one line with a fit width, never dropped', async () => {
    const text = '👨‍👩‍👧‍👦';
    const pages = await layout({ text, measureText: () => 99999 });
    assert.equal(textOf(pages), text);
    assert.equal(pages.length, 1);
    assert.equal(pages[0].commands.length, 1);
    assert.equal(pages[0].commands[0].width, 888);
    const f = fixture({ measureImpl: () => 99999 });
    await exportTextCollectionImages({ ...f, text, yieldControl: async () => {} });
    assert.equal(f.images[0].draws[0].value, text);
    assert.equal(f.images[0].draws[0].maxWidth, 888);
});

test('very long labels are fully paginated, even after the body ends', async () => {
    const header = '名字很长🧭'.repeat(180) + '页眉结尾';
    const footer = '时间备注。'.repeat(200) + '页尾结尾';
    const pages = await layout({ text: '只此一句', header, footer });
    assert.ok(pages.length > 3);
    assert.equal(textOf(pages), '只此一句');
    assert.equal(textOf(pages, 'header'), header);
    assert.equal(textOf(pages, 'footer'), footer);
    for (const page of pages) {
        assert.ok(page.commands.length <= 30);
        for (const line of page.commands) assert.ok(line.y >= 96 && line.y + line.lineHeight <= page.height - 96);
    }
});

test('a long label stops when consumed, while the other short label repeats', async () => {
    const header = '角色名'.repeat(200);
    const text = '正文'.repeat(5000);
    const pages = await layout({ text, header, footer: '日期' });
    assert.equal(textOf(pages), text);
    assert.equal(textOf(pages, 'header'), header);
    assert.equal(textOf(pages, 'footer'), '日期'.repeat(pages.length));
    assert.ok(pages.at(-1).commands.every(line => line.kind !== 'header'));
});

test('empty labels draw no header or footer', async () => {
    const pages = await layout({ text: '只有正文' });
    assert.ok(pages[0].commands.every(line => line.kind === 'body'));
});

test('malicious styling is never treated as HTML, CSS declarations or remote URLs', async () => {
    const [page] = await layout({ text: '<img src=x onerror=alert(1)>', foreground: 'url(https://example.invalid/a)',
        background: '</canvas><script>anything</script>', fontFamily: 'serif; background:url(https://example.invalid)' });
    assert.equal(page.foreground, '#242b34');
    assert.equal(page.background, '#fffdf8');
    assert.equal(page.fontFamily, 'serif');
    assert.equal(textOf([page]), '<img src=x onerror=alert(1)>');
});

test('computed theme colors and a Unicode font family remain supported', async () => {
    const [page] = await layout({ text: '正文', foreground: 'rgb(22, 44, 66)', background: '#faf8f4', fontFamily: '"思源宋体", Georgia, serif' });
    assert.equal(page.foreground, 'rgb(22, 44, 66)');
    assert.equal(page.background, '#faf8f4');
    assert.equal(page.fontFamily, '"思源宋体", Georgia, serif');
});

test('theme opacity becomes solid paper and malformed numeric colors use a readable fallback', async () => {
    const [page] = await layout({ text: '正文', foreground: 'rgb(2..3, 44, 66)', background: 'rgba(22, 44, 66, 0.2)' });
    assert.equal(page.foreground, '#242b34');
    assert.equal(page.background, 'rgb(22, 44, 66)');
    const [hex] = await layout({ text: '正文', foreground: '#abcd', background: '#11223344' });
    assert.equal(hex.foreground, '#abc');
    assert.equal(hex.background, '#112233');
});

test('invalid inputs and invalid measurements fail before yielding any page', async () => {
    for (const text of [null, undefined, 12, '', ' \n\t ']) await assert.rejects(layout({ text }), { code: 'collection_image_empty' });
    await assert.rejects(layout({ text: '正文', header: {} }), { code: 'collection_image_input' });
    for (const width of [NaN, Infinity, -1, undefined]) await assert.rejects(layout({ text: '正文', measureText: () => width }), { code: 'collection_image_measure' });
});

test('large input yields cooperatively while still in layout, before the first page', async () => {
    let yields = 0;
    const controller = new AbortController();
    await assert.rejects(layout({ text: '正文', header: '名字'.repeat(10000), signal: controller.signal,
        yieldControl: async () => { if (++yields === 2) controller.abort(); } }), { name: 'AbortError' });
    assert.equal(yields, 2);
});

test('cancellation and lost owner stop further layout pages', async () => {
    for (const mode of ['signal', 'owner']) {
        const controller = new AbortController();
        let active = true, seen = 0;
        await assert.rejects(async () => {
            for await (const page of layoutTextCollectionImages({ text: '正文'.repeat(5000), measureText: measure,
                signal: controller.signal, isCurrent: () => active, yieldControl: async () => {} })) {
                assert.equal(page.page, 1);
                seen++;
                if (mode === 'signal') controller.abort(); else active = false;
            }
        }, { name: 'AbortError' });
        assert.equal(seen, 1);
    }
});

test('encoder downloads sequentially, reuses one canvas and releases it after each page', async () => {
    const f = fixture();
    const result = await exportTextCollectionImages({ ...f, text: '长篇段落。'.repeat(1200), yieldControl: async () => {} });
    assert.ok(result.pages > 3);
    assert.equal(f.files.length, result.pages);
    assert.deepEqual(f.created, ['canvas']);
    assert.equal(f.canvas.width, 0);
    assert.equal(f.canvas.height, 0);
    assert.equal(f.files[0].filename, '千幕收藏-001.png');
    assert.equal(f.files.at(-1).filename, `千幕收藏-${String(result.pages).padStart(3, '0')}.png`);
    for (let i = 1; i < result.pages; i++) {
        const priorDownload = f.events.findIndex(event => event[0] === 'download' && event[1] === i);
        const nextEncode = f.events.findIndex(event => event[0] === 'encode' && event[1] === i + 1);
        assert.ok(priorDownload < nextEncode);
        assert.ok(f.events.slice(priorDownload, nextEncode).some(event => event[0] === 'width' && event[1] === 0));
    }
});

test('export encoding failures and unsupported canvas release their resources', async () => {
    for (const settings of [
        { encode: done => done(null), code: 'collection_image_encode' },
        { encode: done => done(new Blob(['not png'], { type: 'text/plain' })), code: 'collection_image_encode' },
        { encode() { throw Object.assign(new Error('canvas failure'), { code: 'native_canvas_failure' }); }, code: 'native_canvas_failure' },
        { contextAvailable: false, code: 'collection_image_unavailable' },
    ]) {
        const f = fixture(settings);
        await assert.rejects(exportTextCollectionImages({ ...f, text: '正文', yieldControl: async () => {} }), { code: settings.code, exportedPages: 0 });
        assert.equal(f.canvas.width, 0);
        assert.equal(f.canvas.height, 0);
        assert.equal(f.files.length, 0);
    }
});

test('aborting a pending encoding releases canvas, and the late callback cannot download', async () => {
    const controller = new AbortController();
    let encoded, started;
    const whenStarted = new Promise(resolve => { started = resolve; });
    const f = fixture({ encode: done => { encoded = done; started(); } });
    const saving = exportTextCollectionImages({ ...f, text: '正文', signal: controller.signal, yieldControl: async () => {} });
    await whenStarted;
    controller.abort();
    await assert.rejects(saving, { name: 'AbortError', exportedPages: 0 });
    encoded(new Blob(['late png'], { type: 'image/png' }));
    assert.equal(f.files.length, 0);
    assert.equal(f.canvas.width, 0);
    assert.equal(f.canvas.height, 0);
});

test('owner change while encoding blocks the late download', async () => {
    let active = true;
    const f = fixture({ encode: done => { active = false; done(new Blob(['png'], { type: 'image/png' })); } });
    await assert.rejects(exportTextCollectionImages({ ...f, text: '正文', isCurrent: () => active, yieldControl: async () => {} }), { name: 'AbortError' });
    assert.equal(f.files.length, 0);
    assert.equal(f.canvas.width, 0);
});

test('download failure reports only completed pages and does not encode a following page', async () => {
    const f = fixture();
    let calls = 0;
    await assert.rejects(exportTextCollectionImages({ ...f, text: '长文'.repeat(5000), yieldControl: async () => {}, download: async (...args) => {
        if (++calls === 2) throw Object.assign(new Error('download rejected'), { code: 'test_download' });
        return f.download(...args);
    } }), { code: 'test_download', exportedPages: 1 });
    assert.equal(f.images.length, 2);
    assert.equal(f.files.length, 1);
    assert.equal(f.canvas.width, 0);
});

test('cancelling after one successful download does not generate the next image', async () => {
    const f = fixture(), controller = new AbortController();
    await assert.rejects(exportTextCollectionImages({ ...f, text: '长文'.repeat(5000), signal: controller.signal, yieldControl: async () => {}, download: async (...args) => {
        await f.download(...args);
        controller.abort();
    } }), { name: 'AbortError', exportedPages: 1 });
    assert.equal(f.images.length, 1);
});

test('default yielding completes and returns no retained canvas or blob collection', async () => {
    const f = fixture();
    assert.deepEqual(await exportTextCollectionImages({ ...f, text: '短摘录' }), { pages: 1 });
    assert.equal(f.canvas.width, 0);
    assert.equal(f.canvas.height, 0);
});

test('filename prefix cannot inject a path or HTML into the local download name', async () => {
    const f = fixture();
    await exportTextCollectionImages({ ...f, text: '正文', filenamePrefix: '../<title>:"bad"\\path?*.png', yieldControl: async () => {} });
    assert.doesNotMatch(f.files[0].filename, /[<>:"/\\|?*\u0000-\u001f]/);
    assert.match(f.files[0].filename, /-001\.png$/);
});
