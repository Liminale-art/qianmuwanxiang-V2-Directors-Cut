import test from 'node:test';
import assert from 'node:assert/strict';
import {characterNativeFixture,namespace,document} from './helpers/character-native-fixture.mjs';
import {characterLegacyFixture,legacyPacket} from './helpers/character-legacy-fixture.mjs';
import {createCharacterReconciliation} from '../qianmu-character-reconciliation.js';
import {characterLibraryBackupDigest,characterBackupBindingKey} from '../qianmu-character-library-backup.js';
import {CHARACTER_RECONCILED_SCHEMA,validateCharacterNativeIndex,characterNativeBytes,characterNativeBackup} from '../qianmu-character-native-contract.js';
import {readCharacterImport,planCharacterImport} from '../qianmu-character-import.js';
import {canonicalUserSubjectKey} from '../qianmu-user-identity.js';

const finish=async job=>{for(let i=0;i<530;i++){const result=await job.step();if(result.done)return result;}assert.fail('unbounded migration');};
async function setup(t,{conflict=false}={}){
  const f=await characterNativeFixture(t),packet=legacyPacket({optional:false}),old=characterLegacyFixture(t,packet),store=f.open();
  const head=conflict?await store.createOnce(namespace,{id:'old-0',document:document('Remote')},{isCurrent:()=>true}).then(r=>r.head):await store.save(namespace,{document:document('Unrelated')});
  let active=true;const open=()=>{const job=createCharacterReconciliation({storage:f.storage,local:old.createLocal(),isCurrent:()=>active});t.after(()=>job.close());return job;};
  const receipt=async()=>(await f.readIndex()).value.imports[0];
  return {f,packet,old,store,head,open,receipt,stop:()=>{active=false;}};
}
const options=()=>({confirmed:true,isCurrent:()=>true});
const binding=()=>({category:'char',subjectKey:'char:legacy.png',scope:'default',chatKey:''});
const chooseAll=(preview,value)=>Object.fromEntries(preview.conflicts.map(row=>[row.key,value]));

test('existing ST and nonempty IDB merge independent additions only after every immutable original and manifest is confirmed',async t=>{
  const {f,old,packet,store,open,receipt}=await setup(t),before=structuredClone(old.state),job=open();
  await job.step();assert.equal((await f.readIndex()).value.imports,undefined);
  await job.step();assert.equal((await f.readIndex()).value.imports,undefined);
  await job.step();assert.equal((await f.readIndex()).value.imports,undefined);
  assert.deepEqual(await job.step(),{done:true,changed:true});const saved=await receipt();
  assert.equal((await f.readIndex()).value.schema,CHARACTER_RECONCILED_SCHEMA);assert.deepEqual(saved.pending,[]);
  assert.equal((await store.list(namespace)).length,2);assert.equal((await store.bindings(namespace)).find(row=>row.scope==='chat').archiveId,'');
  const source=await readCharacterImport(f.storage,saved);assert.equal(source.digest,await characterLibraryBackupDigest(packet));assert.deepEqual(old.state,before);
  assert.deepEqual((await store.legacyDocument(namespace,{digest:saved.digest,id:'old-0'})).document,packet.archives[0].document);
});

test('a recorded source is not reimported after edits, binding changes or deletion and does not upload again',async t=>{
  const {f,store,open,receipt}=await setup(t);await finish(open());const original=await receipt();
  const target=await store.bindings(namespace);for(const row of target)await store.bind(namespace,{target:row,expectedRevision:row.revision,inherit:true});
  const old=await store.load(namespace,'old-0');await store.remove(namespace,'old-0',old.head.revision);f.reset();
  assert.deepEqual(await finish(open()),{done:true,changed:false});assert.equal(f.uploads,0);assert.equal(await store.load(namespace,'old-0'),null);
  assert.deepEqual(await receipt(),original);assert.equal((await f.readIndex()).value.retired.archives.includes('old-0'),true);
});

