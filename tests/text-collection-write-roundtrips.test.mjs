import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {webcrypto} from 'node:crypto';
import {collectionIndexFixture,record} from './helpers/collection-index-fixture.mjs';
import {configureStAccountStorage} from '../qianmu-st-account-storage.js';
import {createTextCollectionSession} from '../qianmu-text-collection-session.js';
import {resolveImageAccountNamespace} from '../qianmu-account-identity.js';
import {deleteTextCollectionFloor} from '../qianmu-text-collection-floor-delete.js';

const methodCounts=calls=>({get:calls.filter(row=>row.request.method==='GET').length,post:calls.filter(row=>row.request.method==='POST').length});
const fileSteps=calls=>calls.map(({path,request})=>{
  if(request.method==='POST'){
    const document=JSON.parse(Buffer.from(JSON.parse(request.body).data,'base64').toString('utf8'));
    return 'POST '+(document.schema==='qianmu.st-account-head.v1'?'head':document.slot==='collection-record'?'original':'directory');
  }
  return 'GET '+(path.includes('-collection-record-')?'original':/-collections\.json$/.test(path)?'head':'directory');
});
const directoryWrite=['GET head','GET directory','GET head','POST directory','GET head','POST head','GET head','GET directory'];

async function nativeServerFixture(t){
  const seed=await collectionIndexFixture(t,[record(1),record(2)]),temporary=await fs.realpath(os.tmpdir());
  const root=await fs.mkdtemp(path.join(temporary,'qianmu-collection-server-cost-')),accountRoot=path.join(root,'account'),files=path.join(accountRoot,'files');
  await fs.mkdir(files,{recursive:true});for(const [name,text] of seed.files)await fs.writeFile(path.join(files,name),text);
  const {createTextCollectionNativeService}=await import('../qianmu-text-collection-native-service.js');
  const service=createTextCollectionNativeService({dataRoot:root});
  const request={user:{profile:{handle:'index-fixture',enabled:true},directories:{root:accountRoot,files}}};
  const counts={capabilities:0,write:0,fileGET:0,filePOST:0,identityHTTP:0},payloads=[],clients=[];let loseReceipt=false,lastResult,heldReceipt=null;
  const originalLocation=Object.getOwnPropertyDescriptor(globalThis,'location');
  Object.defineProperty(globalThis,'location',{configurable:true,value:{origin:'https://st.fixture.invalid'}});
  const user={currentUser:{handle:'index-fixture'},accountsEnabled:true};
  // Guards resolve through the real identity entry, never a fixed namespace.
  const resolveNamespace=()=>resolveImageAccountNamespace({loadUser:async()=>user,fetchImpl:async()=>{counts.identityHTTP++;assert.fail('initialized host has no identity HTTP');}});
  const fetchImpl=async(url,options={})=>{
    const {origin,pathname}=new URL(url);assert.equal(origin,'https://st.fixture.invalid');assert.equal(options.credentials,'same-origin');
    assert.equal(options.cache,'no-store');assert.equal(options.redirect,'error');assert.equal(options.headers.Authorization,undefined);
    assert.equal(options.headers['X-CSRF-Token'],'fixture');
    if(pathname==='/api/plugins/qianmu-tts/text-collections/native-capabilities'){
      assert.equal(options.method,'GET');counts.capabilities++;return Response.json(await service.capabilities(request));
    }
    if(pathname==='/api/plugins/qianmu-tts/text-collections/native-write'){
      assert.equal(options.method,'POST');counts.write++;const payload=JSON.parse(options.body);payloads.push(structuredClone(payload));
      const held=heldReceipt;heldReceipt=null;
      const result=await service.write(request,payload,{signal:options.signal});lastResult=result;
      if(held){held.entered();await held.gate;}
      if(loseReceipt){loseReceipt=false;throw new TypeError('synthetic lost acknowledgement');}return Response.json(result);
    }
    if(pathname==='/api/files/upload'){counts.filePOST++;assert.fail('a dispatched server mutation must never fall back to browser file uploads');}
    assert.equal(options.method,'GET');assert.match(pathname,/^\/user\/files\/qianmu-v2-[a-f0-9]{64}-[a-z0-9-]+\.json$/);counts.fileGET++;
    try{return new Response(await fs.readFile(path.join(files,path.basename(pathname))),{headers:{'content-type':'application/json'}});}
    catch(cause){if(cause.code==='ENOENT')return Response.json({}, {status:404});throw cause;}
  };
  t.mock.method(globalThis,'fetch',fetchImpl);
  const config={resolveNamespace,isCurrent:()=>true,headers:()=>({'X-CSRF-Token':'fixture'}),fetchImpl,origin:globalThis.location.origin,cryptoImpl:webcrypto};
  configureStAccountStorage(config);
  t.after(async()=>{clients.forEach(client=>client.close());await service.close();
    if(originalLocation)Object.defineProperty(globalThis,'location',originalLocation);else delete globalThis.location;
    const verified=await fs.realpath(root);assert.equal(path.dirname(verified),temporary);assert.match(path.basename(verified),/^qianmu-collection-server-cost-/);await fs.rm(verified,{recursive:true});});
  return {counts,payloads,files,reset(){for(const key of Object.keys(counts))counts[key]=0;},loseReceipt(){loseReceipt=true;},get lastResult(){return lastResult;},
    holdNextReceipt(){let release,entered;const started=new Promise(done=>entered=done),gate=new Promise(done=>release=done);heldReceipt={gate,entered};return {started,release};},
    async open(){const session=await createTextCollectionSession({...config,fetchImpl:undefined});clients.push(session);return session;},
    async canonicalBytes(){return Object.fromEntries(await Promise.all((await fs.readdir(files)).sort().map(async name=>[name,await fs.readFile(path.join(files,name),'utf8')])));}};
}

