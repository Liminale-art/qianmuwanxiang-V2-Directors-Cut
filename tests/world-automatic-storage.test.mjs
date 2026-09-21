import test from 'node:test';
import assert from 'node:assert/strict';
import {streamCheckpointTransport} from './helpers/stream-checkpoint-fixture.mjs';
import {createWorldAutomaticStorage as create} from '../qianmu-world-automatic-storage.js';
import {normalizeWorldAutomaticApproval} from '../qianmu-world-automatic-approval.js';
const scope={namespace:'st-user:world-test',source:{schema:'qianmu.world-source.v1',chatKey:'chat-a',revisionId:'wrev-'+'a'.repeat(64),field:'npc_updates',itemId:'witem-'+'b'.repeat(64)}};
const record=()=>({version:1,requestId:'wa-'+'c'.repeat(32),status:'preparing',updatedAt:100});
const gate=()=>{let resolve;return {promise:new Promise(done=>resolve=done),resolve};};
function fixture(){
  const transport=streamCheckpointTransport(scope.namespace);let current=true;
  return {...transport,transport,create:owner=>create({scope:owner||scope,guard:()=>current,createStorage:transport.createStorage}),set current(value){current=value;}};
}

test('world claim is lazy, compact and readable by a fresh client; neither prose nor engine settings are stored',async()=>{
  const f=fixture(),a=await f.create();assert.equal(f.calls.length,0);assert.equal(await a.read(),null);
  const saved=await a.prepare(record());assert.equal(saved.confirmation,'verified-st-file');assert.equal(saved.concurrency,'optimistic-non-cas');
  assert.deepEqual(normalizeWorldAutomaticApproval(saved.approval),saved.approval);assert.deepEqual(saved.approval.source,scope.source);
  for(const value of [saved,saved.record,saved.approval,saved.approval.source])assert.ok(Object.isFrozen(value));
  const queued=await a.settle(record(),'queued');a.close();const b=await f.create();assert.deepEqual(await b.read(),queued.record);b.close();
  assert.doesNotMatch([...f.files.values()].join(''),/prompt|apiKey|mes"|floor|engine|model|endpoint/);
  for(const row of f.calls){assert.equal(row.options.credentials,'same-origin');assert.equal(row.options.redirect,'error');assert.ok(row.path==='/api/files/upload'||row.options.method==='GET');}
});

test('world claim authorizes no work until both ST head and body have been read back',async()=>{
  const f=fixture(),entered=gate(),held=gate();let head=false,finished=false;
  f.transport.hook=async({path,options})=>{if(path==='/api/files/upload')head=JSON.parse(Buffer.from(JSON.parse(options.body).data,'base64').toString()).schema==='qianmu.st-account-head.v1';
    else if(head){entered.resolve();await held.promise;}};
  const a=await f.create(),pending=a.prepare(record()).then(()=>finished=true);await entered.promise;assert.equal(finished,false);held.resolve();await pending;a.close();
});

for(const status of ['preparing','queued','failed','cancelled'])test(`world ${status} survives a reload and never permits a second automatic request`,async()=>{
  const f=fixture(),a=await f.create();await a.prepare(record());if(status!=='preparing')await a.settle(record(),status);a.close();
  const b=await f.create(),before=f.calls.length;await assert.rejects(b.prepare({...record(),requestId:'wa-'+'d'.repeat(32)}),/已有自动尝试/);
  assert.ok(f.calls.slice(before).every(row=>row.options.method==='GET'));assert.equal((await b.read()).status,status);b.close();
});

test('world slots are bound to every source dimension, independent of prompt, model or output settings',async()=>{
  const f=fixture(),a=await f.create();await a.prepare(record());const originalFiles=[...f.files.keys()];
  for(const patch of [{chatKey:'chat-b'},{revisionId:'wrev-'+'d'.repeat(64)},{field:'world_updates'},{itemId:'witem-'+'e'.repeat(64)}]){
    const b=await f.create({...scope,source:{...scope.source,...patch}});assert.equal(await b.read(),null);await b.prepare(record());b.close();
  }
  assert.ok(originalFiles.every(key=>f.files.has(key)));await assert.rejects(a.prepare(record()),/已有自动尝试/);a.close();
});

test('same-realm concurrent world clients have one claim winner; late settlement never overwrites it',async()=>{
  const f=fixture(),a=await f.create(),b=await f.create(),results=await Promise.allSettled([a.prepare(record()),b.prepare({...record(),requestId:'wa-'+'d'.repeat(32)})]);
  assert.equal(results.filter(result=>result.status==='fulfilled').length,1);const saved=await a.read(),queued=await a.settle(saved,'queued');
  await assert.rejects(b.settle(saved,'failed'),/已变化/);assert.deepEqual(await b.read(),queued.record);a.close();b.close();
});

test('invalid scopes and record payloads fail before any ST request; nothing is silently truncated',async()=>{
  const f=fixture();for(const invalid of [{...scope,namespace:'other'},{...scope,namespace:'st-user:\u007f'},{...scope,private:'text'},
    {...scope,source:{...scope.source,body:'text'}},{...scope,source:{...scope.source,chatKey:'x'.repeat(513)}},{...scope,source:{...scope.source,schema:'future'}}])await assert.rejects(f.create(invalid));
  const a=await f.create();for(const patch of [{version:2},{requestId:'wa-no'},{updatedAt:0},{updatedAt:Infinity},{updatedAt:1.5},{extra:'private text'},{status:'queued'}])await assert.rejects(a.prepare({...record(),...patch}));
  for(const status of ['preparing','complete','unknown'])await assert.rejects(a.settle(record(),status));
  assert.equal(f.calls.length,0);a.close();
});

test('preparing captures its input before awaiting transport; caller mutations cannot alter the claim',async()=>{
  const f=fixture(),a=await f.create(),entered=gate(),held=gate();f.transport.hook=async()=>{entered.resolve();await held.promise;};
  const first=record(),pending=a.prepare(first);await entered.promise;first.requestId='wa-'+'d'.repeat(32);first.status='queued';held.resolve();
  assert.deepEqual((await pending).record,record());assert.deepEqual(await a.read(),record());a.close();
});

for(const mode of ['lost-body','lost-head','source','account','close'])test(`world ${mode} during saving stops without transport retries or a fabricated success`,async()=>{
  const f=fixture(),a=await f.create();let posts=0;
  f.transport.hook=({path,options,files,json})=>{
    if(path!=='/api/files/upload')return;posts++;const {name,data}=JSON.parse(options.body);files.set(name,Buffer.from(data,'base64').toString());
    if(mode==='lost-body'&&posts===1||mode==='lost-head'&&posts===2)throw Error('lost acknowledgement');
    if(posts===2){if(mode==='source')f.current=false;if(mode==='account')f.transport.namespace='st-user:other';if(mode==='close')a.close();return json({path:`/user/files/${name}`});}
  };
  await assert.rejects(a.prepare(record()));assert.equal(posts,mode==='lost-body'?1:2);a.close();
  if(mode==='lost-head'){f.transport.hook=null;const b=await f.create();assert.equal((await b.read()).status,'preparing');await assert.rejects(b.prepare(record()),/已有自动尝试/);b.close();}
});

test('a lost settlement acknowledgement leaves a blocking claim rather than allowing replay',async()=>{
  const f=fixture(),a=await f.create();await a.prepare(record());let posts=0;
  f.transport.hook=({path})=>{if(path==='/api/files/upload'){posts++;throw Error('unconfirmed');}};
  await assert.rejects(a.settle(record(),'queued'));assert.equal(posts,1);f.transport.hook=null;assert.equal((await a.read()).status,'preparing');
  await assert.rejects(a.prepare(record()),/已有自动尝试/);a.close();
});

test('foreign, future and malformed world documents remain untouched rather than treated as missing',async()=>{
  for(const mode of ['schema','scope','record','null']){
    const f=fixture(),a=await f.create();await a.prepare(record());const native=await f.transport.createStorage({isCurrent:()=>true,maxBytes:16384});
    const head=[...f.files.values()].map(JSON.parse).find(row=>row.schema==='qianmu.st-account-head.v1');
    await native.update(head.slot,value=>{if(mode==='null')return null;if(mode==='schema')value.schema='future';if(mode==='scope')value.scope.source.chatKey='foreign';if(mode==='record')value.record.extra='private';return value;});
    const before=f.calls.length;await assert.rejects(a.read());await assert.rejects(a.prepare(record()));assert.ok(f.calls.slice(before).every(row=>row.options.method==='GET'));native.close();a.close();
  }
});

test('opening under the wrong account or a cancelled guard makes no request and closes the adapter',async()=>{
  const f=fixture();f.current=false;await assert.rejects(f.create());f.current=true;
  await assert.rejects(f.create({...scope,namespace:'st-user:other'}),/账户不一致/);assert.equal(f.calls.length,0);
  const a=await f.create();a.close();a.close();await assert.rejects(a.read());await assert.rejects(a.prepare(record()));assert.equal(f.calls.length,0);
});

test('fabricated memory receipts do not count as durable world claims or proof of a missing record',async()=>{
  const receipt={exists:true,fingerprint:'a'.repeat(64),persistence:'memory',concurrency:'optimistic-non-cas'};
  const a=await create({scope,guard:()=>true,createStorage:async()=>({namespace:scope.namespace,close(){},
    read:async()=>({...receipt,exists:false,fingerprint:null,value:null}),update:async(_slot,transform)=>({...receipt,value:transform(null,{exists:false})})})});
  await assert.rejects(a.prepare(record()),/保存未确认/);await assert.rejects(a.read(),/保存未确认/);a.close();
});
