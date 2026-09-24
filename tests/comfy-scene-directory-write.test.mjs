import test from 'node:test';
import assert from 'node:assert/strict';
import {COMFY_SELECTION_SCHEMA} from '../qianmu-comfy-selection.js';
import {createNativeComfySceneStore} from '../qianmu-comfy-scene-native-store.js';
import {COMFY_SCENE_NATIVE_SLOT as slot,sceneBytes} from '../qianmu-comfy-scene-native-contract.js';
import {COMFY_SCENE_DIRECTORY_SCHEMA as schema,COMFY_SCENE_HISTORY_SLOT as pageSlot,readSceneDirectory} from '../qianmu-comfy-scene-directory.js';
import {prepareSceneDirectoryWrite,shouldPageSceneDirectory} from '../qianmu-comfy-scene-directory-write.js';
import {COMFY_SCENE_SNAPSHOT_SCHEMA} from '../qianmu-comfy-scene-backup.js';
import {comfySceneScopeKey} from '../qianmu-comfy-scene-lock.js';
import {characterNativeFixture,namespace} from './helpers/character-native-fixture.mjs';
import {comfySceneIdbFixture,comfySceneJournalFixture} from './helpers/comfy-scene-idb-fixture.mjs';

const scope={namespace,chatKey:'chat',continuityId:'scene',narrativeLayer:'present'},lock=target=>({schema:COMFY_SELECTION_SCHEMA,scope:target,poolKey:'a'.repeat(64),candidateId:'candidate',executionKey:'b'.repeat(64)});
let seedFiles;
async function fixture(t,{seed=true,old=comfySceneIdbFixture()}={}){
  const f=await characterNativeFixture(t),open=(legacy=old,log=comfySceneJournalFixture(),createStorage=f.createStorage)=>{
    const journal=log.open(),store=createNativeComfySceneStore({legacy:legacy.open(),journal,createStorage,now:()=>100});t.after(()=>store.close());return {store,journal,old:legacy,log};
  },a=open();
  const reserve=async(id,target=scope,client=a)=>{const state=await client.store.inspect(target);return client.store.reserve(target,{lock:lock(target),expectedRevision:state.revision,expectedGeneration:state.generation,attemptId:id,ownerId:'page',token:'token-'+id,label:{planId:'plan',floor:1}});};
  const complete=async(id,target=scope)=>{const result=await reserve(id,target);await a.store.begin(result.receipt);await a.store.settle(result.receipt,'succeeded');return result;};
  if(seed){if(seedFiles)for(const [name,body]of seedFiles)f.files.set(name,body);else{for(let i=0;i<21;i++)await complete('seed-'+i);seedFiles=new Map(f.files);}}
  const root=async()=>(await f.storage.read(slot)).value;
  const directory=async()=>readSceneDirectory(await root(),{namespace,scope:f.storage.scope,readImmutable:ref=>f.storage.readImmutable(ref)});
  return Object.assign(f,{a,open,reserve,complete,root,directory});
}
const uploaded=call=>call.path==='/api/files/upload'?JSON.parse(Buffer.from(JSON.parse(call.request.body).data,'base64').toString('utf8')):null;
const pageUploads=f=>f.calls.filter(call=>uploaded(call)?.slot===pageSlot).length;
function retained(before,after){for(const [name,body]of before)if(JSON.parse(body).schema!=='qianmu.st-account-head.v1')assert.equal(after.get(name),body);}

