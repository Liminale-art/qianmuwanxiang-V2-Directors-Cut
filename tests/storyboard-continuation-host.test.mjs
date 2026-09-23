import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {createStoryboardContinuationHost} from '../qianmu-storyboard-continuation-host.js';
import {createStoryboardMessageReference,resolveStoryboardMessageReference} from '../qianmu-storyboard.js';
import {readStoryboardContinuationLinks,storyboardContinuationSavePending} from '../qianmu-storyboard-continuation-proof.js?v=1.59.350';
import {acquireChatSaveLock,releaseChatSaveLock} from '../qianmu-chat-save-lock.js';
const copy=value=>JSON.parse(JSON.stringify(value));
const deferred=()=>{let resolve;const promise=new Promise(yes=>{resolve=yes;});return{promise,resolve};};
async function tick(){for(let i=0;i<30;i++)await Promise.resolve();}
function fixture(extra={}){
  const message={mes:'Alice cooks.\n\n',name:'Alice',send_date:'day-1',gen_started:'gen-1',swipe_id:0},emitter=new EventEmitter();
  const store={},host={chatId:'chat',characterId:0,characters:[{chat:'chat',avatar:'Alice.png'}],chat:[message],chatMetadata:{story_director_liminale:store},eventSource:emitter};
  let epoch=0,enabled=true,saves=0,accounts=0,namespace='st-user:test',write=async()=>{},account=null;
  host.saveMetadata=async()=>{saves++;await write();};
  const notices=[],runtime=createStoryboardContinuationHost({getContext:()=>host,epoch:()=>epoch,enabled:()=>enabled,createReference:createStoryboardMessageReference,
    resolveNamespace:async()=>{accounts++;return account?account():namespace;},notify:message=>notices.push(message),...extra});
  const reference=()=>createStoryboardMessageReference({message,chatKey:'chat',floor:host.chat.length-1});
  return{host,message,emitter,store,runtime,notices,reference,get saves(){return saves;},get accounts(){return accounts;},
    set write(value){write=value;},set account(value){account=value;},set enabled(value){enabled=value;},set namespace(value){namespace=value;},bump:()=>epoch++,
    start:(type='continue',options={},dryRun=false)=>emitter.emit('generation_after_commands',type,options,dryRun),
    advance(n=2){message.mes+='Bob brings a bowl.\n\n';message.send_date=`day-${n}`;message.gen_started=`gen-${n}`;message.swipe_info=[{send_date:message.send_date,gen_started:message.gen_started,extra:{}}];},
    gate:(type='continue')=>runtime.beforeAutomatic(host.chat.length-1,message,type),
    listeners:()=>emitter.eventNames().reduce((sum,event)=>sum+emitter.listenerCount(event),0)};
}

test('host begin captures synchronously before date mutation without account lookup, saving or blocking ST generation',async()=>{
  const f=fixture(),old=f.reference(),before=copy(f.host.chat);f.start();assert.equal(f.accounts,0);assert.equal(f.saves,0);assert.deepEqual(f.host.chat,before);
  f.advance();assert.notEqual(f.reference().messageKey,old.messageKey);assert.equal(await f.gate(),true);assert.equal(f.saves,1);
  assert.equal(resolveStoryboardMessageReference(old,f.host.chat,{chatKey:'chat',metadata:f.host.chatMetadata}).state,'active');
  assert.doesNotMatch(JSON.stringify(f.store),/Alice cooks|Bob brings|apiKey|prompt/);f.runtime.close();assert.equal(f.listeners(),0);
});

test('a failing notification cannot throw into host listeners or admit an unconfirmed continuation',async()=>{
  const f=fixture({notify:()=>{throw Error('notification plugin unavailable');}});let later=0;
  f.emitter.on('message_received',()=>later++);assert.doesNotThrow(()=>f.emitter.emit('message_received',0,'continue'));
  assert.equal(later,1);assert.equal(await f.gate(),false);assert.equal(f.saves,0);f.runtime.close();
});

test('a failing optional inline refresh does not undo a confirmed save or schedule a second save',async()=>{
  const f=fixture({onSaved:()=>{throw Error('renderer is closing');}});f.start();f.advance();assert.equal(await f.gate(),true);
  assert.equal(await f.gate(),true);assert.equal(f.saves,1);assert.equal(f.notices.length,0);assert.equal(readStoryboardContinuationLinks(f.store).length,1);f.runtime.close();
});

test('transient host context errors cannot escape the received listener and interrupt later ST handlers',async()=>{
  let fail=false;const f=fixture();f.runtime.close();
  const runtime=createStoryboardContinuationHost({getContext:()=>{if(fail)throw Error('host switching');return f.host;},epoch:()=>0,enabled:()=>true,
    createReference:createStoryboardMessageReference,resolveNamespace:async()=>'st-user:test',notify:()=>{}});
  let later=0;f.emitter.on('message_received',()=>later++);fail=true;
  assert.doesNotThrow(()=>f.emitter.emit('message_received',0,'continue'));assert.equal(later,1);assert.equal(runtime.beforeAutomatic(0,f.message,'continue'),false);
  runtime.close();f.runtime.close();
});

