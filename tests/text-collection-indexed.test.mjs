import test from 'node:test';
import assert from 'node:assert/strict';
import {collectionIndexFixture,record,entry,account} from './helpers/collection-index-fixture.mjs';
import {validateNativeCollectionDocument,nativeCollectionLogicalBytes} from '../qianmu-text-collection-document.js';
const gate=()=>{let resolve;return {promise:new Promise(done=>{resolve=done;}),resolve};};

test('actual native session lists compact metadata and reads only the selected complete original',async t=>{
  const records=Array.from({length:12},(_,i)=>record(i,('原件'+i+'\r\n😀').repeat(8000))),f=await collectionIndexFixture(t,records),session=await f.open();
  const page=await session.list({cursor:null,limit:5});assert.equal(page.total,12);assert.equal(page.items.length,5);assert.equal(f.bodyReads,0);assert.equal(f.uploads,0);
  assert.equal(f.calls.length,2,'one native index head plus one compact index');
  f.reset();const selected=await session.get(records[5].id);assert.deepEqual(selected.record,records[5]);assert.equal(f.bodyReads,1);assert.equal(f.calls.length,1);
  f.reset();assert.equal((await session.list({cursor:page.nextCursor,limit:5})).items.length,5);assert.equal(f.calls.length,0);
  assert.equal((await session.get('missing-item')).record,null);assert.equal(f.calls.length,0);
});

test('inventory, cleanup, restore and batch capabilities do not fetch or hydrate any original',async t=>{
  const f=await collectionIndexFixture(t,[record(1,'文本😀'),record(2,'另一个正文')]),s=await f.open();
  const inventory=await s.inventory();assert.equal(inventory.count,2);assert.equal(inventory.textBytes,Buffer.byteLength('文本😀另一个正文'));
  assert.equal(inventory.bytes,nativeCollectionLogicalBytes((await f.readIndex()).value));
  assert.equal((await s.cleanupPlan()).items.length,2);assert.ok((await s.restoreInfo()).remainingRecords>0);assert.equal((await s.batchInfo()).maxItems,32);
  assert.equal(f.bodyReads,0);assert.equal(f.uploads,0);
});

test('search covers text beyond the preview, pages complete results and never writes originals',async t=>{
  const f=await collectionIndexFixture(t,[record(1,'开头'.repeat(200)+'末尾关键词'),record(2,'第二份末尾关键词'),record(3,'不匹配')]),s=await f.open();
  const first=await s.list({cursor:null,limit:1,search:'末尾关键词'});assert.equal(first.total,2);assert.equal(first.items.length,1);assert.equal(f.bodyReads,3);
  const next=await s.list({cursor:first.nextCursor,limit:1,search:'末尾关键词'});assert.equal(next.items.length,1);assert.notEqual(next.items[0].id,first.items[0].id);assert.equal(next.nextCursor,null);
  f.reset();assert.equal((await s.list({cursor:null,limit:50,search:'CHAR'})).total,3);assert.equal(f.bodyReads,0);assert.equal(f.uploads,0);
});

test('full backup reads every complete original and remains independent of its deleted source chat',async t=>{
  const records=[record(1,'完整\r\n😀'.repeat(2000)),record(2)],f=await collectionIndexFixture(t,records),s=await f.open();
  const backup=(await s.snapshot()).backup;assert.deepEqual(backup.records,records);assert.equal(backup.sourceAccount,account);assert.equal(f.bodyReads,2);assert.equal(f.uploads,0);
});

for(const operation of ['get','search','backup'])test(`missing original is an explicit ${operation} failure, not an empty or partial result`,async t=>{
  const f=await collectionIndexFixture(t,[record(1),record(2)]),s=await f.open(),ref=f.descriptors[1].original;
  f.files.delete(`qianmu-v2-${ref.scope}-${ref.slot}-${ref.fingerprint}.json`);
  assert.equal((await s.list()).total,2,'metadata is independently readable');
  await assert.rejects(operation==='get'?s.get(f.records[1].id):operation==='search'?s.list({cursor:null,limit:50,search:'原文'}):s.snapshot(),{code:'st_account_storage_missing'});
  assert.equal(f.uploads,0);
});

test('new-format edits persist only one changed original plus its compact index, keeping all other versions',async t=>{
  const f=await collectionIndexFixture(t,[record(1,'旧正文'.repeat(9000)),record(2,'不变的正文'.repeat(9000))]),s=await f.open(),before=new Map(f.files);
  const edit=s.prepareEdit(f.records[0].id,1,'新的单条正文'),ack=await edit.submit();assert.equal(ack.revision,2);assert.equal(f.uploads,3,'one original, index body, index head');
  const current=(await f.readIndex()).value;assert.equal(current.version,2);assert.equal(Object.hasOwn(current.entries[0],'record'),false);
  assert.deepEqual(current.entries[1],f.descriptors[1]);assert.deepEqual((await s.get(f.records[0].id)).record.text,'新的单条正文');
  assert.deepEqual(await f.originals.read(f.descriptors[0]),entry(f.records[0]));
  for(const [name,body]of before)if(!name.endsWith('-collections.json'))assert.equal(f.files.get(name),body);
  const writes=f.uploads;assert.deepEqual(await edit.submit(),ack);assert.equal(f.uploads,writes,'receipt retry does not preserve another body or rewrite the index');
});

