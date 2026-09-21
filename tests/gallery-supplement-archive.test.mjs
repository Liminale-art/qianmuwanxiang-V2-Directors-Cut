import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import {galleryDiscoveryFixture} from './helpers/gallery-discovery-fixture.mjs';
import {createChatCharacterReceiptService} from '../qianmu-chat-character-receipt-service.js';
import {createCurrentGalleryArchiveSession} from '../qianmu-gallery-archive-source.js';
import {createGalleryArchiveStorage} from '../qianmu-gallery-archive-storage.js';
import {createGalleryArchiveBrowser} from '../qianmu-gallery-archive-browser.js';
import {createGalleryDiscoveryClient} from '../qianmu-gallery-discovery-client.js';
import {createGalleryArchiveCoordinator} from '../qianmu-gallery-archive-coordinator.js';
import {createGallerySupplementStorage,captureGallerySupplement} from '../qianmu-gallery-archive-supplement.js';
import {galleryArchiveSourceSlot,galleryArchiveSourceVersion} from '../qianmu-gallery-archive-version.js';
import {emptyChatCharacterCollection} from '../qianmu-character-chat-batch.js';
import {chatGalleryDigest} from '../qianmu-chat-gallery-digest.js';
import {imageServiceAccount} from '../qianmu-image-service-access.js';

const documents=f=>[...f.transport.files.values()].map(JSON.parse).filter(row=>row.schema==='qianmu.st-account-document.v1').map(row=>row.value);
const versions=f=>documents(f).filter(row=>/^qianmu\.gallery\.source-version\./.test(row.schema));
const gate=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};};
const until=async predicate=>{const end=Date.now()+10000;while(!predicate()){assert.ok(Date.now()<end);await new Promise(r=>setTimeout(r,5));}};
async function fixture(t){
  const f=await galleryDiscoveryFixture(t),service=createChatCharacterReceiptService({dataRoot:f.host.root});t.after(()=>service.close());
  const store=f.host.context.chatMetadata.story_director_liminale;store.storyboardCollections=[{id:'album',name:'Original',future:{zero:0,keep:['',false,null]}}];
  store.characterDrafts=emptyChatCharacterCollection({namespace:f.host.account,chatKey:'chat'});store.characterDrafts.future={note:' keep exact '};await f.host.save();
  const scope={namespace:f.host.account,ownerKey:'char:Alice.png',chatKey:'chat'},state={calls:[],hook:null};
  const fetchImpl=async(url,options)=>{
    state.calls.push({url,options});if(state.hook){const reply=await state.hook(url,options);if(reply)return reply;}
    try{
      if(url.endsWith('/gallery-archive/versions'))return Response.json(await f.service.list(f.host.req,JSON.parse(options.body),{signal:options.signal}));
      const method=url.endsWith('/supplement')?'readGallerySupplement':'inspectGallery';
      assert.ok(url.endsWith('/supplement')||url.endsWith('/receipt'));return Response.json(await service[method](f.host.req,JSON.parse(options.body),{signal:options.signal}));
    }catch(error){return Response.json({ok:false,code:error.code},{status:error.status||409});}
  };
  return {...f,store,scope,state,service,discovery:f.service,fetchImpl,
    // Isolate supplement behavior here; default-on original+supplement wiring
    // together is exercised by gallery-original-idle with actual local HTTP.
    async open(options={}){const session=await createCurrentGalleryArchiveSession({getContext:()=>f.host.context,epoch:()=>f.host.epoch,account:async()=>f.host.account,
      fetchImpl,createStorage:f.transport.createStorage,preserveOriginals:false,...options});t.after(()=>session.close());return session;},
    async reader(){const reader=await createGalleryArchiveStorage({scope,guard:()=>true,verifyRecord:()=>false,createStorage:f.transport.createStorage});t.after(()=>reader.close());return reader;},
    request(){return {version:1,expectedAccount:imageServiceAccount(f.host.req).namespace,target:{kind:'character',avatar:'Alice.png',chatId:'chat'},gallerySha256:chatGalleryDigest(f.host.rows).sha256};},
    browser(){const browser=createGalleryArchiveBrowser({account:async()=>f.host.account,headers:()=>({}),
      createDiscovery:options=>createGalleryDiscoveryClient({...options,fetchImpl}),createArchive:options=>createGalleryArchiveStorage({...options,createStorage:f.transport.createStorage})});t.after(()=>browser.close());return browser;},
  };
}

