import test from 'node:test';
import assert from 'node:assert/strict';
import {collectionIndexFixture,record,account} from './helpers/collection-index-fixture.mjs';
import {createNativeTextCollectionClient} from '../qianmu-text-collection-native.js';

test('fresh known floor feedback checks exact sources without network, and stale or invalidated snapshots stay unknown',async t=>{
  let clock=100000;t.mock.method(Date,'now',()=>clock);
  const f=await collectionIndexFixture(t,[record(1)]),session=await f.open();
  assert.equal(await session.knownFloorState('deleted-chat',1),null,'an unopened directory is not assumed empty');
  await session.sources();f.reset();
  assert.equal(await session.knownFloorState('deleted-chat',1),true);
  assert.equal(await session.knownFloorState('deleted-chat',2),false);
  assert.equal(f.calls.length,0);
  clock+=15001;assert.equal(await session.knownFloorState('deleted-chat',1),null);
  assert.equal(f.calls.length,0,'expiry cannot silently add a read to the interaction path');
  await session.sources();session.invalidateReadCache();f.reset();
  assert.equal(await session.knownFloorState('deleted-chat',1),null);assert.equal(f.calls.length,0);
});

test('whole-record verified directories can answer floor status, and changed accounts never reuse it',async t=>{
  const f=await collectionIndexFixture(t,[record(1)],{version:1}),session=await f.open();
  await session.sources();f.reset();
  assert.equal(await session.knownFloorState('deleted-chat',1),true);
  assert.equal(await session.knownFloorState('other-chat',1),false);assert.equal(f.calls.length,0);
  f.setAccount('st-user:other');
  await assert.rejects(session.knownFloorState('deleted-chat',1),{code:'text_collection_sync_account'});
  assert.equal(f.calls.length,0);
});

test('missing exact-descriptor provenance stays unknown even when a different known source is on the requested floor',async t=>{
  const f=await collectionIndexFixture(t,[record(1),record(2)]),session=await f.open();
  await session.get(record(1).id);f.reset();
  assert.equal(await session.knownFloorState('deleted-chat',1),null);
  assert.equal(await session.knownFloorState('deleted-chat',3),null);assert.equal(f.calls.length,0);
  await session.sources();f.reset();
  assert.equal(await session.knownFloorState('deleted-chat',1),true);
  assert.equal(await session.knownFloorState('deleted-chat',3),false);assert.equal(f.calls.length,0);
});

test('an epoch change while the guard is pending cannot publish a cached floor answer',async t=>{
  const f=await collectionIndexFixture(t,[record(1)]);let pause=false,release,entered;
  const client=createNativeTextCollectionClient({expectedAccount:account,readScope:{},storageFactory:async()=>f.storage,
    guard:async()=>{if(pause){pause=false;entered();await new Promise(resolve=>{release=resolve;});}return true;},
    legacyFactory:()=>({snapshot:()=>assert.fail('native fixture exists'),close(){}})});
  t.after(()=>client.close());await client.sources();f.reset();
  const started=new Promise(resolve=>{entered=resolve;});pause=true;
  const pending=client.knownFloorState('deleted-chat',1);await started;
  client.invalidateReadCache();release();assert.equal(await pending,null);assert.equal(f.calls.length,0);
});
