import test from 'node:test';
import assert from 'node:assert/strict';
import {createCollectionMigration} from '../qianmu-text-collection-migration.js';
import {scheduleCollectionMigrationSteps} from '../qianmu-text-collection-migration-idle.js';
import {collectionIndexFixture,record,entry,account} from './helpers/collection-index-fixture.mjs';

const make=f=>createCollectionMigration({store:f.storage,expectedAccount:account});
async function finish(job){let result;for(let i=0;i<50;i++){result=await job.step();if(result.done)return result;}assert.fail('migration did not finish');}
function browser(t,{expose=false}={}){
  const window=new EventTarget(),document=new EventTarget(),timers=new Map();let time=0,id=0,stream=null;
  window.Event=Event;window.navigator={onLine:true,connection:{saveData:false}};
  window.SillyTavern={getContext:()=>({streamingProcessor:stream})};document.hidden=false;document.readyState='complete';
  window.setTimeout=(fn,ms)=>{timers.set(++id,{fn,at:time+ms});return id;};window.clearTimeout=id=>timers.delete(id);
  if(expose){const a=Object.getOwnPropertyDescriptor(globalThis,'window'),b=Object.getOwnPropertyDescriptor(globalThis,'document');
    Object.defineProperty(globalThis,'window',{value:window,configurable:true});Object.defineProperty(globalThis,'document',{value:document,configurable:true});
    t.after(()=>{window.dispatchEvent(new Event('pagehide'));if(a)Object.defineProperty(globalThis,'window',a);else delete globalThis.window;if(b)Object.defineProperty(globalThis,'document',b);else delete globalThis.document;});
    t.mock.method(Date,'now',()=>time);
  }
  return {window,document,timers,now:()=>time,stream:value=>{stream=value;},advance:ms=>{time+=ms;},
    async tick(){const pair=timers.entries().next().value;assert.ok(pair,'expected scheduled work');const [id,{fn,at}]=pair;timers.delete(id);time=Math.max(time,at);await fn();},
    async drain(){for(let i=0;timers.size&&i<50;i++)await this.tick();assert.equal(timers.size,0);}};
}

test('migration preserves one complete original per step and publishes only after all are verified',async t=>{
  const records=Array.from({length:5},(_,i)=>record(i+1,'全文😀\r\n'.repeat(22000)+i)),f=await collectionIndexFixture(t,records,{version:1}),before=await f.readIndex(),oldFiles=new Map(f.files),job=make(f);
  f.reset();assert.deepEqual(await job.step(),{done:false,processed:0,total:5});assert.equal(f.uploads,0);
  for(let i=0;i<5;i++){const start=f.uploads,result=await job.step();assert.equal(result.processed,i+1);assert.equal(f.uploads-start,1);assert.equal((await f.readIndex()).fingerprint,before.fingerprint);}
  const result=await job.step();assert.deepEqual(result,{done:true,changed:true});assert.equal(f.uploads,7);
  const next=await f.readIndex();assert.equal(next.value.version,2);assert.equal(next.value.revision,before.value.revision);assert.ok(JSON.stringify(next.value).length<9000);
  for(const [name,value]of oldFiles)if(name.endsWith('-collections.json'))continue;else assert.equal(f.files.get(name),value);
  const client=await f.open();assert.deepEqual((await client.snapshot()).backup.records,records);assert.deepEqual(await job.step(),{done:true});
});

test('tombstones, receipts, historical migration metadata and complete source identity survive conversion',async t=>{
  const f=await collectionIndexFixture(t,[record(1),record(2)],{version:1}),client=await f.open();
  const request=client.prepareEdit(record(1).id,1,'已编辑\r\n保留全部'),receipt=await request.submit();await client.prepareDelete(record(2).id,1).submit();
  const prior=await f.readIndex();prior.value.migration={source:'legacy',checkedAt:41,records:2,extra:{kept:true}};await f.writeIndex(prior.value);
  const source=(await f.readIndex()).value;f.reset();await finish(make(f));const result=(await f.readIndex()).value;
  assert.equal(f.uploads,3);assert.deepEqual(result.receipts,source.receipts);assert.deepEqual(result.migration,source.migration);assert.deepEqual(result.entries[1],source.entries[1]);
  const other=await f.open();assert.equal((await other.get(record(1).id)).record.text,'已编辑\r\n保留全部');assert.equal((await other.inventory()).deletedCount,1);
  assert.deepEqual(await request.submit(),receipt,'a pre-upgrade operation reconciles its unchanged receipt');
});

test('v1 with unknown root metadata is left intact before any original upload',async t=>{
  const f=await collectionIndexFixture(t,[record(1)],{version:1}),source=await f.readIndex();source.value.unknownOldField={text:'不可丢弃'};await f.writeIndex(source.value);f.reset();
  await assert.rejects(make(f).step(),{code:'text_collection_sync_layout'});assert.equal(f.uploads,0);assert.deepEqual((await f.readIndex()).value,source.value);
});