test('large-gallery idle preservation discovers and independently reads exact supplements after original chat deletion',async t=>{
  const f=await fixture(t);f.host.rows=[4,1,9,2,7,0].map(i=>({id:'r'+i,createdAt:i,url:'/user/images/f.png',future:'x'.repeat(450000)}));await f.host.save();
  const raw=await fs.readFile(f.host.file),session=await f.open();assert.equal(f.state.calls.length,0);const saved=await session.preserveAll();
  assert.ok(saved.sourceReceipt.bytes>2*1048576);assert.equal(saved.supplements.state,'complete');assert.equal(versions(f).length,1);assert.equal(versions(f)[0].schema,'qianmu.gallery.source-version.v2');
  assert.deepEqual(await fs.readFile(f.host.file),raw);session.close();await f.flush();await fs.unlink(f.host.file);
  const browser=f.browser(),list=await browser.list(),reads=f.transport.calls.length;assert.equal(list.entries.length,1);assert.equal(f.transport.calls.length,reads);
  await browser.open(list.entries[0].key);assert.ok(!f.transport.calls.slice(reads).some(call=>call.path.includes('-gallery-supplement-')),'opening a directory does not preload supplement bodies');
  const recovered=await browser.supplement();assert.equal(recovered.state,'available');assert.equal(recovered.canPrune,false);assert.equal(recovered.originalVerified,false);
  assert.deepEqual(recovered.receipt.order,['r4','r1','r9','r2','r7','r0']);assert.deepEqual(recovered.receipt.saved,{storyboardCollections:f.store.storyboardCollections,characterDrafts:f.store.characterDrafts});
  const page=await browser.page();assert.deepEqual(page.rows.map(row=>row.recordId),['r9','r7','r4','r2','r1','r0']);
  const reader=await f.reader();for(const row of page.rows)assert.equal((await reader.readRecord(row.record)).record.future.length,450000);
  assert.equal(f.state.calls.filter(c=>c.url.endsWith('/supplement')).length,2);assert.ok(f.opened.every(name=>name.includes('-gallery-source2-')),'discovery reads only small version descriptors');
});

test('same images with edited, empty and missing companions retain separate immutable versions without rewriting record bodies',async t=>{
  const f=await fixture(t),saved=[],ids=[];
  for(const change of [()=>{},()=>{f.store.storyboardCollections[0].name='Edited';},()=>{f.store.storyboardCollections=[];},()=>{delete f.store.storyboardCollections;delete f.store.characterDrafts;}]){
    change();await f.host.save();const s=await f.open();ids.push(s.identity);saved.push(await s.preserveAll());s.close();
  }
  assert.equal(new Set(ids).size,4);assert.equal(new Set(saved.map(s=>s.supplement.sha256)).size,4);assert.equal(new Set(saved.map(s=>s.sourceReceipt.sha256)).size,1);
  assert.equal(versions(f).length,4);assert.equal(documents(f).filter(v=>v.schema==='qianmu.gallery.record.v1').length,1);
  const reader=await f.reader(),states=[];for(const s of saved)states.push((await reader.readSupplement(s.supplement)).receipt.saved);
  assert.equal(states[0].storyboardCollections[0].name,'Original');assert.equal(states[1].storyboardCollections[0].name,'Edited');assert.deepEqual(states[2].storyboardCollections,[]);assert.deepEqual(states[3],{});
  const before=[...f.transport.files],s=await f.open();assert.deepEqual((await s.preserveAll()).supplement,saved.at(-1).supplement);assert.deepEqual([...f.transport.files],before);
});

test('local unsaved companions produce an explicit partial result and no guessed supplement, then succeed only after real save',async t=>{
  const f=await fixture(t);f.store.storyboardCollections[0].name='Unsaved';const s=await f.open(),result=await s.preserveAll();s.close();
  assert.equal(result.supplements.state,'partial');assert.equal(result.supplements.proof,'not-confirmed');assert.equal(result.supplement,undefined);assert.equal(versions(f)[0].schema,'qianmu.gallery.source-version.v1');
  assert.equal(documents(f).filter(v=>v.schema==='qianmu.gallery.supplement.v1').length,0);assert.equal(f.state.calls.filter(c=>c.url.endsWith('/supplement')).length,1);
  await f.host.save();const next=await f.open();assert.equal((await next.preserveAll()).supplements.state,'complete');assert.equal(versions(f).length,2);
});

