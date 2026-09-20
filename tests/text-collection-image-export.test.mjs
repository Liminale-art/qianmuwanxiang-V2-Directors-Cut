import test from 'node:test';
import assert from 'node:assert/strict';
import {layoutCollectionImage,renderCollectionImages} from '../qianmu-text-collection-image-export.js';

const measure=text=>[...new Intl.Segmenter(undefined,{granularity:'grapheme'}).segment(text)].length*34;
test('short collection is square with 2em first-line indentation and intact paragraph text',()=>{
    const pages=layoutCollectionImage({text:'第一段文字。\n第二段文字。',header:'角色 & 用户',footer:'2026-09-20',measure});
    assert.equal(pages.length,1);assert.equal(pages[0].width,1080);assert.equal(pages[0].height,1080);
    assert.deepEqual(pages[0].lines.map(line=>line.indent),[68,68]);
    assert.equal(pages[0].lines.map(line=>line.text).join('\n'),'第一段文字。\n第二段文字。');
    assert.equal(pages[0].centered,true);assert.ok(pages[0].lines[0].y>400);assert.ok(pages[0].lines[0].x>200);
    const one=layoutCollectionImage({text:'一句话',measure})[0].lines[0];assert.equal(one.indent,0);assert.equal(one.x,(1080-measure(one.text))/2);
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
test('all long collection text exports beyond three pages without an artificial text limit',()=>{
    for(const length of [8000,30001,200000]){
        const text='文'.repeat(length),pages=layoutCollectionImage({text,measure});
        assert.ok(pages.length>3);assert.ok(pages.every(page=>page.height<=2560));
        assert.equal(pages.flatMap(page=>page.lines).map(line=>line.text).join(''),text);
        assert.equal(pages[0].centered,undefined);assert.equal(pages[0].lines[0].y,84);
    }
    assert.throws(()=>layoutCollectionImage({text:'  ',measure}),/没有可保存/);
    assert.throws(()=>layoutCollectionImage({text:'文',header:'名'.repeat(161),measure}),/160/);
});

test('encoding yields one released canvas at a time and supports cancellation between pages',async()=>{
    const canvases=[],controller=new AbortController();
    const document={createElement(){const canvas={width:300,height:150,getContext:()=>({measureText:value=>({width:measure(value)}),fillRect(){},fillText(){}}),toBlob(callback){queueMicrotask(()=>callback(new Blob(['image'])));}};canvases.push(canvas);return canvas;}};
    const output=renderCollectionImages({document,text:'文'.repeat(8000),signal:controller.signal});
    const first=await output.next();assert.equal(first.done,false);assert.ok(first.value.total>3);assert.equal(first.value.index,0);
    assert.equal(canvases.length,2);assert.ok(canvases.every(canvas=>canvas.width===1&&canvas.height===1));
    controller.abort();await assert.rejects(output.next(),{name:'AbortError'});assert.equal(canvases.length,2);
});
