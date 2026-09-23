import test from 'node:test';
import assert from 'node:assert/strict';
import {createGalleryShotReader} from '../qianmu-gallery-shot-reader.js';

const shot=()=>({id:'shot',characters:[{id:'char',name:'A'}],intent:{summary:'original'},future:{whole:'x'.repeat(26000),values:['',0,false,null]}});
const options=patch=>({readSnapshot:()=>assert.fail('unexpected archive read'),readLegacy:()=>assert.fail('unexpected plan fallback'),isCurrent:()=>true,...patch});
test('resident shot reads are complete detached values and never read an archive or current plan',async()=>{
  const record={id:'r',shotSpec:shot()},before=structuredClone(record),reader=createGalleryShotReader(record,options());
  const result=await reader.read();assert.deepEqual(result,record.shotSpec);assert.notEqual(result,record.shotSpec);result.future.values.push('edit');
  assert.deepEqual(record,before);assert.equal(reader.assertCurrent(),true);record.shotSpec.intent.summary='new';assert.throws(()=>reader.assertCurrent());
});
test('inline, server and strong local recipes use only the caller scoped reader and preserve unknown shot content',async()=>{
  for(const field of ['snapshot','snapshotServerRef','snapshotRef']){
    const record={id:'r',[field]:field==='snapshotRef'?'reference':{version:1}},expected=shot();let reads=0;
    const reader=createGalleryShotReader(record,options({readSnapshot:async value=>{assert.equal(value,record);reads++;return {shotSpec:expected};}}));
    const result=await reader.read();assert.deepEqual(result,expected);assert.notEqual(result,expected);assert.equal(reads,1);assert.equal(Object.hasOwn(record,'shotSpec'),false);
  }
});
test('missing or failed known originals never borrow a current plan',async()=>{
  const record={id:'r',snapshotServerRef:{version:1}};
  for(const result of [null,{}, {shotSpec:null}])assert.equal(await createGalleryShotReader(record,options({readSnapshot:async()=>result})).read(),null);
  await assert.rejects(createGalleryShotReader(record,options({readSnapshot:async()=>{throw Error('original unavailable');}})).read(),/original unavailable/);
});
test('legacy plan fallback is used only for a record with no original recipe and no explicit unavailable state',async()=>{
  const record={id:'r',planId:'plan'},expected=shot();let reads=0;
  const reader=createGalleryShotReader(record,options({readLegacy:()=>{reads++;return expected;}}));assert.deepEqual(await reader.read(),expected);assert.equal(reads,1);
  assert.equal(await createGalleryShotReader({id:'r',recipeUnavailable:true},options()).read(),null);
  assert.equal(await createGalleryShotReader(null,options({readLegacy:()=>null})).read(),null);
});
test('record edits and stale ownership while awaiting an original invalidate the whole result',async()=>{
  for(const mode of ['field','reference','owner']){let valid=true;const record={id:'r',snapshotRef:'ref'};
    const reader=createGalleryShotReader(record,options({isCurrent:()=>valid,readSnapshot:async()=>{
      if(mode==='field')record.future='new';if(mode==='reference')record.snapshotRef='new';if(mode==='owner')valid=false;return {shotSpec:shot()};}}));
    await assert.rejects(reader.read(),/已变化/);
  }
});
test('an initially stale guard starts no source read',async()=>{
  const reader=createGalleryShotReader({id:'r',snapshotRef:'ref'},options({isCurrent:()=>false}));await assert.rejects(reader.read(),/已变化/);
});
test('accessors, non-JSON input and over-limit content cannot be silently trimmed into a usable shot',async()=>{
  let calls=0;const record={id:'r'};Object.defineProperty(record,'shotSpec',{enumerable:true,get(){calls++;return shot();}});
  assert.throws(()=>createGalleryShotReader(record,options()));assert.equal(calls,0);
  assert.throws(()=>createGalleryShotReader({id:'r',shotSpec:{large:'x'.repeat(2*1024*1024+1)}},options()));
  for(const bad of [[],true,'future-format'])await assert.rejects(createGalleryShotReader({id:'r',snapshotRef:'ref'},options({readSnapshot:async()=>({shotSpec:bad})})).read());
});
