import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {storyboardFunctionSource as source} from './helpers/storyboard-form-fixture.mjs';
import {isPlainObject,clone} from '../qianmu-storyboard-utils.js';
import {readCoreadPackageFile,coreadPackageSafeKey,applyCoreadPackageData,collectCoreadPackageData,createCoreadImportProgress,coreadImportProgressText} from '../qianmu-reader-package.js';
import {omitConfigConnections} from '../qianmu-config-connections.js';
function fixture(local){
  let exported;const notices=[];
  const c=vm.createContext({isPlainObject,clone,readCoreadPackageFile,coreadPackageSafeKey,applyCoreadPackageData,createCoreadImportProgress,coreadImportProgressText,omitConfigConnections,
    settings:{},storyboardAdmissionEpoch:1,configRestoreActivity:()=>({}),coread:()=>local,readerDialog:{loaded:false},toast:m=>notices.push(m),confirmDialog:async()=>true,base64ToBlob:()=>{throw Error('unexpected media');},MODULE_NAME:'fixture',
    blobStore:{blobStoreAvailable:()=>true,listReaderChatKeys:async()=>[],listReaderImages:async()=>[],listReaderVectorKeys:async()=>[],listAudio:async()=>[],listRetLog:async()=>[]},
    saveSettings(){},renderModal(){},rerenderMoreIfOpen(){},fileStamp:()=> 'fixture',
    document:{createElement:()=>({click(){},remove(){}}),body:{appendChild(){}}},URL:{createObjectURL:()=> 'blob:fixture',revokeObjectURL(){}},
    Blob:class{constructor(parts){exported=JSON.parse(parts[0]);}}});
  vm.runInContext(['coreadIsCredentialKey','coreadSanitizePackageValue','coreadMergePackageValue','coreadImportDataFile','coreadExportData'].map(source).join('\n'),c);
  c.collectCoreadPackageData=collectCoreadPackageData;
  c.blobToBase64=async()=>{throw Error('unexpected media in connection-only fixture');};
  c.createCoreadImportViewGuard=()=>({check(){},release(){}});
  c.blobStore.createReaderPackageWriter=({check})=>{assert.equal(typeof check,'function');return c.blobStore;};
  return {c,notices,exported:()=>exported,run:prefs=>c.coreadImportDataFile({text:async()=>JSON.stringify({type:'qianmu-coread',version:5,books:[],prefs})})};
}
function settings(){
  return {books:[],collections:[{id:'collection',name:'fixture'}],enabled:true,fontSize:16,assistant:{apiProfileId:'local-assistant'},comic:{visionApiProfileId:'local-vision'},
    memory:{dialogProvider:'sillytavern',dialogApiProfileId:'local-dialog',...Object.fromEntries(['vector','rerank','summary'].flatMap(kind=>[
      [kind+'ApiUrl','https://local.invalid'],[kind+'ApiKey','synthetic-key'],[kind+'Model','local-model'],[kind+'Models',['local-model']],
      [kind+'Profiles',[{id:'local',apiUrl:'https://local.invalid',apiKey:'synthetic-profile'}]],[kind+'ProfileSel','local']]))}};
}
test('reader import preserves each recipient connection group and cannot transfer keys by list position',async()=>{
  const local=settings(),before=structuredClone(local),e=fixture(local),incoming=settings();
  incoming.fontSize=20;incoming.enabled=false;
  incoming.assistant.apiProfileId='foreign';incoming.comic.visionApiProfileId='foreign';incoming.memory.dialogProvider='external';incoming.memory.dialogApiProfileId='foreign';
  for(const kind of ['vector','rerank','summary']){
    incoming.memory[kind+'ApiUrl']='https://other.invalid';incoming.memory[kind+'ApiKey']='incoming-placeholder';
    incoming.memory[kind+'Profiles']=[{id:'different',apiUrl:'https://other.invalid'}];incoming.memory[kind+'ProfileSel']='different';
  }
  await e.run(incoming);assert.equal(local.fontSize,20);assert.equal(local.enabled,true);
  assert.deepEqual(local.memory,before.memory);assert.deepEqual(local.assistant,before.assistant);assert.deepEqual(local.comic,before.comic);
});
test('absent recipient connections stay absent instead of accepting source endpoints or profile bindings',async()=>{
  const local={books:[],fontSize:16},e=fixture(local);await e.run(settings());
  for(const key of ['memory','assistant','comic'])assert.equal(JSON.stringify(local[key]),'{}');
});
test('actual reader export strips complete connections from a detached copy and retains reading preferences',async()=>{
  const local=settings(),before=structuredClone(local),e=fixture(local);await e.c.coreadExportData();
  const result=e.exported();assert.deepEqual(local,before);assert.equal(result.prefs.fontSize,16);assert.equal(result.version,5);
  assert.deepEqual(result.prefs.collections,before.collections);
  assert.deepEqual(result.prefs.memory,{});assert.deepEqual(result.prefs.assistant,{});assert.deepEqual(result.prefs.comic,{});
  assert.equal(JSON.stringify(result).includes('synthetic'),false);assert.equal(JSON.stringify(result).includes('https://local.invalid'),false);
});

