import test from 'node:test';
import assert from 'node:assert/strict';
import {createNativeTextCollectionClient} from '../qianmu-text-collection-native.js';
import {createTextCollection} from '../qianmu-text-collection.js';
const account='st-user:'+'a'.repeat(64);
const item=(id,text='值得保存的厨房往事')=>createTextCollection({id,mode:'full',createdAt:10,source:{account,chatId:'old-chat',messageId:0,replyId:'reply-1',charName:'角色',userName:'用户',text}});
const mutation=(record,id='mutation-0001')=>({version:1,expectedAccount:account,mutationId:id,operation:'create',id:record.id,baseRevision:0,record});
function fixture({records=[],legacyStatus=404}={}){
  let value=null,writes=0,reads=0,legacyReads=0,live=true;
  const store={read:async()=>{reads++;return {exists:value!==null,value:structuredClone(value),fingerprint:value===null?null:'current'};},
    write:async(_,next,options)=>{await options.guard();writes++;value=structuredClone(next);return {value:structuredClone(value)};},
    update:async(_,fn,options)=>{await options.guard();const next=fn(structuredClone(value));writes++;value=structuredClone(next);return {value:structuredClone(value)};},close(){}};
  const legacy={snapshot:async()=>{legacyReads++;if(!records.length)throw Object.assign(Error('legacy unavailable'),{code:'text_collection_sync_unavailable',upstreamStatus:legacyStatus});return {backup:{type:'qianmu-text-collections',version:1,sourceAccount:account,exportedAt:20,libraryRevision:records.length,records}};},close(){}};
  const client=createNativeTextCollectionClient({expectedAccount:account,guard:async()=>live,storageFactory:async()=>store,legacyFactory:()=>legacy,now:()=>30});
  return {client,get state(){return structuredClone(value);},get counts(){return {writes,reads,legacyReads};},invalidate(){live=false;}};
}
test('native collection works without plugin backend and survives a separate library session',async()=>{
  const f=fixture();assert.equal(f.client.persistence,'st-account-file');assert.equal(f.client.concurrency,'optimistic-non-cas');
  assert.equal((await f.client.list()).total,0);const record=item('collection-0001'),request=mutation(record);
  const ack=await f.client.write(request);assert.equal(ack.revision,1);assert.deepEqual((await f.client.get(record.id)).record,record);
  assert.equal((await f.client.list({cursor:null,limit:50,search:'厨房'})).items[0].id,record.id);
  assert.equal((await f.client.snapshot()).backup.records.length,1);assert.equal((await f.client.inventory()).count,1);
  assert.equal(f.state.version,1,'this compatibility release does not automatically convert old or newly initialized libraries');
  assert.equal(f.counts.legacyReads,1);f.client.close();
});
test('legacy originals migrate with same identity and are never deleted or rewritten',async()=>{
  const record=item('collection-0001'),f=fixture({records:[record]});assert.deepEqual((await f.client.get(record.id)).record,record);
  assert.equal(f.state.migration.records,1);assert.equal(f.counts.legacyReads,1);assert.equal((await f.client.list()).total,1);f.client.close();
});
test('only a real legacy 404 is absence; unsupported or failed legacy service never creates an empty replacement',async()=>{
  for(const status of [401,405,501,503]){const f=fixture({legacyStatus:status});await assert.rejects(f.client.list());assert.equal(f.state,null);assert.equal(f.counts.writes,0);f.client.close();}
});
test('stable mutation IDs reconcile retries and reject changed payloads',async()=>{
  const f=fixture(),request=mutation(item('collection-0001'));const first=await f.client.write(request),retry=await f.client.write(request);assert.deepEqual(retry,first);assert.equal(f.state.entries.length,1);assert.equal(f.state.revision,1);
  await assert.rejects(f.client.write({...request,record:item(request.id,'其他文字')}),{code:'text_collection_sync_mutation_conflict'});f.client.close();
});
test('edits, stale revisions, tombstones and cleanup snapshots keep their established contracts',async()=>{
  const f=fixture(),request=mutation(item('collection-0001'));await f.client.write(request);
  const edit={version:1,expectedAccount:account,mutationId:'mutation-edit1',operation:'edit',id:request.id,baseRevision:1,text:'收藏修改'};
  assert.equal((await f.client.write(edit)).revision,2);await assert.rejects(f.client.write({...edit,mutationId:'mutation-edit2'}),{code:'text_collection_sync_conflict'});
  const plan=await f.client.cleanupPlan();assert.deepEqual(plan.items,[{id:request.id,revision:2}]);
  await f.client.write({version:1,expectedAccount:account,mutationId:'mutation-del01',operation:'delete',id:request.id,baseRevision:2});
  assert.equal((await f.client.get(request.id)).record,null);assert.equal((await f.client.inventory()).deletedCount,1);assert.equal((await f.client.snapshot()).backup.records.length,0);f.client.close();
});
test('account or session invalidation blocks all subsequent native writes',async()=>{
  const f=fixture();await f.client.list();const writes=f.counts.writes;f.invalidate();await assert.rejects(f.client.write(mutation(item('collection-0001'))));assert.equal(f.counts.writes,writes);f.client.close();
});