test('rejected notification promises are isolated without unhandled rejections or a retry',async()=>{
  const f=fixture({notify:async()=>{throw Error('asynchronous toast failure');}});f.emitter.emit('message_received',0,'continue');
  await tick();assert.equal(await f.gate(),false);assert.equal(f.saves,0);f.runtime.close();
});

test('a rejected optional refresh promise does not reject confirmed continuation handoff',async()=>{
  const f=fixture({onSaved:async()=>{throw Error('asynchronous renderer failure');}});f.start();f.advance();
  assert.equal(await f.gate(),true);await tick();assert.equal(f.saves,1);assert.equal(f.notices.length,0);f.runtime.close();
});

test('throwing host getters at initialization yield an inert adapter rather than breaking extension startup',()=>{
  const runtime=createStoryboardContinuationHost({getContext:()=>{throw Error('not ready');},epoch:()=>0,enabled:()=>true});
  assert.equal(runtime.beforeAutomatic(0,{},'continue'),false);assert.doesNotThrow(()=>runtime.close());
});

test('a throwing enable getter is isolated from generation dispatch and never requests a save',()=>{
  const f=fixture({enabled:()=>{throw Error('settings replaced');}});let later=0;f.emitter.on('generation_after_commands',()=>later++);
  assert.doesNotThrow(()=>f.start());assert.equal(later,1);assert.equal(f.gate(),false);assert.equal(f.saves,0);f.runtime.close();
});

test('partial subscription failure removes already-attached listeners and leaves the adapter closed',()=>{
  const events=new EventEmitter(),on=events.on.bind(events);let count=0;events.on=(...args)=>{on(...args);if(++count===2)throw Error('host teardown during binding');return events;};
  const runtime=createStoryboardContinuationHost({getContext:()=>({eventSource:events}),epoch:()=>0,enabled:()=>true});
  assert.equal(events.eventNames().length,0);assert.equal(runtime.beforeAutomatic(0,{},'continue'),false);runtime.close();
});

test('one failed unsubscribe does not prevent cleanup of remaining event handlers',()=>{
  const f=fixture(),original=f.emitter.removeListener.bind(f.emitter);let calls=0;
  // Adapter captures its remove method at creation, so install a fresh source.
  f.runtime.close();f.emitter.removeListener=(...args)=>{calls++;original(...args);if(calls===1)throw Error('after removal');return f.emitter;};
  const runtime=createStoryboardContinuationHost({getContext:()=>f.host,epoch:()=>0,enabled:()=>true});
  assert.doesNotThrow(()=>runtime.close());assert.equal(calls,2);assert.equal(f.listeners(),0);runtime.close();assert.equal(calls,2);
});

test('the received event releases ST immediately and persists the relation independently of the automatic extraction queue',async()=>{
  const rendered=[],f=fixture({onSaved:floor=>rendered.push(floor)}),gate=deferred(),started=deferred();
  f.write=async()=>{started.resolve();await gate.promise;};
  // ST snapshots its listeners before its sequential awaited dispatch.
  for(const listener of f.emitter.listeners('generation_after_commands'))await listener('continue',{},false);
  f.advance();for(const listener of f.emitter.listeners('message_received'))assert.equal(listener(0,'continue'),undefined);
  await started.promise;assert.equal(f.saves,1);assert.deepEqual(rendered,[]);gate.resolve();assert.equal(await f.gate(),true);assert.deepEqual(rendered,[0]);
  f.runtime.close();assert.equal(f.listeners(),0);
});

test('normal and dry-run generation take a metadata-only fast path without capture or save',async()=>{
  const f=fixture();for(const type of ['normal','regenerate','swipe','quiet','impersonate']){f.start(type);assert.equal(f.gate(type),null);}
  f.start('continue',{},true);assert.equal(f.gate('normal'),null);assert.equal(f.accounts,0);assert.equal(f.saves,0);f.runtime.close();assert.equal(f.listeners(),0);
});

test('duplicate terminal notifications share one save barrier, including notifications with no type',async()=>{
  const f=fixture(),gate=deferred(),started=deferred();f.write=async()=>{started.resolve();await gate.promise;};f.start();f.advance();
  const a=f.gate(),b=f.gate(undefined);await started.promise;assert.equal(f.saves,1);assert.equal(storyboardContinuationSavePending(f.store),true);assert.equal(readStoryboardContinuationLinks(f.store),undefined);
  gate.resolve();assert.equal(await a,true);assert.equal(await b,true);assert.equal(await f.gate(),true);assert.equal(f.saves,1);assert.equal(storyboardContinuationSavePending(f.store),false);f.runtime.close();
});