test('old supplement backend preserves metadata directory and issues no fallback or repeated request',async t=>{
  const f=await fixture(t);f.state.hook=url=>url.endsWith('/supplement')?new Response('old',{status:404}):undefined;
  const s=await f.open(),result=await s.preserveAll();assert.equal(result.total,1);assert.equal(result.supplements.state,'partial');
  assert.equal(f.state.calls.filter(c=>c.url.endsWith('/supplement')).length,1);assert.ok(f.state.calls.every(c=>c.url.endsWith('/supplement')||c.url.endsWith('/receipt')));
  const reader=await s.openSourceVersion(result.sourceReceipt);assert.equal((await reader.page()).rows.length,1);reader.close();
});

test('server companion change during upload retains the copy but never publishes a mixed supplemented version',async t=>{
  const f=await fixture(t);let changed=false;
  f.transport.hook=async({path,options})=>{if(path==='/api/files/upload'&&!changed&&JSON.parse(options.body).name.includes('-gallery-supplement-')){
    changed=true;const metadata=structuredClone(f.host.context.chatMetadata);metadata.story_director_liminale.storyboardCollections[0].name='Remote edit';await fs.writeFile(f.host.file,JSON.stringify({chat_metadata:metadata})+'\n');
  }};
  const s=await f.open(),result=await s.preserveAll();assert.equal(changed,true);assert.equal(result.supplements.state,'partial');assert.equal(versions(f)[0].schema,'qianmu.gallery.source-version.v1');
  assert.equal(documents(f).filter(v=>v.schema==='qianmu.gallery.supplement.v1').length,1);assert.equal(f.store.storyboardCollections[0].name,'Original');
});

test('local companion edit or account switch during upload cannot be swallowed as a harmless partial gap',async t=>{
  for(const mutate of [f=>{f.store.storyboardCollections[0].name='Live edit';},f=>{f.host.epoch++;},f=>{f.host.account='st-user:bob';f.transport.namespace='st-user:bob';}]){
    const f=await fixture(t);let changed=false;f.transport.hook=({path,options})=>{if(path==='/api/files/upload'&&!changed&&JSON.parse(options.body).name.includes('-gallery-supplement-')){changed=true;mutate(f);}};
    const s=await f.open();await assert.rejects(s.preserveAll());assert.equal(changed,true);assert.equal(versions(f).length,0);
  }
});

test('failed supplement upload keeps full record directory without rewriting or deleting originals',async t=>{
  const f=await fixture(t),before=await fs.readFile(f.host.file);f.transport.hook=({path,options,json})=>path==='/api/files/upload'&&JSON.parse(options.body).name.includes('-gallery-supplement-')?json({},503):undefined;
  const s=await f.open(),result=await s.preserveAll();assert.equal(result.supplements.state,'partial');assert.equal(result.total,1);assert.equal(versions(f).length,1);assert.deepEqual(await fs.readFile(f.host.file),before);
  assert.ok(f.transport.calls.every(c=>c.options.method!=='DELETE'));
});

test('corrupt existing supplement stays untouched and is not silently recreated from the still-available chat',async t=>{
  const f=await fixture(t),first=await f.open();await first.preserveAll();first.close();
  const [name,text]=[...f.transport.files].find(([name,text])=>name.includes('-gallery-supplement-')&&JSON.parse(text).schema==='qianmu.st-account-document.v1');
  const bad=JSON.parse(text);bad.value.receipt.saved.storyboardCollections[0].name='corrupt';f.transport.files.set(name,JSON.stringify(bad));const uploads=f.transport.calls.filter(c=>c.path==='/api/files/upload').length;
  const next=await f.open(),result=await next.preserveAll();assert.equal(result.supplements.state,'partial');assert.equal(f.transport.files.get(name),JSON.stringify(bad));
  assert.equal(f.transport.calls.slice().filter(c=>c.path==='/api/files/upload'&&JSON.parse(c.options.body).name.includes('-gallery-supplement-')).length,2);
  assert.ok(f.transport.calls.filter(c=>c.path==='/api/files/upload').length>=uploads);
});

