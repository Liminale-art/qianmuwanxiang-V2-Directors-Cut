// Isolated native DB + Web Locks; synthetic records only, never provider requests.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),{chromium}=require(process.env.QIANMU_PLAYWRIGHT_MODULE||'playwright');
const browser=await chromium.launch({channel:process.env.QIANMU_BROWSER_CHANNEL||undefined,headless:true}),context=await browser.newContext();
let external=0;const errors=[];
await context.route('**/*',async route=>{
  const url=new URL(route.request().url());
  if(url.href==='https://qianmu.test/')return route.fulfill({contentType:'text/html',body:'<!doctype html>'});
  if(url.href==='https://qianmu.test/qianmu-image-channel.js')return route.fulfill({contentType:'application/javascript',body:await readFile(new URL('../qianmu-image-channel.js',import.meta.url))});
  external++;return route.abort();
});
try{
  const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));await page.goto('https://qianmu.test/');
  const checks=await page.evaluate(async()=>{
    const {createBrowserImageChannel}=await import('/qianmu-image-channel.js'),dbName='synthetic-channel-cleanup',checks=[];
    const db=await new Promise((resolve,reject)=>{const r=indexedDB.open(dbName,1);r.onupgradeneeded=()=>r.result.createObjectStore('channels');r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
    const rows=[{key:'a1',namespace:'account-a',status:'uncertain'},{key:'a2',namespace:'account-a',status:'uncertain'},{key:'b1',namespace:'account-b',status:'uncertain'}];
    const seed=()=>new Promise((resolve,reject)=>{const tx=db.transaction('channels','readwrite'),store=tx.objectStore('channels');store.clear();for(const row of rows)store.put(row,row.key);tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error);});
    const read=()=>new Promise((resolve,reject)=>{const tx=db.transaction('channels','readonly'),r=tx.objectStore('channels').getAll();tx.oncomplete=()=>resolve(r.result);tx.onabort=()=>reject(tx.error);});
    const check=(name,yes)=>{if(!yes)throw Error(name);checks.push(name);};
    try{
      for(const mode of ['before','open','first-delete','last-delete']){
        await seed();let valid=mode!=='before',deleted=0;
        const client=createBrowserImageChannel({dbName,ownerId:'synthetic'}),transaction=IDBDatabase.prototype.transaction,remove=IDBCursorWithValue.prototype.delete;
        try{
          IDBDatabase.prototype.transaction=function(names,access,...args){const tx=transaction.call(this,names,access,...args);if(this.name===dbName&&access==='readwrite'&&mode==='open')valid=false;return tx;};
          IDBCursorWithValue.prototype.delete=function(){const request=remove.call(this);deleted++;if(mode==='first-delete'||mode==='last-delete'&&deleted===2)valid=false;return request;};
          let error;try{await client.manage('account-a',{remove:true,check(){if(!valid)throw Error('stale cleanup');}});}catch(cause){error=cause;}
          check(mode+' invalidation aborts the entire account transaction',error?.code==='image_channel_changed'&&JSON.stringify(await read())===JSON.stringify(rows));
        }finally{IDBDatabase.prototype.transaction=transaction;IDBCursorWithValue.prototype.delete=remove;client.close();}
      }
      await seed();const client=createBrowserImageChannel({dbName,ownerId:'synthetic'});
      try{
        let blocked=false;await navigator.locks.request('qianmu:nai-maintenance',{mode:'shared'},async()=>{try{await client.manage('account-a',{remove:true});}catch(error){blocked=error.code==='image_channel_busy';}});
        check('live generation maintenance lock prevents cleanup without deleting anything',blocked&&(await read()).length===3);
        const result=await client.manage('account-a',{remove:true});
        check('successful cleanup commits only the selected account and leaves the other intact',result.count===2&&JSON.stringify(await read())===JSON.stringify([rows[2]]));
      }finally{client.close();}
    }finally{db.close();}
    return checks;
  });
  assert.equal(checks.length,6);assert.equal(external,0);assert.deepEqual(errors,[]);console.log(JSON.stringify({checks,external,errors}));
}finally{await context.close();await browser.close();}
