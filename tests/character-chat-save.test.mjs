import test from 'node:test';
import assert from 'node:assert/strict';
import {createChatCharacterSaveSession} from '../qianmu-character-chat-save.js';
import {emptyChatCharacterCollection,prepareChatCharacterBatch} from '../qianmu-character-chat-batch.js';
import {chatCharacterCollectionReceiptText} from '../qianmu-chat-character-receipt.js';
import {createHash} from 'node:crypto';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createChatCharacterReceiptService} from '../qianmu-chat-character-receipt-service.js';

const owner={namespace:'st-user:alice',chatKey:'Chat A'},field='story_director_liminale';
const next=()=>prepareChatCharacterBatch(emptyChatCharacterCollection(owner),{source:{kind:'body',chatKey:owner.chatKey,messageKey:'m1',revisionId:'r1'},characters:[{id:'C1',name:'Alice',identity:['silver hair']}]},{owner,expectedRevision:0}).collection;
const gate=()=>{let release;const promise=new Promise(resolve=>{release=resolve;});return {promise,release};};
function fixture(){
  const store={plan:{id:'keep'},reader:{book:'keep'},tts:{voice:'keep'}},metadata={[field]:store,anotherPlugin:{keep:true}},characters=[{avatar:'A.png',chat:'Chat A'},{avatar:'B.png',chat:'Chat B'}];
  let epoch=0,active=true,namespace=owner.namespace,server={},host=async()=>{server=structuredClone(current.chatMetadata);},saves=0;
  let current={characterId:0,groupId:null,chatId:'Chat A',characters,chat:[],chatMetadata:metadata,saveMetadata(){saves++;return host();}};
  const requests=[];
  const options={getContext:()=>current,epoch:()=>epoch,account:async()=>namespace,guard:async()=>{},isCurrent:()=>active,timeoutMs:100,
    fetchImpl:async(url,options)=>{
      const input=JSON.parse(options.body);requests.push(input);const collection=server[field]?.characterDrafts;
      let summary=null;if(collection){const {text,...fields}=chatCharacterCollectionReceiptText(collection,owner);summary={...fields,sha256:createHash('sha256').update(text).digest('hex')};}
      return new Response(JSON.stringify({ok:true,version:1,expectedAccount:input.expectedAccount,target:input.target,state:summary?'present':'absent',collection:summary,proof:'read-only-snapshot'}),{headers:{'content-type':'application/json'}});
    }};
  return {options,store,metadata,requests,get current(){return current;},get saves(){return saves;},get server(){return server;},set server(value){server=value;},host(fn){host=fn;},
    switch(){epoch++;current={...current,characterId:1,chatId:'Chat B',chatMetadata:{[field]:{plan:'B'}},chat:[]};},deactivate(){active=false;},account(value){namespace=value;}};
}

test('native save changes only characterDrafts and confirms the exact server snapshot',async()=>{
  const f=fixture(),plan=f.store.plan,reader=f.store.reader,tts=f.store.tts,other=f.metadata.anotherPlugin,session=await createChatCharacterSaveSession(f.options),after=next();
  const result=await session.save(after,{expectedRevision:0});assert.deepEqual(result,{status:'saved',revision:1});assert.equal(f.saves,1);
  assert.strictEqual(f.store.plan,plan);assert.strictEqual(f.store.reader,reader);assert.strictEqual(f.store.tts,tts);assert.strictEqual(f.metadata.anotherPlugin,other);
  assert.deepEqual(f.server[field].characterDrafts,after);assert.equal(session.pending(),null);session.close();
});

test('server divergence and unrecognized local fields are rejected before mutation or host save',async()=>{
  const f=fixture(),session=await createChatCharacterSaveSession(f.options);f.server={[field]:{characterDrafts:next()}};
  await assert.rejects(session.save(next(),{expectedRevision:0}));assert.equal(f.saves,0);assert.equal(Object.hasOwn(f.store,'characterDrafts'),false);session.close();
  const g=fixture();g.store.characterDrafts={...emptyChatCharacterCollection(owner),future:'keep'};const before=JSON.stringify(g.store),second=await createChatCharacterSaveSession(g.options);
  await assert.rejects(second.save(next(),{expectedRevision:0}));assert.equal(g.saves,0);assert.equal(JSON.stringify(g.store),before);second.close();
});