test('closed session rejects a late supplement response without creating its body or a version',async t=>{
  const f=await fixture(t),entered=gate(),release=gate();f.state.hook=async(url,options)=>{if(!url.endsWith('/supplement'))return;
    const result=await f.service.readGallerySupplement(f.host.req,JSON.parse(options.body));entered.resolve();await release.promise;return Response.json(result);};
  const s=await f.open(),pending=s.preserveAll();await entered.promise;s.close();release.resolve();await assert.rejects(pending);assert.equal(versions(f).length,0);
  assert.equal(documents(f).filter(v=>v.schema==='qianmu.gallery.supplement.v1').length,0);
});

test('supplement capture rejects getters, holes, unsafe fields and lossy scalars before native I/O',async t=>{
  const f=await fixture(t);let calls=0;const getter={get field(){calls++;return 1;}};
  for(const bad of [getter,[,1],{value:undefined},{value:NaN},{value:'\ud800'},JSON.parse('{"__proto__":{}}')])assert.throws(()=>captureGallerySupplement(bad));
  assert.equal(calls,0);assert.equal(f.transport.calls.length,0);
  const storage=await createGallerySupplementStorage({scope:f.scope,guard:()=>true,createStorage:f.transport.createStorage});t.after(()=>storage.close());
  const response=await f.service.readGallerySupplement(f.host.req,f.request());await assert.rejects(storage.preserve(response,{verify:()=>false}));assert.equal(f.transport.calls.length,0);
});

test('large Unicode order is independently stored beyond the image-page budget and read back with no clipping',async t=>{
  const f=await fixture(t);f.host.rows=Array.from({length:3100},(_,i)=>({id:'字'.repeat(234)+'-'+String(i).padStart(5,'0'),createdAt:i}));await f.host.save();
  const response=await f.service.readGallerySupplement(f.host.req,f.request()),storage=await createGallerySupplementStorage({scope:f.scope,guard:()=>true,createStorage:f.transport.createStorage});
  t.after(()=>storage.close());const saved=await storage.preserve(response,{verify:()=>true});assert.ok(saved.reference.bytes>2*1048576);
  const read=await storage.read(saved.reference);assert.deepEqual(read.value.receipt.order,response.order);assert.equal(read.value.receipt.order.length,3100);
});

test('published versions bind supplement and manifest; foreign, unstaged and swapped selectors fail',async t=>{
  const f=await fixture(t),s=await f.open(),saved=await s.preserveAll(),reader=await f.reader();
  await assert.rejects(reader.openSourceVersion(saved.sourceReceipt));await assert.rejects(reader.openSourceVersion(saved.sourceReceipt,{...saved.supplement,sha256:'0'.repeat(64)}));
  const version=versions(f)[0],key=await galleryArchiveSourceSlot(f.scope,saved.sourceReceipt,saved.supplement);assert.ok(key.startsWith('gallery-source2-'));assert.deepEqual(galleryArchiveSourceVersion(version,f.scope,saved.sourceReceipt),version);
  const response=await f.service.readGallerySupplement(f.host.req,f.request());
  const writer=await createGalleryArchiveStorage({scope:f.scope,guard:()=>true,verifyRecord:()=>true,verifySupplement:()=>true,createStorage:f.transport.createStorage});t.after(()=>writer.close());
  const staged=await writer.stagePage(f.host.rows);await assert.rejects(writer.publishSourceVersion(saved.sourceReceipt,[staged.descriptor],saved.supplement),/本次保全/);
  const foreign=await createGallerySupplementStorage({scope:{...f.scope,ownerKey:'char:Other.png'},guard:()=>true,createStorage:f.transport.createStorage});t.after(()=>foreign.close());
  await assert.rejects(foreign.preserve(response,{verify:()=>true}),/所选聊天/);
});

