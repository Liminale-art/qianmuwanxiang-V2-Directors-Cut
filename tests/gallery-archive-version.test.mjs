import test from 'node:test';
import assert from 'node:assert/strict';
import {createGalleryArchiveStorage} from '../qianmu-gallery-archive-storage.js';
import {chatGalleryReceiptText} from '../qianmu-chat-gallery-receipt.js';
import {vibeDigest} from '../qianmu-vibe-file.js';
import {streamCheckpointTransport} from './helpers/stream-checkpoint-fixture.mjs';

const row=(id,time=id)=>({id:String(id),createdAt:time,url:'/user/images/test.png',chatKey:'chat',tags:['test'],unknown:{unchanged:true}});
const proof=async records=>{const {text,...rest}=chatGalleryReceiptText(records);return {...rest,sha256:await vibeDigest(text),proof:'read-only-snapshot'};};
async function fixture(t){
  const scope={namespace:'st-user:archive-version',ownerKey:'char:Alice.png',chatKey:'chat'},transport=streamCheckpointTransport(scope.namespace);
  const open=async()=>{const store=await createGalleryArchiveStorage({scope,guard:()=>true,verifyRecord:()=>true,createStorage:transport.createStorage});t.after(()=>store.close());return store;};
  return {scope,transport,open,store:await open()};
}
const versions=f=>[...f.transport.files.values()].map(text=>JSON.parse(text)).filter(doc=>doc.value?.schema==='qianmu.gallery.source-version.v1');
const uploads=f=>f.transport.calls.filter(call=>call.path==='/api/files/upload').length;

test('multiple pages publish one immutable complete version; a fresh client finds it by exact source receipt',async t=>{
  const f=await fixture(t),records=[row(4),row(3),row(2),row(1)],receipt=await proof(records),pages=[];
  for(const batch of [records.slice(0,2),records.slice(2)])pages.push((await f.store.stagePage(batch)).descriptor);
  const published=await f.store.publishSourceVersion(receipt,pages);assert.equal(published.total,4);assert.equal(published.pages,2);
  assert.equal(published.canPrune,false);assert.equal(published.originalVerified,false);assert.equal(versions(f).length,1);
  f.store.close();const other=await f.open(),before=f.transport.calls.length,reader=await other.openSourceVersion(receipt);
  assert.equal(f.transport.calls.length-before,4); // Source pointer head/body and manifest head/body only.
  const list=await reader.page({limit:2});assert.equal(f.transport.calls.length-before,6);
  assert.deepEqual(list.rows.map(item=>item.recordId),['4','3']);assert.equal(list.hasMore,true);
  const next=await reader.page({limit:2,cursor:list.cursor});assert.deepEqual(next.rows.map(item=>item.recordId),['2','1']);assert.equal(next.hasMore,false);
  assert.deepEqual((await other.readRecord(list.rows[0].record)).record,records[0]);reader.close();
});

test('same full version is idempotent and source edits retain independently readable old versions',async t=>{
  const f=await fixture(t),a=[row(1)],ra=await proof(a),pa=(await f.store.stagePage(a)).descriptor;
  const first=await f.store.publishSourceVersion(ra,[pa]),count=uploads(f);
  const again=await f.store.publishSourceVersion(ra,[pa]);assert.deepEqual(first.reference,again.reference);assert.equal(uploads(f),count);
  const b=[{...a[0],unknown:{changed:true}}],rb=await proof(b),pb=(await f.store.stagePage(b)).descriptor;
  const second=await f.store.publishSourceVersion(rb,[pb]);assert.notEqual(second.reference.sha256,first.reference.sha256);assert.equal(versions(f).length,2);
  for(const [receipt,expected] of [[ra,a[0]],[rb,b[0]]]){
    const reader=await f.store.openSourceVersion(receipt),page=await reader.page();assert.deepEqual((await f.store.readRecord(page.rows[0].record)).record,expected);reader.close();
  }
});

test('missing or incomplete pages cannot publish a complete version',async t=>{
  const f=await fixture(t),records=[row(2),row(1)],receipt=await proof(records),page=(await f.store.stagePage([records[0]])).descriptor;
  const before=uploads(f);await assert.rejects(f.store.publishSourceVersion(receipt,[page]),/完整来源/);
  await assert.rejects(f.store.publishSourceVersion(receipt,[{...page,sha256:'a'.repeat(64)}]),/尚未/);
  assert.equal(uploads(f),before);assert.equal(versions(f).length,0);
});

