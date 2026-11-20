import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {isPlainObject,uniqueClean,htmlEscape} from '../qianmu-storyboard-utils.js';
import {storyboardFunctionSource as section} from './helpers/storyboard-form-fixture.mjs';
const source=await readFile(new URL('../index.js',import.meta.url),'utf8');
const dictActions=source.slice(source.indexOf('    // 词典册：新建词册'),source.indexOf("  });\n  morePage?.addEventListener('change', (e) => {\n    const packInput"));

function fixture(){
  const m={dictBooks:[{id:'dict',name:'Dictionary',pairs:{old:['alias']}}]},calls=[],notices=[];
  const page={isConnected:true,hidden:false},origin={isConnected:true,closest:()=>page};let resolve;
  const fields={'.sd-reader-de-canon':{value:'new'},'.sd-reader-de-aliases':{value:'one，two、new',addEventListener(){}},'.sd-reader-de-preview':{innerHTML:''}};
  const wrap={innerHTML:'',querySelector:s=>fields[s]};
  const host={POPUP_TYPE:{CONFIRM:1},Popup:class{show(){return new Promise(r=>resolve=r);}}};
  const c=vm.createContext({m,isPlainObject,uniqueClean,htmlEscape,ctx:()=>host,coreadMemory:()=>m,
    settings:{enabled:true,coread:{memory:m}},readerView:{bookId:'book'},coreadOpenRequestId:0,RUNTIME_LOCK_KEY:'runtimeFixture',runtimeFixture:{},chat:'A',
    // Two archives of the same book under one ST chat: the dictionary scope is the archive, never the chat.
    archives:{A:{bucket:'friend-a::book',bookId:'book',loaded:true,dictBound:['dict']},B:{bucket:'friend-b::book',bookId:'book',loaded:true,dictBound:['dict','other']}},
    getChatKey:()=>c.chat,document:{createElement:()=>wrap,querySelector:()=>page},toast:(...args)=>notices.push(args),saveSettings:()=>calls.push('save')});
  c.readerDialog=c.archives.A;
  vm.runInContext(['coreadNormalizeSynonyms','coreadCaptureDictMutation','coreadOpenDictEntryDialog'].map(section).join('\n'),c);
  return {c,m,calls,notices,page,origin,fields,answer:value=>resolve(value)};
}

test('current dictionary edit accepts host confirmations and writes the current normalized object exactly once',async()=>{
  for(const answer of [true,1,'1']){
    const f=fixture(),old=f.m.dictBooks[0],run=f.c.coreadOpenDictEntryDialog('dict','old',['alias'],f.origin);
    // Mirrors coreadMemory rebuilding equivalent dictionary objects while the popup waits.
    f.m.dictBooks=f.m.dictBooks.map(d=>({...d,pairs:f.c.coreadNormalizeSynonyms(d.pairs)}));
    f.answer(answer);assert.equal(JSON.stringify(await run),JSON.stringify({canon:'new',aliases:['one','two','new']}));
    assert.equal(JSON.stringify(f.m.dictBooks[0].pairs),JSON.stringify({new:['one','two']}));
    assert.deepEqual(old.pairs,{old:['alias']});assert.deepEqual(f.calls,['save']);assert.deepEqual(f.notices,[]);
  }
});

test('late entry confirmation after ownership or page changes cannot write or announce success',async()=>{
  for(const change of ['archive','reader','navigation','disabled','settings','memory','runtime','stopped','hidden','detached','origin']){
    const f=fixture(),before=JSON.stringify(f.m),run=f.c.coreadOpenDictEntryDialog('dict','old',['alias'],f.origin);
    if(change==='archive')f.c.readerDialog=f.c.archives.B;if(change==='reader')f.c.readerView=null;if(change==='navigation')f.c.coreadOpenRequestId++;
    if(change==='disabled')f.c.settings.enabled=false;if(change==='settings')f.c.settings={enabled:true,coread:{memory:f.m}};
    if(change==='memory')f.c.settings.coread.memory={};if(change==='runtime')f.c.runtimeFixture={};if(change==='stopped')delete f.c.runtimeFixture;
    if(change==='hidden')f.page.hidden=true;if(change==='detached')f.page.isConnected=false;if(change==='origin')f.origin.isConnected=false;
    f.answer(true);assert.equal(await run,null,change);assert.equal(JSON.stringify(f.m),before,change);assert.deepEqual(f.calls,[],change);assert.deepEqual(f.notices,[],change);
  }
});

