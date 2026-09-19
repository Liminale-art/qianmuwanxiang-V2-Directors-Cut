// Isolated real IndexedDB only: no ST login, network service or production data.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),{chromium}=require(process.env.QIANMU_PLAYWRIGHT_MODULE||'playwright');
const browser=await chromium.launch({channel:process.env.QIANMU_BROWSER_CHANNEL||undefined,headless:true}),context=await browser.newContext();
const checks=[],errors=[],allowed=new Set(['account-local-store','text-collection-outbox-store','text-collection-sync-contract','text-collection-backup','text-collection','json-input'].map(name=>`qianmu-${name}.js`));let external=0;
const deadline=setTimeout(()=>{console.error('Collection outbox check exceeded 60 seconds');void browser.close();},60000);
await context.route('**/*',async route=>{
  const url=new URL(route.request().url());
  if(url.origin==='https://qianmu.test'){
    if(url.pathname==='/')return route.fulfill({contentType:'text/html',body:'<!doctype html><meta charset="utf-8">'});
    const file=url.pathname.slice(1);if(allowed.has(file))return route.fulfill({contentType:'text/javascript',body:await readFile(new URL('../'+file,import.meta.url),'utf8')});
  }
  external++;return route.abort();
});
async function boot(page){
  await page.goto('https://qianmu.test/');
  await page.evaluate(async()=>{
    const module=await import('./qianmu-text-collection-outbox-store.js'),{createTextCollection}=await import('./qianmu-text-collection.js');
    const namespace='st-user:'+'a'.repeat(64),store=module.createTextCollectionOutboxStore();
    window.fixture={module,namespace,store,make(n){const id='collection-'+n;
      const record=createTextCollection({id,createdAt:n,mode:'full',source:{account:namespace,chatId:'removed-chat',messageId:n,replyId:'reply-'+n,charName:'旧角色',userName:'旧用户',text:`保留全文\r\n${n}😀`}});
      return module.createTextCollectionOutboxEntry({version:1,expectedAccount:namespace,mutationId:'mutation-'+n,operation:'create',id,baseRevision:0,record},{queuedAt:n});
    },save(n){return store.update(namespace,state=>state.entries.push(this.make(n)));},read(){return store.read(namespace);}};
  });
}
try{
  const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));await boot(page);
  await page.evaluate(()=>fixture.save(1));const first=await page.evaluate(()=>fixture.read());await page.reload();await boot(page);
  assert.deepEqual(await page.evaluate(()=>fixture.read()),first);
  checks.push('exact pending request, source and CRLF text survive a fresh document in real IndexedDB');
  const tab=await context.newPage();tab.on('pageerror',error=>errors.push(error.message));await boot(tab);
  await Promise.all([page.evaluate(()=>fixture.save(2)),tab.evaluate(()=>fixture.save(3))]);assert.equal((await page.evaluate(()=>fixture.read())).entries.length,3);
  checks.push('two tabs serialize account updates without losing either pending original');
  const isolated=await page.evaluate(async()=>({other:await fixture.store.read('st-user:'+'b'.repeat(64)),databases:(await indexedDB.databases()).map(row=>row.name)}));
  assert.equal(isolated.other.entries.length,0);assert.deepEqual(isolated.databases,['qianmu-text-collection-outbox']);
  checks.push('account namespaces remain separate and the notes database is never opened');
  const baseline=await page.evaluate(()=>fixture.read());
  for(const mode of ['abort','quota','invalid','guard']){
    const result=await page.evaluate(async mode=>{
      const original=IDBObjectStore.prototype.put;let failure;
      try{
        if(mode==='abort')IDBObjectStore.prototype.put=function(value){const result=original.call(this,value),tx=this.transaction;result.addEventListener('success',()=>tx.abort());return result;};
        if(mode==='quota')IDBObjectStore.prototype.put=function(){throw new DOMException('quota','QuotaExceededError');};
        await fixture.store.update(fixture.namespace,state=>{state.entries.push(fixture.make(4));if(mode==='invalid')state.entries[0].request.apiKey='must reject';},{guard:()=>mode!=='guard'});
      }catch(error){failure=error.code||error.message;}finally{IDBObjectStore.prototype.put=original;}
      return {failure,state:await fixture.read()};
    },mode);
    assert.ok(result.failure,mode);assert.deepEqual(result.state,baseline,mode);
  }
  checks.push('native transaction abort after request success, quota failure, invalid schema and stale guard preserve all old rows');
  await page.evaluate(()=>fixture.store.close());await assert.rejects(page.evaluate(()=>fixture.read()));await boot(page);assert.deepEqual(await page.evaluate(()=>fixture.read()),baseline);
  checks.push('closed session rejects work while reopening retains all committed pending identities');
  assert.equal(external,0);assert.deepEqual(errors,[]);
  console.log(JSON.stringify({passed:checks.length,checks,errors,externalRequests:external,productionDataRead:false,networkSubmissions:0,scope:'actual account-local/outbox modules with browser IndexedDB; no capture/editor integration'},null,2));
}finally{clearTimeout(deadline);await context.close();await browser.close();}
