import test from 'node:test';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {collectionIndexFixture,record,namespace} from './helpers/collection-index-fixture.mjs';
import {createTextCollectionSession} from '../qianmu-text-collection-session.js';

test('a warm v2 directory opens a cold detail in another panel with one original GET and no duplicate head/body reads',async t=>{
  const f=await collectionIndexFixture(t,[record(1)]),a=await f.open();await a.list();
  assert.equal(f.bodyReads,0,'summary-only browsing has not warmed the full original');a.close();f.reset();
  const b=await f.open();assert.equal((await b.get(record(1).id,{preferCache:true})).record.text,record(1).text);
  assert.equal(f.bodyReads,1);assert.equal(f.calls.length,1,'a verified directory only needs the exact immutable original, not head/body initialization again');
  f.reset();await b.get(record(1).id,{forceRefresh:true});
  assert.equal(f.bodyReads,1);assert.equal(f.calls.length,3,'explicit refresh still rereads the directory head/body and complete original');
});

test('closing during an aborted background directory recheck keeps another same-account panel warm',async t=>{
  const f=await collectionIndexFixture(t,[record(1)]),a=await f.open();await a.sources();
  let release,entered,first=true;
  const waiting=new Promise(resolve=>{entered=resolve;}),gate=new Promise(resolve=>{release=resolve;});
  f.hook(async({path})=>{if(first&&path.includes('-collections.json')){first=false;entered();await gate;}});
  const controller=new AbortController(),pending=assert.rejects(a.list(undefined,{revalidate:true,signal:controller.signal}),{code:'st_account_storage_cancelled'});
  await waiting;controller.abort();a.close();release();await pending;f.hook(null);f.reset();
  const b=await f.open();assert.equal((await b.list(undefined,{preferCache:true})).total,1);
  assert.equal((await b.get(record(1).id,{preferCache:true})).record.text,record(1).text);
  assert.equal(f.calls.length,0,'a panel close cannot turn warm browsing into head/body/original downloads');
});

test('a chat or panel lifecycle invalidated during identity resolution cannot revoke shared account snapshots',async t=>{
  const f=await collectionIndexFixture(t,[record(1)]);let live=true,holdIdentity=false,release,entered;
  const waiting=new Promise(resolve=>{entered=resolve;});
  const resolveNamespace=async()=>{
    if(holdIdentity){holdIdentity=false;entered();await new Promise(resolve=>{release=resolve;});}
    return namespace;
  };
  const a=await createTextCollectionSession({resolveNamespace,isCurrent:()=>live,headers:()=>({'X-CSRF-Token':'fixture'}),cryptoImpl:webcrypto});
  t.after(()=>a.close());await a.sources();holdIdentity=true;
  const pending=assert.rejects(a.sources(),{code:'text_collection_sync_cancelled'});
  await waiting;live=false;release();await pending;a.close();f.reset();
  const b=await f.open();assert.equal((await b.list(undefined,{preferCache:true})).total,1);
  assert.equal((await b.get(record(1).id,{preferCache:true})).record.text,record(1).text);
  assert.equal(f.calls.length,0,'old floor-status epochs cannot discard an unrelated open/reopened library snapshot');
});

test('identity unavailable while a session remains live still revokes warm same-account readers',async t=>{
  const f=await collectionIndexFixture(t,[record(1)]);let unavailable=false;
  const a=await createTextCollectionSession({resolveNamespace:async()=>{if(unavailable)throw Error('identity unavailable');return namespace;},
    isCurrent:()=>true,headers:()=>({'X-CSRF-Token':'fixture'}),cryptoImpl:webcrypto});
  t.after(()=>a.close());const b=await f.open();await a.sources();unavailable=true;
  await assert.rejects(a.sources(),{code:'text_collection_sync_account'});f.reset();
  await assert.rejects(b.list(undefined,{preferCache:true}),{code:'text_collection_sync_account'});
  assert.equal(f.calls.length,0,'identity uncertainty may not reveal the old cache to another live session');
  unavailable=false;const reopened=await f.open();assert.equal((await reopened.list(undefined,{preferCache:true})).total,1);
  assert.equal(f.calls.length,2,'after a real identity failure a new verified reader must reload the remote directory');
});
