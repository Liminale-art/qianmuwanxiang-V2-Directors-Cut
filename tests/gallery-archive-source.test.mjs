import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import {EventEmitter} from 'node:events';
import {createCurrentGalleryArchiveSession} from '../qianmu-gallery-archive-source.js';
import {createGalleryArchiveStorage} from '../qianmu-gallery-archive-storage.js';
import {createChatCharacterReceiptService} from '../qianmu-chat-character-receipt-service.js';
import {recipeClientFixture} from './helpers/recipe-client-fixture.mjs';
import {streamCheckpointTransport} from './helpers/stream-checkpoint-fixture.mjs';
import {createGalleryArchiveCoordinator} from '../qianmu-gallery-archive-coordinator.js';

const gate=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};};
async function fixture(t){
  const host=await recipeClientFixture(t),transport=streamCheckpointTransport(host.account),service=createChatCharacterReceiptService({dataRoot:host.root});
  const events=new EventEmitter();host.context.eventSource=events;
  let hook;const calls=[];
  const fetchImpl=async(url,options)=>{
    if(url==='/api/plugins/qianmu-tts/chat-gallery/recipe/read')return host.fetch(url,options);
    assert.equal(url,'/api/plugins/qianmu-tts/chat-gallery/receipt');const body=JSON.parse(options.body);calls.push({url,...options,body});
    if(hook){const result=await hook({body,options});if(result)return result;}
    try{return Response.json(await service.inspectGallery(host.req,body,{signal:options.signal}));}
    catch(error){return Response.json({ok:false,code:error.code},{status:error.status||400});}
  };
  t.after(()=>service.close());
  return {host,transport,events,calls,set hook(value){hook=value;},
    async open(options={}){const session=await createCurrentGalleryArchiveSession({getContext:()=>host.context,epoch:()=>host.epoch,
      account:async()=>host.account,fetchImpl,createStorage:transport.createStorage,...options});t.after(()=>session.close());return session;},
  };
}

test('exact saved chat -> native immutable record -> readback; no source save or original download',async t=>{
  const f=await fixture(t);f.host.rows[0].unknown={text:' untouched\r\n',flags:[false,0,null]};await f.host.save();
  const original=await fs.readFile(f.host.file),raw=structuredClone(f.host.rows[0]),session=await f.open();
  assert.equal(f.calls.length,0);assert.equal(f.transport.calls.length,0);
  const saved=await session.preserveRecord(raw.id),read=await session.readRecord(saved.reference);
  assert.deepEqual(read.record,raw);assert.deepEqual(f.host.rows[0],raw);assert.deepEqual(await fs.readFile(f.host.file),original);
  assert.equal(saved.sourceReceipt.proof,'read-only-snapshot');assert.equal(saved.sourceReceipt.count,1);
  assert.equal(saved.originalVerified,false);assert.equal(saved.canPrune,false);assert.equal(saved.recipeState,'inline');
  assert.equal(f.calls.length,2);
  for(const call of f.calls){assert.deepEqual(Object.keys(call.body).sort(),['expectedAccount','target','version']);
    assert.equal(call.headers.Authorization,undefined);assert.equal(call.headers['X-CSRF-Token'],'fixture-only');
    assert.equal(call.credentials,'same-origin');assert.equal(call.redirect,'error');}
});

test('batch uses two saved-source receipts, not one roundtrip per item; page body loads on demand',async t=>{
  const f=await fixture(t),base=f.host.rows[0];f.host.rows=[3,2,1].map(i=>({...base,id:'record-'+i,createdAt:i}));await f.host.save();
  const session=await f.open(),result=await session.stagePage(f.host.rows.map(row=>row.id));assert.equal(f.calls.length,2);
  const reader=await session.openStagedPage(result.descriptor),page=await reader.page({limit:2});
  assert.deepEqual(page.rows.map(row=>row.recordId),['record-3','record-2']);assert.equal(result.canPrune,false);reader.close();
});

test('unsaved edit including unknown metadata fails before a single native request',async t=>{
  const f=await fixture(t);f.host.rows[0].unknown='not saved';const session=await f.open();
  await assert.rejects(session.preserveRecord('image'),/尚未保存/);assert.equal(f.calls.length,1);assert.equal(f.transport.calls.length,0);
});

