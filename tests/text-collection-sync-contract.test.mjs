import test from 'node:test';
import assert from 'node:assert/strict';
import {createTextCollection} from '../qianmu-text-collection.js';
import {textCollectionSyncMutation,textCollectionSyncEntry,applyTextCollectionMutation} from '../qianmu-text-collection-sync-contract.js';

const account=`st-user:${'a'.repeat(64)}`,other=`st-user:${'b'.repeat(64)}`;
const make=()=>createTextCollection({id:'collection-1',source:{account,chatId:'chat-1',messageId:0,replyId:'reply-1',charName:'角色',userName:'读者',text:'不收藏\r\n记念😀\n也不收藏'},mode:'selection',start:5,end:9,createdAt:100});
const create=()=>({version:1,expectedAccount:account,mutationId:'mutation-1',operation:'create',id:'collection-1',baseRevision:0,record:make()});
const change=(operation,extra={})=>({version:1,expectedAccount:account,mutationId:'mutation-2',operation,id:'collection-1',baseRevision:1,...extra});
const entry=()=>applyTextCollectionMutation(null,create(),200);
const contract={code:'text_collection_sync_contract'},conflict={code:'text_collection_sync_conflict'};

test('stored selection owns only selected text and frozen source snapshots, never the chat',()=>{
  const request=create(),saved=entry();
  assert.equal(saved.record.text,'记念😀');
  assert.doesNotMatch(JSON.stringify(saved),/不收藏/);
  assert.equal(saved.record.source.charName,'角色');
  assert.equal('text' in saved.record.source,false);
  assert.deepEqual(textCollectionSyncMutation(request),request);
  for(const value of [saved,saved.record,saved.record.source,saved.record.range])assert.ok(Object.isFrozen(value));
});

test('only create may supply metadata; wrong account and altered initial versions fail closed',()=>{
  for(const value of [{...create(),expectedAccount:other},{...create(),id:'other-id'},{...create(),baseRevision:1},
    {...create(),record:{...make(),revision:2}},{...create(),record:{...make(),updatedAt:101}},{...create(),apiKey:'secret'}])assert.throws(()=>textCollectionSyncMutation(value),contract);
  assert.throws(()=>textCollectionSyncMutation(change('edit',{text:'edit',record:make()})),contract);
  assert.throws(()=>textCollectionSyncEntry(entry(),other),contract);
});

test('edit increments one record revision without changing names, original date, range or source',()=>{
  const before=entry(),after=applyTextCollectionMutation(before,change('edit',{text:' 自己修订\r\n😀 '}),50);
  assert.equal(after.revision,2);assert.equal(after.updatedAt,101);assert.equal(after.record.text,' 自己修订\r\n😀 ');
  assert.deepEqual(after.record.source,before.record.source);assert.deepEqual(after.record.range,before.record.range);
  assert.equal(after.record.createdAt,100);assert.equal(before.record.text,'记念😀');
  assert.throws(()=>applyTextCollectionMutation(after,change('edit',{text:'stale'}),300),conflict);
  assert.throws(()=>applyTextCollectionMutation(before,change('edit',{text:'x',id:'another-id'}),300),contract);
});

test('delete removes text and provenance from tombstones and rejects old-client resurrection',()=>{
  const tombstone=applyTextCollectionMutation(entry(),change('delete'),300);
  assert.deepEqual(tombstone,{id:'collection-1',revision:2,updatedAt:300,deleted:true,record:null});
  assert.doesNotMatch(JSON.stringify(tombstone),/角色|记念|chat-1/);
  assert.throws(()=>applyTextCollectionMutation(tombstone,create(),400),conflict);
  assert.throws(()=>applyTextCollectionMutation(tombstone,change('edit',{text:'revive',baseRevision:2}),400),conflict);
  assert.throws(()=>textCollectionSyncMutation(change('delete',{text:'should not be transmitted'})),contract);
  assert.throws(()=>textCollectionSyncEntry({...tombstone,record:make()},account),contract);
});

test('strict inputs reject unknown actions, blank or broken text and unconfirmed edits/deletion',()=>{
  for(const value of [change('delete',{baseRevision:0}),change('edit',{text:'x',baseRevision:0}),change('merge'),
    change('edit',{text:''}),change('edit',{text:'\ud800'}),change('edit',{text:'x'.repeat(200001)}),change('delete',{mutationId:'short'}),
    change('delete',{id:'../../outside'}),change('delete',{baseRevision:1.5}),change('delete',{version:2})])assert.throws(()=>textCollectionSyncMutation(value),contract);
  assert.throws(()=>applyTextCollectionMutation(null,change('delete'),200),conflict);
  assert.throws(()=>applyTextCollectionMutation(entry(),create(),200),conflict);
});

test('clock and revision overflow preserve the original instead of wrapping',()=>{
  assert.throws(()=>applyTextCollectionMutation(entry(),change('delete'),NaN),{code:'text_collection_sync_clock'});
  const full=entry(),max=Number.MAX_SAFE_INTEGER;
  const current={...full,revision:max,record:{...full.record,revision:max}};
  assert.throws(()=>applyTextCollectionMutation(current,change('delete',{baseRevision:max}),300),{code:'text_collection_sync_clock'});
  const last={...full,updatedAt:253402214400000,record:{...full.record,updatedAt:253402214400000}};
  assert.throws(()=>applyTextCollectionMutation(last,change('delete'),200),{code:'text_collection_sync_clock'});
});
