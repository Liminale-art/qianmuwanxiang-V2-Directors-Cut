import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {htmlEscape} from '../qianmu-storyboard-utils.js';
import {storyboardFunctionSource as section} from './helpers/storyboard-form-fixture.mjs';

function fixture(mode='popup') {
  const data={books:[{id:'book',title:'Old',author:'Writer',progress:45,notes:['keep']}],collections:[{id:'folder',name:'Folder',bookIds:[],createdAt:1,updatedAt:1}]};
  const page={isConnected:true,hidden:false},modal={classList:{contains:()=>true},querySelector:()=>page};
  const fields={title:{value:' New '},author:{value:' Author '},collection:{value:'folder'}};
  let answer,finish,guard;const writes=[],notices=[],saves=[];
  const c=vm.createContext({settings:{enabled:true,coread:data},MODAL_ID:'modal',RUNTIME_LOCK_KEY:'runtime',runtime:{},coreadOpenRequestId:0,
    htmlEscape,MODULE_NAME:'fixture',console:{warn:()=>{}},toast:(...args)=>notices.push(args),saveSettings:()=>saves.push('save'),
    document:{getElementById:()=>modal,createElement:()=>({querySelector:s=>fields[s.split('-').at(-1)]})},
    ctx:()=>mode==='popup'?{POPUP_TYPE:{CONFIRM:1},Popup:class{show(){return new Promise(r=>answer=r);}}}:{},
    promptInput:()=>new Promise(r=>answer=r),
    blobStore:{updateBookMetadata:(id,patch,options)=>{writes.push({id,patch});guard=options.isCurrent;return new Promise((resolve,reject)=>finish={resolve,reject});}}
  });
  c.coread=()=>c.settings.coread;
  vm.runInContext(['coreadBookMeta','coreadCollections','coreadCollectionForBook','coreadMoveBooksToCollection','coreadCaptureCollectionMutation','coreadEditBookInfo'].map(section).join('\n'),c);
  return {c,data,page,fields,writes,notices,saves,answer:v=>answer(v),get finish(){return finish;},get guard(){return guard;}};
}
const tick=async()=>{await Promise.resolve();await Promise.resolve();};
async function submit(f,mode='popup') {const pending=f.c.coreadEditBookInfo('book');f.answer(mode==='popup'?true:'New');await tick();if(mode!=='popup'){f.answer('Author');await tick();}return {pending};}

test('book editor commits current shelf metadata only after body metadata is settled',async()=>{
  const f=fixture(),{pending}=await submit(f);
  assert.equal(f.writes.length,1);assert.equal(f.data.books[0].title,'Old');assert.equal(f.saves.length,0);
  f.data.books=[{...f.data.books[0],progress:77,notes:['new note']}];f.finish.resolve({status:'updated'});
  assert.equal(await pending,true);assert.equal(f.data.books[0].title,'New');assert.equal(f.data.books[0].author,'Author');
  assert.equal(f.data.books[0].progress,77);assert.deepEqual(f.data.books[0].notes,['new note']);assert.deepEqual(Array.from(f.data.collections[0].bookIds),['book']);
  assert.equal(f.saves.length,1);assert.equal(f.notices.at(-1)[1],'success');
});

test('missing local body permits shelf-only edits without claiming the body was saved',async()=>{
  const f=fixture('fallback'),{pending}=await submit(f,'fallback');f.finish.resolve({status:'missing'});
  assert.equal(await pending,true);assert.equal(f.data.books[0].title,'New');assert.equal(f.saves.length,1);
  assert.match(f.notices.at(-1)[0],/仅更新书架信息/);assert.equal(f.notices.at(-1)[1],'info');
});

const changes={owner:f=>{f.c.settings={enabled:true,coread:structuredClone(f.data)};},page:f=>{f.page.isConnected=false;},hidden:f=>{f.page.hidden=true;},runtime:f=>{f.c.runtime={};},open:f=>{f.c.coreadOpenRequestId++;},removed:f=>{f.data.books=[];},edited:f=>{f.data.books[0].title='Concurrent';},moved:f=>{f.data.collections[0].bookIds=['book'];},target:f=>{f.data.collections=[];}};
test('delayed popup cannot write into changed owners, books, pages or missing target collections',async()=>{
  for(const [label,change]of Object.entries(changes)){
    const f=fixture(),pending=f.c.coreadEditBookInfo('book');change(f);const before=JSON.stringify([f.data,f.c.settings]);
    f.answer(true);assert.equal(await pending,false,label);assert.equal(JSON.stringify([f.data,f.c.settings]),before,label);assert.equal(f.writes.length,0,label);assert.equal(f.saves.length,0,label);
  }
});

test('stale fallback exits after title prompt instead of opening the next dialog',async()=>{
  const f=fixture('fallback'),pending=f.c.coreadEditBookInfo('book');f.page.isConnected=false;f.answer('New');
  assert.equal(await pending,false);assert.equal(f.writes.length,0);
});

test('storage wait checks its original ownership again and never overwrites a replacement shelf',async()=>{
  for(const [label,change]of Object.entries(changes)){
    const f=fixture(),{pending}=await submit(f);assert.equal(typeof f.guard,'function');change(f);const before=JSON.stringify([f.data,f.c.settings]);
    assert.equal(f.guard(),false,label);f.finish.resolve({status:'stale'});assert.equal(await pending,false,label);
    assert.equal(JSON.stringify([f.data,f.c.settings]),before,label);assert.equal(f.saves.length,0,label);assert.ok(f.notices.every(n=>n[1]!=='success'),label);
  }
});

test('a committed body with an expired page is reported honestly without reverting newer data',async()=>{
  const f=fixture(),{pending}=await submit(f);changes.owner(f);f.finish.resolve({status:'updated'});
  assert.equal(await pending,false);assert.equal(f.saves.length,0);assert.equal(f.data.books[0].title,'Old');
  assert.match(f.notices.at(-1)[0],/正文信息已保存.*书架/);assert.equal(f.notices.at(-1)[1],'warning');
});

test('body write failure or unknown result does not modify shelf metadata or report success',async()=>{
  for(const kind of ['reject','unknown']){const f=fixture(),{pending}=await submit(f);
    if(kind==='reject')f.finish.reject(Error('disk unavailable'));else f.finish.resolve({status:'unexpected'});
    assert.equal(await pending,false);assert.equal(f.data.books[0].title,'Old');assert.equal(f.saves.length,0);assert.equal(f.notices.at(-1)[1],'error');}
});

test('cancel and empty title do not start a storage update',async()=>{
  for(const cancel of [true,false]){const f=fixture(),pending=f.c.coreadEditBookInfo('book');f.fields.title.value='  ';f.answer(!cancel);
    assert.equal(await pending,false);assert.equal(f.writes.length,0);assert.equal(f.saves.length,0);}
});

test('settings scheduling failure reports partial completion, not an all-saved success',async()=>{
  const f=fixture(),{pending}=await submit(f);f.c.saveSettings=()=>{throw Error('host unavailable');};f.finish.resolve({status:'updated'});
  assert.equal(await pending,false);assert.equal(f.notices.at(-1)[1],'warning');assert.match(f.notices.at(-1)[0],/书架.*保存/);
});
