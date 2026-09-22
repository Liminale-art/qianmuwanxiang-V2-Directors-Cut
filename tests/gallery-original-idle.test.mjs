import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import {createCurrentGalleryArchiveSession} from '../qianmu-gallery-archive-source.js';
import {createGalleryArchiveStorage} from '../qianmu-gallery-archive-storage.js';
import {createGalleryArchiveCoordinator} from '../qianmu-gallery-archive-coordinator.js';
import {createChatCharacterReceiptService} from '../qianmu-chat-character-receipt-service.js';
import {createGalleryOriginalClient} from '../qianmu-gallery-original-client.js';
import {galleryOriginalHttpFixture,originalPng as png} from './helpers/gallery-original-http-fixture.mjs';
import {streamCheckpointTransport} from './helpers/stream-checkpoint-fixture.mjs';

const gate=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};};
const until=async predicate=>{const end=Date.now()+8000;while(!predicate()){assert.ok(Date.now()<end,'operation did not settle');await new Promise(r=>setTimeout(r,5));}};
const documents=transport=>[...transport.files.values()].map(text=>JSON.parse(text)).filter(row=>row.schema==='qianmu.st-account-document.v1').map(row=>row.value);
async function fixture(t,{count=3,io=fs}={}){
  const f=await galleryOriginalHttpFixture(t,{io}),transport=streamCheckpointTransport(f.account),receipt=createChatCharacterReceiptService({dataRoot:f.root,io});
  const base=structuredClone(f.rows[0]);f.rows.splice(0,f.rows.length,...Array.from({length:count},(_,i)=>({...structuredClone(base),id:'frame-'+i,createdAt:i,url:'/user/images/frame-'+i+'.png'})));
  for(const row of f.rows)await fs.writeFile(path.join(f.images,path.basename(row.url)),png);await f.save();t.after(()=>receipt.close());
  const state={epoch:0,account:f.account,hook:null,calls:[]};
  const fetchImpl=async(url,options)=>{
    state.calls.push({url,options});if(state.hook){const response=await state.hook(url,options);if(response)return response;}
    if(url.startsWith('/api/plugins/qianmu-tts/chat-gallery/original/'))return f.fetch(url,options);
    if(url.endsWith('/chat-gallery/supplement')){
      try{return Response.json(await receipt.readGallerySupplement(f.req,JSON.parse(options.body),{signal:options.signal}));}
      catch(error){return Response.json({ok:false,code:error.code},{status:error.status||400});}
    }
    if(url.endsWith('/chat-gallery/receipt')){
      try{return Response.json(await receipt.inspectGallery(f.req,JSON.parse(options.body),{signal:options.signal}));}
      catch(error){return Response.json({ok:false,code:error.code},{status:error.status||400});}
    }
    if(url.endsWith('/chat-gallery/recipe/read')){
      try{return Response.json(await f.service.read(f.req,JSON.parse(options.body),{signal:options.signal}));}
      catch{return Response.json({ok:false},{status:503});}
    }
    assert.fail('unexpected network request');
  };
  return {...f,transport,state,fetchImpl,
    batches:()=>state.calls.filter(call=>call.url.endsWith('/preserve-batch')),
    copies:()=>documents(transport).filter(value=>value?.schema==='qianmu.gallery.original-copy.v1'),
    async open(options={}){const session=await createCurrentGalleryArchiveSession({getContext:()=>f.context,epoch:()=>state.epoch,account:async()=>state.account,
      fetchImpl,createStorage:transport.createStorage,preserveEvidence:false,...options});t.after(()=>session.close());return session;},
  };
}

test('default idle preservation copies batches server-side, binds every exact record and avoids duplicate record reads',async t=>{
  let headers=0,images=0;const f=await fixture(t,{count:10,io:{...fs,open:(file,...args)=>{
    if(String(file).endsWith('.jsonl'))headers++;if(String(file).endsWith('.png'))images++;return fs.open(file,...args);
  }}}),before=await fs.readFile(f.file),raw=structuredClone(f.rows),session=await f.open();
  assert.equal(f.state.calls.length,0);assert.equal(f.transport.calls.length,0);
  let recordReadsBeforeCopy;const recordReads=()=>f.transport.calls.filter(call=>call.path.includes('-gallery-record-')&&call.options.method!=='POST').length;
  f.state.hook=url=>{if(url.endsWith('/preserve-batch'))recordReadsBeforeCopy??=recordReads();};
  const saved=await session.preserveAll();assert.equal(saved.originals.state,'complete');assert.equal(saved.originals.available,10);assert.equal(saved.originals.preserved,10);
  assert.equal(saved.originals.originalVerified,false);assert.equal(saved.canPrune,false);assert.equal(headers,8);assert.equal(images,10);
  assert.equal(recordReads(),recordReadsBeforeCopy,'staged original sidecars reuse the already verified record');
  assert.deepEqual(f.batches().map(call=>JSON.parse(call.options.body).selections.length),[8,2]);assert.equal(f.copies().length,10);
  assert.deepEqual(f.rows,raw);assert.deepEqual(await fs.readFile(f.file),before);
  for(const call of f.batches()){assert.doesNotMatch(call.options.body,/url|snapshot|prompt|bytes/);assert.equal(call.options.headers.Authorization,undefined);assert.equal(call.options.headers['X-CSRF-Token'],'fixture-only');}
});

