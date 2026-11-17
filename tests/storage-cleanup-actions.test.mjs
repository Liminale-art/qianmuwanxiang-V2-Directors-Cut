import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {createStorageCleanupSession} from '../qianmu-storage-cleanup-session.js';
import {storyboardFunctionSource as source} from './helpers/storyboard-form-fixture.mjs';
import {storageEventsShell,storageCardRoot} from './helpers/storage-card.mjs';

// Execute the real button callbacks and the real scan gate. Only database IO
// and the surrounding ST shell are substitutes: no real originals are deleted.
function fixture(result, kind = 'chat') {
  const notices=[],state={logs:['original'],pipelineLogs:['original']},reconciled=[];
  const selected=['a','b'].map(chatKey=>({name:'audio',chatKey}));
  const calls={save:0,clear:0,metadata:0,refresh:0};
  let currentScanScope=JSON.stringify([1,'st-user:fixture']);
  const card=storageCardRoot();
  const c=vm.createContext(storageEventsShell({settings:{logHistory:['original']},storyboardAdmissionEpoch:1,setTimeout,
    storageInventoryState:{status:'ready',scope:currentScanScope,data:{idb:{stores:[]}}},storageInventoryScope:async()=>currentScanScope,storyboardState:()=>state,
    openStorageChatCleanupDialog:async()=>selected,openStorageCleanupDialog:async()=>['__diagnostics__'],blobStore:{clearChatScopedStorage:async entries=>{calls.clear++;assert.equal(entries,selected);return result;},clearStorageItems:async()=>{calls.clear++;return result;}},
    getChatKey:()=> 'a',reconcileClearedStorageItems:names=>{reconciled.push([...names]);return {chatMetadataChanged:false};},saveSettings(){calls.save++;},saveMetadata:async()=>{calls.metadata++;},
    refreshStorageInventory:async()=>{calls.refresh++;},toast:(...args)=>notices.push(args),formatStorageBytes:()=> '0 B'}));
  vm.runInContext([source('ensureStorageScanCurrent'),source('storageScanForCleanup'),source('bindStorageManagementEvents')].join('\n'),c);
  c.storageCleanupSession=createStorageCleanupSession({owner:()=>c.settings,scope:()=>c.getChatKey(),epoch:()=>c.storyboardAdmissionEpoch});
  const root=card.root;
  c.bindStorageManagementEvents(root);
  return {c,root,card,state,notices,calls,reconciled,selected:kind==='chat'?selected:['__diagnostics__'],setScanScope:value=>{currentScanScope=value;},run:()=>card.click(kind==='chat'?'.sd-storage-chat-clean':'.sd-storage-clean')};
}
const row=(chatKey,count=1,name='audio')=>({name,chatKey,count,bytes:10});

test('the card wires exactly one export, one import and the two cleanup entries, once',()=>{
  const e=fixture({cleared:[],failed:[],count:0,bytes:0});
  for(const selector of ['.sd-storage-export','.sd-storage-import','.sd-storage-clean','.sd-storage-chat-clean'])assert.equal(e.card.bound(selector),true,selector);
  const before=['.sd-storage-clean','.sd-storage-chat-clean'].map(selector=>e.card.node(selector).handlers.get('click'));
  e.c.bindStorageManagementEvents(e.root);
  assert.deepEqual(['.sd-storage-clean','.sd-storage-chat-clean'].map(selector=>e.card.node(selector).handlers.get('click')),before);
  assert.equal(e.card.backup.dataset.storageBound,'true');
});

test('cleanup without a current scan scans first, and waits for a scan already running',async()=>{
  for(const kind of ['chat','module']){
    const e=fixture({cleared:[],failed:[],count:0,bytes:0},kind);let opened=null;
    const ready=e.c.storageInventoryState;e.c.storageInventoryState={status:'idle',data:null};
    e.c.refreshStorageInventory=async force=>{e.calls.refresh++;assert.equal(force,true);e.c.storageInventoryState=ready;};
    e.c[kind==='chat'?'openStorageChatCleanupDialog':'openStorageCleanupDialog']=async data=>{opened=data;return null;};
    await e.run();assert.equal(e.calls.refresh,1,kind);assert.equal(opened,ready.data,kind);assert.equal(e.calls.clear,0);

    const waiting=fixture({cleared:[],failed:[],count:0,bytes:0},kind),done=waiting.c.storageInventoryState;let seen=null;
    waiting.c.storageInventoryState={status:'loading',data:null,scope:done.scope};
    waiting.c[kind==='chat'?'openStorageChatCleanupDialog':'openStorageCleanupDialog']=async data=>{seen=data;return null;};
    const pending=waiting.run();await new Promise(resolve=>setImmediate(resolve));assert.equal(seen,null,kind);
    waiting.c.storageInventoryState=done;await pending;
    assert.equal(seen,done.data,kind);assert.equal(waiting.calls.refresh,0,kind);assert.equal(waiting.c.storageCleanupSession.busy,false);
  }
});

