import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {recipeClientFixture,recipe} from './helpers/recipe-client-fixture.mjs';
import {chatGalleryDigest} from '../qianmu-chat-gallery-digest.js';
import {recipeArchiveBatchRequest,recipeArchiveBatchResponse,recipeArchiveBatchCapabilities,RECIPE_BATCH_LIMITS as LIMIT} from '../qianmu-recipe-batch-contract.js';
import {recipeArchiveErrorPayload} from '../qianmu-recipe-archive-contract.js';
import {createChatCharacterReceiptService} from '../qianmu-chat-character-receipt-service.js';
const account='st-user:'+createHash('sha256').update('alice').digest('hex'),target={kind:'character',avatar:'Alice.png',chatId:'chat'};
const input=rows=>({version:1,expectedAccount:account,target,gallerySha256:chatGalleryDigest(rows).sha256,selections:rows.map(row=>({recordId:row.id,createdAt:row.createdAt}))});
const setup=async(e,count=3)=>{e.rows=Array.from({length:count},(_,i)=>({id:'image-'+i,createdAt:i,source:'comfy',snapshot:recipe('prompt-'+i),unknown:'DO_NOT_RETURN'}));await e.save();return input(e.rows);};
const timeout={timeout:15000};

test('recipe batch request is selectors only and enforces exact account/source/unique ordered selections',()=>{
  const body=input([{id:'one',createdAt:1}]);assert.deepEqual(recipeArchiveBatchRequest(body),body);
  for(const patch of [{snapshot:recipe()},{path:'../file'},{reference:{}},{selections:[]},{selections:Array.from({length:9},(_,i)=>({recordId:String(i),createdAt:i}))},
    {selections:[body.selections[0],body.selections[0]]},{selections:[{...body.selections[0],snapshot:recipe()}]},
    {gallerySha256:'wrong'},{expectedAccount:'st-user:bob'},{target:{...target,chatId:'../escape'}},{version:2}])assert.throws(()=>recipeArchiveBatchRequest({...body,...patch}));
  assert.equal(LIMIT.records,8);assert.equal(LIMIT.snapshotBytes,2*1024*1024);
});
test('authenticated batch capability is read-only, exact and does not create recipe storage',timeout,async t=>{
  const e=await recipeClientFixture(t),before=await fs.readFile(e.file);
  const caps=e.service.batchCapabilities(e.req,{version:1,expectedAccount:account});assert.deepEqual(recipeArchiveBatchCapabilities(caps),caps);
  assert.equal(caps.canPrune,false);assert.equal(caps.selectorOnly,true);assert.equal(caps.maxRecords,8);
  for(const patch of [{extra:true},{canPrune:true},{selectorOnly:false},{maxRecords:9},{maxSnapshotBytes:LIMIT.snapshotBytes+1},{proof:'durable-recipe-batch'}])assert.throws(()=>recipeArchiveBatchCapabilities({...caps,...patch}));
  assert.throws(()=>e.service.batchCapabilities(e.req,{version:1,expectedAccount:'st-user:'+'0'.repeat(64)}));
  assert.throws(()=>e.service.batchCapabilities(e.req,{version:1,expectedAccount:account,snapshot:recipe()}));
  await assert.rejects(fs.stat(e.archive),{code:'ENOENT'});assert.deepEqual(await fs.readFile(e.file),before);
});
test('eight selected recipes use exactly two complete saved-header reads and return only ordered durable references',timeout,async t=>{
  let reads=0;const io={...fs,async open(file,...args){if(String(file).endsWith('chat.jsonl'))reads++;return fs.open(file,...args);}};
  const e=await recipeClientFixture(t,{io}),body=await setup(e,8),before=await fs.readFile(e.file);
  const result=await e.service.preserveBatch(e.req,body);assert.deepEqual(recipeArchiveBatchResponse(result),result);assert.equal(reads,2);
  assert.equal(result.records.length,8);assert.equal(result.canPrune,false);
  assert.deepEqual(result.records.map(row=>row.selection.recordId),body.selections.map(row=>row.recordId));
  assert.doesNotMatch(JSON.stringify(result),/DO_NOT_RETURN|"snapshot"|workflow|prompt-[0-9]/);
  assert.deepEqual(await fs.readFile(e.file),before);assert.equal((await fs.readdir(e.archive)).length,8);
  const beforeLegacy=reads;
  for(const selection of body.selections)await e.service.preserve(e.req,{version:1,expectedAccount:account,target,selection:{...selection,gallerySha256:body.gallerySha256}});
  assert.equal(reads-beforeLegacy,16);assert.deepEqual(await fs.readFile(e.file),before);assert.equal((await fs.readdir(e.archive)).length,8);
});
test('over 2 MiB saved source is fully verified twice while retaining only the selected recipe batch',timeout,async t=>{
  let reads=0;const io={...fs,async open(file,...args){if(String(file).endsWith('chat.jsonl'))reads++;return fs.open(file,...args);}};
  const e=await recipeClientFixture(t,{io});await setup(e,8);const selections=input(e.rows).selections;
  e.rows.push(...Array.from({length:5},(_,i)=>({id:'unselected-'+i,createdAt:100+i,unknown:'x'.repeat(450000)})));await e.save();
  const before=await fs.readFile(e.file);assert.ok(before.length>2*1024*1024);
  const result=await e.service.preserveBatch(e.req,{...input(e.rows),selections});assert.equal(result.records.length,8);assert.equal(reads,2);assert.deepEqual(await fs.readFile(e.file),before);
});
test('batch references round-trip every full recipe through a fresh ordinary client without uploading recipes',timeout,async t=>{
  const e=await recipeClientFixture(t),body=await setup(e,3),original=e.rows.map(row=>structuredClone(row.snapshot));
  const response=await e.fetch('/api/plugins/qianmu-tts/chat-gallery/recipe/preserve-batch',{body:JSON.stringify(body)}),result=await response.json();
  assert.equal(response.status,200);assert.equal(result.proof,'durable-recipe-batch');assert.deepEqual(e.calls[0].body,body);
  for(let i=0;i<e.rows.length;i++){e.rows[i].snapshotServerRef=result.records[i].reference;delete e.rows[i].snapshot;}await e.save();
  const fresh=e.client();try{for(let i=0;i<e.rows.length;i++)assert.deepEqual((await fresh.read(e.rows[i])).snapshot,original[i]);}finally{fresh.close();}
});
test('batch accepts a mix of exact saved inline and server recipes without replacing old immutable files',timeout,async t=>{
  const e=await recipeClientFixture(t);await setup(e,2);const client=e.client(),saved=await client.preserve(e.rows[0]);client.close();
  e.rows[0].snapshotServerRef=saved.reference;delete e.rows[0].snapshot;await e.save();
  const files=await fs.readdir(e.archive),before=await fs.readFile(e.archive+'/'+files[0]);
  const result=await e.service.preserveBatch(e.req,input(e.rows));assert.deepEqual(result.records[0].reference,saved.reference);
  assert.deepEqual(await fs.readFile(e.archive+'/'+files[0]),before);assert.equal((await fs.readdir(e.archive)).length,2);
});
test('batch response rejects omissions, reordering, different source/account and any prune claim',timeout,async t=>{
  const e=await recipeClientFixture(t),body=await setup(e,2),result=await e.service.preserveBatch(e.req,body);
  for(const change of [v=>v.records.pop(),v=>v.records.reverse(),v=>{v.canPrune=true;},v=>{v.extra=true;},
    v=>{v.records[0].expectedAccount='st-user:'+'0'.repeat(64);},v=>{v.records[0].selection.gallerySha256='0'.repeat(64);},
    v=>{v.records[0].target.chatId='other';},v=>{v.records[0].selection.createdAt++;},v=>{v.records[0].snapshot=recipe();}]){
    const value=structuredClone(result);change(value);assert.throws(()=>recipeArchiveBatchResponse(value));
  }
});
test('unsaved digest, missing/duplicate records, timestamp or account mismatch stop before any recipe storage',timeout,async t=>{
  const e=await recipeClientFixture(t),body=await setup(e,2);
  for(const patch of [{gallerySha256:'0'.repeat(64)},{expectedAccount:'st-user:'+'0'.repeat(64)},
    {selections:[{recordId:'missing',createdAt:0}]},{selections:[{recordId:e.rows[0].id,createdAt:123}]}])await assert.rejects(e.service.preserveBatch(e.req,{...body,...patch}));
  e.rows.push(structuredClone(e.rows[0]));await e.save();await assert.rejects(e.service.preserveBatch(e.req,{...body,gallerySha256:chatGalleryDigest(e.rows).sha256}));
  await assert.rejects(fs.stat(e.archive),{code:'ENOENT'});
});
test('missing, unavailable, credential-bearing or malformed last recipe cannot partially preserve earlier valid recipes',timeout,async t=>{
  const e=await recipeClientFixture(t);
  for(const change of [row=>{delete row.snapshot;row.snapshotRef='local-only';},row=>{row.recipeUnavailable=true;},
    row=>{row.snapshot.payload.apiKey='SYNTHETIC_SECRET';},row=>{row.snapshot={prompt:'partial'};}]){
    await setup(e,3);change(e.rows[2]);await e.save();await assert.rejects(e.service.preserveBatch(e.req,input(e.rows)));
    await assert.rejects(fs.stat(e.archive),{code:'ENOENT'});
  }
});
test('combined selected payload and individual recipe bounds remain explicit without clipping or writing',timeout,async t=>{
  const e=await recipeClientFixture(t);
  for(const [count,size] of [[3,740000],[1,1050000]]){
    await setup(e,count);for(const row of e.rows)row.snapshot.extra='x'.repeat(size);await e.save();const before=await fs.readFile(e.file);
    await assert.rejects(e.service.preserveBatch(e.req,input(e.rows)),error=>error.status===413);assert.deepEqual(await fs.readFile(e.file),before);
    await assert.rejects(fs.stat(e.archive),{code:'ENOENT'});
  }
});
test('unselected unknown-field change during a write invalidates the batch, keeps any durable copy and never alters source',timeout,async t=>{
  let e,changed=false;const io={...fs,async open(file,flags,...args){
    const handle=await fs.open(file,flags,...args);
    if(e&&String(file).endsWith('.json')&&flags==='wx'){
      const sync=handle.sync.bind(handle);handle.sync=async()=>{await sync();if(!changed){changed=true;e.rows.at(-1).unknown='new user edit';await e.save();}};
    }return handle;
  }};
  e=await recipeClientFixture(t,{io});await setup(e,3);const body=input(e.rows);body.selections.pop();
  await assert.rejects(e.service.preserveBatch(e.req,body));assert.equal(changed,true);
  assert.match(await fs.readFile(e.file,'utf8'),/new user edit/);assert.equal(e.rows.filter(row=>row.snapshot).length,3);
  assert.ok((await fs.readdir(e.archive)).length>=1);
});
test('account change and cancellation during the batch cannot publish a successful receipt',timeout,async t=>{
  for(const mode of ['account','abort','root','chatRoot']){
    let e,changed=false;const controller=new AbortController(),io={...fs,async open(file,flags,...args){
      const handle=await fs.open(file,flags,...args);
      if(e&&String(file).endsWith('.json')&&flags==='wx'){
        const sync=handle.sync.bind(handle);handle.sync=async()=>{await sync();if(!changed){changed=true;
          if(mode==='account')e.req.user.profile.handle='bob';else if(mode==='root')e.req.user.directories.root=e.root+'/different';
          else if(mode==='chatRoot')e.req.user.directories.chats=e.root+'/different-chats';else controller.abort();
        }};
      }
      return handle;
    }};
    e=await recipeClientFixture(t,{io});const body=await setup(e,2),before=await fs.readFile(e.file);
    await assert.rejects(e.service.preserveBatch(e.req,body,{signal:controller.signal}));assert.equal(changed,true);assert.deepEqual(await fs.readFile(e.file),before);
  }
});
test('source callback cannot escape its lifetime or mutate a selected recipe and still claim complete verification',timeout,async t=>{
  const e=await recipeClientFixture(t),body=await setup(e,2),source=createChatCharacterReceiptService({dataRoot:e.root});t.after(()=>source.close());
  let verify;await source.withGalleryRecipeBatch(e.req,body,lease=>{verify=lease.verify;return 1;});await assert.rejects(verify(),/已结束/);
  await assert.rejects(source.withGalleryRecipeBatch(e.req,body,lease=>{lease.records[0].snapshot.prompt='tampered';return 1;}));
  assert.equal(JSON.parse((await fs.readFile(e.file,'utf8')).split('\n')[0]).chat_metadata.story_director_liminale.storyboardImages[0].snapshot.prompt,'prompt-0');
});
test('final complete reread detects content changed behind metadata that falsely appears unchanged',timeout,async t=>{
  let e,headerReads=0,prior;const io={...fs,
    async lstat(file,options){const stat=await fs.lstat(file,options);if(e&&String(file)===e.file){prior??=stat;return prior;}return stat;},
    async open(file,...args){
      if(e&&String(file)===e.file&&++headerReads===2){e.rows.at(-1).unknown='late edit';await e.save();}
      const handle=await fs.open(file,...args);
      if(e&&String(file)===e.file)return {read:handle.read.bind(handle),close:handle.close.bind(handle),stat:async()=>prior};return handle;
    }};
  e=await recipeClientFixture(t,{io});const body=await setup(e,2);body.selections.pop();
  await assert.rejects(e.service.preserveBatch(e.req,body));assert.equal(headerReads,2);assert.match(await fs.readFile(e.file,'utf8'),/late edit/);
});
test('unexpected filesystem errors do not expose private paths through batch HTTP payloads',timeout,async t=>{
  const io={...fs,async open(file,...args){if(String(file).endsWith('chat.jsonl'))throw Error('PRIVATE_PATH_AND_SECRET');return fs.open(file,...args);}};
  const e=await recipeClientFixture(t,{io}),body=await setup(e,1);
  const response=await e.fetch('/api/plugins/qianmu-tts/chat-gallery/recipe/preserve-batch',{body:JSON.stringify(body)}),value=await response.json();
  assert.equal(value.ok,false);assert.doesNotMatch(JSON.stringify(value),/PRIVATE_PATH_AND_SECRET/);assert.ok(response.status>=400);
  assert.doesNotMatch(JSON.stringify(recipeArchiveErrorPayload(Error('private'))),/private/);
});
test('shared recipe request budget bounds concurrent batches and closed service cannot advertise or preserve',timeout,async t=>{
  let release,entered,count=0,released=false;
  const gate=new Promise(done=>{release=()=>{released=true;done();};}),ready=new Promise(done=>{entered=done;});
  const io={...fs,async open(file,...args){if(String(file).endsWith('chat.jsonl')&&!released){if(++count===4)entered();await gate;}return fs.open(file,...args);}};
  const e=await recipeClientFixture(t,{io}),body=await setup(e,1),tasks=Array.from({length:4},()=>e.service.preserveBatch(e.req,body));
  const results=Promise.allSettled(tasks);
  try{await ready;await assert.rejects(e.service.preserveBatch(e.req,body),error=>error.status===429);}finally{release();await results;}
  await e.service.close();assert.throws(()=>e.service.batchCapabilities(e.req,{version:1,expectedAccount:account}));await assert.rejects(e.service.preserveBatch(e.req,body));
});
test('group batch resolves the saved group source, not a same-named character chat',timeout,async t=>{
  const e=await recipeClientFixture(t);await setup(e,1);await fs.mkdir(e.req.user.directories.groupChats,{recursive:true});
  const groupRows=[{...e.rows[0],snapshot:recipe('GROUP_SOURCE')}];
  await fs.writeFile(e.req.user.directories.groupChats+'/chat.jsonl',JSON.stringify({chat_metadata:{story_director_liminale:{storyboardImages:groupRows}}})+'\n');
  const body={...input(groupRows),target:{kind:'group',chatId:'chat'}},result=await e.service.preserveBatch(e.req,body);
  assert.equal(result.target.kind,'group');const saved=JSON.parse(await fs.readFile(e.archive+'/'+result.records[0].reference.id+'.json','utf8'));
  assert.match(JSON.stringify(saved),/GROUP_SOURCE/);assert.match(await fs.readFile(e.file,'utf8'),/prompt-0/);
});
