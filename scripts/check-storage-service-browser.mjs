// Actual service footer + cleanup chooser, local theme runtime, synthetic state only.
// All requests are intercepted; no ST account, provider or user database is accessed.
import assert from 'node:assert/strict';
import {readFile,mkdir} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {join} from 'node:path';
import {storyboardFunctionSource as section} from '../tests/helpers/storyboard-form-fixture.mjs';
const require=createRequire(import.meta.url),{chromium}=require(process.env.QIANMU_PLAYWRIGHT_MODULE||'playwright');
const browser=await chromium.launch({channel:process.env.QIANMU_BROWSER_CHANNEL||undefined,headless:true});
const context=await browser.newContext(),page=await context.newPage(),checks=[],errors=[];let external=0;
page.on('pageerror',error=>errors.push(error.message));
await context.route('**/*',async route=>{
  const url=new URL(route.request().url());
  if(url.origin==='https://qianmu.test'&&url.pathname==='/')return route.fulfill({contentType:'text/html',body:'<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'});
  if(url.origin==='https://qianmu.test'&&/^\/qianmu-[a-z0-9-]+\.js$/.test(url.pathname))return route.fulfill({contentType:'text/javascript',body:await readFile(new URL('..'+url.pathname,import.meta.url),'utf8')});
  external++;return route.abort();
});
try{
  await page.goto('https://qianmu.test/');
  await page.addStyleTag({content:await readFile(new URL('../style.css',import.meta.url),'utf8')});
  await page.addStyleTag({content:await readFile(new URL('../qianmu-theme-skins.css',import.meta.url),'utf8')});
  await page.addStyleTag({content:'body{margin:0;background:#777}#story-director-modal .sd-card{box-sizing:border-box}#story-director-modal .sd-storage-service{margin-top:0}'});
  if(process.env.QIANMU_STORAGE_SCREENSHOT_DIR)await mkdir(process.env.QIANMU_STORAGE_SCREENSHOT_DIR,{recursive:true});
  await page.evaluate(async source=>{
    Object.assign(window,await import('/qianmu-appearance-session.js'),await import('/qianmu-storage-backup-view.js'));
    Object.assign(window,{MODAL_ID:'story-director-modal',VERSION:'1.59.384',STORAGE_CLEANUP_LAYER_ID:'qianmu-storage-cleanup-layer',THEME_KEYS:['light','dark'],NOTES_THEME_VARIABLES:[],STORAGE_ITEM_RISK:{},STORAGE_CHAT_CLEARABLE:new Set(['audio']),
      applyQianmuIcons(){},refreshQianmuUpdateStatus:async()=>{},getChatKey:()=> 'fixture',htmlEscape:value=>String(value??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;'),formatStorageBytes:value=>`${value} B`});
    (0,eval)(source);
    window.setup=async(family,mode,status='ready')=>{
      window.appearanceSession?.reset();document.body.replaceChildren();
      window.settings={theme:mode,appearance:{version:1,family,mode,source:'manual',accent:'#64833d'}};
      window.optionalServiceState={status,services:[],version:'1.59.384',latestVersion:'1.59.384'};
      const root=document.createElement('section');root.id=MODAL_ID;root.className=`open sd-theme-${mode}`;
      root.innerHTML=`<div class="sd-backdrop"></div><section class="sd-window"><main class="sd-body"><section class="sd-card sd-storage-card"><h3>数据管理</h3>${renderStorageServiceStatus()}</section></main></section>`;
      document.body.append(root);
      window.appearanceSession=createQianmuAppearanceSession({document,readSettings:()=>settings,loadStyles:()=>({promise:Promise.resolve(true),cancel(){}})});
      appearanceSession.mount(root);await appearanceSession.sync();await new Promise(done=>requestAnimationFrame(done));
      return root;
    };
  },['optionalServiceLabel','optionalServiceLatestDisplay','optionalServiceDetail','renderStorageServiceStatus','paintOptionalServiceState','refreshOptionalServiceState','bindStorageManagementEvents','storageChatScopeLabel','openStorageCleanupDialog','openStorageChatCleanupDialog'].map(section).join('\n'));
  for(const width of [320,1280])for(const family of ['classic','editorial','glass'])for(const mode of ['light','dark']){
    await page.setViewportSize({width,height:800});
    for(const status of ['idle','checking','ready','missing','unsupported','error']){
      const result=await page.evaluate(async({family,mode,status})=>{
        const root=await setup(family,mode,status),footer=root.querySelector('.sd-storage-service'),label=root.querySelector('.sd-optional-service-label');
        const boxes=[footer,...footer.children,...root.querySelectorAll('.sd-storage-service-versions > span')].map(node=>node.getBoundingClientRect());
        return {fit:boxes.every(box=>box.left>=0&&box.right<=innerWidth)&&footer.scrollWidth<=footer.clientWidth,
          label:label.textContent,color:getComputedStyle(label).color,border:getComputedStyle(label).borderTopWidth,height:label.getBoundingClientRect().height,
          current:root.querySelector('.sd-storage-service-current').textContent,latest:root.querySelector('.sd-storage-service-latest').textContent};
      },{family,mode,status});
      assert.equal(result.fit,true,`${family}/${mode}/${width}/${status} overflow`);
      assert.equal(result.border,'1px');assert.ok(result.height>=24&&result.height<=34);
      const rgb=mode==='dark'?{ready:'rgb(121, 214, 160)',error:'rgb(255, 153, 159)',gray:'rgb(178, 184, 192)'}:{ready:'rgb(33, 116, 69)',error:'rgb(176, 49, 58)',gray:'rgb(98, 105, 116)'};
      assert.equal(result.color,rgb[status==='ready'?'ready':['error','unsupported'].includes(status)?'error':'gray']);
      assert.equal(result.current,status==='ready'?'v1.59.384':status==='missing'?'未安装':'未获取');assert.equal(result.latest,'v1.59.384');
      checks.push(`${family}/${mode}/${width}/${status}: compact colored status, distinct versions, no overflow`);
      if(process.env.QIANMU_STORAGE_SCREENSHOT_DIR&&((family==='classic'&&mode==='light'&&width===320&&status==='ready')||(family==='glass'&&mode==='dark'&&width===1280&&status==='error')))await page.screenshot({path:join(process.env.QIANMU_STORAGE_SCREENSHOT_DIR,`service-${family}-${mode}-${width}.png`)});
    }
    const cleanup=await page.evaluate(async({family,mode})=>{
      await setup(family,mode);
      const sample={idb:{stores:[{name:'audio',label:'音频缓存',bytes:32,count:1}]},diagnosticsBytes:8};
      const pending=openStorageCleanupDialog(sample),layer=document.getElementById(STORAGE_CLEANUP_LAYER_ID),dialog=layer.querySelector('[role=dialog]');
      await new Promise(done=>requestAnimationFrame(done));
      const rect=dialog.getBoundingClientRect(),confirm=layer.querySelector('.sd-storage-cleanup-confirm');
      const before=confirm.disabled,hasBackup=!!layer.querySelector('.sd-storage-backup-home,input[type=file]');
      layer.querySelector('input[value=audio]').click();const enabled=!confirm.disabled;
      layer.querySelector('.sd-storage-cleanup-cancel').click();
      return {fit:rect.left>=0&&rect.right<=innerWidth&&rect.top>=0&&rect.bottom<=innerHeight,hasBackup,before,enabled,canceled:await pending===null,removed:!layer.isConnected};
    },{family,mode});
    assert.equal(cleanup.fit,true);assert.equal(cleanup.hasBackup,false);for(const key of ['before','enabled','canceled','removed'])assert.equal(cleanup[key],true,key);
    checks.push(`${family}/${mode}/${width}: cleanup is selection only, cancellation releases chooser`);
  }
  const live=await page.evaluate(async()=>{
    const root=await setup('glass','dark'),card=root.querySelector('.sd-card');
    const input=document.createElement('input');input.value='keep my draft';card.prepend(input);input.focus();input.setSelectionRange(5,7);
    window.optionalServiceState={status:'idle',services:[],latestVersion:'1.59.384',checkedAt:0};window.optionalServiceProbePromise=null;
    let calls=0;window.ctx=()=>({getRequestHeaders:()=>({})});window.featureRuntime={load:async()=>({probeQianmuOptionalService:async()=>{calls++;return new Promise(resolve=>window.resolveProbe=resolve);}})};
    bindStorageManagementEvents(root);const button=root.querySelector('.sd-storage-service-refresh');button.click();button.click();await new Promise(done=>setTimeout(done,0));
    const pending=optionalServiceProbePromise;resolveProbe({status:'ready',version:'1.59.384',services:[],checkedAt:Date.now()});await pending;
    await refreshOptionalServiceState(false);
    return {calls,sameCard:card===root.querySelector('.sd-card'),sameInput:input===document.activeElement&&input.value==='keep my draft'&&input.selectionStart===5&&input.selectionEnd===7,
      current:root.querySelector('.sd-storage-service-current').textContent,latest:root.querySelector('.sd-storage-service-latest').textContent};
  });
  assert.equal(live.calls,1);assert.equal(live.sameCard,true);assert.equal(live.sameInput,true);assert.equal(live.current,'v1.59.384');assert.equal(live.latest,'v1.59.384');checks.push('live refresh coalesces and preserves unsaved input, selection, card, and known latest');
  assert.equal(external,0);assert.deepEqual(errors,[]);console.log(JSON.stringify({checks,external,errors,productionDataRead:false}));
}finally{await context.close();await browser.close();}
