// Synthetic form only. All routes intercepted; no ST account, model or persistence.
import assert from 'node:assert/strict';
import {readFile,mkdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import vm from 'node:vm';
import {createStoryboardFormFixture,storyboardFunctionSource as section} from '../tests/helpers/storyboard-form-fixture.mjs';
const require=createRequire(import.meta.url),{chromium}=require(process.env.QIANMU_PLAYWRIGHT_MODULE||'playwright');
const css=(await Promise.all(['style.css','qianmu-theme-skins.css'].map(p=>readFile(new URL('../'+p,import.meta.url),'utf8')))).join('\n');
const out=new URL('../dist/local-qa/world-automatic/',import.meta.url);await mkdir(out,{recursive:true});
const browser=await chromium.launch({channel:process.env.QIANMU_BROWSER_CHANNEL||undefined,headless:true});
const context=await browser.newContext(),page=await context.newPage(),errors=[],checks=[],screenshots=[];let external=0;
page.on('pageerror',error=>errors.push(error.message));
await context.route('**/*',async route=>{
  const url=route.request().url();
  if(url==='https://qianmu.test/')return route.fulfill({contentType:'text/html',body:'<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body></body></html>'});
  for(const file of ['qianmu-theme-surfaces.js','qianmu-theme-palette.js'])if(url===`https://qianmu.test/${file}`)return route.fulfill({contentType:'text/javascript',body:await readFile(new URL('../'+file,import.meta.url),'utf8')});
  external++;return route.abort();
});
try{
  await page.goto('https://qianmu.test/');await page.addStyleTag({content:css});
  await page.evaluate(async()=>{window.theme=await import('./qianmu-theme-surfaces.js');});
  for(const family of ['novel','openai','comfy']){
    const f=createStoryboardFormFixture({family});Object.assign(f.context,{getChatKey:()=> 'fixture',directorProductionPacketState:{packets:[],chatKey:'fixture'}});
    vm.runInContext(section('renderStoryboardProductionSources'),f.context);f.state.directorBridge.worldSideShotsEnabled=true;
    const content=f.context.renderStoryboardProductionSources(f.state);
    for(const width of [320,393,1280])for(const skin of ['classic','editorial','glass'])for(const mode of ['light','dark']){
      await page.setViewportSize({width,height:900});
      await page.evaluate(({content,skin,mode})=>{
        window.controller?.dispose();document.body.innerHTML=`<main id="story-director-modal" class="sd-storyboard-mode sd-theme-${mode==='dark'?'dark':'light'} open"><section class="sd-window"><main class="sd-body sd-storyboard-body"><div class="sd-storyboard-root"><header class="sd-storyboard-titlebar"><span>镜头台</span></header><div class="sd-storyboard-scroll"><div class="sd-storyboard-create">${content}</div></div><nav class="sd-storyboard-nav"></nav></div></main></section></main>`;
        const root=document.getElementById('story-director-modal');window.controller=theme.createQianmuThemeSurfaceController();controller.register(root);
        if(skin!=='classic')controller.setTheme({theme:skin,mode,accent:'#719782'});
        root.querySelector('details').open=true;
      },{content,skin,mode});
      await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
      const result=await page.evaluate(()=>{
        const card=document.querySelector('.sd-storyboard-production-card'),chip=card.querySelector('.sd-option-chip'),select=card.querySelector('select');
        const box=n=>{const r=n.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,height:r.height,width:r.width};};
        return {card:box(card),chip:box(chip),select:box(select),overflow:card.scrollWidth-card.clientWidth,checked:chip.querySelector('input').checked,disabled:select.disabled,
          chipRadius:getComputedStyle(chip).borderRadius,selectRadius:getComputedStyle(select).borderRadius,headingAlign:getComputedStyle(select.previousElementSibling).textAlign};
      });
      const key=`${family}/${width}/${skin}/${mode}`;
      assert.ok(result.overflow<=1,key+JSON.stringify(result));assert.ok(result.chip.left>=result.card.left&&result.select.right<=result.card.right+1,key);
      assert.ok(Math.abs(result.chip.height-result.select.height)<=1,key+JSON.stringify(result));
      if(Math.abs(result.chip.left-result.select.left)>2)assert.ok(Math.abs(result.chip.bottom-result.select.bottom)<=1,key+JSON.stringify(result));
      assert.equal(result.checked,false);assert.equal(result.disabled,true);assert.equal(result.headingAlign,'left');
      if(skin==='editorial')assert.equal(result.chipRadius,'0px');else assert.ok(parseFloat(result.chipRadius)<20,key+JSON.stringify(result));
      const hit=await page.evaluate(()=>{const el=document.querySelector('.sd-option-chip'),r=el.getBoundingClientRect(),hit=document.elementFromPoint(r.left+r.width/2,r.top+r.height/2);return {ok:el===hit||el.contains(hit),tag:hit?.outerHTML?.slice(0,160),root:getComputedStyle(document.querySelector('.sd-storyboard-root')).height};});
      if(!hit.ok){await page.screenshot({path:fileURLToPath(new URL('blocked.png',out))});throw Error(key+JSON.stringify({result,hit}));}
      await page.locator('.sd-option-chip').click();assert.equal(await page.locator('.sd-storyboard-world-auto').isChecked(),true);
      checks.push(key);
      if(family==='novel'&&width===393&&mode==='light'){
        const path=fileURLToPath(new URL(`${skin}-393.png`,out));await page.locator('.sd-storyboard-production-card').screenshot({path});screenshots.push(path);
      }
    }
  }
  assert.deepEqual(errors,[]);assert.equal(external,0);console.log(JSON.stringify({passed:checks.length,errors,external,productionDataRead:false,screenshots,
    scope:'real world-card markup/CSS with synthetic state; runtime binding tested separately, no real ST or paid-model acceptance'}));
}finally{await context.close();await browser.close();}