test('actual default lifecycle activates at 64 versions, reuses full pages and updates only a bounded tail',async t=>{
  const f=await fixture(t),old=await f.root();assert.equal(old.entries[0].versions.length,63);assert.equal(shouldPageSceneDirectory(old),false);const originals=new Map(f.files);f.reset();
  const reserved=await f.reserve('next');let root=await f.root();assert.equal(root.schema,schema);assert.equal(root.entries[0].history.count,64);assert.equal(pageUploads(f),1);
  const first=root.entries[0].history.reference;f.reset();await f.a.store.begin(reserved.receipt);root=await f.root();assert.equal(pageUploads(f),1);assert.equal(root.entries[0].history.count,65);
  const tail=(await f.storage.readImmutable(root.entries[0].history.reference)).value;assert.deepEqual(tail.previous,{reference:first,count:64});assert.equal(tail.versions.length,1);
  f.reset();await f.a.store.settle(reserved.receipt,'succeeded');root=await f.root();assert.equal(pageUploads(f),1);assert.equal(root.entries[0].history.count,66);
  const nextTail=(await f.storage.readImmutable(root.entries[0].history.reference)).value;assert.deepEqual(nextTail.previous,tail.previous);assert.equal(nextTail.versions.length,2);
  const b=f.open(comfySceneIdbFixture());assert.deepEqual(await b.store.inspect(scope),await f.a.store.inspect(scope));assert.equal((await b.journal.read(namespace)).claims.length,0);retained(originals,f.files);
  assert.equal((await b.store.exportScene(scope)).versions.length,66);
});

test('wide shallow histories stay v1 rather than add a history request for every scene',async t=>{
  const f=await fixture(t,{seed:false});for(let i=0;i<64;i++)await f.reserve('item-'+i,{...scope,continuityId:'scene-'+i});
  const root=await f.root();assert.notEqual(root.schema,schema);assert.equal(root.entries.length,64);assert.equal(shouldPageSceneDirectory(root),false);assert.equal(pageUploads(f),0);
});

for(const failure of ['page','head','ack'])test(`${failure} failure around automatic activation keeps exact intent and recovers without duplicate events`,async t=>{
  const f=await fixture(t),before=new Map(f.files),originalRoot=await f.root();let hit=false;
  f.hook(call=>{const value=uploaded(call);if(!hit&&(failure==='page'?value?.slot===pageSlot:value?.schema==='qianmu.st-account-head.v1'&&value.slot===slot)){
    hit=true;if(failure==='ack'){const {name,data}=JSON.parse(call.request.body);f.files.set(name,Buffer.from(data,'base64').toString('utf8'));}throw Error('lost '+failure);
  }});
  await assert.rejects(f.reserve('interrupted'));assert.equal(hit,true);f.hook(null);const pending=await f.a.journal.read(namespace);assert.equal(pending.pending.proposal.kind,'reserve');
  if(failure!=='ack')assert.deepEqual(await f.root(),originalRoot);retained(before,f.files);f.a.store.close();
  const resumed=f.open(f.a.old,f.a.log);f.reset();assert.equal((await resumed.store.inspect(scope)).pending,1);assert.equal((await resumed.journal.read(namespace)).pending,null);
  assert.equal((await resumed.store.exportScene(scope)).versions.length,64);assert.equal((await f.root()).schema,schema);if(failure!=='page')assert.equal(pageUploads(f),0);if(failure==='ack')assert.equal(f.uploads,0);
});

test('failure after page upload can be exported without retrying publication or hiding retained pending work',async t=>{
  const f=await fixture(t);f.hook(call=>{const value=uploaded(call);if(value?.schema==='qianmu.st-account-head.v1'&&value.slot===slot)throw Error('offline head');});
  await assert.rejects(f.reserve('pending'));f.hook(null);const pending=await f.a.journal.read(namespace);f.reset();const packet=await f.a.store.exportAll(namespace);
  assert.equal(packet.entries[0].versions.length,63);assert.deepEqual(packet.localJournal,pending);assert.equal(f.uploads,0);
});

test('a competing device winning during page creation is not overwritten and the loser retains its conflict',async t=>{
  const f=await fixture(t),isolated=await import('../qianmu-st-account-storage.js?paged-independent-race');
  const b=f.open(comfySceneIdbFixture(),comfySceneJournalFixture(),options=>isolated.createStAccountStorage({...options,resolveNamespace:async()=>namespace,origin:'https://st.fixture.invalid',headers:()=>({'X-CSRF-Token':'synthetic'}),fetchImpl:f.fetchImpl}));
  let raced=false,winner;f.hook(async call=>{if(!raced&&uploaded(call)?.slot===pageSlot){raced=true;winner=await f.reserve('winner',scope,b);}});
  await assert.rejects(f.reserve('loser'),{code:'st_account_storage_conflict'});f.hook(null);const pending=(await f.a.journal.read(namespace)).pending;assert.ok(pending);f.reset();
  assert.equal((await f.a.store.inspect(scope)).pending,1);const journal=await f.a.journal.read(namespace);assert.equal(journal.pending,null);assert.deepEqual(journal.conflicts,[pending]);assert.equal(f.uploads,0);
  const packet=await b.store.exportScene(scope);assert.equal(packet.versions.length,64);assert.equal(packet.versions.at(-1).action.attemptId,'winner');await b.store.begin(winner.receipt);
});

