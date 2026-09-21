import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {createHash} from 'node:crypto';
import {createChatCharacterReceiptService} from '../qianmu-chat-character-receipt-service.js';
import {createChatCharacterReceiptClient,createCurrentChatCharacterReceiptClient} from '../qianmu-chat-character-receipt-client.js';
import {CHAT_CHARACTER_RECEIPT_LIMITS,chatCharacterReceiptTarget,chatCharacterReceiptRequest,
  chatCharacterCollectionReceiptText,chatCharacterReceiptResponse,chatCharacterReceiptErrorPayload} from '../qianmu-chat-character-receipt.js';
import {emptyChatCharacterCollection,prepareChatCharacterBatch} from '../qianmu-character-chat-batch.js';
import {imageServiceAccount} from '../qianmu-image-service-access.js';
import {init,exit} from '../server-plugin.js';
import {createChatGalleryReceiptClient,createCurrentChatGalleryReceiptClient,createChatGalleryRecordClient,createChatGalleryDetailsClient} from '../qianmu-chat-character-receipt-client.js';
import {projectChatGalleryDetails,chatGalleryDetailsResponse,CHAT_GALLERY_DETAILS_RESPONSE_BYTES} from '../qianmu-chat-gallery-details.js';
import {chatGalleryReceiptText,chatGalleryReceiptResponse,CHAT_GALLERY_RECEIPT_LIMITS} from '../qianmu-chat-gallery-receipt.js';
import {chatGalleryRecordRequest,chatGalleryRecordResponse,projectChatGalleryRecord,CHAT_GALLERY_RECORD_RESPONSE_BYTES} from '../qianmu-chat-gallery-record.js';

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

const gallery=()=>[{id:'frame-1',createdAt:1,url:'/PRIVATE_IMAGE.png',prompt:'PRIVATE_PROMPT',future:{unknown:true}}];
const readableGallery=()=>[{...gallery()[0],url:'/user/images/fixture.png',tags:['海岸'],snapshot:{apiKey:'PRIVATE_KEY'},privateOther:'PRIVATE_OTHER'}];
const recordRequest=(records=readableGallery(),patch={})=>({...input(),selection:{recordId:'frame-1',createdAt:1,gallerySha256:galleryResponse(records).gallery.sha256,...patch}});
const recordResponse=()=>({ok:true,version:1,expectedAccount:account('alice'),target,gallerySha256:recordRequest().selection.gallerySha256,
  record:projectChatGalleryRecord(readableGallery()[0]),proof:'read-only-record'});
function galleryResponse(value=gallery(),selected=target){
  const normalized=chatGalleryReceiptText(value),summary=normalized?{count:normalized.count,bytes:normalized.bytes,sha256:createHash('sha256').update(normalized.text).digest('hex')}:null;
  return {ok:true,version:1,expectedAccount:account('alice'),target:selected,state:summary?'present':'absent',gallery:summary,proof:'read-only-snapshot'};
}

test('gallery digest is exact for future fields and order; absent and empty are distinct',()=>{
  const a=gallery(),b=[{future:a[0].future,prompt:a[0].prompt,url:a[0].url,createdAt:1,id:'frame-1'}];
  assert.deepEqual(chatGalleryReceiptText(a),chatGalleryReceiptText(b));
  assert.notEqual(chatGalleryReceiptText(a).text,chatGalleryReceiptText([{...a[0],future:{unknown:false}}]).text);
  assert.equal(chatGalleryReceiptText(undefined),null);assert.equal(chatGalleryReceiptText([]).count,0);
  for(const value of [null,{},[null],[undefined],[{n:NaN}],[{n:undefined}],[{at:new Date()}],new Array(1)])assert.throws(()=>chatGalleryReceiptText(value));
  const cycle={};cycle.self=cycle;assert.throws(()=>chatGalleryReceiptText([cycle]));
  const hole=new Array(1);hole.extra=true;assert.throws(()=>chatGalleryReceiptText([{nested:hole}]));
  assert.throws(()=>chatGalleryReceiptText([{text:'a'.repeat(CHAT_GALLERY_RECEIPT_LIMITS.bytes)}]));
  assert.throws(()=>chatGalleryReceiptText(Array.from({length:10001},()=>({}))));
});

