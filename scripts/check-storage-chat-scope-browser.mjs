// Synthetic native IndexedDB only. No production origin, credentials or remote IO.
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
    await api.estimateBlobStoreUsage();
    const db=await new Promise((resolve,reject)=>{const req=indexedDB.open('qianmu-blobstore');req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);});
    const put=(name,rows)=>new Promise((resolve,reject)=>{const tx=db.transaction(name,'readwrite');for(const [key,value]of rows)tx.objectStore(name).put(value,key);tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error);});
    const all=name=>new Promise((resolve,reject)=>{const req=db.transaction(name).objectStore(name).getAllKeys();req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);});
    const prefix='x'.repeat(512),keys=[prefix+'A',prefix+'B',prefix,'书友😀','é','e\u0301'];
    const invalid=[null,123,' scope','scope ','scope\n','sc\u0000ope','\ud800'];
    const stores=['audio','tts_lines','storyboard_snapshots','storyboard_plan_archives','video_tasks','video_budget','video_media','video_drafts','video_timelines','video_postproduction'];
    for(const name of stores){
      const wrap=chatKey=>name==='audio'||name==='video_media'?{meta:{chatKey}}:{chatKey};
      await put(name,[...keys.map((chatKey,i)=>[name==='tts_lines'?chatKey:`valid-${i}`,wrap(chatKey)]),
        ...invalid.filter(k=>name!=='tts_lines'||k!==null).map((chatKey,i)=>[name==='tts_lines'?chatKey:`invalid-${i}`,wrap(chatKey)])]);
    }
    let inventory=await api.estimateBlobStoreUsage();
    for(const name of stores){
      const row=inventory.stores.find(item=>item.name===name);
      check(name+' inventory retains exact distinct keys and excludes malformed metadata',row.scopes.length===keys.length&&keys.every(key=>row.scopes.some(s=>s.chatKey===key&&s.count===1)));
      check(name+' unknown records still count toward inventory',row.count>row.scopes.reduce((n,s)=>n+s.count,0));
      const result=await api.clearChatScopedStorage([{name,chatKey:keys[0]}]);
      const remaining=await all(name);
      check(name+' deletes only the full selected key, not its prefix neighbours',result.count===1&&!result.failed.length&&remaining.length===row.count-1&&remaining.includes(name==='tts_lines'?keys[1]:'valid-1')&&remaining.includes(name==='tts_lines'?prefix:'valid-2'));
    }
    // Invalid request keys must not trigger even a single write transaction.
    const originalTransaction=IDBDatabase.prototype.transaction;let writes=0;
    try{
      IDBDatabase.prototype.transaction=function(names,mode,...args){if(mode==='readwrite')writes++;return originalTransaction.call(this,names,mode,...args);};
      const result=await api.clearChatScopedStorage(invalid.map(chatKey=>({name:'audio',chatKey})));
      check('malformed selections do not open write transactions',writes===0&&result.cleared.length===0&&result.failed.length===0);
    }finally{IDBDatabase.prototype.transaction=originalTransaction;}
    for(const name of ['reader_chats','reader_vectors']){
      await put(name,[['scope::book',{bookId:'book'}],['scope::legacy',{}],['scope::inner::book',{bookId:'inner::book'}],
        ['scope::bad',{bookId:'different'}],['scope::unknown::book',{}],['scope::empty',{bookId:''}],['scope::null',{bookId:null}],['scope::',{}],[' scope::book',{bookId:'book'}]]);
      const row=(await api.estimateBlobStoreUsage()).stores.find(item=>item.name===name);
      check(name+' exact book suffix and unambiguous legacy format only',row.count===9&&row.scopes.length===1&&row.scopes[0].chatKey==='scope'&&row.scopes[0].count===3);
      const result=await api.clearChatScopedStorage([{name,chatKey:'scope'}]);
      const remaining=await all(name);
      check(name+' contradictory and ambiguous reader buckets survive scoped cleanup',result.count===3&&remaining.length===6&&remaining.includes('scope::bad')&&remaining.includes('scope::unknown::book'));
    }
    await put('storyboard_inbox',[['protected',{chatKey:'scope'}]]);
    await api.clearChatScopedStorage([{name:'storyboard_inbox',chatKey:'scope'}]);
    check('unfiled storyboard deliveries remain outside the cleanup allow-list',(await all('storyboard_inbox')).includes('protected'));
    const originalCursor=IDBObjectStore.prototype.openCursor,originalDelete=IDBCursor.prototype.delete;
    for(const phase of ['cursor','delete-success','scan-end']){
      await put('audio',[['guard-a',{meta:{chatKey:'guard'}}],['guard-b',{meta:{chatKey:'guard'}}]]);
      let valid=true,triggered=false;
      try{
        IDBObjectStore.prototype.openCursor=function(...args){
          const req=originalCursor.apply(this,args);
          if(this.name==='audio'&&this.transaction.mode==='readwrite')req.addEventListener('success',()=>{
            if(phase==='cursor'&&req.result||phase==='scan-end'&&!req.result){valid=false;triggered=true;}
          });return req;
        };
        IDBCursor.prototype.delete=function(){
          const req=originalDelete.call(this);
          if(phase==='delete-success'&&this.source.name==='audio')req.addEventListener('success',()=>{valid=false;triggered=true;},{once:true});
          return req;
        };
        const result=await api.clearChatScopedStorage([{name:'audio',chatKey:'guard'}],{check(){if(!valid)throw Error('scope changed');}});
        const remaining=await all('audio');
        check('scope change at '+phase+' rolls back the entire in-flight group without claiming deletion',triggered&&result.cleared.length===0&&result.count===0&&result.failed[0]?.error==='scope changed'&&remaining.includes('guard-a')&&remaining.includes('guard-b'));
      }finally{IDBObjectStore.prototype.openCursor=originalCursor;IDBCursor.prototype.delete=originalDelete;}
    }
    // An empty cursor is not a committed inventory: abort just before tx completion.
    for(const late of [false,true]){
      let aborted=false,failed=false;
      try{
        IDBObjectStore.prototype.openCursor=function(...args){const req=originalCursor.apply(this,args);if(this.name==='audio'&&this.transaction.mode==='readonly')req.addEventListener('success',()=>{if(late?!req.result:!!req.result){aborted=true;this.transaction.abort();}});return req;};
        try{await api.estimateBlobStoreUsage();}catch{failed=true;}
      }finally{IDBObjectStore.prototype.openCursor=originalCursor;}
      check((late?'late':'partial')+' inventory abort is rejected rather than exposing a successful cleanup directory',aborted&&failed);
    }
    inventory=await api.estimateBlobStoreUsage();
    check('inventory and scoped cleanup can retry after aborted work',inventory.available&&(await api.clearChatScopedStorage([{name:'audio',chatKey:'guard'}])).count===2);
    db.close();return checks;
  });
  assert.equal(external,0);assert.deepEqual(errors,[]);console.log(JSON.stringify({nativeIndexedDB:true,checks,external,errors}));
}finally{await context.close();await browser.close();}
