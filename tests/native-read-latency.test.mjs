import test from 'node:test';
import assert from 'node:assert/strict';
import {performance} from 'node:perf_hooks';
import {createCharacterArchiveSession} from '../qianmu-character-archive-session.js';
import {configureStAccountStorage,captureStAccountStorageWorkerContext,verifyStAccountStorageWorkerContext} from '../qianmu-st-account-storage.js';
import {resolveImageAccountNamespace} from '../qianmu-image-admission.js';
import {characterNativeFixture,namespace,document} from './helpers/character-native-fixture.mjs';

const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const origin='https://st.fixture.invalid',rtt=35;

test('cold character selection removes one serial catalogue body RTT, not authorization or native validation',async t=>{
 const f=await characterNativeFixture(t);await f.open().save(namespace,{document:document()});
 const snapshots=[];
 for(const oldAdapter of [true,false]){
  const store=createCharacterArchiveSession({requestMigration:()=>{},createLocal:()=>assert.fail('native selection must not open IDB'),
   createStorage:async options=>{const client=await f.createStorage(options);return oldAdapter?{...client,readFingerprint:undefined}:client;}});
  t.after(()=>store.close());f.reset();let active=0,peak=0;
  f.hook(async()=>{active++;peak=Math.max(peak,active);await sleep(rtt);active--;});
  const start=performance.now(),result=await store.overview(namespace),elapsed=performance.now()-start;
  assert.equal(result.rows[0].name,'Alice');assert.equal(f.uploads,0);assert.equal(peak,1);
  snapshots.push({requests:f.calls.length,elapsed,bodies:f.calls.filter(row=>/-character-library-[a-f0-9]{64}\.json$/.test(row.path)).length});
  store.close();
 }
 assert.deepEqual(snapshots.map(row=>row.requests),[4,3]);assert.deepEqual(snapshots.map(row=>row.bodies),[2,1]);
 assert.ok(snapshots[1].elapsed< snapshots[0].elapsed-rtt*.5,JSON.stringify({rtt,snapshots}));
 t.diagnostic(JSON.stringify({scope:'synthetic sequential ST GETs',rttMs:rtt,before:snapshots[0],after:snapshots[1]}));
});

test('Worker live verification uses one uncached identity RTT per guard, without repeating a CSRF handoff',async t=>{
 let requests=0,headers=0;
 const options={origin,isCurrent:()=>true,headers:()=>{headers++;return {'X-CSRF-Token':'synthetic'};},
  resolveNamespace:()=>resolveImageAccountNamespace({loadUser:async()=>({currentUser:null}),fetchImpl:async(path,request)=>{
   assert.equal(path,'/api/users/me');assert.equal(request.cache,'no-store');requests++;await sleep(rtt);return Response.json({handle:'latency-fixture'});
  }})};
 configureStAccountStorage(options);const context=await captureStAccountStorageWorkerContext(),results=[];
 for(const legacyCapture of [true,false]){
  requests=0;headers=0;const start=performance.now();
  for(let n=0;n<3;n++)if(legacyCapture)assert.deepEqual(await captureStAccountStorageWorkerContext(),context);else assert.equal(await verifyStAccountStorageWorkerContext(context),true);
  results.push({elapsed:performance.now()-start,requests,headers});
 }
 assert.deepEqual(results.map(row=>row.requests),[6,3]);assert.deepEqual(results.map(row=>row.headers),[3,0]);
 assert.ok(results[1].elapsed<results[0].elapsed*.8,JSON.stringify({rtt,results}));
 t.diagnostic(JSON.stringify({scope:'synthetic authenticated identity GETs',rttMs:rtt,before:results[0],after:results[1]}));
});

test('live Worker verification rejects account, origin, lifecycle and configuration changes after delayed identity resolution',async()=>{
 for(const mode of ['account','origin','lifecycle','reconfigured']){
  let active=true,owner=namespace,finish;const waiting=new Promise(resolve=>finish=resolve);
  const settings={origin,isCurrent:()=>active,headers:()=>assert.fail('a guard must not capture secrets again'),resolveNamespace:async()=>{await waiting;return owner;}};
  configureStAccountStorage(settings);const result=verifyStAccountStorageWorkerContext({namespace,origin:mode==='origin'?'https://other.invalid':origin});
  if(mode==='account')owner='st-user:other';if(mode==='lifecycle')active=false;if(mode==='reconfigured')configureStAccountStorage({...settings});
  finish();await assert.rejects(result,error=>/^st_account_storage_(?:account|scope)$/.test(error.code));
 }
 let reads=0;configureStAccountStorage({origin,isCurrent:()=>true,headers:()=>({}),resolveNamespace:async()=>{reads++;return reads===1?namespace:'st-user:changed';}});
 assert.equal(await verifyStAccountStorageWorkerContext({namespace,origin}),true);
 await assert.rejects(verifyStAccountStorageWorkerContext({namespace,origin}));assert.equal(reads,2,'successful guard is never cached as authorization');
});
