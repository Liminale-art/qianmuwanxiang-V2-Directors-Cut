import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {createStoryboardStreamHost} from '../qianmu-storyboard-stream-host.js';
const deferred=()=>{let resolve;return {promise:new Promise(done=>resolve=done),resolve};};
async function tick(){for(let i=0;i<40;i++)await Promise.resolve();}
function fixture(extra={}){
  const events=new EventEmitter(),timers=new Map(),dom=new Map(),notices=[],calls=[];
  const host={chat:[{is_user:true,mes:'Question'}],chatMetadata:{},eventSource:events,streamingProcessor:null};
  let epoch=0,enabled=true,valid=true,sequence=0,opened=0,disposed=0,validated=0,busy=false,runHook=null,frameSignal;
  const document={addEventListener:(event,fn)=>{const rows=dom.get(event)||new Set();rows.add(fn);dom.set(event,rows);},removeEventListener:(event,fn)=>dom.get(event)?.delete(fn)};
  const runtime=createStoryboardStreamHost({getContext:()=>host,epoch:()=>epoch,enabled:()=>enabled,busy:()=>busy,document,intervalMs:0,
    setTimer:fn=>{const id=++sequence;timers.set(id,fn);return id;},clearTimer:id=>timers.delete(id),
    openFrame:({floor,signal})=>{opened++;frameSignal=signal;assert.equal(floor,1);return {assertCurrent(){validated++;if(!valid)throw Error('changed');},dispose(){disposed++;}};},
    run:async options=>{calls.push(options);return runHook?runHook(options):{status:'advanced',queued:1};},notify:message=>notices.push(message),...extra});
  const start=(type=undefined,options={},dryRun=false)=>events.emit('generation_after_commands',type,options,dryRun);
  const begin=(type=undefined)=>{const message={name:'Alice',is_user:false,mes:'A kitchen.\n\nMore',send_date:'today',gen_started:'generation-1',swipe_id:0};
    host.chat.push(message);host.streamingProcessor={type,messageId:1,abortController:new AbortController(),isFinished:false};return message;};
  const step=async()=>{const [id,fn]=timers.entries().next().value||[];assert.ok(fn,'a timer is pending');timers.delete(id);fn();await tick();};
  return {host,events,timers,dom,notices,calls,runtime,start,begin,step,token:value=>events.emit('stream_token_received',value),
    get counts(){return{opened,disposed,validated};},get signal(){return frameSignal;},
    set enabled(value){enabled=value;},set valid(value){valid=value;},set busy(value){busy=value;},set run(value){runHook=value;},bump:()=>epoch++,
    finish:()=>runtime.beforeAutomatic(1,host.chat[1],host.streamingProcessor?.type),
    input:({search=false,owned=true}={})=>{for(const fn of dom.get('input')||[])fn({target:{type:search?'search':'text',className:search?'sd-search':'sd-storyboard-prompt',closest:()=>owned?{}:null,matches:()=>true}});},
    listeners:()=>events.eventNames().reduce((n,name)=>n+events.listenerCount(name),0)+[...dom.values()].reduce((n,rows)=>n+rows.size,0)};
}

test('stream host coalesces raw notifications and reads only processed prose after the delayed handoff',async()=>{
  const f=fixture();f.start();const message=f.begin();let reads=0,text='Original incomplete';Object.defineProperty(message,'mes',{get(){reads++;return text;}});
  const raw={toString(){assert.fail('raw token read');}};for(let i=0;i<5000;i++)f.token(raw);
  assert.equal(f.timers.size,1);assert.equal(f.counts.opened,0);assert.equal(reads,0);assert.equal(f.calls.length,0);
  text='Processed kitchen.\n\nMore';await f.step();assert.equal(f.counts.opened,1);assert.equal(reads,0);await f.step();assert.equal(reads,1);assert.equal(f.calls.length,1);
  const checked=f.counts.validated;for(let i=0;i<5000;i++)f.token(raw);assert.equal(reads,1);assert.equal(f.counts.validated,checked);assert.equal(f.timers.size,1);
  await f.step();assert.equal(f.calls.length,1,'same closed prefix is not extracted again');f.runtime.close();assert.equal(f.listeners(),0);assert.equal(f.timers.size,0);
});

