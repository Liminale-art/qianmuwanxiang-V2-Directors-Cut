import test from 'node:test';
import assert from 'node:assert/strict';
import {streamCheckpointTransport} from './helpers/stream-checkpoint-fixture.mjs';
import {createStoryboardStreamFinalStorage as create} from '../qianmu-storyboard-stream-final-storage.js';
const scope={namespace:'st-user:final-test',chatKey:'chat',messageKey:'message',revisionId:'original',planId:'original-plan',sourceRevisionId:'finished-1'};
const record=(revision='finished-1')=>({version:1,sourceRevisionId:revision,requestId:'request-1',status:'preparing',updatedAt:Date.now()});
const gate=()=>{let resolve;return {promise:new Promise(done=>resolve=done),resolve};};
function fixture(){
  const transport=streamCheckpointTransport(scope.namespace);let current=true;
  return {...transport,transport,create:owner=>create({scope:owner||scope,guard:()=>current,createStorage:transport.createStorage}),set current(value){current=value;}};
}

test('final claims are lazy, compact, durable and recoverable without preserving prompts or message bodies',async()=>{
  const f=fixture(),a=await f.create(),first=record();assert.equal(f.calls.length,0);
  const saved=await a.prepare(first);assert.equal(saved.confirmation,'verified-st-file');assert.ok(Object.isFrozen(saved.record));
  const settled=await a.settle(first,'complete');a.close();const b=await f.create();assert.deepEqual(await b.read(),settled.record);
  assert.equal(settled.concurrency,'optimistic-non-cas');assert.doesNotMatch([...f.files.values()].join(''),/prompt|apiKey|mes"/);
  for(const {options} of f.calls){assert.equal(options.credentials,'same-origin');assert.equal(options.redirect,'error');}b.close();
});

test('a final claim cannot authorize a caller until its head and body have been read back',async()=>{
  const f=fixture(),entered=gate(),held=gate();let head=false,finished=false;
  f.transport.hook=async({path,options})=>{if(path==='/api/files/upload')head=JSON.parse(Buffer.from(JSON.parse(options.body).data,'base64').toString()).schema==='qianmu.st-account-head.v1';
    else if(head){entered.resolve();await held.promise;}};
  const a=await f.create(),pending=a.prepare(record()).then(()=>finished=true);await entered.promise;assert.equal(finished,false);held.resolve();await pending;a.close();
});

for(const status of ['preparing','complete','failed','cancelled'])test(`lost local final ${status} marker never turns a saved claim into a fresh request`,async()=>{
  const f=fixture(),a=await f.create(),first=record();await a.prepare(first);if(status!=='preparing')await a.settle(first,status);a.close();
  const b=await f.create(),before=f.calls.length;await assert.rejects(b.prepare({...record(),requestId:'new-request'}),/已有取景记录/);
  assert.ok(f.calls.slice(before).every(row=>row.options.method==='GET'));assert.equal((await b.read()).status,status);b.close();
});

test('distinct finished continuations retain their separate claims under the same original plan',async()=>{
  const f=fixture(),a=await f.create(),first=record();await a.prepare(first);await a.settle(first,'complete');const oldKeys=[...f.files.keys()];
  const b=await f.create({...scope,sourceRevisionId:'finished-2'}),second=record('finished-2');await b.prepare(second);await b.settle(second,'complete');
  assert.equal((await a.read()).sourceRevisionId,'finished-1');assert.equal((await b.read()).sourceRevisionId,'finished-2');assert.ok(oldKeys.every(key=>f.files.has(key)));
  await assert.rejects(a.prepare(record()),/已有取景记录/);a.close();b.close();
});

test('same-realm competing final claimants have one winner and late settlement cannot replace a completed record',async()=>{
  const f=fixture(),a=await f.create(),b=await f.create(),first=record();
  const results=await Promise.allSettled([a.prepare(first),b.prepare({...first,requestId:'second'})]);assert.equal(results.filter(row=>row.status==='fulfilled').length,1);
  const claimed=await a.read(),completed=await a.settle(claimed,'complete');await assert.rejects(b.settle(claimed,'failed'),/已变化/);assert.deepEqual(await b.read(),completed.record);a.close();b.close();
});

test('invalid scopes, extra payloads, future records and revision mismatches never reach the transport',async()=>{
  const f=fixture();for(const owner of [{...scope,namespace:'other'},{...scope,sourceRevisionId:''},{...scope,private:'prose'}])await assert.rejects(f.create(owner));
  const a=await f.create();for(const value of [{...record(),extra:'private prose'},{...record(),version:2},record('other'),{...record(),requestId:'bad\nrequest'},{...record(),status:'complete'}])await assert.rejects(a.prepare(value));
  assert.equal(f.calls.length,0);a.close();
});

test('lost acknowledgements are not retried and source/account changes cannot confirm a final claim',async()=>{
  for(const mode of ['lost','source','account','close']){
    const f=fixture(),a=await f.create();let posts=0;
    f.transport.hook=({path,options,files,json})=>{
      if(path!=='/api/files/upload')return;posts++;if(mode==='lost')throw Error('lost acknowledgement');
      if(posts===2){const {name,data}=JSON.parse(options.body);files.set(name,Buffer.from(data,'base64').toString());
        if(mode==='source')f.current=false;if(mode==='account')f.transport.namespace='st-user:other';if(mode==='close')a.close();return json({path:`/user/files/${name}`});}
    };
    await assert.rejects(a.prepare(record()));assert.equal(posts,mode==='lost'?1:2);a.close();
  }
});

test('malformed or foreign remote final records are left untouched',async()=>{
  for(const mode of ['schema','scope','record','null']){
    const f=fixture(),a=await f.create();await a.prepare(record());const native=await f.transport.createStorage({isCurrent:()=>true,maxBytes:16384});
    const head=[...f.files.values()].map(JSON.parse).find(row=>row.schema==='qianmu.st-account-head.v1');
    await native.update(head.slot,value=>{if(mode==='null')return null;if(mode==='schema')value.schema='future';if(mode==='scope')value.scope.planId='foreign';if(mode==='record')value.record.extra='private';return value;});
    const before=f.calls.length;await assert.rejects(a.prepare(record()));assert.ok(f.calls.slice(before).every(row=>row.options.method==='GET'));native.close();a.close();
  }
});

test('a fabricated in-memory receipt never counts as a verified ST final claim',async()=>{
  const a=await create({scope,guard:()=>true,createStorage:async()=>({namespace:scope.namespace,close(){},update:async(_slot,transform)=>({value:transform(null,{exists:false}),exists:true,fingerprint:'a'.repeat(64),persistence:'memory',concurrency:'optimistic-non-cas'})})});
  await assert.rejects(a.prepare(record()),/读回未确认/);a.close();
});
