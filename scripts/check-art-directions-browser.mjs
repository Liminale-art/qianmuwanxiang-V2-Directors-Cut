// Isolated real-DOM checks only; no ST, account or model requests.
import assert from 'node:assert/strict';
import {readFile,readdir,mkdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {createStoryboardFormFixture,storyboardFunctionSource} from '../tests/helpers/storyboard-form-fixture.mjs';
const require=createRequire(import.meta.url),{chromium}=require(process.env.QIANMU_PLAYWRIGHT_MODULE||'playwright');
const root=new URL('../',import.meta.url),out=new URL('../dist/local-qa/art-directions/',import.meta.url);await mkdir(out,{recursive:true});
const assets=new Set((await readdir(root)).filter(name=>/^qianmu-[\w-]+\.js$/.test(name)));
const css=(await Promise.all(['style.css','qianmu-theme-skins.css'].map(file=>readFile(new URL(file,root),'utf8')))).join('\n');
const handlers=['storyboardLoadArtistPreset','storyboardLoadArtistChoice'].map(storyboardFunctionSource).join('\n');
const browser=await chromium.launch({channel:process.env.QIANMU_BROWSER_CHANNEL||undefined,headless:true});
const context=await browser.newContext({reducedMotion:'reduce'}),page=await context.newPage(),errors=[],screenshots=[];let external=0,passed=0;
page.on('pageerror',error=>errors.push(error.message));
await context.route('**/*',async route=>{
  const url=new URL(route.request().url());
  if(url.href==='https://qianmu.test/')return route.fulfill({contentType:'text/html',body:'<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body></body></html>'});
  if(url.origin==='https://qianmu.test'&&assets.has(url.pathname.slice(1)))return route.fulfill({contentType:'text/javascript',body:await readFile(new URL(url.pathname.slice(1),root),'utf8')});
  external++;return route.abort();
});
try{
  await page.goto('https://qianmu.test/');await page.addStyleTag({content:css});
  await page.evaluate(async()=>{window.art=await import('./qianmu-art-directions.js');window.core=await import('./qianmu-storyboard.js');window.theme=await import('./qianmu-theme-surfaces.js');window.icons=await import('./qianmu-icon-renderer.js');});
  for(const family of ['novel','banana','seedream','openai'])for(const width of [320,393,1280])for(const skin of ['classic','editorial','glass'])for(const mode of ['light','dark']){
    const f=createStoryboardFormFixture({family}),profile=f.context.storyboardProviderProfile(f.state),capabilities=f.context.getStoryboardCapabilities(family,profile.capabilityModelId);
    const picker=f.context.renderStoryboardArtDirectionChoice(f.state,profile,capabilities),card=f.content.match(/<details class="sd-card sd-storyboard-prompt-card"[\s\S]*?<\/details>/)?.[0];
    assert.ok(card?.includes(picker));const content='<div class="sd-storyboard-model-workbench">'+card.replace(picker,`<div data-art-host>${picker}</div>`)+'</div>';
    await page.setViewportSize({width,height:1000});
    await page.evaluate(({content,state,capabilities,skin,mode,handlers})=>{
      window.controller?.dispose();document.body.innerHTML='<main id="story-director-modal" class="sd-storyboard-mode sd-theme-'+mode+' open"><section class="sd-window"><main class="sd-body sd-storyboard-body"><div class="sd-storyboard-root"><header class="sd-storyboard-titlebar">镜头台</header><div class="sd-storyboard-scroll">'+content+'</div><nav class="sd-storyboard-nav"></nav></div></main></section></main>';
      const root=document.getElementById('story-director-modal');window.controller=theme.createQianmuThemeSurfaceController();controller.register(root);if(skin!=='classic')controller.setTheme({theme:skin,mode,accent:'#719782'});
      window.state=state;window.saves=0;window.storyboardState=()=>window.state;window.saveSettings=()=>saves++;window.toast=message=>{throw Error(message);};window.selectStoryboardArtDirection=art.selectStoryboardArtDirection;
      const actions=new Function(handlers+';return {storyboardLoadArtistChoice};')();
      const bind=()=>root.querySelector('.sd-storyboard-art-choice').addEventListener('change',event=>actions.storyboardLoadArtistChoice(event.target.value));
      window.renderModal=()=>{const host=root.querySelector('[data-art-host]');host.innerHTML=art.renderStoryboardArtDirectionChoice(window.state,window.state.profiles[window.state.source],capabilities);icons.applyQianmuIcons(host);bind();};
      icons.applyQianmuIcons(root);bind();
    },{content,state:JSON.parse(JSON.stringify(f.state)),capabilities,skin,mode,handlers});
    const key=`${family}-${skin}-${mode}-${width}`;
    assert.equal(await page.locator('[data-art-host] option').count(),3,key);
    await page.locator('.sd-storyboard-art-choice').waitFor({state:'visible',timeout:3000});
    await page.locator('.sd-storyboard-art-choice').click();await page.keyboard.press('Escape');
    await page.locator('.sd-storyboard-art-choice').selectOption('direction:cg');
    assert.equal(await page.evaluate(()=>state.profiles[state.source].artDirection),'cg',key);
    await page.evaluate(()=>{window.state=core.normalizeStoryboardState(JSON.parse(JSON.stringify(state)));renderModal();});
    assert.equal(await page.locator('.sd-storyboard-art-choice').inputValue(),'direction:cg',key+' reload');
    const box=await page.locator('[data-art-host]').evaluate(host=>{const r=host.getBoundingClientRect(),select=host.querySelector('select'),s=select.getBoundingClientRect();return {overflow:host.scrollWidth-host.clientWidth,inside:s.left>=r.left-1&&s.right<=r.right+1&&s.top>=0&&s.bottom<=innerHeight,height:s.height,buttons:[...host.querySelectorAll('button')].map(button=>button.getBoundingClientRect().height)};});
    assert.ok(box.overflow<=1&&box.inside&&box.height>=28,key+JSON.stringify(box));assert.ok(box.buttons.every(height=>Math.abs(height-box.height)<1),key+JSON.stringify(box));
    assert.ok(await page.locator('.sd-storyboard-art-choice').evaluate(el=>{const r=el.getBoundingClientRect();return el.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2));}),key+' picker must be hit-testable, not clipped');
    if(width===393&&skin==='classic'&&mode==='light'){const path=fileURLToPath(new URL('final-'+family+'-393.png',out));await page.locator('.sd-storyboard-scroll').screenshot({path,animations:'disabled'});screenshots.push(path);}
    await page.locator('.sd-storyboard-art-choice').selectOption('');assert.equal(await page.evaluate(()=>state.profiles[state.source].artDirection),'',key);
    assert.equal(await page.evaluate(()=>saves),2,key);passed++;
  }
  assert.deepEqual(errors,[]);assert.equal(external,0);console.log(JSON.stringify({passed,errors,external,screenshots,scope:'isolated real DOM, not ST/mobile/model acceptance'}));
}catch(error){await page.screenshot({path:fileURLToPath(new URL('failure.png',out))});throw error;}
finally{await context.close();await browser.close();}
