import test from 'node:test';import assert from 'node:assert/strict';
import {characterNativeFixture,namespace,document} from './helpers/character-native-fixture.mjs';
import {characterLegacyFixture,legacyPacket} from './helpers/character-legacy-fixture.mjs';
import {createCharacterReconciliation} from '../qianmu-character-reconciliation.js';
import {createCharacterArchiveStore} from '../qianmu-character-archive-store.js';
import {characterLibraryBackupDigest as digest} from '../qianmu-character-library-backup.js';
import {emptyCharacterSources,inspectCharacterSources,characterSourceLibrary} from '../qianmu-character-source-backup.js';
import {buildCharacterBackupFile,readCharacterBackupFile,selectCharacterBackupWorkflows} from '../qianmu-character-backup-file.js';
import {createCharacterRestoreSession} from '../qianmu-character-backup-restore.js';
import {createNativeResourceJournal} from '../qianmu-resource-journal-native.js';
import {fixture as bundleFixture,data} from './fixtures/storyboard-bundle.mjs';
import {inspectStoryboardResourceBundle} from '../qianmu-storyboard-bundle-resources.js';
import {openStoryboardBundle} from '../qianmu-storyboard-bundle.js';
import {planComfyLibraryRestore,COMFY_LIBRARY_BACKUP_SCHEMA} from '../qianmu-comfy-library-backup.js';

async function packet(library=legacyPacket()){return {...emptyCharacterSources(library.namespace),sources:[{digest:await digest(library),library:structuredClone(library)}]};}
async function reconciled(t){
  const f=await characterNativeFixture(t),old=characterLegacyFixture(t),store=f.open();await store.createOnce(namespace,{id:'old-0',document:document('Current')},{isCurrent:()=>true});
  const job=createCharacterReconciliation({storage:f.storage,local:old.createLocal()});for(let i=0;i<20;i++)if((await job.step()).done)break;job.close();return {f,old,store};
}
test('all preserved legacy libraries export without writes, including sources whose review is resolved',async t=>{
  const {f,store}=await reconciled(t),source=await store.backupSources(namespace),before=await store.backup(namespace);assert.deepEqual(source,await packet());
  const item=(await store.legacyImports(namespace))[0],review=await store.previewLegacyImport(namespace,item.digest);
  await store.resolveLegacyImport(namespace,{digest:item.digest,expectedFingerprint:review.fingerprint,decisions:Object.fromEntries(review.conflicts.map(row=>[row.key,'current']))},{confirmed:true});
  assert.deepEqual(await store.legacyImports(namespace),[]);f.reset();assert.deepEqual(await store.backupSources(namespace),source);assert.equal(f.uploads,0);assert.deepEqual(await store.backup(namespace),before);
});
test('fresh native client restores exact sources without adopting any archive, binding or old approval',async t=>{
  const f=await characterNativeFixture(t),store=f.open(),source=await packet(legacyPacket({optional:false}));
  assert.deepEqual(await store.previewSources(namespace,source),{count:1,bytes:new TextEncoder().encode(JSON.stringify(source.sources[0])).length,added:1,existing:0});
  assert.throws(()=>store.restoreSources(namespace,source),/确认/);assert.equal(f.uploads,0);
  await store.restoreSources(namespace,source,{confirmed:true});assert.equal((await store.backup(namespace)).usage.count,0);assert.deepEqual(await store.bindings(namespace),[]);
  const other=f.open();assert.deepEqual(await other.backupSources(namespace),source);assert.equal((await other.legacyImports(namespace))[0].count,3);
  f.reset();await other.restoreSources(namespace,source,{confirmed:true});assert.equal(f.uploads,0);
});
test('explicit review can adopt a missing archive and its binding together, never on source restore',async t=>{
  const f=await characterNativeFixture(t),store=f.open(),source=await packet();await store.restoreSources(namespace,source,{confirmed:true});
  const review=await store.previewLegacyImport(namespace,source.sources[0].digest);
  await store.resolveLegacyImport(namespace,{digest:review.digest,expectedFingerprint:review.fingerprint,decisions:Object.fromEntries(review.conflicts.map(row=>[row.key,'source']))},{confirmed:true});
  assert.equal((await store.load(namespace,'old-0')).document.name,'Legacy 0');assert.equal((await store.bindings(namespace)).length,2);assert.deepEqual(await store.backupSources(namespace),source);
});
test('tombstones and current records survive source restoration',async t=>{
  const f=await characterNativeFixture(t),store=f.open();await store.createOnce(namespace,{id:'old-0',document:document('Deleted')},{isCurrent:()=>true});
  const existing=await store.load(namespace,'old-0');await store.remove(namespace,'old-0',existing.head.revision);
  const prior=(await f.readIndex()).value;await store.restoreSources(namespace,await packet(),{confirmed:true});const after=(await f.readIndex()).value;
  assert.deepEqual(after.archives,prior.archives);assert.deepEqual(after.bindings,prior.bindings);assert.deepEqual(after.retired,prior.retired);assert.equal(await store.load(namespace,'old-0'),null);
  const review=await store.previewLegacyImport(namespace,after.imports[0].digest);assert.equal(review.conflicts.find(row=>row.kind==='archive').deleted,true);
});
test('source capture rejects digest/namespace mutations, duplicate sources and unknown fields before writes',async t=>{
  const f=await characterNativeFixture(t),store=f.open(),good=await packet();
  for(const change of [value=>value.sources[0].digest='f'.repeat(64),value=>value.namespace='st-user:else',value=>value.sources.push(structuredClone(value.sources[0])),value=>value.sources[0].approved=true,value=>value.restoreAuthorized=true]){
    const value=structuredClone(good);change(value);await assert.rejects(store.restoreSources(namespace,value,{confirmed:true}));assert.equal(f.uploads,0);
  }
});
test('restore captures caller input before awaiting account I/O',async t=>{
  const f=await characterNativeFixture(t),store=f.open(),source=await packet(),original=structuredClone(source);
  const job=store.restoreSources(namespace,source,{confirmed:true});source.sources.length=0;await job;assert.deepEqual(await store.backupSources(namespace),original);
});
test('failed source manifest upload retains originals and explicit retry reuses them',async t=>{
  const f=await characterNativeFixture(t),store=f.open(),source=await packet();f.hook(call=>{
    if(call.request.method==='POST'&&JSON.parse(call.request.body).name.includes('-character-import-'))return new Response('{}',{status:503});
  });await assert.rejects(store.restoreSources(namespace,source,{confirmed:true}));assert.equal((await f.readIndex()).exists,false);
  const saved=new Set(f.files.keys());assert.equal(saved.size,1);f.hook(null);f.reset();await store.restoreSources(namespace,source,{confirmed:true});
  assert.ok(f.calls.filter(row=>row.request.method==='POST').every(row=>!saved.has(JSON.parse(row.request.body).name)));assert.deepEqual(await store.backupSources(namespace),source);
});
test('lost directory acknowledgement does not replay adoption or automatically upload again',async t=>{
  const f=await characterNativeFixture(t),store=f.open(),source=await packet();f.loseAck();await assert.rejects(store.restoreSources(namespace,source,{confirmed:true}));
  const writes=f.uploads;await new Promise(resolve=>setTimeout(resolve,10));assert.equal(f.uploads,writes);
  const other=f.open();assert.deepEqual(await other.backupSources(namespace),source);assert.equal((await other.list(namespace)).length,0);
  f.reset();await other.restoreSources(namespace,source,{confirmed:true});assert.equal(f.uploads,0);
});
test('source export refuses a catalog changed during original reads',async t=>{
  const f=await characterNativeFixture(t),store=f.open(),source=await packet();await store.restoreSources(namespace,source,{confirmed:true});
  f.hook(async call=>{if(call.request.method==='GET'&&call.path.includes('-character-import-')){f.hook(null);await f.open().save(namespace,{document:document('Concurrent')});}});
  await assert.rejects(store.backupSources(namespace),/变化/);
});