test('local changes during receipt preflight do not get overwritten by the earlier draft',async()=>{
  const f=fixture(),fetch=f.options.fetchImpl,after=next(),session=await createChatCharacterSaveSession({...f.options,fetchImpl:async(...args)=>{const response=await fetch(...args);f.store.characterDrafts=after;return response;}});
  await assert.rejects(session.save(next(),{expectedRevision:0}));assert.strictEqual(f.store.characterDrafts,after);assert.equal(f.saves,0);session.close();
});

test('swallowed host failure leaves pending intent, requires explicit retry, then saves once verified',async()=>{
  const f=fixture();f.host(async()=>{});const session=await createChatCharacterSaveSession(f.options),after=next(),result=await session.save(after,{expectedRevision:0});
  assert.equal(result.status,'unconfirmed');assert.deepEqual(result.pending.after,after);assert.equal(f.saves,1);assert.deepEqual(f.store.characterDrafts,after);
  assert.equal((await session.retry()).status,'unconfirmed');assert.equal(f.saves,1);
  f.host(async()=>{f.server=structuredClone(f.metadata);});assert.deepEqual(await session.retry({confirmed:true}),{status:'saved',revision:1});assert.equal(f.saves,2);assert.equal(session.pending(),null);session.close();
});

test('a thrown host error after commit can only be acknowledged through matching readback',async()=>{
  const f=fixture();f.host(async()=>{f.server=structuredClone(f.metadata);throw Error('lost ack');});const session=await createChatCharacterSaveSession(f.options);
  assert.equal((await session.save(next(),{expectedRevision:0})).status,'saved');assert.equal(f.saves,1);session.close();
});

test('chat switch while the host is queued neither writes old drafts into B nor rolls back either metadata object',async()=>{
  const f=fixture(),entered=gate(),release=gate();f.host(async()=>{entered.release();await release.promise;f.server=structuredClone(f.current.chatMetadata);});
  const session=await createChatCharacterSaveSession(f.options),after=next(),operation=session.save(after,{expectedRevision:0});await entered.promise;f.switch();release.release();
  const result=await operation;assert.equal(result.status,'unconfirmed');assert.deepEqual(f.store.characterDrafts,after);assert.equal(f.current.chatMetadata[field].characterDrafts,undefined);assert.equal(f.server[field].characterDrafts,undefined);
  assert.deepEqual(session.pending().target,{kind:'character',chatId:'Chat A',avatar:'A.png'});await assert.rejects(session.retry({confirmed:true}));session.close();
});

test('host timeout keeps pending state and prevents another session from queuing an overlapping write',async()=>{
  const f=fixture(),release=gate();f.host(async()=>{await release.promise;f.server=structuredClone(f.metadata);});const first=await createChatCharacterSaveSession(f.options),second=await createChatCharacterSaveSession(f.options);
  const result=await first.save(next(),{expectedRevision:0});assert.equal(result.reason,'host_pending');assert.equal(f.saves,1);
  await assert.rejects(first.retry({confirmed:true}));await assert.rejects(second.save(next(),{expectedRevision:1}));assert.equal(f.saves,1);
  release.release();await new Promise(resolve=>setImmediate(resolve));assert.equal((await first.verify()).status,'saved');assert.equal(f.saves,1);first.close();second.close();
});

test('already committed retry is read-only and does not call the native writer a second time',async()=>{
  const f=fixture();f.host(async()=>{});const session=await createChatCharacterSaveSession(f.options);await session.save(next(),{expectedRevision:0});f.server=structuredClone(f.metadata);
  assert.equal((await session.retry({confirmed:true})).status,'saved');assert.equal(f.saves,1);session.close();
});

test('retry refuses changed server data and changed local data without replacing either',async()=>{
  for(const where of ['server','local']){
    const f=fixture();f.host(async()=>{});const session=await createChatCharacterSaveSession(f.options);await session.save(next(),{expectedRevision:0});
    const other=next();other.revision=2;if(where==='server')f.server={[field]:{characterDrafts:other}};else f.store.characterDrafts=other;
    assert.equal((await session.retry({confirmed:true})).status,'unconfirmed');assert.equal(f.saves,1);assert.equal((where==='server'?f.server[field]:f.store).characterDrafts.revision,2);session.close();
  }
});

test('account/source invalidation before staging never invokes a host write',async()=>{
  const f=fixture(),session=await createChatCharacterSaveSession(f.options);f.account('st-user:bob');await assert.rejects(session.save(next(),{expectedRevision:0}));assert.equal(f.saves,0);
  f.deactivate();await assert.rejects(session.verify());session.close();
  const g=fixture();let valid=true;const guarded=await createChatCharacterSaveSession({...g.options,guard:async()=>valid});valid=false;
  await assert.rejects(guarded.save(next(),{expectedRevision:0}));assert.equal(g.saves,0);assert.equal(g.requests.length,0);guarded.close();
});

