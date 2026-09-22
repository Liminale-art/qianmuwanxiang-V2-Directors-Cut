import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createGalleryEvidenceStorage,captureGalleryEvidence,GALLERY_EVIDENCE_PAGE_LIMITS as LIMIT} from '../qianmu-gallery-archive-evidence.js';
import {createGalleryArchiveStorage} from '../qianmu-gallery-archive-storage.js';
import {STORYBOARD_CHAT_EVIDENCE_SCHEMA} from '../qianmu-storyboard-chat-evidence.js';
import {streamCheckpointTransport} from './helpers/stream-checkpoint-fixture.mjs';
import {chatEvidenceFixture} from './helpers/chat-evidence-fixture.mjs';
import {createGalleryDiscoveryService} from '../qianmu-gallery-discovery-service.js';
import {createGalleryDiscoveryClient} from '../qianmu-gallery-discovery-client.js';
import {createGalleryArchiveBrowser} from '../qianmu-gallery-archive-browser.js';
import {galleryArchiveSourceSlot,galleryArchiveSourceVersion} from '../qianmu-gallery-archive-version.js';

const sha=value=>createHash('sha256').update(value).digest('hex');
const scope={namespace:'st-user:alice',ownerKey:'char:Alice.png',chatKey:'chat-one'};
const supplement={sha256:'a'.repeat(64),bytes:1000};
const gate=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};};
const values=transport=>[...transport.files.values()].map(JSON.parse).filter(v=>v.schema==='qianmu.st-account-document.v1').map(v=>v.value);
const pages=transport=>values(transport).filter(v=>v.schema==='qianmu.gallery.evidence-page.v1');
const manifests=transport=>values(transport).filter(v=>v.schema==='qianmu.gallery.evidence-manifest.v1');
const uploads=transport=>transport.calls.filter(c=>c.path==='/api/files/upload');
function synthetic(count=4){
  const messages=Array.from({length:count},(_,floor)=>({floor,sha256:sha('body-'+floor),messageHash:'12345678',revisionHash:'87654321',swipeId:floor%3}));
  const core={schema:STORYBOARD_CHAT_EVIDENCE_SCHEMA,chatKey:scope.chatKey,messages};
  return {ok:true,version:1,expectedAccount:'st-user:'+sha('alice'),target:{kind:'character',chatId:scope.chatKey,avatar:'Alice.png'},gallerySha256:'b'.repeat(64),
    source:{bytes:Math.max(200,count*128),sha256:'c'.repeat(64)},header:{bytes:100,sha256:'d'.repeat(64)},chatEvidence:{...core,digest:sha(JSON.stringify(core))},proof:'read-only-chat-evidence'};
}
function redigest(value){const {digest,...core}=value.chatEvidence;value.chatEvidence.digest=sha(JSON.stringify(core));return value;}
async function fixture(t,options={}){
  const transport=streamCheckpointTransport(scope.namespace),state={current:true},yields=[];
  const store=await createGalleryEvidenceStorage({scope,guard:()=>state.current,createStorage:transport.createStorage,yieldWork:async()=>{yields.push(1);},...options});
  t.after(()=>store.close());return {transport,state,yields,store};
}
async function realFixture(t){
  const host=await chatEvidenceFixture(t),transport=streamCheckpointTransport(scope.namespace);
  host.rows[0].url='/user/images/frame.png';await host.write();
  const evidence=await host.service.readGalleryEvidenceSource(host.req,host.request());
  const companion=await host.service.readGallerySupplement(host.req,host.request());
  const store=await createGalleryArchiveStorage({scope,guard:()=>true,verifyRecord:()=>true,verifySupplement:()=>true,verifyEvidence:()=>true,createStorage:transport.createStorage});
  t.after(()=>store.close());return {host,transport,evidence,companion,store};
}
async function nativeObject(transport,kind,value){
  const ref={sha256:sha(JSON.stringify(value)),bytes:Buffer.byteLength(JSON.stringify(value))},native=await transport.createStorage({maxBytes:LIMIT.manifestBytes});
  try{await native.write('gallery-evidence-'+kind+'-'+ref.sha256,value,{expectedFingerprint:null});}finally{native.close();}return ref;
}

