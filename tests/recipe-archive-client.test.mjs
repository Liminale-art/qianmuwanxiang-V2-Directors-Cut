import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import * as fs from 'node:fs/promises';
import {recipeClientFixture,recipe} from './helpers/recipe-client-fixture.mjs';
import {storyboardFunctionSource as section} from './helpers/storyboard-form-fixture.mjs';
import {preserveCapturedSnapshotArchives} from '../qianmu-plan-archive-write.js';
import {RECIPE_ARCHIVE_LIMITS} from '../qianmu-recipe-archive-contract.js';
import {projectChatGalleryDetails} from '../qianmu-chat-gallery-details.js';
import {createStoryboardBundleConfiguration} from '../qianmu-storyboard-bundle-configuration.js';
import {createStoryboardDefaults} from '../qianmu-storyboard.js';

test('real saved source -> immutable server reference -> fresh device recipe, with no recipe upload or local cache',async t=>{
  const e=await recipeClientFixture(t),client=e.client(),before=await fs.readFile(e.file);
  const saved=await client.preserve(e.rows[0]);client.close();assert.deepEqual(await fs.readFile(e.file),before);
  const request=e.calls[0];assert.equal(request.credentials,'same-origin');assert.equal(request.cache,'no-store');assert.equal(request.redirect,'error');
  assert.deepEqual(Object.keys(request.body).sort(),['expectedAccount','selection','target','version']);assert.doesNotMatch(JSON.stringify(request.body),/original|workflow|snapshot|private body/);
  assert.equal(request.headers['X-CSRF-Token'],'fixture-only');assert.equal(request.headers.Authorization,undefined);
  e.rows[0].snapshotServerRef=saved.reference;delete e.rows[0].snapshot;await e.save();
  const fresh=e.client();const read=await fresh.read(structuredClone(e.rows[0]));fresh.close();
  assert.deepEqual(read.snapshot,recipe());assert.equal(read.origin,'server-archive');assert.equal(read.snapshot.payload.parameters.workflow.nodes.length,120);
  assert.equal((await fs.readdir(e.archive)).length,1);
});

test('unsaved changes, duplicate ids, same-name other characters and wrong accounts do not read or preserve guessed sources',async t=>{
  const e=await recipeClientFixture(t);
  for(const mode of ['unsaved','duplicate','character','account']){
    const original=structuredClone(e.rows);const client=e.client();
    if(mode==='unsaved')e.rows[0].snapshot.prompt='unsaved';
    if(mode==='duplicate')e.rows.push({...e.rows[0]});
    if(mode==='character')e.context.characters[0].avatar='Other.png';
    if(mode==='account')e.account='st-user:bob';
    await assert.rejects(client.preserve(e.rows[0]));client.close();
    e.rows=original;e.context.characters[0].avatar='Alice.png';e.account='st-user:alice';
  }
  await assert.rejects(fs.stat(e.archive),{code:'ENOENT'});
  e.rows[0].snapshot.prompt='not yet saved';const client=e.client();await assert.rejects(client.preserve(e.rows[0]));client.close();
});

test('response from a different record, revision, account, target or operation is refused',async t=>{
  const e=await recipeClientFixture(t);
  for(const change of [v=>{v.expectedAccount='st-user:'+'0'.repeat(64);},v=>{v.target.chatId='other';},v=>{v.selection.createdAt++;},
    v=>{v.selection.gallerySha256='0'.repeat(64);},v=>{v.selection.recordId='other';},v=>{v.proof='read-only-recipe';v.origin='saved-inline';v.snapshot=recipe();v.reference=null;}]){
    const client=e.client({fetchImpl:async(url,options)=>{const response=await e.fetch(url,options),value=await response.json();change(value);return Response.json(value);}});
    await assert.rejects(client.preserve(e.rows[0]));client.close();
  }
  const writer=e.client(),ref=(await writer.preserve(e.rows[0])).reference;writer.close();e.rows[0].snapshotServerRef=ref;delete e.rows[0].snapshot;await e.save();
  const client=e.client({fetchImpl:async(url,options)=>{const value=await (await e.fetch(url,options)).json();value.reference={...ref,id:ref.sha256+'-00000000-0000-4000-8000-000000000000'};return Response.json(value);}});
  await assert.rejects(client.read(e.rows[0]),/保存的版本/);client.close();
});

test('close, abort, account, gallery, source epoch and record replacement during response invalidate late receipts',async t=>{
  const e=await recipeClientFixture(t);
  for(const mode of ['close','abort','account','gallery','epoch','replace']){
    const original=structuredClone(e.rows),controller=new AbortController();let release,reached;
    const ready=new Promise(done=>{reached=done;});
    const client=e.client({fetchImpl:async(url,options)=>{const response=await e.fetch(url,options);reached();await new Promise(done=>{release=done;});return response;}});
    const pending=client.preserve(e.rows[0],{signal:controller.signal});const rejected=assert.rejects(pending);await ready;
    if(mode==='close')client.close();if(mode==='abort')controller.abort();if(mode==='account')e.account='st-user:bob';
    if(mode==='gallery')e.rows[0].snapshot.prompt='changed';if(mode==='epoch')e.epoch++;if(mode==='replace')e.rows=structuredClone(e.rows);
    release();await rejected;client.close();e.rows=original;e.account='st-user:alice';
  }
});

