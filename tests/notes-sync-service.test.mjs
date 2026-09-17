import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {createNotesSyncService} from '../qianmu-notes-sync-service.js';
import {NOTES_SYNC_LIMITS,NOTES_SYNC_SCHEMA,notesSyncErrorPayload} from '../qianmu-notes-sync-contract.js';
import {imageServiceAccount} from '../qianmu-image-service-access.js';
import {init,exit} from '../server-plugin.js';
const account=handle=>imageServiceAccount({user:{profile:{handle}}}).namespace;
const input=(patch={})=>({version:1,expectedAccount:account('alice'),id:'note-one',baseRevision:0,note:{title:'旧标题',body:'完整正文\n第二行 😄',pinned:false,createdAt:1},deleted:false,mutationId:randomUUID(),...patch});
const gate=()=>{let release;const promise=new Promise(resolve=>release=resolve);return {promise,release};};
async function fixture(t,options={}){
  const parent=await fs.realpath(os.tmpdir()),root=await fs.mkdtemp(path.join(parent,'qianmu-notes-sync-test-')),userRoot=path.join(root,'alice');await fs.mkdir(userRoot);
  const request={user:{profile:{handle:'alice',enabled:true},directories:{root:userRoot}}},services=[];
  const create=extra=>{const service=createNotesSyncService({dataRoot:root,...options,...extra});services.push(service);return service;};
  const service=create();
  t.after(async()=>{await Promise.all(services.map(service=>service.close()));const real=await fs.realpath(root);assert.equal(path.dirname(real),parent);assert.match(path.basename(real),/^qianmu-notes-sync-test-/);await fs.rm(real,{recursive:true});});
  return {root,userRoot,request,service,create,file:path.join(userRoot,'.qianmu-notes-sync-v1.json'),lock:path.join(userRoot,'.qianmu-notes-sync-v1.lock')};
}
test('list is non-initializing, authenticated and bound to the host account directory',async t=>{
  const f=await fixture(t);assert.deepEqual(await f.service.list(f.request),{ok:true,version:1,expectedAccount:account('alice'),revision:0,notes:[]});assert.deepEqual(await fs.readdir(f.userRoot),[]);
  await assert.rejects(f.service.list({}),{status:401});await assert.rejects(f.service.write(f.request,input({expectedAccount:account('bob')})),{status:401});
  for(const patch of [{path:f.root},{x:0},{namespace:'alice'}])await assert.rejects(f.service.write(f.request,{...input(),...patch}),{status:400});
  f.request.user.directories.root=f.root;await assert.rejects(f.service.list(f.request),{status:403});
  assert.throws(()=>createNotesSyncService({dataRoot:path.parse(f.root).root}));
});
test('all notes including unpinned originals persist across service restarts and independent accounts stay separate',async t=>{
  const f=await fixture(t),first=await f.service.write(f.request,input());assert.equal(first.note.pinned,false);assert.equal(first.revision,1);
  const reopened=f.create();assert.deepEqual((await reopened.list(f.request)).notes,[first.note]);
  const bobRoot=path.join(f.root,'bob');await fs.mkdir(bobRoot);const bob={user:{profile:{handle:'bob'},directories:{root:bobRoot}}};
  assert.deepEqual((await reopened.list(bob)).notes,[]);await reopened.write(bob,input({expectedAccount:account('bob'),note:{title:'B',body:'B only',pinned:true,createdAt:1}}));
  assert.deepEqual((await reopened.list(f.request)).notes,[first.note]);assert.doesNotMatch(JSON.stringify(await reopened.list(bob)),/完整正文|qianmu-notes-sync-test/);
});
test('same mutation retries are durable and exact, including retry after another device updates the note',async t=>{
  const f=await fixture(t),one=input(),first=await f.service.write(f.request,one),before=await fs.readFile(f.file);
  assert.deepEqual(await f.service.write(f.request,one),first);assert.deepEqual(await fs.readFile(f.file),before);
  const second=await f.service.write(f.request,input({baseRevision:1,note:{...one.note,body:'second device'}}));assert.equal(second.revision,2);
  const reopened=f.create();assert.deepEqual(await reopened.write(f.request,one),first);assert.equal((await reopened.list(f.request)).notes[0].body,'second device');
  await assert.rejects(reopened.write(f.request,{...one,note:{...one.note,body:'wrong replay'}}),{code:'notes_sync_mutation_conflict'});
});
test('per-note CAS preserves both independent edits and supplies current original on conflicts',async t=>{
  const f=await fixture(t),one=input(),a=await f.service.write(f.request,one);await f.service.write(f.request,input({id:'another'}));
  const b=await f.service.write(f.request,input({baseRevision:a.revision,note:{...one.note,body:'first writer'}}));assert.equal(b.revision,3);
  let error;try{await f.service.write(f.request,input({baseRevision:a.revision,note:{...one.note,body:'stale writer'}}));}catch(value){error=value;}
  const conflict=notesSyncErrorPayload(error);assert.equal(conflict.status,409);assert.equal(conflict.body.note.body,'first writer');assert.equal(conflict.body.revision,3);
  assert.equal((await f.service.list(f.request)).notes.length,2);assert.equal((await f.service.list(f.request)).revision,3);
  await assert.rejects(f.service.write(f.request,input({baseRevision:3,note:{...one.note,createdAt:2}})),{status:400});
});
test('explicit deletes retain empty tombstones and stale devices cannot resurrect their old IDs',async t=>{
  const f=await fixture(t),one=input();await f.service.write(f.request,one);
  const remove=input({baseRevision:1,deleted:true}),gone=await f.service.write(f.request,remove);
  assert.equal(gone.note.deleted,true);assert.equal(gone.note.body,'');assert.equal(gone.note.title,'');assert.equal(gone.note.pinned,false);
  assert.deepEqual(await f.service.write(f.request,remove),gone);assert.deepEqual((await f.service.list(f.request)).notes,[gone.note]);
  for(const baseRevision of [0,1,2])await assert.rejects(f.service.write(f.request,input({baseRevision})),{code:'notes_sync_conflict'});
});
test('same-service concurrent creates serialize and cross-service file lock refuses an overlapping write',async t=>{
  const held=gate(),entered=gate();let hold=true;
  const f=await fixture(t,{io:{...fs,open:async(file,...args)=>{const h=await fs.open(file,...args);if(hold&&String(file).endsWith('.lock')){entered.release();await held.promise;}return h;}}});
  const first=f.service.write(f.request,input());await entered.promise;
  const secondService=f.create({io:fs});await assert.rejects(secondService.write(f.request,input({id:'other'})),{code:'notes_sync_busy'});
  hold=false;held.release();await first;
  const results=await Promise.allSettled([f.service.write(f.request,input({id:'shared'})),f.service.write(f.request,input({id:'shared'}))]);
  assert.equal(results.filter(result=>result.status==='fulfilled').length,1);assert.equal(results.find(result=>result.status==='rejected').reason.code,'notes_sync_conflict');
  assert.equal((await f.service.list(f.request)).notes.length,2);
});
test('crash locks, living owners and unverifiable locks receive distinct diagnoses and are never silently removed',async t=>{
  const f=await fixture(t);await f.service.write(f.request,input());const original=await fs.readFile(f.file);
  for(const [status,code] of [['dead','notes_sync_stale_lock'],['alive','notes_sync_busy'],['unknown','notes_sync_lock_unverifiable']]){
    const lock=JSON.stringify({version:1,owner:randomUUID(),pid:12345});await fs.writeFile(f.lock,lock);
    let inspected=0;const service=f.create({processStatus:pid=>{assert.equal(pid,12345);inspected++;return status;}});
    await assert.rejects(service.write(f.request,input({baseRevision:1})),{code});assert.equal(inspected,1);
    assert.equal(await fs.readFile(f.lock,'utf8'),lock);assert.deepEqual(await fs.readFile(f.file),original);await fs.unlink(f.lock);
  }
  for(const lock of ['broken',JSON.stringify({version:99,owner:randomUUID(),pid:12345}),JSON.stringify({version:1,owner:randomUUID(),pid:-1}),JSON.stringify({version:1,owner:randomUUID(),pid:12345,path:'/unknown'})]){
    await fs.writeFile(f.lock,lock);const service=f.create({processStatus:()=>assert.fail('unknown lock cannot probe a supplied process')});
    await assert.rejects(service.write(f.request,input({baseRevision:1})),{code:'notes_sync_lock_unverifiable'});assert.equal(await fs.readFile(f.lock,'utf8'),lock);await fs.unlink(f.lock);
  }
});
test('a replaced lock cannot inherit a prior dead-process diagnosis or be removed',async t=>{
  const f=await fixture(t),lock=JSON.stringify({version:1,owner:randomUUID(),pid:12345});await fs.writeFile(f.lock,lock);
  const replacement=JSON.stringify({version:1,owner:randomUUID(),pid:process.pid});
  const service=f.create({processStatus:async()=>{await fs.writeFile(f.lock,replacement);return 'dead';}});
  await assert.rejects(service.write(f.request,input()),{code:'notes_sync_busy'});assert.equal(await fs.readFile(f.lock,'utf8'),replacement);assert.equal((await f.service.list(f.request)).notes.length,0);
});
test('corrupt, overlarge and account-mismatched files are retained, never interpreted as an empty library',async t=>{
  const f=await fixture(t);await f.service.write(f.request,input());const original=await fs.readFile(f.file);
  for(const value of ['broken',JSON.stringify({schema:'future'}),original.toString().replace('完整正文','损坏正文')]){
    await fs.writeFile(f.file,value);await assert.rejects(f.service.list(f.request));await assert.rejects(f.service.write(f.request,input({id:'new'})));assert.equal(await fs.readFile(f.file,'utf8'),value);
  }
  await fs.writeFile(f.file,original);await fs.truncate(f.file,NOTES_SYNC_LIMITS.bytes+1);await assert.rejects(f.service.list(f.request),{code:'notes_sync_corrupt'});
  assert.equal((await fs.stat(f.file)).size,NOTES_SYNC_LIMITS.bytes+1);
  await fs.writeFile(f.file,original);const raw=JSON.parse(original);raw.expectedAccount=account('bob');const {checksum,...payload}=raw;raw.checksum=createHash('sha256').update(JSON.stringify(payload)).digest('hex');await fs.writeFile(f.file,JSON.stringify(raw));
  await assert.rejects(f.service.list(f.request),{code:'notes_sync_corrupt'});
});
test('record and durable mutation capacities reject further writes explicitly without pruning history or originals',async t=>{
  const f=await fixture(t);
  for(const kind of ['notes','mutations']){
    const count=NOTES_SYNC_LIMITS[kind];
    const mutations=Array.from({length:count},(_,index)=>({mutationId:`capacity-${String(index).padStart(8,'0')}`,hash:'a'.repeat(64),revision:index+1,updatedAt:index+2}));
    const makeRow=index=>({id:`note-${index}`,title:'保留',body:'不可静默清理',pinned:false,createdAt:1,updatedAt:index+2,revision:index+1,deleted:false});
    const state={schema:NOTES_SYNC_SCHEMA,expectedAccount:account('alice'),revision:count,notes:kind==='notes'?Array.from({length:count},(_,index)=>makeRow(index)):[makeRow(count-1)],mutations};
    const original=JSON.stringify({...state,checksum:createHash('sha256').update(JSON.stringify(state)).digest('hex')});await fs.writeFile(f.file,original);
    await assert.rejects(f.service.write(f.request,input({id:'one-more'})),{code:'notes_sync_capacity',status:507});
    assert.equal(await fs.readFile(f.file,'utf8'),original);
  }
});
test('corrupt internal rows with otherwise valid checksums remain server failures, not fabricated empty data',async t=>{
  const f=await fixture(t);await f.service.write(f.request,input());const original=JSON.parse(await fs.readFile(f.file,'utf8'));
  for(const patch of [state=>state.notes[0].width=400,state=>state.mutations[0].mutationId='bad',state=>state.notes[0].revision=2,state=>state.mutations[0].updatedAt++]){
    const {checksum,...state}=structuredClone(original);patch(state);const value=JSON.stringify({...state,checksum:createHash('sha256').update(JSON.stringify(state)).digest('hex')});await fs.writeFile(f.file,value);
    await assert.rejects(f.service.list(f.request),{status:503});assert.equal(await fs.readFile(f.file,'utf8'),value);
  }
});
test('directory changes during a pending operation fail closed, and invalid clocks never create a note file',async t=>{
  const waiting=gate(),entered=gate();let held=true;
  const f=await fixture(t,{io:{...fs,realpath:async(...args)=>{const value=await fs.realpath(...args);if(held){held=false;entered.release();await waiting.promise;}return value;}}});
  const pending=f.service.write(f.request,input());await entered.promise;f.request.user.directories.root=path.join(f.root,'different');waiting.release();await assert.rejects(pending,{code:'notes_sync_account'});
  f.request.user.directories.root=f.userRoot;
  for(const value of [-1,NaN,Infinity]){const broken=f.create({io:fs,now:()=>value});await assert.rejects(broken.write(f.request,input()),{code:'notes_sync_clock'});assert.deepEqual(await fs.readdir(f.userRoot),[]);}
});
test('symbolic directories and multiply-linked data files are not followed or overwritten',async t=>{
  const f=await fixture(t);await f.service.write(f.request,input());const backup=await fs.readFile(f.file),other=path.join(f.root,'hardlink');await fs.link(f.file,other);
  await assert.rejects(f.service.list(f.request),{code:'notes_sync_corrupt'});await assert.rejects(f.service.write(f.request,input({baseRevision:1})));assert.deepEqual(await fs.readFile(other),backup);await fs.unlink(other);
  const alias=path.join(f.root,'alias');await fs.symlink(f.userRoot,alias,process.platform==='win32'?'junction':'dir');f.request.user.directories.root=alias;
  await assert.rejects(f.service.list(f.request),{code:'notes_sync_path'});assert.deepEqual(await fs.readFile(f.file),backup);
});
test('pre-commit write failure preserves the old complete file and cleans only its own temporary file and lock',async t=>{
  const f=await fixture(t);await f.service.write(f.request,input());const original=await fs.readFile(f.file);
  const failed=f.create({io:{...fs,rename:async()=>{throw Object.assign(Error('private-path'),{code:'EIO'});}}});
  let error;try{await failed.write(f.request,input({baseRevision:1}));}catch(value){error=value;}
  assert.equal(error.writeState,'unconfirmed');assert.doesNotMatch(JSON.stringify(notesSyncErrorPayload(error)),/private-path/);
  assert.deepEqual(await fs.readFile(f.file),original);assert.deepEqual(await fs.readdir(f.userRoot),['.qianmu-notes-sync-v1.json']);
});
test('lost acknowledgement after atomic replacement is recoverable by the same mutation without duplicate edits',async t=>{
  const f=await fixture(t),body=input();let throwAfter=true;
  const uncertain=f.create({io:{...fs,rename:async(...args)=>{await fs.rename(...args);if(throwAfter){throwAfter=false;throw Error('synthetic lost ack');}}}});
  await assert.rejects(uncertain.write(f.request,body),{writeState:'unconfirmed'});assert.equal((await f.service.list(f.request)).revision,1);
  assert.equal((await f.service.write(f.request,body)).revision,1);assert.equal((await f.service.list(f.request)).notes.length,1);
});
test('changed account, cancellation and service close cancel queued work without leaving a lock',async t=>{
  for(const action of ['account','abort','close']){
    const waiting=gate(),entered=gate();let first=true;const controller=new AbortController();
    const f=await fixture(t,{io:{...fs,realpath:async(...args)=>{const value=await fs.realpath(...args);if(first){first=false;entered.release();await waiting.promise;}return value;}}});
    const pending=f.service.write(f.request,input(),{signal:controller.signal});await entered.promise;
    let closing;if(action==='account')f.request.user.profile.handle='bob';if(action==='abort')controller.abort();if(action==='close')closing=f.service.close();
    waiting.release();await assert.rejects(pending);await closing;assert.deepEqual(await fs.readdir(f.userRoot),[]);
  }
});
test('account changes during lock release suppress both saved acknowledgements and conflict originals',async t=>{
  for(const stale of [false,true]){
    const f=await fixture(t);if(stale)await f.service.write(f.request,input());
    const guarded=f.create({io:{...fs,unlink:async(file)=>{await fs.unlink(file);if(String(file).endsWith('.lock'))f.request.user.profile.handle='bob';}}});
    let error;try{await guarded.write(f.request,input());}catch(value){error=value;}
    const payload=notesSyncErrorPayload(error);assert.equal(payload.status,401);assert.equal(Object.hasOwn(payload.body,'note'),false);assert.doesNotMatch(JSON.stringify(payload),/完整正文/);
    f.request.user.profile.handle='alice';assert.equal((await f.service.list(f.request)).notes.length,1);assert.deepEqual(await fs.readdir(f.userRoot),['.qianmu-notes-sync-v1.json']);
  }
});
test('server routes expose only same-origin notes endpoints with no-store headers and authenticated writes',async t=>{
  const f=await fixture(t),routes=new Map();const router={get:(route,handler)=>routes.set(`GET ${route}`,handler),post:(route,handler)=>routes.set(`POST ${route}`,handler)};
  await init(router,{dataRoot:f.root});t.after(exit);
  const call=async(method,route,request)=>{const result={status:200,headers:{}};const response={set:(key,value)=>{result.headers[key]=value;return response;},status:value=>{result.status=value;return response;},json:body=>{result.body=body;return response;},once(){},off(){}};await routes.get(`${method} ${route}`)(request,response);return result;};
  assert.equal((await call('GET','/notes',{})).status,401);
  const listed=await call('GET','/notes',f.request);assert.equal(listed.status,200);assert.equal(listed.headers['Cache-Control'],'no-store');assert.deepEqual(listed.body.notes,[]);
  const saved=await call('POST','/notes/write',{...f.request,body:input()});assert.equal(saved.status,200);assert.equal(saved.body.note.body,'完整正文\n第二行 😄');
  const conflict=await call('POST','/notes/write',{...f.request,body:input()});assert.equal(conflict.status,409);assert.equal(conflict.body.code,'notes_sync_conflict');
});
