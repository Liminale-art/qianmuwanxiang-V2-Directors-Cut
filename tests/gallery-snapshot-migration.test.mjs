import {test as nodeTest} from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {migrateGallerySnapshots,GALLERY_SNAPSHOT_BATCH} from '../qianmu-gallery-snapshot-migration.js';
import {storyboardFunctionSource as fn} from './helpers/storyboard-form-fixture.mjs';
const test=(name,run)=>nodeTest(name,{timeout:15000},run);

const rows=(n,size=8)=>Array.from({length:n},(_,i)=>({id:'image-'+i,chatKey:'chat',snapshot:{prompt:'p'+i,body:'x'.repeat(size)},future:{keep:true}}));
function fixture(records=rows(19)){
  const e={records,chat:'chat',epoch:1,time:0,events:[],writes:[],saves:[],errors:[],active:0,maxActive:0,normalized:0};
  const options={readRecords:()=>e.records,readChatKey:()=>e.chat,readEpoch:()=>e.epoch,available:()=>true,admit:async()=>true,now:()=>e.time,
    recordChatKey:row=>row.chatKey,recordKey:row=>'chat␟'+row.id,normalize:snapshot=>{e.normalized++;e.events.push('normalize');return structuredClone(snapshot);},
    yieldWork:async()=>{e.events.push('yield');},onError:error=>e.errors.push(error),
    connect:async()=>{
      e.active++;e.maxActive=Math.max(e.maxActive,e.active);e.events.push('connect');
      return {preserve:async row=>{e.events.push('preserve:'+row.id);return {reference:{version:1,id:row.id}};},guard:async()=>{},guardIdentity:async()=>{},close(){e.active--;e.events.push('close');}};
    },
    put:async(records,options)=>{assert.equal(options.preserveExisting,true);e.writes.push(structuredClone(records));e.events.push('put');return {stored:records.map(row=>row.key)};},
    save:async()=>{e.events.push('save');e.saves.push(structuredClone(e.records));}};
  e.options=options;e.run=records=>migrateGallerySnapshots(records||e.records,options);return e;
}
test('all 19 originals migrate across bounded 8/8/3 batches with fresh server proof and yields, without library clipping',async()=>{
  const e=fixture(),before=structuredClone(e.records);assert.equal(await e.run(),19);
  assert.deepEqual(e.writes.map(rows=>rows.length),[8,8,3]);assert.equal(e.saves.length,3);assert.equal(e.active,0);assert.equal(e.maxActive,1);
  assert.equal(e.events.filter(event=>event==='connect').length,3);assert.ok(e.events.filter(event=>event==='yield').length>=19);
  assert.ok(e.events.indexOf('normalize')>e.events.indexOf('preserve:image-0'));
  assert.deepEqual(e.writes.flat().map(row=>row.snapshot),before.map(row=>row.snapshot));
  assert.equal(e.records.length,19);assert.ok(e.records.every(row=>!row.snapshot&&row.snapshotServerRef));assert.deepEqual(e.records.map(row=>row.future),before.map(row=>row.future));
});
test('UTF-8 recipe bytes split a batch before the count ceiling and keep every original',async()=>{
  const e=fixture(rows(3));e.records.forEach(row=>row.snapshot.body='汉'.repeat(300000));assert.equal(await e.run(),3);
  assert.deepEqual(e.writes.map(rows=>rows.length),[2,1]);assert.ok(e.writes.every(rows=>rows.reduce((n,row)=>n+Buffer.byteLength(JSON.stringify(row.snapshot)),0)<=GALLERY_SNAPSHOT_BATCH.bytes));
});
test('5001 inline recipes are not normalized or serialized by migration before unavailable storage or server admission',async()=>{
  for(const failure of ['storage','admission','server']){
    const e=fixture(rows(5001));for(const row of e.records)row.snapshot.toJSON=()=>assert.fail('eager whole-library serialization');
    if(failure==='storage')e.options.available=()=>false;
    if(failure==='admission')e.options.admit=async()=>false;
    if(failure==='server')e.options.connect=async()=>{throw Error('unavailable');};
    assert.equal(await e.run(),0);assert.equal(e.normalized,0);assert.equal(e.writes.length,0);assert.equal(e.saves.length,0);
    assert.ok(e.records.every(row=>row.snapshot));
  }
});
test('single over-budget recipe remains complete and is never normalized or submitted',async()=>{
  const e=fixture(rows(1,GALLERY_SNAPSHOT_BATCH.bytes+1)),original=e.records[0].snapshot;assert.equal(await e.run(),0);
  assert.equal(e.records[0].snapshot,original);assert.equal(e.normalized,0);assert.equal(e.writes.length,0);assert.equal(e.events.some(event=>event.startsWith('preserve:')),false);
});
test('partial proof failure commits only already confirmed recipes and leaves the failed and later originals untouched',async()=>{
  const e=fixture(rows(4)),before=structuredClone(e.records),connect=e.options.connect;
  e.options.connect=async()=>{const client=await connect(),preserve=client.preserve;client.preserve=row=>row.id==='image-2'?Promise.reject(Error('offline')):preserve(row);return client;};
  assert.equal(await e.run(),2);assert.deepEqual(e.records.slice(2),before.slice(2));assert.equal(e.normalized,2);assert.equal(e.active,0);
  e.options.connect=connect;assert.equal(await e.run(),2);assert.ok(e.records.every(row=>!row.snapshot));
});
test('the 15-second cooperative deadline leaves pending recipes inline and a later event resumes them',async()=>{
  const e=fixture(rows(3)),connect=e.options.connect;e.options.connect=async()=>{const client=await connect(),preserve=client.preserve;client.preserve=async row=>{const result=await preserve(row);e.time+=16000;return result;};return client;};
  assert.equal(await e.run(),1);assert.ok(e.records[1].snapshot);assert.equal(e.normalized,1);
  e.options.connect=connect;assert.equal(await e.run(),2);
});
test('expiration while yielding stops before reading or submitting another recipe',async()=>{
  const e=fixture(rows(2));e.options.yieldWork=async()=>{e.time+=16000;};assert.equal(await e.run(),0);assert.equal(e.events.includes('connect'),false);assert.equal(e.normalized,0);
});
for(const kind of ['epoch','chat','gallery'])test(`a ${kind} switch while connecting leaves the original gallery untouched`,async()=>{
  const e=fixture(),original=e.records,before=structuredClone(original),connect=e.options.connect;
  e.options.connect=async()=>{const client=await connect();if(kind==='epoch')e.epoch++;if(kind==='chat')e.chat='next';if(kind==='gallery')e.records=rows(1);return client;};
  assert.equal(await e.run(),0);assert.deepEqual(original,before);assert.equal(e.normalized,0);assert.equal(e.active,0);
});
test('activity admission is checked before every batch and preserves the unstarted remainder',async()=>{
  const e=fixture();let checks=0;e.options.admit=async()=>++checks<3;assert.equal(await e.run(),8);
  assert.equal(checks,3);assert.ok(e.records.slice(8).every(row=>row.snapshot));assert.equal(e.active,0);
});
test('later batch save failure restores just that batch, with earlier durable batches still intact',async()=>{
  const e=fixture(),before=structuredClone(e.records),save=e.options.save;let writes=0;
  e.options.save=async()=>{if(++writes===2)throw Error('ST failure');return save();};assert.equal(await e.run(),8);
  assert.ok(e.records.slice(0,8).every(row=>!row.snapshot&&row.snapshotServerRef));assert.deepEqual(e.records.slice(8),before.slice(8));
  e.options.save=save;assert.equal(await e.run(),11);
});
test('a user edit during failed save wins over rollback and absent metadata stays absent',async()=>{
  const e=fixture(rows(2));delete e.records[0].chatKey;e.options.recordChatKey=()=> 'chat';const first=e.records[0].snapshot,newer={prompt:'later'};
  e.options.save=async()=>{e.records[1].snapshot=newer;throw Error('failed');};assert.equal(await e.run(),0);
  assert.equal(e.records[0].snapshot,first);assert.equal(Object.hasOwn(e.records[0],'chatKey'),false);assert.equal(Object.hasOwn(e.records[0],'snapshotRef'),false);assert.equal(e.records[1].snapshot,newer);
});
test('same-gallery calls serialize, do not duplicate writes and release their lane after completion',async()=>{
  const e=fixture(rows(2));let release,entered,firstConnect=true;const gate=new Promise(resolve=>entered=resolve),connect=e.options.connect;
  e.options.connect=async()=>{if(firstConnect){firstConnect=false;entered();await new Promise(resolve=>release=resolve);}return connect();};
  const first=e.run([e.records[0]]);await gate;const second=e.run();e.options.connect=connect;release();
  assert.deepEqual(await Promise.all([first,second]),[1,1]);assert.equal(e.writes.flat().length,2);assert.equal(e.maxActive,1);assert.equal(e.active,0);
  e.records.push(...rows(1).map(row=>({...row,id:'new'})));assert.equal(await e.run(),1);
});
test('another gallery is not blocked and a waiting old owner cannot publish after an epoch switch',async()=>{
  const e=fixture(rows(2)),other=fixture(rows(1));let release,entered;const gate=new Promise(resolve=>entered=resolve),connect=e.options.connect;
  e.options.connect=async()=>{entered();await new Promise(resolve=>release=resolve);return connect();};
  const first=e.run([e.records[0]]);await gate;const second=e.run();assert.equal(await other.run(),1);e.epoch++;release();
  assert.deepEqual(await Promise.all([first,second]),[0,0]);assert.ok(e.records.every(row=>row.snapshot));assert.equal(e.active,0);
});
test('actual entry delegates bounded batches, retains its busy lifecycle and schedules additive preservation',async()=>{
  const e=fixture(),c=vm.createContext({migrateGallerySnapshots,storyboardSnapshotArchiveBusy:0,storyboardSnapshotEpoch:1,Date,
    storyboardGalleryRecords:()=>e.records,getChatKey:()=>e.chat,storyboardPackageArchiveAllowed:e.options.admit,storyboardRecipeArchiveClient:e.options.connect,
    storyboardRecordChatKey:e.options.recordChatKey,storyboardSnapshotKey:e.options.recordKey,sanitizeStoryboardSnapshot:e.options.normalize,
    blobStore:{blobStoreAvailable:e.options.available,putStoryboardSnapshots:e.options.put},saveMetadata:e.options.save,console:{warn(){}},storyboardScheduleGalleryPreservation:()=>e.events.push('schedule')});
  vm.runInContext(fn('storyboardArchiveGallerySnapshots'),c);const work=c.storyboardArchiveGallerySnapshots();assert.equal(c.storyboardSnapshotArchiveBusy,1);
  assert.equal(await work,19);assert.equal(c.storyboardSnapshotArchiveBusy,0);assert.deepEqual(e.writes.map(rows=>rows.length),[8,8,3]);assert.equal(e.events.at(-1),'schedule');
});
test('malformed client capability and advertised batch without a batch writer cannot silently use legacy preservation',async()=>{
  for(const capability of [null,undefined,'true',true]){
    const e=fixture(rows(1)),connect=e.options.connect;
    e.options.connect=async()=>({...await connect(),supportsBatch:async()=>capability});
    assert.equal(await e.run(),0);assert.ok(e.records[0].snapshot);assert.equal(e.writes.length,0);assert.equal(e.saves.length,0);
    assert.equal(e.events.some(event=>event.startsWith('preserve:')),false);assert.equal(e.active,0);assert.equal(e.normalized,0);
  }
});
