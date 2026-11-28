import test from 'node:test';
import assert from 'node:assert/strict';
import {buildCoreadPackage,coreadPackageExportText} from '../qianmu-reader-package.js';
import {readZipDirectory,zipEntryBlob} from '../qianmu-storage-transfer.js';

const png = text => new Blob([text], {type:'image/png'});
function fixture(){
  const calls=[];
  const bookMetas=[{id:'book',title:'甲书',hasCover:true,notes:[{id:'n1',text:'划线'}]},{id:'remote',title:'乙书'},{id:'bare',title:'丙书',hasCover:true}];
  const records={book:{fullText:'original prose',chapters:[{title:'一',content:'original prose'}],sig:'signature',comicDescriptions:{page1:'description'},meta:{title:'import-time'},savedAt:7,extra:'kept'},bare:{fullText:'',chapters:[]}};
  const data={getBook:id=>records[id],getCover:id=>id==='book'?png('cover'):undefined,
    listReaderChatKeys:()=>['role::book','comic::book','role::gone'],getReaderChat:key=>({messages:[key],slices:['memory']}),
    listReaderImages:()=>[{key:'book::1',blob:png('illustration')},{key:'gone::1',blob:png('orphan')}],
    listReaderVectorKeys:()=>['role::book'],getReaderVectors:()=>({model:'fixture',vecs:{v:[1,2]}}),
    listAudio:()=>[{key:'voice',blob:new Blob(['voice'],{type:'audio/mpeg'}),meta:{source:'coread'},createdAt:9},{key:'other',blob:new Blob(['x']),meta:{source:'tts'}}],
    listRetLog:()=>[{id:2,at:8,query:'fixture'}]};
  const blobStore=Object.fromEntries(Object.entries(data).map(([name,fn])=>[name,async(...args)=>{calls.push([name,...args]);return fn(...args);}]));
  return {calls,bookMetas,records,blobStore,options:{bookMetas,prefs:{fontSize:18,readLog:{books:{book:{ms:5}}}},blobStore,now:()=>new Date('2026-11-29T00:00:00.000Z')}};
}
async function unpack(blob){
  const entries=await readZipDirectory(blob),byName=new Map(entries.map(entry=>[entry.name,entry]));
  return {names:entries.map(entry=>entry.name),json:async name=>JSON.parse(await (await zipEntryBlob(blob,byName.get(name))).text()),
    text:async name=>(await zipEntryBlob(blob,byName.get(name))).text(),entry:name=>byName.get(name)};
}

test('one folder per book, the manifest first and stored, preferences and shared parts beside them',async()=>{
  const e=fixture(),pack=await buildCoreadPackage(e.options),zip=await unpack(pack.blob);
  assert.equal(zip.names[0],'manifest.json');assert.equal(zip.entry('manifest.json').method,0);
  const manifest=await zip.json('manifest.json');
  assert.deepEqual(manifest,{type:'qianmu-coread',version:6,exportedAt:'2026-11-29T00:00:00.000Z',credentialsIncluded:false,prefs:'prefs.json',shared:'shared/index.json',
    books:[{id:'book',dir:'books/1/'},{id:'remote',dir:'books/2/'},{id:'bare',dir:'books/3/'}],
    skipped:[{id:'remote',title:'乙书',part:'text'},{id:'bare',title:'丙书',part:'cover'}]});
  assert.deepEqual(await zip.json('prefs.json'),e.options.prefs);
  const index=await zip.json('books/1/index.json');
  assert.deepEqual(index,{id:'book',meta:'books/1/meta.json',book:'books/1/book.json',cover:{file:'books/1/cover.png',mime:'image/png'},
    images:[{key:'book::1',file:'books/1/images/1.png',mime:'image/png'}],chats:[{key:'role::book',file:'books/1/chats/1.json'},{key:'comic::book',file:'books/1/chats/2.json'}],
    vectors:[{key:'role::book',file:'books/1/vectors/1.json'}]});
  assert.deepEqual(await zip.json('books/1/meta.json'),e.bookMetas[0],'the current shelf entry, notes included');
  assert.equal(await zip.text('books/1/images/1.png'),'illustration','media are the original bytes, not base64');
  assert.equal(zip.entry('books/1/images/1.png').method,0);
  const shared=await zip.json('shared/index.json');
  assert.deepEqual(shared.chats,[{key:'role::gone',file:'shared/chats/1.json'}]);assert.deepEqual(shared.images,[{key:'gone::1',file:'shared/images/1.png',mime:'image/png'}]);
  assert.deepEqual(shared.audio,[{key:'voice',file:'shared/audio/1.mp3',mime:'audio/mpeg',meta:{source:'coread'},createdAt:9}]);
  assert.deepEqual(await zip.json('shared/retlog.json'),[{id:2,at:8,query:'fixture'}]);
  assert.deepEqual(pack.counts,{books:2,chats:2,images:2,vectors:1,audio:1},'the comic page record is not counted as a conversation');
});

