import test from 'node:test';
import assert from 'node:assert/strict';
import {textCollectionBulkRequest,textCollectionBulkResponse,textCollectionBulkInfoResponse,textCollectionCleanupPlanResponse,partitionTextCollectionMutations,TEXT_COLLECTION_BULK_LIMITS} from '../qianmu-text-collection-bulk-contract.js';
import {createTextCollection} from '../qianmu-text-collection.js';
const account='st-user:'+'a'.repeat(64),other='st-user:'+'b'.repeat(64);
const mutation=(id='collection-1')=>({version:1,expectedAccount:account,mutationId:'mutation-'+id,operation:'delete',id,baseRevision:1});
const batch=(mutations=[mutation()])=>({version:1,expectedAccount:account,mutations});
const ack=input=>({ok:true,version:1,expectedAccount:account,libraryRevision:2,mutationId:input.mutationId,id:input.id,revision:2,updatedAt:3});

test('bounded batches accept only distinct restore/delete targets in one account, not arbitrary edits or paths',()=>{
  assert.deepEqual(textCollectionBulkRequest(batch()),batch());
  const item=mutation();
  for(const value of [batch([]),batch(Array.from({length:33},(_,i)=>mutation('collection-'+i))),batch([item,item]),batch([item,{...mutation('collection-2'),mutationId:item.mutationId}]),
    batch([{...item,expectedAccount:other}]),batch([{...item,operation:'edit',text:'unapproved'}]),{...batch(),path:'other-file'},batch(Array(1))])assert.throws(()=>textCollectionBulkRequest(value));
});

test('batch size is actual JSON UTF-8 bytes and an oversized batch is refused without slicing originals',()=>{
  const record=createTextCollection({id:'source-01',mode:'full',createdAt:1,source:{account,chatId:'chat',messageId:0,replyId:'reply',charName:'角色',userName:'读者',text:'中'.repeat(200000)}});
  const mutations=Array.from({length:4},(_,i)=>({...mutation('restored-'+i),operation:'restore',baseRevision:0,record}));
  assert.ok(new TextEncoder().encode(JSON.stringify(batch(mutations))).length>TEXT_COLLECTION_BULK_LIMITS.bytes);
  assert.throws(()=>textCollectionBulkRequest(batch(mutations)),/单批内容超过上限/);assert.equal(record.text.length,200000);
  assert.equal(textCollectionBulkRequest(batch(mutations.slice(0,2))).mutations.length,2);
});

test('success requires every ordered per-record receipt and cannot hide a missing or mismatched result',()=>{
  const input=batch([mutation(),mutation('collection-2')]),results=input.mutations.map(ack);
  const result={ok:true,version:1,expectedAccount:account,libraryRevision:3,results};
  assert.equal(textCollectionBulkResponse(result,input).results.length,2);
  for(const patch of [{results:[results[0]]},{results:results.toReversed()},{results:[results[0],{...results[1],libraryRevision:4}]},{expectedAccount:other},{libraryRevision:1},{hidden:'text'}])assert.throws(()=>textCollectionBulkResponse({...result,...patch},input));
});

test('batch capability requires exact bounds and account data, not a legacy restore-info success',()=>{
  const input={version:1,expectedAccount:account},value={ok:true,...input,libraryRevision:3,maxItems:32,maxBytes:2097152,remainingRecords:9998,remainingMutations:99997};
  assert.deepEqual(textCollectionBulkInfoResponse(value,input),value);
  for(const patch of [{maxItems:33},{maxItems:0},{maxBytes:0},{maxBytes:2097153},{remainingMutations:100000},{restoreVersion:1},{expectedAccount:other}])assert.throws(()=>textCollectionBulkInfoResponse({...value,...patch},input));
});

test('partition respects both record count and exact escaped UTF-8 wire bytes without slicing a record',()=>{
  const requests=Array.from({length:65},(_,i)=>mutation('collection-'+i));
  assert.deepEqual(partitionTextCollectionMutations(requests,{expectedAccount:account,maxItems:32,maxBytes:2097152}).map(p=>p.length),[32,32,1]);
  const record=createTextCollection({id:'source-01',mode:'full',createdAt:1,source:{account,chatId:'chat',messageId:0,replyId:'reply',charName:'角色',userName:'读者',text:'中\n"😀'.repeat(40)}});
  const a={...mutation('restore-a'),operation:'restore',baseRevision:0,record},b={...mutation('restore-b'),operation:'restore',baseRevision:0,record};
  const bytes=new TextEncoder().encode(JSON.stringify(batch([a,b]))).byteLength;
  assert.deepEqual(partitionTextCollectionMutations([a,b],{expectedAccount:account,maxItems:32,maxBytes:bytes}).map(p=>p.length),[2]);
  const split=partitionTextCollectionMutations([a,b],{expectedAccount:account,maxItems:32,maxBytes:bytes-1});assert.deepEqual(split.map(p=>p.length),[1,1]);
  for(const part of split)assert.ok(new TextEncoder().encode(JSON.stringify(batch(part))).byteLength<=bytes-1);
  assert.throws(()=>partitionTextCollectionMutations([a],{expectedAccount:account,maxItems:32,maxBytes:100}),/单条收藏超过/);
});

test('cleanup manifest is exact account-bound IDs/revisions, not partial lists or embedded originals',()=>{
  const input={version:1,expectedAccount:account},value={ok:true,...input,libraryRevision:4,total:2,items:[{id:'collection-1',revision:2},{id:'collection-2',revision:1}]};
  assert.deepEqual(textCollectionCleanupPlanResponse(value,input),value);
  for(const patch of [{total:3},{expectedAccount:other},{libraryRevision:1},{items:[...value.items,{id:'collection-1',revision:2}],total:3},
    {items:[{id:'collection-1',revision:2,text:'private'},value.items[1]]},{items:[{id:'collection-1',revision:0},value.items[1]]},{items:Array(2)},{source:'hidden'}])assert.throws(()=>textCollectionCleanupPlanResponse({...value,...patch},input));
  const accepted=textCollectionCleanupPlanResponse(value,input);assert.ok(Object.isFrozen(accepted.items[0]));
});
