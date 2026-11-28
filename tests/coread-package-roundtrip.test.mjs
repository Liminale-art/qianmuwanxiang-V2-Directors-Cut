import test from 'node:test';
import assert from 'node:assert/strict';
import {buildCoreadPackage,readCoreadPackageFile,applyCoreadPackageData,createCoreadImportProgress,finishCoreadPackageImport} from '../qianmu-reader-package.js';
import {buildZip,readZipDirectory,zipEntryBlob} from '../qianmu-storage-transfer.js';
import {omitConfigConnections,restoreConfigConnections,readConfigFile,readConfigEnvelope} from '../qianmu-config-connections.js';
import {applyPreparedConfig} from '../qianmu-config-apply.js';

// In-memory I/O deliberately tests cross-package identity, not IndexedDB durability.
// Native transactions and download handoff have separate browser checks.
const plain=value=>!!value&&typeof value==='object'&&!Array.isArray(value);
function fixture(){
  const books=[{id:'novel',title:'same title',progress:37,hasCover:true,notes:[{id:'n1',kind:'highlight',text:'Moonlight'}]},{id:'comic',title:'same title',progress:2,mode:'comic',hasCover:false}];
  const records=new Map([
    ['novel',{fullText:'Moonlight ⟦img:1⟧',chapters:[{start:0,title:'one'}],sig:'original',comicDescriptions:{}}],
    ['comic',{fullText:'',chapters:[],sig:'comic',comicDescriptions:{1:'window'}}],
  ]);
  const chats=new Map(['role-a','role-b'].map((role,index)=>[role+'::novel',{messages:[{text:role}],slices:[{memory:role}],cursor:index+3,dictBound:index?[]:['dict-default','places']}]));
  chats.set('comic::comic',{pages:{1:'page record'}});
  const vectors=new Map(['role-a::novel','role-b::novel'].map(key=>[key,{model:'synthetic',vecs:{[key]:[1,2,3]}}]));
  const images=[{key:'novel::1',blob:new Blob(['illustration'],{type:'image/png'})},{key:'comic::1',blob:new Blob(['comic page'],{type:'image/png'})}];
  const readLog={books:{novel:{ms:90000,chars:3400,mark:3400,last:2}},days:{'2026-11-24':3400},pals:{}};
  const settings={apiKey:'synthetic-source',coread:{books,readLog,readerThemes:[{name:'夜读'}],homeCards:[{id:'today',hidden:true}],assistant:{apiProfileId:'source-only'}}};
  const reader={getBook:async id=>records.get(id),getCover:async id=>id==='novel'?new Blob(['cover'],{type:'image/png'}):undefined,
    listReaderChatKeys:async()=>[...chats.keys()],getReaderChat:async key=>chats.get(key),listReaderImages:async()=>images,
    listReaderVectorKeys:async()=>[...vectors.keys()],getReaderVectors:async key=>vectors.get(key),
    listAudio:async()=>[{key:'voice',blob:new Blob(['voice'],{type:'audio/wav'}),meta:{source:'coread',speaker:'role-a'},createdAt:9},{key:'other-module',blob:new Blob(['unrelated']),meta:{source:'tts'}}],
    listRetLog:async()=>[{at:10,query:'moon'}]};
  return {settings,reader,records,chats,vectors,images};
}
function destination(){
  const stores=Object.fromEntries(['books','covers','chats','images','vectors','audio','logs'].map(name=>[name,new Map()]));
  stores.books.set('outside-pack',{fullText:'keep'});stores.audio.set('local-audio',{blob:new Blob(['keep'])});
  let current={apiKey:'synthetic-recipient',coread:{books:[],readLog:{books:{local:{ms:1}},days:{},pals:{}}}},saves=0;
  const host={settings:current},writer={
    putBookWithCover:async(id,record,cover)=>{stores.books.set(id,structuredClone(record));if(cover)stores.covers.set(id,cover);},
    putReaderChat:async(key,record)=>stores.chats.set(key,structuredClone(record)),putReaderImageByKey:async(key,blob)=>stores.images.set(key,blob),
    putReaderVectors:async(key,record)=>stores.vectors.set(key,structuredClone(record)),
    bulkPutAudio:async entries=>{let added=0,skipped=0;for(const row of entries){if(stores.audio.has(row.key))skipped++;else{stores.audio.set(row.key,row);added++;}}return {added,skipped,failed:0};},
    pushRetLog:async row=>stores.logs.set(stores.logs.size,structuredClone(row)),
  };
  return {stores,writer,current:()=>current,save:()=>saves++,saves:()=>saves,
    config(prepared){const result=applyPreparedConfig({prepared,owner:current,host,slot:'settings',setCurrent:value=>current=value,save:()=>saves++,layoutStorage:()=>null});assert.equal(result.status,'applied');}};
}
const prefsOf=settings=>{const {books,...rest}=omitConfigConnections(structuredClone(settings)).coread;return rest;};
const asFile=(blob,name='qianmu-coread-pack.zip')=>new File([blob],name,{type:'application/json'});
async function restore(target,blob){
  const data=await readCoreadPackageFile(asFile(blob)),warnings=[];
  const progress=await applyCoreadPackageData(data,{blobStore:target.writer,coread:()=>target.current().coread,isPlainObject:plain,base64ToBlob:()=>assert.fail('v6 never decodes base64'),onBookIndexed:target.save,warn:(...args)=>warnings.push(args)});
  return {data,progress,warnings};
}

