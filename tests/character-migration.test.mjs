import test from 'node:test';
import assert from 'node:assert/strict';
import {characterNativeFixture,namespace,document} from './helpers/character-native-fixture.mjs';
import {characterLegacyFixture,legacyPacket} from './helpers/character-legacy-fixture.mjs';
import {createCharacterMigration} from '../qianmu-character-migration.js';
import {createCharacterArchiveSession} from '../qianmu-character-archive-session.js';
import {characterNativeBytes,emptyCharacterNativeIndex} from '../qianmu-character-native-contract.js';
import {validateCharacterLibraryBackup} from '../qianmu-character-library-backup.js';

async function fixture(t,options={}){
  const f=await characterNativeFixture(t),packet=legacyPacket(options),old=characterLegacyFixture(t,packet),local=old.createLocal();
  let active=true;const migration=createCharacterMigration({storage:f.storage,local,isCurrent:()=>active});t.after(()=>migration.close());
  return {f,old,local,packet,migration,stop(){active=false;}};
}
async function finish(migration){for(let i=0;i<520;i++){const step=await migration.step();if(step.done)return step;}assert.fail('migration did not finish');}
function headUploads(f){return f.calls.filter(row=>row.request.method==='POST'&&JSON.parse(row.request.body).name.endsWith('-character-library.json'));}

test('legacy absent optional defaults survive actual IDB backup, ST original preservation and normalized read without raw rewrite',async t=>{
  const {f,old,local,packet,migration}=await fixture(t,{optional:false,count:2}),before=structuredClone(old.state);
  assert.deepEqual(await local.backup(namespace),packet);assert.deepEqual(await finish(migration),{done:true,changed:true});
  assert.deepEqual(await f.open().backup(namespace),packet);assert.deepEqual(old.state,before);assert.equal(headUploads(f).length,1);
  const read=await f.open().load(namespace,'old-0');assert.equal(read.document.ageStatus,'unknown');assert.equal(read.document.imagegen.preview,null);assert.equal(read.head.bytes,packet.archives[0].head.bytes);
  assert.equal(read.head.version,3);assert.equal(read.head.createdAt,0);assert.equal(read.document.imagegen.novelReference.strength,0);
  assert.equal((await f.open().bindings(namespace)).find(row=>row.scope==='chat').archiveId,'');
  f.reset();assert.deepEqual(await migration.step(),{done:true,changed:false});assert.equal(f.calls.length,0);
});

test('only the two historical missing fields are allowed; invalid supplied and all other normalized-away fields stay rejected',()=>{
  for(const change of [d=>d.ageStatus='invalid',d=>d.ageStatus=null,d=>d.imagegen.preview={},d=>delete d.imagegen.negative,
    d=>d.name=' padded ',d=>d.aliases.push('Alias'),d=>d.imagegen.apiKey='synthetic',d=>d.future=true]){
    const value=legacyPacket();change(value.archives[0].document);value.archives[0].head.bytes=characterNativeBytes(value.archives[0].document);value.usage.bytes=value.archives[0].head.bytes;
    assert.throws(()=>validateCharacterLibraryBackup(value));
  }
});

test('migration publishes no directory until all originals are preserved and no step uploads more than one original',async t=>{
  const {f,migration}=await fixture(t,{count:3});
  await migration.step();assert.equal(f.uploads,0);
  for(let i=0;i<3;i++){f.reset();await migration.step();assert.equal(f.uploads,1);assert.equal((await f.readIndex()).exists,false);}
  await migration.step();assert.equal((await f.readIndex()).value.archives.length,3);
});

test('image and Comfy reference receipts remain byte-exact without fetching images or resolving workflow files',async t=>{
  const {f,old,packet,migration}=await fixture(t);
  const value=packet.archives[0].document;
  value.imagegen.reference={url:'/user/images/Qianmu-References/old.png',name:'old',mime:'image/png',bytes:500,sha256:'a'.repeat(64)};
  value.comfy={version:1,implementations:[{version:1,name:'slot',workflow:{id:'flow',revision:'wrev',version:1,hash:'b'.repeat(64)},referenceSlot:1,loras:[],conditioning:[]}]};
  packet.archives[0].head.bytes=characterNativeBytes(value);packet.usage.bytes=packet.archives[0].head.bytes;old.replace(packet);
  await finish(migration);assert.deepEqual(await f.open().backup(namespace),packet);assert.equal(f.calls.some(row=>row.path.includes('/images/')||row.path.includes('/prompt')),false);
});

test('existing ST directory including an empty directory with deletion markers is never overwritten by initial migration',async t=>{
  const {f,migration,old}=await fixture(t),index=emptyCharacterNativeIndex(namespace);index.retired.archives=['old-0'];await f.writeIndex(index);f.reset();
  await assert.rejects(()=>migration.step(),/ST 已有/);assert.equal(f.uploads,0);assert.equal(old.reads.length,0);assert.deepEqual((await f.readIndex()).value,index);
});

test('a directory appearing after originals are preserved wins; initial migration does not merge or resurrect any identity',async t=>{
  const {f,migration}=await fixture(t);await migration.step();await migration.step();
  const head=await f.open().save(namespace,{document:document('remote')});f.reset();
  await assert.rejects(()=>migration.step());assert.equal(headUploads(f).length,0);assert.equal((await f.open().load(namespace,head.id)).document.name,'remote');assert.equal(await f.open().load(namespace,'old-0'),null);
});