test('gallery receipt response exposes only bounded count/digest and an exact source target',()=>{
  assert.deepEqual(chatGalleryReceiptResponse(galleryResponse()),galleryResponse());
  for(const value of [{...galleryResponse(),url:'PRIVATE'}, {...galleryResponse(),gallery:{...galleryResponse().gallery,prompt:'PRIVATE'}},
    {...galleryResponse(),state:'absent'}, {...galleryResponse(),target:{...target,avatar:'../other.png'}},
    {...galleryResponse(),gallery:{...galleryResponse().gallery,count:-1}}])assert.throws(()=>chatGalleryReceiptResponse(value));
});

test('gallery service reads only its declared record family and never exposes unrelated content or writes',async t=>{
  const f=await fixture(t);const value=header();value.chat_metadata.story_director_liminale.storyboardImages=gallery();
  value.chat_metadata.story_director_liminale.characterDrafts='malformed unrelated family';await f.write(value,'PRIVATE_BODY');
  const before=await fs.readFile(f.file),result=await f.service.inspectGallery(f.request,input());
  assert.deepEqual(result,galleryResponse());assert.doesNotMatch(JSON.stringify(result),/PRIVATE_|prompt|url|characterDrafts/);
  assert.deepEqual(await fs.readFile(f.file),before);await rejectsCode(f.service.inspect(f.request,input()),'content');
});

test('gallery missing, absent, empty, malformed and oversized sources do not collapse to the same state',async t=>{
  const f=await fixture(t);await rejectsCode(f.service.inspectGallery(f.request,input()),'missing');
  await f.write();assert.equal((await f.service.inspectGallery(f.request,input())).state,'absent');
  for(const records of [[],null,{},[null]]){
    const value=header();value.chat_metadata.story_director_liminale.storyboardImages=records;await f.write(value);
    if(Array.isArray(records)&&!records.length)assert.deepEqual((await f.service.inspectGallery(f.request,input())).gallery,galleryResponse([]).gallery);
    else await rejectsCode(f.service.inspectGallery(f.request,input()),'content');
  }
  // Invalid JSON fails at its first token; it is not a valid oversized header.
  await fs.writeFile(f.file,'x'.repeat(CHAT_CHARACTER_RECEIPT_LIMITS.headerBytes+1)+'\n');await rejectsCode(f.service.inspectGallery(f.request,input()),'content');
});

test('gallery lookup separates same-named character chats and group files inside the authenticated account',async t=>{
  const f=await fixture(t),a=header(),b=header();a.chat_metadata.story_director_liminale.storyboardImages=gallery();b.chat_metadata.story_director_liminale.storyboardImages=[];await f.write(a);
  await fs.mkdir(path.join(f.chats,'Bob'));await fs.writeFile(path.join(f.chats,'Bob',target.chatId+'.jsonl'),JSON.stringify(b)+'\n');
  const selected={...target,avatar:'Bob.png'};assert.deepEqual(await f.service.inspectGallery(f.request,input(selected)),galleryResponse([],selected));
  const group={kind:'group',chatId:target.chatId};await fs.writeFile(path.join(f.groups,target.chatId+'.jsonl'),JSON.stringify(b)+'\n');
  assert.deepEqual(await f.service.inspectGallery(f.request,input(group)),galleryResponse([],group));
  await rejectsCode(f.service.inspectGallery(f.request,{...input(),expectedAccount:account('bob')}),'account');
  await rejectsCode(f.service.inspectGallery(f.request,input({...target,chatId:'../escape'})),'contract');
});

