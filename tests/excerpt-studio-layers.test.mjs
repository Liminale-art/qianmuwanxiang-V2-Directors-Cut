import test from 'node:test';
import assert from 'node:assert/strict';
import {parseExcerptTemplate, excerptFields} from '../features/excerpt/qianmu-excerpt-template.js';
import {createDoc, createDocFromScheme, schemeFromDoc, normalizeScheme, normalizeDoc, normalizeElement, normalizeProps, normalizeLock,
    makeContinuationPage, BLEND_MODES} from '../features/excerpt/qianmu-excerpt-doc.js';
import {layoutDoc, elementCss} from '../features/excerpt/qianmu-excerpt-render.js';

const fields = excerptFields({charName: '沈砚', userName: '阿遥', floor: 42});
const twoBoxDoc = body => {
    const template = parseExcerptTemplate(`<section data-page="first" data-height="1000">
      <div data-qm="text" style="left:0px;top:0px;width:400px;height:40px">{{char}}</div>
      <div data-qm="body" style="left:0px;top:100px;width:200px;height:120px"></div>
      <div data-qm="body" style="left:300px;top:100px;width:200px;height:120px"></div>
    </section><section data-page="rest"><div data-qm="body" style="left:0px;top:0px;width:200px;height:600px"></div></section>`).template;
    return createDoc({template, templateId: 'custom:t', body, fields});
};
// 与 excerpt-studio-model 里同一种假测量：按框宽 / 字号算每行字数、框高 / 行高算行数。
function fakeMeasurer() {
    let box = null, lines = 0;
    return {
        prepare(doc, element) { const size = element.props?.size || 20; box = {h: element.h, perLine: Math.max(1, Math.floor(element.w / size)), lineHeight: size * 1.5}; lines = 0; },
        fill(paragraphs) { lines = paragraphs.reduce((sum, text) => sum + Math.max(1, Math.ceil(Array.from(text).length / box.perLine)), 0); },
        fits() { return lines * box.lineHeight <= box.h; },
        dispose() {},
    };
}

test('old drafts without layer fields open unchanged: not hidden, nothing locked, same inline style', () => {
    const legacy = {kind: 'rect', id: 'e_old', x: 10, y: 20, w: 30, h: 40, props: {fill: '#ff0000', opacity: 0.4}};
    const element = normalizeElement(legacy);
    assert.equal(element.hidden, false);
    assert.deepEqual(element.lock, {pos: false, style: false});
    assert.equal(elementCss(element, {z: 2}), elementCss({...legacy, cls: '', base: ''}, {z: 2}));
    const doc = JSON.parse(JSON.stringify(twoBoxDoc('正文')));
    for (const page of doc.pages) for (const item of page.elements) { delete item.hidden; delete item.lock; }
    const reopened = normalizeDoc(doc);
    assert.ok(reopened.pages[0].elements.every(item => item.hidden === false && item.lock.pos === false && item.lock.style === false));
    assert.deepEqual(normalizeLock(undefined), {pos: false, style: false});
    assert.deepEqual(normalizeLock({pos: 1, style: 'yes'}), {pos: false, style: false}, 'only real booleans lock');
});

test('blend modes are a fixed list; opacity and blend reach the inline style the export also uses', () => {
    assert.ok(BLEND_MODES.includes('multiply') && BLEND_MODES.includes('normal'));
    assert.deepEqual(normalizeProps({blend: 'multiply', opacity: 0.5}), {opacity: 0.5, blend: 'multiply'});
    assert.deepEqual(normalizeProps({blend: 'plus-lighter;color:red'}), {}, 'unknown blend values are dropped');
    assert.deepEqual(normalizeProps({opacity: 3}), {opacity: 1});
    const css = elementCss({kind: 'text', x: 0, y: 0, w: 1, h: 1, props: {opacity: 0.5, blend: 'screen'}});
    assert.match(css, /opacity:0\.5/); assert.match(css, /mix-blend-mode:screen/);
    assert.doesNotMatch(elementCss({kind: 'text', x: 0, y: 0, w: 1, h: 1, props: {}}), /mix-blend-mode/);
});

test('hidden and lock survive storage, schemes and continuation pages', () => {
    const doc = twoBoxDoc('正文');
    const [title, first] = doc.pages[0].elements;
    title.hidden = true; title.lock = {pos: true, style: false};
    first.lock = {pos: false, style: true}; first.props.blend = 'multiply';
    const stored = normalizeDoc(JSON.parse(JSON.stringify(doc)));
    assert.equal(stored.pages[0].elements[0].hidden, true);
    assert.deepEqual(stored.pages[0].elements[0].lock, {pos: true, style: false});
    assert.deepEqual(stored.pages[0].elements[1].lock, {pos: false, style: true});
    assert.equal(stored.pages[0].elements[1].props.blend, 'multiply');
    const next = createDocFromScheme(normalizeScheme(JSON.parse(JSON.stringify(schemeFromDoc(doc)))), {body: '另一段', fields});
    assert.equal(next.pages[0].elements[0].hidden, true);
    assert.deepEqual(next.pages[0].elements[0].lock, {pos: true, style: false});
    doc.pages.push({...makeContinuationPage(doc), kind: 'rest'});
    doc.pages[1].elements[0].lock = {pos: true, style: true};
    assert.deepEqual(makeContinuationPage(doc).elements[0].lock, {pos: true, style: true}, 'later continuation pages copy the last one');
});

test('a hidden body box takes no text; the text flows on to the next visible box', () => {
    const body = '字'.repeat(60);
    const doc = twoBoxDoc(body);
    const [, a, b] = doc.pages[0].elements;
    let result = layoutDoc(doc, {measurer: fakeMeasurer(), makePage: () => makeContinuationPage(doc)});
    const both = result.pages[0].slices;
    assert.ok(both[a.id].end > both[a.id].start && both[b.id].start === both[a.id].end);
    a.hidden = true;
    result = layoutDoc(doc, {measurer: fakeMeasurer(), makePage: () => makeContinuationPage(doc)});
    assert.equal(result.pages[0].slices[a.id], undefined, 'hidden box gets no slice');
    assert.equal(result.pages[0].slices[b.id].start, 0, 'next box starts where the hidden one would have');
    const placed = result.pages.flatMap(page => Object.values(page.slices)).reduce((sum, slice) => sum + slice.end - slice.start, 0);
    assert.equal(placed, body.length, 'no text is lost');
});
