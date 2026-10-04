import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createOriginalTaskRecovery, originalRecoveryLogs } from '../qianmu-storyboard-original-recovery.js';
import { storyboardFunctionSource } from './helpers/storyboard-form-fixture.mjs';
const log=(id='a',extra={})=>({id,status:'failed',submissionState:'accepted',snapshot:{source:'comfy',chatKey:'chat',imageAdmission:{version:1,namespace:'st-user:alice',attemptId:id}},...extra});
const flush=()=>new Promise(resolve=>setImmediate(resolve));
function fixture(receive=async()=>{}){
  let current={owner:{},epoch:1,chat:'chat'};const logs=[log()],active=new Set(),timers=new Map();let serial=0;
  const manager=createOriginalTaskRecovery({scope:()=>current,logs:()=>logs,active:()=>active,receive,
    schedule:(fn,delay)=>{timers.set(++serial,{fn,delay});return serial;},cancel:id=>timers.delete(id)});
  const tick=async()=>{const [id,timer]=timers.entries().next().value;timers.delete(id);timer.fn();await flush();};
  return {manager,logs,active,timers,tick,change:patch=>current={...current,...patch}};
}
test('only unresolved known-attempt current-chat logs are eligible, never queued/running/canceled/success/foreign work',()=>{
  const rows=[log('yes'),log('foreign',{snapshot:{...log().snapshot,chatKey:'other'}}),log('done',{status:'success'}),log('running',{status:'generating'}),
    log('cancel',{status:'cancelled'}),log('unsent',{submissionState:'not_submitted'}),log('failed',{params:{upstreamStatus:'failed'}}),log('active'),
    log('missing',{snapshot:{source:'comfy',chatKey:'chat'}}),log('nai',{snapshot:{...log().snapshot,source:'novel',serviceTask:{attemptId:'nai'},imageAdmission:{...log().snapshot.imageAdmission,attemptId:'nai'}}})];
  assert.deepEqual(originalRecoveryLogs(rows,{chat:'chat',active:new Set(['active'])}).map(row=>row.id),['yes','nai']);
  assert.deepEqual(originalRecoveryLogs(rows,{chat:''}),[]);assert.equal(originalRecoveryLogs(Array.from({length:20},(_,i)=>log(String(i))),{chat:'chat'}).length,8);
});
test('triggers merge; each activation performs at most three receipt checks and has no submission dependency',async()=>{
  const calls=[],f=fixture(async row=>calls.push(row.id));f.manager.trigger();f.manager.trigger();assert.equal(f.timers.size,1);
  for(let i=0;i<3;i++)await f.tick();assert.deepEqual(calls,['a','a','a']);assert.equal(f.timers.size,0);
  assert.doesNotMatch(readFileSync(new URL('../qianmu-storyboard-original-recovery.js',import.meta.url),'utf8'),/\.submit\(|\.prepare\(|\.catalog\(|localStorage|setInterval/);
});
test('in-flight triggers never double receive; successful result stops remaining network checks',async()=>{
  let release,calls=0;const f=fixture(async row=>{calls++;await new Promise(resolve=>release=resolve);row.status='success';});
  f.manager.trigger();await f.tick();f.manager.trigger();assert.equal(calls,1);assert.equal(f.timers.size,0);
  release();await flush();await f.tick();assert.equal(calls,1);assert.equal(f.timers.size,0);
});
test('changing chat stops scheduled original work and does not query a foreign log',async()=>{
  const calls=[],f=fixture(async row=>calls.push(row.id));f.manager.trigger();f.change({chat:'other'});await f.tick();assert.deepEqual(calls,[]);
  f.manager.trigger();await f.tick();assert.deepEqual(calls,[]);assert.equal(f.timers.size,0);
});
test('generation actively owning an attempt blocks recovery; disabled owner and reset cancel timers',async()=>{
  let calls=0;const f=fixture(async()=>calls++);f.active.add('a');f.manager.trigger();await f.tick();assert.equal(calls,0);
  f.active.clear();f.manager.trigger();assert.equal(f.timers.size,1);f.manager.reset();assert.equal(f.timers.size,0);
  f.change({owner:null});f.manager.trigger();assert.equal(f.timers.size,0);
});
function logNavigation(logs){
  const state={logs,view:'gallery'},notices=[],opened=[],rows=logs.map(row=>({dataset:{storyboardLog:row.id},open:false,scrollIntoView(){this.scrolled=true;}}));
  const c=vm.createContext({storyboardState:()=>state,toast:(...args)=>notices.push(args),openModal:tab=>{opened.push(tab);c.activeTab='imagegen';},
    requestAnimationFrame:fn=>fn(),storyboardHydratePipelineArchive:async()=>{},activeTab:'dashboard',MODAL_ID:'modal',document:{querySelectorAll:()=>rows}});
  vm.runInContext(storyboardFunctionSource('storyboardOpenImageLog'),c);return {c,state,notices,opened,rows};
}
test('image log shortcut expands only its exact record log and never guesses another task',async()=>{
  const f=logNavigation([{id:'older',recordIds:['r1']},{id:'target',recordIds:['r2']},{id:'else',snapshot:{imageAdmission:{attemptId:'other'}}}]);
  await f.c.storyboardOpenImageLog({id:'r2'});assert.deepEqual(f.opened,['imagegen']);assert.equal(f.state.view,'logs');assert.equal(f.rows[1].open,true);assert.equal(f.rows[0].open,false);
  await f.c.storyboardOpenImageLog({id:'absent'});assert.equal(f.opened.length,1);assert.match(f.notices.at(-1)[0],/已不在日志中/);
});
test('image log shortcut allows exact attempt fallback but rejects ambiguous associations',async()=>{
  const f=logNavigation([{id:'a',snapshot:{imageAdmission:{attemptId:'job'}}}]);await f.c.storyboardOpenImageLog({id:'r',taskId:'job'});assert.equal(f.rows[0].open,true);
  const g=logNavigation([{id:'a',recordId:'r'},{id:'b',recordIds:['r']}]);await g.c.storyboardOpenImageLog({id:'r'});assert.equal(g.opened.length,0);assert.match(g.notices[0][0],/多个任务/);
});
test('image log shortcut waits for archive re-render and cannot reopen after leaving logs',async()=>{
  const f=logNavigation([{id:'a',recordId:'r'}]);let release;f.c.storyboardHydratePipelineArchive=()=>new Promise(resolve=>release=resolve);
  const opening=f.c.storyboardOpenImageLog({id:'r'});assert.equal(f.rows[0].open,false);release();await opening;assert.equal(f.rows[0].open,true);
  f.rows[0].open=false;const late=f.c.storyboardOpenImageLog({id:'r'});f.state.view='gallery';release();await late;assert.equal(f.rows[0].open,false);
});
