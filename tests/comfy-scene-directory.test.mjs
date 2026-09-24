import test from 'node:test';
import assert from 'node:assert/strict';
import {COMFY_SELECTION_SCHEMA} from '../qianmu-comfy-selection.js';
import {createNativeComfySceneStore} from '../qianmu-comfy-scene-native-store.js';
import {COMFY_SCENE_NATIVE_SLOT as slot,sceneLeaves,sceneBytes} from '../qianmu-comfy-scene-native-contract.js';
import {comfySceneScopeKey} from '../qianmu-comfy-scene-lock.js';
import {COMFY_SCENE_SNAPSHOT_SCHEMA} from '../qianmu-comfy-scene-backup.js';
import {COMFY_SCENE_DIRECTORY_SCHEMA as schema,COMFY_SCENE_HISTORY_SCHEMA as pageSchema,COMFY_SCENE_HISTORY_SLOT as pageSlot,
  validateSceneDirectory,validateSceneHistoryPage,readSceneDirectory,sceneHistoryLocator} from '../qianmu-comfy-scene-directory.js';
import {characterNativeFixture,namespace} from './helpers/character-native-fixture.mjs';
import {comfySceneIdbFixture,comfySceneJournalFixture} from './helpers/comfy-scene-idb-fixture.mjs';

const scope={namespace,chatKey:'chat',continuityId:'scene',narrativeLayer:'present'};
const request=(id='A',target=scope,revision=0)=>({expectedGeneration:0,expectedRevision:revision,
  lock:{schema:COMFY_SELECTION_SCHEMA,scope:target,poolKey:'a'.repeat(64),candidateId:id,executionKey:'b'.repeat(64)},
  attemptId:id,ownerId:'page-'+id,token:'ticket-'+id,label:{planId:'plan',floor:1,workflowName:id}});
async function fixture(t){
  const f=await characterNativeFixture(t),open=(old=comfySceneIdbFixture(),log=comfySceneJournalFixture())=>{
    const legacy=old.open(),journal=log.open(),store=createNativeComfySceneStore({legacy,journal,createStorage:f.createStorage,now:()=>100});
    t.after(()=>store.close());return {store,old,log,legacy,journal};
  };
  const a=open(),complete=async(target=scope,id='A')=>{const reserved=await a.store.reserve(target,request(id,target));await a.store.begin(reserved.receipt);await a.store.settle(reserved.receipt,'succeeded');return reserved.receipt;};
  const writeRoot=async value=>{const found=await f.storage.read(slot);return f.storage.write(slot,value,{expectedFingerprint:found.fingerprint});};
  // Test-only future-format fixture: production exposes no writer or migration.
  const paginate=async(size=2)=>{
    const source=(await f.storage.read(slot)).value,directory={...structuredClone(source),schema,entries:[]},pages=[];
    for(const entry of source.entries){let previous=null;
      for(let start=0;start<entry.versions.length;start+=size){const versions=entry.versions.slice(start,start+size),value={schema:pageSchema,namespace,scope:entry.scope,start,previous,versions};
        const saved=await f.storage.preserveImmutable(pageSlot,value);pages.push({value,reference:saved.reference});previous={reference:saved.reference,count:start+versions.length};}
      directory.entries.push({scope:entry.scope,blocked:entry.blocked,heads:sceneLeaves(entry),history:previous});
    }
    await writeRoot(directory);return {source,directory,pages};
  };
  return Object.assign(f,{a,open,complete,paginate,writeRoot});
}
function original(f,reference){const row=[...f.files].find(([name])=>name.includes('-'+reference.slot+'-')&&name.endsWith('-'+reference.fingerprint+'.json'));assert.ok(row);return row;}
const historyReads=f=>f.calls.filter(row=>row.request.method==='GET'&&row.path.includes('-'+pageSlot+'-')).length;

