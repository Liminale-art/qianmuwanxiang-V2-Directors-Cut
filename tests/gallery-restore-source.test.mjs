import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {chatEvidenceFixture,sha} from './helpers/chat-evidence-fixture.mjs';
import {streamCheckpointTransport} from './helpers/stream-checkpoint-fixture.mjs';
import {createGalleryArchiveStorage} from '../qianmu-gallery-archive-storage.js';
import {createGalleryRestoreSource} from '../qianmu-gallery-restore-source.js';
import {createGalleryArchiveBrowser} from '../qianmu-gallery-archive-browser.js';
import {createGalleryDiscoveryService} from '../qianmu-gallery-discovery-service.js';
import {createGalleryDiscoveryClient} from '../qianmu-gallery-discovery-client.js';
import {chatGalleryDigest} from '../qianmu-chat-gallery-digest.js';
import {recipeArchiveEnvelope} from '../qianmu-recipe-archive-contract.js';
import {emptyChatCharacterCollection} from '../qianmu-character-chat-batch.js';
const scope={namespace:'st-user:alice',ownerKey:'char:Alice.png',chatKey:'chat-one'};
const recipe=()=>({source:'nai',prompt:'original prompt',negative:'',profile:{},payload:{},future:{exact:[null,false,0,'']}});
const gate=()=>{let resolve;return {promise:new Promise(done=>resolve=done),resolve};};
async function fixture(t,{count=3,large=false}={}){
  const host=await chatEvidenceFixture(t),transport=streamCheckpointTransport(scope.namespace),state={current:true,namespace:scope.namespace};
  host.rows.splice(0,host.rows.length,...Array.from({length:count},(_,i)=>({id:'r'+i,createdAt:i,url:'/user/images/r.png',tags:['tag'],future:{untouched:large?'x'.repeat(450000):[null,0,false]},snapshot:recipe()})).reverse());
  if(count>=3){[host.rows[0],host.rows[1]]=[host.rows[1],host.rows[0]];delete host.rows[2].snapshot;}
  const saved={storyboardCollections:[{id:'album',name:'原合集',future:false}],characterDrafts:emptyChatCharacterCollection({namespace:scope.namespace,chatKey:scope.chatKey})};saved.characterDrafts.future={keep:0};
  let server;
  if(count>=2){
    const record=host.rows[1],snapshot=record.snapshot,envelope=recipeArchiveEnvelope({version:1,expectedAccount:'st-user:'+sha('alice'),source:{target:host.target,recordId:record.id,createdAt:record.createdAt},snapshot});
    delete record.snapshot;record.snapshotServerRef={version:1,id:sha(envelope.text)+'-'+randomUUID(),sha256:sha(envelope.text),bytes:Buffer.byteLength(envelope.text)};
    server={record,snapshot};
  }
  await host.write({header:{chat_metadata:{story_director_liminale:{storyboardImages:host.rows,...saved}}}});
  const request={version:1,expectedAccount:'st-user:'+sha('alice'),target:host.target,gallerySha256:chatGalleryDigest(host.rows).sha256};
  const companion=await host.service.readGallerySupplement(host.req,request),body=await host.service.readGalleryEvidenceSource(host.req,request);
  const create=async extra=>{const archive=await createGalleryArchiveStorage({scope,guard:()=>state.current,verifyRecord:()=>true,verifySupplement:()=>true,verifyEvidence:()=>true,createStorage:transport.createStorage,...extra});t.after(()=>archive.close());return archive;};
  const archive=await create(),ordered=[...host.rows].sort((a,b)=>b.createdAt-a.createdAt),descriptors=[];
  const batch=large?2:128;for(let offset=0;offset<ordered.length;offset+=batch)descriptors.push((await archive.stagePage(ordered.slice(offset,offset+batch))).descriptor);
  if(server)await archive.preserveServerRecipe(server.record,{ok:true,version:1,expectedAccount:request.expectedAccount,target:host.target,
    selection:{recordId:server.record.id,createdAt:server.record.createdAt,gallerySha256:request.gallerySha256},reference:server.record.snapshotServerRef,snapshot:server.snapshot,origin:'server-archive',proof:'read-only-recipe'});
  if(count){const record=host.rows[0],digest=sha('fake image');await archive.preserveOriginalReference(record,{version:1,expectedAccount:request.expectedAccount,target:host.target,
    selection:{recordId:record.id,createdAt:record.createdAt,gallerySha256:request.gallerySha256},reference:{version:1,id:digest+'-'+randomUUID(),sha256:digest,bytes:10,mime:'image/png'},
    original:{url:record.url,sha256:digest,bytes:10,mime:'image/png'},proof:'original-copy-readback',persistence:'st-account-file',originalVerified:true,canPrune:false});}
  const supplement=(await archive.preserveSupplement(companion)).reference,evidence=(await archive.preserveEvidence(body,supplement)).reference;
  const sourceReceipt={...chatGalleryDigest(host.rows),proof:'read-only-snapshot'},version=await archive.publishSourceVersion(sourceReceipt,descriptors,supplement,evidence);
  const selection={schema:'qianmu.gallery.source-version.v3',scope,sourceReceipt,manifest:version.reference,supplement,evidence};
  return {host,transport,state,saved,archive,selection,server,create,
    async source(extra={}){const s=await createGalleryRestoreSource({selection,archive,guard:async()=>state.current,...extra});t.after(()=>s.close());return s;},
    async browser(){
      const folder=path.join(host.user,'files');await fs.mkdir(folder);host.req.user.directories.files=folder;
      for(const [name,text] of transport.files)await fs.writeFile(path.join(folder,name),text);
      const discovery=createGalleryDiscoveryService({dataRoot:host.root});t.after(()=>discovery.close());
      const browser=createGalleryArchiveBrowser({account:async()=>state.namespace,headers:()=>({}),isCurrent:()=>state.current,
        createArchive:options=>create({...options}),createDiscovery:options=>createGalleryDiscoveryClient({...options,fetchImpl:async(url,options)=>{
          assert.ok(url.endsWith('/gallery-archive/versions'));return Response.json(await discovery.list(host.req,JSON.parse(options.body),{signal:options.signal}));}}),
        createOriginal:()=>{throw Error('review must not fetch image bytes');},loadImage:()=>{throw Error('review must not load original URL');}});t.after(()=>browser.close());return browser;
    },
  };
}

