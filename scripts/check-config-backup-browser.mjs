// Native download + file input against synthetic settings. No production ST or real credentials.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {storyboardFunctionSource as section} from '../tests/helpers/storyboard-form-fixture.mjs';
const require=createRequire(import.meta.url),{chromium}=require(process.env.QIANMU_PLAYWRIGHT_MODULE||'playwright');
const browser=await chromium.launch({channel:process.env.QIANMU_BROWSER_CHANNEL||undefined,headless:true});
const context=await browser.newContext({acceptDownloads:true});let external=0;const errors=[];
await context.route('**/*',async route=>{
  const url=new URL(route.request().url());
  if(url.origin==='https://qianmu.test'){
    if(url.pathname==='/')return route.fulfill({contentType:'text/html',body:'<div id="story-director-modal"><div id="fixture-root"></div></div>'});
    if(['/qianmu-config-connections.js','/qianmu-config-export.js','/qianmu-json-input.js','/qianmu-config-apply.js','/qianmu-data-migrations.js','/qianmu-config-undo.js','/qianmu-config-undo-action.js','/qianmu-storage-backup-view.js'].includes(url.pathname))return route.fulfill({contentType:'application/javascript',body:await readFile(new URL('..'+url.pathname,import.meta.url))});
  }
  external++;return route.abort();
});
try{
  const page=await context.newPage();page.on('pageerror',e=>{errors.push(e.message);console.error('Isolated page error:',e.message);});await page.goto('https://qianmu.test');
  const css=await readFile(new URL('../style.css',import.meta.url),'utf8');
  const hiddenRule=css.match(/#story-director-modal \.sd-storage-backup-section \.sd-undo-config\[hidden\]\s*\{[^}]+\}/)?.[0];
  assert.ok(hiddenRule);await page.addStyleTag({content:'.sd-btn { display:flex !important; }\n'+hiddenRule});
  await page.evaluate(async source=>{
    Object.assign(window,await import('/qianmu-config-connections.js'));
    Object.assign(window,await import('/qianmu-config-export.js'));
    Object.assign(window,await import('/qianmu-config-apply.js'),{PROSE_LAYOUT_STORAGE_KEY:'fixture-layout'});
    Object.assign(window,await import('/qianmu-config-undo.js'),await import('/qianmu-config-undo-action.js'),await import('/qianmu-storage-backup-view.js'));
    window.configUndo=createConfigUndoSlot();window.configUndoAction=null;
    window.settings={apiKey:'fixture-main-private',apiUrl:'https://fixture.invalid',theme:'dark',tts:{providers:{doubao:{apiKey:'fixture-tts-private',accessKey:'fixture-access-private',voiceLibrary:[{voiceId:'saved-voice'}]}}},coread:{books:[{id:'book',progress:.6}],memory:{summaryApiKey:'fixture-summary-private'}}};
    window.notices=[];window.prompts=[];window.allow=false;window.saved=0;
    window.context={extensionSettings:{}};Object.assign(window,{clone:structuredClone,confirmDialog:async(title,text)=>{prompts.push(text);return allow;},
      toast:(...args)=>notices.push(args),fileStamp:()=> 'isolated',isPlainObject:value=>value&&typeof value==='object'&&!Array.isArray(value),
      ctx:()=>context,MODULE_NAME:'fixture',DEFAULT_SETTINGS:{},configRestoreActivity:()=>({}),normalizeStoryboardState:structuredClone,migrateSettings(){},mergeDefaults(){},getSettings:()=>context.extensionSettings.fixture,
      storyboardPlanArchiveEpoch:0,storyboardPlanArchiveTimer:null,storyboardPlanArchiveCache:new Map(),
      storyboardPipelineArchiveEpoch:0,storyboardPipelineArchiveCache:new Map(),storyboardPipelineArchiveWrites:new Map(),storyboardPipelineArchiveHydration:null,
      storyboardSnapshotEpoch:0,storyboardSnapshotCache:new Map(),storyboardSnapshotReads:new Map(),
      storyboardAdmissionEpoch:0,
      storyboardPlansForPortableExport:async value=>value,seedBuiltinTheaters(){},saveSettings:()=>saved++,storyboardSchedulePlanArchive(){},applyDirectorInjection:async()=>{},renderFloatButton(){},renderModal(){}});
    // Execute the same entry adapters called by the storage card, only host services are stubs.
    new Function(source+';window.runExport=exportConfig;window.runImport=importConfig;window.renderModal=()=>{document.getElementById("fixture-root").innerHTML=renderStorageBackupSection();bindStorageManagementEvents(document);};renderModal();')();
  },['ttsDownloadBlob','exportConfig','importConfig','configApplyOptions','undoConfigRestore','bindStorageManagementEvents'].map(section).join('\n'));
  await page.locator('.sd-storage-backup-section').evaluate(el=>{el.open=true;});
  const downloadEvent=page.waitForEvent('download');await page.locator('.sd-export-config').click();const download=await downloadEvent;
  assert.match(download.suggestedFilename(),/^qianmu-config-.*\.json$/);
  const pack=JSON.parse(await readFile(await download.path(),'utf8'));
  assert.equal(pack.version,2);assert.equal(pack.includeApi,false);assert.doesNotMatch(JSON.stringify(pack),/fixture-(main|tts|access|summary)-private/);
  assert.equal(pack.settings.tts.providers.doubao.voiceLibrary[0].voiceId,'saved-voice');assert.equal(pack.settings.coread.books[0].progress,.6);
  await page.evaluate(()=>{allow=true;settings.apiKey='recipient-main';settings.tts.providers.doubao.apiKey='recipient-voice';settings.coread.memory.summaryApiKey='recipient-memory';});
  pack.settings.focusClock={status:'running',phase:'focus',focusMinutes:30,endsAt:9999999999999,lock:{owner:'old'},sessionToken:'foreign',voiceCleanupCues:[{cacheKey:'foreign'}],history:[{id:'completed'}]};
  pack.settings.theme='light';await page.locator('.sd-import-config-file').setInputFiles({name:'config.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(pack))});
  await page.waitForFunction(()=>saved===1);
  assert.deepEqual(await page.evaluate(()=>[settings.theme,settings.apiKey,settings.tts.providers.doubao.apiKey,settings.coread.memory.summaryApiKey]),['light','recipient-main','recipient-voice','recipient-memory']);
  assert.deepEqual(await page.evaluate(()=>[settings.focusClock.status,settings.focusClock.lock,settings.focusClock.voiceCleanupCues.length,settings.focusClock.history[0].id]),['idle',null,0,'completed']);
  assert.ok(await page.evaluate(()=>prompts.some(text=>text.includes('当前连接与密钥保留'))));
  await page.locator('.sd-import-config-file').setInputFiles({name:'bad.json',mimeType:'application/json',buffer:Buffer.from('{"type":"qianmu-config","version":2,"settings":{"__proto__":{"x":true}}}')});
  await page.waitForFunction(()=>notices.some(row=>row[0].includes('导入失败')));assert.equal(await page.evaluate(()=>saved),1);
  await page.locator('.sd-storage-backup-section').evaluate(el=>{el.open=true;});
  assert.equal(await page.locator('.sd-undo-config').isVisible(),true);
  const before=await page.evaluate(()=>prompts.length);await page.evaluate(()=>{allow=false;});await page.locator('.sd-undo-config').click();
  await page.waitForFunction(count=>prompts.length>count,before);assert.equal(await page.evaluate(()=>saved),1);
  await page.evaluate(()=>{allow=true;});await page.locator('.sd-undo-config').click();await page.waitForFunction(()=>saved===2);
  assert.deepEqual(await page.evaluate(()=>[settings.theme,settings.apiKey,configUndo.available(settings)]),['dark','recipient-main',false]);
  assert.equal(await page.locator('.sd-undo-config').isVisible(),false);
  await page.locator('.sd-import-config-file').setInputFiles({name:'config.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(pack))});await page.waitForFunction(()=>saved===3);
  await page.locator('.sd-storage-backup-section').evaluate(el=>{el.open=true;});
  // A stale visible button must still refuse after a user edit without a rerender.
  await page.evaluate(()=>{settings.theme='user-change';});await page.locator('.sd-undo-config').click();
  await page.waitForFunction(()=>notices.some(row=>row[0].includes('无法撤回')));assert.equal(await page.evaluate(()=>saved),3);
  assert.equal(await page.evaluate(()=>settings.theme),'user-change');
  // Native Storage failure injection: a failed undo must neither announce success
  // nor consume its recovery point; a failed compensation must be visible instead.
  for(const incomplete of [false,true]){
    const savedBefore=await page.evaluate(()=>saved);
    await page.evaluate(()=>{settings.theme='before-storage-failure';localStorage.setItem('fixture-layout','original-layout-bytes');});
    const storagePack={...pack,settings:{...pack.settings,proseLayout:{enabled:false,width:80}}};
    await page.locator('.sd-import-config-file').setInputFiles({name:'storage-config.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(storagePack))});
    await page.waitForFunction(count=>saved===count+1,savedBefore);
    await page.locator('.sd-storage-backup-section').evaluate(el=>{el.open=true;});
    const prior=await page.evaluate(()=>({saved,notices:notices.length,raw:localStorage.getItem('fixture-layout')}));
    await page.evaluate(incomplete=>{
      window.storageFailureCalls=0;window.nativeSetItem=Storage.prototype.setItem;
      Storage.prototype.setItem=function(key,value){
        if(key!=='fixture-layout')return nativeSetItem.call(this,key,value);
        storageFailureCalls++;
        if(incomplete){if(storageFailureCalls===1)nativeSetItem.call(this,key,value);throw new DOMException('Isolated storage failure','QuotaExceededError');}
        if(storageFailureCalls===1)throw new DOMException('Isolated storage failure','QuotaExceededError');
        return nativeSetItem.call(this,key,value);
      };
    },incomplete);
    try{
      await page.locator('.sd-undo-config').click();
      await page.waitForFunction(count=>notices.length>count,prior.notices);
      const failure=await page.evaluate(()=>({saved,theme:settings.theme,available:configUndo.available(settings),raw:localStorage.getItem('fixture-layout'),notice:notices.at(-1),calls:storageFailureCalls}));
      assert.equal(failure.saved,prior.saved);assert.equal(failure.theme,'light');assert.equal(failure.available,true);assert.equal(failure.calls,2);
      assert.equal(failure.notice[1],'error');assert.equal(failure.raw,incomplete?'original-layout-bytes':prior.raw);
      assert.match(failure.notice[0],incomplete?/部分状态未能还原/:/已恢复原状态/);
    }finally{await page.evaluate(()=>{Storage.prototype.setItem=nativeSetItem;delete window.nativeSetItem;});}
    const noticeCount=await page.evaluate(()=>notices.length);
    await page.locator('.sd-undo-config').click();await page.waitForFunction(count=>notices.length>count,noticeCount);
    if(incomplete){
      assert.equal(await page.evaluate(()=>saved),prior.saved);
      assert.match(await page.evaluate(()=>notices.at(-1)[0]),/无法撤回/);
      assert.equal(await page.evaluate(()=>settings.theme),'light');
    }else{
      assert.deepEqual(await page.evaluate(()=>[saved,settings.theme,localStorage.getItem('fixture-layout'),configUndo.available(settings)]),[prior.saved+1,'before-storage-failure','original-layout-bytes',false]);
    }
  }
  await page.evaluate(()=>{let nested={text:'kept'};for(let n=0;n<42;n++)nested={child:nested};settings={theme:'preservation',nested};allow=true;});
  const preserveEvent=page.waitForEvent('download');await page.locator('.sd-export-config').click();const preserved=await preserveEvent;
  assert.match(preserved.suggestedFilename(),/^qianmu-config-preservation-/);
  const content=JSON.parse(await readFile(await preserved.path(),'utf8'));let leaf=content.settings.nested;for(let n=0;n<42;n++)leaf=leaf.child;assert.equal(leaf.text,'kept');
  assert.ok(await page.evaluate(()=>notices.some(row=>row[0].includes('当前版本不能直接恢复')&&row[1]==='warning')));
  // Full shipped CSS and the actual storage-card view, inside the real modal/body
  // hierarchy. Only inventory data/host are synthetic; no sizing overrides hide overflow.
  await page.addStyleTag({content:css});
  await page.evaluate(source=>{
    window.storageInventoryState={status:'loading',data:null};window.htmlEscape=value=>String(value).replaceAll('&','&amp;').replaceAll('<','&lt;');
    window.renderFixtureStorage=new Function(source+';return renderStorageManagementCard;')();
  },section('renderStorageManagementCard'));
  const layouts=[];
  for(const width of [320,393,720,1100])for(const theme of ['', 'sd-theme-dark'])for(const recoverable of [false,true]){
    await page.setViewportSize({width,height:898});
    await page.evaluate(({theme,recoverable})=>{
      storageInventoryState.status=recoverable?'error':'loading';storageInventoryState.error='临时盘点不可用';
      const modal=document.querySelector('#story-director-modal');modal.className='open '+theme;
      modal.innerHTML='<section class="sd-window"><main class="sd-body">'+renderFixtureStorage()+'</main></section>';
      modal.querySelector('.sd-undo-config').hidden=!recoverable;
    },{theme,recoverable});
    assert.equal(await page.locator('.sd-export-config').isVisible(),false);
    await page.locator('.sd-storage-backup-section > summary').click();
    const layout=await page.evaluate(()=>{
      const root=document.querySelector('.sd-storage-card'),body=document.querySelector('.sd-body');
      const rows=[...root.querySelectorAll('.sd-storage-backup-row')].map(row=>{
        const box=row.getBoundingClientRect(),controls=[...row.querySelectorAll('button')].map(el=>el.getBoundingClientRect());
        return {contained:controls.every(b=>b.left>=box.left-1&&b.right<=box.right+1),aligned:controls.length<2||Math.abs(controls[0].height-controls[1].height)<1,label:row.querySelector('span').getBoundingClientRect().width};
      });
      return {rows,noOverflow:root.scrollWidth<=root.clientWidth+1&&body.scrollWidth<=body.clientWidth+1,
        filesHidden:[...root.querySelectorAll('input[type=file]')].every(el=>el.getClientRects().length===0)};
    });
    assert.equal(layout.rows.length,6);assert.equal(layout.noOverflow,true,`overflow at ${width}/${theme}/${recoverable}`);
    assert.ok(layout.rows.every(row=>row.contained&&row.aligned&&row.label>0),`controls at ${width}/${theme}/${recoverable}`);
    assert.equal(layout.filesHidden,true);assert.equal(await page.locator('.sd-undo-config').isVisible(),recoverable);
    await page.locator('.sd-storage-backup-section > summary').press('Enter');
    assert.equal(await page.locator('.sd-export-config').isVisible(),false);
    assert.equal(await page.locator('.sd-undo-config').isVisible(),false);
    layouts.push({width,theme:theme||'default',recoverable});
  }
  assert.deepEqual(errors,[]);assert.equal(external,0);console.log(JSON.stringify({nativeDownload:true,nativeFileInput:true,nestedConnectionsExcluded:true,recipientConnectionsPreserved:true,malformedNoWrite:true,undoCancel:true,undoApplied:true,undoStaleBlocked:true,nativeStorageFailureRetry:true,incompleteCompensationBlocksRetry:true,explicitPreservationDownload:true,fullStyleLayouts:layouts,external,errors}));
}finally{await context.close();await browser.close();}
