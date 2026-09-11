// Native temporary IndexedDB and synthetic text only. No production origin or data.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),{chromium}=require(process.env.QIANMU_PLAYWRIGHT_MODULE||'playwright');
const browser=await chromium.launch({channel:process.env.QIANMU_BROWSER_CHANNEL||undefined,headless:true}),context=await browser.newContext();
let external=0;const errors=[];
await context.route('**/*',async route=>{
  const url=new URL(route.request().url());
  if(url.href==='https://qianmu.test/')return route.fulfill({contentType:'text/html',body:'<!doctype html>'});
  if(url.origin==='https://qianmu.test'&&['/qianmu-notes.js','/qianmu-blobstore.js'].includes(url.pathname))return route.fulfill({contentType:'application/javascript',body:await readFile(new URL('..'+url.pathname,import.meta.url))});
  external++;return route.abort();
});
try{
  const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));await page.goto('https://qianmu.test/');
  const checks=await page.evaluate(async()=>{
    const api=await import('/qianmu-notes.js'),db=await import('/qianmu-blobstore.js'),checks=[];
    const check=(name,value)=>{if(!value)throw Error(name);checks.push(name);},guard=()=>{};
    const read=()=>api.listQianmuNotes({strict:true}),write=note=>api.saveImportedQianmuNote(note,{check:guard});
    await db.putNote('original',{body:'keep original'});
    let collision=false;try{await write({id:'original',body:'must not replace'});}catch{collision=true;}
    check('create-only import preserves an existing ID',collision&&(await read()).find(n=>n.id==='original').body==='keep original');
    const add=IDBObjectStore.prototype.add;let result;
    try{
      IDBObjectStore.prototype.add=function(value,key){const request=add.call(this,value,key);if(key==='abort')request.addEventListener('success',()=>this.transaction.abort(),{once:true});return request;};
      const file=new File([JSON.stringify({type:'qianmu-notes',version:1,notes:[{id:'abort',body:'rollback'},{id:'committed',body:'saved'}]})],'fixture.json');
      result=await api.importQianmuNotesBackup(file,{check:guard,read,write,uid:()=> 'copy'});
    }finally{IDBObjectStore.prototype.add=add;}
    const notes=await read();
    check('aborted successful request is failed while another note commits',result.imported===1&&result.failed.length===1&&!notes.some(n=>n.id==='abort')&&notes.some(n=>n.id==='committed'));
    const cursor=IDBObjectStore.prototype.openCursor;let failed=false;
    try{
      IDBObjectStore.prototype.openCursor=function(...args){const request=cursor.apply(this,args);if(this.name==='notes')request.addEventListener('success',()=>{if(!request.result)this.transaction.abort();});return request;};
      try{await read();}catch{failed=true;}
    }finally{IDBObjectStore.prototype.openCursor=cursor;}
    check('a late inventory abort cannot masquerade as a successfully read empty or partial library',failed);
    let guarded=false;try{await api.saveImportedQianmuNote({id:'stale'},{check(){throw Error('stale');}});}catch{guarded=true;}
    check('stale import does not create a note',guarded&&!(await read()).some(n=>n.id==='stale'));
    const audio=new Blob(['synthetic audio'],{type:'audio/mpeg'});
    await db.importFavorite('favorite-original',audio,{speaker:'fixture'},'original');
    let collisionError;try{await db.importFavorite('favorite-original',audio,{},'replacement');}catch(error){collisionError=error;}
    check('favorite import preserves collisions and provides a readable error',!!collisionError?.message&&(await db.getFavorite('favorite-original')).label==='original');
    let aborted=false;
    try{
      IDBObjectStore.prototype.add=function(value,key){const request=add.call(this,value,key);if(key==='favorite-abort')request.addEventListener('success',()=>this.transaction.abort(),{once:true});return request;};
      try{await db.importFavorite('favorite-abort',audio,{},'abort');}catch(error){aborted=!!error?.message;}
    }finally{IDBObjectStore.prototype.add=add;}
    check('a favorite request success followed by abort is never reported as committed',aborted&&!(await db.getFavorite('favorite-abort')));
    await db.importFavorite('favorite-next',audio,{},'next');
    check('another favorite can commit after an independent failure',(await db.getFavorite('favorite-next')).label==='next');
    let guardCalls=0,staleFavorite=false;
    try{await db.importFavorite('favorite-stale',audio,{},'',{check(){if(++guardCalls===2)throw Error('stale after database await');}});}catch{staleFavorite=true;}
    check('favorite guard is rechecked after opening the database and before any write',staleFavorite&&guardCalls===2&&!(await db.getFavorite('favorite-stale')));
    const writer=db.createReaderPackageWriter(),oldBlob=new Blob(['old']),newBlob=new Blob(['new']);
    const rows=[
      ['putBook','reader_books','reader-book',{fullText:'old'},{fullText:'new'},()=>db.getBook('reader-book'),v=>v.fullText],
      ['putCover','reader_covers','reader-cover',oldBlob,newBlob,()=>db.getCover('reader-cover'),v=>v.text()],
      ['putReaderChat','reader_chats','reader-chat',{messages:['old']},{messages:['new']},()=>db.getReaderChat('reader-chat'),v=>v.messages[0]],
      ['putReaderImageByKey','reader_images','reader-image::1',oldBlob,newBlob,()=>db.getReaderImage('reader-image',1),v=>v.text()],
      ['putReaderVectors','reader_vectors','reader-vector',{model:'old'},{model:'new'},()=>db.getReaderVectors('reader-vector'),v=>v.model],
    ];
    for(const [method,store,key,original,replacement,readValue,content] of rows){
      await writer[method](key,original);const put=IDBObjectStore.prototype.put;let failed=false;
      try{
        IDBObjectStore.prototype.put=function(value,id){const request=put.call(this,value,id);if(this.name===store&&id===key)request.addEventListener('success',()=>this.transaction.abort(),{once:true});return request;};
        try{await writer[method](key,replacement);}catch(error){failed=!!error?.message;}
      }finally{IDBObjectStore.prototype.put=put;}
      check(method+' rejects an aborted replacement and preserves the old original',failed&&await content(await readValue())==='old');
      let calls=0,stale=false;const guarded=db.createReaderPackageWriter({check(){if(++calls===2)throw Error('changed while opening database');}});
      try{await guarded[method](key,replacement);}catch{stale=true;}
      check(method+' checks after database wait without changing the original',stale&&calls===2&&await content(await readValue())==='old');
      await writer[method](key,replacement);check(method+' commits a confirmed replacement',await content(await readValue())==='new');
    }
    await db.putAudio('reader-audio-existing',oldBlob,{marker:'old'});
    const entry=key=>({key,blob:newBlob,meta:{marker:'new'}});
    const existing=await writer.bulkPutAudio([entry('reader-audio-existing'),entry('reader-audio-new'),entry('reader-audio-new')]);
    check('audio import preserves original bytes and metadata and skips same-batch duplicates',existing.added===1&&existing.skipped===2&&existing.failed===0&&(await db.getAudio('reader-audio-existing')).meta.marker==='old'&&await (await db.getAudio('reader-audio-existing')).blob.text()==='old');
    const audioProgress=[];let audioResult;
    try{
      IDBObjectStore.prototype.add=function(value,key){const request=add.call(this,value,key);if(key==='reader-audio-abort')request.addEventListener('success',()=>this.transaction.abort(),{once:true});return request;};
      audioResult=await writer.bulkPutAudio([entry('reader-audio-abort'),entry('reader-audio-after')],{onProgress:p=>audioProgress.push(p)});
    }finally{IDBObjectStore.prototype.add=add;}
    check('audio count follows transaction commit and continues after an independent failed row',audioResult.added===1&&audioResult.failed===1&&!await db.getAudio('reader-audio-abort')&&!!await db.getAudio('reader-audio-after')&&audioProgress[0].added===0&&audioProgress[0].failed===1);
    let current=true,partial,interrupted=false;
    const guardedAudio=db.createReaderPackageWriter({check(){if(!current)throw Error('stale audio import');}});
    try{await guardedAudio.bulkPutAudio([entry('reader-audio-first'),entry('reader-audio-never')],{onProgress:p=>{partial=p;current=false;}});}catch{interrupted=true;}
    check('audio interruption retains committed progress but prevents the next record',interrupted&&partial.added===1&&!!await db.getAudio('reader-audio-first')&&!await db.getAudio('reader-audio-never'));
    const getKey=IDBObjectStore.prototype.getKey;current=true;interrupted=false;
    try{
      IDBObjectStore.prototype.getKey=function(key){const request=getKey.call(this,key);if(key==='reader-audio-lookup')request.addEventListener('success',()=>{current=false;},{once:true});return request;};
      try{await guardedAudio.bulkPutAudio([entry('reader-audio-lookup')]);}catch{interrupted=true;}
    }finally{IDBObjectStore.prototype.getKey=getKey;}
    check('audio lookup rechecks the guard inside the same write transaction',interrupted&&!await db.getAudio('reader-audio-lookup'));
    let audioCalls=0;interrupted=false;
    try{await db.createReaderPackageWriter({check(){if(++audioCalls===2)throw Error('database wait expired');}}).bulkPutAudio([entry('reader-audio-open')]);}catch{interrupted=true;}
    check('audio import cannot write after its database wait becomes stale',interrupted&&audioCalls===2&&!await db.getAudio('reader-audio-open'));
    for(let i=0;i<50;i++)await writer.pushRetLog({query:'original-'+i,at:1000+i});
    const originalLogs=JSON.stringify(await db.listRetLog());let logFailed=false;
    try{
      IDBObjectStore.prototype.add=function(...args){const request=add.apply(this,args);if(this.name==='reader_retlog')request.addEventListener('success',()=>this.transaction.abort(),{once:true});return request;};
      try{await writer.pushRetLog({query:'aborted insertion',at:2000});}catch(error){logFailed=!!error?.message;}
    }finally{IDBObjectStore.prototype.add=add;}
    check('an aborted log insertion preserves all fifty originals',logFailed&&JSON.stringify(await db.listRetLog())===originalLogs);
    const deleteRecord=IDBObjectStore.prototype.delete;logFailed=false;
    try{
      IDBObjectStore.prototype.delete=function(...args){const request=deleteRecord.apply(this,args);if(this.name==='reader_retlog')request.addEventListener('success',()=>this.transaction.abort(),{once:true});return request;};
      try{await writer.pushRetLog({query:'aborted trimming',at:2000});}catch(error){logFailed=!!error?.message;}
    }finally{IDBObjectStore.prototype.delete=deleteRecord;}
    check('trimming failure rolls back both the new log and deletion of old logs',logFailed&&JSON.stringify(await db.listRetLog())===originalLogs);
    const getAllKeys=IDBObjectStore.prototype.getAllKeys;current=true;logFailed=false;
    try{
      IDBObjectStore.prototype.getAllKeys=function(...args){const request=getAllKeys.apply(this,args);if(this.name==='reader_retlog')request.addEventListener('success',()=>{current=false;},{once:true});return request;};
      try{await guardedAudio.pushRetLog({query:'stale trim',at:2000});}catch{logFailed=true;}
    }finally{IDBObjectStore.prototype.getAllKeys=getAllKeys;}
    check('log guard expiry before trimming rolls back the queued insertion',logFailed&&JSON.stringify(await db.listRetLog())===originalLogs);
    let logCalls=0;logFailed=false;
    try{await db.createReaderPackageWriter({check(){if(++logCalls===2)throw Error('stale log database wait');}}).pushRetLog({query:'stale open',at:2000});}catch{logFailed=true;}
    check('log import rechecks its owner after waiting for the database',logFailed&&logCalls===2&&JSON.stringify(await db.listRetLog())===originalLogs);
    await writer.pushRetLog({query:'confirmed',at:2000});const committedLogs=await db.listRetLog();
    check('a confirmed log replaces only the oldest insertion and retains exactly fifty',committedLogs.length===50&&committedLogs[0].query==='confirmed'&&!committedLogs.some(r=>r.query==='original-0')&&committedLogs.some(r=>r.query==='original-1'));
    const descriptor=Object.getOwnPropertyDescriptor(window,'indexedDB');
    try{
      Object.defineProperty(window,'indexedDB',{configurable:true,value:undefined});
      let logsUnavailable=false;try{await writer.pushRetLog({query:'unavailable'});}catch{logsUnavailable=true;}check('log import rejects unavailable storage',logsUnavailable);
      let unavailable=false;try{await writer.bulkPutAudio([entry('reader-audio-unavailable')]);}catch{unavailable=true;}check('audio import rejects unavailable storage instead of claiming saved',unavailable);
      for(const [name,run] of [['strict read',read],['persistent import',()=>write({id:'no-storage'})],['favorite import',()=>db.importFavorite('no-storage',audio,{},'')],['reader import',()=>writer.putBook('no-storage',{})]]){
        let failed=false;try{await run();}catch{failed=true;}check(name+' rejects unavailable storage',failed);
      }
      await api.saveQianmuNote({id:'temporary',body:'normal temporary',pinned:false});
      const local=await api.listQianmuNotes();
      check('normal temporary notes still work but failed imports never become temporary',local.some(n=>n.id==='temporary')&&!local.some(n=>n.id==='no-storage'));
    }finally{if(descriptor)Object.defineProperty(window,'indexedDB',descriptor);else delete window.indexedDB;}
    return checks;
  });
  assert.equal(checks.length,40);assert.equal(external,0);assert.deepEqual(errors,[]);console.log(JSON.stringify({checks,external,errors}));
}finally{await context.close();await browser.close();}
