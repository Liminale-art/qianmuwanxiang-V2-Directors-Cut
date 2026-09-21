import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {preserveCapturedSnapshotArchives} from '../qianmu-plan-archive-write.js';
import {storyboardFunctionSource as section} from './helpers/storyboard-form-fixture.mjs';

const base='chat␟image',revision=base+'␟revision:'+'a'.repeat(64);
const captured=()=>[{key:base,chatKey:'chat',recordId:'image',snapshot:{prompt:'original',payload:{seed:0}}}];

test('snapshot bridge requires immutable storage, clones payloads and adopts committed references',async()=>{
  const input=captured(),before=structuredClone(input);
  const result=await preserveCapturedSnapshotArchives(input,async(rows,options)=>{
    assert.equal(options.preserveExisting,true);assert.deepEqual(rows,input);
    rows[0].snapshot.prompt='writer copy';return {stored:[revision]};
  });
  assert.deepEqual(input,before);assert.equal(result[0].key,revision);assert.equal(result[0].snapshot.prompt,'original');
});

test('incomplete, sparse, reordered or unrelated snapshot references cannot discard inline data',async()=>{
  for(const result of [null,{}, {stored:[]},{stored:['']},{stored:['foreign']},{stored:[base,'extra']},
    {stored:[base+'␟revision:bad']},{stored:new Array(1)},{stored:[base+'␟revision:'+'A'.repeat(64)]}]){
    const input=captured();await assert.rejects(preserveCapturedSnapshotArchives(input,async()=>result),/归档返回位置不完整/);
    assert.equal(input[0].snapshot.prompt,'original');
  }
  await assert.rejects(preserveCapturedSnapshotArchives([...captured(),{...captured()[0],key:'another'}],async()=>({stored:['another',base]})),/归档返回位置不完整/);
});

function fixture() {
  const record={id:'image',chatKey:'chat',snapshotRef:base},rows=[record],cache=new Map([[base,{prompt:'old'}]]),writes=[];
  const c=vm.createContext({preserveCapturedSnapshotArchives,getChatKey:()=> 'chat',storyboardSnapshotEpoch:0,storyboardSnapshotCache:cache,
    storyboardSnapshotReads:new Map(),storyboardGalleryRecords:()=>rows,sanitizeStoryboardSnapshot:structuredClone,clone:structuredClone,
    console:{warn(){}},storyboardSnapshotArchiveBusy:0,storyboardScheduleGalleryPreservation:()=>{},storyboardPackageArchiveAllowed:async()=>true,saveMetadata:async()=>{},storyboardRecipeArchiveClient:async()=>{throw Error('old backend fixture');},
    blobStore:{blobStoreAvailable:()=>true,putStoryboardSnapshots:async(records,options)=>{
      assert.equal(options.preserveExisting,true);writes.push(structuredClone(records));return {stored:[revision]};
    },getStoryboardSnapshots:async()=>[{key:base,snapshot:{prompt:'old'}},{key:revision,snapshot:{prompt:'edited'}}]}});
  vm.runInContext(['storyboardRecordChatKey','storyboardSnapshotKey','storyboardSnapshotForRecord','storyboardReadSnapshotForRecord',
    'storyboardStoreSnapshotForRecord','storyboardArchiveGallerySnapshots','storyboardHydrateGallerySnapshots'].map(section).join('\n'),c);
  return {record,rows,cache,writes,c};
}

