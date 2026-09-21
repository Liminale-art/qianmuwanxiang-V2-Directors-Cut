// Local real-DOM matrix. Every request is intercepted; no ST or model access.
import assert from 'node:assert/strict';
import {readFile,readdir,mkdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),{chromium}=require(process.env.QIANMU_PLAYWRIGHT_MODULE||'playwright');
const root=new URL('../',import.meta.url),out=new URL('../dist/local-qa/composition-schemes/',import.meta.url);await mkdir(out,{recursive:true});
const assets=new Set((await readdir(root)).filter(name=>/^qianmu-[\w-]+\.js$/.test(name)));
const css=(await Promise.all(['style.css','qianmu-theme-skins.css'].map(file=>readFile(new URL(file,root),'utf8')))).join('\n');
const browser=await chromium.launch({channel:process.env.QIANMU_BROWSER_CHANNEL||undefined,headless:true});
const context=await browser.newContext(),page=await context.newPage(),errors=[],checks=[],screenshots=[];let external=0;
page.on('pageerror',error=>errors.push(error.message));
await context.route('**/*',async route=>{
  const url=new URL(route.request().url());
  if(url.href==='https://qianmu.test/')return route.fulfill({contentType:'text/html',body:'<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body></body></html>'});
  if(url.origin==='https://qianmu.test'&&assets.has(url.pathname.slice(1)))return route.fulfill({contentType:'text/javascript',body:await readFile(new URL(url.pathname.slice(1),root),'utf8')});
  external++;return route.abort();
});
try{
  await page.goto('https://qianmu.test/');await page.addStyleTag({content:css});
  await page.evaluate(async()=>{window.view=await import('./qianmu-composition-schemes-view.js');window.schemes=await import('./qianmu-composition-schemes.js');window.core=await import('./qianmu-storyboard.js');window.theme=await import('./qianmu-theme-surfaces.js');window.icons=await import('./qianmu-icon-renderer.js');});
  for(const width of [320,393,1280])for(const skin of ['classic','editorial','glass'])for(const mode of ['light','dark']){
    await page.setViewportSize({width,height:1000});const key=`${skin}-${mode}-${width}`;
    await page.evaluate(({skin,mode})=>{
      window.controller?.dispose();document.body.innerHTML='<main id="story-director-modal" class="sd-storyboard-mode sd-theme-'+mode+' open"><section class="sd-window"><main class="sd-body sd-storyboard-body"><div class="sd-storyboard-root"><header class="sd-storyboard-titlebar">取景预设</header><div class="sd-storyboard-scroll"><div class="sd-storyboard-presets-page" id="fixture"></div></div></div></main></section></main>';
      const root=document.getElementById('story-director-modal');window.controller=theme.createQianmuThemeSurfaceController();controller.register(root);if(skin!=='classic')controller.setTheme({theme:skin,mode,accent:'#719782'});
      window.state=core.createStoryboardDefaults();state.promptPresets=[{id:'p',name:'故事',items:[]}];state.promptCompiler.instructionPresetId='p';window.saves=0;window.sequence=0;
      window.paint=()=>{const fixture=document.getElementById('fixture');fixture.innerHTML=view.renderCompositionEditor(state,{ratios:core.STORYBOARD_RATIOS});
        view.bindCompositionEditor(fixture,state,{normalize:core.normalizeStoryboardCompositionPolicy,current:()=>true,save:()=>saves++,render:paint,createId:()=>`local-${++sequence}`});icons.applyQianmuIcons(fixture);};paint();
    },{skin,mode});
    await page.locator('[data-composition-editor]>summary').click();
    await page.locator('[data-composition-select]').selectOption('qianmu:composition-default');
    await page.locator('[data-composition-name]').fill('日常构景');
    await page.locator('[data-composition-field="preferredRatioId"]').selectOption('16:9');
    assert.equal(await page.locator('[data-composition-name]').inputValue(),'日常构景',key+' draft name retained');
    await page.locator('[data-composition-action="new"]').click();
    assert.equal(await page.evaluate(()=>state.compositionSchemes.length),1,key);
    await page.locator('.sd-composition-binding').click();
    await page.locator('[data-composition-field="ruleOverride"]').fill('给主体留出空间');await page.locator('[data-composition-name]').focus();
    assert.equal(await page.evaluate(()=>state.promptPresets[0].compositionBinding.policy.ruleOverride),'',key+' temporary edits do not change binding');
    await page.locator('[data-composition-action="save"]').click();
    assert.equal(await page.evaluate(()=>state.promptPresets[0].compositionBinding.policy.ruleOverride),'给主体留出空间',key);
    const geometry=await page.evaluate(()=>{const host=document.getElementById('fixture'),box=host.getBoundingClientRect(),fields=[...host.querySelectorAll('input[type=text],select,textarea,button')];return {overflow:host.scrollWidth-host.clientWidth,
      bounded:fields.every(field=>{const r=field.getBoundingClientRect();return r.left>=box.left-1&&r.right<=box.right+1;}),heights:[...host.querySelectorAll('.sd-composition-save-row>*')].map(field=>field.getBoundingClientRect().height),
      nameBox:(()=>{const el=host.querySelector('[data-composition-name]'),s=getComputedStyle(el),rules=[];const visit=list=>{for(const rule of list){if(rule.cssRules)visit(rule.cssRules);if(rule.selectorText&&el.matches(rule.selectorText)&&(rule.style.height||rule.style.minHeight))rules.push(rule.cssText);}};for(const sheet of document.styleSheets)visit(sheet.cssRules);return {height:s.height,minHeight:s.minHeight,padding:s.padding,boxSizing:s.boxSizing,lineHeight:s.lineHeight,border:s.borderWidth,rules};})(),title:getComputedStyle(host.querySelector('.sd-composition-selector')).textAlign,outline:getComputedStyle(host.querySelector('textarea')).outlineStyle};});
    assert.ok(geometry.overflow<=1&&geometry.bounded,key+JSON.stringify(geometry));assert.ok(geometry.heights.every(height=>Math.abs(height-32)<1),key+JSON.stringify(geometry));assert.equal(geometry.title,'left',key);assert.equal(geometry.outline,'none',key);
    if(width===393&&mode==='light'){const path=fileURLToPath(new URL(skin+'-393.png',out));await page.locator('.sd-storyboard-scroll').screenshot({path});screenshots.push(path);}
    await page.locator('[data-composition-editor]>summary').click();await page.waitForFunction(()=>state.collapsedCards['composition-editor']===true);await page.evaluate(()=>paint());assert.equal(await page.locator('[data-composition-editor]').getAttribute('open'),null,key+' collapse persists');
    await page.locator('[data-composition-editor]>summary').click();
    for(const id of await page.locator('[data-composition-ratio]').evaluateAll(fields=>fields.map(field=>field.value)))if(id!=='16:9')await page.locator(`label:has([data-composition-ratio][value="${id}"])`).click();
    await page.locator('label:has([data-composition-ratio][value="16:9"])').click();
    assert.equal(await page.locator('[data-composition-ratio][value="16:9"]').isChecked(),true,key+' last ratio protected');
    assert.match(await page.locator('[data-composition-status]').textContent(),/至少/);
    await page.locator('[data-composition-action="delete"]').click();assert.equal(await page.evaluate(()=>state.compositionSchemes.length),0,key);
    await page.evaluate(()=>{schemes.applyBoundComposition(state,state.promptPresets[0],core.normalizeStoryboardCompositionPolicy);paint();});assert.equal(await page.evaluate(()=>state.compositionPolicy.ruleOverride),'给主体留出空间',key);
    checks.push(key);
  }
  assert.deepEqual(errors,[]);assert.equal(external,0);console.log(JSON.stringify({passed:checks.length,errors,external,screenshots,scope:'isolated DOM, not real ST/mobile/model acceptance'}));
}catch(error){await page.screenshot({path:fileURLToPath(new URL('failure.png',out))});throw error;}
finally{await context.close();await browser.close();}
