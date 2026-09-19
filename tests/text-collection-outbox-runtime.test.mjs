import test from 'node:test';
import assert from 'node:assert/strict';
import {createTextCollectionOutboxRuntime} from '../qianmu-text-collection-outbox-runtime.js';
import {createTextCollectionOutboxEntry,emptyTextCollectionOutbox,validateTextCollectionOutbox} from '../qianmu-text-collection-outbox-store.js';
import {createTextCollection} from '../qianmu-text-collection.js';
import {textCollectionSyncError as error} from '../qianmu-text-collection-sync-contract.js';
const namespace='st-user:'+'a'.repeat(64);
const original=()=>createTextCollection({id:'collection-1',createdAt:1,mode:'full',source:{account:namespace,chatId:'deleted-chat',messageId:0,replyId:'reply-1',charName:'旧名字',userName:'读者',text:'原始\r\n收藏😀'}});
const request=()=>({version:1,expectedAccount:namespace,mutationId:'mutation-1',operation:'create',id:'collection-1',baseRevision:0,record:original()});
const ack=r=>({ok:true,version:1,expectedAccount:namespace,libraryRevision:r.baseRevision+1,mutationId:r.mutationId,id:r.id,revision:r.baseRevision+1,updatedAt:r.record?.updatedAt||2});
function fixture(){
  let state=emptyTextCollectionOutbox(namespace),valid=true,failUpdate=0,updates=0,mode='ok';const sent=[];
  const store={read:async()=>structuredClone(state),update:async(_,mutate,{guard})=>{updates++;if(updates===failUpdate)throw error('storage','quota',507);assert.equal(guard(),true);const draft=structuredClone(state);mutate(draft);validateTextCollectionOutbox(draft,namespace);state=structuredClone(draft);return structuredClone(state);}};
  const session={expectedAccount:namespace,guard:async()=>{if(!valid)throw error('account','changed',401);},resumePending:r=>({submit:async()=>{assert.equal(state.entries.find(row=>row.request.mutationId===r.mutationId)?.started,true);sent.push(structuredClone(r));if(mode==='lost')throw error('connection','lost',503);if(mode==='conflict')throw error('conflict','other edit');if(mode==='switch'){valid=false;return ack(r);}return mode==='bad'?{...ack(r),mutationId:'wrong-id'}:ack(r);}})};
  return {store,session,sent,get state(){return structuredClone(state);},set valid(value){valid=value;},set mode(value){mode=value;},set failUpdate(value){failUpdate=value;},runtime:()=>createTextCollectionOutboxRuntime({session,store,now:()=>2})};
}
test('persist precedes transport; recreation and lost receipts reuse the exact request before retiring it',async()=>{
  const f=fixture(),first=f.runtime();await first.enqueue(request());assert.equal(f.sent.length,0);f.mode='lost';await assert.rejects(first.submit('mutation-1'));assert.equal(f.state.entries[0].started,true);first.close();
  const second=f.runtime();f.mode='ok';const result=await second.submit('mutation-1');assert.equal(result.status,'confirmed');assert.deepEqual(f.sent[0],f.sent[1]);assert.deepEqual(f.state.entries,[]);second.close();
});
test('quota before durable enqueue or start never sends, and acknowledgement retirement failure keeps exact retry identity',async()=>{
  for(const point of [1,2,3]){
    const f=fixture(),runtime=f.runtime();f.failUpdate=point;
    if(point===1)await assert.rejects(runtime.enqueue(request()));
    else{await runtime.enqueue(request());await assert.rejects(runtime.submit('mutation-1'));}
    assert.equal(f.sent.length,point===3?1:0);assert.equal(f.state.entries.length,point===1?0:1);
    if(point===3){f.failUpdate=0;await runtime.submit('mutation-1');assert.deepEqual(f.sent[0],f.sent[1]);assert.equal(f.state.entries.length,0);}runtime.close();
  }
});
test('edit conflict preserves draft and original provenance, never rebases or automatically resubmits',async()=>{
  const f=fixture(),runtime=f.runtime(),base=original(),r={version:1,expectedAccount:namespace,mutationId:'mutation-1',operation:'edit',id:base.id,baseRevision:1,text:'我的修改'};
  await runtime.enqueue(r,{base});f.mode='conflict';await assert.rejects(runtime.submit(r.mutationId),{code:'text_collection_sync_conflict'});
  assert.equal(f.state.entries[0].state,'conflict');assert.deepEqual(f.state.entries[0].base,base);assert.equal(f.state.entries[0].request.text,'我的修改');
  await assert.rejects(runtime.submit(r.mutationId));assert.equal(f.sent.length,1);runtime.close();
});
test('wrong receipts and account changes cannot clear local originals or dispatch old-account drafts',async()=>{
  for(const mode of ['bad','switch','before']){const f=fixture(),runtime=f.runtime();await runtime.enqueue(request());f.mode=mode;if(mode==='before')f.valid=false;
    await assert.rejects(runtime.submit('mutation-1'));assert.equal(f.state.entries.length,1);assert.equal(f.sent.length,mode==='before'?0:1);runtime.close();}
});
test('repeated enqueue is identity-preserving, differing content cannot overwrite and simultaneous clicks share one submission',async()=>{
  const f=fixture(),runtime=f.runtime(),r=request();await runtime.enqueue(r);await runtime.enqueue(r);assert.equal(f.state.entries.length,1);
  await assert.rejects(runtime.enqueue({...r,record:{...r.record,source:{...r.record.source,charName:'another'}}}),{code:'text_collection_sync_local_conflict'});
  const a=runtime.submit(r.mutationId),b=runtime.submit(r.mutationId);assert.equal(a,b);await a;assert.equal(f.sent.length,1);runtime.close();
});
test('cancellation and close retain pending requests; shared store remains usable',async()=>{
  const f=fixture(),runtime=f.runtime();await runtime.enqueue(request());const controller=new AbortController();controller.abort();
  await assert.rejects(runtime.submit('mutation-1',{signal:controller.signal}));assert.equal(f.sent.length,0);runtime.close();await assert.rejects(runtime.list());
  assert.deepEqual(f.state.entries,[createTextCollectionOutboxEntry(request(),{queuedAt:2})]);assert.equal((await f.runtime().list()).length,1);
});

