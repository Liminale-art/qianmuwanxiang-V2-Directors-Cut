import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {createHash} from 'node:crypto';
import {createChatCharacterReceiptService} from '../qianmu-chat-character-receipt-service.js';
import {createChatCharacterReceiptClient} from '../qianmu-chat-character-receipt-client.js';
import {CHAT_CHARACTER_RECEIPT_LIMITS,chatCharacterReceiptTarget,chatCharacterReceiptRequest,
  chatCharacterCollectionReceiptText,chatCharacterReceiptResponse,chatCharacterReceiptErrorPayload} from '../qianmu-chat-character-receipt.js';
import {emptyChatCharacterCollection,prepareChatCharacterBatch} from '../qianmu-character-chat-batch.js';
import {imageServiceAccount} from '../qianmu-image-service-access.js';
import {init,exit} from '../server-plugin.js';

const owner={namespace:'st-user:alice',chatKey:'旅途 01'},target={kind:'character',chatId:owner.chatKey,avatar:'Alice.png'};
const account=handle=>imageServiceAccount({user:{profile:{handle,enabled:true}}}).namespace;
const input=(selected=target)=>({version:1,expectedAccount:account('alice'),target:selected});
const draft=()=>prepareChatCharacterBatch(emptyChatCharacterCollection(owner),{
  source:{kind:'body',chatKey:owner.chatKey,messageKey:'m1',revisionId:'r1'},characters:[{id:'C1',name:'PRIVATE_PERSON',identity:['PRIVATE_APPEARANCE']}]
},{owner,expectedRevision:0,createId:()=> '12345678-1234-4234-8234-123456789012'}).collection;
const header=(collection=draft())=>({user_name:'PRIVATE_USER',character_name:'PRIVATE_CHAR',chat_metadata:{apiKey:'PRIVATE_KEY',
  story_director_liminale:{history:['PRIVATE_HISTORY'],reader:{keep:true},characterDrafts:collection}}});
function response(collection=draft()){
  const {text,...summary}=chatCharacterCollectionReceiptText(collection,owner);
  return {ok:true,version:1,expectedAccount:account('alice'),target,state:'present',collection:{...summary,sha256:createHash('sha256').update(text).digest('hex')},proof:'read-only-snapshot'};
}
const json=(value,status=200)=>new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json'}});
const gate=()=>{let release;const promise=new Promise(resolve=>{release=resolve;});return {promise,release};};
async function fixture(t,options={}){
  const parent=await fs.realpath(os.tmpdir()),root=await fs.mkdtemp(path.join(parent,'qianmu-chat-receipt-test-'));
  const userRoot=path.join(root,'alice'),chats=path.join(userRoot,'chats'),groups=path.join(userRoot,'group chats'),folder=path.join(chats,'Alice');
  await fs.mkdir(folder,{recursive:true});await fs.mkdir(groups);
  const file=path.join(folder,target.chatId+'.jsonl'),request={user:{profile:{handle:'alice',enabled:true},directories:{root:userRoot,chats,groupChats:groups}}};
  const service=createChatCharacterReceiptService({dataRoot:root,...options});
  t.after(async()=>{await service.close();const resolved=await fs.realpath(root);
    assert.equal(path.dirname(resolved),parent);assert.match(path.basename(resolved),/^qianmu-chat-receipt-test-/);await fs.rm(resolved,{recursive:true});});
  return {root,userRoot,chats,groups,folder,file,request,service,write:async(value=header(),body='PRIVATE_BODY')=>fs.writeFile(file,JSON.stringify(value)+'\n'+JSON.stringify({mes:body})+'\n')};
}
const rejectsCode=(promise,code)=>assert.rejects(promise,{code:'chat_character_receipt_'+code});

