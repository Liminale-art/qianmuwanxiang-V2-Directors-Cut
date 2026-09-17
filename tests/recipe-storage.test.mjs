import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {recipeClientFixture} from './helpers/recipe-client-fixture.mjs';
import {createRecipeArchiveStore} from '../qianmu-recipe-archive-store.js';
import {recipeArchiveStorageRequest,recipeArchiveStorageResponse,RECIPE_ARCHIVE_LIMITS as LIMIT} from '../qianmu-recipe-archive-contract.js';
import {collectRecipeArchiveStorage} from '../qianmu-recipe-storage.js';
const account='st-user:'+createHash('sha256').update('alice').digest('hex');
const request={version:1,expectedAccount:account};
const response=()=>({ok:true,...request,state:'present',files:2,bytes:100,limitFiles:LIMIT.files,limitBytes:LIMIT.totalBytes,proof:'observed-file-sizes'});
const collect=options=>collectRecipeArchiveStorage({resolveNamespace:async()=>'st-user:alice',...options});
const deferred=()=>{let resolve;return {promise:new Promise(done=>resolve=done),resolve:value=>resolve(value)};};
async function store(t,f,io){const value=createRecipeArchiveStore({dataRoot:f.root,io:{...fs,...io}});t.after(()=>value.close());return value;}

test('storage protocol is account-only, exact, bounded and never confuses missing data with zero',()=>{
  assert.deepEqual(recipeArchiveStorageRequest(request),request);
  for(const value of [{...request,path:'file'},{...request,target:{kind:'group',chatId:'chat'}},{...request,expectedAccount:'st-user:alice'},{version:1}])assert.throws(()=>recipeArchiveStorageRequest(value));
  assert.deepEqual(recipeArchiveStorageResponse(response()),response());
  for(const value of [{...response(),bytes:null},{...response(),files:null},{...response(),files:0},{...response(),state:'absent'},{...response(),files:LIMIT.files+1},{...response(),limitBytes:1},{...response(),names:['private']}])assert.throws(()=>recipeArchiveStorageResponse(value));
  assert.equal(recipeArchiveStorageResponse({...response(),bytes:LIMIT.totalBytes+100}).bytes,LIMIT.totalBytes+100);
});

test('missing recipe folder is confirmed absent without creating it or requiring a selected chat',async t=>{
  const f=await recipeClientFixture(t);delete f.req.user.directories.chats;delete f.req.user.directories.groupChats;
  const result=await f.service.storage(f.req,request);assert.deepEqual(result,{...response(),state:'absent',files:0,bytes:0});
  await assert.rejects(fs.stat(f.archive),{code:'ENOENT'});
  await assert.rejects(f.service.storage(f.req,{...request,expectedAccount:'st-user:'+'b'.repeat(64)}),{code:'recipe_archive_account'});
});

test('file observation includes partial and unreferenced regular files without opening any payload',async t=>{
  const f=await recipeClientFixture(t),client=f.client();t.after(()=>client.close());const saved=await client.preserve(f.rows[0]);
  await fs.writeFile(path.join(f.archive,'unfinished.json'),'partial');await fs.writeFile(path.join(f.archive,'unknown'),'保留');
  const before=await fs.readFile(f.file),s=await store(t,f,{open:()=>assert.fail('payload open'),readFile:()=>assert.fail('payload read'),mkdir:()=>assert.fail('directory write'),unlink:()=>assert.fail('deletion')});
  assert.deepEqual(await s.usage(f.req,account),{state:'present',files:3,bytes:saved.reference.bytes+7+6});
  assert.deepEqual(await fs.readFile(f.file),before);assert.equal((await fs.readdir(f.archive)).length,3);
});

test('empty existing folder is present, and observed bytes above the write limit are not capped',async t=>{
  const f=await recipeClientFixture(t);await fs.mkdir(f.archive);
  assert.equal((await f.service.storage(f.req,request)).state,'present');
  const file=path.join(f.archive,'oversize');await fs.writeFile(file,'x');
  const s=await store(t,f,{async lstat(name,options){const value=await fs.lstat(name,options);if(name===file)value.size=BigInt(LIMIT.totalBytes+1);return value;}});
  assert.deepEqual(await s.usage(f.req,account),{state:'present',files:1,bytes:LIMIT.totalBytes+1});
});

test('directory, hardlink and junction entries fail closed instead of reporting a partial total',async t=>{
  const f=await recipeClientFixture(t);await fs.mkdir(f.archive);const unknown=path.join(f.archive,'entry');
  await fs.mkdir(unknown);await assert.rejects(f.service.storage(f.req,request),{code:'recipe_archive_path'});await fs.rmdir(unknown);
  await fs.link(f.file,unknown);await assert.rejects(f.service.storage(f.req,request),{code:'recipe_archive_path'});await fs.unlink(unknown);
  await fs.symlink(path.dirname(f.file),unknown,'junction');await assert.rejects(f.service.storage(f.req,request),{code:'recipe_archive_path'});
});

test('missing account root and unreadable directory do not become an empty archive or expose paths',async t=>{
  const f=await recipeClientFixture(t);f.req.user.directories.root=path.join(f.root,'missing');
  await assert.rejects(f.service.storage(f.req,request),{code:'recipe_archive_missing'});
  f.req.user.directories.root=path.join(f.root,'alice');await fs.mkdir(f.archive);
  const s=await store(t,f,{opendir:()=>{throw Error('SECRET PATH '+f.archive);}});
  await assert.rejects(s.usage(f.req,account),error=>error.code==='recipe_archive_storage'&&!error.message.includes(f.root));
});