test('changed or removed dictionary rejects stale content instead of overwriting another edit',async()=>{
  for(const change of ['deleted','renamed','pairs']){
    const f=fixture(),run=f.c.coreadOpenDictEntryDialog('dict','old',['alias'],f.origin);
    if(change==='deleted')f.m.dictBooks=[];if(change==='renamed')f.m.dictBooks[0].name='Other';if(change==='pairs')f.m.dictBooks[0].pairs.old=['newer'];
    const before=JSON.stringify(f.m);f.answer(true);assert.equal(await run,null);assert.equal(JSON.stringify(f.m),before);assert.deepEqual(f.calls,[]);assert.equal(f.notices[0][1],'warning');
  }
});

test('cancel and empty canonical value preserve the existing dictionary',async()=>{
  for(const answer of [false,0,'',null]){const f=fixture(),before=JSON.stringify(f.m),run=f.c.coreadOpenDictEntryDialog('dict','old',['alias'],f.origin);f.answer(answer);assert.equal(await run,null);assert.equal(JSON.stringify(f.m),before);assert.deepEqual(f.calls,[]);}
  const f=fixture();f.fields['.sd-reader-de-canon'].value=' ';const run=f.c.coreadOpenDictEntryDialog('dict','old',['alias'],f.origin);f.answer(true);assert.equal(await run,null);assert.deepEqual(f.calls,[]);assert.equal(f.notices[0][1],'warning');
});

test('scope checks are read-only and must not normalize a new settings owner',()=>{
  const f=fixture(),guard=f.c.coreadCaptureDictMutation(f.m,'dict',f.origin);
  f.c.coreadMemory=()=>{throw Error('scope check must not normalize settings');};
  assert.equal(guard.isCurrent(),true);assert.equal(guard.currentBook(),f.m.dictBooks[0]);
  f.c.chat='B';assert.equal(guard.isCurrent(),true,'switching the ST chat does not end an edit made for a reading archive');
  f.c.settings={enabled:true,coread:{memory:f.m}};assert.equal(guard.isCurrent(),false);assert.equal(guard.currentBook(),null);
});

function actionFixture(action){
  const f=fixture(),{c,m,origin,page,calls}=f;let resolve;
  const selectors={add:'dictbook-add',rename:'dictbook-rename',delete:'dictbook-delbtn',rowDelete:'dict-row-del',entryAdd:'dict-addentry',entryEdit:'dict-row-edit',bind:'dictbook-bind'};
  const row={dataset:{bookid:'dict',canon:'old'}};origin.dataset={id:'dict'};origin.closest=s=>s==='.sd-reader-dict-row'?row:page;
  // What the archive store holds; saving writes the open archive's binding there, or fails when told to.
  const stores={},saved=[];f.saveFails=false;
  for(const archive of Object.values(c.archives))stores[archive.bucket]={dictBound:[...archive.dictBound]};
  Object.assign(c,{uid:()=> 'new-dict',COREAD_DEFAULT_DICT:'default',coreadCurrentDictId:'dict',coreadDistilling:false,coreadMemoryWrites:0,COREAD_MEMORY_BUSY:'正在整理记忆，请稍候',
    coreadSaveDialog:async()=>{
      if(!c.readerDialog.bucket||!c.readerDialog.loaded||f.saveFails)return false;
      stores[c.readerDialog.bucket]={...(Array.isArray(c.readerDialog.dictBound)?{dictBound:[...c.readerDialog.dictBound]}:{})};saved.push(c.readerDialog.bucket);return true;
    },
    rerenderMoreIfOpen:()=>calls.push('render:'+c.chat),
    coreadPromptText:()=>new Promise(r=>resolve=r),confirmDialog:()=>new Promise(r=>resolve=r),coreadOpenDictEntryDialog:()=>new Promise(r=>resolve=r),
    getChatStore:()=>{throw Error('dictionary binding must not touch chat metadata');},
    saveMetadata:()=>{throw Error('dictionary binding must not save chat metadata');},rerenderMore:()=>calls.push('render:'+c.chat),
    e:{target:{closest:s=>s==='.sd-reader-'+selectors[action]?origin:null}}});
  vm.runInContext(['coreadBoundDicts','coreadSetBoundDicts'].map(section).join('\n'),c);
  const dispatch=()=>vm.runInContext('(function(){const m=coreadMemory();'+dictActions+'})()',c);
  return Object.assign(f,{stores,saved,dispatch,finish:async()=>{resolve?.(['add','rename'].includes(action)?' New name ':true);await new Promise(r=>setImmediate(r));await new Promise(r=>setImmediate(r));}});
}