test('fresh idle session reuses bound originals without reading missing live images or rewriting sidecars',async t=>{
  const f=await fixture(t),first=await f.open();await first.preserveAll();first.close();
  const files=[...f.transport.files],requests=f.state.calls.filter(call=>call.url.includes('/original/')).length;
  for(const row of f.rows)await fs.unlink(path.join(f.images,path.basename(row.url)));
  const other=await f.open(),saved=await other.preserveAll();assert.equal(saved.originals.state,'complete');assert.equal(saved.originals.available,3);assert.equal(saved.originals.preserved,0);
  assert.equal(f.state.calls.filter(call=>call.url.includes('/original/')).length,requests);assert.deepEqual([...f.transport.files],files);
});

test('appending one image preserves only its new original, keeping older bound copies and recipes',async t=>{
  const f=await fixture(t,{count:2}),first=await f.open();await first.preserveAll();first.close();const before=f.batches().length;
  f.rows.push({...structuredClone(f.rows[0]),id:'appended',createdAt:30,url:'/user/images/appended.png'});await fs.writeFile(path.join(f.images,'appended.png'),png);await f.save();
  const other=await f.open(),saved=await other.preserveAll();assert.equal(saved.originals.available,3);assert.equal(saved.originals.preserved,1);
  assert.deepEqual(f.batches().slice(before).map(call=>JSON.parse(call.options.body).selections.map(row=>row.recordId)),[['appended']]);assert.equal(f.copies().length,3);
});

test('fresh archive reader recovers complete record, server recipe and original after source files are gone',async t=>{
  const f=await fixture(t,{count:1}),client=f.client(),snapshot=structuredClone(f.rows[0].snapshot);
  const recipe=await client.preserve(f.rows[0]);client.close();delete f.rows[0].snapshot;f.rows[0].snapshotServerRef=recipe.reference;await f.save();
  const raw=structuredClone(f.rows[0]),session=await f.open(),saved=await session.preserveAll(),scope={...session.scope};session.close();
  await fs.unlink(f.file);await fs.unlink(path.join(f.images,'frame-0.png'));await fs.unlink(path.join(f.archive,recipe.reference.id+'.json'));
  const fresh=await createGalleryArchiveStorage({scope,guard:()=>true,verifyRecord:()=>false,createStorage:f.transport.createStorage});t.after(()=>fresh.close());
  const reader=await fresh.openSourceVersion(saved.sourceReceipt,saved.supplement),page=await reader.page(),media=await fresh.readMediaRecord(page.rows[0].record);
  assert.deepEqual(media.record,raw);assert.deepEqual((await fresh.readRecipe(page.rows[0].record)).snapshot,snapshot);assert.equal(media.media.state,'available');
  const originals=createGalleryOriginalClient({account:async()=>f.account,headers:()=>({}),fetchImpl:f.fetch});t.after(()=>originals.close());
  assert.deepEqual(Buffer.from(await (await originals.read(media.media.reference)).blob.arrayBuffer()),png);reader.close();
});

test('missing originals keep the complete directory and recipes, stop media attempts and report exact deferred counts',async t=>{
  const f=await fixture(t,{count:10});await fs.unlink(path.join(f.images,'frame-9.png'));
  const session=await f.open(),saved=await session.preserveAll();assert.equal(saved.total,10);assert.equal(saved.originals.state,'partial');
  assert.equal(saved.originals.failed,8);assert.equal(saved.originals.deferred,2);assert.equal(saved.originals.available,0);assert.equal(f.batches().length,1);
  assert.equal(f.copies().length,0);const reader=await session.openSourceVersion(saved.sourceReceipt,saved.supplement),page=await reader.page();assert.equal(page.rows.length,10);
  assert.deepEqual((await session.readRecipe(page.rows[0].record)).snapshot,f.rows[9].snapshot);reader.close();
});

