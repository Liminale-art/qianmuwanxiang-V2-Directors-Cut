import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readCoreadPackageFile,coreadPackageSafeKey,COREAD_PACKAGE_LIMITS,createCoreadImportProgress,coreadImportProgressText,prepareCoreadPackageExport} from '../qianmu-reader-package.js';
import {isPlainObject,clone} from '../qianmu-storyboard-utils.js';
import {storyboardFunctionSource as source} from './helpers/storyboard-form-fixture.mjs';
const file=text=>({size:Buffer.byteLength(text),text:async()=>text});
test('legacy reader packs retain original content and all supported v1-v5 variants',async()=>{
  for(const version of [undefined,1,2,3,4,5]){
    const value={type:'qianmu-coread',version,books:[{meta:{id:'book'},fullText:'__proto__ is ordinary prose'}],prefs:{fontSize:18}};
    assert.deepEqual(await readCoreadPackageFile(file(JSON.stringify(value))),JSON.parse(JSON.stringify(value)));
  }
});
test('unreadably large input is rejected before reading or allocating its contents',async()=>{
  let reads=0;await assert.rejects(()=>readCoreadPackageFile({size:COREAD_PACKAGE_LIMITS.bytes+1,text(){reads++;}}),/256 MiB/);assert.equal(reads,0);
});
test('dangerous keys, duplicate fields, excessive nesting and invalid envelopes fail closed',async()=>{
  const invalid=[
    '{"type":"qianmu-coread","books":[],"prefs":{"__proto__":{"polluted":true}}}',
    '{"type":"qianmu-coread","books":[],"prefs":{"\\u0063onstructor":{}}}',
    '{"type":"qianmu-coread","books":[],"books":[1]}',
    '{"type":"qianmu-coread","books":[],"prefs":{"x":1e999}}',
    JSON.stringify({type:'qianmu-coread',books:[],version:6}),
    JSON.stringify({type:'qianmu-coread',books:[],audio:{}}),
    JSON.stringify({type:'qianmu-coread',books:[],prefs:[]}),
    '['.repeat(41)+'0'+']'.repeat(41),
  ];for(const text of invalid)await assert.rejects(()=>readCoreadPackageFile(file(text)));
});
test('actual merge and export helpers cannot mutate prototypes even if called without the reader',()=>{
  const c=vm.createContext({isPlainObject,clone,coreadPackageSafeKey});
  vm.runInContext(['coreadIsCredentialKey','coreadSanitizePackageValue','coreadMergePackageValue'].map(source).join('\n'),c);
  const result=vm.runInContext(`const bad=JSON.parse('{"__proto__":{"qianmuAuditMarker":true},"constructor":{},"safe":"keep"}');
    const merged=coreadMergePackageValue({},bad),clean=coreadSanitizePackageValue(bad);
    ({polluted:({}).qianmuAuditMarker===true,merged:JSON.stringify(merged),clean:JSON.stringify(clean)});`,c);
  assert.equal(result.polluted,false);assert.equal(result.merged,'{"safe":"keep"}');assert.equal(result.clean,'{"safe":"keep"}');
});
test('the actual import rejects unsafe packs before any confirmation or storage action',async()=>{
  const notices=[],reader={},c=vm.createContext({createCoreadImportProgress,coreadImportProgressText,settings:{},storyboardAdmissionEpoch:1,coread:()=>reader,configRestoreActivity:()=>({}),readCoreadPackageFile,toast:m=>notices.push(m)});
  c.createCoreadImportViewGuard=()=>({check(){},release(){}});
  vm.runInContext(source('coreadImportDataFile'),c);
  await c.coreadImportDataFile(file('{"type":"qianmu-coread","books":[],"prototype":{}}'));
  assert.match(notices[0],/未写入内容/);
});

const pack=()=>({type:'qianmu-coread',version:5,books:[{meta:{id:'original',hasCover:true},fullText:'完整原文',coverB64:'YQ=='}],chats:[{key:'chat-a::original',rec:{messages:[],slices:[]}}],images:[{key:'original::1',b64:'YQ=='}],vectors:[{key:'chat-a::original',rec:{vecs:{}}}],audio:[{key:'voice',b64:'YQ==',meta:{source:'coread'}}],retrievalLogs:[{at:1}]});

