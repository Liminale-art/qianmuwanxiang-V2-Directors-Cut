import test from 'node:test';
import assert from 'node:assert/strict';
import {buildCoreadPackage,readCoreadPackageFile,applyCoreadPackageData,createCoreadImportProgress} from '../qianmu-reader-package.js';
import {buildZip,readZipDirectory,zipEntryBlob} from '../qianmu-storage-transfer.js';

// v6 预检：目录、manifest 与各书 index.json 有一处不对就整包不写；内容条目坏了只算那一条。
const json=value=>new Blob([JSON.stringify(value)]);
const plain=value=>!!value&&typeof value==='object'&&!Array.isArray(value);
function source(){
  const empty=async()=>[];
  return {getBook:async()=>({fullText:'prose',chapters:[]}),getCover:async()=>undefined,listReaderChatKeys:async()=>['role::a','role::b'],
    getReaderChat:async key=>({messages:[key]}),listReaderImages:async()=>[{key:'a::1',blob:new Blob(['img'],{type:'image/png'})}],listReaderVectorKeys:empty,
    getReaderVectors:async()=>({}),listAudio:empty,listRetLog:empty};
}
const pack=()=>buildCoreadPackage({bookMetas:[{id:'a',title:'甲'},{id:'b',title:'乙'}],prefs:{fontSize:18},blobStore:source()});
async function rewrite(blob,change){
  const files=[];
  for(const entry of await readZipDirectory(blob)){const content=await zipEntryBlob(blob,entry);const next=await change(entry.name,content);if(next!==null)files.push({name:entry.name,blob:next??content});}
  return buildZip(files);
}
const edit=async(blob,name,mutate)=>rewrite(blob,async(entry,content)=>entry===name?json(mutate(JSON.parse(await content.text()))):undefined);
const open=blob=>readCoreadPackageFile(new File([blob],'pack.zip'));

test('a normal v6 package opens with every book, the preferences and the shared parts',async()=>{
  const data=await open((await pack()).blob);
  assert.equal(data.version,6);assert.deepEqual(data.books.map(book=>book.id),['a','b']);assert.deepEqual(data.prefs,{fontSize:18});assert.equal(data.prefsUnreadable,false);
});

test('a broken manifest, an unknown version or a non-zip are refused before any write',async()=>{
  const {blob}=await pack();
  await assert.rejects(open(await edit(blob,'manifest.json',m=>({...m,version:7}))),/暂不支持此伴读整包版本/);
  await assert.rejects(open(await edit(blob,'manifest.json',m=>({...m,type:'other'}))),/不是有效的千幕阅读数据文件/);
  await assert.rejects(open(await rewrite(blob,name=>name==='manifest.json'?new Blob(['{"type":']):undefined)),/不是有效的千幕阅读数据文件/);
  await assert.rejects(open(blob.slice(0,blob.size-10)),/不是有效的千幕阅读数据文件|不完整/);
  const nested=await edit(blob,'manifest.json',m=>{let deep={};for(let i=0;i<45;i++)deep={deep};return {...m,extra:deep};});
  await assert.rejects(open(nested),/不是有效的千幕阅读数据文件/);
});

test('a damaged index in any book refuses the whole package, naming the book’s position',async()=>{
  const {blob}=await pack();
  const cases=[
    [await edit(blob,'manifest.json',m=>({...m,books:[m.books[0],m.books[0]]})),/第 2 项编号重复/],
    [await rewrite(blob,name=>name==='books/2/index.json'?null:undefined),/第 2 项目录无法读取/],
    [await edit(blob,'books/2/index.json',i=>({...i,id:'other'})),/第 2 项书目信息缺失/],
    [await edit(blob,'books/1/index.json',i=>({...i,book:'books/1/missing.json'})),/第 1 项正文原件缺失/],
    [await edit(blob,'books/1/index.json',i=>({...i,images:[{...i.images[0],mime:'text/html'}]})),/第 1 项媒体类型无效/],
    [await edit(blob,'books/1/index.json',i=>({...i,images:[{...i.images[0],file:'books/1/images/9.png'}]})),/第 1 项条目缺失或过大/],
    [await edit(blob,'books/2/index.json',i=>({...i,chats:[{key:'role::a',file:i.chats[0].file}]})),/第 2 项编号重复/],
    [await edit(blob,'books/1/index.json',i=>({...i,cover:{file:'books/1/meta.json',mime:'text/html'}})),/第 1 项封面缺失或媒体类型无效/],
    [await edit(blob,'shared/index.json',s=>({...s,audio:[{key:'v',file:'prefs.json',mime:'audio/mpeg',meta:[]}]})),/共用资料媒体信息格式无效/],
  ];
  for(const [file,pattern] of cases)await assert.rejects(open(file),pattern);
});

test('a content entry that breaks the per-entry bounds fails only itself',async()=>{
  const {blob}=await pack();
  let deep={x:1};for(let i=0;i<45;i++)deep={deep};
  const broken=await rewrite(blob,name=>name==='books/1/chats/1.json'?json({messages:[deep]}):name==='books/2/chats/1.json'?new Blob(['{"constructor":1}']):undefined);
  const data=await open(broken),written=[],progress=createCoreadImportProgress(),shelf={books:[]},warnings=[];
  const writer={putBookWithCover:async id=>written.push(['book',id]),putReaderChat:async key=>written.push(['chat',key]),putReaderImageByKey:async key=>written.push(['image',key]),
    putReaderVectors:async()=>{},bulkPutAudio:async()=>({added:0}),pushRetLog:async()=>{}};
  await applyCoreadPackageData(data,{blobStore:writer,coread:()=>shelf,isPlainObject:plain,warn:(...args)=>warnings.push(args),progress});
  assert.deepEqual(written,[['image','a::1'],['book','a'],['book','b']]);
  assert.equal(progress.failed,2);assert.equal(progress.ok,2);assert.equal(warnings.length,2);assert.deepEqual(shelf.books.map(book=>book.id),['b','a']);
});
