import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {setImmediate as flush} from 'node:timers/promises';
import {createQianmuReleaseVersionReader} from '../qianmu-release-version.js';
import {storyboardFunctionSource as section} from './helpers/storyboard-form-fixture.mjs';
const official={remoteUrl:'https://github.com/Liminale-art/qianmuwanxiang-V2-Directors-Cut.git',currentBranchName:'codex/phase-1'};
const response=(version='1.59.384',extra={})=>new Response(JSON.stringify({name:'qianmu-omniscene',version,...extra}));

test('release lookup uses the ST-verified official branch without credentials, redirects or request headers',async()=>{
  const requests=[],read=createQianmuReleaseVersionReader({fetchImpl:async(url,init)=>{requests.push({url,init});return response();}});
  assert.equal(await read(official),'1.59.384');assert.equal(requests.length,1);
  const {url,init}=requests[0];assert.equal(url,'https://raw.githubusercontent.com/Liminale-art/qianmuwanxiang-V2-Directors-Cut/codex%2Fphase-1/package.json');
  assert.equal(init.method,'GET');assert.equal(init.credentials,'omit');assert.equal(init.referrerPolicy,'no-referrer');assert.equal(init.redirect,'error');assert.equal(init.headers,undefined);assert.ok(init.signal);
});

test('unverified repositories, missing branches and malformed refs never cause a release request',async()=>{
  let calls=0;const read=createQianmuReleaseVersionReader({fetchImpl:async()=>{calls++;return response();}});
  for(const remoteUrl of ['',undefined,'https://evil.invalid/Liminale-art/qianmuwanxiang-V2-Directors-Cut.git','https://github.com/other/fork.git',official.remoteUrl+'?token=private','https://user:secret@github.com/Liminale-art/qianmuwanxiang-V2-Directors-Cut.git'])assert.equal(await read({...official,remoteUrl}),'');
  for(const currentBranchName of ['',undefined,'../main','main/','codex//main','main?secret','main#hash','main\n','codex/.hidden','main.lock','x'.repeat(201)])assert.equal(await read({...official,currentBranchName}),'');
  assert.equal(calls,0);
});

test('same-branch successful checks are single-flight and cached for thirty minutes',async()=>{
  let now=0,calls=0,finish;const read=createQianmuReleaseVersionReader({now:()=>now,fetchImpl:async()=>{calls++;return new Promise(resolve=>finish=resolve);}});
  const a=read(official),b=read(official);assert.equal(calls,1);finish(response());assert.deepEqual(await Promise.all([a,b]),['1.59.384','1.59.384']);
  now=30*60*1000-1;assert.equal(await read(official),'1.59.384');assert.equal(calls,1);
  now++;const c=read(official);assert.equal(calls,2);finish(response('1.59.384'));assert.equal(await c,'1.59.384');
  assert.equal(await read(official),'1.59.384');assert.equal(calls,2);
});

test('failed checks use a one-minute cache and another branch cannot overwrite the original result',async()=>{
  let now=0,calls=0,finish;const read=createQianmuReleaseVersionReader({now:()=>now,fetchImpl:async()=>{calls++;return new Promise(resolve=>finish=resolve);}});
  const first=read(official);assert.equal(calls,1);finish(new Response('failed',{status:503}));assert.equal(await first,'');
  now=60*1000-1;assert.equal(await read(official),'');assert.equal(calls,1);
  const other=read({...official,currentBranchName:'codex/next'});assert.equal(calls,2);finish(response('1.59.384'));assert.equal(await other,'1.59.384');
  assert.equal(await read(official),'');assert.equal(calls,2);
  now++;const recovered=read(official);assert.equal(calls,3);finish(response('1.59.384'));assert.equal(await recovered,'1.59.384');
  assert.equal(await read(official),'1.59.384');assert.equal(calls,3);
});

