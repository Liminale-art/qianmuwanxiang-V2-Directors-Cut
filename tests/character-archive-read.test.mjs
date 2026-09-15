import test from 'node:test';
import assert from 'node:assert/strict';
import {createCharacterArchiveStore} from '../qianmu-character-archive-store.js';
import {newCharacterArchive,normalizeCharacterArchive} from '../qianmu-character-archive.js';

const namespace='st-user:fixture',id='alice',key=JSON.stringify([namespace,id]);
const bytes=value=>new TextEncoder().encode(JSON.stringify(value)).byteLength;
function records(){
  const document=normalizeCharacterArchive({...newCharacterArchive('char'),name:'Alice',aliases:['Al']});
  const head={key,namespace,id,revision:'revision-1',version:1,category:document.category,name:document.name,
    aliases:[...document.aliases],cover:'',bytes:bytes(document),createdAt:1,updatedAt:1};
  return {head,row:{key,namespace,revision:head.revision,document}};
}
// Exercise the actual store read path. There is no write method or real browser database in this fixture.
function environment(data){
  const reads=[];
  const database={close(){},transaction(names,mode){
    assert.equal(mode,'readonly');let pending=0,aborted=false;
    const tx={abort(){aborted=true;queueMicrotask(()=>tx.onabort?.());},objectStore(name){return {get(requested){
      assert.equal(requested,key);assert.ok(['heads','documents'].includes(name));reads.push(name);
      const request={};pending++;
      queueMicrotask(()=>{
        if(aborted)return;
        request.result=structuredClone(name==='heads'?data.head:data.row);request.onsuccess?.();pending--;
        if(pending===0)queueMicrotask(()=>{if(!aborted&&pending===0)tx.oncomplete?.();});
      });
      return request;
    }};}};
    return tx;
  }};
  const indexedDB={open(){const request={};queueMicrotask(()=>{request.result=database;request.onsuccess?.();});return request;}};
  return {store:createCharacterArchiveStore({indexedDB}),reads};
}

test('archive reads one consistent document without modifying stored records',async()=>{
  const data=records(),before=structuredClone(data),{store,reads}=environment(data);
  try{
    assert.deepEqual(await store.load(namespace,id),{head:data.head,document:data.row.document});
    assert.deepEqual(reads,['heads','documents']);assert.deepEqual(data,before);
  }finally{store.close();}
});

test('archive missing heads remain absent rather than adopting an orphan document',async()=>{
  const data=records();data.head=undefined;const {store,reads}=environment(data);
  try{assert.equal(await store.load(namespace,id),null);assert.deepEqual(reads,['heads']);}finally{store.close();}
});

test('archive owner, record identity and indexed metadata must match the stored document',async()=>{
  for(const mutate of [
    data=>{data.row.key=JSON.stringify([namespace,'other']);},
    data=>{data.row.namespace='st-user:other';},
    data=>{data.row.revision='revision-2';},
    data=>{data.head.id='other';},
    data=>{data.row.document.category='user';},
    data=>{data.row.document.name='Other';},
    data=>{data.row.document.aliases=['Someone else'];},
    data=>{data.head.cover='/user/images/wrong.png';},
    data=>{data.head.bytes++;},
  ]){
    const data=records();mutate(data);const before=structuredClone(data),{store}=environment(data);
    try{await assert.rejects(store.load(namespace,id),{code:'character_archive_index'});assert.deepEqual(data,before);}finally{store.close();}
  }
});

test('legacy optional defaults normalize on read without rewriting data or rejecting its original byte count',async()=>{
  const data=records();delete data.row.document.ageStatus;delete data.row.document.imagegen.preview;
  data.head.bytes=bytes(data.row.document);const before=structuredClone(data),{store}=environment(data);
  try{
    const loaded=await store.load(namespace,id);assert.equal(loaded.document.ageStatus,'unknown');assert.equal(loaded.document.imagegen.preview,null);
    assert.equal(loaded.head.bytes,data.head.bytes);assert.deepEqual(data,before);
  }finally{store.close();}
});