test('different same-ID archives and changed explicit bindings are preserved for review without timestamp or version guesses',async t=>{
  const {f,store,open,receipt}=await setup(t,{conflict:true});
  await store.bind(namespace,{target:binding(),archiveId:''});await finish(open());
  assert.equal((await store.load(namespace,'old-0')).document.name,'Remote');assert.equal((await store.bindings(namespace)).find(row=>row.scope==='default').archiveId,'');
  const r=await receipt();assert.equal(r.pending.length,2);const preview=await store.previewLegacyImport(namespace,r.digest);
  assert.deepEqual(preview.conflicts.map(row=>row.kind).sort(),['archive','binding']);assert.equal(preview.conflicts.find(row=>row.kind==='archive').sourceVersion,3);
  f.reset();const overview=await store.overview(namespace);assert.equal(overview.imports[0].count,2);assert.equal(f.originalReads,0);assert.equal(f.calls.filter(c=>c.request.method==='GET').length,2);
});

test('explicit keep-current resolves the receipt only, retains exact old source and prevents repeated review',async t=>{
  const {f,store,open,receipt}=await setup(t,{conflict:true});await finish(open());const r=await receipt(),preview=await store.previewLegacyImport(namespace,r.digest),files=new Map(f.files);
  assert.equal((await store.resolveLegacyImport(namespace,{digest:r.digest,expectedFingerprint:preview.fingerprint,decisions:chooseAll(preview,'current')},options())).resolved,preview.conflicts.length);
  assert.deepEqual(await store.legacyImports(namespace),[]);assert.equal((await store.load(namespace,'old-0')).document.name,'Remote');
  assert.equal((await store.legacyDocument(namespace,{digest:r.digest,id:'old-0'})).document.name,'Legacy 0');
  for(const [key,value]of files)if(!key.endsWith('-character-library.json'))assert.equal(f.files.get(key),value);
  f.reset();await finish(open());assert.equal(f.uploads,0);assert.deepEqual(await store.legacyImports(namespace),[]);
});

test('explicit use-source applies archive and dependent binding together while preserving the current original as an immutable file',async t=>{
  const {f,store,open,receipt}=await setup(t,{conflict:true}),prior=(await f.readIndex()).value.archives[0].original;await finish(open());
  const r=await receipt(),preview=await store.previewLegacyImport(namespace,r.digest);
  await store.resolveLegacyImport(namespace,{digest:r.digest,expectedFingerprint:preview.fingerprint,decisions:chooseAll(preview,'source')},options());
  assert.equal((await store.load(namespace,'old-0')).document.name,'Legacy 0');assert.equal((await store.bindings(namespace)).find(row=>row.scope==='default').archiveId,'old-0');
  assert.equal((await f.storage.readImmutable(prior)).value.document.name,'Remote');assert.deepEqual(await store.legacyImports(namespace),[]);
});

test('missing consent, partial/extra choices and stale fingerprints cannot replace current records',async t=>{
  const {f,store,open,receipt}=await setup(t,{conflict:true});await finish(open());const r=await receipt(),preview=await store.previewLegacyImport(namespace,r.digest),input={digest:r.digest,expectedFingerprint:preview.fingerprint,decisions:chooseAll(preview,'source')};
  f.reset();assert.throws(()=>store.resolveLegacyImport(namespace,input),/确认/);
  await assert.rejects(()=>store.resolveLegacyImport(namespace,{...input,decisions:{}},options()),/逐项/);
  await assert.rejects(()=>store.resolveLegacyImport(namespace,{...input,decisions:{...input.decisions,extra:'source'}},options()),/变化/);assert.equal(f.uploads,0);
  await store.save(namespace,{document:document('new after preview')});f.reset();
  await assert.rejects(()=>store.resolveLegacyImport(namespace,input,options()),/变化/);assert.equal(f.uploads,0);assert.equal((await store.load(namespace,'old-0')).document.name,'Remote');
});

