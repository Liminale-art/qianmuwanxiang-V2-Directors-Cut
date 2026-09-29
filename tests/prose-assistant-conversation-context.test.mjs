import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {captureProseAssistantContext as capture} from '../qianmu-prose-assistant-context.js';
import {captureProseAssistantChatSource,captureProseAssistantSource} from '../qianmu-prose-assistant-source.js';
import {createProseAssistantThreadKey as thread} from '../qianmu-prose-assistant-history-contract.js';

const uuid='3d0582fd-4ee5-4ac0-a5ae-49fe8bfc4d31';
async function fixture(){
 const emitter=new EventEmitter(),reads=[],host={chatId:'A',characterId:0,characters:[{avatar:'A.png',chat:'A'}],chatMetadata:{},eventSource:emitter,chat:[{mes:'第一层'},{mes:'第二层',is_user:true},{mes:'第三层'}]};
 let identities=0;
 const options={getContext:()=>host,epoch:()=>0,resolveNamespace:async()=>{identities++;return 'st-user:alice';},isCurrent:()=>true,floor:2,referenceFloors:2,previousFloors:1,readText:(message,floor)=>{reads.push(floor);return message.mes;}};
 const seed=await captureProseAssistantChatSource(options),base=seed.key,account=seed.scope.namespace;seed.close();identities=0;
 return {host,options,base,account,reads,get identities(){return identities;},reset(){identities=0;reads.length=0;},listeners:()=>emitter.eventNames().reduce((count,type)=>count+emitter.listenerCount(type),0)};
}
const otherChat=(base,name='B')=>{const tuple=JSON.parse(base);tuple[3].chatId=name;return JSON.stringify(tuple);};

test('selected same-chat thread keeps its own key and history with the same identity cost as the default path',async()=>{
 const f=await fixture(),normal=await capture(f.options),baseline=f.identities;assert.equal(normal.key,f.base);normal.close();f.reset();
 const conversationKey=thread(f.base,uuid),turns=Array.from({length:8},(_,index)=>({user:'Q'+index,assistant:'A'+index}));
 const selected=await capture({...f.options,conversationKey,history:{key:conversationKey,turns}});
 assert.equal(selected.key,conversationKey);assert.deepEqual(f.reads,[2,1]);assert.equal(selected.reference.text,'第三层');assert.equal(selected.history.length,6);assert.equal(selected.history[0].user,'Q2');assert.equal(f.identities,baseline);
 selected.close();assert.equal(f.listeners(),0);
});

test('a selected conversation bound to another ST chat can continue only with zero references and reads no prose',async()=>{
 const f=await fixture(),conversationKey=thread(otherChat(f.base),uuid),history={key:conversationKey,turns:[{user:'已有问题',assistant:'已有回答'}]};
 const selected=await capture({...f.options,referenceFloors:0,previousFloors:0,conversationKey,history});
 assert.equal(selected.key,conversationKey);assert.equal(selected.reference,null);assert.deepEqual(selected.previous,[]);assert.deepEqual(selected.history,history.turns);assert.deepEqual(f.reads,[]);selected.close();assert.equal(f.listeners(),0);
 for(const referenceFloors of [1,2,9,undefined]){
  f.reset();await assert.rejects(capture({...f.options,referenceFloors,conversationKey,history}));assert.deepEqual(f.reads,[]);assert.equal(f.listeners(),0);
 }
});

test('a catalog-confirmed renamed binding can reference the current chat without rewriting the original thread key',async()=>{
 const f=await fixture(),conversationKey=thread(f.base,uuid);f.host.chatId='Renamed';f.host.characters[0].chat='Renamed';const conversationOwnerKey=otherChat(f.base,'Renamed');
 const selected=await capture({...f.options,conversationKey,conversationOwnerKey,history:{key:conversationKey,turns:[{user:'原问题',assistant:'原回答'}]}});
 assert.equal(selected.key,conversationKey);assert.equal(selected.reference.text,'第三层');assert.deepEqual(f.reads,[2,1]);selected.close();assert.equal(f.listeners(),0);
 f.reset();await assert.rejects(capture({...f.options,conversationKey}));assert.deepEqual(f.reads,[]);assert.equal(f.listeners(),0);
});

test('foreign-account, nested-owner, malformed keys and mismatched histories are rejected without reading prose',async()=>{
 const f=await fixture(),foreignTuple=JSON.parse(f.base);foreignTuple[1]='st-user:'+'b'.repeat(64);const foreign=thread(JSON.stringify(foreignTuple),uuid),own=thread(f.base,uuid);
 for(const patch of [
  {conversationKey:foreign},{conversationKey:foreign,referenceFloors:0},{conversationKey:foreign,conversationOwnerKey:f.base},
  {conversationKey:own,conversationOwnerKey:own},{conversationKey:own,conversationOwnerKey:null},{conversationOwnerKey:f.base},{conversationKey:own+' '},
  {conversationKey:own,history:{key:f.base,turns:[]}},{conversationKey:own,history:{key:thread(f.base,'cfdd5159-cfdf-416b-aeb6-5496e9fdccdb'),turns:[]}},
 ]){
  f.reset();await assert.rejects(capture({...f.options,...patch}));assert.deepEqual(f.reads,[]);assert.equal(f.listeners(),0);
 }
});

test('selected conversation reference bounds remain strict and default history matching is not relaxed',async()=>{
 const f=await fixture(),conversationKey=thread(f.base,uuid);
 for(const patch of [{referenceFloors:-1},{referenceFloors:10},{referenceFloors:1.5},{previousFloors:-1},{previousFloors:9}]){
  f.reset();await assert.rejects(capture({...f.options,conversationKey,...patch}));assert.deepEqual(f.reads,[]);assert.equal(f.identities,0);
 }
 await assert.rejects(capture({...f.options,history:{key:conversationKey,turns:[]}}));assert.equal(f.listeners(),0);
 f.reset();const normal=await capture({...f.options,history:{key:f.base,turns:[{user:'普通问题',assistant:'普通回答'}]}});assert.equal(normal.key,f.base);assert.equal(normal.history.length,1);normal.close();
});

test('offstage threads stay prose-free and selected foreign bindings still require an explicit zero reference',async()=>{
 const f=await fixture();f.host.chatId='';const base=JSON.stringify(['qianmu-prose-assistant-offstage-v1',f.account]),conversationKey=thread(base,uuid);
 const selected=await capture({...f.options,conversationKey,history:{key:conversationKey,turns:[]}});assert.equal(selected.key,conversationKey);assert.equal(selected.reference,null);assert.deepEqual(f.reads,[]);selected.close();
 await assert.rejects(capture({...f.options,conversationKey:thread(f.base,uuid)}));assert.deepEqual(f.reads,[]);assert.equal(f.listeners(),0);
 const foreign=await capture({...f.options,referenceFloors:0,conversationKey:thread(f.base,uuid)});assert.equal(foreign.reference,null);foreign.close();assert.equal(f.listeners(),0);
});

test('the source expected-chat check occurs after identity confirmation but before invoking the prose reader',async()=>{
 const f=await fixture();await assert.rejects(captureProseAssistantSource({...f.options,expectedChatKey:otherChat(f.base)}),{code:'prose_assistant_source'});
 assert.deepEqual(f.reads,[]);assert.equal(f.identities,2);assert.equal(f.listeners(),0);
 const selected=await captureProseAssistantSource({...f.options,expectedChatKey:f.base});assert.equal(selected.key,f.base);assert.deepEqual(f.reads,[2]);selected.close();assert.equal(f.listeners(),0);
});