test('gallery client verifies the complete local snapshot without sending its contents to the server',async()=>{
  let seen;const client=createChatGalleryReceiptClient({namespace:owner.namespace,target,fetchImpl:async(url,options)=>{seen={url,...options};return json(galleryResponse());}});
  assert.equal((await client.verify(gallery())).matches,true);assert.match(seen.url,/\/chat-gallery\/receipt$/);assert.deepEqual(JSON.parse(seen.body),input());
  assert.doesNotMatch(seen.body,/PRIVATE_|prompt|url/);assert.equal((await client.verify([{...gallery()[0],future:{unknown:false}}])).matches,false);
  // Explicit absent response; the fixture default otherwise produces a populated gallery.
  const absentClient=createChatGalleryReceiptClient({namespace:owner.namespace,target,fetchImpl:async()=>json({...galleryResponse(),state:'absent',gallery:null})});
  assert.equal((await absentClient.verify(undefined)).matches,true);assert.equal((await absentClient.verify([])).matches,false);client.close();absentClient.close();
});

test('gallery client rejects stale targets, wrong receipt family, oversized responses and reports missing source safely',async()=>{
  for(const value of [response(),{...galleryResponse(),target:{...target,avatar:'Bob.png'}},{...galleryResponse(),expectedAccount:account('bob')}]){
    const client=createChatGalleryReceiptClient({namespace:owner.namespace,target,fetchImpl:async()=>json(value)});await rejectsCode(client.verify(gallery()),'client');client.close();
  }
  const large=createChatGalleryReceiptClient({namespace:owner.namespace,target,fetchImpl:async()=>new Response(' '.repeat(2049),{headers:{'content-type':'application/json'}})});await rejectsCode(large.inspect(),'client');large.close();
  const missing=createChatGalleryReceiptClient({namespace:owner.namespace,target,fetchImpl:async()=>json({ok:false,code:'chat_character_receipt_missing',message:'PRIVATE_PATH'},404)});
  await assert.rejects(missing.inspect(),error=>error.message.includes('不存在或已移动')&&!error.message.includes('PRIVATE_PATH'));missing.close();
});

test('current gallery adapter requires exact host source and rejects a same-name character switch',async()=>{
  let revision=1,calls=0;const context={chatId:target.chatId,characterId:0,characters:[{avatar:target.avatar,chat:target.chatId},{avatar:'Bob.png',chat:target.chatId}],chat:[],chatMetadata:{story_director_liminale:{storyboardImages:gallery()}}};
  const client=await createCurrentChatGalleryReceiptClient({getContext:()=>context,epoch:()=>revision,account:async()=>owner.namespace,fetchImpl:async()=>{calls++;return json(galleryResponse());}});
  assert.equal((await client.verify(gallery())).matches,true);context.characterId=1;revision++;await rejectsCode(client.verify(gallery()),'client');assert.equal(calls,1);client.close();
});

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

test('historical record contract admits only an exact selector and small render-only projection',()=>{
  assert.deepEqual(chatGalleryRecordRequest(recordRequest()),recordRequest());
  assert.deepEqual(Object.keys(recordResponse().record),['id','createdAt','url','tags']);
  assert.deepEqual(chatGalleryRecordResponse(recordResponse()),recordResponse());
  assert.doesNotMatch(JSON.stringify(recordResponse()),/PRIVATE_|snapshot|prompt|privateOther/);
  for(const value of [{...recordRequest(),url:'/user/images/other.png'},{...recordRequest(),root:'/'},
    {...recordRequest(),selection:{...recordRequest().selection,createdAt:'1'}},recordRequest(undefined,{gallerySha256:'guess'}),recordRequest(undefined,{recordId:''})])assert.throws(()=>chatGalleryRecordRequest(value));
  for(const patch of [{url:'https://example.invalid/image.png'},{url:'//example.invalid/image.png'},{url:'blob:xyz'},{url:'data:image/png;base64,AAAA'},
    {url:'/api/plugins/delete.png'},{url:'/user/images/%2e%2e/other.png'},{url:'/user/images/image.svg'},{url:'/user/images/a.png?token=PRIVATE'}])assert.throws(()=>projectChatGalleryRecord({...readableGallery()[0],...patch}));
  assert.throws(()=>chatGalleryRecordResponse({...recordResponse(),record:{...recordResponse().record,prompt:'PRIVATE'}}));
});