test('capture rejects unknown fields, getters, holes and lossy identities before any I/O',async()=>{
  let touched=0;
  for(const modify of [raw=>Object.defineProperty(raw,'target',{get(){touched++;return {};},enumerable:true}),
    raw=>Object.defineProperty(raw.chatEvidence.messages[0],'floor',{get(){touched++;return 0;},enumerable:true}),
    raw=>{delete raw.chatEvidence.messages[0];},raw=>{raw.chatEvidence.messages.extra=1;},raw=>{raw.chatEvidence.messages[0].secret='private';},
    raw=>{raw.chatEvidence.messages[0].swipeId=NaN;},raw=>{raw.chatEvidence.messages[0].sha256='bad';},raw=>{raw.target.avatar='\ud800.png';},
    raw=>{raw[Symbol('hidden')]=1;},raw=>{raw.chatEvidence.messages[0].toJSON=()=>({});}]){
    const raw=synthetic();modify(raw);assert.throws(()=>captureGalleryEvidence(raw));
  }assert.equal(touched,0);
});

test('real header-bound evidence and companion copies remain readable after source chat deletion',async t=>{
  const f=await realFixture(t),savedCompanion=await f.store.preserveSupplement(f.companion);
  const saved=await f.store.preserveEvidence(f.evidence,savedCompanion.reference);assert.equal(saved.pages,1);assert.equal(saved.messages,2);
  assert.equal(saved.canPrune,false);assert.equal(saved.originalVerified,false);assert.equal(saved.proof,'evidence-readback-only');
  f.store.close();await fs.unlink(f.host.file);
  const reader=await createGalleryArchiveStorage({scope,guard:()=>true,verifyRecord:()=>false,createStorage:f.transport.createStorage});t.after(()=>reader.close());
  const recovered=await reader.readEvidence(saved.reference);assert.deepEqual(recovered.receipt,f.evidence);assert.deepEqual(recovered.supplement,savedCompanion.reference);
  const stored=JSON.stringify(values(f.transport));for(const secret of ['PRIVATE_PROMPT','PRIVATE_KEY','PRIVATE_HIDDEN','PRIVATE_CHAR','PRIVATE_USER','正文🌸','PRIVATE_HISTORY'])assert.ok(!stored.includes(secret));
  assert.ok(f.transport.calls.every(c=>c.options.method==='GET'||c.path==='/api/files/upload'));
});

test('100000 digest rows pass actual native storage as 196 small pages without increasing native limits',async t=>{
  const f=await fixture(t),raw=synthetic(100000),whole=await f.transport.createStorage({maxBytes:24*1048576});
  await assert.rejects(whole.write('unpaged-evidence',raw,{expectedFingerprint:null}),/结构过大/);whole.close();assert.equal(uploads(f.transport).length,0);
  const saved=await f.store.preserve(raw,{supplement,verify:()=>true});assert.equal(saved.pages,196);assert.equal(saved.messages,100000);
  assert.equal(pages(f.transport).length,196);assert.equal(manifests(f.transport).length,1);assert.ok(f.yields.length>=392);
  for(const value of values(f.transport)){assert.ok(Buffer.byteLength(JSON.stringify(value))<128*1024);if(value.rows)assert.ok(value.rows.length<=512);}
  const read=await f.store.read(saved.reference);assert.deepEqual(read.receipt,raw);assert.equal(read.receipt.chatEvidence.messages.at(-1).floor,99999);
  const gets=f.transport.calls.length;await f.store.readManifest(saved.reference);assert.equal(f.transport.calls.length-gets,2,'manifest inspection reads no pages');
});

test('empty, single and exact page boundaries preserve complete order without empty trailing pages',async t=>{
  for(const count of [0,1,512,513]){
    const f=await fixture(t),raw=synthetic(count),saved=await f.store.preserve(raw,{supplement,verify:()=>true});
    assert.equal(saved.pages,Math.ceil(count/512));assert.equal((await f.store.read(saved.reference)).receipt.chatEvidence.messages.length,count);
    const manifest=manifests(f.transport)[0];assert.equal(manifest.pages.reduce((n,p)=>n+p.count,0),count);
  }
});

