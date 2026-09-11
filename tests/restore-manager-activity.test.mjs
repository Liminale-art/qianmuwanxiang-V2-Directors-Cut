import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {storyboardFunctionSource as source} from './helpers/storyboard-form-fixture.mjs';
import {createStorageCleanupSession} from '../qianmu-storage-cleanup-session.js';

function fixture(){
  const f={chat:'chat',namespace:'account',root:{isConnected:true},modalOpen:true,other:{},loads:0,opened:0,writes:0,notes:[],refreshes:0};
  let finish;
  f.view={isOpen:true,finished:new Promise(r=>finish=r),close(){this.isOpen=false;finish();}};
  const manager={openRestoreStorageManager:options=>{f.opened++;f.options=options;return f.view;}};
  manager.openMappingRegistry=manager.openRestoreStorageManager;
  const features={
    storyboardRestoreStorage:{runRestoreStorage:async(action,options)=>{await options.guard();f.writes++;return action;}},
    storyboardRestoreStorageView:manager,storyboardMappingView:manager,
    imageAdmission:{resolveImageAccountNamespace:async()=>f.identity?f.identity():f.namespace},
    storyboardPackageMutation:{storyboardPackageDigest:async value=>{assert.equal(value,'chat');return 'hash';}},
  };
  const c=vm.createContext({settings:{},storyboardAdmissionEpoch:1,getChatKey:()=>f.chat,MODAL_ID:'fixture',
    document:{getElementById:()=>({classList:{contains:()=>f.modalOpen}})},
    featureRuntime:{load:async name=>{f.loads++;return f.load?f.load(name,features[name]):features[name];}},
    applyQianmuIcons(){},formatStorageBytes(){},toast:message=>f.notes.push(message),refreshStorageInventory:async()=>f.refreshes++});
  vm.runInContext(source('storyboardOpenRestoreStorage'),c);
  c.configRestoreActivity=(cleanup=true,own=null)=>({transfer:own!==c.storyboardOpenRestoreStorage&&!!c.storyboardOpenRestoreStorage.busy,...f.other});
  f.c=c;f.start=options=>c.storyboardOpenRestoreStorage(f.root,'account',options);return f;
}
const tick=()=>new Promise(r=>setImmediate(r));

test('all existing activity lanes reject a manager before loading its runtime or claiming a window',async()=>{
  for(const lane of ['voice','reader','focus','director','image','transfer']){
    const f=fixture();f.other={[lane]:true};await f.start();assert.equal(f.loads,0);assert.equal(f.opened,0);assert.equal(!!f.c.storyboardOpenRestoreStorage.busy,false);assert.match(f.notes[0],/结束正在进行/);
  }
});

test('both management views own one activity slot from lazy loading until their actual close',async()=>{
  for(const mappings of [false,true]){
    const f=fixture();let release;
    f.load=(name,value)=>name==='storyboardRestoreStorage'?new Promise(r=>release=()=>r(value)):value;
    const pending=f.start({mappings});await tick();assert.equal(f.c.configRestoreActivity().transfer,true);
    await f.start();assert.equal(f.loads,4,'duplicate open does not load a second runtime');
    release();await tick();assert.equal(f.opened,1);assert.equal(f.c.configRestoreActivity().transfer,true);
    await f.options.run('inspect',{});assert.equal(f.writes,1,'the manager can ignore its own slot');
    f.view.close();await pending;assert.equal(f.c.configRestoreActivity().transfer,false);
  }
});

test('owner, chat, page, account and other activity are rechecked after the asynchronous identity lookup',async()=>{
  for(const mode of ['owner','chat','root','modal','epoch','account','activity']){
    const f=fixture();let release;f.identity=()=>new Promise(r=>release=r);
    const pending=f.start();await tick();
    if(mode==='owner')f.c.settings={};if(mode==='chat')f.chat='other';if(mode==='root')f.root.isConnected=false;
    if(mode==='modal')f.modalOpen=false;if(mode==='epoch')f.c.storyboardAdmissionEpoch++;if(mode==='activity')f.other={image:true};
    release(mode==='account'?'other':'account');await pending;
    assert.equal(f.opened,0);assert.equal(f.writes,0);assert.equal(f.c.storyboardOpenRestoreStorage.busy,false);assert.ok(f.notes.length);
  }
});

