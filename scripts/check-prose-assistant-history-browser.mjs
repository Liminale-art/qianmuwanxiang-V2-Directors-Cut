// Real isolated IndexedDB transactions, synthetic scopes/text; never a ST account.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),{chromium}=require(process.env.QIANMU_PLAYWRIGHT_MODULE||'playwright');
const browser=await chromium.launch({channel:process.env.QIANMU_BROWSER_CHANNEL||undefined,headless:true}),context=await browser.newContext();
const allowed=new Set(['qianmu-prose-assistant-history.js','qianmu-prose-assistant-history-contract.js','qianmu-prose-assistant-history-runtime.js','qianmu-account-local-store.js','qianmu-chat-file-target.js']),checks=[],errors=[];let external=0;
const timer=setTimeout(()=>{console.error('Assistant history check exceeded 60 seconds');void browser.close();},60000);
await context.route('**/*',async route=>{const url=new URL(route.request().url()),file=url.pathname.slice(1);
 if(url.origin==='https://qianmu.test'){
  if(url.pathname==='/')return route.fulfill({contentType:'text/html',body:'<!doctype html><meta charset="utf-8">'});
  if(allowed.has(file))return route.fulfill({contentType:'text/javascript',body:await readFile(new URL('../'+file,import.meta.url),'utf8')});
 }external++;return route.abort();
});
async function boot(page){page.on('pageerror',error=>errors.push(error.message));await page.goto('https://qianmu.test/');await page.evaluate(async()=>{
 const {createProseAssistantHistoryStore}=await import('./qianmu-prose-assistant-history.js'),account='st-user:'+'a'.repeat(64),other='st-user:'+'b'.repeat(64);
 const key=(a=account,chatId='A')=>JSON.stringify(['qianmu-prose-assistant-v2',a,'char:A.png',{kind:'character',chatId,avatar:'A.png'},null]);
 const store=createProseAssistantHistoryStore();window.fixture={account,other,key,store,row(n=1){return {id:n,user:'问题\r\n😀',assistant:'<b>纯文本</b>',status:'complete',reference:{floor:0,replyId:'swipe:0',mode:'floor',range:{start:0,end:4}}};},read(){return store.read(account,key());},write(rev,rows,options){return store.write(account,key(),rev,rows,options);}};
 });}
