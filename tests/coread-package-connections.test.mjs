import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {storyboardFunctionSource as source} from './helpers/storyboard-form-fixture.mjs';
import {isPlainObject,clone} from '../qianmu-storyboard-utils.js';
import {readCoreadPackageFile,coreadPackageSafeKey,coreadPackageRestoreMessage,applyCoreadPackageData,collectCoreadPackageData,prepareCoreadPackageExport,createCoreadImportProgress,coreadImportProgressText,finishCoreadPackageImport} from '../qianmu-reader-package.js';
import {omitConfigConnections} from '../qianmu-config-connections.js';
function fixture(local){
  let exported;const notices=[];
  const c=vm.createContext({isPlainObject,clone,readCoreadPackageFile,coreadPackageSafeKey,coreadPackageRestoreMessage,applyCoreadPackageData,createCoreadImportProgress,coreadImportProgressText,finishCoreadPackageImport,omitConfigConnections,
    settings:{},storyboardAdmissionEpoch:1,configRestoreActivity:()=>({}),coread:()=>local,readerDialog:{loaded:false},toast:m=>notices.push(m),confirmDialog:async()=>true,base64ToBlob:()=>{throw Error('unexpected media');},MODULE_NAME:'fixture',
    blobStore:{blobStoreAvailable:()=>true,listReaderChatKeys:async()=>[],listReaderImages:async()=>[],listReaderVectorKeys:async()=>[],listAudio:async()=>[],listRetLog:async()=>[]},
    saveSettings(){},renderModal(){},rerenderMoreIfOpen(){},fileStamp:()=> 'fixture',
    document:{createElement:()=>({click(){},remove(){}}),body:{appendChild(){}}},URL:{createObjectURL:()=> 'blob:fixture',revokeObjectURL(){}},setTimeout(){},
    Blob:class{constructor(parts){exported=JSON.parse(parts[0]);}}});
  vm.runInContext(['ttsDownloadBlob','coreadIsCredentialKey','coreadSanitizePackageValue','coreadMergePackageValue','coreadImportDataFile','coreadExportData'].map(source).join('\n'),c);
  c.collectCoreadPackageData=collectCoreadPackageData;
  c.prepareCoreadPackageExport=payload=>{const prepared=prepareCoreadPackageExport(payload);exported=JSON.parse(JSON.stringify(payload));return prepared;};
  c.configRestoreActivity=(includeCleanup=true,ownTransfer=null)=>({transfer:(ownTransfer!==c.coreadExportData&&c.coreadExportData.busy)||(ownTransfer!==c.coreadImportDataFile&&c.coreadImportDataFile.busy),...c.competingActivity});
  c.blobToBase64=async()=>{throw Error('unexpected media in connection-only fixture');};
  c.createCoreadImportViewGuard=(origin,action)=>({check(){if(c.pageChanged)throw Error(`${action} page changed`);},release(){c.viewReleased=true;}});
  c.blobStore.createReaderPackageWriter=({check})=>{assert.equal(typeof check,'function');return c.blobStore;};
  c.blobStore.createReaderPackageReader=({check})=>{assert.equal(typeof check,'function');return c.blobStore;};
  return {c,notices,exported:()=>exported,run:prefs=>c.coreadImportDataFile({text:async()=>JSON.stringify({type:'qianmu-coread',version:5,books:[],prefs})})};
}
test('non-restorable originals require explicit consent and confirmation cannot outlive their owner or page',async()=>{
  for(const mode of ['confirm','cancel','page','settings','reader','epoch','activity']){
    const local=settings(),e=fixture(local),downloads=[];let asks=0;
    let rec={original:'keep this complete'};for(let i=0;i<42;i++)rec={nested:rec};
    e.c.blobStore.listReaderChatKeys=async()=>['chat'];e.c.blobStore.getReaderChat=async()=>rec;
    e.c.ttsDownloadBlob=(blob,name)=>downloads.push({blob,name});
    e.c.confirmDialog=async(title,text)=>{
      asks++;assert.match(title,/保全/);assert.match(text,/不能直接恢复/);
      if(mode==='page')e.c.pageChanged=true;
      if(mode==='settings')e.c.settings={};if(mode==='reader')e.c.coread=()=>({});
      if(mode==='epoch')e.c.storyboardAdmissionEpoch++;if(mode==='activity')e.c.competingActivity={voice:true};
      return mode!=='cancel';
    };
    await e.c.coreadExportData();assert.equal(asks,1);assert.equal(e.c.coreadExportData.busy,false);assert.equal(e.c.viewReleased,true);
    assert.equal(downloads.length,mode==='confirm'?1:0);
    assert.equal(e.notices.some(n=>n.includes('伴读数据已打包导出')),false,'a preservation copy is never advertised as a normal restorable pack');
    if(mode==='confirm'){
      assert.match(downloads[0].name,/preservation/);assert.match(e.notices.at(-1),/不能直接恢复/);
      const saved=JSON.parse(await downloads[0].blob.text());assert.deepEqual(saved.chats[0].rec,rec);
      await assert.rejects(()=>readCoreadPackageFile(downloads[0].blob));
    }
  }
});

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

test('partially restored originals retain local preferences instead of selecting a possibly unrestored book',async()=>{
  for(const failure of ['failed','invalid']){
    const local=settings(),before=structuredClone(local),e=fixture(local);
    e.c.applyCoreadPackageData=async(data,{progress})=>{progress.ok=1;progress[failure]=1;local.books.push({id:'committed',title:'preserve this successful entry'});};
    await e.run({fontSize:28,currentBookId:'failed-book',collections:[{id:'foreign',name:'incoming'}]});
    assert.equal(local.fontSize,before.fontSize);assert.equal(local.currentBookId,undefined);assert.deepEqual(local.collections,before.collections);
    assert.equal(local.books[0].id,'committed','do not compensate by throwing away successfully imported originals');
    assert.match(e.notices.at(-1),/包内阅读偏好未应用/);assert.equal(e.c.coreadImportDataFile.busy,false);
  }
});