test('independent source follows original order, preserves unknown companion fields and reads once per record without original chat',async t=>{
  const f=await fixture(t);await fs.unlink(f.host.file);const before=f.transport.calls.length,s=await f.source();
  assert.ok(f.transport.calls.slice(before).every(c=>!c.path.includes('-gallery-record-')),'opening only loads small indices and companions');
  const received=[],progress=[],result=await s.scan({visit:item=>received.push(item),onProgress:p=>progress.push(p)});
  assert.deepEqual(received.map(v=>v.record),f.host.rows);assert.deepEqual(received.map(v=>v.index),[0,1,2]);assert.equal(result.galleryVerified,true);
  assert.deepEqual(result.recipes,{available:2,missing:1});assert.deepEqual(result.originals,{referenced:1,missing:2});assert.equal(result.originalVerified,false);assert.equal(result.restoreReady,false);assert.equal(result.canPrune,false);
  assert.deepEqual((await s.metadata()).supplement.saved,f.saved);assert.equal(result.evidenceFloors,2);assert.deepEqual(progress.at(-1),{completed:3,total:3});
  assert.ok(f.transport.calls.slice(before).every(c=>c.options.method!=='POST'));
  const recordReads=f.transport.calls.slice(before).filter(c=>c.path.includes('-gallery-record-'));assert.equal(recordReads.length,6,'one head/body pair per record, not three independent reads');
});