test('late dictionary actions cannot mutate either archive or issue success on another page',async()=>{
  for(const action of ['add','rename','delete','rowDelete','entryAdd','entryEdit'])for(const change of ['archive','origin','reader','runtime','memory','hidden']){
    const f=actionFixture(action),before=JSON.stringify([f.m,f.stores]);f.dispatch();
    if(change==='archive')f.c.readerDialog=f.c.archives.B;if(change==='origin')f.origin.isConnected=false;if(change==='reader')f.c.readerView=null;
    if(change==='runtime')f.c.runtimeFixture={};if(change==='memory')f.c.settings.coread.memory={};if(change==='hidden')f.page.hidden=true;
    await f.finish();assert.equal(JSON.stringify([f.m,f.stores]),before,action+':'+change);assert.deepEqual(f.calls,[],action+':'+change);assert.deepEqual(f.notices,[],action+':'+change);
  }
});

test('normal dictionary actions write current normalized data and only the open archive binding',async()=>{
  for(const action of ['add','rename','delete','rowDelete']){
    const f=actionFixture(action),old=f.m.dictBooks[0];f.dispatch();f.m.dictBooks=f.m.dictBooks.map(d=>({...d,pairs:f.c.coreadNormalizeSynonyms(d.pairs)}));await f.finish();
    if(action==='add')assert.equal(f.m.dictBooks[1].name,'New name');
    if(action==='rename'){assert.equal(f.m.dictBooks[0].name,'New name');assert.equal(old.name,'Dictionary');}
    if(action==='delete'){assert.equal(f.m.dictBooks.length,0);assert.deepEqual(f.stores['friend-a::book'].dictBound,[]);assert.deepEqual(f.saved,['friend-a::book']);assert.equal(f.c.coreadCurrentDictId,'');}
    else assert.deepEqual(f.saved,[],'only deleting a bound dictionary rewrites the archive');
    if(action==='rowDelete')assert.equal(JSON.stringify(f.m.dictBooks[0].pairs),'{}');
    assert.deepEqual(f.stores['friend-b::book'].dictBound,['dict','other']);assert.deepEqual(f.c.archives.B.dictBound,['dict','other']);assert.equal(f.calls.filter(x=>x==='save').length,1);assert.equal(f.calls.filter(x=>x==='render:A').length,1);
  }
});

test('changed dictionary cannot be renamed or deleted by stale consent, and default book deletion is rejected in handler',async()=>{
  for(const action of ['rename','delete','rowDelete']){
    const f=actionFixture(action);f.dispatch();f.m.dictBooks[0].pairs.old=['newer'];const before=JSON.stringify([f.m,f.stores]);await f.finish();
    assert.equal(JSON.stringify([f.m,f.stores]),before);assert.deepEqual(f.calls,[]);assert.equal(f.notices[0][1],'warning');
  }
  const f=actionFixture('delete');f.origin.dataset.id='default';f.m.dictBooks[0].id='default';f.dispatch();await f.finish();
  assert.equal(f.m.dictBooks.length,1);assert.deepEqual(f.calls,[]);
});

test('deleting a dictionary the archive uses stops, with the dictionary kept, when the archive cannot be saved',async()=>{
  const f=actionFixture('delete');f.saveFails=true;f.dispatch();await f.finish();
  assert.equal(f.m.dictBooks.length,1,'the dictionary is not deleted');assert.deepEqual(Array.from(f.c.readerDialog.dictBound),['dict'],'the binding in memory is put back');
  assert.deepEqual(f.stores['friend-a::book'].dictBound,['dict']);assert.deepEqual(f.calls,[]);assert.deepEqual(f.notices,[['绑定未能保存，请重试','warning']]);
  const busy=actionFixture('delete');busy.c.coreadDistilling=true;busy.dispatch();await busy.finish();
  assert.equal(busy.m.dictBooks.length,1);assert.deepEqual(busy.saved,[]);assert.match(busy.notices[0][0],/正在整理记忆/);
  // A dictionary this archive does not use is deleted without touching the archive.
  const other=actionFixture('delete');other.c.readerDialog.dictBound=['elsewhere'];other.saveFails=true;other.dispatch();await other.finish();
  assert.equal(other.m.dictBooks.length,0);assert.deepEqual(other.saved,[]);
});