test('local edits after capture stop before receipt or native I/O',async t=>{
  const f=await fixture(t),session=await f.open();f.host.rows[0].snapshot.prompt='new';
  await assert.rejects(session.preserveRecord('image'),/已修改/);assert.equal(f.calls.length,0);assert.equal(f.transport.calls.length,0);
});

test('record-list replacement, host reload, chat epoch and event invalidate exact source',async t=>{
  for(const mutate of [f=>{f.host.rows=[...f.host.rows];},f=>{f.host.context.chat=[];},f=>{f.host.epoch++;},f=>{f.events.emit('chat_changed');}]){
    const f=await fixture(t),session=await f.open();mutate(f);
    await assert.rejects(async()=>session.preserveRecord('image'));assert.equal(f.calls.length,0);assert.equal(f.transport.calls.length,0);
  }
});

test('account changes in source resolver or native resolver never write to another account',async t=>{
  for(const change of [f=>{f.host.account='st-user:bob';},f=>{f.transport.namespace='st-user:bob';}]){
    const f=await fixture(t),session=await f.open();change(f);await assert.rejects(session.preserveRecord('image'));
    assert.equal(f.transport.calls.filter(call=>call.path==='/api/files/upload').length,0);
  }
});

test('server record changed during upload: retain copies, do not return success or alter source',async t=>{
  const f=await fixture(t),session=await f.open();let changed=false;
  f.transport.hook=async({path})=>{if(path==='/api/files/upload'&&!changed){changed=true;
    const header={chat_metadata:{story_director_liminale:{storyboardImages:[{...f.host.rows[0],unknown:'server edit'}]}}};
    await fs.writeFile(f.host.file,JSON.stringify(header)+'\n');}};
  await assert.rejects(session.preserveRecord('image'),error=>error.writeState==='unconfirmed'&&/尚未保存/.test(error.message));
  assert.equal(f.calls.length,2);assert.ok(f.transport.files.size>0);assert.equal(f.host.rows[0].unknown,undefined);
  assert.match(await fs.readFile(f.host.file,'utf8'),/server edit/);
});

test('local record changes during upload fail final verification without rolling back saved copies',async t=>{
  const f=await fixture(t),session=await f.open();let changed=false;
  f.transport.hook=async({path})=>{if(path==='/api/files/upload'&&!changed){changed=true;f.host.rows[0].unknown='live edit';}};
  await assert.rejects(session.preserveRecord('image'),error=>error.writeState==='unconfirmed'&&/已修改/.test(error.message));
  assert.equal(f.calls.length,1);assert.ok(f.transport.files.size>0);assert.equal(f.host.rows[0].unknown,'live edit');
});

test('close during source receipt cancels even an uncooperative response',async t=>{
  const f=await fixture(t),session=await f.open(),started=gate();f.hook=()=>{started.resolve();return new Promise(()=>{});};
  const pending=session.preserveRecord('image');await started.promise;session.close();
  await assert.rejects(pending,/取消|结束/);assert.equal(f.transport.calls.length,0);assert.equal(f.events.eventNames().length,0);
});

test('one operation at a time and retry does not rewrite identical objects',async t=>{
  const f=await fixture(t),session=await f.open(),started=gate(),release=gate();let waiting=true;
  f.hook=async()=>{if(waiting){waiting=false;started.resolve();await release.promise;}};
  const first=session.preserveRecord('image');await started.promise;
  await assert.rejects(session.preserveRecord('image'),/重复提交/);release.resolve();const saved=await first;
  const uploads=f.transport.calls.filter(call=>call.path==='/api/files/upload').length,again=await session.preserveRecord('image');
  assert.deepEqual(again.reference,saved.reference);assert.equal(f.transport.calls.filter(call=>call.path==='/api/files/upload').length,uploads);
});

test('unknown/duplicate selection cannot inject records and malformed IDs reject before I/O',async t=>{
  const f=await fixture(t),session=await f.open();
  for(const ids of [[],['missing'],['image','image'],[{id:'image'}]])await assert.rejects(async()=>session.stagePage(ids));
  assert.equal(f.calls.length,0);assert.equal(f.transport.calls.length,0);
  f.host.rows.push({...f.host.rows[0]});await assert.rejects(f.open(),/编号/);assert.equal(f.transport.calls.length,0);
});

