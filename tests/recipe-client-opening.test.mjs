import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import {recipeClientFixture,recipe} from './helpers/recipe-client-fixture.mjs';
import {storyboardFunctionSource as section} from './helpers/storyboard-form-fixture.mjs';
import {chatGalleryDigest} from '../qianmu-chat-gallery-digest.js';

const deferred=()=>{let resolve;const promise=new Promise(yes=>resolve=yes);return {promise,resolve};};
const tick=()=>new Promise(done=>setTimeout(done,0));
function events(e){const emitter=new EventEmitter();e.context.eventSource=emitter;
  return {emitter,count:()=>emitter.eventNames().reduce((n,name)=>n+emitter.listenerCount(name),0)};}

test('opening yields through the complete gallery without network, mutation or a whole-library clone',async t=>{
  const e=await recipeClientFixture(t),base=e.rows[0];e.rows=Array.from({length:97},(_,i)=>({...structuredClone(base),id:'row-'+i,createdAt:i,
    future:{keep:[0,false,null,'',{'嵌套':'完整'}]},padding:'x'.repeat(16000)}));await e.save();
  const before=JSON.stringify(e.rows),expected=chatGalleryDigest(e.rows),ev=events(e);let yields=0,ticks=0;
  const heartbeat=setInterval(()=>ticks++,0);let client;
  try{client=await e.open({yieldWork:()=>{yields++;}});}finally{clearInterval(heartbeat);}
  t.after(()=>client?.close());assert.ok(yields>2);assert.ok(ticks>2);assert.equal(e.calls.length,0);assert.equal(JSON.stringify(e.rows),before);
  const result=await client.preserveBatch(e.rows.slice(0,8));assert.equal(result.gallerySha256,expected.sha256);assert.equal(ev.count(),5);
  assert.deepEqual((await client.read(e.rows[0])).snapshot,recipe());assert.equal(JSON.stringify(e.rows),before);client.close();assert.equal(ev.count(),0);
});

test('the live entry awaits the yielding opener and never calls the synchronous compatibility constructor',async t=>{
  const e=await recipeClientFixture(t),paused=deferred(),reached=deferred();let opened=0;
  const c=vm.createContext({Error,ctx:()=>e.context,storyboardSnapshotEpoch:0,storyboardGalleryRecords:()=>e.rows,
    featureRuntime:{load:async name=>{assert.equal(name,'recipeArchive');return {
      createCurrentRecipeArchiveClient:()=>assert.fail('sync constructor must not run in the live UI'),
      openCurrentRecipeArchiveClient:options=>{opened++;return e.open({...options,yieldWork:async()=>{reached.resolve();await paused.promise;}});}};}}});
  vm.runInContext(section('storyboardRecipeArchiveClient'),c);let settled=false;
  const pending=c.storyboardRecipeArchiveClient().then(client=>{settled=true;return client;});await reached.promise;
  assert.equal(settled,false);assert.equal(e.calls.length,0);paused.resolve();const client=await pending;t.after(()=>client.close());assert.equal(opened,1);
  assert.deepEqual((await client.read(e.rows[0])).snapshot,e.rows[0].snapshot);
});

test('source changes during module loading stop the actual entry before opening a client',async t=>{
  const e=await recipeClientFixture(t),pending=deferred();let opened=0;
  const c=vm.createContext({Error,ctx:()=>e.context,storyboardSnapshotEpoch:0,storyboardGalleryRecords:()=>e.rows,
    featureRuntime:{load:()=>pending.promise}});vm.runInContext(section('storyboardRecipeArchiveClient'),c);
  const work=c.storyboardRecipeArchiveClient(),rejected=assert.rejects(work,/聊天已变化/);c.storyboardSnapshotEpoch++;
  pending.resolve({openCurrentRecipeArchiveClient:()=>{opened++;}});await rejected;assert.equal(opened,0);
});

test('opening binds the initial account and rejects a later account even before the first request',async t=>{
  const e=await recipeClientFixture(t),ev=events(e),client=await e.open();e.account='st-user:bob';
  await assert.rejects(client.supportsBatch(),/账户/);assert.equal(e.calls.length,0);client.close();assert.equal(ev.count(),0);
});

test('account, epoch, gallery, messages and metadata changes while opening release every borrowed listener',async t=>{
  for(const mode of ['account','epoch','gallery','messages','metadata','rename','deleted','loaded-invalid']){
    const e=await recipeClientFixture(t),ev=events(e),ready=deferred(),gate=deferred();
    const pending=e.open({yieldWork:async()=>{ready.resolve();await gate.promise;}}),rejected=assert.rejects(pending);await ready.promise;
    if(mode==='account')e.account='st-user:bob';if(mode==='epoch')e.epoch++;if(mode==='gallery')e.rows=structuredClone(e.rows);
    if(mode==='messages')e.context.chat=[];if(mode==='metadata')e.context.chatMetadata=structuredClone(e.context.chatMetadata);
    if(mode==='rename')ev.emitter.emit('chat_renamed',{oldFileName:'chat.jsonl',avatarId:'Alice.png',newFileName:'new.jsonl'});
    if(mode==='deleted')ev.emitter.emit('chat_deleted','chat');
    if(mode==='loaded-invalid'){e.context.chatMetadata.integrity='changed';ev.emitter.emit('chat_loaded');}
    gate.resolve();await rejected;assert.equal(ev.count(),0);assert.equal(e.calls.length,0);assert.ok(e.rows[0].snapshot);
  }
});

