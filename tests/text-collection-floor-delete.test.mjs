import test from 'node:test';
import assert from 'node:assert/strict';
import {collectionIndexFixture,record,account} from './helpers/collection-index-fixture.mjs';
import {textCollectionRecord} from '../qianmu-text-collection.js';
import {deleteTextCollectionFloor} from '../qianmu-text-collection-floor-delete.js';

test('filled floor star deletes every excerpt on that floor in one indexed batch, not another floor',async t=>{
  const first=record(1),second=textCollectionRecord({...record(2),source:{...record(2).source,messageId:1}}),other=record(3);
  const f=await collectionIndexFixture(t,[first,second,other]),session=await f.open(),progress=[];
  f.reset();const result=await deleteTextCollectionFloor({session,chatId:'deleted-chat',messageId:1,onProgress:value=>progress.push(value)});
  assert.deepEqual(result,{total:2,confirmed:2});assert.deepEqual(progress,[{total:2,confirmed:2}]);
  assert.equal(f.uploads,2,'one index body and head; no per-excerpt write');
  assert.equal((await session.list()).total,1);assert.equal((await session.get(other.id)).record.id,other.id);
  assert.equal((await session.get(first.id)).record,null);assert.equal((await session.get(second.id)).record,null);
});

test('stale revision rejects the entire floor batch without deleting either excerpt',async t=>{
  const first=record(1),second=textCollectionRecord({...record(2),source:{...record(2).source,messageId:1}});
  const f=await collectionIndexFixture(t,[first,second]),a=await f.open(),b=await f.open();let progress=0,remoteUploads=0;
  const stale={...a,sources:async options=>{const sources=await a.sources(options);await b.prepareEdit(first.id,1,'远端已修改').submit();remoteUploads=f.uploads;return sources;}};
  f.reset();await assert.rejects(deleteTextCollectionFloor({session:stale,chatId:'deleted-chat',messageId:1,onProgress:()=>progress++}),{code:'text_collection_sync_conflict'});
  assert.equal(progress,0);assert.equal(f.uploads,remoteUploads,'stale floor delete adds no upload');assert.equal((await a.list()).total,2);
});

test('a collection added by another device after the click snapshot is never swept into the delete',async t=>{
  const first=record(1),later=textCollectionRecord({...record(2),source:{...record(2).source,messageId:1}});
  const f=await collectionIndexFixture(t,[first]),a=await f.open(),b=await f.open();
  const snapshot={...a,sources:async options=>{const sources=await a.sources(options);await b.prepareCreate(later).submit();return sources;}};
  assert.deepEqual(await deleteTextCollectionFloor({session:snapshot,chatId:'deleted-chat',messageId:1}),{total:1,confirmed:1});
  const page=await a.list();assert.deepEqual(page.items.map(item=>item.id),[later.id]);
});

test('foreign provenance, another chat, duplicate IDs and a changed page never expand the delete scope',async()=>{
  const base={id:'collection-0001',revision:1,account,chatId:'chat-a',messageId:7};let submitted=0,current=true;
  const session={expectedAccount:account,guard:async()=>{if(!current)throw Error('page changed');},
    sources:async()=>({expectedAccount:account,items:[base,{...base,id:'collection-0002',account:'st-user:'+'f'.repeat(64)},
      {...base,id:'collection-0003',chatId:'chat-b'}]}),
    prepareDelete:(id,revision)=>({request:{version:1,expectedAccount:account,mutationId:'mutation-'+id,operation:'delete',id,baseRevision:revision},submit:async()=>{submitted++;}}),
    prepareBatch:()=>assert.fail('one matching item uses the single-record endpoint')};
  assert.deepEqual(await deleteTextCollectionFloor({session,chatId:'chat-a',messageId:7}),{total:1,confirmed:1});assert.equal(submitted,1);
  session.sources=async()=>({expectedAccount:account,items:[base,base]});
  await assert.rejects(deleteTextCollectionFloor({session,chatId:'chat-a',messageId:7}),/重复/);assert.equal(submitted,1);
  current=false;await assert.rejects(deleteTextCollectionFloor({session,chatId:'chat-a',messageId:7}),/page changed/);assert.equal(submitted,1);
});
