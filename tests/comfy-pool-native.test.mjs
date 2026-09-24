import test from 'node:test';
import assert from 'node:assert/strict';
import {createComfyPoolStore} from '../qianmu-comfy-pool-store.js';
import {comfyPoolBackupDigest,validateComfyPoolBackup} from '../qianmu-comfy-pool-backup.js';
import {COMFY_POOL_NATIVE_SLOT as slot} from '../qianmu-comfy-pool-native-contract.js';
import {pinComfyAutoPool,readPinnedComfyAutoPool,prepareComfyAutoSession} from '../qianmu-comfy-auto-runtime.js';
import {normalizeStoryboardShotSpec} from '../qianmu-storyboard.js';
import {bindStoryboardPromptRenderings} from '../qianmu-prompt-formats.js';
import {renderComfyPools,createComfyPoolController} from '../qianmu-comfy-pool-view.js';
import {comfyLibraryIdbFixture,comfyPoolIdbFixture} from './helpers/comfy-library-idb-fixture.mjs';
import {poolNativeFixture,namespace,workflow} from './helpers/comfy-pool-native-fixture.mjs';

const index=async f=>(await f.storage.read(slot)).value;
const file=ref=>`qianmu-v2-${ref.scope}-${ref.slot}-${ref.fingerprint}.json`;
const save=(f,store,prior=null,change={})=>store.save(namespace,{id:prior?.id||'',expectedRevision:prior?.revision||'',name:'Candidate scheme',pool:{...f.pool,...(prior?{id:prior.id,revision:prior.revision}:{}),...change}});
async function oldLibrary(t,f){const store=f.poolLocal.open();t.after(()=>store.close());const first=await save(f,store),second=await save(f,store,first,{styleLock:false});return {store,first,second,packet:await store.backup(namespace)};}

test('complete local pool history migrates read-only with references, toggles, priorities and zero values unchanged',async t=>{
  const f=await poolNativeFixture(t),old=await oldLibrary(t,f),before=JSON.stringify(f.poolLocal.state.tables),native=f.openPool();f.reset();const view=await native.view(namespace);
  assert.equal(view.rows[0].revision,old.second.revision);assert.equal(view.usage.persistence,'st-account-file');assert.deepEqual(await native.backup(namespace),old.packet);assert.equal(JSON.stringify(f.poolLocal.state.tables),before);
  const other=f.openPool(comfyPoolIdbFixture()),loaded=await other.load(namespace,old.first.id,old.first.revision);assert.deepEqual(loaded.pool,old.packet.pools[0].versions[0].pool);
  assert.equal(loaded.pool.candidates[0].classification.maxSubjects,0);assert.equal(loaded.pool.candidates[0].priority,0);assert.equal(loaded.pool.enabled,true);assert.equal(loaded.pool.styleLock,true);
  f.poolLocal.state.reads.length=0;f.reset();await native.view(namespace);assert.equal(f.uploads,0);assert.ok(!f.poolLocal.state.reads.some(row=>row.name==='documents'&&row.kind==='get'));
});

