import test from 'node:test';
import assert from 'node:assert/strict';
import {textCollectionBulkRequest,textCollectionBulkResponse,TEXT_COLLECTION_BULK_LIMITS} from '../qianmu-text-collection-bulk-contract.js';
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
