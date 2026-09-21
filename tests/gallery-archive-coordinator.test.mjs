import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {createGalleryArchiveCoordinator} from '../qianmu-gallery-archive-coordinator.js';
import {storyboardFunctionSource as section} from './helpers/storyboard-form-fixture.mjs';

const gate=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
const flush=()=>new Promise(resolve=>setImmediate(resolve));
function fixture(t,extra={}){
  const window=new EventTarget(),document=new EventTarget(),timers=new Map(),opened=[],errors=[];
  let time=0,id=0,available=true,current=true,admitted=true,identity='account/chat/content',saves=0;
  const context={chatMetadata:{story_director_liminale:{storyboardImages:[{id:'image'}]}}};
  window.navigator={onLine:true,connection:{saveData:false}};document.hidden=false;document.readyState='complete';
  window.setTimeout=(fn,ms)=>{timers.set(++id,{fn,at:time+ms});return id;};window.clearTimeout=id=>timers.delete(id);
  const options={getContext:()=>context,epoch:()=>0,account:async()=> 'st-user:test',headers:()=>({}),window,document,now:()=>time,
    isCurrent:()=>current,canRun:()=>available,admit:async()=>admitted,onError:e=>errors.push(e),
    connect:async args=>{const session={identity,closed:false,close(){this.closed=true;},async preserveAll(){args.guard();saves++;}};opened.push(session);return session;},...extra};
  const c=createGalleryArchiveCoordinator(options);t.after(()=>c.close());
  return {c,options,window,document,timers,opened,errors,context,get saves(){return saves;},set available(v){available=v;},set current(v){current=v;},set admitted(v){admitted=v;},set identity(v){identity=v;},
    async tick(ms=5000){time+=ms;const due=[...timers].filter(([,v])=>v.at<=time);for(const [key,{fn}] of due){if(timers.delete(key))fn();}await flush();},flush};
}

test('idle coordinator has no startup I/O, coalesces triggers and skips exact unchanged successful versions',async t=>{
  const f=fixture(t);await f.tick();assert.equal(f.opened.length,0);assert.equal(f.timers.size,0);
  for(let i=0;i<20;i++)f.c.schedule();assert.equal(f.timers.size,1);await f.tick(4999);assert.equal(f.saves,0);
  await f.tick(1);assert.equal(f.saves,1);assert.equal(f.opened[0].closed,true);assert.equal(f.timers.size,0);
  f.c.schedule();await f.tick();assert.equal(f.opened.length,2);assert.equal(f.saves,1);
  f.identity='account/chat/edited';f.c.schedule();await f.tick();assert.equal(f.saves,2);
  f.c.reset();f.c.schedule();await f.tick();assert.equal(f.saves,3,'reset invalidates session-only success memo');
});

test('typing, generation, hidden/offline and data-saving defer imports until quiet',async t=>{
  const f=fixture(t);f.c.schedule();f.available=false;await f.tick();assert.equal(f.opened.length,0);f.available=true;
  f.document.hidden=true;await f.tick();f.document.hidden=false;
  f.window.navigator.onLine=false;await f.tick();f.window.navigator.onLine=true;
  f.window.navigator.connection.saveData=true;await f.tick();f.window.navigator.connection.saveData=false;
  await f.tick(2500);f.document.dispatchEvent(new Event('input'));await f.tick(2500);assert.equal(f.saves,0);
  await f.tick();assert.equal(f.saves,1);
});

test('a running pass yields between records and resumes without reopening a second session',async t=>{
  const first=gate(),proceed=gate(),writes=[];let f;
  f=fixture(t,{connect:async args=>({identity:'one',close(){},async preserveAll(){writes.push(1);first.resolve();await proceed.promise;await args.yieldWork();writes.push(2);}})});
  f.c.schedule();await f.tick();await first.promise;f.available=false;proceed.resolve();await flush();
  assert.deepEqual(writes,[1]);assert.equal(f.c.status().state,'waiting');await f.tick();assert.deepEqual(writes,[1]);
  f.available=true;await f.tick();assert.deepEqual(writes,[1,2]);assert.equal(f.c.status().state,'saved');assert.equal(f.timers.size,0);
});