test('historical single-record reader never changes bytes or reveals another record and chat metadata',async t=>{
  const f=await fixture(t),records=[...readableGallery(),{...readableGallery()[0],id:'other',prompt:'PRIVATE_OTHER_PROMPT'}],value=header();
  value.chat_metadata.story_director_liminale.storyboardImages=records;await f.write(value);const before=await fs.readFile(f.file);
  const reply=await f.service.readGalleryRecord(f.request,recordRequest(records));
  assert.equal(reply.record.id,'frame-1');assert.equal(reply.record.url,'/user/images/fixture.png');
  assert.doesNotMatch(JSON.stringify(reply),/PRIVATE_|other|snapshot|characterDrafts/);assert.deepEqual(await fs.readFile(f.file),before);
});

test('historical record reader rejects changed snapshots, missing IDs, duplicate IDs and changed times',async t=>{
  const f=await fixture(t),records=readableGallery(),value=header();value.chat_metadata.story_director_liminale.storyboardImages=records;await f.write(value);
  await rejectsCode(f.service.readGalleryRecord(f.request,recordRequest(records,{gallerySha256:'0'.repeat(64)})),'record_changed');
  await rejectsCode(f.service.readGalleryRecord(f.request,recordRequest(records,{recordId:'missing'})),'record_missing');
  await rejectsCode(f.service.readGalleryRecord(f.request,recordRequest(records,{createdAt:2})),'record_changed');
  records.push({...records[0],url:'/user/images/second.png'});await f.write(value);
  await rejectsCode(f.service.readGalleryRecord(f.request,recordRequest(records)),'record_ambiguous');
  await f.write();await rejectsCode(f.service.readGalleryRecord(f.request,recordRequest()),'record_missing');
});

test('historical reader retains authentication, exact file, cancellation and link boundaries',async t=>{
  const f=await fixture(t),value=header();value.chat_metadata.story_director_liminale.storyboardImages=readableGallery();await f.write(value);
  await rejectsCode(f.service.readGalleryRecord({},recordRequest()),'account');
  await rejectsCode(f.service.readGalleryRecord(f.request,{...recordRequest(),expectedAccount:account('bob')}),'account');
  const controller=new AbortController();controller.abort();await rejectsCode(f.service.readGalleryRecord(f.request,recordRequest(),{signal:controller.signal}),'changed');
  const linked=path.join(f.folder,'extra.jsonl');await fs.link(f.file,linked);
  await rejectsCode(f.service.readGalleryRecord(f.request,recordRequest()),'path');
  assert.doesNotMatch(JSON.stringify(chatCharacterReceiptErrorPayload(Error('PRIVATE_PATH'))),/PRIVATE_PATH/);
});

test('historical reader refuses unsupported media locations without server-side fetching',async t=>{
  const f=await fixture(t);
  for(const url of ['https://private.invalid/image.png','/api/unsafe.png','blob:old','data:image/png;base64,AAAA']){
    const records=[{...readableGallery()[0],url}],value=header();value.chat_metadata.story_director_liminale.storyboardImages=records;await f.write(value);
    await rejectsCode(f.service.readGalleryRecord(f.request,recordRequest(records)),'record_url');
  }
});

test('record client binds selector, digest, account and target and strips unrelated request headers',async()=>{
  let calls=0;const client=createChatGalleryRecordClient({namespace:owner.namespace,target,headers:()=>({'X-CSRF-Token':'fixture',Authorization:'PRIVATE_KEY'}),fetchImpl:async(url,options)=>{
    calls++;assert.equal(url,'/api/plugins/qianmu-tts/chat-gallery/record');assert.deepEqual(JSON.parse(options.body),recordRequest());
    assert.equal(options.headers.Authorization,undefined);assert.equal(options.redirect,'error');assert.equal(options.cache,'no-store');return json(recordResponse());
  }});
  assert.deepEqual(await client.read(recordRequest().selection),recordResponse());assert.equal(calls,1);client.close();await rejectsCode(client.read(recordRequest().selection),'client');
  for(const patch of [{record:{...recordResponse().record,id:'other'}},{record:{...recordResponse().record,createdAt:2}},{gallerySha256:'0'.repeat(64)},
    {expectedAccount:account('bob')},{target:{...target,avatar:'Other.png'}}]){
    const wrong=createChatGalleryRecordClient({namespace:owner.namespace,target,fetchImpl:async()=>json({...recordResponse(),...patch})});
    await rejectsCode(wrong.read(recordRequest().selection),'client');wrong.close();
  }
});

