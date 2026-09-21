import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import {createGalleryArchiveBrowser as create} from '../qianmu-gallery-archive-browser.js';
import {createGalleryArchiveStorage} from '../qianmu-gallery-archive-storage.js';
import {createGalleryDiscoveryClient} from '../qianmu-gallery-discovery-client.js';
import {galleryDiscoveryFixture} from './helpers/gallery-discovery-fixture.mjs';

const gate=()=>{let resolve;return {promise:new Promise(done=>resolve=done),resolve};};
async function fixture(t,extra={}){
  const f=await galleryDiscoveryFixture(t);await f.add();await f.add(2);await f.flush();
  let namespace=f.host.account,current=true,images=0;const sources=[];
  const options={account:async()=>namespace,headers:()=>({'X-CSRF-Token':'fixture'}),isCurrent:()=>current,
    createDiscovery:options=>createGalleryDiscoveryClient({...options,fetchImpl:async(url,init)=>{
      assert.equal(url,'/api/plugins/qianmu-tts/gallery-archive/versions');
      return Response.json(await f.service.list(f.host.req,JSON.parse(init.body),{signal:init.signal}));
    }}),
    createArchive:options=>createGalleryArchiveStorage({...options,createStorage:f.transport.createStorage}),
    loadImage:async(url,{guard,signal})=>{await guard();assert.equal(signal.aborted,false);images++;sources.push(url);return {blob:new Blob(['synthetic']),width:10,height:20};},...extra};
  const s=create(options);t.after(()=>s.close());
  return {...f,s,options,get images(){return images;},sources,
    switchAccount(){namespace='st-user:bob';f.transport.namespace=namespace;},invalidate(){current=false;}};
}

test('actual discovery, native version/page/record readers work with no original chat and never write',async t=>{
  const f=await fixture(t),before=await f.unchanged(),calls=f.transport.calls.length;
  await fs.unlink(f.host.file);assert.equal(f.images,0);
  const list=await f.s.list();assert.equal(list.entries.length,2);assert.equal(f.transport.calls.length,calls);
  const entry=list.entries[0];await f.s.open(entry.key);
  assert.equal(f.transport.calls.length-calls,4,'only native source pointer and manifest');
  const page=await f.s.page({limit:24});assert.equal(page.rows.length,1);assert.equal(f.images,0);
  assert.equal(f.transport.calls.length-calls,6,'page metadata, not all record bodies');
  const preview=await f.s.preview(page.rows[0].recordId);
  assert.equal(f.transport.calls.length-calls,8);assert.equal(f.images,1);
  assert.equal(preview.record.prompt,'PRIVATE_PROMPT');assert.equal(preview.source.chatKey,entry.value.scope.chatKey);
  assert.equal(preview.originalVerified,false);assert.equal(preview.canPrune,false);
  assert.ok(f.transport.calls.slice(calls).every(row=>row.options.method!=='POST'));
  assert.deepEqual(await f.unchanged(),before);assert.deepEqual(Object.keys(f.s).sort(),['close','isClosed','list','open','page','preview']);
});

test('caller cannot forge a discovered version or select a record outside the current page',async t=>{
  const f=await fixture(t),list=await f.s.list({limit:1});await assert.rejects(f.s.open('a'.repeat(64)),/当前列表/);
  list.entries[0].value.scope.chatKey='forged';await f.s.open(list.entries[0].key);
  const page=await f.s.page();await assert.rejects(f.s.preview('not-listed'),/当前分页/);
  page.rows[0].record.sha256='b'.repeat(64);const found=await f.s.preview(page.rows[0].recordId);
  assert.notEqual(found.source.chatKey,'forged');assert.equal(f.images,1);
  await f.s.page({tags:['missing']});await assert.rejects(f.s.preview(page.rows[0].recordId),/当前分页/);
});

