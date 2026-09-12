import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {storyboardFunctionSource as source} from './helpers/storyboard-form-fixture.mjs';

test('all four package paths stop before loading when the real shared page or activity check fails',async()=>{
  for(const name of ['storyboardExportPackage','storyboardImportPackage','storyboardImportBundle','storyboardReviewRecordLink']){
    for(const reason of ['page','activity']){
      let released=0,loads=0;const notices=[],modal={isConnected:true,classList:{contains:()=>true}};
      const c=vm.createContext({settings:{},storyboardAdmissionEpoch:1,document:{getElementById:()=>modal},MODAL_ID:'fixture',
        createCoreadImportViewGuard:()=>({check(){if(reason==='page')throw Error('page changed');},release(){released++;}}),
        configRestoreActivity:()=>({other:reason==='activity'}),storyboardState:()=>({}),getChatStore:()=>({}),getChatKey:()=> 'chat',
        storyboardImportPackage:{},storyboardExportPackage:{},storyboardBundleReview:null,storyboardLinkReview:null,
        featureRuntime:{load(){loads++;throw Error('must not load');}},toast:message=>notices.push(message)});
      vm.runInContext(['createStorageBackupCheck','storyboardPackageContext',name].map(source).join('\n'),c);
      await c[name]({restoreLinkReview:true});assert.equal(loads,0,name+'/'+reason);assert.equal(released,1);
      assert.equal(!!c.storyboardImportPackage.busy,false);assert.equal(!!c.storyboardExportPackage.busy,false);assert.equal(notices.length,1);
      assert.match(notices[0],reason==='page'?/page changed/:/其他任务已开始/);
    }
  }
});

test('package context keeps checking after asynchronous work rather than reusing a stale starting check',()=>{
  let stopped=false,released=0;const state={},store={},c=vm.createContext({MODAL_ID:'fixture',document:{getElementById:()=>({})},
    createStorageBackupCheck:()=>{const check=()=>{if(stopped)throw Error('stale');};check.release=()=>released++;return check;},
    storyboardState:()=>state,getChatStore:()=>store,getChatKey:()=> 'chat',storyboardAdmissionEpoch:1});
  vm.runInContext(source('storyboardPackageContext'),c);const context=c.storyboardPackageContext({});
  assert.equal(context().state,state);stopped=true;assert.throws(context,/stale/);context.release();assert.equal(released,1);
});
