import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {releasePlanReferencesForChats} from '../qianmu-plan-archive-write.js';
import {createStorageCleanupSession} from '../qianmu-storage-cleanup-session.js';
import {storyboardFunctionSource as source} from './helpers/storyboard-form-fixture.mjs';

// Execute the real button callback and reference reconciliation. Only database IO
// and the surrounding ST shell are substitutes: no real originals are deleted.
function fixture(result, kind = 'chat') {
  const notices=[],handlers=new Map(),state={shotPlans:['a','b','unselected'].map(chatKey=>({
    id:'plan-'+chatKey,chatKey,archiveRef:'original-'+chatKey,archiveVersion:1,archivedAt:7,
  }))};
  const selected=['a','b'].map(chatKey=>({name:'storyboard_plan_archives',chatKey}));
  const calls={save:0,clear:0};
  const c=vm.createContext({settings:{logHistory:['original']},storyboardAdmissionEpoch:1,releasePlanReferencesForChats,storyboardPlanArchiveEpoch:0,storyboardPlanArchiveTimer:null,storyboardPlanArchiveCache:new Map(),
    storageInventoryState:{data:{idb:{stores:[]}}},storyboardState:()=>state,
    openStorageChatCleanupDialog:async()=>selected,openStorageCleanupDialog:async()=>['__diagnostics__'],blobStore:{clearChatScopedStorage:async entries=>{calls.clear++;assert.equal(entries,selected);return result;},clearStorageItems:async()=>{calls.clear++;return result;}},
    getChatKey:()=> 'a',reconcileClearedStorageItems:()=>({chatMetadataChanged:false}),saveSettings(){calls.save++;},
    refreshStorageInventory:async()=>{},toast:(...args)=>notices.push(args),formatStorageBytes:()=> '0 B'});
  vm.runInContext(source('reconcileClearedStoryboardPlanChats')+'\n'+source('bindStorageManagementEvents'),c);
  c.storageCleanupSession=createStorageCleanupSession({owner:()=>c.settings,scope:()=>c.getChatKey(),epoch:()=>c.storyboardAdmissionEpoch});
  const root={isConnected:true,querySelector:selector=>selector===(kind==='chat'?'.sd-storage-chat-clean':'.sd-storage-clean')?{addEventListener:(name,callback)=>handlers.set(name,callback)}:null,querySelectorAll:()=>[]};
  c.bindStorageManagementEvents(root);
  return {c,root,state,notices,calls,selected:kind==='chat'?selected:['__diagnostics__'],run:()=>handlers.get('click')()};
}
const row=(chatKey,count=1)=>({name:'storyboard_plan_archives',chatKey,count,bytes:10});

test('both real cleanup entry points pass their live scope check into the database loop',async()=>{
  for(const kind of ['chat','module']){
    const result={cleared:[],failed:[],count:0,bytes:0},e=fixture(result,kind);let checked=false;
    e.c.blobStore[kind==='chat'?'clearChatScopedStorage':'clearStorageItems']=async(entries,session)=>{
      session.check();e.root.isConnected=false;
      assert.throws(()=>session.check(),/后续操作已停止/);checked=true;return result;
    };
    await e.run();assert.equal(checked,true);assert.equal(e.calls.save,0);
  }
});

for(const phase of ['selection','storage'])test('both cleanup paths stop stale '+phase+' results before touching a new owner',async()=>{
  for(const kind of ['chat','module'])for(const change of ['owner','chat','epoch','root']){
    const result={cleared:[],failed:[],count:0,bytes:0},e=fixture(result,kind);let release;
    if(phase==='selection')e.c[kind==='chat'?'openStorageChatCleanupDialog':'openStorageCleanupDialog']=()=>new Promise(r=>release=r);
    else e.c.blobStore[kind==='chat'?'clearChatScopedStorage':'clearStorageItems']=()=>new Promise(r=>release=r);
    const pending=e.run();await new Promise(r=>setImmediate(r));assert.equal(typeof release,'function');
    if(change==='owner')e.c.settings={logHistory:['new owner']};
    if(change==='chat')e.c.getChatKey=()=> 'other';
    if(change==='epoch')e.c.storyboardAdmissionEpoch++;
    if(change==='root')e.root.isConnected=false;
    release(phase==='selection'?e.selected:result);await pending;
    assert.equal(e.calls.save,0,kind+'/'+change);assert.ok(e.c.settings.logHistory.length);
    assert.equal(e.state.shotPlans[0].archiveRef,'original-a');assert.equal(e.c.storageCleanupSession.busy,false);
    assert.match(e.notices.at(-1)[0],/后续操作已停止/);
  }
});

test('duplicate cleanup does not open a second selector and cancellation releases the shared session',async()=>{
  const e=fixture({cleared:[],failed:[],count:0,bytes:0});let release,opened=0;
  e.c.openStorageChatCleanupDialog=()=>{opened++;return new Promise(r=>release=r);};
  const pending=e.run();await e.run();assert.equal(opened,1);assert.equal(e.c.storageCleanupSession.busy,true);
  release(null);await pending;assert.equal(e.c.storageCleanupSession.busy,false);assert.equal(e.calls.clear,0);
  e.c.openStorageChatCleanupDialog=async()=>null;await e.run();assert.equal(e.c.storageCleanupSession.busy,false);
});

test('failed chat cleanup preserves original archive references, so failure remains genuinely recoverable',async()=>{
  const e=fixture({cleared:[],failed:[row('a'),row('b')],count:0,bytes:0});
  await e.run();
  assert.deepEqual(e.state.shotPlans.map(plan=>plan.archiveRef),['original-a','original-b','original-unselected']);
  assert.equal(e.notices.at(-1)[1],'warning');
});

test('partial cleanup removes only confirmed successful references, not failed or unselected chats',async()=>{
  const e=fixture({cleared:[row('b')],failed:[row('a')],count:1,bytes:10});
  await e.run();
  assert.equal(e.state.shotPlans[0].archiveRef,'original-a');
  assert.deepEqual(e.state.shotPlans[1],{id:'plan-b',chatKey:'b'});
  assert.equal(e.state.shotPlans[2].archiveRef,'original-unselected');assert.equal(e.notices.at(-1)[1],'warning');
});

test('confirmed successful groups, including already-empty ones, release only their stale references',async()=>{
  const e=fixture({cleared:[row('a'),row('b',0)],failed:[],count:1,bytes:10});
  await e.run();
  assert.deepEqual(e.state.shotPlans.slice(0,2),[{id:'plan-a',chatKey:'a'},{id:'plan-b',chatKey:'b'}]);
  assert.equal(e.state.shotPlans[2].archiveRef,'original-unselected');assert.equal(e.notices.at(-1)[1],'success');
});
