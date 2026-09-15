import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),{chromium}=require(process.env.QIANMU_PLAYWRIGHT_MODULE||'playwright');
const allowed=new Set(JSON.parse(await readFile(new URL('../release-files.json',import.meta.url),'utf8')).files.filter(file=>file.endsWith('.js')));
const browser=await chromium.launch({channel:process.env.QIANMU_BROWSER_CHANNEL||undefined,headless:true}),context=await browser.newContext(),errors=[];let external=0;
await context.route('**/*',async route=>{
  const url=new URL(route.request().url()),file=url.pathname.slice(1);
  if(url.origin==='https://qianmu.test'&&url.pathname==='/')return route.fulfill({contentType:'text/html',body:'<!doctype html>'});
  if(url.origin==='https://qianmu.test'&&allowed.has(file))return route.fulfill({contentType:'application/javascript',body:await readFile(new URL('../'+file,import.meta.url),'utf8')});
  external++;return route.abort();
});
try{
  const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));await page.goto('https://qianmu.test/');
  const checks=await page.evaluate(async()=>{
    const {createCharacterArchiveStore}=await import('/qianmu-character-archive-store.js'),{promoteChatCharacterDraft}=await import('/qianmu-character-chat-promotion.js'),
      {createChatCharacterDraft}=await import('/qianmu-character-chat-draft.js'),{characterLibraryBackupDigest,validateCharacterLibraryBackup}=await import('/qianmu-character-library-backup.js');
    const checks=[],check=(name,condition)=>{if(!condition)throw Error(name);checks.push(name);};
    const owner={namespace:'st-user:alice',chatKey:'Chat A'},draft=createChatCharacterDraft({owner,id:'12345678-1234-4234-8234-123456789abc',
      source:{kind:'body',chatKey:owner.chatKey,messageKey:'m1',revisionId:'r1',characterId:'C1'},character:{id:'C1',name:'Stranger',identity:['silver hair']}});
    const original=JSON.stringify(draft),store=createCharacterArchiveStore(),peer=createCharacterArchiveStore(),options={owner,expectedRevision:1,confirmed:true,store,readDraft:()=>draft,isCurrent:()=>true,guard:async()=>{}};
    const results=await Promise.all([promoteChatCharacterDraft(draft,options),promoteChatCharacterDraft(draft,{...options,store:peer})]);
    check('concurrent promotion creates once and retries without duplicating usage',results.filter(row=>row.created).length===1&&results[0].archiveId===results[1].archiveId&&(await store.usage(owner.namespace)).count===1);
    check('promotion preserves draft and creates no binding',JSON.stringify(draft)===original&&(await store.bindings(owner.namespace)).length===0&&results.every(row=>row.automaticBinding===false));
    const id=results[0].archiveId,summary=await store.storageSummary(owner.namespace),backup=await store.backup(owner.namespace);
    check('existing storage summary and backup include the fixed archive',summary.documents.count===1&&validateCharacterLibraryBackup(backup).count===1&&backup.archives[0].head.id===id);
    const restored=createCharacterArchiveStore({dbName:'qianmu-promotion-restore-fixture'}),empty=await restored.backup(owner.namespace);
    await restored.restoreBackup(owner.namespace,backup,{confirmed:true,expectedDigest:await characterLibraryBackupDigest(empty),isCurrent:()=>true});
    check('existing backup restore preserves the new archive format without migration',(await restored.load(owner.namespace,id)).document.name==='Stranger');restored.close();
    const record=await store.load(owner.namespace,id);await store.save(owner.namespace,{id,expectedRevision:record.head.revision,document:{...record.document,name:'Global edit'}});
    let failed=false;try{await promoteChatCharacterDraft(draft,options);}catch(error){failed=error.promotionState==='unconfirmed';}
    check('promotion retry never overwrites an edited global archive',failed&&(await store.load(owner.namespace,id)).document.name==='Global edit'&&(await store.usage(owner.namespace)).count===1);
    const scope='st-user:atomic-fixture',value=draft.document,guard={isCurrent:()=>true},before=JSON.stringify(await store.storageSummary(scope)),nativeAdd=IDBObjectStore.prototype.add;
    try{IDBObjectStore.prototype.add=function(...args){if(this.name==='documents')throw new DOMException('synthetic quota','QuotaExceededError');return nativeAdd.apply(this,args);};
      failed=false;try{await store.createOnce(scope,{id:'quota',document:value},guard);}catch{failed=true;}
      check('document quota failure rolls back head and accounting atomically',failed&&(await store.load(scope,'quota'))===null&&JSON.stringify(await store.storageSummary(scope))===before);
    }finally{IDBObjectStore.prototype.add=nativeAdd;}
    try{let requestSucceeded=false;IDBObjectStore.prototype.add=function(...args){const request=nativeAdd.apply(this,args);if(this.name==='documents')request.addEventListener('success',()=>{requestSucceeded=true;this.transaction.abort();});return request;};
      failed=false;try{await store.createOnce(scope,{id:'abort',document:value},guard);}catch{failed=true;}
      check('successful write request followed by transaction abort is not acknowledged',requestSucceeded&&failed&&(await store.load(scope,'abort'))===null&&JSON.stringify(await store.storageSummary(scope))===before);
    }finally{IDBObjectStore.prototype.add=nativeAdd;}
    failed=false;try{await store.createOnce(scope,{id:'changed',document:value},{isCurrent:()=>false});}catch{failed=true;}
    check('invalid current identity prevents creating any archive',failed&&(await store.load(scope,'changed'))===null);
    const raced=await Promise.allSettled([store.createOnce(scope,{id:'race',document:value},guard),peer.createOnce(scope,{id:'race',document:{...value,name:'Different'}},guard)]);
    check('different documents competing for one stable ID cannot overwrite each other',raced.filter(row=>row.status==='fulfilled').length===1&&raced.filter(row=>row.status==='rejected').length===1&&(await store.usage(scope)).count===1);
    const raw=await new Promise((resolve,reject)=>{const request=indexedDB.open('qianmu-character-archive',1);request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});
    check('database schema remains version one with only the original four stores',raw.version===1&&JSON.stringify(Array.from(raw.objectStoreNames))===JSON.stringify(['bindings','documents','heads','usage']));
    await new Promise((resolve,reject)=>{const tx=raw.transaction('documents','readwrite');tx.objectStore('documents').put({key:JSON.stringify([scope,'orphan']),namespace:scope,revision:'orphan',document:value});tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error);});
    failed=false;try{await store.createOnce(scope,{id:'orphan',document:value},guard);}catch{failed=true;}
    const orphan=await new Promise((resolve,reject)=>{const request=raw.transaction('documents','readonly').objectStore('documents').get(JSON.stringify([scope,'orphan']));request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});
    check('unindexed original document is preserved rather than overwritten',failed&&(await store.load(scope,'orphan'))===null&&orphan.revision==='orphan'&&JSON.stringify(orphan.document)===JSON.stringify(value));
    raw.close();const latest=await store.load(owner.namespace,id);await store.remove(owner.namespace,id,latest.head.revision);
    check('existing archive cleanup removes fixed records and updates usage',(await store.load(owner.namespace,id))===null&&(await store.storageSummary(owner.namespace)).documents.count===0);
    check('no unrelated reader or narration database was opened',!(await indexedDB.databases()).some(row=>row.name==='qianmu-blobstore'));store.close();peer.close();return checks;
  });
  assert.equal(external,0);assert.deepEqual(errors,[]);console.log(JSON.stringify({checks,realIndexedDB:true,external,errors,limits:'isolated synthetic archives only; no UI, actual user data, model calls or physical mobile test'}));
}finally{await context.close();await browser.close();}
