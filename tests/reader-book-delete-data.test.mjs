import test from 'node:test';
import assert from 'node:assert/strict';
import * as store from '../qianmu-blobstore.js';
import {installMemoryIndexedDB} from './helpers/reader-idb-fixture.mjs';
import {readFile} from 'node:fs/promises';
const {deleteReaderBookData}=store;
const storeSource=await readFile(new URL('../qianmu-blobstore.js',import.meta.url),'utf8');
test('book cleanup rejects invalid admission before accessing storage',async()=>{
  await assert.rejects(deleteReaderBookData('',{deleteMemory:true}),TypeError);
  await assert.rejects(deleteReaderBookData('book'),TypeError);
  assert.deepEqual(await deleteReaderBookData('book',{deleteMemory:true,isCurrent:()=>false}),{status:'stale'});
});

// Two books, each read with two companions, one of them a comic with a page script; the real transaction on an in-memory IndexedDB.
async function library(){
  const idb=installMemoryIndexedDB();store.configureBlobStoreAccount();
  for(const id of ['novel','comic']){
    await store.putBook(id,{meta:{title:id},fullText:'正文',chapters:[{}]});
    await store.putCover(id,new Blob(['cover']));await store.putReaderImage(id,1,new Blob(['image']));
    for(const scope of ['friend-a','friend-b']){
      await store.putReaderChat(`${scope}::${id}`,{bookId:id,messages:[{text:'聊过'}],slices:[{id:`${scope}-${id}`,summary:'记忆'}],cursor:1,dictBound:['places']});
      await store.putReaderVectors(`${scope}::${id}`,{dim:2,vecs:{x:[1,2]}});
    }
  }
  await store.putReaderChat('comic::comic',{bookId:'comic',pages:{1:'文字稿'}});
  // 新内容模型的四个仓（v16）：S1 起只有笔记有数据，排版、样式字体、原件在 S2 才写；这里预先放上，验证删书时一并清掉。
  const db=[...idb.databases.values()][0];
  for(const id of ['novel','comic']){
    await store.putReaderNotes(id,{v:1,notes:[{id:`${id}-n`,kind:'highlight',from:0,to:2,ch:0,text:'正文'}],updatedAt:1});
    db.stores.get('reader_docs').set(`${id}::d0`,{xhtml:'<p>正文</p>'}).set(`${id}::notes`,{notes:{}});
    db.stores.get('reader_assets').set(`${id}::css::1`,{text:'p{}'}).set(`${id}::font::1`,{family:'f'});
    db.stores.get('reader_sources').set(id,{name:`${id}.epub`});
  }
  db.stores.get('reader_docs').set('novella::d0',{xhtml:'another book whose id starts the same'});
  return idb;
}
const keysOf=(idb,name)=>[...[...idb.databases.values()][0].stores.get(name).keys()].sort();

test('deleting a book with its memory reports exactly the archives it removed, and leaves the other book alone',async()=>{
  const idb=await library();
  try{
    const result=await deleteReaderBookData('comic',{deleteMemory:true});
    assert.equal(result.status,'committed');
    assert.deepEqual([...result.chatKeys].sort(),['comic::comic','friend-a::comic','friend-b::comic'],'the keys the account must drop, page script included');
    assert.deepEqual(result.counts,{books:1,covers:1,images:1,conversations:0,buckets:2,vectors:2,docs:2,assets:2,sources:1,notes:1});
    assert.deepEqual(keysOf(idb,'reader_docs'),['novel::d0','novel::notes','novella::d0'],'only keys under this book’s own prefix');
    assert.deepEqual(keysOf(idb,'reader_assets'),['novel::css::1','novel::font::1']);
    assert.deepEqual(keysOf(idb,'reader_sources'),['novel']);assert.deepEqual(await store.listReaderNoteKeys(),['novel']);
    assert.deepEqual((await store.listReaderChatKeys()).sort(),['friend-a::novel','friend-b::novel']);
    assert.deepEqual(await store.listCoverKeys(),['novel']);assert.deepEqual((await store.listReaderVectorKeys()).sort(),['friend-a::novel','friend-b::novel']);
    const again=await deleteReaderBookData('comic',{deleteMemory:true});
    assert.deepEqual(again.chatKeys,[],'nothing left to report the second time');
  }finally{idb.restore();store.configureBlobStoreAccount();}
});

