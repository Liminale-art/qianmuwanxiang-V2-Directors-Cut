import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {EventEmitter} from 'node:events';
import {setTimeout as delay} from 'node:timers/promises';
import {readFile} from 'node:fs/promises';
import {copyRenamedProseAssistantHistory as copy} from '../qianmu-prose-assistant-native.js';
import {createProseAssistantRenameCoordinator as coordinate} from '../qianmu-prose-assistant-rename.js';
import {emptyProseAssistantHistory} from '../qianmu-prose-assistant-history-contract.js';
import {createProseFloorTools} from '../qianmu-prose-floor-tools.js';
import {streamCheckpointTransport} from './helpers/stream-checkpoint-fixture.mjs';
const account='st-user:'+createHash('sha256').update('alice').digest('hex');
const key=(chatId='new',integrity='same')=>JSON.stringify(['qianmu-prose-assistant-v2',account,'char:A.png',{kind:'character',chatId,avatar:'A.png'},integrity]);
const slot=value=>'assistant-'+createHash('sha256').update(value).digest('hex');
const row={id:1,user:'问题',assistant:'完整回答',status:'complete',reference:null};
const history=(k,rows=[row],revision=2)=>({version:1,namespace:k,revision,updatedAt:20,rows});
async function fixture({rows=[row],native=true,integrity='same'}={}){
 const transport=streamCheckpointTransport('st-user:alice'),store=await transport.createStorage();
 const oldKey=key('old',integrity),newKey=key('new',integrity),prior=history(oldKey,rows);let live=true,reads=0;
 if(native)await store.write(slot(oldKey),prior,{expectedFingerprint:null});
 const options={source:{key:newKey,scope:{namespace:account},assertCurrent:()=>live,guard:async()=>live},oldChatId:'old',isCurrent:()=>live,
  storageFactory:transport.createStorage,legacyFactory:()=>({read:async(ns,k,{guard})=>{assert.equal(guard(),true);assert.equal(ns,account);assert.equal(k,oldKey);reads++;return structuredClone(prior);},close(){}})};
 return {transport,store,oldKey,newKey,prior,options,get reads(){return reads;},stop(){live=false;}};
}
test('rename copies the full native history to the exact destination, retains every old file and is readable on another device',async()=>{
 const f=await fixture(),before=new Map(f.transport.files);assert.deepEqual(await copy(f.options),{status:'copied',turns:1});
 for(const [name,text]of before)assert.equal(f.transport.files.get(name),text);
 const second=await f.transport.createStorage(),saved=await second.read(slot(f.newKey));assert.deepEqual(saved.value,{...f.prior,namespace:f.newKey});assert.equal(f.reads,0);second.close();f.store.close();
});
test('clear revision and missing integrity survive rename without resurrecting local replies',async()=>{
 const f=await fixture({rows:[],integrity:null});await copy(f.options);const state=(await f.store.read(slot(f.newKey))).value;
 assert.equal(state.revision,2);assert.deepEqual(state.rows,[]);assert.equal(f.reads,0);f.store.close();
});
test('existing destination, including a clear marker, is never overwritten or merged',async()=>{
 const f=await fixture();await f.store.write(slot(f.newKey),history(f.newKey,[],5),{expectedFingerprint:null});const before=new Map(f.transport.files);
 assert.deepEqual(await copy(f.options),{status:'existing'});assert.deepEqual(f.transport.files,before);f.store.close();
});
test('exact legacy local history is copied only when native source is absent and is not deleted',async()=>{
 const f=await fixture({native:false}),prior=structuredClone(f.prior);assert.equal((await copy(f.options)).status,'copied');assert.equal(f.reads,2);assert.deepEqual(f.prior,prior);assert.equal((await f.store.read(slot(f.newKey))).value.rows[0].assistant,'完整回答');f.store.close();
});
test('no prior history means no needless upload',async()=>{
 const f=await fixture({native:false});f.options.legacyFactory=()=>({read:async()=>emptyProseAssistantHistory(f.oldKey),close(){}});
 assert.deepEqual(await copy(f.options),{status:'empty'});assert.equal(f.transport.files.size,0);f.store.close();
});
test('legacy local edits during copy are detected by a complete second read',async()=>{
 const f=await fixture({native:false});let n=0;f.options.legacyFactory=()=>({read:async(_a,_k,{guard})=>{assert.equal(guard(),true);return history(f.oldKey,[{...row,assistant:++n===1?'原回复':'另一页面修改'}]);},close(){}});
 await assert.rejects(copy(f.options),{code:'prose_assistant_history_conflict'});assert.equal(f.transport.files.size,0);f.store.close();
});
test('wrong account, offstage, invalid name and stale live source cannot create destination records',async()=>{
 for(const alter of [f=>{f.options.source.scope.namespace='st-user:'+'b'.repeat(64);},f=>{f.options.oldChatId='../old';},f=>{f.options.source.key=JSON.stringify(['qianmu-prose-assistant-offstage-v1',account]);},f=>f.stop()]){
  const f=await fixture(),before=new Map(f.transport.files);alter(f);await assert.rejects(copy(f.options));assert.deepEqual(f.transport.files,before);f.store.close();
 }
});
test('changed source between initial read and final check stops the copy without touching either version',async()=>{
 const f=await fixture();let n=0;const base=f.options.storageFactory;
 f.options.storageFactory=async options=>{const store=await base(options);return {...store,async read(id,opts){const r=await store.read(id,opts);if(id===slot(f.oldKey)&&++n===2)return {...r,fingerprint:'b'.repeat(64)};return r;}};};
 await assert.rejects(copy(f.options),{code:'prose_assistant_history_conflict'});assert.equal((await f.store.read(slot(f.newKey))).exists,false);f.store.close();
});
test('lost acknowledgement is reconciled with an exact read, never a second write',async()=>{
 const f=await fixture(),base=f.options.storageFactory;let writes=0;
 f.options.storageFactory=async options=>{const store=await base(options);return {...store,async write(...args){writes++;await store.write(...args);throw Error('lost');}};};
 assert.equal((await copy(f.options)).status,'copied');assert.equal(writes,1);assert.equal((await f.store.read(slot(f.newKey))).exists,true);f.store.close();
});
test('a competing different destination is retained, not reconciled as success',async()=>{
 const f=await fixture(),base=f.options.storageFactory;
 f.options.storageFactory=async options=>{const store=await base(options);return {...store,async write(id,_value,opts){await store.write(id,history(f.newKey,[],9),opts);throw Error('competing writer');}};};
 await assert.rejects(copy(f.options));assert.equal((await f.store.read(slot(f.newKey))).value.revision,9);assert.equal((await f.store.read(slot(f.oldKey))).value.rows.length,1);f.store.close();
});
function host(patch={}){
 const bus=new EventEmitter(),warnings=[],copies=[],requests=[];let live=true,namespace='st-user:alice';
 const context={chatId:'new',characterId:0,groupId:null,characters:[{avatar:'A.png',chat:'new'}],chat:[],chatMetadata:{integrity:'same'},eventSource:bus,eventTypes:{CHAT_RENAMED:'rename'}};
 const options={getContext:()=>context,resolveNamespace:async()=>namespace,isCurrent:()=>live,headers:()=>({'X-CSRF-Token':'safe',Authorization:'PRIVATE'}),notify:(...args)=>warnings.push(args),
  copy:async options=>{copies.push(options);return {status:'copied'};},fetchImpl:async(url,options)=>{requests.push({url,options});return new Response(JSON.stringify({fileName:'new.jsonl'}),{headers:{'content-type':'application/json'}});},...patch};
 const coordinator=coordinate(options);coordinator.refresh();const event={avatarId:'A.png',groupId:null,oldFileName:'old.jsonl',newFileName:'new.jsonl'};
 return {context,bus,warnings,copies,requests,coordinator,event,options,stop(){live=false;},account(value){namespace=value;}};
}
test('completed current rename uses exact live identity, and ordinary chat loads never copy history',async()=>{
 const f=host();f.bus.emit('chat_loaded');await f.coordinator.settled();assert.equal(f.copies.length,0);
 f.bus.emit('rename',f.event);await f.coordinator.settled();assert.equal(f.copies.length,1);assert.equal(f.copies[0].oldChatId,'old');assert.equal(f.copies[0].source.key,key());assert.equal(f.requests.length,0);assert.deepEqual(f.warnings,[]);f.coordinator.close();assert.equal(f.bus.listenerCount('rename'),0);
});
test('completed host event through actual native transport persists both char and group rename histories',async()=>{
 for(const group of [false,true]){
  const transport=streamCheckpointTransport('st-user:alice'),store=await transport.createStorage(),f=host({copy:options=>copy({...options,storageFactory:transport.createStorage,legacyFactory:()=>assert.fail('remote exists')})});
  if(group)Object.assign(f.context,{groupId:'G',groups:[{id:'G',chat_id:'new'}]});
  const make=id=>group?JSON.stringify(['qianmu-prose-assistant-v2',account,'group:G',{kind:'group',chatId:id},'same']):key(id);
  await store.write(slot(make('old')),history(make('old')),{expectedFingerprint:null});const original=new Map(transport.files);
  f.bus.emit('rename',{...f.event,...(group?{groupId:'G',avatarId:undefined}:{})});await f.coordinator.settled();assert.deepEqual(f.warnings,[]);
  assert.equal((await store.read(slot(make('new')))).value.rows[0].assistant,'完整回答');for(const [name,body]of original)assert.equal(transport.files.get(name),body);f.coordinator.close();store.close();
 }
});
test('sanitized new name uses ST read-only utility and only forwards CSRF, not API credentials',async()=>{
 const f=host();f.bus.emit('rename',{...f.event,newFileName:'n?ew.jsonl'});await f.coordinator.settled();assert.equal(f.copies.length,1);assert.equal(f.requests.length,1);
 const {url,options}=f.requests[0];assert.equal(url,'/api/files/sanitize-filename');assert.deepEqual(options.headers,{'Content-Type':'application/json',Accept:'application/json','X-CSRF-Token':'safe'});assert.equal(options.credentials,'same-origin');assert.equal(options.redirect,'error');assert.deepEqual(JSON.parse(options.body),{fileName:'n?ew.jsonl'});f.coordinator.close();
});
test('foreign character, unopened chat, wrong group and malformed event do not copy or fetch',async()=>{
 const f=host();for(const e of [{...f.event,avatarId:'B.png'},{...f.event,newFileName:'other.jsonl'},{...f.event,groupId:'other'},null,{...f.event,oldFileName:'old'}]){f.bus.emit('rename',e);await f.coordinator.settled();}
 assert.equal(f.copies.length,0);assert.equal(f.requests.length,0);assert.deepEqual(f.warnings,[]);f.coordinator.close();
});
test('group rename retains exact group identity',async()=>{
 const f=host();Object.assign(f.context,{groupId:'G',groups:[{id:'G',chat_id:'new'}]});f.bus.emit('rename',{...f.event,groupId:'G',avatarId:undefined});await f.coordinator.settled();assert.equal(f.copies.length,1);assert.equal(f.copies[0].source.scope.ownerKey,'group:G');f.coordinator.close();
});
test('source or account change during canonical-name lookup prevents late writes',async()=>{
 for(const change of [f=>{f.context.chatMetadata={integrity:'same'};},f=>f.account('st-user:bob'),f=>f.coordinator.close()]){
  let release;const f=host({fetchImpl:()=>new Promise(resolve=>{release=resolve;})});f.bus.emit('rename',{...f.event,newFileName:'n?ew.jsonl'});while(!release)await delay(1);
  change(f);release(new Response(JSON.stringify({fileName:'new.jsonl'}),{headers:{'content-type':'application/json'}}));await f.coordinator.settled();assert.equal(f.copies.length,0);f.coordinator.close();
 }
});
test('rename waiting gate completes after copy and warns on existing destination without exposing contents',async()=>{
 let release;const f=host({copy:()=>new Promise(resolve=>{release=resolve;})});f.bus.emit('rename',f.event);let done=false;const wait=f.coordinator.settled().then(()=>done=true);while(!release)await delay(1);assert.equal(done,false);release({status:'existing'});await wait;assert.equal(done,true);assert.match(f.warnings[0][0],/保留双方/);f.coordinator.close();
});
test('failed rename cannot open an empty assistant; explicit history retry retries only the exact affected source',async()=>{
 let attempts=0;const f=host({copy:async()=>{if(++attempts<3)throw Error('PRIVATE');return {status:'copied'};}}),source={key:key(),assertCurrent:()=>true,guard:async()=>true};
 f.bus.emit('rename',f.event);await f.coordinator.settled();assert.equal(attempts,1);
 await f.coordinator.settled({...source,key:key('other')});assert.equal(attempts,1);
 await assert.rejects(f.coordinator.settled(source),{code:'prose_assistant_history_rename'});assert.equal(attempts,2);
 await f.coordinator.settled(source);assert.equal(attempts,3);await f.coordinator.settled(source);assert.equal(attempts,3);assert.doesNotMatch(JSON.stringify(f.warnings),/PRIVATE/);f.coordinator.close();
});
test('timeout releases panel wait and suppresses any late copy',async()=>{
 let release;const f=host({timeoutMs:100,fetchImpl:()=>new Promise(resolve=>{release=resolve;})});f.bus.emit('rename',{...f.event,newFileName:'n?ew.jsonl'});await f.coordinator.settled();assert.equal(f.warnings.length,1);
 release(new Response(JSON.stringify({fileName:'new.jsonl'}),{headers:{'content-type':'application/json'}}));await delay(5);assert.equal(f.copies.length,0);f.coordinator.close();
});
test('stalled response stream is cancelled at the overall deadline',async()=>{
 let cancelled=false;const f=host({timeoutMs:100,fetchImpl:async()=>new Response(new ReadableStream({pull:()=>new Promise(()=>{}),cancel(){cancelled=true;}}),{headers:{'content-type':'application/json'}})});
 f.bus.emit('rename',{...f.event,newFileName:'n?ew.jsonl'});await f.coordinator.settled();await delay(5);assert.equal(cancelled,true);assert.equal(f.copies.length,0);f.coordinator.close();
});
test('bad/oversized/redirected filename response never authorizes history copy',async()=>{
 for(const response of [()=>new Response('{}',{status:401}),()=>new Response(JSON.stringify({fileName:'new.jsonl',extra:'PRIVATE'}),{headers:{'content-type':'application/json'}}),()=>new Response('x'.repeat(4100),{headers:{'content-type':'application/json'}}),()=>Object.defineProperty(new Response('{}',{headers:{'content-type':'application/json'}}),'redirected',{value:true})]){
  const f=host({fetchImpl:async()=>response()});f.bus.emit('rename',{...f.event,newFileName:'n?ew.jsonl'});await f.coordinator.settled();assert.equal(f.copies.length,0);assert.equal(f.warnings.length,1);assert.doesNotMatch(JSON.stringify(f.warnings),/PRIVATE/);f.coordinator.close();
 }
});
test('actual floor-tools lifecycle owns one rename listener and restores it after disable/enable',async()=>{
 const f=host();f.coordinator.close();const window=new EventTarget(),document=new EventTarget();Object.assign(window,{localStorage:{getItem:()=>null},setTimeout,clearTimeout,navigator:{onLine:true}});document.hidden=false;
 const tools=createProseFloorTools({...f.options,window,document,sessionFactory:async()=>({close(){}}),outboxFactory:()=>({list:async()=>[],close(){}})});
 try{tools.configureHive({window,document});tools.refresh(null);tools.refresh(null);assert.equal(f.bus.listenerCount('rename'),1);tools.dispose();assert.equal(f.bus.listenerCount('rename'),0);tools.configureHive({window,document});assert.equal(f.bus.listenerCount('rename'),1);}finally{tools.dispose();}
});
test('actual assistant history factory waits for rename, including the hive open path',async()=>{
 const source=await readFile(new URL('../qianmu-prose-floor-tools.js',import.meta.url),'utf8');
 assert.match(source,/assistantHistoryFactory:async input=>\{await renames\?\.settled\(input.source\)/);assert.match(source,/open:\(\)=>assistant\.openAssistant\(\)/);assert.match(source,/renames\?\.close\(\);renames=null/);
});