test('indexed create, restore and delete retain stable identities, source metadata and tombstones',async t=>{
  const f=await collectionIndexFixture(t),s=await f.open(),created=record(2);await s.prepareCreate(created).submit();
  const restore=s.prepareRestore(created,'restored-item');await restore.submit();const restored=(await s.get('restored-item')).record;
  assert.equal(restored.ownerAccount,account);assert.equal(restored.restoredFrom.id,created.id);assert.equal(restored.source.charName,created.source.charName);
  f.reset();await s.prepareDelete(created.id,1).submit();assert.equal(f.uploads,2,'deletion publishes the index only');
  assert.equal((await s.get(created.id)).record,null);const state=(await f.readIndex()).value,tombstone=state.entries.find(row=>row.id===created.id);
  assert.deepEqual(tombstone,{id:created.id,revision:2,updatedAt:tombstone.updatedAt,deleted:true,record:null});assert.equal((await s.inventory()).deletedCount,1);
});

test('stale indexed edits and mutation-id payload changes cannot upload replacement originals',async t=>{
  const f=await collectionIndexFixture(t),a=await f.open(),b=await f.open(),id=f.records[0].id;await a.list();
  const op=b.prepareEdit(id,1,'远端新内容');await op.submit();f.reset();
  await assert.rejects(a.prepareEdit(id,1,'旧版本覆盖').submit(),{code:'text_collection_sync_conflict'});assert.equal(f.uploads,0);
  await assert.rejects(a.resumePending({...op.request,text:'修改同一操作'}).submit(),{code:'text_collection_sync_mutation_conflict'});assert.equal(f.uploads,0);
  assert.equal((await a.get(id,{forceRefresh:true})).record.text,'远端新内容');
});

test('accepted indexed head with lost acknowledgement reconciles the same operation without another upload',async t=>{
  const f=await collectionIndexFixture(t),s=await f.open(),op=s.prepareEdit(f.records[0].id,1,'已落盘但回执丢失');await s.list();f.loseIndexAck();
  await assert.rejects(op.submit(),e=>e.writeState==='unconfirmed');const writes=f.uploads,ack=await op.submit();
  assert.equal(ack.revision,2);assert.equal(f.uploads,writes);assert.equal((await s.get(f.records[0].id)).record.text,'已落盘但回执丢失');
});

test('index upload failure preserves the old library and uploaded original without returning success',async t=>{
  const f=await collectionIndexFixture(t),s=await f.open(),before=(await f.readIndex()).value;
  f.hook(({path,request})=>{if(path==='/api/files/upload'){const body=JSON.parse(Buffer.from(JSON.parse(request.body).data,'base64').toString('utf8'));
    if(body.slot==='collections')throw Error('index offline');}});
  await assert.rejects(s.prepareEdit(f.records[0].id,1,'仅原件已保全').submit());f.hook(null);
  assert.deepEqual((await f.readIndex()).value,before);assert.ok([...f.files.values()].some(body=>body.includes('仅原件已保全')));
  assert.equal((await s.get(f.records[0].id)).record.text,f.records[0].text);
});

test('concurrent index replacement while preserving an original rejects the old publication',async t=>{
  const f=await collectionIndexFixture(t),s=await f.open(),prior=await f.readIndex();let replaced=false;
  const remote=await f.originals.preserve(entry({...f.records[0],revision:2,updatedAt:20,text:'远端已编辑'}));
  f.hook(async({path,request})=>{if(!replaced&&request.method==='GET'&&path.includes('-collection-record-')){
    replaced=true;f.hook(null);await f.storage.write('collections',{...prior.value,revision:prior.value.revision+1,entries:[remote],migration:{remote:'kept'}},{expectedFingerprint:prior.fingerprint});}});
  await assert.rejects(s.prepareEdit(f.records[0].id,1,'不覆盖远端目录').submit(),{code:'text_collection_sync_conflict'});
  const state=(await f.readIndex()).value;assert.deepEqual(state.migration,{remote:'kept'});assert.deepEqual(state.entries,[remote]);
});

test('concurrent independent indexed edits merge through the native library queue without losing either change',async t=>{
  const f=await collectionIndexFixture(t,[record(1),record(2)]),a=await f.open(),b=await f.open();await a.list();await b.list();
  const results=await Promise.all([a.prepareEdit(f.records[0].id,1,'第一条修改').submit(),b.prepareEdit(f.records[1].id,1,'第二条修改').submit()]);
  assert.ok(results.every(row=>row.revision===2));assert.equal((await f.readIndex()).value.revision,4);
  assert.equal((await a.get(f.records[0].id,{forceRefresh:true})).record.text,'第一条修改');assert.equal((await b.get(f.records[1].id,{forceRefresh:true})).record.text,'第二条修改');
});