test('late activity blocks every action including alias edits, not only two previously guarded actions',async()=>{
  for(const action of ['inspect','clear','mapping-import-apply','user-alias-apply']){
    const f=fixture(),pending=f.start();await tick();assert.equal(f.opened,1);
    f.other={transfer:true};await assert.rejects(f.options.run(action,{}),/其他任务/);assert.equal(f.writes,0);
    f.view.close();await pending;assert.equal(f.c.storyboardOpenRestoreStorage.busy,false);
  }
});

test('load failures release the activity slot so an independent later attempt is not permanently blocked',async()=>{
  const f=fixture();f.load=()=>{throw Error('synthetic unavailable module');};await f.start();
  assert.equal(f.c.storyboardOpenRestoreStorage.busy,false);assert.equal(f.opened,0);
  delete f.load;const pending=f.start();await tick();assert.equal(f.opened,1);f.view.close();await pending;
});

function cleanupFixture(selected=['__storyboard_restores__']){
  const f=fixture(),c=f.c;let click;
  f.root.querySelector=s=>s==='.sd-storage-clean'?{addEventListener:(_name,callback)=>click=callback}:null;f.root.querySelectorAll=()=>[];
  c.storageInventoryState={data:{restoreStorage:{namespace:'account'}}};c.openStorageCleanupDialog=async()=>selected;
  const activity=c.configRestoreActivity;
  c.configRestoreActivity=(include=true,own=null)=>({...activity(include,own),cleanup:include&&c.storageCleanupSession.busy});
  c.storageCleanupSession=createStorageCleanupSession({owner:()=>c.settings,scope:()=>f.chat,epoch:()=>c.storyboardAdmissionEpoch,activity:()=>c.configRestoreActivity(false)});
  c.blobStore={clearStorageItems:()=>assert.fail('handoff must not clear unrelated selected stores')};c.saveSettings=()=>assert.fail('handoff must not save unrelated configuration');
  vm.runInContext(source('bindStorageManagementEvents'),c);c.bindStorageManagementEvents(f.root);f.cleanup=()=>click();return f;
}

test('real cleanup hands off its slot to the real per-record manager without bypassing task protection',async()=>{
  const f=cleanupFixture(),pending=f.cleanup();await tick();
  assert.equal(f.opened,1);assert.equal(f.c.storageCleanupSession.busy,false);assert.equal(f.c.storyboardOpenRestoreStorage.busy,true);
  assert.equal(f.c.storageCleanupSession.begin(f.root),null,'manager protects itself from another cleanup');
  f.view.close();await pending;assert.equal(f.c.configRestoreActivity().transfer,false);assert.equal(f.c.storageCleanupSession.busy,false);assert.deepEqual(f.notes,[]);
});

test('mixed selections require explicit handoff consent and never resume stale unrelated cleanup',async()=>{
  for(const choice of [true,false]){
    const f=cleanupFixture(['__storyboard_restores__','notes','favorites']);let asked=0;
    f.c.confirmDialog=async(title,text)=>{asked++;assert.match(title,/先管理/);assert.match(text,/不会清理.*其他 2 项.*重新选择/);assert.equal(f.c.storageCleanupSession.busy,true);return choice;};
    const pending=f.cleanup();await tick();assert.equal(asked,1);assert.equal(f.opened,choice?1:0);
    if(choice)f.view.close();await pending;assert.equal(f.c.storageCleanupSession.busy,false);assert.equal(f.writes,0);assert.deepEqual(f.notes,[]);
  }
});

test('handoff confirmation cannot outlive its scope or bypass a task starting during manager loading',async()=>{
  for(const mode of ['owner','chat','epoch','root','activity','load-activity','load-failure']){
    const f=cleanupFixture(['__storyboard_restores__','notes']);
    f.c.confirmDialog=async()=>{if(mode==='owner')f.c.settings={};if(mode==='chat')f.chat='other';if(mode==='epoch')f.c.storyboardAdmissionEpoch++;if(mode==='root')f.root.isConnected=false;if(mode==='activity')f.other={image:true};return true;};
    if(mode==='load-activity')f.load=(_name,value)=>{f.other={image:true};return value;};
    if(mode==='load-failure')f.load=()=>{throw Error('synthetic load failure');};
    await f.cleanup();assert.equal(f.opened,0,mode);assert.equal(f.writes,0,mode);assert.equal(f.c.storageCleanupSession.busy,false,mode);assert.equal(!!f.c.storyboardOpenRestoreStorage.busy,false,mode);assert.ok(f.notes.length,mode);
  }
});
