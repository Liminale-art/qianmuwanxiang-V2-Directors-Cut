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
    // Invalidation after a committed store must never start another write transaction.
    for(const kind of ['module','chat']){
      await api.putAudio('scope-audio',new Blob(['synthetic']),{chatKey:'scope'});
      await api.putTtsLineCache('scope',{lines:['keep subsequent group']});
      let valid=true,writes=0;const transaction=IDBDatabase.prototype.transaction;
      try{
        IDBDatabase.prototype.transaction=function(names,mode,...args){
          const tx=transaction.call(this,names,mode,...args);
          if(mode==='readwrite'){writes++;tx.addEventListener('complete',()=>{valid=false;},{once:true});}
          return tx;
        };
        const session={check(){if(!valid)throw Error('scope changed');}};
        const ordered=(await api.estimateBlobStoreUsage()).stores.filter(row=>['audio','tts_lines'].includes(row.name)).map(row=>row.name);
        check(kind+' fixture contains both stores',ordered.length===2);
        result=kind==='module'?await api.clearStorageItems(ordered,session):await api.clearChatScopedStorage(ordered.map(name=>({name,chatKey:'scope'})),session);
        check(kind+' stops before the next native write transaction',writes===1);
        check(kind+' retains committed success and reports the unstarted group as failed',result.cleared.length===1&&result.failed.length===1&&result.failed[0].error==='scope changed');
        const after=await api.estimateBlobStoreUsage();
        check(kind+' subsequent group data survives',after.stores.find(row=>row.name===ordered[1]).count>0);
      }finally{IDBDatabase.prototype.transaction=transaction;}
    }
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