test('oversize source and accessors reject without truncating or invoking getters',async t=>{
  const f=await fixture(t);f.host.rows[0].unknown='x'.repeat(2*1024*1024);
  await assert.rejects(f.open());delete f.host.rows[0].unknown;let getterCalls=0;
  Object.defineProperty(f.host.rows[0],'unknown',{enumerable:true,get(){getterCalls++;return 'must not read';}});
  await assert.rejects(f.open());assert.equal(getterCalls,0);assert.equal(f.calls.length,0);assert.equal(f.transport.calls.length,0);
});

test('legacy local recipe reference remains explicit, with no fabricated inline snapshot or cache lookup',async t=>{
  const f=await fixture(t);delete f.host.rows[0].snapshot;f.host.rows[0].snapshotRef='chat\u241fimage';await f.host.save();
  const original=structuredClone(f.host.rows[0]),session=await f.open(),result=await session.preserveRecord('image');
  assert.equal(result.recipeState,'local-reference');assert.deepEqual((await session.readRecord(result.reference)).record,original);
  assert.equal(result.originalVerified,false);assert.equal(result.canPrune,false);
});

test('missing/invalid backend receipt stops before native writes and never falls back to local settings',async t=>{
  for(const reply of [Response.json({ok:false},{status:404}),Response.json({ok:true,version:1}),new Response('html',{status:200})]){
    const f=await fixture(t),session=await f.open();f.hook=()=>reply;
    await assert.rejects(session.preserveRecord('image'));assert.equal(f.transport.calls.length,0);
  }
});

test('async or non-approving lifecycle guards are not accepted',async t=>{
  const f=await fixture(t);
  for(const guard of [async()=>true,()=>false,()=>undefined])await assert.rejects(f.open({guard}));
  assert.equal(f.calls.length,0);assert.equal(f.transport.calls.length,0);
});

test('chat switch during native upload prevents later page publication and releases event listeners',async t=>{
  const f=await fixture(t),session=await f.open();let switched=false;
  f.transport.hook=async({path})=>{if(path==='/api/files/upload'&&!switched){switched=true;f.events.emit('chat_changed');}};
  await assert.rejects(session.stagePage(['image']),error=>error.writeState==='unconfirmed');
  assert.equal(f.events.eventNames().length,0);assert.equal(f.calls.length,1);
  assert.ok(![...f.transport.files.values()].some(text=>text.includes('qianmu.gallery.index-page.v1')));
});

test('saved server recipe reference is preserved verbatim, never implicitly read or presented as materialized',async t=>{
  const f=await fixture(t),recipeClient=f.host.client(),preserved=await recipeClient.preserve(f.host.rows[0]);recipeClient.close();
  delete f.host.rows[0].snapshot;f.host.rows[0].snapshotServerRef=preserved.reference;await f.host.save();
  const raw=structuredClone(f.host.rows[0]),recipeCalls=f.host.calls.length,session=await f.open(),saved=await session.preserveRecord('image');
  assert.equal(saved.recipeState,'server-reference');assert.deepEqual((await session.readRecord(saved.reference)).record,raw);
  assert.equal(f.host.calls.length,recipeCalls);assert.equal(saved.canPrune,false);
});

test('complete source capture sorts only its index, publishes every page, and reopens without another source request',async t=>{
  const f=await fixture(t);f.host.rows=Array.from({length:130},(_,index)=>({id:'r'+index,createdAt:index,url:'/user/images/fixture.png',chatKey:'chat'}));await f.host.save();
  const original=structuredClone(f.host.rows),session=await f.open(),version=await session.preserveAll();
  assert.equal(version.total,130);assert.equal(version.pages,2);assert.equal(f.calls.length,2);assert.deepEqual(f.host.rows,original);
  session.close();const other=await f.open(),reader=await other.openSourceVersion(version.sourceReceipt);let cursor,ids=[];
  do{const page=await reader.page({limit:60,...(cursor?{cursor}:{})});ids.push(...page.rows.map(row=>row.recordId));cursor=page.cursor;}while(cursor);
  assert.deepEqual(ids,original.map(row=>row.id).reverse());assert.equal(f.calls.length,2);reader.close();
});

async function serverRecipe(f){
  const client=f.host.client(),original=structuredClone(f.host.rows[0].snapshot);
  try{const saved=await client.preserve(f.host.rows[0]);delete f.host.rows[0].snapshot;f.host.rows[0].snapshotServerRef=saved.reference;await f.host.save();return {original,reference:saved.reference};}
  finally{client.close();}
}

