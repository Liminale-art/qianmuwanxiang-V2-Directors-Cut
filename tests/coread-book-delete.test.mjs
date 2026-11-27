import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {storyboardFunctionSource as section} from './helpers/storyboard-form-fixture.mjs';

function fixture() {
  const data={books:[{id:'a',title:'Alpha',progress:45},{id:'b',title:'Beta'}],collections:[{id:'folder',name:'Folder',bookIds:['a','b'],createdAt:1,updatedAt:1}]};
  const page={isConnected:true,hidden:false},modal={classList:{contains:()=>true},querySelector:()=>page},calls=[],notices=[],account=[];
  // The account side of a deletion: what the reader asked the two mirrors to do, and what the chat mirror answers.
  const answer={registered:true,pending:[]};
  let saveAnswer;
  const c=vm.createContext({settings:{enabled:true,coread:data},MODAL_ID:'modal',RUNTIME_LOCK_KEY:'runtime',runtime:{},coreadOpenRequestId:0,
    document:{getElementById:()=>modal},readerDialog:{bookId:'a',bucket:'chat::a',loaded:true,slices:['unsaved']},readerView:null,coreadEchoTtl:new Map(),
    coreadMemoryWrites:0,coreadIdentitySwitchBusy:false,coreadDistilling:false,coreadAutoTextInFlight:false,dialogBusy:false,readerAssistantBusy:false,coreadComicVisionBusy:false,
    coreadSaveDialog:()=>new Promise(resolve=>{calls.push('save-dialog');saveAnswer=resolve;}),unmountReaderPortal:()=>calls.push('unmount'),saveSettings:()=>calls.push('save-settings'),
    
    reader:{COREAD_SLICE_SCHEMA_VERSION:3},readerContentCache:null,readerAssistant:null,readerAssistantSessions:new Map(),dialogGenToken:0,dialogAbort:null,
    focusClockActiveLock:()=>null,coreadArchiveDialogSlices:s=>s,readerLog:null,
    readerChatSync:{remove:async keys=>{account.push(['chat-remove',[...keys]]);return {registered:answer.registered,synced:answer.registered?keys.filter(key=>!answer.pending.includes(key)):[],pending:answer.registered?answer.pending.filter(key=>keys.includes(key)):[...keys]};},
      request:(...args)=>account.push(['chat-request',...args])},
    readerCoverSync:{remove:async ids=>{account.push(['cover-remove',[...ids]]);return {registered:true,synced:[...ids],pending:[]};}},
    blobStore:{deleteReaderBookData:async(id,options)=>{calls.push('delete-body');return {status:'committed',chatKeys:options.deleteMemory?[`chat::${id}`,`other::${id}`,`comic::${id}`]:[]};}},toast:(...args)=>notices.push(args),console:{warn:()=>{}},MODULE_NAME:'fixture'});
  c.coread=()=>c.settings.coread;
  const names=['coreadBookMeta','coreadCollections','coreadCaptureCollectionMutation','coreadReportAccountRemoval','coreadDeleteBook','coreadCanDeleteBooks','coreadRequestDeleteBooks'];
  vm.runInContext(names.map(section).join('\n'),c);
  return {c,data,page,calls,notices,account,answer,answerSave:value=>saveAnswer(value)};
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
    const f=requestFixture();let release;f.c.blobStore.deleteReaderBookData=()=>{f.calls.push('delete-body');return new Promise(r=>release=r);};
    const pending=f.c.coreadRequestDeleteBooks(['a','b']);f.confirm(true);await tick();f.memory(false);await tick();f.answerSave(true);await tick();
    assert.equal(f.data.books.length,2);if(change==='book')f.data.books[1].title='New consent required';else f.c.settings={enabled:true,coread:structuredClone(f.data)};
    release({status:'committed'});const result=await pending;assert.equal(result,change==='book');assert.equal(f.data.books.length,change==='book'?1:2);assert.equal(f.c.settings.coread.books.length,change==='book'?1:2);
    assert.equal(f.calls.filter(c=>c==='delete-body').length,1);assert.match(f.notices.at(-1)[0],change==='book'?/1\/2.*停止/:/书架已变化/);assert.equal(f.notices.at(-1)[1],'warning');
  }
});

test('cancel, unavailable targets and all busy writers cause zero deletion work',async()=>{
  const f=requestFixture(),pending=f.c.coreadRequestDeleteBooks(['a']);f.confirm(false);assert.equal(await pending,false);assert.deepEqual(f.calls,[]);assert.equal(f.prompts.length,1);
  for(const flag of ['coreadMemoryWrites','coreadIdentitySwitchBusy','coreadDistilling','coreadAutoTextInFlight','dialogBusy','readerAssistantBusy','coreadComicVisionBusy']){
    const b=requestFixture();b.c[flag]=true;assert.equal(await b.c.coreadRequestDeleteBooks(['a']),false,flag);assert.deepEqual(b.calls,[],flag);assert.equal(b.prompts.length,0,flag);
  }
  const missing=requestFixture();assert.equal(await missing.c.coreadRequestDeleteBooks(['a','missing']),false);assert.equal(missing.prompts.length,0);
});

