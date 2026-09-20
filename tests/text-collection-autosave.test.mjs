import test from 'node:test';
import assert from 'node:assert/strict';
import {createCollectionAutosave} from '../qianmu-text-collection-autosave.js';
function fixture(rows=[]){
 const window=new EventTarget(),document=new EventTarget(),timers=new Map();let next=0,opens=0,closed=0,submitted=[],failure=false,current=true;
 window.navigator={onLine:true};window.setTimeout=(fn,delay)=>{const id=++next;timers.set(id,{fn,delay});return id;};window.clearTimeout=id=>timers.delete(id);document.hidden=false;
 const auto=createCollectionAutosave({window,document,isCurrent:()=>current,sessionFactory:async()=>{opens++;return {close(){closed++;}};},outboxFactory:()=>({list:async()=>rows,submit:async id=>{submitted.push(id);if(failure)throw Error('offline');return {status:'confirmed'};},keepCopy:async row=>{submitted.push('copy:'+row.request.mutationId);return {status:'confirmed'};},close(){}})});
 return {auto,window,document,timers,get opens(){return opens;},get closed(){return closed;},submitted,fail(){failure=true;},invalidate(){current=false;},async tick(){const [id,{fn}]=timers.entries().next().value;timers.delete(id);fn();await auto.wake();}};
}
test('empty recovery queue is dormant; a save event schedules only a delayed check',async()=>{
 const f=fixture();f.auto.start();await f.auto.wake();assert.equal(f.opens,1);assert.equal(f.timers.size,0);
 f.window.dispatchEvent(new Event('qianmu-collection-save-queued'));assert.equal(f.timers.size,1);assert.equal([...f.timers.values()][0].delay,3000);
 await f.tick();assert.equal(f.timers.size,0);f.auto.close();f.window.dispatchEvent(new Event('online'));assert.equal(f.opens,2);
});
test('recovery retries are bounded and reconnect can retry without any user sync button',async()=>{
 const f=fixture([{state:'pending',request:{mutationId:'same-request'}}]);f.fail();await f.auto.wake();await f.tick();await f.tick();
 assert.deepEqual(f.submitted,['same-request','same-request','same-request']);assert.equal(f.timers.size,0);f.auto.close();
});
test('conflicts create an independent copy rather than rebasing or discarding the edit',async()=>{
 const f=fixture([{state:'conflict',request:{mutationId:'old-edit'}}]);await f.auto.wake();assert.deepEqual(f.submitted,['copy:old-edit']);assert.equal(f.timers.size,0);f.auto.close();
});

test('one confirmed recovery batch emits only one payload-free star refresh; failures and empty queues do not',async()=>{
 for(const [rows,fail,expected] of [[[],false,0],[[{state:'pending',request:{mutationId:'a'}},{state:'pending',request:{mutationId:'b'}}],false,1],[[{state:'pending',request:{mutationId:'a'}}],true,0]]){
  const f=fixture(rows),events=[];f.document.addEventListener('qianmu-text-collections-changed',event=>events.push(event));if(fail)f.fail();
  await f.auto.wake();assert.equal(events.length,expected);for(const event of events)assert.equal(event.detail,undefined);f.auto.close();
 }
});
test('hidden, offline and expired runtime do not scan or submit',async()=>{
 const f=fixture();f.document.hidden=true;await f.auto.wake();f.document.hidden=false;f.window.navigator.onLine=false;await f.auto.wake();f.window.navigator.onLine=true;f.invalidate();await f.auto.wake();assert.equal(f.opens,0);f.auto.close();
});

function controlled({submit,list}={}){
 const window=new EventTarget(),document=new EventTarget(),timers=new Map(),errors=[];let next=0;
 window.navigator={onLine:true};window.setTimeout=(fn,delay)=>{const id=++next;timers.set(id,{fn,delay});return id;};window.clearTimeout=id=>timers.delete(id);document.hidden=false;
 const auto=createCollectionAutosave({window,document,isCurrent:()=>true,onError:cause=>errors.push(cause),sessionFactory:async()=>({close(){}}),
  outboxFactory:()=>({list,submit,close(){}})});
 return {auto,window,timers,errors,fire(){const [id,{fn}]=timers.entries().next().value;timers.delete(id);fn();}};
}

test('a queue wake that fires during a slow submission is replayed after the active snapshot finishes',async()=>{
 let release,entered;const held=new Promise(resolve=>{release=resolve;}),started=new Promise(resolve=>{entered=resolve;}),rows=['old'],submitted=[];
 const f=controlled({list:async()=>rows.map(id=>({state:'pending',request:{mutationId:id}})),submit:async id=>{submitted.push(id);if(id==='old'){entered();await held;}rows.splice(rows.indexOf(id),1);return {status:'confirmed'};}});
 f.auto.start();const active=f.auto.wake();await started;rows.push('new');f.window.dispatchEvent(new Event('qianmu-collection-save-queued'));
 f.fire();assert.equal(f.timers.size,0,'the scheduled wake fired while the old request was still running');release();await active;
 assert.equal(f.timers.size,1,'the new work must retain a wake after the old snapshot completes');assert.equal([...f.timers.values()][0].delay,3000);
 f.fire();await f.auto.wake();assert.deepEqual(submitted,['old','new']);assert.equal(f.timers.size,0);f.auto.close();
});

test('one rejected save cannot starve the next independent save; each failed round still backs off at most three times',async()=>{
 let remaining=true;const submitted=[];
 const f=controlled({list:async()=>['bad',...(remaining?['good']:[])].map(id=>({state:'pending',request:{mutationId:id}})),submit:async id=>{submitted.push(id);if(id==='bad')throw Error('one damaged operation');remaining=false;return {status:'confirmed'};}});
 await f.auto.wake();assert.deepEqual(submitted,['bad','good']);assert.equal([...f.timers.values()][0].delay,30000);
 f.fire();await f.auto.wake();f.fire();await f.auto.wake();assert.deepEqual(submitted,['bad','good','bad','bad']);assert.equal(f.timers.size,0);f.auto.close();
});

test('account failure stops the batch immediately and does not schedule blind retries in a different account',async()=>{
 const submitted=[];const f=controlled({list:async()=>['old','other'].map(id=>({state:'pending',request:{mutationId:id}})),submit:async id=>{submitted.push(id);f.window.dispatchEvent(new Event('qianmu-collection-save-queued'));throw Object.assign(Error('account changed'),{code:'text_collection_sync_account'});}});f.auto.start();
 await f.auto.wake();assert.deepEqual(submitted,['old']);assert.equal(f.timers.size,0);f.auto.close();
});

test('non-final submit results are retained for a bounded retry rather than claimed as completed',async()=>{
 for(const status of ['pending','conflict']){
  let count=0;const f=controlled({list:async()=>[{state:'pending',request:{mutationId:'same'}}],submit:async()=>{count++;return {status};}});
  await f.auto.wake();assert.equal(f.timers.size,1);f.fire();await f.auto.wake();f.fire();await f.auto.wake();assert.equal(count,3);assert.equal(f.timers.size,0);f.auto.close();
 }
});