test('timeout covers unresolved identity, headers, fetch and response body; late headers do not dispatch',async t=>{
  const e=await recipeClientFixture(t);let release;
  for(const mode of ['account','headers','fetch','body']){
    let calls=0;const never=()=>new Promise(done=>{release=done;});
    const client=e.client({timeoutMs:100,...(mode==='account'?{account:never}:{}),...(mode==='headers'?{headers:never}:{}),
      fetchImpl:async()=>{calls++;return mode==='fetch'?never():new Response(new ReadableStream({start(){}}),{headers:{'Content-Type':'application/json'}});}});
    await assert.rejects(client.preserve(e.rows[0]),/取消|超时/);
    if(mode==='account'||mode==='headers'){release(mode==='account'?'st-user:alice':{});await new Promise(done=>setTimeout(done,10));assert.equal(calls,0);}
    if(mode==='fetch')release(Response.json({ok:false}));client.close();
  }
});

test('old backend, HTML, broken JSON, oversized and invalid UTF8 response bodies fail without returning partial recipes',async t=>{
  const e=await recipeClientFixture(t);
  for(const make of [()=>new Response('old',{status:404}),()=>new Response('old',{status:405}),()=>new Response('<html>',{headers:{'Content-Type':'text/html'}}),
    ()=>new Response('{',{headers:{'Content-Type':'application/json'}}),()=>new Response('x',{headers:{'Content-Type':'application/json','Content-Length':String(RECIPE_ARCHIVE_LIMITS.fileBytes+1)}}),
    ()=>new Response('x'.repeat(RECIPE_ARCHIVE_LIMITS.fileBytes+1),{headers:{'Content-Type':'application/json'}}),
    ()=>new Response(new Uint8Array([0xc3,0x28]),{headers:{'Content-Type':'application/json'}})]){
    const client=e.client({fetchImpl:async()=>make()});await assert.rejects(client.preserve(e.rows[0]));client.close();
  }
  assert.deepEqual(e.rows[0].snapshot,recipe());
});

function entry(e,options={}){
  const cache=new Map(),local=new Map();let writes=0,saves=0;
  const globals={console:{warn(){}},Date,JSON,Map,Error,clone:structuredClone,sanitizeStoryboardSnapshot:structuredClone,preserveCapturedSnapshotArchives,
    getChatKey:()=>e.context.chatId,storyboardSnapshotEpoch:e.epoch,storyboardSnapshotCache:cache,storyboardSnapshotReads:new Map(),storyboardGalleryRecords:()=>e.rows,
    storyboardPackageArchiveAllowed:async()=>true,storyboardRecipeArchiveClient:async()=>e.client(options),toast:()=>{},
    saveMetadata:async()=>{saves++;await e.save();},blobStore:{blobStoreAvailable:()=>true,
      putStoryboardSnapshots:async rows=>{writes++;for(const row of rows)local.set(row.key,structuredClone(row));return {stored:rows.map(row=>row.key)};},
      getStoryboardSnapshots:async keys=>keys.map(key=>local.get(key)).filter(Boolean)}};
  const c=vm.createContext(globals);vm.runInContext(['storyboardRecordChatKey','storyboardSnapshotKey','storyboardSnapshotForRecord','storyboardReadSnapshotForRecord',
    'storyboardStoreSnapshotForRecord','storyboardArchiveGallerySnapshots','storyboardHydrateGallerySnapshots'].map(section).join('\n'),c);
  return {c,cache,local,get writes(){return writes;},get saves(){return saves;}};
}

test('actual automatic archive writes the durable ref into saved metadata and a fresh device bypasses wrong legacy caches',async t=>{
  const e=await recipeClientFixture(t),a=entry(e);
  assert.equal(await a.c.storyboardArchiveGallerySnapshots(),1);assert.ok(e.rows[0].snapshotServerRef);assert.equal(e.rows[0].snapshot,undefined);
  const saved=JSON.parse((await fs.readFile(e.file,'utf8')).split('\n')[0]).chat_metadata.story_director_liminale.storyboardImages[0];
  assert.deepEqual(saved,e.rows[0]);assert.equal(a.saves,1);
  const b=entry(e);b.cache.set(e.rows[0].snapshotRef,{prompt:'WRONG OTHER ACCOUNT'});b.c.blobStore.blobStoreAvailable=()=>false;
  assert.equal(b.c.storyboardSnapshotForRecord(e.rows[0]),null);
  assert.deepEqual(await b.c.storyboardReadSnapshotForRecord(e.rows[0]),recipe());assert.equal(b.writes,0);
  assert.equal(await b.c.storyboardHydrateGallerySnapshots(e.rows,{migrate:false}),0);
});

