// Local real-DOM checks, synthetic state, all requests intercepted; no ST data.
import assert from 'node:assert/strict';
import {readFile,mkdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),{chromium}=require(process.env.QIANMU_PLAYWRIGHT_MODULE||'playwright');
const css=(await Promise.all(['style.css','qianmu-theme-skins.css'].map(file=>readFile(new URL('../'+file,import.meta.url),'utf8')))).join('\n');
const out=new URL('../dist/local-qa/gallery-keywords/',import.meta.url);await mkdir(out,{recursive:true});
const assets=new Set(['qianmu-gallery-keywords.js','qianmu-gallery-keywords-view.js','qianmu-theme-surfaces.js','qianmu-theme-palette.js']);
const browser=await chromium.launch({channel:process.env.QIANMU_BROWSER_CHANNEL||undefined,headless:true});
const context=await browser.newContext(),page=await context.newPage(),errors=[],checks=[],screenshots=[];let external=0;
page.on('pageerror',error=>errors.push(error.message));
await context.route('**/*',async route=>{
  const url=new URL(route.request().url());
  if(url.href==='https://qianmu.test/')return route.fulfill({contentType:'text/html',body:'<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body></body></html>'});
  const file=url.pathname.slice(1);
  if(url.origin==='https://qianmu.test'&&assets.has(file))return route.fulfill({contentType:'text/javascript',body:await readFile(new URL('../'+file,import.meta.url),'utf8')});
  external++;return route.abort();
});
try{
  await page.goto('https://qianmu.test/');await page.addStyleTag({content:css});
  await page.evaluate(async()=>{window.view=await import('./qianmu-gallery-keywords-view.js');window.core=await import('./qianmu-gallery-keywords.js');window.theme=await import('./qianmu-theme-surfaces.js');});
  for(const width of [320,393,1280])for(const skin of ['classic','editorial','glass'])for(const mode of ['light','dark']){
    await page.setViewportSize({width,height:900});
    await page.evaluate(({skin,mode})=>{
      window.controller?.dispose();document.body.innerHTML='<main id="story-director-modal" class="sd-storyboard-mode sd-theme-'+mode+' open"><section class="sd-window"><main class="sd-body sd-storyboard-body"><div class="sd-storyboard-root"><header class="sd-storyboard-titlebar">取景预设 · 阅片室</header><div class="sd-storyboard-scroll"><div class="sd-storyboard-create" id="fixture"></div></div></div></main></section></main>';
      const root=document.getElementById('story-director-modal');window.controller=theme.createQianmuThemeSurfaceController();controller.register(root);if(skin!=='classic')controller.setTheme({theme:skin,mode,accent:'#719782'});
      window.state={promptCompiler:{instructionPresetId:'p'},promptPresets:[{id:'p',galleryKeywords:['夜色','相伴','暖光']}],galleryTagFilters:[]};window.saves=0;
      window.records=[{tags:['夜色','相伴']},{tags:['夜色']},{tags:['暖光']},{tags:['这是一个较长的自定义关键词用于核查窄屏换行']}];
      const fixture=document.getElementById('fixture');fixture.innerHTML=view.renderGalleryKeywordEntry(state)+'<section class="sd-card"><input class="text_pole" value="独立文字搜索" aria-label="文字搜索"></section><div id="filters"></div><div id="count"></div>';
      view.bindGalleryKeywordEntry(fixture,state,{current:()=>true,save:()=>saves++});
      window.paint=()=>{document.getElementById('filters').innerHTML=view.renderGalleryKeywordFilters(records,state.galleryTagFilters);document.getElementById('count').textContent=records.filter(row=>core.galleryTagsMatch(row,state.galleryTagFilters)).length;
        document.querySelectorAll('[data-gallery-tag-filter]').forEach(button=>button.onclick=()=>{state.galleryTagFilters=core.toggleGalleryTag(state.galleryTagFilters,button.dataset.galleryTagFilter);paint();});};paint();
    },{skin,mode});
    const key=[width,skin,mode].join('/');await page.locator('.sd-gallery-keyword-entry summary').click();
    await page.locator('[data-gallery-keyword-editor]').fill('夜色，\n相伴\n暖光');await page.locator('[aria-label="文字搜索"]').focus();
    assert.deepEqual(await page.evaluate(()=>state.promptPresets[0].galleryKeywords),['夜色','相伴','暖光'],key);
    assert.equal(await page.evaluate(()=>saves),1,key);
    for(const word of ['夜色','相伴'])await page.locator(`[data-gallery-tag-filter="${word}"]`).click();
    assert.equal(await page.locator('#count').textContent(),'1',key);assert.equal(await page.locator('[aria-label="文字搜索"]').inputValue(),'独立文字搜索',key);
    assert.equal(await page.locator('[data-gallery-tag-filter][aria-pressed=true]').count(),2,key);
    const appearance=await page.evaluate(()=>{const active=document.querySelector('[data-gallery-tag-filter][aria-pressed=true]'),idle=document.querySelector('[data-gallery-tag-filter][aria-pressed=false]');return {active:getComputedStyle(active).backgroundColor,idle:getComputedStyle(idle).backgroundColor,height:active.getBoundingClientRect().height,width:active.getBoundingClientRect().width};});
    assert.notEqual(appearance.active,appearance.idle,key+' visible selected state');assert.ok(appearance.height<=32&&appearance.width<100,key+JSON.stringify(appearance));
    const geometry=await page.evaluate(()=>{const root=document.getElementById('fixture'),r=root.getBoundingClientRect();return {overflow:root.scrollWidth-root.clientWidth,
      fields:[...root.querySelectorAll('textarea,button')].map(el=>{const b=el.getBoundingClientRect();return b.left>=r.left-1&&b.right<=r.right+1;}),
      aligned:getComputedStyle(root.querySelector('label')).textAlign,outline:getComputedStyle(root.querySelector('textarea')).outlineStyle};});
    assert.ok(geometry.overflow<=1&&geometry.fields.every(Boolean),key+JSON.stringify(geometry));assert.equal(geometry.aligned,'left',key);assert.equal(geometry.outline,'none',key);
    if(width===393&&mode==='light'){const path=fileURLToPath(new URL(skin+'-393.png',out));await page.locator('.sd-storyboard-scroll').screenshot({path});screenshots.push(path);}
    await page.locator('[data-gallery-keyword-editor]').fill('');await page.locator('[aria-label="文字搜索"]').focus();assert.deepEqual(await page.evaluate(()=>state.promptPresets[0].galleryKeywords),[],key);
    await page.locator('[data-gallery-keyword-defaults]').click();assert.ok((await page.evaluate(()=>state.promptPresets[0].galleryKeywords)).length>20,key);
    checks.push(key);
  }
  assert.deepEqual(errors,[]);assert.equal(external,0);console.log(JSON.stringify({passed:checks.length,errors,external,screenshots,scope:'local DOM and synthetic data, not real ST/mobile/model acceptance'}));
}catch(error){await page.screenshot({path:fileURLToPath(new URL('failure.png',out))});throw error;}
finally{await context.close();await browser.close();}