for(const type of [undefined,'normal','swipe','regenerate'])test(`supported ${type||'default'} host generation owns one delayed stream lifetime`,async()=>{
  const f=fixture();f.start(type);f.begin(type);f.token('raw');await f.step();await f.step();assert.equal(f.calls.length,1);
  assert.equal(await f.finish(),true);assert.equal(f.counts.disposed,1);f.runtime.close();assert.equal(f.listeners(),0);
});

for(const type of ['quiet','impersonate','continue','unknown'])test(`${type} is not mistaken for a new stream; explicit continue retains its separate lineage path`,async()=>{
  const f=fixture();f.start(type);f.begin(type);f.token('raw');assert.equal(f.timers.size,0);assert.equal(f.calls.length,0);assert.equal(f.finish(),null);f.runtime.close();
});

test('dry runs and disabled streaming neither select a source nor register a timer',()=>{
  const f=fixture();f.start(undefined,{},true);f.begin();f.token();assert.equal(f.timers.size,0);f.enabled=false;f.start();f.token();assert.equal(f.timers.size,0);f.runtime.close();
});

test('finish waits for pending partial work, is single-flight and never performs final extraction itself',async()=>{
  const f=fixture(),gate=deferred();f.start();f.begin();f.run=()=>gate.promise;f.token();await f.step();await f.step();
  const a=f.finish(),b=f.finish();assert.equal(a,b);let ended=false;a.then(()=>ended=true);await tick();assert.equal(ended,false);
  f.token('late');assert.equal(f.timers.size,0);gate.resolve({status:'advanced',queued:1});assert.equal(await a,true);assert.equal(f.calls.length,1);assert.equal(f.counts.disposed,1);f.runtime.close();
});

test('the received listener cannot await model work or prevent following ST handlers',async()=>{
  const f=fixture(),gate=deferred();f.start();f.begin();f.run=()=>gate.promise;f.token();await f.step();await f.step();let later=0;
  f.events.on('message_received',()=>later++);assert.equal(f.events.emit('message_received','1',undefined),true);assert.equal(later,1);
  const done=f.finish();gate.resolve({status:'advanced',queued:1});assert.equal(await done,true);f.runtime.close();
});

for(const event of ['generation_stopped','message_edited','message_deleted','message_swiped'])test(`${event} aborts pending stream work without permitting terminal fallback`,async()=>{
  const f=fixture(),gate=deferred();f.start();f.begin();f.run=()=>gate.promise;f.token();await f.step();await f.step();
  const signal=f.calls[0].signal;f.events.emit(event);assert.equal(signal.aborted,true);assert.equal(f.finish(),false);assert.equal(f.timers.size,0);
  gate.resolve({status:'advanced',queued:1});await tick();assert.equal(f.calls.length,1);f.runtime.close();assert.equal(f.counts.disposed,1);
});

test('chat change releases the old lifetime instead of retaining an old-chat cancellation tombstone',async()=>{
  const f=fixture(),gate=deferred();f.start();f.begin();f.run=()=>gate.promise;f.token();await f.step();await f.step();const oldSignal=f.signal;
  f.events.emit('chat_id_changed');assert.equal(oldSignal.aborted,true);assert.equal(f.counts.disposed,1);assert.equal(f.finish(),null);
  f.token('late');assert.equal(f.timers.size,0);gate.resolve({status:'advanced',queued:1});await tick();assert.equal(f.calls.length,1);f.runtime.close();
});

test('manual workbench input stops early generation, while search and unrelated input do not',async()=>{
  const f=fixture();f.start();f.begin();f.token();await f.step();f.input({search:true});f.input({owned:false});assert.equal(f.signal.aborted,false);
  f.input();assert.equal(f.signal.aborted,true);assert.equal(f.finish(),false);assert.equal(f.timers.size,0);f.runtime.close();
});

test('a stopped processor cannot turn an error receipt into ordinary automatic fallback, even before source selection',()=>{
  const f=fixture();f.start();f.begin();f.host.streamingProcessor.abortController.abort();assert.equal(f.finish(),false);assert.equal(f.calls.length,0);f.runtime.close();
});

test('a non-stream terminal receipt clears bootstrap work and keeps the ordinary extraction path',()=>{
  const f=fixture();f.start();const message=f.begin();f.token();assert.equal(f.timers.size,1);assert.equal(f.finish(),null);assert.equal(f.timers.size,0);
  f.token('too late');assert.equal(f.calls.length,0);assert.equal(f.runtime.beforeAutomatic(1,message,undefined),null);f.runtime.close();
});

