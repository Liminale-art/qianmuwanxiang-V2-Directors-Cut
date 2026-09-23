import test from 'node:test';
import assert from 'node:assert/strict';
import {characterNativeFixture} from './helpers/character-native-fixture.mjs';
const slot='batch-proof',gate=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};
async function fixture(t){const f=await characterNativeFixture(t),refs=[];for(let n=0;n<4;n++)refs.push((await f.storage.preserveImmutable(slot,{n})).reference);f.reset();return Object.assign(f,{refs});}
const isBody=call=>call.request.method==='GET'&&call.path.includes('-'+slot+'-');

test('one immutable batch starts at most four same-slot reads and preserves input order after out-of-order completion',async t=>{
  const f=await fixture(t),entered=gate(),pending=[],signals=[];let active=0,peak=0;
  f.hook(async call=>{if(isBody(call)){const wait=gate();active++;peak=Math.max(peak,active);pending.push(wait);signals.push(call.request.signal);if(pending.length===4)entered.resolve();await wait.promise;active--;}});
  const read=f.storage.readImmutableBatch(f.refs);await entered.promise;assert.equal(peak,4);assert.equal(new Set(signals).size,1);
  for(const wait of pending.reverse())wait.resolve();const results=await read;
  assert.deepEqual(results.map(row=>row.status),Array(4).fill('fulfilled'));assert.deepEqual(results.map(row=>row.value.value.n),[0,1,2,3]);assert.equal(f.uploads,0);assert.equal(f.calls.length,4);
});

test('a queued same-slot write cannot overtake a live immutable read batch',async t=>{
  const f=await fixture(t),entered=gate(),release=gate();let reads=0;
  f.hook(async call=>{if(isBody(call)){if(++reads===4)entered.resolve();await release.promise;}});
  const reading=f.storage.readImmutableBatch(f.refs);await entered.promise;const writing=f.storage.write(slot,{changed:true},{expectedFingerprint:null});
  await new Promise(resolve=>setImmediate(resolve));assert.equal(f.uploads,0);release.resolve();await reading;await writing;
  assert.deepEqual((await f.storage.read(slot)).value,{changed:true});assert.deepEqual((await f.storage.readImmutable(f.refs[0])).value,{n:0});
});

test('missing or tampered immutable bodies fail individually without replacing healthy exact versions',async t=>{
  const f=await fixture(t),name=ref=>[...f.files.keys()].find(key=>key.endsWith('-'+ref.fingerprint+'.json'));
  assert.equal(f.files.delete(name(f.refs[1])),true);const target=name(f.refs[2]);f.files.set(target,f.files.get(target).replace('"n":2','"n":9'));
  const results=await f.storage.readImmutableBatch(f.refs);assert.deepEqual(results.map(row=>row.status),['fulfilled','rejected','rejected','fulfilled']);
  assert.equal(results[1].reason.code,'st_account_storage_missing');assert.equal(results[2].reason.code,'st_account_storage_format');assert.equal(results[0].value.value.n,0);assert.equal(results[3].value.value.n,3);assert.equal(f.uploads,0);
});

test('batch size, aggregate bytes, account and slot are validated before any transport',async t=>{
  const f=await fixture(t),bad=[[],[f.refs[0],,f.refs[1]],[...f.refs,f.refs[0]],f.refs.map(ref=>({...ref,bytes:3*1024*1024})),[{...f.refs[0],scope:'f'.repeat(64)}],[f.refs[0],{...f.refs[1],slot:'another-slot'}]];
  for(const refs of bad){const before=f.calls.length;await assert.rejects(f.storage.readImmutableBatch(refs));assert.equal(f.calls.length,before);}
});

test('reference and option containers are captured before queueing',async t=>{
  const f=await fixture(t),refs=f.refs.map(ref=>({...ref})),options={guard:()=>true};const reading=f.storage.readImmutableBatch(refs,options);
  refs[0].fingerprint='f'.repeat(64);refs.pop();options.guard=()=>false;assert.deepEqual((await reading).map(row=>row.value.value.n),[0,1,2,3]);
});

test('a page guard rejection never starts a batch read',async t=>{
  const f=await fixture(t);await assert.rejects(f.storage.readImmutableBatch(f.refs,{guard:()=>false}),{code:'st_account_storage_scope',writeState:'not_started'});assert.equal(f.calls.length,0);
});

test('account switching during a batch rejects the whole result without returning partial previous-account data',async t=>{
  const f=await fixture(t),entered=gate(),release=gate();let count=0;
  f.hook(async call=>{if(isBody(call)){if(++count===4)entered.resolve();await release.promise;}});
  const reading=f.storage.readImmutableBatch(f.refs);await entered.promise;f.account('st-user:other');release.resolve();
  await assert.rejects(reading,{code:'st_account_storage_account',writeState:'not_started'});assert.equal(f.calls.length,4);assert.equal(f.uploads,0);
});

for(const mode of ['abort','close','timeout'])test(`batch ${mode} terminates ignored network signals without retries or writes`,async t=>{
  const f=await fixture(t),store=await f.createStorage({timeoutMs:100}),entered=gate(),controller=new AbortController();t.after(()=>store.close());let count=0;
  f.hook(call=>{if(isBody(call)){if(++count===4)entered.resolve();return new Promise(()=>{});}});
  const reading=store.readImmutableBatch(f.refs,{signal:controller.signal});await entered.promise;if(mode==='abort')controller.abort();if(mode==='close')store.close();
  await assert.rejects(reading,error=>error.writeState==='not_started');assert.equal(f.calls.length,4);assert.equal(f.uploads,0);
});
