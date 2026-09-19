import test from 'node:test';
import assert from 'node:assert/strict';
import {createTextCollectionRestoreBatch} from '../qianmu-text-collection-restore-batch.js';
import {createTextCollection} from '../qianmu-text-collection.js';
import {textCollectionSyncMutation} from '../qianmu-text-collection-sync-contract.js';
const sourceAccount=`st-user:${'a'.repeat(64)}`,expectedAccount=`st-user:${'b'.repeat(64)}`;
const gate=()=>{let release;return {promise:new Promise(resolve=>{release=resolve;}),release:value=>release(value)};};
function fixture(){
  const records=Array.from({length:3},(_,i)=>createTextCollection({id:`source-${i}`,mode:'full',createdAt:1,source:{account:sourceAccount,chatId:'old',messageId:0,replyId:'old',charName:'角色',userName:'读者',text:`收藏${i}`}}));
  const backup={type:'qianmu-text-collections',version:1,sourceAccount,exportedAt:2,libraryRevision:3,records};
  const f={current:true,accepted:true,preflights:0,asks:[],sent:[],saved:new Set(),prepared:[],remainingRecords:100,remainingMutations:100,lost:null,updates:[]};let ids=0;
  const session={expectedAccount,guard:async()=>{if(!f.current)throw Error('account changed');},batchInfo:async()=>{f.preflights++;if(f.backendError)throw Error('update backend');return {maxItems:f.maxItems||1,maxBytes:2097152,remainingRecords:f.remainingRecords,remainingMutations:f.remainingMutations};},
    prepareRestore(record,id){const request=textCollectionSyncMutation({version:1,expectedAccount,mutationId:`mutation-${id}`,operation:'restore',id,baseRevision:0,record});f.prepared.push(request);return {request};},
    prepareBatch(mutations){return {request:{mutations},submit:async({signal})=>{if(signal.aborted)throw Error('aborted');f.sent.push(...mutations);mutations.forEach(r=>f.saved.add(r.id));if(mutations.some(r=>r.id===f.lost)){f.lost=null;throw Object.assign(Error('lost ack'),{writeState:'unconfirmed'});}return {};}};}};
  f.options={backup,session,check:()=>{if(!f.current)throw Error('page changed');},confirm:async(...args)=>{f.asks.push(args);return f.accepted;},uid:()=>`copy-id-${++ids}`,onProgress:p=>f.updates.push(p)};
  return f;
}
test('whole backup is validated before any request; fixed copy IDs and exact metadata survive outside mutation',async()=>{
  const f=fixture(),batch=createTextCollectionRestoreBatch(f.options);assert.equal(f.preflights,0);assert.equal(f.sent.length,0);
  f.options.backup.records[0]={};const result=await batch.run();assert.equal(result.status,'complete');assert.equal(result.confirmed,3);
  assert.equal(f.preflights,1);assert.equal(f.asks.length,1);assert.match(f.asks[0][1],/来自其他账户/);assert.match(f.asks[0][1],/关闭或刷新后不能自动续接/);
  assert.equal(f.sent[0].record.text,'收藏0');assert.equal(f.saved.size,3);assert.deepEqual(f.updates.map(x=>x.confirmed),[1,2,3]);assert.equal(batch.progress.active,false);
  await batch.run();assert.equal(f.sent.length,3);
  const bad=fixture();bad.options.backup.records[2]={...bad.options.backup.records[2],extra:'secret'};assert.throws(()=>createTextCollectionRestoreBatch(bad.options));assert.equal(bad.prepared.length,0);
});
test('decline, unsupported backend and insufficient whole-batch quota never submit any originals',async()=>{
  for(const mode of ['decline','backend','quota']){
    const f=fixture();if(mode==='decline')f.accepted=false;if(mode==='backend')f.backendError=true;if(mode==='quota')f.remainingRecords=2;
    const batch=createTextCollectionRestoreBatch(f.options);if(mode==='decline')assert.equal((await batch.run()).status,'cancelled');else await assert.rejects(batch.run());
    assert.equal(f.sent.length,0);assert.equal(batch.progress.confirmed,0);assert.equal(batch.progress.active,false);assert.equal(f.asks.length,mode==='decline'?1:0);
  }
});
test('lost acknowledgement stops the batch and explicit retry keeps IDs without resending confirmed entries',async()=>{
  const f=fixture();f.lost='copy-id-2';const batch=createTextCollectionRestoreBatch(f.options);
  await assert.rejects(batch.run(),/lost ack/);assert.deepEqual(batch.progress,{total:3,confirmed:1,uncertain:true,active:false});assert.equal(f.saved.size,2);
  f.remainingRecords=0;assert.equal((await batch.run()).confirmed,3);assert.deepEqual(f.sent.map(r=>r.id),['copy-id-1','copy-id-2','copy-id-2','copy-id-3']);
  assert.equal(f.sent[1],f.sent[2]);assert.equal(f.saved.size,3);assert.equal(f.asks.length,1);assert.equal(f.preflights,2);
});
test('concurrent run calls share one confirmation and account changes or close prevent further submissions',async()=>{
  for(const mode of ['account','close']){
    const f=fixture(),entered=gate(),hold=gate();f.options.confirm=async()=>{entered.release();return hold.promise;};
    const batch=createTextCollectionRestoreBatch(f.options),first=batch.run(),second=batch.run();assert.equal(first,second);await entered.promise;
    if(mode==='account')f.current=false;else batch.close();hold.release(true);await assert.rejects(first);assert.equal(f.sent.length,0);assert.equal(batch.progress.active,false);
  }
});
test('progress UI failure after a confirmed write retains its receipt position and does not duplicate it',async()=>{
  const f=fixture();let first=true;f.options.onProgress=()=>{if(first){first=false;throw Error('view lost');}};
  const batch=createTextCollectionRestoreBatch(f.options);await assert.rejects(batch.run(),/view lost/);assert.equal(batch.progress.confirmed,1);assert.equal(batch.progress.uncertain,false);
  await batch.run();assert.deepEqual(f.sent.map(r=>r.id),['copy-id-1','copy-id-2','copy-id-3']);
});

test('multi-record progress advances only on whole-batch acknowledgements and retry preserves the batch',async()=>{
  const f=fixture();f.maxItems=2;f.lost='copy-id-2';const batch=createTextCollectionRestoreBatch(f.options);
  await assert.rejects(batch.run());assert.equal(f.saved.size,2);assert.equal(batch.progress.confirmed,0);assert.equal(batch.progress.uncertain,true);
  await batch.run();assert.deepEqual(f.updates.map(p=>p.confirmed),[2,3]);assert.deepEqual(f.sent.map(r=>r.id),['copy-id-1','copy-id-2','copy-id-1','copy-id-2','copy-id-3']);assert.equal(f.saved.size,3);
});
