import test from 'node:test';
import assert from 'node:assert/strict';
import {createTextCollectionFloorStatus} from '../qianmu-text-collection-floor-status.js';

function fixture(){
  const state={namespace:'st-user:alice',scope:{chatId:'chat-a',chat:[]},current:true,clock:100,reads:0,identity:0,created:0,closed:0,changes:0,records:[],mode:'ok',hold:null};
  const account=()=>state.namespace==='st-user:alice'?'account-a':'account-b';
  const manager=createTextCollectionFloorStatus({getScope:()=>state.scope,resolveNamespace:async()=>{state.identity++;return state.namespace;},isCurrent:()=>state.current,now:()=>state.clock,maxAgeMs:1000,onChange:()=>state.changes++,sessionFactory:async()=>{
    state.created++;const expectedAccount=account();
    return {expectedAccount,guard:async()=>{if(account()!==expectedAccount)throw Error('account changed');},close:()=>state.closed++,sources:async({signal})=>{
      state.reads++;state.signal=signal;const records=structuredClone(state.records);
      if(state.mode==='hold')await new Promise(resolve=>{state.hold=resolve;});
      if(state.mode==='error')throw Error('network');
      return {expectedAccount,items:records.map(record=>record.source)};
    }};
  }});
  const row=(messageId,overrides={})=>({source:{account:'account-a',chatId:'chat-a',messageId,replyId:'swipe:0',...overrides},text:'PRIVATE BODY NOT RETAINED'});
  return {state,manager,row};
}

test('one current-chat snapshot serves every visible floor; all swipe versions count while foreign sources do not',async()=>{
  const {state,manager,row}=fixture();state.records=[row(2),row(2,{replyId:'swipe:9'}),row(4,{account:'account-b'}),row(6,{chatId:'other-chat'})];
  await Promise.all(Array.from({length:200},()=>manager.refresh()));
  assert.equal(state.reads,1);assert.equal(state.created,1);assert.equal(state.closed,1);
  assert.equal(state.identity,3,'200 concurrent renders share one identity/read/guard sequence');
  for(let floor=0;floor<200;floor++)assert.equal(manager.status(floor),floor===2);
  await manager.refresh();assert.equal(state.reads,1);
  state.clock+=1001;await manager.refresh();assert.equal(state.reads,2);manager.dispose();
});

test('missing host identity backs off failed fallback requests instead of retrying on every render',async()=>{
  const scope={chatId:'chat-a',chat:[]};let attempts=0,clock=0;
  const manager=createTextCollectionFloorStatus({getScope:()=>scope,resolveNamespace:async()=>{attempts++;throw Error('identity unavailable');},isCurrent:()=>true,now:()=>clock,maxAgeMs:1000,sessionFactory:async()=>assert.fail('no account, no snapshot')});
  await manager.refresh();for(let index=0;index<200;index++)await manager.refresh();assert.equal(attempts,1);assert.equal(manager.status(1),null);
  clock=1001;await manager.refresh();assert.equal(attempts,2);await manager.refresh({force:true});assert.equal(attempts,3);manager.dispose();
});

test('save and delete invalidation reflect only acknowledged snapshots; deleting one of two collections keeps the star',async()=>{
  const {state,manager,row}=fixture();await manager.refresh();assert.equal(manager.status(1),false);
  state.records=[row(1),row(1,{replyId:'swipe:4'})];await manager.refresh({force:true});assert.equal(manager.status(1),true);
  state.records.shift();await manager.refresh({force:true});assert.equal(manager.status(1),true);
  state.records=[];await manager.refresh({force:true});assert.equal(manager.status(1),false);
  assert.equal(state.reads,4);manager.dispose();
});

test('network failure is unknown, does not clear a server record or claim an empty library, and backs off render storms',async()=>{
  const {state,manager,row}=fixture();state.records=[row(1)];await manager.refresh();assert.equal(manager.status(1),true);
  state.mode='error';await manager.refresh({force:true});assert.equal(manager.status(1),null);
  await Promise.all(Array.from({length:100},()=>manager.refresh()));assert.equal(state.reads,2);
  state.mode='ok';await manager.refresh({force:true});assert.equal(manager.status(1),true);manager.dispose();
});

test('switching chat or account never adopts an old cache or a late response',async()=>{
  const {state,manager,row}=fixture();state.records=[row(1)];await manager.refresh();assert.equal(manager.status(1),true);
  state.scope={chatId:'chat-b',chat:[]};assert.equal(manager.status(1),null);await manager.refresh();assert.equal(manager.status(1),false);
  state.scope={chatId:'chat-a',chat:[]};state.mode='hold';const task=manager.refresh();
  while(!state.hold)await new Promise(resolve=>setImmediate(resolve));
  state.namespace='st-user:bob';state.mode='ok';state.hold();await task;assert.equal(manager.status(1),null);
  await manager.refresh();assert.equal(manager.status(1),false);manager.dispose();
});

test('invalidating in-flight state aborts it and coalesces the trailing read without optimistic fill',async()=>{
  const {state,manager,row}=fixture();state.records=[row(1)];state.mode='hold';const first=manager.refresh();
  while(!state.hold)await new Promise(resolve=>setImmediate(resolve));
  const forced=manager.refresh({force:true});assert.equal(state.signal.aborted,true);assert.equal(manager.status(1),null);
  state.records=[];state.mode='ok';state.hold();await Promise.all([first,forced]);
  assert.equal(state.reads,2);assert.equal(manager.status(1),false);assert.equal(state.closed,2);manager.dispose();
});

test('dispose aborts pending reads, drops all floor state and emits no late updates',async()=>{
  const {state,manager,row}=fixture();state.records=[row(1)];state.mode='hold';const task=manager.refresh();
  while(!state.hold)await new Promise(resolve=>setImmediate(resolve));
  manager.dispose();const changes=state.changes;assert.equal(state.signal.aborted,true);state.hold();await task;
  assert.equal(manager.status(1),null);assert.equal(state.changes,changes);await manager.refresh({force:true});assert.equal(state.reads,1);
});

test('malformed snapshot or changed source account is unknown rather than a false success',async()=>{
  const scope={chatId:'chat-a',chat:[]};
  for(const backup of [{sourceAccount:'wrong',records:[]},{sourceAccount:'a',records:null},{sourceAccount:'a',records:Array(10001).fill({})}]){
    const manager=createTextCollectionFloorStatus({getScope:()=>scope,resolveNamespace:async()=>'st-user:alice',isCurrent:()=>true,sessionFactory:async()=>({expectedAccount:'a',sources:async()=>({expectedAccount:backup.sourceAccount,items:backup.records}),close(){}})});
    await manager.refresh();assert.equal(manager.status(0),null);manager.dispose();
  }
});
