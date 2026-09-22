import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import {galleryRestorePlanFixture} from './helpers/gallery-restore-plan-fixture.mjs';
import {prepareCurrentGalleryRestore} from '../qianmu-gallery-restore-runtime.js';
import {createGalleryRestorePlanStorage} from '../qianmu-gallery-restore-plan.js';
import {mergeGallerySupplement} from '../qianmu-gallery-merge-supplement.js';
import {emptyChatCharacterCollection} from '../qianmu-character-chat-batch.js';
import {createGalleryArchiveBrowser} from '../qianmu-gallery-archive-browser.js';
const prepare=(f,extra={})=>prepareCurrentGalleryRestore({...f.options,selection:f.selection,archive:f.archive,...extra});
const records=f=>[...f.transport.files.values()].map(value=>JSON.parse(value)).filter(row=>row.schema==='qianmu.st-account-document.v1').map(row=>row.value);
const plans=f=>records(f).filter(row=>row.schema==='qianmu.gallery.restore-plan.v1');
const owner={namespace:'st-user:alice',chatKey:'chat-one'};
async function readPlan(f,reference){const storage=f.own(await createGalleryRestorePlanStorage({scope:f.selection.scope,guard:()=>true,createStorage:f.transport.createStorage}));return storage.read(reference);}

test('explicit preparation saves paged references and current baseline, preserving order without changing live or saved chat',async t=>{
  const f=await galleryRestorePlanFixture(t),current=[{id:'new-current',createdAt:99,url:'/user/images/new.png',future:{keep:0}},f.rows[1]];
  f.store.storyboardImages=current;await f.save();const before=await fs.readFile(f.host.file),live=JSON.stringify(f.context.chatMetadata),progress=[];
  const result=await prepare(f,{onProgress:value=>progress.push(value)});assert.equal(result.compatible,true);assert.equal(result.added,2);assert.equal(result.kept,1);assert.equal(result.total,4);
  assert.equal(result.restoreReady,false);assert.equal(result.canPrune,false);assert.equal(result.persistence,'st-account-file');
  assert.deepEqual(await fs.readFile(f.host.file),before);assert.equal(JSON.stringify(f.context.chatMetadata),live);assert.equal(f.store.storyboardImages,current);
  const saved=await readPlan(f,result.reference);assert.deepEqual(saved.saved,f.store.storyboardCollections?{storyboardCollections:f.store.storyboardCollections}:{});
  const pages=records(f).filter(row=>row.schema==='qianmu.gallery.restore-page.v1').sort((a,b)=>a.start-b.start);
  assert.deepEqual(pages.flatMap(p=>p.rows.map(r=>r.recordId)),['new-current',f.rows[1].id,f.rows[0].id,f.rows[2].id]);
  assert.deepEqual(pages[0].rows.map(r=>r.origin),['baseline','baseline','source','source']);assert.ok(progress.some(p=>p.phase==='preserving'));
  assert.ok(f.calls.every(c=>!/\/state$|\/save/.test(c.url)));
});

test('more than 400 records prepare in bounded pages, remain readable by a new client and deduplicate repeated preparation',async t=>{
  const f=await galleryRestorePlanFixture(t,{count:451});f.store.storyboardImages=[];await f.save();const result=await prepare(f);
  assert.equal(result.total,451);const saved=await readPlan(f,result.reference);assert.deepEqual(saved.plan.pages.map(p=>p.count),[128,128,128,67]);
  assert.ok(saved.plan.pages.every(p=>p.bytes<128*1024));const uploads=f.transport.calls.filter(c=>c.path==='/api/files/upload').length;
  assert.deepEqual((await prepare(f)).reference,result.reference);assert.equal(f.transport.calls.filter(c=>c.path==='/api/files/upload').length,uploads);
});

test('gallery larger than 2 MiB prepares completely without putting record bodies into plan pages',async t=>{
  const f=await galleryRestorePlanFixture(t,{count:5,large:true});f.store.storyboardImages=[];await f.save();const result=await prepare(f),saved=await readPlan(f,result.reference);
  assert.ok(saved.plan.gallery.bytes>2*1048576);assert.equal(saved.plan.gallery.count,5);assert.ok(JSON.stringify(saved).length<10000);
  assert.ok(records(f).filter(r=>r.schema==='qianmu.gallery.restore-page.v1').every(r=>JSON.stringify(r).length<10000));
});

