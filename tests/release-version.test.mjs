import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {setImmediate as flush} from 'node:timers/promises';
import {createQianmuReleaseVersionReader} from '../qianmu-release-version.js';
import {storyboardFunctionSource as section} from './helpers/storyboard-form-fixture.mjs';
const official={remoteUrl:'https://github.com/Liminale-art/qianmuwanxiang-V2-Directors-Cut.git',currentBranchName:'codex/phase-1'};
const response=(version='1.59.371',extra={})=>new Response(JSON.stringify({name:'qianmu-omniscene',version,...extra}));

test('release lookup uses the ST-verified official branch without credentials, redirects or request headers',async()=>{
  const requests=[],read=createQianmuReleaseVersionReader({fetchImpl:async(url,init)=>{requests.push({url,init});return response();}});
  assert.equal(await read(official),'1.59.371');assert.equal(requests.length,1);
  const {url,init}=requests[0];assert.equal(url,'https://raw.githubusercontent.com/Liminale-art/qianmuwanxiang-V2-Directors-Cut/codex%2Fphase-1/package.json');
  assert.equal(init.method,'GET');assert.equal(init.credentials,'omit');assert.equal(init.referrerPolicy,'no-referrer');assert.equal(init.redirect,'error');assert.equal(init.headers,undefined);assert.ok(init.signal);
});

test('unverified repositories, missing branches and malformed refs never cause a release request',async()=>{
  let calls=0;const read=createQianmuReleaseVersionReader({fetchImpl:async()=>{calls++;return response();}});
  for(const remoteUrl of ['',undefined,'https://evil.invalid/Liminale-art/qianmuwanxiang-V2-Directors-Cut.git','https://github.com/other/fork.git',official.remoteUrl+'?token=private','https://user:secret@github.com/Liminale-art/qianmuwanxiang-V2-Directors-Cut.git'])assert.equal(await read({...official,remoteUrl}),'');
  for(const currentBranchName of ['',undefined,'../main','main/','codex//main','main?secret','main#hash','main\n','codex/.hidden','main.lock','x'.repeat(201)])assert.equal(await read({...official,currentBranchName}),'');
  assert.equal(calls,0);
});

test('same-branch checks are single-flight and cached for thirty minutes including failures',async()=>{
  let now=0,calls=0,finish;const read=createQianmuReleaseVersionReader({now:()=>now,fetchImpl:async()=>{calls++;return new Promise(resolve=>finish=resolve);}});
  const a=read(official),b=read(official);assert.equal(calls,1);finish(response());assert.deepEqual(await Promise.all([a,b]),['1.59.371','1.59.371']);
  now=30*60*1000-1;assert.equal(await read(official),'1.59.371');assert.equal(calls,1);
  now++;const c=read(official);assert.equal(calls,2);finish(new Response('failed',{status:503}));assert.equal(await c,'');
  assert.equal(await read(official),'');assert.equal(calls,2);
  const d=read({...official,currentBranchName:'codex/next'});assert.equal(calls,3);finish(response('1.59.372'));assert.equal(await d,'1.59.372');
  assert.equal(await read(official),'','another branch cannot overwrite the original failed result');
});

test('package identity and version are validated without borrowing the installed frontend version',async()=>{
  for(const body of [{name:'different-package',version:'1.59.371'},...['latest','<script>','1.2.3\n','1.2.3-'+ 'a'.repeat(80),{},null].map(version=>({name:'qianmu-omniscene',version}))]){
    const read=createQianmuReleaseVersionReader({fetchImpl:async()=>new Response(JSON.stringify(body))});assert.equal(await read(official),'');
  }
  assert.equal(await createQianmuReleaseVersionReader({fetchImpl:async()=>response('v1.59.371-rc.1+build.2')})(official),'1.59.371-rc.1+build.2');
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
    qianmuUpdateState:{status:'idle',checkedAt:0},qianmuUpdatePromise:null,optionalServiceState:{status:'ready',version:'1.59.371',services:[]},
    ctx:()=>({getRequestHeaders:()=>({'X-CSRF-Token':'synthetic-st-only'})}),qianmuInstalledExtensionName:()=> 'third-party/qianmu',qianmuInstalledExtensionScope:async()=>false,
    fetch:async()=>{calls.version++;return new Response(JSON.stringify({...official,isUpToDate:false}));},
    readQianmuLatestRelease:info=>new Promise(resolve=>pending.push({info,resolve})),
    paintOptionalServiceState:()=>{calls.paint++;},paintQianmuVersionBadge:()=>{calls.badge++;}});
  vm.runInContext(section('refreshQianmuUpdateStatus'),context);return {context,pending,calls};
}

test('the existing update check starts release metadata asynchronously and does not hold health or repeat on cached opens',async()=>{
  const f=updateFixture(),result=await f.context.refreshQianmuUpdateStatus();
  assert.equal(result.status,'ready');assert.equal(f.pending.length,1);assert.equal(f.context.optionalServiceState.latestVersion,'');assert.equal(f.calls.badge,1);
  assert.equal(f.context.optionalServiceState.status,'ready');assert.equal(f.context.optionalServiceState.version,'1.59.371');
  f.pending[0].resolve('1.59.371');await flush();assert.equal(f.context.optionalServiceState.latestVersion,'1.59.371');
  await f.context.refreshQianmuUpdateStatus();assert.equal(f.calls.version,1);assert.equal(f.pending.length,1);
});

test('superseded release responses cannot overwrite a newer check and failed ST checks leave latest unknown',async()=>{
  const f=updateFixture();await f.context.refreshQianmuUpdateStatus(true);await f.context.refreshQianmuUpdateStatus(true);
  f.pending[1].resolve('1.59.372');await flush();f.pending[0].resolve('1.59.371');await flush();assert.equal(f.context.optionalServiceState.latestVersion,'1.59.372');
  f.context.fetch=async()=>new Response('',{status:503});await f.context.refreshQianmuUpdateStatus(true);
  assert.equal(f.context.optionalServiceState.latestVersion,'');assert.equal(f.pending.length,2);assert.equal(f.context.optionalServiceState.status,'ready');
});
