// Existing data-manager dialog + native IDB + actual HTTP source/recipe readers
// and browser download, isolated from real ST accounts, media and external APIs.
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import {createRequire} from 'node:module';
import {historyExportFixture,png} from '../tests/helpers/history-export-fixture.mjs';
import {storyboardFunctionSource} from '../tests/helpers/storyboard-form-fixture.mjs';
import {inspectHistoricalStoryboardBundle} from '../qianmu-historical-storyboard-bundle.js';
import {openStoryboardBundle} from '../qianmu-storyboard-bundle.js';
const {chromium}=createRequire(import.meta.url)(process.env.QIANMU_PLAYWRIGHT_MODULE||'playwright');
const f=await historyExportFixture(),errors=[],unexpected=[],checks=[],downloads=[],requests=[];
const release=JSON.parse(await readFile(new URL('../release-files.json',import.meta.url),'utf8'));
const modules=new Map(await Promise.all(release.files.filter(file=>file.endsWith('.js')||['style.css','qianmu-theme-skins.css'].includes(file)).map(async file=>['/'+file,await readFile(new URL('../'+file,import.meta.url))])));
const allowed=['receipt','state','evidence','record','recipe/read'].map(key=>'/api/plugins/qianmu-tts/chat-gallery/'+key);
let blockMedia=false,releaseMedia,mediaStarted=false,oldBackend=false,imageBytes=png;
const server=http.createServer(async(req,res)=>{
  const abort=new AbortController();res.once('close',()=>{if(!res.writableEnded)abort.abort();});
  try{
    const route=new URL(req.url,'http://localhost').pathname;
    if(route==='/'){res.writeHead(200,{'Content-Type':'text/html'});res.end('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"><link rel="stylesheet" href="/qianmu-theme-skins.css"><div id="story-director-modal" class="open"><button id="anchor">管理目录</button></div>');return;}
    if(route==='/favicon.ico'){res.writeHead(204);res.end();return;}
    if(modules.has(route)){res.writeHead(200,{'Content-Type':route.endsWith('.css')?'text/css':'application/javascript'});res.end(modules.get(route));return;}
    if(allowed.includes(route)){
      let body='';for await(const part of req){body+=part;if(body.length>4096)throw Error('oversized selector');}requests.push({route,body:JSON.parse(body)});
      if(oldBackend&&route.endsWith('/state')){res.writeHead(404,{'Content-Type':'text/plain'});res.end('old');return;}
      const result=await f.fetch(route,{body,signal:abort.signal});if(!res.destroyed){res.writeHead(result.status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(await result.text());}return;
    }
    if(['/user/images/inline.png','/user/images/server.png'].includes(route)){
      requests.push({route});if(blockMedia){mediaStarted=true;await new Promise(done=>releaseMedia=done);}
      if(!res.destroyed){res.writeHead(200,{'Content-Type':'image/png','Content-Length':String(imageBytes.length),'Cache-Control':'no-store'});res.end(imageBytes);}return;
    }
    unexpected.push(route);res.writeHead(404);res.end();
  }catch(error){if(!abort.signal.aborted)errors.push(error.message);if(!res.destroyed){res.writeHead(500);res.end();}}
});
await new Promise(done=>server.listen(0,'127.0.0.1',done));const origin='http://127.0.0.1:'+server.address().port;
const browser=await chromium.launch({channel:process.env.QIANMU_BROWSER_CHANNEL||undefined,headless:true}),context=await browser.newContext({acceptDownloads:true});
const timer=setTimeout(()=>void browser.close(),120000);
await context.route('**/*',route=>{if(new URL(route.request().url()).origin!==origin){unexpected.push(route.request().url());return route.abort();}return route.continue();});
const check=(label,condition)=>{assert.ok(condition,label);checks.push(label);};
const archive=path.join(f.user,'.qianmu-recipes-v1'),archiveBytes=async()=>Promise.all((await readdir(archive)).sort().map(async name=>[name,await readFile(path.join(archive,name),'utf8')]));
try{
  const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));page.on('download',download=>downloads.push(download));await page.goto(origin);
  imageBytes=Buffer.from(await page.evaluate(async()=>{const canvas=document.createElement('canvas');canvas.width=32;canvas.height=48;canvas.getContext('2d').fillRect(0,0,32,48);const blob=await new Promise(done=>canvas.toBlob(done,'image/png'));return [...new Uint8Array(await blob.arrayBuffer())];}));
  await page.addScriptTag({content:storyboardFunctionSource('ttsDownloadBlob')});
  await page.evaluate(async()=>{
    const {createGalleryCatalogStore}=await import('/qianmu-gallery-catalog-store.js');window.store=createGalleryCatalogStore();window.account='st-user:alice';
    await store.upsert(account,{ownerKey:'char:Alice.png',chatKey:'chat-one'},[{id:'inline',createdAt:1,kind:'still',tags:[]}],{expectedRevision:0});
    window.openManager=(await import('/qianmu-gallery-catalog-management-view.js')).openGalleryCatalogManagement;
    window.host={chatId:'UNRELATED_CHAT',imagegen:{model:'UNRELATED_MODEL'}};
    window.open=()=>{window.manager=openManager({anchor:document.getElementById('anchor'),resolveNamespace:async()=>account,getContext:()=>({...host,characters:[{avatar:'Alice.png',name:'Alice'}],getRequestHeaders:()=>({'X-CSRF-Token':'fixture'})}),
      save:(blob,name)=>{window.lastExport={blob,name};ttsDownloadBlob(blob,name);}});};open();
  });
  const ready=()=>page.waitForFunction(()=>document.querySelector('dialog fieldset')?.disabled===false);
  const click=action=>page.locator(`[data-catalog-action="${action}"]`).click();
  const chooseChat=async()=>{await ready();await page.locator('[data-catalog-scope]').first().click();await ready();await page.locator('[data-catalog-scope]').first().click();await ready();};
  await ready();check('opening existing manager does not read originals or scan server chats',requests.length===0);
  check('whole account has no ambiguous historical export button',await page.locator('[data-catalog-action="export-history"]').count()===0);
  await chooseChat();
  check('same existing manager exposes historical export only for an exact chat',await page.locator('[data-catalog-action="export-history"]').count()===1&&requests.length===0);
  check('derived catalog count remains distinct from real original count',(await page.locator('dialog').innerText()).includes('1 条目录引用'));
  await click('export-history');await ready();
  const confirmation=await page.locator('dialog').innerText();
  check('confirmation states scope, limits, missing-file stop and unsupported recovery',confirmation.includes('当前已保存的全部静帧')&&confirmation.includes('400')&&confirmation.includes('暂不支持恢复')&&confirmation.includes('不含正文全文'));
  check('opening confirmation starts neither source nor media requests',requests.length===0&&downloads.length===0);
  await click('export-back');await ready();check('back is not export or deletion',requests.length===0&&downloads.length===0);
  await click('export-history');await ready();
  const before=await readFile(f.file),beforeArchives=await archiveBytes();
  const downloaded=page.waitForEvent('download');void downloaded.catch(()=>{});await click('export-confirm');await ready();
  assert.match(await page.locator('[data-catalog-status]').innerText(),/已交给浏览器保存/);const download=await downloaded;
  check('real host handoff produces one descriptively named QMB download',downloads.length===1&&/^qianmu-history-originals-2-\d+\.qmb$/.test(download.suggestedFilename()));
  const stream=await download.createReadStream(),chunks=[];for await(const chunk of stream)chunks.push(chunk);
  const exportedFile=new Blob(chunks),result=await inspectHistoricalStoryboardBundle(exportedFile),opened=await openStoryboardBundle(exportedFile);
  assert.deepEqual(Buffer.from((await opened.read(opened.manifest.entries.find(row=>row.id.startsWith('image:')).id)).bytes),imageBytes);checks.push('downloaded original is byte-identical to the actually decoded HTTP PNG');
  check('saved download includes two real originals despite only one catalog reference',result.summary.images===2&&result.source.selection.total===2&&result.source.recipes.length===2);
  assert.deepEqual(result.source.saved,f.saved);checks.push('download retains saved draft, album, unknown fields and full recipes');
  check('browser success states handoff and no restoration claim',(await page.locator('[data-catalog-status]').innerText()).includes('已交给浏览器保存')&&(await page.locator('[data-catalog-status]').innerText()).includes('暂不支持恢复'));
  check('export never updates catalog count or source chat/recipe bytes',await page.evaluate(async()=>(await store.usage(account)).count===1)&&(await readFile(f.file)).equals(before)&&JSON.stringify(await archiveBytes())===JSON.stringify(beforeArchives));
  check('unrelated currently open chat and model are untouched',await page.evaluate(()=>host.chatId==='UNRELATED_CHAT'&&host.imagegen.model==='UNRELATED_MODEL'));
  await click('export-history');await ready();
  await page.evaluate(async()=>{window.theme=(await import('/qianmu-theme-surfaces.js')).createQianmuThemeSurfaceController();theme.register(document.getElementById('story-director-modal'));});
  for(const [name,mode] of [['classic','light'],['editorial','light'],['editorial','dark'],['glass','light'],['glass','dark']])for(const width of [320,1280]){
    await page.setViewportSize({width,height:800});await page.evaluate(({name,mode})=>{theme.setTheme(name==='classic'?null:{theme:name,mode});},{name,mode});
    check(`${name}/${mode}/${width} export confirmation has no horizontal clipping`,await page.evaluate(()=>{const d=document.querySelector('dialog'),m=d.querySelector('main'),r=d.getBoundingClientRect();return d.scrollWidth<=d.clientWidth+1&&m.scrollWidth<=m.clientWidth+1&&r.left>=0&&r.right<=innerWidth;}));
  }
  blockMedia=true;mediaStarted=false;await click('export-confirm');await page.waitForFunction(()=>document.querySelector('[data-catalog-status]')?.textContent.includes('正在读取原图'));
  for(let n=0;n<200&&!mediaStarted;n++)await new Promise(done=>setTimeout(done,10));assert.ok(mediaStarted);
  check('export progress leaves cancellation outside the disabled controls',await page.locator('[data-catalog-action="export-stop"]').isEnabled()&&await page.locator('[data-catalog-action="clear"]').isDisabled());
  await click('export-stop');await ready();releaseMedia?.();blockMedia=false;await page.waitForTimeout(30);
  check('cancelled media fetch produces no second download and allows retry',downloads.length===1&&(await page.locator('[data-catalog-status]').innerText()).includes('取消')&&await page.locator('[data-catalog-action="export-history"]').isEnabled());
  oldBackend=true;await click('export-history');await ready();await click('export-confirm');await ready();oldBackend=false;
  check('old backend explains upgrade rather than saving fallback data',downloads.length===1&&(await page.locator('[data-catalog-status]').innerText()).includes('更新千幕配套后端'));
  f.rows.push({id:'missing',createdAt:3,url:'/user/images/missing.png',snapshotRef:'legacy-only'});await f.write();
  const mediaBefore=requests.filter(row=>row.route.startsWith('/user/images/')).length;
  await click('export-history');await ready();await click('export-confirm');await ready();
  check('missing historical recipe stops before any image read or incomplete handoff',downloads.length===1&&(await page.locator('[data-catalog-status]').innerText()).includes('旧设备引用')&&requests.filter(row=>row.route.startsWith('/user/images/')).length===mediaBefore);
  f.rows.pop();await f.write();
  await click('export-history');await ready();await page.evaluate(()=>account='st-user:bob');await click('export-confirm');await page.waitForFunction(()=>!document.querySelector('dialog'));
  check('account switch removes old dialog and prevents download',downloads.length===1);await page.evaluate(()=>{account='st-user:alice';open();});await chooseChat();
  await click('export-history');await ready();blockMedia=true;mediaStarted=false;await click('export-confirm');
  for(let n=0;n<200&&!mediaStarted;n++)await new Promise(done=>setTimeout(done,10));assert.ok(mediaStarted);
  await click('close');await page.waitForFunction(()=>!document.querySelector('dialog'));releaseMedia?.();blockMedia=false;await page.waitForTimeout(30);
  check('closing parent workflow stops pending export and restores focus',downloads.length===1&&await page.evaluate(()=>document.activeElement===document.getElementById('anchor')));
  check('only explicit read routes and ST-local images were requested',requests.every(row=>allowed.includes(row.route)||['/user/images/inline.png','/user/images/server.png'].includes(row.route))&&unexpected.length===0&&errors.length===0);
  await page.evaluate(()=>store.close());
  console.log(JSON.stringify({checks,errors,unexpected,downloads:downloads.length,realTemporaryChats:true,productionAccess:false}));
}finally{clearTimeout(timer);releaseMedia?.();await context.close();await browser.close();await new Promise(done=>server.close(done));await f.close();}