test('configured default pool/recipe factories prepare the exact original candidate on an empty second device without granting execution',async t=>{
  const f=await poolNativeFixture(t),old=await oldLibrary(t,f);f.configureDefaults();const store=createComfyPoolStore();t.after(()=>store.close());await store.list(namespace);
  const pinned=await pinComfyAutoPool({namespace,selection:old.first});await save(f,store,old.second,{candidates:[]});await f.workflows.save(namespace,{id:f.workflowHead.id,expectedRevision:f.workflowHead.revision,name:'new workflow',document:workflow('new')});
  f.configureDefaults(comfyLibraryIdbFixture(),comfyPoolIdbFixture());f.reset();const read=await readPinnedComfyAutoPool({namespace,binding:pinned.binding});assert.equal(read.pool.candidates.length,1);assert.equal(read.pool.styleLock,true);assert.equal(f.calls.filter(row=>row.request.method==='GET').length,9);assert.equal(f.uploads,0);
  const session=await prepareComfyAutoSession({namespace,binding:pinned.binding});try{
    assert.equal(session.executionAuthorized,false);assert.equal(session.candidates[0].target.comfyWorkflowBinding.revision,f.workflowHead.revision);assert.equal(session.candidates[0].target.connectionPresetId,'original-connection');
    const shot=normalizeStoryboardShotSpec({subject:'cup',subjectKind:'object',scene:'a cup on the table',narrativeLayer:'present',sensitive:false,characters:[],promptAtoms:{global:['soft light']}});
    shot.promptRenderingPack=await bindStoryboardPromptRenderings(shot,{natural_language:{global:'A cup rests on the table.',characters:[],negative:'extra people'}});let probes=0;
    const selected=await session.select({shotSpec:shot,probe:async({recipe,guard})=>{probes++;await guard();assert.match(recipe.document.workflow,/original/);return {automaticEligible:true};}});
    assert.equal(probes,1);assert.equal(selected.executionAuthorized,false);assert.equal(selected.status,'selected');
  }finally{session.close();}
  assert.ok(!f.calls.some(row=>/prompt|generate|history|queue/.test(row.path)||row.request.method==='POST'));
});

test('archiving the actual pinned workflow blocks pool preparation instead of substituting a newer graph',async t=>{
  const f=await poolNativeFixture(t),store=f.openPool(),head=await save(f,store);f.configureDefaults();const pinned=await pinComfyAutoPool({namespace,selection:head});
  await f.workflows.archive(namespace,f.workflowHead.id,f.workflowHead.revision,true);f.reset();await assert.rejects(prepareComfyAutoSession({namespace,binding:pinned.binding}),/没有可用/);assert.equal(f.uploads,0);
});

test('same-prefix changes extend once; divergent branches stay exportable and explicit copies keep all original target bindings',async t=>{
  const f=await poolNativeFixture(t),old=await oldLibrary(t,f),native=f.openPool();await native.list(namespace);const third=await save(f,old.store,old.second,{enabled:false});await native.list(namespace);assert.equal((await native.versions(namespace,third.id)).length,3);
  f.time(20);const remote=await save(f,native,third,{styleLock:false});await save(f,old.store,third,{candidates:[]});const view=await native.view(namespace),source=view.recovery.sources.find(row=>row.pending.length);
  assert.equal(view.rows[0].revision,remote.revision);assert.deepEqual(await native.exportLegacy(namespace,source.census),await old.store.backup(namespace));
  await native.resolveLegacy(namespace,{census:source.census,id:third.id,choice:'copy',expectedRevision:view.recovery.revision,confirmed:true});
  const copies=await native.list(namespace),copy=copies.find(row=>row.id!==remote.id),versions=await native.versions(namespace,copy.id);assert.equal(copy.version,4);assert.equal(copies.find(row=>row.id===remote.id).revision,remote.revision);
  const earliest=await native.load(namespace,copy.id,versions.at(-1).revision);assert.deepEqual(earliest.pool.candidates,old.packet.pools[0].versions[0].pool.candidates);assert.equal(earliest.pool.enabled,true);assert.notEqual(earliest.pool.id,third.id);assert.equal(validateComfyPoolBackup(await native.backup(namespace)).versions,8);
});

test('archive and directory removal survive stale local changes; recovery restores only the archived originals',async t=>{
  const f=await poolNativeFixture(t),old=await oldLibrary(t,f),store=f.openPool();await store.list(namespace);await store.archive(namespace,old.first.id,old.second.revision,true);await save(f,old.store,old.second,{enabled:false});assert.deepEqual(await store.list(namespace),[]);
  await store.purge(namespace,old.first.id,old.second.revision);const state=await store.recoverySources(namespace),source=state.sources.find(row=>row.pending.length);await store.resolveLegacy(namespace,{census:source.census,id:old.first.id,choice:'keep',expectedRevision:state.revision,confirmed:true});assert.deepEqual(await store.list(namespace),[]);
  const current=await store.recoverySources(namespace);await store.restoreRetired(namespace,old.first.id,{expectedRevision:current.revision,confirmed:true});assert.deepEqual(await store.list(namespace),[]);assert.equal((await store.list(namespace,{archived:true}))[0].version,2);assert.equal((await store.exportLegacy(namespace,source.census)).pools[0].versions.length,3);
});