test('known deletion marks beat old archives and bindings automatically, preserving the complete skipped source without resurrection',async t=>{
  const {f,store,open,receipt}=await setup(t,{conflict:true}),head=await store.load(namespace,'old-0');
  await store.remove(namespace,'old-0',head.head.revision);await store.bind(namespace,{target:binding(),inherit:true});await finish(open());
  assert.equal(await store.load(namespace,'old-0'),null);assert.equal((await store.bindings(namespace)).some(row=>row.scope==='default'),false);
  const r=await receipt();assert.deepEqual(r.pending,[]);assert.equal((await store.legacyDocument(namespace,{digest:r.digest,id:'old-0'})).document.name,'Legacy 0');
});

test('a pending archive deleted after audit cannot be revived through the review path',async t=>{
  const {store,open,receipt}=await setup(t,{conflict:true});await finish(open());const head=await store.load(namespace,'old-0');await store.remove(namespace,'old-0',head.head.revision);
  const r=await receipt(),p=await store.previewLegacyImport(namespace,r.digest);assert.equal(p.conflicts.find(row=>row.kind==='archive').deleted,true);
  await assert.rejects(()=>store.resolveLegacyImport(namespace,{digest:r.digest,expectedFingerprint:p.fingerprint,decisions:chooseAll(p,'source')},options()),/已删除/);
  await store.resolveLegacyImport(namespace,{digest:r.digest,expectedFingerprint:p.fingerprint,decisions:chooseAll(p,'current')},options());assert.equal(await store.load(namespace,'old-0'),null);
});

test('same-ID different categories stay explicit and cannot be adopted over the current category',async t=>{
  const {f,store,old,packet,open,receipt}=await setup(t,{conflict:true});packet.archives[0].document.category='other';packet.archives[0].head.category='other';
  packet.archives[0].head.bytes=characterNativeBytes(packet.archives[0].document);packet.usage.bytes=packet.archives[0].head.bytes;packet.bindings=[];packet.usage.bindings=0;old.replace(packet);await finish(open());
  const r=await receipt(),p=await store.previewLegacyImport(namespace,r.digest);assert.equal(p.conflicts[0].categoryConflict,true);f.reset();
  await assert.rejects(()=>store.resolveLegacyImport(namespace,{digest:r.digest,expectedFingerprint:p.fingerprint,decisions:chooseAll(p,'source')},options()),/分类/);assert.equal(f.uploads,0);
});

test('all colliding USER address spellings become review items instead of accepting whichever sorts first',async t=>{
  const {store,old,packet,open,receipt}=await setup(t);
  const a='user:/User%20Avatars/Alice%20One.png',b=canonicalUserSubjectKey(a);assert.ok(b);assert.notEqual(a,b);
  packet.bindings=[a,b].map((subjectKey,i)=>({category:'user',subjectKey,scope:'default',chatKey:'',archiveId:'',revision:`alias-${i}`,updatedAt:i}));packet.usage.bindings=2;old.replace(packet);
  await finish(open());assert.equal((await store.bindings(namespace)).length,0);const p=await store.previewLegacyImport(namespace,(await receipt()).digest);assert.equal(p.conflicts.length,2);assert.ok(p.conflicts.every(row=>row.alias));
});

test('changed old source produces a separate retained receipt, never changes the prior source or assumes it is a newer remote version',async t=>{
  const {store,old,packet,open,f}=await setup(t);await finish(open());const first=(await f.readIndex()).value.imports[0];
  packet.archives[0].document.name='Late old edit';packet.archives[0].head.name='Late old edit';packet.archives[0].head.revision='late-revision';packet.archives[0].head.version=99;
  packet.archives[0].head.bytes=characterNativeBytes(packet.archives[0].document);packet.usage.bytes=packet.archives[0].head.bytes;old.replace(packet);await finish(open());
  const index=(await f.readIndex()).value;assert.equal(index.imports.length,2);assert.deepEqual(index.imports[0],first);assert.equal(index.imports[1].pending.length,1);
  assert.equal((await store.load(namespace,'old-0')).document.name,'Legacy 0');
});

