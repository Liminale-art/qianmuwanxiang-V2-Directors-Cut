import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createGalleryDiscoveryService} from '../qianmu-gallery-discovery-service.js';
import {galleryDiscoveryRequest,galleryDiscoveryResponse,galleryDiscoveryErrorPayload,GALLERY_DISCOVERY_LIMITS} from '../qianmu-gallery-discovery-contract.js';
import {galleryDiscoveryFixture as fixture} from './helpers/gallery-discovery-fixture.mjs';
import {createCurrentGalleryArchiveSession} from '../qianmu-gallery-archive-source.js';
import {createChatCharacterReceiptService} from '../qianmu-chat-character-receipt-service.js';
import {createGalleryArchiveStorage} from '../qianmu-gallery-archive-storage.js';

const sha=text=>createHash('sha256').update(text).digest('hex');
const gate=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};};

test('over 2 MiB source preserves to real native files, discovers and validates through the existing response contract',async t=>{
  const f=await fixture(t);f.host.rows=Array.from({length:6},(_,i)=>({id:'large-'+i,createdAt:i,url:'/user/images/f.png',unknown:'x'.repeat(450000)}));await f.host.save();
  const service=createChatCharacterReceiptService({dataRoot:f.host.root});t.after(()=>service.close());
  const session=await createCurrentGalleryArchiveSession({getContext:()=>f.host.context,epoch:()=>f.host.epoch,account:async()=>f.host.account,
    createStorage:f.transport.createStorage,fetchImpl:async(url,options)=>Response.json(await service[url.endsWith('/supplement')?'readGallerySupplement':'inspectGallery'](f.host.req,JSON.parse(options.body),{signal:options.signal}))});
  t.after(()=>session.close());const saved=await session.preserveAll();assert.ok(saved.sourceReceipt.bytes>2*1024*1024);await f.flush();
  const request=f.input({version:2}),result=await galleryDiscoveryResponse(await f.service.list(f.host.req,request),{namespace:f.host.account,request});
  assert.equal(result.entries.length,1);assert.deepEqual(result.entries[0].value.sourceReceipt,saved.sourceReceipt);
  const source=result.entries[0].value,reader=await createGalleryArchiveStorage({scope:source.scope,guard:()=>true,verifyRecord:()=>false,createStorage:f.transport.createStorage});
  t.after(()=>reader.close());const pageReader=await reader.openSourceVersion(source.sourceReceipt,source.supplement),page=await pageReader.page();
  assert.equal(page.rows.length,6);for(const row of page.rows)assert.equal((await reader.readRecord(row.record)).record.unknown.length,450000);pageReader.close();
});

test('real native-version files discover across pages without reading chats, originals, records or recipes',async t=>{
  const f=await fixture(t);for(let i=1;i<=5;i++)await f.add(i);await f.flush();
  await fs.writeFile(path.join(f.folder,'unrelated-private.json'),'PRIVATE_UNRELATED');
  const before=await f.unchanged();await fs.unlink(f.host.file); // Only the synthetic source chat is removed.
  let cursor=null,entries=[];
  do{const result=await f.service.list(f.host.req,f.input({cursor}));
    assert.equal(result.proof,'read-only-directory');assert.ok(result.entries.length<=2);entries.push(...result.entries);cursor=result.nextCursor;
    assert.ok(!JSON.stringify(result).includes('PRIVATE_'));
  }while(cursor);
  assert.equal(entries.length,5);assert.equal(new Set(entries.map(row=>row.key)).size,5);
  assert.deepEqual(entries.map(row=>row.key),entries.map(row=>row.key).sort());
  assert.equal(f.opened.length,15);assert.ok(f.opened.every(name=>/-gallery-source-[a-f0-9]{64}(?:-[a-f0-9]{64})?\.json$/.test(name)));
  assert.deepEqual(await f.unchanged(),before);
});

test('empty owned native folder is explicit empty, missing folder is an error and is never created',async t=>{
  const f=await fixture(t);const empty=await f.service.list(f.host.req,f.input());assert.deepEqual(empty.entries,[]);assert.equal(empty.nextCursor,null);
  await fs.rmdir(f.folder);await assert.rejects(f.service.list(f.host.req,f.input()),{code:'gallery_discovery_missing'});
  await assert.rejects(fs.stat(f.folder),{code:'ENOENT'});
});

test('caller cannot select another account, path, scope or arbitrary filename',async t=>{
  const f=await fixture(t);await f.add();await f.flush();
  for(const patch of [{expectedAccount:'st-user:'+'a'.repeat(64)},{path:f.folder},{namespace:'st-user:bob'},{limit:33},{cursor:{after:'../'}}])await assert.rejects(f.service.list(f.host.req,f.input(patch)));
  assert.equal(f.opened.length,0);
  f.host.req.user.profile.enabled=false;await assert.rejects(f.service.list(f.host.req,f.input()),{code:'gallery_discovery_account'});
});