// Counts are request-level evidence over the real native client and storage.
// No production VPS timings or private account data are inferred from fixtures.
test('browser-only native create preserves the measured 13-file-request baseline and complete original',async t=>{
  const f=await collectionIndexFixture(t,[record(1)]),session=await f.open();await session.sources();f.reset();
  const source='A complete synthetic original\r\n\r\nSecond paragraph — Unicode 保全',created=record(2,source);
  await session.prepareCreate(created).submit();assert.deepEqual(methodCounts(f.calls),{get:10,post:3});
  assert.deepEqual(fileSteps(f.calls),['GET head','GET directory','GET original','POST original','GET original',...directoryWrite]);
  const saved=(await session.get(created.id)).record;assert.equal(saved.text,source);assert.deepEqual(saved.source,created.source);
  assert.equal((await session.get(record(1).id)).record.text,record(1).text,'unrelated originals remain complete');
});

test('browser-only native edit preserves the measured 14-file-request baseline and earlier original bytes',async t=>{
  const original=record(2,'Initial synthetic text\r\n\r\nOriginal second paragraph'),f=await collectionIndexFixture(t,[record(1),original]),session=await f.open();
  await session.sources();const descriptor=f.descriptors[1],edited='Edited first paragraph\r\n\r\nEdited second paragraph\nFinal line';f.reset();
  await session.prepareEdit(original.id,1,edited).submit();assert.deepEqual(methodCounts(f.calls),{get:11,post:3});
  assert.deepEqual(fileSteps(f.calls),['GET head','GET directory','GET original','GET original','POST original','GET original',...directoryWrite]);
  const saved=(await session.get(original.id)).record;assert.equal(saved.text,edited);assert.deepEqual(saved.source,original.source);assert.equal(saved.revision,2);
  const prior=await f.originals.read(descriptor);assert.equal(prior.record.text,original.text,'saved old version remains readable by its exact reference');
  assert.equal((await session.get(record(1).id)).record.text,record(1).text);
});

test('browser-only native lost directory acknowledgement retains the identical create and confirms it without a second upload',async t=>{
  const f=await collectionIndexFixture(t,[record(1)]),session=await f.open();await session.list();
  const operation=session.prepareCreate(record(2)),frozen=structuredClone(operation.request);f.loseIndexAck();
  await assert.rejects(operation.submit());f.reset();await operation.submit();
  assert.deepEqual(operation.request,frozen);assert.equal(f.uploads,0);
  const page=await session.list();assert.equal(page.total,2);assert.equal(page.items.filter(row=>row.id===record(2).id).length,1);
});

test('actual identity→session→native→same-file server uses one mutation POST with no browser upload fallback and complete text',async t=>{
  const f=await nativeServerFixture(t),session=await f.open();await session.sources();f.reset();
  const original=record(3,'Complete server-created original\r\n\r\nSynthetic second paragraph — 保全');
  const created=await session.prepareCreate(original).submit();assert.equal(created.revision,1);
  assert.deepEqual(f.counts,{capabilities:1,write:1,fileGET:0,filePOST:0,identityHTTP:0},'first save includes its one read-only capability negotiation');
  assert.equal((await session.get(original.id)).record.text,original.text);
  const beforeFiles=await f.canonicalBytes(),edited='Edited server text\r\n\r\nAll paragraphs preserved\nFinal line';f.reset();
  const ack=await session.prepareEdit(original.id,1,edited).submit();assert.equal(ack.revision,2);
  assert.deepEqual(f.counts,{capabilities:0,write:1,fileGET:0,filePOST:0,identityHTTP:0},'the supported save itself has one roundtrip');
  const updated=(await session.get(original.id)).record;assert.equal(updated.text,edited);assert.deepEqual(updated.source,original.source);
  assert.equal((await session.get(record(1).id)).record.text,record(1).text);
  const afterFiles=await f.canonicalBytes();
  for(const [name,text] of Object.entries(beforeFiles))if(!/-collections\.json$/.test(name))assert.equal(afterFiles[name],text,'retained original/version bytes are never rewritten');
  assert.equal(Object.keys(afterFiles).some(name=>name==='.qianmu-text-collection-v1.json'),false,'no second legacy library is created');
  f.reset();await session.prepareDelete(original.id,2).submit();assert.deepEqual(f.counts,{capabilities:0,write:1,fileGET:0,filePOST:0,identityHTTP:0});
  assert.equal((await session.get(original.id)).record,null);
});