test('a scan that fails leaves cleanup unopened and releases the session',async()=>{
  for(const kind of ['chat','module']){
    const e=fixture({cleared:[],failed:[],count:0,bytes:0},kind);let opened=0;
    e.c.storageInventoryState={status:'idle',data:null};
    e.c.refreshStorageInventory=async()=>{e.calls.refresh++;e.c.storageInventoryState={status:'error',data:null,error:'unavailable'};};
    e.c[kind==='chat'?'openStorageChatCleanupDialog':'openStorageCleanupDialog']=async()=>{opened++;return e.selected;};
    await e.run();assert.equal(opened,0,kind);assert.equal(e.calls.clear,0,kind);assert.equal(e.calls.save,0,kind);
    assert.match(e.notices.at(-1)[0],/重新扫描/);assert.equal(e.notices.at(-1)[1],'error');assert.equal(e.c.storageCleanupSession.busy,false);
  }
});

test('collection-only cleanup uses its scanned fingerprint and never opens generic cache cleanup or saves ST settings',async()=>{
  const e=fixture({cleared:[],failed:[],count:0,bytes:0},'module');let called=0;
  e.c.storageInventoryState.data.collectionStorage={fingerprint:'scanned-collection'};
  e.c.openStorageCleanupDialog=async()=>['__text_collection__'];
  e.c.proseFloorTools={clearCollection:async options=>{
    called++;assert.equal(options.confirmed,true);assert.equal(options.expectedFingerprint,'scanned-collection');options.check();
    return {status:'cleared',count:2};
  }};
  await e.run();assert.equal(called,1);assert.equal(e.calls.clear,0);assert.equal(e.calls.save,0);
  assert.equal(e.c.storageCleanupSession.busy,false);
});

test('a collection conflict stops mixed cleanup before unrelated deletion or settings writes',async()=>{
  const e=fixture({cleared:[],failed:[],count:0,bytes:0},'module');
  e.c.storageInventoryState.data.collectionStorage={fingerprint:'scanned-collection'};
  e.c.openStorageCleanupDialog=async()=>['__text_collection__','__diagnostics__'];
  e.c.proseFloorTools={clearCollection:async options=>{options.check();throw Error('收藏已有更新');}};
  await e.run();assert.equal(e.calls.clear,0);assert.equal(e.calls.save,0);
  assert.deepEqual(Array.from(e.c.settings.logHistory),['original']);assert.equal(e.notices.at(-1)[1],'error');
  assert.equal(e.c.storageCleanupSession.busy,false);
});

test('a stale scan scope after selection blocks both cleanup entry points before any deletion',async()=>{
  for(const kind of ['chat','module']){
    const e=fixture({cleared:[],failed:[],count:0,bytes:0},kind);let opened=0;
    e.c[kind==='chat'?'openStorageChatCleanupDialog':'openStorageCleanupDialog']=async()=>{
      opened++;e.setScanScope(JSON.stringify([1,'st-user:other']));return e.selected;
    };
    await e.run();
    assert.equal(opened,1,kind);assert.equal(e.calls.clear,0,kind);assert.equal(e.calls.save,0,kind);
    assert.deepEqual(e.reconciled,[]);assert.deepEqual(e.state.logs,['original']);
    assert.match(e.notices.at(-1)[0],/重新扫描/);assert.equal(e.c.storageCleanupSession.busy,false);
  }
});

test('cleanup owns its page watcher through mutation and releases it once without releasing a newer operation',()=>{
  let closed=false,released=0;
  const session=createStorageCleanupSession({owner:()=>1,scope:()=>1,epoch:()=>1,watchView:()=>({check(){if(closed)throw Error('closed and reopened');},release(){released++;}})});
  const token=session.begin({isConnected:true});token.check();closed=true;
  assert.throws(()=>token.check(),/后续操作已停止/);closed=false;assert.throws(()=>token.check(),/后续操作已停止/);
  token.release();assert.equal(released,1);const next=session.begin({isConnected:true});token.release();assert.equal(session.busy,true);
  next.check();next.release();assert.equal(released,2);
  const failed=createStorageCleanupSession({owner:()=>1,scope:()=>1,epoch:()=>1,watchView(){throw Error('initially closed');}});
  assert.equal(failed.begin({isConnected:true}),null);assert.equal(failed.busy,false);
});

test('cleanup cannot start while any known task lane is active or status cannot be read',()=>{
  for(const lane of ['reader','focus','director','voice','image','transfer','unknown']){
    const notices=[],session=createStorageCleanupSession({owner:()=>1,scope:()=>1,epoch:()=>1,notify:text=>notices.push(text),
      activity:()=>{if(lane==='unknown')throw Error('synthetic');return {[lane]:true};}});
    assert.equal(session.begin({isConnected:true}),null,lane);assert.equal(session.busy,false);assert.equal(notices.length,1);
  }
});

test('a newly started task permanently invalidates the old cleanup, even after the task finishes',()=>{
  for(const lane of ['reader','focus','director','voice','image','transfer','unknown']){
    let running=false;const session=createStorageCleanupSession({owner:()=>1,scope:()=>1,epoch:()=>1,
      activity:()=>{if(running&&lane==='unknown')throw Error('synthetic');return {[lane]:running};}});
    const token=session.begin({isConnected:true});token.check();running=true;
    assert.throws(()=>token.check(),/后续操作已停止/);running=false;
    assert.throws(()=>token.check(),/后续操作已停止/);token.release();
    const retry=session.begin({isConnected:true});retry.check();retry.release();
  }
});

