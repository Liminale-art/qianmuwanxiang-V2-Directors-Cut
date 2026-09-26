import test from 'node:test';
import assert from 'node:assert/strict';
import {createImageAccountIdentityResolver} from '../qianmu-account-identity.js';
import {readySource,singleUser,identityNativeFixture,measureIdentityNativeCosts} from './helpers/account-identity-fixture.mjs';

function fixture(t,{ready=true}={}){
  let source=readySource(ready),user=singleUser(),server='default-user',calls=0,hook=null;
  const window=new EventTarget(),resolver=createImageAccountIdentityResolver({window,getContext:()=>({eventSource:source,eventTypes:{APP_READY:'APP_READY'}})});
  const fetchImpl=async()=>{calls++;await hook?.();return typeof server==='number'?Response.json({}, {status:server}):Response.json({handle:server});};
  const options={loadUser:async()=>user,fetchImpl};t.after(()=>resolver.close());
  return {resolver,options,window,get source(){return source;},get user(){return user;},get calls(){return calls;},
    replaceSource(value){source=value;},replaceUser(value){user=value;},server(value){server=value;},hook(value){hook=value;},resolve:extra=>resolver.resolve({...options,...extra})};
}

test('only an explicitly APP_READY, matching verified single-account page reuses fallback identity',async t=>{
  const f=fixture(t,{ready:false});await f.resolve();await f.resolve();assert.equal(f.calls,2,'initial false account flag is not ready');
  f.source.emit();await f.resolve();await f.resolve();assert.equal(f.calls,3,'one authenticated handshake after ready');
  f.resolver.invalidate();await f.resolve();assert.equal(f.calls,4);await f.resolve({forceRefresh:true});assert.equal(f.calls,5);
});

test('late APP_READY replay and simultaneous single-account guards share only one handshake',async t=>{
  const f=fixture(t);let entered,release;const start=new Promise(done=>entered=done),gate=new Promise(done=>release=done);
  f.hook(()=>{entered();return gate;});const a=f.resolve();await start;const b=f.resolve();release();
  assert.deepEqual(await Promise.all([a,b]),['st-user:default-user','st-user:default-user']);assert.equal(f.calls,1);
  await f.resolve();assert.equal(f.calls,1);assert.equal(f.source.listeners,1);
});

test('multi-account, unresolved helper, wrong server owner and absent ready host never memoize',async t=>{
  const f=fixture(t);f.user.accountsEnabled=true;await f.resolve();await f.resolve();assert.equal(f.calls,2);
  f.user.accountsEnabled=false;f.user.getCurrentUserHandle=()=>null;await f.resolve();await f.resolve();assert.equal(f.calls,4);
  f.user.getCurrentUserHandle=()=>'default-user';f.server('unexpected-owner');await f.resolve();await f.resolve();assert.equal(f.calls,6);
  const unknown=createImageAccountIdentityResolver({window:null,getContext:()=>({eventSource:f.source,eventTypes:{}})});t.after(()=>unknown.close());
  await unknown.resolve(f.options);await unknown.resolve(f.options);assert.equal(f.calls,8);
});

test('live account flags, source and user-module replacement invalidate a confirmed memo',async t=>{
  const f=fixture(t);await f.resolve();f.user.accountsEnabled=true;f.user.currentUser={handle:'live-owner'};
  assert.equal(await f.resolve(),'st-user:live-owner');assert.equal(f.calls,1);
  f.user.currentUser=null;await f.resolve();await f.resolve();assert.equal(f.calls,3);
  f.user.accountsEnabled=false;await f.resolve();assert.equal(f.calls,4);
  f.replaceUser(singleUser());await f.resolve();assert.equal(f.calls,5);
  const old=f.source;f.replaceSource(readySource(false));await f.resolve();await f.resolve();assert.equal(f.calls,7);assert.equal(old.listeners,0);
  f.source.emit();await f.resolve();await f.resolve();assert.equal(f.calls,8);
});

test('pagehide suspends and clears identity; pageshow requires a fresh verified handshake',async t=>{
  const f=fixture(t);await f.resolve();f.window.dispatchEvent(new Event('pagehide'));
  await assert.rejects(f.resolve(),{code:'image_attempt_account'});assert.equal(f.calls,1);assert.equal(f.source.listeners,0);
  f.window.dispatchEvent(new Event('pageshow'));await f.resolve();await f.resolve();assert.equal(f.calls,2);
});

for(const change of ['pagehide','mode','source','invalidate'])test(`${change} during a fallback rejects it and cannot refill old memo`,async t=>{
  const f=fixture(t);let entered,release;const start=new Promise(done=>entered=done),gate=new Promise(done=>release=done);
  f.hook(()=>{entered();return gate;});const attempt=assert.rejects(f.resolve(),{code:'image_attempt_account'});await start;
  if(change==='pagehide')f.window.dispatchEvent(new Event('pagehide'));
  if(change==='mode')f.user.accountsEnabled=true;
  if(change==='source')f.replaceSource(readySource(true));
  if(change==='invalidate')f.resolver.invalidate();
  release();await attempt;f.hook(null);f.user.accountsEnabled=false;f.window.dispatchEvent(new Event('pageshow'));
  await f.resolve();await f.resolve();assert.equal(f.calls,2);
});

test('failed identity response and timeout never become reusable success',async t=>{
  const f=fixture(t);for(const status of [401,403]){f.server(status);await assert.rejects(f.resolve(),{code:'image_attempt_account'});}
  let release;f.server('default-user');f.hook(()=>new Promise(done=>release=done));
  await assert.rejects(f.resolve({timeoutMs:100}),{code:'image_attempt_account'});release();f.hook(null);
  await f.resolve();await f.resolve();assert.equal(f.calls,4);
});

for(const status of [401,403])test(`real native file ${status} revokes the default resolver page memo`,async t=>{
  const f=await identityNativeFixture();t.after(()=>f.close());assert.equal(await f.resolveNamespace(),'st-user:default-user');
  const before=f.counts.identityHTTP;f.setStatus(status);await assert.rejects(f.storage.read('collections'),{code:'st_account_storage_account'});
  await f.resolveNamespace();assert.equal(f.counts.identityHTTP,before+1,'storage response actively invalidates page identity');
});

test('real resolver→session→native request counts reduce only in the verified single-account page',async()=>{
  const before=await measureIdentityNativeCosts({ready:false}),after=await measureIdentityNativeCosts({ready:true});
  assert.deepEqual(before.map(row=>row.identityHTTP),[26,14,8,51]);
  assert.deepEqual(after.map(row=>row.identityHTTP),[1,0,0,0]);
  assert.deepEqual(after.map(row=>[row.fileGET,row.filePOST]),before.map(row=>[row.fileGET,row.filePOST]),'authenticated files and write/readback protocol unchanged');
  assert.deepEqual(after.map(row=>[row.fileGET,row.filePOST]),[[2,0],[1,0],[0,0],[6,2]]);
});