test('record client enforces byte limit, safe errors and cancellation while waiting for a body',async()=>{
  for(const reply of [new Response('x'.repeat(CHAT_GALLERY_RECORD_RESPONSE_BYTES+1),{headers:{'content-type':'application/json'}}),
    json({ok:false,code:'chat_character_receipt_record_missing',message:'PRIVATE_SERVER_PATH'},404),new Response('old backend',{status:404})]){
    const client=createChatGalleryRecordClient({namespace:owner.namespace,target,fetchImpl:async()=>reply});
    await assert.rejects(client.read(recordRequest().selection),error=>error.code==='chat_character_receipt_client'&&!error.message.includes('PRIVATE'));client.close();
  }
  let cancelled=false;const stream=new ReadableStream({start(c){c.enqueue(new TextEncoder().encode('{'));},cancel(){cancelled=true;}});
  const client=createChatGalleryRecordClient({namespace:owner.namespace,target,timeoutMs:100,fetchImpl:async()=>new Response(stream,{headers:{'content-type':'application/json'}})});
  await rejectsCode(client.read(recordRequest().selection),'client');assert.equal(cancelled,true);client.close();
});

test('generation details preserve exact display fields without returning recipes, arbitrary metadata or invented defaults',()=>{
  const original={...readableGallery()[0],finalPrompt:'最终\n<img src=x>',negative:'',seed:0,width:1024,cfg:0,model:'保存的模型',artistString:'画师'};
  const projected=projectChatGalleryDetails(original);assert.equal(projected.generation.prompt,'PRIVATE_PROMPT');assert.equal(projected.generation.finalPrompt,original.finalPrompt);
  assert.equal(projected.generation.negative,'');assert.equal(projected.generation.effectiveNegative,null);assert.equal(projected.generation.seed,0);assert.equal(projected.generation.cfg,0);
  assert.equal(projected.generation.recipeState,'inline');assert.doesNotMatch(JSON.stringify(projected),/PRIVATE_KEY|privateOther|future|snapshot|\/user\/images/);
  for(const [record,state] of [[{id:'a',createdAt:0},'not-recorded'],[{id:'a',createdAt:0,snapshotRef:'PRIVATE_REF'},'reference-only'],[{id:'a',createdAt:0,snapshot:{},recipeUnavailable:true},'unavailable']]){
    const row=projectChatGalleryDetails(record);assert.equal(row.generation.recipeState,state);assert.equal(row.generation.model,null);assert.doesNotMatch(JSON.stringify(row),/PRIVATE_REF/);
  }
  assert.equal(projectChatGalleryDetails({...original,seed:'18446744073709551615'}).generation.seed,'18446744073709551615');
  for(const patch of [{prompt:'x'.repeat(24001)},{negative:{text:'wrong'}},{seed:{}},{width:NaN},{model:['wrong']},{id:''},{snapshot:'broken'},{snapshotRef:{}},{recipeUnavailable:'yes'}])assert.throws(()=>projectChatGalleryDetails({...original,...patch}));
});

const detailResponse=()=>({...recordResponse(),record:projectChatGalleryDetails(readableGallery()[0]),proof:'read-only-details'});
test('generation response rejects unbounded or incompatible structures rather than silently clipping prompts',()=>{
  assert.deepEqual(chatGalleryDetailsResponse(detailResponse()),detailResponse());
  const base=detailResponse();
  for(const patch of [{proof:'read-only-record'},{extra:true},{record:{...base.record,url:'/user/images/other.png'}},{record:{...base.record,generation:{...base.record.generation,secret:'PRIVATE'}}},
    {record:{...base.record,generation:{...base.record.generation,recipeState:'complete'}}},{record:{...base.record,generation:{...base.record.generation,prompt:'\u0000'.repeat(24000),finalPrompt:'\u0000'.repeat(24000)}}}])assert.throws(()=>chatGalleryDetailsResponse({...base,...patch}));
});

