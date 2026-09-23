import test from 'node:test';
import assert from 'node:assert/strict';
import {changeComfySceneRecord,captureComfySceneAction} from '../qianmu-comfy-scene-lock.js';
import {createNativeComfySceneStore} from '../qianmu-comfy-scene-native-store.js';
import {COMFY_SCENE_EVENT_SCHEMA} from '../qianmu-comfy-scene-native-contract.js';
import {characterNativeFixture,namespace} from './helpers/character-native-fixture.mjs';
import {comfySceneIdbFixture,comfySceneJournalFixture} from './helpers/comfy-scene-idb-fixture.mjs';
import {completedComfySceneSource} from './helpers/comfy-scene-source-fixture.mjs';

function reservation(n,{chatKey='chat',continuityId='scene-'+n}={}){
  const sample=completedComfySceneSource(namespace,1).rows[0].value.record,scope={...sample.scope,chatKey,continuityId},lock={...sample.lock,scope};
  const action=captureComfySceneAction({type:'reserve',lock,expectedRevision:0,attemptId:'task-'+n,ownerId:'page',token:'synthetic-'+n},scope),result=changeComfySceneRecord(null,scope,action,100);
  return {receipt:result.receipt,proposal:{id:'proposal-'+n,namespace,kind:'reserve',generation:0,cleared:false,receipt:result.receipt,outcomeId:'',
    events:[{schema:COMFY_SCENE_EVENT_SCHEMA,namespace,scope,record:result.row,before:null,action,source:null,at:100,generation:0,parents:[]}]}};
}
const claimQuery=(filter={})=>({kind:'claims',scope:null,chatKey:null,pendingOnly:false,...filter});
async function fixture(t){
  const idb=comfySceneJournalFixture(),journal=idb.open(),value=await journal.read(namespace),items=[reservation(0),reservation(1),reservation(2,{chatKey:'other-chat'})];t.after(()=>journal.close());
  value.claims=items.map((item,n)=>({receipt:item.receipt,outcomes:n===1?[]:[{id:'outcome-'+n,outcome:'succeeded'}]}));idb.state.tables.accounts.set(namespace,value);
  return {idb,journal,items};
}

test('control and summary projections do not carry unrelated original receipt tokens',async t=>{
  const f=await fixture(t);assert.deepEqual(await f.journal.select(namespace,{kind:'control'}),{nativeKnown:false,pending:null});
  const summary=await f.journal.select(namespace,{kind:'summary'});assert.deepEqual(summary,{pending:null,outcomes:2,conflicts:0});assert.ok(!JSON.stringify(summary).includes('synthetic-'));
});

test('claim selection binds exact account, chat, scene and narrative layer with all original outcomes',async t=>{
  const f=await fixture(t),full=await f.journal.read(namespace),scope=f.items[0].receipt.scope;
  assert.deepEqual(await f.journal.select(namespace,claimQuery({scope})),[full.claims[0]]);
  assert.deepEqual(await f.journal.select(namespace,claimQuery({chatKey:'chat'})),full.claims.slice(0,2));
  assert.deepEqual(await f.journal.select(namespace,claimQuery({chatKey:'chat',pendingOnly:true})),[full.claims[0]]);
  assert.deepEqual(await f.journal.select(namespace,claimQuery({pendingOnly:true})),[full.claims[0],full.claims[2]]);
  assert.deepEqual(await f.journal.select(namespace,claimQuery({scope:{...scope,narrativeLayer:'memory'}})),[]);
});

test('control retains the complete pending operation while summary returns only its identity',async t=>{
  const f=await fixture(t),pending=reservation(3).proposal;await f.journal.stage(namespace,pending);
  assert.deepEqual((await f.journal.select(namespace,{kind:'control'})).pending,{id:pending.id,proposal:pending});
  assert.deepEqual((await f.journal.select(namespace,{kind:'summary'})).pending,{id:pending.id,kind:'reserve'});
  assert.deepEqual((await f.journal.read(namespace)).pending.proposal,pending);
});

test('authority projection checks an exact local claim and its retained reserve conflict',async t=>{
  const f=await fixture(t),receipt=f.items[0].receipt;
  assert.deepEqual(await f.journal.select(namespace,{kind:'authority',receipt}),{owned:true,executable:true});
  await f.journal.stage(namespace,f.items[0].proposal);await f.journal.retainConflict(namespace,f.items[0].proposal.id);
  assert.deepEqual(await f.journal.select(namespace,{kind:'authority',receipt}),{owned:true,executable:false});
  assert.deepEqual(await f.journal.select(namespace,{kind:'authority',receipt:f.items[1].receipt}),{owned:true,executable:true});
  for(const patch of [{token:'other'},{attemptId:'other'},{ownerId:'other'}])assert.deepEqual(await f.journal.select(namespace,{kind:'authority',receipt:{...receipt,...patch}}),{owned:false,executable:false});
});

