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
  const record={id:'image',chatKey:'chat',snapshotRef:base},rows=[record],writes=[];
  const c=vm.createContext({preserveCapturedSnapshotArchives,getChatKey:()=> 'chat',storyboardSnapshotEpoch:0,
    storyboardGalleryRecords:()=>rows,sanitizeStoryboardSnapshot:structuredClone,clone:()=>assert.fail('no duplicate full-recipe memory cache'),
    console:{warn(){}},storyboardSnapshotArchiveBusy:0,storyboardScheduleGalleryPreservation:()=>{},storyboardPackageArchiveAllowed:async()=>true,saveMetadata:async()=>{},
    storyboardRecipeArchiveClient:async()=>({preserve:async()=>({reference:{id:'confirmed-test-reference'}}),read:async()=>({snapshot:{prompt:'edited'}}),guard:async()=>true,guardIdentity:async()=>true,close(){}}),
    ctx:()=>({chatMetadata:null}),loadLocalChunk:async()=>({readCurrentGalleryLocalRecipe:async()=>{throw Error('请核对旧配方');}}),
    blobStore:{blobStoreAvailable:()=>true,putStoryboardSnapshots:async(records,options)=>{
      assert.equal(options.preserveExisting,true);writes.push(structuredClone(records));return {stored:[revision]};
    },getStoryboardSnapshots:()=>assert.fail('entry must not perform an unscoped batch read')}});
  vm.runInContext(['storyboardRecordChatKey','storyboardSnapshotKey','storyboardSnapshotForRecord','storyboardReadSnapshotForRecord',
    'storyboardStoreSnapshotForRecord','storyboardArchiveGallerySnapshots'].map(section).join('\n'),c);
  return {record,rows,writes,c};
}

test('actual prompt edit and automatic archival retain exact durable recipes without a duplicate memory cache',async()=>{
  for(const automatic of [false,true]) {
    const e=fixture();e.record.snapshot={prompt:'edited'};
    const result=automatic?await e.c.storyboardArchiveGallerySnapshots():await e.c.storyboardStoreSnapshotForRecord(e.record,e.record.snapshot);
    assert.equal(result,automatic?1:true);assert.equal(e.record.snapshotRef,revision);
    if(!automatic){assert.equal(e.record.snapshot.prompt,'edited');await e.c.saveMetadata();assert.equal(await e.c.storyboardArchiveGallerySnapshots(),1);}
    assert.equal(e.record.snapshot,undefined);
    assert.ok(e.writes.length);assert.ok(e.writes.every(rows=>rows[0].snapshot.prompt==='edited'));
    assert.equal((await e.c.storyboardReadSnapshotForRecord(e.record)).prompt,'edited');
    await assert.rejects(e.c.storyboardReadSnapshotForRecord({id:'image',chatKey:'chat',snapshotRef:base}),/核对旧配方/);
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
    assert.ok(e.record.snapshot);assert.equal(e.record.snapshotRef,base);
    if(mode==='mutate'||mode==='replace')assert.equal(e.record.snapshot.prompt,'newer');
  }
});

test('large gallery metadata iteration does not read recipes; one explicit action reads only its own reference',async()=>{
  const e=fixture(),reads=[];e.record.snapshotRef=revision;
  e.rows.push(...Array.from({length:5000},(_,i)=>({id:'old-'+i,chatKey:'chat',snapshotRef:'chat␟old-'+i})));
  const before=JSON.stringify(e.rows);
  e.c.loadLocalChunk=async()=>({readCurrentGalleryLocalRecipe:async({record})=>{reads.push(record.snapshotRef);return {prompt:'chosen'};}});
  for(const row of e.rows)assert.equal(e.c.storyboardSnapshotForRecord(row),null);
  assert.deepEqual(reads,[]);assert.deepEqual(e.writes,[]);
  assert.equal((await e.c.storyboardReadSnapshotForRecord(e.record)).prompt,'chosen');
  assert.deepEqual(reads,[revision]);assert.equal(JSON.stringify(e.rows),before);
});

test('unrecorded recipes never invent a base-key reference or borrow an unscoped cache',async()=>{
  const e=fixture();delete e.record.snapshotRef;const before=structuredClone(e.record);
  e.c.blobStore.getStoryboardSnapshots=()=>assert.fail('unrecorded source must not read cache');
  assert.equal(await e.c.storyboardReadSnapshotForRecord(e.record),null);assert.deepEqual(e.record,before);
});

test('chat changes during lazy recipe loader import cannot switch the borrowed source',async()=>{
  const e=fixture();let release;e.c.loadLocalChunk=()=>new Promise(resolve=>{release=resolve;});
  const work=e.c.storyboardReadSnapshotForRecord(e.record);e.c.storyboardSnapshotEpoch++;
  release({readCurrentGalleryLocalRecipe:()=>assert.fail('must stop before new source is borrowed')});await assert.rejects(work,/来源已变化/);
});
