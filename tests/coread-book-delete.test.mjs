import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {storyboardFunctionSource as section} from './helpers/storyboard-form-fixture.mjs';

function fixture() {
  const data={books:[{id:'a',title:'Alpha',progress:45},{id:'b',title:'Beta'}],collections:[{id:'folder',name:'Folder',bookIds:['a','b'],createdAt:1,updatedAt:1}]};
  const page={isConnected:true,hidden:false},modal={classList:{contains:()=>true},querySelector:()=>page},calls=[],notices=[];
  let saveAnswer;
  const c=vm.createContext({settings:{enabled:true,coread:data},MODAL_ID:'modal',RUNTIME_LOCK_KEY:'runtime',runtime:{},coreadOpenRequestId:0,
    document:{getElementById:()=>modal},readerDialog:{bookId:'a',bucket:'chat::a',loaded:true,slices:['unsaved']},readerView:null,coreadEchoTtl:new Map(),
    coreadMemoryWrites:0,coreadIdentitySwitchBusy:false,coreadWorldSyncBusy:false,coreadDistilling:false,coreadAutoTextInFlight:false,dialogBusy:false,readerAssistantBusy:false,coreadComicVisionBusy:false,
    coreadSaveDialog:()=>new Promise(resolve=>{calls.push('save-dialog');saveAnswer=resolve;}),unmountReaderPortal:()=>calls.push('unmount'),saveSettings:()=>calls.push('save-settings'),
    coreadInvalidatePool:()=>{},coreadClearBookDialogue:async()=>{calls.push('clear-dialog');return {};},coreadPurgeBookMemory:async()=>{calls.push('purge-memory');return {};},
    blobStore:{deleteBook:async()=>calls.push('delete-body'),deleteReaderImages:async()=>calls.push('delete-images')},toast:(...args)=>notices.push(args),console:{warn:()=>{}},MODULE_NAME:'fixture'});
  c.coread=()=>c.settings.coread;
  const names=['coreadBookMeta','coreadCollections','coreadCaptureCollectionMutation','coreadDeleteBook','coreadCanDeleteBooks','coreadRequestDeleteBooks'];
  vm.runInContext(names.map(section).join('\n'),c);
  return {c,data,page,calls,notices,answerSave:value=>saveAnswer(value)};
}

test('failed dialogue preservation stops before removing any book, cache or in-memory slices',async()=>{
  const f=fixture(),before=JSON.stringify(f.data),dialog=f.c.readerDialog,pending=f.c.coreadDeleteBook('a');
  f.answerSave(false);const result=await pending;assert.equal(JSON.stringify(f.data),before);assert.equal(f.c.readerDialog,dialog);
  assert.deepEqual(f.calls,['save-dialog']);assert.equal(result,false);assert.match(f.notices.at(-1)[0],/未.*保存|保存.*失败/);
});

const tick=async()=>{await Promise.resolve();await Promise.resolve();};
function requestFixture(){
  const f=fixture();let confirm,memory;const prompts=[];
  f.c.confirmDialog=title=>{prompts.push(['confirm',title]);return new Promise(r=>confirm=r);};
  f.c.coreadChooseDeleteMemory=(title,options)=>{prompts.push(['memory',title]);f.memoryGuard=options.isCurrent;return new Promise(r=>memory=r);};
  return Object.assign(f,{prompts,confirm:v=>confirm(v),memory:v=>memory(v)});
}

test('each confirmation retains the original owner and complete selected-book set',async()=>{
  for(const stage of ['confirm','memory'])for(const change of ['owner','page','runtime','title','replacement','removed','moved','busy']){
    const f=requestFixture(),pending=f.c.coreadRequestDeleteBooks(['a','b']);
    if(stage==='memory'){f.confirm(true);await tick();}
    if(change==='owner')f.c.settings={enabled:true,coread:structuredClone(f.data)};
    if(change==='page')f.page.isConnected=false;if(change==='runtime')f.c.runtime={};
    if(change==='title')f.data.books[1].title='Changed';if(change==='replacement')f.data.books[1]={...f.data.books[1]};
    if(change==='removed')f.data.books.pop();if(change==='moved')f.data.collections[0].bookIds=['a'];if(change==='busy')f.c.coreadMemoryWrites=1;
    const before=JSON.stringify([f.data,f.c.settings]);if(stage==='memory')f.memory(false);else f.confirm(true);
    assert.equal(await pending,false,stage+change);assert.equal(JSON.stringify([f.data,f.c.settings]),before,stage+change);
    assert.deepEqual(f.calls,[],stage+change);assert.equal(f.prompts.length,stage==='confirm'?1:2);
  }
});

test('batch consent is consumed per book rather than invalidated by its own first deletion',async()=>{
  const f=requestFixture(),pending=f.c.coreadRequestDeleteBooks(['a','b','a']);f.confirm(true);await tick();f.memory(false);await tick();f.answerSave(true);
  assert.equal(await pending,true);assert.equal(f.data.books.length,0);assert.equal(f.calls.filter(c=>c==='delete-body').length,2);
  assert.match(f.prompts[0][1],/Alpha.*等 2 本书/);assert.doesNotMatch(f.prompts[0][1],/Beta/);
  assert.match(f.notices.at(-1)[0],/移除 2 本/);assert.doesNotMatch(f.notices.at(-1)[0],/记忆.*已.*删除/);
});

