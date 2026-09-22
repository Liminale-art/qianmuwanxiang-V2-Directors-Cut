import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import {galleryChatSaveFixture as fixture,pagedConsent,gate} from './helpers/gallery-chat-save-fixture.mjs';
import {createGalleryWriteProposal} from '../qianmu-gallery-write-proposal.js';
import {createHistoricalChatMutation} from '../qianmu-historical-chat-journal.js';
import {acquireChatSaveLock,releaseChatSaveLock} from '../qianmu-chat-save-lock.js';

const native=async f=>f.journal().loadHistoricalChatMutation(f.account);
test('paged writer journals before ST save, keeps other modules and reads exact metadata/body/files back',async t=>{
  const f=await fixture(t),beforeBody=JSON.stringify(f.context.chat),store=f.store;f.store.otherModule={value:'untouched'};
  f.host=async()=>{assert.equal((await native(f)).phase,'submitted');assert.equal(f.store,f.context.chatMetadata.story_director_liminale);await f.save();};
  const result=await f.openWriter().save(pagedConsent);assert.equal(result.status,'saved');assert.equal(result.metadataVerified,true);assert.equal(result.canPrune,false);assert.equal(result.durableJournal,true);
  assert.equal(result.originalsVerified,1);assert.equal(result.recipesVerified,1);assert.equal(f.saves,1);assert.equal(f.store,store);assert.deepEqual(f.store.otherModule,{value:'untouched'});
  assert.equal(JSON.stringify(f.context.chat),beforeBody);assert.equal((await native(f)).phase,'verified');assert.deepEqual(f.store.storyboardImages,f.rows);
  assert.deepEqual(JSON.parse((await fs.readFile(f.file,'utf8')).split('\n')[0]).chat_metadata,f.context.chatMetadata);
  assert.ok(f.calls.some(c=>c.url.endsWith('/verify-restored')));assert.ok(!f.calls.some(c=>c.url.endsWith('/state')));
});

test('refresh of completed operation verifies without invoking ST again or restoring recipe files',async t=>{
  const f=await fixture(t),a=f.openWriter();assert.equal((await a.save(pagedConsent)).status,'saved');a.close();const calls=f.calls.length;
  assert.equal((await f.openWriter().recover()).status,'saved');assert.equal(f.saves,1);
  assert.ok(f.calls.slice(calls).every(c=>!c.url.endsWith('/restore')));
});

test('missing confirmation, current edits, body changes, wrong host and missing initialized slot do not write',async t=>{
  const f=await fixture(t);await assert.rejects(f.openWriter().save({confirmed:true}));assert.equal(f.saves,0);
  f.store.storyboardImages.push({...f.rows[1],id:'new-user-record'});await assert.rejects(f.openWriter().save(pagedConsent),/基线/);assert.equal(await native(f),null);
  f.store.storyboardImages=[];f.context.chat[0].mes+=' edited';await assert.rejects(f.openWriter().save(pagedConsent),/正文/);assert.equal(f.saves,0);
  f.context.characters[0].avatar='Other.png';assert.throws(()=>f.openWriter(),/准确/);f.context.characters[0].avatar='Alice.png';
  delete f.store.storyboardImages;await assert.rejects(f.openWriter().save(pagedConsent),/未初始化/);assert.equal(f.saves,0);
});

test('server-only gallery, companion, other module or narrative changes reject before live assignments and journal publication',async t=>{
  for(const kind of ['gallery','companion','other-module','body']){
    const f=await fixture(t),original=JSON.parse(f.originalFile.toString().split('\n')[0]);
    if(kind==='gallery')original.chat_metadata.story_director_liminale.storyboardImages=[f.rows[1]];
    if(kind==='companion')original.chat_metadata.story_director_liminale.storyboardCollections=[{id:'other',name:'edit'}];
    if(kind==='other-module')original.chat_metadata.otherPlugin={edited:'remotely'};
    const body=structuredClone(f.context.chat);if(kind==='body')body[0].mes+=' remote edit';
    await fs.writeFile(f.file,[JSON.stringify(original),...body.map(row=>JSON.stringify(row))].join('\n')+'\n');
    await assert.rejects(f.openWriter().save(pagedConsent));assert.equal(f.saves,0);assert.equal(f.store.storyboardImages.length,0);assert.equal(await native(f),null);
  }
});

test('missing original or recipe after resolved plan prevents host writes, without implicit repair',async t=>{
  for(const kind of ['image','recipe']){const f=await fixture(t);await fs.unlink(kind==='image'?f.image:f.recipePath);const at=f.calls.length;
    await assert.rejects(f.openWriter().save(pagedConsent));assert.equal(f.saves,0);assert.equal(f.store.storyboardImages.length,0);assert.equal(await native(f),null);
    assert.ok(f.calls.slice(at).every(c=>!c.url.endsWith('/restore')));
  }
});

