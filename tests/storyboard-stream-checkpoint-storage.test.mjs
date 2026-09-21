import test from 'node:test';
import assert from 'node:assert/strict';
import {createStAccountStorage} from '../qianmu-st-account-storage.js';
import {createStoryboardStreamCheckpointStorage as create} from '../qianmu-storyboard-stream-checkpoint-storage.js';
const owner={namespace:'st-user:checkpoint-fixture',chatKey:'chat-private-name',messageKey:'message',revisionId:'revision',planId:'plan'};
const record=(i=1)=>({version:1,requestId:`request-${i}`,sourceDigest:String(i).repeat(64),prefixLength:10*i,status:'preparing',passes:i,updatedAt:Date.now()});
const response=(value,status=200)=>new Response(typeof value==='string'?value:JSON.stringify(value),{status,headers:{'content-type':'application/json'}});
const gate=()=>{let resolve;return {promise:new Promise(done=>resolve=done),resolve};};
function fixture(){
  const files=new Map(),calls=[];let current=true,namespace=owner.namespace,hook=null,created=0;
  const fetchImpl=async(url,options)=>{
    const path=new URL(url).pathname;calls.push({path,options});if(hook){const result=await hook({path,options,files,calls});if(result)return result;}
    if(path==='/api/files/upload'){const {name,data}=JSON.parse(options.body);files.set(name,Buffer.from(data,'base64').toString('utf8'));return response({path:`/user/files/${name}`});}
    const name=path.split('/').at(-1);return files.has(name)?response(files.get(name)):response({},404);
  };
  const createStorage=async options=>{created++;return createStAccountStorage({...options,fetchImpl,resolveNamespace:async()=>namespace,
    origin:'https://checkpoint.fixture.invalid',headers:()=>({'X-CSRF-Token':'fixture',Authorization:'never-send', 'x-api-key':'never-send'}),timeoutMs:200});};
  return {files,calls,createStorage,create:(scope=owner)=>create({scope,guard:()=>current,createStorage}),get created(){return created;},
    set current(value){current=value;},set namespace(value){namespace=value;},set hook(value){hook=value;}};
}

test('explicit checkpoint clients are lazy until used and persist compact records across independent clients',async()=>{
  const f=fixture(),a=await f.create();assert.equal(f.calls.length,0);const first=record(),receipt=await a.prepare(first);
  assert.equal(receipt.confirmation,'verified-st-file');assert.equal(receipt.concurrency,'optimistic-non-cas');assert.ok(Object.isFrozen(receipt.attempt));a.close();
  const b=await f.create();assert.deepEqual(await b.read(),first);assert.deepEqual((await b.verify(first)).attempt,first);
  const text=[...f.files.values()].join('');assert.doesNotMatch(text,/prompt|apiKey|正文|Authorization/);assert.equal(f.files.size,2);
  assert.ok([...f.files.keys()].every(name=>!name.includes(owner.chatKey)&&!name.includes(owner.namespace)));
  for(const {path,options} of f.calls){assert.ok(path.startsWith('/user/files/')||path==='/api/files/upload');assert.equal(options.headers.Authorization,undefined);assert.equal(options.headers['x-api-key'],undefined);assert.equal(options.redirect,'error');}
  b.close();
});

test('preparing is fully written and read back before a caller can request a model',async()=>{
  const f=fixture(),held=gate(),entered=gate();let savedHead=false,ran=false;
  f.hook=async({path,options})=>{if(path==='/api/files/upload')savedHead=JSON.parse(Buffer.from(JSON.parse(options.body).data,'base64').toString('utf8')).schema==='qianmu.st-account-head.v1';
    else if(savedHead){entered.resolve();await held.promise;}};
  const store=await f.create(),pending=store.prepare(record()).then(()=>{ran=true;});await entered.promise;assert.equal(ran,false);held.resolve();await pending;assert.equal(ran,true);store.close();
});

test('missing settings after a recorded attempt cannot silently claim a fresh request',async()=>{
  const f=fixture(),a=await f.create(),first=record();await a.prepare(first);a.close();const b=await f.create(),before=f.calls.length;
  await assert.rejects(b.prepare(record()),/上次取景记录未核对/);assert.ok(f.calls.slice(before).every(row=>row.options.method==='GET'));assert.deepEqual(await b.read(),first);b.close();
});