test('browser exposes an explicit read-only restore review without preloading on directory opening or losing current page',async t=>{
  const f=await fixture(t),browser=await f.browser();await fs.unlink(f.host.file);const list=await browser.list();await browser.open(list.entries[0].key);const page=await browser.page();
  const start=f.transport.calls.length,result=await browser.review();assert.equal(result.total,3);assert.equal(result.recipes.available,2);assert.equal(result.originalVerified,false);
  assert.ok(f.transport.calls.slice(start).every(c=>c.options.method!=='POST'));assert.equal((await browser.recipe(page.rows[0].recordId)).state,'available');
  f.state.namespace='st-user:other';await assert.rejects(browser.review(),/账户/);assert.equal(browser.isClosed(),true);
});

test('more than 400 records are fully streamed without copying all record bodies into the source',async t=>{
  const f=await fixture(t,{count:451}),s=await f.source();let count=0;const result=await s.scan({visit:item=>{assert.equal(item.index,count);count++;}});
  assert.equal(count,451);assert.equal(result.total,451);assert.equal(result.recipes.available,450);assert.equal(result.galleryVerified,true);
});

test('source reads a gallery above the old whole-state 2 MiB limit without old state endpoint or truncation',async t=>{
  const f=await fixture(t,{count:5,large:true});assert.ok(f.selection.sourceReceipt.bytes>2*1048576);const s=await f.source(),lengths=[];
  await s.scan({visit:item=>lengths.push(item.record.future.untouched.length)});assert.deepEqual(lengths,[450000,450000,450000,450000,450000]);
});

test('explicit empty gallery still verifies its companion and body evidence, rather than treating missing files as empty',async t=>{
  const f=await fixture(t,{count:0}),s=await f.source(),result=await s.scan();assert.equal(result.total,0);assert.equal(result.galleryVerified,true);assert.equal(result.evidenceFloors,2);
  await assert.rejects(s.read(0),/超出/);
});

test('detached metadata, summaries and read values cannot poison the next source read',async t=>{
  const f=await fixture(t),s=await f.source(),a=await s.metadata();a.supplement.order.reverse();a.evidence.chatEvidence.messages.length=0;s.summary.scope.chatKey='forged';
  const row=await s.read(0);row.record.id='forged';assert.equal((await s.read(0)).record.id,f.host.rows[0].id);assert.equal(s.summary.scope.chatKey,scope.chatKey);
  assert.deepEqual((await s.metadata()).supplement.order,f.host.rows.map(r=>r.id));assert.equal((await s.scan()).galleryVerified,true);
});

test('old versions stop before any reads and do not infer missing order/body from current chat',async t=>{
  const f=await fixture(t),before=f.transport.calls.length;
  for(const schema of ['v1','v2']){const selection={...f.selection,schema:'qianmu.gallery.source-version.'+schema};delete selection.evidence;if(schema==='v1')delete selection.supplement;
    await assert.rejects(f.source({selection}),/旧版本/);}
  assert.equal(f.transport.calls.length,before);
});

test('missing recipe copy is reported as missing, and corrupt server recipe bytes cannot be counted as complete',async t=>{
  const f=await fixture(t),s=await f.source();
  const serverItem=await s.read(1);assert.equal(serverItem.recipe.origin,'server-copy');
  const keys=[...f.transport.files.keys()].filter(k=>k.includes('-gallery-recipe-'));assert.ok(keys.length);
  for(const key of keys)f.transport.files.delete(key);assert.equal((await s.scan()).recipes.available,1);
  const corrupted={...f.archive,readRecoveryRecord:async ref=>{const item=await f.archive.readRecoveryRecord(ref);if(item.record.snapshotServerRef)item.recipe={state:'available',origin:'server-copy',snapshot:recipe()};if(item.recipe.snapshot)item.recipe.snapshot.prompt='forged';return item;}};
  const bad=await f.source({archive:corrupted});await assert.rejects(bad.scan(),/配方副本/);
});