test('too many entries refuse the whole observation and close the iterator',async t=>{
  const f=await recipeClientFixture(t);await fs.mkdir(f.archive);const file=path.join(f.archive,'sample');await fs.writeFile(file,'x');let closed=false;
  const s=await store(t,f,{opendir:async()=>({async *[Symbol.asyncIterator](){try{for(let i=0;i<=LIMIT.files;i++)yield {name:'count-'+i};}finally{closed=true;}}}),
    lstat:(name,options)=>fs.lstat(path.basename(name).startsWith('count-')?file:name,options)});
  await assert.rejects(s.usage(f.req,account),{code:'recipe_archive_capacity'});assert.equal(closed,true);
});

test('file changes between observations and directory changes reject stale sizes',async t=>{
  const f=await recipeClientFixture(t);await fs.mkdir(f.archive);const file=path.join(f.archive,'sample');await fs.writeFile(file,'x');
  for(const mode of ['file','directory']){let seen=0;const s=await store(t,f,{async lstat(name,options){const value=await fs.lstat(name,options);
    if(name===(mode==='file'?file:f.archive)&&++seen>=(mode==='file'?2:5))value.mtimeNs+=1n;return value;}});
    await assert.rejects(s.usage(f.req,account),{code:'recipe_archive_changed'});
  }
});

test('account switch, abort and closed service prevent publishing a pending file observation',async t=>{
  for(const mode of ['account','abort','close']){
    const f=await recipeClientFixture(t);await fs.mkdir(f.archive);const gate=deferred(),entered=deferred(),controller=new AbortController();
    const s=await store(t,f,{async opendir(name){entered.resolve();await gate.promise;return fs.opendir(name);}});
    const work=s.usage(f.req,account,{signal:controller.signal});const rejected=assert.rejects(work,{code:'recipe_archive_changed'});await entered.promise;
    let closing;if(mode==='account')f.req.user.profile.handle='bob';else if(mode==='abort')controller.abort();else closing=s.close();
    gate.resolve();await rejected;await closing;
  }
});

test('real client reads current-account server files, sends only CSRF and never selects a chat',async t=>{
  const f=await recipeClientFixture(t),client=f.client();t.after(()=>client.close());const saved=await client.preserve(f.rows[0]);f.context.chatId=undefined;
  const result=await collect({fetchImpl:f.fetch,headers:()=>({'X-CSRF-Token':'fixture','Authorization':'PRIVATE'})});
  assert.equal(result.namespace,'st-user:alice');assert.equal(result.status,'ready');assert.equal(result.files,1);assert.equal(result.bytes,saved.reference.bytes);
  const sent=f.calls.at(-1);assert.deepEqual(sent.body,request);assert.equal(sent.credentials,'same-origin');assert.equal(sent.cache,'no-store');assert.equal(sent.redirect,'error');
  assert.deepEqual(sent.headers,{'Content-Type':'application/json',Accept:'application/json','X-CSRF-Token':'fixture'});
});

test('old backend, errors, malformed and oversized bodies stay unavailable with null counts',async()=>{
  for(const result of [()=>new Response('old',{status:404}),()=>new Response('busy',{status:429}),()=>new Response('<html>'),
    ()=>new Response('{',{headers:{'content-type':'application/json'}}),()=>Response.json({...response(),expectedAccount:'st-user:'+'b'.repeat(64)}),
    ()=>Response.json({...response(),snapshot:{private:'body'}}),()=>new Response('x'.repeat(16385),{headers:{'content-type':'application/json'}}),
    ()=>new Response(new Uint8Array([0xff]),{headers:{'content-type':'application/json'}}),()=>{throw Error('private backend detail');}]){
    const value=await collect({fetchImpl:async()=>result()});assert.equal(value.status,'unavailable');assert.equal(value.bytes,null);assert.equal(value.files,null);assert.doesNotMatch(value.error,/private backend detail/);
  }
});

test('changed account or page cannot publish even a valid or failed backend reply',async()=>{
  for(const ok of [true,false]){let namespace='st-user:alice';await assert.rejects(collect({resolveNamespace:async()=>namespace,fetchImpl:async()=>{namespace='st-user:bob';return ok?Response.json(response()):new Response('',{status:404});}}),{code:'recipe_storage_stale'});}
  let valid=true;await assert.rejects(collect({valid:()=>valid,fetchImpl:async()=>{valid=false;return Response.json(response());}}),{code:'recipe_storage_stale'});
});

test('whole-operation timeout includes account and headers; late resolution cannot send requests',async()=>{
  for(const phase of ['account','headers']){const gate=deferred();let requests=0;
    const work=collect({timeoutMs:100,...(phase==='account'?{resolveNamespace:()=>gate.promise}:{headers:()=>gate.promise}),fetchImpl:async()=>{requests++;return Response.json(response());}});
    assert.equal((await work).status,'unavailable');gate.resolve(phase==='account'?'st-user:alice':{});await new Promise(done=>setTimeout(done,10));assert.equal(requests,0);
  }
});

test('stalled fetch and body are bounded and a late response is discarded',async()=>{
  const gate=deferred();let cancelled=false;
  const first=await collect({timeoutMs:100,fetchImpl:()=>gate.promise});assert.equal(first.status,'unavailable');
  gate.resolve(new Response(new ReadableStream({cancel(){cancelled=true;}}),{headers:{'content-type':'application/json'}}));await new Promise(done=>setTimeout(done,10));assert.equal(cancelled,true);
  cancelled=false;const second=await collect({timeoutMs:100,fetchImpl:async()=>new Response(new ReadableStream({cancel(){cancelled=true;}}),{headers:{'content-type':'application/json'}})});
  assert.equal(second.status,'unavailable');assert.equal(cancelled,true);
});