test('historical details service reads only the selected record under the same account and complete source digest',async t=>{
  const f=await fixture(t),rows=[...readableGallery(),{...readableGallery()[0],id:'other',prompt:'DO_NOT_RETURN_OTHER'}],value=header();value.chat_metadata.story_director_liminale.storyboardImages=rows;await f.write(value);const before=await fs.readFile(f.file);
  const result=await f.service.readGalleryDetails(f.request,recordRequest(rows));assert.equal(result.record.generation.prompt,'PRIVATE_PROMPT');assert.doesNotMatch(JSON.stringify(result),/PRIVATE_BODY|PRIVATE_KEY|PRIVATE_HISTORY|DO_NOT_RETURN_OTHER|snapshot|privateOther/);
  assert.deepEqual(await fs.readFile(f.file),before);
  await rejectsCode(f.service.readGalleryDetails({},recordRequest(rows)),'account');await rejectsCode(f.service.readGalleryDetails(f.request,{...recordRequest(rows),expectedAccount:account('bob')}),'account');
  await rejectsCode(f.service.readGalleryDetails(f.request,recordRequest(rows,{gallerySha256:'0'.repeat(64)})),'record_changed');
  await rejectsCode(f.service.readGalleryDetails(f.request,recordRequest(rows,{createdAt:2})),'record_changed');
  await rejectsCode(f.service.readGalleryDetails(f.request,recordRequest(rows,{recordId:'missing'})),'record_missing');
  const abort=new AbortController();abort.abort();await rejectsCode(f.service.readGalleryDetails(f.request,recordRequest(rows),{signal:abort.signal}),'changed');
  rows.push({...rows[0]});await f.write(value);await rejectsCode(f.service.readGalleryDetails(f.request,recordRequest(rows)),'record_ambiguous');
});

test('details client binds metadata to the preview selector and does not reuse the render-only endpoint',async()=>{
  let calls=0;const client=createChatGalleryDetailsClient({namespace:owner.namespace,target,headers:()=>({'X-CSRF-Token':'fixture',Authorization:'PRIVATE'}),fetchImpl:async(url,options)=>{
    calls++;assert.equal(url,'/api/plugins/qianmu-tts/chat-gallery/details');assert.deepEqual(JSON.parse(options.body),recordRequest());assert.equal(options.headers.Authorization,undefined);assert.equal(options.credentials,'same-origin');assert.equal(options.redirect,'error');return json(detailResponse());
  }});
  assert.deepEqual(await client.read(recordRequest().selection),detailResponse());assert.equal(calls,1);client.close();
  for(const patch of [{expectedAccount:account('bob')},{target:{...target,chatId:'other'}},{gallerySha256:'b'.repeat(64)},{record:{...detailResponse().record,id:'other'}},{record:{...detailResponse().record,createdAt:2}}]){
    const wrong=createChatGalleryDetailsClient({namespace:owner.namespace,target,fetchImpl:async()=>json({...detailResponse(),...patch})});await rejectsCode(wrong.read(recordRequest().selection),'client');wrong.close();
  }
});