test('receipt target uses exact safe basenames; body cannot choose a root, namespace, path or future version',()=>{
  assert.deepEqual(chatCharacterReceiptRequest(input()),input());
  assert.deepEqual(chatCharacterReceiptTarget({kind:'group',chatId:'旅行-群聊'}),{kind:'group',chatId:'旅行-群聊'});
  for(const chatId of ['','..','../another','a/b','a\\b','a:b','trailing.','white ','CON','NUL.jsonl','x\0','a'.repeat(250),'a\ud800'])assert.throws(()=>chatCharacterReceiptTarget({...target,chatId}));
  for(const avatar of ['../Alice.png','Alice.jpg','.png','con.png'])assert.throws(()=>chatCharacterReceiptTarget({...target,avatar}));
  for(const extra of [{version:2},{expectedAccount:'st-user:alice'},{root:'D:/outside'},{namespace:owner.namespace},{user:{}}])assert.throws(()=>chatCharacterReceiptRequest({...input(),...extra}));
  assert.throws(()=>chatCharacterReceiptTarget({kind:'group',chatId:'x',avatar:'Alice.png'}));
});

test('digest ignores key order, but not extra fields or owner changes; it is not a commit proof',()=>{
  const original=draft(),copy=Object.fromEntries(Object.entries(original).reverse());
  assert.equal(chatCharacterCollectionReceiptText(original,owner).text,chatCharacterCollectionReceiptText(copy,owner).text);
  assert.notEqual(chatCharacterCollectionReceiptText({...original,extra:'kept'},owner).text,chatCharacterCollectionReceiptText(original,owner).text);
  assert.throws(()=>chatCharacterCollectionReceiptText({...original,owner:{...owner,chatKey:'other'}},owner));
  assert.throws(()=>chatCharacterCollectionReceiptText({...original,extra:undefined},owner));
  let nested={};for(let i=0;i<40;i++)nested={nested};assert.throws(()=>chatCharacterCollectionReceiptText({...original,nested},owner));
  assert.throws(()=>chatCharacterReceiptResponse({...response(),proof:'committed'}));
  assert.throws(()=>chatCharacterReceiptResponse({...response(),state:'absent'}));
});

test('large chat uses one bounded header chunk; response omits bodies, identities, credentials and unrelated metadata',async t=>{
  let bytes=0,reads=0;const io={...fs,open:async(...args)=>{const handle=await fs.open(...args);return {
    stat:(...a)=>handle.stat(...a),close:()=>handle.close(),read:async(...a)=>{const result=await handle.read(...a);bytes+=result.bytesRead;reads++;return result;}};}};
  const f=await fixture(t,{io});await f.write(header(),'PRIVATE_BODY'.repeat(500000));
  const before=await fs.readFile(f.file),receipt=await f.service.inspect(f.request,input());assert.deepEqual(receipt,response());
  assert.equal(reads,1);assert.ok(bytes<=16384);assert.doesNotMatch(JSON.stringify(receipt),/PRIVATE_|apiKey|history|reader|alice|\\Users/);
  assert.deepEqual(await fs.readFile(f.file),before);assert.deepEqual(await fs.readdir(f.folder),[target.chatId+'.jsonl']);
});

test('empty collection is present; missing field is absent; missing file is never treated as saved or created',async t=>{
  const f=await fixture(t);await rejectsCode(f.service.inspect(f.request,input()),'missing');
  for(const metadata of [{},{story_director_liminale:{}},{story_director_liminale:{reader:{keep:true}}}]){
    await f.write({chat_metadata:metadata});const result=await f.service.inspect(f.request,input());assert.equal(result.state,'absent');assert.equal(result.collection,null);
  }
  await f.write(header(emptyChatCharacterCollection(owner)));const result=await f.service.inspect(f.request,input());assert.equal(result.state,'present');assert.equal(result.collection.count,0);
  await rejectsCode(f.service.inspect(f.request,input({...target,avatar:'Never existed.png'})),'missing');assert.deepEqual(await fs.readdir(f.chats),['Alice']);
});