for(const configFirst of [true,false])test(`v6 round trip keeps book IDs, notes, images, per-companion memories and reading stats (${configFirst?'config':'originals'} first)`,async()=>{
  const source=fixture(),before=structuredClone(source.settings),target=destination();
  const config=readConfigEnvelope(await readConfigFile(new Blob([JSON.stringify({type:'qianmu-config',version:2,includeApi:false,settings:omitConfigConnections(structuredClone(source.settings))})])));
  const pack=await buildCoreadPackage({bookMetas:structuredClone(source.settings.coread.books),prefs:prefsOf(source.settings),blobStore:source.reader});
  assert.deepEqual(pack.skipped,[]);
  const restoreConfig=()=>target.config(restoreConfigConnections(structuredClone(config.settings),target.current()));
  if(configFirst){restoreConfig();assert.equal(target.stores.books.has('novel'),false,'configuration alone cannot manufacture a book original');}
  const {data,progress,warnings}=await restore(target,pack.blob);
  if(!configFirst)restoreConfig();
  assert.deepEqual(warnings,[]);
  assert.equal(progress.ok,2);assert.equal(progress.coverOk,1);assert.equal(progress.chatOk,2);assert.equal(progress.vectorOk,2);assert.equal(progress.imageOk,2);assert.equal(progress.audioOk,1);assert.equal(progress.logOk,1);
  assert.deepEqual(target.current().coread.books.map(book=>book.id).sort(),['comic','novel']);
  assert.deepEqual(target.current().coread.books.find(book=>book.id==='novel').notes,source.settings.coread.books[0].notes);
  for(const [id,original] of source.records){const restored=target.stores.books.get(id);for(const key of ['fullText','chapters','sig','comicDescriptions'])assert.deepEqual(restored[key],original[key]);}
  for(const [key,record] of source.chats)assert.deepEqual(target.stores.chats.get(key),record,'same-book companion histories must not be merged');
  for(const [key,record] of source.vectors)assert.deepEqual(target.stores.vectors.get(key),record);
  for(const image of source.images){const restored=target.stores.images.get(image.key);assert.equal(await restored.text(),await image.blob.text());assert.equal(restored.type,'image/png');}
  assert.equal(await target.stores.covers.get('novel').text(),'cover');assert.equal(await target.stores.audio.get('voice').blob.text(),'voice');
  assert.equal(target.stores.audio.has('other-module'),false);assert.equal(target.stores.books.get('outside-pack').fullText,'keep');assert.ok(target.stores.audio.has('local-audio'));
  assert.deepEqual(data.prefs.readLog,source.settings.coread.readLog,'per-book reading stats travel with the preferences');
  assert.deepEqual(data.prefs.readerThemes,[{name:'夜读'}]);assert.equal(data.prefs.assistant.apiProfileId,undefined,'connections never enter the package');
  assert.equal(target.current().apiKey,'synthetic-recipient');
  assert.equal(target.saves(),3);assert.deepEqual(source.settings,before);
});

