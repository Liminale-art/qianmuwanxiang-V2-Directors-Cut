import test from 'node:test';
import assert from 'node:assert/strict';
import {createNativeComfyWorkflowStore} from '../qianmu-comfy-native-store.js';
import {COMFY_NATIVE_SLOT as slot} from '../qianmu-comfy-native-contract.js';
import {normalizeComfyLibraryDocument} from '../qianmu-comfy-library.js';
import {comfyLibraryBackupDigest,validateComfyLibraryBackup} from '../qianmu-comfy-library-backup.js';
import {pinComfyRouteWorkflow,readPinnedComfyRouteWorkflow} from '../qianmu-comfy-route.js';
import {characterNativeFixture,namespace} from './helpers/character-native-fixture.mjs';

const document=(name='first')=>({workflow:JSON.stringify({one:{class_type:'CLIPTextEncode',inputs:{text:'%qianmu_prompt%',style:name}},two:{class_type:'SaveImage',inputs:{images:['one',0]}}}),outputNodeId:'two',parameters:{seed:0,width:832},positivePrompt:'retained addition',negativePrompt:'retained negative'});
async function fixture(t,options={}){
  const f=await characterNativeFixture(t);let at=0;const open=extra=>{const store=createNativeComfyWorkflowStore({createStorage:f.createStorage,now:()=>at,...options,...extra});t.after(()=>store.close());return store;};
  return Object.assign(f,{openWorkflow:open,store:open(),time:value=>at=value});
}
const save=(f,head=null,value=document())=>f.store.save(namespace,{name:'Workflow',id:head?.id||'',expectedRevision:head?.revision||'',document:value});
const index=async f=>(await f.storage.read(slot)).value;
const name=ref=>`qianmu-v2-${ref.scope}-${ref.slot}-${ref.fingerprint}.json`;

test('new independent client reads complete immutable workflow versions and exact graph order, zero values and absent classification',async t=>{
  const f=await fixture(t),first=await save(f);f.time(2);const second=await save(f,first,document('second')),other=f.openWorkflow();
  assert.equal(second.createdAt,0);assert.equal(second.version,2);assert.deepEqual(await other.list(namespace),[second]);
  assert.deepEqual(await other.load(namespace,first.id,first.revision),normalizeComfyLibraryDocument(document()));
  assert.deepEqual(await other.load(namespace,second.id,second.revision),normalizeComfyLibraryDocument(document('second')));
  assert.equal((await other.versions(namespace,first.id))[1].revision,first.revision);assert.equal((await other.load(namespace,first.id,first.revision)).parameters.seed,'0');
  assert.ok(!Object.hasOwn(await other.load(namespace,first.id,first.revision),'classification'));
  assert.ok(!f.calls.some(call=>/delete|generate|prompt|plugins|encode-vibe/.test(call.path)));
});

test('ordinary pinned route consumes the original saved recipe on another client after a newer version exists',async t=>{
  const f=await fixture(t),first=await save(f),selection={id:first.id,revision:first.revision,version:first.version};
  const pinned=await pinComfyRouteWorkflow({namespace,selection,createStore:()=>f.openWorkflow()});f.time(2);await save(f,first,document('second'));
  const restored=await readPinnedComfyRouteWorkflow({namespace,binding:pinned.binding,createStore:()=>f.openWorkflow()});
  assert.deepEqual(restored.document,pinned.document);assert.equal(restored.binding.revision,first.revision);assert.equal(restored.document.positivePrompt,'retained addition');
  const uploads=f.uploads;await f.store.archive(namespace,first.id,(await f.store.list(namespace))[0].revision,true);
  await assert.rejects(readPinnedComfyRouteWorkflow({namespace,binding:pinned.binding,createStore:()=>f.openWorkflow()}),/归档/);assert.equal(f.uploads,uploads+2);
});

test('archive and restore preserve every immutable version; removal retains originals and does not advertise freed disk',async t=>{
  const f=await fixture(t),a=await save(f),b=await save(f,a,document('second'));f.time(3);
  const archived=await f.store.archive(namespace,b.id,b.revision,true);assert.equal(archived.archived,true);assert.deepEqual(await f.openWorkflow().list(namespace),[]);
  assert.equal((await f.openWorkflow().list(namespace,{archived:true}))[0].id,b.id);assert.equal((await f.store.versions(namespace,b.id)).length,2);
  await f.store.archive(namespace,b.id,b.revision,false);assert.equal((await f.store.list(namespace)).length,1);await f.store.archive(namespace,b.id,b.revision,true);
  const files=[...(await index(f)).workflows[0].versions].map(v=>name(v.reference)),purged=await f.store.purge(namespace,b.id,b.revision);
  assert.equal(purged.retained,true);assert.equal(purged.removed,2);assert.ok(files.every(file=>f.files.has(file)));assert.equal((await index(f)).retired.length,1);
  assert.equal(await f.openWorkflow().load(namespace,b.id,a.revision),null);assert.equal((await f.store.usage(namespace)).count,0);
});

test('stale save, archived edit and unconfirmed restore never replace current versions',async t=>{
  const f=await fixture(t),a=await save(f),b=await save(f,a,document('second')),uploads=f.uploads;
  await assert.rejects(save(f,a,document('stale')),/已变化/);assert.equal(f.uploads,uploads);
  await f.store.archive(namespace,b.id,b.revision,true);await assert.rejects(save(f,b),/归档/);
  const backup=await f.store.backup(namespace);await assert.rejects(f.store.restoreBackup(namespace,backup,{expectedDigest:await comfyLibraryBackupDigest(backup)}),/确认/);
});

