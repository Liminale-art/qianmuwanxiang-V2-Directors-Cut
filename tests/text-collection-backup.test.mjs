import test from 'node:test';
import assert from 'node:assert/strict';
import {createTextCollection,updateTextCollection} from '../qianmu-text-collection.js';
import {TEXT_COLLECTION_BACKUP_LIMITS,prepareTextCollectionBackup,readTextCollectionBackupFile,validateTextCollectionBackup} from '../qianmu-text-collection-backup.js';
const sourceAccount='st-user:'+'a'.repeat(64),check=()=>{};
const original=()=>createTextCollection({id:'collection-1',mode:'selection',start:4,end:9,createdAt:1,source:{account:sourceAccount,chatId:'deleted-chat',messageId:4,replyId:'old-reply',charName:'当时角色',userName:'当时用户',text:'未选内容选择这句话未选内容'}});
const prepare=(records=[original()])=>prepareTextCollectionBackup({sourceAccount,libraryRevision:10,records,exportedAt:20});

test('edited prose round-trips exactly without inventing source ranges or resetting original metadata',async()=>{
  const record=updateTextCollection(original(),{text:'编辑后长度不同\r\n😀 <script>不是代码</script>'},1,3);
  const {blob,payload,count}=prepare([record]);assert.equal(count,1);
  const read=await readTextCollectionBackupFile(blob,{check});assert.deepEqual(read.records[0],record);assert.deepEqual(read,payload);
  assert.notEqual(record.text.length,record.range.end-record.range.start);assert.equal(read.records[0].createdAt,1);assert.equal(read.records[0].revision,2);
  const raw=await blob.text();assert.doesNotMatch(raw,/未选内容|mutationId|apiKey|Authorization/);assert.match(raw,/<script>/);
});
test('validating or preparing makes detached immutable snapshots, never alters caller records',()=>{
  const record=structuredClone(original()),before=structuredClone(record),result=prepare([record]);record.text='改动外部变量';
  assert.deepEqual(result.payload.records[0],before);assert.ok(Object.isFrozen(result.payload.records[0].source));assert.ok(Object.isFrozen(result.payload.records));
  const empty=prepare([]);assert.equal(empty.count,0);assert.equal(empty.payload.libraryRevision,10);
});
test('mixed accounts, duplicate IDs, hidden fields and invalid revisions reject the whole backup',()=>{
  const valid=prepare().payload;
  for(const change of [{apiKey:'secret'},{version:'1'},{records:[original(),original()]},{libraryRevision:0},{sourceAccount:'st-user:'+'b'.repeat(64)},{exportedAt:Infinity},{records:Array(10001).fill(original())}])assert.throws(()=>validateTextCollectionBackup({...valid,...change}));
  const edited=structuredClone(valid);edited.records.push({...original(),id:'collection-2',source:{...original().source,text:'unselected original'}});assert.throws(()=>validateTextCollectionBackup(edited));
});
test('file admission checks declared size first and actual structure/encoding without trusting extensions',async()=>{
  let reads=0;for(const size of [0,-1,NaN,TEXT_COLLECTION_BACKUP_LIMITS.bytes+1])await assert.rejects(readTextCollectionBackupFile({size,text:async()=>{reads++;return '{}';}},{check}));assert.equal(reads,0);
  const raw=await prepare().blob.text();
  for(const text of [raw.replace('"version":1','"version":1,"version":1'),raw.replace('"version":1','"constructor":{},"version":1'),raw.replace('"exportedAt":20','"exportedAt":1e999'),'{',JSON.stringify({...prepare().payload,records:[{...original(),text:'\ud800'}]})])
    await assert.rejects(readTextCollectionBackupFile({size:1,text:async()=>text},{check}));
  assert.deepEqual(await readTextCollectionBackupFile(new Blob([raw]),{check}),prepare().payload);
});
test('source account remains evidence, not destination identity, and stale reads cannot authorize an import',async()=>{
  const blob=prepare().blob;let current=true;
  await assert.rejects(readTextCollectionBackupFile({size:blob.size,text:async()=>{current=false;return blob.text();}},{check(){if(!current)throw Error('account changed');}}),/account changed/);
  assert.equal((await readTextCollectionBackupFile(blob,{check})).sourceAccount,sourceAccount);
  await assert.rejects(readTextCollectionBackupFile(blob),/需要当前账户/);
});