test('verification refuses membership removed while immutable source bodies were being read',async t=>{
  const f=await characterNativeFixture(t),store=f.open(),source=await packet();await store.restoreSources(namespace,source,{confirmed:true});
  f.hook(async call=>{if(call.request.method==='GET'&&call.path.includes('-character-import-')){f.hook(null);const current=(await f.readIndex()).value;await f.writeIndex({...current,imports:[],revision:current.revision+1});}});
  await assert.rejects(store.verifySources(namespace,source),/目录在核验期间已变化/);
});

test('cancelled source restoration never publishes a directory after preserving an original',async t=>{
  const f=await characterNativeFixture(t),store=f.open(),source=await packet();let live=true;
  f.hook(call=>{if(call.request.method==='POST'&&JSON.parse(call.request.body).name.includes('-character-record-'))live=false;});
  await assert.rejects(store.restoreSources(namespace,source,{confirmed:true,isCurrent:()=>live}));f.hook(null);assert.equal((await f.readIndex()).exists,false);
  const writes=f.uploads;await new Promise(resolve=>setTimeout(resolve,10));assert.equal(f.uploads,writes);assert.equal((await f.open().list(namespace)).length,0);
});

test('missing source originals cannot be replaced by a current same-id document',async t=>{
  const f=await characterNativeFixture(t),store=f.open(),source=await packet();await store.restoreSources(namespace,source,{confirmed:true});
  await store.createOnce(namespace,{id:'old-0',document:document('New current')},{isCurrent:()=>true});
  const before=new Map(f.files),entry=[...before].find(([name,text])=>name.includes('-character-record-')&&text.includes('Legacy 0'));assert.ok(entry);f.files.delete(entry[0]);
  await assert.rejects(store.backupSources(namespace));await assert.rejects(store.verifySources(namespace,source));assert.equal((await store.load(namespace,'old-0')).document.name,'New current');
});
test('native source methods are routed through the common factory and do not fall back after identity loss',async t=>{
  const f=await characterNativeFixture(t),old=characterLegacyFixture(t,legacyPacket({count:0}));old.replace(characterSourceLibrary(namespace,[],[]));
  const store=createCharacterArchiveStore({native:{createStorage:f.createStorage,requestMigration:()=>{}},indexedDB:old.indexedDB,keyRange:old.keyRange});t.after(()=>store.close());
  const source=await packet();await store.restoreSources(namespace,source,{confirmed:true});assert.deepEqual(await store.backupSources(namespace),source);
  f.account('st-user:changed');await assert.rejects(store.backupSources(namespace));
});
test('standalone resource v2 keeps old-only images and pinned workflow versions, while empty old sources stay v1',async()=>{
  const f=await bundleFixture(),library=characterSourceLibrary(f.sources.characters.namespace,[],[]),sources=await packet(f.sources.characters);
  const workflows=selectCharacterBackupWorkflows(library,f.sources.workflows,sources),result=await buildCharacterBackupFile(library,{sources,workflows,readImages:async()=>[{mime:'image/png',data}]});
  const restored=await readCharacterBackupFile(result.file);assert.equal(restored.schema,'qianmu.character.resources.v2');assert.deepEqual(restored.sources,sources);assert.equal(restored.library.archives.length,0);assert.equal(restored.images.length,1);assert.equal(restored.workflows.workflows[0].versions.length,2);
  const old=await buildCharacterBackupFile(library);assert.equal((await readCharacterBackupFile(old.file)).schema,'qianmu.character.resources.v1');
  const broken=structuredClone(restored);broken.images=[];await assert.rejects(readCharacterBackupFile(new Blob([JSON.stringify(broken)])),/缺少/);
  await assert.rejects(buildCharacterBackupFile(library,{sources,readImages:async()=>assert.fail('should preflight fixed workflows')}));
});
test('whole bundle carries source-only dependencies and describes them separately, with no export writes',async()=>{
  const f=await bundleFixture(),source=await packet(f.sources.characters);f.sources.characters=characterSourceLibrary(source.namespace,[],[]);f.options.characterStore.backupSources=async()=>structuredClone(source);
  const built=await f.build(),opened=await openStoryboardBundle(built.file),checked=await inspectStoryboardResourceBundle(built.file,{includeOrigins:true});
  assert.deepEqual(await opened.readJson('character-sources'),source);assert.equal(checked.summary.characterSources,1);
  assert.ok(checked.origins.rows.some(row=>row.at.startsWith('character-sources:')&&row.kind==='workflow'));
  assert.ok(checked.originals.some(row=>row.url==='/user/images/cover.png'));
});
test('whole export detects old source additions during download rather than omitting them',async()=>{
  const f=await bundleFixture(),source=await packet(f.sources.characters);let reads=0;f.options.characterStore.backupSources=async()=>++reads===1?source:emptyCharacterSources(source.namespace);
  await assert.rejects(f.build(),/旧来源已变化/);
});