test('whole-library backup and explicit restore preserve all historical IDs and metadata on an empty native account',async t=>{
  const f=await fixture(t),a=await save(f),b=await save(f,a,{...document('second'),classification:{version:1,visualKinds:['object'],castSizes:['none'],maxSubjects:0}});await f.store.archive(namespace,b.id,b.revision,true);
  const backup=await f.store.backup(namespace);assert.equal(validateComfyLibraryBackup(backup).versions,2);
  const target=await fixture(t),empty=await target.store.backup(namespace);const restored=await target.store.restoreBackup(namespace,backup,{confirmed:true,expectedDigest:await comfyLibraryBackupDigest(empty)});
  assert.equal(restored.added,1);assert.deepEqual(await target.store.backup(namespace),backup);assert.deepEqual(await target.openWorkflow().load(namespace,a.id,a.revision),normalizeComfyLibraryDocument(document()));
});

test('backup cannot hide missing old originals behind a valid newest version',async t=>{
  const f=await fixture(t),a=await save(f),b=await save(f,a,document('second')),old=(await index(f)).workflows[0].versions[0];f.files.delete(name(old.reference));
  assert.deepEqual(await f.store.load(namespace,b.id,b.revision),normalizeComfyLibraryDocument(document('second')));
  await assert.rejects(f.store.load(namespace,a.id,a.revision));await assert.rejects(f.store.backup(namespace));
});

test('wrong-account, corrupted original and known missing directory never fall back to a fresh empty library',async t=>{
  for(const kind of ['account','original','directory']){
    const f=await fixture(t),a=await save(f);if(kind==='account')f.account('st-user:other');
    if(kind==='original'){const ref=(await index(f)).workflows[0].versions[0].reference;f.files.set(name(ref),'{}');}
    if(kind==='directory')f.files.delete([...f.files.keys()].find(key=>key.endsWith('-'+slot+'.json')));
    const before=f.uploads;await assert.rejects(f.store.load(namespace,a.id,a.revision));assert.equal(f.uploads,before);
  }
});

test('a concurrent native head change stops save instead of overwriting another client',async t=>{
  const f=await fixture(t),a=await save(f);let once=false;
  f.hook(async call=>{if(once||call.path!=='/api/files/upload')return;const body=JSON.parse(call.request.body);if(!body.name.includes('-comfy-workflow-version-'))return;once=true;
    const old=await f.storage.read(slot),next=structuredClone(old.value);next.revision++;await f.storage.write(slot,next,{expectedFingerprint:old.fingerprint});
  });await assert.rejects(save(f,a,document('second')));assert.equal((await f.store.list(namespace))[0].version,1);
});

test('a lost directory acknowledgement preserves complete originals and does not automatically retry a write',async t=>{
  const f=await fixture(t);let heads=0;
  f.hook(call=>{if(call.path!=='/api/files/upload')return;const {name,data}=JSON.parse(call.request.body);if(!name.endsWith('-'+slot+'.json'))return;heads++;f.files.set(name,Buffer.from(data,'base64').toString());throw Error('lost acknowledgement');});
  await assert.rejects(save(f));assert.equal(heads,1);f.hook(null);const rows=await f.openWorkflow().list(namespace);assert.equal(rows.length,1);assert.deepEqual(await f.openWorkflow().load(namespace,rows[0].id,rows[0].revision),normalizeComfyLibraryDocument(document()));
});

test('capacity, foreign fields and connection credentials are rejected without uploads',async t=>{
  const f=await fixture(t,{maxBytes:1});await assert.rejects(save(f),/容量上限/);assert.equal(f.uploads,0);
  const other=await fixture(t);await assert.rejects(save(other,null,{workflow:{a:{class_type:'Custom',inputs:{api_key:'must-not-save'}}}}),/凭据/);assert.equal(other.uploads,0);
  const valid=await save(other),packet=await other.store.backup(namespace),changed=structuredClone(packet);changed.workflows[0].versions[0].document.hidden='unrecognized';
  await assert.rejects(other.store.restoreBackup(namespace,changed,{confirmed:true,expectedDigest:await comfyLibraryBackupDigest(packet)}),/无损/);assert.equal((await other.store.list(namespace))[0].revision,valid.revision);
});

test('ordinary summary counts active complete versions, includes native index bytes, and preserves retired scope boundaries',async t=>{
  const f=await fixture(t);assert.deepEqual(await f.store.storageSummary(namespace),{status:'ready',count:0,archived:0,versions:0,documentBytes:0,indexBytes:0,bytes:0});assert.equal(f.uploads,0);
  const a=await save(f),b=await save(f,a,document('second')),view=await f.store.storageSummary(namespace);assert.equal(view.documentBytes,b.totalBytes);assert.equal(view.versions,2);assert.equal(view.bytes,view.documentBytes+view.indexBytes);assert.ok(view.indexBytes>0);
  assert.doesNotMatch(JSON.stringify(view),/workflowHash|CLIPTextEncode|retained addition/);
});

test('closing or revoking a scope rejects queued work and returns no old-account recipe',async t=>{
  const f=await fixture(t),a=await save(f);await assert.rejects(f.store.load(namespace,a.id,a.revision,{isCurrent:()=>false}));
  let calls=0;await assert.rejects(f.store.load(namespace,a.id,a.revision,{guard:()=>++calls<3}));f.store.close();await assert.rejects(f.store.list(namespace));
});
