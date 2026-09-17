// Synthetic recipes in a disposable browser profile; no ST, generation or production cleanup.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {storyboardFunctionSource as section} from '../tests/helpers/storyboard-form-fixture.mjs';
const require=createRequire(import.meta.url),{chromium}=require(process.env.QIANMU_PLAYWRIGHT_MODULE||'playwright');
const sources=new Map(await Promise.all(['qianmu-blobstore.js','qianmu-plan-archive-write.js','qianmu-config-connections.js','qianmu-json-input.js','qianmu-data-migrations.js'].map(async file=>['https://qianmu.test/'+file,await readFile(new URL('../'+file,import.meta.url),'utf8')])));
const browser=await chromium.launch({channel:process.env.QIANMU_BROWSER_CHANNEL||undefined,headless:true}),context=await browser.newContext();
let external=0;const errors=[];
await context.route('**/*',route=>{const url=route.request().url();return url==='https://qianmu.test/'?route.fulfill({contentType:'text/html',body:'<!doctype html><body></body>'}):sources.has(url)?route.fulfill({contentType:'application/javascript',body:sources.get(url)}):(external++,route.abort());});
try {
  const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));await page.goto('https://qianmu.test/');
  const result=await page.evaluate(async source=>{
    const api=await import('/qianmu-blobstore.js'),checks=[],check=(name,ok)=>{if(!ok)throw Error(name);checks.push(name);};
    const make=(key,prompt)=>({key,chatKey:'fixture',recordId:'same',updatedAt:1,snapshot:{prompt,profile:{seed:0},payload:{prompt,workflow:{nodes:['kept']}}}});
    const read=async key=>(await api.getStoryboardSnapshots([key]))[0];
    const put=rows=>api.putStoryboardSnapshots(rows,{preserveExisting:true});
    const original=make('base','original'),changed=make('base','changed');
    check('first archival preserves the legacy reference format',(await put([original])).stored[0]==='base');
    const originalRow=JSON.stringify(await read('base'));
    check('identical retries keep original archival metadata',(await put([{...original,updatedAt:2}])).stored[0]==='base'&&JSON.stringify(await read('base'))===originalRow);
    const revision=(await put([changed])).stored[0];
    check('different payload receives an independent digest revision',/^base␟revision:[a-f0-9]{64}$/.test(revision));
    check('the original is not overwritten',JSON.stringify(await read('base'))===originalRow);
    check('the new revision retains the full recipe',(await read(revision)).snapshot.payload.workflow.nodes[0]==='kept'&&(await read(revision)).snapshot.prompt==='changed');
    check('identical revision retries reuse the committed key',(await put([changed])).stored[0]===revision);
    const batch=await put([changed,changed,make('base','third')]);
    check('duplicate and different batch revisions retain input order',batch.stored[0]===revision&&batch.stored[1]===revision&&batch.stored[2]!==revision);
    const concurrent=await Promise.all([put([make('race','A')]),put([make('race','B')])]);
    check('concurrent writers keep both independent recipes',concurrent[0].stored[0]!==concurrent[1].stored[0]&&(await api.getStoryboardSnapshots(concurrent.flatMap(row=>row.stored))).length===2);
    const mutable=make('captured','before'),pending=put([mutable]);mutable.snapshot.prompt='after';await pending;
    check('payload is captured before asynchronous hashing',(await read('captured')).snapshot.prompt==='before');
    // A digest is not trusted in place of comparing the actual stored payload.
    const collision=make('collision','new');await put([make('collision','old')]);
    const collisionKey=(await put([collision])).stored[0];
    await api.putStoryboardSnapshots([{...make(collisionKey,'corrupt fixture')}]);
    let collisionRejected=false;try{await put([make('collision-first','new'),collision]);}catch{collisionRejected=true;}
    check('conflicting digest slot aborts the entire batch',collisionRejected&&!await read('collision-first'));
    check('conflicting slots and legacy originals are never overwritten',(await read(collisionKey)).snapshot.prompt==='corrupt fixture'&&(await read('collision')).snapshot.prompt==='old');
    const nativeAdd=IDBObjectStore.prototype.add;
    try {
      IDBObjectStore.prototype.add=function(value,...args){if(this.name==='storyboard_snapshots'&&value.key==='quota-two')throw new DOMException('synthetic quota','QuotaExceededError');return nativeAdd.call(this,value,...args);};
      let rejected=false;try{await put([make('quota-one','one'),make('quota-two','two')]);}catch{rejected=true;}
      check('storage failure rolls back the complete batch',rejected&&(await api.getStoryboardSnapshots(['quota-one','quota-two'])).length===0);
    } finally {IDBObjectStore.prototype.add=nativeAdd;}

    const base='entry-chat␟image',old={source:'novel',prompt:'old prompt',negative:'old negative',profile:{seed:0},payload:{prompt:'old prompt',negative:'old negative',parameters:{steps:28}}};
    await put([{key:base,chatKey:'entry-chat',recordId:'image',snapshot:old}]);
    const record={id:'image',chatKey:'entry-chat',source:'novel',snapshot:{...structuredClone(old),prompt:'imported prompt'}},records=[record];
    const state={source:'novel',profiles:{novel:{}},promptDraft:{shots:[]}};let saves=0,inlineRenders=0,generations=0;
    class Popup {
      constructor(wrap){this.wrap=wrap;}
      async show(){document.body.append(this.wrap);this.wrap.querySelector('.sd-storyboard-edit-positive').value='user edited prompt';this.wrap.querySelector('.sd-storyboard-edit-negative').value='user edited negative';this.wrap.remove();return 2;}
    }
    Object.assign(window,await import('/qianmu-plan-archive-write.js'),{blobStore:api,clone:structuredClone,
      storyboardGalleryRecords:()=>records,getChatKey:()=> 'entry-chat',storyboardSnapshotEpoch:0,storyboardSnapshotCache:new Map(),storyboardSnapshotReads:new Map(),
      sanitizeStoryboardSnapshot:structuredClone,storyboardPackageArchiveAllowed:async()=>true,saveMetadata:async()=>{saves++;},
      storyboardState:()=>state,ctx:()=>({Popup,POPUP_TYPE:{CONFIRM:1}}),normalizeStoryboardShotSpec:value=>value,characterReferenceChoice:()=>'',
      synchronizeStoryboardCaptionBase:()=>{},storyboardRenderInlineImages:()=>{inlineRenders++;},storyboardRedrawRecord:()=>{generations++;},toast:()=>{}});
    const entry=new Function(source+';return {archive:storyboardArchiveGallerySnapshots,store:storyboardStoreSnapshotForRecord,read:storyboardReadSnapshotForRecord,hydrate:storyboardHydrateGallerySnapshots,snapshot:storyboardSnapshotForRecord,edit:storyboardEditPrompt};')();
    check('actual automatic archival stores the returned revision',await entry.archive()===1&&record.snapshotRef!==base&&!record.snapshot&&saves===1);
    const importedRef=record.snapshotRef;storyboardSnapshotCache.clear();
    check('actual reader resolves imported revision after clearing cache',(await entry.read(record)).prompt==='imported prompt');
    check('actual reader still resolves the unchanged legacy reference',(await entry.read({id:'image',chatKey:'entry-chat',snapshotRef:base})).prompt==='old prompt');
    check('actual editor only-save action succeeds',await entry.edit({record})===true);
    const editedRef=record.snapshotRef;
    check('only-save edits point to a new immutable revision',editedRef!==base&&editedRef!==importedRef&&!record.snapshot);
    check('only-save neither generates nor bypasses metadata and inline refresh',generations===0&&saves===2&&inlineRenders===1);
    check('old, imported and edited recipes remain separately readable',(await read(base)).snapshot.prompt==='old prompt'&&(await read(importedRef)).snapshot.prompt==='imported prompt'&&(await read(editedRef)).snapshot.prompt==='user edited prompt');
    check('editing retains non-prompt generation parameters',(await read(editedRef)).snapshot.payload.parameters.steps===28&&(await read(editedRef)).snapshot.profile.seed===0);
    storyboardSnapshotCache.clear();
    const staleRecord={id:'image',chatKey:'entry-chat',snapshotRef:base};let releaseRead;
    window.blobStore={...api,getStoryboardSnapshots:async keys=>{const rows=await api.getStoryboardSnapshots(keys);await new Promise(resolve=>{releaseRead=resolve;});return rows;}};
    const staleRead=entry.read(staleRecord);
    while(!releaseRead)await new Promise(resolve=>setTimeout(resolve,0));
    staleRecord.snapshotRef=editedRef;releaseRead();
    check('a delayed old read cannot revert an edited reference',await staleRead===null&&staleRecord.snapshotRef===editedRef&&!storyboardSnapshotCache.has(base));
    window.blobStore=api;
    storyboardSnapshotCache.clear();
    const legacyRecord={id:'image',chatKey:'entry-chat',snapshotRef:base};
    await entry.hydrate([legacyRecord,record],{migrate:false});
    check('batch rehydration does not confuse legacy and revised recipes',entry.snapshot(legacyRecord).prompt==='old prompt'&&entry.snapshot(record).prompt==='user edited prompt');
    // Return to an older version creates no overwrite and does not grow another archive.
    check('saving an identical old recipe reuses its reference',await entry.store(record,old)===true&&record.snapshotRef===base);
    const nativeDigest=SubtleCrypto.prototype.digest;
    try {
      SubtleCrypto.prototype.digest=function(){return Promise.reject(Error('synthetic digest unavailable'));};
      check('hashing failure leaves a complete inline fallback',await entry.store(record,{...old,prompt:'unsaved archive'})===false&&record.snapshot.prompt==='unsaved archive'&&record.snapshotRef===base);
      check('hashing failure does not modify the old durable archive',(await read(base)).snapshot.prompt==='old prompt');
    } finally {SubtleCrypto.prototype.digest=nativeDigest;}
    record.snapshot={...structuredClone(old),prompt:'metadata retry'};
    window.saveMetadata=async()=>{throw Error('synthetic metadata failure');};
    check('failed metadata save retains the inline retry copy',await entry.archive()===0&&record.snapshot.prompt==='metadata retry');
    window.saveMetadata=async()=>{saves++;};
    check('retry finishes on its already committed revision',await entry.archive()===1&&!record.snapshot&&(await read(record.snapshotRef)).snapshot.prompt==='metadata retry');
    const usage=await api.estimateBlobStoreUsage(),scope=usage.stores.find(row=>row.name==='storyboard_snapshots').scopes.find(row=>row.chatKey==='entry-chat');
    check('existing storage management counts all recipe revisions',scope.count===4&&scope.bytes>0);
    return {checks,base,importedRef,editedRef};
  },['storyboardRecordChatKey','storyboardSnapshotKey','storyboardSnapshotForRecord','storyboardReadSnapshotForRecord',
    'storyboardStoreSnapshotForRecord','storyboardArchiveGallerySnapshots','storyboardHydrateGallerySnapshots','storyboardEditPrompt'].map(section).join('\n'));
  const fresh=await context.newPage();fresh.on('pageerror',error=>errors.push(error.message));await fresh.goto('https://qianmu.test/');
  const prompts=await fresh.evaluate(async keys=>{const api=await import('/qianmu-blobstore.js');return (await api.getStoryboardSnapshots(keys)).map(row=>row.snapshot.prompt);},[result.base,result.importedRef,result.editedRef]);
  assert.deepEqual(prompts,['old prompt','imported prompt','user edited prompt']);result.checks.push('new page reads original and revised recipes from durable storage without caches');
  assert.equal(external,0);assert.deepEqual(errors,[]);console.log(JSON.stringify({nativeIndexedDB:true,checks:result.checks,external,errors}));
} finally {await context.close();await browser.close();}
