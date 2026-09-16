// Real renderers/controller and native IndexedDB on a fresh origin; no ST or provider access.
import assert from 'node:assert/strict';
import {readFile,mkdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {implementation as historicalImplementation} from '../tests/helpers/comfy-character-fixture.mjs';
import {createStoryboardFormFixture,storyboardFunctionSource} from '../tests/helpers/storyboard-form-fixture.mjs';
const require=createRequire(import.meta.url),{chromium}=require(process.env.QIANMU_PLAYWRIGHT_MODULE||'playwright');
const appearance=process.env.QIANMU_TEST_APPEARANCE||'';
assert.ok(!appearance||/^(editorial|glass)\/(light|dark)$/.test(appearance),'invalid isolated appearance');
const browser=await chromium.launch({channel:process.env.QIANMU_BROWSER_CHANNEL||undefined,headless:true});
const context=await browser.newContext({hasTouch:true}),errors=[],checks=[];let external=0,referenceImage;
const css=await readFile(new URL('../style.css',import.meta.url),'utf8')+(appearance?'\n'+await readFile(new URL('../qianmu-theme-skins.css',import.meta.url),'utf8'):'');
const qa=new URL(`../dist/local-qa/${appearance?appearance.replace('/','-')+'/':''}`,import.meta.url);
await mkdir(qa,{recursive:true});
await context.route('**/*',async route=>{
  const url=new URL(route.request().url());
  if(url.origin==='https://qianmu.test'&&url.pathname==='/user/images/synthetic-character.png'&&referenceImage)return route.fulfill({contentType:'image/png',body:referenceImage});
  if(url.origin==='https://qianmu.test'&&url.pathname==='/')return route.fulfill({contentType:'text/html',body:`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><style>body{margin:0}#story-director-modal{position:relative!important;display:block!important;inset:auto!important;transform:none!important;width:100%!important;height:898px!important;box-sizing:border-box}#story-director-modal .sd-window{width:100%!important;height:100%!important;max-height:none!important;margin:0!important}</style><div id="story-director-modal" class="open sd-theme-dark sd-storyboard-mode"><section class="sd-window"><main class="sd-body sd-storyboard-body"><div class="sd-storyboard-root"><header class="sd-storyboard-titlebar">COMFY WORKBENCH</header><div class="sd-storyboard-scroll"><div id="host"></div></div><nav class="sd-storyboard-nav">隔离验收</nav></div></main></section></div>`});
  if(url.origin==='https://qianmu.test'&&/^\/qianmu-[a-z0-9-]+\.js$/.test(url.pathname))return route.fulfill({contentType:'application/javascript',body:await readFile(new URL('..'+url.pathname,import.meta.url))});
  external++;return route.abort();
});
const ok=(name,value)=>{assert.ok(value,name);checks.push(name);};
try{
  const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));await page.goto('https://qianmu.test/');
  const verifyAppearance=async(label,selector)=>{
    if(!appearance)return;
    const result=await page.evaluate(async selector=>{
      const root=document.getElementById('story-director-modal'),host=document.getElementById('host'),field=host.querySelector(selector),scroll=host.closest('.sd-storyboard-scroll');
      field.focus({preventScroll:true});if(field.setSelectionRange&&(!field.type||['text','search','textarea'].includes(field.type)))field.setSelectionRange(0,2);
      scroll.scrollTop=Math.min(43,scroll.scrollHeight-scroll.clientHeight);
      const before={nodes:[...host.querySelectorAll('*')],html:host.innerHTML,value:field.value,selection:[field.selectionStart,field.selectionEnd],top:scroll.scrollTop,applied:applied.length,downloads:downloads.length,notices:notices.length};
      const requested=appearanceSettings.appearance,put=IDBObjectStore.prototype.put;let writes=0;
      IDBObjectStore.prototype.put=function(...args){writes++;return put.apply(this,args);};
      try{
        appearanceSettings.appearance=updateAppearancePreferences(appearanceSettings,{family:requested.family==='glass'?'editorial':'glass',mode:requested.mode==='light'?'dark':'light'});
        await appearanceSession.sync();await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
        const value={nodes:before.nodes.every(node=>node.isConnected)&&host.innerHTML===before.html,focus:document.activeElement===field,value:field.value===before.value,
          selection:JSON.stringify([field.selectionStart,field.selectionEnd])===JSON.stringify(before.selection),scroll:scroll.scrollTop===Math.min(before.top,scroll.scrollHeight-scroll.clientHeight),
          actions:before.applied===applied.length&&before.downloads===downloads.length&&before.notices===notices.length,top:[before.top,scroll.scrollTop],max:scroll.scrollHeight-scroll.clientHeight,theme:root.dataset.qmTheme};
        appearanceSettings.appearance=requested;await appearanceSession.sync();await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
        // The floating glass rail has a different safe tail. If the target page
        // is shorter than the old offset, native clamping is the correct result.
        value.restored=root.dataset.qmTheme===requested.family&&before.nodes.every(node=>node.isConnected)&&field.value===before.value&&document.activeElement===field&&scroll.scrollTop===Math.min(value.top[1],scroll.scrollHeight-scroll.clientHeight);
        value.writes=writes;value.restoredTop=scroll.scrollTop;
        value.pills=[...host.querySelectorAll('button.sd-btn')].every(node=>getComputedStyle(node).borderRadius==='999px');
        return value;
      }finally{IDBObjectStore.prototype.put=put;}
    },selector);
    assert.ok(result.nodes&&result.focus&&result.value&&result.selection&&result.scroll&&result.actions&&result.restored&&result.pills&&result.writes===0,`${appearance} ${label}: ${JSON.stringify(result)}`);
    checks.push(`${appearance} ${label} keeps nodes, draft, focus, selection, bounded scroll and explicit-save boundaries`);
  };
  await page.evaluate(async appearance=>{
    if(appearance){
      Object.assign(window,await import('/qianmu-appearance-session.js'),await import('/qianmu-appearance-settings.js'));
      const [family,mode]=appearance.split('/');window.appearanceSettings={theme:'dark',appearance:updateAppearancePreferences({}, {family,mode})};
      window.appearanceSession=createQianmuAppearanceSession({readSettings:()=>appearanceSettings,loadStyles:()=>({promise:Promise.resolve(true),cancel(){}})});
      appearanceSession.mount(document.getElementById('story-director-modal'));await appearanceSession.sync();
    }
    const {renderComfyWorkbench}=await import('/qianmu-comfy-workbench.js');
    const {createComfyWorkflowStore}=await import('/qianmu-comfy-library.js');
    const {createComfyLibraryController}=await import('/qianmu-comfy-library-view.js');
    const {applyQianmuIcons}=await import('/qianmu-icon-renderer.js');
    window.scope='st-user:synthetic';window.host=document.querySelector('#host');window.applied=[];window.downloads=[];window.notices=[];
    window.graph=JSON.stringify({text:{class_type:'CLIPTextEncode',inputs:{text:'fixed quality, %qianmu_prompt%'}},save:{class_type:'SaveImage',inputs:{images:['text',0]}}});
    window.original={workflow:graph,outputNodeId:'save',parameters:{width:'768',height:'1024',steps:'20'},positivePrompt:'legacy extra',negativePrompt:'legacy exclusion'};
    window.profile={comfyWorkflow:graph,comfyCharacterEnabled:true,comfyCharacterActivation:{legacy:true},width:768,height:1024,steps:20,cfg:6,seed:-1,sampler:'euler',scheduler:'normal'};
    window.draw=(automatic,connection=null)=>{host.innerHTML=renderComfyWorkbench({profile,connection,autoEnabled:automatic,capabilities:{width:true,height:true,steps:true,cfg:true,seed:true,sampler:true,scheduler:true,reference:true}});applyQianmuIcons(host);};
    window.store=createComfyWorkflowStore({dbName:'qianmu-comfy-browser-synthetic'});
    await store.save(scope,{name:'旧方案',document:original});
    window.openLibrary=()=>{
      window.controller=createComfyLibraryController({store,resolveNamespace:async()=>scope,getCurrentRecipe:()=>({name:'当前方案',document:original}),
        onApply:row=>applied.push(row),onIcons:applyQianmuIcons,download:async blob=>downloads.push(JSON.parse(await blob.text())),notify:message=>notices.push(message),confirm:async()=>true});
      controller.mount(host);
    };
    draw(false);
  },appearance);
  for(const width of [320,393,1100]){
    await page.setViewportSize({width,height:898});await page.evaluate(()=>draw(false));
    const metrics=await page.locator('.sd-comfy-workbench').evaluate(node=>({overflow:node.scrollWidth-node.clientWidth,fields:[...node.querySelectorAll('[data-storyboard-field]')].map(field=>({height:field.getBoundingClientRect().height,label:getComputedStyle(field.parentElement).textAlign}))}));
    ok(`workbench contains controls at ${width}`,metrics.overflow<=1&&metrics.fields.length===7);
    ok(`parameter heights match at ${width}`,Math.max(...metrics.fields.map(x=>x.height))-Math.min(...metrics.fields.map(x=>x.height))<=1);
    ok(`field labels stay left aligned at ${width}`,metrics.fields.every(x=>['left','start'].includes(x.label)));
    ok(`old role/prompt controls absent at ${width}`,await page.locator('[data-comfy-character-action],[data-storyboard-card="comfy-prompt"]').count()===0);
    await page.locator('[data-storyboard-card="comfy-references"] summary').click();
    ok(`native reference fold works at ${width}`,!await page.locator('[data-storyboard-card="comfy-references"]').evaluate(node=>node.open));
    await page.evaluate(()=>draw(true));ok(`auto mode replaces fixed controls at ${width}`,await page.locator('.sd-comfy-open-pools').count()===1&&await page.locator('[data-storyboard-field]').count()===0);
  }
  for(const width of [320,393,1100]){
    await page.setViewportSize({width,height:898});await page.evaluate(()=>draw(false,{baseUrl:'https://www.runninghub.cn'}));
    const metrics=await page.locator('.sd-comfy-workbench').evaluate(node=>({overflow:node.scrollWidth-node.clientWidth,heights:[...node.querySelectorAll('[data-storyboard-field]')].map(field=>field.getBoundingClientRect().height)}));
    ok(`RH runtime selector matches field heights without overflow at ${width}`,metrics.overflow<=1&&metrics.heights.length===8&&Math.max(...metrics.heights)-Math.min(...metrics.heights)<=1);
    await page.locator('[data-storyboard-field="comfyInstanceType"]').selectOption('plus');
    ok(`RH tier selection remains native keyboard/touch compatible at ${width}`,await page.locator('[data-storyboard-field="comfyInstanceType"]').inputValue()==='plus');
    await page.evaluate(()=>{profile.comfyConsoleUrl='https://www.runninghub.cn/workflow/1980237776367083521';draw(false,{baseUrl:'https://www.runninghub.cn'});document.querySelector('[data-storyboard-card="comfy-workflow"]').open=true;});
    ok(`explicit console link stays reachable and isolated from ST at ${width}`,await page.locator('.sd-comfy-console-link').evaluate(link=>{
      const bounds=link.getBoundingClientRect(),parent=link.closest('.sd-comfy-workbench').getBoundingClientRect();
      return bounds.height>=30&&bounds.left>=parent.left&&bounds.right<=parent.right+1
        &&link.href==='https://www.runninghub.cn/workflow/1980237776367083521'&&link.target==='_blank'
        &&link.rel.includes('noopener')&&link.rel.includes('noreferrer')&&link.referrerPolicy==='no-referrer';
    }));
  }
  await page.evaluate(()=>openLibrary());await page.waitForSelector('.sd-comfy-library-row');
  await page.locator('[data-comfy-action="edit"]').first().click();await page.waitForSelector('[data-comfy-draft="name"]');
  for(const width of [320,393,1100]){
    await page.setViewportSize({width,height:898});
    ok(`editor contains all controls at ${width}`,await page.locator('.sd-comfy-library').evaluate(node=>node.scrollWidth-node.clientWidth<=1));
    ok(`no retired addition fields at ${width}`,await page.locator('[data-comfy-draft="positivePrompt"],[data-comfy-draft="negativePrompt"]').count()===0);
    ok(`editor icons render locally at ${width}`,await page.locator('[data-comfy-action="save"] svg').count()===1);
    await verifyAppearance(`workflow editor at ${width}`,'[data-comfy-draft="workflow"]');
    await page.screenshot({caret:'initial',path:fileURLToPath(new URL(`comfy-library-${width}.png`,qa))});
  }
  await page.locator('[data-comfy-action="export-draft"]').click();await page.waitForFunction(()=>downloads.length===1);
  ok('export retains legacy original',await page.evaluate(()=>downloads[0].document.positivePrompt==='legacy extra'));
  await page.locator('[data-comfy-action="apply-version"]').click();await page.waitForFunction(()=>applied.length===1);
  ok('saved-version application carries current account',await page.evaluate(()=>applied[0].namespace===scope));
  await page.locator('[data-comfy-runtime]').selectOption('plus');
  await page.locator('[data-comfy-console]').fill('https://www.runninghub.cn/workflow/1980237776367083521?source=workspace');
  await page.locator('[data-comfy-draft="name"]').fill('新版本');await verifyAppearance('dirty workflow before explicit save','[data-comfy-draft="name"]');await page.locator('[data-comfy-action="save"]').click();await page.waitForSelector('.sd-comfy-library-row');
  ok('saving does not apply or overwrite historical additions',await page.evaluate(async()=>{
    const rows=await store.list(scope),versions=await store.versions(scope,rows[0].id);
    const latest=await store.load(scope,rows[0].id,rows[0].revision),old=await store.load(scope,rows[0].id,versions.find(row=>row.version===1).revision);
    return applied.length===1&&versions.length===2&&latest.positivePrompt===''&&latest.negativePrompt===''&&latest.workflow===graph&&old.positivePrompt==='legacy extra'
      &&latest.runninghubInstanceType==='plus'&&!Object.hasOwn(old,'runninghubInstanceType')
      &&latest.consoleUrl==='https://www.runninghub.cn/workflow/1980237776367083521'&&!Object.hasOwn(old,'consoleUrl');
  }));
  await page.locator('[data-comfy-action="apply"]').click();await page.waitForFunction(()=>applied.length===2);
  ok('list application targets the new revision, account and saved RH tier',await page.evaluate(()=>applied[1].namespace===scope&&applied[1].version===2&&applied[1].document.positivePrompt===''&&applied[1].document.runninghubInstanceType==='plus'));
  await page.evaluate(async()=>{
    controller.dispose();
    const {createComfyWorkflowStore}=await import('/qianmu-comfy-library.js');
    const {openComfyRoutePicker}=await import('/qianmu-comfy-route-view.js');
    const {pinComfyRouteWorkflow,readPinnedComfyRouteWorkflow}=await import('/qianmu-comfy-route.js');
    const {createComfyPoolStore}=await import('/qianmu-comfy-pool-store.js');
    const {createComfyPoolController,createComfyPoolCandidate}=await import('/qianmu-comfy-pool-view.js');
    const {COMFY_SELECTION_SCHEMA}=await import('/qianmu-comfy-selection.js');
    const {applyQianmuIcons}=await import('/qianmu-icon-renderer.js');
    const createStore=()=>createComfyWorkflowStore({dbName:'qianmu-comfy-browser-synthetic'});
    window.store=createStore();await store.save(scope,{name:'可择流方案',document:{...original,classification:{version:1,contentClasses:['sfw'],promptFormat:'tags'}}});
    window.routeHead=(await store.list(scope)).find(row=>row.name==='可择流方案');
    window.routeRecipe=await pinComfyRouteWorkflow({namespace:scope,selection:routeHead,createStore});
    // ST Popup is the sole shell substitute; selection/async loading/pinning run unmodified.
    class Popup{
      constructor(wrap,_type,_text,options){this.wrap=wrap;this.options=options;this.dlg=document.createElement('dialog');this.dlg.className='popup';}
      show(){return new Promise(resolve=>{
        const dialog=this.dlg;
        dialog.style.cssText='box-sizing:border-box;max-width:calc(100vw - 24px)';
        const body=document.createElement('div'),content=document.createElement('div'),controls=document.createElement('div');
        body.className='popup-body';content.className='popup-content';controls.className='popup-controls';
        content.append(this.wrap);body.append(content);dialog.append(body,controls);
        for(const [action,text] of [['confirm',this.options.okButton],['cancel',this.options.cancelButton]]){
          const button=document.createElement('button');button.className='menu_button '+(action==='confirm'?'popup-button-ok':'popup-button-cancel');button.textContent=text;button.dataset.testPicker=action;
          button.onclick=()=>{dialog.close();dialog.remove();resolve(action==='confirm');};controls.append(button);
        }document.body.append(dialog);dialog.showModal();
        window.lastPickerDialog=dialog;
        window.pickerClassic={background:getComputedStyle(dialog).backgroundColor,color:getComputedStyle(dialog).color};
      });}
    }
    const shell=document.createElement('style');shell.textContent='.popup{background:#242424;color:#eee;border:1px solid #777;border-radius:10px;padding:14px}.popup-controls{display:flex;justify-content:center;gap:8px;margin-top:12px}.popup-controls .menu_button{min-height:40px;padding:8px 16px}.popup .popup-content{min-width:0}';document.head.prepend(shell);
    window.pickerMounts=0;window.pickerReleases=0;
    window.startPicker=hasReferences=>{window.picked=undefined;void openComfyRoutePicker({context:{Popup,POPUP_TYPE:{CONFIRM:1}},namespace:scope,hasReferences,createStore,
      mountAppearance:dialog=>{if(!window.appearanceSession)return;pickerMounts++;const off=appearanceSession.mountPortal(dialog);return ()=>{pickerReleases++;off();};}
    }).then(value=>window.picked=value,error=>window.picked={error:error.message});};
    window.poolStore=createComfyPoolStore({dbName:'qianmu-comfy-pools-browser-synthetic'});
    const candidate=createComfyPoolCandidate({namespace:scope,choice:{recipe:routeRecipe,roles:true}});candidate.target.comfyCharacterEnabled=true;
    await poolStore.save(scope,{name:'历史候选',pool:{schema:COMFY_SELECTION_SCHEMA,namespace:scope,id:'draft',revision:'draft',enabled:false,styleLock:true,candidates:[candidate]}});
    window.poolDownloads=[];window.poolSelections=[];
    window.openPools=()=>{
      window.poolController=createComfyPoolController({store:poolStore,resolveNamespace:async()=>scope,
        readRecipe:options=>readPinnedComfyRouteWorkflow({...options,createStore}),pickWorkflow:async()=>({recipe:routeRecipe,roles:true}),onIcons:applyQianmuIcons,
        onSelect:row=>poolSelections.push(row),download:async blob=>poolDownloads.push(JSON.parse(await blob.text())),confirm:async()=>true});poolController.mount(host);
    };
  });
  for(const width of [320,393,1100]){
    await page.setViewportSize({width,height:898});await page.evaluate(()=>startPicker(true));await page.waitForSelector('dialog[open]');
    await page.locator('[data-comfy-route-pick="workflow"]').selectOption(await page.evaluate(()=>routeHead.id));
    await page.waitForFunction(()=>!document.querySelector('[data-comfy-route-pick="revision"]').disabled);
    await page.locator('[data-comfy-route-pick="revision"]').selectOption(await page.evaluate(()=>routeHead.revision));
    await page.locator('[data-comfy-route-references]').check();
    ok(`picker fields fit at ${width}`,await page.locator('.sd-comfy-route-picker').evaluate(node=>node.scrollWidth-node.clientWidth<=1&&[...node.querySelectorAll('select')].every(field=>field.getBoundingClientRect().height===40)));
    ok(`picker has no role toggle at ${width}`,await page.locator('[data-comfy-route-roles]').count()===0);
    if(appearance){
      const result=await page.evaluate(async()=>{
        const root=lastPickerDialog,picker=root.querySelector('.sd-comfy-route-picker'),fields=[...picker.querySelectorAll('select,input')],nodes=[...root.querySelectorAll('*')];
        const requested=appearanceSettings.appearance,before=fields.map(node=>[node.value,node.checked]),html=picker.innerHTML;
        fields[1].focus({preventScroll:true});const baseline=appearanceSession.size;
        const unrelated=document.createElement('dialog');unrelated.className='popup';document.body.append(unrelated);
        const hostColor=getComputedStyle(unrelated).color,hostBackground=getComputedStyle(unrelated).backgroundColor;
        let stable=true,classic=false,modes=true,writes=0;const put=IDBObjectStore.prototype.put;
        IDBObjectStore.prototype.put=function(...args){writes++;return put.apply(this,args);};
        try{
          for(const patch of [{family:requested.family==='glass'?'editorial':'glass',mode:requested.mode==='light'?'dark':'light'},{family:'classic'},requested]){
            appearanceSettings.appearance=patch===requested?requested:updateAppearancePreferences(appearanceSettings,patch);await appearanceSession.sync();await new Promise(resolve=>requestAnimationFrame(resolve));
            stable&&=nodes.every(node=>node.isConnected)&&picker.innerHTML===html&&document.activeElement===fields[1]&&JSON.stringify(fields.map(node=>[node.value,node.checked]))===JSON.stringify(before)&&appearanceSession.size===baseline;
            stable&&=getComputedStyle(unrelated).color===hostColor&&getComputedStyle(unrelated).backgroundColor===hostBackground&&!unrelated.hasAttribute('data-qm-theme');
            if(patch.family==='classic')classic=!root.hasAttribute('data-qm-theme')&&getComputedStyle(root).color===pickerClassic.color&&getComputedStyle(root).backgroundColor===pickerClassic.background;
            else modes&&=root.dataset.qmTheme===patch.family&&root.dataset.qmMode===patch.mode&&getComputedStyle(root).colorScheme===patch.mode;
          }
          return {stable,classic,modes,writes,owners:baseline};
        }finally{IDBObjectStore.prototype.put=put;unrelated.remove();}
      });
      ok(`${appearance} picker at ${width} switches in place, restores classic and never themes an unrelated ST popup: ${JSON.stringify(result)}`,result.stable&&result.classic&&result.modes&&result.writes===0&&result.owners===2);
      await page.screenshot({caret:'initial',path:fileURLToPath(new URL(`comfy-picker-${width}.png`,qa))});
    }
    await page.locator('[data-test-picker="confirm"]').click();await page.waitForFunction(()=>window.picked!==undefined);
    ok(`picker preserves explicit version and reference choice at ${width}`,await page.evaluate(()=>!picked.error&&picked.roles===false&&picked.useReferences===true&&picked.recipe.binding.revision===routeHead.revision));
    if(appearance)ok(`${appearance} picker at ${width} releases its appearance on confirmation`,await page.evaluate(()=>pickerMounts===pickerReleases&&appearanceSession.size===1&&!lastPickerDialog.hasAttribute('data-qm-theme')));
  }
  await page.evaluate(()=>startPicker(false));await page.waitForSelector('dialog[open]');
  ok('missing workbench references cannot be requested',await page.locator('[data-comfy-route-references]').isDisabled());
  await page.locator('[data-test-picker="cancel"]').click();await page.waitForFunction(()=>window.picked!==undefined);ok('cancel does not bind a workflow',await page.evaluate(()=>picked===null));
  if(appearance)ok(`${appearance} cancelling picker releases its appearance without binding`,await page.evaluate(()=>pickerMounts===pickerReleases&&appearanceSession.size===1&&!lastPickerDialog.hasAttribute('data-qm-theme')));
  await page.evaluate(()=>openPools());await page.waitForSelector('[data-pool-id]');await page.locator('[data-pool-action="edit"]').first().click();await page.waitForSelector('[data-pool-name]');
  await page.locator('[data-pool-member] summary').click();
  for(const width of [320,393,1100]){
    await page.setViewportSize({width,height:898});
    ok(`candidate controls fit at ${width}`,await page.locator('.sd-comfy-pools').evaluate(node=>node.scrollWidth-node.clientWidth<=1));
    ok(`candidate role toggle stays retired at ${width}`,await page.locator('[data-pool-action="toggle-roles"]').count()===0);
    await verifyAppearance(`candidate editor at ${width}`,'[data-pool-name]');
    await page.screenshot({caret:'initial',path:fileURLToPath(new URL(`comfy-pool-${width}.png`,qa))});
  }
  await page.locator('[data-pool-action="toggle-member"]').click();await page.waitForFunction(()=>document.querySelector('[data-pool-action="toggle-member"]').getAttribute('aria-pressed')==='true');
  await page.locator('[data-pool-action="add-member"]').click();await page.waitForFunction(()=>document.querySelectorAll('[data-pool-member]').length===2);
  await page.locator('[data-pool-action="style-lock"]').click();await page.waitForFunction(()=>document.querySelector('[data-pool-action="style-lock"]').getAttribute('aria-pressed')==='false');
  await verifyAppearance('dirty candidate choices before save','[data-pool-name]');
  await page.locator('[data-pool-action="save"]').click();await page.waitForSelector('[data-pool-id]');
  ok('new pool revision retires roles but preserves enabled choices, style lock and historical data',await page.evaluate(async()=>{
    const row=(await poolStore.list(scope))[0],versions=await poolStore.versions(scope,row.id);
    const latest=await poolStore.load(scope,row.id,row.revision),old=await poolStore.load(scope,row.id,versions.find(v=>v.version===1).revision);
    return versions.length===2&&latest.pool.candidates.length===2&&latest.pool.candidates.every(c=>!c.target.comfyCharacterEnabled)
      &&latest.pool.candidates[0].enabled&&!latest.pool.candidates[1].enabled&&!latest.pool.styleLock&&old.pool.candidates[0].target.comfyCharacterEnabled&&poolSelections.length===0;
  }));
  referenceImage=Buffer.from(await page.evaluate(async legacy=>{
    poolController.dispose();store.close();
    const {newCharacterArchive}=await import('/qianmu-character-archive.js');
    const {createCharacterArchiveStore}=await import('/qianmu-character-archive-store.js');
    const {createCharacterArchiveController}=await import('/qianmu-character-archive-view.js');
    const {applyQianmuIcons}=await import('/qianmu-icon-renderer.js');
    const canvas=document.createElement('canvas');canvas.width=80;canvas.height=100;const ctx=canvas.getContext('2d');ctx.fillStyle='#91baab';ctx.fillRect(0,0,80,100);
    const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/png')),bytes=await blob.arrayBuffer();
    const sha256=[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(n=>n.toString(16).padStart(2,'0')).join('');
    const reference={url:'/user/images/synthetic-character.png',name:'synthetic cover',mime:'image/png',bytes:blob.size,sha256};
    window.charStore=createCharacterArchiveStore({dbName:'qianmu-character-retirement-synthetic'});
    window.oldCharacter={...newCharacterArchive('char'),name:'历史角色',aliases:['旧别名'],ageStatus:'adult',comfy:{version:1,implementations:[legacy]},
      imagegen:{appearance:'black hair',negative:'extra hands',sensitiveAppearance:'',reference,preview:{...reference,sourceSha256:sha256},novelReference:{strength:0.6,fidelity:1}}};
    window.charHead=await charStore.save(scope,{document:oldCharacter});
    for(const category of ['user','other'])await charStore.save(scope,{document:{...newCharacterArchive(category),name:`测试 ${category}`}});
    window.startCharacters=()=>{
      window.charController=createCharacterArchiveController({store:charStore,resolveNamespace:async()=>scope,getContext:async()=>({chatKey:'synthetic-chat',subjects:[]}),onIcons:applyQianmuIcons,confirm:async()=>true});charController.mount(host);
    };
    return [...new Uint8Array(bytes)];
  },historicalImplementation));
  await page.evaluate(()=>startCharacters());await page.waitForSelector('.sd-character-file');
  for(const width of [320,393,1100]){
    await page.setViewportSize({width,height:898});
    ok(`character categories fit at ${width}`,await page.locator('.sd-character-library').evaluate(node=>node.scrollWidth-node.clientWidth<=1));
    ok(`three character categories remain present at ${width}`,await page.locator('[data-archive-category]').count()===3);
  }
  await page.locator(`[data-archive-action="edit"][data-archive-id="${await page.evaluate(()=>charHead.id)}"]`).click();await page.waitForSelector('[data-archive-field="name"]');
  await page.waitForFunction(()=>document.querySelector('.sd-character-cover-upload img')?.naturalWidth===80);
  for(const width of [320,393,1100]){
    await page.setViewportSize({width,height:898});
    await verifyAppearance(`character editor at ${width}`,'[data-archive-field="name"]');
    await page.screenshot({caret:'initial',path:fileURLToPath(new URL(`comfy-character-${width}.png`,qa))});
    const overflow=await page.locator('.sd-character-editor').evaluate(node=>({width:node.clientWidth,scroll:node.scrollWidth,children:[...node.querySelectorAll('*')].filter(child=>child.getBoundingClientRect().right>node.getBoundingClientRect().right+1).slice(0,10).map(child=>child.className)}));
    ok(`character editor contains fields at ${width}: ${JSON.stringify(overflow)}`,overflow.scroll-overflow.width<=1);
    ok(`character toolbar retains reachable full-sized actions at ${width}`,await page.locator('.sd-character-editor > fieldset > .sd-character-tools').evaluate(node=>[...node.querySelectorAll('button')].every(button=>{const box=button.getBoundingClientRect(),toolbar=node.getBoundingClientRect();return box.width>=40&&box.height>=40&&box.left>=toolbar.left-1&&box.right<=toolbar.right+1;})));
    ok(`retired editor absent but reference control remains at ${width}`,await page.locator('[data-archive-action^="comfy-"]').count()===0&&await page.locator('[data-archive-image]').count()===1);
  }
  await page.locator('[data-archive-field="name"]').fill('更新角色');await verifyAppearance('dirty character before save','[data-archive-field="name"]');await page.locator('[data-archive-action="save"]').click();await page.waitForSelector('.sd-character-file');
  ok('editing old archive keeps legacy workflow, references and appearance',await page.evaluate(async()=>{
    const saved=await charStore.load(scope,charHead.id);return saved.head.version===2&&saved.document.name==='更新角色'
      &&JSON.stringify(saved.document.comfy)===JSON.stringify(oldCharacter.comfy)&&JSON.stringify(saved.document.imagegen)===JSON.stringify(oldCharacter.imagegen);
  }));
  await page.locator(`[data-archive-action="edit"][data-archive-id="${await page.evaluate(()=>charHead.id)}"]`).click();await page.waitForSelector('[data-archive-field="name"]');
  await page.locator('[data-archive-action="copy"]').click();await page.waitForFunction(()=>document.querySelector('[data-archive-field="name"]').value.endsWith('副本'));
  await page.locator('[data-archive-action="save"]').click();await page.waitForSelector('.sd-character-file');
  ok('copy retains identity and reference but does not inherit retired workflows',await page.evaluate(async()=>{
    const copied=(await charStore.list(scope)).find(row=>row.name.endsWith('副本')),saved=await charStore.load(scope,copied.id),old=await charStore.load(scope,charHead.id);
    return !Object.hasOwn(saved.document,'comfy')&&JSON.stringify(saved.document.imagegen)===JSON.stringify(old.document.imagegen)&&old.document.comfy.implementations.length===1;
  }));
  await page.locator('[data-archive-action="new"][data-category="other"]').click();await page.waitForSelector('[data-archive-field="name"]');
  await page.locator('[data-archive-field="name"]').fill('新路人');await page.locator('[data-archive-action="save"]').click();await page.waitForSelector('.sd-character-file');
  ok('new archive has no retired fields or implicit copied reference',await page.evaluate(async()=>{
    const row=(await charStore.list(scope)).find(row=>row.name==='新路人'),saved=await charStore.load(scope,row.id);
    return saved.document.category==='other'&&!Object.hasOwn(saved.document,'comfy')&&saved.document.imagegen.reference===null;
  }));
  for(const width of [393,1100]){
    await page.setViewportSize({width,height:898});
    for(const connection of [{options:{comfyTransport:'gateway',allowPrivateNetwork:true}},{options:{comfyTransport:'browser'}}]){
      const form=createStoryboardFormFixture({family:'comfy',connection}).content;
      await page.evaluate(html=>{host.innerHTML=html;},form);
      ok(`native controls stay out of daily view and preserve the saved permission at ${width}/${connection.options.comfyTransport}`,await page.evaluate(options=>{
        const details=document.querySelector('.sd-comfy-connection-options'),field=document.querySelector('.sd-storyboard-private-network');
        if(details.open||field.checkVisibility()||field.checked!==Boolean(options.allowPrivateNetwork))throw Error(JSON.stringify({open:details.open,visible:field.checkVisibility(),checked:field.checked,expected:options.allowPrivateNetwork}));
        return true;
      },connection.options));
      await page.locator('.sd-comfy-connection-options > summary').click();
      ok(`native connection management opens within the panel at ${width}/${connection.options.comfyTransport}`,await page.evaluate(()=>{
        const details=document.querySelector('.sd-comfy-connection-options'),select=details.querySelector('select'),box=details.getBoundingClientRect(),control=select.getBoundingClientRect();
        return details.open&&control.width>0&&control.left>=box.left&&control.right<=box.right+1&&box.right<=innerWidth&&details.scrollWidth<=details.clientWidth+1;
      }));
    }
    for(const baseUrl of ['https://cloud.comfy.org','https://www.runninghub.cn']){
      await page.evaluate(html=>{host.innerHTML=html;},createStoryboardFormFixture({family:'comfy',connection:{baseUrl}}).content);
      ok(`cloud ${baseUrl} has only its platform label, not native authorization at ${width}`,await page.evaluate(()=>{
        return !!document.querySelector('.sd-comfy-platform .sd-badge')&&!document.querySelector('.sd-comfy-connection-options,.sd-comfy-targets,.sd-storyboard-private-network');
      }));
    }
  }
  await page.evaluate(html=>{host.innerHTML=html;},createStoryboardFormFixture({family:'comfy'}).content);
  await page.addScriptTag({content:storyboardFunctionSource('bindStoryboardComfyTargets')});
  await page.evaluate(async()=>{
    const core=await import('/qianmu-storyboard.js');window.connectionState=core.createStoryboardDefaults();connectionState.source='comfy';
    window.clone=value=>structuredClone(value);window.storyboardState=()=>connectionState;window.storyboardConnectionState=state=>state.connections.comfy;
    window.getStoryboardComfyTransport=core.getStoryboardComfyTransport;window.storyboardCaptureWorkbench=()=>{};window.storyboardRequestHeaders=()=>({});window.confirmDialog=async()=>false;window.toast=()=>{};
    window.targetMounts=0;window.targetDisposes=0;window.targetRuntime={mountComfyTargets:()=>{targetMounts++;return()=>targetDisposes++;}};
    window.featureRuntime={load:name=>name==='comfyTargets'?new Promise(resolve=>window.finishTargetLoad=()=>resolve(targetRuntime)):Promise.resolve({resolveImageAccountNamespace:async()=>scope})};
    bindStoryboardComfyTargets(host);
  });
  await page.locator('.sd-comfy-connection-options > summary').click();await page.locator('.sd-comfy-targets > summary').click();
  await page.waitForFunction(()=>!!window.finishTargetLoad);
  await page.locator('.sd-comfy-connection-options > summary').click();
  await page.waitForFunction(()=>!document.querySelector('.sd-comfy-targets').open);
  await page.evaluate(()=>finishTargetLoad());await page.waitForTimeout(30);
  ok('closing connection management ignores a late authorization module load',await page.evaluate(()=>targetMounts===0&&!document.querySelector('.sd-comfy-targets-body').textContent));
  await page.evaluate(()=>{featureRuntime.load=name=>Promise.resolve(name==='comfyTargets'?targetRuntime:{resolveImageAccountNamespace:async()=>scope});});
  await page.locator('.sd-comfy-connection-options > summary').click();await page.locator('.sd-comfy-targets > summary').click();
  await page.waitForFunction(()=>targetMounts===1);
  await page.locator('.sd-comfy-connection-options > summary').click();await page.waitForFunction(()=>targetDisposes===1);
  ok('closing management disposes its active authorization view without changing the saved connection',await page.evaluate(()=>!document.querySelector('.sd-comfy-targets').open&&connectionState.connections.comfy.draft.options.comfyTransport==='gateway'));
  await page.evaluate(()=>host._sdComfyTargetsCleanup());
  assert.equal(external,0);assert.deepEqual(errors,[]);console.log(JSON.stringify({checks,appearance:appearance||'classic',external,errors}));
}finally{await context.close();await browser.close();}
