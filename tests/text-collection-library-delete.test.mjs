import test from 'node:test';
import assert from 'node:assert/strict';
import {collectionLibraryFixture} from './helpers/collection-library-fixture.mjs';
import {textCollectionBulkRequest} from '../qianmu-text-collection-bulk-contract.js';

const account='st-user:'+'a'.repeat(64);
async function deletionFixture(t,count,{failCall=0,acceptedBeforeFailure=false,onSubmit}={}){
  const live=new Map(Array.from({length:count},(_,i)=>{
    const id='item-'+String(i).padStart(4,'0');return [id,{id,revision:1,charName:'CHAR',userName:'USER',createdAt:10,preview:'片段'+i}];
  })),prepared=[],batchHandles=[],submissions=[],receipts=new Set();let listReads=0,effects=0;
  const fail=()=>Object.assign(Error('提交结果未确认，请重试'),{code:'text_collection_sync_connection'});
  async function submit(request){
    submissions.push(request);await onSubmit?.(request,submissions.length);
    const failed=submissions.length===failCall;
    if(failed&&!acceptedBeforeFailure)throw fail();
    const items=request.mutations||[request];
    for(const item of items)if(!receipts.has(item.mutationId)){
      if(live.get(item.id)?.revision!==item.baseRevision)throw Object.assign(Error('已在其他设备变更'),{code:'text_collection_sync_conflict'});
    }
    for(const item of items)if(!receipts.has(item.mutationId)){
      receipts.add(item.mutationId);live.delete(item.id);effects++;
    }
    if(failed)throw fail();return {};
  }
  const sessionOverrides={expectedAccount:account,
    list:async()=>{listReads++;return {items:[...live.values()],total:live.size,nextCursor:null};},
    prepareDelete(id,baseRevision){
      const request={version:1,expectedAccount:account,mutationId:'mutation-'+String(prepared.length+1).padStart(8,'0'),operation:'delete',id,baseRevision};
      prepared.push(request);return {request,submit:()=>submit(request)};
    },
    prepareBatch(inputs){const request=textCollectionBulkRequest({version:1,expectedAccount:account,mutations:inputs});batchHandles.push(request);return {request,submit:()=>submit(request)};},
  };
  const f=await collectionLibraryFixture(t,{sessionOverrides});
  return {...f,live,prepared,batchHandles,submissions,get listReads(){return listReads;},get effects(){return effects;},
    async selectAll(){await f.click('select');for(const id of live.keys())await f.choose(id);},
    get status(){return f.status;},get rows(){return f.rows;},get changes(){return f.changes;},get closed(){return f.closed;}};
}

test('actual collection panel deletes forty selected items in bounded batches and refreshes only once',async t=>{
  const f=await deletionFixture(t,40);await f.selectAll();await f.click('delete-selected');
  assert.equal(f.submissions.length,2);assert.deepEqual(f.submissions.map(request=>request.mutations.length),[32,8]);
  assert.equal(f.prepared.length,40);assert.equal(f.batchHandles.length,2);assert.equal(f.effects,40);
  assert.equal(f.listReads,2,'one initial read and only one final refresh');assert.equal(f.changes,1);
  assert.equal(f.rows.length,0);assert.match(f.status,/已删除 40 条收藏/);
});

test('lost batch receipt leaves every item selected and retries the identical captured batch without new mutations',async t=>{
  const f=await deletionFixture(t,2,{failCall:1,acceptedBeforeFailure:true});await f.selectAll();await f.click('delete-selected');
  assert.equal(f.effects,2,'the fake transport accepted the two targets');assert.equal(f.rows.length,2,'unconfirmed items remain visible');
  assert.match(f.status,/已删除 0 条/);assert.equal(f.changes,0);assert.equal(f.listReads,1);
  await f.click('delete-selected');
  assert.equal(f.submissions[1],f.submissions[0],'reuse the very same batch handle and payload');
  assert.equal(f.prepared.length,2);assert.equal(f.batchHandles.length,1);assert.equal(f.effects,2);
  assert.equal(f.listReads,2);assert.equal(f.changes,1);assert.equal(f.rows.length,0);
});

test('partial multi-batch success removes only confirmed rows, retains the failed batch, and resumes it once',async t=>{
  const f=await deletionFixture(t,40,{failCall:2});await f.selectAll();await f.click('delete-selected');
  assert.equal(f.effects,32);assert.equal(f.rows.length,8);assert.match(f.status,/已删除 32 条/);
  assert.equal(f.changes,1);assert.equal(f.listReads,1,'a partial failure must not refresh away the unconfirmed selection');
  await f.click('delete-selected');
  assert.equal(f.submissions.length,3);assert.equal(f.submissions[2],f.submissions[1]);
  assert.equal(f.prepared.length,40);assert.equal(f.batchHandles.length,2);assert.equal(f.effects,40);
  assert.equal(f.listReads,2);assert.equal(f.changes,2);assert.equal(f.rows.length,0);
});

test('stale revision rejects the selected batch without displaying any deletion success',async t=>{
  let f;f=await deletionFixture(t,2,{onSubmit:()=>{f.live.get('item-0001').revision=2;}});await f.selectAll();await f.click('delete-selected');
  assert.equal(f.effects,0);assert.equal(f.rows.length,2);assert.equal(f.listReads,1);assert.equal(f.changes,0);
  assert.match(f.status,/已删除 0 条.*其他设备变更/);assert.equal(f.submissions[0].mutations[0].baseRevision,1);
});

test('single selection keeps its stable single-item handle rather than preparing an unnecessary batch',async t=>{
  const f=await deletionFixture(t,1,{failCall:1,acceptedBeforeFailure:true});await f.selectAll();await f.click('delete-selected');
  assert.equal(f.submissions[0].operation,'delete');assert.equal(f.batchHandles.length,0);assert.equal(f.rows.length,1);
  await f.click('delete-selected');assert.equal(f.submissions[1],f.submissions[0]);assert.equal(f.prepared.length,1);
  assert.equal(f.effects,1);assert.equal(f.listReads,2);assert.equal(f.rows.length,0);
});

test('changed account guard stops the selected deletion before any captured batch is submitted',async t=>{
  const f=await deletionFixture(t,2);await f.selectAll();
  f.session.guard=async()=>{throw Object.assign(Error('账户已变化'),{code:'text_collection_sync_account'});};
  await f.click('delete-selected');assert.equal(f.submissions.length,0);assert.equal(f.effects,0);assert.equal(f.closed,true);assert.equal(f.changes,0);
});

test('page change after the first batch prevents submission of the next captured batch',async t=>{
  let f;f=await deletionFixture(t,40,{onSubmit:(_request,n)=>{if(n===1)f.setCurrent(false);}});await f.selectAll();await f.click('delete-selected');
  assert.equal(f.submissions.length,1);assert.equal(f.effects,32);assert.equal(f.listReads,1);
  assert.equal(f.changes,0,'no stale panel success signal');assert.equal(f.rows.length,40);
});
