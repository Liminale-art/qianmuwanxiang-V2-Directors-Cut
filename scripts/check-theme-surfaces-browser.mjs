// Real storyboard renderers and the existing notes drag handler, with isolated data.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {createStoryboardFormFixture,storyboardFunctionSource} from '../tests/helpers/storyboard-form-fixture.mjs';
const require=createRequire(import.meta.url),{chromium}=require(process.env.QIANMU_PLAYWRIGHT_MODULE||'playwright');
const css=await readFile(new URL('../style.css',import.meta.url),'utf8');
const browser=await chromium.launch({channel:process.env.QIANMU_BROWSER_CHANNEL||undefined,headless:true});
const context=await browser.newContext(),page=await context.newPage(),errors=[],checks=[];let external=0;
page.on('pageerror',e=>errors.push(e.message));
await context.route('**/*',async route=>{
 const url=route.request().url();
 if(url==='https://qianmu.test/')return route.fulfill({contentType:'text/html',body:'<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body></body></html>'});
 for(const file of ['qianmu-theme-surfaces.js','qianmu-theme-palette.js'])if(url===`https://qianmu.test/${file}`)return route.fulfill({contentType:'text/javascript',body:await readFile(new URL('../'+file,import.meta.url),'utf8')});
 if(url.startsWith('https://qianmu.test/')&&/\.(?:png|jpe?g|webp|woff2?)(?:\?|$)/.test(url))return route.fulfill({status:204,body:''});
 external++;return route.abort();
});
try{
 await page.goto('https://qianmu.test/');await page.addStyleTag({content:css});
 await page.evaluate(async()=>{window.themeSurfaces=await import('./qianmu-theme-surfaces.js');});
 for(const family of ['novel','comfy']){
  const form=createStoryboardFormFixture({family});
  await page.evaluate(({content,nav,dragSource})=>{
   window.controller?.dispose();
   document.body.innerHTML=`<main id="story-director-modal" class="sd-theme-light open"><div class="sd-storyboard-scroll" style="height:240px;overflow:auto">${nav}${content}</div></main><div id="qianmu-notes-panel-layer" class="sd-theme-light"><textarea class="sd-note-body" style="position:fixed;left:250px;top:20px;width:250px;height:100px">便笺未保存草稿</textarea></div><div id="qianmu-notes-float-layer"><button class="sd-detached-notes-entry is-glass-dark" style="left:80px;top:160px;--sd-notes-entry-width:60px;--sd-notes-entry-height:68px;background:rgba(43,44,44,.42)!important">N</button></div><dialog id="fixture-dialog"><input value="独立弹层草稿"></dialog>`;
   const root=document.getElementById('story-director-modal'),notes=document.getElementById('qianmu-notes-panel-layer'),entry=document.querySelector('.sd-detached-notes-entry'),dialog=document.getElementById('fixture-dialog');
   const c=window.controller=themeSurfaces.createQianmuThemeSurfaceController();
   const offMain=c.register(root);c.register(notes);c.register(entry,{role:'hive-entry',tone:'dark',edgeIndex:2});c.register(dialog);
   root.querySelectorAll('details').forEach(n=>n.open=true);
   const input=[...root.querySelectorAll('textarea')].find(n=>n.getClientRects().length&&n.offsetHeight&&!n.disabled);
   if(!input)throw Error('No visible production textarea in fixture');
   input.value='正式表单未保存草稿';input.focus();input.setSelectionRange(2,6,'backward');
   const scroll=root.querySelector('.sd-storyboard-scroll');scroll.scrollTop=80;
   window.fixture={root,notes,entry,dialog,input,scroll,offMain,originalStyle:entry.getAttribute('style'),noteSettings:{position:{x:80,y:160},detached:true},saves:0};
   Object.assign(window,{clampDetachedNotesEntry:value=>value,detachedNoteCanReturnHome:()=>false,notesFeatureSettings:()=>fixture.noteSettings,persistNotesDevice:()=>fixture.saves++,saveSettings:()=>{throw Error('device geometry must not write account settings');},renderFloatingNotes:()=>{throw Error('theme rebuilt floating entry');},toast(){},openNotesPanel(){}});
   new Function(dragSource+';window.bindFloating=bindFloatingNoteEvents;')();bindFloating(document.getElementById('qianmu-notes-float-layer'));
  },{content:form.content,nav:form.nav,dragSource:storyboardFunctionSource('bindFloatingNoteEvents')});
  for(const width of [393,1280])for(const theme of ['editorial','glass'])for(const mode of ['light','dark']){
   await page.setViewportSize({width,height:900});
   const result=await page.evaluate(({theme,mode})=>{
    const {root,input,scroll,notes,entry,dialog}=fixture;input.focus();input.setSelectionRange(2,6,'backward');
    const before={scroll:scroll.scrollTop,left:entry.style.left,top:entry.style.top,classes:root.className,controls:root.querySelectorAll('input,textarea,select,button').length};
    const snapshot=controller.setTheme({theme,mode,accent:'#5c79d3'});
    const optionRow=root.querySelector('.sd-storyboard-automation-options'),options=[...optionRow.querySelectorAll('.sd-option-chip')].map(node=>node.getBoundingClientRect());
    const stream=root.querySelector('.sd-storyboard-stream-enabled'),streamLabel=stream.closest('label'),streamRect=streamLabel.getBoundingClientRect(),generationGrid=streamLabel.previousElementSibling.getBoundingClientRect(),streamNote=root.querySelector('.sd-storyboard-stream-note');
    return {same:root.contains(input),focused:document.activeElement===input,value:input.value,selection:[input.selectionStart,input.selectionEnd,input.selectionDirection],scroll:scroll.scrollTop,
     left:entry.style.left,top:entry.style.top,classes:root.className,controls:root.querySelectorAll('input,textarea,select,button').length,before,
     tokens:[root,notes,dialog].map(n=>getComputedStyle(n).getPropertyValue('--sd-text').trim()),expected:snapshot.tokens['--sd-text'],
     hive:entry.style.getPropertyValue('--sd-wheel-icon'),expectedHive:snapshot.hive.dark.icon,background:getComputedStyle(entry).backgroundColor,
     automation:{count:options.length,equal:options.length===2&&Math.abs(options[0].width-options[1].width)<1&&Math.abs(options[0].top-options[1].top)<1,
       fits:optionRow.scrollWidth<=optionRow.clientWidth+1,retired:!!root.querySelector('.sd-storyboard-auto-capture')},
     streaming:{checked:stream.checked,disabled:stream.disabled,fullWidth:Math.abs(streamRect.width-generationGrid.width)<1,
       tallEnough:streamRect.height>=35,roundedRectangle:parseFloat(getComputedStyle(streamLabel).borderRadius)<streamRect.height/2,
       noteFits:streamNote.scrollWidth<=streamNote.clientWidth+1}};
   },{theme,mode});
   assert.equal(result.same,true);assert.equal(result.focused,true);assert.equal(result.value,'正式表单未保存草稿');assert.deepEqual(result.selection,[2,6,'backward']);
   for(const key of ['scroll','left','top','classes','controls'])assert.equal(result[key],result.before[key]);
   assert.ok(result.tokens.every(v=>v===result.expected));assert.equal(result.hive,result.expectedHive);assert.match(result.background,/color\(srgb|rgba/);
   assert.deepEqual(result.automation,{count:2,equal:true,fits:true,retired:false});
   assert.deepEqual(result.streaming,{checked:false,disabled:false,fullWidth:true,tallEnough:true,roundedRectangle:true,noteFits:true});
   checks.push(`${family} ${width} ${theme} ${mode}: two equal automation options plus default-off full-width streaming choice`);
   checks.push(`${family} ${width} ${theme} ${mode}: real form and portals retain state`);
  }
  // Theme patching must leave real captured-pointer drag and the single position save intact.
  const entry=page.locator('.sd-detached-notes-entry'),box=await entry.boundingBox();assert.ok(box);
  await page.mouse.move(box.x+box.width/2,box.y+box.height/2);await page.mouse.down();
  await page.mouse.move(box.x+box.width/2+24,box.y+box.height/2+20,{steps:3});
  await page.evaluate(()=>controller.setTheme({theme:'editorial',mode:'light',accent:'#8475ba'}));
  await page.mouse.move(box.x+box.width/2+70,box.y+box.height/2+65,{steps:4});await page.mouse.up();
  const dragged=await page.evaluate(()=>({left:fixture.entry.style.left,top:fixture.entry.style.top,saves:fixture.saves,position:fixture.noteSettings.position}));
  assert.notEqual(dragged.left,'80px');assert.equal(parseFloat(dragged.left),dragged.position.x);assert.equal(parseFloat(dragged.top),dragged.position.y);assert.equal(dragged.saves,1);checks.push(`${family}: real notes drag continues and saves once`);
  const late=await page.evaluate(()=>{
   fixture.offMain();fixture.root.remove();
   const late=document.createElement('dialog');late.innerHTML='<input value="稍后挂载的草稿">';document.body.append(late);const off=controller.register(late);late.showModal();
   const input=late.querySelector('input');input.focus();input.setSelectionRange(1,4);controller.setTheme({theme:'glass',mode:'dark'});
   const themed=late.getAttribute('data-qm-theme'),same=late.querySelector('input')===input,focus=document.activeElement===input;
   controller.setTheme(null);const restored=!late.hasAttribute('data-qm-theme')&&late.style.getPropertyValue('--sd-text')==='';
   late.close();off();late.remove();controller.dispose();return {themed,same,focus,restored,main:!!document.getElementById('story-director-modal'),size:controller.size};
  });
  assert.deepEqual(late,{themed:'glass',same:true,focus:true,restored:true,main:false,size:0});checks.push(`${family}: panel absent, late dialog, classic restoration, clean disposal`);
 }
 assert.deepEqual(errors,[]);assert.equal(external,0);console.log(JSON.stringify({passed:checks.length,checks,errors,external,productionDataRead:false,scope:'production renderers and drag handler with isolated data; no real ST data or deployment'}));
}finally{await context.close();await browser.close();}