test('default native reader preserves v1 views, complete exports and originals through multi-page compatibility',async t=>{
  const f=await fixture(t);await f.complete();await f.complete({...scope,continuityId:'second'},'B');
  const view=await f.a.store.inspect(scope),list=await f.a.store.list(namespace,'chat'),review=await f.a.store.review(namespace,'chat'),packet=await f.a.store.exportAll(namespace),one=await f.a.store.exportScene(scope);
  assert.equal(historyReads(f),0);const {source,directory,pages}=await f.paginate(2),before=new Map(f.files),local=structuredClone(f.a.old.state.tables),journal=await f.a.journal.read(namespace);f.reset();
  assert.deepEqual(await f.a.store.inspect(scope),view);assert.deepEqual(await f.a.store.list(namespace,'chat'),list);assert.deepEqual(await f.a.store.review(namespace,'chat'),review);
  assert.deepEqual(await f.a.store.exportAll(namespace),packet);assert.deepEqual(await f.a.store.exportScene(scope),one);
  const summary=await f.a.store.storageSummary(namespace);assert.equal(summary.count,2);assert.equal(summary.indexBytes,sceneBytes(directory)+pages.reduce((n,page)=>n+sceneBytes(page.value),0));
  assert.deepEqual((await readSceneDirectory(directory,{namespace,scope:f.storage.scope,readImmutable:ref=>f.storage.readImmutable(ref)})).index,source);
  assert.ok(historyReads(f)>0);assert.equal(f.uploads,0);assert.deepEqual(f.files,before);assert.deepEqual(f.a.old.state.tables,local);assert.deepEqual(await f.a.journal.read(namespace),journal);
});

test('cleared tombstones and generation survive paged reads without reviving old scenes',async t=>{
  const f=await fixture(t);await f.complete();await f.a.store.clearAccount(namespace,{expectedGeneration:0});const before=await f.a.store.exportAll(namespace);await f.paginate(1);f.reset();
  assert.deepEqual(await f.a.store.exportAll(namespace),before);assert.equal((await f.a.store.inspect(scope)).generation,1);assert.equal((await f.a.store.inspect(scope)).lock,null);
  assert.deepEqual(await f.a.store.list(namespace,'chat'),[]);assert.equal((await f.a.store.storageSummary(namespace)).count,0);assert.equal(f.uploads,0);
});

for(const resolved of [false,true])test(`legacy fork ${resolved?'explicit resolution':'complete branches'} remains intact after pagination`,async t=>{
  const f=await fixture(t);await f.complete();const old=comfySceneIdbFixture(),local=old.open();t.after(()=>local.close());
  const reserved=await local.reserve(scope,request('B'));await local.begin(reserved.receipt);await local.settle(reserved.receipt,'succeeded');const b=f.open(old),fork=(await b.store.review(namespace,'chat')).rows[0];assert.equal(fork.branches.length,2);
  if(resolved)await b.store.resolveSource(scope,{heads:fork.heads,generation:fork.generation,selected:fork.branches[0].digest,acknowledged:true});
  const before=await b.store.review(namespace,'chat'),packet=await b.store.exportScene(scope);await f.paginate(1);f.reset();
  assert.deepEqual(await b.store.review(namespace,'chat'),before);assert.deepEqual(await b.store.exportScene(scope),packet);
  if(resolved)assert.equal((await b.store.inspect(scope)).established,true);else await assert.rejects(b.store.inspect(scope),/分叉/);assert.equal(f.uploads,0);
});

for(const corruption of ['missing','tampered'])test(`${corruption} immutable history fails closed without empty replacement or uploads`,async t=>{
  const f=await fixture(t);await f.complete();const {pages}=await f.paginate(1),[name,body]=original(f,pages[0].reference);
  if(corruption==='missing')f.files.delete(name);else{const value=JSON.parse(body);value.value.versions[0].stateBytes++;f.files.set(name,JSON.stringify(value));}
  const before=new Map(f.files);f.reset();await assert.rejects(f.a.store.inspect(scope));await assert.rejects(f.a.store.exportAll(namespace));assert.equal(f.uploads,0);assert.deepEqual(f.files,before);
});

test('missing transition original cannot masquerade as a verified current state or full export',async t=>{
  const f=await fixture(t);await f.complete();const {source}=await f.paginate(1),[name]=original(f,source.entries[0].versions.at(-1).reference);f.files.delete(name);f.reset();
  const review=await f.a.store.review(namespace,'chat');assert.ok(review.rows[0].error);assert.deepEqual(review.rows[0].branches,[]);await assert.rejects(f.a.store.inspect(scope));await assert.rejects(f.a.store.exportAll(namespace));assert.equal(f.uploads,0);
});

test('read-compatible directories reject new publication before uploads and preserve the exact pending intent for later recovery',async t=>{
  const f=await fixture(t);await f.complete();await f.paginate();const before=new Map(f.files);f.reset();
  await assert.rejects(f.a.store.reserve({...scope,continuityId:'new'},request('B',{...scope,continuityId:'new'})),/仅兼容读取/);
  const journal=await f.a.journal.read(namespace);assert.equal(journal.pending.proposal.kind,'reserve');assert.equal(f.uploads,0);
  const packet=await f.a.store.exportAll(namespace);assert.deepEqual(packet.localJournal,journal);assert.equal(packet.entries.length,1);assert.deepEqual(f.files,before);
});

