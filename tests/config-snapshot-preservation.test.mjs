import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {storyboardFunctionSource as section} from './helpers/storyboard-form-fixture.mjs';
function fixture() {
  const record={id:'image',chatKey:'chat',snapshot:{prompt:'original'}},rows=[record],calls=[];
  const c=vm.createContext({getChatKey:()=> 'chat',storyboardSnapshotEpoch:0,storyboardSnapshotCache:new Map(),storyboardSnapshotReads:new Map(),
    storyboardGalleryRecords:()=>rows,sanitizeStoryboardSnapshot:structuredClone,clone:structuredClone,console:{warn(){}},
    storyboardPackageArchiveAllowed:async()=>true,saveMetadata:async()=>calls.push('metadata'),
    blobStore:{blobStoreAvailable:()=>true,putStoryboardSnapshots:async(_rows,options)=>{assert.equal(options.preserveExisting,true);calls.push('write');},
      deleteStoryboardSnapshots:()=>assert.fail('automatic archival must not delete older originals'),getStoryboardSnapshots:async()=>{calls.push('read');return [];}}});
  vm.runInContext(['storyboardRecordChatKey','storyboardSnapshotKey','storyboardArchiveGallerySnapshots','storyboardHydrateGallerySnapshots'].map(section).join('\n'),c);
  return {c,record,rows,calls};
}

test('automatic snapshot archival retains full inline content when preservation rejects a collision',async()=>{
  const e=fixture(),original=e.record.snapshot;
  e.c.blobStore.putStoryboardSnapshots=async(_rows,options)=>{assert.equal(options.preserveExisting,true);throw Error('collision');};
  assert.equal(await e.c.storyboardArchiveGallerySnapshots(),0);
  assert.equal(e.record.snapshot,original);assert.equal(e.record.snapshotRef,undefined);assert.equal(e.c.storyboardSnapshotCache.size,0);assert.deepEqual(e.calls,[]);
});

test('removed or edited records during archival are not stripped and do not authorize original deletion',async()=>{
  for(const change of ['remove','edit','epoch']) {
    const e=fixture(),original=e.record.snapshot;
    e.c.blobStore.putStoryboardSnapshots=async()=>{if(change==='remove')e.rows.length=0;else if(change==='edit')original.prompt='new edit';else e.c.storyboardSnapshotEpoch++;};
    assert.equal(await e.c.storyboardArchiveGallerySnapshots([e.record]),0);
    assert.equal(e.record.snapshot,original);assert.equal(e.c.storyboardSnapshotCache.size,0);assert.deepEqual(e.calls,[]);
  }
});

test('failed metadata save restores inline fallback only if no later user edit replaced it',async()=>{
  for(const edited of [false,true]) {
    const e=fixture(),original=e.record.snapshot,later={prompt:'later edit'};
    e.c.saveMetadata=async()=>{if(edited)e.record.snapshot=later;throw Error('metadata failure');};
    assert.equal(await e.c.storyboardArchiveGallerySnapshots(),0);
    assert.equal(e.record.snapshot,edited?later:original);
  }
  const e=fixture();assert.equal(await e.c.storyboardArchiveGallerySnapshots(),1);
  assert.equal(e.record.snapshot,undefined);assert.equal(e.record.snapshotRef,'chat␟image');assert.deepEqual(e.calls,['write','metadata']);
});

test('snapshot hydration does not adopt the next configuration epoch after awaiting migration',async()=>{
  const e=fixture();e.c.storyboardArchiveGallerySnapshots=async()=>{e.c.storyboardSnapshotEpoch++;};
  delete e.record.snapshot;e.record.snapshotRef='chat␟image';
  assert.equal(await e.c.storyboardHydrateGallerySnapshots(),0);assert.deepEqual(e.calls,[]);
});