test('unrelated and other-account file prefixes are neither opened nor exposed',async t=>{
  const f=await fixture(t);await f.add();await f.flush();
  await fs.writeFile(path.join(f.folder,`qianmu-v2-${'a'.repeat(64)}-gallery-source-${'b'.repeat(64)}.json`),'PRIVATE_OTHER_ACCOUNT');
  await fs.writeFile(path.join(f.folder,'qianmu-v2-unrelated-notes.json'),'PRIVATE_NOTE');
  const result=await f.service.list(f.host.req,f.input());assert.equal(result.entries.length,1);assert.equal(f.opened.length,3);
});

test('directory change invalidates continuation instead of skipping or merging different snapshots',async t=>{
  const f=await fixture(t);for(let i=1;i<=3;i++)await f.add(i);await f.flush();
  const first=await f.service.list(f.host.req,f.input());assert.ok(first.nextCursor);
  await fs.writeFile(path.join(f.folder,'new-file.json'),'new');
  await assert.rejects(f.service.list(f.host.req,f.input({cursor:first.nextCursor})),{code:'gallery_discovery_stale'});
  assert.equal((await f.service.list(f.host.req,f.input())).entries.length,2);
});

test('missing or corrupted version body is not an empty success and is not repaired',async t=>{
  for(const mode of ['missing','corrupt']){
    const f=await fixture(t);await f.add();await f.flush();
    const name=[...f.transport.files.keys()].find(name=>/-gallery-source-[a-f0-9]{64}-[a-f0-9]{64}\.json$/.test(name));
    if(mode==='missing')await fs.unlink(path.join(f.folder,name));else await fs.writeFile(path.join(f.folder,name),'{}');
    const before=await f.unchanged();await assert.rejects(f.service.list(f.host.req,f.input()));assert.deepEqual(await f.unchanged(),before);
  }
});

test('hard-linked version pointer is rejected before any body can be read',async t=>{
  const f=await fixture(t);await f.add();await f.flush();
  const name=[...f.transport.files.keys()].find(name=>/-gallery-source-[a-f0-9]{64}\.json$/.test(name));
  await fs.link(path.join(f.folder,name),path.join(f.folder,'extra-link.json'));
  await assert.rejects(f.service.list(f.host.req,f.input()),{code:'gallery_discovery_content'});assert.equal(f.opened.length,0);
});

test('symlinked files directory cannot traverse to another native directory',async t=>{
  const f=await fixture(t),target=path.join(f.host.req.user.directories.root,'elsewhere');await fs.mkdir(target);await fs.rmdir(f.folder);
  await fs.symlink(target,f.folder,'junction');await assert.rejects(f.service.list(f.host.req,f.input()),{code:'gallery_discovery_path'});
});

test('account changes during file reading discard the eventual directory response',async t=>{
  const f=await fixture(t);await f.add();await f.flush();let changed=false;
  const service=createGalleryDiscoveryService({dataRoot:f.host.root,io:{...fs,open:async(...args)=>{
    const handle=await fs.open(...args);if(!changed){changed=true;f.host.req.user.profile.handle='bob';}return handle;}}});t.after(()=>service.close());
  await assert.rejects(service.list(f.host.req,f.input()),{code:'gallery_discovery_changed'});
});

test('source metadata must belong to the authenticated namespace even with valid native checksums',async t=>{
  const f=await fixture(t);await f.add();await f.flush();
  const headName=[...f.transport.files.keys()].find(name=>/-gallery-source-[a-f0-9]{64}\.json$/.test(name));
  const head=JSON.parse(f.transport.files.get(headName)),oldName=headName.slice(0,-5)+'-'+head.fingerprint+'.json',doc=JSON.parse(f.transport.files.get(oldName));
  doc.value.scope.namespace='st-user:bob';const text=JSON.stringify(doc),fingerprint=sha(text);
  await fs.writeFile(path.join(f.folder,headName.slice(0,-5)+'-'+fingerprint+'.json'),text);
  await fs.writeFile(path.join(f.folder,headName),JSON.stringify({...head,fingerprint}));
  await assert.rejects(f.service.list(f.host.req,f.input()),{code:'gallery_discovery_contract'});
});

test('file-list memory is bounded by page size plus sentinel and scan overflow is explicit',async t=>{
  const f=await fixture(t);let closed=false;
  const service=createGalleryDiscoveryService({dataRoot:f.host.root,io:{...fs,opendir:async()=>({
    async *[Symbol.asyncIterator](){for(let index=0;index<=GALLERY_DISCOVERY_LIMITS.scan;index++)yield {name:'not-a-gallery-file'};},async close(){closed=true;}
  })}});t.after(()=>service.close());
  await assert.rejects(service.list(f.host.req,f.input()),{code:'gallery_discovery_capacity'});assert.equal(closed,true);assert.equal(f.opened.length,0);
});