test('new legacy sources on a read-compatible root stop before preservation uploads and leave both old tables intact',async t=>{
  const f=await fixture(t);await f.complete();await f.paginate();const old=comfySceneIdbFixture(),legacy=old.open();t.after(()=>legacy.close());await legacy.reserve(scope,request('B'));
  const snapshot=structuredClone(old.state.tables),b=f.open(old),before=new Map(f.files);f.reset();await assert.rejects(b.store.review(namespace,'chat'),/仅兼容读取/);
  assert.equal(f.uploads,0);assert.deepEqual(old.state.tables,snapshot);assert.deepEqual(f.files,before);assert.equal((await b.journal.read(namespace)).pending,null);
});

test('lost v1 acknowledgement can be proved from paginated full history without publishing a second operation',async t=>{
  const f=await fixture(t);let lost=false;f.hook(call=>{if(call.path==='/api/files/upload'){const {name,data}=JSON.parse(call.request.body),body=Buffer.from(data,'base64').toString('utf8'),value=JSON.parse(body);
    if(!lost&&value.schema==='qianmu.st-account-head.v1'&&value.slot===slot){lost=true;f.files.set(name,body);throw Error('lost acknowledgement');}}});
  await assert.rejects(f.a.store.reserve(scope,request()));f.hook(null);const pending=(await f.a.journal.read(namespace)).pending;assert.ok(pending);await f.paginate(1);f.reset();
  assert.equal((await f.a.store.inspect(scope)).pending,1);assert.equal((await f.a.journal.read(namespace)).pending,null);assert.equal(f.uploads,0);assert.equal((await f.a.store.exportScene(scope)).versions.length,1);
});

for(const paged of [false,true])test(`full export never replays a pending publication (${paged?'v2':'v1'})`,async t=>{
  const f=await fixture(t);await f.complete();f.hook(call=>{if(call.path==='/api/files/upload')throw Error('offline');});
  const target={...scope,continuityId:'pending'};await assert.rejects(f.a.store.reserve(target,request('B',target)));f.hook(null);const pending=await f.a.journal.read(namespace);if(paged)await f.paginate();
  const before=new Map(f.files);f.reset();const packet=await f.a.store.exportAll(namespace);assert.deepEqual(packet.localJournal,pending);assert.equal(packet.entries.length,1);assert.equal(f.uploads,0);assert.deepEqual(f.files,before);
});

for(const edge of ['account','abort','root-change','legacy-change'])test(`${edge} during history read prevents a stale successful result`,async t=>{
  const f=await fixture(t);await f.complete();const {directory}=await f.paginate(1),controller=new AbortController();let changed=false;
  f.hook(call=>{if(!changed&&call.path.includes('-'+pageSlot+'-')){changed=true;
    if(edge==='account')f.account('st-user:other');if(edge==='abort')controller.abort();
    if(edge==='root-change')for(const [name,body]of f.files){const value=JSON.parse(body);if(value.schema==='qianmu.st-account-head.v1'&&value.slot===slot){value.fingerprint='f'.repeat(64);f.files.set(name,JSON.stringify(value));}}
    if(edge==='legacy-change')f.a.old.state.tables.usage.set(namespace,{count:0,bytes:0,generation:1});
  }});
  // Legacy changes are made after the baseline snapshot, while loading originals.
  if(edge==='legacy-change'){changed=false;f.hook(call=>{if(!changed&&call.path.includes('-comfy-scene-transition-')){changed=true;f.a.old.state.tables.usage.set(namespace,{count:0,bytes:0,generation:1});}});}
  f.reset();await assert.rejects(f.a.store.review(namespace,'chat',{signal:controller.signal}));assert.equal(changed,true);assert.equal(f.uploads,0);assert.equal(directory.schema,schema);
});