test('unchanged evidence reuses pages; header or companion changes retain versions, one body edit copies only its page',async t=>{
  const f=await fixture(t),raw=synthetic(1025),first=await f.store.preserve(raw,{supplement,verify:()=>true}),writes=uploads(f.transport).length;
  assert.deepEqual((await f.store.preserve(raw,{supplement,verify:()=>true})).reference,first.reference);assert.equal(uploads(f.transport).length,writes);
  const header=structuredClone(raw);header.header.sha256='e'.repeat(64);header.source.sha256='f'.repeat(64);
  const second=await f.store.preserve(header,{supplement,verify:()=>true});assert.notEqual(second.reference.sha256,first.reference.sha256);assert.equal(pages(f.transport).length,3);
  const third=await f.store.preserve(header,{supplement:{...supplement,sha256:'1'.repeat(64)},verify:()=>true});assert.notEqual(third.reference.sha256,second.reference.sha256);assert.equal(pages(f.transport).length,3);
  const edit=structuredClone(header);edit.chatEvidence.messages[514].sha256=sha('edited');redigest(edit);
  const fourth=await f.store.preserve(edit,{supplement,verify:()=>true});assert.equal(pages(f.transport).length,4);assert.equal(manifests(f.transport).length,4);
  assert.deepEqual((await f.store.read(first.reference)).receipt,raw);assert.deepEqual((await f.store.read(fourth.reference)).receipt,edit);
});

test('missing or corrupt stored pages fail read and are never repaired over damaged originals',async t=>{
  for(const damage of ['missing','corrupt']){
    const f=await fixture(t),raw=synthetic(513),saved=await f.store.preserve(raw,{supplement,verify:()=>true});
    const [name,text]=[...f.transport.files].find(([name,text])=>name.includes('-gallery-evidence-page-')&&JSON.parse(text).schema==='qianmu.st-account-document.v1');
    if(damage==='missing')f.transport.files.delete(name);else f.transport.files.set(name,text.replace('12345678','11223344'));
    const before=[...f.transport.files],writes=uploads(f.transport).length;await assert.rejects(f.store.read(saved.reference));await assert.rejects(f.store.preserve(raw,{supplement,verify:()=>true}));
    assert.equal(uploads(f.transport).length,writes);assert.deepEqual([...f.transport.files],before);
  }
});

test('manifest contracts reject missing, overlapping, reordered, wrong-scope and extra-field descriptors',async t=>{
  const f=await fixture(t),raw=synthetic(1025),saved=await f.store.preserve(raw,{supplement,verify:()=>true}),original=manifests(f.transport)[0];
  for(const mutate of [m=>m.pages.pop(),m=>m.pages.reverse(),m=>{m.pages[1].start=0;},m=>{m.pages[0].count=511;},m=>{m.scope.chatKey='other';},
    m=>{m.receipt.expectedAccount='st-user:'+'0'.repeat(64);},m=>{m.pages[0].body='private';},m=>{m.receipt.header.bytes=m.receipt.source.bytes+1;}]){
    const altered=structuredClone(original);mutate(altered);const reference=await nativeObject(f.transport,'manifest',altered);await assert.rejects(f.store.readManifest(reference));
  }assert.deepEqual((await f.store.read(saved.reference)).receipt,raw);
});

test('valid page and manifest hashes cannot disguise changed rows behind the original whole-evidence digest',async t=>{
  const f=await fixture(t),raw=synthetic(),saved=await f.store.preserve(raw,{supplement,verify:()=>true});
  const page=structuredClone(pages(f.transport)[0]);page.rows[0].sha256=sha('not original');const pageRef=await nativeObject(f.transport,'page',page);
  const manifest=structuredClone(manifests(f.transport)[0]);Object.assign(manifest.pages[0],pageRef);const ref=await nativeObject(f.transport,'manifest',manifest);
  await f.store.readManifest(ref);await assert.rejects(f.store.read(ref),/摘要不符/);assert.deepEqual((await f.store.read(saved.reference)).receipt,raw);
});

test('snapshot is detached before the first await and verifier receives only bounded summary copies',async t=>{
  const f=await fixture(t),raw=synthetic(513),original=structuredClone(raw),entered=gate(),release=gate();let calls=0;
  const pending=f.store.preserve(raw,{supplement,verify:async summary=>{
    assert.equal(summary.chatEvidence.messages,undefined);assert.equal(summary.chatEvidence.count,513);
    if(++calls===1){entered.resolve();await release.promise;}summary.header.sha256='0'.repeat(64);return true;
  }});
  await entered.promise;raw.chatEvidence.messages[0].sha256='9'.repeat(64);raw.header.sha256='8'.repeat(64);raw.target.chatId='other';release.resolve();
  const saved=await pending;assert.deepEqual((await f.store.read(saved.reference)).receipt,original);
});

