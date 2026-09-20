import test from 'node:test';
import assert from 'node:assert/strict';
import {createStoryboardStreamScheduler,runStoryboardStreamPass} from '../qianmu-storyboard-stream-scheduler.js';
const deferred=()=>{let resolve;return{promise:new Promise(yes=>{resolve=yes;}),resolve:value=>resolve(value)};};
async function tick(){for(let i=0;i<40;i++)await Promise.resolve();}
function fixture(extra={}){
  let text='Alice cooks.\n\nPartial',current=true,busy=false,clock=0,seq=0,reads=0,runs=0,finishes=0;
  let run=async()=>({status:'advanced',queued:1}),finish=async()=>true;
  const timers=new Map(),signals=[],scheduler=createStoryboardStreamScheduler({isCurrent:()=>current,busy:()=>busy,now:()=>clock,
    read:()=>{reads++;return text;},run:async options=>{runs++;signals.push(options.signal);return run(options);},finish:async options=>{finishes++;return finish(options);},
    setTimer:(fn,ms)=>{const id=++seq;timers.set(id,{fn,ms});return id;},clearTimer:id=>timers.delete(id),...extra});
  return{scheduler,timers,signals,get reads(){return reads;},get runs(){return runs;},get finishes(){return finishes;},get text(){return text;},
    set text(value){text=value;},set current(value){current=value;},set busy(value){busy=value;},set run(value){run=value;},set finish(value){finish=value;},
    async fire(){assert.equal(timers.size,1);const [id,{fn,ms}]=timers.entries().next().value;timers.delete(id);clock+=ms;fn();await tick();},
  };
}

test('thousands of token pulses coalesce into one event-turn read and one pass; raw token arguments are never inspected',async()=>{
  const f=fixture(),raw={toString(){throw Error('raw token read');}};for(let i=0;i<5000;i++)f.scheduler.pulse(raw);
  assert.equal(f.reads,0);assert.equal(f.timers.size,1);assert.equal(f.runs,0);await f.fire();assert.equal(f.reads,1);assert.equal(f.runs,1);assert.equal(f.timers.size,0);f.scheduler.close();
});

test('unchanged or unfinished paragraphs never buy another extraction attempt',async()=>{
  const f=fixture();f.text='unfinished';f.scheduler.pulse();await f.fire();assert.equal(f.runs,0);
  f.text='First paragraph.\n\nunfinished';f.scheduler.pulse();await f.fire();assert.equal(f.runs,1);
  for(let i=0;i<5;i++){f.text+=' appended';f.scheduler.pulse();await f.fire();}assert.equal(f.runs,1);assert.equal(f.scheduler.status.passes,1);f.scheduler.close();
});

test('a busy external compiler has no polling timer and is resumed only by an explicit idle wakeup',async()=>{
  const f=fixture();f.busy=true;f.scheduler.pulse();assert.equal(f.timers.size,0);assert.equal(f.reads,0);
  f.busy=false;f.scheduler.wake();await f.fire();assert.equal(f.runs,1);assert.equal(f.timers.size,0);f.scheduler.close();
});

test('a busy result at handoff does not consume a pass and does not create a retry loop',async()=>{
  const f=fixture();f.run=async()=>({status:'busy',queued:0});f.scheduler.pulse();await f.fire();assert.equal(f.scheduler.status.passes,0);assert.equal(f.timers.size,0);
  f.run=async()=>({status:'advanced',queued:1});f.scheduler.wake();await f.fire();assert.equal(f.scheduler.status.passes,1);assert.equal(f.runs,2);f.scheduler.close();
});

test('pulses during a slow pass produce only one later pass and preserve the cooldown',async()=>{
  const f=fixture(),gate=deferred();f.run=()=>gate.promise;f.scheduler.pulse();await f.fire();
  f.text+='\n\nSecond';for(let i=0;i<100;i++)f.scheduler.pulse();assert.equal(f.timers.size,0);assert.equal(f.runs,1);
  f.run=async()=>({status:'advanced',queued:1});gate.resolve({status:'advanced',queued:1});await tick();assert.equal(f.timers.size,1);
  assert.ok([...f.timers.values()][0].ms>=2500);await f.fire();assert.equal(f.runs,2);assert.equal(f.scheduler.status.queued,2);f.scheduler.close();
});

test('partial pass limit bounds model calls while leaving one explicit final handoff',async()=>{
  const f=fixture({maxPasses:3});for(let i=0;i<3;i++){f.text+=` ${i}\n\n`;f.scheduler.pulse();await f.fire();}
  f.text+='more\n\n';f.scheduler.pulse();f.scheduler.wake();assert.equal(f.timers.size,0);assert.equal(f.runs,3);
  assert.equal(await f.scheduler.finalize(),true);assert.equal(await f.scheduler.finalize(),true);assert.equal(f.finishes,1);assert.equal(f.scheduler.status.passes,3);f.scheduler.close();
});