for(const change of ['account','legacy'])test(`${change} change before new root publication preserves the previous directory`,async t=>{
  const f=await fixture(t),before=await f.root();let changed=false;
  f.hook(call=>{if(!changed&&uploaded(call)?.slot===pageSlot){changed=true;if(change==='account')f.account('st-user:other');else f.a.old.state.tables.usage.set(namespace,{count:0,bytes:0,generation:1});}});
  await assert.rejects(f.reserve('changed'));f.hook(null);f.account(namespace);assert.equal(changed,true);assert.deepEqual(await f.root(),before);assert.ok((await f.a.journal.read(namespace)).pending);
});

test('page readback mismatch prevents root publication while preserving the transaction intent',async t=>{
  const f=await fixture(t),before=await f.root();let tampered=false;
  f.hook(call=>{const value=uploaded(call);if(value?.slot===pageSlot){const {name,data}=JSON.parse(call.request.body),body=JSON.parse(Buffer.from(data,'base64').toString('utf8'));body.value.versions[0].stateBytes++;
    f.files.set(name,JSON.stringify(body));tampered=true;return new Response(JSON.stringify({path:'/user/files/'+name}),{headers:{'content-type':'application/json'}});}});
  await assert.rejects(f.reserve('broken'));f.hook(null);assert.equal(tampered,true);assert.deepEqual(await f.root(),before);assert.ok((await f.a.journal.read(namespace)).pending);
});

test('clearing and style links keep generation and complete histories through subsequent paged writes',async t=>{
  const f=await fixture(t);await f.complete('next');const before=await f.a.store.inspect(scope),target={...scope,continuityId:'linked'};
  await f.a.store.linkStyle(scope,target,{expectedSourceRevision:before.revision,expectedRevision:0,expectedGeneration:0,label:{planId:'link',floor:2}});
  const root=await f.root();assert.equal(root.entries.length,2);assert.equal(root.entries[1].history.count,1);assert.equal((await f.a.store.inspect(target)).styleOrigin.sourceFloor,1);
  const result=await f.a.store.clearAccount(namespace,{expectedGeneration:0});assert.equal(result.generation,1);assert.deepEqual(await f.a.store.list(namespace,'chat'),[]);
  const packet=await f.a.store.exportAll(namespace);assert.equal(packet.entries.length,2);assert.ok(packet.entries.every(entry=>entry.versions.at(-1).action.type==='clear'));
  const reserved=await f.reserve('after-clear');assert.equal(reserved.view.generation,1);assert.equal((await f.root()).schema,schema);
});

test('legacy empty tombstones preserve their original generation on first publication',async t=>{
  const old=comfySceneIdbFixture({schema:COMFY_SCENE_SNAPSHOT_SCHEMA,namespace,usage:{count:0,bytes:0,generation:7},rows:[]}),f=await fixture(t,{seed:false,old});
  const before=structuredClone(old.state.tables);assert.equal((await f.a.store.inspect(scope)).generation,7);assert.equal((await f.root()).cleared,true);assert.deepEqual(old.state.tables,before);
});

test('new completed legacy sources and explicit resolution append to paged history without deleting either source',async t=>{
  const f=await fixture(t);await f.complete('next');const old=comfySceneIdbFixture(),local=old.open();t.after(()=>local.close());
  const reserved=await local.reserve(scope,{lock:{...lock(scope),candidateId:'other'},expectedRevision:0,expectedGeneration:0,attemptId:'other',ownerId:'other',token:'other'});
  await local.begin(reserved.receipt);await local.settle(reserved.receipt,'succeeded');const snapshot=structuredClone(old.state.tables),b=f.open(old),row=(await b.store.review(namespace,'chat')).rows[0];
  assert.equal(row.branches.length,2);const originals=new Map(f.files);await b.store.resolveSource(scope,{heads:row.heads,generation:row.generation,selected:row.branches[0].digest,acknowledged:true});
  assert.equal((await b.store.exportScene(scope)).versions.at(-1).action.type,'resolve');assert.deepEqual(old.state.tables,snapshot);retained(originals,f.files);assert.equal((await f.root()).schema,schema);
});

