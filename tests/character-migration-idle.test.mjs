import test from 'node:test';
import assert from 'node:assert/strict';
import {characterNativeFixture,namespace} from './helpers/character-native-fixture.mjs';
import {characterLegacyFixture,legacyPacket} from './helpers/character-legacy-fixture.mjs';
import {requestCharacterMigration} from '../qianmu-character-migration-idle.js';
import {createCharacterArchiveStore} from '../qianmu-character-archive-store.js';

function browser(t,{expose=false}={}){
  const window=new EventTarget(),document=new EventTarget(),timers=new Map();let time=0,id=0,stream=null;
  window.navigator={onLine:true,connection:{saveData:false}};window.SillyTavern={getContext:()=>({streamingProcessor:stream})};
  document.hidden=false;document.readyState='complete';window.setTimeout=(fn,ms)=>{timers.set(++id,{fn,at:time+ms});return id;};window.clearTimeout=id=>timers.delete(id);
  t.after(()=>window.dispatchEvent(new Event('pagehide')));
  if(expose){for(const [key,value]of Object.entries({window,document})){const prior=Object.getOwnPropertyDescriptor(globalThis,key);
    Object.defineProperty(globalThis,key,{value,configurable:true});t.after(()=>{if(prior)Object.defineProperty(globalThis,key,prior);else delete globalThis[key];});}
    t.mock.method(Date,'now',()=>time);}
  return {window,document,timers,now:()=>time,advance:ms=>{time+=ms;},stream:value=>{stream=value;},
    async tick(){const pair=timers.entries().next().value;assert.ok(pair);const [key,{fn,at}]=pair;timers.delete(key);time=Math.max(time,at);await fn();},
    async drain(){for(let i=0;timers.size&&i<30;i++)await this.tick();assert.equal(timers.size,0);}};
}
async function setup(t){const f=await characterNativeFixture(t),old=characterLegacyFixture(t),b=browser(t);f.configure();f.reset();
  const request=()=>requestCharacterMigration({...b,namespace,createLocal:old.createLocal,createStorage:f.createStorage});return {f,old,b,request};}

test('idle migration opens neither IDB nor network before quiet time, coalesces requests and closes its own clients',async t=>{
  const {f,old,b,request}=await setup(t);request();request();assert.equal(b.timers.size,1);assert.equal(old.opened,0);assert.equal(f.calls.length,0);
  await b.drain();assert.deepEqual(await f.open().backup(namespace),legacyPacket());assert.ok(old.closes>=1);
  request();assert.equal(b.timers.size,0);
});

test('idle migration yields while typing, streaming, hidden, offline, loading, input-pending or saving data',async t=>{
  const {f,b,request}=await setup(t);request();b.advance(4500);b.document.dispatchEvent(new Event('input'));await b.tick();
  b.stream({isStopped:false,isFinished:false});await b.tick();b.stream(null);b.document.hidden=true;await b.tick();b.document.hidden=false;
  b.window.navigator.onLine=false;await b.tick();b.window.navigator.onLine=true;b.window.navigator.connection.saveData=true;await b.tick();b.window.navigator.connection.saveData=false;
  b.document.readyState='loading';await b.tick();b.document.readyState='complete';b.window.navigator.scheduling={isInputPending:()=>true};await b.tick();
  assert.equal(f.calls.length,0);b.window.navigator.scheduling.isInputPending=()=>false;await b.drain();assert.equal((await f.readIndex()).exists,true);
});

test('account changes, configuration replacement and pagehide abandon scheduled work without publication',async t=>{
  for(const mode of ['account','config','pagehide']){
    const {f,b,request}=await setup(t);request();if(mode==='account')f.account('st-user:another');else if(mode==='config')f.configure();else b.window.dispatchEvent(new Event('pagehide'));
    if(b.timers.size)await b.tick();assert.equal(b.timers.size,0);assert.equal(f.uploads,0);
  }
});

test('an interrupted first preservation retains IDB and waits for a later normal read plus cooldown before retrying',async t=>{
  const {f,old,b,request}=await setup(t),before=structuredClone(old.state);request();await b.tick();
  f.hook(call=>call.request.method==='POST'?new Response('{}',{status:503}):undefined);await b.tick();assert.equal(b.timers.size,0);
  request();assert.equal(b.timers.size,0);f.hook(null);b.advance(61000);request();await b.drain();
  assert.deepEqual(old.state,before);assert.deepEqual(await f.open().backup(namespace),legacyPacket());
});

test('pagehide during an in-flight original request cancels transport and prevents later directory publication',async t=>{
  const {f,b,request}=await setup(t);request();await b.tick();let release,entered;
  const started=new Promise(resolve=>{entered=resolve;});f.hook(async call=>{if(call.path.includes('-character-record-')){entered();await new Promise(resolve=>{release=resolve;});}});
  const pending=b.tick();await started;b.window.dispatchEvent(new Event('pagehide'));release();await pending;f.hook(null);
  assert.equal((await f.readIndex()).exists,false);assert.equal(b.timers.size,0);
});

test('ordinary main-thread factory actually schedules preservation and closing the panel does not discard its independent idle job',async t=>{
  const f=await characterNativeFixture(t),old=characterLegacyFixture(t,legacyPacket({optional:false})),b=browser(t,{expose:true});f.configure();
  const store=createCharacterArchiveStore({indexedDB:old.indexedDB,keyRange:old.keyRange,native:{createStorage:f.createStorage}});
  assert.equal(b.timers.size,0);assert.equal((await store.list(namespace)).length,1);assert.equal(b.timers.size,1);assert.equal(f.uploads,0);store.close();
  await b.drain();assert.deepEqual(await f.open().backup(namespace),legacyPacket({optional:false}));
  const next=createCharacterArchiveStore({native:{createStorage:f.createStorage},indexedDB:{open(){assert.fail('native must not reopen legacy');}}});t.after(()=>next.close());
  assert.equal((await next.load(namespace,'old-0')).document.ageStatus,'unknown');
});