test('old detail backend, oversized response and stalled body keep honest errors and cancel readers',async()=>{
  const old=createChatGalleryDetailsClient({namespace:owner.namespace,target,fetchImpl:async()=>new Response('old backend',{status:404})});
  await assert.rejects(old.read(recordRequest().selection),/更新千幕配套后端/);old.close();
  const over=createChatGalleryDetailsClient({namespace:owner.namespace,target,fetchImpl:async()=>new Response('x'.repeat(CHAT_GALLERY_DETAILS_RESPONSE_BYTES+1),{headers:{'content-type':'application/json'}})});
  await rejectsCode(over.read(recordRequest().selection),'client');over.close();
  let cancelled=false;const body=new ReadableStream({start(c){c.enqueue(new TextEncoder().encode('{'));},cancel(){cancelled=true;}});
  const hanging=createChatGalleryDetailsClient({namespace:owner.namespace,target,timeoutMs:100,fetchImpl:async()=>new Response(body,{headers:{'content-type':'application/json'}})});
  await rejectsCode(hanging.read(recordRequest().selection),'client');assert.equal(cancelled,true);hanging.close();
});

test('production HTTP route plus browser client verifies a synthetic chat without saving or exposing its contents',async t=>{
  const f=await fixture(t),routes=new Map(),seen=[],value=header();value.chat_metadata.story_director_liminale.storyboardImages=gallery();await f.write(value);const before=await fs.readFile(f.file);
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
  const hostContext={characterId:0,groupId:null,chatId:owner.chatKey,characters:[{avatar:target.avatar,chat:owner.chatKey}],chat:[],chatMetadata:{}};
  const client=await createCurrentChatCharacterReceiptClient({getContext:()=>hostContext,epoch:()=>0,account:async()=>owner.namespace,fetchImpl:async(url,options)=>{
    const reply=await fetch(origin+url.replace('/api/plugins/qianmu-tts',''),{...options,headers:{...options.headers,'x-test-login':'alice'}});
    assert.equal(reply.headers.get('cache-control'),'no-store');assert.equal(reply.headers.get('x-content-type-options'),'nosniff');return reply;
  }});
  assert.equal((await client.verify(draft())).matches,true);
  const rejected=await fetch(origin+endpoint,{method:'POST',headers:{'x-test-login':'alice','content-type':'application/json'},body:JSON.stringify({...input(),root:f.root})});
  assert.equal(rejected.status,400);assert.doesNotMatch(await rejected.text(),/qianmu-chat-receipt-test|PRIVATE_/);
  const galleryEndpoint='/chat-gallery/receipt';assert.equal((await fetch(origin+galleryEndpoint,{method:'POST'})).status,401);
  const galleryClient=createChatGalleryReceiptClient({namespace:owner.namespace,target,fetchImpl:async(url,options)=>fetch(origin+url.replace('/api/plugins/qianmu-tts',''),{...options,headers:{...options.headers,'x-test-login':'alice'}})});
  assert.equal((await galleryClient.verify(gallery())).matches,true);
  assert.deepEqual(await fs.readFile(f.file),before);
  const recordEndpoint='/chat-gallery/record';assert.equal((await fetch(origin+recordEndpoint,{method:'POST'})).status,401);
  value.chat_metadata.story_director_liminale.storyboardImages=readableGallery();await f.write(value);const recordBefore=await fs.readFile(f.file);
  const recordClient=createChatGalleryRecordClient({namespace:owner.namespace,target,fetchImpl:async(url,options)=>fetch(origin+url.replace('/api/plugins/qianmu-tts',''),{...options,headers:{...options.headers,'x-test-login':'alice'}})});
  assert.deepEqual(await recordClient.read(recordRequest().selection),recordResponse());assert.deepEqual(await fs.readFile(f.file),recordBefore);
  const detailsEndpoint='/chat-gallery/details';assert.equal((await fetch(origin+detailsEndpoint,{method:'POST'})).status,401);
  const detailsClient=createChatGalleryDetailsClient({namespace:owner.namespace,target,fetchImpl:async(url,options)=>fetch(origin+url.replace('/api/plugins/qianmu-tts',''),{...options,headers:{...options.headers,'x-test-login':'alice'}})});
  assert.deepEqual(await detailsClient.read(recordRequest().selection),detailResponse());assert.deepEqual(await fs.readFile(f.file),recordBefore);
  assert.ok(seen.every(url=>[endpoint,galleryEndpoint,recordEndpoint,detailsEndpoint].includes(url)));client.close();galleryClient.close();recordClient.close();detailsClient.close();
});
