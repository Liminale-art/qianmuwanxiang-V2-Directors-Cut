import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {releasePlanReferencesForChats} from '../qianmu-plan-archive-write.js';
import {storyboardFunctionSource as source} from './helpers/storyboard-form-fixture.mjs';

// Execute the real button callback and reference reconciliation. Only database IO
// and the surrounding ST shell are substitutes: no real originals are deleted.
function fixture(result) {
  const notices=[],handlers=new Map(),state={shotPlans:['a','b','unselected'].map(chatKey=>({
    id:'plan-'+chatKey,chatKey,archiveRef:'original-'+chatKey,archiveVersion:1,archivedAt:7,
  }))};
  const selected=['a','b'].map(chatKey=>({name:'storyboard_plan_archives',chatKey}));
  const c=vm.createContext({releasePlanReferencesForChats,storyboardPlanArchiveEpoch:0,storyboardPlanArchiveTimer:null,storyboardPlanArchiveCache:new Map(),
    storageInventoryState:{data:{idb:{stores:[]}}},storyboardState:()=>state,
    openStorageChatCleanupDialog:async()=>selected,blobStore:{clearChatScopedStorage:async entries=>{assert.equal(entries,selected);return result;}},
    getChatKey:()=> 'a',reconcileClearedStorageItems:()=>({chatMetadataChanged:false}),saveSettings(){},
    refreshStorageInventory:async()=>{},toast:(...args)=>notices.push(args),formatStorageBytes:()=> '0 B'});
  vm.runInContext(source('reconcileClearedStoryboardPlanChats')+'\n'+source('bindStorageManagementEvents'),c);
  c.bindStorageManagementEvents({querySelector:selector=>selector==='.sd-storage-chat-clean'?{addEventListener:(name,callback)=>handlers.set(name,callback)}:null,querySelectorAll:()=>[]});
  return {state,notices,run:()=>handlers.get('click')()};
}
const row=(chatKey,count=1)=>({name:'storyboard_plan_archives',chatKey,count,bytes:10});

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