test('a batch stops before a changed next book and reports only the already removed count',async()=>{
  for(const change of ['book','owner']){
    const f=requestFixture();let release;f.c.blobStore.deleteBook=()=>{f.calls.push('delete-body');return new Promise(r=>release=r);};
    const pending=f.c.coreadRequestDeleteBooks(['a','b']);f.confirm(true);await tick();f.memory(false);await tick();f.answerSave(true);await tick();
    assert.equal(f.data.books.length,1);if(change==='book')f.data.books[0].title='New consent required';else f.c.settings={enabled:true,coread:structuredClone(f.data)};
    release();const result=await pending;assert.equal(result,change==='book');assert.equal(f.data.books.length,1);assert.equal(f.c.settings.coread.books.length,1);
    assert.equal(f.calls.filter(c=>c==='delete-body').length,1);assert.match(f.notices.at(-1)[0],/1\/2.*停止/);assert.equal(f.notices.at(-1)[1],'warning');
  }
});

test('cancel, unavailable targets and all busy writers cause zero deletion work',async()=>{
  const f=requestFixture(),pending=f.c.coreadRequestDeleteBooks(['a']);f.confirm(false);assert.equal(await pending,false);assert.deepEqual(f.calls,[]);assert.equal(f.prompts.length,1);
  for(const flag of ['coreadMemoryWrites','coreadIdentitySwitchBusy','coreadWorldSyncBusy','coreadDistilling','coreadAutoTextInFlight','dialogBusy','readerAssistantBusy','coreadComicVisionBusy']){
    const b=requestFixture();b.c[flag]=true;assert.equal(await b.c.coreadRequestDeleteBooks(['a']),false,flag);assert.deepEqual(b.calls,[],flag);assert.equal(b.prompts.length,0,flag);
  }
  const missing=requestFixture();assert.equal(await missing.c.coreadRequestDeleteBooks(['a','missing']),false);assert.equal(missing.prompts.length,0);
});

test('rejected saves and interrupted cleanup fail visibly instead of continuing the batch',async()=>{
  const f=fixture();f.c.coreadSaveDialog=async()=>{throw Error('synthetic');};assert.equal(await f.c.coreadDeleteBook('a'),false);assert.equal(f.data.books.length,2);
  const g=requestFixture();g.c.coreadClearBookDialogue=async()=>{throw Error('synthetic cleanup interruption');};
  const pending=g.c.coreadRequestDeleteBooks(['a','b']);g.confirm(true);await tick();g.memory(false);await tick();g.answerSave(true);
  assert.equal(await pending,true,'original shelf should repaint its partial state');assert.equal(g.data.books.length,1);assert.equal(g.data.books[0].id,'b');
  assert.match(g.notices.at(-1)[0],/未完成/);assert.equal(g.notices.at(-1)[1],'warning');
});

test('a changed owner, page, book or dialogue after preservation cannot inherit old deletion consent',async()=>{
  for(const change of ['owner','page','book','dialogue','memory-busy']) {
    const f=fixture(),pending=f.c.coreadDeleteBook('a');
    if(change==='owner')f.c.settings={enabled:true,coread:structuredClone(f.data)};
    if(change==='page')f.page.isConnected=false;
    if(change==='book')f.data.books[0]={...f.data.books[0]};
    if(change==='dialogue')f.c.readerDialog={bookId:'b',loaded:true};
    if(change==='memory-busy')f.c.coreadMemoryWrites++;
    const before=JSON.stringify([f.data,f.c.settings]);f.answerSave(true);
    assert.equal(await pending,false,change);assert.equal(JSON.stringify([f.data,f.c.settings]),before,change);assert.deepEqual(f.calls,['save-dialog'],change);
  }
});

test('preserving dialogue participates in the existing memory-write guard and excludes a second deletion',async()=>{
  const f=fixture(),first=f.c.coreadDeleteBook('a');
  assert.equal(f.c.coreadMemoryWrites,1);assert.equal(await f.c.coreadDeleteBook('a'),false);assert.deepEqual(f.calls,['save-dialog']);
  f.answerSave(true);assert.equal(await first,true);assert.equal(f.c.coreadMemoryWrites,0);assert.equal(f.calls.filter(c=>c==='delete-body').length,1);
  const failed=fixture();failed.c.coreadSaveDialog=async()=>{throw Error('synthetic');};
  assert.equal(await failed.c.coreadDeleteBook('a'),false);assert.equal(failed.c.coreadMemoryWrites,0,'a rejected save must release its own guard');
});

test('admitted deletion preserves other books and the existing memory choice',async()=>{
  for(const deleteMemory of [false,true]){const f=fixture(),pending=f.c.coreadDeleteBook('a',{deleteMemory});f.answerSave(true);
    assert.equal(await pending,true);assert.equal(f.data.books.length,1);assert.equal(f.data.books[0].id,'b');
    assert.equal(f.calls.includes('purge-memory'),deleteMemory);assert.equal(f.calls.includes('clear-dialog'),!deleteMemory);
    assert.equal(f.data.retainedMemoryBooks.length,deleteMemory?0:1);
  }
});