test('selecting a small result still rejects corruption in an unrelated claim',async t=>{
  const f=await fixture(t);f.idb.state.tables.accounts.get(namespace).claims[2].receipt.extra='must not disappear';
  for(const query of [{kind:'control'},{kind:'summary'},claimQuery({scope:f.items[0].receipt.scope}),{kind:'authority',receipt:f.items[0].receipt}])await assert.rejects(f.journal.select(namespace,query));
  assert.equal(f.idb.state.writes.length,0);
});

const invalidQueries=[
  ['unknown kind',()=>({kind:'latest'})],
  ['extra selector field',()=>({kind:'control',scope:null})],
  ['foreign account scope',f=>claimQuery({scope:{...f.items[0].receipt.scope,namespace:'st-user:foreign'}})],
  ['foreign account receipt',f=>({kind:'authority',receipt:{...f.items[0].receipt,scope:{...f.items[0].receipt.scope,namespace:'st-user:foreign'}}})],
  ['ambiguous chat and scene',f=>claimQuery({scope:f.items[0].receipt.scope,chatKey:'chat'})],
  ['undefined chat does not broaden to all chats',()=>claimQuery({chatKey:undefined})],
  ['invalid pending switch',()=>claimQuery({pendingOnly:'yes'})],
];
for(const [name,query]of invalidQueries)test(`invalid journal selection: ${name}`,async t=>{
  const f=await fixture(t),before=f.idb.state.transactions.length;await assert.rejects(async()=>f.journal.select(namespace,query(f)));assert.equal(f.idb.state.transactions.length,before);
});

test('selector and returned objects are isolated from later caller mutation',async t=>{
  const f=await fixture(t),scope=structuredClone(f.items[0].receipt.scope),query=claimQuery({scope}),reading=f.journal.select(namespace,query);
  query.scope=null;scope.continuityId='other';query.pendingOnly=true;const result=await reading;assert.equal(result.length,1);assert.deepEqual(result[0].receipt,f.items[0].receipt);
  result[0].receipt.token='changed result';result[0].outcomes.length=0;assert.equal((await f.journal.read(namespace)).claims[0].receipt.token,f.items[0].receipt.token);
});

test('authority selection captures the exact receipt before asynchronous reads',async t=>{
  const f=await fixture(t),receipt=structuredClone(f.items[0].receipt),reading=f.journal.select(namespace,{kind:'authority',receipt});receipt.token='changed after invocation';
  assert.deepEqual(await reading,{owned:true,executable:true});
});

test('another page late outcome is returned on the next projection instead of a cached empty result',async t=>{
  const f=await fixture(t),other=f.idb.open();t.after(()=>other.close());const scope=f.items[1].receipt.scope;
  assert.deepEqual(await f.journal.select(namespace,claimQuery({scope,pendingOnly:true})),[]);await other.remember(f.items[1].receipt,'accepted');
  const result=await f.journal.select(namespace,claimQuery({scope,pendingOnly:true}));assert.equal(result.length,1);assert.equal(result[0].outcomes[0].outcome,'accepted');
});

test('projection reads leave full claims, conflict originals and native metadata exportable',async t=>{
  const f=await fixture(t);await f.journal.stage(namespace,f.items[0].proposal);await f.journal.retainConflict(namespace,f.items[0].proposal.id);await f.journal.observeNative(namespace);
  const before=await f.journal.read(namespace),writes=f.idb.state.writes.length;
  for(const query of [{kind:'control'},{kind:'summary'},claimQuery({scope:f.items[1].receipt.scope}),{kind:'authority',receipt:f.items[1].receipt}])await f.journal.select(namespace,query);
  assert.deepEqual(await f.journal.read(namespace),before);assert.equal(f.idb.state.writes.length,writes);assert.deepEqual(before.conflicts[0].proposal,f.items[0].proposal);
});

test('close and corrupt pending proposals cannot produce successful small projections',async t=>{
  const f=await fixture(t),value=f.idb.state.tables.accounts.get(namespace);value.pending={id:'broken',proposal:{}};
  await assert.rejects(f.journal.select(namespace,{kind:'summary'}));f.journal.close();await assert.rejects(f.journal.select(namespace,{kind:'control'}));
});

