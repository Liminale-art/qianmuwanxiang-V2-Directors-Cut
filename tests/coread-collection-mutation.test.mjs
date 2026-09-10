import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {htmlEscape} from '../qianmu-storyboard-utils.js';
import {storyboardFunctionSource as section} from './helpers/storyboard-form-fixture.mjs';

function fixture() {
  const data={books:[{id:'book'}],collections:[{id:'folder',name:'Old',bookIds:['book'],createdAt:1,updatedAt:1}],libCollectionId:'folder'};
  const page={isConnected:true,hidden:false},modal={open:true,querySelector:()=>page};
  modal.classList={contains:()=>modal.open};let resolve;
  const calls=[],notices=[],c=vm.createContext({settings:{enabled:true,coread:data},MODAL_ID:'modal',
    RUNTIME_LOCK_KEY:'runtimeFixture',runtimeFixture:{},coreadOpenRequestId:0,
    document:{getElementById:()=>modal},promptInput:()=>new Promise(r=>resolve=r),confirmDialog:()=>new Promise(r=>resolve=r),
    uid:()=> 'new-folder',saveSettings:()=>calls.push('save'),toast:(...args)=>notices.push(args)});
  c.coread=()=>c.settings.coread;
  const names=['coreadCaptureCollectionMutation','coreadBookMeta','coreadCollections','coreadMoveBooksToCollection','coreadCreateCollection','coreadRenameCollection','coreadDissolveCollection','coreadChooseCollectionForBooks'];
  vm.runInContext(names.map(section).join('\n'),c);
  return {c,data,page,modal,calls,notices,answer:value=>resolve(value)};
}
const start=(f,action)=>f.c['coread'+action+'Collection'](action==='Create'?'':'folder');

test('rename writes the current collection even when normalization rebuilt its object',async()=>{
  const f=fixture(),pending=start(f,'Rename'),old=f.data.collections[0];
  f.c.coreadCollections();f.answer(' New name ');
  assert.equal(await pending,true);assert.equal(f.data.collections[0].name,'New name');
  assert.equal(old.name,'Old');assert.deepEqual(f.calls,['save']);assert.equal(f.data.collections[0].bookIds[0],'book');
});

function choiceFixture(mode='popup') {
  const f=fixture(),field={value:'target'};let resolve;
  f.data.collections.push({id:'target',name:'Target',bookIds:[],createdAt:2,updatedAt:2});
  f.c.htmlEscape=htmlEscape;
  f.c.document.createElement=()=>({innerHTML:'',querySelector:()=>field});
  f.c.ctx=()=>mode==='popup'?{POPUP_TYPE:{CONFIRM:1},Popup:class{show(){return new Promise(r=>resolve=r);}}}:{};
  return {...f,field,choose:value=>resolve(value)};
}

test('a vanished explicit collection never means move out, including direct move callers',async()=>{
  const f=choiceFixture(),pending=f.c.coreadChooseCollectionForBooks(['book']);
  f.data.collections=f.data.collections.filter(x=>x.id!=='target');const before=JSON.stringify(f.data);
  f.choose(true);assert.equal(await pending,false);assert.equal(JSON.stringify(f.data),before);assert.deepEqual(f.calls,[]);
  assert.equal(f.notices.length,1);assert.equal(f.notices[0][1],'warning');
  assert.equal(f.c.coreadMoveBooksToCollection(['book'],'missing'),null);
  assert.equal(JSON.stringify(f.data),before);assert.deepEqual(f.calls,[]);
});

test('current popup choices move to the selected target or explicitly to unclassified',async()=>{
  for(const target of ['target',''])for(const answer of [true,1,'1']){
    const f=choiceFixture();f.field.value=target;const pending=f.c.coreadChooseCollectionForBooks(['book','book']);f.choose(answer);
    assert.equal(await pending,true);assert.equal(f.data.collections[0].bookIds.length,0);
    assert.equal(f.data.collections[1].bookIds.length,target?1:0);assert.deepEqual(f.calls,['save']);assert.equal(f.notices[0][1],'success');
  }
});

test('delayed choices reject changed owners, pages and selected book membership without writing',async()=>{
  for(const mode of ['popup','fallback'])for(const change of ['settings','page','removed','moved']){
    const f=choiceFixture(mode),pending=f.c.coreadChooseCollectionForBooks(['book']);
    if(change==='settings')f.c.settings={enabled:true,coread:f.data};if(change==='page')f.page.isConnected=false;
    if(change==='removed')f.data.books=[];
    if(change==='moved'){f.data.collections[0].bookIds=[];f.data.collections[1].bookIds=['book'];}
    const before=JSON.stringify(f.data);if(mode==='popup')f.choose(true);else f.answer('Target');
    assert.equal(await pending,false,mode+':'+change);assert.equal(JSON.stringify(f.data),before);assert.deepEqual(f.calls,[]);
  }
});

