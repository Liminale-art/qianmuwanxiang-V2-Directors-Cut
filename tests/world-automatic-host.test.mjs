import test from 'node:test';
import assert from 'node:assert/strict';
import {createWorldAutomaticHost as create,createWorldAutomaticRepairBudget,selectWorldAutomaticPackets as select,normalizeWorldAutomaticLimit as limit} from '../qianmu-world-automatic-host.js';
import {prepareAutomaticWorldShot} from '../qianmu-world-automatic.js';
import {normalizeStoryboardShotSpec} from '../qianmu-storyboard.js';
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
const flush=async()=>{for(let i=0;i<4;i++)await new Promise(setImmediate);};
function fixture(options={}){
  let busy=false,valid=true,prepared=0,disposed=0,sequence=0;const timers=new Map(),calls=[],notices=[],repairs=[];
  const host=create({busy:()=>busy,notify:text=>notices.push(text),setTimer:fn=>{timers.set(++sequence,fn);return sequence;},clearTimer:id=>timers.delete(id),...options});
  const ticket=(key='new-plan',extra={})=>({key,limit:2,current:()=>valid,prepare:async()=>{prepared++;return ['first','second'];},
    run:async(id,budget)=>{calls.push(id);repairs.push(budget);return true;},dispose:()=>disposed++,...extra});
  return {host,ticket,timers,calls,notices,repairs,get prepared(){return prepared;},get disposed(){return disposed;},
    set busy(v){busy=v;},set valid(v){valid=v;},async tick(){const entry=timers.entries().next().value;if(entry){timers.delete(entry[0]);entry[1]();}await flush();}};
}

test('world completion queues once with one timer and no startup reads or polling',async()=>{
  const e=fixture();assert.equal(e.prepared,0);assert.equal(e.timers.size,0);
  assert.equal(e.host.offer(e.ticket()),true);for(let i=0;i<100;i++)e.host.wake();assert.equal(e.timers.size,1);
  await e.tick();assert.deepEqual(e.calls,['first','second']);assert.equal(e.prepared,1);assert.equal(e.disposed,1);assert.equal(e.timers.size,0);
  assert.equal(e.repairs[0],e.repairs[1]);assert.match(e.notices[0],/2\/2/);assert.equal(e.host.offer(e.ticket()),false);assert.equal(e.prepared,1);e.host.close();
});

test('busy ordinary extraction defers before preparation with no repeated timer until an explicit wake',async()=>{
  const e=fixture();e.busy=2;assert.equal(e.host.offer(e.ticket()),true);for(let i=0;i<500;i++)e.host.wake();
  assert.equal(e.timers.size,0);assert.equal(e.prepared,0);e.busy=false;e.host.wake();await e.tick();assert.equal(e.calls.length,2);
});

test('busy after preparing or after an image resumes the same ids and budget without a second preparation',async()=>{
  for(const after of ['prepare','image']){
    const e=fixture();let preparations=0,usedBudget;
    e.host.offer(e.ticket('plan',{prepare:async()=>{preparations++;if(after==='prepare')e.busy=true;return ['a','b'];},
      run:async(id,budget)=>{e.calls.push(id);usedBudget||=budget;assert.equal(budget,usedBudget);if(id==='a'&&after==='image')e.busy=true;return true;}}));
    await e.tick();assert.equal(e.host.snapshot().waiting,true);assert.equal(e.timers.size,0);assert.equal(e.disposed,0);
    e.busy=false;e.host.wake();await e.tick();assert.deepEqual(e.calls,['a','b']);assert.equal(preparations,1);assert.equal(e.disposed,1);
  }
});

test('newer completion replaces a waiting plan instead of backfilling it',async()=>{
  const e=fixture();e.busy=true;e.host.offer(e.ticket('old'));e.host.offer(e.ticket('new',{prepare:async()=>['new-a']}));
  assert.equal(e.disposed,1);e.busy=false;e.host.wake();await e.tick();assert.deepEqual(e.calls,['new-a']);assert.equal(e.disposed,2);
});

test('new completion while old preparation awaits cannot dispatch the old result',async()=>{
  const e=fixture(),gate=deferred();e.host.offer(e.ticket('old',{prepare:()=>gate.promise}));await e.tick();
  e.host.offer(e.ticket('new',{prepare:async()=>['new-a']}));gate.resolve(['old-a']);await flush();await e.tick();assert.deepEqual(e.calls,['new-a']);assert.equal(e.disposed,2);
});

test('duplicate delivery of the same live ticket cannot dispose or alter the owned batch',async()=>{
  const e=fixture(),ticket=e.ticket();e.host.offer(ticket);assert.equal(e.host.offer(ticket),false);assert.equal(e.disposed,0);
  ticket.run=()=>assert.fail('mutated run');ticket.limit=4;await e.tick();assert.deepEqual(e.calls,['first','second']);assert.equal(e.disposed,1);
});

for(const phase of ['waiting','preparing','running'])test(`opt-out or source revocation during ${phase} never dispatches the next image`,async()=>{
  const e=fixture(),gate=deferred();e.host.offer(e.ticket('plan',phase==='preparing'?{prepare:()=>gate.promise}:phase==='running'?{
    run:async id=>{e.calls.push(id);return gate.promise;}}:{}));
  if(phase!=='waiting')await e.tick();e.valid=false;gate.resolve(phase==='preparing'?['a','b']:true);await flush();await e.tick();
  assert.equal(e.calls.length,phase==='running'?1:0);assert.equal(e.disposed,1);assert.equal(e.timers.size,0);assert.equal(e.notices.length,0);
});

