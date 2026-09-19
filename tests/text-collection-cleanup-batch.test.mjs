import test from 'node:test';
import assert from 'node:assert/strict';
import {createTextCollectionCleanupBatch} from '../qianmu-text-collection-cleanup-batch.js';
import {collectionCleanupOptions} from '../qianmu-storage-backup-view.js';
const expectedAccount='st-user:'+'a'.repeat(64);
function fixture(){
  const f={live:true,accepted:true,asks:[],sent:[],saved:new Set(),lose:true,updates:[],quota:100};
  const plan={ok:true,version:1,expectedAccount,libraryRevision:3,total:3,items:[1,2,3].map(n=>({id:`collection-${n}`,revision:1}))};
  const session={expectedAccount,guard:async()=>{if(!f.live)throw Error('changed');},batchInfo:async()=>({maxItems:2,maxBytes:2097152,remainingMutations:f.quota}),
    prepareDelete:(id,baseRevision)=>({request:{version:1,expectedAccount,mutationId:`mutation-${id}`,operation:'delete',id,baseRevision}}),
    prepareBatch:mutations=>({request:{mutations},submit:async()=>{if(f.conflict)throw Object.assign(Error('conflict'),{writeState:'not_started'});f.sent.push(mutations);mutations.forEach(r=>f.saved.add(r.id));if(f.lose){f.lose=false;throw Error('lost');}}})};
  f.options={plan,session,check:()=>{if(!f.live)throw Error('changed');},confirm:async(...args)=>{f.asks.push(args);return f.accepted;},onProgress:p=>f.updates.push(p),otherModules:2};return f;
}
test('cleanup requires explicit confirmation and warns about originals, skipped modules and retained receipts',async()=>{
  const f=fixture();f.accepted=false;const batch=createTextCollectionCleanupBatch(f.options);assert.equal((await batch.run()).status,'cancelled');assert.equal(f.sent.length,0);
  assert.match(f.asks[0][1],/不可恢复.*3 条收藏原件/);assert.match(f.asks[0][1],/其他 2 个模块本次不执行/);assert.match(f.asks[0][1],/文件不一定归零或变小/);
  f.quota=2;await assert.rejects(batch.run(),/额度不足/);assert.equal(f.sent.length,0);
});
test('lost cleanup receipt keeps fixed IDs and revisions without re-planning or silently repeating confirmed batches',async()=>{
  const f=fixture(),batch=createTextCollectionCleanupBatch(f.options);await assert.rejects(batch.run(),/lost/);
  assert.equal(batch.progress.confirmed,0);assert.equal(batch.progress.uncertain,true);assert.equal(f.saved.size,2);
  f.options.plan.items=[];f.quota=0;const done=await batch.run();assert.equal(done.confirmed,3);assert.equal(f.saved.size,3);assert.equal(f.asks.length,1);
  assert.equal(f.sent[0],f.sent[1]);assert.deepEqual(f.updates.map(p=>p.confirmed),[2,3]);assert.deepEqual(f.sent[2].map(r=>r.id),['collection-3']);
});
test('conflict, closed page and close during confirmation never widen deletion or force a changed revision',async()=>{
  const f=fixture();f.conflict=true;const batch=createTextCollectionCleanupBatch(f.options);await assert.rejects(batch.run(),/conflict/);assert.equal(batch.progress.uncertain,false);assert.equal(batch.progress.confirmed,0);
  f.live=false;await assert.rejects(batch.run());assert.equal(f.sent.length,0);
  const g=fixture();g.options.confirm=async()=>{b.close();return true;};const b=createTextCollectionCleanupBatch(g.options);await assert.rejects(b.run());assert.equal(g.sent.length,0);
});
test('module option exposes only verified current originals, never zero-original receipts as deletable content',()=>{
  assert.deepEqual(collectionCleanupOptions({collectionStorage:{status:'unavailable',bytes:null}}),[]);
  const [item]=collectionCleanupOptions({collectionStorage:{status:'ready',count:3,bytes:999}});assert.equal(item.id,'__collections__');assert.equal(item.bytes,999);assert.equal(item.risk[1],true);assert.equal('checked' in item,false);
  assert.equal(collectionCleanupOptions({collectionStorage:{status:'ready',count:0,bytes:999}})[0].bytes,0);
});
