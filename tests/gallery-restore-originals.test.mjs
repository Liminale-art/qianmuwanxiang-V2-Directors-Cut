import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {galleryOriginalHttpFixture,originalPng as png,originalHash as sha} from './helpers/gallery-original-http-fixture.mjs';
import {streamCheckpointTransport} from './helpers/stream-checkpoint-fixture.mjs';
import {createCurrentGalleryArchiveSession} from '../qianmu-gallery-archive-source.js';
import {createGalleryArchiveStorage} from '../qianmu-gallery-archive-storage.js';
import {createGalleryRestoreSource} from '../qianmu-gallery-restore-source.js';
import {verifyGalleryRestoreOriginals} from '../qianmu-gallery-restore-originals.js';
import {createGalleryOriginalClient} from '../qianmu-gallery-original-client.js';
import {createGalleryArchiveBrowser} from '../qianmu-gallery-archive-browser.js';
const gate=()=>{let resolve;return {promise:new Promise(r=>resolve=r),resolve};};
async function fixture(t,{count=10}={}){
  const f=await galleryOriginalHttpFixture(t),transport=streamCheckpointTransport(f.account),calls=[],state={current:true,hook:null};
  const base=f.rows[0];f.rows.splice(0,f.rows.length,...Array.from({length:count},(_,i)=>({...structuredClone(base),id:'image-'+i,createdAt:i})));
  f.context.chat.push({mes:'local fixture body'});await fs.writeFile(f.file,[JSON.stringify({chat_metadata:f.context.chatMetadata}),...f.context.chat.map(row=>JSON.stringify(row))].join('\n')+'\n');
  const fetchImpl=async(url,options)=>{assert.ok(url.startsWith('/api/plugins/qianmu-tts/'));calls.push({url,options});if(state.hook){const value=await state.hook(url,options);if(value)return value;}return fetch(f.origin+url.slice('/api/plugins/qianmu-tts'.length),options);};
  const session=await createCurrentGalleryArchiveSession({getContext:()=>f.context,epoch:()=>0,account:async()=>f.account,fetchImpl,createStorage:transport.createStorage});
  const preserved=await session.preserveAll();session.close();assert.equal(preserved.evidences.state,'complete');
  const scope={namespace:f.account,ownerKey:'char:Alice.png',chatKey:'chat'},selection={schema:'qianmu.gallery.source-version.v3',scope,sourceReceipt:preserved.sourceReceipt,manifest:preserved.reference,supplement:preserved.supplement,evidence:preserved.evidence};
  const archive=await createGalleryArchiveStorage({scope,guard:()=>state.current,verifyRecord:()=>false,createStorage:transport.createStorage});t.after(()=>archive.close());
  const source=await createGalleryRestoreSource({selection,archive,guard:async()=>state.current});t.after(()=>source.close());
  const client=createGalleryOriginalClient({account:async()=>f.account,headers:()=>({'X-CSRF-Token':'test-only'}),guard:async()=>state.current,fetchImpl});t.after(()=>client.close());
  const run=options=>verifyGalleryRestoreOriginals({source,readBatch:(refs,options)=>client.readBatch(refs,options),guard:async()=>state.current,...options});
  return {...f,transport,calls,state,source,selection,archive,client,run,fetchImpl,
    browser(){const b=createGalleryArchiveBrowser({account:async()=>f.account,headers:()=>({}),isCurrent:()=>state.current,
      createDiscovery:()=>({list:async()=>({entries:[{key:'a'.repeat(64),value:selection}]}),close(){}}),
      createArchive:options=>createGalleryArchiveStorage({...options,createStorage:transport.createStorage}),createOriginal:options=>createGalleryOriginalClient({...options,fetchImpl}),
      loadImage:()=>{throw Error('no mutable URL fallback');}});t.after(()=>b.close());return b;},
  };
}