test('invalid internal pass limits cannot turn a bounded session into unlimited calls',async()=>{
  for(const maxPasses of [NaN,Infinity,'999',-1,999]){
    const f=fixture({maxPasses,intervalMs:NaN}),expected=Number.isSafeInteger(maxPasses)?Math.max(1,Math.min(4,maxPasses)):3;
    for(let i=0;i<expected;i++){f.text+='closed\n\n';f.scheduler.pulse();await f.fire();}
    f.text+='again\n\n';f.scheduler.pulse();assert.equal(f.timers.size,0);assert.equal(f.runs,expected);f.scheduler.close();
  }
});

test('finalization waits for the in-flight pass and reads its occupied-slot outcome before finishing exactly once',async()=>{
  const f=fixture(),gate=deferred();f.run=()=>gate.promise;f.scheduler.pulse();await f.fire();f.scheduler.pulse();
  const a=f.scheduler.finalize(),b=f.scheduler.finalize();assert.equal(a,b);assert.equal(f.finishes,0);assert.equal(f.timers.size,0);
  f.finish=async()=>{assert.equal(f.scheduler.status.queued,2);return true;};gate.resolve({status:'advanced',queued:2});assert.equal(await a,true);assert.equal(f.finishes,1);assert.equal(f.runs,1);f.scheduler.close();
});

for(const status of ['failed','cancelled','invalid'])test(`${status} stops partial and final automatic work without resetting its repair budget`,async()=>{
  const f=fixture();f.run=async()=>({status,queued:1});f.scheduler.pulse();await f.fire();f.text+='next\n\n';f.scheduler.pulse();f.scheduler.wake();
  assert.equal(f.timers.size,0);assert.equal(f.runs,1);assert.equal(await f.scheduler.finalize(),false);assert.equal(f.finishes,0);assert.equal(f.scheduler.status.queued,1);f.scheduler.close();
});

test('a failure arriving during final wait cannot be reinterpreted as an empty floor ready for a fresh batch',async()=>{
  const f=fixture(),gate=deferred();f.run=()=>gate.promise;f.scheduler.pulse();await f.fire();const final=f.scheduler.finalize();gate.resolve({status:'failed',queued:1});
  assert.equal(await final,false);assert.equal(f.finishes,0);assert.equal(f.scheduler.status.failed,true);f.scheduler.close();
});

test('a harmless narrative wait may advance on a later closed paragraph and may finalize with no partial images',async()=>{
  const f=fixture();f.run=async()=>({status:'waiting',queued:0});f.scheduler.pulse();await f.fire();assert.equal(f.scheduler.status.failed,false);
  f.text+='\n\nLater';f.scheduler.pulse();await f.fire();assert.equal(f.runs,2);assert.equal(await f.scheduler.finalize(),true);assert.equal(f.finishes,1);f.scheduler.close();
});

test('rewritten confirmed prose stops later passes and the final fallback',async()=>{
  const f=fixture();f.scheduler.pulse();await f.fire();f.text='changed prefix\n\n';f.scheduler.pulse();await f.fire();
  assert.equal(f.runs,1);assert.equal(f.scheduler.status.failed,true);assert.equal(await f.scheduler.finalize(),false);f.scheduler.close();
});

test('close cancels scheduled and in-flight preparation without reviving from late outcomes or wakeups',async()=>{
  const f=fixture(),gate=deferred();f.run=()=>gate.promise;f.scheduler.pulse();await f.fire();const final=f.scheduler.finalize();f.scheduler.close();
  assert.equal(f.signals[0].aborted,true);gate.resolve({status:'advanced',queued:1});assert.equal(await final,false);f.scheduler.wake();f.scheduler.pulse();assert.equal(f.timers.size,0);assert.equal(f.finishes,0);
  const pending=fixture();pending.scheduler.pulse();pending.scheduler.close();assert.equal(pending.timers.size,0);
});

test('loss of caller identity prevents reading or compiling a different active chat',async()=>{
  const f=fixture();f.scheduler.pulse();f.current=false;await f.fire();assert.equal(f.reads,0);assert.equal(f.runs,0);assert.equal(await f.scheduler.finalize(),false);f.scheduler.close();
});

test('pass adapter preserves accepted partial counts after handoff failure and never retries the compiler',async()=>{
  let calls=0;const result=await runStoryboardStreamPass({compile:async(_,{onPrepared,onStreamOutcome})=>{calls++;try{await onPrepared({});}catch(_){onStreamOutcome({status:'failed'});return false;}},
    submit:async()=>{throw Object.assign(Error('partial'),{streamOutcome:{queued:2,failed:1}});}},{floor:0});
  assert.deepEqual(result,{status:'failed',queued:2});assert.equal(calls,1);
});

test('pass adapter distinguishes busy, wait, valid submissions and missing outcomes without inventing a successful handoff',async()=>{
  for(const [reported,outcome,expected]of [['busy',null,'busy'],['waiting',{queued:0},'waiting'],['ready',{queued:2},'advanced'],['ready',{queued:0},'waiting'],[null,null,'failed']]){
    const result=await runStoryboardStreamPass({compile:async(_,{onPrepared,onStreamOutcome})=>{if(outcome)await onPrepared({});if(reported)onStreamOutcome({status:reported});},submit:async()=>outcome},{floor:0});
    assert.equal(result.status,expected);
  }
});