test('binding is kept per reading archive: it is saved with the archive, and two archives under one ST chat do not affect each other',async()=>{
  const f=actionFixture('bind');f.m.dictBooks.push({id:'other',name:'Other',pairs:{}});
  f.dispatch();await f.finish();                                              // archive A used `dict`: now released
  assert.deepEqual(Array.from(f.c.archives.A.dictBound),[]);assert.deepEqual(f.stores['friend-a::book'].dictBound,[]);
  assert.deepEqual(f.notices.at(-1),['已解除','success']);
  assert.deepEqual(f.c.archives.B.dictBound,['dict','other']);assert.deepEqual(f.stores['friend-b::book'].dictBound,['dict','other'],'the other archive of the same chat is untouched');
  f.c.coreadCurrentDictId='other';f.dispatch();await f.finish();
  assert.deepEqual(Array.from(f.c.archives.A.dictBound),['other']);assert.deepEqual(f.stores['friend-a::book'].dictBound,['other']);
  assert.deepEqual(f.notices.at(-1),['已用于这本书的伴读','success']);
  assert.deepEqual(f.saved,['friend-a::book','friend-a::book']);

  // Switching the ST chat changes nothing; opening the other archive shows its own list.
  f.c.chat='B';assert.deepEqual(Array.from(f.c.coreadBoundDicts()),['other']);
  f.c.readerDialog=f.c.archives.B;assert.deepEqual(Array.from(f.c.coreadBoundDicts()),['dict','other']);
});

test('an archive that never chose uses the default dictionary only; an emptied list stays empty; a failed save is undone and reported',async()=>{
  const f=actionFixture('bind');f.c.readerDialog={bucket:'old::book',bookId:'book',loaded:true};            // a record from before the field existed
  assert.deepEqual(Array.from(f.c.coreadBoundDicts()),['default']);
  f.saveFails=true;f.dispatch();await f.finish();
  assert.equal(Object.hasOwn(f.c.readerDialog,'dictBound'),false,'a failed first choice leaves the archive unset');
  assert.deepEqual(f.notices.at(-1),['绑定未能保存，请重试','warning']);assert.equal(f.stores['old::book'],undefined);
  f.saveFails=false;f.dispatch();await f.finish();
  assert.deepEqual(Array.from(f.c.readerDialog.dictBound),['default','dict'],'the first choice starts from the default');
  assert.deepEqual(f.stores['old::book'].dictBound,['default','dict']);

  const set=actionFixture('bind');set.saveFails=true;set.dispatch();await set.finish();
  assert.deepEqual(Array.from(set.c.readerDialog.dictBound),['dict'],'a failed release is put back');assert.deepEqual(set.stores['friend-a::book'].dictBound,['dict']);
  assert.equal(set.notices.at(-1)[1],'warning');assert.equal(set.notices.some(n=>n[1]==='success'),false);
  set.saveFails=false;set.dispatch();await set.finish();
  assert.deepEqual(Array.from(set.c.coreadBoundDicts()),[],'released on purpose: not even the default comes back');

  for(const state of ['unloaded','distilling','writing']){
    const b=actionFixture('bind');if(state==='unloaded')b.c.readerDialog={bucket:'',bookId:'',loaded:false};
    if(state==='distilling')b.c.coreadDistilling=true;if(state==='writing')b.c.coreadMemoryWrites=1;
    b.dispatch();await b.finish();assert.deepEqual(b.saved,[],state);assert.equal(b.notices.length,1,state);assert.equal(b.notices[0][1],'info',state);
  }
  assert.doesNotMatch(source.slice(source.indexOf('function coreadBoundDicts'),source.indexOf('async function coreadPromptText')),/getChatStore|coreadDictBound|saveMetadata/,'old chat metadata is neither read nor written');
});