test('whole-pool restore requires same account and explicit unchanged approval; all stored toggles and history survive',async t=>{
  const f=await poolNativeFixture(t),store=f.openPool(),first=await save(f,store),second=await save(f,store,first,{enabled:false});await store.archive(namespace,first.id,second.revision,true);const packet=await store.backup(namespace);
  const target=await poolNativeFixture(t),other=target.openPool(),empty=await other.backup(namespace),expectedDigest=await comfyPoolBackupDigest(empty);target.reset();
  await assert.rejects(other.restoreBackup(namespace,packet,{expectedDigest}),/确认/);await assert.rejects(other.restoreBackup('st-user:foreign',packet,{expectedDigest,confirmed:true}),/另一ST账户/);assert.equal(target.uploads,0);
  await other.restoreBackup(namespace,packet,{expectedDigest,confirmed:true});assert.deepEqual(await other.backup(namespace),packet);assert.deepEqual(await other.list(namespace),[]);await assert.rejects(other.restoreBackup(namespace,packet,{expectedDigest,confirmed:true}),/确认后已变化/);
});

test('read-only inventory rejects unregistered local source instead of uploading or reporting zero',async t=>{
  const f=await poolNativeFixture(t);await oldLibrary(t,f);const store=f.openPool();f.reset();await assert.rejects(store.storageSummary(namespace),/未接入/);assert.equal(f.uploads,0);await store.list(namespace);f.reset();
  const summary=await store.storageSummary(namespace);assert.equal(summary.versions,2);assert.equal(summary.bytes,summary.documentBytes+summary.indexBytes);assert.equal(f.uploads,0);assert.ok(!f.calls.some(row=>row.path.includes('-comfy-pool-version-')));
});

test('corrupted/missing local documents or unavailable IDB cannot be silently turned into an empty native pool',async t=>{
  for(const damage of [f=>f.poolLocal.state.tables.documents.pop(),f=>f.poolLocal.state.failOpen=true,f=>f.poolLocal.state.tables.documents[0].pool.apiKey='forbidden']){
    const f=await poolNativeFixture(t);await oldLibrary(t,f);damage(f);const store=f.openPool();f.reset();await assert.rejects(store.list(namespace));assert.equal(f.uploads,0);
  }
});

test('missing historical original and a lost known directory fail without replacement files or latest-version fallback',async t=>{
  const f=await poolNativeFixture(t),store=f.openPool(),first=await save(f,store),second=await save(f,store,first,{enabled:false}),state=await index(f),old=state.pools[0].versions[0];f.files.delete(file(old.reference));f.reset();
  await assert.rejects(store.load(namespace,first.id,first.revision));assert.equal((await store.load(namespace,second.id,second.revision)).pool.enabled,false);await assert.rejects(store.backup(namespace));assert.equal(f.uploads,0);
  f.files.delete(`qianmu-v2-${f.storage.scope}-${slot}.json`);await assert.rejects(store.list(namespace),/目录缺失/);assert.equal(f.uploads,0);
});

test('lost directory acknowledgement is not retried and next verified access finds the single registered source',async t=>{
  const f=await poolNativeFixture(t);await oldLibrary(t,f);const store=f.openPool();let lost=false;
  f.hook(call=>{if(call.path==='/api/files/upload'){const {name,data}=JSON.parse(call.request.body),body=Buffer.from(data,'base64').toString('utf8'),value=JSON.parse(body);if(!lost&&value.schema==='qianmu.st-account-head.v1'&&value.slot===slot){lost=true;f.files.set(name,body);throw Error('lost ack');}}});
  await assert.rejects(store.list(namespace));f.hook(null);f.reset();assert.equal((await store.list(namespace))[0].version,2);assert.equal((await store.recoverySources(namespace)).sources.length,1);assert.equal(f.uploads,0);
});

