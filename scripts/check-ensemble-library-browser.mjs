// Isolated real-DOM UI checks only. No ST credentials, persistence or model calls.
import assert from 'node:assert/strict';
import {readFile,mkdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),{chromium}=require(process.env.QIANMU_PLAYWRIGHT_MODULE||'playwright');
const css=(await Promise.all(['style.css','qianmu-theme-skins.css'].map(p=>readFile(new URL('../'+p,import.meta.url),'utf8')))).join('\n');
const out=new URL('../dist/local-qa/ensemble-library/',import.meta.url);await mkdir(out,{recursive:true});
const assets=new Set(['qianmu-theme-surfaces.js','qianmu-theme-palette.js','qianmu-ensemble-view.js','qianmu-ensemble-editor.js','qianmu-ensemble-selection.js','qianmu-prompt-formats.js','qianmu-icon-renderer.js','qianmu-ensemble-origin.js','qianmu-ensemble-ui.js','qianmu-ensemble-route-view.js','qianmu-ensemble-storage.js','qianmu-st-account-storage.js','qianmu-json-input.js','qianmu-ensemble-target-picker.js']);
assets.add('qianmu-storyboard-limits.js');
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
  await page.evaluate(async()=>{window.theme=await import('./qianmu-theme-surfaces.js');window.module=await import('./qianmu-ensemble-ui.js');window.routeView=await import('./qianmu-ensemble-route-view.js');});
  for(const width of [320,393,1280])for(const skin of ['classic','editorial','glass'])for(const mode of ['light','dark']){
    await page.setViewportSize({width,height:1000});
    await page.evaluate(async({skin,mode})=>{
      window.mount?.close();window.libraryUi?.dispose();window.controller?.dispose();
      document.body.innerHTML='<main id="story-director-modal" class="sd-storyboard-mode sd-theme-'+mode+' open"><section class="sd-window"><main class="sd-body sd-storyboard-body"><div class="sd-storyboard-root"><header class="sd-storyboard-titlebar"><span>镜组</span></header><div class="sd-storyboard-scroll"><div class="sd-storyboard-create"><div id="fixture"></div></div></div><nav class="sd-storyboard-nav"></nav></div></main></section></main>';
      const root=document.getElementById('story-director-modal');window.controller=theme.createQianmuThemeSurfaceController();controller.register(root);if(skin!=='classic')controller.setTheme({theme:skin,mode,accent:'#719782'});
      const namespace='st-user:synthetic-browser-account',chatKey='synthetic-chat';window.stats={reads:0,writes:0,configures:0,publishes:0};const view=value=>({value:structuredClone(value)});
      let library=view({schema:'qianmu.ensemble.library.v1',namespace,schemes:[{id:'ink',revision:'r1',name:'留白水墨 · 室内静谧',description:'适用于静默的室内、回忆与留白；保留叙事既定镜头，只匹配绘制风格。',tags:['静谧','留白'],archived:false,binding:{routeId:'nai',artistPresetId:'ink'}},{id:'photo',revision:'r1',name:'电影感写实',description:'适用于城市远景与自然环境',tags:['风景'],archived:false,binding:{routeId:'comfy',artistPresetId:''}}]});
      let selection=view({schema:'qianmu.ensemble.chat-selection.v1',namespace,chatKey,revision:'r1',enabled:false,schemeIds:[],styleLock:true});
      const store={namespace,chatKey,readLibrary:async()=>{stats.reads++;return library;},readSelection:async()=>{stats.reads++;return selection;},saveLibrary:async(value,expected)=>{if(expected!==library)throw Error('fixture conflict');stats.writes++;return library=view(value);},saveSelection:async(value,expected)=>{if(expected!==selection)throw Error('fixture conflict');stats.writes++;return selection=view(value);},close(){}};
      const target={providerId:'novel',modelId:'nai-diffusion-5-full',capabilityModelId:'nai-diffusion-5-full',connectionPresetId:'',parameterPresetId:''};
      window.libraryState={routing:{rules:[{id:'nai',name:'日常插图',enabled:true,target}]}};
      document.getElementById('fixture').innerHTML=routeView.renderEnsembleRoutePanel();let sequence=0;
      window.libraryUi=module.createStoryboardEnsembleController({state:libraryState,chatKey,isCurrent:()=>true,resolveNamespace:async()=>namespace,createStore:async()=>store,changed:()=>{},publish:()=>{stats.publishes++;},uid:prefix=>prefix+'-'+(++sequence),
        configureTarget:async({target:current})=>{stats.configures++;return {target:structuredClone(current||target),artistCapable:true,label:'NovelAI · 插图'};},
        readTargets:()=>[...libraryState.routing.rules.map(row=>({id:row.id,name:row.name,providerLabel:'NovelAI',artistCapable:true,available:true})),{id:'comfy',name:'固定工作流',providerLabel:'Comfy',artistCapable:false,available:true}],readArtists:()=>[{id:'ink',name:'水墨画师'}]});
      await libraryUi.mount(document.querySelector('.sd-ensemble-library-host'));window.mount={model:libraryUi.model,close:()=>libraryUi.detach()};
    },{skin,mode});
    const key=[width,skin,mode].join('/');
    assert.equal(await page.locator('.sd-ensemble-editor').count(),0,key+' list only on opening');
    assert.equal(await page.locator('.sd-ensemble-scheme').count(),2,key);
    assert.doesNotMatch(await page.locator('#fixture').textContent(),/绘制线路|全局方案库|已归档|手动生成多镜头|镜头数量与同时生成/);
    assert.equal(await page.locator('[data-storyboard-route-rule],[data-ensemble-archived]').count(),0,key);
    await page.locator('[data-ensemble-action=add]').click();await page.locator('[data-ensemble-field=name]').fill('取消的草稿');
    await page.locator('[data-ensemble-action=configure]').click();await page.waitForFunction(()=>!mount.model.snapshot().busy);
    assert.equal(await page.locator('.sd-ensemble-scheme,[data-ensemble-search]').count(),0,key+' editor excludes underlying library');
    assert.deepEqual(await page.evaluate(()=>({writes:stats.writes,publishes:stats.publishes,routes:libraryState.routing.rules.length})),{writes:0,publishes:0,routes:1},key+' configuration remains private until save');
    await page.locator('[data-ensemble-action=cancel]').click();
    assert.deepEqual(await page.evaluate(()=>({writes:stats.writes,routes:libraryState.routing.rules.length,schemes:mount.model.snapshot().library.schemes.length})),{writes:0,routes:1,schemes:2},key+' cancel has no write');
    await page.locator('[data-ensemble-action=add]').click();await page.locator('[data-ensemble-field=name]').fill('新风格');
    await page.locator('[data-ensemble-action=configure]').click();await page.waitForFunction(()=>!mount.model.snapshot().busy);
    assert.equal(await page.locator('[data-ensemble-action=configure]').textContent(),'NovelAI · 插图',key);
    assert.equal(await page.evaluate(()=>stats.writes),0,key);
    await page.locator('[data-ensemble-action=save]').click();await page.waitForFunction(()=>!mount.model.snapshot().busy);
    assert.equal(await page.locator('.sd-ensemble-editor').count(),0,key);assert.equal(await page.locator('.sd-ensemble-scheme').count(),3,key);
    const createdId=await page.evaluate(()=>mount.model.snapshot().library.schemes.find(row=>row.name==='新风格').id);
    assert.deepEqual(await page.evaluate(()=>({writes:stats.writes,publishes:stats.publishes,routes:libraryState.routing.rules.length})),{writes:1,publishes:1,routes:2},key+' one scheme save owns one target');
    await page.locator('[data-ensemble-action=edit][data-id=ink]').click();
    const before=await page.evaluate(()=>{window.originalInput=document.querySelector('[data-ensemble-field=name]');originalInput.focus();originalInput.setSelectionRange(2,2);return stats.reads;});
    await page.locator('[data-ensemble-field=name]').press('ArrowLeft');
    await page.locator('[data-ensemble-field=name]').press('Backspace');
    await page.locator('[data-ensemble-field=name]').pressSequentially('A');
    assert.equal(await page.locator('[data-ensemble-field=name]').evaluate(el=>el.selectionStart),1,key);
    const typing=await page.evaluate(()=>{const el=document.querySelector('[data-ensemble-field=name]');el.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}));el.value='中文方案';el.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertCompositionText',data:'中文方案',isComposing:true}));el.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true,data:'中文方案'}));return {same:el===originalInput,focused:document.activeElement===el,draft:mount.model.snapshot().draft.name,reads:stats.reads,writes:stats.writes};});
    assert.deepEqual(typing,{same:true,focused:true,draft:'中文方案',reads:before,writes:1},key);
    await page.locator('[data-ensemble-field=description]').fill('平静的室内，光线柔和，留白与人物动作自然衔接。');
    assert.equal(await page.evaluate(async()=>{const input=document.querySelector('[data-ensemble-field=name]');await libraryUi.mount(document.querySelector('.sd-ensemble-library-host'));return input===document.querySelector('[data-ensemble-field=name]');}),true,key+' repeated same-host mount does not replace input');
    await page.evaluate(async()=>{libraryUi.detach();await libraryUi.mount(document.querySelector('.sd-ensemble-library-host'));});
    assert.equal(await page.locator('[data-ensemble-field=name]').inputValue(),'中文方案',key+' remount keeps draft');
    assert.equal(await page.evaluate(()=>stats.reads),before,key+' remount reuses account cache');
    const geometry=await page.evaluate(()=>{
      const box=el=>{const r=el.getBoundingClientRect();return {left:r.left,right:r.right,height:r.height};},root=document.querySelector('.sd-ensemble-library');
      return {overflow:root.scrollWidth-root.clientWidth,bounds:box(root),fields:[...root.querySelectorAll('.text_pole:not(textarea),button')].map(el=>({tag:el.tagName,...box(el)})),
        bindings:[...root.querySelectorAll('.sd-ensemble-binding-fields>label')].map(label=>{const control=label.querySelector('button,select'),rect=control.getBoundingClientRect();return {label:box(label),control:box(control),top:rect.top};}),
        headings:[...root.querySelectorAll('.sd-ensemble-fields label>span')].map(el=>getComputedStyle(el).textAlign),icons:root.querySelectorAll('button svg[stroke-width="2.25"]').length,shadow:getComputedStyle(document.querySelector('[data-ensemble-field=description]')).boxShadow};
    });
    assert.ok(geometry.overflow<=1,key+JSON.stringify(geometry));assert.ok(geometry.icons>=3,key);assert.equal(geometry.shadow,'none',key);
    assert.equal(await page.locator('[data-ensemble-field=description]').evaluate(el=>getComputedStyle(el).outlineStyle),'none',key);
    for(const field of geometry.fields){assert.ok(field.left>=geometry.bounds.left-1&&field.right<=geometry.bounds.right+1,key+JSON.stringify(field));assert.ok(Math.abs(field.height-32)<=1,key+JSON.stringify(field));}
    assert.equal(geometry.bindings.length,2,key);
    assert.ok(Math.abs(geometry.bindings[0].top-geometry.bindings[1].top)<=1,key+' generation target and artist controls align '+JSON.stringify(geometry.bindings));
    for(const {label,control} of geometry.bindings)assert.ok(Math.abs(label.left-control.left)<=1&&Math.abs(label.right-control.right)<=1,key+' each generation control fills its column '+JSON.stringify({label,control}));
    assert.ok(geometry.headings.every(value=>value==='left'),key);
    if(width===393&&mode==='light'){const path=fileURLToPath(new URL(skin+'-393.png',out));await page.locator('.sd-storyboard-scroll').screenshot({path});screenshots.push(path);}
    await page.locator('[data-ensemble-action=save]').click();await page.waitForFunction(()=>!mount.model.snapshot().busy);
    assert.equal(await page.locator('.sd-ensemble-scheme-copy>b').first().textContent(),'中文方案',key);
    await page.locator(`[data-ensemble-action=toggle][data-id="${createdId}"]`).click();await page.waitForFunction(()=>!mount.model.snapshot().busy);
    await page.locator('[data-ensemble-action=enabled]').click();await page.waitForFunction(()=>!mount.model.snapshot().busy);
    assert.equal(await page.locator('[data-ensemble-action=enabled]').getAttribute('aria-pressed'),'true',key);
    assert.equal(await page.evaluate(()=>libraryState.routing.styleLibrary),true,key);
    await page.evaluate(()=>{window.originalSearch=document.querySelector('[data-ensemble-search]');});
    await page.locator('[data-ensemble-search]').fill('不存在');
    assert.equal(await page.locator('.sd-ensemble-scheme').count(),0,key);
    assert.equal(await page.evaluate(()=>originalSearch===document.querySelector('[data-ensemble-search]')&&document.activeElement===originalSearch),true,key);
    await page.locator('[data-ensemble-search]').fill('');
    assert.equal(await page.locator(`[data-ensemble-action=toggle][data-id="${createdId}"]`).getAttribute('aria-pressed'),'true',key+' selection survives unrelated editing');
    await page.locator('[data-ensemble-action=edit][data-id=photo]').click();
    await page.locator('[data-ensemble-action=remove][data-id=photo]').click();await page.waitForFunction(()=>!mount.model.snapshot().busy);
    assert.equal(await page.locator('.sd-ensemble-editor').count(),0,key+' deletion returns to list');
    assert.equal(await page.locator('.sd-ensemble-scheme').count(),2,key);
    assert.equal(await page.locator('[data-ensemble-action=edit][data-id=photo]').count(),0,key);
    assert.deepEqual(await page.evaluate(()=>({reads:stats.reads,writes:stats.writes,selected:mount.model.snapshot().selection.schemeIds})),{reads:2,writes:5,selected:[createdId]},key);
    await page.evaluate(async()=>{libraryUi.detach();await libraryUi.mount(document.querySelector('.sd-ensemble-library-host'));});
    assert.equal(await page.evaluate(()=>stats.reads),2,key+' remount cache');
    checks.push(key);
  }
  assert.deepEqual(errors,[]);assert.equal(external,0);console.log(JSON.stringify({passed:checks.length,errors,external,screenshots,scope:'real DOM, local theme and synthetic storage; no production ST, mobile device, cloud or paid-model acceptance'}));
}catch(error){await page.screenshot({path:fileURLToPath(new URL('failure.png',out))});throw error;}
finally{await context.close();await browser.close();}