test('orphan cleanup receives the initiating session, not an unguarded background delete',async()=>{
  const e=fixture({cleared:[],failed:[]},'module');let checked=false;
  e.c.openStorageCleanupDialog=async()=>['__orphan_reader_blobs__'];
  e.c.blobStore.clearOrphanedReaderBlobs=async(session)=>{
    session.check();e.root.isConnected=false;
    assert.throws(()=>session.check(),/后续操作已停止/);checked=true;return {cleared:[],failed:[]};
  };
  await e.run();assert.equal(checked,true);assert.equal(e.calls.save,0);
});

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
    assert.deepEqual(e.state.logs,['original']);assert.equal(e.c.storageCleanupSession.busy,false);
    assert.match(e.notices.at(-1)[0],/后续操作已停止/);
  }
});

test('duplicate cleanup does not open a second selector and cancellation releases the shared session',async()=>{
  const e=fixture({cleared:[],failed:[],count:0,bytes:0});let release,opened=0;
  e.c.openStorageChatCleanupDialog=()=>{opened++;return new Promise(r=>release=r);};
  const pending=e.run();await e.run();await new Promise(resolve=>setImmediate(resolve));assert.equal(opened,1);assert.equal(e.c.storageCleanupSession.busy,true);
  release(null);await pending;assert.equal(e.c.storageCleanupSession.busy,false);assert.equal(e.calls.clear,0);
  e.c.openStorageChatCleanupDialog=async()=>null;await e.run();assert.equal(e.c.storageCleanupSession.busy,false);
});

test('failed chat cleanup reconciles nothing and reports what was kept',async()=>{
  const e=fixture({cleared:[],failed:[{...row('a'),error:'locked'},{...row('b'),error:'locked'}],count:0,bytes:0});
  await e.run();
  assert.deepEqual(e.reconciled,[]);assert.equal(e.calls.metadata,0);assert.equal(e.calls.save,1);assert.equal(e.calls.refresh,1);
  assert.equal(e.notices.at(-1)[1],'warning');assert.match(e.notices.at(-1)[0],/2 个分组失败已保留/);assert.match(e.notices.at(-1)[0],/locked/);
});

test('chat cleanup resets live state only for stores actually emptied in the open chat',async()=>{
  const e=fixture({cleared:[row('a'),row('a',0,'tts_lines'),row('b',3,'reader_chats'),row('a',2,'reader_vectors'),row('a',1,'audio')],failed:[],count:7,bytes:70});
  await e.run();
  assert.deepEqual(e.reconciled,[['audio','reader_vectors']]);
  assert.equal(e.calls.save,1);assert.equal(e.calls.metadata,0);assert.equal(e.notices.at(-1)[1],'success');assert.match(e.notices.at(-1)[0],/已按聊天清理 7 项/);

  const other=fixture({cleared:[row('b',4)],failed:[],count:4,bytes:40});
  await other.run();assert.deepEqual(other.reconciled,[]);assert.equal(other.notices.at(-1)[1],'success');

  const changed=fixture({cleared:[row('a')],failed:[],count:1,bytes:10});
  changed.c.reconcileClearedStorageItems=()=>({chatMetadataChanged:true});
  await changed.run();assert.equal(changed.calls.metadata,1);
});

test('module cleanup clears only real stores, then diagnostics, and reports partial failure',async()=>{
  const e=fixture({cleared:['audio'],failed:[],count:0,bytes:0},'module');let stores=null,rings=0;
  e.c.openStorageCleanupDialog=async()=>['audio','__diagnostics__','__ringtones__'];
  e.c.chatRingtone={actions:{clearAllLocal:async()=>{rings++;}}};
  e.c.blobStore.clearStorageItems=async names=>{stores=[...names];return {cleared:['audio'],failed:[]};};
  await e.run();
  assert.deepEqual(stores,['audio']);assert.equal(rings,1);assert.deepEqual(e.reconciled,[['audio']]);
  assert.deepEqual(Array.from(e.c.settings.logHistory),[]);assert.deepEqual(Array.from(e.state.logs),[]);assert.deepEqual(Array.from(e.state.pipelineLogs),[]);
  assert.equal(e.calls.save,1);assert.deepEqual(e.notices.at(-1),['所选项目已清理。','success']);

  const partial=fixture({cleared:[],failed:[],count:0,bytes:0},'module');
  partial.c.openStorageCleanupDialog=async()=>['audio','favorites'];
  partial.c.blobStore.clearStorageItems=async()=>({cleared:['audio'],failed:[{name:'favorites',error:'locked'}]});
  await partial.run();
  assert.deepEqual(Array.from(partial.c.settings.logHistory),['original']);
  assert.equal(partial.notices.at(-1)[1],'warning');assert.match(partial.notices.at(-1)[0],/已清理 1 个项目，1 个项目失败并保留。 favorites：locked/);
});