test('indexed batch deletion prevalidates all target revisions before publishing anything',async t=>{
  const f=await collectionIndexFixture(t,[record(1),record(2)]),s=await f.open();
  const a=s.prepareDelete(f.records[0].id,1),b=s.prepareDelete(f.records[1].id,2);
  await assert.rejects(s.prepareBatch([a.request,b.request]).submit(),{code:'text_collection_sync_conflict'});assert.equal(f.uploads,0);
  const proper=s.prepareDelete(f.records[1].id,1);const result=await s.prepareBatch([a.request,proper.request]).submit();assert.equal(result.results.length,2);
  assert.equal((await s.list()).total,0);assert.equal((await s.inventory()).deletedCount,2);assert.equal(f.uploads,2);
});

test('legacy-to-index upgrade in another client never gets overwritten by an old-format writer',async t=>{
  const f=await collectionIndexFixture(t),old={version:1,expectedAccount:account,revision:1,entries:[entry(f.records[0])],receipts:[]};await f.writeIndex(old);
  const s=await f.open();await s.list();await f.writeIndex({...old,version:2,entries:f.descriptors});f.reset();
  await s.prepareEdit(f.records[0].id,1,'升级后的编辑').submit();assert.equal((await f.readIndex()).value.version,2);
  assert.equal((await s.get(f.records[0].id)).record.text,'升级后的编辑');
});

test('a compact library keeps the logical byte cap and rejects foreign references before reading originals',async t=>{
  const f=await collectionIndexFixture(t),saved=(await f.readIndex()).value;
  for(const change of [value=>value.entries[0].original.scope='f'.repeat(64),value=>value.future='unknown-index-field']){
    const bad=structuredClone(saved);change(bad);await f.writeIndex(bad);f.reset();const s=await f.open();await assert.rejects(s.list());assert.equal(f.bodyReads,0);s.close();
  }
  const big={...saved,revision:120,entries:Array.from({length:120},(_,i)=>{const row=structuredClone(saved.entries[0]);row.id=row.summary.id='collection-'+String(i).padStart(4,'0');row.recordBytes=600000;row.textBytes=599000;row.original.bytes=601000;return row;})};
  assert.throws(()=>validateNativeCollectionDocument(big,{expectedAccount:account,scope:f.storage.scope}),{code:'text_collection_sync_capacity'});
});

for(const mode of ['abort','close','account','refresh'])test(`late original ${mode} cannot return stale content or publish any index`,async t=>{
  const f=await collectionIndexFixture(t),s=await f.open();await s.list();const entered=gate(),release=gate(),controller=new AbortController();
  f.hook(async({path})=>{if(path.includes('-collection-record-')){entered.resolve();await release.promise;}});
  const pending=s.get(f.records[0].id,{signal:controller.signal}),rejected=assert.rejects(pending);await entered.promise;
  if(mode==='abort')controller.abort();if(mode==='close')s.close();if(mode==='account')f.setAccount('st-user:other');if(mode==='refresh')s.invalidateReadCache();
  release.resolve();await rejected;assert.equal(f.uploads,0);
});

test('cancelling complete-text search stops before the remaining originals and returns no partial page',async t=>{
  const f=await collectionIndexFixture(t,[record(1),record(2),record(3)]),s=await f.open(),controller=new AbortController();
  f.hook(({path})=>{if(path.includes('-collection-record-'))controller.abort();});
  await assert.rejects(s.list({cursor:null,limit:50,search:'正文'},{signal:controller.signal}));assert.equal(f.bodyReads,1);assert.equal(f.uploads,0);
});

test('indexed bulk restore preserves full originals and reconciles all receipts without publishing duplicate entries',async t=>{
  const f=await collectionIndexFixture(t),s=await f.open(),source=record(2,'完整待恢复正文😀');
  const batch=s.prepareBatch([s.prepareRestore(source,'restored-one').request,s.prepareRestore(source,'restored-two').request]);
  const result=await batch.submit();assert.equal(result.results.length,2);assert.equal(f.uploads,4,'two originals plus one index body/head');
  const writes=f.uploads;assert.deepEqual(await batch.submit(),result);assert.equal(f.uploads,writes);assert.equal((await s.list()).total,3);
  for(const id of ['restored-one','restored-two'])assert.equal((await s.get(id)).record.text,source.text);
});

test('cancelling after a new original upload leaves the old index intact and never publishes a partial edit',async t=>{
  const f=await collectionIndexFixture(t),s=await f.open(),before=(await f.readIndex()).value,controller=new AbortController();let uploaded=false;
  f.hook(({path,request})=>{
    if(path==='/api/files/upload'){const body=JSON.parse(Buffer.from(JSON.parse(request.body).data,'base64').toString('utf8'));if(body.slot==='collection-record')uploaded=true;}
    else if(uploaded&&path.includes('-collection-record-'))controller.abort();
  });
  await assert.rejects(s.prepareEdit(f.records[0].id,1,'原件保留，目录不发布').submit({signal:controller.signal}));f.hook(null);
  assert.equal(uploaded,true);assert.equal(f.uploads,1);assert.deepEqual((await f.readIndex()).value,before);
  assert.ok([...f.files.values()].some(body=>body.includes('原件保留，目录不发布')));
});