test('source verification rejection before writes or between pages never publishes a complete manifest',async t=>{
  for(const later of [false,true]){
    const f=await fixture(t);await assert.rejects(f.store.preserve(synthetic(1025),{supplement,verify:()=>later?pages(f.transport).length<1:false}));
    assert.equal(manifests(f.transport).length,0);assert.equal(pages(f.transport).length,later?1:0);if(!later)assert.equal(uploads(f.transport).length,0);
  }
});

test('cancel, account change and close during upload preserve partial copies but cannot claim completion',async t=>{
  for(const change of ['abort','account','close']){
    const f=await fixture(t),controller=new AbortController();let changed=false;
    f.transport.hook=({path,options})=>{if(path==='/api/files/upload'&&!changed&&JSON.parse(options.body).name.includes('-gallery-evidence-page-')){
      changed=true;if(change==='abort')controller.abort();else if(change==='account')f.transport.namespace='st-user:other';else f.store.close();
    }};
    await assert.rejects(f.store.preserve(synthetic(513),{supplement,verify:()=>true,signal:controller.signal}),error=>error.writeState==='unconfirmed');
    assert.equal(changed,true);assert.equal(manifests(f.transport).length,0);assert.ok(uploads(f.transport).length<=1);
  }
});

test('failed later page upload keeps earlier pages without automatic retry or whole-document fallback',async t=>{
  const f=await fixture(t);let failed=false;
  f.transport.hook=({path,json})=>{if(path==='/api/files/upload'&&uploads(f.transport).length>=3){failed=true;return json({},503);}};
  await assert.rejects(f.store.preserve(synthetic(1025),{supplement,verify:()=>true}),e=>e.writeState==='unconfirmed');
  assert.equal(failed,true);assert.equal(pages(f.transport).length,1);assert.equal(manifests(f.transport).length,0);
  assert.equal(uploads(f.transport).length,3);assert.ok(uploads(f.transport).every(c=>JSON.parse(c.options.body).name.includes('-gallery-evidence-page-')));
});

test('damaged existing manifest is not overwritten by a new preservation attempt',async t=>{
  const f=await fixture(t),raw=synthetic(),saved=await f.store.preserve(raw,{supplement,verify:()=>true});
  const [name,text]=[...f.transport.files].find(([name,text])=>name.includes('-gallery-evidence-manifest-')&&JSON.parse(text).schema==='qianmu.st-account-document.v1');
  const bad=JSON.parse(text);bad.value.receipt.source.bytes++;f.transport.files.set(name,JSON.stringify(bad));const before=[...f.transport.files],writes=uploads(f.transport).length;
  await assert.rejects(f.store.preserve(raw,{supplement,verify:()=>true}));await assert.rejects(f.store.read(saved.reference));assert.deepEqual([...f.transport.files],before);assert.equal(uploads(f.transport).length,writes);
});

test('archive facade requires a staged companion and exact account/chat/gallery/header binding before evidence writes',async t=>{
  const f=await realFixture(t);await assert.rejects(f.store.preserveEvidence(f.evidence,supplement),/尚未在本次/);
  const saved=await f.store.preserveSupplement(f.companion),before=uploads(f.transport).length;
  for(const mutate of [r=>{r.header.sha256='0'.repeat(64);},r=>{r.header.bytes++;},r=>{r.gallerySha256='0'.repeat(64);},r=>{r.expectedAccount='st-user:'+'0'.repeat(64);},r=>{r.target.avatar='Other.png';}]){
    const raw=structuredClone(f.evidence);mutate(raw);await assert.rejects(f.store.preserveEvidence(raw,saved.reference));
  }assert.equal(uploads(f.transport).length,before);assert.equal(manifests(f.transport).length,0);
  const reader=await createGalleryArchiveStorage({scope,guard:()=>true,verifyRecord:()=>true,verifySupplement:()=>true,createStorage:f.transport.createStorage});t.after(()=>reader.close());
  await reader.preserveSupplement(f.companion);await assert.rejects(reader.preserveEvidence(f.evidence,saved.reference));assert.equal(manifests(f.transport).length,0);
});

test('archive read refuses a missing companion rather than returning detached evidence as a complete source',async t=>{
  const f=await realFixture(t),companion=await f.store.preserveSupplement(f.companion),saved=await f.store.preserveEvidence(f.evidence,companion.reference);
  for(const name of [...f.transport.files.keys()])if(name.includes('-gallery-supplement-'))f.transport.files.delete(name);
  await assert.rejects(f.store.readEvidence(saved.reference),/缺失/);assert.equal(manifests(f.transport).length,1);assert.equal(pages(f.transport).length,1);
});

