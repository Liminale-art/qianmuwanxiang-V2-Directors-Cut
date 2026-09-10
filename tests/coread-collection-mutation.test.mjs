import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
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
  const names=['coreadCaptureCollectionMutation','coreadCollections','coreadCreateCollection','coreadRenameCollection','coreadDissolveCollection'];
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