test('an older floor receipt does not terminate the active generation bootstrap',async()=>{
  const f=fixture();f.start();f.begin();f.token();assert.equal(f.runtime.beforeAutomatic(0,f.host.chat[0],undefined),null);assert.equal(f.timers.size,1);
  await f.step();await f.step();assert.equal(f.calls.length,1);f.runtime.close();
});

for(const change of ['generation','processor','chat','metadata','epoch','enabled'])test(`${change} replacement cannot borrow an earlier host lifetime`,async()=>{
  const f=fixture();f.start();const message=f.begin();f.token();await f.step();
  if(change==='generation')message.gen_started='new';if(change==='processor')f.host.streamingProcessor={...f.host.streamingProcessor};if(change==='chat')f.host.chat=[...f.host.chat];
  if(change==='metadata')f.host.chatMetadata={};if(change==='epoch')f.bump();if(change==='enabled')f.enabled=false;
  f.token('late');assert.equal(f.signal.aborted,true);assert.equal(f.timers.size,0);assert.equal(f.calls.length,0);f.runtime.close();
});

test('busy work waits for explicit wake without polling and respects a later source-guard failure',async()=>{
  const f=fixture();f.start();f.begin();f.busy=true;f.token();await f.step();assert.equal(f.timers.size,0);
  f.busy=false;f.runtime.wake();assert.equal(f.timers.size,1);f.valid=false;await f.step();assert.equal(f.calls.length,0);assert.equal(await f.finish(),false);f.runtime.close();
});

test('a failed pass blocks final fallback and optional notification errors cannot escape into ST',async()=>{
  const f=fixture({notify:async()=>{throw Error('optional toast rejected');}});f.start();f.begin();f.run=async()=>({status:'failed',queued:1});f.token();await f.step();await f.step();
  assert.equal(await f.finish(),false);assert.equal(f.calls.length,1);await tick();f.runtime.close();
});

test('missing or stale processors cannot cause the previous assistant response to be extracted',async()=>{
  const f=fixture();f.begin();f.start();f.token();await f.step();assert.equal(f.counts.opened,0);assert.equal(f.calls.length,0);assert.equal(f.timers.size,0);f.runtime.close();
});

test('a new processor still cannot reuse the unchanged previous assistant generation',async()=>{
  const f=fixture();f.begin();f.start();f.host.streamingProcessor={...f.host.streamingProcessor,abortController:new AbortController()};f.token();await f.step();
  assert.equal(f.counts.opened,0);assert.equal(f.calls.length,0);f.runtime.close();
});

test('host initialization errors and partial subscription failure clean up without throwing',()=>{
  const broken=createStoryboardStreamHost({getContext:()=>{throw Error('closing');}});broken.close();
  const source=new EventEmitter(),on=source.on;let calls=0;source.on=function(event,fn){on.call(this,event,fn);if(++calls===2)throw Error('subscription failed');return this;};
  const runtime=createStoryboardStreamHost({getContext:()=>({eventSource:source})});assert.equal(source.eventNames().length,0);runtime.close();
});

test('the supplied abort signal stops bootstrap without model work and cannot reopen through final notification',()=>{
  const f=fixture(),controller=new AbortController();f.start(undefined,{signal:controller.signal});f.begin();f.token();controller.abort();
  assert.equal(f.timers.size,0);assert.equal(f.finish(),false);assert.equal(f.calls.length,0);f.runtime.close();
});

test('a failed frame guard setup is isolated from the host and blocks an automatic retry',async()=>{
  const f=fixture({openFrame:()=>{throw Error('source unavailable');}});f.start();f.begin();f.token();await f.step();
  assert.equal(f.finish(),false);assert.equal(f.calls.length,0);assert.equal(f.notices.length,1);f.runtime.close();
});

test('a new generation aborts the old frame but its late completion cannot close the replacement',async()=>{
  const f=fixture(),gate=deferred();f.start();f.begin();f.run=()=>gate.promise;f.token();await f.step();await f.step();const oldSignal=f.signal;
  f.start();f.host.chat[1].gen_started='new-generation';f.host.streamingProcessor={type:undefined,messageId:1,abortController:new AbortController()};f.token();
  assert.equal(oldSignal.aborted,true);gate.resolve({status:'advanced',queued:1});await tick();assert.equal(f.timers.size,1);
  await f.step();assert.equal(f.signal.aborted,false);assert.equal(f.counts.opened,2);f.runtime.close();assert.equal(f.counts.disposed,2);
});