test('native journal failure before any acknowledgement leaves live fields and saved chat unchanged',async t=>{
  const f=await fixture(t);f.transport.hook=({path})=>path==='/api/files/upload'?Response.json({}, {status:503}):null;
  await assert.rejects(f.openWriter().save(pagedConsent));assert.equal(f.saves,0);assert.equal(JSON.stringify(f.context.chatMetadata),f.live);assert.deepEqual(await fs.readFile(f.file),f.originalFile);
});

test('swallowed native failure is uncertain; refreshed saved-before requires explicit retry and never auto writes',async t=>{
  const f=await fixture(t);f.host=()=>{};const a=f.openWriter(),result=await a.save(pagedConsent);assert.equal(result.status,'unconfirmed');assert.equal(f.saves,1);a.close();
  f.store.storyboardImages=[];const b=f.openWriter();assert.equal((await b.recover()).reason,'confirmation_required');assert.equal(f.saves,1);await assert.rejects(b.retry());
  f.host=()=>f.save();assert.equal((await b.retry({confirmed:true})).status,'saved');assert.equal(f.saves,2);assert.equal((await b.verify()).status,'saved');assert.equal(f.saves,2);
});

test('host rejection after disk persistence is accepted only by full readback, not replay',async t=>{
  const f=await fixture(t);f.host=async()=>{await f.save();throw Error('reply lost');};assert.equal((await f.openWriter().save(pagedConsent)).status,'saved');assert.equal(f.saves,1);
});

test('host timeout/close keeps shared exclusion until the actual host promise settles',async t=>{
  const f=await fixture(t),hold=gate();f.host=()=>hold.promise;const a=f.openWriter({hostTimeoutMs:10});assert.equal((await a.save(pagedConsent)).reason,'host_pending');a.close();
  const token={};assert.equal(acquireChatSaveLock(f.store,token),false);await assert.rejects(f.openWriter().recover(),/上一项/);
  await f.save();hold.resolve();await new Promise(r=>setTimeout(r,10));assert.equal(acquireChatSaveLock(f.store,token),true);releaseChatSaveLock(f.store,token);
  assert.equal((await f.openWriter().recover()).status,'saved');assert.equal(f.saves,1);
});

test('another chat writer holds the same exclusion; closing an unused session cannot release it',async t=>{
  const f=await fixture(t),token={};assert.equal(acquireChatSaveLock(f.store,token),true);const a=f.openWriter();await assert.rejects(a.save(pagedConsent),/上一项/);a.close();
  assert.equal(acquireChatSaveLock(f.store,{}),false);releaseChatSaveLock(f.store,token);assert.equal(f.saves,0);
});

test('edited local fields during submitted journal commit remain untouched with durable uncertainty',async t=>{
  const f=await fixture(t);let changed=false;
  f.transport.hook=({path,options})=>{if(path==='/api/files/upload'){const value=JSON.parse(Buffer.from(JSON.parse(options.body).data,'base64').toString());
    if(value.value?.schema==='qianmu.historical-chat-journal.v1'&&value.value.phase==='submitted'){changed=true;f.store.storyboardImages=[{...f.rows[1],id:'user-edit'}];}}};
  assert.equal((await f.openWriter().save(pagedConsent)).status,'unconfirmed');assert.equal(changed,true);assert.equal(f.saves,0);assert.equal(f.store.storyboardImages[0].id,'user-edit');assert.equal((await native(f)).phase,'submitted');
});

test('post-save missing image or corrupted recipe keeps journal unverified and never reports completion',async t=>{
  for(const kind of ['image','recipe']){const f=await fixture(t);f.host=async()=>{await f.save();if(kind==='image')await fs.unlink(f.image);else await fs.writeFile(f.recipePath,'{}');};
    const result=await f.openWriter().save(pagedConsent);assert.equal(result.status,'unconfirmed');assert.equal(f.saves,1);assert.equal((await native(f)).phase,'submitted');
    const calls=f.calls.length;assert.equal((await f.openWriter().recover()).status,'unconfirmed');assert.equal(f.saves,1);assert.ok(f.calls.slice(calls).every(c=>!c.url.endsWith('/restore')));
  }
});

test('stale live before with already-saved server after asks reload without assigning or calling host',async t=>{
  const f=await fixture(t);await f.openWriter().save(pagedConsent);f.store.storyboardImages=[];
  const result=await f.openWriter().recover();assert.equal(result.reason,'reload_required');assert.equal(f.saves,1);assert.equal(f.store.storyboardImages.length,0);
});

test('verified journal cannot replay if the server is later rolled back',async t=>{
  const f=await fixture(t);await f.openWriter().save(pagedConsent);await fs.writeFile(f.file,f.originalFile);const b=f.openWriter();assert.equal((await b.recover()).status,'unconfirmed');
  const result=await b.retry({confirmed:true});assert.equal(result.status,'unconfirmed');assert.match(result.message,/重放/);assert.equal(f.saves,1);
});