test('late factory completion closes storage and async guards are rejected without unhandled rejection',async()=>{
  const wait=gate();let current=true,closes=0;
  const opening=createGalleryEvidenceStorage({scope,guard:()=>current,createStorage:async()=>{await wait.promise;return {namespace:scope.namespace,close(){closes++;}};}});
  current=false;wait.resolve();await assert.rejects(opening);assert.equal(closes,1);
  await assert.rejects(createGalleryEvidenceStorage({scope,guard:async()=>{throw Error('late');},createStorage:()=>{throw Error('should not open');}}));
  await new Promise(resolve=>setTimeout(resolve,0));
});

test('concurrent preservation is rejected; cancellation during paged read never returns a partial receipt',async t=>{
  const f=await fixture(t),entered=gate(),release=gate();let first=true;
  const pending=f.store.preserve(synthetic(513),{supplement,verify:async()=>{if(first){first=false;entered.resolve();await release.promise;}return true;}});
  await entered.promise;await assert.rejects(f.store.preserve(synthetic(),{supplement,verify:()=>true}),/正在保存/);release.resolve();const saved=await pending;
  const controller=new AbortController();f.transport.hook=({path})=>{if(path.includes('-gallery-evidence-page-'))controller.abort();};
  await assert.rejects(f.store.read(saved.reference,{signal:controller.signal}));assert.equal(manifests(f.transport).length,1);
});

test('forged receipt fields, wrong account and oversized row lists cannot write any native document',async t=>{
  const f=await fixture(t);
  for(const mutate of [r=>{r.expectedAccount='st-user:'+'0'.repeat(64);},r=>{r.target.chatId='other';},r=>{r.header.bytes=r.source.bytes+1;},
    r=>{r.source.bytes=128*1048576+1;},r=>{r.chatEvidence.digest='0'.repeat(64);},r=>{r.chatEvidence.messages.length=100001;},r=>{r.proof='saved';}]){
    const raw=synthetic();mutate(raw);await assert.rejects(f.store.preserve(raw,{supplement,verify:()=>true}));
  }assert.equal(uploads(f.transport).length,0);
});

test('v3 immutable versions bind verified evidence; new browser discovers copies without source chat or eager evidence reads',async t=>{
  const f=await realFixture(t),companion=await f.store.preserveSupplement(f.companion),body=await f.store.preserveEvidence(f.evidence,companion.reference);
  const page=await f.store.stagePage(f.host.rows),source={...f.companion.gallery,proof:'read-only-snapshot'};
  await f.store.publishSourceVersion(source,[page.descriptor]);await f.store.publishSourceVersion(source,[page.descriptor],companion.reference);
  const saved=await f.store.publishSourceVersion(source,[page.descriptor],companion.reference,body.reference);
  const version=values(f.transport).find(v=>v.schema==='qianmu.gallery.source-version.v3');assert.deepEqual(galleryArchiveSourceVersion(version,scope,source),version);
  assert.deepEqual(version.evidence,body.reference);assert.ok((await galleryArchiveSourceSlot(scope,source,companion.reference,body.reference)).startsWith('gallery-source3-'));
  const folder=path.join(f.host.user,'files');await fs.mkdir(folder);f.host.req.user.directories.files=folder;
  for(const [name,text] of f.transport.files)await fs.writeFile(path.join(folder,name),text);await fs.unlink(f.host.file);f.store.close();
  const opened=[],service=createGalleryDiscoveryService({dataRoot:f.host.root,io:{...fs,open:async(file,...rest)=>{opened.push(path.basename(file));return fs.open(file,...rest);}}});t.after(()=>service.close());
  const request=version=>({version,expectedAccount:f.evidence.expectedAccount,limit:32,cursor:null});
  assert.equal((await service.list(f.host.req,request(1))).entries.length,1);assert.equal((await service.list(f.host.req,request(2))).entries.length,2);
  const browser=createGalleryArchiveBrowser({account:async()=>scope.namespace,headers:()=>({}),
    createDiscovery:options=>createGalleryDiscoveryClient({...options,fetchImpl:async(_,opts)=>Response.json(await service.list(f.host.req,JSON.parse(opts.body),{signal:opts.signal}))}),
    createArchive:options=>createGalleryArchiveStorage({...options,createStorage:f.transport.createStorage})});t.after(()=>browser.close());
  const list=await browser.list();assert.equal(list.entries.length,3);assert.ok(opened.every(name=>/-gallery-source[23]?-/.test(name)));
  const selected=list.entries.find(entry=>entry.value.evidence);let at=f.transport.calls.length;await browser.open(selected.key);
  assert.ok(!f.transport.calls.slice(at).some(c=>c.path.includes('-gallery-evidence-')||c.path.includes('-gallery-supplement-')));
  assert.equal((await browser.page()).rows.length,1);at=f.transport.calls.length;const evidence=await browser.evidence();assert.equal(evidence.state,'available');assert.deepEqual(evidence.receipt,f.evidence);
  assert.deepEqual(evidence.reference,saved.evidence);assert.ok(f.transport.calls.slice(at).some(c=>c.path.includes('-gallery-evidence-page-')));
  await browser.open(list.entries.find(entry=>!entry.value.evidence).key);assert.equal((await browser.evidence()).state,'not-preserved');
  const bad=[...f.transport.files].find(([name,text])=>name.includes('-gallery-source3-')&&JSON.parse(text).schema==='qianmu.st-account-document.v1');
  await fs.writeFile(path.join(folder,bad[0]),'damaged');assert.equal((await service.list(f.host.req,request(2))).entries.length,2);await assert.rejects(service.list(f.host.req,request(3)));
});