const rootMutations={
  unknown:value=>{value.extra=true;},namespace:value=>{value.namespace='st-user:other';},duplicate:value=>{value.entries.push(structuredClone(value.entries[0]));},
  'foreign-scope':value=>{value.entries[0].scope.namespace='st-user:other';},'missing-head':value=>{value.entries[0].heads=[];},
  'duplicate-head':value=>{value.entries[0].heads.push(structuredClone(value.entries[0].heads[0]));},
  'foreign-reference':value=>{value.entries[0].history.reference.scope='f'.repeat(64);},'wrong-slot':value=>{value.entries[0].history.reference.slot='comfy-scene-transition';},
  'oversized-reference':value=>{value.entries[0].history.reference.bytes=128*1024+1025;},'invalid-count':value=>{value.entries[0].history.count=8193;},
};
for(const [name,mutate]of Object.entries(rootMutations))test(`light directory header rejects ${name} before any history fetch`,async t=>{
  const f=await fixture(t);await f.complete();const directory=structuredClone((await f.paginate()).directory);mutate(directory);let reads=0;
  await assert.rejects(readSceneDirectory(directory,{namespace,scope:f.storage.scope,readImmutable:async()=>{reads++;throw Error('must not fetch');}}));assert.equal(reads,0);
});

const pageMutations={
  unknown:value=>{value.extra=true;},namespace:value=>{value.namespace='st-user:other';},scope:value=>{value.scope.continuityId='another';},
  'missing-prefix':value=>{value.previous=null;},'wrong-prefix-count':value=>{value.previous.count++;},'wrong-start':value=>{value.start++;},
  'future-schema':value=>{value.schema='qianmu.comfy.scene-history.v9';},empty:value=>{value.versions=[];},
  'oversized-page':value=>{value.versions[0].parents=Array.from({length:2100},(_,i)=>i.toString(16).padStart(64,'0'));},
};
for(const [name,mutate]of Object.entries(pageMutations))test(`immutable history contract rejects ${name} even when its file hash is valid`,async t=>{
  const f=await fixture(t);await f.complete();const {directory,pages}=await f.paginate(2),value=structuredClone(pages.at(-1).value);mutate(value);
  const saved=await f.storage.preserveImmutable(pageSlot,value);directory.entries[0].history.reference=saved.reference;await f.writeRoot(directory);f.reset();
  await assert.rejects(f.a.store.inspect(scope));assert.equal(f.uploads,0);
});

test('page entry/count limits, root previous pointer and duplicate metadata are strict',async t=>{
  const f=await fixture(t);await f.complete();const {pages}=await f.paginate(2),first=pages[0].value,options={namespace,scope,storageScope:f.storage.scope,count:2};
  assert.doesNotThrow(()=>validateSceneHistoryPage(first,options));assert.throws(()=>validateSceneHistoryPage({...first,versions:Array(65).fill(first.versions[0])},{...options,count:65}));
  assert.throws(()=>validateSceneHistoryPage({...first,previous:{reference:pages[0].reference,count:2}},options));
  assert.throws(()=>validateSceneHistoryPage({...first,versions:[first.versions[0],first.versions[0]]},options));
  for(const count of [0,-1,1.5,8193])assert.throws(()=>sceneHistoryLocator({reference:pages[0].reference,count},f.storage.scope));
});

for(const broken of ['duplicate','predecessor','head'])test(`cross-page ${broken} inconsistency is rejected after complete reconstruction`,async t=>{
  const f=await fixture(t);await f.complete();const {directory,pages}=await f.paginate(2),last=structuredClone(pages.at(-1).value);
  if(broken==='duplicate')last.versions[0]=structuredClone(pages[0].value.versions[0]);if(broken==='predecessor')last.versions[0].parents=['f'.repeat(64)];
  const saved=await f.storage.preserveImmutable(pageSlot,last);directory.entries[0].history.reference=saved.reference;
  directory.entries[0].heads=broken==='head'?[pages[0].value.versions[0]]:[last.versions[0]];await f.writeRoot(directory);f.reset();await assert.rejects(f.a.store.inspect(scope));assert.equal(f.uploads,0);
});

test('directory and page inputs are captured before async guards can mutate caller-owned objects',async t=>{
  const f=await fixture(t);await f.complete();const {source,directory,pages}=await f.paginate(2);let first=true,lastReturned=null;
  const reading=readSceneDirectory(directory,{namespace,scope:f.storage.scope,readImmutable:async ref=>{
    const page=pages.find(row=>row.reference.fingerprint===ref.fingerprint);lastReturned=structuredClone(page.value);return {value:lastReturned};},
    check:async()=>{if(first){first=false;directory.entries[0].heads=[];directory.namespace='st-user:other';}else if(lastReturned){lastReturned.versions=[];lastReturned=null;}}});
  assert.deepEqual((await reading).index,source);
});