test('actual explicit edit saves inline first and publishes a separate server recipe without changing the old file',async t=>{
  const e=await recipeClientFixture(t),a=entry(e);await a.c.storyboardArchiveGallerySnapshots();
  const ref=e.rows[0].snapshotServerRef,old=await fs.readFile(e.archive+'/'+ref.id+'.json');
  assert.equal(await a.c.storyboardStoreSnapshotForRecord(e.rows[0],recipe('edited')),true);
  assert.equal(e.rows[0].snapshotServerRef,undefined);assert.equal(e.rows[0].snapshot.prompt,'edited');
  await e.save();assert.equal(await a.c.storyboardArchiveGallerySnapshots([e.rows[0]]),1);
  assert.notEqual(e.rows[0].snapshotServerRef.id,ref.id);assert.deepEqual(await fs.readFile(e.archive+'/'+ref.id+'.json'),old);
  assert.equal((await entry(e).c.storyboardReadSnapshotForRecord(e.rows[0])).prompt,'edited');
});

test('actual old-backend fallback keeps local recipes; metadata failure restores inline and its original reference',async t=>{
  const e=await recipeClientFixture(t),a=entry(e,{fetchImpl:async()=>new Response('old',{status:404})});
  assert.equal(await a.c.storyboardArchiveGallerySnapshots(),1);assert.equal(e.rows[0].snapshotServerRef,undefined);assert.equal((await a.c.storyboardReadSnapshotForRecord(e.rows[0])).prompt,'original');
  e.rows[0].snapshot=recipe('retry');await e.save();const b=entry(e);b.c.saveMetadata=async()=>{throw Error('save failed');};
  assert.equal(await b.c.storyboardArchiveGallerySnapshots(),0);assert.equal(e.rows[0].snapshot.prompt,'retry');assert.equal(e.rows[0].snapshotServerRef,undefined);
  const c=entry(e);assert.equal(await c.c.storyboardArchiveGallerySnapshots(),1);assert.ok(e.rows[0].snapshotServerRef);
});

test('actual late local writes after account/source changes cannot publish refs or discard inline',async t=>{
  const e=await recipeClientFixture(t),a=entry(e);
  const put=a.c.blobStore.putStoryboardSnapshots;a.c.blobStore.putStoryboardSnapshots=async rows=>{const result=await put(rows);e.account='st-user:bob';return result;};
  assert.equal(await a.c.storyboardArchiveGallerySnapshots(),0);assert.ok(e.rows[0].snapshot);assert.equal(e.rows[0].snapshotServerRef,undefined);assert.equal(a.saves,0);
});

test('actual server read failures cannot silently fall back to legacy cache, logs or current settings',async t=>{
  const e=await recipeClientFixture(t),a=entry(e);await a.c.storyboardArchiveGallerySnapshots();
  const b=entry(e,{fetchImpl:async()=>new Response('offline',{status:503})});b.cache.set(e.rows[0].snapshotRef,recipe('wrong'));
  await assert.rejects(b.c.storyboardReadSnapshotForRecord(e.rows[0]));assert.equal(b.c.storyboardSnapshotForRecord(e.rows[0]),null);
});

test('generation details distinguish saved server references without claiming readability',()=>{
  const projected=projectChatGalleryDetails({id:'a',createdAt:0,snapshotServerRef:{version:1}});
  assert.equal(projected.generation.recipeState,'server-reference');
  assert.equal(projectChatGalleryDetails({id:'a',createdAt:0,snapshotServerRef:{},recipeUnavailable:true}).generation.recipeState,'unavailable');
  assert.equal(projectChatGalleryDetails({id:'a',createdAt:0,snapshotServerRef:{},snapshot:{}}).generation.recipeState,'inline');
});

test('bundle configuration refuses pointer-only imports and discards source-server pointers when full recipes travel',async()=>{
  const settings=createStoryboardDefaults(),chat={storyboardImages:[]},configuration=createStoryboardBundleConfiguration({namespace:'st-user:alice',chatKey:'chat',settings,chat,
    messages:()=>[],guard:async()=>{},isCurrent:()=>true,persist:async()=>{},journal:{prepareMutation:async row=>row,updateMutation:async()=>{}}});
  const id='imported',raw={id,source:'novel',snapshotServerRef:{id:'OTHER-SERVER'},snapshotRef:'OTHER-DEVICE'},
    input={fingerprint:'a'.repeat(64),settings:{},chat:{images:[raw],collections:[]},imageUrls:{[id]:'/user/images/Qianmu-Storyboards/import-'+'a'.repeat(64)+'.png'}};
  await assert.rejects(configuration.preview(input),/缺少原始配置/);assert.deepEqual(chat.storyboardImages,[]);
  raw.snapshot={...recipe(),source:'novel'};
  const preview=await configuration.preview(input);
  await configuration.apply({...input,expectedDigest:preview.digest});
  assert.equal(chat.storyboardImages[0].snapshotServerRef,undefined);assert.equal(chat.storyboardImages[0].snapshotRef,undefined);
  assert.ok(chat.storyboardImages[0].snapshot);assert.equal(raw.snapshotServerRef.id,'OTHER-SERVER');
});