test('save adapter reports local durability only after readback and never fabricates a server receipt',async()=>{
  const f=fixture(),runtime=f.runtime();f.mode='lost';await assert.rejects(runtime.save(request()),cause=>cause.localSaved===true&&cause.localMutationId==='mutation-1'&&!Object.hasOwn(cause,'revision'));
  f.mode='ok';const result=await runtime.save(request());assert.equal(result.id,'collection-1');assert.equal(result.revision,1);assert.deepEqual(f.sent[0],f.sent[1]);assert.equal(f.state.entries.length,0);runtime.close();
});
test('save adapter cannot claim retained content when local writes fail or account changes',async()=>{
  for(const mode of ['quota','switch']){const f=fixture(),runtime=f.runtime();if(mode==='quota')f.failUpdate=1;else f.mode='switch';
    await assert.rejects(runtime.save(request()),cause=>cause.localSaved!==true);assert.equal(f.sent.length,mode==='quota'?0:1);runtime.close();}
});

test('local removal needs explicit consent, checks the viewed snapshot and never sends a server deletion',async()=>{
  const f=fixture(),runtime=f.runtime(),row=await runtime.enqueue(request());await assert.rejects(runtime.remove(row),{code:'text_collection_sync_consent'});assert.equal(f.state.entries.length,1);
  f.mode='lost';await assert.rejects(runtime.submit(row.request.mutationId));const started=(await runtime.list())[0];
  await assert.rejects(runtime.remove(row,{confirmed:true}),{code:'text_collection_sync_local_conflict'});
  await assert.rejects(runtime.remove(started,{confirmed:true}),{code:'text_collection_sync_consent'});
  const before=f.sent.length;assert.equal((await runtime.remove(started,{confirmed:true,acceptUnconfirmed:true})).removed,true);assert.equal(f.sent.length,before);assert.equal(f.state.entries.length,0);
  assert.equal((await runtime.remove(started,{confirmed:true,acceptUnconfirmed:true})).removed,false);runtime.close();
});
test('failed local removal and an invalidated account leave all originals untouched',async()=>{
  for(const mode of ['quota','account']){const f=fixture(),runtime=f.runtime(),row=await runtime.enqueue(request());if(mode==='quota')f.failUpdate=2;else f.valid=false;
    await assert.rejects(runtime.remove(row,{confirmed:true}));assert.deepEqual(f.state.entries,[row]);assert.equal(f.sent.length,0);runtime.close();}
});
