import test from 'node:test';
import assert from 'node:assert/strict';
import {BUILTIN_TEMPLATES, parseExcerptTemplate, sanitizeCss, sanitizeDecor, excerptFields, resolveFields, TEMPLATE_STARTER} from '../features/excerpt/qianmu-excerpt-template.js';
import {createDoc, createDocFromScheme, schemeFromDoc, normalizeScheme, normalizeDoc, setRatio, pageHeight, normalizeBody,
    makeContinuationPage, normalizeStudioSettings, builtinTemplate, normalizeCustomRatio, normalizeGrain, PAGE_BREAK, MAX_PAGE_HEIGHT, MIN_PAGE_HEIGHT} from '../features/excerpt/qianmu-excerpt-doc.js';
import {layoutDoc, adjustBreak, embedFonts, elementCss, imageGeometry, grainColors, grainStyle} from '../features/excerpt/qianmu-excerpt-render.js';

const fields = excerptFields({charName: '沈砚', userName: '阿遥', floor: 42, sentAt: '2023-5-20 @21h 05m 10s 1ms'});

// 假测量：按框宽 / 字号算每行字数、框高 / 行高算行数；每段至少一行。只验分页逻辑，不代表真实字形排版。
function fakeMeasurer() {
    let box = null, lines = 0, probes = 0;
    const geometry = element => {
        const size = element.props?.size || 20, lineHeight = size * 1.5;
        return {perLine: Math.max(1, Math.floor(element.w / size)), lineHeight};
    };
    return {
        prepare(doc, element) { box = {element, h: element.h, ...geometry(element)}; lines = 0; },
        fill(paragraphs) { probes++; lines = paragraphs.reduce((sum, text) => sum + Math.max(1, Math.ceil(Array.from(text).length / box.perLine)), 0); },
        fits() { return lines * box.lineHeight <= box.h; },
        get probes() { return probes; },
        dispose() {},
    };
}
const flowDoc = (body, options = {}) => {
    const template = parseExcerptTemplate(`<section data-page="first" data-height="1000">
      <div data-qm="text" style="left:0px;top:0px;width:400px;height:40px">{{char}}</div>
      <div data-qm="body" style="left:0px;top:100px;width:200px;height:300px"></div>
      <div data-qm="text" style="left:0px;top:600px;width:400px;height:40px">第 {{floor}} 层</div>
    </section><section data-page="rest"><div data-qm="body" style="left:0px;top:0px;width:200px;height:600px"></div></section>`).template;
    return createDoc({template, templateId: 'custom:t', body, fields: options.fields || fields, ratio: options.ratio || 'tpl'});
};
const layout = (doc, options = {}) => layoutDoc(doc, {measurer: fakeMeasurer(), makePage: () => makeContinuationPage(doc), ...options});

