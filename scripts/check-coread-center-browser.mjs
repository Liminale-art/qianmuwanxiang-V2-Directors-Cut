// Real templates, wrapper functions, event branches and CSS. No real books, storage or imports.
import assert from 'node:assert/strict';
import {readFile,mkdir} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {coreadCenterFunctions,coreadRecordsFunctions} from '../tests/helpers/coread-center-fixture.mjs';
import {normalizeCoreadSource} from '../qianmu-reader.js';
const require=createRequire(import.meta.url),{chromium}=require(process.env.QIANMU_PLAYWRIGHT_MODULE||'playwright');
const source=await readFile(new URL('../index.js',import.meta.url),'utf8');
const css=await readFile(new URL('../style.css',import.meta.url),'utf8');
const view=await readFile(new URL('../qianmu-reader-center-view.js',import.meta.url),'utf8');
const icons=await readFile(new URL('../qianmu-icon-renderer.js',import.meta.url),'utf8');
function between(start,end){const a=source.indexOf(start),b=source.indexOf(end,a+start.length);assert.ok(a>=0&&b>a,`Missing event branch: ${start}`);return source.slice(a,b);}
const click=between("    if (e.target.closest('.sd-reader-tour-skip'))", "    if (e.target.closest('.sd-reader-guide-replay'))");
const fileChange=between("    const packInput = e.target.closest('.sd-reader-pack-import-input');",'    const m = coreadMemory();');
const guardChange=between("    if (e.target.closest('.sd-reader-spoiler-filter'))",'\n');
const recordClick=between("    if (e.target.closest('.sd-reader-distillprompt-save'))", "    if (e.target.closest('.sd-reader-sumitem-export'))");
const archiveClick=between("    if (e.target.closest('.sd-reader-slice-clear'))",'    // 词典册：新建词册');
const syncChange=between("    if (e.target.closest('.sd-reader-storagemode'))",'\n');
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
  await page.evaluate(({functions,normalize,handler})=>{
    coreadGuideStep=null;window.reader={normalizeCoreadSource:window.eval('('+normalize+')')};
    window.getChatStore=()=>({coreadBound:[]});window.coreadWorldSyncBusy=false;
    window.DEFAULT_DISTILL_TEXT_PROMPT='fixture';window.DEFAULT_MAINLINE_SUMMARY_PROMPT='fixture';
    window.toast=()=>{};readerDialog.messages=[];readerDialog.cursor=0;
    window.eval(functions);
    window.rerenderMore=()=>{const root=document.getElementById('center');root.innerHTML=`<div class="sd-reader-mtab-body">${renderMemRecordsTab(memory)}</div>`;root.querySelectorAll('details').forEach(n=>n.open=true);applyQianmuIcons(document.getElementById('sd-reader-portal'));};
    window.resetRecords=()=>{memory={worldSyncMode:'none',summaryItems:[{id:'fixed',title:'内置条目',text:'fixed',order:1,builtin:true},{id:'custom',title:'自定义<&',text:'custom',order:2}]};calls.save=0;rerenderMore();};
    document.getElementById('center').addEventListener('click',new Function('e','const m=coreadMemory(),morePage=document.getElementById("center");'+handler));
    resetRecords();
  },{functions:coreadRecordsFunctions,normalize:normalizeCoreadSource.toString(),handler:recordClick});
  const recordActions=[];
  for(const width of [320,360,430,1100])for(const action of ['click','tap','keyboard']){
    await page.setViewportSize({width,height:850});await page.evaluate(()=>resetRecords());
    const activate=async selector=>{const n=page.locator(selector);if(action==='keyboard'){await n.focus();await n.press('Enter');}else await n[action]();};
    assert.equal(await page.locator('.sd-reader-sumitem-del[data-id="fixed"]').count(),0);
    await activate('.sd-reader-sumitem-up[data-id="custom"]');
    assert.deepEqual(await page.evaluate(()=>[memory.summaryItems.find(x=>x.id==='custom').order,calls.save]),[1,1]);
    await activate('.sd-reader-sumitem-down[data-id="custom"]');
    assert.deepEqual(await page.evaluate(()=>[memory.summaryItems.find(x=>x.id==='custom').order,calls.save]),[2,2]);
    for(const [selector,key,value]of [['distillprompt','distillTextPrompt','new distill'],['mainlineprompt','mainlineSummaryPrompt','new mainline']]){
      await page.locator(`.sd-reader-${selector}-text`).fill('  '+value+'  ');
      const saves=await page.evaluate(()=>calls.save);await activate(`.sd-reader-${selector}-save`);
      assert.equal(await page.evaluate(key=>memory[key],key),value);assert.equal(await page.evaluate(()=>calls.save),saves+1);
      assert.equal(await page.locator(`.sd-reader-${selector}-save`).evaluate(n=>n.closest('details').open),true);
    }
    const idle=await page.evaluate(()=>calls.save);
    await page.locator('.sd-reader-sumitem[data-id="custom"] .sd-reader-promptblock-acts').evaluate(n=>n.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true})));
    assert.equal(await page.locator('.sd-reader-sumitem[data-id="custom"]').evaluate(n=>n.open),true);
    assert.equal(await page.evaluate(()=>calls.save),idle);
    await activate('.sd-reader-sumitem-del[data-id="custom"]');
    assert.deepEqual(await page.evaluate(()=>memory.summaryItems.map(x=>x.id)),['fixed']);assert.equal(await page.evaluate(()=>calls.save),idle+1);
    recordActions.push({width,action,once:true});
  }
  await page.evaluate(({archiveClick,syncChange})=>{
    window.confirmAnswer=false;
    window.coreadSetWorldSyncMode=mode=>calls.modes.push(mode);
    window.coreadOpenSliceManagerDialog=()=>calls.managers.push('slices');
    window.coreadOpenArchivePage=()=>calls.managers.push('archives');
    window.confirmDialog=async(title,message)=>{calls.confirmations.push({title,message});return confirmAnswer;};
    window.coreadClearAllSlices=async()=>{calls.clears++;};
    const root=document.getElementById('center');
    root.addEventListener('click',new Function('e',archiveClick));
    root.addEventListener('change',new Function('e',syncChange));
  },{archiveClick,syncChange});
  const recordLayouts=[];
  for(const width of [320,360,430,1100]){
    await page.setViewportSize({width,height:850});
    await page.evaluate(()=>{coreadWorldSyncBusy=false;readerDialog.slices=[{id:1},{id:2}];confirmAnswer=false;Object.assign(calls,{modes:[],managers:[],confirmations:[],clears:0});resetRecords();});
    const boxes=await page.locator('.sd-reader-memory-overview,.sd-reader-storagemode,.sd-reader-sumitem').evaluateAll(nodes=>nodes.map(n=>{const r=n.getBoundingClientRect();return {kind:n.className,x:r.x,right:r.right,width:r.width,overflow:n.scrollWidth-n.clientWidth};}));
    for(const box of boxes)assert.ok(box.x>=0&&box.right<=width+1&&box.width>0&&box.overflow<=1,JSON.stringify({width,box}));
    for(const mode of ['shared','dedicated','none'])await page.locator('.sd-reader-storagemode').selectOption(mode);
    assert.deepEqual(await page.evaluate(()=>calls.modes),['shared','dedicated','none']);
    await page.evaluate(()=>{coreadWorldSyncBusy=true;rerenderMore();});
    assert.equal(await page.locator('.sd-reader-storagemode').isDisabled(),true);
    await page.evaluate(()=>{coreadWorldSyncBusy=false;rerenderMore();});
    await page.locator('.sd-reader-slice-manage').tap();await page.locator('.sd-reader-arch-manage').tap();
    assert.deepEqual(await page.evaluate(()=>calls.managers),['slices','archives']);
    await page.locator('.sd-reader-slice-clear').tap();
    assert.deepEqual(await page.evaluate(()=>[calls.confirmations.length,calls.clears]),[1,0]);
    assert.match(await page.evaluate(()=>calls.confirmations[0].message),/本聊天里这本书.*不可恢复/);
    await page.evaluate(()=>{confirmAnswer=true;});await page.locator('.sd-reader-slice-clear').tap();
    await page.waitForFunction(()=>calls.clears===1);
    assert.equal(await page.evaluate(()=>calls.confirmations.length),2);
    await page.locator('.sd-reader-memory-overview').scrollIntoViewIfNeeded();
    await page.screenshot({path:fileURLToPath(new URL(`../dist/local-qa/coread-records-${width}.png`,import.meta.url)),fullPage:true});
    await page.evaluate(()=>{readerDialog.slices=[];rerenderMore();});
    assert.equal(await page.locator('.sd-reader-slice-clear').isDisabled(),true);
    assert.equal(await page.locator('.sd-reader-slice-manage').isEnabled(),true);
    recordLayouts.push({width,boxes,confirmationBeforeClear:true,busyDisabled:true});
  }
  assert.deepEqual(errors,[]);assert.equal(external,0);
  console.log(JSON.stringify({layouts,recordActions,recordLayouts,realEventBranches:true,realTemplates:true,external,errors,limits:'isolated DOM; no real data import/deletion/sync, host navigation, guide positioning, record expansion memory or physical iOS validation'}));
}finally{await context.close();await browser.close();}
