// Native temporary IndexedDB and synthetic text only. No production origin or data.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {storyboardFunctionSource} from '../tests/helpers/storyboard-form-fixture.mjs';
const require=createRequire(import.meta.url),{chromium}=require(process.env.QIANMU_PLAYWRIGHT_MODULE||'playwright');
const browser=await chromium.launch({channel:process.env.QIANMU_BROWSER_CHANNEL||undefined,headless:true}),context=await browser.newContext();
let external=0;const errors=[];
await context.route('**/*',async route=>{
  const url=new URL(route.request().url());
  if(url.href==='https://qianmu.test/')return route.fulfill({contentType:'text/html',body:'<!doctype html>'});
  if(url.origin==='https://qianmu.test'&&['/qianmu-notes.js','/qianmu-blobstore.js','/qianmu-reader-package.js','/qianmu-json-input.js'].includes(url.pathname))return route.fulfill({contentType:'application/javascript',body:await readFile(new URL('..'+url.pathname,import.meta.url))});
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
    const reader=db.createReaderPackageReader();
    for(const [method,row] of [['getBook',rows[0]],['getCover',rows[1]],['getReaderChat',rows[2]],['getReaderVectors',rows[4]]]){
      const [,store,key,,,,content]=row;const get=IDBObjectStore.prototype.get;
      check(method+' returns the original only after a completed read',await content(await reader[method](key))==='new');
      let failed=false;
      try{
        IDBObjectStore.prototype.get=function(id){const request=get.call(this,id);if(this.name===store&&id===key)request.addEventListener('success',()=>this.transaction.abort(),{once:true});return request;};
        try{await reader[method](key);}catch(error){failed=!!error?.message;}
      }finally{IDBObjectStore.prototype.get=get;}
      check(method+' rejects a successful request followed by transaction abort',failed);
      let calls=0;failed=false;
      try{await db.createReaderPackageReader({check(){if(++calls===2)throw Error('stale database wait');}})[method](key);}catch{failed=true;}
      check(method+' checks state again after the database wait',failed&&calls===2);
      let current=true;failed=false;
      try{
        IDBObjectStore.prototype.get=function(id){const request=get.call(this,id);if(this.name===store&&id===key)request.addEventListener('success',()=>{current=false;},{once:true});return request;};
        try{await db.createReaderPackageReader({check(){if(!current)throw Error('stale completion');}})[method](key);}catch{failed=true;}
      }finally{IDBObjectStore.prototype.get=get;}
      check(method+' cannot publish a result after its owner changes before completion',failed);
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
    let lookupAborted;
    try{
      IDBObjectStore.prototype.getKey=function(key){const request=getKey.call(this,key);if(key==='reader-audio-lookup-abort')request.addEventListener('success',()=>this.transaction.abort(),{once:true});return request;};
      lookupAborted=await writer.bulkPutAudio([entry('reader-audio-lookup-abort'),entry('reader-audio-after-lookup-abort')]);
    }finally{IDBObjectStore.prototype.getKey=getKey;}
    check('external abort during audio lookup fails only that row and does not prevent the next committed row',lookupAborted.failed===1&&lookupAborted.added===1&&lookupAborted.skipped===0&&!await db.getAudio('reader-audio-lookup-abort')&&!!await db.getAudio('reader-audio-after-lookup-abort'));
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
    logFailed=false;
    try{
      IDBObjectStore.prototype.getAllKeys=function(...args){const request=getAllKeys.apply(this,args);if(this.name==='reader_retlog')request.addEventListener('success',()=>this.transaction.abort(),{once:true});return request;};
      try{await writer.pushRetLog({query:'lookup aborted externally',at:2000});}catch{logFailed=true;}
    }finally{IDBObjectStore.prototype.getAllKeys=getAllKeys;}
    check('external abort during log lookup preserves every original and does not claim the new record committed',logFailed&&JSON.stringify(await db.listRetLog())===originalLogs);
    let logCalls=0;logFailed=false;
    try{await db.createReaderPackageWriter({check(){if(++logCalls===2)throw Error('stale log database wait');}}).pushRetLog({query:'stale open',at:2000});}catch{logFailed=true;}
    check('log import rechecks its owner after waiting for the database',logFailed&&logCalls===2&&JSON.stringify(await db.listRetLog())===originalLogs);
    await writer.pushRetLog({query:'confirmed',at:2000});const committedLogs=await db.listRetLog();
    check('a confirmed log replaces only the oldest insertion and retains exactly fifty',committedLogs.length===50&&committedLogs[0].query==='confirmed'&&!committedLogs.some(r=>r.query==='original-0')&&committedLogs.some(r=>r.query==='original-1'));
    const scans=[['listReaderChatKeys','reader_chats','openKeyCursor'],['listReaderImages','reader_images','openCursor'],['listReaderVectorKeys','reader_vectors','openKeyCursor'],['listAudio','audio','openCursor'],['listRetLog','reader_retlog','openCursor']];
    for(const [method,store,cursorMethod] of scans){
      const expected=await db[method](),actual=await reader[method]();
      check(method+' preserves inventory projection and ordering after completion',JSON.stringify(actual)===JSON.stringify(expected)&&actual.every((item,i)=>item?.blob?.size===expected[i]?.blob?.size));
      const original=IDBObjectStore.prototype[cursorMethod];
      for(const end of [false,true]){
        let failed=false;
        try{
          IDBObjectStore.prototype[cursorMethod]=function(...args){const request=original.apply(this,args);if(this.name===store)request.addEventListener('success',()=>{if(!!request.result!==end)this.transaction.abort();});return request;};
          try{await reader[method]();}catch(error){failed=!!error?.message;}
        }finally{IDBObjectStore.prototype[cursorMethod]=original;}
        check(method+(end?' refuses a late end-of-scan abort':' refuses a partial inventory after cursor abort'),failed);
      }
      let calls=0,failed=false;
      try{await db.createReaderPackageReader({check(){if(++calls===2)throw Error('stale scan open');}})[method]();}catch{failed=true;}
      check(method+' rechecks state after opening the database',failed&&calls===2);
      for(const end of [false,true]){
        let current=true;failed=false;
        try{
          IDBObjectStore.prototype[cursorMethod]=function(...args){const request=original.apply(this,args);if(this.name===store)request.addEventListener('success',()=>{if(!!request.result!==end)current=false;});return request;};
          try{await db.createReaderPackageReader({check(){if(!current)throw Error('stale scan');}})[method]();}catch{failed=true;}
        }finally{IDBObjectStore.prototype[cursorMethod]=original;}
        check(method+(end?' rejects state changes at the end of scanning':' stops scanning when the owner changes'),failed);
      }
    }
    const descriptor=Object.getOwnPropertyDescriptor(window,'indexedDB');
    try{
      Object.defineProperty(window,'indexedDB',{configurable:true,value:undefined});
      let unavailableScans=0;for(const [method] of scans){try{await reader[method]();}catch{unavailableScans++;}}check('every backup directory rejects unavailable storage',unavailableScans===5);
      let readUnavailable=false;try{await reader.getBook('reader-book');}catch{readUnavailable=true;}check('reader backup cannot read cached database handles after storage becomes unavailable',readUnavailable);
      let logsUnavailable=false;try{await writer.pushRetLog({query:'unavailable'});}catch{logsUnavailable=true;}check('log import rejects unavailable storage',logsUnavailable);
      let unavailable=false;try{await writer.bulkPutAudio([entry('reader-audio-unavailable')]);}catch{unavailable=true;}check('audio import rejects unavailable storage instead of claiming saved',unavailable);
      for(const [name,run] of [['strict read',read],['persistent import',()=>write({id:'no-storage'})],['favorite import',()=>db.importFavorite('no-storage',audio,{},'')],['reader import',()=>writer.putBook('no-storage',{})]]){
        let failed=false;try{await run();}catch{failed=true;}check(name+' rejects unavailable storage',failed);
      }
      await api.saveQianmuNote({id:'temporary',body:'normal temporary',pinned:false});
      const local=await api.listQianmuNotes();
      check('normal temporary notes still work but failed imports never become temporary',local.some(n=>n.id==='temporary')&&!local.some(n=>n.id==='no-storage'));
    }finally{if(descriptor)Object.defineProperty(window,'indexedDB',descriptor);else delete window.indexedDB;}
    const {createCoreadImportViewGuard,prepareCoreadPackageExport,readCoreadPackageFile}=await import('/qianmu-reader-package.js');
    const pack={type:'qianmu-coread',version:5,books:[{meta:{id:'synthetic-book'},fullText:'月光 synthetic original'}],prefs:{fontSize:16}};
    const normalPack=prepareCoreadPackageExport(pack),readPack=await readCoreadPackageFile(normalPack.blob);
    check('native Blob export round trips Unicode originals through the real package reader',!normalPack.preservationOnly&&JSON.stringify(readPack)===JSON.stringify(pack));
    let deep={original:'keep complete'};for(let i=0;i<42;i++)deep={nested:deep};
    const originalText=JSON.stringify({...pack,chats:[{key:'synthetic-chat',rec:deep}]}),preserved=prepareCoreadPackageExport(JSON.parse(originalText));
    check('non-restorable deep originals remain byte-complete in a marked preservation copy',preserved.preservationOnly&&await preserved.blob.text()===originalText);
    let refused=false;try{await readCoreadPackageFile(preserved.blob);}catch{refused=true;}
    check('preservation classification agrees with the current native import rejection',refused);
    const mount=reader=>{
      const host=document.createElement('section');host.innerHTML=reader?'<div class="sd-reader-morepage"><input hidden></div>':'<div id="story-director-modal" class="open"><section><input hidden></section></div>';
      document.body.append(host);const root=host.firstElementChild,input=host.querySelector('input'),token=createCoreadImportViewGuard(input);
      return {host,root,input,token,done(){token.release();host.remove();}};
    };
    const rejects=token=>{try{token.check();return false;}catch{return true;}};
    let f=mount(false);check('a hidden native file input on an open backup page remains valid',!rejects(f.token));
    f.root.classList.remove('open');f.root.classList.add('open');check('closing then reopening a modal cannot revive its pending import',rejects(f.token));f.done();
    f=mount(true);check('the independent reader center does not require the main modal',!rejects(f.token));
    f.root.hidden=true;f.root.hidden=false;check('closing then reopening the reader center invalidates its import',rejects(f.token));f.done();
    f=mount(false);f.input.remove();check('a removed import control cannot continue a stale page operation',rejects(f.token));f.done();
    f=mount(false);const replacement=document.createElement('section');replacement.append(f.input);f.root.replaceChildren(replacement);await Promise.resolve();check('storage-card refresh can retain the same file input without cancelling import',!rejects(f.token));f.done();
    f=mount(true);window.dispatchEvent(new Event('pagehide'));check('leaving the document invalidates a reader import',rejects(f.token));f.done();
    f=mount(false);const exportGuard=createCoreadImportViewGuard(f.input,'导出');f.root.classList.remove('open');let exportError;
    try{exportGuard.check();}catch(error){exportError=error.message;}exportGuard.release();f.done();
    check('the shared page guard reports an export cancellation without claiming imported writes',exportError.includes('导出页面')&&exportError.includes('未导出备份')&&!exportError.includes('已写入'));
    return checks;
  });
  await page.evaluate(code=>{window.eval(code);window.downloadRevoked=0;const revoke=URL.revokeObjectURL.bind(URL);URL.revokeObjectURL=url=>{window.downloadRevoked++;revoke(url);};},storyboardFunctionSource('ttsDownloadBlob'));
  const pendingDownload=page.waitForEvent('download');
  await page.evaluate(()=>ttsDownloadBlob(new Blob(['synthetic backup only'],{type:'application/json'}),'千幕-隔离备份.json'));
  const download=await pendingDownload;assert.equal(download.suggestedFilename(),'千幕-隔离备份.json');
  let content='';for await(const chunk of await download.createReadStream())content+=chunk.toString();assert.equal(content,'synthetic backup only');
  await page.waitForFunction(()=>window.downloadRevoked===1);assert.equal(await page.locator('a').count(),0);
  checks.push('the real browser receives complete synthetic bytes and filename before one delayed URL release');
  assert.equal(checks.length,102);assert.equal(external,0);assert.deepEqual(errors,[]);console.log(JSON.stringify({checks,external,errors}));
}finally{await context.close();await browser.close();}
