import assert from 'node:assert/strict';
import {readFile,mkdir} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {storyboardFunctionSource as section,createStoryboardFormFixture} from '../tests/helpers/storyboard-form-fixture.mjs';
const require=createRequire(import.meta.url),{chromium}=require(process.env.QIANMU_PLAYWRIGHT_MODULE||'playwright');
const css=await readFile(new URL('../style.css',import.meta.url),'utf8');
const forms={model:createStoryboardFormFixture().content,comfy:createStoryboardFormFixture({family:'comfy'}).content};
const functions=['storyboardPageKey','storyboardScroller','storyboardRememberPageScroll','storyboardRestorePageScroll','storyboardChangeWorkbenchEngine',
  'coreadCompanionChoices','coreadCompanionCharacter','coreadCompanionSession','coreadEnsureCompanionSession','coreadSelectCompanion','renderCoreadSessionBar','coreadContinueLast'].map(section).join('\n');
await mkdir(new URL('../dist/local-qa/',import.meta.url),{recursive:true});
const browser=await chromium.launch({channel:process.env.QIANMU_BROWSER_CHANNEL||undefined,headless:true}),context=await browser.newContext({hasTouch:true});
let external=0;const errors=[];await context.route('**/*',route=>{external++;return route.abort();});const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
try{
  await page.setContent(`<style>${css}</style><style>body{margin:0;background:#222}#story-director-modal{position:static!important;display:block!important;width:100%;box-sizing:border-box;padding:8px}#workbench{padding-top:12px}.sd-storyboard-scroll{height:340px!important;overflow:auto!important;min-height:0!important}#workbench:after{content:'';display:block;height:80px}</style><div id="story-director-modal" class="sd-theme-dark"><div id="shelf"></div><div id="workbench"></div></div>`);
  await page.evaluate(({functions,forms})=>{
    window.forms=forms;window.state={source:'novel',view:'create'};window.storyboardState=()=>state;window.storyboardPageScrolls=new Map([['create',420],['create:comfy',720]]);window.storyboardPendingRestoreScroll=null;
    window.STORYBOARD_PROVIDER_REGISTRY={novel:{}};window.storyboardCaptureWorkbench=()=>{};window.saveSettings=()=>{};
    window.readerView=null;window.coreadDistilling=false;window.coreadOpenRequestId=0;window.c={companionAvatar:'a.png',lastReading:{bookId:'book',avatar:'a.png'}};
    window.host={characterId:0,chatId:'host-chat',characters:[{avatar:'a.png',name:'书友甲 · 很长的名称用于检查窄屏'},{avatar:'b.png',name:'书友乙'}]};
    window.ctx=()=>host;window.coread=()=>c;window.getChatKey=()=>host.chatId;window.getChatStore=()=>({});window.clone=structuredClone;window.coreadInvalidatePool=()=>{};
    window.htmlEscape=s=>String(s||'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;');window.coreadBookMeta=id=>id==='book'?{id,title:'上次的书'}:null;window.toast=()=>{};
    window.coreadOpenBook=(bookId,options)=>{window.opened={bookId,...options};};
    window.eval(functions);
    window.renderShelf=()=>{const shelf=document.getElementById('shelf');shelf.innerHTML=renderCoreadSessionBar();shelf.querySelector('select').onchange=e=>coreadSelectCompanion(e.target.value);shelf.querySelector('.sd-reader-continue-last').onclick=()=>coreadContinueLast();};
    window.renderModal=()=>{
      const root=document.getElementById('workbench');storyboardRememberPageScroll(root);
      const key=storyboardPageKey(),target=storyboardPendingRestoreScroll??storyboardPageScrolls.get(key)??0;
      root.innerHTML=`<button id="model-mode">模型接口</button><button id="comfy-mode">Comfy</button><div class="sd-storyboard-scroll" data-storyboard-page="${key}">${forms[state.source==='comfy'?'comfy':'model']}<div style="height:1800px"></div></div>`;
      storyboardRestorePageScroll(root.querySelector('.sd-storyboard-scroll'),target);storyboardPendingRestoreScroll=null;
      root.querySelector('#model-mode').onclick=()=>storyboardChangeWorkbenchEngine(root,'model');root.querySelector('#comfy-mode').onclick=()=>storyboardChangeWorkbenchEngine(root,'comfy');renderShelf();
    };renderModal();
  },{functions,forms});
  const layouts=[];
  for(const width of [320,360,430,1100]){
    await page.evaluate(()=>{host.characterId=0;host.chatId='host-chat';});
    await page.setViewportSize({width,height:850});
    await page.locator('#comfy-mode').tap();await page.waitForTimeout(40);assert.equal(await page.locator('.sd-storyboard-scroll').evaluate(n=>n.scrollTop),720);
    await page.locator('#model-mode').tap();await page.waitForTimeout(40);assert.equal(await page.locator('.sd-storyboard-scroll').evaluate(n=>n.scrollTop),420);
    await page.evaluate(()=>{for(let i=0;i<20;i++)storyboardChangeWorkbenchEngine(document.getElementById('workbench'),i%2?'model':'comfy');});
    await page.waitForTimeout(50);assert.equal(await page.locator('.sd-storyboard-scroll').evaluate(n=>n.scrollTop),420);
    await page.locator('.sd-reader-companion-select').selectOption('b.png');assert.equal(await page.evaluate(()=>host.characterId),0);
    await page.evaluate(()=>{host.characterId=undefined;host.chatId='';});await page.locator('.sd-reader-continue-last').tap();
    assert.equal(await page.evaluate(()=>opened.resume.avatar),'a.png');assert.equal(await page.evaluate(()=>host.chatId),'');
    const box=await page.locator('.sd-reader-session-bar').boundingBox();assert.ok(box.x>=0&&box.x+box.width<=width+1);assert.ok(await page.locator('.sd-reader-companion-select').evaluate(n=>n.clientWidth)>100);layouts.push({width,box});
    await page.screenshot({path:fileURLToPath(new URL(`../dist/local-qa/reading-navigation-${width}.png`,import.meta.url)),fullPage:true});
  }
  assert.deepEqual(errors,[]);assert.equal(external,0);console.log(JSON.stringify({layouts,rapidSwitch:true,independentCompanion:true,resume:true,errors,external}));
}finally{await context.close();await browser.close();}