test('source changes during preservation or final write never silently publish mixed snapshots',async t=>{
  for(const phase of ['preserve','publish']){
    const {f,old,open}=await setup(t),job=open();await job.step();
    if(phase==='preserve'){old.state.heads[0].revision='changed';await assert.rejects(()=>job.step());}
    else {await job.step();await job.step();f.hook(call=>{if(call.request.method==='POST'&&/-character-library-[a-f0-9]+\.json$/.test(JSON.parse(call.request.body).name))old.state.heads[0].revision='changed';});await assert.rejects(()=>job.step());}
    assert.equal((await f.readIndex()).value.imports,undefined);
  }
});

test('remote edits before the final plan are included without discarding the complete preserved source',async t=>{
  const {store,open}=await setup(t),job=open();await job.step();await job.step();await job.step();
  await store.save(namespace,{document:document('concurrent')});await finish(job);
  assert.ok((await store.list(namespace)).some(row=>row.name==='concurrent'));assert.equal((await store.list(namespace)).length,3);
});

test('a competing remote head arriving during publication stops the merge without overwriting the winner',async t=>{
  const {f,store,open}=await setup(t),job=open();await job.step();await job.step();await job.step();const before=(await f.readIndex()).value;
  await store.save(namespace,{document:document('concurrent winner')});const key=[...f.files.keys()].find(name=>name.endsWith('-character-library.json')),winner=f.files.get(key);
  await f.writeIndex(before);f.hook(call=>{if(call.request.method==='POST'&&/-character-library-[a-f0-9]+\.json$/.test(JSON.parse(call.request.body).name))f.files.set(key,winner);});
  await assert.rejects(()=>job.step());f.hook(null);assert.equal(f.files.get(key),winner);assert.equal((await f.readIndex()).value.imports,undefined);
  assert.ok((await store.list(namespace)).some(row=>row.name==='concurrent winner'));
});

test('lost merge acknowledgement leaves accepted receipts readable and a subsequent audit performs no duplicate write',async t=>{
  const {f,open,store}=await setup(t),job=open();await job.step();await job.step();await job.step();f.loseAck();
  await assert.rejects(()=>job.step(),error=>error.writeState==='unconfirmed');assert.equal((await store.list(namespace)).length,2);f.reset();
  assert.deepEqual(await finish(open()),{done:true,changed:false});assert.equal(f.uploads,0);
});

test('missing manifest, bad receipt and missing selected original stop review rather than returning an empty source',async t=>{
  const {f,store,open,receipt}=await setup(t,{conflict:true});await finish(open());const r=await receipt(),source=await readCharacterImport(f.storage,r),p=await store.previewLegacyImport(namespace,r.digest);
  const original=source.archives[0].original,key=`qianmu-v2-${original.scope}-${original.slot}-${original.fingerprint}.json`;f.files.delete(key);f.reset();
  await assert.rejects(()=>store.resolveLegacyImport(namespace,{digest:r.digest,expectedFingerprint:p.fingerprint,decisions:chooseAll(p,'source')},options()));assert.equal(f.uploads,0);
  f.files.delete(`qianmu-v2-${r.source.scope}-${r.source.slot}-${r.source.fingerprint}.json`);await assert.rejects(()=>store.previewLegacyImport(namespace,r.digest));assert.equal(f.uploads,0);
});