test('idle coordinator retries only on a real event and includes changed companions in success identity',async t=>{
  const f=await fixture(t),errors=[];let connections=0;
  const c=createGalleryArchiveCoordinator({getContext:()=>f.host.context,epoch:()=>f.host.epoch,account:async()=>f.host.account,isCurrent:()=>true,quietMs:5,
    window:{setTimeout,clearTimeout,navigator:{onLine:true},addEventListener(){},removeEventListener(){}},document:{readyState:'complete',addEventListener(){},removeEventListener(){}},
    connect:async options=>{connections++;return f.open(options);},onError:error=>errors.push(error)});t.after(()=>c.close());
  f.state.hook=url=>url.endsWith('/supplement')?new Response('old',{status:404}):undefined;c.schedule();await until(()=>c.status().state==='partial');
  assert.deepEqual(errors,[{code:'gallery_supplements_incomplete',writeState:'records_saved'}]);const calls=f.state.calls.length;await new Promise(r=>setTimeout(r,30));assert.equal(f.state.calls.length,calls);
  f.state.hook=null;c.schedule();await until(()=>c.status().state==='saved');const before=f.state.calls.length;c.schedule();await until(()=>connections===3&&!c.status().running&&!c.status().pending);assert.equal(f.state.calls.length,before);
  f.store.storyboardCollections[0].name='Edited after success';await f.host.save();c.schedule();await until(()=>connections===4&&c.status().state==='saved');assert.equal(versions(f).length,3);
});

test('legacy discovery ignores new directories while v2 paginates mixed versions without reading supplement bodies',async t=>{
  const f=await fixture(t);await f.add(8);const s=await f.open();await s.preserveAll();s.close();f.store.storyboardCollections[0].name='Later';await f.host.save();const later=await f.open();await later.preserveAll();await f.flush();
  const legacy=await f.discovery.list(f.host.req,f.input());assert.equal(legacy.version,1);assert.equal(legacy.entries.length,1);assert.equal(legacy.entries[0].value.schema,'qianmu.gallery.source-version.v1');
  const all=[];let cursor=null;do{const page=await f.discovery.list(f.host.req,f.input({version:2,limit:1,cursor}));all.push(...page.entries);cursor=page.nextCursor;
    if(cursor)await assert.rejects(f.discovery.list(f.host.req,f.input({cursor})),/续页/);
  }while(cursor);assert.equal(all.length,3);assert.equal(new Set(all.map(e=>e.key)).size,3);assert.ok(f.opened.every(name=>/-gallery-source2?-/.test(name)));
  // A malformed future body cannot break the legacy directory on rollback.
  const body=[...f.transport.files].find(([name,text])=>name.includes('-gallery-source2-')&&JSON.parse(text).schema==='qianmu.st-account-document.v1');
  await fs.writeFile(path.join(f.folder,body[0]),'broken');
  assert.equal((await f.discovery.list(f.host.req,f.input())).entries.length,1);await assert.rejects(f.discovery.list(f.host.req,f.input({version:2,limit:32})));
});

test('old discovery backend rejects capability v2 explicitly with no retry or false empty result',async t=>{
  let calls=0;const client=createGalleryDiscoveryClient({account:async()=> 'st-user:alice',headers:()=>({}),fetchImpl:async()=>{calls++;return Response.json({ok:false,code:'gallery_discovery_contract'},{status:400});}});t.after(()=>client.close());
  await assert.rejects(client.list(),error=>error.serviceCode==='gallery_discovery_unsupported');assert.equal(calls,1);
});

test('empty gallery with real companion fields is still preserved by the idle coordinator',async t=>{
  const f=await fixture(t);f.host.rows=[];await f.host.save();
  const c=createGalleryArchiveCoordinator({getContext:()=>f.host.context,epoch:()=>f.host.epoch,account:async()=>f.host.account,isCurrent:()=>true,quietMs:5,
    window:{setTimeout,clearTimeout,navigator:{onLine:true},addEventListener(){},removeEventListener(){}},document:{readyState:'complete',addEventListener(){},removeEventListener(){}},connect:options=>f.open(options)});t.after(()=>c.close());
  c.schedule();await until(()=>c.status().state==='saved');assert.equal(versions(f).length,1);assert.equal(versions(f)[0].sourceReceipt.count,0);
  const reader=await f.reader(),read=await reader.readSupplement(versions(f)[0].supplement);assert.deepEqual(read.receipt.order,[]);assert.equal(read.receipt.saved.storyboardCollections[0].name,'Original');
});

test('async supplement guards are rejected without unhandled background rejections or writes',async t=>{
  const f=await fixture(t);await assert.rejects(createGallerySupplementStorage({scope:f.scope,guard:async()=>{throw Error('late');},createStorage:f.transport.createStorage}));
  await new Promise(r=>setImmediate(r));assert.equal(f.transport.calls.length,0);
});