test('no native migration or paging uploads occur on the default v1 lifecycle',async t=>{
  const f=await fixture(t);await f.complete();const directory=(await f.storage.read(slot)).value;assert.notEqual(directory.schema,schema);assert.equal(historyReads(f),0);
  assert.ok([...f.files.keys()].every(name=>!name.includes('-'+pageSlot+'-')));assert.doesNotThrow(()=>validateSceneDirectory(directory,namespace,f.storage.scope));
});

test('page cycles stop before re-reading an already verified immutable reference',async t=>{
  const f=await fixture(t);await f.complete();const {directory,pages}=await f.paginate(2),last=structuredClone(pages.at(-1).value);last.previous.reference=pages.at(-1).reference;let reads=0;
  await assert.rejects(readSceneDirectory(directory,{namespace,scope:f.storage.scope,readImmutable:async()=>{reads++;return {value:last};}}),/循环引用/);assert.equal(reads,1);
});

test('aggregate history budget stops a hostile but individually bounded page chain without truncated success',async t=>{
  const f=await fixture(t);await f.complete();const {directory,pages}=await f.paginate(),meta=pages[0].value.versions[0],reference=pages[0].reference;
  const heavy={...meta,parents:Array.from({length:950},(_,i)=>i.toString(16).padStart(64,'0'))},map=new Map();let previous=null;
  for(let i=0;i<150;i++){
    const key=(i+1).toString(16).padStart(64,'0'),versions=[{...heavy,digest:(10000+i*2).toString(16).padStart(64,'0')},{...heavy,digest:(10001+i*2).toString(16).padStart(64,'0')}];
    map.set(key,{schema:pageSchema,namespace,scope,start:i*2,previous,versions});previous={reference:{...reference,fingerprint:key},count:(i+1)*2};
  }
  directory.entries[0].history=previous;directory.entries[0].heads=[map.get(previous.reference.fingerprint).versions.at(-1)];let reads=0;
  await assert.rejects(readSceneDirectory(directory,{namespace,scope:f.storage.scope,readImmutable:async ref=>{reads++;return {value:map.get(ref.fingerprint)};}}),/完整历史超过/);
  assert.ok(reads>100&&reads<150);
});

test('a declared ancestor cannot appear alongside its descendant as a current head',async t=>{
  const f=await fixture(t);await f.complete();const {directory,source}=await f.paginate();directory.entries[0].heads=source.entries[0].versions.slice(-2);
  assert.throws(()=>validateSceneDirectory(directory,namespace,f.storage.scope),/不是末端/);
});

test('multi-branch late-result originals remain complete and verifiable across page boundaries',async t=>{
  const f=await fixture(t),reserved=await f.a.store.reserve(scope,request());await f.a.store.begin(reserved.receipt);
  const record=structuredClone((await f.a.store.exportScene(scope)).versions.at(-1).record);record.label.sceneTitle='Other retained source';const bytes=sceneBytes(record);
  const old=comfySceneIdbFixture({schema:COMFY_SCENE_SNAPSHOT_SCHEMA,namespace,usage:{count:1,bytes,generation:0},rows:[{key:comfySceneScopeKey(scope),value:{namespace,chatKey:scope.chatKey,bytes,record}}]});
  const b=f.open(old);await b.store.review(namespace,'chat');await f.a.store.settle(reserved.receipt,'succeeded');
  const before=await b.store.exportScene(scope),review=await b.store.review(namespace,'chat');assert.equal(before.versions.filter(event=>event.action?.type==='branch_result').length,2);
  await f.paginate(1);f.reset();assert.deepEqual(await b.store.exportScene(scope),before);assert.deepEqual(await b.store.review(namespace,'chat'),review);assert.equal(f.uploads,0);
});

test('an already-published pending proposal still requires its exact original before acknowledgement',async t=>{
  const f=await fixture(t);let lost=false;f.hook(call=>{if(call.path==='/api/files/upload'){const {name,data}=JSON.parse(call.request.body),body=Buffer.from(data,'base64').toString('utf8'),value=JSON.parse(body);
    if(!lost&&value.schema==='qianmu.st-account-head.v1'&&value.slot===slot){lost=true;f.files.set(name,body);throw Error('lost');}}});
  await assert.rejects(f.a.store.reserve(scope,request()));f.hook(null);const before=await f.a.journal.read(namespace),{source}=await f.paginate(1);
  f.files.delete(original(f,source.entries[0].versions[0].reference)[0]);f.reset();await assert.rejects(f.a.store.inspect(scope));
  assert.deepEqual(await f.a.journal.read(namespace),before);assert.equal(f.uploads,0);
});
