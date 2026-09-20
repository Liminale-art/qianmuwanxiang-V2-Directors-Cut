// Actual collection exporter and canvas in isolated Edge. Synthetic prose only.
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
const save=()=>page.locator('[data-collection-manage="image-save"]'),close=()=>page.locator('[data-collection-manage="image-close"]');
async function exported(){await page.waitForFunction(()=>/^已生成 /.test(document.querySelector('[role="status"]')?.textContent));}
async function open(text){await page.evaluate(text=>{fixture.ui?.stop();if(text!==undefined)fixture.original={...fixture.original,text};fixture.open();},text);}
async function screenshotImage(index,name){const data=await page.evaluate(index=>fixture.downloads[index].data,index);await writeFile(path.join(artifacts,name),Buffer.from(data.split(',')[1],'base64'));}
try{
    await page.goto('https://qianmu.test/');await page.addStyleTag({content:await readFile(new URL('../qianmu-text-collection.css',import.meta.url),'utf8')});
    await page.evaluate(async()=>{
        const {openTextCollectionImageExport}=await import('./qianmu-text-collection-image-export.js');
        const host=document.getElementById('fixture');host.style.cssText='--sd-sticky-bg:#292b2f;--sd-text:#f0f0f0;--sd-muted:#bbb;--qm-accent:#a7c4b5;--qm-collection-prose-font:sans-serif';
        const text='夜色漫过窗沿。\n那些未曾说出口的心事，此刻都有了安静的去处。';
        window.fixture={current:true,namespace:'alice',host,downloads:[],draws:[],rects:[],text,original:{source:{charName:'林间',userName:'旅人'},createdAt:Date.UTC(2026,8,20),text}};
        const fillText=CanvasRenderingContext2D.prototype.fillText,fillRect=CanvasRenderingContext2D.prototype.fillRect;
        CanvasRenderingContext2D.prototype.fillText=function(text,x,y,...args){fixture.draws.push({text,x,y,align:this.textAlign,width:this.canvas.width,height:this.canvas.height});return fillText.call(this,text,x,y,...args);};
        CanvasRenderingContext2D.prototype.fillRect=function(x,y,w,h){fixture.rects.push({x,y,w,h,width:this.canvas.width,height:this.canvas.height});return fillRect.call(this,x,y,w,h);};
        fixture.open=()=>{fixture.current=true;fixture.namespace='alice';fixture.ui=openTextCollectionImageExport({parent:host,record:fixture.original,isCurrent:()=>fixture.current,guard:async()=>{if(fixture.namespace!=='alice')throw Error('账户已变化，请重新打开');},download:fixture.useNative?undefined:async(blob,name)=>{
            const bitmap=await createImageBitmap(blob),canvas=document.createElement('canvas');canvas.width=bitmap.width;canvas.height=bitmap.height;canvas.getContext('2d').drawImage(bitmap,0,0);
            fixture.downloads.push({name,type:blob.type,size:blob.size,width:bitmap.width,height:bitmap.height,data:canvas.toDataURL('image/png')});bitmap.close();canvas.width=canvas.height=1;
        }});};fixture.open();
        const original=HTMLCanvasElement.prototype.toBlob;
        fixture.holdCanvas=()=>{HTMLCanvasElement.prototype.toBlob=function(callback,...args){original.call(this,blob=>{fixture.release=()=>callback(blob);},...args);};};
        fixture.restoreCanvas=()=>{HTMLCanvasElement.prototype.toBlob=original;};
    });
    assert.equal(await page.locator('textarea').count(),0);
    assert.equal(await page.locator('[data-image-header]').inputValue(),'林间 & 旅人');assert.equal(await page.locator('[data-image-footer]').inputValue(),'2026-09-20');
    for(const width of [320,393,1280]){
        await page.setViewportSize({width,height:850});const box=await page.locator('dialog').evaluate(node=>({w:node.getBoundingClientRect().width,h:node.getBoundingClientRect().height,scroll:node.scrollWidth,client:node.clientWidth}));
        assert.ok(box.h<380&&box.w<=420&&box.w<=width&&box.scroll<=box.client+1,JSON.stringify(box));
    }
    await page.setViewportSize({width:393,height:850});await page.screenshot({path:path.join(artifacts,'collection_export_compact.png')});
    checks.push('only annotation toggle and header/footer fields in a compact dialog at 320/393/1280px; no body re-edit');
    await save().click();await exported();assert.equal(await page.evaluate(()=>fixture.downloads.length),1);
    const first=await page.evaluate(()=>fixture.downloads[0]);assert.equal(first.width,1080);assert.equal(first.height,1080);assert.equal(first.type,'image/png');assert.ok(first.size>1000);
    const draw=await page.evaluate(()=>fixture.draws),body=draw.filter(call=>!['林间 & 旅人','2026-09-20'].includes(call.text));
    assert.ok(body[0].y>350&&body.at(-1).y<700);assert.equal(draw.find(call=>call.text==='2026-09-20').align,'right');
    await screenshotImage(0,'collection_short_dark.png');checks.push('short body is vertically centred in a square PNG, decorations remain in their corners');
    await open('一句值得留下的话。');await page.locator('[data-image-annotate]').uncheck();assert.equal(await page.locator('[data-image-header]').isDisabled(),true);
    await page.evaluate(()=>{fixture.draws=[];fixture.rects=[];});await save().click();await exported();
    const single=await page.evaluate(()=>fixture.draws);assert.equal(single.length,1);assert.equal(single[0].text,'一句值得留下的话。');assert.ok(single[0].y>480&&single[0].y<560&&single[0].x>250);
    await screenshotImage(1,'collection_one_sentence.png');checks.push('one-sentence export is centred horizontally and vertically; switching annotation off preserves field values but draws neither');
    await page.evaluate(()=>{fixture.host.style.setProperty('--sd-sticky-bg','#faf8f0');fixture.host.style.setProperty('--sd-text','#292b2f');fixture.host.style.setProperty('--sd-muted','#676863');});
    await open('灯'.repeat(8000));await page.locator('[data-image-annotate]').uncheck();await page.evaluate(()=>{fixture.draws=[];fixture.rects=[];});
    await save().click();await exported();const long=await page.evaluate(()=>fixture.downloads.slice(2));
    assert.ok(long.length>3);assert.equal(new Set(long.map(image=>image.name)).size,long.length);assert.ok(long.every(image=>image.height<=2560&&image.height>=1080));
    assert.equal(await page.evaluate(()=>fixture.draws.map(call=>call.text).join('')),'灯'.repeat(8000));
    assert.equal(await page.evaluate(()=>fixture.rects.every(rect=>rect.x===0&&rect.y===0&&rect.w===rect.width&&rect.h===rect.height)),true);
    assert.match(await page.locator('[role="status"]').textContent(),/允许多文件下载/);await screenshotImage(2,'collection_long_light_page1.png');
    checks.push(`all 8000 characters exported intact across ${long.length} sequential pages; long prose uses the full column, no truncation or three-page limit`);
    const count=await page.evaluate(()=>fixture.downloads.length);
    await open('取消测试');await page.evaluate(()=>{fixture.release=null;fixture.holdCanvas();});await save().click();await page.waitForFunction(()=>typeof fixture.release==='function');await close().click();await page.evaluate(()=>{fixture.release();fixture.restoreCanvas();});await page.waitForTimeout(100);
    assert.equal(await page.evaluate(()=>fixture.downloads.length),count);assert.equal(await page.locator('dialog').count(),0);checks.push('closing during canvas encoding prevents all late downloads');
    await open('账号切换测试');await page.evaluate(()=>{fixture.release=null;fixture.holdCanvas();});await save().click();await page.waitForFunction(()=>typeof fixture.release==='function');await page.evaluate(()=>{fixture.namespace='bob';fixture.release();fixture.restoreCanvas();});await page.waitForFunction(()=>document.querySelector('[role="status"]').textContent.includes('账户已变化'));
    assert.equal(await page.evaluate(()=>fixture.downloads.length),count);await close().click();checks.push('account validation repeats before each page download');
    await open('长文取消'.repeat(10000));await save().click();await close().click();await page.waitForTimeout(100);assert.equal(await page.evaluate(()=>fixture.downloads.length),count);assert.equal(await page.locator('dialog').count(),0);
    checks.push('chunked long-text layout yields to UI and can be cancelled before encoding');
    await page.evaluate(()=>{
        fixture.useNative=true;fixture.urls=new Set();fixture.peakUrls=0;fixture.nativeClicks=0;
        const create=URL.createObjectURL,revoke=URL.revokeObjectURL,click=HTMLAnchorElement.prototype.click;
        URL.createObjectURL=function(blob){const url=create.call(this,blob);fixture.urls.add(url);fixture.peakUrls=Math.max(fixture.peakUrls,fixture.urls.size);return url;};
        URL.revokeObjectURL=function(url){fixture.urls.delete(url);return revoke.call(this,url);};
        HTMLAnchorElement.prototype.click=function(){fixture.nativeClicks++;};
        fixture.restoreNative=()=>{URL.createObjectURL=create;URL.revokeObjectURL=revoke;HTMLAnchorElement.prototype.click=click;fixture.useNative=false;};
    });
    await open('完整导出'.repeat(500));await save().click();await exported();
    assert.ok(await page.evaluate(()=>fixture.nativeClicks>1));assert.equal(await page.evaluate(()=>fixture.peakUrls),1);assert.equal(await page.evaluate(()=>fixture.urls.size),0);
    await close().click();await page.evaluate(()=>fixture.restoreNative());checks.push('default download lifecycle holds at most one PNG object URL, releasing it before preparing the next page');
    await open('快捷键');await page.keyboard.press('Escape');assert.equal(await page.locator('dialog').count(),0);
    assert.deepEqual(errors,[]);assert.equal(external,0);process.stdout.write(JSON.stringify({count:checks.length,checks,artifacts,externalRequests:external,productionWrites:false,pageErrors:errors},null,2)+'\n');
}finally{await context.close();await browser.close();}
