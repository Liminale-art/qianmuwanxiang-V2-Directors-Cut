// Real canvas/layout in isolated Edge; synthetic prose only, no ST account/data.
import assert from 'node:assert/strict';
import {readFile,mkdtemp,writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import os from 'node:os';
import path from 'node:path';
const require=createRequire(import.meta.url),{chromium}=require(process.env.QIANMU_PLAYWRIGHT_MODULE||'playwright');
const browser=await chromium.launch({channel:process.env.QIANMU_BROWSER_CHANNEL||undefined,headless:true}),context=await browser.newContext(),page=await context.newPage();
const allowed=new Set(['qianmu-text-collection-image-export.js','qianmu-text-collection-presentation.js','qianmu-icon-renderer.js']);
const errors=[],checks=[];let external=0;
const artifacts=await mkdtemp(path.join(os.tmpdir(),'qianmu-collection-image-'));
page.on('pageerror',cause=>errors.push(cause.message));
await context.route('**/*',async route=>{
    const url=new URL(route.request().url());
    if(url.origin==='https://qianmu.test'&&url.pathname==='/')return route.fulfill({contentType:'text/html',body:'<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><main id="fixture"></main>'});
    if(url.origin==='https://qianmu.test'&&allowed.has(url.pathname.slice(1)))return route.fulfill({contentType:'text/javascript',body:await readFile(new URL('../'+url.pathname.slice(1),import.meta.url),'utf8')});
    external++;return route.abort();
});
try{
    await page.goto('https://qianmu.test/');await page.addStyleTag({content:await readFile(new URL('../qianmu-text-collection.css',import.meta.url),'utf8')});
    await page.evaluate(async()=>{
        const {openTextCollectionImageExport}=await import('./qianmu-text-collection-image-export.js');
        const host=document.getElementById('fixture');host.style.cssText='--sd-sticky-bg:#292b2f;--sd-text:#f0f0f0;--sd-muted:#bbb;--qm-accent:#a7c4b5;--qm-collection-prose-font:sans-serif';
        const text='夜色漫过窗沿。两人停下交谈，望向远处亮起的第一盏灯。\n那些未曾说出口的心事，此刻仿佛都有了安静的去处。';
        window.fixture={current:true,namespace:'alice',host,downloads:[],draws:[],rects:[],text,original:{source:{charName:'林间',userName:'旅人'},createdAt:Date.UTC(2026,8,20),text}};
        const fillText=CanvasRenderingContext2D.prototype.fillText,fillRect=CanvasRenderingContext2D.prototype.fillRect;
        CanvasRenderingContext2D.prototype.fillText=function(text,x,y,...args){fixture.draws.push({text,x,y,align:this.textAlign,width:this.canvas.width,height:this.canvas.height});return fillText.call(this,text,x,y,...args);};
        CanvasRenderingContext2D.prototype.fillRect=function(x,y,w,h){fixture.rects.push({x,y,w,h,width:this.canvas.width,height:this.canvas.height});return fillRect.call(this,x,y,w,h);};
        fixture.open=()=>{fixture.current=true;fixture.namespace='alice';fixture.ui=openTextCollectionImageExport({parent:host,record:fixture.original,isCurrent:()=>fixture.current,guard:async()=>{if(fixture.namespace!=='alice')throw Error('账户已变化，请重新打开');},download:async(blob,name)=>{
            const bitmap=await createImageBitmap(blob),canvas=document.createElement('canvas');canvas.width=bitmap.width;canvas.height=bitmap.height;canvas.getContext('2d').drawImage(bitmap,0,0);
            fixture.downloads.push({name,type:blob.type,size:blob.size,width:bitmap.width,height:bitmap.height,data:canvas.toDataURL('image/png')});bitmap.close();canvas.width=canvas.height=1;
        }});};fixture.open();
        const original=HTMLCanvasElement.prototype.toBlob;
        fixture.holdCanvas=()=>{HTMLCanvasElement.prototype.toBlob=function(callback,...args){original.call(this,blob=>{fixture.release=()=>callback(blob);},...args);};};
        fixture.restoreCanvas=()=>{HTMLCanvasElement.prototype.toBlob=original;};
    });
    const save=page.locator('[data-collection-manage="image-save"]'),close=page.locator('[data-collection-manage="image-close"]'),text=page.locator('[data-image-text]'),status=()=>page.locator('[role="status"]').textContent();
    assert.equal(await page.locator('[data-image-header]').inputValue(),'林间 & 旅人');assert.equal(await page.locator('[data-image-footer]').inputValue(),'2026-09-20');
    for(const width of [320,393,1280]){
        await page.setViewportSize({width,height:850});const box=await page.locator('dialog').evaluate(node=>({w:node.getBoundingClientRect().width,h:node.getBoundingClientRect().height,scroll:node.scrollWidth,client:node.clientWidth}));
        assert.equal(box.h,width<=760?742:760);assert.ok(box.w<=width&&box.scroll<=box.client+1);
    }
    await page.setViewportSize({width:393,height:850});await page.screenshot({path:path.join(artifacts,'collection_image_editor_narrow.png')});
    await save.click();await page.waitForFunction(()=>fixture.downloads.length===1);assert.match(await status(),/已生成 1 张/);
    const first=await page.evaluate(()=>fixture.downloads[0]);assert.equal(first.width,1080);assert.equal(first.height,1080);assert.equal(first.type,'image/png');assert.ok(first.size>1000);
    const footerCall=await page.evaluate(()=>fixture.draws.find(call=>call.text==='2026-09-20'));assert.equal(footerCall.align,'right');assert.equal(footerCall.x,996);assert.ok(footerCall.y>900);
    assert.equal(await page.evaluate(()=>fixture.rects.every(rect=>rect.x===0&&rect.y===0&&rect.w===rect.width&&rect.h===rect.height)),true,'only background rectangles are drawn, never decorative rules');
    await writeFile(path.join(artifacts,'collection_short_dark.png'),Buffer.from(first.data.split(',')[1],'base64'));
    checks.push('one editor produces an actual square PNG, lower-right footer and no decorative line; no storage or model calls');
    await page.locator('[data-image-header]').fill('');await page.locator('[data-image-footer]').fill('');await text.fill('第一段。\n\n\n \n第二段。');await page.evaluate(()=>{fixture.draws=[];fixture.rects=[];});await save.click();await page.waitForFunction(()=>fixture.downloads.length===2);
    assert.equal(await page.evaluate(()=>fixture.original.text),await page.evaluate(()=>fixture.text));
    const plain=await page.evaluate(()=>fixture.draws);assert.deepEqual(plain.map(call=>call.text),['第一段。','第二段。']);assert.equal(plain[1].y-plain[0].y,68);assert.ok(plain.every(call=>call.align==='start'||call.align==='left'));
    const plainImage=await page.evaluate(()=>fixture.downloads[1]);await writeFile(path.join(artifacts,'collection_plain_text.png'),Buffer.from(plainImage.data.split(',')[1],'base64'));
    checks.push('unannotated output is only body text; redundant blank lines collapse to one paragraph gap without changing the saved original');
    await page.evaluate(()=>{fixture.host.style.setProperty('--sd-sticky-bg','#faf8f0');fixture.host.style.setProperty('--sd-text','#292b2f');fixture.host.style.setProperty('--sd-muted','#676863');});
    await page.locator('[data-image-header]').fill('林间 & 旅人');await page.locator('[data-image-footer]').fill('2026-09-20');
    await text.fill('灯'.repeat(2900));await save.click();await page.waitForFunction(()=>fixture.downloads.length===5);assert.match(await status(),/已生成 3 张/);
    const long=await page.evaluate(()=>fixture.downloads.slice(2));assert.equal(new Set(long.map(image=>image.name)).size,3);assert.ok(long.every(image=>image.height<=2560&&image.height>=1080&&image.width===1080));
    await writeFile(path.join(artifacts,'collection_long_light_page1.png'),Buffer.from(long[0].data.split(',')[1],'base64'));
    checks.push('long prose exports three real bounded PNGs with separate names using the light theme');
    await page.locator('[data-image-header]').fill('');await page.locator('[data-image-footer]').fill('');await page.evaluate(()=>{fixture.draws=[];fixture.rects=[];});await save.click();await page.waitForFunction(()=>fixture.downloads.length===8);
    assert.equal(await page.evaluate(()=>fixture.draws.map(call=>call.text).join('')),'灯'.repeat(2900));assert.equal(await page.evaluate(()=>fixture.rects.every(rect=>rect.x===0&&rect.y===0&&rect.w===rect.width&&rect.h===rect.height)),true);
    const plainLong=await page.evaluate(()=>fixture.downloads[5]);await writeFile(path.join(artifacts,'collection_plain_long_page1.png'),Buffer.from(plainLong.data.split(',')[1],'base64'));
    checks.push('all three unannotated pages contain exactly the complete body text, with no automatic page numbers or rules');
    await text.fill('文'.repeat(8000));await save.click();await page.waitForFunction(()=>document.querySelector('[role="status"]').textContent.includes('超出 3 张'));assert.equal(await page.evaluate(()=>fixture.downloads.length),8);assert.equal(await save.isDisabled(),false);
    checks.push('over-capacity prose receives an actionable limit and creates no truncated image');
    await text.fill('取消测试');await page.evaluate(()=>fixture.holdCanvas());await save.click();await page.waitForFunction(()=>typeof fixture.release==='function');await close.click();await page.evaluate(()=>{fixture.release();fixture.restoreCanvas();});await page.waitForTimeout(100);
    assert.equal(await page.evaluate(()=>fixture.downloads.length),8);assert.equal(await page.locator('dialog').count(),0);
    checks.push('closing while canvas encoding is pending prevents late downloads');
    await page.evaluate(()=>{fixture.release=null;fixture.open();fixture.holdCanvas();});await save.click();await page.waitForFunction(()=>typeof fixture.release==='function');await page.evaluate(()=>{fixture.namespace='bob';fixture.release();fixture.restoreCanvas();});await page.waitForFunction(()=>document.querySelector('[role="status"]').textContent.includes('账户已变化'));assert.equal(await page.evaluate(()=>fixture.downloads.length),8);
    await close.click();await page.evaluate(()=>fixture.open());await page.keyboard.press('Escape');assert.equal(await page.locator('dialog').count(),0);
    checks.push('account validation runs again before each download, and Escape closes the export without affecting storage');
    assert.deepEqual(errors,[]);assert.equal(external,0);process.stdout.write(JSON.stringify({count:checks.length,checks,artifacts,externalRequests:external,productionWrites:false,pageErrors:errors},null,2)+'\n');
}finally{await context.close();await browser.close();}