test('nested create retains the original book selection guard through every prompt',async()=>{
  for(const mode of ['popup','fallback','empty'])for(const change of ['none','settings','page','removed','moved']){
    const f=choiceFixture(mode);if(mode==='empty')f.data.collections=[];
    f.field.value='__new__';const pending=f.c.coreadChooseCollectionForBooks(['book']);
    if(mode==='popup')f.choose(true);if(mode==='fallback')f.answer('Fresh');
    await new Promise(r=>setImmediate(r));
    if(change==='settings')f.c.settings={enabled:true,coread:f.data};if(change==='page')f.page.isConnected=false;
    if(change==='removed')f.data.books=[];
    if(change==='moved'){f.data.collections=[{id:'other',name:'Other',bookIds:['book'],createdAt:3,updatedAt:3}];}
    const before=JSON.stringify(f.data);f.answer('Fresh');const result=await pending;
    if(change==='none'){assert.equal(result,true,mode);assert.equal(f.data.collections.at(-1).name,'Fresh');assert.equal(f.data.collections.at(-1).bookIds[0],'book');assert.deepEqual(f.calls,['save','save']);}
    else{assert.equal(result,false,mode+':'+change);assert.equal(JSON.stringify(f.data),before);assert.deepEqual(f.calls,[]);}
  }
});

test('late collection consent cannot write into replaced settings or another page',async()=>{
  for(const action of ['Create','Rename','Dissolve'])for(const change of ['settings','coread','disabled','runtime','stopped','navigation','detached','hidden','closed']){
    const f=fixture(),pending=start(f,action);
    if(change==='settings')f.c.settings={enabled:true,coread:f.data};
    if(change==='coread')f.c.settings.coread={books:[],collections:[],libCollectionId:''};
    if(change==='disabled')f.c.settings.enabled=false;
    if(change==='runtime')f.c.runtimeFixture={};if(change==='stopped')delete f.c.runtimeFixture;
    if(change==='navigation')f.c.coreadOpenRequestId++;
    if(change==='detached')f.page.isConnected=false;if(change==='hidden')f.page.hidden=true;if(change==='closed')f.modal.open=false;
    const before=JSON.stringify([f.data,f.c.settings.coread]);f.answer(action==='Dissolve'?true:'Changed');
    assert.equal(await pending,action==='Create'?null:false,action+':'+change);
    assert.equal(JSON.stringify([f.data,f.c.settings.coread]),before,action+':'+change);
    assert.deepEqual(f.calls,[],action+':'+change);assert.deepEqual(f.notices,[],action+':'+change);
  }
});

test('changed collection must not be renamed or dissolved using outdated consent',async()=>{
  for(const action of ['Rename','Dissolve'])for(const change of ['removed','renamed','members','revision']){
    const f=fixture(),pending=start(f,action);
    if(change==='removed')f.data.collections=[];if(change==='renamed')f.data.collections[0].name='Concurrent';
    if(change==='members')f.data.collections[0].bookIds=[];if(change==='revision')f.data.collections[0].updatedAt++;
    const before=JSON.stringify(f.data);f.answer(action==='Dissolve'?true:'Changed');
    assert.equal(await pending,false,action+':'+change);assert.equal(JSON.stringify(f.data),before);assert.deepEqual(f.calls,[]);
    assert.equal(f.notices.length,1);assert.equal(f.notices[0][1],'warning');
  }
});

test('current create and dissolve save once while preserving book data',async()=>{
  const f=fixture(),books=JSON.stringify(f.data.books),pending=start(f,'Create');f.answer(' New folder ');
  assert.equal((await pending).name,'New folder');assert.equal(f.data.collections.length,2);assert.deepEqual(f.calls,['save']);
  const removed=start(f,'Dissolve');f.c.coreadCollections();f.answer(true);
  assert.equal(await removed,true);assert.equal(f.data.libCollectionId,'');assert.equal(f.data.collections.length,1);
  assert.equal(JSON.stringify(f.data.books),books);assert.deepEqual(f.calls,['save','save']);
});

test('cancel, blank names and duplicate names preserve collections without saving',async()=>{
  for(const action of ['Create','Rename'])for(const answer of [null,'  ','NEW']){
    const f=fixture();f.data.collections.push({id:'other',name:'New',bookIds:[],createdAt:2,updatedAt:2});
    const pending=start(f,action),before=JSON.stringify(f.data);f.answer(answer);
    assert.equal(await pending,action==='Create'?null:false);assert.equal(JSON.stringify(f.data),before);assert.deepEqual(f.calls,[]);
  }
  const f=fixture(),pending=start(f,'Dissolve'),before=JSON.stringify(f.data);f.answer(false);
  assert.equal(await pending,false);assert.equal(JSON.stringify(f.data),before);assert.deepEqual(f.calls,[]);
});

test('collection scope validation is read-only and cannot normalize a replacement owner',()=>{
  const f=fixture(),guard=f.c.coreadCaptureCollectionMutation('folder');
  f.c.coread=()=>{throw Error('late check must not normalize current settings');};
  assert.equal(guard.isCurrent(),true);assert.equal(guard.currentCollection(),f.data.collections[0]);
  f.c.settings.coread={};assert.equal(guard.isCurrent(),false);assert.equal(guard.currentCollection(),null);
});