const illegal={truncate:value=>{value.entries[0].versions.pop();},rewrite:value=>{value.entries[0].versions[0].stateBytes++;},remove:value=>{value.entries=[];},revision:value=>{value.revision++;},generation:value=>{value.generation+=2;}};
for(const [name,mutate]of Object.entries(illegal))test(`append preparation rejects ${name} before preserving any pages`,async t=>{
  const f=await fixture(t);await f.reserve('next');const current=await f.directory(),next=structuredClone(current.index);next.revision++;mutate(next);let writes=0;
  await assert.rejects(prepareSceneDirectoryWrite(next,{current,namespace,scope:f.storage.scope,preserveImmutable:async()=>{writes++;throw Error('should not write');}}));assert.equal(writes,0);
});

test('write preparation captures both proposed and verified source objects before the first asynchronous guard',async t=>{
  const f=await fixture(t);await f.reserve('next');const current=await f.directory(),next=structuredClone(current.index);next.revision++;const expected=structuredClone(next);let first=true;
  const prepared=await prepareSceneDirectoryWrite(next,{current,namespace,scope:f.storage.scope,preserveImmutable:()=>assert.fail('unchanged histories need no upload'),check:async()=>{
    if(first){first=false;current.root.entries=[];current.index.entries=[];next.entries=[];}
  }});assert.deepEqual(prepared.index,expected);assert.equal(prepared.root.entries[0].history.count,64);
});

test('very large explicit parent metadata keeps the full v1 contract instead of truncating to fit a page',async t=>{
  // Contract-only capacity input. Synthetic metadata is not evidence of real events.
  const f=await fixture(t);await f.reserve('next');const current=await f.directory(),next=structuredClone(current.index),entry=next.entries[0],template=entry.versions[0];next.revision++;
  const parents=[];for(let i=0;i<2100;i++){const digest=(i+10000).toString(16).padStart(64,'0');parents.push(digest);entry.versions.push({...template,digest,parents:[]});}
  entry.versions.push({...template,digest:'f'.repeat(64),parents});let writes=0;
  const prepared=await prepareSceneDirectoryWrite(next,{current,namespace,scope:f.storage.scope,preserveImmutable:async()=>{writes++;assert.fail('must retain v1');}});
  assert.notEqual(prepared.root.schema,schema);assert.deepEqual(prepared.index,next);assert.equal(writes,0);
});

test('retained directory growth is bounded by page tails while complete exported history remains available',async t=>{
  const f=await fixture(t),rows=[];let equivalentV1Bytes=0;
  for(const [,body]of f.files){const value=JSON.parse(body);if(value.schema==='qianmu.st-account-document.v1'&&value.slot===slot)equivalentV1Bytes+=Buffer.byteLength(body);}
  for(let n=21;n<48;n++){
    const reserved=await f.reserve('growth-'+n);await record();await f.a.store.begin(reserved.receipt);await record();await f.a.store.settle(reserved.receipt,'succeeded');await record();
    if([31,47].includes(n)){
      const current=await f.directory(),bodies=[...f.files].filter(([,body])=>{const value=JSON.parse(body);return value.schema==='qianmu.st-account-document.v1'&&[slot,pageSlot].includes(value.slot);});
      const retainedBytes=bodies.reduce((sum,[,body])=>sum+Buffer.byteLength(body),0);assert.ok(retainedBytes<equivalentV1Bytes);assert.ok(sceneBytes(current.root)<1500);
      assert.equal((await f.a.store.exportScene(scope)).versions.length,(n+1)*3);rows.push({tasks:n+1,versions:(n+1)*3,rootBytes:sceneBytes(current.root),retainedBytes,equivalentV1Bytes});
    }
  }
  async function record(){const current=await f.directory();equivalentV1Bytes+=Buffer.byteLength(JSON.stringify({schema:'qianmu.st-account-document.v1',scope:f.storage.scope,slot,value:current.index}));}
  t.diagnostic(JSON.stringify({scope:'synthetic ST/IDB writes; exact equivalent v1 body sizes, not VPS latency or disk usage',rows}));
});