test('complete preservation materializes exact server recipe and fresh-device reads survive deletion of source chat and old recipe',async t=>{
  const f=await fixture(t),{original,reference}=await serverRecipe(f),raw=structuredClone(f.host.rows[0]),session=await f.open(),before=await fs.readFile(f.host.file);
  const saved=await session.preserveAll();assert.equal(saved.recipeCopies,1);assert.equal(saved.canPrune,false);
  assert.deepEqual(f.host.rows[0],raw);assert.deepEqual(await fs.readFile(f.host.file),before);
  const scope={...session.scope};session.close();await fs.unlink(f.host.file);await fs.unlink(f.host.archive+'/'+reference.id+'.json');
  const fresh=await createGalleryArchiveStorage({scope,guard:()=>true,verifyRecord:()=>false,createStorage:f.transport.createStorage});t.after(()=>fresh.close());
  const reader=await fresh.openSourceVersion(saved.sourceReceipt),page=await reader.page(),result=await fresh.readRecipe(page.rows[0].record);
  assert.deepEqual(result.snapshot,original);assert.equal(result.origin,'server-copy');assert.equal(result.originalVerified,false);
  assert.deepEqual((await fresh.readRecord(page.rows[0].record)).record,raw);
  assert.ok(f.host.calls.filter(call=>call.url.endsWith('/read')).every(call=>!Object.hasOwn(call.body,'snapshot')));reader.close();
});

test('repeated complete preservation keeps identical server copies and never rewrites a record or recipe',async t=>{
  const f=await fixture(t);await serverRecipe(f);const session=await f.open(),first=await session.preserveAll();
  const files=[...f.transport.files],posts=f.transport.calls.filter(call=>call.options.method==='POST').length,recipeReads=f.host.calls.filter(call=>call.url.endsWith('/read')).length;
  const again=await session.preserveAll();assert.deepEqual(again,first);assert.deepEqual([...f.transport.files],files);
  assert.equal(f.transport.calls.filter(call=>call.options.method==='POST').length,posts);
  assert.equal(f.host.calls.filter(call=>call.url.endsWith('/read')).length,recipeReads,'existing exact recipe copies need no source recipe API');
});

test('server recipe read failure prevents publication, keeps partial immutable copies and never changes live source',async t=>{
  const f=await fixture(t);await serverRecipe(f);const raw=structuredClone(f.host.rows),session=await f.open();
  f.host.fetch=async()=>Response.json({ok:false},{status:503});
  await assert.rejects(session.preserveAll(),error=>error.writeState==='unconfirmed');assert.deepEqual(f.host.rows,raw);
  assert.ok(f.transport.files.size>0);assert.ok(![...f.transport.files.keys()].some(name=>name.includes('-gallery-source-')));
});

test('recipe upload failure leaves prior record and original server recipe intact, without publishing incomplete version',async t=>{
  const f=await fixture(t),{reference}=await serverRecipe(f),session=await f.open();
  const original=await fs.readFile(f.host.archive+'/'+reference.id+'.json');
  f.transport.hook=async({path,options,json})=>path==='/api/files/upload'&&JSON.parse(options.body).name.includes('-gallery-recipe-')?json({},503):undefined;
  await assert.rejects(session.preserveAll(),error=>error.writeState==='unconfirmed');
  assert.deepEqual(await fs.readFile(f.host.archive+'/'+reference.id+'.json'),original);
  assert.ok(![...f.transport.files.keys()].some(name=>name.includes('-gallery-source-')));
});

test('local-only recipe remains unresolved after complete preservation, while inline and absent recipes keep their exact states',async t=>{
  const f=await fixture(t),base=f.host.rows[0];f.host.rows=[base,{...base,id:'local',createdAt:2,snapshot:undefined,snapshotRef:'legacy'}];
  delete f.host.rows[1].snapshot;f.host.rows.push({id:'none',createdAt:3,url:'/user/images/none.png'});await f.host.save();
  const session=await f.open(),saved=await session.preserveAll(),reader=await session.openSourceVersion(saved.sourceReceipt),page=await reader.page();
  const states={};for(const row of page.rows)states[row.recordId]=(await session.readRecipe(row.record)).state;
  assert.deepEqual(states,{none:'not-recorded',local:'local-reference',image:'available'});assert.equal(saved.recipeCopies,0);reader.close();
});