test('empty exact saved gallery remains a valid zero-page preparation',async t=>{
  const f=await galleryRestorePlanFixture(t,{count:0}),result=await prepare(f),saved=await readPlan(f,result.reference);
  assert.equal(result.total,0);assert.deepEqual(saved.plan.pages,[]);assert.equal(saved.plan.gallery.bytes,2);
});

test('same ID with changed content reports conflict, preserves current record and publishes no plan',async t=>{
  const f=await galleryRestorePlanFixture(t);f.store.storyboardImages=[{...f.rows[0],future:'changed'}];await f.save();
  const before=await fs.readFile(f.host.file),result=await prepare(f);assert.equal(result.compatible,false);assert.equal(result.conflicts,1);assert.equal(result.examples[0].id,f.rows[0].id);
  assert.equal(plans(f).length,0);assert.deepEqual(await fs.readFile(f.host.file),before);assert.equal(f.store.storyboardImages[0].future,'changed');
});

test('different companion record blocks publication even if image records agree',async t=>{
  const f=await galleryRestorePlanFixture(t);f.store.storyboardCollections[0].name='renamed';await f.save();const result=await prepare(f);
  assert.equal(result.compatible,false);assert.equal(result.examples[0].field,'storyboardCollections');assert.equal(plans(f).length,0);
});

test('wrong chat or unavailable generation gate refuses preparation before any new ST file writes',async t=>{
  const f=await galleryRestorePlanFixture(t),before=f.transport.files.size;
  await assert.rejects(prepare(f,{canPrepare:()=>false}),/仍在处理/);
  f.context.chatId='elsewhere';f.context.characters[0].chat='elsewhere';await assert.rejects(prepare(f),/准确原聊天/);
  assert.equal(f.transport.files.size,before);
});

test('changed narrative version is never mixed into the selected historical source',async t=>{
  const f=await galleryRestorePlanFixture(t);f.context.chat[0].mes+=' changed';await f.save();await assert.rejects(prepare(f),/相同正文/);assert.equal(plans(f).length,0);
});

test('unsaved gallery changes and edits during progress never produce a confirmed plan',async t=>{
  const f=await galleryRestorePlanFixture(t);f.store.storyboardImages=[];await assert.rejects(prepare(f),/尚未保存/);assert.equal(plans(f).length,0);
  await f.save();await assert.rejects(prepare(f,{onProgress:({phase})=>{if(phase==='source')f.context.chat[0].mes+=' changed';}}),/正文已修改/);assert.equal(plans(f).length,0);
});

test('cancellation or account-page guard change during streaming drops preparation without mutating original data',async t=>{
  for(const cancel of ['signal','page']){
    const f=await galleryRestorePlanFixture(t),controller=new AbortController(),before=JSON.stringify(f.context.chatMetadata);
    await assert.rejects(prepare(f,{signal:controller.signal,onProgress:({phase})=>{if(phase==='source'){if(cancel==='signal')controller.abort();else f.stop();}}}),/取消|来源|页面/);
    assert.equal(JSON.stringify(f.context.chatMetadata),before);assert.equal(plans(f).length,0);
  }
});

test('independent reader detects missing or corrupt plan pages, and never treats a partial plan as ready',async t=>{
  const f=await galleryRestorePlanFixture(t),result=await prepare(f);
  const keys=[...f.transport.files.keys()].filter(k=>k.includes('-gallery-restore-page-'));assert.ok(keys.length);
  const backup=new Map(keys.map(k=>[k,f.transport.files.get(k)]));for(const key of keys)f.transport.files.delete(key);
  await assert.rejects(readPlan(f,result.reference),/缺失/);
  for(const [key,text] of backup)f.transport.files.set(key,text.replace('"r1"','"forged"'));
  await assert.rejects(readPlan(f,result.reference),/校验|摘要|损坏/);
});

test('lost plan upload acknowledgement cannot report completion and leaves originals untouched',async t=>{
  const f=await galleryRestorePlanFixture(t),before=await fs.readFile(f.host.file);let hit=false;
  f.transport.hook=({path,options,files})=>{if(path==='/api/files/upload'){const body=JSON.parse(options.body);if(body.name.includes('-gallery-restore-plan-')){files.set(body.name,Buffer.from(body.data,'base64').toString());hit=true;throw Error('lost acknowledgement');}}};
  await assert.rejects(prepare(f));assert.equal(hit,true);assert.deepEqual(await fs.readFile(f.host.file),before);
});