test('local source changes during preservation stop migration head publication and retain original local data',async t=>{
  const f=await poolNativeFixture(t);await oldLibrary(t,f);const store=f.openPool();let changed=false;
  f.hook(call=>{if(!changed&&call.path==='/api/files/upload'){changed=true;f.poolLocal.state.tables.heads[0].archived=true;}});await assert.rejects(store.list(namespace),/期间变化/);f.hook(null);assert.equal((await f.storage.read(slot)).exists,false);assert.equal(f.poolLocal.state.tables.heads[0].archived,true);
});

test('stale revisions, stale approvals, nonboolean archival, clock regression and original limits reject without uploading',async t=>{
  const f=await poolNativeFixture(t),store=f.openPool(),first=await save(f,store),second=await save(f,store,first);f.reset();await assert.rejects(save(f,store,first),/已变化/);await assert.rejects(store.archive(namespace,first.id,second.revision,'false'),/归档状态/);f.time(1);await assert.rejects(save(f,store,second),/时间发生回退/);assert.equal(f.uploads,0);
  const small=f.openPool(comfyPoolIdbFixture(),{maxBytes:1,native:{createStorage:f.createStorage}});await assert.rejects(small.list(namespace),/容量/);assert.equal(f.uploads,0);
  f.time(20);await store.archive(namespace,first.id,second.revision,true);await store.purge(namespace,first.id,second.revision);const state=await store.recoverySources(namespace);await save(f,store);f.reset();await assert.rejects(store.restoreRetired(namespace,first.id,{expectedRevision:state.revision,confirmed:true}),/已变化/);assert.equal(f.uploads,0);
});

test('revoked account/page guards and closed sessions never publish a captured old-account candidate',async t=>{
  const f=await poolNativeFixture(t),store=f.openPool(),head=await save(f,store);f.reset();await assert.rejects(store.load(namespace,head.id,head.revision,{isCurrent:()=>false}));let guards=0;await assert.rejects(store.load(namespace,head.id,head.revision,{guard:()=>++guards<3}));assert.equal(f.uploads,0);store.close();await assert.rejects(store.list(namespace));
});

test('empty native inventory is measured zero and a too-small new-save limit stops before uploads',async t=>{
  const f=await poolNativeFixture(t),store=f.openPool(comfyPoolIdbFixture(),{maxBytes:1});f.reset();assert.deepEqual(await store.storageSummary(namespace),{status:'ready',count:0,archived:0,versions:0,documentBytes:0,indexBytes:0,bytes:0});await assert.rejects(save(f,store),/容量上限/);assert.equal(f.uploads,0);
});

test('another native client changing the directory during an original upload is not overwritten',async t=>{
  const f=await poolNativeFixture(t),store=f.openPool(),first=await save(f,store);
  const {createStAccountStorage}=await import('../qianmu-st-account-storage.js?pool-native-race');
  const createStorage=options=>createStAccountStorage({...options,resolveNamespace:async()=>namespace,isCurrent:options?.isCurrent||(()=>true),headers:()=>({'X-CSRF-Token':'synthetic'}),fetchImpl:f.fetchImpl,origin:'https://st.fixture.invalid'});
  const other=f.openPool(comfyPoolIdbFixture(),{native:{createStorage}});let changed=false,remote;
  f.hook(async call=>{if(!changed&&call.path==='/api/files/upload'&&JSON.parse(call.request.body).name.includes('-comfy-pool-version-')){changed=true;remote=await save(f,other,null,{styleLock:false});}});
  await assert.rejects(save(f,store,first,{enabled:false}),{code:'st_account_storage_conflict'});f.hook(null);const rows=await other.list(namespace);assert.equal(rows.find(row=>row.id===first.id).revision,first.revision);assert.ok(rows.some(row=>row.id===remote.id));
});