test('group read uses its exact chat ID and owned group directory, never falls back to a group container or character chat',async t=>{
  const f=await fixture(t),group={kind:'group',chatId:owner.chatKey};await fs.writeFile(path.join(f.groups,group.chatId+'.jsonl'),JSON.stringify(header())+'\n');
  assert.equal((await f.service.inspect(f.request,input(group))).state,'present');await rejectsCode(f.service.inspect(f.request,input()),'missing');
  await rejectsCode(f.service.inspect(f.request,input({...group,chatId:'group-container-id'})),'missing');
});

test('BOM, CRLF, split UTF-8 header and header-only file are supported; prose is not parsed',async t=>{
  const f=await fixture(t),value=header();value.chat_metadata.other='字'.repeat(20000);
  await fs.writeFile(f.file,'\uFEFF'+JSON.stringify(value)+'\r\nnot valid JSON prose');assert.deepEqual(await f.service.inspect(f.request,input()),response());
  await fs.writeFile(f.file,JSON.stringify(header()));assert.deepEqual(await f.service.inspect(f.request,input()),response());
});

test('bad headers, future collections, foreign owners and oversized data fail without changing original bytes',async t=>{
  const f=await fixture(t),bad=[Buffer.from([0xff,10]),Buffer.from(''),Buffer.from('{"chat_metadata":\n'),Buffer.from(JSON.stringify({mes:'body'})),
    Buffer.from(JSON.stringify({chat_metadata:{story_director_liminale:null}})),Buffer.from(JSON.stringify(header(null))),
    Buffer.from(JSON.stringify(header({...draft(),schema:'future'}))),Buffer.from(JSON.stringify(header({...draft(),owner:{...owner,namespace:'st-user:bob'}}))),
    Buffer.from(JSON.stringify(header({...draft(),owner:{...owner,chatKey:'other'}})))];
  for(const value of bad){await fs.writeFile(f.file,value);await rejectsCode(f.service.inspect(f.request,input()),'content');assert.deepEqual(await fs.readFile(f.file),value);}
  const large=Buffer.from(JSON.stringify({chat_metadata:{padding:'x'.repeat(CHAT_CHARACTER_RECEIPT_LIMITS.headerBytes)}})+'\n');
  await fs.writeFile(f.file,large);await rejectsCode(f.service.inspect(f.request,input()),'size');assert.deepEqual(await fs.readFile(f.file),large);
});

test('unauthenticated, disabled, mismatched accounts and outside directories fail before opening files',async t=>{
  let opened=0;const f=await fixture(t,{io:{...fs,open:async(...args)=>{opened++;return fs.open(...args);}}});await f.write();
  await rejectsCode(f.service.inspect({},input()),'account');
  await rejectsCode(f.service.inspect({...f.request,user:{...f.request.user,profile:{handle:'alice',enabled:false}}},input()),'account');
  await rejectsCode(f.service.inspect(f.request,{...input(),expectedAccount:account('bob')}),'account');
  await rejectsCode(f.service.inspect({...f.request,user:{...f.request.user,directories:{...f.request.user.directories,chats:f.root}}},input()),'path');assert.equal(opened,0);
});

test('hard-linked files and linked chat directories cannot become receipts',async t=>{
  const f=await fixture(t);await f.write();await fs.link(f.file,path.join(f.root,'hardlink'));await rejectsCode(f.service.inspect(f.request,input()),'path');
  const other=path.join(f.userRoot,'other');await fs.mkdir(other);await fs.symlink(other,path.join(f.chats,'Link'),process.platform==='win32'?'junction':'dir');
  await rejectsCode(f.service.inspect(f.request,input({...target,avatar:'Link.png'})),'path');
});