test('explicit close releases scheduled and in-flight ownership, never starting a replacement timer',async()=>{
  for(const inFlight of [false,true]){
    const e=fixture(),gate=deferred();e.host.offer(e.ticket('plan',{prepare:()=>gate.promise}));if(inFlight)await e.tick();
    e.host.close();gate.resolve(['a']);await flush();assert.equal(e.calls.length,0);assert.equal(e.timers.size,0);assert.equal(e.disposed,1);
    assert.equal(e.host.offer(e.ticket('next')),false);assert.equal(e.host.snapshot().closed,true);
  }
});

test('failed images consume their selected attempt rather than refilling a successful-image quota',async()=>{
  const e=fixture();e.host.offer(e.ticket('plan',{run:async id=>{e.calls.push(id);return false;}}));await e.tick();
  assert.deepEqual(e.calls,['first','second']);assert.match(e.notices[0],/0\/2/);e.host.wake();await e.tick();assert.equal(e.calls.length,2);
});

test('oversized, duplicate or invalid selected ids stop before generation',async()=>{
  for(const ids of [['a','b','c'],['a','a'],[null],null]){
    const e=fixture();e.host.offer(e.ticket('plan',{prepare:async()=>ids}));await e.tick();assert.equal(e.calls.length,0);assert.equal(e.disposed,1);assert.equal(e.notices.length,1);
  }
});

test('one image accepted before a later error is not replayed',async()=>{
  const e=fixture();e.host.offer(e.ticket('plan',{run:async id=>{e.calls.push(id);if(id==='second')throw Error('unknown outcome');return true;}}));await e.tick();
  assert.deepEqual(e.calls,['first','second']);assert.match(e.notices[0],/已入队画面保留/);assert.equal(e.host.offer(e.ticket('plan')),false);assert.equal(e.calls.length,2);
});

test('notification and idle-hook failures cannot change completed image results',async()=>{
  for(const failure of [()=>{throw Error('ui');},async()=>{throw Error('ui');}]){
    const e=fixture({notify:failure,idle:failure});e.host.offer(e.ticket());await e.tick();assert.equal(e.calls.length,2);assert.equal(e.disposed,1);
  }
});

test('unreadable current state, scheduler or busy state stops safely without loop retries',async()=>{
  const variants=[{current:()=>{throw Error('context');}},{host:{busy:()=>{throw Error('context');}}},{host:{setTimer:()=>{throw Error('timer');}}}];
  for(const item of variants){const e=fixture(item.host);e.host.offer(e.ticket('plan',item.current?{current:item.current}:{}));await e.tick();assert.equal(e.calls.length,0);assert.equal(e.disposed,1);}
});

test('three expression repairs are shared by the batch, not multiplied by its image count',async()=>{
  const budget=createWorldAutomaticRepairBudget(),shot=normalizeStoryboardShotSpec({subject:'garden'});let calls=0;
  const prepare=()=>prepareAutomaticWorldShot({shot,promptFormats:['tags'],repairBudget:budget,guard:async()=>{},prepareRenderings:async()=>{calls++;return {};}});
  await assert.rejects(prepare(),/本批已修复3次/);assert.equal(calls,4);assert.equal(budget.remaining,0);
  await assert.rejects(prepare(),/本批已修复3次/);assert.equal(calls,5);assert.equal(budget.take(),false);
});

const worldSource=(i,chatKey='chat')=>({schema:'qianmu.world-source.v1',chatKey,revisionId:'wrev-'+'a'.repeat(64),field:'npc_updates',itemId:'witem-'+i.repeat(64)});
function selection(){return {chatKey:'chat',limit:3,media:[],packets:['a','b','c'].map(id=>({packetId:id,sourceRef:{worldSource:worldSource(id)}})),
  ledger:{entries:['a','b','c'].map(id=>({entryId:'entry-'+id,source:{recordId:id}}))},
  pool:{owner:{chatKey:'chat'},candidates:['c','a','b'].map(id=>({entryId:'entry-'+id,owner:{chatKey:'chat'},sourceKind:'simulation',recommendation:'manual_review',gates:{sourceValid:true,factConsistency:true,shotDistinct:true}}))}};}

test('world selection follows existing ranking, source identity and its own bounded attempt count',()=>{
  const data=selection();assert.deepEqual(select(data),['c','a','b']);assert.deepEqual(select({...data,limit:1}),['c']);
  for(const value of [0,-1,5,NaN,Infinity,'no'])assert.equal(limit(value),1);assert.equal(limit('4'),4);
});

test('already illustrated sources, duplicates, untrusted candidates and foreign sources are not auto selected',()=>{
  const data=selection();data.media=[{id:'old',chatKey:'chat',productionContext:{worldSource:worldSource('c')}}];assert.deepEqual(select(data),['a','b']);
  data.pool.candidates.push(data.pool.candidates[1]);data.packets[2].sourceRef.worldSource=worldSource('a');data.media=[];assert.deepEqual(select(data),['c','b']);
  for(const mutate of [d=>d.pool.owner.chatKey='foreign',d=>d.pool.candidates.forEach(c=>c.recommendation='reject'),d=>d.pool.candidates.forEach(c=>c.gates.factConsistency=false),d=>d.packets.forEach(p=>p.sourceRef.worldSource=worldSource('d','foreign'))]){
    const d=selection();mutate(d);assert.deepEqual(select(d),[]);
  }
});
