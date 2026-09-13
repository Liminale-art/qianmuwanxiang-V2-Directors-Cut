import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {storyboardFunctionSource} from './helpers/storyboard-form-fixture.mjs';

const deferred=()=>{let resolve;return {promise:new Promise(r=>{resolve=r;}),resolve:()=>resolve()};};
function fixture() {
  const host={dataset:{},isConnected:true},nai={},calls=[];let chat='original-chat',mounted;
  const root={isConnected:true,querySelector:selector=>selector.includes('comfy')?host:nai};
  const service={retrieveOriginal:async(row,options)=>{calls.push('retrieve');assert.equal(options.apiKey,'original-key');
    assert.equal(options.chatKey,'original-chat');assert.equal(row.attemptId,'original');
    return options.deliver({}, {}, [], async()=>{},async()=>{});
  }};
  const view={mountComfyInbox:(_host,options)=>{mounted=options;return ()=>calls.push('dispose');}};
  const c=vm.createContext({settings:{},storyboardAdmissionEpoch:0,getChatKey:()=>chat,uid:()=> 'ticket',
    featureRuntime:{load:async()=>view},storyboardComfyRecoveryRuntime:async()=>service,storyboardState:()=>({logs:[]}),
    storyboardResolveComfyRecoveryKey:async()=> 'original-key',storyboardDeliverGatewayResult:async(_job,log,_data,options)=>{
      assert.equal(log,null);assert.equal(options.service,true);await options.guard();calls.push('archive');return {archived:true};
    }});
  vm.runInContext(storyboardFunctionSource('storyboardOpenComfyInbox'),c);
  return {c,root,host,calls,service,view,get mounted(){return mounted;},change(kind){
    if(kind==='owner')c.settings={};else if(kind==='epoch')c.storyboardAdmissionEpoch++;
    else if(kind==='chat')chat='other';else root._sdComfyInboxCleanup();
  }};
}
const row={attemptId:'original',originalOnly:true,baseUrl:'https://comfy.test',credentialId:'original-credential'};

test('cancel from the inbox uses the original cloud credential and cannot fall through to receipt or archive',async()=>{
  const e=fixture();let cancellation=0;
  e.c.resolveComfyCloudRecoveryKey=async(_selected,ports)=>{await ports.guard();return 'original-key';};
  e.service.cancelCloudOriginal=async(selected,options)=>{
    assert.equal(selected.engine,'cloud');assert.equal(options.apiKey,'original-key');assert.equal(options.valid(),true);
    e.change('chat');assert.equal(options.valid(),false);cancellation++;return {warning:'已请求取消'};
  };
  await e.c.storyboardOpenComfyInbox(e.root);
  await e.mounted.receive({...row,engine:'cloud'},'server','cancel');assert.equal(cancellation,1);assert.deepEqual(e.calls,[]);
});

test('original-only inbox rejects late credential results after page, owner, epoch or chat changes',async()=>{
  for(const kind of ['owner','epoch','chat','dispose']) {
    const e=fixture(),entered=deferred(),release=deferred();await e.c.storyboardOpenComfyInbox(e.root);
    e.c.storyboardResolveComfyRecoveryKey=async()=>{entered.resolve();await release.promise;return 'original-key';};
    const receiving=e.mounted.receive(row);await entered.promise;e.change(kind);release.resolve();
    await assert.rejects(receiving,/收片页面已变化/);
    assert.equal(e.calls.includes('retrieve'),false);assert.equal(e.calls.includes('archive'),false);
    await assert.rejects(e.mounted.receive(row),/收片页面已变化/);
  }
});

test('a delayed inbox module cannot mount over a different configuration or chat',async()=>{
  for(const kind of ['owner','epoch','chat']) {
    const e=fixture(),release=deferred();e.c.featureRuntime.load=async()=>{await release.promise;return e.view;};
    const opening=e.c.storyboardOpenComfyInbox(e.root);e.change(kind);release.resolve();await opening;
    assert.equal(e.mounted,undefined);assert.deepEqual(e.calls,[]);
  }
});

test('original-only delivery rechecks the page after the asynchronous account guard',async()=>{
  for(const changed of [false,true]) {
    const e=fixture();e.service.retrieveOriginal=async(_row,options)=>options.deliver({}, {}, [], async()=>{},async()=>{
      if(changed)e.change('owner');
    });
    await e.c.storyboardOpenComfyInbox(e.root);
    if(changed)await assert.rejects(e.mounted.receive(row),/收片页面已变化/);
    else assert.equal((await e.mounted.receive(row)).archived,true);
    assert.deepEqual(e.calls,changed?[]:['archive']);
  }
  const e=fixture();await e.c.storyboardOpenComfyInbox(e.root);await e.mounted.receive(row);
  assert.deepEqual(e.calls,['retrieve','archive']);
});

test('cloud inbox resolves only the original cloud key and keeps the shared archive guard',async()=>{
  const e=fixture();let resolutions=0;
  e.c.resolveComfyCloudRecoveryKey=async(selected,ports)=>{assert.equal(selected.engine,'cloud');await ports.guard();resolutions++;return 'original-key';};
  e.c.storyboardResolveComfyRecoveryKey=()=>assert.fail('cloud must not resolve a native host credential');
  await e.c.storyboardOpenComfyInbox(e.root);await e.mounted.receive({...row,engine:'cloud'});
  assert.equal(resolutions,1);assert.deepEqual(e.calls,['retrieve','archive']);
});