test('deleting a book but keeping its memory removes no archive: nothing is reported for account deletion',async()=>{
  const idb=await library();
  try{
    const result=await deleteReaderBookData('comic',{deleteMemory:false,sliceSchemaVersion:3,archiveSlices:slices=>slices});
    assert.equal(result.status,'committed');assert.deepEqual(result.chatKeys,[]);
    assert.deepEqual((await store.listReaderChatKeys()).sort(),['comic::comic','friend-a::comic','friend-a::novel','friend-b::comic','friend-b::novel']);
    const kept=await store.getReaderChat('friend-a::comic');
    assert.deepEqual(kept.messages,[]);assert.equal(kept.slices[0].summary,'记忆');assert.deepEqual(kept.dictBound,['places'],'the rewritten archive keeps its dictionary binding');
    assert.equal((await store.getReaderChat('comic::comic')).pages[1],'文字稿');
    assert.equal(await store.getCover('comic'),undefined);
    assert.equal(result.counts.notes,1,'notes go with the book even when its memory is kept');assert.deepEqual(await store.listReaderNoteKeys(),['novel']);
    assert.deepEqual(keysOf(idb,'reader_docs'),['novel::d0','novel::notes','novella::d0']);assert.deepEqual(keysOf(idb,'reader_sources'),['novel']);
    await store.deleteCover('novel');assert.deepEqual(await store.listCoverKeys(),[]);
  }finally{idb.restore();store.configureBlobStoreAccount();}
});

test('version 16 creates the four new reader stores at once, and the orphan audit covers them',async()=>{
  const idb=await library();
  try{
    const db=[...idb.databases.values()][0];
    for(const name of ['reader_docs','reader_assets','reader_sources','reader_notes'])assert.ok(db.stores.has(name),name);
    db.stores.get('reader_docs').set('gone::d0',{xhtml:'x'});db.stores.get('reader_assets').set('gone::css::1',{text:''});
    db.stores.get('reader_sources').set('gone',{name:'x'});
    await store.putReaderNotes('gone',{v:1,notes:[],updatedAt:1});await store.putReaderNotes('elsewhere',{v:1,notes:[],updatedAt:1});
    const audit=await store.auditOrphanedReaderBlobs({shelfBookIds:['elsewhere']});
    assert.deepEqual(audit.records.map(item=>[item.store,String(item.key),item.bookId]).sort(),
      [['reader_assets','gone::css::1','gone'],['reader_docs','gone::d0','gone'],['reader_docs','novella::d0','novella'],['reader_notes','gone','gone'],['reader_sources','gone','gone']],
      'notes of a book still on the shelf (its text on another device) are not orphans');
    const cleared=await store.clearOrphanedReaderBlobs({shelfBookIds:['elsewhere']});
    assert.equal(cleared.cleared.length,5);assert.deepEqual(await store.listReaderNoteKeys(),['comic','elsewhere','novel']);
  }finally{idb.restore();store.configureBlobStoreAccount();}
});

test('the data manager lists the four new stores under the reader category',()=>{
  assert.match(storeSource,/const DB_VERSION = 16;/);
  for(const [name,label] of [['STORE_READER_DOCS','书籍排版'],['STORE_READER_ASSETS','书内样式与字体'],['STORE_READER_SOURCES','原书文件'],['STORE_READER_NOTES','伴读笔记']])
    assert.ok(storeSource.includes(`[${name}]: { label: '${label}', category: 'reader', recoverable: false }`),name);
});