test('wrong full-gallery digest never confirms a partially streamed source',async t=>{
  const f=await fixture(t),archive={...f.archive,readRecoveryRecord:async ref=>{const r=await f.archive.readRecoveryRecord(ref);r.record.future.extra='mutation';return r;}};
  const s=await f.source({archive});await assert.rejects(s.scan(),/完整原图库摘要/);
});

test('duplicated, missing or foreign page IDs cannot be used as a complete restore order',async t=>{
  const f=await fixture(t);
  for(const mutate of [rows=>rows.push(rows[0]),rows=>rows.pop(),rows=>{rows[0].recordId='foreign';}]){
    const archive={...f.archive,openSourceVersion:async(...args)=>{const real=await f.archive.openSourceVersion(...args);return {...real,page:async input=>{const result=await real.page(input);mutate(result.rows);return result;}};}};
    await assert.rejects(f.source({archive}),/重复|额外|覆盖/);
  }
});

test('abort, close, false guard and overlapping reads cannot return a late result or new data',async t=>{
  const f=await fixture(t),controller=new AbortController(),s=await f.source({signal:controller.signal});controller.abort();await assert.rejects(s.scan(),/取消/);await assert.rejects(s.metadata(),/取消/);
  const wait=gate(),archive={...f.archive,readRecoveryRecord:async ref=>{await wait.promise;return f.archive.readRecoveryRecord(ref);}},g=await f.source({archive});
  const reading=g.read(0);await new Promise(r=>setTimeout(r,5));await assert.rejects(g.read(1),/正在核对/);g.close();wait.resolve();await assert.rejects(reading,/取消/);
  const h=await f.source();f.state.current=false;await assert.rejects(h.metadata(),/来源已变化/);
});

test('missing version at final handoff refuses a success summary while keeping all other files',async t=>{
  const f=await fixture(t),s=await f.source(),before=f.transport.files.size;let removed=0;
  await assert.rejects(s.scan({visit:item=>{if(item.index===2)for(const key of f.transport.files.keys())if(key.includes('-gallery-source3-')){f.transport.files.delete(key);removed++;}}}),/完整图库版本/);
  assert.equal(removed,2);assert.equal(f.transport.files.size,before-removed);
});

test('companion/body disagreement is rejected before any record reads',async t=>{
  const f=await fixture(t),start=f.transport.calls.length,archive={...f.archive,readEvidence:async(...args)=>{const body=await f.archive.readEvidence(...args);body.receipt.header.sha256='f'.repeat(64);return body;}};
  await assert.rejects(f.source({archive}),/同一版本/);assert.ok(!f.transport.calls.slice(start).some(c=>c.path.includes('-gallery-record-')));
});

test('progress callback cancellation stops before records, and async callback failures are handled',async t=>{
  const f=await fixture(t),controller=new AbortController(),s=await f.source({signal:controller.signal}),start=f.transport.calls.length;
  await assert.rejects(s.scan({onProgress:async()=>controller.abort()}),/取消/);assert.ok(!f.transport.calls.slice(start).some(c=>c.path.includes('-gallery-record-')));
  const g=await f.source();await assert.rejects(g.scan({onProgress:async()=>{throw Error('progress stopped');}}),/progress stopped/);
});

test('closing browser during restore scan rejects promptly and a late record cannot continue scanning',async t=>{
  const f=await fixture(t),wait=gate();let recordReads=0,entered;const started=new Promise(r=>entered=r);
  const browser=createGalleryArchiveBrowser({account:async()=>scope.namespace,headers:()=>({}),createDiscovery:()=>({list:async()=>({entries:[{key:'a'.repeat(64),value:f.selection}]}),close(){}}),
    createArchive:async options=>{const real=await f.create(options);return {...real,readRecoveryRecord:async(...args)=>{recordReads++;entered();await wait.promise;return real.readRecoveryRecord(...args);}};}});t.after(()=>browser.close());
  await browser.list();await browser.open('a'.repeat(64));const pending=browser.review();await started;browser.close();await assert.rejects(pending,/取消/);wait.resolve();await new Promise(r=>setTimeout(r,10));assert.equal(recordReads,1);
});
