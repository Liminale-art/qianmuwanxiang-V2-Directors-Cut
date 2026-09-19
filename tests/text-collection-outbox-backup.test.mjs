import test from 'node:test';
import assert from 'node:assert/strict';
import {createTextCollection} from '../qianmu-text-collection.js';
import {createTextCollectionOutboxEntry,emptyTextCollectionOutbox} from '../qianmu-text-collection-outbox-store.js';
import {TEXT_COLLECTION_OUTBOX_BACKUP_BYTES,prepareTextCollectionOutboxBackup,validateTextCollectionOutboxBackup,readTextCollectionOutboxBackupFile,mergeTextCollectionOutboxBackup} from '../qianmu-text-collection-outbox-backup.js';
import {validateTextCollectionBackup} from '../qianmu-text-collection-backup.js';
const namespace='st-user:'+'a'.repeat(64),other='st-user:'+'b'.repeat(64),check=()=>{};
const original=()=>createTextCollection({id:'original-1',mode:'selection',start:3,end:5,createdAt:1,source:{account:namespace,chatId:'deleted-chat',messageId:0,replyId:'reply-1',charName:'旧角色',userName:'旧用户',text:'未选择片段不收录'}});
const state=()=>({...emptyTextCollectionOutbox(namespace),entries:[{...createTextCollectionOutboxEntry({version:1,expectedAccount:namespace,mutationId:'mutation-1',operation:'edit',id:'original-1',baseRevision:1,text:'本机\r\n冲突修改😀 <script>文字</script>'},{base:original(),queuedAt:2}),started:true,state:'conflict'}]});
const prepare=value=>prepareTextCollectionOutboxBackup(value||state(),{exportedAt:3});
test('pending backup preserves original request identity, draft and base without claiming a server revision',async()=>{
  const before=structuredClone(state()),result=prepare(before),read=await readTextCollectionOutboxBackupFile(result.blob,{check});assert.deepEqual(read,result.payload);assert.equal(result.count,1);
  assert.deepEqual(read.entries,before.entries);assert.equal(read.type,'qianmu-text-collection-outbox');assert.equal(Object.hasOwn(read,'libraryRevision'),false);assert.throws(()=>validateTextCollectionBackup(read));
  before.entries[0].base.source.charName='ignored';assert.equal(read.entries[0].base.source.charName,'旧角色');assert.ok(Object.isFrozen(read.entries[0].request));
  const raw=await result.blob.text();assert.doesNotMatch(raw,/未选择|不收录|apiKey|Authorization/);assert.match(raw,/<script>/);
});
test('malformed backup rejects foreign mixed rows, duplicates, hidden fields and unbounded structure',()=>{
  const payload=prepare().payload;
  for(const change of [{type:'qianmu-text-collections'},{extra:'secret'},{exportedAt:NaN},{namespace:other},{entries:[payload.entries[0],payload.entries[0]]},{entries:Array(10001).fill(payload.entries[0])}])assert.throws(()=>validateTextCollectionOutboxBackup({...payload,...change}));
  assert.throws(()=>validateTextCollectionOutboxBackup({...payload,entries:[{...payload.entries[0],password:'secret'}]}));
});
test('file import checks size, duplicate keys, invalid encoding and owner invalidation before accepting data',async()=>{
  let reads=0;for(const size of [0,NaN,TEXT_COLLECTION_OUTBOX_BACKUP_BYTES+1])await assert.rejects(readTextCollectionOutboxBackupFile({size,text:async()=>{reads++;return '{}';}},{check}));assert.equal(reads,0);
  const raw=await prepare().blob.text();for(const text of [raw.replace('"version":1','"version":1,"version":1'),raw.replace('"exportedAt":3','"exportedAt":1e999'),raw.replace('"version":1','"constructor":{},"version":1'),'{'])await assert.rejects(readTextCollectionOutboxBackupFile(new Blob([text]),{check}));
  let alive=true;await assert.rejects(readTextCollectionOutboxBackupFile({size:1,text:async()=>{alive=false;return raw;}},{check(){if(!alive)throw Error('closed');}}),/closed/);
});
test('merge is account-bound, idempotent and never downgrades started or conflict evidence',()=>{
  const backup=prepare().payload,empty=emptyTextCollectionOutbox(namespace),first=mergeTextCollectionOutboxBackup(empty,backup);assert.equal(first.added,1);assert.equal(empty.entries.length,0);
  const again=mergeTextCollectionOutboxBackup(first.state,backup);assert.equal(again.added,0);assert.equal(again.duplicates,1);assert.deepEqual(again.state,first.state);
  const older={...backup,entries:[{...backup.entries[0],started:false,state:'pending',queuedAt:0}]};assert.deepEqual(mergeTextCollectionOutboxBackup(first.state,older).state,first.state);
  assert.throws(()=>mergeTextCollectionOutboxBackup(emptyTextCollectionOutbox(other),backup),{code:'text_collection_sync_account'});
});
test('one conflicting operation identity rejects the entire merge without partially adding other rows',()=>{
  const current=state(),before=structuredClone(current),payload=prepare().payload,row=payload.entries[0];
  const input={...payload,entries:[{...row,request:{...row.request,mutationId:'mutation-2'}},{...row,request:{...row.request,text:'同编号不同内容'}}]};
  assert.throws(()=>mergeTextCollectionOutboxBackup(current,input),{code:'text_collection_sync_local_conflict'});assert.deepEqual(current,before);
});
