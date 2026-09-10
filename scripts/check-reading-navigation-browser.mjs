import assert from 'node:assert/strict';
import {readFile,mkdir} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {storyboardFunctionSource as section,createStoryboardFormFixture} from '../tests/helpers/storyboard-form-fixture.mjs';
const require=createRequire(import.meta.url),{chromium}=require(process.env.QIANMU_PLAYWRIGHT_MODULE||'playwright');
const css=await readFile(new URL('../style.css',import.meta.url),'utf8');
const identityViewSource=await readFile(new URL('../qianmu-reader-identity-view.js',import.meta.url),'utf8');
const forms={model:createStoryboardFormFixture().content,comfy:createStoryboardFormFixture({family:'comfy'}).content};
const functions=['storyboardPageKey','storyboardScroller','storyboardRememberPageScroll','storyboardRestorePageScroll','storyboardChangeWorkbenchEngine',
  'coreadCompanionChoices','coreadCompanionCharacter','coreadCompanionSession','coreadEnsureCompanionSession','coreadSelectCompanion',
  'coreadPersonaChoices','coreadHostPersona','coreadPersona','coreadUserName','coreadApplyIdentityChoice','coreadChooseIdentity','renderCoreadIdentityChoices','renderCoreadIdentity','bindCoreadReadingPosition'].map(section).join('\n');