test('an exact changed source head rejects migration even when its revision number was unchanged',async t=>{
  const f=await collectionIndexFixture(t,[record(1)],{version:1}),job=make(f);await job.step();await job.step();
  const newer=await f.readIndex();newer.value.entries[0]=entry(record(1,'较新但版本号相同的完整资料'));await f.writeIndex(newer.value);f.reset();
  await assert.rejects(job.step(),{code:'st_account_storage_conflict'});assert.equal(f.uploads,0);assert.deepEqual((await f.readIndex()).value,newer.value);
});

test('foreground edit during migration remains usable and the changed v1 source cannot be replaced',async t=>{
  const f=await collectionIndexFixture(t,[record(1),record(2)],{version:1}),client=await f.open(),job=make(f);await job.step();await job.step();
  await client.prepareEdit(record(2).id,1,'新的编辑').submit();assert.equal((await client.list()).total,2);await job.step();
  await assert.rejects(job.step(),{code:'st_account_storage_conflict'});const current=await f.readIndex();assert.equal(current.value.version,1);assert.equal(current.value.entries[1].record.text,'新的编辑');
});

test('preservation failure retains v1 and later pass reuses already verified originals',async t=>{
  const f=await collectionIndexFixture(t,[record(1),record(2)],{version:1}),source=await f.readIndex(),job=make(f);await job.step();await job.step();
  f.hook(call=>{if(call.request.method==='POST')return new Response('{}',{status:503});});await assert.rejects(job.step());f.hook(null);
  assert.equal((await f.readIndex()).fingerprint,source.fingerprint);f.reset();await finish(make(f));assert.equal(f.uploads,3,'one remaining original + index body/head, not two original uploads');
});

test('lost original acknowledgement never publishes a partial index and exact retry does not upload it twice',async t=>{
  const f=await collectionIndexFixture(t,[record(1)],{version:1}),job=make(f);await job.step();
  let once=true;f.hook(call=>{if(once&&call.request.method==='POST'){once=false;const {name,data}=JSON.parse(call.request.body);f.files.set(name,Buffer.from(data,'base64').toString('utf8'));throw Error('lost original acknowledgement');}});
  await assert.rejects(job.step(),e=>e.writeState==='unconfirmed');f.hook(null);assert.equal((await f.readIndex()).value.version,1);
  f.reset();await finish(make(f));assert.equal(f.uploads,2,'only the final index is uploaded');
});

test('lost final head acknowledgement leaves a complete v2 library, next pass only verifies it',async t=>{
  const f=await collectionIndexFixture(t,[record(1)],{version:1}),job=make(f);await job.step();await job.step();f.loseIndexAck();
  await assert.rejects(job.step(),e=>e.writeState==='unconfirmed');assert.equal((await f.readIndex()).value.version,2);
  f.reset();assert.deepEqual(await finish(make(f)),{done:true,changed:false});assert.equal(f.uploads,0);assert.deepEqual((await (await f.open()).get(record(1).id)).record,record(1));
});

for(const mode of ['close','guard','account'])test(`migration ${mode} between originals stops without publishing a partial library`,async t=>{
  const f=await collectionIndexFixture(t,[record(1),record(2)],{version:1});let current=true;
  const job=createCollectionMigration({store:f.storage,expectedAccount:account,check:()=>current});await job.step();await job.step();f.reset();
  if(mode==='close')job.close();else if(mode==='guard')current=false;else f.setAccount('st-user:someone-else');
  await assert.rejects(job.step());assert.equal(f.uploads,0);
});

test('idle worker serializes steps, waits for user quiet, and removes timers when done',async t=>{
  const b=browser(t);let count=0,finished=0;
  const stop=scheduleCollectionMigrationSteps({...b,isCurrent:()=>true,step:async()=>({done:++count===2}),onFinish:()=>finished++});
  assert.equal(count,0);await b.tick();assert.equal(count,1);b.document.dispatchEvent(new Event('input'));await b.tick();assert.equal(count,1);await b.tick();assert.equal(count,2);
  assert.equal(b.timers.size,0);assert.equal(finished,1);stop();assert.equal(finished,1);
});

test('idle worker respects hidden, offline, saving-data, streaming, loading and pending input gates',async t=>{
  const b=browser(t);let busy=false,count=0;
  scheduleCollectionMigrationSteps({...b,isCurrent:()=>true,isBusy:()=>busy,step:async()=>{count++;return {done:true};}});
  b.document.hidden=true;await b.tick();b.document.hidden=false;b.window.navigator.onLine=false;await b.tick();b.window.navigator.onLine=true;
  b.window.navigator.connection.saveData=true;await b.tick();b.window.navigator.connection.saveData=false;busy=true;await b.tick();busy=false;
  b.document.readyState='loading';await b.tick();b.document.readyState='complete';b.window.navigator.scheduling={isInputPending:()=>true};await b.tick();
  assert.equal(count,0);b.window.navigator.scheduling.isInputPending=()=>false;await b.tick();assert.equal(count,1);
});