test('a continue first seen after hot reload is blocked instead of using an ordinary fresh budget',()=>{
  const f=fixture();f.advance();assert.equal(f.gate(),false);assert.equal(f.gate(),false);assert.equal(f.notices.length,1);assert.equal(f.saves,0);assert.equal(f.accounts,0);f.runtime.close();
});

test('saved continuation barriers are not reusable for an edited final body or a later generation',async()=>{
  for(const mutate of [f=>f.message.mes+='edited',f=>f.message.gen_started='another']){
    const f=fixture();f.start();f.advance();assert.equal(await f.gate(),true);mutate(f);assert.equal(await f.gate(),false);assert.equal(f.saves,1);f.runtime.close();
  }
});

for(const [name,mutate]of[['edit',f=>f.emitter.emit('message_edited',0)],['swipe',f=>f.message.swipe_id=1],['chat switch',f=>f.host.chatId='other'],
  ['epoch',f=>f.bump()],['disabled',f=>f.enabled=false],['message replacement',f=>f.host.chat[0]=copy(f.message)],['new generation',f=>f.start('regenerate')]]){
  test(`${name} stops the captured continuation without saving or invoking image work`,async()=>{
    const f=fixture();f.start();f.advance();mutate(f);assert.equal(await f.gate(),false);assert.equal(f.saves,0);f.runtime.close();assert.equal(f.listeners(),0);
  });
}

test('host rejection rolls back only the staged bridge and repeated terminal events do not retry saves',async()=>{
  const f=fixture();f.write=async()=>{throw Error('not public');};f.start();f.advance();assert.equal(await f.gate(),false);assert.equal(await f.gate(),false);
  assert.equal(f.saves,1);assert.equal(f.notices.length,1);assert.doesNotMatch(f.notices[0],/not public/);assert.equal(f.store.storyboardContinuations,undefined);f.runtime.close();
});

test('save timeout blocks automatic work, retains the issued lock until settlement and never resumes a late batch',async()=>{
  const f=fixture({timeoutMs:100}),gate=deferred(),started=deferred();f.write=async()=>{started.resolve();await gate.promise;};f.start();f.advance();
  const pending=f.gate();await started.promise;assert.equal(await pending,false);const token={};assert.equal(acquireChatSaveLock(f.store,token),false);
  assert.equal(storyboardContinuationSavePending(f.store),true);assert.equal(await f.gate(),false);gate.resolve();await tick();
  assert.equal(storyboardContinuationSavePending(f.store),false);assert.equal(f.store.storyboardContinuations.length,1);
  assert.equal(acquireChatSaveLock(f.store,token),true);releaseChatSaveLock(f.store,token);assert.equal(await f.gate(),false);assert.equal(f.saves,1);f.runtime.close();assert.equal(f.listeners(),0);
});

test('a busy shared metadata writer blocks before account lookup and does not poll or retry',async()=>{
  const f=fixture(),token={};assert.equal(acquireChatSaveLock(f.store,token),true);f.start();f.advance();assert.equal(await f.gate(),false);releaseChatSaveLock(f.store,token);
  assert.equal(await f.gate(),false);assert.equal(f.saves,0);assert.equal(f.accounts,0);f.runtime.close();assert.equal(f.listeners(),0);
});

test('switching source during account lookup cancels before a host save',async()=>{
  const f=fixture(),gate=deferred(),started=deferred();f.account=async()=>{started.resolve();await gate.promise;return 'st-user:test';};f.start();f.advance();
  const pending=f.gate();await started.promise;f.runtime.reset();gate.resolve();assert.equal(await pending,false);assert.equal(f.saves,0);assert.equal(f.notices.length,0);f.runtime.close();assert.equal(f.listeners(),0);
});

test('source switching after an issued successful save preserves its old-chat proof but cannot resume automatic work',async()=>{
  const f=fixture(),gate=deferred(),started=deferred();f.write=async()=>{started.resolve();await gate.promise;};f.start();f.advance();const pending=f.gate();await started.promise;
  f.host.chatId='other';f.runtime.reset();gate.resolve();assert.equal(await pending,false);assert.equal(f.store.storyboardContinuations.length,1);assert.equal(f.notices.length,0);f.runtime.close();
});

test('continue observation reads only the current floor even in a five-thousand-floor chat',async()=>{
  const f=fixture();f.host.chat.unshift(...Array.from({length:4999},()=>({get mes(){throw Error('unselected body read');}})));f.start();f.advance();
  assert.equal(await f.gate(),true);assert.equal(f.saves,1);f.runtime.close();assert.equal(f.listeners(),0);
});

test('dispose and abort release observers and prevent later events from reviving a captured source',async()=>{
  const f=fixture(),controller=new AbortController();f.start('continue',{signal:controller.signal});f.advance();controller.abort();assert.equal(await f.gate(),false);f.runtime.close();
  assert.equal(f.listeners(),0);f.start();assert.equal(await f.gate(),false);assert.equal(f.saves,0);
});
