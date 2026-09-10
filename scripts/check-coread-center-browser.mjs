// Real templates, wrapper functions, event branches and CSS. No real books, storage or imports.
import assert from 'node:assert/strict';
import {readFile,mkdir} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {coreadCenterFunctions} from '../tests/helpers/coread-center-fixture.mjs';
const require=createRequire(import.meta.url),{chromium}=require(process.env.QIANMU_PLAYWRIGHT_MODULE||'playwright');
const source=await readFile(new URL('../index.js',import.meta.url),'utf8');
const css=await readFile(new URL('../style.css',import.meta.url),'utf8');
const view=await readFile(new URL('../qianmu-reader-center-view.js',import.meta.url),'utf8');
const icons=await readFile(new URL('../qianmu-icon-renderer.js',import.meta.url),'utf8');
function between(start,end){const a=source.indexOf(start),b=source.indexOf(end,a+start.length);assert.ok(a>=0&&b>a,`Missing event branch: ${start}`);return source.slice(a,b);}
const click=between("    if (e.target.closest('.sd-reader-tour-skip'))", "    if (e.target.closest('.sd-reader-guide-replay'))");
const fileChange=between("    const packInput = e.target.closest('.sd-reader-pack-import-input');",'    const m = coreadMemory();');
const guardChange=between("    if (e.target.closest('.sd-reader-spoiler-filter'))",'\n');
await mkdir(new URL('../dist/local-qa/',import.meta.url),{recursive:true});
const browser=await chromium.launch({channel:process.env.QIANMU_BROWSER_CHANNEL||undefined,headless:true});
const context=await browser.newContext({hasTouch:true}),errors=[];let external=0;
await context.route('**/*',route=>{external++;return route.abort();});
const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
try{
  await page.setContent(`<style>${css}</style><style>body{margin:0;background:#222}#tour-frame{position:relative;height:320px}</style><div id="story-director-modal" class="sd-theme-dark" hidden></div><div id="sd-reader-portal" class="sd-reader-portal"><div class="sd-reader-stage"><div class="sd-reader-morepage"><div class="sd-reader-morepage-body" id="center"></div></div></div></div>`);
  await page.evaluate(async({view,icons,functions,click,fileChange,guardChange})=>{
    Object.assign(window,await import('data:text/javascript,'+encodeURIComponent(view)));
    Object.assign(window,await import('data:text/javascript,'+encodeURIComponent(icons)));
    const theme=getComputedStyle(document.getElementById('story-director-modal')),portal=document.getElementById('sd-reader-portal');
    for(const key of theme)if(key.startsWith('--sd-'))portal.style.setProperty(key,theme.getPropertyValue(key));
    window.COREAD_MEMORY_ENABLED=true;window.coreadGuideStep=null;
    window.readerDialog={bookId:'book',readBoundary:{progress:12.5},slices:[{id:1},{id:2},{id:3}]};
    window.coreadBookMeta=()=>({title:'长书名<& 用于检查窄屏显示与文本转义'.repeat(4),progress:80});
    window.coreadCurrentReadBoundarySync=()=>{throw Error('Explicit boundary must win');};
    window.coreadSafeSlices=rows=>rows.slice(0,1);
    window.htmlEscape=value=>String(value??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;');
    window.memory={spoilerProtection:true};window.coreadMemory=()=>memory;
    window.calls={save:0,invalidate:0,prepare:0,imports:[]};
    window.saveSettings=()=>calls.save++;window.coreadInvalidatePool=()=>calls.invalidate++;
    window.prepareCompanionSetup=()=>calls.prepare++;
    window.coreadImportDataFile=file=>calls.imports.push({name:file?.name,cleared:document.querySelector('.sd-reader-pack-import-input').value===''});
    window.eval(functions);
    window.rerenderMore=()=>{document.getElementById('center').innerHTML=renderCoreadCenterStatus(memory)+`<div class="sd-reader-setup-body sd-reader-center-setup">${renderCoreadSpoilerGuard(memory)}${renderCoreadPackBar()}</div><div id="tour-frame">${renderCoreadGuide()}</div>`;applyQianmuIcons(portal);};
    const root=document.getElementById('center');
    root.addEventListener('click',new Function('e',click));
    root.addEventListener('change',new Function('e',fileChange+'\nconst m=coreadMemory();\n'+guardChange));
    rerenderMore();
  },{view,icons,functions:coreadCenterFunctions,click,fileChange,guardChange});
  const layouts=[];
  for(const width of [320,360,430,1100]){
    await page.setViewportSize({width,height:850});
    await page.evaluate(()=>{coreadGuideStep=null;memory.spoilerProtection=true;calls.save=0;calls.invalidate=0;calls.imports=[];rerenderMore();});
    assert.match(await page.locator('.sd-reader-center-book-copy small').textContent(),/12.5%.*3 条记忆.*2 条进度外隔离/);
    assert.equal(await page.locator('.sd-reader-center-book-copy b').count(),1);
    await page.locator('.sd-reader-setup-guard').tap();
    assert.deepEqual(await page.evaluate(()=>[memory.spoilerProtection,calls.save,calls.invalidate]),[false,1,1]);
    await page.locator('.sd-reader-setup-guard').tap();
    assert.equal(await page.locator('.sd-reader-spoiler-filter').isChecked(),true);
    const input=page.locator('.sd-reader-pack-import-input');
    const hit=await input.evaluate(n=>{const r=n.getBoundingClientRect();return document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)===n;});
    assert.equal(hit,true,'native input itself must receive the import tap');
    await input.setInputFiles({name:'fixture.json',mimeType:'application/json',buffer:Buffer.from('{}')});
    assert.deepEqual(await page.evaluate(()=>calls.imports),[{name:'fixture.json',cleared:true}]);
    await page.evaluate(()=>{coreadGuideStep=0;rerenderMore();});
    assert.equal(await page.locator('.sd-reader-tour-prev').isDisabled(),true);
    await page.locator('.sd-reader-tour-next').tap();assert.equal(await page.evaluate(()=>coreadGuideStep),1);
    await page.locator('.sd-reader-tour-prev').tap();assert.equal(await page.evaluate(()=>coreadGuideStep),0);
    await page.evaluate(()=>{coreadGuideStep=coreadGuideSteps().length-1;rerenderMore();});
    assert.equal(await page.locator('.sd-reader-tour-next').getAttribute('title'),'完成');
    const boxes=await page.locator('.sd-reader-center-book,.sd-reader-setup-guard,.sd-reader-packbar,.sd-reader-tour').evaluateAll(nodes=>nodes.map(n=>{const r=n.getBoundingClientRect();return {x:r.x,right:r.right,width:r.width,overflow:n.scrollWidth-n.clientWidth};}));
    for(const box of boxes)assert.ok(box.x>=0&&box.right<=width+1&&box.width>0&&box.overflow<=1,JSON.stringify({width,box}));
    await page.screenshot({path:fileURLToPath(new URL(`../dist/local-qa/coread-center-${width}.png`,import.meta.url)),fullPage:true});
    await page.locator('.sd-reader-tour-next').tap();assert.deepEqual(await page.evaluate(()=>[coreadGuideStep,memory.guideSeen,memory.moreTab]),[null,true,'setup']);
    assert.equal(await page.locator('.sd-reader-tour').count(),0);
    await page.evaluate(()=>{coreadGuideStep=0;memory.guideSeen=false;rerenderMore();});
    await page.locator('.sd-reader-tour-skip').tap();assert.deepEqual(await page.evaluate(()=>[coreadGuideStep,memory.guideSeen]),[null,true]);
    layouts.push({width,boxes,nativeInputHit:hit});
  }
  assert.deepEqual(errors,[]);assert.equal(external,0);
  console.log(JSON.stringify({layouts,realEventBranches:true,realTemplates:true,external,errors,limits:'isolated DOM; no real data import, host navigation, guide positioning or physical iOS validation'}));
}finally{await context.close();await browser.close();}
