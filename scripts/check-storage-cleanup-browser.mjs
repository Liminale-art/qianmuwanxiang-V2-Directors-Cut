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
    await api.putCover('orphan-abort',new Blob(['synthetic cover']));
    const originalDelete=IDBObjectStore.prototype.delete;
    try{
      IDBObjectStore.prototype.delete=function(key){const request=originalDelete.call(this,key);if(key==='orphan-abort')request.addEventListener('success',()=>this.transaction.abort(),{once:true});return request;};
      result=await api.clearOrphanedReaderBlobs();
    }finally{IDBObjectStore.prototype.delete=originalDelete;}
    check('orphan request success followed by abort never reports a cleared resource',result.cleared.length===0&&result.failed.length===1&&Boolean(await api.getCover('orphan-abort')));
    result=await api.clearOrphanedReaderBlobs();
    check('orphan retry reports only committed deletion',result.cleared.length===1&&!await api.getCover('orphan-abort'));
    await api.putCover('orphan-a',new Blob(['first']));await api.putReaderImage('orphan-b',0,new Blob(['second']));
    const transaction=IDBDatabase.prototype.transaction;let valid=true,writes=0;
    try{
      IDBDatabase.prototype.transaction=function(names,mode,...args){
        const tx=transaction.call(this,names,mode,...args);
        if(mode==='readwrite'){writes++;tx.addEventListener('complete',()=>{valid=false;},{once:true});}
        return tx;
      };
      result=await api.clearOrphanedReaderBlobs({check(){if(!valid)throw Error('scope changed');}});
    }finally{IDBDatabase.prototype.transaction=transaction;}
    check('orphan scope change preserves the next resource without another write transaction',writes===1&&result.cleared.length===1&&result.failed.length===1&&Boolean(await api.getReaderImage('orphan-b',0)));
    await api.clearOrphanedReaderBlobs();
    await api.putCover('restored-during-cleanup',new Blob(['keep cover']));let inserted=false;
    try{
      IDBDatabase.prototype.transaction=function(names,mode,...args){
        if(!inserted&&mode==='readwrite'){
          inserted=true;
          transaction.call(this,'reader_books','readwrite').objectStore('reader_books').put({fullText:'restored fixture'},'restored-during-cleanup');
        }
        return transaction.call(this,names,mode,...args);
      };
      result=await api.clearOrphanedReaderBlobs();
    }finally{IDBDatabase.prototype.transaction=transaction;}
    check('a book restored after inventory protects its cover at the transactional recheck',inserted&&result.cleared.length===0&&result.skipped.length===1&&Boolean(await api.getCover('restored-during-cleanup')));
    const bookKey='restored-during-cleanup',valueMethods=['getAll','getAllKeys','openCursor'],savedMethods=valueMethods.map(name=>IDBObjectStore.prototype[name]);
    try{
      for(const name of valueMethods){const original=IDBObjectStore.prototype[name];IDBObjectStore.prototype[name]=function(...args){if(this.name==='reader_books')throw Error('inventory must only read keys');return original.apply(this,args);};}
      const ids=await api.listBookIds();
      check('book inventory returns actual IDs without loading book values or using a getAll fallback',ids.includes(bookKey)&&ids.every(id=>typeof id==='string'));
    }finally{valueMethods.forEach((name,i)=>IDBObjectStore.prototype[name]=savedMethods[i]);}
    const keyCursor=IDBObjectStore.prototype.openKeyCursor;
    for(const late of [false,true]){
      let failed=false;
      try{
        IDBObjectStore.prototype.openKeyCursor=function(...args){const request=keyCursor.apply(this,args);if(this.name==='reader_books')request.addEventListener('success',()=>{if(late?!request.result:!!request.result)this.transaction.abort();});return request;};
        try{await api.auditOrphanedReaderBlobs();}catch{failed=true;}
      }finally{IDBObjectStore.prototype.openKeyCursor=keyCursor;}
      check('orphan audit rejects '+(late?'end-of-scan':'partial')+' book inventory rather than labelling live covers as unreferenced',failed&&Boolean(await api.getCover(bookKey)));
    }
    const descriptor=Object.getOwnPropertyDescriptor(window,'indexedDB');
    try{
      Object.defineProperty(window,'indexedDB',{configurable:true,value:undefined});
      for(const [label,run] of [['module',()=>api.clearStorageItems(['notes'])],['chat',()=>api.clearChatScopedStorage([{name:'audio',chatKey:'fixture'}])],['orphan',()=>api.clearOrphanedReaderBlobs()]]){
        let failed=false;try{await run();}catch{failed=true;}check(label+' cleanup cannot claim success without storage support',failed);
      }
      check('empty selections remain harmless no-ops without storage support',(await api.clearStorageItems([])).cleared.length===0&&(await api.clearChatScopedStorage([])).cleared.length===0);
    }finally{if(descriptor)Object.defineProperty(window,'indexedDB',descriptor);else delete window.indexedDB;}
    return checks;
  });
  assert.equal(external,0);assert.deepEqual(errors,[]);console.log(JSON.stringify({nativeIndexedDB:true,checks,external,errors}));
}finally{await context.close();await browser.close();}