test('another pending proposal or a changed revision cannot be adopted or retried',async t=>{
  const f=await fixture(t),proposal=createGalleryWriteProposal({prepared:f.source.metadata,resolved:f.resolved});proposal.evidenceDigest='e'.repeat(64);
  await f.journal().prepareHistoricalChatMutation(await createHistoricalChatMutation(proposal),{confirmed:true});await assert.rejects(f.openWriter().recover(),/不属于/);await assert.rejects(f.openWriter().save(pagedConsent),/待核对/);assert.equal(f.saves,0);
});

test('empty exact no-op verifies but does not publish a journal or invoke host',async t=>{
  const f=await fixture(t,{count:0,serverRecipe:false}),result=await f.openWriter().save(pagedConsent);assert.equal(result.status,'unchanged');assert.equal(result.metadataVerified,true);assert.equal(f.saves,0);assert.equal(await native(f),null);
});

test('closed or timed-out account wait cannot later dispatch a native save',async t=>{
  const f=await fixture(t),held=gate(),a=f.openWriter({account:()=>held.promise,timeoutMs:20});await assert.rejects(a.save(pagedConsent),/超时/);held.resolve(f.account);
  await new Promise(r=>setTimeout(r,10));assert.equal(f.saves,0);assert.equal(f.store.storyboardImages.length,0);
});

test('actual paged save exceeds 400 records and two MiB without using the legacy state endpoint',async t=>{
  const f=await fixture(t,{count:451,recordBytes:5000,serverRecipe:false});
  assert.ok(Buffer.byteLength(JSON.stringify(f.rows))>2*1024*1024);
  const result=await f.openWriter().save(pagedConsent);assert.equal(result.status,'saved');assert.equal(f.saves,1);
  assert.deepEqual(f.store.storyboardImages,f.rows);assert.equal((await native(f)).phase,'verified');
  assert.equal(JSON.parse((await fs.readFile(f.file,'utf8')).split('\n')[0]).chat_metadata.story_director_liminale.storyboardImages.length,451);
  assert.ok(f.calls.every(c=>!c.url.endsWith('/state')));assert.equal((await f.openWriter().recover()).status,'saved');assert.equal(f.saves,1);
});

test('remote edits during durable submitted publication stop before host assignment',async t=>{
  const f=await fixture(t);let changed=false;
  f.transport.hook=async({path,options})=>{if(path==='/api/files/upload'){const value=JSON.parse(Buffer.from(JSON.parse(options.body).data,'base64').toString());
    if(value.value?.schema==='qianmu.historical-chat-journal.v1'&&value.value.phase==='submitted'){
      changed=true;const head=JSON.parse(f.originalFile.toString().split('\n')[0]);head.chat_metadata.otherPlugin={value:'remote-edit'};
      await fs.writeFile(f.file,[JSON.stringify(head),...f.context.chat.map(row=>JSON.stringify(row))].join('\n')+'\n');
    }}};
  assert.equal((await f.openWriter().save(pagedConsent)).status,'unconfirmed');assert.equal(changed,true);assert.equal(f.saves,0);
  assert.equal(f.store.storyboardImages.length,0);assert.equal((await native(f)).phase,'submitted');assert.match(await fs.readFile(f.file,'utf8'),/remote-edit/);
});

test('non-writable destination is rejected before any partial assignment or journal write',async t=>{
  const f=await fixture(t);Object.defineProperty(f.store,'storyboardImages',{writable:false});
  await assert.rejects(f.openWriter().save(pagedConsent),/不可安全写入/);assert.equal(f.saves,0);assert.equal(JSON.stringify(f.context.chatMetadata),f.live);assert.equal(await native(f),null);
});

test('changed pending revision prevents explicit retry from overwriting another session',async t=>{
  const f=await fixture(t);f.host=()=>{};const a=f.openWriter();assert.equal((await a.save(pagedConsent)).status,'unconfirmed');
  const row=await native(f);await f.journal().updateHistoricalChatMutation(row,'uncertain');const result=await a.retry({confirmed:true});
  assert.equal(result.status,'unconfirmed');assert.match(result.message,/另一页面/);assert.equal(f.saves,1);
});

test('backend without file-verification endpoint fails safely instead of silently skipping proof',async t=>{
  const f=await fixture(t);f.state.hook=url=>url.endsWith('/verify-restored')?Response.json({error:'not installed'},{status:404}):null;
  await assert.rejects(f.openWriter().save(pagedConsent),/服务不可用/);assert.equal(f.saves,0);assert.equal(await native(f),null);assert.equal(f.store.storyboardImages.length,0);
});

test('account loss after host persistence stays unconfirmed and never submits another write',async t=>{
  const f=await fixture(t);f.host=async()=>{await f.save();f.state.active=false;};const result=await f.openWriter().save(pagedConsent);
  assert.equal(result.status,'unconfirmed');assert.equal(f.saves,1);f.state.active=true;assert.equal((await native(f)).phase,'submitted');
  assert.equal((await f.openWriter().recover()).status,'saved');assert.equal(f.saves,1);
});
