import test from 'node:test';
import assert from 'node:assert/strict';
import {assertStoryboardStructureBytes as check} from '../qianmu-storyboard-limits.js';

test('structure budget measures complete UTF-8 serialization without trimming or mutating',()=>{
  const value={text:'画面🙂',shots:Array.from({length:169},(_,i)=>({id:`S${i+1}`}))},before=JSON.stringify(value);
  const size=new TextEncoder().encode(before).byteLength;
  assert.equal(check(value,size),value);assert.throws(()=>check(value,size-1),{code:'storyboard_structure_capacity',submissionState:'not_submitted'});
  assert.equal(JSON.stringify(value),before);
});

test('nonserializable structures and invalid budgets fail before callers can clone or submit',()=>{
  const cycle={};cycle.self=cycle;
  for(const value of [cycle,undefined,1n])assert.throws(()=>check(value),{code:'storyboard_structure_capacity'});
  for(const limit of [0,-1,NaN,Infinity,1.5,Number.MAX_SAFE_INTEGER+1])assert.throws(()=>check([],limit),{code:'storyboard_structure_capacity'});
});

test('existing response capacity accepts its exact boundary and rejects one byte more',()=>{
  const value='a'.repeat(256*1024-2);assert.equal(check(value),value);
  assert.throws(()=>check(value+'a'),{code:'storyboard_structure_capacity'});
});