test('metadata guard detects edits, removals, bindings, usage, missing originals and orphan keys without loading any body',async t=>{
  const {local,old,packet}=await fixture(t),original=structuredClone(old.state),guard=await local.createMigrationGuard(namespace,packet);
  old.reads.length=0;assert.equal(await guard(),true);assert.equal(old.reads.some(r=>r.name==='documents'&&r.kind==='get'),false);
  for(const change of [s=>s.heads[0].revision='other',s=>s.heads=[],s=>s.bindings[0].revision='different-binding',s=>s.usage[0].bytes++,s=>s.documents=[],
    s=>s.documents.push({...s.documents[0],key:JSON.stringify([namespace,'orphan'])}),s=>s.heads[0].unknown=true]){
    Object.assign(old.state,structuredClone(original));change(old.state);await assert.rejects(()=>guard());
  }
  Object.assign(old.state,original);assert.equal(await guard(),true);
});

test('source changes before the next preservation step stop without publishing and do not modify the changed local data',async t=>{
  const {f,old,migration}=await fixture(t);await migration.step();old.state.heads[0].revision='edit';const before=structuredClone(old.state);
  await assert.rejects(()=>migration.step(),/变化/);assert.equal(f.uploads,0);assert.deepEqual(old.state,before);assert.equal((await f.readIndex()).exists,false);
});

test('body-only damage or changes are caught by full source re-audit before publication even if a revision was not advanced',async t=>{
  const {f,old,migration}=await fixture(t);await migration.step();await migration.step();old.state.documents[0].document.imagegen.appearance='pink hair!';
  await assert.rejects(()=>migration.step());assert.equal(headUploads(f).length,0);assert.equal((await f.readIndex()).exists,false);
});

test('source changes during final directory-body upload are caught before publishing the head',async t=>{
  const {f,old,migration}=await fixture(t);await migration.step();await migration.step();
  f.hook(call=>{if(call.request.method==='POST'&&/-character-library-[a-f0-9]+\.json$/.test(JSON.parse(call.request.body).name))old.state.heads[0].revision='mid-upload';});
  await assert.rejects(()=>migration.step());assert.equal(headUploads(f).length,0);assert.equal((await f.readIndex()).exists,false);
});

test('post-head source changes report an uncertain publication, never claim success or blindly retry',async t=>{
  const {f,old,migration}=await fixture(t);await migration.step();await migration.step();
  f.hook(call=>{if(call.request.method==='POST'&&JSON.parse(call.request.body).name.endsWith('-character-library.json'))old.state.heads[0].revision='late-edit';});
  await assert.rejects(()=>migration.step(),e=>e.writeState==='unconfirmed');assert.equal(headUploads(f).length,1);
  await assert.rejects(()=>migration.step());assert.equal(headUploads(f).length,1);assert.equal(old.state.heads[0].revision,'late-edit');
});

test('lost directory acknowledgement retains the verified full ST originals and all local data without automatic resubmission',async t=>{
  const {f,old,packet,migration}=await fixture(t),before=structuredClone(old.state);await migration.step();await migration.step();f.loseAck();
  await assert.rejects(()=>migration.step(),e=>e.writeState==='unconfirmed');assert.equal(headUploads(f).length,1);assert.deepEqual(old.state,before);
  assert.deepEqual(await f.open().backup(namespace),packet);await assert.rejects(()=>migration.step());assert.equal(headUploads(f).length,1);
});

test('401 failures and account cancellation do not publish, clear originals or become empty libraries',async t=>{
  const {f,old,migration}=await fixture(t),before=structuredClone(old.state);f.hook(()=>new Response('{}',{status:401}));
  await assert.rejects(()=>migration.step());assert.equal(f.uploads,0);assert.deepEqual(old.state,before);
});

test('page cancellation and close halt deferred migration with no further I/O',async t=>{
  const {f,migration,stop}=await fixture(t);await migration.step();stop();f.reset();await assert.rejects(()=>migration.step());assert.equal(f.calls.length,0);
  migration.close();await assert.rejects(()=>migration.step());assert.equal(f.calls.length,0);
});

test('binding-only legacy libraries preserve explicit no-archive overrides rather than treating them as empty',async t=>{
  const {f,migration,packet}=await fixture(t,{count:0});await finish(migration);assert.deepEqual(await f.open().backup(namespace),packet);assert.equal(f.originalReads,0);
});

test('normal session schedules nonempty preservation without blocking reads then transparently switches after verified publication',async t=>{
  const {f,old,packet,migration}=await fixture(t);let requests=0;
  const session=createCharacterArchiveSession({createLocal:old.createLocal,createStorage:f.createStorage,requestMigration:options=>{requests++;assert.equal(options.namespace,namespace);}});t.after(()=>session.close());
  assert.equal((await session.list(namespace))[0].name,'Legacy 0');assert.equal(requests,1);assert.equal(f.uploads,0);
  await finish(migration);assert.deepEqual(await session.backup(namespace),packet);assert.equal(requests,1);
  const head=await session.save(namespace,{id:'old-0',expectedRevision:'rev-0',document:document('native edit')});assert.equal(head.version,4);
  assert.equal(old.state.documents[0].document.name,'Legacy 0');assert.equal((await f.open().load(namespace,'old-0')).document.name,'native edit');
});