for(const key of ['books','chats','images','vectors','audio','retrievalLogs'])test(key+' invalid later entry is rejected before confirmation or destination access',async()=>{
  const value=pack();value[key].push(null);const notices=[];let asked=0,writes=0;
  const reader={},c=vm.createContext({createCoreadImportProgress,coreadImportProgressText,settings:{},storyboardAdmissionEpoch:1,coread:()=>reader,configRestoreActivity:()=>({}),readCoreadPackageFile,toast:m=>notices.push(m),confirmDialog:async()=>{asked++;return true;},blobStore:{blobStoreAvailable(){writes++;return true;}}});
  c.createCoreadImportViewGuard=()=>({check(){},release(){}});vm.runInContext(source('coreadImportDataFile'),c);
  await c.coreadImportDataFile(file(JSON.stringify(value)));
  assert.equal(asked,0);assert.equal(writes,0);assert.match(notices[0],/第 2 项/);assert.equal(c.coreadImportDataFile.busy,false);
  const prepared=prepareCoreadPackageExport(value);assert.equal(prepared.preservationOnly,true);assert.deepEqual(JSON.parse(await prepared.blob.text()),value);
});

test('missing prose cannot silently replace a local original with empty text; intentional empty comic remains legal',async()=>{
  for(const patch of [{fullText:undefined},{fullText:null},{fullText:[]},{chapters:{}},{comicDescriptions:[]},{coverB64:null},{coverB64:''}]){
    const value=pack();Object.assign(value.books[0],patch);
    await assert.rejects(readCoreadPackageFile(file(JSON.stringify(value))),/第 1 项/);
  }
  const value=pack();value.books[0]={meta:{id:'comic',mode:'comic'},fullText:'',chapters:[],comicDescriptions:{page1:'原文'}};
  assert.deepEqual(await readCoreadPackageFile(file(JSON.stringify(value))),value);
});

test('duplicate identifiers fail within each destination, never silently taking the last item',async()=>{
  for(const key of ['books','chats','images','vectors','audio']){
    const value=pack();value[key].push(structuredClone(value[key][0]));
    await assert.rejects(readCoreadPackageFile(file(JSON.stringify(value))),/编号重复/);
  }
  // Distinct companions for the same book remain distinct; IDs may overlap across different stores.
  const value=pack();value.chats.push({key:'chat-b::original',rec:{messages:['other companion'],slices:[]}});value.audio[0].key=value.images[0].key;
  assert.deepEqual(await readCoreadPackageFile(file(JSON.stringify(value))),value);
});

test('malformed keys, records and media fields are not coerced into writable entries',async()=>{
  for(const [key,patch] of [['books',{meta:{id:3}}],['chats',{key:[]}],['chats',{rec:[]}],['vectors',{rec:null}],['images',{b64:[]}],['audio',{b64:''}],['audio',{meta:[]}],['images',{key:' '}],['books',{meta:null}]]){
    const value=pack();Object.assign(value[key][0],patch);await assert.rejects(readCoreadPackageFile(file(JSON.stringify(value))),/第 1 项/);
  }
  for(const version of [true,[1],null])await assert.rejects(readCoreadPackageFile(file(JSON.stringify({...pack(),version}))),/版本/);
});

test('preflight preserves legacy extra metadata and original identity/progress/memory instead of rewriting it',async()=>{
  for(const version of [undefined,1,'1',2,3,4,5,'5']){
    const value=pack();value.version=version;value.books[0].meta.progress=0.67;
    value.chats[0].rec.legacy={names:{char:'书友'},cursor:71,custom:'do not discard'};
    const original=JSON.stringify(value),prepared=prepareCoreadPackageExport(value);assert.equal(prepared.preservationOnly,false);
    const restored=await readCoreadPackageFile(file(original));assert.equal(JSON.stringify(restored),original);assert.equal(JSON.stringify(value),original);
  }
});

test('every inline media category rejects damaged encoding before any prose can be overwritten',async()=>{
  for(const key of ['books','images','audio'])for(const encoded of ['YR==','YQ=','Y Q==','data:audio/mpeg;base64,YQ==','!!!!']){
    const value=pack();value[key][0][key==='books'?'coverB64':'b64']=encoded;
    await assert.rejects(readCoreadPackageFile(file(JSON.stringify(value))),/媒体编码/);
    const prepared=prepareCoreadPackageExport(value);assert.equal(prepared.preservationOnly,true);assert.deepEqual(JSON.parse(await prepared.blob.text()),value);
  }
});

test('media family and complete MIME parameters survive while wrong or malformed types fail closed',async()=>{
  for(const key of ['books','images','audio'])for(const mime of ['text/html',{},'audio/','image/\r\nbad']){
    const value=pack();value[key][0][key==='books'?'coverMime':'mime']=mime;
    await assert.rejects(readCoreadPackageFile(file(JSON.stringify(value))),/媒体类型/);
  }
  const value=pack();value.audio[0].mime='audio/webm;codecs=opus';value.images[0].mime='image/*';
  assert.deepEqual(await readCoreadPackageFile(file(JSON.stringify(value))),value);
});
