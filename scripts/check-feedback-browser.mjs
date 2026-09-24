// Isolated browser regression: real modules/styles, synthetic diagnostics, no ST or external services.
import assert from 'node:assert/strict';
import {readFile,mkdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),{chromium}=require(process.env.QIANMU_PLAYWRIGHT_MODULE||'playwright');
const css=(await Promise.all(['style.css','qianmu-theme-skins.css'].map(file=>readFile(new URL('../'+file,import.meta.url),'utf8')))).join('\n');
const assets=new Set(['qianmu-feedback-view.js','qianmu-feedback-report.js','qianmu-theme-surfaces.js','qianmu-theme-palette.js','qianmu-icon-renderer.js']);
const out=new URL('../dist/local-qa/feedback/',import.meta.url);await mkdir(out,{recursive:true});
const browser=await chromium.launch({channel:process.env.QIANMU_BROWSER_CHANNEL||undefined,headless:true});
const context=await browser.newContext(),page=await context.newPage(),errors=[],screenshots=[],checks=[];let external=0;
page.on('pageerror',error=>errors.push(error.message));
await context.route('**/*',async route=>{
  const url=new URL(route.request().url());
  if(url.href==='https://qianmu.test/')return route.fulfill({contentType:'text/html',body:'<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><body></body>'});
  if(url.origin==='https://qianmu.test'&&assets.has(url.pathname.slice(1)))return route.fulfill({contentType:'text/javascript',body:await readFile(new URL('..'+url.pathname,import.meta.url),'utf8')});
  external++;return route.abort();
});
try{
  await page.goto('https://qianmu.test/');await page.addStyleTag({content:css});
  await page.evaluate(async()=>{
    window.feedback=await import('./qianmu-feedback-view.js');window.theme=await import('./qianmu-theme-surfaces.js');window.icons=await import('./qianmu-icon-renderer.js');
    Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async text=>{window.copies.push(text);if(window.holdCopy)await new Promise(resolve=>{window.finishCopy=resolve;});}}});
  });
  for(const width of [320,393,1280])for(const skin of ['classic','editorial','glass'])for(const mode of ['light','dark']){
    await page.setViewportSize({width,height:900});
    await page.evaluate(({skin,mode})=>{
      window.dispose?.(true);window.surface?.dispose();
      document.body.innerHTML='<main id="story-director-modal" class="open sd-theme-'+mode+'"><section class="sd-window"><header class="sd-header"><strong>API 与日志</strong></header><main class="sd-body"><details class="sd-card sd-feedback-card" open><summary>问题反馈</summary><div id="feedback-fixture"></div></details></main></section></main>';
      const root=document.getElementById('story-director-modal');window.surface=theme.createQianmuThemeSurfaceController();surface.register(root);if(skin!=='classic')surface.setTheme({theme:skin,mode,accent:'#719782'});
      window.scope={};window.valid=true;window.copies=[];window.downloads=[];window.holdCopy=false;
      const environment={qianmuVersion:'1.59.374',stVersion:'1.12.0',backendStatus:'ready'};
      for(const key of ['apiKey','url','headers','chat','workflow'])Object.defineProperty(environment,key,{get(){throw Error('unexpected private read');}});
      window.options={scope,environment,isCurrent:()=>valid,applyIcons:icons.applyQianmuIcons,download:(blob,name)=>downloads.push({blob,name})};
      window.host=document.getElementById('feedback-fixture');window.dispose=feedback.mountFeedback(host,options);
    },{skin,mode});
    const key=[width,skin,mode].join('/');
    const input=page.getByRole('textbox',{name:'问题描述'}),copy=page.getByRole('button',{name:'复制报告'}),save=page.getByRole('button',{name:'保存报告'});
    assert.equal(await page.locator('#feedback-fixture textarea').count(),1,key);
    assert.equal(await page.locator('#feedback-fixture :is(select,details,pre,input,a)').count(),0,key);
    assert.equal(await copy.isDisabled(),true,key);assert.equal(await save.isDisabled(),true,key);
    assert.equal(await input.getAttribute('maxlength'),null,key);
    assert.match(await input.getAttribute('placeholder'),/例如.*角色库/);
    assert.equal(await page.locator('#feedback-fixture').textContent(),'复制报告保存报告',key);
    await input.fill('问题描述');await input.evaluate(el=>{window.originalInput=el;el.focus();el.setSelectionRange(2,2);});
    await input.press('ArrowLeft');await input.press('Backspace');await input.pressSequentially('A');
    assert.equal(await input.inputValue(),'A题描述',key);
    const ime=await input.evaluate(el=>{
      el.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}));
      el.value='中文输入未打断';el.setSelectionRange(4,4);
      el.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertCompositionText',data:'中文',isComposing:true}));
      el.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true,data:'中文'}));
      return {same:el===originalInput,active:document.activeElement===el,start:el.selectionStart};
    });assert.deepEqual(ime,{same:true,active:true,start:4},key);
    await page.evaluate(()=>{dispose();dispose=feedback.mountFeedback(host,options);});
    assert.equal(await input.inputValue(),'中文输入未打断',key);assert.equal(await input.evaluate(el=>el.selectionStart),4,key);
    await input.fill('点击角色库后没有加载完成。\n预期看到档案，实际页面一直转圈。');
    const geometry=await page.locator('.sd-feedback-form').evaluate(form=>{
      const box=node=>{const r=node.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,height:r.height,width:r.width};};
      const field=form.querySelector('textarea');return {overflow:form.scrollWidth-form.clientWidth,form:box(form),field:box(field),buttons:[...form.querySelectorAll('button')].map(box),icons:form.querySelectorAll('button svg[stroke-width="2.25"]').length,outline:getComputedStyle(field).outlineStyle};
    });
    assert.ok(geometry.overflow<=1,key+JSON.stringify(geometry));assert.equal(geometry.icons,2,key);assert.equal(geometry.outline,'none',key);
    assert.ok(Math.abs(geometry.field.left-geometry.form.left)<=1&&Math.abs(geometry.field.right-geometry.form.right)<=1,key);
    assert.ok(Math.abs(geometry.buttons[0].top-geometry.buttons[1].top)<=1,key+' actions align');
    assert.ok(Math.abs(geometry.buttons[0].width-geometry.buttons[1].width)<=1,key+' actions equally fill row');
    if(width===393){const path=fileURLToPath(new URL(skin+'-'+mode+'.png',out));await page.locator('.sd-feedback-card').screenshot({path});screenshots.push(path);}
    const text=' 首行空白保留\n'+('中文🙂'.repeat(4000))+'\n不能丢失的最后一行 ';
    await input.fill(text);await copy.click();await save.click();
    const exported=await page.evaluate(async()=>({copied:copies[0],saved:await downloads[0].blob.text(),name:downloads[0].name}));
    assert.equal(exported.copied,exported.saved,key);assert.ok(exported.saved.includes('问题描述\n'+text+'\n\n附带诊断'),key);
    assert.match(exported.saved,/千幕版本：1.59.374/);assert.match(exported.saved,/ST 版本：1.12.0/);assert.doesNotMatch(exported.saved,/apiKey|workflow|https:|private read/);
    assert.equal(exported.name,'qianmu-feedback.txt',key);
    await page.evaluate(()=>{window.valid=false;});await save.click();await copy.click();
    assert.deepEqual(await page.evaluate(()=>({copies:copies.length,downloads:downloads.length})),{copies:1,downloads:1},key+' account invalidation guards both actions');
    await page.evaluate(()=>{dispose(true);window.valid=true;window.options={...options,scope:{}};window.dispose=feedback.mountFeedback(host,options);});
    assert.equal(await input.inputValue(),'',key+' account change cannot adopt old draft');
    await input.fill('pending clipboard');await page.evaluate(()=>{window.holdCopy=true;});await copy.click();
    await page.waitForFunction(()=>typeof window.finishCopy==='function');
    await page.evaluate(async()=>{dispose(true);finishCopy();await Promise.resolve();});
    assert.equal(await page.locator('#feedback-fixture').textContent(),'',key+' closed view ignores late completion');
    checks.push(key);
  }
  assert.deepEqual(errors,[]);assert.equal(external,0);
  console.log(JSON.stringify({passed:checks.length,errors,external,screenshots,scope:'isolated local browser with synthetic diagnostics; no live ST or external requests'}));
}catch(error){await page.screenshot({path:fileURLToPath(new URL('failure.png',out))});throw error;}
finally{await context.close();await browser.close();}