test('account, directory and cancellation changes during a read reject its eventual result',async t=>{
  for(const action of ['account','directory','abort']){
    const entered=gate(),release=gate(),controller=new AbortController();
    const f=await fixture(t,{io:{...fs,open:async(...args)=>{const handle=await fs.open(...args);entered.release();await release.promise;return handle;}}});await f.write();
    const rejection=rejectsCode(f.service.inspect(f.request,input(),{signal:controller.signal}),'changed');await entered.promise;
    if(action==='account')f.request.user.profile.handle='bob';else if(action==='directory')f.request.user.directories.chats=f.root;else controller.abort();release.release();await rejection;
  }
});

test('replacement or same-inode modification during reading is not acknowledged',async t=>{
  for(const action of ['replace','edit']){
    const entered=gate(),release=gate();const f=await fixture(t,{io:{...fs,open:async(...args)=>{const handle=await fs.open(...args);return {
      stat:(...a)=>handle.stat(...a),close:()=>handle.close(),read:async(...a)=>{const result=await handle.read(...a);entered.release();await release.promise;return result;}};}}});await f.write();
    const rejection=rejectsCode(f.service.inspect(f.request,input()),'changed');await entered.promise;
    if(action==='replace'){await fs.rename(f.file,f.file+'.old');await f.write();}else await fs.appendFile(f.file,'new body');release.release();await rejection;
  }
});

test('queue is bounded and closing cancels pending readers and closes handles',async t=>{
  const release=gate(),entered=gate();let opened=0,closed=0;
  const f=await fixture(t,{io:{...fs,open:async(...args)=>{const handle=await fs.open(...args);opened++;if(opened===4)entered.release();await release.promise;
    return {stat:(...a)=>handle.stat(...a),read:(...a)=>handle.read(...a),close:async()=>{closed++;await handle.close();}};}}});await f.write();
  const operations=Array.from({length:4},()=>rejectsCode(f.service.inspect(f.request,input()),'changed'));
  await entered.promise;await rejectsCode(f.service.inspect(f.request,input()),'busy');const closing=f.service.close();release.release();await Promise.all([...operations,closing]);
  assert.equal(opened,closed);await rejectsCode(f.service.inspect(f.request,input()),'changed');
});

test('unexpected filesystem errors never expose raw paths or host errors',()=>{
  const result=chatCharacterReceiptErrorPayload(Object.assign(new Error('D:/PRIVATE_PATH PRIVATE_KEY'),{code:'EACCES'}));
  assert.equal(result.status,503);assert.doesNotMatch(JSON.stringify(result),/PRIVATE_|EACCES/);
});

test('browser verification scopes exact account/chat and strips unrelated headers',async()=>{
  let seen;const client=createChatCharacterReceiptClient({namespace:owner.namespace,target,headers:()=>({'X-CSRF-Token':'fixture','Authorization':'PRIVATE_KEY'}),fetchImpl:async(url,options)=>{seen={url,...options};return json(response());}});
  assert.equal((await client.verify(draft())).matches,true);assert.equal(seen.credentials,'same-origin');assert.equal(seen.cache,'no-store');assert.equal(seen.redirect,'error');assert.equal(seen.method,'POST');
  assert.deepEqual(JSON.parse(seen.body),input());assert.equal(seen.headers['X-CSRF-Token'],'fixture');assert.equal(seen.headers.Authorization,undefined);
  assert.equal((await client.verify({...draft(),extra:'not persisted'})).matches,false);
});

test('browser rejects wrong account/chat, incompatible response and server errors',async()=>{
  for(const make of [()=>json({...response(),expectedAccount:account('bob')}),()=>json({...response(),target:{...target,chatId:'other'}}),
    ()=>json({...response(),privateData:'not allowed'}),()=>json({ok:false,message:'PRIVATE_PATH'},500),()=>new Response('<html>error</html>')]){
    const client=createChatCharacterReceiptClient({namespace:owner.namespace,target,fetchImpl:async()=>make()});await rejectsCode(client.inspect(),'client');
  }
});