test('old or unavailable media backend does not prevent metadata publication or cause fallback requests',async t=>{
  for(const status of [404,503]){
    const f=await fixture(t,{count:10});f.state.hook=url=>url.includes('/original/')?new Response('unavailable',{status}):undefined;
    const session=await f.open(),saved=await session.preserveAll();assert.equal(saved.originals.state,'partial');assert.equal(saved.originals.failed,8);assert.equal(saved.originals.deferred,2);
    assert.equal(f.state.calls.filter(call=>call.url.includes('/original/')).length,1);assert.equal(f.copies().length,0);
    const reader=await session.openSourceVersion(saved.sourceReceipt,saved.supplement);assert.equal((await reader.page()).rows.length,10);reader.close();
  }
});

test('non-native or unsupported originals remain explicit gaps and are never fetched',async t=>{
  const f=await fixture(t,{count:4});f.rows[0].url='https://outside.invalid/private.png';f.rows[1].url='data:image/png;base64,AA==';f.rows[2].url='user/images/frame-2.png';await f.save();
  const session=await f.open(),saved=await session.preserveAll();assert.equal(saved.originals.available,1);assert.equal(saved.originals.skipped,3);assert.equal(saved.originals.state,'partial');
  assert.deepEqual(JSON.parse(f.batches()[0].options.body).selections.map(row=>row.recordId),['frame-3']);assert.equal(saved.total,4);
  assert.ok(f.state.calls.every(call=>call.url.startsWith('/api/plugins/')));
});

test('corrupt original sidecar is retained without recopying or blocking other records',async t=>{
  const f=await fixture(t),first=await f.open();await first.preserveAll();first.close();
  const entry=[...f.transport.files].find(([name,text])=>name.includes('-gallery-original-')&&JSON.parse(text).schema==='qianmu.st-account-document.v1');
  const corrupted=JSON.parse(entry[1]);corrupted.value.source.reference.bytes++;f.transport.files.set(entry[0],JSON.stringify(corrupted));
  const files=[...f.transport.files],before=f.batches().length,other=await f.open(),saved=await other.preserveAll();
  assert.equal(saved.originals.state,'partial');assert.equal(saved.originals.failed,1);assert.equal(saved.originals.available,2);assert.equal(f.batches().length,before);assert.deepEqual([...f.transport.files],files);
});

test('one sidecar upload failure leaves its original intact and permits remaining sidecars plus directory',async t=>{
  const f=await fixture(t);let failed=false;
  f.transport.hook=({path,options,json})=>{if(!failed&&path==='/api/files/upload'&&JSON.parse(options.body).name.includes('-gallery-original-')){failed=true;return json({},503);}};
  const session=await f.open(),saved=await session.preserveAll();assert.equal(failed,true);assert.equal(saved.originals.failed,1);assert.equal(saved.originals.available,2);assert.equal(saved.originals.state,'partial');
  const reader=await session.openSourceVersion(saved.sourceReceipt,saved.supplement);assert.equal((await reader.page()).rows.length,3);reader.close();
  for(const row of f.rows)assert.deepEqual(await fs.readFile(path.join(f.images,path.basename(row.url))),png);
});

test('partial backend batch result never publishes original references but preserves the full metadata directory',async t=>{
  const f=await fixture(t);f.state.hook=async(url,options)=>{
    if(!url.endsWith('/preserve-batch'))return;const result=await (await f.fetch(url,options)).json();result.records.pop();return Response.json(result);
  };
  const session=await f.open(),saved=await session.preserveAll();assert.equal(saved.originals.available,0);assert.equal(saved.originals.failed,3);assert.equal(f.copies().length,0);
  const reader=await session.openSourceVersion(saved.sourceReceipt,saved.supplement);assert.equal((await reader.page()).rows.length,3);reader.close();
});

test('close or chat-epoch change during a late original response cannot publish a stale reference or success',{timeout:15000},async t=>{
  for(const mode of ['close','epoch']){
    const f=await fixture(t),entered=gate(),release=gate();t.after(()=>release.resolve());
    f.state.hook=async(url,options)=>{if(!url.endsWith('/preserve-batch'))return;const response=await f.fetch(url,options);entered.resolve();await release.promise;return response;};
    const session=await f.open(),task=session.preserveAll();void task.catch(()=>{});await entered.promise;
    if(mode==='close')session.close();else f.state.epoch++;release.resolve();await assert.rejects(task);assert.equal(f.copies().length,0);
    assert.ok(![...f.transport.files.keys()].some(name=>name.includes('-gallery-source-')));
  }
});