test('page descriptors must belong to the current validated staging session',async t=>{
  const f=await fixture(t),records=[row(1)],receipt=await proof(records),page=(await f.store.stagePage(records)).descriptor;
  const other=await f.open();await assert.rejects(other.publishSourceVersion(receipt,[page]),/本次保全/);assert.equal(versions(f).length,0);
});

test('cross-page repeated IDs are rejected even with non-overlapping chronological bounds',async t=>{
  const f=await fixture(t),records=[row('same',3),row('same',1)],receipt=await proof(records),pages=[];
  for(const record of records)pages.push((await f.store.stagePage([record])).descriptor);
  const before=uploads(f);await assert.rejects(f.store.publishSourceVersion(receipt,pages),/跨页/);
  assert.equal(uploads(f),before);assert.equal(versions(f).length,0);
});

test('missing page during publication preserves staged records and never creates a version pointer',async t=>{
  const f=await fixture(t),records=[row(1)],receipt=await proof(records),page=(await f.store.stagePage(records)).descriptor;
  const name=[...f.transport.files.keys()].find(key=>key.endsWith(`gallery-page-${page.sha256}.json`));f.transport.files.delete(name);
  const before=uploads(f);await assert.rejects(f.store.publishSourceVersion(receipt,[page]),/缺失/);
  assert.equal(uploads(f),before);assert.equal(versions(f).length,0);assert.ok(f.transport.files.size>0);
});

test('different page partition for identical source never overwrites its existing directory',async t=>{
  const f=await fixture(t),records=[row(2),row(1)],receipt=await proof(records),first=(await f.store.stagePage(records)).descriptor;
  const original=await f.store.publishSourceVersion(receipt,[first]),pages=[];
  for(const record of records)pages.push((await f.store.stagePage([record])).descriptor);
  await assert.rejects(f.store.publishSourceVersion(receipt,pages),error=>error.writeState==='unconfirmed'&&/不同目录/.test(error.message));
  assert.equal(versions(f).length,1);const reader=await f.store.openSourceVersion(receipt);assert.deepEqual(reader.reference,original.reference);reader.close();
});

test('empty saved gallery has an explicit zero-record version; absent version is not empty success',async t=>{
  const f=await fixture(t),receipt=await proof([]);await assert.rejects(f.store.openSourceVersion(receipt),/尚无/);
  const result=await f.store.publishSourceVersion(receipt,[]);assert.equal(result.total,0);assert.equal(result.pages,0);
  const reader=await f.store.openSourceVersion(receipt),before=f.transport.calls.length,page=await reader.page();
  assert.deepEqual(page.rows,[]);assert.equal(page.hasMore,false);assert.equal(f.transport.calls.length,before);reader.close();
});

test('malformed source proof and foreign scope cannot discover another version',async t=>{
  const f=await fixture(t),records=[row(1)],receipt=await proof(records),page=(await f.store.stagePage(records)).descriptor;
  await f.store.publishSourceVersion(receipt,[page]);const before=f.transport.calls.length;
  for(const value of [{...receipt,extra:true},{...receipt,sha256:[receipt.sha256]},{...receipt,proof:'durable'}, {...receipt,count:-1}])await assert.rejects(f.store.openSourceVersion(value));
  assert.equal(f.transport.calls.length,before);
  const other=await createGalleryArchiveStorage({scope:{...f.scope,ownerKey:'char:Bob.png'},guard:()=>true,verifyRecord:()=>true,createStorage:f.transport.createStorage});t.after(()=>other.close());
  await assert.rejects(other.openSourceVersion(receipt),/尚无/);
});

test('failed version-head upload reports uncertainty; a later explicit retry retains original records',async t=>{
  const f=await fixture(t),records=[row(1)],receipt=await proof(records),page=(await f.store.stagePage(records)).descriptor;
  let failed=false;f.transport.hook=({path,options,json})=>{
    if(path==='/api/files/upload'){
      const body=JSON.parse(options.body),value=JSON.parse(Buffer.from(body.data,'base64').toString());
      if(!failed&&value.slot?.startsWith('gallery-source-')&&!Object.hasOwn(value,'value')){failed=true;return json({},503);}
    }
  };
  await assert.rejects(f.store.publishSourceVersion(receipt,[page]),error=>error.writeState==='unconfirmed');assert.equal(failed,true);
  await assert.rejects(f.store.openSourceVersion(receipt),/尚无/);f.transport.hook=null;
  await f.store.publishSourceVersion(receipt,[page]);const reader=await f.store.openSourceVersion(receipt);assert.equal((await reader.page()).rows.length,1);reader.close();
});