test('supplement merge preserves missing fields, exact unknown data, draft ownership and current revision',async()=>{
  assert.deepEqual((await mergeGallerySupplement({}, {},owner)).saved,{});
  const draft=emptyChatCharacterCollection(owner);draft.future={kept:false};draft.revision=7;
  const incoming={...draft,revision:999};const result=await mergeGallerySupplement({characterDrafts:draft},{characterDrafts:incoming,storyboardCollections:[{id:'new',future:[null,0,false]}]},owner);
  assert.equal(result.saved.characterDrafts.revision,7);assert.deepEqual(result.saved.characterDrafts.future,{kept:false});assert.equal(result.added.storyboardCollections,1);
  const conflict=await mergeGallerySupplement({characterDrafts:draft},{characterDrafts:{...incoming,future:{kept:true}}},owner);assert.equal(conflict.saved,null);assert.equal(conflict.conflicts.length,1);
});

test('supplement merge rejects duplicate IDs, wrong ownership or credential fields instead of dropping them',async()=>{
  await assert.rejects(mergeGallerySupplement({}, {storyboardCollections:[{id:'a'},{id:'a'}]},owner),/重复/);
  await assert.rejects(mergeGallerySupplement({}, {characterDrafts:emptyChatCharacterCollection({...owner,namespace:'st-user:other'})},owner));
  await assert.rejects(mergeGallerySupplement({}, {storyboardCollections:[{id:'a',apiKey:'do not copy'}]},owner));
});

test('actual browser action lazily loads the runtime and preserves data only on explicit preparation',async t=>{
  const f=await galleryRestorePlanFixture(t);f.store.storyboardImages=[];await f.save();f.transport.configure();
  const priorFetch=globalThis.fetch;globalThis.fetch=f.options.fetchImpl;t.after(()=>{globalThis.fetch=priorFetch;});
  const browser=f.own(createGalleryArchiveBrowser({...f.options,createArchive:async()=>f.archive,
    createDiscovery:()=>({list:async()=>({entries:[{key:'a'.repeat(64),value:f.selection}]}),close(){}})}));
  const start=f.transport.calls.length;await browser.list();await browser.open('a'.repeat(64));await browser.page();
  assert.ok(f.transport.calls.slice(start).every(c=>c.options.method!=='POST'));assert.equal(plans(f).length,0);
  const result=await browser.prepare();assert.equal(result.compatible,true);assert.equal(result.total,3);assert.equal(f.store.storyboardImages.length,0);
  assert.equal((await browser.page()).rows.length,3);assert.equal(result.restoreReady,false);
});

test('plan publication requires the staged pages in this session, rechecks them before the head and rejects a false verifier',async t=>{
  const f=await galleryRestorePlanFixture(t),result=await prepare(f),saved=await readPlan(f,result.reference);
  const {schema,scope,supplement,...input}=saved.plan;
  const storage=f.own(await createGalleryRestorePlanStorage({scope,guard:()=>true,createStorage:f.transport.createStorage}));
  await assert.rejects(storage.publish(input,{saved:saved.saved,verify:()=>false}),/尚未完整验证/);
  await assert.rejects(storage.publish(input,{saved:saved.saved,verify:()=>true}),/未核验的分页/);
  const pages=records(f).filter(v=>v.schema==='qianmu.gallery.restore-page.v1');for(const page of pages)await storage.stagePage(page.rows,page.start);
  for(const key of [...f.transport.files.keys()])if(key.includes('-gallery-restore-plan-')||key.includes('-gallery-restore-page-'))f.transport.files.delete(key);
  await assert.rejects(storage.publish(input,{saved:saved.saved,verify:()=>true}),/缺失/);assert.equal(plans(f).length,0);
});

test('plan read rejects foreign account and a closed reader',async t=>{
  const f=await galleryRestorePlanFixture(t),result=await prepare(f);
  await assert.rejects(createGalleryRestorePlanStorage({scope:{...f.selection.scope,namespace:'st-user:other'},guard:()=>true,createStorage:f.transport.createStorage}),/账户/);
  const storage=await createGalleryRestorePlanStorage({scope:f.selection.scope,guard:()=>true,createStorage:f.transport.createStorage});storage.close();await assert.rejects(storage.read(result.reference),/来源已变化/);
});