test('the actual exporter never creates a downloadable complete pack after a required read or dialog save fails',async()=>{
  for(const failure of ['getBook','listAudio','coreadSaveDialog']){
    const local=settings();local.books=[{id:'book'}];const e=fixture(local);
    e.c.blobStore.getBook=async()=>({fullText:'original'});e.c.blobStore.getCover=async()=>undefined;
    if(failure==='coreadSaveDialog'){e.c.readerDialog.loaded=true;e.c.coreadSaveDialog=async()=>{throw Error('save failed');};}
    else e.c.blobStore[failure]=async()=>{throw Error('read failed');};
    await e.c.coreadExportData();assert.equal(e.exported(),undefined,'no Blob was created for a partial pack');
    assert.match(e.notices.at(-1),/备份未完成/);assert.equal(e.notices.some(n=>n.includes('已打包导出')),false);
  }
});

test('the actual export freezes book metadata and preferences together before asynchronous collection',async()=>{
  const local=settings();local.books=[{id:'original',title:'before'}];const e=fixture(local);let release;
  e.c.blobStore.getBook=()=>new Promise(r=>release=r);e.c.blobStore.getCover=async()=>undefined;
  const pending=e.c.coreadExportData();await new Promise(r=>setImmediate(r));
  local.fontSize=99;local.books[0].title='after';local.books.push({id:'new'});
  release({fullText:'original prose'});await pending;
  const result=e.exported();assert.equal(result.prefs.fontSize,16);assert.equal(result.books.length,1);
  assert.equal(result.books[0].meta.title,'before');assert.equal(result.prefs.books,undefined,'the existing preference format excludes book originals');
  assert.equal(local.fontSize,99);assert.equal(local.books.length,2,'export cannot overwrite live changes');
});
for(const phase of ['save','read'])test('actual export '+phase+' cannot finish under a different state owner',async()=>{
  for(const changed of ['settings','reader','epoch']){
    const local=settings();local.books=[{id:'original'}];const e=fixture(local);let release;
    e.c.blobStore.getBook=async()=>({fullText:'original'});e.c.blobStore.getCover=async()=>undefined;
    if(phase==='save'){e.c.readerDialog.loaded=true;e.c.coreadSaveDialog=()=>new Promise(r=>release=r);}
    else e.c.blobStore.getBook=()=>new Promise(r=>release=r);
    const pending=e.c.coreadExportData();await new Promise(r=>setImmediate(r));
    if(changed==='settings')e.c.settings={changed:true};if(changed==='reader')e.c.coread=()=>({});if(changed==='epoch')e.c.storyboardAdmissionEpoch++;
    release({fullText:'original'});await pending;assert.equal(e.exported(),undefined);assert.match(e.notices.at(-1),/伴读状态已变化/);
  }
});
