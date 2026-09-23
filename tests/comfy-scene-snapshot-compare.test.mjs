import test from 'node:test';
import assert from 'node:assert/strict';
import {validateComfySceneSnapshot,sameComfySceneSnapshot,COMFY_SCENE_SNAPSHOT_SCHEMA} from '../qianmu-comfy-scene-backup.js';
import {comfySceneIdbFixture} from './helpers/comfy-scene-idb-fixture.mjs';
import {completedComfySceneSource} from './helpers/comfy-scene-source-fixture.mjs';

const namespace='st-user:scene-compare';
function fixture(t,count=2){const source=completedComfySceneSource(namespace,count),idb=comfySceneIdbFixture(source),store=idb.open();t.after(()=>store.close());return {source,idb,store};}
const first=f=>f.idb.state.tables.scopes.get(f.source.rows[0].key);

// The previous algorithm remains only as a comparison oracle in this test.
// Counters include the shared IDB double's cloning, equally in both modes;
// elapsed time is diagnostic, not a real browser/VPS performance threshold.
async function measuredCheck(store,expected,legacy){
  const stringify=JSON.stringify,clone=globalThis.structuredClone,counts={snapshotSerializations:0,recordSerializations:0,rowClones:0};
  JSON.stringify=function(value,...args){if(value?.schema===COMFY_SCENE_SNAPSHOT_SCHEMA)counts.snapshotSerializations++;if(value?.schema==='qianmu.comfy.scene-lock.v1')counts.recordSerializations++;return stringify.call(JSON,value,...args);};
  globalThis.structuredClone=function(value,...args){if(value?.record?.schema==='qianmu.comfy.scene-lock.v1')counts.rowClones++;return clone(value,...args);};
  const start=performance.now();try{
    if(legacy){const captured=structuredClone(expected);validateComfySceneSnapshot(captured);assert.equal(sameComfySceneSnapshot(await store.snapshot(namespace),captured),true);}
    else assert.equal(await store.assertSnapshot(expected),true);
  }finally{JSON.stringify=stringify;globalThis.structuredClone=clone;}
  return {...counts,elapsedMs:Math.round((performance.now()-start)*100)/100};
}

for(const count of [1,32,128,1024])test(`complete ${count}-scene comparison keeps atomic reads while removing the second snapshot workload`,async t=>{
  const f=fixture(t,count),expected=await f.store.snapshot(namespace),before=structuredClone(f.idb.state.tables),measurements=[];
  for(const legacy of [true,false]){
    f.idb.state.transactions.length=0;f.idb.state.reads.length=0;
    const measurement=await measuredCheck(f.store,expected,legacy);
    assert.deepEqual(f.idb.state.transactions,[{names:['scopes','usage'],mode:'readonly'}]);
    assert.equal(f.idb.state.reads.filter(row=>row.kind==='cursor').length,count+1);assert.equal(f.idb.state.reads.filter(row=>row.kind==='keys').length,1);
    measurements.push(measurement);
  }
  assert.equal(measurements[0].snapshotSerializations,6);assert.equal(measurements[1].snapshotSerializations,2);
  assert.equal(measurements[0].rowClones-measurements[1].rowClones,count);assert.ok(measurements[1].recordSerializations<measurements[0].recordSerializations);
  assert.deepEqual(f.idb.state.tables,before);assert.equal(f.idb.state.writes.length,0);
  t.diagnostic(JSON.stringify({count,before:measurements[0],after:measurements[1],scope:'isolated complete IDB comparison, not browser or VPS timing'}));
});

const mutations=[
  ['changed label',f=>{first(f).record.label.workflowName='changed';}],
  ['unknown undefined field',f=>{first(f).record.extra=undefined;}],
  ['negative zero',f=>{f.idb.state.tables.usage.get(namespace).generation=-0;}],
  ['non-finite value',f=>{first(f).record.updatedAt=NaN;}],
  ['non-JSON object',f=>{first(f).record.label=new Map();}],
  ['sparse array',f=>{first(f).record.holders=Array(1);}],
  ['extra array property',f=>{first(f).record.holders.extra='retained';}],
  ['missing row',f=>{f.idb.state.tables.scopes.delete(f.source.rows[0].key);}],
  ['missing usage',f=>{f.idb.state.tables.usage.delete(namespace);}],
  ['generation change',f=>{f.idb.state.tables.usage.get(namespace).generation++;}],
  ['row leaves chat index',f=>{first(f).namespace='st-user:other';}],
];
for(const [name,change]of mutations)test(`full comparison rejects ${name} without normalizing or overwriting it`,async t=>{
  const f=fixture(t),expected=await f.store.snapshot(namespace);change(f);const before=structuredClone(f.idb.state.tables);
  await assert.rejects(f.store.assertSnapshot(expected));assert.deepEqual(f.idb.state.tables,before);assert.equal(f.idb.state.writes.length,0);
});

for(const kind of ['absent','empty','cleared'])test(`complete comparison distinguishes ${kind} metadata without inventing records`,async t=>{
  const f=fixture(t,0);if(kind==='absent')f.idb.state.tables.usage.delete(namespace);if(kind==='cleared')f.idb.state.tables.usage.get(namespace).generation=9;
  const expected=await f.store.snapshot(namespace);assert.equal(await f.store.assertSnapshot(expected),true);assert.equal(f.idb.state.writes.length,0);
});