test('actual prompt edit and automatic archival use returned references without poisoning older cached recipes',async()=>{
  for(const automatic of [false,true]) {
    const e=fixture();e.record.snapshot={prompt:'edited'};
    const result=automatic?await e.c.storyboardArchiveGallerySnapshots():await e.c.storyboardStoreSnapshotForRecord(e.record,e.record.snapshot);
    assert.equal(result,automatic?1:true);assert.equal(e.record.snapshotRef,revision);
    if(!automatic){assert.equal(e.record.snapshot.prompt,'edited');await e.c.saveMetadata();assert.equal(await e.c.storyboardArchiveGallerySnapshots(),1);}
    assert.equal(e.record.snapshot,undefined);
    assert.equal(e.cache.get(base).prompt,'old');assert.equal(e.cache.get(revision).prompt,'edited');
    e.cache.clear();assert.equal((await e.c.storyboardReadSnapshotForRecord(e.record)).prompt,'edited');
    assert.equal((await e.c.storyboardReadSnapshotForRecord({id:'image',chatKey:'chat',snapshotRef:base})).prompt,'old');
  }
});

test('failed or incomplete explicit archive writes retain complete edited inline recipes and old references',async()=>{
  for(const mode of ['throw','missing','empty','foreign','unavailable']) {
    const e=fixture();e.c.blobStore.blobStoreAvailable=()=>mode!=='unavailable';
    e.c.blobStore.putStoryboardSnapshots=async()=>{
      if(mode==='throw')throw Error('quota');return mode==='missing'?undefined:{stored:mode==='empty'?[]:['foreign']};
    };
    assert.equal(await e.c.storyboardStoreSnapshotForRecord(e.record,{prompt:'edited',payload:{seed:0}}),false);
    assert.deepEqual(e.record.snapshot,{prompt:'edited',payload:{seed:0}});assert.equal(e.record.snapshotRef,base);
    assert.equal(e.cache.size,1);assert.equal(e.cache.get(base).prompt,'old');
  }
});

test('late explicit writes cannot strip or replace newer edits, record identities or chat epochs',async()=>{
  for(const mode of ['mutate','replace','id','epoch','chat']) {
    const e=fixture();e.c.blobStore.putStoryboardSnapshots=async()=>{
      if(mode==='mutate')e.record.snapshot.prompt='newer';
      if(mode==='replace')e.record.snapshot={prompt:'newer'};
      if(mode==='id')e.record.id='changed';
      if(mode==='epoch')e.c.storyboardSnapshotEpoch++;
      if(mode==='chat')e.c.getChatKey=()=> 'another chat';
      return {stored:[revision]};
    };
    assert.equal(await e.c.storyboardStoreSnapshotForRecord(e.record,{prompt:'edited'}),false);
    assert.ok(e.record.snapshot);assert.equal(e.record.snapshotRef,base);assert.equal(e.cache.size,1);
    if(mode==='mutate'||mode==='replace')assert.equal(e.record.snapshot.prompt,'newer');
  }
});

test('batch hydration continues to resolve explicit revision and legacy references separately',async()=>{
  const e=fixture();e.cache.clear();e.record.snapshotRef=revision;e.rows.push({id:'old-copy',chatKey:'chat',snapshotRef:base});
  assert.equal(await e.c.storyboardHydrateGallerySnapshots(e.rows,{migrate:false}),2);
  assert.equal(e.c.storyboardSnapshotForRecord(e.record).prompt,'edited');assert.equal(e.c.storyboardSnapshotForRecord(e.rows[1]).prompt,'old');
});

test('late reads of older references cannot roll back edited recipes or changed record identities',async()=>{
  for(const mode of ['reference','inline','id']) {
    const e=fixture();e.cache.clear();let release;
    e.c.blobStore.getStoryboardSnapshots=()=>new Promise(resolve=>{release=resolve;});
    const pending=e.c.storyboardReadSnapshotForRecord(e.record);
    if(mode==='reference')e.record.snapshotRef=revision;
    if(mode==='inline')e.record.snapshot={prompt:'newer inline'};
    if(mode==='id')e.record.id='changed';
    release([{key:base,snapshot:{prompt:'old'}}]);
    assert.equal(await pending,null);assert.equal(e.cache.size,0);
    assert.equal(e.record.snapshotRef,mode==='reference'?revision:base);
    if(mode==='inline')assert.equal(e.record.snapshot.prompt,'newer inline');
  }
});