test('reset during a late session open closes it without writes or success',async t=>{
  const wait=gate(),session={identity:'old',closed:false,close(){this.closed=true;},preserveAll(){assert.fail('late session must not write');}};
  const f=fixture(t,{connect:()=>wait.promise});f.c.schedule();await f.tick();assert.equal(f.c.status().running,true);
  f.c.reset();wait.resolve(session);await flush();assert.equal(session.closed,true);assert.equal(f.c.status().running,false);assert.equal(f.timers.size,0);assert.deepEqual(f.errors,[]);
});

test('retrigger cancels old work, keeps one in flight and coalesces the replacement',async t=>{
  const wait=gate(),sessions=[];let active=0,max=0,successful=0;
  const f=fixture(t,{connect:async args=>{const number=sessions.length,session={identity:'version'+number,closed:false,close(){this.closed=true;},async preserveAll(){
    active++;max=Math.max(max,active);try{if(!number)await wait.promise;args.guard();successful++;}finally{active--;}
  }};sessions.push(session);return session;}});
  f.c.schedule();await f.tick();for(let i=0;i<10;i++)f.c.schedule();assert.equal(sessions[0].closed,true);
  await f.tick();assert.equal(sessions.length,1);wait.resolve();await flush();await f.tick();assert.equal(sessions.length,2);
  assert.equal(max,1);assert.equal(successful,1);assert.deepEqual(f.errors,[]);
});

test('failure waits for another real trigger, emits no source or private error details and retains retryability',async t=>{
  let attempts=0;const f=fixture(t,{connect:async()=>({identity:'retry',close(){},async preserveAll(){attempts++;if(attempts===1)throw Object.assign(Error('SECRET raw chat'),{writeState:'unconfirmed'});}})});
  f.c.schedule();await f.tick();assert.equal(f.c.status().state,'error');assert.equal(f.timers.size,0);
  assert.deepEqual(f.errors,[{code:'gallery_preservation_failed',writeState:'unconfirmed'}]);await f.tick();assert.equal(attempts,1);
  f.c.schedule();await f.tick();assert.equal(attempts,2);assert.equal(f.c.status().state,'saved');
});

test('pending import recovery blocks source reads; empty/non-chat contexts and expired owners do nothing',async t=>{
  const f=fixture(t);f.admitted=false;f.c.schedule();await f.tick();assert.equal(f.opened.length,0);
  f.admitted=true;await f.tick();assert.equal(f.saves,1);
  f.context.chatMetadata={};f.c.schedule();await f.tick();assert.equal(f.opened.length,1);assert.equal(f.timers.size,0);
  f.current=false;f.c.schedule();await f.tick();assert.equal(f.opened.length,1);assert.equal(f.timers.size,0);
});

test('account identity changes cannot reuse another account success, pagehide disposes timers',async t=>{
  const f=fixture(t);f.c.schedule();await f.tick();f.identity='different-account/chat/content';f.c.schedule();await f.tick();assert.equal(f.saves,2);
  f.c.schedule();f.window.dispatchEvent(new Event('pagehide'));await f.tick();assert.equal(f.saves,2);assert.equal(f.c.status().closed,true);assert.equal(f.timers.size,0);
});

test('close while paused cancels idle wait without late writes or leaked timers',async t=>{
  const started=gate(),resume=gate();let late=0,f;
  f=fixture(t,{connect:async args=>({identity:'paused',close(){},async preserveAll(){started.resolve();await resume.promise;await args.yieldWork();late++;}})});
  f.c.schedule();await f.tick();await started.promise;f.available=false;resume.resolve();await flush();assert.equal(f.timers.size,1);
  f.c.close();await flush();assert.equal(late,0);assert.equal(f.timers.size,0);assert.deepEqual(f.errors,[]);
});

test('storage restore epoch change invalidates a paused pass even without a chat reset event',async t=>{
  let epoch=1,late=0,f;const start=gate(),resume=gate();
  f=fixture(t,{epoch:()=>epoch,connect:async args=>({identity:'old',close(){},async preserveAll(){start.resolve();await resume.promise;await args.yieldWork();late++;}})});
  f.c.schedule();await f.tick();await start.promise;f.available=false;resume.resolve();await flush();epoch++;
  await f.tick();assert.equal(late,0);assert.equal(f.c.status().running,false);assert.equal(f.timers.size,0);assert.deepEqual(f.errors,[]);
});