for(const action of ['begin','settle'])test(`${action} interrupted on a tail update recovers its original metadata operation only`,async t=>{
  const f=await fixture(t),reserved=await f.reserve('tail');if(action==='settle')await f.a.store.begin(reserved.receipt);const before=await f.root();
  f.hook(call=>{if(uploaded(call)?.slot===pageSlot)throw Error('offline tail');});
  await assert.rejects(action==='begin'?f.a.store.begin(reserved.receipt):f.a.store.settle(reserved.receipt,'succeeded'));f.hook(null);
  assert.deepEqual(await f.root(),before);assert.equal((await f.a.journal.read(namespace)).pending.proposal.kind,action);f.a.store.close();const resumed=f.open(f.a.old,f.a.log);
  const view=await resumed.store.inspect(scope);assert.equal(view.pending,action==='begin'?1:0);assert.equal((await resumed.journal.read(namespace)).pending,null);
  const packet=await resumed.store.exportScene(scope);assert.equal(packet.versions.length,action==='begin'?65:66);assert.equal(packet.versions.at(-1).action.type,action);
  assert.ok(f.calls.every(call=>call.path==='/api/files/upload'||call.path.startsWith('/user/files/')));
});

test('late original-task results append across all matching paged branches without choosing a source',async t=>{
  const f=await fixture(t),reserved=await f.reserve('late');await f.a.store.begin(reserved.receipt);
  const record=structuredClone((await f.a.store.exportScene(scope)).versions.at(-1).record);record.label.sceneTitle='Second source';const bytes=sceneBytes(record);
  const old=comfySceneIdbFixture({schema:COMFY_SCENE_SNAPSHOT_SCHEMA,namespace,usage:{count:1,bytes,generation:0},rows:[{key:comfySceneScopeKey(scope),value:{namespace,chatKey:scope.chatKey,bytes,record}}]});
  const b=f.open(old);assert.equal((await b.store.review(namespace,'chat')).rows[0].branches.length,2);const before=new Map(f.files);
  const result=await f.a.store.settle(reserved.receipt,'succeeded');assert.equal(result.view.conflicted,true);const packet=await f.a.store.exportScene(scope);
  assert.equal(packet.versions.filter(event=>event.action?.type==='branch_result').length,2);assert.equal(packet.versions.length,68);retained(before,f.files);
  assert.ok((await b.store.review(namespace,'chat')).rows[0].branches.every(branch=>!branch.record.holders.length));assert.equal((await f.root()).schema,schema);
});

test('page packing respects byte as well as entry limits and preserves the exact expanded metadata',async t=>{
  // Contract-only metadata packing, not a claim that synthetic transition hashes
  // are verified event originals. Runtime event verification stays separate.
  const f=await fixture(t);await f.reserve('next');const current=await f.directory(),next=structuredClone(current.index),entry=next.entries[0],template=entry.versions[0],parents=entry.versions.map(meta=>meta.digest);next.revision++;
  for(let i=0;i<100;i++)entry.versions.push({...template,digest:(10000+i).toString(16).padStart(64,'0'),parents});
  const prepared=await prepareSceneDirectoryWrite(next,{current,namespace,scope:f.storage.scope,preserveImmutable:(name,value)=>f.storage.preserveImmutable(name,value)});
  let locator=prepared.root.entries[0].history,shortFullPage=false,count=0;
  while(locator){const page=(await f.storage.readImmutable(locator.reference)).value;assert.ok(sceneBytes(page)<=128*1024);assert.ok(page.versions.length<=64);if(page.previous&&page.versions.length<64)shortFullPage=true;count++;locator=page.previous;}
  assert.ok(count>3);assert.equal(shortFullPage,true);const checked=await readSceneDirectory(prepared.root,{namespace,scope:f.storage.scope,readImmutable:ref=>f.storage.readImmutable(ref)});
  assert.deepEqual(checked.index,next);assert.equal(checked.metadataBytes,prepared.metadataBytes);
});
