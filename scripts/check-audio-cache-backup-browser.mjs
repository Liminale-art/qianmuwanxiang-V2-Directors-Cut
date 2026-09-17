// Production handlers + native file input/download/IndexedDB on a synthetic, isolated origin.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {storyboardFunctionSource as section} from '../tests/helpers/storyboard-form-fixture.mjs';
const names=['createStorageBackupCheck','ttsExportAudioCache','ttsImportAudioCache','transferAudioCache','ttsDownloadBlob','bindStorageManagementEvents'];
const source=names.map(section).join('\n');
const require=createRequire(import.meta.url),{chromium}=require(process.env.QIANMU_PLAYWRIGHT_MODULE||'playwright');
const browser=await chromium.launch({channel:process.env.QIANMU_BROWSER_CHANNEL||undefined,headless:true}),context=await browser.newContext(),page=await context.newPage();
const checks=[],errors=[];let external=0,downloads=0;
const ok=(name,value)=>{assert.ok(value,name);checks.push(name);};
page.on('pageerror',error=>errors.push(error.message));page.on('download',()=>downloads++);
await context.route('**/*',async route=>{
  const url=new URL(route.request().url());
  if(url.origin==='https://qianmu.test'&&url.pathname==='/')return route.fulfill({contentType:'text/html',body:'<!doctype html><div id="story-director-modal" class="open"><section class="sd-storage-card"></section></div>'});
  if(url.origin==='https://qianmu.test'&&/^\/qianmu-[a-z0-9-]+\.js$/.test(url.pathname))return route.fulfill({contentType:'application/javascript',body:await readFile(new URL('..'+url.pathname,import.meta.url),'utf8')});
  external++;return route.abort();
});
const entry=(key,data='YQ==')=>({key,data,type:'audio/mpeg',createdAt:123,meta:{text:'synthetic',speaker:'fixture'}});
const pack=entries=>({type:'qianmu-tts-audio-cache',version:1,count:entries.length,entries});
const choose=async data=>{
  const count=await page.evaluate(()=>notices.length);
  await page.locator('input[data-storage-import="audio"]').setInputFiles({name:'synthetic-cache.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(data))});
  await page.waitForFunction(count=>notices.length>count&&!ttsImportAudioCache.busy,count);
};
try{
  await page.goto('https://qianmu.test/');
  await page.evaluate(async source=>{
    Object.assign(window,await import('/qianmu-storyboard-utils.js'),await import('/qianmu-storage-backup-view.js'));
    window.blobStore=await import('/qianmu-blobstore.js');window.createCoreadImportViewGuard=(await import('/qianmu-reader-package.js')).createCoreadImportViewGuard;
    Object.assign(window,{settings:{},storyboardAdmissionEpoch:1,MODAL_ID:'story-director-modal',storageInventoryState:{sampledAt:0},configUndo:{available:()=>false},
      notices:[],prompts:[],allowed:true,otherWork:false,refreshes:0,fileStamp:()=> 'synthetic',toast:(...args)=>notices.push(args),confirmDialog:async(...args)=>{prompts.push(args);return allowed;},
      refreshStorageInventory:async()=>{refreshes++;}});
    (0,eval)(source);
    window.configRestoreActivity=(include=true,own=null)=>({other:otherWork,audio:own!==ttsExportAudioCache&&ttsExportAudioCache.busy||own!==ttsImportAudioCache&&ttsImportAudioCache.busy});
    document.querySelector('.sd-storage-card').innerHTML=renderStorageBackupSection();document.querySelector('details').open=true;
    bindStorageManagementEvents(document.querySelector('#story-director-modal'));bindStorageManagementEvents(document.querySelector('#story-director-modal'));
    await blobStore.putAudio('existing',new Blob(['original'],{type:'audio/mpeg'}),{text:'keep',chatKey:'first-chat',apiKey:'synthetic-secret'});
    await blobStore.addFavorite('favorite',new Blob(['favorite'],{type:'audio/mpeg'}),{},'keep favorite');
  },source);
  const downloaded=page.waitForEvent('download');await page.locator('[data-storage-export="audio"]').click();const download=await downloaded;
  const stream=await download.createReadStream(),chunks=[];for await(const chunk of stream)chunks.push(chunk);
  const raw=Buffer.concat(chunks).toString('utf8'),data=JSON.parse(raw);
  ok('real central button downloads one complete v1 cache package with a site-wide filename',downloads===1&&download.suggestedFilename()==='qianmu-语音缓存-synthetic.json'&&data.type==='qianmu-tts-audio-cache'&&data.count===1);
  ok('download retains audio/provenance but excludes credential metadata',Buffer.from(data.entries[0].data,'base64').toString()==='original'&&data.entries[0].meta.chatKey==='first-chat'&&!raw.includes('synthetic-secret'));
  await choose(pack([entry('existing','Y2hhbmdlZA=='),entry('new')]));
  ok('native file input confirms once, restores missing cache and never replaces an existing key',await page.evaluate(async()=>prompts.length===1&&await (await blobStore.getAudio('existing')).blob.text()==='original'&&await (await blobStore.getAudio('new')).blob.text()==='a'));
  ok('actual handler reports committed added/skipped totals and refreshes inventory',await page.evaluate(()=>notices.at(-1)[0].includes('新增 1 条，已存在保留 1 条')&&refreshes===1&&!ttsImportAudioCache.busy));
  ok('file input resets and can select the same package again',await page.locator('input[data-storage-import="audio"]').inputValue()==='');
  await choose(pack([entry('new')]));ok('a repeated import remains idempotent',await page.evaluate(()=>notices.at(-1)[0].includes('新增 0 条，已存在保留 1 条')));
  await page.evaluate(()=>{allowed=false;});
  const prior=await page.evaluate(()=>prompts.length);
  await page.locator('input[data-storage-import="audio"]').setInputFiles({name:'cancel.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(pack([entry('cancel')])))});
  await page.waitForFunction(prior=>prompts.length>prior&&!ttsImportAudioCache.busy,prior);
  ok('cancelling confirmation leaves the cache untouched',await page.evaluate(async()=>!(await blobStore.getAudio('cancel'))));await page.evaluate(()=>{allowed=true;});
  const confirmations=await page.evaluate(()=>prompts.length);await choose(pack([entry('must-not-write'),{...entry('bad'),data:'invalid'}]));
  ok('a malformed late row rejects the whole package before confirmation or any write',await page.evaluate(async count=>prompts.length===count&&!(await blobStore.getAudio('must-not-write')),confirmations));
  await page.evaluate(()=>{
    window.originalAdd=IDBObjectStore.prototype.add;
    IDBObjectStore.prototype.add=function(value,key){const request=originalAdd.call(this,value,key);if(this.name==='audio'&&key==='abort')request.addEventListener('success',()=>this.transaction.abort(),{once:true});return request;};
  });
  await choose(pack([entry('abort')]));
  ok('request success followed by native transaction abort is a failed record, never a successful restore',await page.evaluate(async()=>!(await blobStore.getAudio('abort'))&&notices.at(-1)[1]==='warning'&&notices.at(-1)[0].includes('失败 1 条')));
  await page.evaluate(()=>{
    IDBObjectStore.prototype.add=function(value,key){const request=originalAdd.call(this,value,key);if(this.name==='audio'&&key==='stale-before-commit')request.addEventListener('success',()=>{storyboardAdmissionEpoch++;},{once:true});return request;};
  });
  await choose(pack([entry('stale-before-commit'),entry('not-started')]));
  ok('owner invalidation at request success aborts the uncommitted record and stops later writes',await page.evaluate(async()=>!(await blobStore.getAudio('stale-before-commit'))&&!(await blobStore.getAudio('not-started'))&&notices.at(-1)[1]==='error'));
  await page.evaluate(()=>{
    IDBObjectStore.prototype.add=originalAdd;window.originalTransaction=IDBDatabase.prototype.transaction;
    IDBDatabase.prototype.transaction=function(names,mode,...args){const transaction=originalTransaction.call(this,names,mode,...args);if(mode==='readwrite'&&String(names).includes('audio'))transaction.addEventListener('complete',()=>document.querySelector('#story-director-modal').classList.remove('open'),{once:true});return transaction;};
  });
  await choose(pack([entry('committed-before-close'),entry('after-close')]));
  ok('closing after a commit preserves it, reports the saved count and never starts the next row',await page.evaluate(async()=>!!(await blobStore.getAudio('committed-before-close'))&&!(await blobStore.getAudio('after-close'))&&notices.at(-1)[0].includes('已写入 1 条并保留')));
  await page.evaluate(()=>{IDBDatabase.prototype.transaction=originalTransaction;document.querySelector('#story-director-modal').classList.add('open');otherWork=true;});
  const beforePrompt=await page.evaluate(()=>prompts.length);await choose(pack([entry('busy-blocked')]));
  ok('running work blocks import before confirmation or writes',await page.evaluate(async count=>prompts.length===count&&!(await blobStore.getAudio('busy-blocked')),beforePrompt));
  await page.evaluate(()=>{otherWork=false;window.originalEncode=blobToBase64;window.blobToBase64=async blob=>{await new Promise(resolve=>window.releaseEncode=resolve);return originalEncode(blob);};});
  await page.locator('[data-storage-export="audio"]').click();await page.waitForFunction(()=>typeof releaseEncode==='function');
  await page.evaluate(()=>{storyboardAdmissionEpoch++;releaseEncode();});await page.waitForFunction(()=>!ttsExportAudioCache.busy);
  ok('a late export after scope changes does not download and releases its transfer lock',downloads===1&&await page.evaluate(()=>notices.at(-1)[1]==='error'));
  ok('cache operations leave favorites and model settings untouched',await page.evaluate(async()=>(await blobStore.listFavorites()).length===1&&Object.keys(settings).length===0));
  assert.deepEqual(errors,[]);assert.equal(external,0);
  console.log(JSON.stringify({passed:checks.length,checks,errors,external,downloads,scope:'production central handlers; native isolated files/download and IndexedDB; no real ST, cleanup or paid generation'}));
}finally{await context.close();await browser.close();}