test('a v5 single-JSON package from before still restores',async()=>{
  const target=destination(),b64=text=>Buffer.from(text).toString('base64');
  const v5={type:'qianmu-coread',version:5,prefs:{fontSize:20},books:[{meta:{id:'old',title:'旧书',hasCover:true},fullText:'old prose',chapters:[],sig:'s',coverB64:b64('cover'),coverMime:'image/png'}],
    chats:[{key:'role::old',rec:{messages:['hi']}}],images:[{key:'old::1',b64:b64('img'),mime:'image/png'}],vectors:[],audio:[],retrievalLogs:[]};
  const data=await readCoreadPackageFile(new Blob([JSON.stringify(v5)]));
  const progress=await applyCoreadPackageData(data,{blobStore:target.writer,coread:()=>target.current().coread,isPlainObject:plain,base64ToBlob:(text,type)=>new Blob([Buffer.from(text,'base64')],{type}),onBookIndexed:target.save,warn:()=>assert.fail('unexpected partial restore')});
  assert.equal(progress.ok,1);assert.equal(progress.chatOk,1);assert.equal(progress.imageOk,1);
  assert.equal(target.stores.books.get('old').fullText,'old prose');assert.equal(await target.stores.images.get('old::1').text(),'img');
});

// 一本书的正文条目坏了：那本书不写，别的书、对话、插图、偏好照常恢复。
async function rewrite(blob,change){
  const entries=await readZipDirectory(blob),files=[];
  for(const entry of entries){const content=await zipEntryBlob(blob,entry);const next=await change(entry.name,content);if(next!==null)files.push({name:entry.name,blob:next??content});}
  return buildZip(files);
}
test('one failed book does not block the other books, its own companions or the preferences',async()=>{
  const source=fixture(),target=destination();
  const pack=await buildCoreadPackage({bookMetas:structuredClone(source.settings.coread.books),prefs:prefsOf(source.settings),blobStore:source.reader});
  const broken=await rewrite(pack.blob,name=>name==='books/1/book.json'?new Blob(['{"fullText":12}']):undefined);
  const {data,progress,warnings}=await restore(target,broken);
  assert.equal(progress.ok,1);assert.equal(progress.failed,1);assert.equal(warnings.length,1);
  assert.equal(target.stores.books.has('novel'),false,'the damaged original is not written');assert.ok(target.stores.books.has('comic'));
  assert.ok(target.stores.chats.has('role-a::novel'),'the failed book’s companions are still restored');
  const reader=target.current().coread,reloads=[],notices=[];
  finishCoreadPackageImport({reader,progress,hasPrefs:plain(data.prefs),check(){},save(){},refresh(){},notify:(text,level)=>notices.push([text,level]),
    preparePrefs:()=>({...structuredClone(reader),...data.prefs}),reload:()=>reloads.push(reader.readLog)});
  assert.deepEqual(reader.readLog,source.settings.coread.readLog);assert.deepEqual(reader.readerThemes,[{name:'夜读'}]);assert.deepEqual(reader.homeCards,[{id:'today',hidden:true}]);
  assert.equal(reloads.length,1);assert.match(notices[0][0],/失败 1 项[\s\S]*阅读偏好已恢复。/);assert.equal(notices[0][1],'warning');
});

test('a damaged preferences entry is reported and the books are still restored',async()=>{
  const source=fixture(),target=destination();
  const pack=await buildCoreadPackage({bookMetas:structuredClone(source.settings.coread.books),prefs:prefsOf(source.settings),blobStore:source.reader});
  const {data,progress}=await restore(target,await rewrite(pack.blob,name=>name==='prefs.json'?new Blob(['{"broken":']):undefined));
  assert.equal(data.prefs,undefined);assert.equal(progress.prefsUnreadable,1);assert.equal(progress.ok,2);
});

test('a book exported without local text adds only a shelf entry where none exists, and never replaces a local one',async()=>{
  const source=fixture();source.records.delete('novel');
  const pack=await buildCoreadPackage({bookMetas:structuredClone(source.settings.coread.books),prefs:{},blobStore:source.reader});
  const fresh=destination(),first=await restore(fresh,pack.blob);
  assert.equal(first.progress.noText,1);assert.equal(fresh.stores.books.has('novel'),false);
  assert.deepEqual(fresh.current().coread.books.find(book=>book.id==='novel')?.hasCover,false);
  const local=destination();local.current().coread.books.push({id:'novel',title:'local copy',progress:80});
  await restore(local,pack.blob);
  assert.equal(local.current().coread.books.find(book=>book.id==='novel').title,'local copy');
});