test('real HTTP verifies independently saved image bytes after original chat and URL file are removed, deduplicating across batches',async t=>{
  const f=await fixture(t);await fs.unlink(f.file);await fs.unlink(f.image);const before=f.transport.calls.length,start=f.calls.length,receipts=[];
  const result=await f.run({onVerified:item=>receipts.push(item)});assert.equal(result.originalVerified,true);assert.equal(result.restoreReady,false);assert.equal(result.canPrune,false);
  assert.deepEqual(result.originals,{referenced:10,missing:0,verified:10,unique:1,bytes:png.length});assert.equal(receipts.length,10);assert.ok(receipts.every(row=>!('blob' in row)&&row.originalVerified));
  assert.deepEqual(receipts.map(r=>r.recordId),f.rows.map(r=>r.id));assert.ok(f.calls.slice(start).every(c=>/\/original\/(?:capabilities|read)$/.test(c.url)));
  assert.equal(f.calls.slice(start).filter(c=>c.url.endsWith('/read')).length,1);assert.equal(f.calls.slice(start).filter(c=>c.url.endsWith('/capabilities')).length,1);
  assert.ok(f.transport.calls.slice(before).every(c=>c.options.method!=='POST'));assert.equal(result.recipes.available,10);
});

test('browser quick review does not fetch bytes; only explicit original verification reads exact copies',async t=>{
  const f=await fixture(t,{count:3}),b=f.browser();await b.list();await b.open('a'.repeat(64));const start=f.calls.length;
  const basic=await b.review();assert.equal(basic.originalVerified,false);assert.equal(f.calls.length,start);
  const full=await b.review({verifyOriginals:true});assert.equal(full.originalVerified,true);assert.equal(full.originals.verified,3);assert.equal(f.calls.length-start,2);
  await assert.rejects(b.review({verifyOriginals:'yes'}),/方式无效/);
});

test('missing references remain missing and do not fall back to original paths or generate replacements',async t=>{
  const f=await fixture(t,{count:3}),row=await f.source.read(0);
  for(const key of f.transport.files.keys())if(key.includes('-gallery-original-'+row.reference.sha256))f.transport.files.delete(key);
  const start=f.calls.length,result=await f.run();assert.equal(result.originalVerified,false);assert.equal(result.originals.missing,1);assert.equal(result.originals.verified,2);assert.equal(result.originals.unique,1);
  assert.ok(f.calls.slice(start).every(c=>/\/original\/(?:capabilities|read)$/.test(c.url)));
});

test('corrupt or removed private copy stops with no success result, repeated request or mutable-image fallback',async t=>{
  for(const mode of ['corrupt','missing']){
    const f=await fixture(t,{count:2}),row=await f.source.read(0),ref=row.media.reference,file=path.join(f.req.user.directories.root,'.qianmu-originals-v1',ref.sha256.slice(0,2),ref.id+'.bin');
    if(mode==='corrupt')await fs.writeFile(file,Buffer.alloc(png.length));else await fs.unlink(file);
    const start=f.calls.length;await assert.rejects(f.run());assert.equal(f.calls.length-start,2);assert.ok(f.calls.slice(start).every(c=>/\/original\/(?:capabilities|read)$/.test(c.url)));
    assert.deepEqual(await fs.readFile(f.image),png);
  }
});

test('last image read cannot confirm a version removed after metadata scan',async t=>{
  const f=await fixture(t,{count:2});f.state.hook=url=>{if(url.endsWith('/original/read'))for(const key of f.transport.files.keys())if(key.includes('-gallery-source3-'))f.transport.files.delete(key);};
  await assert.rejects(f.run(),/完整图库版本/);
});

test('empty archive confirms no image work without even probing the original service',async t=>{
  const f=await fixture(t,{count:0}),start=f.calls.length,result=await f.run();assert.equal(result.total,0);assert.equal(result.originals.verified,0);assert.equal(f.calls.length,start);
});

test('cancelling after an original receipt prevents the rest of the stream and any success',async t=>{
  const f=await fixture(t),controller=new AbortController();let seen=0;await assert.rejects(f.run({signal:controller.signal,onVerified:()=>{seen++;controller.abort();}}),/取消/);assert.equal(seen,1);
});