test('normal trailing chat-loaded notification does not invalidate an unchanged opening',async t=>{
  const e=await recipeClientFixture(t),ev=events(e),client=await e.open({yieldWork:()=>ev.emitter.emit('chat_loaded')});
  assert.deepEqual((await client.read(e.rows[0])).snapshot,recipe());client.close();assert.equal(ev.count(),0);
});

test('pre-aborted opening does no account or network work and releases listeners',async t=>{
  const e=await recipeClientFixture(t),ev=events(e),abort=new AbortController();abort.abort();let accounts=0;
  await assert.rejects(e.open({signal:abort.signal,account:async()=>{accounts++;return e.account;}}),/取消/);
  assert.equal(accounts,0);assert.equal(e.calls.length,0);assert.equal(ev.count(),0);
});

test('abort or timeout while identity, guard or yielding is stalled settles promptly and late work cannot create a client',async t=>{
  for(const mode of ['account','guard','yield'])for(const cancel of ['abort','timeout']){
    const e=await recipeClientFixture(t),ev=events(e),ready=deferred(),gate=deferred(),controller=new AbortController();let reached=0;
    const wait=async()=>{reached++;ready.resolve();return gate.promise;},options={signal:controller.signal,timeoutMs:100};
    if(mode==='account')options.account=wait;if(mode==='guard')options.guard=wait;if(mode==='yield')options.yieldWork=wait;
    const pending=e.open(options),rejected=assert.rejects(pending,/取消|超时/);await ready.promise;
    if(cancel==='abort')controller.abort();await rejected;assert.equal(ev.count(),0);gate.resolve(mode==='account'?e.account:undefined);
    await tick();assert.equal(e.calls.length,0);assert.equal(ev.count(),0);assert.equal(reached,1);
  }
});

test('bad options, sparse rows, accessors and oversized originals fail closed without running getters or retaining listeners',async t=>{
  const e=await recipeClientFixture(t),ev=events(e),original=e.rows;
  for(const options of [{getGallery:null},{account:null},{guard:null},{timeoutMs:NaN},{yieldWork:1},{sourceSummary:{sha256:'0'.repeat(64)}}]){
    await assert.rejects(e.open(options));assert.equal(ev.count(),0);
  }
  let invoked=0;const bad={...original[0]};Object.defineProperty(bad,'future',{enumerable:true,get(){invoked++;return 'bad';}});
  for(const rows of [new Array(2),[bad],[{...original[0],oversized:'x'.repeat(2*1024*1024)}],undefined]){
    if(rows===undefined)await assert.rejects(e.open({getGallery:()=>undefined}));else{e.rows=rows;await assert.rejects(e.open());}
    assert.equal(ev.count(),0);
  }
  assert.equal(invoked,0);assert.equal(e.calls.length,0);e.rows=original;
});

test('a forged prepared digest option cannot replace the internally computed complete source',async t=>{
  const e=await recipeClientFixture(t),expected=chatGalleryDigest(e.rows),client=await e.open({prepared:{original:{sha256:'0'.repeat(64)},namespace:'st-user:bob'},original:{sha256:'0'.repeat(64)}});
  t.after(()=>client.close());const result=await client.preserve(e.rows[0]);assert.equal(result.selection.gallerySha256,expected.sha256);
});

test('unselected in-place edits behind the opening scan cannot pass the full pre-dispatch verification',async t=>{
  const e=await recipeClientFixture(t);e.rows=Array.from({length:40},(_,i)=>({id:'row-'+i,createdAt:i,...(i===0?{snapshot:recipe()}:{future:'initial'})}));await e.save();
  let yields=0;const client=await e.open({yieldWork:()=>{if(++yields===2)e.rows[1].future='changed after it was hashed';}});t.after(()=>client.close());
  await assert.rejects(client.preserve(e.rows[0]),/变化/);assert.equal(e.calls.length,0);assert.ok(e.rows[0].snapshot);
});

test('newly opened clients still reject unsaved content, duplicate selections and late response edits',async t=>{
  const e=await recipeClientFixture(t);e.rows[0].snapshot.prompt='unsaved';const client=await e.open();await assert.rejects(client.read(e.rows[0]));client.close();
  e.rows[0].snapshot.prompt='original';e.rows.push({...e.rows[0]});await e.save();const dupe=await e.open();const prior=e.calls.length;
  await assert.rejects(dupe.preserve(e.rows[0]),/重复/);assert.equal(e.calls.length,prior);dupe.close();
  e.rows.pop();await e.save();const changed=await e.open({fetchImpl:async(...args)=>{const result=await e.fetch(...args);e.rows[0].future='late';return result;}});
  await assert.rejects(changed.read(e.rows[0]),/变化/);changed.close();assert.ok(e.rows[0].snapshot);
});

test('opening and reading are compatible with exact group sources and unknown original fields',async t=>{
  const e=await recipeClientFixture(t);e.context.groupId='group';e.context.groups=[{id:'group',chat_id:'chat'}];
  await fs.mkdir(e.req.user.directories.groupChats,{recursive:true});
  await fs.writeFile(path.join(e.req.user.directories.groupChats,'chat.jsonl'),JSON.stringify({chat_metadata:e.context.chatMetadata})+'\n');
  const client=await e.open();t.after(()=>client.close());assert.deepEqual((await client.read(e.rows[0])).snapshot,recipe());
  assert.equal(e.calls[0].body.target.kind,'group');assert.equal(e.calls[0].body.target.avatar,undefined);
  assert.deepEqual(e.rows[0].snapshot,recipe());
});