try{
 const page=await context.newPage();await boot(page);assert.deepEqual(await page.evaluate(async()=>(await indexedDB.databases()).map(x=>x.name)),[]);
 const first=await page.evaluate(async()=>{const result=await fixture.write(0,[fixture.row()],{now:1});result.rows[0].user='mutated return';return fixture.read();});
 assert.equal(first.rows[0].user,'问题\r\n😀');await page.reload();await boot(page);assert.deepEqual(await page.evaluate(()=>fixture.read()),first);
 checks.push('lazy isolated database preserves exact plaintext and reference after real transaction completion/reload; returned objects do not mutate stored originals');
 const isolated=await page.evaluate(async()=>({a:await fixture.store.read(fixture.account,fixture.key(fixture.account,'B')),b:await fixture.store.read(fixture.other,fixture.key(fixture.other)),dbs:(await indexedDB.databases()).map(x=>x.name)}));
 assert.equal(isolated.a.rows.length,0);assert.equal(isolated.b.rows.length,0);assert.deepEqual(isolated.dbs,['qianmu-prose-assistant-history']);
 await assert.rejects(page.evaluate(()=>fixture.store.read(fixture.other,fixture.key())));checks.push('same-name accounts/chats remain separate and no notes, audio or reader database is opened');
 const second=await context.newPage();await boot(second);
 const results=await Promise.all([page,second].map((p,i)=>p.evaluate(async n=>{try{const r=fixture.row(2);r.assistant='writer '+n;await fixture.write(1,[fixture.row(),r],{now:2});return 'saved';}catch(error){return error.code;}},i)));
 assert.deepEqual(results.sort(),['prose_assistant_history_conflict','saved']);const baseline=await page.evaluate(()=>fixture.read());assert.equal(baseline.revision,2);assert.equal(baseline.rows.length,2);
 checks.push('concurrent pages use revision compare-and-swap: exactly one commits and the other retains a visible conflict instead of overwriting');
 for(const mode of ['abort','quota','guard','invalid']){
  const result=await page.evaluate(async mode=>{const put=IDBObjectStore.prototype.put;let failure;
   try{
    if(mode==='abort')IDBObjectStore.prototype.put=function(value){const request=put.call(this,value),tx=this.transaction;request.addEventListener('success',()=>tx.abort());return request;};
    if(mode==='quota')IDBObjectStore.prototype.put=function(){throw new DOMException('quota','QuotaExceededError');};
    const row=fixture.row(3);if(mode==='invalid')row.apiKey='forbidden';await fixture.write(2,[fixture.row(),row],{guard:()=>mode!=='guard',now:3});
   }catch(error){failure=error.code||error.name;}finally{IDBObjectStore.prototype.put=put;}
   return {failure,state:await fixture.read()};
  },mode);assert.ok(result.failure,mode);assert.deepEqual(result.state,baseline,mode);
 }
 checks.push('post-request native abort, quota, stale guard and credential-field injection never claim commit or change the previous transcript');
 await page.evaluate(()=>fixture.write(2,[],{now:4}));await assert.rejects(second.evaluate(()=>fixture.write(2,[fixture.row()],{now:5})));const cleared=await second.evaluate(()=>fixture.read());assert.equal(cleared.revision,3);assert.deepEqual(cleared.rows,[]);
 checks.push('clearing retains a revision marker so an older page cannot resurrect removed dialogue');
 await page.evaluate(()=>fixture.store.close());await assert.rejects(page.evaluate(()=>fixture.read()));await boot(page);assert.deepEqual(await page.evaluate(()=>fixture.read()),cleared);
 checks.push('closing releases database ownership; reopening reads committed state without resuming a model request');
 await page.evaluate(async()=>{
  const {openProseAssistantHistory}=await import('./qianmu-prose-assistant-history-runtime.js');fixture.openRuntime=()=>openProseAssistantHistory({source:{key:fixture.key(),scope:{namespace:fixture.account},guard:async()=>true,assertCurrent:()=>true},store:fixture.store,isCurrent:()=>true});
  fixture.runtime=await fixture.openRuntime();await fixture.runtime.save({key:fixture.key(),busy:false,rows:[fixture.row(4)]});fixture.runtime.close();fixture.runtime=await fixture.openRuntime();
 });
 assert.equal(await page.evaluate(()=>fixture.runtime.initialHistory().rows[0].id),4);
 const failed=await page.evaluate(async()=>{const put=IDBObjectStore.prototype.put;try{IDBObjectStore.prototype.put=function(){throw new DOMException('quota','QuotaExceededError');};await fixture.runtime.save({key:fixture.key(),busy:false,rows:[fixture.row(4),fixture.row(5)]});}catch(_){return fixture.runtime.status();}finally{IDBObjectStore.prototype.put=put;}});
 assert.equal(failed.dirty,true);assert.equal(failed.canRetry,true);assert.equal((await page.evaluate(()=>fixture.read())).rows.length,1);
 await page.evaluate(()=>fixture.runtime.retry());assert.equal((await page.evaluate(()=>fixture.read())).rows.length,2);assert.equal(await page.evaluate(()=>fixture.runtime.status().dirty),false);
 checks.push('real coordinator restores committed rows, retains a failed snapshot and explicitly retries after quota recovery without changing the prior original');
 const conflict=await page.evaluate(async()=>{const other=await fixture.openRuntime();await other.save({key:fixture.key(),busy:false,rows:[]});other.close();try{await fixture.runtime.save({key:fixture.key(),busy:false,rows:[fixture.row(6)]});}catch(error){return {code:error.code,status:fixture.runtime.status()};}});
 assert.equal(conflict.code,'prose_assistant_history_conflict');assert.equal(conflict.status.canRetry,false);assert.deepEqual((await page.evaluate(()=>fixture.read())).rows,[]);await page.evaluate(()=>fixture.runtime.close());
 checks.push('coordinator respects another page clear and refuses both silent rebasing and automatic resurrection');
 const usage=await page.evaluate(async()=>{
  const key=fixture.key(fixture.account,'B'),rows=[fixture.row(),{...fixture.row(2),status:'failed'},{...fixture.row(3),status:'cancelled'}];await fixture.store.write(fixture.account,key,0,rows,{now:9});
  await fixture.store.write(fixture.other,fixture.key(fixture.other),0,[fixture.row()],{now:10});
  fixture.rawPut=async value=>{const db=await new Promise((resolve,reject)=>{const request=indexedDB.open('qianmu-prose-assistant-history',1);request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});try{await new Promise((resolve,reject)=>{const tx=db.transaction('accounts','readwrite');tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error);tx.objectStore('accounts').put(value);});}finally{db.close();}};
  // A corrupt foreign document must not even be visited by this account scan.
  await fixture.rawPut({namespace:fixture.key(fixture.other),privateText:'FOREIGN PRIVATE',invalid:true});
  fixture.legacyKey=fixture.key().replace('assistant-v2','assistant-v1');await fixture.rawPut({version:1,namespace:fixture.legacyKey,revision:1,updatedAt:1,rows:[{...fixture.row(),assistant:'LEGACY UNKNOWN OWNER'}]});
  const originals=[await fixture.read(),await fixture.store.read(fixture.account,key)],expected=originals.reduce((sum,row)=>sum+new TextEncoder().encode(JSON.stringify(row)).byteLength,0),put=IDBObjectStore.prototype.put;
  try{IDBObjectStore.prototype.put=function(){throw Error('read-only inventory must not write');};return {summary:await fixture.store.usage(fixture.account),expected};}finally{IDBObjectStore.prototype.put=put;}
 });
 assert.equal(usage.summary.bytes,usage.expected);assert.equal(usage.summary.records,2);assert.equal(usage.summary.chats,1);assert.equal(usage.summary.markers,1);assert.equal(usage.summary.count,3);for(const name of ['complete','failed','cancelled'])assert.equal(usage.summary[name],1);
 assert.equal(usage.summary.estimated,true);assert.equal(usage.summary.scope,'current-account-local');assert.doesNotMatch(JSON.stringify(usage.summary),/FOREIGN|PRIVATE|问题|纯文本|Chat|apiKey/);
 checks.push('bounded read-only usage scans only the exact account prefix, counts UTF-8 records including clear markers, and returns no dialogue or file identifiers');
 const legacy=await page.evaluate(async()=>{const db=await new Promise(resolve=>{const request=indexedDB.open('qianmu-prose-assistant-history',1);request.onsuccess=()=>resolve(request.result);});try{return await new Promise((resolve,reject)=>{const request=db.transaction('accounts','readonly').objectStore('accounts').get(fixture.legacyKey);request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});}finally{db.close();}});
 assert.equal(legacy.rows[0].assistant,'LEGACY UNKNOWN OWNER');assert.deepEqual((await page.evaluate(()=>fixture.read())).rows,[]);
 checks.push('legacy v1 raw-handle records are retained untouched but never adopted or counted as verified v2 digest ownership');
 const scannerCases=await page.evaluate(async()=>{
  const {createAccountLocalStore}=await import('./qianmu-account-local-store.js'),contract=await import('./qianmu-prose-assistant-history-contract.js');
  const scanner=createAccountLocalStore({dbName:'qianmu-prose-assistant-history',validateNamespace:contract.proseAssistantHistoryKey,validate:contract.validateProseAssistantHistory,empty:contract.emptyProseAssistantHistory,error:contract.proseAssistantHistoryError,label:'助手历史'});
  const prefix=JSON.stringify(['qianmu-prose-assistant-v2',fixture.account]).slice(0,-1)+',',range=IDBKeyRange.bound(prefix,prefix+'\uffff'),codes=[];
  for(const mode of ['limit','guard','async','throw','close']){let live=true;try{await scanner.scan({range,limit:mode==='limit'?1:100,visit(){if(mode==='guard')live=false;if(mode==='async')return Promise.resolve();if(mode==='throw')throw Object.assign(Error(),{code:'test-visit'});if(mode==='close')scanner.close();}},{guard:()=>live});codes.push('unexpected success');}catch(error){codes.push(error.code);}}
  scanner.close();return codes;
 });
 assert.deepEqual(scannerCases,['prose_assistant_history_capacity','prose_assistant_history_account','prose_assistant_history_storage','test-visit','prose_assistant_history_closed']);
 assert.deepEqual(await page.evaluate(()=>fixture.store.usage(fixture.account)),usage.summary);
 checks.push('range walk rejects cap overflow, stale guard, asynchronous visitors, visitor failure and close without publishing partial statistics or altering originals');
 const inaccessible=await page.evaluate(async()=>{const cursor=IDBObjectStore.prototype.openCursor;try{IDBObjectStore.prototype.openCursor=function(){throw Error('private scan failure');};return await fixture.store.usage(fixture.account);}catch(error){return {code:error.code,message:error.message};}finally{IDBObjectStore.prototype.openCursor=cursor;}});
 assert.equal(inaccessible.code,'prose_assistant_history_storage');assert.doesNotMatch(inaccessible.message,/private/);assert.deepEqual(await page.evaluate(()=>fixture.store.usage(fixture.account)),usage.summary);
 checks.push('cursor failures remain explicit unavailable errors rather than a successful zero, and a later read can recover');
 await page.evaluate(()=>fixture.rawPut({namespace:fixture.key(fixture.account,'broken'),invalid:true}));await assert.rejects(page.evaluate(()=>fixture.store.usage(fixture.account)));
 checks.push('damaged own-account history rejects the entire summary instead of silently excluding its unknown occupancy');
 assert.equal(external,0);assert.deepEqual(errors,[]);console.log(JSON.stringify({checks,count:checks.length,externalRequests:external,pageErrors:errors,productionWrites:false,scope:'isolated real IndexedDB only; no host panel, ST sync or model'},null,2));
}finally{clearTimeout(timer);await context.close();await browser.close();}
