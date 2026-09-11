import test from 'node:test';
import assert from 'node:assert/strict';
import {deleteReaderBookData} from '../qianmu-blobstore.js';
test('book cleanup rejects invalid admission before accessing storage',async()=>{
  await assert.rejects(deleteReaderBookData('',{deleteMemory:true}),TypeError);
  await assert.rejects(deleteReaderBookData('book'),TypeError);
  assert.deepEqual(await deleteReaderBookData('book',{deleteMemory:true,isCurrent:()=>false}),{status:'stale'});
});
