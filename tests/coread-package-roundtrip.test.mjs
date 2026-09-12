import test from 'node:test';
import assert from 'node:assert/strict';
import {collectCoreadPackageData,prepareCoreadPackageExport,readCoreadPackageFile,applyCoreadPackageData} from '../qianmu-reader-package.js';
import {omitConfigConnections,restoreConfigConnections,readConfigFile,readConfigEnvelope} from '../qianmu-config-connections.js';
import {applyPreparedConfig} from '../qianmu-config-apply.js';

// In-memory I/O deliberately tests cross-package identity, not IndexedDB durability.
// Native transactions and download handoff have separate browser checks.
const encode=async blob=>Buffer.from(await blob.arrayBuffer()).toString('base64');
const decode=(text,type)=>new Blob([Buffer.from(text,'base64')],{type});
const plain=value=>!!value&&typeof value==='object'&&!Array.isArray(value);
function fixture(){
  const books=[{id:'novel',title:'same title',progress:37,hasCover:true},{id:'comic',title:'same title',progress:2,mode:'comic',hasCover:false}];
  const records=new Map([
    ['novel',{fullText:'Moonlight ⟦img:1⟧',chapters:[{start:0,title:'one'}],sig:'original',comicDescriptions:{}}],
    ['comic',{fullText:'',chapters:[],sig:'comic',comicDescriptions:{1:'window'}}],
  ]);
  const chats=new Map(['role-a','role-b'].map((role,index)=>[role+'::novel',{messages:[{text:role}],slices:[{memory:role}],cursor:index+3}]));
  const vectors=new Map([...chats.keys()].map(key=>[key,{model:'synthetic',vecs:{[key]:[1,2,3]}}]));
  const images=[{key:'novel::1',blob:new Blob(['illustration'],{type:'image/png'})},{key:'comic::1',blob:new Blob(['comic page'],{type:'image/png'})}];
  const settings={apiKey:'synthetic-source',coread:{books,bookId:'novel',assistant:{apiProfileId:'source-only'}}};
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
  let current={apiKey:'synthetic-recipient',coread:{books:[],bookId:''}},saves=0;
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

for(const version of [1,5])for(const configFirst of [true,false])test(`v${version} cross-package round trip keeps book IDs and per-companion memories (${configFirst?'config':'originals'} first)`,async()=>{
  const source=fixture(),before=structuredClone(source.settings),target=destination();
  const config=readConfigEnvelope(await readConfigFile(new Blob([JSON.stringify({type:'qianmu-config',version:2,includeApi:false,settings:omitConfigConnections(structuredClone(source.settings))})])));
  const data=await collectCoreadPackageData({bookMetas:source.settings.coread.books,blobStore:source.reader,blobToBase64:encode});
  const exported=prepareCoreadPackageExport({type:'qianmu-coread',version,...data});assert.equal(exported.preservationOnly,false);
  const parsed=await readCoreadPackageFile(exported.blob);
  const restoreConfig=()=>target.config(restoreConfigConnections(structuredClone(config.settings),target.current()));
  if(configFirst){restoreConfig();assert.equal(target.stores.books.has('novel'),false,'configuration alone cannot manufacture a book original');}
  const progress=await applyCoreadPackageData(parsed,{blobStore:target.writer,coread:()=>target.current().coread,isPlainObject:plain,base64ToBlob:decode,onBookIndexed:target.save,warn:()=>assert.fail('unexpected partial restore')});
  if(!configFirst)restoreConfig();
  assert.equal(progress.ok,2);assert.equal(progress.chatOk,2);assert.equal(progress.vectorOk,2);assert.equal(progress.imageOk,2);assert.equal(progress.audioOk,1);
  assert.deepEqual(target.current().coread.books,source.settings.coread.books);assert.equal(target.current().coread.bookId,'novel');
  for(const [id,original] of source.records){const restored=target.stores.books.get(id);for(const key of ['fullText','chapters','sig','comicDescriptions'])assert.deepEqual(restored[key],original[key]);}
  for(const [key,record] of source.chats)assert.deepEqual(target.stores.chats.get(key),record,'same-book companion histories must not be merged');
  for(const [key,record] of source.vectors)assert.deepEqual(target.stores.vectors.get(key),record);
  for(const image of source.images)assert.equal(await target.stores.images.get(image.key).text(),await image.blob.text());
  assert.equal(await target.stores.covers.get('novel').text(),'cover');assert.equal(await target.stores.audio.get('voice').blob.text(),'voice');
  assert.equal(target.stores.audio.has('other-module'),false);assert.equal(target.stores.books.get('outside-pack').fullText,'keep');assert.ok(target.stores.audio.has('local-audio'));
  assert.equal(target.current().apiKey,'synthetic-recipient');assert.equal(target.current().coread.assistant.apiProfileId,undefined);
  assert.equal(target.saves(),3);assert.deepEqual(source.settings,before);
});

for(const missing of ['getBook','getCover','getReaderChat','getReaderVectors'])test(`a configured index with missing ${missing} cannot be exported as a complete originals pack`,async()=>{
  const source=fixture();source.reader[missing]=async()=>undefined;
  await assert.rejects(collectCoreadPackageData({bookMetas:source.settings.coread.books,blobStore:source.reader,blobToBase64:encode}),/未能完整读取/);
  assert.equal(source.settings.coread.books.length,2,'failed export leaves the only source index intact');
});
