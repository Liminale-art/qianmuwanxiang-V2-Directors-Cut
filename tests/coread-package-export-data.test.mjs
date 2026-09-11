import test from 'node:test';
import assert from 'node:assert/strict';
import {collectCoreadPackageData} from '../qianmu-reader-package.js';
function fixture(){
  const calls=[],warnings=[],bookMetas=[{id:'book',title:'fixture'}];
  const original={fullText:'original prose',chapters:[{start:0}],sig:'signature',comicDescriptions:{page1:'description'}};
  const data={getBook:original,getCover:{type:'image/png',kind:'cover'},listReaderChatKeys:['chat::book'],getReaderChat:{messages:['chat'],slices:['memory'],cursor:5},
    listReaderImages:[{key:'book::1',blob:{type:'image/png',kind:'image'}}],listReaderVectorKeys:['chat::book'],getReaderVectors:{model:'fixture',vecs:{v:[1,2]}},
    listAudio:[{key:'reader-voice',blob:{type:'audio/mpeg',kind:'voice'},meta:{source:'coread'},createdAt:9},{key:'unrelated',blob:{kind:'unrelated'},meta:{source:'tts'}}],listRetLog:[{id:2,at:8,query:'fixture'}]};
  const blobStore=Object.fromEntries(Object.entries(data).map(([name,result])=>[name,async(...args)=>{calls.push([name,...args]);return result;}]));
  return {calls,warnings,original,data,options:{bookMetas,blobStore,blobToBase64:async blob=>blob.kind,warn:(...args)=>warnings.push(args)}};
}
test('the extracted collector retains book originals and each supported media category without unrelated audio',async()=>{
  const e=fixture(),result=await collectCoreadPackageData(e.options);
  assert.deepEqual(result.books,[{meta:e.options.bookMetas[0],...e.original,coverB64:'cover',coverMime:'image/png'}]);
  assert.deepEqual(result.chats,[{key:'chat::book',rec:e.data.getReaderChat}]);
  assert.deepEqual(result.images,[{key:'book::1',b64:'image',mime:'image/png'}]);
  assert.deepEqual(result.vectors,[{key:'chat::book',rec:e.data.getReaderVectors}]);
  assert.deepEqual(result.audio,[{key:'reader-voice',b64:'voice',mime:'audio/mpeg',meta:{source:'coread'},createdAt:9}]);
  assert.deepEqual(result.retrievalLogs,e.data.listRetLog);assert.deepEqual(e.warnings,[]);
});
test('books without an optional cover still retain their original text and chapter data',async()=>{
  const e=fixture();e.options.blobStore.getCover=async()=>undefined;
  const result=await collectCoreadPackageData(e.options);
  assert.equal(result.books[0].coverB64,'');assert.equal(result.books[0].fullText,e.original.fullText);
  assert.deepEqual(result.books[0].chapters,e.original.chapters);
});
test('an empty library exports empty category arrays without requesting a nonexistent book',async()=>{
  const e=fixture();e.options.bookMetas=[];
  for(const name of ['listReaderChatKeys','listReaderImages','listReaderVectorKeys','listAudio','listRetLog'])e.options.blobStore[name]=async()=>[];
  const result=await collectCoreadPackageData(e.options);
  assert.deepEqual(result,{books:[],chats:[],images:[],vectors:[],audio:[],retrievalLogs:[]});assert.deepEqual(e.calls,[]);
});

test('every failed original or category read stops the complete collector without leaking underlying error text',async()=>{
  for(const method of ['getBook','getCover','listReaderChatKeys','getReaderChat','listReaderImages','listReaderVectorKeys','getReaderVectors','listAudio','listRetLog']){
    const e=fixture();e.options.blobStore[method]=async()=>{throw Error('sensitive fixture detail');};
    await assert.rejects(()=>collectCoreadPackageData(e.options),error=>/未能完整读取/.test(error.message)&&!error.message.includes('sensitive'));
  }
});
test('missing required originals or malformed inventory cannot silently become empty exported data',async()=>{
  const cases=[['getBook',undefined],['getBook',{}],['getReaderChat',null],['getReaderVectors',null],['listReaderImages',[{key:'missing'}]],
    ['listAudio',[{key:'missing',meta:{source:'coread'}}]],['listRetLog',[null]]];
  for(const method of ['listReaderChatKeys','listReaderImages','listReaderVectorKeys','listAudio','listRetLog'])cases.push([method,undefined]);
  for(const [method,value] of cases){const e=fixture();e.options.blobStore[method]=async()=>value;await assert.rejects(()=>collectCoreadPackageData(e.options),/未能完整读取/);}
  const e=fixture();e.options.bookMetas[0].hasCover=true;e.options.blobStore.getCover=async()=>undefined;
  await assert.rejects(()=>collectCoreadPackageData(e.options),/书籍封面/);
});
test('a failed or empty media encoding prevents a misleading partial backup',async()=>{
  for(const kind of ['cover','image','voice'])for(const fail of [true,false]){
    const e=fixture();e.options.blobToBase64=async blob=>{if(blob.kind!==kind)return blob.kind;if(fail)throw Error('encode failed');return '';};
    await assert.rejects(()=>collectCoreadPackageData(e.options),/未能完整读取/);
  }
});