for(const nativeJournal of [false,true])test(`standalone coordinator restores old-only images/workflows and native sources without adopting old metadata (${nativeJournal?'ST checkpoint':'memory checkpoint'})`,async t=>{
  const f=await bundleFixture(),ns=f.sources.characters.namespace,source=await packet(f.sources.characters),library=characterSourceLibrary(ns,[],[]);
  const built=await buildCharacterBackupFile(library,{sources:source,workflows:f.sources.workflows,readImages:async()=>[{mime:'image/png',data}]});
  const target=await characterNativeFixture(t,{account:ns}),store=target.open(),files=new Map(),events=[];let record=null,workflows={schema:COMFY_LIBRARY_BACKUP_SCHEMA,namespace:ns,credentialsIncluded:false,workflows:[]};
  const legacy={loadResource:async()=>record,prepareResource:async row=>(record={...row,phase:'prepared'}),updateResource:async(_row,phase)=>(events.push(phase),record={...record,phase}),close(){}};
  const journal=nativeJournal?createNativeResourceJournal({legacy,createStorage:target.createStorage}):legacy;t.after(()=>journal.close());
  const workflowStore={backup:async()=>structuredClone(workflows),usage:async()=>({limit:64*1048576}),restoreBackup:async(_ns,input,options)=>{
    assert.equal(await digest(workflows),options.expectedDigest);const plan=planComfyLibraryRestore(workflows,input);workflows={...workflows,workflows:plan.writes};
  }};
  const images={inspect:async receipt=>({receipt,state:files.has(receipt.url)?'present':'missing'}),restore:async(receipt,value)=>{assert.equal(value,data);files.set(receipt.url,value);}};
  const session=await createCharacterRestoreSession(ns,await readCharacterBackupFile(built.file),{store,workflowStore,journal,images,locks:{request:async(_name,_options,run)=>run({})}});t.after(()=>session.close());
  const preview=await session.preview();assert.equal(preview.sources.count,1);assert.equal(target.uploads,0);
  await session.restore(preview,{confirmed:true});assert.equal((await journal.loadResource(ns)).phase,'verified');assert.equal(files.size,2);assert.equal((await store.list(ns)).length,0);assert.deepEqual(await target.open().backupSources(ns),source);
  if(nativeJournal){assert.equal(record,null);const other=createNativeResourceJournal({legacy,createStorage:target.createStorage});t.after(()=>other.close());assert.equal((await other.loadResource(ns)).phase,'verified');}
});
