import test from 'node:test';
import assert from 'node:assert/strict';
import {createTextCollection,textCollectionRecord,updateTextCollection,restoreTextCollectionCopy,TEXT_COLLECTION_LIMITS} from '../qianmu-text-collection.js';
import {textCollectionSyncMutation,applyTextCollectionMutation,textCollectionSyncResponse} from '../qianmu-text-collection-sync-contract.js';
import {createTextCollectionOutboxEntry} from '../qianmu-text-collection-outbox-store.js';
import {prepareTextCollectionBackup,validateTextCollectionBackup} from '../qianmu-text-collection-backup.js';
const account='st-user:'+'a'.repeat(64),source={account,chatId:'chat-1',messageId:0,replyId:'swipe:0',charName:'角色',userName:'读者',text:'PRIVATE\r\n原文😀\r\nHIDDEN'};
const make=(text,extra={})=>createTextCollection({id:'collection-1',source,mode:'selection',start:9,end:13,createdAt:10,...text===undefined?{}:{text},...extra});
test('pre-capture edit is explicit, retains real source offsets and never retains the unselected layer or old selected text',()=>{
 const record=make('另写一段\r\n😀');assert.equal(record.schemaVersion,3);assert.equal(record.captureEdited,true);assert.equal(record.text,'另写一段\r\n😀');assert.deepEqual(record.range,{start:9,end:13});assert.equal(record.source.textLength,source.text.length);assert.equal(record.revision,1);assert.equal(record.updatedAt,record.createdAt);
 assert.doesNotMatch(JSON.stringify(record),/PRIVATE|HIDDEN|原文/);assert.equal(source.text,'PRIVATE\r\n原文😀\r\nHIDDEN');assert.deepEqual(textCollectionRecord(JSON.parse(JSON.stringify(record))),record);
 assert.equal(make().schemaVersion,1);assert.equal(make('原文😀').schemaVersion,1);assert.equal(make('换字😀').schemaVersion,3,'same length is still an edit');
 const full=make('短句',{mode:'full',start:undefined,end:undefined});assert.equal(full.range.end,source.text.length);assert.equal(full.mode,'full');
});
test('edit marker cannot bypass source, Unicode, range or schema validation; legacy unedited length checks remain strict',()=>{
 for(const text of ['', '  ', '\ud800','\udc00','x\0y','x'.repeat(TEXT_COLLECTION_LIMITS.text+1)])assert.throws(()=>make(text));
 for(const change of [{captureEdited:false},{captureEdited:undefined},{schemaVersion:1},{source:{...make('new').source,text:'PRIVATE'}},{range:{start:0,end:999}},{mode:'full'}])assert.throws(()=>textCollectionRecord({...make('new'),...change}));
 const legacy=make();assert.throws(()=>textCollectionRecord({...legacy,text:'short'}));assert.throws(()=>make('new',{start:11,end:12}));
});
test('edited capture uses one first-revision create, queues its exact content, and backups/restored copies retain provenance without inventing prior saves',()=>{
 const record=make('修改后的收藏'),request=textCollectionSyncMutation({version:1,expectedAccount:account,mutationId:'mutation-1',operation:'create',id:record.id,baseRevision:0,record});
 assert.equal(createTextCollectionOutboxEntry(request,{queuedAt:11}).request.record.text,record.text);
 const entry=applyTextCollectionMutation(null,request,12);assert.equal(entry.revision,1);assert.deepEqual(entry.record,record);
 textCollectionSyncResponse({ok:true,version:1,expectedAccount:account,libraryRevision:1,mutationId:request.mutationId,id:record.id,revision:1,updatedAt:10},'write',request);
 const packageData=prepareTextCollectionBackup({sourceAccount:account,libraryRevision:1,records:[record],exportedAt:20});assert.deepEqual(validateTextCollectionBackup(JSON.parse(JSON.stringify(packageData.payload))).records[0],record);
 const edited=updateTextCollection(record,{text:'再次编辑'},1,21);assert.equal(edited.captureEdited,true);assert.equal(edited.revision,2);assert.deepEqual(edited.range,record.range);
 const restored=restoreTextCollectionCopy(edited,{id:'restored-1',ownerAccount:account,restoredAt:22});assert.equal(restored.schemaVersion,2);assert.equal('captureEdited' in restored,false);assert.equal(restored.text,'再次编辑');assert.equal(restored.restoredFrom.revision,2);assert.deepEqual(restored.range,record.range);
});