test('actual entry keeps committed shelf records when host save throws and does not reapply incoming preferences',async()=>{
  const local=settings(),e=fixture(local),before=structuredClone(local);let saves=0,writes=0;
  e.c.applyCoreadPackageData=async(data,{progress})=>{writes++;progress.ok=1;local.books.push({id:'committed'});};
  e.c.saveSettings=()=>{saves++;throw Error('synthetic save failure');};
  await e.run({fontSize:28,currentBookId:'incoming'});
  assert.equal(writes,1);assert.equal(saves,2);assert.equal(local.fontSize,before.fontSize);assert.equal(local.currentBookId,undefined);assert.equal(local.books[0].id,'committed');
  assert.match(e.notices.at(-1),/设置保存结果未确认/);assert.equal(e.c.coreadImportDataFile.busy,false);
});

test('actual entry reports a repaint failure separately after applied preferences without rerunning storage',async()=>{
  const local=settings(),e=fixture(local);let writes=0,saves=0;e.c.applyCoreadPackageData=async()=>{writes++;};
  e.c.saveSettings=()=>{saves++;};e.c.renderModal=()=>{throw Error('synthetic view failure');};
  await e.run({fontSize:28});assert.equal(local.fontSize,28);assert.equal(writes,1);assert.equal(saves,1);
  assert.match(e.notices.at(-1),/不必重复导入/);assert.equal(e.notices.some(n=>n.startsWith('伴读导入未完成：')),false);
});

test('actual import schedules the first restored shelf before a later write is interrupted',async()=>{
  const local=settings(),e=fixture(local),saved=[];let release,writes=0;
  e.c.saveSettings=()=>saved.push(structuredClone(local.books));
  e.c.blobStore.putBookWithCover=async()=>{if(++writes===2)await new Promise(r=>release=r);};
  const data={type:'qianmu-coread',books:[{meta:{id:'first'},fullText:'one'},{meta:{id:'second'},fullText:'two'}],prefs:{fontSize:28}};
  const pending=e.c.coreadImportDataFile({text:async()=>JSON.stringify(data)});await new Promise(r=>setImmediate(r));
  assert.equal(typeof release,'function');assert.deepEqual(saved.map(books=>books.map(b=>b.id)),[['first']]);
  e.c.pageChanged=true;release();await pending;
  assert.equal(saved.length,1,'no save to the changed page or state owner');assert.equal(local.fontSize,16,'incoming preferences not applied after interruption');
  assert.match(e.notices.at(-1),/已导入 2 本书原件/);assert.equal(e.c.coreadImportDataFile.busy,false);
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

test('a pending export excludes duplicate export and reader import, then releases its busy flag',async()=>{
  const local=settings();local.books=[{id:'book'}];const e=fixture(local);let release,reads=0;
  e.c.blobStore.getBook=()=>{reads++;return new Promise(r=>release=r);};e.c.blobStore.getCover=async()=>undefined;
  const pending=e.c.coreadExportData();await new Promise(r=>setImmediate(r));assert.equal(e.c.coreadExportData.busy,true);
  await e.c.coreadExportData();assert.equal(reads,1);assert.match(e.notices.at(-1),/重复导出/);
  await e.run({fontSize:77});assert.equal(local.fontSize,16);assert.match(e.notices.at(-1),/结束正在进行的任务/);
  release({fullText:'original'});await pending;assert.ok(e.exported());assert.equal(e.c.coreadExportData.busy,false);
});
test('competing operations block export before reading and stop a pending export without downloading',async()=>{
  for(const lane of ['voice','reader','focus','director','image','transfer']){
    const local=settings();local.books=[{id:'book'}];const e=fixture(local);let release,reads=0;
    e.c.blobStore.getBook=()=>{reads++;return new Promise(r=>release=r);};e.c.blobStore.getCover=async()=>undefined;
    e.c.competingActivity={[lane]:true};await e.c.coreadExportData();assert.equal(reads,0);assert.equal(!!e.c.coreadExportData.busy,false);
    e.c.competingActivity={};const pending=e.c.coreadExportData();await new Promise(r=>setImmediate(r));
    e.c.competingActivity={[lane]:true};release({fullText:'original'});await pending;
    assert.equal(e.exported(),undefined);assert.equal(e.c.coreadExportData.busy,false);assert.match(e.notices.at(-1),/其他任务已开始/);
  }
});

for(const phase of ['save','read'])test('closing the export page during '+phase+' prevents download and releases its guard',async()=>{
  const local=settings();local.books=[{id:'book'}];const e=fixture(local);let release;
  e.c.blobStore.getBook=async()=>({fullText:'original'});e.c.blobStore.getCover=async()=>undefined;
  if(phase==='save'){e.c.readerDialog.loaded=true;e.c.coreadSaveDialog=()=>new Promise(r=>release=r);}
  else e.c.blobStore.getBook=()=>new Promise(r=>release=r);
  const pending=e.c.coreadExportData();await new Promise(r=>setImmediate(r));e.c.pageChanged=true;release({fullText:'original'});await pending;
  assert.equal(e.exported(),undefined);assert.equal(e.c.coreadExportData.busy,false);assert.equal(e.c.viewReleased,true);assert.match(e.notices.at(-1),/导出 page changed/);
});
