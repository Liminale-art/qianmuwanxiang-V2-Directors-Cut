// Real IndexedDB and Web Locks, isolated synthetic account and receipts only.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),{chromium}=require(process.env.QIANMU_PLAYWRIGHT_MODULE||'playwright');
const browser=await chromium.launch({channel:process.env.QIANMU_BROWSER_CHANNEL||undefined,headless:true}),context=await browser.newContext();
const denied=[],errors=[];
await context.route('**/*',async route=>{
  const url=new URL(route.request().url());
  if(url.href==='https://qianmu.test/')return route.fulfill({contentType:'text/html',body:'<!doctype html>'});
  if(url.origin==='https://qianmu.test'&&/^\/qianmu-[a-z0-9-]+\.js$/.test(url.pathname))return route.fulfill({contentType:'application/javascript',body:await readFile(new URL('..'+url.pathname,import.meta.url))});
  denied.push(url.pathname);return route.abort();
});
try{
  const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));await page.goto('https://qianmu.test/');
  const checks=await page.evaluate(async()=>{
    const {createImageServiceClientStore,createImageServiceClient}=await import('/qianmu-image-service-client.js'),checks=[];
    const verify=(name,valid)=>{if(!valid)throw Error(name);checks.push(name);};
    for(const mode of ['success','stale-write','changed-row','partial','account','busy']){
      const store=createImageServiceClientStore({dbName:'synthetic-receipt-'+mode});let live=true,namespace='account-a';
      const client=createImageServiceClient({store,account:async()=>namespace,fetchImpl:()=>{throw Error('Network is forbidden');}});
      const seed=(attemptId,ns='account-a')=>store.put({version:1,namespace:ns,attemptId,channelKey:'a'.repeat(64),status:'submitted',snapshot:{}});
      try{
        await seed('a');await seed('b');await seed('foreign','account-b');const original=await store.list('account-a');
        const remove=store.remove.bind(store),transaction=IDBDatabase.prototype.transaction;
        store.remove=async(ns,id,options)=>{
          if(mode==='changed-row')await store.put({...await store.get(ns,id),status:'available'});
          const result=await remove(ns,id,options);if(mode==='partial')live=false;return result;
        };
        try{
          IDBDatabase.prototype.transaction=function(names,access,...args){const tx=transaction.call(this,names,access,...args);if(mode==='stale-write'&&this.name==='synthetic-receipt-'+mode&&access==='readwrite')live=false;return tx;};
          const options={remove:true,expectedNamespace:'account-a',check(){if(!live)throw Error('page changed');}};
          if(mode==='account')namespace='account-b';let error,result;
          const run=async()=>{try{result=await client.manage(options);}catch(cause){error=cause;}};
          if(mode==='busy')await navigator.locks.request('qianmu:service-maintenance:account-a',{mode:'shared'},run);else await run();
          const remaining=await store.list('account-a');
          if(mode==='success')verify('successful cleanup deletes only selected local receipts',!error&&result.count===2&&remaining.length===0);
          if(['stale-write','account','busy'].includes(mode))verify(mode+' preserves every original receipt',!!error&&JSON.stringify(remaining)===JSON.stringify(original));
          if(mode==='changed-row')verify('compare-and-swap retains a receipt updated after inventory',error?.code==='image_service_client_changed'&&remaining.length===2&&remaining[0].status==='available');
          if(mode==='partial')verify('partial cleanup reports exactly one committed deletion and keeps the second',error?.clearedCount===1&&remaining.length===1&&remaining[0].attemptId==='b');
          verify(mode+' never deletes another account', (await store.list('account-b')).length===1);
        }finally{IDBDatabase.prototype.transaction=transaction;}
      }finally{client.close();}
    }
    return checks;
  });
  assert.equal(checks.length,12);assert.deepEqual(denied,[]);assert.deepEqual(errors,[]);console.log(JSON.stringify({checks,denied,errors}));
}finally{await context.close();await browser.close();}