test('the book record keeps its own fields but not the import-time metadata or save stamp',async()=>{
  const e=fixture(),zip=await unpack((await buildCoreadPackage(e.options)).blob);
  assert.deepEqual(await zip.json('books/1/book.json'),{fullText:'original prose',chapters:[{title:'一',content:'original prose'}],sig:'signature',comicDescriptions:{page1:'description'},extra:'kept'});
  assert.deepEqual(await zip.json('books/3/book.json'),{fullText:'',chapters:[],sig:'',comicDescriptions:{}},'an intentionally empty text is still a text');
});

test('a book without local text is listed and skipped, its shelf entry and companions still exported',async()=>{
  const e=fixture();e.records.book=undefined;
  const pack=await buildCoreadPackage(e.options),zip=await unpack(pack.blob),index=await zip.json('books/1/index.json');
  assert.equal(index.book,null);assert.equal(index.cover,null);assert.equal(index.chats.length,2);assert.ok(zip.names.includes('books/1/meta.json'));
  assert.equal(zip.names.includes('books/1/book.json'),false);
  assert.deepEqual(pack.skipped.map(item=>[item.id,item.part]),[['book','text'],['remote','text'],['bare','cover']]);
  assert.equal(e.calls.some(call=>call[0]==='getCover'&&call[1]==='book'),false,'no cover read for a book that has no text here');
});

test('the export notice names what was skipped in one short sentence each',()=>{
  const counts={books:3,chats:2,images:4,audio:1};
  assert.equal(coreadPackageExportText({counts,skipped:[]}),'伴读数据已打包导出：3 本书 · 2 段对话 · 4 张插图 · 1 条语音。');
  assert.equal(coreadPackageExportText({counts,skipped:[{title:'甲',part:'text'},{title:'乙',part:'text'},{title:'丙',part:'cover'}]}),
    '伴读数据已打包导出：3 本书 · 2 段对话 · 4 张插图 · 1 条语音。 有 2 本书在这台设备上没有正文，未导出：《甲》《乙》 有 1 本书的封面不在这台设备上，未导出封面：《丙》');
  const many=Array.from({length:7},(_,i)=>({title:`书${i}`,part:'text'}));
  assert.match(coreadPackageExportText({counts,skipped:many}),/有 7 本书[^《]*《书0》《书1》《书2》《书3》《书4》等$/);
});

test('an unexpected read failure still stops the whole export without leaking the underlying error',async()=>{
  for(const method of ['getBook','getCover','listReaderChatKeys','getReaderChat','listReaderImages','listReaderVectorKeys','getReaderVectors','listAudio','listRetLog']){
    const e=fixture();e.blobStore[method]=async()=>{throw Error('sensitive fixture detail');};
    await assert.rejects(()=>buildCoreadPackage(e.options),error=>/未能完整读取/.test(error.message)&&!error.message.includes('sensitive'),method);
  }
  for(const [method,value] of [['getReaderChat',null],['getReaderVectors',null],['listReaderImages',[{key:'book::1'}]],['listAudio',[{key:'x',meta:{source:'coread'}}]],['listRetLog',[null]],['listReaderChatKeys',undefined]]){
    const e=fixture();e.blobStore[method]=async()=>value;await assert.rejects(()=>buildCoreadPackage(e.options),/未能完整读取/,method);
  }
});

test('every awaited read rechecks ownership before reading more or building the file',async()=>{
  for(const method of ['getBook','getCover','listReaderChatKeys','getReaderChat','listReaderImages','listReaderVectorKeys','getReaderVectors','listAudio','listRetLog']){
    const e=fixture();let current=true,at=-1;e.options.check=()=>{if(!current)throw Error('owner changed');};
    const original=e.blobStore[method];e.blobStore[method]=async(...args)=>{const value=await original(...args);current=false;at=e.calls.length;return value;};
    await assert.rejects(()=>buildCoreadPackage(e.options),/owner changed/,method);
    assert.equal(e.calls.length,at,'no further read after invalidation');
  }
});

test('an empty library still writes a restorable manifest and empty shared lists',async()=>{
  const e=fixture();e.options.bookMetas=[];
  for(const name of ['listReaderChatKeys','listReaderImages','listReaderVectorKeys','listAudio','listRetLog'])e.blobStore[name]=async()=>[];
  const pack=await buildCoreadPackage(e.options),zip=await unpack(pack.blob);
  assert.deepEqual((await zip.json('manifest.json')).books,[]);assert.deepEqual(await zip.json('shared/index.json'),{images:[],chats:[],vectors:[],audio:[],retrievalLogs:'shared/retlog.json'});
  assert.deepEqual(pack.skipped,[]);
});
