import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {encodeGalleryArchiveRecipe as encode,inspectGalleryArchiveRecipe as inspect} from '../qianmu-gallery-archive-recipe.js';
import {createGalleryArchiveStorage} from '../qianmu-gallery-archive-storage.js';
import {streamCheckpointTransport} from './helpers/stream-checkpoint-fixture.mjs';
const sha=text=>createHash('sha256').update(text).digest('hex');
const scope={namespace:'st-user:fixture',ownerKey:'char:Alice.png',chatKey:'chat'};
const reference={version:1,id:'a'.repeat(64)+'-12345678-1234-4123-8123-123456789abc',sha256:'a'.repeat(64),bytes:123};
const record=()=>({id:'one',createdAt:1,chatKey:'chat',url:'/user/images/one.png',snapshotServerRef:{...reference},unknown:{keep:'raw'}});
const response=()=>({ok:true,version:1,expectedAccount:'st-user:'+sha('fixture'),target:{kind:'character',avatar:'Alice.png',chatId:'chat'},
  selection:{recordId:'one',createdAt:1,gallerySha256:sha('source')},reference:{...reference},proof:'read-only-recipe',origin:'server-archive',
  snapshot:{source:'comfy',prompt:' 原提示\r\n',negative:'',profile:{seed:0},payload:{workflow:{nodes:[{id:1}]}},unknown:[false,0,null,'']}});

test('lossless recipe copy binds exact account, record hash, original reference and unknown fields',async()=>{
  const input=record(),recipe=response(),before=structuredClone(input),copy=await encode(scope,input,recipe);
  assert.deepEqual(inspect(scope,copy.record,copy.value).snapshot,recipe.snapshot);assert.deepEqual(input,before);
  assert.equal(copy.value.record.sha256,copy.record.reference.sha256);assert.deepEqual(copy.value.serverReference,reference);
});

test('foreign account, target, selector, origin, proof and changed reference cannot create a copy',async()=>{
  for(const change of [v=>v.expectedAccount='st-user:'+sha('other'),v=>v.target.chatId='other',v=>v.target.avatar='Other.png',
    v=>v.selection.recordId='other',v=>v.selection.createdAt=2,v=>v.origin='saved-inline',v=>v.proof='durable-recipe',
    v=>v.reference.bytes++,v=>v.snapshot.profile.apiKey='never-store']){
    const value=response();change(value);await assert.rejects(encode(scope,record(),value));
  }
  await assert.rejects(encode(scope,{...record(),recipeUnavailable:true},response()));
  await assert.rejects(encode(scope,{...record(),snapshot:response().snapshot},response()));
});

test('reading rejects copies spliced onto another version, namespace, schema or server reference',async()=>{
  const copy=await encode(scope,record(),response());
  for(const change of [v=>v.scope.namespace='st-user:other',v=>v.scope.chatKey='other',v=>v.record.sha256='b'.repeat(64),
    v=>v.serverReference.bytes++,v=>v.schema='other',v=>v.extra=true,v=>v.snapshot.payload.authorization='secret']){
    const value=structuredClone(copy.value);change(value);assert.throws(()=>inspect(scope,copy.record,value));
  }
});

test('native sidecar is immutable; missing copy is explicit and a changed recipe never overwrites the first copy',async()=>{
  const transport=streamCheckpointTransport(scope.namespace),store=await createGalleryArchiveStorage({scope,guard:()=>true,verifyRecord:()=>true,createStorage:transport.createStorage});
  try{
    await assert.rejects(store.preserveServerRecipe(record(),response()),/缺失/);assert.equal(transport.calls.filter(c=>c.options.method==='POST').length,0);
    const saved=await store.preserveRecord(record());assert.equal((await store.readRecipe(saved.reference)).state,'not-preserved');
    await store.preserveServerRecipe(record(),response());const original=[...transport.files];
    const changed=response();changed.snapshot.prompt='different';await assert.rejects(store.preserveServerRecipe(record(),changed),/不同配方/);
    assert.deepEqual([...transport.files],original);assert.deepEqual((await store.readRecipe(saved.reference)).snapshot,response().snapshot);
    const key=[...transport.files.keys()].find(name=>name.endsWith(`gallery-recipe-${saved.reference.sha256}.json`));assert.ok(key);
    transport.files.set(key,'broken');await assert.rejects(store.readRecipe(saved.reference));assert.equal(transport.files.get(key),'broken');
  }finally{store.close();}
});

test('non-approving verifier and account switch prevent sidecar writes',async()=>{
  const transport=streamCheckpointTransport(scope.namespace);let approved=true;
  const store=await createGalleryArchiveStorage({scope,guard:()=>true,verifyRecord:()=>approved,createStorage:transport.createStorage});
  try{
    await store.preserveRecord(record());const count=transport.files.size;approved=false;
    await assert.rejects(store.preserveServerRecipe(record(),response()),/尚未/);assert.equal(transport.files.size,count);
    approved=true;transport.namespace='st-user:other';await assert.rejects(store.preserveServerRecipe(record(),response()));assert.equal(transport.files.size,count);
  }finally{store.close();}
});