test('closing browser while original HTTP is pending rejects promptly and ignores late image bytes',async t=>{
  const f=await fixture(t,{count:2}),wait=gate();let enter;const entered=new Promise(r=>enter=r),b=f.browser();await b.list();await b.open('a'.repeat(64));
  f.state.hook=async url=>{if(url.endsWith('/original/read')){enter();await wait.promise;}};const pending=b.review({verifyOriginals:true});await entered;b.close();await assert.rejects(pending,/取消/);wait.resolve();await new Promise(r=>setTimeout(r,10));assert.equal(b.isClosed(),true);
});

function syntheticSource(count,{missing=false}={}){
  const refs=Array.from({length:count},()=>({version:1,id:sha(png)+'-'+randomUUID(),sha256:sha(png),bytes:png.length,mime:'image/png'}));
  const source={summary:{total:count},verify:async()=>true,scan:async({visit,onProgress})=>{await onProgress({completed:0,total:count});for(let index=0;index<count;index++)await visit({index,record:{id:'r'+index,createdAt:index},reference:{sha256:sha('r'+index),bytes:100},media:missing?{state:'not-preserved'}:{state:'available',reference:refs[index],original:{url:'/user/images/r.png'}}});return {total:count,galleryVerified:true,originals:{referenced:missing?0:count,missing:missing?count:0}};}};
  return {source,refs};
}
const response=reference=>({reference,blob:new Blob([png],{type:'image/png'}),proof:'original-copy-readback',originalVerified:true,canPrune:false});
const batchResult=count=>({count,proof:'original-batch-readback',originalVerified:true,canPrune:false});

test('more than 400 original references are processed in bounded batches, with no retained image arrays',async()=>{
  const {source}=syntheticSource(451),sizes=[];let delivered=0;
  const result=await verifyGalleryRestoreOriginals({source,guard:async()=>true,onVerified:row=>{assert.equal(row.index,delivered++);assert.ok(!('blob' in row));},readBatch:async(refs,{visit})=>{sizes.push(refs.length);for(let i=0;i<refs.length;i++)await visit(response(refs[i]),i);return batchResult(refs.length);}});
  assert.equal(result.originals.verified,451);assert.equal(result.originals.unique,451);assert.ok(sizes.every(n=>n>=1&&n<=8));assert.equal(sizes.length,57);
});

test('partial, unordered, unverifiable or incomplete batch acknowledgements never authorize completion',async()=>{
  for(const mode of ['partial','order','proof','size','final']){
    const {source}=syntheticSource(2);await assert.rejects(verifyGalleryRestoreOriginals({source,guard:async()=>true,readBatch:async(refs,{visit})=>{
      for(let i=0;i<(mode==='partial'?1:2);i++){const row=response(refs[i]);if(mode==='proof')row.originalVerified=false;if(mode==='size')row.blob=new Blob(['bad'],{type:'image/png'});await visit(row,mode==='order'?1-i:i);}
      return {...batchResult(refs.length),...(mode==='final'?{originalVerified:false}:{})};
    }}));
  }
});

test('same copy id with changed descriptor is not reused, and guard or final source refusal cancels confirmation',async()=>{
  const {source,refs}=syntheticSource(2);refs[1]={...refs[0],bytes:refs[0].bytes+1};
  await assert.rejects(verifyGalleryRestoreOriginals({source,guard:async()=>true,readBatch:()=>{throw Error('must not read');}}),/同一原图副本/);
  const empty=syntheticSource(0).source;empty.verify=async()=>false;await assert.rejects(verifyGalleryRestoreOriginals({source:empty,guard:async()=>true,readBatch:()=>{}}),/来源未确认/);
  await assert.rejects(verifyGalleryRestoreOriginals({source:empty,guard:async()=>false,readBatch:()=>{}}),/来源已变化/);
});
