import test from 'node:test';
import assert from 'node:assert/strict';
import {createCurrentChatCharacterReceiptClient,createChatCharacterReceiptClient} from '../qianmu-chat-character-receipt-client.js';
import {imageServiceAccount} from '../qianmu-image-service-access.js';

const gate=()=>{let release;const promise=new Promise(resolve=>{release=resolve;});return {promise,release};};
const context=()=>({characterId:0,groupId:null,chatId:'Chat A',characters:[{name:'Same name',avatar:'A.png',chat:'Chat A'},{name:'Same name',avatar:'B.png',chat:'Chat A'}],
  groups:[{id:'group-1',chat_id:'Group Chat A'}],chat:[],chatMetadata:{story_director_liminale:{plan:{keep:true},reader:{keep:true}}}});
function fixture(){
  let current=context(),epoch=0,namespace='st-user:alice';const calls=[];
  const options={getContext:()=>current,epoch:()=>epoch,account:async()=>namespace,fetchImpl:async(url,request)=>{
    const body=JSON.parse(request.body);calls.push(body);return new Response(JSON.stringify({ok:true,version:1,expectedAccount:body.expectedAccount,target:body.target,state:'absent',collection:null,proof:'read-only-snapshot'}),{headers:{'content-type':'application/json'}});
  }};
  return {options,calls,get current(){return current;},set current(value){current=value;},switch(){epoch++;},account(value){namespace=value;}};
}

test('current host adapter uses exact avatar/chat, not character display name or array-index filename; it never mutates metadata',async()=>{
  const f=fixture(),before=JSON.stringify(f.current),client=await createCurrentChatCharacterReceiptClient(f.options);
  assert.equal((await client.inspect()).state,'absent');assert.deepEqual(f.calls[0].target,{kind:'character',chatId:'Chat A',avatar:'A.png'});
  assert.equal(f.calls[0].expectedAccount,imageServiceAccount({user:{profile:{handle:'alice'}}}).namespace);assert.equal(JSON.stringify(f.current),before);client.close();
});

test('host group location uses actual chat_id, including group zero, with no character fallback',async()=>{
  const f=fixture();f.current.groupId=0;f.current.groups=[{id:0,chat_id:'Group Chat A'}];f.current.chatId='Group Chat A';f.current.characterId=undefined;
  const client=await createCurrentChatCharacterReceiptClient(f.options);await client.inspect();assert.deepEqual(f.calls[0].target,{kind:'group',chatId:'Group Chat A'});client.close();
});

test('closed chats, default IDs, incomplete host rows, ambiguous groups, and stale card chat fields cannot become requests',async()=>{
  for(const patch of [{chatId:''},{chatId:undefined},{characterId:null},{characterId:-1},{characterId:'1.5'},{characters:[]},{chatMetadata:null},{chat:null},
    {characters:[{avatar:'A.png',chat:'Other'}]},{groupId:'group-1'},{groupId:'x',groups:[]},{groupId:NaN,groups:[{id:NaN,chat_id:'Chat A'}]},
    {groupId:'x',groups:[{id:'x',chat_id:'Chat A'},{id:'x',chat_id:'Chat A'}]}]){
    const f=fixture();Object.assign(f.current,patch);await assert.rejects(createCurrentChatCharacterReceiptClient(f.options));assert.equal(f.calls.length,0);
  }
  const f=fixture();await assert.rejects(createCurrentChatCharacterReceiptClient({...f.options,epoch:undefined}));await assert.rejects(createCurrentChatCharacterReceiptClient({...f.options,epoch:()=>NaN}));
});

test('account resolution cannot bind a chat that changed while identity was being resolved',async()=>{
  const f=fixture(),entered=gate(),release=gate();const creation=createCurrentChatCharacterReceiptClient({...f.options,account:async()=>{entered.release();await release.promise;return 'st-user:alice';}});
  const rejection=assert.rejects(creation);await entered.promise;f.current.characterId=1;release.release();await rejection;assert.equal(f.calls.length,0);
});