test('strict v1/v2 contract preserves v1 compatibility and rejects forged or duplicated import receipts',async t=>{
  const {f,open}=await setup(t);const v1=(await f.readIndex()).value;validateCharacterNativeIndex(v1,f.storage);await finish(open());const v2=(await f.readIndex()).value;
  for(const mutate of [v=>v.imports.push(v.imports[0]),v=>v.imports[0].digest='bad',v=>v.imports[0].source.scope='a'.repeat(64),v=>v.imports[0].pending=['unknown'],v=>v.imports[0].pending=['archive:bad id'],v=>v.schema=v1.schema]){
    const value=structuredClone(v2);mutate(value);assert.throws(()=>validateCharacterNativeIndex(value,f.storage));
  }
});

test('planning owns independent output and cannot mutate the original manifest or current directory',async t=>{
  const {f,open,receipt}=await setup(t);await finish(open());const source=await readCharacterImport(f.storage,await receipt()),index=(await f.readIndex()).value;
  const before=structuredClone(source);index.archives=index.archives.filter(row=>row.head.id!=='old-0');index.bindings=[];index.usage={count:1,bytes:index.archives[0].head.bytes,bindings:0};
  const plan=planCharacterImport(index,source);plan.next.archives.find(row=>row.head.id==='old-0').head.name='mutation';assert.deepEqual(source,before);
});

test('a recorded digest never hides a missing preserved source manifest as a successful no-op',async t=>{
  const {f,open,receipt}=await setup(t);await finish(open());const r=await receipt();f.files.delete(`qianmu-v2-${r.source.scope}-${r.source.slot}-${r.source.fingerprint}.json`);f.reset();
  await assert.rejects(()=>finish(open()));assert.equal(f.uploads,0);
});

test('retirement of an equivalent USER address prevents another spelling from restoring the old explicit unbind',async t=>{
  const {store,old,packet,open,receipt}=await setup(t),canonical='user:/User Avatars/Alice%20One.png';
  await store.bind(namespace,{target:{category:'user',subjectKey:canonical,scope:'chat',chatKey:'chat'},inherit:true});
  packet.bindings=[{category:'user',subjectKey:'user:/User%20Avatars/Alice%20One.png',scope:'chat',chatKey:'chat',archiveId:'',revision:'old-user-bind',updatedAt:0}];packet.usage.bindings=1;old.replace(packet);
  await finish(open());assert.equal((await store.bindings(namespace)).length,0);assert.deepEqual((await receipt()).pending,[]);
});

test('imports survive normal edit/backup without pulling whole legacy sources into ordinary lists or the active-library backup',async t=>{
  const {f,store,open,head}=await setup(t);await finish(open());const before=(await f.readIndex()).value.imports;
  await store.save(namespace,{id:head.id,expectedRevision:head.revision,document:document('Edited native')});
  assert.deepEqual((await f.readIndex()).value.imports,before);f.reset();await store.overview(namespace);
  assert.equal(f.calls.some(row=>row.path.includes('-character-import-')),false);const backup=await store.backup(namespace);assert.equal(backup.usage.count,2);assert.equal(backup.imports,undefined);
});

test('caller cancellation and lost review acknowledgement never blind-retry explicit replacement',async t=>{
  const {f,store,open,receipt}=await setup(t,{conflict:true});await finish(open());const r=await receipt(),p=await store.previewLegacyImport(namespace,r.digest),input={digest:r.digest,expectedFingerprint:p.fingerprint,decisions:chooseAll(p,'source')};
  f.reset();await assert.rejects(()=>store.resolveLegacyImport(namespace,input,{confirmed:true,isCurrent:()=>false}));assert.equal(f.calls.length,0);
  f.loseAck();await assert.rejects(()=>store.resolveLegacyImport(namespace,input,options()),error=>error.writeState==='unconfirmed');
  assert.deepEqual(await store.legacyImports(namespace),[]);assert.equal((await store.load(namespace,'old-0')).document.name,'Legacy 0');
  f.reset();await assert.rejects(()=>store.resolveLegacyImport(namespace,input,options()),/变化/);assert.equal(f.uploads,0);
});