test('evidenced publication refuses unstaged evidence, absent companion, wrong binding and missing pages',async t=>{
  const f=await realFixture(t),companion=await f.store.preserveSupplement(f.companion),body=await f.store.preserveEvidence(f.evidence,companion.reference);
  const page=await f.store.stagePage(f.host.rows),source={...f.companion.gallery,proof:'read-only-snapshot'};
  for(const args of [[source,[page.descriptor],undefined,body.reference],[source,[page.descriptor],companion.reference,{...body.reference,sha256:'0'.repeat(64)}]])await assert.rejects(f.store.publishSourceVersion(...args));
  const next=await createGalleryArchiveStorage({scope,guard:()=>true,verifyRecord:()=>true,verifySupplement:()=>true,verifyEvidence:()=>true,createStorage:f.transport.createStorage});t.after(()=>next.close());
  await next.preserveSupplement(f.companion);const nextPage=await next.stagePage(f.host.rows);await assert.rejects(next.publishSourceVersion(source,[nextPage.descriptor],companion.reference,body.reference),/尚未在本次/);
  const missing=[...f.transport.files.keys()].find(name=>name.includes('-gallery-evidence-page-'));f.transport.files.delete(missing);
  await assert.rejects(f.store.publishSourceVersion(source,[page.descriptor],companion.reference,body.reference));
  assert.equal(values(f.transport).filter(v=>v.schema==='qianmu.gallery.source-version.v3').length,0);
});

test('source change during v3 publication retains written copies but never acknowledges current-source success',async t=>{
  const f=await realFixture(t);let current=true;
  const store=await createGalleryArchiveStorage({scope,guard:()=>true,verifyRecord:()=>true,verifySupplement:()=>true,verifyEvidence:()=>current,createStorage:f.transport.createStorage});t.after(()=>store.close());
  const companion=await store.preserveSupplement(f.companion),body=await store.preserveEvidence(f.evidence,companion.reference),page=await store.stagePage(f.host.rows);
  f.transport.hook=({path,options})=>{if(path==='/api/files/upload'&&JSON.parse(options.body).name.includes('-gallery-source3-'))current=false;};
  await assert.rejects(store.publishSourceVersion({...f.companion.gallery,proof:'read-only-snapshot'},[page.descriptor],companion.reference,body.reference),e=>e.writeState==='unconfirmed');
  assert.equal(manifests(f.transport).length,1);assert.equal(pages(f.transport).length,1);
});

test('new discovery capability cannot accept older success responses as an empty complete library',async t=>{
  for(const version of [1,2]){
    let calls=0;const client=createGalleryDiscoveryClient({account:async()=>scope.namespace,headers:()=>({}),fetchImpl:async(_,options)=>{
      calls++;assert.equal(JSON.parse(options.body).version,3);return Response.json({ok:true,version,expectedAccount:synthetic().expectedAccount,entries:[],nextCursor:null,proof:'read-only-directory'});
    }});t.after(()=>client.close());await assert.rejects(client.list());assert.equal(calls,1);
  }
});
