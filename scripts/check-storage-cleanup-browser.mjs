// Native temporary database only: no production origin, credentials or remote IO.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),{chromium}=require(process.env.QIANMU_PLAYWRIGHT_MODULE||'playwright');
const source=await readFile(new URL('../qianmu-blobstore.js',import.meta.url),'utf8');
const browser=await chromium.launch({channel:process.env.QIANMU_BROWSER_CHANNEL||undefined,headless:true}),context=await browser.newContext();
let external=0;const errors=[];
await context.route('**/*',route=>{
  if(route.request().url()==='https://qianmu.test/')return route.fulfill({contentType:'text/html',body:'<!doctype html>'});
  if(route.request().url()==='https://qianmu.test/qianmu-blobstore.js')return route.fulfill({contentType:'application/javascript',body:source});
  external++;return route.abort();
});
try{
  const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));await page.goto('https://qianmu.test/');
  const checks=await page.evaluate(async()=>{
    const api=await import('/qianmu-blobstore.js'),checks=[],check=(name,ok)=>{if(!ok)throw Error(name);checks.push(name);};
    await api.putNote('fixture-note',{text:'keep on failure'});await api.putAudio('fixture-audio',new Blob(['synthetic']));
    const original=IDBObjectStore.prototype.clear;let result;
    try{
      IDBObjectStore.prototype.clear=function(){const request=original.call(this);if(this.name==='notes')request.addEventListener('success',()=>this.transaction.abort(),{once:true});return request;};
      result=await api.clearStorageItems(['notes','audio']);
    }finally{IDBObjectStore.prototype.clear=original;}
    check('native abort restores the supposedly deleted note',(await api.listNotes()).length===1);
    check('request success followed by transaction abort is reported as failed, not cleared: '+JSON.stringify(result),result.failed.some(row=>row.name==='notes')&&!result.cleared.includes('notes'));
    check('another selected store can commit independently',result.cleared.includes('audio')&&(await api.estimateBlobStoreUsage()).stores.find(row=>row.name==='audio').count===0);
    const retry=await api.clearStorageItems(['notes']);
    check('retry after abort commits and reports actual success',retry.cleared.includes('notes')&&retry.failed.length===0&&(await api.listNotes()).length===0);
    const descriptor=Object.getOwnPropertyDescriptor(window,'indexedDB');
    try{
      Object.defineProperty(window,'indexedDB',{configurable:true,value:undefined});
      for(const [label,run] of [['module',()=>api.clearStorageItems(['notes'])],['chat',()=>api.clearChatScopedStorage([{name:'audio',chatKey:'fixture'}])]]){
        let failed=false;try{await run();}catch{failed=true;}check(label+' cleanup cannot claim success without storage support',failed);
      }
      check('empty selections remain harmless no-ops without storage support',(await api.clearStorageItems([])).cleared.length===0&&(await api.clearChatScopedStorage([])).cleared.length===0);
    }finally{if(descriptor)Object.defineProperty(window,'indexedDB',descriptor);else delete window.indexedDB;}
    return checks;
  });
  assert.equal(external,0);assert.deepEqual(errors,[]);console.log(JSON.stringify({nativeIndexedDB:true,checks,external,errors}));
}finally{await context.close();await browser.close();}
