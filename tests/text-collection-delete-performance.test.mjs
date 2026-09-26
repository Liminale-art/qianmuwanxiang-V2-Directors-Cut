import test from 'node:test';
import assert from 'node:assert/strict';
import {collectionIndexFixture,record,namespace} from './helpers/collection-index-fixture.mjs';
import {collectionLibraryFixture} from './helpers/collection-library-fixture.mjs';

async function ready(panel){
  for(let index=0;index<100&&panel.panel.element.attrs['aria-busy']==='true';index++)await new Promise(resolve=>setTimeout(resolve,0));
  assert.equal(panel.panel.element.attrs['aria-busy'],'false');
}
const counts=f=>({gets:f.calls.filter(call=>call.request.method==='GET').length,posts:f.uploads,originals:f.bodyReads});

for(const reopen of [false,true])test(`real library controller ${reopen?'reopened warm':'first-open'} two-item deletion publishes one confirmed native directory`,async t=>{
  const native=await collectionIndexFixture(t,[record(1),record(2),record(3)]);
  if(reopen){const prior=await native.open();await prior.sources();prior.close();}
  const session=await native.open(),panel=await collectionLibraryFixture(t,{sessionOverrides:session});await ready(panel);
  assert.equal(panel.rows.length,3);await panel.click('select');await panel.choose(record(1).id);await panel.choose(record(2).id);native.reset();
  await panel.click('delete-selected');await ready(panel);
  assert.deepEqual(counts(native),{gets:6,posts:2,originals:0},'old two-item path used 18 GETs + 4 POSTs, before survivor-source rereads');
  assert.equal(panel.rows.length,1);assert.equal(panel.rows[0].dataset.collectionId,record(3).id);assert.equal(panel.changes,1);
  assert.match(panel.status,/已删除 2 条收藏/);
  if(reopen){native.reset();assert.equal((await session.get(record(3).id)).record.text,record(3).text);assert.equal((await session.sources()).items.length,1);assert.equal(native.calls.length,0);}
});

test('the reopened-panel write-format hint cannot override a remotely changed directory format or identity',async t=>{
  for(const changed of ['format','account']){
    const f=await collectionIndexFixture(t),first=await f.open();await first.list();first.close();
    const next=await f.open();await next.list(undefined,{preferCache:true});const operation=next.prepareDelete(record(1).id,1);
    if(changed==='format'){const index=await f.readIndex();await f.writeIndex({...index.value,version:1,entries:[{id:record(1).id,revision:1,updatedAt:record(1).updatedAt,deleted:false,record:record(1)}]});}
    else f.setAccount(namespace+'-changed');f.reset();
    await assert.rejects(operation.submit(),changed==='format'?{code:'text_collection_sync_changed'}:undefined);assert.equal(f.uploads,0);
  }
});