test('idle application coordinator -> exact saved source -> fresh native reader without another source write',async t=>{
  const f=await fixture(t),{original}=await serverRecipe(f),before=await fs.readFile(f.host.file),errors=[];let opens=0,result,scope;
  const document=new EventTarget();document.hidden=false;document.readyState='complete';
  const c=createGalleryArchiveCoordinator({getContext:()=>f.host.context,epoch:()=>f.host.epoch,isCurrent:()=>true,window:globalThis,document,quietMs:1,onError:e=>errors.push(e),
    connect:async options=>{opens++;const session=await f.open({guard:options.guard,yieldWork:options.yieldWork});scope=session.scope;
      return {...session,async preserveAll(){return result=await session.preserveAll();}};}});t.after(()=>c.close());
  const until=async predicate=>{for(let i=0;i<500;i++){if(predicate())return;await new Promise(r=>setTimeout(r,5));}assert.fail('bounded fixture wait expired');};
  assert.equal(f.calls.length,0);assert.equal(opens,0);for(let i=0;i<20;i++)c.schedule();await until(()=>c.status().state==='saved');
  assert.equal(opens,1);assert.equal(result.total,1);assert.equal(result.recipeCopies,1);assert.deepEqual(errors,[]);assert.deepEqual(await fs.readFile(f.host.file),before);
  const calls=f.calls.length,posts=f.transport.calls.filter(call=>call.options.method==='POST').length;
  c.schedule();await until(()=>opens===2&&!c.status().running);assert.equal(f.calls.length,calls);assert.equal(f.transport.calls.filter(call=>call.options.method==='POST').length,posts);
  const reader=await createGalleryArchiveStorage({scope,guard:()=>true,verifyRecord:()=>false,createStorage:f.transport.createStorage});t.after(()=>reader.close());
  const version=await reader.openSourceVersion(result.sourceReceipt),page=await version.page();assert.deepEqual((await reader.readRecipe(page.rows[0].record)).snapshot,original);version.close();
});

test('full preservation yields before each record and refuses publication after source changes during a pause',async t=>{
  const f=await fixture(t),base=f.host.rows[0];f.host.rows=[base,{...base,id:'next',createdAt:2}];await f.host.save();
  let yields=0,mutated=false;const session=await f.open({yieldWork:async()=>{yields++;if(!mutated&&f.transport.calls.some(call=>call.path==='/api/files/upload')){mutated=true;f.host.rows[0].unknown='changed while idle';}}});
  await assert.rejects(session.preserveAll(),/已修改/);assert.ok(yields>=4);assert.equal(mutated,true);
  assert.ok(![...f.transport.files.keys()].some(name=>name.includes('-gallery-source-')));assert.equal(f.host.rows[0].unknown,'changed while idle');
});

test('detached recipe reader still rejects an account change during a server response before sidecar publication',async t=>{
  const f=await fixture(t);await serverRecipe(f);const originalFetch=f.host.fetch;
  f.host.fetch=async(url,options)=>{const response=await originalFetch(url,options);f.host.account='st-user:bob';return response;};
  const session=await f.open();await assert.rejects(session.preserveAll(),/账户|核验|变化/);
  assert.ok(![...f.transport.files.keys()].some(name=>name.includes('-gallery-recipe-')||name.includes('-gallery-source-')));
});

test('one appended image fetches only its new recipe, and a fresh session reuses older native copies',async t=>{
  const f=await fixture(t),{original}=await serverRecipe(f),first=await f.open();await first.preserveAll();first.close();
  const next={...structuredClone(f.host.rows[0]),id:'next',createdAt:2,snapshot:original};delete next.snapshotServerRef;f.host.rows.push(next);await f.host.save();
  const client=f.host.client();try{next.snapshotServerRef=(await client.preserve(next)).reference;delete next.snapshot;}finally{client.close();}await f.host.save();
  const before=f.host.calls.filter(call=>call.url.endsWith('/read')).length,session=await f.open(),saved=await session.preserveAll();
  assert.equal(saved.total,2);assert.equal(saved.recipeCopies,2);
  const reads=f.host.calls.filter(call=>call.url.endsWith('/read')).slice(before);assert.equal(reads.length,1);assert.equal(reads[0].body.selection.recordId,'next');
  const reader=await session.openSourceVersion(saved.sourceReceipt),page=await reader.page();assert.equal(page.rows.length,2);
  for(const row of page.rows)assert.deepEqual((await session.readRecipe(row.record)).snapshot,original);reader.close();
});