test('same-named character with same chat filename, metadata reload, message reload and A-B-A epoch changes invalidate old clients',async()=>{
  for(const change of [f=>{f.current.characterId=1;},f=>{f.current.chatMetadata=structuredClone(f.current.chatMetadata);},f=>{f.current.chat=[];},
    f=>{f.current.chatMetadata.story_director_liminale=structuredClone(f.current.chatMetadata.story_director_liminale);},f=>f.switch()]){
    const f=fixture(),client=await createCurrentChatCharacterReceiptClient(f.options);change(f);await assert.rejects(client.inspect());assert.equal(f.calls.length,0);client.close();
  }
});

test('account change before request or during an actual response invalidates receipt without using a previous cached identity',async()=>{
  const f=fixture(),client=await createCurrentChatCharacterReceiptClient(f.options);f.account('st-user:bob');await assert.rejects(client.inspect());assert.equal(f.calls.length,0);client.close();
  const next=fixture(),fetch=next.options.fetchImpl,second=await createCurrentChatCharacterReceiptClient({...next.options,fetchImpl:async(...args)=>{const result=await fetch(...args);next.account('st-user:bob');return result;}});
  await assert.rejects(second.inspect());assert.equal(next.calls.length,1);second.close();
});

test('external source guard is checked around asynchronous identity lookup and before exposing receipt',async()=>{
  const f=fixture();let valid=true;const original=f.options.fetchImpl;
  const client=await createCurrentChatCharacterReceiptClient({...f.options,guard:async()=>{if(!valid)throw Error('source changed');},fetchImpl:async(...args)=>{const reply=await original(...args);valid=false;return reply;}});
  await assert.rejects(client.inspect());assert.equal(f.calls.length,1);client.close();
});

test('receipt close immediately releases stalled response readers and prevents new reads',async()=>{
  const entered=gate();let cancelled=0;const stream=new ReadableStream({pull(){entered.release();},cancel(){cancelled++;}},{highWaterMark:0});
  const client=createChatCharacterReceiptClient({namespace:'st-user:alice',target:{kind:'group',chatId:'Group A'},fetchImpl:async()=>new Response(stream,{headers:{'content-type':'application/json'}})});
  const rejection=assert.rejects(client.inspect());await entered.promise;client.close();await rejection;await new Promise(resolve=>setImmediate(resolve));
  assert.equal(cancelled,1);assert.equal(stream.locked,false);await assert.rejects(client.inspect());
});

test('close while guard is pending prevents a late network dispatch',async()=>{
  const entered=gate(),release=gate();let calls=0;
  const client=createChatCharacterReceiptClient({namespace:'st-user:alice',target:{kind:'group',chatId:'Group A'},guard:async()=>{entered.release();await release.promise;},fetchImpl:async()=>{calls++;}});
  const rejection=assert.rejects(client.inspect());await entered.promise;client.close();await rejection;release.release();await new Promise(resolve=>setImmediate(resolve));assert.equal(calls,0);
});

test('a response arriving after close has its unread body cancelled as well',async()=>{
  const entered=gate(),release=gate();let cancelled=0;
  const stream=new ReadableStream({pull(){},cancel(){cancelled++;}},{highWaterMark:0});
  const client=createChatCharacterReceiptClient({namespace:'st-user:alice',target:{kind:'group',chatId:'Group A'},fetchImpl:async()=>{entered.release();await release.promise;return new Response(stream,{headers:{'content-type':'application/json'}});}});
  const rejection=assert.rejects(client.inspect());await entered.promise;client.close();await rejection;release.release();await new Promise(resolve=>setImmediate(resolve));
  assert.equal(cancelled,1);assert.equal(stream.locked,false);
});

test('verification identity guard stays inside the timeout and cannot block forever before creating the read',async()=>{
  const release=gate();let calls=0;const client=createChatCharacterReceiptClient({namespace:'st-user:alice',target:{kind:'group',chatId:'Group A'},timeoutMs:100,
    guard:()=>release.promise,fetchImpl:async()=>{calls++;}});
  const collection={schema:'qianmu.character.chat-collection.v1',owner:{namespace:'st-user:alice',chatKey:'Group A'},revision:0,items:[]};
  await assert.rejects(client.verify(collection));release.release();await new Promise(resolve=>setImmediate(resolve));assert.equal(calls,0);client.close();
});