test('unknown native directory fields and damaged pool originals fail instead of normalizing away evidence',async t=>{
  const f=await poolNativeFixture(t),store=f.openPool(),head=await save(f,store),old=await f.storage.read(slot),before=structuredClone(old.value);before.unknown='do not ignore';await f.storage.write(slot,before,{expectedFingerprint:old.fingerprint});f.reset();await assert.rejects(f.openPool().list(namespace),/目录格式/);assert.equal(f.uploads,0);
  const current=await f.storage.read(slot);await f.storage.write(slot,old.value,{expectedFingerprint:current.fingerprint});const version=old.value.pools[0].versions[0];f.files.set(file(version.reference),'{}');f.reset();await assert.rejects(store.load(namespace,head.id,head.revision));assert.equal(f.uploads,0);
});

test('active and imported backups cannot bypass unknown-field or cross-account reference checks',async t=>{
  const f=await poolNativeFixture(t),store=f.openPool(),head=await save(f,store),backup=await store.backup(namespace),expectedDigest=await comfyPoolBackupDigest(backup);f.reset();
  for(const edit of [value=>value.pools[0].versions[0].pool.apiKey='forbidden',value=>value.pools[0].versions[0].pool.candidates[0].target.comfyReferences.namespace='st-user:foreign',value=>value.pools[0].versions[0].meta.bytes++]){
    const packet=structuredClone(backup);edit(packet);await assert.rejects(store.restoreBackup(namespace,packet,{expectedDigest,confirmed:true}));
  }assert.equal(f.uploads,0);assert.equal((await store.list(namespace))[0].revision,head.revision);
});

test('native recovery UI uses one compact snapshot, shows retained source choices and never changes the current selection',async()=>{
  const census='a'.repeat(64),calls=[],downloads=[];let views=0,selected=0;
  const buttons=Object.fromEntries(['copy-legacy','export-legacy'].map(action=>[action,{dataset:{poolAction:action},addEventListener(_,handler){this.click=()=>handler({preventDefault(){}});},closest:selector=>selector==='[data-pool-id]'?{dataset:{poolId:action==='export-legacy'?census:census+':old'}}:null}]));
  const host={isConnected:true,innerHTML:'',contains:()=>false,closest:()=>null,querySelector:()=>null,querySelectorAll:selector=>selector==='[data-pool-action]'?Object.values(buttons):[]};
  const value={rows:[],usage:{count:0,versions:0,bytes:0,limit:10000,persistence:'st-account-file'},recovery:{revision:7,sources:[{census,count:1,versions:2,pending:[{id:'old',name:'<old>',version:2}]}],retired:[]}};
  const store={view:async()=>{views++;return structuredClone(value);},list:()=>assert.fail('no redundant reads'),usage:()=>assert.fail('no redundant reads'),resolveLegacy:async(_ns,choice)=>calls.push(choice),exportLegacy:async()=>({complete:true}),close(){}};
  const c=createComfyPoolController({store,resolveNamespace:async()=>namespace,confirm:async()=>true,download:blob=>downloads.push(blob),onSelect:()=>selected++}),flush=async()=>{for(let i=0;i<8;i++)await new Promise(resolve=>setImmediate(resolve));};
  try{c.mount(host);await flush();assert.equal(views,1);assert.match(host.innerHTML,/sd-comfy-library-management/);assert.doesNotMatch(host.innerHTML,/<old>|ST 账户保存|当前目录正文量/);buttons['copy-legacy'].click();await flush();assert.deepEqual(calls,[{census,id:'old',choice:'copy',expectedRevision:7,confirmed:true}]);buttons['export-legacy'].click();await flush();assert.equal(downloads.length,1);assert.equal(selected,0);}finally{c.dispose();}
  const archived=renderComfyPools({...value,archived:true,rows:[{id:'old',name:'Old',candidateCount:1,totalBytes:100,version:2}]});assert.match(archived,/移出目录/);assert.doesNotMatch(archived,/永久清理/);
});
