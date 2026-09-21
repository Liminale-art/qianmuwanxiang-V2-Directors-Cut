import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import {EventEmitter} from 'node:events';
import {createCurrentGalleryArchiveSession} from '../qianmu-gallery-archive-source.js';
import {createChatCharacterReceiptService} from '../qianmu-chat-character-receipt-service.js';
import {recipeClientFixture} from './helpers/recipe-client-fixture.mjs';
import {streamCheckpointTransport} from './helpers/stream-checkpoint-fixture.mjs';

const gate=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};};
async function fixture(t){
  const host=await recipeClientFixture(t),transport=streamCheckpointTransport(host.account),service=createChatCharacterReceiptService({dataRoot:host.root});
  const events=new EventEmitter();host.context.eventSource=events;
  let hook;const calls=[];
  const fetchImpl=async(url,options)=>{
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