test('a verified settled checkpoint advances one round and rejects failed, same-prefix or fourth attempts',async()=>{
  const f=fixture(),store=await f.create();let previous=null;
  for(let i=1;i<=3;i++){const next=record(i);await store.prepare(next,previous);previous=(await store.settle(next,'waiting')).attempt;}
  await assert.rejects(store.prepare(record(4),previous));assert.equal((await store.read()).passes,3);
  const g=fixture(),other=await g.create(),first=record();await other.prepare(first);const failed=(await other.settle(first,'failed')).attempt;
  await assert.rejects(other.prepare(record(2),failed),/顺序无效/);store.close();other.close();
});

test('same-realm concurrent claimants cannot both prepare the same original checkpoint',async()=>{
  const f=fixture(),a=await f.create(),b=await f.create(),results=await Promise.allSettled([a.prepare(record()),b.prepare({...record(),requestId:'different-request'})]);
  assert.equal(results.filter(row=>row.status==='fulfilled').length,1);assert.equal(results.filter(row=>row.status==='rejected').length,1);a.close();b.close();
});

test('late completion cannot replace the next request and cannot erase retained original bodies',async()=>{
  const f=fixture(),store=await f.create(),first=record();await store.prepare(first);const previous=(await store.settle(first,'ready')).attempt;
  const next=record(2);await store.prepare(next,previous);const originals=[...f.files.keys()];await assert.rejects(store.settle(first,'failed'),/已被替换/);
  assert.deepEqual(await store.read(),next);assert.ok(originals.every(key=>f.files.has(key)));store.close();
});

test('invalid scopes, records and extra private payloads fail without uploading',async()=>{
  const f=fixture();for(const scope of [{...owner,namespace:'other'},{...owner,planId:''},{...owner,extra:true}])await assert.rejects(f.create(scope));assert.equal(f.created,0);
  const store=await f.create();for(const bad of [{...record(),extra:'private prose'},{...record(),version:2},{...record(),passes:0},{...record(),status:'ready'}])await assert.rejects(store.prepare(bad));
  assert.equal(f.calls.length,0);store.close();
});

test('future, wrong-owner or corrupted remote records are not overwritten',async()=>{
  for(const mode of ['schema','scope','attempt','null']){
    const f=fixture(),storage=await f.create(),first=record();await storage.prepare(first);
    // Alter via the actual storage transport so the outer content hash remains valid.
    const native=await f.createStorage({isCurrent:()=>true,maxBytes:16384}),name=[...f.files.keys()].find(name=>JSON.parse(f.files.get(name)).schema==='qianmu.st-account-head.v1');
    const head=JSON.parse(f.files.get(name));await native.update(head.slot,value=>{if(mode==='null')return null;if(mode==='schema')value.schema='future';if(mode==='scope')value.scope.chatKey='other';if(mode==='attempt')value.attempt.status='unknown';return value;});
    const before=f.calls.length;await assert.rejects(storage.read());await assert.rejects(storage.prepare(record()));assert.ok(f.calls.slice(before).every(row=>row.options.method==='GET'));
    native.close();storage.close();
  }
});

test('a lost upload acknowledgement never authorizes a model or retries the write',async()=>{
  const f=fixture(),store=await f.create();let posts=0;
  f.hook=({path})=>{if(path==='/api/files/upload'){posts++;throw Error('simulated lost acknowledgement');}};
  await assert.rejects(store.prepare(record()),error=>error.writeState==='unconfirmed');assert.equal(posts,1);store.close();
});

test('account and source changes before readback prevent authorization and keep committed originals',async()=>{
  for(const kind of ['account','source','close']){
    const f=fixture(),store=await f.create();let commits=0;
    f.hook=({path,options,files})=>{if(path==='/api/files/upload'&&++commits===2){const {name,data}=JSON.parse(options.body);files.set(name,Buffer.from(data,'base64').toString('utf8'));
      if(kind==='account')f.namespace='st-user:other';if(kind==='source')f.current=false;if(kind==='close')store.close();return response({path:`/user/files/${name}`});}};
    await assert.rejects(store.prepare(record()));assert.equal(f.files.size,2);store.close();
  }
});

test('a mismatching client account is rejected before file access and the client is closed',async()=>{
  const f=fixture();f.namespace='st-user:other';await assert.rejects(f.create(),/账户不一致/);assert.equal(f.calls.length,0);
});

test('a fabricated or mismatching persistence receipt is not treated as a storage barrier',async()=>{
  const first=record();let value,closes=0;
  const store=await create({scope:owner,guard:()=>true,createStorage:async()=>({namespace:owner.namespace,close:()=>closes++,update:async(_slot,transform)=>{
    value=transform(null,{exists:false});return {exists:true,value,fingerprint:'a'.repeat(64),persistence:'memory',concurrency:'optimistic-non-cas'};}})});
  await assert.rejects(store.prepare(first),/读回未确认/);store.close();assert.equal(closes,1);
});
