import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {storyboardFunctionSource as source} from './helpers/storyboard-form-fixture.mjs';
function fixture(){
  let serial=0;const waits=[],box={isConnected:true,dataset:{},innerHTML:'initial',querySelectorAll:()=>[]};
  const modal={open:true,classList:{contains:()=>modal.open}};
  const root={isConnected:true,box,querySelector:()=>root.box,closest:()=>modal};
  const c=vm.createContext({settings:{},storyboardAdmissionEpoch:1,MODAL_ID:'fixture',uid:()=>String(++serial),
    blobStore:{blobStoreAvailable:()=>true,listFavorites:()=>new Promise((resolve,reject)=>waits.push({resolve,reject}))},
    snapshotAccState(){},applyQianmuIcons(){},applyAccState(){},htmlEscape:String,ttsFavoriteFilename:f=>f.id,
    groupByFolder:items=>({folderList:[],loose:items})});
  vm.runInContext(source('ttsRefreshFavorites'),c);
  return {c,root,box,modal,waits,run:()=>c.ttsRefreshFavorites(root)};
}
const entry={id:'fixture',meta:{text:'newer saved favorite'}};
for(const outcome of ['empty','content','error'])test('obsolete favorite '+outcome+' never paints over a changed page or owner',async()=>{
  for(const change of ['owner','epoch','closed','root','box','replacement']){
    const e=fixture(),pending=e.run(),loading=e.box.innerHTML;
    if(change==='owner')e.c.settings={};if(change==='epoch')e.c.storyboardAdmissionEpoch++;
    if(change==='closed')e.modal.open=false;if(change==='root')e.root.isConnected=false;
    if(change==='box')e.box.isConnected=false;if(change==='replacement')e.root.box={};
    if(outcome==='error')e.waits[0].reject(Error('late read'));else e.waits[0].resolve(outcome==='content'?[entry]:[]);
    await pending;assert.equal(e.box.innerHTML,loading,change);
  }
});
test('latest refresh wins even when an earlier success or error arrives later',async()=>{
  for(const error of [false,true]){
    const e=fixture(),first=e.run(),second=e.run();e.waits[1].resolve([entry]);await second;
    const newest=e.box.innerHTML;assert.match(newest,/newer saved favorite/);
    if(error)e.waits[0].reject(Error('old failure'));else e.waits[0].resolve([]);
    await first;assert.equal(e.box.innerHTML,newest);
  }
});
test('current empty and failed reads retain their existing clear messages',async()=>{
  const e=fixture(),empty=e.run();e.waits[0].resolve([]);await empty;assert.match(e.box.innerHTML,/还没有收藏/);
  const failed=e.run();e.waits[1].reject(Error('read failed'));await failed;assert.match(e.box.innerHTML,/读取收藏失败/);
});
