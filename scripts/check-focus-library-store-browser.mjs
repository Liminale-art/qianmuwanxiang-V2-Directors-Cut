// Native database in an intercepted origin. No real user library or generation service.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),{chromium}=require(process.env.QIANMU_PLAYWRIGHT_MODULE||'playwright');
const sources=new Map(await Promise.all(['qianmu-focus-library.js','qianmu-focus-library-store.js','qianmu-focus-voice.js'].map(async file=>['https://qianmu.test/'+file,await readFile(new URL('../'+file,import.meta.url),'utf8')])));
const browser=await chromium.launch({channel:process.env.QIANMU_BROWSER_CHANNEL||undefined,headless:true}),context=await browser.newContext(),errors=[];let external=0;
await context.route('**/*',route=>{const url=route.request().url();return url==='https://qianmu.test/'?route.fulfill({contentType:'text/html',body:'<!doctype html>'}):sources.has(url)?route.fulfill({contentType:'application/javascript',body:sources.get(url)}):(external++,route.abort());});
try{
  const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));await page.goto('https://qianmu.test/');
  const checks=await page.evaluate(async()=>{
    const {createFocusLibraryStore}=await import('/qianmu-focus-library-store.js'),checks=[];
    const check=(name,ok)=>{if(!ok)throw Error(name);checks.push(name);};
    const owner={namespace:'st-user:one',characterKey:'character:A.png'},other={...owner,characterKey:'character:B.png'},second={...owner,namespace:'st-user:two'};
    const blob=new Blob(['RIFF fixture'],{type:'audio/wav'}),draft={id:'one',text:'Original',moments:['focus:complete'],speaker:'Same Name',voice:{voiceId:'v',apiKey:'never saved'}};
    const store=createFocusLibraryStore(),peer=createFocusLibraryStore();
    const initial=await store.save(owner,draft,blob);check('creation commits a separate recording',initial.status==='saved'&&initial.clip.revision===1);
    check('metadata carries no credentials',!JSON.stringify(await store.list(owner.namespace)).includes('never saved'));
    const otherSaved=await store.save(other,draft,blob);await store.save(second,draft,blob);
    check('same names and ids do not share role or account recordings',(await store.list(owner.namespace)).length===2&&(await store.list(second.namespace)).length===1);
    const nativeGet=IDBObjectStore.prototype.get;
    try{IDBObjectStore.prototype.get=function(...args){if(this.name==='audio')throw Error('metadata must not read audio');return nativeGet.apply(this,args);};
      check('folder listing and summary never load audio',(await store.list(owner.namespace)).length===2&&(await store.summary(owner.namespace)).count===2);
    }finally{IDBObjectStore.prototype.get=nativeGet;}
    const raced=await Promise.all([store.save(owner,{...draft,text:'First'},blob,{expectedRevision:1}),peer.save(owner,{...draft,text:'Second'},blob,{expectedRevision:1})]);
    const latest=raced.find(result=>result.status==='saved').clip.revision;
    check('two editors cannot overwrite each other',raced.filter(r=>r.status==='saved').length===1&&raced.filter(r=>r.status==='conflict').length===1);
    check('old playback snapshot never silently receives regenerated audio',(await store.readAudio(owner,'one',1)).status==='conflict'&&(await store.readAudio(owner,'one',latest)).status==='ready');
    check('stale deletion cannot remove newer recording',(await store.remove(owner,'one',1)).status==='conflict');
    const before=await store.summary(owner.namespace),nativePut=IDBObjectStore.prototype.put;
    try{
      IDBObjectStore.prototype.put=function(...args){if(this.name==='audio')throw new DOMException('synthetic quota','QuotaExceededError');return nativePut.apply(this,args);};
      let failed=false;try{await store.save(owner,{...draft,id:'fail'},blob);}catch(_){failed=true;}
      check('audio write failure rolls back metadata and accounting',failed&&(await store.list(owner.namespace)).length===2&&JSON.stringify(await store.summary(owner.namespace))===JSON.stringify(before));
    }finally{IDBObjectStore.prototype.put=nativePut;}
    try{
      let uncommitted=false,settled=false;
      IDBObjectStore.prototype.put=function(...args){const r=nativePut.apply(this,args);if(this.name==='audio')r.addEventListener('success',()=>{uncommitted=!settled;this.transaction.abort();});return r;};
      let failed=false;try{await store.save(owner,{...draft,id:'abort'},blob);}catch(_){failed=true;}finally{settled=true;}
      check('request success is not save success',uncommitted&&failed&&(await store.list(owner.namespace)).length===2);
    }finally{IDBObjectStore.prototype.put=nativePut;}
    let guardCalls=0,failed=false;
    try{await store.save(owner,{...draft,id:'stale'},blob,{isCurrent:()=>++guardCalls<5});}catch(_){failed=true;}
    check('role switch during save aborts all writes',failed&&(await store.list(owner.namespace)).length===2);
    const tiny=createFocusLibraryStore({dbName:'qianmu-focus-library-quota',limits:{clips:1}});await tiny.save(owner,draft,blob);
    failed=false;try{await tiny.save(owner,{...draft,id:'extra'},blob);}catch(e){failed=e.code==='focus_library_quota';}
    check('quota never evicts an existing recording',failed&&(await tiny.list(owner.namespace)).length===1);tiny.close();
    await store.remove(owner,'one',latest);check('delete updates only the selected role and its usage',(await store.summary(owner.namespace)).count===1&&(await store.readAudio(other,'one',otherSaved.clip.revision)).status==='ready');
    check('deletion retry does not change totals twice',(await store.remove(owner,'one',latest)).status==='missing'&&(await store.summary(owner.namespace)).count===1);
    const recreated=await store.save(owner,draft,blob);
    check('delete and recreate never reuse an old edit or playback ticket',recreated.clip.revision>latest&&(await store.readAudio(owner,'one',latest)).status==='conflict'&&(await store.remove(owner,'one',latest)).status==='conflict'&&(await store.save(owner,draft,blob,{expectedRevision:latest})).status==='conflict');
    await store.remove(owner,'one',recreated.clip.revision);
    store.close();peer.close();const reopened=createFocusLibraryStore();check('saved audio survives reopening',(await reopened.readAudio(other,'one',otherSaved.clip.revision)).status==='ready');
    const db=await new Promise((resolve,reject)=>{const request=indexedDB.open('qianmu-focus-library',1);request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});
    await new Promise((resolve,reject)=>{const tx=db.transaction('audio','readwrite');tx.objectStore('audio').delete(JSON.stringify([other.namespace,other.characterKey,'one']));tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error);});
    check('missing local audio is explicit and does not delete its metadata',(await reopened.readAudio(other,'one',otherSaved.clip.revision)).status==='missing'&&(await reopened.list(owner.namespace)).length===1);
    await new Promise((resolve,reject)=>{const tx=db.transaction('usage','readwrite');tx.objectStore('usage').put({count:0,bytes:0},owner.namespace);tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error);});
    failed=false;try{await reopened.remove(other,'one',otherSaved.clip.revision);}catch(_){failed=true;}
    check('inconsistent accounting fails closed rather than deleting more data',failed&&(await reopened.list(owner.namespace)).length===1);db.close();
    check('shared narration and reader database was never opened',!(await indexedDB.databases()).some(db=>db.name==='qianmu-blobstore'));reopened.close();
    return checks;
  });
  assert.equal(external,0);assert.deepEqual(errors,[]);console.log(JSON.stringify({checks,realIndexedDB:true,external,errors,limits:'storage and selection foundation only; no UI, paid TTS, real user data or physical mobile testing'}));
}finally{await context.close();await browser.close();}
