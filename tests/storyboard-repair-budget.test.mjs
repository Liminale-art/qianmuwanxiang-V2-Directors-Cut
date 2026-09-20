import test from 'node:test';
import assert from 'node:assert/strict';
import {repairStoryboardContract as repair,createStoryboardRepairBudget as budget,STORYBOARD_CONTRACT_REPAIR_MAX_BYTES,storyboardContractFailure as failure} from '../qianmu-storyboard-contract.js';
const broken='{ invalid';
const valid=JSON.stringify({schema:'qianmu.storyboard.plan.v1',should_generate:false,skip_reason:'no scene',shots:[],continuity_updates:[],decisions:[]});
test('format repair uses at most three calls, stops on success and preserves original errors',async()=>{
 let calls=0;const result=await repair({raw:broken,request:async()=>++calls===3?valid:broken});assert.equal(result.ok,true);assert.equal(result.repairCalls,3);assert.ok(result.originalErrors.length);
 calls=0;const failed=await repair({raw:broken,request:async()=>{calls++;return broken;}});assert.equal(calls,3);assert.equal(failed.repairExhausted,true);assert.match(failure(failed).message,/已修复3次/);
});
test('independent stages sharing one budget cannot multiply retries and concurrent reservations remain bounded',async()=>{
 const shared=budget();let calls=0;
 const first=await repair({raw:broken,budget:shared,request:async()=>++calls===2?valid:broken});assert.equal(first.repairCalls,2);
 const second=await repair({raw:broken,budget:shared,request:async()=>{calls++;return broken;}});assert.equal(second.repairCalls,1);assert.equal(calls,3);
 const b=budget(),request=async()=>{await Promise.resolve();return broken;};const results=await Promise.all([repair({raw:broken,budget:b,request}),repair({raw:broken,budget:b,request})]);assert.equal(results.reduce((n,r)=>n+r.repairCalls,0),3);
});
test('locally valid output, empty and oversized source never spend a repair call; transport or abort stops after one',async()=>{
 for(const raw of [valid,'','x'.repeat(STORYBOARD_CONTRACT_REPAIR_MAX_BYTES+1)]){const b=budget();const result=await repair({raw,budget:b,request:()=>assert.fail('no repair needed or allowed')});assert.equal(result.repairCalls,0);assert.equal(b.used,0);}
 let calls=0;const stopped=await repair({raw:broken,request:async()=>{calls++;throw new Error('private transport detail');}});assert.equal(calls,1);assert.doesNotMatch(failure(stopped).message,/private/);
 calls=0;const empty=await repair({raw:broken,request:async()=>{calls++;return '';}});assert.equal(calls,1);assert.equal(empty.repairSkipped,'unsafe_or_oversized');
});
test('invalid budgets cannot bypass the cap and a spent budget does not invoke the request',async()=>{
 for(const value of [-1,4,1.5,'3'])assert.throws(()=>budget(value));await assert.rejects(repair({raw:broken,budget:{remaining:99},request:()=>assert.fail()}));
 assert.equal((await repair({raw:broken,budget:budget(0),request:()=>assert.fail()})).repairCalls,0);
});