test('closing a session does not erase staged data or cancel an already issued host save by pretending it failed',async()=>{
  const f=fixture(),entered=gate(),release=gate();f.host(async()=>{entered.release();await release.promise;f.server=structuredClone(f.metadata);});
  const session=await createChatCharacterSaveSession(f.options),after=next(),operation=session.save(after,{expectedRevision:0});await entered.promise;session.close();release.release();
  assert.equal((await operation).status,'unconfirmed');assert.deepEqual(f.store.characterDrafts,after);assert.deepEqual(f.server[field].characterDrafts,after);assert.deepEqual(session.pending().after,after);
});

test('an unchanged local collection reports unchanged, not a durable save receipt',async()=>{
  const f=fixture(),session=await createChatCharacterSaveSession(f.options),result=await session.save(emptyChatCharacterCollection(owner),{expectedRevision:0});
  assert.equal(result.status,'unchanged');assert.equal(f.saves,0);assert.equal(f.requests.length,0);session.close();
});

test('native-host-shaped save and real backend first-line readback persist the fixture field without changing adjacent modules',async t=>{
  const parent=await fs.realpath(os.tmpdir()),root=await fs.mkdtemp(path.join(parent,'qianmu-character-save-test-')),userRoot=path.join(root,'alice'),chats=path.join(userRoot,'chats'),folder=path.join(chats,'A');
  await fs.mkdir(folder,{recursive:true});const file=path.join(folder,'Chat A.jsonl'),f=fixture(),originalBody='\n'+JSON.stringify({mes:'PRESERVE_BODY'})+'\n';
  await fs.writeFile(file,JSON.stringify({chat_metadata:f.metadata})+originalBody);const service=createChatCharacterReceiptService({dataRoot:root}),request={user:{profile:{handle:'alice'},directories:{root:userRoot,chats}}};
  t.after(async()=>{await service.close();const resolved=await fs.realpath(root);assert.equal(path.dirname(resolved),parent);assert.match(path.basename(resolved),/^qianmu-character-save-test-/);await fs.rm(resolved,{recursive:true});});
  // Test-only host saving. Production delegates to the existing ST saveMetadata and never writes this file directly.
  f.host(async()=>{await fs.writeFile(file,JSON.stringify({chat_metadata:f.current.chatMetadata})+originalBody);});
  const session=await createChatCharacterSaveSession({...f.options,timeoutMs:5000,fetchImpl:async(_url,options)=>new Response(JSON.stringify(await service.inspect(request,JSON.parse(options.body))),{headers:{'content-type':'application/json'}})});
  const after=next();assert.equal((await session.save(after,{expectedRevision:0})).status,'saved');const raw=await fs.readFile(file,'utf8'),saved=JSON.parse(raw.split('\n')[0]);
  assert.deepEqual(saved.chat_metadata[field].characterDrafts,after);assert.deepEqual(saved.chat_metadata[field].reader,{book:'keep'});assert.ok(raw.endsWith(originalBody));session.close();
});

test('a stalled preflight guard times out without later mutating metadata or dispatching a save',async()=>{
  const f=fixture(),release=gate();let stall=false;
  const session=await createChatCharacterSaveSession({...f.options,guard:async()=>{if(stall)await release.promise;}});stall=true;
  await assert.rejects(session.save(next(),{expectedRevision:0}),{code:'character_archive_chat_save_cancelled'});
  release.release();await new Promise(resolve=>setImmediate(resolve));assert.equal(f.saves,0);assert.equal(f.requests.length,0);assert.equal(f.store.characterDrafts,undefined);session.close();
});

test('close during preflight releases this session immediately and prevents late mutation',async()=>{
  const f=fixture(),entered=gate(),release=gate();let stall=false;
  const session=await createChatCharacterSaveSession({...f.options,guard:async()=>{if(stall){entered.release();await release.promise;}}});stall=true;
  const rejection=assert.rejects(session.save(next(),{expectedRevision:0}));await entered.promise;session.close();await rejection;
  release.release();await new Promise(resolve=>setImmediate(resolve));assert.equal(f.saves,0);assert.equal(f.store.characterDrafts,undefined);
});