test('live record edit during original response invalidates the pass rather than being swallowed as a media gap',async t=>{
  const f=await fixture(t);f.state.hook=async(url,options)=>{
    if(!url.endsWith('/preserve-batch'))return;const response=await f.fetch(url,options);f.rows[0].unknown='edited';return response;
  };
  const session=await f.open();await assert.rejects(session.preserveAll(),/已修改|会话已结束/);assert.equal(f.copies().length,0);
  assert.ok(![...f.transport.files.keys()].some(name=>name.includes('-gallery-source-')));
});

test('actual idle coordinator marks partial media without retries, resumes on a real trigger, then skips unchanged success',async t=>{
  const f=await fixture(t),document=new EventTarget(),errors=[];document.hidden=false;document.readyState='complete';let opened=0;
  f.state.hook=url=>url.includes('/original/')?new Response('old',{status:404}):undefined;
  const c=createGalleryArchiveCoordinator({getContext:()=>f.context,epoch:()=>f.state.epoch,account:async()=>f.state.account,isCurrent:()=>true,window:globalThis,document,quietMs:1,
    connect:async options=>{opened++;return f.open(options);},onError:error=>errors.push(error)});t.after(()=>c.close());
  c.schedule();await until(()=>c.status().state==='partial');assert.deepEqual(errors,[{code:'gallery_originals_incomplete',writeState:'records_saved'}]);
  const requests=f.state.calls.length;await new Promise(r=>setTimeout(r,25));assert.equal(f.state.calls.length,requests);assert.equal(c.status().pending,false);
  f.state.hook=null;c.schedule();await until(()=>c.status().state==='saved');assert.equal(f.copies().length,3);
  const originals=f.batches().length,postCount=f.transport.calls.filter(call=>call.options.method==='POST').length;
  c.schedule();await until(()=>opened===3&&!c.status().running);assert.equal(f.batches().length,originals);assert.equal(f.transport.calls.filter(call=>call.options.method==='POST').length,postCount);
});

test('staged-original helpers reject stale pages and aborted reads before additional storage I/O',async t=>{
  const f=await fixture(t,{count:2}),session=await f.open(),archive=await createGalleryArchiveStorage({scope:session.scope,guard:()=>true,verifyRecord:()=>true,createStorage:f.transport.createStorage});t.after(()=>archive.close());
  const page=await archive.stagePage([...f.rows].reverse()),old=page.records.find(row=>row.recordId==='frame-0').reference;
  const proof=await (await f.request('preserve',f.input())).json();await archive.stagePage([f.rows[1]]);
  const before=f.transport.calls.length;await assert.rejects(archive.readStagedOriginal(old),/当前已保全批次/);
  await assert.rejects(archive.preserveStagedOriginalReference(old,proof),/当前已保全批次/);assert.equal(f.transport.calls.length,before);
  const current=page.records.find(row=>row.recordId==='frame-1').reference,controller=new AbortController();controller.abort();
  await assert.rejects(archive.readStagedOriginal(current,{signal:controller.signal}),/取消/);assert.equal(f.transport.calls.length,before);
});

test('idle work yields after one media batch and an epoch change prevents the next batch or sidecar',{timeout:15000},async t=>{
  const f=await fixture(t,{count:10}),entered=gate(),release=gate();let firstDone=false,held=false;t.after(()=>release.resolve());
  f.state.hook=async(url,options)=>{if(!url.endsWith('/preserve-batch'))return;const result=await f.fetch(url,options);firstDone=true;return result;};
  const session=await f.open({yieldWork:async()=>{if(firstDone&&!held){held=true;entered.resolve();await release.promise;}}}),task=session.preserveAll();void task.catch(()=>{});
  await entered.promise;assert.equal(f.batches().length,1);assert.equal(f.copies().length,0);f.state.epoch++;release.resolve();await assert.rejects(task);
  assert.equal(f.batches().length,1);assert.equal(f.copies().length,0);
});

test('account switch during media response cannot become a successful partial directory in another account',async t=>{
  const f=await fixture(t);f.state.hook=async(url,options)=>{
    if(!url.endsWith('/preserve-batch'))return;const result=await f.fetch(url,options);f.state.account='st-user:bob';f.transport.namespace='st-user:bob';return result;
  };
  const session=await f.open();await assert.rejects(session.preserveAll());assert.equal(f.copies().length,0);
  assert.ok(![...f.transport.files.keys()].some(name=>name.includes('-gallery-source-')));
});
