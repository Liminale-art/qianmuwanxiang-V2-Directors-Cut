// Native IndexedDB in a fresh, intercepted origin; never connects to ST or user storage.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),{chromium}=require(process.env.QIANMU_PLAYWRIGHT_MODULE||'playwright');
const source=await readFile(new URL('../qianmu-blobstore.js',import.meta.url),'utf8');
const browser=await chromium.launch({channel:process.env.QIANMU_BROWSER_CHANNEL||undefined,headless:true});
const context=await browser.newContext(),errors=[];let external=0;
await context.route('**/*',route=>route.request().url()==='https://qianmu.test/'
  ?route.fulfill({contentType:'text/html',body:'<!doctype html><title>Isolated book metadata test</title>'})
  :(external++,route.abort()));
try {
  const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));await page.goto('https://qianmu.test/');
  const checks=await page.evaluate(async source=>{
    const books=await import('data:text/javascript,'+encodeURIComponent(source)),checks=[];
    const check=(name,ok)=>{if(!ok)throw Error(name);checks.push(name);};
    const record=()=>({meta:{title:'Original',author:'Writer',mode:'text'},fullText:'Latest body',chapters:[{start:0}],comicDescriptions:{page1:'new description'},sig:'stable',createdAt:123});
    const open=()=>new Promise((resolve,reject)=>{const req=indexedDB.open('qianmu-blobstore',15);req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);});
    await books.putBook('book',record());const original=await books.getBook('book');
    let result=await books.updateBookMetadata('book',{title:' Renamed ',author:' New author ',fullText:'must not overwrite',meta:{mode:'comic'}});
    let current=await books.getBook('book');
    check('only title and author change',result.status==='updated'&&current.meta.title==='Renamed'&&current.meta.author==='New author'&&current.meta.mode==='text');
    check('body and attached data survive',current.fullText===original.fullText&&JSON.stringify(current.chapters)===JSON.stringify(original.chapters)&&JSON.stringify(current.comicDescriptions)===JSON.stringify(original.comicDescriptions)&&current.sig===original.sig&&current.createdAt===123);
    check('result does not retain book body',!('fullText' in result)&&!('record' in result));
    await books.updateBookMetadata('book',{title:'t'.repeat(130),author:'a'.repeat(90)});current=await books.getBook('book');
    check('existing editor field limits preserved',current.meta.title.length===120&&current.meta.author.length===80);
    result=await books.updateBookMetadata('absent',{title:'Never imported'});
    check('missing body is explicit and never upserted',result.status==='missing'&&await books.getBook('absent')===undefined);
    await books.putBook('removed',record());await books.deleteBook('removed');
    result=await books.updateBookMetadata('removed',{title:'Never resurrected'});
    check('deleted book stays deleted',result.status==='missing'&&await books.getBook('removed')===undefined);
    const db=await open();
    try {
      const prior=db.transaction('reader_books','readwrite');prior.objectStore('reader_books').put({...record(),fullText:'Concurrent newer body',comicDescriptions:{page2:'newest'}},'queued');
      result=await books.updateBookMetadata('queued',{title:'New title',author:''});current=await books.getBook('queued');
      check('queued update reads latest committed body',result.status==='updated'&&current.fullText==='Concurrent newer body'&&current.comicDescriptions.page2==='newest');
      await books.putBook('delete-queued',record());const deletion=db.transaction('reader_books','readwrite');deletion.objectStore('reader_books').delete('delete-queued');
      result=await books.updateBookMetadata('delete-queued',{title:'Never resurrected'});
      check('queued deletion cannot be undone by metadata save',result.status==='missing'&&await books.getBook('delete-queued')===undefined);
    } finally {db.close();}
    for(const expireAt of [1,2,3,4]) {
      await books.putBook('stale',record());let calls=0;
      result=await books.updateBookMetadata('stale',{title:'Discard'}, {isCurrent:()=>++calls<expireAt});current=await books.getBook('stale');
      check(`stale editor before boundary ${expireAt} cannot commit`,result.status==='stale'&&current.meta.title==='Original');
    }
    const nativePut=IDBObjectStore.prototype.put;
    try {
      await books.putBook('abort',record());let settled=false,unsettledAtSuccess=false;
      IDBObjectStore.prototype.put=function(...args){const req=nativePut.apply(this,args);if(this.name==='reader_books'){req.addEventListener('success',()=>{unsettledAtSuccess=!settled;this.transaction.abort();});}return req;};
      let failure;await books.updateBookMetadata('abort',{title:'Rollback'}).then(()=>{settled=true;},e=>{settled=true;failure=e;});
      current=await books.getBook('abort');check('request success is not transaction success',unsettledAtSuccess&&!!failure&&current.meta.title==='Original');
      IDBObjectStore.prototype.put=function(){throw new DOMException('Fixture write failure','QuotaExceededError');};
      failure=null;try{await books.updateBookMetadata('abort',{title:'Must fail'});}catch(e){failure=e;}
      current=await books.getBook('abort');check('write failure rejects and preserves original',failure?.name==='QuotaExceededError'&&current.meta.title==='Original');
    } finally {IDBObjectStore.prototype.put=nativePut;}
    let throws=0,failure;
    try{await books.updateBookMetadata('book',{title:'Guard failure'},{isCurrent:()=>{if(++throws===3)throw Error('owner lookup failed');return true;}});}catch(e){failure=e;}
    check('guard exceptions fail closed',failure?.message==='owner lookup failed'&&(await books.getBook('book')).meta.title==='t'.repeat(120));
    return checks;
  },source);
  assert.equal(external,0);assert.deepEqual(errors,[]);console.log(JSON.stringify({checks,realIndexedDB:true,external,errors,limits:'isolated synthetic books; UI not wired and real ST/browser quotas not exercised'}));
} finally {await context.close();await browser.close();}
