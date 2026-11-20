import test from 'node:test';
import assert from 'node:assert/strict';
import * as store from '../qianmu-blobstore.js';
import {installMemoryIndexedDB} from './helpers/reader-idb-fixture.mjs';
const {deleteReaderBookData}=store;
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
  return idb;
}

test('deleting a book with its memory reports exactly the archives it removed, and leaves the other book alone',async()=>{
  const idb=await library();
  try{
    const result=await deleteReaderBookData('comic',{deleteMemory:true});
    assert.equal(result.status,'committed');
    assert.deepEqual([...result.chatKeys].sort(),['comic::comic','friend-a::comic','friend-b::comic'],'the keys the account must drop, page script included');
    assert.deepEqual(result.counts,{books:1,covers:1,images:1,conversations:0,buckets:2,vectors:2});
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
    await store.deleteCover('novel');assert.deepEqual(await store.listCoverKeys(),[]);
  }finally{idb.restore();store.configureBlobStoreAccount();}
});
