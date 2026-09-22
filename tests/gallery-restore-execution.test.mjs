import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import {galleryChatSaveFixture as fixture,gate} from './helpers/gallery-chat-save-fixture.mjs';
import {createGalleryRestoreExecution} from '../qianmu-gallery-restore-execution.js';
import {createGalleryArchiveBrowser} from '../qianmu-gallery-archive-browser.js';

async function setup(t){const f=await fixture(t),names=[],locks={request:async(name,options,run)=>{names.push(name);assert.equal(options.ifAvailable,true);return run({});}};
  const open=extra=>createGalleryRestoreExecution({...f.options,selection:f.selection,preparation:f.prepared.reference,archive:f.archive,createJournal:f.journal,locks,...extra}).then(f.own);
  return {...f,get saves(){return f.saves;},set host(value){f.host=value;},open,names,locks};}
const consent=view=>({confirmed:true,expectedDigest:view.digest});

test('actual coordinator restores missing originals/recipes and exact chat, then explicitly ends only its verified journal',async t=>{
  const f=await setup(t);await fs.unlink(f.image);await fs.unlink(f.recipePath);const runtime=await f.open(),view=await runtime.preview();
  assert.equal(view.mode,'fresh');assert.equal(view.ready,true);assert.equal(view.assets.missing,1);assert.equal(f.saves,0);
  const result=await runtime.execute(consent(view));assert.equal(result.status,'restored');assert.equal(result.proof,'paged-chat-and-files-readback');assert.equal(f.saves,1);assert.equal(f.store.storyboardImages.length,3);
  assert.deepEqual(await fs.readFile(f.image),f.png);assert.notEqual(f.store.storyboardImages[0].snapshotServerRef.id,f.rows[0].snapshotServerRef.id);
  assert.equal((await f.journal().loadHistoricalChatMutation(f.account)).phase,'verified');await assert.rejects(runtime.finish());
  assert.equal((await runtime.finish({confirmed:true})).status,'finished');assert.equal(await f.journal().loadHistoricalChatMutation(f.account),null);assert.equal(f.saves,1);
  assert.deepEqual(f.names,[`qianmu:package-import:${f.account}`,`qianmu:character-restore:${f.account}`]);
});
test('refresh uses persisted paged journal, not a new preparation or file upload',async t=>{
  const f=await setup(t),a=await f.open();await a.execute(consent(await a.preview()));a.close();const start=f.calls.length,writes=f.transport.calls.filter(c=>c.path==='/api/files/upload').length;
  const b=await f.open({preparation:undefined}),view=await b.preview();assert.equal(view.mode,'recovery');assert.equal(view.status,'saved');assert.equal(view.ready,false);assert.equal(f.saves,1);
  assert.equal(f.transport.calls.filter(c=>c.path==='/api/files/upload').length,writes);assert.ok(f.calls.slice(start).every(c=>!c.url.endsWith('/restore')));await assert.rejects(b.execute(consent(view)));
});
test('failed host persistence refreshes to explicit retry, without restoring or selecting different recipes',async t=>{
  const f=await setup(t);f.host=()=>{};const a=await f.open(),first=await a.execute(consent(await a.preview()));assert.equal(first.status,'unconfirmed');assert.equal(f.saves,1);a.close();
  f.store.storyboardImages=[];const at=f.calls.length,b=await f.open({preparation:undefined}),view=await b.preview();assert.equal(view.mode,'recovery');assert.equal(view.ready,true);assert.equal(f.saves,1);
  f.host=()=>f.save();const result=await b.execute(consent(view));assert.equal(result.status,'restored');assert.equal(f.saves,2);assert.ok(f.calls.slice(at).every(c=>!c.url.endsWith('/restore')));
});
test('wrong chat, no preparation, busy-generation gate and wrong version cannot start restoration',async t=>{
  const f=await setup(t),before=f.transport.files.size;await assert.rejects(f.open({preparation:undefined}),/先准备/);await assert.rejects(f.open({canPrepare:()=>false}));
  await assert.rejects(f.open({selection:{...f.selection,scope:{...f.selection.scope,chatKey:'other'}}}),/准确/);
  await assert.rejects(f.open({selection:{...f.selection,manifest:{...f.selection.manifest,sha256:'0'.repeat(64)}}}),/另一图库/);
  assert.equal(f.transport.files.size,before);assert.equal(f.saves,0);
});
test('no consent, stale image preview or unavailable browser exclusion never invokes host or restores files',async t=>{
  const f=await setup(t),a=await f.open(),view=await a.preview();await assert.rejects(a.execute({...consent(view),confirmed:false}));await assert.rejects(a.execute({confirmed:true,expectedDigest:'stale'}));
  await fs.unlink(f.image);await assert.rejects(a.execute(consent(view)),/重新核对/);assert.equal(f.saves,0);await assert.rejects(fs.stat(f.image),{code:'ENOENT'});
  const b=await f.open({locks:{request:async(_,__,run)=>run(null)}}),other=await b.preview();await assert.rejects(b.execute(consent(other)),/另一页面/);assert.equal(f.saves,0);await assert.rejects(fs.stat(f.image),{code:'ENOENT'});
});
test('local edit after preview is preserved and prevents all restore writes',async t=>{
  const f=await setup(t);await fs.unlink(f.image);const a=await f.open(),view=await a.preview();f.store.storyboardCollections=[{id:'user-new'}];
  const at=f.calls.length;await assert.rejects(a.execute(consent(view)),/基线/);assert.equal(f.saves,0);assert.ok(f.calls.slice(at).every(c=>!c.url.endsWith('/restore')));assert.deepEqual(f.store.storyboardCollections,[{id:'user-new'}]);
});
test('closing coordinator during pending native host retains shared lock and journal for fresh read-only recovery',async t=>{
  const f=await setup(t),held=gate(),entered=gate();f.host=()=>{entered.resolve();return held.promise;};const a=await f.open(),view=await a.preview(),work=a.execute(consent(view));
  await entered.promise;a.close();await assert.rejects(work);await f.save();held.resolve();await new Promise(r=>setTimeout(r,10));
  const b=await f.open({preparation:undefined});assert.equal((await b.preview()).status,'saved');assert.equal(f.saves,1);
});
test('real archive browser lazily reaches preparation, preview, confirmed restoration and finishing through the runtime',async t=>{
  const f=await setup(t);f.transport.configure();const savedFetch=globalThis.fetch;
  globalThis.fetch=(url,options)=>String(url).startsWith('/api/plugins/qianmu-tts/')?f.options.fetchImpl(url,options):savedFetch(url,options);
  t.after(()=>globalThis.fetch=savedFetch);let connected=0;
  const browser=f.own(createGalleryArchiveBrowser({...f.options,createArchive:async()=>f.archive,
    createDiscovery:()=>({list:async()=>({entries:[{key:'a'.repeat(64),value:f.selection}]}),close(){}}),
    createRestoration:options=>{connected++;return createGalleryRestoreExecution({...options,createStorage:f.transport.createStorage,fetchImpl:f.options.fetchImpl,createJournal:f.journal,locks:f.locks});}}));
  await browser.list();await browser.open('a'.repeat(64));await browser.page();assert.equal(connected,0);await browser.prepare();assert.equal(connected,0);
  const preview=await browser.restorePreview();assert.equal(connected,1);assert.equal(f.saves,0);assert.equal((await browser.restore(consent(preview))).status,'restored');assert.equal(f.saves,1);
  assert.equal((await browser.finishRestore()).status,'finished');assert.equal(await f.journal().loadHistoricalChatMutation(f.account),null);
});