test('all built-in templates parse in the same format users write, with flow boxes and a continuation page', () => {
    for (const item of BUILTIN_TEMPLATES) {
        const parsed = parseExcerptTemplate(item.source);
        assert.equal(parsed.ok, true, item.id);
        assert.ok(parsed.template.first.elements.some(element => element.kind === 'body'), item.id);
        assert.ok(parsed.template.rest?.elements.some(element => element.kind === 'body'), item.id);
        assert.match(parsed.template.paper, /^#[0-9a-f]{6}$/);
    }
    const night = parseExcerptTemplate(BUILTIN_TEMPLATES.find(item => item.id === 'builtin:night').source).template;
    const flows = night.first.elements.filter(element => element.kind === 'body');
    assert.deepEqual(flows.map(element => element.vertical), [true, true], 'night template reads in vertical columns');
    assert.ok(flows[0].x > flows[1].x, 'vertical flow starts at the right-hand box');
    assert.equal(parseExcerptTemplate(TEMPLATE_STARTER).ok, true);
});

test('template sanitizer drops scripts, handlers, images and remote resources but keeps data: textures', () => {
    const parsed = parseExcerptTemplate(`<style>@import url(https://x.test/a.css); .a{background:url("https://x.test/p.png")} .b{background:url(data:image/png;base64,AA)} .c{background:\\75rl(https://x.test/e.png)} .d{background-image:image-set("https://x.test/i.png" 1x)}</style>
      <section data-page="first"><div data-qm="text" onclick="alert(1)" class="ok qm-sneaky" style="left:1px;top:2px;width:3px;height:4px;background:url(http://x.test)">Hi<script>alert(1)</script></div>
      <img src="x" onerror="alert(1)"><iframe src="https://x.test"></iframe><p class="deco" onmouseover="x">装饰<b>粗</b></p><svg viewBox="0 0 2 2"><path d="M0 0" fill="url(#g)" onload="x"/></svg></section>`);
    assert.equal(parsed.ok, true);
    const {css, first} = parsed.template;
    assert.doesNotMatch(css, /url\(\s*["']?https?:|@import/i);
    assert.match(css, /data:image\/png;base64,AA/);
    assert.doesNotMatch(css, /image-set\(/i);
    assert.equal(first.elements[0].cls, 'ok');
    assert.equal(first.elements[0].src, 'Hi');
    assert.doesNotMatch(first.elements[0].base, /http/);
    assert.equal(first.decor, '<p class="deco">装饰<b>粗</b></p><svg viewBox="0 0 2 2"><path d="M0 0"></path></svg>');
    assert.equal(sanitizeDecor('<div onclick="x" style="color:red">a</div><script>b</script>'), '<div style="color:red">a</div>');
    assert.equal(sanitizeCss('a{}</style><script>'), 'a{}/style>script>');
    assert.equal(parseExcerptTemplate('<div>no section</div>').ok, false);
});

test('placeholder fields: floor, dates, weekday and the lunar date come from the floor; missing values stay empty', () => {
    assert.equal(fields.pair, '沈砚 与 阿遥');
    assert.equal(fields.floor, '42');
    assert.equal(fields.date, '2023年5月20日');
    assert.equal(fields.md, '5/20');
    assert.equal(fields.time, '21:05');
    assert.equal(fields.weekday, '星期六');
    assert.equal(fields.lunar, '癸卯年四月初二');
    assert.equal(excerptFields({sentAt: 'November 26, 2026 9:05pm'}).time, '21:05');
    assert.equal(excerptFields({}).date, '');
    assert.equal(resolveFields('{{char}}·{{nope}}', fields), '沈砚·{{nope}}');
});

test('a new document fills fields, drops boxes whose fields are all empty, and keeps the body as an independent copy', () => {
    const doc = flowDoc('第一段\n\n\n第二段  \n', {fields: excerptFields({charName: '沈砚'})});
    assert.deepEqual(doc.pages[0].elements.map(element => element.kind), ['text', 'body']);
    assert.equal(doc.pages[0].elements[0].text, '沈砚');
    assert.equal(doc.body, '第一段\n第二段');
    assert.equal(normalizeBody('a\n\f\nb'), `a${PAGE_BREAK}b`);
});

test('scheme round trip: untouched field boxes follow the next excerpt, edited text stays literal', () => {
    const doc = flowDoc('正文');
    doc.pages[0].elements[0].props.color = '#123456';
    doc.pages[0].elements[2].text = '第三卷'; doc.pages[0].elements[2].src = null;
    const scheme = normalizeScheme(JSON.parse(JSON.stringify(schemeFromDoc(doc))));
    assert.ok(scheme);
    const next = createDocFromScheme(scheme, {body: '另一段', fields: excerptFields({charName: '林深', floor: 7})});
    const [title, , note] = next.pages[0].elements;
    assert.equal(title.text, '林深'); assert.equal(title.props.color, '#123456');
    assert.equal(note.text, '第三卷');
    assert.equal(next.body, '另一段');
    assert.notEqual(title.id, doc.pages[0].elements[0].id);
});

test('ratio change rescales vertical positions only', () => {
    const doc = flowDoc('正文');
    const body = doc.pages[0].elements.find(element => element.kind === 'body');
    assert.equal(pageHeight(doc), 1000);
    setRatio(doc, '1:1');
    assert.equal(pageHeight(doc), 1080);
    assert.equal(body.y, 108); assert.equal(body.h, 324); assert.equal(body.x, 0); assert.equal(body.w, 200);
});

test('custom ratio: integer W:H, width stays 1080, height clamped; removed or broken ratios fall back to the template', () => {
    assert.equal(normalizeCustomRatio('5:7'), '5:7');
    for (const bad of ['0:3', '3:0', '1.5:2', '100:1', 'a:b', '', null, '4:5:6']) assert.equal(normalizeCustomRatio(bad), '', String(bad));
    const doc = flowDoc('正文');
    assert.equal(setRatio(doc, 'custom', 'x'), false);
    assert.equal(setRatio(doc, 'custom', '5:7'), true);
    assert.equal(pageHeight(doc), Math.round(1080 * 7 / 5));
    assert.equal(setRatio(doc, 'custom', '5:7'), false, 'same custom ratio is not a change');
    setRatio(doc, 'custom', '1:99');
    assert.equal(pageHeight(doc), MAX_PAGE_HEIGHT);
    setRatio(doc, 'custom', '99:1');
    assert.equal(pageHeight(doc), MIN_PAGE_HEIGHT);
    setRatio(doc, 'custom', '4:3');
    const stored = normalizeDoc(JSON.parse(JSON.stringify(doc)));
    assert.equal(stored.ratio, 'custom'); assert.equal(stored.customRatio, '4:3'); assert.equal(pageHeight(stored), 810);
    const scheme = normalizeScheme(JSON.parse(JSON.stringify(schemeFromDoc(doc))));
    assert.equal(pageHeight(createDocFromScheme(scheme, {body: 'x'})), 810);
    const old = JSON.parse(JSON.stringify(flowDoc('正文')));
    old.ratio = 'auto';
    assert.equal(normalizeDoc(old).ratio, 'tpl');
    assert.equal(normalizeScheme({...JSON.parse(JSON.stringify(schemeFromDoc(flowDoc('x')))), ratio: 'auto'}).ratio, 'tpl');
    assert.equal(normalizeDoc({...old, ratio: 'custom', customRatio: 'bad'}).ratio, 'tpl');
    assert.equal(pageHeight({ratio: 'auto', template: {height: 1234}}), 1234);
});

test('paper grain is stored with the doc and scheme, clamped, and its colour follows the paper', () => {
    assert.deepEqual(normalizeGrain(undefined), {amount: 0, size: 3});
    assert.deepEqual(normalizeGrain({amount: 140, size: 0.2}), {amount: 100, size: 1});
    const doc = flowDoc('正文');
    assert.deepEqual(doc.grain, {amount: 0, size: 3});
    doc.grain = {amount: 35, size: 5};
    assert.deepEqual(normalizeDoc(JSON.parse(JSON.stringify(doc))).grain, {amount: 35, size: 5});
    const scheme = normalizeScheme(JSON.parse(JSON.stringify(schemeFromDoc(doc))));
    assert.deepEqual(createDocFromScheme(scheme, {body: 'x'}).grain, {amount: 35, size: 5});
    const light = grainColors('#f2ede3'), dark = grainColors('#121010');
    const lightness = value => Number(/(\d+(?:\.\d+)?)%\)$/.exec(value)[1]);
    assert.ok(lightness(light.main) < 50, 'darker specks on light paper');
    assert.ok(lightness(dark.main) > 30, 'lighter specks on dark paper');
    assert.match(light.main, /^hsl\(4\d\.\d /, 'specks keep the paper hue');
    const calls = [];
    const ctx = {grainTile: (paper, size) => { calls.push([paper, size]); return {src: 'data:image/png;base64,AA', size: 300}; }};
    assert.equal(grainStyle({...doc, grain: {amount: 0, size: 3}}, ctx), '');
    assert.match(grainStyle(doc, ctx), /background-size:300px 300px;opacity:0.35/);
    assert.deepEqual(calls, [[doc.paper, 5]]);
});

test('layout name: template name on a new doc, scheme name when started from a scheme, kept through storage', () => {
    const doc = flowDoc('正文');
    assert.equal(doc.name, doc.template.name);
    doc.name = '我的方案';
    const scheme = normalizeScheme(JSON.parse(JSON.stringify(schemeFromDoc(doc))));
    assert.equal(scheme.name, '我的方案');
    assert.equal(createDocFromScheme(scheme, {body: 'x'}).name, '我的方案');
    assert.equal(createDocFromScheme(scheme, {body: 'x', name: '列表里的名字'}).name, '列表里的名字');
    doc.name = '';
    assert.equal(normalizeDoc(JSON.parse(JSON.stringify(doc))).name, '');
    const legacy = JSON.parse(JSON.stringify(doc)); delete legacy.name; delete legacy.grain;
    const reopened = normalizeDoc(legacy);
    assert.equal(reopened.name, ''); assert.deepEqual(reopened.grain, {amount: 0, size: 3});
});

test('stored drafts are revalidated: bad pieces are dropped, unsafe styles and decorations cleaned', () => {
    assert.equal(normalizeDoc({v: 2}), null);
    const doc = JSON.parse(JSON.stringify(flowDoc('正文')));
    doc.pages[0].elements[0].base = 'color:red;background:url(https://x.test)';
    doc.pages[0].decor = '<div onclick="x">d</div><script>s</script>';
    doc.pages[0].elements.push({kind: 'nope'}, {kind: 'image', x: 0, y: 0, w: 10, h: 10, image: {id: '../evil', w: 1, h: 1}});
    const normalized = normalizeDoc(doc);
    assert.equal(normalized.pages[0].decor, '<div>d</div>');
    assert.doesNotMatch(normalized.pages[0].elements[0].base, /http/);
    assert.equal(normalized.pages[0].elements.length, 4);
    assert.equal(normalized.pages[0].elements[3].image, null);
});

test('body flows through boxes, adds continuation pages, honours page breaks and removes pages it no longer needs', () => {
    const paragraph = '字'.repeat(50);
    const doc = flowDoc(Array.from({length: 8}, () => paragraph).join('\n'));
    let result = layout(doc);
    assert.ok(doc.pages.length >= 2);
    const covered = result.pages.flatMap(page => Object.values(page.slices));
    for (let index = 1; index < covered.length; index++) assert.ok(covered[index].start >= covered[index - 1].end, 'slices never overlap');
    const text = covered.map(slice => doc.body.slice(slice.start, slice.end)).join('');
    assert.equal(text.replace(/\n/g, ''), doc.body.replace(/\n/g, ''), 'every character is placed once');
    assert.equal(result.remaining, 0);
    const pagesBefore = doc.pages.length;
    doc.body = `短文${PAGE_BREAK}第二页`;
    result = layout(doc);
    assert.equal(doc.pages.length, 2, 'auto continuation pages beyond the text are removed');
    assert.ok(pagesBefore > 2);
    assert.equal(result.pages[1].breakBefore, 2);
    assert.equal(doc.body.slice(result.pages[1].slices[doc.pages[1].elements[0].id].start), '第二页');
});

test('a box too small for any text stops instead of adding pages forever', () => {
    const doc = flowDoc('一'.repeat(40));
    doc.pages[0].elements.find(element => element.kind === 'body').h = 5;
    doc.restLayout.elements[0].h = 5;
    const result = layout(doc);
    assert.equal(result.stuck, true);
    assert.ok(result.remaining > 0);
    assert.ok(doc.pages.length <= 2);
});

// 逐个二分作对照：从剩下的全部开始。新的试排从估计值起步，结果须与之相同。
function referenceCount(measurer, doc, element, start, limit) {
    const total = limit - start;
    if (total <= 0) return 0;
    measurer.prepare(doc, element);
    const fits = count => { measurer.fill(doc.body.slice(start, start + count).split('\n')); return measurer.fits(); };
    if (fits(total)) return total;
    let low = 0, high = total - 1;
    while (low < high) { const middle = Math.ceil((low + high) / 2); if (fits(middle)) low = middle; else high = middle - 1; }
    return adjustBreak(doc.body, start, low);
}

test('fitting from an estimate gives the same cuts as plain bisection, and reusing hints needs fewer probes', () => {
    const paragraph = '他说完了。然后走了，风很大'.repeat(4);
    for (const hint of [undefined, 1, 37, 5000]) {
        const doc = flowDoc(Array.from({length: 9}, () => paragraph).join('\n'));
        const hints = new Map(hint === undefined ? [] : doc.pages.flatMap(page => page.elements).filter(item => item.kind === 'body').map(item => [item.id, hint]));
        const result = layout(doc, {hints});
        const reference = fakeMeasurer();
        for (const entry of result.pages) {
            const page = doc.pages.find(item => item.id === entry.id);
            for (const element of page.elements.filter(item => item.kind === 'body')) {
                const slice = entry.slices[element.id];
                assert.equal(slice.end - slice.start, referenceCount(reference, doc, element, slice.start, doc.body.length), `hint ${hint}`);
            }
        }
    }
    const doc = flowDoc(Array.from({length: 9}, () => paragraph).join('\n'));
    const hints = new Map(), first = fakeMeasurer();
    layoutDoc(doc, {measurer: first, makePage: () => makeContinuationPage(doc), hints});
    const second = fakeMeasurer();
    layoutDoc(doc, {measurer: second, makePage: () => makeContinuationPage(doc), hints});
    assert.ok(second.probes < first.probes, `${second.probes} < ${first.probes}`);
});

test('page cuts avoid starting a box with closing punctuation or splitting a Latin word', () => {
    const body = '他说完了。然后走了';
    assert.equal(adjustBreak(body, 0, 4), 3);
    assert.equal(adjustBreak('hello world again', 0, 8), 6);
    assert.equal(adjustBreak('abc', 0, 3), 3);
});

test('style output maps user props onto inline CSS; image framing never leaves gaps', () => {
    const css = elementCss({kind: 'text', x: 1, y: 2, w: 3, h: 4, base: 'color:red', props: {size: 30, ls: 0.1, color: '#000000', align: 'justify', font: 'kai'}}, {z: 3});
    assert.match(css, /top:2px/); assert.match(css, /font-size:30px/); assert.match(css, /letter-spacing:0.1em/);
    assert.ok(css.indexOf('color:red') < css.indexOf('color:#000000'), 'user colour overrides the template');
    const g = imageGeometry(100, 100, {w: 200, h: 100, cx: 0, cy: 0.5, zoom: 1});
    assert.deepEqual([g.w, g.h, g.left, g.top], [200, 100, 0, 0]);
    assert.equal(imageGeometry(100, 100, {w: 200, h: 100, cx: 1, cy: 0.5, zoom: 1}).left, -100);
});

test('studio settings keep only valid schemes and templates', () => {
    const doc = flowDoc('正文');
    const state = normalizeStudioSettings({last: schemeFromDoc(doc), schemes: [{id: 's1', name: '甲', scheme: schemeFromDoc(doc)}, {name: '坏', scheme: {v: 9}}],
        templates: [{id: 't1', source: TEMPLATE_STARTER}, {id: 't2', source: '<p>x</p>'}]});
    assert.ok(state.last);
    assert.deepEqual(state.schemes.map(item => item.name), ['甲']);
    assert.deepEqual(state.templates.map(item => item.id), ['t1']);
    assert.ok(builtinTemplate('builtin:book'));
});

test('export embeds only the font fragments the page uses', async () => {
    const fetched = [];
    const usage = new Map([['f1', 'Ab']]);
    const result = await embedFonts(usage, {
        faces: async () => [{url: 'https://f.test/latin.woff2', weight: '400', style: 'normal', unicodeRange: 'U+0041-005A'},
            {url: 'https://f.test/cjk.woff2', weight: '400', style: 'normal', unicodeRange: 'U+4E00-9FFF'}],
        fetch: async url => { fetched.push(url); return {ok: true, blob: async () => new Blob(['x'], {type: 'font/woff2'})}; },
    });
    assert.deepEqual(fetched, ['https://f.test/latin.woff2']);
    assert.equal(result.families.get('f1'), 'QmX1');
    assert.match(result.css, /@font-face\{font-family:"QmX1";src:url\("data:font\/woff2;base64,/);
});
