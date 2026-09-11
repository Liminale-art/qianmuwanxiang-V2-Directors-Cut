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
    if(url.pathname==='/')return route.fulfill({contentType:'text/html',body:'<section class="sd-storage-backup-section"><button class="sd-export-config">导出</button><button class="sd-import-config">导入</button><input class="sd-import-config-file" type="file"></section>'});
    if(url.pathname==='/qianmu-config-connections.js')return route.fulfill({contentType:'application/javascript',body:await readFile(new URL('../qianmu-config-connections.js',import.meta.url))});
  }
  external++;return route.abort();
});
try{
  const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));await page.goto('https://qianmu.test');
  await page.evaluate(async source=>{
    Object.assign(window,await import('/qianmu-config-connections.js'));
    window.settings={apiKey:'fixture-main-private',apiUrl:'https://fixture.invalid',theme:'dark',tts:{providers:{doubao:{apiKey:'fixture-tts-private',accessKey:'fixture-access-private',voiceLibrary:[{voiceId:'saved-voice'}]}}},coread:{books:[{id:'book',progress:.6}],memory:{summaryApiKey:'fixture-summary-private'}}};
    window.notices=[];window.prompts=[];window.allow=false;window.saved=0;
    window.context={extensionSettings:{}};Object.assign(window,{clone:structuredClone,confirmDialog:async(title,text)=>{prompts.push(text);return allow;},
      toast:(...args)=>notices.push(args),fileStamp:()=> 'isolated',isPlainObject:value=>value&&typeof value==='object'&&!Array.isArray(value),
      ctx:()=>context,MODULE_NAME:'fixture',DEFAULT_SETTINGS:{},mergeDefaults(){},getSettings:()=>context.extensionSettings.fixture,
      storyboardPlanArchiveEpoch:0,storyboardPlanArchiveTimer:null,storyboardPlanArchiveCache:new Map(),
      seedBuiltinTheaters(){},saveSettings:()=>saved++,storyboardSchedulePlanArchive(){},applyDirectorInjection:async()=>{},renderFloatButton(){},renderModal(){}});
    // Execute the same entry adapters called by the storage card, only host services are stubs.
    new Function(source+';window.runExport=exportConfig;window.runImport=importConfig;bindStorageManagementEvents(document);')();
  },['ttsDownloadBlob','exportConfig','importConfig','bindStorageManagementEvents'].map(section).join('\n'));
  const downloadEvent=page.waitForEvent('download');await page.locator('.sd-export-config').click();const download=await downloadEvent;
  assert.match(download.suggestedFilename(),/^qianmu-config-.*\.json$/);
  const pack=JSON.parse(await readFile(await download.path(),'utf8'));
  assert.equal(pack.version,2);assert.equal(pack.includeApi,false);assert.doesNotMatch(JSON.stringify(pack),/fixture-(main|tts|access|summary)-private/);
  assert.equal(pack.settings.tts.providers.doubao.voiceLibrary[0].voiceId,'saved-voice');assert.equal(pack.settings.coread.books[0].progress,.6);
  await page.evaluate(()=>{allow=true;settings.apiKey='recipient-main';settings.tts.providers.doubao.apiKey='recipient-voice';settings.coread.memory.summaryApiKey='recipient-memory';});
  pack.settings.theme='light';await page.locator('input').setInputFiles({name:'config.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(pack))});
  await page.waitForFunction(()=>saved===1);
  assert.deepEqual(await page.evaluate(()=>[settings.theme,settings.apiKey,settings.tts.providers.doubao.apiKey,settings.coread.memory.summaryApiKey]),['light','recipient-main','recipient-voice','recipient-memory']);
  assert.ok(await page.evaluate(()=>prompts.some(text=>text.includes('当前连接与密钥保留'))));
  await page.locator('input').setInputFiles({name:'bad.json',mimeType:'application/json',buffer:Buffer.from('{"type":"qianmu-config","version":2,"settings":{"__proto__":{"x":true}}}')});
  await page.waitForFunction(()=>notices.some(row=>row[0].includes('导入失败')));assert.equal(await page.evaluate(()=>saved),1);
  assert.deepEqual(errors,[]);assert.equal(external,0);console.log(JSON.stringify({nativeDownload:true,nativeFileInput:true,nestedConnectionsExcluded:true,recipientConnectionsPreserved:true,malformedNoWrite:true,external,errors}));
}finally{await context.close();await browser.close();}