test('force bypasses cached results but joins an in-flight check for the same branch',async()=>{
  let now=0,calls=0,finish;const read=createQianmuReleaseVersionReader({now:()=>now,fetchImpl:async()=>{calls++;return new Promise(resolve=>finish=resolve);}});
  const first=read(official),joined=read(official,{force:true});assert.equal(calls,1);
  finish(response('1.59.384'));assert.deepEqual(await Promise.all([first,joined]),['1.59.384','1.59.384']);
  now=1000;const refreshed=read(official,{force:true}),joinedAgain=read(official,{force:true});assert.equal(calls,2);
  finish(response('1.59.384'));assert.deepEqual(await Promise.all([refreshed,joinedAgain]),['1.59.384','1.59.384']);
  assert.equal(await read(official),'1.59.384');assert.equal(calls,2);
  const failed=read(official,{force:true});assert.equal(calls,3);finish(new Response('failed',{status:503}));assert.equal(await failed,'');
  assert.equal(await read(official),'');assert.equal(calls,3);
  const retried=read(official,{force:true});assert.equal(calls,4);finish(response('1.59.385'));assert.equal(await retried,'1.59.385');
});

test('package identity and version are validated without borrowing the installed frontend version',async()=>{
  for(const body of [{name:'different-package',version:'1.59.384'},...['latest','<script>','1.2.3\n','1.2.3-'+ 'a'.repeat(80),{},null].map(version=>({name:'qianmu-omniscene',version}))]){
    const read=createQianmuReleaseVersionReader({fetchImpl:async()=>new Response(JSON.stringify(body))});assert.equal(await read(official),'');
  }
  assert.equal(await createQianmuReleaseVersionReader({fetchImpl:async()=>response('v1.59.384-rc.1+build.2')})(official),'1.59.384-rc.1+build.2');
  assert.equal(await createQianmuReleaseVersionReader({fetchImpl:async()=>new Response('not-json')})(official),'');
});

test('declared or streamed bodies above sixteen KiB are canceled and do not become a latest version',async()=>{
  for(const declared of [true,false]){
    let canceled=false,reads=0;
    const body=new ReadableStream({pull(controller){reads++;controller.enqueue(new Uint8Array(16385));},cancel(){canceled=true;}});
    const read=createQianmuReleaseVersionReader({fetchImpl:async()=>new Response(body,{headers:declared?{'Content-Length':'16385'}:{}})});
    assert.equal(await read(official),'');await flush();assert.equal(canceled,true);assert.ok(reads<=2);
  }
});

test('redirected responses and network failures remain unknown and a stalled fetch stops at its deadline',async()=>{
  const redirected=response();Object.defineProperty(redirected,'redirected',{value:true});
  assert.equal(await createQianmuReleaseVersionReader({fetchImpl:async()=>redirected})(official),'');
  assert.equal(await createQianmuReleaseVersionReader({fetchImpl:async()=>{throw Error('private details');}})(official),'');
  let signal;const read=createQianmuReleaseVersionReader({timeoutMs:10,fetchImpl:(_url,init)=>{signal=init.signal;return new Promise(()=>{});}});
  assert.equal(await read(official),'');assert.equal(signal.aborted,true);
});

function updateFixture(){
  const pending=[],calls={version:0,paint:0,badge:0};
  const context=vm.createContext({AbortController,setTimeout,clearTimeout,Date,
    qianmuUpdateState:{status:'idle',checkedAt:0},qianmuUpdatePromise:null,optionalServiceState:{status:'ready',version:'1.59.384',services:[]},
    ctx:()=>({getRequestHeaders:()=>({'X-CSRF-Token':'synthetic-st-only'})}),qianmuInstalledExtensionName:()=> 'third-party/qianmu',qianmuInstalledExtensionScope:async()=>false,
    fetch:async()=>{calls.version++;return new Response(JSON.stringify({...official,isUpToDate:false}));},
    readQianmuLatestRelease:(info,options)=>new Promise(resolve=>pending.push({info,options,resolve})),
    paintOptionalServiceState:()=>{calls.paint++;},paintQianmuVersionBadge:()=>{calls.badge++;}});
  vm.runInContext(section('refreshQianmuUpdateStatus'),context);return {context,pending,calls};
}