test('absent, timeout and aborted responses cannot confirm a saved collection; stalled readers are released',async()=>{
  const absent={...response(),state:'absent',collection:null},client=createChatCharacterReceiptClient({namespace:owner.namespace,target,fetchImpl:async()=>json(absent)});
  assert.equal((await client.verify(emptyChatCharacterCollection(owner))).matches,false);
  let cancelled=0;const stream=new ReadableStream({pull(){},cancel(){cancelled++;}});
  const stalled=createChatCharacterReceiptClient({namespace:owner.namespace,target,timeoutMs:100,fetchImpl:async()=>new Response(stream,{headers:{'content-type':'application/json'}})});
  await rejectsCode(stalled.inspect(),'client');await new Promise(resolve=>setImmediate(resolve));assert.equal(cancelled,1);assert.equal(stream.locked,false);
  let calls=0;const controller=new AbortController();controller.abort();const aborted=createChatCharacterReceiptClient({namespace:owner.namespace,target,fetchImpl:async()=>{calls++;return json(response());}});
  await rejectsCode(aborted.inspect({signal:controller.signal}),'client');assert.equal(calls,0);
});

test('guard timeout never dispatches later; context switch after response rejects',async()=>{
  const release=gate();let calls=0;
  const client=createChatCharacterReceiptClient({namespace:owner.namespace,target,timeoutMs:100,guard:()=>release.promise,fetchImpl:async()=>{calls++;return json(response());}});
  await rejectsCode(client.inspect(),'client');release.release();await new Promise(resolve=>setImmediate(resolve));assert.equal(calls,0);
  let current=true;const switched=createChatCharacterReceiptClient({namespace:owner.namespace,target,guard:async()=>{if(!current)throw Error('changed');},fetchImpl:async()=>{current=false;return json(response());}});
  await rejectsCode(switched.inspect(),'client');
});

test('production HTTP route plus browser client verifies a synthetic chat without saving or exposing its contents',async t=>{
  const f=await fixture(t),routes=new Map(),seen=[];await f.write();const before=await fs.readFile(f.file);
  await init({get:(name,handler)=>routes.set(`GET ${name}`,handler),post:(name,handler)=>routes.set(`POST ${name}`,handler)},{dataRoot:f.root});
  const server=http.createServer(async(req,res)=>{
    if(req.headers['x-test-login']==='alice')req.user=structuredClone(f.request.user);
    const chunks=[];for await(const part of req)chunks.push(part);req.body=chunks.length?JSON.parse(Buffer.concat(chunks)):{};
    res.set=(key,value)=>{res.setHeader(key,value);return res;};res.status=code=>{res.statusCode=code;return res;};
    res.json=value=>{res.setHeader('content-type','application/json');res.end(JSON.stringify(value));return res;};
    seen.push(req.url);const handler=routes.get(`${req.method} ${req.url}`);if(handler)await handler(req,res);else{res.statusCode=404;res.end();}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await exit();});
  const origin=`http://127.0.0.1:${server.address().port}`,endpoint='/chat-characters/receipt';
  assert.equal((await fetch(origin+endpoint,{method:'POST'})).status,401);
  const client=createChatCharacterReceiptClient({namespace:owner.namespace,target,fetchImpl:async(url,options)=>{
    const reply=await fetch(origin+url.replace('/api/plugins/qianmu-tts',''),{...options,headers:{...options.headers,'x-test-login':'alice'}});
    assert.equal(reply.headers.get('cache-control'),'no-store');assert.equal(reply.headers.get('x-content-type-options'),'nosniff');return reply;
  }});
  assert.equal((await client.verify(draft())).matches,true);
  const rejected=await fetch(origin+endpoint,{method:'POST',headers:{'x-test-login':'alice','content-type':'application/json'},body:JSON.stringify({...input(),root:f.root})});
  assert.equal(rejected.status,400);assert.doesNotMatch(await rejected.text(),/qianmu-chat-receipt-test|PRIVATE_/);
  assert.deepEqual(await fs.readFile(f.file),before);assert.ok(seen.every(url=>url===endpoint));
});