async function nativeFixture(t,count,projected){
  const f=await characterNativeFixture(t),source=completedComfySceneSource(namespace,1),old=comfySceneIdbFixture(source),idb=comfySceneJournalFixture(),base=idb.open(),measurements=[];
  const record=(kind,result)=>{measurements.push({kind,bytes:new TextEncoder().encode(JSON.stringify(result)).length});return result;};
  const journal={...base,read:async ns=>record('full',await base.read(ns)),select:projected?async(ns,q)=>record(q.kind,await base.select(ns,q)):undefined};
  const store=createNativeComfySceneStore({legacy:old.open(),journal,createStorage:f.createStorage,now:()=>100});t.after(()=>store.close());await store.review(namespace,'chat');
  const value=await base.read(namespace);for(let n=0;n<count;n++)value.claims.push({receipt:reservation(n,{chatKey:'other-chat',continuityId:'retained-'+n}).receipt,outcomes:[]});idb.state.tables.accounts.set(namespace,value);
  return Object.assign(f,{store,base,idb,source,measurements,clear(){f.reset();measurements.length=0;idb.state.transactions.length=0;idb.state.writes.length=0;}});
}

for(const count of [0,32,128,1024])test(`native coordinator projects ${count} unrelated retained tickets without whole-journal handoff`,async t=>{
  const modes=[];for(const projected of [false,true]){
    const f=await nativeFixture(t,count,projected),scope=f.source.rows[0].value.record.scope,results={},cost=[];
    for(const action of ['inspect','review','list','storageSummary','pendingOwners']){
      f.clear();const start=performance.now();results[action]=await (['inspect','pendingOwners'].includes(action)?f.store[action](scope):['review','list'].includes(action)?f.store[action](namespace,'chat'):f.store[action](namespace));
      cost.push({action,reads:f.measurements.length,returnedBytes:f.measurements.reduce((n,row)=>n+row.bytes,0),elapsedMs:Math.round((performance.now()-start)*100)/100});
      assert.equal(f.measurements.length,{inspect:3,review:2,list:2,storageSummary:1,pendingOwners:4}[action]);assert.equal(f.idb.state.transactions.length,f.measurements.length);
      assert.equal(f.uploads,0);assert.equal(f.idb.state.writes.length,0);if(projected)assert.ok(f.measurements.every(row=>row.kind!=='full'));
    }
    assert.equal((await f.store.exportJournal(namespace)).claims.length,count);modes.push({projected,results,cost});
  }
  assert.deepEqual(modes[0].results,modes[1].results);assert.ok(modes[1].cost.every(row=>row.returnedBytes<256));
  for(let n=0;n<modes[0].cost.length;n++)assert.ok(modes[1].cost[n].returnedBytes<modes[0].cost[n].returnedBytes);
  t.diagnostic(JSON.stringify({count,modes:modes.map(({projected,cost})=>({projected,cost})),scope:'actual coordinator over synthetic ST/IDB; full stored account validation and read counts remain'}));
});

for(const projected of [false,true])test(`ordinary reserve/begin/settle remains exact with ${projected?'projected':'legacy adapter'} journal reads`,async t=>{
  const f=await nativeFixture(t,32,projected),item=reservation(300),scope=item.receipt.scope,action=item.proposal.events[0].action;
  const reserved=await f.store.reserve(scope,{...action,expectedGeneration:0});await f.store.begin(reserved.receipt);await f.store.settle(reserved.receipt,'succeeded');
  assert.equal((await f.store.inspect(scope)).established,true);const full=await f.store.exportJournal(namespace);assert.equal(full.claims.length,32);assert.equal(full.pending,null);assert.ok(full.claims.every(row=>row.receipt.scope.chatKey==='other-chat'));
});

for(const action of ['list','chatUsage','clearChat'])test(`an unspecified chat never broadens ${action} into delivery for other chats`,async t=>{
  const f=await nativeFixture(t,1,true),receipt=(await f.base.read(namespace)).claims[0].receipt;await f.base.remember(receipt,'succeeded');f.clear();
  await assert.rejects(f.store[action](namespace,undefined));assert.equal(f.uploads,0);assert.equal(f.calls.length,0);assert.equal((await f.base.read(namespace)).claims[0].outcomes[0].outcome,'succeeded');
});
