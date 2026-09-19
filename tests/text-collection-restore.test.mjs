import test from 'node:test';
import assert from 'node:assert/strict';
import {createTextCollection,updateTextCollection,textCollectionRecord,restoreTextCollectionCopy,textCollectionRecordAccount} from '../qianmu-text-collection.js';
import {textCollectionSyncMutation,applyTextCollectionMutation,textCollectionSyncEntry,textCollectionSyncResponse} from '../qianmu-text-collection-sync-contract.js';
import {prepareTextCollectionBackup,readTextCollectionBackupFile} from '../qianmu-text-collection-backup.js';
const account=`st-user:${'a'.repeat(64)}`,target=`st-user:${'b'.repeat(64)}`;
const original=()=>updateTextCollection(createTextCollection({id:'original-1',source:{account,chatId:'old-chat',messageId:0,replyId:'reply-1',charName:'旧角色',userName:'旧用户',text:'秘密前文\r\n摘录\r\n秘密后文'},mode:'selection',start:6,end:8,createdAt:10}),{text:'修改过的\r\n更长正文😀'},1,20);
const input=()=>({version:1,expectedAccount:target,mutationId:'restore-1',operation:'restore',id:'restored-1',baseRevision:0,record:original()});

test('restored copies separate destination ownership from unchanged origin and preserve edited body and dates',()=>{
  const source=original(),copy=restoreTextCollectionCopy(source,{id:'restored-1',ownerAccount:target,restoredAt:30});
  assert.equal(copy.schemaVersion,2);assert.equal(copy.revision,1);assert.equal(textCollectionRecordAccount(copy),target);assert.equal(copy.source.account,account);
  for(const key of ['source','range','text','createdAt','updatedAt','mode'])assert.deepEqual(copy[key],source[key]);
  assert.deepEqual(copy.restoredFrom,{account,id:'original-1',revision:2,restoredAt:30});assert.ok(Object.isFrozen(copy.restoredFrom));
  assert.equal(source.revision,2);assert.doesNotMatch(JSON.stringify(copy),/秘密/);assert.deepEqual(textCollectionRecord(JSON.parse(JSON.stringify(copy))),copy);
  const edited=updateTextCollection(copy,{text:'再次编辑'},1,31);assert.equal(edited.revision,2);assert.deepEqual(edited.restoredFrom,copy.restoredFrom);assert.deepEqual(edited.source,source.source);
});

test('restore cannot overwrite existing entries or masquerade as first capture; invalid provenance is rejected',()=>{
  const request=input(),entry=applyTextCollectionMutation(null,request,30);
  assert.throws(()=>textCollectionSyncMutation({...request,id:request.record.id}));assert.throws(()=>textCollectionSyncMutation({...request,baseRevision:1}));
  assert.throws(()=>textCollectionSyncMutation({...request,operation:'create',record:entry.record}));
  assert.throws(()=>applyTextCollectionMutation(entry,request,31),{code:'text_collection_sync_conflict'});
  assert.throws(()=>textCollectionSyncEntry(entry,account));
  for(const modify of [r=>{delete r.ownerAccount;},r=>{r.ownerAccount='bob';},r=>{r.restoredFrom.id=r.id;},r=>{r.restoredFrom.revision=0;},r=>{r.restoredFrom.apiKey='secret';},r=>{r.schemaVersion=1;},r=>{r.restoredFrom.restoredAt=NaN;}]){
    const value=structuredClone(entry.record);modify(value);assert.throws(()=>textCollectionRecord(value));
  }
  assert.throws(()=>textCollectionRecord({...original(),revision:1}),'ordinary capture length constraints remain strict');
});

test('restored copies round-trip through backup and a later restoration without remapping original chat provenance',async()=>{
  const first=applyTextCollectionMutation(null,input(),30).record;
  const result=prepareTextCollectionBackup({sourceAccount:target,libraryRevision:1,records:[first],exportedAt:40});
  assert.deepEqual((await readTextCollectionBackupFile(result.blob,{check:()=>{}})).records,[first]);
  assert.throws(()=>prepareTextCollectionBackup({sourceAccount:account,libraryRevision:1,records:[first]}));
  const again=restoreTextCollectionCopy(first,{id:'restored-2',ownerAccount:account,restoredAt:50});
  assert.deepEqual(again.source,original().source);assert.equal(again.text,original().text);assert.equal(again.createdAt,10);
  assert.deepEqual(again.restoredFrom,{account:target,id:'restored-1',revision:1,restoredAt:50});
});

test('restore acknowledgements bind the new ID and original modification date, not the capture date',()=>{
  const request=input(),entry=applyTextCollectionMutation(null,request,30),value={ok:true,version:1,expectedAccount:target,mutationId:request.mutationId,id:entry.id,revision:1,updatedAt:20,libraryRevision:1};
  assert.deepEqual(textCollectionSyncResponse(value,'write',request),value);assert.throws(()=>textCollectionSyncResponse({...value,updatedAt:10},'write',request));
  assert.equal(textCollectionSyncResponse({ok:true,version:1,expectedAccount:target,libraryRevision:1,record:entry.record},'get',{version:1,expectedAccount:target,id:entry.id}).record.source.account,account);
});

test('draft copies carry replacement text explicitly without inventing an accepted source revision',()=>{
  const request={...input(),text:'本机冲突修改\r\n保留😀'},copy=applyTextCollectionMutation(null,request,30).record;
  assert.equal(copy.text,request.text);assert.equal(copy.revision,1);assert.equal(copy.updatedAt,30);assert.equal(copy.createdAt,10);
  assert.deepEqual(copy.source,request.record.source);assert.deepEqual(copy.range,request.record.range);assert.equal(copy.restoredFrom.revision,request.record.revision);assert.equal(copy.restoredFrom.id,request.record.id);
  assert.deepEqual(textCollectionSyncMutation(request),request);assert.notEqual(request.record.text,request.text);
  const response={ok:true,version:1,expectedAccount:target,mutationId:request.mutationId,id:copy.id,revision:1,updatedAt:30,libraryRevision:1};
  textCollectionSyncResponse(response,'write',request);assert.throws(()=>textCollectionSyncResponse({...response,updatedAt:19},'write',request));
  for(const text of ['',null,undefined,'\ud800','x'.repeat(200001)])assert.throws(()=>textCollectionSyncMutation({...request,text}));
  assert.throws(()=>applyTextCollectionMutation({id:copy.id,revision:1,updatedAt:copy.updatedAt,deleted:false,record:copy},request,31),{code:'text_collection_sync_conflict'});
  assert.equal(applyTextCollectionMutation(null,request,1).record.updatedAt,request.record.updatedAt);
});
