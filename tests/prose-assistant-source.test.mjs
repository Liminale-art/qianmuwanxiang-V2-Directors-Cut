import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {createHash} from 'node:crypto';
import {captureProseAssistantSource as capture,captureProseAssistantChatSource,PROSE_ASSISTANT_SOURCE_LIMIT,proseAssistantAccountForNamespace} from '../qianmu-prose-assistant-source.js';
import {resolveImageAccountNamespace} from '../qianmu-image-admission.js';
import {proseAssistantHistoryKey} from '../qianmu-prose-assistant-history-contract.js';

function fixture(){
  let account='st-user:alice',epoch=1,live=true;const emitter=new EventEmitter(),reads=[];
  const context={chatId:'Chat A',characterId:0,characters:[{avatar:'A.png',chat:'Chat A',name:'same'},{avatar:'B.png',chat:'Chat A',name:'same'}],groupId:null,groups:[{id:0,chat_id:'Chat A'}],chatMetadata:{integrity:'cloned'},eventSource:emitter,
    chat:[{mes:'隐藏推理或原HTML不直接引用',name:'角色',swipe_id:1},{mes:'另一个楼层，未授权读取'}]};
  const options={getContext:()=>context,epoch:()=>epoch,resolveNamespace:async()=>account,isCurrent:()=>live,floor:0,readText:(message,floor)=>{reads.push(floor);assert.equal(message,context.chat[floor]);return '未选择\r\n正文😀\r\n后文不选';}};
  return {context,options,reads,emitter,set account(value){account=value;},set live(value){live=value;},changeEpoch(){epoch++;},listeners:()=>emitter.eventNames().reduce((n,type)=>n+emitter.listenerCount(type),0)};
}

test('chat-level panel source reads no prose and stays alive when an old floor changes or new prose arrives',async()=>{
 const f=fixture(),chat=await captureProseAssistantChatSource(f.options),floor=await capture(f.options);assert.equal(chat.key,floor.key);floor.close();f.reads.length=0;
 f.context.chat[0].mes='edited';f.context.chat.push({mes:'new user reply',is_user:true});assert.equal(await chat.guard(),true);assert.deepEqual(f.reads,[]);
 f.emitter.emit('chat_changed');assert.throws(chat.assertCurrent);assert.equal(f.listeners(),0);
});

test('chat panel account changes during capture fail closed without reading or moving history',async()=>{
 const f=fixture();let calls=0;await assert.rejects(captureProseAssistantChatSource({...f.options,resolveNamespace:async()=>++calls===1?'st-user:alice':'st-user:bob'}));assert.deepEqual(f.reads,[]);assert.equal(f.listeners(),0);
});

test('offstage source has a separate account-bound key and cannot silently fall back from a broken real chat',async()=>{
 const f=fixture(),chat=await captureProseAssistantChatSource(f.options);chat.close();f.context.chatId='';
 const offstage=await captureProseAssistantChatSource(f.options);assert.equal(offstage.scope.offstage,true);assert.notEqual(offstage.key,chat.key);assert.deepEqual(JSON.parse(offstage.key).slice(0,1),['qianmu-prose-assistant-offstage-v1']);assert.equal(proseAssistantHistoryKey(offstage.key,offstage.scope.namespace),offstage.key);assert.deepEqual(f.reads,[]);
 f.context.chatId='Chat A';assert.throws(offstage.assertCurrent);f.context.characterId=999;await assert.rejects(captureProseAssistantChatSource(f.options));
});

test('actual host namespace resolver produces a handle which is explicitly digested before history partitioning',async()=>{
 const namespace=await resolveImageAccountNamespace({loadUser:async()=>({currentUser:{handle:'普通用户'}}),fetchImpl:()=>assert.fail('verified handle needs no request')});assert.equal(namespace,'st-user:普通用户');
 const f=fixture();f.account=namespace;const source=await capture(f.options),expected='st-user:'+createHash('sha256').update('普通用户').digest('hex');
 assert.equal(source.scope.namespace,expected);assert.equal(proseAssistantHistoryKey(source.key,expected),source.key);assert.equal(JSON.parse(source.key)[0],'qianmu-prose-assistant-v2');assert.doesNotMatch(JSON.stringify(source),/普通用户/);source.close();assert.equal(f.listeners(),0);
});

test('literal hexadecimal handles are hashed exactly once as handles, never guessed to be existing fingerprints or legacy ownership',async()=>{
 const hash=createHash('sha256').update('alice').digest('hex');assert.equal(await proseAssistantAccountForNamespace('st-user:alice'),'st-user:'+hash);
 assert.equal(await proseAssistantAccountForNamespace('st-user:'+hash),'st-user:'+createHash('sha256').update(hash).digest('hex'));
 assert.notEqual(await proseAssistantAccountForNamespace('st-user: alice '),await proseAssistantAccountForNamespace('st-user:alice'),'no handle normalization merges accounts');
 const f=fixture(),source=await capture(f.options);assert.throws(()=>proseAssistantHistoryKey(source.key.replace('assistant-v2','assistant-v1')));source.close();
});