test('timeout, external abort and close settle stalled enumeration without returning partial metadata',async t=>{
  for(const mode of ['timeout','abort','close']){
    const f=await fixture(t),started=gate(),release=gate();let closed=false;
    const service=createGalleryDiscoveryService({dataRoot:f.host.root,timeoutMs:100,io:{...fs,opendir:async()=>({
      async *[Symbol.asyncIterator](){started.resolve();await release.promise;yield {name:'ignored'};},async close(){closed=true;}
    })}});t.after(()=>service.close());const controller=new AbortController(),pending=service.list(f.host.req,f.input(),{signal:controller.signal});
    await started.promise;if(mode==='abort')controller.abort();if(mode==='close')await service.close();
    await assert.rejects(pending,{code:'gallery_discovery_changed'});release.resolve();await new Promise(resolve=>setTimeout(resolve,10));assert.equal(closed,true);
  }
});

test('discovery queue has a strict two-operation bound',async t=>{
  const f=await fixture(t),started=gate(),release=gate();let count=0;
  const service=createGalleryDiscoveryService({dataRoot:f.host.root,io:{...fs,opendir:async()=>({
    async *[Symbol.asyncIterator](){if(++count===2)started.resolve();await release.promise;yield {name:'ignored'};},async close(){}
  })}});t.after(()=>service.close());
  const first=service.list(f.host.req,f.input()),second=service.list(f.host.req,f.input());await started.promise;
  await assert.rejects(service.list(f.host.req,f.input()),{code:'gallery_discovery_busy'});release.resolve();await Promise.all([first,second]);
});

test('response contract rejects extra fields, replayed cursor, wrong scope and invalid source locator',async t=>{
  const f=await fixture(t);for(let i=1;i<=3;i++)await f.add(i);await f.flush();const result=await f.service.list(f.host.req,f.input());
  for(const mutate of [value=>{value.extra='bad';},value=>{value.entries[0].key='0'.repeat(64);},value=>{value.entries[0].value.extra='bad';},value=>{value.nextCursor.after='0'.repeat(64);}]){
    const copy=structuredClone(result);mutate(copy);await assert.rejects(galleryDiscoveryResponse(copy,{namespace:f.host.account,request:f.input()}));
  }
  assert.throws(()=>galleryDiscoveryRequest({...f.input(),cursor:{...result.nextCursor,account:'st-user:'+'a'.repeat(64)}}));
});

test('unexpected filesystem errors expose no paths or raw system details',async t=>{
  const f=await fixture(t),service=createGalleryDiscoveryService({dataRoot:f.host.root,io:{...fs,opendir:async()=>{throw Error('PRIVATE_LOCAL_PATH');}}});t.after(()=>service.close());
  await assert.rejects(service.list(f.host.req,f.input()),error=>{const result=galleryDiscoveryErrorPayload(error);assert.equal(result.status,503);assert.ok(!JSON.stringify(result).includes('PRIVATE_'));return true;});
});

test('head path injection and oversized head never open a supplied target or read unbounded bytes',async t=>{
  for(const mode of ['path','size']){
    const f=await fixture(t);await f.add();await f.flush();const name=[...f.transport.files.keys()].find(name=>/-gallery-source-[a-f0-9]{64}\.json$/.test(name));
    const original=JSON.parse(f.transport.files.get(name));
    await fs.writeFile(path.join(f.folder,name),mode==='path'?JSON.stringify({...original,fingerprint:'../../private'}):' '.repeat(5000));
    await assert.rejects(f.service.list(f.host.req,f.input()),{code:'gallery_discovery_content'});
    assert.deepEqual(f.opened,mode==='path'?[name]:[]);
  }
});

test('host file-directory misconfiguration cannot escape the authenticated account root',async t=>{
  const f=await fixture(t);f.host.req.user.directories.files=path.join(f.host.root,'bob','files');
  await assert.rejects(f.service.list(f.host.req,f.input()),{code:'gallery_discovery_path'});assert.equal(f.opened.length,0);
});

test('timed-out live filesystem work retains its queue slot until actual cleanup completes',async t=>{
  const f=await fixture(t),started=gate(),release=gate();let count=0;
  const service=createGalleryDiscoveryService({dataRoot:f.host.root,timeoutMs:300,io:{...fs,opendir:async()=>({
    async *[Symbol.asyncIterator](){if(++count===2)started.resolve();await release.promise;yield {name:'ignored'};},async close(){}
  })}});t.after(()=>service.close());
  const first=service.list(f.host.req,f.input()),second=service.list(f.host.req,f.input());
  const finished=Promise.allSettled([first,second]);await started.promise;
  assert.ok((await finished).every(result=>result.status==='rejected'&&result.reason.code==='gallery_discovery_changed'));
  await assert.rejects(service.list(f.host.req,f.input()),{code:'gallery_discovery_busy'});
  assert.equal(count,2);release.resolve();await new Promise(resolve=>setTimeout(resolve,10));
  assert.deepEqual((await service.list(f.host.req,f.input())).entries,[]);
});
