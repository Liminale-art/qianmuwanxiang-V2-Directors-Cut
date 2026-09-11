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
  pack.settings.theme='light';await page.locator('.sd-import-config-file').setInputFiles({name:'config.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(pack))});
  await page.waitForFunction(()=>saved===1);
  assert.deepEqual(await page.evaluate(()=>[settings.theme,settings.apiKey,settings.tts.providers.doubao.apiKey,settings.coread.memory.summaryApiKey]),['light','recipient-main','recipient-voice','recipient-memory']);
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
  await page.evaluate(()=>{let nested={text:'kept'};for(let n=0;n<42;n++)nested={child:nested};settings={theme:'preservation',nested};allow=true;});
  const preserveEvent=page.waitForEvent('download');await page.locator('.sd-export-config').click();const preserved=await preserveEvent;
  assert.match(preserved.suggestedFilename(),/^qianmu-config-preservation-/);
  const content=JSON.parse(await readFile(await preserved.path(),'utf8'));let leaf=content.settings.nested;for(let n=0;n<42;n++)leaf=leaf.child;assert.equal(leaf.text,'kept');
  assert.ok(await page.evaluate(()=>notices.some(row=>row[0].includes('当前版本不能直接恢复')&&row[1]==='warning')));
  assert.deepEqual(errors,[]);assert.equal(external,0);console.log(JSON.stringify({nativeDownload:true,nativeFileInput:true,nestedConnectionsExcluded:true,recipientConnectionsPreserved:true,malformedNoWrite:true,undoCancel:true,undoApplied:true,undoStaleBlocked:true,explicitPreservationDownload:true,external,errors}));
}finally{await context.close();await browser.close();}