test('rejected saves and interrupted cleanup fail visibly instead of continuing the batch',async()=>{
  const f=fixture();f.c.coreadSaveDialog=async()=>{throw Error('synthetic');};assert.equal(await f.c.coreadDeleteBook('a'),false);assert.equal(f.data.books.length,2);
  const g=requestFixture();g.c.blobStore.deleteReaderBookData=async()=>{throw Error('synthetic cleanup interruption');};
  const pending=g.c.coreadRequestDeleteBooks(['a','b']);g.confirm(true);await tick();g.memory(false);await tick();g.answerSave(true);
  assert.equal(await pending,false,'failed transaction keeps the original shelf unchanged');assert.equal(g.data.books.length,2);assert.equal(g.data.books[0].id,'a');
  assert.match(g.notices.at(-1)[0],/失败.*保留/);assert.equal(g.notices.at(-1)[1],'warning');
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

test('admitted deletion preserves other books and applies the memory choice to the local archive',async()=>{
  for(const deleteMemory of [false,true]){const f=fixture();let choice;
    f.c.blobStore.deleteReaderBookData=async(id,options)=>{f.calls.push('delete-body');choice=options.deleteMemory;return {status:'committed',chatKeys:options.deleteMemory?['chat::a','comic::a']:[]};};
    const pending=f.c.coreadDeleteBook('a',{deleteMemory});f.answerSave(true);
    assert.equal(await pending,true);assert.equal(f.data.books.length,1);assert.equal(f.data.books[0].id,'b');
    assert.equal(choice,deleteMemory);assert.deepEqual(f.calls,['save-dialog','delete-body','save-settings'],'no world-book write happens');
    assert.equal(f.data.retainedMemoryBooks.length,deleteMemory?0:1);
  }
});

test('cleanup keeps its writer guard until commit and detaches only the removed reader',async()=>{
  const f=fixture();f.c.readerView={bookId:'a'};f.c.readerContentCache={bookId:'a',fullText:'large body'};
  f.c.readerAssistant={bookId:'a'};f.c.readerAssistantToken=0;f.c.readerAssistantAbort=null;
  for(const name of ['focusClockCancelEntry','focusClockPauseForReadingExit','coreadClearPendingChatImages'])f.c[name]=()=>f.calls.push(name);
  f.c.readerAssistantSessions.set('char::a',{});f.c.readerAssistantSessions.set('char::b',{});
  let release;f.c.blobStore.deleteReaderBookData=()=>new Promise(r=>release=r);
  const pending=f.c.coreadDeleteBook('a');f.answerSave(true);await tick();
  assert.equal(f.c.coreadMemoryWrites,1);assert.equal(f.data.books.length,2);assert.ok(f.c.readerContentCache);
  assert.equal(await f.c.coreadDeleteBook('b'),false);
  release({status:'committed'});assert.equal(await pending,true);assert.equal(f.c.coreadMemoryWrites,0);
  assert.equal(f.c.readerView,null);assert.equal(f.c.readerContentCache,null);assert.equal(f.c.readerAssistant.bookId,'');
  assert.equal(f.c.readerAssistantSessions.has('char::a'),false);assert.equal(f.c.readerAssistantSessions.has('char::b'),true);
});
test('failed memory deletion keeps the shelf for retry and no longer mentions a world book',async()=>{
  const f=fixture();f.c.blobStore.deleteReaderBookData=async()=>{throw Error('local failure');};
  const pending=f.c.coreadDeleteBook('a',{deleteMemory:true});f.answerSave(true);
  assert.equal(await pending,false);assert.equal(f.data.books.length,2);assert.equal(f.c.coreadMemoryWrites,0);
  assert.match(f.notices.at(-1)[0],/本机清理失败.*保留/);assert.doesNotMatch(f.notices.at(-1)[0],/世界书/);
});

test('collection-only deletion preserves all books and uses the existing confirmation without a memory prompt',async()=>{
  const f=requestFixture(),books=JSON.stringify(f.data.books),pending=f.c.coreadRequestDeleteBooks([],['folder','folder']);
  assert.match(f.prompts[0][1],/确定删除合集「Folder」/);f.confirm(true);
  assert.equal(await pending,true);assert.equal(f.data.collections.length,0);assert.equal(JSON.stringify(f.data.books),books);
  assert.deepEqual(f.calls,['save-settings']);assert.equal(f.prompts.length,1);
});

test('collection deletion refuses canceled, missing or changed targets and stale owners without writes',async()=>{
  for(const change of ['cancel','owner','page','runtime','name','membership','removed']){
    const f=requestFixture(),pending=f.c.coreadRequestDeleteBooks([],['folder']);
    if(change==='owner')f.c.settings={enabled:true,coread:structuredClone(f.data)};
    if(change==='page')f.page.isConnected=false;
    if(change==='runtime')f.c.runtime={};
    if(change==='name')f.data.collections[0].name='Changed';
    if(change==='membership')f.data.collections[0].bookIds=['a'];
    if(change==='removed')f.data.collections=[];
    const before=JSON.stringify([f.data,f.c.settings]);f.confirm(change!=='cancel');
    assert.equal(await pending,false,change);assert.equal(JSON.stringify([f.data,f.c.settings]),before,change);assert.deepEqual(f.calls,[],change);
  }
  const missing=requestFixture();assert.equal(await missing.c.coreadRequestDeleteBooks([],['missing']),false);assert.equal(missing.prompts.length,0);
});

test('mixed consent deletes only explicitly selected books, tolerating its own membership update',async()=>{
  const f=requestFixture(),pending=f.c.coreadRequestDeleteBooks(['a'],['folder']);
  assert.match(f.prompts[0][1],/Alpha.*合集「Folder」/);f.confirm(true);await tick();f.memory(false);await tick();f.answerSave(true);
  assert.equal(await pending,true);assert.equal(f.data.collections.length,0);assert.deepEqual(Array.from(f.data.books,b=>b.id),['b']);
  assert.equal(f.calls.filter(c=>c==='delete-body').length,1);assert.equal(f.calls.filter(c=>c==='save-settings').length,2);
});

test('a changed collection during the memory choice cancels the entire mixed batch before cleanup',async()=>{
  const f=requestFixture(),pending=f.c.coreadRequestDeleteBooks(['a'],['folder']);f.confirm(true);await tick();
  f.data.collections[0].name='New name';const before=JSON.stringify(f.data);f.memory(false);
  assert.equal(await pending,false);assert.equal(JSON.stringify(f.data),before);assert.deepEqual(f.calls,[]);
});

test('deleting memory asks the account to drop exactly the archives the local transaction removed; keeping it uploads the rewritten ones',async()=>{
  const gone=fixture(),first=gone.c.coreadDeleteBook('a',{deleteMemory:true});gone.answerSave(true);assert.equal(await first,true);
  assert.deepEqual(gone.account,[['chat-remove',['chat::a','other::a','comic::a']],['cover-remove',['a']]]);
  assert.equal(gone.notices.some(notice=>/账户/.test(notice[0])),false,'a deletion that reached the account needs no extra notice');
  const kept=fixture(),second=kept.c.coreadDeleteBook('a',{deleteMemory:false});kept.answerSave(true);assert.equal(await second,true);
  assert.deepEqual(kept.account,[['chat-request'],['cover-remove',['a']]],'the cover goes with the book either way');
  const failed=fixture();failed.c.blobStore.deleteReaderBookData=async()=>{throw Error('local failure');};
  const third=failed.c.coreadDeleteBook('a',{deleteMemory:true});failed.answerSave(true);assert.equal(await third,false);
  assert.deepEqual(failed.account,[],'nothing is asked of the account when the local transaction did not commit');
});

test('an account copy that could not be deleted is reported as such, once per batch, never as deleted',async()=>{
  const offline=requestFixture();offline.answer.pending=['chat::a','chat::b'];
  const pending=offline.c.coreadRequestDeleteBooks(['a','b']);offline.confirm(true);await tick();offline.memory(true);await tick();offline.answerSave(true);
  assert.equal(await pending,true);assert.equal(offline.data.books.length,0);
  assert.deepEqual(offline.account.filter(call=>call[0]==='chat-remove').map(call=>call[1][0]),['chat::a','chat::b']);
  const warnings=offline.notices.filter(notice=>/账户/.test(notice[0]));
  assert.equal(warnings.length,1,'two books, one notice');assert.equal(warnings[0][1],'warning');
  assert.equal(warnings[0][0],'本机记忆已删除；账户里的副本暂时没删掉，联网后会自动补删');
  assert.equal(offline.notices.at(-1),warnings[0],'the honest notice is the last word');

  const unnoted=requestFixture();unnoted.answer.registered=false;
  const second=unnoted.c.coreadRequestDeleteBooks(['a']);unnoted.confirm(true);await tick();unnoted.memory(true);await tick();unnoted.answerSave(true);
  assert.equal(await second,true);
  assert.deepEqual(unnoted.notices.at(-1),['本机已删除，但没能登记账户端删除，其他设备上的副本不会被删','warning']);

  const alone=fixture();alone.answer.pending=['chat::a'];
  const third=alone.c.coreadDeleteBook('a',{deleteMemory:true});alone.answerSave(true);assert.equal(await third,true);
  assert.match(alone.notices.at(-1)[0],/暂时没删掉/,'a single deletion outside a batch reports for itself');
});