test('late component loading after runtime disposal cannot recreate the automatic writer',async()=>{
  const load=gate();const context=vm.createContext({initialized:true,settings:{enabled:true},isRuntimeOwner:()=>true,storyboardAdmissionEpoch:1,
    storyboardGalleryPreserver:null,storyboardGalleryPreserverLoading:null,featureRuntime:{load:()=>load.promise},console:{warn(){}}});
  vm.runInContext(section('storyboardScheduleGalleryPreservation'),context);context.storyboardScheduleGalleryPreservation();context.storyboardAdmissionEpoch++;
  load.resolve({createGalleryArchiveCoordinator:()=>assert.fail('disposed runtime must not recreate writer')});await flush();assert.equal(context.storyboardGalleryPreserver,null);
});

test('actual application glue coalesces lazy imports and respects typing/generation/import/cleanup gates',async()=>{
  const load=gate(),created=[],warnings=[];let scheduled=0,loaded=0;
  const context=vm.createContext({initialized:true,settings:{enabled:true},isRuntimeOwner:()=>true,storyboardAdmissionEpoch:1,storyboardSnapshotEpoch:1,
    storyboardGalleryPreserver:null,storyboardGalleryPreserverLoading:null,storyboardSnapshotArchiveBusy:0,
    featureRuntime:{load:()=>{loaded++;return load.promise;}},ctx:()=>({}),storyboardRequestHeaders:()=>({}),storyboardPackageArchiveAllowed:async()=>true,
    configRestoreActivity:()=>({}),console:{warn:message=>warnings.push(message)}});vm.runInContext(section('storyboardScheduleGalleryPreservation'),context);
  context.storyboardScheduleGalleryPreservation();context.storyboardScheduleGalleryPreservation();assert.equal(loaded,1);
  load.resolve({createGalleryArchiveCoordinator:options=>{created.push(options);return {schedule:()=>scheduled++};}});await flush();
  assert.equal(created.length,1);assert.equal(scheduled,1);context.storyboardScheduleGalleryPreservation();assert.equal(scheduled,2);
  const options=created[0];assert.equal(options.canRun(),true);
  options.onError({code:'gallery_originals_incomplete',writeState:'records_saved',private:'never log'});assert.match(warnings[0],/记录与配方已保存/);assert.doesNotMatch(warnings[0],/never log/);
  options.onError({code:'gallery_preservation_failed'});assert.match(warnings[1],/图库保全未完成/);
  for(const key of ['director','image','transfer']){context.configRestoreActivity=()=>({[key]:true});assert.equal(options.canRun(),false);}
  context.configRestoreActivity=()=>({});context.storyboardSnapshotArchiveBusy=1;assert.equal(options.canRun(),false);context.storyboardSnapshotArchiveBusy=0;
  context.ctx=()=>({streamingProcessor:{isStopped:false,isFinished:false}});assert.equal(options.canRun(),false);
  context.ctx=()=>({streamingProcessor:{isStopped:true,isFinished:false}});assert.equal(options.canRun(),true);
});

test('actual entry completion schedules even an already stripped gallery, but never after epoch change',async()=>{
  let scheduled=0;const context=vm.createContext({storyboardSnapshotArchiveBusy:0,storyboardSnapshotEpoch:1,storyboardGalleryRecords:()=>[],getChatKey:()=> 'chat',
    storyboardScheduleGalleryPreservation:()=>scheduled++,blobStore:{blobStoreAvailable:()=>true}});
  vm.runInContext(section('storyboardArchiveGallerySnapshots'),context);assert.equal(await context.storyboardArchiveGallerySnapshots(),0);
  assert.equal(scheduled,1);assert.equal(context.storyboardSnapshotArchiveBusy,0);
  context.storyboardGalleryRecords=()=>{context.storyboardSnapshotEpoch++;return [];};
  // Default arguments run before epoch capture; changes inside processing are the protected case.
  context.getChatKey=()=>{context.storyboardSnapshotEpoch++;return 'next';};await context.storyboardArchiveGallerySnapshots([]);
  assert.equal(scheduled,1);assert.equal(context.storyboardSnapshotArchiveBusy,0);
});
