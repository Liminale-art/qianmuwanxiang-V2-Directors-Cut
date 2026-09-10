import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {isPlainObject,uniqueClean,htmlEscape} from '../qianmu-storyboard-utils.js';
import {storyboardFunctionSource as section} from './helpers/storyboard-form-fixture.mjs';
const source=await readFile(new URL('../index.js',import.meta.url),'utf8');
const dictActions=source.slice(source.indexOf('    // 词典册：新建词册'),source.indexOf('    // 测试按钮：综合自检'));

function fixture(){
  const m={dictBooks:[{id:'dict',name:'Dictionary',pairs:{old:['alias']}}]},calls=[],notices=[];
  const page={isConnected:true,hidden:false},origin={isConnected:true,closest:()=>page};let resolve;
  const fields={'.sd-reader-de-canon':{value:'new'},'.sd-reader-de-aliases':{value:'one，two、new',addEventListener(){}},'.sd-reader-de-preview':{innerHTML:''}};
  const wrap={innerHTML:'',querySelector:s=>fields[s]};
  const host={POPUP_TYPE:{CONFIRM:1},Popup:class{show(){return new Promise(r=>resolve=r);}}};
  const c=vm.createContext({m,isPlainObject,uniqueClean,htmlEscape,ctx:()=>host,coreadMemory:()=>m,
    settings:{enabled:true,coread:{memory:m}},readerView:{bookId:'book'},coreadOpenRequestId:0,RUNTIME_LOCK_KEY:'runtimeFixture',runtimeFixture:{},chat:'A',
    getChatKey:()=>c.chat,document:{createElement:()=>wrap,querySelector:()=>page},toast:(...args)=>notices.push(args),saveSettings:()=>calls.push('save'),coreadInvalidatePool:()=>calls.push('invalidate')});
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
    assert.deepEqual(old.pairs,{old:['alias']});assert.deepEqual(f.calls,['save','invalidate']);assert.deepEqual(f.notices,[]);
  }
});

test('late entry confirmation after ownership or page changes cannot write, invalidate or announce success',async()=>{
  for(const change of ['chat','reader','navigation','disabled','settings','memory','runtime','stopped','hidden','detached','origin']){
    const f=fixture(),before=JSON.stringify(f.m),run=f.c.coreadOpenDictEntryDialog('dict','old',['alias'],f.origin);
    if(change==='chat')f.c.chat='B';if(change==='reader')f.c.readerView=null;if(change==='navigation')f.c.coreadOpenRequestId++;
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
  f.c.settings={enabled:true,coread:{memory:f.m}};assert.equal(guard.isCurrent(),false);assert.equal(guard.currentBook(),null);
});

function actionFixture(action){
  const f=fixture(),{c,m,origin,page,calls}=f;let resolve;
  const selectors={add:'dictbook-add',rename:'dictbook-rename',delete:'dictbook-delbtn',rowDelete:'dict-row-del',entryAdd:'dict-addentry',entryEdit:'dict-row-edit'};
  const row={dataset:{bookid:'dict',canon:'old'}};origin.dataset={id:'dict'};origin.closest=s=>s==='.sd-reader-dict-row'?row:page;
  const stores={A:{coreadDictBound:['dict']},B:{coreadDictBound:['dict','other']}};
  Object.assign(c,{uid:()=> 'new-dict',COREAD_DEFAULT_DICT:'default',coreadCurrentDictId:'dict',
    coreadPromptText:()=>new Promise(r=>resolve=r),confirmDialog:()=>new Promise(r=>resolve=r),coreadOpenDictEntryDialog:()=>new Promise(r=>resolve=r),
    getChatStore:()=>stores[c.chat],coreadBoundDicts:()=>stores[c.chat].coreadDictBound,
    saveMetadata:()=>calls.push('metadata:'+c.chat),rerenderMore:()=>calls.push('render:'+c.chat),
    e:{target:{closest:s=>s==='.sd-reader-'+selectors[action]?origin:null}}});
  const dispatch=()=>vm.runInContext('(function(){const m=coreadMemory();'+dictActions+'})()',c);
  return {...f,stores,dispatch,finish:async()=>{resolve?.(['add','rename'].includes(action)?' New name ':true);await new Promise(r=>setImmediate(r));}};
}

test('late dictionary actions cannot mutate either chat or issue success on another page',async()=>{
  for(const action of ['add','rename','delete','rowDelete','entryAdd','entryEdit'])for(const change of ['chat','origin','reader','runtime','memory','hidden']){
    const f=actionFixture(action),before=JSON.stringify([f.m,f.stores]);f.dispatch();
    if(change==='chat')f.c.chat='B';if(change==='origin')f.origin.isConnected=false;if(change==='reader')f.c.readerView=null;
    if(change==='runtime')f.c.runtimeFixture={};if(change==='memory')f.c.settings.coread.memory={};if(change==='hidden')f.page.hidden=true;
    await f.finish();assert.equal(JSON.stringify([f.m,f.stores]),before,action+':'+change);assert.deepEqual(f.calls,[],action+':'+change);assert.deepEqual(f.notices,[],action+':'+change);
  }
});

test('normal dictionary actions write current normalized data and only the owning chat binding',async()=>{
  for(const action of ['add','rename','delete','rowDelete']){
    const f=actionFixture(action),old=f.m.dictBooks[0];f.dispatch();f.m.dictBooks=f.m.dictBooks.map(d=>({...d,pairs:f.c.coreadNormalizeSynonyms(d.pairs)}));await f.finish();
    if(action==='add')assert.equal(f.m.dictBooks[1].name,'New name');
    if(action==='rename'){assert.equal(f.m.dictBooks[0].name,'New name');assert.equal(old.name,'Dictionary');}
    if(action==='delete'){assert.equal(f.m.dictBooks.length,0);assert.deepEqual(Array.from(f.stores.A.coreadDictBound),[]);assert.equal(f.c.coreadCurrentDictId,'');}
    if(action==='rowDelete')assert.equal(JSON.stringify(f.m.dictBooks[0].pairs),'{}');
    assert.deepEqual(f.stores.B.coreadDictBound,['dict','other']);assert.equal(f.calls.filter(x=>x==='save').length,1);assert.equal(f.calls.filter(x=>x==='render:A').length,1);
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