test('server-accepted lost receipt remains on that endpoint and confirms the identical mutation without another revision or file body',async t=>{
  const f=await nativeServerFixture(t),session=await f.open();await session.list();f.reset();
  const operation=session.prepareCreate(record(3,'Complete retry original\r\nDo not duplicate')),request=structuredClone(operation.request);
  f.loseReceipt();await assert.rejects(operation.submit(),{code:'text_collection_sync_native_connection',writeState:'unconfirmed'});
  assert.deepEqual(f.counts,{capabilities:1,write:1,fileGET:0,filePOST:0,identityHTTP:0});
  const afterAcceptance=await f.canonicalBytes(),accepted=structuredClone(f.lastResult);f.reset();
  const ack=await operation.submit();assert.deepEqual(operation.request,request);assert.deepEqual(f.payloads[0],f.payloads[1]);
  assert.deepEqual(f.counts,{capabilities:0,write:1,fileGET:0,filePOST:0,identityHTTP:0});
  assert.deepEqual(await f.canonicalBytes(),afterAcceptance,'same operation only reads its durable receipt, without rewriting originals or advancing the head');
  assert.deepEqual(ack,accepted.acknowledgements.results[0]);
  const page=await session.list();assert.equal(page.total,3);assert.equal(page.items.filter(row=>row.id===record(3).id).length,1);
});

test('a genuinely cold native save still counts its initial directory opening separately from the accelerated mutation',async t=>{
  const f=await nativeServerFixture(t),session=await f.open();f.reset();
  await session.prepareCreate(record(3)).submit();
  assert.deepEqual(f.counts,{capabilities:1,write:1,fileGET:2,filePOST:0,identityHTTP:0},'cold directory head/body and capability negotiation are not hidden by the one-POST save claim');
});

test('actual warmed floor cancellation after reopening counts its source-head revalidation separately from the accelerated write',async t=>{
  const f=await nativeServerFixture(t),first=await f.open();await first.sources();first.close();f.reset();
  const reopened=await f.open(),result=await deleteTextCollectionFloor({session:reopened,chatId:'deleted-chat',messageId:1});
  assert.deepEqual(result,{total:1,confirmed:1});
  assert.deepEqual(f.counts,{capabilities:1,write:1,fileGET:1,filePOST:0,identityHTTP:0},'whole cancellation includes its fresh source directory head and first capability probe, not only the mutation POST');
  assert.deepEqual(f.payloads[0].mutations.map(row=>({id:row.id,operation:row.operation})),[{id:record(1).id,operation:'delete'}]);
  assert.equal((await reopened.get(record(1).id)).record,null);
  assert.equal((await reopened.get(record(2).id)).record.text,record(2).text,'another floor remains complete and cached');
  assert.deepEqual(f.counts,{capabilities:1,write:1,fileGET:1,filePOST:0,identityHTTP:0},'post-confirmation checks do not re-download surviving original text');
  reopened.close();f.reset();const next=await f.open();
  assert.deepEqual(await deleteTextCollectionFloor({session:next,chatId:'deleted-chat',messageId:2}),{total:1,confirmed:1});
  assert.deepEqual(f.counts,{capabilities:0,write:1,fileGET:1,filePOST:0,identityHTTP:0},'once support is known, another complete floor cancellation is head GET plus mutation POST');
});

test('out-of-order successful server receipts cannot replace a newer confirmed shared directory with an older snapshot',async t=>{
  const f=await nativeServerFixture(t),a=await f.open(),b=await f.open();await a.list();await b.list(undefined,{revalidate:true});
  const held=f.holdNextReceipt(),first=a.prepareCreate(record(3)).submit();await held.started;
  let newer;
  try{newer=await b.prepareCreate(record(4)).submit();}finally{held.release();}
  const older=await first;assert.ok(newer.libraryRevision>older.libraryRevision);
  const page=await b.list(undefined,{preferCache:true});
  assert.equal(page.total,4,'late lower-revision receipt must not hide the already confirmed independent save');
  assert.equal(page.libraryRevision,newer.libraryRevision);
  assert.ok(page.items.some(row=>row.id===record(3).id));assert.ok(page.items.some(row=>row.id===record(4).id));
});