test('missing or failing crypto and scope changes while digesting fail closed and release borrowed listeners',async()=>{
 for(const cryptoImpl of [null,{subtle:{digest:async()=>{throw Error('private crypto detail');}}},{subtle:{digest:async()=>new ArrayBuffer(1)}}]){
  const f=fixture();await assert.rejects(capture({...f.options,cryptoImpl}),error=>{assert.equal(error.code,'prose_assistant_source');assert.doesNotMatch(error.message,/private/);return true;});assert.equal(f.listeners(),0);
 }
 const f=fixture();await assert.rejects(capture({...f.options,cryptoImpl:{subtle:{digest:async()=>{f.account='st-user:bob';return new ArrayBuffer(32);}}}}));assert.equal(f.listeners(),0);
});
test('explicit selection retains only supplied rendered text and immutable provenance, without scanning other floors or metadata',async()=>{
  const f=fixture(),before=structuredClone(f.context.chatMetadata),s=await capture({...f.options,range:{start:5,end:9}});
  assert.equal(s.reference.text,'正文😀');assert.deepEqual(f.reads,[0]);assert.equal(s.reference.replyId,'swipe:1');assert.equal(s.reference.mode,'selection');
  assert.doesNotMatch(JSON.stringify(s),/未选择|后文不选|隐藏推理|另一个楼层/);assert.equal(Object.hasOwn(s,'messages'),false);assert.equal(Object.hasOwn(s,'apiKey'),false);
  assert.ok(Object.isFrozen(s.scope)&&Object.isFrozen(s.reference.range));assert.deepEqual(f.context.chatMetadata,before);s.close();assert.equal(f.listeners(),0);
});
test('conversation keys separate accounts, same-name owners and group zero while multiple floors remain one chat',async()=>{
  const f=fixture(),a=await capture(f.options),second=await capture({...f.options,floor:1});assert.equal(a.key,second.key);second.close();
  f.context.characterId=1;const b=await capture(f.options);assert.notEqual(b.key,a.key);assert.throws(a.assertCurrent);b.close();
  f.context.groupId=0;const group=await capture(f.options);assert.equal(group.scope.ownerKey,'group:0');assert.notEqual(group.key,b.key);group.close();
  f.account='st-user:bob';const bob=await capture(f.options);assert.notEqual(bob.key,group.key);bob.close();assert.equal(f.listeners(),0);
});
test('edit, swipe, replacement, source events and page changes irreversibly invalidate old replies',async()=>{
  for(const change of [f=>{f.context.chat[0].mes='edited';},f=>{f.context.chat[0].swipe_id=2;},f=>{f.context.chat[0]={...f.context.chat[0]};},f=>{f.live=false;},f=>f.changeEpoch(),f=>f.emitter.emit('chat_changed')]){
    const f=fixture(),s=await capture(f.options);change(f);await assert.rejects(s.guard());assert.equal(f.listeners(),0);assert.throws(s.assertCurrent);
  }
  const f=fixture(),s=await capture(f.options);f.account='st-user:bob';await assert.rejects(s.guard());f.account='st-user:alice';await assert.rejects(s.guard());assert.equal(f.listeners(),0);
});
test('late identity resolution, text-reader mutation and invalid inputs release shared listeners without producing a scope',async()=>{
  const f=fixture();let release,entered;const ready=new Promise(resolve=>{entered=resolve;});
  const promise=capture({...f.options,resolveNamespace:()=>{entered();return new Promise(resolve=>{release=resolve;});}}),rejected=assert.rejects(promise);
  await ready;f.emitter.emit('chat_renamed',{avatarId:'A.png',oldFileName:'Chat A.jsonl'});release('st-user:alice');await rejected;assert.equal(f.listeners(),0);
  for(const patch of [{range:{start:8,end:9}},{range:{start:0,end:1,extra:true}},{range:{start:1,end:1}},{readText:()=>''},{readText:()=>'<img>\ud800'},
    {readText:()=> 'x'.repeat(PROSE_ASSISTANT_SOURCE_LIMIT+1)},{resolveNamespace:async()=>''},{floor:8},{floor:-1}]){
    const g=fixture();await assert.rejects(capture({...g.options,...patch}));assert.equal(g.listeners(),0);
  }
  const g=fixture();await assert.rejects(capture({...g.options,readText:()=>{g.context.chat[0].mes='changed';return 'text';}}));assert.equal(g.listeners(),0);
});
test('ordinary full-floor references preserve CRLF and markup as plain data and never require names or host integrity',async()=>{
  const f=fixture();delete f.context.chatMetadata.integrity;delete f.context.chat[0].name;f.options.readText=()=>'<b>文本</b>\r\n下一行';
  const s=await capture(f.options);assert.equal(s.reference.text,'<b>文本</b>\r\n下一行');assert.equal(s.reference.mode,'floor');assert.equal(s.scope.integrity,null);assert.equal(await s.guard(),true);s.close();
});