test('existing exact native copy remains usable when the old server recipe file is gone, without recreating it',async t=>{
  const f=await fixture(t),{reference}=await serverRecipe(f),session=await f.open(),first=await session.preserveAll();session.close();
  await fs.unlink(f.host.archive+'/'+reference.id+'.json');const before=f.host.calls.length,other=await f.open();
  assert.deepEqual(await other.preserveAll(),first);assert.equal(f.host.calls.length,before);
  await assert.rejects(fs.stat(f.host.archive+'/'+reference.id+'.json'),error=>error.code==='ENOENT');
});

test('corrupt native recipe copy fails without silently re-reading, overwriting or publishing another version',async t=>{
  const f=await fixture(t);await serverRecipe(f);const session=await f.open(),saved=await session.preserveAll(),reader=await session.openSourceVersion(saved.sourceReceipt),page=await reader.page();reader.close();session.close();
  const head=[...f.transport.files.keys()].find(key=>key.endsWith(`gallery-recipe-${page.rows[0].record.sha256}.json`));f.transport.files.set(head,'broken');
  const files=[...f.transport.files],reads=f.host.calls.length,other=await f.open();await assert.rejects(other.preserveAll());
  assert.deepEqual([...f.transport.files],files);assert.equal(f.host.calls.length,reads);
});

test('a missing native recipe copy is recreated only from the exact saved original, never current settings',async t=>{
  const f=await fixture(t);await serverRecipe(f);const session=await f.open(),saved=await session.preserveAll(),reader=await session.openSourceVersion(saved.sourceReceipt),page=await reader.page();reader.close();session.close();
  const head=[...f.transport.files.keys()].find(key=>key.endsWith(`gallery-recipe-${page.rows[0].record.sha256}.json`));f.transport.files.delete(head);
  const before=f.host.calls.filter(call=>call.url.endsWith('/read')).length,other=await f.open();await other.preserveAll();
  assert.equal(f.host.calls.filter(call=>call.url.endsWith('/read')).length-before,1);assert.ok(f.transport.files.has(head));
});

test('401 saved originals are preserved in four complete pages, with no storage cap clipping',async t=>{
  const f=await fixture(t);f.host.rows=Array.from({length:401},(_,i)=>({id:'record-'+i,createdAt:i,url:'/user/images/'+i+'.png',unknown:{keep:i}}));await f.host.save();
  const before=await fs.readFile(f.host.file),session=await f.open(),saved=await session.preserveAll();assert.equal(saved.total,401);assert.equal(saved.pages,4);
  const reader=await session.openSourceVersion(saved.sourceReceipt),ids=[];let cursor;
  do{const page=await reader.page({limit:60,...cursor?{cursor}:{}});ids.push(...page.rows.map(row=>row.recordId));cursor=page.cursor;}while(cursor);
  assert.equal(new Set(ids).size,401);assert.equal(ids[0],'record-400');assert.equal(ids.at(-1),'record-0');
  assert.deepEqual(await fs.readFile(f.host.file),before);assert.equal(f.host.rows.length,401);reader.close();
});

test('newer append changes only the leading partial page, keeping the older full page content-addressed',async t=>{
  const f=await fixture(t),record=i=>({id:'record-'+i,createdAt:i,url:'/user/images/'+i+'.png'});
  f.host.rows=Array.from({length:130},(_,i)=>record(i));await f.host.save();const first=await f.open();await first.preserveAll();first.close();
  const pages=()=>new Map([...f.transport.files].map(([key,text])=>[key,JSON.parse(text)]).filter(([,body])=>body.schema==='qianmu.st-account-document.v1'&&body.value?.schema==='qianmu.gallery.index-page.v1'));
  const before=pages();assert.equal(before.size,2);const full=[...before].find(([,body])=>body.value.rows.length===128);assert.ok(full);
  f.host.rows.push(record(130));await f.host.save();const second=await f.open(),saved=await second.preserveAll(),after=pages();
  assert.equal(saved.total,131);assert.equal(saved.pages,2);assert.equal(after.size,before.size+1,'one new leading page, not rewrites of all page boundaries');
  assert.deepEqual(after.get(full[0]),full[1]);const reader=await second.openSourceVersion(saved.sourceReceipt),firstRows=await reader.page({limit:4});
  assert.deepEqual(firstRows.rows.map(row=>row.recordId),['record-130','record-129','record-128','record-127']);reader.close();
});