await mkdir(new URL('../dist/local-qa/',import.meta.url),{recursive:true});
const browser=await chromium.launch({channel:process.env.QIANMU_BROWSER_CHANNEL||undefined,headless:true}),context=await browser.newContext({hasTouch:true});
let external=0;const errors=[];await context.route('**/*',route=>{external++;return route.abort();});const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
try{
  await page.setContent(`<style>${css}</style><style>body{margin:0;background:#222}#story-director-modal{position:static!important;display:block!important;width:100%;box-sizing:border-box;padding:8px}#workbench{padding-top:12px}.sd-storyboard-scroll{height:340px!important;overflow:auto!important;min-height:0!important}#workbench:after{content:'';display:block;height:80px}</style><div id="story-director-modal" class="sd-theme-dark"><div id="shelf"></div><div id="workbench"></div></div>`);
  await page.evaluate(async({functions,forms,identityViewSource})=>{
    Object.assign(window,await import('data:text/javascript,'+encodeURIComponent(identityViewSource)));
    window.forms=forms;window.state={source:'novel',view:'create'};window.storyboardState=()=>state;window.storyboardPageScrolls=new Map([['create',420],['create:comfy',720]]);window.storyboardPendingRestoreScroll=null;
    window.STORYBOARD_PROVIDER_REGISTRY={novel:{}};window.storyboardCaptureWorkbench=()=>{};window.saveSettings=()=>{};
    window.readerView=null;window.coreadDistilling=false;window.coreadAutoTextInFlight=false;window.dialogBusy=false;window.readerAssistantBusy=false;window.coreadComicVisionBusy=false;window.coreadOpenRequestId=0;window.c={};
    window.coreadMemoryWrites=0;window.coreadIdentitySwitchBusy=false;window.coreadWorldSyncBusy=false;window.readerScrollSaveTimer=null;
    window.host={characterId:0,chatId:'host-chat',characters:[{avatar:'a.png',name:'书友甲 · 很长的名称用于检查窄屏'},{avatar:'b.png',name:'书友乙'}]};
    window.ctx=()=>host;window.coread=()=>c;window.getChatKey=()=>host.chatId;window.getChatStore=()=>({});window.clone=structuredClone;window.coreadInvalidatePool=()=>{};
    host.powerUserSettings={personas:{'u1.png':'当前用户','u2.png':'独立 USER'},persona_descriptions:{'u2.png':{description:'独立人设'}}};host.user_avatar='u1.png';
    window.coreadPersonaAvatarRaw='';window.getPersonaName=()=> '当前用户';window.getPersonaDescription=()=> '原人设';
    host.POPUP_TYPE={CONFIRM:1};host.Popup=class{constructor(wrap){this.wrap=wrap;}show(){return new Promise(resolve=>{const modal=document.createElement('dialog');modal.style.cssText='position:fixed;margin:auto;width:min(520px,calc(100vw - 24px));box-sizing:border-box;background:#262a2e;color:#eee';modal.append(this.wrap);for(const [label,result]of [['取消',0],['选择',1]]){const button=document.createElement('button');button.textContent=label;button.onclick=()=>{modal.close();modal.remove();resolve(result);};modal.append(button);}modal.addEventListener('cancel',()=>{modal.remove();resolve(0);});document.body.append(modal);modal.showModal();});}};
    window.htmlEscape=s=>String(s||'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;');window.coreadBookMeta=id=>id==='book'?{id,title:'上次的书'}:null;window.notices=[];window.toast=text=>notices.push(text);
    window.coreadOpenBook=(bookId,options)=>{window.opened={bookId,...options};};
    window.eval(functions);
    window.renderShelf=()=>{const shelf=document.getElementById('shelf');shelf.innerHTML=`<section class="sd-reader-identity-card" style="display:flex;justify-content:space-around;padding:16px">${renderCoreadIdentity('书友',coreadCompanionCharacter()?.name||'书友','','fa-user','char')}${renderCoreadIdentity('我',coreadUserName(),'','fa-circle-user','user')}</section>`;shelf.querySelectorAll('[data-coread-identity]').forEach(button=>button.onclick=()=>coreadChooseIdentity(button.dataset.coreadIdentity));};
    window.readingSaves=[];window.coreadSaveProgress=()=>readingSaves.push(readerView.scrollRatio);
    window.mountReading=()=>{document.getElementById('reading-probe')?.remove();const body=document.createElement('div');body.id='reading-probe';body.style.cssText='height:300px;overflow:auto';body.innerHTML='<div style="height:2000px">阅读位置回归</div>';document.body.append(body);bindCoreadReadingPosition(body);return body;};
    window.renderModal=()=>{
      const root=document.getElementById('workbench');storyboardRememberPageScroll(root);
      const key=storyboardPageKey(),target=storyboardPendingRestoreScroll??storyboardPageScrolls.get(key)??0;
      root.innerHTML=`<button id="model-mode">模型接口</button><button id="comfy-mode">Comfy</button><div class="sd-storyboard-scroll" data-storyboard-page="${key}">${forms[state.source==='comfy'?'comfy':'model']}<div style="height:1800px"></div></div>`;
      storyboardRestorePageScroll(root.querySelector('.sd-storyboard-scroll'),target);storyboardPendingRestoreScroll=null;
      root.querySelector('#model-mode').onclick=()=>storyboardChangeWorkbenchEngine(root,'model');root.querySelector('#comfy-mode').onclick=()=>storyboardChangeWorkbenchEngine(root,'comfy');renderShelf();
    };renderModal();
  },{functions,forms,identityViewSource});
  const layouts=[];
  for(const width of [320,360,430,1100]){
    await page.evaluate(()=>{readerView=null;host.characterId=0;host.chatId='host-chat';c.companionOverrideAvatar='';c.personaOverrideAvatar='';delete c.lastReading;renderShelf();});
    await page.setViewportSize({width,height:850});
    await page.locator('#comfy-mode').tap();await page.waitForTimeout(40);assert.equal(await page.locator('.sd-storyboard-scroll').evaluate(n=>n.scrollTop),720);
    await page.locator('#model-mode').tap();await page.waitForTimeout(40);assert.equal(await page.locator('.sd-storyboard-scroll').evaluate(n=>n.scrollTop),420);
    await page.evaluate(()=>{for(let i=0;i<20;i++)storyboardChangeWorkbenchEngine(document.getElementById('workbench'),i%2?'model':'comfy');});
    await page.waitForTimeout(50);assert.equal(await page.locator('.sd-storyboard-scroll').evaluate(n=>n.scrollTop),420);
    assert.equal(await page.locator('.sd-reader-continue-last').count(),0);
    await page.locator('[data-coread-identity="char"]').tap();assert.equal(await page.locator('dialog b').textContent(),'选择书友');await page.locator('dialog select').selectOption('b.png');await page.getByRole('button',{name:'选择',exact:true}).tap();
    assert.equal(await page.evaluate(()=>host.characterId),0);assert.equal(await page.evaluate(()=>c.companionOverrideAvatar),'b.png');
    await page.locator('[data-coread-identity="user"]').tap();const picker=await page.locator('dialog').boundingBox();assert.ok(picker.x>=0&&picker.x+picker.width<=width+1);
    assert.equal(await page.locator('dialog b').textContent(),'选择人设');
    const select=await page.locator('dialog select').boundingBox(),content=await page.locator('.sd-reader-identity-picker').boundingBox();
    assert.ok(Math.abs(select.x-content.x)<2&&Math.abs(select.width-content.width)<2,'selection fills the content area');
    assert.ok(Math.abs((select.x-picker.x)-(picker.x+picker.width-select.x-select.width))<2,'equal left and right insets');
    await page.screenshot({path:fileURLToPath(new URL(`../dist/local-qa/reading-identity-picker-${width}.png`,import.meta.url)),fullPage:true});
    await page.locator('dialog select').selectOption('u2.png');await page.getByRole('button',{name:'选择',exact:true}).tap();assert.equal(await page.evaluate(()=>host.user_avatar),'u1.png');assert.equal(await page.evaluate(()=>coreadUserName()),'独立 USER');
    await page.locator('[data-coread-identity="user"]').tap();await page.locator('dialog select').selectOption('');await page.getByRole('button',{name:'取消',exact:true}).tap();assert.equal(await page.evaluate(()=>c.personaOverrideAvatar),'u2.png');
    assert.equal(await page.locator('#shelf select').count(),0);layouts.push({width,picker,select});
    await page.evaluate(()=>{readerView={chapterIndex:1,scrollRatio:.67};const old=mountReading();old.scrollTop=1200;old.dispatchEvent(new Event('scroll'));readerView={...readerView,companionAvatar:'b.png'};window.expectedRatio=readerView.scrollRatio;mountReading();old.scrollTop=0;old.dispatchEvent(new Event('scroll'));});
    await page.waitForTimeout(700);
    assert.ok(await page.evaluate(()=>Math.abs(readerView.scrollRatio-expectedRatio)<.001));
    assert.ok(await page.locator('#reading-probe').evaluate(n=>Math.abs(n.scrollTop/(n.scrollHeight-n.clientHeight)-window.expectedRatio)<.001));
    await page.evaluate(()=>{document.getElementById('reading-probe').remove();readerView=null;});
    await page.screenshot({path:fileURLToPath(new URL(`../dist/local-qa/reading-navigation-${width}.png`,import.meta.url)),fullPage:true});
  }
  assert.deepEqual(errors,[]);assert.equal(external,0);console.log(JSON.stringify({layouts,rapidSwitch:true,independentCompanion:true,sharedPosition:true,continueRemoved:true,errors,external}));
}finally{await context.close();await browser.close();}
