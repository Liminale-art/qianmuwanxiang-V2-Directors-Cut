import test from 'node:test';
import assert from 'node:assert/strict';
import {layoutCollectionImage} from '../qianmu-text-collection-image-export.js';

const measure=text=>[...new Intl.Segmenter(undefined,{granularity:'grapheme'}).segment(text)].length*34;
test('short collection is square with 2em first-line indentation and intact paragraph text',()=>{
    const pages=layoutCollectionImage({text:'第一段文字。\n第二段文字。',header:'角色 & 用户',footer:'2026-09-20',measure});
    assert.equal(pages.length,1);assert.equal(pages[0].width,1080);assert.equal(pages[0].height,1080);
    assert.deepEqual(pages[0].lines.map(line=>line.indent),[68,68]);
    assert.equal(pages[0].lines.map(line=>line.text).join('\n'),'第一段文字。\n第二段文字。');
});
test('long texts produce two or three bounded pages with no duplicated or omitted graphemes',()=>{
    for(const [length,expected] of [[1900,2],[2900,3]]){
        const text='文'.repeat(length),pages=layoutCollectionImage({text,header:'角色',footer:'日期',measure});
        assert.equal(pages.length,expected);assert.ok(pages.every(page=>page.height>=1080&&page.height<=2560));
        assert.equal(pages.flatMap(page=>page.lines).map(line=>line.text).join(''),text);
        assert.equal(pages[0].lines[0].indent,68);assert.equal(pages[1].lines[0].indent,0);
    }
});
test('emoji graphemes and long metadata are wrapped without clipping; blank runs normalize to a paragraph gap',()=>{
    const emoji='👩🏽‍🚀',text='甲'.repeat(23)+emoji+'乙\n\n'+emoji;
    const pages=layoutCollectionImage({text,header:'名字'.repeat(35),measure});
    assert.ok(pages[0].headerLines.length>1);assert.ok(pages[0].lines.every(line=>line.text!==''));
    assert.equal(pages.flatMap(page=>page.lines).map(line=>line.text).join(''),text.replace(/\n/g,''));
    assert.ok(pages.flatMap(page=>page.lines).every(line=>!line.text.endsWith('\u200d')));
    const normalized=layoutCollectionImage({text:'第一段。\n\n \r\n\t\n第二段。',measure});
    assert.deepEqual(normalized[0].lines.map(line=>line.text),['第一段。','第二段。']);
    assert.equal(normalized[0].lines[1].y-normalized[0].lines[0].y,68);
    assert.deepEqual(normalized[0].headerLines,[]);assert.deepEqual(normalized[0].footerLines,[]);
});
test('over-capacity text is explicitly rejected rather than silently truncated',()=>{
    assert.throws(()=>layoutCollectionImage({text:'文'.repeat(8000),measure}),/超出 3 张/);
    assert.throws(()=>layoutCollectionImage({text:'文'.repeat(30001),measure}),/过长/);
    assert.throws(()=>layoutCollectionImage({text:'  ',measure}),/没有可保存/);
    assert.throws(()=>layoutCollectionImage({text:'文',header:'名'.repeat(161),measure}),/160/);
});