test('pagehide and expired lifecycle stop idle work before a single file read',async t=>{
  for(const mode of ['pagehide','scope']){const b=browser(t);let live=true,count=0;
    scheduleCollectionMigrationSteps({...b,isCurrent:()=>live,step:async()=>{count++;return {done:false};}});
    if(mode==='pagehide')b.window.dispatchEvent(new Event('pagehide'));else{live=false;await b.tick();}
    assert.equal(count,0);assert.equal(b.timers.size,0);}
});

test('a busy idle callback yields without reading and cancellation removes the queued callback',async t=>{
  const b=browser(t),callbacks=new Map();let id=0,count=0;
  b.window.requestIdleCallback=fn=>{callbacks.set(++id,fn);return id;};b.window.cancelIdleCallback=id=>callbacks.delete(id);
  const stop=scheduleCollectionMigrationSteps({...b,isCurrent:()=>true,step:async()=>{count++;return {done:true};}});
  await b.tick();const first=callbacks.get(1);callbacks.delete(1);await first({timeRemaining:()=>1});assert.equal(count,0);await b.tick();assert.equal(callbacks.size,1);
  stop();assert.equal(callbacks.size,0);assert.equal(count,0);assert.equal(b.timers.size,0);
});

test('a pagehide while an original response is pending cannot start any subsequent upload',async t=>{
  const b=browser(t,{expose:true}),f=await collectionIndexFixture(t,[record(1),record(2)],{version:1}),client=await f.open();await client.list();await b.tick();
  let release,entered;const wait=new Promise(resolve=>{release=resolve;}),started=new Promise(resolve=>{entered=resolve;});
  f.hook(async call=>{if(call.path.includes('-collection-record-')){entered();await wait;}});
  const pending=b.tick();await started;b.window.dispatchEvent(new Event('pagehide'));const count=f.uploads;release();await pending;
  assert.equal(f.uploads,count);assert.equal(b.timers.size,0);f.hook(null);assert.equal((await f.readIndex()).value.version,1);
});

test('actual native list schedules but never waits for migration, which outlives panel close without duplicate jobs',async t=>{
  const b=browser(t,{expose:true}),f=await collectionIndexFixture(t,[record(1),record(2)],{version:1}),first=await f.open();
  assert.equal((await first.list()).total,2);assert.equal(f.uploads,0);assert.equal(f.calls.length,2);assert.equal(b.timers.size,1);first.close();
  const other=await f.open();await other.list({cursor:null,limit:50},{preferCache:true});assert.equal(b.timers.size,1);assert.equal(f.calls.length,2);
  await b.drain();assert.equal((await f.readIndex()).value.version,2);f.reset();await other.list();assert.equal(f.bodyReads,0);assert.equal(f.calls.length,2);
  assert.deepEqual((await other.get(record(1).id)).record,record(1));assert.equal(f.bodyReads,1);
});

test('background host pauses during streaming and resumes one original at a time',async t=>{
  const b=browser(t,{expose:true}),f=await collectionIndexFixture(t,[record(1)],{version:1}),client=await f.open();await client.list();f.reset();
  b.stream({isStopped:false,isFinished:false});await b.tick();assert.equal(f.calls.length,0);
  b.stream({isFinished:true});await b.tick();assert.equal(f.uploads,0);await b.tick();assert.equal(f.uploads,1);await b.tick();assert.equal(f.uploads,3);
});

test('local edit invalidates in-flight migration; a later quiet read retries exact preserved originals',async t=>{
  const b=browser(t,{expose:true}),f=await collectionIndexFixture(t,[record(1),record(2)],{version:1}),client=await f.open();await client.list();await b.tick();await b.tick();
  await client.prepareEdit(record(2).id,1,'用户正在修改').submit();const before=f.uploads;await b.tick();assert.equal(f.uploads,before);assert.equal(b.timers.size,0);assert.equal((await f.readIndex()).value.version,1);
  await client.list();assert.equal(b.timers.size,0,'no immediate automatic network retry');b.advance(61000);await client.list();f.reset();await b.drain();assert.equal(f.uploads,3);
  assert.equal((await client.get(record(2).id)).record.text,'用户正在修改');
});

for(const mode of ['account','configuration','pagehide'])test(`background ${mode} change discards remaining migration work`,async t=>{
  const b=browser(t,{expose:true}),f=await collectionIndexFixture(t,[record(1),record(2)],{version:1}),client=await f.open();await client.list();await b.tick();await b.tick();f.reset();
  if(mode==='account')f.setAccount('st-user:another');else if(mode==='configuration')f.reconfigure();else b.window.dispatchEvent(new Event('pagehide'));
  if(b.timers.size)await b.tick();assert.equal(f.uploads,0);assert.equal(b.timers.size,0);
});
