// Only fresh synthetic IndexedDB; no ST page, account or user records.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),{chromium}=require(process.env.QIANMU_PLAYWRIGHT_MODULE||'playwright');
const source=await readFile(new URL('../qianmu-blobstore.js',import.meta.url),'utf8');
const browser=await chromium.launch({channel:process.env.QIANMU_BROWSER_CHANNEL||undefined,headless:true});
const context=await browser.newContext(),errors=[];let external=0;
await context.route('**/*',route=>route.request().url()==='https://qianmu.test/'?route.fulfill({contentType:'text/html',body:'<!doctype html><title>Isolated deletion</title>'}):route.request().url()==='https://qianmu.test/store.js'?route.fulfill({contentType:'application/javascript',body:source}):(external++,route.abort()));
try {
  const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));await page.goto('https://qianmu.test/');
  const checks=await page.evaluate(async source=>{
    const api=await import('/store.js'),checks=[];
    const check=(name,ok)=>{if(!ok)throw Error(name);checks.push(name);};
    const archive=slices=>slices.map(s=>({...s,archived:true}));
    const options={archiveSlices:archive,sliceSchemaVersion:3};
    const seed=async id=>{
      await api.putBook(id,{fullText:'body'});await api.putCover(id,new Blob(['cover']));await api.putReaderImage(id,1,new Blob(['image']));
      for(const char of ['charA','charB']){
        await api.putReaderChat(`${char}::${id}`,{messages:['hello'],assistantMessages:['draft'],summaries:['memory'],slices:[{id:'slice'}],unknown:'preserve'});
        await api.putReaderVectors(`${char}::${id}`,{vecs:{slice:[1]}});
      }
      await api.putReaderVectors(`orphan::${id}`,{vecs:{old:[1]}});
    };
    await seed('book');await seed('book-other');
    let result=await api.deleteReaderBookData('book',options),chat=await api.getReaderChat('charA::book');
    check('keep commits all body/cover/images together',result.status==='committed'&&!await api.getBook('book')&&!await api.getCover('book')&&!await api.getReaderImage('book',1));
    check('keep archives dialogue but preserves summaries unknown fields and vectors',chat.messages.length===0&&chat.assistantMessages.length===0&&chat.slices[0].archived&&chat.summaries[0]==='memory'&&chat.unknown==='preserve'&&!!await api.getReaderVectors('charA::book'));
    check('all companions share cleanup but not memories',result.counts.conversations===2&&(await api.getReaderChat('charB::book')).slices[0].archived);
    check('exact book boundaries preserve neighbours',!!await api.getBook('book-other')&&(await api.getReaderChat('charA::book-other')).messages.length===1);
    result=await api.deleteReaderBookData('book',{deleteMemory:true});
    check('purge includes orphan vectors without chat buckets',result.counts.buckets===2&&result.counts.vectors===3&&!await api.getReaderVectors('orphan::book'));
    result=await api.deleteReaderBookData('book',options);
    check('retry is idempotent and never resurrects missing buckets',result.status==='committed'&&Object.values(result.counts).every(n=>n===0)&&!await api.getReaderChat('charA::book'));
    await seed('rollback');
    const originalDelete=IDBObjectStore.prototype.delete,originalPut=IDBObjectStore.prototype.put;
    try {
      let atSuccess=false,settled=false;
      IDBObjectStore.prototype.delete=function(...args){const req=originalDelete.apply(this,args);if(this.name==='reader_books')req.addEventListener('success',()=>{atSuccess=!settled;this.transaction.abort();});return req;};
      let failed=false;try{await api.deleteReaderBookData('rollback',options);}catch(_){failed=true;}finally{settled=true;}
      check('request success followed by abort never reports completion',atSuccess&&failed&&!!await api.getBook('rollback')&&!!await api.getCover('rollback')&&(await api.getReaderChat('charA::rollback')).messages.length===1);
      IDBObjectStore.prototype.delete=originalDelete;
      IDBObjectStore.prototype.put=function(){throw new DOMException('synthetic quota','QuotaExceededError');};
      failed=false;try{await api.deleteReaderBookData('rollback',options);}catch(e){failed=e.name==='QuotaExceededError';}
      check('archive failure rolls back book and images as well',failed&&!!await api.getBook('rollback')&&!!await api.getReaderImage('rollback',1));
    }finally{IDBObjectStore.prototype.delete=originalDelete;IDBObjectStore.prototype.put=originalPut;}
    let calls=0;result=await api.deleteReaderBookData('rollback',{...options,isCurrent:()=>++calls<5});
    check('owner loss aborts pending transaction',result.status==='stale'&&!!await api.getBook('rollback')&&(await api.getReaderChat('charA::rollback')).messages.length===1);
    let failed=false;try{await api.deleteReaderBookData('rollback',{...options,archiveSlices:()=>Promise.resolve([])});}catch(_){failed=true;}
    check('asynchronous archive callback rejected without partial deletion',failed&&!!await api.getBook('rollback'));
    result=await api.deleteReaderBookData('rollback',options);
    check('failed cleanup remains safely retryable',result.status==='committed'&&!await api.getBook('rollback'));
    const originalCursor=IDBObjectStore.prototype.openCursor,originalGet=IDBObjectStore.prototype.get,reads=[];
    try{
      IDBObjectStore.prototype.openCursor=function(){throw Error('cleanup must not load whole-store values');};
      IDBObjectStore.prototype.get=function(key){reads.push([this.name,key]);return originalGet.call(this,key);};
      await api.deleteReaderBookData('rollback',options);
      check('cleanup reads only matching dialogue values, never neighbouring heavy payloads',reads.every(([store,key])=>store==='reader_chats'&&key.endsWith('::rollback')));
    }finally{IDBObjectStore.prototype.openCursor=originalCursor;IDBObjectStore.prototype.get=originalGet;}
    return checks;
  },source);
  assert.equal(external,0);assert.deepEqual(errors,[]);console.log(JSON.stringify({checks,realIndexedDB:true,external,errors}));
}finally{await context.close();await browser.close();}