test('the existing update check starts release metadata asynchronously and does not hold health or repeat on cached opens',async()=>{
  const f=updateFixture(),result=await f.context.refreshQianmuUpdateStatus();
  assert.equal(result.status,'ready');assert.equal(f.pending.length,1);assert.equal(f.context.optionalServiceState.latestVersion,'');assert.equal(f.calls.badge,1);
  assert.notEqual(f.pending[0].options?.force,true,'ordinary startup checks may use the version cache');
  assert.equal(f.context.optionalServiceState.status,'ready');assert.equal(f.context.optionalServiceState.version,'1.59.384');
  f.pending[0].resolve('1.59.384');await flush();assert.equal(f.context.optionalServiceState.latestVersion,'1.59.384');
  await f.context.refreshQianmuUpdateStatus();assert.equal(f.calls.version,1);assert.equal(f.pending.length,1);
});

test('superseded release responses cannot overwrite a newer check and failed ST checks leave latest unknown',async()=>{
  const f=updateFixture();await f.context.refreshQianmuUpdateStatus(true);await f.context.refreshQianmuUpdateStatus(true);
  assert.equal(f.pending[0].options?.force,true,'explicit checks must bypass the cached release version');
  assert.equal(f.pending[1].options?.force,true);
  f.pending[1].resolve('1.59.384');await flush();f.pending[0].resolve('1.59.371');await flush();assert.equal(f.context.optionalServiceState.latestVersion,'1.59.384');
  f.context.fetch=async()=>new Response('',{status:503});await f.context.refreshQianmuUpdateStatus(true);
  assert.equal(f.context.optionalServiceState.latestVersion,'');assert.equal(f.pending.length,2);assert.equal(f.context.optionalServiceState.status,'ready');
});

test('a failed ST metadata check is retried after one minute without changing the successful cache lifetime',async()=>{
  const f=updateFixture();f.context.fetch=async()=>{f.calls.version++;throw Error('synthetic offline');};
  await f.context.refreshQianmuUpdateStatus(true);
  assert.equal(f.context.qianmuUpdateState.status,'unknown');assert.equal(f.calls.version,1);
  f.context.qianmuUpdateState.checkedAt=Date.now()-59999;
  await f.context.refreshQianmuUpdateStatus();assert.equal(f.calls.version,1);
  f.context.qianmuUpdateState.checkedAt=Date.now()-60001;
  await f.context.refreshQianmuUpdateStatus();assert.equal(f.calls.version,2);
});

test('a failed remote package read does not keep the outer update check cached for thirty minutes',async()=>{
  const f=updateFixture();await f.context.refreshQianmuUpdateStatus();
  assert.equal(f.calls.version,1);assert.equal(f.pending.length,1);
  f.pending[0].resolve('');await flush();
  assert.equal(f.context.qianmuUpdateState.status,'ready');
  assert.equal(f.context.optionalServiceState.latestVersion,'');
  f.context.qianmuUpdateState.checkedAt=Date.now()-59999;
  await f.context.refreshQianmuUpdateStatus();assert.equal(f.calls.version,1);
  f.context.qianmuUpdateState.checkedAt=Date.now()-60001;
  await f.context.refreshQianmuUpdateStatus();assert.equal(f.calls.version,2);
  assert.equal(f.pending.length,2);
  f.pending[1].resolve('1.59.384');await flush();
  assert.equal(f.context.optionalServiceState.latestVersion,'1.59.384');
  f.context.qianmuUpdateState.checkedAt=Date.now()-60001;
  await f.context.refreshQianmuUpdateStatus();assert.equal(f.calls.version,2,'a successful remote read keeps the normal cache lifetime');
});