test('opening the next version closes old reader and a fresh discovery clears stale selections',async t=>{
  const f=await fixture(t),list=await f.s.list();await f.s.open(list.entries[0].key);const old=await f.s.page();
  await f.s.open(list.entries[1].key);await assert.rejects(f.s.preview(old.rows[0].recordId));
  const next=await f.s.page();assert.notEqual(next.rows[0].recordId,old.rows[0].recordId);
  await f.s.list();await assert.rejects(f.s.page(),/选择已保存/);
});

test('account or host change cannot load records or images from a previous account',async t=>{
  const f=await fixture(t),list=await f.s.list();await f.s.open(list.entries[0].key);const page=await f.s.page(),calls=f.transport.calls.length;
  f.switchAccount();await assert.rejects(f.s.preview(page.rows[0].recordId),/账户已变化/);
  assert.equal(f.s.isClosed(),true);assert.equal(f.images,0);assert.equal(f.transport.calls.length,calls);
  const g=await fixture(t);g.invalidate();await assert.rejects(g.s.list(),/页面已变化/);
});

test('missing original media or record fails visibly without repair, writes, or generation fallback',async t=>{
  const f=await fixture(t,{loadImage:async()=>{throw Error('原图不存在');}}),list=await f.s.list();await f.s.open(list.entries[0].key);const page=await f.s.page();
  const before=f.transport.calls.length;await assert.rejects(f.s.preview(page.rows[0].recordId),/原图不存在/);
  const suffix=`gallery-record-${page.rows[0].record.sha256}.json`;
  const head=[...f.transport.files.keys()].find(name=>name.endsWith(suffix));f.transport.files.delete(head);
  await assert.rejects(f.s.preview(page.rows[0].recordId),/缺失/);
  assert.ok(f.transport.calls.slice(before).every(call=>call.options.method!=='POST'));
});

test('closing while account resolution is pending rejects promptly and prevents late I/O',async t=>{
  const wait=gate();let lists=0;
  const s=create({account:()=>wait.promise,headers:()=>({}),createDiscovery:()=>({list(){lists++;},close(){}})});t.after(()=>s.close());
  const reading=s.list();s.close();await assert.rejects(reading,/取消/);wait.resolve('st-user:alice');
  await new Promise(done=>setTimeout(done,0));assert.equal(lists,0);
});

test('deadline closes a stalled operation and disallows overlapping and subsequent work',async t=>{
  const wait=gate(),s=create({account:()=>wait.promise,headers:()=>({}),timeoutMs:100});t.after(()=>s.close());
  const pending=s.list();await assert.rejects(s.list(),/正在读取/);await assert.rejects(pending,/取消或超时/);
  assert.equal(s.isClosed(),true);await assert.rejects(s.open('x'),/页面已变化/);wait.resolve('st-user:alice');
});

test('late archive creation after close is released and cannot read its source',async t=>{
  const wait=gate();let closed=0,opened=0;
  const f=await fixture(t,{createArchive:()=>wait.promise}),list=await f.s.list(),opening=f.s.open(list.entries[0].key);
  await new Promise(done=>setTimeout(done,0));f.s.close();await assert.rejects(opening,/取消/);
  wait.resolve({close(){closed++;},openSourceVersion(){opened++;}});await new Promise(done=>setTimeout(done,0));
  assert.equal(closed,1);assert.equal(opened,0);
});

test('manifest changes and record metadata mismatch stop before media fetch',async t=>{
  const f=await fixture(t,{createArchive:async()=>({close(){},openSourceVersion:async()=>({reference:{sha256:'b'.repeat(64),bytes:2},close(){}})})});
  const list=await f.s.list();await assert.rejects(f.s.open(list.entries[0].key),/版本已变化/);assert.equal(f.images,0);
  const g=await fixture(t,{createArchive:async options=>{
    const real=await createGalleryArchiveStorage({...options,createStorage:g.transport.createStorage});
    return {...real,readRecord:async ref=>{const saved=await real.readRecord(ref);saved.record.id='mismatch';return saved;}};
  }}),items=await g.s.list();await g.s.open(items.entries[0].key);const page=await g.s.page();
  await assert.rejects(g.s.preview(page.rows[0].recordId),/记录与目录不一致/);assert.equal(g.images,0);
});
