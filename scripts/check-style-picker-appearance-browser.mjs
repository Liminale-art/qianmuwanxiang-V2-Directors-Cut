// Actual picker renderers + appearance runtime in an isolated Chromium origin.
// All module/style responses are local. No ST account, provider, storage write,
// model call or external network is allowed.
import assert from 'node:assert/strict';
import {readFile,mkdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),{chromium}=require(process.env.QIANMU_PLAYWRIGHT_MODULE||'playwright');
const browser=await chromium.launch({channel:process.env.QIANMU_BROWSER_CHANNEL||undefined,headless:true});
const context=await browser.newContext(),page=await context.newPage(),checks=[],errors=[];let external=0;
const qa=new URL('../dist/local-qa/style-pickers/',import.meta.url);await mkdir(qa,{recursive:true});
const deadline=setTimeout(()=>{console.error('Style picker checks exceeded 90 seconds');void browser.close();},90000);
page.on('pageerror',error=>errors.push(error.message));
await context.route('**/*',async route=>{
  const url=new URL(route.request().url());
  if(url.origin==='https://qianmu.test'&&url.pathname==='/')return route.fulfill({contentType:'text/html',body:'<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><body></body>'});
  if(url.origin==='https://qianmu.test'&&/^\/qianmu-[a-z0-9-]+\.js$/.test(url.pathname))return route.fulfill({contentType:'text/javascript',body:await readFile(new URL('..'+url.pathname,import.meta.url),'utf8')});
  external++;return route.abort();
});
try{
  await page.goto('https://qianmu.test/');
  await page.addStyleTag({content:'body{margin:0;background:#ddd}.text_pole,.menu_button{background:white;color:black}dialog{font:14px Arial}.popup-buttons{display:flex;gap:10px;margin-top:12px}.popup-buttons button{flex:1;padding:8px}.popup-content{min-width:0}'});
  await page.addStyleTag({content:await readFile(new URL('../style.css',import.meta.url),'utf8')});
  await page.addStyleTag({content:await readFile(new URL('../qianmu-theme-skins.css',import.meta.url),'utf8')});
  await page.evaluate(async()=>{
    Object.assign(window,await import('./qianmu-appearance-session.js'),await import('./qianmu-ensemble-target-picker.js'),await import('./qianmu-comfy-route-view.js'),await import('./qianmu-storyboard.js'));
    window.PickerPopup=class{
      constructor(content){this.dlg=document.createElement('dialog');this.dlg.innerHTML='<div class="popup-content"></div><div class="popup-buttons"><button class="menu_button popup-button-ok">选用</button><button class="menu_button popup-button-cancel">取消</button></div>';this.dlg.querySelector('.popup-content').append(content);}
      show(){document.body.append(this.dlg);this.dlg.showModal();return new Promise(resolve=>{this.dlg.querySelector('.popup-button-cancel').onclick=()=>{this.dlg.close();this.dlg.remove();resolve(false);};this.dlg.querySelector('.popup-button-ok').onclick=()=>{this.dlg.close();this.dlg.remove();resolve(true);};});}
    };
    window.setup=async(family,mode)=>{
      window.appearance?.reset();document.body.replaceChildren();
      window.settings={theme:mode==='dark'?'dark':'light',appearance:{version:1,family,mode,source:'manual',accent:'#64833d'}};
      window.panel=document.createElement('section');panel.id='story-director-modal';panel.className=`sd-theme-${settings.theme}`;panel.innerHTML='<select class="text_pole"><option>对照控件</option></select>';document.body.append(panel);
      window.appearance=createQianmuAppearanceSession({document,readSettings:()=>settings,loadStyles:()=>({promise:Promise.resolve(true),cancel(){}})});appearance.mount(panel);await appearance.sync();
      window.foreign=document.createElement('dialog');foreign.className='other-plugin';document.body.append(foreign);window.foreignBefore=[getComputedStyle(foreign).color,getComputedStyle(foreign).backgroundColor];
      window.reads=0;window.storeCloses=0;
    };
    window.openPicker=kind=>{
      const common={context:{Popup:PickerPopup,POPUP_TYPE:{CONFIRM:1}},mountAppearance:root=>appearance.mountPortal(root,{inheritTheme:true})};
      if(kind==='target')window.finished=openEnsembleTargetPicker({...common,target:{providerId:'novel',modelId:'nai-diffusion-5-full',capabilityModelId:'nai-diffusion-5-full'},providers:STORYBOARD_PROVIDER_REGISTRY,models:id=>STORYBOARD_MODEL_REGISTRY[id]||[],defaultTarget:()=>({providerId:'novel',modelId:'nai-diffusion-5-full'}),validateTarget:()=>{throw Error('Unexpected confirmation');}});
      else window.finished=openComfyRoutePicker({...common,namespace:'st-user:synthetic',hasReferences:true,createStore:()=>({list:async()=>{reads++;await new Promise(resolve=>window.releaseRead=resolve);return [];},close(){storeCloses++;}})});
    };
    window.inspect=()=>{
      const dialog=document.querySelector('dialog:not(.other-plugin)'),style=getComputedStyle(dialog),field=dialog.querySelector('input:not([type=checkbox]),select'),control=getComputedStyle(field),box=dialog.getBoundingClientRect();
      const normalColor=value=>{const probe=document.createElement('span');probe.style.color=value;dialog.append(probe);const result=getComputedStyle(probe).color;probe.remove();return result;};
      return {ink:style.color,expectedInk:normalColor(getComputedStyle(panel).getPropertyValue('--sd-text')),fieldInk:control.color,
        fill:control.backgroundColor,expectedFill:getComputedStyle(panel.querySelector('select')).backgroundColor,
        bg:style.backgroundColor,theme:dialog.dataset.qmTheme||'classic',mode:dialog.dataset.qmMode||settings.theme,
        contained:box.left>=0&&box.top>=0&&box.right<=innerWidth+1&&box.bottom<=innerHeight+1,overflow:dialog.scrollWidth-dialog.clientWidth,
        foreign:[getComputedStyle(foreign).color,getComputedStyle(foreign).backgroundColor],foreignBefore,
        loading:dialog.textContent.includes('正在读取工作流'),readCount:reads};
    };
  });
  for(const width of [360,1280]){
    await page.setViewportSize({width,height:850});
    for(const family of ['classic','editorial','glass'])for(const mode of ['light','dark'])for(const kind of ['target','workflow']){
      await page.evaluate(async({family,mode,kind})=>{await setup(family,mode);openPicker(kind);},{family,mode,kind});
      await page.waitForSelector(`dialog.${kind==='target'?'sd-ensemble-target-dialog':'sd-comfy-route-dialog'}[open]`);
      const result=await page.evaluate(()=>inspect()),label=`${width}/${family}/${mode}/${kind}`;
      assert.equal(result.ink,result.expectedInk,label+' text');assert.equal(result.fieldInk,result.expectedInk,label+' input text');assert.equal(result.fill,result.expectedFill,label+' input fill');
      assert.ok(result.contained&&result.overflow<=1,label+' bounds');assert.deepEqual(result.foreign,result.foreignBefore,label+' foreign untouched');
      if(kind==='workflow'){assert.equal(result.loading,true,label+' visible before list finishes');assert.equal(result.readCount,1);}
      if(width===360&&family==='classic'&&mode==='light'||width===1280&&family==='glass'&&mode==='dark'&&kind==='target')await page.locator(`dialog.${kind==='target'?'sd-ensemble-target-dialog':'sd-comfy-route-dialog'}`).screenshot({path:fileURLToPath(new URL(`${family}_${mode}_${width}_${kind}.png`,qa))});
      await page.click(`dialog.${kind==='target'?'sd-ensemble-target-dialog':'sd-comfy-route-dialog'} .popup-button-cancel`);
      assert.equal(await page.evaluate(async()=>{const result=await finished;if(window.releaseRead){releaseRead();delete window.releaseRead;}await Promise.resolve();return result;}),null);
      assert.equal(await page.evaluate(()=>appearance.size),1,label+' release');checks.push(label);
    }
  }
  assert.equal(external,0);assert.deepEqual(errors,[]);console.log(JSON.stringify({passed:checks.length,checks,externalRequests:external,pageErrors:errors}));
}finally{clearTimeout(deadline);await context.close();await browser.close();}