test('caller edits during digesting cannot change captured recipe, original record or scope',async()=>{
  const owner={...scope},raw=record(),reply=response(),pending=encode(owner,raw,reply);
  owner.chatKey='changed';raw.id='changed';raw.snapshotServerRef.bytes++;reply.snapshot.prompt='changed';
  const result=await pending;assert.equal(result.value.scope.chatKey,'chat');assert.equal(result.record.value.record.id,'one');
  assert.equal(result.value.serverReference.bytes,reference.bytes);assert.equal(result.value.snapshot.prompt,response().snapshot.prompt);
});

test('last read-back batch reuses its exact record bytes, but freshly reads the recipe sidecar each time',async()=>{
  const transport=streamCheckpointTransport(scope.namespace),store=await createGalleryArchiveStorage({scope,guard:()=>true,verifyRecord:()=>true,createStorage:transport.createStorage});
  try{
    const page=await store.stagePage([record()]),ref=page.records[0].reference;
    assert.equal((await store.readStagedRecipe(ref)).state,'not-preserved');await store.preserveServerRecipe(record(),response());
    const before=transport.calls.length,result=await store.readStagedRecipe(ref);
    assert.equal(transport.calls.length-before,2,'only the recipe native head and body, not the already read-back record');
    assert.deepEqual(result.snapshot,response().snapshot);assert.equal(result.canPrune,false);assert.equal(result.originalVerified,false);
    assert.ok(transport.calls.slice(before).every(call=>call.options.method==='GET'));
    const head=[...transport.files.keys()].find(key=>key.endsWith(`gallery-recipe-${ref.sha256}.json`));transport.files.set(head,'corrupted');
    await assert.rejects(store.readStagedRecipe(ref));assert.equal(transport.files.get(head),'corrupted','never falls back to an in-memory existence claim');
  }finally{store.close();}
});

test('staged recipe reuse rejects injected references, older batches, partial batches and new sessions',async()=>{
  const transport=streamCheckpointTransport(scope.namespace);let approved=true;
  const make=()=>createGalleryArchiveStorage({scope,guard:()=>true,verifyRecord:()=>approved,createStorage:transport.createStorage}),store=await make();
  try{
    const page=await store.stagePage([record()]),ref=page.records[0].reference;
    for(const bad of [{...ref,bytes:ref.bytes+1},{...ref,sha256:'f'.repeat(64)}])await assert.rejects(store.readStagedRecipe(bad),/当前已保全批次/);
    const before=transport.calls.length;const fresh=await make();try{await assert.rejects(fresh.readStagedRecipe(ref),/当前已保全批次/);}finally{fresh.close();}
    assert.equal(transport.calls.length,before);
    await store.stagePage([{...record(),id:'two',createdAt:2}]);await assert.rejects(store.readStagedRecipe(ref),/当前已保全批次/);
    await store.stagePage([record()]);approved=false;await assert.rejects(store.stagePage([{...record(),id:'failed',createdAt:3}]));
    approved=true;await assert.rejects(store.readStagedRecipe(ref),/当前已保全批次/);
  }finally{store.close();}
});

test('a staged recipe cannot bypass source verification or an account switch',async()=>{
  const transport=streamCheckpointTransport(scope.namespace);let approved=true;
  const store=await createGalleryArchiveStorage({scope,guard:()=>true,verifyRecord:()=>approved,createStorage:transport.createStorage});
  try{
    const page=await store.stagePage([record()]),ref=page.records[0].reference;await store.preserveServerRecipe(record(),response());const before=transport.calls.length;
    approved=false;await assert.rejects(store.readStagedRecipe(ref),/尚未/);assert.equal(transport.calls.length,before);
    approved=true;transport.namespace='st-user:another';await assert.rejects(store.readStagedRecipe(ref));
  }finally{store.close();}
});

test('a later batch or explicit cancellation invalidates a paused staged read before native I/O',async()=>{
  const transport=streamCheckpointTransport(scope.namespace);let pause=false,release,started;
  const wait=new Promise(resolve=>release=resolve),ready=new Promise(resolve=>started=resolve);
  const store=await createGalleryArchiveStorage({scope,guard:()=>true,verifyRecord:async value=>{if(pause&&value.id==='one'){started();await wait;}return true;},createStorage:transport.createStorage});
  try{
    const page=await store.stagePage([record()]),ref=page.records[0].reference;pause=true;
    const pending=store.readStagedRecipe(ref);await ready;await store.stagePage([{...record(),id:'next',createdAt:2}]);
    const before=transport.calls.length;release();await assert.rejects(pending,/当前已保全批次/);assert.equal(transport.calls.length,before);
    pause=false;await store.stagePage([record()]);const abort=new AbortController();abort.abort();const calls=transport.calls.length;
    await assert.rejects(store.readStagedRecipe(ref,{signal:abort.signal}),/取消/);assert.equal(transport.calls.length,calls);
  }finally{release();store.close();}
});