test('property order does not affect a complete comparison',async t=>{
  const f=fixture(t),expected=await f.store.snapshot(namespace),row=first(f);
  row.record=Object.fromEntries(Object.entries(row.record).reverse());row.record.label=Object.fromEntries(Object.entries(row.record.label).reverse());
  assert.equal(await f.store.assertSnapshot(expected),true);
});

test('the expected snapshot is captured before the first asynchronous boundary',async t=>{
  const f=fixture(t),expected=await f.store.snapshot(namespace),checking=f.store.assertSnapshot(expected);
  expected.rows[0].value.record.label.workflowName='caller changed after invocation';expected.rows.pop();assert.equal(await checking,true);assert.equal(f.idb.state.writes.length,0);
});

test('the primary-key scan catches a hidden account record even with an empty chat index',async t=>{
  const f=fixture(t,0),expected=await f.store.snapshot(namespace),other=completedComfySceneSource(namespace,1).rows[0];
  other.value.namespace='st-user:foreign';f.idb.state.tables.scopes.set(other.key,other.value);await assert.rejects(f.store.assertSnapshot(expected),/保全期间变化/);assert.equal(f.idb.state.writes.length,0);
});

test('a valid change before the comparison transaction is detected, not served from a prior success',async t=>{
  const f=fixture(t),expected=await f.store.snapshot(namespace);assert.equal(await f.store.assertSnapshot(expected),true);
  f.idb.state.beforeTransaction=()=>{f.idb.state.tables.usage.get(namespace).generation++;f.idb.state.beforeTransaction=null;};
  await assert.rejects(f.store.assertSnapshot(expected),/保全期间变化/);assert.equal(f.idb.state.writes.length,0);
});

test('another account does not enter the comparison or get altered',async t=>{
  const f=fixture(t),expected=await f.store.snapshot(namespace),foreign=completedComfySceneSource('st-user:foreign',1);
  f.idb.state.tables.scopes.set(foreign.rows[0].key,foreign.rows[0].value);f.idb.state.tables.usage.set(foreign.namespace,foreign.usage);
  const before=structuredClone(f.idb.state.tables);assert.equal(await f.store.assertSnapshot(expected),true);assert.deepEqual(f.idb.state.tables,before);
});

test('raw pending receipt tokens and expired reservations are compared, not a display summary',async t=>{
  const f=fixture(t,0),sample=completedComfySceneSource(namespace,1).rows[0].value.record;
  await f.store.reserve(sample.scope,{lock:sample.lock,expectedRevision:0,attemptId:'pending',ownerId:'page',token:'original-token'});
  const expected=await f.store.snapshot(namespace),key=expected.rows[0].key,later=f.idb.open({now:()=>10000000});t.after(()=>later.close());
  assert.ok(expected.rows[0].value.record.holders[0].expiresAt<10000000);assert.equal(await later.assertSnapshot(expected),true);
  f.idb.state.tables.scopes.get(key).record.holders[0].token='changed-token';
  await assert.rejects(later.assertSnapshot(expected),/保全期间变化/);assert.equal(f.idb.state.tables.scopes.get(key).record.holders[0].token,'changed-token');
});

test('receipt array order is retained even when all individual receipt fields still match',async t=>{
  const f=fixture(t,0),sample=completedComfySceneSource(namespace,1).rows[0].value.record;
  for(let n=0;n<2;n++)await f.store.reserve(sample.scope,{lock:sample.lock,expectedRevision:n,attemptId:'pending-'+n,ownerId:'page',token:'token-'+n});
  const expected=await f.store.snapshot(namespace);f.idb.state.tables.scopes.get(expected.rows[0].key).record.holders.reverse();
  await assert.rejects(f.store.assertSnapshot(expected),/保全期间变化/);
});

test('full expected snapshot validation still enforces the current store quota',async t=>{
  const f=fixture(t),expected=await f.store.snapshot(namespace),small=f.idb.open({limits:{scopes:1}});t.after(()=>small.close());
  await assert.rejects(small.assertSnapshot(expected),/容量/);assert.equal(f.idb.state.writes.length,0);
});

test('revocation during the scan never returns a successful comparison',async t=>{
  const f=fixture(t,8),expected=await f.store.snapshot(namespace);let calls=0;
  await assert.rejects(f.store.assertSnapshot(expected,{isCurrent:()=>++calls<6}));assert.equal(f.idb.state.writes.length,0);
});

test('a closed store cannot confirm even an otherwise exact snapshot',async t=>{
  const f=fixture(t),expected=await f.store.snapshot(namespace);f.store.close();await assert.rejects(f.store.assertSnapshot(expected));
});

test('invalid expected snapshot fields cannot authorize a matching damaged source',async t=>{
  const f=fixture(t),expected=await f.store.snapshot(namespace);expected.rows[0].value.record.extra=undefined;first(f).record.extra=undefined;
  await assert.rejects(f.store.assertSnapshot(expected));assert.equal(f.idb.state.writes.length,0);
});
